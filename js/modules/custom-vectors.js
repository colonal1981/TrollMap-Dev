/**
 * custom-vectors.js — imported GeoJSON layers.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHAT THIS USED TO BE
 *
 * Two features in one 614-line module: a QuickDraw structure mapper (click the map to drop
 * dock / brush / riprap / timber / attractor / hazard / point / cove pins, stored in IndexedDB)
 * and a general GeoJSON importer. The mapper was deleted 2026-08-07.
 *
 * Ryan: "that hole structure adding subpanel has been replaced by the changes we made to the
 * structure pipeline and the POIs we have here... i dont think i will ever need to add my own
 * quickdraw structures either." Seven of its eight pin types now arrive in the pack without
 * anyone clicking -- docks from docks.geojson, timber and hazards and attractors from the Garmin
 * POI layer, points and cove mouths from build_water_features.py. Riprap is the one type with no
 * replacement; if it matters, OSM man_made=breakwater is the source and fetch_osm_structures.py
 * already runs per lake.
 *
 * He confirmed no pins were stored, so nothing was exported before the store went.
 *
 * WHAT SURVIVES, AND WHERE IT LIVES NOW
 *
 * Importing a GeoJSON as a named layer. Its UI moved into the Contour Data panel, behind the
 * SAME file picker that loads contours -- Ryan: "i would prefer the merge... 1 picker and it
 * chooses what to do with it." So this module no longer owns a panel or a toolbar button; it
 * owns the layers and renders its list into whatever host the contour panel gives it.
 *
 * addCustomVectorLayer is a real EXPORT now. It used to be a bare window global, which meant
 * lint:imports could not see that the contour panel depends on it -- the same invisible
 * cross-boundary dependency that nearly cost us js/data/lakes.js. The window alias is kept for
 * anything reaching it from the console.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { isReady as dbIsReady, tryPut } from '../utils/db.js';

const VECTOR_LAYERS = {};
window.CUSTOM_VECTOR_LAYERS = VECTOR_LAYERS;

// Where renderVectorList() draws. Set by the contour panel when it builds; until then the list
// simply has nowhere to go, which is not an error -- layers still load and still draw.
let _listHost = null;

export function setVectorListHost(el) {
  _listHost = el || null;
  renderVectorList();
}

export function addCustomVectorLayer(layerName, geojson) {
  const map = state?.MAP;
  if (!map) return null;
  if (VECTOR_LAYERS[layerName]) map.removeLayer(VECTOR_LAYERS[layerName]);

  const features = geojson.features || [];
  const hasLines = features.some((f) => f.geometry?.type?.includes('Line'));

  const layer = L.geoJSON(geojson, {
    style: (f) => {
      const p = f.properties || {};
      return { color: p.color || '#ff00ff', fillColor: p.color || '#ff00ff',
               fillOpacity: 0.15, weight: p.weight || 3,
               dashArray: p.dash || (hasLines ? '6,4' : null), opacity: 0.9 };
    },
    // Styling reads the FILE's own properties now. It used to look each point up in
    // STRUCTURE_TYPES for a colour and an emoji, which only ever matched pins this app had
    // dropped itself -- an import from anywhere else fell through to the default anyway.
    pointToLayer: (f, latlng) => L.circleMarker(latlng, {
      radius: 7, color: '#fff', weight: 1.5,
      fillColor: (f.properties || {}).color || '#ffb703', fillOpacity: 0.88,
    }),
    onEachFeature: (f, l) => {
      const p = f.properties || {};
      const name = p.name || p.Name || p.label || p.type || 'Feature';
      const depth = p.depth || p.Depth || '';
      const notes = p.notes || p.Notes || p.desc || p.category || '';
      l.bindTooltip(`\u{1F4CD} ${esc(name)}`, { direction: 'top', offset: [0, -4] });
      l.bindPopup(`<b style="color:${p.color || '#ff00ff'}">\u{1F4CD} ${esc(name)}</b>`
        + `${depth ? `<br>Depth: ${esc(String(depth))} ft` : ''}`
        + `${notes ? `<br><i>${esc(String(notes))}</i>` : ''}`);
    },
  }).addTo(map);

  VECTOR_LAYERS[layerName] = layer;
  try {
    map.fitBounds(layer.getBounds(), { padding: [30, 30] });
  } catch (_) {
    // Audited 2026-08-04 -- deliberately silent. getBounds() throws on a layer with no drawable
    // features, and an import of attribute-only rows is a real thing a user can do. The layer is
    // added either way; all that is lost is the auto-zoom, which the fit button will do later.
  }
  renderVectorList();

  if (dbIsReady()) {
    const rec = { name: layerName, geo: geojson, importedAt: new Date().toISOString() };
    void tryPut('layers', rec, `imported vector layer "${layerName}"`);
    window.pushItemOnSave?.('layer', layerName, rec);
  }
  return layer;
}

export function removeCustomVectorLayer(layerName) {
  if (!VECTOR_LAYERS[layerName]) return false;
  state.MAP?.removeLayer(VECTOR_LAYERS[layerName]);
  delete VECTOR_LAYERS[layerName];
  renderVectorList();
  return true;
}

export function renderVectorList() {
  const host = _listHost;
  if (!host) return;
  const names = Object.keys(VECTOR_LAYERS);
  if (!names.length) {
    host.innerHTML = '<p style="color:var(--muted);font-size:11px;margin:0">No imported layers.</p>';
    return;
  }
  host.innerHTML = names.map((n) => `
      <div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid var(--line)">
        <span style="width:8px;height:8px;background:#ff00ff;border-radius:50%;flex-shrink:0"></span>
        <span style="flex:1;color:#ccc;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(n)}</span>
        <button data-vdel="${esc(n)}" style="padding:1px 5px;font-size:10px;color:var(--bad);border:none;background:transparent;cursor:pointer">\u{1F5D1}</button>
        <button data-vfit="${esc(n)}" style="padding:1px 5px;font-size:10px;border:none;background:transparent;color:var(--muted);cursor:pointer">⤢</button>
      </div>`).join('');

  host.querySelectorAll('[data-vdel]').forEach((el) => {
    el.addEventListener('click', () => removeCustomVectorLayer(el.dataset.vdel));
  });
  host.querySelectorAll('[data-vfit]').forEach((el) => {
    el.addEventListener('click', () => {
      const n = el.dataset.vfit;
      try {
        if (VECTOR_LAYERS[n]) state.MAP?.fitBounds(VECTOR_LAYERS[n].getBounds(), { padding: [30, 30] });
      } catch (_) {
        // Same as the fit on import: an empty layer has no bounds and Leaflet throws. The user
        // pressed a zoom button and there is nothing to zoom to; there is nothing to report.
      }
    });
  });
}

// Kept for anything calling it from the console. Production code imports the export.
window.addCustomVectorLayer = addCustomVectorLayer;
window.removeCustomVectorLayer = removeCustomVectorLayer;
