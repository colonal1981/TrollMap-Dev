// TWO JOBS, TWO RULES, AND ONE REGEX WAS DOING BOTH.
//
// /research/analyze-facts is told to keep only facts that mention `baseName`. That string is
// matched against DOCUMENT TEXT. The rule that built it stripped only the parenthetical
// containing "Co" -- deliberately, so that "Saluda River (2)" kept the ordinal that tells four
// Saluda Rivers apart. That argument is correct about a STORAGE KEY and wrong here: no document
// ever written says "Saluda River (2)".
//
// Measured 2026-09-16: 11 of 355 waters kept a parenthetical, 8 of them rivers. The Congaree was
// handed ten good documents and told to keep only facts mentioning "Congaree River (to SC-601)".
// It returned zero facts. Ryan: *"the 2 is our own made up thing... the saluda is the saluda."*
//
//     a name that IDENTIFIES A STORED OBJECT must be UNIQUE    -> legacyStorageName keeps "(2)"
//     a name that MATCHES DOCUMENT TEXT must be FINDABLE       -> lakeTerms, and now the others
//
// THE RESIDUAL RISK IS NAMED, NOT HIDDEN. "Saluda River (2)" and "Saluda River (Lower Saluda)"
// now share a base name, so a document about one can contribute a fact to the other. The aliases
// list and the off-lake gate are what stand between them, and neither separates two same-named
// waters in one state. That is the trade, taken deliberately: eight rivers go from zero facts to
// facts, and two Saludas can bleed.
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { legacyStorageName, stripLakeQualifiers } from '../Worker/research/keys.js';
import { lakeTerms } from '../js/utils/doc-relevance.js';

const SALUDA_2 = 'Saluda River (2) (Newberry Co, SC)';
const SALUDA_LOWER = 'Saluda River (Lower Saluda) (Lexington Co, SC)';
const CONGAREE = 'Congaree River (to SC-601) (Richland Co, SC)';

describe('the STORAGE key must stay unique, and did not move', () => {
  // The landmine. If this ever starts stripping the ordinal, two Saluda Rivers collide on one
  // key and one of them serves the other's profile -- the exact failure RESEARCH_CANONICAL_IDS
  // caused when a pond was handed a reservoir's whole profile.
  it('keeps the ordinal that tells four Saluda Rivers apart', () => {
    expect(legacyStorageName(SALUDA_2).includes('(2)')).toBe(true);
  });

  it('still drops only the county stamp and puts the state back', () => {
    expect(legacyStorageName(SALUDA_2)).toBe('Saluda River (2), SC');
    expect(legacyStorageName('Lake Murray (Lexington Co, SC)')).toBe('Lake Murray, SC');
  });

  it('gives the two Saludas DIFFERENT keys, which is its whole job', () => {
    expect(legacyStorageName(SALUDA_2)).not.toBe(legacyStorageName(SALUDA_LOWER));
  });
});

describe('the MATCHING name must be findable', () => {
  it('lakeTerms strips every parenthetical, and always did', () => {
    expect(lakeTerms(CONGAREE).baseName).toBe('Congaree River');
    expect(lakeTerms(SALUDA_2).baseName).toBe('Saluda River');
  });

  it('stripLakeQualifiers agrees with it, which is what the search anchor uses', () => {
    expect(stripLakeQualifiers(CONGAREE)).toBe('Congaree River');
    expect(stripLakeQualifiers(SALUDA_2)).toBe('Saluda River');
  });

  it('leaves nothing a document could not contain', () => {
    for (const n of [CONGAREE, SALUDA_2, SALUDA_LOWER, 'Lake Robinson (Greer) (Greenville Co, SC)',
                     'Cane Creek Reservoir (Orange County) (Orange Co, NC)']) {
      expect(lakeTerms(n).baseName.includes('(')).toBe(false);
      expect(stripLakeQualifiers(n).includes('(')).toBe(false);
    }
  });

  it('THE TRADE, stated: the two Saludas share a BASE name', () => {
    // Asserted so nobody rediscovers it as a surprise. The answer is the alias list below, never
    // putting the ordinal back into a document search.
    expect(lakeTerms(SALUDA_2).baseName).toBe(lakeTerms(SALUDA_LOWER).baseName);
  });
});

describe('and the alias list is what keeps them apart', () => {
  // extract.js builds these inline, so they are reproduced here exactly rather than imported.
  // The rule: the bare name, PLUS the contents of any parenthetical that reads like a name --
  // not a county stamp, not a bare ordinal.
  const strip = (a) => String(a || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const inside = (a) => (String(a || '').match(/\(([^)]*)\)/g) || [])
    .map((p) => p.slice(1, -1).trim())
    .filter((p) => !/\bCo\b|\bCounty\b/i.test(p))
    .filter((p) => /[A-Za-z]{3}/.test(p));
  const aliases = (a) => [strip(a), ...inside(a)].filter((x) => x.length >= 4);

  it('recovers the term a document would actually use', () => {
    expect(aliases(SALUDA_LOWER)).toEqual(['Saluda River', 'Lower Saluda']);
  });

  it('drops the ordinal, which no document contains', () => {
    expect(aliases(SALUDA_2)).toEqual(['Saluda River']);
  });

  it('drops a reach note and a county qualifier too', () => {
    expect(aliases(CONGAREE)).toEqual(['Congaree River']);
    expect(aliases('Cane Creek Reservoir (Orange County) (Orange Co, NC)'))
      .toEqual(['Cane Creek Reservoir']);
  });

  it('keeps a place name, which is findable', () => {
    expect(aliases('Lake Robinson (Greer) (Greenville Co, SC)'))
      .toEqual(['Lake Robinson', 'Greer']);
  });

  it('SO THE TWO SALUDAS ARE SEPARABLE AGAIN, by a real name and not our ordinal', () => {
    const a = aliases(SALUDA_LOWER);
    const b = aliases(SALUDA_2);
    expect(a.some((x) => !b.includes(x))).toBe(true);
  });
});

describe('the three matching sites agree -- TRIPWIRES ON A NAME', () => {
  // Greps, and they catch a revert, not a behaviour. The first site was cleanLakeBaseName() in the
  // Research tab's engine until the tab was deleted on 2026-09-25; base_name() in the batch is
  // the one that sends a base name to the extractor now.
  const batch = readFileSync(new URL('../Scripts/research_lakes.py', import.meta.url), 'utf8');
  const ext = readFileSync(new URL('../Worker/research/extract.js', import.meta.url), 'utf8');
  const keys = readFileSync(new URL('../Worker/research/keys.js', import.meta.url), 'utf8');

  it("the batch's base_name strips every parenthetical", () => {
    const fn = batch.slice(batch.indexOf('def base_name('), batch.indexOf('\ndef ', batch.indexOf('def base_name(') + 1));
    expect(fn.includes('b = re.sub(r"\\s*\\([^)]*\\)\\s*", " "')).toBe(true);
    expect(fn.includes('\\bCo\\b')).toBe(false);
  });

  it("the extractor's own fallback strips every parenthetical", () => {
    expect(ext.includes(".replace(/\\s*\\([^)]*\\)\\s*/g, ' ')")).toBe(true);
    expect(ext.includes('\\bCo\\b[^)]*\\)\\s*/i')).toBe(false);
  });

  it('and the storage key STILL uses the county-only regex, because a key is not a match', () => {
    // legacyStorageName() moved from keys.js to js/data/research-ids.js on 2026-09-25 -- one copy,
    // which keys.js imports -- so the regex is asserted where it lives.
    const ids = readFileSync(new URL('../js/data/research-ids.js', import.meta.url), 'utf8');
    expect(ids.includes('\\bCo\\b')).toBe(true);
    expect(keys.includes("from '../../js/data/research-ids.js'")).toBe(true);
  });
});
