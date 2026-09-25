#!/usr/bin/env python3
"""fetch_sources() stores a fetched page as its text, with its lines, and a PDF as a PDF.

Personal use only, not for distribution or resale; not for navigation.

/research/proxy-download-batch's Scrape.do fallback now sends a page back as its HTML, because
turning it into text does not fit the Worker's 10 ms of CPU, and sends a PDF -- named by its
Content-Type or its bytes, not its URL -- back as not handled, with reason 'pdf'. This drives
fetch_sources() with the Worker mocked, on the pages fetched byte-exact in
test/fixtures/fetched-pages, and looks at what it would store.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'Scripts' / 'research_lakes.py'
FIX = ROOT / 'test' / 'fixtures' / 'fetched-pages'
SOURCES = json.loads((FIX / 'sources.json').read_text(encoding='utf-8'))

GREENWOOD = 'lakegreenwoodfishing-report-2026-09-06.html'
PDF = 'ncwrc-inland-fishing-regulations.pdf.head'
PDF_URL = SOURCES[PDF]['url']
PAGE_URL = SOURCES[GREENWOOD]['url']


def load_module():
    spec = importlib.util.spec_from_file_location('research_lakes_fetch_under_test', SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def old_strip(html):
    import re
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', html)).strip()


@unittest.skipUnless(shutil.which('node'), 'node runs js/utils/html-text.js, and it is not on PATH')
class AFetchedPageKeepsItsLines(unittest.TestCase):

    def run_fetch(self, batch_results, raw_answers=None, existing=None, sources=None):
        mod = load_module()
        calls = {'batch': [], 'raw': []}

        def fake_req(path, payload=None, timeout=300):
            calls['batch'].append(payload)
            return 200, {'ok': True, 'results': batch_results}, None

        def fake_raw(path, timeout=300):
            calls['raw'].append(path)
            for key, answer in (raw_answers or {}).items():
                if key in path:
                    return answer
            return 404, None, None, 'not mocked', ''

        mod._req = fake_req
        mod._raw = fake_raw
        mod.pdf_text = lambda data: ('15A NCAC 10C .0205 PUBLIC MOUNTAIN TROUT WATERS\n' * 20
                                     if data.startswith(b'%PDF-') else '')
        sources = sources or [{'url': PAGE_URL, 'title': 'Greenwood report'},
                              {'url': PDF_URL, 'title': 'NC Inland Fishing Regulations'}]
        docs, stats = mod.fetch_sources('Lake Greenwood', sources, existing or [], repo=str(ROOT))
        return docs, stats, calls

    def test_the_fallbacks_html_is_stored_as_text_with_lines(self):
        html = (FIX / GREENWOOD).read_text(encoding='utf-8')
        docs, stats, _ = self.run_fetch(
            [{'url': PAGE_URL, 'text': '', 'html': html, 'source': 'scrapedo', 'ok': True}],
            sources=[{'url': PAGE_URL, 'title': 'Greenwood report'}])
        self.assertEqual(stats['html_ok'], 1)
        text = docs[0]['fullText']
        lines = text.split('\n')
        self.assertGreater(len(lines), 50)
        self.assertEqual(lines[0], 'Lake Greenwood Fishing Report Sep 6th, 2026 - Lake Greenwood Fishing')
        self.assertIn('The Mozingos from Hodges, South Carolina, had a great day striper fishing on '
                      'Lake Greenwood today.', text)
        self.assertNotIn('@context', text)

    def test_an_item_returned_as_a_pdf_reaches_the_pdf_path(self):
        pdf = (FIX / PDF).read_bytes()
        docs, stats, calls = self.run_fetch(
            [{'url': PDF_URL, 'text': '', 'source': 'unhandled', 'ok': False, 'reason': 'pdf'}],
            raw_answers={'proxy-download?url=': (200, pdf, 'application/pdf', None, '')},
            sources=[{'url': PDF_URL, 'title': 'NC Inland Fishing Regulations'}])
        self.assertEqual(len(calls['raw']), 1, 'it never reached the one-at-a-time path')
        self.assertIn('&type=PDF', calls['raw'][0], 'asked for as HTML, the Worker would scrape it as a page')
        self.assertEqual(stats['pdf_ok'], 1)
        self.assertTrue(docs[0]['fullText'].startswith('15A NCAC 10C .0205'))

    def test_a_pdf_asked_for_as_one_that_comes_back_as_text_is_kept_as_text(self):
        """TinyFish reads a PDF's text itself and sends it as text/plain; pypdf must not get it."""
        text = '15A NCAC 10C .0205 PUBLIC MOUNTAIN TROUT WATERS 3\n(a) For purposes of this Rule\n' * 10
        docs, stats, _ = self.run_fetch(
            [{'url': PDF_URL, 'text': '', 'source': 'unhandled', 'ok': False, 'reason': 'pdf'}],
            raw_answers={'proxy-download?url=': (200, text.encode(), 'text/plain; charset=utf-8', None, 'tinyfish')},
            sources=[{'url': PDF_URL, 'title': 'NC Inland Fishing Regulations'}])
        self.assertEqual(stats['html_ok'], 1)
        self.assertEqual(docs[0]['fullText'], text)

    def test_results_are_paired_by_url_not_position(self):
        html = (FIX / GREENWOOD).read_text(encoding='utf-8')
        docs, _, calls = self.run_fetch([
            {'url': PDF_URL, 'text': '', 'source': 'unhandled', 'ok': False, 'reason': 'pdf'},
            {'url': PAGE_URL, 'text': '', 'html': html, 'source': 'scrapedo', 'ok': True},
        ], raw_answers={'proxy-download?url=': (200, (FIX / PDF).read_bytes(), 'application/pdf', None, '')})
        by_url = {d['url']: d for d in docs}
        self.assertTrue(by_url[PAGE_URL]['fullText'].startswith('Lake Greenwood Fishing Report'))
        self.assertTrue(by_url[PDF_URL]['fullText'].startswith('15A NCAC'))

    def test_every_stored_copy_says_where_its_text_came_from(self):
        html = (FIX / GREENWOOD).read_text(encoding='utf-8')
        page_doc = self.run_fetch(
            [{'url': PAGE_URL, 'text': '', 'html': html, 'source': 'scrapedo', 'ok': True}],
            sources=[{'url': PAGE_URL, 'title': 'Greenwood report'}])[0][0]
        self.assertEqual(page_doc['fetchedBy'], 'scrapedo')
        pdf_doc = self.run_fetch(
            [{'url': PDF_URL, 'text': '', 'source': 'unhandled', 'ok': False, 'reason': 'pdf'}],
            raw_answers={'proxy-download?url=': (200, (FIX / PDF).read_bytes(), 'application/pdf', None, 'tinyfish')},
            sources=[{'url': PDF_URL, 'title': 'regs'}])[0][0]
        self.assertEqual(pdf_doc['fetchedBy'], 'pdf')
        text = 'Rule text\n' * 40
        text_doc = self.run_fetch(
            [{'url': PDF_URL, 'text': '', 'source': 'unhandled', 'ok': False, 'reason': 'pdf'}],
            raw_answers={'proxy-download?url=': (200, text.encode(), 'text/plain', None, 'tinyfish')},
            sources=[{'url': PDF_URL, 'title': 'regs'}])[0][0]
        self.assertEqual(text_doc['fetchedBy'], 'tinyfish', "proxy-download's X-Source")

    def test_a_copy_stored_before_the_fix_is_fetched_again_whatever_its_age(self):
        """No `fetchedBy`: flat, or another URL's text. Neither can be told from the text alone."""
        html = (FIX / GREENWOOD).read_text(encoding='utf-8')
        fresh = '2099-01-01T00:00:00'   # newer than any TTL could expire
        before_fix = [
            {'url': PAGE_URL, 'fullText': old_strip(html), 'fetchedAt': fresh},
            # misfiled: lines, looks fine, and is a bald-eagle thread under a fishing report's URL
            {'url': PDF_URL, 'fullText': 'r/whatsthisbird\nBald eagle over the lake?\n', 'fetchedAt': fresh},
        ]
        _, stats, calls = self.run_fetch(
            [{'url': PAGE_URL, 'text': '', 'html': html, 'source': 'scrapedo', 'ok': True},
             {'url': PDF_URL, 'text': '', 'source': 'unhandled', 'ok': False, 'reason': 'pdf'}],
            raw_answers={'proxy-download?url=': (200, (FIX / PDF).read_bytes(), 'application/pdf', None, '')},
            existing=before_fix)
        self.assertEqual(stats['reused'], 0)
        self.assertEqual(len(calls['batch']), 1)

    def test_a_stamped_copy_is_reused_by_ttl_even_if_it_is_one_line(self):
        fresh = '2099-01-01T00:00:00'
        stamped = [{'url': PAGE_URL, 'fullText': 'A page that really is one line.',
                    'fetchedAt': fresh, 'fetchedBy': 'tinyfish'}]
        _, stats, calls = self.run_fetch([], existing=stamped,
                                         sources=[{'url': PAGE_URL, 'title': 'Greenwood report'}])
        self.assertEqual(stats['reused'], 1)
        self.assertEqual(calls['batch'], [])


if __name__ == '__main__':
    unittest.main()
