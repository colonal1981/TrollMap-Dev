#!/usr/bin/env python3
"""A feature that spans the water without a vertex in it is still in the water.

2026-09-20. `build_all_chartpacks` drops contours and depth areas that are not in the lake
itself -- only the collar -- and the test was `any(mask.cell_of(x, y) in mask.core for x, y in
verts(f))`. A vertex test cannot see a feature that crosses the water without landing in it,
and on a river that is the ordinary shape: Garmin cuts its bands at subdivision seams, so a
band lying across a channel narrower than the seam spacing has its corners on both banks and
nothing in between.

Measured on the Congaree against the shipped pack:

    depth areas touching boundary + 250 m       4,748
      at least one vertex inside the boundary   3,886    7,407.2 acres
      NO vertex inside, dropped whole             862      249.8 acres

and the dropped list opens 17.55 acres of 5-6 ft, 8.82 of 6-7, 6.44 of 6-7, 5.86 of 4-5.
Ryan saw it as the basemap showing through mid-river: "a chunk of river is missing from our
extraction... it happens in multiple places in this pack".

THE RULE ITSELF IS UNCHANGED AND IS ASSERTED HERE. Wateree is 49 km2 of water with a 257 km
shoreline, so a 250 m collar adds ~64 km2 of land and the pack was shipping 1,234 depth areas
sitting entirely on it. A feature that does not touch the water still dies -- no vertex in it,
no edge crossing it, and not enclosing it. What changed is that "in the water" stopped meaning
"has a corner there".

Synthetic, so the shapes are known exactly rather than argued about.
"""
import importlib.util, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_chartpack import LakeMask, touches_core, verts

FAIL = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        FAIL.append(msg)


def poly(pts):
    r = list(pts)
    if r[0] != r[-1]:
        r.append(r[0])
    return {'type': 'Polygon', 'coordinates': [r]}


def line(pts):
    return {'type': 'LineString', 'coordinates': list(pts)}


def old_test(g, mask):
    """The test this replaces, kept so the difference is measured and not asserted."""
    return any(mask.cell_of(x, y) in mask.core for x, y in verts(g))


def main():
    # A channel 0.0006 deg wide -- about 55 m, narrower than the 250 m collar and wider than
    # the 22 m cell, which is the Congaree at the bends.
    W, E = -80.6600, -80.6400
    S, N = 33.7670, 33.7676
    # CLOSED: the scanline fill walks consecutive pairs, so an unclosed ring loses its last
    # edge, every row sees one crossing instead of two and the fill produces nothing.
    chan = [(W, S), (E, S), (E, N), (W, N), (W, S)]
    deg = 250 / 111320.0
    mask = LakeMask([chan], deg)
    print('--- the shape that was being dropped ---')
    # A band lying ACROSS the channel: corners on both banks, no vertex in the water.
    across = poly([(-80.6500, S - 0.0004), (-80.6480, S - 0.0004),
                   (-80.6480, N + 0.0004), (-80.6500, N + 0.0004)])
    check(not old_test(across, mask), 'the old vertex test does NOT see a band across the channel')
    check(touches_core(across, mask), 'touches_core DOES see it -- its edges cross the water')

    crossing = line([(-80.6500, S - 0.0004), (-80.6500, N + 0.0004)])
    check(not old_test(crossing, mask), 'the old test does not see a contour crossing the channel')
    check(touches_core(crossing, mask), 'touches_core sees the crossing contour')

    print('\n--- and the shape the rule exists to drop still dies ---')
    inland = poly([(-80.6500, N + 0.0012), (-80.6480, N + 0.0012),
                   (-80.6480, N + 0.0018), (-80.6500, N + 0.0018)])
    check(not old_test(inland, mask), 'the old test drops a band sitting in the collar')
    check(not touches_core(inland, mask),
          'touches_core drops it too -- this is the Wateree fix, 1,234 depth areas on dry land')
    inland_line = line([(-80.6520, N + 0.0014), (-80.6460, N + 0.0014)])
    check(not touches_core(inland_line, mask), 'a contour running along the collar still dies')

    print('\n--- the easy cases are unchanged ---')
    inside = poly([(-80.6500, 33.7672), (-80.6480, 33.7672),
                   (-80.6480, 33.7674), (-80.6500, 33.7674)])
    check(old_test(inside, mask) and touches_core(inside, mask),
          'a band wholly inside the water is kept by both')
    far = poly([(-80.5000, 33.9000), (-80.4980, 33.9000),
                (-80.4980, 33.9020), (-80.5000, 33.9020)])
    check(not old_test(far, mask) and not touches_core(far, mask),
          'a band in the next county is dropped by both')

    print('\n--- enclosure: the failure a box test is the only thing that catches ---')
    swallow = poly([(-80.7000, 33.7000), (-80.6000, 33.7000),
                    (-80.6000, 33.8000), (-80.7000, 33.8000)])
    check(not old_test(swallow, mask), 'the old test cannot see a polygon that ENCLOSES the water')
    check(touches_core(swallow, mask), 'touches_core sees it')

    print('\n--- an interior ring counts as touching ---')
    # Outer ring far away, hole punched right over the channel: `verts()` returns the outer
    # ring only, so the feature has to be read through every ring.
    donut = {'type': 'Polygon', 'coordinates': [
        [(-80.7000, 33.7000), (-80.6000, 33.7000), (-80.6000, 33.8000),
         (-80.7000, 33.8000), (-80.7000, 33.7000)],
        [(-80.6520, 33.7671), (-80.6500, 33.7671), (-80.6500, 33.7675),
         (-80.6520, 33.7675), (-80.6520, 33.7671)]]}
    check(touches_core(donut, mask), 'a band drawn round an island is kept by its interior ring')

    print('\n--- no mask, no opinion ---')
    class Bare:
        core = None
        cell = 0.0002
        w = s = 0.0
        def cell_of(self, x, y): return (0, 0)
    check(touches_core(inside, Bare()), 'with no core there is nothing to be outside of')

    print('\n%s  %d failure(s)' % ('FAILED' if FAIL else 'ALL PASS', len(FAIL)))
    for f in FAIL:
        print('   - ' + f)
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
