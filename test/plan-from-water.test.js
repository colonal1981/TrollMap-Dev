import { describe, it, expect } from './expect-shim.mjs';
import { planFromWater } from '../js/modules/plan-from-water.js';
import { orientLegs } from '../js/modules/plan-candidates.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE SEAM BETWEEN A PICKED PIECE AND AN ASSEMBLED DAY
//
// Everything here exists because of one failure on 2026-08-11, live, the first time Ryan built a
// day from water he had ticked himself:
//
//     Failed: Cannot read properties of undefined (reading '1')
//     trollmap-worker.../water/wateree_lake/route  400  (x8)
//
// The cause was a single omission in legFrom(): it computed both ends of the leg for the ramp
// transits and never put them on the object. orientLegs() is documented to take `{start, end}[]`,
// so every leg arrived unoriented; the assembler asked the router to route to `undefined`, which
// the worker refused eight times; the cursor advanced to `undefined`; and metresBetween() finally
// threw on the run home, three modules from the missing field.
//
// 1,227 tests passed while that was true. None of them ever ran a piece through planFromWater()
// into assemblePlan(), which is the seam the whole Pick Water tab depends on. So these tests are
// deliberately end-to-end across it and assert on the SHAPE the next stage needs, not on the
// return value of the stage under test — a field that is merely absent is exactly what got
// through last time.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const RAMP = [-80.7107, 34.3486];

/** A picked piece in the shape offerWater() hands back. */
function piece(key, lon, lat, holdsFt) {
  const coords = Array.from({ length: 40 }, (_, i) => [lon + i * 0.0004, lat + i * 0.00012]);
  return {
    key, runId: `wateree_lake#${key}`, coords, lengthM: 1800, laneLengthM: 4000, holdsFt,
    near: [{ t: 'hump', s: 400, d: 12 }, { t: 'hazard', s: 900, d: 30 }],
    partners: [], reasons: { for: ['1.1 mi unbroken'], against: [] },
    envelope: Array(20).fill(holdsFt + 2), envelopeStepM: 90, chartedFrac: 1,
  };
}

const PICKED = [piece(81, -80.70, 34.35, 22), piece(87, -80.72, 34.38, 26), piece(51, -80.68, 34.31, 30)];

const MODEL = async () => JSON.stringify({
  loadout: { rods: [{ id: 'R1', lure: 'A-Rig', rig: 'fluoro' }, { id: 'R2', lure: 'Spoon', rig: 'snap' }] },
  deploy: Object.fromEntries(PICKED.map((p) => [p.runId, { port: 'R1', starboard: 'R2' }])),
  stops: [], changes: [],
});

const build = (extra = {}) => planFromWater({
  picked: PICKED, spots: [], ramp: RAMP, slug: 'wateree_lake', usableAh: 80, windowMin: 480,
  launchTime: '06:30', returnTime: '13:00', askModel: MODEL,
  planArgs: { water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-07-29',
              species: ['Striped Bass'], usableAh: 80, tackle: ['A-Rig'], conditions: {} },
  ...extra,
});

describe('a leg built from picked water carries both of its ends', () => {
  it('builds a day at all — the regression that shipped', async () => {
    const r = await build();
    expect(r.plan).toBeTruthy();
    expect(r.problems.length).toBe(0);
  });

  it('orientLegs can orient every leg, which it cannot without start and end', async () => {
    const r = await build();
    const troll = r.plan.legs.filter((l) => l.type !== 'transit');
    // The assembler destructures `{ start, end }` off orientLegs' answer. Feed it legs missing
    // those and it returns `{flipped}` alone — silently, because hop() guards with isArray.
    const facing = orientLegs(troll.map((l) => ({
      runId: l.runId, start: l.coordinates[0], end: l.coordinates[l.coordinates.length - 1],
    })), RAMP);
    expect(facing.length).toBe(troll.length);
    for (const f of facing) {
      expect(Array.isArray(f.start)).toBe(true);
      expect(Array.isArray(f.end)).toBe(true);
    }
  });
});

describe('the transit router is fetched ahead of the assembler, not called inside it', () => {
  it('asks the router for well-formed [lon,lat] pairs only', async () => {
    const asked = [];
    await build({ routeWater: async (from, to) => { asked.push([from, to]); return null; } });
    // Eight requests went out with `to: undefined` on 2026-08-11 and the worker answered 400 to
    // every one. A pair with an undefined end is the bug, so it is the assertion.
    expect(asked.length > 0).toBe(true);
    for (const [a, b] of asked) {
      expect(Array.isArray(a) && a.length === 2 && a.every(Number.isFinite)).toBe(true);
      expect(Array.isArray(b) && b.length === 2 && b.every(Number.isFinite)).toBe(true);
    }
  });

  it('uses the routed geometry when the router answers', async () => {
    const r = await build({
      routeWater: async (from, to) => ({
        distanceM: 900, coordinates: [from, [(from[0] + to[0]) / 2, from[1]], to],
      }),
    });
    const transits = r.plan.legs.filter((l) => l.type === 'transit');
    expect(transits.length > 0).toBe(true);
    expect(transits.every((l) => !l.unrouted)).toBe(true);
  });

  it('falls back to straight lines that MARK THEMSELVES when the pack has no water graph', async () => {
    const r = await build({ routeWater: async () => null });
    const transits = r.plan.legs.filter((l) => l.type === 'transit');
    expect(transits.length > 0).toBe(true);
    // Worse plan, not a broken one — and it says so. An unrouted transit that did not admit it
    // is the failure this whole path is written to avoid.
    expect(transits.every((l) => l.unrouted)).toBe(true);
  });

  it('never leaves a transit with an undefined distance', async () => {
    // Handing the ASYNC router straight to assemblePlan returns a Promise, which is truthy, so
    // the `|| straight(...)` fallback never fires and the leg ends up with distanceM undefined
    // and two points. It does not throw. It just quietly stops being a real transit.
    for (const extra of [{}, { routeWater: async () => null }]) {
      const r = await build(extra);
      for (const l of r.plan.legs.filter((x) => x.type === 'transit')) {
        expect(Number.isFinite(l.lengthM)).toBe(true);
        expect(l.coordinates.length >= 2).toBe(true);
      }
    }
  });
});
