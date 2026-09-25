// A fetched page is stored as its text, with its lines -- not as its stripped source.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Measured on the desktop on 2026-09-25 over 1,677 stored documents of 84 waters: 279 had no line
// break at all, holding 12.6 of 55.7 million characters. They began with the Google Tag Manager
// snippet (SCDNR), WordPress CSS and `&#8211;` (the Edgefield Advertiser), a JSON-LD block (Lake
// Greenwood Fishing) -- and the NCWRC Inland Fishing Regulations were stored as the PDF's bytes,
// because their URL has no `.pdf`. All four came from /research/proxy-download-batch's Scrape.do
// fallback:
//
//     html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
//
// These tests run the real pages, fetched byte-exact on the desktop (test/fixtures/fetched-pages).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { htmlToText, isPdfBody, isFlatText, decodeEntities } from '../js/utils/html-text.js';
import { readBatchResults } from '../js/utils/fetch-batch.js';
import { handleResearchProxyDownloadBatch } from '../Worker/research/download.js';
import { textDateOf } from '../Worker/research/text-date.js';

const FIX = new URL('./fixtures/fetched-pages/', import.meta.url);
// The folder is byte-exact (`* -text`); a checkout that still turned LF into CRLF is undone here.
const page = (f) => readFileSync(new URL(f, FIX), 'utf8').replace(/\r\n/g, '\n');
const bytes = (f) => new Uint8Array(readFileSync(new URL(f, FIX)));
const SOURCES = JSON.parse(page('sources.json'));
const OLD = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const PAGES = {
  'scdnr-news-freshwater.html': {
    first: 'SCDNR - News Releases - Freshwater Fishing Trends',
    source: ["'gtm.start'", 'googletagmanager', 'dataLayer', 'function(w,d,s,l,i)'],
    says: [
      'Information on fishing trends provided courtesy of www.anglersheadquarters.com/ , South Carolina\'s premier fishing report source',
      'Black bass: Guide Jerry Kotal (706-988-0860) reports that at the end of August bass were feeding pretty well',
      'Deeper fish should also be caught on drop shots around humps and bridges.',
    ],
    lines: ['Piedmont Area', 'Lake Russell', 'Clarks Hill (Lake Thurmond)'],
  },
  'edgefield-advertiser-scdnr-report-2012-08.html': {
    first: 'SCDNR Freshwater Fishing Report – The Edgefield Advertiser',
    source: ['contain-intrinsic-size', 'img.wp-smiley', '!important', 'data-toggle', '&#8211;'],
    says: [
      'Trout: Good. For quality fish the catch rate has overall been pretty good.',
      'Channel catfish don’t seem to mind the heat and they continue to feed well.',
      'Dip (stink) bait, especially Hoss’ Hog Bait, is vastly outperforming both cut bait and nightcrawlers.',
    ],
    lines: ['Mountains Area', 'Lake Jocassee', 'Lake Keowee', 'Lake Hartwell'],
  },
  'lakegreenwoodfishing-report-2026-09-06.html': {
    first: 'Lake Greenwood Fishing Report Sep 6th, 2026 - Lake Greenwood Fishing',
    source: ['@context', 'schema.org', '"@graph"', 'wp-emoji'],
    says: [
      'The Mozingos from Hodges, South Carolina, had a great day striper fishing on Lake Greenwood today.',
      'The fish were biting, and they put some nice stripers in the boat!',
      '321 Amber Hill Circle Cross Hill, SC 29332, United States',
    ],
    lines: ['Lake Greenwood Fishing Report Sep 6th, 2026', 'By Fishing Guide Daniel Skipper'],
  },
};

for (const [file, want] of Object.entries(PAGES)) {
  const html = page(file);
  const text = htmlToText(html);
  const lines = text.split('\n');

  test(`${file}: the old fallback made it one line, with source in its first 300 characters`, () => {
    const old = OLD(html);
    assert.equal(old.split('\n').length, 1);
    assert.ok(want.source.some((s) => old.slice(0, 300).includes(s)));
  });

  test(`${file}: the text has lines, and its first line is page text`, () => {
    assert.ok(lines.length > 50, `${lines.length} lines`);
    assert.equal(lines[0], want.first);
    for (const l of want.lines) assert.ok(lines.includes(l), `no line "${l}"`);
  });

  test(`${file}: none of the page's script or CSS is in it`, () => {
    for (const s of want.source) assert.ok(!text.includes(s), `"${s}" is still in the text`);
    assert.ok(!/<\/?[a-z][^>]*>/i.test(text), 'a tag is still in the text');
  });

  test(`${file}: entities are decoded`, () => {
    assert.ok(!/&(?:#\d+|#x[0-9a-f]+|amp|nbsp|lt|gt|quot|rsquo|lsquo|ndash|mdash);/i.test(text));
  });

  test(`${file}: the sentences a reader sees are all still there`, () => {
    for (const s of want.says) assert.ok(text.includes(s), `missing: ${s}`);
  });

  test(`${file}: every word a reader sees is still there`, () => {
    // What the page shows, the crude way: drop what a browser never shows (comments and the
    // contents of script, style, noscript, template and svg) and every tag, decode, split on space.
    // Each of those words has to be in the text, as often as it is on the page.
    const shown = decodeEntities(html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<(?:=\s*"[^"]*"|=\s*'[^']*'|[^>])*>/g, ' ')).split(/\s+/).filter(Boolean);
    const have = new Map();
    for (const w of text.split(/\s+/)) have.set(w, (have.get(w) || 0) + 1);
    const missing = shown.filter((w) => { const n = have.get(w) || 0; have.set(w, n - 1); return n <= 0; });
    assert.deepEqual(missing, []);
  });
}

test('lakegreenwoodfishing: text-date.js finds the report\'s date once its lines survive', () => {
  const html = page('lakegreenwoodfishing-report-2026-09-06.html');
  const fact = { quote: 'had a great day striper fishing on Lake Greenwood today' };
  const doc = (t) => ({ title: 'Lake Greenwood Fishing Report Sep 6th, 2026', fullText: t, fetchedAt: '2026-09-25T12:00:00Z' });
  // Flat, only the title's year was found.
  assert.equal(textDateOf(fact, doc(OLD(html))).textDate, '2026');
  const got = textDateOf(fact, doc(htmlToText(html)));
  assert.equal(got.textDate, '2026-09-06');
  assert.match(got.textDateFrom, /September 6, 2026/);
});

test('htmlToText: a source newline is a space, a block is a line, <pre> keeps its lines', () => {
  assert.equal(htmlToText('<p>one\n  two</p><p>three<br>four</p>'), 'one two\nthree\nfour');
  assert.equal(htmlToText('<pre>a\nb</pre>'), 'a\nb');
  assert.equal(htmlToText('<p>&amp;lt;b&amp;gt; stays text</p>'), '&lt;b&gt; stays text');
  assert.equal(htmlToText('<p>&lt;b&gt; is text</p>'), '<b> is text');
  assert.equal(htmlToText('<p>a &unknownthing; b&#150;c</p>'), 'a &unknownthing; b–c');
  assert.equal(htmlToText('<p>x</p><script>never closed'), 'x');
  assert.equal(htmlToText('<script type="application/ld+json">{"@context":"x"}</script><h1>Title</h1>'), 'Title');
});

// ── the PDF, by what the server sent ────────────────────────────────────────────────────────

const PDF_URL = SOURCES['ncwrc-inland-fishing-regulations.pdf.head'].url;

test('the NCWRC regulations have no .pdf in their URL; the server says PDF, and so do the bytes', () => {
  assert.ok(!/\.pdf/i.test(PDF_URL));
  assert.equal(SOURCES['ncwrc-inland-fishing-regulations.pdf.head'].contentType, 'application/pdf');
  const b = bytes('ncwrc-inland-fishing-regulations.pdf.head');
  assert.equal(isPdfBody('application/pdf', b), true);
  assert.equal(isPdfBody('application/octet-stream', b), true, 'the bytes alone say so');
  assert.equal(isPdfBody('', b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), true);
  assert.equal(isPdfBody('text/html', bytes('scdnr-news-freshwater.html')), false);
});

// Runs the Worker's batch handler with fetch standing in for TinyFish and Scrape.do.
async function batch(items, { scrapeDo, tinyfish } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://api.fetch.tinyfish.ai')) {
      if (!tinyfish) return new Response('down', { status: 503 });
      return new Response(JSON.stringify(tinyfish), { headers: { 'Content-Type': 'application/json' } });
    }
    if (u.startsWith('https://api.scrape.do')) {
      const target = decodeURIComponent(new URL(u).searchParams.get('url'));
      const r = scrapeDo[target];
      if (!r) return new Response('no', { status: 404 });
      return new Response(r.body, { headers: { 'Content-Type': r.contentType } });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const req = new Request('https://w/research/proxy-download-batch', { method: 'POST', body: JSON.stringify({ urls: items }) });
    const res = await handleResearchProxyDownloadBatch(req, { SCRAPEDO_TOKEN: 't', ...(tinyfish ? { TINYFISH_API_KEY: 'k' } : {}) });
    return (await res.json()).results;
  } finally {
    globalThis.fetch = realFetch;
  }
}

const fixtureAnswer = (f) => ({ body: bytes(f), contentType: SOURCES[f].contentType });

test('the fallback sends a PDF to the PDF path and does not return it as text', async () => {
  const f = 'ncwrc-inland-fishing-regulations.pdf.head';
  for (const contentType of ['application/pdf', 'application/octet-stream', 'text/html']) {
    const [r] = await batch([{ url: PDF_URL, title: 'Inland Fishing Regulations', type: 'HTML' }],
      { scrapeDo: { [PDF_URL]: { body: bytes(f), contentType } } });
    assert.equal(r.source, 'unhandled', contentType);
    assert.equal(r.reason, 'pdf', contentType);
    assert.equal(r.ok, false);
    assert.equal(r.text, '');
    assert.ok(!('html' in r));
  }
});

test('the fallback sends a page back as its HTML, which the caller makes text with lines', async () => {
  const items = Object.keys(PAGES).map((f) => ({ url: SOURCES[f].url, title: f, type: 'HTML' }));
  const scrapeDo = Object.fromEntries(Object.keys(PAGES).map((f) => [SOURCES[f].url, fixtureAnswer(f)]));
  const results = await batch(items, { scrapeDo });
  const read = readBatchResults(items, results);
  for (const [i, f] of Object.keys(PAGES).entries()) {
    assert.equal(results[i].ok, true);
    assert.equal(results[i].html, readFileSync(new URL(f, FIX), 'utf8'));
    assert.equal(read[i].kind, 'text');
    assert.equal(read[i].text.split('\n')[0], PAGES[f].first);
  }
});

test('TinyFish handing back PDF bytes goes to the PDF path too', async () => {
  const items = [{ url: PDF_URL, title: 'regs', type: 'HTML' }];
  const results = await batch(items, {
    tinyfish: { results: [{ url: PDF_URL, text: page('ncwrc-inland-fishing-regulations.pdf.head') }], errors: [] },
    scrapeDo: {},
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].source, 'unhandled');
  assert.equal(results[0].reason, 'pdf');
});

test('results come back paired with their URL and in the order sent', async () => {
  const A = 'https://a.example/report', B = 'https://b.example/report';
  const words = 'Striped bass are schooling on the lower lake at dawn. '.repeat(10);
  // TinyFish fetched B and reported A in errors, so its first result is B's.
  const results = await batch([{ url: A, title: 'A' }, { url: B, title: 'B' }], {
    tinyfish: { results: [{ url: B, text: `B: ${words}` }], errors: [{ url: A, error: 'timeout' }] },
    scrapeDo: { [A]: { body: `<html><body><p>A: ${words}</p></body></html>`, contentType: 'text/html' } },
  });
  assert.deepEqual(results.map((r) => r.url), [A, B]);
  assert.equal(results[1].source, 'tinyfish');
  assert.ok(results[1].text.startsWith('B:'));
  assert.equal(results[0].source, 'scrapedo');
  const read = readBatchResults([{ url: A }, { url: B }], [...results].reverse());
  assert.ok(read[0].text.startsWith('A:'), 'paired by URL, not by position');
  assert.ok(read[1].text.startsWith('B:'));
});

// ── the app's reading of the batch ─────────────────────────────────────────────────────────

test('the app sends an item the batch returned as a PDF to its PDF path, as type PDF', () => {
  const src = { url: PDF_URL, title: 'regs', type: 'HTML' };
  const [r] = readBatchResults([src], [{ url: PDF_URL, text: '', source: 'unhandled', ok: false, reason: 'pdf' }]);
  assert.equal(r.kind, 'individual');
  assert.equal(r.src.type, 'PDF');
  // nepis and blocked go alone too, keeping the type they had
  const [n] = readBatchResults([src], [{ url: PDF_URL, text: '', source: 'unhandled', ok: false, reason: 'nepis' }]);
  assert.equal(n.kind, 'individual');
  assert.equal(n.src.type, 'HTML');
});

test('the app\'s cache: a flat copy or a PDF\'s bytes is not reused, a copy with lines is', () => {
  for (const f of Object.keys(PAGES)) {
    assert.equal(isFlatText(OLD(page(f))), true, f);
    assert.equal(isFlatText(htmlToText(page(f))), false, f);
  }
  assert.equal(isFlatText(page('ncwrc-inland-fishing-regulations.pdf.head')), true);
  assert.equal(isFlatText(''), true);
  const src = readFileSync(new URL('../js/modules/lake-research-engine.js', import.meta.url), 'utf8');
  assert.match(src, /age < getDocTtl\(src\.url\) && !isFlatText\(existing\.fullText \|\| existing\.text\)/);
  assert.match(src, /readBatchResults\(batch, batchData\.results\)/);
});

// ── CPU, printed so the PR can quote it ────────────────────────────────────────────────────

test('CPU: the conversion on the largest fixture and on a synthetic 1 MB page', () => {
  const time = (h) => {
    for (let i = 0; i < 3; i++) htmlToText(h);
    const ts = [];
    for (let i = 0; i < 15; i++) { const t = process.hrtime.bigint(); htmlToText(h); ts.push(Number(process.hrtime.bigint() - t) / 1e6); }
    ts.sort((a, b) => a - b);
    return ts[7];
  };
  const largest = page('lakegreenwoodfishing-report-2026-09-06.html');
  const all = Object.keys(PAGES).map(page).join('');
  const mb = all.repeat(Math.ceil(1048576 / all.length)).slice(0, 1048576);
  const a = time(largest), b = time(mb);
  for (let i = 0; i < 3; i++) OLD(mb);
  const t = process.hrtime.bigint(); OLD(mb);
  const old = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`# htmlToText: ${(largest.length / 1024).toFixed(0)} KB fixture ${a.toFixed(2)} ms; `
    + `1 MB of the fixtures ${b.toFixed(2)} ms (old one-line strip ${old.toFixed(2)} ms)`);
  // Not a budget assertion -- a machine's speed is not the Worker's. It holds only that the
  // conversion is linear, which is what running it in the callers relies on.
  assert.ok(b < a * 100, `1 MB took ${b} ms against ${a} ms for 85 KB`);
});
