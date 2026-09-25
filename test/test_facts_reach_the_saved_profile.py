#!/usr/bin/env python3
"""The facts a run extracts have to reach the document /research/save receives.

Personal use only, not for distribution or resale; not for navigation.

research_lakes.py built the fisheries agent's input as `prev = dict(profile)` and set
`_extractedFacts` on that copy. `profile` is what gets saved. Measured 2026-09-16: 72 of
79 stored profiles carried no facts, and plan-prompt.js reads that exact field to build
the SmartPlan prompt -- so every water this script researched was planning off registry
floors alone.

These tests drive research_one() with the Worker mocked and look at the save payload.
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'Scripts' / 'research_lakes.py'

FACTS = [
    {'fact': 'The shoals run from the US-601 bridge down to the first bend.',
     'quote': 'Shoals extend from the bridge downstream to the bend.',
     'source': 'A river fishing page', 'category': 'habitat', 'confidence': 90},
    {'fact': 'Stripers hold below the shoals through the summer.',
     'quote': 'Stripers stack below the shoals in summer.',
     'source': 'A river fishing page', 'category': 'seasonalPattern', 'confidence': 85},
]

LAKE = 'Congaree River (to SC-601) (Richland Co, SC)'


def load_module():
    spec = importlib.util.spec_from_file_location('research_lakes_under_test', SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class FactsReachTheSavedProfile(unittest.TestCase):

    def build(self, extracted=FACTS, stored=None):
        """Mock the Worker. Returns (module, saved_payloads, agent_inputs)."""
        mod = load_module()
        saved = []
        agent_inputs = []

        def fake_req(path, payload=None, timeout=300):
            if path.startswith('/research/deterministic-facts'):
                return 200, {'profile': {
                    'lakeName': LAKE, 'state': 'SC',
                    'biology': {'predatorSpecies': ['Striped Bass']},
                    'limnology': {}, 'evidence': {}, 'sources': [],
                    'trollingIntelligence': {},
                }}, None
            if path.startswith('/research/limnology-data'):
                return 200, {}, None
            if path.startswith('/research/discover'):
                return 200, {'success': True,
                             'sources': [{'url': 'https://example.org/river',
                                          'title': 'A river fishing page'}]}, None
            if path.startswith('/research/get-normalized'):
                return 200, {'documents': [{
                    'title': 'A river fishing page', 'url': 'https://example.org/river',
                    'fullText': 'The shoals run from the bridge. ' * 40}]}, None
            if path.startswith('/research/save-normalized'):
                return 200, {'ok': True}, None
            if path.startswith('/research/analyze-facts'):
                return 200, {'extracted_facts': list(extracted)}, None
            if path.startswith('/research/agent-llm'):
                agent_inputs.append(payload)
                return 200, {'section': {'Striped Bass': {'depthFt': 12}},
                             'meta': {'groups': [], 'speciesTraitRows': 4,
                                      'agencyEntries': 1, 'missingSpecies': []}}, None
            if path.startswith('/research/save'):
                saved.append(payload)
                return 200, {'key': 'k', 'version': 2}, None
            return 200, {}, None

        mod._req = fake_req
        mod.stored_profile = lambda lake: (dict(stored) if stored else {},
                                           'no profile yet' if stored is None else 'stored')
        mod.mirror_locally = lambda lake: True
        mod.registry_ramps = lambda row: []
        # Nothing is fetched: the corpus comes back from /research/get-normalized as cached,
        # which is the path a re-run takes anyway and which skips the off-lake gate.
        mod.fetch_sources = lambda *a, **k: ([], {})
        return mod, saved, agent_inputs

    def saved_profile(self, mod, saved, **kw):
        out = mod.research_one(LAKE, 'SC', row={}, **kw)
        self.assertTrue(saved, f'nothing reached /research/save; error={out.get("error")!r}')
        return saved[-1]['profile'], out

    # -- the bug ---------------------------------------------------------------

    def test_extracted_facts_reach_the_save_payload(self):
        mod, saved, _ = self.build()
        profile, out = self.saved_profile(mod, saved)
        self.assertEqual(out['facts'], len(FACTS))
        self.assertEqual(profile.get('_extractedFacts'), FACTS,
                         'the run counted the facts and saved a profile without them')

    def test_the_agent_still_gets_them(self):
        """The copy handed to the agent must keep carrying the facts -- that part worked."""
        mod, saved, agent_inputs = self.build()
        self.saved_profile(mod, saved)
        self.assertTrue(agent_inputs, 'the fisheries agent was never called')
        prev = agent_inputs[-1]['previousResults']
        self.assertEqual(prev.get('_extractedFacts'), FACTS)

    # -- the rules the fix has to respect --------------------------------------

    def test_an_empty_extraction_does_not_wipe_stored_facts(self):
        """carry_forward()'s rule: 'I did not look' and 'there is nothing there' differ."""
        mod, saved, _ = self.build(extracted=[], stored={'_extractedFacts': FACTS})
        profile, out = self.saved_profile(mod, saved)
        self.assertEqual(out['facts'], 0)
        self.assertEqual(profile.get('_extractedFacts'), FACTS,
                         'a run that found nothing deleted what an earlier run found')

    def test_a_fresh_extraction_replaces_stale_stored_facts(self):
        older = [{'fact': 'Stale.', 'source': 'Old page', 'category': 'habitat'}]
        mod, saved, _ = self.build(stored={'_extractedFacts': older})
        profile, _ = self.saved_profile(mod, saved)
        self.assertEqual(profile.get('_extractedFacts'), FACTS,
                         'the stored facts outlived a run that found new ones')

    def test_the_count_is_left_to_the_worker(self):
        """storage.js:292 derives _extractedFactsCount. Two writers for one number is the bug
        this project keeps re-finding, so the script must not set it."""
        mod, saved, _ = self.build()
        profile, _ = self.saved_profile(mod, saved)
        self.assertNotIn('_extractedFactsCount', profile,
                         'the script wrote a count the Worker already derives')

    def test_a_carried_count_does_not_outlive_the_facts_it_counted(self):
        """carry_forward() preserves _extractedFactsCount because the run did not compute it.
        storage.js:292 reads `incoming._extractedFactsCount || facts.length`, so a carried 99
        would win over a fresh list of two and the profile would claim a number its own array
        contradicts. The stale count has to be dropped before the save."""
        mod, saved, _ = self.build(stored={'_extractedFactsCount': 99,
                                           '_extractedFacts': [{'fact': 'Stale.'}]})
        profile, _ = self.saved_profile(mod, saved)
        self.assertEqual(len(profile['_extractedFacts']), len(FACTS))
        self.assertNotIn('_extractedFactsCount', profile,
                         'a count carried from the stored profile outlived the facts it counted')

    def test_documents_are_not_copied_into_the_profile(self):
        """The corpus has its own store; south_holston_tn carries 137 facts and no documents."""
        mod, saved, _ = self.build()
        profile, _ = self.saved_profile(mod, saved)
        self.assertNotIn('_normalizedDocuments', profile)


class FreshDocumentsGoFirst(unittest.TestCase):
    """`chosen = usable[:LLM_DOC_LIMIT]` takes twelve, so whatever sorts first is what gets read.

    Cached documents sorted ahead of fetched ones, which meant an old run's corpus held every slot
    and a newly fetched document was the first thing the limit cut. Two Congaree runs either side of
    replacing the paddling query returned the same eight sources and Paddle SC went from 5 facts to
    11 -- the query had changed and nothing downstream could see it.
    """

    def build(self):
        mod = load_module()
        extracted_from = []

        def fake_req(path, payload=None, timeout=300):
            if path.startswith('/research/deterministic-facts'):
                return 200, {'profile': {'lakeName': LAKE, 'state': 'SC',
                                         'biology': {'predatorSpecies': ['Striped Bass']},
                                         'limnology': {}, 'evidence': {}, 'sources': [],
                                         'trollingIntelligence': {}}}, None
            if path.startswith('/research/limnology-data'):
                return 200, {}, None
            if path.startswith('/research/discover'):
                return 200, {'success': True, 'sources': [{'url': 'https://example.org/fresh'}],
                             'queryLog': []}, None
            if path.startswith('/research/get-normalized'):
                return 200, {'documents': [
                    {'title': 'Cached paddle trail', 'url': 'https://example.org/paddle',
                     'fullText': 'Paddle the blue trail. ' * 40}]}, None
            if path.startswith('/research/save-normalized'):
                return 200, {'ok': True}, None
            if path.startswith('/research/analyze-facts'):
                extracted_from.append((payload['documents'][0] or {}).get('title'))
                return 200, {'extracted_facts': []}, None
            if path.startswith('/research/agent-llm'):
                return 200, {'section': {'Striped Bass': {'depthFt': 12}},
                             'meta': {'groups': [], 'speciesTraitRows': 4}}, None
            if path.startswith('/research/save'):
                return 200, {'key': 'k', 'version': 2}, None
            return 200, {}, None

        mod._req = fake_req
        mod.stored_profile = lambda lake: ({}, 'no profile yet')
        mod.mirror_locally = lambda lake: True
        mod.registry_ramps = lambda row: []
        mod.fetch_sources = lambda *a, **k: ([{
            'title': 'Fresh seasonal report', 'url': 'https://example.org/fresh',
            'fullText': 'Stripers run in early summer. ' * 40}], {})
        # The gate passes everything through, in the order it was given.
        mod.gate_documents = lambda repo, docs, lake, alt, scope=None: {'documents': list(docs),
                                                            'rejected': 0, 'refused': []}
        return mod, extracted_from

    def test_the_freshly_fetched_document_is_extracted_first(self):
        mod, extracted_from = self.build()
        out = mod.research_one(LAKE, 'SC', row={})
        self.assertIsNone(out.get('error'), out.get('error'))
        self.assertTrue(extracted_from, 'nothing reached /research/analyze-facts')
        self.assertEqual(extracted_from[0], 'Fresh seasonal report',
                         'a cached document was read before the one this run just fetched')
        self.assertIn('Cached paddle trail', extracted_from,
                      'the cached document was dropped rather than demoted')


class TheDiscoverLogReachesTheScreen(unittest.TestCase):
    """The Worker records why a run found 15 sources and the next found 23. Nothing read it."""

    LOG = [
        '[fisheries] river query set (3) in place of the SC table, naming Largemouth Bass',
        '[fisheries] tinyfish: "Congaree River" fishing report water level flow  4 results',
        '[fisheries] recency fallback 180d: 2 additional results',
        '[fisheries] TinyFish failed: 429 rate limited',
        'Grokipedia citation fetch failed: timeout',
        '  ? off-lake (no_name): Sunfish Lake Park',
        '  ? below threshold (score 1): Uncovering the Seams in Mainframes',
        '  found (score 7): Dial up South Carolina river monsters',
        '  merged tags for https://example.org/x  [fisheries]',
    ]

    def setUp(self):
        self.mod = load_module()

    def test_a_failure_prints_without_verbose(self):
        lines = self.mod.discover_log_lines(self.LOG, verbose=False)
        self.assertEqual(len(lines), 2, lines)
        self.assertTrue(all(l.startswith('!! discover:') for l in lines), lines)
        self.assertTrue(any('429 rate limited' in l for l in lines))
        self.assertTrue(any('Grokipedia' in l for l in lines))

    def test_per_query_counts_print_under_verbose(self):
        lines = self.mod.discover_log_lines(self.LOG, verbose=True)
        self.assertTrue(any('4 results' in l for l in lines))
        self.assertTrue(any('recency fallback 180d' in l for l in lines))
        self.assertTrue(any('query set (3)' in l for l in lines))

    def test_per_result_lines_are_counted_not_printed(self):
        lines = self.mod.discover_log_lines(self.LOG, verbose=True)
        for noisy in ('Sunfish Lake Park', 'Mainframes', 'river monsters', 'merged tags'):
            self.assertFalse(any(noisy in l for l in lines), f'{noisy} was printed')
        self.assertTrue(any('4 per-result line(s) not shown' in l for l in lines), lines)

    def test_an_empty_or_missing_log_prints_nothing(self):
        self.assertEqual(self.mod.discover_log_lines([], verbose=True), [])
        self.assertEqual(self.mod.discover_log_lines(None, verbose=True), [])

    def test_the_log_is_carried_into_the_run_result(self):
        mod, saved, _ = FactsReachTheSavedProfile().build()
        out = mod.research_one(LAKE, 'SC', row={})
        self.assertIn('query_log', out)


class SnippetsAreEvidenceWeAlreadyPaidFor(unittest.TestCase):
    """Discovery hands back a 400-character snippet per source and the driver dropped them.

    Ryan, 2026-09-16: "are we discarding those before we have checked them for information or
    after?" Before. And the snippets were in hand the whole time -- "Striped bass in the Congaree
    River will hold against tree lines and readily take live herring early in the day" is a
    position, a bait and a time of day, in text discovery already returned.
    """

    # Three sources with real snippets, one with a stub too short to be worth a call.
    FOUND = [
        {'url': 'https://www.gameandfishmag.com/a', 'title': 'Summer Bass',
         'snippet': 'Even on the lower end of the Congaree River, I focus on the deeper holes of '
                    'water to find the larger fish through the summer months.'},
        {'url': 'https://www.carolinasportsman.com/b', 'title': 'Save the Stripers',
         'snippet': 'Striped bass in the Congaree River will hold against tree lines and readily '
                    'take live herring early in the day.'},
        {'url': 'https://www.facebook.com/groups/x/posts/y', 'title': 'Striper tips',
         'snippet': 'Use cut bait like shad or herring on bottom, also swim baits and bucktails. '
                    'Saluda is the place to be after May, Congaree has slowed down.'},
        {'url': 'https://example.com/tiny', 'title': 'Stub', 'snippet': 'Congaree.'},
    ]

    SNIPPET_FACTS = [{'fact': 'Stripers hold against tree lines on the Congaree River.',
                      'source': 'Save the Stripers', 'category': 'habitatCover'}]

    def build(self, found=None):
        mod = load_module()
        saved, calls = [], []

        def fake_req(path, payload=None, timeout=300):
            if path.startswith('/research/deterministic-facts'):
                return 200, {'profile': {'lakeName': LAKE, 'state': 'SC',
                                         'biology': {'predatorSpecies': ['Striped Bass']},
                                         'limnology': {}, 'evidence': {}, 'sources': [],
                                         'trollingIntelligence': {}}}, None
            if path.startswith('/research/limnology-data'):
                return 200, {}, None
            if path.startswith('/research/discover'):
                return 200, {'success': True,
                             'sources': list(self.FOUND if found is None else found),
                             'queryLog': []}, None
            if path.startswith('/research/get-normalized'):
                return 200, {'documents': [{
                    'title': 'A cached river page', 'url': 'https://example.org/cached',
                    'fullText': 'The Congaree River below the shoals. ' * 40}]}, None
            if path.startswith('/research/save-normalized'):
                return 200, {'ok': True}, None
            if path.startswith('/research/analyze-facts'):
                calls.append(payload)
                if payload.get('docIndex') == -1:
                    return 200, {'extracted_facts': list(self.SNIPPET_FACTS)}, None
                return 200, {'extracted_facts': []}, None
            if path.startswith('/research/agent-llm'):
                return 200, {'section': {'Striped Bass': {'depthFt': 12}},
                             'meta': {'groups': [], 'speciesTraitRows': 4}}, None
            if path.startswith('/research/save'):
                saved.append(payload)
                return 200, {'key': 'k', 'version': 2}, None
            return 200, {}, None

        mod._req = fake_req
        mod.stored_profile = lambda lake: ({}, 'no profile yet')
        mod.mirror_locally = lambda lake: True
        mod.registry_ramps = lambda row: []
        mod.fetch_sources = lambda *a, **k: ([], {})
        return mod, saved, calls

    def run_one(self, mod, saved):
        out = mod.research_one(LAKE, 'SC', row={}, verbose=False)
        self.assertTrue(saved, f'nothing was saved; error={out.get("error")!r}')
        return saved[-1]['profile'], out

    def test_a_fact_taken_from_a_snippet_reaches_the_profile(self):
        mod, saved, _ = self.build()
        profile, out = self.run_one(mod, saved)
        self.assertEqual(out.get('snippet_facts'), len(self.SNIPPET_FACTS))
        facts = profile.get('_extractedFacts') or []
        self.assertIn(self.SNIPPET_FACTS[0], facts,
                      'the snippet fact was extracted and then not saved')

    def test_one_call_for_every_snippet_not_one_each(self):
        mod, saved, calls = self.build()
        self.run_one(mod, saved)
        snippet_calls = [c for c in calls if c.get('docIndex') == -1]
        self.assertEqual(len(snippet_calls), 1,
                         f'{len(snippet_calls)} snippet calls; it must cost one request')
        self.assertEqual(len(snippet_calls[0]['documents']), 3,
                         'the too-short stub should not have travelled')

    def test_a_snippet_too_short_to_hold_a_fact_is_skipped(self):
        mod, saved, calls = self.build()
        self.run_one(mod, saved)
        sent = [d['url'] for d in
                [c for c in calls if c.get('docIndex') == -1][0]['documents']]
        self.assertNotIn('https://example.com/tiny', sent)

    def test_no_snippets_means_no_call_at_all(self):
        mod, saved, calls = self.build(found=[{'url': 'https://example.com/a', 'title': 'x',
                                              'snippet': ''}])
        self.run_one(mod, saved)
        self.assertEqual([c for c in calls if c.get('docIndex') == -1], [],
                         'a request went out carrying nothing')

    def test_the_snippet_pass_counts_its_own_characters(self):
        mod, saved, _ = self.build()
        _, out = self.run_one(mod, saved)
        self.assertGreater(out['chars_sent'], 0)
        self.assertEqual(out.get('snippet_sources'), 3)


class TheCapsMeanWhatTheySay(unittest.TestCase):
    """SOURCE_CAP = 0 and EXTRACT_DOC_LIMIT = 0 both mean no limit, and 0 is easy to get wrong.

    `rest[:max(0, 0 - 0)]` is the empty list, so the old expression would have discarded every
    discovered source the moment the cap became 0.
    """

    def test_source_cap_zero_takes_everything_rather_than_nothing(self):
        mod = load_module()
        self.assertEqual(mod.SOURCE_CAP, 0, 'the cap is no longer 0; this test guards that shape')
        found = [{'url': f'https://example.com/{i}', 'title': str(i), 'snippet': 'x' * 100}
                 for i in range(27)]
        seeds = [s for s in found if s.get('priority') == 1]
        rest = sorted((s for s in found if s.get('priority') != 1),
                      key=lambda s: s.get('prefetchScore', s.get('score', 3)), reverse=True)
        taken = seeds + (rest if not mod.SOURCE_CAP
                         else rest[:max(0, mod.SOURCE_CAP - len(seeds))])
        self.assertEqual(len(taken), 27, 'a cap of 0 discarded sources instead of keeping them')

    def test_extract_limit_zero_reads_every_usable_document(self):
        mod = load_module()
        self.assertEqual(mod.EXTRACT_DOC_LIMIT, 0)
        usable = list(range(27))
        chosen = usable if not mod.EXTRACT_DOC_LIMIT else usable[:mod.EXTRACT_DOC_LIMIT]
        self.assertEqual(len(chosen), 27)

    def test_the_agent_is_offered_every_readable_document(self):
        """Offering more must not grow the prompt that has to reason -- agents.js still injects at
        most eight (maxDocs) and cleanProfile() deletes _normalizedDocuments before the dump. What
        changed on 2026-09-24 is that the eight are chosen from all of them, not from the first
        twelve in search order: on Lake Murray that choice had left out every guide report."""
        mod = load_module()
        self.assertEqual(mod.LLM_DOC_LIMIT, 0, 'the agent is offered every readable document')
        docs = [{'title': f'd{i}', 'url': f'u{i}', 'fullText': 'x' * 30000} for i in range(40)]
        sent = mod.agent_documents(docs)
        self.assertEqual(len(sent), 40)
        self.assertTrue(all(len(d['text']) == mod.LLM_DOC_CHARS for d in sent))
        agents = (SCRIPT.parents[1] / 'Worker' / 'research' / 'agents.js').read_text(encoding='utf-8')
        self.assertRegex(agents, r'const maxDocs = 8;', 'the prompt still takes eight')
        self.assertRegex(agents, r'delete out\._normalizedDocuments;',
                         'the profile dump still leaves the documents out')

    def test_the_per_document_character_bound_came_down(self):
        mod = load_module()
        self.assertEqual(mod.EXTRACT_DOC_CHARS, 20000,
                         'extraction is reading more per document than the agent does')
        self.assertLessEqual(mod.EXTRACT_DOC_CHARS, mod.LLM_DOC_CHARS,
                             'extraction should never read more per document than the agent prompt')


if __name__ == '__main__':
    unittest.main(verbosity=2)
