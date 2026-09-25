#!/usr/bin/env python3
r"""test_registry_here.py -- a registry that is on disk is never reported missing.

    py .\scripts\test_registry_here.py

Personal use only, not for distribution or resale; not for navigation.

On 2026-09-24 three node smoke checks built their path with URL.pathname, which on Windows is
"/F:/...", and printed SKIP on the ONLY machine that has the registry. Every python registry test now
skips through registry_here.py, so the same slip there would hide all of them at once, on the one run
that matters, and still come out green.

This looks for lake_index.json by a different road -- walking up from this file, the way
test_feature_type_corrections.find_registry does -- and fails if it is there and the helper says it
is not. In the cloud the file is absent and this passes. On Ryan's machine it is present, found, and
this passes. It fails only when the helper's path logic breaks.
"""
import os, sys, unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from registry_here import REGISTRY, registry_has, registry_is_here, registry_path, why_missing


def _on_disk():
    """registry/lake_index.json in the folder above this one or the one above that, or None."""
    d = _HERE
    for _ in range(2):
        d = os.path.dirname(d)
        p = os.path.join(d, 'registry', 'lake_index.json')
        if os.path.exists(p):
            return p
    return None


class ARegistryOnDiskIsFound(unittest.TestCase):

    def test_a_lake_index_on_disk_is_not_reported_missing(self):
        p = _on_disk()
        if p is None:
            return   # nothing on disk, so there is nothing the helper could hide
        self.assertTrue(registry_is_here(), 'the helper looked for the registry at %s' % REGISTRY)
        self.assertTrue(registry_has('lake_index.json'),
                        '%s is on disk and the helper looked at %s'
                        % (p, registry_path('lake_index.json')))

    def test_the_helper_and_the_disk_agree_either_way(self):
        self.assertEqual(registry_has('lake_index.json'), _on_disk() is not None)

    def test_a_missing_registry_says_which_file_the_test_reads(self):
        self.assertIn('no_such_registry_file.json', why_missing('no_such_registry_file.json'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
