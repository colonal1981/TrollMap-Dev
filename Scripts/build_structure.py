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

WHAT WAS WRONG WITH THIS ONE -- 2026-08-28

Ryan, looking at Wateree on the map: *"i am seeing humps on islands... i am seeing humps piled
up on top of other humps and the same with ledges... i think every depth change is being called
a hump or ledge on wateree"*. All three were true, and the file said 7,315 structures on one
lake. Three separate faults, one per complaint:

1. **Islands were humps.** outer_ring() takes p[0] and drops every hole, so the 54 islands
   Wateree has were invisible. A closed contour drawn around an island is a closed loop far
   from the SHORELINE, which was the only test, so all 54 became humps.

2. **Every contour inside a hump was another hump.** A high spot draws one closed loop per foot
   of relief, and each was emitted separately as well as counted in its parent's `levels`. 59%
   of humps sat within 50 m of another. Only the outermost loop of a nest is a hump now; the
   ones inside it are what `levels` and `relief` have always been counting.

3. **A ledge meant any slope at all.** Every 90 m cell with a five-foot drop somewhere within
   400 m qualified, which on a lake that shelves is every cell -- 6,923 of them, median slope
   5 ft per 100 ft, a quarter under 1.9, and 99% within 100 m of another. A break is not a
   slope, it is a slope steeper than the bottom AROUND it, so a ledge is now a local maximum in
   the slope field, scored by how far it stands above its own neighbourhood. That needs no
   threshold chosen by anybody: a gentle shelf still has local maxima and they score near zero.

4. **A bump with no height was still a bump.** Fixing 1 and 2 took Wateree from 7,315 to 740
   and stopped there. It never asked whether what survived had any relief: a single closed
   contour with no loop nested inside it has nothing to measure a rise against, reports
   `relief_ft` 0.0, and shipped anyway -- 115 of the 167 humps left on Wateree. A hump now
   needs a second level, which is the smallest number of contours that can express a rise.

And one the complaints did not name: find_ledges() trusted a comment saying the contours were
clipped to the lake. They are clipped to the lake PLUS A 250 m BUFFER, islands included, so 90
ledges sat outside the shoreline and two on islands. The few hundred survivors are tested for
being in the water, which is the same check the old comment refused at a thousandth of the cost.

    Wateree      7,315 -> 740        humps 392 -> 167, ledges 6,923 -> 573
    on islands      54 -> 0
    outside lake    90 -> 0
    piled within 50 m   59% -> 1%   (humps)      99% -> 2% within 100 m (ledges)

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


def island_rings(boundary):
    """Every hole in the lake polygon -- the islands.

    outer_ring() takes p[0] and drops p[1:], which is every island the lake has. Wateree has 54
    of them, from a third of an acre to 229, and the hump detector could not see one: a closed
    contour loop drawn around an island is a closed loop offshore of the SHORELINE, so it passed
    the only test there was and became a hump. 54 of Wateree's 392 humps were islands, which is
    every island it has. Ryan: "i am seeing humps on islands".

    Returned for both jobs a hole does here -- rejecting a loop that sits on land, and standing
    in as shoreline for the offshore test, because a bar ten metres off an island is shoreline
    structure exactly as it is ten metres off the bank.
    """
    if not boundary:
        return []
    geoms = ([f.get('geometry') for f in (boundary.get('features') or [])]
             if boundary.get('type') == 'FeatureCollection'
             else [boundary.get('geometry') or boundary])
    out = []
    for g in geoms:
        if not g:
            continue
        t = g.get('type')
        polys = [g['coordinates']] if t == 'Polygon' else (g['coordinates'] if t == 'MultiPolygon' else [])
        for poly in polys:
            for hole in (poly[1:] if poly else []):
                if is_closed(hole) and len(hole) > 3:
                    out.append(hole)
    return out


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


def find_humps(contours, ring, islands=()):
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
            # THE ACRE FLOOR DECIDES WHAT MAY BE A HUMP, NOT WHAT MAY BE THE TOP OF ONE.
            #
            # `HUMP_MIN_ACRES` stops a 0.04-acre loop being shipped as a hump of its own, which
            # is right. It was applied here, before nesting, so a small loop INSIDE a real hump
            # was thrown away too -- and inside a nest the small ring is the PEAK.
            #
            # Measured on hump_7, Lake Wateree, the crown Ryan put a waypoint on to two metres:
            # thirteen closed rings stack over 34.37964,-80.73507, from 21.0 ft at 5.78 ac down
            # to 8.9 ft at 0.039 ac. The four innermost -- 8.9/0.039, 9.8/0.106, 11.2/0.192,
            # 12.1/0.309 -- are all under 0.4 ac, so the deepest ring the algorithm ever saw was
            # 13.1 and it reported 7.9 ft of relief on a hill that stands 12.1 ft off its base.
            #
            # So they come in, carry `too_small`, and are barred from surviving as humps
            # themselves further down. What they may do is be the crown of the one they sit in.
            if a > HUMP_MAX_ACRES: continue
            lon, lat = centroid(c)
            if ring and not point_in_ring(lon, lat, ring): continue
            # ON AN ISLAND IS NOT OFFSHORE. Inside the outer ring and inside a hole are both
            # "inside the lake" to a point-in-polygon test that only ever saw the outer ring.
            if any(point_in_ring(lon, lat, h) for h in islands): continue
            loops.append({'lon': lon, 'lat': lat, 'acres': a, 'depth': float(d), 'ring': c,
                          'too_small': a < HUMP_MIN_ACRES})
    # nesting: a loop whose centroid falls inside another, deeper loop
    loops.sort(key=lambda h: -h['acres'])
    for h in loops:
        h['levels'] = 1
        h['relief'] = 0.0
        # WHERE THE TOP IS. Ryan: "the hump should be marked on the shallowest spot... that is
        # the top of the hill... the fish will be off to the sides."
        #
        # A hump was marked at the centroid of its OUTERMOST ring, which is the base -- on
        # hump_7 that put the waypoint 86 m from the peak and downhill, where the rings run
        # 18-21 ft and the structure reads as a 3 ft rise. The crown is what you idle over and
        # what the sides hang off, so it is what carries the position.
        h['crown_depth'] = h['depth']
        h['crown_lon'], h['crown_lat'] = h['lon'], h['lat']
    # Nesting, bbox-first. point_in_ring is O(ring) and there are 632 loops on Wateree, so the
    # naive pair loop is 400,000 ring walks. A bounding-box reject costs four comparisons and
    # removes almost all of them.
    for h in loops:
        xs = [p[0] for p in h['ring']]; ys = [p[1] for p in h['ring']]
        h['bbox'] = (min(xs), min(ys), max(xs), max(ys))
    # A LOOP INSIDE A HUMP IS THAT HUMP, NOT ANOTHER ONE. Ryan: "i am seeing humps piled up on
    # top of other humps and the same with ledges". A high spot draws one closed contour per
    # foot of relief, so a hump with fifteen levels was emitted as the outer loop AND as
    # fourteen more humps standing on it -- 59% of Wateree's 392 were within 50 m of another.
    #
    # `levels` and `relief` were already counting the nested loops, which is what makes them
    # levels of one hump rather than humps of their own. They are marked here and dropped below.
    for h in loops:
        h['nested_in'] = None
    for i, h in enumerate(loops):
        x0, y0, x1, y1 = h['bbox']
        for j in range(i + 1, len(loops)):
            k = loops[j]
            if k['acres'] > h['acres']: continue
            if not (x0 <= k['lon'] <= x1 and y0 <= k['lat'] <= y1): continue
            if point_in_ring(k['lon'], k['lat'], h['ring']):
                h['levels'] += 1
                # RELIEF IS BASE MINUS CROWN, and it was `max(abs(k - h))` -- an absolute
                # value, so a ring nested inside that is DEEPER than the outer one counted as
                # rise. That is a hole in the top of a rise, not height: Wateree's hump_2 came
                # out crown 24.9 ft, base 24.9 ft, relief 8.2 ft, which cannot all be true.
                # Set below from the crown, once the whole nest has been walked.
                # The shallowest ring in the nest is the summit; its centroid is the position.
                if k['depth'] < h['crown_depth']:
                    h['crown_depth'] = k['depth']
                    h['crown_lon'], h['crown_lat'] = k['lon'], k['lat']
                # The loops are sorted biggest first, so the first container found is the
                # tightest one that has already been seen -- keep the outermost by overwriting
                # only when nothing claimed it yet.
                if k['nested_in'] is None:
                    k['nested_in'] = i
    loops = [h for h in loops if h['nested_in'] is None]
    # A LOOP WITH NOTHING INSIDE IT HAS NO MEASURABLE RELIEF, so it is not a hump.
    #
    # `relief` is the depth difference between this loop and the deepest loop nested inside it.
    # With one level there is no second ring to measure against, so the field comes out 0.0 --
    # and 0.0 was being shipped as a fact. It does not mean flat. It means "somewhere between
    # nothing and one contour interval, unmeasured", and the honest answer to that is not to
    # put a waypoint on it.
    #
    # NOT A THRESHOLD ANYBODY PICKED. Two levels is the smallest number of contours that can
    # express a rise at all; below that the question is unanswerable from this data. Counted
    # 2026-08-29, before this line existed: relief_ft 0.0 on 68.9% of Wateree's 167 humps,
    # 65.0% of Kentucky Lake's 4,063, 46.1% of Murray's 1,011 and 89.0% of Pamlico Sound's
    # 10,814 -- and `levels <= 1` matched that count exactly in every pack, which is the
    # mechanism rather than a correlation.
    # A NEST WITH NO SHALLOWER RING INSIDE IT IS NOT A RISE. `levels > 1` counted any nested
    # loop, including a deeper one -- see the relief note above. A hump needs a summit.
    loops = [h for h in loops if h['levels'] > 1 and h['crown_depth'] < h['depth']]
    # A ring under the acre floor may be the crown of a hump; it may not BE one. It reached the
    # nesting pass so its depth could count, and anything still unclaimed here is a standalone
    # bump too small to ship -- which is the rule HUMP_MIN_ACRES was written for.
    loops = [h for h in loops if not h['too_small']]
    # AND THE HUMP MOVES TO ITS SUMMIT. Everything downstream reads `lon`/`lat` as the hump's
    # position, so the crown is written into them rather than carried alongside and ignored.
    for h in loops:
        h['base_depth'] = h['depth']
        h['relief'] = round(h['depth'] - h['crown_depth'], 4)
        h['lon'], h['lat'] = h['crown_lon'], h['crown_lat']
    out = []
    if ring:
        # Offshore test through a grid. Scanning a 17,282-vertex ring per candidate is 11M
        # distance calls; bucketing the ring once makes each test a handful.
        rg = Grid(MIN_OFFSHORE_DEG * 2)
        for p in ring: rg.add(p[0], p[1], None)
        # An island's shore is shore. A loop hugging one is the tip of a point by another name.
        for h in islands:
            for p in h: rg.add(p[0], p[1], None)
        lim = MIN_OFFSHORE_DEG * 111320.0
        for h in loops:
            close = any(metres((h['lon'], h['lat']), (qx, qy)) < lim
                        for qx, qy, _ in rg.near(h['lon'], h['lat']))
            if not close: out.append(h)
    else:
        out = loops
    for h in out: h.pop('ring', None); h.pop('bbox', None)
    return out


def find_ledges(contours, ring=None, islands=()):
    """Real bottom slope: horizontal distance between ADJACENT depth levels.

    Ten feet of drop in 30 m is a wall; ten feet in 300 m is a taper. That is the number an
    angler recognises and it is what the old centroid-bucketing never measured.

    ONLY CONSECUTIVE LEVELS ARE COMPARED. Asking "nearest vertex at any other depth" is both
    wrong -- the 40 ft line running beside the 5 ft line says nothing about the slope between
    them -- and quadratic in the number of levels. Wateree has 65 levels and roughly 300,000
    sampled vertices; pairing every level against every other did not finish in two minutes.
    Walking consecutive pairs is 64 passes over two point sets.

    NO POINT-IN-POLYGON DURING THE SWEEP. Re-testing 300,000 sampled vertices against a
    17,282-vertex ring is a billion operations. But the file guarantees less than the original
    version of this comment claimed: build_all_chartpacks.py clips to the lake boundary PLUS A
    250 m BUFFER, and it keeps the contours drawn around islands. So `every vertex is in the
    lake by construction` was not true -- 90 of Wateree's ledges sat outside the shoreline in
    the buffer and two sat on islands.
    
    The survivors are tested instead of the samples. There are a few hundred of them rather
    than hundreds of thousands, which is the same check for a thousandth of the work.

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

    # A LEDGE IS WHERE THE BOTTOM BREAKS, NOT WHEREVER IT SLOPES.
    #
    # Every cell that got this far has a five-foot drop somewhere within 400 m, and on a lake
    # that shelves at all, that is every cell. Wateree returned 6,923 ledges with a median slope
    # of 5 ft per 100 ft and a quarter of them under 1.9 -- a two-foot fall across a hundred
    # feet, which is a taper a boat drifts over without noticing. 99% of them sat within 100 m
    # of another. Ryan: "i think every depth change is being called a hump or ledge on wateree".
    #
    # What makes a break is not the slope's size but that it is steeper than the bottom AROUND
    # it. That needs no threshold to be chosen: keep the cells that are a local maximum in the
    # slope field, and score each by how far it stands above its own neighbourhood. A gently
    # shelving flat still has local maxima, and they score near zero and rank last, which is
    # what they deserve -- rather than being cut by a number somebody picked.
    if not best:
        return []
    out = []
    for (cx, cy), rec in best.items():
        ring1 = [best[(cx + dx, cy + dy)]['slope']
                 for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                 if (dx or dy) and (cx + dx, cy + dy) in best]
        if not ring1 or rec['slope'] < max(ring1):
            continue                      # something beside it is steeper; that is the break
        wide = [best[(cx + dx, cy + dy)]['slope']
                for dx in range(-2, 3) for dy in range(-2, 3)
                if (dx or dy) and (cx + dx, cy + dy) in best]
        around = sorted(wide)[len(wide) // 2] if wide else 0.0
        rec['prominence'] = round(max(0.0, rec['slope'] - around), 2)
        # In the water, and not on an island. Cheap here and nowhere else: this list is the few
        # hundred breaks that survived, not the vertices they were found among.
        if ring and not point_in_ring(rec['lon'], rec['lat'], ring):
            continue
        if any(point_in_ring(rec['lon'], rec['lat'], h) for h in islands):
            continue
        out.append(rec)
    return out


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
    """PROMINENCE LEADS. How far this break stands above the bottom around it is what makes it
    a break; raw steepness follows, because a lake with a steep basin would otherwise rank its
    whole shoreline above a genuine drop on a flat one."""
    if not ledges: return
    smax = max(l['slope'] for l in ledges) or 1
    dmax = max(l['drop'] for l in ledges) or 1
    pmax = max(l.get('prominence', 0.0) for l in ledges) or 1
    for l in ledges:
        l['score'] = round(100 * (0.5 * (l.get('prominence', 0.0) / pmax)
                                  + 0.3 * (l['slope'] / smax)
                                  + 0.2 * (l['drop'] / dmax)), 1)


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


def _stamp_mod():
    import importlib.util
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location('pack_stamp',
                                                  os.path.join(here, 'pack_stamp.py'))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


_PS = None


def _stamp_is_current(pack, out, inputs, params):
    global _PS
    if _PS is None:
        _PS = _stamp_mod()
    return _PS.is_current(pack, out, inputs, params)


def _stamp_record(pack, out, inputs, params):
    global _PS
    if _PS is None:
        _PS = _stamp_mod()
    _PS.record(pack, out, inputs, params)


def _merge_prior_report(path, lakes, partial):
    """A scoped run must update the rows it touched and leave the rest alone.

    Measured 2026-08-13: registry/_structure.json and registry/_water_graphs.json each held ONE
    lake, and registry/_trolling_runs.json held zero, because a --only-lakes run rewrote the
    card-wide report with just its own scope. 543 packs had trolling runs on disk at the time.
    build_all_chartpacks.py has merged its report for months; these siblings did not, and the
    flag that makes scoping possible is exactly the flag that destroyed the report.

    Returns the lakes dict to write. A full run (partial falsy) replaces, as it should.
    """
    if not partial or not path or not os.path.exists(path):
        return lakes
    try:
        with open(path, encoding='utf-8') as fh:
            prev = json.load(fh)
        if isinstance(prev.get('lakes'), dict):
            merged = dict(prev['lakes'])
            merged.update(lakes)
            return merged
    except (OSError, ValueError):
        pass                      # an unreadable previous report is not worth failing over
    return lakes


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--packs', required=True, help='chartpack root')
    ap.add_argument('--registry', required=True, help='for boundaries/<slug>.geojson')
    ap.add_argument('--force', action='store_true',
                    help='rebuild even when contours, boundary and settings are unchanged')
    ap.add_argument('--report')
    ap.add_argument('--only-lakes')
    ap.add_argument('--limit', type=int)
    ap.add_argument('--ship-only', action='store_true',
                    help='build only the lakes that actually ship, per <registry>/charted.json '
                         '(734 of 1732 today). Off by default. Exits if charted.json cannot be '
                         'read rather than quietly building every pack. --only-lakes names lakes '
                         'explicitly and wins over this.')
    ap.add_argument('--all-packs', action='store_true',
                    help='ignore the index gate and build every pack dir under --packs. Off by '
                         'default: the app offers 358 of the 1,709 pack dirs on disk and the '
                         'rest is half an hour nothing reads.')
    ap.add_argument('--index',
                    help='registry/lake_index.json -- ONLY these slugs are built. Defaults '
                         'beside --registry.')
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
    # THE INDEX GATE, AND IT IS THE ONE upload_garmin_to_r2.py ALREADY USES. 1,709 pack dirs on
    # disk, 358 slugs the app offers. Ryan, 2026-08-29, after a 35-minute run: "thanks for making
    # me do structures on all of the extracted lakes even the ones we don't offer in the app".
    # The uploader has gated on registry/lake_index.json with this flag name for two weeks; this
    # is the same gate reading the same file, so the two scripts agree on what "a lake we ship"
    # means instead of disagreeing by 1,351 packs.
    #
    # FAILS CLOSED, for the reason the uploader's does: a builder that reads "I cannot find the
    # list of what to build" as "build everything" turns a missing input into half an hour of
    # work. --only-lakes names lakes explicitly and wins over this, the same way it wins over
    # --ship-only.
    if not a.all_packs and not a.only_lakes:
        ipath = a.index or os.path.join(a.registry, 'lake_index.json')
        try:
            _idx = json.load(open(ipath, encoding='utf-8'))
            offered = set(_idx if isinstance(_idx, dict) else
                          (r.get('slug') or r.get('key') for r in _idx))
        except Exception as exc:
            sys.exit('NO USABLE INDEX at %s (%s).\n'
                     'Refusing to build: without it this walks every pack dir under %s, most of '
                     'which the app does not offer.\n'
                     'Pass --index explicitly, or --all-packs if a full archive build is what '
                     'you actually want.' % (ipath, exc.__class__.__name__, a.packs))
        kept = [x for x in slugs if x in offered]
        print('index gate: %d of %d pack dirs are slugs the app offers; %d passed over '
              '(--all-packs to ignore it)' % (len(kept), len(slugs), len(slugs) - len(kept)))
        slugs = kept

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
    made = skipped = current = 0
    # Inputs it actually reads: the contours it derives from, and the boundary that gives it the
    # outer ring. The registry boundary is absolute, so it is stamped by full path.
    # THE RULES ARE PART OF THE STAMP. The inputs did not change on 2026-08-28 and the answers
    # did: islands stopped being humps, a hump stopped being emitted once per contour inside it,
    # and a ledge stopped meaning any slope at all. Stamped on the contours alone, every pack
    # would have reported itself up to date and kept the old file. Bump this when the geometry
    # rules change and every lake rebuilds without anybody remembering --force.
    RULES_VERSION = '2026-08-30-crown'
    ST_PARAMS = (a.min_score, RULES_VERSION)
    for n, slug in enumerate(slugs, 1):
        pack = os.path.join(a.packs, slug)
        st_inputs = ('contours.geojson',
                     os.path.join(a.registry, 'boundaries', slug + '.geojson'))
        if not a.force and _stamp_is_current(pack, 'structure.geojson', st_inputs, ST_PARAMS):
            current += 1
            if n % 25 == 0 or n == len(slugs):
                print('  %d/%d  %d written, %d up to date, %d skipped, %.1f min'
                      % (n, len(slugs), made, current, skipped, (time.time() - t0) / 60),
                      flush=True)
            continue
        cpath = os.path.join(a.packs, slug, 'contours.geojson')
        contours = read_json(cpath)
        if not contours or not (contours.get('features') or []):
            report[slug] = {'skipped': 'no contours'}; skipped += 1; continue
        bnd = read_json(os.path.join(a.registry, 'boundaries', slug + '.geojson'))
        ring = outer_ring(bnd)
        islands = island_rings(bnd)
        humps = find_humps(contours, ring, islands)
        ledges = find_ledges(contours, ring, islands)
        score_humps(humps); score_ledges(ledges)
        feats = []
        for i, h in enumerate(sorted(humps, key=lambda x: -x['score'])):
            if h['score'] < a.min_score: continue
            feats.append({'type': 'Feature',
                          # `depth_ft` IS THE CROWN, which is what both readers already call it:
                          # plan-candidates.js prints `crown ${depth_ft} ft` and
                          # supplemental-layers.js prints `crown @${depth}ft`. The pipeline was
                          # writing the BASE into it, so hump_1 read "crown @23ft" with its top
                          # at 8.9 ft. The point is the summit now, and the depth at that point
                          # is the depth of the summit. `base_ft` is what it stands on.
                          'properties': {'kind': 'hump', 'id': 'hump_%d' % (i + 1),
                                         'score': h['score'],
                                         'depth_ft': round(h['crown_depth'], 1),
                                         'base_ft': round(h['base_depth'], 1),
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
                                         # HOW FAR THIS BREAK STANDS ABOVE THE BOTTOM AROUND
                                         # IT, which is what makes it a break and what leads
                                         # the score. A steep bank in a steep basin has a low
                                         # one; a wall on a flat has a high one.
                                         'steeper_than_around_by': l.get('prominence', 0.0),
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
        _stamp_record(pack, 'structure.geojson', st_inputs, ST_PARAMS)
        report[slug] = {'humps': len(humps), 'ledges': len(ledges), 'features': len(feats)}
        made += 1
        if n % 25 == 0 or n == len(slugs):
            print('  %d/%d  %d written, %d up to date, %d skipped, %.1f min'
                  % (n, len(slugs), made, current, skipped, (time.time() - t0) / 60), flush=True)

    print('\n%d written, %d already current, %d skipped, %.1f min'
          % (made, current, skipped, (time.time() - t0) / 60))
    if current and not a.force:
        print('   up to date = same contours, same boundary, same --min-score. --force overrides.')
    th = sum(r.get('humps', 0) for r in report.values())
    tl = sum(r.get('ledges', 0) for r in report.values())
    print('   %d humps, %d ledges across every pack' % (th, tl))
    print('   the old adapter would have kept 8 and 8 per lake, in the browser, per research run')
    if a.report:
        doc = {'generatedBy': 'build_structure.py', 'note': NOTE, 'lakes': report}
        # A ship-only run covers 734 of 1732 lakes and --only-lakes can cover one. Mark either,
        # so a reader does not take this report for a statement about the whole card, and MERGE
        # rather than replace. The key is absent on a full run.
        partial = ('ship-only' if (a.ship_only and not a.only_lakes)
                   else ('only-lakes' if a.only_lakes else None))
        if partial:
            doc['partial'] = partial
            doc['lakes'] = _merge_prior_report(a.report, report, partial)
        json.dump(doc, open(a.report, 'w', encoding='utf-8'), indent=1)
        print('-> %s%s' % (a.report,
                           '  (merged, %d packs)' % len(doc['lakes']) if partial else ''))


if __name__ == '__main__':
    main()
