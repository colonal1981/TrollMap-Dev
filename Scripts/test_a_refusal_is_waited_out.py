#!/usr/bin/env python3
r"""test_a_refusal_is_waited_out.py -- a rate refusal is waited out by the caller, for as long as
Google asked.

    py .\scripts\test_a_refusal_is_waited_out.py

Personal use only, not for distribution or resale; not for navigation.

A refused request counts against the day. The Worker used to answer a per-minute or "high demand"
refusal by asking the next key and model at once -- every step another counted request into the
same busy minute. With `waitOnRefusal` it hands the refusal back with Google's delay ("Please retry
in 35.4s" as retryAfterMs), and these hold the batch to waiting it out: never less than the waits
already argued for (EXTRACT_RETRY_WAITS, GROUP_RETRY_WAITS), longer when Google asked for longer.
Waiting costs no requests. _req and the sleeps are stubbed.
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import research_lakes as R                                    # noqa: E402
import species_group_retry as SGR                             # noqa: E402

REFUSED = ("gemini/gemini-3.5-flash-lite: You exceeded your current quota, please check your plan "
           "and billing details. * Quota exceeded for metric: "
           "generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 15, "
           "model: gemini-3.5-flash-lite\nPlease retry in 35.4s.")


def refused(ms):
    return 200, {"extracted_facts": [], "meta": {"docResults": [
        {"doc": "d", "facts": 0, "error": REFUSED, "refusal": "minute", "retryAfterMs": ms}],
        "llmRequests": [{"key": 1, "model": "gemini-3.5-flash-lite", "http": 429,
                         "answered": False}]}}, None


ANSWER = (200, {"extracted_facts": [{"fact": "stripers at 30 ft"}], "meta": {
    "docResults": [{"doc": "d", "facts": 1, "model": "gemini-3.1-flash-lite"}],
    "llmRequests": [{"key": 2, "model": "gemini-3.1-flash-lite", "http": 200, "answered": True}]}},
    None)


class Stubbed(unittest.TestCase):
    def setUp(self):
        self._req, self._sleep = R._req, time.sleep
        self.waits = []
        time.sleep = self.waits.append

    def tearDown(self):
        R._req, time.sleep = self._req, self._sleep


class Extraction(Stubbed):
    def test_the_read_asks_the_worker_to_hand_refusals_back(self):
        bodies = []
        R._req = lambda path, body: (bodies.append(body), ANSWER)[1]
        R.extract_documents("L", "SC", [], [{"text": "a" * 300}], rpm=0, tpm=0)
        self.assertIs(bodies[0]["waitOnRefusal"], True)

    def test_googles_delay_when_it_is_longer_than_the_argued_wait(self):
        replies = iter([refused(35400), ANSWER])
        R._req = lambda path, body: next(replies)
        out = {}
        facts, _, failed, model = R.extract_documents("L", "SC", [], [{"text": "a" * 300}], rpm=0,
                                                      tpm=0, tally=R.LLMTally(out))
        self.assertEqual(self.waits, [35.4], "Please retry in 35.4s")
        self.assertEqual(len(facts), 1)
        self.assertEqual(failed, [])
        self.assertEqual(model, {"gemini-3.1-flash-lite": 1})
        self.assertEqual((out["llm"]["sent"], out["llm"]["answered"]), (2, 1),
                         "one refused request and one answer -- nothing walked")

    def test_the_argued_wait_when_google_asked_for_less(self):
        replies = iter([refused(2000), refused(2000), ANSWER])
        R._req = lambda path, body: next(replies)
        R.extract_documents("L", "SC", [], [{"text": "a" * 300}], rpm=0, tpm=0)
        self.assertEqual(self.waits, list(R.EXTRACT_RETRY_WAITS[:2]))

    def test_a_day_that_is_spent_is_not_waited_on(self):
        spent = (200, {"extracted_facts": [], "meta": {"docResults": [{"doc": "d", "facts": 0,
                 "error": "gemini: every free key and model this call could ask has said its day "
                          "is spent (per-day limit); none is asked again before midnight Pacific",
                 "refusal": "day", "retryAfterMs": None}], "llmRequests": []}}, None)
        R._req = lambda path, body: spent
        _, _, failed, _ = R.extract_documents("L", "SC", [], [{"text": "a" * 300}], rpm=0, tpm=0)
        self.assertEqual(self.waits, [], "no wait inside a run brings a day back")
        self.assertIn("day is spent", failed[0]["why"])

    def test_the_snippet_read_is_waited_out_too(self):
        replies = iter([refused(35400), ANSWER])
        bodies = []
        R._req = lambda path, body: (bodies.append(body), next(replies))[1]
        code, ex, _, why = R.read_with_waits({"combine": True, "waitOnRefusal": True})
        self.assertEqual(code, 200)
        self.assertIsNone(why)
        self.assertEqual(len(bodies), 2)
        self.assertEqual(self.waits, [35.4])


class SpeciesGroups(Stubbed):
    def test_a_refused_group_waits_as_long_as_google_asked(self):
        first = {"success": True, "section": {}, "meta": {"groups": [
            {"group": "bass", "species": ["Largemouth Bass"], "ok": False, "asked": True,
             "reason": REFUSED, "refusal": "minute", "retryAfterMs": 35400, "attempts": 1}],
            "missingSpecies": ["Largemouth Bass"]}}
        again = {"success": True, "section": {"Largemouth Bass": {}}, "meta": {"groups": [
            {"group": "bass", "species": ["Largemouth Bass"], "ok": True, "asked": True,
             "attempts": 1}], "missingSpecies": []}}
        res, reasked = SGR.ask_failed_groups_again(lambda groups: again, first,
                                                   sleep=self.waits.append, log=lambda m: None)
        self.assertEqual(self.waits, [35.4])
        self.assertEqual(reasked, ["bass"])
        self.assertEqual(SGR.groups_to_ask_again(res), [])

    def test_the_argued_wait_stands_when_google_named_none(self):
        first = {"meta": {"groups": [{"group": "bass", "ok": False, "refusal": "demand",
                                      "retryAfterMs": None}]}}
        self.assertEqual(SGR.retry_after_seconds(first), 0)
        SGR.ask_failed_groups_again(lambda groups: None, first, sleep=self.waits.append,
                                    log=lambda m: None)
        self.assertEqual(self.waits, list(SGR.GROUP_RETRY_WAITS))


if __name__ == "__main__":
    unittest.main()
