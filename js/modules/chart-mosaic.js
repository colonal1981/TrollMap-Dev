/**
 * Chart mosaic — saved depth-contour overlay layers.
 *
 * state.CHARTS holds the committed layers:
 *   { type: 'bounds', name, img, bounds: {north,south,east,west}, overlay, visible, opacity, rotation }
 *
 * Layers persist to IndexedDB via `settings.__all__` (the global
 * container entry) and are restored on page load.
 *
 * WHAT WENT ON 2026-09-25: committing the working image as a layer, adding one (addChartLayer),
 * the affine layer type, and nudging, scaling and rotating a layer. The working image came from
 * the georeference workflow (chart-overlay.js) and the batch tile import (chart-import.js), both
 * deleted as unreachable; the nudge toolbar (#toolbarGeorefGroup, #nudgeGroup) was gone from
 * index.html; and the affine type called window.createAffineImageOverlayForMosaic, which nothing
 * ever defined. What is left is the Chart Layers popup: list, show, hide, opacity, delete.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { setBanner } from '../core/map-init.js';
import { get as dbGet, put as dbPut, isReady as dbIsReady } from '../utils/db.js';

function removeChartLayerObj(c) {
  if (!c || !state.MAP) return;
  try {
    if (c.overlay && state.MAP.hasLayer(c.overlay)) state.MAP.removeLayer(c.overlay);
    else if (c.overlay) {
      // Audited 2026-08-04 -- last-ditch removal of a layer the map says it does not have.
      // Leaflet throws if it never held it, which is the case being handled; the outer catch
      // reports anything that is actually a problem.
      try { state.MAP.removeLayer(c.overlay); } catch (_) {}
    }
  } catch (e) {
    console.warn('chart layer remove failed', e);
  }
}

function addChartLayerObj(c) {
  if (!c || !state.MAP) return;
  try {
    if (c.overlay) {
      c.overlay.addTo(state.MAP);
      setTimeout(() => window.refreshChartOverlayTransforms?.(), 0);
    }
  } catch (e) {
    console.warn('chart layer add failed', e);
  }
}

async function setAllChartsVisible(visible) {
  state.CHARTS.forEach((c) => {
    c.visible = visible;
    if (visible) addChartLayerObj(c);
    else removeChartLayerObj(c);
  });
  renderChartList();
  await persistCharts();
}

async function deleteChartsByPredicate(pred, confirmText) {
  const doomed = [];
  state.CHARTS.forEach((c, i) => { if (pred(c, i)) doomed.push(i); });
  if (!doomed.length) { alert('No matching chart layers to delete.'); return; }
  if (confirmText && !confirm(confirmText.replace('{n}', doomed.length))) return;
  doomed.sort((a, b) => b - a).forEach((i) => {
    removeChartLayerObj(state.CHARTS[i]);
    state.CHARTS.splice(i, 1);
  });
  renderChartList();
  await persistCharts();
  setBanner(`Deleted ${doomed.length} chart layer(s)`);
  setTimeout(() => setBanner(''), 1800);
}

function renderChartList() {
  const host = document.getElementById('chartLayers');
  if (!host) return;
  if (!state.CHARTS.length) {
    host.innerHTML = '<p class="muted">No chart layers yet. Load + georeference a screenshot.</p>';
    return;
  }
  host.innerHTML = state.CHARTS.map((c, idx) => {
    const checked = c.visible !== false ? 'checked' : '';
    return `
      <div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--line);font-size:11px">
        <input type="checkbox" data-chart-idx="${idx}" data-chart-action="toggle" ${checked} />
        <span style="flex:1;color:#e7eef6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</span>
        <button data-chart-idx="${idx}" data-chart-action="delete" title="Delete" style="color:var(--bad)">🗑</button>
        <input type="range" min="0" max="100" value="${Math.round((c.opacity || 0.75) * 100)}"
               data-chart-idx="${idx}" data-chart-action="opacity" title="Opacity" style="width:60px"/>
      </div>
    `;
  }).join('');

  host.querySelectorAll('[data-chart-action]').forEach((el) => {
    el.addEventListener('change', () => onChartAction(el));
    el.addEventListener('click',   () => onChartAction(el));
  });
}

function onChartAction(el) {
  const idx = parseInt(el.dataset.chartIdx, 10);
  const action = el.dataset.chartAction;
  const c = state.CHARTS[idx];
  if (!c) return;

  if (action === 'toggle') {
    c.visible = el.checked;
    if (el.checked) addChartLayerObj(c);
    else removeChartLayerObj(c);
    persistCharts();
  } else if (action === 'delete') {
    if (!confirm(`Delete "${c.name}"?`)) return;
    removeChartLayerObj(c);
    state.CHARTS.splice(idx, 1);
      renderChartList();
    persistCharts();
  } else if (action === 'opacity') {
    const op = parseInt(el.value, 10) / 100;
    c.opacity = op;
    if (c.overlay) {
      c.overlay.setOpacity(op);
      window.refreshChartOverlayTransforms?.();
    }
    persistCharts();
  }
}

// ── Persistence (IndexedDB) ───────────────────────────────────────────────

export async function persistCharts() {
  if (!dbIsReady()) return;
  try {
    // Strip Leaflet layer objects — only persist the data.
    const minimal = state.CHARTS.map((c) => ({
      type: c.type,
      name: c.name,
      img: c.img,
      bounds: c.bounds,
      natSize: c.natSize,
      pts: c.pts,
      visible: c.visible !== false,
      opacity: c.opacity,
      rotation: c.rotation,
    }));
    await dbPut('charts', {
      name: '__all__',
      charts: minimal,
      savedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('persistCharts failed', e);
  }
}

export async function restoreCharts() {
  if (!dbIsReady()) return;
  try {
    const rec = await dbGet('charts', '__all__');
    if (!rec || !Array.isArray(rec.charts)) return;
    rec.charts.forEach((c) => {
      state.CHARTS.push({
        ...c,
        visible: c.visible !== false,
        overlay: null,
      });
    });
    // Re-create Leaflet layers after MAP is ready.
    if (state.MAP_OK) {
      state.CHARTS.forEach((c) => { if (c.visible !== false) addChartLayerObj(c); });
      const pts = [];
      state.CHARTS.forEach((c) => {
        if (c.bounds) {
          pts.push([c.bounds.north, c.bounds.west]);
          pts.push([c.bounds.south, c.bounds.east]);
        }
      });
      if (pts.length && state.MAP) state.MAP.fitBounds(pts, { padding: [20, 20] });
    }
  } catch (e) {
    console.warn('restoreCharts failed:', e);
  }
}

// ── Wire toolbar buttons ─────────────────────────────────────────────────

function wireButtons() {
  // Big chart-list buttons (show all / hide all / delete hidden / delete all)
  document.getElementById('chartShowAllBtn')?.addEventListener('click', () => setAllChartsVisible(true));
  document.getElementById('chartHideAllBtn')?.addEventListener('click', () => setAllChartsVisible(false));
  document.getElementById('chartDeleteHiddenBtn')?.addEventListener('click', () =>
    deleteChartsByPredicate((c) => c.visible === false, 'Delete {n} hidden chart layer(s)?'),
  );
  document.getElementById('chartDeleteAllBtn')?.addEventListener('click', () =>
    deleteChartsByPredicate(() => true, 'Delete ALL {n} chart layer(s)? This cannot be undone.'),
  );
}

wireButtons();
