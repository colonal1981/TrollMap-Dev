import { livePolicyFor, closuresFor } from './regulations-live.js';
/**
 * species-intel.js — TrollMap Unified Species behavior + regulations knowledge base.
 * Sourced from SCDNR regulations, Carolina Sportsman, and Angler's Headquarters.
 * Consolidated: Merged legacy species-intel.js and species-intel-v2.js.
 */

// ── Regulations ────────────────────────────────────────────────────────────
// REGULATIONS WAS HERE AND IS GONE -- 2026-08-27.
//
// A hand-written table of SIX waters that gated `legal: false` for all 358. Ryan: "what is the
// point of having all of this information if we just have hand written tables that cover
// slightly more than 1% of our water".
//
// Thirteen rows. ELEVEN WERE DUPLICATES:
//
//   Wateree, 8 species, and Murray, 1 -- limits and notes. livePolicyFor() answers limits from
//   the state digest for every water in four states, not six, and says whether the rule it found
//   was lake-specific or statewide.
//
//   Marion and Moultrie -- the Jun 16 - Sep 30 striper closure. registry/regulations.json parses
//   it out of the book itself, and test/regulations-closures.test.js checks the hand row and the
//   parsed one against each other on 36 sample days: they agree on every one.
//
// THE OTHER TWO WERE NOT LAW AT ALL, AND THEY DO NOT BELONG ANYWHERE. `notPresent` on Monticello
// and Parr Shoals said there are no striped bass in those lakes. That was rebuilt here on
// 2026-08-27 as a `species_absent` list read off the registry row, and removed on 2026-08-28.
//
// Ryan, twice: *"that random note about parr not having striped bass isn't needed... we have a
// species list"*, and then *"i do not want to block the plan based on our species lists"*.
//
// THREE REASONS, AND THE THIRD ONE NEVER GOES AWAY.
//
// Absence is not enumerable -- nobody can write down what is not in a lake, which is why that
// list was two waters and one fish and could never have been more.
//
// Our lists are short: 130 of 358 waters have one at all.
//
// AND A PUBLISHED LIST IS A SNAPSHOT, NOT A CENSUS. Ryan, 2026-08-28: *"species lists are
// incomplete... and just because spotted bass isn't mentioned today doesn't mean they didn't end
// up getting in and reproducing like mad like they like to do... smallmouth are in parr and
// monticello because they made it in through the broad river"*. Fish arrive on their own. An
// agency page names what somebody sampled in the year they wrote it. Even a complete list would
// go stale, so no amount of filling the gaps makes the complement safe.
//
// So OUR SPECIES DATA DOES NOT GATE A TRIP. What we know about a lake's fish INFORMS a plan --
// ranks it, warns on it, says where the number came from -- and never blocks one.
//
// `legal: false` comes from law: a closure the book states, parsed by build_regulations_table.py.
// Nothing else in this file may produce it.
//
// DO NOT ADD A WATER HERE. There is nothing to add it to. A closure belongs in the book parser,
// a limit in the digest, and what swims in a lake in the species merge, which does not gate.

// ── Helpers ───────────────────────────────────────────────────────────────
export function getSeason(date) {
  const month = (date instanceof Date ? date : new Date(date)).getMonth() + 1; // 1-12
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'fall';
  if (month === 12 || month <= 2) return 'winter';
  return 'spring';
}

export const TOD = { DAWN: 'dawn', DAY: 'day', DUSK: 'dusk', NIGHT: 'night' };

export function getTimeOfDay(launchTimeStr) {
  if (!launchTimeStr) return TOD.DAY;
  const hour = parseInt(String(launchTimeStr).split(':')[0], 10);
  if (isNaN(hour)) return TOD.DAY;
  if (hour < 8) return TOD.DAWN;
  if (hour < 17) return TOD.DAY;
  if (hour < 20) return TOD.DUSK;
  return TOD.NIGHT;
}

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

/**
 * WARNINGS, NOT A NOTE. The old unknown branch returned `note`, and NEITHER CALLER READS IT:
 * checkPlanLegality maps `reason` and `warnings`; smart-plan reads `legal` and `warnings`. So on
 * 448 of 454 waters this ran, said "we do not know", and displayed nothing — indistinguishable
 * from "checked, you are fine". The throw path in checkPlanLegality directly above DOES warn, so
 * a failed check spoke and an empty one did not.
 *
 * `state` is optional and only used to read the live digest, which the caller primes when a water
 * is selected. A cold cache is the unknown branch, which warns. Nothing here turns a network
 * problem into permission.
 *
 * A LIMIT IS NOT A CLOSURE. The digest publishes size and creel limits; it does not say a season
 * is shut, which is what `legal: false` means. Legality still comes from the curated table's
 * notPresent / closedSeason rows, and the returned `limits` says which book it came out of.
 */
export function checkRegulations(lakeName, species, date, state = null) {
  const live = state ? livePolicyFor(state, lakeName, species) : null;
  // `withheld` CARRIES NO NUMBERS AND MUST NOT BECOME AN EMPTY LIMIT. The book has a row for
  // this fish here and it could not be served -- written for another kind of water, or cut by
  // the grid. Shaped as `limits` it would print "no stated size limit / no stated creel limit",
  // which is the one reading it must never have: an unstatable rule rendered as no rule.
  const limits = live && live.scope !== 'none' && live.scope !== 'withheld'
    ? { sizeLimit: live.sizeLimit, creelLimit: live.creelLimit, scope: live.scope,
        species: live.species, state: live.state, fromBook: !!live.fromBook,
        // NAME THE SOURCE THAT ACTUALLY ANSWERED. The book cites a page and the digest does not,
        // and a person checking a limit needs to know which one they are checking.
        source: live.fromBook
          ? `${live.source || 'the state book'}${live.page ? `, p.${live.page}` : ''}`
          : `${live.state || 'state'} regulations digest`,
        addressIsAReach: !!live.addressIsAReach }
    : null;

  // THE BOOKS COME FIRST, AND THEY CAN SAY NO.
  //
  // Until now `legal: false` came only from REGULATIONS below -- six hand-typed waters against
  // 448 that got "we do not know" and displayed nothing. registry/regulations.json is the same
  // law parsed offline from the state digests with no LLM in the path, and it reaches 74 waters
  // so far, Lake Marion and Lake Moultrie among them. Marion is the case that matters: its
  // striped bass closure is real, the research pipeline lost it entirely, and the hand table is
  // the only reason the app knew about it.
  //
  // Only `all_fishing` and `harvest` block. A method closure warns and does not stop a trip.
  const books = state ? closuresFor(state, lakeName, species, date) : null;
  const bookWarnings = [];
  if (books && books.blocking && books.blocking.length) {
    const c = books.blocking[0];
    const when = c.start && c.end ? ` (${c.start} to ${c.end})` : '';
    const who = c.applies_to === 'all_fishing' ? 'This water is closed' : `${species} harvest is closed`;
    return {
      legal: false,
      reason: `${who}${when}: "${c.text}"`,
      regInfo: null,
      limits,
      // THE OTHER BLOCKING ROWS ARE NOT REDUNDANT. Lake Edwin B. Johnson carries two:
      // `Closed to Boating and Fishing` and `Closed to Boating and Fishing until July 1, 2027`.
      // Only the second one says when it reopens, and reporting the first alone throws that
      // away. Everything the books put on this water and this fish on this day gets said.
      warnings: [
        ...books.blocking.slice(1).map((w) => `Also in effect: "${w.text}"`),
        ...books.warnings.map((w) => `Also in effect: "${w.text}"`),
      ],
      source: c.source || 'state regulations book',
    };
  }
  if (books && books.warnings && books.warnings.length) {
    for (const w of books.warnings) bookWarnings.push(`In effect here: "${w.text}"`);
  }
  if (books && books.error) {
    bookWarnings.push('Closure data could not be read for this water — verify before you keep one.');
  }

  {
    const warnings = [];
    // A RULE THAT EXISTS AND CANNOT BE STATED IS THE LOUDEST THING HERE, so it is said first and
    // nothing below it gets to answer instead.
    if (live && live.scope === 'withheld') {
      warnings.push(`${species} on ${lakeName}: the ${live.state || 'state'} book has a rule for `
        + `this fish that does not apply here as written — ${live.why}. No limit is published for `
        + `this water. Check with the state before you keep one.`);
    } else if (limits) {
      warnings.push(`${species} on ${lakeName}: ${limits.scope === 'lake' ? 'lake-specific' : 'statewide'} `
        + `limits are ${limits.sizeLimit || 'no stated size limit'} / `
        + `${limits.creelLimit || 'no stated creel limit'} (${limits.source})`
        + (limits.addressIsAReach
            ? '. The book addresses a stretch of this water, not all of it — check you are on it'
            : '')
        + `. No closure information for this water — verify before you keep one.`);
    } else if (live) {
      warnings.push(`The ${live.state || 'state'} digest was read and lists nothing for ${species} `
        + `on ${lakeName}. Verify before you keep one.`);
    } else {
      warnings.push(`No regulation data for ${lakeName} — verify with the state before you keep one.`);
    }
    return { legal: true, reason: null, regInfo: null, limits,
             warnings: [...bookWarnings, ...warnings], note: warnings[0] };
  }
}

// SPECIES_BEHAVIOR and getBehaviorV1Compat were deleted 2026-08-20.
//
// The table was TWO waters, Wateree and Murray, hand-written, and its only consumer was
// smart-plan.js -- v1, unreachable since v2 shipped and deleted the same day. V2 below is
// keyed by SPECIES, and plan-inputs.js depthBandFor() already reads the lake's own
// researched profile first and falls back to it, labelling which answer it used in
// `source`. That cascade is the expandable mechanism; the hand-written floor beneath it
// does not need a second, smaller, staler copy.
//
// getBehaviorV1Compat() was written to unify the two and had zero callers from the day
// it was written.
// ── SPECIES BEHAVIOR V2 ──────────────────────────────────
const baseSCReservoir = (overrides = {}) => ({
  preferredMethod: 'trolling',
  waterClarity: ['clear', 'stained'],
  reactionStrike: false,
  rodArchitecture: 'M/MH Spinning / 30lb braid + 20lb fluoro leader',
  confidence: { source: 'Literature', evidence: ['SCDNR / guide reports'] },
  ...overrides
});

export const SPECIES_BEHAVIOR_V2 = {
  'Striped Bass': {
    'Lake Wateree': {
      summer: baseSCReservoir({
        preferredStructure: ['channel_ledge', 'humps', 'creek_channel_swing', 'bridge', 'main_lake_points'],
        preferredPresentation: ['umbrella_rig_medium', 'deep_diving_crankbait', 'flutter_spoon', 'bucktail'],
        lureFamilies: ['A-Rig', 'Deep Crankbait', 'Flutter Spoon', 'Bucktail'],
        preferredColors: ['Blueback Herring', 'Pearl', 'Sexy Shad', 'Chrome'],
        preferredDepth: (tempF) => tempF > 84 ? [14, 16] : [10, 16],
        preferredSpeed: [1.8, 2.5],
        leadDistance: [45, 80],
        reactionStrike: true,
        forage: ['threadfin_shad', 'blueback_herring'],
        confidence: { source: 'Field Validated', evidence: ['Carolina Sportsman guide interviews – Heinning, Whiteside', 'Repeated catches by user – Wateree trolling'] },
        notes: [
          'Thermocline typically 18-24ft on Wateree in July (shallower Jun, deeper Aug)',
          'Dawn window: channel-adjacent ledges — fish near surface first 60min of light',
          'Mid-morning: fish drop to thermocline edge — use electronics to find suspended fish',
          'Umbrella rig 1/4oz jigheads + 4-5" trailers — match shad size',
          'Flutter spoon 3/4oz + 2oz torpedo — vertical jigging or slow troll',
        ]
      }),
      fall: baseSCReservoir({
        preferredStructure: ['creek_mouth', 'channel_edge', 'secondary_points'],
        preferredPresentation: ['medium_crankbait', 'umbrella_rig_medium', 'bucktail'],
        lureFamilies: ['Medium Crankbait', 'A-Rig', 'Bucktail'],
        preferredDepth: [10, 20],
        preferredSpeed: [1.8, 2.2],
        notes: ['Shad migration – fish push shallower as water cools', 'Schooling action common dusk/dawn']
      }),
      winter: baseSCReservoir({
        preferredStructure: ['channel', 'deep_humps', 'bridge_pilings'],
        preferredPresentation: ['jigging_spoon', 'bucktail_slow', 'live_shad_downline'],
        lureFamilies: ['Flutter Spoon', 'Hair Jig'],
        preferredDepth: [15, 30],
        preferredSpeed: [1.0, 1.5],
        reactionStrike: false,
        notes: ['Slower presentation – suspended deeper – use electronics']
      }),
      spring: baseSCReservoir({
        preferredStructure: ['points', 'creek_mouths', 'flats_near_channel'],
        preferredPresentation: ['topwater_walker', 'medium_crankbait', 'swimbait_jighead', 'live_herring_freeline'],
        lureFamilies: ['Topwater', 'Medium Crankbait', 'Swimbait'],
        preferredDepth: [5, 15],
        preferredSpeed: [1.5, 2.0],
        notes: ['Pre/post spawn shallow push']
      }),
      fallbackPresentation: ['jigging_spoon_vertical', 'live_bait_downline']
    },
    'Lake Murray': {
      summer: baseSCReservoir({
        preferredStructure: ['thermocline_30ft', 'dam_basin', 'humps', 'channel_ledges'],
        preferredPresentation: ['umbrella_rig', 'live_herring_downline', 'flutter_spoon'],
        lureFamilies: ['A-Rig', 'Flutter Spoon'],
        preferredDepth: [28, 36],
        preferredSpeed: [1.2, 1.8],
        notes: ['Two groups: suspended near 30ft thermocline, and deep/bottom 70-100ft near dam', 'Free-line one rod early, topwater other – both kayak fishable']
      }),
      spring: baseSCReservoir({
        preferredStructure: ['creek_backs', 'shallow_points', 'buffalo_creek_mouth', 'rocky_creek_mouth'],
        preferredPresentation: ['casting_plug', 'a_rig_light', 'fluke', 'free_line_herring'],
        lureFamilies: ['Medium Crankbait', 'A-Rig Light', 'Fluke'],
        preferredDepth: [3, 15],
        preferredSpeed: [1.5, 1.8],
        notes: ['Herring spawn Apr-May – Buffalo/Rocky Creek mouths key']
      }),
      fall: baseSCReservoir({ preferredStructure: ['creek_mouths', 'points'], preferredPresentation: ['a_rig_medium', 'crankbait'], lureFamilies: ['A-Rig', 'Crankbait'], preferredDepth: [10, 25], preferredSpeed: [1.5, 2.0] }),
      winter: baseSCReservoir({ preferredStructure: ['upper_lake', 'channel'], preferredPresentation: ['live_shad', 'jigging_spoon'], lureFamilies: ['Flutter Spoon'], preferredDepth: [15, 30], preferredSpeed: [1.0, 1.3], notes: ['Follow threadfin shad upper lake'] }),
    },
    'Lake Marion': {
      summer: baseSCReservoir({ preferredStructure: ['pinopolis_dam', 'deep_holes_40_55ft'], preferredPresentation: ['live_herring_downline', 'bucktail'], lureFamilies: ['Bucktail', 'Live Bait'], preferredDepth: [40, 55], preferredSpeed: [1.0, 1.5], notes: ['VERIFY SEASON – CLOSED Jun16-Sep30 Santee system'], confidence: { source: 'Regulation Critical', evidence: ['SCDNR Santee Cooper closure'] } }),
      winter: baseSCReservoir({ preferredStructure: ['humps', 'ledges'], preferredPresentation: ['bucktail_jig', 'rockport_rattler', 'live_blueback_herring'], lureFamilies: ['Bucktail', 'Hair Jig'], preferredDepth: [20, 50], preferredSpeed: [1.2, 1.5], notes: ['December prime – vary jig color chartreuse/white – mark fish, drop slightly above'] }),
      fall: baseSCReservoir({ preferredStructure: ['open_water_schools', 'points'], preferredPresentation: ['bucktail', 'jig_plastic_trailer', 'topwater'], lureFamilies: ['Bucktail', 'Topwater'], preferredDepth: [20, 40], preferredSpeed: [1.5, 1.8] }),
      spring: baseSCReservoir({ preferredStructure: ['congaree_river_run', 'wateree_river_run', 'diversion_canal', 'deep_holes'], preferredPresentation: ['live_herring', 'cut_bait'], lureFamilies: ['Live Bait'], preferredDepth: [10, 30], preferredSpeed: [1.0, 1.3], notes: ['Spawning run – fish concentrated'] }),
    },
    'Lake Moultrie': {
      summer: baseSCReservoir({ preferredStructure: ['pinopolis_dam', 'open_water_40_50ft'], preferredPresentation: ['topwater_dawn', 'bucktail', 'live_herring_bottom'], lureFamilies: ['Topwater', 'Bucktail', 'Live Bait'], preferredDepth: [40, 50], preferredSpeed: [1.2, 1.5], notes: ['CLOSED Jun16-Sep30 – verify'] }),
      winter: baseSCReservoir({ preferredStructure: ['dam_area', 'humps'], preferredPresentation: ['bucktail_jig', 'live_menhaden'], lureFamilies: ['Bucktail'], preferredDepth: [20, 50], preferredSpeed: [1.2, 1.5], notes: ['Menhaden migrate via lock/fish lift – 3-finger size preferred'] }),
      fall: baseSCReservoir({ preferredStructure: ['ledges', 'points'], preferredPresentation: ['bucktail', 'live_herring_downline'], preferredDepth: [20, 40], preferredSpeed: [1.2, 1.5] }),
      spring: baseSCReservoir({ preferredStructure: ['pre_spawn_staging', 'diversion_canal_approach'], preferredPresentation: ['live_herring'], preferredDepth: [10, 30], preferredSpeed: [1.0, 1.3] }),
    }
  },
  'Largemouth Bass': {
    'default_SC_reservoir': {
      spring: baseSCReservoir({
        preferredStructure: ['secondary_points', 'creek_arms', 'laydowns', 'docks', 'grass_edge', 'riprap'],
        preferredPresentation: ['medium_crankbait', 'spinnerbait', 'chatterbait', 'swimbait_jighead'],
        lureFamilies: ['Medium Crankbait', 'Spinnerbait', 'Chatterbait', 'Swimbait'],
        preferredColors: ['Sexy Shad', 'Chartreuse/White', 'Firetiger', 'Bluegill'],
        preferredDepth: [4, 12],
        preferredSpeed: [1.8, 2.4],
        leadDistance: [40, 65],
        reactionStrike: true,
        forage: ['bluegill', 'shad', 'crawfish'],
        notes: ['Troll secondary points and creek channel swings – cover water', 'Deflection off wood/rock triggers reaction'],
        fallbackPresentation: ['texas_rig', 'wacky_rig', 'jig_n_pig']
      }),
      summer: baseSCReservoir({
        preferredStructure: ['offshore_humps', 'deep_points', 'dock_shade', 'grass_lines', 'bridge_pilings'],
        preferredPresentation: ['deep_crankbait', 'swimbait_jighead', 'spinnerbait_slow'],
        lureFamilies: ['Deep Crankbait', 'Swimbait', 'Spinnerbait'],
        preferredDepth: [8, 18],
        preferredSpeed: [1.6, 2.2],
        notes: ['Early/late low-light topwater window – buzzbait / walker trolled with popping cork', 'Mid-day deep – 10-18ft']
      }),
      fall: baseSCReservoir({
        preferredStructure: ['creek_mouths', 'flats', 'points', 'bait_schools'],
        preferredPresentation: ['lipless_crankbait', 'spinnerbait', 'medium_crankbait', 'chatterbait'],
        lureFamilies: ['Lipless Crankbait', 'Spinnerbait', 'Chatterbait'],
        preferredDepth: [3, 10],
        preferredSpeed: [2.0, 2.6],
        reactionStrike: true,
        notes: ['Bait migration – aggressive chasing – faster troll effective']
      }),
      winter: baseSCReservoir({
        preferredStructure: ['channel_bluffs', 'deep_docks', 'bridge', 'steep_points'],
        preferredPresentation: ['jigging_spoon_slow', 'swimbait_slow_roll', 'hair_jig'],
        lureFamilies: ['Flutter Spoon', 'Swimbait', 'Hair Jig'],
        preferredDepth: [12, 25],
        preferredSpeed: [1.2, 1.6],
        reactionStrike: false,
        notes: ['Slow down – vertical capable but troll slow along bluff walls'],
        fallbackPresentation: ['ned_rig', 'drop_shot', 'jig_n_pig']
      })
    }
  },
  'White Bass / Hybrid': {
    'default_SC_reservoir': {
      spring: baseSCReservoir({
        preferredStructure: ['wind_blown_points', 'river_runs', 'creek_mouths', 'shoals'],
        preferredPresentation: ['inline_spinner', 'small_crankbait', 'road_runner', 'swimbait_3in'],
        lureFamilies: ['Inline Spinner', 'Road Runner', 'Small Crankbait', 'Swimbait'],
        preferredDepth: [4, 12],
        preferredSpeed: [2.0, 2.8],
        reactionStrike: true,
        notes: ['Schooling – when you find one, circle/work area – aggressive chasers – perfect trolling target'],
        confidence: { source: 'Field Validated', evidence: ['SC reservoir schooling behavior – user validated'] }
      }),
      summer: baseSCReservoir({
        preferredStructure: ['main_lake_humps', 'channel_edges', 'open_water_bait'],
        preferredPresentation: ['small_flutter_spoon', 'inline_spinner', 'small_crankbait'],
        preferredDepth: [12, 25],
        preferredSpeed: [2.0, 2.6]
      }),
      fall: { preferredStructure: ['creek_mouths', 'points'], preferredPresentation: ['inline_spinner', 'lipless_crankbait'], preferredDepth: [5, 15], preferredSpeed: [2.2, 2.8] },
      winter: { preferredStructure: ['deep_channel', 'river_bends'], preferredPresentation: ['jigging_spoon', 'hair_jig'], preferredDepth: [20, 35], preferredSpeed: [1.2, 1.6], reactionStrike: false }
    }
  },
  'Crappie': {
    'default_SC_reservoir': {
      spring: baseSCReservoir({
        preferredMethod: 'trolling',
        preferredStructure: ['brush_piles', 'docks', 'laydowns', 'bridge_pilings', 'stake_beds'],
        preferredPresentation: ['road_runner', 'hair_jig', 'small_swimbait_jighead', 'trolling_spider_rig_slow'],
        lureFamilies: ['Road Runner', 'Hair Jig', 'Small Swimbait'],
        preferredColors: ['Chartreuse/White', 'Pink/White', 'Monkey Milk', 'Electric Chicken'],
        preferredDepth: [3, 8],
        preferredSpeed: [0.8, 1.4],
        leadDistance: [25, 50],
        reactionStrike: false,
        notes: ['Slow troll – 0.8-1.3mph ideal – brush pile hopping – use 2 rods staggered depth', 'Best SC trolling crappie technique – long line road runners'],
        fallbackPresentation: ['vertical_jig', 'slip_float']
      }),
      summer: baseSCReservoir({ preferredStructure: ['deep_brush', 'bridge', 'timber', 'channel_edges'], preferredPresentation: ['hair_jig', 'road_runner_deep'], preferredDepth: [12, 22], preferredSpeed: [0.7, 1.2] }),
      fall: baseSCReservoir({ preferredStructure: ['docks', 'brush', 'creek_channels'], preferredPresentation: ['road_runner', 'hair_jig'], preferredDepth: [6, 14], preferredSpeed: [0.9, 1.4] }),
      winter: baseSCReservoir({ preferredStructure: ['deep_brush', 'bridge_pilings', 'standing_timber'], preferredPresentation: ['hair_jig_vertical', 'small_spoon'], preferredDepth: [15, 28], preferredSpeed: [0.5, 1.0], notes: ['Near-vertical slow troll / controlled drift'] })
    }
  },
  'Blue Catfish': {
    'default_SC_reservoir': {
      summer: baseSCReservoir({
        preferredMethod: 'trolling',
        preferredStructure: ['channel_ledges', 'humps', 'deep_flats', 'river_channel'],
        preferredPresentation: ['santee_cooper_rig_dragging', 'cut_bait_slow_troll', 'deep_diving_crankbait_incidental'],
        lureFamilies: ['Cut Bait', 'Santee Rig'],
        preferredDepth: [15, 35],
        preferredSpeed: [0.5, 1.0],
        notes: ['Slow drift / slow troll dragging cut shad / herring – Santee Cooper rig – 0.5-0.8mph – rod holders – clickers on', 'Santee Cooper lakes (Marion/Moultrie) = world class blue cats'],
        reactionStrike: false,
        fallbackPresentation: ['anchor_cut_bait']
      }),
      spring: baseSCReservoir({ preferredStructure: ['flats_near_channel', 'creek_mouths'], preferredPresentation: ['cut_bait_dragging'], preferredDepth: [8, 20], preferredSpeed: [0.4, 0.8] }),
      fall: baseSCReservoir({ preferredStructure: ['channel_edges', 'humps'], preferredPresentation: ['cut_bait_dragging'], preferredDepth: [15, 30], preferredSpeed: [0.5, 0.9] }),
      winter: baseSCReservoir({ preferredStructure: ['deep_holes', 'channel_bends', 'dam_area'], preferredPresentation: ['cut_bait_anchor', 'slow_drag'], preferredDepth: [25, 55], preferredSpeed: [0.3, 0.6] })
    }
  },
  'Channel Catfish': {
    'default_SC_reservoir': {
      spring: baseSCReservoir({ preferredStructure: ['flats', 'creek_mouths', 'riprap'], preferredPresentation: ['santee_rig_dragging', 'spinnerbait_slow_incidental', 'crankbait_incidental'], preferredDepth: [4, 14], preferredSpeed: [0.6, 1.2], notes: ['Channel cats will absolutely crush trolled crankbaits / spinnerbaits – more aggressive than blues'] }),
      summer: baseSCReservoir({ preferredStructure: ['channel_edges', 'flats'], preferredPresentation: ['cut_bait_dragging'], preferredDepth: [10, 25], preferredSpeed: [0.5, 1.0] }),
      fall: baseSCReservoir({ preferredStructure: ['points', 'flats'], preferredPresentation: ['cut_bait_dragging', 'crankbait'], preferredDepth: [6, 18], preferredSpeed: [0.8, 1.3] }),
      winter: baseSCReservoir({ preferredStructure: ['deep_holes'], preferredPresentation: ['cut_bait_anchor'], preferredDepth: [20, 40], preferredSpeed: [0.3, 0.6] })
    }
  },
  'Flathead Catfish': {
    'default_SC_reservoir': {
      spring: baseSCReservoir({ preferredMethod: 'anchor/finesse', preferredStructure: ['wood', 'timber', 'boulders', 'bridge_pilings'], preferredPresentation: ['live_bluegill', 'live_bream'], preferredDepth: [5, 20], preferredSpeed: [0, 0.3], notes: ['Flatheads = live bait ambush – not a primary trolling target – included for completeness – set live bluegill on Santee rig and SLOW drift 0.2-0.4mph max at night'], reactionStrike: false, fallbackPresentation: ['anchor_live_bait_night'] }),
      summer: baseSCReservoir({ preferredStructure: ['deep_wood', 'timber', 'ledges'], preferredPresentation: ['live_bream', 'live_shad'], preferredDepth: [12, 30], preferredSpeed: [0, 0.4] }),
      fall: baseSCReservoir({ preferredStructure: ['wood', 'channel_bends'], preferredPresentation: ['live_bait'], preferredDepth: [10, 25], preferredSpeed: [0, 0.4] }),
      winter: baseSCReservoir({ preferredStructure: ['deep_holes', 'timber'], preferredPresentation: ['live_bait_slow'], preferredDepth: [25, 45], preferredSpeed: [0, 0.3] })
    }
  },
  'Bowfin': {
    'default_SC_reservoir': {
      spring: baseSCReservoir({
        preferredStructure: ['lily_pads', 'grass_edge', 'wood', 'backwater_slough', 'creek_mouth', 'cypress_knees'],
        preferredPresentation: ['medium_diving_crankbait', 'deep_diving_crankbait', 'spinnerbait', 'chatterbait', 'paddle_tail'],
        lureFamilies: ['Medium Crankbait', 'Deep Crankbait', 'Spinnerbait', 'Chatterbait', 'Paddle Tail', 'Swim Jig'],
        preferredColors: ['Firetiger', 'Chartreuse/White', 'Black/Blue', 'White'],
        preferredDepth: [4, 10],
        preferredSpeed: [1.4, 2.0],
        leadDistance: [35, 55],
        reactionStrike: true,
        waterClarity: ['stained', 'dirty'],
        forage: ['bluegill', 'shad', 'crawfish'],
        confidence: { source: 'Field Validated', evidence: ['Repeated catches by user trolling crankbaits – SC reservoirs', '31 of 47 bowfin caught trolling medium/deep diving crankbaits'] },
        notes: ['Highly aggressive reaction feeder – will chase moving lures farther than most anglers expect', 'Excellent trolling target around submerged vegetation and wood', 'Often strikes diving crankbaits intended for striped bass', 'Do NOT sit – cover water – move pocket to pocket', 'User-validated: medium/deep diving crankbaits OUTPERFORM frogs/spinnerbaits for trolling bowfin in SC'],
        fallbackPresentation: ['topwater_frog_casting', 'swim_jig_pitch']
      }),
      summer: baseSCReservoir({ preferredStructure: ['grass_mats', 'lily_pads', 'shaded_wood', 'backwater'], preferredPresentation: ['spinnerbait', 'chatterbait', 'paddle_tail', 'buzzbait'], preferredDepth: [2, 8], preferredSpeed: [1.3, 1.8], notes: ['Low light / shade – thick vegetation edges'] }),
      fall: baseSCReservoir({ preferredStructure: ['grass_edge', 'wood', 'creek_backs'], preferredPresentation: ['spinnerbait', 'medium_crankbait', 'chatterbait'], preferredDepth: [3, 9], preferredSpeed: [1.5, 2.0] }),
      winter: baseSCReservoir({ preferredStructure: ['deep_sloughs', 'canal_bends', 'warm_water_discharge'], preferredPresentation: ['slow_roll_spinnerbait', 'jig_n_pig'], preferredDepth: [6, 14], preferredSpeed: [1.0, 1.4], reactionStrike: false })
    }
  },
  'Chain Pickerel': {
    'default_SC_reservoir': {
      spring: baseSCReservoir({
        preferredStructure: ['grass_edge', 'lily_pads', 'wood', 'docks', 'creek_backs'],
        preferredPresentation: ['inline_spinner', 'spinnerbait', 'jerkbait_trolled_slow', 'paddle_tail'],
        lureFamilies: ['Inline Spinner', 'Spinnerbait', 'Jerkbait', 'Paddle Tail'],
        preferredColors: ['Firetiger', 'Gold', 'Silver/Black', 'Chartreuse'],
        preferredDepth: [3, 8],
        preferredSpeed: [1.6, 2.2],
        leadDistance: [40, 60],
        reactionStrike: true,
        notes: ['Ambush – vegetation edges – likes flash/vibration – wire leader recommended – will absolutely crush trolled spinnerbaits'],
        fallbackPresentation: ['jerkbait_cast', 'inline_spinner_cast']
      }),
      summer: baseSCReservoir({ preferredStructure: ['deep_grass_edge', 'shade', 'docks'], preferredPresentation: ['spinnerbait', 'paddle_tail'], preferredDepth: [5, 12], preferredSpeed: [1.5, 2.0] }),
      fall: baseSCReservoir({ preferredStructure: ['grass', 'wood', 'points'], preferredPresentation: ['spinnerbait', 'jerkbait', 'inline_spinner'], preferredDepth: [3, 9], preferredSpeed: [1.8, 2.3], reactionStrike: true }),
      winter: baseSCReservoir({ preferredStructure: ['deep_vegetation_edge', 'canals', 'warm_pockets'], preferredPresentation: ['jerkbait_slow', 'hair_jig'], preferredDepth: [6, 14], preferredSpeed: [1.2, 1.6], reactionStrike: false })
    }
  },
  'Red Drum (Redfish)': {
    'Coastal SC Inshore': {
      spring: baseSCReservoir({
        preferredMethod: 'trolling',
        preferredStructure: ['oyster_bars', 'creek_mouths', 'grass_edges', 'dock_pilings', 'channel_edges'],
        preferredPresentation: ['paddle_tail_jighead_trolled', 'gold_spoon_slow', 'swimbait'],
        lureFamilies: ['Paddle Tail', 'Gold Spoon', 'Swimbait', 'Gulp Shrimp'],
        preferredColors: ['Rootbeer/Gold', 'New Penny', 'White', 'Chartreuse'],
        preferredDepth: [2, 6],
        preferredSpeed: [1.2, 2.0],
        leadDistance: [30, 50],
        waterClarity: ['clear', 'stained'],
        forage: ['mullet', 'shrimp', 'crab', 'mud_minnows'],
        notes: ['Slow troll creek edges and oyster bar drop-offs – 1.2-1.8mph – popping cork with live shrimp/mullet also deadly', 'Incoming tide – push up onto flats – outgoing – stage at creek mouths'],
        confidence: { source: 'Literature + Inshore Guide Consensus', evidence: ['SCDNR inshore creel', 'Charleston inshore guide reports'] },
        fallbackPresentation: ['popping_cork_live_shrimp', 'cut_mullet_bottom']
      }),
      summer: baseSCReservoir({ preferredStructure: ['grass_flats', 'docks_shade', 'oyster_rakes'], preferredPresentation: ['paddle_tail', 'topwater_early', 'gold_spoon'], preferredDepth: [1, 5], preferredSpeed: [1.0, 1.8], notes: ['Early morning topwater – flood tide tailing'] }),
      fall: baseSCReservoir({ preferredStructure: ['creek_mouths', 'jetties', 'oyster_bars', 'beach_troughs'], preferredPresentation: ['mullet_imitation_swimbait', 'gold_spoon', 'paddle_tail', 'cut_mullet'], lureFamilies: ['Swimbait', 'Gold Spoon', 'Paddle Tail'], preferredDepth: [2, 8], preferredSpeed: [1.4, 2.2], reactionStrike: true, notes: ['Fall bull red run – big mullet pattern – gold spoon / mullet swimbait trolled along beach troughs and inlet edges – PRIME TIME'] }),
      winter: baseSCReservoir({ preferredStructure: ['deep_holes', 'creek_bends', 'dock_pilings', 'warm_water_discharge'], preferredPresentation: ['gulp_shrimp_slow', 'paddle_tail_slow'], preferredDepth: [4, 12], preferredSpeed: [0.8, 1.3], reactionStrike: false, notes: ['Schools stacked deep – slow and subtle'] })
    }
  },
  'Speckled Trout (Spotted Seatrout)': {
    'Coastal SC Inshore': {
      spring: baseSCReservoir({
        preferredMethod: 'trolling',
        preferredStructure: ['grass_edges', 'oyster_bars', 'creek_mouths', 'dock_lights', 'drop_offs'],
        preferredPresentation: ['paddle_tail_jighead', 'mirrodine_twitch_trolled', 'gulp_shrimp_popping_cork'],
        lureFamilies: ['Paddle Tail', 'Twitchbait', 'Gulp Shrimp'],
        preferredColors: ['Opening Night', 'New Penny', 'Pearl/Chartreuse', 'Electric Chicken'],
        preferredDepth: [2, 6],
        preferredSpeed: [1.0, 1.8],
        leadDistance: [30, 50],
        notes: ['Troll grass edges and oyster bar drop-offs slow – 1.0-1.5mph – trout suspend – keep bait ABOVE them', 'Popping cork with live shrimp / Voodoo shrimp deadly – can slow-troll corks'],
        fallbackPresentation: ['popping_cork_live_shrimp', 'twitchbait_cast']
      }),
      summer: baseSCReservoir({ preferredStructure: ['deep_grass_edges', 'channel_drop_offs', 'bridge_pilings', 'dock_lights_night'], preferredPresentation: ['paddle_tail', 'gulp_shrimp'], preferredDepth: [4, 10], preferredSpeed: [0.9, 1.5] }),
      fall: baseSCReservoir({ preferredStructure: ['creek_mouths', 'oyster_bars', 'flats'], preferredPresentation: ['paddle_tail', 'mirrodine', 'topwater_early'], preferredDepth: [2, 6], preferredSpeed: [1.2, 1.8], reactionStrike: true, notes: ['Fall feed – aggressive – shrimp migration'] }),
      winter: baseSCReservoir({ preferredStructure: ['deep_holes', 'canals', 'warm_water_discharge', 'creek_bends'], preferredPresentation: ['mirrolure_slow_suspend', 'gulp_shrimp_slow'], preferredDepth: [6, 14], preferredSpeed: [0.6, 1.2], reactionStrike: false, notes: ['Cold-stun risk – check SCDNR closures – very slow presentation'] })
    }
  },
  'Bluegill': {
    default_SC_reservoir: {
      spring: {
        preferredStructure: ['shoreline_flats', 'dock_edges', 'submerged_vegetation', 'gravel_beds'],
        preferredPresentation: ['lipless_crankbait', 'inline_spinner', 'road_runner'],
        lureFamilies: ['lipless crankbait', 'inline spinner', 'road runner'],
        preferredDepth: [1, 6],
        preferredSpeed: [0.8, 1.3],
        leadDistance: [20, 35],
        preferredColors: ['Bright', 'chartreuse/white'],
        notes: ['Slow, tight shoreline pass — hug the bank edge · 2" lipless crank proven at Prestwood · Spawning beds = gravel/hard bottom shallow', 'Speed at low end of range — fast enough to deflect off bottom structure, slow enough for short-striking fish'],
        confidence: { source: 'Angler-confirmed – Prestwood Lake SC 2024-2026', level: 'high' },
        reactionStrike: true,
      },
      summer: {
        preferredStructure: ['dock_shade', 'deeper_vegetation_edge', 'channel_adjacent_flats'],
        preferredPresentation: ['road_runner', 'inline_spinner', 'lipless_crankbait'],
        lureFamilies: ['road runner', 'inline spinner'],
        preferredDepth: [3, 10],
        preferredSpeed: [0.7, 1.1],
        leadDistance: [25, 40],
        notes: ['Move slightly deeper in heat — follow shaded dock edges · Early morning shoreline bite goes fast, transitions deeper by 9am'],
        confidence: { source: 'Standard SC panfish summer pattern', level: 'medium' },
        reactionStrike: true,
      },
      fall: {
        preferredStructure: ['shoreline_flats', 'points', 'vegetation_edges'],
        preferredPresentation: ['lipless_crankbait', 'inline_spinner'],
        lureFamilies: ['lipless crankbait', 'inline spinner'],
        preferredDepth: [2, 8],
        preferredSpeed: [0.9, 1.4],
        leadDistance: [20, 35],
        notes: ['Fall = active feeding push — slightly faster retrieve than summer · Follow shoreline contours around points'],
        confidence: { source: 'Standard SC panfish fall pattern', level: 'medium' },
        reactionStrike: true,
      },
      winter: {
        preferredStructure: ['deep_flats', 'channel_adjacent', 'sunny_shallows_midday'],
        preferredPresentation: ['road_runner', 'lipless_crankbait'],
        lureFamilies: ['road runner', 'lipless crankbait'],
        preferredDepth: [4, 12],
        preferredSpeed: [0.6, 0.9],
        leadDistance: [30, 45],
        notes: ['Slow way down — cold water fish much less aggressive · Midday sun-warmed shallows worth checking · Road Runner jig works well at low speed'],
        confidence: { source: 'Standard SC panfish winter pattern', level: 'medium' },
        reactionStrike: false,
      },
    },
  },
  'Redear Sunfish (Shellcracker)': {
    default_SC_reservoir: {
      spring: {
        preferredStructure: ['hard_bottom_flats', 'shell_substrate', 'dock_edges', 'gravel_beds'],
        preferredPresentation: ['lipless_crankbait', 'road_runner', 'inline_spinner'],
        lureFamilies: ['lipless crankbait', 'road runner'],
        preferredDepth: [2, 8],
        preferredSpeed: [0.8, 1.2],
        leadDistance: [20, 35],
        preferredColors: ['Bright', 'chartreuse/white'],
        notes: ['Shellcracker key = hard bottom – shell/gravel substrate preferred over soft mud · Spring spawn in deeper structure than bluegill – 3-8ft · Lipless crank ticking bottom is the move'],
        confidence: { source: 'Angler-confirmed – Prestwood Lake SC', level: 'high' },
        reactionStrike: true,
      },
      summer: {
        preferredStructure: ['deeper_flats', 'channel_edges', 'dock_shade'],
        preferredPresentation: ['road_runner', 'lipless_crankbait'],
        lureFamilies: ['road runner', 'lipless crankbait'],
        preferredDepth: [5, 12],
        preferredSpeed: [0.7, 1.0],
        leadDistance: [30, 45],
        notes: ['Deeper than bluegill in summer – follow hard bottom into 8-12ft range'],
        confidence: { source: 'Standard SC shellcracker pattern', level: 'medium' },
        reactionStrike: true,
      },
      fall: {
        preferredStructure: ['flats', 'points', 'hard_bottom'],
        preferredPresentation: ['lipless_crankbait', 'inline_spinner'],
        lureFamilies: ['lipless crankbait'],
        preferredDepth: [3, 10],
        preferredSpeed: [0.8, 1.3],
        leadDistance: [25, 40],
        notes: ['Fall feeding push – similar to spring activity · Hard bottom flats near points'],
        confidence: { source: 'Standard SC shellcracker pattern', level: 'medium' },
        reactionStrike: true,
      },
      winter: {
        preferredStructure: ['deep_holes', 'channel_adjacent', 'hard_bottom_deep'],
        preferredPresentation: ['road_runner', 'lipless_crankbait'],
        lureFamilies: ['road runner'],
        preferredDepth: [8, 18],
        preferredSpeed: [0.5, 0.8],
        leadDistance: [35, 50],
        notes: ['Deepest of the panfish in winter – follow hard bottom to 10-18ft · Very slow presentation required'],
        confidence: { source: 'Standard SC shellcracker pattern', level: 'medium' },
        reactionStrike: false,
      },
    },
  }
};

console.log('[species-intel] Unified Trolling-First Multi-Species Brain loaded');
