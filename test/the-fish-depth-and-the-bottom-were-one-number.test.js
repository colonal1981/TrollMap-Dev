import { describe, it, expect } from './expect-shim.mjs';
import { describeDepthBand } from '../js/modules/plan-inputs.js';

// ---------------------------------------------------------------------------
// Why this test exists
//
// The object below is not invented. It is `plan.conditions.depthBand` copied
// out of the plan Ryan saved on 2026-09-05, "Lake Wateree - Clearwater AM
// Troll Sep 5", the one he called complete garbage:
//
//   ft:           [3, 15]
//   waterDepthFt: [3, 15]
//   meaning:      "where the fish are, not the depth of the water"
//   sourceQuote:  "Dam areas with fast current in 3-15 feet of water; ..."
//
// The quote names the quantity out loud -- feet OF WATER -- and the record
// wrote that number into the fish depth as well, then attached a note
// explaining the very distinction it had just collapsed. Downstream, a 6-12 ft
// crankbait went over 5.9 ft of water three times.
//
// Ryan's own reading is why the band itself is not thrown away: "even the
// guide post i mentioned could give you 3-15 feet... in the morning topwater
// (3ft) perch at 15ft on humps". The numbers can be real. Calling them a fish
// depth when nobody said so is what is not.
//
// The test is an equality test, not a threshold. No number is invented.
// ---------------------------------------------------------------------------

const WATEREE_SEP_5 = {
  band: [3, 15],
  holding: 'suspended',
  waterDepthFt: [3, 15],
  basis: 'researched profile for this lake — Striped Bass, summer',
  sourceQuote: 'Dam areas with fast current in 3-15 feet of water; Rocky points and current breaks',
};

describe('describeDepthBand — one number cannot be two quantities', () => {
  it('refuses to call a collapsed band a fish depth', () => {
    const d = describeDepthBand(WATEREE_SEP_5, 'Striped Bass', 'summer');
    expect(d.fishDepthStated).toBe(false);
    expect(d.meaning).not.toMatch(/where the fish are/);
  });

  it('keeps the band — it is still the best water to look in', () => {
    const d = describeDepthBand(WATEREE_SEP_5, 'Striped Bass', 'summer');
    expect(d.ft).toEqual([3, 15]);
    expect(d.waterDepthFt).toEqual([3, 15]);
  });

  it('tells the model not to pick a lure by that number alone', () => {
    const d = describeDepthBand(WATEREE_SEP_5, 'Striped Bass', 'summer');
    expect(d.note).toMatch(/not as a depth to run a bait at/);
    expect(d.note).toMatch(/holding depth is unknown/);
  });

  it('leaves a genuinely separated band exactly as it was', () => {
    // Suspended at 20 over 35 ft of water — the case the fisheries prompt
    // spells out. Two quantities, two numbers, nothing to warn about.
    const d = describeDepthBand(
      { band: [20, 20], holding: 'suspended', waterDepthFt: [35, 35] },
      'Striped Bass', 'summer');
    expect(d.fishDepthStated).toBe(true);
    expect(d.meaning).toMatch(/where the fish are/);
    expect(d.note).toMatch(/are suspended here/);
  });

  it('does not fire when the record never stated a water depth', () => {
    const d = describeDepthBand(
      { band: [12, 22], holding: 'bottom', waterDepthFt: null }, 'Blue Catfish', 'fall');
    expect(d.fishDepthStated).toBe(true);
    expect(d.meaning).toMatch(/where the fish are/);
  });

  it('survives the empty case that has always been allowed through', () => {
    // plan-water-ui called this with undefined for weeks; it must not throw.
    const d = describeDepthBand(undefined, 'Striped Bass', 'summer');
    expect(d.ft).toBe(null);
    expect(d.fishDepthStated).toBe(true);   // nothing collapsed, because nothing was stated
  });
});
