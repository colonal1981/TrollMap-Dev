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

  // ── A MISSING WATER DEPTH USED TO BE READ AS PROOF, AND IT IS THE OPPOSITE ──────────────────
  //
  // These two asserted `fishDepthStated === true` for a record with NO water depth beside the band,
  // because fishDepthWasStated() opened with
  //
  //     if (!Array.isArray(band) || !Array.isArray(water)) return true;
  //
  // -- the absence of the second quantity taken as evidence about the first. A function named for
  // "was this stated" answered yes when its input said nothing at all.
  //
  // FOUND FROM RYAN'S OWN DAY, 2026-09-18. congaree_river, Largemouth Bass, summer:
  //
  //     [0, 5] ft · suspended · waterDepthFt null
  //     "Every few minutes as I worked along the shoreline, a largemouth bass would boil at,
  //      or take, my lure."
  //
  // A man on a bank getting surface boils, read as a suspended holding depth for a whole river.
  // Ten of the fifteen warnings on that plan were rods "fishing below the fish" measured against
  // it, while every source he checked put those fish on deep holes and channel swings -- which is
  // where the app had already put the legs. Right about the water, wrong about the fish.
  //
  // MEASURED ACROSS ALL 81 STORED PROFILES, read live off the Worker, 1,293 depth entries:
  //
  //     337  stated             a fish depth AND a different water depth, or a quote with a number
  //     198  one number         band == waterDepthFt, what this file was originally written for
  //     552  no citation at all
  //     206  a quote with no number in it
  //
  // 537 of the unsupported also name a `holding` position, which is the field that decides WHICH
  // WATER gets picked rather than what the prose says.
  //
  // The research prompt already forbids all of it -- "A quoted range and a reported range must
  // MATCH", and "If you are reporting a value from general knowledge of the species rather than
  // from anything in front of you, set sourceQuote to null". The model complied honestly 552 times
  // and the reader upgraded the honesty into a measurement.
  it('a band with no water depth and no citation is NOT a stated fish depth', () => {
    const d = describeDepthBand(
      { band: [12, 22], holding: 'bottom', waterDepthFt: null }, 'Blue Catfish', 'fall');
    expect(d.fishDepthStated).toBe(false);
    expect(d.evidence).toBe('no-citation');
    // The RANGE is what is unsupported. The holding position is a separate claim and is still said.
    expect(d.note).toMatch(/carries NO source sentence/);
    expect(d.note).toMatch(/on the bottom here/);
  });

  it('nor is one cited to a sentence with no number in it', () => {
    const d = describeDepthBand(
      { band: [0, 5], holding: 'suspended', waterDepthFt: null,
        sourceQuote: 'Every few minutes as I worked along the shoreline, a largemouth bass '
                   + 'would boil at, or take, my lure.' },
      'Largemouth Bass', 'summer');
    expect(d.fishDepthStated).toBe(false);
    expect(d.evidence).toBe('quote-has-no-depth');
    expect(d.note).toMatch(/a sentence with no depth in it/);
    // The quote is quoted back, because "the research says 0-5" and "one man saw boils off a bank"
    // are different sentences and only one of them is what happened.
    expect(d.note).toMatch(/boil at, or take, my lure/);
  });

  it('but a quote that carries a number is evidence, even with no water depth', () => {
    const d = describeDepthBand(
      { band: [12, 22], holding: 'bottom', waterDepthFt: null,
        sourceQuote: 'catfish hold in 12 to 22 feet through the fall' }, 'Blue Catfish', 'fall');
    expect(d.fishDepthStated).toBe(true);
    expect(d.evidence).toBe('stated');
  });

  it('the test is a digit, not a parse, and says so', () => {
    // Deliberately crude. Checking that the quoted range AGREES with the band is language work that
    // can be wrong in both directions; "no digit anywhere in the sentence" cannot be. A quote whose
    // number contradicts its band still counts as stated here, and that is the honest limit of this
    // test rather than a gap somebody should close by guessing.
    const d = describeDepthBand(
      { band: [40, 50], holding: 'bottom', waterDepthFt: null,
        sourceQuote: 'taken in 5 feet of water' }, 'Blue Catfish', 'fall');
    expect(d.evidence).toBe('stated');
  });

  it('survives the empty case that has always been allowed through', () => {
    // plan-water-ui called this with undefined for weeks; it must not throw.
    const d = describeDepthBand(undefined, 'Striped Bass', 'summer');
    expect(d.ft).toBe(null);
    // And it is NOT a stated fish depth. There is no record here at all, so answering yes was the
    // same defect as the two cases above in its purest form.
    expect(d.fishDepthStated).toBe(false);
  });
});
