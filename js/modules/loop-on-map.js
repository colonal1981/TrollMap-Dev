/**
 * THE DAY IS A LOOP, AND IT IS LAID ON THE MAIN MAP.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-10-04, after Pick Water's ticks and three buttons kept handing him something other
 * than a loop: "we keep adding stuff and none of it actually works the way i want", and on the
 * answer -- one button that replaces Pick Water and Generate Smart Plan, not a fifth way -- "lets
 * try it... if i just have to click something and not actually draw an entire route i will give a
 * chance... will it actually still use all of the structure and my catch history to build the loop
 * in areas that are fishy?"
 *
 * So "Plan it as one troll" does this, and nothing else:
 *   1. On a river it hands the day to the river plan (up one bank and back down the other) -- the
 *      loop is a lake thing, the same split Pick Water made (riverHere()).
 *   2. On a lake it reads the water (findWater), lays the loop (trollForMe) and draws it on the MAIN
 *      map at once, with the old plan taken off it, so what is on the screen is never last week's day.
 *   3. A click on the water is where a loop turns -- exactly there, not the middle of some lane -- and
 *      the loop is laid again through it. A click on a numbered turn takes it off. A turn no loop can
 *      reach on water deep enough says so on its marker instead of being dropped quietly.
 *   4. "Build this loop" asks the model for baits, stops and times (buildFromPicked) and the plan
 *      replaces the loop on the map.
 *
 * THE LOOP IS STILL HIS FISH AND THE STRUCTURE. A turn he clicks fixes where that loop turns and
 * nothing else: the depth it rides is the water under his catches of this species (loopLine), the
 * lines out and home stay on it, every other loop of the day is still chosen for the most of his
 * catches and then charted structure (fishBeforeFilling), and the bar says how many of each a loop
 * passes. See plan-troll-loop.js.
 */

import { state } from '../core/state.js';
import { LOOP_COLORS, TRANSIT_COLOR } from './plan-to-timeline.js';
import { turnsReached } from './plan-troll-loop.js';
import { findWater, trollForMe, buildFromPicked, loopForMap, riverHere } from './plan-water-ui.js';

const MAX_TURNS = 4;           // a day is at most four loops (trollLoop's maxPetals)
const S = {
  turns: [],                   // [{ at: [lon, lat], reached, offM }] in the order he clicked them
  key: null,                   // the water and ramp the turns were clicked on
  on: false,                   // the loop is on the map and a click on the water is a turn
  busy: false, again: false,   // laying a loop; and a click came in while it was
  building: false,
  hidOld: false,
  lines: null, marks: null, bar: null, barEl: null, watch: 0, clickTimer: 0, wired: false,
  lineFt: null,
};

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mi = (m) => `${((Number(m) || 0) / 1609.34).toFixed(1)} mi`;
const hours = (min) => {
  const m = Math.round(Number(min) || 0);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The one button. */
export async function planAsOneTroll() {
  if (riverHere()) {
    if (S.on || S.lines || S.hidOld || S.bar) endPreview();     // a lake's loop is not this river's day
    const st = $('smartPlanStatus');
    if (st) st.textContent = 'A river: the day is up one bank and back down the other, so the river plan lays it.';
    $('runSmartPlanBtn')?.click();
    return;
  }
  if (!state.MAP_OK || typeof L === 'undefined') {
    // No map to draw on: the three steps in a row, as before.
    return (await import('./plan-water-ui.js')).trollPlan();
  }
  wire();
  S.building = false;
  showBar();
  hideOldPlan();
  goToMap();
  setBar({ busy: 'Reading the water…' });
  watch(true);
  try {
    const before = loopForMap().pieces;
    await findWater();
    const now = loopForMap();
    // FIND WATER STOPPED (no lake, no pack, a closed season...) and said why on its own status line,
    // the way trollPlan() always told: the water it read is not new. The bar says it, and the old plan
    // goes back on the map.
    if (now.pieces === before || !now.pieces || !now.pieces.length) {
      endPreview({ keepBar: true });
      setBar({ error: now.status || 'Find water stopped without saying why.' });
      return;
    }
    const key = `${now.slug}|${now.rampName}`;
    if (key !== S.key) { S.turns = []; S.key = key; }
    // THE LAKE'S OWN CHART UNDER ITS LOOP, the way picking it on the map draws it: the depth bands the
    // lines ride, and his catch markers judged against this water, so a pin off it is not drawn
    // (catch-plot.js; Ryan, 10/4: "i am seeing fish on land in this area still"). Not awaited.
    if (now.lake) window.loadSupplementalForLake?.(now.lake);
    S.on = true;                // only now is a click on the water a turn
    await relay({ fit: true });
  } finally {
    watch(false);
  }
}

/** Lay the loop through the turns, as often as clicks came in while it was being laid. */
async function relay({ fit = false } = {}) {
  if (S.busy) { S.again = true; return; }
  S.busy = true;
  watch(true);
  try {
    do {
      S.again = false;
      setBar({ busy: S.turns.length ? 'Laying the loop through your turns…' : 'Laying the loop…' });
      drawTurns();
      const loop = await trollForMe({ via: S.turns.map((t) => t.at) });
      const snap = loopForMap();
      if (!loop) {
        if (snap.noWater && !S.turns.length) return laneDayInstead(snap.why);
        clearLines();
        S.turns.forEach((t) => { t.reached = null; });
        drawTurns();
        setBar({ error: snap.why || 'No loop came back.' });
        continue;
      }
      S.lineFt = loop.lineFt;
      const r = turnsReached(S.turns.map((t) => t.at), loop);
      S.turns.forEach((t, i) => { t.reached = r[i].reached; t.offM = r[i].offM; t.passedBy = r[i].passedBy; });
      drawLoop(loop, fit);
      fit = false;
      drawTurns();
      setBar({ loop, snap });
    } while (S.again);
  } finally {
    S.busy = false;
    watch(false);
  }
}

/** No loop can be laid on this water whatever he clicks: the lane plan, and say why. */
function laneDayInstead(why) {
  endPreview();
  const st = $('smartPlanStatus');
  if (st) st.textContent = `No loop here (${why || 'no reason given'}), so this is the lane plan instead.`;
  document.querySelector('#bottomNav button[data-tab="plan"]')?.click();
  $('runSmartPlanBtn')?.click();
}

async function build() {
  if (S.busy || S.building) return;
  S.building = true;
  S.on = false;                 // a click during the build is not a turn
  setBar({ busy: 'Building: baits, stops and times. This is the wait on Claude, about two minutes…' });
  watch(true);
  const before = window._planV2;
  try {
    await buildFromPicked();
  } finally {
    watch(false);
    S.building = false;
  }
  if (window._planV2 && window._planV2 !== before) { setBar({ built: true }); return; }
  // IT DID NOT BUILD: the loop is still his, on the map, with its turns and the button to try again.
  const why = $('wgStatus')?.textContent || 'no reason given';
  const snap = loopForMap();
  if (snap.loop && S.lines) {
    S.on = true;
    setBar({ loop: snap.loop, snap });
    setBar({ note: `The plan did not build: ${why}` });
  } else {
    setBar({ error: `The plan did not build: ${why}` });
  }
}

// ── the map ─────────────────────────────────────────────────────────────────────────────────────

function wire() {
  if (S.wired) return;
  S.wired = true;
  // ANYTHING ELSE THAT DRAWS THE MAP ENDS THE LOOP PREVIEW -- a plan built, a saved plan opened --
  // so a loop being laid can never sit on top of a different day. renderMap() calls this first.
  window.endLoopPreview = () => { if (S.on || S.lines || S.hidOld) endPreview({ keepBar: S.building }); };
  // A DOUBLE CLICK ZOOMS; IT IS NOT TWO TURNS. The click waits a moment to see if a second follows.
  state.MAP.on('click', (e) => {
    if (!S.on || S.building) return;
    if ($('editMode')?.value === 'add') return;     // adding a waypoint
    clearTimeout(S.clickTimer);
    S.clickTimer = setTimeout(() => addTurn([e.latlng.lng, e.latlng.lat]), 260);
  });
  state.MAP.on('dblclick', () => clearTimeout(S.clickTimer));
}

function addTurn(at) {
  if (!S.on || S.building) return;
  if (S.turns.length >= MAX_TURNS) {
    setBar({ note: `A day is at most ${MAX_TURNS} loops, so at most ${MAX_TURNS} turns. Click a number to take one off first.` });
    return;
  }
  S.turns.push({ at, reached: null, offM: null });
  drawTurns();
  relay();
}

function removeTurn(i) {
  if (S.building) return;
  S.turns.splice(i, 1);
  drawTurns();
  relay();
}

function hideOldPlan() {
  S.on = false;
  if (state.LAYER && state.MAP.hasLayer(state.LAYER)) { state.MAP.removeLayer(state.LAYER); S.hidOld = true; }
}

function clearLines() {
  if (S.lines) { S.lines.remove(); S.lines = null; }
}

function endPreview({ keepBar = false } = {}) {
  clearLines();
  if (S.marks) { S.marks.remove(); S.marks = null; }
  if (S.hidOld && state.LAYER) { state.LAYER.addTo(state.MAP); S.hidOld = false; }
  S.on = false;
  if (!keepBar) removeBar();
}

function goToMap() {
  const b = document.querySelector('#bottomNav button[data-tab="map"]');
  if (b && !b.classList.contains('active')) b.click();
}

/** The loop in the colours the built plan will use: out bright, home dashed in the dark twin. */
function drawLoop(loop, fit) {
  clearLines();
  const g = L.layerGroup();
  const ll = (c) => [c[1], c[0]];
  const pts = [];
  if (Array.isArray(loop.cove) && loop.cove.length > 1) {
    L.polyline(loop.cove.map(ll), { color: '#000', weight: 5, opacity: 0.4, interactive: false }).addTo(g);
    L.polyline(loop.cove.map(ll), { color: TRANSIT_COLOR, weight: 2.5, opacity: 0.95, dashArray: '10,7', interactive: false }).addTo(g);
  }
  for (const leg of loop.legs || []) {
    const pair = LOOP_COLORS[leg.petal % LOOP_COLORS.length];
    const home = leg.half === 'back';
    const c = (leg.coords || []).map(ll);
    if (c.length < 2) continue;
    L.polyline(c, { color: '#000', weight: 6, opacity: 0.55, interactive: false }).addTo(g);
    L.polyline(c, { color: home ? pair[1] : pair[0], weight: 3, opacity: 1, interactive: false,
                    ...(home ? { dashArray: '12,6' } : {}) }).addTo(g);
    pts.push(...c);
  }
  if (Array.isArray(loop.ramp)) {
    L.circleMarker(ll(loop.ramp), { radius: 7, color: '#000', weight: 2.5, fillColor: '#ff1744', fillOpacity: 1, interactive: false }).addTo(g);
    pts.push(ll(loop.ramp));
  }
  g.addTo(state.MAP);
  S.lines = g;
  if (fit && pts.length) {
    for (const t of S.turns) pts.push(ll(t.at));
    // Clear of the bar in the top right corner, so the loop is not drawn under it.
    const barW = (S.barEl && S.barEl.offsetWidth) || 0;
    setTimeout(() => {
      state.MAP.invalidateSize();
      state.MAP.fitBounds(pts, { paddingTopLeft: [40, 40], paddingBottomRight: [barW + 50, 40], animate: false });
    }, 120);
  }
}

/** Numbered turns: white where a loop turns, red where none can, outlined while one is being laid. */
function drawTurns() {
  if (S.marks) { S.marks.remove(); S.marks = null; }
  if (!S.turns.length) return;
  const g = L.layerGroup();
  S.turns.forEach((t, i) => {
    const bad = t.reached === false && t.passedBy == null, pending = t.reached == null;
    const bg = bad ? '#ff1744' : '#ffffff', fg = bad ? '#ffffff' : '#0b1622';
    const html = `<div style="width:22px;height:22px;border-radius:50%;background:${bg};color:${fg};`
      + `border:2px ${pending ? 'dashed' : 'solid'} #0b1622;box-shadow:0 0 0 2px rgba(255,255,255,.7);`
      + `font:700 12px/18px system-ui,sans-serif;text-align:center;cursor:pointer">${i + 1}</div>`;
    const m = L.marker([t.at[1], t.at[0]], {
      icon: L.divIcon({ className: '', html, iconSize: [22, 22], iconAnchor: [11, 11] }), keyboard: false,
    });
    const line = S.lineFt != null ? `the ${Math.round(S.lineFt)} ft line` : 'the line';
    const before = S.turns.slice(0, i).some((u) => u.reached);
    const tip = pending ? `Turn ${i + 1}: laying the loop through it…`
      : t.reached === false && t.passedBy != null ? `Turn ${i + 1}: loop ${t.passedBy + 1} already goes past here (${t.offM} m off), so no loop of its own turns here: it would come back over that one.`
      : bad ? (before
        ? `Turn ${i + 1}: no loop gets here without going back over the loop before it, so the day is laid without it.`
        : `Turn ${i + 1}: no loop can get here from the ramp, so the day is laid without it.`)
      : t.offM > 60 ? `Turn ${i + 1}: the loop turns ${t.offM} m from here, at the nearest water on its line (near ${line}).`
      : `Turn ${i + 1}: the loop turns here.`;
    m.bindTooltip(`${esc(tip)}<br><i>Click to take this turn off.</i>`, { direction: 'top', offset: [0, -12] });
    m.on('click', () => removeTurn(i));
    m.addTo(g);
  });
  g.addTo(state.MAP);
  S.marks = g;
}

// ── the bar on the map ──────────────────────────────────────────────────────────────────────────

function showBar() {
  if (S.bar) return;
  const Bar = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const d = L.DomUtil.create('div');
      d.style.cssText = 'background:rgba(11,22,35,.95);color:#e8eff4;border:1px solid rgba(232,239,244,.25);'
        + 'border-radius:10px;padding:10px 12px;max-width:340px;font:12px/1.45 system-ui,sans-serif;'
        + 'box-shadow:0 4px 18px rgba(0,0,0,.45)';
      L.DomEvent.disableClickPropagation(d);
      L.DomEvent.disableScrollPropagation(d);
      d.addEventListener('click', (e) => {
        const a = e.target.closest('[data-lom]');
        if (!a) return;
        const what = a.dataset.lom;
        if (what === 'build') build();
        else if (what === 'plan') document.querySelector('#bottomNav button[data-tab="plan"]')?.click();
        else if (what === 'close') { removeBar(); if (!S.building && !S.busy) endPreview(); }
      });
      return d;
    },
  });
  S.bar = new Bar();
  S.bar.addTo(state.MAP);
  S.barEl = S.bar.getContainer();
}

function removeBar() {
  if (S.bar) { S.bar.remove(); S.bar = null; S.barEl = null; }
}

/** Copy the status line the work writes to into the bar while it runs. */
function watch(on) {
  clearInterval(S.watch);
  S.watch = 0;
  if (!on) return;
  S.watch = setInterval(() => {
    const live = S.barEl && S.barEl.querySelector('[data-lom-live]');
    const src = $('wgStatus');
    if (live && src) live.textContent = src.textContent;
  }, 300);
}

function setBar(o) {
  if (!S.barEl) showBar();
  if (!S.barEl) return;
  const snap = o.snap || loopForMap();
  const head = `<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">`
    + `<b style="font-size:13px">🎣 ${esc(snap.lake || 'Plan it as one troll')}${snap.rampName ? ` from ${esc(snap.rampName)}` : ''}</b>`
    + `<button data-lom="close" title="Close" style="background:none;border:none;color:#9fb3c3;font-size:14px;cursor:pointer;padding:0 2px">✕</button></div>`;
  const hint = '<div style="margin-top:6px;color:#9fb3c3">Not where you want it? <b style="color:#e8eff4">Click the water where a loop '
    + 'should turn</b> and it is laid again through that spot. Click a number to take that turn off.</div>';
  let body = '';
  if (o.busy) {
    body = `<div style="margin-top:6px;color:#ffd54f">${esc(o.busy)}</div>`
      + `<div data-lom-live style="margin-top:4px;color:#9fb3c3;max-height:3.2em;overflow:hidden">${esc($('wgStatus')?.textContent || '')}</div>`;
  } else if (o.error) {
    body = `<div style="margin-top:6px;color:#ff8a80">${esc(o.error)}</div>`
      + (S.on ? (S.turns.length ? '<div style="margin-top:4px;color:#9fb3c3">Take a turn off (click its number) or click somewhere else.</div>' : '') : '');
    if (S.on) body += hint;
  } else if (o.built) {
    body = '<div style="margin-top:6px;color:#69f0ae">Built. Baits, stops and times are on the Plan tab, and the plan is on the map.</div>'
      + '<div style="margin-top:8px;display:flex;gap:6px"><button data-lom="plan" class="primary small">Open the plan</button></div>'
      + '<div style="margin-top:6px;color:#9fb3c3">To change the loop, press Plan it as one troll again: your turns are kept.</div>';
  } else if (o.note) {
    // A NOTE GOES ON TOP OF WHAT IS THERE, so the Build button is not wiped to say it.
    let n = S.barEl.querySelector('[data-lom-note]');
    if (!n) {
      n = document.createElement('div');
      n.setAttribute('data-lom-note', '');
      n.style.cssText = 'margin-top:6px;color:#ffd54f';
      S.barEl.insertBefore(n, S.barEl.children[1] || null);
    }
    n.textContent = o.note;
    return;
  } else if (o.loop) {
    const loop = o.loop;
    const byPetal = (loop.petals || []).map((p, i) => {
      const legs = (loop.legs || []).filter((l) => l.petal === i);
      const out = legs.filter((l) => l.half === 'out').reduce((a, l) => a + l.lengthM, 0);
      const back = legs.filter((l) => l.half === 'back').reduce((a, l) => a + l.lengthM, 0);
      const col = LOOP_COLORS[i % LOOP_COLORS.length][0];
      const s = p.score || {};
      return `<div style="margin-top:3px"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;`
        + `background:${col};margin-right:6px;vertical-align:-1px"></span><b>Loop ${i + 1}</b>`
        // and the shallow edge of its own Contour alarm, which it never goes under
        + `${p.lineFt != null ? ` on ${Math.round(p.lineFt)} ft` : ''}`
        + `${p.edgeFt != null ? `, never under ${Math.round(p.edgeFt)} ft` : ''}: ${mi(out)} out, ${mi(back)} home`
        // Every catch it goes past, the ones an earlier loop passed too -- going round again is the point.
        + ` · past ${s.passes != null ? s.passes : (s.fish || 0)} of your ${esc(snap.species || '')} catches and ${plural(s.structure || 0, 'charted mark')}</div>`;
    }).join('');
    const missed = S.turns.filter((t) => t.reached === false && t.passedBy == null).length;
    // WHICH LINE EACH LOOP RIDES -- his fish's line first, then round the same water a band over.
    const lines = [...new Set((loop.petals || []).map((p) => Math.round(p.lineFt != null ? p.lineFt : loop.lineFt)))];
    body = `<div style="margin-top:6px">${mi(loop.trolledM)} trolled on ${lines.length === 1 ? `the ${lines[0]} ft line`
        : `the ${lines.slice(0, -1).join(', ')} and ${lines[lines.length - 1]} ft lines`}: `
      + `about ${hours(loop.minutes)} of your ${hours(loop.budgetMin)}.</div>`
      + byPetal
      + (missed ? `<div style="margin-top:6px;color:#ff8a80">${missed === 1 ? 'The turn' : `${missed} turns`} in red can't be reached, `
        + `so the day is laid without ${missed === 1 ? 'it' : 'them'} (hover over a number for why).</div>` : '')
      + `<details style="margin-top:6px"><summary style="cursor:pointer;color:#9fb3c3">Why this loop</summary>`
      + `<div style="margin-top:4px;color:#c9d6df;max-height:9em;overflow:auto">${esc(snap.status)}</div></details>`
      + hint
      + '<div style="margin-top:8px"><button data-lom="build" class="primary" style="width:100%;height:34px;font-weight:700">'
      + 'Build this loop</button></div>'
      + '<div style="margin-top:4px;color:#9fb3c3;font-size:11px">Baits, stops and times: about two minutes on Claude.</div>';
  }
  S.barEl.innerHTML = head + body;
}
