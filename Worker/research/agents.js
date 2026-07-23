// research/agents.js — split from worker-research.js (behavior-preserving) 
import { JSON_HEADERS, callLLM, extractLLMText } from '../worker-core.js';
import { LAKES, lakeKeyFromName } from '../worker-data.js';
import { tinyfishFetch } from './clients.js';
import { extractJsonPossibly } from './keys.js';
import { handleResearchDiscover } from './discover.js';
import { handleResearchProxyDownload } from './download.js';
import { handleResearchGetNormalized, handleResearchSaveNormalized } from './deterministic.js';
import { handleResearchAnalyzeFacts, handleResearchDedupeContradictions } from './extract.js';

var RESEARCH_AGENTS = {
  identity: {
    label: "Lake Identity",
    order: 1,
    system: "You are a data assembly agent for lake identity and pool management data. Map extracted facts to the JSON fields. CRITICAL RULES: (1) surfaceAreaAcres must be in ACRES — if source gives km², multiply by 247.1; (2) maxDepthFt is actual water depth — NEVER use pool elevation as depth; (3) For Duke Energy CRA pool tables the columns are: Month | Guide Curve ft | Minimum ft | Maximum ft in local datum; (4) riverSystem must be a river/watershed name like 'Saluda River' or 'Catawba-Wateree' — NEVER a HUC code or monitoring site description; (5) archetype must be a lake type like 'large hydroelectric reservoir' — NEVER a water quality site type like 'other-surface water site'; (6) Never invent values. Return ONLY valid JSON. (8) county: use an array for multi-county or multi-state lakes (e.g. ['York, SC', 'Gaston, NC', 'Mecklenburg, NC']). For single county use a string. Never leave null if county information is present in the facts. (7) normalPoolFt is the STATIC full pool surface elevation in feet NGVD/NAVD (e.g. 265.3, 385.5, 569.4, 75.5) — NEVER a daily fluctuation range, drawdown amount, or year range. If you see phrases like 'fluctuate up to X feet', 'averaging X feet per day', 'up to X feet daily', or 'X feet year-round fluctuation', those are fluctuation amounts NOT pool elevations — set normalPoolFt to null. If the only pool number is a fluctuation or a year range, set normalPoolFt to null. Valid pool elevations are typically 3-digit numbers (e.g. 265, 385, 569) for NGVD/NAVD, or 2-digit numbers representing local datum (e.g. 97 for Duke Energy lakes). Single-digit or ambiguous numbers should be set to null unless clearly labeled as pool elevation.",
    userTemplate: (lakeName, state, prev) => {
      const facts = prev?._extractedFacts || [];

      const surfaceFact = facts.find(f => f.category === 'surfaceArea' && /acre/i.test(f.fact))
        || facts.find(f => f.category === 'surfaceArea');
      const surfaceArea = surfaceFact ? (() => {
        const m = surfaceFact.fact.match(/([\d,]+(?:\.\d+)?)\s*acres?/i);
        if (m) return parseFloat(m[1].replace(',',''));
        const km = surfaceFact.fact.match(/([\d,]+(?:\.\d+)?)\s*km/i);
        if (km) return Math.round(parseFloat(km[1].replace(',','')) * 247.1);
        return null;
      })() : null;

      const maxFact = facts.find(f => f.category === 'maxDepthFt' && !/225|pool|elevation/i.test(f.fact));
      const maxDepth = maxFact ? (() => {
        const m = maxFact.fact.match(/([\d.]+)\s*f(?:ee)?t/i);
        if (m) return parseFloat(m[1]);
        const met = maxFact.fact.match(/([\d.]+)\s*met/i);
        if (met) return Math.round(parseFloat(met[1]) * 3.281);
        return null;
      })() : null;

      const avgFact = facts.find(f => f.category === 'averageDepthFt');
      const avgDepth = avgFact ? (() => {
        const m = avgFact.fact.match(/([\d.]+)\s*f(?:ee)?t/i);
        if (m) return parseFloat(m[1]);
        const met = avgFact.fact.match(/([\d.]+)\s*met/i);
        if (met) return Math.round(parseFloat(met[1]) * 3.281 * 10) / 10;
        return null;
      })() : null;

      const identityFacts = facts.filter(f => {
        if (!/identity|surface|depth|dam|year|owner|river|archetype|impound|county|pool|drawdown|elevation|normal/i.test(f.category)) return false;
        // Exclude poolLevel facts that are just fluctuation ranges — not pool elevations
        if (f.category === 'poolLevel' && !/elevation|ngvd|navd|feet above|ft msl|\d{3}\s*f/i.test(f.fact)) return false;
        return true;
      }).map(f => `• [${f.category}] ${f.fact} (source: ${f.source}, confidence ${f.confidence}%)\n  Quote: "${f.quote}"`).join('\n\n');

      const ownerText = (facts.find(f => f.category === 'reservoirOwner')?.fact || '').toLowerCase();
      const isDuke = /duke/i.test(ownerText);

      const dukePoolSection = isDuke ? `

DUKE ENERGY CRA POOL LEVEL TABLE — IF PRESENT IN DOCUMENTS:
The CRA agreement PDF has a table: Month(s) | Guide Curve (target ft) | Minimum ft | Maximum ft (local datum, typically 93-100 range).
Extract into poolManagement: guideCurveFt by month, minimumFt, maximumFt, drawdownSchedule [{months, targetFt}].
Set drawdownType: "scheduled" and normalPoolFt to the Maximum column value.` : '';

      const docSection = prev?._documentContext
        ? `\n\nDOCUMENT TEXT:\n${prev._documentContext.slice(0, 60000)}`
        : '';

      return `Map identity facts for ${lakeName} (${state}).

EXTRACTED FACTS:
${identityFacts || 'No identity facts — use document context.'}

RULES:
- surfaceAreaAcres: ${surfaceArea !== null ? surfaceArea : 'extract from facts (acres preferred; km² × 247.1)'}
- maxDepthFt: ${maxDepth !== null ? maxDepth : 'from EPA/USGS only — reject pool elevation values'}
- averageDepthFt: ${avgDepth !== null ? avgDepth : 'convert meters × 3.281 if needed'}
${dukePoolSection}
${docSection}

Return ONLY valid JSON:
{
  "identity": {
    "lakeName": "${lakeName}",
    "aliases": [],
    "state": "${state || ''}",
    "county": null,
    "riverSystem": null,
    "reservoirOwner": null,
    "surfaceAreaAcres": ${surfaceArea !== null ? surfaceArea : null},
    "maxDepthFt": ${maxDepth !== null ? maxDepth : null},
    "averageDepthFt": ${avgDepth !== null ? avgDepth : null},
    "elevationFt": null,
    "normalPoolFt": null,
    "type": "reservoir",
    "archetype": null,
    "damName": null,
    "yearImpounded": null,
    "drawdownType": null,
    "poolManagement": null
  },
  "sources": []
}
JSON only.`;
    },
    expectedKey: "identity"
  },
  limnology: {
    label: "Limnology",
    order: 2,
    system: "You are a limnologist data assembly agent. Map extracted facts and depth profile data to the limnology JSON. depletionDepthFt = shallowest depth where DO drops below 2 mg/L. anoxicBelowFt = depth where DO approaches 0. thermocline summerDepthFt = single number (midpoint of thermocline range, in feet). Convert meters to feet (×3.281). All numeric fields must be numbers or null — NEVER strings. Return ONLY valid JSON.",
    userTemplate: (lakeName, state, prev) => {
      const facts = prev?._extractedFacts || [];
      const limFacts = facts.filter(f =>
        /limnology|thermocline|oxygen|clarity|secchi|trophic|depth.?profile|water.?clarity|hydraulic|retention|do_depth|temp_depth/i.test(f.category + ' ' + f.fact)
      );
      const factsBlock = limFacts.map(f =>
        `• [${f.category}] ${f.fact} (source: ${f.source}, confidence ${f.confidence}%)\n  Quote: "${f.quote}"`
      ).join('\n\n');

      const docSection = prev?._documentContext
        ? `\n\nRAW DOCUMENT TEXT (look for depth profile tables with DO and temperature readings at multiple depths):\n${prev._documentContext.slice(0, 40000)}`
        : '';

      return `Extract limnology data for ${lakeName} from facts and documents.

EXTRACTED FACTS:
${factsBlock || 'No limnology facts extracted — derive from document depth profiles.'}

INSTRUCTIONS:
1. secchiFt: The EPA NES table has a row labeled "SECCHI (METERS)" — that is the only row for Secchi. Convert meters × 3.281. NEVER use alkalinity (10-35 mg/L), conductivity, pH, or any other row as Secchi. Most SE piedmont reservoirs have secchi < 5ft, but oligotrophic mountain lakes (Nantahala, Santeetlah, Jocassee, etc.) can have legitimate secchi of 10-20ft. Only reject values above 25ft as implausible.
2. thermocline.summerDepthFt: find where temperature drops sharply with depth in summer profiles. Report as a SINGLE NUMBER (the midpoint in feet, e.g. 19 for a 16-22ft range). NEVER a string, NEVER a range string like "16-22".
3. oxygen.depletionDepthFt: depth where DO first drops below 2 mg/L in summer. Must be a number or null — never the string "null".
4. oxygen.anoxicBelowFt: depth where DO approaches 0. Must be a number or null — never the string "null".
5. trophicStatus: derive from phosphorus, Secchi, chlorophyll data if present.
6. hydraulicRetentionDays: look for "retention time" or "residence time" in days. Number or null.
7. All depth values in feet — convert meters × 3.281.
8. CRITICAL: Every numeric field must be a JSON number or JSON null. Never use the string "null", never use a range string. If data is unavailable, use JSON null.
${docSection}

Return ONLY:
{
  "limnology": {
    "waterClarity": {"typical": null, "color": null, "secchiFt": null, "note": null},
    "thermocline": {"summerDepthFt": null, "strength": null, "winterMix": null, "confidence": null, "note": null},
    "oxygen": {"depletionDepthFt": null, "anoxicBelowFt": null, "note": null},
    "trophicStatus": null,
    "hydraulicRetentionDays": null,
    "flowCharacteristics": null,
    "seasonalDrawdownFt": null,
    "phTypical": null
  },
  "sources": []
}
JSON only.`;
    },
    expectedKey: "limnology"
  },
  biology: {
    label: "Fisheries Biology",
    order: 3,
    system: "You are a fisheries data assembly agent. Map extracted facts to the biology JSON. CRITICAL: predatorSpecies MUST include ALL species from the deterministic list — never shrink it. Only add species confirmed in facts/documents. Return ONLY valid JSON.",
    userTemplate: (lakeName, state, prev) => {
      const facts = prev?._extractedFacts || [];
      const bioFacts = facts.filter(f =>
        /biology|forage|species|predator|stocking|standing.?stock|shad|bass|crappie|catfish|biomass|rotenone|abundance|invasive|herring|spawn|bream|bluegill|crawfish|crayfish|perch/i.test(f.category + ' ' + f.fact)
      );

      // Split facts: official agency sources vs web/guide sources
      // Only official sources can confirm new species presence
      const OFFICIAL_SRC = /scdnr|ncwrc|ncwildlife|gadnr|georgiawildlife|twra|tn\.gov|tva\.gov|eregulations|dnr\.sc\.gov|dnr\.nc\.gov|ncwildlife\.gov|epd\.georgia|wildlife\.ga\.gov|georgiawildlife\.com|epa\.gov|usgs\.gov|usace|corps\.army\.mil|santee.?cooper|duke.?energy|ferc|statewide.?fisheries|annual.?report|management.?plan|survey.*\d{4}|\d{4}.*survey/i;
      const officialFacts = bioFacts.filter(f => OFFICIAL_SRC.test(f.source || ''));
      const webFacts = bioFacts.filter(f => !OFFICIAL_SRC.test(f.source || ''));

      const deterministicSpecies = prev?.biology?.predatorSpecies || [];

      const officialFactsBlock = officialFacts.map(f =>
        `• [${f.category}] ${f.fact} (source: ${f.source}, confidence ${f.confidence}%)\n  Quote: "${f.quote}"`
      ).join('\n\n');

      const webFactsBlock = webFacts.map(f =>
        `• [${f.category}] ${f.fact} (source: ${f.source}, confidence ${f.confidence}%)\n  Quote: "${f.quote}"`
      ).join('\n\n');

      const docSection = prev?._documentContext
        ? `\n\nDOCUMENT TEXT (look for species lists, stocking records, cove rotenone data, biomass tables, spawn timing, forage location notes):\n${prev._documentContext.slice(0, 80000)}`
        : '';

      return `Map fisheries biology facts for ${lakeName}.

DETERMINISTIC SPECIES LIST (MUST be preserved — only add, never remove):
${JSON.stringify(deterministicSpecies)}

OFFICIAL AGENCY FACTS (SCDNR, NCWRC, EPA, USGS, eRegulations, DNR, Santee Cooper — authoritative for species presence):
${officialFactsBlock || 'None.'}

WEB / GUIDE FACTS (fishing guides, social media, commercial sites — use for forage/behavior/stocking only, NOT species presence):
${webFactsBlock || 'None.'}
${docSection}

RULES:
1. predatorSpecies: start with deterministic list above. ONLY add a species if it appears in the OFFICIAL AGENCY FACTS section or in official agency document text. NEVER add a species based solely on web/guide sources like Omnia Fishing, fishing reports, or social media — these are unreliable for confirming species presence. Never remove. NEVER add: sturgeon, paddlefish, gar, eel, lamprey, shad, herring, carp, drum, buffalo, sucker, or any protected/endangered/baitfish species — these are NOT predator species.
2. primaryForage: extract from facts AND document text. If shad (threadfin shad, gizzard shad, blueback herring) are mentioned as forage or baitfish in any document, include them. Do not leave primaryForage empty if forage species appear in the source material.
3. knownStockings: extract actual stocking events with species, quantities, years if mentioned.
4. standingStockKgHa: extract biomass figures from rotenone or electrofishing data if present.
5. speciesAbundance: use actual percentage data from documents if available.
6. spawnTiming: extract spawn timing per species if mentioned (e.g. "largemouth bass spawn late March to early May when water reaches 62-68°F"). Use format {"species": "timing description"}.
7. forageSpatial: if documents mention WHERE forage concentrates (e.g. "bream in shallow rocky coves", "shad school in open mid-lake water near dam", "crappie at creek mouths"), extract that as a single descriptive string.
8. baitfishMovement: if documents describe seasonal or behavioral movement of bait species, extract as a seasonal object {"spring": "...", "summer": "...", "fall": "...", "winter": "..."}. Include spatial context (e.g. "suspend over humps near thermocline", "push into creek backs"). Omit seasons with no document support.
9. Keep spawnTiming keyed by the exact species name and preserve temperature/date triggers when stated.
10. forageSpatial must name the area or habitat where forage is reported; do not turn a generic forage species statement into a location.
11. speciesBehavior: CRITICAL — for each predator species, extract lake-specific depth ranges, structure associations, and behavioral notes per season from documents. This replaces generic species intel in Smart Plan. If a document says "largemouth bass holding in 5-8 feet around woody cover" — that goes in speciesBehavior.Largemouth Bass.summer. If no species-specific depth/structure data exists in documents, omit that species from speciesBehavior.

Return ONLY:
{
  "biology": {
    "primaryForage": [],
    "secondaryForage": [],
    "predatorSpecies": ${JSON.stringify(deterministicSpecies.length ? deterministicSpecies : [])},
    "speciesAbundance": {},
    "standingStockKgHa": null,
    "baitfishMovement": { "spring": null, "summer": null, "fall": null, "winter": null },
    "knownStockings": [],
    "invasiveSpecies": [],
    "forageCalendar": {},
    "spawnTiming": {},
    "forageSpatial": null,
    "speciesBehavior": {}
  },
  "sources": []
}
speciesBehavior schema per species: { "spring": {"depthRange": [minFt, maxFt], "structure": [], "notes": null}, "summer": {...}, "fall": {...}, "winter": {...}, "spawnTiming": {"waterTempF": null, "typicalMonths": []}, "spawnHabitat": null, "lakeSpecificNotes": null }
depthRange is [minFt, maxFt] array or null. Only populate seasons with document evidence. JSON only.`;
    },
    expectedKey: "biology"
  },
  habitat: {
    label: "Habitat",
    order: 4,
    system: "You are an aquatic habitat data assembly agent. Map facts and geospatial data to the habitat JSON. No fishing advice. Return ONLY valid JSON.",
    userTemplate: (lakeName, state, prev) => {
      const facts = prev?._extractedFacts || [];
      const habFacts = facts.filter(f =>
        /habitat|cover|attractor|bottom|timber|dock|vegetation|structure|point|creek|ledge|flat|ramp|bridge|riprap|cove|arm|shallow|marina|pier/i.test(f.category + ' ' + f.fact)
      );
      const existingHabitat = prev?.habitat || {};
      const factsBlock = habFacts.map(f =>
        `• [${f.category}] ${f.fact} (source: ${f.source}, confidence ${f.confidence}%)`
      ).join('\n');

      return `Map habitat facts for ${lakeName}.

EXTRACTED FACTS:
${factsBlock || 'No habitat facts extracted.'}

EXISTING GEOSPATIAL DATA (from TrollMap contour/supplemental layers — preserve these exactly):
${JSON.stringify(existingHabitat, null, 2).slice(0, 3000)}

RULES:
CASTING EXTRACTION REQUIREMENTS — these fields power the casting stop builder. Search the full document, including captions, tables, map labels, and prose. Preserve named locations verbatim and do not replace a specific location with a generic category.
1. dockDensity: if documents describe dock concentration (e.g. "heavily docked residential shoreline", "sparse docks", "marina on north end"), capture as a descriptive string. null if not mentioned.
2. riprapLocations: list specific riprap areas if mentioned (e.g. dam face, causeways, bridge approaches, rip-rapped banks). Array of strings.
3. namedCreekMouths: extract named creek mouths or arms if mentioned in documents (e.g. "Bear Creek arm", "Dutchman Creek mouth"). Array of strings. These are high-value casting targets.
4. timberFields: if documents describe flooded timber areas or submerged wood concentrations, capture as descriptive string with location if available.
5. shallowFlatAreas: if documents describe specific named shallow flat areas or coves good for casting/spawning, capture as descriptive string.
6. Include evidence-backed location details even when no numeric value is present; an empty array/null is correct only when the document contains no support.
7. Do not infer casting locations from generic lake geography or fishing knowledge.
8. standingTimber: boolean or description if submerged timber is present lake-wide.
9. cover: array of cover types present (docks, brush, timber, riprap, etc.).
10. Preserve all existing geospatial structuralElements and artificialHabitatDetails exactly.

Return ONLY:
{
  "habitat": {
    "bottomComposition": {},
    "cover": [],
    "vegetation": {},
    "artificialHabitat": [],
    "artificialHabitatDetails": ${JSON.stringify(existingHabitat.artificialHabitatDetails || null)},
    "structuralElements": ${JSON.stringify(existingHabitat.structuralElements || {})},
    "dockDensity": null,
    "riprapLocations": [],
    "namedCreekMouths": [],
    "timberFields": null,
    "shallowFlatAreas": null,
    "standingTimber": null,
    "notes": ${JSON.stringify(existingHabitat.notes || null)}
  },
  "sources": []
}
JSON only.`;
    },
    expectedKey: "habitat"
  },
  navigation: {
    label: "Navigation",
    order: 5,
    system: "You are a boating safety data assembly agent. Map ramp data and hazard facts to the navigation JSON. Return ONLY valid JSON.",
    userTemplate: (lakeName, state, prev) => {
      const existingNav = prev?.navigation || {};
      const ramps = existingNav.ramps?.length ? JSON.stringify(existingNav.ramps) : '[]';
      const facts = prev?._extractedFacts || [];
      const navFacts = facts.filter(f =>
        /ramp|hazard|shoal|navigation|timber|dam|bridge|tailwater|surge|idle|access/i.test(f.category + ' ' + f.fact)
      ).map(f => `• ${f.fact} (source: ${f.source})`).join('\n');

      return `Navigation data for ${lakeName}.

EXISTING RAMP DATA (from SCDNR — preserve exactly):
${ramps}

EXTRACTED HAZARD FACTS:
${navFacts || 'No navigation facts extracted — derive from lake type and operator.'}

Return ONLY:
{
  "navigation": {
    "ramps": ${ramps},
    "hazards": [],
    "shoals": [],
    "standingTimberAreas": [],
    "idleZones": [],
    "dangerousAreas": [],
    "notes": null
  },
  "sources": []
}
JSON only.`;
    },
    expectedKey: "navigation"
  },

  regulations: {
    label: "Regulations",
    order: 6,
    system: "You are a fishing regulations specialist. Extract fishing regulations from the provided live regulations page content. For each species: check if the lake appears in an exception list. If listed, use the exception rule. If not listed, the statewide rule applies. Return ONLY valid JSON. Never invent limits — if unknown, set null.",
    userTemplate: (lakeName, state, prev) => {
      const facts = (prev?._extractedFacts || [])
        .filter(f => /regulation|creel|limit|season|closed|gear|size.*limit|possession|sizeLimit|creelLimit/i.test(f.category + ' ' + f.fact))
        .slice(0, 30);
      const factsBlock = facts.map(f => `• [${f.category}] ${f.fact} (source: ${f.source})`).join('\n');
      const regsContent = prev?._regsSource?.content
        ? prev._regsSource.content.slice(0, 30000)
        : 'Not available';
      return `Extract fishing regulations for ${lakeName} (${state}).

LIVE REGULATIONS PAGE:
${regsContent}

EXTRACTED REGULATION FACTS (use to fill species-specific fields):
${factsBlock || 'None extracted'}

INSTRUCTIONS:
1. Read the regulations page above carefully
2. For each species, find rows that apply to ${lakeName}
3. If ${lakeName} is in an exception row, use that exception rule
4. If not listed, statewide rule applies
5. Extract rules for: Largemouth Bass, Striped Bass / Hybrid, White Bass, Crappie, Blue Catfish, Channel Catfish, Bream, Chain Pickerel

CRITICAL STRUCTURE RULES — violations will corrupt the profile:
- creelLimits MUST be a JSON object with species name keys. NEVER a string, NEVER an array.
- sizeLimits MUST be a JSON object with species name keys. NEVER a string, NEVER an array.
- specialRules is ONLY for gear restrictions (trotlines, traps, slot limits, unusual rules). NEVER put creel or size limits here.
- Every species you find a creel limit for MUST appear as a key in creelLimits.
- Every species you find a size limit for MUST appear as a key in sizeLimits.

CORRECT example for Lake Murray:
"creelLimits": {
  "Striped Bass / Hybrid": "5",
  "Largemouth Bass": "5 combined black bass",
  "Crappie": "20",
  "White Bass": "10",
  "Bream": "30",
  "Blue Catfish": "25",
  "Chain Pickerel": "30"
}
"sizeLimits": {
  "Largemouth Bass": "14 inches min",
  "Striped Bass / Hybrid": "Oct. 1 - May 31: 21 inches min; June 1 - Sept. 30: any length",
  "Crappie": "8 inches min"
}

WRONG — do NOT do this:
"creelLimits": "The crappie regulation is 20 fish per day"  ← STRING, NOT ALLOWED
"creelLimits": ["20 crappie per day"]  ← ARRAY, NOT ALLOWED

Return ONLY valid JSON:
{
  "regulations": {
    "state": "${state || 'SC'}",
    "lakeSpecificRegulations": {
      "hasExceptions": true,
      "creelLimits": {},
      "sizeLimits": {},
      "closedSeasons": [],
      "specialRules": []
    },
    "notes": "Verify at official agency site before fishing."
  },
  "sources": [{"label":"eRegulations SC Freshwater Fishing","url":"https://www.eregulations.com/southcarolina/fishing","trust":"OFFICIAL"}]
}
JSON only. Never output a string or array for creelLimits or sizeLimits.`;
    },
    expectedKey: "regulations"
  },

  fisheries: {
    label: "Species Intelligence",
    order: 7,
    system: "You are a fisheries biologist and professional fishing guide. You are given a verified lake profile AND raw text from source documents (fishing guides, reports, agency surveys). Extract seasonal species behavior from BOTH the profile AND the source documents. CONSENSUS RULE: When multiple sources cover the same species/season, use the depth range and structure that appears in the majority of sources. If sources contradict (e.g. 3 say 15-25ft and 1 says 5ft), use the majority position and note the discrepancy in the notes field. Do not average contradicting values — pick the consensus. Do not invent data when sources are silent — return null for that season. Prioritize official agency documents over fishing guide content when they conflict. Do NOT recommend routes, speeds, or specific lure colors. CRITICAL: Only include species listed in the biology.predatorSpecies array. Return JSON only.",
    userTemplate: (lakeName, state, prev) => {
      const bio = prev?.biology || prev?.forage || {};
      const confirmedSpecies = Array.isArray(bio.predatorSpecies) ? bio.predatorSpecies : [];
      const speciesList = confirmedSpecies.length > 0 ? confirmedSpecies : ['(none confirmed — biology section empty)'];
      const speciesArrayStr = speciesList.map(s => `"${s}"`).join(', ');
      const exampleSpecies = speciesList[0] || 'SpeciesName';
      const primaryForage = Array.isArray(bio.primaryForage) ? bio.primaryForage : (typeof bio.primaryForage === 'string' ? [bio.primaryForage] : []);
      const secondaryForage = Array.isArray(bio.secondaryForage) ? bio.secondaryForage : (typeof bio.secondaryForage === 'string' ? [bio.secondaryForage] : []);
      const allForage = [...primaryForage, ...secondaryForage];
      const forageStr = allForage.length > 0 ? allForage.join(', ') : 'unknown';
      const docSection = prev?._documentContext
        ? `\n\nSOURCE DOCUMENTS (extract seasonal depth, structure, and behavior from these — this is primary evidence):\n${prev._documentContext}`
        : '';
      return `You are given a verified lake profile and source documents. Extract seasonal fishing intelligence from BOTH.

Lake: ${lakeName}
Lake profile (use for confirmed species, forage, limnology context):
${JSON.stringify(prev, null, 2).slice(0, 12000)}
${docSection}

CONFIRMED SPECIES (ONLY these — do not add others):
${speciesList.join(', ')}

CONFIRMED LAKE FORAGE: ${forageStr}
Use forage intelligently — match what each predator species actually eats, not the full lake forage list:
- Striped Bass / Largemouth Bass / Spotted Bass: primary forage is shad (threadfin, gizzard, blueback herring)
- Crappie: small shad, minnows
- Catfish: shad, bream, crawfish — opportunistic
- Bluegill / Panfish: insects, small invertebrates, tiny minnows — NOT shad or herring
- If source documents specify forage for a species/season, use exactly that
- If documents are silent, use species-appropriate forage from the confirmed lake list
- Never assign the full lake forage list to every species — that is wrong

Task: For each confirmed species, extract seasonal depth ranges, key structures, forage, and behavior notes from the source documents above. Use the profile (thermocline, oxygen floor, forage) to fill gaps where documents are silent. This is stable long-term intelligence, not a daily plan.

CRITICAL SPECIES COVERAGE: Every species in the confirmed list MUST appear in trollingIntelligence, even if some seasons are null. For species with seasonal closures (e.g. Striped Bass closed June-August on Lake Marion), still include all four seasons — use null for closed/unknown seasons, but populate open seasons from document evidence. Do not silently omit any confirmed species.

SPECIFIC EXTRACTION TARGETS — look for these in the source documents:
- Striped Bass spring: look for "pre-spawn", "staging", "spawning tributaries", "spring run", "March", "April", "May", "58-68°F" — extract depth, structure, forage from that context
- Striped Bass fall: look for "October", "fall striper", "post-closure", "schooling" — extract what you find
- Largemouth Bass winter: look for "cold water", "winter bass", "January", "February", "deep timber", "creek channels in winter", "jigs spoons worms" — if a doc says "bass move back to deep water where jigs, spoons and heavily weighted worms are productive" that is winter LMB data; populate notes even if no explicit depth is given
- Striped Bass winter: look for "deep water", "shiner minnows", "drifting", "winter striper" — if a doc says "stripers are in deep water where drifting with large shiner minnows is effective" that is winter striper data; populate notes and use depth from fall as estimate if no winter depth stated
- If a document says "pre-spawn striped bass staging near spawning tributaries following shad schools" — that is spring striper data, extract it

If a document gives specific depth ranges or seasonal behavior for a species on ${lakeName}, use it — do not replace document evidence with generic inferences.

SCHEMA RULES — every season entry MUST follow this exact structure, no exceptions:
{
  "preferredDepth": [minFt, maxFt],   ← 2-element number array, or null if truly unknown
  "structures": [],                    ← array of strings, never omit this key
  "forage": [],                        ← array of strings, never omit this key
  "recommendedPresentations": [],      ← array of strings, never omit this key
  "notes": ""                          ← string or null, never omit this key
}

NEVER output a bare array like [5, 12] for a season — that is invalid. Every season must be a full object or null.
If you only know the depth range for a species but not structures/forage, still return the full object with preferredDepth populated and empty arrays for the rest.
If a season is completely unknown, use null for that season entry.

Return ONLY:
{
  "trollingIntelligence": {
    "${exampleSpecies}": {
      "summer": {
        "preferredDepth": [12,18],
        "structures": ["channel ledges","creek mouths","long points"],
        "forage": ["Threadfin Shad"],
        "recommendedPresentations": ["MR Crankbait","DD Crankbait","A-Rig"],
        "notes": "behavior notes drawn from source documents"
      },
      "fall": {"preferredDepth":[8,15],"structures":[],"forage":[],"recommendedPresentations":[],"notes":""},
      "winter": {"preferredDepth":[20,35],"structures":[],"forage":[],"recommendedPresentations":[],"notes":""},
      "spring": {"preferredDepth":[5,15],"structures":[],"forage":[],"recommendedPresentations":[],"notes":""}
    }
  },
  "sources": [{"label":"Derived from lake profile and source documents","trust":"DERIVED"}]
}

Species list MUST be ONLY: [${speciesArrayStr}] — do NOT add species not in this list.
preferredDepth MUST be a 2-element number array [minDepthFt, maxDepthFt] or null — NEVER a bare array at the season level.
JSON only.`;
    },
    expectedKey: "trollingIntelligence"
  },
  summary: {
    label: "AI Summary",
    order: 8,
    system: "You summarize a lake profile into a readable human description, max 500 words. Use only supplied JSON. Never invent facts. Return JSON with text field.",
    userTemplate: (lakeName, state, prev) => `Summarize this lake profile for a kayak angler. Max 500 words. Use only supplied JSON. Never invent facts.

Profile:
${JSON.stringify(prev, null, 2).slice(0, 15000)}

Return ONLY:
{
  "summary": {
    "text": "Lake Wateree is a lowland river-run reservoir... Primary trolling opportunities are ... Always check lake specific fishing regulations for season closures and creel limits before launching.",
    "keywords": ["river-run","striped bass","channel ledges","Threadfin Shad","regulations"]
  },
  "sources": [{"label":"Derived from lake profile","trust":"DERIVED"}]
}

Plain text summary in text field, no markdown headers, no bullet list - 2-3 paragraphs max.
JSON only.`,
    expectedKey: "summary"
  }
};

function calculateSectionConfidence(sources, hasData, sectionType) {
  if (!hasData) return { percent: 0, level: "missing", reason: "no data" };
  const src = Array.isArray(sources) ? sources : [];

  // ── Trolling / TrollingIntelligence — data-structure validated scoring ──
  // Trolling has no citable sources (fishing tactics aren't USGS-published),
  // so source-count scoring always under-reports. Instead, validate the output
  // structure: does it have species × season entries with depth/structure/forage?
  if (sectionType === 'trolling' || sectionType === 'trollingIntelligence') {
    const sectionData = arguments[3]; // passed by handleResearchAgent
    let speciesCount = 0, structuredSeasons = 0;
    if (sectionData && typeof sectionData === 'object') {
      for (const [species, seasons] of Object.entries(sectionData)) {
        if (typeof seasons !== 'object' || !seasons) continue;
        speciesCount++;
        for (const season of ['spring','summer','fall','winter']) {
          const s = seasons[season];
          if (s && typeof s === 'object') {
            const hasDepth = Array.isArray(s.preferredDepth) && s.preferredDepth.length === 2;
            const hasStruct = Array.isArray(s.structures) && s.structures.length > 0;
            const hasForage = Array.isArray(s.forage) && s.forage.length > 0;
            if (hasDepth && (hasStruct || hasForage)) structuredSeasons++;
          }
        }
      }
    }
    if (speciesCount >= 3 && structuredSeasons >= 6) return { percent: 80, level: "high", reason: `validated: ${speciesCount} species, ${structuredSeasons} structured seasons`, trollingValidation: true };
    if (speciesCount >= 2 && structuredSeasons >= 3) return { percent: 65, level: "medium", reason: `validated: ${speciesCount} species, ${structuredSeasons} structured seasons`, trollingValidation: true };
    if (speciesCount >= 1 && structuredSeasons >= 1) return { percent: 50, level: "low", reason: `validated: ${speciesCount} species, ${structuredSeasons} structured seasons`, trollingValidation: true };
    // Fall through to source-count scoring if structure is empty
  }

  // ── Regulations — data-structure validation for general statewide limits + lake-specific exceptions ──
  if (sectionType === 'regulations') {
    const sectionData = arguments[3];
    if (sectionData && typeof sectionData === 'object') {
      const hasLakeSpecific = sectionData.lakeSpecificRegulations && typeof sectionData.lakeSpecificRegulations === 'object';
      const hasGeneralState = sectionData.generalStateRegulations && typeof sectionData.generalStateRegulations === 'object';
      const hasClosedSeasons = (hasLakeSpecific && Array.isArray(sectionData.lakeSpecificRegulations.closedSeasons)) || Array.isArray(sectionData.seasonalClosures);
      let officialSources = 0;
      for (const s of src) {
        if (String(s.trust||'').toUpperCase().includes('OFFICIAL') || /DNR|WILDLIFE|FISHREGS|CODE|AGENCY/.test(String(s.label||'').toUpperCase())) officialSources++;
      }
      if (hasLakeSpecific && hasGeneralState && officialSources >= 1) {
        const pct = Math.min(99, 85 + (officialSources > 1 ? 8 : 0) + (hasClosedSeasons ? 5 : 0));
        return { percent: pct, level: pct >= 95 ? "very high" : "high", reason: `validated: state limits + lake exceptions (${officialSources} official sources)`, regulationsValidation: true };
      }
      if ((hasLakeSpecific || hasGeneralState) && officialSources >= 1) {
        return { percent: 75, level: "medium", reason: `validated regulations structure (${officialSources} official sources)`, regulationsValidation: true };
      }
    }
  }

  // ── Biology — predatorSpecies is the field Smart Plan consumes ──
  // Source-count scoring over-reports when forage/stocking facts exist but the
  // confirmed predator list is empty. A biology section with zero predator
  // species is not actionable for the app regardless of how many sources
  // contributed forage notes, so cap it low instead of letting the source count
  // inflate it. Only penalize an explicitly-empty array; leave undefined alone.
  if (sectionType === 'biology') {
    const sectionData = arguments[3];
    const predators = sectionData && Array.isArray(sectionData.predatorSpecies) ? sectionData.predatorSpecies : null;
    if (predators !== null && predators.length === 0) {
      return { percent: 35, level: "low", reason: "validated: 0 predator species — unusable for Smart Plan", biologyValidation: true };
    }
  }

  if (!src.length) return { percent: 45, level: "low", reason: "no sources, AI estimate" };
  let score = 0;
  let official = 0, secondary = 0, model = 0, derived = 0;
  for (const s of src) {
    const trust = String(s.trust || '').toUpperCase();
    const label = String(s.label || '').toUpperCase();
    if (trust.includes('OFFICIAL') || /USGS|USACE|EPA|DNR|WILDLIFE|DUKE|DOMINION|SANTEE|SAVANNAH|CORPS/.test(label)) {
      score += 30; official++;
    } else if (trust.includes('DERIVED')) {
      score += 20; derived++;
    } else if (trust.includes('OFFICIAL_GIS') || trust.includes('THIRD_PARTY') || /SURVEY|FISH|REPORT|SAMPLE/.test(label)) {
      score += 15; secondary++;
    } else {
      score += 5; model++;
    }
  }
  // bonus for multiple agreeing sources
  if (official >= 3) score += 20;
  else if (official >=2) score += 10;
  else if (official >=1 && secondary >=1) score += 8;
  if (src.length >=3) score += 10;
  else if (src.length >=2) score += 5;

  let pct = Math.min(99, Math.max(10, score));
  // cap based on source quality
  if (official ===0 && secondary ===0) pct = Math.min(pct, 65);
  if (official ===0 && derived===0) pct = Math.min(pct, 75);

  let level = "low";
  if (pct >= 95) level = "very high";
  else if (pct >= 85) level = "high";
  else if (pct >= 70) level = "medium";
  else if (pct >= 50) level = "low";
  else level = "needs review";

  return {
    percent: pct,
    level,
    officialCount: official,
    secondaryCount: secondary,
    totalSources: src.length,
    reason: `${official} official, ${secondary} secondary, ${src.length} total`
  };
}

// True when a trollingIntelligence object carries at least one species with a
// season entry that has a usable depth range, structure list, or forage list.
// Shared by the section validator and the overall confidence gate.
function hasStructuredTrollingIntel(trolling) {
  if (!trolling || typeof trolling !== 'object') return false;
  return Object.values(trolling).some(seasons => {
    if (!seasons || typeof seasons !== 'object' || Array.isArray(seasons)) return false;
    return ['spring', 'summer', 'fall', 'winter'].some(s => {
      const e = seasons[s];
      if (!e || typeof e !== 'object') return false;
      const hasDepth = Array.isArray(e.preferredDepth) && e.preferredDepth.length === 2
        && e.preferredDepth.every(n => typeof n === 'number' && isFinite(n));
      const hasStruct = Array.isArray(e.structures) && e.structures.length > 0;
      const hasForage = Array.isArray(e.forage) && e.forage.length > 0;
      return hasDepth || hasStruct || hasForage;
    });
  });
}

/**
 * Apply null-field penalties + Smart Plan critical-field gates to the
 * section-averaged overall confidence.
 *
 * predatorSpecies and trollingIntelligence are the two fields Smart Plan
 * actually consumes. A profile with empty species is functionally useless to
 * the app no matter how many sources the other sections found, so these cap the
 * overall score hard rather than just nudging it. Pure function — shared by
 * storage.save and the tests so there is exactly one implementation.
 *
 * @param {number} rawOverall   confidence averaged across sections (0-99)
 * @param {object} profile      incoming lake profile
 * @param {object} fieldStatus  profile.fieldStatus (exemption map)
 * @returns {{ percent: number, penalties: string[] }}
 */
function gateOverallConfidence(rawOverall, profile, fieldStatus = {}) {
  const lim = profile.limnology || {};
  const bio = profile.biology || profile.forage || {};
  const id = profile.identity || {};
  const trolling = profile.trollingIntelligence || profile.trolling || profile.fisheries || {};
  const penalties = [];
  const exempt = (path) => ['not_applicable', 'not_available_after_targeted_review'].includes(fieldStatus[path]?.status);
  let conf = rawOverall;

  // Limnology / identity null-field penalties (behavior preserved from the
  // previous inline scoring — 99% with no thermocline depth is misleading).
  if (lim.thermocline?.summerDepthFt == null && !exempt('limnology.thermocline.summerDepthFt')) { conf -= 8; penalties.push('thermocline.summerDepthFt'); }
  if (lim.oxygen?.depletionDepthFt == null && !exempt('limnology.oxygen.depletionDepthFt')) { conf -= 6; penalties.push('oxygen.depletionDepthFt'); }
  if (lim.waterClarity?.secchiFt == null && !exempt('limnology.waterClarity.secchiFt')) { conf -= 3; penalties.push('secchiFt'); }
  if (!bio.knownStockings?.length && !exempt('biology.knownStockings')) { conf -= 3; penalties.push('knownStockings'); }
  if (!id.damName && !exempt('identity.damName')) { conf -= 2; penalties.push('damName'); }
  if (!id.yearImpounded) { conf -= 2; penalties.push('yearImpounded'); }

  // ── Smart Plan critical fields — heavily weighted ──
  const hasPredatorSpecies = Array.isArray(bio.predatorSpecies) && bio.predatorSpecies.length > 0;
  const hasTrollingIntel = hasStructuredTrollingIntel(trolling);
  if (!hasPredatorSpecies && !exempt('biology.predatorSpecies')) {
    conf -= 28; penalties.push('predatorSpecies (empty — unusable for Smart Plan)');
  }
  if (!hasTrollingIntel && !exempt('fisheries.trollingIntelligence')) {
    conf -= 18; penalties.push('trollingIntelligence (empty — unusable for Smart Plan)');
  }

  // Hard caps — these two fields gate Smart Plan entirely. No amount of source
  // count in identity/limnology/habitat can make an empty-species profile useful.
  if (!hasPredatorSpecies && !exempt('biology.predatorSpecies')) conf = Math.min(conf, 45);
  if (!hasTrollingIntel && !exempt('fisheries.trollingIntelligence')) conf = Math.min(conf, 58);

  return { percent: Math.max(30, Math.min(99, conf)), penalties };
}

async function handleResearchAgent(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({success:false, error:"invalid JSON body"}), {status:400, headers:JSON_HEADERS}); }
  const lakeName = String(body.lakeName || body.lake || '').trim();
  const state = String(body.state || '').trim() || 'SC';
  const agentKey = String(body.agent || '').trim().toLowerCase();
  const previousResults = body.previousResults || body.context || {};
  if (!lakeName) return new Response(JSON.stringify({success:false, error:"missing lakeName"}), {status:400, headers:JSON_HEADERS});
  const agent = RESEARCH_AGENTS[agentKey];
  if (!agent) return new Response(JSON.stringify({success:false, error:`unknown agent ${agentKey}. Valid: ${Object.keys(RESEARCH_AGENTS).join(', ')}`}), {status:400, headers:JSON_HEADERS});

  // Ground identity agent with known LAKES constant to reduce hallucination
  let groundedPrev = previousResults;
  if (agentKey === 'identity') {
    const lookupKey = lakeKeyFromName(lakeName);
    const known = LAKES[lookupKey];
    if (known) {
      groundedPrev = {...previousResults, _knownBaseline: {lakeKey: lookupKey, ...known, note:"This is TrollMap curated baseline — verify against official sources, don't trust blindly"}};
    }
  }

  // Ground regulations agent with live eRegulations page — replaces LLM memory with actual current rules
  if (agentKey === 'regulations') {
    const regsUrls = {
      SC: 'https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits',
      NC: 'https://www.eregulations.com/northcarolina/fishing/warm-water-game-fish-regulations',
      GA: 'https://www.eregulations.com/georgia/fishing/game-species-daily-limits',
      TN: 'https://www.tn.gov/twra/fishing/regulations.html',
    };
    const regsUrl = regsUrls[state] || regsUrls.SC;
    try {
      const regsRes = await fetch(regsUrl, {
        headers: { 'User-Agent': 'TrollMap/15 Evidence Engine', 'Accept': 'text/html' },
        cf: { cacheTtl: 86400, cacheEverything: true }
      });
      if (regsRes.ok) {
        let regsText = await regsRes.text();
        regsText = regsText
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim()
          .slice(0, 30000);
        groundedPrev = {
          ...previousResults,
          _regsSource: {
            url: regsUrl,
            content: regsText,
            note: 'LIVE OFFICIAL REGULATIONS PAGE — use this as authoritative source. Extract ALL species rules that apply to ' + lakeName + '. For statewide rules, check if ' + lakeName + ' appears in any exception list. If not listed as an exception, the statewide rule applies. Do NOT use training data for specific limits.'
          }
        };
      }
    } catch (e) {
      console.warn('Regulations page fetch failed: ' + e.message);
    }
  }

  // Inject document text for agents that benefit from reading source material directly
  // limnology gets the EPA/water quality docs; biology gets the fisheries docs
  // fisheries gets fishing guide/report docs — seasonal behavior lives in these, not the profile
  // identity uses _extractedFacts only — raw docs make prompt too large for Cerebras TPM
  const docInjectionAgents = new Set(['limnology', 'biology', 'habitat', 'fisheries']);
  if (docInjectionAgents.has(agentKey) && previousResults._normalizedDocuments?.length) {
    const docFilter = {
      limnology: /epa|nscep|water.?qual|characteriz|nutrient|limnol/i,
      identity:  /epa|nscep|water.?qual|characteriz|sc.?lake|dnr/i,
      biology:   /striped.?bass|fisheries|biology|annual|species|stocking|fish|bass|crappie|catfish|pattern|forage|shad|herring|omnia|conventional|sportsman|tactic|guide/i,
      habitat:   /habitat|attractor|structure|dnr|sc.?lake/i,
      fisheries: /fish|bass|crappie|striper|catfish|pattern|season|depth|behavior|report|tactic|guide|omnia|conventional|sportsman/i,
    };
    const filter = docFilter[agentKey];
    // Gemini free-tier requests must stay comfortably below token-per-minute
    // limits. Limnology already receives extracted facts, so two focused source
    // excerpts are enough for table/profile confirmation; eight large docs made
    // the paid/free model route hit quota while biology still succeeded.
    const maxDocs = agentKey === 'limnology' ? 2 : agentKey === 'fisheries' ? 8 : 8;
    const charsPerDoc = agentKey === 'limnology' ? 15000 : agentKey === 'fisheries' ? 150000 : 40000;
    const relevantDocs = previousResults._normalizedDocuments
      .filter(d => !filter || filter.test(d.title + ' ' + d.url))
      .slice(0, maxDocs);
    if (relevantDocs.length) {
      const docContext = relevantDocs
        .map(d => `=== ${d.title} ===\n${d.text?.slice(0, charsPerDoc) || ''}`)
        .join('\n\n');
      groundedPrev = {
        ...groundedPrev,
        _documentContext: docContext,
        _documentContextNote: `Raw document text from ${relevantDocs.length} source(s) — use this for specific measurements, tables, and depth profiles. Prioritize this over training knowledge.`
      };
    }
  }

  // For regulations agent — filter facts to only regulation-relevant ones to keep prompt size manageable
  if (agentKey === 'regulations' && groundedPrev._extractedFacts?.length) {
    const regsCats = new Set(['sizeLimit_lakeSpecific','creelLimit_lakeSpecific','sizeLimit_general',
      'creelLimit_general','closedSeason','gearRestrictions','regulations_general','regulations']);
    groundedPrev = {
      ...groundedPrev,
      _extractedFacts: groundedPrev._extractedFacts
        .filter(f => regsCats.has(f.category) || /regulation|creel|limit|season|closed|gear|size.*limit|possession/i.test(f.category + ' ' + f.fact))
        .slice(0, 40)  // cap at 40 facts max
    };
  }

  // ── Fisheries agent: run one LLM call per species group for focused extraction ──
  // Running all 17 species in one call causes token budget compression — striper spring
  // and other minority-season data gets dropped. Split into groups, merge results.
  if (agentKey === 'fisheries') {
    // The client normally supplies the completed biology section. Keep a
    // compatibility fallback for older callers/resume payloads that only sent
    // predatorSpecies at the top level; otherwise fisheries silently receives
    // an empty list and creates zero groups.
    const bio = groundedPrev?.biology || {};
    const allSpecies = Array.isArray(bio.predatorSpecies)
      ? bio.predatorSpecies
      : (Array.isArray(groundedPrev?.predatorSpecies) ? groundedPrev.predatorSpecies : []);
    if (!Array.isArray(bio.predatorSpecies) && allSpecies.length) {
      bio.predatorSpecies = allSpecies;
    }
    console.log(`fisheries agent: received ${allSpecies.length} species from biology context`);

    // Dedup species before grouping:
    // Black Crappie / White Crappie are redundant with Crappie for trolling intel purposes
    // Merge them all into a single 'Crappie' representative to avoid 3 near-identical calls
    const SPECIES_MERGE = {
      'Black Crappie': 'Crappie',
      'White Crappie': 'Crappie',
      'Redear Sunfish Shellcracker': 'Redear Sunfish (Shellcracker)',
      'Redear Sunfish': 'Redear Sunfish (Shellcracker)',
    };
    const deduped = [];
    const dedupSeen = new Set();
    for (const s of allSpecies) {
      const canonical = SPECIES_MERGE[s] || s;
      if (!dedupSeen.has(canonical)) { dedupSeen.add(canonical); deduped.push(canonical); }
    }

    // Group species by fishing category
    const SPECIES_GROUPS = {
      bass:    ['Largemouth Bass', 'Smallmouth Bass', 'Spotted Bass', 'Alabama Bass', 'Striped Bass', 'White Bass', 'Yellow Bass', 'Redeye Bass'],
      crappie: ['Crappie'],
      catfish: ['Catfish', 'Blue Catfish', 'Flathead Catfish', 'Channel Catfish', 'Bullhead'],
      panfish: ['Bream', 'Bluegill', 'Redear Sunfish (Shellcracker)', 'Bowfin', 'White Perch', 'Yellow Perch', 'Walleye', 'Sauger'],
      other:   ['Pickerel', 'Chain Pickerel', 'Pike', 'Muskie', 'Trout', 'Brown Trout', 'Rainbow Trout', 'Brook Trout'],
    };

    // Assign each confirmed species to a group
    const grouped = {};
    const assigned = new Set();
    for (const [group, members] of Object.entries(SPECIES_GROUPS)) {
      const matched = deduped.filter(s => members.some(m => s.toLowerCase().includes(m.toLowerCase()) || m.toLowerCase().includes(s.toLowerCase())));
      if (matched.length) { grouped[group] = matched; matched.forEach(s => assigned.add(s)); }
    }
    // Any unmatched species go into 'other'
    const unmatched = deduped.filter(s => !assigned.has(s));
    if (unmatched.length) grouped['other'] = [...(grouped['other'] || []), ...unmatched];

    const groupEntries = Object.entries(grouped).filter(([, sp]) => sp.length > 0);
    console.log(`fisheries agent: ${allSpecies.length} species split into ${groupEntries.length} groups: ${groupEntries.map(([g,sp]) => `${g}(${sp.length})`).join(', ')}`);

    // Build a per-group prompt using the same userTemplate but with a filtered species list
    const buildGroupPrompt = (groupSpecies) => {
      const groupPrev = { ...groundedPrev, biology: { ...bio, predatorSpecies: groupSpecies } };
      return agent.userTemplate(lakeName, state, groupPrev);
    };

    // Run all groups concurrently
    const groupPromises = groupEntries.map(async ([groupName, groupSpecies]) => {
      const userPrompt = buildGroupPrompt(groupSpecies);
      const payload = {
        messages: [
          { role: "system", content: agent.system },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: 5000,
        response_format: { type: "json_object" }
      };
      try {
        const llmResult = await callLLM(env, payload, null);
        const rawText = extractLLMText(llmResult.data);
        const parsed = extractJsonPossibly(rawText);
        if (!parsed) {
          console.warn(`fisheries group ${groupName}: non-JSON response`);
          return {};
        }
        return parsed.trollingIntelligence || parsed[agentKey] || parsed || {};
      } catch (e) {
        console.warn(`fisheries group ${groupName} failed: ${e.message}`);
        return {};
      }
    });

    const groupResults = await Promise.all(groupPromises);

    // Merge all group results into single trollingIntelligence object
    const mergedIntelligence = {};
    for (const groupResult of groupResults) {
      for (const [species, seasons] of Object.entries(groupResult)) {
        if (species === 'sources') continue;
        mergedIntelligence[species] = seasons;
      }
    }

    // Run normalization pass (same as post-processing below)
    const SEASONS = ['spring', 'summer', 'fall', 'winter'];
    const normalizedMerged = {};
    for (const [species, seasons] of Object.entries(mergedIntelligence)) {
      if (!seasons || typeof seasons !== 'object') { normalizedMerged[species] = seasons; continue; }
      const normSeasons = {};
      for (const season of SEASONS) {
        const entry = seasons[season];
        if (entry === null || entry === undefined) {
          normSeasons[season] = null;
        } else if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'number') {
          normSeasons[season] = { preferredDepth: entry, structures: [], forage: [], recommendedPresentations: [], notes: null };
        } else if (typeof entry === 'object' && !Array.isArray(entry)) {
          normSeasons[season] = {
            preferredDepth: Array.isArray(entry.preferredDepth) && entry.preferredDepth.length === 2 ? entry.preferredDepth : null,
            structures: Array.isArray(entry.structures) ? entry.structures : [],
            forage: Array.isArray(entry.forage) ? entry.forage : [],
            recommendedPresentations: Array.isArray(entry.recommendedPresentations) ? entry.recommendedPresentations : [],
            notes: entry.notes || null
          };
        } else {
          normSeasons[season] = null;
        }
      }
      normalizedMerged[species] = normSeasons;
    }

    const elapsed = Date.now();
    return new Response(JSON.stringify({
      success: true,
      agent: agentKey,
      section: normalizedMerged,
      confidence: { percent: 35 },
      meta: { model: 'multi-group', provider: 'gemini-free' },
      sources: [{ label: 'Derived from lake profile and source documents', trust: 'DERIVED' }]
    }), { headers: JSON_HEADERS });
  }

  const systemPrompt = agent.system;
  const userPrompt = agent.userTemplate(lakeName, state, groundedPrev);
  
  // Safety check — if prompt is too large, truncate _extractedFacts further
  const promptLen = systemPrompt.length + userPrompt.length;
  if (promptLen > 80000 && groundedPrev._extractedFacts?.length > 5) {
    console.warn(`handleResearchAgent: ${agentKey} prompt too large (${promptLen} chars) — truncating facts`);
    groundedPrev = { ...groundedPrev, _extractedFacts: groundedPrev._extractedFacts.slice(0, 5) };
  }

  const payload = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.1,
    max_tokens: agentKey === 'trolling' ? 2000 : agentKey === 'summary' ? 800 : agentKey === 'fisheries' ? 8000 : 3000,
    response_format: { type: "json_object" }
  };

  const start = Date.now();
  let llmResult;
  try {
    // Use the exact same default free-tier routing chain as biology, habitat,
    // identity, and regulations. Limnology used to force the Gemini route,
    // bypassing the successful default fallback/rate routing used by the other
    // agents even when they ultimately reported Flash-Lite.
    llmResult = await callLLM(env, payload, null);
  } catch (e) {
    return new Response(JSON.stringify({success:false, error:`LLM failed: ${e.message}`, agent: agentKey, lakeName}), {status: 502, headers: JSON_HEADERS});
  }
  const rawText = extractLLMText(llmResult.data);
  const parsed = extractJsonPossibly(rawText);
  if (!parsed) {
    return new Response(JSON.stringify({success:false, error:"Agent returned non-JSON", raw: rawText.slice(0, 800), agent: agentKey}), {status: 502, headers: JSON_HEADERS});
  }

  const dataKey = agent.expectedKey;
  let sectionData = (parsed[dataKey] && Object.keys(parsed[dataKey]).length > 0) ? parsed[dataKey] : (parsed[agentKey] && Object.keys(parsed[agentKey] || {}).length > 0) ? parsed[agentKey] : parsed;
  const sources = parsed.sources || sectionData?.sources || [];

  // Sanitize limnology output — coerce string "null" and range strings to proper types
  if (agentKey === 'limnology' && sectionData) {
    const lim = sectionData;
    const coerceNum = (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        if (v === 'null' || v === '' || v === 'unknown') return null;
        // Range string like "16-22" — take midpoint
        const rangeMatch = v.match(/^([\d.]+)\s*[-–]\s*([\d.]+)$/);
        if (rangeMatch) return Math.round((parseFloat(rangeMatch[1]) + parseFloat(rangeMatch[2])) / 2);
        const num = parseFloat(v);
        return isFinite(num) ? num : null;
      }
      return null;
    };
    if (lim.thermocline) {
      lim.thermocline.summerDepthFt = coerceNum(lim.thermocline.summerDepthFt);
    }
    if (lim.oxygen) {
      lim.oxygen.depletionDepthFt = coerceNum(lim.oxygen.depletionDepthFt);
      lim.oxygen.anoxicBelowFt = coerceNum(lim.oxygen.anoxicBelowFt);
    }
    if (lim.waterClarity) {
      lim.waterClarity.secchiFt = coerceNum(lim.waterClarity.secchiFt);
    }
    lim.hydraulicRetentionDays = coerceNum(lim.hydraulicRetentionDays) ?? lim.hydraulicRetentionDays;
    lim.seasonalDrawdownFt = coerceNum(lim.seasonalDrawdownFt) ?? lim.seasonalDrawdownFt;
  }

  // Sanitize regulations output — fix malformed creelLimits/sizeLimits
  // Agent sometimes returns these as strings or arrays instead of {species: limit} objects
  if (agentKey === 'regulations' && sectionData) {
    const cleanCreel = {};
    const cleanSize = {};
    const lsr = sectionData.lakeSpecificRegulations || {};

    // If creelLimits/sizeLimits came back as a string or array, they're malformed — discard them
    // so the deterministic parser's correct values aren't overwritten with garbage
    const creelSource = (lsr.creelLimits && typeof lsr.creelLimits === 'object' && !Array.isArray(lsr.creelLimits))
      ? lsr.creelLimits : {};
    const sizeSource = (lsr.sizeLimits && typeof lsr.sizeLimits === 'object' && !Array.isArray(lsr.sizeLimits))
      ? lsr.sizeLimits : {};

    // Only keep properly keyed species entries (not creel_0, creel_1, size_0, etc.)
    const numberedKeyPattern = /^(creel|size|limit)_\d+$/i;
    for (const [k, v] of Object.entries(creelSource)) {
      if (!numberedKeyPattern.test(k) && typeof v === 'string') cleanCreel[k] = v;
    }
    for (const [k, v] of Object.entries(sizeSource)) {
      if (!numberedKeyPattern.test(k) && typeof v === 'string') cleanSize[k] = v;
    }
    // Also filter specialRules — remove nongame device garbage and misplaced creel/size rules
    const cleanSpecialRules = (lsr.specialRules || []).filter(r =>
      typeof r === 'string' && r.length < 200 && !/Allowable Nongame Devices|Marking of Nongame|Facebook RSS/i.test(r)
      && !/\d+\s*(inch|in\b|fish|per day|creel|possession|limit)/i.test(r) // misplaced limits
    );

    sectionData = {
      ...sectionData,
      lakeSpecificRegulations: {
        ...lsr,
        creelLimits: cleanCreel,
        sizeLimits: cleanSize,
        specialRules: cleanSpecialRules
      }
    };
  }

  // Normalize habitat output — fix string fields that should be arrays
  // The habitat agent sometimes writes cover/riprapLocations/namedCreekMouths as comma-separated strings
  if (agentKey === 'habitat' && sectionData && typeof sectionData === 'object') {
    const ARRAY_FIELDS = ['cover', 'riprapLocations', 'namedCreekMouths', 'artificialHabitat'];
    for (const field of ARRAY_FIELDS) {
      const val = sectionData[field];
      if (typeof val === 'string' && val.trim()) {
        // Convert comma-separated string to array
        sectionData[field] = val.split(',').map(s => s.trim()).filter(Boolean);
      } else if (val == null) {
        sectionData[field] = [];
      }
    }
  }

  // Normalize trollingIntelligence — fix bare array season entries like [5, 15]
  // Agent sometimes shortcuts secondary species to just a depth array instead of full season object
  if (agentKey === 'fisheries' && sectionData && typeof sectionData === 'object') {
    console.log(`[fisheries-debug] sectionData keys: ${Object.keys(sectionData).join(', ')}`);
    console.log(`[fisheries-debug] first entry sample: ${JSON.stringify(Object.entries(sectionData)[0])?.slice(0, 200)}`);
    const SEASONS = ['spring', 'summer', 'fall', 'winter'];
    const normalized = {};
    for (const [species, seasons] of Object.entries(sectionData)) {
      if (species === 'sources') { normalized[species] = seasons; continue; }
      if (!seasons || typeof seasons !== 'object') { normalized[species] = seasons; continue; }
      const normSeasons = {};
      for (const season of SEASONS) {
        const entry = seasons[season];
        if (entry === null || entry === undefined) {
          normSeasons[season] = null;
        } else if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'number') {
          // Bare depth array — promote to full season object
          normSeasons[season] = {
            preferredDepth: entry,
            structures: [],
            forage: [],
            recommendedPresentations: [],
            notes: null
          };
        } else if (typeof entry === 'object' && !Array.isArray(entry)) {
          // Full object — ensure all required keys present
          normSeasons[season] = {
            preferredDepth: Array.isArray(entry.preferredDepth) && entry.preferredDepth.length === 2 ? entry.preferredDepth : null,
            structures: Array.isArray(entry.structures) ? entry.structures : [],
            forage: Array.isArray(entry.forage) ? entry.forage : [],
            recommendedPresentations: Array.isArray(entry.recommendedPresentations) ? entry.recommendedPresentations : [],
            notes: entry.notes || null
          };
        } else {
          normSeasons[season] = null;
        }
      }
      normalized[species] = normSeasons;
    }
    sectionData = normalized;
  }

  const hasData = sectionData && (typeof sectionData === 'object' ? Object.keys(sectionData).filter(k => k !== 'sources').length > 0 : true);
  const confidence = calculateSectionConfidence(sources, hasData, agentKey, sectionData);

  return new Response(JSON.stringify({
    success: true,
    agent: agentKey,
    label: agent.label,
    order: agent.order,
    lakeName,
    state,
    data: parsed,
    section: sectionData,
    sectionKey: dataKey,
    sources,
    confidence,
    meta: {
      provider: llmResult.provider,
      model: llmResult.model,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString()
    },
    raw: rawText.slice(0, 2000)
  }), {headers: JSON_HEADERS});
}

// ─── PER-AGENT PIPELINE ENDPOINT ───
// Orchestrates: discover → fetch → extract → enrich for a SINGLE agent
// POST /research/agent { lakeName, state, agent, mode, targetFields, previousResults }
async function handleResearchAgentPipeline(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({success:false, error:"invalid JSON body"}), {status:400, headers:JSON_HEADERS}); }
  const lakeName = String(body.lakeName || body.lake || '').trim();
  const state = String(body.state || '').trim() || 'SC';
  const agentKey = String(body.agent || '').trim().toLowerCase();
  const mode = String(body.mode || 'full').trim(); // 'full' or 'resume'
  const targetFields = Array.isArray(body.targetFields) ? body.targetFields : [];
  const previousResults = body.previousResults || {};

  if (!lakeName) return new Response(JSON.stringify({success:false, error:"missing lakeName"}), {status:400, headers:JSON_HEADERS});
  if (!agentKey) return new Response(JSON.stringify({success:false, error:"missing agent"}), {status:400, headers:JSON_HEADERS});
  if (!RESEARCH_AGENTS[agentKey]) return new Response(JSON.stringify({success:false, error:`unknown agent ${agentKey}`}), {status:400, headers:JSON_HEADERS});

  try {
    // Step 1: Discover sources for this agent
    const discoverReq = new Request('internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lakeName, state, agent: agentKey, reservoirOwner: body.reservoirOwner, predatorSpecies: body.predatorSpecies })
    });
    const discoverRes = await handleResearchDiscover(discoverReq, env);
    if (!discoverRes.ok) throw new Error(`Discover failed: ${discoverRes.status}`);
    const discoverData = await discoverRes.json();
    if (!discoverData.success) throw new Error(discoverData.error || 'Discovery failed');
    const sources = discoverData.sources || [];

    // Filter sources for this agent
    const agentSources = sources.filter(s => s.agentTags?.includes(agentKey) || !s.agentTags);
    if (!agentSources.length) {
      return new Response(JSON.stringify({ success: true, agent: agentKey, section: {}, factsCount: 0, docsUsed: 0, note: 'No sources found for this agent' }), { headers: JSON_HEADERS });
    }

    // Step 2: Fetch/normalize documents (if mode=full) or load existing (if mode=resume)
    let normalizedDocuments = [];
    if (mode === 'full') {
      // Regulations agent: data is in KV-cached deterministic facts — no docs needed
      if (agentKey === 'regulations') {
        console.log(`[agent-pipeline] regulations: skipping fetch — data from deterministic facts KV cache`);
      } else {
        // Load existing normalized docs for this lake — skip anything already fresh
        let existingDocs = [];
        try {
          const normRes = await handleResearchGetNormalized(env, lakeName);
          if (normRes.ok) {
            const normData = await normRes.json();
            existingDocs = normData.documents || [];
          }
        } catch (_) {}

        // TTL map by source type — how long before we refetch (ms)
        const TTL_MS = {
          academic:   365 * 24 * 60 * 60 * 1000, // SEAFWA, USGS, EPA surveys — static forever
          official:   90  * 24 * 60 * 60 * 1000, // SCDNR, eRegulations, FERC — annual cycles
          news:       30  * 24 * 60 * 60 * 1000, // SCDNR news, stocking updates
          anecdotal:  14  * 24 * 60 * 60 * 1000, // fishing reports, tournament results, social
        };

        function getDocTtl(url) {
          const u = String(url || '').toLowerCase();
          if (/seafwa\.org|usgs\.gov|nepis\.epa\.gov|epa\.gov|asmfc\.org|apms\.org|seafwa|\.edu/.test(u)) return TTL_MS.academic;
          if (/dnr\.sc\.gov|ncwildlife\.org|georgiawildlife|tn\.gov|eregulations\.com|ferc\.gov|duke-energy\.com|santeecooper\.com|usace\.army\.mil/.test(u)) return TTL_MS.official;
          if (/news|report|stocking|annual|trends|freshwater\.html|fishing-report/.test(u)) return TTL_MS.news;
          return TTL_MS.anecdotal;
        }

        const existingByUrl = new Map(existingDocs.map(d => [String(d.url || '').split('?')[0].toLowerCase(), d]));
        const now = Date.now();

        for (const src of agentSources) {
          // Skip PDF/HTML already in R2 and still fresh
          const normUrl = String(src.url || '').split('?')[0].toLowerCase();
          const existing = existingByUrl.get(normUrl);
          if (existing?.fetchedAt) {
            // If we have an etag, use conditional fetch — let the origin tell us if it changed
            if (existing.etag) {
              try {
                const condResult = await tinyfishFetch({
                  urls: [src.url],
                  format: 'markdown',
                  if_none_match: existing.etag,
                  include_etag_and_last_modified: true,
                  ttl: 0 // bypass TinyFish cache for conditional check
                }, env);
                const condPage = condResult.results?.[0];
                if (condPage?.not_modified) {
                  console.log(`[agent-pipeline] etag hit (not modified): ${src.url.slice(0,80)}`);
                  const merged = { ...existing, agentTags: [...new Set([...(existing.agentTags || []), agentKey])] };
                  normalizedDocuments.push(merged);
                  existingByUrl.set(normUrl, merged);
                  continue;
                } else if (condPage?.text && condPage.text.length > 200) {
                  console.log(`[agent-pipeline] etag miss (content changed): ${src.url.slice(0,80)}`);
                  const doc = {
                    title: src.title, url: src.url, fullText: condPage.text,
                    agentTags: [...new Set([...(src.agentTags || [agentKey]), agentKey])],
                    discoveredBy: src.discoveredBy || agentKey,
                    fetchedAt: new Date().toISOString(),
                    etag: condPage.etag || null,
                    lastModified: condPage.last_modified || null,
                  };
                  normalizedDocuments.push(doc);
                  existingByUrl.set(normUrl, doc);
                  continue;
                }
                // Fall through to full fetch if conditional fetch failed
              } catch (condErr) {
                console.warn(`[agent-pipeline] conditional fetch failed for ${src.url}: ${condErr.message} — falling through to full fetch`);
              }
            } else {
              // No etag — fall back to TTL-based check
              const age = now - new Date(existing.fetchedAt).getTime();
              const ttl = getDocTtl(src.url);
              if (age < ttl) {
                console.log(`[agent-pipeline] cache hit (${Math.round(age/86400000)}d old, ttl ${Math.round(ttl/86400000)}d): ${src.url.slice(0,80)}`);
                const merged = { ...existing, agentTags: [...new Set([...(existing.agentTags || []), agentKey])] };
                normalizedDocuments.push(merged);
                existingByUrl.set(normUrl, merged);
                continue;
              } else {
                console.log(`[agent-pipeline] cache stale (${Math.round(age/86400000)}d old, ttl ${Math.round(ttl/86400000)}d) — refetching: ${src.url.slice(0,80)}`);
              }
            }
          }

          // Not cached or stale — fetch it
          try {
            const proxyReq = new Request(`https://internal/research/proxy-download?url=${encodeURIComponent(src.url)}&type=${src.type || 'HTML'}`, {
              method: 'GET',
            });
            const proxyRes = await handleResearchProxyDownload(proxyReq, env);
            if (proxyRes.ok) {
              const xSource = proxyRes.headers?.get('X-Source') || 'unknown';
              const xEtag = proxyRes.headers?.get('ETag') || proxyRes.headers?.get('X-ETag') || null;
              const xLastModified = proxyRes.headers?.get('Last-Modified') || proxyRes.headers?.get('X-Last-Modified') || null;
              // Content-Type determines text vs binary — TinyFish returns text/plain even for
              // PDF URLs it extracted. Only binary application/pdf needs PDF.js on the Worker
              // side; but Workers don't have PDF.js — binary PDFs must be returned to client.
              // So here we accept text responses and skip binary ones (client handles via
              // lake-research-engine.js which has PDF.js access).
              const ct = proxyRes.headers?.get('Content-Type') || '';
              let text = '';
              if (ct.includes('application/pdf')) {
                // Binary PDF came back — this shouldn't happen in Worker-side pipeline
                // (proxy-download should have extracted it via TinyFish). Log and skip;
                // the client-side runner (lake-research-engine.js) will handle this URL
                // with PDF.js when it processes the source list directly.
                console.warn(`[agent-pipeline] binary PDF returned by proxy for ${src.url.slice(0,80)} — skipping Worker-side; client will handle`);
              } else {
                text = await proxyRes.text();
              }
              if (text && text.length > 200) {
                const doc = {
                  title: src.title, url: src.url, fullText: text,
                  agentTags: src.agentTags || [agentKey],
                  discoveredBy: src.discoveredBy || agentKey,
                  fetchedAt: new Date().toISOString(),
                  etag: xEtag,
                  lastModified: xLastModified,
                  snippet: src.snippet || null,
                  siteName: src.siteName || null,
                  publishedDate: src.publishedDate || null,
                  prefetchScore: src.prefetchScore || null,
                };
                normalizedDocuments.push(doc);
                existingByUrl.set(normUrl, doc);
                console.log(`[agent-pipeline] fetched (${xSource}, ${text.length} chars): ${src.url.slice(0,80)}`);
              } else if (!ct.includes('application/pdf')) {
                console.warn(`[agent-pipeline] fetch returned insufficient content (${text.length} chars) via ${xSource}: ${src.url.slice(0,80)}`);
              }
            } else {
              console.warn(`[agent-pipeline] proxy download HTTP ${proxyRes.status} for ${src.url.slice(0,80)}`);
            }
          } catch (e) {
            console.warn(`Proxy download failed for ${src.url}: ${e.message}`);
          }
        }

        // Merge new/updated docs back into R2 — don't overwrite docs from other agents
        if (normalizedDocuments.length) {
          // Build merged list: existing docs not touched by this run + new/refreshed docs
          const updatedUrls = new Set(normalizedDocuments.map(d => String(d.url || '').split('?')[0].toLowerCase()));
          const untouched = existingDocs.filter(d => !updatedUrls.has(String(d.url || '').split('?')[0].toLowerCase()));
          const merged = [...untouched, ...normalizedDocuments];
          const saveReq = new Request('internal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lakeName, documents: merged })
          });
          await handleResearchSaveNormalized(saveReq, env);
        }
      }
    } else {
      // Resume mode: load existing normalized docs and filter by agentTags
      const normRes = await handleResearchGetNormalized(env, lakeName);
      if (normRes.ok) {
        const normData = await normRes.json();
        normalizedDocuments = (normData.documents || []).filter(d => d.agentTags?.includes(agentKey));
      }
    }

    if (!normalizedDocuments.length) {
      return new Response(JSON.stringify({ success: true, agent: agentKey, section: {}, factsCount: 0, docsUsed: 0, note: 'No documents available for this agent' }), { headers: JSON_HEADERS });
    }

    // Step 3: Extract facts with targetFields
    const analyzeReq = new Request('internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lakeName,
        baseName: lakeName.replace(/^Lake\s+/i,'').replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i,'').trim(),
        state,
        docIndex: 0,
        documents: normalizedDocuments.slice(0, 12).map(d => ({ title: d.title, url: d.url, text: d.fullText?.slice(0, 150000) }))
      })
    });
    const analyzeRes = await handleResearchAnalyzeFacts(analyzeReq, env);
    if (!analyzeRes.ok) throw new Error(`Analyze facts failed: ${analyzeRes.status}`);
    const analyzeData = await analyzeRes.json();
    const extractedFacts = analyzeData.extracted_facts || [];

    // Step 4: Deduplicate
    const dedupeReq = new Request('internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facts: extractedFacts })
    });
    const dedupeRes = await handleResearchDedupeContradictions(dedupeReq, env);
    let uniqueFacts = extractedFacts;
    if (dedupeRes.ok) {
      const dedupeData = await dedupeRes.json();
      uniqueFacts = dedupeData.deduplicated_facts || extractedFacts;
    }

    // Step 5: Run agent enrichment
    const agentReq = new Request('internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lakeName,
        state,
        agent: agentKey,
        previousResults: {
          ...previousResults,
          _extractedFacts: uniqueFacts,
          _normalizedDocuments: normalizedDocuments.slice(0, agentKey === 'fisheries' ? 25 : 12).map(d => ({ title: d.title, url: d.url, text: d.fullText?.slice(0, agentKey === 'fisheries' ? 150000 : 40000) }))
        }
      })
    });
    const agentRes = await handleResearchAgent(agentReq, env);
    if (!agentRes.ok) throw new Error(`Agent ${agentKey} failed: ${agentRes.status}`);
    const agentData = await agentRes.json();

    return new Response(JSON.stringify({
      success: true,
      agent: agentKey,
      section: agentData.section,
      confidence: agentData.confidence,
      sources: agentData.sources,
      factsCount: uniqueFacts.length,
      docsUsed: normalizedDocuments.length,
      docTitles: normalizedDocuments.map(d => d.title?.slice(0, 80)),
      factsSample: uniqueFacts.slice(0, 5).map(f => `[${f.category}] ${String(f.fact||'').slice(0,80)}`),
      queryLog: discoverData.queryLog || [],
    }), { headers: JSON_HEADERS });

  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message, agent: agentKey }), { status: 502, headers: JSON_HEADERS });
  }
}

export { RESEARCH_AGENTS, calculateSectionConfidence, gateOverallConfidence, hasStructuredTrollingIntel, handleResearchAgent, handleResearchAgentPipeline };
