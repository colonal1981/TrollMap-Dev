/**
 * Contour / GIS layers — the ones saved offline by the import that used to live here, restored
 * and rendered as styled layers on the map. (The import itself, and the batch chart-tile
 * import, went on 2026-09-25: nothing in index.html could reach either.)
 *
 * Features:
 *   - Color-coded by depth when features carry a depth-like property
 *   - Drag-to-reposition: clicking the popup button enables drag,
 *     and dragging commits the new position to IndexedDB so the
 *     correction persists across page reloads
 *   - Layer list with show/hide/delete buttons
 *
 * State: CONTOUR_LAYERS (name → { geo, layer, labelGroup, visible, ... })
 * lives at module scope. Imports are listed in the Edit tab so the
 * user can manage them.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { depthColor } from '../utils/depth-palette.js';
import { setBanner } from '../core/map-init.js';
import { getAll as dbGetAll, del as dbDel, isReady as dbIsReady, tryPut } from '../utils/db.js';

const CONTOUR_LAYERS = {};

// ── File handling ─────────────────────────────────────────────────────────
// handleLayerFile() read a KML, GPX or GeoJSON dropped on #dropZone or picked in #layerFile,
// simplified it and saved it offline. Neither control is in index.html, so it went on
// 2026-09-25, with the drop-zone wiring and the PNG + .georef.json batch import (its
// #batchImportInput is a hidden input nothing opens). Layers saved before still load:
// loadAllLayers() is untouched.

// ── Add / remove a contour layer ─────────────────────────────────────────

export function addContourLayer(name, geo, depthProp) {
  if (!state.MAP_OK) return;
  removeContourLayer(name);

  const layer = L.geoJSON(geo, {
    pointToLayer: (f, latlng) => {
      const props = f.properties || {};
      const isRamp = props.FACILITY || (props.Name || '').includes('Ramp') || (props.Name || '').includes('Landing') || name.includes('Ramp');
      const ico = isRamp ? '⛵' : '📍';
      const bgCol = isRamp ? '#00e5ff' : '#ff5252';
      const textCol = isRamp ? '#062d00' : '#fff';
      const bdrCol = isRamp ? '#007a8a' : '#fff';

      const spotName = props.Name || props.FacilityName || props.FACILITY || 'GIS Spot';
      const spotKey = (f.id != null) ? f.id : Math.round(latlng.lat * 10000);

      const m = L.marker(latlng, {
        icon: L.divIcon({
          className: 'custom-gis-marker',
          html: `
            <div style="
              background:${bgCol};color:${textCol};font-size:11.5px;font-weight:700;
              font-family:system-ui,sans-serif;padding:3px 8px;border-radius:6px;
              border:2px solid ${bdrCol};white-space:nowrap;
              box-shadow:0 2px 8px rgba(0,0,0,.6);cursor:pointer;display:inline-block;
            ">${ico} ${esc(spotName).split(' (')[0]}</div>`,
          iconAnchor: [12, 12],
        }),
        draggable: false,  // becomes draggable when user clicks "Re-Position"
      });

      const safeSpotName = esc(spotName).replace(/'/g, "\\'");
      m.bindPopup(`
        <div style="font-family:system-ui,sans-serif;font-size:13px;color:#111;min-width:200px">
          <b style="font-size:15px;color:#0d4f8b">${esc(spotName)}</b><br>
          <span style="font-family:monospace;font-size:11px;color:#555"
                id="popupCoords_${spotKey}">${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}</span><br>
          ${props.DEPTH_FT ? `<b>Habitat Depth:</b> ${props.DEPTH_FT} ft<br>` : ''}
          ${props.NOTES ? `<span style="font-size:12px;color:#666">${esc(props.NOTES)}</span><br>` : ''}

          <div style="margin-top:12px;border-top:1px solid #ddd;padding-top:8px;display:flex;flex-direction:column;gap:6px">
            <button onclick="window.enableSpotRepositioning(this, '${safeSpotName}')"
                    class="small primary"
                    style="background:var(--warn);color:#000;font-weight:700;padding:6px;border-radius:6px;border:none">
              ✥ Re-Position This Spot
            </button>
            ${!isRamp ? `
            <button onclick="window.sendWptToGenerator(${latlng.lat}, ${latlng.lng}, 'start')"
                    style="background:#0e7c7b;color:#fff;border:none;border-radius:6px;padding:5px;font-size:11.5px;font-weight:700;cursor:pointer">🎯 Set as Troll Start</button>
            <button onclick="window.sendWptToGenerator(${latlng.lat}, ${latlng.lng}, 'end')"
                    style="background:#0d4f8b;color:#fff;border:none;border-radius:6px;padding:5px;font-size:11.5px;font-weight:700;cursor:pointer">🎯 Set as Troll End</button>
            ` : ''}
          </div>
        </div>
      `);

      // Track which marker's popup is currently open (for the spot repositioning helper)
      m.on('popupopen',  () => { m._isActivelyOpen = true;  });
      m.on('popupclose', () => { m._isActivelyOpen = false; });

      // Drag end → save corrected coords to IndexedDB
      m.on('dragend', async (ev) => {
        const newLL = ev.target.getLatLng();
        m.setLatLng(newLL);
        const readout = document.getElementById(`popupCoords_${spotKey}`);
        if (readout) readout.textContent = `${newLL.lat.toFixed(5)}, ${newLL.lng.toFixed(5)}`;
        // The alert below promises this position is locked in for all future trips. That
        // promise was printed whether or not the write happened -- the catch swallowed the
        // failure and the dialog fired anyway. A GPS correction you made on the water, told
        // you was permanent, and silently lost is the worst outcome this file can produce.
        //
        // The old `if (dbIsReady())` guard is gone with it: db.js writes now await the open
        // instead of no-opping, so a correction dragged in the first second after load lands
        // rather than being skipped. That guard was the thing making early writes vanish.
        const saved = await tryPut('settings', {
          key: `custom_gis_${spotName}`,
          lat: newLL.lat,
          lon: newLL.lng,
          correctedAt: new Date().toISOString(),
        }, `corrected GPS for "${spotName}"`);
        alert(saved
          ? `Saved custom corrected GPS coordinates for "${spotName}".\nNew verified position: [${newLL.lat.toFixed(5)}, ${newLL.lng.toFixed(5)}].\nThis spot will remain locked on this coordinate for all future trips.`
          : `COULD NOT SAVE the corrected position for "${spotName}".\nThe marker has moved on screen, but the correction is NOT stored and will be gone on reload.\nSee the console for why.`);
        m.dragging.disable();
      });

      return m;
    },
    style: (f) => {
      const d = depthProp != null ? f.properties?.[depthProp] : null;
      return { color: depthColor(d), weight: 1.5, opacity: 0.8 };
    },
  }).addTo(state.MAP);
  layer.setZIndex(2);

  // Add depth labels on contour lines (every 5ft interval)
  const labelGroup = L.layerGroup().addTo(state.MAP);
  const labelInterval = 5;
  const minCoords = 8;

  geo.features.forEach((f) => {
    const d = depthProp != null ? f.properties?.[depthProp] : null;
    if (d == null) return;
    const depth = Math.round(d);
    if (depth % labelInterval !== 0) return;

    const coords = f.geometry?.coordinates;
    if (!coords || coords.length < minCoords) return;

    const mid = coords[Math.floor(coords.length / 2)];
    if (!mid) return;

    const label = L.marker([mid[1], mid[0]], {
      icon: L.divIcon({
        className: '',
        html: `<div style="
          background:rgba(10,20,35,0.85);
          color:${depthColor(depth)};
          font-size:13px;
          font-weight:700;
          font-family:monospace;
          padding:2px 6px;
          border-radius:4px;
          border:1px solid ${depthColor(depth)};
          white-space:nowrap;
          pointer-events:none;
          line-height:1.4;
          display:inline-block;
        ">${depth}ft</div>`,
        iconAnchor: [18, 10],
      }),
      interactive: false,
    });
    labelGroup.addLayer(label);
  });

  CONTOUR_LAYERS[name] = { geo, layer, labelGroup, visible: true, opacity: 0.8, depthProp };
}

function removeContourLayer(name) {
  const Lyr = CONTOUR_LAYERS[name];
  if (!Lyr) return;
  if (Lyr.layer) state.MAP.removeLayer(Lyr.layer);
  if (Lyr.labelGroup) state.MAP.removeLayer(Lyr.labelGroup);
  delete CONTOUR_LAYERS[name];
}

// ── Layer management UI ──────────────────────────────────────────────────

async function renderLayerList() {
  const host = document.getElementById('layerList');
  if (!host) return;
  const names = Object.keys(CONTOUR_LAYERS);
  if (!names.length) { host.innerHTML = '<p class="muted">No offline layers yet.</p>'; return; }
  let html = '';
  for (const n of names) {
    const Lyr = CONTOUR_LAYERS[n];
    const count = Lyr.geo.features.length;
    const safe = esc(n).replace(/'/g, "\\'");
    html += `<div class="row" style="justify-content:space-between">
      <div style="flex:1"><b>${esc(n)}</b> <span class="muted">(${count} features)</span></div>
      <button onclick="window.toggleLayer('${safe}')">${Lyr.visible ? 'Hide' : 'Show'}</button>
      <button onclick="window.deleteLayer('${safe}')">Delete</button>
    </div>`;
  }
  host.innerHTML = html;
}

export async function loadAllLayers() {
  let all = [];
  if (dbIsReady()) {
    try { all = await dbGetAll('layers'); console.log('[IDB] layers found:', all.length); }
    catch (e) { console.warn('[IDB] layers error:', e); }
  }
  for (const rec of all) addContourLayer(rec.name, rec.geo, rec.depthProp);
  renderLayerList();
}

async function clearAllLayers() {
  const names = Object.keys(CONTOUR_LAYERS);
  if (!names.length) return;
  if (!confirm(`Delete ALL ${names.length} contour/GIS layers?\nThis cannot be undone.`)) return;
  for (const n of [...names]) removeContourLayer(n);
  if (dbIsReady()) {
    try {
      const all = await dbGetAll('layers');
      for (const rec of all) await dbDel('layers', rec.name);
    } catch (e) { console.warn('[IDB] clear layers failed:', e); }
  }
  renderLayerList();
  setBanner('Cleared all contour/GIS layers');
  setTimeout(() => setBanner(''), 1800);
}

window.toggleLayer = function toggleLayer(name) {
  const Lyr = CONTOUR_LAYERS[name];
  if (!Lyr) return;
  if (Lyr.visible) {
    state.MAP.removeLayer(Lyr.layer);
    if (Lyr.labelGroup) state.MAP.removeLayer(Lyr.labelGroup);
    Lyr.visible = false;
  } else {
    Lyr.layer.addTo(state.MAP);
    if (Lyr.labelGroup) Lyr.labelGroup.addTo(state.MAP);
    Lyr.visible = true;
  }
  renderLayerList();
};

window.deleteLayer = function deleteLayer(name) {
  if (!confirm(`Delete layer "${name}"?`)) return;
  removeContourLayer(name);
  if (dbIsReady()) {
    dbDel('layers', name).catch((e) => console.warn('[IDB] layer delete failed:', e));
  }
  renderLayerList();
};

window.clearAllLayers = clearAllLayers;
