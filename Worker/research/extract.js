// research/extract.js — split from worker-research.js (behavior-preserving)
import { JSON_HEADERS, callLLM, extractLLMText } from '../worker-core.js';
import { extractJsonPossibly } from './keys.js';

async function handleResearchAnalyzeFacts(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || "").trim();
  // The county stamp goes first, and it has to go here too: this is the fallback for a caller
  // that sends no baseName, and the prompt below tells the model to extract only facts that
  // mention this string. "(Hall Co, GA)" is consolidate_lake_index.py's handwriting, not a name
  // any document uses. Same regex as cleanLakeBaseName() in lake-research-engine.js,
  // legacyStorageName() in research/keys.js and lakeTerms() in js/utils/doc-relevance.js -- `Co`
  // as a word, so "Saluda River (2)" keeps the ordinal that is the only thing telling four
  // Saluda Rivers apart.
  const baseName = String(body.baseName || body.lakeName || "")
    .replace(/\s*\([^)]*\bCo\b[^)]*\)\s*/i, ' ').replace(/\s+/g, ' ')
    .replace(/^Lake\s+/i,'').replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i,'').trim() || lakeName;
  const state = String(body.state||'SC').trim();
  const documents = body.documents || [];
  // Optional low-cost Smart Plan recovery mode. Documents still come from the
  // caller's saved R2 normalized corpus; this merely narrows extraction focus.
  const targetFields = Array.isArray(body.targetFields) ? body.targetFields.filter(Boolean).slice(0, 20) : [];

  if (!lakeName || !documents.length) {
    return new Response(JSON.stringify({ success: false, error: "Missing lakeName or documents payload" }), { status: 400, headers: JSON_HEADERS });
  }

  // Filter index/search pages — high URL density, low prose content
  const isIndexPage = (doc) => {
    const text = doc.text || doc.fullText || '';
    const urlMatches = (text.match(/https?:\/\//g) || []).length;
    const words = text.split(/\s+/).length;
    return urlMatches > 40 && urlMatches / words > 0.15;
  };

  const usableDocs = documents.filter(d => !isIndexPage(d));
  const filteredCount = documents.length - usableDocs.length;
  if (filteredCount > 0) {
    console.log(`handleResearchAnalyzeFacts: filtered ${filteredCount} index/search page(s)`);
  }

  if (!usableDocs.length) {
    return new Response(JSON.stringify({ success: false, error: "All documents were index/search pages" }), { status: 400, headers: JSON_HEADERS });
  }

  // Per-document extraction — one LLM call per document
  // This ensures every document gets fully read instead of competing for context budget
  const allFacts = [];
  const docResults = [];

  const SYSTEM = "You are a precise fact extraction engine. Extract verified facts about the specified lake from this single document. Return ONLY valid JSON with extracted_facts array. Never hallucinate. Quote must be verbatim from the document. Confidence 0-100.";


  // ── Keyword sentence harvester ─────────────────────────────────────────────
  // Scans raw document text for sentences containing high-value keywords plus
  // a numeric value. Injects flagged sentences directly into the extraction
  // prompt so the LLM sees the relevant evidence rather than hunting for it.
  const HARVEST_KEYWORDS = [
    // Identity / morphometry
    /normal\s+pool|full\s+pool|pool\s+elevation|pool\s+level|surface\s+elevation/i,
    /thermocline|metalimnion|epilimnion|hypolimnion|stratif/i,
    /dissolved\s+oxygen|\bdo\b.*mg\/l|mg\/l.*\bdo\b|anox|hypox/i,
    /secchi|water\s+clarity|turbidity|clarity/i,
    /trophic|eutrophic|mesotrophic|oligotrophic/i,
    /drawdown|rule\s+curve|guide\s+curve|seasonal.*level|winter.*pool|summer.*pool|normal.*target|target.*level|year.round.*level|level.*year.round|full.*pool|full.pond/i,
    /threadfin|gizzard|blueback|alewife|shad.*forage|forage.*shad/i,
    /retention\s+time|residence\s+time|hydraulic/i,
    /standing\s+timber|submerged\s+timber|stump|cypress.*lake|flooded.*timber/i,
    /riprap|rip[- ]rapped|rocky\s+(?:bank|shoreline)|dam\s+face|causeway|bridge\s+approach/i,
    /creek\s+(?:mouth|arm)|river\s+arm|cove|tributary\s+mouth|inlet/i,
    /dock(?:s|\s+density)|marina|pier|shallow\s+flat|spawning\s+(?:flat|cove)|fish\s+attractor/i,

    // ── WHERE THE FISH ARE, which nothing above was looking for ──────────────────────────────
    //
    // Every pattern above this line is limnology, morphometry or structure. None of them match a
    // sentence about fish, so the single most useful line in the corpus went unflagged and was
    // never extracted:
    //
    //   "15 to 40 feet, though this shifts daily. Early in the morning, they hunt near creek
    //    mouths, points, and humps at around 10 feet deep. As the sun rises, they suspend deeper
    //    to follow schools of shad."
    //
    // AHQ INSIDER Week 32. Depth, holding pattern and the reason it moves, in one sentence, for
    // the species Ryan plans for. It does not say "Wateree" so the alias test missed it too, and
    // the fisheries agent only ever saw it because that agent reads raw document text.
    //
    // Which is worth stating plainly: the facts pass is not a superset of the documents, and any
    // design that treats it as one -- an audit, or an agent assembling only from facts -- inherits
    // this blind spot. Two did today.
    /suspend\w*|holding\s+(?:at|in|around|near|tight)|water\s+column|up\s+off\s+the\s+bottom/i,
    /(?:on|near|hugging|relating\s+to)\s+the\s+bottom|bottom[- ]?hugging|dragging|bumping\s+bottom/i,
    // ANY RANGE IN FEET, not only one followed by "deep". The first cut of this required
    // deep/down/of-water after the unit and therefore still missed both of the sentences that
    // started this -- "15 to 40 feet, though this shifts daily" and "he works the 12- to 22-foot
    // range". Flagging is only prioritisation, capped at twenty sentences, so a false positive
    // costs a line of prompt and a false negative costs the fact.
    /\d+\s*(?:to|-|–|—)\s*\d+\s*-?\s*(?:feet|ft|foot)\b/i,
    /\d+\s*-\s*(?:to|–)\s*\d+\s*-\s*foot/i,
    /\d+[- ]foot\s+(?:range|depth|zone|contour|mark)/i,
    /\d+\s*(?:feet|ft|foot)\s*(?:deep|down|of\s+water)|down\s+\d+\s*(?:feet|ft)/i,
    /down\s?lines?|free\s?lines?|planer\s+boards?|long[- ]?line\s+troll|tight[- ]?lin|umbrella\s+rig|a[- ]rig/i,
    /top\s?water|surface\s+(?:schooling|activity)|schooling|busting|birds?\s+(?:working|diving)/i,
    /pre[- ]?spawn|post[- ]?spawn|spawning\s+run|staging|shad\s+spawn|fall\s+turnover|summer\s+pattern|winter\s+pattern/i,
    /(?:bite|fish|they)\s+(?:are|will\s+be|move|moved|pull|push|drop|hold)\s+(?:up|down|out|back|deeper|shallow)/i,
  ];

  function harvestKeywordSentences(text, maxSentences = 20, lakeAliases = []) {
    if (!text || text.length < 100) return [];
    // Build alias regex if aliases provided — flags sentences mentioning the lake by any known name
    const aliasRx = lakeAliases.length
      ? new RegExp(lakeAliases.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
      : null;
    // Split on sentence boundaries
    const sentences = text
      .replace(/\r\n/g, '\n')
      .split(/(?<=[.!?])\s+(?=[A-Z])|\n{2,}/)
      .map(s => s.replace(/\s+/g, ' ').trim())
      .filter(s => s.length > 20 && s.length < 800);

    const flagged = [];
    const seen = new Set();
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      if (seen.has(s)) continue;
      const hasKeyword = HARVEST_KEYWORDS.some(rx => rx.test(s));
      const hasAlias = aliasRx ? aliasRx.test(s) : false;
      const hasNumber = /\d/.test(s);
      const isCastingTarget = /riprap|rip[- ]rapped|creek\s+(?:mouth|arm)|river\s+arm|cove|tributary\s+mouth|inlet|dock|marina|pier|shallow\s+flat|spawning\s+(?:flat|cove)|fish\s+attractor|timber/i.test(s);
      if ((hasKeyword || hasAlias) && (hasNumber || isCastingTarget || hasAlias)) {
        // Include the next sentence too (handles two-sentence fact patterns)
        const pair = i + 1 < sentences.length
          ? s + ' ' + sentences[i + 1]
          : s;
        flagged.push(pair.slice(0, 600));
        seen.add(s);
        if (flagged.length >= maxSentences) break;
      }
    }
    return flagged;
  }

    const buildDocPrompt = (doc, lakeName, baseName, state) => {
    const combined = (doc.title || '') + ' ' + (doc.url || '');
    const isRegulations = /regulation|regs|eregulation|creel|size.?limit|bag.?limit/i.test(combined);
    const isLimnology = /epa|nscep|water.?qual|limnol|nutrient|eutrophication|characteriz|ferc.*ea|environmental.?assess|relicens|phytoplankton|journal.*water|water.*journal/i.test(combined);
    const isBiology = /fisheries|biology|annual.report|investigations|stocking|species|creel.survey|electrofishing|bass|bream|crappie|striper|catfish|sunfish|perch/i.test(combined);
    const isOperator = /duke.energy|dominion|santee.cooper|usace|army.corps|ferc|cra|agreement/i.test(combined);
    const isGuide = /sportsman|fishing.report|guide|carolinasportsman|anglersheadquarters|takemefishing|hot.*spot|night.*bass|monster|striper.*lake|lake.*striper|bassin|fishing.*sc|sc.*fishing/i.test(combined);
    const isSCDNR = /dnr\.sc\.gov|dnr\.nc\.gov|gadnr|description\.html|lake.*description|scdnr|ncwrc|fisheries.*fact|fact.*sheet/i.test(combined);
    const isGrokipedia = /grokipedia\.com/i.test(doc.url || '');

    const focusParts = [];
    if (isGrokipedia) focusParts.push(`
PRIORITY FIELDS for this Grokipedia reference article — extract ALL of the following if present:

MORPHOMETRY & IDENTITY:
- Surface area in acres
- Maximum depth in feet
- Average/mean depth in feet
- Normal pool elevation (feet NGVD or NAVD)
- Total storage capacity (acre-feet)
- Active/usable storage capacity (acre-feet)
- Shoreline miles
- Year impounded/completed
- Dam name(s) and type
- Reservoir owner/operator (current)
- River system / watershed
- County/counties
- GPS coordinates or location description
- FERC license number and expiration

POOL MANAGEMENT & OPERATIONS:
- Daily water level fluctuation range (feet)
- Seasonal drawdown amount (feet)
- Normal minimum pool elevation
- Pumped storage cycle description
- Hydroelectric capacity (MW)

LIMNOLOGY — extract every number you find:
- Thermocline depth in summer (feet or meters — convert to feet)
- Hypolimnetic anoxia depth (where DO drops below 2 mg/L)
- Surface dissolved oxygen range (mg/L)
- Water clarity / Secchi depth (feet or meters)
- Trophic status (oligotrophic/mesotrophic/eutrophic)
- Total phosphorus (mg/L)
- Chlorophyll-a (µg/L)
- pH range
- Water temperature ranges
- Thermal stratification details

BIOLOGY — extract every species and forage reference:
- All sport fish species documented (list each separately)
- Primary forage fish species (gizzard shad, threadfin shad, alewife, etc.)
- Secondary forage species
- Total number of documented fish species
- Any priority/rare/endangered species present
- Stocking programs (species, quantities, years, agency)
- Trophy fish potential mentions

HABITAT & NAVIGATION:
- Fish attractors (count, types)
- Boat ramps (count, locations)
- Access points
- Fishing restrictions (no jet skis, no water skiing, speed limits, etc.)
- Nuclear exclusion zones or restricted areas
- Standing timber / submerged structure

WATER QUALITY:
- Impairments or 303(d) listings
- PCB or contamination advisories
- E. coli or bacteria issues
- Thermal discharge effects (nuclear/industrial cooling)`);

    if (isLimnology) focusParts.push(`
PRIORITY FIELDS for this document type:
- Thermocline depth: the SPECIFIC DEPTH in meters or feet where temperature drops sharply (epilimnion thickness). Convert meters × 3.281 to feet. Example fact: "Thermocline in Lake X develops at 4-6 meters (~13-20 feet)."
- Oxygen depletion depth: the SPECIFIC DEPTH where DO drops below 2 mg/L. Example fact: "DO drops below 2 mg/L below 5 meters (~16 feet) in Lake X."
- Secchi depth: actual measured value in meters or feet. Example: "Secchi depth averaged 1.2 meters (3.9 feet)."
- Temperature at multiple depths (derive thermocline where temp drops sharply)
- Surface area (in km² or acres — note units), mean depth, max depth (in meters — convert to feet)
- Hydraulic retention time in days
- Trophic status (eutrophic/mesotrophic/oligotrophic)
- Total phosphorus and chlorophyll-a values
- Drawdown schedule / rule curve target elevations
UNIT WARNING: The EPA NES summary table has multiple rows. SECCHI row values are 0.3-0.5m. Alkalinity row is 10-35 mg/L. Do NOT confuse these. Temperature row is in °C.
CRITICAL: If you see a depth value near a thermocline or oxygen keyword, ALWAYS extract it with the specific number. "Oxygen depletion below the thermocline is widespread" is NOT a useful fact without the depth.`);

    if (isBiology) focusParts.push(`
PRIORITY FIELDS for this document type:
- Species present (all game fish and forage species mentioned for this lake)
- Stocking events (species, quantity, year, agency)
- Standing stock biomass (kg/ha) from cove rotenone or electrofishing data
- Species composition percentages (% of standing stock)
- Growth data, PSD/RSD values, electrofishing CPUE
- Forage fish species and relative abundance
- Florida bass allele frequency if mentioned`);

    if (isRegulations) focusParts.push(`
PRIORITY FIELDS for this document type:
- Creel limits by species (statewide AND lake-specific exceptions)
- Size/length limits by species
- Closed seasons (note which waterbodies they apply to — Santee River ≠ Lake Wateree)
- Any gear restrictions or special rules for this lake`);

    if (isOperator) focusParts.push(`
PRIORITY FIELDS for this document type:
- Pool level targets by month (Guide Curve column from CRA table — local datum feet)
- Minimum and maximum pool elevations
- Drawdown schedule and target elevations
- Normal full pool elevation
- ANY sentence mentioning a target lake level, normal operating level, or year-round target (e.g. "normal target lake level is 97 feet year-round")
- Fixed target elevations even without a monthly table`);

    if (isGuide) focusParts.push(`
PRIORITY FIELDS for this document type:
- Thermocline depth (any mention of depth where fish concentrate, e.g. "thermocline at 16 feet")
- Seasonal patterns by species
- Structure types where fish are found
- Forage behavior and depth preferences`);

    if (isSCDNR) focusParts.push(`
PRIORITY FIELDS for this SCDNR/agency lake description or fact sheet:
- Surface area in acres
- Shoreline miles
- Average and maximum depth in feet
- Normal pool elevation
- Boat ramps (count and locations)
- Fish attractors (count and types)
- Fishing access locations
- Marinas
- Species present (list each separately)
- Stocking programs
- Any lake-specific regulations mentioned`);

    // Fallback: if no type matched, use a broad general prompt so no doc gets zero guidance
    if (focusParts.length === 0) focusParts.push(`
PRIORITY FIELDS — extract any of the following present in this document:
- Morphometry: surface area, depth, shoreline, pool elevation
- Limnology: thermocline depth, dissolved oxygen, Secchi depth, trophic status, water clarity
- Biology: species present, stocking, forage fish, standing stock
- Regulations: creel limits, size limits, closed seasons
- Habitat: fish attractors, structure, vegetation
- Navigation: boat ramps, access points, hazards`);

    const targetedRecoveryInstructions = targetFields.length ? `\nTARGETED SMART PLAN RECOVERY: The only requested gaps are ${targetFields.join(', ')}. Prioritize exact, lake-attributed evidence for those fields. Do not return generic facts merely because they are present.` : '';
    const focusInstructions = focusParts.join('\n\n') + targetedRecoveryInstructions;
    const _baseNameStripped = baseName.replace(/,\s*(SC|NC|GA|TN)(\/[A-Z]{2})?\s*$/i, '').trim();
    const _lakeNameStripped = 'Lake ' + _baseNameStripped;

    // ── Document aliases: real-world names used in documents for lakes with
    // non-standard display names (slash names, dual names, renamed lakes, etc.)
    const DOCUMENT_ALIASES = {
      'clarks hill / thurmond': ['Clarks Hill Lake', 'J. Strom Thurmond Lake', 'Lake Thurmond', 'Thurmond Lake', 'Clarks Hill Reservoir', 'Strom Thurmond Lake'],
      'lake russell': ['Richard B. Russell Lake', 'Lake Russell', 'Russell Lake', 'R.B. Russell Lake'],
      'lake wylie': ['Lake Wylie', 'Wylie Lake', 'Lake Wylie Reservoir'],
      'lake monticello': ['Lake Monticello', 'Monticello Reservoir', 'Broad River Reservoir'],
      'fishing creek reservoir': ['Fishing Creek Reservoir', 'Fishing Creek Lake', 'Nitrolee Dam'],
      'lake greenwood': ['Lake Greenwood', 'Buzzard Roost Reservoir'],
      'lake jocassee': ['Lake Jocassee', 'Jocassee Reservoir'],
      'mountain island lake': ['Mountain Island Lake', 'Mountain Island Reservoir'],
      'high rock lake': ['High Rock Lake', 'High Rock Reservoir'],
      'blewett falls lake': ['Blewett Falls Lake', 'Blewett Falls Reservoir', 'Lake Tillery'],
      'lake hartwell': ['Lake Hartwell', 'Hartwell Lake', 'Hartwell Reservoir'],
    };
    const _aliasKey = _baseNameStripped.toLowerCase().replace(/,\s*(sc|nc|ga|tn)(\/[a-z]{2})?\s*$/i, '').trim();
    const _docAliases = DOCUMENT_ALIASES[_aliasKey] || [];
    const _aliasClause = _docAliases.length
      ? ` OR any of these known aliases: ${_docAliases.map(a => `"${a}"`).join(', ')}`
      : '';

    const _flagged = harvestKeywordSentences(doc.text || '', 20, _docAliases);
    const _flaggedBlock = _flagged.length
      ? '⚑ FLAGGED PASSAGES (keyword matches — prioritize extracting facts from these):\n' +
        _flagged.map((s, i) => `[${i+1}] ${s.replace(/`/g, "'").replace(/\$/g, 'USD')}`).join('\n') + '\n\n'
      : '';
    return `Extract ALL verified facts about "${lakeName}" (base name "${baseName}", state ${state}) from this document.

DOCUMENT: ${doc.title}
URL: ${doc.url || 'unknown'}
${focusInstructions}

RULES:
1. Only extract facts that explicitly mention "${baseName}" or "${lakeName}" or "${_baseNameStripped}" or "${_lakeNameStripped}"${_aliasClause}, OR are general ${state} statewide regulations that apply to this lake.
1a. MULTI-LAKE DOCUMENTS: If this document covers multiple lakes or water bodies, only extract numeric facts (depths, areas, temperatures, DO levels, Secchi depths) where the specific number is explicitly attributed to "${_baseNameStripped}" or "${_lakeNameStripped}"${_docAliases.length ? ` or one of its aliases (${_docAliases.join(', ')})` : ''} in the same sentence or the immediately preceding sentence. If a number appears in a paragraph or table row that also discusses another lake, skip it unless the attribution to this lake is unambiguous. When in doubt, omit the fact.
2. Never invent numbers. If a value is not in this document, omit it.
3. Convert all measurements: meters × 3.281 = feet; km² × 247.1 = acres.
   CRITICAL: If you see "Surface area: 205.58 kilometers²" or similar — that is km², convert it: 205.58 × 247.1 = 50,798 acres. NEVER report the raw km² number as if it were acres.
4. For table data: extract each meaningful row as a separate fact with the row content as the quote.
5. If this document has NO information about "${_baseNameStripped}" or "${_lakeNameStripped}"${_aliasClause}, return {"extracted_facts": []}.${_flaggedBlock}DOCUMENT TEXT:
${(doc.text || '').slice(0, 150000)}

Return ONLY:
{"extracted_facts": [{"fact": "concise sentence", "page": 1, "confidence": 85, "source": "${doc.title.slice(0,80)}", "quote": "verbatim text", "category": "category_name"}]}

Categories: surfaceArea, maxDepthFt, averageDepthFt, thermocline, oxygen, secchi, trophicStatus, hydraulicRetentionDays, predatorSpecies, primaryForage, stocking, standingStock, speciesAbundance, seasonalDepth, holdingPattern, waterDepthUnderFish, seasonalPattern, creelLimit_general, creelLimit_lakeSpecific, sizeLimit_general, sizeLimit_lakeSpecific, closedSeason, poolLevel, drawdownSchedule, habitatCover, structuralElement, ramp, hazard, reservoirOwner, damName, yearImpounded, riverSystem, county, consumptionAdvisory, summary
CRITICAL CATEGORY RULES:
- thermocline: MUST include the actual depth in feet or meters (e.g. 'thermocline at 4-6m', 'epilimnion extends to 20 feet'). Do NOT file vague facts like 'thermocline is present' without a depth.
- oxygen: MUST include the depth where DO drops below 2 mg/L (e.g. 'DO < 2 mg/L below 5 meters'). Do NOT file vague facts like 'oxygen depletion occurs' without a depth.
- secchi: MUST include the actual Secchi depth value in meters or feet.
- consumptionAdvisory: use for mercury advisories, meal frequency limits due to contamination — NOT for creel limits
- seasonalDepth: the depth THE FISH are holding at, for a named species and season. "stripers are running 15 to 40 feet" is seasonalDepth. Name the species and the season in the fact sentence whenever the document gives them, because that is what makes the fact usable later.
- waterDepthUnderFish: the depth of the WATER a pattern happens over, when the document gives it separately from the fish depth. "suspended at 20 ft in 35 feet of water" is BOTH a seasonalDepth of 20 and a waterDepthUnderFish of 35 — extract two facts, never one averaged number. These are different measurements and conflating them puts a boat over the wrong water.
- holdingPattern: whether the fish are on the bottom or up in the water column. "they suspend deeper to follow schools of shad" is holdingPattern. So is "anchoring cut bait on the bottom". Extract these even when no depth is given — where a fish sits relative to the bottom is a fact on its own.
- seasonalPattern: how the pattern MOVES — time of day, sun angle, water temperature, a trigger. "shifts daily", "as the sun rises they go deeper", "early morning they hunt at 10 feet" all belong here. A depth with no sense of how it changes is a snapshot presented as a rule.

FISHING BEHAVIOUR IS A FIRST-CLASS FACT. Sentences from guides, fishing reports and lake columns about where a species sits in a given season are the most useful thing in this corpus and were previously dropped for having no category. Extract them with the same care as a Secchi reading. A sentence naming a species, a depth and a time of year is worth more than any morphometry in the document.`;
  };

  for (let i = 0; i < usableDocs.length; i++) {
    const doc = usableDocs[i];
    const docText = doc.text || doc.fullText || '';
    if (!docText || docText.length < 100) {
      console.log(`handleResearchAnalyzeFacts: skipping empty doc [${i+1}]: ${doc.title}`);
      continue;
    }

    try {
      const prompt = buildDocPrompt(doc, lakeName, baseName, state);
      const payload = {
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: prompt }
        ],
        temperature: 0.05,
        max_tokens: 4000,
        response_format: { type: "json_object" }
      };

      const { data } = await callLLM(env, payload, null);
      const text = extractLLMText(data);
      const parsed = extractJsonPossibly(text);

      if (!parsed) {
        console.warn(`handleResearchAnalyzeFacts: doc [${i+1}] "${doc.title}" returned non-JSON`);
        docResults.push({ doc: doc.title, facts: 0, error: 'non-JSON' });
        continue;
      }

      let facts = parsed.extracted_facts || parsed.facts || [];
      if (!Array.isArray(facts)) facts = [];

      // Normalize
      facts = facts.map(f => ({
        fact: String(f.fact||'').trim().slice(0,500),
        page: parseInt(f.page)||1,
        confidence: Math.min(99, Math.max(10, parseInt(f.confidence)||70)),
        source: String(f.source || doc.title || 'Unknown').slice(0,180),
        quote: String(f.quote||'').trim().slice(0,400),
        category: String(f.category||'general').trim().slice(0,50)
      })).filter(f => f.fact.length > 10);

      // Quality filter: require lake mention for non-regulation facts
      const generalCats = new Set(['creelLimit_general','sizeLimit_general','regulations_general','closedSeason']);
      // Build alias check strings for this lake
      const _qfAliasKey2 = baseName.toLowerCase().replace(/,\s*(sc|nc|ga|tn)(\/[a-z]{2})?\s*$/i, '').trim();
      const _qfAliases = ({
        'clarks hill / thurmond': ['clarks hill lake', 'j. strom thurmond lake', 'lake thurmond', 'thurmond lake', 'clarks hill reservoir', 'strom thurmond lake'],
        'lake russell': ['richard b. russell lake', 'lake russell', 'russell lake', 'r.b. russell lake'],
        'lake wylie': ['lake wylie', 'wylie lake'],
        'lake monticello': ['lake monticello', 'monticello reservoir'],
        'fishing creek reservoir': ['fishing creek reservoir', 'fishing creek lake', 'nitrolee dam'],
        'lake greenwood': ['lake greenwood', 'buzzard roost reservoir'],
        'lake hartwell': ['lake hartwell', 'hartwell lake', 'hartwell reservoir'],
        'mountain island lake': ['mountain island lake', 'mountain island reservoir'],
        'high rock lake': ['high rock lake', 'high rock reservoir'],
        'blewett falls lake': ['blewett falls lake', 'blewett falls reservoir'],
      })[_qfAliasKey2] || [];
      const kept = facts.filter(f => {
        if (generalCats.has(f.category) || /general|creel|size.?limit|regulation/i.test(f.category)) return true;
        const combined = `${f.fact} ${f.quote} ${f.source}`.toLowerCase();
        if (combined.includes(baseName.toLowerCase()) || combined.includes(lakeName.toLowerCase())) return true;
        return _qfAliases.some(alias => combined.includes(alias));
      });

      allFacts.push(...kept);
      docResults.push({ doc: doc.title, facts: kept.length });
      console.log(`handleResearchAnalyzeFacts: doc [${i+1}/${usableDocs.length}] "${doc.title.slice(0,50)}" → ${kept.length} facts`);

    } catch (e) {
      console.warn(`handleResearchAnalyzeFacts: doc [${i+1}] failed: ${e.message}`);
      docResults.push({ doc: doc.title, facts: 0, error: e.message });
    }
  }

  return new Response(JSON.stringify({
    success: true,
    extracted_facts: allFacts,
    meta: {
      totalDocs: usableDocs.length,
      filteredIndexPages: filteredCount,
      docResults,
      totalFacts: allFacts.length
    }
  }), { headers: JSON_HEADERS });
}



async function handleResearchDedupeContradictions(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const facts = body.facts || [];

  const normalize = (s) => String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ').slice(0,200);
  const deduplicated = [];
  const contradictions = [];
  const seenFactMap = new Map(); // normalized fact -> index in deduped
  const categoryGroups = new Map(); // category -> array of facts

  for (const f of facts) {
    const factNorm = normalize(f.fact);
    if (!factNorm) continue;
    const cat = String(f.category||'general').toLowerCase().trim();

    // Deduplicate exact or near-identical facts
    if (seenFactMap.has(factNorm)) {
      const existingIdx = seenFactMap.get(factNorm);
      const existing = deduplicated[existingIdx];
      existing.sourcesAgree = (existing.sourcesAgree||1)+1;
      // keep higher confidence quote
      if ((f.confidence||0) > (existing.confidence||0)) {
        existing.confidence = f.confidence;
        existing.quote = f.quote || existing.quote;
        existing.source = f.source || existing.source;
      }
      continue;
    }
    // Near-duplicate check: if one fact contains the other (>80% overlap) treat as same
    let isNearDup = false;
    for (let i=0;i<deduplicated.length;i++) {
      const existingNorm = normalize(deduplicated[i].fact);
      if (factNorm.length > 20 && existingNorm.length > 20) {
        if (factNorm.includes(existingNorm.slice(0, Math.floor(existingNorm.length*0.8))) || existingNorm.includes(factNorm.slice(0, Math.floor(factNorm.length*0.8)))) {
          const existing = deduplicated[i];
          existing.sourcesAgree = (existing.sourcesAgree||1)+1;
          if ((f.confidence||0) > (existing.confidence||0)) {
            existing.confidence = f.confidence;
            existing.quote = f.quote || existing.quote;
          }
          seenFactMap.set(factNorm, i);
          isNearDup = true;
          break;
        }
      }
    }
    if (isNearDup) continue;

    // Contradiction detection — ONLY mutually exclusive claims on the SAME specific attribute.
    // Biology/forage facts are NEVER considered for contradictions (they are almost always complementary).
    // Only identity (acreage, depth, elevation) and regulations (creel/size limits) can produce real conflicts.
    const group = categoryGroups.get(cat) || [];
    // WQP metadata categories — useless for research profile, filter entirely
    const WQP_NOISE_CATS = new Set(['monitoringlocationidentifier','monitoringlocationname','monitoringlocationtypename',
      'monitoringlocationdescription','huc','latitude','longitude','datum','identifier','sitetype',
      'maintainer','watershed','coordinates','country','location']);
    if (WQP_NOISE_CATS.has(cat)) continue; // skip WQP metadata facts entirely

    const IMPORTANT_CATEGORIES = new Set(['identity', 'surfacearea', 'maxdepth', 'averagedepth', 'elevation', 'regulations', 'creellimit_lakespecific', 'sizelimit_lakespecific', 'creellimit', 'sizelimit']);

    if (!IMPORTANT_CATEGORIES.has(cat) && !cat.includes('identity') && !cat.includes('regulation')) {
      // skip biology/forage/limnology/habitat/navigation entirely — they produce false positives
    } else {
      for (const prev of group) {
        const prevText = String(prev.fact).toLowerCase();
        const currText = String(f.fact).toLowerCase();

        // Only look for direct numeric conflicts on the exact same attribute
        // e.g. "13,710 acres" vs "13,025 acres" for surface area, or two different creel limits
        let numberConflict = false;
        const numsPrev = prevText.match(/\d+(?:\.\d+)?/g) || [];
        const numsCurr = currText.match(/\d+(?:\.\d+)?/g) || [];

        if (numsPrev.length && numsCurr.length) {
          const nPrev = parseFloat(numsPrev[0]);
          const nCurr = parseFloat(numsCurr[0]);
          if (isFinite(nPrev) && isFinite(nCurr) && nPrev !== nCurr) {
            // Require the facts to be talking about the exact same measurable attribute
            // (surface area, max depth, creel limit, size limit, elevation, etc.)
            const sameAttr = /acre|surface|depth|elevation|pool|creel|limit|size/i.test(prevText) &&
                             /acre|surface|depth|elevation|pool|creel|limit|size/i.test(currText);
            const relDiff = Math.abs(nPrev - nCurr) / Math.max(1, Math.min(nPrev, nCurr));
            // Don't flag as contradiction if facts mention different species
            const speciesNames = /largemouth|striped|hybrid|crappie|catfish|bream|walleye|pickerel|perch|bass|bluegill|redear|muskellunge|muskie/i;
            const prevSpecies = (prevText.match(speciesNames) || [])[0] || '';
            const currSpecies = (currText.match(speciesNames) || [])[0] || '';
            const differentSpecies = prevSpecies && currSpecies && prevSpecies.toLowerCase() !== currSpecies.toLowerCase();
            // Don't flag seasonal rules as contradictions (Oct-May vs Jun-Sep etc)
            const seasonPattern = /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d+\s*-\s*(may|sept|oct)|spring|summer|fall|winter|seasonal/i;
            const bothSeasonal = seasonPattern.test(prevText) && seasonPattern.test(currText);
            // Skip if both facts contain the same set of numbers — different phrasing of same fact
            const allNumsPrev = new Set((prevText.match(/\d+(?:\.\d+)?/g) || []).map(Number));
            const allNumsCurr = new Set((currText.match(/\d+(?:\.\d+)?/g) || []).map(Number));
            const sameNumbers = [...allNumsPrev].every(n => allNumsCurr.has(n)) && [...allNumsCurr].every(n => allNumsPrev.has(n));
            // 15% threshold filters rounding noise (48k vs 51k acres = 6.25%) while
            // catching real conflicts (13k vs 51k acres = 292%)
            if (sameAttr && relDiff > 0.15 && !differentSpecies && !bothSeasonal && !sameNumbers) {
              numberConflict = true;
            }
          }
        }

        if (numberConflict) {
          contradictions.push({
            field: f.category,
            factA: prev.fact,
            quoteA: prev.quote,
            pageA: prev.page,
            confidenceA: prev.confidence,
            sourceA: prev.source,
            factB: f.fact,
            quoteB: f.quote,
            pageB: f.page,
            confidenceB: f.confidence,
            sourceB: f.source,
            reason: 'mutually exclusive numeric claim on same attribute'
          });
        }
      }
    }
    // Add to deduped
    const entry = { ...f, sourcesAgree: 1 };
    const idx = deduplicated.length;
    deduplicated.push(entry);
    seenFactMap.set(factNorm, idx);
    if (!categoryGroups.has(cat)) categoryGroups.set(cat, []);
    categoryGroups.get(cat).push(entry);
  }

  // Sort deduplicated by confidence desc
  deduplicated.sort((a,b)=> (b.confidence||0)-(a.confidence||0));

  // Deduplicate contradictions by field — keep only the highest-confidence pair per field
  // (per-document extraction produces N facts per field, leading to N*(N-1)/2 contradiction pairs)
  const seenContraField = new Map();
  const dedupedContradictions = contradictions.filter(c => {
    const key = String(c.field).toLowerCase();
    const pairConf = (c.confidenceA || 0) + (c.confidenceB || 0);
    if (!seenContraField.has(key) || pairConf > seenContraField.get(key).conf) {
      seenContraField.set(key, { conf: pairConf, c });
      return false; // will re-add from map below
    }
    return false;
  });
  // Re-add best pair per field
  seenContraField.forEach(({ c }) => dedupedContradictions.push(c));

  return new Response(JSON.stringify({ success: true, deduplicated_facts: deduplicated, contradictions: dedupedContradictions, meta: { input: facts.length, deduped: deduplicated.length, contradictions: dedupedContradictions.length } }), { headers: JSON_HEADERS });
}

// ── GAP QUERY TEMPLATES ──────────────────────────────────────────────────────
const GAP_QUERIES = {
  "limnology.thermocline.summerDepthFt":   (lake, dnr) => `"${lake}" thermocline depth summer stratification fishing`,
  "limnology.oxygen.depletionDepthFt":     (lake, dnr) => `"${lake}" dissolved oxygen depletion depth summer fish floor`,
  "biology.predatorSpecies":               (lake, dnr) => `"${lake}" fish species gamefish bass crappie catfish striped`,
  "biology.primaryForage":                 (lake, dnr) => `"${lake}" forage fish shad herring baitfish`,
  // `dnr` is a COMPLETE site: filter from siteFilter(), not a bare domain — see the note where
  // it is built. Interpolating `site:${dnr}` here is what silently un-scoped the OR.
  "regulations.lakeSpecificRegulations":   (lake, dnr) => `"${lake}" fishing regulations specific creel limit size limit ${dnr}`,
};

// ── MAPPING AGENT — maps extracted facts to profile schema, nulls everything else ──
async function handleResearchMapFacts(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || '').trim();
  const facts = body.facts || [];
  const gapTexts = body.gapTexts || []; // raw text from targeted gap searches
  const pass = body.pass || 1;

  if (!lakeName) {
    return new Response(JSON.stringify({ success: false, error: "Missing lakeName" }), { status: 400, headers: JSON_HEADERS });
  }

  // If neither facts nor gap texts are provided, return empty null profile
  if (!facts.length && !gapTexts.length) {
    const emptyProfile = { identity: { lakeName }, limnology: {}, biology: {}, habitat: {}, navigation: {}, regulations: {}, trollingIntelligence: {} };
    return new Response(JSON.stringify({ success: true, profile: emptyProfile, provider: 'none', model: 'none', pass, factsUsed: 0, note: 'No facts or gap texts provided — all fields null' }), { headers: JSON_HEADERS });
  }

  const factsText = facts.map(f => `[${f.category}] ${f.fact} (Source: ${f.source}, Confidence: ${f.confidence}%)`).join('\n');
  const gapTextsSection = gapTexts.length ? `\n\nADDITIONAL TARGETED SEARCH RESULTS (extract any relevant facts for the null fields):\n${gapTexts.map(g => `[Searching for: ${g.field}]\n${g.text}`).join('\n\n---\n\n').slice(0, 4000)}` : '';

  const prompt = `You are a data mapping agent. You have a list of verified facts and potentially some raw research excerpts (gap texts) for ${lakeName}.

Your job is to map this information to the correct fields in the profile schema below.

STRICT RULES:
- Use the "VERIFIED FACTS" list primarily.
- Use "ADDITIONAL TARGETED SEARCH RESULTS" to fill in null fields. You MUST extract data from these excerpts, including from tables.
- If the data is in a table, treat the row/cell as a verified fact.
- Do NOT infer, estimate, or use any knowledge beyond the provided text.
- Null is correct when data is missing — it means unknown, not bad data.

VERIFIED FACTS FROM OFFICIAL DOCUMENTS:
${factsText.slice(0, 8000)}
${gapTextsSection}

Map this information to this exact JSON schema. Every null means no information was found for that field:
{
  "identity": {
    "lakeName": "${lakeName}",
    "state": null,
    "county": null,
    "riverSystem": null,
    "reservoirOwner": null,
    "surfaceAreaAcres": null,
    "maxDepthFt": null,
    "averageDepthFt": null,
    "normalPoolFt": null,
    "shorelinesLengthMi": null,
    "damName": null,
    "yearImpounded": null,
    "archetype": null,
    "aliases": []
  },
  "limnology": {
    "waterClarity": {"typical": null, "secchiFt": null, "note": null},
    "thermocline": {"summerDepthFt": null, "winterMix": null, "note": null},
    "oxygen": {"depletionDepthFt": null, "anoxicBelowFt": null, "note": null},
    "trophicStatus": null,
    "seasonalDrawdownFt": null
  },
  "biology": {
    "primaryForage": [],
    "secondaryForage": [],
    "predatorSpecies": [],
    "speciesAbundance": {},
    "knownStockings": [],
    "invasiveSpecies": [],
    "spawnTiming": {},
    "forageSpatial": null
  },
  "habitat": {
    "bottomComposition": {},
    "cover": [],
    "vegetation": {},
    "structuralElements": {},
    "artificialHabitat": [],
    "dockDensity": null,
    "riprapLocations": [],
    "namedCreekMouths": [],
    "timberFields": null,
    "shallowFlatAreas": null,
    "standingTimber": null,
    "notes": null
  },
  "navigation": {
    "ramps": [],
    "hazards": [],
    "notes": null
  },
  "regulations": {
    "state": null,
    "generalStateRegulations": {"lengthLimits": {}, "creelLimits": {}},
    "lakeSpecificRegulations": {"hasExceptions": null, "creelLimits": {}, "sizeLimits": {}, "specialRules": [], "closedSeasons": []},
    "notes": null
  },
  "trollingIntelligence": {}
}

Return ONLY valid JSON matching this schema exactly. No explanations.`;

  const payload = {
    messages: [
      { role: "system", content: "You are a strict data mapping agent. Map facts to schema fields only. Return valid JSON only. Never add information not in the facts list." },
      { role: "user", content: prompt }
    ],
    temperature: 0.05,
    max_tokens: 3000,
    response_format: { type: "json_object" }
  };

  try {
    const { data, provider, model } = await callLLM(env, payload, null);
    const text = extractLLMText(data);
    const parsed = extractJsonPossibly(text);
    if (!parsed) return new Response(JSON.stringify({ success: false, error: "Mapping agent returned non-JSON" }), { status: 502, headers: JSON_HEADERS });
    return new Response(JSON.stringify({ success: true, profile: parsed, provider, model, pass, factsUsed: facts.length }), { headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 502, headers: JSON_HEADERS });
  }
}

// ── GAP ANALYSIS — identify null fields and return targeted search queries ──
async function handleResearchGapAnalysis(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || '').trim();
  const profile = body.profile || {};
  const state = String(body.state || 'SC').toUpperCase();

  // ONE TABLE, NOT A SECOND TERNARY. This line used to hard-code the agencies itself and had
  // gone stale on the one that moved: it still said `ncwildlife.org`, which 302s to
  // `ncwildlife.gov`. Measured on Lake Norman, 2026-08-21 -- the old host returns Wikipedia and
  // a lake survey from TEXAS; the current one returns seven NCWRC documents, one dated 2026.
  //
  // It was also malformed. `site:${dnr}` with dnr = 'a OR b' renders `site:a OR b`, which does
  // not scope the OR -- eRegulations was being asked for as a loose keyword, not a domain.
  // siteFilter() gives every term its own `site:` and uses the WHOLE list, so a domain added to
  // the table is a domain that gets searched.
  const { STATE_FISH_AGENCY_DOMAINS, siteFilter } = await import('./discover.js');
  const dnrDomain = siteFilter([...(STATE_FISH_AGENCY_DOMAINS[state] || STATE_FISH_AGENCY_DOMAINS.SC),
                                'eregulations.com']);
  const baseName = lakeName.replace(/^Lake\s+/i,'').replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i,'').trim();

  // Only check fields that directly affect Smart Plan quality
  const nullFields = [];
  const check = (path, val) => {
    if (val === null || val === undefined || val === '' || (Array.isArray(val) && !val.length) || (typeof val === 'object' && !Array.isArray(val) && !Object.keys(val).length)) {
      nullFields.push(path);
    }
  };

  const lim = profile.limnology || {};
  check('limnology.thermocline.summerDepthFt', lim.thermocline?.summerDepthFt);
  check('limnology.oxygen.depletionDepthFt', lim.oxygen?.depletionDepthFt);

  const bio = profile.biology || {};
  check('biology.predatorSpecies', bio.predatorSpecies);
  check('biology.primaryForage', bio.primaryForage);

  const reg = profile.regulations || {};
  const lakeRegs = reg.lakeSpecificRegulations || {};
  if (!lakeRegs.hasExceptions && !Object.keys(lakeRegs.creelLimits||{}).length) {
    nullFields.push('regulations.lakeSpecificRegulations');
  }

  // Build targeted queries for null fields
  const gapQueries = nullFields
    .filter(f => GAP_QUERIES[f])
    .map(f => ({ field: f, query: GAP_QUERIES[f](baseName, dnrDomain) }));

  return new Response(JSON.stringify({
    success: true,
    nullFields,
    gapQueries,
    totalGaps: nullFields.length,
    searchableGaps: gapQueries.length
  }), { headers: JSON_HEADERS });
}

// ── GAP SEARCH — one search down the shared cost ladder, for one null field ──
async function handleResearchGapSearch(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || '').trim();
  const state = String(body.state || 'SC').toUpperCase();
  const field = String(body.field || '').trim();
  const query = String(body.query || '').trim();

  if (!lakeName || !query) return new Response(JSON.stringify({ success: false, error: "Missing lakeName or query", extracted_facts: [], rawText: '' }), { status: 400, headers: JSON_HEADERS });

  // THE CASCADE THAT USED TO LIVE HERE IS NOW searchWeb() IN clients.js.
  //
  // This handler was the ONLY one of six search call sites that could reach Tavily or Firecrawl;
  // the other five called tinyfishSearch() bare and stopped dead when TinyFish came up empty.
  // Rather than copy this block four more times, it moved -- so every search in the research
  // engine now falls down the same cost ladder, and there is one place to change the order.
  try {
    const { searchWeb } = await import('./clients.js');
    const found = await searchWeb({
      query, domain_type: 'web', purpose: `Find ${field} for ${lakeName}`,
    }, env);
    const results = found.results || [];
    const urls = results.map((r) => r.url).filter(Boolean);
    const rawText = results
      .map((r) => (r.content ? `## ${r.title || r.url}\n${r.content}` : ''))
      .filter(Boolean).join('\n\n').slice(0, 8000);
    if (found.provider && found.provider !== 'tinyfish') {
      console.log(`Gap search answered by ${found.provider} for ${query.slice(0, 60)}`);
    }

    if (!results.length) return new Response(JSON.stringify({ success: true, extracted_facts: [], rawText: '', note: "No results found" }), { headers: JSON_HEADERS });

    return new Response(JSON.stringify({ success: true, extracted_facts: [], rawText, field, query, urls }), { headers: JSON_HEADERS });

  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message, extracted_facts: [], rawText: '' }), { status: 502, headers: JSON_HEADERS });
  }
}

// ─── ORIGINAL LAKE RESEARCH MODULE FUNCTIONS ───

export { handleResearchAnalyzeFacts, handleResearchDedupeContradictions, GAP_QUERIES, handleResearchMapFacts, handleResearchGapAnalysis, handleResearchGapSearch };
