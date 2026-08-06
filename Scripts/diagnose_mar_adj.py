#!/usr/bin/env python3
r"""diagnose_mar_adj.py - why does a water graph have more components than it should?

    py .\scripts\diagnose_mar_adj.py --tiles "F:\TrollMapPipeline\garmin\charts\Tiles" `
       --registry "F:\TrollMapPipeline\registry" --lake edisto_river

Written 2026-08-07. Reads nothing, writes nothing, decodes a few MAR files and counts.

WHY

`restitch_water_graphs.py` was asked to repair severed graphs and produced 10,066 joins for an
8.5% improvement, with every join pressed against whatever --max-m it was given. That is the
signature of a limit standing in for a missing fact rather than describing a real one.

The report says why, without any decoding at all:

    edisto_river    3,013 nodes   2,878 edges   2 seam joins   138 components
    buffalo_river   2,617 nodes   2,340 edges   4 seam joins   282 components

A connected graph on n nodes needs at least n-1 edges. Edisto has 135 fewer than that, so it is
disconnected by arithmetic, before any geometry is considered. Both are 2-tile lakes, so
cross-tile seams cannot explain it. The ADJ table -- Garmin's own statement of which water cells
connect -- is being under-read, and `stitch()` is deliberately blind to it because it only joins
across tiles, on the assumption that "within a tile the ADJ table already states every real
connection". That assumption is the thing to test.

`mar_route.build()` drops an ADJ record on three conditions:

    if na >= len(cent) or nb >= len(cent): continue     # node index past the ring table
    if cent[na] is None or cent[nb] is None: continue   # a cell with no usable ring
    if va not in V or vb not in V: continue             # portal VERTEX missing

The third is the suspicious one. `va`/`vb` are used only to compute `mid`, the portal midpoint,
which is decoration -- the connection between cell A and cell B does not stop existing because
we cannot draw a dot on the boundary between them. If that branch is where the edges go, the fix
is to keep the edge and let `mid` be None.

The second is a real severance too: discarding a cell also discards every edge through it, so a
dead cell in a channel cuts the channel. Contracting it -- joining its neighbours to each other
-- preserves connectivity through water Garmin says is water.

This script says which of the three it actually is. Run it before changing anything.
"""
import argparse
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)


# Tile resolution is NOT reimplemented here. build_water_graphs.py already does it and the
# first version of this script got it wrong twice over: it walked the tree looking for a
# directory named after the full tile id, when the map hands out `B4E0F8`, the directory is
# `4E0F8` (the layer letter is stripped -- B is the B-tile family, the mesh lives in G<id>.MAR
# beside it), and a recursive walk of that tree is slow enough to time out anyway. Import the
# resolver that is already right instead of writing a third one.
from build_water_graphs import index_tiles, mar_path      # noqa: E402


def strip_layer_letter(tid):
    """`B4E0F8` -> `4E0F8`, matching build_water_graphs.py line 294."""
    t = str(tid).upper()
    return t[1:] if t and t[0].isalpha() and len(t) > 1 else t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tiles', required=True)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--lake', default='edisto_river')
    ap.add_argument('--layer', type=int, default=0)
    ap.add_argument('--max-tiles', type=int, default=3)
    a = ap.parse_args()

    from gmapmf_mar_v1 import Mar, layer_vertices, cell_rings, node_tables

    tm = json.load(open(os.path.join(a.registry, 'tile_lake_map.json'), encoding='utf-8'))
    by = tm.get('by_lake', tm)
    tids = by.get(a.lake) or []
    if not tids:
        sys.exit('%s has no tiles in tile_lake_map.json' % a.lake)
    print('%s: %d tile(s) %s' % (a.lake, len(tids), tids[:6]))
    idx = index_tiles(a.tiles)
    print('tile index: %d directories under %s' % (len(idx), a.tiles))

    grand = dict(adj=0, kept=0, d_range=0, d_cell=0, d_vtx=0,
                 cells=0, dead=0, nodes=0)
    for tid in tids[:a.max_tiles]:
        key = strip_layer_letter(tid)
        d = idx.get(key)
        p = mar_path(d) if d else None
        if not p:
            print('  %s -> %s: %s' % (tid, key,
                                      'no directory in the index' if not d
                                      else 'directory found but no .MAR in it'))
            continue
        m = Mar(p)
        if a.layer >= len(m.layers):
            print('  %s: no layer %d' % (tid, a.layer))
            continue
        V = layer_vertices(m, a.layer)
        rings = cell_rings(m, a.layer)
        _N, A, B = node_tables(m, a.layer)

        cent = []
        for r in rings:
            if not r:
                cent.append(None)
                continue
            pts = [V[x][:2] for x in r if x in V]
            cent.append((sum(q[0] for q in pts) / len(pts),
                         sum(q[1] for q in pts) / len(pts)) if pts else None)

        d_range = d_cell = d_vtx = kept = 0
        # What WOULD survive if the midpoint stopped being a requirement?
        kept_if_vtx_optional = 0
        for (na, nb, va, vb) in A:
            if na >= len(cent) or nb >= len(cent):
                d_range += 1
                continue
            if cent[na] is None or cent[nb] is None:
                d_cell += 1
                continue
            kept_if_vtx_optional += 1
            if va not in V or vb not in V:
                d_vtx += 1
                continue
            kept += 1

        dead = sum(1 for c in cent if c is None)
        print('\n  tile %s  (%s)' % (tid, os.path.basename(p)))
        print('    cells %6d   dead cells %6d   vertices %7d   ADJ %7d   B-table %s'
              % (len(rings), dead, len(V), len(A),
                 (len(B) if B is not None else 'None')))
        print('    ADJ kept                    %7d  (%.1f%%)'
              % (kept, 100.0 * kept / max(len(A), 1)))
        print('    dropped: node index range   %7d' % d_range)
        print('    dropped: dead cell          %7d' % d_cell)
        print('    dropped: MISSING VERTEX     %7d   <- midpoint only' % d_vtx)
        print('    would keep if vtx optional  %7d  (%.1f%%)'
              % (kept_if_vtx_optional,
                 100.0 * kept_if_vtx_optional / max(len(A), 1)))
        # n-1 is the floor for connectivity. Say whether each version clears it.
        n_live = len(rings) - dead
        print('    live cells %d -> needs >= %d edges to be connectable' % (n_live, n_live - 1))
        print('       as built:            %s'
              % ('OK' if kept >= n_live - 1 else 'SHORT by %d' % (n_live - 1 - kept)))
        print('       with vtx optional:   %s'
              % ('OK' if kept_if_vtx_optional >= n_live - 1
                 else 'SHORT by %d' % (n_live - 1 - kept_if_vtx_optional)))

        grand['adj'] += len(A); grand['kept'] += kept
        grand['d_range'] += d_range; grand['d_cell'] += d_cell; grand['d_vtx'] += d_vtx
        grand['cells'] += len(rings); grand['dead'] += dead
        grand['nodes'] += n_live

    print('\n  ── totals ──────────────────────────────────────────')
    print('  ADJ records            %8d' % grand['adj'])
    print('  kept                   %8d  (%.1f%%)'
          % (grand['kept'], 100.0 * grand['kept'] / max(grand['adj'], 1)))
    print('  lost to missing vertex %8d  (%.1f%%)'
          % (grand['d_vtx'], 100.0 * grand['d_vtx'] / max(grand['adj'], 1)))
    print('  lost to dead cells     %8d' % grand['d_cell'])
    print('  lost to index range    %8d' % grand['d_range'])
    print('  dead cells             %8d of %d' % (grand['dead'], grand['cells']))
    print('\n  If "lost to missing vertex" is the big number, the fix is one line in')
    print('  mar_route.build(): keep the edge, let mid be None. If "dead cells" is,')
    print('  the fix is to contract them rather than discard them. If neither, the')
    print('  ADJ table itself is being read short and that is a decoder question.')


if __name__ == '__main__':
    main()
