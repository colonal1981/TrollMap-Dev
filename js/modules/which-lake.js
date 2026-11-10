/**
 * which-lake.js -- the "Which lake?" card on the planner tab: his lakes, best first, for the day's wind (change
 * request 85).
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-11-09, planning Wednesday 11/11: "for wednesday i am looking to go fishing but i am concerned about the
 * wind possibly... the app should be able to check the forecast for the main lakes near me and tell me which one is
 * the best for the forecast".
 *
 * NOTHING HERE IS A NEW RULE. Each piece is one the plans already use:
 *   - the fish: checkPlanLegality(), the check that refuses a plan for a closed fish. His words, 11/9: "just use the
 *     same logic that prevents a plan being made during a closure".
 *   - the wind: fetchForecast(), the plans' own forecast (the National Weather Service blend), asked at his ramp.
 *   - the waves: wind-waves.js, the Shore Protection Manual formula the plans measure each leg with, against his 1 ft
 *     (TOO_ROUGH_FT, item 22) and the plans' no-go (NO_GO_SUSTAINED_MPH, NO_GO_GUST_MPH).
 *
 * WHAT IS MINE, AND SAID ON THE CARD: the water weighed is the open water within 3 miles of the ramp (NEAR_RAMP_M),
 * because his own account of the Wateree day was the distance from the ramp ("The routes would have taken me way too
 * far from the ramp with 1-2 ft swells due to the wind"); and the order -- under 1 ft all day first, then the most
 * water under 1 ft at the roughest hour.
 */

import { waveHeightFt, TOO_ROUGH_FT, NO_GO_SUSTAINED_MPH, NO_GO_GUST_MPH } from '../utils/wind-waves.js';

export const NEAR_RAMP_M = 4828;          // 3 miles
const GRID = 24;                          // cells across the circle; about 450 inside it before land is dropped
const M_PER_DEG = 111320;

const round1 = (x) => Math.round(x * 10) / 10;
const hh = (h) => `${String(h).padStart(2, '0')}:00`;

/**
 * Points on the water within `radiusM` of the ramp, on a square grid -- the water a day from this ramp is fished on.
 * @param {function(number, number): boolean} inside   waterTest() of the boundary
 * @param {number[]} at   the ramp, [lon, lat]
 * @returns {number[][]}  [[lon, lat], ...], [] when nothing is on the water
 */
export function waterNearRamp(inside, at, radiusM = NEAR_RAMP_M, n = GRID) {
  if (typeof inside !== 'function' || !Array.isArray(at) || !at.every(Number.isFinite)) return [];
  const [lon0, lat0] = at;
  const kx = M_PER_DEG * Math.cos(lat0 * Math.PI / 180), ky = M_PER_DEG;
  const cell = (2 * radiusM) / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = -radiusM + (i + 0.5) * cell, y = -radiusM + (j + 0.5) * cell;
      if (x * x + y * y > radiusM * radiusM) continue;
      const p = [lon0 + x / kx, lat0 + y / ky];
      if (inside(p[0], p[1])) out.push(p);
    }
  }
  return out;
}

/**
 * The waves on that water hour by hour: the worst of them, and how much of the water stays under his limit.
 * Rounded to a tenth before it is compared, the way roughLegs() compares a leg.
 * @param {number[][]} points   waterNearRamp()
 * @param {function} rays       shoreRays() of the boundary
 * @param {{hour:number, mph:number, deg:number, gustMph?:number}[]} windByHour
 * @returns {?{hours:object[], worstFt:number, worstHour:number, calmAtWorst:number, roughHours:number[], points:number}}
 */
export function dayWaves(points, rays, windByHour, limitFt = TOO_ROUGH_FT) {
  if (!Array.isArray(points) || !points.length || typeof rays !== 'function' || !Array.isArray(windByHour)) return null;
  const fetches = points.map(() => new Map());     // the fetch depends only on the direction
  const fetchOf = (i, deg) => {
    const m = fetches[i];
    if (!m.has(deg)) m.set(deg, rays(points[i][0], points[i][1], deg));
    return m.get(deg);
  };
  const hours = [];
  let measured = 0;
  for (const w of windByHour) {
    const mph = Number(w && w.mph), deg = Number(w && w.deg);
    if (!Number.isFinite(mph) || !Number.isFinite(deg)) continue;
    let worst = 0, calm = 0, n = 0;
    for (let i = 0; i < points.length; i++) {
      const f = fetchOf(i, deg);
      if (f == null) continue;
      const ft = round1(waveHeightFt(mph, f));       // no depth: deep water, the higher answer
      n += 1;
      if (ft > worst) worst = ft;
      if (ft < limitFt) calm += 1;
    }
    if (!n) continue;
    measured = Math.max(measured, n);
    hours.push({ hour: w.hour, mph, deg, gustMph: Number.isFinite(Number(w.gustMph)) ? Number(w.gustMph) : null,
                 worstFt: worst, calmShare: calm / n });
  }
  if (!hours.length) return null;
  const top = hours.reduce((a, b) => (b.worstFt > a.worstFt ? b : a));
  return { hours, worstFt: top.worstFt, worstHour: top.hour, calmAtWorst: top.calmShare,
           roughHours: hours.filter((h) => h.worstFt >= limitFt).map((h) => h.hour), points: measured };
}

/** The day's wind, rain and thunder at one ramp, off fetchForecast()'s answer. */
export function dayWeather(forecast) {
  const wind = (forecast && forecast.windByHour) || [];
  const wx = (forecast && forecast.weatherByHour) || [];
  if (!wind.length) return null;
  const top = wind.reduce((a, b) => (Number(b.mph) > Number(a.mph) ? b : a));
  const gusts = wind.map((w) => Number(w.gustMph)).filter(Number.isFinite);
  const over = wind.filter((w) => Number(w.mph) > NO_GO_SUSTAINED_MPH || Number(w.gustMph) > NO_GO_GUST_MPH);
  return {
    minMph: Math.min(...wind.map((w) => Number(w.mph))), maxMph: Number(top.mph), fromDeg: Number(top.deg),
    maxGust: gusts.length ? Math.max(...gusts) : null,
    noGo: over.map((w) => ({ hour: w.hour, mph: Number(w.mph), gustMph: Number(w.gustMph) })),
    thunder: wx.filter((e) => e.thunder).map((e) => e.hour),
    rain: wx.filter((e) => e.rain && !e.thunder).map((e) => e.hour),
    model: (forecast && forecast.windModel) || null,
  };
}

/** Best first, as the card says: storms and no-go wind last, then under 1 ft all day, then the most calm water. */
function rankKey(r) {
  const w = r.waves, x = r.weather;
  const hazard = x && (x.thunder.length || x.noGo.length) ? 1 : 0;
  if (!w) return [r.fallback ? 1 : 0, 1, hazard, 0, 0, 0];
  const rough = w.roughHours.length ? 1 : 0;
  return [r.fallback ? 1 : 0, 0, hazard, rough, rough ? -w.calmAtWorst : w.worstFt, w.worstFt,
          (x && x.maxGust) || 0];
}
const byKey = (a, b) => {
  const ka = rankKey(a), kb = rankKey(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
};

/**
 * Of a lake's ramps, the one to put in at. "first" is his order (Pack's before Low Falls); "sheltered" is Monticello's,
 * "whichever one is more protected on that day of the 2 ramps", by the same order the lakes are ranked in.
 */
export function pickRamp(options, pick) {
  const ok = (options || []).filter(Boolean);
  if (!ok.length) return null;
  if (pick !== 'sheltered' || ok.length < 2) return { best: ok[0], others: ok.slice(1) };
  const sorted = [...ok].sort(byKey);
  return { best: sorted[0], others: sorted.slice(1) };
}

/** The lakes, best first; Bates last whatever its numbers, because it is his fallback. */
export function rankLakes(rows) {
  return [...(rows || [])].sort(byKey);
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

/** "11:00–13:00, 15:00" */
export function hoursText(hours) {
  const hs = [...new Set((hours || []).filter(Number.isFinite))].sort((a, b) => a - b);
  const runs = [];
  for (const h of hs) {
    const last = runs[runs.length - 1];
    if (last && h === last[1] + 1) last[1] = h; else runs.push([h, h]);
  }
  return runs.map(([a, b]) => (a === b ? hh(a) : `${hh(a)}–${hh(b)}`)).join(', ');
}

/**
 * The sentences of one lake's row. `model` is the wind model the card's footer names; a row whose wind came from
 * another (the blend had no answer for that ramp) says so on the row.
 */
export function rowLines(r, limitFt = TOO_ROUGH_FT, model = null) {
  const lines = [];
  const w = r.waves, x = r.weather;
  const miles = Math.round(NEAR_RAMP_M / 1609.344);
  if (!x) lines.push('No forecast for this ramp on that date yet.');
  else if (!w) lines.push(`The waves could not be measured: ${r.why || 'no outline of this water to measure on'}.`);
  else if (!w.roughHours.length) {
    lines.push(`Waves under ${limitFt} ft on all the water within ${miles} mi of the ramp, all day `
             + `(at most ${w.worstFt.toFixed(1)} ft, ${hh(w.worstHour)}).`);
  } else {
    lines.push(`Waves reach ${w.worstFt.toFixed(1)} ft on the most open water within ${miles} mi at ${hh(w.worstHour)}; `
             + `${Math.round(w.calmAtWorst * 100)}% of that water stays under ${limitFt} ft then. `
             + `Over ${limitFt} ft somewhere ${hoursText(w.roughHours)}.`);
  }
  if (x) {
    const range = x.minMph === x.maxMph ? `${x.maxMph}` : `${x.minMph}–${x.maxMph}`;
    lines.push(`Wind ${compass(x.fromDeg)} ${range} mph${x.maxGust != null ? `, gusts to ${x.maxGust}` : ''}.`
             + (x.thunder.length ? ` Thunder ${hoursText(x.thunder)}.` : '')
             + (x.rain.length ? ` Rain ${hoursText(x.rain)}.` : '')
             + (!x.thunder.length && !x.rain.length ? ' No rain forecast.' : '')
             + (x.model && model && x.model !== model ? ` Wind from ${x.model} here.` : ''));
    if (x.noGo.length) {
      lines.push(`Over the plans' no-go (${NO_GO_SUSTAINED_MPH} mph sustained, ${NO_GO_GUST_MPH} gusting) `
               + `${hoursText(x.noGo.map((n) => n.hour))}.`);
    }
  }
  lines.push(`For ${r.species.join(', ')}.` + (r.closed && r.closed.length
    ? ` Not ${r.closed.map((c) => c.species).join(' or ')}: ${r.closed[0].reason}.` : ''));
  if (r.others && r.others.length) {
    const o = r.others[0];
    lines.push(`The more sheltered of its two ramps today; from ${o.ramp} the water reaches `
             + `${o.waves ? `${o.waves.worstFt.toFixed(1)} ft` : 'an unmeasured height'}.`);
  }
  if (r.other) lines.push(`${r.other} is the other way in.`);
  if (r.fallback) lines.push('Your fallback when the main lakes are too windy.');
  return lines;
}

/** The closed-fish reason the planner gives, cut at its quotation. */
export function shortReason(reason) {
  const s = String(reason || 'closed season or closed water');
  const i = s.indexOf(': "');
  return i > 0 ? s.slice(0, i) : s;
}

// ── THE CARD ─────────────────────────────────────────────────────────────────────────────────────────────────────

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** One lake: the fish that may be fished there that day, then each ramp's wind and waves. */
export async function weighLake(L, dateStr, launchTime, returnTime, deps) {
  const { ensureRegulations, checkPlanLegality, fetchForecast, packFetcher, CF_WORKER_URL, resolveR2Key,
          shoreRays, waterTest } = deps;
  const at = L.ramps[0].at;
  await ensureRegulations(L.lake, { worker: CF_WORKER_URL, at }).catch(() => false);
  const date = new Date(`${dateStr}T12:00:00`);
  const legal = [], closed = [];
  for (const s of L.species) {
    const g = checkPlanLegality(L.lake, s, date, { at });
    if (g.legal) legal.push(s); else closed.push({ species: s, reason: shortReason(g.reason) });
  }
  if (!legal.length) return { lake: L.lake, closed };
  const key = resolveR2Key(L.lake);
  const bd = key ? await packFetcher(CF_WORKER_URL)(`/${key}/boundary.geojson`) : null;
  const rays = bd ? shoreRays(bd) : null, inside = bd ? waterTest(bd) : null;
  const options = await Promise.all(L.ramps.map(async (R) => {
    const fc = await fetchForecast(L.lake, dateStr, { launchTime, returnTime, at: R.at, pressure: false });
    const weather = dayWeather(fc);
    const pts = inside ? waterNearRamp(inside, R.at) : [];
    const waves = weather && rays && pts.length ? dayWaves(pts, rays, fc.windByHour) : null;
    return { lake: L.lake, ramp: R.name, weather, waves, fallback: L.fallback,
             why: !bd ? 'no outline of this water in its chart pack' : (!pts.length ? 'no water near the ramp on the outline' : '') };
  }));
  const { best, others } = pickRamp(options, L.pick);
  return { ...best, others: L.pick === 'sheltered' ? others : [], species: legal, closed, other: L.other };
}

function rowHtml(r, i, model) {
  return `
    <button type="button" class="which-lake-row" data-lake="${esc(r.lake)}" data-ramp="${esc(r.ramp)}"
            style="display:block;width:100%;text-align:left;background:transparent;border:0;border-top:1px dashed var(--line);padding:8px 0;cursor:pointer;color:inherit">
      <div style="font-size:12px;color:var(--text)"><b style="color:var(--accent)">${i + 1}</b>&nbsp; <b>${esc(r.lake)}</b> · ${esc(r.ramp)}
        <span style="float:right;font-size:11px;color:var(--accent2)">Plan from here</span></div>
      ${rowLines(r, TOO_ROUGH_FT, model).map((l) => `<div style="font-size:11px;color:var(--muted);margin-top:2px">${esc(l)}</div>`).join('')}
    </button>`;
}

async function useLake(lake, ramp, say) {
  const lakeSel = document.getElementById('planLake'), rampSel = document.getElementById('planRamp');
  if (!lakeSel || !rampSel) return;
  if (![...lakeSel.options].some((o) => o.value === lake)) { say(`${lake} is not in the Waterbody list right now.`, true); return; }
  lakeSel.value = lake;
  lakeSel.dispatchEvent(new Event('change', { bubbles: true }));
  // The landings that reach a water arrive after the dropdown is first drawn (Bates' launch is one of them).
  for (let i = 0; i < 24 && ![...rampSel.options].some((o) => o.value === ramp); i++) {
    await new Promise((res) => setTimeout(res, 250));
  }
  if (![...rampSel.options].some((o) => o.value === ramp)) { say(`${ramp} did not appear in the Ramp list for ${lake}.`, true); return; }
  rampSel.value = ramp;
  rampSel.dispatchEvent(new Event('change', { bubbles: true }));
  say(`Set to ${lake} from ${ramp}.`);
}

async function runWhichLake() {
  const out = document.getElementById('whichLakeOut');
  if (!out) return;
  const say = (m, bad) => { out.innerHTML = `<div style="font-size:12px;color:${bad ? 'var(--warn)' : 'var(--muted)'}">${esc(m)}</div>`; };
  const species = [...document.querySelectorAll('#planSpeciesChecks input[type=checkbox]:checked')].map((c) => c.value);
  if (!species.length) { say('Tick a fish under Target Species first.', true); return; }
  const dateStr = document.getElementById('planDate')?.value || localToday();
  const launchTime = document.getElementById('planLaunchTime')?.value || '06:00';
  const returnTime = document.getElementById('planReturnTime')?.value || '15:00';
  const [{ lakesFor }, pf, sp, st, lk, ww, rd] = await Promise.all([
    import('../data/my-lakes.js'), import('./plan-preflight.js'), import('./smart-plan-v2.js'), import('../core/state.js'),
    import('../data/lake-keys.js'), import('../utils/wind-waves.js'), import('./river-drifts.js')]);
  const lakes = lakesFor(species, dateStr);
  say(`Checking the wind on ${lakes.length} lakes for ${dateStr}, ${launchTime}–${returnTime}…`);
  const deps = { ensureRegulations: pf.ensureRegulations, checkPlanLegality: pf.checkPlanLegality,
                 fetchForecast: pf.fetchForecast, packFetcher: sp.packFetcher, CF_WORKER_URL: st.CF_WORKER_URL,
                 resolveR2Key: lk.resolveR2Key, shoreRays: ww.shoreRays, waterTest: rd.waterTest };
  // ONE LAKE AT A TIME. Asked all at once on 2026-11-09 (his evening), the seven ramps' forecasts came back with two
  // missing outright and others off the default model instead of the National Weather Service blend -- Murray at 2-3 mph
  // where the blend, asked alone, had 0-5 gusting 10. Asked one after another, all seven came from the blend.
  const got = [];
  for (const L of lakes) {
    got.push(await weighLake(L, dateStr, launchTime, returnTime, deps)
      .catch((e) => ({ lake: L.lake, failed: (e && e.message) || 'failed' })));
  }
  const rows = rankLakes(got.filter((g) => g.ramp));
  const closed = got.filter((g) => !g.ramp && g.closed);
  const failed = got.filter((g) => g.failed);
  // The footer names the model most rows' wind came from; a row from another says so itself.
  const tally = new Map();
  for (const r of rows) if (r.weather && r.weather.model) tally.set(r.weather.model, (tally.get(r.weather.model) || 0) + 1);
  const model = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const miles = Math.round(NEAR_RAMP_M / 1609.344);
  out.innerHTML = `
    <div style="font-size:11px;color:var(--muted);margin-bottom:2px">${esc(dateStr)} · ${esc(launchTime)}–${esc(returnTime)} · ${esc(species.join(', '))}.
      Best first: storms and no-go wind last, then waves under ${TOO_ROUGH_FT} ft all day, then the most water under ${TOO_ROUGH_FT} ft at the roughest hour. Tap a lake to plan from it.</div>
    ${rows.length ? rows.map((r, i) => rowHtml(r, i, model)).join('') : '<div style="font-size:12px;color:var(--warn)">None of your lakes is open for that fish on that date.</div>'}
    ${closed.length ? `<div style="font-size:11px;color:var(--muted);border-top:1px dashed var(--line);padding-top:6px">Not that day: ${closed.map((c) => `${esc(c.lake)} — ${esc(c.closed.map((x) => x.reason).join('; '))}`).join(' · ')}</div>` : ''}
    ${failed.length ? `<div style="font-size:11px;color:var(--warn)">Could not check: ${esc(failed.map((f) => f.lake).join(', '))}.</div>` : ''}
    <div style="font-size:10px;color:var(--muted);margin-top:6px">Wind: ${esc(model || 'the plans’ forecast')}, at each ramp. Waves: the plans' fetch formula on open water within ${miles} mi of the ramp, against your ${TOO_ROUGH_FT} ft.</div>`;
  for (const b of out.querySelectorAll('.which-lake-row')) {
    b.addEventListener('click', () => useLake(b.dataset.lake, b.dataset.ramp, (m, bad) => {
      const s = document.getElementById('whichLakeStatus');
      if (s) { s.textContent = m; s.style.color = bad ? 'var(--warn)' : 'var(--accent2)'; }
    }));
  }
}

if (typeof document !== 'undefined') {
  document.getElementById('whichLakeBtn')?.addEventListener('click', () => {
    runWhichLake().catch((e) => {
      const out = document.getElementById('whichLakeOut');
      if (out) out.textContent = `Could not check the lakes: ${(e && e.message) || e}`;
    });
  });
}
