#!/usr/bin/env python3
"""Every pass keeps its ceiling -- a pass over a hump or a ledge included.

The file keeps its old name so the history reads in one place. What it holds changed on
2026-09-27.

2026-09-26: Ryan, "i dont really pay that close attention to the exact depth line... i treat them
more as zones than individual lines... it is really hard to hand steer a kayak on a single
contour". Asked whether a pass over a hump or ledge may run over it and on out into deeper water,
he said yes, and the ceiling came off hump and ledge seeds (DEEP_SIDE_OPEN = {hump, ledge}).

2026-09-27: on what that produced, *"our trolling lanes are broken... a lane having a 30ft depth
difference from shallowest to deepest isn't a trolling lane"*. Measured on Lake Murray, the only
pack re-fitted in between: hump passes had a median 39 ft of water between their shallowest and
deepest point, ledge passes 26 ft, and 2,023 of 2,812 ran more than 20 ft (worst: 11 to 168 ft).
Contour and hole passes, which had kept the ceiling, never ran more than 20 ft on any pack. So
DEEP_SIDE_OPEN is empty again.

WHAT THESE TESTS HOLD.

  1. The floor never moves. It is the grounding rule, for every kind of pass.
  2. The ceiling applies to every pass: contour, hole, and a pass seeded on a hump or a ledge.
  3. `seed_deep()` gets the same ceiling.
  4. The 9/26 failure, small: a chord laid over a 15 ft hump standing in 60 ft of water keeps only
     the stretch over the hump. It does not run on across 60 ft of water as one lane.
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


def cut(ceil, raster, floor, min_leg=600.0):
    chord = np.array([[x, 0.0] for x in np.linspace(-600.0, 600.0, 49)], float)
    ps = ftr.split_to_band(chord, raster, floor, ceil, min_leg, bridge_m=40.0, bridge_dm=6.0,
                           deep_bridge_m=300.0, deep_bridge_dm=30.0)
    return max([float(ftr._seglens(p).sum()) for p in ps] or [0.0])


def main():
    top = {'depth_dm': 46, 'seed': 'hump_top', 'seed_kind': 'hump'}
    edge = {'depth_dm': 183, 'seed': 'hump_edge', 'seed_kind': 'hump'}
    ledge = {'depth_dm': 76, 'seed': 'ledge', 'seed_kind': 'ledge'}
    hole = {'depth_dm': 140, 'seed': 'hole_over', 'seed_kind': 'hole'}
    contour = {'depth_dm': 76}
    everything = (top, edge, ledge, hole, contour)

    eq(ftr.DEEP_SIDE_OPEN, frozenset(), 'no seed kind has its deep side open')

    # ── 1 · the floor never moves ───────────────────────────────────────────────────────────
    for pr in everything:
        eq(ftr.band_for(pr, Args())[0], pr['depth_dm'] - Args.tol_dm, f'floor for {pr}')

    # ── 2 · the ceiling applies to every pass ───────────────────────────────────────────────
    for pr in everything:
        eq(ftr.band_for(pr, Args())[2], pr['depth_dm'] + Args.ceiling_dm,
           f'the ceiling stays for {pr.get("seed", "a contour")}')

    # ── 3 · seed_deep steps against the same ceiling ────────────────────────────────────────
    for pr in everything:
        eq(ftr.band_for(pr, Args())[1], pr['depth_dm'] + Args.ceiling_dm,
           f'seed_deep steps against the band ceiling for {pr.get("seed", "a contour")}')

    # ── 4 · the 9/26 failure, small ─────────────────────────────────────────────────────────
    floor, seed_ceil, fit_ceil = ftr.band_for(top, Args())
    eq(fit_ceil, seed_ceil, 'the cut uses the band ceiling for a hump seed')
    kept = cut(fit_ceil, Hump(), floor, min_leg=100.0)
    assert kept < 300.0, f'only the stretch over the hump survives, not 1,200 m of 60 ft water: {kept}'
    assert cut(fit_ceil, Hump(), floor) == 0.0, 'nothing 600 m long is 15 ft deep here'
    assert cut(math.inf, Hump(), floor) >= 1150.0, 'with no ceiling it would run the whole chord'

    # ── 5 · a shoal still ends the pass ─────────────────────────────────────────────────────
    assert cut(math.inf, Hump(shoal_at=300.0), floor) < 1000.0, 'a 3 ft bar still cuts a chord'

    print('test_deep_side_open: all checks passed')


if __name__ == '__main__':
    main()
