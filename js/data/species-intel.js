/**
 * species-intel.js — Lake-specific species behavior + regulations knowledge base.
 *
 * This is the "brain" behind the smart plan feature: given a lake, species,
 * date, time of day, and (optionally) live water temp, it returns a
 * recommended depth band, lure/technique suggestions, trolling speed, and
 * a plain-language rationale — plus any regulatory constraints that apply.
 *
 * Sourced from SCDNR regulations (verified June 2026), Carolina Sportsman
 * guide interviews, Angler's Headquarters seasonal reports, and SC Code of
 * Laws Title 50 Chapter 13. Regulations should be re-verified periodically
 * since SCDNR can issue emergency changes — see REGULATIONS.lastVerified.
 *
 * Data is intentionally conservative: when real intel doesn't exist for a
 * lake/species/season combo, the orchestrator falls back to general advice
 * rather than fabricating false precision.
 *
 * PLATFORM CONSTRAINT: Ryan fishes from a kayak (2023 Native Watersports
 * Slayer Propel Max 12.5, pedal drive) with a maximum of 2 rods in the
 * water at once. No planer boards, no downriggers. Depth control is via
 * lead-length only (see spread-builder.js autoCalculateLead()). Lure
 * entries in this file should stick to techniques fishable from 1-2 rods
 * off a kayak — avoid recommending planer boards, outriggers, or spreads
 * that assume 4+ simultaneous presentations.
 */

// ── Regulations ────────────────────────────────────────────────────────────
// Hard constraints. The orchestrator checks these FIRST, before any
// depth/lure logic, and will refuse or flag recommendations that would be
// illegal. closedSeason uses [startMonth, startDay, endMonth, endDay]
// (1-indexed months) and is inclusive on both ends.

export const REGULATIONS = {
  lastVerified: '2026-06-30',
  source: 'SCDNR Freshwater Fishing Regulations + SC Code of Laws Title 50 Ch.13 (50-13-230)',

  'Lake Wateree': {
    'Striped Bass': {
      closedSeason: null,
      creelLimit: null,
      sizeLimit: null,
      note: 'No lake-specific striper creel/size limit found on SCDNR Lake Wateree regs page. Stocked striped-bass-only (no hybrids). Verify current statewide limit before keeping fish.',
      stocked: true,
    },
  },

  'Lake Murray': {
    'Striped Bass': {
      closedSeason: null, // open year-round
      creelLimit: 5, // combined striper + hybrid striper per day
      sizeLimit: {
        // Oct 1 - May 31: 21" minimum. Jun 1 - Sep 30: no minimum length.
        byMonth: {
          1: { min: 21 }, 2: { min: 21 }, 3: { min: 21 }, 4: { min: 21 }, 5: { min: 21 },
          6: { min: null }, 7: { min: null }, 8: { min: null }, 9: { min: null },
          10: { min: 21 }, 11: { min: 21 }, 12: { min: 21 },
        },
      },
      note: 'Year-round open. 5 fish/day combined striper+hybrid limit always applies. No minimum size Jun-Sep; 21" minimum Oct-May.',
      stocked: true,
    },
  },

  'Lake Marion': {
    'Striped Bass': {
      closedSeason: [6, 16, 9, 30], // closed Jun 16 - Sep 30
      creelLimit: 2,
      sizeLimit: { min: 23, max: 25, exception: 'one fish per day may exceed 26 inches' },
      note: 'CLOSED June 16 - September 30 (Santee River system rule, includes Marion/Moultrie/Wateree River/Congaree/Broad). No targeted catch & release allowed during closure. Open season Oct 1 - Jun 15: 2 fish/day, 23-25" slot, one fish may exceed 26".',
      stocked: true,
    },
  },

  'Lake Moultrie': {
    'Striped Bass': {
      closedSeason: [6, 16, 9, 30],
      creelLimit: 2,
      sizeLimit: { min: 23, max: 25, exception: 'one fish per day may exceed 26 inches' },
      note: 'Same Santee River system rule as Lake Marion — closed Jun 16 - Sep 30.',
      stocked: true,
    },
  },

  'Lake Monticello': {
    'Striped Bass': {
      notPresent: true,
      note: 'Lake Monticello has NO stocked striped bass population. Target species here are largemouth bass, smallmouth bass, crappie, and catfish instead.',
    },
  },

  'Parr Reservoir': {
    'Striped Bass': {
      notPresent: true,
      note: 'Parr Reservoir has no managed/dedicated striper fishery. Smallmouth bass is the primary target species; largemouth and crappie also present.',
    },
  },
};

// ── Species behavior ──────────────────────────────────────────────────────
// Per-lake, per-species behavior by season and time-of-day. depthBand can be
// a fixed [min,max] array or a function(waterTempF) => [min,max] when the
// lake's behavior is temperature-driven rather than calendar-driven.

const DAWN = 'dawn';   // ~30min before sunrise to ~2hrs after
const DAY = 'day';     // mid-morning through mid-afternoon
const DUSK = 'dusk';   // ~2hrs before sunset to ~30min after
const NIGHT = 'night';

export const SPECIES_BEHAVIOR = {

  'Lake Wateree': {
    'Striped Bass': {
      summer: { // Jun-Aug
        depthBand: (tempF) => {
          // Thermocline sets up ~16-20ft by Aug per Carolina Sportsman guide
          // interviews (Heinning, Whiteside). Shallower than Murray/Marion.
          if (tempF && tempF > 84) return [18, 24];
          return [14, 22];
        },
        timeOfDay: {
          [DAWN]: { depthShift: -6, lures: ['Choppo 90', 'Rattling Spook', 'Bucktail'], speed: 1.8,
            notes: 'Early AM stripers run 12-15ft, shallower than mid-day. Topwater/schooling window. Cast netting bait around grass banks if live-baiting.' },
          [DAY]: { depthShift: 0, lures: ['A-Rig Medium', 'Umbrella Rig 3/4oz', 'Flutter Spoon 2oz'], speed: 2.0,
            notes: 'Fish scatter to ledges/channels by mid-morning. Umbrella rigs with 1/4oz jigheads + 4-5" trailers (match the hatch to shad size). Trolling speed 1.5-2.5mph. Thermocline sets up 16-20ft by late summer — use electronics to find suspended fish.' },
          [DUSK]: { depthShift: -4, lures: ['Choppo 90', 'Bucktail', 'Shad-imitation lure'], speed: 1.8,
            notes: 'Topwater schooling action returns, scattered but dependable in low light.' },
        },
        sources: ['Justin Whiteside guide interviews, Carolina Sportsman 2019/2021', 'Chris Heinning guide interview, Carolina Sportsman 2021'],
      },
      fall: { // Sep-Nov
        depthBand: [10, 20],
        timeOfDay: {
          [DAWN]: { depthShift: -4, lures: ['Topwater shad imitation', 'Bucktail'], speed: 1.8, notes: 'Shad migration pattern begins, fish push shallower as water cools.' },
          [DAY]: { depthShift: 0, lures: ['Crankbait', 'A-Rig Medium'], speed: 2.0, notes: 'Scattered along ledges and channel edges, following bait.' },
          [DUSK]: { depthShift: -3, lures: ['Topwater', 'Bucktail'], speed: 1.8, notes: 'Schooling action common.' },
        },
        sources: ['General reservoir striper seasonal pattern, Wateree fishing reports'],
      },
      winter: { // Dec-Feb
        depthBand: [15, 30],
        timeOfDay: {
          [DAWN]: { depthShift: 0, lures: ['Jigging spoon', 'Live shad downline'], speed: 1.0, notes: 'Slower presentation, fish deeper and less aggressive.' },
          [DAY]: { depthShift: 5, lures: ['Jigging spoon', 'Bucktail'], speed: 1.0, notes: 'Suspended deeper, target with electronics.' },
          [DUSK]: { depthShift: 0, lures: ['Live bait downline'], speed: 1.0, notes: '' },
        },
        sources: ['General SC reservoir winter striper pattern'],
      },
      spring: { // Mar-May
        depthBand: [5, 15],
        timeOfDay: {
          [DAWN]: { depthShift: -3, lures: ['Topwater', 'Live herring free-line'], speed: 1.5, notes: 'Pre/post spawn shallow push, points and creek mouths.' },
          [DAY]: { depthShift: 0, lures: ['Crankbait', 'Live bait'], speed: 1.8, notes: '' },
          [DUSK]: { depthShift: -3, lures: ['Topwater'], speed: 1.5, notes: '' },
        },
        sources: ['General reservoir spring striper spawn-run pattern'],
      },
    },
  },

  'Lake Murray': {
    'Striped Bass': {
      summer: {
        depthBand: (tempF) => {
          // Thermocline ~30ft lower lake by Aug per AHQ 2021 report.
          // Two depth groups exist: suspended near thermocline vs deep/bottom.
          return [28, 36];
        },
        timeOfDay: {
          [DAWN]: { depthShift: -4, lures: ['Live herring free-line', 'Choppo 90'], speed: 1.0,
            notes: 'Fish may only be 12-15ft deep early, get progressively deeper through morning. Free-line one rod, work topwater on the other — both fishable from a kayak with no planer board needed.' },
          [DAY]: { depthShift: 0, lures: ['Down-line live herring', 'Umbrella rig', 'Lead-core trolling'], speed: 1.5,
            notes: 'Thermocline ~30ft in lower lake (Dreher Island to dam). One group suspends near 30ft, another holds bottom in 70-100ft near the dam (low O2, harder to catch). Down-rodding with line counters recommended.' },
          [DUSK]: { depthShift: -4, lures: ['Free-line live herring'], speed: 1.0, notes: 'Evening shallow push similar to dawn.' },
        },
        sources: ['William Attaway guide interview, Carolina Sportsman 2021', 'AHQ Lake Murray Summer 2021 report', 'Bouknight guide interview, Fish of Dreams'],
      },
      fall: {
        depthBand: [10, 25],
        timeOfDay: {
          [DAWN]: { depthShift: -3, lures: ['Topwater', 'Live herring'], speed: 1.5, notes: 'Fish move toward creek mouths chasing shad as water cools.' },
          [DAY]: { depthShift: 0, lures: ['A-Rig', 'Crankbait'], speed: 1.8, notes: '' },
          [DUSK]: { depthShift: -3, lures: ['Topwater'], speed: 1.5, notes: '' },
        },
        sources: ['General Murray fall pattern'],
      },
      winter: {
        depthBand: [15, 30],
        timeOfDay: {
          [DAWN]: { depthShift: 0, lures: ['Live shad', 'Jigging spoon'], speed: 1.0, notes: 'Stripers head toward upper lake following threadfin shad in winter.' },
          [DAY]: { depthShift: 0, lures: ['Down-line live bait'], speed: 1.0, notes: '' },
          [DUSK]: { depthShift: 0, lures: ['Live bait'], speed: 1.0, notes: '' },
        },
        sources: ['Murray seasonal migration pattern, Best Fishing in America guide'],
      },
      spring: {
        depthBand: [3, 15],
        timeOfDay: {
          [DAWN]: { depthShift: -2, lures: ['Plugs', 'Flukes', 'Free-line herring'], speed: 1.5,
            notes: 'Fish in backs of creeks, shallow points. Mouths of Buffalo/Rocky Creek key in April-May herring spawn.' },
          [DAY]: { depthShift: 0, lures: ['Casting plugs', 'A-Rig Light'], speed: 1.8, notes: 'Cast one rod to cover while trolling the other on lead-length depth control.' },
          [DUSK]: { depthShift: -2, lures: ['Topwater'], speed: 1.5, notes: '' },
        },
        sources: ['Brad Taylor guide interview, AHQ Spring report'],
      },
    },
  },

  'Lake Marion': {
    'Striped Bass': {
      summer: {
        // NOTE: closed season Jun16-Sep30 — orchestrator must check REGULATIONS first
        depthBand: [40, 55],
        timeOfDay: {
          [DAWN]: { depthShift: -5, lures: ['Topwater', 'Bucktail'], speed: 1.5, notes: 'Schooling action near Pinopolis Dam early/late, but verify season is open before targeting.' },
          [DAY]: { depthShift: 0, lures: ['Live herring downline'], speed: 1.0, notes: 'Post-spawn fish hold near Pinopolis Dam ~50ft.' },
          [DUSK]: { depthShift: -5, lures: ['Topwater', 'Bucktail'], speed: 1.5, notes: '' },
        },
        sources: ['Kevin Davis guide interview, Carolina Sportsman 2021 (Lake Moultrie post-spawn pattern)'],
      },
      fall: {
        depthBand: [20, 40],
        timeOfDay: {
          [DAWN]: { depthShift: -5, lures: ['Bucktail', 'Jig + plastic trailer'], speed: 1.5, notes: 'Schooling action picks up, surface feeding common.' },
          [DAY]: { depthShift: 0, lures: ['Live herring', 'Cut bait'], speed: 1.2, notes: '' },
          [DUSK]: { depthShift: -5, lures: ['Bucktail', 'Topwater'], speed: 1.5, notes: '' },
        },
        sources: ['Kevin Davis / Leroy Suggs December striper report, Coastal Angler Magazine'],
      },
      winter: {
        depthBand: [20, 50],
        timeOfDay: {
          [DAWN]: { depthShift: -3, lures: ['Bucktail', 'Rockport Rattler jig'], speed: 1.5,
            notes: 'December prime time. Schooling action plus live bait. Vary jig color frequently (chartreuse, white combos).' },
          [DAY]: { depthShift: 3, lures: ['Live blueback herring downline'], speed: 1.0,
            notes: 'Mark fish on graph along humps/ledges, drop bait to fish depth or slightly above — they readily come up but seldom go deeper.' },
          [DUSK]: { depthShift: -3, lures: ['Bucktail'], speed: 1.5, notes: '' },
        },
        sources: ['Kevin Davis / Leroy Suggs, Coastal Angler Magazine Dec report'],
      },
      spring: {
        depthBand: [10, 30],
        timeOfDay: {
          [DAWN]: { depthShift: -3, lures: ['Live herring'], speed: 1.2, notes: 'Spawning run up Congaree/Wateree rivers via diversion canal. Fish concentrated in deep holes during the run itself.' },
          [DAY]: { depthShift: 0, lures: ['Live herring', 'Cut bait'], speed: 1.2, notes: '' },
          [DUSK]: { depthShift: -3, lures: ['Live bait'], speed: 1.2, notes: '' },
        },
        sources: ['Santee Cooper Country fishing strategies guide'],
      },
    },
  },

  'Lake Moultrie': {
    'Striped Bass': {
      // Same regulatory window as Marion (Santee River system). Behavior
      // differs slightly — Moultrie has more open water, less standing timber.
      summer: {
        depthBand: [40, 50],
        timeOfDay: {
          [DAWN]: { depthShift: -10, lures: ['Topwater', 'Bucktail'], speed: 1.5, notes: 'Pinopolis Dam schooling action — verify season open before targeting.' },
          [DAY]: { depthShift: 0, lures: ['Live herring near bottom'], speed: 1.0, notes: 'Fish near 50ft close to Pinopolis Dam, deep water.' },
          [DUSK]: { depthShift: -10, lures: ['Topwater', 'Bucktail'], speed: 1.5, notes: '' },
        },
        sources: ['Kevin Davis, Carolina Sportsman 2021'],
      },
      fall: {
        depthBand: [20, 40],
        timeOfDay: {
          [DAWN]: { depthShift: -5, lures: ['Bucktail', 'Topwater'], speed: 1.5, notes: '' },
          [DAY]: { depthShift: 0, lures: ['Live herring downline'], speed: 1.2, notes: '' },
          [DUSK]: { depthShift: -5, lures: ['Bucktail'], speed: 1.5, notes: '' },
        },
        sources: ['General Moultrie fall pattern, consistent with Marion'],
      },
      winter: {
        depthBand: [20, 50],
        timeOfDay: {
          [DAWN]: { depthShift: -3, lures: ['Bucktail jig', 'Live menhaden'], speed: 1.5,
            notes: 'Menhaden migrate in via lock/fish lift near Pinopolis — excellent live bait when available, ~3 fingers wide preferred size.' },
          [DAY]: { depthShift: 3, lures: ['Live blueback herring'], speed: 1.0, notes: 'Mark fish, drop to depth or slightly above.' },
          [DUSK]: { depthShift: -3, lures: ['Bucktail'], speed: 1.5, notes: '' },
        },
        sources: ['Leroy Suggs guide interview, Coastal Angler Magazine'],
      },
      spring: {
        depthBand: [10, 30],
        timeOfDay: {
          [DAWN]: { depthShift: -3, lures: ['Live herring'], speed: 1.2, notes: 'Pre-spawn staging before the run up through the diversion canal.' },
          [DAY]: { depthShift: 0, lures: ['Live herring'], speed: 1.2, notes: '' },
          [DUSK]: { depthShift: -3, lures: ['Live bait'], speed: 1.2, notes: '' },
        },
        sources: ['Santee Cooper Country fishing strategies guide'],
      },
    },
  },

  // Monticello and Parr have no meaningful striper data (see REGULATIONS —
  // notPresent: true). Largemouth/crappie/catfish entries can be added here
  // later if Ryan wants those species covered by the smart plan too.
};

// ── Helpers ───────────────────────────────────────────────────────────────

export function getSeason(date) {
  const month = (date instanceof Date ? date : new Date(date)).getMonth() + 1; // 1-12
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'fall';
  if (month === 12 || month <= 2) return 'winter';
  return 'spring';
}

export function getTimeOfDay(launchTimeStr) {
  // launchTimeStr is "HH:MM" 24hr from the planLaunchTime input
  if (!launchTimeStr) return DAY;
  const hour = parseInt(launchTimeStr.split(':')[0], 10);
  if (isNaN(hour)) return DAY;
  if (hour < 8) return DAWN;
  if (hour < 17) return DAY;
  if (hour < 20) return DUSK;
  return NIGHT;
}

/**
 * Check whether a species is legal to target right now on a given lake.
 * Returns { legal: bool, reason: string|null, regInfo: object|null }
 */
/**
 * Normalize a lake-dropdown value (e.g. "Lake Wateree, SC" or
 * "river:wateree-tailrace") against this file's REGULATIONS/SPECIES_BEHAVIOR
 * keys (e.g. "Lake Wateree"). The Plan tab's dropdown values come from
 * LAKE_DB keys in data/lakes.js, which include a ", SC" suffix and other
 * variations that don't exact-match the bare lake names used here.
 * Exact match first, then strip a trailing ", XX" state suffix and retry,
 * then fall back to substring containment in either direction (same
 * tolerant pattern utility-sync.js already uses for this exact problem).
 */
export function resolveLakeKey(lakeName, table) {
  if (!lakeName) return null;
  if (table[lakeName]) return lakeName;
  const stripped = lakeName.replace(/,\s*[A-Za-z]{2}$/, '').trim();
  if (table[stripped]) return stripped;
  const lower = stripped.toLowerCase();
  const found = Object.keys(table).find((k) => {
    const kl = k.toLowerCase();
    return lower.includes(kl) || kl.includes(lower);
  });
  return found || null;
}

export function checkRegulations(lakeName, species, date) {
  const key = resolveLakeKey(lakeName, REGULATIONS);
  const lakeRegs = key ? REGULATIONS[key] : null;
  if (!lakeRegs || !lakeRegs[species]) {
    return { legal: true, reason: null, regInfo: null, note: 'No specific regulation data available — verify locally before fishing.' };
  }
  const reg = lakeRegs[species];

  if (reg.notPresent) {
    return { legal: false, reason: reg.note, regInfo: reg };
  }

  if (reg.closedSeason) {
    const [sm, sd, em, ed] = reg.closedSeason;
    const d = date instanceof Date ? date : new Date(date);
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const mdVal = month * 100 + day;
    const startVal = sm * 100 + sd;
    const endVal = em * 100 + ed;
    const inClosedWindow = startVal <= endVal
      ? (mdVal >= startVal && mdVal <= endVal)
      : (mdVal >= startVal || mdVal <= endVal); // wraps year boundary
    if (inClosedWindow) {
      return { legal: false, reason: `Closed season: ${reg.note}`, regInfo: reg };
    }
  }

  return { legal: true, reason: null, regInfo: reg };
}
