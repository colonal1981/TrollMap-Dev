#!/usr/bin/env python3
"""test_mirror_research_profiles.py -- the parts that do not need the network.

    py .\scripts\test_mirror_research_profiles.py

Personal use only, not for distribution or resale; not for navigation.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mirror_research_profiles as M                          # noqa: E402


class SafeId(unittest.TestCase):
    def test_a_plain_id_passes(self):
        self.assertEqual(M.safe_id('parr_shoals_reservoir'), 'parr_shoals_reservoir')
        self.assertEqual(M.safe_id('lake_murray_sc'), 'lake_murray_sc')
        self.assertEqual(M.safe_id('watauga_lake_tn'), 'watauga_lake_tn')

    def test_a_key_that_would_escape_the_directory_is_refused(self):
        # The id comes off an R2 key. None of these may ever become a path.
        for bad in ('../etc/passwd', 'a/b', 'a\\b', '..', '.', '', None, '/abs'):
            self.assertIsNone(M.safe_id(bad), bad)

    def test_a_leading_dot_is_refused(self):
        self.assertIsNone(M.safe_id('.hidden'))

    def test_an_absurdly_long_id_is_refused(self):
        self.assertIsNone(M.safe_id('a' * 200))


class Plan(unittest.TestCase):
    LAKES = [{'id': 'a', 'uploaded': '1'}, {'id': 'b', 'uploaded': '2'}]

    def test_an_empty_manifest_reads_everything(self):
        p = M.plan(self.LAKES, {})
        self.assertEqual([r['id'] for r in p['fetch']], ['a', 'b'])
        self.assertEqual(p['unchanged'], [])

    def test_a_matching_upload_stamp_is_skipped(self):
        p = M.plan(self.LAKES, {'lakes': {'a': {'uploaded': '1'}}})
        self.assertEqual([r['id'] for r in p['fetch']], ['b'])
        self.assertEqual(p['unchanged'], ['a'])

    def test_a_changed_upload_stamp_is_read_again(self):
        p = M.plan(self.LAKES, {'lakes': {'a': {'uploaded': 'OLD'}}})
        self.assertEqual([r['id'] for r in p['fetch']], ['a', 'b'])

    def test_force_ignores_the_manifest(self):
        p = M.plan(self.LAKES, {'lakes': {'a': {'uploaded': '1'}, 'b': {'uploaded': '2'}}},
                   force=True)
        self.assertEqual(len(p['fetch']), 2)
        self.assertEqual(p['unchanged'], [])

    def test_a_profile_that_left_the_bucket_is_reported_not_fetched(self):
        p = M.plan(self.LAKES, {'lakes': {'a': {'uploaded': '1'}, 'ghost': {'uploaded': 'x'}}})
        self.assertEqual(p['gone'], ['ghost'])
        self.assertNotIn('ghost', [r['id'] for r in p['fetch']])

    def test_an_unusable_id_is_reported_and_never_fetched(self):
        p = M.plan([{'id': '../x', 'uploaded': '1'}], {})
        self.assertEqual(p['fetch'], [])
        self.assertEqual(p['unusable_ids'], ['../x'])


class Species(unittest.TestCase):
    PARR = {'biology': {'predatorSpecies': ['Largemouth Bass', 'Smallmouth Bass', 'Bluegill']},
            'metadata': {'status': 'Draft'}}

    def test_it_reads_the_field_smart_plan_consumes(self):
        self.assertEqual(M.profile_species(self.PARR),
                         ['Bluegill', 'Largemouth Bass', 'Smallmouth Bass'])

    def test_a_missing_biology_block_is_not_a_crash(self):
        self.assertEqual(M.profile_species({}), [])
        self.assertEqual(M.profile_species(None), [])
        self.assertEqual(M.profile_species({'biology': {'predatorSpecies': None}}), [])

    def test_status_falls_back_rather_than_throwing(self):
        self.assertEqual(M.profile_status(self.PARR), 'Draft')
        self.assertEqual(M.profile_status({}), 'unknown')


class Evidence(unittest.TestCase):
    def test_a_list_of_entries_is_read(self):
        p = {'evidence': {'biology': {'predatorSpecies': [
            {'sourceType': 'official_structured', 'sourceLabel': 'SC DNR ramps'},
            {'sourceType': 'official_structured', 'sourceLabel': 'SC DES advisory'}]}}}
        self.assertEqual(M.evidence_sources(p),
                         ['official_structured SC DNR ramps',
                          'official_structured SC DES advisory'])

    def test_an_older_bare_entry_is_read_too(self):
        p = {'evidence': {'biology': {'predatorSpecies': {'sourceLabel': 'SC DNR ramps'}}}}
        self.assertEqual(M.evidence_sources(p), ['SC DNR ramps'])

    def test_no_evidence_block_reads_as_no_sources_not_a_crash(self):
        self.assertEqual(M.evidence_sources({}), [])
        self.assertEqual(M.evidence_sources({'evidence': {}}), [])

    def test_an_entry_with_no_label_is_still_counted(self):
        p = {'evidence': {'biology': {'predatorSpecies': [{}]}}}
        self.assertEqual(M.evidence_sources(p), ['(unlabelled)'])


class Summary(unittest.TestCase):
    def test_it_counts_waters_carrying_species_not_waters_present(self):
        profiles = {
            'a': {'biology': {'predatorSpecies': ['Largemouth Bass']}, 'metadata': {'status': 'Verified'}},
            'b': {'biology': {'predatorSpecies': []}, 'metadata': {'status': 'Draft'}},
            'c': {'biology': {'predatorSpecies': ['Largemouth Bass', 'Smallmouth Bass']},
                  'metadata': {'status': 'Draft'}},
        }
        s = M.summarise(profiles)
        self.assertEqual(s['profiles'], 3)
        self.assertEqual(s['carrying_predator_species'], 2)
        self.assertEqual(s['distinct_species'], 2)
        self.assertEqual(s['by_status'], {'Draft': 2, 'Verified': 1})


if __name__ == '__main__':
    unittest.main(verbosity=2)
