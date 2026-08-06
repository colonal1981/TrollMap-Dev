#!/usr/bin/env python3
"""build_water_graphs.py - a routing graph over navigable water, one per lake.

Personal use only, not for distribution or resale; **NOT FOR NAVIGATION**.

PowerShell:

    py .\\build_water_graphs.py `
       --tiles    "F:\\TrollMapPipeline\\garmin\\charts\\Tiles" `
       --registry "F:\\TrollMapPipeline\\registry" `
       --map      "F:\\TrollMapPipeline\\registry\\tile_lake_map.json" `
       --out      "F:\\TrollMapPipeline\\chartpack"

WHAT THIS IS AND WHY IT IS NOT THE SAFE-WATER LAYER

The `G<id>.MAR` files beside every GMP tile are Garmin's auto-guidance mesh. Their dissolved
polygons were measured at 93-97% IoU against the RGN2 depth bands this pipeline already ships,
so as a DISPLAY layer they are redundant and were declined -- see
`MAR_INTO_THE_PIPELINE_2026-08-06.md`.

What is not redundant is the table underneath them. `ADJ` is a list of portals between adjacent
water cells:

    ADJ record = (nodeA, nodeB, vtxRefA, vtxRefB)

That is a routing graph over water, stated outright, and nothing else in the project can produce
one. Ryan, on seeing the first route: *"that is exactly what garmins auto routing does"* -- which
is the point. This is not an approximation of Garmin's routing, it is Garmin's routing data.

WHY IT MATTERS

`js/utils/geo.js` `distMi()` is haversine -- a straight line -- and it is imported by
`smart-plan.js`, `smart-plan-context.js`, `supplemental-layers.js`, `notifications.js`,
`lake-research-engine.js` and `plan-builder.js`. Every distance the app has ever shown is
as-the-crow-flies. Measured on Wateree, June Creek Boat Ramp to Lakeside Marina:

    straight line   12.39 km   -- and only 59.5% of it is over water
    by water        35.63 km   -- 220 of 220 segments inside navigable water
                     2.9x

The detour ratio across the tile's 14 ramps and marinas runs 1.0x to 3.1x. It is not a constant
that could be approximated with a fudge factor; it depends entirely on the shape of the water.

EVERY DEPTH IN ONE GRAPH -- THIS IS WHAT MAKES IT USEFUL FOR TROLLING

MAR carries NINE NESTED layers: 0, 3, 6, 9, 12, 15, 18, 24 and 30 ft. Layer N is the water a
boat drawing N feet can reach, and each is a strict subset of the one above it. Garmin uses them
to route by draft.

Rather than pick one, this tags every layer-0 cell with **the deepest layer that still contains
it** and ships all of it in one graph. Measured on Wateree's own tile:

    layer 1 ( 3 ft)  3,839 of 6,810 layer-0 cells      56%
    layer 4 (12 ft)    991                             15%
    layer 8 (30 ft)    137                              2%

Monotonic, because the layers nest. Which gives the client two filters off one file:

    MINIMUM DEPTH   keep nodes with depth >= X     "route me over water at least 12 ft"
    DEPTH BAND      keep lo <= depth <= hi         "keep me on the 12-18 ft shelf"

The second is the trolling case, and it falls out for free: a cell in the 12 ft layer but NOT
in the 18 ft layer is between 12 and 18 ft deep. Run Dijkstra over the filtered node set and the
route follows the band instead of merely staying inside it.

Depth is the cell's own value from the mesh, not an interpolation, and it is capped at 30 ft
because that is the deepest layer Garmin ships -- a 60 ft hole reads as 30.

TILE SEAMS

MAR is per-tile and the graph stops at the tile edge. 88 of 1,551 lakes span more than one tile
-- Wateree, Norman, Moultrie, Watts Bar and Walter F George are all 4 -- so the tiles are merged
per lake and cells from DIFFERENT tiles within `--seam-m` of each other are joined.

100 m is inside the mesh's own noise: the median portal edge on layer 0 is 13 m and the longest
is 188 m. Measured on Wateree's four tiles, the meshes approach to 29 m (B4E0F0/B4E0F1) and 66 m
(B4E0DA/B4E0F0); the other three pairs are separate waters that merely share a slug and are
nowhere near each other. Stitching produced 21 joins and grew the Wateree body from 6,201 cells
to 8,204.

THE FILE

`<slug>/water_graph.bin`, little-endian throughout:

    0   char[4]  'TMWG'
    4   u8       format version (2)
    5   u8       base MAR layer index (0)
    6   u16      base layer depth, feet (0)
    8   u32      node count
    12  u32      edge count
    16  node[]   i32 lon_e7, i32 lat_e7        -- degrees x 1e7
    ..  edge[]   u32 a, u32 b                  -- indices into node[]
    ..  depth[]  u8 per node, FEET             -- deepest MAR layer containing this cell

The depth array is last so a reader that only wants geometry can stop after the edges. One byte
per node: 8.7 KB on Wateree's 8,896-cell graph, and it gzips to almost nothing because the
values come from a set of nine.

u32 indices throughout rather than u16-when-it-fits. A merged coastal lake can exceed 65,535
cells, the high bytes are almost all zero, and the uploader gzips on the way to R2 -- so the
simple format costs nothing on the wire and cannot silently overflow.

This writes ONE NEW OBJECT PER LAKE and touches no existing pack file, so it cannot cause a
re-upload of contours or depth areas.
"""
from __future__ import annotations
import argparse, json, math, os, struct, sys, time
from collections import defaultdict

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path: sys.path.insert(0, _HERE)
from build_chartpack import build_mask, _rings          # noqa: E402
from gmapmf_mar_v1 import Mar, depth_polygons           # noqa: E402
from mar_route import build as build_graph, metres      # noqa: E402

MAGIC = b'TMWG'
VERSION = 2
NOTE = "Personal use only, not for distribution or resale; not for navigation."


def load_boundary(registry, slug):
    """Every part of the lake's boundary, not just the first.

    Same rule as `build_all_chartpacks.load_boundary`, and for the same reason: 3DHP splits a
    lake into one Feature per part -- Marion has 4, Barkley 20 -- in no particular order, so
    reading `features[0]` clips against a fragment. Marion's first fragment is 1/3400th of the
    water.
    """
    fp = os.path.join(registry, 'boundaries', slug + '.geojson')
    if not os.path.exists(fp):
        return None
    try:
        gj = json.load(open(fp, encoding='utf-8'))
    except Exception:
        return None
    geoms = ([f.get('geometry') for f in (gj.get('features') or [])]
             if gj.get('type') == 'FeatureCollection'
             else [gj.get('geometry') or gj])
    r = [ring for g in geoms if g for ring in _rings(g)]
    return r or None


def index_tiles(root):
    """tile id -> directory. The card nests Tiles/<xx>/<yy>/<ID>/, and a recursive walk of the
    whole tree is slow enough to time out, so index the three known levels directly."""
    idx = {}
    for a in os.listdir(root):
        pa = os.path.join(root, a)
        if not os.path.isdir(pa): continue
        for b in os.listdir(pa):
            pb = os.path.join(pa, b)
            if not os.path.isdir(pb): continue
            for c in os.listdir(pb):
                if os.path.isdir(os.path.join(pb, c)):
                    idx[c.upper()] = os.path.join(pb, c)
    return idx


def mar_path(tiledir):
    for f in os.listdir(tiledir):
        if f.upper().endswith('.MAR'):
            return os.path.join(tiledir, f)
    return None


def tile_graph(path, layer):
    """One tile's cells, portals, and per-cell depth. -> (centroids, edges, depths_ft)

    The depth of a cell is the deepest MAR layer that still contains it. The layers nest, so
    testing the layer-0 centroids against each deeper layer's dissolved polygon in turn and
    keeping the last hit gives the cell's own depth without interpolating anything.

    Costs about 2.7 s per tile for all eight deeper layers, and the caller caches per tile, so
    a tile shared by six lakes pays once.
    """
    m = Mar(path)
    if layer >= len(m.layers):
        return [], [], []
    cent, g, _rings_, _V, _n = build_graph(m, layer)
    live = [(i, c) for i, c in enumerate(cent) if c is not None]
    remap = {i: k for k, (i, c) in enumerate(live)}
    nodes = [c for _i, c in live]
    edges = set()
    for u in g:
        if u not in remap: continue
        for v, _w, _mid in g[u]:
            if v in remap:
                a, b = remap[u], remap[v]
                if a != b: edges.add((min(a, b), max(a, b)))

    depths = [round(m.layers[layer]['depth'] / 3.048)] * len(nodes)
    try:
        from shapely.geometry import Point
        from shapely.prepared import prep
        pts = [Point(c) for c in nodes]
        for li in range(layer + 1, len(m.layers)):
            ft = round(m.layers[li]['depth'] / 3.048)
            P = prep(depth_polygons(m, li))
            for k, pt in enumerate(pts):
                if P.contains(pt): depths[k] = ft
    except ImportError:
        # Without shapely every cell keeps the base layer's depth, so the graph still routes --
        # it just cannot be filtered by depth. Say so rather than shipping a silent 0.
        print('   !! shapely not installed: depths not resolved, every cell reads %d ft'
              % depths[0] if depths else 0)
    return nodes, sorted(edges), depths


def stitch(nodes, edges, owner, seam_m):
    """Join cells from DIFFERENT tiles that are within seam_m. Returns the number of joins.

    Only cross-tile pairs, because within a tile the ADJ table already states every real
    connection and inventing more would route a boat through a wall.
    """
    if seam_m <= 0: return 0, sorted(set(edges))
    cell = seam_m / 111320.0 * 1.5
    grid = defaultdict(list)
    for i, p in enumerate(nodes):
        grid[(int(p[0] / cell), int(p[1] / cell))].append(i)
    have = {(a, b) for a, b in edges}
    joins = 0
    for i, p in enumerate(nodes):
        gx, gy = int(p[0] / cell), int(p[1] / cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in grid.get((gx + dx, gy + dy), ()):
                    if j <= i or owner[i] == owner[j]: continue
                    if metres(p, nodes[j]) > seam_m: continue
                    k = (i, j)
                    if k in have: continue
                    have.add(k); joins += 1
    return joins, sorted(have)


def write_graph(path, nodes, edges, depths, layer, base_ft):
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
    ap.add_argument('--tiles', required=True, help='the card Tiles root')
    ap.add_argument('--registry', required=True)
    ap.add_argument('--map', required=True, help='tile_lake_map.json')
    ap.add_argument('--out', required=True, help='chartpack root; writes <slug>/water_graph.bin')
    ap.add_argument('--layer', type=int, default=0, help='MAR depth layer (default 0 = 0 ft)')
    ap.add_argument('--seam-m', type=float, default=100.0)
    ap.add_argument('--buffer-m', type=float, default=250.0,
                    help='same shoreline buffer the packs use, so a cell just off the boundary '
                         'is not dropped')
    ap.add_argument('--only-lakes', help='comma list or @file of slugs')
    ap.add_argument('--limit', type=int)
    ap.add_argument('--report', help='write a JSON summary here; DEFAULTS to '
                                     '<registry>/_water_graphs.json')
    a = ap.parse_args()

    # The report used to be opt-in, and on 2026-08-07 a full card rebuild ran without it. The
    # graphs on disk were the new halo ones; the report beside them still held the PRE-halo
    # numbers from six hours earlier, and read as current. A run must never be able to leave a
    # stale report standing for the state it just replaced -- so this defaults rather than asks.
    if not a.report:
        a.report = os.path.join(a.registry, '_water_graphs.json')

    tm = json.load(open(a.map, encoding='utf-8'))
    by_lake = tm['by_lake']
    want = None
    if a.only_lakes:
        src = a.only_lakes
        if src.startswith('@'): src = open(src[1:], encoding='utf-8').read()
        elif os.path.exists(src): src = open(src, encoding='utf-8').read()
        want = {s.strip() for s in src.replace('\n', ',').split(',') if s.strip()}

    idx = index_tiles(a.tiles)
    print('%d tile directories indexed' % len(idx))
    slugs = sorted(s for s in by_lake if want is None or s in want)
    if a.limit: slugs = slugs[:a.limit]
    print('%d lakes' % len(slugs))

    # A tile is read once and reused across every lake that sits on it. Wateree's four tiles
    # are shared with Fishing Creek and the Catawba chain; without this the card's 169 tiles
    # would be decoded several hundred times.
    cache = {}
    bad_tiles = {}
    report = {}
    t0 = time.time()
    made = skipped = 0
    for n, slug in enumerate(slugs, 1):
        rings = load_boundary(a.registry, slug)
        if not rings:
            report[slug] = {'skipped': 'no boundary polygon'}; skipped += 1; continue
        mask = build_mask(rings, a.buffer_m / 111320.0)
        nodes, owner, edges, depths = [], [], [], []
        tiles_used = 0
        halo_added = 0          # cells kept because they bridge, not because they are inside
        for t in by_lake[slug]:
            tid = t.upper()
            tid = tid[1:] if tid[0].isalpha() and len(tid) > 1 else tid
            if tid not in cache:
                d = idx.get(tid)
                p = mar_path(d) if d else None
                # ONE BAD TILE MUST NOT KILL THE RUN. The first card-wide attempt died at
                # `unhandled NODE record size 5` after indexing 2,654 tiles and starting on
                # 1,713 lakes -- every lake before it lost too. A tile that will not decode is
                # a tile without a graph, recorded and skipped.
                try:
                    cache[tid] = tile_graph(p, a.layer) if p else ([], [], [])
                except Exception as exc:
                    cache[tid] = ([], [], [])
                    bad_tiles[tid] = '%s: %s' % (type(exc).__name__, exc)
            tn, te, tdep = cache[tid]
            if not tn: continue
            tiles_used += 1
            # ── ONE-RING HALO ───────────────────────────────────────────────────────────
            #
            # Cells used to be kept only if their centroid landed in `mask.core`, and an edge
            # only if BOTH its endpoints did. That severed the graph at every cell the polygon
            # happened to exclude -- and a cell sitting in the channel between two kept
            # stretches takes the channel with it when it goes.
            #
            # Measured on edisto_river, 2026-08-07: its two tiles hold 7,336 cells and 7,628
            # edges; the graph kept 3,013 nodes and 2,878 edges. Fewer edges than nodes, so it
            # could not be connected whatever the geometry said -- 138 components. Rivers were
            # worst because a river boundary is a ribbon and the routing mesh does not know it
            # exists; coastal worse still, at 70 components median and not one zone connected.
            #
            # So: keep one ring of cells beyond the boundary -- a cell that is ADJACENT to a
            # kept cell, and no further. Those are water Garmin surveyed as navigable, and the
            # polygon is an approximation of the lake, not of the water. Same reasoning as the
            # 250 m buffer on point layers, applied to the one layer where a wrong exclusion
            # severs connectivity instead of merely misplacing a dot.
            #
            # One ring and no more: a cell two rings out is still excluded unless it is itself
            # adjacent to something inside, so this cannot walk into the next water body.
            #
            # This is what restitch_water_graphs.py was compensating for. Its joins came in at
            # a median of 11-20 m -- the MAR cell spacing -- because it was re-deriving by
            # distance guessing the very edges Garmin states outright in ADJ. See
            # WATER_GRAPHS_WERE_SEVERED_BY_THE_CLIP_2026-08-07.md.
            inside = set()
            for i, c in enumerate(tn):
                if mask.cell_of(c[0], c[1]) in mask.core:
                    inside.add(i)
            halo = set()
            if inside:
                for u, v in te:
                    if u in inside and v not in inside:
                        halo.add(v)
                    elif v in inside and u not in inside:
                        halo.add(u)
            keep = {}
            for i in sorted(inside | halo):
                keep[i] = len(nodes)
                nodes.append(tn[i]); owner.append(tid); depths.append(tdep[i])
            halo_added += len(halo)
            for u, v in te:
                if u in keep and v in keep:
                    x, y = keep[u], keep[v]
                    edges.append((min(x, y), max(x, y)))
        if not nodes:
            report[slug] = {'skipped': 'no MAR cells inside the boundary',
                            'tiles': len(by_lake[slug])}
            skipped += 1; continue
        joins, edges = stitch(nodes, edges, owner, a.seam_m)

        # NODES WITH NO EDGES IS NOT A SPARSE GRAPH, IT IS LOOSE POINTS. Every route on it
        # fails. Writing the file makes the Worker load it and then fail anyway; not writing it
        # makes the Worker say "no water graph", which is the truth and is already handled.
        # Seen 2026-08-07 on coast_st_helena_sc (239 nodes / 0 edges) and coast_cape_romain_sc
        # (148 / 0) -- their tiles decode cells but hand back an empty ADJ table, so there is
        # nothing for the halo to bridge. That is a tile problem, not a clip problem.
        if not edges:
            report[slug] = {'skipped': 'nodes but zero edges - unroutable',
                            'nodes': len(nodes), 'edges': 0,
                            'halo': halo_added, 'tiles': tiles_used}
            skipped += 1
            continue

        # THE REAL COMPONENT COUNT, not the arithmetic lower bound. edges < nodes-1 PROVES
        # disconnection and can never prove connection -- wateree_lake passed that test while
        # carrying 844 orphan nodes, which is how the 2026-08-06 diagnosis went wrong. Union-
        # find is cheap and it is the number that decides whether trolling runs can be built
        # on this water, so compute it rather than leaving the next reader to infer it.
        parent = list(range(len(nodes)))

        def _find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for _u, _v in edges:
            ru, rv = _find(_u), _find(_v)
            if ru != rv:
                parent[ru] = rv
        sizes = defaultdict(int)
        for i in range(len(nodes)):
            sizes[_find(i)] += 1
        biggest = max(sizes.values())

        outdir = os.path.join(a.out, slug)
        os.makedirs(outdir, exist_ok=True)
        size = write_graph(os.path.join(outdir, 'water_graph.bin'),
                           nodes, edges, depths, a.layer, min(depths) if depths else 0)
        # How much of the lake survives each depth filter -- the number that says whether a
        # 12 ft trolling route is even possible on this water before anyone tries to plan one.
        hist = {}
        for ft in (0, 3, 6, 9, 12, 15, 18, 24, 30):
            n_at = sum(1 for d in depths if d >= ft)
            if n_at: hist[ft] = n_at
        # `halo` and `components` are recorded so the next person can check this without
        # decoding anything: edges < nodes-1 means disconnected, whatever the geometry says.
        report[slug] = {'nodes': len(nodes), 'edges': len(edges), 'seam_joins': joins,
                        'halo': halo_added, 'tiles': tiles_used, 'bytes': size,
                        'min_edges_for_connected': max(len(nodes) - 1, 0),
                        'components': len(sizes),
                        'largest_component_pct': round(100.0 * biggest / len(nodes), 1),
                        'orphan_nodes': len(nodes) - biggest,
                        'cells_at_depth_ft': hist}
        made += 1
        if n % 25 == 0 or n == len(slugs):
            print('  %d/%d  %d written, %d skipped, %.1f min'
                  % (n, len(slugs), made, skipped, (time.time() - t0) / 60), flush=True)

    print('\n%d graphs written, %d skipped, %.1f min' % (made, skipped, (time.time() - t0) / 60))
    if made:
        tot = sum(r.get('bytes', 0) for r in report.values())
        nn = sum(r.get('nodes', 0) for r in report.values())
        print('   %d nodes total, %.1f MB on disk, %.0f KB median'
              % (nn, tot / 1e6,
                 sorted(r['bytes'] for r in report.values() if 'bytes' in r)[made // 2] / 1024))
        multi = [r for r in report.values() if r.get('seam_joins')]
        print('   %d lakes needed seam joins, %d joins total'
              % (len(multi), sum(r['seam_joins'] for r in multi)))
        # Connectivity, stated plainly, because this is the gate on build_trolling_runs.py.
        conn = [r for r in report.values() if 'components' in r]
        whole = [r for r in conn if r['components'] == 1]
        orph = sum(r['orphan_nodes'] for r in conn)
        print('   %d of %d graphs are a single component; %d orphan nodes (%.2f%%) card-wide'
              % (len(whole), len(conn), orph, 100.0 * orph / max(nn, 1)))
        worst = sorted(conn, key=lambda r: -r['orphan_nodes'])[:8]
        if worst and worst[0]['orphan_nodes']:
            print('   most fragmented:')
            for slug_, r in sorted(((s, r) for s, r in report.items() if 'components' in r),
                                   key=lambda kv: -kv[1]['orphan_nodes'])[:8]:
                print('      %-30s %5d comps, largest holds %5.1f%%, %d orphans'
                      % (slug_, r['components'], r['largest_component_pct'], r['orphan_nodes']))
    why = defaultdict(int)
    for r in report.values():
        if r.get('skipped'): why[r['skipped']] += 1
    for k, v in why.items(): print('   skipped, %s: %d' % (k, v))
    if bad_tiles:
        print('   %d tile(s) failed to decode:' % len(bad_tiles))
        for t, e in list(bad_tiles.items())[:10]: print('      %-8s %s' % (t, e[:90]))
    if a.report:
        json.dump({'generatedBy': 'build_water_graphs.py', 'layer': a.layer,
                   'seamM': a.seam_m, 'note': NOTE, 'badTiles': bad_tiles, 'lakes': report},
                  open(a.report, 'w', encoding='utf-8'), indent=1)
        print('-> %s' % a.report)


if __name__ == '__main__':
    main()
