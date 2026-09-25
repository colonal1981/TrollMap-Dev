#!/usr/bin/env python3
r"""test_species_group_retry.py -- a species group the Worker did not answer is asked again in a new
request, and merged.

    py .\scripts\test_species_group_retry.py

Personal use only, not for distribution or resale; not for navigation.

Nottely Lake (GA), 2026-09-25: the catfish, panfish and "other" groups came back "Too many
subrequests by single Worker invocation" -- the first groups had spent the request's allowance and
these three were never asked. The Worker now reports them `asked: false`; these hold the batch to
asking them again in a NEW request, and to reporting what is still lost after it. No network --
_req and the waits are stubbed.
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import research_lakes as R                                    # noqa: E402
import species_group_retry as SGR                             # noqa: E402

LAKE = "Nottely Lake, GA"
SEASON = {"summer": {"preferredDepth": [8, 20], "holding": "suspended"}}
GROUPS = {"bass": ["Largemouth Bass"], "catfish": ["Channel Catfish"], "panfish": ["Bluegill"]}
SPENT = "Too many subrequests by single Worker invocation."


def outcome(name, ok, asked=True):
    return {"group": name, "species": GROUPS[name], "ok": ok, "asked": asked,
            "attempts": 1 if asked else 0,
            "reason": None if ok else (SPENT if asked else f"not asked: ... ({SPENT})")}


FIRST = {"success": True,
         "section": {"Largemouth Bass": SEASON},
         "data": {"lakeForage": {"primary": ["Threadfin Shad"], "secondary": []}, "speciesFound": []},
         "meta": {"groups": [outcome("bass", True), outcome("catfish", False),
                             outcome("panfish", False, asked=False)],
                  "missingSpecies": ["Channel Catfish", "Bluegill"]},
         "warnings": ['fisheries group "catfish" returned nothing (' + SPENT + ')',
                      'fisheries group "panfish" was not asked -- ask it in a new request',
                      "fisheries: 1 holding value(s) the normaliser could not read - x"]}


class Stub:
    """The Worker: the first request as above; a later one answers what it is asked, except any
    group in `refuse`."""
    def __init__(self, refuse=()):
        self.bodies, self.refuse = [], set(refuse)

    def __call__(self, path, payload=None, timeout=300):
        assert path == "/research/agent-llm", path
        self.bodies.append(payload)
        asked = payload.get("groups")
        if not asked:
            return 200, FIRST, None
        groups = [outcome(g, g not in self.refuse) for g in asked]
        section = {GROUPS[g][0]: SEASON for g in asked if g not in self.refuse}
        return 200, {"success": True, "section": section,
                     "data": {"lakeForage": {"primary": ["Gizzard Shad", "threadfin shad"]},
                              "speciesFound": []},
                     "meta": {"groups": groups, "askedGroups": asked,
                              "missingSpecies": [GROUPS[g][0] for g in asked if g in self.refuse]},
                     "warnings": [f'fisheries group "{g}" returned nothing (high demand)'
                                  for g in asked if g in self.refuse]}, None


class AskedAgainInANewRequest(unittest.TestCase):
    def setUp(self):
        self._req, self._sleep = R._req, time.sleep
        self.waits = []
        time.sleep = self.waits.append

    def tearDown(self):
        R._req, time.sleep = self._req, self._sleep

    def run_it(self, refuse=()):
        R._req = stub = Stub(refuse)
        out = {}
        code, res, err = R.ask_species_groups(LAKE, "GA", {"x": 1}, "lite", out)
        self.assertEqual(code, 200)
        return stub, res, out

    def test_only_the_unanswered_groups_are_asked_again(self):
        stub, res, out = self.run_it()
        self.assertEqual(len(stub.bodies), 2)
        self.assertNotIn("groups", stub.bodies[0])
        self.assertEqual(stub.bodies[1]["groups"], ["catfish", "panfish"],
                         "the failed group and the one never asked; not bass")
        self.assertEqual(stub.bodies[1]["previousResults"], {"x": 1}, "the same question")
        self.assertEqual(self.waits, [8], "the first of the waits the Worker used to spend")
        self.assertEqual(out["groups_reasked"], ["catfish", "panfish"])

    def test_the_second_answer_is_merged_into_the_first(self):
        _, res, _ = self.run_it()
        self.assertEqual(sorted(res["section"]), ["Bluegill", "Channel Catfish", "Largemouth Bass"])
        self.assertEqual(res["meta"]["missingSpecies"], [])
        self.assertEqual(SGR.groups_to_ask_again(res), [])
        self.assertEqual(res["data"]["lakeForage"]["primary"], ["Threadfin Shad", "Gizzard Shad"],
                         "a union by name, the first spelling standing")
        self.assertEqual(res["warnings"],
                         ["fisheries: 1 holding value(s) the normaliser could not read - x"],
                         "the lines about groups that have since answered are gone; the rest stay")
        att = {g["group"]: g["attempts"] for g in res["meta"]["groups"]}
        self.assertEqual(att, {"bass": 1, "catfish": 2, "panfish": 1})

    def test_a_group_refused_after_both_waits_is_still_lost(self):
        stub, res, out = self.run_it(refuse=("catfish",))
        self.assertEqual([b.get("groups") for b in stub.bodies],
                         [None, ["catfish", "panfish"], ["catfish"]])
        self.assertEqual(self.waits, [8, 20])
        self.assertEqual(res["meta"]["missingSpecies"], ["Channel Catfish"])
        self.assertEqual(SGR.groups_to_ask_again(res), ["catfish"])
        self.assertTrue(any(w.startswith('fisheries group "catfish"') for w in res["warnings"]))

    def test_a_clean_first_answer_is_not_asked_again(self):
        clean = dict(FIRST, meta={"groups": [outcome("bass", True)], "missingSpecies": []})
        R._req = lambda *a, **k: (200, clean, None)
        out = {}
        R.ask_species_groups(LAKE, "GA", {}, "lite", out)
        self.assertEqual(out["groups_reasked"], [])
        self.assertEqual(self.waits, [])

    def test_a_failed_second_request_keeps_the_first_answer(self):
        calls = []

        def req(path, payload=None, timeout=300):
            calls.append(payload.get("groups"))
            return (200, FIRST, None) if not payload.get("groups") else (400, None, "bad")
        R._req = req
        out = {}
        code, res, _ = R.ask_species_groups(LAKE, "GA", {}, "lite", out)
        self.assertEqual(code, 200)
        self.assertEqual(res["meta"]["missingSpecies"], ["Channel Catfish", "Bluegill"])
        self.assertEqual(calls, [None, ["catfish", "panfish"], ["catfish", "panfish"]])


if __name__ == "__main__":
    unittest.main()
