// research/facts-util.js — split from worker-research.js (behavior-preserving)
import { callLLM, extractLLMText } from '../worker-core.js';

function normalizeResearchName(s) {
  return String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function hasResearchValue(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

function buildEvidence(sourceType, sourceLabel, sourceUrl, quote, method, extra = {}) {
  return { sourceType, sourceLabel, sourceUrl, quote: quote || null, method, ...extra };
}

function titleCaseWords(s) {
  return String(s || '').split(/\s+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

const RESEARCH_SPECIES_CANON = {
  'black crappie': 'Black Crappie',
  'white crappie': 'White Crappie',
  'crappie': 'Crappie',
  'striped bass': 'Striped Bass',
  'largemouth bass': 'Largemouth Bass',
  'spotted bass': 'Spotted Bass',
  'smallmouth bass': 'Smallmouth Bass',
  'hybrid bass': 'White Bass / Hybrid',
  'white bass': 'White Bass / Hybrid',
  'white bass hybrid': 'White Bass / Hybrid',
  'striped bass x white bass hybrid': 'White Bass / Hybrid',
  'catfish': 'Catfish',
  'blue catfish': 'Blue Catfish',
  'channel catfish': 'Channel Catfish',
  'flathead catfish': 'Flathead Catfish',
  'bluegill': 'Bluegill',
  'redear sunfish': 'Redear Sunfish (Shellcracker)',
  'shellcracker': 'Redear Sunfish (Shellcracker)',
  'redbreast sunfish': 'Redbreast Sunfish',
  'chain pickerel': 'Chain Pickerel',
  'bowfin': 'Bowfin',
  'yellow perch': 'Yellow Perch',
  'white perch': 'White Perch',
  'threadfin shad': 'Threadfin Shad',
  'gizzard shad': 'Gizzard Shad',
  'blueback herring': 'Blueback Herring',
  'american shad': 'American Shad',
  'trout': 'Trout',
  'rainbow trout': 'Rainbow Trout',
  'brown trout': 'Brown Trout',
  'walleye': 'Walleye',
  'gar': 'Gar',
  'longnose gar': 'Longnose Gar'
};

function canonicalizeResearchSpecies(raw) {
  const n = normalizeResearchName(raw).replace(/\*/g, '').trim();
  if (!n) return null;
  return RESEARCH_SPECIES_CANON[n] || titleCaseWords(n);
}

// Species that must never appear in predatorSpecies regardless of doc content
// Includes protected/endangered species, non-game fish, and forage/baitfish
const NON_GAME_SPECIES = new Set([
  'shortnose sturgeon', 'atlantic sturgeon', 'lake sturgeon', 'pallid sturgeon',
  'paddlefish', 'american eel', 'lamprey', 'sea lamprey',
  'threadfin shad', 'gizzard shad', 'blueback herring', 'american shad', 'alewife',
  'carp', 'common carp', 'bighead carp', 'silver carp', 'grass carp',
  'corbicula', 'asian clam', 'zebra mussel',
  'gar', 'longnose gar', 'spotted gar', 'alligator gar',
  'drum', 'freshwater drum', 'buffalo', 'bigmouth buffalo', 'smallmouth buffalo',
  'sucker', 'white sucker', 'redhorse',
]);

function uniqueResearchSpecies(items) {
  const out = [];
  const seen = new Set();
  for (const raw of items || []) {
    const s = canonicalizeResearchSpecies(raw);
    if (!s) continue;
    const key = normalizeResearchName(s);
    if (seen.has(key)) continue;
    if (NON_GAME_SPECIES.has(key)) continue; // never add non-game/protected/baitfish
    seen.add(key);
    out.push(s);
  }
  return out;
}

function splitSpeciesText(text) {
  const cleaned = String(text || '').replace(/\([^)]*\)/g, ' ').replace(/\band\b/gi, ',').replace(/;/g, ',');
  return cleaned.split(',').map(s => s.trim()).filter(Boolean);
}

async function parseSCDNRDescriptionFacts(lakeName, url, html, env) {
  const text = stripHtmlPreserveTables(html).replace(/\s+/g, ' ').trim();
  const systemPrompt = "You are an expert South Carolina biology and DNR document parser.\n" +
"Extract the following lake facts and details from the provided South Carolina DNR lake description page text.\n\n" +
"For each field, extract:\n" +
"1. The extracted 'value' (adhering to the specified type: number, string, array, etc.).\n" +
"2. The exact 'quote' from the text supporting this extraction.\n\n" +
"JSON Schema to return:\n" +
"{\n" +
"  \"surfaceAreaAcres\": { \"value\": <number|null>, \"quote\": <string|null> },\n" +
"  \"shorelineLengthMi\": { \"value\": <number|null>, \"quote\": <string|null> },\n" +
"  \"counties\": { \"value\": <array of strings>, \"quote\": <string|null> },\n" +
"  \"reservoirOwner\": { \"value\": <string|null>, \"quote\": <string|null> },\n" +
"  \"normalPoolFt\": { \"value\": <number|null>, \"quote\": <string|null> },\n" +
"  \"yearImpounded\": { \"value\": <number|null>, \"quote\": <string|null> },\n" +
"  \"damName\": { \"value\": <string|null>, \"quote\": <string|null> },\n" +
"  \"riverSystem\": { \"value\": <string|null>, \"quote\": <string|null> },\n" +
"  \"archetype\": { \"value\": <string|null>, \"quote\": <string|null> },\n" +
"  \"predatorSpecies\": { \"value\": <array of strings>, \"quote\": <string|null> },\n" +
"  \"knownStockings\": { \"value\": [ { \"species\": <string>, \"agency\": \"SCDNR\", \"note\": <string> } ], \"quote\": <string|null> },\n" +
"  \"attractorCount\": { \"value\": <number|null>, \"quote\": <string|null> },\n" +
"  \"accessPointCount\": { \"value\": <number|null>, \"quote\": <string|null> },\n" +
"  \"publicRampCount\": { \"value\": <number|null>, \"quote\": <string|null> },\n" +
"  \"privateAccessCount\": { \"value\": <number|null>, \"quote\": <string|null> }\n" +
"}\n\n" +
"Notes for extraction rules:\n" +
"- SCDNR description page lists pool elevation as \"Maximum Depth\" and average river depth as \"Average Depth\" — both are misleading and not the actual lake depth. Do not parse these fields into any depth field.\n" +
"- \"counties\" should be the counties within which the lake is located (e.g. [\"Kershaw\", \"Fairfield\", \"Lancaster\"]).\n" +
"- \"predatorSpecies\" are popular sport fish mentioned (e.g. [\"Striped Bass\", \"Largemouth Bass\", \"Crappie\", \"Catfish\"]).\n" +
"- Respond ONLY with valid, raw JSON. Do not include markdown formatting or backticks.";

  const userPrompt = `Lake Name: ${lakeName}\nUrl: ${url}\nText Content:\n${text.slice(0, 12000)}`;

  const identity = { aliases: [], counties: [] };
  const biology = { primaryForage: [], secondaryForage: [], predatorSpecies: [], speciesAbundance: {}, knownStockings: [], baitfishMovement: null, forageCalendar: {}, notes: [] };
  const habitat = { structuralElements: {}, cover: [], vegetation: [], standingTimber: null, dockDensity: null, riprapLocations: [], namedCreekMouths: [], timberFields: null, shallowFlatAreas: null, artificialHabitat: [], artificialHabitatDetails: { attractorCount: null, attractorTypes: [] }, notes: null };
  const navigation = { ramps: [], hazards: [], notes: null, accessPointCount: null, publicRampCount: null, privateAccessCount: null };
  const evidence = { identity: {}, biology: {}, habitat: {}, navigation: {} };

  const store = (section, field, entry) => {
    if (!evidence[section]) evidence[section] = {};
    if (!evidence[section][field]) evidence[section][field] = [];
    evidence[section][field].push(entry);
  };

  try {
    const llmResult = await callLLM(env, {
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      max_tokens: 1500,
      temperature: 0.1,
      response_format: { type: 'json_object' }
    });
    const llmText = extractLLMText(llmResult.data).replace(/`{3}(json)?/g, '').trim();
    const parsed = JSON.parse(llmText);

    if (parsed) {
      // 1. Identity
      if (parsed.surfaceAreaAcres?.value != null) {
        identity.surfaceAreaAcres = parsed.surfaceAreaAcres.value;
        if (parsed.surfaceAreaAcres.quote) {
          store('identity', 'surfaceAreaAcres', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.surfaceAreaAcres.quote, 'llm_extraction'));
        }
      }
      if (parsed.shorelineLengthMi?.value != null) {
        identity.shorelineLengthMi = parsed.shorelineLengthMi.value;
        if (parsed.shorelineLengthMi.quote) {
          store('identity', 'shorelineLengthMi', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.shorelineLengthMi.quote, 'llm_extraction'));
        }
      }
      if (Array.isArray(parsed.counties?.value) && parsed.counties.value.length) {
        identity.counties = parsed.counties.value;
        if (parsed.counties.quote) {
          store('identity', 'counties', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.counties.quote, 'llm_extraction'));
        }
      }
      if (parsed.reservoirOwner?.value) {
        identity.reservoirOwner = parsed.reservoirOwner.value;
        if (parsed.reservoirOwner.quote) {
          store('identity', 'reservoirOwner', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.reservoirOwner.quote, 'llm_extraction'));
        }
      }
      if (parsed.normalPoolFt?.value != null) {
        identity.normalPoolFt = parsed.normalPoolFt.value;
        if (parsed.normalPoolFt.quote) {
          store('identity', 'normalPoolFt', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.normalPoolFt.quote, 'llm_extraction'));
        }
      }
      if (parsed.yearImpounded?.value != null) {
        identity.yearImpounded = parsed.yearImpounded.value;
        if (parsed.yearImpounded.quote) {
          store('identity', 'yearImpounded', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.yearImpounded.quote, 'llm_extraction'));
        }
      }
      if (parsed.damName?.value) {
        identity.damName = parsed.damName.value;
        if (parsed.damName.quote) {
          store('identity', 'damName', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.damName.quote, 'llm_extraction'));
        }
      }
      if (parsed.riverSystem?.value) {
        identity.riverSystem = parsed.riverSystem.value;
        if (parsed.riverSystem.quote) {
          store('identity', 'riverSystem', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.riverSystem.quote, 'llm_extraction'));
        }
      }
      if (parsed.archetype?.value) {
        identity.archetype = parsed.archetype.value;
        if (parsed.archetype.quote) {
          store('identity', 'archetype', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.archetype.quote, 'llm_extraction'));
        }
      }

      // 2. Biology
      if (Array.isArray(parsed.predatorSpecies?.value) && parsed.predatorSpecies.value.length) {
        biology.predatorSpecies = uniqueResearchSpecies(parsed.predatorSpecies.value);
        if (parsed.predatorSpecies.quote) {
          store('biology', 'predatorSpecies', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.predatorSpecies.quote, 'llm_extraction'));
        }
      }
      if (Array.isArray(parsed.knownStockings?.value) && parsed.knownStockings.value.length) {
        biology.knownStockings = parsed.knownStockings.value;
        if (parsed.knownStockings.quote) {
          store('biology', 'knownStockings', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.knownStockings.quote, 'llm_extraction'));
        }
      }

      // 3. Habitat
      if (parsed.attractorCount?.value != null) {
        habitat.artificialHabitat = ['SCDNR fish attractors'];
        habitat.artificialHabitatDetails.attractorCount = parsed.attractorCount.value;
        const note = `s${parsed.attractorCount.value} official SCDNR fish attractors listed on the lake page.`;
        habitat.notes = note;
        if (parsed.attractorCount.quote) {
          store('habitat', 'artificialHabitatDetails', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.attractorCount.quote, 'llm_extraction'));
        }
      }

      // 4. Navigation
      if (parsed.accessPointCount?.value != null) {
        navigation.accessPointCount = parsed.accessPointCount.value;
        if (parsed.accessPointCount.quote) {
          store('navigation', 'accessPointCount', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.accessPointCount.quote, 'llm_extraction'));
        }
      }
      if (parsed.publicRampCount?.value != null) {
        navigation.publicRampCount = parsed.publicRampCount.value;
        if (parsed.publicRampCount.quote) {
          store('navigation', 'publicRampCount', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.publicRampCount.quote, 'llm_extraction'));
        }
      }
      if (parsed.privateAccessCount?.value != null) {
        navigation.privateAccessCount = parsed.privateAccessCount.value;
        if (parsed.privateAccessCount.quote) {
          store('navigation', 'privateAccessCount', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.privateAccessCount.quote, 'llm_extraction'));
        }
      }
    }
  } catch (err) {
    console.error(`LLM SCDNR Description Fact extraction failed: ${err.message}`);
  }

  return { identity, biology, habitat, navigation, evidence, sources: [{ label: 'SCDNR Lake Description', url, trust: 'OFFICIAL', sourceType: 'official_document' }] };
}

const RESEARCH_RAMP_SOURCES = {
  SC: {
    url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/South_Carolina_Public_Water_Access_PUBLIC_VIEW/FeatureServer/0/query",
    label: 'SCDNR South Carolina Public Water Access',
    idField: 'OBJECTID',
    filter: (p) => p.WaterAccessType === 'Boat Ramp' && String(p.Status || '').toLowerCase() === 'active' && String(p.PublicAccess || '').toLowerCase() !== 'closed',
    name: (p) => p.WaterAccessName,
    wb: (p) => p.Waterbody,
    lat: (p) => p.Latitude,
    lon: (p) => p.Longitude,
    meta: (p) => ({ lanes: p.LaunchLanes, dock: p.CourtesyDock, fee: false, species: p.SpeciesList, county: p.County, owner: p.Owner, comments: p.Comments })
  },
  GA: {
    url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/WRD_Water_Access_Points/FeatureServer/0/query",
    label: 'Georgia DNR WRD Water Access Points',
    idField: 'FID',
    filter: (p) => String(p.Ramp || '').toUpperCase() === 'Y' && !['closed', 'inactive'].includes(String(p.Status || '').toLowerCase()),
    name: (p) => p.Name,
    wb: (p) => p.Waterbody,
    lat: (p) => p.Latitude,
    lon: (p) => p.Longitude,
    meta: (p) => ({ lanes: p.NumLanes, dock: p.Dock, fee: String(p.Fee || '').toUpperCase() === 'Y', species: p.SpeciesList || '', county: p.County, owner: p.Owner, motorRestrictions: p.MotorRest })
  },
  NC: {
    url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/NCWRC_Boating_Access_Areas_view/FeatureServer/0/query",
    label: 'NC Wildlife Resources Commission Boating Access Areas',
    idField: 'OBJECTID',
    filter: (p) => !String(p.Site_Status || 'OPEN').toUpperCase().includes('CLOSED'),
    name: (p) => p.BAA_Name,
    wb: (p) => p.Water_Access || p.BAA_Alias,
    lat: (p) => p.Latitude,
    lon: (p) => p.Longitude,
    meta: (p) => ({ lanes: p.Launch_Lane_No, dock: p.Courtesy_Dock_No || p.Fix_Dock_No, fee: false, species: '', county: p.County, owner: p.Owner, motorRestrictions: p.Motorboats_Restricted })
  },
  TN: {
    url: "https://services3.arcgis.com/PWXNAH2YKmZY7lBq/arcgis/rest/services/Boat_Launch_Sites/FeatureServer/0/query",
    label: 'Tennessee Wildlife Resources Agency Boat Launch Sites',
    idField: 'OBJECTID',
    filter: (p) => p.Type === 'Boat Launch' && String(p.IncludeWeb || '').toLowerCase() === 'yes' && !/^(none|0)$/i.test(String(p.Ramps || '')),
    name: (p) => p.Name,
    wb: (p) => p.Waterway,
    lat: (p) => p.Latitude,
    lon: (p) => p.Longitude,
    meta: (p) => ({ lanes: p.Lanes, dock: String(p.CourtesyDock || '').toLowerCase() === 'yes', fee: String(p.AccessFee || '').toLowerCase() === 'yes', species: '', county: p.County, owner: p.Owner, launchable: p.Launchable })
  }
};

const RESEARCH_ATTRACTOR_SOURCES = {
  SC: {
    url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/SCDNR_Freshwater_Fish_Attractors_Public_Web_App/FeatureServer/0/query",
    label: 'SCDNR Freshwater Fish Attractors',
    idField: 'OBJECTID',
    filter: () => true,
    name: (p) => p.FishAttractorName,
    wb: (p) => p.Waterbody,
    lat: (p) => p.lat_dd,
    lon: (p) => p.lon_dd,
    type: (p) => p.Material
  },
  GA: {
    url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/Fish_Attractors_for_Download/FeatureServer/0/query",
    label: 'Georgia DNR Fish Attractors',
    idField: 'OBJECTID',
    filter: () => true,
    name: (p) => p.note,
    wb: (p) => p.waterbody,
    lat: () => null,
    lon: () => null,
    type: (p) => `${p.attractor_code || ''} ${p.attractor_code_other || ''}`.trim()
  },
  NC: {
    url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/Fish_Attractors_public_view/FeatureServer/0/query",
    label: 'NC WRC Fish Attractors',
    idField: 'OBJECTID',
    filter: () => true,
    name: (p) => `${p.Waterbody} Attractor`,
    wb: (p) => p.Waterbody,
    lat: (p) => p.Latitude,
    lon: (p) => p.Longitude,
    type: (p) => `${p.Structure1 || ''} ${p.Structure2 || ''}`.trim() || p.Attractor_Type
  },
  TN: {
    url: "https://services3.arcgis.com/PWXNAH2YKmZY7lBq/arcgis/rest/services/Fish_Attractor_Locations_view/FeatureServer/0/query",
    label: 'Tennessee Wildlife Resources Agency Fish Attractors',
    idField: 'OBJECTID',
    filter: () => true,
    name: (p) => p.Site_Name || (p.Embayment ? `${p.WaterBody} - ${p.Embayment}` : `${p.WaterBody} Attractor`),
    wb: (p) => p.WaterBody,
    lat: (p) => p.YLat,
    lon: (p) => p.XLong,
    type: (p) => [p.StructureTypes, p.Artificial, p.Natural_].filter(Boolean).join(', ') || 'Unknown'
  }
};

async function fetchArcGISGrouped(env, cacheKey, sourceDef, buildRecord) {
  try {
    const cached = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
    if (cached) {
      const txt = await cached.text();
      return JSON.parse(txt);
    }
  } catch (_) {}
  const allFeatures = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const params = new URLSearchParams({ outFields: '*', where: '1=1', f: 'geojson', resultOffset: offset, resultRecordCount: pageSize, orderByFields: sourceDef.idField || 'OBJECTID' });
    const resp = await fetch(`${sourceDef.url}?${params.toString()}`, { headers: { 'User-Agent': 'TrollMap/1.0 (Cloudflare Worker)', 'Accept': 'application/json' }, cf: { cacheTtl: 0 } });
    if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status}`);
    const data = await resp.json();
    const features = data.features || [];
    allFeatures.push(...features);
    if (features.length < pageSize) break;
    offset += pageSize;
  }
  const waterbodies = {};
  for (const feat of allFeatures) {
    const p = feat.properties || {};
    if (!sourceDef.filter(p)) continue;
    const wb = String(sourceDef.wb(p) || 'Unknown').trim();
    const rec = buildRecord(feat, p);
    if (!rec) continue;
    if (!waterbodies[wb]) waterbodies[wb] = [];
    waterbodies[wb].push(rec);
  }
  const result = { waterbodies };
  try {
    await env.R2_TROLLMAP_CHARTPACKS.put(cacheKey, JSON.stringify(result), { httpMetadata: { contentType: 'application/json' }, customMetadata: { fetchedAt: new Date().toISOString() } });
  } catch (_) {}
  return result;
}

function waterbodyMatchesLake(lakeName, waterbodyName) {
  const a = normalizeResearchName(lakeName).replace(/^lake /, '');
  const b = normalizeResearchName(waterbodyName).replace(/^lake /, '');
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}


function stripHtmlPreserveTables(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractHtmlTableRows(html) {
  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(String(html || '')))) {
    const rowHtml = rowMatch[1];
    const cellRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowHtml))) {
      const txt = stripHtmlPreserveTables(cellMatch[1]).replace(/\s+/g, ' ').trim();
      if (txt) cells.push(txt);
    }
    if (cells.length >= 2) rows.push(cells);
  }
  return rows;
}

// Parse markdown pipe-delimited tables (from Firecrawl/normalized text)
// Firecrawl and basic HTML strippers often flatten multi-row tables into ONE long line
// with empty cells between rows:  | a | b | c | d | | e | f | g | h |
// The previous regex walked that line greedily and misaligned columns, so eRegulations
// tables produced garbage rows and zero usable length/creel limits.
function extractMarkdownTableRows(text) {
  const rows = [];
  const str = String(text || '');
  if (!str.includes('|')) return rows;

  // 1) Primary path: insert newlines at empty-cell row separators, then parse lines
  const normalized = str
    .replace(/\|\s*\|/g, '|\n|')          // empty cell between rows → newline
    .replace(/\r\n/g, '\n');

  for (const line of normalized.split('\n')) {
    if (!line.includes('|')) continue;
    // Keep empty trailing cells so 4-col alignment survives; only trim each cell
    let cells = line.split('|').map(c => c.replace(/\s+/g, ' ').trim());
    // Drop leading/trailing empties created by edge pipes
    if (cells.length && cells[0] === '') cells = cells.slice(1);
    if (cells.length && cells[cells.length - 1] === '') cells = cells.slice(0, -1);
    if (!cells.length) continue;
    // Separator / spacer rows
    if (cells.every(c => !c || /^[-:\s]+$/.test(c))) continue;
    // Header-ish single-label rows (section titles spanning the table)
    if (cells.length === 1) continue;
    // Prefer 4-column regulation rows; pad shorter rows, truncate longer
    if (cells.length >= 4) {
      rows.push(cells.slice(0, 4));
    } else if (cells.length === 3) {
      rows.push([...cells, '']);
    } else if (cells.length === 2 && cells[0] && cells[1]) {
      rows.push([cells[0], cells[1], '', '']);
    }
  }

  // 2) Fallback: non-overlapping 4-cell regex if still empty (defensive)
  if (rows.length === 0) {
    const rowRe = /\|([^|\n]{1,500})\|([^|\n]{1,500})\|([^|\n]{1,500})\|([^|\n]{1,500})\|/g;
    let m;
    let pos = 0;
    while ((m = rowRe.exec(str)) !== null) {
      // Advance past this match without re-consuming the trailing |
      if (m.index < pos) continue;
      const cells = [m[1].trim(), m[2].trim(), m[3].trim(), m[4].trim()];
      pos = m.index + m[0].length - 1;
      if (!cells[0] && !cells[1]) continue;
      if (cells.every(c => !c || /^[-:\s]+$/.test(c))) continue;
      rows.push(cells);
      rowRe.lastIndex = pos;
    }
  }
  return rows;
}

// Slice PDF.js extracted text to a page range using --- PAGE n --- markers.
// Used to extract only the relevant section from large combined PDF guides.
function slicePdfPageRange(text, startPage, endPage) {
  if (!text) return text;
  const lines = text.split('\n');
  const result = [];
  let inRange = false;
  for (const line of lines) {
    const pageMatch = line.match(/^---\s*PAGE\s*(\d+)\s*---$/i);
    if (pageMatch) {
      const pageNum = parseInt(pageMatch[1], 10);
      inRange = pageNum >= startPage && pageNum <= endPage;
    }
    if (inRange) result.push(line);
  }
  // If no PAGE markers found (e.g. TinyFish returned plain text), return full text
  return result.length > 0 ? result.join('\n') : text;
}

async function parseSCRegulationsFromHtml(lakeName, regsUrl, html, lakeSpecificHtml = '', env) {
  const systemPrompt = "You are an expert South Carolina freshwater fisheries regulation parser.\n" +
"Your task is to extract size and creel (possession) limits from South Carolina's official freshwater fishing regulations (SCDNR regulations booklet, pages 18-43).\n\n" +
"Extract both:\n" +
"1. Statewide (general) regulations.\n" +
"2. Lake-specific regulations / exceptions for the specified lake body.\n\n" +
"JSON Schema to return:\n" +
"{\n" +
"  \"lastUpdated\": <string|null>,\n" +
"  \"generalStateRegulations\": {\n" +
"    \"lengthLimits\": {\n" +
"       // mapping of species to exact size limit strings, e.g. \"No limit\" or \"14 inch minimum\"\n" +
"    },\n" +
"    \"creelLimits\": {\n" +
"       // mapping of species to creel limit strings, e.g. \"15 per day\" or \"5 per day\"\n" +
"    }\n" +
"  },\n" +
"  \"lakeSpecificRegulations\": {\n" +
"    \"hasExceptions\": <boolean|null>,\n" +
"    \"sizeLimits\": {\n" +
"       // species exceptions for this specific lake\n" +
"    },\n" +
"    \"creelLimits\": {\n" +
"       // creel exceptions for this specific lake\n" +
"    },\n" +
"    \"specialRules\": [\n" +
"       // array of special regulation rules or notes for this lake\n" +
"    ],\n" +
"    \"closedSeasons\": [\n" +
"       // array of objects like { \"species\": <string>, \"period\": <string>, \"note\": <string> }\n" +
"    ]\n" +
"  },\n" +
"  \"evidence\": {\n" +
"     // For any extracted regulation, map the field path (e.g. \"general.Crappie\" or \"lakeSpecific.Largemouth Bass\") to the exact matching text row/sentence quote as a string\n" +
"  }\n" +
"}\n\n" +
"Species names should be canonicalized to match:\n" +
"\"Crappie\", \"Bream\", \"Redbreast Sunfish\", \"Chain Pickerel\", \"Redfin Pickerel\", \"Yellow Perch\", \"Blue Catfish\", \"American Eel\", \"Walleye / Sauger\", \"White Bass\", \"Smallmouth Bass\", \"Redeye Bass\", \"Spotted Bass\", \"Largemouth Bass\", \"Striped Bass / Hybrid\"\n\n" +
"Special Rules:\n" +
"- If the lake is listed as a Striper/Hybrid exception, capture it under lakeSpecificRegulations. If it's NOT explicitly listed, note that the statewide regulation applies.\n" +
"- Do NOT map Santee River system, Wateree Dam, or Cooper River rules as lake exceptions unless they explicitly refer to the reservoir body itself.\n" +
"- Respond ONLY with valid, raw JSON. Do not include markdown formatting or backticks.";

  const cleanHtml = stripHtmlPreserveTables(html).replace(/\s+/g, ' ').trim();
  const cleanLakeHtml = stripHtmlPreserveTables(lakeSpecificHtml).replace(/\s+/g, ' ').trim();

  const userPrompt = `Lake Name: 	ext${lakeName}\nUrl: ${regsUrl}\nStatewide Text:\n${cleanHtml.slice(0, 15000)}\n\nLake-Specific Text:\n${cleanLakeHtml.slice(0, 8000)}`;

  const regs = {
    state: 'SC',
    lastUpdated: null,
    generalStateRegulations: { lengthLimits: {}, creelLimits: {} },
    lakeSpecificRegulations: { hasExceptions: null, creelLimits: {}, sizeLimits: {}, specialRules: [], closedSeasons: [] },
    notes: 'Always verify exact lake exceptions at official agency site before fishing.'
  };
  const evidence = { regulations: {} };

  try {
    const llmResult = await callLLM(env, {
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      max_tokens: 2000,
      temperature: 0.1,
      response_format: { type: 'json_object' }
    });
    const llmText = extractLLMText(llmResult.data).replace(/`{3}(json)?/g, '').trim();
    const parsed = JSON.parse(llmText);

    if (parsed) {
      if (parsed.lastUpdated) regs.lastUpdated = parsed.lastUpdated;
      if (parsed.generalStateRegulations) {
        regs.generalStateRegulations.lengthLimits = parsed.generalStateRegulations.lengthLimits || {};
        regs.generalStateRegulations.creelLimits = parsed.generalStateRegulations.creelLimits || {};
      }
      if (parsed.lakeSpecificRegulations) {
        regs.lakeSpecificRegulations.hasExceptions = parsed.lakeSpecificRegulations.hasExceptions ?? null;
        regs.lakeSpecificRegulations.sizeLimits = parsed.lakeSpecificRegulations.sizeLimits || {};
        regs.lakeSpecificRegulations.creelLimits = parsed.lakeSpecificRegulations.creelLimits || {};
        regs.lakeSpecificRegulations.specialRules = parsed.lakeSpecificRegulations.specialRules || [];
        regs.lakeSpecificRegulations.closedSeasons = parsed.lakeSpecificRegulations.closedSeasons || [];
      }
      if (parsed.evidence) {
        for (const [key, quote] of Object.entries(parsed.evidence)) {
          evidence.regulations[key] = [buildEvidence('official_document', 'SCDNR / eRegulations', regsUrl, quote, 'llm_extraction')];
        }
      }
    }
  } catch (err) {
    console.error(`LLM eRegulations Fact extraction failed: ${err.message}`);
  }

  // Flatten convenience fields for UI/back-compat
  regs.lengthLimits = { ...regs.generalStateRegulations.lengthLimits, ...regs.lakeSpecificRegulations.sizeLimits };
  regs.creelLimits = { ...regs.generalStateRegulations.creelLimits, ...regs.lakeSpecificRegulations.creelLimits };

  return { regulations: regs, evidence, sources: [{ label: 'SCDNR / eRegulations', url: regsUrl, trust: 'OFFICIAL', sourceType: 'official_document' }] };
}

async function getRampSpeciesFacts(env, lakeName, state) {
  const sourceDef = RESEARCH_RAMP_SOURCES[state];
  if (!sourceDef) return null;
  const data = await fetchArcGISGrouped(env, `ramps/${String(state).toLowerCase()}/ramps.json`, sourceDef, (feat, p) => {
    const lat = parseFloat(sourceDef.lat(p));
    const lon = parseFloat(sourceDef.lon(p));
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return { name: String(sourceDef.name(p) || 'Unknown').trim(), lat, lon, ...sourceDef.meta(p) };
  });
  const matches = Object.entries(data.waterbodies || {}).filter(([wb]) => waterbodyMatchesLake(lakeName, wb));
  if (!matches.length) return null;
  const ramps = matches.flatMap(([, arr]) => arr || []);
  const predatorSpecies = uniqueResearchSpecies(ramps.flatMap(r => splitSpeciesText(r.species || '')));
  return { ramps, predatorSpecies, sourceLabel: sourceDef.label };
}

async function getAttractorFacts(env, lakeName, state) {
  const sourceDef = RESEARCH_ATTRACTOR_SOURCES[state];
  if (!sourceDef) return null;
  const data = await fetchArcGISGrouped(env, `attractors/${String(state).toLowerCase()}/attractors.json`, sourceDef, (feat, p) => {
    const lat = parseFloat(sourceDef.lat(p) || feat.geometry?.coordinates?.[1]);
    const lon = parseFloat(sourceDef.lon(p) || feat.geometry?.coordinates?.[0]);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return { name: String(sourceDef.name(p) || 'Attractor').trim(), lat, lon, type: String(sourceDef.type(p) || 'Unknown').trim() };
  });
  const matches = Object.entries(data.waterbodies || {}).filter(([wb]) => waterbodyMatchesLake(lakeName, wb));
  if (!matches.length) return null;
  const attractors = matches.flatMap(([, arr]) => arr || []);
  const typeCounts = {};
  for (const a of attractors) {
    const t = a.type || 'Unknown';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  return { attractors, typeCounts, sourceLabel: sourceDef.label };
}

function buildFactualSummary(profile) {
  const parts = [];
  const id = profile.identity || {};
  const bio = profile.biology || {};
  const lim = profile.limnology || {};
  const hab = profile.habitat || {};
  if (id.archetype || id.surfaceAreaAcres || id.maxDepthFt) {
    parts.push(`${profile.lakeName} ${id.archetype ? `is a ${String(id.archetype).toLowerCase()}` : 'is a reservoir/lake'}${id.surfaceAreaAcres ? ` with about ${Number(id.surfaceAreaAcres).toLocaleString()} surface acres` : ''}${id.maxDepthFt ? ` and a maximum depth near ${id.maxDepthFt} feet` : ''}.`);
  }
  if (Array.isArray(bio.predatorSpecies) && bio.predatorSpecies.length) {
    parts.push(`Confirmed sport fish documented for this waterbody include ${bio.predatorSpecies.join(', ')}${Array.isArray(bio.knownStockings) && bio.knownStockings.length ? `; documented stocking notes include ${bio.knownStockings.map(s => s.species).join(', ')}` : ''}.`);
  }
  if (hasResearchValue(lim.surfaceWater) || lim.waterClarity?.secchiFt || lim.thermocline?.summerDepthFt) {
    const limBits = [];
    if (lim.waterClarity?.secchiFt) limBits.push(`Secchi clarity around ${lim.waterClarity.secchiFt} ft when observed`);
    if (lim.surfaceWater?.recentTempF != null) limBits.push(`recent surface water about ${lim.surfaceWater.recentTempF}°F`);
    if (lim.surfaceWater?.recentDissolvedOxygenMgL != null) limBits.push(`recent surface dissolved oxygen about ${lim.surfaceWater.recentDissolvedOxygenMgL} mg/L`);
    if (lim.thermocline?.summerDepthFt) limBits.push(`summer thermocline near ${Array.isArray(lim.thermocline.summerDepthFt) ? lim.thermocline.summerDepthFt.join('-') : lim.thermocline.summerDepthFt} ft`);
    if (limBits.length) parts.push(`Available limnology data indicate ${limBits.join('; ')}.`);
  }
  const attrCount = hab.artificialHabitatDetails?.attractorCount;
  if (attrCount || hab.cover?.length || hab.notes) {
    const habBits = [];
    if (attrCount) habBits.push(`${attrCount} mapped fish attractors`);
    if (hab.cover?.length) habBits.push(`cover includes ${hab.cover.slice(0, 4).join(', ')}`);
    if (habBits.length) parts.push(`Habitat facts currently confirm ${habBits.join('; ')}.`);
  }
  return parts.join(' ').trim() || null;
}

export { normalizeResearchName, hasResearchValue, buildEvidence, titleCaseWords, RESEARCH_SPECIES_CANON, canonicalizeResearchSpecies, NON_GAME_SPECIES, uniqueResearchSpecies, splitSpeciesText, parseSCDNRDescriptionFacts, RESEARCH_RAMP_SOURCES, RESEARCH_ATTRACTOR_SOURCES, fetchArcGISGrouped, waterbodyMatchesLake, stripHtmlPreserveTables, extractHtmlTableRows, extractMarkdownTableRows, slicePdfPageRange, parseSCRegulationsFromHtml, getRampSpeciesFacts, getAttractorFacts, buildFactualSummary };
