// research/deterministic.js — split from worker-research.js (behavior-preserving)
import { JSON_HEADERS, r2Text } from '../worker-core.js';
import { researchStorageId, resolveResearchStorageId } from './keys.js';
import { buildEvidence, buildFactualSummary, getAttractorFacts, getRampSpeciesFacts, uniqueResearchSpecies, splitSpeciesText } from './facts-util.js';
import { lakeIndex, ncSpeciesByLake, resolveRegistryRow, identityBaseline } from '../registry.js';
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

  // ── IDENTITY, FROM THE REGISTRY, BEFORE ANYONE ASKS A MODEL ────────────────────────────────
  //
  // identityGrounding() has assembled this the whole time -- the registry row, plus a full pool
  // and a drawdown schedule from the operator's own feeds -- and agents.js handed the result to
  // the identity agent AS CONTEXT. The model then restated it, and the restatement was what got
  // stored. That is the shape this refactor exists to remove: the pipeline computes the fact and
  // an LLM is paid to say it back.
  //
  // So it is written here instead. `surfaceAreaAcres`, `maxDepthFt` and `averageDepthFt` are
  // already geometry-derived in the browser (lake-research-engine.js:1057 and 2400-2403, flagged
  // `_geometryDerived`), and mergeMissing only fills what is absent, so nothing here overwrites a
  // measurement taken off the chartpack. What this adds is the registry's own: county, acres when
  // geometry did not answer, feature type, GNIS, centroid, and the pool numbers.
  //
  // WHAT IS STILL THE AGENT'S: `archetype`, `damName`, `reservoirOwner`, `riverSystem` and
  // `yearImpounded`. dam_table.json and water_chain.json can answer the middle three -- the
  // binding already exists in conditions.js -- and that is the next cut, not this one.
  try {
    const base = await identityGrounding(lakeName, env);
    if (base) {
      const id = profile.identity;
      const put = (k, v) => { if (v !== null && v !== undefined && v !== '') id[k] = v; };
      put('county', base.county);
      put('surfaceAreaAcres', base.surfaceAreaAcres);
      put('bodyType', base.featureType);
      put('gnis', base.gnis);
      put('gpsCenter', base.centroid);
      put('normalPoolFt', base.normalPoolFt);
      if (base.poolManagement) put('poolManagement', base.poolManagement);
      if (base.drawdownType) put('drawdownType', base.drawdownType);
      if (base.county) id.counties = [base.county];
      // Evidence, so the card can say where it came from and the contradiction resolver has
      // something to weigh a model's answer against.
      for (const [field, why] of [['county', base.source], ['surfaceAreaAcres', base.source],
                                  ['bodyType', base.source], ['gnis', base.source]]) {
        if (id[field] != null) {
          mergeEvidence('identity', field, buildEvidence([{
            fact: String(id[field]), source: base.source || 'TrollMap registry',
            trust: 'OFFICIAL', sourceType: 'internal_structured',
          }]));
        }
      }
      if (id.normalPoolFt != null && base.normalPoolSource) {
        mergeEvidence('identity', 'normalPoolFt', buildEvidence([{
          fact: String(id.normalPoolFt), source: base.normalPoolSource,
          trust: 'OFFICIAL', sourceType: 'official_structured',
        }]));
      }
    }
  } catch (e) {
    // A registry miss is not a failed run. The identity agent still covers it, and an unresolved
    // name is a real and common state -- resolveRegistryRow refuses an ambiguous one on purpose.
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

  // NORTH CAROLINA'S SPECIES COME FROM A FILE, BECAUSE NC PUBLISHES THEM NOWHERE ELSE.
  //
  // The block above reads `species` off the state ramp feed and works for SC and GA, whose
  // feeds carry `SpeciesList`. NC's feed has no such field and NC has no entry in
  // AGENCY_INDEXES either, so before this, every North Carolina water reached the agents with
  // an empty roster. See ncSpeciesByLake() in ../registry.js for the whole shape of that hole.
  //
  // Keyed by registry SLUG, not by name -- `resolveRegistryRow` is the one resolver that
  // refuses an ambiguous name rather than guessing, and two waters sharing a name is exactly
  // the case that made it that way.
  //
  // `wild` and `stocked` are separate booleans at the source, so a stocked species lands in
  // knownStockings as well as in the roster rather than being inferred from prose.
  if (state === 'NC') {
    try {
      const row = resolveRegistryRow(await lakeIndex(env), lakeName);
      const slug = row && row.slug;
      const entry = slug ? (await ncSpeciesByLake(env))[slug] : null;
      if (entry && entry.predatorSpecies && entry.predatorSpecies.length) {
        profile.biology.predatorSpecies = uniqueResearchSpecies(
          [...(profile.biology.predatorSpecies || []), ...entry.predatorSpecies]);
        const stocked = uniqueResearchSpecies(entry.knownStockings || []);
        if (stocked.length) {
          const already = new Set((profile.biology.knownStockings || [])
            .map((x) => String(x && x.species || '').toLowerCase()));
          profile.biology.knownStockings = [
            ...(profile.biology.knownStockings || []),
            ...stocked.filter((sp) => !already.has(sp.toLowerCase()))
              .map((sp) => ({ species: sp, source: 'NC WRC public fishing areas' })),
          ];
        }
        const label = 'NC WRC public fishing areas';
        const url = 'registry:nc_species_by_lake.json';
        mergeEvidence('biology', 'predatorSpecies', [buildEvidence('official_structured', label, url, null,
          'structured_species_aggregation',
          { speciesCount: entry.predatorSpecies.length, locations: (entry.locations || []).length })]);
        profile.sources.push({ label, url, trust: 'OFFICIAL_GIS', sourceType: 'official_structured' });
      }
    } catch (e) {
      console.warn(`deterministic NC species lookup failed for ${lakeName}: ${e.message}`);
    }
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
