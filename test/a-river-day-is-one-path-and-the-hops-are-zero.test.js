import { describe, it, expect } from './expect-shim.mjs';

const noop = () => {};
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, dataset: {} }), addEventListener: noop, readyState: 'complete',
};
const { assemblePlan } = await import('../js/modules/plan-assemble.js');
const { travelOrder, metresBetween, trimReach } = await import('../js/modules/plan-candidates.js');
const { TACKLE_INVENTORY } = await import('../js/data/tackle-inventory.js');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A RIVER DAY IS ONE PATH OUT AND ONE PATH BACK
//
// Ryan asked for exactly this shape: *"should it just be that the app figures out where i should
// turn around and draws a route that goes up one side and back down the other?"* riverDay() answered
// which reaches. The app then spent 12.9 km of a 35 km day driving between them.
//
// The reaches come out CONTIGUOUS — @47800 ends where @55800 begins, 0.0 m apart — and each carried
// `trollPasses: 2`, which means "fish this reach twice, back to back". A reach fished twice ends
// where it started. So: fish A down and up, drive 6.5 km to B, fish B down and up, drive 6.5 km home.
// All four orderings orientLegs can see are wrong, because the two passes of a reach on a river are
// separated in time by the whole run out.
//
// MEASURED ON HIS OWN 2026-09-17 CONGAREE BENCH, with the real candidates and the real launch:
//
//                         transit   fished   plannedAh   minutes
//     what he got          12,924   22,467       61.95       624   of a 540 min window
//     one path out, back      105   23,852       36.79       539
// ─────────────────────────────────────────────────────────────────────────────────────────────

const lureByName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;
const PLOPPER = TACKLE_INVENTORY.find((l) => l.type === 'topwater_troll');
const SQUARE = TACKLE_INVENTORY.find((l) => l.type === 'crankbait_squarebill');
const SPINNER = TACKLE_INVENTORY.find((l) => l.type === 'spinnerbait');
const DD1 = TACKLE_INVENTORY.find((l) => l.type === 'crankbait_dd1');

// A ramp at the top, then two reaches butted end to end running away from it downstream — the shape
// riverDay() emits and the shape that used to cost 6.5 km a hop.
const LAUNCH = [-81.0357, 33.9649];
function reach(n, fromM, lengthDeg, currentMph = 0.44) {
  const lat0 = 33.9647 - (fromM / 111320);
  const coordinates = [];
  for (let i = 0; i <= 20; i++) coordinates.push([-81.0368, lat0 - lengthDeg * i / 20]);
  const lengthM = metresBetween(coordinates[0], coordinates[coordinates.length - 1]);
  return {
    runId: `congaree_river:drift:mid_channel@${47800 + fromM}`, runIndex: n,
    startM: 0, lengthM, depthFt: 22, maxRunDepthFt: 30,
    start: coordinates[0], end: coordinates[coordinates.length - 1], coordinates,
    passes: [], support: null, drift: true, currentMph, trollPasses: 2,
    fromRamp: { direction: 'downstream', m: fromM }, transitInM: fromM || 105,
  };
}
const A = reach(1, 0, 0.0717);       // ~7.98 km
// AND B STARTS EXACTLY WHERE A ENDS. The first draft of this fixture put it at `fromM: 8000` and left
// an 18 m gap, which the assembler dutifully charged as a transit -- so the test that hops are zero
// failed on the fixture's own arithmetic rather than on the code. Contiguity is the premise here.
const B0 = reach(2, 8000, 0.0584);
const BSHIFT = A.end[1] - B0.start[1];
const B = { ...B0, coordinates: B0.coordinates.map(([x, y]) => [x, y + BSHIFT]) };
B.start = B.coordinates[0]; B.end = B.coordinates[B.coordinates.length - 1];
const ROD = (id, lure) => ({ id, rig: 'snap', role: 'troll', lure: lure.name, color: 'x', leadFt: 60 });
const LOADOUT = { rods: [ROD('R1', PLOPPER), ROD('R3', DD1), ROD('R2', SQUARE), ROD('R4', SPINNER)] };
const routed = (a, b) => ({ distanceM: metresBetween(a, b), coordinates: [a, b] });

function build(extra = {}, cands = [A, B]) {
  return assemblePlan({
    transit: routed, candidates: cands, launch: LAUNCH, loadout: LOADOUT,
    slug: 'congaree_river', water: 'Congaree River, SC', ramp: 'Barney Jordan (Columbia)',
    launchTime: '06:00', returnTime: '15:00', usableAh: 80, lureByName,
    deploy: { [A.runId]: { port: 'R1', starboard: 'R3' }, [B.runId]: { port: 'R2', starboard: 'R4' } },
    ...extra,
  });
}

describe('travelOrder — out through every reach, then back through every reach', () => {
  it('emits one entry per PASS, in the order the boat meets them', () => {
    const { legs, river } = travelOrder([A, B], LAUNCH);
    expect(river).toBe(true);
    expect(legs.length).toBe(4);
    expect(legs.map((c) => `${c.runIndex}.${c.pass}`)).toEqual(['1.1', '2.1', '2.2', '1.2']);
    // Each entry is a single pass now; `trollPasses: 2` was the thing that made them adjacent.
    for (const c of legs) expect(c.trollPasses).toBe(1);
  });

  it('every hop between consecutive legs is zero, which is the whole point', () => {
    const { legs, facing } = travelOrder([A, B], LAUNCH);
    for (let i = 1; i < legs.length; i++) {
      expect(Math.round(metresBetween(facing[i - 1].finish, facing[i].start))).toBe(0);
    }
    // And it finishes where it started, at the near end of the first reach.
    expect(Math.round(metresBetween(facing[3].finish, facing[0].start))).toBe(0);
  });

  it('a reach DOWNSTREAM of the ramp is entered at its upstream end going out', () => {
    const { facing } = travelOrder([A], LAUNCH);
    expect(facing[0].flipped).toBe(false);              // the drawn line IS the outward run
    expect(facing[1].flipped).toBe(true);
  });

  it('and a reach UPSTREAM of the ramp is entered at its downstream end, which is the other way', () => {
    const upA = { ...A, fromRamp: { direction: 'upstream', m: 0 } };
    const { facing } = travelOrder([upA], LAUNCH);
    expect(facing[0].flipped).toBe(true);
    expect(facing[1].flipped).toBe(false);
  });

  it('a lake is untouched: the candidates as given, orientLegs orientation', () => {
    const lake = [{ ...A, drift: null, fromRamp: null, currentMph: null }];
    const { legs, river } = travelOrder(lake, LAUNCH);
    expect(river).toBe(false);
    expect(legs.length).toBe(1);
    expect(legs[0]).toBe(lake[0]);
  });

  it('and so is a pass count this layout does not know how to draw', () => {
    // Three passes over a river reach is out-back-out, which nobody has asked for. Solving it as a
    // chain is the honest answer; inventing a shape is not.
    expect(travelOrder([{ ...A, trollPasses: 3 }], LAUNCH).river).toBe(false);
    expect(travelOrder([{ ...A, trollPasses: 2 }, { ...B, trollPasses: 1 }], LAUNCH).river).toBe(false);
    expect(travelOrder([], LAUNCH).river).toBe(false);
  });
});

describe('the assembler walks it, and the deadhead goes with it', () => {
  it('four fished legs, one hop out, and nothing between them', () => {
    const plan = build();
    const troll = plan.legs.filter((l) => l.type === 'troll');
    const transit = plan.legs.filter((l) => l.type === 'transit');
    expect(troll.length).toBe(4);
    expect(transit.length).toBe(1);                    // the hop to the water and nothing else
    expect(plan.budget.transitM < 200).toBe(true);
  });

  it('the boat goes out downstream and comes back up, and each leg says which', () => {
    const plan = build();
    expect(plan.legs.filter((l) => l.type === 'troll').map((l) => l.heading))
      .toEqual(['downstream', 'downstream', 'upstream', 'upstream']);
  });

  it('the route home is the last fished pass, so no transit leg is invented', () => {
    const plan = build();
    expect(plan.legs.some((l) => l.role === 'return')).toBe(false);
  });

  it('THE DEADHEAD WARNING IS GONE, because there is no deadhead to warn about', () => {
    const plan = build();
    expect(plan.warnings.some((w) => w.includes('deadheading'))).toBe(false);
  });

  it('a stop and a lure change happen once, on the way out', () => {
    // Rivers return no stops, but the guard is the same one the old inner pass loop applied and it
    // has to hold now that the second pass is a sibling rather than a child.
    const plan = build({ changes: [{ beforeRunId: B.runId, rodId: 'R2', to: DD1.name, why: 'x' }] });
    expect(plan.changes.filter((c) => c.rodId === 'R2').length).toBeLessThan(2);
  });

  it('and a rod used again on the way back is not a wasted change any more', () => {
    // The 2026-09-17 bench dropped a change on R1 before the second reach as "never trolled again".
    // R1 is on reach A, and reach A is fished again coming home.
    const plan = build({ changes: [{ beforeRunId: B.runId, rodId: 'R1', to: SQUARE.name, why: 'x' }] });
    expect(plan.warnings.some((w) => w.includes('never trolled or cast again'))).toBe(false);
  });
});

describe('fitRiverDay — the day is re-fitted once the baits set the speed', () => {
  it('a window that cannot hold both reaches cuts the far one and says so', () => {
    const plan = build();
    const cut = plan.warnings.filter((w) => w.includes('is cut to'));
    expect(cut.length).toBe(1);
    expect(cut[0]).toContain(B.runId);
    expect(cut[0]).toContain('2.0 mph before a bait was picked');
    const troll = plan.legs.filter((l) => l.type === 'troll');
    // The cut reach is shorter than it was, both ways, and by the same amount.
    expect(troll[1].lengthM < Math.round(B.lengthM)).toBe(true);
    expect(troll[1].lengthM).toBe(troll[2].lengthM);
  });

  it('and the day it produces FITS, which is the entire point', () => {
    const plan = build();
    expect(plan.budget.estPlannedMin <= plan.budget.windowMin).toBe(true);
    expect(plan.budget.plannedAh <= 80).toBe(true);
    expect(plan.warnings.some((w) => w.includes('min window'))).toBe(false);
  });

  it('a long enough day keeps both reaches whole and cuts nothing', () => {
    const plan = build({ returnTime: '23:00', usableAh: 200 });
    const troll = plan.legs.filter((l) => l.type === 'troll');
    expect(troll.length).toBe(4);
    expect(troll[1].lengthM).toBe(Math.round(B.lengthM));
    expect(plan.warnings.some((w) => w.includes('is cut to') || w.includes('is off the day'))).toBe(false);
  });

  it('a window too small for even a sliver of the second reach drops it whole', () => {
    // MEASURED, NOT PICKED. Reach A out and back costs 328 min with these two baits, so a 345 min
    // window leaves 16 for reach B and B whole is 228 -- 7%, under riverDay's own tenth-of-a-reach
    // floor. The first draft of this test used 12:40, which leaves 71 minutes and cuts B to 31%.
    const plan = build({ returnTime: '11:45' });
    const troll = plan.legs.filter((l) => l.type === 'troll');
    expect(troll.length).toBe(2);
    expect(plan.warnings.some((w) => w.includes('is off the day') && w.includes(B.runId))).toBe(true);
  });

  it('a window between the two cuts rather than drops', () => {
    const plan = build({ returnTime: '12:40' });        // 400 min: 71 left over, 31% of B
    expect(plan.legs.filter((l) => l.type === 'troll').length).toBe(4);
    expect(plan.warnings.some((w) => w.includes('is cut to 31%'))).toBe(true);
  });

  it('the battery binds the same way the clock does', () => {
    // All night, so only the battery can bind. Reach A alone is 25.4 Ah, so 25 keeps A and drops B --
    // and then says the day is over budget, because THE FIRST REACH IS NEVER DROPPED and a day with
    // no water is not a day. That refusal is the hard stop's job, not this function's.
    const plan = build({ returnTime: '23:00', usableAh: 25 });
    expect(plan.legs.filter((l) => l.type === 'troll').length).toBe(2);
    expect(plan.warnings.some((w) => w.includes('is off the day') && w.includes(B.runId))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('over budget'))).toBe(true);
    // And with room for both it takes both, so 25 was the battery talking and not a bug.
    expect(build({ returnTime: '23:00', usableAh: 200 })
      .legs.filter((l) => l.type === 'troll').length).toBe(4);
  });

  it('the bait ceiling is judged once per reach, so its warnings are not doubled', () => {
    // capBaitDepth ran on both passes and said "put a Squarebill on no lead at all" twice about one
    // rig. The bait's depth is identical both ways -- that is what handing it the WATER speed buys --
    // so the answer is cached on the runId.
    const bare = { rods: LOADOUT.rods.map((r) => ({ ...r, leadFt: 0 })) };
    const plan = build({ loadout: bare });
    const said = plan.warnings.filter((w) => w.includes('no lead at all'));
    expect(said.length).toBe(new Set(said).size);
  });

  it('THE FIRST REACH IS NEVER DROPPED, because a day with no water is not a day', () => {
    const plan = build({ returnTime: '07:00', usableAh: 3 });
    expect(plan.legs.filter((l) => l.type === 'troll').length).toBeGreaterThan(0);
  });
});

describe('trimReach — the same cut riverDay makes', () => {
  it('cuts from the near end and says what it was', () => {
    const t = trimReach(A, 0.5);
    expect(t.lengthM).toBe(Math.round(A.lengthM * 0.5));
    expect(t.trimmedFrom).toBe(A.lengthM);
    expect(t.start).toEqual(A.start);                  // the near end is kept
    expect(t.end).not.toEqual(A.end);
  });

  it('a reach cut twice remembers the whole reach, not the middle step', () => {
    const t = trimReach(trimReach(A, 0.5), 0.5);
    expect(t.trimmedFrom).toBe(A.lengthM);
  });
});
