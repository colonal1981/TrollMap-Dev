/**
 * Chart overlay — the SINGLE working image being georeferenced.
 *
 * State used:
 *   state.IMG_OVERLAY      — current L.imageOverlay or null
 *   state.IMG_DATAURL      — data URL of the loaded image
 *   state.IMG_NATSIZE      — { w, h } natural pixel size
 *   state.IMG_BOUNDS       — { north, south, east, west } for bounds mode
 *   state.IMG_ROTATION     — degrees, applied via CSS rotate
 *   state.IMG_AFFINE       — affine-overlay object or null
 *   state.IMG_AFFINE_PTS   — [{ fx, fy, lat, lon }, ...] (3 points)
 *
 *   IMG_NATSIZE is kept as a module-level var because it's only used
 *   by this module and isn't read elsewhere.
 *
 * Companion module: chart-mosaic.js manages the SAVED chart layers
 * (state.CHARTS array) once the user clicks "Commit".
 */

import { state } from '../core/state.js';
import { setBanner } from '../core/map-init.js';

// Module-only — never read by other modules.
let IMG_NATSIZE = null;

// ── Bounds helpers ─────────────────────────────────────────────────────────

function affinePtsBounds(pts) {
  const lats = pts.map((p) => p.lat);
  const lons = pts.map((p) => p.lon);
  return [[Math.max(...lats), Math.min(...lons)], [Math.min(...lats), Math.max(...lons)]];
}

// ── Affine math (3-point perspective-fit) ──────────────────────────────────

/**
 * Solve a 2D affine transformation from 3 src points to 3 dst points.
 * Returns {a,b,c,d,e,f} (2×3 matrix), or null if the points are
 * degenerate (collinear).
 */
function solveAffineFrom3(src, dst) {
  const [s1, s2, s3] = src;
  const [d1, d2, d3] = dst;
  const x1 = s1.x, y1 = s1.y, x2 = s2.x, y2 = s2.y, x3 = s3.x, y3 = s3.y;
  const den = x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2);
  if (Math.abs(den) < 0.000001) return null;

  function coeff(v1, v2, v3) {
    const a = (v1 * (y2 - y3) + v2 * (y3 - y1) + v3 * (y1 - y2)) / den;
    const c = (v1 * (x3 - x2) + v2 * (x1 - x3) + v3 * (x2 - x1)) / den;
    const e = (v1 * (x2 * y3 - x3 * y2) + v2 * (x3 * y1 - x1 * y3) + v3 * (x1 * y2 - x2 * y1)) / den;
    return [a, c, e];
  }
  const [a, c, e] = coeff(d1.x, d2.x, d3.x);
  const [b, d, f] = coeff(d1.y, d2.y, d3.y);
  return { a, b, c, d, e, f };
}

/**
 * Create a Leaflet-overlay-pane image positioned by an affine matrix.
 * Used for non-rectangular (rotated/slanted) chart images that
 * a simple L.imageOverlay can't place correctly.
 */
function createAffineImageOverlay(img, natSize, pts, opacity) {
  const el = document.createElement('img');
  el.src = img;
  el.style.position = 'absolute';
  el.style.left = '0px';
  el.style.top = '0px';
  el.style.width  = (natSize?.w || 1000) + 'px';
  el.style.height = (natSize?.h || 1000) + 'px';
  el.style.transformOrigin = '0 0';
  el.style.pointerEvents = 'none';
  el.style.opacity = (opacity != null ? opacity : 0.75);
  el.style.zIndex = '1';

  const pane = state.MAP.getPanes().overlayPane;
  pane.appendChild(el);

  const obj = {
    el, img,
    natSize: Object.assign({}, natSize),
    pts: pts.map((p) => Object.assign({}, p)),
    opacity: opacity != null ? opacity : 0.75,
    visible: true,
    update() {
      if (!state.MAP || !this.el || !this.pts || this.pts.length < 3) return;
      const w = this.natSize?.w || 1000;
      const h = this.natSize?.h || 1000;
      const src = this.pts.slice(0, 3).map((p) => ({ x: p.fx * w, y: p.fy * h }));
      const dst = this.pts.slice(0, 3).map((p) => state.MAP.latLngToLayerPoint([p.lat, p.lon]));
      const m = solveAffineFrom3(src, dst);
      if (!m) return;
      this.el.style.transform = `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`;
      this.el.style.opacity = this.opacity;
    },
    remove() { if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el); },
    add()    {
      if (this.el && !this.el.parentNode) state.MAP.getPanes().overlayPane.appendChild(this.el);
      this.update();
    },
  };
  setTimeout(() => obj.update(), 0);
  return obj;
}

// ── Rotation transform (Leaflet rewrites transform during zoom/pan) ───────

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
 * Re-apply transforms to every visible chart overlay (working +
 * saved). Bound to map.on('zoom zoomend moveend viewreset resize', …).
 */
export function refreshChartOverlayTransforms() {
  try {
    if (state.IMG_OVERLAY) applyOverlayRotation(state.IMG_OVERLAY, state.IMG_ROTATION || 0);
    if (state.IMG_AFFINE && state.IMG_AFFINE.update) state.IMG_AFFINE.update();
    (state.CHARTS || []).forEach((c) => {
      if (!c || c.visible === false) return;
      if (c.type === 'affine' && c.affine && c.affine.update) c.affine.update();
      else if (c.overlay) applyOverlayRotation(c.overlay, c.rotation || 0);
    });
  } catch (e) {
    console.warn('chart transform refresh failed', e);
  }
}

// Expose for cross-module access (map-init.js subscribes to map events)
window.refreshChartOverlayTransforms = refreshChartOverlayTransforms;

// ── Working overlay: place, nudge, scale, rotate ─────────────────────────

/**
 * Place the provisional working overlay on the map after image load.
 * Default position is centered on the map at a reasonable pixel size.
 */
function placeProvisionalOverlay() {
  if (!state.IMG_DATAURL || !state.MAP || !IMG_NATSIZE) return;

  const c = state.MAP.getCenter();
  const zoom = state.MAP.getZoom();
  const pxSize = 600 / Math.max(1, Math.pow(1.4, 14 - zoom));

  // Remove any prior working overlay.
  if (state.IMG_OVERLAY) state.MAP.removeLayer(state.IMG_OVERLAY);
  if (state.IMG_AFFINE)  state.IMG_AFFINE.remove();

  state.IMG_BOUNDS = {
    north: c.lat + pxSize / 111000 / 2,
    south: c.lat - pxSize / 111000 / 2,
    east:  c.lng + pxSize / 111000 / 2,
    west:  c.lng - pxSize / 111000 / 2,
  };
  state.IMG_OVERLAY = L.imageOverlay(state.IMG_DATAURL, [[state.IMG_BOUNDS.north, state.IMG_BOUNDS.west], [state.IMG_BOUNDS.south, state.IMG_BOUNDS.east]], {
    opacity: parseFloat(document.getElementById('imgOpacity')?.value || 75) / 100,
    interactive: false,
  }).addTo(state.MAP);
  state.IMG_OVERLAY.setZIndex(1);
  applyOverlayRotation(state.IMG_OVERLAY, state.IMG_ROTATION);
  setBanner('Click georef points or arrow keys to align. Press ✓ Commit to save.');
}

function nudgeStep() {
  return (state.MAP?.getZoom() || 14) >= 16 ? 0.0001 : 0.0005;
}

/** Nudge the working overlay (bounds mode). Used by arrow keys. */
function nudgeImage(dLat, dLon) {
  if (!state.IMG_OVERLAY || !state.IMG_BOUNDS) return;
  state.IMG_BOUNDS.north += dLat; state.IMG_BOUNDS.south += dLat;
  state.IMG_BOUNDS.east  += dLon; state.IMG_BOUNDS.west  += dLon;
  state.IMG_OVERLAY.setBounds([[state.IMG_BOUNDS.north, state.IMG_BOUNDS.west], [state.IMG_BOUNDS.south, state.IMG_BOUNDS.east]]);
  applyOverlayRotation(state.IMG_OVERLAY, state.IMG_ROTATION);
}

/** Scale (about center) the working overlay in bounds mode. */
function scaleImage(fLat, fLon) {
  if (!state.IMG_OVERLAY || !state.IMG_BOUNDS) return;
  const cLat = (state.IMG_BOUNDS.north + state.IMG_BOUNDS.south) / 2;
  const cLon = (state.IMG_BOUNDS.east + state.IMG_BOUNDS.west) / 2;
  const hLat = (state.IMG_BOUNDS.north - state.IMG_BOUNDS.south) / 2 * fLat;
  const hLon = (state.IMG_BOUNDS.east - state.IMG_BOUNDS.west) / 2 * fLon;
  state.IMG_BOUNDS.north = cLat + hLat; state.IMG_BOUNDS.south = cLat - hLat;
  state.IMG_BOUNDS.east  = cLon + hLon; state.IMG_BOUNDS.west  = cLon - hLon;
  state.IMG_OVERLAY.setBounds([[state.IMG_BOUNDS.north, state.IMG_BOUNDS.west], [state.IMG_BOUNDS.south, state.IMG_BOUNDS.east]]);
  applyOverlayRotation(state.IMG_OVERLAY, state.IMG_ROTATION);
}

/**
 * Apply scale + rotate around center to a list of {lat, lon, fx, fy}
 * anchor points. Returns the new point list (does not mutate input).
 */
function transformAffinePts(pts, opts) {
  const { rotateDeg = 0, sx = 1, sy = 1 } = opts;
  const cLat = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
  const cLon = pts.reduce((a, p) => a + p.lon, 0) / pts.length;

  let out = pts.map((p) => {
    const lat = cLat + (p.lat - cLat) * sy;
    const lon = cLon + (p.lon - cLon) * sx;
    return { lat, lon, fx: p.fx, fy: p.fy };
  });
  if (rotateDeg) {
    const rad = rotateDeg * Math.PI / 180;
    const cosR = Math.cos(rad), sinR = Math.sin(rad);
    out = out.map((p) => {
      const dLat = p.lat - cLat;
      const dLon = p.lon - cLon;
      return {
        lat: cLat + dLat * cosR - dLon * sinR,
        lon: cLon + dLat * sinR + dLon * cosR,
        fx: p.fx,
        fy: p.fy,
      };
    });
  }
  return out;
}

/** Rotate the working overlay. Routes to affine rotation if applicable. */
function rotateImage(deltaDeg) {
  if (state.IMG_AFFINE && state.IMG_AFFINE_PTS) {
    state.IMG_AFFINE_PTS = transformAffinePts(state.IMG_AFFINE_PTS, { rotateDeg: deltaDeg });
    if (state.IMG_AFFINE) {
      state.IMG_AFFINE.pts = state.IMG_AFFINE_PTS.map((p) => Object.assign({}, p));
      state.IMG_AFFINE.update();
    }
    return;
  }
  if (!state.IMG_OVERLAY) return;
  state.IMG_ROTATION = (state.IMG_ROTATION || 0) + deltaDeg;
  applyOverlayRotation(state.IMG_OVERLAY, state.IMG_ROTATION);
}

// Expose nudgers so map-init's arrow-key handler can call them
window.nudgeImage = nudgeImage;
window.scaleImage = scaleImage;
window.rotateImage = rotateImage;

// ── Georef workflow (3-point affine) ──────────────────────────────────────

function showGeorefCoordBox(step) {
  const box = document.getElementById('georefCoordBox');
  if (!box) return;
  const stepEl = document.getElementById('georefCoordStep');
  if (stepEl) stepEl.textContent = String(step);
  box.style.display = 'block';
  document.getElementById('georefLatIn').value = '';
  document.getElementById('georefLonIn').value = '';
  setTimeout(() => document.getElementById('georefLatIn')?.focus(), 50);
}

function hideGeorefCoordBox() {
  const box = document.getElementById('georefCoordBox');
  if (box) box.style.display = 'none';
}

function endGeorefUI() {
  ['toolbarGeorefGroup', 'nudgeGroup'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

/** Promote a fractional image position + lat/lng to a georef point. */
function commitGeorefMapPoint(lat, lon) {
  if (!window.georefState) return;
  const { pendingFx: fx, pendingFy: fy, step, pts } = window.georefState;
  pts.push({ fx, fy, lat, lon });

  if (pts.length >= 3) {
    applyGeoref(pts);
    window.georefState = null;
    endGeorefUI();
    return;
  }
  window.georefState.step = (step || 1) + 1;
  window.georefState.phase = 'image';
  setBanner(`Pt ${window.georefState.step}/3: click the image at another landmark…`);
}

/**
 * Apply a list of georef points. Routes to the affine (3-point)
 * path when 3 or more points are given; otherwise uses the legacy
 * 2-point axis-aligned projection.
 */
function applyGeoref(p) {
  if (p && p.length >= 3) return applyAffineGeoref(p);

  const [P1, P2] = p;
  if (P1.fx === P2.fx || P1.fy === P2.fy) {
    alert('Points too aligned — pick diagonal landmarks.');
    return;
  }
  const a = (P2.lon - P1.lon) / (P2.fx - P1.fx);
  const b = P1.lon - a * P1.fx;
  const c = (P2.lat - P1.lat) / (P2.fy - P1.fy);
  const d = P1.lat - c * P1.fy;
  state.GEOREF = { a, b, c, d };

  const west = b, east = a * 1 + b, north = d, south = c * 1 + d;
  state.IMG_BOUNDS = { north, south, east, west };

  if (state.IMG_OVERLAY) state.MAP.removeLayer(state.IMG_OVERLAY);
  state.IMG_OVERLAY = L.imageOverlay(state.IMG_DATAURL, [[north, west], [south, east]], {
    opacity: parseFloat(document.getElementById('imgOpacity')?.value || 75) / 100,
    interactive: false,
  }).addTo(state.MAP);
  state.IMG_OVERLAY.setZIndex(1);
  applyOverlayRotation(state.IMG_OVERLAY, state.IMG_ROTATION);
  state.MAP.fitBounds([[north, west], [south, east]], { padding: [20, 20] });
  const nudge = document.getElementById('nudgeGroup');
  if (nudge) nudge.style.display = 'flex';
}

/** 3-point affine georef — preferred for any non-axis-aligned image. */
function applyAffineGeoref(p) {
  if (!state.IMG_DATAURL || !IMG_NATSIZE) { alert('Load a chart image first'); return; }
  const pts = p.slice(0, 3).map((q) => Object.assign({}, q));
  const src = pts.map((q) => ({ x: q.fx * (IMG_NATSIZE.w || 1000), y: q.fy * (IMG_NATSIZE.h || 1000) }));
  const dst = pts.map((q) => state.MAP.latLngToLayerPoint([q.lat, q.lon]));
  if (!solveAffineFrom3(src, dst)) {
    alert('Those 3 points are too close to a straight line. Pick a wider triangle.');
    return;
  }
  if (state.IMG_OVERLAY) { state.MAP.removeLayer(state.IMG_OVERLAY); state.IMG_OVERLAY = null; }
  if (state.IMG_AFFINE)  { state.IMG_AFFINE.remove(); state.IMG_AFFINE = null; }
  state.IMG_AFFINE_PTS = pts;
  state.IMG_AFFINE = createAffineImageOverlay(
    state.IMG_DATAURL, IMG_NATSIZE, state.IMG_AFFINE_PTS,
    parseFloat(document.getElementById('imgOpacity')?.value || 75) / 100,
  );
  state.IMG_BOUNDS = null;
  state.IMG_ROTATION = 0;
  state.MAP.fitBounds(affinePtsBounds(state.IMG_AFFINE_PTS), { padding: [30, 30] });
  const nudge = document.getElementById('nudgeGroup');
  if (nudge) nudge.style.display = 'flex';
  setBanner('3-point chart aligned — use nudge/scale/rotate if needed, then Commit');
  setTimeout(() => setBanner(''), 3000);
}

/**
 * Handle a click on the map during the georef workflow. Two phases:
 *   'image' — user just clicked the chart image; record fractional
 *             position and ask for the matching lat/lng
 *   'map'   — user clicked the satellite map; record that point directly
 */
function handleGeorefClick(e) {
  if (!state.IMG_OVERLAY) { window.georefState = null; endGeorefUI(); return; }

  if (window.georefState.phase === 'image') {
    const ob = state.IMG_OVERLAY.getBounds();
    const fx = (e.latlng.lng - ob.getWest()) / (ob.getEast() - ob.getWest());
    const fy = (ob.getNorth() - e.latlng.lat) / (ob.getNorth() - ob.getSouth());
    window.georefState.pendingFx = fx;
    window.georefState.pendingFy = fy;
    window.georefState.phase = 'map';
    setBanner(`Pt ${window.georefState.step}/3: type coords OR click satellite for same spot…`);
    document.getElementById('map').style.cursor = 'crosshair';
    showGeorefCoordBox(window.georefState.step);
  } else if (window.georefState.phase === 'map') {
    hideGeorefCoordBox();
    commitGeorefMapPoint(e.latlng.lat, e.latlng.lng);
  }
}

window.handleGeorefClick = handleGeorefClick;
window.applyAffineGeoref = applyAffineGeoref;  // used by chart-mosaic.js

// ── Wire image-related toolbar buttons ────────────────────────────────────

function wireButtons() {
  // Drop waypoint at current GPS
  document.getElementById('dropWptBtn')?.addEventListener('click', () => {
    if (!state.GPS_MARKER) { alert('No GPS fix yet'); return; }
    const ll = state.GPS_MARKER.getLatLng();
    const name = prompt('Waypoint name:', `WPT${state.DATA.waypoints.length + 1}`);
    if (name === null) return;
    state.DATA.waypoints.push({ lat: ll.lat, lon: ll.lng, name: name || 'WPT', sym: 'Waypoint' });
    try { window.renderAll?.(); } catch (_) {}
  });

  // Clear working image
  document.getElementById('clearImgBtn')?.addEventListener('click', () => {
    if (state.IMG_OVERLAY) { state.MAP.removeLayer(state.IMG_OVERLAY); state.IMG_OVERLAY = null; }
    if (state.IMG_AFFINE)  { state.IMG_AFFINE.remove(); state.IMG_AFFINE = null; }
    state.IMG_DATAURL = null; state.IMG_BOUNDS = null; IMG_NATSIZE = null;
    state.IMG_ROTATION = 0; state.IMG_AFFINE_PTS = null;
    window.georefState = null; state.ACTIVE_CHART = -1;
    ['toolbarGeorefGroup', 'nudgeGroup'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    const inp = document.getElementById('imgInput');
    if (inp) inp.value = '';
  });

  // 📷 imgBtn: if no charts yet, open file picker; else nudge last saved chart
  document.getElementById('imgBtn')?.addEventListener('click', () => {
    if (state.CHARTS?.length > 0) {
      state.ACTIVE_CHART = state.CHARTS.length - 1;
      // chart-mosaic.showNudgeToolbar will be called from there
      setBanner(`Nudge mode for last saved chart — use arrows or buttons`);
      setTimeout(() => setBanner(''), 2200);
      document.getElementById('nudgeGroup') && (document.getElementById('nudgeGroup').style.display = 'flex');
    } else {
      state.ACTIVE_CHART = -1;
      document.getElementById('imgInput')?.click();
    }
  });

  // Image file picker
  document.getElementById('imgInput')?.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = (ev) => {
      state.IMG_DATAURL = ev.target.result;
      const im = new Image();
      im.onload = () => {
        IMG_NATSIZE = { w: im.width, h: im.height };
        state.IMG_ROTATION = 0; state.IMG_AFFINE_PTS = null;
        if (state.IMG_AFFINE) { state.IMG_AFFINE.remove(); state.IMG_AFFINE = null; }
        state.ACTIVE_CHART = -1;
        const t = document.getElementById('toolbarGeorefGroup');
        if (t) t.style.display = 'flex';
        placeProvisionalOverlay();
      };
      im.src = state.IMG_DATAURL;
    };
    r.readAsDataURL(f);
  });

  // Opacity slider
  document.getElementById('imgOpacity')?.addEventListener('input', (e) => {
    const op = parseFloat(e.target.value) / 100;
    if (state.IMG_OVERLAY) state.IMG_OVERLAY.setOpacity(op);
    if (state.IMG_AFFINE)  { state.IMG_AFFINE.opacity = op; state.IMG_AFFINE.update(); }
  });

  // Georef workflow toggle
  document.getElementById('georefBtn')?.addEventListener('click', () => {
    if (!state.IMG_DATAURL) { alert('Load a chart image first'); return; }
    window.georefState = { phase: 'image', step: 1, pts: [], pendingFx: null, pendingFy: null };
    setBanner('Pt 1/3: click the image at a recognizable landmark…');
    document.getElementById('map').style.cursor = 'crosshair';
  });

  // Georef coordinate-input OK / Cancel / Enter
  document.getElementById('georefCoordOk')?.addEventListener('click', () => {
    const lat = parseFloat(document.getElementById('georefLatIn').value);
    const lon = parseFloat(document.getElementById('georefLonIn').value);
    if (isNaN(lat) || isNaN(lon)) { alert('Enter valid lat/lon numbers'); return; }
    hideGeorefCoordBox();
    commitGeorefMapPoint(lat, lon);
  });

  document.getElementById('georefCoordCancel')?.addEventListener('click', () => {
    hideGeorefCoordBox();
    window.georefState = null;
    endGeorefUI();
  });

  ['georefLatIn', 'georefLonIn'].forEach((id) => {
    document.getElementById(id)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('georefCoordOk').click();
      e.target.style.borderColor = '';
    });
  });
}

wireButtons();
