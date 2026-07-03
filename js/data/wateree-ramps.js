/**
 * wateree-ramps.js — Lake Wateree ramp database with zone affiliation,
 * status, and spatial metadata for the Smart Plan ramp evaluation engine.
 *
 * Coordinates sourced from TrollMap's TRISTATE_MASTER_RAMPS database
 * (data/ramps.js) to ensure consistency with map display.
 *
 * Zone affiliations describe which part of the lake each ramp best
 * accesses given realistic kayak range and predominant depth structure
 * in the adjacent water.
 */

export const WATEREE_RAMPS = [
  {
    name: 'Wateree Creek Access Area',
    key: 'Wateree Creek',
    lat: 34.4696, lon: -80.9139,
    side: 'west',
    zone: 'north',
    free: true,
    status: 'open',
    closedUntil: null,
    notes: 'Far north end, access to upper lake and Dutchmans Creek arm. Shallow water nearby, main channel further out.',
    bestFor: ['north_channel', 'dutchmans_arm', 'shallow_flats'],
    avoidWind: ['W', 'NW'], // exposed to west wind on the upper lake
  },
  {
    name: 'Taylor Creek Access Area',
    key: 'Taylor Creek',
    lat: 34.4377, lon: -80.8758,
    side: 'west',
    zone: 'north',
    free: true,
    status: 'open',
    closedUntil: null,
    notes: 'Upper lake west side. Access to Taylors and Dutchmans Creek arms, transition to main lake.',
    bestFor: ['taylors_arm', 'north_channel', 'mid_depth_ledges'],
    avoidWind: ['W', 'SW'],
  },
  {
    name: 'Lake Wateree State Park',
    key: 'Lake Wateree State Park',
    lat: 34.4328, lon: -80.8584,
    side: 'west',
    zone: 'north',
    free: false,
    payAmount: 'State park fee applies',
    status: 'open',
    closedUntil: null,
    notes: 'Pay to launch — state park fee required. Near Taylor Creek, similar access.',
    bestFor: ['taylors_arm', 'north_channel'],
    avoidWind: ['W', 'SW'],
  },
  {
    name: 'June Creek Access Area',
    key: 'June Creek',
    lat: 34.3913, lon: -80.8294,
    side: 'west',
    zone: 'mid',
    free: true,
    status: 'open',
    closedUntil: null,
    notes: 'Northernmost of the mid-lake west cluster. Good access to channel ledges and mid-lake structure.',
    bestFor: ['mid_channel', 'channel_ledges', 'mid_depth_ledges'],
    avoidWind: ['W', 'NW'],
  },
  {
    name: 'Molly Creek Access Area',
    key: 'Molly Creek',
    lat: 34.3828, lon: -80.7880,
    side: 'west',
    zone: 'mid',
    free: true,
    status: 'open',
    closedUntil: null,
    notes: 'Mid-lake west side. Close to main channel, good depth access.',
    bestFor: ['mid_channel', 'channel_ledges', 'clearwater_area'],
    avoidWind: ['W'],
  },
  {
    name: 'Colonel Creek Access Area',
    key: 'Colonel Creek',
    lat: 34.3689, lon: -80.7972,
    side: 'west',
    zone: 'mid',
    free: true,
    status: 'open',
    closedUntil: null,
    notes: 'Mid-lake west side, southernmost of the cluster. Good channel access, reasonable distance to east-side structure.',
    bestFor: ['mid_channel', 'channel_ledges', 'clearwater_area'],
    avoidWind: ['W', 'SW'],
  },
  {
    name: 'White Oak / Clearwater Cove',
    key: 'Clearwater Cove',
    lat: 34.3793, lon: -80.7288,
    side: 'east',
    zone: 'mid',
    free: true,
    status: 'open',
    closedUntil: null,
    notes: 'ONLY free public ramp on the east side. Direct access to Clearwater Cove humps, Wyboo Creek arm, east bank contours. Protected from west wind by the lake body.',
    bestFor: ['clearwater_cove', 'east_bank', 'wyboo_arm', 'humps', 'channel_ledges'],
    avoidWind: ['E', 'SE'], // exposed to east wind
    exclusive: ['clearwater_cove', 'east_bank', 'wyboo_arm', 'humps'], // only ramp for these zones
  },
  {
    name: 'Buck Hill',
    key: 'Buck Hill',
    lat: 34.3359, lon: -80.7072,
    side: 'west',
    zone: 'south',
    free: true,
    status: 'closed',
    closedUntil: '2027-03-01',
    notes: 'CLOSED — estimated reopening March 2027.',
    bestFor: ['south_channel'],
    avoidWind: [],
  },
];

// Zones that only Clearwater Cove can access
export const EAST_ONLY_ZONES = ['clearwater_cove', 'east_bank', 'wyboo_arm', 'humps'];

// Wind direction → compass bearing mapping
const WIND_BEARINGS = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5,
  E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5,
  W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

/**
 * Compute distance in miles between two lat/lon points.
 */
export function distanceMiles(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 69.0;
  const dLon = (lon2 - lon1) * 69.0 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

/**
 * Parse wind direction string (e.g. "WSW 11 mph" or "SW") → degrees.
 */
export function parseWindDeg(weatherStr) {
  if (!weatherStr) return null;
  const m = String(weatherStr).match(/\b(N|NNE|NE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)\b/);
  return m ? (WIND_BEARINGS[m[1]] ?? null) : null;
}

/**
 * Is a ramp exposed to the current wind direction?
 * A ramp is exposed if wind is within 45° of its avoidWind directions.
 */
export function isRampExposed(ramp, windDeg) {
  if (windDeg == null || !ramp.avoidWind.length) return false;
  return ramp.avoidWind.some(dir => {
    const avoid = WIND_BEARINGS[dir];
    if (avoid == null) return false;
    const diff = Math.abs(windDeg - avoid) % 360;
    return Math.min(diff, 360 - diff) <= 45;
  });
}

/**
 * Score a ramp for a given set of target zones and conditions.
 * Higher = better. Returns { score, reasons[] }.
 */
export function scoreRamp(ramp, { targetZones, windDeg, rangeMiles, currentRampKey }) {
  let score = 100;
  const reasons = [];
  const positives = [];

  // Closed ramp — disqualify
  if (ramp.status === 'closed') {
    return {
      score: -999,
      reasons: [`${ramp.name} is closed until ${ramp.closedUntil || 'unknown'}`],
      positives: [],
      disqualified: true,
    };
  }

  // Pay ramp — penalize but don't disqualify
  if (!ramp.free) {
    score -= 15;
    reasons.push(`${ramp.name} requires a launch fee`);
  }

  // Wind exposure penalty
  if (isRampExposed(ramp, windDeg)) {
    score -= 25;
    reasons.push(`${ramp.name} is exposed to current wind direction — rougher launch and retrieval`);
  } else if (windDeg != null) {
    score += 10;
    positives.push(`${ramp.name} is sheltered from current wind`);
  }

  // Zone match — does this ramp give good access to the target zones?
  const zoneMatches = (targetZones || []).filter(z => ramp.bestFor.includes(z));
  if (zoneMatches.length > 0) {
    score += zoneMatches.length * 20;
    positives.push(`${ramp.name} has direct access to ${zoneMatches.join(', ')}`);
  } else {
    score -= 20;
    reasons.push(`${ramp.name} doesn't directly access the target depth zones`);
  }

  // Distance from ramp to nearest target zone (rough — uses ramp position as proxy)
  // This is a placeholder until we have per-zone centroid coordinates
  // For now: west-side ramps penalized if targeting east-only zones
  const needsEastSide = (targetZones || []).some(z => EAST_ONLY_ZONES.includes(z));
  if (needsEastSide && ramp.side !== 'east') {
    score -= 40;
    reasons.push(`Targeting east-side structure — only Clearwater Cove provides direct east-bank access`);
  }
  if (needsEastSide && ramp.side === 'east') {
    score += 30;
    positives.push(`Clearwater Cove is the only ramp with direct east-bank access`);
  }

  return { score, reasons, positives, disqualified: false };
}

/**
 * Given current conditions and target zones, rank all valid Wateree ramps
 * and return the best choice plus any recommendation to change ramps.
 */
export function evaluateRamps({ currentRampKey, targetZones, windDeg, rangeMiles }) {
  const scored = WATEREE_RAMPS.map(ramp => ({
    ramp,
    ...scoreRamp(ramp, { targetZones, windDeg, rangeMiles, currentRampKey }),
  }))
  .filter(r => !r.disqualified)
  .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const current = scored.find(r => r.ramp.key === currentRampKey);
  const currentScore = current?.score ?? 0;
  const bestScore = best?.score ?? 0;

  const shouldSwitch = best && best.ramp.key !== currentRampKey && (bestScore - currentScore) >= 20;

  return {
    ranked: scored,
    best: best?.ramp,
    bestScore,
    current: current?.ramp,
    currentScore,
    shouldSwitch,
    switchDelta: bestScore - currentScore,
  };
}
