#!/usr/bin/env python3
"""
test_species_habitat_weights.py -- a weight must not be stronger than the matrix said.

Personal use only, not for distribution or resale; not for navigation.

Two failures matter here and both are silent:

  1. LIFE STAGE COLLAPSE. Red drum on soft bottom is High as an adult and Very High as a
     SPAWNING adult; seatrout on soft bottom is Medium as an adult and Very High spawning.
     Lump the stages and every adult weight comes out too strong. I made exactly that mistake
     reading the file by hand before this script existed, and reported it to Ryan as fact.

  2. A CLASS THE APP DOES NOT HAVE. The structure vocabulary is read out of coastal-scoring.js
     at build time. If the mapping names something that file no longer exports, the run must say
     so rather than write a weight for a class nothing scores.

    py test_species_habitat_weights.py
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_species_habitat_weights as B  # noqa: E402

KEYS = {'marsh_edge', 'oyster', 'creek_mouth', 'dock_piling', 'grass_flat', 'channel_edge'}
OURS = {'reddrum': 'Red Drum (Redfish)',
        'redfish': 'Red Drum (Redfish)',
        'spottedseatrout': 'Speckled Trout (Spotted Seatrout)',
        'speckledtrout': 'Speckled Trout (Spotted Seatrout)',
        'southernkingfish': 'Whiting (Southern Kingfish)'}


def row(species, stage, habitat, rank, num):
    return {'Species': species, 'Region': 'South Atlantic', 'Habitat Category': 'x',
            'Habitat Type': habitat, 'Life Stage': stage, 'Rank': rank, 'Numeric Rank': str(num)}


class Stages(unittest.TestCase):
    def test_a_spawning_rank_does_not_leak_into_the_adult_weight(self):
        rows = [row('Red Drum', 'Adult', 'Loose Fine Bottom (mud, silt, and sand)', 'High', 3.5),
                row('Red Drum', 'Spawning Adult', 'Loose Fine Bottom (mud, silt, and sand)',
                    'Very High', 4.0)]
        sp, *_ = B.build(rows, OURS, KEYS)
        subs = sp['Red Drum (Redfish)']['substrates']
        self.assertEqual(subs['adult']['fine'], 3.5)
        self.assertEqual(subs['spawning']['fine'], 4.0)

    def test_juvenile_marsh_does_not_become_adult_marsh(self):
        # Marsh is where juvenile red drum live. Adults use it Medium. Collapsing the stages
        # would send a plan to the grass for a fish that is not there.
        rows = [row('Red Drum', 'Adult', 'Saltwater & Brackish Marsh', 'Medium', 2.0),
                row('Red Drum', 'Juvenile & Young-of-Year', 'Saltwater & Brackish Marsh',
                    'Very High', 4.0)]
        sp, *_ = B.build(rows, OURS, KEYS)
        st = sp['Red Drum (Redfish)']['structures']
        self.assertEqual(st['adult']['marsh_edge'], 2.0)
        self.assertEqual(st['juvenile']['marsh_edge'], 4.0)

    def test_all_four_stages_are_kept(self):
        rows = [row('Red Drum', s, 'Oyster Reef', 'Low', 1.0)
                for s in ('Adult', 'Spawning Adult', 'Juvenile & Young-of-Year', 'Egg & Larva')]
        sp, *_ = B.build(rows, OURS, KEYS)
        self.assertEqual(sorted(sp['Red Drum (Redfish)']['structures']),
                         ['adult', 'juvenile', 'larva', 'spawning'])


class Buckets(unittest.TestCase):
    def test_bottom_composition_is_kept_apart_from_structure(self):
        # Nothing in the packs emits a substrate yet. A weight for a class nothing emits looks
        # like it worked and does nothing -- the mistake structureWeights() already refuses.
        rows = [row('Red Drum', 'Adult', 'Oyster Reef', 'High', 3.5),
                row('Red Drum', 'Adult', 'Firm Hard Bottom (boulders to embedded rock)',
                    'High', 3.5)]
        sp, *_ = B.build(rows, OURS, KEYS)
        rec = sp['Red Drum (Redfish)']
        self.assertEqual(rec['structures']['adult'], {'oyster': 3.5})
        self.assertEqual(rec['substrates']['adult'], {'hard': 3.5})

    def test_the_strongest_row_wins_when_two_types_reach_one_class(self):
        # Marsh is three habitat types and SAV is two. Averaging would let a Low row drag a
        # Very High one down; the matrix is saying the class matters AT LEAST this much.
        rows = [row('Spotted Sea Trout', 'Adult', 'Saltwater & Brackish Marsh', 'Very High', 4.0),
                row('Spotted Sea Trout', 'Adult', 'Tidal Freshwater Marsh', 'Low', 1.0)]
        sp, *_ = B.build(rows, OURS, KEYS)
        self.assertEqual(
            sp['Speckled Trout (Spotted Seatrout)']['structures']['adult']['marsh_edge'], 4.0)

    def test_a_habitat_that_maps_to_nothing_is_counted_not_dropped(self):
        rows = [row('Red Drum', 'Adult', 'Mangrove Species', 'High', 3.5)]
        sp, unmapped, *_ = B.build(rows, OURS, KEYS)
        self.assertEqual(sp, {})
        self.assertEqual(unmapped, {'Mangrove Species': 1})

    def test_a_mapping_to_a_class_the_app_lacks_is_reported_not_written(self):
        # THE GUARD. If coastal-scoring.js drops or renames a class, the run must say so.
        rows = [row('Red Drum', 'Adult', 'Oyster Reef', 'High', 3.5)]
        sp, _u, _n, bad, _r = B.build(rows, OURS, KEYS - {'oyster'})
        self.assertEqual(sp, {})
        self.assertEqual(bad, {'oyster': 1})


class Names(unittest.TestCase):
    def test_a_bracketed_alternate_matches(self):
        rows = [row('Southern Kingfish', 'Adult', 'Oyster Reef', 'Low', 1.0)]
        sp, *_ = B.build(rows, OURS, KEYS)
        self.assertIn('Whiting (Southern Kingfish)', sp)

    def test_sea_trout_and_seatrout_are_one_fish(self):
        self.assertEqual(B.norm_species('Spotted Sea Trout'),
                         B.norm_species('Spotted Seatrout'))

    def test_a_species_we_do_not_carry_is_counted_not_invented(self):
        rows = [row('Gray Snapper', 'Adult', 'Oyster Reef', 'High', 3.5)]
        sp, _u, unmatched, *_ = B.build(rows, OURS, KEYS)
        self.assertEqual(sp, {})
        self.assertEqual(unmatched, {'Gray Snapper': 1})

    def test_alternates_cover_both_halves_and_slashes(self):
        alts = {B.norm_species(a) for a in B.species_alternates('Whiting (Southern Kingfish)')}
        self.assertIn('whiting', alts)
        self.assertIn('southernkingfish', alts)
        alts = {B.norm_species(a) for a in B.species_alternates('White Bass / Hybrid')}
        self.assertIn('whitebass', alts)


class HabitatMapping(unittest.TestCase):
    def test_a_mainstem_river_row_is_a_channel_edge(self):
        kind, key = B.classify_habitat(
            'Moderate Gradient Large Mainstem River Finer Substrate (mud, silt, and sand)', KEYS)
        self.assertEqual((kind, key), ('structure', 'channel_edge'))

    def test_dead_shell_is_a_substrate_not_an_oyster_reef(self):
        # A shell accumulation is bottom, not a reef standing in the water.
        self.assertEqual(B.classify_habitat('Dead Shell Accumulation', KEYS),
                         ('substrate', 'shell'))

    def test_sav_reaches_the_grass_flat_class(self):
        for t in ('Mesohaline & Polyhaline Species', 'Tidal Fresh & Oligohaline Species'):
            self.assertEqual(B.classify_habitat(t, KEYS), ('structure', 'grass_flat'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
