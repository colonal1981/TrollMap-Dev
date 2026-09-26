// THE WATER GRAPH IS SEARCHED IN THE BROWSER.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Item 24. The Worker is on Cloudflare's free plan, 10 ms of CPU a request, and on Lake Murray
// (118,090 nodes) tables of 8, 16 and 24 sources from /distances came back "Worker exceeded
// resource limits" at random. js/utils/water-graph.js reads the same water_graph.bin the same way
// and searches it here. Measured on the live Murray pack: the same four distances as the Worker to
// the metre, and the ranking in 1.3 s against 26 s for the Worker loop, with the same dozen legs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWaterGraph, nodeIndex, distancesFromNode, localWaterDistances } from '../js/utils/water-graph.js';
import { selectByWater } from '../js/modules/smart-plan-v2.js';
import { selectCandidates, metresBetween } from '../js/modules/plan-candidates.js';

// A TMWG v2 file: a chain of nodes along a line, depth 9 ft unless told otherwise.
function tmwg(nodes, edges, depths) {
  const n = nodes.length, e = edges.length;
  const buf = new ArrayBuffer(16 + n * 8 + e * 8 + n);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x47574d54, true);
  dv.setUint8(4, 2);
  dv.setUint32(8, n, true); dv.setUint32(12, e, true);
  nodes.forEach(([x, y], i) => {
    dv.setInt32(16 + i * 8, Math.round(x * 1e7), true);
    dv.setInt32(16 + i * 8 + 4, Math.round(y * 1e7), true);
  });
  let o = 16 + n * 8;
  for (const [a, b] of edges) { dv.setUint32(o, a, true); dv.setUint32(o + 4, b, true); o += 8; }
  new Uint8Array(buf, o, n).set(depths || nodes.map(() => 9));
  return buf;
}

// A "U": down the west side, across the bottom, up the east side. The two tops are 1 km apart by crow
// and about 5 km apart by water -- the Hilton cove, drawn small.
const U = [];
for (let i = 0; i <= 20; i++) U.push([-81.330, 34.100 - i * 0.001]);      // west arm, north to south
for (let i = 1; i <= 10; i++) U.push([-81.330 + i * 0.0011, 34.080]);     // across the bottom
for (let i = 1; i <= 20; i++) U.push([-81.319, 34.080 + i * 0.001]);      // east arm, south to north
const EDGES = U.slice(1).map((_, i) => [i, i + 1]);

test('parses a TMWG graph and refuses anything else', () => {
  const g = parseWaterGraph(tmwg(U, EDGES));
  assert.equal(g.nn, U.length);
  assert.equal(g.adj.length, EDGES.length * 2);
  assert.ok(g.cellM > 80 && g.cellM < 130, `the index cell is the mesh's own scale: ${g.cellM}`);
  assert.equal(parseWaterGraph(new ArrayBuffer(8)), null);
  const bad = tmwg(U, EDGES); new DataView(bad).setUint32(0, 0x474d5754, true);
  assert.equal(parseWaterGraph(bad), null, 'the byte-reversed magic is not a graph');
});

test('the nearest node is found exactly, near or far', () => {
  const g = parseWaterGraph(tmwg(U, EDGES));
  const near = nodeIndex(g);
  for (const [k, p] of [[0, [-81.3301, 34.1001]], [25, [-81.3245, 34.0795]], [50, [-81.3189, 34.1003]]]) {
    let best = -1, bd = Infinity;
    U.forEach((q, i) => { const d = metresBetween(p, q); if (d < bd) { bd = d; best = i; } });
    assert.equal(near(p[0], p[1]).i, best, `point ${k}`);
  }
  assert.equal(near(-81.20, 34.30).i >= 0, true, 'a point far off the graph still finds its nearest');
});

test('distances follow the water, and shallow water is priced the way /route prices it', () => {
  const g = parseWaterGraph(tmwg(U, EDGES));
  const f = distancesFromNode(g, 0);
  const crow = metresBetween(U[0], U[U.length - 1]);
  assert.ok(f[U.length - 1] > crow * 4, `around the U, not across it: ${Math.round(f[U.length - 1])} vs ${Math.round(crow)}`);
  // A short cut across the top, but 2 ft deep: with a 6 ft floor the long way round wins.
  const cut = parseWaterGraph(tmwg(U, [...EDGES, [0, U.length - 1]],
                                    U.map((_, i) => (i === 0 || i === U.length - 1 ? 2 : 9))));
  assert.ok(distancesFromNode(cut, 0, 0)[U.length - 1] < 1100, 'no floor: straight across');
  assert.ok(distancesFromNode(cut, 1, 6)[U.length - 2] > crow * 4, 'a 6 ft floor: around, not across the shoal');
});

test('the local asker answers like the Worker: snaps included, never below the straight line', async () => {
  const ask = localWaterDistances(parseWaterGraph(tmwg(U, EDGES)));
  const top = [-81.3300, 34.1000], other = [-81.3190, 34.1000];
  const [d] = await ask(top, [other]);
  assert.ok(d >= metresBetween(top, other));
  const field = ask.fieldFrom(top);
  assert.ok(Math.abs(field(other) - d) < 0.5, 'the synchronous field agrees with the async answer');
  const rows = await ask.matrix([top, other], [other, top]);
  assert.equal(rows.length, 2);
  assert.ok(Math.abs(rows[0][0] - rows[1][1]) < 1, 'the same water both ways');
});

test('selectByWater prices every window in one selection when the graph is local', async () => {
  // Two lanes: one just across the top of the U from the ramp (near by crow, far by water), one
  // down the ramp's own arm (farther by crow, nearer by water).
  const lane = (coords) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
    properties: { depth_ft: 20, length_m: 1200, routable: true, relief: 'flat', fitted: true, shallowest_ft: 14,
                  near: [{ s: 200, t: 'point', d: 25 }, { s: 800, t: 'point', d: 25 }] } });
  const across = lane(Array.from({ length: 12 }, (_, k) => [-81.3190, 34.0995 - k * 0.001]));
  const down = lane(Array.from({ length: 12 }, (_, k) => [-81.3300, 34.0880 - k * 0.0005]));
  const RAMP = [-81.3300, 34.1000];
  const OPTS = { ramp: RAMP, slug: 'u', fishDepthFt: [0, 99], holding: 'bottom', usableAh: 999, windowMin: 9999, limit: 1 };
  const crow = selectCandidates([across, down], OPTS);
  assert.equal(crow[0].runIndex, 0, 'by crow, the lane across the top');
  const ask = localWaterDistances(parseWaterGraph(tmwg(U, EDGES)));
  const wet = await selectByWater([across, down], OPTS, { ramp: RAMP, distancesFrom: ask });
  assert.equal(wet.byWater.local, true);
  assert.equal(wet.byWater.selections, 1);
  assert.equal(wet[0].runIndex, 1, 'by water, the lane down his own arm');
});
