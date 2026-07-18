/**
 * supplemental-layers.js — Supplemental PBF-extracted layer integration.
 */

import { state, CF_WORKER_URL } from '../core/state.js';
import { esc } from '../utils/escape.js';

const LAKE_NAME_TO_R2_KEY = {
  // ── SC Lakes ────────────────────────────────────────────────────────────────
  'Lake Marion, SC':                    'lake_marion',
  'Lake Moultrie, SC':                  'lake_moultrie',
  'Lake Murray, SC':                    'lake_murray',
  'Lake Wateree, SC':                   'lake_wateree_fishing_creek',
  'Fishing Creek Reservoir, SC':        'lake_wateree_fishing_creek',
  'Lake Wylie, SC/NC':                  'lake_wylie',
  'Catawba Narrows, SC/NC':             'catawba_narrows',
  'Lake Hartwell, SC/GA':               'lake_hartwell',
  'Lake Greenwood, SC':                 'lake_greenwood_secession',
  'Lake Secession, SC':                 'lake_greenwood_secession',
  'Lake Keowee, SC':                    'lake_keowee',
  'Lake Jocassee, SC/NC':               'lake_jocassee',
  'Lake Russell, SC/GA':                'lake_thurmond_russell',
  'Lake Russell, GA':                   'lake_thurmond_russell',
  'Lake Russell, SC':                   'lake_thurmond_russell',
  'Richard B. Russell Lake, GA':        'lake_thurmond_russell',
  'Clarks Hill / Thurmond, SC/GA':      'lake_thurmond_russell',
  'Lake Thurmond, SC':                  'lake_thurmond_russell',
  'Clarks Hill Lake, GA':               'lake_thurmond_russell',
  'Lake Monticello, SC':                'lake_monticello_parr',
  'Parr Reservoir, SC':                 'lake_monticello_parr',
  'Lake Robinson, SC':                  'north_saluda_reservoir',
  'Lake Bowen, SC':                     'lake_bowen',
  'Lake Blalock, SC':                   'lake_blalock',

  // ── NC Lakes ────────────────────────────────────────────────────────────────
  'Lake Norman, NC':                    'lake_norman_mountain_island',
  'Mountain Island Lake, NC':           'lake_norman_mountain_island',
  'Lake Norman (South), NC':            'lake_norman',
  'Lake Hickory, NC':                   'lake_hickory_rhodhiss',
  'Lake Rhodhiss, NC':                  'lake_hickory_rhodhiss',
  'Lake James, NC':                     'lake_james',
  'High Rock Lake, NC':                 'yadkin_river_chain',
  'Badin Lake, NC':                     'yadkin_river_chain',
  'Lake Tillery, NC':                   'yadkin_river_chain',
  'Blewett Falls Lake, NC':             'yadkin_river_chain',
  'Jordan Lake, NC':                    'jordan_lake',
  'Falls Lake, NC':                     'falls_lake',
  'W. Kerr Scott Reservoir, NC':        'w_kerr_scott_reservoir',
  'Shearon Harris Reservoir, NC':       'shearon_harris_reservoir',
  'Randleman Lake, NC':                 'randleman_lake',
  'Lake Mackintosh, NC':                'lake_mackintosh',
  'Lake Townsend, NC':                  'lake_townsend',
  'Lake Michie / Little River, NC':     'lake_michie',
  'Lake Reidsville, NC':                'lake_reidsville',
  'North Fork Reservoir, NC':           'north_fork_reservoir',
  'Belews Lake, NC':                    'belews_lake',
  'Hyco Lake, NC':                      'hyco_lake',
  'Mayo Lake, NC':                      'mayo_lake',
  'Auman Lake, NC':                     'auman_lake',
  'Bonnie Doone Lake, NC':              'bonnie_doone_lake',
  'John D. Long Lake, NC':              'john_d_long_lake',
  'John H. Moss Lake, NC':              'john_h_moss_lake',
  'Oak Hollow / Higgins Lake, NC':      'oak_hollow_higgins',
  'Lake Summit, NC':                    'lake_summit',
  'Nantahala Lake, NC':                 'nantahala_lake',
  'Lake Santeetlah, NC':                'lake_santeetlah',
  'Hiwassee Lake, NC':                  'hiwassee_lake',
  'Fontana Lake, NC':                   'fontana_lake',
  'Lake Cheoah, NC':                    'lake_cheoah',

  // ── GA Lakes ────────────────────────────────────────────────────────────────
  'Lake Oconee, GA':                    'lake_oconee',
  'Lake Sinclair, GA':                  'lake_sinclair',
  'Lake Lanier, GA':                    'lake_lanier',
  'Lake Jackson, GA':                   'lake_juliette_high_falls',
  'Lake Juliette / High Falls, GA':     'lake_juliette_high_falls',
  'Lake Blackshear, GA':                'lake_blackshear',
  'Lake Allatoona, GA':                 'lake_allatoona',
  'Tobesofkee Reservoir, GA':           'tobesofkee_reservoir',
  'Kornbow Lake, GA':                   'kornbow_lake',
  'Lake Blue Ridge, GA':                'lake_blue_ridge',
  'Lake Nottely, GA':                   'lake_nottely',
  'Lake Burton, GA':                    'lake_burton',
  'Lake Chatuge, GA/NC':                'lake_chatuge',

  // ── TN / NC Mountain ────────────────────────────────────────────────────────
  'Norris Lake, TN':                    'norris_lake',
  'Norris Reservoir, TN':               'norris_lake',
  'Douglas Lake, TN':                   'douglas_lake',
  'Douglas Reservoir, TN':              'douglas_lake',
  'Cherokee Lake, TN':                  'cherokee_lake',
  'Cherokee Reservoir, TN':             'cherokee_lake',
  'Fort Loudoun Lake, TN':              'fort_loudoun_lake',
  'Fort Loudoun Reservoir, TN':         'fort_loudoun_lake',
  'Fort Loundon Reservoir, TN':         'fort_loudoun_lake',
  'Tellico Lake, TN':                   'tellico_lake',
  'Tellico Reservoir, TN':              'tellico_lake',
  'Melton Hill Lake, TN':               'melton_hill_lake',
  'Melton Hill Reservoir, TN':          'melton_hill_lake',
  'South Holston Lake, TN':             'south_holston_lake',
  'South Holston Reservoir, TN':        'south_holston_lake',
  'Lake Chilhowee, TN':                 'lake_chilhowee',
  'Lake Cheoah, TN/NC':                 'lake_cheoah',
  'Watauga Lake, TN':                   'watauga_boone_chain',
  'Boone Lake, TN':                     'watauga_boone_chain',
  'Boone Reservoir, TN':                'watauga_boone_chain',
  'Watauga / Boone Chain, TN/NC':       'watauga_boone_chain',

  // ── SC Coastal ──────────────────────────────────────────────────────────────
  'ACE Basin / Edisto, SC':             'sc_ga_coastal',
  'Charleston Harbor, SC':              'sc_ga_coastal',
  'Winyah Bay / Georgetown, SC':        'sc_ga_coastal',
  'Beaufort / Port Royal Sound, SC':    'sc_ga_coastal',
  'St. Helena Sound, SC':               'sc_ga_coastal',
  'Hilton Head / Calibogue Sound, SC':  'sc_ga_coastal',
  'Santee River Delta / North Inlet, SC': 'sc_ga_coastal',
  'Savannah River / Savannah, GA':      'sc_ga_coastal',
}

const LAKE_BOUNDARY_KEY = {
  'Lake Marion, SC':               'lake_marion_3dhp',
  'Lake Moultrie, SC':             'lake_moultrie_3dhp',
  'Lake Murray, SC':               'lake_murray_3dhp',
  'Lake Wateree, SC':              'lake_wateree_3dhp',
  'Fishing Creek Reservoir, SC':   'lake_wateree_3dhp',
  'Lake Monticello, SC':           'lake_monticello_3dhp',
  'Parr Reservoir, SC':            'lake_monticello_3dhp',
};

// ── FIX: fuzzy name resolver — same logic as contour-data.js resolveR2Key ────
export function resolveSupplementalKey(displayName) {
  // 1. Exact match
  if (LAKE_NAME_TO_R2_KEY[displayName]) return LAKE_NAME_TO_R2_KEY[displayName];
  // 2. Strip state suffix ", SC" / ", NC/GA" etc
  const stripped = displayName.replace(/,\s*[A-Z]{2}(\/[A-Z]{2})?$/, '').trim();
  if (LAKE_NAME_TO_R2_KEY[stripped]) return LAKE_NAME_TO_R2_KEY[stripped];
  // 3. Case-insensitive partial match (handles extra words like "(Duke Energy)")
  const dl = stripped.toLowerCase();
  const found = Object.entries(LAKE_NAME_TO_R2_KEY).find(([k]) => {
    const kl = k.toLowerCase().replace(/,\s*[a-z]{2}(\/[a-z]{2})?$/, '').trim();
    return dl.includes(kl) || kl.includes(dl);
  });
  return found ? found[1] : null;
}

// Same fuzzy logic for boundary key
export function resolveBoundaryKey(displayName) {
  if (LAKE_BOUNDARY_KEY[displayName]) return LAKE_BOUNDARY_KEY[displayName];
  const stripped = displayName.replace(/,\s*[A-Z]{2}(\/[A-Z]{2})?$/, '').trim();
  if (LAKE_BOUNDARY_KEY[stripped]) return LAKE_BOUNDARY_KEY[stripped];
  const dl = stripped.toLowerCase();
  const found = Object.entries(LAKE_BOUNDARY_KEY).find(([k]) => {
    const kl = k.toLowerCase().replace(/,\s*[a-z]{2}(\/[a-z]{2})?$/, '').trim();
    return dl.includes(kl) || kl.includes(dl);
  });
  return found ? found[1] : null;
}

const DEPTH_BANDS = [
  { max: 10,       color: '#e63946' },
  { max: 20,       color: '#f4a261' },
  { max: 28,       color: '#e9c46a' },
  { max: 36,       color: '#2a9d8f' },
  { max: 45,       color: '#00e5ff' },
  { max: 55,       color: '#0077b6' },
  { max: 65,       color: '#7b2d8b' },
  { max: Infinity, color: '#ffffff' },
];

function depthAreaColor(ft) {
  for (const band of DEPTH_BANDS) {
    if (ft <= band.max) return band.color;
  }
  return '#ffffff';
}

const IDB_NAME    = 'trollmap-supplemental';
const IDB_STORE   = 'layers';
const IDB_VERSION = 1;
const CACHE_TTL   = 24 * 60 * 60 * 1000;

let _db = null;
async function openDB() {
  if (_db) return _db;
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE, { keyPath: 'key' });
    req.onsuccess = e => { _db = e.target.result; res(_db); };
    req.onerror   = e => rej(e.target.error);
  });
}

async function idbGet(key) {
  try {
    const db = await openDB();
    return new Promise((res, rej) => {
      const req = db.transaction(IDB_STORE).objectStore(IDB_STORE).get(key);
      req.onsuccess = () => res(req.result || null);
      req.onerror   = () => rej(req.error);
    });
  } catch (_) { return null; }
}

async function idbSet(key, value) {
  try {
    const db = await openDB();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ key, value, ts: Date.now() });
  } catch (_) {}
}

async function fetchSupplemental(lakeKey, layer) {
  const url = `${CF_WORKER_URL}/chartpacks/supplemental/${lakeKey}/${layer}.geojson?v=${Date.now()}`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function loadLayer(lakeKey, layer) {
  const cacheKey = `${lakeKey}/${layer}`;
  const cached = await idbGet(cacheKey);
  if (cached?.ts && (Date.now() - cached.ts) < CACHE_TTL && cached.value?.features?.length) {
    return cached.value;
  }
  const gj = await fetchSupplemental(lakeKey, layer);
  if (!gj?.features?.length) throw new Error('empty');
  await idbSet(cacheKey, gj);
  return gj;
}

let _activeLakeKey    = null;
let _depthAreaLayer   = null;
let _depthAreaVisible = true;
let _depthAreaGeoJSON = null;
let _fishingLayer     = null;
let _fishingVisible   = false;
let _poiLayer         = null;
let _visionLayer      = null;
let _visionVisible    = false;
let _poiVisible       = false;
let _boundaryGeoJSON  = null;
let _osmStructureData = null;

export function getDepthAreaGeoJSON() { return _depthAreaGeoJSON; }
export function getLakeBoundaryGeoJSON() { return _boundaryGeoJSON; }
export function bringDepthAreasToBack() {
  if (_depthAreaLayer) _depthAreaLayer.bringToBack();
}
window.bringDepthAreasToBack = function() {
  if (_depthAreaLayer) _depthAreaLayer.bringToBack();
};

function getMap() { return state.MAP; }
function mapReady() { return state.MAP_OK && !!state.MAP; }

async function loadDepthAreas(lakeKey) {
  if (!mapReady()) return;
  if (_depthAreaLayer) { getMap().removeLayer(_depthAreaLayer); _depthAreaLayer = null; }
  try {
    const gj = await loadLayer(lakeKey, 'depth_areas');
    _depthAreaLayer = L.geoJSON(gj, {
      style(feat) {
        const depthFt = feat.properties?.depth_max_ft ?? feat.properties?.depth_min_ft ?? 0;
        const color   = depthAreaColor(depthFt);
        return { fillColor: color, fillOpacity: 0.30, color, weight: 0.5, opacity: 0.5 };
      },
      onEachFeature(feat, layer) {
        const p = feat.properties || {};
        const minFt = p.depth_min_ft ?? '?';
        const maxFt = p.depth_max_ft ?? '?';
        layer.bindTooltip(`Depth zone: ${minFt}–${maxFt} ft`, { sticky: true, direction: 'top', opacity: 0.85 });
      },
    });
    if (_depthAreaVisible) { _depthAreaLayer.addTo(getMap()); _depthAreaLayer.bringToBack(); }
    _depthAreaGeoJSON = gj;
    globalThis.SUPPLEMENTAL_DEPTH_LAYER   = _depthAreaLayer;
    globalThis.SUPPLEMENTAL_DEPTH_GEOJSON = gj;
    window.SUPPLEMENTAL_DEPTH_LAYER       = _depthAreaLayer;
    window.SUPPLEMENTAL_DEPTH_GEOJSON     = gj;
    console.log(`[supplemental] depth_areas loaded: ${gj.features.length} features for ${lakeKey}`);
  } catch (e) {
    if (!e.message.includes('404') && !e.message.includes('empty')) {
      console.warn(`[supplemental] depth_areas fetch failed for ${lakeKey}:`, e.message);
    }
  }
}

async function loadFishingSpots(lakeKey) {
  if (!mapReady()) return;
  if (_fishingLayer) { getMap().removeLayer(_fishingLayer); _fishingLayer = null; }
  const group = L.layerGroup();
  let total = 0;
  try {
    const pts = await loadLayer(lakeKey, 'fishing_points');
    pts.features.forEach(feat => {
      const coords = feat.geometry?.coordinates;
      if (!coords) return;
      const m = L.circleMarker([coords[1], coords[0]], { radius: 4, color: '#76ff03', weight: 1, fillColor: '#76ff03', fillOpacity: 0.7 });
      m.bindTooltip('Community fishing spot', { sticky: true, direction: 'top', opacity: 0.85 });
      group.addLayer(m); total++;
    });
  } catch (_) {}
  try {
    const lines = await loadLayer(lakeKey, 'fishing_lines');
    L.geoJSON(lines, {
      style() { return { color: '#76ff03', weight: 1.5, opacity: 0.55, dashArray: '4,4' }; },
      onEachFeature(feat, layer) { layer.bindTooltip('Community fishing path', { sticky: true, direction: 'top', opacity: 0.85 }); },
    }).eachLayer(l => { group.addLayer(l); total++; });
  } catch (_) {}
  if (total === 0) { console.log(`[supplemental] no fishing spots data for ${lakeKey}`); return; }
  _fishingLayer = group;
  if (_fishingVisible) _fishingLayer.addTo(getMap());
  console.log(`[supplemental] fishing spots loaded: ${total} features for ${lakeKey}`);
}

const POI_STYLE = {
  fish_attractor: { emoji: '🎯', color: '#00e5ff' },
  boat_ramp:      { emoji: '⛵', color: '#4fc3f7' },
  trailer_ramp:   { emoji: '⛵', color: '#4fc3f7' },
  generic_ramp:   { emoji: '⛵', color: '#4fc3f7' },
  water_access:   { emoji: '🚣', color: '#4fc3f7' },
  place_name:     { emoji: '📌', color: '#aaaaaa' },
};

const VISION_STYLE = {
  DOCK_CLUSTER:    { emoji: '⚓', color: '#03A9F4', label: 'Dock Cluster' },
  RIPRAP:          { emoji: '🪨', color: '#FF9800', label: 'Riprap' },
  BRIDGE:          { emoji: '🌉', color: '#9C27B0', label: 'Bridge / Pilings' },
  FLOODED_TIMBER:  { emoji: '🪵', color: '#795548', label: 'Flooded Timber' },
};

async function loadVisionStructures(lakeKey) {
  if (!mapReady()) return;
  if (_visionLayer) { getMap().removeLayer(_visionLayer); _visionLayer = null; }
  try {
    const url = `${CF_WORKER_URL}/chartpacks/supplemental/${lakeKey}/vision-structure.geojson?v=${Date.now()}`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return;
    const gj = await r.json();
    if (!gj?.features?.length) return;
    const group = L.layerGroup();
    gj.features.forEach(feat => {
      const coords = feat.geometry?.coordinates;
      if (!coords) return;
      const p = feat.properties || {};
      const style = VISION_STYLE[p.structure_type] || { emoji: '📍', color: '#9E9E9E', label: p.structure_type || 'Structure' };
      const conf = p.confidence ? ` (${Math.round(p.confidence * 100)}%)` : '';
      const dockNote = p.dock_count_estimate ? ` ~${p.dock_count_estimate} docks` : '';
      const m = L.circleMarker([coords[1], coords[0]], {
        radius: 7, color: '#fff', weight: 1.5,
        fillColor: style.color, fillOpacity: 0.85
      });
      const featureId = `${coords[0].toFixed(6)},${coords[1].toFixed(6)}`;
      m.bindTooltip(`${style.emoji} ${style.label}${dockNote}${conf}`, { sticky: true, direction: 'top', opacity: 0.9 });
      m.bindPopup(`<b style="color:${style.color}">${style.emoji} ${esc(style.label)}</b>${dockNote}<br>
        <span style="font-size:11px">${esc(p.description || '')}</span><br>
        <span style="color:#aaa;font-size:10px">Confidence: ${conf} · AI vision detection</span><br>
        <button onclick="window._removeVisionStructure('${featureId}')"
          style="margin-top:6px;font-size:11px;padding:3px 10px;background:var(--bad,#b3261e);color:#fff;border:none;border-radius:4px;cursor:pointer">
          🗑 Remove
        </button>`);
      m.featureId = featureId;
      group.addLayer(m);
    });
    _visionLayer = group;
    _visionLayer.addTo(getMap());
    console.log(`[supplemental] vision-structure loaded: ${gj.features.length} features for ${lakeKey}`);
  } catch (e) {
    if (!e.message?.includes('404')) console.warn(`[supplemental] vision-structure fetch failed:`, e.message);
  }
}

// Remove a single vision structure by coordinate ID — patches R2 GeoJSON
window._removeVisionStructure = async function(featureId) {
  if (!_activeLakeKey || !_visionLayer) return;
  // Remove from map
  _visionLayer.eachLayer(l => {
    if (l.featureId === featureId) {
      _visionLayer.removeLayer(l);
      l.closePopup();
    }
  });
  // Patch R2
  try {
    const url = `${CF_WORKER_URL}/chartpacks/supplemental/${_activeLakeKey}/vision-structure.geojson?v=${Date.now()}`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return;
    const gj = await r.json();
    const [flon, flat] = featureId.split(',').map(Number);
    gj.features = gj.features.filter(f => {
      const [lon, lat] = f.geometry?.coordinates || [];
      return !(Math.abs(lon - flon) < 0.000001 && Math.abs(lat - flat) < 0.000001);
    });
    gj.metadata = gj.metadata || {};
    gj.metadata.structuresFound = gj.features.length;
    await fetch(`${CF_WORKER_URL}/research/vision-scan-save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lakeName: gj.metadata?.lakeName || _activeLakeKey,
        features: gj.features,
        tilesTotal: gj.metadata?.tilesTotal,
        tilesProcessed: gj.metadata?.tilesProcessed,
        tilesSkipped: gj.metadata?.tilesSkipped,
      })
    });
    console.log(`[supplemental] vision structure removed: ${featureId}`);
  } catch (e) {
    console.warn(`[supplemental] vision remove failed:`, e.message);
  }
};

async function loadPOIs(lakeKey) {
  if (!mapReady()) return;
  if (_poiLayer) { getMap().removeLayer(_poiLayer); _poiLayer = null; }
  try {
    const gj = await loadLayer(lakeKey, 'pois');
    const group = L.layerGroup();
    gj.features.forEach(feat => {
      const coords = feat.geometry?.coordinates;
      if (!coords) return;
      const p     = feat.properties || {};
      const type  = p.ramp_subtype || p.poi_type || 'place_name';
      const style = POI_STYLE[type] || POI_STYLE.place_name;
      const name  = p.name || type;
      const m = L.circleMarker([coords[1], coords[0]], { radius: 5, color: '#ffffff', weight: 1.5, fillColor: style.color, fillOpacity: 0.9 });
      m.bindTooltip(`${style.emoji} ${esc(name)}`, { sticky: true, direction: 'top', opacity: 0.9 });
      m.bindPopup(`<b style="color:${style.color}">${style.emoji} ${esc(name)}</b><br><span style="color:#aaa;font-size:11px">${esc(type.replace(/_/g, ' '))}</span><br><span style="color:#aaa;font-size:10px">${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}</span>`);
      group.addLayer(m);
    });
    _poiLayer = group;
    if (_poiVisible) _poiLayer.addTo(getMap());
    console.log(`[supplemental] pois loaded: ${gj.features.length} features for ${lakeKey}`);
  } catch (e) {
    if (!e.message.includes('404') && !e.message.includes('empty')) {
      console.warn(`[supplemental] pois fetch failed for ${lakeKey}:`, e.message);
    }
  }
}

async function loadLakeBoundary(displayName) {
  const boundaryKey = resolveBoundaryKey(displayName);
  if (!boundaryKey) return;
  const cacheKey = `boundary/${boundaryKey}`;
  try {
    const cached = await idbGet(cacheKey);
    if (cached?.ts && (Date.now() - cached.ts) < CACHE_TTL && cached.value?.features?.length) {
      _boundaryGeoJSON = cached.value;
      window.LAKE_BOUNDARY_GEOJSON = _boundaryGeoJSON;
      console.log(`[supplemental] boundary loaded from cache: ${boundaryKey}`);
      return;
    }
    const url = `${CF_WORKER_URL}/chartpacks/boundaries/${boundaryKey}.geojson?v=${Date.now()}`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const gj = await r.json();
    if (!gj?.features?.length) throw new Error('empty');
    const main = gj.features.reduce((best, f) => {
      const a = f.properties?.shape_Area || f.properties?.areasqkm || 0;
      return a > (best?.properties?.shape_Area || best?.properties?.areasqkm || 0) ? f : best;
    }, gj.features[0]);
    _boundaryGeoJSON = { type: 'FeatureCollection', features: [main] };
    await idbSet(cacheKey, _boundaryGeoJSON);
    window.LAKE_BOUNDARY_GEOJSON = _boundaryGeoJSON;
    console.log(`[supplemental] boundary loaded: ${boundaryKey}`);
  } catch (e) {
    console.warn(`[supplemental] boundary fetch failed for ${boundaryKey}:`, e.message);
  }
}

export async function loadSupplementalForLake(displayName) {
  if (!displayName || displayName.startsWith('river:')) return;

  const lakeKey = resolveSupplementalKey(displayName);
  if (!lakeKey) return;

  if (lakeKey === _activeLakeKey) return;
  _activeLakeKey = lakeKey;
  window._osmActiveLakeKey = lakeKey;
  _osmStructureData = null;
  window.dispatchEvent(new CustomEvent('trollmap:lakeChanged'));

  if (_fishingLayer) { getMap()?.removeLayer(_fishingLayer); _fishingLayer = null; }
  if (_poiLayer)     { getMap()?.removeLayer(_poiLayer);     _poiLayer     = null; }
  if (_visionLayer)  { getMap()?.removeLayer(_visionLayer);  _visionLayer  = null; _visionVisible = false; }

  _fishingVisible = false;
  _poiVisible     = false;
  _updateButtonState('btnFishingSpots', false);
  _updateButtonState('btnPOI', false);

  await loadDepthAreas(lakeKey);

  loadFishingSpots(lakeKey).catch(() => {});
  loadPOIs(lakeKey).catch(() => {});
  loadLakeBoundary(displayName).catch(() => {});
  // Preload OSM structures for getSupplementalContext and Smart Plan
  fetch(`${CF_WORKER_URL}/chartpacks/supplemental/${lakeKey}/osm-structures.geojson`)
    .then(r => r.ok ? r.json() : null)
    .then(gj => { _osmStructureData = gj && gj.features ? gj.features : []; })
    .catch(() => { _osmStructureData = []; });
}

function _updateButtonState(id, active) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.style.background = active ? 'var(--accent)' : '';
  btn.style.color      = active ? '#000' : '';
}

function wireFishingButton() {
  const btn = document.getElementById('btnFishingSpots');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!mapReady()) return;
    if (!_activeLakeKey) { btn.title = 'Select a lake first'; return; }
    _fishingVisible = !_fishingVisible;
    _updateButtonState('btnFishingSpots', _fishingVisible);
    if (_fishingVisible) {
      if (!_fishingLayer) await loadFishingSpots(_activeLakeKey);
      if (_fishingLayer)  _fishingLayer.addTo(getMap());
    } else {
      if (_fishingLayer) getMap().removeLayer(_fishingLayer);
    }
  });
}

function wirePOIButton() {
  const btn = document.getElementById('btnPOI');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!mapReady()) return;
    if (!_activeLakeKey) { btn.title = 'Select a lake first'; return; }
    _poiVisible = !_poiVisible;
    _updateButtonState('btnPOI', _poiVisible);
    if (_poiVisible) {
      if (!_poiLayer) await loadPOIs(_activeLakeKey);
      if (_poiLayer)  _poiLayer.addTo(getMap());
    } else {
      if (_poiLayer) getMap().removeLayer(_poiLayer);
    }
  });
}

export function getSupplementalContext(lat, lon, radiusMi = 0.5) {
  const R = 3958.8;
  const toRad = d => d * Math.PI / 180;
  function distMi(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }
  const results = { attractors: [], fishingPoints: [], pois: [] };
  if (!_activeLakeKey) return results;
  if (_poiLayer) {
    _poiLayer.eachLayer(l => {
      const ll = l.getLatLng?.();
      if (!ll) return;
      if (distMi(lat, lon, ll.lat, ll.lng) <= radiusMi) {
        const p = l.feature?.properties || {};
        if (p.poi_type === 'fish_attractor') results.attractors.push(p);
        else results.pois.push(p);
      }
    });
  }
  if (_fishingLayer) {
    _fishingLayer.eachLayer(l => {
      const ll = l.getLatLng?.();
      if (!ll) return;
      if (distMi(lat, lon, ll.lat, ll.lng) <= radiusMi) results.fishingPoints.push({ lat: ll.lat, lon: ll.lng });
    });
  }
  if (_osmStructureData && _osmStructureData.length) {
    for (const feat of _osmStructureData) {
      const coords = feat.geometry && feat.geometry.coordinates;
      if (!coords) continue;
      if (distMi(lat, lon, coords[1], coords[0]) <= radiusMi) {
        results.osmStructures = results.osmStructures || [];
        results.osmStructures.push({ lat: coords[1], lon: coords[0], ...feat.properties });
      }
    }
  }
  return results;
}

function init() {
  const btnFishing = document.getElementById('btnFishingSpots');
  const btnPOI     = document.getElementById('btnPOI');
  if (!btnFishing || !btnPOI) { setTimeout(init, 300); return; }
  wireFishingButton();
  wirePOIButton();
  console.log('[supplemental-layers] module ready');
}

init();

window.loadSupplementalForLake = loadSupplementalForLake;
export function getOsmStructures() { return _osmStructureData || []; }

window.toggleDepthAreas = function(visible) {
  _depthAreaVisible = visible;
  if (!_depthAreaLayer) return;
  if (visible) {
    _depthAreaLayer.addTo(getMap());
    _depthAreaLayer.bringToBack();
    window.SUPPLEMENTAL_DEPTH_LAYER = _depthAreaLayer;
  } else {
    getMap()?.removeLayer(_depthAreaLayer);
    window.SUPPLEMENTAL_DEPTH_LAYER = _depthAreaLayer;
  }
};