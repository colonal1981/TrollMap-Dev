/**
 * plan-areas.js -- THE DAY IS SPENT IN THE AREAS THE REPORTS NAME, NOT TURNED AT THEM.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-11-06, on the loops laid through the report places from Short Stay on Moultrie: "we shouldn't let the
 * route length dictate trolling speed... faster you go the shallower the sinking lures run... why is that loop is so
 * long does it need to be that long... do all 3 loops need to be ran", and "just because a place is mentioned in a
 * report why would there be a turn there? that part confuses me". Then, of the dam and the Bonneau flats: "i feel like
 * honestly those are 2 different areas to concentrate in". And of the run between them: "if i am going to run out
 * somewhere lets do it at about 3 mph and during that time put 2 deep diving crankbaits that match the fishing depth
 * and allowable depth for that run... 3mph is slow enough that the crankbaits won't blow out and striper will hit a
 * bait moving that fast if they are hungry lol". Shown a sample of the day laid that way (two areas, three ways to
 * spend Sunday): "yeah that works... i think...".
 *
 * So, where the reports name places for his fish around this date:
 *   - EACH PLACE IS AN AREA, a choice with its distance and time BY WATER from the ramp: the water within AREA_R_M of
 *     the place, at the depth the reports put his fish over, outside the keep-out zones.
 *   - THE DAY IS SPENT IN THE AREA. Laps on the reports' depth line, round the area and back to where the run came in,
 *     out one side and back the other (the loop he trolls, trollLoop()), and a second lap a steering band deeper or
 *     shallower; gone round again until it is time to go home. No filler loop: the time a lap does not fill is said
 *     as his.
 *   - A RUN IS TROLLED AT RUN_MPH WITH TWO DEEP DIVERS, chosen from his crankbaits for the run's floor and the fish's
 *     depth (runDivers()). Lines up out of the cove; in where the water holds deep enough for them the rest of the way.
 *   - THE OPTIONS are each area all day and, where two areas fit, both: the nearer first, then the run across, then
 *     home from the farther.
 *
 * My choices inside it, not his: the area is everything within 3/4 mile of the place (said on the sample, his to
 * change); the run prefers water at the reports' depth and goes shallower only where it must; of the pairs of divers
 * that reach the fish's depth and keep 85% of the most of the run any pair could troll, the nearest the fish, then the
 * deeper; a run under 800 m trolled is run with the lines up; "both" splits the time in the areas in half, in whole laps.
 *
 * Pure: no DOM, no fetch. The caller hands in parsed GeoJSON.
 */
import { depthGrid, shortestFrom, pathTo, straighten, trollLoop, densify } from './plan-troll-loop.js';
import { metresBetween, minutesFor } from './plan-candidates.js';
import { TROLL_MPH, TRANSIT_MPH } from './plan-water.js';
import { HAND_STEER_BAND_FT } from './plan-tracks.js';
import { LURE_KNOWLEDGE } from '../data/lure-knowledge.js';

/** An area is the water within this of the place a report names: 3/4 mile. */
export const AREA_R_M = 1200;
/** His run speed, with two deep divers out. */
export const RUN_MPH = 3.0;
/** How many rods go out on a run. */
export const RUN_RODS = 2;
/** Shorter than this trolled, a run is run with the lines up. */
export const MIN_RUN_TROLLED_M = 800;
/** The farthest a lap goes round its line before it turns: about an hour's lap at 2 mph, out one side and back. */
export const LAP_OUT_M = 1700;
/** A deeper pair of divers is used while it keeps this much of the most of the run any pair could troll. */
const RUN_KEEP = 0.85;

const M_PER_DEG_LAT = 110540.0;
const mPerDegLon = (lat) => 111320.0 * Math.cos((lat * Math.PI) / 180);
const lineM = (c) => { let m = 0; for (let k = 1; k < c.length; k++) m += metresBetween(c[k - 1], c[k]); return m; };
const fin = (v) => v != null && v !== '' && Number.isFinite(Number(v));

/** The crankbaits in his bag that can go out on a run, with the depth each is rated to. */
export function runCrankbaits(inventory) {
  const seen = new Set();
  return (inventory || [])
    .filter((l) => l && l.trollable !== false && /^crankbait_/.test(String(l.type || '')))
    .map((l) => ({ l, k: LURE_KNOWLEDGE[l.type] }))
    .filter(({ k }) => k && k.ratedDepth && fin(k.ratedDepth.min) && fin(k.ratedDepth.max))
    .filter(({ l }) => (seen.has(l.name) ? false : seen.add(l.name)))
    .map(({ l, k }) => ({ name: l.name, type: l.type, min: Number(k.ratedDepth.min), max: Number(k.ratedDepth.max),
                          maxMph: k.speed && fin(k.speed.max) ? Number(k.speed.max) : null }))
    .sort((a, b) => b.max - a.max || b.min - a.min || a.name.localeCompare(b.name));
}

/**
 * WHICH TWO DEEP DIVERS GO OUT ON A RUN, AND WHERE THE LINES GO IN.
 *
 * `depths` is today's water at each station along the run, `cum` the metres to each. A pair of divers needs the water
 * at least its deeper bait's rated depth plus his steering band under it; the lines go in where the water holds that
 * (two soundings in a row, the app's "sustained") the rest of the way. Of the pairs that reach the fish's depth and keep
 * most of the run trolled (RUN_KEEP of the best), the one whose depths best cover the fish's, then the deeper. Only baits rated under RUN_MPH's ceiling are used.
 *
 * @returns {{rods: object[], linesInM: number, floorFt: number, trolledM: number, needFt: number}|{rods: [], why: string}}
 */
export function runDivers(depths, cum, cranks, { steerFt = HAND_STEER_BAND_FT, fishFt = null, mph = RUN_MPH } = {}) {
  const n = (depths || []).length;
  const total = n ? cum[n - 1] : 0;
  if (n < 2) return { rods: [], why: 'the run is too short to troll', trolledM: 0 };
  // The sustained depth at each station, and the shallowest of it from there to the end.
  const sus = depths.map((d, i) => {
    const a = Number(d), b = i ? Number(depths[i - 1]) : Number(d);
    return Number.isFinite(a) && Number.isFinite(b) ? Math.max(a, b) : Number.isFinite(a) ? a : -Infinity;
  });
  const suf = new Array(n);
  for (let i = n - 1, m = Infinity; i >= 0; i--) { m = Math.min(m, sus[i]); suf[i] = m; }
  const ok = (cranks || []).filter((c) => c.maxMph == null || c.maxMph >= mph);
  if (!ok.length) return { rods: [], why: `no crankbait in the bag is rated to ${mph} mph`, trolledM: 0 };
  const pairs = [];
  for (const cap of [...new Set(ok.map((c) => c.max))]) {
    const pair = ok.filter((c) => c.max <= cap).slice(0, RUN_RODS);
    if (!pair.length || pairs.some((p) => p.rods.map((r) => r.name).join('|') === pair.map((r) => r.name).join('|'))) continue;
    const needFt = Math.max(...pair.map((r) => r.max)) + steerFt;
    let i0 = -1;
    for (let i = 0; i < n; i++) if (suf[i] >= needFt) { i0 = i; break; }
    if (i0 < 0) continue;
    pairs.push({ rods: pair, needFt, i0, linesInM: Math.round(cum[i0]), trolledM: Math.round(total - cum[i0]),
                 floorFt: Math.round(suf[i0] * 10) / 10 });
  }
  const trollable = pairs.filter((p) => p.trolledM >= MIN_RUN_TROLLED_M);
  if (!trollable.length) {
    const floor = Math.round(Math.max(...sus.slice(Math.floor(n / 4))));
    return { rods: [], trolledM: 0,
             why: pairs.length ? `the water deep enough for a deep diver holds for under ${(MIN_RUN_TROLLED_M / 1609.344).toFixed(1)} mi of it`
               : `it never holds water deep enough for any crankbait in the bag (about ${floor} ft at most)` };
  }
  const cover = (p) => {
    if (!Array.isArray(fishFt) || fishFt.length !== 2) return 0;
    const lo = Math.min(...p.rods.map((r) => r.min)), hi = Math.max(...p.rods.map((r) => r.max));
    return Math.max(0, Math.min(hi, fishFt[1]) - Math.max(lo, fishFt[0]));
  };
  // A shallower pair can always go in sooner, so "the most of the run trolled" alone picks the shallowest baits in the
  // bag. Of the pairs that reach the fish's depth, those that keep most of the run trolled (RUN_KEEP of the best); of
  // those the nearest the fish, then the deeper. Where none reaches the fish, the deepest pair that keeps it.
  const near = (set) => { const b = Math.max(...set.map((p) => p.trolledM)); return set.filter((p) => p.trolledM >= RUN_KEEP * b); };
  const covering = trollable.filter((p) => cover(p) > 0);
  const usable = covering.length ? near(covering) : near(trollable);
  usable.sort((a, b) => cover(b) - cover(a) || b.needFt - a.needFt);
  const u = usable[0];
  return { rods: u.rods, linesInM: u.linesInM, floorFt: u.floorFt, trolledM: u.trolledM, needFt: u.needFt, i0: u.i0 };
}

/** The water along a path, every `stepM`: today's depth (the grid's), and the metres to each station. */
function profile(G, coords, stepM = 40) {
  const st = densify(coords, stepM);
  const cum = [0];
  for (let k = 1; k < st.length; k++) cum.push(cum[k - 1] + metresBetween(st[k - 1], st[k]));
  return { st, cum, depths: st.map((p) => { const v = G.at(p); return Number.isFinite(v) ? v : NaN; }) };
}

/** Split a path at `atM` metres along it: [before, after]. */
function splitAt(coords, atM) {
  if (!(atM > 0)) return [[coords[0]], coords.slice()];
  let run = 0;
  for (let k = 1; k < coords.length; k++) {
    const a = coords[k - 1], b = coords[k], m = metresBetween(a, b);
    if (run + m >= atM) {
      const t = m > 0 ? (atM - run) / m : 0;
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      return [[...coords.slice(0, k), p], [p, ...coords.slice(k)]];
    }
    run += m;
  }
  return [coords.slice(), [coords[coords.length - 1]]];
}

/**
 * THE AREAS AND THE WAYS TO SPEND THE DAY IN THEM.
 *
 * @param {object}   o
 * @param {number[]} o.ramp         [lon, lat]
 * @param {object[]} o.daFeatures   depth_areas.geojson features -- REQUIRED
 * @param {object[]} [o.koFeatures], [o.shoreFeatures]
 * @param {number}   [o.offsetFt]   the lake below its chart, ft
 * @param {object[]} o.places       [{at, name, n, why}] the places the reports name for his fish, most first
 * @param {number[]} o.waterFt      [lo, hi] the water the reports put his fish over
 * @param {number[]} [o.fishFt]     [lo, hi] how deep the reports put the fish themselves
 * @param {number}   o.windowMin    launch to return
 * @param {number}   [o.stopMin]    minutes held back for his stops
 * @param {object[]} [o.cranks]     runCrankbaits(inventory)
 * @param {object[]} [o.marks]      [{at, type, what, depthFt}] structure: the laps are laid past it, the area lists it
 * @param {string}   [o.launchTime] 'HH:MM', for the clock on each option
 */
export function layAreas(o) {
  if (!(o && Array.isArray(o.daFeatures) && o.daFeatures.length)) return { error: 'this pack has no depth areas, so the water in an area cannot be read' };
  if (!Array.isArray(o.ramp)) return { error: 'no ramp' };
  const water = Array.isArray(o.waterFt) && o.waterFt.length === 2 && o.waterFt.every(fin) ? o.waterFt.map(Number) : null;
  if (!water) return { error: 'the reports give no depth of water for the areas' };
  const places = (o.places || []).filter((p) => p && Array.isArray(p.at));
  if (!places.length) return { error: 'the reports name no place' };
  const steer = Number(o.steerFt) || HAND_STEER_BAND_FT;
  const R = Number(o.radiusM) || AREA_R_M;
  const cellM = Number(o.cellM) || 25;
  const ramp = o.ramp;
  const budgetMin = Math.max(0, (Number(o.windowMin) || 0) - (Number(o.stopMin) || 0));
  const [lo, hi] = water[0] <= water[1] ? water : [water[1], water[0]];
  const lineA = Math.round((lo + hi) / 2);
  const lineB = lineA + steer <= hi + 1 ? lineA + steer : lineA - steer >= lo - 1 ? lineA - steer : null;

  // ── ONE GRID FOR THE RAMP AND EVERY AREA ─────────────────────────────────────────────────────
  const pad = R + 1500;
  const xs = [ramp[0], ...places.map((p) => p.at[0])], ys = [ramp[1], ...places.map((p) => p.at[1])];
  const midLat = (Math.min(...ys) + Math.max(...ys)) / 2;
  const bbox = [Math.min(...xs) - pad / mPerDegLon(midLat), Math.min(...ys) - pad / M_PER_DEG_LAT,
                Math.max(...xs) + pad / mPerDegLon(midLat), Math.max(...ys) + pad / M_PER_DEG_LAT];
  const gridWith = (shore) => depthGrid(o.daFeatures, { bbox, cellM, offsetFt: o.offsetFt, keepOut: o.koFeatures, shore });
  let G = gridWith(o.shoreFeatures);
  const n = () => G.w * G.h;

  // THE RUN: on any charted water out of the keep-out zones, dearer the shallower it is than the reports' water, so it
  // keeps to water the divers clear where there is any and goes shallow only where it has to (the cove).
  const runCostOf = (g) => {
    const c = new Float64Array(g.w * g.h);
    for (let k = 0; k < c.length; k++) {
      const d = g.d[k];
      c[k] = !Number.isFinite(d) || d <= 0 ? Infinity : d >= lo ? 1 : 1 + 3 * ((lo - d) / steer);
    }
    return c;
  };
  const rampCell = (g, cost) => {
    let rc = g.cellOf(ramp);
    if (rc < 0) return -1;
    if (cost[rc] < Infinity) return rc;
    const ri = rc % g.w, rj = (rc - ri) / g.w;
    let best = -1, bd = Infinity;
    for (let r = 1; r < 40 && best < 0; r++) {
      for (let j = rj - r; j <= rj + r; j++) for (let i = ri - r; i <= ri + r; i++) {
        if (i < 0 || j < 0 || i >= g.w || j >= g.h) continue;
        const c = j * g.w + i;
        if (cost[c] < Infinity) { const dd = Math.hypot(i - ri, j - rj); if (dd < bd) { bd = dd; best = c; } }
      }
    }
    return best;
  };
  let runCost = runCostOf(G);
  let rc = rampCell(G, runCost);
  if (rc < 0) return { error: 'no charted water near the ramp' };
  let tree = shortestFrom(G, runCost, rc);
  // A CANAL LINED WITH DOCKS IS NOT SEALED (trollLoopSteps(), Rowland 10/3): where the charted shore closes the ramp
  // into a pocket, the run out is found on the depth bands alone, and said.
  let coveCrossesShore = false;
  { let reach = 0; for (let k = 0; k < n(); k++) if (tree.len[k] < Infinity) reach++;
    if (reach * cellM * cellM < 4 * R * R && (o.shoreFeatures || []).length) {
      const G2 = gridWith(null), c2 = runCostOf(G2), r2 = rampCell(G2, c2);
      if (r2 >= 0) { G = G2; runCost = c2; rc = r2; tree = shortestFrom(G, runCost, rc); coveCrossesShore = true; }
    } }

  const inCircle = (c, at) => metresBetween(G.lonLat(c), at) <= R;
  const mPerMin = (TROLL_MPH * 1609.344) / 60;
  const cranks = o.cranks || [];
  const fishFt = Array.isArray(o.fishFt) && o.fishFt.length === 2 && o.fishFt.every(fin) ? o.fishFt.map(Number) : null;

  /** A run along `cells` (a grid path): its line, where the lines go in, and the two divers. */
  const runOf = (cells, { fromCove = true } = {}) => {
    if (!cells || cells.length < 2) return null;
    const coords = straighten(G, runCost, cells).map(G.lonLat);
    if (fromCove) coords[0] = ramp;
    const pr = profile(G, coords);
    const lengthM = Math.round(pr.cum[pr.cum.length - 1] || 0);
    const div = runDivers(pr.depths, pr.cum, cranks, { steerFt: steer, fishFt });
    const trolled = div.rods.length ? div : null;
    const [up, down] = trolled ? splitAt(coords, trolled.linesInM) : [coords, [coords[coords.length - 1]]];
    return {
      coords, lengthM,
      upCoords: up, upM: Math.round(lineM(up)),                               // lines up: out of the cove
      trolledCoords: trolled ? down : null, trolledM: trolled ? trolled.trolledM : 0,
      rods: trolled ? trolled.rods : [], floorFt: trolled ? trolled.floorFt : null, needFt: trolled ? trolled.needFt : null,
      why: trolled ? null : div.why,
      shallowestFt: Math.round(Math.min(...pr.depths.filter(Number.isFinite)) * 10) / 10,
    };
  };
  const runMinutes = (r) => (r ? minutesFor(r.upM, TRANSIT_MPH) + minutesFor(r.trolledM, RUN_MPH) : 0);

  /** The water on `lineFt` inside the circle round `at`, from cell `from`: the cell farthest round it, by its line. */
  const lineCostIn = (lineFt, at) => {
    const c = new Float64Array(n()).fill(Infinity);
    const ci = G.cellOf(at);
    if (ci < 0) return c;
    const r = Math.ceil(R / cellM), pi = ci % G.w, pj = (ci - pi) / G.w;
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const i = pi + di, j = pj + dj;
      if (i < 0 || j < 0 || i >= G.w || j >= G.h || Math.hypot(di, dj) * cellM > R) continue;
      const k = j * G.w + i, d = G.d[k];
      if (Number.isFinite(d) && d >= lineFt - steer) c[k] = 1 + ((d - lineFt) / steer) ** 2;
    }
    return c;
  };
  // A LAP IS NOT THE WHOLE AREA. "why is that loop is so long does it need to be that long": the lap turns at the
  // farthest water on its line no more than LAP_OUT_M round it from where it starts, so a lap is about an hour.
  const farOnLine = (lineFt, at, from) => {
    const cost = lineCostIn(lineFt, at);
    if (!(cost[from] < Infinity)) return null;
    const t = shortestFrom(G, cost, from);
    let T = -1, bl = 0;
    for (let k = 0; k < t.len.length; k++) {
      if (t.len[k] < Infinity && t.len[k] <= LAP_OUT_M && Math.abs(G.d[k] - lineFt) <= steer && t.len[k] > bl) { bl = t.len[k]; T = k; }
    }
    return T >= 0 ? { T, alongM: bl } : null;
  };
  /** One lap from the entry, round the line to its far end in the area and back the other side (trollLoop()). */
  const lapOf = (lineFt, area, E) => {
    // the nearest cell on this line to the entry, inside the area
    let from = -1, bd = Infinity;
    const ei = E % G.w, ej = (E - ei) / G.w, r = Math.ceil(R / cellM);
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const i = ei + di, j = ej + dj;
      if (i < 0 || j < 0 || i >= G.w || j >= G.h) continue;
      const k = j * G.w + i;
      if (!(Math.abs(G.d[k] - lineFt) <= steer) || !inCircle(k, area.at)) continue;
      const dd = Math.hypot(di, dj);
      if (dd < bd) { bd = dd; from = k; }
    }
    if (from < 0) return null;
    const far = farOnLine(lineFt, area.at, from);
    if (!far || far.alongM < 300) return null;
    const lap = trollLoop({
      ramp: G.lonLat(E), daFeatures: o.daFeatures, koFeatures: o.koFeatures, shoreFeatures: coveCrossesShore ? [] : o.shoreFeatures,
      offsetFt: o.offsetFt, lineFt, lineFrom: 'reports', lineRangeFt: [lo, hi], steerFt: steer,
      windowMin: Math.ceil((3 * far.alongM + 2 * bd * cellM) / mPerMin) + 10, stopMin: 0,
      via: [G.lonLat(far.T)], contourOnly: true, maxPetals: 1, catches: [], marks: o.marks || [], cellM,
    });
    if (!lap || lap.error || !(lap.legs || []).length) return null;
    const legs = lap.legs.filter((l) => (l.coords || []).length > 1);
    const m = legs.reduce((a, l) => a + l.lengthM, 0);
    // the bit from where the run came in to where the lap's lines go in, and back, is trolled too
    const joinM = lap.coveM || 0;
    return { lineFt, legs, m, joinM, joinCoords: lap.cove || null, minutes: Math.round(minutesFor(m + 2 * joinM, TROLL_MPH)),
             structure: (lap.score && lap.score.structure) || 0 };
  };

  // ── EACH AREA ───────────────────────────────────────────────────────────────────────────────
  const areas = [];
  const left = [];
  places.forEach((p, idx) => {
    const area = { key: `a${idx + 1}`, name: p.name || `area ${idx + 1}`, at: p.at, n: p.n || 0, why: p.why || '', years: p.years };
    // Where the run comes in: the water on the reports' line inside the area nearest the ramp, by the run.
    let E = -1, be = Infinity, cells = 0, inBand = 0;
    const ci = G.cellOf(p.at);
    if (ci < 0) { left.push({ ...area, left: 'off the chart' }); return; }
    const r = Math.ceil(R / cellM), pi = ci % G.w, pj = (ci - pi) / G.w;
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const i = pi + di, j = pj + dj;
      if (i < 0 || j < 0 || i >= G.w || j >= G.h || Math.hypot(di, dj) > r) continue;
      const k = j * G.w + i, d = G.d[k];
      if (!Number.isFinite(d)) continue;
      cells++;
      if (d >= lo && d <= hi) inBand++;
      if (Math.abs(d - lineA) <= steer && tree.dist[k] < be) { be = tree.dist[k]; E = k; }
    }
    area.acres = Math.round((inBand * cellM * cellM) / 4046.86);
    area.waterFt = [lo, hi];
    if (E < 0 || !(be < Infinity)) { left.push({ ...area, left: `no ${lineA} ft water inside it can be reached from the ramp` }); return; }
    area.entry = G.lonLat(E);
    area.run = runOf(pathTo(tree.prev, rc, E));
    if (!area.run) { left.push({ ...area, left: 'no way to it by water' }); return; }
    // NEAR THE RAMP THERE IS NO RUN: lines in where the area starts.
    if (area.run.trolledM < MIN_RUN_TROLLED_M) {
      area.near = true;
      area.run = { ...area.run, upCoords: area.run.coords, upM: area.run.lengthM, trolledCoords: null, trolledM: 0, rods: [] };
    }
    area.runMin = Math.round(runMinutes(area.run));
    area.laps = [lineA, lineB].filter((ln) => ln != null).map((ln) => lapOf(ln, area, E)).filter(Boolean);
    if (!area.laps.length) { left.push({ ...area, left: `no lap on the ${lineA} ft line fits inside it` }); return; }
    area.marks = (o.marks || []).filter((m) => m && Array.isArray(m.at) && metresBetween(m.at, p.at) <= R
      && (!fin(m.depthFt) || (Number(m.depthFt) >= lo - 2 * steer && Number(m.depthFt) <= hi + steer)));
    area.E = E;
    areas.push(area);
  });

  // ── THE WAYS TO SPEND THE DAY ───────────────────────────────────────────────────────────────
  const clock = (min) => {
    const m0 = /^(\d{1,2}):(\d{2})/.exec(String(o.launchTime || ''));
    if (!m0) return null;
    const t = (Number(m0[1]) * 60 + Number(m0[2]) + Math.round(min)) % 1440;
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };
  /** Whole laps of an area in `min`, the two lines in turn: [{lap, minutes}], and what is left. */
  // The two lines in turn, then whichever still fits; started on whichever line leaves the least over.
  const lapsIn = (area, min) => {
    let best = null;
    for (let s0 = 0; s0 < area.laps.length; s0++) {
      const out = [];
      let t = 0;
      for (let k = 0; k < 200; k++) {
        let lap = area.laps[(s0 + k) % area.laps.length];
        if (t + lap.minutes > min) lap = area.laps.find((l) => t + l.minutes <= min);
        if (!lap) break;
        out.push(lap); t += lap.minutes;
      }
      if (!best || t > best.t) best = { out, t };
    }
    return { laps: best.out, usedMin: Math.round(best.t), leftMin: Math.round(min - best.t) };
  };
  const options = [];
  const optionOf = (parts, label) => {
    // parts: [{kind:'run', run, reversed?, from, to}, {kind:'area', area, min}]
    let t = 0;
    const steps = [];
    let ok = true;
    for (const p of parts) {
      if (p.kind === 'run') {
        const r = p.run;
        const up = minutesFor(r.upM, TRANSIT_MPH), tr = minutesFor(r.trolledM, RUN_MPH);
        if (p.home) {
          if (r.trolledM) steps.push({ kind: 'run', at: clock(t), min: Math.round(tr), m: r.trolledM, rods: r.rods, floorFt: r.floorFt, home: true, to: p.to });
          t += tr;
          steps.push({ kind: 'up', at: clock(t), min: Math.round(up), m: r.upM, home: true });
          t += up;
        } else {
          if (r.upM >= 50) steps.push({ kind: 'up', at: clock(t), min: Math.round(up), m: r.upM, between: !!p.between, to: p.to });
          t += up;
          if (r.trolledM) steps.push({ kind: 'run', at: clock(t), min: Math.round(tr), m: r.trolledM, rods: r.rods, floorFt: r.floorFt, to: p.to });
          t += tr;
        }
      } else {
        const L = lapsIn(p.area, p.min);
        if (!L.laps.length) ok = false;
        steps.push({ kind: 'area', at: clock(t), min: L.usedMin, area: p.area.key, laps: L.laps.length, leftMin: L.leftMin, lapList: L.laps });
        t += L.usedMin + L.leftMin;
      }
    }
    if (!ok) return null;
    steps.push({ kind: 'ramp', at: clock(t) });
    const fishingMin = steps.filter((s) => s.kind === 'area').reduce((a, s) => a + s.min, 0);
    const runningMin = steps.filter((s) => s.kind === 'run').reduce((a, s) => a + s.min, 0);
    const leftMin = steps.filter((s) => s.kind === 'area').reduce((a, s) => a + s.leftMin, 0);
    return { label, steps, fishingMin, runningMin, leftMin, areas: parts.filter((p) => p.kind === 'area').map((p) => p.area.key), parts };
  };
  for (const a of areas) {
    const inArea = budgetMin - 2 * a.runMin;
    if (inArea < Math.min(...a.laps.map((l) => l.minutes))) { a.tooFar = true; continue; }
    const op = optionOf([{ kind: 'run', run: a.run, to: a.key }, { kind: 'area', area: a, min: inArea },
                         { kind: 'run', run: a.run, home: true }], `${a.name} all day`);
    if (op) options.push(op);
  }
  // BOTH: the two areas the reports name most that each fit a lap, the nearer first.
  const fit = areas.filter((a) => !a.tooFar);
  if (fit.length >= 2) {
    const pair = fit.slice(0, 2).sort((x, y) => x.run.lengthM - y.run.lengthM);
    const [a1, a2] = pair;
    const t12 = shortestFrom(G, runCost, a1.E, { dst: a2.E });
    const cells = pathTo(t12.prev, a1.E, a2.E);
    const across = cells ? runOf(cells, { fromCove: false }) : null;
    if (across) {
      if (across.trolledM < MIN_RUN_TROLLED_M) Object.assign(across, { upCoords: across.coords, upM: across.lengthM, trolledCoords: null, trolledM: 0, rods: [] });
      const acrossMin = runMinutes(across);
      const inAreas = budgetMin - minutesFor(a1.run.upM, TRANSIT_MPH) - minutesFor(a1.run.trolledM, RUN_MPH)
        - acrossMin - a2.runMin;
      const half = inAreas / 2;
      const first = lapsIn(a1, half);
      if (first.laps.length && inAreas - first.usedMin >= Math.min(...a2.laps.map((l) => l.minutes))) {
        const op = optionOf([{ kind: 'run', run: a1.run, to: a1.key }, { kind: 'area', area: a1, min: first.usedMin },
                             { kind: 'run', run: across, between: true, to: a2.key },
                             { kind: 'area', area: a2, min: inAreas - first.usedMin },
                             { kind: 'run', run: a2.run, home: true }], `${a1.name}, then ${a2.name}`);
        if (op) { op.across = across; options.push(op); }
      }
    }
  }
  return {
    areas: areas.map(({ E, ...a }) => a), left, options, lineFt: lineA, lines: [lineA, lineB].filter((x) => x != null),
    waterFt: [lo, hi], fishFt, radiusM: R, budgetMin: Math.round(budgetMin), coveCrossesShore, ramp,
  };
}

/**
 * ONE OPTION AS THE LOOP THE REST OF THE APP READS: legs in the order he fishes them (the run out, the laps, the run
 * across, the run home), each with what it is, so loopPieces(), loopSteps(), the map and Build the day take it as
 * they take a loop. A run leg carries `run`: the speed and the two divers.
 */
export function optionLoop(day, i) {
  const op = day && day.options && day.options[i];
  if (!op) return null;
  const byKey = new Map(day.areas.map((a) => [a.key, a]));
  const legs = [];
  let lap = 0;
  const runLeg = (r, name, reversed, to) => {
    if (!r || !r.trolledM || !r.trolledCoords) return;
    const c = reversed ? r.trolledCoords.slice().reverse() : r.trolledCoords.slice();
    legs.push({ coords: c, lengthM: Math.round(lineM(c)), petal: -1, half: 'run', name,
                run: { mph: RUN_MPH, rods: r.rods.map((x) => x.name), floorFt: r.floorFt, needFt: r.needFt, to: to || null } });
  };
  let areaNo = 0;
  for (const p of op.parts) {
    if (p.kind === 'run') {
      runLeg(p.home ? p.run : p.run, p.home ? 'run-home' : p.between ? 'run-across' : 'run-out', !!p.home,
             p.to ? (byKey.get(p.to) || {}).name : null);
      continue;
    }
    areaNo++;
    const step = op.steps.find((s) => s.kind === 'area' && s.area === p.area.key);
    for (const L of (step && step.lapList) || []) {
      lap++;
      for (const l of L.legs) {
        legs.push({ coords: l.coords, lengthM: l.lengthM, petal: lap - 1, half: l.half, lineFt: L.lineFt, edgeFt: l.edgeFt,
                    deepestNearbyFt: l.deepestNearbyFt, name: `area${areaNo}-lap${lap}-${l.half}`, area: p.area.key });
      }
    }
  }
  const first = op.parts[0] && op.parts[0].run;
  const trolledM = legs.reduce((a, l) => a + l.lengthM, 0);
  const upM = op.parts.filter((p) => p.kind === 'run').reduce((a, p) => a + (p.run.upM || 0), 0);
  const minutes = op.steps.reduce((a, s) => a + (s.min || 0), 0);
  return {
    mode: 'areas', ramp: day.ramp, cove: first ? first.upCoords : null, coveM: first ? first.upM : 0,
    legs, petals: [], trolledM, runM: upM, minutes, budgetMin: day.budgetMin, lineFt: day.lineFt,
    option: i, optionLabel: op.label, day,
    score: { structure: 0, fish: 0, passes: 0 },
  };
}

/** The minutes said as "2 h 10 min" or "45 min". */
export const hm = (min) => {
  const m = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(m / 60), r = m % 60;
  return h ? `${h} h${r ? ` ${r} min` : ''}` : `${r} min`;
};
const mi = (m) => `${((Number(m) || 0) / 1609.344).toFixed(1)} mi`;

/** An option's timeline in words, one line a step. */
export function optionLines(day, op) {
  const byKey = new Map(day.areas.map((a) => [a.key, a]));
  return op.steps.map((s) => {
    const at = s.at ? `${s.at} ` : '';
    if (s.kind === 'up') {
      return `${at}lines up${s.home ? ' into the cove and in to the ramp' : s.between ? ' over the shallow water on the way across' : ' out of the cove'} (${mi(s.m)})`;
    }
    if (s.kind === 'run') {
      return `${at}${s.home ? 'run home' : `run to ${(byKey.get(s.to) || {}).name || 'the next area'}`} at ${RUN_MPH} mph, ${mi(s.m)}, `
        + `about ${hm(s.min)}, trolling ${s.rods.map((r) => r.name).join(' and ')}`;
    }
    if (s.kind === 'area') {
      const a = byKey.get(s.area) || {};
      return `${at}${a.name}: ${s.laps} lap${s.laps === 1 ? '' : 's'}, ${hm(s.min)}`
        + (s.leftMin >= 5 ? `; ${hm(s.leftMin)} more is yours (less than a lap)` : '');
    }
    return `${at}at the ramp`;
  });
}
