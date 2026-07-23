import { describe, it, expect } from 'vitest';
import {
  calculateSectionConfidence,
  gateOverallConfidence,
  hasStructuredTrollingIntel,
} from '../Worker/research/agents.js';

// Bug #2: confidence scoring was counting sources, not field completeness.
// A profile with empty predatorSpecies + empty trollingIntelligence still read
// 94% because the overall formula averaged source-count-based section scores.
// predatorSpecies and trollingIntelligence are the two fields Smart Plan
// consumes, so they are now heavily weighted: hard caps + heavy penalties.

// ── Helpers ────────────────────────────────────────────────────────────────
const fullLimnology = {
  thermocline: { summerDepthFt: 18 },
  oxygen: { depletionDepthFt: 22 },
  waterClarity: { secchiFt: 3 },
};
const fullIdentity = { damName: 'Fort Loudoun Dam', yearImpounded: 1943 };

const structuredTrolling = {
  'Largemouth Bass': {
    summer: { preferredDepth: [8, 14], structures: ['ledges'], forage: ['Threadfin shad'] },
    winter: { preferredDepth: [20, 35], structures: ['timber'], forage: [] },
  },
};

// ── Overall confidence gating ──────────────────────────────────────────────
describe('gateOverallConfidence — Smart Plan critical-field gating', () => {
  it('crushes the reported case: 94% with empty species + empty trolling → low', () => {
    const profile = {
      biology: { predatorSpecies: [], primaryForage: ['Threadfin shad'], knownStockings: [] },
      limnology: fullLimnology,
      identity: fullIdentity,
      trollingIntelligence: {},
    };
    const result = gateOverallConfidence(94, profile, {});
    // Hard cap when predatorSpecies is empty — profile is unusable for Smart Plan.
    expect(result.percent).toBeLessThanOrEqual(50);
    expect(result.penalties).toEqual(expect.arrayContaining([
      'predatorSpecies (empty — unusable for Smart Plan)',
      'trollingIntelligence (empty — unusable for Smart Plan)',
    ]));
  });

  it('does NOT penalize a complete profile', () => {
    const profile = {
      biology: { predatorSpecies: ['Largemouth Bass', 'Striped Bass'], knownStockings: [{ species: 'Striped Bass' }] },
      limnology: fullLimnology,
      identity: fullIdentity,
      trollingIntelligence: structuredTrolling,
    };
    const result = gateOverallConfidence(95, profile, {});
    expect(result.percent).toBe(95);
    expect(result.penalties).toHaveLength(0);
  });

  it('gates on empty predatorSpecies even with a high source-count average', () => {
    const profile = {
      biology: { predatorSpecies: [] },
      limnology: fullLimnology,
      identity: fullIdentity,
      trollingIntelligence: structuredTrolling,
    };
    // 99% from many sources in identity/limnology/habitat is meaningless when
    // there is no species to plan around.
    expect(gateOverallConfidence(99, profile, {}).percent).toBeLessThanOrEqual(45);
  });

  it('gates (less severely) when species exist but trollingIntelligence is empty', () => {
    const profile = {
      biology: { predatorSpecies: ['Largemouth Bass'], knownStockings: [{ species: 'Largemouth Bass' }] },
      limnology: fullLimnology,
      identity: fullIdentity,
      trollingIntelligence: {},
    };
    expect(gateOverallConfidence(99, profile, {}).percent).toBeLessThanOrEqual(58);
  });

  it('respects fieldStatus exemptions (not_applicable / not_available_after_targeted_review)', () => {
    const profile = {
      biology: { predatorSpecies: [], knownStockings: [{ species: 'Striped Bass' }] },
      limnology: fullLimnology,
      identity: fullIdentity,
      trollingIntelligence: {},
    };
    const fieldStatus = {
      'biology.predatorSpecies': { status: 'not_applicable' },
      'fisheries.trollingIntelligence': { status: 'not_available_after_targeted_review' },
    };
    // Exempt fields are skipped, so no penalties apply with a fully-populated profile.
    const exempted = gateOverallConfidence(99, profile, fieldStatus).percent;
    const plain = gateOverallConfidence(99, profile, {}).percent;
    expect(exempted).toBeGreaterThan(plain);
    expect(exempted).toBe(99);
  });

  it('preserves existing limnology null-field penalties', () => {
    const profile = {
      biology: { predatorSpecies: ['Largemouth Bass'], knownStockings: [{ species: 'Largemouth Bass' }] },
      limnology: { thermocline: { summerDepthFt: null }, oxygen: { depletionDepthFt: null }, waterClarity: { secchiFt: null } },
      identity: { damName: null, yearImpounded: null },
      trollingIntelligence: structuredTrolling,
    };
    // thermocline 8 + oxygen 6 + secchi 3 + damName 2 + yearImpounded 2 = 21 points
    // (knownStockings is populated, predatorSpecies + trolling present → no Smart Plan gate)
    expect(gateOverallConfidence(90, profile, {}).percent).toBe(69);
  });

  it('clamps to [30, 99]', () => {
    const profile = { biology: { predatorSpecies: [] }, limnology: {}, identity: {}, trollingIntelligence: {} };
    expect(gateOverallConfidence(10, profile, {}).percent).toBe(30);
  });
});

// ── Trolling structure detection ───────────────────────────────────────────
describe('hasStructuredTrollingIntel', () => {
  it('returns false for empty / null / missing', () => {
    expect(hasStructuredTrollingIntel({})).toBe(false);
    expect(hasStructuredTrollingIntel(null)).toBe(false);
    expect(hasStructuredTrollingIntel(undefined)).toBe(false);
  });

  it('returns false for season objects with no depth/structure/forage', () => {
    expect(hasStructuredTrollingIntel({
      'Largemouth Bass': { summer: { preferredDepth: null, structures: [], forage: [] } },
    })).toBe(false);
  });

  it('returns true when a season has a depth range or structure/forage', () => {
    expect(hasStructuredTrollingIntel(structuredTrolling)).toBe(true);
    expect(hasStructuredTrollingIntel({
      'Striped Bass': { spring: { preferredDepth: [5, 12], structures: [], forage: [] } },
    })).toBe(true);
  });
});

// ── Biology section confidence ─────────────────────────────────────────────
describe('calculateSectionConfidence — biology empty-species cap', () => {
  // Even with many official sources, an explicitly-empty predator list is not
  // actionable for Smart Plan, so the biology section caps low instead of
  // inflating on source count.
  it('caps low when predatorSpecies is an empty array', () => {
    const manyOfficial = Array.from({ length: 5 }, () => ({ trust: 'OFFICIAL', label: 'TWRA' }));
    const result = calculateSectionConfidence(manyOfficial, true, 'biology', { predatorSpecies: [] });
    expect(result.percent).toBeLessThanOrEqual(35);
    expect(result.reason).toMatch(/predator species/);
  });

  it('leaves undefined predatorSpecies to normal source-count scoring', () => {
    const result = calculateSectionConfidence([{ trust: 'OFFICIAL', label: 'TWRA' }], true, 'biology', {});
    expect(result.percent).toBeGreaterThan(0);
    expect(result.reason).not.toMatch(/predator species/);
  });
});
