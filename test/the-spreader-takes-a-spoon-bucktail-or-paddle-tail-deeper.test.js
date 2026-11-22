// Personal use only, not for distribution or resale; not for navigation.
//
// THE SPREADER TAKES A SPOON, A BUCKTAIL OR A PADDLE TAIL DEEPER.
//
// Ryan, 2026-11-22: "does the app know about the spreader rigs". It did not: they were left out of the box as hardware.
// Then, with the maker's page for the G. Pucci T-Bead Spreader (3" x 5", chartreuse, two of them): "with whatever weight
// tied on using lightweight line... then the lure is tied to the longer arm using 25lb fluro 5-6 ft long with whatever lure
// we want behind it"; the weights, "assume 1,2,3 oz but i probably have others"; behind it, "spoons, bucktails, paddle
// tails... haven't tried cranks yet". The plan names the weight and the bait, as it does a spoon's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TACKLE_INVENTORY, lureByName, SPREADERS_OWNED, SPREADER_NAME, spreaderCarries } from '../js/data/tackle-inventory.js';
import { connectionFor, depthWindow, trollableBaits } from '../js/data/lure-knowledge.js';
import { planArgsFrom, buildPlanRequest, spreaderRig, spreaderBlock } from '../js/modules/plan-prompt.js';
import { assemblePlan } from '../js/modules/plan-assemble.js';
import { planToTimeline, stopRodLine } from '../js/modules/plan-to-timeline.js';
import { rodsAtLaunch } from '../js/modules/rods-at-launch.js';

const BUCK = 'SPRO Prime Bucktail Jig 1oz (SBTJ-1)';
const SW4 = 'Swimbait 4" – Jighead';
const SPOON = 'Nichols Lake Fork Flutter Spoon 5" 1-1/8oz (FS14-118)';
const CRANK = 'Bomber Fat Free Shad BD7F';
const conn = (n) => { const l = lureByName(n); return l ? connectionFor(l.type) : null; };
const ask = (rods) => planArgsFrom({ loadout: { rods }, legs: [{ runId: 'w#1', deploy: { port: rods[0].id } }] },
  [{ runId: 'w#1' }], { tackle: TACKLE_INVENTORY.map((l) => l.name), connectionOf: conn });

test('his two spreaders are in the box as hardware, and carry a spoon, a bucktail or a paddle tail', () => {
  const s = TACKLE_INVENTORY.find((l) => l.id === 'spreader_tbead');
  assert.equal(s.name, 'G. Pucci T-Bead Spreader 3"x5"');
  assert.equal(s.trollable, false);
  assert.equal(s.castable, false);
  assert.equal(SPREADERS_OWNED, 2);
  assert.equal(SPREADER_NAME, s.name);
  for (const n of [BUCK, SW4, SPOON, 'P-Line Laser Minnow 2oz (PLM2)']) {
    const l = TACKLE_INVENTORY.find((x) => x.name === n) || lureByName(n);
    assert.ok(l && spreaderCarries(l), n);
  }
  for (const n of [CRANK, 'Fluke 4" – Jighead', 'A-Rig – five 1/2oz heads (~4.1oz)', 'Small Casting Spoon (Kastmaster type)']) {
    assert.equal(spreaderCarries(lureByName(n)), false, n);
  }
  // hardware is not offered as a bait, or refused as one
  const g = trollableBaits(TACKLE_INVENTORY, { speedMph: 2 });
  assert.ok(!g.legal.some((l) => l.type === 'spreader') && !g.refused.some((r) => r.type === 'spreader'));
});

test('the model is told of them, and how to ask for one', () => {
  const b = spreaderBlock();
  assert.match(b, /HIS SPREADERS\.\*\* He has 2 \(G\. Pucci T-Bead Spreader 3inx5in\)/);
  assert.match(b, /hangs off the short arm on light line/);
  assert.match(b, /5-6 ft of 25 lb fluoro off the long arm/);
  assert.match(b, /not a\s+crankbait or an A-rig/);
  const p = buildPlanRequest({ water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-11-23', launchTime: '06:00',
    returnTime: '15:00', species: ['Striped Bass'], conditions: {}, candidates: [],
    tackle: TACKLE_INVENTORY.map((l) => l.name), trollable: TACKLE_INVENTORY.filter((l) => l.trollable).map((l) => l.name),
    lureByName }).user;
  assert.match(p, /HIS SPREADERS/);
  assert.match(p, /you may add "spreader": true/);
});

test('a spreader rod gets the lightest of his weights that puts the bait where the plan wants it', () => {
  const shallow = spreaderRig({ lure: BUCK, runsDepthFt: [18, 22] });
  const deep = spreaderRig({ lure: BUCK, runsDepthFt: [34, 38] });
  assert.ok(shallow.weightOz <= deep.weightOz, `${shallow.weightOz} then ${deep.weightOz}`);
  assert.ok([1, 2, 3].includes(deep.weightOz));
  assert.equal(spreaderRig({ lure: SPOON }).weightOz, 2);          // no depth named: the middle of his three
  assert.match(deep.said, /^on a spreader: the \doz weight on the short arm on light line, 5-6 ft of 25 lb fluoro from the long arm to the bucktail$/);
  assert.match(spreaderRig({ lure: SW4, runsDepthFt: [28, 32] }).said, /to the swimbait$/);
});

test('the plan keeps a spreader on a spoon, bucktail or paddle tail troll rod, two at most, and says why it drops one', () => {
  const a = ask([
    { id: 'R3', lure: BUCK, color: 'white, red throat', role: 'troll', runsDepthFt: [26, 30], spreader: true },
    { id: 'R5', lure: SW4, color: 'white', role: 'troll', runsDepthFt: [26, 30], spreader: true },
    { id: 'R6', lure: SPOON, color: 'super shad', role: 'troll', runsDepthFt: [26, 30], spreader: true },
    { id: 'R1', lure: CRANK, color: 'ghost/pearl holographic', role: 'troll', spreader: true },
    { id: 'R4', lure: 'Bomber Super Pogy 1-1/4oz (hi p mullet)', color: 'hi-p mullet', role: 'cast', spreader: true },
  ]);
  const rod = (lure) => a.loadout.rods.find((r) => r.lure === lure);
  assert.equal(rod(BUCK).spreader, true);
  assert.equal(rod(SW4).spreader, true);
  assert.ok(rod(BUCK).inlineWeightOz > 0);
  assert.match(rod(BUCK).rigSaid, /^on a spreader: the/);
  // the third is over his two; the spoon keeps its own inline weight
  assert.equal(rod(SPOON).spreader, undefined);
  assert.match(rod(SPOON).rigSaid, /^behind the \doz inline weight/);
  assert.equal(rod(CRANK).spreader, undefined);
  const said = a.problems.join('\n');
  assert.match(said, /R6: he has 2 spreaders, and both are on other rods — no spreader/);
  assert.match(said, /R1: a Bomber Fat Free Shad BD7F does not go behind a spreader/);
  assert.match(said, /R4: a spreader is for trolling/);
});

// A leg like the 11/23 loops: 34 ft of water, a 30 ft floor.
const LEG = { runId: 'wateree_lake#81', lengthM: 1800, depthFt: 34, maxRunDepthFt: 30, start: [-80.70, 34.35],
  end: [-80.68, 34.36], coordinates: [[-80.70, 34.35], [-80.69, 34.355], [-80.68, 34.36]], passes: [], speedMph: 2.0 };
const build = (rods) => assemblePlan({ candidates: [LEG], launch: [-80.71, 34.348], loadout: { rods },
  deploy: { [LEG.runId]: { port: rods[0].id, starboard: rods[1] && rods[1].id } }, stops: [], changes: [],
  launchTime: '06:30', returnTime: '13:00', usableAh: 80, lureByName });

test('on the water the spreader\'s weight takes the bait deeper, and every card says it is on the spreader', () => {
  const bare = { id: 'R3', lure: BUCK, color: 'white, red throat', role: 'troll', rig: 'snap', leadFt: 90 };
  const onIt = { ...bare, id: 'R5', spreader: true, inlineWeightOz: 2,
                 rigSaid: 'on a spreader: the 2oz weight on the short arm on light line, 5-6 ft of 25 lb fluoro from the long arm to the bucktail' };
  const plan = build([onIt, bare]);
  const leg = plan.legs.find((l) => l.type === 'troll');
  assert.equal(leg.rodPlan.R5.inlineWeightOz, 2);
  assert.equal(leg.rodPlan.R5.spreader, true);
  assert.equal(leg.rodPlan.R3 && leg.rodPlan.R3.inlineWeightOz, undefined);
  const b = lureByName(BUCK);
  assert.ok(depthWindow({ ...b, inlineWeightOz: 2 }, { speedMph: 2, leadFt: 90 }).max
          > depthWindow(b, { speedMph: 2, leadFt: 90 }).max);
  // the ladder reads the spreader's weight too
  const ladderRods = (leg.depthLadder && leg.depthLadder.rows ? leg.depthLadder.rows : []).map((r) => JSON.stringify(r)).join('\n');
  assert.ok(!leg.depthLadder || /R5/.test(ladderRods), ladderRods);
  // the stop line and the card row
  assert.match(stopRodLine(onIt, leg, plan.legs), /R5: SPRO Prime Bucktail Jig 1oz \(SBTJ-1\) · white, red throat · on the spreader with the 2oz weight/);
  const tl = planToTimeline(plan);
  const rows = JSON.stringify(tl);
  assert.match(rows, /"spreader":true/);
  // Rods At Launch: the spreader sentence, not "inline"
  const ral = rodsAtLaunch({ plan, timeline: tl.timeline });
  const r5 = ral.rods.find((r) => r.id === 'R5');
  assert.equal(r5.weight, 'On a spreader: the 2oz weight on the short arm on light line, 5-6 ft of 25 lb fluoro from the long arm to the bucktail');
  assert.doesNotMatch(JSON.stringify(ral.rods), /2oz inline/);
});
