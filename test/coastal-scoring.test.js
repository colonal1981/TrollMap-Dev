import { describe, it, expect } from './expect-shim.mjs';
import {
  normalizeCoastalSpecies,
  assessFreshwaterIntrusion,
  tacticalNote,
  DEPTH_BANDS,
  INTRUSION_THRESHOLD,
} from '../js/modules/coastal-scoring.js';

// THE SPOT SCORER'S TESTS STOOD HERE -- classifyStructure, proximityFactor, depthFactor,
// scoreSpot, intrusionAdjustment and rankSpots. The scorer had no caller since smart-plan.js v1
// was deleted and went on 2026-09-25. The four exports the app imports are tested below.

describe('normalizeCoastalSpecies', () => {
  it('maps the UI labels and common nicknames', () => {
    expect(normalizeCoastalSpecies('Red Drum (Redfish)')).toBe('redfish');
    expect(normalizeCoastalSpecies('redfish')).toBe('redfish');
    expect(normalizeCoastalSpecies('Spottail Bass')).toBe('redfish');
    expect(normalizeCoastalSpecies('Speckled Trout (Spotted Seatrout)')).toBe('trout');
    expect(normalizeCoastalSpecies('specks')).toBe('trout');
    expect(normalizeCoastalSpecies('Southern Flounder')).toBe('flounder');
    expect(normalizeCoastalSpecies('doormat')).toBe('flounder');
  });

  it('returns null for freshwater species so callers can fall back', () => {
    expect(normalizeCoastalSpecies('Striped Bass')).toBeNull();
    expect(normalizeCoastalSpecies('Crappie')).toBeNull();
    expect(normalizeCoastalSpecies('')).toBeNull();
    expect(normalizeCoastalSpecies(null)).toBeNull();
  });
});

describe('assessFreshwaterIntrusion — 130% of 30-day mean', () => {
  it('is inactive at or below the threshold', () => {
    expect(assessFreshwaterIntrusion(1300, 1000).active).toBe(false);
    expect(assessFreshwaterIntrusion(900, 1000).active).toBe(false);
  });

  it('activates above 130% and surfaces the brief wording', () => {
    const r = assessFreshwaterIntrusion(1500, 1000);
    expect(r.active).toBe(true);
    expect(r.ratio).toBeCloseTo(1.5, 3);
    expect(r.message).toMatch(/Heavy runoff/);
    expect(r.message).toMatch(/Trout pushing toward inlets/);
  });

  it('scales severity with how extreme the runoff is', () => {
    const mild = assessFreshwaterIntrusion(1400, 1000);
    const wild = assessFreshwaterIntrusion(4000, 1000);
    expect(wild.severity).toBeGreaterThan(mild.severity);
    expect(wild.severity).toBeLessThanOrEqual(1);
  });

  it('is inert on missing or nonsensical gauge data', () => {
    expect(assessFreshwaterIntrusion(null, 1000).active).toBe(false);
    expect(assessFreshwaterIntrusion(1500, 0).active).toBe(false);
    expect(assessFreshwaterIntrusion(undefined, undefined).active).toBe(false);
  });

  it('threshold matches the brief', () => {
    expect(INTRUSION_THRESHOLD).toBe(1.3);
  });
});

describe('tacticalNote', () => {
  it('gives a note for every species/stage pair the depth bands know', () => {
    for (const species of Object.keys(DEPTH_BANDS)) {
      for (const stage of ['flood', 'high', 'ebb', 'low']) {
        expect(tacticalNote(species, stage), `${species}/${stage}`).toBeTruthy();
      }
    }
  });

  it('degrades to empty string for unknown input', () => {
    expect(tacticalNote('bass', 'flood')).toBe('');
  });
});
