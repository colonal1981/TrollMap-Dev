#!/usr/bin/env python3
"""A trolling pass may be seeded by a structure, not only by a contour.

Ryan, 2026-08-30, on the cove he caught eleven fish in: "not a single trolling lane comes near
it". The lanes were all seeded from contour lines, and the water he fishes is a flat with humps
standing out of it -- so the only contours in it are the edge of the flat, the rings around the
humps, and stubs. Nothing to trace.

WHAT THESE TESTS HOLD.

  1. The contour half does not move. Adding a second seed source must change nothing about the
     first. The initial cut padded the depth raster to fit the seeds, which shifted the grid
     origin and quietly rewrote 318 of Wateree's 1,750 contour lanes -- output with nothing to do
     with the change. A seed is trimmed to the raster now; the raster is untouched.
  2. A seed comes out shaped like a run. `depth_dm`, a LineString, `closed` false -- because the
     whole design is that nothing downstream learns a new kind of thing.
  3. Every structure is offered, none is judged. Which structure is worth fishing is
     `trollingIntelligence`'s call at plan time, and `fit_trolling_runs.py` already says why it
     must not try: "WHICH water to troll is a fishing decision... it cannot make that call and
     must not try."
  4. A pass runs ACROSS the fall line, not down it. Ryan: "i dont care whether lines go north to
     south or east to west" -- direction is the shape of the bottom, not a choice.

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
    """Only what structure_seeds() reads."""
    structure_seed_m = 600.0
    min_fit_m = 800.0
    no_structure_seeds = False


class FlatRaster:
    """A depth field that falls to the east: deeper with rising x, so the fall line is due east
    and anything standing on the bottom runs north-south across it."""
    step = 12.0

    def __init__(self, w_m=6000.0, h_m=6000.0):
        self.x0, self.y0 = 0.0, 0.0
        self.nx, self.ny = int(w_m / self.step), int(h_m / self.step)

    def deeper_dir(self, xy):
        return np.tile(np.array([[1.0, 0.0]]), (len(xy), 1))


def pack_with(tmp, feats):
    import json, os
    os.makedirs(tmp, exist_ok=True)
    with open(os.path.join(tmp, 'structure.geojson'), 'w', encoding='utf-8') as fh:
        json.dump({'type': 'FeatureCollection', 'features': feats}, fh)
    return tmp


def feat(kind, lon, lat, **props):
    p = {'kind': kind, 'id': kind + '_1', 'score': 50.0}
    p.update(props)
    return {'type': 'Feature', 'properties': p,
            'geometry': {'type': 'Point', 'coordinates': [lon, lat]}}


def run(tmp, feats, lat0=34.4):
    return ftr.structure_seeds(pack_with(tmp, feats), FlatRaster(), lat0, Args())


def main(tmp):
    lat0 = 0.5 * 6000.0 / ftr.M_PER_DEG_LAT          # middle of the fake raster, in degrees
    k = ftr.m_per_deg_lon(lat0)
    lon0 = 0.5 * 6000.0 / k

    # ── 2 · shaped like a run ───────────────────────────────────────────────────────────────
    s = run(tmp, [feat('hump', lon0, lat0, depth_ft=6.0, base_ft=23.0, area_acres=3.1,
                       relief_ft=17.0)])
    eq(len(s), 2, 'a hump is offered two ways -- over the top and past the flank')
    eq(sorted(f['properties']['seed'] for f in s), ['hump_edge', 'hump_top'], 'the two shapes')
    for f in s:
        p = f['properties']
        eq(f['geometry']['type'], 'LineString', 'a seed is a line')
        eq(p['closed'], False, 'a seed is never a ring -- the fitter refuses those')
        assert p['depth_dm'] > 0, 'depth_dm carries the band the fitter cuts to'
        assert len(f['geometry']['coordinates']) >= 4, 'min_fit_m needs four vertices'
        assert p['length_m'] >= Args.min_fit_m, 'shorter than min_fit_m is dropped, not emitted'
        eq(p['seed_id'], 'hump_1', 'the structure it came off is named')
        assert p['seed_score'] == 50.0 and p['seed_relief_ft'] == 17.0, \
            'the structure own numbers ride along so the app can rank on measurements'

    top = next(f for f in s if f['properties']['seed'] == 'hump_top')
    edge = next(f for f in s if f['properties']['seed'] == 'hump_edge')
    eq(top['properties']['depth_ft'], 6.0, 'the crown pass targets the top of the hump')
    eq(edge['properties']['depth_ft'], 23.0, 'the flank pass targets the water it rises out of')

    # ── 4 · across the fall line, not down it ───────────────────────────────────────────────
    c = top['geometry']['coordinates']
    dx = (c[-1][0] - c[0][0]) * k
    dy = (c[-1][1] - c[0][1]) * ftr.M_PER_DEG_LAT
    assert abs(dx) < 1e-6 * abs(dy) + 1.0, \
        f'the pass must run across the fall line (east), got dx={dx:.1f} dy={dy:.1f}'
    assert abs(dy) > 500.0, 'and it must be a pass, not a stub'

    # the flank pass sits off the feature, on the deep side
    ec = edge['geometry']['coordinates']
    mid_e = ec[len(ec) // 2][0]
    assert mid_e > c[len(c) // 2][0], 'the flank pass is offset toward deeper water'

    # ── 3 · every structure offered, none judged ────────────────────────────────────────────
    junk = run(tmp, [feat('hump', lon0, lat0, depth_ft=20.0, base_ft=21.0, area_acres=0.41,
                          relief_ft=1.0, score=5.0)])
    eq(len(junk), 2, 'a 1 ft hump is still offered -- the pipeline does not pre-judge structure')
    assert junk[0]['properties']['seed_relief_ft'] == 1.0, 'it carries the number that damns it'

    # ── ledges and holes ────────────────────────────────────────────────────────────────────
    s = run(tmp, [feat('ledge', lon0, lat0, depth_ft=25.9, deep_ft=32.2, fall_ft=28.2)])
    eq([f['properties']['seed'] for f in s], ['ledge'], 'a ledge gets one pass, along its top')
    eq(s[0]['properties']['depth_ft'], 25.9, 'targeted at the top of the drop')

    s = run(tmp, [feat('hole', lon0, lat0, depth_ft=54.1, rim_ft=18.0, area_acres=12.8,
                       relief_ft=36.1)])
    eq(sorted(f['properties']['seed'] for f in s), ['hole_over', 'hole_rim'],
       'a hole is offered across the bottom and around the lip')
    eq(next(f for f in s if f['properties']['seed'] == 'hole_over')['properties']['depth_ft'],
       54.1, 'over the hole targets the hole')
    eq(next(f for f in s if f['properties']['seed'] == 'hole_rim')['properties']['depth_ft'],
       18.0, 'the rim pass targets the rim')

    # ── kinds with no way to troll them are not invented ────────────────────────────────────
    eq(run(tmp, [feat('brushpile', lon0, lat0, depth_ft=12.0)]), [],
       'an unknown kind is skipped rather than guessed at')
    eq(run(tmp, [{'type': 'Feature', 'properties': {'kind': 'hump', 'depth_ft': 6.0},
                  'geometry': {'type': 'LineString', 'coordinates': [[0, 0], [1, 1]]}}]), [],
       'structure.geojson stores points; anything else is not one')

    # ── 1 · trimmed to the raster, never padded around it ───────────────────────────────────
    #
    # This raster falls east, so a pass runs north-south and only the north and south walls can
    # cut one. 200 m off the south wall leaves 776 m of the 1,200 m chord inside, which is under
    # `min_fit_m` -- so it is dropped rather than handed to the fitter as a stub.
    s = run(tmp, [feat('ledge', lon0, 200.0 / ftr.M_PER_DEG_LAT, depth_ft=20.0)])
    eq(s, [], 'a seed with too little room inside the raster is dropped, not clipped into a lie')

    # 500 m off the wall leaves 1,076 m: trimmed, kept, and honest about its own length.
    s = run(tmp, [feat('ledge', lon0, 500.0 / ftr.M_PER_DEG_LAT, depth_ft=20.0)])
    eq(len(s), 1, 'a seed with room to spare survives the trim')
    assert s[0]['properties']['length_m'] < 1200.0, \
        'a trimmed seed reports what survived, not the chord we asked for'
    for f in s:
        for lon, lat in f['geometry']['coordinates']:
            assert 0.0 <= lon * k <= 6000.0 and 0.0 <= lat * ftr.M_PER_DEG_LAT <= 6000.0, \
                'every vertex of a trimmed seed is inside the raster'
        assert f['properties']['length_m'] >= Args.min_fit_m, \
            'length_m describes what survived the trim, not the chord we asked for'

    # ── seed_relief: a seeded pass measures what a contour pass inherits ────────────────────
    #
    # `build_water_features.py` runs BEFORE the fitter and must, so a seed cut inside the fitter
    # can never have a parent to inherit `relief` from. The first version of this change left the
    # field empty and every one of Wateree's 269 new passes scored zero against a main-lake
    # contour that got 12 for free. The rule is imported from build_water_features, not restated.
    class Slab:
        """dm_raw in decimetres, 12 m cells. Depth is a function of i alone: the east half of the
        box falls away to 65 ft while the line sits in 20 ft."""
        step = 12.0

        def __init__(self, drop_dm=None):
            self.nx = self.ny = 200
            self.dm_raw = np.full((self.nx, self.ny), 61.0, dtype=np.float32)   # 20 ft
            if drop_dm is not None:
                self.dm_raw[self.nx // 2:, :] = drop_dm
            self.x0 = self.y0 = 0.0

        def _ij(self, xy):
            i = np.clip((xy[:, 0] / self.step + 0.5).astype(int), 0, self.nx - 1)
            j = np.clip((xy[:, 1] / self.step + 0.5).astype(int), 0, self.ny - 1)
            return i, j

    line = np.array([[1200.0, y] for y in np.linspace(400.0, 1600.0, 40)], float)

    rel, mix, deep = ftr.seed_relief(line, Slab(198.0), 20.0, 250.0)   # 65 ft beside a 20 ft line
    eq(rel, 'channel_edge', 'a 45 ft drop within 250 m is a channel edge')
    assert deep >= 60, f'deepest_within_m carries the drop, got {deep}'
    assert sum(mix.values()) > 1, 'relief_mix counts every station, not just the winner'

    rel, _, _ = ftr.seed_relief(line, Slab(None), 20.0, 250.0)
    eq(rel, 'flat', 'water that does not change beside the line is a flat')

    rel, _, _ = ftr.seed_relief(line, Slab(90.0), 20.0, 250.0)          # 29.5 ft beside 20 ft
    eq(rel, 'break', 'between four and fifteen feet of drop is a break')

    eq(ftr.seed_relief(line, Slab(198.0), None, 250.0), (None, None, None),
       'no depth to compare against means no claim, not a guess')
    blank = Slab(None); blank.dm_raw[:] = np.nan
    eq(ftr.seed_relief(line, blank, 20.0, 250.0), (None, None, None),
       'unsounded water is not flat water -- it is no answer')

    # ── no structure file, no seeds, no exception ───────────────────────────────────────────
    import tempfile
    eq(ftr.structure_seeds(tempfile.mkdtemp(), FlatRaster(), lat0, Args()), [],
       'a pack without structure.geojson simply has no seeds')
    print('test_structure_seeds: all checks passed')


if __name__ == '__main__':
    import tempfile
    main(tempfile.mkdtemp())
