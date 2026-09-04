#!/usr/bin/env python3
"""test_research_lakes_carry.py -- the run may only change what it computed.

    py .\scripts\test_research_lakes_carry.py

Personal use only, not for distribution or resale; not for navigation.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import research_lakes as R                                    # noqa: E402


class CarryForward(unittest.TestCase):
    def test_a_field_the_run_did_not_compute_survives(self):
        # 42 of 52 lakes lost trophicStatus this way: the deterministic skeleton has the key with
        # nothing in it, and the save stored the skeleton.
        stored = {'limnology': {'trophicStatus': 'eutrophic', 'seasonalDrawdownFt': 4}}
        fresh = {'limnology': {'trophicStatus': None, 'seasonalDrawdownFt': None}}
        self.assertEqual(R.carry_forward(stored, fresh), stored)

    def test_a_field_the_run_did_compute_wins(self):
        stored = {'limnology': {'trophicStatus': 'eutrophic'}}
        fresh = {'limnology': {'trophicStatus': 'mesotrophic'}}
        self.assertEqual(R.carry_forward(stored, fresh)['limnology']['trophicStatus'], 'mesotrophic')

    def test_a_partial_block_does_not_delete_its_neighbours(self):
        # A fresh limnology carrying only a thermocline must not take the Secchi with it.
        stored = {'limnology': {'thermocline': {'summerDepthFt': 20},
                                'waterClarity': {'secchiFt': 8.6}}}
        fresh = {'limnology': {'thermocline': {'summerDepthFt': 22}}}
        out = R.carry_forward(stored, fresh)
        self.assertEqual(out['limnology']['thermocline']['summerDepthFt'], 22)
        self.assertEqual(out['limnology']['waterClarity']['secchiFt'], 8.6)

    def test_an_empty_list_never_overwrites_a_full_one(self):
        # "I did not look" and "there is nothing there" are different claims.
        stored = {'biology': {'primaryForage': ['Threadfin Shad']}}
        fresh = {'biology': {'primaryForage': []}}
        self.assertEqual(R.carry_forward(stored, fresh)['biology']['primaryForage'],
                         ['Threadfin Shad'])

    def test_a_full_list_from_the_run_does_overwrite(self):
        stored = {'biology': {'predatorSpecies': ['Largemouth Bass']}}
        fresh = {'biology': {'predatorSpecies': ['Largemouth Bass', 'Bluegill']}}
        self.assertEqual(len(R.carry_forward(stored, fresh)['biology']['predatorSpecies']), 2)

    def test_a_new_section_from_the_run_is_taken(self):
        self.assertEqual(R.carry_forward({}, {'trollingIntelligence': {'Bass': {}}}),
                         {'trollingIntelligence': {'Bass': {}}})

    def test_a_zero_is_a_value_and_not_an_absence(self):
        # 0 ft of drawdown is a measurement. It must beat a stored 4.
        stored = {'limnology': {'seasonalDrawdownFt': 4}}
        fresh = {'limnology': {'seasonalDrawdownFt': 0}}
        self.assertEqual(R.carry_forward(stored, fresh)['limnology']['seasonalDrawdownFt'], 0)

    def test_nothing_stored_means_the_run_stands_alone(self):
        fresh = {'biology': {'predatorSpecies': ['Bass']}}
        self.assertEqual(R.carry_forward({}, fresh), fresh)


class CarriedKeys(unittest.TestCase):
    def test_it_names_what_was_kept_and_nothing_else(self):
        stored = {'limnology': {'trophicStatus': 'eutrophic', 'seasonalDrawdownFt': 4},
                  'biology': {'predatorSpecies': ['Bass']}}
        fresh = {'limnology': {'trophicStatus': None, 'seasonalDrawdownFt': None},
                 'biology': {'predatorSpecies': ['Bass', 'Bluegill']}}
        self.assertEqual(R.carried_keys(stored, fresh),
                         {'limnology.trophicStatus', 'limnology.seasonalDrawdownFt'})

    def test_an_empty_stored_field_is_not_reported_as_carried(self):
        self.assertEqual(R.carried_keys({'limnology': {'trophicStatus': None}},
                                        {'limnology': {'trophicStatus': None}}), set())


class StatusOf(unittest.TestCase):
    def test_it_reads_the_stored_status(self):
        self.assertEqual(R.status_of({'metadata': {'status': 'verified'}}, 'stored'),
                         ('verified', 'stored'))

    def test_no_profile_carries_the_reason_through(self):
        self.assertEqual(R.status_of(None, 'no profile yet'), (None, 'no profile yet'))

    def test_a_profile_with_no_status_says_so(self):
        self.assertEqual(R.status_of({'metadata': {}}, 'stored'),
                         (None, 'stored profile names no status'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
