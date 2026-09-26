/**
 * coastal-agents.js — what the coast needs from the research Worker that a lake does not.
 *
 * It held the saltwater research agents -- `estuary`, `tidal` and `saltwater_regulations` --
 * until 2026-09-25. All three were retired from the run on 2026-08-31 and nothing ran them after,
 * so their definitions went. What is left is the SC inshore roster floor and isCoastalZone().
 */

// COASTAL_AGENTS stood here: `estuary`, `tidal` and `saltwater_regulations`, retired from the
// run on 2026-08-31 (their fields had no reader outside the research pipeline, and no agent writes
// the law). Their definitions were deleted on 2026-09-25 -- nothing ran them -- and with them
// coastalAgentPlan() and COASTAL_SKIPPED_AGENTS, which only a test read.

/*
 * COASTAL_AGENT_HINTS MOVED TO water-type-hints.js ON 2026-09-03, and was dead when it moved.
 *
 * It was keyed on `habitat` and `biology`. Both agents were RETIRED on 2026-09-01, as
 * COASTAL_SKIPPED_AGENTS recorded until it went on 2026-09-25. agents.js looked the hint
 * up as COASTAL_AGENT_HINTS[agentKey] against the live agents, so it could not match anything,
 * and every coastal research pass ran the freshwater prompt.
 *
 * It is not in this file any more because rivers need the same treatment and a river hint does
 * not belong in coastal-agents.js. One table, keyed water type -> agent, in
 * Worker/research/water-type-hints.js.
 */

/**
 * THE SC INSHORE ROSTER. A DECISION, WRITTEN DOWN AS ONE.
 *
 * Ryan, 2026-09-02, asked for the basic predator list for South Carolina inshore:
 *
 *   > i would use this as the basic list of predator species for SC inshore... it covers
 *   > anything i am going to fish for on a regular basis
 *   > Red Drum (Redfish) / Spotted Seatrout (Speckled Trout) / Southern Flounder /
 *   > Black Drum / Sheepshead
 *
 * THESE FIVE NAMES WERE ALREADY IN THIS FILE AND HAD NO STANDING. COASTAL_AGENT_HINTS.biology
 * lists them (plus Tarpon) as "the predator species of interest", and that hint is all that ever
 * reached a profile: Murrells Inlet v8.0 carries exactly those five plus Cobia, with
 * `evidence.biology` an EMPTY OBJECT and `biology.notes` reading "Coastal estuary — saltwater
 * species baseline. Agents estuary/tidal/saltwater_regulations will refine." Those agents were
 * retired on 2026-08-31, so nothing ever refined it, and Cobia -- which is not an inshore fish
 * and is named by no fact in that profile -- arrived from nowhere and stayed.
 *
 * So the same five become a roster with a basis instead of a suggestion in a prompt. Three
 * things stand behind them, and none of them is a model:
 *
 *   SCDNR runs its trammel-net and electrofishing surveys "in every major South Carolina
 *   estuary" for red drum, seatrout and flounder -- its own 2025 Species Snapshots say so on
 *   page 2 of each. Presence of those three in an SC estuary is not a research question.
 *
 *   Black drum and sheepshead carry SC statewide saltwater size and creel limits in
 *   registry/regulations_table.json, parsed from SC Regs2627.pdf. A fish the state regulates
 *   inshore and every guide reports off dock pilings is not a fish whose presence needs a paper.
 *
 *   Ryan fishes this coast from a 12.5 ft kayak and named the five he targets.
 *
 * WHAT IT IS NOT is a survey of any one zone. The SCDNR species pages name no estuary at all --
 * checked, 2026-09-02, on dnr.sc.gov/marine/species/reddrum.html -- and the 176-page red drum
 * stock assessment names thirteen of them only as survey strata. So the evidence row this is
 * written with says FLOOR, in those words, and anything past these five needs a citation for
 * that particular water. Tarpon at Winyah, cobia off Port Royal and tripletail are exactly the
 * fish this list must not silently claim.
 *
 * GEORGIA IS NOT THIS LIST. Its WRD access layer marks 48 species per access point as Y/N
 * columns, and all four GA zones come back with the full inshore set when those points are
 * bound to the zone's own bbox. Derived beats declared where a feed exists.
 */
const SC_INSHORE_ROSTER = Object.freeze([
  'Red Drum (Redfish)',
  'Speckled Trout (Spotted Seatrout)',
  'Southern Flounder',
  'Black Drum',
  'Sheepshead',
]);

/**
 * The basis, carried with the roster so a reader never has to guess which of the two it is --
 * a measurement of this water, or a floor that applies to the whole coast.
 */
const SC_INSHORE_BASIS = 'SC inshore floor — SCDNR surveys every major South Carolina estuary '
  + 'for red drum, seatrout and flounder (2025 Species Snapshots); black drum and sheepshead '
  + 'carry SC statewide saltwater limits. Presence in THIS zone is not established by these '
  + 'sources; anything beyond these five needs a citation for this water.';

/** True when a research target is a coastal zone. */
function isCoastalZone(zoneKeyOrName) {
  return typeof zoneKeyOrName === 'string' && zoneKeyOrName.startsWith('coast_');
}

export {
  SC_INSHORE_ROSTER,
  SC_INSHORE_BASIS,
  isCoastalZone,
};
