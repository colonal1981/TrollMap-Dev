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
import { describe as nodeDescribe, it, expect } from './expect-shim.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { speciesGroupsFor } from '../js/modules/species-selector.js';
import { resolveR2Key } from '../js/data/lake-keys.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── THE ONE FILE THE DEPLOY GATE CANNOT FETCH ─────────────────────────────────────────────────
//
// `registry/species_map.json` is pipeline data, not repo data, and unlike the other three registry
// objects the suite reads it is NOT published to R2 -- deliberately. It is resolved at BUILD time
// into `regulations.json` (see Worker/trollmap-worker.js, "Resolved at BUILD time from
// registry/species_map.json"), so nothing in the app ever fetches it, and adding it to the
// uploader's PASSTHROUGH_REGISTRIES to make CI's life easier would repeat the mistake that table
// already records: `nla_limnology.json` was added there on 2026-09-04 and taken out the next day
// because NOTHING IN THE APP OPENS IT.
//
// So this file skips when the map is absent, with the reason printed, rather than the workflow
// carrying a list of tests to leave out. A list of exceptions in a second place is the two-lists
// problem this repo already has a test against, and it drifts the first time a test is added.
//
// IT SKIPS, IT DOES NOT PASS. A test that quietly reports success over a file it could not read is
// verify_registry_r2.py printing that twenty objects matched over twenty it never compared.
const MAP_PATH = path.join(ROOT, '..', 'registry', 'species_map.json');
const HAVE_MAP = existsSync(MAP_PATH);
const MAP = HAVE_MAP ? JSON.parse(readFileSync(MAP_PATH, 'utf8')) : { species: {} };
// ONE WRAPPER, NOT TWELVE OPTIONS OBJECTS. Every suite in this file reads the map, so the skip goes
// on `describe` once and cannot be forgotten on a suite added later.
const describe = HAVE_MAP
  ? nodeDescribe
  : (name, fn) => nodeDescribe(name, { skip: 'registry/species_map.json is not beside the repo -- '
      + 'it is a BUILD-time input, deliberately unpublished, so a runner cannot fetch it. Run this '
      + 'on the pipeline machine.' }, fn);
const UTIL = readFileSync(path.join(ROOT, 'Worker', 'research', 'facts-util.js'), 'utf8');

const WATEREE = resolveR2Key('Lake Wateree, SC');
const WINYAH = resolveR2Key('Winyah Bay / Georgetown, SC');
const flat = (groups) => groups.flatMap((g) => g.species);
const values = (groups) => flat(groups).map((s) => s.value);

const FRESH = speciesGroupsFor(WATEREE, null);
const SALT = speciesGroupsFor(WINYAH, null);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// ── ANCHORED ON THE DECLARATION, NOT ON THE NAME ────────────────────────────────────────────────
//
// `between(UTIL, 'NON_GAME_SPECIES', ']);')` used indexOf on the NAME, and the first place that
// name appears in facts-util.js is a COMMENT 173 lines above the declaration -- the alewife note
// inside RESEARCH_SPECIES_CANON, "NON_GAME_SPECIES has known it since it was written". So the slice
// started in the middle of the canon table and ran to the first `]);` after it, and this file read
// half the canon as the forage list: `Hybrid` and `Redear Sunfish (Shellcracker)` came back as
// forage and the test went red on data that says nothing of the kind.
//
// A guard that greps source for a bare identifier is a guard that a comment can move. Both anchors
// are the declaration now, matched as a declaration, and a missing one throws here rather than
// silently slicing from position 0 -- an empty CANON would have made the test above pass on nothing.
const between = (src, declRe, to) => {
  const m = declRe.exec(src);
  if (!m) throw new Error(`facts-util.js no longer declares ${declRe} — this guard is reading the wrong file`);
  const start = m.index;
  const end = src.indexOf(to, start);
  if (end < 0) throw new Error(`no ${to} after ${declRe}`);
  return src.slice(start, end);
};
const CANON = Object.fromEntries(
  [...between(UTIL, /^\s*(?:export\s+)?const RESEARCH_SPECIES_CANON\b/m, '};')
    .matchAll(/^\s*'([^']+)'\s*:\s*'([^']+)'/gm)].map((m) => [m[1], m[2]]));
const NON_GAME = new Set(
  [...between(UTIL, /^\s*(?:export\s+)?const NON_GAME_SPECIES\b/m, ']);')
    .matchAll(/'([^']+)'/g)].map((m) => m[1]));

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
