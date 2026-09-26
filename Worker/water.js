/**
 * Worker/water.js — the compute plane over the static pack layers.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS EXISTS
 *
 * A phone at a boat ramp on one bar does not need a lake's whole water graph -- it needs one route
 * across the lake. This answers that question Worker-side and returns the answer. The pack files
 * stay in R2 and are read once per isolate.
 *
 *   POST /water/{slug}/route          { "from": [lon,lat], "to": [lon,lat] }
 *
 * smart-plan-v2.js routes every connecting leg over water through it.
 *
 * THERE WERE THREE MORE: GET /runs and /features and POST /plan, the 2026-08-06 design in which
 * the app asked the Worker for runs and the Worker chained them into a trip
 * (WORKER_AND_SMARTPLAN_REWRITE_PLAN_2026-08-06.md). The current Smart Plan replaced it on
 * 2026-08-07: the pack goes to candidates, the model picks runs, and the app assembles. Their
 * only caller was js/modules/smart-plan-route.js, which nothing imported. The routes and that
 * module went on 2026-09-25, with the two rules the leg-slicer carried: depth is the nearest
 * charted line, and a run may wrap only on a closed ring. Git has them if a leg-slicer is ever
 * written again.
 *
 * NOTHING HERE SCORES ANYTHING.
 */
import { CORS, JSON_HEADERS, chartpackKey, r2Text } from './worker-core.js';

// 'TMWG' = 54 4D 57 47, so a little-endian u32 read is 0x47574d54. Writing the bytes in
// reading order (0x474d5754) is the big-endian value and silently fails every load — the
// header check just returns "no water graph for this water", which reads like a missing file.
const MAGIC = 0x47574d54;
// ── THE CACHE IS BOUNDED BY BYTES NOW, NOT BY A COUNT OF PACKS ────────────────────────
//
// `CACHE_MAX = 8` was right when every graph came off Garmin's MAR mesh. Wateree's bathymetric
// graph is 4.57 MB on the wire and 5.9 MiB once this function expands it, so eight of them is
// 47 MiB of a 128 MiB isolate — comfortable, which is why a count was enough.
//
// The coastal graphs built from our own bathymetry on 2026-09-15 are a different size. ACE Basin
// is 321,844 nodes and 1,140,629 edges, 10.9 MiB on the wire, and the arrays kept below come to
// 15.1 MiB. Eight of those is 121 MiB, which leaves under 7 MiB of a 128 MiB isolate for the
// Worker and everything else in it. A COUNT CANNOT EXPRESS THAT: no one number of packs is right
// for both a 5.9 MiB graph and a 15.1 MiB one.
//
// THE BUDGET IS DERIVED, NOT PICKED. Parsing that graph needs its retained 15.1 MiB and, alive at
// the same moment, the 10.9 MiB source buffer plus the transient `deg`, `ea`, `eb`, `fill` and
// `lens` arrays — another 19.9 MiB, of which `lens` alone is a Float64Array over every edge.
// That is a 45.9 MiB peak landing on top of whatever the cache already holds. At 40 MiB of cache
// the worst moment is 86 MiB, leaving 42 MiB for the Worker itself.
//
// UNITS, SAID ONCE: every figure here is MiB, because the 128 MB isolate limit is. An earlier
// draft of this note mixed MB and MiB and put the same array at 15.9 and 15.1.
//
// THE COUNT CAP STAYS as a second bound. A hundred small entries carry a hundred lots of Map and
// object overhead that summing byteLength does not see.
const CACHE_MAX = 8;                              // parsed packs held per isolate
const CACHE_MAX_BYTES = 40 * 1024 * 1024;
const _cache = new Map();
const _cacheBytes = new Map();
let _cacheTotal = 0;

/**
 * What one entry actually costs, in bytes.
 *
 * A typed array knows its own size, and that covers the water graph — the only entry here
 * measured in megabytes. Everything else reports what its caller already knew (the JSON text
 * length, for a parsed pack file) or falls back to a floor. The floor is a floor and is named as
 * one: it is not a measurement of a Map of vertex buckets, and a number invented for one would be
 * worse than admitting the bound is approximate above the megabyte scale that matters.
 */
export function entryBytes(v, given) {
  if (Number.isFinite(given)) return given;
  if (!v || typeof v !== 'object') return 64;
  let n = 0;
  for (const x of Object.values(v)) {
    if (x && typeof x.byteLength === 'number') n += x.byteLength;
  }
  return n || 4096;
}

/** The cache's own accounting, so a test can assert the bound instead of trusting it. */
export function cacheStats() {
  return { entries: _cache.size, bytes: _cacheTotal, maxBytes: CACHE_MAX_BYTES, maxEntries: CACHE_MAX };
}

function cacheGet(k) {
  if (!_cache.has(k)) return null;
  const v = _cache.get(k);
  _cache.delete(k);                  // LRU: reinsert to mark as most recent
  _cache.set(k, v);
  return v;                          // the byte total is unchanged: same key, same value
}

function cacheSet(k, v, bytes) {
  if (_cache.has(k)) {               // a re-set replaces, so drop the old cost first
    _cacheTotal -= _cacheBytes.get(k) || 0;
    _cache.delete(k);
    _cacheBytes.delete(k);
  }
  const b = entryBytes(v, bytes);
  _cache.set(k, v);
  _cacheBytes.set(k, b);
  _cacheTotal += b;
  // NEVER EVICT TO EMPTY. The entry just added is the one the caller is about to use, and a graph
  // bigger than the whole budget must still be usable once rather than thrown away and re-fetched
  // on every request — which would be slower AND peak higher than keeping it.
  while (_cache.size > 1 && (_cache.size > CACHE_MAX || _cacheTotal > CACHE_MAX_BYTES)) {
    const oldest = _cache.keys().next().value;
    _cacheTotal -= _cacheBytes.get(oldest) || 0;
    _cache.delete(oldest);
    _cacheBytes.delete(oldest);
  }
  return v;
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, ...JSON_HEADERS, 'Cache-Control': 'public, max-age=60', ...extra },
  });
}

// ── loading ─────────────────────────────────────────────────────────────────────────────────

async function packJson(env, slug, file) {
  const k = `json:${slug}/${file}`;
  const hit = cacheGet(k);
  if (hit !== null) return hit;
  const obj = await env.R2_TROLLMAP_CHARTPACKS.get(chartpackKey(slug, file));
  if (!obj) return cacheSet(k, false);
  const txt = await r2Text(obj);            // honours the stored gzip; obj.text() would not
  try {
    // The source length is the honest size for a parsed object: the parse is the same order of
    // magnitude as its text and this is the only place that still has the text to ask.
    return cacheSet(k, JSON.parse(txt), txt.length);
  } catch {
    return cacheSet(k, false);
  }
}

async function packBytes(env, slug, file) {
  const obj = await env.R2_TROLLMAP_CHARTPACKS.get(chartpackKey(slug, file));
  if (!obj) return null;
  const enc = obj.httpMetadata && obj.httpMetadata.contentEncoding;
  const body = (enc && String(enc).toLowerCase() === 'gzip')
    ? obj.body.pipeThrough(new DecompressionStream('gzip'))
    : obj.body;
  return new Response(body).arrayBuffer();
}

// ONE LOAD PER GRAPH AT A TIME, HOWEVER MANY REQUESTS ARRIVE WHILE IT IS LOADING.
//
// The cache above answers a request that arrives AFTER the graph is parsed. It did nothing for the
// ones that arrive DURING: each missed, fetched the 4.6 MB .bin and parsed it again. Pick Water
// prefetches every transit of the day at once -- twenty requests for Ryan's 2026-09-26 Wateree day --
// so a cold isolate began twenty parses of the same graph together, each with the ~46 MiB peak the
// note above works out, against a 128 MiB isolate. Fourteen of the nineteen transits came back
// unrouted and drew as straight lines, and every one of them routed on a warm Worker afterwards.
// Now the first miss starts the load and every request behind it waits on that same promise.
const _inflight = new Map();

/** water_graph.bin, format v2. See build_water_graphs.py for the writer. */
async function graph(env, slug) {
  const k = `graph:${slug}`;
  const hit = cacheGet(k);
  if (hit !== null) return hit;
  const pending = _inflight.get(k);
  if (pending) return pending;
  const p = loadGraph(env, slug, k).finally(() => _inflight.delete(k));
  _inflight.set(k, p);
  return p;
}

async function loadGraph(env, slug, k) {
  const buf = await packBytes(env, slug, 'water_graph.bin');
  if (!buf || buf.byteLength < 16) return cacheSet(k, false);
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) return cacheSet(k, false);
  const nn = dv.getUint32(8, true);
  const ne = dv.getUint32(12, true);
  if (16 + nn * 8 + ne * 8 + nn > buf.byteLength) return cacheSet(k, false);
  const lon = new Float64Array(nn);
  const lat = new Float64Array(nn);
  let o = 16;
  for (let i = 0; i < nn; i++, o += 8) {
    lon[i] = dv.getInt32(o, true) / 1e7;
    lat[i] = dv.getInt32(o + 4, true) / 1e7;
  }
  // Adjacency as flat CSR — an array of arrays costs more than the graph does.
  const deg = new Uint32Array(nn);
  const ea = new Uint32Array(ne);
  const eb = new Uint32Array(ne);
  for (let e = 0; e < ne; e++, o += 8) {
    const a = dv.getUint32(o, true);
    const b = dv.getUint32(o + 4, true);
    ea[e] = a; eb[e] = b;
    if (a < nn && b < nn) { deg[a]++; deg[b]++; }
  }
  // COPIED, NOT VIEWED, AND AT THIS SIZE THAT IS THE DIFFERENCE BETWEEN 121 KB AND 4.6 MB.
  //
  // A Uint8Array VIEW keeps its whole backing ArrayBuffer alive, so caching one pinned the entire
  // .bin for the life of the entry. On the Garmin mesh that was 151 KB and nobody could care. The
  // bathymetric graph is 4.57 MB, eight of them fit in this cache, and a Worker isolate has
  // 128 MB -- so the view alone would have retained 36 MB to hold 1 MB of depths.
  const depth = new Uint8Array(buf, o, nn).slice();
  const head = new Uint32Array(nn + 1);
  for (let i = 0; i < nn; i++) head[i + 1] = head[i] + deg[i];
  const adj = new Uint32Array(head[nn]);
  const fill = head.slice(0, nn);
  for (let e = 0; e < ne; e++) {
    const a = ea[e], b = eb[e];
    if (a < nn && b < nn) { adj[fill[a]++] = b; adj[fill[b]++] = a; }
  }
  // The mesh's own scale, so "is this point off the water" is calibrated per lake instead of
  // guessed. MAR cells are not uniform: on Wateree the edges run 35 m at the median, 507 m at
  // p99 and 1,126 m at the longest, so a point in the middle of a legitimate open-water edge
  // sits ~250 m from either end. A fixed 150 m threshold failed 11 points on a plan that an
  // independent depth-grid check found 100% over water across 1,915 samples.
  // A TYPED ARRAY, because this one is 448,208 entries on the bathymetric graph. A plain JS array
  // of that many doubles is several times the memory of a Float64Array and its sort compares
  // through a callback; the typed sort is numeric and in place. Same number out.
  const lens = new Float64Array(ne);
  let nl = 0;
  for (let e = 0; e < ne; e++) {
    const a = ea[e], b = eb[e];
    if (a < nn && b < nn) lens[nl++] = metres(lon[a], lat[a], lon[b], lat[b]);
  }
  const used = lens.subarray(0, nl);
  used.sort();
  const p99 = nl ? used[Math.floor(nl * 0.99)] : 200;
  return cacheSet(k, { nn, lon, lat, depth, head, adj, offWaterM: Math.max(120, Math.round(p99 / 2)) });
}

// ── geometry ────────────────────────────────────────────────────────────────────────────────

function metres(ax, ay, bx, by) {
  const dx = (bx - ax) * 111320 * Math.cos(((ay + by) / 2) * Math.PI / 180);
  const dy = (by - ay) * 110570;
  return Math.hypot(dx, dy);
}

// ── handlers ────────────────────────────────────────────────────────────────────────────────

function nearestNode(g, lon, lat) {
  let bi = -1, bd = Infinity;
  for (let i = 0; i < g.nn; i++) {
    const d = metres(lon, lat, g.lon[i], g.lat[i]);
    if (d < bd) { bd = d; bi = i; }
  }
  return { i: bi, d: bd };
}

/** Shortest path over navigable water. Returns {distance_m, coordinates} or null if unreachable. */
// Longer than any route on any water this app carries, so a single shallow metre outranks every
// possible saving in distance. Wateree end to end is about 60 km; this is a thousand times that.
const PENALTY = 1e6;

function shortestPath(g, ai, bi, minDepth) {
  const dist = new Float64Array(g.nn).fill(Infinity);
  const prev = new Int32Array(g.nn).fill(-1);
  dist[ai] = 0;
  // Binary heap. 8,896 nodes on Wateree; an array scan would be O(n^2) and is not needed.
  const heap = [[0, ai]];
  const push = (d, i) => {
    heap.push([d, i]);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p][0] <= heap[c][0]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]]; c = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1, r = l + 1;
        let s = c;
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
        if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
        if (s === c) break;
        [heap[s], heap[c]] = [heap[c], heap[s]]; c = s;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, u] = pop();
    if (d > dist[u]) continue;
    if (u === bi) break;
    for (let e = g.head[u]; e < g.head[u + 1]; e++) {
      const v = g.adj[e];
      const w = metres(g.lon[u], g.lat[u], g.lon[v], g.lat[v]);
      // THE FLOOR IS A COST, NOT A GATE, AND THAT IS WHAT MAKES IT USABLE AT A RAMP.
      //
      // `continue` here made the depth all-or-nothing: either every node on the path cleared the
      // floor or the whole request fell back to no floor at all. A launch ramp is in shallow
      // water by definition -- the node nearest Clearwater Cove is tagged 3 ft -- so every leg
      // touching the ramp dropped the constraint entirely and crossed whatever it liked for its
      // whole length, to get off a bank it had to cross either way.
      //
      // Shallow metres are priced instead. PENALTY is not a tuning knob: it is longer than any
      // path on any lake this app carries, so the search is LEXICOGRAPHIC -- fewest shallow
      // metres first, shortest distance among those. A route that can hold the floor holds it
      // exactly; one that cannot uses the least shallow water it possibly can, which at a ramp
      // is the few metres off the bank and nothing else.
      const shallow = minDepth && g.depth[v] < minDepth;
      const cost = shallow ? w * PENALTY : w;
      if (d + cost < dist[v]) { dist[v] = d + cost; prev[v] = u; push(d + cost, v); }
    }
  }
  if (!Number.isFinite(dist[bi])) return null;
  // WALK IT BACK AND MEASURE WHAT IT ACTUALLY COST, because `dist` is a penalised number and
  // nobody wants that reported as a distance. The real length and the shallow metres both come
  // out of the path itself.
  const path = [];
  let realM = 0, shallowM = 0, shallowest = Infinity;
  for (let u = bi; u !== -1; u = prev[u]) {
    path.push([Number(g.lon[u].toFixed(6)), Number(g.lat[u].toFixed(6))]);
    if (g.depth[u] < shallowest) shallowest = g.depth[u];
    const p = prev[u];
    if (p !== -1) {
      const w = metres(g.lon[p], g.lat[p], g.lon[u], g.lat[u]);
      realM += w;
      if (minDepth && g.depth[u] < minDepth) shallowM += w;
    }
  }
  path.reverse();
  return { distance_m: Math.round(realM), coordinates: path,
           shallow_m: Math.round(shallowM),
           shallowest_ft: Number.isFinite(shallowest) ? shallowest : null };
}

// THE HINT USED TO NAME A SCRIPT THAT NO LONGER EXISTS AND SHOULD NOT BE RUN.
// It said "run restitch_water_graphs.py if this pack predates that repair".
// restitch was retracted on 2026-08-07 and deleted: it closed graph components by joining
// them within a distance tolerance, and at 75 m, 178 lakes needed joins over 50 m -- a join
// that long welds water above a dam to water below it and routes a trolling run through the
// dam. The diagnosis behind it was wrong. Components are severed by the BOUNDARY CLIP in
// build_water_graphs.py, so the fix is a wider boundary, never a wider join.
const UNREACHABLE = {
  error: 'no route over water between those points',
  hint: 'the two points are in different connected components of the water graph — the '
      + 'boundary clip severed them, so the fix is a wider boundary for this water, not a '
      + 'wider join',
};

/**
 * Shortest path, PRICING shallow water rather than forbidding it.
 *
 * `depth` on a graph node is the deepest layer that contains the cell. On the Garmin mesh 45% of
 * Wateree's nodes are tagged 0 ft, so a hard `min_depth_ft: 3` discarded half the lake; the
 * bathymetric graph is 5.2% at 0 ft, and at a 6 ft floor 80.4% of its nodes remain with 99.8% of
 * those in one connected piece. The floor became affordable, and this function became the thing
 * standing in its way.
 *
 * IT USED TO BE ALL OR NOTHING: try the whole path with the floor, and if that failed anywhere,
 * throw the floor away for the WHOLE path. A launch ramp is in shallow water by definition -- the
 * node nearest Clearwater Cove is tagged 3 ft -- so every leg touching the ramp fell back to no
 * constraint at all and was then free to cross a 2 ft neck a mile away, to solve a problem that
 * only existed in the first twenty metres off the bank.
 *
 * shortestPath() prices shallow metres instead, lexicographically: fewest shallow metres first,
 * shortest distance among those. So a route that can hold the floor holds it exactly, and one
 * that cannot spends the least shallow water it possibly can. There is one call and it always
 * answers.
 *
 * `min_depth_held` stays for callers that only want the yes/no, and `shallow_m` is the number
 * worth reading: "40 m of it is shallower than you asked for, leaving the ramp" is a fact he can
 * act on, where "the constraint was dropped" is not.
 */
function pathPreferringDepth(g, ai, bi, minDepth) {
  const p = shortestPath(g, ai, bi, minDepth);
  if (!p) return null;
  if (!(minDepth > 0)) return p;
  return { ...p, min_depth_held: p.shallow_m === 0 };
}

// ── shoreline clearance ─────────────────────────────────────────────────────────────────────
//
// Garmin's auto-guidance does NOT smooth a path afterwards. There is no funnel, no string-pull
// and no simplification anywhere in its routing module -- verified across the whole firmware
// image. It searches a space that ALREADY has a land buffer applied: `nav_land_dist_restrict`,
// default 152.4 m, which is exactly 500 ft. See GARMIN_AUTOGUIDANCE_DECODED_2026-08-07.md.
//
// That one constant explains both behaviours Ryan described. Water narrower than twice the
// clearance has no freedom left, so the line is forced to the middle of the creek or cove;
// wider water leaves slack and the shortest path takes over as a straight shot.
//
// We cannot search a buffered mesh here -- the shipped graph carries cell centroids and no
// portal geometry -- so we take the graph's cell path and pull it straight wherever the straight
// line stays on water and at least `clearance` off the bank. Same observable behaviour.
//
// WHY THIS MATTERS: rendering raw cell centroids produced a 13.95 km saw-tooth for a 4.97 km hop
// on Wateree, reversing direction 27 times -- 530 m out and 527 m back to advance 140 m. The
// cell SEQUENCE was right the whole time; the polyline through it was not.
//
// FAILS OPEN at every step. No boundary object, no usable ring, no valid straightening -- return
// the path exactly as the graph gave it. A poor line beats no route.

const RING_CELL = 0.002;            // ~200 m grid over the boundary ring
const SAMPLE_M = 20;                // clearance is tested every 20 m along a candidate segment
const CLEARANCE_DEFAULT_M = 12;     // a kayak, not Garmin's 152.4 m powerboat default

function ringsFromGeoJson(gj) {
  const polys = [];
  for (const f of (gj.features || [gj])) {
    const geom = f.geometry || f;
    if (!geom || !geom.coordinates) continue;
    if (geom.type === 'Polygon') polys.push(geom.coordinates);
    else if (geom.type === 'MultiPolygon') for (const q of geom.coordinates) polys.push(q);
  }
  // The lake is the biggest ring. Boundary files carry stray slivers on some packs.
  let best = null;
  for (const q of polys) if (q[0] && (!best || q[0].length > best[0].length)) best = q;
  return best;
}

async function boundaryIndex(env, slug) {
  const k = `bidx:${slug}`;
  const hit = cacheGet(k);
  if (hit !== null) return hit;
  let gj = null;
  try { gj = await packJson(env, slug, 'boundary.geojson'); } catch { gj = null; }
  if (!gj) return cacheSet(k, false);
  const poly = ringsFromGeoJson(gj);
  if (!poly || !poly[0] || poly[0].length < 4) return cacheSet(k, false);

  // Two indexes over the same rings: y-buckets for inside/outside, a grid of vertices for
  // distance-to-shore. Wateree's ring is 17,282 vertices; scanning it per sample is not viable.
  const yb = new Map(), vg = new Map();
  for (const ring of poly) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
      const lo = Math.floor(Math.min(y1, y2) / RING_CELL), hi = Math.floor(Math.max(y1, y2) / RING_CELL);
      for (let b = lo; b <= hi; b++) {
        let a = yb.get(b); if (!a) yb.set(b, a = []);
        a.push(x1, y1, x2, y2);
      }
      const gk = `${Math.floor(x1 / RING_CELL)}:${Math.floor(y1 / RING_CELL)}`;
      let v = vg.get(gk); if (!v) vg.set(gk, v = []);
      v.push(x1, y1);
    }
  }

  const inside = (lon, lat) => {
    const a = yb.get(Math.floor(lat / RING_CELL));
    if (!a) return false;
    let ins = false;
    for (let i = 0; i < a.length; i += 4) {
      const x1 = a[i], y1 = a[i + 1], x2 = a[i + 2], y2 = a[i + 3];
      if ((y1 > lat) !== (y2 > lat) && lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) ins = !ins;
    }
    return ins;
  };

  // Distance to the nearest ring VERTEX, not the nearest segment. The ring is dense enough that
  // the difference is under the sampling noise, and it keeps this O(1) per query.
  const distShore = (lon, lat) => {
    const gx = Math.floor(lon / RING_CELL), gy = Math.floor(lat / RING_CELL);
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
    let best = Infinity;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const v = vg.get(`${gx + dx}:${gy + dy}`);
        if (!v) continue;
        for (let i = 0; i < v.length; i += 2) {
          const ex = (lon - v[i]) * kx, ey = (lat - v[i + 1]) * ky;
          const d = ex * ex + ey * ey;
          if (d < best) best = d;
        }
      }
    }
    return best === Infinity ? Infinity : Math.sqrt(best);
  };

  return cacheSet(k, { inside, distShore });
}

/** Straighten a graph path, holding `clearance` metres off the bank. Never lengthens it. */
function straighten(coords, idx, clearance) {
  if (!idx || !Array.isArray(coords) || coords.length < 3) return coords;
  const okAt = (lon, lat) => idx.inside(lon, lat) && idx.distShore(lon, lat) >= clearance;
  const clear = (a, b) => {
    const d = metres(a[0], a[1], b[0], b[1]);
    const n = Math.max(2, Math.ceil(d / SAMPLE_M));
    for (let k = 1; k < n; k++) {
      const t = k / n;
      if (!okAt(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)) return false;
    }
    return true;
  };
  const out = [coords[0]];
  let i = 0, guard = 0;
  while (i < coords.length - 1 && guard++ < 10000) {
    let j = coords.length - 1;
    while (j > i + 1 && !clear(coords[i], coords[j])) j--;
    out.push(coords[j]);
    i = j;
  }
  // The endpoints are snapped graph nodes and may themselves sit inside the clearance band -- a
  // ramp is against the bank by definition. If nothing could be joined, keep the original.
  return out.length >= 2 && out.length <= coords.length ? out : coords;
}

function pathLength(coords) {
  let m = 0;
  for (let i = 0; i < coords.length - 1; i++) m += metres(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
  return Math.round(m);
}

/** pathPreferringDepth + straightening. `idx` may be false; then this is a no-op. */
function waterPath(g, ai, bi, minDepth, idx, clearance) {
  const p = pathPreferringDepth(g, ai, bi, minDepth);
  if (!p || !idx) return p;
  const s = straighten(p.coordinates, idx, clearance);
  if (s === p.coordinates || s.length >= p.coordinates.length) return p;
  return { ...p, coordinates: s, distance_m: pathLength(s), raw_vertices: p.coordinates.length };
}
async function handleRoute(env, slug, request) {
  const g = await graph(env, slug);
  if (!g) return json({ error: 'no water graph for this water', slug }, 404);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'body must be JSON' }, 400); }
  const from = body && body.from, to = body && body.to;
  const ok = (p) => Array.isArray(p) && p.length >= 2 && p.every((n) => Number.isFinite(n));
  if (!ok(from) || !ok(to)) return json({ error: 'from and to must be [lon, lat]' }, 400);
  const a = nearestNode(g, from[0], from[1]);
  const b = nearestNode(g, to[0], to[1]);
  if (a.i < 0 || b.i < 0) return json({ error: 'graph is empty', slug }, 500);
  const clearance = Number.isFinite(Number(body.clearance_m))
    ? Math.max(0, Number(body.clearance_m)) : CLEARANCE_DEFAULT_M;
  const bidx = await boundaryIndex(env, slug);
  const p = waterPath(g, a.i, b.i, Number(body.min_depth_ft) || 0, bidx, clearance);
  if (!p) return json({ ...UNREACHABLE, slug }, 422);
  const straight = metres(from[0], from[1], to[0], to[1]);
  return json({
    slug,
    from_snapped_m: Math.round(a.d), to_snapped_m: Math.round(b.d),
    // Whether the depth preference survived. Computing this and then not returning it made
    // the relaxation invisible, which is the same failure as not relaxing at all: the caller
    // asked to stay in 3 ft, did not, and was never told.
    min_depth_held: p.min_depth_held,
    // HOW MUCH OF IT IS SHALLOWER THAN HE ASKED FOR, which is the number a person can act on.
    // The router spends the least shallow water it can rather than abandoning the floor, so
    // "40 m" is the boat leaving the bank and "600 m" is a leg worth looking at. `min_depth_held`
    // alone made those two read the same.
    shallow_m: p.shallow_m,
    shallowest_ft: p.shallowest_ft,
    distance_m: p.distance_m,
    straight_line_m: Math.round(straight),
    detour_ratio: straight > 0 ? Number((p.distance_m / straight).toFixed(2)) : null,
    vertices: p.coordinates.length,
    coordinates: p.coordinates,
  });
}

/** Returns a Response, or null if the path is not ours. */
export async function handleWaterRoute(request, env, url) {
  const mm = url.pathname.match(/^\/water\/([^/]+)\/(route)$/);
  if (!mm) return null;
  const slug = mm[1];
  const what = mm[2];
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  try {
    if (what === 'route' && request.method === 'POST') return await handleRoute(env, slug, request);
  } catch (e) {
    return json({ error: String(e && e.message || e), slug, endpoint: what }, 500);
  }
  return json({ error: 'method not allowed' }, 405);
}

export const WATER_ROUTES = [
  'POST /water/<slug>/route  {from:[lon,lat], to:[lon,lat], min_depth_ft?}',
];
