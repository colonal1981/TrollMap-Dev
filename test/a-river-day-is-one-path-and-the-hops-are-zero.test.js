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
const LIPLESS = TACKLE_INVENTORY.find((l) => l.type === 'lipless');
const SPOON = TACKLE_INVENTORY.find((l) => l.type === 'flutter_spoon');

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
    // `decisions` since 2026-09-21: a reach trimmed or dropped is the app's own arithmetic
    // against the clock and the battery, reported. See plan-assemble.js.
    const cut = plan.decisions.filter((w) => w.includes('is cut to'));
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
    expect(plan.decisions.some((w) => w.includes('is off the day') && w.includes(B.runId))).toBe(true);
  });

  it('a window between the two cuts rather than drops', () => {
    const plan = build({ returnTime: '12:40' });        // 400 min: 71 left over, 31% of B
    expect(plan.legs.filter((l) => l.type === 'troll').length).toBe(4);
    expect(plan.decisions.some((w) => w.includes('is cut to 31%'))).toBe(true);
  });

  it('the battery binds the same way the clock does', () => {
    // All night, so only the battery can bind. Reach A alone is 25.4 Ah, so 25 keeps A and drops B --
    // and then says the day is over budget, because THE FIRST REACH IS NEVER DROPPED and a day with
    // no water is not a day. That refusal is the hard stop's job, not this function's.
    const plan = build({ returnTime: '23:00', usableAh: 25 });
    expect(plan.legs.filter((l) => l.type === 'troll').length).toBe(2);
    expect(plan.decisions.some((w) => w.includes('is off the day') && w.includes(B.runId))).toBe(true);
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

// ── AND A DAY CAN BE TWO OUT-AND-BACKS FROM ONE LAUNCH ────────────────────────────────────────
//
// riverDay() fills the richer side of the launch first and carries on into the other side if the
// budget has room. Ryan launches at BATES BRIDGE, station 123,600 of a 126,843 m centreline, so his
// Congaree day is exactly that: 8 km of river above him and 3.2 km below.
//
// THE FIRST VERSION OF travelOrder() MIRRORED THE WHOLE LIST — A-out, B-out, B-back, A-back — which
// is right for one arm and reintroduces the bug it was written to kill the moment there are two: the
// boat runs 8 km up, comes back past the launch to fish the downstream arm, then goes back up to
// where the first arm ended. Measured from Bates Bridge: T2 and T3 at 4,821 m each, 9,691 m of
// deadhead on a 29.5 km day.
//
// A reach ABOVE the ramp is drawn downstream too, so its drawn `start` is the FAR end. That is what
// made the second and third defects here: the hop reserve read `transitInM` — the distance to the
// drawn start — and trimReach() cut the drawn prefix.

// 8 km of river ABOVE the launch, drawn downstream, so coords run far → near.
// THE NEAR END IS PASSED IN AND NOT DERIVED. The first draft computed it from `fromM / 111320` and
// left gaps of 22 m and 4 m against the reach it was meant to butt onto -- then failed the test that
// hops are zero, on the fixture's own rounding rather than on the code. Contiguity is the premise of
// every assertion below, so it is built rather than approximated. Second time tonight.
function upReach(n, fromM, lengthDeg, latNear) {
  const coordinates = [];
  for (let i = 0; i <= 20; i++) coordinates.push([-81.0368, latNear + lengthDeg * (1 - i / 20)]);
  const lengthM = metresBetween(coordinates[0], coordinates[coordinates.length - 1]);
  return {
    runId: `congaree_river:drift:mid_channel@${115600 - fromM}`, runIndex: n,
    startM: 0, lengthM, depthFt: 22, maxRunDepthFt: 30,
    start: coordinates[0], end: coordinates[coordinates.length - 1], coordinates,
    passes: [{ id: 'p1', atM: 200, type: 'hole', offM: 10, weight: 3, at: coordinates[1] },
             { id: 'p2', atM: Math.round(lengthM - 200), type: 'hole', offM: 10, weight: 3,
               at: coordinates[19] }],
    support: null, drift: true, currentMph: 0.66, trollPasses: 2,
    fromRamp: { direction: 'upstream', m: fromM },
    // THE TRAP: `transitInM` is the distance to the DRAWN start, which on an upstream reach is the far
    // end. `fromRampM` is the near end. Both are real fields off selectCandidates.
    transitInM: fromM + Math.round(lengthM), transitOutM: fromM, fromRampM: fromM || 49,
  };
}
// Its near end IS reach A's near end, which is where the boat launches from.
const UP = upReach(1, 0, 0.0717, A.start[1]);            // ~7.98 km above the launch

describe('a river day with two arms, and the ends that are not where they look', () => {
  it('two arms are two out-and-backs, and every hop is still zero', () => {
    const { legs, facing } = travelOrder([UP, A], LAUNCH);
    expect(legs.map((c) => `${c.fromRamp.direction.slice(0, 2)}#${c.pass}`))
      .toEqual(['up#1', 'up#2', 'do#1', 'do#2']);
    for (let i = 1; i < legs.length; i++) {
      expect(Math.round(metresBetween(facing[i - 1].finish, facing[i].start))).toBeLessThan(2);
    }
    // It starts and finishes at the launch end of the first arm.
    expect(Math.round(metresBetween(facing[0].start, facing[3].finish))).toBeLessThan(2);
  });

  it('the outward pass of an upstream reach runs the drawn line BACKWARDS', () => {
    const { facing } = travelOrder([UP], LAUNCH);
    expect(facing[0].flipped).toBe(true);
    // It enters at the near end, which is the drawn line's LAST coordinate.
    expect(facing[0].start).toEqual(UP.end);
    expect(facing[1].flipped).toBe(false);
  });

  it('THE HOP RESERVE IS THE NEAR END, NOT `transitInM`', () => {
    // `transitInM` on this reach is 7,978 + 0 metres — the distance to its far end. Reserving that hop
    // both ways at 3.5 mph is 170 MINUTES, which on his Bates Bridge bench ate the whole remainder and
    // dropped the second arm of his day while the budget printed 99 minutes still unspent.
    const plan = build({ usableAh: 200 }, [UP]);
    const troll = plan.legs.filter((l) => l.type === 'troll');
    expect(troll.length).toBe(2);
    expect(troll.every((l) => !l.trimmedFrom)).toBe(true);
    expect(plan.warnings.some((w) => w.includes('is off the day') || w.includes('is cut to'))).toBe(false);
    // And the hop it actually pays is the 49 m one.
    expect(plan.budget.transitM).toBeLessThan(200);
  });

  it('trimReach cuts the FAR end of an upstream reach, and keeps the end the boat comes in by', () => {
    const t = trimReach(UP, 0.5);
    expect(t.lengthM).toBe(Math.round(UP.lengthM * 0.5));
    // The near end does not move; the far one does.
    expect(t.end).toEqual(UP.end);
    expect(t.start).not.toEqual(UP.start);
    // The structure past the cut is gone and what survives has its distance along the line rebased,
    // because the line no longer starts where it did.
    expect(t.passes.length).toBe(1);
    expect(t.passes[0].id).toBe('p2');
    expect(t.passes[0].atM).toBeLessThan(UP.passes[1].atM);
    // A downstream reach still cuts the other way, which is what it always did.
    const d = trimReach(A, 0.5);
    expect(d.start).toEqual(A.start);
    expect(d.end).not.toEqual(A.end);
  });

  it('a cut upstream reach still butts onto the one before it', () => {
    const near = upReach(1, 0, 0.0717, A.start[1]);
    const far = upReach(2, 7978, 0.0717, near.start[1]);   // butted onto `near`'s far end exactly
    const t = trimReach(far, 0.5);
    // The cut keeps the half nearest the launch, so its near end is still where `near` ends.
    expect(Math.round(metresBetween(t.end, near.start))).toBeLessThan(2);
  });
});

// ── A ROD RIGGED AND NEVER PUT IN THE WATER IS A KNOT TIED FOR NOTHING ─────────────────────────
//
// Ryan, 2026-09-18, reading a plan whose loadout carried a lipless crankbait: "but a rod with a
// lipless crankbait isnt offered on any leg?" It was offered — on the one reach the APP had removed.
// Nothing said so, and the mirror of "A LEG WITH NOTHING IN THE WATER IS SAID OUT LOUD" did not exist.
describe('a rod with no water is said out loud, and whose fault it is', () => {
  const ROD = (id, lure) => ({ id, rig: 'snap', role: 'troll', lure: lure.name, color: 'x', leadFt: 60 });
  const SIX = { rods: [ROD('R1', PLOPPER), ROD('R3', DD1), ROD('R2', SQUARE), ROD('R4', SPINNER),
                       ROD('R5', LIPLESS), ROD('R6', SPOON)] };

  it('a rod the MODEL rigged and never deployed is a retie it asked for', () => {
    const plan = build({ loadout: SIX });
    const said = plan.warnings.filter((w) => /never goes in the water on any leg/.test(w));
    // R5 and R6 are rigged and deployed nowhere; the four in `deploy` are.
    expect(said.length).toBe(2);
    expect(said.join(' ')).toContain('R5');
    expect(said.join(' ')).toContain('R6');
    expect(said[0]).toContain('buys nothing');
  });

  it('but a rod stranded because the APP cut its reach is the APP\'S doing, and says so', () => {
    // A window that drops reach B entirely takes R2 and R4 with it — they were deployed there and
    // nowhere else. Blaming him for a bait he rigged for water we removed would be backwards.
    const plan = build({ returnTime: '11:45', loadout: SIX });
    const stranded = plan.warnings.filter((w) => /its only water came off the day/.test(w));
    expect(stranded.length).toBe(2);
    expect(stranded.join(' ')).toContain('R2');
    expect(stranded.join(' ')).toContain('R4');
    expect(stranded[0]).toContain(B.runId);
    expect(stranded[0]).toContain("THE APP'S DOING");
    // And the two that were never deployed at all still get the other sentence, not this one.
    expect(plan.warnings.filter((w) => /never goes in the water on any leg/.test(w)).length).toBe(2);
  });

  it('a staged rod is not a complaint — it is carrying whatever it was carrying', () => {
    const staged = { rods: [...LOADOUT.rods, { id: 'R5', rig: 'snap', staged: true, lure: null }] };
    const plan = build({ loadout: staged });
    expect(plan.warnings.some((w) => w.includes('R5'))).toBe(false);
  });

  it('and a plan with no water in it complains about no rods at all', () => {
    // Six rods and nothing to deploy on is one story, not seven. `assemblePlan({candidates: []})`
    // warning about nothing is its own assertion in plan-assemble.test.js; this is the same rule.
    const plan = build({ loadout: SIX }, []);
    expect(plan.legs.length).toBe(0);
    expect(plan.warnings.filter((w) => /goes in the water|came off the day/.test(w)).length).toBe(0);
  });
});
