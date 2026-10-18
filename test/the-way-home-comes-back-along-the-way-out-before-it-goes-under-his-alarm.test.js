// THE WAY HOME COMES BACK ALONG THE WAY OUT BEFORE IT GOES UNDER HIS ALARM, AND A STOP IS NOT LOST FOR
// NAMING ITS STRUCTURE WHERE ITS LEG GOES.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan's Rowland plan for 10/24, built 2026-10-18 with Marion 2.9 ft down: Option 1's way home went up
// onto the bar at the creek mouth, 180 m under his 14 ft and 5 ft at the shallowest, where on 10/10 (the
// lake 1.1 ft lower) the same option had held 13. The way out holds the 19-21 ft edge on the bank side of
// the channel there, and the way home, kept to the bank side of it, had nowhere at his depth. Asked
// whether to find out why and make it hold his depth at both levels, and to put back the stop the plan
// had dropped: "please".
//
// Measured with the app's own trollLoop on the Marion pack and his journal (the route in his saved plan
// is this one to the metre): at 2.9 ft down, 310 -> 130 m under 14.3 ft, shallowest 5.1 -> 12.1 ft (a
// 50 m crossing of a chart corner between two cells), 234 min either way; at 3.99, 140 -> 0 m, 13 -> 15 ft.
// Marion's largemouth, Moultrie at 0 and 2 ft down, Wateree at 0 and 3, Bates: every option the same
// line. Murray from Hilton: Option 1 290 -> 90 m under its edge, the same 187 min.
//
// What these hold:
//   1. the way out's own line is a price of its own, between his gap and his alarm, and only when asked;
//   2. it is asked only when the way home without it goes under his alarm, so every other way home is
//      laid exactly as before, and the old prices hold when no line is offered;
//   3. a stop whose runId is a structure one leg lists is put on that leg, and the plan says so; one that
//      names nothing listed is left for the assembler to refuse, as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { planArgsFrom } from '../js/modules/plan-prompt.js';

const src = fs.readFileSync(new URL('../js/modules/plan-options.js', import.meta.url), 'utf8');
const live = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('1. the way out\'s own line: dearer than any number of his gap\'s cells, cheaper than under his alarm', () => {
  assert.ok(live.includes('function besideOn(net, out, lo, hi, steer, ends, side, sg, onLine = false) {'));
  assert.ok(live.includes('const line = onLine && !end && onOut[k] === 1 && side[k] === 0;'), 'only the line itself, only when asked');
  assert.ok(live.includes('if (side[k] !== sg && !line && !end) continue;'), 'the other side stays shut');
  assert.ok(live.includes('const t1 = sum + 1, tL = t1 * (n1 + 2), t2 = nL ? tL * (nL + 2) : tL;'));
  assert.ok(live.includes('else if (tier[k] === 2) c[k] = tL + base[k];'));
  assert.ok(live.includes('else if (tier[k] === 3) c[k] = t2 * underEdge(net.D[k], lo, steer);'));
});

test('2. asked only when the way home on its side would go under his alarm', () => {
  const i = live.indexOf('home = wayOf(so, from, S, besideOn(so, out, lo0, hi0, steer, [S, from], side, sg));');
  assert.ok(i > 0);
  const next = live.slice(i, i + 400);
  assert.ok(next.includes('if (home && home.some((q) => !(so.D[q] >= lo0 - steer))) {'));
  assert.ok(next.includes('besideOn(so, out, lo0, hi0, steer, [S, from], side, sg, true)) || home;'));
  // the way there for every other option is untouched (sideWay)
  assert.ok(live.includes('else if (tier[k] === 2) c[k] = t2 * underEdge(D[k], lo, steer);'), 'sideWay as it was');
});

const CANDS = [
  { runId: 'lake_marion#loop1-out', lengthM: 5833, depthFt: 25, start: [-80.221, 33.543], end: [-80.236, 33.517],
    coordinates: [[-80.221, 33.543], [-80.236, 33.517]],
    passes: [{ id: 'lake_marion#0:p1', atM: 1092, type: 'point', offM: 97, at: [-80.222, 33.540],
               what: 'point, 47 m bulge, 25.9 ft on the deep side, channel edge', depthFt: 25.9 }] },
  { runId: 'lake_marion#loop1-back', lengthM: 6135, depthFt: 24, start: [-80.236, 33.517], end: [-80.221, 33.543],
    coordinates: [[-80.236, 33.517], [-80.221, 33.543]],
    passes: [{ id: 'lake_marion#1:p18', atM: 5689, type: 'point', offM: 40, at: [-80.222, 33.540],
               what: 'point', depthFt: 25.9 }] },
];
const answer = (stops) => ({
  safety: { isGo: false, warning: 'wind', rampEvaluation: 'open to the NE' },
  loadout: { why: 'his A-rig', rods: [{ id: 'R1', lure: 'Nichols Lake Fork Flutter Spoon 3/4oz', color: 'Chrome', role: 'troll' }] },
  legs: [{ runId: 'lake_marion#loop1-out', speedMph: 2, deploy: { port: 'R1' }, why: 'out' },
         { runId: 'lake_marion#loop1-back', speedMph: 2, deploy: { port: 'R1' }, why: 'home' }],
  stops, changes: [], notes: {},
});

test('3. the stop at the channel-edge point, its id where its leg goes, is put on the leg that lists it', () => {
  const a = planArgsFrom(answer([
    { runId: 'lake_marion#0:p1', id: 'lake_marion#0:p1', rods: ['R1'], durationMin: 25, why: 'channel edge' },
    { runId: 'lake_marion#loop1-back', id: 'lake_marion#1:p18', rods: ['R1'], durationMin: 20, why: 'a return to lake_marion#0:p1' },
  ]), CANDS, {});
  assert.deepEqual(a.stops.map((s) => [s.runId, s.structureId]), [
    ['lake_marion#loop1-out', 'lake_marion#0:p1'], ['lake_marion#loop1-back', 'lake_marion#1:p18']]);
  assert.ok(a.problems.some((p) => /put on lake_marion#loop1-out, the one leg that lists lake_marion#0:p1/.test(p)), a.problems.join(' | '));
});

test('3. a runId that is no leg and no listed structure is left for the assembler to refuse', () => {
  const a = planArgsFrom(answer([{ runId: 'lake_marion#7', id: 'lake_marion#7:p0', rods: ['R1'], durationMin: 10 }]), CANDS, {});
  assert.deepEqual(a.stops.map((s) => s.runId), ['lake_marion#7']);
  assert.ok(!a.problems.some((p) => /put on/.test(p)));
});
