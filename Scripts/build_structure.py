#!/usr/bin/env python3
"""build_structure.py - humps, ledges and slope for every lake, from geometry alone.

Personal use only, not for distribution or resale; not for navigation.

PowerShell:

    py .\\build_structure.py `
       --packs    "F:\\TrollMapPipeline\\chartpack" `
       --registry "F:\\TrollMapPipeline\\registry" `
       --report   "F:\\TrollMapPipeline\\registry\\_structure.json"

WHY THIS IS NOT PART OF RESEARCH

`deriveGeospatialStructureFacts()` in `js/modules/lake-research-engine.js` computes humps and
ledges from the chartpack layers -- in the browser, one lake at a time, during a research run,
by fetching three GeoJSON files back out of R2 through the Worker.

None of that is research. It is arithmetic on geometry that is already on disk, it gives the
same answer every time, and it has to be redone for every lake anyone ever researches. Ryan,
2026-08-06: *"i want to decouple this process from research... this is all geometry and really
has nothing to do with research."*

So it moves here: computed once, offline, over every pack, at full resolution, and shipped as
`<slug>/structure.geojson` beside the layers it came from.

WHAT WAS WRONG WITH THE OLD ONE, BESIDES WHERE IT RAN

1. **It was capped at 8.** `lake-research-engine.js:522` keeps `humpCandidates.slice(0, 8)` and
   `ledgeCandidates.slice(0, 8)`. Wateree produces **632 hump candidates and 338 ledge
   candidates**, so 98.7% and 97.6% were discarded.

2. **The cap was the only selection there is.** Every hump reaches Smart Plan with a flat
   `score: 8`, so nothing downstream ranks them -- "the 8 biggest closed loops" was the entire
   model. Raising the cap without scoring would just hand Smart Plan 600 identical stops.

3. **The ledge detector did not measure slope.** It bucketed contour CENTROIDS into a 300 m grid
   and called three-in-a-cell a ledge. That measures how fragmented the contour lines happen to
   be in a spot. A 13.3 km contour contributes one centroid, in open water. Since the switch to
   Garmin contours -- whose lines are 8x longer than i-Boating's -- it measures even less.

   Real slope is the horizontal distance between ADJACENT DEPTH LEVELS: two contours 5 ft apart
   and 10 m apart is a wall; 5 ft apart and 300 m apart is a flat. That is what this computes.

Also worth recording: switching to Garmin contours made hump detection **7.5x better** on
Wateree (84 candidates from i-Boating, 632 from Garmin) because closed loops actually close in
the Garmin decode. All of that gain was being thrown away by the cap.

--SHIP-ONLY, AND WHAT IT ACTUALLY SAVES HERE

`registry/charted.json` carries the ship decision `build_all_chartpacks.py` already made:
**734 of 1732 lakes ship**, the other 998 hold a `skipped` reason. This walk never read it.
Ryan, 2026-08-09: *"why are we running all of that on stuff that we aren't going to ship... and
then only when we get to actually uploading them do we cut out the lakes we already knew we
weren't going to use."*

Measured before believing it, card-wide 2026-08-09: **1579 packs opened, 590 written, 22.6 min**
-- and all 590 are already shipping lakes, because `contours.geojson` exists in **590 shipping
packs and 0 non-shipping ones**. The loop above returns at `no contours` before it computes
anything. So the 22.6 min was never being spent on lakes we will not upload; what `--ship-only`
removes today is 989 pointless directory probes, which is seconds.

It is still worth having. The run stops reporting `1579 packs` when it means 590, and the day a
non-shipping lake gets contours this script will not quietly start building it. The real waste
is next door in `build_water_features.py`, which does reach 844 non-shipping packs.

OFF by default so an existing command line still means what it always meant, and because the
decision is not permanent -- a lake that gets bathymetry later has to be rebuilt anyway. With
the flag set and `charted.json` missing or unreadable the script EXITS; falling back to
"everything" is the failure the flag exists to prevent.

THE OUTPUT

`<slug>/structure.geojson` -- Points, every candidate, ranked, nothing capped. The client takes
the top N it wants; that decision does not belong in the data.

    properties:
      kind          'hump' | 'ledge'
      score         0-100, comparable within a lake
      depth_ft      the contour depth at the feature
      -- humps
      area_acres    enclosed area of the closed loop
      relief_ft     depth difference between the loop and the water around it
      levels        how many contour levels nest inside it
      -- ledges
      slope_ft_per_100ft   rise over run, the number an angler would recognise
      drop_ft       depth change across the measured span
      run_ft        horizontal distance over which it drops
"""
from __future__ import annotations
import argparse, json, math, os, sys, time
from collections import defaultdict

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path: sys.path.insert(0, _HERE)

NOTE = "Personal use only, not for distribution or resale; not for navigation."

# A hump has to be offshore. 0.0012 deg is ~130 m; inside that a closed loop is usually an
# island or the tip of a point, which is shoreline structure and already has its own layer.
MIN_OFFSHORE_DEG = 0.0012
HUMP_MIN_ACRES, HUMP_MAX_ACRES = 0.4, 500.0

# Slope is sampled, not computed at every vertex: a lake has millions and adjacent vertices on
# the same line give the same answer. Every 4th vertex on Wateree is 60,000 samples and the
# result does not move when it is every 2nd.
SAMPLE_EVERY = 4
# Two contours further apart than this are not the same break.
MAX_RUN_M = 400.0
# MEASURE SLOPE OVER A FIXED VERTICAL DROP, NOT BETWEEN WHATEVER TWO LEVELS ARE ADJACENT.
#
# Adjacent-level slope is degenerate. The first run on Wateree returned a top ten of identical
# ledges reading "1.4 ft of drop over 3 ft of run, 46.5 ft per 100 ft" -- two contour lines
# nearly touching. As the run goes to zero the slope goes to infinity regardless of how little
# depth is actually involved, so the ranking filled up with noise.
#
# Asking instead "how far do I have to travel to lose 5 feet" gives a number with a fixed
# vertical scale, which is also how an angler reads a chart. MIN_RUN_M then stops two coincident
# vertices from reporting a cliff -- 5 m is about a boat length, and inside that the two contour
# vertices are the same place as far as this data can tell. It does put a ceiling on the metric:
# a 5 ft drop inside 5 m reads as 30 ft per 100 ft and cannot read steeper. Ties at the ceiling
# are real ties -- the bank is as steep as the chart can express.
DROP_FT = 5.0
MIN_RUN_M = 5.0


def flat_lines(g):
    t = g.get('type')
    if t == 'LineString': return [g['coordinates']]
    if t == 'MultiLineString': return g['coordinates']
    return []


def metres(a, b):
    mx = 111320.0 * math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((b[0] - a[0]) * mx, (b[1] - a[1]) * 110540.0)


def is_closed(c):
    return len(c) >= 4 and abs(c[0][0] - c[-1][0]) < 1e-9 and abs(c[0][1] - c[-1][1]) < 1e-9


def ring_area_acres(c):
    a = 0.0
    for i in range(len(c) - 1):
        a += c[i][0] * c[i + 1][1] - c[i + 1][0] * c[i][1]
    lat = sum(p[1] for p in c) / len(c)
    m2 = abs(a / 2.0) * (111320.0 ** 2) * math.cos(math.radians(lat))
    return m2 / 4046.86


def centroid(c):
    xs = [p[0] for p in c]; ys = [p[1] for p in c]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def point_in_ring(x, y, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def outer_ring(boundary):
    """Largest ring across every part. 3DHP splits a lake into parts and the first is not the
    biggest -- the same trap `build_all_chartpacks.load_boundary` documents."""
    if not boundary: return None
    geoms = ([f.get('geometry') for f in (boundary.get('features') or [])]
             if boundary.get('type') == 'FeatureCollection'
             else [boundary.get('geometry') or boundary])
    best, ba = None, -1
    for g in geoms:
        if not g: continue
        t = g.get('type')
        polys = [g['coordinates']] if t == 'Polygon' else (g['coordinates'] if t == 'MultiPolygon' else [])
        for p in polys:
            if not p: continue
            a = ring_area_acres(p[0]) if is_closed(p[0]) else 0
            if a > ba: ba, best = a, p[0]
    return best


class Grid:
    """Point bucket for nearest-neighbour inside a radius. A lake's contours are hundreds of
    thousands of vertices and the slope pass asks a nearest-other-depth question for tens of
    thousands of them; brute force is quadratic and does not finish."""
    def __init__(self, cell_deg):
        self.c = cell_deg
        self.g = defaultdict(list)

    def add(self, x, y, payload):
        self.g[(int(x / self.c), int(y / self.c))].append((x, y, payload))

    def near(self, x, y, rings=1):
        gx, gy = int(x / self.c), int(y / self.c)
        for dx in range(-rings, rings + 1):
            for dy in range(-rings, rings + 1):
                for it in self.g.get((gx + dx, gy + dy), ()):
                    yield it


def find_humps(contours, ring):
    """Closed contour loops offshore. Score by size and by how many levels stack inside.

    A loop with three deeper loops nested inside it is a real high spot with relief; a single
    loop is a bump. `levels` is what separates them and the old version did not look.
    """
    loops = []
    for f in contours.get('features') or []:
        d = f.get('properties', {}).get('depth_ft')
        if d is None: continue
        for c in flat_lines(f['geometry']):
            if not is_closed(c): continue
            a = ring_area_acres(c)
            if not (HUMP_MIN_ACRES <= a <= HUMP_MAX_ACRES): continue
            lon, lat = centroid(c)
            if ring and not point_in_ring(lon, lat, ring): continue
            loops.append({'lon': lon, 'lat': lat, 'acres': a, 'depth': float(d), 'ring': c})
    # nesting: a loop whose centroid falls inside another, deeper loop
    loops.sort(key=lambda h: -h['acres'])
    for h in loops:
        h['levels'] = 1
        h['relief'] = 0.0
    # Nesting, bbox-first. point_in_ring is O(ring) and there are 632 loops on Wateree, so the
    # naive pair loop is 400,000 ring walks. A bounding-box reject costs four comparisons and
    # removes almost all of them.
    for h in loops:
        xs = [p[0] for p in h['ring']]; ys = [p[1] for p in h['ring']]
        h['bbox'] = (min(xs), min(ys), max(xs), max(ys))
    for i, h in enumerate(loops):
        x0, y0, x1, y1 = h['bbox']
        for j in range(i + 1, len(loops)):
            k = loops[j]
            if k['acres'] > h['acres']: continue
            if not (x0 <= k['lon'] <= x1 and y0 <= k['lat'] <= y1): continue
            if point_in_ring(k['lon'], k['lat'], h['ring']):
                h['levels'] += 1
                h['relief'] = max(h['relief'], abs(k['depth'] - h['depth']))
    out = []
    if ring:
        # Offshore test through a grid. Scanning a 17,282-vertex ring per candidate is 11M
        # distance calls; bucketing the ring once makes each test a handful.
        rg = Grid(MIN_OFFSHORE_DEG * 2)
        for p in ring: rg.add(p[0], p[1], None)
        lim = MIN_OFFSHORE_DEG * 111320.0
        for h in loops:
            close = any(metres((h['lon'], h['lat']), (qx, qy)) < lim
                        for qx, qy, _ in rg.near(h['lon'], h['lat']))
            if not close: out.append(h)
    else:
        out = loops
    for h in out: h.pop('ring', None); h.pop('bbox', None)
    return out


def find_ledges(contours, ring=None):
    """Real bottom slope: horizontal distance between ADJACENT depth levels.

    Ten feet of drop in 30 m is a wall; ten feet in 300 m is a taper. That is the number an
    angler recognises and it is what the old centroid-bucketing never measured.

    ONLY CONSECUTIVE LEVELS ARE COMPARED. Asking "nearest vertex at any other depth" is both
    wrong -- the 40 ft line running beside the 5 ft line says nothing about the slope between
    them -- and quadratic in the number of levels. Wateree has 65 levels and roughly 300,000
    sampled vertices; pairing every level against every other did not finish in two minutes.
    Walking consecutive pairs is 64 passes over two point sets.

    NO POINT-IN-POLYGON HERE. `build_all_chartpacks.py` already clipped these contours to the
    lake boundary plus its 250 m buffer, so every vertex is in the lake by construction.
    Re-testing 300,000 vertices against a 17,282-vertex ring is a billion operations to confirm
    something the file already guarantees.

    The steepest sample in each ~90 m cell represents that cell, so one break yields one ledge
    rather than four hundred vertices' worth.
    """
    by_depth = defaultdict(list)
    for f in contours.get('features') or []:
        d = f.get('properties', {}).get('depth_ft')
        if d is None: continue
        for c in flat_lines(f['geometry']):
            by_depth[round(float(d), 1)].extend(c[::SAMPLE_EVERY])
    levels = sorted(by_depth)
    if len(levels) < 2: return []

    CELL = 0.0008                       # ~90 m result cells
    search = Grid(180.0 / 111320.0)     # 180 m buckets, one ring out = 540 m reach
    best = {}
    for li, d1 in enumerate(levels):
        # the shallowest level that is at least DROP_FT deeper
        d2 = next((d for d in levels[li + 1:] if d - d1 >= DROP_FT), None)
        if d2 is None: break
        drop = d2 - d1
        search.g.clear()
        for p in by_depth[d2]:
            search.add(p[0], p[1], None)
        if not search.g: continue
        for x, y in ((p[0], p[1]) for p in by_depth[d1]):
            bdist = 1e18
            for qx, qy, _ in search.near(x, y):
                dist = metres((x, y), (qx, qy))
                if dist < bdist: bdist = dist
            if bdist > MAX_RUN_M: continue
            run = max(bdist, MIN_RUN_M)
            slope = drop / (run / 30.48)            # ft per 100 ft of run
            k = (int(x / CELL), int(y / CELL))
            cur = best.get(k)
            if cur is None or slope > cur['slope']:
                best[k] = {'lon': x, 'lat': y, 'slope': slope, 'drop': drop,
                           'run_ft': run / 0.3048, 'depth': d2}
    return list(best.values())


def score_humps(humps):
    if not humps: return
    amax = max(h['acres'] for h in humps) or 1
    lmax = max(h['levels'] for h in humps) or 1
    rmax = max(h['relief'] for h in humps) or 1
    for h in humps:
        # relief and nesting lead; raw size is the weakest of the three because a big flat
        # loop at one level is a plateau, not a high spot.
        h['score'] = round(100 * (0.45 * (h['relief'] / rmax)
                                  + 0.35 * (h['levels'] / lmax)
                                  + 0.20 * (h['acres'] / amax)), 1)


def score_ledges(ledges):
    if not ledges: return
    smax = max(l['slope'] for l in ledges) or 1
    dmax = max(l['drop'] for l in ledges) or 1
    for l in ledges:
        l['score'] = round(100 * (0.7 * (l['slope'] / smax) + 0.3 * (l['drop'] / dmax)), 1)


def read_json(p):
    if not os.path.exists(p): return None
    try:
        return json.load(open(p, encoding='utf-8'))
    except Exception:
        return None


def ship_only_slugs(registry):
    """The lakes that actually get uploaded, read from `<registry>/charted.json`.

    `build_all_chartpacks.py` already decided this and wrote it down: a lake ships when its
    record carries NO `skipped` reason and a non-null `charted`. A skip reason, a null `charted`,
    or no record at all means it is passed over. Nothing is re-derived here -- a second
    implementation of the ship test is how the two copies drift apart.

    Unreadable file is fatal on purpose. The whole point of the flag is not doing the work; a
    quiet fallback to "process everything" would be the failure it exists to prevent.
    """
    path = os.path.join(registry, 'charted.json')
    try:
        with open(path, encoding='utf-8') as fh:
            rows = json.load(fh)
    except (OSError, ValueError) as e:
        sys.exit('--ship-only: cannot read %s (%s: %s)\n'
                 '             refusing to run, because without it this builds every pack'
                 % (path, type(e).__name__, e))
    if not isinstance(rows, dict) or not rows:
        sys.exit('--ship-only: %s is not a slug->record map' % path)
    ship = {k for k, v in rows.items()
            if isinstance(v, dict) and not v.get('skipped') and v.get('charted') is not None}
    return ship, len(rows)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--packs', required=True, help='chartpack root')
    ap.add_argument('--registry', required=True, help='for boundaries/<slug>.geojson')
    ap.add_argument('--report')
    ap.add_argument('--only-lakes')
    ap.add_argument('--limit', type=int)
    ap.add_argument('--ship-only', action='store_true',
                    help='build only the lakes that actually ship, per <registry>/charted.json '
                         '(734 of 1732 today). Off by default. Exits if charted.json cannot be '
                         'read rather than quietly building every pack. --only-lakes names lakes '
                         'explicitly and wins over this.')
    ap.add_argument('--min-score', type=float, default=0.0,
                    help='drop candidates below this. Default 0 -- ship everything ranked and '
                         'let the client choose, because a cap in the data is a decision made '
                         'in the wrong place.')
    a = ap.parse_args()

    slugs = sorted(d for d in os.listdir(a.packs)
                   if os.path.isdir(os.path.join(a.packs, d)) and not d.startswith('_'))
    if a.only_lakes:
        src = a.only_lakes
        if src.startswith('@'): src = open(src[1:], encoding='utf-8').read()
        elif os.path.exists(src): src = open(src, encoding='utf-8').read()
        want = {s.strip() for s in src.replace('\n', ',').split(',') if s.strip()}
        slugs = [s for s in slugs if s in want]
    if a.ship_only:
        if a.only_lakes:
            print('--ship-only: not applied, --only-lakes already names the lakes to build')
        else:
            ship, total = ship_only_slugs(a.registry)
            kept = [s for s in slugs if s in ship]
            # Say the number out loud. A cap that prints nothing reads as "covered everything".
            print('--ship-only: %d of %d packs ship; %d passed over'
                  % (len(ship), total, total - len(ship)))
            print('             %d of %d packs on disk selected; %d never uploaded, not built'
                  % (len(kept), len(slugs), len(slugs) - len(kept)))
            slugs = kept
    if a.limit: slugs = slugs[:a.limit]
    print('%d packs' % len(slugs))

    report = {}
    t0 = time.time()
    made = skipped = 0
    for n, slug in enumerate(slugs, 1):
        cpath = os.path.join(a.packs, slug, 'contours.geojson')
        contours = read_json(cpath)
        if not contours or not (contours.get('features') or []):
            report[slug] = {'skipped': 'no contours'}; skipped += 1; continue
        ring = outer_ring(read_json(os.path.join(a.registry, 'boundaries', slug + '.geojson')))
        humps = find_humps(contours, ring)
        ledges = find_ledges(contours)
        score_humps(humps); score_ledges(ledges)
        feats = []
        for i, h in enumerate(sorted(humps, key=lambda x: -x['score'])):
            if h['score'] < a.min_score: continue
            feats.append({'type': 'Feature',
                          'properties': {'kind': 'hump', 'id': 'hump_%d' % (i + 1),
                                         'score': h['score'], 'depth_ft': round(h['depth'], 1),
                                         'area_acres': round(h['acres'], 2),
                                         'relief_ft': round(h['relief'], 1),
                                         'levels': h['levels']},
                          'geometry': {'type': 'Point',
                                       'coordinates': [round(h['lon'], 6), round(h['lat'], 6)]}})
        for i, l in enumerate(sorted(ledges, key=lambda x: -x['score'])):
            if l['score'] < a.min_score: continue
            feats.append({'type': 'Feature',
                          'properties': {'kind': 'ledge', 'id': 'ledge_%d' % (i + 1),
                                         'score': l['score'], 'depth_ft': round(l['depth'], 1),
                                         'slope_ft_per_100ft': round(l['slope'], 1),
                                         'drop_ft': round(l['drop'], 1),
                                         'run_ft': round(l['run_ft'], 0)},
                          'geometry': {'type': 'Point',
                                       'coordinates': [round(l['lon'], 6), round(l['lat'], 6)]}})
        doc = {'type': 'FeatureCollection',
               'properties': {'layer': 'structure', 'key': slug,
                              'generator': 'build_structure.py', 'note': NOTE},
               'features': feats}
        json.dump(doc, open(os.path.join(a.packs, slug, 'structure.geojson'), 'w',
                            encoding='utf-8'), ensure_ascii=False)
        report[slug] = {'humps': len(humps), 'ledges': len(ledges), 'features': len(feats)}
        made += 1
        if n % 25 == 0 or n == len(slugs):
            print('  %d/%d  %d written, %d skipped, %.1f min'
                  % (n, len(slugs), made, skipped, (time.time() - t0) / 60), flush=True)

    print('\n%d written, %d skipped, %.1f min' % (made, skipped, (time.time() - t0) / 60))
    th = sum(r.get('humps', 0) for r in report.values())
    tl = sum(r.get('ledges', 0) for r in report.values())
    print('   %d humps, %d ledges across every pack' % (th, tl))
    print('   the old adapter would have kept 8 and 8 per lake, in the browser, per research run')
    if a.report:
        doc = {'generatedBy': 'build_structure.py', 'note': NOTE, 'lakes': report}
        # A ship-only run covers 734 of 1732 lakes. Mark it, so a reader does not take this
        # report for a statement about the whole card. The key is absent on a full run.
        if a.ship_only and not a.only_lakes: doc['partial'] = 'ship-only'
        json.dump(doc, open(a.report, 'w', encoding='utf-8'), indent=1)
        print('-> %s' % a.report)


if __name__ == '__main__':
    main()
