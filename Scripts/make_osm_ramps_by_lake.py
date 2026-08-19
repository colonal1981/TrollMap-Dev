#!/usr/bin/env python3
r"""make_osm_ramps_by_lake.py - group OSM boat ramps onto lakes, WITH their coordinates.

Personal use only, not for distribution or resale; not for navigation.

    py .\make_osm_ramps_by_lake.py --registry "F:\TrollMapPipeline\registry" `
       --ramps "F:\TrollMapPipeline\osm_ramps.geojson"
    # ... reports, writes nothing. Then --go.

WHAT WAS WRONG

`registry/osm_ramps_by_lake.json` held 1,413 ramp records across 210 lakes and **not one of
them had a coordinate**:

    "dawhoo_lake": [ { "name": null, "access": null, "tag": "leisure=slipway" } ]

`osm_ramps.py` is not the culprit -- it writes proper GeoJSON Points, and `osm_ramps.geojson`
still has all 3,550 of them with coordinates. Whatever grouped them by lake kept `name`,
`access` and `tag` and dropped the geometry, and that step was never checked in.

The consequence reaches the user directly. `ramp_sources` counts those records, so the lake
carries an access badge; the map has no point to draw, so the ramp layer renders nothing.
Ryan on Dawhoo Lake: *"dropdown says there is one ramp via OSM, i click the ramp button
nothing shows up"*. 71 lakes had ONLY coordinate-less ramps, so their badge was pure fiction.

WHAT THIS DOES

Re-groups `osm_ramps.geojson` against `registry/boundaries/<slug>.geojson`, keeping the point.

A ramp sits on the BANK -- outside the water polygon by definition -- so containment is
tested against the boundary's bbox plus a margin, not against the polygon. Where more than
one lake claims a ramp, the SMALLEST claimant wins: a big reservoir's bbox swallows every
farm pond near it, and the pond is the more specific answer. That is the same reasoning as
`pruneAccessToRecord` in access-index.js, which drops a ramp from a lake it is not on.

It reports how many lakes gain a real ramp, how many lose a fictional one, and what changed
in total, because "your access badge is now correct" is only trustworthy with the number of
badges that were wrong beside it.
"""
import argparse, json, math, os, sys


def retired_of(registry):
    """(slugs a merge has retired, note). From the ONE file that records them.

    A RETIRED SLUG IS STILL A FILE IN registry/boundaries/, AND THIS SCRIPT AWARDS A RAMP TO
    THE SMALLEST CLAIMANT. A merge retires the near-duplicate of a lake, so the retired
    boundary is almost the same shape as the keeper's and is frequently the SMALLER of the
    two -- which means it wins, and the ramps land on a slug `lake_index.json` does not offer.

    Measured 2026-08-19, straight after a --go run:

        brinkley_lake      17 ramps   falls_lake got 0
        persimmon_lake     10          hiwassee_lake got 1
        tail_race_canal     3          cooper_river got 9
        wilson_dam          1          santee_river got 4

    falls_lake is a shipped lake that came out of that run with no OSM ramps at all.

    Imported by NAME off sys.path rather than restated here, and for the reason
    verify_registry_r2.py gives at its own copy of this import: a second reader of the
    deletion tab drifts from the first, and then both agree with themselves while one is
    wrong. upload_garmin_to_r2 does `from r2_gzip import prepared` at module level, so the
    script's own directory has to be on sys.path before the import.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    try:
        import upload_garmin_to_r2 as ug
        fn = getattr(ug, 'retired_slugs', None)
        if fn is None:
            return set(), ('upload_garmin_to_r2.py has no retired_slugs() -- retired slugs are '
                           'NOT being filtered, and a merged-away slug can take ramps off its '
                           'keeper')
        return fn(registry)
    except Exception as exc:
        return set(), ('could not import retired_slugs from upload_garmin_to_r2.py (%s: %s) -- '
                       'retired slugs are NOT being filtered, and a merged-away slug can take '
                       'ramps off its keeper' % (type(exc).__name__, exc))


def load_boxes(bdir, skip=()):
    """slug -> (W, S, E, N, area_deg2). Read from the boundary, not the index, because the
    index is what this file feeds and reading your own output back is how errors persist."""
    out = {}
    skip = set(skip or ())
    for fn in os.listdir(bdir):
        if not fn.endswith('.geojson'):
            continue
        slug = fn[:-len('.geojson')]
        if slug in skip:
            continue
        try:
            gj = json.load(open(os.path.join(bdir, fn), encoding='utf-8'))
        except Exception:
            continue
        lo_x = lo_y = float('inf')
        hi_x = hi_y = float('-inf')

        def eat(c):
            nonlocal lo_x, lo_y, hi_x, hi_y
            if not c:
                return
            if isinstance(c[0], (int, float)):
                x, y = c[0], c[1]
                lo_x = min(lo_x, x); hi_x = max(hi_x, x)
                lo_y = min(lo_y, y); hi_y = max(hi_y, y)
                return
            for s in c:
                eat(s)

        for f in (gj.get('features') or []):
            eat((f.get('geometry') or {}).get('coordinates'))
        if lo_x == float('inf'):
            continue
        out[slug] = (lo_x, lo_y, hi_x, hi_y, (hi_x - lo_x) * (hi_y - lo_y))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--ramps', required=True, help='osm_ramps.geojson from osm_ramps.py')
    ap.add_argument('--margin-m', type=float, default=300.0,
                    help='how far off the water a ramp may sit. Default 300 m.')
    ap.add_argument('--go', action='store_true', help='write. Default is a dry run.')
    a = ap.parse_args()

    print('MODE: %s' % ('WRITING' if a.go else 'DRY RUN -- nothing will be changed'))
    bdir = os.path.join(a.registry, 'boundaries')
    gone, gone_note = retired_of(a.registry)
    if gone_note:
        print('!! %s' % gone_note)
    boxes = load_boxes(bdir, skip=gone)
    print('%d registry boundaries (%d retired slug(s) skipped, so a merged-away boundary '
          'cannot outbid its keeper)' % (len(boxes), len(gone)))

    gj = json.load(open(a.ramps, encoding='utf-8'))
    feats = gj.get('features') or []
    print('%d OSM ramps in %s' % (len(feats), os.path.basename(a.ramps)))

    GRID = 0.1
    grid = {}
    for slug, (w, s, e, n, _) in boxes.items():
        for gx in range(int(math.floor(w / GRID)), int(math.floor(e / GRID)) + 1):
            for gy in range(int(math.floor(s / GRID)), int(math.floor(n / GRID)) + 1):
                grid.setdefault((gx, gy), []).append(slug)

    dlat = a.margin_m / 111320.0
    out, unclaimed = {}, 0
    for f in feats:
        c = (f.get('geometry') or {}).get('coordinates') or []
        if len(c) < 2:
            continue
        lon, lat = c[0], c[1]
        dlon = a.margin_m / (111320.0 * max(0.1, math.cos(math.radians(lat))))
        best = None
        for slug in grid.get((math.floor(lon / GRID), math.floor(lat / GRID)), ()):
            w, s, e, n, area = boxes[slug]
            if s - dlat <= lat <= n + dlat and w - dlon <= lon <= e + dlon:
                # smallest claimant wins -- a reservoir's bbox contains every pond near it
                if best is None or area < best[1]:
                    best = (slug, area)
        if best is None:
            unclaimed += 1
            continue
        p = f.get('properties') or {}
        out.setdefault(best[0], []).append({
            'name': p.get('name'),
            'access': p.get('access'),
            'tag': p.get('tag'),
            'osm_type': p.get('osm_type'),
            'osm_id': p.get('osm_id'),
            'lat': round(lat, 7),
            'lon': round(lon, 7),
        })

    dst = os.path.join(a.registry, 'osm_ramps_by_lake.json')
    old = {}
    if os.path.exists(dst):
        try:
            old = json.load(open(dst, encoding='utf-8'))
        except Exception:
            old = {}
    old_lakes = set(old)
    new_lakes = set(out)
    old_recs = sum(len(v) for v in old.values())
    new_recs = sum(len(v) for v in out.values())
    old_with = sum(1 for v in old.values() for r in v if isinstance(r.get('lat'), (int, float)))

    print('\n%d ramps assigned to %d lakes, %d claimed by no boundary'
          % (new_recs, len(out), unclaimed))
    print('before: %d records on %d lakes, %d had coordinates'
          % (old_recs, len(old_lakes), old_with))
    print('after : %d records on %d lakes, %d have coordinates' % (new_recs, len(out), new_recs))
    gained = sorted(new_lakes - old_lakes)
    lost = sorted(old_lakes - new_lakes)
    print('\n%d lakes gain ramps they never had' % len(gained))
    for s in gained[:12]:
        print('    + %-34s %d ramp(s)' % (s, len(out[s])))
    if len(gained) > 12:
        print('    ... %d more' % (len(gained) - 12))
    print('\n%d lakes LOSE their ramps -- those records had no coordinates and no ramp was '
          'ever within %.0f m of the water' % (len(lost), a.margin_m))
    for s in lost[:12]:
        print('    - %-34s had %d fictional record(s)' % (s, len(old[s])))
    if len(lost) > 12:
        print('    ... %d more' % (len(lost) - 12))

    if a.go:
        json.dump(out, open(dst, 'w', encoding='utf-8'), indent=1)
        print('\n-> %s' % dst)
        print('   re-run consolidate_lake_index.py so lake_index.json picks the ramps up')
    else:
        print('\nDRY RUN -- nothing written. Add --go.')


if __name__ == '__main__':
    main()
