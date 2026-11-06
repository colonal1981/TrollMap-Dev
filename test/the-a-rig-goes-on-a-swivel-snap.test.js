// Personal use only, not for distribution or resale; not for navigation.
//
// THE A-RIG GOES ON A SWIVEL SNAP ROD BEFORE ANY OTHER SNAP BAIT.
//
// Ryan, 2026-11-06, of his Moultrie card for 11/8, which had the A-rig on R3, "20 lb fluoro leader — tie direct":
// "i also do not tie an a-rig to a leader... it use the swivel snap for the a-rig for ease of tieing knots".
// seatRods() filled the two snap rods in the model's order, and the swimbait and the spoon came first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seatRods, ROD_RIG } from '../js/modules/plan-prompt.js';
import { snapFirst, connectionFor } from '../js/data/lure-knowledge.js';

const TYPE = {
  'DD3 Crankbait (20-25ft)': 'crankbait_dd3',
  'Swimbait 5" – Jighead': 'jighead',
  'Nichols Lake Fork Flutter Spoon 5" 1-1/8oz (FS14-118)': 'flutter_spoon',
  'P-Line Laser Minnow 2oz (PLM2)': 'vertical_jig',
  'A-Rig – five 1/2oz heads (~4.1oz)': 'umbrella_rig',
  'SPRO Prime Bucktail Jig 1oz (SBTJ-1)': 'bucktail',
};
const connOf = (n) => (TYPE[n] ? connectionFor(TYPE[n]) : null);
const firstOf = (n) => !!TYPE[n] && snapFirst(TYPE[n]);
// The model's own loadout for 11/8, in its order.
const MOULTRIE = [
  { id: 'R1', lure: 'DD3 Crankbait (20-25ft)' }, { id: 'R2', lure: 'Swimbait 5" – Jighead' },
  { id: 'R3', lure: 'Nichols Lake Fork Flutter Spoon 5" 1-1/8oz (FS14-118)' },
  { id: 'R4', lure: 'P-Line Laser Minnow 2oz (PLM2)' }, { id: 'R5', lure: 'A-Rig – five 1/2oz heads (~4.1oz)' },
  { id: 'R6', lure: 'SPRO Prime Bucktail Jig 1oz (SBTJ-1)' },
];
const rodOf = (seat, lure) => seat.rods.find((r) => r.lure === lure).id;

test('only the A-rig is snap-first, and it is still a snap bait like the rest', () => {
  assert.equal(snapFirst('umbrella_rig'), true);
  for (const t of ['flutter_spoon', 'bucktail', 'jighead', 'crankbait_dd3']) assert.equal(snapFirst(t), false, t);
  assert.equal(connectionFor('umbrella_rig'), 'snap');
});

test('his 11/8 loadout: the A-rig on a snap rod, the crankbait still tied to a leader', () => {
  const seat = seatRods(MOULTRIE, connOf, firstOf);
  const a = rodOf(seat, 'A-Rig – five 1/2oz heads (~4.1oz)');
  assert.equal(ROD_RIG[a], 'snap', `the A-rig is on ${a}`);
  assert.equal(ROD_RIG[rodOf(seat, 'DD3 Crankbait (20-25ft)')], 'fluoro');
  assert.equal(seat.rods.filter((r) => r.lure && ROD_RIG[r.id] === 'snap').length, 2, 'both snaps carry a bait');
  assert.deepEqual(seat.problems, []);
});

test('without the rule it is the old order (the swimbait and the spoon took the snaps)', () => {
  const seat = seatRods(MOULTRIE, connOf);
  assert.equal(ROD_RIG[rodOf(seat, 'A-Rig – five 1/2oz heads (~4.1oz)')], 'fluoro');
});

test('more A-rigs than snap rods: the extra one goes on a leader rod and the plan says so', () => {
  const three = ['A', 'B', 'C'].map((k, i) => ({ id: `R${i + 1}`, lure: `A-Rig ${k}` }));
  const seat = seatRods(three, () => 'snap', () => true);
  assert.equal(seat.rods.filter((r) => r.lure && ROD_RIG[r.id] === 'snap').length, 2);
  assert.equal(seat.problems.length, 1);
  assert.match(seat.problems[0], /^A-Rig C is on a leader rod \(R1\): there are more A-rigs than snap rods/);
});

test('both planners hand the rule to the seating', () => {
  const sp = readFileSync(new URL('../js/modules/smart-plan-v2.js', import.meta.url), 'utf8');
  assert.match(sp, /planArgsFrom\(res, candidates, \{ tackle: o\.tackle, connectionOf, snapFirstOf \}\)/);
  const pw = readFileSync(new URL('../js/modules/plan-water-ui.js', import.meta.url), 'utf8');
  assert.match(pw, /snapFirstOf: \(name\) => \{/);
  // and the one-troll Build the day passes it on: planFromWater() called planArgsFrom() without it (found 11/6 evening)
  const pf = readFileSync(new URL('../js/modules/plan-from-water.js', import.meta.url), 'utf8');
  assert.match(pf, /planArgsFrom\(res, legs, \{ tackle: o\.tackle, connectionOf: o\.connectionOf, snapFirstOf: o\.snapFirstOf \}\)/);
  const pp = readFileSync(new URL('../js/modules/plan-prompt.js', import.meta.url), 'utf8');
  // and the spoon's weight rides a snap too (11/6), named in planArgsFrom itself
  assert.match(pp, /seatRods\(claimed, ctx\.connectionOf, ctx\.snapFirstOf, ctx\.weightOf \|\| needsInlineWeightByName\)/);
});

// AND THE TRIP REPORT'S A-RIG SECTION IS THE RIG ON THE CARD. Ryan, 2026-11-06: "this doesn't match the loadout": it
// printed "~2.65oz Framework", "4.6\" swimbait" and "3/16oz × 5" five times, once a leg, with no rod.
test("the report's A-rig rows: one a rod, its legs, its heads and weight from its name, nothing invented", () => {
  const src = readFileSync(new URL('../js/modules/plan-builder.js', import.meta.url), 'utf8');
  const i = src.indexOf('export function arigBreakdownRows');
  const j = src.indexOf('export function laneTelemetry');
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const arigBreakdownRows = new Function('esc', `${src.slice(i, j).replace('export function', 'return function')}`)(esc);
  const row = (leg, side) => ({ side, rod: 'R5', lure: 'A-Rig – five 1/2oz heads (~4.1oz)', color: 'pearl/white swimbaits, silver blades',
                                lead: 90, depth: '22–26', trailerSize: '', notes: `[Leg ${leg} — loop] why` });
  const spread = [row(1, 'Stbd'), row(2, 'Stbd'), row(3, 'Stbd'), row(4, 'Stbd'), row(6, 'Port'),
                  { side: 'Port', rod: 'R1', lure: 'DD3 Crankbait (20-25ft)', notes: '[Leg 3 — x]' }];
  const html = arigBreakdownRows(spread);
  assert.equal((html.match(/<tr>/g) || []).length, 1, 'one rod, one row');
  assert.match(html, /<b>R5<\/b>/);
  assert.match(html, /L1, L2, L3, L4, L6/);
  assert.match(html, /five 1\/2oz heads, about 4\.1 oz with the frame/);
  assert.match(html, /22–26 ft<\/b> @ <b>90 ft lead/);
  assert.doesNotMatch(html, /2\.65|3\/16|4\.6/);
  assert.equal(arigBreakdownRows([{ rod: 'R1', lure: 'DD3 Crankbait (20-25ft)' }]), '');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /~2\.65oz Framework|3\/16oz × 5/, 'the old defaults are gone from the code');
});

// THE SPOON'S WEIGHT RIDES THE SNAP, SO A SPOON TAKES A SNAP ROD BEFORE A CAST BAIT. Ryan, 9/14: "the weight attaches to
// one of the swivel snap rods then has a 5ft fluoro leader with the spoon tied on". His 11/8 card (rerun, 11/6): Claude
// had the A-rig on R5 and the spoon on R6, the bucktail and the Spook as cast rods; the app moved the cast bucktail onto
// R6 and the spoon onto a leader rod. And of the report: "nothing in the html i am looking at says that the spoon is
// supposed to be tied to a weight and if so what weight... right now the spoon i have tied to the 2oz weight is the
// smaller 4 inch spoon that is 3/4oz".
test('a spoon takes a snap rod before a cast bait, and says its weight and leader whether or not it is deployed', async () => {
  const { planArgsFrom, needsInlineWeightByName, spoonRig } = await import('../js/modules/plan-prompt.js');
  const { TACKLE_INVENTORY, RIGGED_SPOON } = await import('../js/data/tackle-inventory.js');
  const BIG = 'Nichols Lake Fork Flutter Spoon 5" 1-1/8oz (FS14-118)';
  const BUCK = 'SPRO Prime Bucktail Jig 1oz (SBTJ-1)';
  const rods = [{ id: 'R1', lure: 'DD3 Crankbait (20-25ft)' }, { id: 'R2', lure: 'DD2 Crankbait (16-20ft)' },
                { id: 'R3', lure: BUCK, role: 'cast' }, { id: 'R4', lure: 'Walking Bait / Spook', role: 'cast' },
                { id: 'R5', lure: 'A-Rig – five 1/2oz heads (~4.1oz)' }, { id: 'R6', lure: BIG, runsDepthFt: [26, 32] }];
  const type = new Map(TACKLE_INVENTORY.map((l) => [l.name, l.type]));
  const conn = (n) => (type.has(n) ? connectionFor(type.get(n)) : null);
  const seat = seatRods(rods, conn, (n) => type.has(n) && snapFirst(type.get(n)), needsInlineWeightByName);
  const on = (lure) => seat.rods.find((r) => r.lure === lure).id;
  assert.equal(ROD_RIG[on(BIG)], 'snap', `the spoon is on ${on(BIG)}`);
  assert.equal(ROD_RIG[on('A-Rig – five 1/2oz heads (~4.1oz)')], 'snap');
  assert.equal(ROD_RIG[on(BUCK)], 'fluoro', 'the cast bucktail ties on a leader rod');
  assert.deepEqual(seat.problems, []);
  // the rigged spoon, as he said it
  assert.equal(RIGGED_SPOON.weightOz, 0.75);
  assert.equal(RIGGED_SPOON.lengthIn, 4);
  // the big spoon: its weight, snap and leader said, and a re-tie
  const big = spoonRig({ id: 'R6', lure: BIG, runsDepthFt: [26, 32] });
  assert.equal(big.weightOz, 2);
  assert.match(big.said, /behind the 2oz inline weight on the swivel snap, 5 ft fluoro leader to the spoon/);
  assert.match(big.retie, /the 2oz weight has the 4" 3\/4oz spoon tied behind it now, so this is a re-tie at the truck/);
  const small = spoonRig({ id: 'R6', lure: RIGGED_SPOON.name, runsDepthFt: [20, 24] });
  assert.equal(small.retie, null);
  assert.match(small.said, /as it is tied now$/);
  // and through planArgsFrom, on a spoon that is only ever the backup
  const res = { loadout: { rods }, legs: [{ runId: 'w#1', deploy: { port: 'R1', starboard: 'R5' },
                                            ifNotProducing: { rodId: 'R6', insteadOf: 'R1', why: 'x' } }] };
  const a = planArgsFrom(res, [{ runId: 'w#1' }], { tackle: TACKLE_INVENTORY.map((l) => l.name), connectionOf: conn,
                                                   snapFirstOf: (n) => type.has(n) && snapFirst(type.get(n)) });
  const sp = a.loadout.rods.find((r) => r.lure === BIG);
  assert.equal(sp.inlineWeightOz, 2);
  assert.match(sp.rigSaid, /5 ft fluoro leader/);
  assert.ok(a.problems.some((p) => /re-tie at the truck/.test(p)));
  // the rods list prints it for a rod that never goes in the water
  const { rodsAtLaunch } = await import('../js/modules/rods-at-launch.js');
  const list = rodsAtLaunch({ plan: { loadout: a.loadout }, timeline: [] });
  const row = list.rods.find((r) => r.lure === BIG);
  assert.match(row.weight, /^Behind the 2oz inline weight on the swivel snap, 5 ft fluoro leader/);
});
