#!/usr/bin/env python3
r"""test_claude_species.py -- the species answers written by Claude, held to the Murray rules.

    py .\scripts\test_claude_species.py

Personal use only, not for distribution or resale; not for navigation.

Ryan, 2026-09-24: "you building the actual research profiles after gemini is done makes the most
sense". These hold claude_species.py to what the Murray comparison found mattered: the packet keeps
a wrapped PDF sentence whole and a weekly report's dates, and drops the other lake in a two-lake
article; an entry whose quote is not in the corpus, or whose depth is not in its own quote, is
thrown out; every roster species comes back; the stored answer is never shown to Claude; nothing is
saved unless asked; and a usage limit stops Claude for the rest of the run. No network and no CLI --
`run` and _req are stubbed.
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import claude_species as C                                    # noqa: E402
import research_lakes as R                                    # noqa: E402

ROSTER = ["Striped Bass", "Crappie", "Channel Catfish"]
AHQ = ("# AHQ INSIDER Lake Murray Report\n\nOctober 30\n\nLake Murray water levels are at 355.84.\n\n"
       "He is still catching fish on unweighted planer boards and free lines fished over the channel "
       "in about 20-25 feet up the river. The same pattern is going on in creeks.\n\n"
       "January 22\n\nFish are related to the channel ledges, and generally they are about 15-18 "
       "feet down in 25-30 feet of water.\n")
SURVEY = ("Striped Bass Fisheries Management on Lake Murray\n"
          "58% of striped bass anglers reported most often catching fish during the summer on\n"
          "Lake Murray at depths of 30-\n59 feet below the surface, 22% reported depths of 60-89 feet.\n")
TWO_LAKES = ("**LAKE MURRAY**\n\nOnce on the lake, look for stripers near the surface around points "
             "or flats feeding on shad.\n\n**HARTWELL**\n\nThe stripers hold in the tops of timber "
             "15 feet down on Hartwell. Anchor in 20 to 25 feet of water and throw out live herring "
             "on both sides of the boat when the fish are on the points.\n")
DOCS = [{"title": "AHQ INSIDER Lake Murray (SC) Week 9", "url": "https://a.example/ahq", "fullText": AHQ},
        {"title": "Striped Bass Fisheries Management on Lake Murray", "url": "https://d.example/s.pdf",
         "fullText": SURVEY},
        {"title": "May's Monsters: Stripers on Carolina Lakes", "url": "https://g.example/may",
         "fullText": TWO_LAKES}]
PROFILE = {"lakeName": "Lake Murray, SC",
           "trollingIntelligence": {sp: {"spring": {"notes": "STORED-ANSWER-MARKER"}} for sp in ROSTER},
           "biology": {"predatorSpecies": ROSTER + ["Black Crappie"],
                       "primaryForage": ["Blueback Herring"]},
           "limnology": {}, "_extractedFacts": [{"fact": "f"}] * 3,
           "metadata": {"lastUpdated": "2026-09-24T22:04:28Z"}}


def entry(q, pd=None, wd=None, holding="suspended"):
    return {"preferredDepth": pd, "holding": holding, "waterDepthFt": wd, "sourceQuote": q,
            "structures": [], "forage": [], "recommendedPresentations": [], "notes": "n"}


GOOD = {"Striped Bass": {"spring": None, "summer": entry(
            "58% of striped bass anglers reported most often catching fish during the summer on Lake "
            "Murray at depths of 30-59 feet below the surface", [30, 59], None, "both"),
                         "fall": entry("He is still catching fish on unweighted planer boards and free "
                                       "lines fished over the channel in about 20-25 feet up the river.",
                                       None, [20, 25]),
                         "winter": None},
        "Crappie": {"spring": None, "summer": None, "fall": None,
                    "winter": entry("Fish are related to the channel ledges, and generally they are "
                                    "about 15-18 feet down in 25-30 feet of water.", [15, 18], [25, 30])},
        "Channel Catfish": {s: None for s in C.SEASONS}}


class Packet(unittest.TestCase):
    def build(self):
        return C.build_packet("Lake Murray, SC", "SC", PROFILE, DOCS, ROSTER,
                              ["Lake Murray", "Murray Lake"], "Murray", today="2026-09-24")

    def test_a_wrapped_pdf_sentence_is_kept_whole(self):
        packet, _ = self.build()
        self.assertIn("at depths of 30-\n59 feet below the surface", packet)

    def test_a_weekly_reports_dates_travel_with_its_passages(self):
        packet, _ = self.build()
        self.assertIn("October 30", packet)
        self.assertIn("January 22", packet)
        self.assertLess(packet.index("October 30"), packet.index("unweighted planer boards"))
        self.assertLess(packet.index("January 22"), packet.index("15-18"))

    def test_the_other_lake_in_a_two_lake_article_is_left_out(self):
        packet, _ = self.build()
        self.assertIn("near the surface around points", packet)
        self.assertNotIn("tops of timber", packet)

    def test_every_kept_slice_is_verbatim(self):
        packet, _ = self.build()
        corpus = [C.norm(d["fullText"]) for d in DOCS]
        n = 0
        for part in packet.split("=== DOC ")[1:]:
            body = part.split(" characters\n\n", 1)[1]
            for chunk in body.split("\n[...]\n"):
                text = C.norm(chunk)
                if text:
                    n += 1
                    self.assertTrue(any(text in t for t in corpus), text[:80])
        self.assertGreater(n, 2)

    def test_the_stored_answer_is_not_in_the_packet(self):
        packet, _ = self.build()
        self.assertNotIn("STORED-ANSWER-MARKER", packet)

    def test_channel_alone_is_not_a_fish_word(self):
        fish = C.fish_pattern(["Channel Catfish", "Blue Catfish"])
        self.assertIsNone(fish.search("The river channel is 40 feet deep below the dam."))
        self.assertIsNotNone(fish.search("Channel catfish on cut herring"))


class Checks(unittest.TestCase):
    def test_a_good_answer_passes_whole(self):
        clean, problems = C.check_section(GOOD, ROSTER, DOCS)
        self.assertEqual(problems, [])
        self.assertEqual(clean["Crappie"]["winter"]["preferredDepth"], [15, 18])

    def test_a_quote_in_no_document_is_thrown_out(self):
        bad = json.loads(json.dumps(GOOD))
        bad["Crappie"]["winter"]["sourceQuote"] = "Spawning occurs when the water is 70-80 degrees."
        clean, problems = C.check_section(bad, ROSTER, DOCS)
        self.assertIsNone(clean["Crappie"]["winter"])
        self.assertTrue(any("not in any stored document" in p for p in problems))

    def test_a_widened_range_is_thrown_out(self):
        bad = json.loads(json.dumps(GOOD))
        bad["Crappie"]["winter"]["preferredDepth"] = [12, 30]
        clean, problems = C.check_section(bad, ROSTER, DOCS)
        self.assertIsNone(clean["Crappie"]["winter"])
        self.assertTrue(any("12 is not in the quote" in p for p in problems))

    def test_every_roster_species_comes_back_and_nothing_else(self):
        partial = {"Striped Bass": GOOD["Striped Bass"], "Walleye": {s: None for s in C.SEASONS}}
        clean, problems = C.check_section(partial, ROSTER, DOCS)
        self.assertEqual(list(clean), ROSTER)
        self.assertEqual(clean["Channel Catfish"], {s: None for s in C.SEASONS})
        self.assertTrue(any(p.startswith("Walleye") for p in problems))

    def test_the_roster_is_the_stored_sections_merged_names(self):
        roster, why = C.roster_for(PROFILE)
        self.assertEqual(roster, ROSTER)                 # not "Black Crappie" from the raw list
        self.assertIn("stored section", why)

    def test_the_schema_requires_every_roster_species(self):
        s = C.schema_for(ROSTER)
        self.assertEqual(s["properties"]["trollingIntelligence"]["required"], ROSTER)


class Call(unittest.TestCase):
    def setUp(self):
        C._stopped["why"] = None
        self._exe = C.claude_exe
        C.claude_exe = lambda: "claude.exe"

    def tearDown(self):
        C.claude_exe = self._exe
        C._stopped["why"] = None

    def fake(self, stdout, code=0):
        seen = {}

        class P:
            returncode, stderr = code, ""

        def run(cmd, **kw):
            seen["cmd"], seen["input"] = cmd, kw.get("input")
            p = P()
            p.stdout = stdout
            return p
        return run, seen

    def test_one_call_no_tools_no_session_the_rules_and_the_packet_on_stdin(self):
        run, seen = self.fake(json.dumps({"subtype": "success", "is_error": False,
                                          "structured_output": {"trollingIntelligence": GOOD},
                                          "usage": {"input_tokens": 5, "output_tokens": 7},
                                          "modelUsage": {"claude-opus-5-5": {}},
                                          "total_cost_usd": 1.0, "duration_api_ms": 2000}))
        section, meta = C.ask_claude("PACKET", ROSTER, model="opus", run=run)
        self.assertEqual(section, GOOD)
        cmd = seen["cmd"]
        self.assertEqual(cmd[cmd.index("--tools") + 1], "")
        self.assertIn("--no-session-persistence", cmd)
        self.assertEqual(cmd[cmd.index("--model") + 1], "opus")
        self.assertEqual(json.loads(cmd[cmd.index("--json-schema") + 1]),
                         C.schema_for(ROSTER))
        self.assertTrue(seen["input"].startswith(C.RULES) and seen["input"].endswith("PACKET"))
        self.assertEqual(meta["model"], "claude-opus-5-5")

    def test_a_usage_limit_stops_claude_for_the_rest_of_the_run(self):
        run, _ = self.fake(json.dumps({"subtype": "success", "is_error": True,
                                       "result": "Claude usage limit reached. Resets 9pm"}))
        section, meta = C.ask_claude("P", ROSTER, run=run)
        self.assertIsNone(section)
        run2, seen2 = self.fake("{}")
        section, meta = C.ask_claude("P", ROSTER, run=run2)
        self.assertIsNone(section)
        self.assertIn("stopped for this run", meta["error"])
        self.assertNotIn("cmd", seen2, "a stopped run must not start the CLI again")


class GroupsOnlyWithClaude(unittest.TestCase):
    def setUp(self):
        self._req, self.reg, self._ask = R._req, R.REGISTRY_DIR, C.ask_claude
        R.REGISTRY_DIR = None
        self._td = tempfile.TemporaryDirectory()
        self.saved, self.packets = [], []

        def req(path, payload=None, timeout=300):
            if path.startswith("/research/get?"):
                return 200, {"ok": True, "profile": json.loads(json.dumps(PROFILE))}, None
            if path.startswith("/research/get-normalized"):
                return 200, {"documents": DOCS}, None
            if path == "/research/save":
                self.saved.append(payload)
                return 200, {"ok": True}, None
            return 404, None, "unexpected " + path
        R._req = req

        def ask(packet, roster, model=None, timeout=None, run=None):
            self.packets.append(packet)
            return json.loads(json.dumps(GOOD)), {"model": "claude-opus-5-5", "seconds": 1.0,
                                                  "input_tokens": 10, "output_tokens": 20}
        C.ask_claude = ask

    def tearDown(self):
        R._req, R.REGISTRY_DIR, C.ask_claude = self._req, self.reg, self._ask
        self._td.cleanup()

    def test_it_writes_the_comparison_and_saves_only_when_asked(self):
        r, paths = R.species_groups_only("Lake Murray, SC", "SC", "claude", save=False,
                                         report_dir=self._td.name, aliases=["Lake Murray"])
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.saved, [])
        with open(paths[0], encoding="utf-8") as f:
            kept = json.load(f)
        self.assertEqual(kept["new_section"]["Crappie"]["winter"]["waterDepthFt"], [25, 30])
        self.assertEqual(kept["stored_section"], PROFILE["trollingIntelligence"])
        with open(paths[1], encoding="utf-8") as f:
            md = f.read()
        self.assertIn("## The Claude call", md)
        self.assertNotIn("STORED-ANSWER-MARKER", self.packets[0])

    def test_save_puts_the_checked_answer_on_the_profile(self):
        r, _ = R.species_groups_only("Lake Murray, SC", "SC", "claude", save=True,
                                     report_dir=self._td.name)
        self.assertTrue(r["saved"])
        ti = self.saved[0]["profile"]["trollingIntelligence"]
        self.assertEqual(list(ti), ROSTER)
        self.assertEqual(len(self.saved[0]["profile"]["_extractedFacts"]), 3, "nothing else moves")


class Resume(unittest.TestCase):
    """--resume skips what the Claude step already wrote, so a batch a usage limit stopped can be
    picked back up without paying again for the waters it finished."""

    def test_the_three_ways_claude_saves_are_recognised_and_nothing_else(self):
        by = lambda s: {"metadata": {"createdBy": s}}
        self.assertTrue(R.claude_wrote_last(by("research_lakes.py --groups-only --group-models claude")))
        self.assertTrue(R.claude_wrote_last(
            by("research_lakes.py --apply-groups species_groups_claude_lake_murray_sc_1.json")))
        self.assertFalse(R.claude_wrote_last(by("research_lakes.py batch")))
        self.assertFalse(R.claude_wrote_last(
            by("research_lakes.py --apply-groups species_groups_lite_lake_murray_sc_1.json")))
        self.assertFalse(R.claude_wrote_last({}))

    def test_skip_keeps_order_and_keeps_a_water_it_could_not_read(self):
        stored = {"A": {"metadata": {"createdBy": "research_lakes.py --groups-only --group-models claude"}},
                  "B": {"metadata": {"createdBy": "research_lakes.py batch"}}}
        old = R.stored_profile
        R.stored_profile = lambda n: (stored.get(n), "stored" if n in stored else "HTTP 500")
        try:
            todo, skipped = R.skip_claude_done([("A", "SC", []), ("B", "SC", []), ("C", "SC", [])])
        finally:
            R.stored_profile = old
        self.assertEqual([t[0] for t in todo], ["B", "C"])
        self.assertEqual([s[0] for s in skipped], ["A"])


if __name__ == "__main__":
    unittest.main()
