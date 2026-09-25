#!/usr/bin/env python3
r"""test_requests_per_answer.py -- every run prints requests sent per answer.

    py .\scripts\test_requests_per_answer.py

Personal use only, not for distribution or resale; not for navigation.

Ryan's dashboards, 2026-09-25: ~5,500 requests counted against the day on the five free Gemini
projects, for ~900 answers in that day's run logs. The Worker now returns every request its callLLM
sent (meta.llmRequests on /research/analyze-facts and /research/agent-llm); these hold the batch to
summing them per water and per run, retries and failed calls included, and to saying so when a
response carried no record rather than counting it as nothing. _req is stubbed.
"""
import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import research_lakes as R                                    # noqa: E402


def reqs(*statuses):
    return [{"key": 1, "model": "gemini-3.5-flash-lite", "http": s, "answered": s == 200}
            for s in statuses]


class Tally(unittest.TestCase):
    def test_sums_every_response_and_writes_through_to_the_result(self):
        out = {}
        t = R.LLMTally(out)
        t.add({"meta": {"llmRequests": reqs(429, 429, 200)}})
        t.add({"meta": {"llmRequests": reqs(503, 200)}})
        self.assertEqual(out["llm"]["sent"], 5)
        self.assertEqual(out["llm"]["answered"], 2)
        self.assertEqual(out["llm"]["per_answer"], 2.5)
        self.assertEqual(out["llm"]["refused_by_http"], {"429": 2, "503": 1})
        self.assertEqual(out["llm"]["unmeasured"], 0)

    def test_a_response_with_no_record_is_unmeasured_not_zero(self):
        out = {}
        t = R.LLMTally(out)
        t.add(None)
        t.add({"success": True})
        self.assertEqual(out["llm"]["sent"], 0)
        self.assertEqual(out["llm"]["unmeasured"], 2)
        self.assertIn("2 response(s) unmeasured", R.llm_note(out))

    def test_the_water_line_and_the_run_line(self):
        a = {"llm": {"sent": 12, "answered": 10, "per_answer": 1.2, "refused_by_http": {"429": 2},
                     "unmeasured": 0}}
        b = {"llm": {"sent": 8, "answered": 5, "per_answer": 1.6, "refused_by_http": {"503": 3},
                     "unmeasured": 1}}
        self.assertEqual(R.llm_note(a), "  llm: 12 sent / 10 answered (1.20 per answer)")
        line = R.run_llm_line([a, b])
        self.assertIn("20 sent / 15 answered (1.33 per answer)", line)
        self.assertIn("503 x3", line)
        self.assertIn("429 x2", line)
        self.assertIn("1 response(s) unmeasured", line)
        self.assertEqual(R.llm_note({}), "")


class Extraction(unittest.TestCase):
    def setUp(self):
        self._req, self._sleep = R._req, time.sleep
        time.sleep = lambda s: None

    def tearDown(self):
        R._req, time.sleep = self._req, self._sleep

    def test_retries_are_counted_too(self):
        calls = {"n": 0}
        lock = threading.Lock()

        def fake(path, body):
            with lock:
                calls["n"] += 1
                n = calls["n"]
            if n == 1:
                # Refused: the Worker still answers 200, with the reason per document.
                return 200, {"extracted_facts": [], "meta": {
                    "docResults": [{"error": "gemini/x: high demand"}],
                    "llmRequests": reqs(503)}}, None
            return 200, {"extracted_facts": [{"fact": "f"}], "meta": {
                "docResults": [{"facts": 1, "model": "gemini-3.5-flash-lite"}],
                "llmRequests": reqs(200)}}, None

        R._req = fake
        out = {}
        tally = R.LLMTally(out)
        facts, _, failed, _ = R.extract_documents("L", "SC", [], [{"text": "a" * 300}], rpm=0, tpm=0,
                                                  tally=tally)
        self.assertEqual(len(facts), 1)
        self.assertEqual(failed, [])
        self.assertEqual((out["llm"]["sent"], out["llm"]["answered"]), (2, 1))

    def test_an_error_body_is_read_for_its_record(self):
        def fake(path, body, timeout=None):
            R._REQ_ERROR.body = {"success": False, "meta": {"llmRequests": reqs(429, 429)}}
            return 502, None, "LLM failed"

        R._req = fake
        out = {}
        R._ask_agent_llm("L", {"agent": "fisheries"}, out, R.LLMTally(out))
        # A 502 is retried as a transport failure (AGENT_LLM_TRIES), and every try spent two.
        self.assertEqual(out["llm"]["sent"], 2 * R.AGENT_LLM_TRIES)
        self.assertEqual(out["llm"]["answered"], 0)


if __name__ == "__main__":
    unittest.main()
