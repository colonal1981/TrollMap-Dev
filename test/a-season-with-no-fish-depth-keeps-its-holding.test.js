// a-season-with-no-fish-depth-keeps-its-holding.test.js
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-09-25, the Wateree striper plan he built the night before he fished it: legs three
// miles from Clearwater Cove, a 9 ft dock line, a DD1 over 10 ft of water. "ummm this dont make
// any sense." The profile's fall entry for Striped Bass is sourced and says how they hold and over
// what water -- and states no FISH depth, so `preferredDepth` is null:
//
//   { preferredDepth: null, holding: 'suspended', waterDepthFt: [19, 22],
//     sourceQuote: '... lower lake flats which he knows hold fish in 19-22 feet of water.' }
//
// researchedBand() returned null on that and the whole season went with it. The plan fell to the
// built-in table with holding UNKNOWN, matched the water to a 10-19.7 ft fish band as though
// stripers were on the bottom, and every deep run near the ramp failed that test.
import { describe, it, expect } from './expect-shim.mjs';
import { depthBandFor, researchedBand, describeDepthBand, fishDepthEvidence }
  from '../js/modules/plan-inputs.js';
import { eligibleForHolding } from '../js/modules/plan-candidates.js';

const QUOTE = 'unless it is dead still he is just letting the wind push the boat around on lower lake '
            + 'flats which he knows hold fish in 19-22 feet of water.';
const WATEREE = {
  limnology: { oxygen: { anoxicBelowFt: 19.7, depletionDepthFt: 16.4 } },
  trollingIntelligence: {
    'Striped Bass': {
      fall: { preferredDepth: null, holding: 'suspended', waterDepthFt: [19, 22], sourceQuote: QUOTE },
      summer: { preferredDepth: [12, 22], holding: 'suspended', sourceQuote: 'targeted in the 12- to 22-foot depth range' },
    },
  },
};

describe('a researched season with no fish depth', () => {
  it('still comes back from researchedBand, with what it did state and no band', () => {
    const r = researchedBand(WATEREE, 'Striped Bass', 'fall');
    expect(r !== null).toBe(true);
    expect(r.band).toBe(null);
    expect(r.holding).toBe('suspended');
    expect(r.waterDepthFt[0]).toBe(19);
    expect(r.waterDepthFt[1]).toBe(22);
    expect(r.sourceQuote).toBe(QUOTE);
  });

  it('gives depthBandFor the table fish range and the research holding, and says which is which', () => {
    const d = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'fall', 80, WATEREE);
    expect(Array.isArray(d.band)).toBe(true);
    expect(d.holding).toBe('suspended');
    expect(d.waterDepthFt[1]).toBe(22);
    expect(d.fishDepthFrom).toBe('table');
    expect(/built-in table/.test(d.basis)).toBe(true);
    expect(/researched profile/.test(d.basis)).toBe(true);
  });

  it('is not called a stated fish depth -- the table range beside a researched water depth is two sources, not two quantities', () => {
    const d = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'fall', 80, WATEREE);
    expect(fishDepthEvidence(d)).toBe('water-only');
    const x = describeDepthBand(d, 'Striped Bass', 'fall');
    expect(x.fishDepthStated).toBe(false);
    expect(x.holding).toBe('suspended');
    expect(/19–22 ft/.test(x.note)).toBe(true);
    expect(/built-in table/.test(x.note)).toBe(true);
  });

  it('lets deep water through again: suspended has no ceiling, unknown did', () => {
    const d = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'fall', 80, WATEREE);
    // A run's properties, as passWaterFt() reads them: 30 ft of water, measured.
    const deep = { mean_depth_ft: 30 };
    expect(eligibleForHolding(deep, d.band, d.holding).ok).toBe(true);
    expect(eligibleForHolding(deep, d.band, null).ok).toBe(false);
  });
});

describe('what did not change', () => {
  it('a season WITH a fish depth is the research band, exactly as before', () => {
    const d = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'summer', 80, WATEREE);
    expect(d.source).toBe('research');
    expect(d.band[0]).toBe(12);
    expect(d.fishDepthFrom).toBe(undefined);
  });

  it('a season that states neither holding nor water depth is still no research at all', () => {
    const bare = { trollingIntelligence: { 'Striped Bass': { fall: { preferredDepth: null, notes: 'x' } } } };
    expect(researchedBand(bare, 'Striped Bass', 'fall')).toBe(null);
    const d = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'fall', 80, bare);
    expect(d.holding).toBe(null);
    expect(d.fishDepthFrom).toBe(undefined);
  });
});
