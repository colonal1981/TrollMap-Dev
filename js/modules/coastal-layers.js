/**
 * coastal-layers.js — oyster beds, marsh edges and depth soundings.
 *
 * These three layers only exist for `coast_*` zones and have no freshwater
 * equivalent, so they live here rather than bloating supplemental-layers.js
 * (which already handles depth_areas / POIs / OSM structures generically and
 * works for coastal zones unchanged).
 *
 * Data provenance (see Scripts/extract_coastal_habitat.py):
 *   oyster_beds     SCDNR + NCDMF BENTHIC polygons. SC/NC only — GA has no
 *                   public oyster shapefile, so GA zones legitimately 404.
 *   marsh_edges     ESI code 9/10 salt marsh lines. SC/GA/NC.
 *   depth_soundings Point depths, MLLW. Rendered as labels at zoom >= 13.
 *
 * Soundings are tide-corrected for display: charted MLLW depths understate
 * actual water by the current tide height, and an angler reading "2 ft" on a
 * 5 ft flood tide would needlessly avoid perfectly runnable water.
 */

import { state, CF_WORKER_URL } from '../core/state.js';
import { isCoastalKey } from '../data/coastal-zones.js';
import { tideAdjustedDepth } from './tide-engine.js';

const _renderer = L.canvas({ padding: 0.5 });

// Zoom at which individual sounding labels become readable rather than soup.
const SOUNDING_MIN_ZOOM = 13;

const STYLE = {
  oyster: { color: '#c68642', fill: '#c68642' },
  marsh:  { color: '#5cb85c' },
};

function getMap() { return state.MAP; }
function mapReady() { return state.MAP_OK && !!state.MAP; }

// ── Fetch + cache ───────────────────────────────────────────────────────────
const _memCache = new Map();

async function fetchCoastalLayer(zoneKey, layer) {
  const cacheKey = `${zoneKey}/${layer}`;
  if (_memCache.has(cacheKey)) return _memCache.get(cacheKey);

  const url = `${CF_WORKER_URL}/chartpacks/${zoneKey}/${layer}.geojson`;
  const res = await fetch(url, { cache: 'default' });
  if (!res.ok) {
    // 404 is expected and normal (GA has no oyster data) — cache the miss so
    // toggling the button repeatedly does not re-request it every time.
    _memCache.set(cacheKey, null);
    if (res.status === 404) return null;
    throw new Error(`HTTP ${res.status}`);
  }
  const gj = await res.json();
  const value = gj?.features?.length ? gj : null;
  _memCache.set(cacheKey, value);
  return value;
}

// ── Layer state ─────────────────────────────────────────────────────────────
let _activeZoneKey  = null;
let _oysterLayer    = null;
let _marshLayer     = null;
let _soundingLayer  = null;
let _soundingData   = null;
let _oysterVisible  = false;
let _marshVisible   = false;
let _soundingVisible = false;
let _zoomHandlerBound = false;

/** Current tide height in ft, or null. Set by refreshSoundingLabels(). */
let _tideHeightFt = null;

// ── Oyster beds ─────────────────────────────────────────────────────────────
async function buildOysterLayer(zoneKey) {
  const gj = await fetchCoastalLayer(zoneKey, 'oyster_beds');
  if (!gj) return null;
  return L.geoJSON(gj, {
    renderer: _renderer,
    smoothFactor: 1.5,
    style() {
      return {
        color: STYLE.oyster.color,
        weight: 1,
        opacity: 0.9,
        fillColor: STYLE.oyster.fill,
        fillOpacity: 0.35,
      };
    },
    pointToLayer(feat, latlng) {
      return L.circleMarker(latlng, {
        radius: 4, color: STYLE.oyster.color, weight: 1,
        fillColor: STYLE.oyster.fill, fillOpacity: 0.7,
      });
    },
    onEachFeature(feat, layer) {
      layer.bindTooltip('🦪 Oyster bed — redfish on moving water', {
        sticky: true, direction: 'top', opacity: 0.85,
      });
    },
  });
}

// ── Marsh edges ─────────────────────────────────────────────────────────────
async function buildMarshLayer(zoneKey) {
  const gj = await fetchCoastalLayer(zoneKey, 'marsh_edges');
  if (!gj) return null;
  return L.geoJSON(gj, {
    renderer: _renderer,
    smoothFactor: 1.5,
    style() {
      return { color: STYLE.marsh.color, weight: 2, opacity: 0.75, dashArray: '6,3' };
    },
    onEachFeature(feat, layer) {
      layer.bindTooltip('🌾 Spartina marsh edge — flood-tide redfish', {
        sticky: true, direction: 'top', opacity: 0.85,
      });
    },
  });
}

// ── Depth soundings ─────────────────────────────────────────────────────────
function soundingLabelHtml(chartedFt, adjustedFt) {
  const shown = Number.isFinite(adjustedFt) ? adjustedFt : chartedFt;
  // Colour by actual runnable water, not charted datum.
  const color =
    shown < 2  ? '#e53935' :
    shown < 4  ? '#fb8c00' :
    shown < 8  ? '#fdd835' : '#4fc3f7';
  return `<span style="
    color:${color};font-size:10px;font-weight:700;
    text-shadow:0 0 3px #000,0 0 2px #000;white-space:nowrap;
  ">${shown.toFixed(1)}</span>`;
}

function buildSoundingMarkers(features, tideFt) {
  const group = L.layerGroup();
  for (const feat of features) {
    const coords = feat.geometry?.coordinates;
    if (!coords) continue;
    const charted = Number(feat.properties?.depth_ft);
    if (!Number.isFinite(charted)) continue;
    const adjusted = tideAdjustedDepth(charted, tideFt);

    const marker = L.marker([coords[1], coords[0]], {
      interactive: true,
      icon: L.divIcon({
        className: 'coastal-sounding',
        html: soundingLabelHtml(charted, adjusted),
        iconSize: [26, 12],
        iconAnchor: [13, 6],
      }),
    });
    const tideNote = Number.isFinite(tideFt)
      ? `<br><span style="font-size:10px;color:#aaa">charted ${charted.toFixed(1)} ft MLLW · tide ${tideFt >= 0 ? '+' : ''}${tideFt.toFixed(1)} ft</span>`
      : '<br><span style="font-size:10px;color:#aaa">charted depth (MLLW) — sync tides to correct</span>';
    marker.bindTooltip(
      `<b>${Number.isFinite(adjusted) ? adjusted.toFixed(1) : charted.toFixed(1)} ft</b>${tideNote}`,
      { direction: 'top', opacity: 0.9 }
    );
    group.addLayer(marker);
  }
  return group;
}

function soundingsShouldRender() {
  return _soundingVisible && mapReady() && getMap().getZoom() >= SOUNDING_MIN_ZOOM;
}

function applySoundingVisibility() {
  if (!mapReady()) return;
  const map = getMap();
  if (soundingsShouldRender()) {
    if (_soundingLayer && !map.hasLayer(_soundingLayer)) _soundingLayer.addTo(map);
  } else if (_soundingLayer && map.hasLayer(_soundingLayer)) {
    map.removeLayer(_soundingLayer);
  }
}

function bindZoomHandler() {
  if (_zoomHandlerBound || !mapReady()) return;
  getMap().on('zoomend', applySoundingVisibility);
  _zoomHandlerBound = true;
}

async function buildSoundingLayer(zoneKey) {
  const gj = await fetchCoastalLayer(zoneKey, 'depth_soundings');
  if (!gj) return null;
  _soundingData = gj.features;
  return buildSoundingMarkers(_soundingData, _tideHeightFt);
}

/**
 * Re-label soundings against a new tide height. Called after a tide sync so
 * the numbers on screen match the water the angler will actually float in.
 */
export function refreshSoundingLabels(tideHeightFt) {
  _tideHeightFt = Number.isFinite(tideHeightFt) ? tideHeightFt : null;
  if (!_soundingData || !mapReady()) return;
  const wasOn = _soundingLayer && getMap().hasLayer(_soundingLayer);
  if (_soundingLayer) getMap().removeLayer(_soundingLayer);
  _soundingLayer = buildSoundingMarkers(_soundingData, _tideHeightFt);
  if (wasOn) applySoundingVisibility();
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Point the coastal layers at a zone. Clears everything for freshwater keys
 * so switching from an estuary back to a lake does not leave marsh lines on
 * the map.
 */
export async function loadCoastalLayersForZone(zoneKey) {
  if (zoneKey === _activeZoneKey) return;
  clearCoastalLayers();
  _activeZoneKey = isCoastalKey(zoneKey) ? zoneKey : null;
  if (!_activeZoneKey) return;
  bindZoomHandler();
  updateCoastalButtons();
}

export function clearCoastalLayers() {
  const map = mapReady() ? getMap() : null;
  for (const layer of [_oysterLayer, _marshLayer, _soundingLayer]) {
    if (layer && map) map.removeLayer(layer);
  }
  _oysterLayer = _marshLayer = _soundingLayer = null;
  _soundingData = null;
  _oysterVisible = _marshVisible = _soundingVisible = false;
  _activeZoneKey = null;
  updateCoastalButtons();
}

async function toggle(kind) {
  if (!mapReady() || !_activeZoneKey) return;
  const map = getMap();

  if (kind === 'oyster') {
    _oysterVisible = !_oysterVisible;
    if (_oysterVisible) {
      if (!_oysterLayer) _oysterLayer = await buildOysterLayer(_activeZoneKey);
      if (_oysterLayer) _oysterLayer.addTo(map);
      else notifyEmpty('btnOysterBeds', 'No oyster data for this zone');
    } else if (_oysterLayer) map.removeLayer(_oysterLayer);
  }

  if (kind === 'marsh') {
    _marshVisible = !_marshVisible;
    if (_marshVisible) {
      if (!_marshLayer) _marshLayer = await buildMarshLayer(_activeZoneKey);
      if (_marshLayer) _marshLayer.addTo(map);
      else notifyEmpty('btnMarshEdges', 'No marsh data for this zone');
    } else if (_marshLayer) map.removeLayer(_marshLayer);
  }

  if (kind === 'soundings') {
    _soundingVisible = !_soundingVisible;
    if (_soundingVisible && !_soundingLayer) {
      _soundingLayer = await buildSoundingLayer(_activeZoneKey);
      if (!_soundingLayer) notifyEmpty('btnSoundings', 'No sounding data for this zone');
    }
    applySoundingVisibility();
    if (_soundingVisible && _soundingLayer && getMap().getZoom() < SOUNDING_MIN_ZOOM) {
      notifyEmpty('btnSoundings', `Zoom to ${SOUNDING_MIN_ZOOM}+ to see depth labels`);
    }
  }

  updateCoastalButtons();
}

function notifyEmpty(btnId, msg) {
  const btn = document.getElementById(btnId);
  if (btn) btn.title = msg;
  console.log(`[coastal-layers] ${msg}`);
}

function setBtn(id, active, enabled) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.style.background = active ? 'var(--accent)' : '';
  btn.style.color      = active ? '#000' : '';
  btn.style.opacity    = enabled ? '' : '0.4';
  btn.disabled = !enabled;
}

function updateCoastalButtons() {
  const on = !!_activeZoneKey;
  setBtn('btnOysterBeds', _oysterVisible, on);
  setBtn('btnMarshEdges', _marshVisible, on);
  setBtn('btnSoundings',  _soundingVisible, on);

  // Hide the whole group for freshwater so the toolbar stays uncluttered.
  const grp = document.getElementById('coastalLayerGroup');
  if (grp) grp.style.display = on ? '' : 'none';
}

/** Soundings near a point, tide-corrected — used by coastal SmartPlan. */
export function getSoundingsNear(lat, lon, radiusDeg = 0.01) {
  if (!_soundingData) return [];
  const out = [];
  for (const feat of _soundingData) {
    const c = feat.geometry?.coordinates;
    if (!c) continue;
    if (Math.abs(c[1] - lat) > radiusDeg || Math.abs(c[0] - lon) > radiusDeg) continue;
    const charted = Number(feat.properties?.depth_ft);
    if (!Number.isFinite(charted)) continue;
    out.push({
      lat: c[1], lon: c[0],
      chartedFt: charted,
      actualFt: tideAdjustedDepth(charted, _tideHeightFt),
    });
  }
  return out;
}

export function getCoastalLayerState() {
  return {
    zoneKey: _activeZoneKey,
    tideHeightFt: _tideHeightFt,
    oysterVisible: _oysterVisible,
    marshVisible: _marshVisible,
    soundingVisible: _soundingVisible,
    soundingCount: _soundingData?.length || 0,
  };
}

// ── Wiring ──────────────────────────────────────────────────────────────────
function init() {
  const grp = document.getElementById('coastalLayerGroup');
  if (!grp) { setTimeout(init, 300); return; }

  document.getElementById('btnOysterBeds')?.addEventListener('click', () => toggle('oyster'));
  document.getElementById('btnMarshEdges')?.addEventListener('click', () => toggle('marsh'));
  document.getElementById('btnSoundings')?.addEventListener('click', () => toggle('soundings'));

  updateCoastalButtons();
  console.log('[coastal-layers] module ready');
}

init();

window.loadCoastalLayersForZone = loadCoastalLayersForZone;
window.refreshSoundingLabels    = refreshSoundingLabels;
window.getSoundingsNear         = getSoundingsNear;
window.getCoastalLayerState     = getCoastalLayerState;
