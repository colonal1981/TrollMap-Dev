// Personal use only, not for distribution or resale; not for navigation.
//
// PICK WATER HUNG THE BROWSER ON MURRAY (2026-09-26), inside inRing() under depthSampler(). The
// fix reads fewer edges and sorts each grid cell once; it must not move a single depth. These hold
// the new lookups to the old ones point for point: indexRing()/inIndexedRing() against inRing(),
// and depthSampler() against the plain scan it replaced, on rings with thousands of vertices,
// holes, nested bands, vertices, edge midpoints and points on the grid's own cell lines.
import { describe, it, expect } from './expect-shim.mjs';
import { inRing, indexRing, inIndexedRing, ringNearBox } from '../js/utils/geojson-coords.js';
import { depthSampler } from '../js/modules/plan-water-index.js';

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

// A wobbly closed ring around (cx, cy): `n` vertices, radius r with noise, first point repeated.
function blob(cx, cy, r, n, wobble = 0.35) {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    const rr = r * (1 - wobble / 2 + wobble * rnd());
    ring.push([cx + rr * Math.cos(t), cy + rr * Math.sin(t) * 0.8]);
  }
  ring.push(ring[0].slice());
  return ring;
}

// Points worth asking about: random ones around the ring, every vertex, every edge midpoint.
function probes(rings, box, k) {
  const pts = [];
  for (let i = 0; i < k; i++) pts.push([box[0] + (box[2] - box[0]) * rnd(), box[1] + (box[3] - box[1]) * rnd()]);
  for (const r of rings) for (let i = 0; i < r.length - 1; i++) {
    pts.push(r[i].slice());
    pts.push([(r[i][0] + r[i + 1][0]) / 2, (r[i][1] + r[i + 1][1]) / 2]);
  }
  return pts;
}

// The sampler as it was before 2026-09-26: every candidate's rings through inRing().
function oldSampler(features, cellDeg = 0.002) {
  const polys = features.map((f) => ({ rings: f.geometry.coordinates, maxFt: f.properties.depth_max_ft }));
  return (pt) => {
    let best = null;
    for (const q of polys) {
      if (!inRing(pt[0], pt[1], q.rings[0])) continue;
      if (q.rings.slice(1).some((h) => inRing(pt[0], pt[1], h))) continue;
      if (best == null || q.maxFt < best) best = q.maxFt;
    }
    return best;
  };
}

describe('the indexed ray cast is inRing(), edge for edge', () => {
  it('agrees at every probe on rings from 3 to 4,000 vertices', () => {
    for (const n of [3, 4, 9, 60, 700, 4000]) {
      const ring = blob(-81.3, 34.09, 0.01, n);
      const idx = indexRing(ring);
      for (const p of probes([ring], [-81.32, 34.07, -81.28, 34.11], 1500)) {
        expect(inIndexedRing(p[0], p[1], idx)).toBe(inRing(p[0], p[1], ring));
      }
    }
  });

  it('agrees on a ring that is not closed and on one that is flat', () => {
    const open = blob(-80.7, 34.37, 0.004, 50).slice(0, -1);
    const flat = [[-80.7, 34.37], [-80.69, 34.37], [-80.68, 34.37]];
    for (const ring of [open, flat]) {
      const idx = indexRing(ring);
      for (const p of probes([ring], [-80.71, 34.36, -80.67, 34.38], 500)) {
        expect(inIndexedRing(p[0], p[1], idx)).toBe(inRing(p[0], p[1], ring));
      }
    }
  });

  it('a box no edge comes near is all inside or all out', () => {
    const ring = blob(-81.3, 34.09, 0.01, 800);
    const idx = indexRing(ring);
    let checked = 0;
    for (let b = 0; b < 400; b++) {
      const w = -81.315 + 0.03 * rnd(), s = 34.075 + 0.03 * rnd(), e = w + 0.002, n = s + 0.002;
      if (ringNearBox(idx, w, s, e, n)) continue;
      checked++;
      const first = inRing(w + 0.001, s + 0.001, ring);
      for (let k = 0; k < 25; k++) {
        expect(inRing(w + 0.002 * rnd(), s + 0.002 * rnd(), ring)).toBe(first);
      }
      // The corners too -- the grid's own cell lines are where a lookup lands on a box edge.
      for (const c of [[w, s], [e, s], [w, n], [e, n]]) expect(inRing(c[0], c[1], ring)).toBe(first);
    }
    expect(checked > 50).toBe(true);
  });
});

describe('depthSampler() gives the depth the old scan gave, everywhere', () => {
  // Nested bands with holes, the shape Wateree ships, and a set of thin bands side by side, the
  // shape Murray ships -- 1 ft bands that do not nest.
  const feats = [];
  const band = (rings, ft) => feats.push({ type: 'Feature', properties: { depth_max_ft: ft },
                                           geometry: { type: 'Polygon', coordinates: rings } });
  band([blob(-81.30, 34.09, 0.020, 3000), blob(-81.305, 34.092, 0.003, 200), blob(-81.29, 34.085, 0.002, 150)], 5);
  band([blob(-81.30, 34.09, 0.014, 2000)], 20);
  band([blob(-81.30, 34.09, 0.008, 900), blob(-81.297, 34.088, 0.0015, 80)], 40);
  band([blob(-81.30, 34.09, 0.003, 300)], 60);
  for (let i = 0; i < 40; i++) band([blob(-81.33 + 0.0015 * i, 34.07, 0.0009, 24)], 10 + (i % 7));
  const old = oldSampler(feats);
  const at = depthSampler(feats);
  const rings = feats.flatMap((f) => f.geometry.coordinates);

  it('agrees at random points, every vertex and every edge midpoint', () => {
    let n = 0;
    for (const p of probes(rings, [-81.34, 34.06, -81.27, 34.12], 4000)) { expect(at(p)).toBe(old(p)); n++; }
    expect(n > 10000).toBe(true);
  });

  it('agrees on the grid cell lines, where a lookup lands on the edge of a cell', () => {
    const cell = 0.002;
    for (let i = 0; i < 2000; i++) {
      const x = Math.round((-81.34 + 0.07 * rnd()) / cell) * cell;
      const y = Math.round((34.06 + 0.06 * rnd()) / cell) * cell;
      for (const p of [[x, 34.06 + 0.06 * rnd()], [-81.34 + 0.07 * rnd(), y], [x, y]]) expect(at(p)).toBe(old(p));
    }
  });

  it('asks the same point twice and gets the same answer (the cell cache)', () => {
    for (let i = 0; i < 500; i++) {
      const p = [-81.34 + 0.07 * rnd(), 34.06 + 0.06 * rnd()];
      const a = at(p);
      expect(at(p)).toBe(a);
      expect(a).toBe(old(p));
    }
  });
});
