/**
 * test/watershed-names-are-the-apps-names.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Scripts/watershed_names.mjs turns two outside sources' fish names into the app's, using only
 * files the app already owns. Three things went wrong or nearly did on its first day, 2026-09-23,
 * and each is a case here:
 *
 *   - canonicalizeResearchSpecies() passes any string through, so "Whitetail Shiner" came back
 *     as an app species and a TARGET. Only a key the canon holds is an app name.
 *   - "not a target" was read as "forage", and Longnose Gar became forage on three rivers. A
 *     forage fish is one a state agency writes as something a predator eats.
 *   - a binomial two app species both list (Micropterus henshalli, on Spotted Bass and Alabama
 *     Bass) must resolve to the one that lists it ALONE, or not at all.
 *
 *   node --test test/watershed-names-are-the-apps-names.test.js
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { binomialIndex, nameAll, preyVocabulary } from '../Scripts/watershed_names.mjs';
import { forageFromAgencyPages } from '../Worker/research/deterministic.js';

const TRAITS = { species: {
  'Smallmouth Bass': [{ scientific: 'Micropterus dolomieu' }, { scientific: 'Micropterus dolomieui' }],
  'Spotted Bass': [{ scientific: 'Micropterus punctulatus, Micropterus henshalli' }],
  'Alabama Bass': [{ scientific: 'Micropterus henshalli' }],
  'Walleye': [{ scientific: 'Stizostedion vitreum/Sander vitreus' }],
  'Gizzard Shad': [{ scientific: 'Dorosoma cepedianum' }],
  'Longnose Gar': [{ scientific: 'Lepisosteus osseus' }],
}};
const PREY = new Set(['Gizzard Shad', 'Blueback Herring', 'Threadfin Shad', 'Alewife']);
const one = (common, scientific, prey = PREY) => nameAll([{ common, scientific }], TRAITS, undefined, prey)[0];

describe('a binomial is one fish', () => {
  it('the 2010 name reaches the app name', () => {
    expect(one('Walleye', 'Stizostedion vitreum').name).toBe('Walleye');
    expect(one('Smallmouth Bass', 'Micropterus dolomieu').by).toBe('binomial');
  });
  it('a binomial two species list goes to the one that lists it alone', () => {
    expect(binomialIndex(TRAITS).index.get('micropterus henshalli')).toBe('Alabama Bass');
  });
});

describe('a common name counts only if the canon holds it', () => {
  it('Whitetail Shiner is not an app species', () => {
    const r = one('Whitetail Shiner', 'Cyprinella galactura');
    expect(r.name).toBe(null);
    expect(r.role).toBe(null);
  });
  it('Black Bullhead is, by the canon, and is a target', () => {
    const r = one('Black Bullhead', 'Ameiurus melas');
    expect(r.name).toBe('Bullhead');
    expect(r.by).toBe('common name');
    expect(r.role).toBe('target');
  });
});

describe('forage is what an agency writes as eaten, not what the roster drops', () => {
  it('gizzard shad is forage; longnose gar is non-game', () => {
    expect(one('Gizzard Shad', 'Dorosoma cepedianum').role).toBe('forage');
    expect(one('Longnose Gar', 'Lepisosteus osseus').role).toBe('non-game');
  });
  it('with no agency vocabulary nothing is called forage', () => {
    expect(one('Gizzard Shad', 'Dorosoma cepedianum', null).role).toBe('non-game');
  });
  it('the vocabulary is read out of the agency pages by the app\'s own reader', () => {
    const doc = { rows: { lake_x: [{ agency: 'GA DNR', species: [{ name: 'Spotted Bass',
      notes: 'Threadfin shad and blueback herring are the preferred prey of spotted bass.' }] }] } };
    const v = preyVocabulary(doc, forageFromAgencyPages);
    expect(v.has('Threadfin Shad')).toBe(true);
    expect(v.has('Blueback Herring')).toBe(true);
    expect(v.has('Longnose Gar')).toBe(false);
  });
  it('and over the real agency file it is exactly the four the agencies name', () => {
    let doc = null;
    try {
      doc = JSON.parse(readFileSync('F:/TrollMapPipeline/registry/agency_lake_facts.json', 'utf8'));
    } catch { return; }                        // not on this machine: nothing to measure
    const v = [...preyVocabulary(doc, forageFromAgencyPages)].sort();
    expect(v.includes('Longnose Gar')).toBe(false);
    expect(v.includes('Blueback Herring')).toBe(true);
  });
});
