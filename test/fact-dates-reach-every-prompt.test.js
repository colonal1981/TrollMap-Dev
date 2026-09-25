// Personal use only, not for distribution or resale; not for navigation.
//
// A FACT'S DATE REACHES EVERY PROMPT THAT PRINTS THE FACT.
//
// PR #65 gave every extracted fact the date of its text, and one prompt -- plan-prompt.js's
// factLine() -- printed it. Every other prompt that prints a fact printed it without: the identity,
// navigation and regulations agents, the fisheries agent's parsed observations and its profile dump,
// the two coastal fact agents, map-facts and the validation pass. They all print it now, in
// factLine()'s words, from js/utils/fact-date.js. Where two printed facts disagree and both carry a
// full date, the line says which is the newer, and both are printed.
//
// Search snippets: a snippet fact with no date in its own text takes the search provider's date for
// the result, labelled as the provider's. Real text throughout -- see test/fixtures/text-date/README.md.
//
//   node --test test/fact-dates-reach-every-prompt.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleResearchAnalyzeFacts, handleResearchMapFacts } from '../Worker/research/extract.js';
import { handleResearchValidationPass } from '../Worker/research/storage.js';
import { RESEARCH_AGENTS } from '../Worker/research/agents.js';
import { COASTAL_AGENTS } from '../Worker/research/coastal-agents.js';
import { parseBehaviour, behaviourBlock } from '../Worker/research/behaviour.js';
import { patternFactsFrom } from '../js/modules/plan-prompt.js';
import { writtenOf } from '../js/utils/fact-date.js';

// A Windows checkout turns the fixtures' line ends into CRLF; they were fetched with LF.
const fixture = (f) => readFileSync(new URL(`./fixtures/text-date/${f}`, import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

const DNR_2018 = {
  title: 'New size limits and dates in place for Santee striped bass May 7, 2018',
  url: 'https://www.dnr.sc.gov/news/2018/may/may7_striperlimit.html',
  text: fixture('dnr-news-2018-santee-striper.md'), fetchedAt: '2026-09-25T15:00:00Z',
};
const CS_2007 = {
  title: '“Sub-Tropical” Trout', url: 'https://www.carolinasportsman.com/content/sub-tropical-trout/',
  text: fixture('carolina-sportsman-lower-saluda-trout-2007.md'), fetchedAt: '2026-09-25T15:00:00Z',
};
const SEARCH = JSON.parse(fixture('search-wateree-crappie.json'));

// Every model call goes through fetch; the prompt is whatever was sent.
function stubModel(reply) {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push(String(init && init.body));
    const text = JSON.stringify(reply(sent.length));
    return { ok: true, status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text }] } }],
                           choices: [{ message: { content: text } }] }),
      text: async () => text };
  };
  return sent;
}
const post = (body) => new Request('https://w.example/x', { method: 'POST', body: JSON.stringify(body) });
const ENV = { GEMINI_FREE_API_KEY: 'k' };
const extract = async (docs, extra = {}) => (await handleResearchAnalyzeFacts(post({
  lakeName: 'Lake Wateree', baseName: 'Wateree', state: 'SC', docIndex: 0, documents: docs, ...extra }), ENV)).json();
const fact = (quote, category, fact) => ({ fact, quote, category, confidence: 90 });

// The Lower Saluda's striper rule, dated by the real handler from the real pages.
//   2007: Carolina Sportsman, "five striped bass", 21 inches -- no full date in its text.
//   2018: SCDNR news of May 7, 2018 -- the 26-inch minimum it was replacing.
//   2026: eRegulations, "Last Updated: August 5, 2026" -- the same quote and date as the dedupe
//         test in a-fact-has-the-date-of-its-text.test.js: 3 fish, 23 to 25 inches, Oct. 1 - June 15.
async function saludaFacts() {
  stubModel(() => ({ extracted_facts: [
    fact('The daily creel limit is five trout and five striped bass.', 'creelLimit_lakeSpecific',
      'The daily creel limit for striped bass on the Lower Saluda River is 5 fish'),
  ] }));
  const [f2007] = (await extract([CS_2007])).extracted_facts;
  stubModel(() => ({ extracted_facts: [
    fact('Previously, the limit for striped bass in the Santee River system during the open period was three (3) fish, all of which had to be at least 26 inches.',
      'sizeLimit_lakeSpecific', 'The minimum size limit for striped bass in the Santee River system is 26 inches'),
  ] }));
  const [f2018] = (await extract([DNR_2018])).extracted_facts;
  const eregs = 'Santee River system (see map below); includes Saluda River (Lower Reach) | Striped or Hybrid Bass or a combination | Oct. 1 - June 15 striped bass between 23 and 25 inches may be harvested except that one fish may be greater than 26 inches | 3';
  const src = 'South Carolina Freshwater Fish Size & Possession Limits';
  const dated = { textDate: '2026-08-05', textDateFrom: 'page date near the top: "Last Updated: August 5, 2026"' };
  const size2026 = { fact: 'From Oct. 1 to June 15, the size limit for striped bass in the Santee River system, including the Lower Reach of the Saluda River, is 23 to 25 inches; one fish may be greater than 26 inches',
    quote: eregs, source: src, category: 'sizeLimit_lakeSpecific', confidence: 85, ...dated };
  const creel2026 = { fact: 'The daily creel limit for striped bass on the Lower Saluda River is 3 fish',
    quote: eregs, source: src, category: 'creelLimit_lakeSpecific', confidence: 85, ...dated };
  return { f2007, f2018, size2026, creel2026 };
}

test('the fixtures date as they should before any prompt reads them', async () => {
  const { f2007, f2018 } = await saludaFacts();
  assert.equal(f2018.textDate, '2018-05-07');
  // "August 2007" is a month without a day; the rule does not make one up.
  assert.equal(f2007.textDate, null);
  assert.equal(f2007.textDateFrom, null);
});

// ── ITEM 1: EVERY PROMPT THAT PRINTS A FACT PRINTS ITS DATE ───────────────────────────────────

const AHQ_FACT = {
  fact: 'Lake Wateree crappie are suspended 18-20 feet down over the channel in the lower lake',
  quote: 'most suspended 18-20 feet down and some a bit shallower', category: 'seasonalDepth',
  source: 'AHQ INSIDER Lake Wateree (SC) 2026 Week 9 Fishing Report – Updated February 25',
  confidence: 90, textDate: '2026-02-25', textDateFrom: 'date line above the quote: "February 25"',
};
const NO_YEAR = { ...AHQ_FACT, fact: 'Lake Wateree crappie flat on the bottom in 25 feet of water',
  quote: 'flat on the bottom', textDate: '--10-02' };

test('the regulations agent: each fact with its date, and the undated one as it always was', async () => {
  const { f2007, creel2026 } = await saludaFacts();
  const p = RESEARCH_AGENTS.regulations.userTemplate('Saluda River (Lower)', 'SC', { _extractedFacts: [f2007, creel2026] });
  // BEFORE: "• [creelLimit_lakeSpecific] The daily creel limit for striped bass on the Lower Saluda River is 3 fish (source: South Carolina Freshwater Fish Size & Possession Limits)"
  assert.ok(p.includes('• [creelLimit_lakeSpecific] The daily creel limit for striped bass on the Lower Saluda River is 3 fish (written 2026-08-05) (source: South Carolina Freshwater Fish Size & Possession Limits)'), p);
  assert.ok(p.includes('• [creelLimit_lakeSpecific] The daily creel limit for striped bass on the Lower Saluda River is 5 fish (source: “Sub-Tropical” Trout)'));
  // The 2007 side has no full date, so nothing is said to be newer than it: an undated fact is not
  // an old one. Both are printed.
  assert.ok(!/newer|older/.test(p));
});

test('the identity and navigation agents print the date', () => {
  const pool = { fact: 'Lake Wateree is at 97.5% of full pool', quote: 'Lake Wateree is at 97.5% of full pool',
    category: 'poolLevel', source: AHQ_FACT.source, confidence: 90, textDate: '2026-02-25' };
  const idP = RESEARCH_AGENTS.identity.userTemplate('Lake Wateree', 'SC', { _extractedFacts: [
    { ...pool, fact: 'Normal full pool elevation of Lake Wateree is 225.5 feet', category: 'normalPoolFt' }] });
  assert.match(idP, /Normal full pool elevation of Lake Wateree is 225\.5 feet \(written 2026-02-25\) \(source:/);
  const navP = RESEARCH_AGENTS.navigation.userTemplate('Lake Wateree', 'SC', { navigation: { ramps: [] },
    _extractedFacts: [{ ...NO_YEAR, fact: 'One hump in Colonel Creek is only 12-15 feet deep, a hazard at low water', category: 'navigationHazard' }] });
  assert.match(navP, /a hazard at low water \(written 10-02, year not stated\) \(source:/);
});

test("the fisheries agent: each parsed observation carries its quote's date", () => {
  const block = behaviourBlock(parseBehaviour([AHQ_FACT, { ...AHQ_FACT, textDate: null, source: 'x' }]));
  // BEFORE: `... · "most suspended 18-20 feet down and some a bit shallower" (AHQ INSIDER ...)`
  assert.ok(block.includes('"most suspended 18-20 feet down and some a bit shallower" (written 2026-02-25) (AHQ INSIDER'), block);
  // The same sentence from an undated copy is its own line now, not folded into the dated one.
  assert.ok(block.includes('"most suspended 18-20 feet down and some a bit shallower" (x)'));
});

test("the fisheries agent's profile dump says `written`, in the same words", () => {
  const p = RESEARCH_AGENTS.fisheries.userTemplate('Lake Wateree', 'SC', { _extractedFacts: [AHQ_FACT, NO_YEAR] });
  assert.match(p, /"written": "written 2026-02-25"/);
  assert.match(p, /"written": "written 10-02, year not stated"/);
  assert.match(p, /"textDateFrom": "date line above the quote: \\"February 25\\""/, 'the evidence for the date stays');
});

test('both coastal fact agents print the date', () => {
  const f = { fact: 'Mean tidal range at Winyah Bay is 4.6 feet', quote: 'mean range of 4.6 feet', category: 'tidal',
    source: 'NOAA', confidence: 80, textDate: '2019-06-03' };
  const printing = [];
  for (const key of Object.keys(COASTAL_AGENTS)) {
    const p = COASTAL_AGENTS[key].userTemplate('Winyah Bay', 'SC', { _extractedFacts: [{ ...f, category: 'estuary tidal salinity' }] });
    if (!p.includes('Mean tidal range at Winyah Bay')) continue;   // an agent that prints no facts
    printing.push(key);
    assert.ok(p.includes('Mean tidal range at Winyah Bay is 4.6 feet (written 2019-06-03) (source: NOAA'), key);
  }
  assert.equal(printing.length, 2, `the two coastal agents that print facts: ${printing}`);
});

test('map-facts and the validation pass print the date', async () => {
  let sent = stubModel(() => ({ identity: {} }));
  await handleResearchMapFacts(post({ lakeName: 'Lake Wateree', facts: [AHQ_FACT] }), ENV);
  assert.ok(sent.some((b) => b.includes('18-20 feet down over the channel in the lower lake (written 2026-02-25) (Source:')), sent[0]);
  sent = stubModel(() => ({}));
  await handleResearchValidationPass(post({ lakeName: 'Lake Wateree', nullFields: ['trollingIntelligence.x'], extractedFacts: [AHQ_FACT, NO_YEAR] }), ENV);
  assert.ok(sent.some((b) => b.includes('in the lower lake (written 2026-02-25)')), sent[0]);
  assert.ok(sent.some((b) => b.includes('in 25 feet of water (written 10-02, year not stated)')));
});

test("the planner's factLine is writtenOf's words, unchanged", () => {
  const lines = patternFactsFrom({ _extractedFacts: [AHQ_FACT, NO_YEAR] });
  assert.ok(lines.includes(`${AHQ_FACT.fact} (written 2026-02-25) [${AHQ_FACT.source}]`), lines.join('\n'));
  assert.ok(lines.includes(`${NO_YEAR.fact} (written 10-02, year not stated) [${NO_YEAR.source}]`));
});

// ── ITEM 2: TWO DATED FACTS THAT DISAGREE -- WHICH IS NEWER, AND BOTH SHOWN ──────────────────

test('the regulations prompt says which of two dated, disagreeing facts is newer, and prints both', async () => {
  const { f2007, f2018, size2026, creel2026 } = await saludaFacts();
  const facts = [f2007, f2018, size2026, creel2026];
  const p = RESEARCH_AGENTS.regulations.userTemplate('Saluda River (Lower)', 'SC', { _extractedFacts: facts });
  assert.ok(p.includes('• [sizeLimit_lakeSpecific] The minimum size limit for striped bass in the Santee River system is 26 inches (written 2018-05-07; older than the fact written 2026-08-05 that disagrees with it) (source: New size limits'), p);
  assert.ok(p.includes('may be greater than 26 inches (written 2026-08-05; newer than the fact written 2018-05-07 that disagrees with it) (source: South Carolina'));
  // Whether two facts disagree is the dedupe's test, unchanged (js/utils/fact-date.js): it compares
  // the FIRST number of each -- here 26 and the 1 of "Oct. 1". The same rule written "23 to 25
  // inches" first would compare 26 with 23, under its 15% floor, and no pair would be named.
  // Four facts in, four lines out: the older rule is kept, so the planner can see it changed.
  assert.equal((p.match(/^• \[/gm) || []).length, 4);
  // The creel pair disagrees too (5 vs 3), but 2007 has no full date: no claim either way.
  assert.ok(p.includes('Lower Saluda River is 3 fish (written 2026-08-05) (source:'));
});

test('the same day, or a date with no day, says nothing about which is newer', () => {
  const a = { fact: 'The daily creel limit for striped bass on the Lower Saluda River is 5 fish', category: 'creelLimit_lakeSpecific', textDate: '2026-08-05' };
  const b = { ...a, fact: 'The daily creel limit for striped bass on the Lower Saluda River is 3 fish' };
  assert.equal(writtenOf(a, [a, b]), ' (written 2026-08-05)');
  assert.equal(writtenOf({ ...a, textDate: '2007' }, [{ ...a, textDate: '2007' }, b]), ' (written 2007)');
  assert.equal(writtenOf({ ...a, textDate: null }, [b]), '');
});

// ── ITEM 3: A SNIPPET'S DATE IS THE SEARCH PROVIDER'S, AND SAYS SO ────────────────────────────

// Built the way research_lakes.py builds its snippet documents, from the discover candidate, whose
// `publishedDate` is discover.js's `r.date || r.published_date`.
const snippetDocs = SEARCH.results.map((r) => ({ title: r.title, url: r.url, text: r.snippet,
  publishedDate: r.date || r.published_date || '' }));

test('snippet facts take the search provider\'s date where their text has none -- labelled as the provider\'s', async () => {
  stubModel(() => ({ extracted_facts: [
    fact('Lake Wateree is at 96.8% of full pool.', 'poolLevel', 'Lake Wateree is at 96.8% of full pool'),
    fact('Crappie are transitioning to deeper brush piles and points', 'seasonalPattern', 'Wateree crappie are moving to deeper brush piles and points'),
    fact("I've gone the last 3 weeks and I caught nearly nothing", 'fishingPressure', 'An angler at Wateree caught nearly nothing for 3 weeks'),
    fact('can catch a 20 fish per person (minimum size 8 inches) limit', 'creelLimit_lakeSpecific', 'Lake Wateree crappie limit is 20 fish per person, minimum size 8 inches'),
  ] }));
  const facts = (await extract(snippetDocs, { combine: true, docIndex: -1 })).extracted_facts;
  const by = Object.fromEntries(facts.map((f) => [f.category, f]));
  assert.equal(facts.length, 4, 'annotate, never filter');
  // BEFORE: research_lakes.py sent no provider date, and all four were null.
  assert.equal(by.seasonalPattern.textDate, '2026-09-06');
  assert.equal(by.seasonalPattern.textDateFrom, 'search provider\'s date for the result, not the page\'s: "Sep 6, 2026"');
  assert.equal(by.creelLimit_lakeSpecific.textDate, '2013-01-21');
  // "5 months ago" is relative to when the search ran, which the snippet does not carry.
  assert.equal(by.fishingPressure.textDate, null);
  assert.match(by.fishingPressure.textDateFrom, /"5 months ago", which is not a date/);
  // No provider date and no date in the text: as before.
  assert.equal(by.poolLevel.textDate, null);
  assert.equal(by.poolLevel.textDateFrom, null);
  // And a snippet fact reaches the planner with it.
  assert.ok(patternFactsFrom({ _extractedFacts: facts }).some((l) => l.includes('deeper brush piles and points (written 2026-09-06)')));
});

test("a snippet's own date line still comes before the provider's", async () => {
  const doc = { title: 'AHQ INSIDER Lake Wateree (SC) 2026 Week 9 Fishing Report – Updated February 25',
    url: 'https://www.anglersheadquarters.com/x',
    text: 'January 8\n\nThe **crappie** bite is pretty phenomenal right now on Lake Wateree, but veteran tournamentangler Will Hinson of Cassatt reports that it’s a tale of two lakes.',
    publishedDate: 'Jan 21, 2013' };
  stubModel(() => ({ extracted_facts: [fact('The crappie bite is pretty phenomenal right now on Lake Wateree', 'seasonalPattern', 'Wateree crappie bite is phenomenal')] }));
  const [f] = (await extract([doc])).extracted_facts;
  assert.equal(f.textDate, '2026-01-08');
  assert.match(f.textDateFrom, /^date line above the quote/);
});
