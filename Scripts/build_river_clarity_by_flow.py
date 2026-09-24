#!/usr/bin/env python3
r"""build_river_clarity_by_flow.py -- each river's measured clarity, grouped by where its flow sat.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\build_river_clarity_by_flow.py --registry F:\TrollMapPipeline\registry [--cache DIR]
    py .\scripts\build_river_clarity_by_flow.py ... --lake broad_river      # one water, printed

Writes registry/river_clarity_by_flow.json, shipped by upload_garmin_to_r2.py as
_registry/river_clarity_by_flow.json and read by Worker/conditions.js.

WHAT IT ANSWERS. The river card already says where today's flow sits in the river's own history --
"between the 75th and 90th percentile", off USGS's daily statistics for the date (flowVsHistory in
Worker/conditions.js). It could not say what that means for the water. Measured 2026-09-24 on the
34 rivers with on-water turbidity and a daily flow record: turbidity rises with flow against its
normal -- the median reading sits at the 35th percentile of its river's turbidity in the lowest
quarter of flow and the 78th in the top tenth (A_VALUE_THE_WATER_DOES_NOT_MEASURE_IS_WITHDRAWN_...).
Ryan approved showing that beside the flow line, as the river's own readings, not as a formula.

So for every river and every USGS gauge bound to it that publishes discharge:

  - the WQP turbidity and Secchi readings since 2015 at stations INSIDE the river's registry
    outline -- the Worker's own on-the-water test, the same start date as its pull;
  - the gauge's daily mean discharge on each reading's date (USGS OGC daily values);
  - where that flow sat for that calendar day in USGS's own daily statistics -- the same
    /nwis/stat request and the same banding as statBand() in Worker/conditions.js, so the band a
    reading is filed under is the band the card would have shown that day;
  - per band: how many readings, and their median.

NOTHING IS FITTED AND NOTHING IS DROPPED. A band with two readings says two readings; the card prints
the count beside the median, which is how he judges it. A gauge with no daily statistics, or a river
with no reading on the water, gets no entry and the card says nothing.
"""
import argparse
import csv
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date

UA = {'User-Agent': 'TrollMap/1.0 (personal fishing app; pipeline)'}
SINCE = '2015-01-01'        # the Worker's WQP pull asks from 01-01-2015; see wqpPull()
STEPS = [('p10', 10), ('p25', 25), ('p50', 50), ('p75', 75), ('p90', 90)]


def fetch(url, cache=None, name=None, timeout=180):
    if cache and name:
        p = os.path.join(cache, name)
        if os.path.exists(p) and os.path.getsize(p) > 0:
            return open(p, encoding='utf-8').read()
    err = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                t = r.read().decode('utf-8', 'replace')
            if cache and name:
                os.makedirs(cache, exist_ok=True)
                open(os.path.join(cache, name), 'w', encoding='utf-8').write(t)
            return t
        except Exception as e:                                    # noqa: BLE001 -- retried, then reported
            err = e
            time.sleep(3 * (attempt + 1))
    print(f'   !! {url[:90]}...: {err}', flush=True)
    return None


# ── ON THE WATER: the Worker's test (Worker/research/on-water.js), point in outline with holes ──
def polygons_of(geo):
    out = []
    for f in (geo.get('features') or [geo]):
        g = f.get('geometry') or f
        if g.get('type') == 'Polygon':
            out.append(g['coordinates'])
        elif g.get('type') == 'MultiPolygon':
            out.extend(g['coordinates'])
    return out


def _in_ring(x, y, ring):
    inside, j = False, len(ring) - 1
    for i in range(len(ring)):
        xi, yi, xj, yj = ring[i][0], ring[i][1], ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def on_water(polys, x, y):
    return any(_in_ring(x, y, p[0]) and not any(_in_ring(x, y, h) for h in p[1:]) for p in polys)


# ── THE BAND, EXACTLY AS THE CARD NAMES IT ────────────────────────────────────────────────────
def parse_daily_stats(rdb):
    """USGS /nwis/stat daily RDB -> {(month, day): {'p10':..,'p90':..}}. Empty cells are None --
    the parseDailyStats() guard: Number('') is 0, and 0 would read as the driest day on record."""
    lines = [l for l in (rdb or '').split('\n') if l and not l.startswith('#')]
    if len(lines) < 3:
        return {}
    head = lines[0].split('\t')
    ix = {h: i for i, h in enumerate(head)}
    if 'month_nu' not in ix or 'day_nu' not in ix:
        return {}
    out = {}
    for line in lines[2:]:
        f = line.split('\t')

        def num(k):
            i = ix.get(k)
            if i is None or i >= len(f) or not f[i].strip():
                return None
            try:
                return float(f[i])
            except ValueError:
                return None
        p = {k: num(f'{k}_va') for k, _ in STEPS}
        if any(v is not None for v in p.values()):
            try:
                out[(int(f[ix['month_nu']]), int(f[ix['day_nu']]))] = p
            except ValueError:
                pass
    return out


def stat_band(value, st):
    """statBand() in Worker/conditions.js, line for line: the label the card prints."""
    if not st or value is None:
        return None
    steps = [(k, n) for k, n in STEPS if st.get(k) is not None]
    if not steps:
        return None
    if value < st[steps[0][0]]:
        return f'below the {steps[0][1]}th percentile'
    if value >= st[steps[-1][0]]:
        return f'above the {steps[-1][1]}th percentile'
    for i in range(len(steps) - 1):
        if st[steps[i][0]] <= value < st[steps[i + 1][0]]:
            return f'between the {steps[i][1]}th and {steps[i + 1][1]}th percentile'
    return None


NORMAL = {'between the 25th and 50th percentile', 'between the 50th and 75th percentile'}


def median(xs):
    xs = sorted(xs)
    n = len(xs)
    if not n:
        return None
    return xs[n // 2] if n % 2 else round((xs[n // 2 - 1] + xs[n // 2]) / 2, 2)


def summarise(rows):
    """[(kind, value)] -> {'turbidity': {'median_ntu', 'n'}, 'secchi': {'median_ft', 'n'}}"""
    t = [v for k, v in rows if k == 'turbidity']
    s = [v for k, v in rows if k == 'secchi']
    out = {}
    if t:
        out['turbidity'] = {'median_ntu': median(t), 'n': len(t)}
    if s:
        out['secchi'] = {'median_ft': median(s), 'n': len(s)}
    return out


# ── THE THREE SOURCES ─────────────────────────────────────────────────────────────────────────
def wqp_readings(bbox, polys, cache, slug):
    w, s, e, n = bbox
    chars = ['Turbidity', 'Depth, Secchi disk depth']
    q = [f'bBox={w},{s},{e},{n}'] + [f'characteristicName={urllib.parse.quote(c)}' for c in chars] \
        + [f'startDateLo={SINCE[5:7]}-{SINCE[8:10]}-{SINCE[:4]}', 'mimeType=csv', 'zip=no',
           'providers=NWIS', 'providers=STORET']
    base = 'https://www.waterqualitydata.us/data/'
    st = fetch(base + 'Station/search?' + '&'.join(q), cache, f'{slug}.stations.csv', 300)
    rs = fetch(base + 'Result/search?' + '&'.join(q + ['dataProfile=resultPhysChem']), cache,
               f'{slug}.results.csv', 300)
    if st is None or rs is None:
        return None, 0
    where = {}
    for r in csv.DictReader(io.StringIO(st)):
        try:
            where[r['MonitoringLocationIdentifier']] = (float(r['LongitudeMeasure']),
                                                       float(r['LatitudeMeasure']))
        except (KeyError, ValueError):
            pass
    on = {sid for sid, (x, y) in where.items() if on_water(polys, x, y)}
    out = []
    for r in csv.DictReader(io.StringIO(rs)):
        if r.get('MonitoringLocationIdentifier') not in on:
            continue
        ch, d = r.get('CharacteristicName') or '', (r.get('ActivityStartDate') or '')[:10]
        try:
            v = float(r.get('ResultMeasureValue') or '')
        except ValueError:
            continue
        unit = (r.get('ResultMeasure/MeasureUnitCode') or '').lower()
        if ch == 'Turbidity':
            if unit and not any(u in unit for u in ('ntu', 'fnu', 'jtu', 'ntru', 'fnru')):
                continue
            if v >= 0:
                out.append(('turbidity', d, v))
        elif ch.startswith('Depth, Secchi'):
            ft = (v * 3.28084 if unit in ('m', 'meters') else v / 12 if unit == 'in'
                  else v if unit in ('ft', 'feet') else None)
            if ft is not None and ft > 0:
                out.append(('secchi', d, round(ft, 2)))
    return out, len(on)


def daily_flow(site, cache):
    """Daily mean discharge since SINCE: {date: cfs}.

    USGS's OGC API first -- the whole range in one page. It answers 429 after a few dozen requests
    an hour without a key (measured 2026-09-24, 30 refusals in one pass over the rivers), so on a
    refusal the legacy daily-values service is asked a year at a time; it answered 503 to a
    twelve-year range the same day and 200 to a single year."""
    t = fetch('https://api.waterdata.usgs.gov/ogcapi/v0/collections/daily/items?f=json'
              f'&monitoring_location_id=USGS-{site}&parameter_code=00060&statistic_id=00003'
              f'&time={SINCE}/{date.today():%Y-%m-%d}&limit=10000&properties=time,value',
              cache, f'q2_{site}.json')
    q, missing = {}, []
    if t is not None:
        try:
            for f in json.loads(t or '{}').get('features') or []:
                p = f.get('properties') or {}
                try:
                    x = float(p['value'])
                except (KeyError, TypeError, ValueError):
                    continue
                if x >= 0:
                    q[str(p['time'])[:10]] = x
        except json.JSONDecodeError:
            pass
        return q, missing
    for year in range(int(SINCE[:4]), date.today().year + 1):
        y = fetch('https://waterservices.usgs.gov/nwis/dv/?format=json'
                  f'&sites={site}&parameterCd=00060&statCd=00003'
                  f'&startDT={year}-01-01&endDT={year}-12-31&siteStatus=all',
                  cache, f'dv_{site}_{year}.json', 120)
        if y is None:
            # NOT CACHED, SO A RERUN ASKS AGAIN -- and until then the entry says which years it
            # is missing rather than looking like a gauge that was simply quiet those years.
            missing.append(year)
            continue
        try:
            for ts in json.loads(y or '{}').get('value', {}).get('timeSeries') or []:
                for vals in ts.get('values') or []:
                    for v in vals.get('value') or []:
                        try:
                            x = float(v['value'])
                        except (KeyError, TypeError, ValueError):
                            continue
                        if x >= 0:
                            q[str(v['dateTime'])[:10]] = x
        except (json.JSONDecodeError, AttributeError):
            pass
    return q, missing


def daily_stats(site, cache):
    # THE SAME REQUEST flowVsHistory() makes, so the bands are the card's bands.
    return parse_daily_stats(fetch('https://waterservices.usgs.gov/nwis/stat/?format=rdb'
                                   '&statReportType=daily&statTypeCd=p10,p25,p50,p75,p90'
                                   f'&parameterCd=00060&sites={site}', cache, f'stat_{site}.rdb'))


def flow_sites(binding):
    """Every USGS site bound to the water that publishes discharge -- the Worker takes whichever of
    gauge/tailwater/pool has a live flow, so each gets its own table and the lookup is by site."""
    out = []
    for g in [binding.get('pool'), binding.get('tailwater'), *(binding.get('gauges') or [])]:
        site = g and g.get('usgs_site')
        parms = (g or {}).get('parms') or (g or {}).get('usgs_parms') or []
        if site and '00060' in parms and site not in out:
            out.append(site)
    return out


def build_water(slug, row, binding, registry, cache):
    bpath = os.path.join(registry, 'boundaries', slug + '.geojson')
    if not os.path.exists(bpath):
        return None, 'no registry outline'
    polys = polygons_of(json.load(open(bpath, encoding='utf-8')))
    recs, stations_on = wqp_readings(row['bounds_wsen'], polys, cache, slug)
    if recs is None:
        return None, 'WQP unreachable'
    if not recs:
        return None, 'no turbidity or Secchi reading at a station on the water'
    sites = {}
    for site in flow_sites(binding):
        stats = daily_stats(site, cache)
        q, missing_years = daily_flow(site, cache)
        if not stats or not q:
            continue
        by_band, placed = {}, 0
        for kind, d, v in recs:
            flow = q.get(d)
            try:
                st = stats.get((int(d[5:7]), int(d[8:10])))
            except ValueError:
                st = None
            band = stat_band(flow, st)
            if band is None:
                continue
            by_band.setdefault(band, []).append((kind, v))
            placed += 1
        if not placed:
            continue
        sites[site] = {
            'bands': {b: summarise(rows) for b, rows in by_band.items()},
            'normal': summarise([x for b, rows in by_band.items() if b in NORMAL for x in rows]),
            'readings_placed': placed,
            **({'flow_years_unread': missing_years} if missing_years else {}),
        }
    if not sites:
        return None, 'no bound gauge with daily statistics and daily flow on a reading date'
    return {'stations_on': stations_on, 'readings': len(recs), 'since': SINCE, 'sites': sites}, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--registry', required=True)
    ap.add_argument('--cache', default=None, help='keep downloads here and reuse them')
    ap.add_argument('--lake', nargs='*', default=None, help='only these slugs; prints, does not write')
    ap.add_argument('--out', default=None, help='default <registry>/river_clarity_by_flow.json')
    a = ap.parse_args()
    idx = json.load(open(os.path.join(a.registry, 'lake_index.json'), encoding='utf-8'))
    wb = json.load(open(os.path.join(a.registry, 'water_bindings.json'), encoding='utf-8'))['bindings']
    rivers = [(s, r) for s, r in sorted(idx.items()) if r.get('feature_type') == 'river'
              and (not a.lake or s in a.lake)]
    waters, skipped = {}, {}
    for n, (slug, row) in enumerate(rivers, 1):
        got, why = build_water(slug, row, wb.get(slug) or {}, a.registry, a.cache)
        if got:
            waters[slug] = got
            print(f'[{n}/{len(rivers)}] {slug}: {got["readings"]} readings on {got["stations_on"]} '
                  f'station(s), {len(got["sites"])} gauge(s)', flush=True)
        else:
            skipped[slug] = why
            print(f'[{n}/{len(rivers)}] {slug}: none -- {why}', flush=True)
    doc = {
        '_note': ("Each river's WQP turbidity and Secchi readings since 2015 at stations inside its "
                  'registry outline, grouped by where the bound gauge\'s daily mean discharge sat that '
                  "day in USGS's daily statistics -- the bands statBand() prints on the card. Medians "
                  'and counts, nothing fitted. Personal use only, not for distribution or resale; not '
                  'for navigation.'),
        'built': f'{date.today():%Y-%m-%d}',
        'source': 'Scripts/build_river_clarity_by_flow.py',
        'normal_bands': sorted(NORMAL),
        'waters': waters,
        'skipped': skipped,
    }
    if a.lake:
        print(json.dumps(doc, indent=1)[:4000])
        return 0
    out = a.out or os.path.join(a.registry, 'river_clarity_by_flow.json')
    with open(out, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(doc, fh, indent=1)
    print(f'{len(waters)} river(s) with a table, {len(skipped)} without -> {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
