/**
 * Chart overlay — the rotation transform the saved chart layers need on every map move.
 *
 * THE GEOREFERENCE WORKFLOW THAT LIVED HERE WENT ON 2026-09-25: loading a screenshot, placing
 * it, nudging, scaling and rotating it, clicking or typing three georef points, and the affine
 * fit. Every control that started it -- #imgBtn, #imgInput, #georefBtn, #nudgeGroup -- was gone
 * from index.html, so none of it could run. What stays is what the saved layers in
 * chart-mosaic.js still need.
 */

import { state } from '../core/state.js';

/**
 * Apply a CSS rotation to a Leaflet overlay's image element.
 *
 * NOTE: Leaflet rewrites style.transform during zoom/pan, so we
 * APPEND our rotate() to whatever Leaflet has already set, instead
 * of replacing it. refreshChartOverlayTransforms() re-applies this
 * after every map movement.
 */
function applyOverlayRotation(overlay, deg) {
  if (!overlay) return;
  const el = overlay.getElement && overlay.getElement();
  if (!el) return;
  const rot = deg || 0;
  el.style.transformOrigin = 'center center';
  el.style.transformBox = 'fill-box';
  const base = (el.style.transform || '').replace(/\s*rotate\([^)]*\)/g, '');
  el.style.transform = `${base} rotate(${rot}deg)`.trim();
}

/**
 * Re-apply transforms to every visible saved chart overlay. Bound to
 * map.on('zoom zoomend moveend viewreset resize', …).
 */
export function refreshChartOverlayTransforms() {
  try {
    (state.CHARTS || []).forEach((c) => {
      if (!c || c.visible === false) return;
      if (c.overlay) applyOverlayRotation(c.overlay, c.rotation || 0);
    });
  } catch (e) {
    console.warn('chart transform refresh failed', e);
  }
}

// Expose for cross-module access (map-init.js subscribes to map events)
window.refreshChartOverlayTransforms = refreshChartOverlayTransforms;
