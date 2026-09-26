// ─────────────────────────────────────────────────────────────────────────────────────────────
// A WEIGHTED BAIT IS LEADED TO THE DEPTH ASKED FOR, "CLEARS" MEANS OFF THE BOTTOM, AND THE
// LAKE'S MEASURED DRAWDOWN COMES OFF THE CHART BEFORE A BAIT IS CHECKED AGAINST IT.
//
// Ryan's Pick Water plan for Lake Wateree, 2026-09-26: 3.40 ft below full pool, anoxic below
// 19.7 ft. The model asked for R5 -- the 3/4oz Nichols flutter spoon behind the 2oz inline weight
// -- at 12-16 ft and wrote `leadFt: 90`. The app kept the 90, which runs that rig 24-28 ft: under
// the anoxic line and ten feet under the depth asked for, on every deep leg. On the shallow legs
// it shortened the lead "so it clears" to a lead that put the spoon's deep end exactly ON the
// rise -- and the card, reading the same numbers, said gap 0, taps. Same for a 3/4oz bucktail on
// a 6 ft rise. And every one of those checks compared against the full-pool chart, 3.4 ft deeper
// than the water he was in.
//
// Real inventory and real lure physics throughout, the same as bait-depth-ceiling.test.js.
// Personal use only, not for distribution or resale; not for navigation.
// ─────────────────────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assemblePlan } from '../js/modules/plan-assemble.js';
import { planToTimeline } from '../js/modules/plan-to-timeline.js';
import { buildPlanRequest } from '../js/modules/plan-prompt.js';
import { buildSmartPlanV2 } from '../js/modules/smart-plan-v2.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';
import { depthWindow } from '../js/data/lure-knowledge.js';
import { poolOffsetFt, todayDepthFt } from '../js/utils/water-conditions.js';

const lureByName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;
const SPOON = lureByName('Nichols Lake Fork Flutter Spoon 3/4oz');
const BUCKTAIL = lureByName('3/4oz Bucktail Jig');
const MR = lureByName('MR Crankbait (6-12ft)');
const RIGGED_SPOON = { ...SPOON, inlineWeightOz: 2 };
const ANOXIC = 19.7;
const WATEREE_TODAY = { featureType: 'lake', belowFullPoolFt: 3.4, levelFt: 222.1, fullPoolFt: 225.5 };

const leg = (runId, { min, median, max = median + 8 }) => ({
  runId, lengthM: 1800, depthFt: median, depthMinFt: min, depthMaxFt: max, maxRunDepthFt: min,
  start: [-80.70, 34.35], end: [-80.68, 34.36],
  coordinates: [[-80.70, 34.35], [-80.69, 34.355], [-80.68, 34.36]],
  passes: [], speedMph: 2.0,
});
const R5 = () => ({ id: 'R5', lure: SPOON.name, rig: 'snap', role: 'troll', leadFt: 90,
                    runsDepthFt: [12, 16] });
const R6 = () => ({ id: 'R6', lure: BUCKTAIL.name, rig: 'snap', role: 'troll', leadFt: 70,
                    runsDepthFt: [10, 15] });

const build = (legs, rods, extra = {}) => assemblePlan({
  candidates: legs, launch: [-80.71, 34.348],
  loadout: { rods },
  deploy: Object.fromEntries(legs.map((l) => [l.runId, { port: rods[0].id,
                                                          starboard: rods[1] && rods[1].id }])),
  stops: [], changes: [], launchTime: '06:30', returnTime: '13:00', usableAh: 80,
  lureByName, ...extra,
});
const trollLeg = (plan, runId) => plan.legs.find((l) => l.type === 'troll' && l.runId === runId);
const cardRod = (plan, runId, rodId) => {
  const t = planToTimeline(plan, { warnings: plan.warnings });
  const card = t.timeline.find((c) => c.legType === 'troll' && c.warnings !== undefined
    && plan.legs.find((l) => l.id === c.legId && l.runId === runId));
  return { card, rod: (card.rods || []).find((r) => r.rod === rodId) };
};

// ── BUG D ───────────────────────────────────────────────────────────────────────────────────────

test('a spoon behind the weight is leaded to the 12-16 ft asked for, not the 90 ft named', () => {
  // The number the app used to keep: 90 ft on this rig is 24-28 ft.
  assert.equal(depthWindow(RIGGED_SPOON, { speedMph: 2.0, leadFt: 90 }).max, 28);
  const deep = leg('wateree_lake#597', { min: 30, median: 33 });
  const plan = build([deep], [R5()], { oxygenFloorFt: ANOXIC, waterState: WATEREE_TODAY });
  const got = (trollLeg(plan, deep.runId).rodPlan || {}).R5 || {};
  assert.ok(Number.isFinite(got.leadFt) && got.leadFt < 90, `lead ${got.leadFt}`);
  const w = depthWindow(RIGGED_SPOON, { speedMph: 2.0, leadFt: got.leadFt });
  assert.deepEqual(got.runsDepthFt, [w.min, w.max]);
  assert.ok(w.min >= 12 && w.max <= 16, `runs ${w.min}-${w.max}`);
  assert.ok(w.max <= ANOXIC);
  // The card prints the fitted lead and the depth it runs, not 90 and 24-28.
  const { rod } = cardRod(plan, deep.runId, 'R5');
  assert.equal(rod.lead, got.leadFt);
  assert.equal(rod.depth, `${w.min}–${w.max}`);
  // And the app says what it did, once, where decisions go.
  assert.ok(plan.decisions.some((d) => /^R5 on wateree_lake#597\b.*12-16 ft the plan asked for/.test(d)));
});

test('no bait lead can lift runs under the measured anoxic line', () => {
  // Asked for deeper than the oxygen goes: the lead stops the spoon above 19.7, and says why.
  const rod = { ...R5(), runsDepthFt: [22, 26] };
  const deep = leg('wateree_lake#597', { min: 30, median: 33 });
  const plan = build([deep], [rod], { oxygenFloorFt: ANOXIC });
  const got = trollLeg(plan, deep.runId).rodPlan.R5;
  const w = depthWindow(RIGGED_SPOON, { speedMph: 2.0, leadFt: got.leadFt });
  assert.ok(w.max <= ANOXIC, `runs to ${w.max}`);
  assert.ok(plan.decisions.some((d) => /19\.7 ft anoxic line/.test(d)));
  // A plain lead-controlled bait on a lead that takes it under the line comes up too.
  const lipless = TACKLE_INVENTORY.find((l) => l.type === 'lipless' && l.weightOz === 0.5);
  const p2 = build([deep], [{ id: 'R1', lure: lipless.name, rig: 'snap', role: 'troll',
                              leadFt: 120 }], { oxygenFloorFt: ANOXIC });
  const g2 = trollLeg(p2, deep.runId).rodPlan.R1;
  assert.ok(depthWindow(lipless, { speedMph: 2.0, leadFt: g2.leadFt }).max <= ANOXIC);
  // No floor measured, nothing moved: the same lipless keeps its 120 ft.
  const p3 = build([deep], [{ id: 'R1', lure: lipless.name, rig: 'snap', role: 'troll',
                              leadFt: 120 }]);
  assert.equal(trollLeg(p3, deep.runId).rodPlan.R1.leadFt, undefined);
});

test('a shortened lead leaves the spoon OFF the rise, and the card agrees', () => {
  // The Sep 26 sentence: 90 ft, 28 ft deep, "shortened the lead to 42 ft so it clears" on a leg
  // that runs 14 ft at its shallowest -- and the card said gap 0, taps. Water shallow the whole
  // way along (median 14) so the lead IS shortened; no depth asked, so nothing is fitted first.
  const rod = { ...R5(), runsDepthFt: undefined };
  const flat = leg('wateree_lake#1485', { min: 14, median: 14, max: 16 });
  const plan = build([flat], [rod]);
  const said = plan.warnings.find((w) => /^R5 on wateree_lake#1485: .*shortened the lead/.test(w));
  assert.ok(said, plan.warnings.join('\n'));
  assert.doesNotMatch(said, /so it clears/);
  const got = trollLeg(plan, flat.runId).rodPlan.R5;
  const w = depthWindow(RIGGED_SPOON, { speedMph: 2.0, leadFt: got.leadFt });
  assert.ok(w.max < 14, `runs to ${w.max} on a 14 ft rise`);
  const { rod: row } = cardRod(plan, flat.runId, 'R5');
  assert.equal(row.clearance.taps, false);
  assert.ok(row.clearance.gap > 0, `gap ${row.clearance.gap}`);
});

test('a bucktail shortened for a 6 ft rise rides above it, not on it', () => {
  // "a 3/4oz Bucktail Jig on 70 ft of lead at 2 mph runs to 17 ft, and this leg runs 6 ft at its
  // shallowest with a median of 12 ft ... shortened the lead to 18 ft so it clears" -- 18 ft of
  // lead is 2-6 ft, the deep end ON the 6 ft rise.
  assert.equal(depthWindow(BUCKTAIL, { speedMph: 2.0, leadFt: 18 }).max, 6);
  const shallow = leg('wateree_lake#1776', { min: 6, median: 12, max: 14 });
  const plan = build([shallow], [R6()]);
  const got = trollLeg(plan, shallow.runId).rodPlan.R6;
  assert.ok(got.leadFt < 18, `lead ${got.leadFt}`);
  assert.ok(depthWindow(BUCKTAIL, { speedMph: 2.0, leadFt: got.leadFt }).max < 6);
  const { rod } = cardRod(plan, shallow.runId, 'R6');
  assert.equal(rod.clearance.taps, false);
  assert.ok(rod.clearance.gap > 0, `gap ${rod.clearance.gap}`);
});

test('the lead offered over a flagged rise is one that gets the bait off it', () => {
  // Spoon fitted to 12-16 on a leg with a 14 ft rise and a 20 ft median: the lead is left where it
  // is and the rise flagged, with a lead that clears it. That lead has to CLEAR it.
  const risey = leg('wateree_lake#1480', { min: 14, median: 20 });
  const plan = build([risey], [R5()]);
  const got = trollLeg(plan, risey.runId).rodPlan.R5;
  assert.ok(Number.isFinite(got.clearsAt), JSON.stringify(got));
  assert.ok(depthWindow(RIGGED_SPOON, { speedMph: 2.0, leadFt: got.clearsAt }).max < 14);
});

// ── BUG E ───────────────────────────────────────────────────────────────────────────────────────

test('the drawdown is the stated one, and nothing when there is no level', () => {
  assert.equal(poolOffsetFt(WATEREE_TODAY), 3.4);
  // The stated drawdown wins over a subtraction; a subtraction stands in when nothing is stated.
  assert.equal(poolOffsetFt({ featureType: 'lake', belowFullPoolFt: 3.4, levelFt: 1, fullPoolFt: 2 }), 3.4);
  assert.equal(poolOffsetFt({ featureType: 'lake', levelFt: 222.1, fullPoolFt: 225.5 }), 3.4);
  assert.equal(poolOffsetFt({ featureType: 'lake', belowFullPoolFt: -1.2 }), -1.2);
  assert.equal(poolOffsetFt({ featureType: 'lake', belowFullPoolFt: null, levelFt: null }), null);
  assert.equal(poolOffsetFt({ featureType: 'river', belowFullPoolFt: 3.4 }), null);
  assert.equal(poolOffsetFt(null), null);
  assert.equal(todayDepthFt(15, 3.4), 11.6);
  assert.equal(todayDepthFt(15, -1.2), 16.2);          // above full pool adds water
  assert.equal(todayDepthFt(15, null), 15);
});

const names = TACKLE_INVENTORY.filter((l) => l.trollable).map((l) => l.name);
const ask = (waterState) => buildPlanRequest({
  water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-09-26',
  launchTime: '07:00', returnTime: '12:00', species: ['Striped Bass'], conditions: {},
  tackle: names, trollable: names, lureByName, waterState,
  candidates: [{ runId: 'wateree_lake#1422', depthFt: 23, maxRunDepthFt: 15, lengthM: 1954 }],
}).user;
const cands = (text) => {
  const i = text.indexOf('[{"runId"');
  return JSON.parse(text.slice(i, text.indexOf('\n', i)));
};

test('3.4 ft down, a 15 ft rise is 11.6 ft of water and the 6-12 ft MR is on cannotUse', () => {
  const c = cands(ask(WATEREE_TODAY))[0];
  assert.ok((c.cannotUse || []).includes(MR.name), JSON.stringify(c.cannotUse));
  // The depth QUOTED stays the chart's; the prompt says the list already has the drawdown off.
  assert.equal(c.maxRunDepthFt, 15);
  assert.match(ask(WATEREE_TODAY), /exception is `cannotUse` on each leg.*less 3\.4 ft/s);
});

test('with no level published, cannotUse is what it always was', () => {
  const c = cands(ask(null))[0];
  assert.ok(!(c.cannotUse || []).includes(MR.name), JSON.stringify(c.cannotUse));
  assert.doesNotMatch(ask(null), /exception is `cannotUse`/);
});

test('the card measures the bait against the bottom today and says it is the chart less the drawdown', () => {
  const mrRod = { id: 'R1', lure: MR.name, rig: 'tie', role: 'troll', leadFt: 60, runsDepthFt: [6, 12] };
  const risey = leg('wateree_lake#1422', { min: 15, median: 23 });
  const plan = build([risey], [mrRod], { waterState: WATEREE_TODAY });
  const L = trollLeg(plan, risey.runId);
  assert.equal(L.depthMinFt, 15);                       // the leg's own depths are the chart's
  assert.equal(L.drawdownFt, 3.4);
  const { card, rod } = cardRod(plan, risey.runId, 'R1');
  assert.equal(rod.clearance.floorFt, 11.6);
  assert.equal(rod.clearance.chartFloorFt, 15);
  assert.equal(rod.clearance.taps, true);               // 12 ft of bill into 11.6 ft of water
  assert.match(card.bottomNote, /Bottom is 11\.6 ft here today — the chart's 15 ft less the 3\.4 ft the lake is below full pool/);
  // And the bait check in the assembler saw the same 11.6.
  assert.ok(plan.warnings.concat(plan.decisions).some((w) => /^R1 on wateree_lake#1422: .*11\.6 ft/.test(w)),
            plan.warnings.concat(plan.decisions).join('\n'));
});

test('with no level published, the card and the checks are unchanged', () => {
  const mrRod = { id: 'R1', lure: MR.name, rig: 'tie', role: 'troll', leadFt: 60, runsDepthFt: [6, 12] };
  const risey = leg('wateree_lake#1422', { min: 15, median: 23 });
  const plan = build([risey], [mrRod]);
  const L = trollLeg(plan, risey.runId);
  assert.equal(L.drawdownFt, undefined);
  const { card, rod } = cardRod(plan, risey.runId, 'R1');
  assert.equal(rod.clearance.floorFt, 15);
  assert.equal(rod.clearance.gap, 3);
  assert.equal(rod.clearance.taps, false);
  assert.match(card.bottomNote, /^Bottom is 15 ft here and the deepest bait rides 3 ft off it/);
});

test('Smart Plan hands the water state to the checks, end to end', async () => {
  // One lane, 28 ft with an 8 ft rise, through the real planner. The same lane as the end-to-end
  // block in bait-depth-ceiling.test.js.
  const STEP = 100, N = 40;
  const lineFt = Array.from({ length: N + 1 }, (_, k) => (k === 20 || k === 21 ? 8 : 28));
  const lane = { type: 'Feature',
    geometry: { type: 'LineString',
      coordinates: Array.from({ length: N + 1 }, (_, k) => [-80.720 + (k * STEP) / 91000, 34.380]) },
    properties: { id: 'w#1', depth_ft: 28, mean_depth_ft: 28, length_m: N * STEP, routable: true,
      fitted: true, envelope_step_m: STEP, envelope_line_ft: lineFt, envelope_ft: lineFt,
      near: Array.from({ length: 16 }, (_, k) => ({ s: 200 + k * 240, t: 'hump', d: 26 })) } };
  const PACK = { '/w/trolling_runs.geojson': { features: [lane] },
                 '/w/structure.geojson': { features: [] }, '/w/water_features.geojson': { features: [] } };
  const lipless = TACKLE_INVENTORY.find((l) => l.type === 'lipless' && l.weightOz === 0.5);
  const DD2 = TACKLE_INVENTORY.find((l) => /DD2/.test(l.name));
  // R1/R5 as in bait-depth-ceiling.test.js: seatRods() re-seats a rod whose id does not match its
  // connection, and a leg deploying a renamed id has nothing in the water.
  const model = async ({ user }) => {
    const runId = (user.match(/"runId":\s*"([^"]+)"/) || [])[1];
    return JSON.stringify({
      safety: { isGo: true, warning: '', rampEvaluation: 'sheltered' },
      loadout: { why: 'x', rods: [
        { id: 'R1', lure: DD2.name, color: 'Shad', role: 'troll', leadFt: 60,
          runsDepthFt: [16, 20], why: 'x' },
        { id: 'R5', lure: lipless.name, color: 'Chrome', role: 'troll',
          leadFt: 60, runsDepthFt: [11, 15], why: 'x' }] },
      legs: [{ runId, speedMph: 2.0, deploy: { port: 'R1', starboard: 'R5' }, why: 'x' }],
      stops: [], changes: [], notes: {} });
  };
  const r = await buildSmartPlanV2({
    r2Key: 'w', chartpackBase: '', ramp: [-80.73, 34.38], rampName: 'Clearwater Cove',
    water: 'Lake Wateree, SC', date: '2026-09-26', launchTime: '07:00', returnTime: '12:00',
    species: 'Striped Bass', fishDepthFt: [10, 20], holding: 'suspended',
    usableAh: 80, windowMin: 300, conditions: {}, waterState: WATEREE_TODAY,
    tackle: [lipless.name, DD2.name], inventory: [lipless, DD2], lureByName,
    fetchJson: async (p) => PACK[p] ?? null, askModel: model,
  });
  const L = r.plan.legs.find((l) => l.type === 'troll');
  assert.equal(L.depthMinFt, 8);
  assert.equal(L.drawdownFt, 3.4);
  const t = planToTimeline(r.plan, { warnings: r.plan.warnings });
  const card = t.timeline.find((c) => c.type === 'troll' && c.legType === 'troll');
  // Whatever rod seatRods() put it on: the one lure in the boat.
  const rod = card.rods.find((x) => x && x.lure === lipless.name);
  assert.ok(rod, JSON.stringify(card.rods));
  assert.equal(rod.clearance.floorFt, 4.6);
  assert.match(card.bottomNote, /the chart's 8 ft less the 3\.4 ft/);
});

test('Pick Water hands the assembler the same water state and oxygen floor', () => {
  const live = (f) => readFileSync(new URL(f, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const src = live('../js/modules/plan-from-water.js');
  const call = src.slice(src.indexOf('assemblePlan({'));
  assert.match(call, /waterState: \(o\.planArgs && o\.planArgs\.waterState\) \?\? o\.waterState/);
  // From planArgs, which is where plan-water-ui.js puts it.
  assert.match(call, /oxygenFloorFt: \(o\.planArgs && o\.planArgs\.oxygenFloorFt\)/);
  assert.match(live('../js/modules/smart-plan-v2.js').slice(
    live('../js/modules/smart-plan-v2.js').indexOf('assemblePlan({')), /oxygenFloorFt,/);
});
