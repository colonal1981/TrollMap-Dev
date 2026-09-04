#!/usr/bin/env python3
"""test_restore_verified_stamps.py -- the parts that do not need the network.

    py .\scripts\test_restore_verified_stamps.py

Personal use only, not for distribution or resale; not for navigation.
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import restore_verified_stamps as R                           # noqa: E402


class WhatQualifies(unittest.TestCase):
    def test_verified_once_and_now_draft_qualifies(self):
        self.assertTrue(R.needs_restoring(
            {'metadata': {'verifiedAt': '2026-08-21T15:32:41Z', 'status': 'draft'}}))

    def test_still_verified_does_not(self):
        self.assertFalse(R.needs_restoring(
            {'metadata': {'verifiedAt': '2026-07-22T00:00:00Z', 'status': 'verified'}}))

    def test_case_does_not_decide_it(self):
        self.assertFalse(R.needs_restoring(
            {'metadata': {'verifiedAt': '2026-07-22T00:00:00Z', 'status': 'Verified'}}))

    def test_never_verified_is_left_alone(self):
        # Inventing a verification is the same failure as destroying one, pointed the other way.
        self.assertFalse(R.needs_restoring({'metadata': {'status': 'draft'}}))
        self.assertFalse(R.needs_restoring({'metadata': {}}))
        self.assertFalse(R.needs_restoring({}))
        self.assertFalse(R.needs_restoring(None))


class WhatItReadsOffTheMirror(unittest.TestCase):
    def _dir(self, profiles):
        d = tempfile.mkdtemp()
        for name, body in profiles.items():
            with open(os.path.join(d, name), 'w', encoding='utf-8') as fh:
                json.dump(body, fh)
        return d

    def test_it_names_the_water_not_the_file(self):
        d = self._dir({'parr_reservoir_sc.json': {
            'lakeName': 'Parr Shoals Reservoir (Fairfield Co, SC)',
            'metadata': {'verifiedAt': '2026-08-21T00:00:00Z', 'status': 'draft',
                         'versionNumber': 19, 'lastUpdated': '2026-09-02T00:00:00Z'}}})
        rows = R.to_restore(d)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][1], 'Parr Shoals Reservoir (Fairfield Co, SC)')
        self.assertEqual(rows[0][3], '2026-08-21')

    def test_a_profile_with_no_lakeName_is_skipped_not_guessed_at(self):
        d = self._dir({'x.json': {'metadata': {'verifiedAt': '2026-08-21T00:00:00Z',
                                               'status': 'draft'}}})
        self.assertEqual(R.to_restore(d), [])

    def test_the_manifest_and_unreadable_files_are_ignored(self):
        d = self._dir({'_manifest.json': {'lakes': {}},
                       'notes.txt': {},
                       'ok.json': {'lakeName': 'Lake Wateree (Kershaw Co, SC)',
                                   'metadata': {'verifiedAt': '2026-08-10T00:00:00Z',
                                                'status': 'draft'}}})
        with open(os.path.join(d, 'broken.json'), 'w', encoding='utf-8') as fh:
            fh.write('{not json')
        rows = R.to_restore(d)
        self.assertEqual([r[1] for r in rows], ['Lake Wateree (Kershaw Co, SC)'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
