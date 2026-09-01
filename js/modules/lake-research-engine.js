// lake-research-engine.js — Pipeline logic, geo helpers, fact building
// No DOM access in this file.

/**
 * Evidence Acquisition Module Design & Execution Engine (Step-by-Step Pipeline)
 * Implements spec:
 * Step 1: Lake Identification (generate canonical_lake.json)
 * Step 2: Source Discovery (automated crawlers/scrapers, generate source_catalog.json)
 * Step 3: Download Sources (CORS proxy fetch PDF/HTML, stream bytes to client, parse client-side with pdf.js, then save to normalized/ in R2, discard binary)
 * Step 4: Text Extraction (Client-side extraction of Title, Headings, Paragraphs, page numbers, tables)
 * Step 5: Source Quality Scoring (Compute scoring from authority, freshness, completeness)
 * Step 6: Document Classification (Classify documents: Hydrology, Biology, Regulations, etc.)
 * Step 7: Information Extraction (Run LLM large-context model for precise structured facts with page, confidence, quote)
 * Step 8: Evidence Deduplication (Merge identical facts, track newest/oldest source)
 * Step 9: Contradiction Detection (Flag conflicting evidence, visual review panel)
 * Step 10: Research Packet Generation (master R2 output research_packet.json)
 *
 * This integrates into/extends the existing `lake-research.js` UI seamlessly.
 */

import { state, CF_WORKER_URL } from '../core/state.js';
// LAKE_DB import removed 2026-08-02: it was imported and never referenced.
import { resolveR2Key } from './contour-data.js';
import { resolveSupplementalKey, resolveBoundaryKey } from './supplemental-layers.js';
import { geoDistanceFt } from '../utils/geo.js';
import { coerceStockingsArray, coerceSpeciesArray, coerceNum, hasResearchValue,
         numberFromText, IDENTITY_MEASURES, pruneRetiredFields } from '../utils/coerce.js';
import { isCoastalKey, COASTAL_ZONES } from '../data/coastal-zones.js';
import { workerHeaders } from '../utils/worker-auth.js';

import { boundsOf, paddedBox } from '../utils/geojson-coords.js';
import { lakeRecordFor } from '../data/lake-registry.js';
import { prepareNormalizedDocuments } from '../utils/doc-relevance.js';

// Setup global caches and references
window.TROLLMAP_RESEARCHED_CACHE = window.TROLLMAP_RESEARCHED_CACHE || {};

// WHICH AGENTS RUN. One list, and until now it was also the list of sections the research card
// draws -- so retiring an agent would silently blank a card, and a section the pipeline fills
// WITHOUT an agent could not be shown at all.
//
// Those are two different questions and the refactor needs them apart:
// RESEARCH_REFACTOR_END_STATE_2026-08-27.md retires ten of eleven agents while several of their
// sections keep being filled deterministically. `regulations` is the first of them --
// deterministic.js and the live digest fill regulations.*, and checkRegulations() has read the
// digest's closures since the hand table was deleted on 2026-08-27, so an LLM writing that
// section is a third source of a fact we already parse out of the book.
// `identity` RETIRED 2026-08-31 -- see deterministic.js. Nine target fields, and
// plan-inputs.js read three of them: archetype/bodyType, maxDepthFt, averageDepthFt. The
// last two are geometry-derived off the chartpack; the first is the registry's
// `feature_type`. The other six have no reader anywhere outside this pipeline.
const FRESHWATER_RESEARCH_ORDER = ['limnology', 'biology', 'habitat', 'navigation', 'fisheries', 'summary'];
const COASTAL_RESEARCH_ORDER = ['biology', 'habitat', 'navigation', 'fisheries', 'summary'];

// WHAT THE RESEARCH CARD DRAWS. A superset of the agent list, and it stays a superset: a section
// with no agent is filled by the deterministic pass or the live digest, and Ryan still has to be
// able to look at it. Retiring an agent removes it from the run list above and nothing else.
const FRESHWATER_PROFILE_SECTIONS = ['identity', 'limnology', 'biology', 'habitat', 'navigation', 'regulations', 'fisheries', 'summary'];
const COASTAL_PROFILE_SECTIONS = ['estuary', 'tidal', 'biology', 'habitat', 'navigation', 'saltwater_regulations', 'fisheries', 'summary'];

// Default export kept for backwards compatibility — callers should use getResearchOrderForLake()
const RESEARCH_ORDER = FRESHWATER_RESEARCH_ORDER;

const RESEARCH_LABELS = {
  limnology: '🌊 Limnology',
  biology: '🐟 Fisheries',
  habitat: '🌿 Habitat',
  navigation: '🧭 Navigation',
  regulations: '📜 Regulations',
  fisheries: '🧠 Species Intelligence',
  summary: '📝 AI Summary',
  saltwater_regulations: '📜 Saltwater Regs',
};

// Agent definitions with target fields for validation
const AGENT_DEFINITIONS = {
  limnology: {
    label: '🌊 Limnology',
    targetFields: ['limnology.waterClarity.typical', 'limnology.waterClarity.color', 'limnology.waterClarity.secchiFt', 'limnology.thermocline.summerDepthFt', 'limnology.thermocline.strength', 'limnology.oxygen.depletionDepthFt', 'limnology.oxygen.anoxicBelowFt', 'limnology.trophicStatus', 'limnology.flowCharacteristics', 'limnology.seasonalDrawdownFt'],
  },
  biology: {
    label: '🐟 Fisheries Biology',
    targetFields: ['biology.primaryForage', 'biology.secondaryForage', 'biology.predatorSpecies', 'biology.speciesAbundance', 'biology.knownStockings', 'biology.baitfishMovement', 'biology.invasiveSpecies', 'biology.spawnTiming', 'biology.forageSpatial'],
  },
  habitat: {
    label: '🌿 Habitat',
    targetFields: ['habitat.bottomComposition', 'habitat.cover', 'habitat.vegetation', 'habitat.standingTimber', 'habitat.dockDensity', 'habitat.riprapLocations', 'habitat.namedCreekMouths', 'habitat.timberFields', 'habitat.shallowFlatAreas', 'habitat.artificialHabitat', 'habitat.artificialHabitatDetails.attractorCount', 'habitat.artificialHabitatDetails.attractorTypes'],
  },
  navigation: {
    label: '🧭 Navigation',
    // `ramps` and `notes` dropped 2026-08-31. deterministic.js has filled `navigation.ramps` from
    // the registry's geometry-bound feeds since it was written -- 9 on Wateree -- and the agent
    // was being asked for a list the pipeline already had. `navigation.notes` has NO reader: the
    // only two matches in js/ or Worker/ are comments naming these very targetFields, and what it
    // holds on Wateree is "Public access is available at Lake Wateree State Recreational Area",
    // which is the ramps list again in prose.
    //
    // `hazards` stays, and it is the only one of the three with a live consumer: researchHazards()
    // in plan-inputs.js feeds both the Lake Intelligence Briefing and the plan prompt's safety
    // section, alongside chartedHazards() off the pack's POI layer.
    //
    // WHETHER IT EARNS ITS PLACE IS A JUDGEMENT AND IT IS RYAN'S. Counted over the 63 profiles:
    // 42 carry hazards, 88 sentences in all, and reading them -- 9 are generic TVA boilerplate
    // ("fluctuating water levels common in TVA reservoirs"), 9 name a marina or a neighbouring
    // lake rather than a hazard, several are regulations filed in the wrong section, and a
    // minority are real and local. Wateree's two are one of each: an S-20-101 bridge replacement
    // with a project id, and "severe thunderstorms historical activity", which the live wind and
    // weather path already answers better.
    targetFields: ['navigation.hazards'],
  },
  fisheries: {
    label: '🧠 Species Intelligence',
    targetFields: ['trollingIntelligence'],
  },
  summary: {
    label: '📝 AI Summary',
    targetFields: ['summary'],
  },
  // ── COASTAL AGENTS RETIRED 2026-08-31 ─────────────────────────────────────
  //
  // `estuary` and `tidal` wrote fifteen fields between them and NOT ONE has a reader outside this
  // pipeline. Checked by reading the lines rather than matching names, which is what made the
  // earlier verdicts wrong: `conditions.js` reads `b.pool.datum` and not `tidal.datum`;
  // `tide-engine.js` classifies a tide stage and never touches `tidal.tidalCurrentKts`;
  // `conditions-strip.js` prints a live USGS 00480 salinity, not `tidal.salinityPpt`. The live
  // tide and gauge path answers everything the coastal cards show.
  //
  // They also carried `identity.surfaceAreaAcres` and `identity.maxDepthFt` among their targets,
  // which the chartpack has been deriving all along.
};

// ── Coastal detection helpers (frontend) ──────────────────────────────────
function getCoastalR2Key(lakeName) {
  // There was never a second resolver here. `contour-data.js` re-exports lake-keys.js's
  // `resolveR2Key` verbatim, so the "prefer the canonical resolver, fall back to the
  // contour-data one" ladder called the SAME function twice and could not have disagreed with
  // itself -- wrapped, for good measure, in a try/catch whose handler called it a third time.
  // resolveR2Key does string work and map lookups and returns null rather than throwing, so
  // there is nothing here to guard against.
  const key = resolveR2Key(lakeName);
  if (key && isCoastalKey(key)) return key;
  // A caller may hand us the slug itself rather than a display name.
  const low = String(lakeName || '').toLowerCase();
  return low.startsWith('coast_') ? low : null;
}

function isCoastalLake(lakeName) {
  const key = getCoastalR2Key(lakeName);
  return !!key;
}

function getResearchOrderForLake(lakeName) {
  return isCoastalLake(lakeName) ? COASTAL_RESEARCH_ORDER : FRESHWATER_RESEARCH_ORDER;
}

function getCoastalZoneMeta(lakeName) {
  const key = getCoastalR2Key(lakeName);
  if (!key) return null;
  return COASTAL_ZONES[key] || null;
}

const _state = {
  currentProfile: null,
  currentLakeName: '',
  currentPackageFiles: [],
  currentVersions: [],
  researchInProgress: false,
  researchLog: [],
  packagePartsCache: {},
  failedUrlsThisRun: new Set() // cleared at start of each run; prevents re-fetching dead URLs across agents
};

// Helper logging
function log(msg) {
  const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
  _state.researchLog.push(entry);
  renderLog();
  console.log(`[evidence-pipeline] ${msg}`);
}

// Re-render the full log from _state.researchLog — call this after any operation
// that might have replaced the DOM element (loadProfile, renderSections, etc.)
function renderLog() {
  const el = document.getElementById('researchLog');
  if (!el) return;
  el.textContent = _state.researchLog.join('\n');
  el.scrollTop = el.scrollHeight;
}

function setProgress(label, pct) {
  const labelEl = document.getElementById('researchProgressLabel');
  const pctEl = document.getElementById('researchProgressPct');
  const fillEl = document.getElementById('researchProgressFill');
  if (labelEl) labelEl.textContent = label;
  if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
  if (fillEl) fillEl.style.width = `${pct}%`;
}

function showProgress(show) {
  const el = document.getElementById('researchProgress');
  if (el) el.style.display = show ? 'block' : 'none';
  // Log element is now a sibling of researchProgress — show it when run starts,
  // keep it visible after run completes (don't hide with progress bar)
  if (show) {
    const logEl = document.getElementById('researchLog');
    if (logEl) logEl.style.display = 'block';
  }
}

function sanitizeStateFromLakeName(lakeName) {
  const s = (lakeName || '').toUpperCase();
  // Prefer primary state from suffix: "Lake X, NC", "Lake X, SC/GA", "Lake X, NC/VA"
  // Order matters: check explicit ", XX" / "/XX" tokens so border lakes resolve correctly.
  if (/,\s*NC(\/|$|\s)|\/NC\b/.test(s) || s.includes('NORTH CAROLINA')) return 'NC';
  if (/,\s*GA(\/|$|\s)|\/GA\b/.test(s) || s.includes('GEORGIA')) return 'GA';
  if (/,\s*TN(\/|$|\s)|\/TN\b/.test(s) || s.includes('TENNESSEE')) return 'TN';
  if (/,\s*VA(\/|$|\s)|\/VA\b/.test(s) || s.includes('VIRGINIA')) return 'NC'; // Kerr/Gaston treated with NC pipeline
  if (/,\s*SC(\/|$|\s)|\/SC\b/.test(s) || s.includes('SOUTH CAROLINA')) return 'SC';
  // Loose fallbacks
  if (/\bNC\b/.test(s)) return 'NC';
  if (/\bGA\b/.test(s)) return 'GA';
  if (/\bTN\b/.test(s)) return 'TN';
  return 'SC';
}

function sanitize(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'unknown';
}

function cleanLakeBaseName(lakeName) {
  let base = String(lakeName || '').trim();
  base = base.replace(/^Lake\s+/i, '');
  base = base.replace(/,\s*(SC|NC|GA|TN)(?:\/(?:SC|NC|GA|TN))*\s*$/i, '').trim();
  base = base.replace(/\s+Reservoir$/i, '').trim();
  base = base.replace(/\s+Lake$/i, '').trim();
  return base || lakeName;
}




// WQP LIMNOLOGY NEEDS A BOUNDING BOX, AND THE REGISTRY HAS ALREADY LOADED ONE.
//
// This asked R2 for `<key>/garmin_shoreline.geojson` and read its bounds. On 2026-08-23 North
// Saluda Reservoir logged "could not derive bbox — skipping"; the pack has no shoreline file.
// Counted rather than guessed: 157 of the 373 shipped packs have no garmin_shoreline.geojson,
// so 42% of the lakes were silently skipping WQP entirely.
//
// That is the second time this exact failure has happened here. The comment this replaces
// records the first: `shoreline.geojson` was the old i-Boating supplemental, was never in the
// uploader's LAYERS, 404'd, and "a 404 here reads exactly like 'this lake has no boundary',
// which silently drops the bbox and takes WQP limnology down with it." Switching to the Garmin
// file fixed the lakes that have one and left the same trapdoor open for the ones that do not.
//
// So stop fetching a file to learn something already in hand. lake_index.json carries
// `bounds_wsen` on every row, it is fetched `cache: 'no-store'` on every load, and all 373
// rows have one whose own centroid falls inside it. No request, no 404, no lake left out.
//
// The fetch chain stays underneath for a label with no registry row — a river, or a water the
// picker knows and the index does not.
const WQP_BBOX_PAD = 0.01;   // ~0.7 mi, so a station just off the shoreline still counts

async function wqpBboxFor(lakeName) {
  const wire = (b) => b && ({ bboxWest: b.west, bboxSouth: b.south, bboxEast: b.east, bboxNorth: b.north });

  // The loader camelCases the row: `bounds_wsen` in lake_index.json is `boundsWSEN` here.
  const fromRegistry = paddedBox(lakeRecordFor(lakeName)?.boundsWSEN, WQP_BBOX_PAD);
  if (fromRegistry) return { bbox: wire(fromRegistry), from: 'registry' };

  const boundaryKey = resolveBoundaryKey(lakeName);
  const urls = [];
  if (boundaryKey) urls.push([`${CF_WORKER_URL}/chartpacks/${boundaryKey}/garmin_shoreline.geojson`, 'garmin_shoreline.geojson']);
  urls.push([`${CF_WORKER_URL}/chartpacks/lake-boundary?lake=${encodeURIComponent(lakeName)}`, 'boundary.geojson']);
  for (const [url, label] of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const b = boundsOf(await res.json());
      const padded = b && paddedBox([b.west, b.south, b.east, b.north], WQP_BBOX_PAD);
      if (padded) return { bbox: wire(padded), from: label };
    } catch (_) { /* try the next one; the caller reports having found nothing */ }
  }
  return { bbox: null, from: null };
}

// One WQP call, used by the full pipeline and by a resume run. These were two byte-identical
// fifty-line blocks; a fix to one of them was a fix to half the lakes.
async function fetchWqpLimnology(lakeName) {
  try {
    const { bbox, from } = await wqpBboxFor(lakeName);
    if (!bbox) { log('⚠️ WQP: no bounding box for this water — skipping'); return; }
    if (from !== 'registry') log(`  WQP bbox from ${from} (no registry row for this water)`);
    const wqpRes = await fetch(`${CF_WORKER_URL}/research/limnology-data`, {
      method: 'POST', headers: workerHeaders(),
      body: JSON.stringify({ lakeName, ...bbox })
    });
    if (!wqpRes.ok) { log(`⚠️ WQP: HTTP ${wqpRes.status}`); return; }
    const wqpData = await wqpRes.json();
    if (!(wqpData.ok && wqpData.recordCount > 0)) { log(`⚠️ WQP: ${wqpData.note || 'no data found'}`); return; }
    _state.wqpLimnology = wqpData;
    const tc = wqpData.thermocline ? `${wqpData.thermocline.depthFt}ft (${wqpData.thermocline.method})` : 'not derived';
    const surfWhen = wqpData.surfaceWater?.recentTempLastObserved || wqpData.surfaceWater?.lastObserved || null;
    const surf = wqpData.surfaceWater?.recentTempF != null
      ? `surface ${wqpData.surfaceWater.recentTempF}°F${surfWhen ? ` sampled ${surfWhen}` : ' (sample date not recorded)'} / DO ${wqpData.surfaceWater.recentDissolvedOxygenMgL ?? '?'} mg/L`
      : '';
    const sec = wqpData.secchi ? `secchi avg ${wqpData.secchi.avgSecchiDepthFt}ft (n=${wqpData.secchi.sampleCount})` : '';
    log(`✔ WQP: ${wqpData.recordCount} records — thermocline ${tc}${surf ? '; ' + surf : ''}${sec ? '; ' + sec : ''}`);
  } catch (e) { log(`⚠️ WQP fetch failed: ${e.message}`); }
}

function cloneJson(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function mergeMissing(target, source) {
  if (source == null) return cloneJson(target);
  if (target == null) return cloneJson(source);
  if (Array.isArray(target)) return target.length ? cloneJson(target) : cloneJson(source);
  if (Array.isArray(source)) return hasResearchValue(target) ? cloneJson(target) : cloneJson(source);
  if (typeof target !== 'object' || typeof source !== 'object') return hasResearchValue(target) ? target : cloneJson(source);
  const out = { ...cloneJson(target) };
  for (const [k, sv] of Object.entries(source)) {
    if (!(k in out)) out[k] = cloneJson(sv);
    else out[k] = mergeMissing(out[k], sv);
  }
  return out;
}

/**
 * AN EVIDENCE MAP MERGED INTO ITSELF MUST NOT GROW.
 *
 * This concatenated blindly, which was harmless while every input was built fresh each run. The
 * moment the SAVED map is seeded -- and it now is, so a targeted rerun stops discarding the
 * evidence of agents it did not run -- a blind concat would append another copy of the same
 * bathymetry entry on every pass, forever.
 *
 * An entry is identified by where it came from and how: source type, label, url, method and
 * quote. A later entry with the same identity REPLACES the earlier one in place -- it is the same
 * claim measured again, and the newer measurement is the one to keep, which also lets a coverage
 * or band count that shifted between runs update rather than accumulate. Position is the first
 * sighting, so the order a reader sees does not shuffle from one run to the next.
 *
 * Only fields present in `b` are rebuilt. A field only `a` holds was deduplicated by whatever
 * merge produced `a`.
 */
/**
 * FACTS AND EVIDENCE ARE PROPERTIES OF THE LAKE'S DOCUMENT CACHE, NOT OF THE AGENTS THAT RAN.
 *
 * Read the note above `allFacts` in assembleAndSaveProfile before changing either merge. On
 * 2026-08-21 both were "fixed" to seed from the saved profile, on the reading that a targeted
 * rerun discards the work of the agents it did not run. It does not, and the seeding was reverted.
 */
function mergeEvidenceMaps(a = {}, b = {}) {
  const out = cloneJson(a) || {};
  for (const [section, fields] of Object.entries(b || {})) {
    out[section] = out[section] || {};
    for (const [field, entries] of Object.entries(fields || {})) {
      out[section][field] = (out[section][field] || []).concat(cloneJson(entries) || []);
    }
  }
  return out;
}

/**
 * A GRAB SAMPLE IS DATED OR IT IS NOT A FACT ABOUT TODAY.
 *
 * The reasoning lives in full above `sampleDated` in Worker/research/facts-util.js. The short
 * version: `limnology.surfaceWater` holds WQP grab samples of whatever age WQP last recorded and
 * nothing refreshes them, while the live water temperature comes from a bound USGS 00010 gauge
 * through /conditions. Both reach the same Smart Plan prompt, so an undated archival number
 * called "recent" reads as today's water and contradicts the gauge.
 *
 * `ownDate` is the number's own sample date. `groupDate` is `surfaceWater.lastObserved`, the
 * newest of temperature, DO and turbidity, which is all that profiles written before per-
 * characteristic dates carry -- it belongs to the group, so it is said as the group's.
 *
 * Mirrored from Worker/research/facts-util.js, which the client cannot import. Change both.
 */
function sampleDated(ownDate, groupDate) {
  if (ownDate) return ` when last sampled ${ownDate}`;
  if (groupDate) return ` (grab sample; newest surface sample here ${groupDate})`;
  return ' (grab sample, date not recorded)';
}

function buildDeterministicSummary(profile) {
  const identity = profile?.identity || {};
  const biology = profile?.biology || {};
  const lim = profile?.limnology || {};
  const hab = profile?.habitat || {};
  const sentences = [];
  if (identity.archetype || identity.surfaceAreaAcres || identity.maxDepthFt) {
    let s = profile?.lakeName || _state.currentLakeName || 'This lake';
    if (identity.archetype) s += ` is a ${String(identity.archetype).toLowerCase()}`;
    if (identity.surfaceAreaAcres) s += `${identity.archetype ? '' : ' has'} about ${Number(identity.surfaceAreaAcres).toLocaleString()} surface acres`;
    if (identity.maxDepthFt) s += `${identity.surfaceAreaAcres ? ',' : ''} with a maximum depth near ${identity.maxDepthFt} feet`;
    sentences.push(`${s}.`);
  }
  if (Array.isArray(biology.predatorSpecies) && biology.predatorSpecies.length) {
    let s = `Confirmed sport fish include ${biology.predatorSpecies.join(', ')}`;
    if (Array.isArray(biology.knownStockings) && biology.knownStockings.length) s += `; documented stocking notes include ${biology.knownStockings.map(x => x.species).join(', ')}`;
    sentences.push(`${s}.`);
  }
  const limBits = [];
  if (lim.waterClarity?.secchiFt) limBits.push(`Secchi clarity around ${lim.waterClarity.secchiFt} ft`);
  const swDated = (own) => sampleDated(own, lim.surfaceWater?.lastObserved);
  if (lim.surfaceWater?.recentTempF != null) limBits.push(`surface water near ${lim.surfaceWater.recentTempF}°F${swDated(lim.surfaceWater.recentTempLastObserved)}`);
  if (lim.surfaceWater?.recentDissolvedOxygenMgL != null) limBits.push(`surface dissolved oxygen near ${lim.surfaceWater.recentDissolvedOxygenMgL} mg/L${swDated(lim.surfaceWater.recentDissolvedOxygenLastObserved)}`);
  if (Array.isArray(lim.thermocline?.summerDepthFt) ? lim.thermocline.summerDepthFt.length : lim.thermocline?.summerDepthFt != null) {
    const depthText = Array.isArray(lim.thermocline.summerDepthFt) ? lim.thermocline.summerDepthFt.join('-') : lim.thermocline.summerDepthFt;
    limBits.push(`summer thermocline near ${depthText} ft`);
  }
  if (limBits.length) sentences.push(`Available limnology data indicate ${limBits.join('; ')}.`);
  const attrCount = hab?.artificialHabitatDetails?.attractorCount;
  const structKeys = Object.keys(hab?.structuralElements || {}).filter(k => hasResearchValue(hab.structuralElements[k]));
  if (attrCount || hab.cover?.length || structKeys.length) {
    const bits = [];
    if (attrCount) bits.push(`${attrCount} mapped fish attractors`);
    if (hab.cover?.length) bits.push(`cover includes ${(Array.isArray(hab.cover) ? hab.cover : 
    String(hab.cover).split(/[,;]/).map(s => s.trim()).filter(Boolean)).slice(0, 4).join(', ')}`);
    if (structKeys.length) bits.push(`mapped structure includes ${structKeys.slice(0, 4).join(', ')}`);
    sentences.push(`Habitat facts currently confirm ${bits.join('; ')}.`);
  }
  return sentences.join(' ').trim() || null;
}

function buildEvidenceEntry(sourceType, sourceLabel, sourceUrl, quote, method, extra = {}) {
  return { sourceType, sourceLabel, sourceUrl, quote: quote || null, method, ...extra };
}

function applyWqpToLimnology(base = {}, wqp = null) {
  const out = cloneJson(base) || {};
  if (!wqp?.ok) return out;
  out.surfaceWater = out.surfaceWater || {};
  if (wqp.surfaceWater) {
    Object.assign(out.surfaceWater, wqp.surfaceWater);
  }
  out.waterClarity = out.waterClarity || {};
  if (wqp.surfaceWater?.recentTurbidityNTU != null && !out.waterClarity.note) {
    out.waterClarity.note = `Recent WQP/SCDES surface turbidity around ${wqp.surfaceWater.recentTurbidityNTU} NTU.`;
  }
  // WQP secchi always wins when it has 5+ samples — higher confidence than any single doc extraction
  if (wqp.secchi?.avgSecchiDepthFt != null && (wqp.secchi.sampleCount >= 5 || !hasResearchValue(out.waterClarity.secchiFt))) {
    out.waterClarity.secchiFt = wqp.secchi.avgSecchiDepthFt;
  }
  if (wqp.thermocline?.depthFt != null && !hasResearchValue(out.thermocline?.summerDepthFt)) {
    out.thermocline = out.thermocline || {};
    out.thermocline.summerDepthFt = wqp.thermocline.depthFt;
    out.thermocline.method = wqp.thermocline.method || null;
    out.thermocline.note = wqp.note || out.thermocline.note || null;
  }
  if (wqp.oxygen?.anoxicBelowFt != null && !hasResearchValue(out.oxygen?.anoxicBelowFt)) {
    out.oxygen = out.oxygen || {};
    out.oxygen.anoxicBelowFt = wqp.oxygen.anoxicBelowFt;
    out.oxygen.note = wqp.oxygen.note || out.oxygen.note || null;
  }
  // Derive trophic status from WQP secchi depth (Carlson TSI thresholds) when not already set
  if (!hasResearchValue(out.trophicStatus) && wqp.secchi?.avgSecchiDepthFt != null && wqp.secchi.sampleCount >= 5) {
    const s = wqp.secchi.avgSecchiDepthFt;
    if (s < 1.6)       out.trophicStatus = 'hypereutrophic';
    else if (s < 6.6)  out.trophicStatus = 'eutrophic';
    else if (s < 13.0) out.trophicStatus = 'mesotrophic';
    else               out.trophicStatus = 'oligotrophic';
  }
  return out;
}

function buildWqpEvidence(wqp) {
  if (!wqp?.ok) return {};
  const sourceUrl = 'worker:/research/limnology-data';
  const entry = buildEvidenceEntry('official_structured', 'Water Quality Portal / SCDES monitoring', sourceUrl, null, 'structured_surface_monitoring', { lastObserved: wqp.lastObserved, recordCount: wqp.recordCount });
  const evidence = { limnology: {} };
  if (wqp.surfaceWater) evidence.limnology.surfaceWater = [entry];
  if (wqp.thermocline?.depthFt != null) evidence.limnology.thermocline = [buildEvidenceEntry('official_structured', 'Water Quality Portal / SCDES monitoring', sourceUrl, null, wqp.thermocline.method || 'depth_profile_derivation', { lastObserved: wqp.lastObserved, evidenceCount: wqp.thermocline.evidenceCount })];
  if (wqp.oxygen?.anoxicBelowFt != null) evidence.limnology.oxygen = [entry];
  return evidence;
}

async function fetchGeoJsonMaybe(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function getBoundaryOuterRing(boundaryGeo) {
  const features = boundaryGeo?.features || [];
  // Select largest polygon by coordinate count (proxy for area) — same logic as supplemental-layers client
  let best = null, bestSize = 0;
  for (const f of features) {
    const g = f?.geometry;
    if (!g) continue;
    let ring = null;
    if (g.type === 'Polygon' && Array.isArray(g.coordinates?.[0])) ring = g.coordinates[0];
    else if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates?.[0]?.[0])) ring = g.coordinates[0][0];
    if (ring && ring.length > bestSize) { best = ring; bestSize = ring.length; }
  }
  return best;
}

function toFeetXY(lon, lat, refLat) {
  const x = lon * 364000 * Math.cos((refLat || lat) * Math.PI / 180);
  const y = lat * 364000;
  return [x, y];
}

function polygonAreaAcresLonLat(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return 0;
  const refLat = ring.reduce((a, p) => a + (p[1] || 0), 0) / ring.length;
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = toFeetXY(ring[i][0], ring[i][1], refLat);
    const [x2, y2] = toFeetXY(ring[i + 1][0], ring[i + 1][1], refLat);
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum / 2) / 43560;
}

function centroidLonLat(ring) {
  if (!Array.isArray(ring) || !ring.length) return [0, 0];
  let lon = 0, lat = 0;
  for (const p of ring) { lon += p[0]; lat += p[1]; }
  return [lon / ring.length, lat / ring.length];
}

function pointInPolygonLonLat(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// geoDistanceFt now from utils/geo.js (canonical)

function summarizePointComplexityFromBoundary(ring) {
  if (!Array.isArray(ring) || ring.length < 40) return {};
  const step = Math.max(1, Math.floor(ring.length / 120));
  const sampled = ring.filter((_, idx) => idx % step === 0);
  const [clon, clat] = centroidLonLat(sampled);
  const radii = sampled.map(([lon, lat]) => geoDistanceFt(clat, clon, lat, lon));
  if (radii.length < 10) return {};
  const smooth = radii.map((_, i) => {
    const prev = radii[(i - 1 + radii.length) % radii.length];
    const cur = radii[i];
    const next = radii[(i + 1) % radii.length];
    return (prev + cur + next) / 3;
  });
  const avg = smooth.reduce((a, b) => a + b, 0) / smooth.length;
  let maxima = 0, minima = 0;
  for (let i = 1; i < smooth.length - 1; i++) {
    if (smooth[i] > smooth[i - 1] && smooth[i] > smooth[i + 1] && smooth[i] > avg * 1.06) maxima++;
    if (smooth[i] < smooth[i - 1] && smooth[i] < smooth[i + 1] && smooth[i] < avg * 0.94) minima++;
  }
  const out = {};
  if (maxima >= 7) out.points = 'numerous shoreline points visible in boundary geometry';
  else if (maxima >= 4) out.points = 'several prominent shoreline points visible in boundary geometry';
  else if (maxima >= 2) out.points = 'a few major shoreline points visible in boundary geometry';
  if (minima >= 6) out.creekArms = 'multiple creek arms / embayments visible in boundary geometry';
  else if (minima >= 3) out.creekArms = 'several creek arms / embayments visible in boundary geometry';
  return out;
}

function isClosedContour(coords) {
  if (!Array.isArray(coords) || coords.length < 4) return false;
  const first = coords[0], last = coords[coords.length - 1];
  return geoDistanceFt(first[1], first[0], last[1], last[0]) < 150;
}

function flattenLineCoords(geom) {
  if (!geom) return [];
  if (geom.type === 'LineString') return [geom.coordinates || []];
  if (geom.type === 'MultiLineString') return geom.coordinates || [];
  return [];
}

/**
 * Minimum distance in degrees from a point to any segment of a ring.
 * Used to reject hump/ledge candidates that sit on or near the shoreline
 * (islands, shoreline points) rather than in open water.
 */
function minDistToRingDeg(lon, lat, ring) {
  let minD = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((lon - x1) * dx + (lat - y1) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const px = x1 + t * dx, py = y1 + t * dy;
    const d = Math.sqrt((lon - px) ** 2 + (lat - py) ** 2);
    if (d < minD) minD = d;
  }
  return minD;
}

// ~0.003° ≈ 300m — humps/ledges must be at least this far from the shoreline
const MIN_OFFSHORE_DEG = 0.003;

// Caps live in js/utils/structure-markers.js so they can be tested without a DOM.
// See that file for the byte counts that made a cap necessary.

function structuresFromPack(structGeo) {
  // READS structure.geojson. It used to be deriveContourStructures(), which grid-bucketed
  // contour centroids in the browser and kept eight humps and eight ledges per lake, per
  // research run. build_structure.py derives the same things offline from contour NESTING --
  // which is what actually makes a hump a hump -- and Wateree's file holds 395 humps and 6,915
  // ledges with relief, area and crown depth on every one.
  //
  // build_structure.py prints the comparison itself: "the old adapter would have kept 8 and 8
  // per lake, in the browser, per research run."
  const out = {};
  const feats = structGeo?.features;
  if (!feats?.length) return out;

  const humps = [], ledges = [];
  for (const f of feats) {
    const p = f.properties || {};
    // build_structure.py emits Points, so the coordinate IS the structure -- carry it.
    const c = f.geometry?.coordinates;
    const rec = Array.isArray(c) && c.length >= 2
      ? { ...p, lon: Number(c[0]), lat: Number(c[1]) }
      : { ...p };
    if (p.kind === 'hump') humps.push(rec);
    else if (p.kind === 'ledge') ledges.push(rec);
  }

  if (humps.length) {
    // Ranked by RELIEF, not by count. A hump is worth reporting because it stands proud of the
    // bottom around it; how many there are says nothing about which one matters.
    const top = humps.filter(h => Number.isFinite(Number(h.relief_ft)))
                     .sort((a, b) => Number(b.relief_ft) - Number(a.relief_ft))
                     .slice(0, 8);
    const desc = top.map(h => {
      const bits = [`${Math.round(Number(h.relief_ft))} ft relief`];
      if (Number.isFinite(Number(h.depth_ft))) bits.push(`crown ${Number(h.depth_ft).toFixed(1)} ft`);
      if (Number.isFinite(Number(h.area_acres))) bits.push(`${Number(h.area_acres).toFixed(1)} ac`);
      return bits.join(', ');
    });
    out.humps = `${humps.length} charted humps; largest by relief — ${desc.join('; ')}`;
  }

  if (ledges.length) {
    // LEDGES DO NOT DISCRIMINATE. Wateree has 6,915, so every stretch of water passes 90-140 of
    // them and a list of "the best ledges" is noise dressed as a finding. Report the shape of
    // the distribution and let the season and species decide which band matters.
    const ft = ledges.map(l => Number(l.depth_ft)).filter(Number.isFinite).sort((a, b) => a - b);
    const rel = ledges.map(l => Number(l.relief_ft)).filter(Number.isFinite).sort((a, b) => a - b);
    const q = (arr, f) => arr.length ? arr[Math.floor((arr.length - 1) * f)] : null;
    const parts = [`${ledges.length} charted ledges`];
    if (ft.length) parts.push(`depths ${ft[0].toFixed(1)}–${ft[ft.length - 1].toFixed(1)} ft, median ${q(ft, 0.5).toFixed(1)} ft`);
    if (rel.length) parts.push(`relief median ${q(rel, 0.5).toFixed(1)} ft, steepest ${rel[rel.length - 1].toFixed(1)} ft`);
    out.ledges = parts.join('; ');
  }

  // ---------------------------------------------------------------------
  // COUNTS AND PROSE. THE COORDINATES DO NOT LIVE HERE ANY MORE.
  //
  // They did between eba1ed1 (2026-08-07) and today, and it was the wrong home. A research
  // profile is a document: saved to R2, re-read on every load, pasted into every LLM prompt.
  // Thurmond ships 3,531 humps and 45,876 ledges, which came to 549 KB of an 810 KB profile
  // and most of a 402,757-character habitat prompt.
  //
  // Capping them was the obvious fix and the wrong one. Ryan, 2026-08-16: "how can i do all
  // casting stops instead of trolling lanes if i want to if you cap everything out
  // arbitrarily". Humps ARE the casting stops -- capping them caps the trip.
  //
  // structure.geojson has been in every pack since the Python pipeline started building it and
  // nothing in the client read it. It does now: supplemental-layers.js prefetches the layer and
  // smart-plan.js takes candidates from it, uncapped, through js/utils/structure-markers.js.
  // What the profile keeps is what a research document is for -- how many, and what that means.
  // Defined here rather than inherited: the previous version of this block declared `placed`
  // alongside the coordinate mapping, and removing the coordinates took the helper with it.
  // node --check cannot see a ReferenceError, and this function cannot be imported under
  // node --test (Leaflet), so the whole geospatial adapter failed at runtime with
  // "placed is not defined" and every habitat and species fact went with it.
  const isPlaced = (r) => Number.isFinite(r.lat) && Number.isFinite(r.lon);
  const placedHumps = humps.filter(isPlaced);
  const placedLedges = ledges.filter(isPlaced);
  if (placedHumps.length) out.humpCount = placedHumps.length;
  if (placedLedges.length) out.ledgeCount = placedLedges.length;
  out.structureSource = 'chartpack structure.geojson (coordinates served from the pack, not this profile)';

  return out;
}

function waterFeaturesFromPack(featGeo) {
  // READS water_features.geojson -- points, coves and named creek mouths, which research has
  // never seen at all. Counting Wateree's own trollingIntelligence, humps and ledges are 7 of
  // 104 structure citations; points, coves and creek mouths are most of the rest.
  const out = {};
  const feats = featGeo?.features;
  if (!feats?.length) return out;

  const byKind = {};
  for (const f of feats) {
    const k = f.properties?.kind;
    if (!k) continue;
    (byKind[k] = byKind[k] || []).push(f);
  }

  if (byKind.point?.length) {
    const rel = byKind.point.map(f => Number(f.properties?.deep_side_ft)).filter(Number.isFinite);
    out.points = `${byKind.point.length} charted points`
      + (rel.length ? `; deep side runs to ${Math.max(...rel).toFixed(1)} ft` : '');
  }
  if (byKind.cove?.length) out.coves = `${byKind.cove.length} charted coves`;
  if (byKind.creek_mouth?.length) {
    // Named ones only -- an unnamed creek mouth is a shape, a named one is a place you can be
    // told to go.
    const named = byKind.creek_mouth.map(f => f.properties?.name).filter(Boolean);
    out.creekMouths = named.length
      ? `${byKind.creek_mouth.length} creek mouths including ${named.slice(0, 6).join(', ')}`
      : `${byKind.creek_mouth.length} charted creek mouths`;
  }
  return out;
}


function deriveDepthAreaStructures(depthGeo) {
  const result = {};
  if (!depthGeo?.features?.length) return result;
  let largeShallow = 0;
  for (const f of depthGeo.features) {
    const p = f.properties || {};
    const max = Number(p.depth_max_ft ?? p.depth_min_ft ?? NaN);
    if (!isFinite(max) || max > 10) continue;
    const g = f.geometry;
    if (!g) continue;
    const rings = g.type === 'Polygon' ? [g.coordinates?.[0]] : g.type === 'MultiPolygon' ? (g.coordinates || []).map(poly => poly[0]) : [];
    for (const ring of rings) {
      const acres = polygonAreaAcresLonLat(ring || []);
      if (acres >= 20) largeShallow++;
    }
  }
  if (largeShallow >= 3) result.flats = 'multiple large shallow flats appear in mapped depth-area polygons';
  else if (largeShallow >= 1) result.flats = 'at least one large shallow flat appears in mapped depth-area polygons';
  return result;
}

// ── Depth-statistics derivation from bathymetric polygons ────────────────────
// Computes area-weighted mean depth and max depth directly from the
// depth_areas.geojson band polygons, cross-checked against contour lines and
// the lake boundary. This replaces LLM/sourced numbers when polygon coverage
// is sufficient — it is the limnologically standard hypsometric average
// (V/A) computed with midpoint integration over each depth band.
const GEOM_DEPTH_COVERAGE_THRESHOLD = 0.65; // require polygons to cover ≥65% of lake area
function polygonRingsAcres(g) {
  // Returns array of { ring, acres } for every outer ring of a Polygon/MultiPolygon.
  // Holes are not subtracted — depth_areas exports from the chart pipeline
  // typically do not include holes, and subtracting them requires a full
  // planar overlay we can't do client-side cheaply; outer-ring shoelace is
  // within ~2–5% for these datasets which is well inside the band-midpoint
  // error already present.
  if (!g) return [];
  const out = [];
  const collect = (coords) => {
    const outer = Array.isArray(coords) ? coords[0] : null;
    if (!Array.isArray(outer) || outer.length < 4) return;
    out.push({ ring: outer, acres: polygonAreaAcresLonLat(outer) });
  };
  if (g.type === 'Polygon') collect(g.coordinates);
  else if (g.type === 'MultiPolygon') (g.coordinates || []).forEach(poly => collect(poly));
  return out;
}

function deriveDepthStatistics(contourGeo, depthGeo, boundaryRing) {
  const out = { ok: false, polygonAreaAcres: 0, boundaryAreaAcres: 0, coverage: 0, bandCount: 0 };

  // 1. Sum polygon areas + build band histogram
  let totalBandArea = 0;
  let volumeAcFt = 0;
  let polyMaxDepth = 0;
  // THERE IS NO SUCH THING AS AN OPEN BAND, and this used to be built on the idea that there is.
  // `be` was read as "deeper than X with no ceiling"; it is the one band that straddles a 256 dm
  // page line, so its ceiling byte reads 0 because 256 mod 256 is 0. Every polygon on the card
  // carries both ends. Measured 2026-08-23 after the re-extract: 0 of 89,835 depth-area features
  // across 298 shipped packs lack a numeric depth_max_ft.
  //
  // So `openBanded`, `openBandAreaAcres`, `openBandAreaShare` and `averageDepthIsLowerBound` are
  // gone. They reported zero on every profile and described a property the data does not have.
  // What is left below is a guard on an UNREADABLE record rather than a claim about the lake --
  // counted, the way gmapmf_regions_v51.py counts `band_floor_above_ceiling`, so an impossible
  // case that starts happening is visible instead of silent.
  let unreadableCeilings = 0;
  // Distinct (floor, ceiling) pairs -- the number a person means by "depth bands". This counted
  // RINGS until 2026-08-23, which told the habitat agent Lake Jocassee has 18,967 depth bands
  // when it has 135, and set the no-boundary trust gate on a number that could be three rings of
  // one band.
  const bandsSeen = new Set();
  let ringCount = 0;
  if (depthGeo?.features?.length) {
    for (const f of depthGeo.features) {
      const p = f.properties || {};
      const zMin = Number(p.depth_min_ft);
      const zMaxRaw = p.depth_max_ft;
      const zMax = Number(zMaxRaw);
      const rings = polygonRingsAcres(f.geometry);
      for (const { acres } of rings) {
        if (!isFinite(acres) || acres <= 0) continue;
        totalBandArea += acres;
        // Band midpoint. If the deepest band has no upper bound (zMaxRaw is null/non-numeric),
        // treat the depth as zMin — conservative lower bound for average depth.
        let zEffective;
        if (isFinite(zMax) && isFinite(zMin)) {
          zEffective = (zMin + zMax) / 2;
          if (zMax > polyMaxDepth) polyMaxDepth = zMax;
        } else if (isFinite(zMin)) {
          // A FLOOR AND NO READABLE CEILING. Not a kind of band -- a record we could not read.
          // Count it at its floor rather than dropping it: the area is real water and dropping it
          // would move coverage and the average without saying so. `unreadableCeilings` is the
          // tripwire; it should stay at zero forever.
          zEffective = zMin;
          unreadableCeilings++;
          if (zMin > polyMaxDepth) polyMaxDepth = zMin;
        } else {
          continue; // no usable depth on this polygon
        }
        volumeAcFt += acres * zEffective;
        bandsSeen.add(isFinite(zMax) ? zMin + ':' + zMax : zMin + ':?');
        ringCount++;
      }
    }
  }
  out.polygonAreaAcres = Math.round(totalBandArea * 10) / 10;
  out.bandCount = bandsSeen.size;
  out.polygonCount = ringCount;
  out.unreadableCeilings = unreadableCeilings;

  // 2. Cross-check max against contour lines (deeper isobars may exist outside polygon coverage)
  let contourMaxDepth = 0;
  if (contourGeo?.features?.length) {
    for (const f of contourGeo.features) {
      const d = Number(f?.properties?.depth_ft);
      if (isFinite(d) && d > contourMaxDepth) contourMaxDepth = d;
    }
  }
  const maxDepthFt = Math.max(polyMaxDepth, contourMaxDepth);
  out.maxDepthFt = isFinite(maxDepthFt) && maxDepthFt > 0 ? Math.round(maxDepthFt * 10) / 10 : null;
  out.contourMaxDepthFt = isFinite(contourMaxDepth) && contourMaxDepth > 0 ? contourMaxDepth : null;
  out.polyMaxDepthFt = isFinite(polyMaxDepth) && polyMaxDepth > 0 ? polyMaxDepth : null;

  // 3. Compute surface area from boundary and coverage ratio
  const boundaryArea = boundaryRing ? polygonAreaAcresLonLat(boundaryRing) : 0;
  out.boundaryAreaAcres = Math.round(boundaryArea * 10) / 10;
  const hasBoundary = boundaryArea > 0;

  // Surface area determination: the boundary polygon represents the lake at full
  // pool and is the authoritative surface area. Depth-band polygons from chart
  // pipelines can overlap significantly (each band polygon may extend slightly
  // into adjacent bands), causing their sum to vastly overestimate the true lake
  // area (e.g. 70k ac summed vs 13k ac actual). When no boundary exists, we
  // cannot derive a reliable surface area — the overlapping bands sum inflates
  // wildly. Only set surfaceAreaAcres when we have a boundary polygon.
  let surfaceAcres;
  if (hasBoundary) {
    surfaceAcres = boundaryArea;
    // Detect excessive polygon overlap: if sum exceeds 1.5× boundary, the bands
    // are clearly overlapping and we should use boundary as the truth.
    if (totalBandArea > boundaryArea * 1.5) {
      out._bandOverlapWarning = `Depth-band polygons sum to ${Math.round(totalBandArea)} ac but boundary is ${Math.round(boundaryArea)} ac — using boundary area`;
    }
  } else {
    // No boundary — surface area cannot be reliably derived from overlapping bands.
    surfaceAcres = 0;
  }
  out.surfaceAreaAcres = (hasBoundary && surfaceAcres > 0) ? Math.round(surfaceAcres) : null;

  // Coverage ratio only computable when we have a boundary to compare against.
  if (totalBandArea > 0 && hasBoundary && surfaceAcres > 0) {
    const rawCoverage = totalBandArea / surfaceAcres;
    out.coverage = Math.round(Math.min(rawCoverage, 1.0) * 1000) / 1000;
    out._rawCoverage = Math.round(rawCoverage * 1000) / 1000;
  }

  // 4. Average depth = volume / totalBandArea — works correctly even with
  //    band overlap (both numerator and denominator are inflated proportionally).
  //    With a boundary: require ≥65% polygon coverage of the lake area.
  //    Without a boundary: require at least 3 depth bands as a minimum data bar.
  const canTrustAverage = hasBoundary
    ? (out.coverage >= GEOM_DEPTH_COVERAGE_THRESHOLD)
    : (bandsSeen.size >= 3);
  if (totalBandArea > 0 && canTrustAverage) {
    const avg = volumeAcFt / totalBandArea;
    if (isFinite(avg) && avg > 0) {
      out.averageDepthFt = Math.round(avg * 10) / 10;
      out.ok = true;
    }
  } else if (totalBandArea > 0 && out.maxDepthFt) {
    // Compute anyway but mark as partial — useful as a fallback or QA signal,
    // not published as a verified identity value.
    const avg = volumeAcFt / totalBandArea;
    if (isFinite(avg) && avg > 0) out.averageDepthFtPartial = Math.round(avg * 10) / 10;
  }

  return out;
}

// deriveDepthStatistics falls back to contour geometry when the depth-area polygons do not
// cover enough of the lake. Asking first means a pack with good depth areas -- which is most of
// them, 1,513 of 1,566 -- never downloads contours at all during research.
function depthStats_needsContours(depthGeo) {
  return !(depthGeo?.features?.length > 0);
}

function derivePoiStructures(poiGeo) {
  // THIS USED TO KEEP ONLY BRIDGE NAMES. Fourteen lines whose entire output was one string:
  // it mapped every POI to its name, filtered for /bridge/i, and discarded the rest. Murrells
  // Inlet loads 2,353 POIs; research kept the bridges.
  //
  // What it was throwing away is precisely what Ryan pointed at on 2026-08-06: "there are garmin
  // POI labels that say submerged timber... fish attractors aren't going to show you stump
  // fields or submerged timber they will just show where dnr has dropped a brushpile... hazard
  // buoys for rocks, or sudden shallow areas is another place to look." On Wateree that is 55
  // Flooded Timber, 61 Shallow Area and 45 hazard marks, all fetched, all parsed, all dropped.
  const result = {};
  const feats = poiGeo?.features;
  if (!feats?.length) return result;

  // Grouped by the layer's own poi_type. `on_water` is already a field in the pack -- use it
  // rather than re-deriving it, and keep land POIs out of a structure summary. Ramps and
  // parking are legitimately on land and belong to the access index, not here.
  const counts = {};
  const named = {};
  for (const f of feats) {
    const p = f.properties || {};
    if (p.on_water === false) continue;
    const t = String(p.poi_type || p.class || '').trim();
    if (!t) continue;
    counts[t] = (counts[t] || 0) + 1;
    if (p.name) (named[t] = named[t] || []).push(String(p.name));
  }

  // The kinds the intel actually cites. Anything else is still counted below, but these get
  // named, because "Flooded Timber" is a place you fish and "Buoy" is furniture.
  const CITED = [/timber/i, /shallow/i, /hazard/i, /attractor/i, /pile/i, /bridge/i, /wreck/i, /reef/i];
  const cited = Object.keys(counts).filter(t => CITED.some(re => re.test(t)));
  if (cited.length) {
    result.chartedStructurePois = cited
      .sort((a, b) => counts[b] - counts[a])
      .map(t => `${counts[t]} ${t}`)
      .join('; ');
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total) {
    const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 6);
    result.chartedPoiMix = `${total} on-water charted POIs — ${top.map(t => `${counts[t]} ${t}`).join(', ')}`;
  }
  // Kept because it was here and it is genuinely useful on a river.
  const bridges = (named.Bridge || []).concat(
    Object.entries(named).filter(([t]) => /bridge/i.test(t)).flatMap(([, v]) => v));
  if (bridges.length) {
    result.bridges = bridges.length >= 2
      ? `bridge-related POIs include ${[...new Set(bridges)].slice(0, 3).join(', ')}`
      : `bridge-related POI includes ${bridges[0]}`;
  }
  return result;
}


async function deriveGeospatialStructureFacts(lakeName) {
  const contourKey = resolveR2Key(lakeName);
  const supplementalKey = resolveSupplementalKey(lakeName);
  const boundaryKey = resolveBoundaryKey(lakeName);
  // structure.geojson and water_features.geojson are what build_structure.py and
  // build_water_features.py already derived from this exact pack, offline, against the whole
  // lake. Research used to re-derive humps and ledges from raw contours in the browser and
  // never saw points, coves or creek mouths at all.
  //
  // NO CACHE-BUSTER. Every one of these carried `?v=${Date.now()}`, which defeated the Worker's
  // ETag + max-age=300 BY CONSTRUCTION -- it could never hit cache, so a Wateree research run
  // re-downloaded 9.7 MB of contours and 18.6 MB of depth areas every time. Packs change only
  // when the uploader runs; five minutes of staleness is the right trade.
  const [structGeo, featGeo, depthGeo, poiGeo, boundaryGeo] = await Promise.all([
    contourKey ? fetchGeoJsonMaybe(`${CF_WORKER_URL}/chartpacks/${contourKey}/structure.geojson`) : Promise.resolve(null),
    contourKey ? fetchGeoJsonMaybe(`${CF_WORKER_URL}/chartpacks/${contourKey}/water_features.geojson`) : Promise.resolve(null),
    supplementalKey ? fetchGeoJsonMaybe(`${CF_WORKER_URL}/chartpacks/${supplementalKey}/depth_areas.geojson`) : Promise.resolve(null),
    supplementalKey ? fetchGeoJsonMaybe(`${CF_WORKER_URL}/chartpacks/${supplementalKey}/pois.geojson`) : Promise.resolve(null),
    // Boundary files in R2 use a _3dhp suffix (USGS 3D Hydrography Program).
    // Try _3dhp first, fall back to bare key for older boundary files.
    boundaryKey ? fetchGeoJsonMaybe(`${CF_WORKER_URL}/chartpacks/${boundaryKey}/boundary.geojson`)
      : Promise.resolve(null),
  ]);
  const ring = getBoundaryOuterRing(boundaryGeo);
  const structuralElements = {
    ...summarizePointComplexityFromBoundary(ring),
    ...structuresFromPack(structGeo),
    ...waterFeaturesFromPack(featGeo),
    ...deriveDepthAreaStructures(depthGeo),
    ...derivePoiStructures(poiGeo),
  };

  // Geometry-derived identity facts (surface area, max depth, average depth).
  // These are preferred over LLM/sourced numbers when bathymetric polygon
  // coverage meets the threshold defined in deriveDepthStatistics.
  // Surface area / max depth / average depth is a DIFFERENT job from structure, and it is the
  // only thing that still wants the raw contour geometry. Fetched here rather than above so the
  // structure path no longer pays for it on packs that have structure.geojson.
  const contourGeo = depthStats_needsContours(depthGeo)
    ? await fetchGeoJsonMaybe(`${CF_WORKER_URL}/chartpacks/${contourKey}/contours.geojson`)
    : null;
  const depthStats = deriveDepthStatistics(contourGeo, depthGeo, ring);

  const identityFacts = {};
  const identityEvidence = {};
  const geoMeta = {};
  if (depthStats.ok) {
    if (depthStats.surfaceAreaAcres) identityFacts.surfaceAreaAcres = depthStats.surfaceAreaAcres;
    if (depthStats.maxDepthFt) identityFacts.maxDepthFt = depthStats.maxDepthFt;
    if (depthStats.averageDepthFt) identityFacts.averageDepthFt = depthStats.averageDepthFt;
    geoMeta.bathymetryCoverage = depthStats.coverage;
    geoMeta.bathymetryBandCount = depthStats.bandCount;
    geoMeta.bathymetryPolygonCount = depthStats.polygonCount;
    // Zero unless a record could not be read at all. See deriveDepthStatistics -- it replaces
    // four open-band fields that reported zero on every profile because open bands do not exist.
    geoMeta.bathymetryUnreadableCeilings = depthStats.unreadableCeilings || 0;
    const bathyEntry = buildEvidenceEntry(
      'internal_geospatial_layer',
      'TrollMap bathymetric contour/depth-area polygons',
      'internal:bathymetry',
      null,
      'geometry_derived_hypsometry',
      {
        polygonAreaAcres: depthStats.polygonAreaAcres,
        boundaryAreaAcres: depthStats.boundaryAreaAcres,
        coverage: depthStats.coverage,
        maxDepthFt: depthStats.maxDepthFt,
        averageDepthFt: depthStats.averageDepthFt,
        surfaceAreaAcres: depthStats.surfaceAreaAcres,
        unreadableCeilings: depthStats.unreadableCeilings || 0,
        bandCount: depthStats.bandCount,
      }
    );
    if (depthStats.surfaceAreaAcres) identityEvidence.surfaceAreaAcres = [bathyEntry];
    if (depthStats.maxDepthFt) identityEvidence.maxDepthFt = [bathyEntry];
    if (depthStats.averageDepthFt) identityEvidence.averageDepthFt = [bathyEntry];
  } else if (depthStats.maxDepthFt) {
    // Coverage too low to trust the average, but max depth from contours is still usable.
    identityFacts.maxDepthFt = depthStats.maxDepthFt;
    geoMeta.bathymetryCoverage = depthStats.coverage;
    geoMeta.bathymetryNote = 'Polygon coverage below threshold; only contour max depth used.';
    identityEvidence.maxDepthFt = [buildEvidenceEntry(
      'internal_geospatial_layer',
      'TrollMap bathymetric contour lines',
      'internal:contours',
      null,
      'geometry_derived_max_depth_only',
      { maxDepthFt: depthStats.maxDepthFt, coverage: depthStats.coverage }
    )];
  }

  const hasStructure = Object.keys(structuralElements).length > 0;
  const hasIdentity = Object.keys(identityFacts).length > 0;
  if (!hasStructure && !hasIdentity) return null;

  const evidence = { habitat: {}, identity: identityEvidence };
  for (const field of Object.keys(structuralElements)) {
    evidence.habitat[`structuralElements.${field}`] = [buildEvidenceEntry('internal_geospatial_layer', 'TrollMap structure / water_features / POI / boundary layers', 'internal:structure+water_features+pois+boundaries', null, 'pipeline_derived_structure_layers', { lakeName })];
  }

  const habitatSection = hasStructure ? {
    structuralElements,
    notes: 'Structural elements summarized from TrollMap contour, depth-area, POI, and boundary layers.'
  } : (undefined);

  const identitySection = hasIdentity ? { ...identityFacts, _geometryDerived: true, _bathymetryMeta: geoMeta } : (undefined);

  return {
    habitat: habitatSection,
    identity: identitySection,
    evidence,
    sources: [{ label: 'TrollMap structure / water_features / POI / boundary layers', url: 'internal:contours+supplemental+boundaries', trust: 'OFFICIAL_GIS', sourceType: 'internal_geospatial_layer' }],
    depthStats,
  };
}

/**
 * PDF.js In-Browser Text Extractor
 * Loads PDF.js from unpkg/cdnjs dynamically so we don't have local dependencies.
 */
async function extractTextFromPDFBytes(arrayBuffer, onProgress) {
  if (window.pdfjsLib === undefined) {
    log("Loading PDF.js dynamically into browser thread...");
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.min.js';
    document.head.appendChild(script);
    await new Promise((resolve) => {
      script.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
        resolve();
      };
    });
  }

  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = pdf.numPages;
  log(`PDF parsed successfully. Total pages to extract text from: ${numPages}`);

  let fullText = "";
  const pagesData = [];

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(" ");
    
    // Attempt simple title/heading heuristic from first page or top lines
    let title = "";
    if (pageNum === 1 && content.items.length) {
      title = content.items.slice(0, 5).map(item => item.str).join(" ").trim().slice(0, 100);
    }

    pagesData.push({
      pageNumber: pageNum,
      text: pageText,
      title: title || `Page ${pageNum}`
    });

    fullText += `\n--- PAGE ${pageNum} ---\n` + pageText;
    if (onProgress) {
      onProgress(pageNum, numPages);
    }
  }

  return { fullText, pages: pagesData };
}

/**
 * Step-by-Step Evidence Acquisition Pipeline Runner
 */
// Shared scoring function used by runFullPipeline and runResume.
// Previously duplicated with a weaker version in the resume path — now one source of truth.
function scoreDocuments(normalizedDocuments, baseName, lakeName) {
  const baseLower = baseName.toLowerCase();
  return normalizedDocuments.map(doc => {
    let authorityScore = 55;
    const auth = String(doc.authority || '').toUpperCase();
    const titleLower = String(doc.title || '').toLowerCase();
    const urlLower = String(doc.url || '').toLowerCase();
    const lower = String(doc.fullText || '').toLowerCase();

    if (/USACE|USGS|EPA|NOAA|FEDERAL/.test(auth)) authorityScore = 100;
    else if (/SCDNR|NCWRC|DNR|STATE/.test(auth)) authorityScore = 98;
    else if (/CLEMSON|NC STATE|UNIVERSITY|UGA|USC/.test(auth)) authorityScore = 90;
    else if (/DUKE|DOMINION|POWER|UTILITY/.test(auth)) authorityScore = 85;
    else if (/GROKIPEDIA/.test(auth) || /grokipedia\.com/i.test(urlLower)) authorityScore = 80;

    const mentionsBase = lower.includes(baseLower);
    const titleHasBase = titleLower.includes(baseLower);
    const isOfficialRegs = /eregulations\.com|fishregs|size.?possession|freshwater.?fish.?size|creel.?limit/i.test(urlLower + ' ' + titleLower)
      || /size limit|possession limit|creel limit|statewide except/i.test(lower.slice(0, 4000));
    const isLakeRegsPage = /\/lakes\/[^/]+\/regs\.html/i.test(urlLower) || /lake .+ regulations/i.test(titleLower);

    let relevance = 40;
    if (titleHasBase) relevance = 95;
    else if (mentionsBase) {
      const count = (lower.match(new RegExp(baseLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      relevance = count >= 3 ? 90 : count >= 1 ? 70 : 50;
    }
    if (isOfficialRegs) { relevance = Math.max(relevance, 90); authorityScore = Math.max(authorityScore, 98); }
    if (isLakeRegsPage && (titleHasBase || urlLower.includes(baseLower))) { relevance = Math.max(relevance, 95); authorityScore = Math.max(authorityScore, 98); }
    if (!mentionsBase && !titleHasBase && !isOfficialRegs) { authorityScore = Math.min(authorityScore, 60); relevance = 35; }

    const otherLakes = ['murray','marion','moultrie','hartwell','keowee','jocassee','thurmond','russell','wylie','norman','james','rhodhiss'];
    for (const other of otherLakes) {
      if (other === baseLower) continue;
      if (titleLower.includes(`lake ${other}`) && !titleLower.includes(baseLower)) {
        authorityScore = Math.min(authorityScore, 30); relevance = 15;
        log(`⚠️ Detected off-lake doc: "${doc.title}" mentions lake ${other} not ${baseName} — penalizing`);
      }
    }

    let freshness = 75;
    const yearMatch = (doc.title + ' ' + doc.url).match(/(19|20)\d{2}/);
    if (yearMatch) { const age = 2026 - parseInt(yearMatch[0], 10); freshness = Math.max(25, 95 - age * 6); }
    if (/pocket guide/i.test(doc.title)) freshness = 50;
    if (/regulations.*202[4-6]|202[4-6].*regulations/i.test(doc.title)) freshness = 95;

    const completeness = (doc.fullText||'').length > 20000 ? 95 : (doc.fullText||'').length > 8000 ? 85 : (doc.fullText||'').length > 2000 ? 65 : 35;
    const composite = Math.round(authorityScore * 0.5 + relevance * 0.3 + freshness * 0.1 + completeness * 0.1);

    const classes = [];
    if (/hydrology|flow|elevation|dam|discharge|river stage|pool/.test(lower)) classes.push("Hydrology");
    if (/biology|forage|shad|herring|predator|bass|crappie|catfish|stocking/.test(lower)) classes.push("Biology");
    if (/limnology|thermocline|oxygen|secchi|turbidity|clarity|temperature stratification/.test(lower)) classes.push("Limnology");
    if (/regulation|creel|size limit|length limit|bag limit|closure|season/.test(lower)) classes.push("Regulations");
    if (/hazard|shoal|stump|depth|timber|navig|boat ramp|access/.test(lower)) classes.push("Navigation");
    if (/troll|presentation|lure|spread|crankbait|a-rig|umbrella/.test(lower)) classes.push("Trolling");

    return {
      title: doc.title, authority: doc.authority, url: doc.url,
      scoring: { authority: authorityScore, relevance, freshness, completeness, composite },
      classes: classes.length ? classes : ["General Overview"]
    };
  }).sort((a, b) => (b.scoring.composite||0) - (a.scoring.composite||0));
}

const VALIDATION_FIELD_PATHS = [
  'identity.surfaceAreaAcres', 'identity.maxDepthFt', 'identity.averageDepthFt',
  'identity.reservoirOwner', 'identity.riverSystem',
  'identity.damName', 'identity.yearImpounded', 'identity.county', 'identity.archetype',
  'limnology.waterClarity.typical', 'limnology.waterClarity.color',
  'limnology.waterClarity.secchiFt', 'limnology.thermocline.summerDepthFt',
  'limnology.thermocline.strength', 'limnology.thermocline.winterMix',
  'limnology.oxygen.depletionDepthFt', 'limnology.oxygen.anoxicBelowFt',
  'limnology.trophicStatus', 'limnology.flowCharacteristics', 'limnology.seasonalDrawdownFt',
  'biology.primaryForage', 'biology.secondaryForage', 'biology.predatorSpecies',
  'biology.speciesAbundance', 'biology.knownStockings', 'biology.baitfishMovement',
  'biology.invasiveSpecies', 'biology.spawnTiming', 'biology.forageSpatial',
  'habitat.bottomComposition', 'habitat.cover', 'habitat.vegetation',
  'habitat.standingTimber', 'habitat.dockDensity', 'habitat.riprapLocations',
  'habitat.namedCreekMouths', 'habitat.timberFields', 'habitat.shallowFlatAreas',
  'habitat.artificialHabitat', 'habitat.artificialHabitatDetails.attractorCount',
  'habitat.artificialHabitatDetails.attractorTypes',
  'navigation.ramps', 'navigation.hazards', 'navigation.notes'
];

const COASTAL_VALIDATION_FIELD_PATHS = [
  'estuary.waterBodyType', 'estuary.meanTidalRangeFt', 'estuary.primaryInlets',
  'estuary.tributaryRivers', 'estuary.marshAcreage', 'estuary.oysterPresence',
  'tidal.datum', 'tidal.stratificationType', 'tidal.salinityPpt', 'tidal.tidalCurrentKts',
  'tidal.flushingTimeDays', 'tidal.waterTempF', 'tidal.turbidity',
  'biology.primaryForage', 'biology.secondaryForage', 'biology.predatorSpecies',
  'biology.speciesAbundance', 'biology.baitfishMovement', 'biology.spawnTiming', 'biology.forageSpatial',
  'habitat.bottomComposition', 'habitat.cover', 'habitat.vegetation',
  'habitat.riprapLocations', 'habitat.namedCreekMouths', 'habitat.shallowFlatAreas',
  'navigation.ramps', 'navigation.hazards', 'navigation.notes',
  // `saltwaterRegulations`, `saltwater_regulations` and `regulations` were here, which meant the
  // validation pass asked an LLM to fill the regulations section even with no agent targeting it.
  // The freshwater list never had them. The coastal digest and fetchLiveRegsAmendments() answer
  // this now, and a proclamation-driven rule is precisely the thing not to freeze into a profile.
];

function valueAtPath(obj, path) {
  return path.split('.').reduce((value, key) => value == null ? undefined : value[key], obj);
}

function isValidationGap(value) {
  return value == null || value === ''
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
}

function setAtPath(obj, path, value) {
  const parts = path.split('.');
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cursor[parts[i]] || typeof cursor[parts[i]] !== 'object') cursor[parts[i]] = {};
    cursor = cursor[parts[i]];
  }
  cursor[parts[parts.length - 1]] = value;
}

// Uses only previously extracted R2/profile facts. No discover, proxy-download,
// Firecrawl, PDF parsing, or per-document extraction is triggered here.
async function validateExistingFacts(lakeName, callbacks = {}) {
  if (_state.researchInProgress) throw new Error('A research task is already in progress.');
  if (!lakeName) throw new Error('Select a lake first.');
  _state.researchInProgress = true;
  _state.researchLog = [];
  showProgress(true);
  setProgress('Loading saved profile and extracted facts…', 5);
  log(`=== VALIDATE EXISTING FACTS: ${lakeName} ===`);
  try {
    const getRes = await fetch(`${CF_WORKER_URL}/research/get?lake=${encodeURIComponent(lakeName)}`);
    if (!getRes.ok) throw new Error(`Profile load HTTP ${getRes.status}`);
    const getData = await getRes.json();
    if (!getData.ok || !getData.profile) throw new Error('No saved research profile exists for this lake. Run research once first.');
    const profile = cloneJson(getData.profile);
    const facts = profile._extractedFacts || [];
    if (!facts.length) throw new Error('This saved profile has no extracted facts to validate. Run research or import facts first.');

    // Masters flatten identity fields, while an in-progress packet has identity
    // nested. Normalize only for validation and retain both shapes on save.
    profile.identity = profile.identity || {
      lakeName: profile.lakeName, state: profile.state, aliases: profile.aliases || [],
      county: profile.county, riverSystem: profile.riverSystem, reservoirOwner: profile.reservoirOwner,
      surfaceAreaAcres: profile.surfaceAreaAcres, maxDepthFt: profile.maxDepthFt,
      averageDepthFt: profile.averageDepthFt,
      damName: profile.damName, yearImpounded: profile.yearImpounded, archetype: profile.archetype
    };
    profile.biology = profile.biology || {};
    profile.limnology = profile.limnology || {};
    profile.habitat = profile.habitat || {};
    profile.navigation = profile.navigation || {};
    profile.estuary = profile.estuary || {};
    profile.tidal = profile.tidal || {};
    profile.saltwaterRegulations = profile.saltwaterRegulations || profile.saltwater_regulations || {};

    const _validationPaths = isCoastalLake(lakeName) ? COASTAL_VALIDATION_FIELD_PATHS : VALIDATION_FIELD_PATHS;
    const nullFields = _validationPaths.filter(path => isValidationGap(valueAtPath(profile, path)));
    log(`Saved facts: ${facts.length}. Empty supported fields: ${nullFields.length}.`);
    if (!nullFields.length) {
      log('✔ No supported validation gaps remain; no LLM call or save needed.');
      setProgress('Existing facts already validated.', 100);
      if (callbacks.onComplete) await callbacks.onComplete(lakeName);
      return { ok: true, fieldsRequested: 0, fieldsFilled: 0 };
    }

    const filled = {};
    const batches = Math.ceil(nullFields.length / 10);
    for (let start = 0; start < nullFields.length; start += 10) {
      const batch = nullFields.slice(start, start + 10);
      const index = start / 10 + 1;
      setProgress(`Validating existing facts (${index}/${batches})…`, 15 + index / batches * 65);
      log(`Validation batch ${index}/${batches}: ${batch.join(', ')}`);
      const res = await fetch(`${CF_WORKER_URL}/research/validation-pass`, {
        method: 'POST', headers: workerHeaders(),
        body: JSON.stringify({ lakeName, state: sanitizeStateFromLakeName(lakeName), nullFields: batch, extractedFacts: facts })
      });
      if (!res.ok) throw new Error(`Validation HTTP ${res.status}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Validation agent failed');
      Object.assign(filled, data.filled || {});
      if (start + 10 < nullFields.length) await new Promise(resolve => setTimeout(resolve, 1000));
    }

    let applied = 0;
    for (const [path, value] of Object.entries(filled)) {
      if (nullFields.includes(path) && !isValidationGap(value) && isValidationGap(valueAtPath(profile, path))) {
        setAtPath(profile, path, value);
        applied++;
      }
    }
    // Keep master-profile identity convenience fields synchronized with values
    // filled under the normalized identity object.
    for (const key of ['surfaceAreaAcres', 'maxDepthFt', 'averageDepthFt', 'reservoirOwner', 'riverSystem', 'damName', 'yearImpounded', 'county', 'archetype']) {
      if (profile.identity[key] != null) profile[key] = profile.identity[key];
    }
    profile.metadata = profile.metadata || {};
    profile.metadata.lastExistingFactsValidationAt = new Date().toISOString();
    profile.metadata.existingFactsValidationApplied = applied;

    setProgress('Saving validated profile…', 90);
    const saveRes = await fetch(`${CF_WORKER_URL}/research/save`, {
      method: 'POST', headers: workerHeaders(),
      body: JSON.stringify({ lakeName, profile, status: profile.metadata.status || 'draft', requestedBy: 'Validate Existing Facts' })
    });
    if (!saveRes.ok) throw new Error(`Save HTTP ${saveRes.status}`);
    log(`✔ Existing-fact validation returned ${Object.keys(filled).length} field(s); applied ${applied}.`);
    setProgress('Existing-fact validation complete.', 100);
    if (callbacks.onComplete) await callbacks.onComplete(lakeName);
    return { ok: true, fieldsRequested: nullFields.length, fieldsFilled: applied, returned: Object.keys(filled).length };
  } catch (err) {
    log(`❌ Existing-fact validation failed: ${err.message}`);
    setProgress('Validation failed — see log.', 0);
    throw err;
  } finally {
    _state.researchInProgress = false;
  }
}

const SMART_PLAN_RECOVERY_FIELDS = [
  'limnology.waterClarity.typical', 'limnology.waterClarity.color', 'limnology.waterClarity.secchiFt',
  'limnology.thermocline.summerDepthFt', 'limnology.thermocline.strength',
  'limnology.oxygen.depletionDepthFt', 'limnology.oxygen.anoxicBelowFt',
  'limnology.flowCharacteristics', 'limnology.seasonalDrawdownFt',
  'biology.primaryForage', 'biology.secondaryForage', 'biology.baitfishMovement',
  'biology.spawnTiming', 'biology.forageSpatial',
  'habitat.cover', 'habitat.standingTimber', 'habitat.dockDensity',
  'habitat.riprapLocations', 'habitat.namedCreekMouths', 'habitat.timberFields',
  'habitat.shallowFlatAreas', 'habitat.artificialHabitat',
  'habitat.artificialHabitatDetails.attractorCount', 'habitat.artificialHabitatDetails.attractorTypes'
];

function normalizeMasterForRecovery(profile) {
  profile.identity = profile.identity || {
    lakeName: profile.lakeName, state: profile.state, aliases: profile.aliases || [], county: profile.county,
    riverSystem: profile.riverSystem, reservoirOwner: profile.reservoirOwner, surfaceAreaAcres: profile.surfaceAreaAcres,
    maxDepthFt: profile.maxDepthFt, averageDepthFt: profile.averageDepthFt,
    damName: profile.damName, yearImpounded: profile.yearImpounded, archetype: profile.archetype
  };
  profile.biology = profile.biology || {};
  profile.limnology = profile.limnology || {};
  profile.limnology.waterClarity = profile.limnology.waterClarity || {};
  profile.limnology.thermocline = profile.limnology.thermocline || {};
  profile.limnology.oxygen = profile.limnology.oxygen || {};
  profile.habitat = profile.habitat || {};
  profile.habitat.artificialHabitatDetails = profile.habitat.artificialHabitatDetails || {};
  profile.navigation = profile.navigation || {};
  profile.fieldStatus = profile.fieldStatus || {};
  return profile;
}

/**
 * A DEPTH NOBODY MEASURED IS NOT A DEPTH OF ZERO.
 *
 * `Number(null)` is 0 and `Number.isFinite(0)` is true, so a lake whose profile had no recorded
 * maximum depth passed the "ten feet or less" test and had four limnology fields stamped
 * `not_applicable` and stripped from the target list before a single query was issued. It is
 * self-sealing: `gateOverallConfidence` exempts `not_applicable` from the null-field penalties,
 * so the confidence score never registered the loss.
 *
 * MEASURED IN R2 ON 2026-08-21, this had already happened. 26 of 61 stored profiles carry
 * `maxDepthFt: null`, and six carry the stamp -- high_rock_lake_nc, lake_blalock_sc,
 * melton_hill_reservoir_tn, lake_hickory_nc and lake_norman_nc all reading "Maximum depth 0 ft
 * and average depth 0 ft", on Norman's part over a 130 ft basin. parr_reservoir_sc caught it
 * through the other operand: a real 15 ft maximum with NO recorded average, where
 * `Number(null) <= 8` closed the second clause.
 *
 * The geometry-derived bathymetry override is what fills this properly -- `deriveDepthStatistics`
 * takes max depth from the contour lines even when polygon coverage is too low to trust an
 * average, so any water with a chartpack has one. This guard is not a substitute for that. It is
 * here because the stamp is written from the SAVED profile, and a profile only has to store null
 * ONCE -- a pack that failed to fetch, a profile written before the override existed -- for four
 * fields to go quietly dead.
 *
 * Same idiom as tide-engine.js: empty string, null and undefined are all "not recorded".
 */
function applyShallowLakeApplicability(profile, fields) {
  const depth = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const max = depth(profile.identity?.maxDepthFt);
  const avg = depth(profile.identity?.averageDepthFt);
  const noPersistentThermocline = (Number.isFinite(max) && max <= 10)
    || (Number.isFinite(max) && max <= 15 && Number.isFinite(avg) && avg <= 8);
  if (!noPersistentThermocline) return fields;
  const exempt = new Set([
    'limnology.thermocline.summerDepthFt', 'limnology.thermocline.strength',
    'limnology.oxygen.depletionDepthFt', 'limnology.oxygen.anoxicBelowFt'
  ]);
  for (const path of fields) {
    if (!exempt.has(path)) continue;
    profile.fieldStatus[path] = {
      status: 'not_applicable',
      reason: `Maximum depth ${max} ft${Number.isFinite(avg) ? ` and average depth ${avg} ft` : ''} indicate no persistent, Smart Plan-relevant summer thermocline or deep oxygen floor.`
    };
  }
  return fields.filter(path => !exempt.has(path));
}

function scoreRecoveryDocument(doc, fields) {
  const id = `${doc.title || ''} ${doc.url || ''}`.toLowerCase();
  const text = String(doc.fullText || doc.text || '').slice(0, 120000).toLowerCase();
  let score = /usgs|epa|water.?quality|limnolog|spartanburgwater|operator|reservoir/i.test(id) ? 20 : 0;
  if (fields.some(f => f.startsWith('limnology.')) && /thermocline|dissolved oxygen|secchi|water quality|stratif|limnolog|profile/.test(text)) score += 30;
  if (fields.some(f => f.startsWith('biology.')) && /forage|herring|shad|spawn|stocking|fisheries|species/.test(text)) score += 20;
  if (fields.some(f => f.startsWith('habitat.')) && /timber|riprap|creek|dock|attractor|vegetation|brush|flat|structure/.test(text)) score += 20;
  if (/facebook|lake biwa|researchgate|bowfishing/i.test(id)) score -= 30;
  return score;
}

// One-and-done, Smart Plan-only recovery. It never downloads or discovers new
// sources: at most five already-normalized R2 documents are re-extracted.
async function recoverSmartPlanFacts(lakeName, callbacks = {}) {
  if (_state.researchInProgress) throw new Error('A research task is already in progress.');
  if (!lakeName) throw new Error('Select a lake first.');
  _state.researchInProgress = true;
  _state.researchLog = [];
  showProgress(true);
  setProgress('Loading saved Smart Plan evidence…', 5);
  log(`=== SMART PLAN TARGETED RECOVERY: ${lakeName} ===`);
  try {
    const [profileRes, docsRes] = await Promise.all([
      fetch(`${CF_WORKER_URL}/research/get?lake=${encodeURIComponent(lakeName)}`),
      fetch(`${CF_WORKER_URL}/research/get-normalized?lake=${encodeURIComponent(lakeName)}`)
    ]);
    if (!profileRes.ok || !docsRes.ok) throw new Error('A saved profile and normalized documents are both required.');
    const profileData = await profileRes.json();
    const docsData = await docsRes.json();
    if (!profileData.ok || !docsData.ok) throw new Error('Could not load saved profile/documents.');
    const profile = normalizeMasterForRecovery(cloneJson(profileData.profile));
    let targetFields = SMART_PLAN_RECOVERY_FIELDS.filter(path => isValidationGap(valueAtPath(profile, path)));
    targetFields = applyShallowLakeApplicability(profile, targetFields);
    if (!targetFields.length) {
      log('✔ No applicable Smart Plan recovery gaps remain.');
      if (callbacks.onComplete) await callbacks.onComplete(lakeName);
      return { ok: true, documents: 0, facts: 0, filled: 0, finalized: 0 };
    }
    const docs = (docsData.documents || []).filter(d => String(d.fullText || d.text || '').length >= 200);
    const selected = docs.map(d => ({ d, score: scoreRecoveryDocument(d, targetFields) }))
      .filter(x => x.score >= 20).sort((a, b) => b.score - a.score).slice(0, 5).map(x => x.d);
    log(`Applicable Smart Plan gaps: ${targetFields.length}. Re-extracting ${selected.length} highest-value cached document(s).`);
    const newFacts = [];
    for (let i = 0; i < selected.length; i++) {
      const doc = selected[i];
      setProgress(`Targeted extraction ${i + 1}/${selected.length}…`, 12 + (i / Math.max(1, selected.length)) * 48);
      log(`Targeted document ${i + 1}/${selected.length}: ${doc.title}`);
      const res = await fetch(`${CF_WORKER_URL}/research/analyze-facts`, {
        method: 'POST', headers: workerHeaders(),
        body: JSON.stringify({ lakeName, state: sanitizeStateFromLakeName(lakeName), targetFields, documents: [{ title: doc.title, url: doc.url, text: String(doc.fullText || doc.text || '').slice(0, 200000) }] })
      });
      if (!res.ok) { log(`⚠️ Targeted extraction HTTP ${res.status}; continuing.`); continue; }
      const data = await res.json();
      newFacts.push(...(data.extracted_facts || []));
      if (i + 1 < selected.length) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    let facts = [...(profile._extractedFacts || []), ...newFacts];
    if (newFacts.length) {
      const dedupeRes = await fetch(`${CF_WORKER_URL}/research/dedupe-contradictions`, { method: 'POST', headers: workerHeaders(), body: JSON.stringify({ facts }) });
      if (dedupeRes.ok) facts = (await dedupeRes.json()).deduplicated_facts || facts;
    }
    profile._extractedFacts = facts;
    profile._extractedFactsCount = facts.length;
    log(`Targeted extraction produced ${newFacts.length} fact(s); evidence corpus now has ${facts.length}.`);

    // Validate only the Smart Plan gaps, now including any recovered facts.
    const filled = {};
    for (let start = 0; start < targetFields.length; start += 10) {
      const batch = targetFields.slice(start, start + 10);
      const res = await fetch(`${CF_WORKER_URL}/research/validation-pass`, { method: 'POST', headers: workerHeaders(), body: JSON.stringify({ lakeName, state: sanitizeStateFromLakeName(lakeName), nullFields: batch, extractedFacts: facts }) });
      if (!res.ok) throw new Error(`Validation HTTP ${res.status}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Validation failed');
      Object.assign(filled, data.filled || {});
      if (start + 10 < targetFields.length) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    let applied = 0;
    for (const [path, value] of Object.entries(filled)) {
      if (targetFields.includes(path) && !isValidationGap(value) && isValidationGap(valueAtPath(profile, path))) { setAtPath(profile, path, value); applied++; }
    }
    // This is the terminal recovery pass by design: remaining applicable gaps
    // are explicitly recorded as reviewed/unavailable and no longer penalize confidence.
    let finalized = 0;
    for (const path of targetFields) {
      if (!isValidationGap(valueAtPath(profile, path))) continue;
      profile.fieldStatus[path] = { status: 'not_available_after_targeted_review', reason: `No defensible value found after targeted extraction of ${selected.length} highest-value saved Smart Plan source(s).` };
      finalized++;
    }
    for (const key of ['surfaceAreaAcres','maxDepthFt','averageDepthFt','reservoirOwner','riverSystem','damName','yearImpounded','county','archetype']) if (profile.identity[key] != null) profile[key] = profile.identity[key];
    // Preserve trollingIntelligence — recovery should never wipe fisheries data
    if (!profile.trollingIntelligence && profileData.profile?.trollingIntelligence) {
      profile.trollingIntelligence = profileData.profile.trollingIntelligence;
    }
    profile.metadata = profile.metadata || {};
    profile.metadata.lastSmartPlanRecoveryAt = new Date().toISOString();
    profile.metadata.smartPlanRecovery = { targetedDocuments: selected.map(d => d.title), newFacts: newFacts.length, applied, finalized };
    setProgress('Saving Smart Plan recovery profile…', 92);
    const saveRes = await fetch(`${CF_WORKER_URL}/research/save`, { method: 'POST', headers: workerHeaders(), body: JSON.stringify({ lakeName, profile, status: profile.metadata.status || 'draft', requestedBy: 'Smart Plan Targeted Recovery' }) });
    if (!saveRes.ok) throw new Error(`Save HTTP ${saveRes.status}`);
    log(`✔ Smart Plan recovery applied ${applied}; finalized ${finalized} reviewed gap(s).`);
    setProgress('Smart Plan recovery complete.', 100);
    if (callbacks.onComplete) await callbacks.onComplete(lakeName);
    return { ok: true, documents: selected.length, facts: newFacts.length, filled: applied, finalized };
  } catch (err) {
    log(`❌ Smart Plan recovery failed: ${err.message}`); setProgress('Recovery failed — see log.', 0); throw err;
  } finally { _state.researchInProgress = false; }
}

// ── runResume: skip discovery/download, load normalized docs from R2, run selected agents ──
async function runResume(lakeName, selectedAgents, callbacks = {}) {
  if (_state.researchInProgress) { alert('A research task is already in progress.'); return; }
  if (!lakeName) { alert('Please select a lake.'); return; }

  log(`=== RESUME: ${lakeName} — agents: [${selectedAgents.join(', ')}] ===`);
  // Worker handles agentTags filtering in resume mode — just delegate to runAgents
  // researchInProgress is managed entirely by runAgents
  await runAgents(lakeName, selectedAgents, 'resume', callbacks);
}

// ── runAgent: Execute single agent pipeline with client-side orchestration ──
// Calls individual fast Worker endpoints sequentially — no single Worker request
// does too much, avoiding the CPU time limit that killed handleResearchAgentPipeline.
// Pattern: discover → proxy-download (per doc) → save-normalized → analyze-facts
//          → dedupe-contradictions → agent (LLM only)

/**
 * The reason a Worker call failed, out of the body it already put there.
 *
 * A 502 FROM THIS WORKER IS NEVER A MYSTERY -- IT IS A SENTENCE WE WROTE. research/agents.js
 * returns `{success:false, error:"LLM failed: <provider error>"}` with status 502 whenever
 * callLLM exhausts its chain, and research/extract.js does the same for the mapping agent.
 * Every one of those bodies names the provider and the HTTP status it got back.
 *
 * Until 2026-08-16 the engine logged `Agent x LLM failed: 502` and dropped the body on the
 * floor, so a night went into guessing at rate limits and Worker memory when the answer was
 * sitting in the response. Ryan: "if it was a rate limit issue with the LLM then i should see
 * a 429 not a 502... so i am not sure that you are even barking up the right tree." He was
 * right, and the body is how anyone would have known.
 */
async function workerFailureReason(res) {
  try {
    const txt = await res.clone().text();
    if (!txt) return `HTTP ${res.status}, empty body`;
    try {
      const j = JSON.parse(txt);
      const bits = [j.error, j.detail, j.raw && `raw: ${String(j.raw).slice(0, 200)}`].filter(Boolean);
      return bits.length ? `HTTP ${res.status} — ${bits.join(' | ')}` : `HTTP ${res.status} — ${txt.slice(0, 300)}`;
    } catch (_) { return `HTTP ${res.status} — ${txt.slice(0, 300)}`; }
  } catch (_) {
    // A body we cannot read is different from a body that says nothing, and only one of them
    // means the response never arrived.
    return `HTTP ${res.status}, body unreadable (the response may not have completed)`;
  }
}


/**
 * The ramps the PIPELINE already bound to this lake, flattened for the Worker.
 *
 * WHY THE WORKER CANNOT DO THIS ITSELF. deterministic.js calls waterbodyMatchesLake(), a
 * bidirectional substring test, against the raw ramp feeds. Counted 2026-08-16, the feeds use
 * NINETEEN different waterbody names for J. Strom Thurmond alone -- "Clarks Hill Lake",
 * "Lake Thurmond", "Little River - Clarks Hill Lake", "Savannah River - Lake J. Strom
 * Thurmond" and fifteen more -- and not one of them is a substring of, or contains,
 * "j strom thurmond reservoir lincoln co ga sc". Hence "ramps: 0" on a 41,000-acre reservoir.
 *
 * consolidate_lake_index.py already solved this BY GEOMETRY and wrote the answer into
 * lake_index.json: 168 ramps across three feeds, correctly attributed. The Worker was
 * re-deriving a join the pipeline had already done, by the weaker method, and losing.
 *
 * So the client sends what it knows, exactly as it now does for `names` and `county`. Same
 * reason handleConditions asks for lat/lon: the Worker has no registry.
 */
function registryRampsFor(lakeName) {
  const rec = lakeRecordFor(lakeName);
  const buckets = rec && rec.ramps;
  if (!buckets) return null;
  const out = [];
  const seen = new Set();
  // dnr first: it is the bucket carrying lanes, dock, county and owner, and a later duplicate
  // from a thinner feed must not displace it.
  for (const key of ['dnr', 'natl', 'dnr_paddle', 'curated', 'osm']) {
    for (const r of (buckets[key] || [])) {
      if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
      const k = `${Math.round(r.lat * 1e5)}|${Math.round(r.lon * 1e5)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        name: r.name, lat: r.lat, lon: r.lon,
        lanes: r.meta?.lanes ?? null, county: r.meta?.county ?? null,
        owner: r.meta?.owner ?? null, type: r.type || null,
        species: r.species || r.meta?.species || null,
        source: r.src || key, waterbody: r.wb || null,
      });
    }
  }
  return out.length ? out : null;
}

async function runAgent(lakeName, agentKey, mode, callbacks = {}, _calledFromRunAgents = false, _contextResults = {}) {
  if (!_calledFromRunAgents && _state.researchInProgress) throw new Error('A research task is already in progress.');
  if (!lakeName) throw new Error('Select a lake first.');
  if (!AGENT_DEFINITIONS[agentKey]) throw new Error(`Unknown agent: ${agentKey}`);

  const def = AGENT_DEFINITIONS[agentKey];

  if (!_calledFromRunAgents) {
    _state.researchInProgress = true;
    _state.researchLog = [];
    _state.packagePartsCache = {};
    const _logEl = document.getElementById('researchLog');
    if (_logEl) _logEl.textContent = '';
    showProgress(true);
  }

  log(`=== RUN AGENT: ${def.label} (${mode}) ===`);

  try {
    const stateName = sanitizeStateFromLakeName(lakeName);
    const baseName = cleanLakeBaseName(lakeName);

    let previousResults = {};
    if (_state.deterministicProfile) {
      previousResults = {
        ...(_state.deterministicProfile),
        reservoirOwner: _state.deterministicProfile?.identity?.reservoirOwner || null,
        predatorSpecies: _state.deterministicProfile?.biology?.predatorSpecies || [],
      };
    }

    // Agents may depend on the output of an earlier agent. In particular,
    // fisheries must receive biology.predatorSpecies; the multi-agent runner
    // intentionally starts independent agents in parallel, so merge the
    // completed dependency context before discovery and LLM enrichment.
    if (_contextResults && Object.keys(_contextResults).length) {
      previousResults = { ...previousResults, ..._contextResults };
    }

    // The identity agent's resume-mode reload lived here: it fetched the saved profile so the LLM
    // would see the geometry-derived depths and not replace them with training-data ones. With the
    // agent retired there is no LLM to protect them from -- deterministic.js writes the one field
    // that has a reader and the chartpack writes the depths.

    // When fisheries runs without biology in the same batch (e.g. resume on
    // fisheries only), load the saved profile's species list so the LLM has
    // the correct predatorSpecies to generate trollingIntelligence sections.
    if (agentKey === 'fisheries' && !previousResults.biology?.predatorSpecies?.length) {
      try {
        const savedRes = await fetch(`${CF_WORKER_URL}/research/get?lake=${encodeURIComponent(lakeName)}`);
        if (savedRes.ok) {
          const savedData = await savedRes.json();
          const savedBiology = savedData.profile?.biology || null;
          if (savedBiology?.predatorSpecies?.length) {
            previousResults = { ...previousResults, biology: savedBiology, predatorSpecies: savedBiology.predatorSpecies };
            log(`  [fisheries] Loaded ${savedBiology.predatorSpecies.length} species from saved profile for LLM context`);
          }
        }
      } catch (_) {
        // Same shape as the Worker's /lake-intel bug: a permanently failing fetch here degrades
        // every lake to 'not researched yet' with nothing anywhere saying so.
        console.warn(`[research] saved profile fetch failed:`, _ && _.message);
      }
    }

    // Summary runs after the profile has already been assembled and saved. It
    // should synthesize that saved profile plus the cached normalized documents
    // created by the other agents — not bail out just because there are no new
    // summary-specific search results.
    if (agentKey === 'summary') {
      try {
        const savedRes = await fetch(`${CF_WORKER_URL}/research/get?lake=${encodeURIComponent(lakeName)}`);
        if (savedRes.ok) {
          const savedData = await savedRes.json();
          const savedProfile = savedData.profile || null;
          if (savedProfile) {
            previousResults = {
              ...previousResults,
              ...savedProfile,
              identity: savedProfile.identity || previousResults.identity || {},
              biology: savedProfile.biology || previousResults.biology || {},
              limnology: savedProfile.limnology || previousResults.limnology || {},
              habitat: savedProfile.habitat || previousResults.habitat || {},
              navigation: savedProfile.navigation || previousResults.navigation || {},
              regulations: savedProfile.regulations || previousResults.regulations || {},
              trollingIntelligence: savedProfile.trollingIntelligence || previousResults.trollingIntelligence || null,
              _extractedFacts: savedProfile._extractedFacts || previousResults._extractedFacts || [],
            };
            log(`  [summary] Loaded saved profile context (facts=${previousResults._extractedFacts?.length || 0}, sources=${savedProfile.sources?.length || 0})`);
          }
        }
      } catch (e) {
        log(`  ⚠️ [summary] Could not load saved profile context: ${e.message}`);
      }
    }

    // ── STEP 1: Discover sources for this agent ──────────────────────────────
    log(`  [${agentKey}] Discovering sources...`);
    let discoverRes;
    const coastalKeyForAgent = getCoastalR2Key(lakeName);
    // The registry's alias set travels with the request. The Worker has no registry, and the
    // agency-index resolver needs every name a state might have used: SCDNR says "Lake
    // Thurmond" where the registry says "J. Strom Thurmond Reservoir", TWRA says "Ft. Loudoun
    // Reservoir" where it says "Fort Loudoun Lake".
    const recForNames = lakeRecordFor(lakeName);
    const discoverPayload = {
      lakeName, state: stateName, agent: agentKey,
      names: recForNames
        ? [recForNames.name, recForNames.displayName, ...(recForNames.legacyDisplayNames || [])]
            .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i)
        : [lakeName],
      county: recForNames ? (recForNames.county || null) : null,
      reservoirOwner: previousResults.reservoirOwner || null,
      predatorSpecies: previousResults.predatorSpecies || [],
      ...(coastalKeyForAgent ? { zoneKey: coastalKeyForAgent, lakeKey: coastalKeyForAgent } : {}),
    };
    if (coastalKeyForAgent) {
      log(`  [${agentKey}] Coastal zone detected: ${coastalKeyForAgent} — using marine agent set`);
    }
    try {
      discoverRes = await fetch(`${CF_WORKER_URL}/research/discover`, {
        method: 'POST',
        headers: workerHeaders(),
        body: JSON.stringify(discoverPayload)
      });
    } catch (e) {
      log(`  ⚠️ [${agentKey}] Discovery network error (${e.message}) — retrying once`);
      await new Promise(resolve => setTimeout(resolve, 1500));
      try {
        discoverRes = await fetch(`${CF_WORKER_URL}/research/discover`, {
          method: 'POST',
          headers: workerHeaders(),
          body: JSON.stringify(discoverPayload)
        });
      } catch (retryErr) {
        throw new Error(`Discover network failed: ${retryErr.message}`);
      }
    }
    if (!discoverRes.ok) throw new Error(`Discover failed: ${discoverRes.status}`);
    const discoverData = await discoverRes.json();
    if (!discoverData.success) throw new Error(discoverData.error || 'Discovery failed');

    const sources = (discoverData.sources || []).filter(s => s.agentTags?.includes(agentKey) || !s.agentTags);
    const queryLog = discoverData.queryLog || [];
    queryLog.forEach(q => log(`  [discover] ${q}`));

    // Cap sources per agent — guaranteed seeds (priority=1) always pass regardless of cap.
    // Discovered sources sorted by prefetchScore descending, then capped.
    // Sources without prefetchScore get a default of 3 so they're not unfairly cut.
    const AGENT_SOURCE_CAPS = {
      identity: 8, limnology: 12, biology: 12, habitat: 8,
      navigation: 8, fisheries: 10, summary: 0,
      estuary: 8, tidal: 12,
    };
    const cap = AGENT_SOURCE_CAPS[agentKey] ?? 10;
    const guaranteed = sources.filter(s => s.priority === 1);
    const discovered = sources.filter(s => s.priority !== 1)
      .sort((a, b) => (b.prefetchScore ?? b.score ?? 3) - (a.prefetchScore ?? a.score ?? 3));
    const discoveryCap = Math.max(0, cap - guaranteed.length);
    const cappedSources = [...guaranteed, ...discovered.slice(0, discoveryCap)];
    if (agentKey === 'summary') {
      log(`  [summary] Found ${sources.length} new sources (${guaranteed.length} seeds + ${discovered.length} discovered); cached profile/docs are the primary summary corpus`);
    } else {
      log(`  [${agentKey}] Found ${sources.length} sources (${guaranteed.length} seeds + ${discovered.length} discovered) → capped to ${cappedSources.length}`);
    }

    if (!cappedSources.length && agentKey !== 'summary') {
      log(`  [${agentKey}] No sources — skipping`);
      return { success: true, agent: agentKey, section: {}, factsCount: 0, docsUsed: 0, queryLog };
    }
    if (!cappedSources.length && agentKey === 'summary') {
      log(`  [summary] No new summary-specific sources — using saved profile and cached normalized documents`);
    }

    // ── STEP 2: Load existing normalized docs from R2 (cache check) ──────────
    let existingDocs = [];
    if (mode === 'resume') {
      const normRes = await fetch(`${CF_WORKER_URL}/research/get-normalized?lake=${encodeURIComponent(lakeName)}`);
      if (normRes.ok) {
        const normData = await normRes.json();
        // Load ALL cached docs — agentTags filter was too strict, causing agents
        // like limnology to see 0 docs when their sources were tagged by a prior
        // identity or biology run. Prefer docs tagged for this agent, but fall
        // back to all docs so cross-agent cached content is available.
        const allDocs = normData.documents || [];
        const tagged = allDocs.filter(d => d.agentTags?.includes(agentKey));
        existingDocs = tagged.length > 0 ? tagged : allDocs;
        log(`  [${agentKey}] Resume: loaded ${existingDocs.length} cached docs${tagged.length === 0 && allDocs.length > 0 ? ' (no agent-tagged docs — using full cache)' : ''}`);
      }
    } else {
      const normRes = await fetch(`${CF_WORKER_URL}/research/get-normalized?lake=${encodeURIComponent(lakeName)}`);
      if (normRes.ok) {
        const normData = await normRes.json();
        existingDocs = normData.documents || [];
      }
    }

    const existingByUrl = new Map(existingDocs.map(d => [String(d.url || '').split('?')[0].toLowerCase(), d]));
    const TTL_MS = {
      academic: 365 * 24 * 60 * 60 * 1000,
      official:  90 * 24 * 60 * 60 * 1000,
      news:      30 * 24 * 60 * 60 * 1000,
      anecdotal: 14 * 24 * 60 * 60 * 1000,
    };
    function getDocTtl(url) {
      const u = String(url || '').toLowerCase();
      if (/seafwa|usgs|nepis|epa\.gov|asmfc|apms|\.edu/.test(u)) return TTL_MS.academic;
      if (/dnr\.sc\.gov|ncwildlife|georgiawildlife|tn\.gov|eregulations|ferc|santeecooper|usace/.test(u)) return TTL_MS.official;
      if (/news|report|stocking|annual|trends|freshwater\.html/.test(u)) return TTL_MS.news;
      return TTL_MS.anecdotal;
    }

    // ── STEP 3: Fetch each source (one Worker call per doc — stays fast) ──────
    const normalizedDocuments = [];
    const now = Date.now();

    // Summary is a synthesis pass. Reuse the normalized documents already
    // fetched by identity/limnology/biology/habitat/navigation/fisheries so the
    // summary has actual lake evidence even when it performs no new discovery.
    if (agentKey === 'summary' && mode !== 'resume') {
      const summaryDocs = existingDocs.filter(d => String(d.fullText || d.text || '').length >= 200);
      normalizedDocuments.push(...summaryDocs);
      log(`  [summary] Loaded ${summaryDocs.length} cached normalized docs for summary context`);
    } else if (mode === 'resume') {
      // Start with whatever is in the normalized cache
      // Filter to agent-tagged docs first, fall back to full cache if none
      const agentTagged = existingDocs.filter(d => d.agentTags?.includes(agentKey));
      const resumeDocs = agentTagged.length ? agentTagged : existingDocs;
      normalizedDocuments.push(...resumeDocs);

      if (agentTagged.length) {
        log(`  [${agentKey}] Resume: loaded ${resumeDocs.length} cached docs`);
      } else {
        log(`  [${agentKey}] Resume: loaded ${resumeDocs.length} cached docs (no agent-tagged docs — using full cache)`);
      }

      // Phase 2: For sources discovered but not in normalized cache, check shared registry
      // This covers the case where a full run failed mid-way and some agents never fetched
      const cachedUrls = new Set(normalizedDocuments.map(d => String(d.url || '').split('?')[0].toLowerCase()));
      let sharedHits = 0;
      const lakeSlug = lakeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

      for (const src of cappedSources) {
        const normUrl = String(src.url || '').split('?')[0].toLowerCase();
        if (cachedUrls.has(normUrl)) continue; // already have it
        if (!src.canonicalUrl) continue;

        try {
          const checkRes = await fetch(`${CF_WORKER_URL}/research/shared/check`, {
            method: 'POST', headers: workerHeaders(),
            body: JSON.stringify({ canonicalUrl: src.canonicalUrl })
          });
          if (!checkRes.ok) continue;
          const checkData = await checkRes.json();
          if (!checkData.found || checkData.document?.indexStatus === 'ambiguous') continue;

          // Pull relevant sections from shared registry
          const queryRes = await fetch(`${CF_WORKER_URL}/research/shared/query`, {
            method: 'POST', headers: workerHeaders(),
            body: JSON.stringify({ canonicalUrl: src.canonicalUrl, lakeSlug, categories: [agentKey] })
          });
          if (!queryRes.ok) continue;
          const queryData = await queryRes.json();
          if (!queryData.text || queryData.text.length < 200) continue;

          const doc = {
            title: checkData.document.title || src.title,
            url: src.url,
            fullText: queryData.text,
            agentTags: [agentKey],
            discoveredBy: agentKey,
            fetchedAt: checkData.document.fetchedAt,
            sharedDocId: checkData.document.id,
            sharedVersionId: checkData.document.versionId,
          };
          normalizedDocuments.push(doc);
          cachedUrls.add(normUrl);
          sharedHits++;
          log(`  📚 [${normalizedDocuments.length}] ${src.title?.slice(0, 70)} (shared registry, ${queryData.matchedSections} sections)`);
        } catch (_) {
          console.warn(`[research] shared check failed:`, _ && _.message);
        }
      }

      if (sharedHits > 0) {
        log(`  [${agentKey}] Resume: pulled ${sharedHits} additional docs from shared registry`);
      }
    } else {
      // ── STEP 3a: Separate cache hits, shared registry hits, and sources needing fetch ──
      const sourcesToFetch = [];
      const lakeSlug = lakeName.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');

      for (const src of cappedSources) {
        const normUrl = String(src.url || '').split('?')[0].toLowerCase();
        const existing = existingByUrl.get(normUrl);

        // Cache hit — reuse if fresh
        if (existing?.fetchedAt) {
          const age = now - new Date(existing.fetchedAt).getTime();
          if (age < getDocTtl(src.url)) {
            log(`  [${agentKey}] cache hit: ${src.title?.slice(0, 60)}`);
            normalizedDocuments.push({ ...existing, agentTags: [...new Set([...(existing.agentTags || []), agentKey])] });
            continue;
          }
        }

        // Phase 2: Check shared registry first
        let sharedDoc = null;
        if (src.canonicalUrl) {
          try {
            const checkRes = await fetch(`${CF_WORKER_URL}/research/shared/check`, {
              method: 'POST', headers: workerHeaders(),
              body: JSON.stringify({ canonicalUrl: src.canonicalUrl })
            });
            if (checkRes.ok) {
              const checkData = await checkRes.json();
              if (checkData.found && checkData.document?.indexStatus !== 'ambiguous') {
                sharedDoc = checkData.document;
              }
            }
          } catch (_) {
            console.warn(`[research] shared check failed:`, _ && _.message);
          }
        }

        if (sharedDoc) {
          try {
            const queryRes = await fetch(`${CF_WORKER_URL}/research/shared/query`, {
              method: 'POST', headers: workerHeaders(),
              body: JSON.stringify({ canonicalUrl: src.canonicalUrl, lakeSlug, categories: [agentKey] })
            });
            if (queryRes.ok) {
              const queryData = await queryRes.json();
              if (queryData.text && queryData.text.length > 200) {
                const doc = {
                  title: sharedDoc.title || src.title, url: src.url, fullText: queryData.text,
                  agentTags: src.agentTags || [agentKey], discoveredBy: agentKey,
                  fetchedAt: sharedDoc.fetchedAt, sharedDocId: sharedDoc.id, sharedVersionId: sharedDoc.versionId,
                };
                normalizedDocuments.push(doc);
                existingByUrl.set(normUrl, doc);
                log(`  📚 [${normalizedDocuments.length}] ${src.title?.slice(0, 70)} (shared registry, ${queryData.matchedSections} sections)`);
                continue;
              }
            }
          } catch (_) {
            console.warn(`[research] shared query failed:`, _ && _.message);
          }
          // Fall through to real fetch if shared query fails
        }

        // Skip URLs that already failed (502/timeout) in a prior agent this run
        if (_state.failedUrlsThisRun.has(src.url)) {
          log(`  ⏭️ Skipping known-failed URL: ${src.title?.slice(0, 60)}`);
          continue;
        }

        // Queue for batch or individual fetch
        sourcesToFetch.push(src);
      }

      // ── STEP 3b: Batch fetch HTML sources via TinyFish (up to 10 per call) ──
      // PDFs, NEPIS, and special domains are fetched individually below.
      const isPdfUrl = (u, t) => (t || '').toUpperCase() === 'PDF' || /\.pdf(?:$|[?#])/i.test(u || '');
      const isSpecialUrl = (u) => /nepis\.epa\.gov|ZyNET\.exe|wateratlas\.usf\.edu/i.test(u || '');

      const batchSources = sourcesToFetch.filter(s => !isPdfUrl(s.url, s.type) && !isSpecialUrl(s.url));
      const individualSources = sourcesToFetch.filter(s => isPdfUrl(s.url, s.type) || isSpecialUrl(s.url));

      const BATCH_SIZE = 10;
      for (let i = 0; i < batchSources.length; i += BATCH_SIZE) {
        const batch = batchSources.slice(i, i + BATCH_SIZE);
        const batchPayload = batch.map(s => ({ url: s.url, canonicalUrl: s.canonicalUrl || s.url, title: s.title, type: s.type || 'HTML' }));

        try {
          const batchRes = await fetch(`${CF_WORKER_URL}/research/proxy-download-batch`, {
            method: 'POST',
            headers: workerHeaders(),
            body: JSON.stringify({ urls: batchPayload })
          });

          if (batchRes.ok) {
            const batchData = await batchRes.json();
            for (let j = 0; j < batch.length; j++) {
              const src = batch[j];
              const result = batchData.results?.[j];
              const normUrl = String(src.url || '').split('?')[0].toLowerCase();

              if (result?.ok && result.text?.length > 200) {
                const doc = {
                  title: src.title, url: src.url, fullText: result.text,
                  agentTags: src.agentTags || [agentKey],
                  discoveredBy: agentKey,
                  fetchedAt: new Date().toISOString(),
                };
                normalizedDocuments.push(doc);
                existingByUrl.set(normUrl, doc);
                log(`  📄 [${normalizedDocuments.length}] ${src.title?.slice(0, 70)} (${result.source})`);

                // Store in shared registry fire-and-forget
                if (src.canonicalUrl) {
                  fetch(`${CF_WORKER_URL}/research/shared/store`, {
                    method: 'POST', headers: workerHeaders(),
                    body: JSON.stringify({
                      canonicalUrl: src.canonicalUrl, requestedUrl: src.url,
                      title: src.title, fullText: result.text,
                      authority: src.authority || 'unknown', fetchProvider: result.source,
                    })
                  }).catch(() => {});
                }
              } else if (result?.reason === 'unhandled') {
                // Batch classified as special — move to individual queue
                individualSources.push(src);
              } else {
                _state.failedUrlsThisRun.add(src.url);
                log(`  ⚠️ Batch fetch failed for ${src.title?.slice(0, 60)}: ${result?.error || 'no content'}`);
              }
            }
          }
        } catch (batchErr) {
          log(`  ⚠️ Batch fetch error: ${batchErr.message} — falling back to individual fetches`);
          individualSources.push(...batch);
        }
      }

      // ── STEP 3c: Individual fetches for PDFs, NEPIS, and batch fallbacks ──
      for (const src of individualSources) {
        const normUrl = String(src.url || '').split('?')[0].toLowerCase();
        try {
          const proxyRes = await fetch(
            `${CF_WORKER_URL}/research/proxy-download?url=${encodeURIComponent(src.url)}&type=${src.type || 'HTML'}`
          );
          if (proxyRes.ok) {
            const xSource = proxyRes.headers?.get('X-Source') || 'unknown';
            const contentType = proxyRes.headers?.get('Content-Type') || '';
            const isPdf = /application\/pdf/i.test(contentType)
              || (!contentType && (src.type === 'PDF' || /\.pdf(?:$|[?#])/i.test(src.url || '')));
            const text = isPdf
              ? (await extractTextFromPDFBytes(await proxyRes.arrayBuffer())).fullText
              : await proxyRes.text();
            if (text && text.length > 200) {
              const doc = {
                title: src.title, url: src.url, fullText: text,
                agentTags: src.agentTags || [agentKey],
                discoveredBy: agentKey,
                fetchedAt: new Date().toISOString(),
              };
              normalizedDocuments.push(doc);
              existingByUrl.set(normUrl, doc);
              log(`  📄 [${normalizedDocuments.length}] ${src.title?.slice(0, 70)} (${isPdf ? 'pdf.js via ' : ''}${xSource})`);

              // Store in shared registry fire-and-forget
              if (src.canonicalUrl) {
                fetch(`${CF_WORKER_URL}/research/shared/store`, {
                  method: 'POST', headers: workerHeaders(),
                  body: JSON.stringify({
                    canonicalUrl: src.canonicalUrl, requestedUrl: src.url,
                    title: src.title, fullText: text,
                    authority: src.authority || 'unknown', fetchProvider: xSource,
                  })
                }).catch(() => {});
              }
            } else {
              _state.failedUrlsThisRun.add(src.url);
              log(`  ⚠️ Insufficient content for ${src.title?.slice(0, 60)} (${text?.length || 0} chars)`);
            }
          }
        } catch (e) {
          _state.failedUrlsThisRun.add(src.url);
          log(`  ⚠️ Fetch failed for ${src.title?.slice(0, 60)}: ${e.message}`);
        }
      }

      // Save normalized docs back to R2 (merge with untouched docs)
      if (normalizedDocuments.length) {
        const updatedUrls = new Set(normalizedDocuments.map(d => String(d.url || '').split('?')[0].toLowerCase()));
        const untouched = existingDocs.filter(d => !updatedUrls.has(String(d.url || '').split('?')[0].toLowerCase()));
        const merged = [...untouched, ...normalizedDocuments];
        // THE GATE RUNS HERE NOW. The Worker is on the free plan -- 10 ms of CPU, not
        // raisable -- and parsing this payload to filter it does not fit. The browser has the
        // documents and no CPU ceiling; the Worker has the R2 credential and should only
        // write bytes. It streams the body straight into the bucket without reading it.
        const prepared = prepareNormalizedDocuments(merged, lakeName, []);
        if (prepared.rejected) {
          log(`  [${agentKey}] ${prepared.rejected} off-lake doc(s) of ${prepared.total} dropped before upload`);
        }
        const saveRes = await fetch(`${CF_WORKER_URL}/research/save-normalized`
          + `?lake=${encodeURIComponent(lakeName)}`
          + `&n=${prepared.documents.length}&rejected=${prepared.rejected}`, {
          method: 'POST',
          headers: workerHeaders(),
          body: JSON.stringify(prepared.documents)
        });
        if (!saveRes.ok) log(`  ⚠️ [${agentKey}] save-normalized ${await workerFailureReason(saveRes)}`);
      }
    }

    if (!normalizedDocuments.length) {
      log(`  [${agentKey}] No documents fetched — running LLM with deterministic context only`);
    }

    // ── STEP 4: Extract facts (one Worker call, fast) ─────────────────────────
    let uniqueFacts = [];
    if (agentKey === 'summary') {
      uniqueFacts = Array.isArray(previousResults._extractedFacts) ? previousResults._extractedFacts.slice(0, 250) : [];
      log(`  [summary] Using ${normalizedDocuments.length} cached docs and ${uniqueFacts.length} existing extracted facts for LLM context (no re-extraction)`);
    } else if (normalizedDocuments.length > 0) {
      log(`  [${agentKey}] Extracting facts from ${normalizedDocuments.length} docs...`);
      try {
        // ── ONE REQUEST PER PAIR OF DOCUMENTS, NOT TWELVE IN ONE ────────────────
        //
        // From wrangler tail, 2026-08-16 11:54, verbatim:
        //
        //     POST /research/analyze-facts - Exceeded CPU Limit
        //     ✘ [ERROR] Error: Worker exceeded CPU time limit.
        //
        // and the same on /research/save-normalized and /research/shared/store. Not a rate
        // limit, not memory, not CORS -- Ryan said a 429 would look like a 429 and he was
        // right. It is CPU, and the arithmetic was already on the page: 12 documents by
        // 150,000 characters is 1.8 MB of JSON to parse, scan and re-serialise in one request.
        //
        // NOTHING IS LOST BY SPLITTING IT. extract.js loops the documents and builds ONE LLM
        // prompt PER DOCUMENT -- the batch was never doing joint work, only arriving together.
        // The same text, the same prompts, ~150 KB of parsing per request instead of 1.8 MB.
        // One document per request: 10 ms of CPU does not stretch to parsing two 150,000
        // character documents plus the JSON around them.
        const ANALYZE_BATCH = 1;
        const analyzeDocs = normalizedDocuments.slice(0, 12).map(d => ({
          title: d.title, url: d.url || '',
          text: (d.fullText || '').slice(0, 150000)
        }));
        const batches = [];
        for (let i = 0; i < analyzeDocs.length; i += ANALYZE_BATCH) batches.push(analyzeDocs.slice(i, i + ANALYZE_BATCH));
        const collectedFacts = [];
        let analyzeOk = false;
        for (const [bi, batch] of batches.entries()) {
          const res = await fetch(`${CF_WORKER_URL}/research/analyze-facts`, {
            method: 'POST',
            headers: workerHeaders(),
            body: JSON.stringify({
              lakeName, baseName, state: stateName,
              zoneKey: coastalKeyForAgent || undefined,
              docIndex: bi * ANALYZE_BATCH,
              documents: batch,
            })
          });
          if (res.ok) {
            analyzeOk = true;
            const d = await res.json();
            collectedFacts.push(...(d.extracted_facts || []));
          } else {
            // Per batch, so one oversized document does not take the other eleven with it.
            log(`  ⚠️ [${agentKey}] analyze-facts batch ${bi + 1}/${batches.length} ${await workerFailureReason(res)}`);
          }
        }
        const analyzeRes = { ok: analyzeOk, json: async () => ({ extracted_facts: collectedFacts }) };
        if (analyzeRes.ok) {
          const analyzeData = await analyzeRes.json();
          const rawFacts = analyzeData.extracted_facts || [];

          // ── STEP 5: Deduplicate facts ─────────────────────────────────────────
          if (rawFacts.length > 0) {
            try {
              const dedupeRes = await fetch(`${CF_WORKER_URL}/research/dedupe-contradictions`, {
                method: 'POST',
                headers: workerHeaders(),
                body: JSON.stringify({ facts: rawFacts })
              });
              if (dedupeRes.ok) {
                const dedupeData = await dedupeRes.json();
                uniqueFacts = dedupeData.deduplicated_facts || rawFacts;
              } else {
                uniqueFacts = rawFacts;
              }
            } catch (dedupeErr) {
              log(`  ⚠️ Dedupe failed — using raw facts: ${dedupeErr.message}`);
              uniqueFacts = rawFacts;
            }
            log(`  [${agentKey}] ${uniqueFacts.length} facts extracted`);
            // Per-doc breakdown — how many facts each document contributed
            const factsByDoc = {};
            for (const f of uniqueFacts) {
              const src = String(f.source || '').slice(0, 50);
              factsByDoc[src] = (factsByDoc[src] || 0) + 1;
            }
            const docEntries = Object.entries(factsByDoc).sort((a,b) => b[1]-a[1]);
            docEntries.forEach(([src, count]) => log(`  📊 ${count} fact${count>1?'s':''}: ${src}`));
            uniqueFacts.slice(0, 5).forEach(f => log(`  💬 [${f.category}] ${String(f.fact || '').slice(0, 80)}`));
          }
        } else {
          log(`  ⚠️ [${agentKey}] analyze-facts ${await workerFailureReason(analyzeRes)} — continuing with 0 facts`);
        }
      } catch (analyzeErr) {
        log(`  ⚠️ [${agentKey}] analyze-facts failed: ${analyzeErr.message} — continuing with 0 facts`);
      }
    }

    // Species trace: keep the evidence handoff visible in the in-app research
    // log. This is intentionally done here rather than relying on DevTools
    // Network inspection, which can pause the pipeline in some browsers.
    if (agentKey === 'biology') {
      const speciesFacts = uniqueFacts.filter(f =>
        /predatorSpecies|speciesAbundance|stocking/i.test(String(f.category || '')) ||
        /\b(muskellunge|muskie|walleye|pickerel|perch|catfish|crappie|bass|bluegill|bowfin)\b/i.test(String(f.fact || ''))
      );
      if (speciesFacts.length) {
        log(`  [biology] Species evidence sent to LLM (${speciesFacts.length} facts):`);
        speciesFacts.forEach(f => log(`    • [${f.category}] ${String(f.fact || '').slice(0, 220)} — source: ${String(f.source || '').slice(0, 80)}`));
      } else {
        log('  [biology] Species evidence sent to LLM: NONE');
      }
    }

    // ── STEP 6: LLM enrichment (one Worker call, fast) ───────────────────────
    log(`  [${agentKey}] Running LLM enrichment...`);
    const llmDocLimit = agentKey === 'fisheries' ? 25 : agentKey === 'summary' ? 10 : 12;
    const llmDocChars = agentKey === 'fisheries' ? 150000 : agentKey === 'summary' ? 12000 : 40000;
    const agentRes = await fetch(`${CF_WORKER_URL}/research/agent-llm`, {
      method: 'POST',
      headers: workerHeaders(),
      body: JSON.stringify({
        lakeName, state: stateName,
        agent: agentKey,
        previousResults: {
          ...previousResults,
          _extractedFacts: uniqueFacts,
          _normalizedDocuments: normalizedDocuments.slice(0, llmDocLimit).map(d => ({
            title: d.title, url: d.url,
            text: (d.fullText || d.text || '').slice(0, llmDocChars)
          }))
        }
      })
    });

    if (!agentRes.ok) {
      // Retry once on 502
      if (agentRes.status === 502) {
        log(`  ⚠️ ${def.label} LLM 502: ${await workerFailureReason(agentRes)} — retrying after 5s...`);
        await new Promise(r => setTimeout(r, 5000));
        const retry = await fetch(`${CF_WORKER_URL}/research/agent-llm`, {
          method: 'POST',
          headers: workerHeaders(),
          body: JSON.stringify({
            lakeName, state: stateName, agent: agentKey,
            previousResults: {
              ...previousResults,
              _extractedFacts: uniqueFacts,
              _normalizedDocuments: normalizedDocuments.slice(0, llmDocLimit).map(d => ({
                title: d.title, url: d.url,
                text: (d.fullText || d.text || '').slice(0, llmDocChars)
              }))
            }
          })
        });
        if (!retry.ok) throw new Error(`Agent ${agentKey} LLM failed on retry: ${await workerFailureReason(retry)}`);
        const retryData = await retry.json();
        if (!retryData.success) throw new Error(retryData.error || 'Agent LLM failed');
        log(`✔ ${def.label} agent complete (${uniqueFacts.length} facts, ${normalizedDocuments.length} docs)`);
        if (callbacks.onComplete) await callbacks.onComplete(lakeName);
        return { ...retryData, _extractedFacts: uniqueFacts, factsCount: uniqueFacts.length, docsUsed: normalizedDocuments.length, queryLog };
      }
      throw new Error(`Agent ${agentKey} LLM failed: ${await workerFailureReason(agentRes)}`);
    }

    const agentData = await agentRes.json();
    if (!agentData.success) throw new Error(agentData.error || 'Agent LLM failed');

    if (agentKey === 'biology') {
      const returnedSpecies = agentData.section?.predatorSpecies || [];
      const inputSpecies = previousResults.biology?.predatorSpecies || [];
      const addedSpecies = returnedSpecies.filter(s => !inputSpecies.some(i => String(i).toLowerCase() === String(s).toLowerCase()));
      log(`  [biology] LLM returned predator species (${returnedSpecies.length}): ${returnedSpecies.join(', ') || 'NONE'}`);
      log(`  [biology] LLM-added species beyond deterministic input: ${addedSpecies.join(', ') || 'NONE'}`);
    }

    // AN AGENT'S OWN WARNINGS REACH THE LOG BEFORE ITS TICK DOES.
    //
    // The fisheries agent splits its species into groups and runs a call per group, and a group
    // that returns nothing merges into nothing. On 2026-08-10 the bass group came back empty --
    // taking Largemouth, White Bass/Hybrid and Striped Bass with it -- and the run printed
    // "✔ Species Intelligence agent complete (59 facts, 10 docs)" and then "✔ All agents
    // complete: 1/1 succeeded". Ryan found it by noticing the species were gone from the card.
    //
    // The Worker knew. It console.warn'd into a log nobody opens. Anything an agent reports as a
    // warning is printed here, above the success line, so a run that quietly lost a quarter of
    // the lake cannot look like a clean one.
    for (const w of (agentData.warnings || [])) log(`  ⚠️ [${agentKey}] ${w}`);

    log(`✔ ${def.label} agent complete (${uniqueFacts.length} facts, ${normalizedDocuments.length} docs)`);
    if (callbacks.onComplete) await callbacks.onComplete(lakeName);
    return { ...agentData, _extractedFacts: uniqueFacts, factsCount: uniqueFacts.length, docsUsed: normalizedDocuments.length, queryLog };

  } catch (e) {
    log(`❌ ${def.label} agent failed: ${e.message}`);
    if (!_calledFromRunAgents) setProgress('Agent failed — see log.', 0);
    throw e;
  } finally {
    if (!_calledFromRunAgents) _state.researchInProgress = false;
  }
}

// ── runAgents: Execute multiple agents in parallel (max 2 concurrent, 2s stagger) ──
// After all agents complete, assembles and saves the profile then fires callbacks.
// Summary agent always runs last (needs all other sections as context).
async function runAgents(lakeName, agentKeys, mode, callbacks = {}) {
  if (_state.researchInProgress) { alert('A research task is already in progress.'); return; }
  if (!lakeName) { alert('Please select a lake first.'); return; }
  if (!agentKeys?.length) { alert('No agents selected.'); return; }

  _state.researchInProgress = true;
  _state.packagePartsCache = {};
  _state.failedUrlsThisRun = new Set();
  // Only reset wqpLimnology for standalone runAgents calls (resume mode).
  // When called from runFullPipeline, wqpLimnology is already populated by Step 1d — don't clobber it.
  if (mode === 'resume') _state.wqpLimnology = null;
  showProgress(true);

  // ── Resume mode: reload deterministic facts so ramps, species, regulations,
  //    and geospatial structure are fresh. In full-pipeline mode these are
  //    already loaded by runFullPipeline Step 1b/1c — don't reload them.
  if (mode === 'resume') {
    _state.deterministicProfile = null;
    try {
      const stateName = sanitizeStateFromLakeName(lakeName);
      const coastalKeyResume = getCoastalR2Key(lakeName);
      const detRes = await fetch(`${CF_WORKER_URL}/research/deterministic-facts`, {
        method: 'POST', headers: workerHeaders(),
        body: JSON.stringify({
          lakeName, state: stateName,
          ramps: registryRampsFor(lakeName),
          county: lakeRecordFor(lakeName)?.county || null,
          ...(coastalKeyResume ? { zoneKey: coastalKeyResume, lakeKey: coastalKeyResume } : {})
        })
      });
      if (coastalKeyResume) log(`🌊 Coastal zone ${coastalKeyResume} detected for deterministic facts (resume)`);
      if (detRes.ok) {
        const detData = await detRes.json();
        if (detData.ok && detData.profile) {
          _state.deterministicProfile = detData.profile;
          const owner = detData.profile.identity?.reservoirOwner || 'unknown';
          const ramps = detData.profile.navigation?.ramps?.length || 0;
          const species = detData.profile.biology?.predatorSpecies?.length || 0;
          const genCreel = Object.keys(detData.profile.regulations?.generalStateRegulations?.creelLimits || {}).length;
          const genLen   = Object.keys(detData.profile.regulations?.generalStateRegulations?.lengthLimits || {}).length;
          const lakeSize = Object.keys(detData.profile.regulations?.lakeSpecificRegulations?.sizeLimits || {}).length;
          const lakeCreel= Object.keys(detData.profile.regulations?.lakeSpecificRegulations?.creelLimits || {}).length;
          log(`✔ Deterministic baseline loaded — owner: ${owner}, ramps: ${ramps}, species: ${species}, regs(gen creel=${genCreel}/len=${genLen}, lake size=${lakeSize}/creel=${lakeCreel})`);
        }
      } else {
        log(`⚠️ Deterministic facts HTTP ${detRes.status} — continuing without context`);
      }
    } catch (e) { log(`⚠️ Deterministic facts failed: ${e.message}`); }

    // Geospatial structure adapter (habitat structure + geometry-derived identity facts)
    try {
      const geoStruct = await deriveGeospatialStructureFacts(lakeName);
      if (geoStruct && _state.deterministicProfile) {
        if (geoStruct.habitat) {
          _state.deterministicProfile.habitat = mergeMissing(_state.deterministicProfile.habitat || {}, geoStruct.habitat);
          if (geoStruct.habitat.notes) {
            _state.deterministicProfile.habitat.notes = [_state.deterministicProfile.habitat.notes, geoStruct.habitat.notes].filter(Boolean).join(' ');
          }
        }
        if (geoStruct.identity) {
          const id = _state.deterministicProfile.identity = _state.deterministicProfile.identity || {};
          for (const k of ['surfaceAreaAcres', 'maxDepthFt', 'averageDepthFt']) {
            if (geoStruct.identity[k] != null) id[k] = geoStruct.identity[k];
          }
          id._geometryDerived = true;
          id._bathymetryMeta = geoStruct.identity._bathymetryMeta || null;
          if (geoStruct.depthStats?.ok) {
            const covLabel = geoStruct.depthStats._rawCoverage != null
              ? `raw coverage ${(geoStruct.depthStats._rawCoverage*100).toFixed(0)}%`
              : `coverage ${(geoStruct.depthStats.coverage*100).toFixed(0)}%`;
            log(`✔ Geometry-derived bathymetry — max ${geoStruct.depthStats.maxDepthFt} ft, avg ${geoStruct.depthStats.averageDepthFt} ft, area ${geoStruct.depthStats.surfaceAreaAcres != null ? geoStruct.depthStats.surfaceAreaAcres + " ac" : "N/A"} (${covLabel})`);
            if (geoStruct.depthStats._bandOverlapWarning) {
              log(`  ⚠️ ${geoStruct.depthStats._bandOverlapWarning}`);
            }
          } else if (geoStruct.depthStats?.maxDepthFt) {
            log(`✔ Geometry-derived max depth ${geoStruct.depthStats.maxDepthFt} ft (polygon coverage ${Math.round((geoStruct.depthStats.coverage||0)*100)}% — avg depth not trusted)`);
          }
        }
        _state.deterministicProfile.evidence = mergeEvidenceMaps(_state.deterministicProfile.evidence || {}, geoStruct.evidence || {});
        _state.deterministicProfile.sources  = [...(_state.deterministicProfile.sources || []), ...(geoStruct.sources || [])];
        const structKeys = Object.keys(geoStruct.habitat?.structuralElements || {}).join(', ') || 'no structural fields';
        log(`✔ Geospatial structure adapter loaded — ${structKeys}`);
      }
    } catch (e) { log(`⚠️ Geospatial structure failed: ${e.message}`); }
  }

  // WQP limnology — runs on both full and resume when limnology is selected.
  // runFullPipeline also runs this in Step 1d; runAgents handles the resume case.
  if (mode === 'resume' && agentKeys.includes('limnology')) {
    setProgress('WQP limnology data...', 5);
    await fetchWqpLimnology(lakeName);
  }

  // ── Dynamic order / waves based on freshwater vs coastal ─────────────────
  const coastalForRun = isCoastalLake(lakeName);
  const effectiveOrder = coastalForRun ? COASTAL_RESEARCH_ORDER : FRESHWATER_RESEARCH_ORDER;
  if (coastalForRun) {
    log(`🌊 Coastal zone ${getCoastalR2Key(lakeName)} detected — using marine agent set [${effectiveOrder.join(', ')}]`);
  }

  // Summary always runs last — separate it from the parallel batch
  const hasSummary = agentKeys.includes('summary');
  let parallelAgents = agentKeys.filter(k => k !== 'summary');
  // Always sort agents by canonical order (freshwater or coastal) so dependencies are respected
  parallelAgents = parallelAgents.sort((a, b) => {
    const ai = effectiveOrder.indexOf(a);
    const bi = effectiveOrder.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  const total = agentKeys.length;
  let completed = 0;
  log(`=== RUN AGENTS: [${agentKeys.join(', ')}] (${mode}) ===`);

  const results = [];
  // Wave structure freshwater:
  //   Wave1: identity, limnology, habitat, navigation
  //   Wave2: biology → fisheries (serial)
  // Wave structure coastal (per COASTAL_IMPLEMENTATION_NOTES §5):
  //   Wave1: estuary (replaces identity), tidal (replaces limnology), habitat, navigation
  //   Wave2: biology, fisheries (shared, with coastal hints)
  // `regulations` and `saltwater_regulations` were the fifth member of each wave and are retired;
  // the digest is parsed live and its closures are what checkRegulations() reads.
  const FRESH_WAVE1 = ['limnology', 'habitat', 'navigation'];
  const COASTAL_WAVE1 = ['habitat', 'navigation'];
  const WAVE1_AGENTS = coastalForRun ? COASTAL_WAVE1 : FRESH_WAVE1;
  const WAVE2_AGENTS = ['biology', 'fisheries'];
  const wave1 = parallelAgents.filter(k => WAVE1_AGENTS.includes(k));
  const wave2 = parallelAgents.filter(k => WAVE2_AGENTS.includes(k));
  // Any unknown agents run in wave 1
  const unknownAgents = parallelAgents.filter(k => !WAVE1_AGENTS.includes(k) && !WAVE2_AGENTS.includes(k));
  const wave1All = [...wave1, ...unknownAgents];

  const runAgentSafe = async (agentKey, dependencyContext = {}) => {
    try {
      const result = await runAgent(lakeName, agentKey, mode, {}, true, dependencyContext);
      completed++;
      setProgress(`[${completed}/${total}] ${RESEARCH_LABELS[agentKey] || agentKey} complete`, Math.round((completed / total) * 80));
      return { status: 'fulfilled', value: result, agent: agentKey };
    } catch (e) {
      completed++;
      log(`❌ ${agentKey} failed: ${e.message}`);
      return { status: 'rejected', reason: e, agent: agentKey };
    }
  };

  try {
    // Wave 1 — all independent agents fire simultaneously
    if (wave1All.length > 0) {
      log(`[runAgents] Wave 1 concurrent: [${wave1All.join(', ')}]`);
      // 500ms stagger between agents to avoid RPM spikes on Gemini free tier
      const wave1Results = await Promise.all(wave1All.map((k, i) =>
        new Promise(resolve => setTimeout(() => runAgentSafe(k).then(resolve), i * 500))
      ));
      for (const result of wave1Results) {
        if (result.status === 'fulfilled') results.push({ agent: result.agent, data: result.value });
      }
    }

    // Wave 2 — biology then fisheries, strictly serial
    if (wave2.length > 0) {
      log(`[runAgents] Wave 2 serial: [${wave2.join(', ')}]`);
      for (const agentKey of wave2) {
        const biologyResult = results.find(r => r.agent === 'biology')?.data;
        const dependencyContext = biologyResult?.section ? { biology: biologyResult.section } : {};
        const result = await runAgentSafe(agentKey, dependencyContext);
        if (result.status === 'fulfilled') results.push({ agent: result.agent, data: result.value });
      }
    }

    // Assemble + save profile from successful non-summary agent results. If all
    // selected work failed (e.g. biology discovery throws), do not create a new
    // profile version with agents=[] and facts=0.
    let assembleResult = { contradictions: [] };
    if (results.length > 0) {
      setProgress('Assembling and saving profile...', 82);
      try {
        assembleResult = await assembleAndSaveProfile(lakeName, results, mode);
      } catch (e) {
        log(`⚠️ Profile assembly failed: ${e.message}`);
      }
    } else {
      log('⚠️ No non-summary agents succeeded — skipping profile assembly/save');
    }

    // Summary agent runs last with the fully assembled profile as context
    if (hasSummary) {
      setProgress('Running summary agent...', 92);
      try {
        const summaryResult = await runAgent(lakeName, 'summary', mode, {}, true);
        completed++;
        results.push({ agent: 'summary', data: summaryResult });
        // Merge summary into the already-saved profile. Do not let an empty
        // summary response wipe the deterministic/profile summary that was just
        // saved during assembly.
        if (summaryResult?.section && hasResearchValue(summaryResult.section)) {
          const existingRes = await fetch(`${CF_WORKER_URL}/research/get?lake=${encodeURIComponent(lakeName)}`);
          if (existingRes.ok) {
            const existingData = await existingRes.json();
            if (existingData.profile) {
              const patched = { ...existingData.profile, summary: summaryResult.section };
              await fetch(`${CF_WORKER_URL}/research/save`, {
                method: 'POST', headers: workerHeaders(),
                body: JSON.stringify({ lakeName, profile: patched, status: patched.metadata?.status || 'draft', requestedBy: 'Summary agent patch' })
              });
              log('✔ Summary section merged into saved profile');
            }
          }
        } else {
          log('⚠️ Summary agent returned no usable section — keeping existing saved summary');
        }
      } catch (e) { log(`⚠️ Summary agent failed: ${e.message}`); }
    }

    log(`✔ All agents complete: ${results.filter(r => r.data).length}/${total} succeeded`);
    const finalLog = [...(_state.researchLog || [])];
    if (callbacks.onComplete) await callbacks.onComplete(lakeName);
    // Re-render log after loadProfile — it may have replaced the DOM element
    _state.researchLog = finalLog.length >= (_state.researchLog?.length || 0) ? finalLog : _state.researchLog;
    renderLog();
    if (assembleResult.contradictions?.length && callbacks.onContradictions) {
      callbacks.onContradictions(assembleResult.contradictions, lakeName);
    }
    return results;

  } catch (e) {
    log(`❌ Multi-agent run failed: ${e.message}`);
    setProgress('Multi-agent run failed — see log.', 0);
  } finally {
    _state.researchInProgress = false;
    showProgress(false);
  }
}


// ── runFullPipeline: Steps 1-1d, then delegates to runAgents ──────────────
async function runFullPipeline(lakeName, selectedAgents, callbacks = {}) {
  if (_state.researchInProgress) { alert('A research task or pipeline is already in progress.'); return; }
  if (!lakeName) { alert('Please select or specify a lake.'); return; }

  _state.researchInProgress = true;
  _state.researchLog = [];
  _state.packagePartsCache = {};
  _state.deterministicProfile = null;
  _state.wqpLimnology = null;
  showProgress(true);
  // Clear the DOM log element for fresh run
  const _logEl = document.getElementById('researchLog');
  if (_logEl) _logEl.textContent = '';

  try {
    const stateName = sanitizeStateFromLakeName(lakeName);
    log(`Resolving canonical lake details — ${lakeName} / ${stateName}`);

    // STEP 1b: Deterministic facts (owner, ramps, species, regulations from APIs)
    setProgress('Step 1b: Loading deterministic facts...', 10);
    try {
      const coastalKeyForDet = getCoastalR2Key(lakeName);
      const detRes = await fetch(`${CF_WORKER_URL}/research/deterministic-facts`, {
        method: 'POST', headers: workerHeaders(),
        body: JSON.stringify({
          lakeName, state: stateName,
          ramps: registryRampsFor(lakeName),
          county: lakeRecordFor(lakeName)?.county || null,
          ...(coastalKeyForDet ? { zoneKey: coastalKeyForDet, lakeKey: coastalKeyForDet } : {})
        })
      });
      if (coastalKeyForDet) log(`🌊 Coastal zone ${coastalKeyForDet} detected for deterministic facts`);
      if (detRes.ok) {
        const detData = await detRes.json();
        if (detData.ok && detData.profile) {
          _state.deterministicProfile = detData.profile;
          const owner = detData.profile.identity?.reservoirOwner || 'unknown';
          const ramps = detData.profile.navigation?.ramps?.length || 0;
          const species = detData.profile.biology?.predatorSpecies?.length || 0;
          const genCreel = Object.keys(detData.profile.regulations?.generalStateRegulations?.creelLimits || {}).length;
          const genLen   = Object.keys(detData.profile.regulations?.generalStateRegulations?.lengthLimits || {}).length;
          const lakeSize = Object.keys(detData.profile.regulations?.lakeSpecificRegulations?.sizeLimits || {}).length;
          const lakeCreel= Object.keys(detData.profile.regulations?.lakeSpecificRegulations?.creelLimits || {}).length;
          log(`✔ Deterministic baseline loaded — owner: ${owner}, ramps: ${ramps}, species: ${species}, regs(gen creel=${genCreel}/len=${genLen}, lake size=${lakeSize}/creel=${lakeCreel})`);
        }
      } else {
        log(`⚠️ Deterministic facts HTTP ${detRes.status} — continuing without context`);
      }
    } catch (e) { log(`⚠️ Deterministic facts failed: ${e.message}`); }

    // STEP 1c: Geospatial structure adapter (habitat structure + geometry-derived identity facts)
    setProgress('Step 1c: Geospatial structure...', 15);
    try {
      const geoStruct = await deriveGeospatialStructureFacts(lakeName);
      if (geoStruct && _state.deterministicProfile) {
        if (geoStruct.habitat) {
          _state.deterministicProfile.habitat = mergeMissing(_state.deterministicProfile.habitat || {}, geoStruct.habitat);
          if (geoStruct.habitat.notes) {
            _state.deterministicProfile.habitat.notes = [_state.deterministicProfile.habitat.notes, geoStruct.habitat.notes].filter(Boolean).join(' ');
          }
        }
        // Merge geometry-derived identity facts (maxDepthFt, averageDepthFt, surfaceAreaAcres).
        // These win over anything from LLM / search in the fact-precedence pass
        // because OFFICIAL_GIS evidence is higher trust than document extraction.
        if (geoStruct.identity) {
          const id = _state.deterministicProfile.identity = _state.deterministicProfile.identity || {};
          for (const k of ['surfaceAreaAcres', 'maxDepthFt', 'averageDepthFt']) {
            if (geoStruct.identity[k] != null) id[k] = geoStruct.identity[k];
          }
          id._geometryDerived = true;
          id._bathymetryMeta = geoStruct.identity._bathymetryMeta || null;
          if (geoStruct.depthStats?.ok) {
            const covLabel = geoStruct.depthStats._rawCoverage != null
              ? `raw coverage ${(geoStruct.depthStats._rawCoverage*100).toFixed(0)}%`
              : `coverage ${(geoStruct.depthStats.coverage*100).toFixed(0)}%`;
            log(`✔ Geometry-derived bathymetry — max ${geoStruct.depthStats.maxDepthFt} ft, avg ${geoStruct.depthStats.averageDepthFt} ft, area ${geoStruct.depthStats.surfaceAreaAcres != null ? geoStruct.depthStats.surfaceAreaAcres + " ac" : "N/A"} (${covLabel})`);
            if (geoStruct.depthStats._bandOverlapWarning) {
              log(`  ⚠️ ${geoStruct.depthStats._bandOverlapWarning}`);
            }
          } else if (geoStruct.depthStats?.maxDepthFt) {
            log(`✔ Geometry-derived max depth ${geoStruct.depthStats.maxDepthFt} ft (polygon coverage ${Math.round((geoStruct.depthStats.coverage||0)*100)}% — avg depth not trusted)`);
          }
        }
        _state.deterministicProfile.evidence = mergeEvidenceMaps(_state.deterministicProfile.evidence || {}, geoStruct.evidence || {});
        _state.deterministicProfile.sources  = [...(_state.deterministicProfile.sources || []), ...(geoStruct.sources || [])];
        const structKeys = Object.keys(geoStruct.habitat?.structuralElements || {}).join(', ') || 'no structural fields';
        log(`✔ Geospatial structure adapter loaded — ${structKeys}`);
      }
    } catch (e) { log(`⚠️ Geospatial adapter failed: ${e.message}`); }

    // STEP 1d: WQP limnology (only when limnology agent is in the run)
    if (!selectedAgents || selectedAgents.includes('limnology')) {
      setProgress('Step 1d: WQP limnology data...', 20);
      await fetchWqpLimnology(lakeName);
    }

    // Delegate to runAgents — each agent does per-agent discover→cache-check→fetch→extract→LLM
    // assembleAndSaveProfile runs after all agents finish inside runAgents
    _state.researchInProgress = false;
    await runAgents(lakeName, selectedAgents, 'full', callbacks);

  } catch (err) {
    log(`❌ Pipeline failed: ${err.message}`);
    alert(`Research Pipeline Failed: ${err.message}`);
    setProgress('Failed', 0);
    _state.researchInProgress = false;
  }
}

// ── assembleAndSaveProfile: merge agent results → save to R2 ─────────────
// Called by runAgents after all agents complete. Handles both full runs
// (all agents) and targeted runs (subset — loads existing R2 profile first
// so un-run sections are preserved).
async function assembleAndSaveProfile(lakeName, agentResults, mode) {
  const stateName = sanitizeStateFromLakeName(lakeName);
  const det = _state.deterministicProfile || { identity: {}, biology: {}, limnology: {}, habitat: {}, navigation: {}, regulations: {}, summary: {}, evidence: {}, sources: [] };
  const wqp = _state.wqpLimnology || null;

  // Load existing R2 profile so a targeted refresh doesn't wipe un-run sections
  let existingSavedProfile = {};
  try {
    const existingRes = await fetch(`${CF_WORKER_URL}/research/get?lake=${encodeURIComponent(lakeName)}`);
    if (existingRes.ok) {
      const existingData = await existingRes.json();
      if (existingData.profile) existingSavedProfile = existingData.profile;
    }
  } catch (e) {
    // Marked /* non-fatal */, and it is -- but a failure means the caller believes no profile
    // exists and starts a fresh research run over one already done.
    console.warn(`[research] existing-profile check failed:`, e && e.message);
    /* non-fatal */
  }

  // Retired fields are dropped before anything reads this profile, so a re-run of any agent
  // clears them rather than carrying them forward one more time.
  const droppedRetired = pruneRetiredFields(existingSavedProfile);
  if (droppedRetired.length) log('  \uD83E\uDDF9 dropped retired field(s): ' + droppedRetired.join(', '));

  // Saved profiles now include a nested identity section (with _geometryDerived
  // flag and _bathymetryMeta). For older profiles that only have flat fields,
  // reconstruct the identity object so resume runs don't wipe them.
  if (!existingSavedProfile.identity && existingSavedProfile.lakeName) {
    existingSavedProfile.identity = {
      surfaceAreaAcres:  existingSavedProfile.surfaceAreaAcres  ?? null,
      maxDepthFt:        existingSavedProfile.maxDepthFt        ?? null,
      averageDepthFt:    existingSavedProfile.averageDepthFt    ?? null,
      damName:           existingSavedProfile.damName           ?? null,
      yearImpounded:     existingSavedProfile.yearImpounded     ?? null,
      reservoirOwner:    existingSavedProfile.reservoirOwner    ?? null,
      county:            existingSavedProfile.county            ?? null,
      riverSystem:       existingSavedProfile.riverSystem       ?? null,
      archetype:         existingSavedProfile.archetype         ?? null,
      aliases:           existingSavedProfile.aliases           ?? [],
      gpsCenter:         existingSavedProfile.gpsCenter         ?? null,
    };
  }

  // Build section map — start from existing/deterministic, then layer in new agent results
  // For coastal zones we also preserve estuary/tidal/saltwaterRegulations sections
  const agentSections = {
    identity:             cloneJson(existingSavedProfile.identity     || det.identity     || {}),
    biology:              cloneJson(existingSavedProfile.biology       || det.biology      || {}),
    habitat:              cloneJson(existingSavedProfile.habitat      || det.habitat      || {}),
    // RAMPS ARE DETERMINISTIC AND THE SAVED PROFILE MUST NOT VETO THEM.
    //
    // `existingSavedProfile.navigation || det.navigation` short-circuits on the OBJECT
    // existing, not on it holding anything. Every profile saved before the ramp join worked
    // carries `navigation: { ramps: [] }`, so the object was truthy, det.navigation was never
    // consulted, and the 116 ramps the pipeline resolved by geometry never reached the file.
    // Thurmond v17 shipped `"ramps": []` beside evidence reading `count: 116`.
    //
    // Filled only when empty: an agent or a human that put ramps there keeps them.
    navigation:           (() => {
      const nav = cloneJson(existingSavedProfile.navigation || det.navigation || {});
      const detRamps = det.navigation?.ramps;
      if ((!Array.isArray(nav.ramps) || !nav.ramps.length) && Array.isArray(detRamps) && detRamps.length) {
        nav.ramps = cloneJson(detRamps);
      }
      return nav;
    })(),
    regulations:          cloneJson(existingSavedProfile.regulations  || det.regulations  || {}),
    limnology:            applyWqpToLimnology(existingSavedProfile.limnology || det.limnology || {}, wqp),
    summary:              cloneJson(existingSavedProfile.summary      || det.summary      || {}),
    trollingIntelligence: existingSavedProfile.trollingIntelligence   || null,
    estuary:              cloneJson(existingSavedProfile.estuary       || {}),
    tidal:                cloneJson(existingSavedProfile.tidal         || {}),
    saltwaterRegulations: cloneJson(existingSavedProfile.saltwaterRegulations || existingSavedProfile.saltwater_regulations || {}),
  };

  // Rebuilt every save from the deterministic pass and WQP, and that is correct: NO agent result
  // contributes an evidence entry anywhere in this function, and the deterministic pass
  // regenerates habitat, identity, navigation and summary evidence on every run. Measured on Lake
  // Norman across a rerun of two agents, 2026-08-21: habitat 11 sub-keys, identity 3, limnology 2,
  // navigation 1, summary 1 -- identical before and after. Seeding this from the saved profile
  // adds nothing, and would force a deduplicating merge to stop the map growing on every save.
  const evidence = mergeEvidenceMaps(det.evidence || {}, buildWqpEvidence(wqp));
  // Defensive: ensure biology arrays are real arrays. A malformed value (e.g. a
  // string from an earlier LLM run or a partial save) previously caused profile
  // assembly to throw "biology.knownStockings.map is not a function" — most often
  // when resuming a single agent (e.g. Species Intelligence) that loads the
  // biology section straight from the saved profile. Normalize here so both the
  // in-memory assembly and the subsequently saved profile are repaired.
  if (agentSections.biology) {
    agentSections.biology.knownStockings = coerceStockingsArray(agentSections.biology.knownStockings);
    agentSections.biology.predatorSpecies = coerceSpeciesArray(agentSections.biology.predatorSpecies);
  }

  const factualSummary = buildDeterministicSummary({ lakeName, identity: agentSections.identity, biology: agentSections.biology, limnology: agentSections.limnology, habitat: agentSections.habitat });
  if (factualSummary) {
    agentSections.summary = { text: factualSummary, keywords: det.summary?.keywords || [] };
  }

  // Apply unique facts from deterministic profile to fill identity/limnology gaps
  const detFacts = det._extractedFacts || [];
  if (detFacts.length) {
    const getFactVal = (cats) => { for (const c of cats) { const f = detFacts.find(f => String(f.category||'').toLowerCase() === c.toLowerCase()); if (f) return f.fact; } return null; };
    // ONE CATEGORY, FIVE SENTENCES, AND ONLY ONE OF THEM STATES THE NUMBER.
    // Lake Jocassee's run extracted five poolLevel facts; the first is a storage capacity in
    // acre-feet and states two elevations, so it answers nothing. Reading only the first fact
    // per category -- which getFactVal above does, correctly, for prose -- would throw the
    // other four away. numberFromText refuses an ambiguous sentence on purpose, and refusing
    // is only useful if the next sentence still gets its turn.
    const factNumber = (cats, measure) => {
      for (const c of cats) {
        for (const f of detFacts) {
          if (String(f.category||'').toLowerCase() !== c.toLowerCase()) continue;
          const v = numberFromText(f.fact, measure);
          if (v != null) return v;
        }
      }
      return null;
    };
    const id = agentSections.identity;
    if (id.surfaceAreaAcres == null) id.surfaceAreaAcres = factNumber(['surfaceArea','surfaceAreaAcres'], IDENTITY_MEASURES.surfaceAreaAcres);
    if (id.maxDepthFt == null)       id.maxDepthFt       = factNumber(['maxDepthFt','maxDepth'], IDENTITY_MEASURES.maxDepthFt);
    if (id.averageDepthFt == null)   id.averageDepthFt   = factNumber(['averageDepthFt','averageDepth'], IDENTITY_MEASURES.averageDepthFt);
    if (!id.archetype)               id.archetype        = getFactVal(['archetype']);
    if (!id.damName)                 id.damName          = getFactVal(['damName']);
    if (id.yearImpounded == null)    id.yearImpounded    = factNumber(['yearImpounded'], IDENTITY_MEASURES.yearImpounded);
    if (!id.reservoirOwner)          id.reservoirOwner   = getFactVal(['reservoirOwner']);
    if (!id.riverSystem)             id.riverSystem      = getFactVal(['riverSystem']);
    const lim = agentSections.limnology;
    if (!lim.thermocline) lim.thermocline = {};
    if (lim.thermocline.summerDepthFt == null) { const tv = getFactVal(['thermocline']); if (tv) lim.thermocline.note = (lim.thermocline.note ? lim.thermocline.note + ' ' : '') + tv; }
    if (!lim.trophicStatus) lim.trophicStatus = getFactVal(['trophicStatus']);
  }

  // Merge new agent section results on top
  for (const { agent: agentKey, data } of agentResults) {
    if (!data?.section) continue;
    const existing = agentSections[agentKey] || {};
    const merged = { ...existing };
    for (const [k, v] of Object.entries(data.section)) {
      if (v == null) continue;
      if (Array.isArray(v) && v.length === 0 && Array.isArray(existing[k]) && existing[k].length > 0) continue;
      merged[k] = v;
    }
    // Limnology: deep-merge nested objects — never let agent null sub-fields
    // overwrite existing non-null values (e.g. WQP-derived thermocline/oxygen)
    if (agentKey === 'limnology') {
      for (const subKey of ['thermocline', 'oxygen', 'waterClarity', 'surfaceWater']) {
        if (merged[subKey] && existing[subKey]) {
          const mergedSub = { ...existing[subKey] };
          for (const [sk, sv] of Object.entries(merged[subKey])) {
            if (sv != null) {
              // WQP secchi (many samples) always beats a single doc extraction
              if (subKey === 'waterClarity' && sk === 'secchiFt' && wqp?.secchi?.sampleCount >= 5 && existing[subKey]?.secchiFt != null) continue;
              mergedSub[sk] = sv;
            }
          }
          merged[subKey] = mergedSub;
        }
      }
      // Coerce string types left over from prior runs or LLM output -- see utils/coerce.js
      if (merged.thermocline) merged.thermocline.summerDepthFt = coerceNum(merged.thermocline.summerDepthFt);
      if (merged.oxygen) {
        merged.oxygen.depletionDepthFt = coerceNum(merged.oxygen.depletionDepthFt);
        merged.oxygen.anoxicBelowFt = coerceNum(merged.oxygen.anoxicBelowFt);
      }
      if (merged.waterClarity) merged.waterClarity.secchiFt = coerceNum(merged.waterClarity.secchiFt);
      if (merged.seasonalDrawdownFt != null) merged.seasonalDrawdownFt = coerceNum(merged.seasonalDrawdownFt) ?? merged.seasonalDrawdownFt;
    }
    // Biology: species list is always additive — never let agent shrink the list.
    // Normalize to Title Case before deduplication so 'largemouth bass' and
    // 'Largemouth Bass' don't both appear. Filter blanks and baitfish/non-predators.
    if (agentKey === 'biology') {
      const INVALID_PREDATORS = /^(shad|herring|menhaden|carp|drum|buffalo|sucker|eel|lamprey|mussels?|clam|crawfish|crayfish|insect|zooplankton|algae|diatom|cryptophyte|cyanobacteria|dinoflagellate|phytoplankton|unknown|other)\b/i;
      const normalizeSpecies = (list) => (list || [])
        .map(s => String(s || '').trim())
        .filter(s => s.length > 2 && !INVALID_PREDATORS.test(s))
        .map(s => s.replace(/\b\w/g, c => c.toUpperCase())); // Title Case
      const detSpecies      = normalizeSpecies(det.biology?.predatorSpecies);
      const existingSpecies = normalizeSpecies(existing.predatorSpecies);
      const agentSpecies    = normalizeSpecies(merged.predatorSpecies);
      // Deduplicate case-insensitively — keep first occurrence (deterministic wins)
      const seen = new Map();
      for (const s of [...detSpecies, ...existingSpecies, ...agentSpecies]) {
        const key = s.toLowerCase();
        if (!seen.has(key)) seen.set(key, s);
      }
      merged.predatorSpecies = [...seen.values()];
      merged.knownStockings  = merged.knownStockings?.length ? merged.knownStockings : (existing.knownStockings?.length ? existing.knownStockings : (det.biology?.knownStockings || []));
      // Coerce in case the LLM returned a non-array (string/object) — prevents
      // downstream ".map is not a function" crashes and repairs saved data.
      merged.knownStockings = coerceStockingsArray(merged.knownStockings);
      merged.predatorSpecies = coerceSpeciesArray(merged.predatorSpecies);
    }
    // Fisheries agent returns trollingIntelligence
    if (agentKey === 'fisheries') {
      const sectionKeys = Object.keys(data.section || {});
      log(`  [fisheries] section keys from LLM: [${sectionKeys.join(', ')}]`);
      if (sectionKeys.length === 0) {
        log(`  ⚠️ [fisheries] LLM returned empty section — trollingIntelligence not updated`);
      }
      agentSections.trollingIntelligence = merged;
    } else {
      agentSections[agentKey] = merged;
    }
  }

  const contradictions = agentResults.flatMap(r => r.data?.contradictions || []);
  const agentsRan = new Set(agentResults.map(r => r.agent));

  // FACTS ARE A PROPERTY OF THE LAKE'S DOCUMENT CACHE, NOT OF THE AGENTS THAT RAN.
  //
  // This line looks like it discards the facts of every agent that did not run, and on 2026-08-21
  // it was rewritten to seed from the saved profile on exactly that reading. THAT WAS WRONG and
  // the rewrite was reverted. Do not repeat it.
  //
  // `runAgent` loads the LAKE-WIDE normalized document cache -- `/research/get-normalized?lake=`,
  // unfiltered in full mode, falling back to all docs in resume mode when nothing carries this
  // agent's tag -- and `/research/analyze-facts` carries NO AGENT KEY. Its request body is
  // {lakeName, baseName, state, zoneKey, docIndex, documents} and its prompt extracts one fixed
  // 35-category list covering every section: surfaceArea and maxDepthFt through stocking,
  // speciesAbundance, ramp, hazard and summary. Whichever agents run, they re-derive the whole
  // ledger from the same corpus.
  //
  // MEASURED, Lake Norman, 2026-08-21. Ryan watched the run: TWO agents, identity and limnology.
  // The saved v12.0 profile kept 54 facts across the same seventeen categories as v11 -- biology's
  // stocking, speciesAbundance and primaryForage among them -- with only re-extraction drift
  // (summary 16 -> 14, oxygen 3 -> 2, secchi 3 -> 2).
  //
  // Stamping each fact with an agent and keeping the ones whose agent "did not speak" is strictly
  // worse than this line: it pins a stale fact to an agent that never owned it and lets it survive
  // a pass that legitimately re-derived the same category. `A_PARTIAL_RERUN_KEPT_ONLY_WHAT_IT_RAN_
  // 2026-08-21.md` has the whole trail.
  const allFacts = agentResults.flatMap(r => r.data?._extractedFacts || []);

  // ── Fact-backed identity override ──────────────────────────────────────
  // The LLM sometimes overrides pre-extracted numeric identity values with
  // different numbers from training data (e.g. maxDepth 150 from docs → 175
  // from LLM, yearImpounded 1946 from docs → 1942 from LLM).
  // When an extracted fact explicitly states a numeric value with a verbatim
  // quote from a document, that value wins over the LLM's guess.
  // IMPORTANT: This runs BEFORE the geometry-derived bathymetry override below,
  // so bathymetry values (direct measurements from our chart data) always take
  // final precedence over both LLM training data and document-extracted facts.
  if (allFacts.length > 0) {
    const factBackfill = (cats, measure) => {
      for (const c of cats) {
        for (const f of allFacts) {
          if (String(f.category||'').toLowerCase() !== c.toLowerCase()) continue;
          const parsed = numberFromText(f.fact, measure);
          if (parsed != null) return { value: parsed, quote: f.quote, source: f.source, confidence: f.confidence };
        }
      }
      return null;
    };
    const id = agentSections.identity;
    // Only override if the fact value differs from the current value
    // (if they match, no need; if current is null, validation pass handles it)
    const surfaceFact = factBackfill(['surfaceArea','surfaceAreaAcres'], IDENTITY_MEASURES.surfaceAreaAcres);
    if (surfaceFact && id.surfaceAreaAcres != null && id.surfaceAreaAcres !== surfaceFact.value) {
      log(`  🔄 identity.surfaceAreaAcres: LLM ${id.surfaceAreaAcres} → fact ${surfaceFact.value} (quote: "${surfaceFact.quote?.slice(0,60)}")`);
      id.surfaceAreaAcres = surfaceFact.value;
    }
    const depthFact = factBackfill(['maxDepthFt','maxDepth'], IDENTITY_MEASURES.maxDepthFt);
    if (depthFact && id.maxDepthFt != null && id.maxDepthFt !== depthFact.value) {
      log(`  🔄 identity.maxDepthFt: LLM ${id.maxDepthFt} → fact ${depthFact.value} (quote: "${depthFact.quote?.slice(0,60)}")`);
      id.maxDepthFt = depthFact.value;
    }
    const avgFact = factBackfill(['averageDepthFt','averageDepth'], IDENTITY_MEASURES.averageDepthFt);
    if (avgFact && id.averageDepthFt != null && id.averageDepthFt !== avgFact.value) {
      log(`  🔄 identity.averageDepthFt: LLM ${id.averageDepthFt} → fact ${avgFact.value} (quote: "${avgFact.quote?.slice(0,60)}")`);
      id.averageDepthFt = avgFact.value;
    }
    const yearFact = factBackfill(['yearImpounded'], IDENTITY_MEASURES.yearImpounded);
    if (yearFact && id.yearImpounded != null && id.yearImpounded !== yearFact.value) {
      log(`  🔄 identity.yearImpounded: LLM ${id.yearImpounded} → fact ${yearFact.value} (quote: "${yearFact.quote?.slice(0,60)}")`);
      id.yearImpounded = yearFact.value;
    }
    // Also fill null fields that the deterministic fill didn't cover (facts from non-identity agents)
    if (id.surfaceAreaAcres == null && surfaceFact) id.surfaceAreaAcres = surfaceFact.value;
    if (id.maxDepthFt == null && depthFact) id.maxDepthFt = depthFact.value;
    if (id.averageDepthFt == null && avgFact) id.averageDepthFt = avgFact.value;
    if (id.yearImpounded == null && yearFact) id.yearImpounded = yearFact.value;
  }

  // ── Geometry-derived bathymetry override (FINAL AUTHORITY) ─────────────
  // Geometry-derived bathymetry values (from depth_areas polygons + contours)
  // are the highest-truth source: they are direct measurements computed from
  // our own chart data via hypsometric integration, not from LLM training data,
  // scraped text, or document-extracted facts. This override runs LAST so it
  // wins over both the LLM agent output AND the fact-backed identity override
  // above. Bathymetry is authoritative for maxDepthFt and averageDepthFt.
  // For surfaceAreaAcres, bathymetry wins only when it is within a reasonable
  // range of the fact-backed value — depth-band polygon overlap can cause the
  // geometry-derived surface area to vastly overestimate the true lake area
  // (e.g. 70,000 ac computed vs. 13,000 ac actual). When the bathymetry area
  // exceeds the fact value by more than 50%, the fact value is more reliable.
  // Check both the deterministic profile (full pipeline) and the existing saved
  // profile (resume mode) for the _geometryDerived flag so bathymetry values
  // persist across resume runs even when the deterministic profile isn't loaded.
  const geoId = (det.identity && det.identity._geometryDerived ? det.identity : null)
    || (existingSavedProfile.identity && existingSavedProfile.identity._geometryDerived ? existingSavedProfile.identity : null);
  if (geoId) {
    const id = agentSections.identity;
    if (geoId.surfaceAreaAcres != null && id.surfaceAreaAcres !== geoId.surfaceAreaAcres) {
      // Sanity check: if bathymetry area is wildly different from fact-backed
      // area, the polygon overlap has corrupted the surface area calculation.
      const factArea = id.surfaceAreaAcres;
      const geoArea = geoId.surfaceAreaAcres;
      const ratio = (factArea && factArea > 0) ? geoArea / factArea : 0;
      if (ratio > 0 && ratio <= 1.5) {
        log(`  🗺️ identity.surfaceAreaAcres: bathymetry ${geoArea} ac overrides prior ${factArea} (authoritative)`);
        id.surfaceAreaAcres = geoArea;
      } else if (ratio > 1.5) {
        log(`  🗺️ identity.surfaceAreaAcres: bathymetry ${geoArea} ac rejected — ${ratio.toFixed(1)}× fact value ${factArea} ac (polygon overlap detected, keeping fact value)`);
      } else {
        log(`  🗺️ identity.surfaceAreaAcres: bathymetry ${geoArea} ac overrides prior ${factArea} (authoritative)`);
        id.surfaceAreaAcres = geoArea;
      }
    }
    if (geoId.maxDepthFt != null && id.maxDepthFt !== geoId.maxDepthFt) {
      log(`  🗺️ identity.maxDepthFt: bathymetry ${geoId.maxDepthFt} ft overrides prior ${id.maxDepthFt} (authoritative)`);
      id.maxDepthFt = geoId.maxDepthFt;
    }
    if (geoId.averageDepthFt != null && id.averageDepthFt !== geoId.averageDepthFt) {
      log(`  🗺️ identity.averageDepthFt: bathymetry ${geoId.averageDepthFt} ft overrides prior ${id.averageDepthFt} (authoritative)`);
      id.averageDepthFt = geoId.averageDepthFt;
    }
    // Preserve the geometry-derived flag and metadata on the final identity
    id._geometryDerived = true;
    if (geoId._bathymetryMeta) id._bathymetryMeta = geoId._bathymetryMeta;
  }

  // ── Coastal fact→schema mapping ──────────────────────────────────────
  // The saltwater agent set extracts facts under coastal categories that don't
  // land in the freshwater regulations/identity/limnology schema on their own.
  // Map them here so the downstream UI (which reads regulations.lengthLimits,
  // identity.tideStation, limnology.salinity, etc.) sees the data.
  // Guarded by isCoastalLake(lakeName) so freshwater assembly is untouched.
  if (isCoastalLake(lakeName)) {
    const zoneMeta = getCoastalZoneMeta(lakeName);
    const factsByCat = (cats) => {
      const set = new Set(cats.map(c => c.toLowerCase()));
      return allFacts.filter(f => set.has(String(f.category || '').toLowerCase()));
    };
    const firstNum = (facts) => {
      for (const f of facts) {
        // "7,980" used to read as 7 here: the pattern stopped at the comma.
        const m = String(f.fact || '').match(/-?\d[\d,]*(?:\.\d+)?/);
        if (m) { const n = parseFloat(m[0].replace(/,/g, '')); if (isFinite(n)) return { value: n, fact: f }; }
      }
      return null;
    };

    // ── (1) Regulations mapping: sizeLimit_general / creelLimit_general /
    //        closedSeason / saltwaterRegulation → regulations.generalStateRegulations
    //        + lakeSpecificRegulations
    const reg = agentSections.regulations = agentSections.regulations || {
      state: stateName,
      generalStateRegulations: { lengthLimits: {}, creelLimits: {} },
      lakeSpecificRegulations: { hasExceptions: null, creelLimits: {}, sizeLimits: {}, specialRules: [], closedSeasons: [] },
      notes: null
    };
    reg.generalStateRegulations = reg.generalStateRegulations || { lengthLimits: {}, creelLimits: {} };
    reg.generalStateRegulations.lengthLimits = reg.generalStateRegulations.lengthLimits || {};
    reg.generalStateRegulations.creelLimits  = reg.generalStateRegulations.creelLimits  || {};
    reg.lakeSpecificRegulations = reg.lakeSpecificRegulations || { hasExceptions: null, creelLimits: {}, sizeLimits: {}, specialRules: [], closedSeasons: [] };
    reg.lakeSpecificRegulations.specialRules = reg.lakeSpecificRegulations.specialRules || [];
    reg.lakeSpecificRegulations.closedSeasons = reg.lakeSpecificRegulations.closedSeasons || [];

    // Recognize saltwater species names in fact text
    const SPECIES_PATTERNS = [
      { key: 'Red Drum (Redfish)',    re: /\b(redfish|red\s*drum)\b/i },
      { key: 'Spotted Seatrout',      re: /\b(spotted\s*sea\s*trout|spotted\s*seatrout|speckled\s*(sea\s*)?trout)\b/i },
      { key: 'Southern Flounder',     re: /\b(southern\s*flounder|summer\s*flounder|flounder)\b/i },
      { key: 'Black Drum',            re: /\bblack\s*drum\b/i },
      { key: 'Sheepshead',            re: /\bsheepshead\b/i },
      { key: 'Cobia',                 re: /\bcobia\b/i },
      { key: 'Tarpon',                re: /\btarpon\b/i },
      { key: 'King Mackerel',         re: /\bking\s*mackerel\b/i },
      { key: 'Spanish Mackerel',      re: /\bspanish\s*mackerel\b/i },
    ];
    const speciesFromText = (text) => {
      const t = String(text || '');
      for (const s of SPECIES_PATTERNS) if (s.re.test(t)) return s.key;
      return null;
    };
    // "12–27 inch slot", "12 inch minimum", "14 inch minimum", "no minimum", "16\" (Total Length)"
    const parseLengthLimit = (text) => {
      const t = String(text || '').replace(/[""]/g, '"');
      if (/no\s*minimum/i.test(t)) return { text: 'No minimum size limit', type: 'none' };
      // slot: NN–NN inch(es), NN-NN in
      let m = t.match(/(\d+(?:\.\d+)?)\s*[–\-to]{1,4}\s*(\d+(?:\.\d+)?)\s*(?:in(?:ch(?:es)?)?|")\s*(?:slot|tl|total\s*length)?/i);
      if (m) return { text: `${m[1]}–${m[2]}" slot`, type: 'slot', min: parseFloat(m[1]), max: parseFloat(m[2]) };
      // min–max in separate phrases (Min NN Max NN)
      const mMin = t.match(/min(?:imum)?\s*size?\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
      const mMax = t.match(/max(?:imum)?\s*size?\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
      if (mMin && mMax) return { text: `${mMin[1]}–${mMax[1]}" slot`, type: 'slot', min: parseFloat(mMin[1]), max: parseFloat(mMax[1]) };
      // "NN inch minimum", "NN" minimum"
      m = t.match(/(\d+(?:\.\d+)?)\s*(?:in(?:ch(?:es)?)?|")\s*(?:min(?:imum)?|tl|total\s*length)/i);
      if (m) return { text: `${m[1]}" minimum`, type: 'min', min: parseFloat(m[1]) };
      // "size limit of NN inches minimum" / "min size NN"
      m = t.match(/(?:size\s*limit|min(?:imum)?\s*size)[^.]*?(\d+(?:\.\d+)?)/i);
      if (m) return { text: `${m[1]}" minimum`, type: 'min', min: parseFloat(m[1]) };
      return null;
    };
    // "bag limit 1", "daily bag limit 5", "10 fish per person"
    const parseCreelLimit = (text) => {
      const t = String(text || '');
      let m = t.match(/(?:daily\s*)?bag\s*limit[^0-9]*(\d+)/i);
      if (m) return { text: `${m[1]} per day`, count: parseInt(m[1], 10) };
      m = t.match(/(\d+)\s*fish\s*per\s*(?:person|day|angler)/i);
      if (m) return { text: `${m[1]} per day`, count: parseInt(m[1], 10) };
      m = t.match(/limit\s*of\s*(\d+)/i);
      if (m) return { text: `${m[1]} per day`, count: parseInt(m[1], 10) };
      return null;
    };

    const sizeFacts  = factsByCat(['sizeLimit_general', 'sizeLimit_lakeSpecific']);
    const creelFacts = factsByCat(['creelLimit_general', 'creelLimit_lakeSpecific']);
    const closedFacts = factsByCat(['closedSeason']);
    const swRegFacts = factsByCat(['saltwaterRegulation']);

    let regMapCount = 0;
    for (const f of sizeFacts) {
      const sp = speciesFromText(f.fact) || speciesFromText(f.quote);
      const parsed = parseLengthLimit(f.fact) || parseLengthLimit(f.quote);
      if (!sp || !parsed) continue;
      if (!reg.generalStateRegulations.lengthLimits[sp]) {
        reg.generalStateRegulations.lengthLimits[sp] = parsed.text;
        regMapCount++;
      }
    }
    for (const f of creelFacts) {
      const sp = speciesFromText(f.fact) || speciesFromText(f.quote);
      const parsed = parseCreelLimit(f.fact) || parseCreelLimit(f.quote);
      if (!sp || !parsed) continue;
      if (!reg.generalStateRegulations.creelLimits[sp]) {
        reg.generalStateRegulations.creelLimits[sp] = parsed.text;
        regMapCount++;
      }
    }
    for (const f of closedFacts) {
      const entry = { note: f.fact, source: f.source || null };
      const exists = reg.lakeSpecificRegulations.closedSeasons.some(x => (x?.note || x) === entry.note);
      if (!exists) { reg.lakeSpecificRegulations.closedSeasons.push(entry); regMapCount++; }
    }
    for (const f of swRegFacts) {
      const rule = String(f.fact || '').trim();
      if (!rule) continue;
      if (!reg.lakeSpecificRegulations.specialRules.includes(rule)) {
        reg.lakeSpecificRegulations.specialRules.push(rule);
        regMapCount++;
      }
    }
    // THE saltwater_regulations AGENT'S STRUCTURED OUTPUT WAS MERGED HERE AND THE AGENT IS GONE.
    // Its own scope doc argued itself out of existence: NC closes southern flounder and spotted
    // seatrout BY PROCLAMATION mid-season, so a stored saltwaterRegulations block is a snapshot of
    // a rule that can be superseded the following week. fetchLiveRegsAmendments() already asks the
    // state for exactly that, and coastal-regulations.js consults the live digest first.
    // The fact-derived mapping above stays -- those come from extracted documents, not an LLM.
    // hasExceptions flag: true if we captured any lake-specific rule or closure
    if (reg.lakeSpecificRegulations.specialRules.length || reg.lakeSpecificRegulations.closedSeasons.length) {
      reg.lakeSpecificRegulations.hasExceptions = true;
    }

    // ── (2) Identity mapping: bodyType / zoneType / tideStation ──
    const id = agentSections.identity = agentSections.identity || {};
    const est = agentSections.estuary || {};
    // bodyType: prefer extracted waterBodyType fact, fall back to estuary agent field
    if (id.bodyType == null) {
      const btFacts = factsByCat(['waterBodyType']);
      const btText = btFacts[0]?.fact || est.waterBodyType || null;
      if (btText) id.bodyType = String(btText).trim();
    }
    // zoneType from coastal zone catalog (bar-built, drowned river valley, sound, etc.)
    if (id.zoneType == null) {
      const bt = String(id.bodyType || est.waterBodyType || '').toLowerCase();
      if (/sound/i.test(bt)) id.zoneType = 'sound';
      else if (/bar[\s-]?built|inlet/i.test(bt)) id.zoneType = 'bar-built estuary';
      else if (/drowned\s*river/i.test(bt)) id.zoneType = 'drowned river valley';
      else if (/lagoon/i.test(bt)) id.zoneType = 'coastal lagoon';
      else if (/harbor|bay/i.test(bt)) id.zoneType = 'coastal bay';
      else if (isCoastalLake(lakeName)) id.zoneType = 'coastal estuary';
    }
    // tideStation from coastal zone catalog
    if (id.tideStation == null && zoneMeta?.tideStation) {
      id.tideStation = zoneMeta.tideStation;
    }
    // county from extracted facts (helpful for coastal ID)
    if (!id.county) {
      const cFact = allFacts.find(f => String(f.category||'').toLowerCase() === 'county');
      if (cFact) {
        const m = String(cFact.fact || '').match(/([A-Z][a-zA-Z\-]+(?:\s+[A-Z][a-zA-Z\-]+)*)\s+County/);
        if (m) id.county = m[1];
      }
    }

    // ── (3) Limnology mapping: salinity + tidalRange ──
    const lim = agentSections.limnology = agentSections.limnology || {};
    if (lim.salinity == null) {
      const salFacts = factsByCat(['salinity']);
      const s = firstNum(salFacts);
      if (s) {
        // Preserve unit (ppt / ‰) if present
        const unitMatch = String(s.fact.fact || '').match(/(‰|ppt|parts?\s*per\s*thousand)/i);
        const unit = unitMatch ? (unitMatch[1] === '‰' ? '‰' : 'ppt') : 'ppt';
        lim.salinity = { value: s.value, unit, source: s.fact.source || null };
      } else if (agentSections.tidal?.salinityPpt?.typical != null) {
        lim.salinity = { value: agentSections.tidal.salinityPpt.typical, unit: 'ppt', source: 'tidal agent' };
      }
    }
    if (lim.tidalRange == null) {
      const trFacts = factsByCat(['tidalRange']);
      const t = firstNum(trFacts);
      if (t) {
        lim.tidalRange = { meanFt: t.value, source: t.fact.source || null };
      } else if (agentSections.estuary?.meanTidalRangeFt != null) {
        lim.tidalRange = { meanFt: agentSections.estuary.meanTidalRangeFt, source: 'estuary agent' };
      }
    }

    if (regMapCount > 0) log(`  🧭 Coastal assembler: mapped ${regMapCount} regulation fact(s) → schema (lengthLimits, creelLimits, specialRules, closedSeasons)`);
    if (id.bodyType || id.zoneType || id.tideStation) log(`  🧭 Coastal assembler: identity.bodyType=${id.bodyType || 'null'}, zoneType=${id.zoneType || 'null'}, tideStation=${id.tideStation || 'null'}`);
    if (lim.salinity || lim.tidalRange) log(`  🧭 Coastal assembler: limnology.salinity=${lim.salinity?.value ?? 'null'}${lim.salinity ? ' ' + lim.salinity.unit : ''}, tidalRange=${lim.tidalRange?.meanFt ?? 'null'}${lim.tidalRange ? ' ft' : ''}`);
  }

  // Validation pass — only runs when we have facts, only checks fields for agents that ran
  const ALL_VALIDATION_FIELDS = {
    identity:   ['identity.surfaceAreaAcres','identity.maxDepthFt','identity.averageDepthFt','identity.reservoirOwner','identity.riverSystem','identity.damName','identity.yearImpounded','identity.county','identity.archetype'],
    limnology:  ['limnology.waterClarity.typical','limnology.waterClarity.color','limnology.waterClarity.secchiFt','limnology.thermocline.summerDepthFt','limnology.thermocline.strength','limnology.thermocline.winterMix','limnology.oxygen.depletionDepthFt','limnology.oxygen.anoxicBelowFt','limnology.trophicStatus','limnology.flowCharacteristics','limnology.seasonalDrawdownFt'],
    biology:    ['biology.primaryForage','biology.secondaryForage','biology.predatorSpecies','biology.speciesAbundance','biology.knownStockings','biology.baitfishMovement','biology.invasiveSpecies','biology.spawnTiming','biology.forageSpatial'],
    habitat:    ['habitat.bottomComposition','habitat.cover','habitat.vegetation','habitat.standingTimber','habitat.dockDensity','habitat.riprapLocations','habitat.namedCreekMouths','habitat.timberFields','habitat.shallowFlatAreas','habitat.artificialHabitat','habitat.artificialHabitatDetails.attractorCount','habitat.artificialHabitatDetails.attractorTypes'],
    navigation: ['navigation.ramps','navigation.hazards','navigation.notes'],
    fisheries:  ['trollingIntelligence'],
    estuary:    ['estuary.waterBodyType','estuary.meanTidalRangeFt','estuary.primaryInlets','estuary.tributaryRivers','estuary.marshAcreage','estuary.oysterPresence','identity.bodyType','identity.zoneType','identity.tideStation'],
    tidal:      ['tidal.datum','tidal.stratificationType','tidal.salinityPpt','tidal.tidalCurrentKts','tidal.flushingTimeDays','tidal.waterTempF','tidal.turbidity','limnology.salinity','limnology.tidalRange'],
  };
  // Map agent keys to their section paths for validation — fisheries writes to trollingIntelligence
  const agentSectionPath = (section) => section === 'fisheries' ? 'trollingIntelligence' : section;
  const relevantFields = Object.entries(ALL_VALIDATION_FIELDS)
    .filter(([section]) => agentsRan.has(section))
    .flatMap(([, fields]) => fields);
  const atPath = (obj, path) => path.split('.').reduce((v, k) => v == null ? undefined : v[k], obj);
  const isMissing = (v) => v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
  const nullFields = relevantFields.filter(p => isMissing(atPath(agentSections, p)));

  if (nullFields.length > 0 && allFacts.length > 0) {
    log(`Running validation pass for ${nullFields.length} empty fields across [${[...agentsRan].join(',')}]: ${nullFields.slice(0,5).join(', ')}${nullFields.length > 5 ? '...' : ''}`);
    try {
      const filled = {};
      const batchSize = 10;
      for (let i = 0; i < nullFields.length; i += batchSize) {
        const fieldBatch = nullFields.slice(i, i + batchSize);
        const valRes = await fetch(`${CF_WORKER_URL}/research/validation-pass`, {
          method: 'POST', headers: workerHeaders(),
          body: JSON.stringify({ lakeName, state: stateName, nullFields: fieldBatch, profile: agentSections, extractedFacts: allFacts })
        });
        if (!valRes.ok) throw new Error(`HTTP ${valRes.status}`);
        const valData = await valRes.json();
        if (!valData.success) throw new Error(valData.error || 'failed');
        Object.assign(filled, valData.filled || {});
        if (i + batchSize < nullFields.length) await new Promise(r => setTimeout(r, 1000));
      }
      let filledCount = 0;
      for (const [path, value] of Object.entries(filled)) {
        if (!nullFields.includes(path) || value == null) continue;
        const parts = path.split('.');
        let obj = agentSections;
        for (let i = 0; i < parts.length - 1; i++) { if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {}; obj = obj[parts[i]]; }
        const lastKey = parts[parts.length - 1];
        if (isMissing(obj[lastKey])) { obj[lastKey] = value; filledCount++; }
      }
      log(`✔ Validation pass: ${filledCount} fields filled from ${Object.keys(filled).length} returned`);
    } catch (e) { log(`⚠️ Validation pass failed: ${e.message} — continuing`); }
  } else if (nullFields.length > 0) {
    log(`ℹ️ Validation pass skipped — no facts extracted (${nullFields.length} fields remain empty: ${nullFields.slice(0,5).join(', ')}${nullFields.length > 5 ? '...' : ''})`);
  } else {
    log(`ℹ️ Validation pass skipped — all relevant fields populated`);
  }

  // Safety-net biology before save
  const INVALID_PREDATORS_FINAL = /^(shad|herring|menhaden|carp|drum|buffalo|sucker|eel|lamprey|mussels?|clam|crawfish|crayfish|insect|zooplankton|algae|diatom|cryptophyte|cyanobacteria|dinoflagellate|phytoplankton|unknown|other)\b/i;
  const normalizeSpeciesFinal = (list) => (list || [])
    .map(s => String(s || '').trim())
    .filter(s => s.length > 2 && !INVALID_PREDATORS_FINAL.test(s))
    .map(s => s.replace(/\b\w/g, c => c.toUpperCase()));
  const detSpecies = normalizeSpeciesFinal(det.biology?.predatorSpecies);
  const agentSpecies = normalizeSpeciesFinal(agentSections.biology?.predatorSpecies);
  const seenFinal = new Map();
  for (const s of [...detSpecies, ...agentSpecies]) {
    const key = s.toLowerCase();
    if (!seenFinal.has(key)) seenFinal.set(key, s);
  }
  const finalSpecies = [...seenFinal.values()];
  const safeBiology = {
    ...(agentSections.biology || {}),
    predatorSpecies: finalSpecies.length ? finalSpecies : detSpecies,
    knownStockings: coerceStockingsArray(
      (agentSections.biology?.knownStockings?.length ? agentSections.biology.knownStockings : null)
      || (Array.isArray(det.biology?.knownStockings) && det.biology.knownStockings.length ? det.biology.knownStockings : null)
      || []
    ),
  };

  // Build source map — seed from existing saved sources first so resume runs
  // don't lose confidence scoring from prior full runs
  const sourceMap = new Map();
  for (const s of (existingSavedProfile.sources || [])) {
    if (!s || (!s.label && !s.url)) continue;
    sourceMap.set(`${s.label}|${s.url || '#'}`, s);
  }
  for (const s of (det.sources || [])) sourceMap.set(`${s.label}|${s.url}`, s);
  for (const r of agentResults) {
    for (const s of (r.data?.sources || [])) {
      const key = `${s.label || s.title}|${s.url || '#'}`;
      if (!sourceMap.has(key)) sourceMap.set(key, { label: s.label || s.title, url: s.url || '#', authority: s.authority, trust: 'THIRD_PARTY' });
    }
  }
  if (wqp?.recordCount > 0) sourceMap.set('Water Quality Portal|https://www.waterqualitydata.us/', { label: 'Water Quality Portal / SCDES monitoring', url: 'https://www.waterqualitydata.us/', trust: 'OFFICIAL', sourceType: 'official_structured' });

  const baseName = cleanLakeBaseName(lakeName);
  const researchPacket = {
    lakeName, baseName, state: stateName,
    ...agentSections,
    biology: safeBiology,
    trollingIntelligence: agentSections.trollingIntelligence || null,
    _extractedFacts: allFacts,
    _extractedFactsCount: allFacts.length,
    _wqpLimnology: wqp || null,
    evidence,
    sources: [...sourceMap.values()]
  };

  const totalFactsExtracted = agentResults.reduce((sum, r) => sum + (r.data?.factsCount || 0), 0);
  // Preserve existing verification status — don't demote a verified profile back to draft
  // just because an agent reran. Status only changes if explicitly set by the user.
  const existingStatus = existingSavedProfile?.metadata?.status || 'draft';
  const existingVerified = existingSavedProfile?.metadata?.verified || false;
  const saveStatus = existingVerified ? 'verified' : existingStatus;

  log(`Saving profile (facts=${totalFactsExtracted} extracted server-side, species=${finalSpecies.length}, agents=[${agentResults.map(r=>r.agent).join(',')}])...`);
  const saveRes = await fetch(`${CF_WORKER_URL}/research/save`, {
    method: 'POST', headers: workerHeaders(),
    body: JSON.stringify({
      lakeName, profile: researchPacket,
      status: saveStatus,
      approve: existingVerified,
      verified: existingVerified,
      requestedBy: 'TrollMap Evidence Engine v6'
    })
  });
  if (!saveRes.ok) {
    const t = await saveRes.text().catch(()=>'').then(s=>s.slice(0,400));
    throw new Error(`Save HTTP ${saveRes.status}: ${t}`);
  }
  const saveData = await saveRes.json();
  log(`✔ Saved profile v${saveData.version} as draft`);
  setProgress('Pipeline completed successfully!', 100);
  log('=== EVIDENCE PIPELINE COMPLETE ===');
  return { contradictions };
}

export { runFullPipeline, runAgents, runAgent, runResume, assembleAndSaveProfile, validateExistingFacts, recoverSmartPlanFacts, deriveGeospatialStructureFacts, renderLog, _state, RESEARCH_ORDER, FRESHWATER_RESEARCH_ORDER, COASTAL_RESEARCH_ORDER, FRESHWATER_PROFILE_SECTIONS, COASTAL_PROFILE_SECTIONS, RESEARCH_LABELS, cloneJson, hasResearchValue, sanitize, sanitizeStateFromLakeName, log, getCoastalR2Key, isCoastalLake, getResearchOrderForLake, getCoastalZoneMeta };
