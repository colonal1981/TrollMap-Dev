import { describe, it, expect } from './expect-shim.mjs';
import { assemblePlan } from '../js/modules/plan-assemble.js';
import { orientLegs, metresBetween, selectCandidates } from '../js/modules/plan-candidates.js';
import { planArgsFrom } from '../js/modules/plan-prompt.js';
import { trackName } from '../js/modules/plan-tracks.js';
import { planToTimeline } from '../js/modules/plan-to-timeline.js';
import { prefetchTransits } from '../js/modules/smart-plan-v2.js';

// ---------------------------------------------------------------------------
// Why this test exists
//
// Ryan, 2026-08-31, looking at a Colonel Creek plan with seven trolling legs and
// eight transits between them:
//
//   "its because they have no concept of running back the other direction...
//    there should be almost no deadheading there"
//
// He was right, and it was structural rather than a tuning problem. A runId
// could appear in a plan exactly once -- plan-prompt.js refuses the second one
// by name -- so a pass could be fished once, and the only way back over water
// that had just produced was a transit to somewhere else.
//
// Measured off that plan's own GPX, and off the Clearwater plan from the same
// morning:
//
//                     in-field deadhead   water fished   deadhead
//   Colonel, as run          2093 m          4272 m        33%
//   Colonel, fished back     1638 m          5455 m        23%
//   Clearwater, as run       1531 m          3433 m        31%
//   Clearwater, fished back   999 m          5211 m        16%
//
// The Colonel geometry is the whole argument in one pair of legs: L1 finished at
// 34.372471,-80.786435, the plan paid 499 m of deadhead to reach L2's far end,
// and L2 ran back to finish 77 m from where L1 had ended. The boat crossed that
// water three times and fished it once.
//
// Direction was NOT the bug and is not what this tests. orientLegs() already
// solved which way round each pass runs; re-solving both plans by brute force
// moves Colonel by 404 m and Clearwater by nothing. What was missing was the
// second pass.
// ---------------------------------------------------------------------------

const LAUNCH = [-80.7300, 34.3800];

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
      id: `${id}:p${k}`, atM: p.atM, type: p.type, offM: 30, weight: 3,
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
    { id: 'R5', rig: 'snap', role: 'troll', lure: 'Flutter Spoon 3/4oz', color: 'Chrome' },
    { id: 'R6', rig: 'snap', role: 'cast', lure: 'Walking Bait', color: 'Bone' },
  ],
};

const A = leg('w#1', -80.7200, -80.6800, 34.3800, [
  { atM: 1200, type: 'hump', structureId: 'hump_7', what: 'offshore hump, 5.6 ac, crown 41 ft', depthFt: 41 },
]);
const B = leg('w#2', -80.6700, -80.6400, 34.3850, []);
const routed = (a, b) => ({ distanceM: metresBetween(a, b), coordinates: [a, b] });

function build(extra = {}, cands = [A, B]) {
  return assemblePlan({
    transit: routed,
    candidates: cands, launch: LAUNCH, loadout: LOADOUT,
    slug: 'wateree_lake', water: 'Lake Wateree, SC', ramp: 'Clearwater Cove',
    launchTime: '06:00', returnTime: '15:00', usableAh: 80,
    deploy: { 'w#1': { port: 'R1', starboard: 'R5' }, 'w#2': { port: 'R2', starboard: 'R5' } },
    ...extra,
  });
}

describe('orientLegs — where the boat stands when the leg is done', () => {
  const one = { start: [-80.72, 34.38], end: [-80.68, 34.38] };
  const two = { start: [-80.67, 34.385], end: [-80.64, 34.385] };

  it('a leg with no pass count is fished once and finishes where it always did', () => {
    const [f] = orientLegs([one], LAUNCH);
    expect(f.passes).toBe(1);
    expect(f.finish).toEqual(f.end);
  });

  it('an even number of passes finishes at the end it came in by', () => {
    const [f] = orientLegs([{ ...one, trollPasses: 2 }], LAUNCH);
    expect(f.passes).toBe(2);
    expect(f.finish).toEqual(f.start);
    expect(f.finish).not.toEqual(f.end);
  });

  it('an odd number of passes finishes at the far end', () => {
    const [f] = orientLegs([{ ...one, trollPasses: 3 }], LAUNCH);
    expect(f.finish).toEqual(f.end);
  });

  it('start and end still mean the FIRST pass, so leg geometry is untouched', () => {
    const [a] = orientLegs([one], LAUNCH);
    const [b] = orientLegs([{ ...one, trollPasses: 4 }], LAUNCH);
    expect(b.flipped).toBe(a.flipped);
    expect(b.start).toEqual(a.start);
    expect(b.end).toEqual(a.end);
  });

  it('garbage in the field is one pass, never NaN and never zero', () => {
    for (const bad of [0, -2, 1.5, 'two', null, {}, Infinity, NaN]) {
      const [f] = orientLegs([{ ...one, trollPasses: bad }], LAUNCH);
      expect(f.passes).toBe(bad === 1.5 ? 1 : 1);
      expect(Array.isArray(f.finish)).toBe(true);
    }
  });

  it('the chain is solved from finish, so a doubled leg changes the next one', () => {
    // Two legs end to end. Fished once, leg one leaves the boat at its far end and leg two is
    // entered from the near side; fished twice it leaves the boat back at the ramp side, and the
    // solver must price the next hop from THERE and not from the end of the first pass.
    const once = orientLegs([one, two], LAUNCH);
    const twice = orientLegs([{ ...one, trollPasses: 2 }, two], LAUNCH);
    expect(metresBetween(once[0].finish, once[1].start))
      .not.toBe(metresBetween(twice[0].finish, twice[1].start));
  });
});

describe('the assembler fishes it back', () => {
  it('one pass is exactly what it was', () => {
    const plan = build();
    const troll = plan.legs.filter((l) => l.type === 'troll');
    expect(troll.length).toBe(2);
    for (const l of troll) expect(l.pass).toBe(undefined);
  });

  it('two passes on one run is two legs, not one leg counted twice', () => {
    const plan = build({}, [{ ...A, trollPasses: 2 }, B]);
    const troll = plan.legs.filter((l) => l.type === 'troll');
    expect(troll.length).toBe(3);
    const mine = troll.filter((l) => l.runId === 'w#1');
    expect(mine.length).toBe(2);
    expect(mine.map((l) => l.pass)).toEqual([1, 2]);
    expect(mine.map((l) => l.ofPasses)).toEqual([2, 2]);
    // Distinct ids, so the GPX draws two tracks and the phone can tell them apart.
    expect(mine[0].id).not.toBe(mine[1].id);
  });

  it('the second pass runs the other way down the same line', () => {
    const plan = build({}, [{ ...A, trollPasses: 2 }, B]);
    const [p1, p2] = plan.legs.filter((l) => l.runId === 'w#1');
    expect(p2.coordinates).toEqual(p1.coordinates.slice().reverse());
    expect(!!p2.trolledReversed).toBe(!p1.trolledReversed);
    expect(p2.lengthM).toBe(p1.lengthM);
  });

  it('a mark is mirrored on the pass that meets it the other way round', () => {
    const plan = build({}, [{ ...A, trollPasses: 2 }, B]);
    const [p1, p2] = plan.legs.filter((l) => l.runId === 'w#1');
    const m1 = p1.marks.find((m) => m.id === 'w#1:p0');
    const m2 = p2.marks.find((m) => m.id === 'w#1:p0');
    expect(m2.atM).toBe(Math.round(p1.lengthM - m1.atM));
    // The coordinate never moves. Only the distance along does.
    expect(m2.at).toEqual(m1.at);
  });

  it('the stop happens once, on the first pass', () => {
    const plan = build({
      stops: [{ runId: 'w#1', structureId: 'w#1:p0', rods: ['R6'], durationMin: 15 }],
    }, [{ ...A, trollPasses: 2 }, B]);
    const [p1, p2] = plan.legs.filter((l) => l.runId === 'w#1');
    expect(p1.stops.length).toBe(1);
    expect(p2.stops.length).toBe(0);
    // And the fifteen minutes are not charged twice.
    expect(p2.estDurationMin).toBeLessThan(p1.estDurationMin);
  });

  it('the distance spine still adds up, which is what the phone reads', () => {
    const plan = build({}, [{ ...A, trollPasses: 3 }, B]);
    let at = 0;
    for (const l of plan.legs) { expect(l.startM).toBe(at); at += l.lengthM; }
    expect(plan.budget.totalM).toBe(at);
    expect(plan.budget.fishingM + plan.budget.transitM).toBe(plan.budget.totalM);
  });

  it('the water fished goes up by exactly one pass length per extra pass', () => {
    const once = build();
    const twice = build({}, [{ ...A, trollPasses: 2 }, B]);
    const oneLeg = once.legs.find((l) => l.runId === 'w#1').lengthM;
    expect(twice.budget.fishingM - once.budget.fishingM).toBe(oneLeg);
  });
});

describe('what fishing it back is worth, on the water it was reported on', () => {
  // THE REAL COLONEL CREEK FIELD, endpoint for endpoint out of EXPORT.GPX 14 -- the plan Ryan was
  // looking at when he said the app has no concept of running back the other direction. Seven
  // legs, eight transits, and the ramp where he actually launched.
  const ENDS = [
    [[-80.789871, 34.377413], [-80.786435, 34.372471]],   // L1
    [[-80.789912, 34.369243], [-80.785676, 34.372761]],   // L2
    [[-80.781891, 34.375305], [-80.788600, 34.376798]],   // L3
    [[-80.787458, 34.378876], [-80.787550, 34.374257]],   // L4
    [[-80.788993, 34.371032], [-80.782908, 34.376086]],   // L5
    [[-80.786098, 34.377496], [-80.791669, 34.377496]],   // L6
    [[-80.790139, 34.377153], [-80.785348, 34.373077]],   // L7
  ];
  const RAMP = [-80.797237, 34.368854];
  const field = (counts) => ENDS.map(([a, b], i) => {
    const coordinates = Array.from({ length: 11 }, (_, k) =>
      [a[0] + (b[0] - a[0]) * k / 10, a[1] + (b[1] - a[1]) * k / 10]);
    return {
      runId: `c#${i + 1}`, runIndex: i + 1, startM: 0, depthFt: 21,
      lengthM: metresBetween(a, b), start: a, end: b, coordinates,
      passes: [], support: null,
      trollPasses: counts[i] > 1 ? counts[i] : undefined,
    };
  });
  const colonel = (counts) => assemblePlan({
    transit: routed, candidates: field(counts), launch: RAMP, loadout: LOADOUT,
    slug: 'wateree_lake', water: 'Lake Wateree, SC', ramp: 'Clearwater Cove',
    launchTime: '06:00', returnTime: '15:00', usableAh: 80,
    deploy: Object.fromEntries(ENDS.map((_, i) =>
      [`c#${i + 1}`, { port: 'R1', starboard: 'R5' }])),
  });

  it('reproduces the day he ran: seven legs, eight transits, a third of it deadhead', () => {
    const plan = colonel([1, 1, 1, 1, 1, 1, 1]);
    expect(plan.legs.filter((l) => l.type === 'troll').length).toBe(7);
    expect(plan.legs.filter((l) => l.type === 'transit').length).toBe(8);
    // Straight-line here rather than water-routed, so this is the floor and not the 2093 m he
    // actually paid -- but it is the same third of the day.
    const inField = plan.legs.filter((l) => l.type === 'transit' && l.role !== 'return')
      .slice(1).reduce((t, l) => t + l.lengthM, 0);
    expect(Math.round(inField)).toBe(2042);
  });

  it('fishing two of them back spends LESS deadhead and fishes 1183 m more water', () => {
    const once = colonel([1, 1, 1, 1, 1, 1, 1]);
    const back = colonel([1, 2, 1, 1, 1, 1, 2]);
    expect(back.budget.transitM).toBeLessThan(once.budget.transitM);
    expect(back.budget.fishingM - once.budget.fishingM).toBe(1183);
    // 33% of the in-field distance to 23%, which is the measurement this whole change was made on.
    const share = (p) => p.budget.transitM / p.budget.totalM;
    expect(share(back)).toBeLessThan(share(once));
    expect(Math.round(share(once) * 100)).toBe(51);
    expect(Math.round(share(back) * 100)).toBe(42);
  });

  it('doubling every leg is not the answer, and the numbers say so', () => {
    // Worth pinning: the saving comes from WHICH legs get fished back, not from more passes.
    // Doubled everywhere, the deadhead goes back up -- the boat keeps finishing at the wrong end.
    const chosen = colonel([1, 2, 1, 1, 1, 1, 2]);
    const all = colonel([2, 2, 2, 2, 2, 2, 2]);
    expect(all.budget.transitM).toBeGreaterThan(chosen.budget.transitM);
  });

  it('the transit after a doubled leg starts where the boat actually is', () => {
    const plan = colonel([1, 2, 1, 1, 1, 1, 2]);
    const idx = plan.legs.findIndex((l) => l.runId === 'c#2' && l.pass === 2);
    const lastPass = plan.legs[idx];
    const next = plan.legs[idx + 1];
    expect(next.type).toBe('transit');
    const stood = lastPass.coordinates[lastPass.coordinates.length - 1];
    expect(metresBetween(next.coordinates[0], stood)).toBeLessThan(1);
  });

  it('the passes stop at the first one that ends after he is due back, and say which', () => {
    const plan = colonel([6, 1, 1, 1, 1, 1, 1]);
    const mine = plan.legs.filter((l) => l.runId === 'c#1');
    expect(mine.length).toBe(6);
    const short = assemblePlan({
      transit: routed, candidates: field([6, 1, 1, 1, 1, 1, 1]), launch: RAMP, loadout: LOADOUT,
      slug: 'wateree_lake', launchTime: '06:00', returnTime: '07:00', usableAh: 80,
      deploy: Object.fromEntries(ENDS.map((_, i) =>
        [`c#${i + 1}`, { port: 'R1', starboard: 'R5' }])),
    });
    expect(short.legs.filter((l) => l.runId === 'c#1').length).toBeLessThan(6);
    expect(short.warnings.some((w) => /asked for 6 passes/.test(w) && /07:00/.test(w))).toBe(true);
  });
});

describe('the model asks for it, and the app refuses what it cannot fish', () => {
  const CANDS = [A, B];
  const res = (legs) => ({
    safety: { isGo: true, warning: '', rampEvaluation: 'sheltered' },
    loadout: { rods: [{ id: 'R1', lure: 'A-Rig Medium', color: 'Chrome', role: 'troll' }] },
    legs, stops: [], changes: [], notes: {},
  });
  const base = { speedMph: 2.0, deploy: { port: 'R1', starboard: 'R5' }, why: 'this water, now' };

  it('carries a whole number of passes through to the assembler', () => {
    const a = planArgsFrom(res([{ runId: 'w#1', ...base, trollPasses: 2 }]), CANDS);
    expect(a.candidates[0].trollPasses).toBe(2);
  });

  it('leaves the field off entirely when the model does not ask', () => {
    const a = planArgsFrom(res([{ runId: 'w#1', ...base }]), CANDS);
    expect(a.candidates[0].trollPasses).toBe(undefined);
  });

  it('refuses half a pass and says so rather than rounding it into existence', () => {
    for (const bad of [0, -1, 1.5, 'twice', {}]) {
      const a = planArgsFrom(res([{ runId: 'w#1', ...base, trollPasses: bad }]), CANDS);
      expect(a.candidates[0].trollPasses).toBe(undefined);
      expect(a.problems.some((p) => /trolling passes/.test(p))).toBe(true);
    }
  });

  it('does not clobber the structure list, which is also called passes', () => {
    const a = planArgsFrom(res([{ runId: 'w#1', ...base, trollPasses: 2 }]), CANDS);
    expect(Array.isArray(a.candidates[0].passes)).toBe(true);
    expect(a.candidates[0].passes[0].id).toBe('w#1:p0');
  });

  it('still refuses the same run listed twice — that is what the count is for', () => {
    const a = planArgsFrom(res([{ runId: 'w#1', ...base }, { runId: 'w#1', ...base }]), CANDS);
    expect(a.candidates.length).toBe(1);
    expect(a.problems.some((p) => /listed twice/.test(p))).toBe(true);
  });
});

describe('the name on the unit says which pass it is', () => {
  it('reads as the same water again, not a coincidence of depth', () => {
    expect(trackName({ id: 'L1', type: 'troll', depthFt: 21.4 })).toBe('L1 · 21 ft');
    expect(trackName({ id: 'L2', type: 'troll', depthFt: 21.4, pass: 2 })).toBe('L2 · 21 ft back');
    expect(trackName({ id: 'L3', type: 'troll', depthFt: 21.4, pass: 3 })).toBe('L3 · 21 ft again');
    // Inside the 24 characters the 93sv shows.
    expect(trackName({ id: 'L12', type: 'troll', depthFt: 21.4, pass: 3 }).length)
      .toBeLessThan(25);
  });
});

describe('the router is asked for the pairs the assembler will actually walk', () => {
  it('prefetches from where the boat finishes, not from the end of the first pass', async () => {
    const asked = [];
    const router = async (a, b) => {
      asked.push([a, b]);
      return { distanceM: metresBetween(a, b), coordinates: [a, b] };
    };
    const cands = [{ ...A, trollPasses: 2 }, B];
    const lookup = await prefetchTransits(cands, LAUNCH, router);
    const facing = orientLegs(cands, LAUNCH);
    // The hop out of the doubled leg is the one that would have been fetched wrong.
    expect(lookup(facing[0].finish, facing[1].start)).not.toBe(null);
    expect(asked.some(([a]) => metresBetween(a, facing[0].finish) < 1)).toBe(true);
  });
});

describe('the timeline says it is the same water again', () => {
  const plan = build({}, [{ ...A, trollPasses: 2 }, B]);
  const built = planToTimeline(plan, { depthBand: [15, 27] });
  const troll = built.timeline.filter((e) => e.type === 'troll' && e.legType !== 'transit');

  it('names the second pass as fished back, not as a second stretch', () => {
    const back = troll.find((e) => e.pass === 2);
    expect(back).toBeTruthy();
    expect(back.label).toMatch(/fished back/);
    expect(back.desc).toMatch(/same water as Leg 1, the other way/);
    expect(back.ofPasses).toBe(2);
  });

  it('leaves a single-pass leg reading exactly as it did', () => {
    const first = troll.find((e) => e.pass === undefined || e.pass === 1);
    expect(first.label).not.toMatch(/fished back/);
    expect(first.desc).not.toMatch(/same water/);
  });
});
