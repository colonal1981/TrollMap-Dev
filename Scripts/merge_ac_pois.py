#!/usr/bin/env python3
r"""merge_ac_pois.py -- put the ActiveCaptain POIs into packs that are already built.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\merge_ac_pois.py --packs F:\TrollMapPipeline\chartpack `
       --registry F:\TrollMapPipeline\registry `
       --db "F:\TrollMapPipeline\POSSIBLY_NEW_GARMIN_CHARTS\active_captain.db" --dry-run
    py .\scripts\merge_ac_pois.py --packs ... --registry ... --db ...

WHY THIS EXISTS RATHER THAN A REBUILD

`build_chartpack.py` has taken `--ac` since it was written, and `build_all_chartpacks.py` imports
pieces of that module without ever calling its `main()`. So the flag has never been passed and NO
SHIPPED PACK CONTAINS AN ACTIVECAPTAIN POI -- measured across 120 packs, every `source` value is
`RGN4 pool-*`. Getting them in that way means rebuilding 373 packs to change one layer.

This reads `pois.geojson` and writes `pois.geojson`. Nothing else in a pack is touched, no tile is
opened, and `merge_pois()` is imported from `build_chartpack.py` rather than restated, so the
dedupe rule stays in one place: same name AND within 50 m is the same feature, ActiveCaptain keeps
its surveyed position, and a Garmin business card that says Ramp beats an ActiveCaptain guess.

THE COORDINATES ARE SEMICIRCLES, NOT DEGREES

`rIndex` is an rtree_i32 and its values are Garmin semicircles -- degrees * 2^31 / 180. Read as
degrees/1e7 they look plausible enough to fool you: the whole database lands between -160 and -62
longitude, which is a good North America, and Charleston Harbour comes out in the Gulf of Alaska.
The tell is that no marker falls in both a US-east latitude band and a US-east longitude band.

WHAT IS ON WATER

An AC record has no such field. The lake's own mask decides it, the same mask the build clips
with: inside the boundary is `on_water: true`, inside the 250 m collar only is `false`. The app
hides land POIs by default (`_poiOnWaterOnly` in supplemental-layers.js), so a marina office
across the road stays out of the way without being thrown away.
"""
from __future__ import annotations
import argparse, json, os, sqlite3, sys, time
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_chartpack import build_mask, _rings, merge_pois  # noqa: E402

BUFFER_M = 250.0
DEG = BUFFER_M / 111320.0
SEMI = 180.0 / 2147483648.0

# ActiveCaptain's marker classes, and the app style each becomes. The names on the right all
# already exist in POI_STYLE (supplemental-layers.js) -- nothing here needs an app change.
#
# Everything unmapped becomes `place_name` rather than being dropped, and every feature keeps
# `ac_poi_type` so a class can be styled later without re-reading the database.
AC_TYPE = {
    64:   'boat_ramp',      # boat landings, state docks, park access -- the half Ryan wants
    8:    'marina',         # marinas, docks, yacht clubs
    128:  'marine_dealer',  # services, repair, dealers
    2048: 'dam',
    1024: 'dam',            # locks: a lock is a dam you can pass through
    512:  'height_marker',  # bridges, which is what the clearance symbol is for
    4:    'hazard_area',    # shoaling, obstructions, tricky entrances
}


def load_json(p):
    with open(p, encoding='utf-8') as fh:
        return json.load(fh)


def ac_features(cur, box):
    """Every ActiveCaptain marker inside `box`, as GeoJSON in the shape merge_pois() expects."""
    w, s, e, n = box
    def enc(d):
        return int(round(d / SEMI))
    q = ('select m.id, m.name, m.poi_type, r.minLon, r.minLat '
         'from rIndex r join markers m on m.id = r.id '
         'where r.minLon >= ? and r.maxLon <= ? and r.minLat >= ? and r.maxLat <= ?')
    out = []
    for mid, name, ptype, lon_i, lat_i in cur.execute(q, (enc(w), enc(e), enc(s), enc(n))):
        nm = (name or '').strip()
        if not nm:
            continue                     # an unnamed AC record cannot be deduped and says nothing
        out.append({
            'type': 'Feature',
            'properties': {
                'name': nm,
                'poi_type': AC_TYPE.get(ptype, 'place_name'),
                'ac_poi_type': ptype,
                'ac_id': mid,
                'source': 'activecaptain',
            },
            'geometry': {'type': 'Point',
                         'coordinates': [round(lon_i * SEMI, 6), round(lat_i * SEMI, 6)]},
        })
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--packs', required=True)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--db', required=True, help='active_captain.db')
    ap.add_argument('--only-lakes', default=None, help='comma list or a file of slugs')
    ap.add_argument('--radius-m', type=float, default=50.0,
                    help='same name within this distance is the same feature (default 50)')
    ap.add_argument('--list', default=None,
                    help='where to write the changed slugs (default <packs>/../outputs/'
                         'ac_merged_lakes.txt)')
    ap.add_argument('--dry-run', action='store_true', help='measure and print, write nothing')
    a = ap.parse_args()

    if not os.path.exists(a.db):
        sys.exit('no ActiveCaptain database at %s' % a.db)
    idx = load_json(os.path.join(a.registry, 'lake_index.json'))
    todo = sorted(idx)
    if a.only_lakes:
        raw = a.only_lakes
        if os.path.exists(raw):
            with open(raw, encoding='utf-8') as fh:
                want = {l.strip() for l in fh if l.strip()}
        else:
            want = {s.strip() for s in raw.split(',') if s.strip()}
        todo = [s for s in todo if s in want]
        print('--only-lakes: %d of %d requested slugs are in the index' % (len(todo), len(want)))

    con = sqlite3.connect('file:%s?mode=ro' % a.db, uri=True)
    cur = con.cursor()
    print('%d lakes; ActiveCaptain database %s' % (len(todo), os.path.basename(a.db)))

    changed, t0 = {}, time.time()
    tot_added = tot_merged = tot_dropped = 0
    for i, slug in enumerate(todo, 1):
        pack = os.path.join(a.packs, slug)
        ppath = os.path.join(pack, 'pois.geojson')
        if not os.path.isdir(pack) or not os.path.exists(ppath):
            continue
        box = (idx[slug].get('bounds_wsen') or [None] * 4)
        if None in box or len(box) != 4:
            continue
        cand = ac_features(cur, (box[0] - DEG, box[1] - DEG, box[2] + DEG, box[3] + DEG))
        if not cand:
            continue

        bpath = os.path.join(a.registry, 'boundaries', slug + '.geojson')
        if not os.path.exists(bpath):
            continue
        gj = load_json(bpath)
        geoms = [f.get('geometry') for f in (gj.get('features') or [])] or [gj.get('geometry') or gj]
        rings = [r for g in geoms if g for r in _rings(g)]
        if not rings:
            continue
        # NO `exclude=`, deliberately. Bathymetry is resolved to one owner because a contour
        # describes one body of water; POINTS ARE THE OPPOSITE and the pack rule says so --
        # "a ramp or a dock genuinely sits just off the bank and the collar is there to catch
        # it, so pois, docks and shoreline stay shared and are not resolved". A ramp on the
        # Cooper is also a ramp on Charleston Harbour. It also saves building the whole
        # nesting map for a question that does not use it.
        mask = build_mask(rings, DEG)
        if mask is None:
            continue

        # A marker in the bounding box is not a marker on the water. The mask is the same one the
        # build clips with, so this keeps exactly what the pack would have kept.
        keep, dropped = [], 0
        for f in cand:
            x, y = f['geometry']['coordinates']
            if (x, y) not in mask:
                dropped += 1
                continue
            f['properties']['on_water'] = mask.cell_of(x, y) in mask.core
            keep.append(f)
        tot_dropped += dropped
        if not keep:
            continue

        doc = load_json(ppath)
        garmin = list(doc.get('features') or [])
        before = len(garmin)
        # MEASURE BEFORE THE CALL. merge_pois() appends the unmatched Garmin features INTO the
        # ActiveCaptain list and returns that same list, so reading len(keep) afterwards reports
        # the merged total and the ActiveCaptain count is gone. It reported "5 pois + 6 AC -> 6"
        # for a pack that actually went 5 -> 11.
        n_ac = len(keep)
        onw = sum(1 for f in keep if f['properties'].get('on_water'))
        feats, merged, added = merge_pois(garmin, keep, radius_m=a.radius_m)
        tot_added += n_ac
        tot_merged += merged
        changed[slug] = {'before': before, 'after': len(feats), 'ac': n_ac,
                         'on_water': onw, 'merged': merged, 'outside': dropped}
        print('   %-34s %4d pois + %3d AC (%d on water) -> %4d   %d shared a name with a Garmin POI'
              % (slug, before, n_ac, onw, len(feats), merged))

        if not a.dry_run:
            doc['features'] = feats
            props = doc.setdefault('properties', {})
            props['activecaptain'] = os.path.basename(a.db)
            props['ac_merged'] = time.strftime('%Y-%m-%d')
            tmp = ppath + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as fh:
                json.dump(doc, fh, ensure_ascii=False)
            os.replace(tmp, ppath)

    print()
    print('%d pack(s) changed of %d examined, %.1f min'
          % (len(changed), len(todo), (time.time() - t0) / 60.0))
    print('ActiveCaptain records added:               %d' % tot_added)
    print('of those, merged onto a Garmin POI:        %d' % tot_merged)
    print('inside the box but outside the water:   %d' % tot_dropped)

    if a.dry_run:
        print('\n--dry-run: nothing written.')
        return 0
    lp = a.list or os.path.join(os.path.dirname(a.packs.rstrip('\\/')), 'outputs',
                                'ac_merged_lakes.txt')
    os.makedirs(os.path.dirname(lp), exist_ok=True)
    with open(lp, 'w', encoding='utf-8') as fh:
        for s in sorted(changed):
            fh.write(s + '\n')
    print('-> %s  (%d slugs)' % (lp, len(changed)))
    print('\nNOTHING DOWNSTREAM READS pois.geojson -- structure, trolling runs and water features')
    print('all derive from contours and depth areas. Upload the packs and clear the browser cache.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
