/**
 * Custom GeoJSON structure layers — load private brush-pile,
 * road-bed, creek-mouth, and other structure intel. Files stay
 * private to the device (never uploaded).
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';

const VECTOR_LAYERS = {};  // name → L.geoJSON layer
window.CUSTOM_VECTOR_LAYERS = VECTOR_LAYERS;

window.removeCustomVectorLayer = function removeCustomVectorLayer(layerName) {
  if (VECTOR_LAYERS[layerName]) {
    state.MAP?.removeLayer(VECTOR_LAYERS[layerName]);
    delete VECTOR_LAYERS[layerName];
    renderVectorList();
    return true;
  }
  return false;
};

window.addCustomVectorLayer = function addCustomVectorLayer(layerName, geojson) {
  if (VECTOR_LAYERS[layerName]) state.MAP?.removeLayer(VECTOR_LAYERS[layerName]);

  const features = geojson.features || [];
  const hasLines  = features.some((f) => f.geometry?.type?.includes('Line'));

  const layer = L.geoJSON(geojson, {
    style: (f) => {
      const p = f.properties || {};
      return {
        color: p.color || '#ff00ff',
        fillColor: p.color || '#ff00ff',
        fillOpacity: 0.15,
        weight: p.weight || 3,
        dashArray: p.dash || (hasLines ? '6,4' : null),
        opacity: 0.9,
      };
    },
    pointToLayer: (f, latlng) => {
      const p = f.properties || {};
      return L.circleMarker(latlng, {
        radius: p.radius || 7,
        color: p.color || '#ffb703',
        fillColor: '#ff5252',
        fillOpacity: 0.8,
        weight: 2,
      });
    },
    onEachFeature: (f, l) => {
      const props = f.properties || {};
      const name  = props.name || props.Name || props.label || props.type || 'Structure';
      const depth = props.depth || props.Depth || '';
      const notes = props.notes || props.Notes || props.desc || props.category || '';
      l.bindPopup(`<b style="color:${props.color || '#ff00ff'}">🗂 ${esc(name)}</b>${depth ? `<br>Depth: ${esc(depth)} ft` : ''}${notes ? `<br><i>${esc(notes)}</i>` : ''}`);
      l.bindTooltip(esc(name), { direction: 'top', offset: [0, -4] });
    },
  }).addTo(state.MAP);

  VECTOR_LAYERS[layerName] = layer;
  if (state.MAP && layer.getBounds) {
    state.MAP.fitBounds(layer.getBounds(), { padding: [30, 30] });
  }
  renderVectorList();

  if (window.DB?.db) {
    try {
      window.DB.put('layers', { name: layerName, geo: geojson, importedAt: new Date().toISOString() });
    } catch (_) {}
  }
};

// ── Floating panel for managing loaded layers ───────────────────────────

const panel = document.createElement('div');
panel.id = 'customVectorPanel';
panel.style.cssText = 'display:none;position:absolute;bottom:52px;left:8px;z-index:600;background:rgba(11,22,35,.96);border:1px solid var(--accent);border-radius:10px;padding:12px 14px;min-width:260px;max-height:50vh;overflow-y:auto;font-size:12px';
panel.innerHTML = `
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
    <span style="color:var(--accent);font-weight:700">🗂 My Structure Layers</span>
    <button id="closeVectorPanel" style="background:none;border:none;color:var(--muted);font-size:14px;cursor:pointer">✕</button>
  </div>
  <div id="vectorLayerList"><p class="muted">No layers loaded yet.</p></div>
  <button id="loadVectorBtn" class="small primary" style="width:100%;margin-top:8px">📂 Load GeoJSON Structure File</button>
  <p class="muted" style="margin:6px 0 0;font-size:10px">Files stay private — never uploaded. Brush piles, road beds, creek mouths, ledges.</p>`;
document.getElementById('panel-map')?.appendChild(panel);

let panelOpen = false;

const btn = document.getElementById('btnCustomVectors');
const fileInput = document.getElementById('customVectorInput');

btn?.addEventListener('click', () => {
  panelOpen = !panelOpen;
  panel.style.display = panelOpen ? 'block' : 'none';
  btn.style.background = panelOpen ? 'var(--accent)' : '';
  btn.style.color = panelOpen ? '#000' : '';
});

panel.querySelector('#closeVectorPanel')?.addEventListener('click', () => {
  panel.style.display = 'none';
  panelOpen = false;
  btn.style.background = '';
  btn.style.color = '';
});

panel.querySelector('#loadVectorBtn')?.addEventListener('click', () => fileInput?.click());

fileInput?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const geojson = JSON.parse(text);
    const layerName = file.name.replace(/\.[^.]+$/, '');
    window.addCustomVectorLayer(layerName, geojson);
    fileInput.value = '';
    console.log(`✓ Custom Vectors: loaded "${layerName}" — ${geojson.features?.length || 0} features`);
  } catch (err) {
    alert(`Error parsing GeoJSON: ${err.message}\n\nEnsure the file is valid GeoJSON format.`);
  }
});

function renderVectorList() {
  const host = panel.querySelector('#vectorLayerList');
  const names = Object.keys(VECTOR_LAYERS);
  if (!names.length) {
    host.innerHTML = '<p class="muted">No layers loaded yet.</p>';
    return;
  }
  host.innerHTML = names.map((n) => `
    <div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--line)">
      <span style="width:10px;height:10px;background:#ff00ff;border-radius:50%;display:inline-block;flex-shrink:0"></span>
      <span style="flex:1;color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(n)}</span>
      <button data-vdel="${esc(n)}" style="padding:1px 6px;font-size:11px;color:var(--bad)">🗑</button>
      <button data-vfit="${esc(n)}" style="padding:1px 6px;font-size:11px">⤢</button>
    </div>
  `).join('');
  host.querySelectorAll('[data-vdel]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const n = e.target.dataset.vdel;
      if (VECTOR_LAYERS[n]) { state.MAP.removeLayer(VECTOR_LAYERS[n]); delete VECTOR_LAYERS[n]; }
      renderVectorList();
    });
  });
  host.querySelectorAll('[data-vfit]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const n = e.target.dataset.vfit;
      if (VECTOR_LAYERS[n]) state.MAP.fitBounds(VECTOR_LAYERS[n].getBounds(), { padding: [30, 30] });
    });
  });
}
