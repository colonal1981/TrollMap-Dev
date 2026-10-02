/**
 * moving-water.js -- when the water was being pulled, read off the gauges that show it.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Item 46 of APP_CHANGE_REQUESTS. Checked 2026-10-01 on two days of USGS 15-minute data: Jefferies'
 * tailrace (`02172002`) is plain on/off, and Monticello's level (`02160900`) falls in the evening
 * and refills in the morning (Fairfield pumped storage). Offered as "a moving-water line in the
 * plan, given as the last days' hours"; Ryan, 2026-10-02: "yeah go ahead on 46".
 *
 * WHICH GAUGES IS NOT DECIDED HERE. The first version named gauges for three lakes by hand, and
 * Ryan: "remember my rule no lake gets something that isn't available to all", then "build the
 * general version". They come from registry/moving_water_gauges.json, which
 * Scripts/build_moving_water.py derives for every lake from water_bindings.json and
 * water_chain.json: the lake's own level gauge, the first gauge below it on each river it empties
 * into, the last gauge above it on each river that feeds it. js/data/moving-water-gauges.js reads it.
 *
 * HISTORY, NOT A SCHEDULE. What each gauge did, said as such.
 *
 * WHAT IS SAID, BY WHAT THE GAUGE IS:
 *   - A FLOW THAT RUNS BACKWARDS gets the hours it ran: between runs something pushes back up it.
 *     Below Jefferies that is the tide; on the rediversion canal it was the water settling back
 *     after a surge, so the line says "flowing back upstream" and not why. There a run can be told
 *     from the back-flow without a number written here (tailraceCut(), below). Jefferies over 9/22-10/2 sits in three groups: -3,000 to 2,000
 *     cfs (the tide), 3,500 to 8,500 and 11,500 to 16,500. tailraceCut() splits (otsuSplit(), the
 *     value that best parts the readings into two groups), and splits the lower side again while
 *     the group it adds averages more than the strongest reverse flow -- the tide runs about as far
 *     forward as it pushes back. The reverse flow is read over a full spring-neap cycle (15 days):
 *     read over two neap days (9/26-9/28, reverse 1,120 cfs) the tide's own upper half averaged
 *     1,200 and the line said Jefferies ran at "about 1,000 cfs". Over the cycle the cut lands at
 *     3,065-3,395 cfs in every window checked, in the empty band between the tide and a run.
 *   - ANY OTHER FLOW OR LEVEL is given as each day's low and high and when, and nothing is decided
 *     about it. A dam that generates shows as a high many times its low; one that held steady shows
 *     as a low and a high a few cfs apart, and that is the answer. A threshold for "ran" on a
 *     river with no tide would be a number nobody measured.
 *   - A RIVER INTO THE LAKE is where it is now against two days before, and its range between.
 *
 * Two days is the window reported, the one the 10/1 check read and the one pressureTrend() uses:
 * two of a pattern that repeats daily. Pure: nothing here fetches. plan-preflight.js does.
 */

export const WINDOW_HOURS = 48;
/** A spring-neap cycle is 14.8 days; the tailrace's reverse flow is read over one whole. */
export const TIDE_CYCLE_DAYS = 15;

/** The value that best splits `values` into two groups (Otsu): most variance between them. */
export function otsuSplit(values) {
  const v = (values || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (v.length < 2 || v[0] === v[v.length - 1]) return null;
  const n = v.length;
  let total = 0;
  for (const x of v) total += x;
  let best = -1, split = null, sumLo = 0;
  for (let i = 0; i < n - 1; i++) {
    sumLo += v[i];
    if (v[i] === v[i + 1]) continue;
    const wLo = i + 1, wHi = n - wLo;
    const mLo = sumLo / wLo, mHi = (total - sumLo) / wHi;
    const between = wLo * wHi * (mLo - mHi) ** 2;
    if (between > best) { best = between; split = (v[i] + v[i + 1]) / 2; }
  }
  return split;
}

/**
 * The stretches of `series` where `test(point)` holds; a reading that fails it ends the stretch.
 * series: [{ t: epoch ms, v }] sorted by time.
 */
export function runsWhere(series, test) {
  const out = [];
  let cur = null;
  for (const p of series || []) {
    if (test(p)) {
      if (!cur) cur = { from: p.t, to: p.t, pts: [] };
      cur.to = p.t; cur.pts.push(p);
    } else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

const round = (x, to) => Math.round(x / to) * to;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

/**
 * "9/30 16:00-23:15", in the browser's clock, which is his. A run past midnight says so. A run of
 * one reading is that reading's time alone: "10/1 00:45-00:45" said a span that was not there.
 */
export function spanText(from, to) {
  const a = new Date(from), b = new Date(to);
  const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  if (a.getTime() === b.getTime()) return `${day(a)} ${hm(a)}`;
  return day(a) === day(b) ? `${day(a)} ${hm(a)}-${hm(b)}` : `${day(a)} ${hm(a)}-${day(b)} ${hm(b)}`;
}

/**
 * Where a tailrace counts as running: split, then split the lower side again while the group that
 * adds averages more than the strongest reverse flow. Null when not even the top group does.
 * `values` is the whole cycle fetched, not only the window reported.
 */
export function tailraceCut(values) {
  const vals = (values || []).filter(Number.isFinite);
  if (!vals.length) return null;
  const tide = Math.max(0, -Math.min(...vals));
  let cut = null, pool = vals;
  for (;;) {
    const s = otsuSplit(pool);
    if (s == null) break;
    const above = pool.filter((v) => v > s);
    if (!(mean(above) > tide)) break;
    cut = s;
    pool = pool.filter((v) => v <= s);
  }
  return cut;
}

/** The readings in the last `hours` before the newest one. */
export function lastHours(series, hours = WINDOW_HOURS) {
  if (!series || !series.length) return [];
  const end = series[series.length - 1].t;
  return series.filter((p) => p.t > end - hours * 3600e3);
}

/** "through 10/2 09:45" -- the newest reading, so a stale gauge says it is. */
function through(series) {
  const d = new Date(series[series.length - 1].t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * A flow below a lake that runs back upstream: the hours it ran in the last two days, each with its
 * flow, or that it did not. Why it runs back is not said. Below Jefferies it is the tide; on the
 * rediversion canal at St. Stephen (2026-10-02) it was the water settling back for a few hours after
 * a one-reading surge, and the canal otherwise ran its steady 100-200 cfs with no tide in it. A run
 * of one reading says so, with that reading.
 */
export function tailraceLine(g, series) {
  if (!series.length) return null;
  const win = lastHours(series);
  const cut = tailraceCut(series.map((p) => p.v));
  const runs = cut != null ? runsWhere(win, (p) => p.v > cut) : [];
  const head = gaugeHead(g);
  const low = Math.min(...win.map((p) => p.v));
  if (!runs.length) {
    return `${head}: did not run in the ${WINDOW_HOURS} hours through ${through(series)}; the highest `
      + `reading was ${round(Math.max(...win.map((p) => p.v)), 10).toLocaleString('en-US')} cfs.`;
  }
  const parts = runs.map((r) => (r.pts.length === 1
    ? `${spanText(r.from, r.to)} for one reading (${Math.round(r.pts[0].v).toLocaleString('en-US')} cfs)`
    : `${spanText(r.from, r.to)} (about ${round(mean(r.pts.map((p) => p.v)), 100).toLocaleString('en-US')} cfs)`));
  return `${head}: ran ${parts.join(', ')}, in the ${WINDOW_HOURS} hours through ${through(series)}.`
    + (low < 0 ? ` Between runs it reads near 0 and below, down to ${Math.round(low).toLocaleString('en-US')} cfs, `
      + 'flowing back upstream.' : '');
}

const UNIT = (g) => (g.param === '00060' ? 'cfs' : 'ft');
const fmt = (g, x) => (UNIT(g) === 'cfs' ? Math.round(x).toLocaleString('en-US') : x.toFixed(2));
const hm = (t) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const md = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };

/** Each local day in the readings: its low and its high, and when. */
export function dailyRange(series) {
  const by = new Map();
  for (const p of series || []) {
    const k = md(p.t);
    const d = by.get(k) || { day: k, lo: p, hi: p, first: p.t, last: p.t };
    if (p.v < d.lo.v) d.lo = p;
    if (p.v > d.hi.v) d.hi = p;
    d.last = p.t;
    by.set(k, d);
  }
  return [...by.values()];
}

/** What the gauge is, in the line: where it sits against the lake. */
export function gaugeHead(g) {
  const where = g.role === 'level' ? "the lake's own level"
    : g.role === 'outflow' ? `below the lake on ${g.viaName || g.via}${Number.isFinite(g.km) ? `, ${g.km} km from it` : ''}`
      : `on ${g.viaName || g.via}, which feeds the lake${Number.isFinite(g.km) ? `, ${g.km} km above it` : ''}`;
  return `${g.name} (USGS ${g.site}), ${where}`;
}

/** A flow or level given as each day's low and high, and when. Nothing decided about it. */
export function rangeLine(g, series) {
  const win = lastHours(series);
  if (!win.length) return null;
  // The first and last days are part days: the window starts and ends mid-day.
  const days = dailyRange(win).map((d) => `${d.day} low ${fmt(g, d.lo.v)} ${UNIT(g)} at ${hm(d.lo.t)}, `
    + `high ${fmt(g, d.hi.v)} at ${hm(d.hi.t)}`);
  return `${gaugeHead(g)}, in the ${WINDOW_HOURS} hours through ${through(series)}: ${days.join('; ')}.`;
}

/** A river into the lake: where it is now against two days before, and its range between. */
export function riverLine(g, series) {
  const win = lastHours(series);
  if (!win.length) return null;
  const vals = win.map((p) => p.v);
  const u = UNIT(g);
  return `${gaugeHead(g)}: ${fmt(g, vals[vals.length - 1])} ${u} at ${through(series)}, `
    + `${fmt(g, vals[0])} ${u} ${WINDOW_HOURS} hours before (low ${fmt(g, Math.min(...vals))}, high ${fmt(g, Math.max(...vals))}).`;
}

/** USGS OGC `continuous` features -> [{ t, v }], sorted, unreadable values dropped. */
export function seriesFrom(payload) {
  const out = [];
  for (const f of (payload && payload.features) || []) {
    const p = (f && f.properties) || {};
    if (p.value === null || p.value === undefined || p.value === '') continue;
    const v = Number(p.value), t = Date.parse(p.time);
    if (Number.isFinite(v) && v > -999999 && Number.isFinite(t)) out.push({ t, v });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** One gauge's line from its readings, by what the gauge is and what it read. */
export function gaugeLine(g, series) {
  if (!series || !series.length) return `${g.name} (USGS ${g.site}): no readings came back.`;
  if (g.role === 'inflow') return riverLine(g, series);
  // A flow that ran backwards anywhere in what was read: the runs, guarded by the back-flow.
  if (g.param === '00060' && series.some((p) => p.v < 0)) return tailraceLine(g, series);
  return rangeLine(g, series);
}

/** How many days of readings a gauge needs: a full tide cycle for a flow below a lake, else two. */
export function daysFor(g) {
  return g.role === 'outflow' && g.param === '00060' ? TIDE_CYCLE_DAYS : WINDOW_HOURS / 24;
}
