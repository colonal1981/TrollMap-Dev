// ONE HALF OF THE PIPELINE WAS HUNTING FOR WHAT THE OTHER HALF REFUSES TO REPORT.
//
// `limnologyGaps` lists whichever of five fields the WQP pull did not answer, and that list is
// handed to document extraction as "go find these in a PDF". Four of the five describe a water
// column that separates into layers: summer thermocline depth, the depth oxygen runs out below,
// the depth it starts depleting, and trophic status.
//
// A river does not stratify. `water-type-hints.js` says so to the fisheries agent in as many
// words. So on all 57 rivers those four came back null on every run -- correctly -- and the gap
// list read null as NOT YET FOUND and sent the extractor looking for a thermocline in moving
// water. Measured 2026-09-16: 57 of 57 rivers, every run.
//
// The rule this breaks is already written down: "we asked and the data cannot answer" and "nobody
// has asked" are different claims. A field that CANNOT EXIST is neither.
import { describe, it, expect } from './expect-shim.mjs';
import {
  limnologyGaps, limnologyFieldsFor, WQP_LIMNOLOGY_FIELDS, WQP_FIELDS_BY_WATER_TYPE,
} from '../js/utils/wqp-limnology.js';
import { WATER_TYPE_HINTS } from '../Worker/research/water-type-hints.js';

// THE ARGUMENT IS THE LIMNOLOGY BLOCK ITSELF, NOT A WRAPPER AROUND IT -- `limnologyGaps` drops
// the leading `limnology.` segment off each path before walking. The first draft of this file
// wrapped it and every field read as missing, which made the "all five" assertions pass for the
// wrong reason and only the filled-value ones fail. Same shape as the fixture in
// the-thermocline-was-saved-over.test.js, which is the one the real pull is checked against.
const SKELETON = () => ({
  waterClarity: { typical: null, secchiFt: null, note: null },
  surfaceWater: {},
  thermocline: { summerDepthFt: null, method: null, note: null },
  oxygen: { depletionDepthFt: null, anoxicBelowFt: null, note: null },
  trophicStatus: null,
  seasonalDrawdownFt: 2.5,
});

const STRATIFICATION_FIELDS = [
  'limnology.thermocline.summerDepthFt',
  'limnology.oxygen.anoxicBelowFt',
  'limnology.oxygen.depletionDepthFt',
  'limnology.trophicStatus',
];

describe('a river is only asked for what a river can have', () => {
  it('asks for clarity and nothing else', () => {
    expect(limnologyGaps(SKELETON(), 'river')).toEqual(['limnology.waterClarity.secchiFt']);
  });

  it('never asks a river for any of the four that need a layered water column', () => {
    const gaps = limnologyGaps(SKELETON(), 'river');
    for (const f of STRATIFICATION_FIELDS) expect(gaps.includes(f)).toBe(false);
  });

  it('asks a river for nothing at all once its clarity is known', () => {
    const l = SKELETON();
    l.waterClarity.secchiFt = 2.5;
    expect(limnologyGaps(l, 'river')).toEqual([]);
  });

  it('is case-insensitive, because feature_type is read straight off a registry row', () => {
    expect(limnologyGaps(SKELETON(), 'RIVER').length).toBe(1);
    expect(limnologyGaps(SKELETON(), 'River').length).toBe(1);
  });
});

describe('nothing else changed', () => {
  it('a caller that passes no water type still asks for all five', () => {
    expect(limnologyGaps(SKELETON())).toEqual(WQP_LIMNOLOGY_FIELDS);
  });

  it('a lake asks for all five', () => {
    expect(limnologyGaps(SKELETON(), 'lake')).toEqual(WQP_LIMNOLOGY_FIELDS);
  });

  it('an unknown or empty water type asks for all five', () => {
    for (const t of ['', null, undefined, 'coastal', 'estuary', 'pond']) {
      expect(limnologyGaps(SKELETON(), t)).toEqual(WQP_LIMNOLOGY_FIELDS);
    }
  });

  it('hands back the canonical array rather than a copy, so the two cannot drift', () => {
    expect(limnologyFieldsFor('lake')).toBe(WQP_LIMNOLOGY_FIELDS);
    expect(limnologyFieldsFor(undefined)).toBe(WQP_LIMNOLOGY_FIELDS);
  });

  it('still reports a filled field as filled and a zero as a value', () => {
    const l = SKELETON();
    l.thermocline.summerDepthFt = 0;
    expect(limnologyGaps(l).includes('limnology.thermocline.summerDepthFt')).toBe(false);
  });
});

describe('the gap list and the prompt agree about what a river has', () => {
  // THE POINT OF THIS SUITE. The bug was not a wrong value, it was two halves of one pipeline
  // holding opposite beliefs: the prompt forbade the agent to report a thermocline while the gap
  // list sent a document extractor to find one. Neither file could have caught that alone, so
  // the contract between them is asserted here, against the real hint text.
  const riverHint = WATER_TYPE_HINTS.river.fisheries;

  it('the river hint does forbid exactly what the gap list now stops asking for', () => {
    expect(riverHint.includes('does not stratify')).toBe(true);
    expect(riverHint.includes('do NOT report a')).toBe(true);
    expect(riverHint.toLowerCase().includes('thermocline')).toBe(true);
    expect(riverHint.toLowerCase().includes('anoxic layer')).toBe(true);
  });

  it('every field dropped for a river is one the hint names as impossible', () => {
    const dropped = WQP_LIMNOLOGY_FIELDS
      .filter((f) => !WQP_FIELDS_BY_WATER_TYPE.river.includes(f));
    expect(dropped).toEqual(STRATIFICATION_FIELDS);
    // The hint forbids the thermocline and the anoxic layer BY NAME, which covers three of the
    // four -- depletion depth is the same measurement as the anoxic depth taken higher up the
    // column. Trophic status is not named there because it is a lake-nutrient classification
    // rather than a stratification claim; its reason is recorded in wqp-limnology.js instead.
    // An earlier version of this assertion matched the hint against the MIDDLE SEGMENT of each
    // field path and passed on one of four, which would have gone green on almost any change.
    const h = riverHint.toLowerCase();
    expect(h.includes('thermocline')).toBe(true);
    expect(h.includes('anoxic layer')).toBe(true);
    expect(dropped.includes('limnology.trophicStatus')).toBe(true);
  });

  it('keeps clarity, which is the one that means the same thing on moving water', () => {
    expect(WQP_FIELDS_BY_WATER_TYPE.river).toEqual(['limnology.waterClarity.secchiFt']);
  });

  it('carries exactly one water type today, so a new one cannot appear unnoticed', () => {
    expect(Object.keys(WQP_FIELDS_BY_WATER_TYPE)).toEqual(['river']);
  });
});
