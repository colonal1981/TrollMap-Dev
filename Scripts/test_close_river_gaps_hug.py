"""A lake's own edge is not a river's gap. Personal use only, not for distribution or resale; not for navigation.

    py .\\test_close_river_gaps_hug.py
"""
import math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shapely.geometry import box
from close_river_gaps import outline_tree, hug_share, HUG_SHARE, M

LAT = 35.74                      # Lake James
K = math.cos(math.radians(LAT))
def m(x, y): return x / (M * K), LAT + y / 110540.0
def rect(x0, y0, x1, y1):
    (a, b), (c, d) = m(x0, y0), m(x1, y1)
    return box(a, b, c, d)

LAKE = rect(0, 0, 2000, 1000)
WIN = rect(-5000, -5000, 5000, 5000)
T = outline_tree([LAKE], WIN)


def test_a_sliver_along_the_shore_is_the_lakes():
    # 400 m of chart 15 m wide, lying just outside the lake's outline: both long sides within a few metres of it.
    assert hug_share(rect(500, 1002, 900, 1017), T, K) >= HUG_SHARE


def test_a_hole_inside_the_lake_is_the_lakes():
    # The strip down the middle of Norris: nothing but lake on every side, 10 m in from the outline.
    lake_with_hole = LAKE.difference(rect(800, 400, 1200, 418))
    t = outline_tree([lake_with_hole], WIN)
    assert hug_share(rect(800, 400, 1200, 418), t, K) >= HUG_SHARE


def test_a_channel_that_meets_the_lake_at_its_mouth_is_not():
    # 1 km of river channel 60 m wide running away from the lake, touching it only across its end.
    assert hug_share(rect(2000, 470, 3000, 530), T, K) < 0.2


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn(); print('ok  ' + name)
