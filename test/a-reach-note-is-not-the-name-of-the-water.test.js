// A REACH NOTE IS NOT THE NAME OF THE WATER.
//
// Ryan, 2026-09-15, running a bench plan: "first bug i see is on the conditions tab and it says
// congaree river, sc does not resolve to a registry record."
//
// It has a row. It has a chartpack, 2,543 contour features, a boundary, 29 depth bands and
// fourteen ramps across three sources. What it does not have is a name anyone calls it:
//
//   name                   Congaree River (to SC-601)
//   display_name           Congaree River (to SC-601) (Richland Co, SC)
//   legacy_display_name    Congaree River (to SC-601), SC
//   legacy_display_names   ["Congaree River (to SC-601), SC"]
//
// normName() strips a trailing county or state stamp and KEEPS the words of anything else in
// brackets, which is deliberate and right -- `(Lower Saluda)`, `(Union County)` and `(2)` are the
// only thing separating two real waters. So all four names claim the key `601 congaree river sc
// to`, the picker offers `Congaree River, SC` which normalises to `congaree river`, and the two
// never meet.
//
// TWO RESOLVERS, ONE QUESTION, DIFFERENT ANSWERS -- which is the shape of half the defects in this
// app. access-index.js's normalizeRegistryKey() strips EVERY parenthetical and would have matched
// this; lake-registry.js's normName() keeps them and did not. conditions-strip.js calls the
// second one.
//
// THE SLUG SETTLES IT, for every row rather than for Congaree. consolidate_lake_index.py builds
// the slug out of what it considers identifying, so a parenthetical whose words are in the slug is
// a disambiguator and must be kept, and one whose words are not is a note.
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'js', 'data', 'lake-registry.js'), 'utf8');
const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// withoutNotes() is module-private, so the rule is reproduced here from the source's own regex and
// the SOURCE is pinned separately below. A test that only read the file would pass on a comment.
const withoutNotes = (name, slug) => {
  const sl = String(slug || '').toLowerCase();
  return String(name || '').replace(/\(([^()]*)\)/g, (whole, inner) => {
    const words = String(inner).toLowerCase().match(/[a-z0-9]+/g);
    return words && words.length && words.every((w) => sl.includes(w)) ? whole : ' ';
  });
};
const squash = (s) => s.replace(/\s+/g, ' ').trim();

describe('the slug says whether a bracket is a name or a note', () => {
  it('drops the reach note that broke Congaree', () => {
    expect(squash(withoutNotes('Congaree River (to SC-601)', 'congaree_river')))
      .toBe('Congaree River');
  });

  it('keeps an ordinal, because that IS which river it is', () => {
    // "Broad River (2)" and "Broad River" are different water hundreds of miles apart.
    expect(squash(withoutNotes('Broad River (2)', 'broad_river_2'))).toBe('Broad River (2)');
    expect(squash(withoutNotes('Pee Dee River (2)', 'pee_dee_river_2'))).toBe('Pee Dee River (2)');
  });

  it('keeps a named reach and a named county, which separate two real waters', () => {
    expect(squash(withoutNotes('Saluda River (Lower Saluda)', 'saluda_river_lower_saluda')))
      .toBe('Saluda River (Lower Saluda)');
    expect(squash(withoutNotes('Cane Creek Lake (Union County)', 'cane_creek_lake_union_county')))
      .toBe('Cane Creek Lake (Union County)');
    expect(squash(withoutNotes('Lake Robinson (Greer)', 'lake_robinson_greer')))
      .toBe('Lake Robinson (Greer)');
  });

  it('drops a county stamp, which normName would have stripped anyway', () => {
    expect(squash(withoutNotes('Congaree River (Richland Co, SC)', 'congaree_river')))
      .toBe('Congaree River');
  });

  it('drops a legacy bracket the slug never took, which is the second row this fixes', () => {
    // sands_pond carries the legacy name "Bid Sands Lake (East)" and nobody had hit it.
    expect(squash(withoutNotes('Bid Sands Lake (East)', 'sands_pond'))).toBe('Bid Sands Lake');
  });

  it('is unmoved by a name with no brackets at all, which is almost every row', () => {
    expect(withoutNotes('Lake Wateree', 'wateree_lake')).toBe('Lake Wateree');
    expect(withoutNotes('', 'x')).toBe('');
  });

  it('drops an empty bracket, because it carries no identity to keep', () => {
    // `words.every()` on an empty list is vacuously TRUE, so without the `words && words.length`
    // guard `()` would read as "every word is in the slug" and be KEPT as though it named
    // something. The guard turns "no words" into "nothing to identify with" -- drop. The first
    // draft of this test asserted the opposite and reasoned backwards to get there.
    expect(squash(withoutNotes('Odd Name ()', 'odd_name'))).toBe('Odd Name');
  });

  it('needs EVERY word in the slug, not just one', () => {
    // "(to SC-601)" contains "sc", and congaree_river does not -- but a slug like
    // "sc_river" would contain it. One word matching must not carry the bracket.
    expect(squash(withoutNotes('Some River (to SC-601)', 'sc_river'))).toBe('Some River');
  });
});

describe('the index gains keys and surrenders none', () => {
  it('registers the note-stripped key beside the full one', () => {
    expect(CODE).toContain('const noteFree = normName(withoutNotes(n, r.slug));');
  });

  it('is first-writer-wins, so it cannot take a key a real name already holds', () => {
    expect(CODE).toContain('!_normIndex.has(noteFree)');
  });

  it('does not touch the state index, where `bare` answers a different question', () => {
    // `bare` strips ORDINALS for the state index -- "which Broad River". This strips BRACKETS for
    // the blind index -- "is this bracket part of the name". Two rules, two indexes, and merging
    // them would make "Broad River (2)" resolvable without a state, which it must not be.
    const stateBlock = CODE.split('_normStateIndex.set')[0].split('const bare =')[1] || '';
    expect(stateBlock.includes('noteFree')).toBe(false);
  });

  it('still keeps the full key, so the bracketed name resolves too', () => {
    expect(CODE).toContain('if (!_normIndex.has(k)) _normIndex.set(k, r);');
  });
});
