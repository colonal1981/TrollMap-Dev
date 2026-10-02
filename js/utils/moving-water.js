/**
 * moving-water.js -- when the water was being pulled, read off the gauges that show it.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Item 46 of APP_CHANGE_REQUESTS. Checked 2026-10-01 on two days of USGS 15-minute data: Jefferies'
 * tailrace (`02172002`) is plain on/off, and Monticello's level (`02160900`) falls in the evening
 * and refills in the morning (Fairfield pumped storage). Wateree's and Murray's gauges below the
 * dams were flat, and Duke's schedule is already read for Wateree. Offered as "a moving-water line
 * in the plan, given as the last days' hours"; Ryan, 2026-10-02: "yeah go ahead on 46".
 *
 * HISTORY, NOT A SCHEDULE. What the gauge did, said as such. Nobody publishes when Jefferies or
 * Fairfield will run; the hours they ran the last two days are what can be known.
 *
 * WHERE "RUNNING" STARTS IS THE DATA'S OWN, not a number written here:
 *   - otsuSplit() is the value that best splits the window's readings into two groups (the most
 *     variance between them).
 *   - A TAILRACE IS ALSO TIDAL, AND IT RUNS AT MORE THAN ONE RATE. Between runs Jefferies reads near
 *     0 and below: the tide pushing back up the canal. Ten days of it (9/22-10/2) sit in three
 *     groups: -3,000 to 2,000 (the tide), 3,500 to 8,500 and 11,500 to 16,500 cfs. One split cannot
 *     part three groups, so tailraceCut() splits, and splits the lower side again, for as long as
 *     the group it would add averages more than the strongest reverse flow -- the tide runs about
 *     as far forward as it pushes back, so a group that averages no more than that can be the tide.
 *   - THE REVERSE FLOW IS READ OVER A FULL SPRING-NEAP CYCLE (15 days), not the two days reported.
 *     Two days can fall on a neap tide: on 9/26-9/28 the strongest reverse flow was 1,120 cfs, the
 *     tide's own upper half averaged 1,200, and the line said Jefferies ran at "about 1,000 cfs".
 *     Over the cycle it is the spring tide's (2,840 cfs in 9/22-10/2), and the cut lands at
 *     3,065-3,395 cfs in every window checked, inside the empty band between the tide and a run.
 *   - A LEVEL moves when its hour-to-hour change is on the moving side of the split, and the split
 *     has to clear the gauge's own smallest step (0.01 ft on Monticello) -- below that the gauge
 *     cannot tell a move from still water. Hours, not 15-minute steps: the steps jitter across the
 *     split and cut one evening's draw into eight pieces.
 *
 * Two days is the window reported, the one the 10/1 check read and the one pressureTrend() uses:
 * two of a pattern that repeats daily. Pure: nothing here fetches. plan-preflight.js does.
 */

export const WINDOW_HOURS = 48;
/** A spring-neap cycle is 14.8 days; the tailrace's reverse flow is read over one whole. */
export const TIDE_CYCLE_DAYS = 15;

/** Which gauges show the water moving, per water. Only those the 10/1 check found showing it. */
export const MOVING_WATER_GAUGES = Object.freeze({
  lake_moultrie: [
    { site: '02172002', param: '00060', kind: 'tailrace', name: 'Jefferies tailrace at Moncks Corner',
      what: "Moultrie's outflow at Pinopolis dam", days: TIDE_CYCLE_DAYS },
  ],
  monticello_reservoir: [
    { site: '02160900', param: '00062', kind: 'level', name: 'Monticello Reservoir near Jenkinsville',
      what: 'Fairfield pumped storage: the level falls when it generates and rises when it pumps back' },
  ],
  lake_marion: [
    { site: '02172002', param: '00060', kind: 'tailrace', name: 'Jefferies tailrace at Moncks Corner',
      what: "Moultrie's outflow; it is what pulls Marion's water through the Diversion Canal",
      days: TIDE_CYCLE_DAYS },
    // The upper lake's current is the rivers'. Fort Motte reports stage only.
    { site: '02169750', param: '00065', kind: 'river', unit: 'ft', name: 'Congaree River at Fort Motte',
      what: 'one of the two rivers that make the upper lake' },
    { site: '02148000', param: '00060', kind: 'river', unit: 'cfs', name: 'Wateree River near Camden',
      what: 'the other river into the upper lake, below Wateree dam' },
  ],
});

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

/** "9/30 16:00-23:15", in the browser's clock, which is his. A run past midnight says so. */
export function spanText(from, to) {
  const a = new Date(from), b = new Date(to);
  const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
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

/** A tailrace: the hours it ran in the last two days, each with its flow, or that it did not. */
export function tailraceLine(g, series) {
  if (!series.length) return null;
  const win = lastHours(series);
  const cut = tailraceCut(series.map((p) => p.v));
  const runs = cut != null ? runsWhere(win, (p) => p.v > cut) : [];
  const head = `${g.name} (USGS ${g.site}), ${g.what}`;
  const low = Math.min(...win.map((p) => p.v));
  if (!runs.length) {
    return `${head}: did not run in the ${WINDOW_HOURS} hours through ${through(series)}; the highest `
      + `reading was ${round(Math.max(...win.map((p) => p.v)), 10).toLocaleString('en-US')} cfs.`;
  }
  const parts = runs.map((r) => `${spanText(r.from, r.to)} (about ${round(mean(r.pts.map((p) => p.v)), 100)
    .toLocaleString('en-US')} cfs)`);
  return `${head}: ran ${parts.join(', ')}, in the ${WINDOW_HOURS} hours through ${through(series)}.`
    + (low < 0 ? ` Between runs it reads near 0 and below, down to ${Math.round(low).toLocaleString('en-US')} cfs: `
      + 'the tide pushing back up the canal.' : '');
}

/** The readings as one value per clock hour (their mean), `t` the start of the hour. */
export function hourly(series) {
  const by = new Map();
  for (const p of series || []) {
    const d = new Date(p.t);
    d.setMinutes(0, 0, 0);
    const k = d.getTime();
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(p.v);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([t, vs]) => ({ t, v: mean(vs) }));
}

/** A level that is pumped and drawn: when it fell and when it rose, and from what to what. */
export function levelLine(g, series) {
  const hrs = hourly(lastHours(series));
  if (hrs.length < 2) return null;
  const steps = [];
  for (let i = 1; i < hrs.length; i++) {
    // Only between hours that follow each other; a gap in the gauge is not a move.
    if (hrs[i].t - hrs[i - 1].t !== 3600e3) continue;
    steps.push({ t: hrs[i].t, d: hrs[i].v - hrs[i - 1].v, v: hrs[i].v, prev: hrs[i - 1].v, from: hrs[i - 1].t });
  }
  const raw = series.map((p) => p.v);
  let resolution = Infinity;
  for (let i = 1; i < raw.length; i++) {
    const d = Math.abs(raw[i] - raw[i - 1]);
    if (d > 1e-9 && d < resolution) resolution = d;
  }
  const split = otsuSplit(steps.map((s) => Math.abs(s.d)));
  const cut = Math.max(split ?? Infinity, Number.isFinite(resolution) ? resolution : 0);
  const moving = (sign) => (s) => Math.abs(s.d) > cut && Math.sign(s.d) === sign;
  const joined = (list) => {
    // Consecutive hours only: runsWhere() walks every step, so a still hour ends the run.
    const out = [];
    for (const s of steps) {
      const last = out[out.length - 1];
      if (list(s)) {
        if (last && last.open) { last.to = s.t + 3600e3; last.end = s.v; }
        else out.push({ open: true, from: s.from, to: s.t + 3600e3, start: s.prev, end: s.v });
      } else if (last) last.open = false;
    }
    return out;
  };
  const runs = [
    ...joined(moving(-1)).map((r) => ({ ...r, word: 'fell' })),
    ...joined(moving(1)).map((r) => ({ ...r, word: 'rose' })),
  ].sort((a, b) => a.from - b.from);
  const head = `${g.name} (USGS ${g.site}), ${g.what}`;
  if (!runs.length) return `${head}: held level in the ${WINDOW_HOURS} hours through ${through(series)}.`;
  const ft = (x) => x.toFixed(2);
  const parts = runs.map((r) => `${r.word} ${spanText(r.from, r.to)} (${ft(r.start)} to ${ft(r.end)} ft)`);
  return `${head}, in the ${WINDOW_HOURS} hours through ${through(series)}: ${parts.join(', ')}.`;
}

/** A river into the lake: where it is now against two days ago, and its range between. */
export function riverLine(g, series) {
  if (!series.length) return null;
  const vals = lastHours(series).map((p) => p.v);
  const u = g.unit || '';
  const f = (x) => (u === 'cfs' ? Math.round(x).toLocaleString('en-US') : x.toFixed(2));
  return `${g.name} (USGS ${g.site}), ${g.what}: ${f(vals[vals.length - 1])} ${u} at ${through(series)}, `
    + `${f(vals[0])} ${u} ${WINDOW_HOURS} hours before (low ${f(Math.min(...vals))}, high ${f(Math.max(...vals))}).`;
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

/** One gauge's line from its readings, by kind. */
export function gaugeLine(g, series) {
  if (!series || !series.length) return `${g.name} (USGS ${g.site}): no readings came back.`;
  if (g.kind === 'tailrace') return tailraceLine(g, series);
  if (g.kind === 'level') return levelLine(g, series);
  return riverLine(g, series);
}
