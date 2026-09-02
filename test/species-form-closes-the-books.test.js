/**
 * species-form-closes-the-books.test.js — the plan form and the four regulation digests agree.
 *
 * `registry/species_map.json` maps what a book calls a fish onto what the plan form offers, and it
 * had been measuring the cost of a form chosen from memory: across the SC, NC, GA and TN digests,
 * 158 species phrases resolved to "no checkbox for this fish", so no rule on any of them could ever
 * fire. SMALLMOUTH BASS carries a separate DATED window on Cherokee, Norris and Douglas and the
 * angler could not say they were fishing for one. Nine of TWRA's ten reservoirs carry a ROCK BASS
 * rule. And SC's entire INSHORE FINFISH page resolved to nothing while the app already had a
 * checkbox for Red Drum, Speckled Trout, Flounder, Sheepshead, Black Drum, Bluefish and Tarpon --
 * because `plan_species.values` listed the fifteen FRESHWATER boxes and nothing else.
 *
 * Ryan, 2026-09-02: "if it is a species in the regs that is fishable from a kayak then go ahead and
 * add it... meaning nothing saltwater that is not inshore... this way we don't have to have this
 * conversation again."
 *
 * `plan_species.values` is a HAND-COPIED MIRROR of the two catalogues in species-selector.js, and
 * the build reads the copy, not the source. The first test here is the only thing standing between
 * that copy and silent drift.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { speciesGroupsFor } from '../js/modules/species-selector.js';
import { resolveR2Key } from '../js/data/lake-keys.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP = JSON.parse(readFileSync(path.join(ROOT, '..', 'registry', 'species_map.json'), 'utf8'));
const UTIL = readFileSync(path.join(ROOT, 'Worker', 'research', 'facts-util.js'), 'utf8');

const WATEREE = resolveR2Key('Lake Wateree, SC');
const WINYAH = resolveR2Key('Winyah Bay / Georgetown, SC');
const flat = (groups) => groups.flatMap((g) => g.species);
const values = (groups) => flat(groups).map((s) => s.value);

const FRESH = speciesGroupsFor(WATEREE, null);
const SALT = speciesGroupsFor(WINYAH, null);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const between = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
const CANON = Object.fromEntries(
  [...between(UTIL, 'RESEARCH_SPECIES_CANON', '};').matchAll(/^\s*'([^']+)'\s*:\s*'([^']+)'/gm)]
    .map((m) => [m[1], m[2]]));
const NON_GAME = new Set(
  [...between(UTIL, 'NON_GAME_SPECIES', ']);').matchAll(/'([^']+)'/g)].map((m) => m[1]));

describe('the copy of the catalogue that the regulations build actually reads', () => {
  it('names every checkbox in both catalogues, and nothing else', () => {
    const boxes = new Set([...values(FRESH), ...values(SALT)]);
    const declared = new Set(MAP.plan_species.values);
    // Two directions, and the second one matters as much: a value left behind in the map after a
    // checkbox is renamed resolves a book phrase onto a species the form no longer offers.
    expect([...boxes].filter((v) => !declared.has(v)).sort()).toEqual([]);
    expect([...declared].filter((v) => !boxes.has(v)).sort()).toEqual([]);
  });

  it('resolves every species the book_phrases table promises', () => {
    const declared = new Set(MAP.plan_species.values);
    const bad = [];
    for (const [phrase, list] of Object.entries(MAP.book_phrases)) {
      if (phrase.startsWith('_')) continue;
      for (const s of list) if (!declared.has(s)) bad.push(`${phrase} -> ${s}`);
    }
    for (const [phrase, v] of Object.entries(MAP.partly_mapped)) {
      if (phrase.startsWith('_')) continue;
      for (const s of (v.plan || [])) if (!declared.has(s)) bad.push(`${phrase} -> ${s}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('a checkbox the filter could never reveal is worse than an honest gap', () => {
  it('every freshwater box is a species this codebase already knows', () => {
    const unknown = values(FRESH).filter((v) => !CANON[norm(v)]);
    // Hybrid and White Bass both fold onto 'White Bass / Hybrid' and declare `covers` instead.
    expect(unknown).toEqual([]);
  });

  it('and none of them is classified as forage', () => {
    // `american shad` sits in NON_GAME_SPECIES, so uniqueResearchSpecies() strips it before a
    // roster is written and heldByWater() could never see it. A box for it can never appear.
    const forage = values(FRESH).filter((v) => NON_GAME.has(norm(v)));
    expect(forage).toEqual([]);
  });

  it('the group boxes say which species they stand for', () => {
    for (const value of ['Crappie', 'Catfish', 'Trout', 'Hybrid', 'White Bass']) {
      const spec = flat(FRESH).find((s) => s.value === value);
      expect(Array.isArray(spec.covers) && spec.covers.length > 0).toBe(true);
    }
  });
});

describe('the form shows what the water holds', () => {
  const profile = (species) => ({ biology: { predatorSpecies: species } });

  it('a lake that holds nine fish does not offer thirty-five', () => {
    const v = values(speciesGroupsFor(WATEREE, profile(
      ['Largemouth Bass', 'Black Crappie', 'Blue Catfish', 'Bluegill', 'White Perch'])));
    expect(v).toContain('Largemouth Bass');
    expect(v).toContain('Crappie');      // the roster says Black Crappie; the box is the group
    expect(v).toContain('Catfish');      // and Blue Catfish reaches it through `covers`
    expect(v).toContain('Bluegill');
    expect(v).toContain('Striped Bass'); // the default tick is never filtered away
    expect(v).not.toContain('Muskellunge');
    expect(v).not.toContain('Shoal Bass');
    expect(v.length).toBeLessThan(12);
  });

  it('never hides a species the angler has already ticked', () => {
    const v = values(speciesGroupsFor(WATEREE, profile(['Largemouth Bass']), ['Muskellunge']));
    expect(v).toContain('Muskellunge');
  });

  it('shows the whole catalogue when the water has not told us anything', () => {
    expect(values(speciesGroupsFor(WATEREE, null)).length).toBe(35);
    expect(values(speciesGroupsFor(WATEREE, { biology: {} })).length).toBe(35);
    expect(values(speciesGroupsFor(WINYAH, null)).length).toBe(19);
  });

  it('an inland lake still never offers tarpon, filtered or not', () => {
    expect(values(speciesGroupsFor(WATEREE, profile(['Tarpon'])))).not.toContain('Tarpon');
  });

  it('a filtered-out species does not come back as a research discovery', () => {
    const p = { biology: { predatorSpecies: ['Largemouth Bass'] },
                trollingIntelligence: { 'Largemouth Bass': {}, Muskellunge: {} } };
    const groups = speciesGroupsFor(WATEREE, p);
    const extras = groups.filter((g) => /research/i.test(g.label)).flatMap((g) => g.species);
    expect(extras).toEqual([]);
    // Muskellunge is in the catalogue, so naming it in the research reveals its own box.
    expect(values(groups)).toContain('Muskellunge');
  });
});

describe('the fish the books name and the form still cannot express', () => {
  it('says why for every one of them', () => {
    const bad = Object.entries(MAP.no_home_in_the_form)
      .filter(([k]) => !k.startsWith('_'))
      .filter(([, v]) => typeof v !== 'string' || v.trim().length < 8)
      .map(([k]) => k);
    expect(bad).toEqual([]);
  });
});
