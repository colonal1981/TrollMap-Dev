/**
 * coastal-scoring.js — tide- and structure-aware spot scoring for inshore
 * saltwater (Red Drum, Speckled Trout, Southern Flounder).
 *
 * Pure functions only: no DOM, no fetch. smart-plan.js supplies the tide
 * state and the structure features; this module decides where the fish are.
 * That split keeps the scoring testable without standing up Leaflet or NOAA.
 *
 * Model, per COASTAL_ARENA_BRIEF.md sections 4B and 5:
 *
 *   score = tide-stage weight (species x stage x structure type)
 *         + proximity bonus (closer to the structure = better)
 *         + freshwater-intrusion adjustment (salinity proxy)
 *
 * Distances are compared in feet against per-structure radii, because the
 * useful range differs a lot by structure: a redfish sitting on a marsh edge
 * is within yards of it, while an oyster point holds fish over a wider apron.
 */

import { distFtFromCoords } from '../utils/geo.js';

export const COASTAL_SPECIES = [
  'Red Drum (Redfish)',
  'Speckled Trout (Spotted Seatrout)',
  'Southern Flounder',
];

/** Canonical species key from a loose UI label. */
export function normalizeCoastalSpecies(name) {
  const s = String(name || '').toLowerCase();
  if (/red\s*drum|redfish|spot ?tail|channel bass/.test(s)) return 'redfish';
  if (/trout|speck/.test(s)) return 'trout';
  if (/flounder|flatfish|doormat/.test(s)) return 'flounder';
  return null;
}

/** Structure classes we score against. */
export const STRUCTURE = {
  MARSH_EDGE:   'marsh_edge',
  OYSTER:       'oyster',
  CREEK_MOUTH:  'creek_mouth',
  DOCK_PILING:  'dock_piling',
  GRASS_FLAT:   'grass_flat',
  CHANNEL_EDGE: 'channel_edge',
};

/**
 * Effective radius (ft) within which a structure still holds fish.
 * Brief section 4B gives 200 m for oyster and 100 m for marsh; the rest are
 * scaled to how tightly each structure concentrates fish.
 */
export const STRUCTURE_RADIUS_FT = {
  [STRUCTURE.MARSH_EDGE]:   330,   // ~100 m
  [STRUCTURE.OYSTER]:       660,   // ~200 m
  [STRUCTURE.CREEK_MOUTH]:  500,
  [STRUCTURE.DOCK_PILING]:  200,   // pilings are a tight target
  [STRUCTURE.GRASS_FLAT]:   660,
  [STRUCTURE.CHANNEL_EDGE]: 400,
};

/**
 * Tide-stage weights: species -> stage -> structure -> points.
 * Transcribed from the brief's +/++/+++ notation as 1/2/3, with negatives
 * for water the fish actively leave. Absent pairs score 0 (neutral).
 */
export const TIDE_WEIGHTS = {
  redfish: {
    flood: { [STRUCTURE.MARSH_EDGE]: 3, [STRUCTURE.OYSTER]: 2, [STRUCTURE.CREEK_MOUTH]: 1 },
    high:  { [STRUCTURE.MARSH_EDGE]: 3, [STRUCTURE.OYSTER]: 1, [STRUCTURE.GRASS_FLAT]: 1 },
    ebb:   { [STRUCTURE.OYSTER]: 2, [STRUCTURE.CREEK_MOUTH]: 3, [STRUCTURE.CHANNEL_EDGE]: 1 },
    low:   { [STRUCTURE.CHANNEL_EDGE]: 2, [STRUCTURE.CREEK_MOUTH]: 2, [STRUCTURE.MARSH_EDGE]: -2, [STRUCTURE.GRASS_FLAT]: -2 },
  },
  trout: {
    flood: { [STRUCTURE.GRASS_FLAT]: 2, [STRUCTURE.CREEK_MOUTH]: 1, [STRUCTURE.CHANNEL_EDGE]: 1 },
    high:  { [STRUCTURE.GRASS_FLAT]: 2, [STRUCTURE.MARSH_EDGE]: 1 },
    ebb:   { [STRUCTURE.CREEK_MOUTH]: 3, [STRUCTURE.CHANNEL_EDGE]: 3, [STRUCTURE.DOCK_PILING]: 1 },
    low:   { [STRUCTURE.CHANNEL_EDGE]: 2, [STRUCTURE.DOCK_PILING]: 1, [STRUCTURE.GRASS_FLAT]: -2 },
  },
  flounder: {
    flood: { [STRUCTURE.CREEK_MOUTH]: 1, [STRUCTURE.CHANNEL_EDGE]: 1 },
    high:  {},
    ebb:   { [STRUCTURE.CREEK_MOUTH]: 3, [STRUCTURE.DOCK_PILING]: 3, [STRUCTURE.CHANNEL_EDGE]: 2 },
    low:   { [STRUCTURE.CHANNEL_EDGE]: 2, [STRUCTURE.CREEK_MOUTH]: 1, [STRUCTURE.GRASS_FLAT]: -2 },
  },
};

/** Preferred working depth (ft, tide-corrected) by species and stage. */
export const DEPTH_BANDS = {
  redfish:  { flood: [1, 4],  high: [1, 4],  ebb: [4, 8],   low: [4, 10] },
  trout:    { flood: [2, 6],  high: [2, 6],  ebb: [6, 12],  low: [6, 14] },
  flounder: { flood: [4, 12], high: [4, 12], ebb: [4, 12],  low: [6, 14] },
};

/**
 * Map an osm-structures.geojson / habitat feature onto a STRUCTURE class.
 * Returns null for features we do not score, so callers can filter.
 */
export function classifyStructure(feature) {
  if (!feature) return null;
  const p = feature.properties || {};
  const raw = String(
    p.structure_type || p.feature_type || p.type || p.layer || ''
  ).toLowerCase();

  if (!raw) return null;
  if (/tidal_channel|creek|inlet|channel_mouth/.test(raw)) return STRUCTURE.CREEK_MOUTH;
  if (/pier|dock|piling|jetty|groyne|wharf/.test(raw))     return STRUCTURE.DOCK_PILING;
  if (/oyster|reef|benthic/.test(raw))                     return STRUCTURE.OYSTER;
  if (/marsh|spartina|esi/.test(raw))                      return STRUCTURE.MARSH_EDGE;
  if (/grass|sav|flat/.test(raw))                          return STRUCTURE.GRASS_FLAT;
  if (/depare|contour|channel|depth/.test(raw))            return STRUCTURE.CHANNEL_EDGE;
  return null;
}

/**
 * Proximity multiplier: 1.0 at the structure, tapering linearly to 0 at its
 * radius. Linear rather than exponential because the brief treats these as
 * flat "within X metres" bands and a hard cliff at the edge would make spot
 * ranking jitter for tiny GPS differences.
 */
export function proximityFactor(distanceFt, structureType) {
  const radius = STRUCTURE_RADIUS_FT[structureType];
  if (!radius) return 0;
  if (!Number.isFinite(distanceFt) || distanceFt < 0) return 0;
  if (distanceFt >= radius) return 0;
  return 1 - (distanceFt / radius);
}

/** Depth suitability: 1 inside the band, tapering to 0 two feet outside it. */
export function depthFactor(actualDepthFt, species, stage) {
  if (!Number.isFinite(actualDepthFt)) return 0.5; // unknown depth: neutral
  const band = DEPTH_BANDS[species]?.[stage];
  if (!band) return 0.5;
  const [min, max] = band;
  if (actualDepthFt >= min && actualDepthFt <= max) return 1;
  const TAPER_FT = 2;
  if (actualDepthFt < min) {
    return Math.max(0, 1 - (min - actualDepthFt) / TAPER_FT);
  }
  return Math.max(0, 1 - (actualDepthFt - max) / TAPER_FT);
}

/**
 * Score one candidate spot.
 *
 * @param {object} opts
 * @param {number} opts.lat
 * @param {number} opts.lon
 * @param {string} opts.species        canonical key: redfish|trout|flounder
 * @param {string} opts.stage          flood|ebb|high|low
 * @param {Array}  opts.structures     [{lat, lon, type}]
 * @param {number} [opts.actualDepthFt] tide-corrected depth at the spot
 * @param {object} [opts.intrusion]    from assessFreshwaterIntrusion()
 * @param {number} [opts.distanceToInletMi] used only when intrusion is active
 * @returns {{score:number, contributions:Array, depthFactor:number}}
 */
export function scoreSpot({
  lat, lon, species, stage, structures = [],
  actualDepthFt, intrusion = null, distanceToInletMi = null,
}) {
  const weights = TIDE_WEIGHTS[species]?.[stage];
  if (!weights) return { score: 0, contributions: [], depthFactor: 0 };

  const contributions = [];
  let structureScore = 0;

  for (const s of structures) {
    const type = s.type;
    const w = weights[type];
    if (!w) continue;
    const d = distFtFromCoords(lat, lon, s.lat, s.lon);
    const prox = proximityFactor(d, type);
    if (prox <= 0) continue;
    // Penalties (negative weights) apply at full strength regardless of
    // distance-taper sign; a redfish will not sit on a dry flat at low tide
    // whether it is 10 ft or 300 ft away.
    const points = w > 0 ? w * prox : w;
    structureScore += points;
    contributions.push({ type, distanceFt: Math.round(d), weight: w, points: +points.toFixed(3) });
  }

  const df = depthFactor(actualDepthFt, species, stage);
  let score = structureScore * df;

  // ── Freshwater intrusion (salinity proxy) ───────────────────────────────
  if (intrusion?.active) {
    score += intrusionAdjustment({ species, intrusion, distanceToInletMi, structures });
  }

  return { score: +score.toFixed(3), contributions, depthFactor: df };
}

/**
 * Salinity penalty/bonus during a runoff event.
 *
 * Trout are the most salinity-sensitive of the three and push toward inlets;
 * redfish slide out of the flooded marsh. Flounder are comparatively
 * tolerant, so they take a smaller hit.
 */
export function intrusionAdjustment({ species, intrusion, distanceToInletMi, structures = [] }) {
  if (!intrusion?.active) return 0;
  const severity = Math.min(1, Math.max(0, intrusion.severity ?? 0.5));

  const sensitivity = species === 'trout' ? 3 : species === 'redfish' ? 2 : 1;

  // Near an inlet = saltier = refuge. Far upriver = freshened = penalised.
  let positional = 0;
  if (Number.isFinite(distanceToInletMi)) {
    // 0 mi -> +1, 10 mi or more -> -1
    positional = 1 - Math.min(2, distanceToInletMi / 5);
  }

  // Upper-creek structures are the first to freshen.
  const hasUpperCreek = structures.some((s) => s.type === STRUCTURE.CREEK_MOUTH && s.upperCreek);
  const upperPenalty = hasUpperCreek ? -0.5 : 0;

  return (positional + upperPenalty) * sensitivity * severity;
}

/**
 * Decide whether current river discharge represents a freshwater intrusion
 * event, per the brief: discharge > 130% of the 30-day mean.
 *
 * @param {number} currentCfs
 * @param {number} mean30dCfs
 * @returns {{active:boolean, ratio:number|null, severity:number, message:string|null}}
 */
export const INTRUSION_THRESHOLD = 1.3;

export function assessFreshwaterIntrusion(currentCfs, mean30dCfs) {
  const cur = Number(currentCfs);
  const mean = Number(mean30dCfs);
  if (!Number.isFinite(cur) || !Number.isFinite(mean) || mean <= 0) {
    return { active: false, ratio: null, severity: 0, message: null };
  }
  const ratio = cur / mean;
  if (ratio <= INTRUSION_THRESHOLD) {
    return { active: false, ratio: +ratio.toFixed(3), severity: 0, message: null };
  }
  // Ramp severity 0 -> 1 between 130% and 250% of normal.
  const severity = Math.min(1, (ratio - INTRUSION_THRESHOLD) / (2.5 - INTRUSION_THRESHOLD));
  return {
    active: true,
    ratio: +ratio.toFixed(3),
    severity: +severity.toFixed(3),
    message:
      'Heavy runoff detected — salinity likely depressed. ' +
      'Trout pushing toward inlets; redfish sliding out of marsh.',
  };
}

/**
 * Rank candidate spots best-first. Ties are broken deterministically by
 * position so plan output is reproducible for the same inputs.
 */
export function rankSpots(candidates, opts) {
  return candidates
    .map((c) => ({
      ...c,
      ...scoreSpot({ ...opts, lat: c.lat, lon: c.lon, actualDepthFt: c.actualDepthFt }),
    }))
    .sort((a, b) => (b.score - a.score) || (a.lat - b.lat) || (a.lon - b.lon));
}

/** Short tactical note for the plan text. */
export function tacticalNote(species, stage) {
  const notes = {
    redfish: {
      flood: 'Flood tide — push shallow, work gold spoons and weedless paddle tails tight to the Spartina.',
      high:  'High water — redfish are up in the flooded grass; sight-fish the edges.',
      ebb:   'Falling water — set up on oyster points and creek mouths as bait flushes out.',
      low:   'Low water — off the flats, fish deeper creek bends and channel edges.',
    },
    trout: {
      flood: 'Rising water — work potholes in the grass flats with a popping cork.',
      high:  'High slack — cover grass flats; expect a slower bite until water moves.',
      ebb:   'Best window — creek mouths and drop-offs with soft plastics on the current seam.',
      low:   'Low water — channel edges and dock lights; slow the retrieve.',
    },
    flounder: {
      flood: 'Moving water — drag Gulp! along creek mouths and channel edges.',
      high:  'Slack high — flounder bite is soft; wait for current.',
      ebb:   'Prime — pinch points, inlet throats and dock pilings; slow bottom drag.',
      low:   'Deeper channel edges; keep the bait on the bottom in current.',
    },
  };
  return notes[species]?.[stage] || '';
}
