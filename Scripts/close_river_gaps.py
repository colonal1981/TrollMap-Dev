#!/usr/bin/env python3
r"""close_river_gaps.py -- the charted water between a river and the next water we offer, given to the river.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.

    py F:\TrollMapPipeline\TrollMap-Dev\Scripts\close_river_gaps.py --registry F:\TrollMapPipeline\registry `
       --chartpack F:\TrollMapPipeline\chartpack --extract F:\TrollMapPipeline\extract
    ... --go        write the boundaries it lists (a REGISTRY change: Ryan runs it)
    ... --check     write nothing; exit 1 if any river still has a gap (the pipeline step, after the cut)

WHY. 2026-11-27, after three runs of the November rebuild: check_pack_against_app.mjs flagged the Savannah's
last 1.2 km as "nothing charted", twice, and it was called "already shipping that way" twice. Ryan: *"Savannah
river drains into the Atlantic, there is 0 chance that is not charted"*. He was right. Garmin charts it all the
way; OUR boundaries left a hole. savannah_river's stops at 32.474, coast_savannah_ga starts at 32.250, and the
1,302 acres of charted river between them were in no pack. That came from August, when the rivers were cut off
where the coastal zone boxes began, and the zone was drawn smaller afterwards. And then, on why it keeps happening:
*"You advocate for moving on and me not understanding the process we don't fix it then we are left to do it all
over again"*. So this finds every case, closes it, and runs as a check so the next quarter cannot ship one.

WHAT A GAP IS, AND NOTHING IN IT IS A TUNED NUMBER.
  * At each end of each offered river's centreline, follow Garmin's charted water (zoom-0 depth areas, the channel
    bands from 2 ft) that NO offered boundary claims, polygon to polygon.
  * It is a gap when that water reaches ANOTHER WATER WE OFFER. Then it is the river's channel between two of our
    waters and belongs to the river: the rule extend_river_boundary.py already applies ("give a river pack the rest
    of its own channel") and the one Ryan set on 2026-08-19, "nothing is ever drawn twice, nothing disappears".
  * It is NOT this river's when it is bigger than the river itself. The Dan runs into 44,375 charted acres -- Kerr
    Lake, which the app does not offer -- and taking that would turn a river into a lake. Reported, never taken.
  * Charted water that runs on and reaches nothing we offer is a water the app does not have (the New River below
    the South Fork, the lower Chattahoochee). Reported, never taken: adding a water is a decision, not a repair.
  * The walk starts only from water within a step of the RIVER'S OWN BOUNDARY, and never steps onto a piece that
    lies along ANOTHER water's outline for at least half its edge. That piece is the other water's own margin or a
    hole inside it, not a channel between the two. Part 4 of the November rebuild (2026-11-27) had neither rule and
    gave rivers what was really lakes' water: 293 acres of Lake James's shoreline to the Catawba, a strip down the
    middle of Norris to the Clinch, slivers round Fontana to the Tuckasegee, Sinclair's coves to the Oconee, and
    the upper Pigeon on the far side of Waterville Lake to the Pigeon below it. Drawn end by end afterwards, the
    gaps that were real lie along their own banks: of the acres part 4 gave the lower Savannah, 100% are in pieces
    with under a fifth of their edge on another water's outline; the Cooper's tailrace 99%, the Holston to Fort
    Loudoun 80%. Lake James's shoreline is the reverse, 83% in pieces with four-fifths or more on the lake's
    outline, and Sinclair's coves 96%. The upper Pigeon lies along nothing; it never touches the river.

WHAT IS ADDED. The channel polygons, the shallower polygons of any depth touching them (the margin the clip would
otherwise drop), less every offered boundary -- so nothing is drawn twice and every new edge is Garmin's own except
the seam with the water it meets. Whole polygons, for the reason extend_river_boundary.py gives: build_structure.py
reads a boundary's rings as shore. The old boundary is copied to registry/boundaries/_before_close_gaps/ first.

THE STEP DISTANCES ARE GEOMETRY, NOT FISHING. Two polygons 60 m apart are the same water across a band seam or a
digitising gap; a water within 150 m is "reached" because boundaries are cut on a 0.0002-0.0004 deg grid (22-44 m)
and drawn with a collar. They decide what is connected, never how much is taken -- that is Garmin's chart.
"""
import argparse, json, math, os, shutil, sys
import numpy as np
import shapely
from shapely.geometry import shape, Point, box, MultiPolygon, Polygon, LineString, mapping
from shapely.ops import unary_union
from shapely.strtree import STRtree
from shapely.prepared import prep

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path: sys.path.insert(0, _HERE)
from build_ramp_reach import water_polys          # the one reader of the extract's depth areas

M = 111320.0
WINDOW_M = 40000.0        # how far round an end to read the chart; the Savannah's gap is 29 km end to end
STEP_M = 60.0             # same water across a seam
REACH_M = 150.0           # another water's boundary is this close: reached
SEED_M = 1500.0           # the end of a centreline is the river's last station, not its last drop of water
CHANNEL_FT = 2.0          # follow the channel, not the 0-1 ft outline Garmin draws round every marsh
HUG_M = 22.0              # "along another water's outline": within the boundary grid's finer step of it
HUG_SAMPLE_M = 10.0       # the edge is read every 10 m
HUG_SHARE = 0.5           # at least half its edge along another water: that water's, not a channel
ACRES = 1.0 / 4046.8564224


def _rings(g):
    for p in getattr(g, 'geoms', [g]):
        if p.geom_type == 'Polygon':
            yield p.exterior
            yield from p.interiors


def outline_tree(geoms, win):
    """Every other offered water's outline inside the window, in short pieces a point can be tested against."""
    segs = []
    for g in geoms:
        for r in _rings(g.intersection(win)):
            c = list(r.coords)
            for i in range(0, len(c) - 1, 32):
                segs.append(LineString(c[i:i + 33]))
    return STRtree(segs) if segs else None


def hug_share(g, tree, k):
    """The share of a piece's edge that lies within HUG_M of another offered water's outline."""
    if tree is None: return 0.0
    pts = []
    for r in _rings(g):
        pts.extend(shapely.segmentize(r, HUG_SAMPLE_M / (M * k)).coords[:-1])
    if not pts: return 0.0
    hit = tree.query(shapely.points(np.array(pts)), predicate='dwithin', distance=HUG_M / (M * k))
    return len(set(hit[0].tolist())) / len(pts)


class TileCache(dict):
    """The parsed tiles water_polys() keeps, the last few only. Keeping every tile it ever read took
    this to 16 GB on Ryan's 32 GB machine by the 37th river, so the oldest goes when there are more than
    `keep`, and the rivers are walked in tile order so neighbours reuse what is held."""
    def __init__(self, keep=6):
        super().__init__(); self.keep = keep; self.order = []

    def __setitem__(self, k, v):
        super().__setitem__(k, v); self.order.append(k)
        while len(self.order) > self.keep:
            super().pop(self.order.pop(0), None)


def load(p):
    with open(p, encoding='utf-8') as fh:
        return json.load(fh)


def boundary(registry, slug):
    p = os.path.join(registry, 'boundaries', slug + '.geojson')
    if not os.path.isfile(p): return None, None
    raw = load(p)
    g = unary_union([shape(f['geometry']).buffer(0) for f in (raw.get('features') or [raw])
                     if f.get('geometry')])
    return (None, None) if g.is_empty else (g, raw)


def acres(g, lat):
    return g.area * M * 110540.0 * math.cos(math.radians(lat)) * ACRES


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--chartpack', required=True)
    ap.add_argument('--extract', required=True)
    ap.add_argument('--only', default='', help='comma-separated river slugs (default: every offered river)')
    ap.add_argument('--report', help='write every end looked at, as JSON')
    ap.add_argument('--changed', help='write the slugs whose boundary changed, one a line (with --go)')
    ap.add_argument('--go', action='store_true', help='write the boundaries; without it nothing is touched')
    ap.add_argument('--check', action='store_true', help='exit 1 if any gap is found; writes nothing')
    a = ap.parse_args()
    for p in (a.registry, a.chartpack, a.extract):
        if not os.path.isdir(p):
            print('not a folder: %s' % p); return 2

    idx = load(os.path.join(a.registry, 'lake_index.json'))
    offered = sorted(k for k, v in idx.items() if isinstance(v, dict))
    rivers = [s for s in offered if idx[s].get('feature_type') == 'river']
    if a.only:
        want = set(x.strip() for x in a.only.split(',') if x.strip())
        rivers = [s for s in rivers if s in want]
    B, RAW = {}, {}
    for s in offered:
        g, raw = boundary(a.registry, s)
        if g is not None: B[s], RAW[s] = g, raw
    print('%d offered waters with a boundary, %d rivers to look at' % (len(B), len(rivers)), flush=True)

    tmap = load(os.path.join(a.registry, 'tile_lake_map.json')).get('by_lake') or {}
    rivers.sort(key=lambda s: (sorted(tmap.get(s) or ['~'])[0], s))
    cache, rows, changed = TileCache(), [], []
    for n, slug in enumerate(rivers, 1):
        cp = os.path.join(a.chartpack, slug, 'centreline.geojson')
        if slug not in B or not os.path.isfile(cp):
            continue
        line = load(cp)['features'][0]['geometry']['coordinates']
        grew = False
        # UNTIL NOTHING IS LEFT, NOT ONE PASS. The first run of this closed the Oconee's 3 acres at Lake
        # Sinclair, the rebuild moved the centreline's end onto the new water, and the check after it found
        # half an acre more that the first pass's seed had not reached. So once a gap is closed the next
        # pass seeds from the water just added, and an end is done only when a pass adds nothing.
        for which, pt in (('upstream', line[0]), ('downstream', line[-1])):
          k = math.cos(math.radians(pt[1]))
          zone = Point(pt[0], pt[1]).buffer(SEED_M / (M * k))
          for rnd in range(8):
            own = B[slug]
            dl, dt = WINDOW_M / (M * k), WINDOW_M / 110540.0
            bbox = (pt[0] - dl, pt[1] - dt, pt[0] + dl, pt[1] + dt)
            polys, _n, deep = water_polys(a.extract, a.registry, slug, bbox, with_depth=True, cache=cache)
            if not polys: break
            win = box(*bbox)
            names = [s for s in B if B[s].intersects(win)]
            preps = [prep(B[s]) for s in names]
            orphan = [i for i, g in enumerate(polys)
                      if not any(p.contains(g.representative_point()) for p in preps)]
            chan = [i for i in orphan if deep[i] >= CHANNEL_FT]
            if not chan: break
            tree = STRtree([polys[i] for i in chan])
            step = STEP_M / (M * k)
            # NOT ANOTHER WATER'S OWN EDGE (module docstring). A piece along another water's outline for half
            # its edge or more is that water's margin, or a hole inside it, and the walk never steps onto it.
            others_t = outline_tree([B[s] for s in names if s != slug], win)
            _hug = {}
            def lakes(i):
                if i not in _hug: _hug[i] = hug_share(polys[i], others_t, k) >= HUG_SHARE
                return _hug[i]
            # A SEED MUST TOUCH THE RIVER. Near the end is not enough: next to a lake almost any scrap of charted
            # water "reaches" the lake. After part 4 joined the Oconee to Lake Sinclair, its check took half an
            # acre of Sinclair's coves 120 m from the Oconee, and repeating from there hopped from cove to cove
            # through 153 acres of the lake.
            seen = set(int(j) for j in tree.query(zone, predicate='intersects')
                       if own.distance(polys[chan[int(j)]]) <= step and not lakes(chan[int(j)]))
            if not seen: break
            # Depth bands do not overlap, so the running sum IS the area. Once it passes the river's own
            # area the answer is already "another water", so the walk stops there: the Dan's Kerr Lake is
            # 42,000 polygons and was being followed to the last one only to be turned away.
            own_ac = acres(own, pt[1])
            gap_ac = sum(acres(polys[chan[j]], pt[1]) for j in seen)
            todo = list(seen)
            while todo and gap_ac <= own_ac:
                j = todo.pop()
                for q in tree.query(polys[chan[j]], predicate='dwithin', distance=STEP_M / (M * k)):
                    q = int(q)
                    if q not in seen and not lakes(chan[q]):
                        seen.add(q); todo.append(q); gap_ac += acres(polys[chan[q]], pt[1])
            comp = [polys[chan[j]] for j in seen]
            others_n = [s for s in names if s != slug]
            btree = STRtree([B[s] for s in others_n])
            reach = set()
            for g in comp:
                for q in btree.query(g, predicate='dwithin', distance=REACH_M / (M * k)):
                    reach.add(others_n[int(q)])
            reach = sorted(reach)
            row = {'slug': slug, 'end': which, 'end_at': [round(pt[1], 5), round(pt[0], 5)],
                   'charted_acres': round(gap_ac, 1), 'river_acres': round(own_ac, 1),
                   'reaches': reach, 'pass': rnd + 1}
            if gap_ac > own_ac:
                row['verdict'] = 'bigger than the river: another water, not taken (walk stopped there)'
            elif not reach:
                row['verdict'] = 'runs on into water the app does not offer'
            else:
                row['verdict'] = 'gap'
                ctree = STRtree(comp)
                add = list(comp)
                for i in orphan:
                    if deep[i] < CHANNEL_FT and len(ctree.query(polys[i], predicate='dwithin',
                                                                  distance=STEP_M / (M * k))) and not lakes(i):
                        add.append(polys[i])
                others = unary_union([B[s] for s in names if s != slug])
                piece = unary_union([g.buffer(0) for g in add]).difference(others).difference(own)
                new = unary_union([own, piece]).buffer(0)
                row['added_acres'] = round(acres(new, pt[1]) - own_ac, 1)
                B[slug] = new
                grew = True
            # A later pass that finds only water it will not take has nothing to say the first did not.
            if row['verdict'] == 'gap' or rnd == 0:
                rows.append(row)
            if row['verdict'] != 'gap' or piece.is_empty:
                break
            zone = piece.buffer(SEED_M / (M * k))
        if grew: changed.append(slug)
        print('%2d/%d %s' % (n, len(rivers), slug), flush=True)

    gaps = [r for r in rows if r['verdict'] == 'gap']
    print('\nGAPS -- charted channel between this river and another water we offer, in no pack:')
    for r in sorted(gaps, key=lambda r: -r['charted_acres']):
        print('  %-26s %-10s %8.1f ac of channel  +%8.1f ac to its boundary  reaches %s  (end %s)'
              % (r['slug'], r['end'], r['charted_acres'], r['added_acres'], ','.join(r['reaches']), r['end_at']))
    other = [r for r in rows if r['verdict'] != 'gap']
    if other:
        print('\nNOT TAKEN, and why:')
        for r in sorted(other, key=lambda r: -r['charted_acres']):
            print('  %-26s %-10s %8.1f ac  %s%s' % (r['slug'], r['end'], r['charted_acres'], r['verdict'],
                                                  ('  (reaches %s)' % ','.join(r['reaches'])) if r['reaches'] else ''))
    if a.report:
        with open(a.report, 'w', encoding='utf-8') as fh:
            json.dump({'_note': 'Personal use only, not for distribution or resale; not for navigation.',
                       'ends': rows}, fh, indent=1)
    if a.check:
        print('\n%d gap(s)%s' % (len(gaps), ' -- close them with --go and rebuild those rivers' if gaps else ''))
        return 1 if gaps else 0
    if not a.go:
        print('\nDRY RUN -- nothing written. %d river(s) would change: %s' % (len(changed), ', '.join(changed)))
        return 0
    bak = os.path.join(a.registry, 'boundaries', '_before_close_gaps')
    os.makedirs(bak, exist_ok=True)
    for slug in changed:
        src = os.path.join(a.registry, 'boundaries', slug + '.geojson')
        if not os.path.exists(os.path.join(bak, slug + '.geojson')):
            shutil.copy2(src, os.path.join(bak, slug + '.geojson'))
        g = B[slug]
        g = MultiPolygon([g]) if isinstance(g, Polygon) else MultiPolygon([p for p in g.geoms if isinstance(p, Polygon)])
        props = (RAW[slug].get('features') or [{}])[0].get('properties') or {}
        with open(src, 'w', encoding='utf-8') as fh:
            json.dump({'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'properties': props,
                                                                  'geometry': mapping(g)}]}, fh)
        print('wrote %s' % src)
    if a.changed:
        with open(a.changed, 'w', encoding='utf-8') as fh:
            fh.write('\n'.join(changed) + '\n')
    print('\n%d boundar%s written; the originals are in %s. Those rivers must be rebuilt.'
          % (len(changed), 'y' if len(changed) == 1 else 'ies', bak))
    return 0


if __name__ == '__main__':
    sys.exit(main())
