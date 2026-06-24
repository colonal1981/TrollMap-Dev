/**
 * Chart mosaic — saved depth-contour overlay layers.
 *
 * state.CHARTS holds the committed layers. Each entry is one of:
 *   { type: 'bounds', name, img, bounds: {north,south,east,west}, overlay, visible, opacity, rotation }
 *   { type: 'affine', name, img, natSize, pts, affine, visible, opacity }
 *
 * Layers persist to IndexedDB via `settings.__all__` (the global
 * container entry) and are restored on page load.
 *
 * Companion: chart-overlay.js handles the WORKING image being aligned.
 * chart-import.js (separate module) handles bulk-sidecar imports that
 * bypass the georef workflow and land straight in CHARTS.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { setBanner } from '../core/map-init.js';

// Exposed so chart-overlay.js and others can push to the saved list.
export function addChartLayer(name, img, bounds, opacity, rotation) {
  const rot = rotation || 0;
  const ov = L.imageOverlay(img, [[bounds.north, bounds.west], [bounds.south, bounds.east]], {
    opacity: opacity != null ? opacity : 0.75,
    interactive: false,
  }).addTo(state.MAP);
  ov.setZIndex(1);
  setTimeout(() => window.refreshChartOverlayTransforms?.(), 0);
  state.CHARTS.push({
    type: 'bounds', name, img,
    bounds: { ...bounds },
    overlay: ov, visible: true,
    opacity: opacity != null ? opacity : 0.75,
    rotation: rot,
  });
  renderChartList();
}

export function addAffineChartLayer(name, img, natSize, pts, opacity) {
  // Lazy-load the affine helper from chart-overlay (avoids circular import).
  const aff = window.createAffineImageOverlayForMosaic
    ? window.createAffineImageOverlayForMosaic(img, natSize, pts, opacity != null ? opacity : 0.75)
    : null;
  if (!aff) return;  // chart-overlay not loaded yet — caller will retry

  state.CHARTS.push({
    type: 'affine', name, img,
    natSize: { ...natSize },
    pts: pts.map((p) => ({ ...p })),
    affine: aff, visible: true,
    opacity: opacity != null ? opacity : 0.75,
  });
  renderChartList();
}

// Expose for chart-overlay.js (its applyAffineGeoref used to inline this)
window.addAffineChartLayer = addAffineChartLayer;

/**
 * Commit the working overlay as a permanent CHARTS layer.
 *
 * Behavior:
 *   - If user clicked Commit with no working image but an active
 *     committed chart is selected, persist that chart's edits.
 *   - Otherwise, prompt for a name and turn the working overlay
 *     (bounds or affine) into a permanent layer.
 */
async function commitWorkingChart() {
  // No working image — save edits to active committed chart instead
  if ((!state.IMG_DATAURL || (!state.IMG_BOUNDS && !state.IMG_AFFINE_PTS)) &&
      state.ACTIVE_CHART >= 0 && state.CHARTS[state.ACTIVE_CHART]) {
    await persistCharts();
    window.refreshChartOverlayTransforms?.();
    setBanner(`Saved edits to "${state.CHARTS[state.ACTIVE_CHART].name}"`);
    setTimeout(() => setBanner(''), 1800);
    return;
  }
  if (!state.IMG_DATAURL || (!state.IMG_BOUNDS && !state.IMG_AFFINE_PTS)) {
    alert('Load + align a chart first');
    return;
  }
  const name = prompt('Name this chart (e.g. "Wateree North Cove"):', `Chart ${state.CHARTS.length + 1}`);
  if (!name) return;

  if (state.IMG_AFFINE_PTS && state.IMG_AFFINE) {
    state.IMG_AFFINE.remove();
    state.IMG_AFFINE = null;
    addAffineChartLayer(
      name, state.IMG_DATAURL, state.IMG_NATSIZE, state.IMG_AFFINE_PTS,
      parseFloat(document.getElementById('imgOpacity')?.value || 75) / 100,
    );
  } else {
    if (state.IMG_OVERLAY) { state.MAP.removeLayer(state.IMG_OVERLAY); state.IMG_OVERLAY = null; }
    addChartLayer(
      name, state.IMG_DATAURL, state.IMG_BOUNDS,
      parseFloat(document.getElementById('imgOpacity')?.value || 75) / 100,
      state.IMG_ROTATION,
    );
  }
  await persistCharts();

  // Reset working state so the user can load another image.
  state.IMG_DATAURL = null; state.IMG_BOUNDS = null;
  state.IMG_NATSIZE = null; state.IMG_ROTATION = 0; state.IMG_AFFINE_PTS = null;
  ['toolbarGeorefGroup', 'nudgeGroup'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

function removeChartLayerObj(c) {
  if (!c || !state.MAP) return;
  try {
    if (c.type === 'affine') c.affine?.remove();
    else if (c.overlay && state.MAP.hasLayer(c.overlay)) state.MAP.removeLayer(c.overlay);
    else if (c.overlay) { try { state.MAP.removeLayer(c.overlay); } catch (_) {} }
  } catch (e) {
    console.warn('chart layer remove failed', e);
  }
}

function addChartLayerObj(c) {
  if (!c || !state.MAP) return;
  try {
    if (c.type === 'affine') {
      if (c.affine) c.affine.add();
      else if (c.img && c.natSize && c.pts) {
        c.affine = window.createAffineImageOverlayForMosaic?.(c.img, c.natSize, c.pts, c.opacity || 0.75);
      }
    } else if (c.overlay) {
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
  state.ACTIVE_CHART = -1;
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
  state.ACTIVE_CHART = -1;
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
        <button data-chart-idx="${idx}" data-chart-action="nudge" title="Make this the active chart for nudging">✥</button>
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
  } else if (action === 'nudge') {
    state.ACTIVE_CHART = idx;
    showNudgeToolbar();
    setBanner(`Nudge mode for "${c.name}" — use arrows or buttons`);
    setTimeout(() => setBanner(''), 2200);
  } else if (action === 'delete') {
    if (!confirm(`Delete "${c.name}"?`)) return;
    removeChartLayerObj(c);
    state.CHARTS.splice(idx, 1);
    state.ACTIVE_CHART = -1;
    renderChartList();
    persistCharts();
  } else if (action === 'opacity') {
    const op = parseInt(el.value, 10) / 100;
    c.opacity = op;
    if (c.type === 'affine' && c.affine) {
      c.affine.opacity = op;
      c.affine.update();
    } else if (c.overlay) {
      c.overlay.setOpacity(op);
      window.refreshChartOverlayTransforms?.();
    }
    persistCharts();
  }
}

// ── Persistence (IndexedDB) ───────────────────────────────────────────────

export async function persistCharts() {
  if (!window.DB?.db) return;
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
    await window.DB.put('charts', {
      name: '__all__',
      charts: minimal,
      savedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('persistCharts failed', e);
  }
}

export async function restoreCharts() {
  if (!window.DB?.db) return;
  try {
    const rec = await window.DB.get('charts', '__all__');
    if (!rec || !Array.isArray(rec.charts)) return;
    rec.charts.forEach((c) => {
      state.CHARTS.push({
        ...c,
        visible: c.visible !== false,
        overlay: null,
        affine: null,
      });
    });
    // Re-create Leaflet layers after MAP is ready.
    if (state.MAP_OK) {
      state.CHARTS.forEach((c) => { if (c.visible !== false) addChartLayerObj(c); });
      const pts = [];
      state.CHARTS.forEach((c) => {
        if (c.type === 'affine' && c.pts) c.pts.forEach((p) => pts.push([p.lat, p.lon]));
        else if (c.bounds) {
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

// ── Nudge / scale / rotate for ACTIVE_CHART ──────────────────────────────

function nudgeTarget(dLat, dLon) {
  if (state.ACTIVE_CHART >= 0 && state.CHARTS[state.ACTIVE_CHART]) {
    const c = state.CHARTS[state.ACTIVE_CHART];
    if (c.type === 'affine') {
      c.pts.forEach((p) => { p.lat += dLat; p.lon += dLon; });
      if (c.affine) {
        c.affine.pts = c.pts.map((p) => ({ ...p }));
        c.affine.update();
      }
    } else {
      c.bounds.north += dLat; c.bounds.south += dLat;
      c.bounds.east  += dLon; c.bounds.west  += dLon;
      c.overlay.setBounds([[c.bounds.north, c.bounds.west], [c.bounds.south, c.bounds.east]]);
      window.refreshChartOverlayTransforms?.();
    }
    persistCharts();
    setBanner(`Nudged ${c.name}`);
    setTimeout(() => setBanner(''), 1200);
  } else if (window.nudgeImage) {
    window.nudgeImage(dLat, dLon);
  }
}

function scaleChartLayer(c, fLat, fLon) {
  if (c.type === 'affine') {
    // Use the same transform helper as chart-overlay (exposed on window)
    c.pts = window.transformAffinePtsForMosaic?.(c.pts, { sx: fLon, sy: fLat }) || c.pts;
    if (c.affine) {
      c.affine.pts = c.pts.map((p) => ({ ...p }));
      c.affine.update();
    }
    return;
  }
  const b = c.bounds;
  const cLat = (b.north + b.south) / 2;
  const cLon = (b.east + b.west) / 2;
  const hLat = (b.north - b.south) / 2 * fLat;
  const hLon = (b.east - b.west) / 2 * fLon;
  b.north = cLat + hLat; b.south = cLat - hLat;
  b.east  = cLon + hLon; b.west  = cLon - hLon;
  c.overlay.setBounds([[b.north, b.west], [b.south, b.east]]);
  window.refreshChartOverlayTransforms?.();
}

function scaleTarget(fLat, fLon) {
  if (state.ACTIVE_CHART >= 0 && state.CHARTS[state.ACTIVE_CHART]) {
    const c = state.CHARTS[state.ACTIVE_CHART];
    scaleChartLayer(c, fLat, fLon);
    persistCharts();
    setBanner(`Scaled ${c.name}`);
    setTimeout(() => setBanner(''), 1200);
  } else if (window.scaleImage) {
    window.scaleImage(fLat, fLon);
  }
}

function rotateTarget(deltaDeg) {
  if (state.ACTIVE_CHART >= 0 && state.CHARTS[state.ACTIVE_CHART]) {
    const c = state.CHARTS[state.ACTIVE_CHART];
    if (c.type === 'affine') {
      c.pts = window.transformAffinePtsForMosaic?.(c.pts, { rotateDeg: deltaDeg }) || c.pts;
      if (c.affine) {
        c.affine.pts = c.pts.map((p) => ({ ...p }));
        c.affine.update();
      }
      persistCharts();
      setBanner(`Rotated ${c.name}`);
    } else {
      c.rotation = (c.rotation || 0) + deltaDeg;
      window.refreshChartOverlayTransforms?.();
      persistCharts();
      setBanner(`Rotated ${c.name}: ${c.rotation.toFixed(1)}°`);
    }
    setTimeout(() => setBanner(''), 1200);
  } else if (window.rotateImage) {
    window.rotateImage(deltaDeg);
    setBanner(`Rotated working chart: ${(state.IMG_ROTATION || 0).toFixed(1)}°`);
    setTimeout(() => setBanner(''), 1200);
  }
}

function showNudgeToolbar() {
  const toolbar = document.getElementById('toolbarGeorefGroup');
  const nudge   = document.getElementById('nudgeGroup');
  if (toolbar) {
    toolbar.classList.remove('hidden');
    toolbar.style.display = 'flex';
  }
  if (nudge) nudge.style.display = 'flex';
}

// Expose for the arrow-key handler in main.js / map-init.js
window.nudgeTarget  = nudgeTarget;
window.scaleTarget  = scaleTarget;
window.rotateTarget = rotateTarget;

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

  // Add the working overlay as a permanent layer
  document.getElementById('addChartBtn')?.addEventListener('click', commitWorkingChart);

  // Nudge / scale / rotate (target the active committed chart OR the working overlay)
  document.getElementById('nBig')?.addEventListener('click', (e) => {
    const cur = e.target.textContent;
    const isBig = cur.includes('coarse');
    e.target.textContent = `step: ${isBig ? 'fine' : 'coarse'}`;
  });
  document.getElementById('nWide')?.addEventListener('click',    () => scaleTarget(1, 1.01));
  document.getElementById('nNarrow')?.addEventListener('click',  () => scaleTarget(1, 0.99));
  document.getElementById('nTall')?.addEventListener('click',    () => scaleTarget(1.01, 1));
  document.getElementById('nShort')?.addEventListener('click',   () => scaleTarget(0.99, 1));
  document.getElementById('nRotL')?.addEventListener('click',    () => rotateTarget(-0.5));
  document.getElementById('nRotR')?.addEventListener('click',    () => rotateTarget(+0.5));
}

wireButtons();

// Public surface
export const chartsApi = {
  addChartLayer,
  addAffineChartLayer,
  commitWorkingChart,
  persistCharts,
  restoreCharts,
  renderChartList,
  setAllChartsVisible,
  deleteChartsByPredicate,
  showNudgeToolbar,
};