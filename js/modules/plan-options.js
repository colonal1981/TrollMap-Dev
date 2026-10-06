/**
 * plan-options.js — the day as OPTIONS: Option 1 from the ramp over the water his fish came from, then
 * loops over the water most like it.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Ryan, 2026-10-05, after `c73bc91` laid lines between his fish: *"this isn't it... i dont know how
 * effective this is as a trolling route"*. Read off his own unit's tracks (HOW_HE_TROLLS_FROM_HIS_OWN_TRACKS
 * _2026-10-05.md), his design, in his words:
 *
 *   > what if these are more like options for me while on the water...a loop that goes through the way
 *   > you just drew them... but if those don't produce fish here are some loops that are similar over
 *   > similar features of water for you try... if i catch fish in that first loop i just keep fishing it
 *   > until it stops producing or its time to go home... it can be laid out in the gpx and in the plan
 *   > as like option 1,2,3
 *
 * On the drawing: *"actually that is much much much better... i like that"*. Then his corrections on
 * Bates, Murray and Marion, and the three rules put back to him and answered *"ok lets redraw with those
 * rules"*, and on the pictures, 2026-10-05: *"go ahead and build it like you have it"*:
 *
 *   1. Option 1 starts at the ramp and is trolled the whole way, holding his depth: his sounder at his own
 *      fish, with his 5 ft steering either side (the deepest water, on a river).
 *   2. It runs out along the edge his fish are on, round or along what they are by -- round Counts Island
 *      on Murray, along Green Island on Marion, down the bend to the shallow spot on Bates -- and back on
 *      the other side.
 *   3. No option on water more open than water he has already fished on that lake. *"i do not fish the
 *      open lake on marion it gets too crazy too fast with weather"*.
 *
 * This is the scratch prototype (`_scratch\tracks_1005\ramp_options.py` and the files it imports) carried
 * into the app unchanged in what it decides. SETTLED_DO_NOT_REOPEN.md, "The day is options", and
 * "Option 1's three rules".
 *
 * SINCE 10/6, from his two Murray plans from Hilton and the pictures that followed:
 *   - Lines in as soon as the water is deep enough: *"i troll all the way there... i would be putting lines
 *     in as soon as the water is deep enough in that channel on the way there"*. The way from the ramp to
 *     the first water at his depth is the cove, run with the lines up, out and back in on one line.
 *   - Every option is laid from the ramp, and none is a longer troll than Option 1: *"the rest are no where
 *     near and i would not run that far to those to fish those options"*, *"are there other possible
 *     options that are the same distance away?"*.
 *   - Out one side and back the other, a lap only where the water holds one: *"option looks to have a lot
 *     of switchbacks and isn't really a loop"*; of the redrawn Option 2, *"that water yeah"*.
 *   - Nothing crosses itself: *"why does this way out from the ramp and the same one for option 1 cross
 *     itself... and then it looks like option 1 crosses itself again in front of counts island"*, and
 *     *"sure... and then if you think this is ready to built into the app go ahead"*.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * EVERY NUMBER, AND WHERE IT CAME FROM (his tracks unless marked MINE)
 *
 *   TURN_W     250 m   median width of his turnarounds while trolling, Wateree 5/16-9/28
 *   BESIDE      55 m   median gap between a way out and the way back beside it
 *   SPOT_R     200 m   90% of his time at 0052 on 6/20 was within 213 m of it
 *   SPOT_TURN  153 m   median width of his 14 turnarounds within 300 m of 0052 on 6/20
 *   STEER        5 ft  his hand-steering band (HAND_STEER_BAND_FT, 2026-08-26)
 *   LIKE_PCT     1 %   "like" is the top 1% of the lake's water for being like a spot (MINE)
 *   N_LIKE       2     the places offered like each kind of his water (MINE)
 *   RADII  200, 500 m  what "alike" compares within: his spot's reach, and a lap's worth past it (MINE)
 *   ISLAND     400 m   an island shorter than a lap (2 x SPOT_R) lies inside the flat a lap works (MINE)
 *
 * Pure: no DOM, no fetch. trollLoopSteps() (plan-troll-loop.js) hands this the grid it built and the
 * parsed pack.
 */

import { metresBetween, minutesFor } from './plan-candidates.js';
import { todayFt } from './plan-water.js';
import { depthGrid } from './plan-troll-loop.js';

const TURN_W = 250;
const BESIDE = 55;
const SPOT_R = 200;
const SPOT_TURN = 153;
const LIKE_PCT = 1;
const N_LIKE = 2;
const RADII = [200, 500];
const LAP_REACH = SPOT_R + TURN_W / 2;     // 325 m: how far a lap reaches from its spot
const LAP_LEN = 2 * SPOT_R;                // 400 m: one lap's length along its flat
const MAX_FT = 60;                                // the depth mix is read to 60 ft; deeper counts as 60

// The 8 neighbours and the 8 knight's moves, so a line can run at 26.6 degrees as well as 0 and 45.
const NB16 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
              [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]];
// the same moves as flat tables, for the search's inner loop
const NB_I = Int8Array.from(NB16, (d) => d[0]), NB_J = Int8Array.from(NB16, (d) => d[1]);
const NB_L = Float64Array.from(NB16, (d) => Math.hypot(d[0], d[1]));

// ── THE WATER AS A GRID ─────────────────────────────────────────────────────────────────────────

/**
 * One water on the grid: depth (chart, today's water) and which cells a line may use.
 * x and y are metres from the grid's south-west corner, cell centres at (i + 0.5) * cell.
 */
function netOf(G, open) {
  const { w, h } = G, cell = G.cellM;
  let N = 0;
  for (let c = 0; c < w * h; c++) if (open[c]) N++;
  return {
    w, h, cell, D: G.d, open, N, G,
    xy: (c) => [((c % w) + 0.5) * cell, (Math.floor(c / w) + 0.5) * cell],
    cellAt: (x, y) => {
      const i = Math.floor(x / cell), j = Math.floor(y / cell);
      return i < 0 || j < 0 || i >= w || j >= h ? -1 : j * w + i;
    },
    lonLat: (c) => G.lonLat(c),
    xyOf: (pt) => {
      const [W, S] = G.bbox;
      return [(pt[0] - W) / G.dLon * cell, (pt[1] - S) / G.dLat * cell];
    },
  };
}

/** The nearest cell to (x, y) that `ok` allows, looking outward ring by ring. */
function nearest(net, x, y, ok, maxR = 400) {
  const { w, h, cell } = net;
  const i0 = Math.min(w - 1, Math.max(0, Math.floor(x / cell))), j0 = Math.min(h - 1, Math.max(0, Math.floor(y / cell)));
  let best = -1, bd = Infinity;
  for (let r = 0; r <= maxR; r++) {
    // a ring at r can hold nothing nearer than (r - 1) cells; stop once that is farther than the best
    if (best >= 0 && (r - 1) * cell > Math.sqrt(bd)) break;
    for (let dj = -r; dj <= r; dj++) {
      const j = j0 + dj;
      if (j < 0 || j >= h) continue;
      const step = (dj === -r || dj === r) ? 1 : 2 * r;
      for (let di = -r; di <= r; di += step || 1) {
        const i = i0 + di;
        if (i < 0 || i >= w) continue;
        const c = j * w + i;
        if (!ok(c)) continue;
        const dx = (i + 0.5) * cell - x, dy = (j + 0.5) * cell - y, dd = dx * dx + dy * dy;
        if (dd < bd) { bd = dd; best = c; }
      }
    }
  }
  return best;
}

class Heap {
  constructor() { this.k = new Float64Array(4096); this.v = new Int32Array(4096); this.n = 0; }
  push(key, val) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2); k.set(this.k); this.k = k;
      const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    const key = this.k[0], val = this.v[0];
    const lk = this.k[--this.n], lv = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= lk) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = lk; this.v[i] = lv;
    this.lastKey = key;
    return val;
  }
}

/**
 * Shortest ways over the grid from `src`, on the 16 directions. `cost` per metre per cell (Infinity
 * closed; null = 1 on every open cell); an edge costs its length times the mean of its two cells, and a
 * knight's move also needs the two cells it passes between to be water. With `dst` it stops there (A*).
 */
function search(net, cost, src, dst = -1, scratch = false) {
  const { w, h, cell, open } = net, n = w * h;
  const { dist, prev } = scratch ? scratchOf(n) : { dist: new Float64Array(n), prev: new Int32Array(n) };
  dist.fill(Infinity); prev.fill(-1);
  const cf = (c) => (!open[c] ? Infinity : cost ? cost[c] : 1);
  if (src < 0 || !(cf(src) < Infinity)) return { dist, prev };
  const aim = dst >= 0;
  const di0 = aim ? dst % w : 0, dj0 = aim ? (dst - di0) / w : 0;
  const hOf = (c) => { if (!aim) return 0; const i = c % w, x = i - di0, y = (c - i) / w - dj0; return Math.sqrt(x * x + y * y) * cell; };
  const heap = new Heap();
  dist[src] = 0; heap.push(hOf(src), src);
  while (heap.n) {
    const c = heap.pop();
    if (c === dst) break;
    const dc = dist[c];
    if (heap.lastKey > dc + hOf(c) + 1e-6) continue;
    const i = c % w, j = (c - i) / w, cc = cf(c);
    for (let q = 0; q < 16; q++) {
      const di = NB_I[q], dj = NB_J[q], i2 = i + di, j2 = j + dj;
      if (i2 < 0 || j2 < 0 || i2 >= w || j2 >= h) continue;
      const c2 = j2 * w + i2;
      if (!open[c2]) continue;
      if (di === 2 || di === -2) { const s = di >> 1; if (!(open[j * w + i + s] && open[j2 * w + i + s])) continue; }
      if (dj === 2 || dj === -2) { const s = dj >> 1; if (!(open[(j + s) * w + i] && open[(j + s) * w + i2])) continue; }
      const c2c = cost ? cost[c2] : 1;
      if (!(c2c < Infinity)) continue;
      const nd = dc + cell * NB_L[q] * 0.5 * (cc + c2c);
      if (nd < dist[c2]) { dist[c2] = nd; prev[c2] = c; heap.push(nd + hOf(c2), c2); }
    }
  }
  return { dist, prev };
}

function pathOf(prev, src, dst) {
  if (dst < 0) return null;
  const p = [dst];
  while (p[p.length - 1] !== src) { const q = prev[p[p.length - 1]]; if (q < 0) return null; p.push(q); }
  return p.reverse();
}

const wayOf = (net, a, b, cost) => (a < 0 || b < 0 ? null : a === b ? [a] : pathOf(search(net, cost, a, b, true).prev, a, b));

// One pair of arrays the searches that only want their path share while a day is laid (a grid of 1.5
// million cells is 18 MB a search), let go when lakeOptions() returns.
let SCRATCH = null;
function scratchOf(n) {
  if (!SCRATCH || SCRATCH.dist.length !== n) SCRATCH = { dist: new Float64Array(n), prev: new Int32Array(n) };
  return SCRATCH;
}
const lengthOf = (net, p) => { let m = 0; for (let k = 1; k < p.length; k++) { const a = net.xy(p[k - 1]), b = net.xy(p[k]); m += Math.hypot(b[0] - a[0], b[1] - a[1]); } return m; };

/** Every cell within r metres of any of `cells`. */
function nearMask(net, cells, r) {
  const { w, h, cell } = net, m = new Uint8Array(w * h), R = Math.floor(r / cell), R2 = (r / cell) ** 2;
  const seen = new Set();
  for (const c of cells) {
    if (c < 0 || seen.has(c)) continue;
    seen.add(c);
    const i = c % w, j = (c - i) / w;
    for (let dj = -R; dj <= R; dj++) {
      const j2 = j + dj;
      if (j2 < 0 || j2 >= h) continue;
      for (let di = -R; di <= R; di++) {
        const i2 = i + di;
        if (i2 < 0 || i2 >= w || di * di + dj * dj > R2) continue;
        m[j2 * w + i2] = 1;
      }
    }
  }
  return m;
}

/** 1 inside the band; dearer by the square of steering bands outside it; never shallower than lo less his 5 ft. */
function bandCost(net, lo, hi, steer) {
  const { w, h, D, open } = net, c = new Float64Array(w * h).fill(Infinity);
  for (let k = 0; k < w * h; k++) {
    if (!open[k]) continue;
    const d = D[k];
    if (d < lo - steer) continue;
    const out = d < lo ? lo - d : d > hi ? d - hi : 0;
    c[k] = 1 + (out / steer) ** 2;
  }
  return c;
}

/** The band, but water too shallow for it is not shut, only dearer than any way round: the way out of a cove. */
function noInf(net, c) {
  let s = 0;
  for (let k = 0; k < c.length; k++) if (net.open[k] && c[k] < Infinity) s += c[k];
  const out = Float64Array.from(c);
  for (let k = 0; k < c.length; k++) if (net.open[k] && !(c[k] < Infinity)) out[k] = s || 1;
  return out;
}

const wholeOf = (net, c) => { let s = 0; for (let k = 0; k < c.length; k++) if (c[k] < Infinity) s += c[k]; return s * net.cell; };

/** A way back BESIDE the way out: not within BESIDE of it except at the ends, never farther than one of his turns. */
function beside(net, out, cost, ends) {
  const near = nearMask(net, out, BESIDE), e = nearMask(net, ends, TURN_W / 2), corridor = nearMask(net, out, TURN_W);
  const whole = wholeOf(net, cost), c2 = Float64Array.from(cost);
  for (let k = 0; k < c2.length; k++) {
    if (!corridor[k]) { c2[k] = Infinity; continue; }
    if (near[k] && !e[k] && c2[k] < Infinity) c2[k] = whole;
  }
  return c2;
}

/**
 * WHICH SIDE OF A LINE the water near it is on: +1 left of the way the line runs, -1 right, 0 on the line
 * or farther than `reach` from it. A cell takes the side of the line's cell nearest it by water, against
 * the line's direction there (two cells either way).
 */
function sidesOf(net, line, reach) {
  const { w, h, open, cell } = net, n = w * h;
  const near = new Int32Array(n).fill(-1), side = new Int8Array(n), q = new Int32Array(n);
  let qh = 0, qt = 0;
  line.forEach((c, k) => { if (c >= 0 && near[c] < 0) { near[c] = k; q[qt++] = c; } });
  const R2 = (reach / cell) ** 2;
  while (qh < qt) {
    const c = q[qh++], i = c % w, j = (c - i) / w, m = line[near[c]], mi = m % w, mj = (m - mi) / w;
    for (let t = 0; t < 8; t++) {
      const i2 = i + NB_I[t], j2 = j + NB_J[t];
      if (i2 < 0 || j2 < 0 || i2 >= w || j2 >= h) continue;
      const c2 = j2 * w + i2;
      if (!open[c2] || near[c2] >= 0 || (i2 - mi) ** 2 + (j2 - mj) ** 2 > R2) continue;
      near[c2] = near[c]; q[qt++] = c2;
    }
  }
  for (let t = 0; t < qt; t++) {
    const c = q[t], k = near[c];
    if (line[k] === c) continue;
    const a = net.xy(line[Math.max(0, k - 2)]), b = net.xy(line[Math.min(line.length - 1, k + 2)]), m = net.xy(line[k]), p = net.xy(c);
    const cr = (b[0] - a[0]) * (p[1] - m[1]) - (b[1] - a[1]) * (p[0] - m[0]);
    side[c] = cr > 0 ? 1 : cr < 0 ? -1 : 0;
  }
  return side;
}

/**
 * beside(), on the one side of the way out the way home keeps to, so the two never cross. Ryan, 10/6: "why
 * does this way out from the ramp and the same one for option 1 cross itself... and then it looks like
 * option 1 crosses itself again in front of counts island".
 */
function besideOn(net, out, cost, ends, side, sg) {
  const c2 = beside(net, out, cost, ends);
  for (let k = 0; k < c2.length; k++) if (side[k] !== sg && k !== ends[0] && k !== ends[1]) c2[k] = Infinity;
  return c2;
}

/**
 * ONE SIDE OF THE WAY THERE, from `from` to `to` on side `sg` of `mid`: at his depth -- his reading,
 * dearer by the square of his steering off it -- within half one of his turns of the middle, so the two
 * sides are never farther apart than one of his turns (beside()'s rule); no nearer the middle than half
 * the gap he leaves between a way out and the way back (BESIDE) but where the water at his depth is too
 * narrow for both; and shallower than his alarm only where it must. His rules in that order: the depth,
 * then the sides. Within half a turn at a spot of either end, where the two sides meet, either side.
 */
function sideWay(net, mid, side, sg, from, to, lo, center, steer) {
  const { open, D } = net, n = net.w * net.h;
  const near = nearMask(net, mid, BESIDE / 2), ends = nearMask(net, [from, to], SPOT_TURN / 2);
  const c = new Float64Array(n).fill(Infinity), tier = new Uint8Array(n);
  let sum = 0, n1 = 0;
  for (let k = 0; k < n; k++) {
    if (!open[k]) continue;
    const end = ends[k] === 1;
    if (!end && side[k] !== sg) continue;
    if (!(D[k] >= lo - steer)) { tier[k] = 2; continue; }
    if (!end && near[k]) { tier[k] = 1; n1++; continue; }
    c[k] = 1 + ((D[k] - center) / steer) ** 2; sum += c[k];
  }
  // dearer than any way round, then dearer than any number of those
  const t1 = sum + 1, t2 = t1 * (n1 + 2);
  for (let k = 0; k < n; k++) if (tier[k] === 1) c[k] = t1 + 1 + ((D[k] - center) / steer) ** 2; else if (tier[k] === 2) c[k] = t2;
  return wayOf(net, from, to, c);
}

// ── A LINE THAT DOES NOT CROSS ITSELF ───────────────────────────────────────────────────────────────

// in at a and out at b, against in at c and out at d, round the point m: across if one pair is between the other
function aroundPoint(m, a, b, c, d) {
  const t = (p) => Math.atan2(p[1] - m[1], p[0] - m[0]);
  return between(t(a), t(b), t(c), t(d));
}
// four ways round a place, by where they leave it: across if c and d are on either side of a and b
function between(a, b, c, d) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  if ([c, d].some((v) => Math.abs(v - lo) < 1e-9 || Math.abs(v - hi) < 1e-9)) return false;
  return (lo < c && c < hi) !== (lo < d && d < hi);
}
// A stretch shared from e1 to e2 is one place, and the ways off it go round it in order: off e2 on its left,
// off e1, off e2 on its right. Where each way leaves it, on that round.
function offStretch(e1, e2) {
  const dd = Math.atan2(e2[1] - e1[1], e2[0] - e1[0]);
  const rel = (e, p) => { let v = Math.atan2(p[1] - e[1], p[0] - e[0]) - dd; while (v <= -Math.PI) v += 2 * Math.PI; while (v > Math.PI) v -= 2 * Math.PI; return v; };
  return { at1: (p) => { const v = rel(e1, p); return Math.PI + (v > 0 ? v : v + 2 * Math.PI); },
           at2: (p) => { const v = rel(e2, p); return v >= 0 ? v : 4 * Math.PI + v; } };
}

/**
 * Every place a closed line (cells, from where the lines go in and back to it) goes over itself: two of its
 * legs across each other, or water it passes twice gone into on one side and out of on the other -- each with
 * the line that takes it away: the stretch between the two passings run the other way round, and where the
 * two went along it the same way, the first up it and back, the second only across its end. The same cells,
 * each as many times.
 */
function* overItself(net, P) {
  const n = P.length, X = P.map((c) => net.xy(c));
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  for (let i = 0; i + 1 < n; i++) {
    for (let j = i + 2; j + 1 < n; j++) {
      if (i === 0 && j === n - 2) continue;
      const a = X[i], b = X[i + 1], c = X[j], d = X[j + 1];
      if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) {
        yield [...P.slice(0, i + 1), ...P.slice(i + 1, j + 1).reverse(), ...P.slice(j + 1)];
      }
    }
  }
  const at = new Map();
  P.forEach((c, k) => { if (k > 0 && k < n - 1) { if (!at.has(c)) at.set(c, []); at.get(c).push(k); } });
  for (const ks of at.values()) {
    for (let u = 0; u < ks.length; u++) for (let v = u + 1; v < ks.length; v++) {
      const i = ks[u], j = ks[v];
      if (j <= i + 1) continue;
      if (P[i + 1] === P[j - 1] && P[i - 1] !== P[j + 1]) {
        // along it the other way: the stretch from here to where they part
        let t = 0;
        while (i + t + 1 < j - t - 1 && P[i + t + 1] === P[j - t - 1]) t++;
        if (P[i + t + 1] === P[j - t - 1]) continue;              // out to the end of it and back: not across
        const w = offStretch(X[i], X[i + t]);
        if (between(w.at1(X[i - 1]), w.at2(X[i + t + 1]), w.at1(X[j + 1]), w.at2(X[j - t - 1]))) {
          yield [...P.slice(0, i + t + 1), ...P.slice(i + t + 1, j - t).reverse(), ...P.slice(j - t)];
        }
      } else if (P[i + 1] === P[j + 1] && P[i - 1] !== P[j - 1]) {
        // along it the same way
        let t = 0;
        while (j + t + 1 < n - 1 && P[i + t + 1] === P[j + t + 1] && i + t + 1 < j) t++;
        const w = offStretch(X[i], X[i + t]);
        // the first time along it, up it and back off where the second comes on; the second, only across its end
        if (between(w.at1(X[i - 1]), w.at2(X[i + t + 1]), w.at1(X[j - 1]), w.at2(X[j + t + 1]))) {
          yield [...P.slice(0, i + t + 1), ...P.slice(i, i + t).reverse(), ...P.slice(i + t + 1, j).reverse(), ...P.slice(j + t)];
        }
      } else if (P[i - 1] !== P[j - 1] && P[i - 1] !== P[j + 1] && P[i + 1] !== P[j - 1] && P[i + 1] !== P[j + 1]) {
        if (aroundPoint(X[i], X[i - 1], X[i + 1], X[j - 1], X[j + 1])) {
          yield [...P.slice(0, i + 1), ...P.slice(i + 1, j).reverse(), ...P.slice(j)];
        }
      }
    }
  }
}

/** How many places a closed line goes over itself (overItself()). */
const timesOver = (net, P) => { let k = 0; for (const x of overItself(net, P)) { void x; k++; } return k; };

/**
 * A LOOP THAT DOES NOT CROSS ITSELF. Wherever a day's line goes over itself, the stretch between the two
 * passings is run the other way round, so the line meets itself there instead of crossing: the same water and
 * the same lines, the contour loop's pairAtCrossings() (Ryan, 10/4: "why do they have to cross") at every
 * crossing of a whole loop. Ryan, 10/6: "why does this way out from the ramp and the same one for option 1
 * cross itself... and then it looks like option 1 crosses itself again in front of counts island". `cells`
 * runs from the place the lines go in and back to it; returns the same cells in the order that does not cross,
 * or crosses the fewest times it can.
 */
export function uncross(net, cells) {
  let P = cells.filter((c, k) => k === 0 || c !== cells[k - 1]), over = timesOver(net, P);
  // a change is kept only where the line then goes over itself fewer times, so it ends
  while (over > 0) {
    let next = null, less = over;
    for (const x of overItself(net, P)) {
      if (!x) continue;
      const k = timesOver(net, x);
      if (k < less) { next = x; less = k; break; }
    }
    if (!next) break;
    P = next; over = less;
  }
  return P;
}

/** Euclidean distance (cells) from every cell to the nearest cell where `isSource` -- Felzenszwalb & Huttenlocher. */
function edt(w, h, isSource) {
  const INF = 1e20, f = new Float64Array(Math.max(w, h)), d1 = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h)), z = new Float64Array(Math.max(w, h) + 1);
  const g = new Float64Array(w * h);
  const pass = (n) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s;
      for (;;) {
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        if (s <= z[k]) { k--; if (k < 0) { k = 0; break; } } else break;
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d1[q] = (q - v[k]) ** 2 + f[v[k]]; }
  };
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) f[j] = isSource(j * w + i) ? 0 : INF;
    pass(h);
    for (let j = 0; j < h; j++) g[j * w + i] = d1[j];
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) f[i] = g[j * w + i];
    pass(w);
    for (let i = 0; i < w; i++) g[j * w + i] = Math.sqrt(d1[i]);
  }
  return g;
}

/** Land joined to itself (4-connected, as scipy's label); returns the label per cell and the count. */
function labelLand(w, h, isLand) {
  const lab = new Int32Array(w * h), q = new Int32Array(w * h);
  let n = 0;
  for (let c0 = 0; c0 < w * h; c0++) {
    if (!isLand(c0) || lab[c0]) continue;
    n++;
    let head = 0, tail = 0;
    q[tail++] = c0; lab[c0] = n;
    while (head < tail) {
      const c = q[head++], i = c % w, j = (c - i) / w;
      const nb = [i > 0 ? c - 1 : -1, i < w - 1 ? c + 1 : -1, j > 0 ? c - w : -1, j < h - 1 ? c + w : -1];
      for (const c2 of nb) if (c2 >= 0 && !lab[c2] && isLand(c2)) { lab[c2] = n; q[tail++] = c2; }
    }
  }
  return { lab, n };
}

/** The line a set of points lies along: unit vector of the major axis, and the centroid. */
function axisOf(X, Y) {
  const n = X.length;
  let mx = 0, my = 0;
  for (let k = 0; k < n; k++) { mx += X[k]; my += Y[k]; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let k = 0; k < n; k++) { const dx = X[k] - mx, dy = Y[k] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const t = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { ux: Math.cos(t), uy: Math.sin(t), mx, my };
}

// ── HIS SPOTS, AND A LAP OVER THE FLAT ONE SITS ON ──────────────────────────────────────────────

/**
 * His catches within one wide turn (TURN_W) of each other are one spot. Each spot stands at the catch
 * nearest their middle; its band is the shallowest to the deepest water its fish came out of.
 * fish: [{x, y, ft, m}] -- m is the catch as the caller gave it.
 */
function spotsOf(net, fish) {
  const n = fish.length, parent = fish.map((_, i) => i);
  const f = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (Math.hypot(fish[i].x - fish[j].x, fish[i].y - fish[j].y) <= TURN_W) parent[f(i)] = f(j);
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) { const r = f(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(fish[i]); }
  return [...groups.values()].map((g) => {
    const cx = g.reduce((a, p) => a + p.x, 0) / g.length, cy = g.reduce((a, p) => a + p.y, 0) / g.length;
    const med = g.reduce((b, p) => (Math.hypot(p.x - cx, p.y - cy) < Math.hypot(b.x - cx, b.y - cy) ? p : b), g[0]);
    const deps = g.map((p) => p.ft);
    return { fish: g, n: g.length, x: med.x, y: med.y, lo: Math.min(...deps), hi: Math.max(...deps),
             node: nearest(net, med.x, med.y, (c) => net.open[c]) };
  });
}

/**
 * The flat a spot sits on -- the water in its band joined to it within a lap's reach -- the line it lies
 * on, and how far it runs either way from the spot. His words: "that entire flat area ... all those humps
 * and islands would force the fish into that flat area".
 */
function flatAxis(net, sp) {
  const { w, h, D, open, cell } = net;
  const c0 = sp.center != null ? sp.center : sp.node;
  const [x, y] = net.xy(c0);
  const R = Math.floor(LAP_REACH / cell), i0 = c0 % w, j0 = (c0 - i0) / w;
  const inb = (c, i, j) => open[c] && D[c] >= sp.lo && D[c] <= sp.hi && (i - i0) ** 2 + (j - j0) ** 2 <= R * R
    && Math.abs(i - i0) <= R && Math.abs(j - j0) <= R;
  if (!inb(c0, i0, j0)) return { x, y, ux: 1, uy: 0, emax: SPOT_R, emin: -SPOT_R };
  const seen = new Set([c0]), q = [c0], X = [], Y = [];
  while (q.length) {
    const c = q.pop(), i = c % w, j = (c - i) / w;
    const p = net.xy(c); X.push(p[0]); Y.push(p[1]);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const i2 = i + di, j2 = j + dj;
      if (i2 < 0 || j2 < 0 || i2 >= w || j2 >= h) continue;
      const c2 = j2 * w + i2;
      if (seen.has(c2) || !inb(c2, i2, j2)) continue;
      seen.add(c2); q.push(c2);
    }
  }
  if (X.length < 3) return { x, y, ux: 1, uy: 0, emax: SPOT_R, emin: -SPOT_R };
  const { ux, uy } = axisOf(X, Y);
  let emax = -Infinity, emin = Infinity, wmax = -Infinity, wmin = Infinity;
  for (let k = 0; k < X.length; k++) {
    const pr = (X[k] - x) * ux + (Y[k] - y) * uy, pw = (X[k] - x) * -uy + (Y[k] - y) * ux;
    if (pr > emax) emax = pr; if (pr < emin) emin = pr; if (pw > wmax) wmax = pw; if (pw < wmin) wmin = pw;
  }
  // A FLAT A LAP FITS ON: the water in the band at least one of his turns at a spot (SPOT_TURN) along
  // the line and across it, as lapAxis() lays its two passes that far apart. Narrower, the lap is
  // squeezed to one turn and its corners drop on whatever water the band allows, and it folds over itself
  // (Ryan, 10/6: "a lot of switchbacks and isn't really a loop").
  return { x, y, ux, uy, emax, emin, fits: emax - emin >= SPOT_TURN && wmax - wmin >= SPOT_TURN };
}

/**
 * A LAP AS HE LAPS A SPOT, on a given line: along it on one pass, a round turn as wide as his turns at a
 * spot, back along it on the other pass, a round turn home -- a closed loop with no point and no double
 * back (his "whats with the double back"). A corner that falls on water the band shuts moves to the
 * nearest water it allows. Returns the loop's pieces (cell paths) and its first cell.
 */
function lapAxis(net, a, lo, hi, steer, w = SPOT_TURN) {
  let { x, y, ux, uy, emax, emin } = a;
  const vx = -uy, vy = ux, h = w / 2, c = bandCost(net, lo, hi, steer);
  if (emax - emin < w) { const mid = (emax + emin) / 2; emax = mid + h; emin = mid - h; }
  const N = (t, o) => nearest(net, x + ux * t + vx * o, y + uy * t + vy * o, (k) => c[k] < Infinity);
  const A1 = N(emin + h, h), B1 = N(emax - h, h), TB = N(emax, 0), B2 = N(emax - h, -h), A2 = N(emin + h, -h), TA = N(emin, 0);
  const p1 = wayOf(net, A1, B1, c);
  if (!p1) return { pieces: null, start: -1 };
  const t1 = wayOf(net, B1, TB, c), t1b = wayOf(net, TB, B2, c);
  const near = nearMask(net, p1, h), ends = nearMask(net, [B2, A2, TB, TA], h), whole = wholeOf(net, c);
  const c2 = Float64Array.from(c);
  for (let k = 0; k < c2.length; k++) if (near[k] && !ends[k] && c2[k] < Infinity) c2[k] = whole;
  const p2 = wayOf(net, B2, A2, c2), t2 = wayOf(net, A2, TA, c), t2b = wayOf(net, TA, A1, c);
  return { pieces: [p1, t1, t1b, p2, t2, t2b].filter((p) => p && p.length), start: A1 };
}

const racetrack = (net, sp, steer) => lapAxis(net, flatAxis(net, sp), sp.lo, sp.hi, steer);

/**
 * The turn at the far end of a run, as he turns: round, as wide as w, to a point w across from the end
 * on whichever side the water allows. Returns the turn and the cell to come back from.
 */
function roundTurn(net, path, w, c) {
  const end = net.xy(path[path.length - 1]);
  let k = path.length - 1, back = 0;
  while (k > 0 && back < w / 2) { const a = net.xy(path[k]), b = net.xy(path[k - 1]); back += Math.hypot(a[0] - b[0], a[1] - b[1]); k--; }
  const st = net.xy(path[k]);
  let dx = end[0] - st[0], dy = end[1] - st[1];
  const n = Math.hypot(dx, dy) || 1; dx /= n; dy /= n;
  let best = null;
  const h = w / 2;
  for (const side of [1, -1]) {
    const px = -dy * side, py = dx * side;
    const apex = nearest(net, end[0] + dx * h + px * h, end[1] + dy * h + py * h, (q) => net.open[q]);
    const bx = end[0] + px * w, by = end[1] + py * w;
    const B = nearest(net, bx, by, (q) => net.open[q]);
    if (B < 0) continue;
    const bp = net.xy(B);
    if (Math.hypot(bp[0] - bx, bp[1] - by) > w / 2) continue;
    const t1 = wayOf(net, path[path.length - 1], apex, c), t2 = t1 ? wayOf(net, apex, B, c) : null;
    if (t1 && t2) {
      const L = lengthOf(net, t1) + lengthOf(net, t2);
      if (!best || L < best.L) best = { L, turn: [...t1, ...t2.slice(1)], B };
    }
  }
  return best ? best : { turn: [path[path.length - 1]], B: path[path.length - 1] };
}

/** Through the spots in order, holding the band. */
function viaPath(net, nodes, lo, hi, steer) {
  const c = bandCost(net, lo, hi, steer), p = [nodes[0]];
  for (let k = 1; k < nodes.length; k++) {
    const q = wayOf(net, nodes[k - 1], nodes[k], c);
    if (!q) return null;
    p.push(...q.slice(1));
  }
  return p;
}

// ── "ALIKE": EVERY FEATURE THE PACK HOLDS, COMPARED WITHIN 200 m AND 500 m ───────────────────────
//
// Ryan, 10/5: "alike needs to be all of the features that play into it". Each feature is counted within
// each radius of a place; each difference is divided by how much that feature varies across the lake's
// water; each kind of feature counts the same (MINE), the mix of depths being one kind among them.
// Measured every other cell (50 m on the 25 m grid) -- MINE, so a lake the size of Murray fits in a
// browser; the laps are still laid on the 25 m grid.

const pointOf = (g) => {
  if (!g) return null;
  if (g.type === 'Point') return g.coordinates;
  const ring = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0]
    : g.type === 'LineString' ? g.coordinates : g.type === 'MultiLineString' ? g.coordinates[0] : null;
  if (!ring || !ring.length) return null;
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / ring.length, y / ring.length];
};

/**
 * The features of every water cell, measured every other cell. `net0` is the chart's water with nothing
 * closed (the water as charted, which is what is compared).
 */
function featuresOf(net0, L) {
  const { w, h, cell, D, open } = net0;
  const st = 2, we = Math.ceil(w / st), he = Math.ceil(h / st);
  const eIdx = new Int32Array(we * he).fill(-1), base = [];
  for (let J = 0; J < he; J++) for (let I = 0; I < we; I++) {
    const c = (J * st) * w + I * st;
    if (open[c]) { eIdx[J * we + I] = base.length; base.push(c); }
  }
  const E = base.length;
  const rc = RADII.map((r) => r / cell);                           // radii in base cells
  const layers = [];                                               // {name, group, A: [Float32Array per radius]}
  const pointLayer = (name, group, pts) => {
    const A = rc.map(() => new Float32Array(E));
    for (const { at, v } of pts) {
      const [px, py] = net0.xyOf(at);
      const pi = Math.floor(px / cell), pj = Math.floor(py / cell);
      if (pi < -rc[1] || pj < -rc[1] || pi > w + rc[1] || pj > h + rc[1]) continue;
      const R = Math.floor(rc[1]);
      for (let J = Math.max(0, Math.ceil((pj - R) / st)); J <= Math.min(he - 1, Math.floor((pj + R) / st)); J++) {
        for (let I = Math.max(0, Math.ceil((pi - R) / st)); I <= Math.min(we - 1, Math.floor((pi + R) / st)); I++) {
          const e = eIdx[J * we + I];
          if (e < 0) continue;
          const d2 = (I * st - pi) ** 2 + (J * st - pj) ** 2;
          for (let k = 0; k < rc.length; k++) if (d2 <= rc[k] * rc[k]) A[k][e] += v;
        }
      }
    }
    layers.push({ name, group, A });
  };
  const at = (f) => pointOf(f && f.geometry);
  const P = (fs, keep, v = () => 1) => (fs || []).filter(keep).map((f) => ({ at: at(f), v: v(f) })).filter((p) => p.at);
  const kind = (k, key = 'kind') => (f) => f && f.properties && f.properties[key] === k;
  const st_ = L.structure || [], wf = L.waterFeatures || [], po = L.pois || [], dk = L.docks || [];
  pointLayer('humps (relief, ft)', 'humps', P(st_, kind('hump'), (f) => Number(f.properties.relief_ft) || 0));
  pointLayer('holes', 'holes', P(st_, kind('hole')));
  // LEDGES BY THE DEPTH OF THEIR TOP, in bins of his 5 ft steering band: a ledge that is the lip of the
  // channel at 26 ft is not the same thing as a bank ledge at 8 ft.
  for (let a = 0; a < 60; a += 5) {
    pointLayer(`ledges, top ${a}-${a + 5} ft`, 'ledges', P(st_, (f) => kind('ledge')(f)
      && (Number(f.properties.depth_ft) || 0) >= a && (Number(f.properties.depth_ft) || 0) < a + 5));
  }
  pointLayer('points', 'points', P(wf, kind('point')));
  pointLayer('coves', 'coves', P(wf, kind('cove')));
  pointLayer('creek mouths', 'creek mouths', P(wf, kind('creek_mouth')));
  pointLayer('flooded timber', 'flooded timber', P(po, kind('flooded_timber', 'poi_type')));
  pointLayer('shallow-area marks', 'shallow-area marks', P(po, kind('shallow_area', 'poi_type')));
  pointLayer('obstructions and piles', 'obstructions and piles',
             P(po, (f) => f && f.properties && ['obstruction', 'pile'].includes(f.properties.poi_type)));
  pointLayer('fish attractors', 'fish attractors', P(po, kind('fish_attractor_buoy', 'poi_type')));
  pointLayer('docks', 'docks', P(dk, () => true));
  // ISLANDS: land inside the lake (not joined to the land at the edge of the grid), in acres.
  {
    const { lab, n } = labelLand(w, h, (c) => !open[c]);
    const edge = new Set();
    for (let i = 0; i < w; i++) { edge.add(lab[i]); edge.add(lab[(h - 1) * w + i]); }
    for (let j = 0; j < h; j++) { edge.add(lab[j * w]); edge.add(lab[j * w + w - 1]); }
    const acre = (cell * cell) / 4046.86, pts = [];
    for (let c = 0; c < w * h; c++) {
      const l = lab[c];
      if (!l || edge.has(l)) continue;
      pts.push({ at: net0.lonLat(c), v: acre });
    }
    void n;
    pointLayer('islands (acres)', 'islands', pts);
  }
  // DISTANCES: to the shore, and to the app's channel stretches (channels.json on the trolling runs).
  const toShore = edt(w, h, (c) => !open[c]);
  layers.push({ name: 'to the shore (m)', group: 'shore', A: [Float32Array.from(base, (c) => toShore[c] * cell)] });
  {
    const ch = L.channels || {}, on = new Uint8Array(w * h);
    let any = false;
    for (const f of (L.runs || [])) {
      const id = f && f.properties && f.properties.id;
      if (!id || !ch[id] || !f.geometry) continue;
      const co = f.geometry.type === 'LineString' ? f.geometry.coordinates
        : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates[0] : null;
      if (!co || co.length < 2) continue;
      const xy = co.map((p) => net0.xyOf(p));
      const seg = [0];
      for (let k = 1; k < xy.length; k++) seg.push(seg[k - 1] + Math.hypot(xy[k][0] - xy[k - 1][0], xy[k][1] - xy[k - 1][1]));
      for (const [a, b] of ch[id]) {
        for (let t = a; t <= b; t += cell / 2) {
          let k = 1;
          while (k < seg.length - 1 && seg[k] < t) k++;
          const f0 = seg[k] > seg[k - 1] ? (t - seg[k - 1]) / (seg[k] - seg[k - 1]) : 0;
          const tt = Math.max(0, Math.min(1, f0));
          const x = xy[k - 1][0] + (xy[k][0] - xy[k - 1][0]) * tt, y = xy[k - 1][1] + (xy[k][1] - xy[k - 1][1]) * tt;
          const c = net0.cellAt(x, y);
          if (c >= 0) { on[c] = 1; any = true; }
        }
      }
    }
    if (any) {
      const toCh = edt(w, h, (c) => on[c] === 1);
      layers.push({ name: 'to the channel (m)', group: 'channel', A: [Float32Array.from(base, (c) => toCh[c] * cell)] });
    }
  }
  // THE MIX OF DEPTHS within each radius: the share of the disk at or under each foot to 60 (land and
  // water with no chart count as 0 ft), compared as a 1-D earth mover's distance.
  const Zq = new Uint8Array(w * h);
  for (let c = 0; c < w * h; c++) { const v = D[c]; Zq[c] = Number.isFinite(v) ? Math.min(MAX_FT, Math.max(0, Math.ceil(v))) : 0; }
  const levels = MAX_FT + 1, R0 = Math.floor(rc[0]), R1 = Math.floor(rc[1]);
  const offs = [];
  for (let dj = -R1; dj <= R1; dj++) for (let di = -R1; di <= R1; di++) {
    const d2 = di * di + dj * dj;
    if (d2 <= rc[1] * rc[1]) offs.push([di, dj, d2 <= rc[0] * rc[0]]);
  }
  const size = [offs.filter((o) => o[2]).length, offs.length];
  const C = [new Uint16Array(E * levels), new Uint16Array(E * levels)];
  const hist0 = new Int32Array(levels), hist1 = new Int32Array(levels);
  for (let e = 0; e < E; e++) {
    const c = base[e], i = c % w, j = (c - i) / w;
    hist0.fill(0); hist1.fill(0);
    for (const [di, dj, small] of offs) {
      const i2 = i + di, j2 = j + dj;
      if (i2 < 0 || j2 < 0 || i2 >= w || j2 >= h) continue;          // off the grid: nothing (as scipy pads)
      const z = Zq[j2 * w + i2];
      hist1[z]++;
      if (small) hist0[z]++;
    }
    let a0 = 0, a1 = 0;
    for (let d = 0; d < levels; d++) { a0 += hist0[d]; a1 += hist1[d]; C[0][e * levels + d] = a0; C[1][e * levels + d] = a1; }
    void R0;
  }
  return { we, he, st, eIdx, base, E, layers, C, size, levels, w, h, cell };
}

/** The eval cell nearest a base cell, among the water ones. */
function evalOf(F, c) {
  const { w, st, we, he, eIdx } = F;
  const i = c % w, j = (c - i) / w;
  const I0 = Math.round(i / st), J0 = Math.round(j / st);
  for (let r = 0; r < 8; r++) {
    let best = -1, bd = Infinity;
    for (let J = J0 - r; J <= J0 + r; J++) for (let I = I0 - r; I <= I0 + r; I++) {
      if (I < 0 || J < 0 || I >= we || J >= he) continue;
      const e = eIdx[J * we + I];
      if (e < 0) continue;
      const d = (I * st - i) ** 2 + (J * st - j) ** 2;
      if (d < bd) { bd = d; best = e; }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/** Spread of a layer over the water, for scaling its differences. */
const sdOf = (A) => {
  let s = 0, s2 = 0, n = 0;
  for (let k = 0; k < A.length; k++) { const v = A[k]; if (Number.isFinite(v)) { s += v; s2 += v * v; n++; } }
  if (!n) return NaN;
  const m = s / n;
  return Math.sqrt(Math.max(0, s2 / n - m * m));
};

/**
 * How unlike each water cell is to the place at eval cell `e0`: for every kind of feature, the difference
 * in what lies within 200 m and 500 m (or the distance), over how much that feature varies across the
 * lake's water; the kinds count equally, the depth mix being one kind among them. Lower is more alike.
 */
function alikeTo(F, e0) {
  const { E, layers, C, size, levels } = F;
  const parts = [];
  // the depth mix
  const em = [0, 1].map((k) => {
    const ref = C[k].subarray(e0 * levels, (e0 + 1) * levels), out = new Float32Array(E), S = size[k];
    for (let e = 0; e < E; e++) {
      let s = 0;
      const o = e * levels;
      for (let d = 0; d < levels; d++) s += Math.abs(C[k][o + d] - ref[d]);
      out[e] = s / S;
    }
    return out;
  });
  const sd2 = sdOf(em[0]), sd5 = sdOf(em[1]);
  const mix = new Float32Array(E);
  for (let e = 0; e < E; e++) mix[e] = 0.5 * ((sd2 > 0 ? em[0][e] / sd2 : 0) + (sd5 > 0 ? em[1][e] / sd5 : 0));
  parts.push(mix);
  // every other kind of feature, the ledge bins being one kind between them
  const groups = new Map();
  for (const L of layers) {
    const acc = new Float32Array(E);
    for (const A of L.A) {
      const sd = sdOf(A), ref = A[e0];
      if (!(sd > 0) || !Number.isFinite(ref)) continue;
      for (let e = 0; e < E; e++) acc[e] += Math.abs(A[e] - ref) / sd;
    }
    for (let e = 0; e < E; e++) acc[e] /= L.A.length;
    if (!groups.has(L.group)) groups.set(L.group, []);
    groups.get(L.group).push(acc);
  }
  for (const list of groups.values()) {
    const g = new Float32Array(E);
    for (const a of list) for (let e = 0; e < E; e++) g[e] += a[e] / list.length;
    parts.push(g);
  }
  const T = new Float32Array(E);
  for (const p of parts) for (let e = 0; e < E; e++) T[e] += p[e] / parts.length;
  const sorted = Float32Array.from(T).sort();
  // the share of the lake's water at least this alike, in per cent (searchsorted, left)
  const pc = (v) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    return (lo / sorted.length) * 100;
  };
  return { T, pc };
}

/** Today's chart depths within SPOT_R of a cell, sorted -- the spot's own mix of depths. */
function localDepths(net0, c) {
  const { w, h, D, cell } = net0, r = Math.floor(SPOT_R / cell), i = c % w, j = (c - i) / w, v = [];
  for (let j2 = Math.max(0, j - r); j2 <= Math.min(h - 1, j + r); j2++) {
    for (let i2 = Math.max(0, i - r); i2 <= Math.min(w - 1, i + r); i2++) {
      const d = D[j2 * w + i2];
      if (Number.isFinite(d)) v.push(d);
    }
  }
  return v.sort((a, b) => a - b);
}

const quantile = (a, q) => {
  if (!a.length) return NaN;
  const pos = Math.min(1, Math.max(0, q)) * (a.length - 1), lo = Math.floor(pos), f = pos - lo;
  return lo + 1 < a.length ? a[lo] + (a[lo + 1] - a[lo]) * f : a[lo];
};
const below = (a, v, right = false) => { let n = 0; for (const x of a) if (right ? x <= v : x < v) n++; return n; };

/**
 * An option holds the same place in its own mix of depths that his fish held at the spot: his fish sat
 * at some place in the spot's mix (the deepest 60% of the water within 200 m at 0052); hold that place.
 */
function bandLike(net0, homeCell, band, optCell) {
  const hv = localDepths(net0, homeCell), ov = localDepths(net0, optCell);
  if (!hv.length || !ov.length) return band;
  const qLo = below(hv, band[0]) / hv.length, qHi = below(hv, band[1], true) / hv.length;
  return [quantile(ov, Math.min(qLo, 1)), quantile(ov, Math.min(Math.max(qHi, qLo), 1))];
}

// ── WHAT HIS FISH ARE BY: AN ISLAND, OR A RIVER'S BANKS ─────────────────────────────────────────

/** Islands: land not joined to the land at the edge of the grid, with the line each lies along. */
function islandsOf(net) {
  const { w, h, open } = net;
  const { lab, n } = labelLand(w, h, (c) => !open[c]);
  const edge = new Set();
  for (let i = 0; i < w; i++) { edge.add(lab[i]); edge.add(lab[(h - 1) * w + i]); }
  for (let j = 0; j < h; j++) { edge.add(lab[j * w]); edge.add(lab[j * w + w - 1]); }
  const cells = new Map();
  for (let c = 0; c < w * h; c++) {
    const l = lab[c];
    if (!l || edge.has(l)) continue;
    if (!cells.has(l)) cells.set(l, []);
    cells.get(l).push(c);
  }
  void n;
  const out = [];
  for (const [id, cs] of cells) {
    if (cs.length < 3) continue;
    const X = cs.map((c) => net.xy(c)[0]), Y = cs.map((c) => net.xy(c)[1]);
    const { ux, uy, mx, my } = axisOf(X, Y);
    let pmin = Infinity, pmax = -Infinity;
    for (let k = 0; k < X.length; k++) { const p = (X[k] - mx) * ux + (Y[k] - my) * uy; if (p < pmin) pmin = p; if (p > pmax) pmax = p; }
    out.push({ id, cells: cs, X, Y, cx: mx, cy: my, ux, uy, pmin, pmax, length: pmax - pmin + net.cell,
               acres: (cs.length * net.cell * net.cell) / 4046.86 });
  }
  return out;
}

/**
 * The island his fish are by: the nearest island at least a lap long (MINE: a shorter one lies inside the
 * flat a lap works), nearer his main spot than any of his other spots are (MINE).
 */
function islandBy(net, lead, others) {
  const nearOther = others.length ? Math.min(...others.map((o) => Math.hypot(lead.x - o.x, lead.y - o.y))) : Infinity;
  let best = null;
  for (const isl of islandsOf(net)) {
    if (isl.length < LAP_LEN) continue;
    let d = Infinity;
    for (let k = 0; k < isl.X.length; k++) { const v = Math.hypot(isl.X[k] - lead.x, isl.Y[k] - lead.y); if (v < d) d = v; }
    if (d < nearOther && (!best || d < best.d)) best = { d, isl };
  }
  return best;
}

/** Twice the farthest the water gets from the shore within a lap's reach of the spot. */
function riverWidth(net, lead) {
  const { w, h, open, cell } = net;
  const dt = edt(w, h, (c) => !open[c]);
  const r = Math.floor(LAP_REACH / cell), c0 = lead.node, i0 = c0 % w, j0 = (c0 - i0) / w;
  let m = 0;
  for (let j = Math.max(0, j0 - r); j <= Math.min(h - 1, j0 + r); j++) {
    for (let i = Math.max(0, i0 - r); i <= Math.min(w - 1, i0 + r); i++) if (dt[j * w + i] > m) m = dt[j * w + i];
  }
  return 2 * m * cell;
}

/**
 * ROUND THE ISLAND IN THE BAND: on each of 16 bearings from its middle, the first water in the band past
 * its shore, joined in order -- within a lap's reach of the shore, and through shallow water only where the
 * band is broken (a shallow strait), never round the lake. Murray: "follows all the way around counts island".
 */
function aroundIsland(net, isl, lo, hi, steer) {
  const { w, h, open, D, cell } = net;
  const isLand = new Uint8Array(w * h);
  for (const c of isl.cells) isLand[c] = 1;
  const distIsl = edt(w, h, (c) => isLand[c] === 1);
  const pts = [];
  for (let k = 0; k < 16; k++) {
    const a = (2 * Math.PI * k) / 16, dx = Math.cos(a), dy = Math.sin(a);
    let left = false;
    for (let t = 0; t < isl.length + LAP_REACH; t += cell / 2) {
      const c = net.cellAt(isl.cx + dx * t, isl.cy + dy * t);
      if (c < 0) break;
      if (!open[c]) { if (left) break; continue; }        // land again: another shore
      left = true;
      if (D[c] >= lo && D[c] <= hi) { if (distIsl[c] * cell <= LAP_REACH) pts.push(c); break; }
    }
  }
  if (pts.length < 3) return null;
  const cc = noInf(net, bandCost(net, lo, hi, steer));
  for (let c = 0; c < cc.length; c++) if (distIsl[c] * cell > LAP_REACH) cc[c] = Infinity;
  const pieces = [];
  for (let k = 0; k < pts.length; k++) {
    const p = wayOf(net, pts[k], pts[(k + 1) % pts.length], cc);
    if (p && p.length) pieces.push(p);
  }
  return pieces.length ? pieces : null;
}

/**
 * ALONG THE ISLAND across from his fish, end to end: the inner pass on the first water in the band off its
 * shore on his fish's side, the outer pass one lap-turn further out. Marion: "you are missing the east to
 * west by green island".
 */
function alongIsland(net, isl, lead, lo, hi, steer) {
  const { ux, uy } = isl;
  let vx = -uy, vy = ux;
  if ((lead.x - isl.cx) * vx + (lead.y - isl.cy) * vy < 0) { vx = -vx; vy = -vy; }
  let t0 = -Infinity;
  for (let k = 0; k < isl.X.length; k++) t0 = Math.max(t0, (isl.X[k] - isl.cx) * vx + (isl.Y[k] - isl.cy) * vy);
  let t = t0;
  while (t < t0 + 3 * LAP_REACH) {
    const c = net.cellAt(isl.cx + vx * t, isl.cy + vy * t);
    if (c >= 0 && net.open[c] && net.D[c] >= lo && net.D[c] <= hi) break;
    t += net.cell / 2;
  }
  const w = SPOT_TURN;
  return lapAxis(net, { x: isl.cx + vx * (t + w / 2), y: isl.cy + vy * (t + w / 2), ux, uy,
                        emax: isl.pmax + TURN_W / 2, emin: isl.pmin - TURN_W / 2 }, lo, hi, steer, w);
}

/**
 * A RIVER, AS HE DOES BATES: "down 1 side turn and back up the other but staying in the deepest water",
 * turning at "a shallow spot where i turn around normally... i have not caught any bowfin past that
 * shallow spot". From the put-in down the deepest water to his farthest fish; he turns where the deepest
 * water across the river is shallowest within half one of his turns of it (MINE: the window); back up the
 * other side of the deepest water.
 */
function riverLoop(net, rnode, lead, steer) {
  const { w, h, open, D, cell } = net;
  const width = riverWidth(net, lead);
  const k = Math.max(3, Math.round(width / cell) | 1), r = (k - 1) / 2;
  // the deepest water across the river: the deepest within a river's width
  const Dz = new Float32Array(w * h);
  for (let c = 0; c < w * h; c++) Dz[c] = Number.isFinite(D[c]) ? D[c] : 0;
  const rowMax = new Float32Array(w * h), Dloc = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    let m = -Infinity;
    for (let i2 = Math.max(0, i - r); i2 <= Math.min(w - 1, i + r); i2++) m = Math.max(m, Dz[j * w + i2]);
    rowMax[j * w + i] = m;
  }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    let m = -Infinity;
    for (let j2 = Math.max(0, j - r); j2 <= Math.min(h - 1, j + r); j2++) m = Math.max(m, rowMax[j2 * w + i]);
    Dloc[j * w + i] = m;
  }
  const cost = new Float64Array(w * h).fill(Infinity);
  for (let c = 0; c < w * h; c++) if (open[c]) cost[c] = 1 + ((Dloc[c] - D[c]) / steer) ** 2;
  const dr = search(net, null, rnode).dist;
  const fishNodes = lead.fish.map((f) => nearest(net, f.x, f.y, (c) => open[c]));
  const far = fishNodes.reduce((b, n) => (dr[n] > dr[b] ? n : b), fishNodes[0]);
  const df = search(net, null, far).dist;
  let end = far, endD = dr[far];
  for (let c = 0; c < w * h; c++) {
    if (!(dr[c] < Infinity) || !(df[c] < Infinity) || dr[c] < dr[far]) continue;
    if (Math.abs(dr[c] - dr[far] - df[c]) <= 2 * cell && dr[c] > endD) { endD = dr[c]; end = c; }
  }
  const line = wayOf(net, rnode, end, cost) || [rnode];
  const cum = [0];
  for (let q = 1; q < line.length; q++) { const a = net.xy(line[q - 1]), b = net.xy(line[q]); cum.push(cum[q - 1] + Math.hypot(a[0] - b[0], a[1] - b[1])); }
  const [fx, fy] = net.xy(far);
  let kf = 0, kd = Infinity;
  line.forEach((c, q) => { const p = net.xy(c), d = Math.hypot(p[0] - fx, p[1] - fy); if (d < kd) { kd = d; kf = q; } });
  let kt = kf;
  line.forEach((c, q) => { if (Math.abs(cum[q] - cum[kf]) <= TURN_W / 2 && Dloc[c] < Dloc[line[kt]]) kt = q; });
  const turn = line[kt];
  const out = wayOf(net, rnode, turn, cost) || [rnode, turn];
  const hh = Math.max(cell, width / 4);
  const near = nearMask(net, out, hh), ends = nearMask(net, [rnode, turn], hh), whole = wholeOf(net, cost);
  const c2 = Float64Array.from(cost);
  for (let c = 0; c < c2.length; c++) if (near[c] && !ends[c] && c2[c] < Infinity) c2[c] = whole;
  const back = wayOf(net, turn, rnode, c2) || out.slice().reverse();
  return { out, back, turn, width, turnFt: Dloc[turn] };
}

// ── HOW OPEN THE WATER IS ───────────────────────────────────────────────────────────────────────

/**
 * The average, over the 16 directions, of the open water from a cell to the shore (m): land, the charted
 * shore and the edge of the grid end a reach. The same question the app's wind exposure asks (fetch to the
 * shore), asked every way, because "it gets too crazy too fast with weather" is not one wind.
 */
function opennessOf(net) {
  const { w, h, open, cell } = net, n = w * h, tot = new Float32Array(n), F = new Float32Array(n);
  const ok = (i, j) => i >= 0 && j >= 0 && i < w && j < h && open[j * w + i];
  for (const [di, dj] of NB16) {
    const step = cell * Math.hypot(di, dj);
    const jOrder = dj > 0 ? [h - 1, -1, -1] : [0, h, 1], iOrder = di > 0 ? [w - 1, -1, -1] : [0, w, 1];
    for (let j = jOrder[0]; j !== jOrder[1]; j += jOrder[2]) {
      for (let i = iOrder[0]; i !== iOrder[1]; i += iOrder[2]) {
        const c = j * w + i;
        if (!open[c]) { F[c] = 0; continue; }
        const i2 = i + di, j2 = j + dj;
        let go = ok(i2, j2);
        if (go && Math.abs(di) === 2) go = ok(i + Math.sign(di), j) && ok(i + Math.sign(di), j2);
        if (go && Math.abs(dj) === 2) go = ok(i, j + Math.sign(dj)) && ok(i2, j + Math.sign(dj));
        F[c] = go ? F[j2 * w + i2] + step : step / 2;
      }
    }
    for (let c = 0; c < n; c++) tot[c] += F[c];
  }
  for (let c = 0; c < n; c++) tot[c] = open[c] ? tot[c] / NB16.length : NaN;
  return tot;
}

// ── HIS SOUNDER AT HIS OWN FISH ─────────────────────────────────────────────────────────────────

const minutesOfDay = (t) => {
  const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = Number(m[2]);
  if (m[3]) { const pm = /p/i.test(m[3]); if (hh === 12) hh = pm ? 12 : 0; else if (pm) hh += 12; }
  return hh * 60 + mm;
};

/**
 * One sounder reading per fish: the depth his sounder gave at the catch's own waypoint, or else the mark
 * he made that day within one of his turns of it (TURN_W), nearest in time. A fish with neither gives none.
 */
export function readingsFor(fishCatches, marks) {
  const out = [];
  for (const m of fishCatches || []) {
    if (Number.isFinite(Number(m && m.sounderFt)) && Number(m.sounderFt) > 0) { out.push({ from: 'waypoint', ft: Number(m.sounderFt) }); continue; }
    if (!m || !m.date) continue;
    const t0 = minutesOfDay(m.time);
    let best = null;
    for (const k of marks || []) {
      if (!k || k.date !== m.date || !Array.isArray(k.at) || !Number.isFinite(Number(k.depthFt))) continue;
      if (metresBetween(k.at, m.at) > TURN_W) continue;
      const t1 = minutesOfDay(String(k.datetime || '').slice(11, 16));
      const dt = t0 != null && t1 != null ? Math.abs(t1 - t0) : Infinity;
      if (!best || dt < best.dt) best = { dt, ft: Number(k.depthFt) };
    }
    if (best) out.push({ from: 'mark', ft: best.ft });
  }
  return out;
}

const median = (a) => { const s = a.slice().sort((x, y) => x - y); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };

// ── THE DAY'S OPTIONS ───────────────────────────────────────────────────────────────────────────

/** A closed lap's pieces as one ring of cells, starting and ending at `start` (or as drawn). */
function ringOf(pieces, start = -1) {
  const ring = [];
  for (const p of pieces) for (const c of p) if (ring[ring.length - 1] !== c) ring.push(c);
  if (ring.length > 1 && ring[0] === ring[ring.length - 1]) ring.pop();
  if (!ring.length) return ring;
  const k = start >= 0 ? ring.indexOf(start) : 0;
  const r = k > 0 ? [...ring.slice(k), ...ring.slice(0, k)] : ring;
  r.push(r[0]);
  return r;
}

/** A grid made again finer for a river (MINE: 10 m, so a 40-100 m river is more than two or three cells across). */
function chartExtent(da) {
  let W = 180, S = 90, E = -180, N = -90;
  for (const f of da || []) {
    const g = f && f.geometry;
    const polys = !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) for (const p of poly[0] || []) {
      if (p[0] < W) W = p[0]; if (p[0] > E) E = p[0]; if (p[1] < S) S = p[1]; if (p[1] > N) N = p[1];
    }
  }
  return E > W && N > S ? [W, S, E, N] : null;
}

/**
 * THE DAY AS OPTIONS. Called by trollLoopSteps() where his catches of the day's species are within reach.
 *
 * k.o          trollLoop's options, with the pack: daFeatures, shoreFeatures, koFeatures, structure,
 *              waterFeatures, pois, docks, runs (trolling_runs features), channels (channels.json `runs`),
 *              allCatches [{at}] (every catch of his, any species), sounderMarks [{at, date, datetime, depthFt}]
 * k.G          the grid trollLoopSteps() built (shore and keep-out zones closed)
 * k.catches    his catches of the species on this water's chart and within reach: [{at, chartFt, date, time, sounderFt}]
 * k.ramp, k.budgetM, k.budgetMin, k.trollMph, k.transitMph, k.steer, k.off, k.counts, k.marks (cast spots, for the count)
 */
export function* lakeOptions(k) {
  try { return yield* layOptions(k); } finally { SCRATCH = null; }
}

function* layOptions(k) {
  const { o, ramp, budgetM, budgetMin, trollMph, steer } = k;
  let G = k.G;
  let G0 = depthGrid(o.daFeatures, { bbox: G.bbox, cellM: G.cellM, offsetFt: o.offsetFt });
  yield 'opt';
  let nets = netsOf(G, G0);
  let laid = laySpots(nets, k, ramp, budgetM);
  if (laid.error) return { error: laid.error };
  // A RIVER: the water at his main spot narrower than his lap turn. Laid again on a finer grid where the
  // chart within reach is small enough to (MINE).
  const width0 = riverWidth(nets.s, laid.spots[0]);
  let regrid = null;
  if (width0 < SPOT_TURN && G.cellM > 10) {
    const ext = chartExtent(o.daFeatures), bb = G.bbox;
    if (ext) {
      // the chart and one cell of bank round it, so water to the chart's edge still has a shore to measure to
      const pl = 10 / (111320 * Math.cos((ext[1] * Math.PI) / 180)), pt = 10 / 110540;
      const box = [Math.max(bb[0], ext[0] - pl), Math.max(bb[1], ext[1] - pt), Math.min(bb[2], ext[2] + pl), Math.min(bb[3], ext[3] + pt)];
      const cells = ((box[2] - box[0]) * 111320 * Math.cos((box[1] * Math.PI) / 180) / 10) * ((box[3] - box[1]) * 110540 / 10);
      if (box[2] > box[0] && box[3] > box[1] && cells < 3e6) {
        const G1 = depthGrid(o.daFeatures, { bbox: box, cellM: 10, offsetFt: o.offsetFt, keepOut: o.koFeatures, shore: o.shoreFeatures });
        const G10 = depthGrid(o.daFeatures, { bbox: box, cellM: 10, offsetFt: o.offsetFt });
        const n1 = netsOf(G1, G10), l1 = laySpots(n1, k, ramp, budgetM);
        if (!l1.error) { G = G1; G0 = G10; nets = n1; laid = l1; regrid = 10; }
      }
    }
    yield 'opt';
  }
  const { s, so } = nets;
  const { spots, dr, rso, fishLeft } = laid;

  // ── KINDS OF WATER: a spot of 2+ fish starts a kind unless its water is like an earlier kind's ─────
  const F = featuresOf(so, { structure: o.structure, waterFeatures: o.waterFeatures, pois: o.pois, docks: o.docks,
                             runs: o.runs, channels: o.channels });
  yield 'opt';
  const kinds = [];
  for (const x of spots) {
    x.e = evalOf(F, x.node);
    const owner = kinds.find((kd) => x.e >= 0 && kd.pc(kd.T[x.e]) <= LIKE_PCT);
    if (!owner && (x.n >= 2 || !kinds.length)) {
      const { T, pc } = alikeTo(F, x.e);
      kinds.push({ lead: x, T, pc, spots: [x] }); x.kind = kinds.length - 1; x.how = 'lead';
      yield 'opt';
    } else if (owner) { owner.spots.push(x); x.kind = kinds.indexOf(owner); x.how = 'like'; }
    else { kinds[0].spots.push(x); x.kind = 0; x.how = 'other water'; }
  }

  // ── RULE 1: HIS DEPTH, from his sounder at his own fish of that kind ±5 ft; else the chart at his pins ──
  for (const kd of kinds) {
    const rd = readingsFor(kd.spots.flatMap((x) => x.fish.map((f) => f.m)), o.sounderMarks || []);
    kd.readings = rd;
    if (rd.length) { const med = median(rd.map((r) => r.ft)); kd.band = [med - steer, med + steer]; kd.bandFrom = 'sounder'; }
    else { kd.band = [kd.lead.lo, kd.lead.hi]; kd.bandFrom = 'chart'; }
  }

  // ── RULE 3: HOW OPEN, and the most open water he has fished on this water ─────────────────────
  const OPEN = opennessOf(s);
  let lim = 0, nFished = 0;
  for (const at of [...(o.allCatches || []).map((m) => m && m.at), ...(o.sounderMarks || []).map((m) => m && m.at)]) {
    if (!Array.isArray(at)) continue;
    const c = s.cellAt(...s.xyOf(at));
    if (c >= 0 && s.open[c] && Number.isFinite(OPEN[c])) { lim = Math.max(lim, OPEN[c]); nFished++; }
  }
  yield 'opt';

  // ── THE OPTIONS ────────────────────────────────────────────────────────────────────────────────
  const transitMph = k.transitMph || trollMph;
  const mTroll = (trollMph * 1609.344) / 60, mRun = (transitMph * 1609.344) / 60;
  // A loop's minutes: the cove run out and back with the lines up, the rest trolled.
  const minutesOf = (coveM, trolledM) => (2 * coveM) / mRun + trolledM / mTroll;
  // LINES IN AS SOON AS THE WATER IS DEEP ENOUGH. Ryan, 10/6: "i troll all the way there... i would be
  // putting lines in as soon as the water is deep enough in that channel on the way there". The way from
  // the ramp up to the first water at his depth is run with the lines up, out and back in on the one line,
  // as the contour loop's cove is; the day is trolled from there.
  const linesIn = (way, lo) => { const i = way.findIndex((c) => so.D[c] >= lo); return i < 0 ? way.length - 1 : i; };

  // ── OPTION 1, FROM THE RAMP ──
  const kd0 = kinds[0], [lo0, hi0] = kd0.band;
  const lead0 = { ...kd0.lead, lo: lo0, hi: hi0, center: kd0.lead.node };
  const others = kd0.spots.filter((x) => x !== kd0.lead);
  const rnode = s.open[rso] ? rso : nearest(s, ...so.xy(rso), (c) => s.open[c] && dr[c] < Infinity);
  const width = riverWidth(s, lead0);
  let shape, info = {}, lap = null, start = -1, out = null, home = null, river = null, cove = null;
  if (width < SPOT_TURN) {
    river = riverLoop(s, rnode, kd0.lead, steer);
    shape = 'river'; start = river.turn; info = { widthM: Math.round(river.width), turnFt: Math.round(river.turnFt) };
  } else {
    const ib = islandBy(s, kd0.lead, others);
    let pieces = null;
    if (ib && ib.d <= LAP_REACH) { pieces = aroundIsland(s, ib.isl, lo0, hi0, steer); shape = 'around'; }
    else if (ib) { pieces = alongIsland(s, ib.isl, kd0.lead, lo0, hi0, steer).pieces; shape = 'along'; }
    else { pieces = racetrack(s, lead0, steer).pieces; shape = 'flat'; }
    if (ib) info = { islandAcres: Math.round(ib.isl.acres * 10) / 10, islandM: Math.round(ib.d), islandLengthM: Math.round(ib.isl.length) };
    if (!pieces || !pieces.length) { pieces = racetrack(s, lead0, steer).pieces; shape = 'flat'; info = {}; }
    if (!pieces || !pieces.length) return { error: 'no loop fits the water your fish came from' };
    const all = pieces.flat();
    start = all.reduce((b, c) => (dr[c] < dr[b] ? c : b), all[0]);
    lap = ringOf(pieces, start);
    // THE WAY OUT FROM THE RAMP, holding the band, on the chart alone (as the app gets out of a cove), and
    // through water shallower than the band only where it must; the lines go in where it first reaches it.
    const c = noInf(so, bandCost(so, lo0, hi0, steer));
    const way = wayOf(so, rso, start, c);
    if (way) {
      const iS = linesIn(way, lo0);
      cove = way.slice(0, iS + 1);
      out = way.slice(iS);
      const S = out[0];
      // THE WAY HOME KEEPS TO ONE SIDE OF THE WAY OUT, the side the lap comes back on, and never crosses
      // it; where that side has no way back, the lap the other way round and the other side.
      if (out.length > 1 && start !== S) {
        const side = sidesOf(so, out, TURN_W);
        const toward = (cells) => Math.sign(cells.reduce((a, q) => a + side[q], 0));
        // which way it goes over the first half of one of his turns at a spot
        const m = Math.max(1, Math.min(Math.round(SPOT_TURN / 2 / so.cell), Math.floor(lap.length / 4)));
        const leaves = toward(lap.slice(1, 1 + m)), returns = toward(lap.slice(-1 - m, -1));
        const sg = returns && returns !== leaves ? returns : -leaves;
        if (sg) {
          home = wayOf(so, start, S, besideOn(so, out, c, [S, start], side, sg));
          if (!home) {
            const back = wayOf(so, start, S, besideOn(so, out, c, [S, start], side, -sg));
            if (back) { home = back; lap = [lap[0], ...lap.slice(1, -1).reverse(), lap[0]]; }
          }
        }
      }
      if (!home) home = start === S ? [S] : wayOf(so, start, S, beside(so, out, c, [S, start])) || out.slice().reverse();
    }
  }
  yield 'opt';
  // RUNS to his other fish of this kind the route does not pass, if the day holds them (approved 10/5)
  const routeCells = [...(lap || []), ...(out || []), ...(home || []), ...(river ? [...river.out, ...river.back] : [])];
  const routeXY = routeCells.map((c) => s.xy(c));
  const onRoute = (x) => routeXY.some((p) => Math.hypot(p[0] - x.x, p[1] - x.y) <= SPOT_R);
  let used = [lap, out, home, river && river.out, river && river.back].filter(Boolean).reduce((a, p) => a + lengthOf(s, p), 0);
  for (const x of kd0.spots) x.onRoute = onRoute(x);
  let left = kd0.spots.filter((x) => !x.onRoute);
  const runs = [];
  if (left.length) {
    const dh = search(s, null, start).dist;
    while (left.length) {
      const far = left.reduce((b, x) => (dh[x.node] > dh[b.node] ? x : b), left[0]);
      const df = search(s, null, far.node).dist;
      const way = left.filter((x) => dh[x.node] + df[x.node] <= dh[far.node] + 2 * SPOT_R).sort((a, b) => dh[a.node] - dh[b.node]);
      left = left.filter((x) => !way.includes(x));
      const rlo = Math.min(lo0, ...way.map((x) => x.lo)), rhi = Math.max(hi0, ...way.map((x) => x.hi));
      // OFF THE ROUTE WHERE IT COMES NEAREST HIS FIRST FISH ON IT, not from the lap's start: four lines on
      // one stretch there -- the way out, the lap, the run, the way home -- were more than any order of them
      // could keep from crossing (Murray from Hilton, 10/6)
      const d1 = search(s, null, way[0].node).dist;
      const from = routeCells.reduce((b, q) => (s.open[q] && d1[q] < d1[b] ? q : b), start);
      const outp = viaPath(s, [from, ...way.map((x) => x.node)], rlo, rhi, steer);
      if (!outp) continue;
      const c = bandCost(s, rlo, rhi, steer);
      const { turn, B } = roundTurn(s, outp, TURN_W, c);
      const back = wayOf(s, B, from, beside(s, [...outp, ...turn], c, [from]));
      if (!back) continue;
      const L = lengthOf(s, outp) + lengthOf(s, turn) + lengthOf(s, back);
      if (used + L > budgetM) {
        // too far for the day: the farthest is left as a pin, and the ones on the way get their own run
        far.noRun = true; left.push(...way.filter((x) => x !== far)); continue;
      }
      used += L;
      runs.push({ from, out: outp, turn, back, fish: way.reduce((a, x) => a + x.n, 0) });
      yield 'opt';
    }
  }
  // The day in the order it is fished, from where the lines go in and back there -- and nowhere over itself:
  // of the ways round it the lap and each run can be gone, each either way, the first that does not cross
  // itself once its crossings are taken away (uncross()), else the one that crosses itself least.
  const runCells = runs.map((r) => [...r.out.slice(1), ...r.turn.slice(1), ...r.back.slice(1)]);
  const flip = (cells) => [...cells.slice(0, -1).reverse(), cells[cells.length - 1]];
  // each run where it leaves the route, the first time the route comes there
  const dayOf = (lapGo, runGo) => {
    const d = river ? [...river.out, ...river.back.slice(1)] : [...(out || [start]), ...lapGo.slice(1), ...(home || []).slice(1)];
    runGo.forEach((rc, q) => { const k = d.indexOf(runs[q].from); d.splice(k < 0 ? d.length - 1 : k + 1, 0, ...rc); });
    return d;
  };
  const ways = [];
  for (let m = 0; m < 2 ** (runs.length + (river ? 0 : 1)); m++) {
    const lapGo = river || !(m & 1) ? lap : flip(lap), bit = river ? 0 : 1;
    ways.push(() => dayOf(lapGo, runCells.map((rc, q) => ((m >> (q + bit)) & 1 ? flip(rc) : rc))));
  }
  let day = null, over = Infinity;
  for (const way of ways) {
    const d = uncross(so, way()), x = timesOver(so, d);
    if (x < over) { day = d; over = x; }
    if (!over) break;
    yield 'opt';
  }
  // out to the farthest of it by water, and back from there
  const kFar = day.reduce((b, c, q) => (dr[c] > dr[day[b]] ? q : b), 0);
  let outCells = day.slice(0, kFar + 1), backCells = day.slice(kFar);
  if (outCells.length < 2) { outCells = day.slice(0, 2); backCells = day.slice(1); }
  const coveM1 = cove && cove.length > 1 ? lengthOf(so, cove) : 0;
  const option1 = { kind: 0, own: true, shape, info, band: [lo0, hi0], bandFrom: shape === 'river' ? 'deepest' : kd0.bandFrom,
                    n: kd0.spots.filter((x) => !x.noRun).reduce((a, x) => a + x.n, 0),
                    pins: kd0.spots.filter((x) => x.noRun).reduce((a, x) => a + x.n, 0),
                    out: outCells, back: backCells, lap: lap || [...river.out, ...river.back.slice(1)], cove: coveM1 ? cove : null,
                    runs: runs.length, fromRampM: 0, lead: kd0.lead, readings: kd0.readings.length };
  option1.minutes = minutesOf(coveM1, lengthOf(so, outCells) + lengthOf(so, backCells));

  // ── EVERY OTHER OPTION, FROM THE RAMP AS WELL ─────────────────────────────────────────────────────
  // Ryan, 10/6: "i troll all the way there", and of Murray's options 2 and 3, 7.5 and 5.5 km out: "the
  // rest are no where near and i would not run that far to those to fish those options". So each is a loop
  // from the ramp: lines up until the way there reaches his depth, then out along one side of it at his
  // depth, a lap where the water there holds one (flatAxis().fits), else a turn at the head of his depth,
  // and back along the other side -- his Bates, "down 1 side turn and back up the other". The way out is
  // on the right going out, so each keeps to the right of the way it is going, as the narrow-channel rule
  // has a boat do. One that takes longer to troll than Option 1 is not offered: the same distance away,
  // as he asked ("are there other possible options that are the same distance away?").
  const trees = new Map();
  const treeOf = (lo) => {
    if (!trees.has(lo)) trees.set(lo, search(so, noInf(so, bandCost(so, lo, Infinity, steer)), rso));
    return trees.get(lo);
  };
  // The way there to a place: the lines-up stretch, the middle of the trolled way, a lap if one fits there.
  function wayThere(kd, node, band) {
    const lo = kd.band[0], tree = treeOf(lo);
    let way = pathOf(tree.prev, rso, node);
    if (!way) return null;
    // the head of his depth: the last of the way there still at it
    let iT = way.length - 1;
    while (iT > 0 && !(so.D[way[iT]] >= lo)) iT--;
    way = way.slice(0, iT + 1);
    if (linesIn(way, lo) >= way.length - 1) return null;
    let ring = null;
    const fa = flatAxis(s, { node, lo: band[0], hi: band[1] });
    if (fa.fits) {
      const lt = lapAxis(s, fa, band[0], band[1], steer);
      const r0 = lt.pieces ? ringOf(lt.pieces) : null;
      if (r0 && r0.length > 3) {
        const ls = r0.reduce((b, q) => (tree.dist[q] < tree.dist[b] ? q : b), r0[0]);
        const w2 = pathOf(tree.prev, rso, ls);
        if (w2 && linesIn(w2, lo) < w2.length - 1) { ring = ringOf(lt.pieces, ls); way = w2; }
      }
    }
    const iS = linesIn(way, lo), mid = way.slice(iS);
    return { mid, ring, coveM: lengthOf(so, way.slice(0, iS + 1)), midM: lengthOf(so, mid), lapM: ring ? lengthOf(s, ring) : 0 };
  }
  // The two sides of it, and the lap turned to match: it leaves on the side the way out came in on.
  function sidesFor(r, kd) {
    const [lo, hi] = kd.band, mid = r.mid, from = mid[0], to = mid[mid.length - 1];
    const side = sidesOf(so, mid, TURN_W / 2);
    let ring = r.ring;
    if (ring) {
      const m = Math.max(1, Math.min(Math.round(SPOT_TURN / 2 / so.cell), Math.floor(ring.length / 4)));
      if (Math.sign(ring.slice(1, 1 + m).reduce((a, q) => a + side[q], 0)) > 0) ring = [ring[0], ...ring.slice(1, -1).reverse(), ring[0]];
    }
    const wayOut = sideWay(so, mid, side, -1, from, to, lo, (lo + hi) / 2, steer);
    const wayHome = wayOut && sideWay(so, mid, side, 1, to, from, lo, (lo + hi) / 2, steer);
    if (!wayOut || !wayHome) return null;
    const cells = uncross(so, [...wayOut, ...(ring ? ring.slice(1) : []), ...wayHome.slice(1)]);
    return { cells, ring, minutes: minutesOf(r.coveM, lengthOf(so, cells)) };
  }

  // Taken: his spots (500 m) and Option 1's route (300 m), then each option's water as it is offered (700 m).
  const taken = new Uint8Array(s.w * s.h);
  const block = (x, y, r) => {
    const R = Math.floor(r / s.cell), i = Math.round(x / s.cell - 0.5), j = Math.round(y / s.cell - 0.5);
    for (let j2 = Math.max(0, j - R); j2 <= Math.min(s.h - 1, j + R); j2++) {
      for (let i2 = Math.max(0, i - R); i2 <= Math.min(s.w - 1, i + R); i2++) taken[j2 * s.w + i2] = 1;
    }
  };
  for (const x of spots) block(x.x, x.y, 500);
  { const cs = [...option1.out, ...option1.back]; for (let q = 0; q < cs.length; q += 4) { const [px, py] = s.xy(cs[q]); block(px, py, 300); } }
  const opts = [option1], like = [], dropped = [], longer = [];
  const headOf = (r) => (r.ring ? r.ring : r.mid.slice(-Math.max(1, Math.round(SPOT_R / so.cell))));
  for (let ki = 0; ki < kinds.length; ki++) {
    const kd = kinds[ki];
    // HIS OWN OTHER WATER, the same way
    if (ki > 0) {
      const r = wayThere(kd, kd.lead.node, kd.band);
      const sd = r && minutesOf(r.coveM, 2 * r.midM + r.lapM) <= option1.minutes ? sidesFor(r, kd) : null;
      const fish = kd.spots.reduce((a, x) => a + x.n, 0);
      if (sd && sd.minutes <= option1.minutes) {
        opts.push({ kind: ki, own: true, n: fish, band: kd.band, bandFrom: kd.bandFrom, shape: sd.ring ? 'flat' : 'turn',
                    cells: sd.cells, ring: sd.ring, minutes: sd.minutes, fromRampM: r.coveM + r.midM,
                    lead: kd.lead, at: so.lonLat(sd.ring ? sd.ring[Math.floor(sd.ring.length / 4)] : r.mid[r.mid.length - 1]) });
        block(kd.lead.x, kd.lead.y, 700);
      } else longer.push({ kind: ki, fish, at: s.lonLat(kd.lead.node) });
      yield 'opt';
    }
    // WATER LIKE IT: away from his spots and the routes above, within half the day by water, no more open
    // than water he has fished here (rule 3), and no longer a troll than Option 1
    const order = Array.from({ length: F.E }, (_, e) => e).sort((a, b) => kd.T[a] - kd.T[b]);
    let got = 0;
    for (const e of order) {
      const top = kd.pc(kd.T[e]);
      if (top > LIKE_PCT) break;
      const bc = F.base[e];
      if (taken[bc]) continue;
      const [x, y] = so.xy(bc);
      const nd = nearest(s, x, y, (c) => s.open[c], 4);
      if (nd < 0) continue;
      const p = s.xy(nd);
      if (Math.hypot(p[0] - x, p[1] - y) > 2 * s.cell || !(dr[nd] <= budgetM / 2)) continue;
      const [blo, bhi] = bandLike(so, kd.lead.node, kd.band, bc);
      const r = wayThere(kd, nd, [blo, bhi]);
      if (!r) { block(x, y, s.cell); continue; }
      // the least it can take, out and back the middle: past Option 1's time already, the sides only add to it
      if (minutesOf(r.coveM, 2 * r.midM + r.lapM) > option1.minutes) continue;
      // THE WATER THE OPTION IS ON, as his catches are each a place he was: the middle of its openness --
      // the lap, or the head of his depth it turns at -- against the most open place he has caught a fish
      // here (MINE: the middle, not the most open corner)
      const op = median(headOf(r).map((c) => OPEN[c]).filter(Number.isFinite));
      if (op > lim) { dropped.push({ kind: ki, top, openM: Math.round(op), at: s.lonLat(nd) }); block(x, y, 700); continue; }
      const sd = sidesFor(r, kd);
      if (!sd || sd.minutes > option1.minutes) continue;
      like.push({ kind: ki, own: false, top, band: [blo, bhi], shape: sd.ring ? 'flat' : 'turn', cells: sd.cells, ring: sd.ring,
                  minutes: sd.minutes, fromRampM: r.coveM + r.midM, openM: Math.round(op),
                  at: so.lonLat(sd.ring ? sd.ring[Math.floor(sd.ring.length / 4)] : r.mid[r.mid.length - 1]) });
      block(x, y, 700); got++;
      yield 'opt';
      if (got >= N_LIKE) break;
    }
  }
  trees.clear();
  like.sort((a, b) => a.top - b.top);
  const all = [...opts, ...like];

  // ── AS THE APP CARRIES A DAY: Option 1 is the loop the plan is built from; every option is on the map ──
  const ll = (cells) => cells.map((c) => s.lonLat(c));
  // a cove as the plan runs it: from the ramp itself
  const coveLL = (cells) => (cells && cells.length > 1 ? [ramp, ...ll(cells.slice(1))] : null);
  const r1 = (v) => Math.round(v * 10) / 10;
  const options = all.map((op, i) => {
    const coords = op === option1 ? ll([...op.out, ...op.back.slice(1)]) : ll(op.cells);
    const ring = op === option1 ? ll(op.lap) : op.ring ? ll(op.ring) : null;
    return { n: i + 1, kind: op.kind, own: op.own, shape: op.shape, info: op.info || null,
             band: [r1(op.band[0]), r1(op.band[1])], bandFrom: op.bandFrom || 'like',
             fish: op.n || 0, pins: op.pins || 0, runs: op.runs || 0, top: op.top != null ? Math.round(op.top * 100) / 100 : null,
             fromRampM: Math.round(op.fromRampM || 0), openM: op.openM != null ? op.openM : null,
             lengthM: Math.round(lengthOfLL(coords)), minutes: Math.round(op.minutes), coords, ring,
             at: op.at || (ring ? ring[Math.floor(ring.length / 4)] : coords[0]) };
  });
  const o1 = option1;
  const legOf = (cells, half) => {
    const coords = ll(cells);
    return { coords, lengthM: Math.round(lengthOfLL(coords)), petal: 0, half, lineFt: null,
             edgeFt: o1.bandFrom === 'deepest' ? null : Math.round(o1.band[0] - steer) };
  };
  const legs = [legOf(o1.out, 'out'), legOf(o1.back, 'back')].filter((l) => l.coords.length > 1);
  const trolledM = legs.reduce((a, l) => a + l.lengthM, 0);
  const cove1 = coveLL(o1.cove), coveM = cove1 ? Math.round(lengthOfLL(cove1)) : 0;
  const fishAll = (k.catches || []).filter((m) => m && Array.isArray(m.at));
  const routeLL = legs.flatMap((l) => l.coords);
  const passed = fishAll.filter((m) => routeLL.some((p) => metresBetween(p, m.at) <= SPOT_R)).length;
  const structure = new Set();
  for (const l of legs) for (const a of marksAlongLL(l.coords, k.marks || [])) structure.add(a);
  const score = { fish: passed, passes: passed, structure: structure.size };
  const minutes = Math.round(minutesFor(trolledM, trollMph) + 2 * minutesFor(coveM, transitMph));
  return {
    mode: 'options',
    ramp, lineFt: null, steerFt: steer,
    line: { from: o1.bandFrom, n: fishAll.length, rangeFt: o1.band },
    options,
    kinds: kinds.map((kd, i) => ({ kind: i, fish: kd.spots.reduce((a, x) => a + x.n, 0), lead: kd.lead.n,
                                   band: kd.band.map(r1), bandFrom: kd.bandFrom, readings: kd.readings.length,
                                   at: s.lonLat(kd.lead.node), dates: [...new Set(kd.lead.fish.map((f) => f.m.date).filter(Boolean))].sort() })),
    dropped: dropped.map((d) => ({ ...d, top: Math.round(d.top * 100) / 100 })), openLimitM: Math.round(lim), fishedPoints: nFished,
    longer,
    catches: { used: fishAll.length, offWater: (k.counts || {}).offWater || 0, outOfReach: ((k.counts || {}).outOfReach || 0) + fishLeft,
               reachM: Math.round(budgetM / 2) },
    cove: cove1, coveM, coveCrossesShore: false,
    start: legs.length ? legs[0].coords[0] : ramp,
    legs,
    petals: [{ out: 0, back: 1, m: trolledM, sharedM: 0, lineFt: null, edgeFt: legs[0] ? legs[0].edgeFt : null, score,
               via: null, places: spots.filter((x) => x.kind === 0 && !x.noRun).length, fishFt: o1.band, kept: true }],
    trolledM, sharedM: 0, runM: 2 * coveM,
    minutes,
    budgetMin: Math.round(budgetMin),
    fillsDay: true, fillsTime: true, onceMinutes: minutes, fillingDay: null,
    score, tried: [],
    grid: { w: G.w, h: G.h, cellM: G.cellM, regrid },
  };
}

function netsOf(G, G0) {
  const n = G.w * G.h, openS = new Uint8Array(n), openO = new Uint8Array(n);
  for (let c = 0; c < n; c++) { openS[c] = Number.isFinite(G.d[c]) ? 1 : 0; openO[c] = Number.isFinite(G0.d[c]) ? 1 : 0; }
  // the water with the charted shore closed takes its depths from the chart, so a cell has one depth
  return { s: netOf({ ...G, d: G0.d }, openS), so: netOf(G0, openO) };
}

/** His fish on the grid, his spots, and how far each is from the ramp by water. */
function laySpots(nets, k, ramp, budgetM) {
  const { s, so } = nets;
  const [rx, ry] = so.xyOf(ramp);
  const rso = nearest(so, rx, ry, (c) => so.open[c]);
  if (rso < 0) return { error: 'no charted water near the ramp' };
  const dr = search(so, null, rso).dist;
  const fish = [];
  for (const m of k.catches || []) {
    if (!m || !Array.isArray(m.at)) continue;
    const [x, y] = s.xyOf(m.at);
    const c = s.cellAt(x, y);
    if (c < 0) continue;
    const ft = m.chartFt != null && Number.isFinite(Number(m.chartFt)) ? todayFt(Number(m.chartFt), k.off) : s.D[c];
    if (!Number.isFinite(ft)) continue;
    fish.push({ x, y, ft, m });
  }
  const all = spotsOf(s, fish);
  const spots = all.filter((x) => x.node >= 0 && dr[x.node] <= budgetM / 2);
  if (!spots.length) return { error: 'none of your fish are within reach of this ramp by water' };
  for (const x of spots) x.dist = dr[x.node];
  spots.sort((a, b) => b.n - a.n || a.dist - b.dist);
  const fishLeft = all.filter((x) => !spots.includes(x)).reduce((a, x) => a + x.n, 0);
  return { spots, dr, rso, fishLeft };
}

const lengthOfLL = (c) => { let m = 0; for (let q = 1; q < c.length; q++) m += metresBetween(c[q - 1], c[q]); return m; };

/** Marks within 50 m of a line (the corridor the bar counts charted marks in). */
function marksAlongLL(coords, marks) {
  const hit = [];
  if (coords.length < 2) return hit;
  for (const mk of marks) {
    if (!mk || !Array.isArray(mk.at)) continue;
    for (let q = 0; q < coords.length; q += 2) if (metresBetween(coords[q], mk.at) <= 50) { hit.push(mk); break; }
  }
  return hit;
}
