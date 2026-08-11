import { readFileSync } from 'node:fs';
import { describe, it, expect } from './expect-shim.mjs';
import { sanitizeLakeId, researchStorageId, researchedNames, RESEARCH_CANONICAL_IDS }
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

  it('carries every canonical id the Worker carries, and no extras', () => {
    const block = /const RESEARCH_CANONICAL_IDS = \{([\s\S]*?)\n\};/.exec(WORKER);
    expect(Boolean(block)).toBe(true);
    const theirs = {};
    for (const m of block[1].matchAll(/'([^']+)':\s*'([^']+)'/g)) theirs[m[1]] = m[2];
    expect(Object.keys(theirs).length > 0).toBe(true);
    expect(Object.keys(RESEARCH_CANONICAL_IDS).sort()).toEqual(Object.keys(theirs).sort());
    for (const k of Object.keys(theirs)) expect(RESEARCH_CANONICAL_IDS[k]).toBe(theirs[k]);
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
