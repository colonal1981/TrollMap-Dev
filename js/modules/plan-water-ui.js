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
import { getSeason } from '../data/species-intel.js';
import { depthBandFor, usableAhFrom } from './plan-inputs.js';
import { packFetcher } from './smart-plan-v2.js';
import { fetchForecast } from './plan-preflight.js';
import { offerWater, dayCost, priceSpots, searchOrder, TROLL_MPH } from './plan-water.js';
import { planFromWater } from './plan-from-water.js';
import { buildSmartPlanV2, modelAsker, waterRouter } from './smart-plan-v2.js';
import { planToTimeline, installTimeline } from './plan-to-timeline.js';
import { renderSmartPlanUI, syncSpread } from './smart-plan-ui.js';
import { TACKLE_INVENTORY } from '../data/tackle-inventory.js';
import { readInputs, rampCoords } from './smart-plan-v2-wiring.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mi = (m) => m / 1609.34;
const fmtMi = (m) => `${mi(m).toFixed(mi(m) < 1 ? 2 : 1)} mi`;
const fmtHm = (min) => `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m`;

/** Everything the tab is currently looking at. Not on `window`; the module owns it. */
const T = { pieces: [], picked: new Set(), ramp: null, rampName: '', usableAh: 0,
            windowMin: null, band: null, holding: null, sortBy: 'ramp', lake: '', limit: 25,
            spots: [], species: '', r2Key: '', dateStr: '', launchTime: '', returnTime: '',
            windByHour: null };

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
// THE MAP — every piece at once, so a choice is a place and not a row number.
// ─────────────────────────────────────────────────────────────────────────────────────────────
function mapSvg(pieces, picked, ramp, w = 560, h = 420) {
  const all = pieces.flatMap((p) => p.coords || []);
  if (all.length < 2) return '';
  const lons = all.map((c) => c[0]), lats = all.map((c) => c[1]);
  const lo0 = Math.min(...lons), lo1 = Math.max(...lons);
  const la0 = Math.min(...lats), la1 = Math.max(...lats);
  // Metres, not degrees. Projecting raw degrees squashes a lake at 34 N by about 17% and it looks
  // like a bug in the fitter rather than a bug in the drawing.
  const kx = 111320 * Math.cos(((la0 + la1) / 2) * Math.PI / 180), ky = 110540;
  const wM = (lo1 - lo0) * kx, hM = (la1 - la0) * ky;
  const s = Math.min((w - 16) / Math.max(1, wM), (h - 16) / Math.max(1, hM));
  const ox = (w - wM * s) / 2, oy = (h - hM * s) / 2;
  const X = (c) => ox + (c[0] - lo0) * kx * s;
  const Y = (c) => h - oy - (c[1] - la0) * ky * s;
  const path = (co) => `M ${co.map((c) => `${X(c).toFixed(1)} ${Y(c).toFixed(1)}`).join(' L ')}`;

  const lines = pieces.map((p) => {
    const on = picked.has(p.key);
    return `<path d="${path(p.coords)}" fill="none" stroke="${on ? '#76ff03' : '#3d6b93'}" `
         + `stroke-width="${on ? 3 : 1.4}" stroke-linecap="round" opacity="${on ? 1 : 0.7}" `
         + `data-key="${esc(p.key)}" class="wg-line"><title>${esc(p.runId || p.key)} — `
         + `${fmtMi(p.lengthM)} at ${p.holdsFt} ft</title></path>`;
  }).join('');

  const rampDot = ramp
    ? `<circle cx="${X(ramp).toFixed(1)}" cy="${Y(ramp).toFixed(1)}" r="5" fill="#ffd54f" `
      + `stroke="#0d1a2a" stroke-width="1.5"><title>launch</title></circle>`
    : '';

  return `<svg id="wgMap" viewBox="0 0 ${w} ${h}" role="img" aria-label="water on this lake">`
       + `<rect x="0" y="0" width="${w}" height="${h}" fill="#0b1622" />${lines}${rampDot}</svg>`;
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
    ${strip(p, T.band)}
    <ul class="wg-for">${r.for.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
    <ul class="wg-against">${r.against.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
  </div>`;
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
  const bits = [
    `<b>${picked.length}</b> piece${picked.length > 1 ? 's' : ''}`,
    `${fmtMi(d.trollM)} trolling`,
    `${fmtMi(d.moveM)} moving`,
    `${fmtHm(d.min)}`,
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
function shown() {
  const sorted = [...T.pieces].sort((a, b) => {
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

function paint() {
  const list = shown();
  const el = $('wgList');
  if (el) el.innerHTML = list.map(row).join('');
  // THE MAP DRAWS WHAT THE LIST DRAWS. Drawing all 211 pieces while listing 12 of them put the
  // whole lake on screen with the twelve invisible inside it -- the map has to answer "where is
  // row 4", and it cannot do that at lake scale.
  const map = $('wgMap')?.parentElement;
  if (map) map.innerHTML = mapSvg(list, T.picked, T.ramp);
  const n = $('wgCount');
  if (n) {
    n.textContent = T.pieces.length > T.limit
      ? `showing ${T.limit} of ${T.pieces.length} — change the sort to see different water`
      : `${T.pieces.length} piece${T.pieces.length === 1 ? '' : 's'}`;
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
  const depth = depthBandFor(species, inp.lakeName, getSeason(date), inp.waterTempF, null);

  say('Reading the pack…');
  const fc = await packFetcher(CF_WORKER_URL)(`/${r2Key}/trolling_runs.geojson`);
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

  say('Measuring the water…');
  let out;
  try {
    out = offerWater(lanes, {
      minM,
      fishBandFt: depth ? depth.band : null,
      holding: depth ? depth.holding : null,
      windByHour: forecast ? forecast.windByHour : null,
      ramps: [{ name: inp.rampName || 'launch', lonLat: ramp }],
    });
  } catch (e) { return say(e.message, true); }

  Object.assign(T, {
    pieces: out.pieces, spots: out.spots || [], picked: new Set(),
    ramp, rampName: inp.rampName || 'launch',
    species, r2Key, dateStr: inp.dateStr, windByHour: forecast ? forecast.windByHour : null,
    launchTime: inp.launchTime, returnTime: inp.returnTime,
    usableAh: usableAhFrom(inp.motor), band: depth ? depth.band : null,
    holding: depth ? depth.holding : null, lake: inp.lakeName,
    windowMin: (() => {
      const p = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : null; };
      const a = p(inp.launchTime), b = p(inp.returnTime);
      return a != null && b != null && b > a ? b - a : null;
    })(),
  });
  paint();
  const withLaps = out.pieces.filter((p) => p.partners.length).length;
  say(`${out.laneCount} charted lanes → ${out.pieces.length} pieces of water, `
    + `${withLaps} with somewhere to turn onto. Depths are MINIMUM WATER DEPTH, not bait depth.`);
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
  say('Asking the model for baits and speeds…');
  let r;
  try {
    r = await planFromWater({
      picked,
      spots: T.spots,
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
        conditions: { depthBand: { ft: T.band, holding: T.holding || 'unknown',
                                   meaning: 'where the fish are, not the depth of the water' } },
      },
      askModel: modelAsker(CF_WORKER_URL),
      transit: waterRouter(CF_WORKER_URL, T.r2Key),
    });
  } catch (e) { return say(`Failed: ${e.message}`, true); }

  if (!r.plan) return say((r.problems && r.problems[0]) || 'No plan', true);

  const built = planToTimeline(r.plan, {
    depthBand: T.band,
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

  // SAY THE ORDER OUT LOUD AND SAY IT IS NOT THE SHORT ONE. Silently reordering what he ticked is
  // how a search reads as a mistake -- § 14 gives him veto, and a veto needs something to look at.
  const seq = r.order.map((i) => T.pieces.indexOf(picked[i]) + 1).join(' → ');
  say(`Built ${picked.length} legs, fished ${seq} — most diagnostic first, so a leg that produces `
    + `nothing still tells you something. That is a search order, not the shortest route. `
    + `${r.dayCost.ah} Ah of ${T.usableAh}. Open the Smart Plan tab to see it.`);
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
  $('wgList')?.addEventListener('change', (e) => {
    const k = e.target?.dataset?.pick;
    if (!k) return;
    if (e.target.checked) T.picked.add(k); else T.picked.delete(k);
    // Repaint the map and the total, NOT the list — rebuilding the list under a click loses the
    // scroll position, and on 200 rows that is the difference between usable and infuriating.
    const map = $('wgMap')?.parentElement;
    if (map) map.innerHTML = mapSvg(shown(), T.picked, T.ramp);
    e.target.closest('.wg-row')?.classList.toggle('picked', e.target.checked);
    total();
  });
  // Clicking the water is the same act as ticking the row.
  document.addEventListener('click', (e) => {
    const k = e.target?.closest?.('.wg-line')?.dataset?.key;
    if (!k) return;
    const box = document.querySelector(`input[data-pick="${CSS.escape(k)}"]`);
    if (box) { box.checked = !box.checked; box.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  console.log('[plan-water-ui] ready');
}
