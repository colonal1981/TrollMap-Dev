#!/usr/bin/env python3
r"""
apply_drawn_coast.py — ONE line down the coast, applied to every zone.

Personal use only, not for distribution or resale; not for navigation.

WHY THIS AND NOT THE PINCH
--------------------------
2026-08-09. `coastal_pinch.py` tried to find the open Atlantic from the shape of the bathymetry
alone -- erode the water, and whatever survives as the biggest connected piece is the sea. Three
variants were tried and each fixed two zones while inverting two others:

    largest piece           right on ACE Basin; wrong on Albemarle and Pamlico, which hold no
                            Atlantic at all, so the biggest water in the box IS the sound
    flood from a named edge  fixed the Outer Banks, needs a compass the zones do not agree on
    largest KEPT piece      inverted Brunswick and Winyah Bay outright, cutting inland water

    Ryan: "this isn't working your cutter has no idea what ocean is vs inland"

Structural, not a tuning problem: connectivity of the soundings carries no information about
which side the land is on.

AND WHY ONE LINE RATHER THAN 22
-------------------------------
    Ryan: "i dont want to do it by zone... that is dumb... that means i have to draw 22 lines...
    i just want to draw a line down the freaking coast of the eastern us"

Right. The coastline is one continuous thing; the zone rectangles are boxes drawn around it. So
the line is drawn once, from the Outer Banks to the Georgia line, with one click to say which
side is sea -- and every zone is clipped against the same line. Zones the line never reaches keep
their rectangles.

HOW A CELL IS DECIDED
---------------------
No flooding and no seeding. For each grid cell, find the nearest segment of the drawn line and
take the sign of the cross product: that is which side of the coast it lies on. Cells on the sea
side are ocean, the rest is the new boundary. A polyline divides the plane, so there is nothing
left to guess and nothing that can inverted -- the side clicked is the side that goes.

    py scripts\apply_drawn_coast.py --registry F:\TrollMapPipeline\registry `
                                    --lines  C:\Users\Ryan\Downloads\coastline.json

DRY RUN BY DEFAULT. --go writes, and the rectangles move to registry/_coastal_rect_originals/
rather than being deleted, because a boundary is recoverable and a deletion is not.

AFTER: re-cut those zones with build_all_chartpacks.py --only-lakes, then upload.
"""
from __future__ import annotations
import argparse, importlib.util, json, math, os, sys


def load_pinch(scripts_dir):
    """Reuse the grid, trace and boundary-writing helpers rather than restating them."""
    spec = importlib.util.spec_from_file_location(
        'cp', os.path.join(scripts_dir, 'coastal_pinch.py'))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def side_field(line_px, W, H, np):
    """For every cell, which side of the polyline it is on. +1 / -1.

    Nearest-segment, then the sign of the cross product against that segment. Vectorised one
    segment at a time: a few hundred passes over the grid, which is nothing, and it avoids the
    per-cell python loop that would make this take minutes on Pamlico.
    """
    ys, xs = np.mgrid[0:H, 0:W]
    xs = xs.astype(np.float32); ys = ys.astype(np.float32)
    best = np.full((H, W), np.inf, dtype=np.float32)
    sign = np.ones((H, W), dtype=np.int8)
    for (x1, y1), (x2, y2) in zip(line_px[:-1], line_px[1:]):
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy
        if L2 == 0:
            continue
        t = ((xs - x1) * dx + (ys - y1) * dy) / L2
        t = np.clip(t, 0.0, 1.0)
        px = x1 + t * dx
        py = y1 + t * dy
        d = (xs - px) ** 2 + (ys - py) ** 2
        cross = (xs - x1) * dy - (ys - y1) * dx
        closer = d < best
        best = np.where(closer, d, best)
        sign = np.where(closer, np.where(cross >= 0, 1, -1).astype(np.int8), sign)
    return sign


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--lines', help='coastline.json from the draw tool. Defaults to the one '
                                    'committed at <registry>/coastline.json -- the coast does '
                                    'not move, so it should not need drawing twice.')
    ap.add_argument('--cell-m', type=float, default=100.0)
    ap.add_argument('--only', help='comma list of zone slugs; default is every coastal zone')
    ap.add_argument('--go', action='store_true', help='write. Default is a dry run.')
    a = ap.parse_args()

    import numpy as np
    cp = load_pinch(os.path.dirname(os.path.abspath(__file__)))

    lines_fp = a.lines or os.path.join(a.registry, 'coastline.json')
    doc = json.load(open(lines_fp, encoding='utf-8'))
    line = doc.get('line') or []
    ocean = doc.get('ocean')
    if len(line) < 2 or not ocean:
        sys.exit('%s needs a line of 2+ points and an ocean point' % a.lines)
    print('coastline: %d points, %.3f %.3f to %.3f %.3f'
          % (len(line), line[0][0], line[0][1], line[-1][0], line[-1][1]))
    print('  from %s' % lines_fp)

    bdir = os.path.join(a.registry, 'boundaries')
    want = {x.strip() for x in (a.only or '').split(',') if x.strip()}
    slugs = sorted(n[:-8] for n in os.listdir(bdir)
                   if n.startswith('coast_') and n.endswith('.geojson'))
    if want:
        slugs = [s for s in slugs if s in want]

    print()
    print('%-32s %10s %10s %9s  %s' % ('zone', 'box km2', 'inshore', 'removed', 'landings'))
    wrote = skipped = 0
    for slug in slugs:
        bfp = os.path.join(bdir, '%s.geojson' % slug)
        rect = cp.boundary_bbox(bfp)
        if not rect:
            continue
        w, s, e, n = rect
        # Only zones the line actually passes near are touched. Everything else keeps its
        # rectangle, so drawing half the coast and finishing later is safe.
        if not any(w - 0.15 <= q[0] <= e + 0.15 and s - 0.15 <= q[1] <= n + 0.15 for q in line):
            skipped += 1
            continue

        lat0 = (s + n) / 2.0
        sx = 111320.0 * math.cos(math.radians(lat0)) / a.cell_m
        sy = 110574.0 / a.cell_m
        W = int((e - w) * sx) + 3
        H = int((n - s) * sy) + 3
        wg = {'x0': w, 'y0': s, 'sx': sx, 'sy': sy, 'cell': a.cell_m,
              'water': np.zeros((H, W), dtype=bool)}
        zone = cp.rasterise_boundary(bfp, wg)
        if zone is None:
            print('  %-30s skipped -- boundary would not rasterise' % slug)
            continue

        px = [((q[0] - w) * sx, (q[1] - s) * sy) for q in line]
        sign = side_field(px, W, H, np)
        ox = (ocean[0] - w) * sx
        oy = (ocean[1] - s) * sy
        # Which sign is the sea? Decided once, from the single ocean point, in the same
        # coordinate frame -- so every zone inherits the same answer and none can flip.
        osx, osy = float(ox), float(oy)
        sea_sign = None
        for (x1, y1), (x2, y2) in zip(px[:-1], px[1:]):
            dx, dy = x2 - x1, y2 - y1
            L2 = dx * dx + dy * dy
            if L2 == 0:
                continue
            t = max(0.0, min(1.0, ((osx - x1) * dx + (osy - y1) * dy) / L2))
            d = (osx - (x1 + t * dx)) ** 2 + (osy - (y1 + t * dy)) ** 2
            cr = (osx - x1) * dy - (osy - y1) * dx
            if sea_sign is None or d < sea_sign[0]:
                sea_sign = (d, 1 if cr >= 0 else -1)
        sea = zone & (sign == sea_sign[1])
        keep = zone & ~sea
        if not keep.any():
            print('  %-30s REFUSED -- the line would remove the whole zone' % slug)
            continue

        parts = cp.trace_keep(keep, wg, 2)
        if not parts:
            print('  %-30s skipped -- nothing traceable after the cut' % slug)
            continue
        cp.write_boundary(a.registry, slug, parts, None, dry=not a.go)
        wrote += 1
        km2 = lambda m: int(m.sum()) * a.cell_m * a.cell_m / 1e6
        print('  %-30s %10.0f %10.0f %8.0f%%' % (slug, km2(zone), km2(keep),
                                                 100.0 * (1 - keep.sum() / max(zone.sum(), 1))))

    print()
    print('%d zone(s) touched, %d left alone because the line does not reach them'
          % (wrote, skipped))
    if a.go:
        print('rectangles moved to %s' % os.path.join(a.registry, '_coastal_rect_originals'))
        print('NOW re-cut those zones with build_all_chartpacks.py --only-lakes, then upload.')
    else:
        print('DRY RUN. Re-run with --go to write.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
