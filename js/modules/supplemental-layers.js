/**
 * supplemental-layers.js — Supplemental PBF-extracted layer integration.
 * Single source of truth for lake→R2 key is js/data/lake-keys.js
 */

import { state, CF_WORKER_URL } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { LAKE_NAME_TO_R2_KEY, resolveR2Key } from '../data/lake-keys.js';
import { distMiFromCoords as distMi } from '../utils/geo.js';

// Canvas renderer — shared for all supplemental polygon/line layers
const _canvasRenderer = L.canvas({ padding: 0.5 });

// ── Unified resolvers ───────────────────────────────────────────────────
// Previously resolveBoundaryKey duplicated the fuzzy logic from lake-keys.js
// with a local copy, which caused drift (e.g. missing entries, coastal keys).
// That broke the geospatial adapter in lake-research-engine.js which uses both
// resolvers to fetch supplemental depth_areas + boundary geojson. Now both
// aliases point to the canonical resolveR2Key.
export const resolveSupplementalKey = resolveR2Key;
export const resolveBoundaryKey = resolveR2Key;

// Re-export map for back-compat
export { LAKE_NAME_TO_R2_KEY, resolveR2Key };

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

// NOAA ENC DEPARE uses metric-derived breaks: 5.9, 11.8, 17.7, 29.9, 35.8, 59.7ft
const DEPTH_BANDS_COASTAL = [
  { max: 5.9,      color: '#e63946' },
  { max: 11.8,     color: '#f4a261' },
  { max: 17.7,     color: '#e9c46a' },
  { max: 29.9,     color: '#2a9d8f' },
  { max: 35.8,     color: '#00e5ff' },
  { max: 59.7,     color: '#0077b6' },
  { max: Infinity, color: '#7b2d8b' },
];

function depthAreaColor(ft, coastal = false) {
  const bands = coastal ? DEPTH_BANDS_COASTAL : DEPTH_BANDS;
  for (const band of bands) {
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
  const url = `${CF_WORKER_URL}/chartpacks/${lakeKey}/${layer}.geojson?v=${Date.now()}`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function loadLayer(lakeKey, layer) {
  const cacheKey = `${lakeKey}/${layer}`;
  // Coastal depth_areas bypass IDB — file updates happen frequently during development
  const bypassIdb = lakeKey.startsWith('coast_') && layer === 'depth_areas';
  if (!bypassIdb) {
    const cached = await idbGet(cacheKey);
    if (cached?.ts && (Date.now() - cached.ts) < CACHE_TTL && cached.value?.features?.length) {
      return cached.value;
    }
  }
  const gj = await fetchSupplemental(lakeKey, layer);
  if (!gj?.features?.length) throw new Error('empty');
  if (!bypassIdb) await idbSet(cacheKey, gj);
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
let _structureMarkerLayer = null;
let _coastalTideHeightFt = null; // set by refreshDepthAreaColors after tide sync

export function getDepthAreaGeoJSON() { return _depthAreaGeoJSON; }
export function getLakeBoundaryGeoJSON() { return _boundaryGeoJSON; }
export function bringDepthAreasToBack() {
  if (_depthAreaLayer) _depthAreaLayer.bringToBack();
}
window.bringDepthAreasToBack = bringDepthAreasToBack;

function getMap() { return state.MAP; }
function mapReady() { return state.MAP_OK && !!state.MAP; }

async function loadDepthAreas(lakeKey) {
  if (!mapReady()) return;
  if (_depthAreaLayer) { getMap().removeLayer(_depthAreaLayer); _depthAreaLayer = null; }
  try {
    const gj = await loadLayer(lakeKey, 'depth_areas');
    const isCoastal = lakeKey.startsWith('coast_');

    // For coastal zones: filter intertidal (depth_max_ft <= 0).
    // Features are pre-sorted scale 4→5 in the GeoJSON so scale 5 renders on top.
    const features = isCoastal
      ? gj.features.filter(f => (f.properties?.depth_max_ft ?? 0) > 0)
      : gj.features;

    _depthAreaLayer = L.geoJSON({ ...gj, features }, {
      renderer: _canvasRenderer,
      smoothFactor: 1.5,
      style(feat) {
        const p = feat.properties || {};
        const chartedFt = p.depth_max_ft ?? p.depth_min_ft ?? p.depth_ft ?? 0;
        // For coastal zones shift color by current tide height so polygons reflect
        // actual water depth at time of trip, not charted MLLW.
        const depthFt = (isCoastal && Number.isFinite(_coastalTideHeightFt))
          ? chartedFt + _coastalTideHeightFt
          : chartedFt;
        const color = depthAreaColor(depthFt, isCoastal);
        return { fillColor: color, fillOpacity: 0.55, color, weight: 0.5, opacity: 0.5 };
      },
      onEachFeature(feat, layer) {
        const p = feat.properties || {};
        const minFt = p.depth_min_ft ?? '?';
        const maxFt = p.depth_max_ft ?? '?';
        layer.bindTooltip(`Depth zone: ${minFt}–${maxFt} ft`, { sticky: true, direction: 'top', opacity: 0.85 });
      },
    });

    if (_depthAreaVisible) {
      _depthAreaLayer.addTo(getMap());
      if (!isCoastal) _depthAreaLayer.bringToBack();
    }
    _depthAreaGeoJSON = gj;
    globalThis.SUPPLEMENTAL_DEPTH_LAYER   = _depthAreaLayer;
    globalThis.SUPPLEMENTAL_DEPTH_GEOJSON = gj;
    window.SUPPLEMENTAL_DEPTH_LAYER       = _depthAreaLayer;
    window.SUPPLEMENTAL_DEPTH_GEOJSON     = gj;
    console.log(`[supplemental] depth_areas loaded: ${features.length} features for ${lakeKey}`);
    // Apply tide-adjusted colors — check immediately and again after a delay
    // to handle the race between depth area load and tide auto-sync
    if (isCoastal) {
      const applyTide = () => {
        const tideFt = _coastalTideHeightFt ?? window._trollmapTide?.heightFt ?? null;
        if (Number.isFinite(tideFt)) refreshDepthAreaColors(tideFt);
      };
      applyTide();
      setTimeout(applyTide, 2000);
    }
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
      renderer: _canvasRenderer,
      smoothFactor: 1.0,
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
  fish_attractor:  { emoji: '🎯', color: '#00e5ff' },
  boat_ramp:       { emoji: '⛵', color: '#4fc3f7' },
  trailer_ramp:    { emoji: '⛵', color: '#4fc3f7' },
  generic_ramp:    { emoji: '⛵', color: '#4fc3f7' },
  water_access:    { emoji: '🚣', color: '#4fc3f7' },
  danger_buoy:     { emoji: '⚠️',  color: '#FF5722' },
  caution_buoy:    { emoji: '🟡', color: '#FF9800' },
  slow_no_wake:    { emoji: '🚤', color: '#FF9800' },
  restricted_area: { emoji: '🚫', color: '#F44336' },
  nav_buoy:        { emoji: '🔴', color: '#F44336' },
  nav_beacon:      { emoji: '🟢', color: '#4CAF50' },
  nav_light:       { emoji: '💡', color: '#FFEB3B' },
  mile_marker:     { emoji: '📍', color: '#9E9E9E' },
  place_name:      { emoji: '📌', color: '#aaaaaa' },
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
    const url = `${CF_WORKER_URL}/chartpacks/${lakeKey}/vision-structure.geojson?v=${Date.now()}`;
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
    const url = `${CF_WORKER_URL}/chartpacks/${_activeLakeKey}/vision-structure.geojson?v=${Date.now()}`;
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
    // Boundary files now stored at {slug}/boundary.geojson (clean flat structure).
    // Route through /chartpacks/lake-boundary worker endpoint which handles key resolution.
    const url = `${CF_WORKER_URL}/chartpacks/lake-boundary?lake=${encodeURIComponent(boundaryKey)}&v=${Date.now()}`;
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

function renderStructureMarkers(displayName) {
  if (!mapReady()) return;
  if (_structureMarkerLayer) { getMap().removeLayer(_structureMarkerLayer); _structureMarkerLayer = null; }
  const profile = window.getResearchedProfile?.(displayName);
  if (!profile) return;
  const se = profile.habitat?.structuralElements || {};
  const humps  = se.humpCoordinates  || [];
  const ledges = se.ledgeCoordinates || [];
  if (!humps.length && !ledges.length) return;

  const group = L.layerGroup();

  for (const h of humps) {
    if (!h.lat || !h.lon) continue;
    L.circleMarker([h.lat, h.lon], {
      renderer: _canvasRenderer,
      radius: 6, color: '#ffb300', weight: 2,
      fillColor: '#ffb300', fillOpacity: 0.5,
    }).bindTooltip(
      `🏔 Hump${h.id ? ' ' + h.id.replace('hump_','#') : ''}${h.areaAcres ? ' ~' + h.areaAcres + 'ac' : ''}${h.depth ? ' @' + h.depth + 'ft' : ''}`,
      { sticky: true, direction: 'top', opacity: 0.9 }
    ).addTo(group);
  }

  for (const l of ledges) {
    if (!l.lat || !l.lon) continue;
    L.circleMarker([l.lat, l.lon], {
      renderer: _canvasRenderer,
      radius: 5, color: '#00e5ff', weight: 2,
      fillColor: '#00e5ff', fillOpacity: 0.5,
    }).bindTooltip(
      `📐 Ledge${l.id ? ' ' + l.id.replace('ledge_','#') : ''}${l.contourDensity ? ' (' + l.contourDensity + ' contours)' : ''}`,
      { sticky: true, direction: 'top', opacity: 0.9 }
    ).addTo(group);
  }

  _structureMarkerLayer = group;
  group.addTo(getMap());
  console.log(`[supplemental] structure markers: ${humps.length} humps, ${ledges.length} ledges for ${displayName}`);
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

  if (_fishingLayer)        { getMap()?.removeLayer(_fishingLayer);        _fishingLayer        = null; }
  if (_poiLayer)            { getMap()?.removeLayer(_poiLayer);            _poiLayer            = null; }
  if (_visionLayer)         { getMap()?.removeLayer(_visionLayer);         _visionLayer         = null; _visionVisible = false; }
  if (_structureMarkerLayer){ getMap()?.removeLayer(_structureMarkerLayer); _structureMarkerLayer = null; }

  _fishingVisible = false;
  _poiVisible     = false;
  _updateButtonState('btnFishingSpots', false);
  _updateButtonState('btnPOI', false);

  await loadDepthAreas(lakeKey);

  // Render hump/ledge markers from research profile.
  // If profile not cached yet, load it silently then render markers.
  if (window.getResearchedProfile?.(displayName)) {
    renderStructureMarkers(displayName);
  } else if (window.loadProfile) {
    window.loadProfile(displayName, true).then(() => renderStructureMarkers(displayName)).catch(() => {});
  } else {
    // loadProfile not yet available — retry after delay
    setTimeout(() => {
      if (window.getResearchedProfile?.(displayName)) {
        renderStructureMarkers(displayName);
      } else {
        window.loadProfile?.(displayName, true).then(() => renderStructureMarkers(displayName)).catch(() => {});
      }
    }, 2000);
  }

  // For coastal zones: fetch current tide height and apply color adjustment.
  // This covers the Map tab where noaa-tides.js auto-sync doesn't fire.
  if (lakeKey.startsWith('coast_')) {
    const { getTideStateForZone } = await import('./tide-engine.js').catch(() => ({}));
    if (getTideStateForZone) {
      getTideStateForZone(lakeKey).then(tide => {
        if (tide?.heightFt != null && Number.isFinite(tide.heightFt)) {
          window._trollmapTide = tide;
          refreshDepthAreaColors(tide.heightFt);
          window.refreshSoundingLabels?.(tide.heightFt);
        }
      }).catch(() => {});
    }
  }

  // Coastal-only layers (oyster beds / marsh edges / soundings). The module
  // clears itself for freshwater keys, so this is safe to call unconditionally.
  window.loadCoastalLayersForZone?.(lakeKey);

  // Fishing spots and POIs are lazy — only fetch when user toggles them on.
  // Preloading 90K+ fishing features on large lakes kills scroll/zoom performance.
  loadLakeBoundary(displayName).catch(() => {});
  // Preload OSM structures for getSupplementalContext and Smart Plan
  fetch(`${CF_WORKER_URL}/chartpacks/${lakeKey}/osm-structures.geojson`)
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
  // distMi now from utils/geo.js (canonical)
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

/**
 * Re-render coastal depth area polygons with tide-adjusted colors.
 * Called by coastal-layers.js after a tide sync.
 */
export function refreshDepthAreaColors(tideHeightFt) {
  if (!_activeLakeKey?.startsWith('coast_')) {
    // Depth areas may still be loading — retry once after a short delay
    setTimeout(() => {
      if (_activeLakeKey?.startsWith('coast_') && _depthAreaGeoJSON) {
        refreshDepthAreaColors(tideHeightFt);
      }
    }, 1500);
    return;
  }
  _coastalTideHeightFt = Number.isFinite(tideHeightFt) ? tideHeightFt : null;
  if (!_depthAreaGeoJSON || !mapReady()) return;
  // Re-render directly from cached GeoJSON — no fetch
  const gj = _depthAreaGeoJSON;
  const isCoastal = true;
  if (_depthAreaLayer) { getMap().removeLayer(_depthAreaLayer); _depthAreaLayer = null; }
  const features = gj.features.filter(f => (f.properties?.depth_max_ft ?? 0) > 0);
  _depthAreaLayer = L.geoJSON({ ...gj, features }, {
    renderer: _canvasRenderer,
    smoothFactor: 1.5,
    style(feat) {
      const p = feat.properties || {};
      const chartedFt = p.depth_max_ft ?? p.depth_min_ft ?? p.depth_ft ?? 0;
      const depthFt = Number.isFinite(_coastalTideHeightFt)
        ? chartedFt + _coastalTideHeightFt
        : chartedFt;
      const color = depthAreaColor(depthFt, isCoastal);
      return { fillColor: color, fillOpacity: 0.55, color, weight: 0.5, opacity: 0.5 };
    },
    onEachFeature(feat, layer) {
      const p = feat.properties || {};
      layer.bindTooltip(`Depth zone: ${p.depth_min_ft ?? '?'}–${p.depth_max_ft ?? '?'} ft`, { sticky: true, direction: 'top', opacity: 0.85 });
    },
  });
  if (_depthAreaVisible) _depthAreaLayer.addTo(getMap());
  window.SUPPLEMENTAL_DEPTH_LAYER = _depthAreaLayer;
  console.log(`[supplemental] depth_areas re-colored: tide ${_coastalTideHeightFt}ft`);
}
window.refreshDepthAreaColors = refreshDepthAreaColors;

function init() {
  const btnFishing = document.getElementById('btnFishingSpots');
  const btnPOI     = document.getElementById('btnPOI');
  if (!btnFishing || !btnPOI) { setTimeout(init, 300); return; }
  wireFishingButton();
  wirePOIButton();

  // Re-render structure markers when research profile finishes loading
  window.addEventListener('trollmap:profileLoaded', (e) => {
    const name = e.detail?.lakeName || _activeLakeKey;
    if (name) renderStructureMarkers(name);
  });

  console.log('[supplemental-layers] module ready');
}

init();

window.loadSupplementalForLake = loadSupplementalForLake;
window.getSupplementalContext = getSupplementalContext;
export function getOsmStructures() { return _osmStructureData || []; }
window._seedOsmStructureData = (features) => { if (!_osmStructureData?.length) _osmStructureData = features; };

window.toggleDepthAreas = function(visible) {
  _depthAreaVisible = visible;
  if (!_depthAreaLayer) return;
  if (visible) {
    _depthAreaLayer.addTo(getMap());
    if (!_activeLakeKey?.startsWith('coast_')) _depthAreaLayer.bringToBack();
    window.SUPPLEMENTAL_DEPTH_LAYER = _depthAreaLayer;
  } else {
    getMap()?.removeLayer(_depthAreaLayer);
    window.SUPPLEMENTAL_DEPTH_LAYER = _depthAreaLayer;
  }
};