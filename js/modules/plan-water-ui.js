/**
 * plan-water-ui.js — the Water tab. The screen where the fisherman chooses.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ONE THING THIS FILE IS FOR
 *
 *   > the problem is you keep coding things that should be decided by the conditions not by some
 *   > algorithm
 *
 * So nothing here picks water. It draws what `plan-water.js` measured, writes the reasons beside
 * it, keeps a running total of what the day costs, and gets out of the way. The only thing it
 * ever refuses is the battery, because that is the only thing Ryan said should be able to refuse:
 *
 *   > if they are going to run out of battery because of choice they shouldn't be able to make
 *   > that choice
 *
 * Everything else — a long day, a piece with nothing on it, water outside the band — is said out
 * loud and left to him.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ALL DOM KNOWLEDGE LIVES HERE
 *
 * `plan-water.js` has no `document` in it and runs its whole path in a test. This file is the
 * boundary. It also owns every piece of SVG, which is where the last version of this went wrong:
 *
 *   `stroke-linecap=round/>` — HTML allows `/` inside an unquoted attribute value, so the tag
 *   never self-closed and 287 paths nested inside one another. It rendered as a single line and
 *   cost an hour of reasoning that one look at getBBox() would have settled.
 *
 * EVERY ATTRIBUTE IN THIS FILE IS QUOTED. Not a style preference — an unquoted one has already
 * eaten an afternoon.
 */

import { state, CF_WORKER_URL } from '../core/state.js';
import { resolveR2Key } from '../data/lake-keys.js';
import { getSeason, seasonNote } from '../data/species-intel.js';
import { depthBandFor, usableAhFrom, researchIntel, researchHazards, describeDepthBand }
  from './plan-inputs.js';
import { packFetcher } from './smart-plan-v2.js';
import { fetchForecast, fetchWaterState } from './plan-preflight.js';
import { depthSampler, shorelineIndex, waterMask } from './plan-water-index.js';
import { offerWater, dayCost, priceSpots, searchOrder, optionality, reasons, TROLL_MPH, TRANSIT_MIN_DEPTH_FT, SPOT_KINDS } from './plan-water.js';
import { joinedPiece } from './plan-pieces.js';
import { planFromWater } from './plan-from-water.js';
import { buildSmartPlanV2, modelAsker, waterRouter } from './smart-plan-v2.js';
import { poiSpotFeatures, attractorSpotFeatures, dockSpotFeatures, chartedGrid, chartedHazards }
  from './plan-candidates.js';
import { planToTimeline, installTimeline } from './plan-to-timeline.js';
import { renderSmartPlanUI, syncSpread } from './smart-plan-ui.js';
import { materialisePlan } from './plan-tracks.js';
import { loadSessionFromPlan, isEnabled, launchFrom } from './notifications.js';
import { renderAll } from '../core/map-init.js';
import { TACKLE_INVENTORY } from '../data/tackle-inventory.js';
import { connectionFor, snapEligibleFrom } from '../data/lure-knowledge.js';
import { readInputs, rampCoords, loadResearchedProfile } from './smart-plan-v2-wiring.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mi = (m) => m / 1609.34;
const fmtMi = (m) => `${mi(m).toFixed(mi(m) < 1 ? 2 : 1)} mi`;
const fmtHm = (min) => `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m`;

/** Everything the tab is currently looking at. Not on `window`; the module owns it. */
const T = { pieces: [], picked: new Set(), ramp: null, rampName: '', usableAh: 0,
            windowMin: null, band: null, holding: null, sortBy: 'ramp', lake: '', limit: 25,
            spots: [], species: '', r2Key: '', dateStr: '', waterTempF: null,
            launchTime: '', returnTime: '',
            // WHAT THE RESEARCH SAID, carried across the two halves of this tab. findWater()
            // loads the profile; buildFromPicked() is the one that writes the prompt, and they
            // are different functions -- so the profile has to survive the gap or the prompt is
            // written without it. That gap is exactly what shipped.
            intel: null, hazards: [],
            windByHour: null, weatherByHour: null, pickedSpots: new Set(),
            // WHICH KINDS OF SPOT HE WANTS TO SEE. Empty means all of them, which is what it
            // did before there was a filter. See paintSpots().
            spotKinds: new Set(),
            // How many spot rows to draw. 573 ledges behind a fixed 30 is the same trapdoor the
            // kind filter just opened; "show more" steps it.
            spotLimit: 30,
            // The water-depth filter. null means no bound — see inDepthBand().
            depthMin: null, depthMax: null };

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE STRIP — distance along the water against depth.
//
// Ryan, on the mock: "i liked the graph from depth strip... it really shows where the bottom is
// and where every thing is". It is a sounder screen, which is the one picture he reads without
// thinking, and it exists because a map is a plan view and all of this is vertical.
//
// THREE DEPTHS, THREE KINDS OF KNOWING, AND THEY MUST NOT BE DRAWN THE SAME WAY:
//
//   the bottom   MEASURED    — filled, hard edge. Shallowest within the wander, which is the one
//                              that decides whether a bait clears.
//   the line     MEASURED    — thin dashed. What the chart says under the centreline, drawn ONLY
//                              so the gap to the shallow side stays visible. Nothing decides on it.
//   the fish     RESEARCHED  — shaded band, no edges. A range with a citation, never a number.
//
// There is deliberately no bait curve. That would need a lead and a speed, neither of which
// exists yet at pick time, and: "my sonar isn't going to show where my bait is... i do not have
// live sonar". A crisp line for something never verified is a lie told in a picture.
// ─────────────────────────────────────────────────────────────────────────────────────────────
function strip(p, band, w = 560, h = 96) {
  const env = p.envelope || [];
  const step = p.envelopeStepM || 40;
  const n = env.length;
  if (n < 2) return '';
  const real = env.filter((d) => d >= 0);
  const line = p.envelopeLine || [];
  const deepAll = [...real, ...(p.envelopeDeep || []).filter((d) => d >= 0), ...(band || [0, 0])];
  const maxFt = Math.max(10, Math.ceil((Math.max(...deepAll) + 4) / 5) * 5);
  const X = (i) => (i / (n - 1)) * w;
  const Y = (ft) => (ft / maxFt) * h;

  // The floor, as a filled area. Uncharted stations BREAK it rather than interpolating across —
  // a smooth line over water nobody sounded is exactly the lie that costs a lure.
  const segs = [];
  let cur = [];
  env.forEach((d, i) => {
    if (d >= 0) cur.push([X(i), Y(d)]);
    else { if (cur.length > 1) segs.push(cur); cur = []; }
  });
  if (cur.length > 1) segs.push(cur);
  const floor = segs.map((s) =>
    `<path d="M ${s[0][0].toFixed(1)} ${h} L ${s.map((q) => `${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join(' L ')} `
    + `L ${s[s.length - 1][0].toFixed(1)} ${h} Z" fill="#1d3b57" stroke="#4a9fd8" stroke-width="1.2" />`).join('');

  // Where nobody sounded it, say so, rather than leaving a gap that reads as deep water.
  const gaps = [];
  let g0 = null;
  env.forEach((d, i) => {
    if (d < 0 && g0 === null) g0 = i;
    if (d >= 0 && g0 !== null) { gaps.push([g0, i]); g0 = null; }
  });
  if (g0 !== null) gaps.push([g0, n - 1]);
  const unch = gaps.map(([a, b]) =>
    `<rect x="${X(a).toFixed(1)}" y="0" width="${Math.max(2, X(b) - X(a)).toFixed(1)}" height="${h}" `
    + `fill="url(#wgHatch)" />`).join('');

  const centre = line.length === n
    ? `<polyline points="${line.map((d, i) => (d >= 0 ? `${X(i).toFixed(1)},${Y(d).toFixed(1)}` : ''))
        .filter(Boolean).join(' ')}" fill="none" stroke="#9fd4ff" stroke-width="1" `
      + `stroke-dasharray="3 3" opacity="0.75" />`
    : '';

  const fish = Array.isArray(band) && band.length === 2
    ? `<rect x="0" y="${Y(band[0]).toFixed(1)}" width="${w}" `
      + `height="${Math.max(1, Y(band[1]) - Y(band[0])).toFixed(1)}" fill="#76ff03" opacity="0.13" />`
    : '';

  // Structure, at the metre it comes up, coloured by whether it is worth fishing. NOT by whether
  // it is a threat — that depends on where it sits against baits that do not exist yet.
  const marks = (p.near || []).filter((q) => q.s != null && q.s <= n * step).map((q) => {
    const x = X(Math.min(n - 1, q.s / step));
    const avoid = q.t === 'hazard' || q.t === 'obstruction';
    return `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${h}" `
         + `stroke="${avoid ? '#ff5252' : '#ffd54f'}" stroke-width="1" opacity="0.55" />`
         + `<title>${esc(q.t.replace(/_/g, ' '))} — ${Math.round(q.d)} m off the line</title>`;
  }).join('');

  const ticks = [];
  for (let ft = 10; ft < maxFt; ft += 10) {
    ticks.push(`<line x1="0" y1="${Y(ft).toFixed(1)}" x2="${w}" y2="${Y(ft).toFixed(1)}" `
             + `stroke="#2b4a68" stroke-width="0.5" />`
             + `<text x="2" y="${(Y(ft) - 2).toFixed(1)}" font-size="8" fill="#6d8fae">${ft}</text>`);
  }

  return `<svg class="wg-strip" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" `
       + `aria-label="depth along this water">`
       + `<defs><pattern id="wgHatch" width="6" height="6" patternUnits="userSpaceOnUse">`
       + `<path d="M 0 6 L 6 0" stroke="#c98b2e" stroke-width="1" opacity="0.5" /></pattern></defs>`
       + `<rect x="0" y="0" width="${w}" height="${h}" fill="#0d1a2a" />`
       + ticks.join('') + fish + unch + floor + centre + marks
       + `<text x="${w - 3}" y="10" font-size="8" fill="#6d8fae" text-anchor="end">`
       + `${fmtMi(n * step)} · deepest ${maxFt} ft</text></svg>`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE MAP — THE ACTUAL CHART, NOT A BOX WITH LINES IN IT.
//
// Ryan, 2026-08-30: "the whole pickwater concept is broken... i should be able to see the map...
// know what it looks like as i am picking it... not a representation of what is under me the
// actual contours and colors but i dont know how that would work for real." And when it was
// still a black rectangle a day later: "this is useless".
//
// It works, and the reason it works is the annoying part: THIS TAB ALREADY DOWNLOADS THE CHART.
// `depth_areas.geojson` is fetched a few hundred lines below to sample depths with, and the
// picture was thrown away every time -- 6,697 depth-banded polygons for Wateree, which is what a
// Garmin unit draws. The shoreline is already here too. No new fetch, no pipeline change.
//
// CANVAS, NOT SVG. The old map was an SVG of the lane polylines over a filled rect, which was
// fine for 109 paths. The chart is 6,697 filled polygons plus the shoreline plus the lanes, and
// as SVG that is a DOM node per polygon and a repaint per pick.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// Shallow to deep, the way a chart reads: pale sand through to a navy channel. Not a rainbow --
// the point is to see the shape of the bottom at a glance, and a hue ramp hides it.
const DEPTH_STOPS = [[0, '#f4ebd9'], [2, '#e7e2c9'], [5, '#cfe0c8'], [8, '#a9d6ce'],
                     [12, '#7fc6d2'], [18, '#54aecb'], [25, '#3690bc'], [32, '#2472a6'],
                     [42, '#1b578c'], [55, '#143f6e'], [70, '#0e2b52']];
function depthColour(ft) {
  if (!(ft >= 0)) return '#8fb6c4';
  for (let i = DEPTH_STOPS.length - 1; i >= 0; i--) if (ft >= DEPTH_STOPS[i][0]) return DEPTH_STOPS[i][1];
  return DEPTH_STOPS[0][1];
}

/** Fit the listed pieces, then draw the whole chart under them. */
function mapCanvas(w = 560, h = 420) {
  return `<canvas id="wgMap" width="${w}" height="${h}" `
       + `style="width:100%;display:block;border-radius:8px;cursor:pointer"></canvas>`;
}

function paintMap(pieces, picked, ramp) {
  const cv = $('wgMap');
  if (!cv || !cv.getContext) return;
  const all = pieces.flatMap((p) => p.coords || []);
  if (all.length < 2) return;

  const box = cv.parentElement.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(320, Math.round(box.width)) || 560;
  const h = Math.round(w * 0.75);
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  cv.style.height = h + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const lons = all.map((c) => c[0]), lats = all.map((c) => c[1]);
  let lo0 = Math.min(...lons), lo1 = Math.max(...lons);
  let la0 = Math.min(...lats), la1 = Math.max(...lats);
  // A LITTLE AIR ROUND THE PICK. Fitting the listed pieces exactly puts them against the edge
  // with none of the water that makes them mean anything -- the cove a lane sits in is the point.
  const padLo = Math.max((lo1 - lo0) * 0.18, 0.004), padLa = Math.max((la1 - la0) * 0.18, 0.003);
  lo0 -= padLo; lo1 += padLo; la0 -= padLa; la1 += padLa;

  const kx = 111320 * Math.cos(((la0 + la1) / 2) * Math.PI / 180), ky = 110540;
  const wM = (lo1 - lo0) * kx, hM = (la1 - la0) * ky;
  const s = Math.min((w - 8) / Math.max(1, wM), (h - 8) / Math.max(1, hM));
  const ox = (w - wM * s) / 2, oy = (h - hM * s) / 2;
  const X = (c) => ox + (c[0] - lo0) * kx * s;
  const Y = (c) => h - oy - (c[1] - la0) * ky * s;
  T.mapHit = { X, Y, w, h };

  ctx.fillStyle = '#0b1622';
  ctx.fillRect(0, 0, w, h);

  // Cull by bounding box. At cove zoom that is most of the lake skipped, and it is the only
  // reason drawing every depth band on every pick is affordable.
  const inView = (bb) => !(bb[2] < lo0 || bb[0] > lo1 || bb[3] < la0 || bb[1] > la1);
  const ringBox = (r) => {
    let a = 180, b = 90, c = -180, d = -90;
    for (const p of r) { if (p[0] < a) a = p[0]; if (p[1] < b) b = p[1];
                         if (p[0] > c) c = p[0]; if (p[1] > d) d = p[1]; }
    return [a, b, c, d];
  };
  const tracePoly = (rings) => {
    ctx.beginPath();
    for (const r of rings) {
      for (let i = 0; i < r.length; i++) {
        const x = X(r[i]), y = Y(r[i]);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
    }
  };

  for (const f of (T.daFeatures || [])) {
    const g = f.geometry;
    if (!g || g.type !== 'Polygon') continue;
    if (!f._bb) f._bb = ringBox(g.coordinates[0]);
    if (!inView(f._bb)) continue;
    ctx.fillStyle = depthColour(Number((f.properties || {}).depth_max_ft));
    tracePoly(g.coordinates);
    ctx.fill('evenodd');
  }

  ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(232,239,244,.45)';
  for (const f of (T.shoreFeatures || [])) {
    const g = f.geometry; if (!g) continue;
    const parts = g.type === 'LineString' ? [g.coordinates]
                : g.type === 'MultiLineString' ? g.coordinates : null;
    if (!parts) continue;
    for (const c of parts) {
      if (c.length < 2) continue;
      if (!inView(ringBox(c))) continue;
      ctx.beginPath();
      for (let i = 0; i < c.length; i++) { const x = X(c[i]), y = Y(c[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
    }
  }

  // The lanes last, so a pick is never buried under a depth band.
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const p of pieces) {
    const on = picked.has(p.key);
    ctx.lineWidth = on ? 4.5 : 2.4;
    ctx.strokeStyle = on ? '#76ff03' : '#ff9d2e';
    ctx.beginPath();
    const co = p.coords || [];
    for (let i = 0; i < co.length; i++) { const x = X(co[i]), y = Y(co[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
    // The row number, so the list and the chart are the same object seen twice.
    const mid = co[Math.floor(co.length / 2)];
    const n = T.rowOf && T.rowOf.get(p.key);
    if (mid && n) {
      const x = X(mid), y = Y(mid);
      ctx.fillStyle = on ? '#76ff03' : 'rgba(11,22,34,.82)';
      ctx.beginPath(); ctx.arc(x, y, 8, 0, 7); ctx.fill();
      ctx.fillStyle = on ? '#0b1622' : '#ff9d2e';
      ctx.font = '600 10px ui-monospace, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(n), x, y);
    }
  }

  if (ramp) {
    ctx.beginPath(); ctx.arc(X(ramp), Y(ramp), 5.5, 0, 7);
    ctx.fillStyle = '#ffd54f'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#0d1a2a'; ctx.stroke();
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A ROW
// ─────────────────────────────────────────────────────────────────────────────────────────────
/**
 * HOW DEEP THIS WATER IS -- from the corridor, not from `holdsFt`.
 *
 * `holdsFt` is the shallowest point the whole stretch clears, set by one shoal somewhere along it.
 * Leading a row with it announced a stretch of 17-24 ft water as "8 ft or deeper", which is true
 * and useless. The shoal is still named, as a reason against, because it is what decides how deep
 * he can fish the whole pass -- it is just not what the water IS.
 */
function water(p) {
  const o = p.reasons?.optionality;
  if (!o || o.fromFt == null) return '';
  return o.toFt - o.fromFt >= 2 ? ` of ${o.fromFt}\u2013${o.toFt} ft water`
                                : ` of about ${o.fromFt} ft water`;
}

function row(p, i) {
  const on = T.picked.has(p.key);
  const r = p.reasons || { for: [], against: [] };
  const ramp = p.rampM && T.rampName in p.rampM ? p.rampM[T.rampName] : null;
  return `<div class="wg-row${on ? ' picked' : ''}" data-key="${esc(p.key)}">
    <div class="wg-head">
      <label class="wg-tick"><input type="checkbox" data-pick="${esc(p.key)}"${on ? ' checked' : ''}>
        <b>${i + 1}.</b> ${fmtMi(p.lengthM)}${water(p)}</label>
      <span class="wg-meta">${ramp != null ? `${fmtMi(ramp)} from the ramp · ` : ''}
        ${Math.round(p.lengthM / (TROLL_MPH * 1609.34) * 60)} min to troll it${
        p.partners.length ? ` · ${p.partners.length} to turn onto` : ''}</span>
    </div>
    ${joinsHtml(p)}
    ${strip(p, T.band)}
    <ul class="wg-for">${r.for.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
    <ul class="wg-against">${r.against.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
  </div>`;
}

/**
 * CARRY ON INTO THE NEXT PIECE.
 *
 * Ryan, on three legs the app drew across water he fishes as one line: "blue and purple to me are
 * pretty much one line / see how i routed around that shallow spot and combined the 2 lines...
 * that is how i would fish that."
 *
 * THE COST IS ON THE BUTTON, not inferred from it. A join buys length and can spend bait depth,
 * and which of those matters is the day's call -- "and its not always about the longest line
 * either". So each one says what it makes, what it costs and what it crosses, and the list is in
 * the order joinsFor() ranked them: deepest bait first, which is deepestUsable()'s own ranking.
 *
 * Three at most. A piece with nine joins is a menu, and the row is already long.
 *
 * DIRECTLY UNDER THE TICK, NOT AT THE FOOT OF THE ROW. The first cut put these after both reason
 * lists, so on a lake with 25 rows they sat below every argument for and against every piece.
 * Ryan: "You buried the buttons at the bottom of 25 trolling lanes..." Taking a join is an
 * ALTERNATIVE TO TICKING THIS PIECE -- it is the same decision, made differently -- so it belongs
 * beside the tick and above the evidence, not after it.
 */
function joinsHtml(p) {
  const js = (p.joins || []).slice(0, 3);
  if (!js.length) return '';
  return `<div class="wg-joins">${js.map((j) => {
    const cost = j.costFt > 0 ? ` · costs ${j.costFt} ft of bait depth` : ' · no cost in bait depth';
    // BY ITS ROW NUMBER, and by its length when it is not on screen. A piece can be filtered out
    // by the depth slider or fall past the row limit and still be perfectly joinable, so the
    // button has to be readable either way rather than naming something he cannot look up.
    // ROW NUMBER FIRST, THE LANE'S ID SECOND, because the two are read in different places. The
    // row number is how he finds it in this list; the id is what the map tooltip says when he
    // hovers the line -- which is how he found it at all: "oh they do if i hover over the map".
    // A piece can also be filtered out by the depth slider or fall past the row limit and still
    // be perfectly joinable, so the button stays readable when there is no row to point at.
    const n = T.rowOf && T.rowOf.get(j.otherKey);
    const id = String(j.otherRunId || '').split('#').pop();
    const who = n ? `row ${n} (${id})`
                  : `${id}, a ${fmtMi(j.otherLengthM || 0)} piece not in this list`;
    return `<button type="button" class="wg-join" data-join="${esc(String(j.idx))}">`
         + `carry on into ${esc(who)} — ${fmtMi(j.lengthM)} `
         + `on one ${j.baitFt} ft bait${cost}`
         + `<span class="wg-join-meta">${j.gapM} m of water between them, ${j.turnDeg}° turn`
         + `${j.floorFt ? `, floor ${j.floorFt.minFt}\u2013${j.floorFt.maxFt} ft` : ''}</span>`
         + `</button>`;
  }).join('')}</div>`;
}

/**
 * A CAST SPOT, PRICED BY WHERE IT LANDS.
 *
 * § 6: "A spot inside a chosen route's corridor IS the stop-and-cast, at no extra travel. A spot
 * away from every chosen route is a destination that costs the trip. Same object, priced by where
 * it lands." So the row changes as he ticks water, and `free` is never a property of the spot.
 *
 * How long a spot is worth working is NOT here. § 7 lists it, and it is a fishing judgement with
 * no number behind it -- the model gets the spot and says, or Ryan decides on the water.
 */
function spotRow(s, i) {
  const on = T.pickedSpots.has(s.key);
  const d = s.depthFt != null ? ` · ${Math.round(s.depthFt)} ft` : '';
  const where = s.free
    ? `<span class="wg-ok">on water you picked, ${s.detourM} m off the line</span>`
    : `${fmtMi(s.detourM)} off your nearest picked water`;
  return `<div class="wg-spot${on ? ' picked' : ''}">
    <label class="wg-tick"><input type="checkbox" data-spot="${esc(s.key)}"${on ? ' checked' : ''}>
      <b>${i + 1}.</b> ${esc(s.what)}${d}</label>
    <span class="wg-meta">${where}${s.structureId ? ` · ${esc(s.structureId)}` : ''}</span>
  </div>`;
}

/**
 * One chip per kind of spot actually present, with how many there are.
 *
 * FIVE THOUSAND SPOTS AND A WINDOW ONTO THIRTY OF THEM. Ryan, doing a Pick Water on Wateree:
 * "the entire screen is full of humps and points and no way to find any other structure —
 * 5020 cast spots · 16 on water you have picked · showing 30".
 *
 * The list is ordered free-first then nearest and then cut at 30, which is the right ordering and
 * a trapdoor: whichever kind happens to be commonest near the picked water fills the window, and
 * every other kind is behind it with no way to reach it. Wateree carries humps, ledges, points,
 * coves, creek mouths, timber, brush piles, charted attractors, DNR brushpiles and two kinds of
 * dock line, and eight of those were unreachable.
 *
 * A filter is the whole fix, and the counts have to be on it — "brush pile 41" is the difference
 * between choosing and guessing. Nothing is hidden by default: an empty selection is every kind,
 * exactly as before.
 */
export function spotKindCounts(priced) {
  const by = new Map();
  for (const s of (priced || [])) {
    if (!s || !s.type) continue;
    // THE KIND'S LABEL, NOT THE SPOT'S OWN NAME. A DNR brushpile carries its published name --
    // "Fish Attractor #4 Lake Wateree" -- which is right on a row and absurd on a chip: the
    // filter came up offering a button labelled with one attractor's name and a count of 3,898.
    // SPOT_KINDS is the vocabulary; a spot's `what` is only a fallback for a kind not in it.
    const label = SPOT_KINDS[s.type] || s.what || s.type;
    const e = by.get(s.type) || { type: s.type, what: label, n: 0, free: 0 };
    e.n += 1;
    if (s.free) e.free += 1;
    by.set(s.type, e);
  }
  // Kinds with spots on water already picked lead, then the commonest. A kind with nothing free
  // is still listed -- it is the one he is hunting for when he opens the filter at all.
  return [...by.values()].sort((a, b) => b.free - a.free || b.n - a.n || a.type.localeCompare(b.type));
}

function spotKindChips(priced) {
  const rows = spotKindCounts(priced);
  if (rows.length < 2) return '';      // one kind is not a choice
  const any = T.spotKinds.size > 0;
  return `<div class="wg-kinds">`
    + `<button type="button" data-kind="" class="wg-kind${any ? '' : ' on'}">all ${priced.length}</button>`
    + rows.map((e) => `<button type="button" data-kind="${esc(e.type)}" `
        + `class="wg-kind${T.spotKinds.has(e.type) ? ' on' : ''}${e.free ? ' has-free' : ''}" `
        + `title="${e.free} on water you have picked">${esc(e.what)} ${e.n}`
        + `${e.free ? ` <i>${e.free}</i>` : ''}</button>`).join('')
    + `</div>`;
}

/** The spots, priced against what is currently ticked, best-value first. */
function paintSpots() {
  const el = $('wgSpots');
  if (!el) return [];
  const picked = T.pieces.filter((p) => T.picked.has(p.key));
  const priced = priceSpots(T.spots, picked, { ramp: T.ramp });
  const chips = spotKindChips(priced);
  // The filter narrows WHAT IS LISTED, never what is priced -- the chips' counts and the totals
  // below have to keep describing the whole water or the numbers change meaning under him.
  const shown = T.spotKinds.size ? priced.filter((x) => T.spotKinds.has(x.type)) : priced;
  // Free ones first, then nearest. A spot that costs a mile of paddling is still offered -- § 9,
  // "feasibility is feedback, not a gate" -- it just does not lead.
  const show = shown.slice(0, T.spotLimit);
  const free = priced.filter((x) => x.free).length;
  const filtered = T.spotKinds.size
    ? ` · ${shown.length} of the kind${T.spotKinds.size > 1 ? 's' : ''} you picked` : '';
  const more = shown.length - show.length;
  el.innerHTML = chips
    + `<div class="wg-count">${priced.length} cast spots · ${free} on water you have `
    + `picked${filtered}${more > 0 ? ` · showing ${show.length}` : ''}</div>`
    + (show.length ? show.map(spotRow).join('')
                   : `<div class="wg-dim">Nothing of that kind on this water.</div>`)
    + (more > 0 ? `<button type="button" class="wg-more" data-more="1">`
                + `show ${Math.min(more, 60)} more of ${more}</button>` : '');
  return priced;
}

/** The running total. Feedback for everything, refusal for the battery alone. */
function total() {
  const picked = T.pieces.filter((p) => T.picked.has(p.key));
  const el = $('wgTotal');
  if (!el) return null;
  if (!picked.length) {
    el.innerHTML = `<span class="wg-dim">Nothing picked yet. Tick the water you want to fish and `
                 + `this says what the day costs.</span>`;
    return null;
  }
  const d = dayCost(picked, { ramp: T.ramp, usableAh: T.usableAh, windowMin: T.windowMin,
                              windByHour: T.windByHour });
  // THE MOVING NUMBERS ARE FLOORS AND THEY NOW LOOK LIKE FLOORS.
  //
  // dayCost() prices the deadhead as a straight line — deliberately, because routing every
  // candidate ordering while he is still ticking boxes would be dozens of round trips. That is
  // the right trade and the wrong presentation: "6.2 mi moving · 6h 26m" reads as a measurement.
  // On his 2026-08-11 Wateree day the routed answer was 17.9 mi and 9h 52m.
  //
  // A trailing "+" is the whole fix. It costs one character and it stops the estimate from
  // reading like the answer, which is exactly the failure the note underneath was already trying
  // to prevent in prose and losing to a number set in bold.
  const bits = [
    `<b>${picked.length}</b> piece${picked.length > 1 ? 's' : ''}`,
    `${fmtMi(d.trollM)} trolling`,
    `${fmtMi(d.moveM)}+ moving`,
    `${fmtHm(d.min)}+`,
    `<b>${d.ah} Ah</b> of ${T.usableAh || '?'}`,
  ];
  // WHAT THE ORDER WOULD HAVE TO BE. The refusal is only useful if it comes with the fix, and the
  // fix is almost always an ordering: "yes, if you fish it second instead of last."
  const order = d.order.map((k) => T.pieces.indexOf(picked[k]) + 1).join(' → ');
  const notes = [];
  if (!d.fits) {
    notes.push(`<span class="wg-stop">Over the battery — ${esc(d.reason)}. `
             + `Best possible order is ${order} and it still does not fit; drop one.</span>`);
  } else {
    notes.push(`<span class="wg-ok">Fits, fished in the order ${order}`
             + `${d.exact ? '' : ' (best found, not proven best past 8 pieces)'}.</span>`);
  }
  if (d.overWindowMin > 0) {
    notes.push(`<span class="wg-warn">${fmtHm(d.overWindowMin)} past your return time — `
             + `that is yours to spend, not a refusal.</span>`);
  }
  // CAST SPOTS ARE PRICED BY WHAT IS TICKED, so they belong in the running total and nowhere else.
  // § 6: "A spot inside a chosen route's corridor IS the stop-and-cast, at no extra travel."
  const free = priceSpots(T.spots, picked, { ramp: T.ramp }).filter((s) => s.free);
  if (free.length) {
    const kinds = {};
    for (const s of free) kinds[s.what] = (kinds[s.what] || 0) + 1;
    const list = Object.entries(kinds).sort((a, b) => b[1] - a[1])
      .map(([w, n]) => `${n} ${w}${n > 1 ? 's' : ''}`).join(', ');
    notes.push(`<span class="wg-ok">${free.length} cast spot${free.length > 1 ? 's' : ''} already `
             + `on this water — ${esc(list)} — so working them costs only the minutes.</span>`);
  } else {
    notes.push(`<span class="wg-dim">No charted cast spots inside this water; anything worth `
             + `stopping on would be a detour.</span>`);
  }
  // WHAT THE TICKED SPOTS ADD. A spot on picked water costs only the minutes spent on it; one
  // off it costs the run out and back, and that is the number worth seeing before committing.
  if (T.pickedSpots.size) {
    const priced = priceSpots(T.spots, picked, { ramp: T.ramp });
    const chosen = priced.filter((x) => T.pickedSpots.has(x.key));
    const away = chosen.filter((x) => !x.free);
    const detourM = away.reduce((a, x) => a + x.detourM * 2, 0);
    notes.push(`<span class="${away.length ? 'wg-warn' : 'wg-ok'}">${chosen.length} cast spot`
             + `${chosen.length > 1 ? 's' : ''} picked — ${chosen.length - away.length} free on `
             + `your water` + (away.length
               ? `, ${away.length} off it costing about ${fmtMi(detourM)} of paddling there and back`
               : `, nothing extra to paddle`) + `.</span>`);
  }
  notes.push(`<span class="wg-dim">Moving distance is straight-line, so it is the optimistic `
           + `number; the plan re-checks it over the water graph.</span>`);
  el.innerHTML = `<div class="wg-sum">${bits.join(' · ')}</div>${notes.join(' ')}`;
  return d;
}

/**
 * The rows currently on screen, in the chosen order.
 *
 * A lake returns 200+ pieces and a list that long is not a choice, it is a haystack. So the list
 * is capped and THE CAP SAYS SO -- see the count under the heading. It is not a filter on quality:
 * the sort is his, and the cap takes the top of whatever he sorted by.
 */
/**
 * THE DEPTH FILTER, AND WHY IT IS THE CORRIDOR AND NOT `holdsFt`.
 *
 * Ryan's first complaint on seeing this tab live, 2026-08-11: "no slider to decide how deep of
 * water to display."
 *
 * The obvious number to filter on is `holdsFt`, and it is the wrong one. `holdsFt` is a THRESHOLD
 * — the shallowest point the whole stretch clears, set by one shoal somewhere along it — so a
 * piece running 22–31 ft of water with a single 18 ft rise reads as "18 ft" and a filter asking
 * for 20 ft and deeper would throw it away. That is water he wants, hidden by its worst metre.
 *
 * `optionality()` gives the corridor: the median shallow and the median deep across the whole
 * envelope, which is the water he is actually fishing. A piece is kept when its corridor OVERLAPS
 * the asked-for band at all, not when it sits wholly inside — asking for 20–30 ft should still
 * show you a piece running 25–40, because most of a pass through it is in the band.
 *
 * Cached on the piece: `shown()` runs on every repaint and `optionality` medians two arrays.
 */
function corridorOf(p) {
  if (p._corr === undefined) p._corr = optionality(p);
  return p._corr;
}

function inDepthBand(p) {
  const lo = T.depthMin, hi = T.depthMax;
  if (lo == null && hi == null) return true;
  const c = corridorOf(p);
  // A piece with no envelope cannot demonstrate its depth, and a filter must not delete water on
  // the strength of a missing measurement — the same rule `charted: null` follows.
  if (c.fromFt == null) return true;
  if (hi != null && c.fromFt > hi) return false;
  if (lo != null && c.toFt < lo) return false;
  return true;
}

function shown() {
  const sorted = [...T.pieces].filter(inDepthBand).sort((a, b) => {
    if (T.sortBy === 'length') return b.lengthM - a.lengthM;
    if (T.sortBy === 'deep') return b.holdsFt - a.holdsFt;
    if (T.sortBy === 'laps') return b.partners.length - a.partners.length || b.lengthM - a.lengthM;
    const x = a.rampM?.[T.rampName] ?? Infinity, y = b.rampM?.[T.rampName] ?? Infinity;
    return x - y;
  });
  // Anything ticked stays visible even if the sort would have pushed it off the end -- a choice
  // that disappears when you change the sort is a choice you cannot check.
  const top = sorted.slice(0, T.limit);
  const keys = new Set(top.map((p) => p.key));
  return top.concat(sorted.filter((p) => T.picked.has(p.key) && !keys.has(p.key)));
}

/**
 * THE SLIDER'S RANGE COMES FROM THE WATER, NOT FROM A NUMBER I PICKED.
 *
 * A 0–100 ft slider on a lake whose deepest corridor is 34 ft spends two thirds of its travel
 * doing nothing, and tells him the lake is shallow before he has looked at anything. The ends are
 * the shallowest and deepest corridor actually present, so every position on it means something —
 * the same rule the rest of this tab follows: if the answer would be a number he has to make up,
 * measure it and show it instead.
 *
 * Built in JS rather than added to index.html so the whole filter is one thing in one file, the
 * way the research picker's toggles are.
 */
function buildDepthFilter() {
  const anchor = $('wgCount');
  if (!anchor || !anchor.parentNode || $('wgDepthBar')) return;
  const bar = document.createElement('div');
  bar.id = 'wgDepthBar';
  bar.style.cssText = 'margin:6px 0;font-size:0.82em;color:var(--muted,#888);display:flex;'
                    + 'align-items:center;gap:8px;flex-wrap:wrap;';
  bar.innerHTML = '<span>Water depth</span>'
    + '<input type="range" id="wgDepthLo" style="width:110px;vertical-align:middle;">'
    + '<input type="range" id="wgDepthHi" style="width:110px;vertical-align:middle;">'
    + '<span id="wgDepthLabel" style="min-width:120px;"></span>'
    + '<button id="wgDepthClear" style="background:none;border:1px solid var(--line,#333);'
    + 'color:var(--muted,#888);border-radius:3px;font-size:0.9em;padding:1px 7px;cursor:pointer;">all</button>';
  anchor.parentNode.insertBefore(bar, anchor.nextSibling);
  const lo = $('wgDepthLo'), hi = $('wgDepthHi');
  const sync = (fromLo) => {
    // The two handles cannot cross. Push the other one rather than clamping the one he is
    // dragging — clamping fights the mouse and feels broken.
    if (+lo.value > +hi.value) { if (fromLo) hi.value = lo.value; else lo.value = hi.value; }
    T.depthMin = +lo.value <= +lo.min ? null : +lo.value;
    T.depthMax = +hi.value >= +hi.max ? null : +hi.value;
    paint();
  };
  lo.addEventListener('input', () => sync(true));
  hi.addEventListener('input', () => sync(false));
  $('wgDepthClear').addEventListener('click', () => {
    lo.value = lo.min; hi.value = hi.max; T.depthMin = null; T.depthMax = null; paint();
  });
}

/** Set the slider's ends from the corridors actually present, and reset it to wide open. */
function fitDepthFilter() {
  buildDepthFilter();
  const lo = $('wgDepthLo'), hi = $('wgDepthHi');
  if (!lo || !hi) return;
  const d = T.pieces.map((p) => corridorOf(p)).filter((c) => c.fromFt != null);
  const bar = $('wgDepthBar');
  if (!d.length) { if (bar) bar.style.display = 'none'; return; }
  if (bar) bar.style.display = 'flex';
  const min = Math.floor(Math.min(...d.map((c) => c.fromFt)));
  const max = Math.ceil(Math.max(...d.map((c) => c.toFt)));
  for (const el of [lo, hi]) { el.min = String(min); el.max = String(max); el.step = '1'; }
  lo.value = String(min); hi.value = String(max);
  T.depthMin = null; T.depthMax = null;
}

function paint() {
  const l = $('wgDepthLabel');
  if (l) {
    l.textContent = (T.depthMin == null && T.depthMax == null)
      ? `all (${$('wgDepthLo')?.min ?? '?'}–${$('wgDepthHi')?.max ?? '?'} ft here)`
      : `${T.depthMin ?? $('wgDepthLo')?.min}–${T.depthMax ?? $('wgDepthHi')?.max} ft`;
  }
  const list = shown();
  // WHICH ROW IS WHICH, so a join can name the piece the way the tab does. Ryan: "your buttons
  // say to carry into x but the numbers dont exist anywhere in the pickwater" -- and they did
  // not: the button was quoting the lane's id out of the chartpack, which appears in no row, no
  // header and no tooltip. Rows are numbered by their position in this list, so the number he
  // reads is the number that has to come back at him.
  T.rowOf = new Map(list.map((p, i) => [p.key, i + 1]));
  const el = $('wgList');
  if (el) el.innerHTML = list.map(row).join('');
  // THE MAP DRAWS WHAT THE LIST DRAWS. Drawing all 211 pieces while listing 12 of them put the
  // whole lake on screen with the twelve invisible inside it -- the map has to answer "where is
  // row 4", and it cannot do that at lake scale.
  const map = $('wgMap')?.parentElement;
  if (map) { map.innerHTML = mapCanvas(); paintMap(list, T.picked, T.ramp); }
  paintSpots();
  const n = $('wgCount');
  if (n) {
    // SAY WHAT THE DEPTH FILTER REMOVED, SEPARATELY FROM WHAT THE CAP REMOVED. They are different
    // kinds of hiding: the cap is "there is more of this", the filter is "you asked me not to
    // show that". Collapsing them into one number is how a filter reads as an empty lake.
    const passing = T.pieces.filter(inDepthBand).length;
    const cut = T.pieces.length - passing;
    const band = (T.depthMin != null || T.depthMax != null)
      ? ` · ${T.depthMin ?? 0}–${T.depthMax ?? '∞'} ft hides ${cut}`
      : '';
    n.textContent = (passing > T.limit
      ? `showing ${T.limit} of ${passing} — change the sort to see different water`
      : `${passing} piece${passing === 1 ? '' : 's'}`) + band;
  }
  total();
}

/** Read the pack, measure the water, put it up. */
export async function findWater() {
  const say = (m, bad) => {
    const s = $('wgStatus');
    if (s) { s.textContent = m; s.style.color = bad ? 'var(--warn)' : 'var(--muted)'; }
  };
  const inp = readInputs();
  if (!inp.lakeName) return say('Pick a lake first', true);
  if (!inp.species.length) return say('Check a species — the band comes from the research', true);

  const r2Key = resolveR2Key(inp.lakeName);
  if (!r2Key) return say(`No chartpack for ${inp.lakeName}`, true);
  const ramp = rampCoords(inp.lakeName, inp.rampName);
  if (!ramp) return say('Could not place that ramp', true);

  const species = inp.species[0];
  const date = new Date(`${inp.dateStr}T12:00:00`);
  // THE RESEARCHED PROFILE FIRST — the same source the Smart Plan tab reads.
  //
  // This argument was `null`, which meant Pick Water could never reach the research pipeline and
  // fell to SPECIES_BEHAVIOR_V2 for every lake on the card. That table covers FOUR lakes, its
  // `preferredDepth` numbers predate the fish-depth/water-depth split, and on Wateree in summer
  // above 84 F it returns [14, 16] while its own notes on the same object say the thermocline
  // sits at 18-24 ft and the fish drop to its edge. Ryan, 2026-08-11: "the 4 lake hard code needs
  // to go away... that is what the research pipeline is for."
  //
  // Absence is still normal and still silent — `depthBandFor` falls back exactly as before, and
  // says which source it used in `basis`. What changes is that a researched lake now gets its
  // researched answer here as well as there.
  say('Reading the research…');
  const researched = await loadResearchedProfile(inp.lakeName);
  const depth = depthBandFor(species, inp.lakeName, getSeason(date, inp.waterTempF), inp.waterTempF, researched);

  say('Reading the pack…');
  const get = packFetcher(CF_WORKER_URL);
  // THREE LAYERS, IN PARALLEL, AND TWO OF THEM ARE OPTIONAL.
  //
  // depth_areas gives which side the bottom rises on; garmin_shoreline gives where the land is.
  // Both already ship in every pack and are already in R2 — no refit and no pipeline change, which
  // I offered twice before checking the bucket. 385 packs carry a shoreline against 543 carrying
  // runs, so the shoreline is genuinely absent a lot and its absence must stay silent rather than
  // become a claim of open water.
  const [fc, daFc, slFc, wfFc, stFc, poFc, dkFc] = await Promise.all([
    get(`/${r2Key}/trolling_runs.geojson`),
    get(`/${r2Key}/depth_areas.geojson`).catch(() => null),
    get(`/${r2Key}/garmin_shoreline.geojson`).catch(() => null),
    get(`/${r2Key}/water_features.geojson`).catch(() => null),
    get(`/${r2Key}/structure.geojson`).catch(() => null),
    // SAME GAP AS SMART PLAN, SAME FIX. castSpots() says it in its own comment: "Timber, piles
    // and attractors exist only in near[] and have no such file, so they keep the estimate".
    // They have a file. It is this one, and neither planner was fetching it.
    get(`/${r2Key}/pois.geojson`).catch(() => null),
    // DOCKS. 2,796 of them on Wateree and not one was reachable: groupDocks() chains them by
    // distance along a trolling lane, and this file was never fetched here at all. Ryan: "docks
    // need to be there... they would be a primary target for casting for largemouth".
    get(`/${r2Key}/docks.geojson`).catch(() => null),
  ]);
  const lanes = (fc && fc.features) || [];
  if (!lanes.length) return say(`${inp.lakeName} has no trolling runs in its chartpack`, true);

  // FOUR REASONS A LAKE CAN COME BACK EMPTY, AND THEY WANT FOUR DIFFERENT ANSWERS.
  //
  // The first cut of this collapsed the last three into "every contour here is a closed ring",
  // which was wrong the very first time it fired: Wateree came back empty on 2026-08-11 because
  // R2 was still holding the 2026-08-09 pack, two days before the envelope was stamped. Telling
  // Ryan his lake was all closed rings would have sent him looking at the fitter.
  //
  // So the diagnosis is read off the data rather than assumed.
  const props = lanes.map((f) => (f && f.properties) || {});
  const fitted = props.filter((p) => p.fitted);
  const enveloped = fitted.filter((p) => Array.isArray(p.envelope_ft));
  if (!enveloped.length) {
    const stale = `Re-run the fitter and upload — see FIT_TROLLING_RUNS_RUNBOOK.`;
    return say(!fitted.length
      // Nothing fitted at all. Either the pack predates the fitter, or every lane is a closed
      // ring — and `kept_closed` is by far the commoner of the two: 294,493 lanes card-wide.
      ? `${inp.lakeName}: ${lanes.length} charted lanes, none of them fitted. On a small water `
        + `every contour is usually a ring around the whole pond, and a ring has no two ends to `
        + `troll between. If this lake is not small, its pack predates the fitter. ${stale}`
      // Fitted but no envelope: the pack was fitted BEFORE fe37479 stamped the wander envelope.
      // This is the R2-is-behind case and it is the one that will keep happening until the
      // card-wide upload lands.
      : `${inp.lakeName}: ${fitted.length} fitted lanes but none carry a wander envelope, so this `
        + `pack was fitted before the envelope was measured. The copy in R2 is older than the one `
        + `on the pipeline machine. ${stale}`, true);
  }

  const minM = Math.max(1, Math.round(Number($('wgMinPass')?.value || 0.5) * 1609.34));
  // THE WIND BELONGS TO THE WATER, NOT JUST TO THE BATTERY. A crosswind on a line you steer by
  // hand is a reason against that piece, so the forecast has to be in hand BEFORE the reasons are
  // written. Failure is silence: no forecast means the wind is not mentioned, never mentioned as calm.
  say('Checking the forecast…');
  const forecast = await fetchForecast(inp.lakeName, inp.dateStr,
    { launchTime: inp.launchTime, returnTime: inp.returnTime }).catch(() => null);

  // SCDNR / NCWRC / GA DNR WRD / TWRA, live from the Worker. Awaited rather than read off
  // gis-toggles' cache: that cache only fills when the map button is clicked, and which layers
  // were toggled first must not decide what a plan can see. Failure is [] and a log.
  const dnrRows = await (window.getFishAttractors?.() ?? Promise.resolve([]))
    .catch((e) => { console.warn('[pick-water] DNR attractor feed unavailable:', e?.message); return []; });
  // Everywhere this pack has charted anything -- the runs, the depth areas, the shoreline, the
  // features, the structure. An attractor outside all of it is on another lake.
  const onWater = chartedGrid([lanes, (daFc && daFc.features) || [], (slFc && slFc.features) || [],
                               (wfFc && wfFc.features) || [], (stFc && stFc.features) || []]);
  const dnrSpots = attractorSpotFeatures(dnrRows, poiSpotFeatures(poFc),
                                         { onWater, where: `pick-water ${r2Key}` })
    .map((f) => ({ type: 'dnr_attractor', at: f.geometry.coordinates,
                   what: f.properties.name || 'DNR brushpile' }));
  if (dnrSpots.length) console.log(`[pick-water] ${dnrSpots.length} state attractors listed`);

  say('Measuring the water…');
  let out;
  try {
    out = offerWater(lanes, {
      minM,
      fishBandFt: depth ? depth.band : null,
      holding: depth ? depth.holding : null,
      windByHour: forecast ? forecast.windByHour : null,
      depthAt: daFc && daFc.features ? depthSampler(daFc.features) : null,
      // WATER-VERSUS-LAND, COARSE AND FAST. Same layer, a different question -- see waterMask().
      // trimDeadEnd() walks sixteen bearings off every lane end, which the exact sampler cannot
      // afford at sixty microseconds a lookup.
      inWater: daFc && daFc.features ? waterMask(daFc.features) : null,
      shoreIndex: slFc && slFc.features ? shorelineIndex(slFc.features) : null,
      // The real points, coves, creek mouths, humps and ledges, so a cast spot snaps to the thing
      // itself rather than to a guess at where along a lane it sat. See castSpots().
      spotFeatures: [...((wfFc && wfFc.features) || []), ...((stFc && stFc.features) || []),
                     ...poiSpotFeatures(poFc), ...dockSpotFeatures(dkFc)],
      // The state's brushpiles, deduped against the buoys Garmin already charted. Listed whether
      // or not a trolling lane happens to pass one -- see the note in castSpots().
      extraSpots: dnrSpots,
      // Local time, for "the sun is behind the bank from 07:00". getTimezoneOffset() is minutes
      // WEST of UTC and positive for the Americas, so the sign flips — EDT is +240 there and -4
      // here. Taken from the machine because Ryan plans at the computer the night before, on the
      // water he is about to fish.
      dateUTC: Date.UTC(...inp.dateStr.split('-').map((n, i) => (i === 1 ? +n - 1 : +n))),
      tzOffset: -new Date(`${inp.dateStr}T12:00:00`).getTimezoneOffset() / 60,
      ramps: [{ name: inp.rampName || 'launch', lonLat: ramp }],
    });
  } catch (e) { return say(e.message, true); }

  Object.assign(T, {
    pieces: out.pieces, spots: out.spots || [], picked: new Set(),
    // THE CHART, KEPT RATHER THAN THROWN AWAY. Both were fetched above to measure with and were
    // dropped the moment the numbers came out of them -- which is why the map was a black box.
    daFeatures: (daFc && daFc.features) || [],
    shoreFeatures: (slFc && slFc.features) || [],
    // WHERE TWO OF THESE ARE ONE RUN -- see joinsFor() in plan-pieces.js. Held whole because
    // joinedPiece() indexes into the piece array these were measured against, so the pair and
    // the array have to stay together.
    joins: out.joins || [], joinsTaken: 0, minM: out.minM,
    ramp, rampName: inp.rampName || 'launch',
    species, r2Key, dateStr: inp.dateStr, windByHour: forecast ? forecast.windByHour : null,
    // CARRIED FOR THE SEASON, which now asks the water rather than the calendar. findWater()
    // reads the inputs; buildFromPicked() writes the prompt, and without this the second half
    // would fall back to the month on its own -- the two halves of one tab disagreeing about
    // which season it is, which is exactly the class of bug `dateStr` is carried for.
    waterTempF: inp.waterTempF,
    weatherByHour: forecast ? forecast.weatherByHour : null,
    launchTime: inp.launchTime, returnTime: inp.returnTime,
    usableAh: usableAhFrom(inp.motor), band: depth ? depth.band : null,
    holding: depth ? depth.holding : null, lake: inp.lakeName,
    // DERIVED HERE because this is where the profile, the species and the date all exist. The
    // profile was being loaded twelve lines above, spent on depthBandFor() alone, and dropped.
    intel: researchIntel(researched, species, getSeason(date, inp.waterTempF)),
    // THE CHART FIRST, THE RESEARCH SECOND -- same order and same reason as Smart Plan. `poFc` is
    // the pois.geojson this function already fetched for the cast spots.
    hazards: [...chartedHazards(poFc), ...researchHazards(researched)],
    windowMin: (() => {
      const p = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : null; };
      const a = p(inp.launchTime), b = p(inp.returnTime);
      return a != null && b != null && b > a ? b - a : null;
    })(),
  });
  // Re-fit the depth slider to THIS lake before the first paint. A range left over from the
  // previous water would silently hide half of this one.
  fitDepthFilter();
  paint();
  const withLaps = out.pieces.filter((p) => p.partners.length).length;
  const extras = [
    daFc && daFc.features ? null : 'no depth areas, so nothing can say which way the wind sets you',
    slFc && slFc.features ? null : 'no shoreline in this pack, so no lee and no sun-behind-the-bank',
  ].filter(Boolean);
  // WHERE THE DEPTH BAND CAME FROM, SAID OUT LOUD.
  //
  // `depthBandFor` has always returned `basis`, `source` and `generic`, and nothing has ever shown
  // any of them. So a band derived from Ryan's own researched profile and a band read off a
  // four-lake table written by hand looked identical on screen — which is how [14, 16] ft sat in
  // front of him for a week reading like a finding.
  //
  // Ryan, 2026-08-11, on why the band is worth displaying at all: "it is nice to see to confirm
  // that the program/llm gets it right." He cannot confirm a number whose provenance is invisible.
  // 60 of the card's waters carry a verified profile; every other one is still answered from the
  // table, and that difference should be legible at a glance rather than by reading source.
  const bandNote = depth && Array.isArray(depth.band)
    ? ` Fish at ${depth.band[0]}–${depth.band[1]} ft — ${depth.source === 'research'
        ? `your researched profile for ${inp.lakeName}`
        : `${depth.basis}${depth.generic ? ', NOT specific to this lake' : ''}`}.`
    : '';
  say(`${out.laneCount} charted lanes → ${out.pieces.length} pieces of water, `
    + `${withLaps} with somewhere to turn onto. Depths are MINIMUM WATER DEPTH, not bait depth.`
    + bandNote
    + (extras.length ? ` — ${extras.join('; ')}.` : ''));
  return out;
}

/** What the picked water is, for the plan to be built from. */
/** The water he ticked, in the order the app would fish it. Exported so a test can read it. */
export function pickedWater() {
  const picked = T.pieces.filter((p) => T.picked.has(p.key));
  const order = searchOrder(picked);
  return { lake: T.lake, ramp: T.ramp, rampName: T.rampName, band: T.band, holding: T.holding,
           order, pieces: order.map((i) => picked[i]), spots: T.spots };
}

/**
 * TURN THE TICKED WATER INTO A DAY.
 *
 * Everything about which water and in what order is already settled before this runs. The model
 * is called once, for tackle -- see plan-from-water.js and THE_FISHERMAN_CHOOSES § 12.
 *
 * The plan is then handed to the SAME renderer, timeline and globals the Smart Plan tab uses.
 * That is not laziness: `collectPlan()` reads `window._smartPlanTimeline`, so Preview, Print,
 * the GPX export and both download buttons all read from there. A plan that draws its own markup
 * into its own container is a plan that cannot leave the app -- which is exactly what v2 did
 * before ONE_PATH_TO_THE_SCREEN, and every export came up empty.
 */
export async function buildFromPicked() {
  const say = (m, bad) => {
    const el = $('wgStatus');
    if (el) { el.textContent = m; el.style.color = bad ? 'var(--warn)' : 'var(--muted)'; }
  };
  const picked = T.pieces.filter((p) => T.picked.has(p.key));
  if (!picked.length) return say('Tick some water first — this builds the day around what you pick.', true);

  const castable = TACKLE_INVENTORY.filter((l) => l.trollable || l.castable);

  // SAME PROMPT AS THE SMART PLAN TAB, because there is no reason a plan should carry less just
  // for having been chosen off the map. Without this, picking water inside a coastal zone got a
  // prompt that had never been told this is a 12.5 ft kayak on an estuary — two plans behaving
  // differently on the same boat on the same water, which is the divergence this file's own
  // header warns about.
  say('Reading the water…');
  const waterState = await fetchWaterState(T.lake, T.dateStr, {
    worker: CF_WORKER_URL, launchTime: T.launchTime, species: T.species,
    point: T.ramp ? { lat: T.ramp[1], lon: T.ramp[0] } : undefined,
  });

  say('Asking the model for baits and speeds…');
  let r;
  try {
    r = await planFromWater({
      picked,
      spots: T.spots,
      // WHAT HE TICKED, not what the app thinks is nearby. A spot he chose is a commitment the day
      // has to carry; the rest are still sent so the model can suggest one, but only these are his.
      chosenSpotKeys: [...T.pickedSpots],
      ramp: T.ramp,
      slug: T.r2Key,
      usableAh: T.usableAh,
      windowMin: T.windowMin,
      launchTime: T.launchTime,
      returnTime: T.returnTime,
      planArgs: {
        // Blank means "no opinion", which is NOT the same as zero. parseInt('') is NaN, so the
        // guard has to be explicit or an empty box would silently ask for no stops at all.
        castStopsWanted: (() => {
          const raw = ($('wgStops')?.value ?? '').trim();
          if (!raw) return null;
          const n = parseInt(raw, 10);
          return Number.isFinite(n) && n >= 0 ? n : null;
        })(),
        water: T.lake, ramp: T.rampName, date: T.dateStr,
        launchTime: T.launchTime, returnTime: T.returnTime,
        species: [T.species], usableAh: T.usableAh,
        tackle: castable.map((l) => l.name),
        // THE THREE FIELDS buildPlanRequest READS THAT THIS PATH NEVER SENT.
        //
        // Ryan, 2026-08-30, on a Pick Water plan for Lake Wateree: "so that note shows up but the
        // plan actually shows the research profile". Both halves are true and that is the bug.
        // The plan card's briefing is assembled by lake-intel from the profile; the PROMPT got
        // `intel: undefined`, fell to "NOTHING. No researched profile exists for this water", and
        // the model dutifully wrote it into the rationale: "Since no profile exists for this
        // water, rely on sonar". Wateree's profile is v140.0 at 96% confidence, 66 ft max depth,
        // a 27 ft summer thermocline, and Pick Water was loading it -- for `depthBandFor` only,
        // three lines up -- and then throwing it away.
        //
        // Smart Plan has sent `intel` since 2026-08-07. Two planners, one prompt, one of them
        // filling it.
        intel: T.intel,
        hazards: T.hazards,
        snapEligible: snapEligibleFrom(castable),
        // `castable` is `trollable || castable` -- the whole bag. Which half may go behind the
        // boat has to be said, or a cast-only soft plastic looks like a crankbait to the model.
        trollable: castable.filter((l) => l.trollable).map((l) => l.name),
        // THE SAME OBJECT SMART PLAN SENDS, from the same builder. This was `{ ft, holding,
        // meaning }` -- the word "suspended" with nothing attached to it, and no `note`, which
        // is the only place the prompt is told what holding MEANS. Ryan, 2026-08-30: "this thing
        // still has no understanding of suspended fish."
        // FROM `T`, BECAUSE `date` LIVES IN findWater() AND THIS IS NOT findWater().
        //
        // It was `getSeason(date)` and it threw "date is not defined" on every press of Build the
        // day from what I picked -- a ReferenceError, so the whole build died before it reached
        // the model. Ryan found it the first time he pressed the button after I added the line.
        // `T.dateStr` is what findWater() stored for exactly this, and line 618 builds the same
        // Date from it the same way.
        conditions: { depthBand: describeDepthBand(T.depth, T.species,
                                                   getSeason(new Date(`${T.dateStr}T12:00:00`),
                                                             T.waterTempF)) },
        waterState,
      },
      askModel: modelAsker(CF_WORKER_URL),
      // FOR planArgsFrom(), which validates the model's answer before the assembler sees it.
      // `tackle` is what the bag actually holds, so a lure the model invented is caught by name;
      // `connectionOf` is how a lure gets seated on a rod that can carry it — tie-only lures onto
      // the fluoro rods, snap-friendly onto the snap rods. Without both, that pass runs blind.
      tackle: castable.map((l) => l.name),
      connectionOf: (name) => {
        const hit = TACKLE_INVENTORY.find((l) => l.name === name);
        return hit ? connectionFor(hit.type) : null;
      },
      // The loadout carries a lure NAME; the depth maths needs the inventory object, because
      // LURE_KNOWLEDGE is keyed by `type` and the lead ratio scales on `weightOz`. Without this
      // the bait-depth ceiling is simply not checked — see capBaitDepth() in plan-assemble.js.
      lureByName: (name) => {
        const n = String(name || '').trim().toLowerCase();
        return n ? TACKLE_INVENTORY.find((l) => String(l.name).toLowerCase() === n) || null : null;
      },
      // `routeWater`, NOT `transit`. `transit` is the SYNCHRONOUS lookup the assembler walks leg
      // by leg; `routeWater` is the async fetcher planFromWater() prefetches every pair with.
      // Handing the fetcher over as `transit` is half of what broke the build on 2026-08-11 —
      // see the note in plan-from-water.js.
      // HIS FLOOR, ASKED FOR DIRECTLY. See waterRouter() for why nobody had ever sent one.
      routeWater: waterRouter(CF_WORKER_URL, T.r2Key, { minDepthFt: TRANSIT_MIN_DEPTH_FT }),
    });
  } catch (e) { return say(`Failed: ${e.message}`, true); }

  if (!r.plan) return say((r.problems && r.problems[0]) || 'No plan', true);

  // WHAT THE MODEL GOT WRONG, ON SCREEN. Every one of these was being computed and discarded:
  // a rod the boat does not carry, a lure the bag does not hold, a leg with no rods deployed, a
  // bait shortened to clear a shoal. The Smart Plan tab has always shown them.
  // AN OVERRIDE THAT HAPPENS SILENTLY IS THE SAME AS NO OVERRIDE. Same note, same reason, as the
  // Smart Plan path: when the water overrules the calendar it changes the depth band, the
  // structure weights and which research entry was read, and he has to be able to see it.
  const sn = seasonNote(new Date(`${T.dateStr}T12:00:00`), T.waterTempF);
  if (sn) r.problems = [...(r.problems || []), sn];

  if (r.problems && r.problems.length) {
    console.warn('[pick-water] the plan came back with %d problem(s):', r.problems.length);
    for (const p of r.problems) console.warn('  •', p);
  }

  const built = planToTimeline(r.plan, {
    depthBand: T.band,
    holding: T.holding || null,
    warnings: r.problems || [],
    rationale: (r.plan.notes && (r.plan.notes.scoutNotes || r.plan.notes.sonar)) || '',
  });
  installTimeline(window, built);
  renderSmartPlanUI({
    routeRods: built.routeRods, routeSpeeds: built.routeSpeeds,
    speedMph: built.cards[0] ? built.cards[0].speedMph : TROLL_MPH,
    stopCandidates: built.stopCandidates,
    scoutReport: built.rationale,
    cardDefs: built.cards, unified: built.timeline,
  });
  syncSpread(built.cards, built.routeRods, built.routeSpeeds);

  // THE PLAN HAS TO LEAVE THE APP OR IT IS NOT A PLAN, and this path had no way out.
  //
  // materialisePlan() had exactly one call site, in smart-plan-v2-wiring, so a day built from
  // picked water rendered on screen and wrote NOTHING to state.DATA -- no tracks, no waypoints,
  // and every export silently empty. That is the same failure the v2 comment records against its
  // own earlier self: `"gpx": { "tracks": 0, "trackPoints": 0 }` on a day describing miles of
  // trolling.
  //
  // `marks: true` because this is the path that was built for the Echomap comparison: charted
  // structure goes out as waypoints so the sounder can be held against the chart.
  // PUBLISH THE PLAN THIS DAY WAS BUILT FROM.
  //
  // window._planV2 was written by smart-plan-v2-wiring and by nothing else, and plan-builder's
  // exporter reads it unconditionally. So a Pick Water day exported with the PREVIOUS Smart Plan
  // run's budget, legs, warnings and safety attached: measured on two exports of the same lake,
  // the Pick Water file carried 5 legs / 7,349 m / 14.08 Ah / 131 min against its own timeline of
  // 8 legs / 29,284 m, and a warning naming `wateree_lake#304`, a leg that day never had.
  //
  // materialisePlan() is already being handed r.plan on the next line, so the plan was here the
  // whole time — it simply was not the one anything downstream could see.
  window._planV2 = r.plan;
  window._planV2Result = r;
  const gpx = materialisePlan(r.plan, { launch: T.ramp, win: window, marks: true });
  window._planV2Gpx = gpx;
  renderAll();

  // WHAT THE DAY HAS TO SAY, HANDED TO THE THING THAT CAN SAY IT. The phone is not the interface:
  // "other than using it to take photos i really do not use it much... that is why we have the
  // notifications being sent to the echomap". notifications.js forwards to the Echomap over
  // ActiveCaptain and had zero importers, so every cue this plan produces had nowhere to go.
  // THE LIVE HAZARD POLL WAS NEVER STARTED ON THIS PATH. `loadSessionFromPlan` only arms it
  // when it is handed a worker URL and somewhere to ask about, and this call passed neither --
  // so `pollHazards()` returned on its first line, every five minutes, forever, while the Smart
  // Plan path a few files away polled correctly. Two entry points into one feature and only one
  // of them switched it on; found 2026-08-25 auditing the alert chain, which had never run in
  // the field. `T.ramp` is the launch this day was costed from, so it is the right place to ask
  // about until the boat reports a position of its own.
  const cues = loadSessionFromPlan(r.plan, {
    weatherByHour: T.weatherByHour,
    worker: CF_WORKER_URL,
    launch: launchFrom(T.ramp),
    date: T.dateStr || T.date || null,
    // This path computes no solunar, so it hands over none. The return time it does know, and
    // that is what the watch expires on.
    returnTime: T.returnTime || null,
  });

  // SAY THE ORDER OUT LOUD AND SAY IT IS NOT THE SHORT ONE. Silently reordering what he ticked is
  // how a search reads as a mistake -- § 14 gives him veto, and a veto needs something to look at.
  const seq = r.order.map((i) => T.pieces.indexOf(picked[i]) + 1).join(' → ');
  // THE REAL CLOCK, OFF THE ASSEMBLED PLAN, NOT THE STRAIGHT-LINE ESTIMATE.
  //
  // Ryan, 2026-08-11: "the picked water doesn't take into account transit time so it told me 6
  // hours of time but when i got the plan tab i was at almost 10 hours on the water."
  //
  // dayCost() DOES count transit — but at straight-line distance, against the CHEAPEST ordering,
  // and it says so in its own source: "A straight line is always the OPTIMISTIC answer." On
  // Wateree that understates it badly. Measured off his own saved plan: 6.2 mi of straight-line
  // moving became 17.9 mi over the water graph, 2.9x, because a lake with 257 km of shoreline
  // makes every straight line cross a peninsula. 306 minutes of transit against 286 of trolling —
  // the deadheading was the longer half of the day and the tab had quoted 100 minutes of it.
  //
  // The estimate stays where it is: it is instant, it is what makes ticking boxes feel live, and
  // it is honestly labelled a floor. But once the plan is BUILT the routed answer exists, so this
  // reports that one and names the gap rather than leaving two numbers to be discovered.
  const realMin = (r.plan.legs || []).reduce((s, l) => s + (l.estDurationMin || 0), 0);
  const est = r.dayCost.min;
  const clock = realMin > 0
    ? `${fmtHm(realMin)} on the water${realMin - est >= 20
        ? ` — ${fmtHm(realMin - est)} more than the ${fmtHm(est)} estimate, because the transits `
          + `are routed round the points rather than straight through them`
        : ''}. `
    : '';
  say(`Built ${picked.length} legs, fished ${seq} — most diagnostic first, so a leg that produces `
    + `nothing still tells you something. That is a search order, not the shortest route. `
    + `${clock}${r.dayCost.ah} Ah of ${T.usableAh}. ${gpx.tracks} tracks and ${gpx.waypoints} waypoints `
    + `for the Echomap — the charted structure is in there to check against the sounder. `
    + `${cues.positionCues} alerts loaded`
    + `${cues.weatherCues ? ` and ${cues.weatherCues} weather` : ''}`
    + `${isEnabled() ? '' : ' (turn alerts on to get them)'}. `
    + `Open the Smart Plan tab to see it.`);
  document.querySelector('#planSubtabs button[data-plansub="plan"]')?.click();
  return r;
}

export function initWaterTab() {
  // SAY WHAT THE TAB IS BEFORE IT HAS ANYTHING TO SHOW. An empty panel with one button reads as
  // broken -- which is exactly how it read on 2026-08-11 when the panel really was broken, and
  // the blankness gave no way to tell the two apart.
  const s = $('wgStatus');
  if (s) {
    s.textContent = 'Set the lake, ramp, date and species on the Smart Plan tab \u2014 this reads '
      + 'the same form \u2014 then press Find water. Depths here are MINIMUM WATER DEPTH, not '
      + 'bait depth.';
  }
  total();
  $('wgFind')?.addEventListener('click', () => findWater());
  $('wgBuild')?.addEventListener('click', () => buildFromPicked());
  $('wgSort')?.addEventListener('change', (e) => { T.sortBy = e.target.value; paint(); });
  $('wgLimit')?.addEventListener('change', (e) => {
    T.limit = Math.max(1, parseInt(e.target.value, 10) || 25); paint();
  });
  // The chips repaint the list, so they are a click and not a change. Repainting loses nothing:
  // T.pickedSpots is the source of truth for a tick and spotRow() reads it back.
  $('wgSpots')?.addEventListener('click', (e) => {
    if (e.target?.closest?.('[data-more]')) { T.spotLimit += 60; paintSpots(); return; }
    const btn = e.target?.closest?.('[data-kind]');
    if (!btn) return;
    // Changing the kind starts the window over -- 300 rows of ledge then 30 of cove would be
    // the old trapdoor wearing the filter's clothes.
    T.spotLimit = 30;
    const k = btn.dataset.kind;
    if (!k) T.spotKinds.clear();
    else if (T.spotKinds.has(k)) T.spotKinds.delete(k);
    else T.spotKinds.add(k);
    paintSpots();
  });
  $('wgSpots')?.addEventListener('change', (e) => {
    const k = e.target?.dataset?.spot;
    if (!k) return;
    if (e.target.checked) T.pickedSpots.add(k); else T.pickedSpots.delete(k);
    e.target.closest('.wg-spot')?.classList.toggle('picked', e.target.checked);
    total();
  });
  $('wgList')?.addEventListener('change', (e) => {
    const k = e.target?.dataset?.pick;
    if (!k) return;
    if (e.target.checked) T.picked.add(k); else T.picked.delete(k);
    // Repaint the map and the total, NOT the list — rebuilding the list under a click loses the
    // scroll position, and on 200 rows that is the difference between usable and infuriating.
    // Repaint only -- the canvas does not have to be rebuilt to change one lane's colour.
    paintMap(shown(), T.picked, T.ramp);
    e.target.closest('.wg-row')?.classList.toggle('picked', e.target.checked);
    // Spots are priced against the ticked water, so ticking water reprices every one of them.
    paintSpots();
    total();
  });
  // TAKING A JOIN. The two halves come off the list and the run they make goes on, ticked --
  // because the thing he chose is the run, not a pair of pieces he now has to remember belong
  // together. joinedPiece() builds it in the same shape buildPieces() does, so nothing below
  // this line knows a join happened.
  $('wgList')?.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('button.wg-join');
    if (!btn) return;
    const j = T.joins[Number(btn.dataset.join)];
    if (!j) return;
    const merged = joinedPiece(T.pieces, j);
    if (!merged) return;
    const key = `j${T.joinsTaken++}`;
    // Everything row() reads that a fresh piece does not carry. `partners` is [] rather than
    // recomputed: ladderPartners() ranks the pieces it was given, and this run was not one of
    // them -- claiming a lap onto water measured against its halves would be a guess.
    const piece = { ...merged, key, partners: [],
                    shallowSide: null, shoreAspect: null,
                    reasons: reasons(merged, { minM: T.minM, fishBandFt: T.band,
                                               holding: T.holding, partners: [] }),
                    joins: [] };
    T.pieces.push(piece);
    for (const p of T.pieces) {
      if (p.runId === merged.joinedFrom[0] || p.runId === merged.joinedFrom[1]) T.picked.delete(p.key);
    }
    T.picked.add(key);
    paint();
  });

  // CLICKING THE WATER IS THE SAME ACT AS TICKING THE ROW, and on a canvas that means finding
  // the lane yourself. The SVG version read `data-key` off the path under the cursor; there are
  // no paths now, so the click is projected back through the same X/Y the paint used and the
  // nearest lane inside a finger's width wins. Anything further away is a click on the chart,
  // which is not a pick -- it should not silently tick the lane on the other side of the cove.
  document.addEventListener('click', (e) => {
    const cv = e.target;
    if (!cv || cv.id !== 'wgMap' || !T.mapHit) return;
    const r = cv.getBoundingClientRect();
    const sx = T.mapHit.w / r.width;                       // CSS pixels -> the paint's own space
    const px = (e.clientX - r.left) * sx, py = (e.clientY - r.top) * sx;
    const { X, Y } = T.mapHit;
    let best = null, bd = 14 * sx;
    for (const q of shown()) {
      for (const c of (q.coords || [])) {
        const d = Math.hypot(X(c) - px, Y(c) - py);
        if (d < bd) { bd = d; best = q.key; }
      }
    }
    if (!best) return;
    const box = document.querySelector(`input[data-pick="${CSS.escape(best)}"]`);
    if (box) { box.checked = !box.checked; box.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  console.log('[plan-water-ui] ready');
}
