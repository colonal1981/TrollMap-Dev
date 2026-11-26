/**
 * autopilot-route.js -- the day cut into what the steering box follows one piece at a time, and the
 * commands that put one piece in the box.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * THE BOX FOLLOWS ONE ROUTE AT A TIME (route.h in the firmware): a list of up to 300 points, either a
 * LOOP, which it goes round again when it closes and says "LAP", or a RUN, one way, which it ends
 * with "END" and then holds the last line's heading. Ryan, 2026-11-26, on how a day goes: "route
 * typically has been one lazy loop then there should be a way to choose to head to the next one
 * maybe... end of the route, popup on phone asking if i am ready to head to the next leg maybe?
 * select ok and it routes me there over water not over land lol". So the day is cut into pieces:
 * every loop of the plan is one piece, and everything between two loops (the way out of the cove,
 * a move between areas, the way home) is one run. The plan already lays those runs over water.
 *
 * WHICH LEGS ARE ONE LOOP is what the plan says: a loop's legs carry `runId` "...#loopN-out" and
 * "...#loopN-back" (plan-troll-loop.js, plan-areas.js), read by loopOf(), the same test the map's
 * loop colours use. Nothing here guesses a loop from the shape of a line.
 *
 * THE POINTS ARE THINNED, NOT RESAMPLED. A leg's line has a point every few metres and the box holds
 * 300 (route::MAX_POINTS). Douglas-Peucker drops the points that lie on a straight stretch and keeps
 * every bend, starting at 2 m off the line -- under the GPS's own error -- and loosening only until
 * the piece fits. The box steers at a spot 20 m ahead on the line (LOOKAHEAD_M), so 2 m is nothing it
 * can feel.
 */
import { loopOf } from '../modules/plan-to-timeline.js';

/** route::MAX_POINTS in the firmware's route.h. A route with more is refused point by point ("WP full"). */
export const MAX_POINTS = 300;

const M_PER_DEG = 6371000 * Math.PI / 180;

/** Metres between two [lon, lat] points (flat earth; a piece is a few kilometres). */
export function metres(a, b) {
  const k = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * M_PER_DEG * k, (b[1] - a[1]) * M_PER_DEG);
}

function rdp(xy, tol) {
  const n = xy.length;
  if (n < 3) return xy.map((_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = xy[a];
    const [bx, by] = xy[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let best = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i];
      const d = len < 1e-9 ? Math.hypot(px - ax, py - ay) : Math.abs(dy * (px - ax) - dx * (py - ay)) / len;
      if (d > best) { best = d; at = i; }
    }
    if (at > 0 && best > tol) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * A piece's line as the box should get it: repeated points gone, a loop's closing point gone (the box
 * closes a loop itself), and thinned to fit. `coords` is [[lon, lat], ...].
 */
export function thin(coords, { loop = false, max = MAX_POINTS } = {}) {
  const pts = [];
  for (const c of coords || []) {
    if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    if (pts.length && metres(pts[pts.length - 1], c) < 1) continue;
    pts.push([c[0], c[1]]);
  }
  if (loop) while (pts.length > 2 && metres(pts[0], pts[pts.length - 1]) < 5) pts.pop();
  if (pts.length <= 2) return pts;
  const lat0 = pts[0][1];
  const k = Math.cos(lat0 * Math.PI / 180);
  const xy = pts.map(([lon, lat]) => [(lon - pts[0][0]) * M_PER_DEG * k, (lat - lat0) * M_PER_DEG]);
  let tol = 2;
  let idx = rdp(xy, tol);
  while (idx.length > max && tol < 500) {
    tol *= 1.5;
    idx = rdp(xy, tol);
  }
  return idx.map((i) => pts[i]);
}

function lineM(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += metres(coords[i - 1], coords[i]);
  return m;
}

/**
 * The plan's day as the pieces the box follows, in the order the boat meets them.
 *
 * @param {object} plan   window._planV2: `legs[]` each with `coordinates` [[lon, lat]...], `type`, `role`, `runId`
 * @returns {{kind:'loop'|'run', name:string, loopN:number|null, coords:number[][], lengthM:number, legIds:string[]}[]}
 */
export function dayPieces(plan) {
  const out = [];
  for (const leg of (plan && plan.legs) || []) {
    const co = (leg && leg.coordinates) || [];
    if (co.length < 2) continue;
    const lp = loopOf(leg);
    const loop = !!(lp && lp.n >= 1);
    const key = loop ? `loop${lp.n}` : 'run';
    const last = out[out.length - 1];
    if (last && last.key === key) {
      const tail = last.coords[last.coords.length - 1];
      last.coords.push(...(metres(tail, co[0]) < 1 ? co.slice(1) : co));
      last.legIds.push(leg.id);
      if (leg.role === 'return') last.home = true;
    } else {
      out.push({ key, kind: loop ? 'loop' : 'run', loopN: loop ? lp.n : null, coords: co.slice(),
                 legIds: [leg.id], home: leg.role === 'return' });
    }
  }
  // A JOIN INSIDE ONE LOOP IS THE LOOP. When a loop's out and back do not touch, the plan joins them
  // with a leg of its own that carries no runId; that is still loop N, not a run to loop N.
  for (let i = 1; i + 1 < out.length;) {
    const [a, b, c] = [out[i - 1], out[i], out[i + 1]];
    if (a.kind === 'loop' && b.kind === 'run' && c.kind === 'loop' && a.loopN === c.loopN) {
      for (const q of [b, c]) {
        const tail = a.coords[a.coords.length - 1];
        a.coords.push(...(metres(tail, q.coords[0]) < 1 ? q.coords.slice(1) : q.coords));
        a.legIds.push(...q.legIds);
      }
      out.splice(i, 2);
    } else i += 1;
  }
  out.forEach((p, i) => {
    p.lengthM = Math.round(lineM(p.coords));
    if (p.kind === 'loop') p.name = `Loop ${p.loopN}`;
    else if (p.home || i === out.length - 1) p.name = 'The way home';
    else {
      const next = out.slice(i + 1).find((q) => q.kind === 'loop');
      p.name = next ? `Run to loop ${next.loopN}` : 'Run';
    }
    delete p.key;
    delete p.home;
  });
  return out;
}

/** "33.918290,-80.380160" -- 6 places, under a metre. The box reads up to 31 characters between W and ;. */
const ll = ([lon, lat]) => `${lat.toFixed(6)},${lon.toFixed(6)}`;

/**
 * What puts a route in the box: clear it (Q), one W<lat>,<lon>; per point, J if it is a loop, and V,
 * which makes the box say what it now holds. Following it (G) is sent separately, after the box has
 * said it took every point.
 */
export function routeCommands(points, { loop = false } = {}) {
  return ['Q', ...points.map((p) => `W${ll(p)};`), ...(loop ? ['J'] : []), 'V'];
}
