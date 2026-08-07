/**
 * contour-data.js — Contour dataset lazy loader + lake selector integration.
 */

import { LAKE_NAME_TO_R2_KEY, resolveR2Key } from '../data/lake-keys.js';
import { viewFilter } from '../utils/viewport-cull.js';
import { addCustomVectorLayer, setVectorListHost } from './custom-vectors.js';

export { LAKE_NAME_TO_R2_KEY, resolveR2Key };

import { state, CF_WORKER_URL } from '../core/state.js';
import { depthColor } from '../utils/depth-palette.js';
import { displayDepth } from './tide-engine.js';
import { isCoastalKey } from '../data/coastal-zones.js';
import { callSafely } from '../utils/call-global.js';

import { cacheGet, cacheSet, cacheClear } from '../utils/db.js';
const CHAIN_DESCRIPTIONS = {
  'lake_thurmond_russell':          'Clarks Hill / Thurmond + Russell Chain',
  'lake_greenwood_secession':       'Lake Greenwood + Secession Chain',
  'lake_monticello_parr':           'Lake Monticello + Parr Reservoir',
  'lake_wateree_fishing_creek':     'Lake Wateree + Fishing Creek',
  'lake_hickory_rhodhiss':          'Lake Hickory + Rhodhiss Chain',
  'lake_norman_mountain_island':    'Lake Norman + Mountain Island Chain',
  'yadkin_river_chain':             'Yadkin River Chain (High Rock → Blewett Falls)',
  'watauga_boone_chain':            'Watauga / Boone Lake Chain',
  // Coastal zones
  'coast_winyah_bay_sc':            'Winyah Bay / Georgetown',
  'coast_murrells_inlet_sc':        'Murrells Inlet / Pawleys Island',
  'coast_santee_delta_sc':          'Santee River Delta / North Inlet',
  'coast_charleston_sc':            'Charleston Harbor',
  // Added 2026-08-04. Cape Romain was in coastal-zones.js, lake_index.json and
  // COASTAL_PRIMARY, and missing from BOTH coastal_catalog.py and this map -- so the
  // zone was offered in the picker, promised every layer by the upload tier, and had
  // no slug -> label entry to fetch contours with. Fourth list it was absent from.
  'coast_cape_romain_sc':           'Cape Romain / Bulls Bay',
  'coast_ace_basin_sc':             'ACE Basin / Edisto',
  'coast_st_helena_sc':             'St. Helena Sound',
  'coast_beaufort_sc':              'Beaufort / Port Royal Sound',
  'coast_hilton_head_sc':           'Hilton Head / Calibogue Sound',
  'coast_savannah_ga':              'Savannah River / Savannah',
  'coast_ossabaw_st_catherines_ga': 'Ossabaw / St. Catherines Sound',
  'coast_sapelo_altamaha_ga':       'Sapelo Sound / Altamaha River',
  'coast_brunswick_st_simons_ga':   'Brunswick / St. Simons Sound',
  'coast_cumberland_st_marys_ga':   'Cumberland Island / St. Marys',
  'coast_brunswick_nc':             'Brunswick County / Shallotte Inlet',
  'coast_cape_fear_nc':             'Cape Fear River / Wilmington',
  'coast_topsail_new_river_nc':     'Topsail Island / New River Inlet',
  'coast_bogue_sound_nc':           'Bogue Sound / Morehead City',
  'coast_core_sound_nc':            'Core Sound / Cape Lookout',
  'coast_pamlico_sound_nc':         'Pamlico Sound / Neuse River',
  'coast_outer_banks_nc':           'Outer Banks / Oregon Inlet',
  'coast_albemarle_sound_nc':       'Albemarle Sound / Elizabeth City',
};

// ── IndexedDB cache ───────────────────────────────────────────────────────────
// Was its own database, `trollmap_contours`, with its own openDB/idbGet/idbSet -- forty lines
// that were also present, near-identically, in supplemental-layers.js and ramps-loader.js.
// Contours are always re-fetchable from R2, so folding into the shared `cache` store needed
// no migration: the worst case is one refetch.
const CACHE_NS  = 'contours';
const CACHE_TTL = 24 * 60 * 60 * 1000;

let changeListeners = [];
let _loadingKey     = null;

export function getActiveContour() {
  return state.ACTIVE_CONTOUR || { smart: null, raw: null };
}

export function onContourChange(fn) {
  changeListeners.push(fn);
}

function notifyChange() {
  // One bad subscriber must not stop the others -- but it also must not disappear. A
  // listener that throws here leaves whatever it renders showing the PREVIOUS lake's
  // contours, which looks like data rather than like a failure.
  changeListeners.forEach((fn, i) => callSafely(fn, `contour change listener #${i}`, state.ACTIVE_CONTOUR));
  window._smartRouteGeoJSON = state.ACTIVE_CONTOUR?.smart || state.ACTIVE_CONTOUR?.raw || null;
}

async function fetchFromR2(r2Key) {
  const url = `${CF_WORKER_URL}/chartpacks/${r2Key}/contours.geojson?v=${Date.now()}`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function loadContourByR2Key(r2Key) {
  if (!r2Key) return;
  if (_loadingKey === r2Key) return;
  _loadingKey = r2Key;

  updateStatusPanel('loading', r2Key);

  try {
    const cached = await cacheGet(CACHE_NS, r2Key, CACHE_TTL);
    if (cached?.features?.length) {
      console.log(`[contour-data] cache hit: ${r2Key} (${cached.features.length} features)`);
      state.ACTIVE_CONTOUR     = { smart: cached, raw: null };
      state.ACTIVE_CONTOUR_KEY = r2Key;
      notifyChange();
      renderContourLayer(true, false);
      updateStatusPanel('loaded', r2Key, cached.features.length);
      _loadingKey = null;
      return;
    }

    console.log(`[contour-data] fetching from R2: ${r2Key}`);
    const gj = await fetchFromR2(r2Key);
    if (!gj?.features?.length) throw new Error('empty response');

    await cacheSet(CACHE_NS, r2Key, gj);
    state.ACTIVE_CONTOUR     = { smart: gj, raw: null };
    state.ACTIVE_CONTOUR_KEY = r2Key;
    notifyChange();
    renderContourLayer(true, false);
    updateStatusPanel('loaded', r2Key, gj.features.length);
    console.log(`[contour-data] loaded ${gj.features.length} features for ${r2Key}`);
  } catch (e) {
    console.warn(`[contour-data] failed to load ${r2Key}:`, e.message);
    updateStatusPanel('error', r2Key, 0, e.message);
  }
  _loadingKey = null;
}

// ── Fuzzy name resolver — handles access-index name variations ────────────────

export async function loadContourForLake(displayName) {
  if (!displayName || displayName.startsWith('river:')) return;
  const r2Key = resolveR2Key(displayName);
  if (!r2Key) {
    console.warn(`[contour-data] no R2 key for lake: "${displayName}"`);
    updateStatusPanel('none', displayName);
    return;
  }
  console.log(`[contour-data] "${displayName}" → ${r2Key}`);
  await loadContourByR2Key(r2Key);
}

// ── Contour layer rendering ───────────────────────────────────────────────────
// The private DEPTH_COLORS table that used to live here is gone. It broke at 10 ft where the
// polygons broke at 11.8 and the soundings at 8, so one depth drew up to three colours
// depending on which layer you were looking at. depth-palette.js owns the ladder now.

// SVG renderer for contour lines — SVG layers sit above canvas in DOM,
// so contours render on top of canvas depth areas automatically.
const _canvasRenderer = L.svg({ padding: 0.5 });

// Zoom threshold below which contour lines are hidden (depth areas still show)
const CONTOUR_MIN_ZOOM = 11;
// Coastal zones are clipped to a RECTANGLE, so their packs carry the open Atlantic out to the
// seaward edge of the box -- 29,676 contours on Murrells Inlet against 7,512 on Wateree, a
// large lake. Until those zones get a real inshore boundary, the linework does not begin until
// the view is small enough for it to mean something. Same floor the facility labels use.
const COASTAL_CONTOUR_MIN_ZOOM = 13;

// Garmin stores depth in DECIMETRES on a nominal 1 ft ladder, so converting to feet lands just
// off a whole number: 3 dm = 0.98 ft, 30 dm = 9.84, 34 dm = 11.15. Two consequences, and the
// second is the one that is easy to miss:
//
//   1. Labels read "29.9" and "34.1" where the plotter reads 30 and 34.
//   2. The round-interval filter below tests `ft % interval`. With ft = 29.9 and interval = 5
//      that is 4.9, so the line is skipped -- and since essentially NO Garmin depth is an exact
//      multiple of 5, zoom levels 12-14 would label almost nothing at all.
//
// Rounding recovers Garmin's own value exactly. The ladder really is whole feet; the fraction is
// only the metric round-trip.
function ftOf(feat) {
  const v = feat?.properties?.depth_ft;
  return (v == null || !Number.isFinite(v)) ? null : Math.round(v);
}

// ── Inline depth labels on contour lines ──────────────────────────────────────
// Depth areas own HOVER (sticky tooltip in supplemental-layers.js); contour lines own
// LABELS. Splitting the two means the fill readout and the line readout never compete
// for the same gesture, and neither needs a click.
//
// Density scales with zoom the way a paper chart does: zoomed out, only the round
// intervals are labelled so the chart stays legible; zoomed in, every contour gets
// numbers. Labels are placed along each line at a pixel interval, so a long contour
// gets several and a short one gets one.
const CONTOUR_LABEL_MIN_ZOOM = 12;
const LABEL_MAX = 400;          // hard ceiling per render; Wateree has ~12k features
// Declutter spacing scales with the font: bigger numbers need more room or they collide.
const LABEL_CLEAR_PX = 56;      // a label is skipped if one already sits this close

// z -> label every N ft. 1 = every contour we have.
function labelIntervalFt(z) {
  if (z >= 16) return 1;
  if (z >= 15) return 2;
  if (z >= 14) return 5;
  return 10;
}
// z -> distance along the line between successive labels, in screen pixels
function labelSpacingPx(z) {
  if (z >= 16) return 150;
  if (z >= 14) return 190;
  return 240;
}
// Chart labels are read at arm's length on a boat, often in sunlight, so these are
// deliberately larger than a typical web map's. Bump CONTOUR_LABEL_SCALE if they are still
// too small -- everything downstream (declutter spacing, halo) scales off the font size.
const CONTOUR_LABEL_SCALE = 1.0;
function labelFontPx(z) { return Math.round((z >= 15 ? 17 : 15) * CONTOUR_LABEL_SCALE); }

let _labelLayer = null;
let _labelCssDone = false;

function ensureLabelCss() {
  if (_labelCssDone) return;
  _labelCssDone = true;
  const s = document.createElement('style');
  // No background, no border: just the number with a white halo, which is how a chart
  // draws it and what keeps it readable over both the fill colours and the line itself.
  s.textContent = `
  /* iconSize is null so Leaflet sets no anchor and the div's top-left lands on the
     point. translate(-50%,-50%) on the span re-centres it on the line regardless of
     how wide the number is, which matters because "8" and "48" differ in width. */
  .contour-lbl { background: none !important; border: none !important; width: 0; height: 0; }
  .contour-lbl span {
    display: inline-block;
    position: absolute;
    left: 0; top: 0;
    font: 700 15px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #0d2b35;
    /* A heavier halo than a web map would use: the numbers sit directly on the contour line
       and over the depth-area fill, and a thin halo disappears against the mid-tone bands. */
    text-shadow: 0 0 4px #fff, 0 0 4px #fff, 0 0 3px #fff, 0 0 3px #fff, 0 0 2px #fff;
    white-space: nowrap;
    pointer-events: none;
    user-select: none;
  }`;
  document.head.appendChild(s);
}

function _ringsOf(geom) {
  if (!geom) return [];
  if (geom.type === 'LineString') return [geom.coordinates];
  if (geom.type === 'MultiLineString') return geom.coordinates;
  if (geom.type === 'Polygon') return geom.coordinates;
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat();
  return [];
}

/**
 * Place depth numbers along the contour lines currently in view.
 *
 * Everything here is viewport-culled and capped. Wateree alone is ~12k contour
 * features; placing a marker per feature would stall the map, so labels are only
 * generated for lines whose points fall inside the padded viewport, spaced along the
 * line in pixel space, and dropped when they would collide with one already placed.
 */
function renderContourLabels(layers) {
  if (!state.MAP_OK || !state.MAP) return;
  ensureLabelCss();
  if (_labelLayer) { state.MAP.removeLayer(_labelLayer); _labelLayer = null; }

  const map = state.MAP;
  const zoom = map.getZoom();
  if (zoom < CONTOUR_LABEL_MIN_ZOOM) return;

  const interval = labelIntervalFt(zoom);
  const spacing  = labelSpacingPx(zoom);
  const font     = labelFontPx(zoom);
  const bounds   = map.getBounds().pad(0.15);

  const placed = [];                    // screen points of labels already drawn
  const group  = L.layerGroup();
  let count = 0;

  const farEnough = (p) => {
    for (let i = 0; i < placed.length; i++) {
      const q = placed[i];
      if (Math.abs(q.x - p.x) < LABEL_CLEAR_PX && Math.abs(q.y - p.y) < LABEL_CLEAR_PX) return false;
    }
    return true;
  };

  for (const { gj, dashed } of layers) {
    if (dashed) continue;                            // never label the raw overlay
    const feats = gj?.features;
    if (!feats?.length) continue;

    for (const feat of feats) {
      if (count >= LABEL_MAX) break;
      const ft = ftOf(feat);
      if (ft == null) continue;
      // Round intervals only, until the zoom is close enough to carry every line.
      if (interval > 1 && ft % interval !== 0) continue;

      for (const ring of _ringsOf(feat.geometry)) {
        if (count >= LABEL_MAX) break;
        if (!ring || ring.length < 2) continue;

        // Project once per ring, culling by the padded viewport as we go.
        let pts = null;
        for (let i = 0; i < ring.length; i++) {
          const c = ring[i];
          if (bounds.contains([c[1], c[0]])) { pts = ring; break; }
        }
        if (!pts) continue;

        const scr = new Array(pts.length);
        for (let i = 0; i < pts.length; i++) {
          scr[i] = map.latLngToLayerPoint([pts[i][1], pts[i][0]]);
        }

        let acc = spacing * 0.5;                      // first label part-way in
        for (let i = 1; i < scr.length && count < LABEL_MAX; i++) {
          const a = scr[i - 1], b = scr[i];
          const dx = b.x - a.x, dy = b.y - a.y;
          const seg = Math.hypot(dx, dy);
          if (seg < 1e-6) continue;
          acc += seg;
          if (acc < spacing) continue;
          acc = 0;

          const mid = L.point((a.x + b.x) / 2, (a.y + b.y) / 2);
          if (!farEnough(mid)) continue;
          const ll = map.layerPointToLatLng(mid);
          if (!bounds.contains(ll)) continue;

          // Align the number to the line, but never let it read upside down.
          let deg = Math.atan2(dy, dx) * 180 / Math.PI;
          if (deg > 90) deg -= 180;
          if (deg < -90) deg += 180;

          const icon = L.divIcon({
            className: 'contour-lbl',
            html: `<span style="font-size:${font}px;transform:translate(-50%,-50%) rotate(${deg.toFixed(1)}deg)">${ft}</span>`,
            iconSize: null,
          });
          // interactive:false so a label can never swallow the depth-area hover beneath it
          L.marker(ll, { icon, interactive: false, keyboard: false, zIndexOffset: 500 })
            .addTo(group);
          placed.push(mid);
          count++;
        }
      }
    }
  }

  if (count) { _labelLayer = group; group.addTo(map); }
}

export function clearContourLabels() {
  if (_labelLayer && state.MAP) { state.MAP.removeLayer(_labelLayer); }
  _labelLayer = null;
}

export function renderContourLayer(showSmart = true, showRaw = false) {
  if (!state.MAP_OK) return;
  if (state.CONTOUR_LAYER) state.MAP.removeLayer(state.CONTOUR_LAYER);
  state.CONTOUR_LAYER = L.layerGroup().addTo(state.MAP);

  const contour = state.ACTIVE_CONTOUR;
  if (!contour) return;

  // Below CONTOUR_MIN_ZOOM, hide contour lines — depth area polygons carry the visual at low zoom
  const zoom = state.MAP.getZoom();
  const floor = isCoastalKey(state.ACTIVE_CONTOUR_KEY) ? COASTAL_CONTOUR_MIN_ZOOM
                                                       : CONTOUR_MIN_ZOOM;
  if (zoom < floor) { clearContourLabels(); return; }

  const smoothFactor = zoom >= 14 ? 0.5 : zoom >= 12 ? 1.0 : 1.5;

  const layers = [];
  if (showSmart && contour.smart) layers.push({ gj: contour.smart, dashed: false });
  if (showRaw   && contour.raw)   layers.push({ gj: contour.raw,   dashed: true  });

  // Draw what is on screen, not what is in the file. See js/utils/viewport-cull.js.
  const inView = viewFilter(state.MAP);
  for (const { gj, dashed } of layers) {
    if (!gj?.features?.length) continue;
    const shown = inView ? gj.features.filter(inView) : gj.features;
    if (!shown.length) continue;
    L.geoJSON({ ...gj, features: shown }, {
      renderer: _canvasRenderer,
      smoothFactor,
      style(feat) {
        // Two changes from the old `ftOf(feat) ?? 0`:
        //   - No `?? 0`. Zero is the shallowest, reddest band, so a contour with no depth
        //     recorded was drawn as "you are aground here". depthColor() answers white for
        //     null, which is what unsurveyed water should look like.
        //   - Tide correction, in coastal zones only. A charted MLLW depth understates the
        //     actual water by the tide height, and the contour has to move with the polygon
        //     under it and the sounding on top of it or the three disagree on screen.
        const shown = displayDepth(ftOf(feat), isCoastalKey(state.ACTIVE_CONTOUR_KEY));
        return { color: depthColor(shown), weight: 1.5, opacity: 0.85, dashArray: dashed ? '4,4' : null };
      },
      onEachFeature(feat, layer) {
        // Depth now reads off the inline labels drawn below, so no gesture is required.
        // The click popup is kept only as a fallback for lines the label pass skipped
        // (a contour off the round interval, or one decluttered away in a busy spot).
        const d = ftOf(feat);
        const name = feat.properties?.name;
        const tip = name ? name : (d != null ? `${d} ft` : null);
        if (tip) layer.bindPopup(tip, { closeButton: false, className: 'contour-popup' });
      },
    }).addTo(state.CONTOUR_LAYER);
  }

  renderContourLabels(layers);

  // Depth areas stay beneath contours — do NOT call bringDepthAreasToBack() here.
}

// Re-render contour lines on zoom changes so threshold gating takes effect
function _wireZoomHandler() {
  if (!state.MAP_OK || !state.MAP) { setTimeout(_wireZoomHandler, 500); return; }
  state.MAP.on('zoomend', () => {
    const showLayer = document.getElementById('cdShowContourLayer')?.checked !== false;
    if (showLayer && state.ACTIVE_CONTOUR) renderContourLayer(true, false);
  });
  // Labels are viewport-culled, so a pan leaves the newly exposed water unlabelled and
  // keeps stale labels off-screen. Re-place them on pan — but only the labels, not the
  // contour geometry, which is the expensive part and does not change when panning.
  // Geometry is now viewport-culled too, so a pan changes WHICH lines exist, not just where
  // the labels sit. Re-render the lines as well -- that used to be "the expensive part that
  // does not change when panning", and with culling it is neither expensive nor unchanged.
  let panTimer = null;
  state.MAP.on('moveend', () => {
    const showLayer = document.getElementById('cdShowContourLayer')?.checked !== false;
    const contour = state.ACTIVE_CONTOUR;
    if (!showLayer || !contour) return;
    clearTimeout(panTimer);
    panTimer = setTimeout(() => { renderContourLayer(true, false); }, 120);
  });
}
_wireZoomHandler();

function updateStatusPanel(status, key, count = 0, errMsg = '') {
  const el = document.getElementById('cdActiveInfo');
  if (!el) return;
  const label = CHAIN_DESCRIPTIONS[key] || key?.replace(/_/g, ' ') || key || '—';
  if (status === 'loading') {
    el.innerHTML = `<div style="color:var(--accent)">⏳ Loading ${label}...</div>`;
  } else if (status === 'loaded') {
    el.innerHTML = `<div style="color:var(--accent2);font-weight:600;margin-bottom:3px">✅ ${label}</div><div style="color:var(--muted)">${count.toLocaleString()} contour features</div>`;
  } else if (status === 'error') {
    el.innerHTML = `<div style="color:var(--warn);font-weight:600">❌ Failed to load ${label}</div><div style="color:var(--muted);font-size:10px">${errMsg}</div><div style="color:var(--muted);font-size:10px">Check R2 upload or try local file</div>`;
  } else if (status === 'none') {
    el.innerHTML = `<div style="color:var(--muted)">No contour data for ${label}</div>`;
  } else {
    el.innerHTML = `<div style="color:var(--muted)">No contour data loaded</div>`;
  }
}

export function buildContourDataPanel(container) {
  container.innerHTML = `
    <div style="margin-bottom:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Active contour data</div>
      <div id="cdActiveInfo" style="font-size:11px;color:var(--muted);background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:8px">Select a lake to load contours</div>
      <button id="cdClearContours" style="margin-top:6px;width:100%;height:28px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;cursor:pointer">✕ Clear contours</button>
    </div>
    <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Show on map</div>
      <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text)"><input type="checkbox" id="cdShowContourLayer" checked> Show depth contours</label>
    </div>
    <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Load local file</div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:6px">QDC exports, pipeline output, or any contours.geojson</div>
      <label style="display:block;width:100%;cursor:pointer">
        <div style="width:100%;height:28px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;display:flex;align-items:center;justify-content:center;cursor:pointer;box-sizing:border-box">📂 Load local .geojson</div>
        <input type="file" id="cdLocalFile" accept=".geojson,.json" style="display:none">
      </label>
    </div>
    <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Load raw QDC folder</div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:6px">Point directly at a Quickdraw C (Community) or U (User) folder — decoded in-browser, no external tool needed</div>
      <select id="cdQdcLayer" style="width:100%;height:26px;font-size:11px;background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:5px;margin-bottom:6px">
        <option value="1" selected>Layer 1 - Recommended</option>
        <option value="0">Layer 0 - Raw (finest)</option>
        <option value="2">Layer 2</option>
        <option value="3">Layer 3</option>
        <option value="4">Layer 4</option>
        <option value="5">Layer 5 - Coarsest</option>
      </select>
      <label style="display:block;width:100%;cursor:pointer">
        <div style="width:100%;height:28px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;display:flex;align-items:center;justify-content:center;cursor:pointer;box-sizing:border-box">📂 Load QDC folder</div>
        <input type="file" id="cdQdcFolder" webkitdirectory multiple style="display:none">
      </label>
      <div id="cdQdcStatus" style="font-size:10px;color:var(--muted);margin-top:6px"></div>
    </div>
    <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Imported layers</div>
      <div id="vectorLayerList"><p style="color:var(--muted);font-size:11px;margin:0">No imported layers.</p></div>
    </div>
    <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Cache</div>
      <button id="cdClearCache" style="width:100%;height:28px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;cursor:pointer">🗑 Clear contour cache (force re-fetch)</button>
    </div>
  `;

  document.getElementById('cdClearContours')?.addEventListener('click', () => {
    state.ACTIVE_CONTOUR = null; state.ACTIVE_CONTOUR_KEY = null;
    if (state.CONTOUR_LAYER) state.MAP?.removeLayer(state.CONTOUR_LAYER);
    state.CONTOUR_LAYER = null;
    clearContourLabels();          // labels live in their own layer group
    notifyChange(); updateStatusPanel('idle');
  });

  // The imported-layer list is rendered by custom-vectors.js into whatever host it is given.
  // It owns the layers; this panel only owns a place to put the list.
  setVectorListHost(document.getElementById('vectorLayerList'));

  document.getElementById('cdShowContourLayer')?.addEventListener('change', e => {
    if (e.target.checked) { renderContourLayer(true, false); window.toggleDepthAreas?.(true); }
    else if (state.CONTOUR_LAYER) {
      state.MAP?.removeLayer(state.CONTOUR_LAYER);
      clearContourLabels();        // otherwise the numbers hang in mid-air with no lines
      window.toggleDepthAreas?.(false);
    }
  });

  // ONE PICKER, AND IT DECIDES. Ryan, 2026-08-07: "i would prefer the merge... 1 picker and it
  // chooses what to do with it." This used to load every file as contours and there was a second
  // picker, in a different panel, for everything else.
  //
  // The test is on the CONTENT, never the filename. `contours.geojson` is a convention, not a
  // guarantee, and the whole point of one picker is that you do not have to know which kind of
  // file you are holding before you open it.
  //
  // A contour file is LineStrings carrying a depth. Anything else -- a track, a waypoint set,
  // someone else's marks, polygons -- becomes an imported vector layer.
  document.getElementById('cdLocalFile')?.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const gj = JSON.parse(await file.text());
      if (!gj?.features?.length) throw new Error('no features found');

      const DEPTH_KEYS = ['depth_ft', 'depth_dm', 'depth_m', 'depth', 'ft', 'DEPTH'];
      const lines = gj.features.filter(f => f.geometry?.type?.includes('Line'));
      const withDepth = lines.filter((f) => {
        const p = f.properties || {};
        // Present and numeric. `p.depth_ft != null` alone would accept '' and let
        // Number('') === 0 tag the whole file as a 0 ft contour set.
        return DEPTH_KEYS.some(k => p[k] !== null && p[k] !== undefined && p[k] !== ''
                                    && Number.isFinite(Number(p[k])));
      });
      const isContours = withDepth.length >= Math.max(1, gj.features.length * 0.5);

      if (isContours) {
        state.ACTIVE_CONTOUR = { smart: gj, raw: null };
        state.ACTIVE_CONTOUR_KEY = file.name;
        notifyChange(); renderContourLayer(true, false);
        updateStatusPanel('loaded', file.name, gj.features.length);
      } else {
        // Say which branch was taken. A file that silently loads as the wrong kind is worse
        // than one that gets rejected, because nothing on screen contradicts it.
        addCustomVectorLayer(file.name.replace(/\.[^.]+$/, ''), gj);
        updateStatusPanel('loaded', file.name + ' → vector layer', gj.features.length);
      }
    } catch (err) { alert('Could not parse GeoJSON: ' + err.message); }
    e.target.value = '';
  });

  document.getElementById('cdQdcFolder')?.addEventListener('change', async e => {
    const allFiles = Array.from(e.target.files);
    const qdcFiles = allFiles.filter(f => f.name.toLowerCase().endsWith('.qdc'));
    const statusEl = document.getElementById('cdQdcStatus');

    if (!qdcFiles.length) {
      if (statusEl) statusEl.textContent = 'No .qdc files found in selected folder.';
      e.target.value = '';
      return;
    }

    const layer = parseInt(document.getElementById('cdQdcLayer')?.value) || 1;
    if (statusEl) statusEl.textContent = `Found ${qdcFiles.length} QDC files. Decoding...`;

    try {
      const { parseQDCFolder, buildDepthGrid, contourGrid } = await import('./qdc-decoder.js');

      const pts = await parseQDCFolder(qdcFiles, layer, (cur, total, stage) => {
        if (statusEl) statusEl.textContent = `${stage}: ${cur}/${total}`;
      });
      if (statusEl) statusEl.textContent = `Decoded ${pts.length} depth points. Building contours...`;

      const gridGeo = buildDepthGrid(pts, 140, true, true);
      if (!gridGeo) throw new Error('Grid build failed — check point spread/density.');

      const contourFC = contourGrid(gridGeo, 2, 4, 120);
      if (!contourFC.features.length) throw new Error('No contour lines generated.');

      const key = `qdc:${qdcFiles.length}files`;
      state.ACTIVE_CONTOUR = { smart: contourFC, raw: null };
      state.ACTIVE_CONTOUR_KEY = key;
      notifyChange(); renderContourLayer(true, false);
      updateStatusPanel('loaded', key, contourFC.features.length);

      if (statusEl) statusEl.textContent = `Done — ${contourFC.features.length} contour lines from ${pts.length} points.`;
    } catch (err) {
      if (statusEl) statusEl.textContent = `Error: ${err.message}`;
      console.error('[contour-data] QDC decode/contour error', err);
    }
    e.target.value = '';
  });

  document.getElementById('cdClearCache')?.addEventListener('click', async () => {
    const btn = document.getElementById('cdClearCache');
    btn.textContent = 'Clearing...'; btn.disabled = true;
    // cacheClear drops only this namespace. The old code called objectStore.clear() on a
    // database it had to itself; the shared store holds other callers' entries too, and
    // "clear contour cache" must not take the ramp list with it.
    const ok = await cacheClear(CACHE_NS);
    if (ok) {
      btn.textContent = '✅ Cache cleared';
      setTimeout(() => { btn.textContent = '🗑 Clear contour cache (force re-fetch)'; btn.disabled = false; }, 2000);
    } else {
      btn.textContent = '❌ Failed'; btn.disabled = false;
    }
  });

  const c = state.ACTIVE_CONTOUR;
  const count = c?.smart?.features?.length || c?.raw?.features?.length || 0;
  if (count && state.ACTIVE_CONTOUR_KEY) updateStatusPanel('loaded', state.ACTIVE_CONTOUR_KEY, count);
}

onContourChange(() => {
  const c = state.ACTIVE_CONTOUR;
  const count = c?.smart?.features?.length || c?.raw?.features?.length || 0;
  if (count && state.ACTIVE_CONTOUR_KEY) updateStatusPanel('loaded', state.ACTIVE_CONTOUR_KEY, count);
  const showLayer = document.getElementById('cdShowContourLayer')?.checked !== false;
  if (showLayer) { renderContourLayer(true, false); window.toggleDepthAreas?.(true); }
});

window.loadContourForLake = loadContourForLake;

export async function loadContourDataset(key) { return loadContourByR2Key(key); }

console.log('[contour-data] module ready — 67 lakes + 21 coastal zones mapped');