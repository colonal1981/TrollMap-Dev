import { describe, it, expect } from './expect-shim.mjs';
import { depthBandFor, usableAhFrom } from '../js/modules/plan-inputs.js';
import { SPECIES_BEHAVIOR_V2, getSeason } from '../js/data/species-intel.js';

// ---------------------------------------------------------------------------
// Why this test exists
//
// Two traps, both found by loading the page in a browser rather than by
// reasoning about the code.
//
// 1. getSeason() returns 'summer'. A caller writing 'Summer' got no band, and
//    no band means the planner refuses before it reads the pack -- a silent
//    dead end for a capital letter.
//
// 2. SPECIES_BEHAVIOR_V2 covers FOUR lakes. The app ships fifteen hundred
//    packs. Three places reach for a `default_SC_reservoir` key that does not
//    exist, so everywhere else fell through -- v1 landed in a hardcoded
//    12-18 / 22-28 ft in a catch block, which is how every Hartwell plan has
//    ever been built.
//
// The rule that comes out of the second one: a generic band is fine, but it
// must never be presented as a lake-specific one.
// ---------------------------------------------------------------------------

const PROFILED = Object.keys(SPECIES_BEHAVIOR_V2['Striped Bass']);

describe('depthBandFor — the species depth band for a whole day', () => {
  it('uses the lake\'s own profile when the table has it', () => {
    const r = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'summer', 84);
    expect(r.generic).toBe(false);
    expect(r.basis).toBe('Lake Wateree');
    expect(r.band.length).toBe(2);
    expect(r.band[1] > r.band[0]).toBe(true);
  });

  it('does not care how the season is capitalised', () => {
    const a = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'summer', 84);
    const b = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'Summer', 84);
    const c = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'SUMMER', 84);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('agrees with what getSeason actually returns', () => {
    // The bug in one line: whatever getSeason emits has to resolve.
    const season = getSeason(new Date('2026-08-10T12:00:00'));
    expect(depthBandFor('Striped Bass', 'Lake Wateree, SC', season, 84)).not.toBe(null);
  });

  it('still answers when the water temperature is blank', () => {
    // preferredDepth is a function of temperature on some lakes, and planWaterTemp is often
    // empty. A throw or a nonsense answer must not filter out the entire lake.
    const r = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'summer', null);
    expect(r).not.toBe(null);
    expect(Number.isFinite(r.band[0]) && Number.isFinite(r.band[1])).toBe(true);
  });

  it('falls back to what the species does elsewhere, and says that it did', () => {
    const r = depthBandFor('Striped Bass', 'Lake Hartwell', 'summer', 84);
    expect(r.generic).toBe(true);
    expect(r.basis.includes('Lake Hartwell is not one of them')).toBe(true);
    // The union of profiled lakes, so it is wider than any one of them. Wide is the safe
    // direction for a filter: the model still picks inside it, and a narrow band would quietly
    // remove the whole lake.
    const own = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'summer', 84);
    expect(r.band[0] <= own.band[0]).toBe(true);
    expect(r.band[1] >= own.band[1]).toBe(true);
  });

  it('never labels a generic band as lake-specific', () => {
    for (const lake of ['Lake Hartwell', 'Lake Keowee', 'Clarks Hill Lake', 'Lake Wylie']) {
      const r = depthBandFor('Striped Bass', lake, 'summer', 84);
      expect(r.generic).toBe(true);
    }
    for (const lake of PROFILED) {
      const r = depthBandFor('Striped Bass', lake, 'summer', 84);
      if (r) expect(r.generic).toBe(false);
    }
  });

  it('returns null rather than guessing for a species nobody profiled', () => {
    expect(depthBandFor('Coelacanth', 'Lake Wateree, SC', 'summer', 84)).toBe(null);
    expect(depthBandFor('Striped Bass', 'Lake Wateree, SC', 'monsoon', 84)).toBe(null);
  });
});

describe('usableAhFrom — the reserve comes off before anyone sees the number', () => {
  it('takes 20% off a LiFePO4 pack', () => {
    expect(usableAhFrom('NK180 Pro 24V, 100Ah LiFePO4')).toBe(80);
    expect(usableAhFrom('50ah')).toBe(40);
  });

  it('assumes the 100 Ah pack when the field says nothing useful', () => {
    expect(usableAhFrom('')).toBe(80);
    expect(usableAhFrom(null)).toBe(80);
    expect(usableAhFrom('some motor')).toBe(80);
  });
});
