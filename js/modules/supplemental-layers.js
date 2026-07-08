/**
 * supplemental-layers.js — Supplemental PBF-extracted layer integration.
 *
 * Layers:
 *   depth_areas    — DEPARE depth zone polygons, auto-loads with contours on lake select
 *   fishing_spots  — fishing_points + fishing_lines combined, toggle button
 *   pois           — place names, landings, attractors, ramps (display only), toggle button
 *
 * R2 paths: supplemental/{lake_key}/{layer}.geojson
 * Fetched via: GET /chartpacks/supplemental/{lake_key}/{layer}.geojson
 *
 * IDB cache: 24hr TTL per layer per lake key (same pattern as contour-data.js)
 *
 * Lake awareness: all layers key off the same LAKE_NAME_TO_R2_KEY map used by
 * contour-data.js. When no lake is selected nothing loads.
 */

import { state, CF_WORKER_URL } from '../core/state.js';
import { esc } from '../utils/escape.js';

// ── Mirrors contour-data.js LAKE_NAME_TO_R2_KEY exactly ──────────────────────
const LAKE_NAME_TO_R2_KEY = {
  'Lake Marion, SC':               'lake_marion',
  'Lake Moultrie, SC':             'lake_moultrie',
  'Lake Murray, SC':               'lake_murray',
  'Lake Wateree, SC':              'lake_wateree_fishing_creek',
  'Fishing Creek Reservoir, SC':   'lake_wateree_fishing_creek',
  'Lake Wylie, SC/NC':             'lake_wylie',
  'Lake Hartwell, SC/GA':          'lake_hartwell',
  'Lake Greenwood, SC':            'lake_greenwood_secession',
  'Lake Secession, SC':            'lake_greenwood_secession',
  'Lake Keowee, SC':               'lake_keowee',
  'Lake Jocassee, SC/NC':          'lake_jocassee',
  'Lake Russell, SC/GA':           'lake_thurmond_russell',
  'Clarks Hill / Thurmond, SC/GA': 'lake_thurmond_russell',
  'Lake Monticello, SC':           'lake_monticello_parr',
  'Parr Reservoir, SC':            'lake_monticello_parr',
  'Lake Robinson, SC':             'north_saluda_reservoir',
  'Lake Bowen, SC':                'lake_bowen',
  'Lake Blalock, SC':              'lake_blalock',
  'Lake Norman, NC':               'lake_norman_mountain_island',
  'Mountain Island Lake, NC':      'lake_norman_mountain_island',
  'Lake Hickory, NC':              'lake_hickory_rhodhiss',
  'Lake Rhodhiss, NC':             'lake_hickory_rhodhiss',
  'Lake James, NC':                'lake_james',
  'Lake Lure, NC':                 'lake_lure',
  'High Rock Lake, NC':            'yadkin_river_chain',
  'Badin Lake, NC':                'yadkin_river_chain',
  'Lake Tillery, NC':              'yadkin_river_chain',
  'Blewett Falls Lake, NC':        'yadkin_river_chain',
  'Jordan Lake, NC':               'jordan_lake',
  'Falls Lake, NC':                'falls_lake',
  'Lake Norman, NC':               'lake_norman_mountain_island',
  'Lake Allatoona, GA':            'lake_allatoona',
  'Lake Lanier, GA':               'lake_lanier',
  'Lake Oconee, GA':               'lake_oconee',
  'Lake Sinclair, GA':             'lake_sinclair',
  'Lake Blue Ridge, GA':           'lake_blue_ridge',
  'Lake Nottely, GA':              'lake_nottely',
  'Lake Burton, GA':               'lake_burton',
  'West Point Lake, GA':           'west_point_lake',
  'Lake Blackshear, GA':           'lake_blackshear',
  'Fort Loudoun Lake, TN':         'fort_loudoun_lake',
  'Tellico Lake, TN':              'tellico_lake',
  'Norris Lake, TN':               'norris_lake',
  'Douglas Lake, TN':              'douglas_lake',
  'Cherokee Lake, TN':             'cherokee_lake',
  'Chickamauga Lake, TN':          'chickamauga_lake',
  'Watts Bar Lake, TN':            'watts_bar_lake',
  'Fontana Lake, NC':              'fontana_lake',
  'Hiwassee Lake, NC':             'hiwassee_lake',
  'Nantahala Lake, NC':            'nantahala_lake',
};

// Maps display name → NHD boundary filename (in trollmap-chartpacks/boundaries/)
const LAKE_BOUNDARY_KEY = {
  'Lake Marion, SC':               'lake_marion_3dhp',
  'Lake Moultrie, SC':             'lake_moultrie_3dhp',
  'Lake Murray, SC':               'lake_murray_3dhp',
  'Lake Wateree, SC':              'lake_wateree_3dhp',
  'Fishing Creek Reservoir, SC':   'lake_wateree_3dhp',
  'Lake Monticello, SC':           'lake_monticello_3dhp',
  'Parr Reservoir, SC':            'lake_monticello_3dhp',
};

// ── Depth color scale — matches contour-data.js DEPTH_COLORS exactly ─────────
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

// ── IDB cache ─────────────────────────────────────────────────────────────────
const IDB_NAME    = 'trollmap-supplemental';
const IDB_STORE   = 'layers';
const IDB_VERSION = 1;
const CACHE_TTL   = 24 * 60 * 60 * 1000; // 24hr

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

// ── R2 fetch ──────────────────────────────────────────────────────────────────
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

// ── Module state ──────────────────────────────────────────────────────────────
let _activeLakeKey      = null;

// Depth areas — auto layer
let _depthAreaLayer     = null;
let _depthAreaVisible   = true; // on by default
let _depthAreaGeoJSON   = null; // raw GeoJSON — accessible to route-builder

// Export getter for route-builder.js to access depth polygon data
export function getDepthAreaGeoJSON() { return _depthAreaGeoJSON; }

// Fishing spots toggle
let _fishingLayer       = null;
let _fishingVisible     = false;

// POI toggle
let _poiLayer           = null;
let _poiVisible         = false;

// Lake boundary — loaded silently, exposed globally for route clipping
let _boundaryGeoJSON    = null;
export function getLakeBoundaryGeoJSON() { return _boundaryGeoJSON; }

function getMap() { return state.MAP; }
function mapReady() { return state.MAP_OK && !!state.MAP; }

// ── Depth area layer ──────────────────────────────────────────────────────────
async function loadDepthAreas(lakeKey) {
  if (!mapReady()) return;

  // Clear previous
  if (_depthAreaLayer) {
    getMap().removeLayer(_depthAreaLayer);
    _depthAreaLayer = null;
  }

  try {
    const gj = await loadLayer(lakeKey, 'depth_areas');
    _depthAreaLayer = L.geoJSON(gj, {
      style(feat) {
        const depthFt = feat.properties?.depth_max_ft ?? feat.properties?.depth_min_ft ?? 0;
        const color   = depthAreaColor(depthFt);
        return {
          fillColor:   color,
          fillOpacity: 0.30,
          color:       color,
          weight:      0.5,
          opacity:     0.5,
        };
      },
      onEachFeature(feat, layer) {
        const p = feat.properties || {};
        const minFt = p.depth_min_ft ?? '?';
        const maxFt = p.depth_max_ft ?? '?';
        layer.bindTooltip(`Depth zone: ${minFt}–${maxFt} ft`, {
          sticky: true, direction: 'top', opacity: 0.85,
        });
      },
    });

    if (_depthAreaVisible) {
      _depthAreaLayer.addTo(getMap());
      // Depth areas go below contour lines — insert behind other layers
      _depthAreaLayer.bringToBack();
    }
    // Store in module variable (reliable) + window globals (fallback)
    _depthAreaGeoJSON = gj;
    globalThis.SUPPLEMENTAL_DEPTH_LAYER = _depthAreaLayer;
    globalThis.SUPPLEMENTAL_DEPTH_GEOJSON = gj;
    window.SUPPLEMENTAL_DEPTH_LAYER = _depthAreaLayer;
    window.SUPPLEMENTAL_DEPTH_GEOJSON = gj;
    console.log(`[supplemental] depth_areas loaded: ${gj.features.length} features for ${lakeKey}`);
  } catch (e) {
    // No depth areas for this lake — silent fail, not every lake has them
    if (!e.message.includes('404') && !e.message.includes('empty')) {
      console.warn(`[supplemental] depth_areas fetch failed for ${lakeKey}:`, e.message);
    }
  }
}

// ── Fishing spots layer ───────────────────────────────────────────────────────
async function loadFishingSpots(lakeKey) {
  if (!mapReady()) return;
  if (_fishingLayer) { getMap().removeLayer(_fishingLayer); _fishingLayer = null; }

  const group = L.layerGroup();
  let total = 0;

  // Points
  try {
    const pts = await loadLayer(lakeKey, 'fishing_points');
    pts.features.forEach(feat => {
      const coords = feat.geometry?.coordinates;
      if (!coords) return;
      const m = L.circleMarker([coords[1], coords[0]], {
        radius: 4,
        color: '#76ff03',
        weight: 1,
        fillColor: '#76ff03',
        fillOpacity: 0.7,
      });
      m.bindTooltip('Community fishing spot', { sticky: true, direction: 'top', opacity: 0.85 });
      group.addLayer(m);
      total++;
    });
  } catch (_) {}

  // Lines
  try {
    const lines = await loadLayer(lakeKey, 'fishing_lines');
    L.geoJSON(lines, {
      style() {
        return { color: '#76ff03', weight: 1.5, opacity: 0.55, dashArray: '4,4' };
      },
      onEachFeature(feat, layer) {
        layer.bindTooltip('Community fishing path', { sticky: true, direction: 'top', opacity: 0.85 });
      },
    }).eachLayer(l => { group.addLayer(l); total++; });
  } catch (_) {}

  if (total === 0) {
    console.log(`[supplemental] no fishing spots data for ${lakeKey}`);
    return;
  }

  _fishingLayer = group;
  if (_fishingVisible) _fishingLayer.addTo(getMap());
  console.log(`[supplemental] fishing spots loaded: ${total} features for ${lakeKey}`);
}

// ── POI layer ─────────────────────────────────────────────────────────────────
const POI_STYLE = {
  fish_attractor: { emoji: '🎯', color: '#00e5ff' },
  boat_ramp:      { emoji: '⛵', color: '#4fc3f7' },
  trailer_ramp:   { emoji: '⛵', color: '#4fc3f7' },
  generic_ramp:   { emoji: '⛵', color: '#4fc3f7' },
  water_access:   { emoji: '🚣', color: '#4fc3f7' },
  place_name:     { emoji: '📌', color: '#aaaaaa' },
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

      const m = L.circleMarker([coords[1], coords[0]], {
        radius: 5,
        color: '#ffffff',
        weight: 1.5,
        fillColor: style.color,
        fillOpacity: 0.9,
      });

      m.bindTooltip(`${style.emoji} ${esc(name)}`, {
        sticky: true, direction: 'top', opacity: 0.9,
      });
      m.bindPopup(`
        <b style="color:${style.color}">${style.emoji} ${esc(name)}</b><br>
        <span style="color:#aaa;font-size:11px">${esc(type.replace(/_/g, ' '))}</span><br>
        <span style="color:#aaa;font-size:10px">${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}</span>
      `);
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

// ── Lake change — loads all layers for the new lake ───────────────────────────
// ── Lake boundary ────────────────────────────────────────────────────────────
async function loadLakeBoundary(displayName) {
  const boundaryKey = LAKE_BOUNDARY_KEY[displayName];
  if (!boundaryKey) return;

  const cacheKey = `boundary/${boundaryKey}`;
  try {
    const cached = await idbGet(cacheKey);
    if (cached?.ts && (Date.now() - cached.ts) < CACHE_TTL && cached.value?.features?.length) {
      _boundaryGeoJSON = cached.value;
      console.log(`[supplemental] boundary loaded from cache: ${boundaryKey}`);
      return;
    }
    const url = `${CF_WORKER_URL}/chartpacks/boundaries/${boundaryKey}.geojson?v=${Date.now()}`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const gj = await r.json();
    if (!gj?.features?.length) throw new Error('empty');
    // Find the main lake polygon (largest by area)
    const main = gj.features.reduce((best, f) => {
      const a = f.properties?.shape_Area || f.properties?.areasqkm || 0;
      return a > (best?.properties?.shape_Area || best?.properties?.areasqkm || 0) ? f : best;
    }, gj.features[0]);
    _boundaryGeoJSON = { type: 'FeatureCollection', features: [main] };
    await idbSet(cacheKey, _boundaryGeoJSON);
    console.log(`[supplemental] boundary loaded: ${boundaryKey} (${gj.features.length} features, using largest)`);
    // Expose globally for route-builder clipping
    window.LAKE_BOUNDARY_GEOJSON = _boundaryGeoJSON;
  } catch (e) {
    console.warn(`[supplemental] boundary fetch failed for ${boundaryKey}:`, e.message);
  }
}

export async function loadSupplementalForLake(displayName) {
  if (!displayName || displayName.startsWith('river:')) return;

  const lakeKey = LAKE_NAME_TO_R2_KEY[displayName];
  if (!lakeKey) return; // No supplemental data for this lake

  if (lakeKey === _activeLakeKey) return; // Already loaded
  _activeLakeKey = lakeKey;

  // Clear existing toggle layers when lake changes
  if (_fishingLayer) { getMap()?.removeLayer(_fishingLayer); _fishingLayer = null; }
  if (_poiLayer)     { getMap()?.removeLayer(_poiLayer);     _poiLayer     = null; }

  // Reset toggle button states
  _fishingVisible = false;
  _poiVisible     = false;
  _updateButtonState('btnFishingSpots', false);
  _updateButtonState('btnPOI', false);

  // Depth areas load automatically alongside contours
  await loadDepthAreas(lakeKey);

  // Pre-fetch fishing spots, POIs, and lake boundary in background
  loadFishingSpots(lakeKey).catch(() => {});
  loadPOIs(lakeKey).catch(() => {});
  loadLakeBoundary(displayName).catch(() => {});
}

// ── Button state helper ───────────────────────────────────────────────────────
function _updateButtonState(id, active) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.style.background = active ? 'var(--accent)' : '';
  btn.style.color      = active ? '#000' : '';
}

// ── Toggle buttons ────────────────────────────────────────────────────────────
function wireFishingButton() {
  const btn = document.getElementById('btnFishingSpots');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!mapReady()) return;
    if (!_activeLakeKey) {
      btn.title = 'Select a lake first';
      return;
    }

    _fishingVisible = !_fishingVisible;
    _updateButtonState('btnFishingSpots', _fishingVisible);

    if (_fishingVisible) {
      if (!_fishingLayer) await loadFishingSpots(_activeLakeKey);
      if (_fishingLayer)  _fishingLayer.addTo(getMap());
    } else {
      if (_fishingLayer)  getMap().removeLayer(_fishingLayer);
    }
  });
}

function wirePOIButton() {
  const btn = document.getElementById('btnPOI');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!mapReady()) return;
    if (!_activeLakeKey) {
      btn.title = 'Select a lake first';
      return;
    }

    _poiVisible = !_poiVisible;
    _updateButtonState('btnPOI', _poiVisible);

    if (_poiVisible) {
      if (!_poiLayer) await loadPOIs(_activeLakeKey);
      if (_poiLayer)  _poiLayer.addTo(getMap());
    } else {
      if (_poiLayer)  getMap().removeLayer(_poiLayer);
    }
  });
}

// ── Public API for Smart Plan context ────────────────────────────────────────
// Returns attractor + fishing point features near a lat/lon within radiusMi
export function getSupplementalContext(lat, lon, radiusMi = 0.5) {
  const R = 3958.8; // Earth radius miles
  const toRad = d => d * Math.PI / 180;
  function distMi(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  const results = { attractors: [], fishingPoints: [], pois: [] };
  if (!_activeLakeKey) return results;

  // Pull from cached IDB or in-memory layers
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
      if (distMi(lat, lon, ll.lat, ll.lng) <= radiusMi) {
        results.fishingPoints.push({ lat: ll.lat, lon: ll.lng });
      }
    });
  }

  return results;
}

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  const btnFishing = document.getElementById('btnFishingSpots');
  const btnPOI     = document.getElementById('btnPOI');

  if (!btnFishing || !btnPOI) {
    setTimeout(init, 300);
    return;
  }

  wireFishingButton();
  wirePOIButton();
  console.log('[supplemental-layers] module ready');
}

init();

// Expose for lake-ramp-select.js hook
window.loadSupplementalForLake = loadSupplementalForLake;

// Toggle depth area polygons — called by contour-data.js checkbox
window.toggleDepthAreas = function(visible) {
  _depthAreaVisible = visible;
  if (!_depthAreaLayer) return;
  if (visible) {
    _depthAreaLayer.addTo(getMap());
    _depthAreaLayer.bringToBack();
    window.SUPPLEMENTAL_DEPTH_LAYER = _depthAreaLayer;
  } else {
    getMap()?.removeLayer(_depthAreaLayer);
    // Keep reference available for routing even when hidden visually
    window.SUPPLEMENTAL_DEPTH_LAYER = _depthAreaLayer;
  }
};