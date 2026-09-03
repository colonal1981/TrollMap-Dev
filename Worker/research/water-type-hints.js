/**
 * water-type-hints.js — the framing a research agent gets for the KIND of water it is on.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT IN coastal-agents.js ANY MORE.
 *
 * `COASTAL_AGENT_HINTS` lived in coastal-agents.js and was keyed on `habitat` and `biology`. Both
 * of those agents were RETIRED on 2026-09-01. The live set is identity, navigation, regulations
 * and fisheries, and on a coastal zone `coastalAgentPlan()` returns exactly one of them:
 * `fisheries`. So the lookup in agents.js —
 *
 *     COASTAL_AGENT_HINTS[agentKey]
 *
 * could not match any agent that runs, and had not been able to since the retirement. **Every
 * coastal research pass has used the freshwater prompt.** The test that was supposed to cover it
 * asserted `agentsSrc.toContain('COASTAL_AGENT_HINTS[agentKey]')` — the string was there, so the
 * test was green for the whole time the feature was dead. A grep-characterisation test is not a
 * test; DELETION_TAB.md already lists that shape and this is what it costs.
 *
 * Two hints for two dead agents are one hint for the one live agent. That is the merge, and it is
 * why the coastal entry below reads as a single block rather than a structure half and a biology
 * half stapled together.
 *
 * RIVERS GET THE SAME MECHANISM RATHER THAN A SECOND ONE. Ryan, 2026-09-03: *"we also need river
 * prompts as well if we actually gathered enough information to make river research worth it"* —
 * the condition is his, and it was measured before this was written. See below.
 *
 * WHAT WE ACTUALLY HAVE PER RIVER, measured 2026-09-03 over the 58 `feature_type: 'river'` rows
 * in lake_index.json. The river hint names only things on this list:
 *
 *     58/58   chartpack -- contours, depth_areas, water_features, structure, water_graph,
 *             trolling_runs. 44 also carry docks. 28 of 58 are charted >= 50%.
 *     54/58   bound to USGS/NWPS gauges          51 a pool/stage gauge, 6 a tailwater gauge
 *     47/58   an NWM reach COMID, so discharge has a forecast and not just a reading
 *     29/58   in regulations_table.json by_water
 *     15/58   below a dam or carrying a Corps project
 *     11/58   a CO-OPS tide station: Cooper, Ashley, Waccamaw, Santee, Edisto, Black,
 *             Combahee, Great Pee Dee, Sampit, Chessie Creek, Black Mingo Creek
 *      8/58   Corps eHydro survey coverage
 *
 * SPECIES, CORRECTED 2026-09-03. This block first said "only 4 of 58 rivers have an agency page
 * and none carries a species list", and that was a single source counted as the whole picture --
 * nc_species_by_lake.json, 15 of 58. deterministic.js unions FIVE sources at request time, and
 * measured across all five, 50 of 58 rivers (86%) have a species list. Rivers are better covered
 * than lakes, which sit at 155 of 284 (55%):
 *
 *     32/58   ramp meta.species        28/58   regulations floor
 *     15/58   NC WRC list               3/58   an agency page
 *
 * The agency harvest IS lake-shaped -- 73 lakes against 3 rivers -- so the hint still does not
 * ask a river agent to reconcile against an agency page it will not be given. That part stands.
 *
 * THE EIGHT WITH NOTHING ARE A FEED SHAPE, NOT A RIVER PROBLEM. Only the `dnr` and `dnr_paddle`
 * ramp buckets carry species (554/875 and 332/412 rows); `natl`, `ncpaws` and `osm` carry none in
 * 2,814 rows between them. SC and GA publish species on their DNR ramps, NC and TN do not -- NC is
 * covered by the WRC list instead, and TWRA publishes reservoir pages and no river pages, so all
 * ten covered Tennessee waters are lakes and all five uncovered ones are rivers. The eight are
 * Clinch, Holston, Nolichucky (two reaches) and Pigeon in TN, First Broad in NC, and Saluda (2)
 * and Bates Old River in SC. WHAT_IS_ACTUALLY_MISSING_FOR_PREDATOR_SPECIES_2026-09-01.md already
 * recorded that no agency publishes a per-water roster for most of these; the fisheries agent is
 * the fallback there by design, not by omission.
 */

/**
 * Appended to an agent's system prompt when the water is of that type.
 *
 * Keyed `waterType -> agentKey`. A type with no entry, or an agent with no entry under its type,
 * gets the plain prompt — no framing is better than framing about the wrong kind of water.
 */
const WATER_TYPE_HINTS = {
  coastal: {
    fisheries:
      "\n\nCOASTAL ZONE — this is a tidal estuary, not a reservoir.\n" +
      "STRUCTURE: the elements that matter are Spartina marsh edges, oyster reefs and rakes, " +
      "tidal creek mouths and confluences, grass flat potholes, dock and pier pilings, inlet " +
      "throats and pinch points, channel edges and drop-offs, and shell rakes. Do NOT report " +
      "brush piles, standing timber, or man-made freshwater fish attractors unless a source " +
      "explicitly documents them. Note which structures are exposed at low tide versus " +
      "submerged at high tide.\n" +
      "SPECIES AND FORAGE: the predators of interest are Red Drum (Redfish), Spotted Seatrout " +
      "(Speckled Trout), Southern Flounder, Black Drum, Sheepshead and Tarpon. The forage base " +
      "is shrimp, mud minnows (mummichog), finger mullet, menhaden, blue crab and juvenile " +
      "spot/croaker — NOT threadfin or gizzard shad, blueback herring, or freshwater crayfish.\n" +
      "TIMING: note spawning and cold-stun timing. Seatrout are vulnerable to winter cold-stun " +
      "events, and red drum move to the inlets and nearshore to spawn in late summer and autumn. " +
      "The tide, not the calendar, decides which structure is fishable on a given hour.",
  },

  river: {
    fisheries:
      "\n\nRIVER — this is moving water, not an impoundment.\n" +
      "THE VARIABLE THAT GOVERNS IS DISCHARGE, not surface elevation. There is no full pool, no " +
      "guide curve and no drawdown here, and a river does not stratify — do NOT report a " +
      "thermocline, an anoxic layer, a pool elevation or a percentage of full pond. Where a " +
      "number is wanted for water level, it is flow in cfs and stage in feet against the gauge's " +
      "own action stage. The same river is different water at 200 cfs and at 6,000 cfs, and " +
      "anything seasonal you report should say which flow it assumes.\n" +
      "BELOW A DAM THE FLOW IS A SCHEDULE, NOT A SEASON. Where generation drives the reach, the " +
      "day is shaped by when units are running, how long the surge takes to arrive, and what the " +
      "water does between releases. Treat a release schedule as the primary timing input and say " +
      "so; do not describe a tailrace as though it fished the same all day.\n" +
      "STRUCTURE: the elements that matter are outside bends and their scour holes, shoals, " +
      "ledges and rock gardens, laydowns and root wads, current seams and eddy lines, the boil " +
      "and the slack behind an obstruction, tributary and creek mouths, point bars and sandbars, " +
      "bridge piers, and riprap. Fish hold in relation to CURRENT as much as to depth: name the " +
      "current feature a fish is using, not only the depth it sits in.\n" +
      "TIDAL REACHES ARE STILL RIVERS. Eleven of the rivers in this app carry a NOAA tide " +
      "station and their current reverses — the Cooper, Ashley, Waccamaw, Santee, Edisto, Black, " +
      "Combahee, Great Pee Dee, Sampit, Chessie Creek and Black Mingo Creek. On those, both the " +
      "flow and the tide apply and the salt wedge moves with them; say which one you are " +
      "reasoning from. On the rest, only flow applies.\n" +
      "SAFETY IS PART OF THE ANSWER on moving water: a rising release, a strainer or a shoal that " +
      "is a hazard at one flow and a feature at another belongs in the plan, not left implicit.",
  },
};

/** The hint for this water type and agent, or '' — never undefined, so callers can concatenate. */
function waterTypeHint(waterType, agentKey) {
  const byAgent = WATER_TYPE_HINTS[String(waterType || '').toLowerCase()];
  return (byAgent && byAgent[agentKey]) || '';
}

export { WATER_TYPE_HINTS, waterTypeHint };
