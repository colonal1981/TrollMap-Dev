/**
 * water-graph.js — the pack's water graph, read in the browser, for distances one-to-many.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY IN THE BROWSER. Item 24 needs the water distance from the ramp to every leg the list might
 * offer, and between the offered legs. The Worker answers that (/water/{slug}/distances), but it is
 * on Cloudflare's free plan -- 10 ms of CPU a request (NOTHING_WAS_THROWN_AWAY..._2026-09-16.md) --
 * and a Dijkstra over Lake Murray's 118,090 nodes is far more than that. Measured 2026-09-26: single
 * calls mostly got through, and a table of 8, 16 or 24 sources came back "Worker exceeded resource
 * limits" at random. The plan already downloads the pack (38 MB of trolling runs on Murray); the
 * graph is 4.5 MB more, and in the browser the same search costs tens of milliseconds and no limit.
 *
 * The Worker keeps /route for the transits themselves, whose line it straightens against the shore.
 * This file only answers "how far", and reads the same TMWG v2 file the same way Worker/water.js
 * does: node lon/lat as int32 x1e7, edges as u32 pairs, one depth byte per node.
 */

// 'TMWG' read little-endian -- see the note on MAGIC in Worker/water.js for why it is not 0x474d5754.
const MAGIC = 0x47574d54;
// Longer than any route on any water this app carries, so a shallow metre outranks every saving in
// distance: the same lexicographic pricing Worker/water.js uses (fewest shallow metres, then
// shortest), so a distance here is the length of the path /route would take.
const PENALTY = 1e6;

const RAD = Math.PI / 180;
function metres(ax, ay, bx, by) {
  const dx = (bx - ax) * 111320 * Math.cos(((ay + by) / 2) * RAD);
  const dy = (by - ay) * 110570;
  return Math.hypot(dx, dy);
}

/** Parse water_graph.bin. Null on anything that is not a TMWG graph. */
export function parseWaterGraph(buf) {
  if (!buf || buf.byteLength < 16) return null;
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) return null;
  const nn = dv.getUint32(8, true);
  const ne = dv.getUint32(12, true);
  if (16 + nn * 8 + ne * 8 + nn > buf.byteLength) return null;
  const lon = new Float64Array(nn);
  const lat = new Float64Array(nn);
  let o = 16;
  for (let i = 0; i < nn; i++, o += 8) {
    lon[i] = dv.getInt32(o, true) / 1e7;
    lat[i] = dv.getInt32(o + 4, true) / 1e7;
  }
  const deg = new Uint32Array(nn);
  const eo = o;
  for (let e = 0; e < ne; e++, o += 8) {
    const a = dv.getUint32(o, true), b = dv.getUint32(o + 4, true);
    if (a < nn && b < nn) { deg[a]++; deg[b]++; }
  }
  const depth = new Uint8Array(buf, o, nn).slice();
  const head = new Uint32Array(nn + 1);
  for (let i = 0; i < nn; i++) head[i + 1] = head[i] + deg[i];
  const adj = new Uint32Array(head[nn]);
  const fill = head.slice(0, nn);
  const lens = [];
  for (let e = 0, p = eo; e < ne; e++, p += 8) {
    const a = dv.getUint32(p, true), b = dv.getUint32(p + 4, true);
    if (a < nn && b < nn) {
      adj[fill[a]++] = b; adj[fill[b]++] = a;
      if (lens.length < 2000) lens.push(metres(lon[a], lat[a], lon[b], lat[b]));
    }
  }
  // THE INDEX CELL IS THE MESH'S OWN SCALE, the median of the first edges, so a cell holds about one
  // node on any graph. It sets how fast the nearest-node search runs, never what it finds.
  lens.sort((x, y) => x - y);
  const cellM = Math.max(1, lens.length ? lens[lens.length >> 1] : 50);
  return { nn, lon, lat, depth, head, adj, cellM };
}

/** A nearest-node finder over the graph: exact, by expanding rings of cells. */
export function nodeIndex(g) {
  if (!g || !g.nn) return () => ({ i: -1, d: Infinity });
  const lat0 = g.lat[0];
  const cx = g.cellM / (111320 * Math.cos(lat0 * RAD));
  const cy = g.cellM / 110570;
  const cells = new Map();
  const cellKey = (ix, iy) => ix * 4194304 + iy;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < g.nn; i++) {
    const ix = Math.floor(g.lon[i] / cx), iy = Math.floor(g.lat[i] / cy);
    if (ix < x0) x0 = ix; if (ix > x1) x1 = ix; if (iy < y0) y0 = iy; if (iy > y1) y1 = iy;
    const k = cellKey(ix, iy);
    let list = cells.get(k);
    if (!list) cells.set(k, (list = []));
    list.push(i);
  }
  const look = (ix, iy, lon, lat, best) => {
    const list = cells.get(cellKey(ix, iy));
    if (!list) return;
    for (const i of list) {
      const d = metres(lon, lat, g.lon[i], g.lat[i]);
      if (d < best.d) { best.d = d; best.i = i; }
    }
  };
  return (lon, lat) => {
    const ix = Math.floor(lon / cx), iy = Math.floor(lat / cy);
    const best = { i: -1, d: Infinity };
    // Ring r is the cells at Chebyshev distance r. Once the nearest node found is closer than any
    // cell of the next ring could be, nothing further out can beat it. And no ring past the one that
    // reaches every cell of the graph can hold anything.
    const far = Math.max(Math.abs(ix - x0), Math.abs(ix - x1), Math.abs(iy - y0), Math.abs(iy - y1));
    for (let r = 0; r <= far; r++) {
      if (best.i >= 0 && (r - 1) * g.cellM > best.d) break;
      if (r === 0) { look(ix, iy, lon, lat, best); continue; }
      for (let d = -r; d <= r; d++) {
        look(ix + d, iy - r, lon, lat, best);
        look(ix + d, iy + r, lon, lat, best);
        if (d > -r && d < r) {
          look(ix - r, iy + d, lon, lat, best);
          look(ix + r, iy + d, lon, lat, best);
        }
      }
    }
    return best;
  };
}

/** Real metres from node `ai` to every node, along the least-shallow path; Infinity where unreachable. */
export function distancesFromNode(g, ai, minDepth = 0) {
  const cost = new Float64Array(g.nn).fill(Infinity);
  const real = new Float64Array(g.nn).fill(Infinity);
  cost[ai] = 0; real[ai] = 0;
  let hk = new Float64Array(1024), hv = new Int32Array(1024), n = 0;
  const push = (d, i) => {
    if (n === hk.length) {
      const k2 = new Float64Array(n * 2); k2.set(hk); hk = k2;
      const v2 = new Int32Array(n * 2); v2.set(hv); hv = v2;
    }
    let c = n++;
    hk[c] = d; hv[c] = i;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (hk[p] <= hk[c]) break;
      const tk = hk[p]; hk[p] = hk[c]; hk[c] = tk;
      const tv = hv[p]; hv[p] = hv[c]; hv[c] = tv;
      c = p;
    }
  };
  push(0, ai);
  while (n) {
    const d = hk[0], u = hv[0];
    n -= 1;
    if (n) {
      hk[0] = hk[n]; hv[0] = hv[n];
      let c = 0;
      for (;;) {
        const l = c * 2 + 1, r = l + 1;
        let s = c;
        if (l < n && hk[l] < hk[s]) s = l;
        if (r < n && hk[r] < hk[s]) s = r;
        if (s === c) break;
        const tk = hk[s]; hk[s] = hk[c]; hk[c] = tk;
        const tv = hv[s]; hv[s] = hv[c]; hv[c] = tv;
        c = s;
      }
    }
    if (d > cost[u]) continue;
    for (let e = g.head[u]; e < g.head[u + 1]; e++) {
      const v = g.adj[e];
      const w = metres(g.lon[u], g.lat[u], g.lon[v], g.lat[v]);
      const c = (minDepth && g.depth[v] < minDepth) ? w * PENALTY : w;
      if (d + c < cost[v]) { cost[v] = d + c; real[v] = real[u] + w; push(d + c, v); }
    }
  }
  return real;
}

/**
 * The same asker shape as waterDistances() in smart-plan-v2.js -- `(from, points) => metres[]` with
 * a `.matrix(sources, points)` -- answered locally. One full search per distinct source, kept for
 * the rest of the plan; metres are node to node plus both snaps, so never below the straight line.
 */
export function localWaterDistances(g, opts = {}) {
  if (!g || !g.nn) return null;
  const minDepth = Number(opts.minDepthFt) || 0;
  const near = nodeIndex(g);
  const fields = new Map();
  // Kept as float32: a metre in a hundred kilometres is well inside its precision, at half the
  // memory -- 25 fields on Murray is 12 MB rather than 24.
  const fieldAt = (i) => {
    let f = fields.get(i);
    if (!f) { f = Float32Array.from(distancesFromNode(g, i, minDepth)); fields.set(i, f); }
    return f;
  };
  const ask = async (from, pts) => {
    const a = near(from[0], from[1]);
    if (a.i < 0) return pts.map(() => null);
    const f = fieldAt(a.i);
    return pts.map((p) => {
      const b = near(p[0], p[1]);
      return b.i >= 0 && Number.isFinite(f[b.i]) ? f[b.i] + a.d + b.d : null;
    });
  };
  ask.matrix = async (sources, pts) => Promise.all(sources.map((s) => ask(s, pts)));
  // SYNCHRONOUS, for a caller that has to answer inside a loop that cannot await --
  // selectCandidates() prices every window of every run through `transitM(a, b)`. One search per
  // source, then a nearest-node lookup per point.
  ask.fieldFrom = (from) => {
    const a = near(from[0], from[1]);
    if (a.i < 0) return () => null;
    const f = fieldAt(a.i);
    return (p) => {
      const b = near(p[0], p[1]);
      return b.i >= 0 && Number.isFinite(f[b.i]) ? f[b.i] + a.d + b.d : null;
    };
  };
  return ask;
}
