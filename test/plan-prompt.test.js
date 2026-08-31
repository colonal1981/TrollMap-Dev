import { describe, it, expect } from './expect-shim.mjs';
import {
  buildPlanRequest, parsePlanResponse, seatRods, planArgsFrom,
  resolveTackleName, stripLureAnnotation,
  ROD_IDS, ROD_RIG, FLUORO_RODS, SNAP_RODS,
} from '../js/modules/plan-prompt.js';
import { assemblePlan, validatePlan } from '../js/modules/plan-assemble.js';
import { TERMINAL_CONNECTION, connectionFor, canTakeSnap, unratedTypes, MAX_TIE_ONLY }
  from '../js/data/lure-knowledge.js';

// ---------------------------------------------------------------------------
// Why this test exists
//
// The rod model took three tries and two corrections from Ryan to get right,
// so it gets pinned down here rather than left to a comment:
//
//   - four rods carry a 20 lb fluoro leader, two carry swivel snaps, and that
//     is permanent terminal tackle
//   - a lure that cannot take a snap can only go on a leader rod, because the
//     snap's metal and weight kill the action
//   - therefore at most four tie-only lures, or he is cutting a snap off in a
//     moving kayak
//   - a plan need not rig all six; the rest stay staged with whatever is on
//     them, and must not be deployed or changed by a plan that cannot name them
//
// The other half is the same guard as the assembler: the model names ids and
// never emits a position.
// ---------------------------------------------------------------------------

const TIE = 'DD2 Crankbait (16-20ft)';
const TIE2 = 'Squarebill Crankbait';
const TIE3 = 'MR Crankbait (6-12ft)';
const TIE4 = 'SR Crankbait (3-5ft)';
const TIE5 = '3/8oz Spinnerbait';
const SNAP = 'Nichols Lake Fork Flutter Spoon 3/4oz';
const SNAP2 = 'A-Rig Medium (~2.65oz) – 4.6" Swimbait';

const CONN = {
  [TIE]: 'tie', [TIE2]: 'tie', [TIE3]: 'tie', [TIE4]: 'tie', [TIE5]: 'tie',
  [SNAP]: 'snap', [SNAP2]: 'snap',
};
const connectionOf = (name) => CONN[name] || null;
const TACKLE = Object.keys(CONN);

function rod(id, lure, extra = {}) { return { id, lure, color: 'Chrome', role: 'troll', ...extra }; }

const CANDS = [
  { runId: 'w#1', runIndex: 1, lengthM: 2500, depthFt: 24, start: [-80.72, 34.38], end: [-80.70, 34.38],
    coordinates: [[-80.72, 34.38], [-80.70, 34.38]],
    passes: [{ id: 'w#1:p0', atM: 900, type: 'hump', offM: 30, weight: 3, at: [-80.71, 34.38],
               structureId: 'hump_9', what: 'offshore hump, crown 18 ft', depthFt: 18 }] },
  { runId: 'w#2', runIndex: 2, lengthM: 1800, depthFt: 31, start: [-80.69, 34.39], end: [-80.67, 34.39],
    coordinates: [[-80.69, 34.39], [-80.67, 34.39]], passes: [] },
];

describe('lure-knowledge — the terminal connection table', () => {
  it('holds the rulings Ryan gave, not inferences', () => {
    expect(connectionFor('crankbait_dd2')).toBe('tie');
    expect(connectionFor('topwater_troll')).toBe('tie');
    expect(connectionFor('spinnerbait')).toBe('tie');
    expect(connectionFor('umbrella_rig')).toBe('snap');
    expect(connectionFor('flutter_spoon')).toBe('snap');
    expect(connectionFor('chatterbait')).toBe('snap');
    expect(connectionFor('bucktail')).toBe('snap');
    expect(connectionFor('jighead')).toBe('snap');
    expect(connectionFor('swimbait_paddle')).toBe('snap');
    expect(connectionFor('marabou_jig')).toBe('snap');
    expect(connectionFor('lipless')).toBe('either');
    expect(connectionFor('cast_only')).toBe('tie');
    expect(connectionFor('jig_football')).toBe('tie');
  });

  it('defaults an unknown type to tie, the direction that cannot hurt the lure', () => {
    expect(connectionFor('some_type_added_next_year')).toBe('tie');
    expect(canTakeSnap('some_type_added_next_year')).toBe(false);
    expect(canTakeSnap('lipless')).toBe(true);
  });

  it('names the gaps instead of hiding them in the default', () => {
    const gaps = unratedTypes([{ type: 'crankbait_dd2' }, { type: 'brand_new_thing' }]);
    expect(gaps).toEqual(['brand_new_thing']);
    expect(unratedTypes(null)).toEqual([]);
  });

  it('caps tie-only lures at the number of leader rods', () => {
    expect(MAX_TIE_ONLY).toBe(FLUORO_RODS.length);
  });
});

describe('plan-prompt — the boat', () => {
  it('is four leader rods and two snap rods, and that is not configurable', () => {
    expect(ROD_IDS.length).toBe(6);
    expect(FLUORO_RODS.length).toBe(4);
    expect(SNAP_RODS.length).toBe(2);
    expect(Object.isFrozen(ROD_RIG)).toBe(true);
  });
});

describe('plan-prompt — seating lures on rods that can carry them', () => {
  it('puts tie-only lures on leader rods, wherever the model put them', () => {
    const { rods, map } = seatRods([rod('R5', TIE), rod('R6', TIE2)], connectionOf);
    const seated = rods.filter((r) => r.lure);
    expect(seated.every((r) => r.rig === 'fluoro')).toBe(true);
    expect(Object.keys(map).length).toBe(2);
  });

  it('fills the snap rods first, because those are the cheap ones to change', () => {
    const { rods } = seatRods([rod('R1', SNAP), rod('R2', SNAP2)], connectionOf);
    const on = Object.fromEntries(rods.filter((r) => r.lure).map((r) => [r.lure, r.id]));
    expect(SNAP_RODS.includes(on[SNAP])).toBe(true);
    expect(SNAP_RODS.includes(on[SNAP2])).toBe(true);
  });

  it('leaves a legal assignment alone', () => {
    const { map } = seatRods([rod('R1', TIE), rod('R5', SNAP)], connectionOf);
    expect(Object.keys(map).length).toBe(0);
  });

  it('says so when the loadout cannot be seated at all', () => {
    const five = [rod('R1', TIE), rod('R2', TIE2), rod('R3', TIE3), rod('R4', TIE4), rod('R5', TIE5)];
    const { problems } = seatRods(five, connectionOf);
    expect(problems.some((p) => p.includes('cutting a snap off'))).toBe(true);
  });

  it('four tie-only lures is fine — that is exactly the boat', () => {
    const four = [rod('R1', TIE), rod('R2', TIE2), rod('R3', TIE3), rod('R4', TIE4)];
    const { problems, rods } = seatRods(four, connectionOf);
    expect(problems.length).toBe(0);
    expect(rods.filter((r) => r.lure).every((r) => r.rig === 'fluoro')).toBe(true);
  });

  it('returns the rods it was not asked to rig as staged, with no lure invented', () => {
    const { rods } = seatRods([rod('R1', TIE), rod('R5', SNAP)], connectionOf);
    expect(rods.length).toBe(6);
    const staged = rods.filter((r) => r.staged);
    expect(staged.length).toBe(4);
    expect(staged.every((r) => r.lure === null)).toBe(true);
    expect(rods.every((r) => r.rig === ROD_RIG[r.id])).toBe(true);
  });

  it('has no opinion when nothing tells it what a lure needs', () => {
    const { problems, map } = seatRods([rod('R5', TIE), rod('R6', TIE2)], null);
    expect(problems.length).toBe(0);
    expect(Object.keys(map).length).toBe(0);
  });
});

describe('plan-prompt — the request', () => {
  const req = buildPlanRequest({
    candidates: [{ runId: 'w#1', lengthM: 2500, depthFt: 24,
                   structures: [{ id: 'w#1:p0', type: 'hump', atM: 900, depthFt: 18, what: 'hump' }] }],
    water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-08-10',
    launchTime: '06:00', returnTime: '15:00', species: ['Striped Bass'],
    conditions: { waterTempF: 84 }, tackle: TACKLE, snapEligible: [SNAP, SNAP2], usableAh: 80,
  });

  it('tells the model which lures may hang off a snap and which may not', () => {
    expect(req.user.includes(SNAP)).toBe(true);
    expect(req.user.includes('MUST BE TIED DIRECT')).toBe(true);
    expect(req.user.includes('AT MOST FOUR tie-only lures')).toBe(true);
  });

  it('asks for six considered choices, not filled slots', () => {
    expect(req.user.includes('THE LURE CHOICE IS THE WHOLE POINT')).toBe(true);
  });

  it('asks for ids and forbids positions', () => {
    expect(req.user.includes('NEVER write a latitude')).toBe(true);
    expect(/"lat"|"lon"|latitude:/.test(req.user)).toBe(false);
  });

  // -------------------------------------------------------------------------------------------
  // PLAN_SCHEMA_V2's "MODEL DECIDES" table gives the model "which runId, in which order". So
  // when the plan of 2026-08-09 came back spending 46% of the day deadheading — 12790 m of
  // 28040, with one 9687 m hop between two legs that were each near the ramp — the answer was
  // not to reorder behind it. It was that nothing had ever told it what a hop costs. These
  // assertions are the telling; test/plan-weights.test.js pins the distances themselves.
  // -------------------------------------------------------------------------------------------
  it('hands the model the distances between legs and tells it they are the cost of the order', () => {
    const withHops = buildPlanRequest({
      candidates: [{ runId: 'w#1', lengthM: 2500, depthFt: 24, transitFromRampM: 400,
                     transitToRampM: 5200, transitToM: { 'w#2': 9687 }, structures: [] },
                   { runId: 'w#2', lengthM: 2200, depthFt: 26, transitFromRampM: 600,
                     transitToRampM: 2800, transitToM: { 'w#1': 9420 }, structures: [] }],
      water: 'Lake Wateree, SC', tackle: TACKLE,
    });
    // the numbers reach it at all
    expect(withHops.user).toContain('9687');
    // and it is told what they are for
    expect(withHops.user).toContain('transitToM');
    expect(withHops.user).toContain('transitToRampM');
    expect(withHops.user).toMatch(/ORDER THE LEGS TO SPEND AS LITTLE OF THE DAY DEADHEADING/);
    // the specific trap: near the ramp is not the same as near each other
    expect(withHops.user).toMatch(/close\s+to the ramp can still be six miles from EACH OTHER/);
  });

  it('carries the day and the candidates as data, not prose', () => {
    expect(req.user.includes('"waterTempF": 84')).toBe(true);
    expect(req.user.includes('w#1:p0')).toBe(true);
    expect(req.system.includes('one valid JSON object')).toBe(true);
  });
});

describe('plan-prompt — reading the answer', () => {
  it('digs the object out of fences and chatter', () => {
    expect(parsePlanResponse('```json\n{"a":1}\n```').a).toBe(1);
    expect(parsePlanResponse('Sure! {"a":2} hope that helps').a).toBe(2);
    let threw = false;
    try { parsePlanResponse('no object here'); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  // -------------------------------------------------------------------------------------------
  // A TRAILING COMMA IS A TYPO IN THE PUNCTUATION, NOT A WRONG ANSWER
  //
  // Ryan, 2026-08-31, building a Pick Water striper day: "The model did not answer usably:
  // Unexpected token ']', ..." }, ], "chan"... is not valid JSON". One character that carries no
  // meaning in JSON, and the whole day went with it -- the candidates, the ordering, the rigging,
  // every number the app had already computed.
  // -------------------------------------------------------------------------------------------
  it('repairs a trailing comma rather than losing the day over one character', () => {
    const out = parsePlanResponse('{ "legs": [ { "runId": "w#1" }, ], "changes": [], }');
    expect(out.legs.length).toBe(1);
    expect(out.legs[0].runId).toBe('w#1');
    expect(out._appRepairs.length).toBe(1);
    expect(out._appRepairs[0]).toMatch(/2 trailing commas/);
  });

  it('never touches a comma inside the model\'s own prose', () => {
    // `why` and `presentation` are free text. A blind regex cannot tell a comma in the syntax
    // from a comma in a sentence, and would edit what the model wrote.
    const out = parsePlanResponse('{ "legs": [{ "why": "work it slow, ]" }], "changes": [] }');
    expect(out.legs[0].why).toBe('work it slow, ]');
    expect(out._appRepairs).toBe(undefined);
  });

  it('still fails loudly on an answer that is broken some other way', () => {
    let msg = '';
    try { parsePlanResponse('{ "legs": [ {"a": } ] }'); } catch (e) { msg = e.message; }
    expect(msg.length > 0).toBe(true);
    expect(/valid JSON/.test(msg)).toBe(true);
  });

  it('says out loud that it repaired something, on the plan\'s own problems list', () => {
    const res = parsePlanResponse('{ "safety": {"isGo": true}, "loadout": {"rods": []}, '
      + '"legs": [], "stops": [], "changes": [], }');
    const a = planArgsFrom(res, CANDS, { tackle: TACKLE, connectionOf });
    expect(a.problems.some((p) => /not valid JSON/.test(p))).toBe(true);
  });
});

describe('plan-prompt — turning the answer into assembler arguments', () => {
  const good = {
    safety: { isGo: true, warning: '', rampEvaluation: 'sheltered from the west' },
    loadout: { why: 'two cover the day', rods: [rod('R1', TIE), rod('R5', SNAP)] },
    legs: [
      { runId: 'w#2', speedMph: 2.0, deploy: { port: 'R1', starboard: 'R5' }, why: 'deep first' },
      { runId: 'w#1', speedMph: 1.8, deploy: { port: 'R1', starboard: 'R5' }, why: 'then the hump' },
    ],
    stops: [{ runId: 'w#1', structureId: 'w#1:p0', rods: ['R5'], durationMin: 20,
              why: 'crown stands proud', presentation: 'count it down', positioning: 'pedal-hover' }],
    changes: [{ beforeRunId: 'w#1', rodId: 'R5', to: SNAP2, why: 'bait moved up' }],
    notes: { scoutNotes: 'shad on the break' },
  };

  it('keeps the model\'s order', () => {
    const a = planArgsFrom(good, CANDS, { tackle: TACKLE, connectionOf });
    expect(a.candidates.map((c) => c.runId)).toEqual(['w#2', 'w#1']);
    expect(a.candidates[0].why).toBe('deep first');
    expect(a.problems.length).toBe(0);
  });

  it('rewrites every rod reference when it has to re-seat one', () => {
    // The model puts the crankbait on a snap rod and the spoon on a leader rod — both wrong, and
    // both fixable by swapping the labels, which must then follow through everywhere.
    const res = JSON.parse(JSON.stringify(good));
    res.loadout.rods = [rod('R5', TIE), rod('R1', SNAP)];
    res.legs = res.legs.map((l) => ({ ...l, deploy: { port: 'R5', starboard: 'R1' } }));
    res.stops[0].rods = ['R1'];
    res.changes[0].rodId = 'R1';

    const a = planArgsFrom(res, CANDS, { tackle: TACKLE, connectionOf });
    const byLure = Object.fromEntries(a.loadout.rods.filter((r) => r.lure).map((r) => [r.lure, r]));
    expect(byLure[TIE].rig).toBe('fluoro');
    expect(byLure[SNAP].rig).toBe('snap');
    // The spoon was on R1 everywhere; every reference must now point at wherever it went.
    const spoonId = byLure[SNAP].id;
    expect(a.stops[0].rods).toEqual([spoonId]);
    expect(a.changes[0].rodId).toBe(spoonId);
    expect(Object.values(a.deploy).every((d) => d.starboard === spoonId || d.port === spoonId)).toBe(true);
    expect(a.problems.some((p) => p.includes('re-seated'))).toBe(true);
  });

  it('will not deploy, cast with, or change a rod the plan never rigged', () => {
    const res = JSON.parse(JSON.stringify(good));
    res.legs[0].deploy = { port: 'R1', starboard: 'R3' };   // R3 is staged
    res.stops[0].rods = ['R4'];
    res.changes[0].rodId = 'R2';
    const a = planArgsFrom(res, CANDS, { tackle: TACKLE, connectionOf });
    expect(a.deploy['w#2']).toBe(undefined);
    expect(a.stops[0].rods).toEqual([]);
    expect(a.changes.length).toBe(0);
    expect(a.problems.filter((p) => p.includes('never rigged')).length).toBe(3);
  });

  it('drops runs it does not recognise and keeps a repeat only once', () => {
    const res = { ...good, legs: [...good.legs, { runId: 'w#1', deploy: { port: 'R1', starboard: 'R5' } },
                                                { runId: 'Secret Honey Hole' }] };
    const a = planArgsFrom(res, CANDS, { tackle: TACKLE, connectionOf });
    expect(a.candidates.length).toBe(2);
    expect(a.problems.some((p) => p.includes('listed twice'))).toBe(true);
    expect(a.problems.some((p) => p.includes('no such run'))).toBe(true);
  });

  it('flags a lure that is not in the bag but does not silently swap it', () => {
    const res = JSON.parse(JSON.stringify(good));
    res.loadout.rods[0].lure = 'Rapala Imagination Minnow';
    const a = planArgsFrom(res, CANDS, { tackle: TACKLE, connectionOf });
    expect(a.problems.some((p) => p.includes('not in the tackle inventory'))).toBe(true);
    expect(a.loadout.rods.some((r) => r.lure === 'Rapala Imagination Minnow')).toBe(true);
  });

  // -------------------------------------------------------------------------------------------
  // THE FALSE WARNING RYAN GOT ON THE WATER, 2026-08-09.
  //
  // The inventory calls it 'DD3 Crankbait (20-25ft)'. The model, handed that exact string, said
  // "DD3 Crankbait". Set.has() said no, and the plan told him two lures that were in the bag
  // were not. These pin the resolver that replaced it.
  // -------------------------------------------------------------------------------------------
  it('the depth suffix on an inventory name is not a missing lure', () => {
    const res = JSON.parse(JSON.stringify(good));
    res.loadout.rods[0].lure = 'DD2 Crankbait';          // TIE is 'DD2 Crankbait (16-20ft)'
    const a = planArgsFrom(res, CANDS, { tackle: TACKLE, connectionOf });
    expect(a.problems.some((p) => p.includes('not in the tackle inventory'))).toBe(false);
    // and the plan carries the inventory's own name from here on
    expect(a.loadout.rods.find((r) => r.id === 'R1').lure).toBe(TIE);
  });

  it('matches in the other direction too, when the model says more than the inventory', () => {
    const res = JSON.parse(JSON.stringify(good));
    res.loadout.rods[1].lure = `${SNAP} in chrome`;
    const a = planArgsFrom(res, CANDS, { tackle: TACKLE, connectionOf });
    expect(a.problems.some((p) => p.includes('not in the tackle inventory'))).toBe(false);
    expect(a.loadout.rods.find((r) => r.id === 'R5').lure).toBe(SNAP);
  });

  it('a lure resolved on shared words alone is reported as the guess it is', () => {
    const res = JSON.parse(JSON.stringify(good));
    res.loadout.rods[0].lure = 'Deep Crankbait, chartreuse';
    const a = planArgsFrom(res, CANDS, { tackle: TACKLE, connectionOf });
    expect(a.problems.some((p) => p.includes('closest thing by shared words'))).toBe(true);
    expect(a.problems.some((p) => p.includes('not in the tackle inventory'))).toBe(false);
  });

  it('a lure change ties on something the bag has, or says so', () => {
    const res = JSON.parse(JSON.stringify(good));
    res.changes[0].to = 'Nichols Lake Fork Flutter Spoon';   // SNAP without the weight
    const a = planArgsFrom(res, CANDS, { tackle: TACKLE, connectionOf });
    expect(a.changes[0].to).toBe(SNAP);
    expect(a.problems.some((p) => p.includes('ties on'))).toBe(false);

    const bad = JSON.parse(JSON.stringify(good));
    bad.changes[0].to = 'Rapala Imagination Minnow';
    const b = planArgsFrom(bad, CANDS, { tackle: TACKLE, connectionOf });
    expect(b.problems.some((p) => p.includes('ties on'))).toBe(true);
    expect(b.changes[0].to).toBe('Rapala Imagination Minnow');
  });

  it('survives an empty or hostile answer without inventing a plan', () => {
    const a = planArgsFrom({}, CANDS, { tackle: TACKLE, connectionOf });
    expect(a.candidates.length).toBe(0);
    expect(a.loadout.rods.length).toBe(6);
    expect(a.loadout.rods.every((r) => r.staged)).toBe(true);
    expect(a.problems.some((p) => p.includes('no legs'))).toBe(true);
    expect(a.safety.isGo).toBe(true);
    expect(planArgsFrom({ safety: { isGo: false, warning: '25 mph gusts' } }, CANDS).safety.isGo).toBe(false);
  });
});

// A stand-in for POST /water/{slug}/route. Without a transit function the assembler draws a
// straight line between two leg ends, marks it `unrouted`, and validatePlan() lists it -- which
// is correct, and not what these tests are about.
const routedTransit = (a, b) => ({
  distanceM: Math.hypot((b[0] - a[0]) * 91000, (b[1] - a[1]) * 111320), coordinates: [a, b],
});

describe('plan-prompt — straight into the assembler', () => {
  it('produces a valid plan with no translation in between', () => {
    const res = {
      safety: { isGo: true, rampEvaluation: 'fine' },
      loadout: { rods: [rod('R1', TIE), rod('R5', SNAP)] },
      legs: [{ runId: 'w#1', deploy: { port: 'R1', starboard: 'R5' }, why: 'the hump line' },
             { runId: 'w#2', deploy: { port: 'R1', starboard: 'R5' }, why: 'deeper' }],
      stops: [{ runId: 'w#1', structureId: 'w#1:p0', rods: ['R5'], durationMin: 15 }],
      changes: [{ beforeRunId: 'w#2', rodId: 'R5', to: SNAP2, why: 'up in the column' }],
    };
    const args = planArgsFrom(res, CANDS, { tackle: TACKLE, connectionOf });
    const plan = assemblePlan({
      ...args, launch: [-80.73, 34.38], slug: 'w', ramp: 'Clearwater Cove',
      launchTime: '06:00', returnTime: '15:00', usableAh: 80, transit: routedTransit,
    });

    expect(validatePlan(plan).length).toBe(0);
    expect(plan.legs.filter((l) => l.type === 'troll').map((l) => l.runId)).toEqual(['w#1', 'w#2']);
    const stop = plan.legs.find((l) => l.runId === 'w#1').stops[0];
    expect(stop.structureId).toBe('hump_9');
    expect(stop.depthFt).toBe(18);
    expect(stop.at).toEqual([-80.71, 34.38]);
    // The spoon is on a snap rod, so swapping it costs seconds, and the plan says so.
    expect(plan.changes[0].cost).toBe('snap');
    expect(plan.changes[0].from).toBe(SNAP);
  });
});

// ---------------------------------------------------------------------------
// THE DAY THAT CAME BACK WITH ONE STOP ON IT
//
// 2026-08-08. Ryan, on the first plan he ran through v2: it "only gave 1 spot to stop and cast".
//
// Two things caused it and only one was the prompt. The shape block asked the model for a field
// called `structureId`, and the candidate data it reads ALSO carries a field called `structureId`
// — the lake's own name for the feature, `hump_9`, sitting right next to the `id` the app
// actually resolves. The model copied the one whose name matched the request. assemblePlan looked
// it up in a Map keyed on `id`, missed, and dropped the stop into a collapsed warnings block.
//
// The reason it came back as exactly ONE rather than none: `structureId` is null for every type
// the packs cannot name — timber, attractors, docks — so on those the model had nothing to copy
// but `id`, and those stops survived. A whole day of humps and points thrown away, one stop left
// standing on an unnamed snag.
//
// Neither half of that is visible from a unit test of either module alone, which is why this one
// runs the round trip. The prompt now asks for `id`; the parser and the assembler take either.
// ---------------------------------------------------------------------------
describe('plan-prompt — a stop named the lake\'s way still lands', () => {
  const TWO_PASS = [
    { runId: 'w#1', runIndex: 1, lengthM: 2500, depthFt: 24,
      start: [-80.72, 34.38], end: [-80.70, 34.38],
      coordinates: [[-80.72, 34.38], [-80.70, 34.38]],
      passes: [
        { id: 'w#1:p0', atM: 900, type: 'hump', offM: 30, weight: 3, at: [-80.71, 34.38],
          structureId: 'hump_9', what: 'offshore hump, crown 18 ft', depthFt: 18 },
        // No structureId — the packs cannot name timber. This is the one that used to survive.
        { id: 'w#1:p1', atM: 1600, type: 'timber', offM: 15, weight: 27, at: [-80.705, 34.38],
          structureId: null, what: 'standing timber', depthFt: null },
      ] },
  ];
  const build = (stops) => assemblePlan({
    ...planArgsFrom({
      safety: { isGo: true }, loadout: { rods: [rod('R1', TIE), rod('R5', SNAP)] },
      legs: [{ runId: 'w#1', deploy: { port: 'R1', starboard: 'R5' }, why: 'the hump line' }],
      stops,
    }, TWO_PASS, { tackle: TACKLE, connectionOf }),
    launch: [-80.73, 34.38], slug: 'w', launchTime: '06:00', returnTime: '15:00', usableAh: 80,
    transit: routedTransit,
  });

  it('resolves a stop that copied structureId instead of id', () => {
    const plan = build([{ runId: 'w#1', structureId: 'hump_9', rods: ['R5'], durationMin: 15 }]);
    const stops = plan.legs.find((l) => l.runId === 'w#1').stops;
    expect(stops.length).toBe(1);
    expect(stops[0].structureId).toBe('hump_9');
    expect(stops[0].depthFt).toBe(18);          // resolved to the real pass, not guessed
    expect(plan.warnings.some((w) => w.includes('no structure'))).toBe(false);
  });

  it('still resolves a stop that copied id, which is what the prompt asks for', () => {
    const plan = build([{ runId: 'w#1', id: 'w#1:p0', rods: ['R5'], durationMin: 15 }]);
    const stops = plan.legs.find((l) => l.runId === 'w#1').stops;
    expect(stops.length).toBe(1);
    expect(stops[0].structureId).toBe('hump_9');
  });

  it('keeps EVERY stop on a leg, however each one was named', () => {
    // The exact shape of the bug: one stop names the lake's way, one names the app's way. Before
    // the fix the named structure vanished and only the unnamed snag came through.
    const plan = build([
      { runId: 'w#1', structureId: 'hump_9', rods: ['R5'], durationMin: 15 },
      { runId: 'w#1', id: 'w#1:p1', rods: ['R5'], durationMin: 10 },
    ]);
    const stops = plan.legs.find((l) => l.runId === 'w#1').stops;
    expect(stops.length).toBe(2);
    expect(stops.map((s) => s.atM)).toEqual([900, 1600]);        // sorted along the leg
    expect(stops.map((s) => s.id)).toEqual(['S1.1', 'S1.2']);    // renumbered after the sort
    expect(validatePlan(plan).length).toBe(0);
  });

  it('still refuses a structure that is not on that leg', () => {
    // The guard this was always for must survive the loosening.
    const plan = build([{ runId: 'w#1', structureId: 'hump_404', rods: ['R5'], durationMin: 15 }]);
    expect(plan.legs.find((l) => l.runId === 'w#1').stops.length).toBe(0);
    expect(plan.warnings.some((w) => w.includes('no structure "hump_404"'))).toBe(true);
  });

  it('asks the model for id, and says several stops are normal', () => {
    // The prompt half of the fix. If the shape block goes back to naming `structureId`, the
    // model goes back to copying the wrong field and only the parser leniency saves it.
    const req = buildPlanRequest({ candidates: TWO_PASS, water: 'Wateree', tackle: TACKLE });
    expect(req.user).toContain('"id": "that structure\'s `id`, copied exactly"');
    expect(req.user).not.toContain('"structureId": "copied exactly from that leg\'s structures"');
    expect(req.user).toMatch(/ONE ENTRY PER STRUCTURE WORTH STOPPING AT/);
  });
});


// -----------------------------------------------------------------------------------------------
// The resolver on its own. v1's tiers, minus the depth fallback -- see the comment above
// resolveTackleName(). The tier is part of the answer because the last tier is a guess.
// -----------------------------------------------------------------------------------------------
describe('resolveTackleName', () => {
  it('exact beats everything', () => {
    expect(resolveTackleName(TIE, TACKLE)).toEqual({ name: TIE, tier: 'exact' });
  });

  it('substring works in both directions', () => {
    expect(resolveTackleName('DD2 Crankbait', TACKLE).tier).toBe('substring');
    expect(resolveTackleName('DD2 Crankbait', TACKLE).name).toBe(TIE);
    expect(resolveTackleName(`${TIE3} deep diver`, TACKLE).name).toBe(TIE3);
  });

  it('returns null rather than inventing a lure', () => {
    // v1's last tier picked one out of the bag by depth keyword. That is exactly what must NOT
    // happen here: this call site exists to report a lure the boat does not carry.
    expect(resolveTackleName('Rapala Imagination Minnow', TACKLE)).toBe(null);
    expect(resolveTackleName('', TACKLE)).toBe(null);
    expect(resolveTackleName(null, TACKLE)).toBe(null);
    expect(resolveTackleName(TIE, [])).toBe(null);
  });

  it('strips a prompt annotation bracket before matching', () => {
    expect(stripLureAnnotation('DD2 Crankbait [16-20ft dive | 1.4-2mph]')).toBe('DD2 Crankbait');
    expect(resolveTackleName('DD2 Crankbait [16-20ft dive]', TACKLE).name).toBe(TIE);
  });
});
