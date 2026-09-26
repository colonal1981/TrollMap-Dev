/**
 * coastal-scoring.js — inshore saltwater tables the planners read (Red Drum, Speckled Trout,
 * Southern Flounder): the species key, the tide-stage depth bands, the tactical note, and the
 * freshwater-intrusion test.
 *
 * Pure functions only: no DOM, no fetch.
 *
 * THE SPOT SCORER THAT GAVE THIS FILE ITS NAME WENT ON 2026-09-25. scoreSpot(), rankSpots(),
 * the structure classes, radii and tide weights, and the intrusion adjustment were written for
 * smart-plan.js (v1, deleted 2026-08-20) and had no caller since. Smart Plan v2 lets the model
 * pick the water from the pack's candidates. The four exports the app imports stay.
 */

/** Canonical species key from a loose UI label. */
export function normalizeCoastalSpecies(name) {
  const s = String(name || '').toLowerCase();
  if (/red\s*drum|redfish|spot ?tail|channel bass/.test(s)) return 'redfish';
  if (/trout|speck/.test(s)) return 'trout';
  if (/flounder|flatfish|doormat/.test(s)) return 'flounder';
  return null;
}

/** Preferred working depth (ft, tide-corrected) by species and stage. */
export const DEPTH_BANDS = {
  redfish:  { flood: [1, 4],  high: [1, 4],  ebb: [4, 8],   low: [4, 10] },
  trout:    { flood: [2, 6],  high: [2, 6],  ebb: [6, 12],  low: [6, 14] },
  flounder: { flood: [4, 12], high: [4, 12], ebb: [4, 12],  low: [6, 14] },
};

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
