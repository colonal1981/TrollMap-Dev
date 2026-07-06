/**
 * ryan-ramps.js — Personal ramp database for TrollMap Smart Plan.
 *
 * These are Ryan's actual launch points across his target lakes —
 * not a generic public database. Coordinates sourced from TrollMap's
 * TRISTATE_MASTER_RAMPS where available, corrected/supplemented from
 * personal knowledge and GPS verification.
 *
 * Design principles:
 *   - Only ramps Ryan actually uses or would use
 *   - Membership/pay ramps included (Ryan has access)
 *   - Closed ramps flagged with estimated reopening
 *   - The ONLY hard block is dangerous weather (GO/NO-GO in plan-builder.js)
 *   - Everything else is guidance, never a gate
 *
 * Platform: 2023 Native Watersports Slayer Propel Max 12.5
 *           NK180 Pro motor (24V, ~6A avg draw at trolling speed)
 *           100Ah LiFePO4 battery
 */

// ── Utility functions ─────────────────────────────────────────────────────────

export function distanceMiles(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 69.0;
  const dLon = (lon2 - lon1) * 69.0 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

export function parseWindDeg(weatherStr) {
  const BEARINGS = {
    N:0, NNE:22.5, NE:45, ENE:67.5, E:90, ESE:112.5, SE:135, SSE:157.5,
    S:180, SSW:202.5, SW:225, WSW:247.5, W:270, WNW:292.5, NW:315, NNW:337.5,
  };
  const m = String(weatherStr || '').match(/\b(N|NNE|NE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)\b/);
  return m ? (BEARINGS[m[1]] ?? null) : null;
}

// ── Lake Wateree ──────────────────────────────────────────────────────────────
// 7 viable ramps. Decision logic:
//   Borderline/rough weather         → Wateree Creek (most protected creek arm)
//   North end / Dutchmans / upper    → Wateree Creek
//   Mid-lake west side               → Molly Creek
//   East side / Clearwater / Wyboo / south body / dam area → Clearwater Cove
//   Taylor Creek                     → available but avoid if gear in vehicle overnight (break-ins)
//   June Creek                       → shallow, untested, low confidence
//   Colonel Creek                    → fine ramp, rarely used
//   Buck Hill                        → CLOSED until March 2027

export const WATEREE_RAMPS = [
  {
    name: 'Clearwater Cove',
    key: 'Clearwater Cove',
    lat: 34.3793, lon: -80.7288,
    side: 'east',
    zone: 'mid_south',
    primary: true,
    free: true,
    status: 'open',
    closedUntil: null,
    preference: 1, // Ryan's #1 launch
    notes: 'Primary east-side launch. Direct access to Clearwater Cove humps, Wyboo Creek arm, east bank contours, south body, dam area. More open/exposed than Wateree Creek in rough weather.',
    bestFor: ['clearwater_cove', 'east_bank', 'wyboo_arm', 'humps', 'south_body', 'dam_area', 'mid_lake'],
    northLimit: 34.383, // don't go north of Molly Creek lat from this ramp
    exclusive: ['clearwater_cove', 'east_bank', 'wyboo_arm', 'humps'], // only ramp for these
  },
  {
    name: 'Wateree Creek Access Area',
    key: 'Wateree Creek',
    lat: 34.4696, lon: -80.9139,
    side: 'west',
    zone: 'north',
    primary: true,
    free: true,
    status: 'open',
    closedUntil: null,
    preference: 2,
    notes: 'Primary north-end launch. Most protected ramp on the lake — narrow creek arm shields from wind. Best choice in borderline weather. Range: north dam to roughly Dutchmans Creek south.',
    bestFor: ['north_channel', 'dutchmans_arm', 'upper_lake', 'north_structure'],
    southLimit: 34.440, // don't go south of Taylor Creek lat from this ramp
    protectedWeather: true, // most sheltered launch on Wateree
  },
  {
    name: 'Molly Creek Access Area',
    key: 'Molly Creek',
    lat: 34.3828, lon: -80.7880,
    side: 'west',
    zone: 'mid',
    primary: true,
    free: true,
    status: 'open',
    closedUntil: null,
    preference: 3,
    notes: 'Go-to mid-lake west-side launch. Use when targeting west-side channel structure between Clearwater\'s north limit and Wateree Creek\'s south limit.',
    bestFor: ['mid_channel', 'mid_lake', 'west_bank', 'channel_ledges'],
  },
  {
    name: 'Taylor Creek Access Area',
    key: 'Taylor Creek',
    lat: 34.4377, lon: -80.8758,
    side: 'west',
    zone: 'north',
    primary: false,
    free: true,
    status: 'open',
    closedUntil: null,
    preference: 4,
    notes: 'Valid north/upper-lake launch but avoid if leaving gear in vehicle overnight — break-in history at this location.',
    bestFor: ['north_channel', 'taylors_arm', 'upper_lake'],
    securityWarning: 'Break-in history — avoid overnight vehicle storage',
  },
  {
    name: 'Colonel Creek Access Area',
    key: 'Colonel Creek',
    lat: 34.3689, lon: -80.7972,
    side: 'west',
    zone: 'mid_south',
    primary: false,
    free: true,
    status: 'open',
    closedUntil: null,
    preference: 5,
    notes: 'Solid ramp, rarely used. Fine alternative if Molly Creek is crowded.',
    bestFor: ['mid_channel', 'channel_ledges', 'west_bank'],
  },
  {
    name: 'June Creek Access Area',
    key: 'June Creek',
    lat: 34.3913, lon: -80.8294,
    side: 'west',
    zone: 'mid',
    primary: false,
    free: true,
    status: 'open',
    closedUntil: null,
    preference: 6,
    notes: 'Very shallow approach — untested by Ryan. Low confidence until verified on the water.',
    bestFor: ['mid_channel'],
    lowConfidence: true,
  },
  {
    name: 'Buck Hill',
    key: 'Buck Hill',
    lat: 34.3359, lon: -80.7072,
    side: 'west',
    zone: 'south',
    primary: false,
    free: true,
    status: 'closed',
    closedUntil: '2027-03-01',
    preference: 7,
    notes: 'CLOSED — estimated reopening March 2027.',
    bestFor: ['south_channel', 'south_body'],
  },
];

// ── Lake Marion ───────────────────────────────────────────────────────────────
// 6 ramps. Lake runs NE-SW (headwaters/swamp = NE, dam/Moultrie = SW).
// Summerton on north shore ≈ midpoint. Santee on south shore near dam end.
// Striper season: CLOSED Jun 16 - Sep 30 (Santee River system rule).

export const MARION_RAMPS = [
  {
    name: 'Sparkleberry Landing',
    key: 'Sparkleberry',
    lat: 33.7015, lon: -80.5368,
    side: 'north',
    zone: 'upper_NW',
    primary: false,
    free: true,
    status: 'open',
    closedUntil: null,
    preference: 1,
    notes: 'Upper lake NW arm, deep in the swamp/timbered section. Spring spawn staging area. Remote.',
    bestFor: ['upper_swamp', 'spawn_staging', 'timbered_flats', 'spring_striper'],
  },
  {
    name: 'Rimini / Pack\'s Landing',
    key: 'Rimini',
    lat: 33.6594, lon: -80.5151,
    side: 'north',
    zone: 'upper_NW',
    primary: true,
    free: true,
    status: 'open',
    closedUntil: null,
    preference: 2,
    notes: 'Good north-shore ramp in the upper lake area. Access to timbered flats and upper channel.',
    bestFor: ['upper_lake', 'north_channel', 'timbered_flats'],
  },
  {
    name: 'Low Falls',
    key: 'Low Falls',
    lat: 33.6324, lon: -80.5435,
    side: 'south',
    zone: 'upper_SW',
    primary: true,
    free: true,
    status: 'open',
    closedUntil: null,
    preference: 3,
    notes: 'Santee/south-shore side, upper lake. Good ramp, opposite shore from Rimini.',
    bestFor: ['upper_lake', 'south_channel', 'santee_side'],
  },
  {
    name: 'Jacks Creek',
    key: 'Jacks Creek',
    lat: 33.5669, lon: -80.4375,
    side: 'north',
    zone: 'mid',
    primary: true,
    free: false,
    payNote: 'Day use fee — Ryan has access',
    status: 'open',
    closedUntil: null,
    preference: 4,
    notes: 'Mid-lake north shore. Was free, now pay. Ryan\'s preferred mid-lake Marion launch. Good access to main lake body.',
    bestFor: ['mid_lake', 'main_channel', 'mid_depth_ledges'],
  },
  {
    name: 'Taw Caw',
    key: 'Taw Caw',
    lat: 33.5354, lon: -80.3317,
    side: 'north',
    zone: 'mid_NE',
    primary: false,
    free: true,
    status: 'open',
    closedUntil: null,
    preference: 5,
    notes: 'Mid-lake NE area. Good alternative now that Jacks Creek went pay. Upper end of mid-lake range.',
    bestFor: ['mid_lake', 'NE_flats', 'mid_depth_ledges'],
  },
  {
    name: 'Rowland Subdivision',
    key: 'Rowland Subdivision',
    lat: 33.5462, lon: -80.2241,
    side: 'east',
    zone: 'NE_Wyboo',
    primary: true,
    free: true,
    status: 'open',
    closedUntil: null,
    preference: 6,
    notes: 'Preferred Wyboo Creek access — middle of the three Wyboo ramps. NE end of lake, good creek arm fishing.',
    bestFor: ['wyboo_arm', 'NE_creek', 'spring_striper'],
  },
];

// ── Lake Moultrie ─────────────────────────────────────────────────────────────
// Ryan primarily fishes Shortstay military rec area near Pinopolis Dam.
// Membership required (active/retired military + family, annual membership).
// No public ramp evaluation needed — this is personal access only.

export const MOULTRIE_RAMPS = [
  {
    name: 'Shortstay Recreation Area',
    key: 'Shortstay',
    lat: 33.2200, lon: -80.0100, // approximate — near Pinopolis Dam
    side: 'west',
    zone: 'dam_area',
    primary: true,
    free: false,
    payNote: 'Military/family membership — annual pass (Ryan has access)',
    status: 'open',
    closedUntil: null,
    preference: 1,
    notes: 'Ryan\'s primary Moultrie launch. Near Pinopolis Dam — direct access to the deep post-spawn/winter striper holding zone. Military/family only with annual membership.',
    bestFor: ['dam_area', 'deep_structure', 'pinopolis_zone', 'winter_striper', 'post_spawn'],
    membershipRequired: true,
  },
];

// ── Lake Murray ───────────────────────────────────────────────────────────────
// Ryan has fished Hilton and the dam ramp. Not enough personal ground truth
// for zone-based ramp evaluation yet. Smart Plan skips ramp evaluation on
// Murray and lets Ryan select manually.

export const MURRAY_RAMPS = [
  {
    name: 'Hilton',
    key: 'Hilton',
    lat: 34.0943, lon: -81.3289,
    side: 'south',
    zone: 'mid',
    primary: true,
    free: true,
    status: 'open',
    closedUntil: null,
    preference: 1,
    notes: 'One of Ryan\'s two primary Murray launches. Mid-lake access.',
    bestFor: ['mid_lake'],
  },
  {
    name: 'Lake Murray Dam',
    key: 'Lake Murray Dam',
    lat: 34.0651, lon: -81.2224,
    side: 'east',
    zone: 'dam_area',
    primary: true,
    free: true,
    status: 'open',
    closedUntil: null,
    preference: 2,
    notes: 'Dam end ramp. Lower lake access, deep water nearby.',
    bestFor: ['dam_area', 'deep_structure', 'lower_lake'],
  },
];

// ── Lake Monticello ───────────────────────────────────────────────────────────
// 2 ramps on main lake + 1 on rec subimpoundment (physically divided).
// No striper — largemouth, crappie, catfish. Ryan hasn't fished in 1-2 years.
// Simple flat list, no zone subdivision needed.

export const MONTICELLO_RAMPS = [
  {
    name: 'Lake Monticello West',
    key: 'Lake Monticello West',
    lat: 34.3763, lon: -81.3179,
    side: 'west',
    zone: 'main_lake',
    primary: true,
    free: true,
    status: 'open',
    closedUntil: null,
    preference: 1,
    notes: 'West side main lake ramp. Note: lake levels can fluctuate up to 5ft/hour due to nuclear plant pumped-storage operations — check level before launching.',
    bestFor: ['main_lake', 'west_bank'],
    levelWarning: 'Pumped-storage reservoir — rapid level changes possible',
  },
  {
    name: 'Lake Monticello East',
    key: 'Lake Monticello East',
    lat: 34.3276, lon: -81.2856,
    side: 'east',
    zone: 'main_lake',
    primary: true,
    free: true,
    status: 'open',
    closedUntil: null,
    preference: 2,
    notes: 'East side main lake ramp. Same level-change warning applies.',
    bestFor: ['main_lake', 'east_bank'],
    levelWarning: 'Pumped-storage reservoir — rapid level changes possible',
  },
  {
    name: 'Monticello Recreation Lake',
    key: 'Subimpoundment',
    lat: 34.3792, lon: -81.3135,
    side: 'west',
    zone: 'rec_lake',
    primary: false,
    free: true,
    status: 'open',
    closedUntil: null,
    preference: 3,
    notes: 'Physically separate subimpoundment — not connected to main lake.',
    bestFor: ['rec_lake'],
  },
];

// ── Master lookup ─────────────────────────────────────────────────────────────

const ALL_RAMPS = {
  'Lake Wateree': WATEREE_RAMPS,
  'Lake Marion':  MARION_RAMPS,
  'Lake Moultrie': MOULTRIE_RAMPS,
  'Lake Murray':  MURRAY_RAMPS,
  'Lake Monticello': MONTICELLO_RAMPS,
};

function resolveLakeRamps(lakeName) {
  const key = Object.keys(ALL_RAMPS).find(k =>
    lakeName.toLowerCase().includes(k.toLowerCase().replace('lake ', ''))
  );
  return key ? ALL_RAMPS[key] : null;
}

// ── Ramp evaluation ───────────────────────────────────────────────────────────

/**
 * Given lake name, current conditions, and target zones from Smart Plan,
 * evaluate which ramp is best and whether to suggest switching.
 *
 * Returns:
 *   { best, current, shouldSwitch, switchDelta, ranked, closedWarning }
 */
export function evaluateRamps({ lakeName, currentRampKey, targetZones, windDeg, rangeMiles, roughWeather }) {
  const ramps = resolveLakeRamps(lakeName);
  if (!ramps) return null;

  // Murray: no zone evaluation, manual selection only
  if (lakeName.toLowerCase().includes('murray')) {
    const current = ramps.find(r => r.key === currentRampKey) || ramps[0];
    return { best: current, current, shouldSwitch: false, skipEval: true, ranked: ramps };
  }

  // Check for closed ramp warning
  const selectedRamp = ramps.find(r => r.key === currentRampKey);
  let closedWarning = null;
  if (selectedRamp?.status === 'closed') {
    closedWarning = `${selectedRamp.name} is closed until ${selectedRamp.closedUntil || 'further notice'}`;
  }

  // Score each open ramp
  const scored = ramps
    .filter(r => r.status === 'open')
    .map(r => {
      let score = 100;
      const reasons = [];
      const positives = [];

      // Rough/borderline weather → heavily favor protected launches
      if (roughWeather) {
        if (r.protectedWeather) { score += 40; positives.push(`${r.name} is the most sheltered launch in rough conditions`); }
        else if (lakeName.toLowerCase().includes('wateree') && r.key === 'Clearwater Cove') {
          score -= 20; reasons.push('Clearwater Cove is more exposed — consider Wateree Creek in rough weather');
        }
      }

      // Low confidence ramp penalty
      if (r.lowConfidence) { score -= 30; reasons.push(`${r.name} has a shallow/unknown approach — verify before committing`); }

      // Security warning
      if (r.securityWarning) { score -= 10; reasons.push(r.securityWarning); }

      // Zone match
      const matches = (targetZones || []).filter(z => r.bestFor?.includes(z));
      if (matches.length) {
        score += matches.length * 20;
        positives.push(`${r.name} accesses ${matches.join(', ')}`);
      } else {
        score -= 20;
        reasons.push(`${r.name} doesn't directly access the target zones for this phase`);
      }

      // Preference bonus (lower number = more preferred by Ryan)
      score += (10 - (r.preference || 5)) * 2;

      // Pay ramp minor penalty if free alternative exists
      if (!r.free) {
        const hasFreeAlternative = ramps.filter(x => x.status === 'open' && x.free).length > 0;
        if (hasFreeAlternative) { score -= 5; reasons.push(`${r.name} has a launch fee`); }
      }

      score = Math.min(100, Math.max(0, score));
      return { ramp: r, score, reasons, positives };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const current = scored.find(r => r.ramp.key === currentRampKey) || scored[0];
  const shouldSwitch = best && current &&
    best.ramp.key !== currentRampKey &&
    (best.score - current.score) >= 20;

  return {
    ranked: scored,
    best: best?.ramp,
    bestScore: best?.score,
    bestPositives: best?.positives || [],
    current: current?.ramp,
    currentScore: current?.score,
    currentReasons: current?.reasons || [],
    shouldSwitch,
    switchDelta: (best?.score || 0) - (current?.score || 0),
    closedWarning,
    skipEval: false,
  };
}
