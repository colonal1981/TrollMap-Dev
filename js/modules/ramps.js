/**
 * ramps.js -- THE LAUNCH LAYER. One marker per landing, from one source.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * ONE SOURCE, 2026-09-22. Ryan: *"right now i have a button that says garmin POI that shows
 * what you are seeing... another that says ramps... and then the ramp dropdown... and none of
 * that reads from the same source"*. He was right, and it was worse than three sources:
 *
 *   #btnRamps      this file        worker /ramps       deduped by utils/dedupe.js
 *   #btnPaddle     gis-toggles.js   worker /paddle      no dedupe
 *   #btnBankPier   gis-toggles.js   worker /bank-pier   no dedupe
 *   #btnPOI        supplemental     pois.geojson + ALL 2,041 /ramps rows injected at runtime
 *   #rampSelect    lake-ramp-select access-index + launches.json, deduped properly
 *
 * Four feeds, four label sites, none deduped against another. /ramps carries "Lake Wateree
 * State Park" and /bank-pier carries "Lake Wateree State Park Bank" 52 m away, so the name
 * drew twice at two sizes; /ramps and /bank-pier both carry "Molly Creek Access Area Boat
 * Ramp" at the IDENTICAL coordinate. And utils/dedupe.js -- now deleted -- treated any two
 * ramps within 0.006 deg (~667 m) as duplicates REGARDLESS OF NAME, which silently removed 85
 * real named ramps from this layer: the Monticello Subimpoundment, Taw Caw Park, Bushy Park -
 * Fresh Water, Saluda Shoals Park. See
 * claude/FIVE_SURFACES_FOUR_FEEDS_AND_EIGHTY_FIVE_RAMPS_DELETED_2026-09-22.md.
 *
 * So all three map buttons now draw the SAME list the Access dropdown is built from --
 * access-index.js, deduped once by sameLanding() (11 m by position, 180 m for a shared name).
 * The buttons became FILTERS rather than feeds.
 *
 * EXACTLY ONE LAYER DRAWS A GIVEN LANDING. Molly Creek is a ramp AND a pier AND is filed by two
 * feeds; with three independent layers it got three pins the moment two buttons were on. Here a
 * landing is drawn by the highest-precedence button that is CURRENTLY ON -- ramp, then paddle,
 * then bank -- so turning the Kayak layer on never doubles a pin, and turning the Ramps layer
 * OFF hands its paddle-capable landings down to Kayak rather than hiding them.
 *
 * THE PACK'S OWN LANDINGS COME TOO, for the selected water. launches.json carries the landings
 * no state feed lists -- Buckhill Landing, which Ryan named himself, is osm+places+ryan -- and
 * until now they reached the dropdown and never the map. Same collapse, same rule.
 */

import { state } from '../core/state.js';
import { registerLayer, wireButton, toggle, show, isVisible } from '../core/layer-registry.js';
import { esc } from '../utils/escape.js';
import { loadAccessIndex, allAccessPoints, accessKinds, sameLanding } from '../data/access-index.js';
import { launchReach, reachLabel } from '../data/launch-reach.js';
import { attachRampCameras } from './ramp-cameras.js';

// Highest precedence first. A landing is drawn once, by the first of these whose button is on.
const KINDS = ['ramp', 'paddle', 'bank'];

// Ryan, 2026-09-25: "the ramp text color is green on a green satellite image... i can't see them".
// The ramp label's text was #062d00, a near-black GREEN, and over satellite tree cover it read as
// part of the trees. Black, like the paddle label's: the box carries the colour, the text is ink.
const STYLE = {
  ramp:   { id: 'ramps',    button: 'btnRamps',    icon: '\u26f5', bg: '#00e5ff', fg: '#000000', edge: '#007a8a' },
  paddle: { id: 'paddle',   button: 'btnPaddle',   icon: '\u{1F6F6}', bg: '#ffb703', fg: '#000000', edge: '#b06a00' },
  bank:   { id: 'bankPier', button: 'btnBankPier', icon: '\u{1F3A3}', bg: '#0e7c7b', fg: '#ffffff', edge: '#ffffff' },
};

let ROWS = null;          // the collapsed list, or null until the index resolves
let ROWS_WATER = '';      // which water's pack landings are folded into ROWS

function currentWater() {
  return document.getElementById('lakeSelect')?.value || '';
}

/**
 * The one list. Live four-state access index, plus the selected water's pack landings,
 * collapsed through the same sameLanding() the dropdown uses.
 */
function rows() {
  const water = currentWater();
  if (ROWS && ROWS_WATER === water) return ROWS;
  const live = allAccessPoints();
  const out = live.map((p) => ({ ...p, kinds: accessKinds(p) }));
  // The pack's landings for the water on screen. launchReach() is synchronous-with-cache and
  // returns [] on a miss, which is the normal case for a water with no pack -- not an error.
  for (const r of (water ? launchReach(water, () => { ROWS = null; redrawAll(); }) : [])) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    if (sameLanding(out, r)) continue;
    out.push({ name: reachLabel(r), lat: r.lat, lon: r.lon,
               typeLabel: 'reaches this water', sourcePath: 'launches.json',
               launch: true, kinds: ['ramp'], filedUnder: r.filed || [] });
  }
  ROWS = out;
  ROWS_WATER = water;
  return out;
}

/** Which button owns this landing right now: the first ON layer among its kinds, or ''. */
function drawnBy(row) {
  for (const k of KINDS) {
    if (row.kinds.includes(k) && isVisible(STYLE[k].id)) return k;
  }
  return '';
}

function markerFor(row, kind) {
  const st = STYLE[kind];
  const osmUrl = `https://www.openstreetmap.org/?mlat=${row.lat}&mlon=${row.lon}&zoom=17`;
  const where = (row.filedUnder || []).join(', ');
  const marker = L.marker([row.lat, row.lon], {
    icon: L.divIcon({
      className: 'custom-gis-marker',
      html: `<div style="
          background:${st.bg};color:${st.fg};font-size:11px;font-weight:700;
          padding:2px 6px;border-radius:4px;border:2px solid ${st.edge};
          white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.5);cursor:pointer;
        ">${st.icon} ${esc(row.name)}</div>`,
      iconAnchor: [0, 8],
    }),
  });
  marker.bindPopup(`
    <b>${esc(row.name)}</b><br>
    <span style="color:#aed581;font-size:12px">${esc(row.typeLabel || '')}</span><br>
    ${where ? `<span style="color:#9ecbff;font-size:11px">${esc(where)}</span><br>` : ''}
    <span style="font-family:monospace;font-size:11px">${row.lat.toFixed(5)}, ${row.lon.toFixed(5)}</span><br>
    <a href="${osmUrl}" target="_blank" style="font-size:12px;display:block;margin-top:4px">\u{1F5FA} Verify on OpenStreetMap \u2197</a>
    <button onclick="window.enableSpotRepositioning(this, '${esc(row.name).replace(/'/g, "\\'")}')" class="small warn" style="margin-top:8px">\u2725 Re-Position Launch Spot</button>
    <div class="ramp-cam"></div>
  `);
  // Filled on OPEN, not on build: redraw() runs on every map move and rebuilds every marker in
  // view, so fetching a frame at build time would fire a request per visible ramp per pan.
  marker.on('popupopen', (ev) => {
    const el = ev.popup && ev.popup.getElement ? ev.popup.getElement() : null;
    if (el) attachRampCameras(el, row);
  });
  return marker;
}

const GROUPS = {};        // kind -> L.layerGroup

function redraw(kind) {
  const group = GROUPS[kind];
  if (!state.MAP_OK || !group || !isVisible(STYLE[kind].id)) return;
  group.clearLayers();
  const bounds = state.MAP.getBounds().pad(0.5);
  let n = 0;
  for (const row of rows()) {
    if (drawnBy(row) !== kind) continue;
    if (!bounds.contains([row.lat, row.lon])) continue;
    group.addLayer(markerFor(row, kind));
    n++;
  }
  return n;
}

/**
 * Every visible kind, because precedence is shared state.
 *
 * Turning Ramps off does not only empty the ramp layer -- every landing it was holding that is
 * ALSO a paddle launch now belongs to Kayak, and Kayak has to be told. Redrawing only the layer
 * whose button moved is how a landing disappears from a map that is still showing its kind.
 */
function redrawAll() {
  for (const k of KINDS) redraw(k);
  window.__rampsLayerVisible = isVisible('ramps');
  window.dispatchEvent(new CustomEvent('trollmap:rampsToggled'));
}

for (const kind of KINDS) {
  const st = STYLE[kind];
  registerLayer({
    id: st.id,
    button: st.button,
    enabled: () => !!state.MAP_OK,
    build: () => {
      const group = L.layerGroup();
      GROUPS[kind] = group;
      if (state.MAP_OK) state.MAP.on('moveend', () => redraw(kind));
      return group;
    },
    onShow: () => redrawAll(),
    onHide: () => redrawAll(),
  });
}

// The index is a network fetch and the buttons can be pressed before it lands. Drop the cache
// and redraw whatever is on once it does, rather than leaving an empty layer that looks like
// "there is nothing here".
loadAccessIndex().then(() => { ROWS = null; redrawAll(); }).catch(() => {});
document.getElementById('lakeSelect')?.addEventListener('change', () => { ROWS = null; redrawAll(); });

/** Kept as exports: they were public API before the registry and callers may still exist. */
export function toggleRampLayer() { return toggle('ramps'); }
export function buildRampLayer() { return show('ramps'); }

export function toggleChartLayersPanel() {
  const wrap = document.getElementById('chartLayersWrap');
  const btn = document.getElementById('btnChartLayers');
  if (!wrap) return;
  const visible = wrap.style.display !== 'none';
  wrap.style.display = visible ? 'none' : 'block';
  if (btn) {
    btn.style.background = visible ? '' : 'var(--accent)';
    btn.style.color = visible ? '' : '#000';
  }
}

function wireButtons() {
  for (const kind of KINDS) wireButton(STYLE[kind].id);
  document.getElementById('btnChartLayers')?.addEventListener('click', toggleChartLayersPanel);
  document.getElementById('closeChartLayersBtn')?.addEventListener('click', () => {
    const wrap = document.getElementById('chartLayersWrap');
    const btn = document.getElementById('btnChartLayers');
    if (wrap) wrap.style.display = 'none';
    if (btn) { btn.style.background = ''; btn.style.color = ''; }
  });
}

wireButtons();
