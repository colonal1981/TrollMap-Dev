// research/deterministic.js — split from worker-research.js (behavior-preserving)
import { JSON_HEADERS } from '../worker-core.js';
import { researchStorageId } from './keys.js';
import { buildEvidence, buildFactualSummary, getAttractorFacts, getRampSpeciesFacts, uniqueResearchSpecies } from './facts-util.js';

async function handleResearchDeterministicFacts(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || body.lake || '').trim();
  const state = String(body.state || 'SC').trim().toUpperCase();
  const zoneKey = String(body.zoneKey || body.lakeKey || '').trim().toLowerCase();
  if (!lakeName) return new Response(JSON.stringify({ ok: false, error: 'missing lakeName' }), { status: 400, headers: JSON_HEADERS });

  const isCoastal = (() => {
    if (zoneKey && zoneKey.startsWith('coast_')) return true;
    const low = lakeName.toLowerCase();
    return low.startsWith('coast_') || low.includes('coast') || low.includes('inlet') || low.includes('sound') || low.includes('harbor') || low.includes('basin') || low.includes('port royal') || low.includes('murrells inlet') || low.includes('pawleys island') || low.includes('winyah') || low.includes('santee delta') || low.includes('charleston harbor') || low.includes('ace basin') || low.includes('st. helena') || low.includes('beaufort') || low.includes('hilton head') || low.includes('savannah river') || low.includes('ossabaw') || low.includes('sapelo') || low.includes('brunswick') || low.includes('cumberland') || low.includes('cape fear') || low.includes('topsail') || low.includes('bogue sound') || low.includes('core sound') || low.includes('pamlico') || low.includes('outer banks') || low.includes('albemarle');
  })();

  // ── Coastal ramp catalog (mirrors js/data/coastal-zones.js ramps) ─────────
  const COASTAL_RAMP_MAP = {
    coast_winyah_bay_sc: [
      { name: 'Sampit River Ramp (Georgetown)', lat: 33.357, lon: -79.282 },
      { name: 'Andrews Boat Landing', lat: 33.452, lon: -79.561 },
      { name: 'North Island Ramp', lat: 33.217, lon: -79.183 },
    ],
    coast_murrells_inlet_sc: [
      { name: 'Morse Park Landing', lat: 33.553, lon: -79.047 },
      { name: 'Garden City Boat Ramp', lat: 33.601, lon: -79.007 },
    ],
    coast_santee_delta_sc: [
      { name: 'Santee Coastal Reserve Ramp', lat: 33.172, lon: -79.358 },
    ],
    coast_charleston_sc: [
      { name: 'Brittlebank Park Ramp', lat: 32.774, lon: -79.959 },
      { name: "Remley's Point", lat: 32.817, lon: -79.918 },
      { name: 'Shem Creek', lat: 32.795, lon: -79.883 },
    ],
    coast_ace_basin_sc: [
      { name: 'Edisto Beach State Park Ramp', lat: 32.489, lon: -80.309 },
      { name: 'Steamboat Landing (Edisto River)', lat: 32.638, lon: -80.617 },
      { name: 'Jehossee Island Landing', lat: 32.576, lon: -80.496 },
    ],
    coast_st_helena_sc: [
      { name: "Edding's Point Ramp", lat: 32.393, lon: -80.434 },
      { name: 'Coosaw River Landing', lat: 32.441, lon: -80.548 },
    ],
    coast_beaufort_sc: [
      { name: 'Henry C. Chambers Waterfront', lat: 32.431, lon: -80.671 },
      { name: "Lady's Island Marina", lat: 32.426, lon: -80.654 },
      { name: 'Port Royal Landing', lat: 32.38, lon: -80.693 },
    ],
    coast_hilton_head_sc: [
      { name: 'Broad Creek Marina', lat: 32.197, lon: -80.747 },
      { name: 'Shelter Cove', lat: 32.209, lon: -80.722 },
    ],
    coast_savannah_ga: [
      { name: 'Houlihan Bridge Ramp', lat: 32.134, lon: -81.107 },
      { name: 'Port Wentworth Ramp', lat: 32.155, lon: -81.167 },
    ],
    coast_ossabaw_st_catherines_ga: [
      { name: 'Kilkenny Creek Landing', lat: 31.818, lon: -81.237 },
      { name: 'Pine Harbor Marina', lat: 31.882, lon: -81.195 },
    ],
    coast_sapelo_altamaha_ga: [
      { name: 'Shellman Bluff Ramp', lat: 31.542, lon: -81.328 },
      { name: 'Crescent Landing', lat: 31.432, lon: -81.355 },
    ],
    coast_brunswick_st_simons_ga: [
      { name: 'Blythe Island Regional Park', lat: 31.148, lon: -81.537 },
      { name: 'Golden Isles Marina', lat: 31.152, lon: -81.393 },
      { name: 'Schnell Landing', lat: 31.09, lon: -81.45 },
    ],
    coast_cumberland_st_marys_ga: [
      { name: 'St. Marys Boat Ramp', lat: 30.735, lon: -81.55 },
      { name: 'Lang Marina St. Marys', lat: 30.728, lon: -81.546 },
    ],
    coast_brunswick_nc: [
      { name: 'Holden Beach Ramp', lat: 33.913, lon: -78.33 },
      { name: 'Shallotte Inlet Access', lat: 33.892, lon: -78.385 },
      { name: 'Sunset Beach Ramp', lat: 33.878, lon: -78.512 },
    ],
    coast_cape_fear_nc: [
      { name: 'Wilmington Riverfront Ramp', lat: 34.235, lon: -77.948 },
      { name: 'Carolina Beach State Park', lat: 34.052, lon: -77.893 },
      { name: 'Masonboro Inlet Access', lat: 34.171, lon: -77.842 },
      { name: 'Wrightsville Beach Ramp', lat: 34.208, lon: -77.797 },
    ],
    coast_topsail_new_river_nc: [
      { name: 'Sneads Ferry Ramp', lat: 34.557, lon: -77.398 },
      { name: 'Topsail Beach Access', lat: 34.388, lon: -77.647 },
      { name: 'New River Inlet Ramp', lat: 34.527, lon: -77.338 },
    ],
    coast_bogue_sound_nc: [
      { name: 'Morehead City Ramp', lat: 34.724, lon: -76.731 },
      { name: 'Beaufort Town Ramp', lat: 34.718, lon: -76.664 },
      { name: 'Atlantic Beach Ramp', lat: 34.699, lon: -76.741 },
    ],
    coast_core_sound_nc: [
      { name: 'Harkers Island Ramp', lat: 34.692, lon: -76.558 },
      { name: 'Davis Shore Ramp', lat: 34.782, lon: -76.457 },
    ],
    coast_pamlico_sound_nc: [
      { name: 'New Bern Ramp', lat: 35.108, lon: -77.044 },
      { name: 'Oriental Ramp', lat: 35.024, lon: -76.694 },
      { name: 'Bay River Ramp', lat: 35.138, lon: -76.778 },
    ],
    coast_outer_banks_nc: [
      { name: 'Oregon Inlet Ramp', lat: 35.779, lon: -75.531 },
      { name: 'Manteo Waterfront Ramp', lat: 35.908, lon: -75.667 },
      { name: 'Nags Head Fishing Pier', lat: 35.953, lon: -75.621 },
    ],
    coast_albemarle_sound_nc: [
      { name: 'Elizabeth City Ramp', lat: 36.295, lon: -76.222 },
      { name: 'Edenton Ramp', lat: 36.058, lon: -76.607 },
      { name: 'Columbia Ramp', lat: 35.916, lon: -76.251 },
    ],
  };

  // For coastal zones, seed with correct saltwater species and forage, not freshwater
  const coastalPredators = ['Red Drum (Redfish)', 'Spotted Seatrout (Speckled Trout)', 'Southern Flounder', 'Black Drum', 'Sheepshead'];
  const coastalForage = ['Shrimp', 'Finger Mullet', 'Mud Minnows (Mummichog)', 'Menhaden', 'Blue Crab', 'Juvenile Spot/Croaker'];

  const profile = {
    lakeName,
    state,
    identity: { aliases: [], counties: [] },
    biology: {
      primaryForage: isCoastal ? coastalForage.slice(0,3) : [],
      secondaryForage: isCoastal ? coastalForage.slice(3) : [],
      predatorSpecies: isCoastal ? coastalPredators.slice() : [],
      speciesAbundance: {},
      knownStockings: [],
      baitfishMovement: null,
      forageCalendar: {},
      notes: isCoastal ? ['Coastal estuary — saltwater species baseline. Agents estuary/tidal/saltwater_regulations will refine.'] : []
    },
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

  // Structured ramps/species — coastal uses static catalog, freshwater uses ArcGIS
  if (isCoastal) {
    try {
      const coastalKey = zoneKey && COASTAL_RAMP_MAP[zoneKey] ? zoneKey : null;
      // If zoneKey not provided but lakeName matches a known zone, try to resolve by name fragment
      let rampList = coastalKey ? COASTAL_RAMP_MAP[coastalKey] : null;
      if (!rampList) {
        // Fuzzy match: find first zone where lakeName includes zone name fragment or vice versa
        const lowLake = lakeName.toLowerCase();
        for (const [slug, ramps] of Object.entries(COASTAL_RAMP_MAP)) {
          const slugName = slug.replace('coast_', '').replace(/_/g, ' ');
          if (lowLake.includes(slugName.split(' ')[0]) || slugName.includes(lowLake.split(',')[0].trim().split(' ')[0])) {
            // Heuristic match — only use if it seems relevant (contains inlet/sound/etc)
            if (lowLake.includes('inlet') || lowLake.includes('sound') || lowLake.includes('harbor') || lowLake.includes('bay') || lowLake.includes('river')) {
              rampList = ramps;
              break;
            }
          }
        }
      }
      if (rampList && rampList.length) {
        profile.navigation.ramps = rampList.map(r => ({ name: r.name, lat: r.lat, lon: r.lon, lanes: null, county: null, owner: null }));
        mergeEvidence('navigation', 'ramps', [buildEvidence('official_structured', 'TrollMap Coastal Zones Catalog', `internal:coastal-zones/${coastalKey || 'coastal'}`, null, 'structured_waterbody_aggregation', { count: profile.navigation.ramps.length, coastal: true })]);
        profile.sources.push({ label: 'TrollMap Coastal Zones Catalog', url: `internal:coastal-zones/${coastalKey || 'coastal'}`, trust: 'OFFICIAL_GIS', sourceType: 'internal_geospatial_layer' });
      }
    } catch (e) {
      console.warn(`deterministic coastal ramps failed for ${lakeName}: ${e.message}`);
    }
    // No freshwater attractor data for estuaries — oyster/marsh structure handled by habitat agent
  } else {
    // Freshwater: existing ArcGIS path
    try {
      const rampFacts = await getRampSpeciesFacts(env, lakeName, state);
      if (rampFacts) {
        profile.navigation.ramps = rampFacts.ramps.map(r => ({ name: r.name, lat: Math.round(r.lat * 1e6) / 1e6, lon: Math.round(r.lon * 1e6) / 1e6, lanes: r.lanes || null, county: r.county || null, owner: r.owner || null }));
        // For freshwater only: merge species from ramp DB (contains gamefish lists)
        // For coastal we already seeded saltwater species and must NOT mix freshwater species like Largemouth/Striped
        if (!isCoastal) {
          profile.biology.predatorSpecies = uniqueResearchSpecies([...(profile.biology.predatorSpecies || []), ...(rampFacts.predatorSpecies || [])]);
        }
        mergeEvidence('navigation', 'ramps', [buildEvidence('official_structured', rampFacts.sourceLabel, `worker:/ramps?state=${state}`, null, 'structured_waterbody_aggregation', { count: profile.navigation.ramps.length })]);
        if (rampFacts.predatorSpecies?.length) mergeEvidence('biology', 'predatorSpecies', [buildEvidence('official_structured', rampFacts.sourceLabel, `worker:/ramps?state=${state}`, null, 'structured_species_aggregation', { speciesCount: rampFacts.predatorSpecies.length })]);
        profile.sources.push({ label: rampFacts.sourceLabel, url: `worker:/ramps?state=${state}`, trust: 'OFFICIAL_GIS', sourceType: 'official_structured' });
      }
    } catch (e) {
      console.warn(`deterministic ramps fetch failed for ${lakeName}: ${e.message}`);
    }

    // Structured attractors — freshwater only
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

  await env.R2_TROLLMAP_CHARTPACKS.put(key, JSON.stringify(docsWithTags, null, 2), {
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
  let safe = researchStorageId(lakeName);
  const key = `lake_packages/${safe}/normalized_documents.json`;
  let obj = await env.R2_TROLLMAP_CHARTPACKS.get(key).catch(() => null);
  if (!obj && LEGACY_PROFILE_KEYS[safe]) {
    obj = await env.R2_TROLLMAP_CHARTPACKS.get(`lake_packages/${LEGACY_PROFILE_KEYS[safe]}/normalized_documents.json`).catch(() => null);
    if (obj) safe = LEGACY_PROFILE_KEYS[safe];
  }
  if (!obj) return new Response(JSON.stringify({ok:false, error:`no normalized documents for ${lakeName}`}), {status:404, headers:JSON_HEADERS});
  const text = await obj.text();
  let docs;
  try { docs = JSON.parse(text); } catch { return new Response(JSON.stringify({ok:false, error:"corrupt normalized documents"}), {status:500, headers:JSON_HEADERS}); }
  return new Response(JSON.stringify({ok:true, lakeName, count: docs.length, documents: docs}), {headers:JSON_HEADERS});
}

export { handleResearchDeterministicFacts, handleResearchSaveNormalized, handleResearchGetNormalized };
