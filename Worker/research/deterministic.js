// research/deterministic.js — split from worker-research.js (behavior-preserving)
import { JSON_HEADERS, r2Text } from '../worker-core.js';
import { researchStorageId, resolveResearchStorageId } from './keys.js';
import { buildEvidence, buildFactualSummary, canonicalizeResearchSpecies, getAttractorFacts, getRampSpeciesFacts, uniqueResearchSpecies, splitSpeciesText, isKnownResearchSpecies, RESEARCH_SPECIES_CANON } from './facts-util.js';
import { lakeIndex, ncSpeciesByLake, resolveRegistryRow, identityBaseline, regulationsTable, agencyLakeFacts, fishAdvisories } from '../registry.js';
import { SC_INSHORE_ROSTER, SC_INSHORE_BASIS } from './coastal-agents.js';
import { dukeRowForNames, fetchDukeAccessAlerts, fetchDukeOperatingRange } from '../worker-data.js';
import { parseAccessAlerts, dukeLocationIdFor, dukePoolManagement } from '../conditions.js';

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
    limnology: { waterClarity: { typical: null, secchiFt: null, note: null }, surfaceWater: {}, thermocline: { summerDepthFt: null, method: null, note: null }, oxygen: { depletionDepthFt: null, anoxicBelowFt: null, note: null }, trophicStatus: null, seasonalDrawdownFt: null },
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

  // ── IDENTITY IS ONE FIELD ──────────────────────────────────────────────────────────────────
  //
  // Ryan, 2026-08-31, on a first cut of this that wrote nine of them: "wait... is that information
  // used anywhere... does anyone ask for that?" Almost none of it. Counted by reading the lines,
  // not by matching names:
  //
  //   plan-inputs.js is the ONLY consumer of identity, and it reads three fields --
  //     put('Lake type',     id.archetype || id.bodyType);
  //     put('Max depth',     id.maxDepthFt, ' ft');
  //     put('Average depth', id.averageDepthFt, ' ft');
  //
  //   maxDepthFt and averageDepthFt are ALREADY geometry-derived off the chartpack
  //   (lake-research-engine.js:1057, 2400-2403). So one field is left.
  //
  //   county, gnis, gpsCenter, normalPoolFt, surfaceAreaAcres, reservoirOwner, riverSystem,
  //   yearImpounded and damName have NO reader outside the research pipeline. Every `damName`
  //   match is `ev.damName` on a dam-release event out of the conditions feed, a different
  //   object entirely; `reservoirOwner` does not appear in js/ or Worker/ at all.
  //
  // The first cut wrote all of them "with evidence", which would have made nine dead paths look
  // sourced and defensible -- the precise thing this refactor removes. So it writes ONE, and the
  // registry's `feature_type` is what the "Lake type" line asks for.
  //
  // The pool numbers identityGrounding() fetches are not lost by this: Worker/conditions.js
  // serves full pool and the drawdown schedule live, which is where a number that changes daily
  // belongs. Storing a copy in a research profile is what step 2 already deleted.
  try {
    const base = await identityGrounding(lakeName, env);
    if (base && base.featureType) {
      profile.identity.bodyType = base.featureType;
      mergeEvidence('identity', 'bodyType', buildEvidence([{
        fact: String(base.featureType), source: base.source || 'TrollMap registry',
        trust: 'OFFICIAL', sourceType: 'internal_structured',
      }]));
    }
    // THE DRAWDOWN IS ALREADY IN HAND AND WAS BEING DROPPED ON THE FLOOR.
    //
    // identityGrounding() reads Duke's /lakes/operating-range and identityBaseline() turns the
    // month-by-month guide curve into one number: the swing between the highest and lowest
    // target index, in feet, because a Duke index unit IS a foot. That has been computed on
    // every deterministic run and then discarded, while `limnology.seasonalDrawdownFt` -- which
    // plan-inputs.js prints as "Seasonal drawdown: N ft" -- was left to the limnology agent.
    //
    // The operator publishes the schedule it intends to run. Nothing a model recalls about a
    // winter drawdown can beat that, and for a water whose operator publishes no such table the
    // honest value is null rather than a remembered one.
    if (base && Number.isFinite(base.seasonalDrawdownFt)) {
      profile.limnology.seasonalDrawdownFt = base.seasonalDrawdownFt;
      mergeEvidence('limnology', 'seasonalDrawdownFt', buildEvidence([{
        fact: `${base.seasonalDrawdownFt} ft between the highest and lowest monthly target`
            + `${base.drawdownType ? ` (${base.drawdownType})` : ''}`,
        source: base.normalPoolSource || 'Duke Energy operating-range API',
        trust: 'OFFICIAL', sourceType: 'official_structured',
      }]));
    }
  } catch (e) {
    // A registry miss is not a failed run. resolveRegistryRow refuses an ambiguous name on
    // purpose and an unresolved water is a real, common state.
    profile.identity.registryNote = `registry identity unavailable: ${e && e.message}`;
  }

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
    // BOTH SHAPES, BECAUSE THE REGISTRY WRITES ONE AND THIS READS THE OTHER.
    // build_dnr_ramps_by_lake.py stores `{name, wb, lat, lon, meta: {species, county, owner}}`
    // and this line read `r.species` off the top level, so a caller forwarding a registry record
    // verbatim delivered its ramps and silently no fish. research_lakes.py flattens on the way
    // out; the browser does not have to.
    const species = uniqueResearchSpecies(clientRamps.flatMap(
      (r) => splitSpeciesText(r.species || r.meta?.species || '')));
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

  // SOUTH CAROLINA INSHORE GETS A FLOOR, AND THE EVIDENCE ROW SAYS THAT IS WHAT IT IS.
  //
  // The block above reads species off the state ramp feed. SCDNR's feed carries `SpeciesList` --
  // it is the only one of the four that does -- but the landings inside an estuary are river
  // landings, and their lists are FRESHWATER. Bound by zone bbox on 2026-09-02, not one of the
  // nine SC coastal zones came back with a single inshore species; Winyah Bay reads largemouth
  // and bream. So the coast reached the plan form with a roster of freshwater fish or nothing.
  //
  // See SC_INSHORE_ROSTER in coastal-agents.js for the five, who chose them and what stands
  // behind them. What matters here is that it is written as a FLOOR: `sourceLabel` says so and
  // `method` is `state_inshore_floor`, so a reader can tell this from the NC block above, which
  // is a per-water structured source, without opening either file.
  //
  // ADDITIVE, LIKE EVERY OTHER SPECIES BLOCK. A zone that later gains a real per-water source --
  // Georgia's access layer marks 48 species per point and binds by the zone's own bbox -- adds
  // to this rather than fighting it, and uniqueResearchSpecies() folds the names.
  // THE REGISTRY ROW DECIDES WHETHER THIS IS COASTAL, NOT isCoastalZone(). That helper matches
  // a `coast_*` SLUG, and every caller into this handler passes a DISPLAY NAME -- measured
  // 2026-09-02: isCoastalZone('Murrells Inlet / Pawleys Island, SC') is false and
  // isCoastalZone('coast_murrells_inlet_sc') is true. Guarding on it would have compiled, run,
  // matched nothing and reported nothing. `feature_type` is what put the sixteen coastal rows in
  // lake_index.json, and resolveRegistryRow is the resolver that refuses an ambiguous name
  // rather than guessing -- the same one the North Carolina block below uses.
  const scRow = state === 'SC' ? resolveRegistryRow(await lakeIndex(env), lakeName) : null;
  if (scRow && String(scRow.feature_type || '').toLowerCase() === 'coastal') {
    profile.biology.predatorSpecies = uniqueResearchSpecies(
      [...(profile.biology.predatorSpecies || []), ...SC_INSHORE_ROSTER]);
    const label = SC_INSHORE_BASIS;
    const url = 'registry:regulations_table.json + SCDNR 2025 Species Snapshots';
    mergeEvidence('biology', 'predatorSpecies', [buildEvidence('official_structured', label, url, null,
      'state_inshore_floor', { speciesCount: SC_INSHORE_ROSTER.length, zone: scRow.slug || lakeName })]);
    profile.sources.push({ label: 'SCDNR saltwater species snapshots and SC saltwater limits',
                           url, trust: 'OFFICIAL', sourceType: 'official_structured' });
  }

  // ── EVERYTHING THE REGISTRY ALREADY KNOWS, off four files keyed by this water's slug ───────
  //
  // These were four inline blocks here -- North Carolina's species file, the agency's own lake
  // page, the regulations floor and the advisory floor -- and nothing outside this handler could
  // reach any of them. So a plan got a species roster if somebody had run research on that water,
  // and nothing if they had not, while all four files sat in R2 behind loaders that cache.
  //
  // They are registrySpeciesFor() now, which this calls and so does GET /species. One assembly,
  // in the order it always ran, so which spelling of a fish survives uniqueResearchSpecies() does
  // not depend on who asked. See the function for why these four moved and the ramp feeds,
  // the SC inshore floor and identityGrounding() did not.
  try {
    const reg = await registrySpeciesFor(env, lakeName, state);
    if (reg.predatorSpecies.length) {
      profile.biology.predatorSpecies = uniqueResearchSpecies(
        [...(profile.biology.predatorSpecies || []), ...reg.predatorSpecies]);
    }
    if (reg.knownStockings.length) {
      const already = new Set((profile.biology.knownStockings || [])
        .map((x) => String((x && x.species) || x || '').toLowerCase()));
      for (const st of reg.knownStockings) {
        const key = String(st.species || '').toLowerCase();
        if (!key) continue;
        if (already.has(key)) {
          // The roster flag landed first and carries no count; the stocking plan's note is the
          // number, so it fills in rather than being dropped as a duplicate.
          const hit = (profile.biology.knownStockings || [])
            .find((x) => String((x && x.species) || x || '').toLowerCase() === key);
          if (hit && typeof hit === 'object' && !hit.note && st.note) hit.note = st.note;
          continue;
        }
        already.add(key);
        profile.biology.knownStockings = [...(profile.biology.knownStockings || []), st];
      }
    }
    for (const ev of reg.evidence) mergeEvidence('biology', ev.field, ev.entries);
    for (const src of reg.sources) {
      profile.sources.push({ label: src.label, url: src.url, trust: src.trust,
                             sourceType: src.sourceType });
    }
  } catch (e) {
    // Every block inside already fails soft; this catch is for the registry row lookup itself.
    console.warn(`deterministic registry species lookup failed for ${lakeName}: ${e && e.message}`);
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


/**
 * EVERY SPECIES THE REGISTRY ALREADY KNOWS ABOUT A WATER, off four files keyed by its slug.
 *
 * Ryan, 2026-09-04: "now wire up the fish species to the other states for the refactor".
 *
 * South Carolina and Georgia publish species on their ramp feeds, and since the ramp source
 * tables were merged the browser gets those directly — see Worker/core/ramp-sources.js and
 * rampMeta() in js/data/access-index.js. North Carolina and Tennessee publish none there. Their
 * fish are in `registry/nc_species_by_lake.json` and `registry/agency_lake_facts.json`, both in
 * R2 with loaders in Worker/registry.js since 2026-08-28, and until now the ONLY thing that read
 * either was the research pipeline. So a water reached a plan with a roster if somebody had run
 * research on it, and with nothing if they had not.
 *
 * This is item 2 of the research refactor — THE_PROFILE_BECAME_A_CACHE_AND_NOBODY_MOVED_THE_READS
 * — for the species half: read at plan time, from the registry, instead of out of a stored profile.
 *
 * FOUR SOURCES AND NOT SIX, and the line is drawn where the cost is. These four are R2 reads
 * behind loaders that cache for INDEX_TTL_S. The two left in the research handler are not:
 * `getRampSpeciesFacts()` matches raw feeds and `identityGrounding()` fetches Duke, and a plan
 * must not wait on either. The SC inshore floor stays there too — it is a coastal-only default,
 * not a per-water fact.
 *
 * THE ORDER IS THE HANDLER'S ORDER, unchanged: NC roster, then the agency page roster, then the
 * two floors. uniqueResearchSpecies() folds names as it goes, so the first spelling of a fish is
 * the one that survives, and moving these blocks would have quietly changed which.
 *
 * A ROSTER AND A FLOOR ARE DIFFERENT CLAIMS. The first two say what is in the water. The last two
 * say only that the state wrote a rule about a fish, or sampled one — presence, and nothing about
 * what else is there. `sources[].kind` says which, so a reader can tell without opening this file.
 *
 * Every block fails soft and says so: most waters have no agency page and no advisory, and the
 * loaders throw when an object is not in the bucket yet. Neither is an error.
 *
 * AND THREE OF THESE FOUR EVIDENCE ROWS HAD NEVER BEEN WRITTEN. The handler called
 * `buildEvidence([{fact, source, trust, sourceType}])` for the agency page and both floors --
 * but buildEvidence's signature is `(sourceType, sourceLabel, sourceUrl, quote, method, extra)`,
 * so the array landed in `sourceType` and the call returned an OBJECT. mergeEvidence() opens with
 * `if (!entries?.length) return`, and an object has no length, so every one of them was dropped
 * on the floor. Only the NC block, which passes `[buildEvidence(...)]` correctly, ever recorded
 * anything. That is why species sourced from an agency page or a rule show up in a stored profile
 * with no evidence behind them -- the value was written and the provenance was not. Rebuilt on
 * the real signature here, with the fact text carried in `extra`.
 *
 * @returns {{predatorSpecies: string[], knownStockings: object[], sources: object[],
 *            evidence: {field: string, entries: object[]}[], slug: ?string}}
 */
/**
 * THE FORAGE THE AGENCY ALREADY NAMED, out of the page this file already opens.
 *
 * Ryan, 2026-09-04, on forage being the last thin field: *"is there anything we have on my drive
 * or already in R2 that helps solve that for a majority of the lakes? we have a boat load of data
 * i bet somewhere we have already found it"*. There is. Of the 87 waters in
 * agency_lake_facts.json, 71 mention a forage word and 29 name a specific forage species, and
 * registrySpeciesFor() was reading one field out of that file -- `page.species[].name`.
 *
 * It is better than a lake-level list, because the agency writes it PER PREDATOR. Lake Hartwell,
 * GA DNR, verbatim: *"Threadfin shad and blueback herring are the preferred prey of spotted bass
 * in Lake Hartwell"* and *"Striped bass and hybrid bass feed almost exclusively on blueback
 * herring but trophy-sized stripers will take large gizzard shad at certain times of the year."*
 * That is exactly what the fisheries prompt asks a model to establish from the same documents.
 *
 * NO NEW LIST, AND THAT IS THE WHOLE TRICK. A forage vocabulary would be the fourth hand-written
 * species table in this codebase, and the three that exist have each been wrong. Instead the rule
 * is written out of the two tables already here:
 *
 *     a name RESEARCH_SPECIES_CANON recognises, which uniqueResearchSpecies() then DROPS,
 *     is forage
 *
 * Threadfin Shad, Gizzard Shad, Blueback Herring, Alewife, American Shad and Hickory Shad all
 * canonicalise and all fall out of a predator roster through NON_GAME_SPECIES. That filter has
 * always known which fish are not targets; nothing had ever kept the half it threw away.
 *
 * SUBSTRINGS ARE DROPPED. The canon holds `shad` and `herring` as well as `threadfin shad`, so a
 * sentence naming one yields both; a result that is a strict substring of another result is the
 * shorter reading of the same fish and goes.
 *
 * WHAT THIS DOES NOT CATCH, said plainly rather than guessed at. Crayfish and bluegill are real
 * forage and the same Hartwell sentence names them -- *"they also feed on small sunfish and
 * crayfish"* -- but both SURVIVE the roster filter, bluegill because it is genuinely a game fish
 * too and crayfish because it is not a fish and is not in NON_GAME_SPECIES. Catching them needs
 * either a forage list or a reading of what the sentence MEANS, and both are inventions. The
 * clupeids are the ones that decide a striper or spotted-bass day, and they are what this returns.
 *
 * PRIMARY ONLY. The agency does not rank them, so neither does this: `secondaryForage` is a
 * distinction nobody made and filling it would be the app claiming a judgement it was not given.
 */
export function forageFromAgencyPages(pages) {
  // ONLY WHAT SITS INSIDE A PREDATOR'S WRITE-UP. `overview` is deliberately not read.
  //
  // Cape Fear River is the case that settled it. Its rows are not lake pages at all -- they are
  // survey reports, `species: []`, titled "AMERICAN SHAD MONITORING IN THE CAPE FEAR RIVER-2015"
  // -- and reading their prose yielded `American Shad, Longnose Gar`: the subject of the study,
  // and a sentence saying gar "were the most abundant nongame fish". Neither is forage. Both
  // passed the rule below, because "not a target" and "is prey" are not the same claim.
  //
  // A statement about what something EATS lives in that fish's own entry. Same discipline as the
  // roster guard above, which refuses a species list that names no known fish: the page's own
  // shape says whether it is the kind of document being read.
  const text = [];
  for (const page of (Array.isArray(pages) ? pages : [])) {
    if (!page) continue;
    for (const sp of (page.species || [])) {
      if (!sp) continue;
      // EVERY PROSE FIELD ANY OF THE FOUR AGENCIES WRITES, counted across the file rather than
      // guessed: GA DNR uses prospect/technique/target/notes, TWRA uses notes/tips, SCDNR uses
      // notes, and NCWRC writes `from` -- a citation, not prose, and it carries no forage. The
      // first cut omitted `tips` and lost Cherokee's alewife, which sits in exactly that field.
      for (const k of ['prospect', 'technique', 'target', 'notes', 'tips']) {
        const v = sp[k];
        if (typeof v === 'string') text.push(v);
        else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') text.push(x);
      }
    }
  }
  if (!text.length) return { forage: [], quotes: [] };

  const hay = text.join(' \n ').toLowerCase();
  const found = new Set();
  // THE CANON'S KEYS, AND NOT NON_GAME_SPECIES. Tried the union of both and measured it: that
  // set exists to say what is not a TARGET, so it also holds `other`, `various`, `game fish`,
  // `other species`, `shrimp` and `paddlefish`, and Lanier came back with "Blueback Herring,
  // Carp, Gizzard Shad, Other, Threadfin Shad, Various". "Not a target" and "is prey" are
  // different claims and this is the second time today that difference has bitten.
  //
  // The real gap it exposed was in the CANON: `alewife` was missing from it, which is why
  // Cherokee's alewife was invisible. A real fish belongs in the table of real fish; it is added
  // there rather than papered over here.
  for (const key of Object.keys(RESEARCH_SPECIES_CANON)) {
    // Word boundaries, or `gar` matches "Edgar" and `spot` matches "spotted".
    const re = new RegExp(`(^|[^a-z])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`);
    if (!re.test(hay)) continue;
    const canon = canonicalizeResearchSpecies(key);
    // The roster filter is the test: a fish it keeps is a target, a fish it drops is forage.
    if (canon && !uniqueResearchSpecies([canon]).length) found.add(canon);
  }
  // `Shad` is the shorter reading of `Threadfin Shad`, not a second fish.
  const all = [...found];
  const forage = all.filter((a) => !all.some((b) => b !== a && b.toLowerCase().includes(a.toLowerCase())));

  // The agency's own sentence, so the evidence quotes the page rather than paraphrasing it.
  const quotes = [];
  for (const line of text) {
    const l = line.toLowerCase();
    if (forage.some((f) => l.includes(f.toLowerCase())) && quotes.length < 3) quotes.push(line.trim());
  }
  return { forage: forage.sort(), quotes };
}

export async function registrySpeciesFor(env, lakeName, state = '') {
  const out = { predatorSpecies: [], knownStockings: [], primaryForage: [],
                sources: [], evidence: [], slug: null };
  const addEvidence = (field, entries) => {
    if (entries && entries.length) out.evidence.push({ field, entries });
  };
  let row = null;
  try {
    row = resolveRegistryRow(await lakeIndex(env), lakeName);
  } catch (e) {
    console.warn(`registrySpeciesFor: no registry row for ${lakeName}: ${e && e.message}`);
    return out;
  }
  out.slug = (row && row.slug) || null;
  if (!out.slug) return out;
  const slug = out.slug;
  const st = String(state || (row && row.state) || '').toUpperCase();

  // ── North Carolina's own file, because NC publishes species nowhere else ──────────────────
  if (st === 'NC' || !st) {
    try {
      const entry = (await ncSpeciesByLake(env))[slug] || null;
      if (entry && entry.predatorSpecies && entry.predatorSpecies.length) {
        out.predatorSpecies = uniqueResearchSpecies([...out.predatorSpecies, ...entry.predatorSpecies]);
        const stocked = uniqueResearchSpecies(entry.knownStockings || []);
        const already = new Set(out.knownStockings.map((x) => String((x && x.species) || '').toLowerCase()));
        for (const sp of stocked) {
          if (already.has(sp.toLowerCase())) continue;
          already.add(sp.toLowerCase());
          out.knownStockings.push({ species: sp, source: 'NC WRC public fishing areas' });
        }
        const label = 'NC WRC public fishing areas';
        const url = 'registry:nc_species_by_lake.json';
        addEvidence('predatorSpecies', [buildEvidence('official_structured', label, url, null,
          'structured_species_aggregation',
          { speciesCount: entry.predatorSpecies.length, locations: (entry.locations || []).length })]);
        out.sources.push({ label, url, kind: 'roster', trust: 'OFFICIAL_GIS',
                           sourceType: 'official_structured', species: entry.predatorSpecies.length });
      }
      // The stocking PLAN is a count, not a flag, and is read whether or not the roster matched:
      // a water can be in the spreadsheet with no ncpaws location at all.
      if (entry && Array.isArray(entry.stockingPlan) && entry.stockingPlan.length) {
        const already = new Set(out.knownStockings.map((x) => String((x && x.species) || '').toLowerCase()));
        const add = [];
        for (const r of entry.stockingPlan) {
          const sp = canonicalizeResearchSpecies(r && r.species);
          if (!sp) continue;
          const n = Number(r.number);
          const bits = [Number.isFinite(n) ? n.toLocaleString('en-US') : null,
                        r.size ? `at ${r.size}` : null].filter(Boolean).join(' ');
          const note = `${r.agency || 'NCWRC'}${r.year ? ` ${r.year}` : ''} stocking plan`
                     + (bits ? `: ${bits}` : '');
          const key = sp.toLowerCase();
          if (already.has(key)) {
            const hit = out.knownStockings.find((x) => String((x && x.species) || '').toLowerCase() === key);
            if (hit && !hit.note) hit.note = note;
            continue;
          }
          already.add(key);
          add.push({ species: sp, note, source: 'NC WRC warmwater stocking plan' });
        }
        if (add.length) {
          out.knownStockings.push(...add);
          addEvidence('knownStockings', [buildEvidence('official_structured',
            'NC WRC warmwater stocking plan', 'registry:nc_species_by_lake.json', null, 'deterministic')]);
        }
      }
    } catch (e) {
      console.warn(`registrySpeciesFor NC lookup failed for ${lakeName}: ${e && e.message}`);
    }
  }

  // ── the agency's own lake page: TWRA, SCDNR, GA DNR ───────────────────────────────────────
  try {
    const pages = (await agencyLakeFacts(env))[slug] || null;
    if (Array.isArray(pages) && pages.length) {
      const named = [];
      for (const page of pages) {
        for (const sp of (page.species || [])) {
          const nm = String((sp && sp.name) || '').trim();
          if (nm) named.push(nm);
        }
      }
      const roster = uniqueResearchSpecies(named);
      // A fishing agency's species list that names no fish is not a species list -- the GA DNR
      // PFA template yields `Gallery`, `Fees & Passes`, `Stay connected` from the lake reader.
      if (roster.length && !roster.some(isKnownResearchSpecies)) {
        console.warn(`agency species list for ${lakeName} names no known fish -- ignoring `
                   + `[${roster.slice(0, 6).join(', ')}]; the page is probably not the lake template`);
      } else if (roster.length) {
        out.predatorSpecies = uniqueResearchSpecies([...out.predatorSpecies, ...roster]);
        const agency = pages[0].agency || 'state agency';
        const url = (pages[0].source && pages[0].source.url) || 'registry:agency_lake_facts.json';
        addEvidence('predatorSpecies', [buildEvidence('official_structured',
          `${agency} lake page`, url, null, 'agency_page_roster',
          { fact: roster.join(', '), speciesCount: roster.length })]);
        out.sources.push({ label: `${agency} lake page`, url, kind: 'roster', trust: 'OFFICIAL',
                           sourceType: 'official_structured', species: roster.length });
      }
      // THE SAME PAGE ALSO SAYS WHAT THOSE FISH EAT. Read whether or not the roster survived --
      // a page whose species headings did not pass the known-fish guard can still carry a
      // forage sentence, and the two claims stand on their own.
      const { forage, quotes } = forageFromAgencyPages(pages);
      if (forage.length) {
        out.primaryForage = forage;
        const agency2 = pages[0].agency || 'state agency';
        const url2 = (pages[0].source && pages[0].source.url) || 'registry:agency_lake_facts.json';
        addEvidence('primaryForage', [buildEvidence('official_structured',
          `${agency2} lake page`, url2, quotes[0] || null, 'agency_page_forage',
          { fact: forage.join(', '), speciesCount: forage.length })]);
        out.sources.push({ label: `${agency2} lake page`, url: url2, kind: 'forage',
                           trust: 'OFFICIAL', sourceType: 'official_structured',
                           species: forage.length });
      }
    }
  } catch (e) {
    console.warn(`registrySpeciesFor agency lookup failed for ${lakeName}: ${e && e.message}`);
  }

  // ── the book names the fish it writes a rule for, and that is a FLOOR ─────────────────────
  try {
    const rec = (await regulationsTable(env)).by_water[slug] || null;
    if (rec) {
      const named = new Set();
      const walk = (o) => {
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (!o || typeof o !== 'object') return;
        for (const [k, v] of Object.entries(o)) {
          if (k === 'plan_species' && Array.isArray(v)) {
            for (const sp of v) if (typeof sp === 'string' && sp.trim()) named.add(sp.trim());
          } else walk(v);
        }
      };
      walk(rec);
      const floor = uniqueResearchSpecies([...named]);
      if (floor.length) {
        const before = new Set(out.predatorSpecies.map((s) => String(s).toLowerCase()));
        out.predatorSpecies = uniqueResearchSpecies([...out.predatorSpecies, ...floor]);
        const added = floor.filter((s) => !before.has(s.toLowerCase()));
        const label = `${rec.state || st} fishing regulations digest (lake-specific rules)`;
        addEvidence('predatorSpecies', [buildEvidence('official_structured', label,
          'registry:regulations.json', null, 'lake_rule_species_floor',
          { fact: `Named in this water's own rules: ${floor.join(', ')}`,
            speciesCount: floor.length, notOtherwiseRecorded: added.length })]);
        out.sources.push({ label, url: 'registry:regulations.json', kind: 'floor',
                           trust: 'OFFICIAL', sourceType: 'official_structured', species: floor.length });
      }
    }
  } catch (e) {
    console.warn(`registrySpeciesFor regs floor failed for ${lakeName}: ${e && e.message}`);
  }

  // ── and the consumption advisories, as a second floor ─────────────────────────────────────
  try {
    const recs = (await fishAdvisories(env))[slug] || [];
    const floor = uniqueResearchSpecies(
      recs.flatMap((rec) => (rec.species || []).map((s) => s && s.species)).filter(Boolean));
    if (floor.length) {
      const before = new Set(out.predatorSpecies.map((s) => String(s).toLowerCase()));
      out.predatorSpecies = uniqueResearchSpecies([...out.predatorSpecies, ...floor]);
      const added = floor.filter((s) => !before.has(s.toLowerCase()));
      const labels = [...new Set(recs.map((r) => r.source).filter(Boolean))];
      addEvidence('predatorSpecies', [buildEvidence('official_structured',
        labels.join(' + ') || 'state fish consumption advisories',
        'registry:fish_advisories.json', null, 'advisory_species_floor',
        { fact: `Named in the fish consumption advisory for this water: ${floor.join(', ')}`,
          speciesCount: floor.length, notOtherwiseRecorded: added.length })]);
      out.sources.push({ label: labels.join(' + ') || 'state fish consumption advisories',
                         url: 'registry:fish_advisories.json', kind: 'floor', trust: 'OFFICIAL',
                         sourceType: 'official_structured', species: floor.length });
    }
  } catch (e) {
    console.warn(`registrySpeciesFor advisory floor failed for ${lakeName}: ${e && e.message}`);
  }

  return out;
}

export { handleResearchDeterministicFacts, handleResearchSaveNormalized, handleResearchGetNormalized };

/**
 * Registry identity for any of the 454, plus a pool elevation only if a live feed published one.
 *
 * THE POOL NUMBER IS THE PART THAT HAD TO CHANGE. `LAKES.normalPool` carried nine Duke lakes whose
 * values are byte-identical to what `normalizeDukeRow()` already parses out of Duke's own
 * `Elevation` string — checked against the live feed on 2026-08-17: Wateree 225.5, Wylie 569.4,
 * Norman 760, Keowee 800, Jocassee 1110, Hickory 935, James 1200, Rhodhiss 995.1, Mountain Island
 * 647.5. The feed carries 35 lakes; the table carried nine of them. A hand-typed copy of a live
 * field is a copy that can go stale without anything reporting it.
 *
 * `dukeRowForNames` is used rather than `getDukeLake`, because getDukeLake matches on a bare
 * substring — the family of bug that put Mountain Island Lake's row on Mountain Lake. The names
 * offered are the registry's own, and the matcher runs with sourceMayBeBroader:false.
 *
 * Murray, Marion and Moultrie lose a hand-typed pool constant here and gain county, acres, GNIS
 * and centroid, which the table never had. Dominion and Santee Cooper publish a current elevation
 * and no full pond, so there is no live number to offer for those three and none is invented.
 */
export async function identityGrounding(lakeName, env) {
  const index = await lakeIndex(env);
  const row = resolveRegistryRow(index, lakeName);
  if (!row) return null;
  const names = [row.display_name, row.name, row.legacy_display_name,
                 ...(Array.isArray(row.legacy_display_names) ? row.legacy_display_names : [])]
    .filter(Boolean);
  const duke = await dukeRowForNames(names).catch(() => null);
  const pool = duke && Number.isFinite(duke.fullPool)
    ? { ft: duke.fullPool,
        source: `Duke Energy live lake-levels feed (${duke.duke_feed_name || 'matched row'})` }
    : null;

  // THE DRAWDOWN SCHEDULE OUT OF THE API RATHER THAN OUT OF A PDF. Ryan, 2026-08-17: "for draw
  // down schedule research should point at that api instead of scraping the webpages that it has
  // been doing for duke". The location id is published in the alert feed, so nothing is typed.
  let poolMgmt = null;
  if (duke) {
    const alerts = parseAccessAlerts(await fetchDukeAccessAlerts().catch(() => null));
    const locId = dukeLocationIdFor(alerts, row.display_name || row.name, names);
    if (locId != null) {
      poolMgmt = dukePoolManagement(await fetchDukeOperatingRange(locId).catch(() => null));
    }
  }
  return identityBaseline(row, pool, poolMgmt);
}
