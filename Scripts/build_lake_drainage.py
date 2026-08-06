#!/usr/bin/env python3
"""build_lake_drainage.py - derive each lake's catchment, and with it how fast it stains.

Personal use only, not for distribution or resale; not for navigation.

    py .\\build_lake_drainage.py --registry "F:\\TrollMapPipeline\\registry"
    py .\\build_lake_drainage.py --registry "..." --only lake_murray -v

Writes `registry\\lake_drainage.json`.

WHAT THIS REPLACES

`LAKE_CLARITY_PROFILES` in `Worker/worker-data.js` hand-authors a `sensitivity` constant per
zone for a handful of lakes, and falls back to a generic 1.2 for "creeks/upper arms" and 0.75
for "main lake" everywhere else. Those two numbers are doing the work of a watershed model on
1,722 waters.

Drainage area is the thing they are standing in for. The arm draining 400 km2 stains first and
hardest after rain; the one draining 8 km2 stays clear. That is measurable per lake, from a
service that is free, keyless and already verified.

VERIFIED 2026-08-06 (by Ryan, from a browser -- the authoring sandbox is blocked on this host)

    NHDPlus_HR/MapServer/3, a box over Lake Murray, outFields=totdasqkm,divdasqkm,streamorde,slope

    {"totdasqkm":0.0728,     "divdasqkm":0.0728,     "streamorde":1, "slope":0.04964}
    {"totdasqkm":0.48450001, "divdasqkm":0.48450001, "streamorde":1, "slope":0.01539}
    {"totdasqkm":0.02570001, "divdasqkm":0.02570001, "streamorde":1, "slope":0.04050}
    "exceededTransferLimit": true

Real doubles, so the schema-verified-but-values-403 note in the sweep is now closed. Two things
that response also settles:

  * `exceededTransferLimit` is true, so a plain query does NOT return the whole box. The biggest
    flowline in a lake's bbox is exactly the one that matters and it is exactly the one a
    truncated page is most likely to omit. This asks the SERVER for the maximum instead of
    fetching rows and maxing them locally, and only falls back to paging if the service refuses.

  * Those three rows are all `streamorde: 1` with catchments under half a square kilometre --
    headwater trickles. A lake's bbox is full of them. The number that describes the lake is the
    LARGEST flowline crossing it, not the average and not the first page.

HOW SENSITIVITY IS DERIVED, AND WHAT IS NOT INVENTED

    flush_ratio = catchment_km2 / lake_surface_km2

A lake with a large watershed for its size takes more runoff per unit of water it holds, so it
colours faster and clears slower. That much is physical.

What is NOT physical is any particular formula turning that ratio into the model's 0.75-1.2
scale, so none is asserted. The ratio is rank-ordered across every lake that got a reading and
mapped onto the range the existing model already uses. That keeps the current calibration --
which was tuned against real water by someone who fishes it -- and only fixes the ORDERING, so
a lake with ten times the watershed of its neighbour stops sharing its constant.

`sensitivity_source` on every record says whether it came from a measurement or the old
fallback, because a derived number and a guess should never be indistinguishable downstream.
"""
import argparse, json, math, os, time, urllib.parse, urllib.request

NHD = ('https://hydro.nationalmap.gov/arcgis/rest/services/NHDPlus_HR/MapServer/3/query')
UA = 'TrollMap/1.0 (personal fishing app)'
ACRE_KM2 = 0.00404686

# The range the existing hand-authored model uses. Kept deliberately: this script re-orders
# lakes within a calibration it did not choose, rather than replacing it with a new one.
SENS_MIN, SENS_MAX = 0.75, 1.20


def get(url, tries=3, pause=0.3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.loads(r.read().decode('utf-8', 'replace'))
            time.sleep(pause)
            return d, None
        except Exception as e:
            last = '%s: %s' % (type(e).__name__, e)
            time.sleep(1.5 * (i + 1))
    return None, last


def stats_query(wsen):
    """Ask the server for the maximum directly. One call, no paging, cannot be truncated."""
    out_stats = json.dumps([
        {'statisticType': 'max', 'onStatisticField': 'totdasqkm', 'outStatisticFieldName': 'maxda'},
        {'statisticType': 'max', 'onStatisticField': 'streamorde', 'outStatisticFieldName': 'maxord'},
        {'statisticType': 'count', 'onStatisticField': 'totdasqkm', 'outStatisticFieldName': 'n'},
    ])
    q = {
        'where': '1=1',
        'geometry': '%s,%s,%s,%s' % tuple(wsen),
        'geometryType': 'esriGeometryEnvelope',
        'inSR': '4326',
        'spatialRel': 'esriSpatialRelIntersects',
        'outStatistics': out_stats,
        'returnGeometry': 'false',
        'f': 'json',
    }
    return NHD + '?' + urllib.parse.urlencode(q)


def page_query(wsen, offset, count=1000):
    q = {
        'where': '1=1',
        'geometry': '%s,%s,%s,%s' % tuple(wsen),
        'geometryType': 'esriGeometryEnvelope',
        'inSR': '4326',
        'spatialRel': 'esriSpatialRelIntersects',
        'outFields': 'totdasqkm,streamorde',
        'returnGeometry': 'false',
        'resultOffset': str(offset),
        'resultRecordCount': str(count),
        'f': 'json',
    }
    return NHD + '?' + urllib.parse.urlencode(q)


def catchment(wsen):
    """(max_km2, max_order, n_flowlines, method) or (None, None, None, reason)."""
    d, err = get(stats_query(wsen))
    if d and not d.get('error'):
        feats = d.get('features') or []
        if feats:
            a = feats[0].get('attributes') or {}
            if a.get('maxda') is not None:
                return float(a['maxda']), a.get('maxord'), a.get('n'), 'server max'
    # The service refused a statistics query. Page instead, and page to the END -- taking the
    # first page and calling it the maximum is the exact failure `exceededTransferLimit` warns
    # about, and it would systematically under-report the biggest lakes.
    best, order, n, off = None, None, 0, 0
    for _ in range(20):
        d, err = get(page_query(wsen, off))
        if not d or d.get('error'):
            return (best, order, n, 'paged (partial)') if best is not None else (None, None, None, err or 'query failed')
        feats = d.get('features') or []
        for f in feats:
            a = f.get('attributes') or {}
            v = a.get('totdasqkm')
            if v is not None and (best is None or v > best):
                best = float(v)
                order = a.get('streamorde')
        n += len(feats)
        if not d.get('exceededTransferLimit') or not feats:
            break
        off += len(feats)
    return (best, order, n, 'paged') if best is not None else (None, None, None, 'no flowlines in bbox')


NWM = ('https://mapservices.weather.noaa.gov/vector/rest/services/obs/'
       'NWM_Stream_Analysis/MapServer/19/query')


def reaches(wsen, min_order):
    """Named NWM reaches crossing a lake's bbox, biggest stream first.

    THIS IS THE ONE THAT UNPARKS THE NO-GAUGE PROBLEM. `GAUGE_AND_UTILITY_PLAN` and the dataset
    sweep both recorded a hard limit: `/nwps/v1/reaches?bbox` returns 404, so "you must arrive
    with a COMID" and the only route to one was `/nwps/v1/gauges/{lid}` -- which needs a gauge,
    which 95 of 230 rivers do not have.

    This layer enumerates them by bounding box. `raw.feature_id` IS the COMID, so a reach can be
    found from geography alone with no gauge in the middle. Verified 2026-08-06:

        raw.feature_id 9715605  order 4  "Grannies Quarter Creek"   streamflow 76.98
        raw.feature_id 9714867  order 1  "White Oak Creek"          streamflow 0

    White Oak Creek is one of Wateree's own arms and is named in its POI layer, which is the
    cross-check that this is the real stream network and not something adjacent.

    Filtered by stream order because a lake's bbox is mostly first-order trickles: order 1 is
    the 0.03 km2 headwater that made the drainage query return `exceededTransferLimit`. An arm
    worth naming is order 2 or better.

    Only the STATIC facts are kept -- id, name, order, position. Live streamflow is a
    request-time question and belongs in the Worker, not baked into a registry file.
    """
    q = {
        'where': 'raw.stream_order>=%d' % min_order,
        'geometry': '%s,%s,%s,%s' % tuple(wsen),
        'geometryType': 'esriGeometryEnvelope',
        'inSR': '4326',
        'spatialRel': 'esriSpatialRelIntersects',
        'outFields': 'raw.feature_id,raw.stream_order,raw.gnis_name,raw.lat,raw.lon',
        'returnGeometry': 'false',
        'resultRecordCount': '400',
        'f': 'json',
    }
    d, err = get(NWM + '?' + urllib.parse.urlencode(q))
    if not d or d.get('error'):
        return None, (d or {}).get('error', {}).get('message') or err or 'query failed'
    seen, out = set(), []
    for f in (d.get('features') or []):
        a = f.get('attributes') or {}
        cid = a.get('raw.feature_id')
        if cid is None or cid in seen:
            continue
        seen.add(cid)
        out.append({
            'comid': int(cid),
            'name': (a.get('raw.gnis_name') or '').strip() or None,
            'order': a.get('raw.stream_order'),
            'lat': round(a['raw.lat'], 5) if a.get('raw.lat') is not None else None,
            'lon': round(a['raw.lon'], 5) if a.get('raw.lon') is not None else None,
        })
    out.sort(key=lambda r: (-(r['order'] or 0), r['name'] or 'zzz'))
    return out, ('truncated' if d.get('exceededTransferLimit') else 'complete')


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--min-order', type=int, default=2,
                    help='lowest NWM stream order worth recording as an arm (default 2)')
    ap.add_argument('--max-reaches', type=int, default=25, help='per lake')
    ap.add_argument('--no-reaches', action='store_true', help='catchment only')
    ap.add_argument('--out', default=None)
    ap.add_argument('--only', default=None)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--min-acres', type=float, default=25.0,
                    help='skip ponds below this; the bbox query costs the same for a 5-acre pond')
    ap.add_argument('-v', '--verbose', action='store_true')
    a = ap.parse_args()

    with open(os.path.join(a.registry, 'lake_index.json'), 'r', encoding='utf-8') as fh:
        index = json.load(fh)
    slugs = [s for s, r in index.items()
             if isinstance(r, dict) and isinstance(r.get('bounds_wsen'), list)
             and (r.get('area_acres') or 0) >= a.min_acres
             and (not a.only or s == a.only)]
    slugs.sort()
    if a.limit:
        slugs = slugs[:a.limit]
    print('%d waters (>= %g acres)' % (len(slugs), a.min_acres))

    rows, t0, fails = {}, time.time(), 0
    for k, slug in enumerate(slugs, 1):
        rec = index[slug]
        km2, order, n, method = catchment(rec['bounds_wsen'])
        surf = (rec.get('area_acres') or 0) * ACRE_KM2
        row = {'display_name': rec.get('display_name'), 'surface_km2': round(surf, 3),
               'catchment_km2': round(km2, 3) if km2 is not None else None,
               'max_stream_order': order, 'flowlines': n, 'method': method}
        if km2 is not None and surf > 0:
            row['flush_ratio'] = round(km2 / surf, 2)
        else:
            fails += 1
        if not a.no_reaches:
            rs, note = reaches(rec['bounds_wsen'], a.min_order)
            if rs is not None:
                row['reaches'] = rs[:a.max_reaches]
                row['reaches_note'] = note
                named = [r['name'] for r in rs if r['name']]
                row['named_streams'] = sorted(set(named))[:20]
            else:
                row['reaches_error'] = note
        rows[slug] = row
        if a.verbose:
            print('   %-26s %-9s catchment %-9s ratio %-7s reaches %-4s %s'
                  % (slug, method, row['catchment_km2'], row.get('flush_ratio'),
                     len(row.get('reaches') or []), ', '.join((row.get('named_streams') or [])[:3])))
        if k % 50 == 0 or k == len(slugs):
            print('  %d/%d  %d without a reading, %.1f min'
                  % (k, len(slugs), fails, (time.time() - t0) / 60))

    # Rank-order into the model's existing range. Percentile, not a fitted curve: the ratio
    # spans orders of magnitude and any curve through it would look more principled than it is.
    have = sorted((r['flush_ratio'], s) for s, r in rows.items() if r.get('flush_ratio') is not None)
    for i, (_ratio, slug) in enumerate(have):
        pct = i / max(1, len(have) - 1)
        rows[slug]['sensitivity'] = round(SENS_MIN + pct * (SENS_MAX - SENS_MIN), 3)
        rows[slug]['sensitivity_source'] = 'derived from NHDPlus catchment'
    for slug, r in rows.items():
        if 'sensitivity' not in r:
            r['sensitivity'] = None
            r['sensitivity_source'] = 'no reading — caller should keep the hand-authored fallback'

    out = a.out or os.path.join(a.registry, 'lake_drainage.json')
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump({'_note': 'catchment is the LARGEST NHDPlus flowline crossing the lake bbox; '
                            'sensitivity is the flush ratio rank-ordered into the existing '
                            '0.75-1.20 range, not a new physical model',
                   'range': [SENS_MIN, SENS_MAX], 'lakes': rows}, fh, indent=1)

    got = len(have)
    print('\n%d of %d waters have a catchment reading (%.0f%%), %.1f min'
          % (got, len(rows), 100.0 * got / max(1, len(rows)), (time.time() - t0) / 60))
    if have:
        rr = [x[0] for x in have]
        print('   flush ratio: min %.2f  p50 %.2f  p90 %.2f  max %.2f'
              % (rr[0], rr[len(rr) // 2], rr[int(len(rr) * 0.9)], rr[-1]))
        print('   clearest-draining : %s' % ', '.join(s for _r, s in have[:3]))
        print('   fastest-staining  : %s' % ', '.join(s for _r, s in have[-3:]))
    withr = sum(1 for r in rows.values() if r.get('reaches'))
    ncom = sum(len(r.get('reaches') or []) for r in rows.values())
    nnamed = len({n for r in rows.values() for n in (r.get('named_streams') or [])})
    if withr:
        print('   %d waters carry NWM reaches: %d COMIDs, %d distinct named streams'
              % (withr, ncom, nnamed))
    methods = {}
    for r in rows.values():
        methods[r['method']] = methods.get(r['method'], 0) + 1
    print('   methods: %s' % methods)
    print('-> %s' % out)


if __name__ == '__main__':
    main()
