// The duplicate lanes collapse faster, and into the same groups.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Item 24, 2026-10-01. Pick Water's built-in 10-25 ft band on Murray: buildPieces() took 7.7 s, and
// 7 s of it was collapse() measuring every sampled point of one stretch against every point of the
// other. It now buckets the points by the swath, stops at the first point inside it, and stops
// counting once 60% is passed or out of reach. Measured on the real packs the same day, pieces
// and joins JSON-identical: Murray 1,016 pieces in 0.8-1.0 s, Wateree 374 in 0.17 s.
//
// This holds the same thing on a made-up lake where many lanes sit within a swath of each other,
// some just inside it and some just outside: the groups buildPieces() makes are exactly the ones
// the old all-against-all measure makes.

import { describe, it } from './expect-shim.mjs';
import assert from 'node:assert/strict';
import { buildPieces, reachCurve, deepestUsable, stretchCoords } from '../js/modules/plan-pieces.js';

// The old collapse(), verbatim but for its name: every sampled point against every point.
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function oldCollapse(entries, swathM) {
  const cell = Math.max(30, swathM);
  const grid = new Map();
  const key = (p) => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
  entries.forEach((e, n) => {
    for (let i = 0; i < e.xy.length; i += 2) {
      const k = key(e.xy[i]);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(n);
    }
  });
  const parent = entries.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  const frac = (A, B) => {
    let hit = 0, n = 0;
    for (let i = 0; i < A.length; i += 2) {
      n++;
      let d = Infinity;
      for (const q of B) { const t = dist2(A[i], q); if (t < d) d = t; }
      if (d <= swathM) hit++;
    }
    return n ? hit / n : 0;
  };
  entries.forEach((e, n) => {
    const cand = new Set();
    for (let i = 0; i < e.xy.length; i += 2) {
      const [gx, gy] = key(e.xy[i]).split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const m of grid.get(`${gx + dx},${gy + dy}`) || []) cand.add(m);
      }
    }
    for (const m of cand) {
      if (m <= n) continue;
      if (frac(e.xy, entries[m].xy) > 0.6 || frac(entries[m].xy, e.xy) > 0.6) union(n, m);
    }
  });
  const groups = new Map();
  entries.forEach((_, n) => {
    const r = find(n);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(n);
  });
  return [...groups.values()];
}

// A lake of nested lanes: a few bundles of near-parallel lines, offset 0-400 m from each other so
// pairs land on both sides of the 50 m swath, at 40 m stations, all in 30 ft of water.
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const LAT = 34.1, LON = -81.3;
const kx = 111320 * Math.cos(LAT * Math.PI / 180), ky = 110540;
const lanes = [];
for (let b = 0; b < 6; b++) {
  const ox = rnd() * 3000, oy = rnd() * 3000, th = rnd() * Math.PI;
  for (let k = 0; k < 14; k++) {
    const off = rnd() * 400, along = rnd() * 300, n = 10 + Math.floor(rnd() * 20);
    const wob = (rnd() - 0.5) * 0.15;
    const coords = [];
    for (let s = 0; s < n; s++) {
      const u = along + s * 40, v = off + s * 40 * wob;
      const x = ox + u * Math.cos(th) - v * Math.sin(th), y = oy + u * Math.sin(th) + v * Math.cos(th);
      coords.push([LON + x / kx, LAT + y / ky]);
    }
    lanes.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
      properties: { id: `fake#${lanes.length}`, fitted: true, envelope_step_m: 40, envelope_m: 25,
                    envelope_ft: Array(n).fill(30), envelope_line_ft: Array(n).fill(32),
                    envelope_deep_ft: Array(n).fill(34) } });
  }
}

describe('collapse() makes the groups the all-against-all measure makes', () => {
  it('on a lake where lanes sit either side of the swath', () => {
    const minM = 300, depths = [6, 10, 14, 18, 22, 26], swath = 50;
    const got = buildPieces(lanes, { clearFt: 0, minM, depths });
    // The entries buildPieces() collapses, rebuilt the way it builds them.
    let latSum = 0;
    for (const f of lanes) { const c = f.geometry.coordinates; latSum += c[0][1] + c[c.length - 1][1]; }
    const lat0 = latSum / (2 * lanes.length);
    const px = 111320 * Math.cos(lat0 * Math.PI / 180);
    const entries = [];
    for (const f of lanes) {
      const p = f.properties;
      const best = deepestUsable(reachCurve(p.envelope_ft, 40, depths, 0), minM);
      if (!best) continue;
      const coords = stretchCoords(f.geometry.coordinates, 40, best.from, best.to);
      entries.push({ runId: p.id, lengthM: best.lengthM, holdsFt: best.depthFt,
                     xy: coords.map((c) => [c[0] * px, c[1] * 110540.0]) });
    }
    const want = oldCollapse(entries, swath).map((g) => {
      const w = g.map((i) => entries[i]).reduce((a, b) => (b.holdsFt > a.holdsFt
        || (b.holdsFt === a.holdsFt && b.lengthM > a.lengthM) ? b : a));
      return `${w.runId}:${g.length}`;
    }).sort();
    assert.ok(want.length > 6 && want.length < entries.length,
      `the made-up lake has groups to make: ${want.length} of ${entries.length}`);
    assert.deepEqual(got.pieces.map((p) => `${p.runId}:${p.duplicates}`).sort(), want);
  });
});
