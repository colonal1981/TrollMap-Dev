// research/deterministic.js — split from worker-research.js (behavior-preserving)
import { JSON_HEADERS, r2Text } from '../worker-core.js';
import { researchStorageId, resolveResearchStorageId } from './keys.js';
import { buildEvidence, buildFactualSummary, getAttractorFacts, getRampSpeciesFacts, uniqueResearchSpecies, splitSpeciesText } from './facts-util.js';

async function handleResearchDeterministicFacts(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || body.lake || '').trim();
  const state = String(body.state || 'SC').trim().toUpperCase();
  if (!lakeName) return new Response(JSON.stringify({ ok: false, error: 'missing lakeName' }), { status: 400, headers: JSON_HEADERS });

  const profile = {
    lakeName,
    state,
    identity: { aliases: [], counties: [] },
    biology: { primaryForage: [], secondaryForage: [], predatorSpecies: [], speciesAbundance: {}, knownStockings: [], baitfishMovement: null, forageCalendar: {}, notes: [] },
    limnology: { waterClarity: { typical: null, color: null, secchiFt: null, note: null }, surfaceWater: {}, thermocline: { summerDepthFt: null, method: null, note: null }, oxygen: { depletionDepthFt: null, anoxicBelowFt: null, note: null }, trophicStatus: null, flowCharacteristics: null, seasonalDrawdownFt: null },
    habitat: { structuralElements: {}, cover: [], vegetation: [], standingTimber: null, dockDensity: null, riprapLocations: [], namedCreekMouths: [], timberFields: null, shallowFlatAreas: null, artificialHabitat: [], artificialHabitatDetails: { attractorCount: null, attractorTypes: [] }, notes: null },
    navigation: { ramps: [], hazards: [], notes: null },
    regulations: { state, generalStateRegulations: { lengthLimits: {}, creelLimits: {} }, lakeSpecificRegulations: { hasExceptions: null, creelLimits: {}, sizeLimits: {}, specialRules: [], closedSeasons: [] }, notes: null },
    summary: { text: null, keywords: [] },
    evidence: { identity: {}, biology: {}, limnology: {}, habitat: {}, navigation: {}, regulations: {}, summary: {} },
    sources: []
  };

  const mergeEvidence = (section, field, entries) => {
    if (!entries?.length) return;
    if (!profile.evidence[section]) profile.evidence[section] = {};
    profile.evidence[section][field] = (profile.evidence[section][field] || []).concat(entries);
  };

  // Document facts are extracted through the normal evidence pipeline. Keeping
  // lake-specific regex corrections here made deterministic facts depend on
  // whichever historical document happened to be cached.

  // Regulations are supplied by the regulations agent from the approved R2
  // digests. Do not add live, per-state URL fallbacks here.

  // Structured ramps/species
  //
  // THE CLIENT'S LIST WINS, BECAUSE THE PIPELINE BOUND IT BY GEOMETRY.
  //
  // getRampSpeciesFacts() below matches the raw feeds with waterbodyMatchesLake(), a
  // bidirectional substring test on the lake's DISPLAY NAME. Counted 2026-08-16, the feeds
  // carry nineteen different waterbody names for J. Strom Thurmond -- "Clarks Hill Lake",
  // "Lake Thurmond", "Little River - Clarks Hill Lake" and sixteen more -- and none of them
  // is a substring of "j strom thurmond reservoir lincoln co ga sc". The endpoint reported
  // "ramps: 0" for a 41,000-acre reservoir that lake_index.json already has 168 ramps for.
  //
  // consolidate_lake_index.py did that join by geometry and got it right. Re-deriving it here
  // by name was always the weaker method; now it is only the fallback, for a caller that
  // cannot send the registry's answer.
  const clientRamps = Array.isArray(body.ramps)
    ? body.ramps.filter((r) => r && Number.isFinite(r.lat) && Number.isFinite(r.lon))
    : [];
  if (clientRamps.length) {
    profile.navigation.ramps = clientRamps.map((r) => ({
      name: r.name, lat: Math.round(r.lat * 1e6) / 1e6, lon: Math.round(r.lon * 1e6) / 1e6,
      lanes: r.lanes ?? null, county: r.county ?? null, owner: r.owner ?? null,
    }));
    const species = uniqueResearchSpecies(clientRamps.flatMap((r) => splitSpeciesText(r.species || '')));
    if (species.length) {
      profile.biology.predatorSpecies = uniqueResearchSpecies([...(profile.biology.predatorSpecies || []), ...species]);
    }
    const label = 'TrollMap registry (pipeline geometry join)';
    mergeEvidence('navigation', 'ramps', [buildEvidence('official_structured', label, 'registry:lake_index.json#ramps', null, 'structured_waterbody_aggregation', { count: profile.navigation.ramps.length })]);
    profile.sources.push({ label, url: 'registry:lake_index.json#ramps', trust: 'OFFICIAL_GIS', sourceType: 'official_structured' });
  }
  try {
    // Skipped entirely when the client already supplied the answer -- a second, weaker join
    // over the same feeds can only disagree with the first.
    const rampFacts = clientRamps.length ? null : await getRampSpeciesFacts(env, lakeName, state);
    if (rampFacts) {
      profile.navigation.ramps = rampFacts.ramps.map(r => ({ name: r.name, lat: Math.round(r.lat * 1e6) / 1e6, lon: Math.round(r.lon * 1e6) / 1e6, lanes: r.lanes || null, county: r.county || null, owner: r.owner || null }));
      profile.biology.predatorSpecies = uniqueResearchSpecies([...(profile.biology.predatorSpecies || []), ...(rampFacts.predatorSpecies || [])]);
      mergeEvidence('navigation', 'ramps', [buildEvidence('official_structured', rampFacts.sourceLabel, `worker:/ramps?state=${state}`, null, 'structured_waterbody_aggregation', { count: profile.navigation.ramps.length })]);
      if (rampFacts.predatorSpecies?.length) mergeEvidence('biology', 'predatorSpecies', [buildEvidence('official_structured', rampFacts.sourceLabel, `worker:/ramps?state=${state}`, null, 'structured_species_aggregation', { speciesCount: rampFacts.predatorSpecies.length })]);
      profile.sources.push({ label: rampFacts.sourceLabel, url: `worker:/ramps?state=${state}`, trust: 'OFFICIAL_GIS', sourceType: 'official_structured' });
    }
  } catch (e) {
    console.warn(`deterministic ramps fetch failed for ${lakeName}: ${e.message}`);
  }

  // Structured attractors
  try {
    const attractorFacts = await getAttractorFacts(env, lakeName, state);
    if (attractorFacts) {
      profile.habitat.artificialHabitat = [...new Set([...(profile.habitat.artificialHabitat || []), 'Fish attractors'])];
      profile.habitat.artificialHabitatDetails.attractorCount = attractorFacts.attractors.length;
      profile.habitat.artificialHabitatDetails.attractorTypes = Object.keys(attractorFacts.typeCounts || {}).sort();
      if (!profile.habitat.notes && attractorFacts.attractors.length) {
        profile.habitat.notes = `${attractorFacts.attractors.length} mapped fish attractors available from ${attractorFacts.sourceLabel}.`;
      }
      mergeEvidence('habitat', 'artificialHabitatDetails', [buildEvidence('official_structured', attractorFacts.sourceLabel, `worker:/attractors?state=${state}`, null, 'structured_waterbody_aggregation', { count: attractorFacts.attractors.length, types: profile.habitat.artificialHabitatDetails.attractorTypes })]);
      profile.sources.push({ label: attractorFacts.sourceLabel, url: `worker:/attractors?state=${state}`, trust: 'OFFICIAL_GIS', sourceType: 'official_structured' });
    }
  } catch (e) {
    console.warn(`deterministic attractors fetch failed for ${lakeName}: ${e.message}`);
  }

  // Simple deterministic summary from explicit facts only
  profile.summary.text = buildFactualSummary(profile);
  profile.summary.keywords = uniqueResearchSpecies([...(profile.biology.predatorSpecies || []), ...(profile.biology.primaryForage || []), ...(profile.habitat.artificialHabitatDetails?.attractorTypes || [])]).slice(0, 12);
  if (profile.summary.text) {
      mergeEvidence('summary', 'text', [buildEvidence('internal_synthesis', 'TrollMap deterministic profile synthesis', 'internal:deterministic-facts', null, 'deterministic_fact_synthesis')]);
  }



  return new Response(JSON.stringify({ ok: true, lakeName, state, profile, seededDiscoveryTargets: [] }), { headers: JSON_HEADERS });
}

async function handleResearchSaveNormalized(request, env) {
  // ── THE FAST PATH: WRITE BYTES, DO NOT READ THEM ────────────────────────────────────────
  //
  // This Worker is on the Cloudflare FREE plan: 10 ms of CPU per request, and unlike the paid
  // plan's 30 s that number cannot be raised. Parsing 1.8 MB of JSON, scanning every document
  // and re-serialising the array does not fit in 10 ms and never did. From wrangler tail,
  // 2026-08-16: "POST /research/save-normalized - Exceeded CPU Limit".
  //
  // The browser has the documents already, has no CPU ceiling, and is where they were fetched.
  // What the Worker has that the browser does not is the R2 credential. So when the client
  // says it has already run the gate -- ?lake=<name> -- the request body goes STRAIGHT into
  // the bucket as a stream. No parse, no stringify, no scan. The gate itself now lives in
  // js/utils/doc-relevance.js, where it is finally testable.
  const _url = new URL(request.url);
  const _preFiltered = _url.searchParams.get('lake');
  if (_preFiltered) {
    const safeKey = `lake_packages/${researchStorageId(_preFiltered)}/normalized_documents.json`;
    await env.R2_TROLLMAP_CHARTPACKS.put(safeKey, request.body, {
      httpMetadata: { contentType: 'application/json' },
    });
    // Counts come from the caller, because counting would mean reading the body.
    const saved = Number(_url.searchParams.get('n'));
    const rejected = Number(_url.searchParams.get('rejected'));
    return new Response(JSON.stringify({
      success: true, key: safeKey, streamed: true,
      saved: Number.isFinite(saved) ? saved : null,
      rejected: Number.isFinite(rejected) ? rejected : null,
    }), { headers: JSON_HEADERS });
  }

  // ── The legacy path, for a client that has not been updated ──────────────────────────────
  // Identical behaviour, and the reason it is kept is that the Worker deploys on push while a
  // browser can still be running last week's bundle out of its service worker cache.
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || "").trim();
  const documents = body.documents || [];
  const agentTags = Array.isArray(body.agentTags) ? body.agentTags : []; // NEW: per-doc agent tags

  if (!lakeName || !documents.length) {
    return new Response(JSON.stringify({ success: false, error: "Missing lakeName or documents payload" }), { status: 400, headers: JSON_HEADERS });
  }

  const safe = researchStorageId(lakeName);
  const key = `lake_packages/${safe}/normalized_documents.json`;

  // Relevance gate — reject docs with no mention of the lake name, base name, or state
  // Prevents off-lake docs (wrong state, wrong lake, tangential articles) from polluting
  // the normalized cache and causing false species extractions downstream
  const baseName = lakeName.replace(/^Lake\s+/i, '').replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i, '').trim();
  const stateMatch = lakeName.match(/,\s*(SC|NC|GA|TN)/i);
  const state = stateMatch ? stateMatch[1].toUpperCase() : '';
  const searchTerms = [
    lakeName.toLowerCase(),
    baseName.toLowerCase(),
    ...(state ? [state.toLowerCase(), ` ${state.toLowerCase()} `, `${state.toLowerCase()} lake`, `lake ${baseName.toLowerCase()}`] : [])
  ];

  const filteredDocuments = documents.filter(doc => {
    const title = (doc.title || '').toLowerCase();
    const preview = (doc.fullText || doc.text || '').slice(0, 3000).toLowerCase();
    const url = (doc.url || '').toLowerCase();
    const combined = title + ' ' + url + ' ' + preview;

    // Must match BOTH lake name/base name AND state — prevents off-state lakes with same name
    // e.g. "Marion Lake, MN" passes lake name check but fails state check
    const lakeNameTerms = [lakeName.toLowerCase(), baseName.toLowerCase()];
    const stateTerms = state ? [
      ` ${state.toLowerCase()} `, `(${state.toLowerCase()})`,
      state.toLowerCase() + ' lake', 'south carolina', 'north carolina',
      'georgia', 'tennessee', 'santee', 'scdnr', 'ncwrc', 'gadnr'
    ] : [];

    const hasLakeName = lakeNameTerms.some(t => combined.includes(t));
    const hasState = !state || stateTerms.some(t => combined.includes(t));

    // Official/priority sources (eRegulations, SCDNR, EPA NSCEP, WQP, Grokipedia) pass automatically
    const isOfficialSource = /eregulations\.com|dnr\.sc\.gov|dnr\.nc\.gov|epd\.georgia|epa\.gov|waterqualitydata|grokipedia|santeecooper|ncwildlife|tw\.gov/i.test(url);

    return isOfficialSource || (hasLakeName && hasState);
  });

  // Add agentTags to each document if provided
  const docsWithTags = filteredDocuments.map((doc, i) => ({
    ...doc,
    agentTags: doc.agentTags || (agentTags[i] || []),
    discoveredBy: doc.discoveredBy || (agentTags[i] ? agentTags[i][0] : 'unknown'),
    fetchedAt: doc.fetchedAt || new Date().toISOString()
  }));

  const rejected = documents.length - filteredDocuments.length;
  if (rejected > 0) {
    console.log(`save-normalized [${lakeName}]: rejected ${rejected} off-lake doc(s) of ${documents.length} total`);
  }

  // COMPACT, NOT PRETTY. This blob is read by code, never by a person, and it carries the full
  // text of every document -- 12 by 150,000 characters on a big lake. Pretty-printing it was
  // CPU spent formatting 1.8 MB that nothing will ever look at, on the exact route wrangler
  // tail caught dying: "POST /research/save-normalized - Exceeded CPU Limit".
  await env.R2_TROLLMAP_CHARTPACKS.put(key, JSON.stringify(docsWithTags), {
    httpMetadata: { contentType: "application/json" }
  });

  return new Response(JSON.stringify({ success: true, key, saved: docsWithTags.length, rejected }), { headers: JSON_HEADERS });
}

async function handleResearchGetNormalized(env, lakeName) {
  const LEGACY_PROFILE_KEYS = {
    'lake_thurmond_sc':       'clarks_hill_thurmond_sc_ga',
    'clarks_hill_lake_ga':    'clarks_hill_thurmond_sc_ga',
    'j_strom_thurmond_lake':  'clarks_hill_thurmond_sc_ga',
    'thurmond_lake_sc':       'clarks_hill_thurmond_sc_ga',
    'richard_b_russell_lake': 'lake_russell_sc',
    'lake_russell_ga':        'lake_russell_sc',
    'lake_russell_sc_ga':     'lake_russell_sc',
  };
  // LEGACY_PROFILE_KEYS above is a third copy of the same alias idea -- keys.js has
  // RESEARCH_CANONICAL_IDS and now the candidate list. Both are tried: the shared resolver
  // first, this file's own map second, so nothing that resolved yesterday stops resolving.
  const found = await resolveResearchStorageId(lakeName,
    (id) => env.R2_TROLLMAP_CHARTPACKS.get(`lake_packages/${id}/normalized_documents.json`).catch(() => null));
  let safe = found ? found.id : researchStorageId(lakeName);
  const key = `lake_packages/${safe}/normalized_documents.json`;
  let obj = found ? found.hit : null;
  if (!obj && LEGACY_PROFILE_KEYS[safe]) {
    obj = await env.R2_TROLLMAP_CHARTPACKS.get(`lake_packages/${LEGACY_PROFILE_KEYS[safe]}/normalized_documents.json`).catch(() => null);
    if (obj) safe = LEGACY_PROFILE_KEYS[safe];
  }
  if (!obj) return new Response(JSON.stringify({ok:false, error:`no normalized documents for ${lakeName}`}), {status:404, headers:JSON_HEADERS});
  const text = await r2Text(obj);
  let docs;
  try { docs = JSON.parse(text); } catch { return new Response(JSON.stringify({ok:false, error:"corrupt normalized documents"}), {status:500, headers:JSON_HEADERS}); }
  return new Response(JSON.stringify({ok:true, lakeName, count: docs.length, documents: docs}), {headers:JSON_HEADERS});
}

export { handleResearchDeterministicFacts, handleResearchSaveNormalized, handleResearchGetNormalized };
