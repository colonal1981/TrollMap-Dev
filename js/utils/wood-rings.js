/**
 * The snags on a plan's legs as Garmin boundaries: his 10 ft around each, and the rings that touch
 * made one outline. Optional at Save ADM, and off unless he ticks it.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-11-03: *"i just don't want to clutter up the screen with waypoints so i am looking for
 * alternatives"*. A boundary per stump would be the clutter again, so the rings are joined: a stump
 * field is ONE boundary, the outline of the union of its rings, not a pin per stump.
 *
 *   - every piece that is a snag to any rod on any leg of this plan (leg.wood, plan-wood.js), once
 *   - a ring of his 10 ft about each (HIS_PASS_FT, wood.js) -- the band his lures pass over, so a
 *     track that stays outside the outline keeps his lures off the wood
 *   - rings that overlap become one outline; a ring that touches no other stays a ring
 *   - named "TM wood <leg>", the leg that meets it first, cut to what the unit shows
 *   - ALARM OFF: he switches it on at the unit if he wants it. Its warning distance is 0, because
 *     the ring is already his distance; a cue line's 152.4 m would sound 500 ft from a stump.
 *
 * THE POINTS IN A RING ARE DERIVED, NOT CHOSEN. A ring is drawn as points ON the circle, so between
 * two points the line cuts inside it by r(1 - cos(pi/N)). N is the fewest points that keep that
 * inside a tenth of a foot -- the precision every depth in the wood file is written to -- on his
 * 10 ft: N = ceil(pi / acos(1 - 0.1/10)) = 23. A part of an outline gets the same spacing.
 */
import { geoDistanceM } from './geo.js';
import { HIS_PASS_FT, HIS_PASS_M } from './wood.js';
import { ADM_NAME_CHARS, BOUNDARY_DEFAULT_COLOR } from './adm.js';

const TENTH_FT = 0.1;
export const RING_POINTS = Math.ceil(Math.PI / Math.acos(1 - TENTH_FT / HIS_PASS_FT));
const TAU = 2 * Math.PI;

/** Every snag on the plan, once, with the first leg that meets it. In the order the day meets them. */
export function snagsOf(plan) {
  const out = new Map();
  for (const leg of ((plan && plan.legs) || [])) {
    for (const e of (leg.wood || [])) {
      if (!e || out.has(e.id) || !Array.isArray(e.at)) continue;
      if (!(e.rods || []).some((r) => r.verdict === 'snag')) continue;
      out.set(e.id, { id: e.id, at: e.at, legId: leg.id });
    }
  }
  return [...out.values()];
}

/** Groups of indices whose rings overlap, directly or through others. `d(i, j)` in metres. */
function clusters(n, d, r) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) if (d(i, j) < 2 * r) parent[find(i)] = find(j);
  }
  const by = new Map();
  for (let i = 0; i < n; i++) {
    const k = find(i);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(i);
  }
  return [...by.values()];
}

/**
 * THE OUTLINE OF THE UNION OF EQUAL CIRCLES, as points in the plane, anticlockwise.
 *
 * Exact in its arcs: each circle keeps the part of its edge no other circle covers, those arcs are
 * chained end to start into loops, and each arc is drawn at the ring's spacing. A cluster can leave a
 * hole in its middle (stumps round an open patch); the hole is a loop going the other way and is
 * left out, so the boundary is the outside of the field.
 *
 * @param {number[][]} c   circle centres, [x, y] in metres
 * @param {number} r       radius, metres
 * @param {number} n       points in a whole ring
 */
export function unionOutline(c, r, n = RING_POINTS) {
  const eps = r * 1e-9;
  const arcs = [];
  for (let i = 0; i < c.length; i++) {
    const cover = [];
    let dup = false;
    for (let j = 0; j < c.length; j++) {
      if (j === i) continue;
      const dx = c[j][0] - c[i][0], dy = c[j][1] - c[i][1];
      const d = Math.hypot(dx, dy);
      if (d <= eps) { if (j < i) dup = true; continue; }
      if (d >= 2 * r) continue;
      const th = Math.atan2(dy, dx), a = Math.acos(d / (2 * r));
      let s = (th - a) % TAU; if (s < 0) s += TAU;
      const e = s + 2 * a;
      if (e > TAU) { cover.push([s, TAU], [0, e - TAU]); } else cover.push([s, e]);
    }
    if (dup) continue;
    cover.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const iv of cover) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }
    if (!merged.length) { arcs.push({ i, s: 0, e: TAU, whole: true }); continue; }
    const free = [];
    let at = 0;
    for (const [s, e] of merged) { if (s > at) free.push([at, s]); at = Math.max(at, e); }
    if (at < TAU) free.push([at, TAU]);
    // An arc running through angle 0 is one arc, not two.
    if (free.length > 1 && free[0][0] === 0 && free[free.length - 1][1] === TAU) {
      const last = free.pop();
      free[0] = [last[0], free[0][1] + TAU];
    }
    for (const [s, e] of free) if (e - s > 1e-12) arcs.push({ i, s, e });
  }
  const pt = (i, t) => [c[i][0] + r * Math.cos(t), c[i][1] + r * Math.sin(t)];
  const step = TAU / n;
  const draw = (a, out) => {
    const m = Math.max(1, Math.ceil((a.e - a.s) / step - 1e-9));
    for (let k = 0; k < m; k++) out.push(pt(a.i, a.s + ((a.e - a.s) * k) / m));
  };
  const loops = [];
  const used = new Set();
  for (let a0 = 0; a0 < arcs.length; a0++) {
    if (used.has(a0)) continue;
    const loop = [];
    let k = a0;
    while (k != null && !used.has(k)) {
      used.add(k);
      const a = arcs[k];
      draw(a, loop);
      if (a.whole) break;
      const [ex, ey] = pt(a.i, a.e);
      let next = null, best = Infinity;
      for (let q = 0; q < arcs.length; q++) {
        if (arcs[q].whole || (used.has(q) && q !== a0)) continue;
        const [sx, sy] = pt(arcs[q].i, arcs[q].s);
        const dd = Math.hypot(sx - ex, sy - ey);
        if (dd < best) { best = dd; next = q; }
      }
      k = next;
    }
    loops.push(loop);
  }
  const area = (p) => p.reduce((s, q, i) => {
    const w = p[(i + 1) % p.length];
    return s + q[0] * w[1] - w[0] * q[1];
  }, 0) / 2;
  let outer = null;
  for (const l of loops) if (l.length >= 3 && (!outer || area(l) > area(outer))) outer = l;
  return outer || [];
}

/**
 * The plan's snags as boundaries for admFile(): [{ name, pts: [[lat, lon]], warnM, alarm, color }].
 * [] when the plan has no snag.
 */
export function woodBoundaries(plan, { r = HIS_PASS_M, n = RING_POINTS } = {}) {
  const snags = snagsOf(plan);
  if (!snags.length) return [];
  const lat0 = snags.reduce((s, p) => s + p.at[1], 0) / snags.length;
  const lon0 = snags.reduce((s, p) => s + p.at[0], 0) / snags.length;
  const kx = geoDistanceM(lat0, lon0, lat0, lon0 + 1e-3) / 1e-3;
  const ky = geoDistanceM(lat0, lon0, lat0 + 1e-3, lon0) / 1e-3;
  const xy = snags.map((p) => [(p.at[0] - lon0) * kx, (p.at[1] - lat0) * ky]);
  const groups = clusters(snags.length, (i, j) => Math.hypot(xy[i][0] - xy[j][0], xy[i][1] - xy[j][1]), r)
    // In the order the day meets them: by the first snag of each group.
    .sort((a, b) => Math.min(...a) - Math.min(...b));
  const perLeg = new Map();
  const out = [];
  for (const g of groups) {
    const legId = snags[Math.min(...g)].legId;
    const k = (perLeg.get(legId) || 0) + 1;
    perLeg.set(legId, k);
    const ring = unionOutline(g.map((i) => xy[i]), r, n);
    if (ring.length < 3) continue;
    out.push({
      name: `TM wood ${legId}${k > 1 ? `.${k}` : ''}`.slice(0, ADM_NAME_CHARS),
      pts: ring.map(([x, y]) => [lat0 + y / ky, lon0 + x / kx]),
      warnM: 0,
      alarm: false,
      color: BOUNDARY_DEFAULT_COLOR,
    });
  }
  return out;
}
