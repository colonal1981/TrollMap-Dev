/**
 * Contour / GIS layer import — load a KML, GPX, or GeoJSON file
 * full of points/lines and render it as a styled layer on the map.
 *
 * Features:
 *   - Auto-detects format from filename extension
 *   - Optional simplification (Douglas-Peucker via simplifyLine)
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
import { depthColor, simplifyLine, guessDepthProp } from '../utils/geo.js';
import { parseKML, kmlToGeoJSON, parseGPX, geoJSONToLines } from '../utils/parsers.js';
import { addChartLayer, persistCharts } from './chart-mosaic.js';
import { setBanner } from '../core/map-init.js';

const CONTOUR_LAYERS = {};

// ── File handling ─────────────────────────────────────────────────────────

async function handleLayerFile(file) {
  const nameEl = document.getElementById('layerName');
  const name = nameEl?.value || file.name.replace(/\.[^.]+$/, '');
  const tol = parseFloat(document.getElementById('simplifyTol')?.value) || 0;
  const text = await file.text();
  let geo = null, depthProp = null;

  try {
    if (file.name.match(/\.kml$/i)) {
      const features = parseKML(text);
      geo = kmlToGeoJSON(features);
    } else if (file.name.match(/\.gpx$/i)) {
      const p = parseGPX(text);
      geo = {
        type: 'FeatureCollection',
        features: p.tracks.map((t) => ({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: t.pts.map((pt) => [pt[1], pt[0]]) },
          properties: { name: t.name },
        })),
      };
    } else {
      geo = JSON.parse(text);
    }

    if (geo.type !== 'FeatureCollection') geo = { type: 'FeatureCollection', features: [] };
    const lines = geoJSONToLines(geo);

    if (tol > 0) {
      lines.forEach((l) => { l.coords = simplifyLine(l.coords, tol); });
    }

    geo = {
      type: 'FeatureCollection',
      features: lines.map((l) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: l.coords.map((c) => [c[1], c[0]]) },
        properties: l.props,
      })),
    };

    if (geo.features.length && geo.features[0].properties) {
      depthProp = guessDepthProp(geo.features[0].properties);
    }

    if (window.DB?.db) {
      try {
        await window.DB.put('layers', { name, geo, depthProp });
      } catch (_) {}
    }

    addContourLayer(name, geo, depthProp);
    renderLayerList();
    alert(`Imported "${name}" — ${geo.features.length} features saved offline.`);
  } catch (err) {
    alert('Import error: ' + err.message);
    console.error(err);
  }
}

// ── Add / remove a contour layer ─────────────────────────────────────────

function addContourLayer(name, geo, depthProp) {
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
        if (window.DB?.db) {
          try {
            await window.DB.put('settings', {
              key: `custom_gis_${spotName}`,
              lat: newLL.lat,
              lon: newLL.lng,
              correctedAt: new Date().toISOString(),
            });
          } catch (_) {}
        }
        alert(`Saved custom corrected GPS coordinates for "${spotName}".\nNew verified position: [${newLL.lat.toFixed(5)}, ${newLL.lng.toFixed(5)}].\nThis spot will remain locked on this coordinate for all future trips.`);
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
  if (window.DB?.db) {
    try { all = await window.DB.getAll('layers'); console.log('[IDB] layers found:', all.length); }
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
  if (window.DB?.db) {
    try {
      const all = await window.DB.getAll('layers');
      for (const rec of all) await window.DB.del('layers', rec.name);
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
  if (window.DB?.db) {
    window.DB.del('layers', name).catch((e) => console.warn('[IDB] layer delete failed:', e));
  }
  renderLayerList();
};

window.clearAllLayers = clearAllLayers;

// ── Wire drop zone / file input ──────────────────────────────────────────

// ── Batch sidecar import ────────────────────────────────────────────────────
// Accepts any number of PNG + .georef.json pairs. Each pair is placed as a
// named chart layer using the bounds from the sidecar — no manual alignment.
// Triggered by:
//   - File picker via the button  → not currently in DOM
//   - Cloud Chartpacks module    → sets input.files programmatically + dispatches change
document.getElementById('batchImportInput')?.addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  // Group files by stem (filename without .png or .georef.json extension)
  const pngs = {}, jsons = {};
  files.forEach((f) => {
    const base = f.name.replace(/\.georef\.json$/i, '').replace(/\.png$/i, '');
    if (/\.georef\.json$/i.test(f.name)) jsons[base] = f;
    else if (/\.png$/i.test(f.name)) pngs[base] = f;
  });

  const matched = Object.keys(jsons).filter((k) => pngs[k]);
  if (!matched.length) {
    alert('No matching PNG + .georef.json pairs found.\nSelect both the PNG files and their .georef.json sidecars together.');
    return;
  }

  let loaded = 0;
  const total = matched.length;
  setBanner(`Loading ${total} chart tiles...`);

  matched.forEach((base) => {
    const jr = new FileReader();
    jr.onload = (jev) => {
      let georef;
      try { georef = JSON.parse(jev.target.result); }
      catch (err) {
        console.error('Bad georef JSON for', base, err);
        loaded++;
        return;
      }

      // Support both {north,south,east,west} at root or nested under {bounds:{...}}
      const b = georef.bounds || georef;
      if (b.north == null || b.south == null || b.east == null || b.west == null) {
        console.warn('Missing bounds in', base, georef);
        loaded++;
        return;
      }

      const pr = new FileReader();
      pr.onload = async (pev) => {
        const bounds = { north: b.north, south: b.south, east: b.east, west: b.west };
        addChartLayer(base, pev.target.result, bounds, 0.75, 0);
        loaded++;
        if (loaded === total) {
          setBanner(`✅ Imported ${total} chart tiles`);
          setTimeout(() => setBanner(''), 3000);
          // Persist to IndexedDB so contours survive a page refresh.
          try { await persistCharts(); } catch (_) {}
          // Fit map to imported tiles
          const lats = [], lons = [];
          state.CHARTS.slice(-total).forEach((c) => {
            lats.push(c.bounds.north, c.bounds.south);
            lons.push(c.bounds.west, c.bounds.east);
          });
          if (lats.length && state.MAP) {
            state.MAP.fitBounds([
              [Math.min(...lats), Math.min(...lons)],
              [Math.max(...lats), Math.max(...lons)],
            ]);
          }
          const wrap = document.getElementById('chartLayersWrap');
          if (wrap) wrap.style.display = 'block';
        } else {
          setBanner(`Loading tiles... ${loaded}/${total}`);
        }
      };
      pr.readAsDataURL(pngs[base]);
    };
    jr.readAsText(jsons[base]);
  });

  e.target.value = ''; // reset so same files can be re-imported if needed
});
// ────────────────────────────────────────────────────────────────────────────

function wireImportUI() {
  const dropZone = document.getElementById('dropZone');
  const layerFile = document.getElementById('layerFile');
  if (!dropZone || !layerFile) return;

  dropZone.addEventListener('click', () => layerFile.click());
  ['dragenter', 'dragover'].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropZone.classList.add('ok');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropZone.classList.remove('ok');
    });
  });
  dropZone.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f) handleLayerFile(f);
  });
  layerFile.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) handleLayerFile(f);
  });
}

wireImportUI();