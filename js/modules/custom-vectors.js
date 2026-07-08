/**
 * custom-vectors.js — Structure Intel Layer
 *
 * Two modes:
 *   1. Load GeoJSON — import any GeoJSON file as a named layer
 *   2. QuickDraw mapping — click to drop structure pins with zero friction
 *
 * QuickDraw controls:
 *   Enter mapping mode → click the 🗂 Structure button → "Start Mapping"
 *   Click map          → drops active type instantly, no dialog
 *   D = Dock (default) B = Brush Pile  R = Riprap   T = Timber
 *   F = Fish Attractor H = Hazard      P = Point     C = Cove Entrance
 *   Z / Ctrl+Z         → Undo last pin
 *   Escape             → Exit mapping mode
 *   S                  → Save (also auto-saves after every click)
 *
 * All pins persist in IndexedDB. Smart Plan reads window.getMyStructures().
 * Export to GeoJSON via the panel for backup or sharing.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';

// ── Structure type registry ───────────────────────────────────────────────────

const STRUCTURE_TYPES = {
  dock:          { label: 'Dock',          emoji: '🪵', color: '#03A9F4', hotkey: 'D' },
  brush_pile:    { label: 'Brush Pile',    emoji: '🎣', color: '#E91E63', hotkey: 'B' },
  riprap:        { label: 'Riprap',        emoji: '🪨', color: '#607D8B', hotkey: 'R' },
  timber:        { label: 'Timber',        emoji: '🌲', color: '#795548', hotkey: 'T' },
  fish_attractor:{ label: 'Fish Attractor',emoji: '🎯', color: '#00E5FF', hotkey: 'F' },
  hazard:        { label: 'Hazard',        emoji: '⚠️', color: '#FF5252', hotkey: 'H' },
  point:         { label: 'Point',         emoji: '📍', color: '#FF9800', hotkey: 'P' },
  cove_mouth:    { label: 'Cove Entrance', emoji: '🌊', color: '#9C27B0', hotkey: 'C' },
};

const DEFAULT_TYPE = 'dock';
const MY_STRUCTURES_KEY = 'My Structures';

// ── Layer registry ────────────────────────────────────────────────────────────

const VECTOR_LAYERS = {};
window.CUSTOM_VECTOR_LAYERS = VECTOR_LAYERS;

// ── State ─────────────────────────────────────────────────────────────────────

let activeType   = DEFAULT_TYPE;
let mappingMode  = false;
let panelOpen    = false;
let undoStack    = [];   // array of feature indices for undo
let pinCount     = 0;    // running total for HUD
let structuresVisible = true; // track show/hide state

// ── Persistent GeoJSON store ──────────────────────────────────────────────────
// The live GeoJSON is stored here in memory; layer is rebuilt on changes.
// IndexedDB is written after every pin and on explicit save.

let myStructuresGeo = { type: 'FeatureCollection', features: [] };

async function loadMyStructures() {
  if (!window.DB?.db) return;
  try {
    const stored = await window.DB.get('layers', MY_STRUCTURES_KEY);
    if (stored?.geo?.features?.length) {
      myStructuresGeo = stored.geo;
      rebuildMyStructuresLayer();
      pinCount = myStructuresGeo.features.length;
      updateHUD();
    }
  } catch (_) {}
}

async function saveMyStructures() {
  if (!window.DB?.db) return;
  try {
    await window.DB.put('layers', {
      name: MY_STRUCTURES_KEY,
      geo: myStructuresGeo,
      importedAt: new Date().toISOString(),
    });
  } catch (_) {}
}

// ── Layer rendering ───────────────────────────────────────────────────────────

function rebuildMyStructuresLayer() {
  const map = state?.MAP;
  if (!map) return;

  if (VECTOR_LAYERS[MY_STRUCTURES_KEY]) {
    map.removeLayer(VECTOR_LAYERS[MY_STRUCTURES_KEY]);
  }

  const layer = L.geoJSON(myStructuresGeo, {
    pointToLayer: (f, latlng) => {
      const t = STRUCTURE_TYPES[f.properties?.type] || STRUCTURE_TYPES.dock;
      return L.circleMarker(latlng, {
        radius: 7,
        color: '#fff',
        weight: 1.5,
        fillColor: t.color,
        fillOpacity: 0.92,
      });
    },
    onEachFeature: (f, l) => {
      const p = f.properties || {};
      const t = STRUCTURE_TYPES[p.type] || STRUCTURE_TYPES.dock;
      l.bindTooltip(`${t.emoji} ${p.name || t.label}`, { direction: 'top', offset: [0, -6] });
      l.bindPopup(buildStructurePopup(f));
    },
  }).addTo(map);

  VECTOR_LAYERS[MY_STRUCTURES_KEY] = layer;
  renderVectorList();
}

function buildStructurePopup(f) {
  const p = f.properties || {};
  const t = STRUCTURE_TYPES[p.type] || STRUCTURE_TYPES.dock;
  const idx = myStructuresGeo.features.indexOf(f);
  return `
    <div style="font-family:system-ui;font-size:12px;min-width:160px">
      <b style="color:${t.color}">${t.emoji} ${t.label}</b>
      ${p.name && p.name !== t.label ? `<br><span style="color:#aaa">${esc(p.name)}</span>` : ''}
      <br><span style="font-size:10px;color:#666">${new Date(p.addedAt||0).toLocaleDateString()}</span>
      <div style="margin-top:8px;display:flex;gap:6px">
        ${idx >= 0 ? `<button onclick="window._deleteStructure(${idx})" style="padding:2px 8px;font-size:11px;border:1px solid #ff5252;color:#ff5252;background:transparent;border-radius:4px;cursor:pointer">🗑 Delete</button>` : ''}
      </div>
    </div>`;
}

window._deleteStructure = async function(idx) {
  myStructuresGeo.features.splice(idx, 1);
  pinCount = myStructuresGeo.features.length;
  rebuildMyStructuresLayer();
  await saveMyStructures();
  updateHUD();
};

// ── QuickDraw HUD ─────────────────────────────────────────────────────────────

let hudEl = null;

function createHUD() {
  if (hudEl) return;
  hudEl = document.createElement('div');
  hudEl.id = 'quickDrawHUD';
  hudEl.style.cssText = `
    position:fixed;bottom:70px;left:50%;transform:translateX(-50%);
    z-index:1500;background:rgba(11,22,35,.95);border:1px solid var(--accent2);
    border-radius:10px;padding:8px 16px;font-size:12px;font-family:system-ui;
    display:none;flex-direction:column;align-items:center;gap:4px;
    box-shadow:0 4px 20px rgba(0,0,0,.6);pointer-events:none;min-width:300px;
  `;
  document.body.appendChild(hudEl);
}

function updateHUD() {
  if (!hudEl) return;
  if (!mappingMode) { hudEl.style.display = 'none'; return; }
  const t = STRUCTURE_TYPES[activeType];

  // Count per type
  const counts = {};
  myStructuresGeo.features.forEach(f => {
    const k = f.properties?.type || 'dock';
    counts[k] = (counts[k] || 0) + 1;
  });
  const countRow = Object.entries(STRUCTURE_TYPES)
    .filter(([k]) => counts[k])
    .map(([k, s]) => `<span style="color:${s.color};margin:0 4px">${s.emoji} ${counts[k]}</span>`)
    .join('');

  hudEl.innerHTML = `
    <div style="color:${t.color};font-weight:700;font-size:14px">${t.emoji} ${t.label} — Click to place</div>
    <div style="color:#888;font-size:10px;margin:1px 0">${pinCount} total · Z/⌫=Undo · Esc=Exit</div>
    ${countRow ? `<div style="font-size:11px;margin:1px 0">${countRow}</div>` : ''}
    <div style="font-size:10px;margin-top:2px;color:#555">${Object.entries(STRUCTURE_TYPES).map(([k,s]) =>
      `<span style="color:${k === activeType ? s.color : '#444'};margin:0 2px;font-weight:${k===activeType?'700':'400'}">[${s.hotkey}]${s.label}</span>`
    ).join(' ')}</div>
  `;
  hudEl.style.display = 'flex';
}

// ── Map cursor ────────────────────────────────────────────────────────────────

function setMapCursor(crosshair) {
  const map = state?.MAP;
  if (!map) return;
  map.getContainer().style.cursor = crosshair ? 'crosshair' : '';
}

// ── Mapping mode enter/exit ───────────────────────────────────────────────────

function enterMappingMode() {
  mappingMode = true;
  activeType  = DEFAULT_TYPE;
  setMapCursor(true);
  updateHUD();
  updateMappingBtn();
  // Disable map double-click zoom so rapid clicking doesn't zoom
  state?.MAP?.doubleClickZoom?.disable();
}

function exitMappingMode() {
  mappingMode = false;
  setMapCursor(false);
  updateHUD();
  updateMappingBtn();
  state?.MAP?.doubleClickZoom?.enable();
}

function updateMappingBtn() {
  const btn = panel?.querySelector('#btnStartMapping');
  if (!btn) return;
  if (mappingMode) {
    btn.textContent = '⏹ Stop Mapping';
    btn.style.background = 'var(--accent2)';
    btn.style.color = '#000';
  } else {
    btn.textContent = '📌 Start Mapping';
    btn.style.background = 'transparent';
    btn.style.color = 'var(--accent2)';
  }
}

// ── Drop a pin ────────────────────────────────────────────────────────────────

async function dropPin(latlng) {
  const t = STRUCTURE_TYPES[activeType];
  const feature = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [latlng.lng, latlng.lat] },
    properties: {
      type: activeType,
      name: t.label,
      color: t.color,
      quality: 5,          // default mid quality — editable later
      addedAt: new Date().toISOString(),
    },
  };
  myStructuresGeo.features.push(feature);
  undoStack.push(myStructuresGeo.features.length - 1);
  pinCount = myStructuresGeo.features.length;
  rebuildMyStructuresLayer();
  await saveMyStructures();
  updateHUD();

  // Flash the newly placed marker so the click registration is obvious
  const map = state?.MAP;
  if (map) {
    const flash = L.circleMarker([latlng.lat, latlng.lng], {
      radius: 14, color: t.color, fillColor: t.color,
      fillOpacity: 0.5, weight: 2, opacity: 0.9,
    }).addTo(map);
    setTimeout(() => map.removeLayer(flash), 400);
  }
}

async function undoLastPin() {
  if (!undoStack.length) return;
  const idx = undoStack.pop();
  myStructuresGeo.features.splice(idx, 1);
  pinCount = myStructuresGeo.features.length;
  rebuildMyStructuresLayer();
  await saveMyStructures();
  updateHUD();
}

// ── Keyboard handler ──────────────────────────────────────────────────────────

function handleMappingKey(e) {
  if (!mappingMode) return;
  const key = e.key.toUpperCase();

  // Type hotkeys
  for (const [typeKey, t] of Object.entries(STRUCTURE_TYPES)) {
    if (key === t.hotkey) {
      activeType = typeKey;
      updateHUD();
      return;
    }
  }

  if (key === 'Z' || (e.ctrlKey && key === 'Z') || key === 'BACKSPACE') { e.preventDefault(); undoLastPin(); return; }
  if (key === 'ESCAPE') { exitMappingMode(); return; }
  if (key === 'S') { saveMyStructures(); return; }
}

// ── Map click handler ─────────────────────────────────────────────────────────

function initMapHandlers() {
  const map = state?.MAP;
  if (!map) { setTimeout(initMapHandlers, 500); return; }

  map.on('click', (e) => {
    if (!mappingMode) return;
    dropPin(e.latlng);
  });

  document.addEventListener('keydown', handleMappingKey);
}

// ── addCustomVectorLayer (public API, unchanged behaviour) ────────────────────

window.addCustomVectorLayer = function addCustomVectorLayer(layerName, geojson) {
  const map = state?.MAP;
  if (!map) return;
  if (VECTOR_LAYERS[layerName]) map.removeLayer(VECTOR_LAYERS[layerName]);

  const features = geojson.features || [];
  const hasLines  = features.some((f) => f.geometry?.type?.includes('Line'));

  const layer = L.geoJSON(geojson, {
    style: (f) => {
      const p = f.properties || {};
      return { color: p.color || '#ff00ff', fillColor: p.color || '#ff00ff',
               fillOpacity: 0.15, weight: p.weight || 3,
               dashArray: p.dash || (hasLines ? '6,4' : null), opacity: 0.9 };
    },
    pointToLayer: (f, latlng) => {
      const p = f.properties || {};
      const t = STRUCTURE_TYPES[p.type];
      return L.circleMarker(latlng, {
        radius: 7, color: '#fff', weight: 1.5,
        fillColor: t?.color || p.color || '#ffb703', fillOpacity: 0.88,
      });
    },
    onEachFeature: (f, l) => {
      const p = f.properties || {};
      const t = STRUCTURE_TYPES[p.type];
      const name = p.name || t?.label || p.Name || p.label || p.type || 'Structure';
      const depth = p.depth || p.Depth || '';
      const notes = p.notes || p.Notes || p.desc || p.category || '';
      l.bindTooltip(`${t?.emoji || '📍'} ${esc(name)}`, { direction: 'top', offset: [0, -4] });
      l.bindPopup(`<b style="color:${t?.color || p.color || '#ff00ff'}">${t?.emoji || '📍'} ${esc(name)}</b>
        ${depth ? `<br>Depth: ${esc(depth)} ft` : ''}${notes ? `<br><i>${esc(notes)}</i>` : ''}`);
    },
  }).addTo(map);

  VECTOR_LAYERS[layerName] = layer;
  try { map.fitBounds(layer.getBounds(), { padding: [30, 30] }); } catch (_) {}
  renderVectorList();
  if (window.DB?.db) {
    try { window.DB.put('layers', { name: layerName, geo: geojson, importedAt: new Date().toISOString() }); } catch (_) {}
  }

  // If imported GeoJSON contains Point features with known structure types or
  // labels, merge them into My Structures so getMyStructures() can find them.
  // This allows imported route templates (Ln1/Ln2/Ln3/Ln4 waypoints) to be
  // used by Smart Plan without manually re-dropping every point.
  const structurePoints = (geojson.features || []).filter(f =>
    f.geometry?.type === 'Point' &&
    (STRUCTURE_TYPES[f.properties?.type] || f.properties?.label)
  );
  if (structurePoints.length > 0) {
    // Merge into myStructuresGeo — replace any existing features with same name/label
    const existingNames = new Set(myStructuresGeo.features.map(f => f.properties?.name).filter(Boolean));
    let added = 0;
    for (const f of structurePoints) {
      const name = f.properties?.name;
      if (name && existingNames.has(name)) continue; // skip duplicates
      myStructuresGeo.features.push({
        ...f,
        properties: { ...f.properties, addedAt: f.properties?.addedAt || new Date().toISOString() }
      });
      added++;
    }
    if (added > 0) {
      pinCount = myStructuresGeo.features.length;
      rebuildMyStructuresLayer();
      saveMyStructures();
      console.log(`[custom-vectors] merged ${added} structure points from "${layerName}" into My Structures`);
    }
  }
};

window.removeCustomVectorLayer = function(layerName) {
  if (VECTOR_LAYERS[layerName]) {
    state.MAP?.removeLayer(VECTOR_LAYERS[layerName]);
    delete VECTOR_LAYERS[layerName];
    renderVectorList();
    return true;
  }
  return false;
};

// ── Smart Plan API ────────────────────────────────────────────────────────────

window.getMyStructures = function() {
  return myStructuresGeo.features.map(f => ({
    name:     f.properties?.name  || 'Structure',
    type:     f.properties?.type  || 'unknown',
    label:   f.properties?.label   || null,        // ← ADD THIS
    quality:  f.properties?.quality ?? 5,
    lat:      f.geometry?.coordinates?.[1],
    lon:      f.geometry?.coordinates?.[0],
    addedAt:  f.properties?.addedAt,
  })).filter(s => s.lat && s.lon);
};

// ── Export GeoJSON ────────────────────────────────────────────────────────────

function exportMyStructures() {
  const blob = new Blob([JSON.stringify(myStructuresGeo, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `my_structures_${new Date().toISOString().slice(0,10)}.geojson`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Panel ─────────────────────────────────────────────────────────────────────

const panel = document.createElement('div');
panel.id = 'customVectorPanel';
panel.style.cssText = 'display:none;position:absolute;bottom:52px;left:8px;z-index:600;background:rgba(11,22,35,.96);border:1px solid var(--accent);border-radius:10px;padding:12px 14px;min-width:270px;max-height:60vh;overflow-y:auto;font-size:12px';
panel.innerHTML = `
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
    <span style="color:var(--accent);font-weight:700">🗂 Structure Intel</span>
    <button id="closeVectorPanel" style="background:none;border:none;color:var(--muted);font-size:14px;cursor:pointer">✕</button>
  </div>

  <button id="btnStartMapping" style="width:100%;padding:7px;border-radius:6px;border:1px solid var(--accent2);background:transparent;color:var(--accent2);font-size:12px;font-weight:700;cursor:pointer;margin-bottom:6px">
    📌 Start Mapping
  </button>

  <div style="background:rgba(255,255,255,.04);border-radius:6px;padding:6px 8px;margin-bottom:8px;font-size:10px;color:var(--muted);line-height:1.6">
    Click map to drop pins · D B R T F H P C = type hotkeys<br>
    Z = Undo · Esc = Exit · S = Save
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-bottom:8px">
    ${Object.entries(STRUCTURE_TYPES).map(([k, t]) => `
      <div style="display:flex;align-items:center;gap:4px;font-size:10px;color:${t.color}">
        <span style="width:8px;height:8px;border-radius:50%;background:${t.color};flex-shrink:0"></span>
        [${t.hotkey}] ${t.label}
      </div>`).join('')}
  </div>

  <div style="border-top:1px solid var(--line);padding-top:8px;margin-bottom:8px">
    <div id="vectorLayerList"><p style="color:var(--muted);font-size:11px">No layers loaded.</p></div>
  </div>

  <div style="display:flex;flex-direction:column;gap:4px">
    <button id="btnToggleStructures" style="width:100%;padding:6px;border-radius:5px;border:1px solid #03A9F4;background:rgba(3,169,244,.1);color:#03A9F4;font-size:11px;font-weight:700;cursor:pointer;margin-bottom:2px">👁 Hide Structures</button>
    <button id="btnExportStructures" style="width:100%;padding:4px;border-radius:5px;border:1px solid var(--accent);background:transparent;color:var(--accent);font-size:10px;cursor:pointer">💾 Export My Structures GeoJSON</button>
    <button id="btnSonarTarget" style="width:100%;padding:6px;border-radius:5px;border:1px solid #00E5FF;background:rgba(0,229,255,.08);color:#00E5FF;font-size:11px;font-weight:700;cursor:pointer">🎯 Save Sonar Target (GPS position)</button>
    <button id="loadVectorBtn" style="width:100%;padding:4px;border-radius:5px;border:1px solid var(--line);background:transparent;color:var(--muted);font-size:10px;cursor:pointer">📂 Load GeoJSON File</button>
    <button id="btnClearMyStructures" style="width:100%;padding:4px;border-radius:5px;border:1px solid var(--bad);background:transparent;color:var(--bad);font-size:10px;cursor:pointer">🗑 Clear My Structures</button>
  </div>
  <p style="margin:6px 0 0;font-size:9px;color:var(--muted)">Auto-saved to device · never uploaded</p>
`;
document.getElementById('panel-map')?.appendChild(panel);

// ── Panel button wiring ───────────────────────────────────────────────────────

const toolbarBtn = document.getElementById('btnCustomVectors');
const fileInput  = document.getElementById('customVectorInput');

toolbarBtn?.addEventListener('click', () => {
  panelOpen = !panelOpen;
  panel.style.display  = panelOpen ? 'block' : 'none';
  toolbarBtn.style.background = panelOpen ? 'var(--accent)' : '';
  toolbarBtn.style.color      = panelOpen ? '#000' : '';
});

panel.querySelector('#closeVectorPanel')?.addEventListener('click', () => {
  panel.style.display  = 'none';
  panelOpen = false;
  toolbarBtn.style.background = '';
  toolbarBtn.style.color      = '';
  if (mappingMode) exitMappingMode();
});

panel.querySelector('#btnStartMapping')?.addEventListener('click', () => {
  if (mappingMode) exitMappingMode();
  else enterMappingMode();
});

panel.querySelector('#btnToggleStructures')?.addEventListener('click', () => {
  const layer = VECTOR_LAYERS[MY_STRUCTURES_KEY];
  const btn   = panel.querySelector('#btnToggleStructures');
  if (!layer) return;
  structuresVisible = !structuresVisible;
  if (structuresVisible) {
    layer.addTo(state.MAP);
    if (btn) { btn.textContent = '👁 Hide Structures'; btn.style.background = 'rgba(3,169,244,.1)'; }
  } else {
    state.MAP?.removeLayer(layer);
    if (btn) { btn.textContent = '👁 Show Structures'; btn.style.background = 'rgba(255,255,255,.05)'; }
  }
});

panel.querySelector('#btnExportStructures')?.addEventListener('click', exportMyStructures);

panel.querySelector('#btnSonarTarget')?.addEventListener('click', async () => {
  // Drop a brush_pile at the current GPS position (or map center as fallback)
  const gpsMarker = state?.GPS_MARKER;
  let latlng;
  if (gpsMarker) {
    latlng = gpsMarker.getLatLng();
  } else if (state?.MAP) {
    latlng = state.MAP.getCenter();
  } else {
    alert('No GPS fix available. Enable GPS tracking first.');
    return;
  }
  const prevType = activeType;
  activeType = 'brush_pile';
  await dropPin(latlng);
  activeType = prevType;
  const btn = panel.querySelector('#btnSonarTarget');
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = '✅ Sonar Target Saved!';
    btn.style.background = 'rgba(0,229,255,.25)';
    setTimeout(() => { btn.textContent = orig; btn.style.background = 'rgba(0,229,255,.08)'; }, 1500);
  }
});

panel.querySelector('#loadVectorBtn')?.addEventListener('click', () => fileInput?.click());

panel.querySelector('#btnClearMyStructures')?.addEventListener('click', async () => {
  if (!confirm(`Clear all ${pinCount} pinned structures? This cannot be undone.`)) return;
  myStructuresGeo = { type: 'FeatureCollection', features: [] };
  pinCount = 0;
  undoStack = [];
  if (VECTOR_LAYERS[MY_STRUCTURES_KEY]) {
    state.MAP?.removeLayer(VECTOR_LAYERS[MY_STRUCTURES_KEY]);
    delete VECTOR_LAYERS[MY_STRUCTURES_KEY];
  }
  await saveMyStructures();
  renderVectorList();
  updateHUD();
});

fileInput?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text    = await file.text();
    const geojson = JSON.parse(text);
    const layerName = file.name.replace(/\.[^.]+$/, '');
    window.addCustomVectorLayer(layerName, geojson);
    fileInput.value = '';
  } catch (err) {
    alert(`GeoJSON parse error: ${err.message}`);
  }
});

// ── Layer list renderer ───────────────────────────────────────────────────────

function renderVectorList() {
  const host  = panel.querySelector('#vectorLayerList');
  const names = Object.keys(VECTOR_LAYERS);
  if (!names.length) {
    host.innerHTML = '<p style="color:var(--muted);font-size:11px">No layers loaded.</p>';
    return;
  }
  host.innerHTML = names.map(n => {
    const isMyStructures = n === MY_STRUCTURES_KEY;
    const count = isMyStructures ? myStructuresGeo.features.length : '';
    return `
      <div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid var(--line)">
        <span style="width:8px;height:8px;background:${isMyStructures ? '#03A9F4' : '#ff00ff'};border-radius:50%;flex-shrink:0"></span>
        <span style="flex:1;color:#ccc;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(n)}${count ? ` (${count})` : ''}</span>
        ${!isMyStructures ? `<button data-vdel="${esc(n)}" style="padding:1px 5px;font-size:10px;color:var(--bad);border:none;background:transparent;cursor:pointer">🗑</button>` : ''}
        <button data-vfit="${esc(n)}" style="padding:1px 5px;font-size:10px;border:none;background:transparent;color:var(--muted);cursor:pointer">⤢</button>
      </div>`;
  }).join('');

  host.querySelectorAll('[data-vdel]').forEach(el => {
    el.addEventListener('click', () => {
      const n = el.dataset.vdel;
      if (VECTOR_LAYERS[n]) { state.MAP?.removeLayer(VECTOR_LAYERS[n]); delete VECTOR_LAYERS[n]; }
      renderVectorList();
    });
  });
  host.querySelectorAll('[data-vfit]').forEach(el => {
    el.addEventListener('click', () => {
      const n = el.dataset.vfit;
      try { if (VECTOR_LAYERS[n]) state.MAP?.fitBounds(VECTOR_LAYERS[n].getBounds(), { padding: [30, 30] }); } catch (_) {}
    });
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

createHUD();
setTimeout(() => {
  loadMyStructures();
  initMapHandlers();
}, 800);

console.log('✓ Structure Intel module armed (QuickDraw mode)');
