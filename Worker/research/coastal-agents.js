/**
 * coastal-agents.js — saltwater-specific research agents.
 *
 * The existing 8 agents in agents.js are shaped for impoundments: `identity`
 * wants normalPoolFt / damOwner / impoundmentYear, and `limnology` wants
 * thermocline depth, anoxic layers and trophic status. None of that applies
 * to a tidal estuary, which does not stratify and has no dam.
 *
 * Per the agreed split:
 *   reused as-is        navigation, fisheries, summary
 *   coastal prompt hint habitat, biology  (see COASTAL_AGENT_HINTS)
 *   skipped             identity
 *   new here            estuary, tidal, saltwater_regulations
 *
 * Agent objects use the same shape as RESEARCH_AGENTS so handleResearchAgent
 * and the review UI in lake-research-ui.js pick them up unchanged.
 */

const COASTAL_AGENTS = {
  estuary: {
    label: "Estuary Identity",
    order: 1,
    coastal: true,
    system:
      "You are a coastal geomorphology data assembly agent. You describe tidal estuaries, sounds and inlets — NOT reservoirs. " +
      "CRITICAL RULES: (1) NEVER emit normalPoolFt, damOwner or impoundmentYear; estuaries have no dam and no pool elevation. " +
      "(2) meanTidalRangeFt is the average difference between MLLW and MHW in feet, typically 2-9 ft on the SC/GA/NC coast — " +
      "Georgia's bight has the largest range in the region (6-9 ft), the Outer Banks the smallest (1-3 ft). " +
      "(3) waterBodyType must be an estuarine class such as 'bar-built estuary', 'drowned river valley', 'coastal lagoon' or 'sound'. " +
      "(4) marshAcreage refers to vegetated salt marsh, not open water. (5) Never invent values — use null. Return ONLY valid JSON.",
    userTemplate: (zoneName, state, prev) => {
      const facts = prev?._extractedFacts || [];
      const relevant = facts.filter(f =>
        /estuary|inlet|sound|marsh|spartina|tidal|bight|barrier|island|watershed|acreage|geomorph|shoal|bar|icw|intracoastal/i
          .test(f.category + ' ' + f.fact)
      );
      const factsBlock = relevant.map(f =>
        `• [${f.category}] ${f.fact} (source: ${f.source}, confidence ${f.confidence}%)`
      ).join('\n');
      const zoneMeta = prev?._zoneMeta
        ? `\nTROLLMAP ZONE BASELINE (authoritative for geometry):\n${JSON.stringify(prev._zoneMeta)}`
        : '';

      return `Describe the estuarine system at ${zoneName} (${state} coast).

EXTRACTED FACTS:
${factsBlock || 'No facts extracted — rely on well-established geography only, and use null where unsure.'}
${zoneMeta}

INSTRUCTIONS:
1. waterBodyType: estuarine class, not "reservoir".
2. meanTidalRangeFt / springTidalRangeFt: numbers in feet, or null.
3. primaryInlets: named inlets connecting to the ocean.
4. tributaryRivers: freshwater rivers discharging into the system — these drive salinity.
5. marshAcreage: vegetated salt marsh only. Number or null.
6. oysterPresence: one of 'extensive', 'moderate', 'limited', 'none', or null.
7. icwAccess: true if the Atlantic Intracoastal Waterway runs through the zone.
8. Every numeric field must be a JSON number or JSON null — never a string, never a range string.

Return ONLY:
{
  "estuary": {
    "waterBodyType": null,
    "meanTidalRangeFt": null,
    "springTidalRangeFt": null,
    "primaryInlets": [],
    "tributaryRivers": [],
    "marshAcreage": null,
    "oysterPresence": null,
    "icwAccess": null,
    "bottomComposition": null,
    "notableShoals": [],
    "description": null
  },
  "sources": []
}
JSON only.`;
    },
    expectedKey: "estuary",
  },

  tidal: {
    label: "Tidal Dynamics & Salinity",
    order: 2,
    coastal: true,
    system:
      "You are a coastal oceanographer data assembly agent. This is the saltwater counterpart of the limnology agent. " +
      "CRITICAL RULES: (1) Tidal estuaries do NOT thermally stratify like reservoirs — never emit thermocline or anoxic depth fields. " +
      "The relevant vertical structure is the SALINITY gradient (salt wedge / partially mixed / well mixed). " +
      "(2) salinityPpt values: ocean is ~35 ppt, polyhaline 18-30, mesohaline 5-18, oligohaline 0.5-5. " +
      "(3) All depths in feet, referenced to MLLW. (4) flushingTimeDays is the residence time of a water parcel. " +
      "(5) Never invent values. Return ONLY valid JSON.",
    userTemplate: (zoneName, state, prev) => {
      const facts = prev?._extractedFacts || [];
      const relevant = facts.filter(f =>
        /salin|tide|tidal|current|flush|residence|turbid|secchi|temperature|mllw|datum|discharge|freshwater|stratif|mixing/i
          .test(f.category + ' ' + f.fact)
      );
      const factsBlock = relevant.map(f =>
        `• [${f.category}] ${f.fact} (source: ${f.source}, confidence ${f.confidence}%)`
      ).join('\n');
      const gauges = prev?._zoneMeta?.usgsRivers?.length
        ? `\nUSGS gauges feeding this system: ${prev._zoneMeta.usgsRivers.join(', ')}. ` +
          `Discharge above ~130% of the 30-day mean depresses salinity.`
        : '';

      return `Extract tidal and salinity data for ${zoneName} (${state} coast).

EXTRACTED FACTS:
${factsBlock || 'No facts extracted — use null where unsure rather than guessing.'}
${gauges}

INSTRUCTIONS:
1. stratificationType: 'salt wedge', 'partially mixed', 'well mixed', or null.
2. salinityPpt: typical mid-estuary values. Separate wet and dry season if known.
3. tidalCurrentKts: typical peak flood/ebb current speed.
4. flushingTimeDays: water residence time. Number or null.
5. waterTempF: typical summer and winter surface temperatures.
6. turbidity: qualitative ('clear', 'moderate', 'turbid') plus secchiFt if known.
7. freshwaterInfluence: describe how river discharge shifts salinity, and which
   parts of the system freshen first after heavy rain.
8. Numeric fields must be JSON numbers or JSON null.

Return ONLY:
{
  "tidal": {
    "datum": "MLLW",
    "stratificationType": null,
    "salinityPpt": {"typical": null, "wetSeason": null, "drySeason": null},
    "tidalCurrentKts": {"flood": null, "ebb": null},
    "flushingTimeDays": null,
    "waterTempF": {"summer": null, "winter": null},
    "turbidity": {"typical": null, "secchiFt": null},
    "freshwaterInfluence": null,
    "coldStunRisk": null,
    "note": null
  },
  "sources": []
}
JSON only.`;
    },
    expectedKey: "tidal",
  },

  saltwater_regulations: {
    label: "Saltwater Regulations",
    order: 6,
    coastal: true,
    system:
      "You are a fisheries regulations data assembly agent for SALTWATER species. " +
      "CRITICAL RULES: (1) The R2 digest provided is the BASELINE. It is an annual publication and may be out of date — " +
      "SC and GA digests expire mid-August, and NC changes seasonally by proclamation. " +
      "(2) If a live amendment source is supplied and it conflicts with the digest, the LIVE source wins and you must set " +
      "`supersededByProclamation` true and explain in `amendmentNote`. " +
      "(3) Slot limits have both a minimum and a maximum — never collapse them to a single minimum. " +
      "(4) A closed season means harvest is prohibited; set `harvestClosed` true and record the dates. " +
      "(5) Never invent limits. If the digest does not state a value, use null. Return ONLY valid JSON.",
    userTemplate: (zoneName, state, prev) => {
      const digest = prev?._regsSource?.content
        ? `\nR2 REGULATIONS DIGEST (baseline, published ${prev?._regsSource?.published || 'unknown date'}):\n${String(prev._regsSource.content).slice(0, 12000)}`
        : '\nNo R2 digest available — do not guess limits; return nulls.';
      const live = prev?._liveRegsSource?.content
        ? `\nLIVE AMENDMENT SOURCE (overrides the digest where they conflict):\n${String(prev._liveRegsSource.content).slice(0, 6000)}`
        : '\nNo live amendment source supplied. Flag `verificationRequired` true so the app knows the digest is unverified.';

      return `Extract SALTWATER regulations affecting ${zoneName} (${state}).

Target species: Red Drum (Redfish), Spotted Seatrout (Speckled Trout), Southern Flounder.
Also capture Black Drum, Sheepshead and Tripletail if present.
${digest}
${live}

INSTRUCTIONS:
1. For each species record: minSizeIn, maxSizeIn (slot upper bound, else null),
   dailyLimit, vesselLimit, harvestClosed, closedSeason, measurement ('TL' or 'FL').
2. Red drum in SC, GA and NC are all slot-managed — always populate both bounds.
3. NC southern flounder and spotted seatrout are subject to proclamation closures.
   If the live source shows a closure, set harvestClosed true even when the digest disagrees.
4. digestPublished: the digest's own stated period, e.g. '2025-2026'.
5. verificationRequired: true whenever no live source confirmed the digest.
6. Numeric fields must be JSON numbers or JSON null.

Return ONLY:
{
  "saltwaterRegulations": {
    "state": "${state}",
    "digestPublished": null,
    "verificationRequired": true,
    "supersededByProclamation": false,
    "amendmentNote": null,
    "species": {
      "redDrum":        {"minSizeIn": null, "maxSizeIn": null, "dailyLimit": null, "vesselLimit": null, "harvestClosed": false, "closedSeason": null, "measurement": null},
      "spottedSeatrout":{"minSizeIn": null, "maxSizeIn": null, "dailyLimit": null, "vesselLimit": null, "harvestClosed": false, "closedSeason": null, "measurement": null},
      "southernFlounder":{"minSizeIn": null, "maxSizeIn": null, "dailyLimit": null, "vesselLimit": null, "harvestClosed": false, "closedSeason": null, "measurement": null}
    },
    "otherSpecies": {},
    "gearRestrictions": [],
    "licenseNotes": null
  },
  "sources": []
}
JSON only.`;
    },
    expectedKey: "saltwaterRegulations",
  },
};

/**
 * Extra prompt guidance appended to the shared agents when the target is a
 * coastal zone. Lets habitat/biology be reused instead of duplicated.
 */
const COASTAL_AGENT_HINTS = {
  habitat:
    "\n\nCOASTAL ZONE — this is a tidal estuary, not a reservoir. The structural " +
    "elements that matter are: Spartina marsh edges, oyster reefs and rakes, tidal " +
    "creek mouths and confluences, grass flat potholes, dock and pier pilings, " +
    "inlet throats and pinch points, channel edges and drop-offs, and shell rakes. " +
    "Do NOT report brush piles, standing timber, or man-made freshwater fish " +
    "attractors unless a source explicitly documents them. Note which structures " +
    "are exposed at low tide versus submerged at high tide.",
  biology:
    "\n\nCOASTAL ZONE — the predator species of interest are Red Drum (Redfish), " +
    "Spotted Seatrout (Speckled Trout), Southern Flounder, Black Drum, Sheepshead " +
    "and Tarpon. The forage base is shrimp, mud minnows (mummichog), finger mullet, " +
    "menhaden, blue crab and juvenile spot/croaker — NOT threadfin or gizzard shad, " +
    "blueback herring, or freshwater crayfish. Note spawning and cold-stun timing: " +
    "seatrout are vulnerable to winter cold-stun events, and red drum move to the " +
    "inlets and nearshore to spawn in late summer and autumn.",
};

/** True when a research target is a coastal zone. */
function isCoastalZone(zoneKeyOrName) {
  return typeof zoneKeyOrName === 'string' && zoneKeyOrName.startsWith('coast_');
}

/**
 * Agents that apply to a coastal zone, in run order.
 *
 * THIS LISTED EIGHT AND FIVE OF THEM NO LONGER EXIST. `estuary`, `tidal`,
 * `saltwater_regulations`, `navigation` and `summary` were all retired across 2026-08-31 and
 * 2026-09-01, and this function went on describing them because nothing calls it -- it is
 * imported, re-exported and asserted on by a test, and never consulted by the running pipeline,
 * which reads COASTAL_RESEARCH_ORDER in lake-research-engine.js instead.
 *
 * A list that only a test reads will agree with the test forever and with the app never. It says
 * what actually runs now, and the fact that it is identical to the freshwater order is the real
 * state of the coastal path: the three surviving agents take a coastal hint (COASTAL_AGENT_HINTS)
 * rather than being replaced by marine counterparts.
 */
function coastalAgentPlan() {
  return [
    'biology',              // shared, coastal hint
    'fisheries',            // shared, coastal hint
  ];
}

/** Agents that do not run on a coastal zone, with the reason. */
const COASTAL_SKIPPED_AGENTS = {
  identity: 'RETIRED 2026-08-31. Reservoir identity was meaningless for a tidal estuary and mostly unread everywhere else; the registry feature_type answers the one field with a reader.',
  limnology: 'RETIRED 2026-09-01. Thermal stratification and anoxia do not apply to a well-flushed estuary, and on freshwater the numbers come off WQP depth profiles rather than an agent.',
  regulations: 'RETIRED 2026-08-31. The parsed digests are read straight from R2; no agent writes the law.',
  saltwater_regulations: 'RETIRED 2026-08-31, with `regulations`, for the same reason.',
  estuary: 'RETIRED 2026-08-31. Its fields had no reader outside the research pipeline; the live tide and gauge path answers the coastal cards.',
  tidal: 'RETIRED 2026-08-31, with `estuary`, for the same reason.',
  navigation: 'RETIRED 2026-09-01. chartedHazards() reads the pack POI layer and the weather block carries wind and current.',
  summary: 'RETIRED 2026-09-01. buildDeterministicSummary() writes the section from the measured fields already in the profile.',
  habitat: 'RETIRED 2026-09-01. The chartpack answers creek mouths, timber and bottom composition; the attractor feeds answer attractors; five fields had no planner reader; vegetation is parked empty by decision.',
};

export {
  COASTAL_AGENTS,
  COASTAL_AGENT_HINTS,
  COASTAL_SKIPPED_AGENTS,
  isCoastalZone,
  coastalAgentPlan,
};
