"""test_under_motor_m.py -- the metres of a landing's route his motor cannot run in.

Personal use only, not for distribution or resale; not for navigation.

    py .\\Scripts\\test_under_motor_m.py

build_ramp_reach.py writes `under_motor_m` on every landing: the metres of the DRAWN route in
water the chart puts shallower than MOTOR_DRAFT_FT. The chart's bands are whole feet and the file
reads a band's shallow edge, so with the motor at one foot the `0-1 ft` band is under it and the
`1-2 ft` band is not. These cases pin that, on synthetic water where the answer is known.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import build_ramp_reach as B                     # noqa: E402
from shapely.geometry import box                 # noqa: E402

FAILS = []


def check(name, got, want, tol):
    ok = abs(got - want) <= tol
    print('%s %-60s got %8.1f want %8.1f' % ('ok  ' if ok else 'FAIL', name, got, want))
    if not ok:
        FAILS.append(name)


# A strip of water 0.01 deg long (about 912 m at 33.5 N) running east, in three bands:
#   west third   '0-1 ft'  -> shallow edge 0
#   middle third '1-2 ft'  -> shallow edge 1
#   east third   '5-6 ft'  -> shallow edge 5
LAT = 33.5
W, E = -80.50, -80.49
third = (E - W) / 3.0
polys = [box(W, LAT - 0.001, W + third, LAT + 0.001),
         box(W + third, LAT - 0.001, W + 2 * third, LAT + 0.001),
         box(W + 2 * third, LAT - 0.001, E, LAT + 0.001)]
depths = [0.0, 1.0, 5.0]
route = [[W + 1e-6, LAT], [E - 1e-6, LAT]]
total = B.polyline_m(route)
motor = [g for g, ft in zip(polys, depths) if ft and ft >= B.MOTOR_DRAFT_FT]

check('the motor draft is the one foot he gave', B.MOTOR_DRAFT_FT, 1.0, 0.0)
check('the 0-1 ft third is under his motor, and only it',
      B.shoal_m(route, motor), total / 3.0, 12.0)
five = [g for g, ft in zip(polys, depths) if ft and ft >= 5.0]
check('against a deeper floor the 1-2 ft third counts too -- a floor is not a draft',
      B.shoal_m(route, five), 2.0 * total / 3.0, 12.0)
all_deep = [box(W, LAT - 0.001, E, LAT + 0.001)]
check('a route wholly in water his motor runs in reads zero',
      B.shoal_m(route, all_deep), 0.0, 1.0)

src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build_ramp_reach.py'),
           encoding='utf-8').read()
check("the record carries under_motor_m, measured on the DRAWN route",
      float("'under_motor_m': (None if not motor_polys or not route" in src
            and 'shoal_m(route, motor_polys)' in src), 1.0, 0.0)
check("and no longer writes shoal_m, which nothing read",
      float("'shoal_m':" in src), 0.0, 0.0)

print('\n%d failed' % len(FAILS))
sys.exit(1 if FAILS else 0)
