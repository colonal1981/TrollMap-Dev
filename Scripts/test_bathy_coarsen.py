#!/usr/bin/env python3
"""coarsen_cells() -- the 2x2 aggregation that made the coastal graphs fit.

Personal use only, not for distribution or resale; not for navigation.

These run without touching the drive: a hand-built cell map, not a 122 MB depth_areas parse.
What they hold is the distinction the whole change rests on -- the RASTER keeps its resolution and
only the NODE grid coarsens -- plus the two rules that make the result honest: a block is water if
ANY of its cells is charted, and it takes the SHALLOWEST of their depths.
"""
import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bathy_graph import coarsen_cells


class CoarsenCells(unittest.TestCase):
    def test_step_one_is_the_identity_and_not_a_copy_of_the_wrong_thing(self):
        # The default must do NOTHING. Every water on the card that already routes goes through
        # this function now.
        dmap = {(0, 0): 6, (1, 0): 9}
        core = {(0, 0), (1, 0), (2, 0)}
        d2, c2 = coarsen_cells(dmap, core, 1)
        self.assertEqual(d2, dmap)
        self.assertEqual(c2, core)

    def test_step_zero_and_negatives_are_the_identity_too(self):
        dmap = {(0, 0): 6}
        for step in (0, -1, -8):
            d2, c2 = coarsen_cells(dmap, {(0, 0)}, step)
            self.assertEqual(d2, dmap)

    def test_a_two_by_two_block_becomes_one_node(self):
        dmap = {(0, 0): 12, (1, 0): 12, (0, 1): 12, (1, 1): 12}
        d2, _ = coarsen_cells(dmap, set(dmap), 2)
        self.assertEqual(d2, {(0, 0): 12})

    def test_shallowest_wins_because_that_is_the_depth_the_boat_meets(self):
        # rasterise_depths() uses the same rule where bands overlap a cell. A block that averaged
        # would invent water nobody sounded: 3 ft here, not 8.25.
        dmap = {(0, 0): 3, (1, 0): 9, (0, 1): 12, (1, 1): 9}
        d2, _ = coarsen_cells(dmap, set(dmap), 2)
        self.assertEqual(d2, {(0, 0): 3})

    def test_ONE_charted_cell_carries_the_whole_block(self):
        # THIS IS THE CREEK CASE AND THE WHOLE REASON THIS IS NOT A COARSER RASTER. A 22 m creek
        # fills one cell of each 2x2 block along its length. Rasterising at 44.6 m would test the
        # block's CENTRE, which is on the bank, and drop it. Aggregating keeps it.
        dmap = {(0, 0): 4, (2, 0): 4, (4, 0): 4, (6, 0): 4}     # every other fine cell, a 1-cell creek
        d2, c2 = coarsen_cells(dmap, set(dmap), 2)
        self.assertEqual(sorted(d2), [(0, 0), (1, 0), (2, 0), (3, 0)])
        # and they are now ADJACENT, where the fine cells had a gap between each pair
        self.assertEqual(len(d2), 4)

    def test_an_uncharted_block_does_not_appear(self):
        # Absence stays absence. A node invented over unsounded water is a route into nothing.
        dmap = {(0, 0): 6}
        core = {(0, 0), (1, 0), (2, 0), (3, 0), (8, 8)}
        d2, c2 = coarsen_cells(dmap, core, 2)
        self.assertEqual(sorted(d2), [(0, 0)])
        # the core still coarsens -- it is the mask's inside-the-boundary test, a separate gate
        self.assertEqual(sorted(c2), [(0, 0), (1, 0), (4, 4)])

    def test_zero_ft_is_carried_not_dropped(self):
        # 0 ft is a charted reading and the router filters on depth at query time. Dropping it here
        # would decide for every caller that shallow water is no water.
        dmap = {(0, 0): 0, (1, 1): 20}
        d2, _ = coarsen_cells(dmap, set(dmap), 2)
        self.assertEqual(d2, {(0, 0): 0})

    def test_step_three_works_for_the_same_reasons(self):
        dmap = {(i, j): 5 + i for i in range(3) for j in range(3)}
        d2, _ = coarsen_cells(dmap, set(dmap), 3)
        self.assertEqual(d2, {(0, 0): 5})

    def test_blocks_do_not_bleed_into_each_other(self):
        # (1,1) and (2,2) are diagonal neighbours in the fine grid and must land in DIFFERENT
        # blocks, or the aggregation quietly welds separate water together.
        dmap = {(1, 1): 6, (2, 2): 30}
        d2, _ = coarsen_cells(dmap, set(dmap), 2)
        self.assertEqual(d2, {(0, 0): 6, (1, 1): 30})

    def test_the_node_count_falls_by_about_four_on_solid_water(self):
        # The size argument, in miniature: 40x40 charted cells -> 400 nodes, not 1600.
        dmap = {(i, j): 10 for i in range(40) for j in range(40)}
        d2, _ = coarsen_cells(dmap, set(dmap), 2)
        self.assertEqual(len(d2), 400)
        self.assertEqual(len(dmap) / len(d2), 4.0)


class TheReportNamesBothGrids(unittest.TestCase):
    """The mislabel that cost a wrong recommendation, pinned so it cannot come back."""

    def setUp(self):
        here = os.path.dirname(os.path.abspath(__file__))
        src = open(os.path.join(here, 'bathy_graph.py'), encoding='utf-8').read()
        self.code = '\n'.join(l for l in src.split('\n')
                              if not l.strip().startswith('#'))

    def test_build_lake_takes_coarsen(self):
        self.assertIn('def build_lake(registry, pack, slug, cell=None, quiet=False, coarsen=1)',
                      self.code)

    def test_the_raster_cell_is_reported_separately_from_the_node_cell(self):
        # `cell_deg` alone read as the grid the graph was built on and was not: the raster came
        # from build_mask whatever `cell` said.
        self.assertIn("rep['raster_cell_deg']", self.code)
        self.assertIn("rep['coarsen']", self.code)

    def test_the_node_coordinate_uses_the_node_cell_not_the_raster_cell(self):
        # The bug this would be: nodes coarsened 2x but placed on 22.3 m centres, so every node
        # sits in the corner of its own block and the edges are the wrong length.
        self.assertIn('(i + 0.5) * node_cell', self.code)
        self.assertNotIn('(i + 0.5) * mask.cell', self.code)

    def test_the_cli_exposes_coarsen_and_defaults_to_unchanged(self):
        self.assertIn("'--coarsen'", self.code)
        self.assertIn('coarsen=a.coarsen', self.code)
        self.assertIn("type=int, default=1", self.code)


if __name__ == '__main__':
    unittest.main(verbosity=2)
