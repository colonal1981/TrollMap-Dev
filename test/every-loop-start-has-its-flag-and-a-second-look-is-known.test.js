// Three little things off Ryan's 10/5 Rowland loop plan (built 10/4, EXPORT.GPX (45)): every loop's
// start gets its own flag, a stop on structure an earlier leg already passed is known to be a return,
// and a lead bait whose deep end is the floor is lifted the foot the card prints as up.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, reading the review of that plan: "this was just a plan for testing... this works... you can
// fix the little things you found".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { planWaypoints } from '../js/modules/plan-tracks.js';
import { markRepeats, sameMark } from '../js/modules/plan-from-water.js';
import { assemblePlan, bottomGapFt } from '../js/modules/plan-assemble.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';
import { depthWindow } from '../js/data/lure-knowledge.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('three loops from one start: each loop\'s start carries its own flag and band', () => {
  // The coordinates of his plan: every loop starts and ends at 33.5425632,-80.2212613.
  const S = [-80.2212613, 33.5425632];
  const T1 = [-80.1975489, 33.5154237], T2 = [-80.2123691, 33.5192685], T3 = [-80.1967405, 33.5161022];
  const leg = (id, from, to, depthFt, startM) => ({ id, type: 'troll', coordinates: [from, to], depthFt, startM, lengthM: 4000 });
  const plan = { legs: [leg('L1', S, T1, 27, 545), leg('L2', T1, S, 28, 4703), leg('L3', S, T2, 23, 8881),
                        leg('L4', T2, S, 24, 12522), leg('L5', S, T3, 19, 16395), leg('L6', T3, S, 19, 20679)] };
  const flags = planWaypoints(plan, null, 'r').filter((w) => w.legStart);
  assert.deepEqual(flags.map((w) => w.name), ['L1 22-32ft', 'L2 23-33ft', 'L3 18-28ft', 'L4 19-29ft', 'L5 14-24ft', 'L6 14-24ft']);
  // the three at the start are on the one coordinate, as his were
  assert.equal(flags.filter((w) => w.lat === S[1] && w.lon === S[0]).length, 3);
  // and an end that lands on a start is still not a second mark there
  assert.equal(planWaypoints(plan, null, 'r').filter((w) => w.legEnd).length, 0);
});

test('a leg fished back still gets one mark at the turn: its own start, not the last one\'s end', () => {
  const A = [-80.70, 34.35], B = [-80.68, 34.36];
  const plan = { legs: [{ id: 'L1', type: 'troll', coordinates: [A, B], depthFt: 20, startM: 0, lengthM: 1800 },
                        { id: 'L2', type: 'troll', coordinates: [B, A], depthFt: 22, startM: 1800, lengthM: 1800 }] };
  const marks = planWaypoints(plan, null, 'r').filter((w) => w.legStart || w.legEnd);
  assert.deepEqual(marks.map((w) => w.name), ['L1 15-25ft', 'L2 17-27ft']);
});

test('the same hump on a later leg says which leg and id it was first listed under', () => {
  // S1.1 and S5.1 of his plan: the one 18 ft hump, as loop1-out's p7 and loop3-out's p18.
  const hump = (id, structureId) => ({ id, type: 'hump', structureId, at: [-80.199515, 33.519727] });
  const legs = [
    { runId: 'lake_marion#loop1-out', passes: [hump('lake_marion#0:p7', 'h1'), { id: 'lake_marion#0:p9', type: 'hump', structureId: 'h1', at: [-80.199515, 33.519727] }] },
    { runId: 'lake_marion#loop1-back', passes: [{ id: 'lake_marion#1:p6', type: 'ledge', structureId: 'l9', at: [-80.21038, 33.52271] }] },
    { runId: 'lake_marion#loop3-out', passes: [hump('lake_marion#4:p18', 'h1'),
      // a point with no charted structure, 10 m from loop2's: the same kind within 15 m is the same thing
      { id: 'lake_marion#4:p2', type: 'point', structureId: null, at: [-80.22039, 33.52965 + 10 / 110540] }] },
  ];
  legs.splice(2, 0, { runId: 'lake_marion#loop2-out', passes: [{ id: 'lake_marion#2:p3', type: 'point', structureId: null, at: [-80.22039, 33.52965] }] });
  markRepeats(legs);
  assert.deepEqual(legs[3].passes[0].passedBefore, { runId: 'lake_marion#loop1-out', id: 'lake_marion#0:p7' });
  assert.deepEqual(legs[3].passes[1].passedBefore, { runId: 'lake_marion#loop2-out', id: 'lake_marion#2:p3' });
  // the first time it is passed it is not a return, and twice on ONE leg is that leg's own business
  assert.equal(legs[0].passes[0].passedBefore, undefined);
  assert.equal(legs[0].passes[1].passedBefore, undefined);
  assert.equal(legs[1].passes[0].passedBefore, undefined);
  // one rule for "the same thing", the spot fold's
  assert.equal(sameMark({ type: 'ledge', at: [0, 0] }, { type: 'ledge', at: [0, 20 / 110540] }), false);
  const src = read('../js/modules/plan-from-water.js');
  assert.ok(src.includes('const same = passes.find((h) => sameMark(h, s));'));
  assert.ok(src.includes('markRepeats(legs);'));
  assert.ok(src.includes('passedBefore: h.passedBefore || undefined'));
  assert.match(read('../js/modules/plan-prompt.js'), /THE SAME THING ON TWO LEGS IS ONE THING[\s\S]*passedBefore/);
});

test('a lead bait whose deep end is the floor is lifted a foot, and a bill bait on its floor is left alone', () => {
  // His L1: the 4" lipless on 100 ft at 2 mph runs 20-24 ft over a 24 ft floor -- gap 0, "taps".
  const LIPLESS = TACKLE_INVENTORY.find((l) => l.name === '4" Lipless Crankbait');
  const DD2 = TACKLE_INVENTORY.find((l) => /^DD2 Crankbait/.test(l.name));
  const lureByName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;
  assert.equal(depthWindow(LIPLESS, { speedMph: 2.0, leadFt: 100 }).max, 24);
  const leg = { runId: 'lake_marion#loop1-out', lengthM: 4158, depthFt: 27, maxRunDepthFt: 24,
                start: [-80.2212613, 33.5425632], end: [-80.1975489, 33.5154237],
                coordinates: [[-80.2212613, 33.5425632], [-80.1975489, 33.5154237]], passes: [], speedMph: 2.0 };
  const build = (rod) => assemblePlan({
    candidates: [leg], launch: [-80.224262, 33.546151], loadout: { rods: [rod] },
    deploy: { [leg.runId]: { port: rod.id } }, stops: [], changes: [],
    launchTime: '06:00', returnTime: '15:00', usableAh: 80, lureByName });
  const rodPlan = (plan, id) => (plan.legs.find((l) => l.type === 'troll').rodPlan || {})[id] || {};
  const lifted = rodPlan(build({ id: 'R3', lure: LIPLESS.name, rig: 'fluoro', role: 'troll', leadFt: 100, runsDepthFt: [20, 24] }), 'R3');
  assert.equal(lifted.leadFt, 96);
  assert.equal(bottomGapFt(24, depthWindow(LIPLESS, { speedMph: 2.0, leadFt: lifted.leadFt }).max), 1);
  // a DD2 rates 16-20: on a 20 ft floor its deep end is the floor, cannotUse offers it, and it stays
  if (DD2) {
    const leg20 = { ...leg, maxRunDepthFt: 20, depthFt: 24 };
    const plan = assemblePlan({ candidates: [leg20], launch: [-80.224262, 33.546151],
      loadout: { rods: [{ id: 'R1', lure: DD2.name, rig: 'fluoro', role: 'troll', leadFt: 76, runsDepthFt: [16, 20] }] },
      deploy: { [leg20.runId]: { port: 'R1' } }, stops: [], changes: [],
      launchTime: '06:00', returnTime: '15:00', usableAh: 80, lureByName });
    assert.ok(!(plan.warnings || []).some((w) => /R1 on .*wrong bait/.test(w)), (plan.warnings || []).join('\n'));
  }
  const src = read('../js/modules/plan-assemble.js');
  assert.ok(src.includes("if (onFloor && (w.mode !== 'lead' || bottomGapFt(ceilingFt, w.max) >= 1)) continue;"));
});
