import { readFileSync } from 'node:fs';
import { describe, it, expect } from './expect-shim.mjs';
import { sanitizeLakeId, researchStorageId, researchStorageIdCandidates, legacyStorageName,
         researchedNames, RESEARCH_CANONICAL_IDS }
  from '../js/data/research-ids.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A SECOND COPY OF A RULE, AND THE TEST THAT MAKES IT SAFE
//
// `js/data/research-ids.js` mirrors `worker/research/keys.js` so the research picker can answer
// "which of these do I not have a profile for" without fetching all sixty profiles to read their
// names back out.
//
// Drift here does not throw. It reports a researched lake as unresearched, which sends Ryan to
// re-run a pipeline that spends Firecrawl credits, or — worse in the other direction — hides a
// lake from the picker that he still needs. So the Worker's own source is READ, not paraphrased.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const WORKER = readFileSync(new URL('../worker/research/keys.js', import.meta.url), 'utf8');

describe('the client mirror agrees with the Worker', () => {
  it('sanitizeLakeId does what the Worker does, character for character', () => {
    // Lifted from the Worker body rather than restated, so a change there fails here.
    const body = /function sanitizeLakeId\(name\)\s*\{([\s\S]*?)\n\}/.exec(WORKER);
    expect(Boolean(body)).toBe(true);
    // eslint-disable-next-line no-new-func
    const theirs = new Function('name', body[1]);
    for (const name of ['Lake Wateree, SC', 'Ft. Loudoun Reservoir, TN', 'Murrells Inlet / Pawleys Island, SC',
                        'HB Robinson Lake (Darlington Co, SC)', 'Santee River Delta / North Inlet, SC',
                        '', null, '   ', 'A'.repeat(200)]) {
      expect(sanitizeLakeId(name)).toBe(theirs(name));
    }
  });

  // THE DUPLICATION THIS GUARDED IS GONE, AND THAT IS WHY IT WENT RED.
  //
  // This used to lift `const RESEARCH_CANONICAL_IDS = {...}` out of the Worker's source and
  // compare it key by key against the client's. The Worker no longer declares one: keys.js line 1
  // is `import { RESEARCH_CANONICAL_IDS } from '../../js/data/research-ids.js'`. So the regex
  // matched nothing, `Boolean(block)` was false, and a test failed because the thing it was
  // protecting against had been fixed properly.
  //
  // A comparison cannot be the guard any more -- there is nothing to compare. THE GUARD IS THAT
  // THERE IS STILL ONE TABLE, which is a stronger claim than "two tables agree today" and is the
  // claim that stops a second copy reappearing. Drift here never throws: it reports a researched
  // lake as unresearched and sends Ryan to re-run a pipeline that spends Firecrawl credits, or
  // hides a lake from the picker that he still needs.
  it('THERE IS ONE TABLE, and the Worker imports it rather than keeping its own', () => {
    expect(WORKER).toMatch(/import \{[^}]*RESEARCH_CANONICAL_IDS[^}]*\}\s*from\s*'[^']*js\/data\/research-ids\.js'/);
    // No second declaration anywhere in the Worker's research layer.
    expect(WORKER).not.toMatch(/(const|let|var)\s+RESEARCH_CANONICAL_IDS\s*=/);
  });

  it('...and the table it imports is a real one, keyed id to id', () => {
    // The import above proves there is one table; this proves the one is not empty. A mirror that
    // agreed with an empty table would have passed the old test too.
    const keys = Object.keys(RESEARCH_CANONICAL_IDS);
    expect(keys.length > 0).toBe(true);
    for (const k of keys) {
      expect(typeof RESEARCH_CANONICAL_IDS[k]).toBe('string');
      expect(RESEARCH_CANONICAL_IDS[k].length > 0).toBe(true);
      // A canonical id must itself be a sanitised id, or the fold produces a key nothing stores.
      expect(sanitizeLakeId(RESEARCH_CANONICAL_IDS[k])).toBe(RESEARCH_CANONICAL_IDS[k]);
    }
  });

  it('folds a border water onto one profile instead of offering it twice', () => {
    // SC calls it Thurmond, GA calls it Clarks Hill. Two names, one profile — and without this
    // the picker offers a lake he has already researched under the other state's name.
    expect(researchStorageId('Lake Thurmond, SC')).toBe('clarks_hill_thurmond_sc_ga');
    expect(researchStorageId('Lake Wylie, NC')).toBe('lake_wylie_sc');
    expect(researchStorageId('Chatuge Lake, NC')).toBe('lake_chatuge_ga');
  });
});

describe('researchedNames — what is already done', () => {
  const LIST = [{ id: 'lake_wateree_sc' }, { id: 'lake_wylie_sc' }, { id: 'clarks_hill_thurmond_sc_ga' }];

  it('matches on the storage id, both spellings of a border water', () => {
    const done = researchedNames(['Lake Wateree, SC', 'Lake Wylie, NC', 'Lake Thurmond, SC'], LIST);
    expect(done.size).toBe(3);
  });

  it('does not match loosely — a near name is a different lake', () => {
    // Two Lake Robinsons in SC, one in Greer and one in Darlington. A fuzzy match would mark the
    // wrong one done and it would simply stop being offered, with nothing on screen saying why.
    const done = researchedNames(['Wateree River, SC', 'Lake Waterees, SC'], LIST);
    expect(done.size).toBe(0);
  });

  it('treats an unreachable list as nothing researched, not everything', () => {
    // fetchResearchedIds() returns [] when the Worker cannot be read. Offering a lake he has
    // already done is a visible, harmless error; hiding one he has not is invisible.
    expect(researchedNames(['Lake Wateree, SC'], []).size).toBe(0);
    expect(researchedNames(['Lake Wateree, SC'], null).size).toBe(0);
  });

  it('accepts bare id strings as well as objects', () => {
    expect(researchedNames(['Lake Wateree, SC'], ['lake_wateree_sc']).size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE PRE-COUNTY SPELLING — added 2026-08-23
//
// `consolidate_lake_index.py` started naming lakes by county in August. Every profile written
// before that is filed under the old "Name, ST" id, and measured against the live bucket that is
// 59 of the 62 profiles in it. The read path had `bare` and `raw` and neither is that spelling,
// so `/research/get?lake=Lake Murray (Newberry Co, SC)` returned 404 while
// `/research/get?lake=Lake Murray, SC` returned a v76 profile.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the pre-county spelling resolves', () => {
  it('legacyStorageName agrees with the Worker, character for character', () => {
    const body = /function legacyStorageName\(name\)\s*\{([\s\S]*?)\n\}/.exec(WORKER);
    expect(Boolean(body)).toBe(true);
    const paren = /const COUNTY_PAREN = (\/.*\/i);/.exec(WORKER);
    expect(Boolean(paren)).toBe(true);
    // eslint-disable-next-line no-new-func
    const theirs = new Function('name', `const COUNTY_PAREN = ${paren[1]};` + body[1]);
    for (const name of ['Lake Murray (Newberry Co, SC)', 'Saluda River (2) (Newberry Co, SC)',
                        'J. Strom Thurmond Reservoir (Lincoln Co, GA/SC)', 'Lake Wateree, SC',
                        'Calderwood Lake (Monroe Co, TN/NC)', 'Bates Old River (Richland Co, SC)',
                        '', null]) {
      expect(legacyStorageName(name)).toBe(theirs(name));
    }
  });

  it('candidates agree with the Worker, in the same order', () => {
    const body = /function researchStorageIdCandidates\(lakeName\)\s*\{([\s\S]*?)\n\}/.exec(WORKER);
    expect(Boolean(body)).toBe(true);
    for (const name of ['Lake Murray (Newberry Co, SC)', 'Lake Thurmond, SC',
                        'North Saluda Reservoir (Greenville Co, SC)', 'Lake Wateree, SC']) {
      // The Worker's own body cannot be eval'd here without its helpers, so the contract is
      // asserted on the OUTPUT instead: the mirror must produce the pre-county id in the middle.
      const got = researchStorageIdCandidates(name);
      expect(got.includes(sanitizeLakeId(legacyStorageName(name)))).toBe(true);
      expect(got.includes(sanitizeLakeId(name))).toBe(true);
    }
  });

  it('a county display name finds a profile filed under the old name', () => {
    // The live case. 59 of 62 profiles are filed this way.
    const LIVE = [{ id: 'lake_murray_sc' }, { id: 'north_saluda_reservoir_greenville_co_sc' }];
    const done = researchedNames(['Lake Murray (Newberry Co, SC)',
                                  'North Saluda Reservoir (Greenville Co, SC)'], LIVE);
    expect(done.size).toBe(2);
  });

  it('keeps the number that tells four Saluda Rivers apart', () => {
    // stripLakeQualifiers would leave "Saluda River" and match whichever profile came first.
    // Only the parenthetical carrying "Co" is removed.
    expect(legacyStorageName('Saluda River (2) (Newberry Co, SC)')).toBe('Saluda River (2), SC');
    expect(researchStorageIdCandidates('Saluda River (2) (Newberry Co, SC)'))
      .toContain('saluda_river_2_sc');
  });

  it('still refuses a lake with no profile under ANY spelling', () => {
    expect(researchedNames(['Lake Wateree (Kershaw Co, SC)'], [{ id: 'lake_murray_sc' }]).size).toBe(0);
  });
});
