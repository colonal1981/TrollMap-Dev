// Personal use only, not for distribution or resale; not for navigation.
//
// A FACT HAS THE DATE OF THE TEXT IT CAME FROM.
//
// `_extractedFacts` carried no date: a 2007 regulation and a 2016 one read the same, and the July
// entry of a weekly report page was nothing apart from the January one. Each fact now carries
// `textDate` and `textDateFrom` (Worker/research/text-date.js). These run the real
// /research/analyze-facts handler against a stubbed Gemini, as snippets-are-read-in-one-call does,
// on pages fetched 2026-09-25 -- see test/fixtures/text-date/README.md.
//
//   node --test test/a-fact-has-the-date-of-its-text.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleResearchAnalyzeFacts, handleResearchDedupeContradictions } from '../Worker/research/extract.js';
import { patternFactsFrom } from '../js/modules/plan-prompt.js';
import { readPage } from '../Worker/research/text-date.js';

const page = (f) => readFileSync(new URL(`./fixtures/text-date/${f}`, import.meta.url), 'utf8');

const AHQ = {
  title: 'AHQ INSIDER Lake Wateree (SC) 2026 Week 9 Fishing Report – Updated February 25',
  url: 'https://www.anglersheadquarters.com/blogs/ahq-report/ahq-insider-lake-wateree-sc-2026-week-9-fishing-report-updated-february-25',
  text: page('ahq-wateree-2026-week-9.md'), fetchedAt: '2026-09-25T15:33:46Z',
};
// Fetched at 01:30 UTC on the 26th, which is the evening of the 25th in Columbia: the page's clock
// says "September 25, 2026" and the UTC day of the fetch does not.
const CS_2016 = {
  title: 'Crappie fishing at Lake Wateree',
  url: 'https://www.carolinasportsman.com/fishing/freshwater-fishing/catch-more-lake-wateree-crappie-this-month-with-these-tips/',
  text: page('carolina-sportsman-wateree-crappie-2016.md'), fetchedAt: '2026-09-26T01:30:00Z',
};
const CS_JOYNER = {
  title: "Colton Joyner's Lake Wateree crappie trip - Carolina Sportsman",
  url: 'https://www.carolinasportsman.com/fishing/freshwater-fishing/crappie/colton-joyners-lake-wateree-crappie-trip/',
  text: page('carolina-sportsman-joyner-wateree-crappie.md'), fetchedAt: '2026-09-25T15:00:00Z',
};
const DNR = {
  title: 'SC Lakes and Waterways - Lake Wateree', url: 'https://www.dnr.sc.gov/lakes/wateree/description.html',
  text: page('dnr-wateree-description.md'), fetchedAt: '2026-09-25T15:00:00Z',
};

function stubGemini(reply) {
  const prompts = [];
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /generativelanguage\.googleapis\.com/);
    prompts.push(JSON.parse(init.body).contents[0].parts[0].text);
    return { ok: true, status: 200, json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(reply(prompts.length)) }] } }] }) };
  };
  return prompts;
}

const ask = async (docs, extra = {}) => (await handleResearchAnalyzeFacts(new Request('https://w.example/x', {
  method: 'POST', body: JSON.stringify({ lakeName: 'Lake Wateree', baseName: 'Wateree', state: 'SC',
    docIndex: 0, documents: docs, ...extra }) }), { GEMINI_FREE_API_KEY: 'k' })).json();

const fact = (quote, category, fact = `Lake Wateree: ${quote}`) => ({ fact, quote, category, confidence: 90 });

test('AHQ weekly page: each fact takes the date line above its quote, in the year the page proves', async () => {
  stubGemini(() => ({ extracted_facts: [
    fact('most suspended 18-20 feet down and some a bit shallower', 'seasonalDepth'),
    fact('fish are in giant schools of up to 800-900 fish just sitting flat on the bottom', 'holdingPattern'),
    fact('One hump in Colonel Creek is only 12-15 feet deep but loaded with fish', 'structuralElement'),
    fact('some better fish are starting to move onto main lake structure', 'seasonalPattern'),
  ] }));
  const d = await ask([AHQ]);
  const by = Object.fromEntries(d.extracted_facts.map((f) => [f.category, f]));
  // BEFORE: none of these facts carried a date, and all four read as the same page.
  // The title says 2026; its entries run February 25 back to October 2, so the year turns under
  // January 8. Giving every entry the title's year would have put the October report in 2026.
  assert.equal(by.seasonalDepth.textDate, '2026-02-25');
  assert.equal(by.holdingPattern.textDate, '2026-01-08');
  assert.equal(by.structuralElement.textDate, '2025-12-23');
  assert.equal(by.seasonalPattern.textDate, '2025-10-02');
  assert.match(by.seasonalPattern.textDateFrom, /^date line above the quote: "October 2"; year from the page date in the title/);
  assert.match(by.seasonalPattern.textDateFrom, /newest-first order/);
});

test('a quote copied from link text is found with the link taken out', async () => {
  stubGemini(() => ({ extracted_facts: [
    fact('Dearal Rodgers of Camden reports that there were four 19 pound bags', 'summary'),
  ] }));
  const [f] = (await ask([AHQ])).extracted_facts;
  assert.equal(f.textDate, '2026-02-25');
});

test('a quote not on a page of dated entries gets null and says why -- and the fact is kept', async () => {
  stubGemini(() => ({ extracted_facts: [fact('crappie are holding deep on Lake Wateree in winter', 'seasonalDepth')] }));
  const facts = (await ask([AHQ])).extracted_facts;
  assert.equal(facts.length, 1, 'annotate, never filter');
  assert.equal(facts[0].textDate, null);
  assert.match(facts[0].textDateFrom, /quote not found on a page of dated entries/);
});

test("Carolina Sportsman: the site's clock at the top is not the article's date, in any time zone", async () => {
  stubGemini(() => ({ extracted_facts: [
    fact('Crappie at Lake Wateree will hang around debris or other forms of cover close to the main-river channel', 'habitatCover'),
  ] }));
  const [f] = (await ask([CS_2016])).extracted_facts;
  // BEFORE this rule, "September 25, 2026" -- a line that is only a date, above every word of the
  // article -- would have dated a 2016 article to the day it was fetched. Its text has no other date.
  assert.equal(f.textDate, null);
  assert.equal(f.textDateFrom, null);
});

test('Carolina Sportsman: past the clock, a date inside a sentence is an event, not the page date', async () => {
  stubGemini(() => ({ extracted_facts: [fact('Colton Joyner caught some slabs', 'predatorSpecies')] }));
  const [f] = (await ask([CS_JOYNER])).extracted_facts;
  // "Colton Joyner caught some slabs on April 3, 2024 while crappie fishing at Lake Wateree." is
  // the day of the trip the page reports. Here it is also near enough the page's date to pass for
  // it, and the rule refuses it anyway: the next page's sentence date was 1952.
  assert.equal(f.textDate, null);
});

// ── WHAT COUNTS AS THE PAGE'S DATE NEAR THE TOP ─────────────────────────────────────────────
//
// The desktop session's measurement on the stored documents of Wateree, Murray, Greenwood and
// Marion, 2026-09-25: 166 of 371 facts dated "near the top" took their date out of a sentence.
// These lines are theirs, as stored.
const nearTop = (line, extra = {}) => readPage({ title: 'Untitled', text: `Home\n${line}\nBody text.`, ...extra }).page;

test('a date inside running prose near the top is not the page date', () => {
  for (const line of [
    'The lake reached a managed maximum of 442.02 feet recorded on March 5, 1952, during early operation.',
    'On Feb. 17, 1942, Santee Cooper first generated electricity at the Jefferies Hydroelectric Station.',
    // Carolina Sportsman's clock with the navigation flattened into its line, from a copy whose
    // fetchedAt (2026-07-21) is a week after the clock: the fetch-day check could never catch it.
    '[Give a Gift Subscription](https://x) July 14, 2026 Search for: [Home](https://y)',
  ]) assert.equal(nearTop(line, { fetchedAt: '2026-07-21T12:00:00Z' }), null, line);
});

test('a date written as a stamp is the page date', () => {
  for (const [line, date] of [
    ['Wednesday, Jul 08 2026', '2026-07-08'],
    ['- by Jay - 25 February, 2026', '2026-02-25'],
    ['By Brian Cope on March 3, 2020', '2020-03-03'],
    ['Posted on March 3, 2020', '2020-03-03'],
    ['Last Updated: August 5, 2026', '2026-08-05'],
    ['## New size limits and dates in place for Santee striped bass May 7, 2018', '2018-05-07'],
  ]) {
    const p = nearTop(line);
    assert.ok(p, line);
    assert.equal(`${p.date.y}-${String(p.date.m).padStart(2, '0')}-${String(p.date.d).padStart(2, '0')}`, date, line);
  }
  assert.equal(nearTop('A fish recorded by the state on March 5, 1952, at the dam.'), null,
    '"by the state" is no byline: a byline is a name');
});

test('SCDNR description page: no date anywhere, so null -- and every fact is still there', async () => {
  stubGemini(() => ({ extracted_facts: [
    fact('The SC DNR manages the lake for recreational fishing and maintains 17 fish attractors', 'habitatCover'),
    fact('Lake Wateree was created in 1920 with the operation of Wateree Hydroelectric Station', 'yearImpounded'),
  ] }));
  const facts = (await ask([DNR])).extracted_facts;
  assert.equal(facts.length, 2);
  // "created in 1920" is a date IN a sentence, about the dam, not the date of the page.
  for (const f of facts) { assert.equal(f.textDate, null); assert.equal(f.textDateFrom, null); }
});

test('combined snippets: each fact is dated against the snippet its quote came from', async () => {
  const snip = (d, text) => ({ title: d.title, url: d.url, text, fetchedAt: d.fetchedAt });
  const docs = [
    snip(AHQ, 'January 8\n\nThe **crappie** bite is pretty phenomenal right now on Lake Wateree, but veteran tournamentangler Will Hinson of Cassatt reports that it’s a tale of two lakes.'),
    snip(DNR, 'The SC DNR manages the lake for recreational fishing and maintains 17 fish attractors. Popular sport fish on Lake Wateree include black crappie.'),
  ];
  stubGemini(() => ({ extracted_facts: [
    fact('The crappie bite is pretty phenomenal right now on Lake Wateree', 'seasonalPattern'),
    fact('maintains 17 fish attractors', 'habitatCover'),
  ] }));
  const by = Object.fromEntries((await ask(docs, { combine: true })).extracted_facts.map((f) => [f.category, f]));
  assert.equal(by.seasonalPattern.textDate, '2026-01-08', "the snippet's own title gives the year");
  assert.equal(by.habitatCover.textDate, null);
});

// ── THE MERGE ────────────────────────────────────────────────────────────────────────────────

const dedupe = async (facts) => (await handleResearchDedupeContradictions(new Request('https://w.example/d', {
  method: 'POST', body: JSON.stringify({ facts }) }), {})).json();

test('two statements of one fact merge, and the date goes with the quote that is kept', async () => {
  const said = 'Tight-lining the channel near the bottom is the best way to catch Lake Wateree crappie in winter.';
  const d = await dedupe([
    { fact: said, category: 'seasonalPattern', confidence: 80, source: AHQ.title, textDate: '2026-01-29',
      textDateFrom: 'date line above the quote: "January 29"',
      quote: 'Tight-lining in the river channel near the bottom is the best way to catch these fish.' },
    { fact: said, category: 'seasonalPattern', confidence: 90, source: AHQ.title, textDate: '2026-02-04',
      textDateFrom: 'date line above the quote: "February 4"',
      quote: 'Tight-lining the main channel near the bottom is the best way to catch these fish.' },
  ]);
  assert.equal(d.deduplicated_facts.length, 1);
  const [f] = d.deduplicated_facts;
  assert.equal(f.sourcesAgree, 2);
  assert.match(f.quote, /main channel/);
  assert.equal(f.textDate, '2026-02-04', 'the February quote with the January date would be a date from nowhere');
});

// The Lower Saluda's striper creel, in its two real texts: a SCDNR freshwater regulations PDF,
// "The Saluda River … 5 fish per day and 21-inch minimum size limit" (no year in what was read),
// and eRegulations, last updated August 5, 2026, which puts the Lower Reach in the Santee system
// at 3. Written the way the extractor writes a limit, they share their first 80%.
test('facts that differ only in their numbers are two facts, not one confirmed twice', async () => {
  const d = await dedupe([
    { fact: 'The daily creel limit for striped bass on the Lower Saluda River is 5 fish',
      quote: '5 fish per day and 21-inch minimum size limit', source: 'Freshwater Fishing Regulations www.dnr.sc.gov/freshwater',
      category: 'creelLimit_lakeSpecific', confidence: 85, textDate: null, textDateFrom: null },
    { fact: 'The daily creel limit for striped bass on the Lower Saluda River is 3 fish',
      quote: 'Santee River system (see map below); includes Saluda River (Lower Reach) | Striped or Hybrid Bass or a combination | Oct. 1 - June 15 striped bass between 23 and 25 inches may be harvested except that one fish may be greater than 26 inches | 3',
      source: 'South Carolina Freshwater Fish Size & Possession Limits', category: 'creelLimit_lakeSpecific',
      confidence: 85, textDate: '2026-08-05', textDateFrom: 'page date near the top: "Last Updated: August 5, 2026"' },
  ]);
  // BEFORE: one fact, "is 5 fish", sourcesAgree 2 -- the current limit gone, and no contradiction.
  assert.equal(d.deduplicated_facts.length, 2);
  assert.ok(d.deduplicated_facts.every((f) => f.sourcesAgree === 1));
  assert.equal(d.contradictions.length, 1, 'the contradiction step now sees the pair');
  assert.equal(d.contradictions[0].textDateA, null);
  assert.equal(d.contradictions[0].textDateB, '2026-08-05');
});

test('the same fact with the same numbers still merges', async () => {
  const d = await dedupe([
    { fact: 'Lake Wateree is at 97.5% of full pool and up the river is muddy while the mid-lake down is fairly clear.', category: 'poolLevel', confidence: 90 },
    { fact: 'Lake Wateree is at 97.5% of full pool and up the river is muddy while the mid-lake down is clear.', category: 'poolLevel', confidence: 80 },
  ]);
  assert.equal(d.deduplicated_facts.length, 1);
});

test('the planner is shown the date of a fact\'s text, and nothing where there is none', () => {
  const lines = patternFactsFrom({ _extractedFacts: [
    { fact: 'Lake Wateree crappie suspended 18-20 feet down.', category: 'seasonalDepth', source: AHQ.title, textDate: '2026-02-25' },
    { fact: 'Lake Wateree crappie flat on the bottom.', category: 'holdingPattern', source: 'x', textDate: '--10-02' },
    { fact: 'Lake Wateree crappie on brush.', category: 'holdingPattern', source: 'y', textDate: null },
  ] });
  assert.ok(lines.some((l) => l.includes('suspended 18-20 feet down. (written 2026-02-25) [AHQ INSIDER')));
  assert.ok(lines.some((l) => l.includes('(written 10-02, year not stated) [x]')));
  assert.ok(lines.some((l) => l === 'Lake Wateree crappie on brush. [y]'));
});

// The same dated entries of the AHQ page, listed oldest first as some report pages are: the year
// now turns going DOWN the page (December, then January), and the newest entry still takes its
// year from the page's date.
test('a page that lists oldest first turns the year the other way', async () => {
  const entries = AHQ.text.split(/\n(?=(?:February|January|December|October) \d+\n)/).slice(1).reverse();
  const doc = { ...AHQ, text: `# ${AHQ.title}\n\n${entries.join('\n')}` };
  stubGemini(() => ({ extracted_facts: [
    fact('One hump in Colonel Creek is only 12-15 feet deep but loaded with fish', 'structuralElement'),
    fact('fish are in giant schools of up to 800-900 fish just sitting flat on the bottom', 'holdingPattern'),
    fact('most suspended 18-20 feet down and some a bit shallower', 'seasonalDepth'),
  ] }));
  const by = Object.fromEntries((await ask([doc])).extracted_facts.map((f) => [f.category, f]));
  assert.equal(by.structuralElement.textDate, '2025-12-23');
  assert.equal(by.holdingPattern.textDate, '2026-01-08');
  assert.equal(by.seasonalDepth.textDate, '2026-02-25');
  assert.match(by.holdingPattern.textDateFrom, /oldest-first order/);
});
