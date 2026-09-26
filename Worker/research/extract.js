// research/extract.js — split from worker-research.js (behavior-preserving)
import { JSON_HEADERS, callLLM, countRequests, extractLLMText, firstModelsFor, geminiFreeProviders } from '../worker-core.js';
import { extractJsonPossibly } from './keys.js';
import { textDateOf, readPage, delink } from './text-date.js';

/**
 * A fact read out of a combined document goes back to the text it came from: the block whose text
 * contains its (verbatim) quote, else the [S#] tag the model wrote in `source`, else unchanged.
 * It is dated against that block's text; a fact given back to none has no text to date it by.
 */
function attributeToBlock(fact, blocks, pages) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const q = norm(fact.quote);
  let hit = q.length >= 12 ? blocks.find((b) => norm(b.text || b.fullText).includes(q)) : null;
  if (!hit) {
    const m = /\[S(\d+)\]/.exec(String(fact.source || ''));
    hit = m ? blocks[Number(m[1]) - 1] : null;
  }
  if (!hit) return { ...fact, textDate: null, textDateFrom: null };
  return { ...fact, source: String(hit.title || fact.source || 'Unknown').slice(0, 180),
           ...textDateOf(fact, hit, pages.get(hit)) };
}

async function handleResearchAnalyzeFacts(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || "").trim();
  // The county stamp goes first, and it has to go here too: this is the fallback for a caller
  // that sends no baseName, and the prompt below tells the model to extract only facts that
  // mention this string. "(Hall Co, GA)" is consolidate_lake_index.py's handwriting, not a name
  // any document uses. CORRECTED 2026-09-16: it strips EVERY parenthetical, not just the county.
  //
  // The old rule kept "Saluda River (2)" on the argument that the ordinal is the only thing
  // telling four Saluda Rivers apart. That is true of a STORAGE KEY and false here, because this
  // string is matched against DOCUMENT TEXT and no document contains it. Two jobs, two rules:
  // `legacyStorageName()` in research/keys.js keeps the ordinal because a key must be UNIQUE, and
  // `lakeTerms()` in js/utils/doc-relevance.js strips every parenthetical because a match must be
  // FINDABLE. This line was using the storage rule to do the matching job.
  //
  // 11 of 355 waters were affected, 8 of them rivers. The Congaree was handed ten good documents
  // and told to keep only facts mentioning "Congaree River (to SC-601)". It returned zero.
  const baseName = String(body.baseName || body.lakeName || "")
    .replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ')
    .replace(/^Lake\s+/i,'').replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i,'').trim() || lakeName;
  const state = String(body.state||'SC').trim();
  const documents = body.documents || [];
  // Optional low-cost Smart Plan recovery mode. Documents still come from the
  // caller's saved R2 normalized corpus; this merely narrows extraction focus.
  const targetFields = Array.isArray(body.targetFields) ? body.targetFields.filter(Boolean).slice(0, 20) : [];

  if (!lakeName || !documents.length) {
    return new Response(JSON.stringify({ success: false, error: "Missing lakeName or documents payload" }), { status: 400, headers: JSON_HEADERS });
  }

  // ── A PAGE FULL OF LINKS IS READ WITHOUT ITS LINKS, NOT REFUSED ─────────────────────────────
  //
  // The density test below used to REFUSE the page, and a weekly fishing report is a page full of
  // links: AHQ's sidebar and archive list put 239 URLs around the Lake Jocassee 2023 Week 38 report,
  // 323 words of it the report itself, and the Monticello Week 40 report went the same way on the
  // pilot. Measured 2026-09-25 over the 1,975 stored documents of the backlog's waters, 5 tripped the
  // test: that AHQ report, two Grokipedia citation pages, a Fishing Creek community page and an EPA
  // search page. Only the last is an index with nothing to read.
  //
  // So a page that trips it is sent with its link targets taken out -- `[text](url)` keeps its text,
  // a bare URL goes -- which is the prose a person would read, and a real index then gives the model
  // nothing to extract. The cost of reading one: a call that returns no facts, on 1 page in ~400.
  const isIndexPage = (doc) => {
    const text = doc.text || doc.fullText || '';
    const urlMatches = (text.match(/https?:\/\//g) || []).length;
    const words = text.split(/\s+/).length;
    return urlMatches > 40 && urlMatches / words > 0.15;
  };

  const usableDocs = documents.map((d) => {
    if (!isIndexPage(d)) return d;
    const text = delink(d.text || d.fullText);
    return { ...d, text, fullText: text, delinked: true };
  });
  const delinkedCount = usableDocs.filter((d) => d.delinked).length;
  if (delinkedCount > 0) {
    console.log(`handleResearchAnalyzeFacts: read ${delinkedCount} link-heavy page(s) with their links taken out`);
  }

  // ── MANY SHORT TEXTS, ONE READ: `combine` ─────────────────────────────────────────────────────
  //
  // research_lakes.py sends discovery's search snippets -- a few hundred characters each -- as one
  // request, and this loop read them one model call apiece: ~45 calls in series inside that one
  // request on the Lower Saluda, 2026-09-24, about as long as fetching and reading every real
  // document. A call's time is the model's round trip, not the length -- 361 characters took 13 s.
  //
  // With `combine`, the texts are read as ONE document, each labelled [S1], [S2]... with its title
  // and address, and every fact is given back to the text its quote came from. The quote is
  // verbatim by this prompt's own rule, so that is a lookup, not a judgement; a fact whose quote
  // appears in none keeps what the model said. Texts under 100 characters are left out exactly as
  // the per-document loop below leaves them out, so combining reads what reading one by one read.
  let combinedBlocks = null;
  if (body.combine === true && usableDocs.length > 1) {
    const blocks = usableDocs.filter((d) => String(d.text || d.fullText || '').length >= 100);
    if (blocks.length > 1) {
      combinedBlocks = blocks;
      const text = blocks.map((d, i) => `[S${i + 1}] ${d.title || 'untitled'}${d.url ? ` — ${d.url}` : ''}\n`
        + String(d.text || d.fullText || '')).join('\n\n');
      usableDocs.splice(0, usableDocs.length,
        { title: `Search result snippets (${blocks.length} sources)`, url: '', text });
    }
  }

  // Per-document extraction — one LLM call per document
  // This ensures every document gets fully read instead of competing for context budget
  const allFacts = [];
  const docResults = [];
  // Every request callLLM sent for this request's documents, answered or not -- see sentRecord()
  // in worker-core.js. Returned in meta.llmRequests so the batch can print requests per answer.
  const llmRequests = [];

  const SYSTEM = combinedBlocks
    ? "You are a precise fact extraction engine. The text you are given is many separate search-result snippets, each labelled [S1], [S2]... Extract verified facts about the specified lake from EVERY snippet, reading each one as if it were the only text you had. Return ONLY valid JSON with extracted_facts array. Never hallucinate. Quote must be verbatim from the snippet. Confidence 0-100."
    : "You are a precise fact extraction engine. Extract verified facts about the specified lake from this single document. Return ONLY valid JSON with extracted_facts array. Never hallucinate. Quote must be verbatim from the document. Confidence 0-100.";


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

    // ── The names a document about this water might use.
    //
    // ELEVEN HAND-WRITTEN ALIAS KEYS, NONE OF WHICH COULD EVER MATCH. This block held a table
    // keyed by base name -- 'lake hartwell', 'mountain island lake', 'clarks hill / thurmond',
    // eight more -- and `baseName` arrives here with "Lake ", " Lake" and " Reservoir" already
    // stripped by cleanLakeBaseName(). So the key was never producible: computed across all 358
    // registry rows on 2026-09-01, the 350 distinct keys the code can generate contain not one
    // of the eleven. The table had never fired for any water, ever, which is why Lanier, Russell
    // and Thurmond kept losing facts to documents that call them by the names it listed.
    //
    // It also carried 'Lake Tillery' as an alias of Blewett Falls Lake. They are separate rows
    // 30 km apart on the Pee Dee -- Tillery 4,847 acres, Blewett Falls 2,439 -- so had the key
    // ever matched, every depth attributed to Tillery would have been filed under Blewett Falls.
    //
    // What replaces it is the caller's list, which is derived rather than typed: see
    // documentNamesFromRecord() in js/data/lake-registry.js. It covers every name the table had
    // that is true, generates the Lake/Reservoir spellings the table listed one water at a time,
    // and reaches all 358 rows instead of eleven. County stamps are dropped on the way in for the
    // same reason baseName drops them: they are consolidate_lake_index.py's handwriting.
    // 2026-09-16: THE PARENTHETICAL CAME OFF, AND WHAT WAS INSIDE IT CAME BACK AS ITS OWN ALIAS.
    //
    // This dropped only the county stamp, so "Saluda River (2)" survived into the alias clause as
    // a name no document contains -- the same defect as baseName above, in the one list that is
    // supposed to be the safety net for it. But stripping the parenthetical alone would have
    // thrown away something real: "Saluda River (Lower Saluda)" becomes "Saluda River" and the
    // term that actually distinguishes it -- the one Ryan said documents would use, *"you might
    // see upper and lower but that is about it"* -- is INSIDE the brackets.
    //
    // So both: the bare name, and the contents of any parenthetical that reads like a name rather
    // than a county stamp or a bare ordinal. That is what keeps the two Saluda Rivers apart now
    // that they share a base name, and it is derived from the registry rather than typed.
    const _stripParens = (a) => String(a || '').replace(/\s*\([^)]*\)\s*/g, ' ')
                                               .replace(/\s+/g, ' ').trim();
    const _insideParens = (a) => (String(a || '').match(/\(([^)]*)\)/g) || [])
      .map((p) => p.slice(1, -1).trim())
      .filter((p) => !/\bCo\b|\bCounty\b/i.test(p))   // our handwriting, not the water's
      .filter((p) => /[A-Za-z]{3}/.test(p));          // "(2)" is not a name
    const _fromCaller = (Array.isArray(body.aliases) ? body.aliases : [])
      .flatMap((a) => [_stripParens(a), ..._insideParens(a)])
      .map((a) => String(a || '').trim())
      .filter((a) => a.length >= 4);
    const _docAliases = [..._fromCaller]
      .filter((a) => a.toLowerCase() !== _baseNameStripped.toLowerCase())
      .filter((v, i, arr) => arr.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i)
      .slice(0, 12);
    const _aliasClause = _docAliases.length
      ? ` OR any of these known aliases: ${_docAliases.map(a => `"${a}"`).join(', ')}`
      : '';

    // A COMBINED READ IS MANY TEXTS, AND THE PROMPT HAS TO SAY SO. Measured 2026-09-24 on 42
    // Lower Saluda search snippets sent both ways to the live Worker: read one apiece, 40 facts
    // from 23 of them; read combined under this prompt as it stood, 9. The live run the same
    // afternoon: 53 snippets, 5 facts, against 31 from 49 read separately that morning. The
    // combined read merged snippets into one sentence ("excellent trout fishing in winter and
    // spring, while striper fishing begins to heat up in mid-April") and skipped whole ones --
    // the 26-inch keeper size, the June-October release rule, the stripers eating stocked trout,
    // the kayak sections from Saluda Shoals to Gardendale. The prompt called the text "this
    // document" and flagged up to 20 keyword sentences out of all of them to "prioritize", and a
    // model told to prioritize twenty sentences in one document does exactly that. So a combined
    // read is told what it is, is walked through it snippet by snippet, and gets no flagged block:
    // at a few hundred characters a snippet, every sentence is already in front of it.
    const _combinedNote = combinedBlocks
      ? `\nTHIS IS NOT ONE DOCUMENT. It is ${combinedBlocks.length} separate search-result snippets, each starting with its label ([S1] to [S${combinedBlocks.length}]), its title and its address. Go through them in order and treat every snippet as if it were the only text you had been given: extract every fact each one states about this water. Do not merge facts from different snippets into one sentence, and do not skip a snippet because another one said something similar -- two sources saying the same thing are two facts. Put the snippet's own title in "source". A snippet that says nothing about this water gives no facts.\n`
      : '';
    const _flagged = combinedBlocks ? [] : harvestKeywordSentences(doc.text || '', 20, _docAliases);
    const _flaggedBlock = _flagged.length
      ? '⚑ FLAGGED PASSAGES (keyword matches — prioritize extracting facts from these):\n' +
        _flagged.map((s, i) => `[${i+1}] ${s.replace(/`/g, "'").replace(/\$/g, 'USD')}`).join('\n') + '\n\n'
      : '';
    return `Extract ALL verified facts about "${lakeName}" (base name "${baseName}", state ${state}) from this document.

DOCUMENT: ${doc.title}
URL: ${doc.url || 'unknown'}${_combinedNote}
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
        // A combined read carries the facts of every text in it. This run's snippets gave 31
        // kept facts across ~45 separate reads, which at the ~100 tokens a fact takes is most of
        // the single-document 4,000 -- so twice that, rather than a truncated reply that parses
        // as nothing and loses them all.
        max_tokens: combinedBlocks ? 8000 : 4000,
        response_format: { type: "json_object" }
      };

      // Both free models, each on its own quota: Ryan, 2026-09-24. See drawStart() in
      // Worker/worker-core.js; this read is most of a research run's calls.
      //
      // `extractModels: 'flash'` puts the full Flash models first, on every free key, as
      // `groupModels: 'flash'` does for the species groups (GEMINI_FREE_FLASH_MODELS). For the day
      // Lite is spent: Ryan's batch of 2026-09-25 ran both Lite models out on all five keys
      // ("limit: 500, model: gemini-3.1-flash-lite") with five waters left, while the Flash
      // allowances -- 20 a day per model per key, 400 in all -- were untouched. Lite is still the
      // default: 400 a day is a few waters of reading, not a batch.
      // `'spare'` puts GEMINI_FREE_SPARE_MODELS first instead: firstModelsFor() in worker-core.js.
      //
      // `waitOnRefusal: true` is the batch saying it waits out a rate refusal itself
      // (EXTRACT_RETRY_WAITS in Scripts/research_lakes.py): a per-minute refusal then comes back
      // in docResults with Google's retry delay instead of being walked across every other key
      // and model, each step a request counted against the day. See stopOnRefusal() in
      // worker-core.js. The app's reads do not ask, and walk as before.
      const first = firstModelsFor(body.extractModels);
      const { data, model, requests } = await callLLM(env, payload, null, {
        spreadModels: true,
        waitOnRateRefusal: body.waitOnRefusal === true,
        ...(first ? { firstModels: first } : {}),
      });
      llmRequests.push(...(requests || []));
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
      // THE DATE OF THE TEXT EACH QUOTE CAME FROM -- see research/text-date.js. A fact whose text
      // carries no date gets null, and is kept exactly as it would have been without one.
      if (combinedBlocks) {
        const pages = new Map(combinedBlocks.map((b) => [b, readPage(b)]));
        facts = facts.map((f) => attributeToBlock(f, combinedBlocks, pages));
      } else {
        const page = readPage(doc);
        facts = facts.map((f) => ({ ...f, ...textDateOf(f, doc, page) }));
      }

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
      docResults.push({ doc: doc.title, facts: kept.length, model });
      console.log(`handleResearchAnalyzeFacts: doc [${i+1}/${usableDocs.length}] "${doc.title.slice(0,50)}" → ${kept.length} facts`);

    } catch (e) {
      console.warn(`handleResearchAnalyzeFacts: doc [${i+1}] failed: ${e.message}`);
      llmRequests.push(...((e && e.requests) || []));
      docResults.push({ doc: doc.title, facts: 0, error: e.message,
                        ...(e && e.refusal ? { refusal: e.refusal.kind,
                                               retryAfterMs: e.refusal.retryAfterMs } : {}) });
    }
  }

  return new Response(JSON.stringify({
    success: true,
    extracted_facts: allFacts,
    meta: {
      totalDocs: usableDocs.length,
      filteredIndexPages: 0,               // none are refused now; see delinkedPages
      delinkedPages: delinkedCount,
      docResults,
      totalFacts: allFacts.length,
      llm: countRequests(llmRequests),
      llmRequests,
      // How many free Gemini keys this Worker holds -- only its secrets know (geminiFreeProviders).
      // Scripts/research_lakes.py paces extraction from it.
      freeKeys: geminiFreeProviders(env).length,
    }
  }), { headers: JSON_HEADERS });
}



// ─── ORIGINAL LAKE RESEARCH MODULE FUNCTIONS ───

export { handleResearchAnalyzeFacts };
