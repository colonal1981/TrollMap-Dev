/**
 * water-endpoints.test.js — the compute plane, pinned against the ways it has already broken.
 *
 * Every case below is a bug that actually happened while `Worker/water.js` was being written on
 * 2026-08-06, not a hypothetical. Three of them were silent — they returned a plausible answer
 * rather than an error — which is why they are worth a test rather than a comment.
 *
 *   1. The TMWG magic number was written in READING order (0x474d5754) instead of the
 *      little-endian u32 it actually is (0x47574d54). Every graph load failed the header check
 *      and the endpoint answered "no water graph for this water" — indistinguishable from a
 *      missing file, and it stayed that way until a route was tried against a pack that
 *      definitely had one.
 *
 *   2. A leg was sliced with `(i + 1) % n`, which is correct on a closed ring and catastrophic
 *      on an open run: it walked off the end of an 8,770 m line, wrapped to index 0 and jumped
 *      across the lake. 2,000 m requested, 5,812 m returned. That is Ryan's original SmartPlan
 *      complaint — "it would reset back to no where near where it left off and then draw a
 *      connecting route over land" — reproduced by the replacement for it.
 *
 *   3. `?depth=12` must mean "the nearest CHARTED line to 12 ft". Garmin's contours are
 *      metric-derived, so near twelve feet the lines are 11.2 and 12.1 with nothing between.
 *      An exact match finds nothing and an unannounced substitution lies about where the boat
 *      is running.
 *
 *   4. `min_depth_ft` as a hard constraint made ordinary requests impossible. Node depth tags
 *      are MAR layer bases (0/3/6/9/12/15/18/24/30) and 45% of Wateree's nodes are tagged 0, so
 *      asking for 3 ft discarded nearly half the graph — including the shallow water every
 *      launch ramp sits in. It must relax and SAY it relaxed.
 */
import { describe, it, expect } from './expect-shim.mjs';
import { handleWaterRoute } from '../Worker/water.js';

// ── fixtures ────────────────────────────────────────────────────────────────────────────────

/**
 * A TMWG v2 graph that actually COVERS the runs below.
 *
 * The first version was four nodes spanning 275 m while the runs spanned 1.5 km, so most of
 * every leg sat beyond any node and the plan validated as off-water. That was the fixture being
 * wrong, not the code — but it is the same shape as a real defect (a pack whose graph does not
 * reach its own contours), so it is worth stating: a graph fixture must span the water it is
 * meant to be navigable for.
 */
function tmwg({ magic = 0x47574d54, allDeep = false } = {}) {
  const n = 24, e = n - 1;
  const buf = new ArrayBuffer(16 + n * 8 + e * 8 + n);
  const dv = new DataView(buf);
  dv.setUint32(0, magic, true);
  dv.setUint8(4, 2); dv.setUint8(5, 0); dv.setUint16(6, 0, true);
  dv.setUint32(8, n, true); dv.setUint32(12, e, true);
  const W = -80.9010, STEP = 0.00078;            // ~72 m apart, spanning ~1.65 km
  for (let i = 0; i < n; i++) {
    dv.setInt32(16 + i * 8, Math.round((W + i * STEP) * 1e7), true);
    dv.setInt32(16 + i * 8 + 4, Math.round(34.4000 * 1e7), true);
  }
  let o = 16 + n * 8;
  for (let i = 0; i < e; i++, o += 8) { dv.setUint32(o, i, true); dv.setUint32(o + 4, i + 1, true); }
  // Node 0 tagged 0 ft — the shallow water a launch ramp sits in, which is what makes
  // min_depth_ft impossible to honour as a hard constraint.
  const depths = new Uint8Array(n).fill(allDeep ? 9 : 9);
  if (!allDeep) { depths[0] = 0; depths[1] = 0; }
  new Uint8Array(buf, o, n).set(depths);
  return buf;
}

function runsDoc() {
  // One OPEN run and one CLOSED ring, both at charted depths that are NOT round feet.
  const open = [];
  for (let i = 0; i < 40; i++) open.push([-80.90 + i * 0.0004, 34.40]);   // ~1.5 km, open
  const ring = [];
  for (let a = 0; a <= 24; a++) {
    const t = (a / 24) * Math.PI * 2;
    // Centred on the graph, not 1.9 km away from it — the first version put this ring
    // beyond every node, which is how the un-checked seam between steps was found.
    ring.push([-80.8985 + 0.0006 * Math.cos(t), 34.400 + 0.0006 * Math.sin(t)]);
  }
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature',
        properties: { depth_dm: 37, depth_ft: 12.1, length_m: 1500, closed: false, routable: true,
                      relief: 'channel_edge', deepest_within_m: 41, ledge_n: 12,
                      near: [{ s: 100, t: 'timber', d: 40 }, { s: 1200, t: 'hump', d: 55 }],
                      near_counts: { timber: 1, hump: 1 } },
        geometry: { type: 'LineString', coordinates: open } },
      { type: 'Feature',
        properties: { depth_dm: 34, depth_ft: 11.2, length_m: 1100, closed: true, routable: true,
                      relief: 'flat', deepest_within_m: 14, near_counts: {} },
        geometry: { type: 'LineString', coordinates: ring } },
      { type: 'Feature',
        properties: { depth_dm: 37, depth_ft: 12.1, length_m: 900, closed: false, routable: false,
                      relief: 'flat', near_counts: {} },
        geometry: { type: 'LineString', coordinates: open.slice(0, 20) } },
    ],
  };
}

function envWith({ graphBuf = tmwg(), runs = runsDoc(), features = null } = {}) {
  return {
    R2_TROLLMAP_CHARTPACKS: {
      async get(key) {
        let payload = null;
        if (key.endsWith('water_graph.bin')) payload = graphBuf;
        else if (key.endsWith('trolling_runs.geojson')) payload = runs ? JSON.stringify(runs) : null;
        else if (key.endsWith('water_features.geojson')) payload = features ? JSON.stringify(features) : null;
        if (payload === null) return null;
        const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : new Uint8Array(payload);
        return {
          httpMetadata: {},
          text: () => Promise.resolve(new TextDecoder().decode(bytes)),
          get body() { return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }); },
        };
      },
    },
  };
}

// water.js caches parsed packs per isolate, KEYED BY SLUG. Every test therefore needs its own
// slug or it silently reads the previous test's fixture — which is exactly what happened the
// first time this file ran: a deliberately corrupt graph "routed fine" because a healthy one
// was already cached under the same name, and a deleted layer still answered 200.
let _slug = 0;
const nextSlug = () => `t${++_slug}`;

const call = async (env, slug, path, method = 'GET', body = null) => {
  const res = await handleWaterRoute(
    { method, json: async () => body }, env, new URL(`https://w/water/${slug}${path}`));
  return { status: res ? res.status : null, body: res ? JSON.parse(await res.text()) : null };
};

// ── the metric-contour rule ─────────────────────────────────────────────────────────────────

describe('depth is the nearest CHARTED line, and the response says which', () => {
  it('asking for 12 ft returns the 12.1 ft line', async () => {
    const r = await call(envWith(), nextSlug(), '/runs?depth=12');
    expect(r.status).toBe(200);
    expect(r.body.requested_depth_ft).toBe(12);
    expect(r.body.depth_ft).toBe(12.1);
  });

  it('SAYS it substituted, rather than silently returning a different depth', async () => {
    const r = await call(envWith(), nextSlug(), '/runs?depth=12');
    expect(typeof r.body.note).toBe('string');
    expect(r.body.note.includes('12.1')).toBe(true);
  });

  it('an exact charted depth is not flagged as a substitution', async () => {
    const r = await call(envWith(), nextSlug(), '/runs?depth=12.1');
    expect(r.body.depth_ft).toBe(12.1);
    expect(r.body.note).toBe(undefined);
  });
});

// ── the wrap rule ───────────────────────────────────────────────────────────────────────────

describe('a leg may only wrap on a closed ring', () => {
  it('an OPEN run stops at its end instead of jumping back to the start', async () => {
    const r = await call(envWith(), nextSlug(), '/runs?depth=12&len=100000&limit=1');
    const leg = r.body.runs[0].leg;
    // The run is ~1.5 km. Asking for 100 km must not produce more than the run holds; the
    // wrapping bug returned 2.9x the requested length by teleporting across the lake.
    expect(leg.length_m <= 1600).toBe(true);
    const co = leg.coordinates;
    let longest = 0;
    for (let i = 1; i < co.length; i++) {
      const dx = (co[i][0] - co[i - 1][0]) * 111320 * Math.cos(34.4 * Math.PI / 180);
      const dy = (co[i][1] - co[i - 1][1]) * 110570;
      longest = Math.max(longest, Math.hypot(dx, dy));
    }
    // A wrap shows up as one enormous segment. Real spacing here is ~37 m.
    expect(longest < 500).toBe(true);
  });

  it('a CLOSED ring may wrap, and still stops at the requested length', async () => {
    const r = await call(envWith(), nextSlug(), '/runs?depth=11.2&len=800&limit=1');
    const leg = r.body.runs[0].leg;
    expect(r.body.runs[0].closed).toBe(true);
    expect(leg.length_m > 0).toBe(true);
    expect(leg.length_m <= 800 * 1.15).toBe(true);
  });
});

// ── reachability ────────────────────────────────────────────────────────────────────────────

describe('runs a boat cannot reach are excluded by default', () => {
  it('routable:false is filtered out unless asked for', async () => {
    const r = await call(envWith(), nextSlug(), '/runs?depth=12');
    expect(r.body.runs.every((x) => x.routable)).toBe(true);
  });

  it('routable=any includes them, for diagnosis', async () => {
    const on = await call(envWith(), nextSlug(), '/runs?depth=12');
    const any = await call(envWith(), nextSlug(), '/runs?depth=12&routable=any');
    expect(any.body.matched > on.body.matched).toBe(true);
  });

  it('has= filters on what a run passes', async () => {
    const hit = await call(envWith(), nextSlug(), '/runs?depth=12&has=timber');
    const miss = await call(envWith(), nextSlug(), '/runs?depth=12&has=attractor');
    expect(hit.body.matched).toBe(1);
    expect(miss.body.matched).toBe(0);
  });
});

// ── the magic number ────────────────────────────────────────────────────────────────────────

describe('the TMWG header is read little-endian', () => {
  it('a correct graph routes', async () => {
    const r = await call(envWith(), nextSlug(), '/route', 'POST',
      { from: [-80.9010, 34.40], to: [-80.8900, 34.40] });
    expect(r.status).toBe(200);
    expect(r.body.distance_m > 0).toBe(true);
    expect(r.body.coordinates.length > 2).toBe(true);
  });

  it('the byte-reversed magic is REJECTED, not silently mis-parsed', async () => {
    // 0x474d5754 is 'TMWG' in reading order and is what the first version looked for.
    const env = envWith({ graphBuf: tmwg({ magic: 0x474d5754 }) });
    const r = await call(env, nextSlug(), '/route', 'POST', { from: [-80.9010, 34.40], to: [-80.8900, 34.40] });
    expect(r.status).toBe(404);
  });
});

// ── min_depth_ft relaxes rather than failing ────────────────────────────────────────────────

describe('min_depth_ft is a preference, because ramps are in shallow water', () => {
  it('routes anyway when the depth cannot be held, and says so', async () => {
    // Node 0 is tagged 0 ft, so a 6 ft minimum cannot be honoured from it.
    const r = await call(envWith(), nextSlug(), '/route', 'POST',
      { from: [-80.9010, 34.40], to: [-80.8900, 34.40], min_depth_ft: 6 });
    expect(r.status).toBe(200);
    expect(r.body.min_depth_held).toBe(false);
  });

  it('reports true when the constraint WAS honoured', async () => {
    const env = envWith({ graphBuf: tmwg({ allDeep: true }) });
    const r = await call(env, nextSlug(), '/route', 'POST',
      { from: [-80.9010, 34.40], to: [-80.8900, 34.40], min_depth_ft: 6 });
    expect(r.body.min_depth_held).toBe(true);
  });
});

// ── plans chain, which is the whole point ───────────────────────────────────────────────────

describe('every leg of a plan starts where the last one ended', () => {
  it('no step begins far from the previous step’s end', async () => {
    const r = await call(envWith(), nextSlug(), '/plan', 'POST', {
      launch: [-80.9010, 34.40],
      legs: [{ depth_ft: 12, length_m: 400 }, { depth_ft: 11.2, length_m: 400 }],
    });
    expect(r.status).toBe(200);
    let prevEnd = null, worst = 0;
    for (const s of r.body.steps) {
      const co = s.coordinates;
      if (prevEnd) {
        const dx = (co[0][0] - prevEnd[0]) * 111320 * Math.cos(34.4 * Math.PI / 180);
        const dy = (co[0][1] - prevEnd[1]) * 110570;
        worst = Math.max(worst, Math.hypot(dx, dy));
      }
      prevEnd = co[co.length - 1];
    }
    // The "reset to nowhere" bug would put kilometres here.
    expect(worst < 400).toBe(true);
    // And the endpoint must have noticed for itself, not just passed this assertion.
    expect(r.body.validation.worst_seam_m < 400).toBe(true);
    expect(r.body.valid).toBe(true);
  });

  it('reports fishing against transit, so a 92%-paddling plan is visible', async () => {
    const r = await call(envWith(), nextSlug(), '/plan', 'POST', {
      launch: [-80.9010, 34.40], legs: [{ depth_ft: 12, length_m: 400 }],
    });
    expect(typeof r.body.fishing_fraction).toBe('number');
    expect(r.body.total_m >= r.body.fishing_m).toBe(true);
  });

  it('validates the whole plan against a threshold derived from the mesh, not a constant', async () => {
    const r = await call(envWith(), nextSlug(), '/plan', 'POST', {
      launch: [-80.9010, 34.40], legs: [{ depth_ft: 12, length_m: 400 }],
    });
    expect(r.body.validation.threshold_source).toBe('half the p99 mesh edge');
    expect(r.body.validation.points_checked > 0).toBe(true);
  });
});

// ── absent layers answer honestly ───────────────────────────────────────────────────────────

describe('a missing layer is a 404 with a reason, never an empty success', () => {
  it('no trolling_runs', async () => {
    const r = await call(envWith({ runs: null }), nextSlug(), '/runs?depth=12');
    expect(r.status).toBe(404);
    expect(r.body.error.includes('trolling_runs')).toBe(true);
  });

  it('no water_features', async () => {
    const r = await call(envWith(), nextSlug(), '/features?kind=point');
    expect(r.status).toBe(404);
  });

  it('an unrelated path is not claimed', async () => {
    const res = await handleWaterRoute({ method: 'GET' }, envWith(), new URL('https://w/chartpacks/x/y.json'));
    expect(res).toBe(null);
  });
});
