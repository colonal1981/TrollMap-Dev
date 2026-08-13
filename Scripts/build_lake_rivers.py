#!/usr/bin/env python3
r"""build_lake_rivers.py - tell the registry what river each lake actually IS.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\build_lake_rivers.py `
       --gpkg "F:\TrollMapPipeline\3dhp_all_CONUS_20260112_GPKG\3dhp_all_CONUS_20260112_GPKG.gpkg" `
       --registry "F:\TrollMapPipeline\registry"

WHY THIS EXISTS

`build_water_bindings.py` matches a gauge to a lake by sharing a strong token between the gauge's
name and the LAKE's name -- `rec.get('name')`, `display_name`, `legacy_display_names`, and nothing
else. Kentucky Lake's tokens are {kentucky, lake}; `lake` is weak, so the only real one is
`kentucky`. Every gauge on it is called "Tennessee River at <town>". No shared token, so the name
test fails and all six drop into `review_geom_only`.

**An impoundment is almost never named after the river it impounds.** Kentucky Lake / Tennessee
River. Belews Lake / Dan River. Tuckertown Reservoir / Yadkin River. Old Hickory Lake / Cumberland
River. That single blind spot is most of the 647-row review pile and a good share of the 643
lakes carrying no binding at all -- one missing join, repeated.

Ryan, 2026-08-13: *"it is named... it is on the river... and it has a location... how is this not
automatically matched"*. It is now.

WHERE THE ANSWER COMES FROM

3DHP names the FLOWLINE even where it leaves the impoundment unnamed -- the same fact that
identified Cheatham as `OH4IA` this morning. Query the flowline table's RTree for each lake's
bounding box, total `lengthkm` per `gnisidlabel`, and the mainstem falls out at the top. Measured
inside Kentucky Lake: two flowlines labelled "Tennessee River".

Names are kept when they carry at least `--min-share` of the longest label's length, capped at
`--max-names`, because a reservoir legitimately IS its mainstem plus its major arms and a gauge on
any of them is on this water. Everything below that is a roadside ditch sharing a bounding box.

WHY THIS IS SAFE

The binder needs name AND geometry, always. The Tennessee River runs through five TVA pools, so
this hands the same river name to all five -- and the geometry test still puts the Perryville
gauge in exactly one of them. Widening the name side cannot bind a gauge to water it is not on;
it can only stop refusing one that it is.

A bbox is not containment, so a tributary just outside the shoreline can be picked up. That is
the same trade, and the same reason it is safe.
"""
import argparse, json, os, sqlite3, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lookup_3dhp import albers          # one projection, defined once, asserted there

FL = 'hydro_3dhp_all_flowline'


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--gpkg', required=True)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--out', help='default <registry>/_lake_rivers.json')
    ap.add_argument('--min-share', type=float, default=0.15,
                    help='keep a river name if its total length is this share of the longest '
                         '(default 0.15)')
    ap.add_argument('--max-names', type=int, default=4)
    ap.add_argument('--pad-km', type=float, default=0.5,
                    help='grow the lake bbox by this much before the RTree query, because a '
                         'gauge sits on the bank and so does the flowline label (default 0.5)')
    ap.add_argument('--only', help='comma list of slugs, for a smoke test')
    ap.add_argument('--limit', type=int, help='stop after N lakes')
    ap.add_argument('--index-only', action='store_true',
                    help='only lakes in lake_index.json -- the water the app can actually offer')
    a = ap.parse_args()

    reg = a.registry
    lakes = json.load(open(os.path.join(reg, 'lakes.json'), encoding='utf-8'))['lakes']
    meta = {r['slug']: r for r in lakes} if isinstance(lakes, list) else lakes
    slugs = [s for s, v in meta.items() if v.get('bounds_wsen')]
    if a.index_only:
        idx = json.load(open(os.path.join(reg, 'lake_index.json'), encoding='utf-8'))
        slugs = [s for s in slugs if s in idx]
    if a.only:
        want = {x.strip() for x in a.only.split(',') if x.strip()}
        missing = want - set(slugs)
        slugs = [s for s in slugs if s in want]
        if missing:
            print('--only: %d named but absent or without bounds: %s'
                  % (len(missing), ', '.join(sorted(missing))))
    if a.limit:
        slugs = slugs[:a.limit]
    print('%d lake(s) with bounds' % len(slugs))

    con = sqlite3.connect('file:%s?mode=ro&immutable=1' % a.gpkg.replace('\\', '/'), uri=True)
    cur = con.cursor()
    sql = ('SELECT gnisidlabel, lengthkm FROM %s WHERE gnisidlabel IS NOT NULL AND fid IN '
           '(SELECT id FROM rtree_%s_shape WHERE maxx>=? AND minx<=? AND maxy>=? AND miny<=?)'
           % (FL, FL))

    out, t0, none = {}, time.time(), 0
    pad = a.pad_km * 1000.0
    for k, s in enumerate(slugs, 1):
        w, sth, e, n = meta[s]['bounds_wsen']
        # Project all four corners: Albers is not axis-aligned to lon/lat, so projecting two
        # corners and assuming a rectangle clips the other two off the query.
        xs, ys = zip(*[albers(lo, la) for lo in (w, e) for la in (sth, n)])
        try:
            rows = cur.execute(sql, (min(xs) - pad, max(xs) + pad,
                                     min(ys) - pad, max(ys) + pad)).fetchall()
        except sqlite3.Error as ex:
            print('   %s: %s' % (s, ex))
            continue
        tot = {}
        for lbl, km in rows:
            lbl = (lbl or '').strip()
            if lbl:
                tot[lbl] = tot.get(lbl, 0.0) + float(km or 0)
        if not tot:
            none += 1
            continue
        top = max(tot.values())
        keep = [nm for nm, v in sorted(tot.items(), key=lambda kv: -kv[1])
                if v >= top * a.min_share][:a.max_names]
        out[s] = {'rivers': keep, 'km': {nm: round(tot[nm], 1) for nm in keep}}
        # Every 25, not every 100. At roughly a second a lake a 100-lake stride is a minute and
        # a half of silence, which is indistinguishable from a hang -- the same mistake
        # build_garmin_water_inventory.py made with its 26-second tile scan.
        if k % 25 == 0 or k == len(slugs):
            el = (time.time() - t0) / 60
            print('   %d/%d  %.1f min, ~%.1f min left'
                  % (k, len(slugs), el, el / k * (len(slugs) - k)), flush=True)

    fp = a.out or os.path.join(reg, '_lake_rivers.json')
    tmp = fp + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump({'generatedBy': 'build_lake_rivers.py', 'gpkg': os.path.basename(a.gpkg),
                   'minShare': a.min_share, 'maxNames': a.max_names, 'padKm': a.pad_km,
                   'lakes': out}, fh, indent=1)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, fp)
    print('\n%d lake(s) got a river name, %d had no named flowline in reach' % (len(out), none))
    print('-> %s' % fp)
    print('   feed it to build_water_bindings.py --lake-rivers')
    return 0


if __name__ == '__main__':
    sys.exit(main())
