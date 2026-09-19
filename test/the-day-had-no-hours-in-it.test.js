import { describe, it, expect } from './expect-shim.mjs';

const noop = () => {};
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, dataset: {} }), addEventListener: noop, readyState: 'complete',
};
const { assemblePlan } = await import('../js/modules/plan-assemble.js');
const { riverDay, travelOrder, forModel, metresBetween, minutesFor } =
  await import('../js/modules/plan-candidates.js');
const { buildPlanRequest, planArgsFrom } = await import('../js/modules/plan-prompt.js');
const { TACKLE_INVENTORY } = await import('../js/data/tackle-inventory.js');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE DAY HAD NO HOURS IN IT, SO THE SAME TWO RODS FISHED ALL OF THEM
//
// Ryan, 2026-09-17, on a nine-hour Congaree plan from Bates Bridge: *"but if it is only an up and
// back am i using the same rods all day long... no matter what? that doesn't make sense... and this
// dashboard doesn't tell me to switch if they aren't working or even mention the other 4 rods?"*
//
// He was reading the app exactly right, and none of the three reasons was the model's judgement:
//
//   1. A river candidate carried `estMin` -- a DURATION -- and no field anywhere said WHEN. So a
//      reach fished out at first light and back in the afternoon arrived as one anonymous stretch.
//   2. `deploy` is keyed by `runId`, and both passes over a reach share one runId. The two rods on
//      the way out WERE the two rods on the way back, by construction.
//   3. `changes` was gated on the first visit, so a swap at the turnaround was impossible too.
//
// And the prompt asked for something it had already forbidden: "Put the low-light legs and the
// full-daylight legs in the order the light comes", on a day whose order rule 3 fixes.
//
// AND THE FIX IS NOT SUBDIVIDING THE WATER, which is the other half of what he said: *"dividing it
// into legs that do not exist just to change baits at arbitrary times doesn't seem to make sense to
// me either"*. Two legs per reach stay two legs. The app supplies the clock; the model keeps the
// fishing.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const lureByName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;
const PLOPPER = TACKLE_INVENTORY.find((l) => l.type === 'topwater_troll');
const DD1 = TACKLE_INVENTORY.find((l) => l.type === 'crankbait_dd1');
const SPINNER = TACKLE_INVENTORY.find((l) => l.type === 'spinnerbait');
const SQUARE = TACKLE_INVENTORY.find((l) => l.type === 'crankbait_squarebill');

// BATES BRIDGE, which is the ramp closest to his house and the one he actually launches from:
// station 123,600 of the Congaree's 126,843 m centreline, so there is 8 km of river above it and
// 3.2 km below. That makes his day TWO out-and-backs from one point, which is the shape every
// number below depends on.
const LAUNCH = [-80.7290, 33.8900];
const CUR = 0.44;                       // the Congaree's measured current on his bench
const TROLL = 2.0;                      // the app's provisional speed through the water

function reach(n, dir, fromM, lengthM) {
  // A drift is drawn DOWNSTREAM -- 3DHP's `flowdirection` sets vertex order -- so the vertices run
  // from the upstream end to the downstream end. On the upstream arm that makes the drawn END the
  // near one, which is the fact riverPassFlipped() and trimReach() both turn on.
  const per = 1 / 111320;
  const far = dir === 'upstream' ? 33.8900 + (fromM + lengthM) * per : 33.8900 - (fromM + lengthM) * per;
  const near = dir === 'upstream' ? 33.8900 + fromM * per : 33.8900 - fromM * per;
  const a = dir === 'upstream' ? far : near;
  const b = dir === 'upstream' ? near : far;
  const coordinates = [];
  for (let i = 0; i <= 20; i++) coordinates.push([-80.7300, a + (b - a) * i / 20]);
  return {
    runId: `congaree_river:drift:mid_channel@${dir === 'upstream' ? 123600 - fromM - lengthM : 123600 + fromM}`,
    runIndex: n, startM: 0, lengthM: Math.round(metresBetween(coordinates[0], coordinates[20])),
    depthFt: 22, depthMinFt: 14, depthMaxFt: 31, maxRunDepthFt: 30,
    start: coordinates[0], end: coordinates[20], coordinates,
    passes: [], support: null, drift: { side: 'mid_channel', label: 'mid channel' },
    currentMph: CUR, score: dir === 'upstream' ? 40 : 25,
    batteryAhUpstream: 5.4, batteryAhDownstream: 3.6, batteryAh: 4.5,
    fromRamp: { direction: dir, m: fromM },
    transitInM: dir === 'upstream' ? fromM + lengthM : fromM,
    transitOutM: dir === 'upstream' ? fromM : fromM + lengthM,
    fromRampM: fromM,
  };
}
const A = reach(1, 'upstream', 49, 7983);      // the ramp is 49 m off the line, measured
const B = reach(2, 'upstream', 8032, 1009);
const C = reach(3, 'downstream', 60, 3158);

// THE ALMANAC IS QUOTED AND THE SKY IS OPEN-METEO'S OWN CODE, which is the rule everywhere else in
// this app. Civil dawn 06:34 and overcast (WMO 3) until 09:00, then mainly clear -- so a pass that
// starts at six is low light by BOTH causes and a pass that starts at ten is low light by neither.
// That is the premise the light assertions rest on, and it is measured rather than asserted.
const ALMANAC = { featureType: 'river', civilDawn: '06:34', sunrise: '06:59',
                  sunset: '19:52', civilDusk: '20:17' };
const WX = [];
for (let h = 5; h <= 20; h++) WX.push({ hour: h, code: h < 9 ? 3 : 1, cloudPct: h < 9 ? 92 : 14 });

const clock = (extra = {}, cands = [A, B, C]) => riverDay(cands, {
  usableAh: 100, windowMin: 630, trollMph: TROLL, transitMph: 3.5,
  launchTime: '06:00', launch: LAUNCH, waterState: ALMANAC, weatherByHour: WX, ...extra,
});

describe('riverDay — every pass gets a clock and a light', () => {
  it('stamps both passes of every reach it keeps', () => {
    const day = clock();
    // TWO, not three. A and B are upstream and C is downstream, and since 2026-09-19 a river day
    // takes ONE arm and it is the upstream one -- a safety rule, not a score. See
    // the-app-draws-the-river-day.test.js for Ryan's own statement of it.
    expect(day.length).toBe(2);
    expect(day.every((c) => c.fromRamp.direction === 'upstream')).toBe(true);
    for (const c of day) {
      expect(Array.isArray(c.passClock)).toBe(true);
      expect(c.passClock.map((p) => p.pass)).toEqual([1, 2]);
    }
  });

  it('and the two passes add up to the day the fit was costed against', () => {
    const day = clock();
    for (const c of day) {
      const both = minutesFor(c.lengthM, Math.max(0.1, TROLL - CUR))
                 + minutesFor(c.lengthM, TROLL + CUR);
      const sum = c.passClock.reduce((t, p) => t + p.min, 0);
      // Each pass is rounded to the minute, so two roundings is the whole tolerance.
      expect(Math.abs(sum - both) <= 2).toBe(true);
    }
  });

  it('one against the current and one with it, at the speed that difference makes', () => {
    const day = clock();
    for (const c of day) {
      const up = c.passClock.find((p) => p.upstream);
      const down = c.passClock.find((p) => !p.upstream);
      expect(up.overGroundMph).toBe(Number((TROLL - CUR).toFixed(2)));
      expect(down.overGroundMph).toBe(Number((TROLL + CUR).toFixed(2)));
      // And the slow one takes longer over the same water, which is the whole point of carrying both.
      expect(up.min > down.min).toBe(true);
    }
  });

  it('numbers them in the order travelOrder lays the day out, not in the order of the list', () => {
    const day = clock();
    const rows = [];
    for (const c of day) for (const p of c.passClock) rows.push({ runId: c.runId, ...p });
    rows.sort((a, b) => a.seq - b.seq);
    // Four, not six: two upstream reaches at two passes each. C is downstream and a river day does
    // not cross the launch -- see the note on the reach count above.
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    // The one answer to what order a river day is fished in. If these two ever disagree, the table
    // in the prompt is claiming an order nobody fishes.
    const walked = travelOrder(day, LAUNCH).legs.map((c) => `${c.runId}#${c.pass}`);
    expect(rows.map((r) => `${r.runId}#${r.pass}`)).toEqual(walked);
    // AND THE CLOCK NEVER GOES BACKWARDS ALONG THAT ORDER.
    for (let i = 1; i < rows.length; i++) expect(rows[i].at >= rows[i - 1].ends).toBe(true);
  });

  it('a reach fished out at six and back at ten is two different lights on one runId', () => {
    const day = clock();
    // The reach nearest the ramp on the arm taken first is the one fished at both ends of the day.
    const first = day.find((c) => c.runId === A.runId);
    const [out, back] = first.passClock;
    expect(out.at < back.at).toBe(true);
    // Measured off the almanac and the WMO codes above, not labelled here: the run out starts before
    // civil dawn under 92% cloud, the run back starts after nine under 14%.
    expect(out.light.low).toBe(true);
    expect(back.light.low).toBe(false);
    expect(out.light.state === back.light.state).toBe(false);
  });

  it('and says nothing at all when there is no launch clock to count from', () => {
    for (const c of clock({ launchTime: null })) expect(c.passClock).toBe(undefined);
    for (const c of clock({ launchTime: '06:00', waterState: null })) {
      // The clock still exists -- it is arithmetic -- but the light is the almanac's silence.
      expect(c.passClock.every((p) => p.light === null)).toBe(true);
    }
  });
});

describe('riverDay — the transit a ramp-anchored day does have', () => {
  it('reports the hop out and the gaps between reaches, and has no arm to cross', () => {
    const day = clock();
    // Walked off the fixture's own numbers rather than typed: out to A's near end, the gap where B
    // does not quite meet A, and the same gap coming back. There is NO fourth term for crossing the
    // launch -- C is downstream and the day never goes there, which is the whole saving. The old
    // expectation carried `+ (A.fromRamp.m + C.fromRamp.m)` for exactly that crossing.
    const gap = Math.abs(B.fromRamp.m - (A.fromRamp.m + day[0].lengthM));
    const expected = A.fromRamp.m + gap + gap;
    expect(day.day.transitM).toBe(expected);
    // And it says out loud that it declined the other side, with what that side was worth.
    const other = day.day.offered.find((o) => o.direction === 'downstream');
    expect(other.takenFirst).toBe(false);
    // Small, which is why a river day is worth drawing this way at all -- and NOT zero, which is what
    // the app reported before it was measured.
    expect(day.day.transitM > 0).toBe(true);
    expect(day.day.transitM / day.day.fishedM < 0.01).toBe(true);
  });

  it('and a one-arm day pays only the hop off the line, both ways being the same 49 m', () => {
    const day = clock({}, [A]);
    expect(day.day.transitM).toBe(A.fromRamp.m);
  });
});

describe('forModel — the clock reaches the model', () => {
  it('sends passClock, and omits the key entirely on a candidate that has none', () => {
    const day = clock();
    expect(forModel(day[0]).passClock.length).toBe(2);
    // Undefined rather than an empty array, so it leaves the JSON the model is handed entirely.
    const bare = forModel({ ...day[0], passClock: undefined, passes: [] });
    expect(bare.passClock).toBe(undefined);
    expect(JSON.stringify(bare).includes('passClock')).toBe(false);
  });
});

const promptFor = (o) => buildPlanRequest({
  water: 'Congaree River, SC', ramp: 'Bates Bridge', date: '2026-09-18',
  launchTime: '06:00', returnTime: '16:30', species: ['striped bass'],
  conditions: {}, tackle: TACKLE_INVENTORY.map((l) => l.name), lureByName,
  usableAh: 100, windowMin: 630, waterState: ALMANAC, weatherByHour: WX, ...o,
}).user;

const ORDER_BY_LIGHT = 'in the order the light comes';
const YOURS_TO_SPEND = 'they are yours to spend';

describe('the prompt — it states the day instead of asking for one', () => {
  it('prints every pass with its hours and its light, in fishing order', () => {
    const day = clock();
    const u = promptFor({ candidates: day.map((c) => forModel(c)), drawnDay: day.day, isRiver: true });
    const rows = [];
    for (const c of day) for (const p of c.passClock) rows.push({ runId: c.runId, ...p });
    rows.sort((a, b) => a.seq - b.seq);
    let at = -1;
    for (const r of rows) {
      const line = `${r.at}—${r.ends} (${r.min} min) ${r.runId} pass ${r.pass} of 2`;
      const i = u.indexOf(line);
      expect(i > 0).toBe(true);
      // And in the day's order on the page, not the candidate list's order.
      expect(i > at).toBe(true);
      at = i;
    }
  });

  it('says where the drawn day turns and what stopped it, which nothing ever read before', () => {
    const day = clock();
    const u = promptFor({ candidates: day.map((c) => forModel(c)), drawnDay: day.day, isRiver: true });
    expect(u.includes('THE DAY AS DRAWN')).toBe(true);
    expect(u.includes(day.day.binding)).toBe(true);
    expect(u.includes(`${day.day.transitM} m of the whole day is transit`)).toBe(true);
    // Both arms, with the one taken first marked -- `offered` exists for exactly this sentence.
    for (const arm of day.day.offered) expect(u.includes(`${arm.reaches} reach`)).toBe(true);
    expect(u.includes('upstream')).toBe(true);
    expect(u.includes('downstream')).toBe(true);
  });

  it('stops telling a river to order the day by light, or to spend a deadhead it cannot', () => {
    const day = clock();
    const u = promptFor({ candidates: day.map((c) => forModel(c)), drawnDay: day.day, isRiver: true });
    expect(u.includes(ORDER_BY_LIGHT)).toBe(false);
    expect(u.includes(YOURS_TO_SPEND)).toBe(false);
    // What replaces them points at what is still open.
    expect(u.includes('THE ORDER IS ALREADY FIXED HERE')).toBe(true);
    expect(u.includes('What is yours is what goes in the water, and WHEN.')).toBe(true);
  });

  it('and a lake day still owns its order, because there it is a real choice', () => {
    const u = promptFor({ candidates: [forModel({ ...A, passClock: undefined, passes: [],
                                                  drift: null, fromRamp: null, transitToM: { x: 1 } })],
                          isRiver: false });
    expect(u.includes(ORDER_BY_LIGHT)).toBe(true);
    expect(u.includes(YOURS_TO_SPEND)).toBe(true);
    expect(u.includes('THE DAY AS DRAWN')).toBe(false);
  });
});

// ── AND WHAT THE PLAN CAN NOW DO WITH IT ────────────────────────────────────────────────────────

const ROD = (id, lure) => ({ id, rig: 'snap', role: 'troll', lure: lure.name, color: 'x', leadFt: 60 });
const LOADOUT = { rods: [ROD('R1', PLOPPER), ROD('R3', DD1), ROD('R2', SQUARE), ROD('R4', SPINNER)] };
const routed = (a, b) => ({ distanceM: metresBetween(a, b), coordinates: [a, b] });

function build(extra = {}, cands = null) {
  const day = cands || clock();
  return assemblePlan({
    transit: routed, candidates: day, launch: LAUNCH, loadout: LOADOUT,
    slug: 'congaree_river', water: 'Congaree River, SC', ramp: 'Bates Bridge',
    launchTime: '06:00', returnTime: '16:30', usableAh: 100, lureByName,
    waterState: ALMANAC, weatherByHour: WX,
    deploy: Object.fromEntries(day.map((c) => [c.runId, { port: 'R1', starboard: 'R3' }])),
    ...extra,
  });
}
const trollLegs = (plan, runId) => plan.legs.filter((l) => l.type === 'troll' && l.runId === runId);

describe('deployBack — the four rods behind the seat', () => {
  it('puts a different pair in the water on the run back when the plan names one', () => {
    const plan = build({ deployBack: { [A.runId]: { port: 'R2', starboard: 'R4' } } });
    const [out, back] = trollLegs(plan, A.runId);
    expect(out.pass).toBe(1);
    expect(back.pass).toBe(2);
    expect(out.deploy).toEqual({ port: 'R1', starboard: 'R3' });
    expect(back.deploy).toEqual({ port: 'R2', starboard: 'R4' });
  });

  it('and the same pair comes back when it does not, which is every plan before this field', () => {
    const plan = build();
    const [out, back] = trollLegs(plan, A.runId);
    expect(back.deploy).toEqual(out.deploy);
  });

  it('so a rod named only for the run back is not reported as never fishing', () => {
    const plan = build({ deployBack: { [A.runId]: { port: 'R2', starboard: 'R4' } } });
    for (const id of ['R2', 'R4']) {
      expect(plan.warnings.some((w) => w.startsWith(`${id} is rigged`))).toBe(false);
    }
  });

  it('planArgsFrom refuses a back pair that is not two different rigged rods', () => {
    const cands = clock();
    const res = {
      loadout: { rods: [{ id: 'R1', lure: PLOPPER.name, leadFt: 60, role: 'troll' },
                        { id: 'R3', lure: DD1.name, leadFt: 60, role: 'troll' }] },
      legs: cands.map((c) => ({ runId: c.runId, deploy: { port: 'R1', starboard: 'R3' },
                                deployBack: { port: 'R1', starboard: 'R1' } })),
      stops: [], changes: [],
    };
    const args = planArgsFrom(res, cands, { tackle: TACKLE_INVENTORY.map((l) => l.name) });
    expect(Object.keys(args.deployBack).length).toBe(0);
    expect(args.problems.some((p) => p.includes('the run back keeps the rods from the run out')))
      .toBe(true);
  });

  it('and one that names a rod this plan never rigged', () => {
    const cands = clock();
    const tackle = TACKLE_INVENTORY.map((l) => l.name);
    const loadout = { rods: [{ id: 'R1', lure: PLOPPER.name, leadFt: 60, role: 'troll' },
                             { id: 'R3', lure: DD1.name, leadFt: 60, role: 'troll' }] };
    const legs = (back) => cands.map((c) => ({ runId: c.runId, deploy: { port: 'R1', starboard: 'R3' },
                                              ...(back ? { deployBack: back } : {}) }));
    // WHICH RODS ARE STAGED IS THE APP'S ANSWER, NOT THE TEST'S. seatRods() moves a lure onto a rod
    // whose terminal tackle can carry it -- this loadout of two snap-friendly baits comes back seated
    // on R5 and R6 -- so naming two ids here and calling them unrigged is a premise that can silently
    // stop being true. Asked first, then used.
    const first = planArgsFrom({ loadout, legs: legs(null), stops: [], changes: [] }, cands, { tackle });
    const staged = first.loadout.rods.filter((r) => r.staged).map((r) => r.id);
    expect(staged.length >= 2).toBe(true);
    const args = planArgsFrom({ loadout, legs: legs({ port: staged[0], starboard: staged[1] }),
                                stops: [], changes: [] }, cands, { tackle });
    expect(Object.keys(args.deployBack).length).toBe(0);
    // The id is not named in the claim, because reseating may rewrite a staged id on the way through
    // and the point is the refusal, not which rod it landed on.
    expect(args.problems.some((p) => /on the run back refers to R\d, which this plan never rigged/
      .test(p))).toBe(true);
  });
});

describe('a lure change can happen at the turnaround', () => {
  const change = (pass) => ({ beforeRunId: A.runId, pass, rodId: 'R3', from: DD1.name,
                              to: SPINNER.name, why: 'the light went' });

  // A change carries the cumulative distance at the point the boat stops to make it -- "a lure change
  // happens where the boat is, before the leg starts" -- so which pass it belongs to is the first
  // trolling leg that begins at or after it. Measured off the plan's own spine, not off an index.
  const attachedTo = (plan) => {
    expect(plan.changes.length).toBe(1);
    const at = plan.changes[0].atM;
    const l = plan.legs.filter((x) => x.type === 'troll' && x.startM >= at)
                       .sort((x, y) => x.startM - y.startM)[0];
    return `${l.runId}#${l.pass}`;
  };

  it('lands before the run BACK when it names pass 2', () => {
    expect(attachedTo(build({ changes: [change(2)] }))).toBe(`${A.runId}#2`);
  });

  it('and before the run out when it does not, which is what it always did', () => {
    for (const p of [1, undefined]) {
      expect(attachedTo(build({ changes: [change(p)] }))).toBe(`${A.runId}#1`);
    }
  });

  it('exactly once either way, because one change is one retie', () => {
    for (const p of [1, 2]) expect(build({ changes: [change(p)] }).changes.length).toBe(1);
  });
});

describe('the light on the run back is judged, and it used to be swallowed', () => {
  // The Whopper Plopper's own recorded technique is "Surface troll at dawn". The run out here starts
  // before civil dawn under 92% cloud -- low light by both causes, so the note agrees and the app
  // says nothing. The run back starts after nine under 14% cloud, where it does not.
  //
  // capBaitDepth's answer used to be cached on the runId and copied onto the return pass, so this
  // check never ran on the afternoon -- the half of the day it exists for.
  it('flags a dawn bait dragged back through full sun, and says nothing on the dawn pass', () => {
    const plan = build();
    const onA = plan.warnings.filter((w) => w.includes('Surface troll at dawn')
                                         && w.includes(A.runId));
    // ONCE about that reach, not twice: the run out agrees with the note and says nothing, the run
    // back does not and says so. Before this the run back inherited the run out's answer and the
    // afternoon was never judged at all.
    expect(onA.length).toBe(1);
    expect(onA[0].includes('NOT low light')).toBe(true);
    expect(onA[0].startsWith('R1 on ')).toBe(true);
    // AND NOT TWICE ABOUT A REACH FISHED TWICE IN ONE LIGHT. Both passes over the far reach are in
    // daylight, which is one piece of news at two different minutes. See newsOf() in the assembler.
    const onB = plan.warnings.filter((w) => w.includes('Surface troll at dawn')
                                         && w.includes(B.runId));
    expect(onB.length).toBe(1);
  });
});
