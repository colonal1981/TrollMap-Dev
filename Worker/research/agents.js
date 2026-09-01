// research/agents.js — split from worker-research.js (behavior-preserving) 
import { JSON_HEADERS, callLLM, extractLLMText } from '../worker-core.js';
import { fetchDukeOperatingRange } from '../worker-data.js';
import { dukePoolManagement } from '../conditions.js';
import { lakeIndex, resolveRegistryRow } from '../registry.js';
// MOVED 2026-08-31. identityGrounding() assembles the registry identity and the live pool
// numbers, and this file handed the result to an LLM as context. That is backwards: it is a
// deterministic fact, so it now lives in deterministic.js, is written straight into the
// profile there, and is imported here only for as long as the identity agent still runs.
import { identityGrounding } from './deterministic.js';
import { fetchStateRegulations, getLakeRegulations,
         fetchSaltwaterRegulations, fetchLiveRegsAmendments } from './clients.js';
import { extractJsonPossibly } from './keys.js';
import { parseBehaviour, behaviourBlock } from './behaviour.js';
import {
  COASTAL_AGENTS, COASTAL_AGENT_HINTS, COASTAL_SKIPPED_AGENTS,
  isCoastalZone, coastalAgentPlan,
} from './coastal-agents.js';
import { coerceNum } from '../../js/utils/coerce.js';

/**
 * Fit an agent prompt inside a character budget by dropping facts, MEASURING AFTER EACH CUT.
 *
 * Pure, and separated out precisely because the inline version could not be tested: it mutated
 * the context object after the prompt string had already been built, so the cut never reached
 * the wire. A budget check that does not re-measure is a log line, not a guard.
 */
export function fitPromptToBudget(systemPrompt, buildUser, grounded, budget = 80000) {
  const sys = String(systemPrompt || '');
  let g = grounded;
  let user = buildUser(g);
  const before = sys.length + user.length;
  if (before <= budget) return { userPrompt: user, grounded: g, truncatedTo: null, over: false, before, size: before };
  for (const keep of [5, 2, 0]) {
    if (!Array.isArray(g._extractedFacts) || g._extractedFacts.length <= keep) continue;
    g = { ...g, _extractedFacts: g._extractedFacts.slice(0, keep) };
    user = buildUser(g);
    const size = sys.length + user.length;
    if (size <= budget) return { userPrompt: user, grounded: g, truncatedTo: keep, over: false, before, size };
  }
  const size = sys.length + user.length;
  return { userPrompt: user, grounded: g, truncatedTo: 0, over: true, before, size };
}


/**
 * The profile WITHOUT the transient carriers, for prompts that dump it as JSON.
 *
 * `prev` arrives carrying `_documentContext` -- the full text of every selected document -- and
 * `_normalizedDocuments`, which is that same text a second time. The fisheries prompt dumped
 * `JSON.stringify(prev).slice(0, 12000)` at the top and then appended `_documentContext` in full
 * below it, so the "lake profile" the agent was handed was mostly a truncated duplicate of the
 * documents, and the limnology, forage and biology it was actually told to use fell off the end
 * of the 12,000 character slice.
 *
 * The summary agent already deleted these by hand before its own dump. This is that, shared.
 */
/**
 * THE ONE GROUP-TERM MAP AND THE ONE REDISTRIBUTOR, because there were two of each and they
 * disagreed. The fisheries agent has two routes into a trollingIntelligence section -- the
 * per-group fan-out and the single-shot fallback -- and each carried its own copy of this table
 * and its own copy of the loop below. The copies had already drifted: the group map listed
 * `catfish`, the fallback map did not.
 *
 * `crappie` and `catfish` are keys here AND real canonical names in RESEARCH_SPECIES_CANON. They
 * are what the deterministic pass writes into predatorSpecies -- NC WRC's "Crappie (Unspecified)"
 * canonicalises to "Crappie" on 52 waters, and the GA DNR lake pages name "Crappie" outright. So
 * a model handed predatorSpecies:['Crappie'] answers with the key "Crappie", which is correct,
 * and the old loop read the correct answer as a group label, redistributed it into itself and
 * then deleted it. Measured 2026-09-01 on the first cold run: Lake Sidney Lanier (Hall Co, GA)
 * returned 4 species out of a confirmed 5 and the one it lost was Crappie.
 *
 * Hence `confirmed.has(keyLower)` guards the whole branch: a key that is itself a confirmed
 * species is an answer, not a label. A real group term -- "Black Bass" is confirmed on no lake --
 * still splits the way it always did.
 */
const GROUP_TERM_MAP = {
  'black bass': ['Largemouth Bass', 'Smallmouth Bass', 'Spotted Bass'],
  'catfish (all species)': ['Blue Catfish', 'Channel Catfish', 'Flathead Catfish'],
  'catfish': ['Blue Catfish', 'Channel Catfish', 'Flathead Catfish'],
  'crappie (all species)': ['Crappie', 'Black Crappie', 'White Crappie'],
  'crappie': ['Crappie', 'Black Crappie', 'White Crappie'],
  'bream/sunfish': ['Bluegill', 'Redear Sunfish (Shellcracker)', 'Warmouth'],
  'bluegill/warmouth': ['Bluegill', 'Warmouth'],
  'striped bass or hybrid striped bass': ['Striped Bass', 'Hybrid Striped Bass'],
};

/** Mutates `section` in place: splits group-term keys onto the confirmed species they cover. */
function redistributeGroupTerms(section, confirmed) {
  for (const [key, seasons] of Object.entries(section)) {
    const keyLower = key.toLowerCase();
    if (!GROUP_TERM_MAP[keyLower] || confirmed.has(keyLower)) continue;
    const targets = GROUP_TERM_MAP[keyLower].filter((t) => confirmed.has(t.toLowerCase()));
    if (!targets.length) continue;
    console.log(`[fisheries-redist] redistributing "${key}" -> ${targets.join(', ')}`);
    for (const target of targets) {
      if (!section[target]) {
        section[target] = JSON.parse(JSON.stringify(seasons));
        continue;
      }
      for (const season of ['spring', 'summer', 'fall', 'winter']) {
        if (!section[target][season] && seasons[season]) {
          section[target][season] = JSON.parse(JSON.stringify(seasons[season]));
        }
      }
    }
    delete section[key];
  }
}

function cleanProfile(prev) {
  const out = { ...(prev || {}) };
  delete out._documentContext;
  delete out._documentContextNote;
  delete out._normalizedDocuments;
  if (Array.isArray(out._extractedFacts)) out._extractedFacts = out._extractedFacts.slice(0, 80);
  return out;
}

/**
 * The model's answer to "where are these fish sitting", made robust.
 *
 * Accepting exactly 'suspended', 'bottom' or 'both' and nulling everything else makes a value the
 * normaliser could not READ indistinguishable from the agent declining to ANSWER -- and that
 * distinction is the only thing telling you whether to fix the prompt or fix this function.
 * "Suspended", "near bottom", "water column" and "suspended/bottom" all failed the strict check.
 *
 * Anything it still cannot place goes into `rejected` and is reported, rather than quietly
 * becoming null.
 */
function coerceHolding(v, rejected) {
  if (v == null || v === '') return null;
  const t = String(v).toLowerCase().trim();
  if (/unknown|unclear|not stated|n\/a|^none$|^null$/.test(t)) return null;
  const susp = /suspend|water column|above the thermocline|open water|pelagic|up off|mid.?water/.test(t);
  const bott = /bottom|benthic|on the floor|hugging|substrate/.test(t);
  if ((susp && bott) || /\bboth\b|mixed|two groups/.test(t)) return 'both';
  if (susp) return 'suspended';
  if (bott) return 'bottom';
  if (Array.isArray(rejected)) rejected.push(String(v).slice(0, 60));
  return null;
}

var RESEARCH_AGENTS = {
  identity: {
    label: "Lake Identity",
    order: 1,
    system: "You are a data assembly agent for lake identity and pool management data. Map extracted facts to the JSON fields. CRITICAL RULES: (1) surfaceAreaAcres must be in ACRES — if source gives km², multiply by 247.1; (2) maxDepthFt is actual water depth — NEVER use pool elevation as depth; (3) For Duke Energy CRA pool tables the columns are: Month | Guide Curve ft | Minimum ft | Maximum ft in local datum; (4) riverSystem must be a river/watershed name like 'Saluda River' or 'Catawba-Wateree' — NEVER a HUC code or monitoring site description; (5) archetype must be a lake type like 'large hydroelectric reservoir' — NEVER a water quality site type like 'other-surface water site'; (6) Never invent values. Return ONLY valid JSON. (8) county: use an array for multi-county or multi-state lakes (e.g. ['York, SC', 'Gaston, NC', 'Mecklenburg, NC']). For single county use a string. Never leave null if county information is present in the facts. (7) normalPoolFt is the STATIC full pool surface elevation in feet NGVD/NAVD (e.g. 265.3, 385.5, 569.4, 75.5) — NEVER a daily fluctuation range, drawdown amount, or year range. If you see phrases like 'fluctuate up to X feet', 'averaging X feet per day', 'up to X feet daily', or 'X feet year-round fluctuation', those are fluctuation amounts NOT pool elevations — set normalPoolFt to null. If the only pool number is a fluctuation or a year range, set normalPoolFt to null. Valid pool elevations are typically 3-digit numbers (e.g. 265, 385, 569) for NGVD/NAVD, or 2-digit numbers representing local datum (e.g. 97 for Duke Energy lakes). Single-digit or ambiguous numbers should be set to null unless clearly labeled as pool elevation.",
    userTemplate: (lakeName, state, prev) => {
      const facts = prev?._extractedFacts || [];

      // ── Bathymetry-derived depth values from TrollMap contour/depth-area polygons ──
      // These are the highest-trust depth measurements — direct hypsometric calculations
      // from our own chart data. They take precedence over LLM training data and
      // document-extracted facts. Inject them into the prompt so the LLM uses them
      // verbatim instead of hallucinating different numbers.
      const prevIdentity = prev?.identity || {};
      const bathySurfaceArea = prevIdentity.surfaceAreaAcres != null ? prevIdentity.surfaceAreaAcres : null;
      const bathyMaxDepth = prevIdentity.maxDepthFt != null ? prevIdentity.maxDepthFt : null;
      const bathyAvgDepth = prevIdentity.averageDepthFt != null ? prevIdentity.averageDepthFt : null;
      const hasBathymetry = prevIdentity._geometryDerived === true;
      const bathyMeta = prevIdentity._bathymetryMeta || null;

      const surfaceFact = facts.find(f => f.category === 'surfaceArea' && /acre/i.test(f.fact))
        || facts.find(f => f.category === 'surfaceArea');
      const surfaceArea = bathySurfaceArea !== null ? bathySurfaceArea : (surfaceFact ? (() => {
        const m = surfaceFact.fact.match(/([\d,]+(?:\.\d+)?)\s*acres?/i);
        if (m) return parseFloat(m[1].replace(',',''));
        const km = surfaceFact.fact.match(/([\d,]+(?:\.\d+)?)\s*km/i);
        if (km) return Math.round(parseFloat(km[1].replace(',','')) * 247.1);
        return null;
      })() : null);

      const maxFact = facts.find(f => f.category === 'maxDepthFt' && !/225|pool|elevation/i.test(f.fact));
      const maxDepth = bathyMaxDepth !== null ? bathyMaxDepth : (maxFact ? (() => {
        const m = maxFact.fact.match(/([\d.]+)\s*f(?:ee)?t/i);
        if (m) return parseFloat(m[1]);
        const met = maxFact.fact.match(/([\d.]+)\s*met/i);
        if (met) return Math.round(parseFloat(met[1]) * 3.281);
        return null;
      })() : null);

      const avgFact = facts.find(f => f.category === 'averageDepthFt');
      const avgDepth = bathyAvgDepth !== null ? bathyAvgDepth : (avgFact ? (() => {
        const m = avgFact.fact.match(/([\d.]+)\s*f(?:ee)?t/i);
        if (m) return parseFloat(m[1]);
        const met = avgFact.fact.match(/([\d.]+)\s*met/i);
        if (met) return Math.round(parseFloat(met[1]) * 3.281 * 10) / 10;
        return null;
      })() : null);

      const identityFacts = facts.filter(f => {
        if (!/identity|surface|depth|dam|year|owner|river|archetype|impound|county|pool|drawdown|elevation|normal/i.test(f.category)) return false;
        // Exclude poolLevel facts that are just fluctuation ranges — not pool elevations
        if (f.category === 'poolLevel' && !/elevation|ngvd|navd|feet above|ft msl|\d{3}\s*f/i.test(f.fact)) return false;
        return true;
      }).map(f => `• [${f.category}] ${f.fact} (source: ${f.source}, confidence ${f.confidence}%)\n  Quote: "${f.quote}"`).join('\n\n');

      const ownerText = (facts.find(f => f.category === 'reservoirOwner')?.fact || '').toLowerCase();
      const isDuke = /duke/i.test(ownerText);

      // THE POOL TABLE IS DATA NOW, NOT A DOCUMENT TO READ. When the baseline carries it, it came
      // out of /lakes/operating-range as JSON and there is nothing to extract; the old instruction
      // stays only for a Duke lake with no location id.
      //
      // The retired instruction also said "normalPoolFt to the Maximum column value", which is 100
      // on a Duke lake — the top of the local index, not an elevation. That is why the authoritative
      // block below states both scales.
      const baselinePool = prev?._knownBaseline?.poolManagement || null;
      const dukePoolSection = baselinePool ? `

DUKE POOL MANAGEMENT (AUTHORITATIVE — from Duke's own operating-range API, do NOT re-derive from documents):
${JSON.stringify({
  normalPoolFt: prev._knownBaseline.normalPoolFt,
  normalPoolDatum: prev._knownBaseline.normalPoolDatum,
  drawdownType: prev._knownBaseline.drawdownType,
  seasonalDrawdownFt: prev._knownBaseline.seasonalDrawdownFt,
  poolManagement: baselinePool,
}, null, 1)}
Use these values EXACTLY. normalPoolFt is feet AMSL and is NOT the "Maximum" column — that column is 100, the top of Duke's local index. If a document disagrees, the API wins.` : (isDuke ? `

DUKE ENERGY CRA POOL LEVEL TABLE — IF PRESENT IN DOCUMENTS:
The CRA agreement PDF has a table: Month(s) | Guide Curve (target ft) | Minimum ft | Maximum ft (local datum, typically 93-100 range).
Extract into poolManagement: guideCurveFt by month, minimumFt, maximumFt, drawdownSchedule [{months, targetFt}].
normalPoolFt must be feet NGVD/NAVD, NOT the Maximum column — on a Duke lake that column is 100, the top of the local index.` : '');

      // Bathymetry authority section — when geometry-derived depth values exist,
      // inject them as authoritative so the LLM doesn't replace them with
      // document-extracted or training-data numbers.
      const bathySection = hasBathymetry ? `

BATHYMETRY-DERIVED DEPTH DATA (AUTHORITATIVE — use these exact values, do NOT override with document facts):
These values were computed directly from TrollMap bathymetric contour lines and depth-area polygons using hypsometric integration.
They are the highest-trust source for depth and area — higher than any document, guide, or LLM training data.
${bathySurfaceArea !== null ? `- surfaceAreaAcres: ${bathySurfaceArea} acres` : ''}
${bathyMaxDepth !== null ? `- maxDepthFt: ${bathyMaxDepth} ft` : ''}
${bathyAvgDepth !== null ? `- averageDepthFt: ${bathyAvgDepth} ft (area-weighted mean depth)` : ''}
${bathyMeta ? `- Polygon coverage: ${(bathyMeta.bathymetryCoverage * 100).toFixed(0)}% of lake area, ${bathyMeta.bathymetryBandCount || '?'} depth bands` : ''}
CRITICAL: Use these bathymetry values EXACTLY as given above. Do NOT replace them with values from documents, websites, or training knowledge. If a document says a different depth, ignore the document — bathymetry is authoritative.` : '';

      const docSection = prev?._documentContext
        ? `\n\nDOCUMENT TEXT:\n${prev._documentContext.slice(0, 60000)}`
        : '';

      return `Map identity facts for ${lakeName} (${state}).

EXTRACTED FACTS:
${identityFacts || 'No identity facts — use document context.'}
${bathySection}

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
  // ── `limnology` RETIRED 2026-09-01 ────────────────────────────────────────────────────────
  //
  // All ten of its target fields are now measured, derived from a measurement, or gone.
  //
  //   secchiFt, thermocline.summerDepthFt, oxygen.anoxicBelowFt   WQP depth-profile samples
  //   oxygen.depletionDepthFt                                     same DO bins, 5 mg/L standard
  //   trophicStatus, waterClarity.typical                         Carlson TSI off that secchi
  //   seasonalDrawdownFt                                          Duke operating-range API
  //   waterClarity.color, thermocline.strength, flowCharacteristics   cut, no reader worth one
  //
  // The system prompt this replaces defined "depletionDepthFt = shallowest depth where DO drops
  // below 2 mg/L" and "anoxicBelowFt = depth where DO approaches 0" -- one threshold asked for
  // twice, which is why the two numbers were never usefully different. They are 5 mg/L and
  // 2 mg/L now, both published standards, both read off the same binned profile.
  //
  // What made this agent worth retiring rather than improving: every number it wrote landed on
  // top of a WQP-derived one, and the evidence row underneath still said the value came from
  // state monitoring data.
  // ── `biology` RETIRED 2026-09-01 ──────────────────────────────────────────────────────────
  //
  // The last of the ten. predatorSpecies is deterministic on 60 of the 64 lakes the research tab
  // offers, and on the other four `fisheries` establishes it from agency documents in its own
  // pass. primaryForage and secondaryForage -- the only fields this agent produced that fisheries
  // actually consumed -- are folded into that same pass, so the forage base is read and used by
  // one agent instead of handed between two. knownStockings stays deterministic. spawnTiming,
  // baitfishMovement, forageSpatial and speciesAbundance are cut: trollingIntelligence already
  // answers the same question per species and per season, which is the form a plan can use.
  // ── `habitat` RETIRED 2026-09-01 ──────────────────────────────────────────────────────────
  //
  // Twelve target fields, none of them left for a model. The pack's water_features and POI layers
  // answer the creek mouths and the timber, the state attractor feeds answer the attractors,
  // `garmin_6_0` -- Garmin's own nature-of-the-seabed labels -- answers bottomComposition where it
  // was surveyed, and five fields had no planner reader at all.
  //
  // Vegetation is parked empty on purpose. Ryan: "for the lakes and rivers just park those
  // empty... i don't think a web fetch is going to get accurate data... that is one of those
  // things i will just have to learn on the water."
  navigation: {
    label: "Navigation",
    order: 5,
    system: "You are a boating safety data assembly agent. Map ramp data and hazard facts to the navigation JSON. Return ONLY valid JSON.",
    // THE RAMPS ARE NOT THE MODEL'S TO REPEAT.
    //
    // This template used to interpolate the full ramp array TWICE -- once as context and again
    // inside the JSON skeleton it asked the model to echo back. That was survivable while
    // deterministic ramps were coming back empty. Once the registry's geometry join started
    // supplying them, Thurmond arrived with 116, and 116 ramps do not fit in max_tokens 3000.
    // From Ryan's run, 2026-08-16:
    //
    //   ⚠️ Navigation LLM 502: HTTP 502 — Agent returned non-JSON | raw: { "navigation": {
    //   "ramps": [ {"name": "Amity RA", ...}, {"name": "Baker Creek State Park", "lat": 33.88
    //
    // Cut off mid-object, so extractJsonPossibly found no closing brace and the agent 502'd --
    // twice, because the retry sent the identical prompt.
    //
    // Deterministic data has no business round-tripping through a language model. The ramps
    // are already on profile.navigation.ramps, the merge in lake-research-engine.js only
    // overwrites keys the agent actually returns, so leaving them out preserves them exactly.
    // What the model is for here is hazards, shoals, timber and idle zones.
    userTemplate: (lakeName, state, prev) => {
      const existingNav = prev?.navigation || {};
      const rampList = Array.isArray(existingNav.ramps) ? existingNav.ramps : [];
      const rampSample = rampList.slice(0, 8).map(r => r?.name).filter(Boolean).join(', ');
      const facts = prev?._extractedFacts || [];
      const navFacts = facts.filter(f =>
        /ramp|hazard|shoal|navigation|timber|dam|bridge|tailwater|surge|idle|access/i.test(f.category + ' ' + f.fact)
      ).map(f => `• ${f.fact} (source: ${f.source})`).join('\n');

      return `Navigation data for ${lakeName}.

RAMPS ARE ALREADY RECORDED — DO NOT RETURN THEM.
${rampList.length} boat ramp(s) are already stored for this lake from official GIS and the
TrollMap registry${rampSample ? ` (for example: ${rampSample})` : ''}. They are context only.
Repeating them will truncate your reply and it will be discarded. Omit the "ramps" key.

EXTRACTED HAZARD FACTS:
${navFacts || 'No navigation facts extracted — derive from lake type and operator.'}

Return ONLY:
{
  "navigation": {
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
    system: "You are a fishing regulations specialist. Extract fishing regulations from the provided approved regulation-source content. For each species: check if the lake appears in an exception list. If listed, use the exception rule. If not listed, the statewide rule applies. Return ONLY valid JSON. Never invent limits — if unknown, set null.",
    userTemplate: (lakeName, state, prev) => {
      const facts = (prev?._extractedFacts || [])
        .filter(f => /regulation|creel|limit|season|closed|gear|size.*limit|possession|sizeLimit|creelLimit/i.test(f.category + ' ' + f.fact))
        .slice(0, 30);
      const factsBlock = facts.map(f => `• [${f.category}] ${f.fact} (source: ${f.source})`).join('\n');
      const regsContent = prev?._regsSource?.content
        ? prev._regsSource.content.slice(0, 30000)
        : 'Not available';
      return `Extract fishing regulations for ${lakeName} (${state}).

APPROVED REGULATION SOURCE:
${regsContent}

EXTRACTED REGULATION FACTS (use to fill species-specific fields):
${factsBlock || 'None extracted'}

INSTRUCTIONS:
1. Read the approved regulation source above carefully
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
  "sources": [{"label":"Approved state regulations digest","url":"r2:regulations","trust":"OFFICIAL"}]
}
JSON only. Never output a string or array for creelLimits or sizeLimits.`;
    },
    expectedKey: "regulations"
  },

  fisheries: {
    label: "Species Intelligence",
    order: 7,
    system: "You are a fisheries biologist and professional fishing guide. You are given a verified lake profile AND raw text from source documents (fishing guides, reports, agency surveys). Extract seasonal species behavior from BOTH the profile AND the source documents. DEPTH MEANS THE FISH, NOT THE BOTTOM — THIS IS THE MOST IMPORTANT RULE HERE. preferredDepth is the depth BELOW THE SURFACE at which the fish are holding. It is NEVER the depth of the water they are over. Those are different numbers and sources routinely give both: 'suspended at 20 ft over 35 ft of water' means preferredDepth [20,20] and waterDepthFt [35,35]. Record both when both are stated; never collapse them into one range and never substitute one for the other. holding says what the fish are relating to: 'bottom' when they are on or within a few feet of the bottom, 'suspended' when they are up in the water column with open water beneath them, 'both' when a source describes two groups. Bottom-relating and suspended fish at the SAME stated depth call for completely different water, so if the sources do not say, return null for holding rather than inferring it. EVERY SEASON ENTRY MUST CITE THE SENTENCE IT CAME FROM. sourceQuote is the verbatim sentence from a source document or a PARSED OBSERVATION that supports the depth and holding you are reporting. Copy it exactly; do not paraphrase it, do not stitch two sentences together, and do not write a quote that is not in the material you were given. If you are reporting a value from general knowledge of the species rather than from anything in front of you, set sourceQuote to null -- that is a legitimate answer and it is far more useful than an invented citation. A quoted range and a reported range must MATCH: if the sentence says 12 to 22 feet, preferredDepth is [12,22] and not [15,40]. CONSENSUS RULE: When multiple sources cover the same species/season, use the depth range and structure that appears in the majority of sources. If sources contradict (e.g. 3 say 15-25ft and 1 says 5ft), use the majority position and note the discrepancy in the notes field. Do not average contradicting values — pick the consensus. Do not invent data when sources are silent — return null for that season. Prioritize official agency documents over fishing guide content when they conflict. Do NOT recommend routes, speeds, or specific lure colors. CRITICAL: Only include species listed in the biology.predatorSpecies array. SPECIES NAME RESOLUTION — CRITICAL: Agency documents frequently use GROUP TERMS that cover multiple species. You MUST split these into individual species keys. NEVER use a group term as a JSON key. Group terms and their individual species mappings: 'Black Bass' or 'black bass (largemouth, smallmouth, spotted)' → split into Largemouth Bass, Smallmouth Bass, Spotted Bass individually. 'Catfish (all species)' or 'Catfish' → split into Blue Catfish, Channel Catfish, Flathead Catfish as applicable. 'Crappie (all species)' → split into Crappie (or Black Crappie / White Crappie if individually listed). 'Bream/Sunfish' or 'Bluegill/Warmouth and other sunfishes' → split into Bluegill, Redear Sunfish (Shellcracker), Warmouth as applicable. When a document has a group heading like 'Black Bass' followed by individual species tips (e.g. 'Largemouthbass - Spring: ... Summer: ... Fall: ... Winter: ...'), parse EACH species line separately and assign to the correct individual species key. If generic group-level data has no species-specific breakdown, replicate that data to each individual species from the confirmed list that belongs to that group. NEVER output 'Black Bass', 'Catfish (all species)', or any other group term as a species key — always use the exact individual species name from the confirmed species list. Return JSON only.",
    userTemplate: (lakeName, state, prev) => {
      const bio = prev?.biology || {};
      const confirmedSpecies = Array.isArray(bio.predatorSpecies) ? bio.predatorSpecies : [];
      // TWO MODES, AND THE SECOND ONE EXISTS BECAUSE THE FIRST USED TO PRODUCE GARBAGE.
      //
      // This read `(none confirmed — biology section empty)` into the species list when the
      // deterministic sources had nothing, and then told the model to write intelligence for
      // ONLY that "species". Ryan, 2026-09-01: "we just need the fisheries intel agent to ask
      // that question before it gets the intel on those species... for lakes that do not have
      // that info from a deterministic source it can be searched for using research."
      //
      // Measured the same day over the 64 inland lakes above 1,000 acres the research tab
      // actually offers: 60 arrive with a species list from a deterministic source and 4 do not
      // -- Robinson, William C Bowen, Bay Tree and White Lake. So DISCOVER mode is the rare path
      // and CLOSED mode stays exactly as it was, byte for byte, when a list exists.
      const discover = confirmedSpecies.length === 0;
      const speciesList = discover ? [] : confirmedSpecies;
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
${JSON.stringify(cleanProfile(prev), null, 2).slice(0, 12000)}
${docSection}${prev?._behaviourBlock || ''}

${discover ? `NO SPECIES LIST EXISTS FOR THIS WATER. ESTABLISH ONE FIRST, THEN WRITE THE INTELLIGENCE.

No deterministic source -- no state ramp record, no agency lake page, no lake-specific regulation
-- names a single fish in this water. That is why you are being asked, and it is the ONLY reason
you may name a species at all.

Rules for establishing the list, and they are the same rules the retired biology agent carried
because the failure they prevent is the same one:

  A. A species counts as present ONLY if an OFFICIAL AGENCY source in the documents above says so
     -- SCDNR, NCWRC, GADNR, TWRA, TVA, USACE, USGS, EPA, a state regulations digest, or a dated
     agency survey. A fishing guide, a report site, a forum post or a social media page is NOT
     evidence of presence, however confident it sounds. Those sources are for behaviour, not for
     what lives here.
  B. NEVER name: sturgeon, paddlefish, gar, eel, lamprey, shad, herring, carp, drum, buffalo,
     sucker, or any protected, endangered or baitfish species. Those are forage or rough fish and
     do not belong in a predator list.
  C. If the documents do not support a species, LEAVE IT OUT. A short honest list is correct. An
     empty list is also correct and is far better than a plausible one -- return
     "speciesFound": [] and "trollingIntelligence": {} and say why in the note.

Return what you established in "speciesFound", each entry carrying the sentence that establishes
it, and then write trollingIntelligence for exactly those species and no others.` : `CONFIRMED SPECIES (ONLY these — do not add others):
${speciesList.join(', ')}`}

SPECIES NAME RESOLUTION — CRITICAL:
Source documents (especially state agency pages like TWRA, SCDNR, NCWRC, DNR) frequently use GROUP TERMS as section headings. These are NOT valid species keys — you MUST split them into individual species from the confirmed list above.

Common group terms and how to resolve them:
• "Black Bass" heading → data goes to Largemouth Bass, Smallmouth Bass, Spotted Bass (whichever are in the confirmed list)
• "black bass (largemouth, smallmouth, spotted)" → same split as above
• "Catfish (all species)" → data goes to Blue Catfish, Channel Catfish, Flathead Catfish (whichever are in the confirmed list)
• "Crappie (all species)" or "Crappie" → data goes to Crappie, Black Crappie, White Crappie (whichever are confirmed)
• "Bream/Sunfish" or "Bluegill/Warmouth and other sunfishes" → data goes to Bluegill, Redear Sunfish (Shellcracker), Warmouth (whichever are confirmed)
• "Striped Bass or Hybrid Striped Bass" → data goes to Striped Bass, Hybrid Striped Bass (whichever are confirmed)

PARSING INDIVIDUAL SPECIES TIPS: When a document has a group heading (e.g. "Black Bass") followed by individual species tip lines like:
  "Largemouthbass - Spring: [tips]; Summer: [tips]; Fall: [tips]; Winter: [tips]"
  "Smallmouthbass - Spring: [tips]; Summer: [tips]; Fall: [tips]; Winter: [tips]"
  "SpottedBass - [tips]"
You MUST parse EACH species line SEPARATELY and assign to the correct individual species key. The species name may be concatenated (e.g. "Largemouthbass" = Largemouth Bass, "Smallmouthbass" = Smallmouth Bass, "SpottedBass" = Spotted Bass). Extract the Spring/Summer/Fall/Winter data from each line into the correct species' seasonal entries.

If generic group-level data has NO species-specific breakdown (just a paragraph about "black bass" in general with no per-species tips), replicate that data to each individual species from the confirmed list that belongs to that group.

NEVER output "Black Bass", "Catfish (all species)", "Bream/Sunfish", or any other group term as a key in trollingIntelligence. Only use exact species names from the confirmed list above.

${allForage.length ? `CONFIRMED LAKE FORAGE: ${forageStr}` : `THIS LAKE'S FORAGE IS NOT RECORDED. ESTABLISH IT FROM THE DOCUMENTS FIRST.

The biology agent used to answer this and it is retired, so read the forage out of the same
documents you are reading everything else from, and return it in "lakeForage" -- primary is what
the sources describe as the main prey base, secondary is everything else named. Threadfin shad,
gizzard shad, blueback herring, alewife, bluegill and crawfish are the usual answers in these
waters; a stocked or introduced forage species is worth naming when a source says so.

Establish that list BEFORE you assign per-species forage below, and then assign from it. If the
documents name no forage at all, return "lakeForage": {"primary": [], "secondary": []} and use
species-appropriate forage from general knowledge for the per-species entries -- do not invent a
lake-specific forage base you did not read.`}
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

- HOLDING PATTERN — EVERY species, EVERY season. THIS IS A SEPARATE SEARCH FROM DEPTH and it is
  the one most often missed, because a document can state a depth without ever saying what the
  fish are relating to. Do not treat depth extraction as having answered it. Hunt the text for:
    suspended · in the water column · above the thermocline · over the channel · over deep water ·
    up off the bottom · schooling on top · open water                    → holding "suspended"
    on the bottom · hugging bottom · dragging · bumping bottom · anchoring ·
    holding tight to · relating to the bottom · on the ledge itself      → holding "bottom"
  Also read behaviour that implies it WITHOUT those words: "downlines over 40 feet of water" is
  suspended; "dragging cut bait on the flats" is bottom; "topwater schooling" is suspended;
  "vertical jigging on the ledge" is bottom. Two groups at once ("some suspended near the
  thermocline, others deep on the bottom") is "both". Leave holding null when the sources genuinely
  do not say — but never leave it null because you did not go looking.

- BOTH DEPTH NUMBERS WHEN A SOURCE GIVES BOTH. Hunt for phrasings carrying the fish depth AND the
  water depth in one sentence: "suspended at 20 ft in 35 feet of water", "holding 25 down over 60",
  "30 feet down on a 55 foot bottom". preferredDepth takes the FISH number, waterDepthFt takes the
  WATER number. Dropping the second is the single most common extraction error on this task.

- Striped Bass spring: look for "pre-spawn", "staging", "spawning tributaries", "spring run", "March", "April", "May", "58-68°F" — extract depth, structure, forage from that context
- Striped Bass fall: look for "October", "fall striper", "post-closure", "schooling" — extract what you find
- Largemouth Bass winter: look for "cold water", "winter bass", "January", "February", "deep timber", "creek channels in winter", "jigs spoons worms" — if a doc says "bass move back to deep water where jigs, spoons and heavily weighted worms are productive" that is winter LMB data; populate notes even if no explicit depth is given
- Striped Bass winter: look for "deep water", "shiner minnows", "drifting", "winter striper" — if a doc says "stripers are in deep water where drifting with large shiner minnows is effective" that is winter striper data; populate notes and use depth from fall as estimate if no winter depth stated
- If a document says "pre-spawn striped bass staging near spawning tributaries following shad schools" — that is spring striper data, extract it

If a document gives specific depth ranges or seasonal behavior for a species on ${lakeName}, use it — do not replace document evidence with generic inferences.

SCHEMA RULES — every season entry MUST follow this exact structure, no exceptions:
{
  "preferredDepth": [minFt, maxFt],   ← depth of the FISH below the surface. NOT water depth.
                                          If a PARSED OBSERVATION covers this species and season,
                                          its value is the answer — copy it, do not adjust it
  "holding": "suspended",              ← "bottom" | "suspended" | "both" | null. Never omit.
                                          Take it from a PARSED OBSERVATION whenever one applies
  "waterDepthFt": [minFt, maxFt],      ← depth of the WATER the pattern happens over, when a
                                          source states it. null when it does not. Never omit
  "sourceQuote": "verbatim sentence",  ← the exact sentence supporting preferredDepth/holding,
                                          or null if this entry is general species knowledge.
                                          NEVER invent one. A widened range with a quote that
                                          does not contain it is worse than no quote at all
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
${allForage.length ? '' : `  "lakeForage": {"primary": ["Threadfin Shad"], "secondary": ["Bluegill", "Crawfish"]},
`}${discover ? `  "speciesFound": [
    {"species": "Largemouth Bass",
     "source": "SCDNR lake page / TWRA survey / state regulations digest — name the agency",
     "quote": "the verbatim sentence from the documents that establishes this fish is in this water"}
  ],
` : ''}  "trollingIntelligence": {
    "${exampleSpecies}": {
      "summer": {
        "preferredDepth": [12,18],
        "holding": "suspended",
        "waterDepthFt": [25,45],
        "sourceQuote": "he works the 12- to 22-foot range but said the most-productive depths vary",
        "structures": ["channel ledges","creek mouths","long points"],
        "forage": ["Threadfin Shad"],
        "recommendedPresentations": ["MR Crankbait","DD Crankbait","A-Rig"],
        "notes": "behavior notes drawn from source documents"
      },
      "fall": {"preferredDepth":[8,15],"holding":"suspended","waterDepthFt":[15,30],"structures":[],"forage":[],"recommendedPresentations":[],"notes":""},
      "winter": {"preferredDepth":[20,35],"holding":"bottom","waterDepthFt":[20,35],"structures":[],"forage":[],"recommendedPresentations":[],"notes":""},
      "spring": {"preferredDepth":[5,15],"holding":null,"waterDepthFt":null,"structures":[],"forage":[],"recommendedPresentations":[],"notes":""}
    }
  },
  "sources": [{"label":"Derived from lake profile and source documents","trust":"DERIVED"}]
}

${discover ? 'The species keys in trollingIntelligence MUST be exactly the names you returned in speciesFound.' : `Species list MUST be ONLY: [${speciesArrayStr}] — do NOT add species not in this list.`}
preferredDepth MUST be a 2-element number array [minDepthFt, maxDepthFt] or null — NEVER a bare array at the season level.
JSON only.`;
    },
    expectedKey: "trollingIntelligence"
  },
  // ── `summary` RETIRED 2026-09-01 ──────────────────────────────────────────────────────────
  //
  // "You summarize a lake profile into a readable human description" -- of a profile the client
  // had already assembled, already summarized deterministically from its own measured fields,
  // and already saved. This agent then read that profile back and wrote the whole thing again
  // with its section replaced.
  //
  // buildDeterministicSummary() in lake-research-engine.js keeps the job. It says the same things
  // off the same numbers, and it cannot say anything the profile does not contain.
};

function calculateSectionConfidence(sources, hasData, sectionType) {
  if (!hasData) return { percent: 0, level: "missing", reason: "no data" };
  const src = Array.isArray(sources) ? sources : [];

  // ── Trolling / TrollingIntelligence — data-structure validated scoring ──
  // Trolling has no citable sources (fishing tactics aren't USGS-published),
  // so source-count scoring always under-reports. Instead, validate the output
  // structure: does it have species × season entries with depth/structure/forage?
  if (sectionType === 'trollingIntelligence') {
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
  const bio = profile.biology || {};
  const id = profile.identity || {};
  const trolling = profile.trollingIntelligence || profile.fisheries || {};
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

  // GROUND THE IDENTITY AGENT FROM THE REGISTRY, NOT FROM A FIFTEEN-LAKE TABLE.
  //
  // This read `LAKES[lakeKeyFromName(lakeName)]` — fifteen waters of 454. Every other lake got a
  // baseline of `undefined` on the one agent whose entire job is to say what the water IS, while
  // its own system prompt tells it "Never invent values". Ryan, 2026-08-17, choosing the fix:
  // ground all 454 from the registry.
  //
  // The old baseline also spread the whole row, which handed the model `duke: "wateree"`,
  // `river: "02148000"` and `ahq: "lake-wateree"` — foreign keys for three other services,
  // presented as curated facts about the lake.
  //
  // A FAILED LOOKUP MUST NOT FAIL THE AGENT. R2 being unreachable is a reason to run ungrounded,
  // which is exactly what 439 lakes did before this. Caught, not thrown.
  let groundedPrev = previousResults;
  if (agentKey === 'identity') {
    const baseline = await identityGrounding(lakeName, env).catch(() => null);
    if (baseline) groundedPrev = { ...previousResults, _knownBaseline: baseline };
  }

  // Regulations use the approved R2 digest through the shared parser. This avoids
  // baking live agency/eRegulations URLs into the agent path.
  if (agentKey === 'regulations') {
    try {
      const stateRegulations = await fetchStateRegulations(state, env);
      const applicableRegulations = getLakeRegulations(stateRegulations, lakeName);
      groundedPrev = {
        ...previousResults,
        _regsSource: {
          url: 'r2:regulations',
          content: JSON.stringify(applicableRegulations),
          note: 'APPROVED R2 REGULATIONS DIGEST — use this parsed statewide and lake-specific data. Never invent limits.'
        }
      };
    } catch (e) {
      console.warn('R2 regulations load failed: ' + e.message);
    }
  }

  // The saltwater agent was built around two inputs it was never handed. `_regsSource`
  // was populated only under `agentKey === 'regulations'` above, so `saltwater_regulations`
  // always took its "No R2 digest available -- do not guess limits; return nulls" branch;
  // and `_liveRegsSource` had no writer anywhere in the tree, so it always took "No live
  // amendment source supplied" as well. Every coastal run hit both fallbacks, which is why
  // saltwater limits came back null with `verificationRequired` set and looked like a
  // cautious agent rather than an unwired one.
  //
  // It gets digest TEXT, not the freshwater parse: `fetchStateRegulations` runs a prompt
  // whose species list is entirely freshwater, and its output has no red drum in it.
  if (agentKey === 'saltwater_regulations') {
    const [digest, live] = await Promise.all([
      fetchSaltwaterRegulations(state, env).catch(e => {
        console.warn('saltwater digest load failed: ' + e.message); return null;
      }),
      fetchLiveRegsAmendments(state, env).catch(e => {
        console.warn('live amendment check failed: ' + e.message); return null;
      })
    ]);
    groundedPrev = { ...(groundedPrev || previousResults) };
    if (digest) {
      groundedPrev._regsSource = {
        url: digest.url,
        published: digest.published,
        content: digest.content,
        note: 'APPROVED R2 SALTWATER DIGEST SECTION -- this is the annual baseline. Never invent limits.'
      };
    }
    if (live) {
      groundedPrev._liveRegsSource = {
        url: (live.urls || []).join(' '),
        checkedFrom: live.after,
        content: live.content,
        note: 'LIVE AMENDMENT SEARCH -- results published after the digest took effect. Where these conflict with the digest, these win.'
      };
    }
  }

  // Inject document text for agents that benefit from reading source material directly
  // biology gets the fisheries docs
  // fisheries gets fishing guide/report docs — seasonal behavior lives in these, not the profile
  const docInjectionAgents = new Set(['fisheries']);
  if (docInjectionAgents.has(agentKey) && previousResults._normalizedDocuments?.length) {
    const docFilter = {
      fisheries: /fish|bass|crappie|striper|catfish|pattern|season|depth|behavior|report|tactic|guide|omnia|conventional|sportsman/i,
    };
    const filter = docFilter[agentKey];
    // Gemini free-tier requests must stay comfortably below token-per-minute limits.
    const maxDocs = 8;
    // 150,000 CHARACTERS PER DOCUMENT WAS NOT A BUDGET, IT WAS THE ABSENCE OF ONE.
    //
    // Eight documents at that cap is 1.2 million characters -- roughly 300,000 tokens of raw
    // source text -- and the profile dump at the top of the prompt embedded a truncated copy of
    // the same text on top of it. Two attempts to add fields to the fisheries schema produced
    // perfectly well-formed output with the new keys absent from all 31 populated entries, twice,
    // with the prompt confirmed deployed both times. A single line of schema at the end of a
    // quarter-million tokens does not steer a model; it writes from its priors and returns
    // something that looks right.
    //
    // A fishing report says everything useful about where fish sit in its first few thousand
    // characters. The agency survey PDFs that were eating the budget are the right source for
    // population and stocking and say nothing about holding depth at all.
    const charsPerDoc = agentKey === 'fisheries' ? 20000 : 40000;
    const matched = previousResults._normalizedDocuments
      .filter(d => !filter || filter.test(d.title + ' ' + d.url));

    // RANK, DO NOT TRUNCATE. The frontend sends 25 documents for fisheries and this kept the
    // first 8 that matched a regex, in whatever order discovery returned them. Ryan, 2026-08-10:
    // "are articles that contain this information being thrown out?" They can be, and nothing
    // said so. Wateree's run had "Winter Crappie Fishing with Will Hinson", "Winter Catfishing
    // with Captain Rodger Taylor", the AHQ summer report and Carolina Sportsman in its corpus --
    // exactly the prose that describes whether fish are on the bottom or up in the column -- and
    // they were competing for eight slots against "Fisheries Investigations in Lakes and Streams
    // 2012/2016/2017", which match the same filter and are vastly longer.
    //
    // So fisheries documents are ordered by how much BEHAVIOUR language they actually contain,
    // per unit length. Density and not raw count, or a three-hundred-page survey wins by being
    // long. This ranks on the thing that is missing rather than guessing from the source type,
    // and a guide article that never discusses depth correctly loses to one that does.
    let ordered = matched;
    if (agentKey === 'fisheries') {
      const BEHAVIOUR = /suspend\w*|thermocline|water column|holding|relat\w+ to the bottom|hugging|on the bottom|off the bottom|down ?line\w*|free ?line\w*|drag\w*|troll\w*|school\w*|feet of water|ft of water|deep water|top ?water|vertical jig\w*/gi;
      ordered = matched
        .map((d) => {
          const t = String(d.text || '');
          const hits = (t.match(BEHAVIOUR) || []).length;
          return { d, hits, density: hits / Math.max(1, t.length / 10000) };
        })
        .sort((a, b) => b.density - a.density || b.hits - a.hits)
        .map((x) => x.d);
    }
    const relevantDocs = ordered.slice(0, maxDocs);
    if (relevantDocs.length) {
      const docContext = relevantDocs
        .map(d => `=== ${d.title} ===\n${d.text?.slice(0, charsPerDoc) || ''}`)
        .join('\n\n');
      // NO SILENT TRUNCATION. Eight of twenty-five quietly becoming the entire evidence base is
      // how a question gets answered "the sources do not say" when three of the sources did.
      const dropped = matched.length - relevantDocs.length;
      const droppedNote = dropped > 0
        ? ` ${dropped} further matching document(s) were not included in this prompt.` : '';
      console.log(`[research:${agentKey}] ${relevantDocs.length} of ${matched.length} matching docs, `
                + `${charsPerDoc} chars each: ${relevantDocs.map(d => d.title).join(' | ')}`);
      groundedPrev = {
        ...groundedPrev,
        _documentContext: docContext,
        _documentContextNote: `Raw document text from ${relevantDocs.length} source(s) — use this for specific measurements, tables, and depth profiles. Prioritize this over training knowledge.${droppedNote}`
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

  // ── THE PARSER OWNS THE VALUES, THE AGENT OWNS THE PLACEMENT ──────────────────────────────
  //
  // Ryan, 2026-08-10: "why do we need the agent at all for this... the information is there why
  // not just use a parser" -- and then the shape of the answer: "pass the parsed info to the
  // agent to put into the right place."
  //
  // Four consecutive runs of the same documents returned striper summer as [15,40], [16,20],
  // [16,25] and [15,40], with `holding` null every time, while the same model wrote "anchoring
  // cut bait on the bottom" into the notes beside it. A holding pattern is three words and a
  // depth is two numbers; neither needs a language model, and asking for them bought only
  // variance. What a regex genuinely cannot do is decide that a sentence about pre-spawn staging
  // in March belongs to striped bass in spring when the document labels neither -- so the agent
  // keeps that and loses the rest.
  //
  // The observations come from `_extractedFacts`, not from raw article text: those are already
  // one claim per entry, already attributed to this lake, and already carry the verbatim quote
  // that has to travel with any value the app later acts on. The biology agent has worked this
  // way since it was written -- "Map extracted facts to the biology JSON" -- and fisheries was
  // the one agent still doing its own extraction.
  if (agentKey === 'fisheries' && Array.isArray(groundedPrev._extractedFacts)) {
    const observations = parseBehaviour(groundedPrev._extractedFacts);
    if (observations.length) {
      console.log(`[research:fisheries] ${observations.length} parsed observation(s) from `
                + `${groundedPrev._extractedFacts.length} facts`);
      groundedPrev = { ...groundedPrev, _behaviourBlock: behaviourBlock(observations) };
    }
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

    // A GROUP THAT COMES BACK EMPTY MUST NOT LOOK LIKE A GROUP THAT HAD NOTHING TO SAY.
    //
    // Ryan, 2026-08-10: "this time it didn't even find striped bass or largemouth". Both are in
    // the `bass` group, that one call returned nothing, and the run logged
    // "✔ Species Intelligence agent complete (59 facts, 10 docs)" followed by
    // "✔ All agents complete: 1/1 succeeded". A quarter of the lake's species disappeared and
    // every line on the screen said success -- because a failed group returns `{}` here and an
    // empty object merges into nothing at all.
    //
    // The catch below already console.warn'd it, but a Worker console line is not somewhere he
    // is ever going to look. So the outcome of every group is collected and returned, and the
    // response carries which confirmed species did not survive the round trip.
    const groupOutcomes = [];

    // Run all groups concurrently
    // ONE LAKE WAS AN UNBOUNDED BURST OF LLM CALLS.
    //
    // `groupEntries.map(async …)` starts every group at once, so a lake with six species groups
    // fired six concurrent calls. That was survivable from a browser, one lake at a time. It is
    // not survivable from a batch: the quarterly run walks 64 lakes with `--jobs`, so four
    // parallel lakes at six groups each is twenty-four simultaneous requests, and the provider
    // chain answers that with 429s rather than intelligence.
    //
    // Bounded to GROUP_CONCURRENCY at a time. The batch's own `--jobs` then multiplies a number
    // somebody chose instead of one nobody counted. Ryan set the constraint and not the value:
    // "keep it under the cpu limit on the worker and under the rpm for the LLM... beyond that i
    // dont care."
    //
    // ONE AT A TIME, NOT TWO. Ryan, 2026-09-01, on two runs that each lost a group to
    // "This model is currently experiencing high demand": "i don't think that error is correct
    // i think you are rate limitting because you are hitting all of the species at once."
    //
    // Counted from the code rather than argued: one lake with eight documents sends eight
    // extraction calls at up to 150,000 characters each (research/extract.js), then one group
    // call per species group carrying up to eight documents at 20,000 characters. That is about
    // 420,000 input tokens inside a minute, and the free Gemini tier meters tokens per minute.
    // Two groups in flight put the two largest prompts of the run on the wire together.
    //
    // Serial groups cost wall time and nothing else -- a group is one call and the lake is not
    // waiting on anything. Measured cost of the change: roughly 10-20 s on a lake that already
    // takes 50-100 s.
    const GROUP_CONCURRENCY = 1;
    const runGroup = async ([groupName, groupSpecies]) => {
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
          groupOutcomes.push({ group: groupName, species: groupSpecies, ok: false, reason: 'non-JSON response' });
          return {};
        }
        const section = parsed.trollingIntelligence || parsed[agentKey] || parsed || {};
        const got = Object.keys(section).filter((k) => k !== 'sources');
        groupOutcomes.push({ group: groupName, species: groupSpecies, ok: got.length > 0,
                             returned: got, reason: got.length ? null : 'empty section' });
        return section;
      } catch (e) {
        console.warn(`fisheries group ${groupName} failed: ${e.message}`);
        groupOutcomes.push({ group: groupName, species: groupSpecies, ok: false, reason: e.message });
        return {};
      }
    };

    // A simple sliding window: GROUP_CONCURRENCY workers pull from one shared cursor, so the
    // next group starts the moment a slot frees rather than waiting for a whole batch to finish.
    const groupResults = new Array(groupEntries.length);
    let groupCursor = 0;
    await Promise.all(Array.from({ length: Math.min(GROUP_CONCURRENCY, groupEntries.length) }, async () => {
      for (;;) {
        const i = groupCursor++;
        if (i >= groupEntries.length) return;
        groupResults[i] = await runGroup(groupEntries[i]);
      }
    }));

    // Merge all group results into single trollingIntelligence object
    const mergedIntelligence = {};
    for (const groupResult of groupResults) {
      for (const [species, seasons] of Object.entries(groupResult)) {
        if (species === 'sources') continue;
        mergedIntelligence[species] = seasons;
      }
    }

    // Post-merge: group-term keys go back onto the species they cover. One map, one loop,
    // both shared with the single-shot path below -- see redistributeGroupTerms().
    redistributeGroupTerms(mergedIntelligence, new Set(allSpecies.map((s2) => s2.toLowerCase())));

    // Run normalization pass (same as post-processing below)
    const SEASONS = ['spring', 'summer', 'fall', 'winter'];
    // Values the model supplied that coerceHolding could not read. Empty is the good outcome.
    const holdingRejects = [];
    const normalizedMerged = {};
    for (const [species, seasons] of Object.entries(mergedIntelligence)) {
      if (!seasons || typeof seasons !== 'object') { normalizedMerged[species] = seasons; continue; }
      const normSeasons = {};
      for (const season of SEASONS) {
        const entry = seasons[season];
        if (entry === null || entry === undefined) {
          normSeasons[season] = null;
        } else if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'number') {
          normSeasons[season] = { preferredDepth: entry, holding: null, waterDepthFt: null, structures: [], forage: [], recommendedPresentations: [], notes: null };
        } else if (typeof entry === 'object' && !Array.isArray(entry)) {
          normSeasons[season] = {
            preferredDepth: Array.isArray(entry.preferredDepth) && entry.preferredDepth.length === 2 ? entry.preferredDepth : null,
            // KEPT, NOT REBUILT AWAY. This normaliser lists the keys of a season entry and
            // constructs a fresh object from them, so any key it does not name is silently
            // discarded no matter what the model returned. `holding` and `waterDepthFt` were
            // added to the agent's schema, its examples and its extraction targets across three
            // separate attempts on 2026-08-10, and every run came back with them absent -- from
            // here, not from the model. The evidence was in the notes the whole time: "they
            // suspend near the bottom in high sun", "they relate to the bottom in 20-30+ feet of
            // water". The agent had the answer and this threw it away on the way out.
            //
            // A normaliser that enumerates keys is a whitelist whether or not anyone meant it as
            // one. Anything added to the fisheries schema has to be added here in the same commit.
holding: coerceHolding(entry.holding, holdingRejects),
            waterDepthFt: Array.isArray(entry.waterDepthFt) && entry.waterDepthFt.length === 2
              ? entry.waterDepthFt : null,
            // THE EVIDENCE TRAVELS WITH THE VALUE. An audit of 2026-08-10 found striper summer
            // reported as [15,40] when the only source in the corpus said "he works the 12- to
            // 22-foot range" -- and 40 ft is below this lake's own anoxic line. Nothing in the
            // output showed the drift, because a number with no sentence behind it looks the
            // same whether it was read or invented. null here means general species knowledge
            // and is an honest answer; a quote is a checkable one.
            sourceQuote: typeof entry.sourceQuote === 'string' && entry.sourceQuote.trim()
              ? entry.sourceQuote.trim().slice(0, 400) : null,
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

    // Which confirmed species did not survive the round trip, whatever the reason -- a failed
    // call, an empty section, or a name the model quietly renamed. Compared against what was
    // asked for rather than against the exceptions caught, because the bass group did not throw.
    const returnedSet = new Set(Object.keys(normalizedMerged).map((k) => k.toLowerCase()));
    const missingSpecies = deduped.filter((s2) => !returnedSet.has(s2.toLowerCase()));
    const failedGroups = groupOutcomes.filter((g) => !g.ok);
    if (missingSpecies.length) {
      console.warn(`[research:fisheries] ${missingSpecies.length} confirmed species missing from `
                 + `the result: ${missingSpecies.join(', ')}`);
    }

    const elapsed = Date.now();
    return new Response(JSON.stringify({
      success: true,
      agent: agentKey,
      section: normalizedMerged,
      confidence: { percent: 35 },
      meta: { model: 'multi-group', provider: 'gemini-free',
              groups: groupOutcomes, failedGroups, missingSpecies },
      // Surfaced where the client's log will show it. A run that lost a quarter of the lake's
      // species must not print a tick and nothing else.
      warnings: [
        ...(holdingRejects.length
            ? [`fisheries: ${holdingRejects.length} holding value(s) the normaliser could not read - `
             + `${[...new Set(holdingRejects)].slice(0, 6).join(', ')}`] : []),
        ...failedGroups.map((g) => `fisheries group "${g.group}" returned nothing (${g.reason}) — `
                                 + `${g.species.join(', ')} have no trolling intelligence from this run`),
        ...(missingSpecies.length && !failedGroups.length
            ? [`fisheries: ${missingSpecies.length} confirmed species missing from the result — `
             + `${missingSpecies.join(', ')}`] : []),
      ],
      sources: [{ label: 'Derived from lake profile and source documents', trust: 'DERIVED' }]
    }), { headers: JSON_HEADERS });
  }

  // Coastal zones reuse the shared habitat/biology agents but need saltwater
  // framing, otherwise they report brush piles and shad for a salt marsh.
  const coastalTarget = isCoastalZone(body.zoneKey || body.lakeKey || '')
    || isCoastalZone(previousResults?._zoneMeta?.slug || '');
  const systemPrompt = (coastalTarget && COASTAL_AGENT_HINTS[agentKey])
    ? agent.system + COASTAL_AGENT_HINTS[agentKey]
    : agent.system;
  // THE GUARD BELOW USED TO REPORT SUCCESS AND DO NOTHING, and that is the whole of it.
  // `userPrompt` was a const built from groundedPrev, then the guard reassigned groundedPrev
  // and the payload sent the ORIGINAL string. From wrangler tail, 2026-08-16, twice with the
  // identical number because the second attempt truncated exactly as much as the first:
  //
  //     (warn) handleResearchAgent: habitat prompt too large (402757 chars) — truncating facts
  //
  // 402,757 characters is roughly 100,000 tokens, against a free-tier Flash-Lite budget of
  // 250,000 per minute -- and wave 1 sends five of these at once. Fitting the prompt is now
  // measured after each cut, and if it will not fit the response says so instead of the log
  // claiming a truncation that never happened.
  const fitted = fitPromptToBudget(systemPrompt, (g) => agent.userTemplate(lakeName, state, g), groundedPrev);
  const userPrompt = fitted.userPrompt;
  groundedPrev = fitted.grounded;
  if (fitted.truncatedTo != null) {
    console.warn(`handleResearchAgent: ${agentKey} prompt was ${fitted.before} chars — kept ${fitted.truncatedTo} facts, now ${fitted.size}`);
  }
  if (fitted.over) {
    // Dropping every fact did not get it under budget, so the bulk is the profile blob or the
    // injected document text, not the facts. Naming that is the difference between a lead and
    // a mystery next time this shows up in the tail.
    console.warn(`handleResearchAgent: ${agentKey} STILL ${fitted.size} chars with zero facts — the bulk is the profile or the injected documents, not _extractedFacts`);
  }

  const payload = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.1,
    max_tokens: agentKey === 'fisheries' ? 8000 : 3000,
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

  // The limnology coercion block that stood here existed to repair a model returning the string
  // "null" and range strings where numbers belonged. Every one of those numbers is now read off a
  // depth profile or an operator's table as a JSON number, so there is nothing left to repair.

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

  // The habitat repair block that stood here split comma-separated strings back into arrays for
  // cover, riprapLocations, namedCreekMouths and artificialHabitat. No agent writes habitat any
  // more: the chartpack and the attractor feeds do, as typed values.

  // Normalize trollingIntelligence — fix bare array season entries like [5, 15]
  // Agent sometimes shortcuts secondary species to just a depth array instead of full season object
  if (agentKey === 'fisheries' && sectionData && typeof sectionData === 'object') {
    console.log(`[fisheries-debug] sectionData keys: ${Object.keys(sectionData).join(', ')}`);
    console.log(`[fisheries-debug] first entry sample: ${JSON.stringify(Object.entries(sectionData)[0])?.slice(0, 200)}`);

    // Same redistribution the group path runs, and now literally the same function. The two
    // copies had already drifted -- this one never listed `catfish` -- which is the argument.
    const bioForRedist = groundedPrev?.biology || {};
    redistributeGroupTerms(sectionData, new Set(
      (Array.isArray(bioForRedist.predatorSpecies) ? bioForRedist.predatorSpecies : [])
        .map((s2) => s2.toLowerCase())));

    const SEASONS = ['spring', 'summer', 'fall', 'winter'];
    // Its own sink -- a separate scope from the group path, and a shared name declared in only
    // one would be a ReferenceError on the one route that writes trolling intelligence.
    const holdingRejects = [];
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
            holding: null,
            waterDepthFt: null,
            sourceQuote: null,
            structures: [],
            forage: [],
            recommendedPresentations: [],
            notes: null
          };
        } else if (typeof entry === 'object' && !Array.isArray(entry)) {
          // Full object — ensure all required keys present
          normSeasons[season] = {
            preferredDepth: Array.isArray(entry.preferredDepth) && entry.preferredDepth.length === 2 ? entry.preferredDepth : null,
            // KEPT, NOT REBUILT AWAY. This normaliser lists the keys of a season entry and
            // constructs a fresh object from them, so any key it does not name is silently
            // discarded no matter what the model returned. `holding` and `waterDepthFt` were
            // added to the agent's schema, its examples and its extraction targets across three
            // separate attempts on 2026-08-10, and every run came back with them absent -- from
            // here, not from the model. The evidence was in the notes the whole time: "they
            // suspend near the bottom in high sun", "they relate to the bottom in 20-30+ feet of
            // water". The agent had the answer and this threw it away on the way out.
            //
            // A normaliser that enumerates keys is a whitelist whether or not anyone meant it as
            // one. Anything added to the fisheries schema has to be added here in the same commit.
holding: coerceHolding(entry.holding, holdingRejects),
            waterDepthFt: Array.isArray(entry.waterDepthFt) && entry.waterDepthFt.length === 2
              ? entry.waterDepthFt : null,
            // THE EVIDENCE TRAVELS WITH THE VALUE. An audit of 2026-08-10 found striper summer
            // reported as [15,40] when the only source in the corpus said "he works the 12- to
            // 22-foot range" -- and 40 ft is below this lake's own anoxic line. Nothing in the
            // output showed the drift, because a number with no sentence behind it looks the
            // same whether it was read or invented. null here means general species knowledge
            // and is an honest answer; a quote is a checkable one.
            sourceQuote: typeof entry.sourceQuote === 'string' && entry.sourceQuote.trim()
              ? entry.sourceQuote.trim().slice(0, 400) : null,
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
// Coastal agents share the RESEARCH_AGENTS registry so handleResearchAgent,
// the section-confidence scorer and the review UI in lake-research-ui.js pick
// them up with no special-casing. They are additive: freshwater lakes never
// select them because coastalAgentPlan() is only consulted for coast_* keys.
Object.assign(RESEARCH_AGENTS, COASTAL_AGENTS);

export {
  RESEARCH_AGENTS, calculateSectionConfidence, gateOverallConfidence,
  hasStructuredTrollingIntel, handleResearchAgent,
  COASTAL_AGENTS, COASTAL_AGENT_HINTS, COASTAL_SKIPPED_AGENTS,
  isCoastalZone, coastalAgentPlan,
};
