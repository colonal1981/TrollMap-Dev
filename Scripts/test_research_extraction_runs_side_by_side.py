#!/usr/bin/env python3
r"""test_research_extraction_runs_side_by_side.py -- several extraction calls at once, under the ceilings.

    py .\scripts\test_research_extraction_runs_side_by_side.py

Personal use only, not for distribution or resale; not for navigation.

Ryan, 2026-09-24: "this is wayyyyyyyyyyyyy too slow... it should not take 10 minutes for 1 body
of water". The Lower Saluda made 40 extraction calls strictly one after another at 8-15 s each.
These hold the replacement to what it promises: calls overlap, the starts per minute and tokens
per minute stay under their ceilings, facts come back in document order, and a document the model
never read is retried when the refusal was "not now" and reported when it was not.
"""
import os
import re
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import research_lakes as R                                    # noqa: E402


class FakeClock:
    def __init__(self):
        self.t = 0.0
        self.lock = threading.Lock()

    def now(self):
        with self.lock:
            return self.t

    def sleep(self, s):
        with self.lock:
            self.t += s


class Limiter(unittest.TestCase):
    def test_the_rpm_ceiling_holds_the_next_start_until_the_minute_has_passed(self):
        c = FakeClock()
        lim = R.CallLimiter(rpm=2, tpm=0, clock=c.now, sleep=c.sleep)
        lim.acquire(10)
        lim.acquire(10)
        self.assertEqual(c.now(), 0.0, 'two starts inside the ceiling cost nothing')
        lim.acquire(10)
        self.assertGreaterEqual(c.now(), 60.0, 'the third waits for the first to leave the window')

    def test_the_tpm_ceiling_counts_tokens_in_flight_not_calls(self):
        c = FakeClock()
        lim = R.CallLimiter(rpm=0, tpm=1000, clock=c.now, sleep=c.sleep)
        lim.acquire(600)
        lim.acquire(300)
        self.assertEqual(c.now(), 0.0)
        lim.acquire(300)
        self.assertGreaterEqual(c.now(), 60.0)

    def test_one_call_bigger_than_the_whole_budget_still_goes_alone(self):
        c = FakeClock()
        lim = R.CallLimiter(rpm=0, tpm=100, clock=c.now, sleep=c.sleep)
        lim.acquire(5000)
        self.assertEqual(c.now(), 0.0)

    def test_the_default_ceiling_is_four_of_the_five_keys(self):
        # Ryan, 2026-09-24: "requests per minute are 15 for gemini free keys and we have 5 of them"
        self.assertEqual(R.DEFAULT_RPM, 60)
        self.assertEqual(R.extract_workers(R.DEFAULT_RPM, 40), 12)

    def test_the_key_count_is_the_workers_own_list(self):
        # GEMINI_FREE_KEYS sizes the ceiling; callLLM's rotation list is what the calls use. A
        # sixth key added there and not here would leave a key's worth of the pool unused.
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'Worker',
                                'worker-core.js'), encoding='utf-8').read()
        keys = re.search(r"const GEMINI_FREE_KEYS = \[([^\]]*)\]", src)
        self.assertIsNotNone(keys, 'the rotation list moved; follow it')
        self.assertEqual(len(re.findall(r"[\"']gemini-free\d*[\"']", keys.group(1))), R.GEMINI_FREE_KEYS)

    def test_the_pool_is_sized_from_the_ceiling(self):
        self.assertEqual(R.extract_workers(30, 40), 6, '30 starts a minute at 12 s a call')
        self.assertEqual(R.extract_workers(15, 40), 3)
        self.assertEqual(R.extract_workers(30, 1), 1)
        self.assertEqual(R.extract_workers(30, 4), 4, 'never more threads than documents')


class ExtractDocuments(unittest.TestCase):
    def setUp(self):
        self._req, self._sleep = R._req, time.sleep
        R.EXTRACT_RETRY_WAITS_SAVED = R.EXTRACT_RETRY_WAITS
        R.EXTRACT_RETRY_WAITS = (0, 0)

    def tearDown(self):
        R._req = self._req
        R.EXTRACT_RETRY_WAITS = R.EXTRACT_RETRY_WAITS_SAVED

    def test_the_last_wait_outlasts_a_per_minute_refusal(self):
        """Marion, 2026-09-24: two documents were refused on RPM and both retries (8 s, 20 s) fell
        inside the same minute. The last wait must be the minute itself."""
        self.assertGreaterEqual(R.EXTRACT_RETRY_WAITS_SAVED[-1], 60)
        self.assertTrue(R._TRANSIENT.search('gemini/gemini-3.1-flash-lite: You exceeded your current '
                                            'quota, please check your plan and billing details'),
                        'the quota refusal is retried, not reported as a document with nothing in it')

    def test_calls_overlap_and_facts_come_back_in_document_order(self):
        live, peak, lock = [0], [0], threading.Lock()

        def fake(path, payload=None, timeout=300):
            i = payload['docIndex']
            with lock:
                live[0] += 1
                peak[0] = max(peak[0], live[0])
            time.sleep(0.05 * (5 - i % 5))          # later documents finish first
            with lock:
                live[0] -= 1
            model = 'gemini-3.1-flash-lite' if i % 5 == 0 else 'gemini-3.5-flash-lite'
            return 200, {'extracted_facts': [{'fact': f'doc {i}'}],
                         'meta': {'docResults': [{'model': model}]}}, None
        R._req = fake
        docs = [{'title': f'd{i}', 'text': 'x' * 400} for i in range(10)]
        facts, sent, failed, models = R.extract_documents('L', 'SC', [], docs, rpm=0, tpm=0)
        self.assertGreater(peak[0], 1, 'more than one call in flight')
        self.assertEqual([f['fact'] for f in facts], [f'doc {i}' for i in range(10)])
        self.assertEqual(sent, 4000)
        self.assertEqual(failed, [])
        self.assertEqual(models, {'gemini-3.5-flash-lite': 8, 'gemini-3.1-flash-lite': 2},
                         'which model read each document is counted, for the time: line')
        self.assertEqual(R.models_note({'extract_models': models}),
                         ': gemini-3.5-flash-lite 8, gemini-3.1-flash-lite 2')
        self.assertEqual(R.models_note({}), '', 'an older report without the count prints nothing')

    def test_high_demand_is_retried_and_a_real_refusal_is_reported(self):
        tries = {}

        def fake(path, payload=None, timeout=300):
            i = payload['docIndex']
            tries[i] = tries.get(i, 0) + 1
            if i == 0 and tries[i] == 1:
                return 200, {'extracted_facts': [], 'meta': {'docResults': [
                    {'error': 'gemini/gemini-3.5-flash-lite: This model is currently experiencing high demand.'}]}}, None
            if i == 1:
                return 200, {'extracted_facts': [], 'meta': {'docResults': [{'error': 'non-JSON'}]}}, None
            return 200, {'extracted_facts': [{'fact': f'doc {i}'}], 'meta': {'docResults': [{}]}}, None
        R._req = fake
        docs = [{'title': f'd{i}', 'text': 'x' * 300} for i in range(3)]
        facts, _, failed, _ = R.extract_documents('L', 'SC', [], docs, rpm=0, tpm=0)
        self.assertEqual(tries[0], 2, '"high demand" is "not now", so it is asked again')
        self.assertEqual(tries[1], 1, 'non-JSON is an answer; asking again changes nothing')
        self.assertEqual([f['fact'] for f in facts], ['doc 0', 'doc 2'])
        self.assertEqual([f['doc'] for f in failed], ['d1'], 'and it is named, not silent')

    def test_a_transport_failure_is_retried_and_a_400_is_not(self):
        tries = {}

        def fake(path, payload=None, timeout=300):
            i = payload['docIndex']
            tries[i] = tries.get(i, 0) + 1
            if i == 0:
                return (0, None, 'timed out') if tries[i] < 3 else (200, {'extracted_facts': []}, None)
            return 400, None, 'Missing lakeName'
        R._req = fake
        _, _, failed, _ = R.extract_documents('L', 'SC', [], [{'text': 'a' * 300}, {'text': 'b' * 300}],
                                           rpm=0, tpm=0)
        self.assertEqual(tries, {0: 3, 1: 1})
        self.assertEqual(len(failed), 1)


class Timings(unittest.TestCase):
    def test_each_stage_is_its_own_number(self):
        c = R.PhaseClock()
        c.mark('discover')
        c.mark('fetch')
        self.assertEqual(list(c.seconds), ['discover', 'fetch'])


if __name__ == '__main__':
    unittest.main()
