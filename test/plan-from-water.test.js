import { describe, it, expect } from './expect-shim.mjs';
import { planFromWater } from '../js/modules/plan-from-water.js';
import { orientLegs } from '../js/modules/plan-candidates.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';
import { connectionFor } from '../js/data/lure-knowledge.js';

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

// THE SHAPE THE MODEL ACTUALLY RETURNS, WHICH IS NOT THE SHAPE THE ASSEMBLER CONSUMES.
//
// This fixture used to hand back a TOP-LEVEL `deploy` map, and it passed — because the code under
// test read `res.deploy` too. Both were wrong in the same direction, so the test was blind to it
// and Ryan found it on the water instead: nine legs, not one rod on any of them.
//
// The model returns `legs: [{runId, speedMph, deploy}]`. planArgsFrom() is what folds those into
// the `{[runId]: {port, starboard}}` map. A fixture that skips the real shape cannot catch a path
// that skips the real parser — so this one uses real lure names out of the real bag.
const LURES = ['3" Lipless Crankbait', 'Dr.Fish Diamond Jig / Jigging Spoon 1oz'];

const MODEL = async () => JSON.stringify({
  loadout: { rods: [{ id: 'R1', lure: LURES[0], role: 'troll', leadFt: 80 },
                    { id: 'R2', lure: LURES[1], role: 'troll', leadFt: 60 }] },
  legs: PICKED.map((p) => ({ runId: p.runId, speedMph: 2.0,
                             deploy: { port: 'R1', starboard: 'R2' }, why: 'the ledge' })),
  stops: [], changes: [],
});

const build = (extra = {}) => planFromWater({
  picked: PICKED, spots: [], ramp: RAMP, slug: 'wateree_lake', usableAh: 80, windowMin: 480,
  launchTime: '06:30', returnTime: '13:00', askModel: MODEL,
  tackle: TACKLE_INVENTORY.filter((l) => l.trollable).map((l) => l.name),
  connectionOf: (n) => {
    const hit = TACKLE_INVENTORY.find((l) => l.name === n);
    return hit ? connectionFor(hit.type) : null;
  },
  planArgs: { water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-07-29',
              species: ['Striped Bass'], usableAh: 80, tackle: LURES, conditions: {} },
  ...extra,
});

describe('a leg built from picked water carries both of its ends', () => {
  it('builds a day at all — the regression that shipped', async () => {
    const r = await build();
    expect(r.plan).toBeTruthy();
    // NOT `problems.length === 0`. Unrouted transits and a re-seat are reported here now, and
    // they are information rather than failure — the old assertion only held because every one of
    // them was being thrown away. What must be empty is the set of things that stop a plan.
    expect(r.plan.legs.length > 0).toBe(true);
  });

  it('PUTS RODS ON THE LEGS — "didn\'t assign baits at all"', async () => {
    // The whole failure, in one assertion. The model answers with deploy inside each leg; this
    // path read a top-level `res.deploy` that is never sent, so every leg arrived with
    // `deploy: null`, routeRods came out {L1..L9: []}, and the spread was empty.
    const r = await build();
    const troll = r.plan.legs.filter((l) => l.type !== 'transit');
    expect(troll.length).toBe(PICKED.length);
    for (const l of troll) {
      expect(Boolean(l.deploy && l.deploy.port && l.deploy.starboard)).toBe(true);
    }
    expect(r.plan.loadout.rods.length > 0).toBe(true);
  });

  it('seats each lure on a rod that can carry it, and says it moved them', async () => {
    // planArgsFrom() does this and the picked-water path was skipping it entirely. A tie-only
    // lure on a snap rod is a wrong change-cost on every swap for the rest of the day.
    const r = await build();
    const ids = r.plan.loadout.rods.map((x) => x.id);
    expect(ids.length >= 2).toBe(true);
    expect(r.problems.some((p) => /re-seated/.test(p))).toBe(true);
  });

  it('reports what the model got wrong instead of returning an empty list', async () => {
    const r = await build({
      askModel: async () => JSON.stringify({
        loadout: { rods: [{ id: 'R1', lure: 'Nonexistent Wobbler 9000', role: 'troll', leadFt: 80 }] },
        legs: PICKED.map((p) => ({ runId: p.runId, speedMph: 2.0, deploy: { port: 'R1' } })),
        stops: [], changes: [],
      }),
    });
    // A lure that is not in the bag, and a leg missing its starboard rod. Both were computed and
    // discarded before — `problems: []` was hardcoded.
    expect(r.problems.some((p) => /not in the tackle inventory/.test(p))).toBe(true);
    expect(r.problems.some((p) => /needs one port rod and one starboard rod/.test(p))).toBe(true);
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
