#!/usr/bin/env python3
"""A pass over a hump or a ledge may run on into deeper water. A contour and a hole may not.

Ryan, 2026-09-26: "i dont really pay that close attention to the exact depth line... i treat them
more as zones than individual lines... it is really hard to hand steer a kayak on a single
contour". Asked whether a pass over a hump or ledge may run over it and on out into deeper water
on either side: yes. On Lake Murray the band's ceiling -- written for contours, which drift off
their ledge while smoothed -- was what cut 77% of hump passes and 82% of ledge passes.

WHAT THESE TESTS HOLD.

  1. The floor never moves. It is the grounding rule, for every kind of pass.
  2. The ceiling comes off only for a pass SEEDED on a hump or a ledge. A contour keeps it, and so
     does a hole, whose failures are on the shallow side and which his answer was not about.
  3. `seed_deep()` still gets the band's own ceiling, so the step onto the deep side cannot jump a
     point off a drop into the channel.
  4. On a chord that crosses a hump rising out of deep water, the cut keeps the whole chord with
     the ceiling open and keeps nothing long enough with it closed -- the Murray failure, small.
  5. A shoal still ends the pass.

Personal use only, not for distribution or resale; not for navigation.
"""
import importlib.util, math, sys
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location('ftr', HERE / 'fit_trolling_runs.py')
ftr = importlib.util.module_from_spec(spec); spec.loader.exec_module(ftr)


def eq(g, w, m):
    assert g == w, f'{m}: got {g!r} want {w!r}'


class Args:
    tol_dm = 3.0
    ceiling_dm = 24.0


class Hump:
    """A 15 ft hump top, 150 m across, standing in 60 ft of water; a chord runs west-east over it.
    `shoal_at` puts a 3 ft bar across the chord at that x, to prove the floor still cuts."""

    def __init__(self, shoal_at=None):
        self.shoal_at = shoal_at

    def at_raw(self, xy):
        x = xy[:, 0]
        d = np.where(np.abs(x) <= 75.0, 15.0 * 3.048, 60.0 * 3.048)
        if self.shoal_at is not None:
            d = np.where(np.abs(x - self.shoal_at) <= 30.0, 3.0 * 3.048, d)
        return d.astype(np.float32)


def cut(ceil, raster, floor):
    chord = np.array([[x, 0.0] for x in np.linspace(-600.0, 600.0, 49)], float)
    ps = ftr.split_to_band(chord, raster, floor, ceil, 600.0, bridge_m=40.0, bridge_dm=6.0,
                           deep_bridge_m=300.0, deep_bridge_dm=30.0)
    return max([float(ftr._seglens(p).sum()) for p in ps] or [0.0])


def main():
    top = {'depth_dm': 46, 'seed': 'hump_top', 'seed_kind': 'hump'}
    edge = {'depth_dm': 183, 'seed': 'hump_edge', 'seed_kind': 'hump'}
    ledge = {'depth_dm': 76, 'seed': 'ledge', 'seed_kind': 'ledge'}
    hole = {'depth_dm': 140, 'seed': 'hole_over', 'seed_kind': 'hole'}
    contour = {'depth_dm': 76}

    # ── 1 · the floor never moves ───────────────────────────────────────────────────────────
    for pr in (top, edge, ledge, hole, contour):
        eq(ftr.band_for(pr, Args())[0], pr['depth_dm'] - Args.tol_dm, f'floor for {pr}')

    # ── 2 · open for a hump or a ledge seed, closed for everything else ─────────────────────
    for pr in (top, edge, ledge):
        eq(ftr.band_for(pr, Args())[2], math.inf, f'the deep side is open for {pr["seed"]}')
    for pr in (hole, contour):
        eq(ftr.band_for(pr, Args())[2], pr['depth_dm'] + Args.ceiling_dm,
           f'the ceiling stays for {pr.get("seed", "a contour")}')
    eq(ftr.band_for({'depth_dm': 76, 'seed_kind': 'ledge'}, Args())[2], 76 + Args.ceiling_dm,
       'a seed_kind with no seed is not a structure seed')

    # ── 3 · seed_deep keeps the band's own ceiling ──────────────────────────────────────────
    for pr in (top, ledge, hole, contour):
        eq(ftr.band_for(pr, Args())[1], pr['depth_dm'] + Args.ceiling_dm,
           f'seed_deep steps against the band ceiling for {pr.get("seed", "a contour")}')

    # ── 4 · the Murray failure, small ───────────────────────────────────────────────────────
    floor, seed_ceil, fit_ceil = ftr.band_for(top, Args())
    closed = cut(seed_ceil, Hump(), floor)
    opened = cut(fit_ceil, Hump(), floor)
    assert closed < 600.0, f'with the ceiling, 150 m over the hump is all that survives: {closed}'
    assert opened >= 1150.0, f'with it open, the whole chord over the hump survives: {opened}'

    # ── 5 · a shoal still ends the pass ─────────────────────────────────────────────────────
    shoaled = cut(fit_ceil, Hump(shoal_at=300.0), floor)
    assert shoaled < 1000.0, f'a 3 ft bar across the chord still cuts it: {shoaled}'

    print('test_deep_side_open: all checks passed')


if __name__ == '__main__':
    main()
