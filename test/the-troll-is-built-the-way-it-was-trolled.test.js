/**
 * the-troll-is-built-the-way-it-was-trolled.test.js
 *
 * 2026-10-03. Ryan, on the Lake Wateree day "Plan it as one troll" built for 2026-10-04: "definitely
 * doesn't work on wateree". Two things made it a string of runs instead of a troll:
 *
 *   1. The build kept only the troll's ORDER. Each piece went back to its drawn direction and every
 *      gap the troll had trolled with the baits in was priced as a run with the lines up -- 23.7 km
 *      of 37.5 km deadheading.
 *   2. The model asked for second passes on four legs, the assembler rightly ran none of them, and the
 *      legs stayed turned for the passes that never ran: each was followed by a run back across the
 *      water it had just trolled, and every one of those four runs was an unrouted straight line,
 *      because the router had been asked for the hop out of the other end.
 *
 *   node --test test/the-troll-is-built-the-way-it-was-trolled.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */
import { describe, it, expect } from './expect-shim.mjs';
import { trollDay, trollShape, asTrolled } from '../js/modules/plan-troll-day.js';
import { planFromWater } from '../js/modules/plan-from-water.js';
import { orientLegs, metresBetween } from '../js/modules/plan-candidates.js';
import { assemblePlan } from '../js/modules/plan-assemble.js';
import { prefetchTransits, assembleSettled, passesRun } from '../js/modules/smart-plan-v2.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';
import { connectionFor } from '../js/data/lure-knowledge.js';

const LAT = 34.38;
const KX = 111320 * Math.cos(LAT * Math.PI / 180);
const ll = (x, y) => [-80.8 + x / KX, LAT + y / 110540];
const line = (x0, y0, x1, y1, n = 10) => {
  const c = [];
  for (let i = 0; i <= n; i++) c.push(ll(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n));
  return c;
};
const piece = (key, x0, y0, x1, y1, holdsFt) => ({
  key, runId: `wateree_lake#${key}`, coords: line(x0, y0, x1, y1), holdsFt,
  lengthM: Math.round(Math.hypot(x1 - x0, y1 - y0)), laneLengthM: Math.round(Math.hypot(x1 - x0, y1 - y0)),
  near: [{ t: 'hump', s: 200, d: 20 }], partners: [], reasons: { for: ['unbroken'], against: [] },
  envelope: Array(10).fill(holdsFt + 1), envelopeStepM: 100, chartedFrac: 1,
});

// a: north up x=0. b: beside a's far end, drawn the same way, so the troll comes back down it
// reversed. The gap between them reads 32 ft; a holds 34 and b holds 30, so one bait covers both.
// c: across a 20 ft shoal, so the troll lines up to reach it.
const RAMP = ll(0, 0);
const A = piece('a', 0, 200, 0, 1200, 34);
const B = piece('b', 40, 200, 40, 1200, 30);
const C = piece('c', 600, 200, 600, 1200, 34);
const depthAt = ([lon, lat]) => {
  const x = (lon - -80.8) * KX, y = (lat - LAT) * 110540;
  if (x > -1 && x < 41 && y > 1150) return 32;          // the gap, ends included: it is sounded at both
  if (x > 100 && x < 500) return 20;
  return 50;
};
const DAY = trollDay([A, B, C], { ramp: RAMP, floorFt: 30, depthAt, windowMin: 600, usableAh: 200 });

describe('the troll says how it runs each piece', () => {
  it('a, then back down b, then a run to c', () => {
    expect(DAY.keys).toEqual(['a', 'b', 'c']);
    expect(DAY.steps.map((s) => s.kind)).toEqual(['run', 'piece', 'troll', 'piece', 'run', 'piece']);
  });

  it('trollShape(): b is reversed, a trolls on into b, b does not troll on into c', () => {
    const sh = trollShape(DAY.steps);
    expect(sh.get('a').reversed).toBe(false);
    expect(sh.get('b').reversed).toBe(true);
    expect(metresBetween(sh.get('a').onTo, B.coords[B.coords.length - 1])).toBeLessThan(1);
    expect(sh.get('a').onShallowestFt).toBe(32);
    expect(sh.get('b').onTo).toBe(null);
    expect(sh.get('c').onTo).toBe(null);
  });

  it('asTrolled(): turned, run on, and the gap counted in the length', () => {
    const sh = trollShape(DAY.steps);
    const a = asTrolled(A, sh.get('a'));
    expect(a.lengthM).toBe(A.lengthM + DAY.steps[2].m);
    expect(a.coords[a.coords.length - 1]).toEqual(sh.get('a').onTo);
    const b = asTrolled(B, sh.get('b'));
    expect(b.coords[0]).toEqual(B.coords[B.coords.length - 1]);
  });
});

describe('orientLegs() keeps a leg already drawn the way it is run', () => {
  it('does not turn it, even where turning it is shorter', () => {
    const one = { start: ll(0, 200), end: ll(0, 1200) };
    const two = { start: ll(40, 200), end: ll(40, 1200) };            // shorter entered at its end
    expect(orientLegs([one, two], RAMP)[1].flipped).toBe(true);
    expect(orientLegs([one, { ...two, fixedDirection: true }], RAMP)[1].flipped).toBe(false);
  });
});

const LURES = ['3" Lipless Crankbait', 'Dr.Fish Diamond Jig / Jigging Spoon 1oz'];
const asked = [];
const model = (passes) => async (req) => {
  asked.push(req);
  return JSON.stringify({
    loadout: { rods: [{ id: 'R1', lure: LURES[0], role: 'troll', leadFt: 60 },
                      { id: 'R2', lure: LURES[1], role: 'troll', leadFt: 40 }] },
    legs: [A, B, C].map((p) => ({ runId: p.runId, speedMph: 2.0, trollPasses: passes,
                                  deploy: { port: 'R1', starboard: 'R2' }, why: 'w' })),
    stops: [], changes: [],
  });
};
const build = (extra = {}) => planFromWater({
  picked: [A, B, C], order: [0, 1, 2], troll: DAY.steps, spots: [], ramp: RAMP, slug: 'wateree_lake',
  usableAh: 80, windowMin: 600, launchTime: '06:00', returnTime: '16:00', askModel: model(1),
  tackle: TACKLE_INVENTORY.filter((l) => l.trollable).map((l) => l.name),
  connectionOf: (n) => { const h = TACKLE_INVENTORY.find((l) => l.name === n); return h ? connectionFor(h.type) : null; },
  planArgs: { water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-10-04',
              species: ['Striped Bass'], usableAh: 80, tackle: LURES, conditions: {} },
  ...extra,
});

describe('the day is built the way the troll ran it', () => {
  it('each piece runs the way the troll entered it', async () => {
    const r = await build();
    expect(r.trolled).toBe(true);
    const troll = r.plan.legs.filter((l) => l.type !== 'transit');
    expect(troll.map((l) => l.runId)).toEqual(['wateree_lake#a', 'wateree_lake#b', 'wateree_lake#c']);
    expect(metresBetween(troll[1].coordinates[0], B.coords[B.coords.length - 1])).toBeLessThan(1);
  });

  it('a gap the troll trolled is the end of the leg before it, not a run with the lines up', async () => {
    const r = await build();
    const i = r.plan.legs.findIndex((l) => l.runId === 'wateree_lake#a');
    expect(r.plan.legs[i + 1].runId).toBe('wateree_lake#b');           // nothing run between them
    const a = r.plan.legs[i];
    expect(a.lengthM).toBe(A.lengthM + DAY.steps[2].m);
    // and the gap c is reached across is still run, routed or not, like any other run
    const j = r.plan.legs.findIndex((l) => l.runId === 'wateree_lake#c');
    expect(r.plan.legs[j - 1].type).toBe('transit');
  });

  it("the gap's shallowest water is the leg's floor when it is lower", async () => {
    const r = await build();
    const a = r.request && r.request.user;
    const cands = JSON.parse(a.slice(a.indexOf('[{"runId"'), a.indexOf('}]\n', a.indexOf('[{"runId"')) + 2));
    const ca = cands.find((c) => c.runId === 'wateree_lake#a');
    expect(ca.maxRunDepthFt).toBe(32);
    expect(ca.trollsOnM).toBe(DAY.steps[2].m);
    expect(ca.transitToMIfFishedBack).toBe(undefined);
  });

  it('the prompt says one troll, and asks for no second pass', async () => {
    const r = await build();
    expect(/THE DAY IS ONE TROLL/.test(r.request.user)).toBe(true);
    expect(/AND FISH THE GOOD ONES BACK/.test(r.request.user)).toBe(false);
    expect(/"trollPasses": 1/.test(r.request.user)).toBe(false);
  });

  it('a second pass the model asks for anyway is not run', async () => {
    const r = await build({ askModel: model(2) });
    expect(r.plan.legs.filter((l) => l.runId === 'wateree_lake#a').length).toBe(1);
  });

  it('without the steps, or with a tick changed, the day is built exactly as before', async () => {
    const r = await build({ troll: undefined });
    expect(r.trolled).toBe(false);
    expect(/THE DAY IS ONE TROLL/.test(r.request.user)).toBe(false);
    const s = await build({ troll: DAY.steps.slice(0, 4), picked: [A, B, C] });
    expect(s.trolled).toBe(false);
  });
});

// ── A PASS THAT DID NOT RUN DOES NOT TURN THE LEG OR CHOOSE ITS ROUTE ───────────────────────────
//
// #434's shape: the ramp off to the side, the leg drawn north to south, the next leg north of it.
// Turned for two passes it is entered at the north end; with the second pass gone the boat is left at
// the south end and runs back up past it.
const LAUNCH = ll(3000, 0);
const leg = (id, x0, y0, x1, y1) => {
  const coordinates = line(x0, y0, x1, y1);
  return { runId: id, startM: 0, lengthM: Math.hypot(x1 - x0, y1 - y0), depthFt: 22,
           start: coordinates[0], end: coordinates[coordinates.length - 1], coordinates, passes: [] };
};
const L1 = leg('w#1', 0, 1000, 0, -1000);
const L2 = leg('w#2', 0, 2000, 0, 4000);
const LOADOUT = { rods: [{ id: 'R1', rig: 'fluoro', role: 'troll', lure: 'A-Rig Medium', color: 'x' },
                         { id: 'R5', rig: 'snap', role: 'troll', lure: 'Flutter Spoon 3/4oz', color: 'x' }] };
const assemble = (cands, transit) => assemblePlan({
  transit, candidates: cands, launch: LAUNCH, loadout: LOADOUT, slug: 'wateree_lake',
  launchTime: '06:00', returnTime: '08:30', usableAh: 80,
  deploy: { 'w#1': { port: 'R1', starboard: 'R5' }, 'w#2': { port: 'R1', starboard: 'R5' } },
});
const router = async (a, b) => ({ distanceM: metresBetween(a, b), coordinates: [a, b] });
const routeFor = (cands) => prefetchTransits(cands, LAUNCH, router);

describe('the passes that ran, before the routes between them', () => {
  const cands = [{ ...L1, trollPasses: 2 }, L2];

  it('built once, the dropped pass leaves the leg turned wrong and the run back unrouted', async () => {
    const plan = assemble(cands, await routeFor(cands));
    expect(plan.legs.filter((l) => l.runId === 'w#1').length).toBe(1);
    const i = plan.legs.findIndex((l) => l.runId === 'w#1');
    expect(plan.legs[i + 1].unrouted).toBe(true);
    expect(plan.legs[i + 1].lengthM).toBeGreaterThan(2900);
  });

  it('settled, the leg runs toward the next one and every run is routed', async () => {
    const { plan, candidates } = await assembleSettled(cands, LAUNCH, routeFor, assemble);
    expect(candidates[0].trollPasses).toBe(1);
    const i = plan.legs.findIndex((l) => l.runId === 'w#1');
    expect(metresBetween(plan.legs[i].coordinates[0], L1.end)).toBeLessThan(1);   // south to north
    expect(plan.legs[i + 1].lengthM).toBeLessThan(1100);
    expect(plan.legs.some((l) => l.unrouted)).toBe(false);
  });

  it('and still says the pass was stopped', async () => {
    const { plan } = await assembleSettled(cands, LAUNCH, routeFor, assemble);
    expect([...(plan.warnings || []), ...(plan.decisions || [])]
      .some((w) => /w#1 asked for 2 passes — stopped after 1/.test(w))).toBe(true);
  });

  it('passesRun(): nothing to settle when every pass ran, or no pass was asked for', () => {
    const plan = { legs: [{ type: 'troll', runId: 'w#1' }, { type: 'troll', runId: 'w#1' }, { type: 'troll', runId: 'w#2' }] };
    expect(passesRun([{ runId: 'w#1', trollPasses: 2 }, { runId: 'w#2' }], plan)).toBe(null);
    expect(passesRun([{ runId: 'w#1', trollPasses: 3 }], plan)[0].trollPasses).toBe(2);
    expect(passesRun([{ runId: 'w#9', trollPasses: 2 }], plan)).toBe(null);
  });
});
