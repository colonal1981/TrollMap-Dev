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

// Bump this whenever the SHAPE of a chartpack changes — new layers, renamed properties, a
// different source. It is part of every cache key, so bumping it orphans every stale entry at
// once.
//
// Without it, replacing a lake's objects in R2 is invisible for up to 24 hours: loadLayer()
// returns the IndexedDB copy before it ever fetches, so an upload followed by a reload shows
// the OLD data and reads as "the upload didn't work". That is the single most likely way a
// correct chartpack looks broken. v2 = the Garmin RGN2/RGN3/RGN4 pack (2026-08-01).
const CACHE_SCHEMA = 2;

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
  const cacheKey = `v${CACHE_SCHEMA}/${lakeKey}/${layer}`;
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
let _poiGeoJSON       = null;
let _poiOnWaterOnly   = true;    // Garmin ships land classes too; see loadPOIs
let _garminLayers     = {};      // name -> L.GeoJSON  (rendered)
let _garminVisible    = {};      // name -> bool
let _garminData       = {};      // name -> GeoJSON    (fetched, may not be rendered)

// FETCHING AND RENDERING ARE SEPARATE, AND THEY HAVE OPPOSITE COSTS.
//
// Rendering is the expensive half: 2,839 dock polygons on the canvas is what hurts pan and
// zoom, which is why the Garmin layers only draw when their button is clicked. Fetching is
// cheap -- docks is 126 KB gzipped and POIs are 10 KB -- and it is what Smart Plan, the tap
// context panel and notifications actually read.
//
// Tying the two together meant `getSupplementalContext()` returned nothing at all unless the
// user had happened to toggle the layer on BEFORE running a plan. A planner silently missing
// every dock and every piece of charted structure, depending on which buttons were clicked in
// which order, is the kind of bug that never announces itself.
//
// So: prefetch the data on lake select, draw only on demand.
const PREFETCH_LAYERS = ['pois', 'docks'];

async function ensureData(lakeKey, layer) {
  if (_garminData[layer]) return _garminData[layer];
  try {
    const gj = await loadLayer(lakeKey, layer);
    _garminData[layer] = gj;
    return gj;
  } catch (e) {
    _garminData[layer] = null;      // remember the miss; most lakes have no Garmin pack yet
    return null;
  }
}

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

    // STROKE WIDTH HAS TO FOLLOW BAND RESOLUTION.
    //
    // The i-Boating packs carried a handful of wide bands, where a 0.5 px outline reads as a
    // clean edge. The Garmin pack carries 66 one-foot bands and 8,085 polygons over the same
    // water, so every band is a thin ring nested inside the next — outlining all of them turns
    // the lake into a grey mesh and buries the contour lines that are supposed to carry the
    // linework. Above ~20 distinct bands the fill alone is the right rendering.
    const bandCount = new Set(features.map(f => f.properties?.band
                                             ?? f.properties?.depth_max_ft)).size;
    const fineBands = bandCount > 20;
    const strokeW = fineBands ? 0 : 0.5;

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
        return { fillColor: color, fillOpacity: 0.55, color, weight: strokeW,
                 opacity: strokeW ? 0.5 : 0, stroke: strokeW > 0 };
      },
      onEachFeature(feat, layer) {
        const p = feat.properties || {};
        layer.bindTooltip(`Depth zone: ${ftLabel(p.depth_min_ft)}–${ftLabel(p.depth_max_ft)} ft`,
                          { sticky: true, direction: 'top', opacity: 0.85 });
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
    console.log(`[supplemental] depth_areas loaded: ${features.length} features, `
              + `${bandCount} bands, stroke ${strokeW} for ${lakeKey}`);
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

  // ── Garmin RGN4 classes (chartpack schema v2) ──────────────────────────
  // SUBMERGED STRUCTURE — Garmin's own labels off mode 5/1, and the reason the layer exists.
  // Colours match VISION_STYLE where the two describe the same thing (flooded timber, bridge)
  // so an AI-detected dock cluster and a charted one read as the same kind of thing.
  road_bed:         { emoji: '🛣️', color: '#8d6e63', structure: true },
  creek_bed:        { emoji: '🏞️', color: '#26a69a', structure: true },
  river_bed:        { emoji: '🏞️', color: '#00897b', structure: true },
  submerged_bridge: { emoji: '🌉', color: '#9C27B0', structure: true },
  flooded_timber:   { emoji: '🪵', color: '#795548', structure: true },
  shallow_area:     { emoji: '🟨', color: '#ffd54f', structure: true },
  rock:             { emoji: '🪨', color: '#9e9e9e', structure: true },
  wreck:            { emoji: '🚢', color: '#546e7a', structure: true },
  pile:             { emoji: '🧱', color: '#6d4c41', structure: true },
  obstruction:      { emoji: '⛔', color: '#d84315', structure: true },
  hazard_area:      { emoji: '⚠️',  color: '#e53935' },
  dam:              { emoji: '🏗️', color: '#607d8b' },
  // ── on-water services ──
  marina:           { emoji: '⚓', color: '#03A9F4' },
  fuel_dock:        { emoji: '⛽', color: '#43a047' },
  boat_club:        { emoji: '🏛️', color: '#5c6bc0' },
  recreation:       { emoji: '🏕️', color: '#7cb342' },
  campground:       { emoji: '⛺', color: '#8bc34a' },
  picnic:           { emoji: '🧺', color: '#8bc34a' },
  // ── land, kept but filtered out by default (see _poiOnWaterOnly) ──
  store:            { emoji: '🏬', color: '#90a4ae' },
  marine_dealer:    { emoji: '🛠️', color: '#78909c' },
  parking:          { emoji: '🅿️', color: '#90a4ae' },
  height_marker:    { emoji: '📏', color: '#b0bec5' },
  road_shield:      { emoji: '🛣️', color: '#b0bec5' },
  // ── decoded geometry, undecoded meaning ──
  // `garmin_3_26` is the purple triangle Ryan counts about a hundred of on Wateree: one symbol
  // class, position confirmed, name still unknown. It gets a real symbol rather than the grey
  // generic pin precisely BECAUSE it is unidentified — a class nobody can see on the map is a
  // class nobody can identify from the chart.
  garmin_3_26:      { emoji: '🔺', color: '#ab47bc' },
};
// Any `garmin_<mode>` the table has not been taught yet. Falling through to `place_name` would
// hide a whole undecoded class among the lake names.
const POI_STYLE_UNKNOWN = { emoji: '❔', color: '#8e8e8e' };

function poiStyleFor(type) {
  return POI_STYLE[type] || (/^garmin_/.test(type) ? POI_STYLE_UNKNOWN : POI_STYLE.place_name);
}

// Human wording for the types whose key is not something to show a person. Without this a
// popup on an unnamed record reads `place_name` or `garmin_3_26` — the internal key, echoed
// back — because the title falls through to the type when there is no name.
const POI_LABEL = {
  place_name:       'Unlabelled point',
  garmin_3_26:      'Unidentified chart symbol',
  height_marker:    'Height marker',
  road_shield:      'Highway marker',
  submerged_bridge: 'Submerged bridge',
  flooded_timber:   'Flooded timber',
  shallow_area:     'Shallow area',
  hazard_area:      'Hazard area',
  road_bed:         'Submerged road bed',
  creek_bed:        'Creek bed',
  river_bed:        'River bed',
  slow_no_wake:     'No wake',
  restricted_area:  'No boats / restricted',
  mile_marker:      'Marker number',
  marine_dealer:    'Marine dealer',
  fuel_dock:        'Fuel dock',
  boat_club:        'Boat club',
  water_access:     'Water access',
  boat_ramp:        'Boat ramp',
  fish_attractor:   'Fish attractor',
};

function poiLabel(type) {
  if (POI_LABEL[type]) return POI_LABEL[type];
  // garmin_3_26 -> "Unidentified symbol · mode 3/26". The mode is the useful part: it is what
  // identifies the class on the chart, and what a later decode will be keyed on.
  const m = /^garmin_(\d+)_(\d+)$/.exec(type);
  if (m) return `Unidentified symbol · mode ${m[1]}/${m[2]}`;
  return type.replace(/_/g, ' ');
}

// Garmin stores depth in DECIMETRES on a nominal 1 ft ladder, so the ft conversion lands just
// off a whole number: 3 dm = 0.98 ft, 30 dm = 9.84, 34 dm = 11.15. Displaying that raw shows
// "29.9" and "34.1" where the plotter shows 30 and 34. Rounding recovers Garmin's own value
// exactly — the ladder really is whole feet, the fraction is only the metric round-trip.
function ftLabel(v) {
  return (v == null || !Number.isFinite(v)) ? '?' : String(Math.round(v));
}

// Decoded but unidentified. Hidden by default: an unnamed symbol whose meaning nobody knows
// is clutter on a fishing map -- it takes up space and answers no question.
//
// It stays in the DATA regardless. The records carry their raw bytes in the archive, so when a
// class is finally named it can be relabelled without re-reading the card, which is the whole
// reason unidentified records are emitted at all.
//
// Mode 3/26 -- Ryan's purple triangles, 122 on Wateree -- is measured to sit ON DOCKS: median
// 0.2 m to the nearest mode-1/1 dock polygon, p25 0.0 (i.e. inside one), 106 of 122 within 10 m,
// against a median 2,301 m to the nearest ramp. It marks about 4% of docks, so it is a property
// OF a dock rather than the dock itself. Name still unknown; that is B5.
const HIDDEN_TYPES = new Set(['garmin_3_26']);
function isUnidentified(t) { return HIDDEN_TYPES.has(t) || /^garmin_\d+_\d+$/.test(t); }
let _showUnidentified = false;

// Structure classes worth surfacing to Smart Plan and the tap-context panel.
const STRUCTURE_TYPES = new Set(
  Object.entries(POI_STYLE).filter(([, v]) => v.structure).map(([k]) => k));

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

// ── Chart text ────────────────────────────────────────────────────────────────
//
// Garmin does not draw a place name as a clickable pin, and neither should we. Two behaviours,
// both driven off the same label pass:
//
//   place names   text only, no marker, from LABEL_MIN_ZOOM
//   structure     marker always, plus text alongside it from STRUCT_TEXT_MIN_ZOOM
//
// GARMIN REPEATS A NAME AS LABEL *CANDIDATES*, and this is the thing that makes a naive render
// look wrong. `Lake Wateree` appears 16 times spread over 21 km and `97` ten times over 39 km --
// those are not sixteen lakes, they are sixteen places the plotter is allowed to draw the word,
// so it can put it wherever there is room at the current zoom and pan. Drawing every candidate
// gives sixteen identical grey pins down the middle of the lake. The declutter below picks one
// and suppresses the rest, which is what the candidates are for.
const LABEL_MIN_ZOOM       = 11;
const STRUCT_TEXT_MIN_ZOOM = 15;
const LABEL_CLEAR_PX       = 60;   // any two labels
const SAME_NAME_CLEAR_PX   = 320;  // two labels bearing the SAME name
const LABEL_MAX_ON_SCREEN  = 220;

let _poiLabelGroup = null;
let _labelHooked   = false;

function _labelHtml(text, color, size, weight) {
  // Halo via text-shadow: these sit over satellite imagery and the depth fill, and a plain
  // white or plain dark label is unreadable over one or the other.
  return `<span style="font-size:${size}px;font-weight:${weight};color:${color};`
       + `white-space:nowrap;text-shadow:0 0 3px #000,0 0 3px #000,0 0 5px #000;`
       + `transform:translate(-50%,-50%);display:inline-block">${esc(text)}</span>`;
}

function renderPoiLabels() {
  const map = getMap();
  if (!map || !_poiGeoJSON) return;
  if (_poiLabelGroup) { map.removeLayer(_poiLabelGroup); _poiLabelGroup = null; }
  if (!_poiVisible) return;
  const z = map.getZoom();
  if (z < LABEL_MIN_ZOOM) return;

  const group = L.layerGroup();
  const bounds = map.getBounds().pad(0.15);
  const placed = [];            // [{pt, name}]
  const showStruct = z >= STRUCT_TEXT_MIN_ZOOM;
  let count = 0;

  const far = (pt, name) => {
    for (const p of placed) {
      const d = Math.hypot(p.pt.x - pt.x, p.pt.y - pt.y);
      if (d < LABEL_CLEAR_PX) return false;
      if (p.name === name && d < SAME_NAME_CLEAR_PX) return false;
    }
    return true;
  };

  for (const f of _poiGeoJSON.features) {
    if (count >= LABEL_MAX_ON_SCREEN) break;
    const p = f.properties || {};
    if (_poiOnWaterOnly && p.on_water === false) continue;
    const type = p.ramp_subtype || p.poi_type || 'place_name';
    const isPlace = type === 'place_name';
    if (!isPlace && !(showStruct && STRUCTURE_TYPES.has(type))) continue;
    const name = p.name || p.card;
    if (!name) continue;                       // 68 unnamed place records: nothing to draw
    if (isPlace && p._labelFor) continue;      // it is a feature's label, drawn by the feature
    const c = f.geometry?.coordinates;
    if (!c || !bounds.contains([c[1], c[0]])) continue;
    const pt = map.latLngToLayerPoint([c[1], c[0]]);
    if (!far(pt, name)) continue;
    const style = poiStyleFor(type);
    const icon = L.divIcon({
      className: 'poi-lbl',
      html: isPlace ? _labelHtml(name, '#e8f1f8', z >= 14 ? 13 : 12, 600)
                    : _labelHtml(name, style.color, 12, 700),
      iconSize: null,
    });
    L.marker([c[1], c[0]], { icon, interactive: false, keyboard: false, zIndexOffset: 400 })
      .addTo(group);
    placed.push({ pt, name });
    count++;
  }
  _poiLabelGroup = group.addTo(map);
}

function hookLabelRedraw() {
  if (_labelHooked) return;
  const map = getMap();
  if (!map) return;
  map.on('moveend zoomend', renderPoiLabels);
  _labelHooked = true;
}

/**
 * Mark the place-name records that are really LABELS for a classed feature.
 *
 * Ryan's `Lakeside Marina` case: one mode-83/0 marina carrying a services card, and three
 * mode-5/1 records with the identical name sitting 90, 160 and 240 m along the shoreline. The
 * three are label candidates for the marina, not three marinas. Any place-name record whose
 * name matches a classed feature within LABEL_FOR_M is flagged and never drawn on its own --
 * the marina's own symbol and text carry the name.
 */
const LABEL_FOR_M = 400;
function markFeatureLabels(features) {
  const classed = [];
  for (const f of features) {
    const p = f.properties || {};
    const t = p.ramp_subtype || p.poi_type;
    if (!t || t === 'place_name') continue;
    const n = norm(p.name || p.card);
    if (n) classed.push({ n, c: f.geometry?.coordinates });
  }
  let flagged = 0;
  for (const f of features) {
    const p = f.properties || {};
    if ((p.ramp_subtype || p.poi_type) !== 'place_name') continue;
    const n = norm(p.name);
    if (!n) continue;
    const c = f.geometry?.coordinates;
    if (!c) continue;
    for (const k of classed) {
      if (k.n === n && k.c && haversineM(c, k.c) <= LABEL_FOR_M) { p._labelFor = true; flagged++; break; }
    }
  }
  return flagged;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function haversineM(a, b) {
  return Math.hypot((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180) * 111320,
                    (b[1] - a[1]) * 110540);
}

async function loadPOIs(lakeKey) {
  if (!mapReady()) return;
  if (_poiLayer) { getMap().removeLayer(_poiLayer); _poiLayer = null; }
  if (_poiLabelGroup) { getMap().removeLayer(_poiLabelGroup); _poiLabelGroup = null; }
  try {
    const gj = await ensureData(lakeKey, 'pois');
    if (!gj) throw new Error('empty');
    _poiGeoJSON = gj;
    const nLabelFor = markFeatureLabels(gj.features);
    const group = L.layerGroup();
    let shown = 0, hidden = 0, asText = 0, unknown = 0;
    gj.features.forEach(feat => {
      const coords = feat.geometry?.coordinates;
      if (!coords) return;
      const p     = feat.properties || {};
      // `on_water === false` is set by the extractor for Garmin's land classes: highway
      // shields, Lowes and Target, marine dealers, parking, flood-plane height markers.
      // They are decoded correctly and kept in the file on purpose, but they are not what
      // this map is for, so they are off by default rather than dropped.
      if (_poiOnWaterOnly && p.on_water === false) { hidden++; return; }
      const type  = p.ramp_subtype || p.poi_type || 'place_name';
      // A place name is TEXT, not a pin. Drawing it as a grey circle you have to click to be
      // told it says "Lake Wateree" is the thing Garmin conspicuously does not do. These are
      // handled by renderPoiLabels(); an unnamed one has nothing to draw at all.
      if (type === 'place_name') { asText++; return; }
      if (!_showUnidentified && isUnidentified(type)) { unknown++; return; }
      const style = poiStyleFor(type);
      const label = poiLabel(type);
      // Title is the name when Garmin or ActiveCaptain gave one, and the human class name
      // otherwise -- never the raw type key.
      const name  = p.name || p.card || label;
      const sub   = (p.name || p.card) ? label : (p.mode ? `Garmin mode ${p.mode}` : '');
      const m = L.circleMarker([coords[1], coords[0]], { radius: 5, color: '#ffffff', weight: 1.5, fillColor: style.color, fillOpacity: 0.9 });
      m.bindTooltip(`${style.emoji} ${esc(name)}`, { sticky: true, direction: 'top', opacity: 0.9 });
      // Garmin business cards carry a service list (20 of 25 marinas list a Ramp) and free
      // text. Both are worth showing — they are the reason a marina is identifiable as a ramp.
      const svc = Array.isArray(p.services) && p.services.length
        ? `<br><span style="color:#8bc34a;font-size:11px">${esc(p.services.join(' · '))}</span>` : '';
      const lines = Array.isArray(p.card_lines) && p.card_lines.length
        ? `<br><span style="color:#bbb;font-size:11px">${esc(p.card_lines.slice(0, 4).join('<br>'))}</span>`.replace(/&lt;br&gt;/g, '<br>') : '';
      const src = p.source ? `<br><span style="color:#777;font-size:10px">${esc(p.source)}${p.mode && p.source !== 'ActiveCaptain' ? ' · mode ' + esc(p.mode) : ''}</span>` : '';
      const subLine = sub ? `<br><span style="color:#aaa;font-size:11px">${esc(sub)}</span>` : '';
      m.bindPopup(`<b style="color:${style.color}">${style.emoji} ${esc(name)}</b>${subLine}${svc}${lines}<br><span style="color:#aaa;font-size:10px">${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}</span>${src}`);
      m.feature = feat;   // getSupplementalContext reads l.feature.properties
      group.addLayer(m); shown++;
    });
    _poiLayer = group;
    if (_poiVisible) _poiLayer.addTo(getMap());
    hookLabelRedraw();
    renderPoiLabels();
    console.log(`[supplemental] pois loaded: ${shown} symbols, ${asText} drawn as chart text, `
              + `${nLabelFor} suppressed as labels for a named feature, `
              + `${hidden} off-water hidden, ${unknown} unidentified hidden for ${lakeKey}`);
  } catch (e) {
    if (!e.message.includes('404') && !e.message.includes('empty')) {
      console.warn(`[supplemental] pois fetch failed for ${lakeKey}:`, e.message);
    }
  }
}

// ── Garmin chart vector layers (chartpack schema v2) ──────────────────────────
//
// These are new R2 objects and none of them collides with anything already in the bucket:
// `garmin_shoreline` is deliberately NOT `shoreline`, which is a different source.
//
// All four are LAZY. `docks` alone is 2,839 polygons on Wateree and `waterbody` is 2,103, and
// the module already learned on fishing_points that eagerly loading tens of thousands of
// features on lake-select destroys pan and zoom. Nothing here loads until it is switched on.
const GARMIN_LAYERS = {
  docks: {
    label: 'Docks & piers',
    // Garmin mode 1/1: median 48 m2, 97.9% within 15 m of the water edge, one per lot down
    // every developed cove. These are Ryan's "actual docks", not the purple triangles.
    style: { color: '#ffb74d', weight: 1, opacity: 0.9, fillColor: '#ffb74d', fillOpacity: 0.45 },
    tip:   () => '🛥 Dock / pier',
  },
  // NOT SHOWN IN THE PANEL. Measured against what is already on screen, this layer draws
  // nothing new: its union is 70.18 km2 against depth_areas' 71.11 km2, and the water it covers
  // that depth shading does NOT is 0.024 km2 -- 2.4 hectares out of 70 km2. The untagged half
  // (116 farm ponds and the river channel, 21.6 km2) is no better: 0.002 km2 uncovered.
  //
  // Its real job is upstream. Mode 6/20 is what carries the lake id -- `c6 02` = Wateree on
  // 1,830 of these polygons -- which is how a chartpack gets attributed to a lake at all. That
  // makes it essential to the pipeline and useless as a chart layer, so it stays in the pack and
  // out of the panel. Still reachable as window.toggleGarminLayer('waterbody') for debugging.
  waterbody: {
    label: 'Charted water body',
    panel: false,
    style: { color: '#4dd0e1', weight: 1, opacity: 0.8, fillColor: '#4dd0e1', fillOpacity: 0.08 },
    tip:   p => p.lake_id ? `Charted water body (lake id ${p.lake_id})` : 'Charted water body (unnamed)',
  },
  // NOT "streams". Measured, 539.7 km of it splits 404 km (75%) of creeks and river channel
  // running inland, and 136 km (25%) tracing the waterline itself -- which is why it reads as
  // "the shoreline in blue" if you only look at the lake. The creek channels are the useful
  // part: a channel swing is structure.
  hydrography: {
    label: 'Creeks & water edge',
    style: { color: '#4fc3f7', weight: 1, opacity: 0.7 },
    tip:   p => p.name ? `〰 ${p.name}` : '〰 Creek / water edge',
  },
  // NOT SHOWN IN THE PANEL. 96% of its 156 km lies inside hydrography already (150.5 km within
  // 25 m); only 5.5 km is unique to it. Two buttons drawing the same white-and-blue line over
  // each other is worse than one, so this stays in the pack and out of the panel.
  garmin_shoreline: {
    label: 'Charted shoreline',
    panel: false,
    style: { color: '#ffffff', weight: 1, opacity: 0.65 },
    tip:   () => 'Charted shoreline',
  },
};

async function loadGarminLayer(lakeKey, name) {
  if (!mapReady() || _garminLayers[name]) return _garminLayers[name] || null;
  const spec = GARMIN_LAYERS[name];
  if (!spec) return null;
  try {
    const gj = await ensureData(lakeKey, name);
    if (!gj) throw new Error('empty');
    const lyr = L.geoJSON(gj, {
      renderer: _canvasRenderer,
      smoothFactor: 1.2,
      style: () => spec.style,
      onEachFeature(feat, layer) {
        layer.bindTooltip(spec.tip(feat.properties || {}),
                          { sticky: true, direction: 'top', opacity: 0.85 });
      },
    });
    _garminLayers[name] = lyr;
    console.log(`[supplemental] ${name} loaded: ${gj.features.length} features for ${lakeKey}`);
    return lyr;
  } catch (e) {
    // A lake with no Garmin pack 404s here. That is the normal case for most lakes right now
    // and must stay silent, or every lake select logs four warnings.
    if (!/404|empty/.test(e.message || '')) {
      console.warn(`[supplemental] ${name} fetch failed for ${lakeKey}:`, e.message);
    }
    return null;
  }
}

/** Toggle one Garmin vector layer. Callable from the console today; wire a button later. */
window.toggleGarminLayer = async function (name, visible) {
  if (!_activeLakeKey || !GARMIN_LAYERS[name]) return false;
  const want = visible === undefined ? !_garminVisible[name] : !!visible;
  _garminVisible[name] = want;
  if (want) {
    const lyr = _garminLayers[name] || await loadGarminLayer(_activeLakeKey, name);
    if (!lyr) { _garminVisible[name] = false; return false; }
    lyr.addTo(getMap());
    // Order matters: depth shading is the bottom fill, these sit above it, contours and their
    // labels stay on top. Without this, docks vanish under the depth polygons.
    _depthAreaLayer?.bringToBack();
  } else if (_garminLayers[name]) {
    getMap()?.removeLayer(_garminLayers[name]);
  }
  _updateButtonState('btnGarmin_' + name, want);
  return want;
};

/** Turn the whole Garmin chart overlay on or off in one call. */
window.toggleGarminChart = async function (visible) {
  const names = Object.entries(GARMIN_LAYERS).filter(([, s]) => s.panel !== false).map(([n]) => n);
  const want = visible === undefined ? !names.some(n => _garminVisible[n]) : !!visible;
  for (const n of names) await window.toggleGarminLayer(n, want);
  return want;
};

/** Show or hide decoded-but-unnamed Garmin symbol classes (mode 3/26 and friends). */
window.toggleUnidentified = function (show) {
  _showUnidentified = show === undefined ? !_showUnidentified : !!show;
  if (_activeLakeKey && _poiLayer) {
    getMap()?.removeLayer(_poiLayer);
    _poiLayer = null;
    loadPOIs(_activeLakeKey).then(() => { if (_poiVisible) _poiLayer?.addTo(getMap()); });
  }
  return _showUnidentified;
};

/** Show or hide Garmin's land classes (highway shields, stores, parking, height markers). */
window.togglePoiOffWater = function (showOffWater) {
  _poiOnWaterOnly = showOffWater === undefined ? !_poiOnWaterOnly : !showOffWater;
  if (_activeLakeKey && _poiLayer) {
    getMap()?.removeLayer(_poiLayer);
    _poiLayer = null;
    loadPOIs(_activeLakeKey).then(() => { if (_poiVisible) _poiLayer?.addTo(getMap()); });
  }
  return !_poiOnWaterOnly;
};

function clearGarminLayers() {
  for (const lyr of Object.values(_garminLayers)) {
    if (lyr) getMap()?.removeLayer(lyr);
  }
  _garminLayers = {};
  _garminVisible = {};
  _garminData = {};
  _dockClusters = null;
  _paintGarminButtons();
}

// ── Structure Intel panel section ─────────────────────────────────────────────
//
// Injected into `#customVectorPanel`, which custom-vectors.js builds and appends to
// `#panel-map` at module load. Injecting rather than editing that file keeps ownership where
// it belongs: these layers are fetched, cached and styled here, so their controls live here
// too, and custom-vectors.js needs no knowledge of chartpacks.
//
// Every one starts OFF and fetches on first click. That is the difference Ryan asked for
// against the existing Structure Intel behaviour, which loads eagerly and offers a Hide.
// Docks alone is 2,839 polygons on Wateree; on a lake with no Garmin pack the fetch 404s and
// the button simply reports nothing to show.
const GARMIN_PANEL_ID = 'garminChartSection';

function _garminBtnStyle(on, color) {
  return `width:100%;padding:5px;border-radius:5px;border:1px solid ${color};`
       + `background:${on ? color : 'transparent'};color:${on ? '#04121e' : color};`
       + `font-size:11px;font-weight:700;cursor:pointer;text-align:left;padding-left:8px`;
}

function _paintGarminButtons() {
  for (const [name, spec] of Object.entries(GARMIN_LAYERS)) {
    const b = document.getElementById('btnGarmin_' + name);
    if (!b) continue;
    const on = !!_garminVisible[name];
    const n = _garminLayers[name]?.getLayers?.().length;
    b.style.cssText = _garminBtnStyle(on, spec.style.color);
    b.textContent = `${on ? '◉' : '○'} ${spec.label}${on && n ? ` (${n})` : ''}`;
  }
}

function injectGarminPanel() {
  const panel = document.getElementById('customVectorPanel');
  if (!panel || document.getElementById(GARMIN_PANEL_ID)) return !!panel;
  const box = document.createElement('div');
  box.id = GARMIN_PANEL_ID;
  box.style.cssText = 'border-top:1px solid var(--line);padding-top:8px;margin-bottom:8px';
  box.innerHTML =
    `<div style="font-size:10px;color:var(--muted);margin-bottom:5px">`
  + `\u{1F5FA} GARMIN CHART — click to load</div>`
  + `<div style="display:flex;flex-direction:column;gap:3px">`
  + Object.entries(GARMIN_LAYERS).filter(([, spec]) => spec.panel !== false).map(([name, spec]) =>
      `<button id="btnGarmin_${name}" style="${_garminBtnStyle(false, spec.style.color)}">`
    + `○ ${spec.label}</button>`).join('')
  + `</div>`
  + `<button id="btnGarminPoiLand" style="width:100%;margin-top:4px;padding:4px;border-radius:5px;`
  + `border:1px solid var(--line);background:transparent;color:var(--muted);font-size:10px;`
  + `cursor:pointer">○ Show Garmin land POIs</button>`
  + `<button id="btnGarminUnknown" style="width:100%;margin-top:3px;padding:4px;border-radius:5px;`
  + `border:1px solid var(--line);background:transparent;color:var(--muted);font-size:10px;`
  + `cursor:pointer" title="Decoded symbols whose meaning is not yet known — mode 3/26 sits on docks">`
  + `○ Show unidentified symbols</button>`;
  // Above the layer list so it reads as chart data, not as one of the user's own files.
  const anchor = panel.querySelector('#vectorLayerList')?.parentElement;
  if (anchor) panel.insertBefore(box, anchor); else panel.appendChild(box);

  for (const [name, spec] of Object.entries(GARMIN_LAYERS)) {
    if (spec.panel === false) continue;
    document.getElementById('btnGarmin_' + name)?.addEventListener('click', async () => {
      const b = document.getElementById('btnGarmin_' + name);
      if (!_activeLakeKey) { if (b) b.title = 'Select a lake first'; return; }
      if (b) b.textContent = '◌ loading…';
      const on = await window.toggleGarminLayer(name);
      if (!on && !_garminLayers[name] && b) b.title = 'No Garmin data for this lake';
      _paintGarminButtons();
    });
  }
  const ub = document.getElementById('btnGarminUnknown');
  ub?.addEventListener('click', () => {
    const on = window.toggleUnidentified();
    ub.textContent = `${on ? '◉' : '○'} ${on ? 'Hide' : 'Show'} unidentified symbols`;
    ub.style.color = on ? 'var(--accent)' : 'var(--muted)';
  });

  const lb = document.getElementById('btnGarminPoiLand');
  lb?.addEventListener('click', () => {
    const showing = window.togglePoiOffWater();
    lb.textContent = `${showing ? '◉' : '○'} `
                   + `${showing ? 'Hide' : 'Show'} Garmin land POIs`;
    lb.style.color = showing ? 'var(--accent)' : 'var(--muted)';
  });
  return true;
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
  if (_poiLayer)            { getMap()?.removeLayer(_poiLayer);            _poiLayer            = null; _poiGeoJSON = null; }
  if (_poiLabelGroup)       { getMap()?.removeLayer(_poiLabelGroup);       _poiLabelGroup       = null; }
  clearGarminLayers();
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
  // Prefetch the Garmin data Smart Plan reads, WITHOUT drawing it. See ensureData().
  Promise.all(PREFETCH_LAYERS.map(l => ensureData(lakeKey, l))).then(([pois, docks]) => {
    if (pois) { _poiGeoJSON = pois; markFeatureLabels(pois.features); }
    const n = (pois?.features?.length || 0) + (docks?.features?.length || 0);
    if (n) console.log(`[supplemental] garmin context prefetched: `
                     + `${pois?.features?.length || 0} pois, ${docks?.features?.length || 0} docks `
                     + `(not drawn) for ${lakeKey}`);
  }).catch(() => {});

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
    renderPoiLabels();   // labels follow the same toggle as the symbols
  });
}

// ── Dock clustering ───────────────────────────────────────────────────────────
//
// 2,839 individual docks is not a thing a person -- or a language model -- can plan against.
// A fisherman sees a DOCKLINE, and the useful unit is "the run of docks along the east shore"
// or "the pocket of a dozen at the back of that cove". Single-linkage at 100 m produces exactly
// that split on Wateree: 50 runs of 20+ docks, 55 pockets of 8-19, and the rest small groups.
//
// `run_m` is what separates the two readings, so it is reported rather than pre-judged: a
// 66-dock cluster spanning 1,537 m is a shoreline to troll, while 12 docks inside 200 m is a
// spot to stop and work. The planner decides which it is; this just measures.
const DOCK_CLUSTER_GAP_M = 100;
let _dockClusters = null;

function clusterDocks(features) {
  const K = Math.cos(34.4 * Math.PI / 180) * 111320, KY = 110540;
  const pts = [];
  for (const f of features) {
    const ring = f.geometry?.coordinates?.[0];
    if (!ring?.length) continue;
    let x = 0, y = 0;
    for (const c of ring) { x += c[0]; y += c[1]; }
    pts.push([x / ring.length, y / ring.length]);
  }
  const cw = DOCK_CLUSTER_GAP_M / K, ch = DOCK_CLUSTER_GAP_M / KY;
  const grid = new Map();
  pts.forEach(([x, y], i) => {
    const k = `${Math.floor(x / cw)},${Math.floor(y / ch)}`;
    (grid.get(k) || grid.set(k, []).get(k)).push(i);
  });
  const seen = new Array(pts.length).fill(false), out = [];
  for (let i = 0; i < pts.length; i++) {
    if (seen[i]) continue;
    const stack = [i], grp = []; seen[i] = true;
    while (stack.length) {
      const j = stack.pop(); grp.push(j);
      const [xj, yj] = pts[j];
      const cx = Math.floor(xj / cw), cy = Math.floor(yj / ch);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const k of (grid.get(`${cx + dx},${cy + dy}`) || [])) {
          if (seen[k]) continue;
          const [xk, yk] = pts[k];
          if (Math.hypot((xk - xj) * K, (yk - yj) * KY) <= DOCK_CLUSTER_GAP_M) {
            seen[k] = true; stack.push(k);
          }
        }
      }
    }
    const xs = grp.map(g => pts[g][0]), ys = grp.map(g => pts[g][1]);
    const w = (Math.max(...xs) - Math.min(...xs)) * K;
    const h = (Math.max(...ys) - Math.min(...ys)) * KY;
    const brg = (Math.atan2(w, h) * 180 / Math.PI + 360) % 180;
    out.push({
      count: grp.length,
      lat: ys.reduce((a, b) => a + b, 0) / ys.length,
      lon: xs.reduce((a, b) => a + b, 0) / xs.length,
      run_m: Math.round(Math.hypot(w, h)),
      bearing: ['N-S', 'NNE-SSW', 'NE-SW', 'ENE-WSW', 'E-W', 'WNW-ESE', 'NW-SE', 'NNW-SSE'
               ][Math.floor((brg + 11.25) / 22.5) % 8],
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

function dockClusters() {
  if (_dockClusters) return _dockClusters;
  const f = _garminData.docks?.features;
  if (!f) return [];
  _dockClusters = clusterDocks(f);
  return _dockClusters;
}

export function getSupplementalContext(lat, lon, radiusMi = 0.5) {
  // distMi now from utils/geo.js (canonical)
  const results = { attractors: [], fishingPoints: [], pois: [], structures: [], docks: [] };
  if (!_activeLakeKey) return results;
  // Read from the GeoJSON, not the rendered layer.
  //
  // The old form walked `_poiLayer`, which meant Smart Plan saw nothing at all unless the user
  // had toggled the POI button on, and saw nothing off-water even then. The data is in memory
  // either way once the layer has been fetched.
  const src = _poiGeoJSON?.features
    ? _poiGeoJSON.features.map(f => ({ p: f.properties || {}, c: f.geometry?.coordinates }))
    : [];
  for (const { p, c } of src) {
    if (!c || distMi(lat, lon, c[1], c[0]) > radiusMi) continue;
    const t = p.ramp_subtype || p.poi_type;
    if (t === 'fish_attractor') results.attractors.push(p);
    // Garmin's own submerged-structure labels -- road beds, creek beds, submerged bridges,
    // flooded timber, shallow areas. These are the highest-value thing in the pack for a
    // fishing plan and they were previously invisible to it.
    else if (STRUCTURE_TYPES.has(t)) results.structures.push({ ...p, lat: c[1], lon: c[0] });
    else if (p.on_water !== false) results.pois.push(p);
  }
  if (_fishingLayer) {
    _fishingLayer.eachLayer(l => {
      const ll = l.getLatLng?.();
      if (!ll) return;
      if (distMi(lat, lon, ll.lat, ll.lng) <= radiusMi) results.fishingPoints.push({ lat: ll.lat, lon: ll.lng });
    });
  }
  // Charted docks (Garmin mode 1/1). Prefetched, so this answers whether the layer is DRAWN or
  // not. A polygon is reduced to its first vertex -- a dock is ~5 x 10 m, so any vertex is
  // within a boat length of the centre and the extra precision would be noise at plan scale.
  // Clusters, not the 2,839 individual polygons. See clusterDocks().
  for (const c of dockClusters()) {
    if (distMi(lat, lon, c.lat, c.lon) <= radiusMi) results.docks.push(c);
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
      layer.bindTooltip(`Depth zone: ${ftLabel(p.depth_min_ft)}–${ftLabel(p.depth_max_ft)} ft`,
                        { sticky: true, direction: 'top', opacity: 0.85 });
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
  // custom-vectors.js builds #customVectorPanel at module load and it logs "armed" before this
  // module does, so it is normally present already. Retry anyway rather than assume load order.
  if (!injectGarminPanel()) setTimeout(injectGarminPanel, 800);

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