// EVERY RESEARCH SEARCH WAS EXACT-PHRASE-ANCHORED ON A STRING THAT EXISTS NOWHERE.
//
// discover.js built its quoted phrase with a state-suffix strip anchored to the END of the name.
// Registry display names do not end in ", SC" -- they end in a county parenthetical -- so nothing
// was stripped and what went out was:
//
//     "Congaree River (to SC-601) (Richland Co, SC)" fishing shoals ledges bends ...
//
// Measured 2026-09-16 against lake_index.json: 285 of 285 lakes, 57 of 57 rivers, 11 of 13 coastal
// -- 353 of 355. The phrase matched nothing, the provider fell back to loose matching, and what
// came back was about the COUNTY. The run that exposed it returned 0 facts from 5 documents and
// had a hail map for Columbia among its candidates.
//
// keys.js diagnosed this exact regex on 2026-08-16 and stripLakeQualifiers() was written and
// exported to fix it. discover.js already imported its sibling and used the cleaned name for
// relevance scoring, agency names and three Grokipedia URLs -- every consumer except the search.
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { stripLakeQualifiers } from '../Worker/research/keys.js';
import { stateFullName, STATE_NAMES } from '../Worker/research/dataset.js';

// Real display names, copied off registry/lake_index.json on 2026-09-16.
const REAL_NAMES = [
  ['Congaree River (to SC-601) (Richland Co, SC)', 'Congaree River'],
  ['Lake Marion (Clarendon Co, SC)', 'Lake Marion'],
  ['J. Strom Thurmond Reservoir (Lincoln Co, GA/SC)', 'J. Strom Thurmond Reservoir'],
  ['Hartwell Lake (Anderson Co, SC/GA)', 'Hartwell Lake'],
  ['Savannah River (Aiken Co, GA)', 'Savannah River'],
  ['ACE Basin / Edisto, SC (Colleton Co, SC)', 'ACE Basin / Edisto'],
  ['Broad River (2) (Union Co, SC)', 'Broad River'],
];

describe('the anchor is now a name a page could actually contain', () => {
  it('clears the county, the reach note and the disambiguator', () => {
    for (const [raw, want] of REAL_NAMES) expect(stripLakeQualifiers(raw)).toBe(want);
  });

  it('keeps the words that make it findable', () => {
    // parseLakeBaseName would give "Wateree" here -- right for a KEY, wrong for a SEARCH.
    expect(stripLakeQualifiers('Wateree Lake (Kershaw Co, SC)')).toBe('Wateree Lake');
    expect(stripLakeQualifiers('Lake Murray (Lexington Co, SC)')).toBe('Lake Murray');
  });

  it('leaves a name that was already clean alone', () => {
    expect(stripLakeQualifiers('Congaree River')).toBe('Congaree River');
  });

  it('never leaves a parenthesis behind, which is the whole bug', () => {
    for (const [raw] of REAL_NAMES) {
      const out = stripLakeQualifiers(raw);
      expect(out.includes('(')).toBe(false);
      expect(out.includes(')')).toBe(false);
    }
  });
});

describe('THE CENSUS, against the real registry', () => {
  // Not a fixture. This reads registry/lake_index.json if it is beside the repo and asserts the
  // count that made this worth fixing is now zero. Skipped with a loud note when the registry is
  // not reachable, because a test that silently passes on a missing input is the shape this
  // project has been burned by.
  const IDX = new URL('../../registry/lake_index.json', import.meta.url);
  const have = existsSync(IDX);

  it('no offered water carries a parenthetical into its search phrase', () => {
    if (!have) {
      console.log('    [skipped] registry/lake_index.json not beside the repo on this machine');
      expect(true).toBe(true);
      return;
    }
    const d = JSON.parse(readFileSync(IDX, 'utf8'));
    let rows = (d && d.lakes) ? d.lakes : d;
    rows = Array.isArray(rows) ? rows : Object.values(rows);
    const bad = rows
      .filter((r) => r && typeof r === 'object')
      .map((r) => r.display_name || r.name || r.slug)
      .filter((n) => stripLakeQualifiers(n).includes('('));
    expect(bad.length).toBe(0);
  });
});

describe('the state that the county was accidentally providing', () => {
  // Cleaning the anchor costs disambiguation. Measured 2026-09-16: `"Broad River" fishing shoals
  // ledges bends current seams holes` returns the SC Broad, the NC Broad, the French Broad AND
  // Virginia's New River; adding the spelled-out state drops the last two and lifts the SC pages.
  it('spells the state out, because a fishing page says South Carolina and not SC', () => {
    expect(stateFullName('SC')).toBe('South Carolina');
    expect(stateFullName('NC')).toBe('North Carolina');
    expect(stateFullName('GA')).toBe('Georgia');
    expect(stateFullName('TN')).toBe('Tennessee');
  });

  it('is case-insensitive and falls back the way it always did', () => {
    expect(stateFullName('sc')).toBe('South Carolina');
    expect(stateFullName('')).toBe('South Carolina');
    expect(stateFullName(null)).toBe('South Carolina');
    expect(stateFullName('ZZ')).toBe('South Carolina');
  });

  it('is ONE map, not a second copy -- buildNepisSearchUrl uses this same export', () => {
    expect(Object.keys(STATE_NAMES).sort()).toEqual(['GA', 'NC', 'SC', 'TN', 'VA']);
    const src = readFileSync(new URL('../Worker/research/dataset.js', import.meta.url), 'utf8');
    expect(src.includes('const stateName = stateFullName(state);')).toBe(true);
    // The inline copy this replaced must not come back.
    expect(/\{\s*SC:\s*'South Carolina'[^}]*\}\s*\[String\(state/.test(src)).toBe(false);
  });
});

describe('discover.js wiring -- TRIPWIRES ON A NAME, not checks on behaviour', () => {
  // Same caveat as every other structural block in this suite: the query is built inside a route
  // handler that wants env, R2 and fetch. These catch a deletion and nothing more.
  const src = readFileSync(new URL('../Worker/research/discover.js', import.meta.url), 'utf8');

  it('anchors on the cleaned name', () => {
    expect(src.includes('const queryLake = stripLakeQualifiers(lakeName)')).toBe(true);
    // The end-anchored strip that caused this must not be what builds the phrase again.
    expect(src.includes('const queryLake = lakeName.replace(')).toBe(false);
  });

  it('adds the state once, where the query is issued', () => {
    expect(src.includes('stateFullName(state)')).toBe(true);
    expect(src.includes('/\\bsite:/i.test(base)')).toBe(true);
  });
});
