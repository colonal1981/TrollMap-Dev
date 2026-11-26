// Personal use only, not for distribution or resale; not for navigation.
//
// THE DAY GOES TO THE STEERING BOX ONE PIECE AT A TIME.
//
// Ryan, 2026-11-26: "route typically has been one lazy loop then there should be a way to choose to head to
// the next one". autopilot-route.js cuts the plan into its loops and the runs between them, by the runId
// the plan already puts on each loop's legs, and thins each piece to the box's 300 points.
import test from 'node:test';
import assert from 'node:assert/strict';

if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const { thin, dayPieces, routeCommands, metres, MAX_POINTS } = await import('../js/utils/autopilot-route.js');

const at = (eastM, northM) => [-80.38 + eastM / (111320 * Math.cos(33.9 * Math.PI / 180)), 33.9 + northM / 111320];
const line = (from, to, n) => Array.from({ length: n }, (_, i) => at(from[0] + ((to[0] - from[0]) * i) / (n - 1), from[1] + ((to[1] - from[1]) * i) / (n - 1)));

test('a straight stretch is two points, a bend is kept, a repeat is dropped', () => {
  const pts = [...line([0, 0], [500, 0], 100), ...line([500, 0], [500, 400], 80).slice(1)];
  pts.splice(10, 0, pts[10]);
  const out = thin(pts);
  assert.equal(out.length, 3);
  assert.ok(metres(out[1], at(500, 0)) < 1);
});

test("a loop's closing point is not sent (the box closes it) and a wiggly day fits in 300", () => {
  const ring = Array.from({ length: 2001 }, (_, i) => {
    const a = (i / 2000) * 2 * Math.PI;
    const r = 800 + 30 * Math.sin(a * 40);
    return at(r * Math.cos(a), r * Math.sin(a));
  });
  const out = thin(ring, { loop: true });
  assert.ok(out.length <= MAX_POINTS, `${out.length} points`);
  assert.ok(out.length > 100, 'the wiggles are kept, not cut to a circle');
  assert.ok(metres(out[0], out[out.length - 1]) > 5);
});

test('the day is its loops and the runs between them, in order', () => {
  const ramp = [0, 0];
  const legs = [
    { id: 'a', type: 'transit', coordinates: line(ramp, [0, 300], 5) },
    { id: 'b', type: 'troll', runId: 'x#loop1-out', coordinates: line([0, 300], [400, 600], 5) },
    { id: 'c', type: 'transit', coordinates: line([400, 600], [420, 620], 2) },
    { id: 'd', type: 'troll', runId: 'x#loop1-back', coordinates: line([420, 620], [0, 300], 5) },
    { id: 'e', type: 'transit', coordinates: line([0, 300], [-500, 900], 5) },
    { id: 'f', type: 'troll', runId: 'x#loop2-out', coordinates: line([-500, 900], [-900, 1200], 5) },
    { id: 'g', type: 'troll', runId: 'x#loop2-back', coordinates: line([-900, 1200], [-500, 900], 5) },
    { id: 'h', type: 'transit', role: 'return', coordinates: line([-500, 900], ramp, 5) },
  ];
  const p = dayPieces({ legs });
  assert.deepEqual(p.map((q) => q.name), ['Run to loop 1', 'Loop 1', 'Run to loop 2', 'Loop 2', 'The way home']);
  assert.deepEqual(p[1].legIds, ['b', 'c', 'd']);
  assert.deepEqual(p.map((q) => q.kind), ['run', 'loop', 'run', 'loop', 'run']);
  assert.ok(Math.abs(p[0].lengthM - 300) < 2);
});

test('a route goes in as clear, points, loop, and a question', () => {
  const c = routeCommands([[-80.38016, 33.91829], [-80.381, 33.919]], { loop: true });
  assert.deepEqual(c, ['Q', 'W33.918290,-80.380160;', 'W33.919000,-80.381000;', 'J', 'V']);
  assert.ok(c[1].length - 2 <= 31, 'the box reads 31 characters between W and ;');
  assert.deepEqual(routeCommands([[-80.38, 33.9], [-80.39, 33.91]]).slice(-1), ['V']);
});
