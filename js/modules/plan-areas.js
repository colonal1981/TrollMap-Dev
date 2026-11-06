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
 * Then, the same evening: "lets try the bigger area so that i am not doing 10 laps right in front of the dam... i might
 * go crazy". The area is 1.5 miles round the place, and the day in it is different loops on new water before any is
 * gone round again (loopCandidates(), chooseLoops(), lapsIn()).
 *
 * My choices inside it, not his: 1.5 miles (his "bigger"; 3/4 mile before); a loop turns no more than 1,700 m round its
 * line from its start, and its way out keeps to its line for three quarters of it; the lines are the middle of the
 * reports' water and a steering band either side inside it; starts 700 m apart, a loop each way from one; the nearest
 * loop with half its water new next; back the way they came once all are fished; the run prefers water at the reports' depth and goes shallower only where it must; of the pairs of divers
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

/**
 * An area is the water within this of the place a report names: 1.5 miles. It was 3/4 mile, and in front of Pinopolis
 * Dam that held 48 acres of the reports' 30-43 ft water, a strip along the dam side of the basin: a day of ten laps on
 * the same two loops. Ryan, 11/6: "lets try the bigger area so that i am not doing 10 laps right in front of the
 * dam... i might go crazy", after "I dont know how close to the dam the guides call by the dam... i think we might be
 * being a little too literal". At 1.5 miles it is 280 acres, the west shelf across the basin with it.
 */
export const AREA_R_M = 2414;
/** A loop's way out is at least this long: the 600 m the app holds a pass to. */
export const LAP_MIN_OUT_M = 600;
/** The most different loops looked for in one area. */
export const MAX_LOOPS = 6;
/** Where loops may start on a line, at least this far apart. */
const START_APART_M = 700;
/** Water within this of a loop already chosen is not new water. */
const COVER_M = 150;
/**
 * A move between loops shorter than this by water is a join: trolled on at the loop's speed with what is out (or
 * lines up over a shoal, loopSteps()). The same 800 m as a run (MIN_RUN_TROLLED_M): less is not worth changing baits.
 */
export const MIN_MOVE_M = 800;
/** A move with the divers may go this much farther than the shortest way by water to stay over water they clear. */
const MOVE_DETOUR = 2;
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
 * WHERE ON A MOVE THE TWO DIVERS ARE OUT. Ryan, 11/6, of the trip home on his third 11/8 plan drawn lines up across a
 * 3 ft flat: the move home ends where the day came into the area, on the edge of the reports' water, and a move was
 * lines up from its start if any of it was under the divers' need -- so 1.3 miles went lines up for the last few metres.
 * Now as a run is: the lines go in where the water first holds the need and come up where it stops holding it the rest
 * of the way. Shallower water BETWEEN the two is a move lines up from its start, as before. `depths`/`cum` are a
 * profile's stations; a station counts as the deeper of it and the one before (a 40 m blip does not count).
 * {inM, outM, trolledM, floorFt} or {why}.
 */
export function diversStretch(depths, cum, needFt, minM = MIN_MOVE_M) {
  const n = (depths || []).length;
  const held = (k) => { const x = depths[k], y = k ? depths[k - 1] : x; return Number.isFinite(x) && Number.isFinite(y) ? Math.max(x, y) : -Infinity; };
  let i0 = 0;
  while (i0 < n && held(i0) < needFt) i0++;
  let i1 = n - 1;
  while (i1 > i0 && held(i1) < needFt) i1--;
  if (i0 >= i1) return { why: 'never over water the divers clear' };
  let floor = Infinity;
  for (let k = i0; k <= i1; k++) {
    if (held(k) < needFt) return { why: 'shallower water between', atM: Math.round(cum[k]) };
    floor = Math.min(floor, held(k));
  }
  const trolledM = cum[i1] - cum[i0];
  if (trolledM < minM) return { why: 'too little of it over water the divers clear' };
  return { inM: Math.round(cum[i0]), outM: Math.round(cum[i1]), trolledM: Math.round(trolledM), floorFt: Math.round(floor * 10) / 10 };
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
  // The lines a loop may ride: the middle of the reports' water, then a steering band deeper and shallower inside it.
  const lineSet = [lineA, lineA + steer, lineA - steer].filter((ln, i) => i === 0 || (ln >= lo - 1 && ln <= hi + 1 && ln > 0));

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
  // ── THE LOOPS IN AN AREA: NEW WATER BEFORE ANY IS GONE ROUND AGAIN ──────────────────────────────────────────────
  // Ryan, 11/6, of ten laps on the same two loops in front of the dam: "i think for trolling by the dam we could find
  // some more loops instead of just repeating the same exact ones". So the loops are looked for across the area's water:
  // on each line, from starts spread over it, each turning at the farthest water on its line no more than LAP_OUT_M
  // round from its start (about an hour's loop: "why is that loop is so long"). Of those, the one with the most water no
  // chosen loop covers is taken, then the next, while at least half of one is new; they are fished in turn, nearest
  // first from where the run comes in, and only then gone round again.
  const loopCandidates = (area, E) => {
    const out = [];
    const ci = G.cellOf(area.at);
    const r = Math.ceil(R / cellM), pi = ci % G.w, pj = (ci - pi) / G.w;
    const ei = E % G.w, ej = (E - ei) / G.w;
    for (const L of lineSet) {
      const cost = lineCostIn(L, area.at);
      const cells = [];
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        const i = pi + di, j = pj + dj;
        if (i < 0 || j < 0 || i >= G.w || j >= G.h) continue;
        const k = j * G.w + i;
        if (cost[k] < Infinity && Math.abs(G.d[k] - L) <= steer) cells.push(k);
      }
      if (!cells.length) continue;
      // The first start is the water on this line nearest where the run comes in; the rest as far from every start
      // already taken as the line goes, no nearer one another than START_APART_M.
      const ij = (k) => [k % G.w, Math.floor(k / G.w)];
      let s0 = cells[0], b0 = Infinity;
      for (const k of cells) { const [i, j] = ij(k); const dd = Math.hypot(i - ei, j - ej); if (dd < b0) { b0 = dd; s0 = k; } }
      const starts = [s0];
      const minD = cells.map((k) => { const [i, j] = ij(k), [a, b] = ij(s0); return Math.hypot(i - a, j - b); });
      while (starts.length < 5) {
        let bi = -1, bd = 0;
        for (let x = 0; x < cells.length; x++) if (minD[x] > bd) { bd = minD[x]; bi = x; }
        if (bi < 0 || bd * cellM < START_APART_M) break;
        const S = cells[bi];
        starts.push(S);
        const [a, b] = ij(S);
        for (let x = 0; x < cells.length; x++) { const [i, j] = ij(cells[x]); const dd = Math.hypot(i - a, j - b); if (dd < minD[x]) minD[x] = dd; }
      }
      // From each start a loop each way along its line, where it goes two ways: the second turns at the farthest water
      // whose way out leaves the start more than a right angle from the first's, so the two are fished one after the
      // other from the same place with no troll between them.
      for (const S of starts) {
        const t = shortestFrom(G, cost, S);
        const [si, sj] = ij(S);
        const reach = cells.filter((k) => t.len[k] < Infinity && t.len[k] <= LAP_OUT_M);
        // each cell's ancestor about 200 m out from the start: the way its path leaves
        const anc = new Map();
        for (const k of reach.slice().sort((a, b) => t.len[a] - t.len[b])) {
          const pv = t.prev[k];
          anc.set(k, t.len[k] <= 200 || pv < 0 || !anc.has(pv) ? k : anc.get(pv));
        }
        const bearing = (k) => { const a = anc.get(k); const [i, j] = ij(a); return Math.atan2(j - sj, i - si); };
        let T = -1, bl = 0;
        for (const k of reach) if (t.len[k] > bl) { bl = t.len[k]; T = k; }
        if (T < 0 || bl < LAP_MIN_OUT_M) continue;
        // A way out that leaves its line for long is a run across deep water, not a loop on the line.
        const onLine = (path) => path && path.filter((k) => Math.abs(G.d[k] - L) <= steer).length >= 0.75 * path.length;
        const pathA = pathTo(t.prev, S, T);
        if (onLine(pathA)) out.push({ lineFt: L, S, T, alongM: bl, path: pathA });
        const ba = bearing(T);
        let T2 = -1, b2 = 0;
        for (const k of reach) {
          if (t.len[k] <= b2 || t.len[k] < LAP_MIN_OUT_M) continue;
          let d = Math.abs(bearing(k) - ba); if (d > Math.PI) d = 2 * Math.PI - d;
          if (d > Math.PI / 2) { b2 = t.len[k]; T2 = k; }
        }
        const pathB = T2 >= 0 ? pathTo(t.prev, S, T2) : null;
        if (onLine(pathB)) out.push({ lineFt: L, S, T: T2, alongM: b2, path: pathB });
      }
    }
    return out;
  };
  // In turn from where the run comes in: the nearest start with at least half its water new, then the nearest to that,
  // so the trolls between loops stay short.
  const chooseLoops = (cands, E) => {
    const covered = new Uint8Array(n());
    const rad = Math.ceil(COVER_M / cellM);
    const cover = (path) => {
      for (const c of path) {
        const i = c % G.w, j = (c - i) / G.w;
        for (let dj = -rad; dj <= rad; dj++) for (let di = -rad; di <= rad; di++) {
          if (di * di + dj * dj > rad * rad) continue;
          const i2 = i + di, j2 = j + dj;
          if (i2 >= 0 && j2 >= 0 && i2 < G.w && j2 < G.h) covered[j2 * G.w + i2] = 1;
        }
      }
    };
    const chosen = [];
    const left = cands.slice();
    let at = G.lonLat(E);
    while (chosen.length < MAX_LOOPS && left.length) {
      let best = -1, bd = Infinity;
      left.forEach((c, x) => {
        const fresh = c.path.reduce((a, k) => a + (covered[k] ? 0 : 1), 0);
        if (fresh < 0.5 * c.path.length) return;
        const d = metresBetween(at, G.lonLat(c.S));
        if (d < bd) { bd = d; best = x; }
      });
      if (best < 0) break;
      const c = left.splice(best, 1)[0];
      chosen.push(c);
      cover(c.path);
      at = G.lonLat(c.S);
    }
    return chosen;
  };
  /** One loop from its start round its line to the turn and back the other side (trollLoop()). */
  const loopOf = (c) => {
    const lap = trollLoop({
      ramp: G.lonLat(c.S), daFeatures: o.daFeatures, koFeatures: o.koFeatures, shoreFeatures: coveCrossesShore ? [] : o.shoreFeatures,
      offsetFt: o.offsetFt, lineFt: c.lineFt, lineFrom: 'reports', lineRangeFt: [lo, hi], steerFt: steer,
      windowMin: Math.ceil((3 * c.alongM) / mPerMin) + 10, stopMin: 0,
      via: [G.lonLat(c.T)], contourOnly: true, maxPetals: 1, catches: [], marks: o.marks || [], cellM,
    });
    if (!lap || lap.error || !(lap.legs || []).length) return null;
    const legs = lap.legs.filter((l) => (l.coords || []).length > 1);
    if (!legs.length) return null;
    const m = legs.reduce((a, l) => a + l.lengthM, 0);
    // A loop that had to go a long way round to get back is not the hour's loop it was asked for.
    if (m > 2.6 * c.alongM + 400) return null;
    const start = legs[0].coords[0], end = legs[legs.length - 1].coords[legs[legs.length - 1].coords.length - 1];
    return { lineFt: c.lineFt, legs, m, start, end, minutes: Math.round(minutesFor(m, TROLL_MPH)),
             structure: (lap.score && lap.score.structure) || 0 };
  };
  // ── THE MOVES BETWEEN LOOPS: AT 3 MPH WITH THE TWO DIVERS, OVER WATER THEY CLEAR ─────────────────────────────────
  // Ryan, 11/6: "as long as the app has me travelling at 3mph with double crankbaits in the water then the transit time
  // is still fishing time". And of being told on the water to pull them over a shoal: "adding more things to the fish
  // finder map is not going to help me". So a move is routed over water the area's two divers clear, around a shoal
  // rather than over it; one that cannot avoid shallow water is run with the lines up from its start, and the plan he
  // reads before he launches says which. A move under MIN_MOVE_M is a join (loopSteps()).
  /** The area's two divers: the run's, or where there is no run, the pair that reaches the fish's depth over its water. */
  const movePairFor = (area) => {
    if (area.run && area.run.rods && area.run.rods.length) return { rods: area.run.rods, needFt: area.run.needFt };
    const ok = cranks.filter((c) => c.maxMph == null || c.maxMph >= RUN_MPH);
    const pairs = [];
    for (const cap of [...new Set(ok.map((c) => c.max))]) {
      const pair = ok.filter((c) => c.max <= cap).slice(0, RUN_RODS);
      const needFt = Math.max(...pair.map((r) => r.max)) + steer;
      if (pair.length && needFt <= lo && !pairs.some((q) => q.rods.map((r) => r.name).join() === pair.map((r) => r.name).join())) {
        pairs.push({ rods: pair, needFt });
      }
    }
    const cover = (q) => {
      if (!fishFt) return 0;
      const a = Math.min(...q.rods.map((r) => r.min)), b = Math.max(...q.rods.map((r) => r.max));
      return Math.max(0, Math.min(b, fishFt[1]) - Math.max(a, fishFt[0]));
    };
    pairs.sort((x, y) => cover(y) - cover(x) || y.needFt - x.needFt);
    return pairs[0] || null;
  };
  /** Any open water costs the same: the shortest way by water, for a move with the lines up. */
  let flatCost = null;
  const flat = () => {
    if (!flatCost) {
      flatCost = new Float64Array(n());
      for (let k = 0; k < flatCost.length; k++) { const d = G.d[k]; flatCost[k] = !Number.isFinite(d) || d <= 0 ? Infinity : 1; }
    }
    return flatCost;
  };
  const nearOpen = (cost, pt) => {
    const c = G.cellOf(pt);
    if (c < 0) return -1;
    if (cost[c] < Infinity) return c;
    const i0 = c % G.w, j0 = (c - i0) / G.w;
    let best = -1, bd = Infinity;
    for (let dj = -4; dj <= 4; dj++) for (let di = -4; di <= 4; di++) {
      const i = i0 + di, j = j0 + dj;
      if (i < 0 || j < 0 || i >= G.w || j >= G.h) continue;
      const k = j * G.w + i;
      if (cost[k] < Infinity && Math.hypot(di, dj) < bd) { bd = Math.hypot(di, dj); best = k; }
    }
    return best;
  };
  /** The way a->b on `cost`, straightened: {coords, m, floorFt} (floor: the shallowest water held 80 m on end). */
  const wayOn = (cost, a, b) => {
    // Straight across where every bit of the straight line costs the least there is: no search.
    const st = densify([a, b], cellM / 2);
    if (st.every((p) => { const c = G.cellOf(p); return c >= 0 && cost[c] === 1; })) {
      const pr = profile(G, [a, b]);
      let floor = Infinity;
      for (let k = 0; k < pr.depths.length; k++) {
        const x = pr.depths[k], y = k ? pr.depths[k - 1] : x;
        if (Number.isFinite(x) && Number.isFinite(y)) floor = Math.min(floor, Math.max(x, y));
      }
      return { coords: [a, b], m: Math.round(metresBetween(a, b)), found: true, pr,
               floorFt: Number.isFinite(floor) ? Math.round(floor * 10) / 10 : null };
    }
    const sa = nearOpen(cost, a), sb = nearOpen(cost, b);
    let path = null;
    if (sa >= 0 && sb >= 0) path = sa === sb ? [sa] : pathTo(shortestFrom(G, cost, sa, { dst: sb }).prev, sa, sb);
    const coords = path && path.length > 1 ? straighten(G, cost, path).map(G.lonLat) : [a, b];
    coords[0] = a; coords[coords.length - 1] = b;
    const pr = profile(G, coords);
    let floor = Infinity;
    for (let k = 0; k < pr.depths.length; k++) {
      const x = pr.depths[k], y = k ? pr.depths[k - 1] : x;
      if (Number.isFinite(x) && Number.isFinite(y)) floor = Math.min(floor, Math.max(x, y));
    }
    return { coords, m: Math.round(pr.cum[pr.cum.length - 1] || metresBetween(a, b)), found: !!path, pr,
             floorFt: Number.isFinite(floor) ? Math.round(floor * 10) / 10 : null };
  };
  /**
   * move(fromPoint, toPoint) for one area: {kind: 'join'|'divers'|'up', coords, m, minutes, floorFt}. A join is under
   * MIN_MOVE_M by water. A move with the divers keeps to water at least their need (rating + steer) from where the lines
   * go in to where they come up (diversStretch()), no more than MOVE_DETOUR times the shortest way; its `coords` are that
   * stretch, and `inM`/`outM` say where on the move it starts and ends. Any other is lines up, the shortest way.
   */
  const moverFor = (area) => {
    const need = area.pair ? area.pair.needFt : Infinity;
    let cost = null;
    const diverCost = () => {
      if (!cost) {
        cost = new Float64Array(n());
        for (let k = 0; k < cost.length; k++) {
          const d = G.d[k];
          cost[k] = !Number.isFinite(d) || d <= 0 ? Infinity : d >= need ? 1 : 1 + 6 * ((need - d) / steer);
        }
      }
      return cost;
    };
    const memo = new Map();
    return (a, b) => {
      const key = `${a[0].toFixed(6)},${a[1].toFixed(6)}>${b[0].toFixed(6)},${b[1].toFixed(6)}`;
      if (memo.has(key)) return memo.get(key);
      const crow = metresBetween(a, b);
      let out;
      if (crow < MIN_MOVE_M / 1.3) out = { kind: 'join', m: Math.round(crow * 1.15), minutes: minutesFor(crow * 1.15, TROLL_MPH) };
      else {
        const short = wayOn(flat(), a, b);
        if (short.m < MIN_MOVE_M) out = { kind: 'join', m: short.m, minutes: minutesFor(short.m, TROLL_MPH) };
        else {
          const dv = area.pair ? wayOn(diverCost(), a, b) : null;
          const st = dv && dv.found && dv.m <= MOVE_DETOUR * short.m ? diversStretch(dv.pr.depths, dv.pr.cum, need) : null;
          if (st && st.trolledM) {
            const mid = splitAt(splitAt(dv.coords, st.inM)[1], st.outM - st.inM)[0];
            const upM = Math.max(0, dv.m - st.trolledM);
            const trolledMin = minutesFor(st.trolledM, RUN_MPH), upMin = minutesFor(upM, TRANSIT_MPH);
            out = { kind: 'divers', coords: mid, m: dv.m, trolledM: st.trolledM, upM, inM: st.inM, outM: st.outM,
                    minutes: trolledMin + upMin, trolledMin, upMin, floorFt: st.floorFt, rods: area.pair.rods, needFt: need };
          } else {
            out = { kind: 'up', coords: short.coords, m: short.m, minutes: minutesFor(short.m, TRANSIT_MPH), floorFt: short.floorFt,
                    shallowFt: dv ? dv.floorFt : short.floorFt };
          }
        }
      }
      memo.set(key, out);
      return out;
    };
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
    area.laps = chooseLoops(loopCandidates(area, E), E).map(loopOf).filter(Boolean);
    if (!area.laps.length) { left.push({ ...area, left: `no loop on the ${lineSet.join(', ')} ft lines fits inside it` }); return; }
    area.pair = movePairFor(area);
    area.move = moverFor(area);
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
  /**
   * Whole loops of an area in `min`: each in turn, then back the way they came (the last one again first), so the move
   * from one to the next stays short; with the moves between them and back to where the run comes in (area.move). A
   * loop that does not fit is passed for the nearest that does.
   * {laps, moves (the move before each loop, then the move home), usedMin, leftMin, distinct, hopMin, diversMin, upMin}.
   */
  const lapsIn = (area, min) => {
    const loops = area.laps, nL = loops.length, E = area.entry;
    const seq = [], moves = [];
    let t = 0, at = -1;
    const from = (a) => (a < 0 ? E : loops[a].end);
    const hop = (a, j) => area.move(from(a), loops[j].start);
    const home = (j) => area.move(loops[j].end, E);
    const fits = (j) => t + hop(at, j).minutes + loops[j].minutes + home(j).minutes <= min;
    // 0, 1, ... n-1, n-1, ... 0, 0, 1, ...
    const turnOrder = nL === 1 ? [0] : [...Array(nL).keys(), ...[...Array(nL).keys()].reverse()];
    for (let k = 0; k < 400; k++) {
      let j = turnOrder[k % turnOrder.length];
      if (!fits(j)) {
        const ok = [...Array(nL).keys()].filter(fits);
        if (!ok.length) break;
        j = ok.sort((x, y) => hop(at, x).minutes - hop(at, y).minutes)[0];
      }
      const mv = hop(at, j);
      t += mv.minutes + loops[j].minutes;
      moves.push(mv); seq.push(loops[j]);
      at = j;
    }
    if (seq.length) { const mv = home(at); t += mv.minutes; moves.push(mv); }
    const sum = (f) => Math.round(moves.reduce((a, x) => a + (f(x) || 0), 0));
    return { laps: seq, moves, usedMin: Math.round(t), leftMin: Math.round(min - t), distinct: new Set(seq).size,
             hopMin: sum((x) => x.minutes), diversMin: sum((x) => x.kind === 'divers' && x.trolledMin),
             upMin: sum((x) => (x.kind === 'up' ? x.minutes : x.kind === 'divers' ? x.upMin : 0)),
             joinMin: sum((x) => x.kind === 'join' && x.minutes) };
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
        steps.push({ kind: 'area', at: clock(t), min: L.usedMin, area: p.area.key, laps: L.laps.length, distinct: L.distinct,
                     hopMin: L.hopMin, diversMin: L.diversMin, upMin: L.upMin, rods: p.area.pair ? p.area.pair.rods : [],
                     leftMin: L.leftMin, lapList: L.laps, moveList: L.moves });
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
    areas: areas.map(({ E, move, ...a }) => a), left, options, lineFt: lineA, lines: [...new Set(areas.flatMap((a) => a.laps.map((l) => l.lineFt)))].sort((a, b) => a - b),
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
  let pendingUp = false;
  const runLeg = (r, name, reversed, to) => {
    if (!r || !r.trolledM || !r.trolledCoords) return;
    const c = reversed ? r.trolledCoords.slice().reverse() : r.trolledCoords.slice();
    legs.push({ coords: c, lengthM: Math.round(lineM(c)), petal: -1, half: 'run', name,
                run: { mph: RUN_MPH, rods: r.rods.map((x) => x.name), floorFt: r.floorFt, needFt: r.needFt, to: to || null },
                ...(pendingUp ? { upBefore: true } : {}) });
    pendingUp = false;
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
    // A MOVE AT 3 MPH WITH THE DIVERS IS A RUN LEG OF ITS OWN; one with the lines up leaves a gap the next piece marks.
    let upNext = false, mv = 0;
    const after = op.parts[op.parts.indexOf(p) + 1];
    const moveLeg = (m, last) => {
      if (!m || m.kind === 'join') return;
      if (m.kind === 'up') { upNext = true; return; }
      mv++;
      const to = !last ? 'the next loop' : after && after.between ? 'the run across' : p.area.near ? 'the way in to the ramp' : 'the run home';
      // Shallow water before the lines go in, after a run with the same divers out: lines up across it, not trolled on.
      const prev = legs[legs.length - 1];
      const upFirst = (m.inM || 0) > 20 && prev && prev.half === 'run';
      legs.push({ coords: m.coords, lengthM: m.trolledM || m.m, petal: -1, half: 'run', name: `area${areaNo}-move${mv}`, area: p.area.key,
                  run: { mph: RUN_MPH, rods: m.rods.map((x) => x.name), floorFt: m.floorFt, needFt: m.needFt, to, move: true },
                  ...(upFirst ? { upBefore: true } : {}) });
      // And where they come up short of the next loop, the rest is lines up.
      if (m.m - (m.outM != null ? m.outM : m.m) > 20) upNext = true;
    };
    const laps = (step && step.lapList) || [], moves = (step && step.moveList) || [];
    laps.forEach((L, x) => {
      moveLeg(moves[x], false);
      lap++;
      L.legs.forEach((l, y) => {
        legs.push({ coords: l.coords, lengthM: l.lengthM, petal: lap - 1, half: l.half, lineFt: L.lineFt, edgeFt: l.edgeFt,
                    deepestNearbyFt: l.deepestNearbyFt, name: `area${areaNo}-lap${lap}-${l.half}`, area: p.area.key,
                    ...(y === 0 && upNext ? { upBefore: true } : {}) });
      });
      upNext = false;
    });
    moveLeg(moves[laps.length], true);
    if (upNext) pendingUp = true;
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
      return `${at}${a.name}: ${s.laps} loop${s.laps === 1 ? '' : 's'}`
        + `${s.distinct && s.distinct < s.laps ? ` (${s.distinct} different, then round again)` : s.laps > 1 ? ', each a different one' : ''}, `
        + `${hm(s.min - (s.diversMin || 0) - (s.upMin || 0))} on them`
        + `${s.diversMin >= 5 ? `, ${hm(s.diversMin)} moving between them at ${RUN_MPH} mph with ${(s.rods || []).map((r) => r.name).join(' and ')}` : ''}`
        + `${s.upMin >= 3 ? `, ${hm(s.upMin)} moving with the lines up where the water between is too shallow for them` : ''}`
        + (s.leftMin >= 5 ? `; ${hm(s.leftMin)} more is yours (less than a loop)` : '');
    }
    return `${at}at the ramp`;
  });
}
