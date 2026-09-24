#!/usr/bin/env python3
r"""test_research_lakes_withdrawn.py -- a WQP row goes when the value it cited goes.

    py .\scripts\test_research_lakes_withdrawn.py

Personal use only, not for distribution or resale; not for navigation.

/research/limnology-data withdraws a value the previous pull supplied and this one does not repeat
(wqpWithdrawals, 2026-09-24) and names the evidence sections that lose their WQP rows. The batch
APPENDS evidence rows run after run, so it has to drop those itself, and only those.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import research_lakes as R                                    # noqa: E402

WQP = {'sourceType': 'official_structured', 'sourceUrl': 'worker:/research/limnology-data'}
DOC = {'sourceType': 'official_structured', 'sourceUrl': 'registry:_registry/document_limnology.json'}


class DropWithdrawnWqpEvidence(unittest.TestCase):
    def test_the_url_is_the_one_the_endpoint_writes(self):
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'js', 'utils',
                               'wqp-limnology.js'), encoding='utf-8') as fh:
            self.assertIn("WQP_EVIDENCE_URL = '%s'" % R.WQP_EVIDENCE_URL, fh.read())

    def test_a_named_section_loses_its_wqp_rows_and_keeps_the_rest(self):
        p = {'evidence': {'limnology': {'waterClarity': [dict(WQP), dict(WQP)],
                                        'thermocline': [dict(WQP), dict(DOC)],
                                        'oxygen': [dict(WQP)]}}}
        self.assertEqual(R.drop_withdrawn_wqp_evidence(p, ['waterClarity', 'thermocline']), 3)
        lim = p['evidence']['limnology']
        self.assertNotIn('waterClarity', lim)
        self.assertEqual(lim['thermocline'], [DOC])
        self.assertEqual(lim['oxygen'], [WQP], 'a section that was not named is not touched')

    def test_nothing_named_or_nothing_there_is_not_an_error(self):
        self.assertEqual(R.drop_withdrawn_wqp_evidence({}, ['waterClarity']), 0)
        self.assertEqual(R.drop_withdrawn_wqp_evidence({'evidence': {}}, None), 0)


if __name__ == '__main__':
    unittest.main()
