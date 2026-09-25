#!/usr/bin/env python3
r"""test_extract_window.py -- extraction reads the part of a long document that is about this water.

    py .\scripts\test_extract_window.py

Personal use only, not for distribution or resale; not for navigation.

research_lakes.py sent every document to /research/analyze-facts cut to its first EXTRACT_DOC_CHARS,
and the extractor takes only facts that name the water. Measured on the desktop on 2026-09-25 over
1,677 stored documents of 84 waters: 69 named the water only past the cut. These hold the window
(water_sections.window(), through research_lakes.doc_window()) to what it must do, on real text
fetched 2026-09-25 (test/fixtures/extract-window/README.md) and on the stored copies: send the water's section when it lies
past the cut, send exactly what was sent before when the document fits or names the water in its
own title, and date every fact of a windowed document as the whole document would -- which is
checked by running the Worker's own research/text-date.js in node on both.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import research_lakes as R                                    # noqa: E402
import water_sections as W                                    # noqa: E402

REPO = os.path.dirname(HERE)
FIX = os.path.join(REPO, "test", "fixtures")
CUT = R.EXTRACT_DOC_CHARS


def fixture(*parts):
    # A Windows checkout turns the fixtures' line ends into CRLF; the pages came with LF.
    with open(os.path.join(FIX, *parts), encoding="utf-8") as f:
        return f.read().replace("\r\n", "\n")


PARR = {"title": "2007 Statewide Research – Freshwater Fisheries Job Progress",
        "url": "https://www.dnr.sc.gov/fish/fwfi/files/2007_annual_report.pdf",
        "fullText": fixture("extract-window", "scdnr-2007-parr.md"),
        "fetchedAt": "2026-09-25T17:30:00Z"}
JORDAN = {"title": "Understanding North Carolina reservoir striped bass and bodie bass anglers",
          "url": "https://www.ncwildlife.gov/fishing/understanding-north-carolina-reservoir-"
                 "striped-bass-and-bodie-bass-anglers/download?attachment",
          "fullText": fixture("extract-window", "nc-reservoir-striped-bass-jordan.md"),
          "fetchedAt": "2026-09-25T17:30:00Z"}
AHQ = {"title": "AHQ INSIDER Lake Wateree (SC) 2026 Week 9 Fishing Report – Updated February 25",
       "url": "https://www.anglersheadquarters.com/blogs/ahq-report/ahq-insider-lake-wateree-sc-"
              "2026-week-9-fishing-report-updated-february-25",
       "fullText": fixture("text-date", "ahq-wateree-2026-week-9.md"),
       "fetchedAt": "2026-09-25T15:33:46Z"}

CASES = ((PARR, "Parr Reservoir, SC", "Parr"),
         (JORDAN, "LAKE JORDAN, NC", "Jordan"))


def names(text, word):
    return len(re.findall(r"\b" + word + r"\b", text, re.I))


class TheSectionPastTheCutIsSent(unittest.TestCase):
    def test_every_fixture_is_longer_than_the_cut_with_the_water_past_it(self):
        for doc, _, word in CASES:
            t = doc["fullText"]
            self.assertGreater(len(t), CUT, word)
            self.assertEqual(names(t[:CUT], word), 0, word)
            self.assertGreater(names(t, word), 0, word)

    def test_the_waters_section_is_sent_where_the_first_cut_sent_none_of_it(self):
        # BEFORE: the first 20,000 characters, with no mention of the water in them. AFTER: the
        # sections that name it. Measured on these fixtures (the PR lists them):
        #   Parr      0 -> 10,654 characters in sections naming Parr, 17 mentions
        #   Jordan    0 -> 743, the survey's paragraph listing Jordan Lake
        for doc, lake, word in CASES:
            text, info = R.doc_window(doc, lake, [], CUT)
            self.assertTrue(info["windowed"], word)
            self.assertLessEqual(len(text), CUT, word)
            self.assertEqual(info["named_first_cut"], 0, word)
            self.assertGreater(info["named_sent"], 0, word)
            self.assertGreater(names(text, word), 0, word)
        text, _ = R.doc_window(PARR, "Parr Reservoir, SC", [], CUT)
        self.assertIn("All of the species from below Parr Reservoir were also found in the reservoir.",
                      text)

    def test_every_piece_sent_is_verbatim_and_in_document_order(self):
        for doc, lake, word in CASES:
            full = doc["fullText"]
            text, _ = R.doc_window(doc, lake, [], CUT)
            at = 0
            for piece in text.split(W.BREAK):
                i = full.find(piece, at)
                self.assertGreaterEqual(i, 0, (word, piece[:80]))
                at = i + len(piece)

    def test_the_head_is_the_top_of_the_page(self):
        for doc, lake, word in CASES:
            text, _ = R.doc_window(doc, lake, [], CUT)
            self.assertEqual(text[:W.TOP_OF_PAGE], doc["fullText"][:W.TOP_OF_PAGE], word)

    def test_the_species_step_is_offered_the_same_window(self):
        sent = R.agent_documents([PARR, JORDAN], "Parr Reservoir, SC", [])
        self.assertEqual(sent[0]["text"], R.doc_window(PARR, "Parr Reservoir, SC", [],
                                                       R.LLM_DOC_CHARS)[0])
        self.assertGreater(names(sent[0]["text"], "Parr"), 0)
        # The NC survey does not name Parr: cut as it always was.
        self.assertEqual(sent[1]["text"], JORDAN["fullText"][:R.LLM_DOC_CHARS])

    def test_a_statewide_report_the_size_of_the_regulations_book_is_cheap(self):
        # The SC regulations book is 475,009 characters. This runs on the desktop, before the call;
        # nothing of it reaches the Worker's 10 ms. Ten copies of the Parr report is that size.
        import time
        big = dict(PARR, fullText=PARR["fullText"] * 10)
        t0 = time.perf_counter()
        text, info = R.doc_window(big, "Parr Reservoir, SC", [], CUT)
        self.assertTrue(info["windowed"])
        self.assertLess(time.perf_counter() - t0, 5.0)


class WhatWasSentBeforeIsSentStill(unittest.TestCase):
    def test_a_document_that_fits_is_sent_unchanged(self):
        t = AHQ["fullText"]
        self.assertLess(len(t), CUT)
        text, info = R.doc_window(AHQ, "Lake Wateree, SC", [], CUT)
        self.assertEqual(text, t)
        self.assertFalse(info["windowed"])

    def test_a_document_whose_own_title_names_the_water_is_its_first_cut(self):
        doc = dict(JORDAN, title="Jordan Lake striped bass anglers")
        text, info = R.doc_window(doc, "LAKE JORDAN, NC", [], CUT)
        self.assertEqual(text, doc["fullText"][:CUT])
        self.assertFalse(info["windowed"])
        doc = dict(PARR, url="https://example.org/parr-reservoir-2007.pdf")
        self.assertEqual(R.doc_window(doc, "Parr Reservoir, SC", [], CUT)[0],
                         PARR["fullText"][:CUT])

    def test_a_title_the_pipeline_wrote_does_not_count(self):
        # discover.js line ~1022: `${lakeName} — ${authority} (via Grokipedia citation)`. The name
        # in it is the pipeline's, not the page's.
        for how in ("Grokipedia", "Wikipedia"):
            doc = dict(PARR, title=f"Parr Reservoir, SC — SCDNR (via {how} citation)")
            text, info = R.doc_window(doc, "Parr Reservoir, SC", [], CUT)
            self.assertTrue(info["windowed"], how)
            self.assertGreater(names(text, "Parr"), 0)

    def test_a_document_no_section_of_which_names_the_water_is_its_first_cut(self):
        text, info = R.doc_window(PARR, "Lake Hartwell, SC", [], CUT)
        self.assertEqual(text, PARR["fullText"][:CUT])
        self.assertFalse(info["windowed"])

    def test_no_water_named_is_the_first_cut(self):
        self.assertEqual(R.agent_documents([PARR])[0]["text"], PARR["fullText"][:R.LLM_DOC_CHARS])

    def test_the_run_reports_how_many_were_windowed_and_what_named_the_water(self):
        docs = [PARR, JORDAN, AHQ]
        infos = [R.doc_window(d, "Parr Reservoir, SC", [], CUT)[1] for d in docs]
        s = R.window_summary(infos, docs)
        self.assertEqual(s["windowed"], 1)
        self.assertEqual(s["named_first_cut"], 0)
        self.assertEqual(s["named_sent"], infos[0]["named_sent"])
        self.assertIn("window: 1 doc(s)", R.window_note({"extract_window": s}))
        self.assertEqual(R.window_note({"extract_window": R.window_summary([{}], [AHQ])}), "")

    def test_extraction_sends_the_window_and_counts_it(self):
        sent = []

        def fake_req(path, body):
            sent.append(body["documents"][0]["text"])
            return 200, {"extracted_facts": [], "meta": {"docResults": []}}, None
        real, R._req = R._req, fake_req
        try:
            stats = {}
            R.extract_documents("Parr Reservoir, SC", "SC", [], [PARR, AHQ], rpm=0, tpm=0,
                                window_stats=stats)
        finally:
            R._req = real
        self.assertIn(R.doc_window(PARR, "Parr Reservoir, SC", [], CUT)[0], sent)
        self.assertIn(AHQ["fullText"], sent)
        self.assertEqual(stats["windowed"], 1)


class TheDesktopsFourChanges(unittest.TestCase):
    """PR #68 measured on 1,677 stored documents, 2026-09-25: four changes, each held here."""

    def test_the_head_is_the_top_of_the_page_not_the_first_section(self):
        # 1. The head ended at the first section break, which in 16 of the 69 documents naming the
        # water only past the cut lay past the cut too (Hartwell 2013: 84,691). It now ends at the
        # line holding the TOP_OF_PAGE-th character as text-date.js reads it.
        for doc, lake, word in CASES:
            text, _ = R.doc_window(doc, lake, [], CUT)
            head = text.split(W.BREAK)[0]
            end = W._head_end(doc["fullText"], CUT)
            self.assertTrue(head.startswith(doc["fullText"][:end]), word)
            self.assertEqual(end, doc["fullText"].find("\n", W.TOP_OF_PAGE), word)   # no links

    def test_the_top_of_the_page_is_counted_without_its_links(self):
        # A SCDNR board packet sent for Lake Bowen: its top is thick with addresses, so text-date.js's
        # first 4,000 characters, counted after delinking, run past character 4,000 of the text. A
        # head cut at 4,000 let a later "May 20, 2021" line into the read top and dated the cover.
        # The AHQ page's top is links too.
        for doc in (AHQ, PARR, JORDAN):
            full = doc["fullText"]
            end = W._head_end(full, len(full))
            self.assertEqual(W._delink(full[:end])[:W.TOP_OF_PAGE], W._delink(full)[:W.TOP_OF_PAGE])
            self.assertGreaterEqual(len(W._delink(full[:end])), W.TOP_OF_PAGE)
        # The packet's cover, in the shape it had: the AHQ page's own navigation line (a real line,
        # 70 characters of it an address) above a top 4,000 characters long, then a date line.
        # Counted in stored characters the head ends before the date line's section is reached in
        # the read top; counted as text-date.js counts, it runs on past the addresses.
        nav = AHQ["fullText"].split("\n")[0]
        cover = "\n".join([nav] * (W.TOP_OF_PAGE // len(nav) + 1)) + "\nMay 20, 2021\n"
        end = W._head_end(cover, len(cover))
        self.assertGreater(end, cover.find("\n", W.TOP_OF_PAGE))
        self.assertEqual(W._delink(cover[:end])[:W.TOP_OF_PAGE], W._delink(cover)[:W.TOP_OF_PAGE])

    def test_a_section_longer_than_the_cut_is_broken_at_its_blank_lines(self):
        # 2. A 60,000-character section naming the water near its end was sent from its start.
        # The 2007 job report has no heading at all, so it is one section of 47,817 characters:
        # read by its paragraphs when it is longer than the cut, as it is.
        g = PARR["fullText"]
        units = W._units(g)
        whole = W.sections(g, units)[2]
        split = W.sections(g, units, paragraphs_past=CUT // 4)[2]
        self.assertLess(len(whole), len(split))
        self.assertTrue(set(whole) <= set(split))
        self.assertEqual(W.sections(g, units, paragraphs_past=len(g))[2], whole)

    def test_a_date_line_is_a_whole_line(self):
        # 3. Blalock's FY2016-17 accountability report, as stored. _units() cuts after ". ", and the
        # unit "(June 30, 2015)." counted as the date line above a section; sent after a BREAK it
        # stood alone and dated 313 sentences the whole report leaves undated.
        text = ("The regulation shall take effect on the first day of July following the effective "
                "date of the section. (June 30, 2015).\nFish attractors were placed in Lake Blalock.\n")
        units = W._units(text)
        self.assertTrue(any(W._DATE_LINE.match(text[a:b].strip()) for a, b in units))
        heads, dates, bounds = W.sections(text, units)
        self.assertEqual(dates, [])
        self.assertEqual(bounds, [0, len(units)])
        ahq = AHQ["fullText"]
        u = W._units(ahq)
        self.assertEqual([ahq[u[i][0]:u[i][1]].strip() for i in W.sections(ahq, u)[1]],
                         [ln.strip() for ln in ahq.split("\n") if W._DATE_LINE.match(ln.strip())])

    def test_a_window_is_sent_only_when_it_carries_more_of_the_water(self):
        # 4. Its date lines and breaks take room: 24 stored windows carried less of the water than
        # the first cut (Falls Lake's NCWRC fishing reports, 12,919 -> 7,880). Every lake the job
        # report and the NC survey name, as the water: a window, where one is sent, carries more.
        n = 0
        for doc in (PARR, JORDAN):
            g = doc["fullText"]
            for term in sorted(set(re.findall(r"\b(?:Lake|LAKE) ([A-Z][a-z]+(?: [A-Z][a-z]+)*)", g))):
                _, info = W.window(g, "x", "y", [term], CUT)
                n += info["windowed"]
                if info["windowed"]:
                    self.assertGreater(info["named_sent"], info["named_first_cut"], term)
                else:
                    self.assertEqual(info["named_sent"], info["named_first_cut"], term)
        self.assertGreater(n, 0)

    def test_a_document_on_one_line_is_its_first_cut(self):
        # KNOWN GAP. The stored Georgia report of 2025-07-18 is 83,459 characters on one line; 82
        # of the 423 long stored documents are like it (fishbrain.com, nepis.epa.gov,
        # grokipedia.com, ncwildlife.gov). There is no line to end a head at and no section to
        # find, so it goes as its first cut, as before. Why they were stored flat is a separate,
        # upstream question. The stored copy itself is in STORED_CASES; this is the job report laid
        # flat the same way.
        flat = dict(PARR, fullText=re.sub(r"\s*\n\s*", " ", PARR["fullText"]))
        self.assertNotIn("\n", flat["fullText"])
        text, info = R.doc_window(flat, "Parr Reservoir, SC", [], CUT)
        self.assertFalse(info["windowed"])
        self.assertEqual(text, flat["fullText"][:CUT])


# THE STORED COPIES, as /research/get-normalized returns them. The cloud session that wrote this
# could not reach workers.dev; the desktop commits them. Until then these are reported skipped.
STORED = os.path.join(FIX, "extract-window", "stored")
STORED_CASES = (  # file, water, windowed?
    ("hartwell-2013-fisheries-investigations.json", "Lake Hartwell, SC", True),
    ("blalock-fy2016-17-accountability-report.json", "Lake Blalock, SC", True),
    ("thurmond-sc-freshwater-fishing-regulations.json", "Lake Thurmond, SC", True),
    ("ocmulgee-ga-fishing-report-2025-07-18.json", "Ocmulgee River, GA", False),
    ("bowen-2021-board-meeting-agenda.json", "Lake Bowen, SC", True),
)


def stored(name):
    with open(os.path.join(STORED, name), encoding="utf-8") as f:
        d = json.load(f)
    d["fullText"] = d["fullText"].replace("\r\n", "\n")
    return d


class TheStoredCopies(unittest.TestCase):
    def test_each_stored_copy_is_windowed_as_measured_and_dated_as_the_whole(self):
        for name, lake, windowed in STORED_CASES:
            with self.subTest(name):
                if not os.path.exists(os.path.join(STORED, name)):
                    self.skipTest(f"{name} is not in the checkout: the desktop commits it from "
                                  "/research/get-normalized")
                d = stored(name)
                self.assertGreater(len(d["fullText"]), CUT)
                text, info = R.doc_window(d, lake, d.get("aliases") or [], CUT)
                self.assertEqual(info["windowed"], windowed, info["why"])
                if windowed:
                    self.assertGreater(info["named_sent"], info["named_first_cut"])
                    if NODE:
                        AWindowIsDatedAsTheWholeDocument.same_dates(self, d, text,
                                                                    skip_repeated=True)
                else:
                    self.assertEqual(text, d["fullText"][:CUT])


class ONE_RULE(unittest.TestCase):
    def test_the_packet_and_the_window_read_the_same_functions(self):
        import claude_species as C
        for name in ("_units", "_is_heading", "_DATE_LINE", "_names_water", "water_terms",
                     "title_names_water", "sections", "TOP_OF_PAGE"):
            self.assertIs(getattr(C, name), getattr(W, name), name)

    def test_the_top_of_the_page_and_the_date_line_are_the_workers(self):
        with open(os.path.join(REPO, "Worker", "research", "text-date.js"), encoding="utf-8") as f:
            js = f.read()
        self.assertEqual(int(re.search(r"const TOP_OF_PAGE = (\d+)", js).group(1)), W.TOP_OF_PAGE)
        month = re.search(r"const MONTH = String\.raw`([^`]*)`", js).group(1)
        self.assertEqual(month, W._MONTH)


# ── A WINDOW DATES A FACT AS THE WHOLE DOCUMENT WOULD ──────────────────────────────────────────

NODE = shutil.which("node")
_DATER = r"""
import {readFileSync} from 'node:fs';
const {textDateOf, readPage} = await import(process.argv[1]);
const cases = JSON.parse(readFileSync(0, 'utf8'));
const out = cases.map(({doc, quotes}) => {
  const page = readPage(doc);
  return quotes.map((q) => textDateOf({quote: q}, doc, page));
});
process.stdout.write(JSON.stringify(out));
"""


def text_dates(cases):
    """research/text-date.js's textDateOf for each quote, run in node on the Worker's own module."""
    src = "file://" + os.path.join(REPO, "Worker", "research", "text-date.js").replace(os.sep, "/")
    r = subprocess.run([NODE, "--input-type=module", "-e", _DATER, src],
                       input=json.dumps(cases), capture_output=True, text=True, encoding="utf-8",
                       check=True)
    return json.loads(r.stdout)


def quotes_of(text):
    """Every sentence-ish piece of the text sent, as the quotes a model could return from it."""
    return [piece[a:b] for piece in text.split(W.BREAK) for a, b in W._units(piece)
            if len(re.sub(r"[^a-z0-9]+", " ", piece[a:b].lower()).strip()) >= 12]


@unittest.skipUnless(NODE, "node is not on this machine: the dating check runs text-date.js in node")
class AWindowIsDatedAsTheWholeDocument(unittest.TestCase):
    def same_dates(self, doc, text, skip_repeated=False):
        """Every sentence sent is dated as in the whole document. With `skip_repeated`, the two
        differences the desktop measured as right are left out: a sentence the page prints more
        than once (the window dates the copy it sends) and a quote that is itself a date line."""
        qs = quotes_of(text)
        if skip_repeated:
            full_norm = re.sub(r"[^a-z0-9]+", " ", doc["fullText"].lower())
            qs = [q for q in qs if full_norm.count(re.sub(r"[^a-z0-9]+", " ", q.lower()).strip()) <= 1
                  and not W._DATE_LINE.match(q.strip())]
        self.assertTrue(qs)
        full, windowed = text_dates([{"doc": {**doc, "text": doc["fullText"]}, "quotes": qs},
                                     {"doc": {**doc, "text": text}, "quotes": qs}])
        for q, a, b in zip(qs, full, windowed):
            self.assertEqual(a, b, q[:80])
        return dict(zip(qs, windowed))

    def test_ahq_the_year_is_counted_through_the_pages_order_when_entries_are_skipped(self):
        # The AHQ page (6,825 characters) is shorter than the cut, so the cut here falls at this
        # water's first mention, as Parr's fell 93,713 characters into its report. The water is
        # Colonel Creek, named only in the December 23 entry; the page's title does not name it.
        # The head runs to January 29. January 8 comes between the head and the kept entry and is
        # skipped, and October 16, 8 and 2 come after it and are skipped -- their date lines are
        # sent, their text is not.
        doc = dict(AHQ, title="AHQ INSIDER 2026 Week 9 Fishing Report – Updated February 25")
        full = doc["fullText"]
        cut = full.index("Colonel Creek")
        text, info = W.window(full, doc["title"], doc["url"], ["Colonel Creek"], cut)
        self.assertTrue(info["windowed"])
        self.assertIn("Colonel Creek", text)
        for skipped in ("The **crappie** bite is pretty phenomenal right now",   # January 8
                        "Fish Stalker Slab Tail Jigs in chartreuse"):            # October 16 and 8
            self.assertIn(skipped, full)
            self.assertNotIn(skipped, text)
        # Every date line of the page is sent, in the page's order.
        lines = [ln.strip() for ln in full.split("\n") if W._DATE_LINE.match(ln.strip())]
        self.assertEqual([ln.strip() for ln in text.split("\n") if W._DATE_LINE.match(ln.strip())],
                         lines)
        dated = self.same_dates(doc, text)
        hump = next(q for q in dated if "Colonel Creek" in q)
        self.assertEqual(dated[hump]["textDate"], "2025-12-23")
        self.assertRegex(dated[hump]["textDateFrom"], r'^date line above the quote: "December 23"; '
                                                      r'year from .*newest-first order')

    def test_every_sentence_sent_is_dated_as_in_the_full_document(self):
        for doc, lake, word in CASES:
            text, info = R.doc_window(doc, lake, [], CUT)
            self.assertTrue(info["windowed"], word)
            self.same_dates(doc, text)


if __name__ == "__main__":
    unittest.main()
