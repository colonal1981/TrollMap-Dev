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


const RESEARCH_ORDER = ['identity', 'limnology', 'biology', 'habitat', 'navigation', 'regulations', 'fisheries', 'summary'];
const RESEARCH_LABELS = {
  identity: '🆔 Identity',
  limnology: '🌊 Limnology',
  biology: '🐟 Fisheries',
  habitat: '🌿 Habitat',
  navigation: '🧭 Navigation',
  regulations: '📜 Regulations',
  fisheries: '🧠 Species Intelligence',
  summary: '📝 AI Summary'
};

// Agent definitions with target fields for validation
const AGENT_DEFINITIONS = {
  identity: {
    label: '🆔 Identity',
    targetFields: ['identity.surfaceAreaAcres', 'identity.maxDepthFt', 'identity.averageDepthFt', 'identity.normalPoolFt', 'identity.reservoirOwner', 'identity.riverSystem', 'identity.damName', 'identity.yearImpounded', 'identity.county', 'identity.archetype'],
  },
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
    targetFields: ['navigation.ramps', 'navigation.hazards', 'navigation.notes'],
  },
  regulations: {
    label: '📜 Regulations',
    targetFields: ['regulations.generalStateRegulations', 'regulations.lakeSpecificRegulations'],
  },
  fisheries: {
    label: '🧠 Species Intelligence',
    targetFields: ['trollingIntelligence'],
  },
  summary: {
    label: '📝 AI Summary',
    targetFields: ['summary'],
  },
};

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

  // ── Hump detection — closed interior contour loops ───────────────────────
  // A closed contour loop entirely inside the lake boundary = offshore hump or high spot
  const humpCandidates = [];
  for (const f of contourGeo.features) {
    const depth = f?.properties?.depth_ft;
    if (depth != null && depth >= 15 && depth <= 35) midDepthCount++;
    for (const coords of flattenLineCoords(f.geometry)) {
      if (!isClosedContour(coords)) continue;
      const areaAcres = polygonAreaAcresLonLat(coords);
      if (areaAcres < 0.5 || areaAcres > 500) continue;
      const [lon, lat] = centroidLonLat(coords);
      if (boundaryRing && !pointInPolygonLonLat(lon, lat, boundaryRing)) continue;
      humpCandidates.push({ lon, lat, areaAcres, depth: depth ?? null });
    }
  }

  // ── Ledge detection — find depth inflection zones ────────────────────────
  // Group mid-depth contours by proximity; dense clusters = ledge/drop-off zones
  const ledgeCandidates = [];
  const midDepthFeatures = contourGeo.features.filter(f => {
    const d = f?.properties?.depth_ft;
    return d != null && d >= 12 && d <= 40;
  });

  // Cluster mid-depth contour centroids into ledge zones using simple grid bucketing
  const LEDGE_GRID = 0.003; // ~300m grid cells
  const ledgeGrid = {};
  for (const f of midDepthFeatures) {
    for (const coords of flattenLineCoords(f.geometry)) {
      if (coords.length < 4) continue;
      const [lon, lat] = centroidLonLat(coords);
      if (boundaryRing && !pointInPolygonLonLat(lon, lat, boundaryRing)) continue;
      const key = `${Math.round(lat / LEDGE_GRID)},${Math.round(lon / LEDGE_GRID)}`;
      if (!ledgeGrid[key]) ledgeGrid[key] = { lats: [], lons: [], count: 0 };
      ledgeGrid[key].lats.push(lat);
      ledgeGrid[key].lons.push(lon);
      ledgeGrid[key].count++;
    }
  }
  for (const cell of Object.values(ledgeGrid)) {
    if (cell.count < 3) continue; // need density to call it a ledge
    const lat = cell.lats.reduce((a,b) => a+b, 0) / cell.lats.length;
    const lon = cell.lons.reduce((a,b) => a+b, 0) / cell.lons.length;
    ledgeCandidates.push({ lat, lon, density: cell.count });
  }

  // Sort and cap — top humps by area, top ledges by contour density
  humpCandidates.sort((a, b) => b.areaAcres - a.areaAcres);
  ledgeCandidates.sort((a, b) => b.density - a.density);
  const topHumps = humpCandidates.slice(0, 8);
  const topLedges = ledgeCandidates.slice(0, 8);

  // Build text summaries (existing behavior)
  if (midDepthCount >= 25) result.channelLedges = 'mid-depth contour density indicates multiple ledges / drop-offs';
  else if (midDepthCount >= 10) result.channelLedges = 'contours indicate at least some ledges / depth breaks';
  if (humpCandidates.length >= 5) result.humps = 'multiple closed contour loops suggest several offshore humps or high spots';
  else if (humpCandidates.length >= 1) result.humps = 'at least one closed contour loop suggests offshore hump / high-spot structure';

  // Add coordinate arrays for Smart Plan casting stop integration
  if (topHumps.length) {
    result.humpCoordinates = topHumps.map((h, i) => ({
      id: `hump_${i+1}`,
      lat: Math.round(h.lat * 100000) / 100000,
      lon: Math.round(h.lon * 100000) / 100000,
      areaAcres: Math.round(h.areaAcres * 10) / 10,
      depth: h.depth,
    }));
  }
  if (topLedges.length) {
    result.ledgeCoordinates = topLedges.map((l, i) => ({
      id: `ledge_${i+1}`,
      lat: Math.round(l.lat * 100000) / 100000,
      lon: Math.round(l.lon * 100000) / 100000,
      contourDensity: l.density,
    }));
  }

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
  'identity.normalPoolFt', 'identity.reservoirOwner', 'identity.riverSystem',
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
      averageDepthFt: profile.averageDepthFt, normalPoolFt: profile.normalPoolFt,
      damName: profile.damName, yearImpounded: profile.yearImpounded, archetype: profile.archetype
    };
    profile.biology = profile.biology || profile.forage || {};
    profile.limnology = profile.limnology || {};
    profile.habitat = profile.habitat || {};
    profile.navigation = profile.navigation || {};

    const nullFields = VALIDATION_FIELD_PATHS.filter(path => isValidationGap(valueAtPath(profile, path)));
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
        method: 'POST', headers: { 'Content-Type': 'application/json' },
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
    for (const key of ['surfaceAreaAcres', 'maxDepthFt', 'averageDepthFt', 'normalPoolFt', 'reservoirOwner', 'riverSystem', 'damName', 'yearImpounded', 'county', 'archetype']) {
      if (profile.identity[key] != null) profile[key] = profile.identity[key];
    }
    profile.metadata = profile.metadata || {};
    profile.metadata.lastExistingFactsValidationAt = new Date().toISOString();
    profile.metadata.existingFactsValidationApplied = applied;

    setProgress('Saving validated profile…', 90);
    const saveRes = await fetch(`${CF_WORKER_URL}/research/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
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
    maxDepthFt: profile.maxDepthFt, averageDepthFt: profile.averageDepthFt, normalPoolFt: profile.normalPoolFt,
    damName: profile.damName, yearImpounded: profile.yearImpounded, archetype: profile.archetype
  };
  profile.biology = profile.biology || profile.forage || {};
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

function applyShallowLakeApplicability(profile, fields) {
  const max = Number(profile.identity?.maxDepthFt);
  const avg = Number(profile.identity?.averageDepthFt);
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
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lakeName, state: sanitizeStateFromLakeName(lakeName), targetFields, documents: [{ title: doc.title, url: doc.url, text: String(doc.fullText || doc.text || '').slice(0, 200000) }] })
      });
      if (!res.ok) { log(`⚠️ Targeted extraction HTTP ${res.status}; continuing.`); continue; }
      const data = await res.json();
      newFacts.push(...(data.extracted_facts || []));
      if (i + 1 < selected.length) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    let facts = [...(profile._extractedFacts || []), ...newFacts];
    if (newFacts.length) {
      const dedupeRes = await fetch(`${CF_WORKER_URL}/research/dedupe-contradictions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ facts }) });
      if (dedupeRes.ok) facts = (await dedupeRes.json()).deduplicated_facts || facts;
    }
    profile._extractedFacts = facts;
    profile._extractedFactsCount = facts.length;
    log(`Targeted extraction produced ${newFacts.length} fact(s); evidence corpus now has ${facts.length}.`);

    // Validate only the Smart Plan gaps, now including any recovered facts.
    const filled = {};
    for (let start = 0; start < targetFields.length; start += 10) {
      const batch = targetFields.slice(start, start + 10);
      const res = await fetch(`${CF_WORKER_URL}/research/validation-pass`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lakeName, state: sanitizeStateFromLakeName(lakeName), nullFields: batch, extractedFacts: facts }) });
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
    for (const key of ['surfaceAreaAcres','maxDepthFt','averageDepthFt','normalPoolFt','reservoirOwner','riverSystem','damName','yearImpounded','county','archetype']) if (profile.identity[key] != null) profile[key] = profile.identity[key];
    // Preserve trollingIntelligence — recovery should never wipe fisheries data
    if (!profile.trollingIntelligence && profileData.profile?.trollingIntelligence) {
      profile.trollingIntelligence = profileData.profile.trollingIntelligence;
    }
    if (!profile.trollingIntelligence && profileData.profile?.trolling) {
      profile.trollingIntelligence = profileData.profile.trolling;
    }
    profile.metadata = profile.metadata || {};
    profile.metadata.lastSmartPlanRecoveryAt = new Date().toISOString();
    profile.metadata.smartPlanRecovery = { targetedDocuments: selected.map(d => d.title), newFacts: newFacts.length, applied, finalized };
    setProgress('Saving Smart Plan recovery profile…', 92);
    const saveRes = await fetch(`${CF_WORKER_URL}/research/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lakeName, profile, status: profile.metadata.status || 'draft', requestedBy: 'Smart Plan Targeted Recovery' }) });
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

    // When fisheries runs without biology in the same batch (e.g. resume on
    // fisheries only), load the saved profile's species list so the LLM has
    // the correct predatorSpecies to generate trollingIntelligence sections.
    if (agentKey === 'fisheries' && !previousResults.biology?.predatorSpecies?.length) {
      try {
        const savedRes = await fetch(`${CF_WORKER_URL}/research/get?lake=${encodeURIComponent(lakeName)}`);
        if (savedRes.ok) {
          const savedData = await savedRes.json();
          const savedBiology = savedData.profile?.biology || savedData.profile?.forage || null;
          if (savedBiology?.predatorSpecies?.length) {
            previousResults = { ...previousResults, biology: savedBiology, predatorSpecies: savedBiology.predatorSpecies };
            log(`  [fisheries] Loaded ${savedBiology.predatorSpecies.length} species from saved profile for LLM context`);
          }
        }
      } catch (_) {}
    }

    // ── STEP 1: Discover sources for this agent ──────────────────────────────
    log(`  [${agentKey}] Discovering sources...`);
    const discoverRes = await fetch(`${CF_WORKER_URL}/research/discover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lakeName, state: stateName, agent: agentKey,
        reservoirOwner: previousResults.reservoirOwner || null,
        predatorSpecies: previousResults.predatorSpecies || [],
      })
    });
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
      navigation: 8, regulations: 5, fisheries: 10, summary: 0
    };
    const cap = AGENT_SOURCE_CAPS[agentKey] ?? 10;
    const guaranteed = sources.filter(s => s.priority === 1);
    const discovered = sources.filter(s => s.priority !== 1)
      .sort((a, b) => (b.prefetchScore ?? b.score ?? 3) - (a.prefetchScore ?? a.score ?? 3));
    const discoveryCap = Math.max(0, cap - guaranteed.length);
    const cappedSources = [...guaranteed, ...discovered.slice(0, discoveryCap)];
    log(`  [${agentKey}] Found ${sources.length} sources (${guaranteed.length} seeds + ${discovered.length} discovered) → capped to ${cappedSources.length}`);

    if (!cappedSources.length) {
      log(`  [${agentKey}] No sources — skipping`);
      return { success: true, agent: agentKey, section: {}, factsCount: 0, docsUsed: 0, queryLog };
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

    // Regulations agent: already in deterministic facts — skip fetching
    if (agentKey === 'regulations') {
      log(`  [regulations] Using KV-cached state regulations — no fetch needed`);
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
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ canonicalUrl: src.canonicalUrl })
          });
          if (!checkRes.ok) continue;
          const checkData = await checkRes.json();
          if (!checkData.found || checkData.document?.indexStatus === 'ambiguous') continue;

          // Pull relevant sections from shared registry
          const queryRes = await fetch(`${CF_WORKER_URL}/research/shared/query`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
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
        } catch (_) {}
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
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ canonicalUrl: src.canonicalUrl })
            });
            if (checkRes.ok) {
              const checkData = await checkRes.json();
              if (checkData.found && checkData.document?.indexStatus !== 'ambiguous') {
                sharedDoc = checkData.document;
              }
            }
          } catch (_) {}
        }

        if (sharedDoc) {
          try {
            const queryRes = await fetch(`${CF_WORKER_URL}/research/shared/query`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
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
          } catch (_) {}
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
            headers: { 'Content-Type': 'application/json' },
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
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
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
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
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
        await fetch(`${CF_WORKER_URL}/research/save-normalized`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lakeName, documents: merged })
        });
      }
    }

    if (!normalizedDocuments.length && agentKey !== 'regulations') {
      log(`  [${agentKey}] No documents fetched — running LLM with deterministic context only`);
    }

    // ── STEP 4: Extract facts (one Worker call, fast) ─────────────────────────
    let uniqueFacts = [];
    if (normalizedDocuments.length > 0) {
      log(`  [${agentKey}] Extracting facts from ${normalizedDocuments.length} docs...`);
      try {
        const analyzeRes = await fetch(`${CF_WORKER_URL}/research/analyze-facts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lakeName, baseName, state: stateName, docIndex: 0,
            documents: normalizedDocuments.slice(0, 12).map(d => ({
              title: d.title, url: d.url || '',
              text: (d.fullText || '').slice(0, 150000)
            }))
          })
        });
        if (analyzeRes.ok) {
          const analyzeData = await analyzeRes.json();
          const rawFacts = analyzeData.extracted_facts || [];

          // ── STEP 5: Deduplicate facts ─────────────────────────────────────────
          if (rawFacts.length > 0) {
            try {
              const dedupeRes = await fetch(`${CF_WORKER_URL}/research/dedupe-contradictions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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
          log(`  ⚠️ [${agentKey}] analyze-facts returned ${analyzeRes.status} — continuing with 0 facts`);
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
    const agentRes = await fetch(`${CF_WORKER_URL}/research/agent-llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lakeName, state: stateName,
        agent: agentKey,
        previousResults: {
          ...previousResults,
          _extractedFacts: uniqueFacts,
          _normalizedDocuments: normalizedDocuments.slice(0, agentKey === 'fisheries' ? 25 : 12).map(d => ({
            title: d.title, url: d.url,
            text: (d.fullText || '').slice(0, agentKey === 'fisheries' ? 150000 : 40000)
          }))
        }
      })
    });

    if (!agentRes.ok) {
      // Retry once on 502
      if (agentRes.status === 502) {
        log(`  ⚠️ ${def.label} LLM 502 — retrying after 5s...`);
        await new Promise(r => setTimeout(r, 5000));
        const retry = await fetch(`${CF_WORKER_URL}/research/agent-llm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lakeName, state: stateName, agent: agentKey,
            previousResults: {
              ...previousResults,
              _extractedFacts: uniqueFacts,
              _normalizedDocuments: normalizedDocuments.slice(0, 12).map(d => ({
                title: d.title, url: d.url,
                text: (d.fullText || '').slice(0, 40000)
              }))
            }
          })
        });
        if (!retry.ok) throw new Error(`Agent ${agentKey} LLM failed: ${retry.status}`);
        const retryData = await retry.json();
        if (!retryData.success) throw new Error(retryData.error || 'Agent LLM failed');
        log(`✔ ${def.label} agent complete (${uniqueFacts.length} facts, ${normalizedDocuments.length} docs)`);
        if (callbacks.onComplete) await callbacks.onComplete(lakeName);
        return { ...retryData, factsCount: uniqueFacts.length, docsUsed: normalizedDocuments.length, queryLog };
      }
      throw new Error(`Agent ${agentKey} LLM failed: ${agentRes.status}`);
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

    log(`✔ ${def.label} agent complete (${uniqueFacts.length} facts, ${normalizedDocuments.length} docs)`);
    if (callbacks.onComplete) await callbacks.onComplete(lakeName);
    return { ...agentData, factsCount: uniqueFacts.length, docsUsed: normalizedDocuments.length, queryLog };

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
  _state.wqpLimnology = null;
  showProgress(true);

  // WQP limnology — runs on both full and resume when limnology is selected.
  // runFullPipeline also runs this in Step 1d; runAgents handles the resume case.
  if (mode === 'resume' && agentKeys.includes('limnology')) {
    setProgress('WQP limnology data...', 5);
    try {
      const supplementalKey = resolveSupplementalKey(lakeName);
      const shorelineUrl = supplementalKey
        ? `${CF_WORKER_URL}/chartpacks/supplemental/${supplementalKey}/shoreline.geojson?v=${Date.now()}`
        : `${CF_WORKER_URL}/chartpacks/lake-boundary?lake=${encodeURIComponent(lakeName)}`;
      const geoRes = await fetch(shorelineUrl);
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
            const step = (flat.length >= 3 && flat[2] === 0.0) || (flat.length % 3 === 0 && flat.length % 2 !== 0) ? 3 : 2;
            for (let i = 0; i < flat.length - 1; i += step) coords.push([flat[i], flat[i+1]]);
          }
        };
        extractCoords(geo);
        if (coords.length) {
          const lons = coords.map(c => c[0]);
          const lats = coords.map(c => c[1]);
          // 0.01° padding (~0.7mi) ensures monitoring stations near the shoreline edge are captured
          bbox = { bboxNorth: Math.max(...lats) + 0.01, bboxSouth: Math.min(...lats) - 0.01, bboxEast: Math.max(...lons) + 0.01, bboxWest: Math.min(...lons) - 0.01 };
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
            _state.wqpLimnology = wqpData;
            const tc   = wqpData.thermocline ? `${wqpData.thermocline.depthFt}ft (${wqpData.thermocline.method})` : 'not derived';
            const surf = wqpData.surfaceWater?.recentTempF != null ? `surface ${wqpData.surfaceWater.recentTempF}°F / DO ${wqpData.surfaceWater.recentDissolvedOxygenMgL ?? '?'} mg/L` : '';
            const sec  = wqpData.secchi ? `secchi avg ${wqpData.secchi.avgSecchiDepthFt}ft (n=${wqpData.secchi.sampleCount})` : '';
            log(`✔ WQP: ${wqpData.recordCount} records — thermocline ${tc}${surf ? '; ' + surf : ''}${sec ? '; ' + sec : ''}`);
          } else {
            log(`⚠️ WQP: ${wqpData.note || 'no data found'}`);
          }
        }
      } else {
        log('⚠️ WQP: could not derive bbox — skipping');
      }
    } catch (e) { log(`⚠️ WQP fetch failed: ${e.message}`); }
  }

  // Summary always runs last — separate it from the parallel batch
  const hasSummary = agentKeys.includes('summary');
  let parallelAgents = agentKeys.filter(k => k !== 'summary');
  // Always sort agents by canonical RESEARCH_ORDER so dependencies are respected
  // regardless of UI selection order or resume call order.
  parallelAgents = parallelAgents.sort((a, b) => {
    const ai = RESEARCH_ORDER.indexOf(a);
    const bi = RESEARCH_ORDER.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  const total = agentKeys.length;
  let completed = 0;
  log(`=== RUN AGENTS: [${agentKeys.join(', ')}] (${mode}) ===`);

  const results = [];
  // Wave structure:
  // Wave 1 — fully concurrent: identity, limnology, habitat, navigation, regulations
  // Wave 2 — serial: biology then fisheries (fisheries needs biology output)
  // Wave 3 — summary (always last, handled separately)
  const WAVE1_AGENTS = ['identity', 'limnology', 'habitat', 'navigation', 'regulations'];
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
      const wave1Results = await Promise.all(wave1All.map(k => runAgentSafe(k)));
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

    // Assemble + save profile from all agent results
    setProgress('Assembling and saving profile...', 82);
    let assembleResult = { contradictions: [] };
    try {
      assembleResult = await assembleAndSaveProfile(lakeName, results, mode);
    } catch (e) {
      log(`⚠️ Profile assembly failed: ${e.message}`);
    }

    // Summary agent runs last with the fully assembled profile as context
    if (hasSummary) {
      setProgress('Running summary agent...', 92);
      try {
        const summaryResult = await runAgent(lakeName, 'summary', mode, {}, true);
        completed++;
        results.push({ agent: 'summary', data: summaryResult });
        // Merge summary into the already-saved profile
        if (summaryResult?.section) {
          const existingRes = await fetch(`${CF_WORKER_URL}/research/get?lake=${encodeURIComponent(lakeName)}`);
          if (existingRes.ok) {
            const existingData = await existingRes.json();
            if (existingData.profile) {
              const patched = { ...existingData.profile, summary: summaryResult.section };
              await fetch(`${CF_WORKER_URL}/research/save`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ lakeName, profile: patched, status: patched.metadata?.status || 'draft', requestedBy: 'Summary agent patch' })
              });
              log('✔ Summary section merged into saved profile');
            }
          }
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
      const detRes = await fetch(`${CF_WORKER_URL}/research/deterministic-facts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lakeName, state: stateName })
      });
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

    // STEP 1c: Geospatial structure adapter
    setProgress('Step 1c: Geospatial structure...', 15);
    try {
      const geoStruct = await deriveGeospatialStructureFacts(lakeName);
      if (geoStruct && _state.deterministicProfile) {
        _state.deterministicProfile.habitat = mergeMissing(_state.deterministicProfile.habitat || {}, geoStruct.habitat || {});
        if (geoStruct.habitat?.notes) {
          _state.deterministicProfile.habitat.notes = [_state.deterministicProfile.habitat.notes, geoStruct.habitat.notes].filter(Boolean).join(' ');
        }
        _state.deterministicProfile.evidence = mergeEvidenceMaps(_state.deterministicProfile.evidence || {}, geoStruct.evidence || {});
        _state.deterministicProfile.sources  = [...(_state.deterministicProfile.sources || []), ...(geoStruct.sources || [])];
        log(`✔ Geospatial structure adapter loaded — ${Object.keys(geoStruct.habitat || {}).join(', ') || 'no fields'}`);
      }
    } catch (e) { log(`⚠️ Geospatial adapter failed: ${e.message}`); }

    // STEP 1d: WQP limnology (only when limnology agent is in the run)
    if (!selectedAgents || selectedAgents.includes('limnology')) {
      setProgress('Step 1d: WQP limnology data...', 20);
      try {
        const supplementalKey = resolveSupplementalKey(lakeName);
        const shorelineUrl = supplementalKey
          ? `${CF_WORKER_URL}/chartpacks/supplemental/${supplementalKey}/shoreline.geojson?v=${Date.now()}`
          : `${CF_WORKER_URL}/chartpacks/lake-boundary?lake=${encodeURIComponent(lakeName)}`;
        const geoRes = await fetch(shorelineUrl);
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
              const step = (flat.length >= 3 && flat[2] === 0.0) || (flat.length % 3 === 0 && flat.length % 2 !== 0) ? 3 : 2;
              for (let i = 0; i < flat.length - 1; i += step) coords.push([flat[i], flat[i+1]]);
            }
          };
          extractCoords(geo);
          if (coords.length) {
            const lons = coords.map(c => c[0]);
            const lats = coords.map(c => c[1]);
            // 0.01° padding (~0.7mi) ensures monitoring stations near the shoreline edge are captured
            bbox = { bboxNorth: Math.max(...lats) + 0.01, bboxSouth: Math.min(...lats) - 0.01, bboxEast: Math.max(...lons) + 0.01, bboxWest: Math.min(...lons) - 0.01 };
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
              _state.wqpLimnology = wqpData;
              const tc   = wqpData.thermocline ? `${wqpData.thermocline.depthFt}ft (${wqpData.thermocline.method})` : 'not derived';
              const surf = wqpData.surfaceWater?.recentTempF != null ? `surface ${wqpData.surfaceWater.recentTempF}°F / DO ${wqpData.surfaceWater.recentDissolvedOxygenMgL ?? '?'} mg/L` : '';
              const sec  = wqpData.secchi ? `secchi avg ${wqpData.secchi.avgSecchiDepthFt}ft (n=${wqpData.secchi.sampleCount})` : '';
              log(`✔ WQP: ${wqpData.recordCount} records — thermocline ${tc}${surf ? '; ' + surf : ''}${sec ? '; ' + sec : ''}`);
            } else {
              log(`⚠️ WQP: ${wqpData.note || 'no data found'}`);
            }
          }
        } else {
          log('⚠️ WQP: could not derive bbox — skipping');
        }
      } catch (e) { log(`⚠️ WQP fetch failed: ${e.message}`); }
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
  } catch (e) { /* non-fatal */ }

  // Saved profiles store identity fields flat at the top level (surfaceAreaAcres,
  // reservoirOwner, etc.) rather than nested under an 'identity' key. Reconstruct
  // the identity object from flat fields so resume runs don't wipe them.
  if (!existingSavedProfile.identity && existingSavedProfile.lakeName) {
    existingSavedProfile.identity = {
      surfaceAreaAcres:  existingSavedProfile.surfaceAreaAcres  ?? null,
      maxDepthFt:        existingSavedProfile.maxDepthFt        ?? null,
      averageDepthFt:    existingSavedProfile.averageDepthFt    ?? null,
      normalPoolFt:      existingSavedProfile.normalPoolFt      ?? null,
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
  const agentSections = {
    identity:             cloneJson(existingSavedProfile.identity     || det.identity     || {}),
    biology:              cloneJson(existingSavedProfile.biology       || det.biology      || {}),
    habitat:              cloneJson(existingSavedProfile.habitat      || det.habitat      || {}),
    navigation:           cloneJson(existingSavedProfile.navigation   || det.navigation   || {}),
    regulations:          cloneJson(existingSavedProfile.regulations  || det.regulations  || {}),
    limnology:            applyWqpToLimnology(existingSavedProfile.limnology || det.limnology || {}, wqp),
    summary:              cloneJson(existingSavedProfile.summary      || det.summary      || {}),
    trollingIntelligence: existingSavedProfile.trollingIntelligence   || null,
  };

  const evidence = mergeEvidenceMaps(det.evidence || {}, buildWqpEvidence(wqp));
  const factualSummary = buildDeterministicSummary({ lakeName, identity: agentSections.identity, biology: agentSections.biology, limnology: agentSections.limnology, habitat: agentSections.habitat });
  if (factualSummary) {
    agentSections.summary = { text: factualSummary, keywords: det.summary?.keywords || [] };
  }

  // Apply unique facts from deterministic profile to fill identity/limnology gaps
  const detFacts = det._extractedFacts || [];
  if (detFacts.length) {
    const getFactVal = (cats) => { for (const c of cats) { const f = detFacts.find(f => String(f.category||'').toLowerCase() === c.toLowerCase()); if (f) return f.fact; } return null; };
    const parseNum  = (s) => { const n = parseFloat(String(s||'').replace(/[^0-9.]/g,'')); return isFinite(n) ? n : null; };
    const id = agentSections.identity;
    if (id.surfaceAreaAcres == null) id.surfaceAreaAcres = parseNum(getFactVal(['surfaceArea','surfaceAreaAcres']));
    if (id.maxDepthFt == null)       id.maxDepthFt       = parseNum(getFactVal(['maxDepthFt','maxDepth']));
    if (id.averageDepthFt == null)   id.averageDepthFt   = parseNum(getFactVal(['averageDepthFt','averageDepth']));
    if (!id.archetype)               id.archetype        = getFactVal(['archetype']);
    if (!id.damName)                 id.damName          = getFactVal(['damName']);
    if (id.yearImpounded == null)    id.yearImpounded    = parseNum(getFactVal(['yearImpounded']));
    if (!id.reservoirOwner)          id.reservoirOwner   = getFactVal(['reservoirOwner']);
    if (!id.riverSystem)             id.riverSystem      = getFactVal(['riverSystem']);
    if (id.normalPoolFt == null)     id.normalPoolFt     = parseNum(getFactVal(['poolLevel','normalPoolFt']));
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
      // Coerce string types left over from prior runs or LLM output
      const coerceNum = (v) => {
        if (v === null || v === undefined) return null;
        if (typeof v === 'number') return v;
        if (typeof v === 'string') {
          if (v === 'null' || v === '' || v === 'unknown') return null;
          const rangeMatch = v.match(/^([\d.]+)\s*[-–]\s*([\d.]+)$/);
          if (rangeMatch) return Math.round((parseFloat(rangeMatch[1]) + parseFloat(rangeMatch[2])) / 2);
          const num = parseFloat(v);
          return isFinite(num) ? num : null;
        }
        return null;
      };
      if (merged.thermocline) merged.thermocline.summerDepthFt = coerceNum(merged.thermocline.summerDepthFt);
      if (merged.oxygen) {
        merged.oxygen.depletionDepthFt = coerceNum(merged.oxygen.depletionDepthFt);
        merged.oxygen.anoxicBelowFt = coerceNum(merged.oxygen.anoxicBelowFt);
      }
      if (merged.waterClarity) merged.waterClarity.secchiFt = coerceNum(merged.waterClarity.secchiFt);
      if (merged.seasonalDrawdownFt != null) merged.seasonalDrawdownFt = coerceNum(merged.seasonalDrawdownFt) ?? merged.seasonalDrawdownFt;
    }
    // Regulations: deep-merge lakeSpecificRegulations — don't let empty overwrite populated
    if (agentKey === 'regulations' && data.section?.lakeSpecificRegulations) {
      const existingLsr = existing.lakeSpecificRegulations || {};
      const agentLsr    = data.section.lakeSpecificRegulations;
      const mergedCreel = (agentLsr.creelLimits && Object.keys(agentLsr.creelLimits).length) ? agentLsr.creelLimits : (existingLsr.creelLimits || {});
      const mergedSize  = (agentLsr.sizeLimits  && Object.keys(agentLsr.sizeLimits).length)  ? agentLsr.sizeLimits  : (existingLsr.sizeLimits  || {});
      merged.lakeSpecificRegulations = { ...existingLsr, ...agentLsr, creelLimits: mergedCreel, sizeLimits: mergedSize };
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

  // Collect all facts from agent responses for validation + source map
  const allFacts = agentResults.flatMap(r => r.data?._extractedFacts || []);
  const contradictions = agentResults.flatMap(r => r.data?.contradictions || []);
  const agentsRan = new Set(agentResults.map(r => r.agent));

  // Validation pass — only runs when we have facts, only checks fields for agents that ran
  const ALL_VALIDATION_FIELDS = {
    identity:   ['identity.surfaceAreaAcres','identity.maxDepthFt','identity.averageDepthFt','identity.normalPoolFt','identity.reservoirOwner','identity.riverSystem','identity.damName','identity.yearImpounded','identity.county','identity.archetype'],
    limnology:  ['limnology.waterClarity.typical','limnology.waterClarity.color','limnology.waterClarity.secchiFt','limnology.thermocline.summerDepthFt','limnology.thermocline.strength','limnology.thermocline.winterMix','limnology.oxygen.depletionDepthFt','limnology.oxygen.anoxicBelowFt','limnology.trophicStatus','limnology.flowCharacteristics','limnology.seasonalDrawdownFt'],
    biology:    ['biology.primaryForage','biology.secondaryForage','biology.predatorSpecies','biology.speciesAbundance','biology.knownStockings','biology.baitfishMovement','biology.invasiveSpecies','biology.spawnTiming','biology.forageSpatial'],
    habitat:    ['habitat.bottomComposition','habitat.cover','habitat.vegetation','habitat.standingTimber','habitat.dockDensity','habitat.riprapLocations','habitat.namedCreekMouths','habitat.timberFields','habitat.shallowFlatAreas','habitat.artificialHabitat','habitat.artificialHabitatDetails.attractorCount','habitat.artificialHabitatDetails.attractorTypes'],
    navigation: ['navigation.ramps','navigation.hazards','navigation.notes'],
    fisheries:  ['trollingIntelligence'],
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
          method: 'POST', headers: { 'Content-Type': 'application/json' },
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
    knownStockings: agentSections.biology?.knownStockings?.length ? agentSections.biology.knownStockings : (det.biology?.knownStockings || []),
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
    forage: safeBiology,
    trolling: null,
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
    method: 'POST', headers: { 'Content-Type': 'application/json' },
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

export { runFullPipeline, runAgents, runAgent, runResume, assembleAndSaveProfile, validateExistingFacts, recoverSmartPlanFacts, deriveGeospatialStructureFacts, renderLog, _state, RESEARCH_ORDER, RESEARCH_LABELS, cloneJson, hasResearchValue, sanitize, sanitizeStateFromLakeName, log };
