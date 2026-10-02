// Personal use only, not for distribution or resale; not for navigation.
//
// A HOP WHOSE ENDS SNAP TO ONE GRAPH NODE IS A ROUTED HOP.
//
// Lake Moultrie from Short Stay, 2026-10-02, the first plan on the rebuilt water graph: T5 (7 m),
// T6 (33 m) and T7 (20 m) were marked "a straight line, not a water-routed path -- it can cross
// land". /water/lake_moultrie/route had answered each with HTTP 200, one vertex and distance 0,
// because both ends snapped to the same node. waterRouter() read one vertex as no route.
//
//   node --test test/a-hop-inside-one-graph-node-is-routed.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { waterRouter, prefetchTransits } from '../js/modules/smart-plan-v2.js';

const A = [-79.990907, 33.245439], B = [-79.990831, 33.245421], NODE = [-79.99085, 33.24555];
const oneNode = async () => ({ ok: true, json: async () => ({ distance_m: 0, coordinates: [NODE],
  vertices: 1, shallow_m: 0, shallowest_ft: 27 }) });

test('the Worker\'s one-node answer comes back as the two ends joined to that node', async () => {
  globalThis.fetch = oneNode;
  try {
    const out = await waterRouter('https://w.example', 'lake_moultrie')(A, B);
    assert.ok(out, 'an answered route is not null');
    assert.deepEqual(out.coordinates, [A, NODE, B]);
  } finally { delete globalThis.fetch; }
});

test('and prefetchTransits keeps it, so the assembler never draws that hop as unrouted', async () => {
  globalThis.fetch = oneNode;
  try {
    const route = waterRouter('https://w.example', 'lake_moultrie');
    const lookup = await prefetchTransits([{ start: B, end: [-79.9899, 33.2460] }], A, route);
    assert.ok(lookup, 'something was routed');
    const p = lookup(A, B);
    assert.ok(p && p.coordinates.length === 3, 'the pair is in the lookup with its node');
    assert.equal(p.unrouted, undefined);
  } finally { delete globalThis.fetch; }
});

test('an empty answer is still no route', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ distance_m: 0, coordinates: [] }) });
  try {
    assert.equal(await waterRouter('https://w.example', 'lake_moultrie')(A, B), null);
  } finally { delete globalThis.fetch; }
});
