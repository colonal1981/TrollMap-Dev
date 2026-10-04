/**
 * plan-troll-loop.js — the day as ONE LINE from the ramp and back, the shape of his own days.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * trollDay() (plan-troll-day.js) strung Pick Water's contour pieces end to end, nearest first. On
 * Ryan's Lake Wateree day for 2026-10-04 that was fifteen pieces laddered east-west-east-west over
 * one three-mile strip, every piece overshooting where the next one began and doubling back to it,
 * with a run out, a run in the middle and a run home. Ryan:
 *
 *   > how is this one continuous troll? this is just joining a bunch of random lines together and
 *   > not even in a straight line... there are double backs and sharp turns... doesn't start or end
 *   > at the ramp at all...
 *
 * His own unit's log for his four Wateree days from Clearwater Cove (8/29, 8/31, 9/26, 9/28) says
 * what a day is: he is trolling within a few hundred yards of the ramp, he takes the main channel in
 * long smooth lines -- out along one edge and back along the other, some days up the lake, some days
 * down toward the dam -- and he finishes at the ramp. Water under him while trolling: median 26-28 ft,
 * mostly 22-32. On 9/28, 2% of every 100 m turned more than 90 degrees. On Moultrie he drew it by hand
 * (2026-10-03): one loop from Short Stay down the levee, along the dam, up the west edge of the deep
 * basin and back -- "using structure and my catch history and other things to decide exactly where
 * the track would go".
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE RULE, AND WHERE EVERY PART OF IT COMES FROM
 *
 * THE WATER IS THE CHART, TODAY. depth_areas.geojson rasterised at `cellM`, each cell the
 * shallowest band covering it (as depthSampler() reads it) less the lake's measured offset. Land,
 * uncharted water, the charted shore line, keep-out zones and water with none in it today are closed.
 *
 * EACH LOOP RIDES ONE LINE, AND NOTHING IS CLOSED BY IT. A loop's line is a depth of water; a cell
 * costs more the further its depth is off that line, by the square of how many of his steering bands
 * (5 ft: "i would probably give at least 5 ft offset because i am hand steering", 2026-08-26 --
 * HAND_STEER_BAND_FT) -- so the line rides the edge and only crosses other water where it has to, the
 * way his tracks cross the channel to come home on the other side. The first loop's line is the depth
 * with the most of his catches here inside that band (loopLine()). Until 10/4 the band was also taken
 * off the line as a FLOOR for the whole day, no water shallower on any loop; on Wyboo Creek that left
 * the channel the only water and one loop the only day. Ryan: "that sounds like an excuse to keep it at
 * one loop instead of concentric loops around the same creek which is what i would actually fish".
 *
 * OUT ONE EDGE, BACK ON OTHER WATER. The way home may not come within `sameWaterM` of the way out,
 * except where the two have to meet at the ramp end and at the turn. 100 m is the app's own measure
 * of "the same water" (selectCandidates()'s corridor dedupe), from his complaint that two legs a
 * few feet apart on one shoreline "fish almost the exact same water".
 *
 * WHERE IT GOES IS DECIDED BY WHAT IT PASSES. Every turn-around the time allows is tried, and the
 * loop kept is the one that passes the most: each charted mark within his corridor (CORRIDOR_M, 50 m
 * either side, § 6) counts once, at the value the caller gives it -- structure, his catches. Nothing
 * here ranks a hump above a ledge.
 *
 * THE DAY IS ONE LOOP OR SEVERAL FROM THE SAME RAMP. After the first, a loop goes round the same water
 * again a steering band shallower or deeper -- his concentric loops -- or, where his fish are somewhere
 * the first loop is not, there. His days on Wateree went up the lake AND down it.
 *
 * HIS FISH ARE THE ONES ON THIS WATER AND WITHIN REACH. A catch counts only if its pin is on the chart
 * and no farther from the ramp, by water, than half the day trolls (Ryan, 10/4: "a fish in the congaree
 * river above lake marion is a totally different fish than one caught in wyboo creek").
 *
 * Pure: no DOM, no fetch. The caller hands in parsed GeoJSON.
 */
import { metresBetween, minutesFor } from './plan-candidates.js';
import { TROLL_MPH, TRANSIT_MPH, reasons, shallowSide, shoreAspect, todayFt } from './plan-water.js';
import { HAND_STEER_BAND_FT } from './plan-tracks.js';

const M_PER_DEG_LAT = 110540.0;
const mPerDegLon = (lat) => 111320.0 * Math.cos((lat * Math.PI) / 180);

/** 50 m either side: his corridor for "on the line" (plan-water.js CORRIDOR_M, § 6). */
export const LOOP_CORRIDOR_M = 50;
/** The app's "same water" distance (selectCandidates() dedupeCorridorM). */
export const SAME_WATER_M = 100;

/**
 * WHAT DEPTH OF WATER A LOOP RIDES, AND WHERE THAT CAME FROM.
 *
 * Ryan, 2026-10-03, on Moultrie: "what is stating that stripers are only 40-50ft on moultrie?... i
 * have absolutely caught fish in shallower water", and "from my fish locations you should be able to
 * figure out where i run". Nothing sourced said 40-50: it was the built-in table's summer line, and the
 * loop took the band's deep edge as a floor -- the band cutting water, which he ruled out on 9/26.
 *
 * Then, 2026-10-04, on Wyboo Creek: "i still don't understand why you picked the middle range and
 * subtracted 5ft... this sounds like AI math not any real fishing strategy? that sounds like an excuse
 * to keep it at one loop instead of concentric loops around the same creek which is what i would
 * actually fish". He was right twice. The middle of his catches' water was my choice, and it made one
 * number of 10-30 ft. And his 5 ft -- "i would probably give at least 5 ft offset because i am hand
 * steering" (2026-08-26), the width of the Contour alarm -- had been made a floor for the whole day:
 * no water under 23 ft, which left the creek channel the only water and one loop the only day.
 *
 * So, in order:
 *   1. the depth with the most of his catches of the species (on this water, within reach of the
 *      ramp: trollLoopSteps()) inside the 5 ft he steers either side of it -- the depth his Contour
 *      alarm, set there, would hold the most of them inside. Between depths holding as many, the one
 *      the most of them were caught over. His Wyboo Creek stripers: 28 ft (four of five inside 23-33).
 *   2. the middle of the water the research says the fish are over this season;
 *   3. only then the fish band: one steering band under its deep edge (its shallow edge on a bottom
 *      day), where the deepest bait runs.
 * There is no floor. Each loop after the first rides its own line, a steering band shallower or deeper,
 * round the same water (trollLoopSteps()).
 *
 * @param {object}   o
 * @param {object[]} [o.catches]  [{at:[lon,lat]}] his catches of the day's species
 * @param {function} [o.depthAt]  chart depth at a point on THIS water, null off it
 * @param {number}   [o.offsetFt] the lake below its chart, ft
 * @param {number[]} [o.waterFt]  [lo, hi] the water the research says the fish are over
 * @param {number[]} [o.band]     [lo, hi] the fish band
 * @param {string}   [o.holding]  'bottom' puts the deepest bait at the band's shallow edge
 * @param {number}   [o.steerFt]  his steering band (HAND_STEER_BAND_FT)
 * @returns {{lineFt:number, from:'catches'|'research'|'band', n?:number, inBand?:number, rangeFt?:number[]}|null}
 */
export function loopLine(o = {}) {
  const steer = Number.isFinite(o.steerFt) ? o.steerFt : HAND_STEER_BAND_FT;
  const ft = (o.catches || [])
    .map((c) => (c && Array.isArray(c.at) && o.depthAt ? o.depthAt(c.at) : null))
    .filter((d) => d != null && Number.isFinite(Number(d)))
    .map((d) => todayFt(Number(d), o.offsetFt));
  const fromFish = lineFromDepths(ft, steer);
  if (fromFish) return fromFish;
  const pair = (v) => (Array.isArray(v) && v.length === 2 && v.every((x) => Number.isFinite(Number(x))) ? v.map(Number) : null);
  const water = pair(o.waterFt);
  if (water) return { lineFt: Math.round((water[0] + water[1]) / 2), from: 'research', rangeFt: water };
  const band = pair(o.band);
  if (band) return { lineFt: (o.holding === 'bottom' ? band[0] : band[1]) + steer, from: 'band', rangeFt: band };
  return null;
}

/**
 * The depth with the most of these depths within `steer` of it; between depths holding as many, the
 * one the most of them round to; then the shallower. Whole feet, from the shallowest to the deepest.
 *
 * @param {number[]} depths  today's water under each catch, ft
 * @returns {{lineFt:number, from:'catches', n:number, inBand:number, rangeFt:number[]}|null}
 */
export function lineFromDepths(depths, steer = HAND_STEER_BAND_FT) {
  const ft = (depths || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!ft.length) return null;
  let best = null;
  for (let d = Math.floor(ft[0]); d <= Math.ceil(ft[ft.length - 1]); d++) {
    let inBand = 0, at = 0;
    for (const x of ft) { if (Math.abs(x - d) <= steer) inBand++; if (Math.round(x) === d) at++; }
    if (!best || inBand > best.inBand || (inBand === best.inBand && at > best.at)) best = { d, inBand, at };
  }
  return { lineFt: best.d, from: 'catches', n: ft.length, inBand: best.inBand, rangeFt: [ft[0], ft[ft.length - 1]] };
}

// ── THE CHART AS A GRID ─────────────────────────────────────────────────────────────────────────

function ringsOf(g) {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

/**
 * Today's water on a square grid.
 *
 * @param {object[]} daFeatures   depth_areas.geojson features
 * @param {object}   o
 * @param {number[]} o.bbox       [west, south, east, north]
 * @param {number}   [o.cellM]    cell size, metres
 * @param {number}   [o.offsetFt] the lake's offset against the chart (positive = lake below it)
 * @param {object[]} [o.keepOut]  keep_out.geojson features -- closed
 * @param {object[]} [o.shore]    garmin_shoreline.geojson features -- every cell a shore line crosses is closed
 */
export function depthGrid(daFeatures, o) {
  const cellM = o.cellM || 25;
  const [W, S, E, N] = o.bbox;
  const dLat = cellM / M_PER_DEG_LAT, dLon = cellM / mPerDegLon((S + N) / 2);
  const w = Math.max(1, Math.ceil((E - W) / dLon)), h = Math.max(1, Math.ceil((N - S) / dLat));
  const d = new Float32Array(w * h).fill(NaN);
  const off = Number(o.offsetFt) || 0;

  const fill = (rings, v) => {
    let ry0 = 90, ry1 = -90, rx0 = 180, rx1 = -180;
    for (const r of rings) for (const p of r) {
      if (p[1] < ry0) ry0 = p[1]; if (p[1] > ry1) ry1 = p[1];
      if (p[0] < rx0) rx0 = p[0]; if (p[0] > rx1) rx1 = p[0];
    }
    if (ry1 < S || ry0 > N || rx1 < W || rx0 > E) return;
    const jFrom = Math.max(0, Math.floor((ry0 - S) / dLat)), jTo = Math.min(h - 1, Math.ceil((ry1 - S) / dLat));
    // Edges bucketed by row, so a long ring is not walked once per row.
    const rows = new Map();
    for (const r of rings) {
      for (let i = 0, k = r.length - 1; i < r.length; k = i++) {
        const a = r[k], b = r[i];
        const lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
        if (lo === hi) continue;
        const j0 = Math.max(jFrom, Math.ceil((lo - S) / dLat - 0.5)), j1 = Math.min(jTo, Math.floor((hi - S) / dLat - 0.5));
        for (let j = j0; j <= j1; j++) {
          let l = rows.get(j); if (!l) rows.set(j, l = []);
          l.push(a, b);
        }
      }
    }
    for (const [j, l] of rows) {
      const yc = S + (j + 0.5) * dLat;
      const xs = [];
      for (let n = 0; n < l.length; n += 2) {
        const a = l[n], b = l[n + 1];
        if ((a[1] > yc) !== (b[1] > yc)) xs.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
      if (xs.length < 2) continue;
      xs.sort((x, y) => x - y);
      for (let n = 0; n + 1 < xs.length; n += 2) {
        let i0 = Math.ceil((xs[n] - W) / dLon - 0.5), i1 = Math.floor((xs[n + 1] - W) / dLon - 0.5);
        if (i1 < 0 || i0 > w - 1) continue;
        if (i0 < 0) i0 = 0; if (i1 > w - 1) i1 = w - 1;
        d.fill(v, j * w + i0, j * w + i1 + 1);
      }
    }
  };

  // Bands NEST, and the shallowest band covering a cell is its depth (depthSampler()): paint the
  // deepest first and let each shallower band paint over it.
  const polys = [];
  for (const f of (daFeatures || [])) {
    const ft = Number(f && f.properties && f.properties.depth_max_ft);
    if (!Number.isFinite(ft)) continue;
    for (const rings of ringsOf(f.geometry)) polys.push({ rings, ft });
  }
  polys.sort((a, b) => b.ft - a.ft);
  for (const p of polys) fill(p.rings, p.ft - off);
  for (const f of (o.keepOut || [])) for (const rings of ringsOf(f && f.geometry)) fill(rings, NaN);

  // THE CHARTED SHORE IS A WALL even where the bands say water on both sides of it (the Pinopolis
  // wall). Every cell a shore line passes through is closed.
  for (const f of (o.shore || [])) {
    const g = f && f.geometry;
    if (!g) continue;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates
      : g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat() : [];
    for (const c of lines) {
      for (let k = 1; k < c.length; k++) {
        const a = c[k - 1], b = c[k];
        const n = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]) / dLon, Math.abs(b[1] - a[1]) / dLat) * 2));
        for (let t = 0; t <= n; t++) {
          const x = a[0] + ((b[0] - a[0]) * t) / n, y = a[1] + ((b[1] - a[1]) * t) / n;
          const i = Math.floor((x - W) / dLon), j = Math.floor((y - S) / dLat);
          if (i >= 0 && j >= 0 && i < w && j < h) d[j * w + i] = NaN;
        }
      }
    }
  }
  const cellOf = (pt) => {
    const i = Math.floor((pt[0] - W) / dLon), j = Math.floor((pt[1] - S) / dLat);
    return (i < 0 || j < 0 || i >= w || j >= h) ? -1 : j * w + i;
  };
  const lonLat = (c) => [W + ((c % w) + 0.5) * dLon, S + (Math.floor(c / w) + 0.5) * dLat];
  return { w, h, d, cellM, dLon, dLat, bbox: [W, S, E, N], cellOf, lonLat,
           at: (pt) => { const c = cellOf(pt); return c < 0 ? NaN : d[c]; } };
}

// ── SHORTEST PATHS ──────────────────────────────────────────────────────────────────────────────

class Heap {
  constructor() { this.k = new Float64Array(1024); this.v = new Int32Array(1024); this.n = 0; }
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

const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * Dijkstra over the grid from `src`, on `cost` (per metre; Infinity = closed) with the cells in
 * `blocked` closed too. Diagonals may not cut a closed corner. With `dst` it stops there and runs
 * as A* on the straight-line distance (every cell costs at least 1 a metre, so it never overshoots).
 * Returns cost, predecessor and the path's length in metres for every cell it settled.
 */
export function shortestFrom(G, cost, src, { blocked = null, dst = -1 } = {}) {
  const { w, h, cellM } = G, n = w * h;
  const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), len = new Float32Array(n).fill(Infinity);
  const open = (c) => cost[c] < Infinity && !(blocked && blocked[c]);
  const di0 = dst >= 0 ? dst % w : 0, dj0 = dst >= 0 ? (dst - di0) / w : 0;
  const hOf = dst >= 0 ? (c) => { const i = c % w; return Math.hypot(i - di0, (c - i) / w - dj0) * cellM; } : () => 0;
  const heap = new Heap();
  dist[src] = 0; len[src] = 0; heap.push(hOf(src), src);
  while (heap.n) {
    const c = heap.pop();
    if (c === dst) break;
    if (heap.lastKey > dist[c] + hOf(c) + 1e-6) continue;
    const i = c % w, j = (c - i) / w;
    for (const [di, dj] of NB) {
      const i2 = i + di, j2 = j + dj;
      if (i2 < 0 || j2 < 0 || i2 >= w || j2 >= h) continue;
      const c2 = j2 * w + i2;
      if (!open(c2)) continue;
      if (di && dj && !(open(j * w + i2) && open(j2 * w + i))) continue;
      const m = di && dj ? cellM * Math.SQRT2 : cellM;
      const nd = dist[c] + m * (cost[c] + cost[c2]) / 2;
      if (nd < dist[c2]) { dist[c2] = nd; prev[c2] = c; len[c2] = len[c] + m; heap.push(nd + hOf(c2), c2); }
    }
  }
  return { dist, prev, len };
}

const pathTo = (prev, src, dst) => {
  const p = [dst];
  while (p[p.length - 1] !== src) { const q = prev[p[p.length - 1]]; if (q < 0) return null; p.push(q); }
  return p.reverse();
};

// ── THE LOOP ────────────────────────────────────────────────────────────────────────────────────

const lineM = (c) => { let m = 0; for (let k = 1; k < c.length; k++) m += metresBetween(c[k - 1], c[k]); return m; };

/**
 * STRAIGHTEN A GRID PATH, AND ONLY WHERE THE STRAIGHT LINE IS NO WORSE. A grid path turns in
 * steps of 45 degrees; the boat does not. From each point the line goes on to the farthest point of
 * the path it can reach straight, over open cells, for no more cost than the grid path spent getting
 * there -- the same cost the path was chosen on, so the straight piece is simply the better path
 * where the grid could not draw it, and it never cuts across water the path went round.
 */
function straighten(G, cost, cells, blocked = null) {
  const { w, cellM } = G;
  const cum = [0];
  for (let k = 1; k < cells.length; k++) {
    const a = cells[k - 1], b = cells[k];
    const diag = (a % w) !== (b % w) && Math.floor(a / w) !== Math.floor(b / w);
    cum.push(cum[k - 1] + (diag ? cellM * Math.SQRT2 : cellM) * (cost[a] + cost[b]) / 2);
  }
  const out = [cells[0]];
  let k = 0;
  while (k < cells.length - 1) {
    let best = k + 1, misses = 0;
    for (let m = k + 2; m < cells.length; m++) {
      const c = runCost(G, cost, cells[k], cells[m], blocked);
      if (c <= cum[m] - cum[k] + 1e-6) { best = m; misses = 0; }
      else if (++misses > 24) break;      // nothing farther clears once it has failed this long
    }
    out.push(cells[best]);
    k = best;
  }
  return out;
}

/** The cost of the straight run a->b, sampled at half a cell; Infinity if any of it is closed. */
function runCost(G, cost, a, b, blocked) {
  const { w, cellM } = G;
  const ai = a % w, aj = (a - ai) / w, bi = b % w, bj = (b - bi) / w;
  const L = Math.hypot(bi - ai, bj - aj);
  const n = Math.max(1, Math.ceil(L * 2));
  const step = (L * cellM) / n;
  let total = 0;
  for (let t = 0; t <= n; t++) {
    const i = Math.round(ai + ((bi - ai) * t) / n), j = Math.round(aj + ((bj - aj) * t) / n);
    const c = j * w + i, v = cost[c];
    if (!(v < Infinity) || (blocked && blocked[c])) return Infinity;
    total += (t === 0 || t === n ? 0.5 : 1) * v * step;
  }
  return total;
}

/** The line with a point every `stepM`, its own vertices kept. */
export function densify(coords, stepM = 40) {
  const out = [coords[0]];
  for (let k = 1; k < coords.length; k++) {
    const a = coords[k - 1], b = coords[k], m = metresBetween(a, b), n = Math.max(1, Math.ceil(m / stepM));
    for (let t = 1; t <= n; t++) out.push([a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n]);
  }
  return out;
}

/** Marks within `corridorM` of a line, each once: [{mark, atM, offM}] in order along it. */
export function marksAlong(coords, marks, corridorM = LOOP_CORRIDOR_M) {
  const out = [];
  if (!coords || coords.length < 2) return out;
  const cum = [0];
  for (let k = 1; k < coords.length; k++) cum.push(cum[k - 1] + metresBetween(coords[k - 1], coords[k]));
  for (const mk of (marks || [])) {
    if (!mk || !Array.isArray(mk.at)) continue;
    let best = Infinity, bestAt = 0;
    for (let k = 1; k < coords.length; k++) {
      const a = coords[k - 1], b = coords[k];
      const kx = mPerDegLon(a[1]);
      const ax = 0, ay = 0, bx = (b[0] - a[0]) * kx, by = (b[1] - a[1]) * M_PER_DEG_LAT;
      const px = (mk.at[0] - a[0]) * kx, py = (mk.at[1] - a[1]) * M_PER_DEG_LAT;
      const L2 = bx * bx + by * by;
      const t = L2 > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / L2)) : 0;
      const dd = Math.hypot(px - (ax + t * bx), py - (ay + t * by));
      if (dd < best) { best = dd; bestAt = cum[k - 1] + t * Math.sqrt(L2); }
    }
    if (best <= corridorM) out.push({ mark: mk, atM: Math.round(bestAt), offM: Math.round(best) });
  }
  return out.sort((x, y) => x.atM - y.atM);
}

/**
 * How much of the way home is the way out again: metres of `back` within `sameM` of `out`, away
 * from the two places they have to meet (twice `sameM` of the cove mouth and of the turn).
 *
 * Ryan's Wateree day for 10/3, laid live with the lake 3.2 ft down: four loops from Clearwater Cove,
 * and the last three came home within 100 m of where they went out for 81-88% of the way -- a
 * double back, which is what he threw out the stitched day for. Water trolled twice is fished once.
 */
export function sharedWaterM(out, back, sameM = SAME_WATER_M, earlier = []) {
  if (!out || out.length < 2 || !back || back.length < 2) return 0;
  const S = out[0], T = out[out.length - 1];
  // An earlier loop is its line, or {coords, withinM}: a loop on ANOTHER depth line is the same water
  // only within his wander of it (trollLoopSteps(), concentric loops), not within sameM.
  const before = (earlier || [])
    .map((e) => (Array.isArray(e) ? { c: e, m: sameM } : { c: e && e.coords, m: (e && e.withinM) || sameM }))
    .filter((e) => e.c && e.c.length >= 2);
  // Water an earlier loop of the day trolled, away from the cove mouth they all leave by.
  const againEarlier = (p) => metresBetween(p, S) >= 2 * sameM
    && before.some((e) => marksAlong(e.c, [{ at: p }], e.m).length);
  let m = 0;
  if (before.length) {
    const pts = densify(out, 40);
    for (let k = 1; k < pts.length; k++) if (againEarlier(pts[k])) m += metresBetween(pts[k - 1], pts[k]);
  }
  const pts = densify(back, 40);
  for (let k = 1; k < pts.length; k++) {
    const p = pts[k];
    const own = metresBetween(p, S) >= 2 * sameM && metresBetween(p, T) >= 2 * sameM
      && marksAlong(out, [{ at: p }], sameM).length > 0;
    if (own || againEarlier(p)) m += metresBetween(pts[k - 1], p);
  }
  return m;
}

/** The cell of `line` nearest cell c of grid G, and how far, in cells. */
function nearestCell(G, line, c) {
  const ci = c % G.w, cj = (c - ci) / G.w;
  let k = 0, bd = Infinity;
  for (let q = 0; q < line.length; q++) {
    const li = line[q] % G.w, lj = (line[q] - li) / G.w, d = (li - ci) ** 2 + (lj - cj) ** 2;
    if (d < bd) { bd = d; k = q; }
  }
  return { k, cells: Math.sqrt(bd) };
}

/** Which side of `line` cell c is on: the sign of the turn from the line's direction where it is nearest c. */
function sideOfLine(G, line, c) {
  const { k } = nearestCell(G, line, c);
  const a = line[Math.max(0, k - 1)], b = line[Math.min(line.length - 1, k + 1)], m = line[k];
  const ai = a % G.w, aj = (a - ai) / G.w, bi = b % G.w, bj = (b - bi) / G.w;
  const mi = m % G.w, mj = (m - mi) / G.w, ci = c % G.w, cj = (c - ci) / G.w;
  return Math.sign((bi - ai) * (cj - mj) - (bj - aj) * (ci - mi));
}

/**
 * Whether a way home (`path`, grid cells) that comes within sameM of the way out (`line`) only
 * CROSSES it: every stretch of it inside `within` (the cells within sameM of the way out, away from
 * the cove mouth and the turn) either never comes closer than sameM -- the ring of cells at exactly
 * sameM is the corridor's edge, which is where a 106 m gap between two edges lands on the 25 m grid
 * -- or goes in on one side of the way out and out on the other, and lies within sameM x 1.41 of the
 * cell where it is nearest it: the most a crossing at 45 degrees, the grid's diagonal, spends within
 * sameM of the line. Shallower than that, or running beside the line before going over it, is
 * travelling along it. A stretch that comes near and goes back the side it came from is beside the
 * way out, not across it.
 *
 * Rowland Subdivision on Marion, 10/4: up the channel toward Potato Creek the two edges are 106-140 m
 * apart the whole way, but the way out swings east round the mouth of Wyboo Creek before it heads
 * west, and the way home has to cross it to reach the creek's east side. Ryan: "it looks like the 28ft
 * line on the north side and the 29 ft line on the south side are more than 100m apart... why can't
 * smart plan use those to make a loop?"
 */
export function onlyCrosses(G, path, within, line, sameM = SAME_WATER_M) {
  return crossingsOf(G, path, within, line, sameM) !== null;
}

/**
 * Where `path` crosses `line`, as onlyCrosses() reads it: [{x, k}], x the index in `path` and k the
 * index in `line` of the cells nearest each other at each crossing -- or null if any stretch near
 * the line is beside it rather than across it.
 */
function crossingsOf(G, path, within, line, sameM) {
  const r2 = 2 * (sameM / G.cellM) ** 2;
  const found = [];
  for (let i = 0; i < path.length; i++) {
    if (!within[path[i]]) continue;
    let j = i;
    while (j + 1 < path.length && within[path[j + 1]]) j++;
    if (i === 0 || j === path.length - 1) return null;
    let x = i, xd = Infinity, xk = 0;
    for (let q = i; q <= j; q++) {
      const nc = nearestCell(G, line, path[q]);
      if (nc.cells < xd) { xd = nc.cells; x = q; xk = nc.k; }
    }
    if (xd * G.cellM >= sameM) { i = j; continue; }
    const s0 = sideOfLine(G, line, path[i - 1]), s1 = sideOfLine(G, line, path[j + 1]);
    if (!s0 || !s1 || s0 === s1) return null;
    const xi = path[x] % G.w, xj = (path[x] - xi) / G.w;
    for (let q = i; q <= j; q++) {
      const qi = path[q] % G.w, qj = (path[q] - qi) / G.w;
      if ((qi - xi) ** 2 + (qj - xj) ** 2 > r2) return null;
    }
    found.push({ x, k: xk });
    i = j;
  }
  return found;
}

/**
 * HIS FISH COME BEFORE FILLING THE DAY -- the order loops, and days of loops, are chosen in.
 *
 * Ryan, 2026-10-03, after the Rowland Subdivision day on Marion came out one 16.9 mi loop down Wyboo
 * Creek and eight miles into the open lower lake, past 2 of his 8 Marion stripers, drew the loop he
 * would troll -- down one side of the creek channel, out along the east-west channel and toward the
 * mouth, back up the other side -- past most of the 7 he caught in that creek: "something like this
 * for a troll lane". The old order took a day that filled the time over any that did not, whatever
 * either passed.
 *
 * So, in order:
 *   1. a loop that does not come home over its own water before one that does -- his 10/3 Wateree
 *      complaint (three loops home within 100 m of the way out, past more of his fish) stands. A
 *      double back is a way home that is more old water than new: more of `backM` (the way home)
 *      within sharedWaterM's reach of the way out, or of a loop earlier in the day, than not -- the
 *      same more-new-than-old test the day uses to stop adding loops, put to the leg that can repeat.
 *      (Over the whole loop it would pass any double back: the way out is always new.) Nor one whose
 *      way home could not keep clear of the way out beyond the turn (`kept` false: a turn in a dead
 *      end, Ryan 10/4 -- "i do not like this part of the purple leg").
 *   2. among those, the most of his catches of the species -- each fish once in the day;
 *   3. then the most times past his fish, a fish passed again counted again (`passes`). Ryan, 10/4:
 *      "concentric loops around the same creek which is what i would actually fish". Of two days past
 *      as many of his fish, the one that goes round his fish's water again beats one that spends the
 *      hours on water none of his fish came from -- miles out into the open lake from Rowland, which
 *      he will not run ("if i wasn't against running in the middle of lake marion miles from the ramp
 *      then this loop would absolutely work", 10/3);
 *   4. then, as it always was: one that fills the time before one that does not; between two that
 *      fill, the most structure, then the most new water; between two that do not, the most new
 *      water, then the most structure.
 * With no catches, 2 and 3 are ties everywhere and the order is the old one.
 *
 * @param {number} fillM  what filling the time means, in metres trolled once
 * @returns {function} a comparator over {m, newM, backM, kept, score: {fish, passes, structure}}
 */
export function fishBeforeFilling(fillM) {
  const key = (t) => {
    // `cleanSharedM`, where given, is the way home over its own way out and over loops on its own line;
    // water shared with a loop on another line (concentric, trollLoopSteps()) is old water for filling
    // the day, but going round a creek again is not a double back.
    const own = Number.isFinite(t.cleanSharedM) ? t.cleanSharedM : t.m - t.newM;
    const clean = t.kept !== false && 2 * own <= t.backM;
    const full = t.newM >= fillM;
    const passes = (t.score && t.score.passes) || 0;
    return [clean ? 1 : 0, clean ? t.score.fish : -1, clean ? passes : -1, full ? 1 : 0,
            full ? t.score.structure : t.newM, full ? t.newM : t.score.structure];
  };
  return (x, y) => {
    const a = key(x), b = key(y);
    for (let i = 0; i < a.length; i++) if (b[i] !== a[i]) return b[i] - a[i];
    return 0;
  };
}

/**
 * THE DAY: loops from the ramp, the first on his fish's line, each after it round the same water a
 * steering band shallower or deeper -- or, where his fish are somewhere no loop has been, a loop there.
 *
 * @param {object}   o
 * @param {number[]} o.ramp          [lon, lat]
 * @param {object[]} o.daFeatures    depth_areas.geojson features -- REQUIRED
 * @param {number}   o.windowMin     launch to return
 * @param {object[]} [o.catches]     [{at:[lon,lat], chartFt?}] his catches of the day's species; chartFt
 *                                   is the chart under the pin (depthSampler()), null off the chart. Only
 *                                   those on this water and within reach of the ramp count.
 * @param {number}   [o.lineFt]      the line when no catch here says one (loopLine(): research, band)
 * @param {string}   [o.lineFrom]    where o.lineFt came from, carried back on `line`
 * @param {number}   [o.floorFt]     the old floor; read as a line one steering band deeper when no
 *                                   lineFt is given. Nothing is closed by it.
 * @param {number}   [o.stopMin]     minutes held back for stops
 * @param {number}   [o.offsetFt]    lake below the chart, ft
 * @param {object[]} [o.shoreFeatures], [o.koFeatures]
 * @param {object[]} [o.marks]       [{at:[lon,lat], value, ...}] what the loop should pass
 * @param {number[][]} [o.via]       where he clicked for a loop to turn, in order
 * @param {number}   [o.maxPetals]   the most loops from the ramp a day is made of (4)
 */
export function* trollLoopSteps(o) {
  if (!(o && Array.isArray(o.daFeatures) && o.daFeatures.length)) throw new Error('trollLoop: this pack has no depth areas, so the water under a line cannot be read');
  const ramp = o.ramp;
  const trollMph = o.trollMph || TROLL_MPH, transitMph = o.transitMph || TRANSIT_MPH;
  const steer = o.steerFt || HAND_STEER_BAND_FT;
  const sameM = o.sameWaterM || SAME_WATER_M, corridorM = o.corridorM || LOOP_CORRIDOR_M;
  const wanderM = o.wanderM || 25;
  const off = Number(o.offsetFt) || 0;
  const maxPetals = o.maxPetals || 4;
  const budgetMin = Math.max(0, (Number(o.windowMin) || 0) - (Number(o.stopMin) || 0));
  const mPerMin = (trollMph * 1609.344) / 60;
  const budgetM = budgetMin * mPerMin;
  // WITHIN REACH: a day's loop goes out and comes back, so the farthest any of it can be from the ramp,
  // by water, is half of what the day trolls. Ryan, 10/4: "just a fish being caught somewhere on that
  // lake shouldn't count... it needs to be within reach from a landing... a fish in the congaree river
  // above lake marion is a totally different fish than one caught in wyboo creek".
  const reachM = budgetM / 2;
  // The grid only has to reach that far.
  const reach = reachM + 1000;
  const bbox = [ramp[0] - reach / mPerDegLon(ramp[1]), ramp[1] - reach / M_PER_DEG_LAT,
                ramp[0] + reach / mPerDegLon(ramp[1]), ramp[1] + reach / M_PER_DEG_LAT];
  const G = depthGrid(o.daFeatures, { bbox, cellM: o.cellM || 25, offsetFt: o.offsetFt,
                                      keepOut: o.koFeatures, shore: o.shoreFeatures });
  const n = G.w * G.h;

  // ── WHAT A METRE COSTS ON A LINE ──────────────────────────────────────────────────────────────
  // NO FLOOR. Closed is land, uncharted water, the charted shore, keep-out zones and water with none
  // in it today. Everything else is open to every loop, and costs more the further its depth is off
  // that loop's line, by the square of how many steering bands -- so a line rides its contour and only
  // crosses other water where it has to.
  // AN EDGE IS WHERE THE BOTTOM MOVES UNDER HIS WANDER. The span of the bottom within his wander
  // (25 m) of a cell, against his steering band: a cell where it moves a whole band or more is an
  // edge and costs what its depth says; on a flat, where it does not move at all, it costs twice
  // that. On Moultrie's dam basin, 55-60 ft of flat bottom, nothing else told the line to keep to
  // the edge he drew round it.
  const wr = Math.max(1, Math.round(wanderM / G.cellM));
  const flat = new Float64Array(n);
  for (let c = 0; c < n; c++) {
    const dd = G.d[c];
    if (!(dd > 0)) { flat[c] = Infinity; continue; }
    const i = c % G.w, j = (c - i) / G.w;
    let lo = dd, hi = dd;
    for (let dj = -wr; dj <= wr; dj++) for (let di = -wr; di <= wr; di++) {
      const i2 = i + di, j2 = j + dj;
      if (i2 < 0 || j2 < 0 || i2 >= G.w || j2 >= G.h) continue;
      const v = G.d[j2 * G.w + i2];
      if (!Number.isFinite(v)) { lo = -Infinity; continue; }
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    flat[c] = 1 + Math.max(0, 1 - (hi - lo) / steer);
  }
  // One cost a line, the last few kept: a day lays its loops on two to four of them.
  const ctxs = new Map();
  const lineCtx = (lineFt) => {
    let x = ctxs.get(lineFt);
    if (x) return x;
    if (ctxs.size >= 4) ctxs.delete(ctxs.keys().next().value);
    const cost = new Float64Array(n);
    let open = 0, dearest = 0;
    for (let c = 0; c < n; c++) {
      if (!(flat[c] < Infinity)) { cost[c] = Infinity; continue; }
      const v = (1 + ((G.d[c] - lineFt) / steer) ** 2) * flat[c];
      cost[c] = v; open++; if (v > dearest) dearest = v;
    }
    // More than any path that stays out of a stretch of water could cost, per metre: no path visits a
    // cell twice, so none costs more than every open cell at the dearest cost, on the diagonal.
    x = { lineFt, cost, crossM: 2 * open * dearest * Math.SQRT2,
          // HIS CONTOUR ALARM: the line, and his steering band either side of it.
          inBand: (c) => Math.abs(G.d[c] - lineFt) <= steer };
    ctxs.set(lineFt, x);
    return x;
  };

  // ── OUT OF THE COVE, by water ─────────────────────────────────────────────────────────────────
  const fromRamp = (g) => {
    const any = new Float64Array(n);
    for (let c = 0; c < n; c++) any[c] = Number.isFinite(g.d[c]) ? 1 : Infinity;
    let rc = g.cellOf(ramp);
    if (rc < 0) return { error: 'the ramp is outside the chart' };
    if (!(any[rc] < Infinity)) {
      // A ramp sits on the bank: start from the nearest charted water.
      let best = -1, bd = Infinity;
      const ri = rc % g.w, rj = (rc - ri) / g.w;
      for (let r = 1; r < 40 && best < 0; r++) {
        for (let j = rj - r; j <= rj + r; j++) for (let i = ri - r; i <= ri + r; i++) {
          if (i < 0 || j < 0 || i >= g.w || j >= g.h) continue;
          const c = j * g.w + i;
          if (any[c] < Infinity) { const dd = Math.hypot(i - ri, j - rj); if (dd < bd) { bd = dd; best = c; } }
        }
      }
      if (best < 0) return { error: 'no charted water near the ramp' };
      rc = best;
    }
    return { rc, cove: shortestFrom(g, any, rc) };
  };
  let fr = fromRamp(G);
  if (fr.error) return { error: fr.error };
  let { rc, cove } = fr;
  let coveCrossesShore = false;
  // A CANAL LINED WITH DOCKS IS NOT SEALED. Garmin draws docks and piers in the shoreline layer --
  // on Lake Marion 3,011 lines, median 43 m -- and every cell a shore line touches is closed, which
  // is right for the Pinopolis wall and wrong for the canal at Rowland Subdivision: 40-60 m wide with
  // 4-41 m docks out from both banks, it closed solid at 25 m, and from the ramp the nearest open
  // water was one cell cut off from the lake. Ryan's Wyboo Creek day (2026-10-03) came back "No loop:
  // no water 23 ft deep can be reached from the ramp", 583 m from 23 ft water. So when the shore
  // closes the ramp into water too small to hold a loop, the run OUT OF THE COVE -- lines up, his eyes
  // on the docks -- is found on the bands alone (land, uncharted water and keep-out zones still
  // closed), and said. The loops themselves stay on the grid with the shore in it.
  const tooSmall = (cells) => cells * G.cellM < 0.25 * budgetM / maxPetals;
  { let wet = 0; for (let c = 0; c < n; c++) if (cove.len[c] < Infinity && flat[c] < Infinity) wet++;
    if (tooSmall(wet) && (o.shoreFeatures || []).length) {
      const G2 = depthGrid(o.daFeatures, { bbox, cellM: o.cellM || 25, offsetFt: o.offsetFt, keepOut: o.koFeatures });
      const fr2 = G2.w === G.w && G2.h === G.h ? fromRamp(G2) : { error: 'grid' };
      if (!fr2.error) { ({ rc, cove } = fr2); coveCrossesShore = true; }
    } }

  // ── HIS FISH: ON THIS WATER, AND WITHIN REACH OF THE RAMP ──────────────────────────────────────
  // On the water: the chart under the pin (the caller's depthSampler(), exact to the polygon), or this
  // grid's cell when the caller did not say. A pin off the chart is not a fish on this water (Ryan,
  // 10/4: "fish with either no position or incorrect position should not make it into the app").
  // Within reach: by water from the ramp, no farther than half the day -- the cell under the pin or one
  // beside it, since a pin by the bank can sit in a cell the grid calls land.
  const catchesIn = (o.catches || []).filter((m) => m && Array.isArray(m.at));
  const chartOf = (m) => {
    if (Object.prototype.hasOwnProperty.call(m, 'chartFt')) return m.chartFt == null || !Number.isFinite(Number(m.chartFt)) ? null : Number(m.chartFt);
    const v = G.at(m.at);
    return Number.isFinite(v) ? v + off : null;
  };
  const byWater = (at) => {
    const c = G.cellOf(at);
    if (c < 0) return Infinity;
    const i = c % G.w, j = (c - i) / G.w;
    let best = cove.len[c];
    for (const [di, dj] of NB) {
      const i2 = i + di, j2 = j + dj;
      if (i2 < 0 || j2 < 0 || i2 >= G.w || j2 >= G.h) continue;
      const v = cove.len[j2 * G.w + i2]; if (v < best) best = v;
    }
    return best;
  };
  const catches = [], depthsToday = [];
  let offWater = 0, outOfReach = 0;
  for (const m of catchesIn) {
    const told = Object.prototype.hasOwnProperty.call(m, 'chartFt');
    if (told && chartOf(m) == null) { offWater++; continue; }
    // Off this grid is farther than half the day by construction (the grid is that reach and a km).
    if (G.cellOf(m.at) < 0) { outOfReach++; continue; }
    const ch = chartOf(m);
    if (ch == null) { offWater++; continue; }
    if (!(byWater(m.at) <= reachM)) { outOfReach++; continue; }
    catches.push(m);
    depthsToday.push(todayFt(ch, off));
  }
  const line = lineFromDepths(depthsToday, steer)
    || (Number.isFinite(o.lineFt) ? { lineFt: o.lineFt, from: o.lineFrom || 'given', rangeFt: o.lineRangeFt || null }
      : Number.isFinite(o.floorFt) ? { lineFt: o.floorFt + steer, from: 'floor' } : null);
  if (!line) return { error: 'nothing says what depth of water to troll: none of your catches of this fish are within reach of this ramp, and the research names no water' };
  const L0 = line.lineFt;
  const ctx0 = lineCtx(L0);

  // WHERE THE LINES GO IN: the nearest water on his line, by water -- in a body of water a loop fits in.
  // From Short Stay on Moultrie the nearest water deep enough was once one cell of a hole, cut off from
  // the rest; every loop from it failed and the day said no loop fits. Each body of open water (cells
  // joined the way a line can pass between them) is tried nearest first; one too small to hold a
  // turn-around a quarter of the shortest loop out (the turn-around rule below, at the most loops a day
  // has) is passed over, and the first that holds a day is the day's.
  const findBodies = () => {
    const body = new Int32Array(n).fill(-1);
    const bodies = [];
    const q = new Int32Array(n);
    const open = (c) => flat[c] < Infinity;
    for (let c0 = 0; c0 < n; c0++) {
      if (!open(c0) || body[c0] >= 0) continue;
      const id = bodies.length;
      let head = 0, tail = 0, size = 0, near = -1, bl = Infinity;
      q[tail++] = c0; body[c0] = id;
      while (head < tail) {
        const c = q[head++]; size++;
        if (cove.len[c] < bl && ctx0.inBand(c)) { bl = cove.len[c]; near = c; }
        const i = c % G.w, j = (c - i) / G.w;
        for (const [di, dj] of NB) {
          const i2 = i + di, j2 = j + dj;
          if (i2 < 0 || j2 < 0 || i2 >= G.w || j2 >= G.h) continue;
          const c2 = j2 * G.w + i2;
          if (!open(c2) || body[c2] >= 0) continue;
          if (di && dj && !(open(j * G.w + i2) && open(j2 * G.w + i))) continue;
          body[c2] = id; q[tail++] = c2;
        }
      }
      if (near >= 0) bodies.push({ size, near, bl });
    }
    return bodies.sort((a, b) => a.bl - b.bl);
  };
  const bodies = findBodies();
  if (!bodies.length) return { error: `no water near the ${L0} ft line can be reached from the ramp` };
  let S = -1, outOfCove = null, coveM = 0, loopBudgetM = 0;

  // WHAT A LOOP PASSES, IN HIS ORDER: his own catches of the day's species first, then the chart's
  // structure. No weights -- a loop past more of his fish wins, and between loops past the same number
  // of his fish, the one past them more often (a fish passed again on another line counts again), then
  // the one past more structure. A catch counts within the app's "same water" (100 m): the photo is
  // taken after the fish is boated, and the boat has moved. A mark counts within his corridor (50 m).
  // Each fish and each mark counts once in the day.
  const marks = (o.marks || []).filter((m) => m && Array.isArray(m.at));
  const scoreOf = (coords, taken) => {
    let fish = 0, passes = 0, structure = 0;
    for (const a of marksAlong(coords, catches, sameM)) { passes++; if (!taken.has(a.mark)) fish++; }
    for (const a of marksAlong(coords, marks, corridorM)) if (!taken.has(a.mark)) structure++;
    return { fish, passes, structure };
  };
  const fishThenFill = fishBeforeFilling;
  const near = (a, b, m) => {
    const ai = a % G.w, aj = (a - ai) / G.w, bi = b % G.w, bj = (b - bi) / G.w;
    return Math.hypot(ai - bi, aj - bj) * G.cellM < m;
  };

  const corridor = new Uint8Array(n);
  // THE WATER A LOOP ALREADY TROLLED is closed to the loops after it on the same line, sameM either
  // side of it -- except near the cove mouth every loop leaves by, which opens wider until a loop gets
  // out. A loop on ANOTHER line is not closed off by it: going round a creek again a band shallower
  // means crossing the first loop where the two lines meet, at the turn and on a steep bank, and with
  // the first loop's water closed the second was shut inside it and came home beside its own way out
  // (Rowland, 10/4, every one). What the two share is counted instead (sharedWaterM, within his
  // wander), and a loop more old water than new is not added.
  const closedBy = (petals, lineFt, ends) => {
    const b = new Uint8Array(n);
    for (const p of petals) {
      if (p.lineFt !== lineFt) continue;
      const r = Math.ceil(sameM / G.cellM);
      for (const c of p.cells) {
        const i = c % G.w, j = (c - i) / G.w;
        for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
          if (di * di + dj * dj > r * r) continue;
          const i2 = i + di, j2 = j + dj;
          if (i2 < 0 || j2 < 0 || i2 >= G.w || j2 >= G.h) continue;
          b[j2 * G.w + i2] = 1;
        }
      }
    }
    for (let c = 0; c < n; c++) if (b[c] && near(c, S, ends * sameM)) b[c] = 0;
    return b;
  };
  const earlierOf = (petals, lineFt) => petals.map((q) => ({ coords: q.coords, withinM: q.lineFt === lineFt ? sameM : wanderM,
                                                              sameLine: q.lineFt === lineFt }));
  /** One loop on `ctx`'s line from S and back, on water not already used, of about `petalM`. */
  function* petal(ctx, petalM, petals, taken, via, bandOnly) {
    let best = null;
    for (const ends of [2, 4, 8, 16]) {
      best = yield* petalWith(ctx, petalM, closedBy(petals, ctx.lineFt, ends), taken, via, bandOnly, earlierOf(petals, ctx.lineFt));
      if (best || !petals.length) break;
    }
    return best;
  }
  function* petalWith(ctx, petalM, blockA, taken, via, bandOnly, earlier) {
    const tree = shortestFrom(G, ctx.cost, S, { blocked: blockA });
    // A LOOP THROUGH A TURN turns there: the cell on its line nearest it, within three times the same
    // water. A turn he clicked with none of its line near turns at the water nearest the click; a loop
    // going round the first one again (bandOnly) needs its own line there or is not laid.
    if (via) {
      const vc = G.cellOf(via);
      let T = -1, bd = Infinity, Tany = -1, bdAny = Infinity;
      if (vc >= 0) {
        const vi = vc % G.w, vj = (vc - vi) / G.w, r = Math.ceil(sameM * 3 / G.cellM);
        for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
          const i2 = vi + di, j2 = vj + dj;
          if (i2 < 0 || j2 < 0 || i2 >= G.w || j2 >= G.h) continue;
          const c = j2 * G.w + i2, dd = Math.hypot(di, dj);
          if (!(tree.len[c] < Infinity) || dd > r) continue;
          if (ctx.inBand(c) && dd < bd) { bd = dd; T = c; }
          if (dd < bdAny) { bdAny = dd; Tany = c; }
        }
      }
      if (T < 0 && !bandOnly) T = Tany;
      if (T < 0) return null;
      return yield* evaluate(ctx, [T], tree, blockA, petalM, taken, true, earlier);
    }
    // Turn-arounds: water on his line whose way out is a quarter to most of the loop -- the grid path
    // is longer than the line it straightens to, so the length is judged after straightening -- spread
    // apart, the ones most on his line first.
    const cand = [];
    for (let c = 0; c < n; c++) {
      if (!ctx.inBand(c) || !(tree.len[c] >= petalM * 0.25 && tree.len[c] <= petalM * 0.8)) continue;
      cand.push(c);
    }
    cand.sort((x, y) => tree.dist[x] / tree.len[x] - tree.dist[y] / tree.len[y]);
    // Spread over how far out they are as well as where, so a long loop is tried as well as a short one.
    const BINS = 6, perBin = Math.ceil((o.maxTurns || 24) / BINS);
    const picks = [];
    for (let b = 0; b < BINS; b++) {
      const lo = petalM * (0.25 + (0.55 * b) / BINS), hi = petalM * (0.25 + (0.55 * (b + 1)) / BINS);
      let k = 0;
      for (const c of cand) {
        if (tree.len[c] < lo || tree.len[c] >= hi) continue;
        if (picks.every((p) => !near(c, p, 600))) { picks.push(c); if (++k >= perBin) break; }
      }
    }
    return yield* evaluate(ctx, picks, tree, blockA, petalM, taken, false, earlier);
  }
  function* evaluate(ctx, picks, tree, blockA, petalM, taken, forced, earlier) {
    const cost = ctx.cost, crossM = ctx.crossM;
    const tried = [];
    for (const T of picks) {
      yield 'turn';
      let out = pathTo(tree.prev, S, T);
      if (!out) continue;
      let outC = straighten(G, cost, out, blockA).map(G.lonLat);
      if (!forced && lineM(outC) > petalM * 0.6) continue;
      // The way home may not come within sameM of the way out, except at the two ends. Where the
      // water is too narrow for that -- one edge up a river arm -- it crosses the way out's water only
      // where there is no other way.
      let back = null, both = null, apartM = null;
      // Where both have to use one passage near the ramp (the mouth of the cove), the end the two
      // may share there grows until the way home is found. AT THE TURN IT DOES NOT: a way home that
      // can only leave the turn on the way out's water is a turn in a dead end, and the loop comes
      // back on top of itself -- Ryan, 10/4, on Moultrie's first loop from Short Stay (home within
      // 25 m of the way out for 300 m from the turn, at the hump's west tip) and Wateree's third from
      // Clearwater Cove (the same, out of the pocket at the dam): "i do not like this part", "does the
      // same thing". Such a loop is still laid, by the narrow-water step below, and comes after every
      // loop whose way home kept clear (fishBeforeFilling).
      const nearOut = (keepM, ends) => {
        const r = Math.ceil(keepM / G.cellM);
        const marked = [];
        for (const c of out) {
          if (near(c, S, ends * sameM) || near(c, T, 2 * sameM)) continue;
          const i = c % G.w, j = (c - i) / G.w;
          for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
            if (di * di + dj * dj > r * r) continue;
            const i2 = i + di, j2 = j + dj;
            if (i2 < 0 || j2 < 0 || i2 >= G.w || j2 >= G.h) continue;
            const c2 = j2 * G.w + i2;
            if (!corridor[c2]) { corridor[c2] = 1; marked.push(c2); }
          }
        }
        return marked;
      };
      for (const ends of [2, 4, 8, 16]) {
        const keepM = sameM;
        const marked = nearOut(keepM, ends);
        both = new Uint8Array(n);
        for (let c = 0; c < n; c++) if (blockA[c] || corridor[c]) both[c] = 1;
        for (const c of marked) corridor[c] = 0;
        const home = shortestFrom(G, cost, T, { blocked: both, dst: S });
        back = pathTo(home.prev, T, S);
        if (back) { apartM = keepM; break; }
      }
      // NO ROOM FOR TWO LINES: the way home crosses the way out's water only where the water leaves
      // no other way, and as little of it as it can -- each metre within sameM of the way out costs
      // more than any way home round it could (crossM), and each within his wander of it (25 m) as
      // much again, so in a channel with room for one line it keeps to the other edge. It used to come
      // within 25 m of the way out wherever it liked, and failing that home on the way out from end
      // to end: told to turn up the channel west of Wyboo Creek toward Potato Creek (100-190 m wide at
      // 23 ft), the loop came back up the creek on its own track as well. Ryan, 10/4: *"i could easily
      // just go that way and then turn around and come back and then finish the leg"*.
      let homeCost = cost;
      if (!back) {
        homeCost = Float64Array.from(cost);
        const within = new Uint8Array(n);
        for (const keepM of [sameM, wanderM]) {
          for (const c of nearOut(keepM, 2)) {
            homeCost[c] += crossM; corridor[c] = 0;
            if (keepM === sameM) within[c] = 1;
          }
        }
        both = blockA;
        const home = shortestFrom(G, homeCost, T, { blocked: both, dst: S });
        back = pathTo(home.prev, T, S);
        apartM = 0;
        // A WAY HOME THAT ONLY CROSSES THE WAY OUT kept clear of it: it trolls none of it twice, it
        // goes over it (onlyCrosses: Rowland Subdivision, 10/4, the channel toward Potato Creek).
        const xs = back ? crossingsOf(G, back, within, out, sameM) : null;
        if (xs) apartM = sameM;
        // AND THEY DO NOT HAVE TO CROSS. The way out is laid first, the cheapest line to the turn,
        // with no thought for where the way home will have to go: from Rowland it went down the
        // creek, round the end of the point and in along the channel's north edge, which left the way
        // home the south edge and no way back to the creek's west side but across it. Ryan, 10/4:
        // "why cant the solid line keep going straight and then turn into that creek and on the
        // southern end then the northern end turn left and go back up the main channel... why do they
        // have to cross". Where they cross once, the two lines are paired the other way past the
        // crossing: the way out carries on along the line the way home took, to the turn, and the way
        // home comes back along the line the way out took. The same water, the same distance apart;
        // the two now meet where they crossed instead of going over each other. Each is straightened
        // with the other's water as dear as the narrow-water step makes it, so a straight run does not
        // cut across toward the other line.
        // AND AT EVERY CROSSING, NOT ONLY ONE (pairAtCrossings). Ryan, 10/4, on a striper loop from
        // Rowland turned just west of Green Island: "mine crosses itself twice" -- once in the main
        // channel below Wyboo Creek, once at the island -- "this is fishable... i am just being picky".
        const paired = xs && xs.length ? pairAtCrossings(out, back, xs) : null;
        if (paired) {
          out = paired.out;
          back = paired.back;
          const apartFrom = (lineCells) => {
            const was = out;
            out = lineCells;
            const c2 = Float64Array.from(cost);
            for (const c of nearOut(sameM, 2)) { c2[c] += crossM; corridor[c] = 0; }
            out = was;
            return c2;
          };
          outC = straighten(G, apartFrom(back), out, blockA).map(G.lonLat);
          homeCost = apartFrom(out);
          both = blockA;
        }
      }
      if (!back) continue;
      const backC = straighten(G, homeCost, back, both).map(G.lonLat);
      const coords = outC.concat(backC.slice(1));
      const m = lineM(coords);
      if (!forced && m > petalM * 1.02) continue;
      // Water trolled a second time -- the way out again, or a loop earlier in the day -- takes the
      // time and fishes nothing new. On Moultrie from Short Stay, three of four loops left up the same
      // mile of the east edge and two came home along the same stretch of the dam.
      const sharedM = sharedWaterM(outC, backC, sameM, earlier);
      const cleanSharedM = earlier.some((e) => !e.sameLine)
        ? sharedWaterM(outC, backC, sameM, earlier.filter((e) => e.sameLine)) : sharedM;
      tried.push({ T, lineFt: ctx.lineFt, out: outC, back: backC, coords, m, sharedM, cleanSharedM, newM: m - sharedM, backM: lineM(backC),
                   kept: apartM >= sameM,
                   score: scoreOf(coords, taken), apartM, cells: out.concat(back) });
    }
    // THE LOOP PASSES THE MOST OF HIS FISH, AND THEN FILLS ITS SHARE OF THE DAY WITH WATER IT TROLLS
    // ONCE (fishThenFill): between loops past as many of his catches, one that fills before one that
    // does not, then the most structure; when none can, the one that trolls the most new water. A loop
    // that comes home over the water it went out on is still laid -- it just does not count as filling.
    tried.sort(fishThenFill(petalM * 0.85));
    return tried[0] || null;
  }

  // ── THE DAY ───────────────────────────────────────────────────────────────────────────────────
  // CONCENTRIC LOOPS ROUND THE SAME WATER. Ryan, 10/4, on the one loop Rowland Subdivision gave him
  // down Wyboo Creek: "concentric loops around the same creek which is what i would actually fish".
  // The first loop rides his fish's line. Each loop after it is one of:
  //   - ROUND THE SAME WATER AGAIN: through the first loop's turn, on the next line out -- a steering
  //     band shallower or a band deeper than the lines already laid, whichever passes his fish better
  //     (fishThenFill); his Contour alarm set a band over, the way he would go round again;
  //   - SOMEWHERE ELSE: on his fish's line, on water no loop has trolled -- looked for only while his
  //     fish within reach are not all passed, or when nothing goes round again. Where his fish are
  //     somewhere the first loop is not, the loop that passes them wins; where they are not, going
  //     round his fish's water again wins on the times past them.
  // A turn he clicked turns that loop: on his fish's line, unless that loop would come back over the
  // day's water -- then a band shallower or deeper, so a second click in the same creek is the same
  // creek on another line. The first loop's size is tried at the whole day and at a half, a third and
  // a quarter of it; a loop after it must fit the time left. The day stops at a loop that is more old
  // water than new, as it always did, or when no loop fits.
  // A LOOP AFTER THE FIRST IS ONE HE WOULD FISH: it comes home on other water than it went out on
  // (fishBeforeFilling's clean), and each of its two legs is at least the shortest pass he set worth
  // having (Smart Plan card, 0.5 mi as it ships). Without that the day ended in loops of 50-200 m in
  // whatever corner the first loop left -- Rowland, 10/4, three of them after a 17.4 mi loop.
  const minLegM = Number(o.minM) > 0 ? Number(o.minM) : 0;
  const fishable = (q) => q && q.kept !== false
    && 2 * (Number.isFinite(q.cleanSharedM) ? q.cleanSharedM : q.m - q.newM) <= q.backM && q.m >= 2 * minLegM
    // and mostly new water, the rule the day stops on below -- a candidate failing it is not chosen
    && q.sharedM <= q.newM;
  const steps = [];
  for (let s = 1; s <= 3; s++) steps.push(L0 - s * steer, L0 + s * steer);
  const lineOrder = [L0, ...steps].filter((ln) => ln > 0);
  const vias = (o.via || []).filter((v) => Array.isArray(v));
  const tries = [];
  for (const b of bodies) {
    S = b.near;
    outOfCove = (pathTo(cove.prev, rc, S) || [rc, S]).map(G.lonLat);
    outOfCove[0] = ramp;
    coveM = lineM(outOfCove);
    loopBudgetM = budgetM - 2 * coveM * (trollMph / transitMph);
    if (b.size * G.cellM < 0.25 * loopBudgetM / maxPetals) continue;
    // A first loop laid for a turn he clicked is the same at every size: tried once.
    const sizes = vias.length ? [Math.max(1, Math.min(maxPetals, vias.length))] : Array.from({ length: maxPetals }, (_, i) => i + 1);
    for (const k of sizes) {
      const taken = new Set();
      const petals = [];
      let left = loopBudgetM;
      let shallower = 0, deeper = 0, shallowDone = false, deepDone = false;
      const usedLine = (ln) => petals.some((q) => q.lineFt === ln);
      for (let p = 0; p < maxPetals; p++) {
        const pm = left / Math.max(1, k - p);
        yield 'petal';
        let pt = null, asked = false;
        if (vias[p]) {
          let first = null;
          for (const ln of lineOrder) {
            const q = yield* petal(lineCtx(ln), pm, petals, taken, vias[p], false);
            if (!q) continue;
            if (!first) first = q;
            if (!petals.length || q.sharedM <= q.newM) { pt = q; break; }
          }
          pt = pt || first;
          asked = !!pt;
          if (pt && pt.lineFt < L0 && !usedLine(pt.lineFt)) shallower = Math.max(shallower, Math.round((L0 - pt.lineFt) / steer));
          if (pt && pt.lineFt > L0 && !usedLine(pt.lineFt)) deeper = Math.max(deeper, Math.round((pt.lineFt - L0) / steer));
        }
        // A TURN NO LOOP CAN REACH DOES NOT COST HIM THE REST OF THE DAY. Rowland, 10/4: a second turn
        // at Potato Creek's mouth, past the channel the first loop had taken, came back with no loop --
        // and took the Wyboo Creek loop past his four largemouth with it. That loop is now chosen the way
        // every loop he did not click is, and `via` on each loop says which turn it was laid for, so the
        // map can say which turn the day could not reach (turnsReached()).
        if (!pt && !petals.length) pt = yield* petal(ctx0, pm, petals, taken, null, false);
        else if (!pt) {
          const cands = [];
          const turn0 = G.lonLat(petals[0].T);
          if (!shallowDone) {
            const ln = L0 - steer * (shallower + 1);
            const q = ln > 0 ? yield* petal(lineCtx(ln), pm, petals, taken, turn0, true) : null;
            if (fishable(q) && q.m <= left * 1.02) cands.push({ q, side: -1 }); else shallowDone = true;
          }
          if (!deepDone) {
            const ln = L0 + steer * (deeper + 1);
            const q = yield* petal(lineCtx(ln), pm, petals, taken, turn0, true);
            if (fishable(q) && q.m <= left * 1.02) cands.push({ q, side: 1 }); else deepDone = true;
          }
          if (catches.some((m) => !taken.has(m)) || !cands.length) {
            const q = left >= 2 * minLegM ? yield* petal(ctx0, pm, petals, taken, null, false) : null;
            if (fishable(q)) cands.push({ q, side: 0 });
          }
          const order = fishThenFill(pm * 0.85);
          cands.sort((x, y) => order(x.q, y.q));
          if (cands.length) {
            pt = cands[0].q;
            if (cands[0].side < 0) shallower++;
            if (cands[0].side > 0) deeper++;
          }
        }
        if (!pt) break;
        // A LOOP ADDED TO THE DAY IS MOSTLY NEW WATER, OR IT IS A DOUBLE BACK. Where the water near
        // the ramp runs out, the next loop could only go out and come home over water the day already
        // trolled -- on Moultrie from Short Stay, a fourth loop with 5.0 of its 9.2 km trolled twice --
        // and a line that comes back on itself is what he threw the stitched day out for. The day stops
        // at the loops before it; the time left is his, for going back over what produced. A loop he
        // asked for by clicking where it turns is kept.
        if (petals.length && !asked && pt.sharedM > pt.newM) break;
        pt.via = asked ? p : null;
        petals.push(pt);
        left -= pt.m;
        for (const a of marksAlong(pt.coords, marks, corridorM)) taken.add(a.mark);
        for (const a of marksAlong(pt.coords, catches, sameM)) taken.add(a.mark);
        if (left < 2 * minLegM || left <= 0) break;
      }
      if (!petals.length) continue;
      const score = { fish: petals.reduce((a, q) => a + q.score.fish, 0),
                      passes: petals.reduce((a, q) => a + q.score.passes, 0),
                      structure: petals.reduce((a, q) => a + q.score.structure, 0) };
      const m = petals.reduce((a, q) => a + q.m, 0);
      const newM = petals.reduce((a, q) => a + q.newM, 0);
      const backM = petals.reduce((a, q) => a + q.backM, 0);
      const cleanSharedM = petals.reduce((a, q) => a + (Number.isFinite(q.cleanSharedM) ? q.cleanSharedM : q.sharedM), 0);
      tries.push({ petals, score, m, newM, backM, cleanSharedM, kept: petals.every((q) => q.kept) });
    }
    if (tries.length) break;
  }
  if (!tries.length) return { error: `no loop on the ${L0} ft line fits the day from this ramp` };
  // THE DAY FILLS THE DAY, the same rule as each loop -- after his fish (fishThenFill): of the days
  // passing the most of his catches, the most times, one that trolls most of the time he has on water
  // it trolls once, then the most structure; when none of them can, the most new water.
  tries.sort(fishThenFill(loopBudgetM * 0.85));
  const day = tries[0];
  // WHAT FILLING THE DAY WOULD HAVE COST, when the day chosen does not fill it: the best day that
  // does, so the status line can say what the time left would have bought (Rowland: a 16.9 mi loop
  // into the open lower lake, past 2 of his stripers, against 3.9 mi past 4).
  const fills = (t) => t.newM >= loopBudgetM * 0.85;
  const filler = fills(day) ? null : tries.find(fills) || null;
  const loopM = day.m;
  // ── THE LEGS: each loop's way out and its way back ───────────────────────────────────────────
  // Two legs a loop, and no more: one pair of rods out, one back, and a new Contour alarm only at
  // the turn. Cutting wherever the water under the line moved 10 ft (his alarm band) made thirteen
  // half-mile legs of one Wateree day, which is the stitched look this replaces.
  const legs = [];
  day.petals.forEach((pt, pi) => {
    for (const half of ['out', 'back']) {
      const c = pt[half];
      // The deepest charted water within the pipeline's relief radius (250 m) of the line, and
      // how much deeper it is than the line: what is beside the line, for the prompt.
      let deep = -Infinity;
      const r = Math.ceil(250 / G.cellM);
      for (let k = 0; k < c.length; k += 3) {
        const cc = G.cellOf(c[k]); if (cc < 0) continue;
        const ci = cc % G.w, cj = (cc - ci) / G.w;
        for (let dj = -r; dj <= r; dj += 2) for (let di = -r; di <= r; di += 2) {
          if (di * di + dj * dj > r * r) continue;
          const i2 = ci + di, j2 = cj + dj;
          if (i2 < 0 || j2 < 0 || i2 >= G.w || j2 >= G.h) continue;
          const v = G.d[j2 * G.w + i2]; if (v > deep) deep = v;
        }
      }
      legs.push({ coords: c, lengthM: Math.round(lineM(c)), petal: pi, half, lineFt: pt.lineFt,
                  deepestNearbyFt: Number.isFinite(deep) ? Math.round((deep + off) * 10) / 10 : null });
    }
  });
  return {
    ramp, lineFt: L0, steerFt: steer,
    // Where the first line came from: his catches here (how many, how many inside his band of it, and
    // over what water), the research, or the band.
    line,
    // His catches of the species the day weighed: on this water and within reach of the ramp; and how
    // many were left out for a pin off the chart, or beyond half a day by water.
    catches: { used: catches.length, offWater, outOfReach, reachM: Math.round(reachM) },
    cove: outOfCove, coveM: Math.round(coveM),
    // The way out of the cove had to be found without the charted shore line, because the docks in
    // it closed it at this grid. The caller says so.
    coveCrossesShore,
    start: G.lonLat(S),
    legs,
    petals: day.petals.map((p) => ({ out: p.out, back: p.back, m: Math.round(p.m), sharedM: Math.round(p.sharedM),
                                     lineFt: p.lineFt, score: p.score, via: p.via != null ? p.via : null })),
    trolledM: Math.round(loopM), sharedM: Math.round(day.petals.reduce((a, p) => a + p.sharedM, 0)),
    runM: Math.round(2 * coveM),
    minutes: Math.round(minutesFor(loopM, trollMph) + 2 * minutesFor(coveM, transitMph)),
    budgetMin: Math.round(budgetMin),
    // Whether the day fills the time he has on water, and what the best day that does would have been.
    // fillsDay counts water trolled once, as the choice did; fillsTime counts it all, repeats included
    // (Moultrie from Short Stay, 10/4: 8 h 53 min of a 9 h day, 3.1 mi of it trolled twice, so it
    // fills the time and not with new water). onceMinutes is the day less its repeats.
    fillsDay: fills(day),
    fillsTime: day.m >= loopBudgetM * 0.85,
    onceMinutes: Math.round(minutesFor(day.newM, trollMph) + 2 * minutesFor(coveM, transitMph)),
    fillingDay: filler ? { petals: filler.petals.length, m: Math.round(filler.m), score: filler.score } : null,
    score: day.score,
    tried: tries.map((t) => ({ petals: t.petals.length, score: t.score, m: Math.round(t.m), newM: Math.round(t.newM),
                               lines: t.petals.map((p) => p.lineFt), kept: t.kept })),
    grid: { w: G.w, h: G.h, cellM: G.cellM },
  };
}

/**
 * WHICH LINE EACH LOOP RIDES, in words: "the 28 ft line; loop 2 round the same water on 23 ft, loop 3
 * on 33 ft". A loop after the first on the first line went somewhere else; on another line, it went
 * round again (or turned where he clicked). `first` replaces the words for loop 1.
 *
 * @param {object} loop  trollLoop()'s answer
 * @param {{first?: string}} [o]
 */
export function linesSaid(loop, o = {}) {
  const ps = (loop && loop.petals) || [];
  const ft = (p) => Math.round(p && p.lineFt != null ? p.lineFt : loop.lineFt);
  const first = o.first || `the ${ft(ps[0])} ft line`;
  const rest = ps.slice(1).map((p, i) => (ft(p) === ft(ps[0])
    ? `loop ${i + 2} on the same line somewhere else`
    : `loop ${i + 2} ${i === 0 || ps.slice(1, i + 1).every((q) => ft(q) === ft(ps[0])) ? 'round the same water ' : ''}on ${ft(p)} ft`));
  return rest.length ? `${first}; ${rest.join(', ')}` : first;
}

// ── THE LOOP AS PICK WATER PIECES, so the day is built the way every picked day is ──────────────

/**
 * The loop's legs in the shape planFromWater() takes a picked piece in: geometry, the water under
 * the line and within his wander every envelope step (the same depthSampler() the pieces are
 * measured with, the chart's own numbers), what it passes, and Pick Water's reasons.
 *
 * @param {object} loop    trollLoop()'s answer
 * @param {object} o
 * @param {function} o.depthAt     depthSampler() over depth_areas -- chart depths
 * @param {object[]} [o.spots]     castSpots() -- what each leg passes
 * @param {object}   [o.shoreIndex] shorelineIndex()
 * @param {string}   [o.slug], [o.rampName]
 * @param {object}   [o.reasonsWith] what reasons() is given: minM, fishBandFt, holding, todayOffsetFt, wind
 */
export function loopPieces(loop, o) {
  const stepM = 40, wanderM = o.wanderM || 25;
  return (loop.legs || []).map((leg, k) => {
    const st = densify(leg.coords, stepM);
    const line = [], side = [], deep = [];
    let charted = 0;
    for (let i = 0; i < st.length; i++) {
      const a = st[Math.max(0, i - 1)], b = st[Math.min(st.length - 1, i + 1)];
      const kx = mPerDegLon(st[i][1]);
      const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * M_PER_DEG_LAT, L = Math.hypot(dx, dy) || 1;
      const px = (-dy / L) * wanderM / kx, py = (dx / L) * wanderM / M_PER_DEG_LAT;
      const c = o.depthAt(st[i]);
      const l = o.depthAt([st[i][0] + px, st[i][1] + py]), r = o.depthAt([st[i][0] - px, st[i][1] - py]);
      if (c != null) charted++;
      const vals = [c, l, r].filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
      line.push(c != null ? Number(c) : (vals.length ? Math.min(...vals) : 0));
      side.push(vals.length ? Math.min(...vals) : 0);
      deep.push(vals.length ? Math.max(...vals) : 0);
    }
    const sorted = (a) => a.slice().sort((x, y) => x - y);
    const med = (a) => { const q = sorted(a); return q[Math.floor(q.length / 2)]; };
    const sustained = (a) => { let m = Infinity; for (let i = 1; i < a.length; i++) m = Math.min(m, Math.max(a[i - 1], a[i])); return Number.isFinite(m) ? m : Math.min(...a); };
    const r1 = (v) => Math.round(v * 10) / 10;
    const water = {
      line: { minFt: r1(Math.min(...line)), medianFt: r1(med(line)), maxFt: r1(Math.max(...line)), sustainedMinFt: r1(sustained(line)) },
      side: { minFt: r1(Math.min(...side)), medianFt: r1(med(side)), maxFt: r1(Math.max(...side)) },
    };
    const holdsFt = Math.floor(sustained(side));
    const near = marksAlong(leg.coords, o.spots || [], SAME_WATER_M)
      .map((a) => ({ s: a.atM, t: a.mark.type, d: a.offM, ft: Number.isFinite(a.mark.depthFt) ? a.mark.depthFt : undefined }));
    const piece = {
      // Named for its loop and its half, so "loop 1, back" is the second leg of the first loop and
      // not a second loop. The plan of 10/4 called its four legs loop1-loop4, and the model wrote
      // "on loop3" about the second loop's way out.
      runId: `${o.slug || 'water'}#loop${leg.petal + 1}-${leg.half}`,
      key: `L${k + 1}`,
      loop: { petal: leg.petal + 1, half: leg.half },
      holdsFt,
      lengthM: leg.lengthM,
      laneLengthM: leg.lengthM,
      offers: [{ depthFt: holdsFt, lengthM: leg.lengthM }],
      water,
      chartedFrac: st.length ? Math.round((charted / st.length) * 100) / 100 : null,
      relief: null,
      deepestNearbyFt: leg.deepestNearbyFt,
      reliefDropFt: leg.deepestNearbyFt != null ? r1(leg.deepestNearbyFt - water.line.medianFt) : null,
      near,
      envelope: side, envelopeDeep: deep, envelopeLine: line, envelopeStepM: stepM, envelopeM: wanderM,
      coords: leg.coords, fullCoords: leg.coords,
      rampM: o.rampName && loop.ramp ? { [o.rampName]: Math.round(metresBetween(loop.ramp, leg.coords[0])) } : {},
      shallowSide: shallowSide(leg.coords, o.depthAt),
      shoreAspect: o.shoreIndex ? shoreAspect(leg.coords, o.shoreIndex) : null,
      partners: [],
      joins: [],
      duplicates: 0,
    };
    piece.reasons = o.reasonsWith ? reasons(piece, { ...o.reasonsWith, partners: [] }) : { for: [], against: [] };
    return piece;
  });
}

/**
 * The troll's steps for planFromWater({ troll }): out of the cove from the ramp, then each leg
 * starting exactly where the last one ended -- so nothing is run between them.
 */
export function loopSteps(loop, pieces) {
  const steps = [];
  let at = loop.ramp;
  pieces.forEach((p, i) => {
    const from = p.coords[0];
    steps.push({ kind: i === 0 ? 'run' : 'troll', from: at, to: from, m: Math.round(metresBetween(at, from)),
                 shallowestFt: i === 0 ? null : p.holdsFt });
    steps.push({ kind: 'piece', key: p.key, runId: p.runId, holdsFt: p.holdsFt, m: p.lengthM, reversed: false, coords: p.coords });
    at = p.coords[p.coords.length - 1];
  });
  return steps;
}

/**
 * WHERE HE CLICKED FOR A LOOP TO TURN, AND WHETHER ONE DID. Ryan, 10/4: "if i just have to click
 * something and not actually draw an entire route i will give a chance". trollLoop turns a loop at
 * the open cell nearest a turn, looking three times SAME_WATER_M round it; a turn it cannot reach on
 * water the loop may troll leaves that loop out of the day rather than failing it. So each turn comes
 * back with how far the nearest line of the day passes it, and whether that is the loop turning there
 * -- the map says which turns the day went to and which it could not, instead of dropping one quietly.
 *
 * @param {Array<[number, number]>} turns  [lon, lat] each, in the order he clicked them
 * @param {object} loop                    trollLoop()'s answer
 * @param {number} [withinM]               how near counts; the search radius plus a cell by default
 */
export function turnsReached(turns, loop, withinM) {
  const lim = withinM != null ? withinM : 3 * SAME_WATER_M + ((loop && loop.grid && loop.grid.cellM) || 25);
  const legs = (loop && loop.legs) || [];
  const petals = (loop && loop.petals) || [];
  // THE LOOP SAYS WHICH TURN EACH OF ITS LOOPS WAS LAID FOR, when it was laid since that was recorded.
  // That is the answer; the distance is then only how far from his click the loop turned -- a click on
  // the bank, or on water shallower than the floor, turns it at the nearest water it may troll, which on
  // Potato Creek's mouth was 400 m off and still the loop he asked for.
  const told = petals.some((p) => p && p.via != null);
  return (turns || []).map((at, i) => {
    const pi = told ? petals.findIndex((p) => p && p.via === i) : -1;
    const mine = pi >= 0 ? legs.filter((l) => l.petal === pi) : legs;
    let best = Infinity;
    for (const l of mine) for (const c of densify(l.coords || [], 20)) {
      const d = metresBetween(at, c);
      if (d < best) best = d;
    }
    // A TURN ON WATER THE DAY ALREADY TROLLS has no loop of its own -- a second loop there would come
    // back over the first -- but the day goes past it: Rowland, 10/4, a turn clicked on the channel
    // the Potato Creek loop runs down. Said, so it is not shown as water the day could not reach.
    let passM = Infinity, passPetal = null;
    if (pi < 0) {
      for (const l of legs) for (const c of densify(l.coords || [], 20)) {
        const d = metresBetween(at, c);
        if (d < passM) { passM = d; passPetal = l.petal; }
      }
    }
    return { at, offM: Number.isFinite(best) ? Math.round(best) : null,
             reached: told ? pi >= 0 : best <= lim, petal: pi >= 0 ? pi : null,
             // within the same distance a turn is looked for in -- the water there is that loop's own
             passedBy: pi < 0 && passM <= lim ? passPetal : null };
  });
}

/**
 * PAST EVERY CROSSING, THE TWO LINES PAIRED THE OTHER WAY. A way home that crosses the way out goes
 * over to the far side of it and, crossing again, comes back. Between each pair of crossings the two
 * lines trade places: the way out carries on along the way home's line to the next crossing, the way
 * home along the way out's. The same water and the same two lines, which now meet where they crossed
 * instead of going over each other. One crossing is the case `88a35cd` handled; this is that rule at
 * any number of them.
 *
 * @param {number[]} out   the way out, ramp to turn (any points)
 * @param {number[]} back  the way home, turn to ramp
 * @param {{x: number, k: number}[]} xs  each crossing: its index on `back` and on `out` (crossingsOf)
 * @returns {{out: number[], back: number[]}|null}  null when the crossings do not come in the order a
 *          loop makes them -- the first along the way out the last along the way home
 */
export function pairAtCrossings(out, back, xs) {
  if (!Array.isArray(xs) || !xs.length || !out || !back) return null;
  const c = xs.slice().sort((a, b) => a.k - b.k);
  const hr = back.slice().reverse();          // the way home, ramp to turn, like the way out
  const ks = [0], hs = [0];
  for (const q of c) { ks.push(q.k); hs.push(back.length - 1 - q.x); }
  ks.push(out.length - 1); hs.push(hr.length - 1);
  for (let i = 1; i < ks.length; i++) if (ks[i] < ks[i - 1] || hs[i] < hs[i - 1]) return null;
  let o2 = [], h2 = [];
  for (let i = 0; i + 1 < ks.length; i++) {
    const so = out.slice(ks[i], ks[i + 1] + 1), sh = hr.slice(hs[i], hs[i + 1] + 1);
    if (i % 2 === 0) { o2 = o2.concat(so); h2 = h2.concat(sh); } else { o2 = o2.concat(sh); h2 = h2.concat(so); }
  }
  return { out: o2, back: h2.reverse() };
}

/** trollLoopSteps() run straight through. */
export function trollLoop(o) {
  const g = trollLoopSteps(o);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}

/**
 * trollLoopSteps() WITHOUT FREEZING THE PAGE: handed back to the browser whenever it has held it
 * longer than a frame or two, the way offerWaterAsync() is ("pickwater is causing the browser to
 * hang", 2026-09-26). `onStep(n)` is told how many turn-arounds have been tried.
 */
export async function trollLoopAsync(o, onStep) {
  const g = trollLoopSteps(o);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let t = now(), n = 0;
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    if (r.value === 'turn') n++;
    if (now() - t > 40) {
      if (onStep) onStep(n);
      await new Promise((res) => setTimeout(res, 0));
      t = now();
    }
  }
}
