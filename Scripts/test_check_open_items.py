#!/usr/bin/env python3
"""test_check_open_items.py -- the coverage kind, and the two ways it can lie.

    py .\scripts\test_check_open_items.py

Personal use only, not for distribution or resale; not for navigation.

WHY THESE CASES

`artifact_missing` grew a coverage mode on 2026-09-23 so one item could say "1 of 56 rivers has
research the app can read" instead of a sentence nobody re-measures. A coverage check has exactly
two ways to be worse than no check at all, and both had already happened elsewhere in this project:

  IT COUNTS THE WRONG SET. The waters must come off a generated registry file, filtered by that
  file's own fields. An item that carries its own list of waters is a hand-written table and stops
  being true the day a river is added.

  IT ASKS WITH THE WRONG NAME. A stored artifact's id comes from the name the CALLER passes.
  Asking with the slug found the Santee profile by prefix and reported 2 of 56; asking the way the
  app asks reports 1, because santee_river_delta_north_inlet_sc is not a key the app ever tries.
  The prefix answer was the comfortable one and it was wrong.
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_open_items as C                                   # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class SelectWaters(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.root, 'registry'))
        with open(os.path.join(self.root, 'registry', 'b.json'), 'w', encoding='utf-8') as fh:
            json.dump({'bindings': {
                'a_river': {'feature_type': 'river', 'display_name': 'A River (X Co, SC)'},
                'b_lake': {'feature_type': 'lake', 'display_name': 'B Lake, SC'},
                'c_river': {'feature_type': 'river', 'display_name': 'C River, NC'},
            }}, fh)

    def spec(self, **kw):
        s = {'file': 'registry/b.json', 'at': 'bindings',
             'where': {'feature_type': 'river'}, 'name': 'display_name'}
        s.update(kw)
        return s

    def test_it_filters_on_the_files_own_field(self):
        self.assertEqual(C.select_waters(self.root, self.spec()),
                         ['A River (X Co, SC)', 'C River, NC'])

    def test_without_name_it_returns_the_key(self):
        self.assertEqual(C.select_waters(self.root, self.spec(name=None)),
                         ['a_river', 'c_river'])

    def test_no_where_means_every_row(self):
        self.assertEqual(len(C.select_waters(self.root, self.spec(where=None))), 3)

    def test_a_new_river_in_the_file_is_counted_without_touching_the_item(self):
        p = os.path.join(self.root, 'registry', 'b.json')
        d = json.load(open(p, encoding='utf-8'))
        d['bindings']['d_river'] = {'feature_type': 'river', 'display_name': 'D River, GA'}
        json.dump(d, open(p, 'w', encoding='utf-8'))
        self.assertEqual(len(C.select_waters(self.root, self.spec())), 3)


class CoverageKeysComeFromTheApp(unittest.TestCase):
    """The resolver is imported, not restated. If keys.js changes, this moves with it."""

    RESOLVER = 'Worker/research/keys.js#researchStorageIdCandidates'

    def test_the_county_parenthetical_is_not_the_only_candidate(self):
        out = C.coverage_keys(REPO, self.RESOLVER, ['Santee River (Berkeley Co, SC)'])
        cands = out['Santee River (Berkeley Co, SC)']
        self.assertIn('santee_river', cands)
        self.assertNotIn('santee_river_delta_north_inlet_sc', cands)

    def test_the_congaree_resolves_to_the_id_on_the_drive(self):
        out = C.coverage_keys(REPO, self.RESOLVER, ['Congaree River (to SC-601) (Richland Co, SC)'])
        self.assertIn('congaree_river_to_sc_601_richland_co_sc',
                      out['Congaree River (to SC-601) (Richland Co, SC)'])

    def test_one_call_answers_for_every_name(self):
        names = ['Congaree River (to SC-601) (Richland Co, SC)', 'Santee River (Berkeley Co, SC)']
        self.assertEqual(sorted(C.coverage_keys(REPO, self.RESOLVER, names)), sorted(names))

    def test_a_resolver_that_is_not_there_raises_rather_than_reporting_fixed(self):
        with self.assertRaises(Exception):
            C.coverage_keys(REPO, 'Worker/research/keys.js#noSuchExport', ['X'])


class TheCoverageVerdict(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.root, 'registry', 'profiles'))
        with open(os.path.join(self.root, 'registry', 'b.json'), 'w', encoding='utf-8') as fh:
            json.dump({'bindings': {
                'a_river': {'feature_type': 'river', 'display_name': 'a_river'},
                'c_river': {'feature_type': 'river', 'display_name': 'c_river'},
            }}, fh)
        self.item = {
            'id': 'x', 'kind': 'artifact_missing', 'dir': 'registry/profiles',
            'for_each': {'file': 'registry/b.json', 'at': 'bindings',
                         'where': {'feature_type': 'river'}, 'name': 'display_name'},
        }

    def touch(self, name):
        open(os.path.join(self.root, 'registry', 'profiles', name), 'w').close()

    def test_none_present_is_open(self):
        self.assertEqual(C.run_item(self.item, self.root, REPO), (True, '0 of 2'))

    def test_some_present_is_still_open(self):
        self.touch('a_river.json')
        self.assertEqual(C.run_item(self.item, self.root, REPO), (True, '1 of 2'))

    def test_all_present_is_fixed(self):
        self.touch('a_river.json')
        self.touch('c_river.json')
        self.assertEqual(C.run_item(self.item, self.root, REPO), (False, '2 of 2'))

    def test_a_file_that_is_not_a_profile_does_not_count(self):
        self.touch('a_river.json')
        self.touch('c_river.txt')
        self.assertEqual(C.run_item(self.item, self.root, REPO), (True, '1 of 2'))

    def test_a_near_miss_name_does_not_count_as_coverage(self):
        # santee_river_delta_north_inlet_sc for santee_river, in miniature. Prefix matching would
        # call this covered. The app cannot read it, so it is not.
        self.touch('a_river_upper_reach_sc.json')
        self.touch('c_river.json')
        self.assertEqual(C.run_item(self.item, self.root, REPO), (True, '1 of 2'))


class ThePathModeStillWorks(unittest.TestCase):
    """artifact_missing was one path before it was coverage, and eleven items still use that."""

    def setUp(self):
        self.root = tempfile.mkdtemp()

    def test_absent(self):
        it = {'id': 'x', 'kind': 'artifact_missing', 'path': 'registry/nope.json'}
        self.assertEqual(C.run_item(it, self.root, REPO), (True, 'absent'))

    def test_present(self):
        os.makedirs(os.path.join(self.root, 'registry'))
        open(os.path.join(self.root, 'registry', 'yes.json'), 'w').close()
        it = {'id': 'x', 'kind': 'artifact_missing', 'path': 'registry/yes.json'}
        self.assertEqual(C.run_item(it, self.root, REPO), (False, 'present'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
