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

    def test_a_table_in_capitals_is_not_a_fish_passage(self):
        # Lake Wateree's packet carried 77,903 characters of the state's 303(d) list.
        text = ("CEDAR CREEK RESERVOIR 0.15 MILES SOUTHWEST OF THE BOAT LANDING FISH TISSUE "
                "MERCURY SCRL-09094 REEDER POINT BR AT SC 48.\n\n"
                "Crappie are holding on brush piles in 12-15 feet of water on Cedar Creek.")
        spans = C.doc_spans(text, C.fish_pattern(["Black Crappie"]), ["Cedar Creek"], True)
        kept = " ".join(text[a:b] for a, b in spans)
        self.assertIn("brush piles in 12-15 feet", kept)
        self.assertNotIn("SCRL-09094", kept)

    def test_channel_alone_is_not_a_fish_word(self):
        fish = C.fish_pattern(["Channel Catfish", "Blue Catfish"])
        self.assertIsNone(fish.search("The river channel is 40 feet deep below the dam."))
        self.assertIsNotNone(fish.search("Channel catfish on cut herring"))


class Rivers(unittest.TestCase):
    """The first river batch, 2026-09-25: every river came back empty. The packet was built from
    lake words, and a weekly lake report went whole into a river's packet for one mention."""

    def test_kind_comes_from_the_name(self):
        for n, k in (("Broad River, SC", "river"), ("Chessie Creek, SC", "river"),
                     ("Diversion Canal (Berkeley Co, SC)", "river"), ("Tail Race Canal, SC", "river"),
                     ("Fishing Creek Reservoir, SC", "lake"), ("Lake Murray, SC", "lake"),
                     ("Saluda River (Lower Saluda), SC", "river")):
            self.assertEqual(C.water_kind(n), k, n)

    def test_river_sentences_are_kept(self):
        text = ("It's a haven for eating sized channel catfish in the 1- to 3-pound range. "
                "Smallies hold in the eddies below the shoals when the flow drops in summer.")
        spans = C.doc_spans(text, C.fish_pattern(["Channel Catfish", "Smallmouth Bass"]),
                            ["Broad River"], True)
        kept = " ".join(text[a:b] for a, b in spans)
        self.assertIn("haven for eating sized channel catfish", kept)
        self.assertIn("eddies below the shoals", kept)

    def test_one_dated_entry_of_a_lake_report_not_the_whole_page(self):
        text = ("# AHQ INSIDER Clarks Hill Report\n\nNovember 30\n\nStripers are 25-35 feet deep on "
                "Clarks Hill on down-rods.\n\nNovember 22\n\nUp the Broad River arm the bass are on "
                "rock in 8-10 feet of water.\n")
        spans = C.doc_spans(text, C.fish_pattern(["Largemouth Bass"]), ["Broad River"], False)
        kept = " ".join(text[a:b] for a, b in spans)
        self.assertIn("Broad River arm", kept)
        self.assertNotIn("25-35 feet deep on Clarks Hill", kept)


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

    def test_spellings_of_one_name_are_asked_once(self):
        # Lake Monticello's stored section, 2026-09-25.
        prof = {"trollingIntelligence": {k: {} for k in (
            "Largemouth Bass", "Black Crappies", "White Crappies", "Blue Catfish", "Black Crappie",
            "Crappie")}}
        roster, why = C.roster_for(prof)
        self.assertEqual(roster, ["Largemouth Bass", "Black Crappie", "White Crappies",
                                  "Blue Catfish", "Crappie"])
        self.assertIn("Black Crappies folded into Black Crappie", why)

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

    def test_an_empty_packet_is_not_sent(self):
        # Chessie Creek, lakes part 1: one 1,315-character document, no passage kept, and a call
        # spent to hear that every season was null.
        run, seen = self.fake("{}")
        docs = [{"title": "Chessie Creek boat ramp", "url": "https://x.example/ramp",
                 "fullText": "Parking for twelve trailers. Open dawn to dusk. " * 30}]
        section, meta = C.answer("Chessie Creek, SC", "SC", PROFILE, docs, run=run)
        self.assertIsNone(section)
        self.assertIn("Claude was not asked", meta["error"])
        self.assertNotIn("cmd", seen)
        self.assertEqual(meta["packet"]["documents_with_text"], 0)

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


class AfterAFullRun(unittest.TestCase):
    """Lakes part 1, 2026-09-25: a failed Claude answer writes one file, a saved one writes two,
    and indexing the second took the whole batch down on its first water."""

    def setUp(self):
        self._g = R.species_groups_only

    def tearDown(self):
        R.species_groups_only = self._g

    def test_a_failed_answer_with_one_file_does_not_raise(self):
        R.species_groups_only = lambda *a, **k: ({"ok": False, "error": "claude: no entry survived",
                                                  "claude": {"entries": 0}}, ["x_FAILED.json"])
        out, secs = R.claude_after_run("Chessie Creek, SC", "SC", [], "_reports", None)
        self.assertFalse(out["ok"])
        self.assertEqual(out["report"], "x_FAILED.json")

    def test_a_saved_answer_reports_its_md(self):
        R.species_groups_only = lambda *a, **k: ({"ok": True, "saved": True, "seconds": 5.0,
                                                  "claude": {"entries": 9}}, ["x.json", "x.md"])
        out, secs = R.claude_after_run("Lake Greenwood, SC", "SC", [], "_reports", None)
        self.assertTrue(out["saved"])
        self.assertEqual(out["report"], "x.md")
        self.assertEqual(secs, 5.0)

    def test_anything_the_step_raises_is_caught(self):
        def boom(*a, **k):
            raise RuntimeError("anything")
        R.species_groups_only = boom
        out, _ = R.claude_after_run("X", "SC", [], "_reports", None)
        self.assertFalse(out["ok"])
        self.assertIn("RuntimeError", out["error"])


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


# ── SPECIES THE REPORTS SHOW AND THE LIST DOES NOT ──────────────────────────────────────────────
# Lakes part 1, 2026-09-25: Lake Greenwood and Lake Blalock came back with one species each, because
# their roster was ['Largemouth Bass'], while Greenwood's own AHQ reports are about crappie, hybrids
# and catfish. Ryan approved letting the step add a fish a first-hand report shows being caught.

PERCH_Q = ("White perch are schooling on the humps and anglers are catching them on small spoons "
           "in 20-30 feet of water.")
REPORT = {"title": "AHQ INSIDER Lake Murray (SC) Week 12", "url": "https://a.example/ahq12",
          "fullText": "October 9\n\n" + PERCH_Q + " Stripers are still up the river.\n" + "x " * 120}
PERCH = {"species": "White Perch", "evidenceQuote": PERCH_Q, "spring": None,
         "summer": None, "fall": entry(PERCH_Q, None, [20, 30], "bottom"), "winter": None}


class SpeciesFromReports(unittest.TestCase):
    DOCS2 = DOCS + [REPORT]

    def test_a_fish_the_reports_show_is_added_with_its_quote(self):
        added, ev, problems = C.check_discovered([PERCH], ROSTER, self.DOCS2)
        self.assertEqual(list(added), ["White Perch"])
        self.assertEqual(added["White Perch"]["fall"]["waterDepthFt"], [20, 30])
        self.assertEqual(ev["White Perch"]["url"], "https://a.example/ahq12")
        self.assertEqual(problems, [])

    def test_a_fish_already_on_the_roster_is_not_added_again(self):
        for name, on in (("Black Crappie", "Crappie"), ("Striped Bass", "Striped Bass"),
                         ("Channel Catfishes", "Channel Catfish")):
            added, _, problems = C.check_discovered([{**PERCH, "species": name}], ROSTER, self.DOCS2)
            self.assertEqual(added, {}, name)
            self.assertIn(f"already answered as {on}", problems[0])
        # A group on the roster covers its members; a hybrid is not the species it is crossed from.
        self.assertIsNone(C.same_fish_on_roster("Hybrid Striped Bass", ["Striped Bass"]))
        self.assertEqual(C.same_fish_on_roster("Shellcracker", ["Redear Sunfish (Shellcracker)"]),
                         "Redear Sunfish (Shellcracker)")

    def test_the_evidence_is_verbatim_and_names_the_fish(self):
        off = {**PERCH, "evidenceQuote": "White perch are everywhere this fall."}
        added, _, problems = C.check_discovered([off], ROSTER, self.DOCS2)
        self.assertEqual(added, {})
        self.assertIn("not in any stored document", problems[0])
        # Verbatim, but about the stripers: it does not show a white perch being caught.
        other = {**PERCH, "evidenceQuote": "Stripers are still up the river."}
        added, _, problems = C.check_discovered([other], ROSTER, self.DOCS2)
        self.assertEqual(added, {})
        self.assertIn("does not name the fish", problems[0])
        self.assertTrue(C.names_the_fish("stripers on the points", "Striped Bass"))
        self.assertTrue(C.names_the_fish("the hybrids are busting shad", "Hybrid Striped Bass"))
        self.assertFalse(C.names_the_fish("bass on the points", "White Perch"))

    def test_a_fish_with_no_season_that_passes_is_not_added(self):
        bad = {**PERCH, "fall": entry(PERCH_Q, [5, 10], None)}      # 5 and 10 are not in the quote
        added, _, problems = C.check_discovered([bad], ROSTER, self.DOCS2)
        self.assertEqual(added, {})
        self.assertTrue(any("-- dropped" in p for p in problems))
        self.assertTrue(any("no season entry passed" in p for p in problems))

    def test_the_schema_asks_for_them(self):
        s = C.schema_for(ROSTER)
        self.assertIn("discoveredSpecies", s["required"])
        item = s["properties"]["discoveredSpecies"]["items"]
        self.assertEqual(item["required"], ["species", "evidenceQuote", *C.SEASONS])
        self.assertIn("SPECIES NOT ON THE LIST", C.RULES)


class SpeciesFromReportsSaved(unittest.TestCase):
    def setUp(self):
        self._req, self.reg, self._ask = R._req, R.REGISTRY_DIR, C.ask_claude
        R.REGISTRY_DIR = None
        self._td = tempfile.TemporaryDirectory()
        self.saved = []

        def req(path, payload=None, timeout=300):
            if path.startswith("/research/get?"):
                return 200, {"ok": True, "profile": json.loads(json.dumps(PROFILE))}, None
            if path.startswith("/research/get-normalized"):
                return 200, {"documents": DOCS + [REPORT]}, None
            if path == "/research/save":
                self.saved.append(payload)
                return 200, {"ok": True}, None
            return 404, None, "unexpected " + path
        R._req = req
        C.ask_claude = lambda packet, roster, model=None, timeout=None, run=None: (
            json.loads(json.dumps(GOOD)), {"model": "claude-sonnet-5", "seconds": 1.0,
                                           "discovered_raw": [PERCH]})

    def tearDown(self):
        R._req, R.REGISTRY_DIR, C.ask_claude = self._req, self.reg, self._ask
        self._td.cleanup()

    def test_saving_adds_it_to_the_roster_and_marks_it(self):
        r, paths = R.species_groups_only("Lake Murray, SC", "SC", "claude", save=True,
                                         report_dir=self._td.name)
        self.assertTrue(r["saved"], r)
        self.assertEqual(r["added_species"], ["White Perch"])
        p = self.saved[0]["profile"]
        self.assertEqual(list(p["trollingIntelligence"]), ROSTER + ["White Perch"])
        self.assertEqual(p["biology"]["predatorSpecies"], ROSTER + ["Black Crappie", "White Perch"])
        mark = p["biology"]["_speciesFromReports"]["White Perch"]
        self.assertEqual(mark["quote"], PERCH_Q)
        self.assertIn("--group-models claude", mark["by"])
        self.assertNotIn("_speciesDiscoveredBy", p["biology"])
        with open(paths[1], encoding="utf-8") as f:
            self.assertIn("Species added from first-hand reports", f.read())
        with open(paths[0], encoding="utf-8") as f:
            self.assertIn("White Perch", json.load(f)["added_species"])

    def test_a_mark_for_a_species_no_longer_answered_is_taken_off(self):
        prof = json.loads(json.dumps(PROFILE))
        prof["biology"]["_speciesFromReports"] = {"Bowfin": {"quote": "q"}, "Crappie": {"quote": "q"}}
        self.assertIsNone(R._save_section("Lake Murray, SC", prof, GOOD, "test"))
        self.assertEqual(list(self.saved[0]["profile"]["biology"]["_speciesFromReports"]), ["Crappie"])


if __name__ == "__main__":
    unittest.main()
