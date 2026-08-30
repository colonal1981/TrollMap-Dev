/**
 * Worker/water.js — the compute plane over the static pack layers.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS EXISTS
 *
 * Wateree's `trolling_runs.geojson` is 3.4 MB and its `structure.geojson` is 1.7 MB. A phone at
 * a boat ramp on one bar does not need either of them — it needs the ten runs at a depth, or
 * one route across the lake. These endpoints answer the question Worker-side and return the
 * answer. The pack files stay in R2 and are read once per isolate.
 *
 * Three endpoints, matching what the fishing intel actually asks for:
 *
 *   GET  /water/{slug}/runs?depth=12&near=lat,lon&len=2000&relief=channel_edge&has=timber
 *   GET  /water/{slug}/features?near=lat,lon&kind=point&limit=20
 *   POST /water/{slug}/route          { "from": [lon,lat], "to": [lon,lat] }
 *
 * NOTHING HERE SCORES ANYTHING.
 *
 * `runs` filters and inventories; it never ranks by "quality". Whether six stands of flooded
 * timber beat nine humps depends on species, season and where the forage is, and that judgement
 * lives in the app's trollingIntelligence. A caller asks for what it wants and gets what
 * matches, with a count of what is on it. See WORKER_AND_SMARTPLAN_REWRITE_PLAN_2026-08-06.md.
 *
 * TWO RULES THAT ARE NOT OPTIONAL
 *
 * 1. Round foot depths mostly do not exist. Garmin's contours are metric-derived, so near
 *    twelve feet the charted lines are 11.2 ft and 12.1 ft with nothing between. `?depth=12`
 *    therefore means "nearest charted line to 12", and the response says which line it used in
 *    `depth_ft`. A caller that searches for an exact 12 finds nothing.
 *
 * 2. Wrapping a run is legal ONLY on a closed ring. The first leg-slicer written against this
 *    data walked an 8,770 m OPEN run with `(i + 1) % n`, fell off the end, wrapped to index 0
 *    and jumped clean across the lake — 2,000 m requested, 5,812 m returned. That is Ryan's
 *    original complaint reproduced exactly ("it would reset back to no where near where it left
 *    off and then draw a connecting route over land"). On an open run you walk to the end and
 *    stop, then try the other direction.
 */
import { CORS, JSON_HEADERS, chartpackKey, r2Text } from './worker-core.js';

// 'TMWG' = 54 4D 57 47, so a little-endian u32 read is 0x47574d54. Writing the bytes in
// reading order (0x474d5754) is the big-endian value and silently fails every load — the
// header check just returns "no water graph for this water", which reads like a missing file.
const MAGIC = 0x47574d54;
const CACHE_MAX = 8;                 // parsed packs held per isolate
const _cache = new Map();

function cacheGet(k) {
  if (!_cache.has(k)) return null;
  const v = _cache.get(k);
  _cache.delete(k);                  // LRU: reinsert to mark as most recent
  _cache.set(k, v);
  return v;
}

function cacheSet(k, v) {
  _cache.set(k, v);
  while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
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
    return cacheSet(k, JSON.parse(txt));
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

/** water_graph.bin, format v2. See build_water_graphs.py for the writer. */
async function graph(env, slug) {
  const k = `graph:${slug}`;
  const hit = cacheGet(k);
  if (hit !== null) return hit;
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

function parseNear(s) {
  if (!s) return null;
  const p = String(s).split(',').map(Number);
  // "lat,lon" — the order a user reads off a chartplotter, not GeoJSON order. Guarded so a
  // transposed pair cannot silently return the wrong side of the state.
  if (p.length !== 2 || !p.every(Number.isFinite)) return null;
  if (Math.abs(p[0]) > 90 || Math.abs(p[1]) > 180) return null;
  return { lat: p[0], lon: p[1] };
}

/**
 * Walk `f` from the point nearest `near` for `want` metres.
 * Wrapping is permitted only when the run is a closed ring — see the header.
 */
function sliceLeg(f, near, want, startS) {
  const co = f.geometry.coordinates;
  const n = co.length;
  const closed = !!f.properties.closed;
  let i0 = 0;
  if (Number.isFinite(startS)) {
    // Position by distance ALONG the run. Used when the caller asked for a feature type: the
    // leg has to cover where that feature actually is, not merely belong to a run that has one
    // somewhere. A 2 km leg off an 8.7 km run can easily miss the only timber on it.
    let s = 0, best = Infinity;
    for (let i = 0; i < n; i++) {
      if (i) s += metres(co[i - 1][0], co[i - 1][1], co[i][0], co[i][1]);
      const d = Math.abs(s - startS);
      if (d < best) { best = d; i0 = i; }
    }
  } else if (near) {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const d = metres(near.lon, near.lat, co[i][0], co[i][1]);
      if (d < best) { best = d; i0 = i; }
    }
  }
  const walk = (step) => {
    const out = [co[i0]];
    let d = 0, i = i0;
    while (d < want) {
      let j = i + step;
      if (closed) j = (j + n) % n;
      else if (j < 0 || j >= n) break;
      if (j === i0) break;
      const seg = metres(co[i][0], co[i][1], co[j][0], co[j][1]);
      if (d + seg > want * 1.15) break;      // a simplified segment can be 100 m+; do not overshoot
      d += seg; out.push(co[j]); i = j;
    }
    return { coords: out, length_m: Math.round(d) };
  };
  const a = walk(1), b = walk(-1);
  return a.length_m >= b.length_m ? a : b;
}

/** Inventory of what a sliced leg passes, from the run's pre-computed `near` list. */
function legInventory(f, coords) {
  const near = f.properties.near || [];
  if (!near.length || coords.length < 2) return {};
  const co = f.geometry.coordinates;
  // `near[].s` is metres along the FULL run, so find where the leg sits on it.
  let s0 = 0;
  const first = coords[0];
  for (let i = 1; i < co.length; i++) {
    if (co[i - 1] === first) break;
    s0 += metres(co[i - 1][0], co[i - 1][1], co[i][0], co[i][1]);
    if (co[i] === first) break;
  }
  let len = 0;
  for (let i = 1; i < coords.length; i++) len += metres(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  const lo = s0, hi = s0 + len;
  const out = {};
  for (const e of near) if (e.s >= lo && e.s <= hi) out[e.t] = (out[e.t] || 0) + 1;
  return out;
}

// ── handlers ────────────────────────────────────────────────────────────────────────────────

async function handleRuns(env, slug, url) {
  const doc = await packJson(env, slug, 'trolling_runs.geojson');
  if (!doc) return json({ error: 'no trolling_runs for this water', slug }, 404);
  let feats = doc.features || [];

  const wantDepth = Number(url.searchParams.get('depth'));
  let usedDepth = null;
  if (Number.isFinite(wantDepth)) {
    // Nearest CHARTED line, because round feet mostly do not exist. See the header.
    let best = Infinity;
    for (const f of feats) {
      const d = Math.abs(f.properties.depth_ft - wantDepth);
      if (d < best) { best = d; usedDepth = f.properties.depth_ft; }
    }
    if (usedDepth === null) return json({ error: 'no runs', slug }, 404);
    feats = feats.filter((f) => f.properties.depth_ft === usedDepth);
  }

  const minLen = Number(url.searchParams.get('min_len')) || 0;
  if (minLen) feats = feats.filter((f) => f.properties.length_m >= minLen);

  if (url.searchParams.get('routable') !== 'any') {
    // A run in a severed pocket is real water with a real contour that a boat cannot reach.
    feats = feats.filter((f) => f.properties.routable !== false);
  }

  const relief = url.searchParams.get('relief');
  if (relief) feats = feats.filter((f) => f.properties.relief === relief);

  // ?has=timber,hump — must PASS these, not be scored on them.
  const has = (url.searchParams.get('has') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (has.length) {
    feats = feats.filter((f) => {
      const c = f.properties.near_counts || {};
      return has.every((t) => (c[t] || 0) > 0);
    });
  }

  const near = parseNear(url.searchParams.get('near'));
  if (near) {
    const dist = (f) => {
      const co = f.geometry.coordinates;
      let best = Infinity;
      const step = Math.max(1, Math.floor(co.length / 40));
      for (let i = 0; i < co.length; i += step) {
        const d = metres(near.lon, near.lat, co[i][0], co[i][1]);
        if (d < best) best = d;
      }
      return best;
    };
    feats = feats.map((f) => ({ f, d: dist(f) })).sort((a, b) => a.d - b.d)
                 .map((x) => { x.f.properties._from_m = Math.round(x.d); return x.f; });
  }

  const limit = Math.min(Number(url.searchParams.get('limit')) || 10, 50);
  const legLen = Number(url.searchParams.get('len')) || 0;
  const out = feats.slice(0, limit).map((f) => {
    const p = f.properties;
    const row = {
      depth_ft: p.depth_ft, depth_dm: p.depth_dm, length_m: p.length_m,
      closed: !!p.closed, relief: p.relief || null, deepest_within_m: p.deepest_within_m ?? null,
      routable: p.routable !== false, passes: p.near_counts || {}, ledge_n: p.ledge_n || 0,
    };
    if (p._from_m !== undefined) row.from_m = p._from_m;
    if (legLen > 0) {
      // If the caller named feature types, put the leg where those features are. Otherwise put
      // it nearest the launch point.
      let startS;
      if (has.length) {
        const ev = (p.near || []).filter((e) => has.includes(e.t)).map((e) => e.s).sort((x, y) => x - y);
        let bestN = 0;
        for (let i = 0; i < ev.length; i++) {
          let j = i;
          while (j < ev.length && ev[j] - ev[i] <= legLen) j++;
          if (j - i > bestN) { bestN = j - i; startS = Math.max(0, ev[i] - legLen * 0.15); }
        }
      }
      const leg = sliceLeg(f, near, legLen, startS);
      row.leg = { requested_m: legLen, length_m: leg.length_m, coordinates: leg.coords };
      row.leg.passes = legInventory(f, leg.coords);
      if (startS !== undefined) row.leg.positioned_for = has;
    } else {
      row.coordinates = f.geometry.coordinates;
    }
    return row;
  });
  return json({
    slug,
    requested_depth_ft: Number.isFinite(wantDepth) ? wantDepth : null,
    depth_ft: usedDepth,
    note: usedDepth !== null && Number.isFinite(wantDepth) && usedDepth !== wantDepth
      ? `contours are metric-derived; nearest charted line to ${wantDepth} ft is ${usedDepth} ft`
      : undefined,
    matched: feats.length, returned: out.length, runs: out,
  });
}

async function handleFeatures(env, slug, url) {
  const doc = await packJson(env, slug, 'water_features.geojson');
  if (!doc) return json({ error: 'no water_features for this water', slug }, 404);
  let feats = doc.features || [];
  const kinds = (url.searchParams.get('kind') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (kinds.length) feats = feats.filter((f) => kinds.includes(f.properties.kind));
  const relief = url.searchParams.get('relief');
  if (relief) feats = feats.filter((f) => f.properties.relief === relief);
  const near = parseNear(url.searchParams.get('near'));
  const radius = Number(url.searchParams.get('radius')) || 0;
  if (near) {
    feats = feats.map((f) => {
      const c = f.geometry.coordinates;
      return { f, d: metres(near.lon, near.lat, c[0], c[1]) };
    });
    if (radius) feats = feats.filter((x) => x.d <= radius);
    feats = feats.sort((a, b) => a.d - b.d).map((x) => {
      x.f.properties._from_m = Math.round(x.d);
      return x.f;
    });
  }
  const limit = Math.min(Number(url.searchParams.get('limit')) || 25, 200);
  return json({ slug, matched: feats.length, features: feats.slice(0, limit) });
}

function nearestNode(g, lon, lat) {
  let bi = -1, bd = Infinity;
  for (let i = 0; i < g.nn; i++) {
    const d = metres(lon, lat, g.lon[i], g.lat[i]);
    if (d < bd) { bd = d; bi = i; }
  }
  return { i: bi, d: bd };
}

/** Shortest path over navigable water. Returns {distance_m, coordinates} or null if unreachable. */
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
      if (minDepth && g.depth[v] < minDepth) continue;
      const w = metres(g.lon[u], g.lat[u], g.lon[v], g.lat[v]);
      if (d + w < dist[v]) { dist[v] = d + w; prev[v] = u; push(d + w, v); }
    }
  }
  if (!Number.isFinite(dist[bi])) return null;
  const path = [];
  for (let u = bi; u !== -1; u = prev[u]) path.push([Number(g.lon[u].toFixed(6)), Number(g.lat[u].toFixed(6))]);
  path.reverse();
  return { distance_m: Math.round(dist[bi]), coordinates: path };
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
 * Shortest path, relaxing `minDepth` rather than failing when it makes the water impassable.
 *
 * `depth` on a graph node is the deepest MAR layer that contains the cell, quantised to
 * 0/3/6/9/12/15/18/24/30 ft. On Wateree 3,979 of 8,896 nodes are tagged 0, so asking for
 * `min_depth_ft: 3` discards 45% of the graph — and a launch ramp is in shallow water by
 * definition, so the boat cannot even leave the bank. Treated as a hard constraint it turns a
 * perfectly ordinary request into "no route", with an error blaming a severed graph.
 *
 * So the depth is a preference: try to honour it, and if that leaves no path at all, route
 * anyway and SAY the constraint was dropped. A plan that quietly ignores the request is as bad
 * as one that fails; a plan that says "I could not keep you in 3 ft, here is the route" is
 * what a person actually wants.
 */
function pathPreferringDepth(g, ai, bi, minDepth) {
  if (minDepth > 0) {
    const p = shortestPath(g, ai, bi, minDepth);
    if (p) return { ...p, min_depth_held: true };
  }
  const p = shortestPath(g, ai, bi, 0);
  if (!p) return null;
  return { ...p, min_depth_held: minDepth > 0 ? false : undefined };
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
    distance_m: p.distance_m,
    straight_line_m: Math.round(straight),
    detour_ratio: straight > 0 ? Number((p.distance_m / straight).toFixed(2)) : null,
    vertices: p.coordinates.length,
    coordinates: p.coordinates,
  });
}

/**
 * POST /water/{slug}/plan — build a whole trip as legs chained on the water graph.
 *
 * THIS IS THE FIX FOR ALL THREE OF THE ORIGINAL SMART PLAN FAILURES, and it is worth being
 * explicit about which line does which, because they were one root cause wearing three faces:
 * SmartPlan had a list of points and no model of the water.
 *
 *   "it wouldn't actually follow a contour"
 *       -> a fishing leg IS a slice of a stitched contour polyline. Not waypoints that a line
 *          is drawn between afterwards -- the charted line itself is the route.
 *
 *   "we couldn't get it to figure out how to leave us in the right position for the next leg"
 *       -> every leg starts at the node the previous leg ENDED on. `cur` below is threaded
 *          through the loop and is the only place a leg may begin. The old behaviour is not
 *          discouraged here, it is unrepresentable.
 *
 *   "it would reset back to no where near where it left off and then draw a connecting route
 *    over land"
 *       -> the connection between legs is a shortest path over the navigable-water graph, so it
 *          cannot cross land by construction. And the whole plan is re-checked at the end: if
 *          any vertex of any step is further than `off_water_m` from the mesh, the plan is
 *          returned with `valid: false` rather than handed over quietly.
 *
 * The two-pass up-and-back limit was a workaround for not being able to check any of this. It
 * is gone; ask for as many legs as you want.
 *
 * Request:
 *   { launch: [lon,lat],
 *     legs: [ { depth_ft: 12, length_m: 2000, has: ["timber"], relief: "channel_edge",
 *               closed: false } ],
 *     return_to_launch: true, max_total_m: 25000, min_depth_ft: 3 }
 *
 * The caller supplies INTENT -- depth, length, what the water should have on it. It does not
 * supply geometry, and this endpoint does not score: `has` is a filter, not a ranking. Which
 * structure matters depends on species, season and forage, and that lives in the app's
 * trollingIntelligence.
 */
async function handlePlan(env, slug, request) {
  const g = await graph(env, slug);
  if (!g) return json({ error: 'no water graph for this water', slug }, 404);
  const doc = await packJson(env, slug, 'trolling_runs.geojson');
  if (!doc) return json({ error: 'no trolling_runs for this water', slug }, 404);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'body must be JSON' }, 400); }
  const launch = body && body.launch;
  if (!Array.isArray(launch) || launch.length < 2 || !launch.every(Number.isFinite)) {
    return json({ error: 'launch must be [lon, lat]' }, 400);
  }
  const want = Array.isArray(body.legs) ? body.legs.slice(0, 12) : [];
  if (!want.length) return json({ error: 'legs must be a non-empty array' }, 400);
  const minDepth = Number(body.min_depth_ft) || 0;
  // Straightening index. Fetched once per plan; false when the pack has no boundary,
  // in which case waterPath() returns the raw graph path unchanged.
  const clearance = Number.isFinite(Number(body.clearance_m))
    ? Math.max(0, Number(body.clearance_m)) : CLEARANCE_DEFAULT_M;
  const bidx = await boundaryIndex(env, slug);
  const maxTotal = Number(body.max_total_m) || Infinity;
  // Derived from this lake's own mesh unless the caller overrides it — see graph().
  const offWaterM = Number(body.off_water_m) || g.offWaterM;

  const all = (doc.features || []).filter((f) => f.properties.routable !== false);
  const steps = [];
  const used = new Set();
  let cur = launch;
  let curNode = nearestNode(g, launch[0], launch[1]);
  let total = 0, fishing = 0, transit = 0;
  const notes = [];
  const relaxed = new Set();

  for (let li = 0; li < want.length; li++) {
    const spec = want[li] || {};
    const legLen = Number(spec.length_m) || 1500;

    // Resolve the intent to candidate water.
    let cand = all;
    let usedDepth = null;
    if (Number.isFinite(Number(spec.depth_ft))) {
      const target = Number(spec.depth_ft);
      let best = Infinity;
      for (const f of cand) {
        const d = Math.abs(f.properties.depth_ft - target);
        if (d < best) { best = d; usedDepth = f.properties.depth_ft; }
      }
      if (usedDepth !== null) {
        cand = cand.filter((f) => f.properties.depth_ft === usedDepth);
        if (usedDepth !== target) {
          notes.push(`leg ${li + 1}: contours are metric-derived; nearest charted line to `
                   + `${target} ft is ${usedDepth} ft`);
        }
      }
    }
    if (spec.relief) cand = cand.filter((f) => f.properties.relief === spec.relief);
    if (typeof spec.closed === 'boolean') cand = cand.filter((f) => !!f.properties.closed === spec.closed);
    const has = Array.isArray(spec.has) ? spec.has : [];
    if (has.length) {
      cand = cand.filter((f) => {
        const c = f.properties.near_counts || {};
        return has.every((t) => (c[t] || 0) > 0);
      });
    }
    cand = cand.filter((f) => f.properties.length_m >= legLen * 0.5);
    if (!cand.length) {
      return json({ error: `leg ${li + 1}: no water matches that request`, slug,
                    tried: spec, steps_built: steps.length }, 422);
    }

    // Nearest to where the LAST leg left the boat -- not to the launch. This is the whole
    // point: position carries forward.
    const scored = cand.map((f) => {
      const co = f.geometry.coordinates;
      const step = Math.max(1, Math.floor(co.length / 30));
      let bd = Infinity, bi = 0;
      for (let i = 0; i < co.length; i += step) {
        const d = metres(cur[0], cur[1], co[i][0], co[i][1]);
        if (d < bd) { bd = d; bi = i; }
      }
      return { f, d: bd, i: bi };
    }).sort((a, b) => a.d - b.d);

    const pick = scored.find((s) => !used.has(s.f)) || scored[0];
    used.add(pick.f);

    // Where on the run to start: at the requested features if any were named, else nearest.
    let startS;
    if (has.length) {
      const ev = (pick.f.properties.near || []).filter((e) => has.includes(e.t))
                   .map((e) => e.s).sort((x, y) => x - y);
      let bestN = 0;
      for (let i = 0; i < ev.length; i++) {
        let j = i;
        while (j < ev.length && ev[j] - ev[i] <= legLen) j++;
        if (j - i > bestN) { bestN = j - i; startS = Math.max(0, ev[i] - legLen * 0.15); }
      }
    }
    const leg = sliceLeg(pick.f, { lon: cur[0], lat: cur[1] }, legLen, startS);
    if (leg.coords.length < 2) {
      return json({ error: `leg ${li + 1}: run too short to slice`, slug }, 422);
    }
    const legStart = leg.coords[0];
    const legEnd = leg.coords[leg.coords.length - 1];

    // Transit from where we are to the head of the leg, over water.
    const sn = nearestNode(g, legStart[0], legStart[1]);
    if (curNode.i !== sn.i) {
      const p = waterPath(g, curNode.i, sn.i, minDepth, bidx, clearance);
      if (!p) return json({ ...UNREACHABLE, slug, at: `transit to leg ${li + 1}`,
                            steps_built: steps.length }, 422);
      if (p.min_depth_held === false && !relaxed.has(li + 1)) {
        relaxed.add(li + 1);
        notes.push(`leg ${li + 1}: could not hold ${minDepth} ft minimum on the way in — `
                 + `routed through shallower water`);
      }
      steps.push({ type: 'transit', length_m: p.distance_m,
                   min_depth_held: p.min_depth_held, coordinates: p.coordinates });
      total += p.distance_m; transit += p.distance_m;
    }

    steps.push({
      type: 'troll', leg: li + 1,
      depth_ft: pick.f.properties.depth_ft,
      depth_dm: pick.f.properties.depth_dm,
      relief: pick.f.properties.relief || null,
      deepest_within_m: pick.f.properties.deepest_within_m ?? null,
      closed: !!pick.f.properties.closed,
      requested_m: legLen, length_m: leg.length_m,
      passes: legInventory(pick.f, leg.coords),
      positioned_for: has.length ? has : undefined,
      coordinates: leg.coords,
    });
    total += leg.length_m; fishing += leg.length_m;

    cur = legEnd;
    curNode = nearestNode(g, legEnd[0], legEnd[1]);
    if (total > maxTotal) {
      notes.push(`stopped after leg ${li + 1}: ${Math.round(total)} m exceeds max_total_m`);
      break;
    }
  }

  if (body.return_to_launch) {
    const ln = nearestNode(g, launch[0], launch[1]);
    if (curNode.i !== ln.i) {
      const p = waterPath(g, curNode.i, ln.i, minDepth, bidx, clearance);
      if (!p) return json({ ...UNREACHABLE, slug, at: 'return to launch',
                            steps_built: steps.length }, 422);
      if (p.min_depth_held === false) notes.push(`return to launch: could not hold ${minDepth} ft minimum`);
      steps.push({ type: 'transit', to: 'launch', length_m: p.distance_m,
                   min_depth_held: p.min_depth_held, coordinates: p.coordinates });
      total += p.distance_m; transit += p.distance_m;
    }
  }

  // Validate the WHOLE plan, not each piece as it was made.
  //
  // The two step kinds need different tests, and conflating them fails good plans. A TRANSIT is
  // a sequence of graph edges: each edge is a MAR portal between two adjacent navmesh cells, so
  // the straight line between those two cell centroids lies inside the union of two cells
  // Garmin has already called navigable. Densifying it and measuring back to the nearest node
  // just rediscovers that mesh cells are large — a 1 km edge in open water has a midpoint 500 m
  // from either end, and the first version of this check failed 181 points that way on a plan
  // that was entirely over water.
  //
  // A TROLL leg is different: it is contour geometry that was never asserted to be navigable,
  // only to be at a depth. That is the one that has to be densified and checked.
  // FIRST: the seams between steps. Every leg is supposed to start where the last one ended —
  // that is the entire fix for "it would reset back to no where near where it left off" — but
  // nothing checked it, because each step was validated on its own. A leg whose head is far
  // from any graph node snaps to the nearest one, and the gap between the transit's end and
  // the leg's start is a hole the boat is expected to teleport across. Offline `routable`
  // usually hides it; when it does not, silence is the worst possible answer.
  let worstSeam = 0;
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1].coordinates;
    const cur = steps[i].coordinates;
    if (!prev.length || !cur.length) continue;
    const e = prev[prev.length - 1];
    const seam = metres(e[0], e[1], cur[0][0], cur[0][1]);
    if (seam > worstSeam) worstSeam = seam;
  }

  let checked = 0, off = 0;
  for (const s of steps) {
    const co = s.coordinates;
    if (s.type === 'transit') {
      for (const p of co) { checked++; if (nearestNode(g, p[0], p[1]).d > offWaterM) off++; }
      continue;
    }
    for (let i = 1; i < co.length; i++) {
      const segLen = metres(co[i - 1][0], co[i - 1][1], co[i][0], co[i][1]);
      const n = Math.max(1, Math.ceil(segLen / 60));
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const lon = co[i - 1][0] + (co[i][0] - co[i - 1][0]) * t;
        const lat = co[i - 1][1] + (co[i][1] - co[i - 1][1]) * t;
        checked++;
        if (nearestNode(g, lon, lat).d > offWaterM) off++;
      }
    }
  }

  // A plan can be geometrically perfect and still not worth doing. The first version of this
  // returned 51.6 km of paddling for 4.3 km of fishing — every leg valid, every transit over
  // water, and nobody would run it in a kayak. Legs are chosen nearest to where the last one
  // ended, which is the right rule for continuity and says nothing about what the trip costs.
  // Surfaced rather than silently "optimised": the caller knows whether it has a trolling motor
  // and how long it has, and can re-ask with max_total_m or a looser `has`.
  if (worstSeam > offWaterM) {
    notes.push(`a ${Math.round(worstSeam)} m gap sits between two steps — a leg was placed on `
             + `water the graph cannot reach. The plan is returned so it can be inspected, but `
             + `it is NOT continuous; check that pack's water_graph and its runs' routable flag.`);
  }
  if (fishing > 0 && transit > fishing * 2) {
    notes.push(`${Math.round(transit / 1000)} km of transit for ${Math.round(fishing / 1000)} km `
             + `of fishing — the water matching this request is a long way from the launch. `
             + `Loosen the filters, or set max_total_m.`);
  }

  return json({
    slug,
    valid: off === 0 && worstSeam <= offWaterM,
    total_m: Math.round(total), fishing_m: Math.round(fishing), transit_m: Math.round(transit),
    fishing_fraction: total > 0 ? Number((fishing / total).toFixed(2)) : null,
    legs: steps.filter((s) => s.type === 'troll').length,
    validation: { points_checked: checked, off_water: off, threshold_m: offWaterM,
                  threshold_source: Number(body.off_water_m) ? 'caller' : 'half the p99 mesh edge',
                  // The largest jump between the end of one step and the start of the next.
                  // Should be a handful of metres; anything near the threshold means a leg was
                  // placed on water the graph does not reach.
                  worst_seam_m: Math.round(worstSeam) },
    notes: notes.length ? notes : undefined,
    steps,
  });
}

/** Returns a Response, or null if the path is not ours. */
export async function handleWaterRoute(request, env, url) {
  const mm = url.pathname.match(/^\/water\/([^/]+)\/(runs|features|route|plan)$/);
  if (!mm) return null;
  const slug = mm[1];
  const what = mm[2];
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  try {
    if (what === 'runs' && request.method === 'GET') return await handleRuns(env, slug, url);
    if (what === 'features' && request.method === 'GET') return await handleFeatures(env, slug, url);
    if (what === 'route' && request.method === 'POST') return await handleRoute(env, slug, request);
    if (what === 'plan'  && request.method === 'POST') return await handlePlan(env, slug, request);
  } catch (e) {
    return json({ error: String(e && e.message || e), slug, endpoint: what }, 500);
  }
  return json({ error: 'method not allowed' }, 405);
}

export const WATER_ROUTES = [
  '/water/<slug>/runs?depth=&near=lat,lon&len=&relief=&has=&min_len=&limit=',
  '/water/<slug>/features?near=lat,lon&kind=point,cove,creek_mouth&radius=&limit=',
  'POST /water/<slug>/route  {from:[lon,lat], to:[lon,lat], min_depth_ft?}',
  'POST /water/<slug>/plan   {launch:[lon,lat], legs:[{depth_ft,length_m,has?,relief?}], return_to_launch?}',
];
