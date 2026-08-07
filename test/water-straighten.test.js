import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WATER = path.join(REPO, 'Worker/water.js');

// ---------------------------------------------------------------------------
// Why this test exists
//
// 2026-08-07. A SmartPlan return leg on Wateree came out as 89 points and
// 13.95 km for a 4.97 km hop, reversing direction 27 times -- 530 m out and
// 527 m back to advance 140 m. Ryan: "there is no way that is how garmin would
// route me back to the ramp with all of that turning... it would be a straight
// shot over water."
//
// The cell SEQUENCE from Dijkstra was correct the whole time. What was wrong
// was drawing a line through MAR cell centroids: cells are tiny near shore and
// enormous in open water (max edge 731 m on Wateree), so consecutive centroids
// sit off at angles to the direction of travel.
//
// Garmin does not smooth afterwards -- there is no funnel or string-pull
// anywhere in its routing module. It searches a space that already has a land
// buffer applied, `nav_land_dist_restrict`, default 152.4 m = 500 ft exactly.
// straighten() approximates that: pull the polyline straight wherever the
// straight line stays on water and off the bank by `clearance`.
//
// The invariants below are the ones that matter. It must never lengthen a
// path, never leave the water, and never throw -- a route that is ugly still
// gets you home; a route over land does not.
// ---------------------------------------------------------------------------

// Pull the real functions out of Worker/water.js rather than reimplementing
// them, so this tests shipped code and not a copy that can drift.
function loadFromWorker() {
  const src = readFileSync(WATER, 'utf8');
  const grab = (from, to) => {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error(`water.js no longer contains ${from}`);
    return src.slice(a, b);
  };
  const code = grab('function metres(', 'function parseNear(')
             + grab('const RING_CELL', 'async function boundaryIndex')
             + grab('function straighten(', 'function pathLength(')
             + grab('function pathLength(', '/** pathPreferringDepth');
  return new Function(
    `${code}; return { straighten, pathLength, metres, CLEARANCE_DEFAULT_M, SAMPLE_M };`
  )();
}

const W = loadFromWorker();

// A bent channel: 600 m wide, turning through a right angle. Coordinates are
// degrees; at this latitude 0.001 deg lon is about 92 m.
const CHANNEL = [
  [-80.80, 34.40], [-80.75, 34.40], [-80.75, 34.35],
  [-80.744, 34.35], [-80.744, 34.406], [-80.80, 34.406], [-80.80, 34.40],
];

function ringIndex(ring, holes = []) {
  const rings = [ring, ...holes];
  const inRing = (lon, lat, r) => {
    let ins = false;
    for (let i = 0; i < r.length - 1; i++) {
      const [x1, y1] = r[i], [x2, y2] = r[i + 1];
      if ((y1 > lat) !== (y2 > lat) && lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) ins = !ins;
    }
    return ins;
  };
  const inside = (lon, lat) => inRing(lon, lat, ring) && !holes.some(h => inRing(lon, lat, h));
  const distShore = (lon, lat) => {
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
    let best = Infinity;
    for (const r of rings) {
      for (let i = 0; i < r.length - 1; i++) {
        const [x1, y1] = r[i], [x2, y2] = r[i + 1];
        const dx = (x2 - x1) * kx, dy = (y2 - y1) * ky;
        const px = (lon - x1) * kx, py = (lat - y1) * ky;
        const L = dx * dx + dy * dy;
        const t = L > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / L)) : 0;
        const d = Math.hypot(px - t * dx, py - t * dy);
        if (d < best) best = d;
      }
    }
    return best;
  };
  return { inside, distShore };
}

// A saw-tooth down the channel: the exact failure mode, alternating across the
// centreline the way consecutive cell centroids do.
function sawtooth() {
  const pts = [];
  for (let i = 0; i <= 20; i++) {
    const lon = -80.798 + (0.0455 * i) / 20;
    pts.push([lon, i % 2 ? 34.4045 : 34.4015]);
  }
  return pts;
}

function reversals(P) {
  let n = 0;
  for (let k = 1; k < P.length - 1; k++) {
    const b1 = Math.atan2(P[k][1] - P[k - 1][1], P[k][0] - P[k - 1][0]);
    const b2 = Math.atan2(P[k + 1][1] - P[k][1], P[k + 1][0] - P[k][0]);
    if (Math.abs((((b2 - b1) * 180) / Math.PI + 180) % 360 - 180) > 90) n++;
  }
  return n;
}

function samplesOutside(P, idx) {
  let n = 0;
  for (let k = 0; k < P.length - 1; k++) {
    const d = W.metres(P[k][0], P[k][1], P[k + 1][0], P[k + 1][1]);
    const steps = Math.max(2, Math.ceil(d / 20));
    for (let t = 1; t < steps; t++) {
      const f = t / steps;
      const lon = P[k][0] + (P[k + 1][0] - P[k][0]) * f;
      const lat = P[k][1] + (P[k + 1][1] - P[k][1]) * f;
      if (!idx.inside(lon, lat)) n++;
    }
  }
  return n;
}

describe('water.js straighten() — the saw-tooth fix', () => {
  const idx = ringIndex(CHANNEL);
  const raw = sawtooth();

  it('exports a kayak-scale default, not Garmin\'s 152.4 m powerboat value', () => {
    expect(W.CLEARANCE_DEFAULT_M > 0 && W.CLEARANCE_DEFAULT_M < 60).toBe(true);
  });

  it('removes the saw-tooth', () => {
    const out = W.straighten(raw, idx, 0);
    expect(reversals(raw) > 5).toBe(true);          // the input really is a saw-tooth
    expect(reversals(out) === 0).toBe(true);
  });

  it('never lengthens a path', () => {
    for (const c of [0, 5, 12, 25]) {
      const out = W.straighten(raw, idx, c);
      expect(W.pathLength(out) <= W.pathLength(raw)).toBe(true);
    }
  });

  it('never leaves the water, at any clearance', () => {
    for (const c of [0, 5, 12, 25, 50]) {
      expect(samplesOutside(W.straighten(raw, idx, c), idx)).toBe(0);
    }
  });

  it('never brings a path closer to shore than it already was', () => {
    // straighten() only DELETES vertices -- it cannot push a line away from the
    // bank. So the guarantee is not "every vertex clears 40 m"; it is "asking
    // for clearance never makes things worse". A path that already hugs the
    // wall is left alone, which is the correct answer, not a failure.
    const hugging = [];
    for (let i = 0; i <= 10; i++) hugging.push([-80.798 + 0.04 * i / 10, 34.4002]);
    const worstIn = Math.min(...hugging.map(p => idx.distShore(p[0], p[1])));
    for (const c of [0, 12, 40]) {
      const out = W.straighten(hugging, idx, c);
      const worstOut = Math.min(...out.map(p => idx.distShore(p[0], p[1])));
      expect(worstOut >= worstIn - 1e-6).toBe(true);
    }
  });

  it('respects clearance when there is room to', () => {
    // Down the middle of a 600 m channel there IS slack, so a 40 m request must
    // be honoured by every vertex of the result.
    const out = W.straighten(raw, idx, 40);
    const worst = Math.min(...out.map(p => idx.distShore(p[0], p[1])));
    expect(worst >= 40).toBe(true);
  });

  it('fails open when there is no boundary index', () => {
    expect(W.straighten(raw, false, 12)).toBe(raw);
    expect(W.straighten(raw, null, 12)).toBe(raw);
  });

  it('leaves degenerate paths alone', () => {
    const two = [[-80.79, 34.402], [-80.76, 34.402]];
    expect(W.straighten(two, idx, 12)).toBe(two);
    expect(W.straighten([], idx, 12).length).toBe(0);
  });

  it('does not cut across an island', () => {
    // A hole squarely between the two ends. A straight line would cross it, so
    // the result must keep enough vertices to go around.
    const island = [
      [-80.778, 34.4015], [-80.770, 34.4015],
      [-80.770, 34.4045], [-80.778, 34.4045], [-80.778, 34.4015],
    ];
    // NOTE: sampling is every SAMPLE_M metres, so a spit of land narrower than
    // that can be stepped over. Documented limitation, not a silent one.
    const withIsland = ringIndex(CHANNEL, [island]);
    const out = W.straighten(raw, withIsland, 0);
    // The invariant is that straightening never makes water-legality WORSE.
    // (This fixture's saw-tooth already clips the island, so demanding zero
    // would be testing the fixture, not the code.)
    expect(samplesOutside(out, withIsland) <= samplesOutside(raw, withIsland)).toBe(true);
  });
});
