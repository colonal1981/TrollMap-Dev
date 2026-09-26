/**
 * regulations-wiring.test.js — the regulation digest actually reaches the agents
 * that were written to read it.
 *
 * Written 2026-08-03. Three separate bugs sat here at once, and none of them made
 * anything throw:
 *
 *   1. One shared REGS_2026_EFFECTIVE = 2026-08-01 switched every state's digest on
 *      the same day. SC's 2026-2027 book is stamped "August 14, 2026-August 14,
 *      2027" and GA's "July 1, 2026 through June 30, 2027", so the app served SC's
 *      new limits eleven days before they were law and GA's a month late.
 *   2. `_regsSource` was populated only under `agentKey === 'regulations'`, so
 *      `saltwater_regulations` — an agent whose first system rule is "The R2 digest
 *      provided is the BASELINE" — never received one and took its
 *      "No R2 digest available; return nulls" branch on every coastal run.
 *   3. `_liveRegsSource` had no writer anywhere in the tree, so the same agent also
 *      took its "No live amendment source supplied" branch every time.
 *
 * Two and three produced saltwater limits of `null` with `verificationRequired`
 * true — which reads exactly like a careful agent declining to guess, and is in
 * fact an agent that was handed nothing. That is why these are behaviour tests
 * against the real prompt the agent receives, not source-text greps: the failure
 * mode here is code that looks correct and is never given its input.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATE_REGULATIONS_CONFIG, REGS_EFFECTIVE, REGS_DATE_VERIFIED, useDigest2026,
  freshwaterRegionOf,
  sliceSaltwaterSection, extractSaltwaterDigest, DIGEST_BUDGET,
} from '../Worker/research/clients.js';

// ── a digest shaped like the real ones ───────────────────────────────────────
// Freshwater first, then the caps running head, then saltwater. The lowercase
// sentence in the freshwater half is quoted from SC's own nongame rules and is the
// exact string that broke the first version of the slicer.
const FRESHWATER = `
F I S H I N G  FRESHWATER FISH SIZE & POSSESSION LIMITS
Largemouth Bass: 12 inch minimum, 5 per day. Crappie: 8 inch, 20 per day.
Blue Catfish: no size limit statewide except Lakes Marion and Moultrie.
To qualify for a resident commercial saltwater fishing license, one must have been
a resident for 12 months. If fishing in both fresh and saltwaters, a person MUST
have both licenses. Trotlines are limited to 50 hooks.
`.repeat(6);

const SALTWATER = `
S A L T W A T E R

F I S H I N G www.eregulations.com/scfishlimits

SIZE & CATCH LIMITS  TL=Total Length
Red Drum: 15" minimum, 23" maximum, 3 per person per day, 6 per boat. TL.
Spotted Seatrout: 14" minimum, 10 per person per day. TL.
Southern Flounder: 16" minimum, 5 per person per day. TL.
Sheepshead: 14" minimum, 10 per day.
`.repeat(4);

const DIGEST_TEXT = FRESHWATER + SALTWATER;

// NC's book has no saltwater section to slice. Its coastal species are rows in the
// same WARMWATER GAME FISH table as largemouth bass -- flounder directly under
// bullheads -- and pdftotext emits the columns out of order, which is why the
// extractor uses wide windows. Transcribed from nc_digest_2026_2027.pdf.
const NC_DIGEST = `
WARMWATER GAME FISH
SPECIES  SIZE LIMIT  DAILY CREEL LIMIT
LARGEMOUTH BASS  14-inch minimum  5  All public waters except those listed below
WALLEYE  None  8  All public fishing waters
BULLHEADS (BLACK, BROWN, FLAT, SNAIL, YELLOW, AND WHITE CATFISH)
All inland fishing waters and joint fishing waters when
None
10 in combination
caught by hook and line
FLOUNDER
All inland fishing waters and joint fishing waters when
15-inch minimum
1 (Sept. 1 - Sept. 14.)
caught by hook and line
RED DRUM (CHANNEL BASS, RED FISH, OR PUPPY DRUM)
18-inch minimum, no fish may be
All inland fishing waters and joint fishing waters when
1
greater than 27 inches
caught by hook and line
SPOTTED SEATROUT
14-inch minimum, no fish may be
3, including only 1 greater
All inland fishing waters and joint fishing waters when
between 20 and 26 inches
than 26 inches
caught by hook and line
YELLOW PERCH  None  None  All inland and joint fishing waters
Established by Division of Marine Fisheries
Unless Changed by Proclamation
`.repeat(3);


// ── fakes ────────────────────────────────────────────────────────────────────
function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(k, opts) {
      const v = store.get(k);
      if (v === undefined) return null;
      return opts?.type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { store.set(k, v); },
  };
}

/** Captures every LLM prompt so a test can assert what the agent was actually given. */
function installFetchStub({ searchResults = [], digestText = DIGEST_TEXT } = {}) {
  const llmPrompts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/chat/completions') || u.includes('generativelanguage')) {
      llmPrompts.push(JSON.parse(init.body || '{}'));
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ saltwaterRegulations: {}, sources: [] }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (init.method === 'POST') {           // tinyfishFetch
      const wanted = /nc_digest/.test(JSON.parse(init.body || '{}').urls?.[0] || '')
        ? NC_DIGEST : digestText;
      return new Response(JSON.stringify({ results: [{ text: wanted }] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ results: searchResults }),  // tinyfishSearch
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { llmPrompts, restore: () => { globalThis.fetch = realFetch; } };
}

const env = () => ({ KV: fakeKV(), TINYFISH_API_KEY: 'test', CEREBRAS_API_KEY: 'test' });

// ── 1. each state switches on its own printed date ───────────────────────────
describe('digest effective dates are per-state', () => {
  test('the four states do not share one effective date', () => {
    const distinct = new Set(Object.values(REGS_EFFECTIVE).map(d => d.toISOString().slice(0, 10)));
    assert.ok(distinct.size > 1,
      'every state switching on the same day is the bug this file exists for');
  });

  test('SC switches on August 14 — the date printed on its own cover', () => {
    // Regs2627.pdf page 1: "August 14, 2026-August 14, 2027"
    assert.equal(REGS_EFFECTIVE.SC.toISOString().slice(0, 10), '2026-08-14');
  });

  test('GA switches on July 1 — the date printed on its own cover', () => {
    // 26GAAB-LR.pdf: "effective for the period of July 1, 2026 through June 30, 2027"
    assert.equal(REGS_EFFECTIVE.GA.toISOString().slice(0, 10), '2026-07-01');
  });

  test('a state serves the new digest only once its own date has passed', () => {
    for (const st of ['SC', 'GA', 'NC', 'TN']) {
      const url = STATE_REGULATIONS_CONFIG[st].pages[0].url;
      const serving2026 = url.includes('2026_2027');
      assert.equal(serving2026, useDigest2026(st),
        `${st} serves ${url.split('/').pop()} but useDigest2026 says ${useDigest2026(st)}`);
    }
  });

  test('the url is re-read, not frozen at module load', () => {
    // A Worker isolate that outlives an effective date must not keep serving last
    // year's book. `url` is a getter; this fails the moment it becomes a string.
    const pg = STATE_REGULATIONS_CONFIG.SC.pages[0];
    const d = Object.getOwnPropertyDescriptor(pg, 'url');
    assert.equal(typeof d.get, 'function', 'pages[0].url must be a getter');
    assert.equal(d.enumerable, true, 'consumers spread and JSON-stringify this object');
  });

  test('every state still exposes the fields its consumers read', () => {
    // discover.js:451, shared.js:496 and the discover-policy test all read `.url`;
    // fetchStateRegulations reads `.key` and `.pageHint`.
    for (const st of ['SC', 'GA', 'NC', 'TN']) {
      const pg = STATE_REGULATIONS_CONFIG[st].pages[0];
      assert.equal(pg.key, 'general', `${st} lost its page key`);
      assert.match(pg.url, /^https:\/\/.+\.pdf$/, `${st} url`);
      assert.ok(pg.pageHint && pg.pageHint.length > 10, `${st} pageHint`);
    }
  });
});

// ── 2. the slicer finds the saltwater section and refuses to guess ───────────
describe('sliceSaltwaterSection', () => {
  test('anchors on the running head, not on prose', () => {
    const { text, located } = sliceSaltwaterSection(DIGEST_TEXT);
    assert.equal(located, true);
    assert.ok(/red drum/i.test(text), 'slice must contain the saltwater limits');
    assert.ok(!/Largemouth Bass/.test(text), 'slice must not contain freshwater limits');
  });

  test('the lowercase licence sentence does not anchor the slice', () => {
    // This is the regression. A case-insensitive match on "saltwater fishing" hit
    // "...commercial saltwater fishing license..." in the middle of the FRESHWATER
    // nongame rules and produced a slice that was mostly trotline law under a
    // heading that said saltwater limits.
    const { text } = sliceSaltwaterSection(DIGEST_TEXT);
    const dropped = DIGEST_TEXT.slice(0, DIGEST_TEXT.length - text.length);
    assert.ok(/commercial saltwater fishing license/.test(dropped),
      'the licence sentence belongs to the freshwater half and must be dropped');
  });

  test('no saltwater content is left behind the slice point', () => {
    const { text } = sliceSaltwaterSection(DIGEST_TEXT);
    const dropped = DIGEST_TEXT.slice(0, DIGEST_TEXT.length - text.length);
    assert.equal((dropped.match(/red drum|seatrout|flounder/gi) || []).length, 0);
  });

  test('a digest with no saltwater section returns null, not the tail', () => {
    // Returning the tail would hand the agent a document labelled the saltwater
    // baseline that is not one. Null lets it take its own honest nulls branch.
    const r = sliceSaltwaterSection('a freshwater-only book with no such running head');
    assert.equal(r.located, false);
    assert.equal(r.text, null);
  });
});


// ── 2b. the extractor survives a different text extractor ────────────────────
describe('extractSaltwaterDigest degrades instead of failing', () => {
  // The running head is an assumption about ONE text extractor. These digests are
  // read by the Worker through TinyFish as markdown, not through pdftotext, and a
  // markdown renderer may well emit "## Saltwater Fishing" for a letter-spaced caps
  // banner. Under the first version that missed match returned null, so SC and GA
  // would have had no digest at all — permanently, silently, and looking exactly
  // like an agent correctly declining to guess.
  const restyled = {
    'title-case markdown header': DIGEST_TEXT.replace(
      /S\s*A\s*L\s*T\s*W\s*A\s*T\s*E\s*R\s+F\s*I\s*S\s*H\s*I\s*N\s*G/g, '## Saltwater Fishing'),
    'head removed entirely': DIGEST_TEXT.replace(
      /S\s*A\s*L\s*T\s*W\s*A\s*T\s*E\s*R\s+F\s*I\s*S\s*H\s*I\s*N\s*G/g, '**Saltwater**'),
  };

  test('the caps head is used when it survives extraction', () => {
    const r = extractSaltwaterDigest('SC', DIGEST_TEXT);
    assert.equal(r.located, true);
    assert.equal(r.anchor, 'head', 'the precise path should win when it is available');
  });

  for (const [label, text] of Object.entries(restyled)) {
    test(`still returns the limits when the head is lost — ${label}`, () => {
      const r = extractSaltwaterDigest('SC', text);
      assert.equal(r.located, true, 'a lost running head must not mean no digest');
      assert.equal(r.anchor, 'whole');
      assert.match(r.text, /Red Drum/i);
      assert.match(r.text, /Spotted Seatrout/i);
    });

    test(`the fallback pulls no freshwater with it — ${label}`, () => {
      // Safe only because it is measured: zero saltwater species names fall in the
      // freshwater half of either book, so whole-document windows cannot reach them.
      const r = extractSaltwaterDigest('SC', text);
      assert.equal((r.text.match(/Largemouth Bass/gi) || []).length, 0);
    });
  }
});

// ── 2c. the freshwater parse can no longer read a saltwater table ────────────
describe('freshwaterRegionOf', () => {
  // parseRegulationsWithLLM slices 35,000 characters forward from its first species
  // hit, through a prompt whose species vocabulary is entirely freshwater. Now that
  // the SC and GA digests CONTAIN their saltwater sections, that window can cross the
  // boundary and hand a red drum table to a largemouth-bass parser. Today's digests
  // are long enough that it does not — which is arithmetic about one extractor, not a
  // property of the data.
  test('cuts a combined digest at the saltwater boundary', () => {
    const fw = freshwaterRegionOf(DIGEST_TEXT);
    assert.ok(fw.length < DIGEST_TEXT.length, 'a combined digest must be cut');
    assert.equal((fw.match(/Red Drum/gi) || []).length, 0);
    assert.match(fw, /Largemouth Bass/, 'the freshwater half must survive intact');
  });

  test('leaves a digest with no saltwater section alone', () => {
    // NC is the case that matters: its coastal species live INSIDE the freshwater
    // table by design, so there is no boundary and nothing may be cut.
    assert.equal(freshwaterRegionOf(NC_DIGEST), NC_DIGEST);
  });

  test('never truncates into uselessness', () => {
    const salted = 'SALTWATER FISHING limits red drum 18 inch';
    assert.equal(freshwaterRegionOf(salted), salted, 'a sub-500-char head is not a real freshwater half');
  });
});

// ── 2d. which effective dates were actually read ─────────────────────────────
describe('effective-date provenance is recorded, not assumed', () => {
  test('SC and GA are verified against their own covers', () => {
    assert.equal(REGS_DATE_VERIFIED.SC, true);
    assert.equal(REGS_DATE_VERIFIED.GA, true);
  });

  test('NC and TN are still marked unverified', () => {
    // They kept August 1 because that is what the old shared constant held — the same
    // unexamined inheritance that had SC switching eleven days early. Flipping either
    // of these to true should require reading a cover, so this test exists to make
    // that flip a deliberate act rather than a tidy-up.
    assert.equal(REGS_DATE_VERIFIED.NC, false);
    assert.equal(REGS_DATE_VERIFIED.TN, false);
  });

  test('every configured state declares its provenance either way', () =>
    Object.keys(STATE_REGULATIONS_CONFIG).forEach(st =>
      assert.equal(typeof REGS_DATE_VERIFIED[st], 'boolean', `${st} has no provenance flag`)));
});

// ── 3. fetchSaltwaterRegulations was tested here ─────────────────────────────
// It fed the `saltwater_regulations` agent its digest text. The agent was deleted on 2026-09-25 --
// nothing ran it -- and the fetcher went with it. extractSaltwaterDigest() below still serves the
// saltwater half of /regulations through fetchStateRegulations().

// ── 3b. the extract fits the window the template actually forwards ───────────
describe('extractSaltwaterDigest is budgeted to the template', () => {
  // coastal-agents.js:160 sliced _regsSource.content to 12,000 characters (the agent that did went
  // on 2026-09-25; the budget stands, because /regulations serves this extract). The first
  // version of this code handed it a 36,000-character section, so two thirds were
  // dropped before the model saw them and which third survived was decided by where
  // the section happened to start — GA's first "red drum" landed at character 9,515,
  // 2,500 short of being cut off entirely. Nothing would have reported that.
  const cases = [['SC', DIGEST_TEXT], ['GA', DIGEST_TEXT], ['NC', NC_DIGEST]];

  for (const [st, text] of cases) {
    test(`${st} fits inside the 12,000-character forward`, () => {
      const { text: out, located } = extractSaltwaterDigest(st, text);
      assert.equal(located, true);
      assert.ok(out.length <= DIGEST_BUDGET, `${st} extract is ${out.length}, over budget`);
      assert.ok(DIGEST_BUDGET < 12000, 'budget must leave room under the template slice');
    });

    test(`${st} loses no species mention to the template slice`, () => {
      const { text: out } = extractSaltwaterDigest(st, text);
      const beyond = out.slice(12000).match(/red drum|seatrout|flounder/gi) || [];
      assert.equal(beyond.length, 0);
    });
  }
});

// ── 4 and 5 were tested here ────────────────────────────────────────────────────
// fetchLiveRegsAmendments(), and the prompt the saltwater and freshwater regulations agents
// received. All three went on 2026-09-25 with the six agents nothing ran.
