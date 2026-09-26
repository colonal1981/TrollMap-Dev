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
 *   2 and 3 were /runs bugs, and /runs was deleted on 2026-09-25 (see below). They stay here as
 *      the record of what a leg-slicer must not do.
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

// ── /runs, /features and /plan ─────────────────────────────────────────────────────────────
// Three describe blocks of /runs tests stood here (the nearest charted line, the closed-ring
// wrap, routable filtering), and one of /plan further down. All three routes were the 2026-08-06
// SmartPlan design that the current one replaced a day later; no caller was left, and they were
// deleted on 2026-09-25. /route is what smart-plan-v2.js calls, and it is tested below.

// Ryan's 2026-09-26 Wateree Pick Water day prefetched twenty transits at once. On a cold isolate each
// one missed the cache and fetched and parsed the 4.6 MB graph again -- twenty ~46 MiB peaks against a
// 128 MiB isolate -- and fourteen transits came back unrouted, every one of which routes when warm.
describe('a burst of routes on a cold Worker loads the graph once', () => {
  it('twenty concurrent routes read water_graph.bin from R2 once, and all route', async () => {
    const env = envWith();
    let graphReads = 0;
    const get = env.R2_TROLLMAP_CHARTPACKS.get;
    env.R2_TROLLMAP_CHARTPACKS.get = async (key) => {
      if (key.endsWith('water_graph.bin')) graphReads++;
      return get(key);
    };
    const slug = nextSlug();
    const rs = await Promise.all(Array.from({ length: 20 }, () =>
      call(env, slug, '/route', 'POST', { from: [-80.9010, 34.40], to: [-80.8900, 34.40] })));
    expect(graphReads).toBe(1);
    expect(rs.every((r) => r.status === 200)).toBe(true);
  });
});

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

// ── absent layers answer honestly ───────────────────────────────────────────────────────────

describe('a missing layer is a 404 with a reason, never an empty success', () => {
  it('no water graph', async () => {
    const r = await call(envWith({ graphBuf: null }), nextSlug(), '/route', 'POST',
                         { from: [-80.9010, 34.4], to: [-80.8900, 34.4] });
    expect(r.status).toBe(404);
    expect(r.body.error.includes('water graph')).toBe(true);
  });

  it('the deleted routes are not answered', async () => {
    for (const p of ['/runs?depth=12', '/features?kind=point', '/plan']) {
      const res = await handleWaterRoute({ method: 'GET' }, envWith(), new URL(`https://w/water/x${p}`));
      expect(res).toBe(null);
    }
  });

  it('an unrelated path is not claimed', async () => {
    const res = await handleWaterRoute({ method: 'GET' }, envWith(), new URL('https://w/chartpacks/x/y.json'));
    expect(res).toBe(null);
  });
});
