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
import argparse, json, math, os, struct, sys, time
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



def build_lake(registry, pack, slug, cell=None, quiet=False):
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
    csz = cell or mask.cell
    rep['cell_deg'] = csz
    rep['cell_m_ns'] = round(csz * 111320.0, 1)
    rep['core_cells'] = len(cells)

    # ── nodes: a core cell is a node only if the chart gives it a depth ──────────────────
    dmap = rasterise_depths(bands, mask)
    rep['charted_cells_in_raster'] = len(dmap)
    idx, nodes, depths = {}, [], []
    for (i, j) in cells:
        d = dmap.get((i, j))
        if d is None:
            continue
        idx[(i, j)] = len(nodes)
        nodes.append((mask.w + (i + 0.5) * mask.cell, mask.s + (j + 0.5) * mask.cell))
        depths.append(d)
    rep['nodes'] = len(nodes)
    rep['uncharted_cells'] = len(cells) - len(nodes)
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
    segs, merged = boundary_segments(rings)
    rep['boundary_segments'] = len(segs)
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
        print('  %-30s %7d nodes %8d edges  %5.2f%% largest  %4.1f%% at 0 ft  %ss'
              % (slug, len(nodes), len(edges), rep['largest_component_pct'],
                 rep['tagged_zero_pct'], rep['seconds']))
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
                    help='comma-separated slugs. Default: every pack with depth_areas.geojson.')
    ap.add_argument('--out-name', default='water_graph.bin')
    ap.add_argument('--report', default='registry/_bathy_graphs.json')
    ap.add_argument('--dry-run', action='store_true', help='measure, write no .bin')
    ap.add_argument('--overwrite', action='store_true',
                    help="replace an existing file at --out-name. Without this the script "
                         "REFUSES rather than clobber Garmin's graph, which is the product of "
                         "a full card pass.")
    a = ap.parse_args()
    reg = a.registry or os.path.join(a.root, 'registry')
    pack = a.pack or os.path.join(a.root, 'chartpack')

    if a.only_lakes:
        slugs = [s.strip() for s in a.only_lakes.split(',') if s.strip()]
    else:
        slugs = sorted(d for d in os.listdir(pack)
                       if os.path.exists(os.path.join(pack, d, 'depth_areas.geojson')))
    print('bathy_graph: %d water%s  %s' % (len(slugs), '' if len(slugs) == 1 else 's',
                                           '(dry run)' if a.dry_run else ''))
    report, built, failed = {}, 0, 0
    for s in slugs:
        try:
            rep, graph = build_lake(reg, pack, s)
        except Exception as e:
            rep, graph = {'slug': s, 'error': '%s: %s' % (type(e).__name__, e)}, None
            print('  %-30s ERROR %s' % (s, rep['error']))
        report[s] = rep
        if graph and not a.dry_run:
            dest = os.path.join(pack, s, a.out_name)
            if os.path.exists(dest) and not a.overwrite:
                rep['skipped'] = 'exists; pass --overwrite to replace'
                print('  %-30s EXISTS, not overwritten' % s)
                failed += 1
                continue
            n, e2, d = graph
            rep['bytes'] = write_graph(dest, n, e2, d)
            built += 1
        elif not graph:
            failed += 1
    rp = os.path.join(a.root, a.report)
    os.makedirs(os.path.dirname(rp), exist_ok=True)
    json.dump({'_note': NOTE, 'built_by': 'scripts/bathy_graph.py',
               'datum': 'chart -- full pool. Drawdown is applied live at route time.',
               'depth_rule': 'depth_min_ft, the SHALLOW end of each 1 ft band',
               'lakes': report}, open(rp, 'w'), indent=1)
    print('built %d   skipped/failed %d   -> %s' % (built, failed, a.report))
    return 0


if __name__ == '__main__':
    sys.exit(main())
