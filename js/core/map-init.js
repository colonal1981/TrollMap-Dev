/**
 * Leaflet map initialization + base-layer switching + waypoint/track
 * rendering. The single largest non-data module in the app — pulled
 * out of the monolithic <script> with the rest of initMap's helpers
 * so that other modules can `import { initMap, renderAll, fitMap }`.
 *
 * Cross-module calls (renderEditTables, renderPlanStats,
 * sendWptToGenerator, refreshChartOverlayTransforms, persistWorkingData)
 * are looked up on `window` so this module can be loaded before those
 * modules are wired up.
 *
 * Persisted state:
 *   The current working data (waypoints + tracks) is autosaved to
 *   IndexedDB `settings.working_gpx_data` whenever renderAll() runs,
 *   and restored on next page load. The FILENAME is restored too so
 *   the toolbar label shows "Restored autosave — N wpts, M tracks"
 *   until the user loads another file.
 */

import { state } from './state.js';
import { esc } from '../utils/escape.js';

// Tile-layer presets. Esri World Imagery for satellite, OSM for street.
// Both with attribution per the providers' terms.
const TILES = {
  sat: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attr: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
  street: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attr: '&copy; OpenStreetMap contributors',
  },
  satLabels: {
    // Transparent reference labels overlaid on satellite tiles.
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    attr: '',
  },
};

// Mutable map-init-local state. Not shared across modules.
let PREVIEW_LAYER = null;
let PREVIEW_TRACKS = [];
let pickTarget = null;          // { field: 'start'|'end' } during coordinate picking
let RESTORING_WORKING_DATA = false;
let FILENAME = 'Untitled';

/**
 * Initialize the Leaflet map, base layers, click handlers, and live UI
 * indicators (zoom pill, storage estimate).
 *
 * Safe to call only once per page load; calling twice will leak listeners.
 */
export function initMap() {
  if (typeof L === 'undefined') {
    const cr = document.getElementById('coordReadout2');
    if (cr) cr.textContent = '⚠ Leaflet offline.';
    return;
  }

  state.MAP = L.map('map', { center: [33.92, -80.34], zoom: 8, zoomControl: false });
  window.MAP = state.MAP;  // exposed for legacy cross-script integrations
  L.control.zoom({ position: 'bottomright' }).addTo(state.MAP);
  setBase('sat');

  state.LAYER = L.layerGroup().addTo(state.MAP);
  PREVIEW_LAYER = L.layerGroup().addTo(state.MAP);
  state.MAP_OK = true;

  state.MAP.on('click', onMapClick);
  state.MAP.on('mousemove', (e) => {
    const el = document.getElementById('coordReadout2');
    if (el) el.textContent = `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`;
  });

  // Leaflet rewrites raster image CSS transforms during zoom/pan; re-apply
  // chart overlay rotation so committed overlays don't visually drift.
  state.MAP.on('zoom zoomend moveend viewreset resize', () => {
    try { window.refreshChartOverlayTransforms?.(); } catch (_) {}
  });

  wireZoomIndicator();
  wireStorageIndicator();
}

/** Update the "z 12.4" pill in the toolbar. */
function wireZoomIndicator() {
  const zoomIndicator = document.getElementById('zoomIndicator');
  if (!zoomIndicator) return;

  const update = () => {
    if (!state.MAP) return;
    const z = state.MAP.getZoom();
    zoomIndicator.textContent = `z ${z.toFixed(1)}`;
    zoomIndicator.title = `Map zoom ${z.toFixed(2)} — i-Boating contour capture will use this zoom`;
  };
  state.MAP.on('zoom zoomend', update);
  update();
}

/** Update the "storage 47 MB free" pill in the toolbar. */
function wireStorageIndicator() {
  const storageIndicator = document.getElementById('storageIndicator');
  if (!storageIndicator) return;

  const fmtMB = (b) => b >= 1048576 ? `${(b / 1048576).toFixed(0)} MB` : `${(b / 1024).toFixed(0)} KB`;

  async function refresh() {
    if (!navigator.storage?.estimate) return;
    try {
      const est = await navigator.storage.estimate();
      const quota = est.quota || 0;
      const usage = est.usage || 0;
      const avail = Math.max(0, quota - usage);
      const persistent = await navigator.storage.persisted?.().catch(() => false);
      storageIndicator.textContent = `storage ${fmtMB(avail)} free`;
      storageIndicator.style.color = avail < 50 * 1048576 ? 'var(--warn)' : 'var(--accent2)';
      storageIndicator.title =
        `Total quota: ${fmtMB(quota)} · Used: ${fmtMB(usage)} · Free: ${fmtMB(avail)}` +
        (persistent ? ' · Persistent: yes' : ' · Persistent: NO (click to request)');
    } catch (_) {
      storageIndicator.textContent = 'storage n/a';
      storageIndicator.style.color = 'var(--muted)';
    }
  }

  storageIndicator.addEventListener('click', async () => {
    const est = await navigator.storage.estimate().catch(() => ({}));
    const quota = est.quota || 0;
    const usage = est.usage || 0;
    const avail = Math.max(0, quota - usage);
    const persistent = await navigator.storage.persisted?.().catch(() => false);
    const lines = [
      `Quota:   ${fmtMB(quota)}`,
      `Used:    ${fmtMB(usage)}`,
      `Free:    ${fmtMB(avail)}`,
      `Persistent: ${persistent ? 'yes' : 'no'}`,
    ];
    if (!persistent && navigator.storage.persist) {
      const ok = await navigator.storage.persist();
      lines.push(`Request persistent storage: ${ok ? 'GRANTED' : 'declined / already requested'}`);
      refresh();
    }
    alert(lines.join('\n'));
  });

  refresh();
  setInterval(refresh, 15000);
}

/**
 * Switch the base tile layer. `kind` is 'sat' or 'street'.
 * When 'sat' is selected, a transparent labels overlay is added on top.
 */
export function setBase(kind) {
  if (!state.MAP) return;
  if (state.BASE) state.MAP.removeLayer(state.BASE);
  if (state.BASE_LABELS) state.MAP.removeLayer(state.BASE_LABELS);

  const t = TILES[kind] || TILES.sat;
  state.BASE = L.tileLayer(t.url, {
    attribution: t.attr,
    maxZoom: 22,
  }).addTo(state.MAP);
  state.BASE.setZIndex(0);

  if (kind === 'sat') {
    state.BASE_LABELS = L.tileLayer(TILES.satLabels.url, {
      attribution: TILES.satLabels.attr,
      maxZoom: 22,
      pane: 'overlayPane',
    }).addTo(state.MAP);
    state.BASE_LABELS.setZIndex(1);
  }
}

/** Read the current edit-mode dropdown value. */
export function editMode() {
  return document.getElementById('editMode')?.value;
}

/**
 * Handle a click anywhere on the map. Three behaviors, in order:
 *   1. If a coordinate-pick is in progress, fill the targeted input and stop.
 *   2. If a chart georef is in progress, hand off to handleGeorefClick.
 *   3. Otherwise, in "add" mode, prompt for a name and add a waypoint.
 */
export function onMapClick(e) {
  if (pickTarget) {
    fillCoord(pickTarget.field, e.latlng.lat, e.latlng.lng);
    pickTarget = null;
    document.body.style.cursor = '';
    setBanner('');
    return;
  }
  if (window.georefState) {
    try { window.handleGeorefClick?.(e); } catch (_) {}
    return;
  }
  const mode = editMode();
  if (mode === 'add') {
    const name = prompt('Waypoint name:', suggestName());
    if (name === null) return;
    state.DATA.waypoints.push({ lat: e.latlng.lat, lon: e.latlng.lng, name: name || 'WPT', sym: 'Waypoint' });
    renderAll();
  }
}

/** Fill the troll-generator start/end coordinate inputs. */
export function fillCoord(field, lat, lon) {
  if (field === 'start') {
    document.getElementById('gLat1').value = lat.toFixed(5);
    document.getElementById('gLon1').value = lon.toFixed(5);
  } else if (field === 'end') {
    document.getElementById('gLat2').value = lat.toFixed(5);
    document.getElementById('gLon2').value = lon.toFixed(5);
  }
  setBanner('');
}

/** Show or hide the georef banner (the orange strip across the map). */
export function setBanner(s) {
  const b = document.getElementById('georefBanner');
  if (!b) return;
  if (s) { b.style.display = 'block'; b.textContent = s; }
  else { b.style.display = 'none'; }
}

/** Auto-name like "WPT1", "WPT2", … based on the current count. */
export function suggestName() {
  return `WPT${state.DATA.waypoints.length + 1}`;
}

/**
 * Begin coordinate-picking mode. The next map click will fill the
 * given field ('start' or 'end' for the troll generator).
 */
export function startPick(field) {
  pickTarget = { field };
  document.body.style.cursor = 'crosshair';
  setBanner('🎯 Click on the map to set ' + (field === 'start' ? 'START' : 'END') + ' waypoint');
}

/**
 * Render every track and waypoint onto the map. Tracks get a black
 * halo + magenta core. Waypoints get a white halo + colored dot,
 * draggable in "view" mode and click-to-delete in "delete" mode.
 */
export function renderMap() {
  if (!state.MAP_OK) return;
  state.LAYER.clearLayers();
  const bounds = [];

  // Phase-aware track colors for Smart Plan routes
  const PHASE_COLORS = {
    1: '#00e5ff',  // Phase 1 Dawn — cyan
    2: '#ffb300',  // Phase 2 Transition — amber
    3: '#ff4081',  // Phase 3 Deep — pink/magenta
  };
  function getTrackColor(trackName) {
    if (!trackName) return '#ff00e6';
    const n = String(trackName);
    if (/Phase\s*1|Dawn/i.test(n))       return PHASE_COLORS[1];
    if (/Phase\s*2|Transition/i.test(n)) return PHASE_COLORS[2];
    if (/Phase\s*3|Deep/i.test(n))       return PHASE_COLORS[3];
    return '#ff00e6'; // default magenta for non-smart-plan tracks
  }

  for (const t of state.DATA.tracks) {
    if (t.pts.length > 1) {
      const isConnector = t.connector || /^Connector:|^Retrace Return:/i.test(t.name || '');
      const color = getTrackColor(t.name);
      if (isConnector) {
        // Connectors: thin dashed line, dimmed
        L.polyline(t.pts, { color, weight: 1.5, opacity: 0.4, dashArray: '6,8' }).addTo(state.LAYER);
      } else {
        // Fishing tracks: full weight with black halo
        L.polyline(t.pts, { color: '#000', weight: 6, opacity: 0.55 }).addTo(state.LAYER);
        L.polyline(t.pts, { color, weight: 2.5, opacity: 1 }).addTo(state.LAYER);
      }
      // Phase label at midpoint — only on fishing tracks, not connectors
      if (!isConnector && /Phase/i.test(t.name || '')) {
        const mid = t.pts[Math.floor(t.pts.length / 2)];
        if (mid) {
          const label = (t.name || '').match(/Phase\s*(\d+)/i)?.[0] || '';
          L.marker(mid, {
            icon: L.divIcon({
              className: '',
              html: `<div style="background:${color};color:#000;font-size:10px;font-weight:700;padding:2px 5px;border-radius:3px;white-space:nowrap;opacity:0.9">${label}</div>`,
              iconAnchor: [20, 10],
            })
          }).addTo(state.LAYER);
        }
      }
      t.pts.forEach((p) => bounds.push(p));
    }
  }

  const draggable = (editMode() === 'view');
  state.DATA.waypoints.forEach((w, i) => {
    const isStart = /T1$/i.test(w.name) || /P1$/i.test(w.name);
    const fill = isStart ? '#ff1744' : '#ffffff';
    const circ = L.circleMarker([w.lat, w.lon], {
      radius: isStart ? 7 : 5,
      color: '#000', weight: 2.5,
      fillColor: fill, fillOpacity: 1,
    });
    const halo = L.circleMarker([w.lat, w.lon], {
      radius: isStart ? 9 : 7,
      color: '#fff', weight: 2, fill: false, opacity: 0.9,
    });

    halo.addTo(state.LAYER);
    circ.bindTooltip(w.name || '(unnamed)', { direction: 'top', offset: [0, -4] });
    circ.bindPopup(`
      <div style="font-family:system-ui,sans-serif;font-size:13px;min-width:180px">
        <b style="font-size:15px;color:#0d4f8b">${esc(w.name || '(unnamed)')}</b><br>
        <span style="font-family:monospace;font-size:11px;color:#555">${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}</span><br>
        <span style="font-size:12px;color:#0e7c7b">${esc(w.sym || 'Waypoint')}</span>
        <div style="margin-top:10px;border-top:1px solid #ddd;padding-top:8px;display:flex;flex-direction:column;gap:6px">
          <b style="font-size:11px;color:#888;text-transform:uppercase">Trolling Lane Generator</b>
          <button onclick="window.sendWptToGenerator(${w.lat},${w.lon},'start')" style="background:#0e7c7b;color:#fff;border:none;border-radius:6px;padding:6px;font-size:12px;font-weight:700;cursor:pointer">🎯 Set as Start Spot</button>
          <button onclick="window.sendWptToGenerator(${w.lat},${w.lon},'end')" style="background:#0d4f8b;color:#fff;border:none;border-radius:6px;padding:6px;font-size:12px;font-weight:700;cursor:pointer">🎯 Set as End Spot</button>
        </div>
      </div>`);
    circ.addTo(state.LAYER);

    if (editMode() === 'delete') {
      circ.on('click', () => {
        if (confirm(`Delete "${w.name}"?`)) {
          state.DATA.waypoints.splice(i, 1);
          renderAll();
        }
      });
    }

    if (draggable) {
      const m = L.marker([w.lat, w.lon], { draggable: true, opacity: 0 }).addTo(state.LAYER);
      m.on('drag', (ev) => {
        circ.setLatLng(ev.latlng);
        halo.setLatLng(ev.latlng);
      });
      m.on('dragend', (ev) => {
        const ll = ev.target.getLatLng();
        state.DATA.waypoints[i].lat = ll.lat;
        state.DATA.waypoints[i].lon = ll.lng;
        try { window.renderEditTables?.(); } catch (_) {}
        try { window.renderPlanStats?.(); } catch (_) {}
      });
    }
    bounds.push([w.lat, w.lon]);
  });

  if (bounds.length) state.MAP._lastBounds = bounds;
}

/** Render map + edit table + plan stats, then autosave. */
export function renderAll() {
  renderMap();
  try { window.renderEditTables?.(); } catch (_) {}
  try { window.renderPlanStats?.(); } catch (_) {}
  persistWorkingData();
}

/** Fit the map to the most recently rendered bounds. */
export function fitMap() {
  if (state.MAP_OK && state.MAP?._lastBounds?.length) {
    state.MAP.fitBounds(state.MAP._lastBounds, { padding: [30, 30] });
  }
}

/** Clear all preview polylines (troll-lane preview before commit). */
export function clearPreview() {
  if (PREVIEW_LAYER) PREVIEW_LAYER.clearLayers();
  PREVIEW_TRACKS = [];
}

/** Display dashed preview tracks on the map without committing them. */
export function showPreview(tracks) {
  clearPreview();
  PREVIEW_TRACKS = tracks;
  if (!state.MAP_OK) return;
  for (const t of tracks) {
    if (t.pts.length > 1) {
      L.polyline(t.pts, { color: '#ff00e6', weight: 2.5, dashArray: '6,6', opacity: 0.9 })
        .addTo(PREVIEW_LAYER);
    }
  }
  const pts = tracks.flatMap((t) => t.pts);
  if (pts.length) state.MAP.fitBounds(pts, { padding: [40, 40] });
}

// ── Working-data autosave / restore ─────────────────────────────────────

/**
 * Save the current waypoints + tracks + filename to IndexedDB so they
 * survive a page refresh. Skips during restore to avoid clobbering.
 */
export async function persistWorkingData() {
  if (RESTORING_WORKING_DATA) return;
  const db = window.DB;  // legacy alias expected by some older modules
  if (!db?.db) return;
  try {
    await db.put('settings', {
      key: 'working_gpx_data',
      filename: FILENAME,
      data: JSON.parse(JSON.stringify(state.DATA)),
      savedAt: new Date().toISOString(),
    });
    const fl = document.getElementById('fileLabel');
    if (fl) fl.title = 'Autosaved ' + new Date().toLocaleTimeString();
  } catch (e) {
    console.warn('Working GPX autosave failed', e);
  }
}

/**
 * Restore the autosaved working data on page load. Only fires if
 * the in-memory data is empty (so a freshly loaded GPX file isn't
 * overwritten by an older autosave).
 */
export async function restoreWorkingData() {
  const db = window.DB;
  if (!db?.db) return;
  try {
    const rec = await db.get('settings', 'working_gpx_data');
    if (!rec || !rec.data) return;
    if ((state.DATA.waypoints?.length) || (state.DATA.tracks?.length)) return;

    RESTORING_WORKING_DATA = true;
    state.DATA = rec.data;   // replace the empty working data
    FILENAME = rec.filename || 'autosaved_working_data.gpx';
    const fl = document.getElementById('fileLabel');
    if (fl) {
      fl.textContent = `Restored autosave — ${state.DATA.waypoints.length} wpts, ${state.DATA.tracks.length} tracks`;
    }
    renderMap();
    try { window.renderEditTables?.(); } catch (_) {}
    try { window.renderPlanStats?.(); } catch (_) {}
    RESTORING_WORKING_DATA = false;
  } catch (e) {
    console.warn('Working GPX restore failed', e);
    RESTORING_WORKING_DATA = false;
  }
}

/** Currently-loaded file name (set by the file loader). */
export function setFilename(name) { FILENAME = name || 'Untitled'; }
export function getFilename() { return FILENAME; }
