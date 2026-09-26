#!/usr/bin/env python3
"""Build a water graph from OUR OWN bathymetry instead of Garmin's MAR mesh.

Personal use only, not for distribution or resale; not for navigation.

WHY. MAR is Garmin's auto-guidance mesh. Where Garmin never built one there is no routing at
all even though the depth data is right there: 16 waters returned "no MAR cells inside the
boundary" with 8,779 contours and 2,541 trolling runs between them, 0 routable. Card-wide the
census put 129,011 of 390,524 runs unroutable.

Design and measurements: claude/OUR_OWN_WATER_GRAPH_2026-08-26.md. Nothing here is re-derived;
the three details below each cost a wrong answer before that document was written.

THE LAND TEST IS THE WHOLE BALLGAME. Both ends of a candidate edge are already known to sit in
charted water, so a segment leaves the water IF AND ONLY IF it crosses the water's edge. Veto
any edge that intersects the boundary. Exact -- no sampling, nothing to get unlucky with.

  1. THE BOUNDARY OF THE UNION, not of the parts. 3DHP splits a lake into one Feature per part
     and neighbouring parts share a border, so testing against the parts vetoes every segment
     that crosses an internal seam in open water. unary_union first, then take its boundary.
  2. NOT garmin_shoreline.geojson. Those arcs are cut open at tile edges, so a segment slips
     through the gap without crossing a line -- that is how 158 sample points landed on land in
     the first audit. This reads registry/boundaries/<slug>.geojson.
  3. CHOP THE RINGS INTO TWO-POINT SEGMENTS BEFORE INDEXING. One 50,000-vertex ring has a
     bounding box the size of the lake, so every query hits it and the index does nothing.

DEPTH IS THE SHALLOW END OF THE BAND, ALWAYS. depth_areas carries depth_min_ft/depth_max_ft in
1 ft bands. A router deciding "can my kayak pass" must not be told the deep end. min is the only
safe read and it is what gets written to the depth byte.

CHART DATUM, AND IT SAYS SO. The graph is built once at full pool, because that is what Garmin
sounded. The drawdown is applied LIVE at route time as
    minimum usable depth = kayak draft + feet below full pond
which is one term added to a parameter Worker/water.js already has. This script never applies a
drawdown and the report records `datum: "chart"` so nothing downstream can assume otherwise.

OUTPUT is byte-identical in FORMAT to what build_water_graphs.py writes -- same TMWG v2 header,
same node/edge/depth layout -- so the Worker, the packs, build_trolling_runs.py and
fit_trolling_runs.py never learn anything changed.
"""
import argparse, json, math, os, shutil, struct, sys, time
from collections import deque

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
from build_chartpack import build_mask, _rings              # noqa: E402

try:
    from shapely.geometry import Polygon, LineString, Point, shape
    from shapely.geometry import box as _box
    from shapely.strtree import STRtree
    from shapely.ops import unary_union
    from shapely.prepared import prep
except ImportError:
    sys.exit('shapely is required: pip install shapely --break-system-packages')

STAMP = time.strftime('%Y-%m-%d')
MAGIC = b'TMWG'
VERSION = 2
NOTE = 'Personal use only, not for distribution or resale; not for navigation.'

# 8-neighbour. 4 would forbid a diagonal move through a gap the boat can actually take, and the
# land test is what decides passability here, not the stencil.
NEIGHBOURS = ((1, 0), (0, 1), (1, 1), (1, -1))   # half the stencil; each pair is emitted once


def load_boundary(registry, slug):
    """Every part of the lake's boundary, not just the first. Marion has 4 parts, Barkley 20,
    in no particular order, so reading features[0] clips against a fragment -- Marion's first
    is 1/3400th of the water."""
    fp = os.path.join(registry, 'boundaries', slug + '.geojson')
    if not os.path.exists(fp):
        return None
    gj = json.load(open(fp, encoding='utf-8'))
    geoms = ([f.get('geometry') for f in (gj.get('features') or [])]
             if gj.get('type') == 'FeatureCollection' else [gj.get('geometry') or gj])
    r = [ring for g in geoms if g for ring in _rings(g)]
    return r or None


def boundary_segments(rings):
    """The union's boundary, chopped into two-point segments.

    Detail 1 and detail 3 of the land test, together. Building polygons from the rings and
    unioning them collapses the shared borders between parts; chopping the result into segments
    is what makes the STRtree do any work at all.
    """
    polys = []
    for r in rings:
        if len(r) < 4:
            continue
        try:
            p = Polygon(r)
            if not p.is_valid:
                p = p.buffer(0)
            if not p.is_empty:
                polys.append(p)
        except Exception:
            continue
    if not polys:
        return [], None
    merged = unary_union(polys)
    segs = []
    b = merged.boundary
    lines = list(getattr(b, 'geoms', [b]))
    for ln in lines:
        cs = list(ln.coords)
        for i in range(len(cs) - 1):
            if cs[i] != cs[i + 1]:
                segs.append(LineString((cs[i], cs[i + 1])))
    return segs, merged


def water_polygon(registry, slug):
    """The lake as WATER, islands included -- or None, and the caller falls back to the rings.

    WHY NOT boundary_segments(rings). `_rings()` in build_chartpack returns OUTER rings only
    (`[c[0]]` per polygon), so every island the boundary carries became a filled-in piece of
    water the moment the rings were built into polygons here. Wateree's registry boundary has
    54 holes, 1.3 km2 of them, and the land test never saw one: measured on the 2026-08-30
    graph, 3,396 edges were not covered by the boundary once its holes count as land -- 49.9 km
    of edge, up to 28.6 m of a single edge over an island.

    Same union-of-the-parts rule as boundary_segments (detail 1): the parts are unioned first so
    a seam between two 3DHP parts in open water is not a wall. The difference is only that each
    part is built from its GeoJSON geometry, holes and all, rather than from its outer ring.

    The islands are the BOUNDARY's, not the chart's. Where the boundary calls something an
    island that the chart floods (hump_8 off Clearwater Cove, 3 ft crown in a 0.27-acre hole --
    THE_ISLAND_THE_CHART_FLOODS_2026-08-31) this routes around it. That is the conservative
    direction for a router: the boat is sent round a 3 ft shoal, never across an island.
    """
    fp = os.path.join(registry, 'boundaries', slug + '.geojson')
    if not os.path.exists(fp):
        return None
    gj = json.load(open(fp, encoding='utf-8'))
    geoms = ([f.get('geometry') for f in (gj.get('features') or [])]
             if gj.get('type') == 'FeatureCollection' else [gj.get('geometry') or gj])
    polys = []
    for g in geoms:
        if not g or g.get('type') not in ('Polygon', 'MultiPolygon'):
            continue
        try:
            p = shape(g)
            if not p.is_valid:
                p = p.buffer(0)
            if not p.is_empty:
                polys.append(p)
        except Exception:
            continue
    if not polys:
        return None
    merged = unary_union(polys)
    return merged if not merged.is_empty else None


def segments_of(merged):
    """Detail 3 of the land test on an already-merged polygon: its whole boundary -- outer rings
    AND island rings -- chopped into two-point segments for the STRtree."""
    segs = []
    b = merged.boundary
    for ln in list(getattr(b, 'geoms', [b])):
        cs = list(ln.coords)
        for i in range(len(cs) - 1):
            if cs[i] != cs[i + 1]:
                segs.append(LineString((cs[i], cs[i + 1])))
    return segs


def depth_bands(pack, slug):
    """Every depth polygon as (rings, shallow_ft). Rings, not shapely -- see rasterise_depths."""
    fp = os.path.join(pack, slug, 'depth_areas.geojson')
    if not os.path.exists(fp):
        return None
    out = []
    gj = json.load(open(fp, encoding='utf-8'))
    for f in (gj.get('features') or []):
        d = (f.get('properties') or {}).get('depth_min_ft')
        g = f.get('geometry')
        if d is None or not g:
            continue
        rings = _rings(g)
        if rings:
            out.append((rings, int(d)))
    return out or None


def dock_polygons(pack, slug):
    """Every charted dock as a shapely polygon, or [] where the pack has none.

    Ryan, on a transit routed straight through one: "i would prefer to not be routed through this
    persons dock... i am sure they prefer that too."

    docks.geojson ships in every pack and nothing has ever read it for routing. Wateree has 2,796.
    Absent is [] and never an error -- a pack without the layer simply has no docks to avoid, and
    that must not be the difference between a graph and no graph.
    """
    fp = os.path.join(pack, slug, 'docks.geojson')
    if not os.path.exists(fp):
        return []
    out = []
    try:
        gj = json.load(open(fp, encoding='utf-8'))
    except Exception:
        return []
    for f in (gj.get('features') or []):
        for r in _rings(f.get('geometry') or {}):
            if len(r) >= 4:
                try:
                    p = Polygon(r)
                    if p.is_valid and not p.is_empty:
                        out.append(p)
                except Exception:
                    continue
    return out


def coarsen_cells(dmap, core, step):
    """Aggregate a step x step block of raster cells into one routing node. Shallowest wins.

    WHY THIS IS NOT A COARSER RASTER, WHICH IS THE WHOLE POINT.
    Raising LakeMask.CELL rasterises at the coarse size and fills a cell when its CENTRE lands in
    a depth band. A creek narrower than the cell then keeps only the centres that happen to fall
    in water, and the chain along it breaks. That is the resolution loss everybody assumes a
    coarser grid must cost.

    This does the opposite. The raster stays at 22.3 m, so the water keeps its shape exactly, and
    only the NODE grid coarsens: a block is water if ANY of its cells is charted. A 30 m creek
    still yields an unbroken chain of nodes down its length.

    MEASURED 2026-09-15 on three coastal zones, step=2, against the 22.3 m graph, using the same
    120 m reach rule build_trolling_runs.py applies:

        zone             fine 22.3 m                coarse 44.6 m              runs LOST
        cape_romain_sc   1,974 runs   9.6 MB 88.18%  1,982 runs  2.6 MB 87.31%       0
        st_helena_sc     8,844 runs  33.8 MB 99.00%  8,853 runs  8.9 MB 99.18%       0
        ace_basin_sc    16,376 runs  44.7 MB 96.94% 16,418 runs 12.0 MB 97.45%       0

    Nothing lost, eight/nine/forty-two gained, and BETTER connected on two of the three. Only 0.3%
    of ACE Basin's runs lie in water 22 m or narrower and that bucket improved too, because the
    coarse grid has fewer gaps to bridge along a creek than the fine one does.

    WHY IT IS WANTED. Worker/water.js expands this format into Float64 coordinates and a CSR
    adjacency, and its own comment sizes the cache against a 128 MB isolate. ACE Basin at 22.3 m is
    44.7 MB on disk and about 104 MB parsed -- one entry would not leave room for a second. At
    44.6 m it is 12.0 MB and about 18 MB parsed, which fits the way Wateree's 4.57 MB does.

    SHALLOWEST WINS, the same rule rasterise_depths() uses where bands overlap a cell: the boat
    meets the shallow one. A block that averaged its depths would invent water nobody sounded.
    """
    if step <= 1:
        return dmap, core
    agg = {}
    for (i, j), d in dmap.items():
        key = (i // step, j // step)
        prev = agg.get(key)
        if prev is None or d < prev:
            agg[key] = d
    return agg, {(i // step, j // step) for (i, j) in core}


def rasterise_depths(bands, mask, mark_rings=False):
    """Scanline-fill every depth polygon into the mask's own grid. Shallowest band wins.

    WHY NOT A SPATIAL INDEX. The obvious version asks an STRtree once per cell. Measured on
    Wateree: point-in-polygon on the cell CENTRE ran in 36 s but left 7,556 of 125,957 core
    cells with no depth -- 6% of the lake, cutting the graph into 2,194 components against the
    ~100 this design measured, because a centre landing on the shared edge between two 1 ft
    bands belongs to both and was matched by neither. Asking the cell's 22 m FOOTPRINT instead,
    which is the correct question, did not finish in three minutes.

    That is the wall LakeMask already hit and documented: "the naive clip is 7.5 billion segment
    tests for one lake... so rasterise ONCE per lake and then ask the grid." Same two steps in
    the same order as LakeMask uses on the boundary: even-odd scanline fill over ALL rings of a
    polygon together so a hole in a band stays a hole, then mark the cells each ring passes
    through so a band thinner than one cell is not lost.

    SHALLOWEST WINS. Where bands overlap a cell, the boat can meet the shallow one.

    MARK_RINGS IS OFF BY DEFAULT, and that is a departure from LakeMask on purpose. LakeMask
    marks the cells its ring passes through so a lake narrower than one cell is not lost. Depth
    bands do not need it -- they tile the water, so the fill alone reaches everything -- and
    turning it on puts a node on every band OUTLINE, including the 0-1 ft band, which is the
    shoreline. Measured on Wateree: it cut uncharted cells 7,556 -> 3,523 but doubled the
    land-test vetoes 9,630 -> 20,698, took components 2,194 -> 4,298, and smeared the shallow
    band along outlines so cells tagged 0 ft went 3.7% -> 6.5%. More nodes, worse graph.
    """
    depth = {}
    w, s0, cell, nx, ny = mask.w, mask.s, mask.cell, mask.nx, mask.ny
    for rings, d in bands:
        ys = [p[1] for r in rings for p in r]
        j0 = max(0, int((min(ys) - s0) / cell) - 1)
        j1 = min(ny - 1, int((max(ys) - s0) / cell) + 1)
        for j in range(j0, j1 + 1):
            y = s0 + (j + 0.5) * cell
            xs = []
            for r in rings:
                for i in range(len(r) - 1):
                    y1, y2 = r[i][1], r[i + 1][1]
                    if (y1 > y) == (y2 > y):
                        continue
                    x1, x2 = r[i][0], r[i + 1][0]
                    xs.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
            if not xs:
                continue
            xs.sort()
            for k in range(0, len(xs) - 1, 2):
                a = max(0, int((xs[k] - w) / cell))
                b = min(nx - 1, int((xs[k + 1] - w) / cell))
                for i in range(a, b + 1):
                    key = (i, j)
                    cur = depth.get(key)
                    if cur is None or d < cur:
                        depth[key] = d
        if mark_rings:
            for r in rings:
                for px, py in r:
                    key = (int((px - w) / cell), int((py - s0) / cell))
                    cur = depth.get(key)
                    if cur is None or d < cur:
                        depth[key] = d
    return depth



def build_lake(registry, pack, slug, cell=None, quiet=False, coarsen=1):
    """One lake. Returns a report dict; writes nothing."""
    t0 = time.time()
    rep = {'slug': slug, 'datum': 'chart', 'drawdown_applied': False}

    rings = load_boundary(registry, slug)
    if not rings:
        rep['skipped'] = 'no registry boundary'
        return rep, None
    bands = depth_bands(pack, slug)
    if not bands:
        rep['skipped'] = 'no depth_areas.geojson'
        return rep, None
    rep['depth_polygons'] = len(bands)
    docks = dock_polygons(pack, slug)
    rep['docks'] = len(docks)

    # The mask is the SAME rasteriser build_chartpack uses -- one grid definition in this repo,
    # not two. buffer 0 because a routing node outside the waterline is a node on the bank.
    mask = build_mask(rings, 0.0)
    core = getattr(mask, 'core', None)
    if core is None:
        rep['skipped'] = 'mask has no core'
        return rep, None
    try:
        cells = sorted(core)
    except TypeError:                      # BboxMask's _BoxCells
        cells = sorted(iter(core))
    # TWO GRIDS, NAMED SEPARATELY, because conflating them cost a whole wrong recommendation.
    # `cell` used to be read as `cell or mask.cell` and written to `cell_deg`, and it is the only
    # thing it did -- the raster came from build_mask regardless. So a caller passing cell=0.0004
    # got a report claiming a 44.6 m grid and a graph built at 22.3 m. `raster_cell_deg` is what
    # the water was rasterised at and is not a parameter; `node_cell_deg` is what the routing
    # nodes sit on and is the one `--coarsen` moves.
    step = max(1, int(coarsen or 1))
    rep['raster_cell_deg'] = mask.cell
    rep['raster_cell_m_ns'] = round(mask.cell * 111320.0, 1)
    rep['coarsen'] = step
    node_cell = mask.cell * step
    rep['cell_deg'] = cell or node_cell
    rep['cell_m_ns'] = round((cell or node_cell) * 111320.0, 1)
    rep['core_cells'] = len(cells)

    # ── nodes: a core cell is a node only if the chart gives it a depth ──────────────────
    dmap = rasterise_depths(bands, mask)
    rep['charted_cells_in_raster'] = len(dmap)
    # THE RASTER IS NEVER COARSENED, ONLY THE NODE GRID. See coarsen_cells() for the measurements
    # and for why a coarser raster is the thing that would lose creeks.
    dmap, cells = coarsen_cells(dmap, cells, step)
    if step > 1:
        rep['charted_cells_after_coarsen'] = len(dmap)
        rep['core_cells_after_coarsen'] = len(cells)
    # ── THE WATER, read BEFORE the nodes, because it decides which cells may be one ──────
    #
    # A NODE ON THE BANK IS NOT A NODE. build_mask marks every cell its ring passes through as
    # core, so a lake narrower than a cell is not lost -- and that puts cells on the bank whose
    # CENTRE is outside the water. The comment above build_mask(rings, 0.0) already says "a
    # routing node outside the waterline is a node on the bank"; nothing enforced it.
    #
    # What it cost, measured on the 2026-08-30 Wateree graph: 4,790 nodes outside the largest
    # component, and 4,413 of them had their centre outside the boundary. None can hold an edge
    # to the lake -- a segment that starts on land is never `covered` -- so each was a loose
    # point, and the Worker's nearestNode() snaps to the nearest node WHATEVER its component:
    # 774 of 5,686 trolling-run ends (13.6%) snapped to one, and a route from there answers 422.
    # Run #401's end is 6 m from an orphan and 17 m from the lake.
    #
    # It also broke the prefilter below. "An edge whose bounding box touches no boundary segment
    # is deep interior" is true only when both ends are in the water; two bank cells side by side
    # can clear every segment's bounding box, and 697 edges lay wholly on land that way.
    water = water_polygon(registry, slug)
    if water is not None:
        segs, merged = segments_of(water), water
    else:
        segs, merged = boundary_segments(rings)
    on_water = prep(merged) if merged is not None else None
    idx, nodes, depths = {}, [], []
    on_bank = 0
    for (i, j) in sorted(cells):
        d = dmap.get((i, j))
        if d is None:
            continue
        xy = (mask.w + (i + 0.5) * node_cell, mask.s + (j + 0.5) * node_cell)
        if on_water is not None and not on_water.covers(Point(xy)):
            on_bank += 1
            continue
        idx[(i, j)] = len(nodes)
        nodes.append(xy)
        depths.append(d)
    rep['nodes'] = len(nodes)
    rep['dropped_on_bank'] = on_bank
    rep['uncharted_cells'] = len(cells) - len(nodes) - on_bank
    if not nodes:
        rep['skipped'] = 'no charted depth inside the boundary'
        return rep, None

    # ── candidate edges: 8-neighbour, each pair emitted once ────────────────────────────
    cand = []
    for (i, j), a in idx.items():
        for dx, dy in NEIGHBOURS:
            b = idx.get((i + dx, j + dy))
            if b is not None:
                cand.append((a, b))
    rep['candidate_edges'] = len(cand)

    # ── THE LAND TEST ───────────────────────────────────────────────────────────────────
    # `segs` and `merged` come from water_polygon() above -- islands included -- and every node
    # is now inside `merged`, which is the premise the prefilter below depends on.
    rep['boundary_segments'] = len(segs)
    rep['boundary_holes'] = sum(len(p.interiors) for p in getattr(merged, 'geoms', [merged])
                                if hasattr(p, 'interiors')) if merged is not None else 0
    #
    # THE TEST IS "DOES ANY PART OF THIS SEGMENT LEAVE THE WATER", NOT "DOES IT TOUCH THE EDGE".
    # An earlier version vetoed on crosses() OR touches(), which killed every segment that merely
    # ended on the waterline -- shoreline cells got stranded and the largest component came out
    # 97.87% against the 99.88% this design measured. `covers` is the exact question: the water
    # polygon covers the whole segment, or some of it is on land.
    #
    # The STRtree is a PREFILTER, not the test. An edge whose bounding box touches no boundary
    # segment is deep interior and cannot leave the water, so it skips the expensive call
    # entirely -- which is most of them.
    edges = []
    vetoed = 0
    if segs and merged is not None:
        stree = STRtree(segs)
        keep_all = prep(merged)
        for a, b in cand:
            ln = LineString((nodes[a], nodes[b]))
            near = stree.query(ln)
            if len(near) == 0:
                edges.append((a, b))
                continue
            if keep_all.covers(ln):
                edges.append((a, b))
            else:
                vetoed += 1
    else:
        edges = cand
    rep['edges'] = len(edges)
    rep['vetoed_by_land_test'] = vetoed

    # ── THE DOCK TEST ───────────────────────────────────────────────────────────────────
    #
    # Ryan, looking at a transit drawn straight through a charted dock: "i would prefer to not be
    # routed through this persons dock... i am sure they prefer that too."
    #
    # The land test above asks whether a segment leaves the WATER. A dock is over water and it is
    # still not somewhere to drive: it is somebody's property, it is a fixed obstruction, and a
    # kayak towing two rods through a boat lift is a bad afternoon for everyone.
    #
    # docks.geojson ships in every pack and nothing has ever read it for routing -- Wateree has
    # 2,796 of them. Same mechanism as the land test and the same prefilter: an STRtree over the
    # dock polygons, and an edge whose bounding box misses every one of them is never tested.
    #
    # `intersects`, not `covers`. A segment that merely clips the corner of a dock still goes
    # through it, and unlike the waterline there is no reason to be generous about touching --
    # nothing legitimate ends ON a dock.
    docked = 0
    if docks:
        dtree = STRtree(docks)
        kept = []
        for a, b in edges:
            ln = LineString((nodes[a], nodes[b]))
            near = dtree.query(ln)
            if len(near) and any(docks[k].intersects(ln) for k in near):
                docked += 1
            else:
                kept.append((a, b))
        edges = kept
    rep['vetoed_by_dock_test'] = docked
    rep['edges'] = len(edges)

    # ── LOOSE POINTS ────────────────────────────────────────────────────────────────────
    #
    # A node the land and dock tests left with no edge at all is not sparse water, it is a point
    # nothing can reach -- build_water_graphs.py says the same of a whole graph. On Wateree they
    # are cells inside a dock polygon or boxed in by docks (351 on 2026-08-30), and each is a
    # nearestNode() trap: #401's end sits 6 m from one and 17 m from open water. Dropped and the
    # survivors renumbered, so the file carries no index that points at nothing.
    deg = [0] * len(nodes)
    for a, b in edges:
        deg[a] += 1
        deg[b] += 1
    loose = sum(1 for k in deg if k == 0)
    rep['dropped_no_edge'] = loose
    if loose:
        remap, n2, d2 = {}, [], []
        for k, (p, dd) in enumerate(zip(nodes, depths)):
            if deg[k]:
                remap[k] = len(n2)
                n2.append(p)
                d2.append(dd)
        edges = [(remap[a], remap[b]) for a, b in edges]
        nodes, depths = n2, d2
    rep['nodes'] = len(nodes)
    if not nodes:
        rep['skipped'] = 'no node kept an edge'
        return rep, None

    # ── components ──────────────────────────────────────────────────────────────────────
    adj = [[] for _ in nodes]
    for a, b in edges:
        adj[a].append(b)
        adj[b].append(a)
    seen = [False] * len(nodes)
    sizes = []
    for s in range(len(nodes)):
        if seen[s]:
            continue
        q, n = deque([s]), 0
        seen[s] = True
        while q:
            u = q.popleft()
            n += 1
            for v in adj[u]:
                if not seen[v]:
                    seen[v] = True
                    q.append(v)
        sizes.append(n)
    sizes.sort(reverse=True)
    rep['components'] = len(sizes)
    rep['largest_component_pct'] = round(100.0 * sizes[0] / len(nodes), 2) if sizes else 0.0
    rep['tagged_zero_ft'] = sum(1 for d in depths if d <= 0)
    rep['tagged_zero_pct'] = round(100.0 * rep['tagged_zero_ft'] / len(depths), 1)
    rep['seconds'] = round(time.time() - t0, 1)
    if not quiet:
        # flush=True because a 196-lake run redirected to a file otherwise shows nothing for
        # minutes at a time -- stdout buffers in 8 KB blocks and the log lags the work, which
        # reads exactly like a hang. It cost twenty minutes of chasing one on 2026-08-27.
        print('  %-30s %7d nodes %8d edges  %5.2f%% largest  %4.1f%% at 0 ft  %ss'
              % (slug, len(nodes), len(edges), rep['largest_component_pct'],
                 rep['tagged_zero_pct'], rep['seconds']), flush=True)
    return rep, (nodes, edges, depths)


def write_graph(path, nodes, edges, depths, layer=0, base_ft=0):
    """Byte-identical FORMAT to build_water_graphs.write_graph -- TMWG v2."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(MAGIC)
        f.write(struct.pack('<BBHII', VERSION, layer, base_ft or 0, len(nodes), len(edges)))
        f.write(b''.join(struct.pack('<ii', round(x * 1e7), round(y * 1e7)) for x, y in nodes))
        f.write(b''.join(struct.pack('<II', a, b) for a, b in edges))
        f.write(bytes(min(255, max(0, d)) for d in depths))
    return os.path.getsize(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default='.')
    ap.add_argument('--registry', default=None)
    ap.add_argument('--pack', default=None)
    ap.add_argument('--only-lakes', default=None,
                    help='comma-separated slugs. Overrides --scope.')
    ap.add_argument('--all-packs', action='store_true',
                    help='do not restrict to waters in lake_index.json. There are 1,706 packs on '
                         'disk with depth_areas and only 358 waters in the index -- the rest are '
                         'retired, out-of-region or never shipped, and building graphs for them '
                         'is work nothing reads.')
    ap.add_argument('--scope', default='missing', choices=['missing', 'all'],
                    help="'missing' (DEFAULT) builds ONLY where the pack has depth_areas.geojson "
                         "and NO water_graph.bin -- the waters Garmin never meshed, which have no "
                         "routing at all today. Nothing that already works is touched. 'all' "
                         "considers every pack with depth_areas.geojson, and still refuses to "
                         "replace an existing graph without --overwrite.")
    ap.add_argument('--coarsen', type=int, default=1, metavar='N',
                    help='aggregate an NxN block of 22.3 m raster cells into ONE routing node. '
                         'Default 1, unchanged. The raster is never coarsened -- the water keeps '
                         'its exact shape and only the node grid moves, so a creek narrower than '
                         'a node still gets an unbroken chain of them. 2 is measured: across '
                         'Cape Romain, St. Helena and ACE Basin it cost ZERO routable runs, '
                         'gained 8/9/42, came out better connected on two of the three, and took '
                         'ACE Basin from 44.7 MB to 12.0 MB -- which is the difference between '
                         'fitting a 128 MB Worker isolate and not. See coarsen_cells().')
    ap.add_argument('--out-name', default='water_graph.bin')
    ap.add_argument('--report', default='registry/_bathy_graphs.json')
    ap.add_argument('--dry-run', action='store_true', help='measure, write no .bin')
    ap.add_argument('--overwrite', action='store_true',
                    help="replace an existing file at --out-name. Without this the script "
                         "REFUSES rather than clobber Garmin's graph, which is the product of "
                         "a full card pass. WITH it, the file being replaced is MOVED to "
                         "<packs>/_to_delete/graph_replaced_<date>/ rather than overwritten, so "
                         "putting it back is a file move and not a rebuild of 455 lakes. The "
                         "report records where each one went.")
    a = ap.parse_args()
    reg = a.registry or os.path.join(a.root, 'registry')
    pack = a.pack or os.path.join(a.root, 'chartpack')

    #
    # SCOPE IS 'missing' BY DEFAULT, AND THAT IS THE DESIGN, NOT A CONVENIENCE.
    #
    # Garmin's portals were asserted by a survey; ours are inferred from what the chart draws.
    # Where he did the work, use his work. This script exists for the waters he never meshed --
    # they have no routing at all, so there is nothing to lose and no lake that currently works
    # can be affected by a defect in here.
    #
    withdepth = sorted(d for d in os.listdir(pack)
                       if os.path.exists(os.path.join(pack, d, 'depth_areas.geojson')))
    on_disk = len(withdepth)
    indexed = None
    if not a.all_packs:
        ix = os.path.join(reg, 'lake_index.json')
        if os.path.exists(ix):
            indexed = set(json.load(open(ix, encoding='utf-8')))
            withdepth = [d for d in withdepth if d in indexed]
    missing = [d for d in withdepth
               if not os.path.exists(os.path.join(pack, d, 'water_graph.bin'))]
    if a.only_lakes:
        slugs = [s.strip() for s in a.only_lakes.split(',') if s.strip()]
        scope = 'named'
    elif a.scope == 'missing':
        slugs, scope = missing, 'missing'
    else:
        slugs, scope = withdepth, 'all'
    print('bathy_graph: %d water%s  [scope=%s]  %s'
          % (len(slugs), '' if len(slugs) == 1 else 's', scope,
             '(dry run)' if a.dry_run else ''))
    print('  packs with depth_areas on disk: %d%s' %
          (on_disk, '' if indexed is None else
           '   in lake_index: %d' % len(withdepth)))
    print('  of those, no Garmin graph: %d' % len(missing))
    report, built, failed, left, measured = {}, 0, 0, 0, 0
    for s in slugs:
        try:
            rep, graph = build_lake(reg, pack, s, coarsen=a.coarsen)
        except Exception as e:
            rep, graph = {'slug': s, 'error': '%s: %s' % (type(e).__name__, e)}, None
            print('  %-30s ERROR %s' % (s, rep['error']), flush=True)
        report[s] = rep
        if graph:
            measured += 1
        if graph and not a.dry_run:
            dest = os.path.join(pack, s, a.out_name)
            if os.path.exists(dest) and not a.overwrite:
                rep['skipped'] = "Garmin's graph is here; --overwrite to replace"
                print('  %-30s HAS A GARMIN GRAPH, left alone' % s, flush=True)
                left += 1
                continue
            # --overwrite USED TO CLOBBER, AND WHAT IT CLOBBERS COSTS A FULL CARD PASS.
            #
            # The graph being replaced is the product of build_water_graphs.py over the whole
            # Garmin mesh. If a bathy graph turns out worse on some water -- fewer routable runs,
            # a worse largest component -- putting the old one back should be a file move, not a
            # rebuild of 455 lakes.
            #
            # It goes to _to_delete/ rather than beside the pack, which is this repo's own rule for
            # a file that should stop being used but must not vanish, and it keeps the uploader
            # from ever seeing it: upload_garmin_to_r2.py maps the layer to the exact name
            # "water_graph.bin", so a file called anything else is not a layer.
            #
            # Written the day registry/_bathy_graphs.json was destroyed by a --dry-run that still
            # wrote its report. A flag that removes something should say so, and should leave the
            # something somewhere.
            if os.path.exists(dest):
                keep = os.path.join(pack, '_to_delete', 'graph_replaced_' + STAMP)
                os.makedirs(keep, exist_ok=True)
                kept = os.path.join(keep, '%s_%s' % (s, a.out_name))
                shutil.move(dest, kept)
                rep['replaced_graph_moved_to'] = os.path.relpath(kept, pack)
                print('  %-30s previous graph -> %s' % (s, rep['replaced_graph_moved_to']),
                      flush=True)
            n, e2, d = graph
            rep['bytes'] = write_graph(dest, n, e2, d)
            built += 1
        elif not graph:
            failed += 1
    rp = os.path.join(a.root, a.report)
    os.makedirs(os.path.dirname(rp), exist_ok=True)
    json.dump({'_note': NOTE, 'built_by': 'scripts/bathy_graph.py', 'scope': scope,
               'datum': 'chart -- full pool. Drawdown is applied live at route time.',
               'depth_rule': 'depth_min_ft, the SHALLOW end of each 1 ft band',
               'lakes': report}, open(rp, 'w'), indent=1)
    # MEASURED IS COUNTED SEPARATELY FROM BUILT. The first version incremented `built` only
    # inside `if graph and not a.dry_run`, so a --dry-run that measured all 196 waters
    # successfully printed "built 0 left alone 0 skipped/failed 0" under 196 lines of real
    # output. A summary that reads zero after a clean run is worse than no summary.
    if a.dry_run:
        print('measured %d   could not build %d   (dry run, nothing written)   -> %s'
              % (measured, failed, a.report))
    else:
        print('built %d   left alone %d   could not build %d   -> %s'
              % (built, left, failed, a.report))
    return 0


if __name__ == '__main__':
    sys.exit(main())
