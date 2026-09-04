#!/usr/bin/env python3
"""
test_build_data_map.py -- the map has to find the places that were actually missed.

Personal use only, not for distribution or resale; not for navigation.

    py test_build_data_map.py

EVERY CASE BELOW IS A MISTAKE A SESSION ACTUALLY MADE on 2026-09-03, in the order it made them.
This file exists so the map cannot regress into being wrong the same ways:

    meta.species          the field was one level below the key that was searched for
    a list container      half the ramp feeds are keyed slug -> [records], not slug -> {record}
    record zero           a field absent from the first record was reported as absent everywhere
    the file count        181 waters mentioned is not 104 waters carrying the field
    SC_INSHORE_ROSTER     a floor applied in Worker code that lives in no file at all
"""

import importlib.util
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('bdm', HERE / 'build_data_map.py')
M = importlib.util.module_from_spec(spec)
sys.modules['bdm'] = M
spec.loader.exec_module(M)


class TheLeafWalk(unittest.TestCase):
    def test_it_reaches_a_field_that_is_not_at_the_top(self):
        # `meta.species`, which is where the ramp feeds keep it and where nobody looked.
        shape = M.walk({'name': 'Blythe Island', 'meta': {'lanes': 2, 'species': 'Red Drum'}})
        self.assertIn('meta.species', shape)
        self.assertEqual(shape['meta.species'], 'Red Drum')

    def test_a_list_index_is_normalised_so_paths_can_be_compared(self):
        self.assertEqual(M.norm_leaf('rows[0].species[2].name'), 'rows[].species[].name')

    def test_an_empty_list_is_reported_rather_than_skipped(self):
        # `"species": []` on Lake Greenwood's agency page is a FACT -- the page was read and has
        # no fish. A walk that skips empty lists cannot tell that from a page nobody fetched.
        self.assertIn('species[]', M.walk({'species': []}))


class TheValueResolver(unittest.TestCase):
    RAMPS = [{'name': 'A', 'meta': {'species': 'Largemouth Bass'}},
             {'name': 'B', 'meta': {'lanes': 2}}]

    def test_a_container_that_is_a_list_resolves(self):
        # Requiring a key here reported dnr_ramps_by_lake.json as holding species for ZERO
        # waters when it holds them for a hundred.
        self.assertEqual(M.at_path(self.RAMPS, '[].meta.species'), ['Largemouth Bass'])

    def test_a_container_that_is_a_dict_resolves(self):
        rec = {'ramps': {'dnr': [{'meta': {'species': 'Bluegill'}}]}}
        self.assertEqual(M.at_path(rec, 'ramps.dnr[].meta.species'), ['Bluegill'])

    def test_a_missing_field_is_empty_and_never_an_exception(self):
        self.assertEqual(M.at_path({'a': 1}, 'b.c'), [])
        self.assertEqual(M.at_path([], '[].meta.species'), [])
        self.assertEqual(M.at_path({'ramps': None}, 'ramps[].x'), [])

    def test_empty_values_do_not_count_as_having_the_field(self):
        self.assertEqual(M.at_path({'species': []}, 'species'), [])
        self.assertEqual(M.at_path({'species': ''}, 'species'), [])


class TheCount(unittest.TestCase):
    """MENTIONING A WATER IS NOT CARRYING THE FIELD, which is how 216 got reported as 182."""

    CONTAINER = {
        'lake_a': [{'meta': {'species': 'Largemouth Bass'}}],
        'lake_b': [{'meta': {'lanes': 3}}],                       # a ramp, no species
        'lake_c': [{'meta': {'species': 'Bluegill'}}],
        'not_ours': [{'meta': {'species': 'Walleye'}}],           # not a shipped slug
    }
    SLUGS = {'lake_a', 'lake_b', 'lake_c'}

    def test_it_counts_waters_that_have_a_value_not_waters_mentioned(self):
        self.assertEqual(M.count_waters_with(self.CONTAINER, '[].meta.species', self.SLUGS), 2)
        self.assertEqual(len(self.CONTAINER), 4)

    def test_a_water_we_do_not_ship_is_not_counted(self):
        self.assertEqual(M.count_waters_with(
            {'not_ours': [{'meta': {'species': 'Walleye'}}]}, '[].meta.species', self.SLUGS), 0)


class TheContainerSearch(unittest.TestCase):
    SLUGS = {'lake_murray', 'lake_marion', 'wateree_lake', 'edisto_river'}

    def test_it_finds_the_container_at_the_bare_root(self):
        d = {s: [{'name': 'x'}] for s in self.SLUGS}
        best = sorted(M.find_slug_container(d, self.SLUGS), reverse=True)
        self.assertEqual(best[0][1], '.')

    def test_it_finds_one_nested_under_a_key(self):
        # `rows`, `waters`, `lakes`, `zones`, `bindings`, `by_lake` -- every file is different.
        for key in ('rows', 'waters', 'lakes', 'zones', 'bindings'):
            with self.subTest(key):
                d = {'_note': 'x', key: {s: {'a': 1} for s in self.SLUGS}}
                best = sorted(M.find_slug_container(d, self.SLUGS), reverse=True)
                self.assertEqual(best[0][1], key)

    def test_a_file_that_is_not_keyed_by_our_slug_returns_nothing(self):
        self.assertEqual(M.find_slug_container({'species': {'Bluegill': {}}}, self.SLUGS), [])


class TheRuntimeWriters(unittest.TestCase):
    """The class of place that has no file, and was missed twice in one afternoon."""

    def test_it_recognises_a_profile_field_assignment(self):
        m = M.ASSIGN.search('    profile.biology.predatorSpecies = uniqueResearchSpecies(')
        self.assertIsNotNone(m)
        self.assertEqual('%s.%s' % (m.group(1), m.group(2)), 'biology.predatorSpecies')

    def test_it_ignores_a_read(self):
        self.assertIsNone(M.ASSIGN.search('const x = profile.biology.predatorSpecies || [];'))

    def test_it_matches_the_other_profile_sections_too(self):
        for line in ('profile.habitat.cover = [];',
                     'profile.limnology.trophicStatus = null;',
                     'profile.navigation.ramps = rows;'):
            with self.subTest(line):
                self.assertIsNotNone(M.ASSIGN.search(line))


if __name__ == '__main__':
    unittest.main(verbosity=2)
