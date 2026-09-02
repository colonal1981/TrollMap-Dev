/**
 * the-prompt-was-sent-object-object.test.js — an array of objects joined is not a sentence.
 *
 * `researchIntel()` builds the researched block of the plan prompt, and `put('Stockings',
 * bio.knownStockings)` has been in it since the block was written. Every SAVED profile holds that
 * field as objects: coerceStockingsArray() at lake-research-engine.js:3526 turns the bare strings
 * into `{species}` on the way in, and the LLM schema in facts-util.js:216 emits
 * `{species, agency, note}` directly. `put`'s array branch was `v.join('; ')`.
 *
 * Measured 2026-09-02:  `Stockings: [object Object]; [object Object]`
 *
 * It survived because it reads correctly on exactly one path -- NC's deterministic roster, where
 * uniqueResearchSpecies() returns plain strings. Every water anybody checked by hand was an NC
 * water, and every other water sent the model two words of nothing.
 *
 * This matters more than a formatting nit: NC WRC publishes the stocking NUMBERS (37,500 bodie
 * bass into Hyco Lake at 1-2 in.), and there was no point extracting them into a field that
 * reached the prompt as `[object Object]`.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */
import { describe, it, expect } from './expect-shim.mjs';
import { researchIntel } from '../js/modules/plan-inputs.js';

const lineFor = (profile, label) => {
  const out = researchIntel(profile, 'Striped Bass', 'summer');
  const text = Array.isArray(out) ? out.join('\n') : String((out && out.text) || out || '');
  return text.split('\n').find((l) => l.includes(`${label}:`)) || '';
};

describe('the researched block never stringifies an object', () => {
  it('renders the stored shape — objects — as fish names', () => {
    const line = lineFor({ biology: { knownStockings: [
      { species: 'Striped Bass' }, { species: 'Walleye' }] } }, 'Stockings');
    expect(line).toContain('Striped Bass');
    expect(line).toContain('Walleye');
    expect(line).not.toContain('[object Object]');
  });

  it('leads with the fish and carries the agency numbers behind it', () => {
    const line = lineFor({ biology: { knownStockings: [
      { species: 'Bodie Bass', agency: 'NCWRC', note: '37,500 at 1-2 in., 2026' }] } }, 'Stockings');
    // The fish first, because that is what the sentence is about -- not `species (Bodie Bass)`.
    expect(/Stockings: Bodie Bass\b/.test(line)).toBe(true);
    expect(line).toContain('37,500 at 1-2 in., 2026');
  });

  it('still reads the deterministic path, which was the one that always worked', () => {
    const line = lineFor({ biology: { knownStockings: ['Striped Bass', 'Walleye'] } }, 'Stockings');
    expect(line).toContain('Striped Bass; Walleye');
  });

  it('drops an element that names no fish rather than printing an empty gap', () => {
    const line = lineFor({ biology: { knownStockings: [
      { species: 'Walleye' }, null, {}, ''] } }, 'Stockings');
    expect(line).toBe('- Stockings: Walleye');
  });

  it('and the same fix holds for every other array of objects in the block', () => {
    // The bug was fixed for the CLASS. predatorSpecies is strings today and could be objects
    // tomorrow -- the LLM schema already emits objects for two of its neighbours.
    const line = lineFor({ biology: { predatorSpecies: [
      { species: 'Largemouth Bass' }, 'Bluegill'] } }, 'Other predators here');
    expect(line).toContain('Largemouth Bass');
    expect(line).toContain('Bluegill');
    expect(line).not.toContain('[object Object]');
  });
});
