import { describe, it, expect } from './expect-shim.mjs';
import {
  normalizeCoastalSpecies,
  classifyStructure,
  proximityFactor,
  depthFactor,
  scoreSpot,
  rankSpots,
  assessFreshwaterIntrusion,
  intrusionAdjustment,
  tacticalNote,
  STRUCTURE,
  STRUCTURE_RADIUS_FT,
  TIDE_WEIGHTS,
  INTRUSION_THRESHOLD,
} from '../js/modules/coastal-scoring.js';

// ~1 degree latitude is 364,000 ft; use small offsets for precise distances.
const FT_PER_DEG_LAT = 364000;
function latOffsetFt(lat, ft) { return lat + ft / FT_PER_DEG_LAT; }

const BASE = { lat: 32.77, lon: -79.93 }; // Charleston Harbor

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

describe('classifyStructure — real pipeline property names', () => {
  it('maps OSM structure_type values emitted by fetch_osm_coastal.py', () => {
    expect(classifyStructure({ properties: { structure_type: 'TIDAL_CHANNEL' } }))
      .toBe(STRUCTURE.CREEK_MOUTH);
    expect(classifyStructure({ properties: { structure_type: 'PIER' } }))
      .toBe(STRUCTURE.DOCK_PILING);
    expect(classifyStructure({ properties: { structure_type: 'JETTY' } }))
      .toBe(STRUCTURE.DOCK_PILING);
  });

  it('maps habitat layers', () => {
    expect(classifyStructure({ properties: { feature_type: 'oyster_bed' } })).toBe(STRUCTURE.OYSTER);
    expect(classifyStructure({ properties: { feature_type: 'marsh_edge' } })).toBe(STRUCTURE.MARSH_EDGE);
    expect(classifyStructure({ properties: { feature_type: 'DEPARE' } })).toBe(STRUCTURE.CHANNEL_EDGE);
  });

  it('returns null for unknown or empty features', () => {
    expect(classifyStructure({ properties: { structure_type: 'PARKING' } })).toBeNull();
    expect(classifyStructure({ properties: {} })).toBeNull();
    expect(classifyStructure(null)).toBeNull();
  });
});

describe('proximityFactor', () => {
  it('is 1 at the structure and 0 at the radius', () => {
    expect(proximityFactor(0, STRUCTURE.MARSH_EDGE)).toBeCloseTo(1, 6);
    expect(proximityFactor(STRUCTURE_RADIUS_FT[STRUCTURE.MARSH_EDGE], STRUCTURE.MARSH_EDGE)).toBe(0);
  });

  it('tapers linearly in between', () => {
    const r = STRUCTURE_RADIUS_FT[STRUCTURE.OYSTER];
    expect(proximityFactor(r / 2, STRUCTURE.OYSTER)).toBeCloseTo(0.5, 6);
  });

  it('is 0 beyond the radius and for junk input', () => {
    expect(proximityFactor(99999, STRUCTURE.OYSTER)).toBe(0);
    expect(proximityFactor(-5, STRUCTURE.OYSTER)).toBe(0);
    expect(proximityFactor(10, 'not_a_structure')).toBe(0);
  });

  it('gives oyster beds a wider apron than marsh edges (brief: 200m vs 100m)', () => {
    expect(STRUCTURE_RADIUS_FT[STRUCTURE.OYSTER])
      .toBeGreaterThan(STRUCTURE_RADIUS_FT[STRUCTURE.MARSH_EDGE]);
  });
});

describe('depthFactor', () => {
  it('is 1 inside the species/stage band', () => {
    // redfish on flood want 1-4 ft
    expect(depthFactor(2, 'redfish', 'flood')).toBe(1);
  });

  it('tapers outside the band', () => {
    expect(depthFactor(5, 'redfish', 'flood')).toBeCloseTo(0.5, 6); // 1 ft over the 4 ft top
    expect(depthFactor(7, 'redfish', 'flood')).toBe(0);             // well past
  });

  it('is neutral when depth is unknown', () => {
    expect(depthFactor(null, 'redfish', 'flood')).toBe(0.5);
    expect(depthFactor(NaN, 'trout', 'ebb')).toBe(0.5);
  });
});

describe('scoreSpot — tide stage drives the answer', () => {
  const marshAt = (ft) => ([{
    type: STRUCTURE.MARSH_EDGE, lat: latOffsetFt(BASE.lat, ft), lon: BASE.lon,
  }]);

  it('redfish on a marsh edge score high on flood and negative at low', () => {
    const flood = scoreSpot({
      ...BASE, species: 'redfish', stage: 'flood',
      structures: marshAt(50), actualDepthFt: 3,
    });
    const low = scoreSpot({
      ...BASE, species: 'redfish', stage: 'low',
      structures: marshAt(50), actualDepthFt: 3,
    });
    expect(flood.score).toBeGreaterThan(2);
    expect(low.score).toBeLessThan(0);
  });

  it('closer to the structure scores higher', () => {
    const near = scoreSpot({ ...BASE, species: 'redfish', stage: 'flood', structures: marshAt(30), actualDepthFt: 3 });
    const far  = scoreSpot({ ...BASE, species: 'redfish', stage: 'flood', structures: marshAt(300), actualDepthFt: 3 });
    expect(near.score).toBeGreaterThan(far.score);
  });

  it('structures beyond their radius contribute nothing', () => {
    const out = scoreSpot({
      ...BASE, species: 'redfish', stage: 'flood',
      structures: marshAt(5000), actualDepthFt: 3,
    });
    expect(out.score).toBe(0);
    expect(out.contributions).toHaveLength(0);
  });

  it('flounder favour dock pilings and creek mouths on the ebb', () => {
    const structures = [
      { type: STRUCTURE.DOCK_PILING, lat: latOffsetFt(BASE.lat, 40), lon: BASE.lon },
    ];
    const ebb  = scoreSpot({ ...BASE, species: 'flounder', stage: 'ebb',  structures, actualDepthFt: 8 });
    const high = scoreSpot({ ...BASE, species: 'flounder', stage: 'high', structures, actualDepthFt: 8 });
    expect(ebb.score).toBeGreaterThan(2);
    expect(high.score).toBe(0); // brief: flounder neutral at high
  });

  it('trout peak at creek mouths on the ebb', () => {
    const structures = [
      { type: STRUCTURE.CREEK_MOUTH, lat: latOffsetFt(BASE.lat, 40), lon: BASE.lon },
    ];
    const ebb   = scoreSpot({ ...BASE, species: 'trout', stage: 'ebb',   structures, actualDepthFt: 8 });
    const flood = scoreSpot({ ...BASE, species: 'trout', stage: 'flood', structures, actualDepthFt: 8 });
    expect(ebb.score).toBeGreaterThan(flood.score);
  });

  it('wrong depth suppresses an otherwise good spot', () => {
    const structures = marshAt(40);
    const good = scoreSpot({ ...BASE, species: 'redfish', stage: 'flood', structures, actualDepthFt: 3 });
    const deep = scoreSpot({ ...BASE, species: 'redfish', stage: 'flood', structures, actualDepthFt: 20 });
    expect(good.score).toBeGreaterThan(0);
    expect(deep.score).toBe(0);
  });

  it('reports per-structure contributions for explainability', () => {
    const out = scoreSpot({
      ...BASE, species: 'redfish', stage: 'ebb',
      structures: [
        { type: STRUCTURE.OYSTER, lat: latOffsetFt(BASE.lat, 100), lon: BASE.lon },
        { type: STRUCTURE.CREEK_MOUTH, lat: latOffsetFt(BASE.lat, 150), lon: BASE.lon },
      ],
      actualDepthFt: 6,
    });
    expect(out.contributions).toHaveLength(2);
    expect(out.contributions.map((c) => c.type)).toContain(STRUCTURE.OYSTER);
    expect(out.contributions[0]).toHaveProperty('distanceFt');
  });

  it('returns a zero score for an unknown stage rather than throwing', () => {
    const out = scoreSpot({ ...BASE, species: 'redfish', stage: 'nonsense', structures: marshAt(50) });
    expect(out.score).toBe(0);
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

describe('intrusionAdjustment — species salinity sensitivity', () => {
  const intrusion = { active: true, severity: 1 };

  it('penalises trout more than flounder far upriver', () => {
    const trout    = intrusionAdjustment({ species: 'trout',    intrusion, distanceToInletMi: 10 });
    const flounder = intrusionAdjustment({ species: 'flounder', intrusion, distanceToInletMi: 10 });
    expect(trout).toBeLessThan(flounder);
  });

  it('rewards inlet-adjacent water during runoff', () => {
    const atInlet  = intrusionAdjustment({ species: 'trout', intrusion, distanceToInletMi: 0 });
    const upriver  = intrusionAdjustment({ species: 'trout', intrusion, distanceToInletMi: 10 });
    expect(atInlet).toBeGreaterThan(0);
    expect(upriver).toBeLessThan(0);
  });

  it('is zero when no intrusion is active', () => {
    expect(intrusionAdjustment({ species: 'trout', intrusion: { active: false }, distanceToInletMi: 0 })).toBe(0);
    expect(intrusionAdjustment({ species: 'trout', intrusion: null })).toBe(0);
  });

  it('penalises upper-creek structures specifically', () => {
    const upper = intrusionAdjustment({
      species: 'trout', intrusion, distanceToInletMi: 2,
      structures: [{ type: STRUCTURE.CREEK_MOUTH, upperCreek: true }],
    });
    const lower = intrusionAdjustment({
      species: 'trout', intrusion, distanceToInletMi: 2,
      structures: [{ type: STRUCTURE.CREEK_MOUTH, upperCreek: false }],
    });
    expect(upper).toBeLessThan(lower);
  });
});

describe('rankSpots', () => {
  it('orders best-first and is deterministic', () => {
    const structures = [{ type: STRUCTURE.MARSH_EDGE, lat: BASE.lat, lon: BASE.lon }];
    const candidates = [
      { lat: latOffsetFt(BASE.lat, 300), lon: BASE.lon, actualDepthFt: 3 },
      { lat: latOffsetFt(BASE.lat, 20),  lon: BASE.lon, actualDepthFt: 3 },
      { lat: latOffsetFt(BASE.lat, 150), lon: BASE.lon, actualDepthFt: 3 },
    ];
    const opts = { species: 'redfish', stage: 'flood', structures };
    const ranked = rankSpots(candidates, opts);
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
    expect(ranked[1].score).toBeGreaterThanOrEqual(ranked[2].score);
    // Same inputs -> same order.
    expect(rankSpots(candidates, opts).map((r) => r.lat)).toEqual(ranked.map((r) => r.lat));
  });
});

describe('tacticalNote', () => {
  it('gives a note for every species/stage pair used by the scorer', () => {
    for (const species of Object.keys(TIDE_WEIGHTS)) {
      for (const stage of ['flood', 'high', 'ebb', 'low']) {
        expect(tacticalNote(species, stage), `${species}/${stage}`).toBeTruthy();
      }
    }
  });

  it('degrades to empty string for unknown input', () => {
    expect(tacticalNote('bass', 'flood')).toBe('');
  });
});
