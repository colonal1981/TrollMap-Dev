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
import { LAKE_DB } from '../data/lakes.js';
import { resolveR2Key } from './contour-data.js';
import { resolveSupplementalKey, resolveBoundaryKey } from './supplemental-layers.js';

// Setup global caches and references
window.TROLLMAP_RESEARCHED_CACHE = window.TROLLMAP_RESEARCHED_CACHE || {};


const RESEARCH_ORDER = ['identity', 'limnology', 'biology', 'habitat', 'navigation', 'regulations', 'summary'];
const RESEARCH_LABELS = {
  identity: '🆔 Identity',
  limnology: '🌊 Limnology',
  biology: '🐟 Fisheries',
  habitat: '🌿 Habitat',
  navigation: '🧭 Navigation',
  regulations: '📜 Regulations',
  summary: '📝 AI Summary'
};

const _state = {
  currentProfile: null,
  currentLakeName: '',
  currentPackageFiles: [],
  currentVersions: [],
  researchInProgress: false,
  researchLog: [],
  packagePartsCache: {}
};

// Helper logging
function log(msg) {
  _state.researchLog.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
  const el = document.getElementById('researchLog');
  if (el) {
    el.textContent = _state.researchLog.join('\n');
    el.scrollTop = el.scrollHeight;
  }
  console.log(`[evidence-pipeline] ${msg}`);
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
}

function sanitizeStateFromLakeName(lakeName) {
  const s = (lakeName || '').toUpperCase();
  // Prefer primary state from suffix: "Lake X, NC", "Lake X, SC/GA", "Lake X, NC/VA"
  // Order matters: check explicit ", XX" / "/XX" tokens so border lakes resolve correctly.
  if (/,\s*NC(\/|$|\s)|\/NC\b/.test(s) || s.includes('NORTH CAROLINA')) return 'NC';
  if (/,\s*GA(\/|$|\s)|\/GA\b/.test(s) || s.includes('GEORGIA')) return 'GA';
  if (/,\s*VA(\/|$|\s)|\/VA\b/.test(s) || s.includes('VIRGINIA')) return 'NC'; // Kerr/Gaston treated with NC pipeline
  if (/,\s*SC(\/|$|\s)|\/SC\b/.test(s) || s.includes('SOUTH CAROLINA')) return 'SC';
  // Loose fallbacks
  if (/\bNC\b/.test(s)) return 'NC';
  if (/\bGA\b/.test(s)) return 'GA';
  return 'SC';
}

function sanitize(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'unknown';
}

function cleanLakeBaseName(lakeName) {
  let base = String(lakeName || '').trim();
  base = base.replace(/^Lake\s+/i, '');
  base = base.replace(/,\s*(SC|NC|GA)\s*$/i, '').trim();
  base = base.replace(/\s+Reservoir$/i, '').trim();
  base = base.replace(/\s+Lake$/i, '').trim();
  return base || lakeName;
}



function hasResearchValue(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
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
  if (biology.predatorSpecies?.length) {
    let s = `Confirmed sport fish include ${biology.predatorSpecies.join(', ')}`;
    if (biology.knownStockings?.length) s += `; documented stocking notes include ${biology.knownStockings.map(x => x.species).join(', ')}`;
    sentences.push(`${s}.`);
  }
  const limBits = [];
  if (lim.waterClarity?.secchiFt) limBits.push(`Secchi clarity around ${lim.waterClarity.secchiFt} ft`);
  if (lim.surfaceWater?.recentTempF != null) limBits.push(`recent surface water near ${lim.surfaceWater.recentTempF}°F`);
  if (lim.surfaceWater?.recentDissolvedOxygenMgL != null) limBits.push(`recent surface dissolved oxygen near ${lim.surfaceWater.recentDissolvedOxygenMgL} mg/L`);
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
    if (hab.cover?.length) bits.push(`cover includes ${hab.cover.slice(0, 4).join(', ')}`);
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

function geoDistanceFt(lat1, lon1, lat2, lon2) {
  const R = 20902231; // Earth radius in feet
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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

function deriveContourStructures(contourGeo, boundaryRing = null) {
  const result = {};
  if (!contourGeo?.features?.length) return result;
  let midDepthCount = 0;
  let closedInteriorLoops = 0;
  for (const f of contourGeo.features) {
    const depth = f?.properties?.depth_ft;
    if (depth != null && depth >= 15 && depth <= 35) midDepthCount++;
    for (const coords of flattenLineCoords(f.geometry)) {
      if (!isClosedContour(coords)) continue;
      const areaAcres = polygonAreaAcresLonLat(coords);
      if (areaAcres < 1 || areaAcres > 400) continue;
      if (boundaryRing) {
        const [lon, lat] = centroidLonLat(coords);
        if (!pointInPolygonLonLat(lon, lat, boundaryRing)) continue;
      }
      closedInteriorLoops++;
    }
  }
  if (midDepthCount >= 25) result.channelLedges = 'mid-depth contour density indicates multiple ledges / drop-offs';
  else if (midDepthCount >= 10) result.channelLedges = 'contours indicate at least some ledges / depth breaks';
  if (closedInteriorLoops >= 5) result.humps = 'multiple closed contour loops suggest several offshore humps or high spots';
  else if (closedInteriorLoops >= 1) result.humps = 'at least one closed contour loop suggests offshore hump / high-spot structure';
  return result;
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

function derivePoiStructures(poiGeo) {
  const result = {};
  if (!poiGeo?.features?.length) return result;
  const names = poiGeo.features.map(f => String(f.properties?.name || '')).filter(Boolean);
  const bridgeNames = names.filter(n => /bridge/i.test(n));
  if (bridgeNames.length >= 2) result.bridges = `bridge-related POIs include ${bridgeNames.slice(0, 3).join(', ')}`;
  else if (bridgeNames.length === 1) result.bridges = `bridge-related POI includes ${bridgeNames[0]}`;
  return result;
}

async function deriveGeospatialStructureFacts(lakeName) {
  const contourKey = resolveR2Key(lakeName);
  const supplementalKey = resolveSupplementalKey(lakeName);
  const boundaryKey = resolveBoundaryKey(lakeName);
  const [contourGeo, depthGeo, poiGeo, boundaryGeo] = await Promise.all([
    contourKey ? fetchGeoJsonMaybe(`${CF_WORKER_URL}/chartpacks/${contourKey}/contours.geojson?v=${Date.now()}`) : Promise.resolve(null),
    supplementalKey ? fetchGeoJsonMaybe(`${CF_WORKER_URL}/chartpacks/supplemental/${supplementalKey}/depth_areas.geojson?v=${Date.now()}`) : Promise.resolve(null),
    supplementalKey ? fetchGeoJsonMaybe(`${CF_WORKER_URL}/chartpacks/supplemental/${supplementalKey}/pois.geojson?v=${Date.now()}`) : Promise.resolve(null),
    boundaryKey ? fetchGeoJsonMaybe(`${CF_WORKER_URL}/chartpacks/boundaries/${boundaryKey}.geojson?v=${Date.now()}`) : Promise.resolve(null),
  ]);
  const ring = getBoundaryOuterRing(boundaryGeo);
  const structuralElements = {
    ...summarizePointComplexityFromBoundary(ring),
    ...deriveContourStructures(contourGeo, ring),
    ...deriveDepthAreaStructures(depthGeo),
    ...derivePoiStructures(poiGeo),
  };
  if (!Object.keys(structuralElements).length) return null;
  const evidence = { habitat: {} };
  for (const field of Object.keys(structuralElements)) {
    evidence.habitat[`structuralElements.${field}`] = [buildEvidenceEntry('internal_geospatial_layer', 'TrollMap contour/supplemental/boundary layers', 'internal:contours+supplemental+boundaries', null, 'geometry_derived_structure_classification', { lakeName })];
  }
  return {
    habitat: {
      structuralElements,
      notes: 'Structural elements summarized from TrollMap contour, depth-area, POI, and boundary layers.'
    },
    evidence,
    sources: [{ label: 'TrollMap contour / supplemental / boundary layers', url: 'internal:contours+supplemental+boundaries', trust: 'OFFICIAL_GIS', sourceType: 'internal_geospatial_layer' }]
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
// Shared scoring function used by both runEvidencePipeline and runFromNormalized.
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

async function runFromNormalized(lakeName, callbacks = {}) {
  if (_state.researchInProgress) { alert('A research task is already in progress.'); return; }
  if (!lakeName) { alert('Please select a lake.'); return; }
  _state.researchInProgress = true;
  _state.researchLog = [];
  _state.packagePartsCache = {};
  showProgress(true);
  setProgress('Fetching existing normalized documents from R2...', 5);
  log(`=== RESUME FROM NORMALIZED: ${lakeName} ===`);
  try {
    // Fetch normalized docs already saved in R2
    const normRes = await fetch(`${CF_WORKER_URL}/research/get-normalized?lake=${encodeURIComponent(lakeName)}`);
    if (!normRes.ok) throw new Error(`No normalized documents found in R2 for ${lakeName} — run the full pipeline first.`);
    const normData = await normRes.json();
    if (!normData.ok || !normData.documents?.length) throw new Error(`No normalized documents found for ${lakeName}.`);
    const normalizedDocuments = normData.documents;
    log(`Loaded ${normalizedDocuments.length} normalized documents from R2.`);

    // Derive state and baseName locally — no Tavily/discover needed for resume
    const stateName = sanitizeStateFromLakeName(lakeName);
    const baseName = lakeName.replace(/^Lake\s+/i, '').replace(/,\s*(SC|NC|GA)\s*$/i, '').trim();

    // Jump straight to scoring (Step 5 & 6) — uses same scoreDocuments function as full pipeline
    setProgress('Step 5-6: Running Quality Scoring & Classification...', 40);
    log('Computing scores based on authority trustworthiness rules...');
    const scoredSources = scoreDocuments(normalizedDocuments, baseName, lakeName);
    log('Scoring and classification completed:');
    scoredSources.forEach(s => {
      log(`• ${s.title}: auth=${s.scoring.authority} rel=${s.scoring.relevance} fresh=${s.scoring.freshness} comp=${s.scoring.completeness} => composite=${s.scoring.composite} classes=${s.classes.join(', ')}`);
    });

    // Now run steps 7 onward exactly as the full pipeline does
    // (fact extraction, dedup, mapping, gap analysis, agents, save)
    // We reuse the shared tail logic by calling into the pipeline directly
    await runPipelineTail(lakeName, baseName, stateName, normalizedDocuments, scoredSources, callbacks);

  } catch (e) {
    log(`❌ Resume Aborted: ${e.message}`);
    setProgress('Resume failed — see log.', 0);
  } finally {
    _state.researchInProgress = false;
  }
}

async function runEvidencePipeline(lakeName, callbacks = {}) {
  if (_state.researchInProgress) {
    alert('A research task or pipeline is already in progress.');
    return;
  }
  if (!lakeName) {
    alert('Please select or specify a lake.');
    return;
  }

  _state.researchInProgress = true;
  _state.researchLog = [];
  _state.packagePartsCache = {};
  showProgress(true);
  setProgress("Initializing evidence pipeline...", 0);
  log(`=== EVIDENCE PIPELINE START: ${lakeName} ===`);

  try {
    const stateName = sanitizeStateFromLakeName(lakeName);
    const sanitizedLake = sanitize(lakeName);

    // ----------------------------------------------------
    // STEP 1: Lake Identification (canonical_lake.json)
    // ----------------------------------------------------
    setProgress("Step 1: Identifying Canonical Lake...", 10);
    log("Resolving canonical lake details and aliases...");
    const baseName = cleanLakeBaseName(lakeName);
    const rawAliases = [
      `${baseName} Reservoir`,
      `Lake ${baseName}`,
      `${baseName} Lake`,
      lakeName,
      `${lakeName} Reservoir`
    ];
    // dedupe and clean double Lake
    const aliasSet = new Set();
    const aliases = [];
    for (let a of rawAliases) {
      a = String(a).replace(/\s+/g, ' ').trim();
      a = a.replace(/^Lake Lake /i, 'Lake ');
      if (!a || aliasSet.has(a.toLowerCase())) continue;
      if (a.toLowerCase() === lakeName.toLowerCase()) continue; // primary name not alias
      aliasSet.add(a.toLowerCase());
      aliases.push(a);
    }
    const canonicalLake = {
      name: lakeName,
      baseName,
      state: stateName,
      aliases,
      sanitizedId: sanitizedLake,
      metadata: {
        lastIdentified: new Date().toISOString()
      }
    };
    log(`Canonical details resolved: ${JSON.stringify(canonicalLake)}`);

    // ----------------------------------------------------
    // STEP 1b: Deterministic facts (owner + seeded drawdown sources)
    // ----------------------------------------------------
    setProgress("Step 1b: Loading deterministic facts...", 18);
    let deterministicProfile = null;
    let reservoirOwner = null;
    let seededDiscoveryTargets = [];
    try {
      const detRes = await fetch(`${CF_WORKER_URL}/research/deterministic-facts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lakeName, state: stateName })
      });
      if (detRes.ok) {
        const detData = await detRes.json();
        if (detData.ok && detData.profile) {
          deterministicProfile = detData.profile;
          reservoirOwner = detData.profile.identity?.reservoirOwner || null;
          seededDiscoveryTargets = Array.isArray(detData.seededDiscoveryTargets) ? detData.seededDiscoveryTargets : [];
          log(`✔ Deterministic baseline loaded — owner: ${reservoirOwner || 'unknown'}, seeded drawdown targets: ${seededDiscoveryTargets.length}`);
        }
      } else {
        log(`⚠️ Deterministic facts HTTP ${detRes.status} — continuing discovery without owner seeding`);
      }
    } catch (e) {
      log(`⚠️ Deterministic facts fetch failed: ${e.message} — continuing without owner seeding`);
    }

    // ----------------------------------------------------
    // STEP 2: Source Discovery
    // ----------------------------------------------------
    setProgress("Step 2: Scoping Trusted Repositories & Scrapers...", 25);
    log("Calling /research/discover API for state & federal sources...");
    const discoverRes = await fetch(`${CF_WORKER_URL}/research/discover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lakeName, state: stateName, reservoirOwner })
    });
    if (!discoverRes.ok) {
      const snippet = await discoverRes.text().catch(() => '').then(t => t.slice(0, 300));
      throw new Error(`Source Discovery HTTP ${discoverRes.status}: ${snippet}`);
    }
    let discoverData;
    try {
      const txt = await discoverRes.text();
      discoverData = JSON.parse(txt);
    } catch (e) {
      throw new Error(`Source Discovery non-JSON response (worker not deployed or 404): ${e.message}`);
    }
    if (!discoverData.success) {
      throw new Error(`Source Discovery Failed: ${discoverData.error || 'Unknown error'}`);
    }

    let sources = discoverData.sources || [];
    log(`Source Discovery completed. Discovered ${sources.length} trusted documents/URLs.`);
    // Log discover query results for visibility into what Firecrawl found/filtered
    if (discoverData.queryLog?.length) {
      for (const line of discoverData.queryLog) log(`[discover] ${line}`);
    }
    sources.forEach(src => {
      log(`• [Priority ${src.priority}] ${src.title} (${src.authority}) - ${src.type}`);
    });

    // ----------------------------------------------------
    // STEP 2b: Dataset hunt (EPA NSCEP / agency reports)
    // EPA "Report on Lake …" series is often the best limnology source for
    // tristate reservoirs. Merge top hits into the download queue.
    // ----------------------------------------------------
    try {
      setProgress("Step 2b: Hunting EPA NSCEP & agency datasets...", 32);
      log("Calling /research/dataset-hunt for EPA NSCEP + agency report URLs...");
      const huntRes = await fetch(`${CF_WORKER_URL}/research/dataset-hunt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lakeName, state: stateName })
      });
      if (huntRes.ok) {
        const huntData = await huntRes.json();
        const datasets = huntData.datasets || [];
        log(`Dataset hunt returned ${datasets.length} candidates (firecrawl=${!!huntData.firecrawlUsed}, tavily=${!!huntData.tavilyUsed}).`);
        // For NEPIS/ZyNET URLs, normalize on the File= parameter (document ID) not the base URL
        // since ZyNET.exe is the same for all documents — the File= param identifies the actual doc
        const normalizeUrl = (url) => {
          const s = String(url || '');
          const fileMatch = s.match(/[?&]File=([^&]+)/i);
          if (fileMatch) return 'nepis:' + decodeURIComponent(fileMatch[1]).toLowerCase();
          return s.split('?')[0].toLowerCase();
        };
        const seen = new Set(sources.map(s => normalizeUrl(s.url)));
        // Prefer EPA NSCEP + high-score PDFs/HTML; cap so we don't explode download time
        const epaFirst = [...datasets].sort((a, b) => {
          const aEpa = /epa|nepis/i.test(a.authority + a.url) ? 1 : 0;
          const bEpa = /epa|nepis/i.test(b.authority + b.url) ? 1 : 0;
          if (aEpa !== bEpa) return bEpa - aEpa;
          return (b.score || 0) - (a.score || 0);
        });
        let added = 0;
        let epaAdded = 0;
        const maxAdd = 12; // raised from 6 — context windows can handle more sources now
        // Per-domain caps prevent any single site flooding the queue
        const DOMAIN_CAPS = {
          'nepis.epa.gov': 1,
          'epa.gov': 2,
          'carolinasportsman.com': 4,
          'dnr.sc.gov': 3,
          'ncwildlife.org': 3,
          'georgiawildlife.com': 3,
          'gameandfishmag.com': 2,
          'in-fisherman.com': 2,
          'bassmaster.com': 2,
          'saludahydrorelicense.com': 3,
          'parrfairfieldrelicense.com': 3,
          'duke-energy.com': 3,
        };
        const domainCounts = {};
        for (const d of epaFirst) {
          if (added >= maxAdd) break;
          const norm = normalizeUrl(d.url);
          const scoreVal = d.score || 0;
          const titleSnip = (d.title || d.url).slice(0, 80);
          if (!d.url || seen.has(norm)) {
            log(`  ✗ skip (dupe): ${titleSnip}`);
            continue;
          }
          // Reject non-SC/NC/GA state agency documents
          if (/michigandnr\.com|michigan\.gov.*dnr|mndnr\.gov|dnr\.wi\.gov|dnr\.illinois|in\.gov.*dnr|\.gc\.ca|dfo-mpo\.gc\.ca/i.test(d.url)) {
            log(`  ✗ skip (foreign/other-state agency): ${titleSnip}`);
            continue;
          }
          const isEpa = /nepis\.epa\.gov|epa\.gov|ZyActionD|ZyPDF/i.test(d.url + (d.authority || ''));
          // Per-domain cap check
          let hostname = '';
          try { hostname = new URL(d.url).hostname.replace(/^www\./,''); } catch(e) {}
          const domainCap = DOMAIN_CAPS[hostname] || 5;
          domainCounts[hostname] = domainCounts[hostname] || 0;
          if (domainCounts[hostname] >= domainCap) {
            log(`  ✗ skip (domain cap ${domainCap} for ${hostname}): ${titleSnip}`);
            continue;
          }
          // Limit to at most 1 EPA report per lake
          if (isEpa && epaAdded >= 1) {
            log(`  ✗ skip (EPA cap reached): ${titleSnip}`);
            continue;
          }
          if (!isEpa && scoreVal < 30) {
            log(`  ✗ skip (score ${scoreVal} < 30): ${titleSnip}`);
            continue;
          }
          seen.add(norm);
          domainCounts[hostname] = (domainCounts[hostname] || 0) + 1;
          sources.push({
            title: d.title || `Dataset: ${d.url}`,
            type: d.type || (/\.pdf$/i.test(d.url) || /ZyPDF/i.test(d.url) ? 'PDF' : 'HTML'),
            authority: d.authority || (isEpa ? 'EPA NSCEP' : 'Web'),
            url: d.url,
            priority: isEpa ? 1 : 2,
            source: d.source || 'dataset_hunt',
            score: scoreVal
          });
          added++;
          if (isEpa) epaAdded++;
          log(`  ✓ added (score ${scoreVal}): ${titleSnip}`);
        }
        // Log all remaining candidates that didn't make the cut
        for (const d of epaFirst) {
          const norm = normalizeUrl(d.url);
          if (seen.has(norm)) continue; // already logged above
          const scoreVal = d.score || 0;
          const titleSnip = (d.title || d.url).slice(0, 80);
          log(`  — candidate (score ${scoreVal}, not added): ${titleSnip}`);
        }
        log(`Merged ${added} dataset-hunt sources into download queue (total ${sources.length}).`);
      } else {
        log(`⚠️ Dataset hunt HTTP ${huntRes.status} — continuing with discover sources only.`);
      }
    } catch (e) {
      log(`⚠️ Dataset hunt failed: ${e.message} — continuing with discover sources only.`);
    }



    // ----------------------------------------------------
    // STEP 3 & 4: Download & Extraction (CORS Proxy + Client PDF.js)
    // ----------------------------------------------------
    setProgress("Step 3-4: Downloading & Extracting Sources (CORS Bypassed)...", 45);
    const normalizedDocuments = [];

    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      log(`Processing [${i + 1}/${sources.length}] ${src.title}...`);

      // skip oversized PDFs early (client memory protection)
      if (src.type === 'PDF' && src.title.toLowerCase().includes('pocket guide')) {
        log(`⚠️ Skipping huge generic pocket guide PDF (50MB) — low lake-specific value.`);
        continue;
      }

      if (src.type === 'PDF') {
        log(`Using Cloudflare Proxy to fetch PDF: ${src.url}`);
        const proxyRes = await fetch(`${CF_WORKER_URL}/research/proxy-download?url=${encodeURIComponent(src.url)}`);
        if (!proxyRes.ok) {
          log(`⚠️ Failed to download PDF: ${src.title} (HTTP ${proxyRes.status}). Skipping document.`);
          continue;
        }
        const arrayBuffer = await proxyRes.arrayBuffer();
        if (arrayBuffer.byteLength > 25 * 1024 * 1024) {
          log(`⚠️ PDF too large (${(arrayBuffer.byteLength/1024/1024).toFixed(1)}MB) — skipping to protect browser memory. URL: ${src.url}`);
          continue;
        }
        log(`PDF raw binary streamed to browser (${arrayBuffer.byteLength} bytes). Processing text extract in browser thread...`);
        
        try {
          const extraction = await extractTextFromPDFBytes(arrayBuffer, (current, total) => {
            setProgress(`Extracting PDF pages: ${current}/${total}`, 45 + (i / sources.length) * 15);
          });
          
          normalizedDocuments.push({
            title: src.title,
            authority: src.authority,
            url: src.url,
            priority: src.priority,
            fullText: extraction.fullText,
            pages: extraction.pages,
            downloadDate: new Date().toISOString(),
            contentType: 'application/pdf'
          });
          log(`Successfully extracted ${extraction.pages.length} pages of text. Discarded binary from browser memory.`);
        } catch (pdfErr) {
          log(`⚠️ Error parsing PDF client-side: ${pdfErr.message}. Skipping.`);
        }
      } else {
        // HTML / TEXT — route through Firecrawl via proxy for better extraction
        log(`Fetching webpage via Firecrawl: ${src.url}`);
        const proxyRes = await fetch(`${CF_WORKER_URL}/research/proxy-download?url=${encodeURIComponent(src.url)}&type=HTML`);
        if (!proxyRes.ok) {
          log(`⚠️ Failed to scrape page: ${src.title} (HTTP ${proxyRes.status}). Skipping document.`);
          continue;
        }

        const isFirecrawl = proxyRes.headers.get('X-Source') === 'firecrawl';
        const nepisFormat = proxyRes.headers.get('X-Nepis-Format') || '';
        const nepisTitle = proxyRes.headers.get('X-Nepis-Title') || '';
        const text = await proxyRes.text();

        // If Firecrawl returned markdown, use it directly — no HTML stripping needed
        const cleanedText = isFirecrawl ? text : text
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        if (cleanedText.length < 200) {
          log(`⚠️ Page content too short (${cleanedText.length} chars) — likely blocked or 404. Skipping.`);
          continue;
        }

        log(`${isFirecrawl ? 'Firecrawl' : 'Basic'} extracted ${cleanedText.length} chars from ${src.title}${nepisFormat ? ` [nepis:${nepisFormat}]` : ''}`);

        normalizedDocuments.push({
          title: nepisTitle || src.title,
          authority: src.authority || (/nepis|epa/i.test(src.url) ? 'EPA NSCEP' : src.authority),
          url: src.url,
          priority: src.priority,
          fullText: cleanedText,
          pages: [{ pageNumber: 1, text: cleanedText, title: nepisTitle || src.title }],
          downloadDate: new Date().toISOString(),
          contentType: isFirecrawl ? 'text/markdown' : 'text/html',
          extractionMethod: isFirecrawl ? (nepisFormat ? `firecrawl_nepis_${nepisFormat}` : 'firecrawl') : 'basic'
        });
        log(`Webpage extracted & normalized successfully.`);

        // EPA NSCEP search-results page may list multiple document landing URLs —
        // follow up on the first few so full report text becomes evidence.
        if (nepisFormat === 'search_results') {
          let docUrls = [];
          try {
            const hdr = proxyRes.headers.get('X-Nepis-Documents');
            if (hdr) docUrls = JSON.parse(hdr);
          } catch (_) {}
          // Also scrape markdown catalog for ZyActionD links
          if (!docUrls.length) {
            const found = cleanedText.match(/https?:\/\/[^\s)"\]]+ZyActionD[^\s)"\]]*/g) || [];
            docUrls = [...new Set(found)].slice(0, 5);
          }
          const follow = (Array.isArray(docUrls) ? docUrls : []).slice(0, 1);
          for (const docUrl of follow) {
            if (!docUrl || normalizedDocuments.some(d => d.url === docUrl)) continue;
            try {
              log(`  ↳ Following EPA NSCEP document: ${docUrl.slice(0, 100)}…`);
              const docRes = await fetch(`${CF_WORKER_URL}/research/proxy-download?url=${encodeURIComponent(docUrl)}&type=HTML`);
              if (!docRes.ok) {
                log(`  ⚠️ EPA doc follow-up failed HTTP ${docRes.status}`);
                continue;
              }
              const docText = await docRes.text();
              if (docText.length < 200) continue;
              const docTitle = docRes.headers.get('X-Nepis-Title') || `EPA NSCEP document`;
              normalizedDocuments.push({
                title: docTitle,
                authority: 'EPA NSCEP',
                url: docUrl,
                priority: 1,
                fullText: docText,
                pages: [{ pageNumber: 1, text: docText, title: docTitle }],
                downloadDate: new Date().toISOString(),
                contentType: 'text/markdown',
                extractionMethod: `firecrawl_nepis_${docRes.headers.get('X-Nepis-Format') || 'landing'}`
              });
              log(`  ✔ EPA doc extracted ${docText.length} chars: ${docTitle.slice(0, 80)}`);
            } catch (e) {
              log(`  ⚠️ EPA doc follow-up error: ${e.message}`);
            }
          }
        }
      }
    }

    // Owner-aware seeded drawdown / operations sources: fetch and merge into
    // normalized documents so fact extraction can surface lake-level ranges,
    // seasonal drawdown schedules, and operations facts from the authority.
    if (seededDiscoveryTargets.length > 0) {
      setProgress("Step 4b: Fetching owner-seeded drawdown / operations sources...", 62);
      log(`Fetching ${seededDiscoveryTargets.length} owner-aware seeded source(s)...`);
      for (const seed of seededDiscoveryTargets) {
        if (!seed?.url) continue;
        if (normalizedDocuments.some(d => d.url === seed.url)) {
          log(`• ${seed.label} already in download queue — skipping`);
          continue;
        }
        log(`Processing seeded source: ${seed.label} (${seed.url})`);
        try {
          const isPdf = String(seed.type || '').toUpperCase() === 'PDF' || /\.pdf$/i.test(seed.url);
          if (isPdf) {
            const proxyRes = await fetch(`${CF_WORKER_URL}/research/proxy-download?url=${encodeURIComponent(seed.url)}`);
            if (!proxyRes.ok) {
              log(`⚠️ Failed to download seeded PDF: ${seed.label} (HTTP ${proxyRes.status})`);
              continue;
            }
            const arrayBuffer = await proxyRes.arrayBuffer();
            if (arrayBuffer.byteLength > 25 * 1024 * 1024) {
              log(`⚠️ Seeded PDF too large (${(arrayBuffer.byteLength/1024/1024).toFixed(1)}MB) — skipping`);
              continue;
            }
            const extraction = await extractTextFromPDFBytes(arrayBuffer, (current, total) => {
              setProgress(`Extracting seeded PDF pages: ${current}/${total}`, 62 + (current / total) * 2);
            });
            normalizedDocuments.push({
              title: seed.label,
              authority: seed.authority,
              url: seed.url,
              priority: 1,
              fullText: extraction.fullText,
              pages: extraction.pages,
              downloadDate: new Date().toISOString(),
              contentType: 'application/pdf'
            });
            log(`✔ Seeded PDF extracted ${extraction.pages.length} pages`);
          } else {
            const proxyRes = await fetch(`${CF_WORKER_URL}/research/proxy-download?url=${encodeURIComponent(seed.url)}&type=HTML`);
            if (!proxyRes.ok) {
              log(`⚠️ Failed to scrape seeded page: ${seed.label} (HTTP ${proxyRes.status})`);
              continue;
            }
            const isFirecrawl = proxyRes.headers.get('X-Source') === 'firecrawl';
            const text = await proxyRes.text();
            const cleanedText = isFirecrawl ? text : text
              .replace(/<script[\s\S]*?<\/script>/gi, " ")
              .replace(/<style[\s\S]*?<\/style>/gi, " ")
              .replace(/<[^>]+>/g, " ")
              .replace(/&nbsp;/g, " ")
              .replace(/&amp;/g, "&")
              .replace(/\s+/g, " ")
              .trim();
            if (cleanedText.length < 200) {
              log(`⚠️ Seeded page content too short (${cleanedText.length} chars) — likely blocked`);
              continue;
            }
            normalizedDocuments.push({
              title: seed.label,
              authority: seed.authority,
              url: seed.url,
              priority: 1,
              fullText: cleanedText,
              pages: [{ pageNumber: 1, text: cleanedText, title: seed.label }],
              downloadDate: new Date().toISOString(),
              contentType: isFirecrawl ? 'text/markdown' : 'text/html',
              extractionMethod: isFirecrawl ? 'firecrawl' : 'basic'
            });
            log(`✔ Seeded page extracted ${cleanedText.length} chars`);
          }
        } catch (seedErr) {
          log(`⚠️ Seeded source error for ${seed.label}: ${seedErr.message}`);
        }
      }
    }

    if (normalizedDocuments.length === 0) {
      throw new Error("No sources were successfully downloaded or extracted. Incomplete pipeline.");
    }

    // Save normalized documents back to the worker R2 normalized folder
    setProgress("Uploading normalized evidence JSON back to R2...", 65);
    log(`Saving ${normalizedDocuments.length} normalized text extracts to R2 normalized/ directory.`);
    await fetch(`${CF_WORKER_URL}/research/save-normalized`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lakeName, documents: normalizedDocuments })
    });

    // ----------------------------------------------------
    // STEP 5 & 6: Source Quality Scoring & Classification
    // ----------------------------------------------------
    setProgress("Step 5-6: Running Quality Scoring & Classification...", 75);
    log("Computing scores based on authority trustworthiness rules...");
    const scoredSources = scoreDocuments(normalizedDocuments, baseName, lakeName);
    log(`Scoring and classification completed:`);
    scoredSources.forEach(s => {
      log(`• ${s.title}: auth=${s.scoring.authority} rel=${s.scoring.relevance} fresh=${s.scoring.freshness} comp=${s.scoring.completeness} => composite=${s.scoring.composite} classes=${s.classes.join(', ')}`);
    });

    await runPipelineTail(lakeName, baseName, stateName, normalizedDocuments, scoredSources, callbacks);

  } catch (err) {
    log(`❌ Pipeline Aborted: ${err.message}`);
    alert(`Evidence Pipeline Failed: ${err.message}`);
    setProgress("Failed", 0);
  } finally {
    _state.researchInProgress = false;
  }
}



async function runPipelineTail(lakeName, baseName, stateName, normalizedDocuments, scoredSources, callbacks = {}) {
    // ----------------------------------------------------
    // STEP 7: Fact extraction (quoted/source-backed only)
    // ----------------------------------------------------
    setProgress("Step 7: Extracting verified facts from documents...", 50);
    log("Per-document extraction — one LLM call per document, no trimming...");

    // Filter index/search pages by URL density in raw text
    const isRawIndexPage = (doc) => {
      const raw = doc.fullText || '';
      const urlMatches = (raw.match(/https?:\/\//g) || []).length;
      const words = raw.split(/\s+/).length;
      return urlMatches > 40 && urlMatches / words > 0.15;
    };

    const usableDocuments = normalizedDocuments.filter(d => {
      if (!d.fullText || d.fullText.length < 100) return false;
      if (isRawIndexPage(d)) { log(`⚠️ Skipping index/search page: ${d.title?.slice(0,50)}`); return false; }
      return true;
    });

    log(`Extracting from ${usableDocuments.length} documents (skipped ${normalizedDocuments.length - usableDocuments.length})`);

    // Call /research/analyze-facts once per document — no batching, no trimming
    const allDocFacts = [];
    for (let i = 0; i < usableDocuments.length; i++) {
      // 1.5s spacing keeps burst under Gemini Flash Lite's 15 RPM limit and provides TPM headroom (~167K TPM),
      // reducing cascades to the 2.5 Flash/Lite models which only have 20 RPD each.
      if (i > 0) await new Promise(res => setTimeout(res, 1500));
      const doc = usableDocuments[i];
      const scored = scoredSources.find(s => s.title === doc.title);
      // Cap document text at 200k chars — large PDFs (200k+) still get trimmed but
      // Gemini 3.1 Flash Lite / 2.5 Flash have 1M token context windows so 200k chars
      // (~50k tokens) is well within budget. Old 80k cap was from Groq era.
      const docText = (doc.fullText || '').slice(0, 200000);
      const singlePayload = {
        lakeName,
        baseName,
        state: stateName,
        documents: [{
          title: doc.title,
          url: doc.url || '',
          text: docText,
          quality: scored ? { ...scored.scoring, classes: scored.classes || [] } : {}
        }]
      };
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45000); // 45s per doc max
        let res;
        try {
          res = await fetch(`${CF_WORKER_URL}/research/analyze-facts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(singlePayload),
            signal: controller.signal
          });
        } finally {
          clearTimeout(timeout);
        }
        if (!res.ok) {
          log(`⚠️ Doc [${i+1}/${usableDocuments.length}] "${doc.title?.slice(0,40)}" HTTP ${res.status} — skipping`);
          continue;
        }
        const data = await res.json();
        if (data.success && data.extracted_facts?.length) {
          allDocFacts.push(...data.extracted_facts);
          log(`📄 [${i+1}/${usableDocuments.length}] "${doc.title?.slice(0,50)}" → ${data.extracted_facts.length} facts`);
        } else {
          log(`📄 [${i+1}/${usableDocuments.length}] "${doc.title?.slice(0,50)}" → 0 facts`);
        }
      } catch (e) {
        if (e.name === 'AbortError') {
          log(`⚠️ Doc [${i+1}] "${doc.title?.slice(0,40)}" timed out after 45s — skipping`);
        } else {
          log(`⚠️ Doc [${i+1}] "${doc.title?.slice(0,40)}" failed: ${e.message}`);
        }
      }
    }

    let rawFacts = allDocFacts;
    log(`Deep scan extracted ${rawFacts.length} verified facts across ${usableDocuments.length} documents.`);
    rawFacts.forEach(f => {
      log(`💬 [${f.category}] "${f.fact?.slice(0,80)}" (${f.confidence}%) - ${f.source?.slice(0,40)}`);
    });;

    // ----------------------------------------------------
    // STEP 8: Deduplication
    // ----------------------------------------------------
    setProgress("Step 8: Deduplicating facts...", 60);
    let uniqueFacts = rawFacts;
    let contradictions = [];
    if (rawFacts.length > 0) {
      log("Deduplicating identical facts and checking for anomalies...");
      try {
        const dedupeRes = await fetch(`${CF_WORKER_URL}/research/dedupe-contradictions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ facts: rawFacts })
        });
        if (dedupeRes.ok) {
          const dedupeData = await dedupeRes.json();
          uniqueFacts = dedupeData.deduplicated_facts || rawFacts;
          contradictions = dedupeData.contradictions || [];
        }
      } catch (e) {
        log(`⚠️ Dedupe failed: ${e.message} — using raw facts`);
      }
      log(`Deduplicated facts count: ${uniqueFacts.length}.`);
      if (contradictions.length > 0) {
        log(`⚠️ ${contradictions.length} contradictions detected:`);
        contradictions.forEach(c => log(`👉 [${c.field}]: "${c.factA}" vs "${c.factB}"`));
      }
    } else {
      log("Skipping dedup — no facts to process.");
    }

    // ----------------------------------------------------
    // STEP 9: Deterministic baseline + WQP surface/profile data
    // ----------------------------------------------------
    setProgress("Step 9: Building factual lake baseline...", 66);
    let deterministicProfile = { identity: {}, biology: {}, limnology: {}, habitat: {}, navigation: {}, regulations: {}, summary: {}, evidence: {}, sources: [] };
    try {
      const detRes = await fetch(`${CF_WORKER_URL}/research/deterministic-facts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lakeName, state: stateName })
      });
      if (detRes.ok) {
        const detData = await detRes.json();
        if (detData.ok && detData.profile) {
          deterministicProfile = detData.profile;
          const genCreel = Object.keys(detData.profile.regulations?.generalStateRegulations?.creelLimits || {}).length;
          const genLen = Object.keys(detData.profile.regulations?.generalStateRegulations?.lengthLimits || {}).length;
          const lakeSize = Object.keys(detData.profile.regulations?.lakeSpecificRegulations?.sizeLimits || {}).length;
          const lakeCreel = Object.keys(detData.profile.regulations?.lakeSpecificRegulations?.creelLimits || {}).length;
          log(`✔ Deterministic baseline loaded — identity=${Object.keys(detData.profile.identity || {}).length}, predatorSpecies=${detData.profile.biology?.predatorSpecies?.length || 0}, ramps=${detData.profile.navigation?.ramps?.length || 0}, regs(gen creel=${genCreel}/len=${genLen}, lake size=${lakeSize}/creel=${lakeCreel})`);
          if (detData.profile._regsDebug) {
            const d = detData.profile._regsDebug;

          }
          if (!genCreel && !genLen && !lakeSize) {
            log('⚠️ Regulations section empty after deterministic parse — check that eRegulations is in normalized docs and FIRECRAWL_API_KEY is set on the worker.');
          }
        }
      }
    } catch (e) {
      log(`⚠️ Deterministic baseline unavailable: ${e.message}`);
    }

    try {
      const geoStruct = await deriveGeospatialStructureFacts(lakeName);
      if (geoStruct) {
        deterministicProfile.habitat = mergeMissing(deterministicProfile.habitat || {}, geoStruct.habitat || {});
        if (geoStruct.habitat?.notes) {
          deterministicProfile.habitat.notes = [deterministicProfile.habitat.notes, geoStruct.habitat.notes].filter(Boolean).join(' ');
        }
        deterministicProfile.evidence = mergeEvidenceMaps(deterministicProfile.evidence || {}, geoStruct.evidence || {});
        deterministicProfile.sources = [...(deterministicProfile.sources || []), ...(geoStruct.sources || [])];
        log(`✔ Geospatial structure adapter loaded — ${Object.keys(geoStruct.habitat?.structuralElements || {}).join(', ') || 'structure notes'}`);
      } else {
        log('⚠️ Geospatial structure adapter found no supported structural fields for this lake.');
      }
    } catch (e) {
      log(`⚠️ Geospatial structure adapter failed: ${e.message}`);
    }

    let wqpLimnology = null;
    try {
      const geoRes = await fetch(`${CF_WORKER_URL}/chartpacks/lake-boundary?lake=${encodeURIComponent(lakeName)}`);
      let bbox = null;
      if (geoRes.ok) {
        const geo = await geoRes.json();
        const coords = [];
        const extractCoords = (obj) => {
          if (!obj) return;
          if (obj.type === 'Feature') extractCoords(obj.geometry);
          else if (obj.type === 'FeatureCollection') obj.features?.forEach(extractCoords);
          else if (obj.coordinates) {
            const flat = obj.coordinates.flat(Infinity);
            for (let i = 0; i < flat.length - 1; i += 2) coords.push([flat[i], flat[i+1]]);
          }
        };
        extractCoords(geo);
        if (coords.length) {
          const lons = coords.map(c => c[0]);
          const lats = coords.map(c => c[1]);
          bbox = { bboxNorth: Math.max(...lats), bboxSouth: Math.min(...lats), bboxEast: Math.max(...lons), bboxWest: Math.min(...lons) };
        }
      }
      if (bbox) {
        const wqpRes = await fetch(`${CF_WORKER_URL}/research/limnology-data`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lakeName, ...bbox })
        });
        if (wqpRes.ok) {
          const wqpData = await wqpRes.json();
          if (wqpData.ok && wqpData.recordCount > 0) {
            wqpLimnology = wqpData;
            const thermoMsg = wqpData.thermocline ? `${wqpData.thermocline.depthFt}ft (${wqpData.thermocline.method})` : 'not derived';
            const surfMsg = wqpData.surfaceWater?.recentTempF != null ? `surface ${wqpData.surfaceWater.recentTempF}°F / DO ${wqpData.surfaceWater.recentDissolvedOxygenMgL ?? '?'} mg/L` : 'surface summary unavailable';
            log(`✔ WQP: ${wqpData.recordCount} records — thermocline ${thermoMsg}; ${surfMsg}`);
          } else {
            log(`⚠️ WQP: ${wqpData.note || 'no data found for this lake boundary'}`);
          }
        }
      } else {
        log("⚠️ WQP: could not derive lake boundary bbox — skipping limnology data fetch");
      }
    } catch (e) {
      log(`⚠️ WQP limnology fetch failed: ${e.message} — continuing without measured data`);
    }

    // ----------------------------------------------------
    // STEP 10: Fact-only section assembly (no inferred tactics)
    // Apply extracted facts to fill gaps in deterministic profile
    // ----------------------------------------------------
    setProgress("Step 10: Assembling factual profile...", 84);

    // Fill null identity fields from extracted facts — direct mapping, no buildFinalResearchPacket needed
    if (uniqueFacts.length > 0) {
      const getFactVal = (categories) => {
        for (const cat of categories) {
          const f = uniqueFacts.find(f => String(f.category||'').toLowerCase() === cat.toLowerCase());
          if (f) return f.fact;
        }
        return null;
      };
      const parseNum = (s) => { const n = parseFloat(String(s||'').replace(/[^0-9.]/g,'')); return isFinite(n) ? n : null; };
      const id = deterministicProfile.identity;
      if (id.surfaceAreaAcres == null) id.surfaceAreaAcres = parseNum(getFactVal(['surfaceArea','surfaceAreaAcres']));
      if (id.maxDepthFt == null)       id.maxDepthFt       = parseNum(getFactVal(['maxDepthFt','maxDepth']));
      if (id.averageDepthFt == null)   id.averageDepthFt   = parseNum(getFactVal(['averageDepthFt','averageDepth']));
      if (!id.archetype)               id.archetype        = getFactVal(['archetype']);
      if (!id.damName)                 id.damName          = getFactVal(['damName']);
      if (id.yearImpounded == null)    id.yearImpounded    = parseNum(getFactVal(['yearImpounded']));
      if (!id.reservoirOwner)          id.reservoirOwner   = getFactVal(['reservoirOwner']);
      if (!id.riverSystem)             id.riverSystem      = getFactVal(['riverSystem']);
      if (id.normalPoolFt == null)     id.normalPoolFt     = parseNum(getFactVal(['poolLevel','normalPoolFt']));
      // Fill limnology gaps from facts
      const lim = deterministicProfile.limnology;
      if (!lim.thermocline) lim.thermocline = {};
      if (lim.thermocline.summerDepthFt == null) {
        const tv = getFactVal(['thermocline']);
        if (tv) lim.thermocline.note = (lim.thermocline.note ? lim.thermocline.note + ' ' : '') + tv;
      }
      if (!lim.trophicStatus) lim.trophicStatus = getFactVal(['trophicStatus']);
    }

    const agentSections = {
      identity: cloneJson(deterministicProfile.identity || {}),
      biology: cloneJson(deterministicProfile.biology || {}),
      habitat: cloneJson(deterministicProfile.habitat || {}),
      navigation: cloneJson(deterministicProfile.navigation || {}),
      regulations: cloneJson(deterministicProfile.regulations || {}),
      limnology: applyWqpToLimnology(deterministicProfile.limnology || {}, wqpLimnology),
      summary: cloneJson(deterministicProfile.summary || {})
    };


    const evidence = mergeEvidenceMaps(deterministicProfile.evidence || {}, buildWqpEvidence(wqpLimnology));
    const factualSummary = buildDeterministicSummary({ lakeName, identity: agentSections.identity, biology: agentSections.biology, limnology: agentSections.limnology, habitat: agentSections.habitat });
    if (factualSummary) {
      agentSections.summary = { text: factualSummary, keywords: deterministicProfile.summary?.keywords || [] };
      evidence.summary = evidence.summary || {};
      evidence.summary.text = (evidence.summary.text || []).concat([buildEvidenceEntry('internal_synthesis', 'TrollMap deterministic profile synthesis', 'internal:deterministic-facts', null, 'deterministic_fact_synthesis')]);
    }

    // ----------------------------------------------------
    // STEP 11: Agent enrichment — runs 3 targeted LLM agents using extracted facts
    // Each agent receives the facts most relevant to its domain
    // ----------------------------------------------------
    setProgress("Step 11: Running agent enrichment...", 88);

    const agentGroups = [
      { key: 'identity_limnology', agents: ['identity', 'limnology'] },
      { key: 'biology_habitat',    agents: ['biology', 'habitat'] },
      { key: 'regulations',        agents: ['regulations'] },
    ];

    for (const group of agentGroups) {
      for (const agentKey of group.agents) {
        try {
          // Delay between agents to avoid burst rate limiting across providers
          await new Promise(res => setTimeout(res, 3000));
          log(`Running ${agentKey} agent...`);
          // Retry agent once on 502 (provider rate limit) after a longer pause
          let agentRes = await fetch(`${CF_WORKER_URL}/research/agent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              lakeName,
              state: stateName,
              agent: agentKey,
              previousResults: {
                ...agentSections,
                _extractedFacts: uniqueFacts,
                _normalizedDocuments: normalizedDocuments.slice(0, 12).map(d => ({
                  title: d.title,
                  url: d.url,
                  text: (d.fullText || '').slice(0, 40000)
                }))
              }
            })
          });
          // Retry once on 502 after 5s pause (provider rate limit)
          if (agentRes.status === 502) {
            log(`⚠️ ${agentKey} agent 502 — retrying after 5s...`);
            await new Promise(res => setTimeout(res, 5000));
            agentRes = await fetch(`${CF_WORKER_URL}/research/agent`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                lakeName,
                state: stateName,
                agent: agentKey,
                previousResults: {
                  ...agentSections,
                  _extractedFacts: uniqueFacts,
                  _normalizedDocuments: normalizedDocuments.slice(0, 12).map(d => ({
                    title: d.title,
                    url: d.url,
                    text: (d.fullText || '').slice(0, 40000)
                  }))
                }
              })
            });
          }
          if (agentRes.ok) {
            const agentData = await agentRes.json();
            if (agentData.success && agentData.section) {
              // Merge agent result — never overwrite deterministic fields with empty arrays
              const existing = agentSections[agentKey] || {};
              const merged = { ...existing };
              for (const [k, v] of Object.entries(agentData.section)) {
                if (v == null) continue;
                if (Array.isArray(v) && v.length === 0 && Array.isArray(existing[k]) && existing[k].length > 0) continue;
                merged[k] = v;
              }
              // Deep-merge lakeSpecificRegulations for regulations agent —
              // only overwrite creelLimits/sizeLimits if agent returned a non-empty object.
              // Prevents sanitized-empty {} from wiping deterministic parser's correct data.
              if (agentKey === 'regulations' && agentData.section?.lakeSpecificRegulations) {
                const existingLsr = existing.lakeSpecificRegulations || {};
                const agentLsr = agentData.section.lakeSpecificRegulations;
                const mergedCreel = (agentLsr.creelLimits && typeof agentLsr.creelLimits === 'object' && !Array.isArray(agentLsr.creelLimits) && Object.keys(agentLsr.creelLimits).length > 0)
                  ? agentLsr.creelLimits
                  : (existingLsr.creelLimits && typeof existingLsr.creelLimits === 'object' ? existingLsr.creelLimits : {});
                const mergedSize = (agentLsr.sizeLimits && typeof agentLsr.sizeLimits === 'object' && !Array.isArray(agentLsr.sizeLimits) && Object.keys(agentLsr.sizeLimits).length > 0)
                  ? agentLsr.sizeLimits
                  : (existingLsr.sizeLimits && typeof existingLsr.sizeLimits === 'object' ? existingLsr.sizeLimits : {});
                merged.lakeSpecificRegulations = {
                  ...existingLsr,
                  ...agentLsr,
                  creelLimits: mergedCreel,
                  sizeLimits: mergedSize,
                };
              }
              agentSections[agentKey] = merged;
              if (agentKey === 'biology') {
                // Always use the LONGER species list — agents should add, never remove
                const detSpecies = deterministicProfile.biology?.predatorSpecies || [];
                const agentSpecies = merged.predatorSpecies || [];
                const existingSpecies = existing.predatorSpecies || [];
                // Merge all three lists — take the union
                const allSpecies = [...new Set([...detSpecies, ...existingSpecies, ...agentSpecies])];
                agentSections.biology.predatorSpecies = allSpecies.length ? allSpecies : detSpecies;
                // Stockings: use agent result if non-empty, otherwise keep existing
                agentSections.biology.knownStockings = merged.knownStockings?.length ? merged.knownStockings : (existing.knownStockings?.length ? existing.knownStockings : (deterministicProfile.biology?.knownStockings || []));
              }
              log(`✔ ${agentKey} agent complete (${agentData.confidence?.percent || '?'}% via ${agentData.meta?.model || '?'})`);
            }
          } else {
            const errSnippet = await agentRes.text().catch(() => '').then(t => t.slice(0, 300));
            log(`⚠️ ${agentKey} agent HTTP ${agentRes.status} — skipping. Response: ${errSnippet}`);
          }
        } catch (e) {
          log(`⚠️ ${agentKey} agent failed: ${e.message} — skipping`);
        }
      }
    }

    // ----------------------------------------------------
    // STEP 11b: Validation pass — fill null critical fields from extracted facts
    // One targeted LLM call using free-tier Flash Lite. Only runs if nulls exist.
    // ----------------------------------------------------
    try {
      const lim = agentSections.limnology || {};
      const ident = agentSections.identity || {};
      const nav = agentSections.navigation || {};
      const hab = agentSections.habitat || {};

      const nullFields = [];
      if (!lim.trophicStatus)                          nullFields.push('limnology.trophicStatus');
      if (!lim.flowCharacteristics)                    nullFields.push('limnology.flowCharacteristics');
      if (lim.seasonalDrawdownFt == null)              nullFields.push('limnology.seasonalDrawdownFt');
      if (!lim.thermocline?.summerDepthFt)             nullFields.push('limnology.thermocline.summerDepthFt');
      if (!lim.thermocline?.strength)                  nullFields.push('limnology.thermocline.strength');
      if (!lim.oxygen?.depletionDepthFt)               nullFields.push('limnology.oxygen.depletionDepthFt');
      if (!lim.oxygen?.anoxicBelowFt)                  nullFields.push('limnology.oxygen.anoxicBelowFt');
      if (!lim.waterClarity?.typical)                  nullFields.push('limnology.waterClarity.typical');
      if (!lim.waterClarity?.secchiFt)                 nullFields.push('limnology.waterClarity.secchiFt');
      if (!ident.county)                               nullFields.push('identity.county');
      if (!ident.normalPoolFt)                         nullFields.push('identity.normalPoolFt');
      if (!ident.gpsCenter)                            nullFields.push('identity.gpsCenter');
      if (!(nav.hazards?.length))                      nullFields.push('navigation.hazards');
      if (!hab.standingTimber)                         nullFields.push('habitat.standingTimber');

      if (nullFields.length > 0) {
        log(`Running validation pass for ${nullFields.length} null field(s)...`);

        // Build a facts block from the most relevant extracted facts
        const relevantFacts = uniqueFacts
          .filter(f => /trophic|eutrophic|mesotrophic|oligotrophic|thermocline|dissolved.oxygen|anox|hypox|secchi|clarity|turbid|pool.level|pool.elevation|drawdown|fluctuat|county|gps|lat|lon|hazard|stump|timber|flow.character|pumped.storage|run.of.river|daily.fluctuat/i.test(f.fact))
          .slice(0, 30)
          .map((f, i) => `[${i+1}] (${f.category}) ${f.fact}`)
          .join('\n');

        if (relevantFacts) {
                    const valRes = await fetch(`${CF_WORKER_URL}/research/validation-pass`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lakeName, nullFields, facts: relevantFacts })
          });

          if (valRes.ok) {
            const valData = await valRes.json();
            const valText = valData.result || '';
            try {
              const clean = valText.replace(/\`\`\`json|\`\`\`/g, '').trim();
              const filled = JSON.parse(clean);
              let fillCount = 0;

              for (const [dotKey, value] of Object.entries(filled)) {
                if (value == null) continue;
                const parts = dotKey.split('.');
                // Map dot-key back to agentSections
                if (parts[0] === 'limnology') {
                  agentSections.limnology = agentSections.limnology || {};
                  if (parts.length === 2) {
                    agentSections.limnology[parts[1]] = value;
                    fillCount++;
                  } else if (parts.length === 3) {
                    agentSections.limnology[parts[1]] = agentSections.limnology[parts[1]] || {};
                    agentSections.limnology[parts[1]][parts[2]] = value;
                    fillCount++;
                  }
                } else if (parts[0] === 'identity') {
                  agentSections.identity = agentSections.identity || {};
                  agentSections.identity[parts[1]] = value;
                  // Also apply to top-level researchPacket fields
                  if (parts[1] === 'county') agentSections._validationCounty = value;
                  if (parts[1] === 'normalPoolFt') agentSections._validationNormalPoolFt = value;
                  if (parts[1] === 'gpsCenter') agentSections._validationGpsCenter = value;
                  fillCount++;
                } else if (parts[0] === 'navigation') {
                  agentSections.navigation = agentSections.navigation || {};
                  agentSections.navigation[parts[1]] = value;
                  fillCount++;
                } else if (parts[0] === 'habitat') {
                  agentSections.habitat = agentSections.habitat || {};
                  agentSections.habitat[parts[1]] = value;
                  fillCount++;
                }
              }

              log(`✔ Validation pass filled ${fillCount} field(s)`);
            } catch (parseErr) {
              log(`⚠️ Validation pass JSON parse failed: ${parseErr.message}`);
            }
          } else {
            log(`⚠️ Validation pass API call failed: HTTP ${valRes.status}`);
          }
        } else {
          log(`Validation pass: no relevant facts found for null fields — skipping`);
        }
      } else {
        log(`Validation pass: no null critical fields — skipping`);
      }
    } catch (valErr) {
      log(`⚠️ Validation pass error (non-fatal): ${valErr.message}`);
    }

    // ----------------------------------------------------
    // STEP 12: Save factual profile
    // ----------------------------------------------------
    setProgress("Step 12: Saving factual profile...", 96);
    const sourceMap = new Map();
    for (const s of (deterministicProfile.sources || [])) {
      const key = `${s.label}|${s.url}`;
      sourceMap.set(key, s);
    }
    for (const s of scoredSources.map(s => ({
      label: s.title,
      url: s.url || '#',
      authority: s.authority,
      trust: (s.scoring?.composite || 0) >= 80 ? 'OFFICIAL' : 'THIRD_PARTY',
      scores: s.scoring
    }))) {
      const key = `${s.label}|${s.url}`;
      if (!sourceMap.has(key)) sourceMap.set(key, s);
    }
    if (wqpLimnology?.recordCount > 0) {
      sourceMap.set('Water Quality Portal|https://www.waterqualitydata.us/', { label: 'Water Quality Portal / SCDES monitoring', url: 'https://www.waterqualitydata.us/', trust: 'OFFICIAL', sourceType: 'official_structured' });
    }

    // Safety net: ensure deterministic biology fields are never lost in the packet
    // Final species list: union of deterministic + agent results — always additive, never subtractive
    const _detSpecies = deterministicProfile.biology?.predatorSpecies || [];
    const _agentSpecies = agentSections.biology?.predatorSpecies || [];
    const _finalSpecies = [...new Set([..._detSpecies, ..._agentSpecies])];
    const safeBiology = {
      ...(agentSections.biology || {}),
      predatorSpecies: _finalSpecies.length ? _finalSpecies : _detSpecies,
      knownStockings: agentSections.biology?.knownStockings?.length ? agentSections.biology.knownStockings : (deterministicProfile.biology?.knownStockings || []),
    };
    const researchPacket = {
      lakeName,
      baseName,
      state: stateName,
      ...agentSections,
      // Apply validation pass top-level overrides
      ...(agentSections._validationCounty ? { county: agentSections._validationCounty } : {}),
      ...(agentSections._validationNormalPoolFt != null ? { normalPoolFt: agentSections._validationNormalPoolFt } : {}),
      ...(agentSections._validationGpsCenter ? { gpsCenter: agentSections._validationGpsCenter } : {}),
      biology: safeBiology,
      forage: safeBiology,
      trolling: null,
      trollingIntelligence: null,
      _extractedFacts: uniqueFacts,
      _extractedFactsCount: uniqueFacts.length,
      _wqpLimnology: wqpLimnology || null,
      evidence,
      sources: [...sourceMap.values()]
    };


    log(`Saving factual profile (facts=${uniqueFacts.length}, deterministic species=${agentSections.biology?.predatorSpecies?.length || 0})...`);
    const saveRes = await fetch(`${CF_WORKER_URL}/research/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lakeName,
        profile: researchPacket,
        status: 'draft',
        requestedBy: 'Evidence Acquisition Engine v5 factual-only'
      })
    });
    if (!saveRes.ok) {
      const t = await saveRes.text().catch(()=>'').then(s=>s.slice(0,400));
      throw new Error(`Save HTTP ${saveRes.status}: ${t}`);
    }
    const saveData = await saveRes.json();
    log(`✔ Saved factual profile v${saveData.version} as draft — facts=${uniqueFacts.length}`);

    setProgress("Pipeline completed successfully!", 100);
    log(`=== EVIDENCE PIPELINE COMPLETE ===`);

    if (callbacks.onComplete) await callbacks.onComplete(lakeName);
    if (contradictions.length > 0 && callbacks.onContradictions) callbacks.onContradictions(contradictions, lakeName);
}



export { runEvidencePipeline, runFromNormalized, _state, RESEARCH_ORDER, RESEARCH_LABELS, cloneJson, hasResearchValue, sanitize, sanitizeStateFromLakeName, log };
