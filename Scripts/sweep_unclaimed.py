#!/usr/bin/env python3
"""
sweep_unclaimed.py -- Garmin bathymetry that belongs to no water we know about.

WHAT THIS ANSWERS

Ryan, 2026-08-11: "are there other lakes like robinson that weren't in the registry at all but
that garmin has bathymetry for? and how do we find those?"

Lake Robinson in Greer is 803 acres, Garmin surveyed it, and it was not in the registry at all --
because the registry is built from NAMED 3DHP waterbodies and 3DHP left that polygon unnamed. No
name search can find a water that has no name. But the bathymetry cannot hide: 00_START_HERE's
governing fact is that a contour can only be assigned by clipping against a polygon, so a contour
inside NO polygon is exactly the app's blind spot, and it is enumerable.

    every cell Garmin charted        (extract/_garmin_coverage.json -- contours + depth_areas only)
      minus every cell inside a known boundary
      = bathymetry with no water attached

CLAIM BY POLYGON, NOT BY BOUNDING BOX. A bbox pass found Robinson but lost Lake John D. Long and
Lake Cherokee, because Broad River's 5,166-acre bbox swallows both. A bbox over-claims, which
under-reports missing water -- safe, but it hides exactly the small water this is for.

WHY IT IS FAST NOW, AND WAS NOT

The first version ray-cast every candidate cell against every ring: O(cells x vertices). Ryan:
"the sweep is running and it is slow." It was. `congaree_river` is one ring of 19,782 vertices, and
a polygon that size covering a few thousand cells costs tens of millions of operations on its own.

This rasterises instead. For each cell ROW, every edge of the ring is crossed once, the crossings
are sorted, and the spans between pairs are filled -- O(rows x vertices), which on a big polygon is
hundreds of times less work. Measured on `congaree_river`, one ring of 19,782 vertices: 0.35 s
against a projected 26 s, ~75x. Lake Robinson still turns up 0.5 km from where Ryan put it.

WHERE IT DISAGREES WITH THE SLOW VERSION, AND WHY THAT IS ACCEPTABLE

Sampled against the ray-cast over five boundaries -- 1,250 cells, 1,247 agree, 99.76%. Every
disagreement is on a multi-ring water (Wateree has 55 rings, Murray 138) and has one cause: rings()
flattens Polygon and MultiPolygon into a plain list and LOSES which rings are outers and which are
HOLES. Each ring is filled independently and unioned, so an island inside a lake gets claimed as
water rather than subtracted from it.

That is a real defect and it is left in deliberately. It can only ever CLAIM cells, never release
them, so its effect is to under-report missing water -- this sweep says "here is water nobody
knows about" and the failure mode makes it say that less often, not more. A cell wrongly claimed
is a lake island we already own; a cell wrongly released would be a phantom lake sending someone
to build a pack for an island. If this is ever reused for something where the bias runs the other
way, fix the hole handling first.

TWO GATES, ADDED 2026-08-12, BOTH FIXING THE SAME ROOT CAUSE

`registry/boundaries` holds 3,392 files. `registry/lake_index.json` holds 859 rows. The
2026-08-11 shrink cut the INDEX and never touched the FOLDER, so 2,538 files are boundaries for
lakes TrollMap does not carry, and 1,531 of those are not even in the four states.

    THE CLAIM PASS READS THE INDEX, NOT THE FOLDER.  An orphan boundary claiming a cell hides
    real water -- the cell stops being "unclaimed" on behalf of a lake that was dropped. It also
    satisfies `nearest_known`, which SHORT-CIRCUITS --near-km, which is how 282 clusters and
    69,710 acres of Missouri, Alabama, Mississippi and Florida water reached this report.

    THE REPORT PASS TESTS THE STATE LINE.  `registry/region_mask.json`, built by
    make_region_mask.py from the Census TIGER states already on the drive. ANY cell inside keeps
    the whole cluster, so Hartwell, Thurmond and Chatuge survive; a centroid test would have
    thrown away real border lakes and called it cleaning.

    py .\\scripts\\make_region_mask.py           # once, or when the state list changes
    py .\\scripts\\sweep_unclaimed.py            # claim pass
    py .\\scripts\\sweep_unclaimed.py --report   # cluster and list

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import glob
import importlib.util
import json
import math
import os
import time
from collections import deque, defaultdict


def _sibling(name):
    """Load a helper that lives next to this script, wherever the script was copied to."""
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), name + '.py')
    spec = importlib.util.spec_from_file_location(name, p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


InRegion = _sibling('in_region')

CELL = 0.002                      # same grid the coverage cache uses
ACRES_PER_CELL = 10.2             # a 0.002 deg square at ~34 N
PTS_PER_CLUSTER = 24              # cell centres carried into the output; see 'pts' below


def rings(g):
    t = (g or {}).get('type')
    c = (g or {}).get('coordinates')
    if t == 'Polygon':
        return c or []
    if t == 'MultiPolygon':
        return [r for p in (c or []) for r in p]
    return []


def fill_ring(ring, want_rows, claimed, cover):
    """
    Scanline-rasterise one ring onto the cell grid, claiming only cells Garmin charted.

    `want_rows` maps a row index -> the set of column indices Garmin covers in that row. Rows with
    no coverage are skipped outright, which is most of them: a boundary's bbox is mostly land.
    """
    ys = [p[1] for p in ring]
    lo = int(math.floor(min(ys) / CELL))
    hi = int(math.ceil(max(ys) / CELL))
    n = len(ring)
    for iy in range(lo, hi + 1):
        cols = want_rows.get(iy)
        if not cols:
            continue
        y = iy * CELL + CELL / 2
        xs = []
        j = n - 1
        for i in range(n):
            yi = ring[i][1]
            yj = ring[j][1]
            if (yi > y) != (yj > y):
                xi = ring[i][0]
                xj = ring[j][0]
                xs.append(xi + (xj - xi) * (y - yi) / ((yj - yi) or 1e-15))
            j = i
        if not xs:
            continue
        xs.sort()
        # Even-odd: fill between consecutive pairs.
        for k in range(0, len(xs) - 1, 2):
            a = int(math.floor((xs[k] - CELL / 2) / CELL)) + 1
            b = int(math.floor((xs[k + 1] - CELL / 2) / CELL))
            if b < a:
                continue
            for ix in range(a, b + 1):
                if ix in cols:
                    claimed.add((ix, iy))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--coverage', default=os.path.join('extract', '_garmin_coverage.json'))
    ap.add_argument('--boundaries', default=os.path.join('registry', 'boundaries'))
    ap.add_argument('--claimed', default=os.path.join('_scratch', 'sweep_claimed.json'))
    ap.add_argument('--out', default=os.path.join('outputs', 'garmin_unclaimed.json'))
    ap.add_argument('--min-acres', type=float, default=40.0)
    ap.add_argument('--max-acres', type=float, default=20000.0)
    ap.add_argument('--index', default=os.path.join('registry', 'lake_index.json'))
    ap.add_argument('--near-km', type=float, default=25.0,
                    help='keep only clusters within this many km of a water in lake_index.json; '
                         '0 disables the filter')
    ap.add_argument('--min-da', type=float, default=0.25,
                    help='share of a cluster that must sit inside a real depth area before it '
                         'counts as surveyed water rather than stray contour lines (0.25)')
    ap.add_argument('--near-cells', type=int, default=25,
                    help='how far to search for the nearest claimed cell, in cells (~200 m '
                         'each). Beyond this a blob is reported as detached with no neighbour.')
    ap.add_argument('--min-fill', type=float, default=0.15,
                    help='a cluster must fill this share of its own bounding box to be called a '
                         'lake rather than a shoreline collar (default 0.15)')
    ap.add_argument('--region-mask', default=os.path.join('registry', 'region_mask.json'))
    ap.add_argument('--no-region', action='store_true',
                    help='skip the four-state test entirely (says so loudly)')
    ap.add_argument('--allow-no-da', action='store_true',
                    help='run even when the coverage cache predates da_cells, accepting that '
                         'surveyed water cannot be told from stray contour lines')
    ap.add_argument('--report', action='store_true')
    a = ap.parse_args()

    cov = json.load(open(a.coverage))
    cover = set((p[0], p[1]) for p in cov['cells'])
    # Cells backed by an actual depth polygon, as opposed to cells that only ever saw a contour
    # line pass through them. A 3,050-acre cluster at -78.4818, 34.7540 held ZERO depth areas
    # and seven contours -- stray lines, not a surveyed lake. An older coverage file has no such
    # split; say so rather than reporting every blob as fully measured.
    # NO da_cells IS A BLOCKER, NOT A WARNING.
    #
    # It was a warning, and on 2026-08-12 that warning scrolled past. The run produced a 1,548-row
    # worklist in which every row read da_share 0.00 -- not because the water is contour-only but
    # because the question was never asked. Ryan had already ruled on exactly this: *"Stop having
    # me continue with errors showing... this is how shit gets missed and you do it every time."*
    #
    # The trap is that the CONSUMER cannot fix it. This script only READS the coverage cache;
    # make_river_boundaries.py writes it, and only its cache key knows to refuse the old format.
    # So the message has to name that command, or the reader is stuck.
    da = set((p[0], p[1]) for p in (cov.get('da_cells') or []))
    if not da and not a.allow_no_da:
        print('STOP: %s has no da_cells.' % a.coverage)
        print()
        print('  Without it there is no telling water Garmin SOUNDED from cells a contour line')
        print('  merely passed through. Every cluster reports da_share 0.00, and --min-da here')
        print('  and in id_unclaimed_water.py both quietly stop filtering.')
        print()
        print('      py .\\scripts\\build_coverage_cache.py')
        print()
        print('  That rebuilds the cache and touches nothing else. (This script only READS it,')
        print('  and make_river_boundaries.py -- which owns the scan -- needs --gpkg/--feeds/--out')
        print('  and rewrites boundary files, so it is the wrong tool for a cache refresh.)')
        print()
        print('  --allow-no-da runs anyway and accepts that the depth test is off.')
        return 2
    if not da:
        print('!! --allow-no-da: the depth test is OFF, da_share will be 0.00 on every row')
    rows = defaultdict(set)
    for ix, iy in cover:
        rows[iy].add(ix)
    print('Garmin cells: %d across %d rows' % (len(cover), len(rows)))

    if not a.report:
        files = sorted(glob.glob(os.path.join(a.boundaries, '*.geojson')))
        if not files:
            print('no boundaries at %s' % a.boundaries)
            return 2
        # THE FOLDER IS NOT THE APP.
        #
        # `registry/boundaries` holds 3,392 geojson files. `registry/lake_index.json` holds 859
        # rows. The 2026-08-11 shrink cut the INDEX from 1,867 to 859 and never touched the
        # FOLDER, so 2,538 of those files are boundaries for lakes TrollMap no longer carries --
        # and 1,531 of the orphans are not even in SC, NC, GA or TN.
        #
        # Claiming from the folder does two wrong things at once. Out-of-region ghosts claim
        # cells and then satisfy `nearest_known`, which SHORT-CIRCUITS the --near-km filter below
        # (it is only consulted when nothing claimed is in reach), which is how 282 clusters and
        # 69,710 acres of Missouri, Alabama, Mississippi and Florida water reached the report.
        # In-region ghosts are worse: they claim real Garmin water for a lake that was dropped,
        # so it never shows up as unclaimed at all. Ryan's actual question is *"i want to make
        # sure we are accounting for all the water"*, and a ghost claim is exactly how water
        # stops being accounted for.
        #
        # So the claim pass reads the INDEX and ignores everything else in the folder.
        if os.path.exists(a.index):
            idx = json.load(open(a.index, encoding='utf-8'))
            slugs = set(idx if isinstance(idx, dict) else
                        (r.get('slug') for r in idx if isinstance(r, dict)))
            keep = [f for f in files if os.path.basename(f)[:-8] in slugs]
            print('%d boundary file(s) in %s, %d match a row in %s -- %d orphan(s) IGNORED'
                  % (len(files), a.boundaries, len(keep), os.path.basename(a.index),
                     len(files) - len(keep)))
            missing = len(slugs) - len(keep)
            if missing > 0:
                print('!! %d index row(s) have NO boundary file' % missing)
            files = keep
            if not files:
                print('no boundary file matches any index row -- refusing to claim nothing')
                return 2
        else:
            print('!! NO index at %s -- claiming from ALL %d file(s) in the folder, which is the '
                  'behaviour that let out-of-region water through' % (a.index, len(files)))
        # WHICH lake claimed the cell, not just that one did.
        #
        # Ryan, 2026-08-12: *"i think we are probably missing pieces of lakes not actual lakes
        # but until we work through it we won't know."* That is answerable, but only if a
        # leftover blob can say what it is NEAR. A 300 m gap to Murray and a 50 km gap to
        # nothing are both "unclaimed" without attribution, and they are completely different
        # problems -- one is a boundary cut short, the other is a lake nobody has.
        claimed = {}
        t0 = time.time()
        for i, fp in enumerate(files):
            try:
                d = json.load(open(fp))
            except Exception:
                continue
            slug = os.path.basename(fp)[:-8]
            feats = d.get('features') if d.get('type') == 'FeatureCollection' else [d]
            mine = set()
            for f in (feats or []):
                for r in rings((f or {}).get('geometry') or {}):
                    if len(r) >= 4:
                        fill_ring(r, rows, mine, cover)
                        # ALSO the cells the ring itself passes through. `fill_ring` claims a
                        # cell only when its CENTRE is inside the ring, so a boundary that
                        # matches Garmin's coverage exactly still leaves a one-cell collar
                        # unclaimed all the way round. In the synthetic test that showed up as
                        # 235 phantom acres on a lake whose boundary covered every cell it had.
                        # At scale it is a large share of the "rims" in this report, and it is
                        # rasterisation, not water.
                        # Walk the EDGES, not just the vertices. A rectangle has four corners
                        # and a collar all the way round it; claiming corner cells removed 31
                        # of 235 phantom acres in the test and left the rest. Sampling each
                        # segment at half a cell catches every cell the line passes through.
                        for k in range(len(r) - 1):
                            x0, y0 = r[k][0], r[k][1]
                            x1, y1 = r[k + 1][0], r[k + 1][1]
                            steps = int(max(abs(x1 - x0), abs(y1 - y0)) / (CELL / 2)) + 1
                            for t in range(steps + 1):
                                px = x0 + (x1 - x0) * t / steps
                                py = y0 + (y1 - y0) * t / steps
                                cl = (int(px / CELL), int(py / CELL))
                                if cl in cover:
                                    mine.add(cl)
            for c in mine:
                claimed.setdefault(c, slug)      # first boundary to claim a cell keeps it
            if (i + 1) % 500 == 0:
                print('  %d/%d boundaries, %d cells claimed, %.0fs'
                      % (i + 1, len(files), len(claimed), time.time() - t0), flush=True)
        os.makedirs(os.path.dirname(a.claimed) or '.', exist_ok=True)
        json.dump([[c[0], c[1], sl] for c, sl in claimed.items()], open(a.claimed, 'w'))
        print('done in %.0fs -- %d of %d Garmin cells are inside a known boundary'
              % (time.time() - t0, len(claimed), len(cover)))
        print('now run with --report')
        return 0

    if not os.path.exists(a.claimed):
        print('no %s yet -- run without --report first' % a.claimed)
        return 2
    raw = json.load(open(a.claimed))
    if raw and len(raw[0]) == 3:
        owner = {(c[0], c[1]): c[2] for c in raw}
    else:
        # An older claim file has no slugs. Still usable for the subtraction, but every blob
        # will report its neighbour as unknown -- say so rather than pretending.
        owner = {(c[0], c[1]): None for c in raw}
        print('!! %s predates lake attribution -- re-run without --report to get NEAREST' % a.claimed)
    claimed = set(owner)
    left = cover - claimed
    print('inside a known boundary: %d' % len(claimed))
    print('UNCLAIMED:               %d  (%.1f%%)' % (len(left), 100.0 * len(left) / max(len(cover), 1)))

    seen = set()
    comps = []
    for c in left:
        if c in seen:
            continue
        q = deque([c])
        seen.add(c)
        comp = []
        while q:
            x, y = q.popleft()
            comp.append((x, y))
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    nb = (x + dx, y + dy)
                    if nb in left and nb not in seen:
                        seen.add(nb)
                        q.append(nb)
        comps.append(comp)

    # ── KEEP ONLY WATER RYAN WOULD ACTUALLY DRIVE TO ──────────────────────────────────────────
    #
    # The first report came back 73.2% unclaimed across 22,092 clusters, and the biggest were
    # Jacksonville, Norfolk and two in Alabama. Nothing was wrong with the arithmetic: the Garmin
    # card spans lon -87.1..-75.2 and lat 30.3..36.8, `registry/lakes.json` carries 3,262 rows
    # across FIFTEEN states, and `registry/boundaries/` matches it -- but `lake_index.json`, which
    # is what the app offers, is the four states and 1,746 rows. So most of that 73% is real
    # unclaimed water that is simply not his.
    #
    # THE STATE LINE, WHICH NOTHING IN THIS PIPELINE HAS EVER TESTED AGAINST.
    #
    # Ryan, 2026-08-12: *"i dont have any of the infrastructure for the other states in the
    # pipeline or in trollmap... doesn't make sense to expand... if they are border lakes that is
    # one thing."* The DNR feeds, the gauge bindings and the proclamation rules exist for exactly
    # four states.
    #
    # ANY CELL INSIDE KEEPS THE WHOLE CLUSTER. Hartwell, Thurmond, Chatuge and the Savannah chain
    # straddle a state line, and a centroid test would throw away real border lakes and call it
    # cleaning -- Lake Marion's own centroid measures 4,160 m outside Lake Marion.
    region = None
    if not a.no_region:
        region = InRegion.Region.load(a.region_mask, required=False)
        if region is None:
            print('!! NO region mask at %s -- NOTHING is filtered by state this run. '
                  'Build it: py .\\scripts\\make_region_mask.py' % a.region_mask)
        else:
            print(region.describe())

    # The proximity filter below is the OLD gate and stays as a second line, because it catches
    # what a state line cannot: water inside the four states that is nowhere near anything the app
    # serves. A per-state bounding box would be the obvious filter and a bad one -- SC's box holds
    # chunks of Georgia and North Carolina, and the open Atlantic sits inside every coastal
    # state's box -- which is why the mask above is the real polygon, not a box.
    keep_near = None
    if a.near_km > 0 and os.path.exists(a.index):
        idx = json.load(open(a.index))
        recs = idx if isinstance(idx, list) else (idx.get('lakes') or list(idx.values()))
        pts = [r['centroid'] for r in recs
               if isinstance(r, dict) and isinstance(r.get('centroid'), list) and len(r['centroid']) == 2]
        # Bucket the known waters by ~0.25 deg so the test is a few dozen comparisons, not 1,746.
        B = 0.25
        grid = defaultdict(list)
        for lon, lat in pts:
            grid[(int(lon / B), int(lat / B))].append((lon, lat))
        span = int(a.near_km / 111.32 / B) + 1

        def near_known(lon, lat):
            gx, gy = int(lon / B), int(lat / B)
            for dx in range(-span, span + 1):
                for dy in range(-span, span + 1):
                    for px, py in grid.get((gx + dx, gy + dy), ()):
                        if math.hypot((px - lon) * math.cos(math.radians(lat)), py - lat) * 111.32 <= a.near_km:
                            return True
            return False
        keep_near = near_known
        print('filtering to within %.0f km of one of %d waters in %s' % (a.near_km, len(pts), a.index))

    # ── FRINGE IS NOT A MISSING LAKE ──────────────────────────────────────────────────────
    #
    # Ryan, 2026-08-12, on the top of this report: *"this still looks to be bullshit."* It did.
    # The largest entries were 19,258 acres sprawling over 42 km beside Hiwassee, 17,646 over
    # 39 km whose nearest boundary was Norris at 0.05 km, and the same shape next to Carters,
    # Center Hill and Lanier. No such lakes exist.
    #
    # They are the RIM. A boundary is cut slightly tighter than Garmin's soundings reach, so
    # every lake leaks a collar of unclaimed cells; those collars run up the feeder rivers and
    # connect, and 8-connectivity welds the lot into one component per drainage. That has been
    # the top of this file since the first run -- the 08-11 output had the same 19,451-acre
    # entry at the same bbox -- so it is not new, it has just been in the way the whole time.
    #
    # Two things separate a rim from a lake, and both are free here:
    #
    #   TOUCHES  a component with a claimed cell in its 8-neighbourhood is attached to water
    #            already in the registry. That is a boundary that needs widening, not a lake
    #            that needs finding. `attach_arms.py` is the tool for those.
    #   FILL     cells / bbox cells. A real impoundment fills a third to two thirds of its own
    #            box. A collar wrapped around 40 km of shoreline fills a few percent.
    # How far to the nearest water we already have, and WHICH one. Searched as expanding rings
    # from the blob's own cells and stopped at --near-cells, because a blob further away than
    # that is a separate lake by any reading and the exact figure stops mattering.
    def nearest_known(c, cap):
        cs = set(c)
        for rad in range(0, cap + 1):
            for (x, y) in c:
                for dx in range(-rad, rad + 1):
                    for dy in range(-rad, rad + 1):
                        if max(abs(dx), abs(dy)) != rad:
                            continue          # ring only, not the filled square
                        p = (x + dx, y + dy)
                        if p in claimed:
                            return rad, owner.get(p)
        return None, None

    out = []
    dropped_far = dropped_out = 0
    acres_out = 0.0
    for c in comps:
        acres = len(c) * ACRES_PER_CELL
        if not (a.min_acres <= acres <= a.max_acres):
            continue
        xs = [p[0] for p in c]
        ys = [p[1] for p in c]
        # BOUNDARY FIRST, CENTROID ONLY AS A FALLBACK.
        #
        # This test used to be centroid-only, and it dropped 7,806 clusters. A centroid is the
        # wrong instrument for "is this near known water": Albemarle Sound measured 52 km from a
        # point 5.53 km off its own shoreline this same morning, and a blob 2 km off the edge of
        # a 40 km reservoir is 25 km from its middle. Anything within reach of a CLAIMED CELL is
        # near known water by definition, whatever the centroid says; the centroid test survives
        # only for blobs beyond that reach, where it is doing its real job of excluding water
        # outside the region the app serves.
        # ANY CELL, never the centroid -- that is what keeps a border lake.
        if region is not None and not region.any_inside(
                ((x * CELL, y * CELL) for x, y in c)):
            dropped_out += 1
            acres_out += acres
            continue
        rad, who = nearest_known(c, a.near_cells)
        if rad is None and keep_near \
                and not keep_near(sum(xs) / len(xs) * CELL, sum(ys) / len(ys) * CELL):
            dropped_far += 1
            continue
        bw = max(xs) - min(xs) + 1
        bh = max(ys) - min(ys) + 1
        # A one-cell-wide line fills its own bounding box completely -- a straight 60x1 river
        # scored fill 1.00 in the synthetic test and sorted above real lakes. Width is a
        # separate question from fill and has to be asked separately.
        narrow = min(bw, bh) < 2
        out.append({
            'acres': round(acres),
            'lon': round(sum(xs) / len(xs) * CELL, 6),
            'lat': round(sum(ys) / len(ys) * CELL, 6),
            'bbox': [round(min(xs) * CELL, 6), round(min(ys) * CELL, 6),
                     round(max(xs) * CELL, 6), round(max(ys) * CELL, 6)],
            'cells': len(c),
            'fill': round(len(c) / float(bw * bh), 3),
            'narrow': narrow,
            'da_cells': sum(1 for p in c if p in da),
            'da_share': round(sum(1 for p in c if p in da) / float(len(c)), 3),
            'near_slug': who,
            'near_cells': rad,
            'near_km': None if rad is None else round(rad * CELL * 111.32, 2),
            'touches_known': rad is not None and rad <= 1,
            # A SAMPLE OF THE ACTUAL CELLS, because the bbox is not the cluster.
            #
            # id_unclaimed_water.py asks 3DHP "what polygon holds this water" and can only ask
            # about points. Given a centroid it asks about a point that is usually on land --
            # Lake Marion's own registry centroid measures 4,160 m outside Lake Marion's polygon.
            # Given the bbox it asks about a box that is 46% land at the median fill here, which
            # caps the achievable score at the fill and made a perfect match read as 0.12.
            # These cells ARE the water, so a score against them means what it says.
            'pts': [[round(x * CELL, 6), round(y * CELL, 6)]
                    for x, y in sorted(c)[::max(1, len(c) // PTS_PER_CLUSTER)][:PTS_PER_CLUSTER]],
        })
    # Biggest FIRST is the wrong sort for this file -- the biggest are rims. Order by what a
    # missing lake looks like: detached from everything known, densely filled, and then large.
    out.sort(key=lambda r: (r['touches_known'], r['narrow'], -r['fill'], -r['acres']))
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    json.dump(out, open(a.out, 'w'), indent=1)

    rim = [r for r in out if r['touches_known']]
    free = [r for r in out if not r['touches_known']]
    solid = [r for r in free if r['fill'] >= a.min_fill and not r['narrow']
             and (not da or r['da_share'] >= a.min_da)]
    # Every filter says what it ate. A filter that removed everything and one that removed
    # nothing look identical from the outside, and that has cost this pipeline four bugs.
    why = []
    if dropped_out:
        why.append('%d outside %s (%s ac)' % (dropped_out, '+'.join(region.states),
                                              format(round(acres_out), ',')))
    if dropped_far:
        why.append('%d too far from any known water' % dropped_far)
    print('\n%d clusters total, %d between %.0f and %.0f acres%s -> %s'
          % (len(comps), len(out), a.min_acres, a.max_acres,
             (', dropped: ' + '; '.join(why)) if why else '', a.out))
    print()
    print('  %6d touch a boundary already in the registry  -- a rim to widen, not a lake to find'
          % len(rim))
    print('  %6d are detached from every known boundary' % len(free))
    print('  %6d of those also fill >= %.0f%% of their box AND are >= %.0f%% inside a real '
          'depth area  <-- THE LIST' % (len(solid), a.min_fill * 100, a.min_da * 100))
    print()
    print('DETACHED AND SOLID, biggest first — paste lon,lat into apps.nationalmap.gov/viewer:')
    print('   %9s %6s %6s %8s  %s' % ('ACRES', 'FILL', 'DEPTH', 'SPAN km', 'LON, LAT'))
    for r in sorted(solid, key=lambda r: -r['acres'])[:30]:
        w, s_, e, n = r['bbox']
        span = math.hypot((e - w) * 111.32 * math.cos(math.radians(r['lat'])),
                          (n - s_) * 111.32)
        print('   %9s %6.2f %6.2f %8.1f  %.6f, %.6f'
              % (format(r['acres'], ','), r['fill'], r['da_share'], span, r['lon'], r['lat']))
    if not solid:
        print('   (none — every detached cluster is stringier than --min-fill)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
