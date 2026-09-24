#!/usr/bin/env python3
r"""test_a_county_is_in_its_own_state.py -- the label never pairs a county with a state it is not in.

    py .\scripts\test_a_county_is_in_its_own_state.py

Personal use only, not for distribution or resale; not for navigation.

Ryan, 2026-09-23: "there is no Broad River in Cherokee County, North Carolina". The county came
from the centroid and the state from the row, and six labels disagreed with themselves.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from consolidate_lake_index import label_suffix, state_suffix, display_with_county  # noqa: E402
from apply_label_rule import relabels                                                # noqa: E402


class LabelSuffix(unittest.TestCase):
    def test_the_broad_names_the_county_s_own_state(self):
        broad = {'state': 'NC', 'states': ['NC']}
        self.assertEqual(display_with_county('Broad River', 'Cherokee', label_suffix(broad, 'SC')),
                         'Broad River (Cherokee Co, SC)')

    def test_a_border_lake_keeps_both_states(self):
        # Ryan's call for Wylie, Tugaloo, Yonah and Webster: both states, because he fishes both
        # banks. York is South Carolina's and SC is already in the suffix, so nothing changes.
        wylie = {'state': 'NC', 'states': ['NC', 'SC']}
        self.assertEqual(label_suffix(wylie, 'SC'), 'NC/SC')

    def test_a_water_whose_county_agrees_is_unchanged(self):
        self.assertEqual(label_suffix({'state': 'SC'}, 'SC'), state_suffix({'state': 'SC'}))

    def test_no_county_means_the_rule_it_always_was(self):
        self.assertEqual(label_suffix({'state': 'GA'}, None), 'GA')


class Relabels(unittest.TestCase):
    INDEX = {
        'broad_river': {'display_name': 'Broad River (Cherokee Co, NC)', 'usgs': {'site': '1'}},
        'lake_x': {'display_name': 'Lake X (Aiken Co, SC)'},
        'lake_y': {'display_name': 'Lake Y (Aiken Co, SC)'},
    }
    BUILT = {
        'broad_river': {'display_name': 'Broad River (Cherokee Co, SC)', 'usgs': {'site': '2'},
                        'legacy_display_names': ['Broad River, NC', 'Broad River (Cherokee Co, NC)']},
        'lake_x': {'display_name': 'Lake X (Aiken Co, SC)'},
        'lake_y': {'display_name': 'Lake Why (Aiken Co, SC)'},
    }

    def test_only_a_county_state_relabel_is_carried(self):
        changes, other = relabels(self.INDEX, self.BUILT)
        self.assertEqual([c[0] for c in changes], ['broad_river'])
        self.assertEqual(changes[0][2], 'Broad River (Cherokee Co, SC)')
        # A different NAME is some other change, and it is reported, not applied.
        self.assertEqual([o[0] for o in other], ['lake_y'])

    def test_the_old_label_must_be_kept_or_nothing_is_carried(self):
        built = {'broad_river': {**self.BUILT['broad_river'], 'legacy_display_names': ['Broad River, NC']}}
        changes, other = relabels({'broad_river': self.INDEX['broad_river']}, built)
        self.assertEqual(changes, [])
        self.assertEqual(len(other), 1)


if __name__ == '__main__':
    unittest.main()
