/**
 * fishing-style-profile.js — Ryan's actual gear, platform, and technique
 * constraints, in one place so recommendation logic (species-intel.js,
 * smart-plan.js) can check against it instead of assuming.
 *
 * Companion to gear-autopilot.js (which stores the live motor/sonar
 * profile in IndexedDB) — this file is the static "how I actually fish"
 * profile: watercraft, rod count, technique preference, and live bait
 * reality, confirmed directly 2026-07-03.
 */

export const FISHING_STYLE = {
  watercraft: {
    make: 'Native Watercraft',
    model: 'Slayer Propel Max 12.5',
    drive: 'Propel Pedal Drive + NK180 trolling motor (bow-mounted)',
    maxRodsInWater: 2,
    hasBuiltInLivewell: false, // bow hatch is a bucket for gear/battery, not a livewell
  },

  // Trolling-first angler. Will fish topwater (cast or trolled with a
  // popping cork) when that's what's working, but the default/preferred
  // mode is trolling. No lead-core/line-counter reels — spinning only.
  primaryMethod: 'trolling',
  spinningOnly: true, // no lead-core trolling, no conventional/casting reels

  // Live bait reality, confirmed 2026-07-03:
  // - Freshwater (herring, shad, menhaden): NOT assumed available by
  //   default. No livewell on this kayak, herring/shad are fragile even
  //   with a portable aerated tank, and cast-netting for them from the
  //   kayak near where they're needed is not a safe plan. Only treat as
  //   available if explicitly toggled on for a specific trip (e.g. bait
  //   bought same-day from a shop that already has it in a tank).
  // - Saltwater (mullet, shrimp): assumed available by default — hardy
  //   enough for a standard bait bucket, easily bought at most coastal
  //   bait shops, no unsafe netting required.
  liveBait: {
    freshwater: false,
    saltwater: true,
  },
};

/**
 * True if a raw lure/technique string represents a live-bait presentation.
 * Mirrors the keyword set already used for static-technique classification
 * in smart-plan.js.
 */
export function isLiveBaitTechnique(rawLureName) {
  if (!rawLureName) return false;
  const s = rawLureName.toLowerCase();
  return s.includes('live') || s.includes('free-line') || s.includes('freeline')
    || s.includes('free line') || s.includes('downline') || s.includes('down-line')
    || s.includes('down line') || s.includes('cut bait');
}

/**
 * Heuristic: is a live-bait raw lure name a saltwater species (mullet,
 * shrimp, menhaden-in-saltwater-context) vs freshwater (herring, shad)?
 * species-intel.js is currently 100% SC freshwater lake content, so this
 * mostly matters once saltwater species/locations get added — kept simple
 * and named-species-based rather than trying to infer from context.
 */
const SALTWATER_BAIT_KEYWORDS = ['mullet', 'shrimp'];
export function isSaltwaterBait(rawLureName) {
  if (!rawLureName) return false;
  const s = rawLureName.toLowerCase();
  return SALTWATER_BAIT_KEYWORDS.some(k => s.includes(k));
}

/**
 * Should this live-bait lure be treated as actually available right now,
 * given the confirmed profile above? Non-live-bait lures always pass
 * through (this function is only meaningful for live-bait entries).
 */
export function isLiveBaitAvailable(rawLureName) {
  if (!isLiveBaitTechnique(rawLureName)) return true; // not live bait, n/a
  return isSaltwaterBait(rawLureName)
    ? FISHING_STYLE.liveBait.saltwater
    : FISHING_STYLE.liveBait.freshwater;
}
