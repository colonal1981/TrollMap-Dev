#!/usr/bin/env python3
"""close_keep_out_in_graph.py - the water graph does not route through a keep-out zone.

Personal use only, not for distribution or resale; not for navigation.

    py .\\close_keep_out_in_graph.py --packs "F:\\TrollMapPipeline\\chartpack" --dry-run
    py .\\close_keep_out_in_graph.py --packs "F:\\TrollMapPipeline\\chartpack" --only lake_moultrie

Rewrites `<slug>/water_graph.bin` in place for every pack with a `keep_out.geojson`, moving the
original to `<packs>/../_to_delete/pre_keep_out_graph/<slug>/` first (never over an earlier copy).

WHY

`build_keep_out_zones.py` draws the water behind a dam's buoys and behind a line the chart names
keep-out, and `fit_trolling_runs.KeepOut` cuts the lanes at it. The lanes are only half of what a plan
draws: every run with lines up, and every join between two lanes, follows the water graph -- the
Worker's /route and the browser's own search in js/utils/water-graph.js both read this file. Ryan,
2026-10-03: *"I just don't want it inside of them"*. So the graph is closed there too.

WHAT CHANGES, AND WHAT DOES NOT. Every edge with an end inside a zone, and every edge whose segment
crosses into one, is removed. NO NODE IS REMOVED OR RENUMBERED: the trolling runs carry `reach_node`
indexes into this file, and a node inside a zone is simply left with no edges. Depth bytes, the
header and the format are unchanged, so nothing that reads the graph learns anything happened.
A second run finds nothing left to remove.
"""
import argparse, json, os, struct, sys, time

try:
    from shapely.geometry import shape, Point, LineString
    from shapely.ops import unary_union
    from shapely.prepared import prep
    from shapely.strtree import STRtree
    from shapely.validation import make_valid
except Exception:                                        # pragma: no cover
    sys.exit('close_keep_out_in_graph.py needs shapely (py -m pip install shapely)')

MAGIC = b'TMWG'


def read(path):
    b = open(path, 'rb').read()
    if b[:4] != MAGIC:
        return None
    ver, layer, base, nn, ne = struct.unpack_from('<BBHII', b, 4)
    off = 16
    nodes = [(x / 1e7, y / 1e7) for x, y in struct.iter_unpack('<ii', b[off:off + nn * 8])]
    off += nn * 8
    edges = list(struct.iter_unpack('<II', b[off:off + ne * 8]))
    off += ne * 8
    depths = b[off:off + nn]
    return {'ver': ver, 'layer': layer, 'base': base, 'nodes': nodes, 'edges': edges, 'depths': depths,
            'tail': b[off + nn:]}


def write(path, g):
    with open(path, 'wb') as f:
        f.write(MAGIC)
        f.write(struct.pack('<BBHII', g['ver'], g['layer'], g['base'], len(g['nodes']), len(g['edges'])))
        f.write(b''.join(struct.pack('<ii', round(x * 1e7), round(y * 1e7)) for x, y in g['nodes']))
        f.write(b''.join(struct.pack('<II', a, b) for a, b in g['edges']))
        f.write(g['depths'])
        f.write(g['tail'])


def zones_of(pack):
    p = os.path.join(pack, 'keep_out.geojson')
    if not os.path.isfile(p):
        return []
    out = []
    for f in json.load(open(p, 'r', encoding='utf-8')).get('features') or []:
        g = f.get('geometry') or {}
        if g.get('type') in ('Polygon', 'MultiPolygon', 'LineString'):
            out.append(make_valid(shape(g)))
    return out


def close(g, zones):
    """Remove the edges that enter a zone. Returns (kept edges, isolated node count, removed count)."""
    areas = [z for z in zones if z.geom_type != 'LineString']
    lines = [z for z in zones if z.geom_type == 'LineString']
    area = prep(unary_union(areas)) if areas else None
    bounds = unary_union(zones).bounds if zones else None
    nodes = g['nodes']
    inside = set()
    if area is not None:
        x0, y0, x1, y1 = bounds
        for i, (x, y) in enumerate(nodes):
            if x0 <= x <= x1 and y0 <= y <= y1 and area.intersects(Point(x, y)):
                inside.add(i)
    whole = unary_union(zones)
    x0, y0, x1, y1 = whole.bounds
    kept, removed = [], 0
    for a, b in g['edges']:
        if a in inside or b in inside:
            removed += 1
            continue
        (ax, ay), (bx, by) = nodes[a], nodes[b]
        if max(ax, bx) < x0 or min(ax, bx) > x1 or max(ay, by) < y0 or min(ay, by) > y1:
            kept.append((a, b))
            continue
        seg = LineString([(ax, ay), (bx, by)])
        if (area is not None and area.intersects(seg)) or any(seg.crosses(l) for l in lines):
            removed += 1
            continue
        kept.append((a, b))
    return kept, len(inside), removed


def backup(packs, slug, path):
    bak = os.path.join(os.path.dirname(os.path.abspath(packs)), '_to_delete', 'pre_keep_out_graph', slug)
    os.makedirs(bak, exist_ok=True)
    dest = os.path.join(bak, 'water_graph.bin')
    n = 2
    while os.path.exists(dest):
        dest = os.path.join(bak, 'water_graph.bin.%d' % n)
        n += 1
    os.replace(path, dest)
    return dest


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--packs', required=True)
    ap.add_argument('--only', default=None, help='one slug, or several joined by commas')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args(argv)
    slugs = (a.only.split(',') if a.only else
             sorted(d for d in os.listdir(a.packs) if os.path.isfile(os.path.join(a.packs, d, 'keep_out.geojson'))))
    t0 = time.time()
    changed = []
    for slug in slugs:
        pack = os.path.join(a.packs, slug)
        gpath = os.path.join(pack, 'water_graph.bin')
        zones = zones_of(pack)
        if not zones or not os.path.isfile(gpath):
            continue
        g = read(gpath)
        if g is None:
            print('  %-40s water_graph.bin is not a TMWG graph -- left alone' % slug)
            continue
        kept, n_in, removed = close(g, zones)
        if not removed:
            continue
        changed.append(slug)
        print('  %-40s %d zone(s): %d nodes inside left without edges, %d of %d edges removed'
              % (slug, len(zones), n_in, removed, len(g['edges'])))
        if not a.dry_run:
            backup(a.packs, slug, gpath)
            g['edges'] = kept
            tmp = gpath + '.tmp'
            write(tmp, g)
            os.replace(tmp, gpath)
    print('%d graphs closed at their zones, %.0fs%s' % (len(changed), time.time() - t0,
                                                      ' (dry run, nothing written)' if a.dry_run else ''))
    if changed and not a.dry_run:
        print('changed: ' + ','.join(changed))
    return 0


if __name__ == '__main__':
    sys.exit(main())
