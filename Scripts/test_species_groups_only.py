#!/usr/bin/env python3
r"""test_species_groups_only.py -- the species groups asked again on what the last run stored.

    py .\scripts\test_species_groups_only.py

Personal use only, not for distribution or resale; not for navigation.

Ryan, 2026-09-24, on a comparison that re-ran the whole document chain and kept nothing: "so your
test to see if this works saves absolutely nothing, spends usage that is already limited and gains
nothing???" These hold --groups-only to the replacement: it makes the group call and no other model
call, on the stored profile and the stored corpus in order; it writes both answers for reading; it
saves only when told to; and --apply-groups saves later from the file, and refuses if the profile
has been written since. No network -- _req is stubbed.
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import research_lakes as R                                    # noqa: E402

LAKE = "Saluda River (Lower Saluda), SC"
STORED_TI = {"Striped Bass": {"spring": {"preferredDepth": [5, 15], "holding": "suspended",
                                         "recommendedPresentations": ["bucktail"], "notes": "old"}},
             "sources": ["x"]}
NEW_TI = {"Striped Bass": {"spring": {"preferredDepth": [8, 20], "holding": "suspended",
                                      "recommendedPresentations": ["live herring"],
                                      "notes": "below the dam at first light",
                                      "sourceQuote": "hold below the Millrace rapids"}},
          "Rainbow Trout": {"winter": {"preferredDepth": [2, 6], "holding": "bottom"}},
          "sources": ["y"]}
DOCS = [{"title": f"d{i}", "url": f"https://e.example/{i}", "fullText": ("t%d " % i) * 80}
        for i in range(15)] + [{"title": "short", "url": "u", "fullText": "too short"}]


class Stub:
    def __init__(self, stored_ti=STORED_TI):
        self.calls, self.saved = [], []
        self.profile = {"lakeName": LAKE, "_extractedFacts": [{"fact": "f"}] * 7,
                        "trollingIntelligence": stored_ti, "metadata": {"lastUpdated": "2026-09-24T20:41:00Z"}}

    def __call__(self, path, payload=None, timeout=300):
        self.calls.append((path, payload))
        if path.startswith("/research/get?"):
            return 200, {"ok": True, "profile": json.loads(json.dumps(self.profile))}, None
        if path.startswith("/research/get-normalized"):
            return 200, {"documents": DOCS}, None
        if path == "/research/agent-llm":
            return 200, {"section": NEW_TI, "warnings": [],
                         "meta": {"groups": [{"group": "bass", "species": ["Striped Bass"],
                                              "returned": ["Striped Bass"], "model": "gemini-3.8-flash"},
                                             {"group": "trout", "species": ["Rainbow Trout"],
                                              "returned": ["Rainbow Trout"], "model": "gemini-3.5-flash-lite"}],
                                  "missingSpecies": []}}, None
        if path == "/research/save":
            self.saved.append(payload)
            return 200, {"ok": True}, None
        return 404, None, "unexpected " + path


class GroupsOnly(unittest.TestCase):
    def setUp(self):
        self._req, self.reg = R._req, R.REGISTRY_DIR
        R.REGISTRY_DIR = None                       # no mirror in a test
        self._td = tempfile.TemporaryDirectory()
        self.tmp = self._td.name

    def tearDown(self):
        R._req, R.REGISTRY_DIR = self._req, self.reg
        self._td.cleanup()

    def run_it(self, save=False, models="flash"):
        R._req = stub = Stub()
        r, paths = R.species_groups_only(LAKE, "SC", models, save=save, report_dir=self.tmp)
        return stub, r, paths

    def test_one_model_call_on_the_stored_inputs_in_order(self):
        stub, r, _ = self.run_it()
        self.assertTrue(r["ok"], r)
        paths = [c[0] for c in stub.calls]
        self.assertEqual(paths.count("/research/agent-llm"), 1, "the groups, and nothing else")
        self.assertFalse([p for p in paths if "analyze-facts" in p or "discover" in p
                          or "proxy-download" in p], "no discovery, fetch or extraction")
        body = dict(stub.calls)["/research/agent-llm"]
        self.assertEqual(body["groupModels"], "flash")
        docs = body["previousResults"]["_normalizedDocuments"]
        self.assertEqual([d["title"] for d in docs], [f"d{i}" for i in range(R.LLM_DOC_LIMIT)],
                         "the corpus's own order, readable ones, first LLM_DOC_LIMIT")
        self.assertEqual(len(body["previousResults"]["_extractedFacts"]), 7, "the stored facts go in")
        self.assertEqual(r["models"], {"bass": "gemini-3.8-flash", "trout": "gemini-3.5-flash-lite"})

    def test_lite_sends_no_switch(self):
        stub, r, _ = self.run_it(models="lite")
        self.assertNotIn("groupModels", dict(stub.calls)["/research/agent-llm"])

    def test_both_answers_are_written_for_reading_and_nothing_is_saved_unasked(self):
        stub, r, paths = self.run_it()
        self.assertEqual(stub.saved, [])
        with open(paths[1], encoding="utf-8") as f:
            md = f.read()
        self.assertIn("## Striped Bass", md)
        self.assertIn("5-15 ft", md)
        self.assertIn("8-20 ft", md)
        self.assertIn("live herring", md)
        self.assertIn("New answer by: gemini-3.8-flash", md)
        self.assertIn("## Rainbow Trout", md)
        self.assertIn("NOT IN THE STORED ANSWER", md)
        with open(paths[0], encoding="utf-8") as f:
            kept = json.load(f)
        self.assertEqual(kept["new_section"], NEW_TI)
        self.assertEqual(kept["stored_section"], STORED_TI)

    def test_save_puts_the_new_answer_on_the_profile(self):
        stub, r, _ = self.run_it(save=True)
        self.assertTrue(r["saved"])
        self.assertEqual(stub.saved[0]["profile"]["trollingIntelligence"], NEW_TI)
        self.assertEqual(len(stub.saved[0]["profile"]["_extractedFacts"]), 7, "nothing else moves")

    def test_apply_saves_from_the_file_with_no_model_call(self):
        _, _, paths = self.run_it()
        R._req = stub = Stub()
        self.assertIsNone(R.apply_species_groups(paths[0]))
        self.assertEqual(stub.saved[0]["profile"]["trollingIntelligence"], NEW_TI)
        self.assertNotIn("/research/agent-llm", [c[0] for c in stub.calls])

    def test_apply_refuses_when_the_profile_has_moved_on(self):
        _, _, paths = self.run_it()
        R._req = stub = Stub(stored_ti={"Striped Bass": {"spring": {"notes": "a later run"}}})
        why = R.apply_species_groups(paths[0])
        self.assertIn("changed since", why)
        self.assertEqual(stub.saved, [])


if __name__ == "__main__":
    unittest.main()
