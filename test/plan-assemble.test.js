import { describe, it, expect } from './expect-shim.mjs';
import {
  assemblePlan, parseClock, formatClock, planRoute, planCues, validatePlan,
} from '../js/modules/plan-assemble.js';
import { structureIndex, resolveStructure, selectCandidates, forModel } from '../js/modules/plan-candidates.js';
import { metresBetween } from '../js/modules/plan-candidates.js';

// ---------------------------------------------------------------------------
// Why this test exists
//
// PLAN_SCHEMA_V2.md lists what the schema is meant to make IMPOSSIBLE:
//
//   - a lure that is not on a rod; a seventh rod
//   - a change with no cost attached
//   - a cast stop the app cannot place on a run
//   - a stop at targetDepth: 6 on a 41 ft hump
//   - a route drawn anywhere the model chose
//   - a notification that fires on the clock while the boat is still two miles back
//
// "Impossible" is a claim about code, so each one gets a test that tries it and
// checks it was refused. The distance spine gets the most attention: it is what
// the phone reads, and Ryan's whole reason for it is that the clock starts
// drifting the moment he hooks a fish and never catches up.
// ---------------------------------------------------------------------------

const LAUNCH = [-80.7300, 34.3800];

// Two legs of known length, laid out east of the ramp. Coordinates are degrees;
// at this latitude 0.001 deg lon is about 92 m.
function leg(id, fromLon, toLon, lat, passes = []) {
  const coordinates = [];
  for (let i = 0; i <= 10; i++) coordinates.push([fromLon + (toLon - fromLon) * i / 10, lat]);
  const lengthM = Math.abs(toLon - fromLon) * 111320 * Math.cos(lat * Math.PI / 180);
  return {
    runId: id, runIndex: Number(id.split('#')[1]),
    startM: 0, lengthM, depthFt: 22.4,
    start: coordinates[0], end: coordinates[coordinates.length - 1],
    coordinates,
    passes: passes.map((p, k) => ({
      id: `${id}:p${k}`, atM: p.atM, type: p.type, offM: p.offM ?? 30, weight: p.weight ?? 3,
      at: [fromLon + (toLon - fromLon) * (p.atM / lengthM), lat],
      structureId: p.structureId ?? null, what: p.what ?? p.type, depthFt: p.depthFt ?? null,
      matchM: 12,
    })),
    support: null,
  };
}

const LOADOUT = {
  rods: [
    { id: 'R1', rig: 'fluoro', role: 'troll', lure: 'A-Rig Medium', color: 'Blueback Herring' },
    { id: 'R2', rig: 'fluoro', role: 'troll', lure: 'Swimbait', color: 'Shad' },
    { id: 'R3', rig: 'fluoro', role: 'troll', lure: 'Deep Crank', color: 'Citrus' },
    { id: 'R4', rig: 'fluoro', role: 'troll', lure: 'Umbrella', color: 'White' },
    { id: 'R5', rig: 'snap', role: 'troll', lure: 'Flutter Spoon 3/4oz', color: 'Chrome' },
    { id: 'R6', rig: 'snap', role: 'cast', lure: 'Walking Bait', color: 'Bone' },
  ],
};

const A = leg('w#1', -80.7200, -80.6800, 34.3800, [
  { atM: 1200, type: 'hump', structureId: 'hump_7', what: 'offshore hump, 5.6 ac, crown 41 ft', depthFt: 41 },
  { atM: 2600, type: 'ledge', structureId: 'ledge_88', what: 'ledge, 6 ft drop, at 32 ft', depthFt: 32.2 },
]);
const B = leg('w#2', -80.6700, -80.6400, 34.3850, [
  { atM: 900, type: 'creek_mouth', what: 'Crooked Creek mouth', depthFt: null },
]);

/**
 * A stand-in for POST /water/{slug}/route. Same straight geometry, so every distance below is
 * unchanged -- but ROUTED, so the plan is not flagged `unrouted`. Without a transit function the
 * assembler draws a straight line between two leg ends, marks it, warns, and validatePlan()
 * lists it: a straight line is water only by luck and on a reservoir it crosses points.
 */
const routed = (a, b) => ({ distanceM: metresBetween(a, b), coordinates: [a, b] });

function basePlan(extra = {}) {
  return assemblePlan({
    transit: routed,
    candidates: [A, B], launch: LAUNCH, loadout: LOADOUT,
    slug: 'wateree_lake', water: 'Lake Wateree, SC', ramp: 'Clearwater Cove',
    launchTime: '06:00', returnTime: '15:00', usableAh: 80,
    deploy: { 'w#1': { port: 'R1', starboard: 'R5' }, 'w#2': { port: 'R2', starboard: 'R5' } },
    ...extra,
  });
}

describe('plan-assemble — the distance spine', () => {
  it('reads a clock and refuses nonsense', () => {
    expect(parseClock('06:00')).toBe(360);
    expect(parseClock('15:45')).toBe(945);
    expect(parseClock('25:00')).toBe(null);
    expect(parseClock('06:99')).toBe(null);
    expect(parseClock('')).toBe(null);
    expect(formatClock(945)).toBe('15:45');
    expect(formatClock(null)).toBe(null);
  });

  it('is gapless: every leg starts where the last one ended', () => {
    const plan = basePlan();
    expect(validatePlan(plan).length).toBe(0);
    let at = 0;
    for (const l of plan.legs) { expect(l.startM).toBe(at); at += l.lengthM; }
    expect(plan.budget.totalM).toBe(at);
  });

  it('keeps the spine in integers so nothing drifts a metre', () => {
    const plan = basePlan();
    for (const l of plan.legs) {
      expect(Number.isInteger(l.startM)).toBe(true);
      expect(Number.isInteger(l.lengthM)).toBe(true);
    }
    expect(plan.budget.fishingM + plan.budget.transitM).toBe(plan.budget.totalM);
  });

  it('labels every clock value as an estimate, and only the window as real', () => {
    const plan = basePlan();
    for (const l of plan.legs) {
      expect('estStartTime' in l).toBe(true);
      expect('estDurationMin' in l).toBe(true);
      expect('startTime' in l).toBe(false);
      expect('durationMin' in l).toBe(false);
    }
    expect(plan.budget.windowMin).toBe(540);
    expect('estPlannedMin' in plan.budget).toBe(true);
  });

  it('has no inbound, outbound or return_to_launch leg', () => {
    const plan = basePlan();
    const types = new Set(plan.legs.map((l) => l.type));
    expect([...types].every((t) => t === 'troll' || t === 'transit')).toBe(true);
    const json = JSON.stringify(plan);
    for (const word of ['return_to_launch', 'inbound', 'outbound', 'out-and-back']) {
      expect(json.includes(word)).toBe(false);
    }
  });
});

describe('plan-assemble — the speed is the model\'s, per leg', () => {
  // PLAN_SCHEMA_V2.md's MODEL DECIDES table grants `legs[].speedMph` to the model. The assembler
  // used to parse it, carry it across a module boundary and then overwrite every leg with one
  // day-wide `trollMph` -- which is why a plan reported 1.8 while both legs ran 2. These two legs
  // are the SAME LENGTH, so the only thing that can make their numbers differ is their speed.
  const SLOW = leg('w#1', -80.7200, -80.6800, 34.3800);
  const FAST = leg('w#2', -80.6700, -80.6300, 34.3800);

  it('costs each leg at its own speed, not one number for the day', () => {
    const plan = basePlan({ candidates: [{ ...SLOW, speedMph: 1.6 }, { ...FAST, speedMph: 2.4 }] });
    const [a, b] = plan.legs.filter((l) => l.type === 'troll');
    expect(a.lengthM).toBe(b.lengthM);
    expect(a.speedMph).toBe(1.6);
    expect(b.speedMph).toBe(2.4);
    // Same water, two speeds: the slow leg takes longer and the fast one costs more amp-hours.
    expect(a.estDurationMin > b.estDurationMin).toBe(true);
    expect(a.batteryAh < b.batteryAh).toBe(true);
    expect(validatePlan(plan).length).toBe(0);
  });

  it('falls back to trollMph for a leg the model gave no speed for, and changes nothing else', () => {
    const mixed = basePlan({ candidates: [{ ...SLOW, speedMph: 2.4 }, FAST] });
    const [a, b] = mixed.legs.filter((l) => l.type === 'troll');
    expect(a.speedMph).toBe(2.4);
    expect(b.speedMph).toBe(2.0);            // the default, untouched

    // A silent model must produce exactly what it produced before this changed.
    const silent = basePlan({ candidates: [SLOW, FAST] });
    const told = basePlan({ candidates: [{ ...SLOW, speedMph: 2.0 }, { ...FAST, speedMph: 2.0 }] });
    expect(JSON.stringify(silent.legs)).toBe(JSON.stringify(told.legs));
  });

  it('refuses a speed this boat does not have and says so', () => {
    const plan = basePlan({ candidates: [{ ...SLOW, speedMph: 40 }, { ...FAST, speedMph: 0 }] });
    expect(plan.legs.filter((l) => l.type === 'troll').every((l) => l.speedMph === 2.0)).toBe(true);
    expect(plan.warnings.some((w) => w.includes('40 mph'))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('0 mph'))).toBe(true);
  });
});

describe('plan-assemble — what the model may not do', () => {
  it('refuses a stop on a structure it was not handed', () => {
    const plan = basePlan({
      stops: [{ runId: 'w#1', structureId: 'Main Lake Point Alpha', rods: ['R6'], why: 'invented' }],
    });
    expect(plan.legs.filter((l) => l.type === 'troll').every((l) => l.stops.length === 0)).toBe(true);
    expect(plan.warnings.some((w) => w.includes('no structure'))).toBe(true);
  });

  it('refuses a stop on a run that is not in the plan', () => {
    const plan = basePlan({ stops: [{ runId: 'w#999', structureId: 'w#999:p0' }] });
    expect(plan.warnings.some((w) => w.includes('not in the plan'))).toBe(true);
  });

  it('places a real stop from the id alone — the model supplies no coordinate', () => {
    const plan = basePlan({
      stops: [{ runId: 'w#1', structureId: 'w#1:p0', rods: ['R6'], durationMin: 20,
                why: 'crown stands proud', presentation: 'count down 12 seconds',
                positioning: 'pedal-hover into the wind' }],
    });
    const s = plan.legs.find((l) => l.id === 'L1').stops[0];
    expect(s.atM).toBe(1200);
    expect(s.at.length).toBe(2);
    expect(s.structureId).toBe('hump_7');
    expect(s.structureRef).toBe('w#1:p0');
    expect(s.durationMin).toBe(20);
    expect(validatePlan(plan).length).toBe(0);
  });

  it('takes stop depth from the structure and never defaults it to 6', () => {
    const plan = basePlan({
      stops: [{ runId: 'w#1', structureId: 'w#1:p0' }, { runId: 'w#2', structureId: 'w#2:p0' }],
    });
    const onHump = plan.legs.find((l) => l.runId === 'w#1').stops[0];
    const onCreek = plan.legs.find((l) => l.runId === 'w#2').stops[0];
    expect(onHump.depthFt).toBe(41);
    // The pipeline has no depth for a creek mouth. Null is the honest answer; 6 is a lie that
    // would then size the jighead.
    expect(onCreek.depthFt).toBe(null);
  });

  it('refuses a seventh rod, in a change and in a deploy', () => {
    const plan = basePlan({
      changes: [{ beforeRunId: 'w#2', rodId: 'R7', to: 'Alabama Rig', why: 'a rod he does not own' }],
      deploy: { 'w#1': { port: 'R1', starboard: 'R9' } },
    });
    expect(plan.changes.length).toBe(0);
    expect(plan.warnings.some((w) => w.includes('no such rod'))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('R9'))).toBe(true);
  });

  it('costs a change from the rod it is on, not from the model saying so', () => {
    // R5 is starboard on w#2 and R1 is port on w#1, so both swaps are for a rod that goes back
    // in the water. That is not decoration in the fixture -- a change on a rod with nothing
    // downstream of it is refused now, and this test is about COST, not about justification.
    const plan = basePlan({
      changes: [
        { beforeRunId: 'w#2', rodId: 'R5', to: 'DD1 Crankbait', why: 'fish moved up' },
        { beforeRunId: 'w#1', rodId: 'R1', to: 'Bucktail', why: 'retie' },
      ],
    });
    const byRod = Object.fromEntries(plan.changes.map((c) => [c.rodId, c.cost]));
    expect(byRod.R5).toBe('snap');       // R5 is on a snap
    expect(byRod.R1).toBe('fluoro');     // R1 is on a 20 lb leader
    expect(plan.changes.every((c) => !!c.cost)).toBe(true);
    // A change happens where the boat is, before the leg — so it lands on a leg boundary.
    const starts = new Set(plan.legs.map((l) => l.startM));
    expect(plan.changes.every((c) => starts.has(c.atM))).toBe(true);
  });
});

describe('plan-assemble — the route is continuous', () => {
  // -----------------------------------------------------------------------------------------
  // Ryan, 2026-08-09: "the transit legs do not actually connect to the trolling legs". Measured
  // off that plan's GPX: T1 ended 70 m short of L1, L1 ended 77 m short of T2, L2 ended 55 m
  // short of T3. The water router returns a path of GRAPH CELL CENTROIDS, so its ends are the
  // centres of the cells containing the endpoints rather than the endpoints themselves.
  // -----------------------------------------------------------------------------------------
  const centroidish = (a, b) => ({
    // A router that answers with points NEAR the ends rather than ON them — which is what the
    // real one does, and what nothing downstream used to correct for.
    distanceM: metresBetween(a, b),
    coordinates: [[a[0] + 0.0006, a[1] + 0.0006], [b[0] - 0.0006, b[1] - 0.0006]],
  });

  it('every leg starts exactly where the one before it ended', () => {
    const plan = basePlan({ transit: centroidish });
    for (let i = 1; i < plan.legs.length; i++) {
      const prev = plan.legs[i - 1].coordinates;
      const here = plan.legs[i].coordinates;
      const gap = metresBetween(prev[prev.length - 1], here[0]);
      expect(gap < 1).toBe(true);
    }
  });

  it('the first leg starts at the launch and the last ends there', () => {
    const plan = basePlan({ transit: centroidish });
    const first = plan.legs[0].coordinates;
    const last = plan.legs[plan.legs.length - 1].coordinates;
    expect(metresBetween(first[0], LAUNCH) < 1).toBe(true);
    expect(metresBetween(last[last.length - 1], LAUNCH) < 1).toBe(true);
  });

  it('counts the metres it stitched on rather than reporting the router number', () => {
    const plan = basePlan({ transit: centroidish });
    const t1 = plan.legs.find((l) => l.type === 'transit');
    let walked = 0;
    for (let i = 1; i < t1.coordinates.length; i++) {
      walked += metresBetween(t1.coordinates[i - 1], t1.coordinates[i]);
    }
    expect(Math.abs(walked - t1.lengthM) <= 1).toBe(true);
  });
});

describe('plan-assemble — saying when it does not fit', () => {
  it('warns when the plan is over the battery', () => {
    const plan = basePlan({ usableAh: 2 });
    expect(plan.warnings.some((w) => w.includes('over budget'))).toBe(true);
  });

  it('warns when the plan runs past the return time', () => {
    const plan = basePlan({ launchTime: '06:00', returnTime: '06:30' });
    expect(plan.warnings.some((w) => w.includes('min window'))).toBe(true);
  });

  // 2026-08-09. This test used to assert the opposite: that the plan WARNS the last leg ends away
  // from the ramp and adds nothing. That was PLAN_SCHEMA_V2's clause and it was right about the
  // thing it deleted -- an invented straight line home, costed as if a kayak flies. It was wrong
  // about what to do instead. Ryan: "this entire plan leaves me stranded miles from the ramp with
  // no timing included for getting home and no route to do it." A warning in a list he never sees
  // is not a route home.
  it('routes him home and puts it in the budget, instead of warning and adding nothing', () => {
    const plan = basePlan();
    const last = plan.legs[plan.legs.length - 1];
    expect(last.type).toBe('transit');
    expect(last.role).toBe('return');
    expect(last.unrouted).toBeUndefined();               // the router answered; nothing is faked
    expect(last.lengthM).toBeGreaterThan(0);
    expect(last.batteryAh).toBeGreaterThan(0);
    expect(last.estDurationMin).toBeGreaterThan(0);
    // it ends AT the ramp
    const end = last.coordinates[last.coordinates.length - 1];
    expect(metresBetween(end, LAUNCH) < 1).toBe(true);
    // and the day's arithmetic counts it
    expect(plan.budget.transitM).toBeGreaterThanOrEqual(last.lengthM);
    expect(plan.budget.totalM).toBe(last.startM + last.lengthM);
    expect(validatePlan(plan).length).toBe(0);
    // the old warning is gone because the thing it warned about is in the plan
    expect(plan.warnings.some((w) => w.includes('not in the plan'))).toBe(false);
  });

  it('adds nothing when the last leg already finishes at the ramp', () => {
    // HOME_TOLERANCE_M is 500 m. A leg that ends on the ramp needs no leg home, and inventing a
    // zero-length one would put an empty track on the unit.
    const backHome = leg('w#9', -80.7200, -80.7300, 34.3800);
    const plan = assemblePlan({
      transit: routed, candidates: [backHome], launch: LAUNCH, loadout: LOADOUT,
      launchTime: '06:00', returnTime: '15:00', usableAh: 80,
    });
    expect(plan.legs.filter((l) => l.role === 'return').length).toBe(0);
    expect(plan.legs[plan.legs.length - 1].type).toBe('troll');
  });

  it('never draws the way home as a straight line without saying so', () => {
    // The invention PLAN_SCHEMA_V2 deleted was exactly this: a straight line from wherever the
    // day finished back to the ramp. When the router will not answer for this pair, the leg is
    // still refused as a finished answer -- marked, warned about loudly, and failed by
    // validatePlan() the same as any other unrouted transit.
    const plan = assemblePlan({
      candidates: [A, B], launch: LAUNCH, loadout: LOADOUT,
      launchTime: '06:00', returnTime: '15:00', usableAh: 80,
    });
    const home = plan.legs.find((l) => l.role === 'return');
    expect(home.unrouted).toBe(true);
    expect(plan.warnings.some((w) => w.includes('THE ROUTE HOME IS NOT WATER-ROUTED'))).toBe(true);
    expect(validatePlan(plan).some((b) => b.includes(`${home.id} is not water-routed`))).toBe(true);
  });

  it('the trip home is something the day can now fail to afford', () => {
    // The point of putting it in the budget rather than in a warning: the over-battery and
    // past-return-time checks see it.
    const plan = basePlan();
    const home = plan.legs.find((l) => l.role === 'return');
    const withoutHome = plan.budget.plannedAh - home.batteryAh;
    const tight = basePlan({ usableAh: Number((withoutHome + home.batteryAh / 2).toFixed(2)) });
    expect(tight.warnings.some((w) => w.includes('over budget'))).toBe(true);
  });

  it('warns at three fluoro reties', () => {
    // R3 is put in the water on w#1 here so its retie is a real one. Three fluoro knots with wet
    // hands is the thing being warned about, and it only counts changes that survive.
    const plan = basePlan({
      deploy: { 'w#1': { port: 'R1', starboard: 'R3' }, 'w#2': { port: 'R2', starboard: 'R5' } },
      changes: [
        { beforeRunId: 'w#1', rodId: 'R1', to: 'a' }, { beforeRunId: 'w#1', rodId: 'R3', to: 'b' },
        { beforeRunId: 'w#2', rodId: 'R2', to: 'c' }, { beforeRunId: 'w#2', rodId: 'R5', to: 'd' },
      ],
    });
    expect(plan.warnings.some((w) => w.includes('fluoro reties'))).toBe(true);
  });

  // -------------------------------------------------------------------------------------------
  // Ryan, 2026-08-09: "has me change a lure for what reason i can't tell... as there is no other
  // stop and cast planned after it has me change it." Measured off that plan: C1 swapped R5 at
  // 8,993 m, the day's only stop was at 6,705 m, and R5 was never in the water or at a stop
  // again. A retie that buys nothing is a defect the app can see without the model's help.
  // -------------------------------------------------------------------------------------------
  it('refuses a lure change on a rod that is never used again', () => {
    const plan = basePlan({
      changes: [
        // R1 is port on w#1 only. Changing it before w#2 is a knot tied for nothing.
        { beforeRunId: 'w#2', rodId: 'R1', to: 'Bucktail', why: 'the wind picked up' },
        // R5 is starboard on w#2, so this one is real and must survive alongside it.
        { beforeRunId: 'w#2', rodId: 'R5', to: 'DD1 Crankbait', why: 'fish moved up' },
      ],
    });
    expect(plan.changes.map((c) => c.rodId)).toEqual(['R5']);
    expect(plan.warnings.some((w) => w.includes('R1') && w.includes('never trolled or cast')))
      .toBe(true);
  });

  it('keeps a change justified by a later stop rather than by the spread', () => {
    // R6 is the cast rod -- it is never deployed, so only a stop can justify touching it.
    const plan = basePlan({
      stops: [{ runId: 'w#2', structureId: 'ledge_3', rods: ['R6'], durationMin: 15 }],
      changes: [{ beforeRunId: 'w#2', rodId: 'R6', to: 'Walking Bait', why: 'for the stop' }],
    });
    expect(plan.changes.map((c) => c.rodId)).toEqual(['R6']);
  });

  // ---------------------------------------------------------------------------------------------
  // "46% of the day is deadheading" is a fact the budget could always have stated and never did.
  // Measured off the plan of 2026-08-09: totalM 28040, fishingM 15250, transitM 12790, with one
  // 9687 m transit between two legs that were each near the ramp. The ordering belongs to the
  // model (PLAN_SCHEMA_V2), so this is not a reorder — it is the plan saying what its own order
  // cost, in the warnings Ryan sees.
  // ---------------------------------------------------------------------------------------------
  it('says so when most of the day is spent getting there', () => {
    // One short leg, reached from a long way off: the transit dominates the distance.
    const far = leg('w#9', -80.4000, -80.3980, 34.3800);
    const plan = assemblePlan({
      transit: routed, candidates: [far], launch: LAUNCH, loadout: LOADOUT,
      launchTime: '06:00', returnTime: '15:00',
    });
    expect(plan.budget.transitM / plan.budget.totalM > 0.35).toBe(true);
    const w = plan.warnings.find((x) => x.includes('deadheading'));
    expect(!!w).toBe(true);
    // The number in the warning is the plan's own, not a re-derivation.
    expect(w.includes(`${Math.round((plan.budget.transitM / plan.budget.totalM) * 100)}%`)).toBe(true);
  });

  it('does not cry wolf on a day that is mostly fishing', () => {
    // Out along one leg and back along the next, finishing beside the ramp — the shape the
    // ordering is supposed to find, and the one the warning must stay quiet about.
    const outbound = leg('w#7', -80.7200, -80.6800, 34.3800);
    const homebound = leg('w#8', -80.6800, -80.7250, 34.3805);
    const plan = assemblePlan({
      transit: routed, candidates: [outbound, homebound], launch: LAUNCH, loadout: LOADOUT,
      launchTime: '06:00', returnTime: '15:00',
    });
    expect(plan.budget.transitM / plan.budget.totalM < 0.35).toBe(true);
    expect(plan.warnings.some((w) => w.includes('deadheading'))).toBe(false);
  });

  it('assembles an empty plan without inventing anything', () => {
    const plan = assemblePlan({ candidates: [], launch: LAUNCH, loadout: LOADOUT });
    expect(plan.legs.length).toBe(0);
    expect(plan.budget.totalM).toBe(0);
    expect(plan.warnings.length).toBe(0);
    expect(validatePlan(plan).length).toBe(0);
  });
});

describe('plan-assemble — what the phone and the GPX read', () => {
  it('walks the legs for the route, with no duplicated joins', () => {
    const route = planRoute(basePlan());
    expect(route.length > 10).toBe(true);
    for (let i = 1; i < route.length; i++) {
      expect(route[i][0] === route[i - 1][0] && route[i][1] === route[i - 1][1]).toBe(false);
    }
  });

  it('orders every cue by distance along the day, not by leg', () => {
    const plan = basePlan({
      stops: [{ runId: 'w#2', structureId: 'w#2:p0' }, { runId: 'w#1', structureId: 'w#1:p1' },
              { runId: 'w#1', structureId: 'w#1:p0' }],
      changes: [{ beforeRunId: 'w#2', rodId: 'R5', to: 'DD1' }],
    });
    const cues = planCues(plan);
    expect(cues.length).toBe(4);
    for (let i = 1; i < cues.length; i++) expect(cues[i].atM >= cues[i - 1].atM).toBe(true);
    expect(cues[0].kind).toBe('stop');
    expect(cues.some((c) => c.kind === 'change')).toBe(true);
  });

  it('gives every leg geometry, so nothing has to guess where it went', () => {
    const plan = basePlan();
    expect(plan.legs.every((l) => Array.isArray(l.coordinates) && l.coordinates.length >= 2)).toBe(true);
  });
});

describe('plan-candidates — resolving a pass to a real structure', () => {
  const features = [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-80.7000, 34.3800] },
      properties: { kind: 'hump', id: 'hump_7', depth_ft: 41, area_acres: 5.6, relief_ft: 28 } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-80.6500, 34.3900] },
      properties: { kind: 'ledge', id: 'ledge_88', depth_ft: 32.2, drop_ft: 6.3, slope_ft_per_100ft: 38.4 } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-80.6100, 34.3700] },
      properties: { kind: 'creek_mouth', name: 'Crooked Creek', cove_m: 451, deepest_within_m: 9 } },
  ];
  const idx = structureIndex(features);

  it('indexes only what it can place', () => {
    expect(idx.n).toBe(3);
    expect(structureIndex(null, undefined).n).toBe(0);
  });

  it('finds the structure and carries its id and depth', () => {
    const hit = resolveStructure([-80.70005, 34.38002], 'hump', 60, idx);
    expect(hit.id).toBe('hump_7');
    expect(hit.depthFt).toBe(41);
    expect(hit.what.includes('crown 41 ft')).toBe(true);
    expect(hit.matchM <= 60).toBe(true);
  });

  it('will not return the wrong kind, or one that is too far', () => {
    expect(resolveStructure([-80.70005, 34.38002], 'ledge', 60, idx)).toBe(null);
    expect(resolveStructure([-80.7500, 34.3800], 'hump', 60, idx)).toBe(null);
    expect(resolveStructure([-80.7000, 34.3800], 'hump', 60, null)).toBe(null);
  });

  it('never reads deepest_within_m as a depth', () => {
    // A creek mouth carries `deepest_within_m: 9`. That is metres of something, not 9 ft of
    // water, and reading it as depth would put a stop on a hole that is not there.
    const hit = resolveStructure([-80.6100, 34.3700], 'creek_mouth', 60, idx);
    expect(hit.depthFt).toBe(null);
    expect(hit.what.includes('Crooked Creek')).toBe(true);
  });
});

describe('plan-candidates — what reaches the model', () => {
  const runs = [{
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: Array.from({ length: 41 }, (_, i) => [-80.72 + i * 0.001, 34.38]) },
    properties: {
      depth_ft: 22, length_m: 3690, routable: true, ledge_n: 4, ledge_min_ft: 8, ledge_max_ft: 40,
      near: Array.from({ length: 30 }, (_, k) => ({ s: 100 + k * 110, t: k % 2 ? 'hump' : 'point', d: 20 + k })),
    },
  }];

  it('hands the model ids, never coordinates', () => {
    const [c] = selectCandidates(runs, { ramp: LAUNCH, slug: 'w', usableAh: 200, windowMin: 600 });
    const m = forModel(c);
    const json = JSON.stringify(m);
    expect(json.includes('-80.7')).toBe(false);
    expect(json.includes('coordinates')).toBe(false);
    expect(m.structures.every((s) => typeof s.id === 'string')).toBe(true);
  });

  it('caps the list and says that it did', () => {
    const [c] = selectCandidates(runs, { ramp: LAUNCH, slug: 'w', usableAh: 200, windowMin: 600 });
    const m = forModel(c);
    expect(m.structuresShown).toBe(12);
    expect(m.structuresTotal > m.structuresShown).toBe(true);
    // Shown in the order the boat meets them, even though they were picked by weight.
    for (let i = 1; i < m.structures.length; i++) {
      expect(m.structures[i].atM >= m.structures[i - 1].atM).toBe(true);
    }
  });

  it('gives the candidate a line, so a leg can be drawn and a stop can be placed', () => {
    const [c] = selectCandidates(runs, { ramp: LAUNCH, slug: 'w', usableAh: 200, windowMin: 600 });
    expect(Array.isArray(c.coordinates) && c.coordinates.length >= 2).toBe(true);
    expect(c.passes.every((p) => Array.isArray(p.at) && p.at.length === 2)).toBe(true);
    expect(c.passes.every((p) => typeof p.id === 'string')).toBe(true);
  });

  it('leaves depth null when no structure file was supplied, rather than guessing', () => {
    const [c] = selectCandidates(runs, { ramp: LAUNCH, slug: 'w', usableAh: 200, windowMin: 600 });
    expect(c.passes.every((p) => p.depthFt === null && p.structureId === null)).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// TRANSIT IS ROUTED OVER WATER, OR IT SAYS IT IS NOT — 2026-08-09
//
// PLAN_SCHEMA_V2 has carried "Transit is still straight-line ... wire waterPath in" as advice
// through three revisions and it was built in none, so every transit in every plan Ryan has run
// was a straight line between two leg ends. That understates the amp-hours on a reservoir and it
// can cross land. Troll legs are safe by provenance -- they are stitched contour geometry out of
// trolling_runs.geojson -- and transits never were.
// ---------------------------------------------------------------------------
describe('plan-assemble — an unrouted transit says so', () => {
  it('marks a straight line, warns about it, and fails validatePlan', () => {
    const plan = assemblePlan({
      candidates: [A, B], launch: LAUNCH, loadout: LOADOUT,
      slug: 'wateree_lake', water: 'Lake Wateree, SC', ramp: 'Clearwater Cove',
      launchTime: '06:00', returnTime: '15:00', usableAh: 80,
    });
    const transits = plan.legs.filter((l) => l.type === 'transit');
    expect(transits.length).toBeGreaterThan(0);
    for (const t of transits) expect(t.unrouted).toBe(true);
    expect(plan.warnings.some((w) => w.includes('straight line'))).toBe(true);
    const bad = validatePlan(plan);
    expect(bad.some((b) => b.includes('not water-routed'))).toBe(true);
  });

  it('says nothing when the router answered', () => {
    const plan = basePlan();
    for (const l of plan.legs) expect(l.unrouted).toBeUndefined();
    expect(plan.warnings.some((w) => w.includes('straight line'))).toBe(false);
    expect(validatePlan(plan).length).toBe(0);
  });

  it('falls back per pair — a router that answers null for one leg marks only that leg', () => {
    let n = 0;
    const flaky = (a, b) => (n++ === 0 ? null : routed(a, b));
    const plan = assemblePlan({
      transit: flaky,
      candidates: [A, B], launch: LAUNCH, loadout: LOADOUT,
      slug: 'wateree_lake', water: 'Lake Wateree, SC', ramp: 'Clearwater Cove',
      launchTime: '06:00', returnTime: '15:00', usableAh: 80,
    });
    const transits = plan.legs.filter((l) => l.type === 'transit');
    expect(transits[0].unrouted).toBe(true);
    expect(transits.slice(1).every((t) => t.unrouted === undefined)).toBe(true);
  });

  it('a routed transit keeps the geometry the router gave it', () => {
    const bend = [-80.7250, 34.3900];
    const viaBend = (a, b) => ({ distanceM: metresBetween(a, bend) + metresBetween(bend, b),
                                 coordinates: [a, bend, b] });
    const plan = basePlan({ transit: viaBend });
    const t = plan.legs.find((l) => l.type === 'transit');
    expect(t.coordinates.length).toBe(3);
    expect(t.coordinates[1]).toEqual(bend);
    // The spine still adds up over a longer path -- lengthM is the routed distance, not the
    // straight one, which is the whole point of routing it.
    expect(validatePlan(plan).length).toBe(0);
  });
});
