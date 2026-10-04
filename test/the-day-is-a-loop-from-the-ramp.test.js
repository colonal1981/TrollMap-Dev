// The day is one line from the ramp and back: loops along the edges, not pieces stitched together.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-03, on the Wateree day "Plan it as one troll" built by stringing Find water's pieces:
// "how is this one continuous troll? this is just joining a bunch of random lines together and not
// even in a straight line... there are double backs and sharp turns... doesn't start or end at the
// ramp at all". His four Wateree days from his unit's log, and the loop he drew round Moultrie's dam
// basin ("using structure and my catch history and other things to decide exactly where the track
// would go"), are what plan-troll-loop.js builds instead.
//
// A synthetic lake: a channel 16 km long and 600 m wide, 45 ft in the middle, shoaling to both banks
// in 5 ft bands; the ramp on the north bank halfway along, so a day can go either way and neither end
// is in reach. What these hold:
//   1. the day leaves the cove mouth and comes back to it: every loop starts and ends there, and the
//      only water run with the lines up is out of the cove and back in;
//   2. there is no floor (since 10/4): a loop rides its own line and nothing closes water but land,
//      the shore, keep-out zones and water with none in it today;
//   3. the line rides its contour (one steering band deeper than an old floorFt), and comes home on
//      the other edge -- not within 100 m of the way out;
//   4. his catches of the day's species decide which way the loop goes when the water does not;
//   5. a place he ticked is where a loop turns;
//   6. each loop is two legs, out and back, built as pieces whose steps leave nothing to run between
//      them; and the assembler puts no transit between a leg and the one starting where it ends;
//   7. "Troll it for me" lays the loop (not trollDay) without freezing the page, and "Plan it as one
//      troll" waits for it;
//   8. a loop that comes home over the water it went out on, or over water an earlier loop of the day
//      trolled, does not fill the day with it, however many of his fish it passes: his 10/3 Wateree day laid live (the lake 3.2 ft down) was four loops, and
//      three came home within 100 m of the way out for 81-88% of the way;
//   9. the lines go in where a loop fits: the nearest deep-enough water to Short Stay on Moultrie at
//      a 40 ft floor was one cell of a hole, and the day said no loop fits;
//  10. the line is the depth with the most of HIS catches of the fish inside the 5 ft he steers either
//      side of it, then the research's water, and only then the fish band -- the band's deep edge as a
//      floor put Moultrie's line on 55 ft (Ryan, 10/3), and the middle of his catches less 5 ft as a
//      floor made Wyboo Creek one loop (Ryan, 10/4: "this sounds like AI math");
//  11. a leg is named for its loop and its half: the plan of 10/4 called its four legs loop1-loop4,
//      and the model wrote "on loop3" about the second loop's way out;
//  12. a loop added to the day is mostly new water, or it is a double back and the day stops before it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trollLoop, trollLoopAsync, depthGrid, loopPieces, loopSteps, marksAlong, densify, sharedWaterM, loopLine, lineFromDepths, SAME_WATER_M } from '../js/modules/plan-troll-loop.js';
import { metresBetween } from '../js/modules/plan-candidates.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, '..', f), 'utf8');

const LAT0 = 34.0, KX = 111320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110540;
const at = (x, y) => [-80 + x / KX, LAT0 + y / KY];
const L = 16000, W = 600, MAXFT = 45;
const depthAtY = (y) => MAXFT * Math.sin((Math.PI * y) / W);
const yOf = (ft) => (Math.asin(Math.min(1, ft / MAXFT)) * W) / Math.PI;
const rect = (x0, y0, x1, y1, ft) => ({ type: 'Feature', properties: { depth_max_ft: ft },
  geometry: { type: 'Polygon', coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]] } });
const DA = [];
for (let ft = 0; ft < MAXFT; ft += 5) {
  const a = yOf(ft), b = yOf(ft + 5);
  DA.push(rect(0, a, L, b, ft + 5));             // south side
  DA.push(rect(0, W - b, L, W - a, ft + 5));     // north side
}
DA.push(rect(0, yOf(MAXFT - 0.01), L, W - yOf(MAXFT - 0.01), MAXFT));
const RAMP = at(8000, W - 10);
const BASE = { ramp: RAMP, daFeatures: DA, floorFt: 20, windowMin: 180, stopMin: 0, maxPetals: 1 };
const grid = depthGrid(DA, { bbox: [-80.01, 33.99, -79.8, 34.02], cellM: 25 });
const M_PER_MIN = (2 * 1609.344) / 60;
const xOf = (pt) => (pt[0] + 80) * KX;
const yAt = (pt) => (pt[1] - LAT0) * KY;

test('1. every loop leaves the cove mouth and comes back to it; only the cove is run', () => {
  const r = trollLoop(BASE);
  assert.ok(!r.error, r.error);
  for (const p of r.petals) {
    assert.ok(metresBetween(p.out[0], r.start) < 1);
    assert.ok(metresBetween(p.back[p.back.length - 1], r.start) < 1);
  }
  assert.ok(r.coveM < 300, `out of the cove ${r.coveM} m`);
  assert.ok(Math.abs(r.runM - 2 * r.coveM) <= 1, `run ${r.runM} m, cove ${r.coveM} m`);
  assert.ok(r.trolledM >= 0.85 * r.budgetMin * M_PER_MIN - 2 * r.coveM, `trolled ${r.trolledM} m`);
});

test('2. there is no floor: the loop rides its line, and water off it only costs more', () => {
  const r = trollLoop(BASE);
  // Most of the way the water under the line is inside his steering band of it (20-30 ft here).
  let inBand = 0, all = 0;
  for (const p of r.petals) for (const half of [p.out, p.back]) {
    for (const pt of densify(half, 40)) { all++; const ft = depthAtY(yAt(pt)); if (ft >= 20 - 1 && ft <= 30 + 1) inBand++; }
  }
  assert.ok(inBand / all >= 0.8, `${inBand} of ${all} stations inside 20-30 ft`);
  // And nothing in the module closes water shallower than a floor: only land, the shore, keep-out
  // zones and water with none in it today.
  const src = read('js/modules/plan-troll-loop.js');
  assert.doesNotMatch(src, /if \(!\(dd >= floor\)\) \{ cost\[c\] = Infinity; continue; \}/);
  assert.match(src, /if \(!\(dd > 0\)\) \{ flat\[c\] = Infinity; continue; \}/);
  assert.equal(r.floorFt, undefined);
  assert.equal(r.lineFt, 25);
});

test('3. the line rides the 25 ft contour and comes home on the other edge', () => {
  const r = trollLoop(BASE);
  const p = r.petals[0];
  // Along the line, every 40 m -- not the straightened line's few corners.
  const medY = (c) => { const ys = densify(c, 40).map(yAt).sort((a, b) => a - b); return ys[Math.floor(ys.length / 2)]; };
  const north = (y) => y > W / 2;
  // One half on each side of the channel, each near its own 25 ft line.
  assert.notEqual(north(medY(p.out)), north(medY(p.back)));
  for (const half of [p.out, p.back]) {
    const ft = depthAtY(medY(half));
    assert.ok(ft >= 20 && ft <= 32, `median water ${ft.toFixed(1)} ft`);
  }
  // Away from the two ends, home is never within the app's "same water" of the way out.
  const mid = p.back.filter((pt) => metresBetween(pt, r.start) > 500 && metresBetween(pt, p.out[p.out.length - 1]) > 500);
  for (const pt of mid) {
    const dmin = Math.min(...p.out.map((q) => metresBetween(pt, q)));
    assert.ok(dmin > SAME_WATER_M - 40, `back within ${dmin.toFixed(0)} m of out`);
  }
});

test('4. his catches decide which way the loop goes when the water does not', () => {
  // The same water both ways from the ramp; his fish one way or the other.
  const east = [at(11000, yOf(25)), at(11800, W - yOf(25)), at(12200, yOf(25))].map((a) => ({ at: a }));
  const west = [at(4000, yOf(25))].map((a) => ({ at: a }));
  const rE = trollLoop({ ...BASE, catches: east });
  const rW = trollLoop({ ...BASE, catches: west });
  const turnX = (r) => xOf(r.petals[0].out[r.petals[0].out.length - 1]);
  assert.ok(rE.score.fish >= 2, `east passes ${rE.score.fish}`);
  assert.ok(turnX(rE) > 8000, 'east catches send it east');
  assert.ok(rW.score.fish >= 1 && turnX(rW) < 8000, 'a west catch sends it west');
});

test('5. a place he ticked is where the loop turns', () => {
  const via = at(11000, yOf(25));
  const r = trollLoop({ ...BASE, via: [via] });
  const turn = r.petals[0].out[r.petals[0].out.length - 1];
  assert.ok(metresBetween(turn, via) < 150, `turned ${metresBetween(turn, via).toFixed(0)} m from it`);
});

test('6. two legs a loop, as pieces with nothing to run between them; no transit at a shared end', () => {
  const r = trollLoop({ ...BASE, maxPetals: 2, windowMin: 300 });
  assert.equal(r.petals.length, 2);
  assert.equal(r.legs.length, 4);
  const depthAt = (pt) => { const v = grid.at(pt); return Number.isFinite(v) ? v : null; };
  const pieces = loopPieces(r, { depthAt, slug: 'test_lake', rampName: 'Ramp',
                                 spots: [{ at: at(9000, yOf(25)), type: 'hump', depthFt: 22 }] });
  assert.deepEqual(pieces.map((p) => p.key), r.legs.map((_, i) => `L${i + 1}`));
  for (const p of pieces) {
    assert.ok(p.water.line.sustainedMinFt >= 20 - 1, `leg ${p.key} line ${p.water.line.sustainedMinFt}`);
    assert.equal(p.envelope.length, p.envelopeLine.length);
  }
  const steps = loopSteps(r, pieces);
  assert.equal(steps[0].kind, 'run');
  const hops = steps.filter((s, i) => i > 0 && s.kind !== 'piece');
  assert.ok(hops.every((s) => s.kind === 'troll' && s.m === 0), hops.map((s) => s.m).join(','));
  assert.equal(marksAlong(r.legs.flatMap((l) => l.coords), [{ at: at(9000, yOf(25)) }], 200).length, 1);
  const asm = read('js/modules/plan-assemble.js');
  assert.match(asm, /metresBetween\(cursor, legStart\) <= 1 \? straight\(cursor, legStart\)/);
  assert.match(read('js/modules/smart-plan-v2.js'), /metresBetween\(cursor, f\.start\) > 1\) pairs\.push/);
});

test('7. Troll it for me lays the loop without freezing the page; Plan it as one troll waits for it', async () => {
  const r = await trollLoopAsync(BASE);
  assert.ok(r.petals.length >= 1);
  const ui = read('js/modules/plan-water-ui.js');
  // since 10/4 it also takes the turns he clicks on the main map (loop-on-map.js)
  assert.match(ui, /export async function trollForMe\(opts = \{\}\)/);
  assert.match(ui, /loop = await trollLoopAsync\(/);
  assert.match(ui, /T\.trollSteps = loopSteps\(loop, pieces\);/);
  assert.match(ui, /await trollForMe\(\);/);
  assert.doesNotMatch(ui, /day = trollDay\(/);
});

test('8. a loop that comes home over its own water does not fill the day, whatever it passes', () => {
  // West of the ramp, a creek 100 m wide and all 25 ft: one line fits, so a loop up it comes home
  // on the way out. East, the channel, where out and back are two edges. His fish are all up the creek.
  const DA2 = DA.map((f) => ({ ...f, geometry: { ...f.geometry,
    coordinates: [f.geometry.coordinates[0].map(([x, y]) => [Math.max(x, -80 + 8000 / KX), y])] } }));
  DA2.push(rect(0, W / 2 - 50, 8000, W / 2 + 50, 25));
  const creek = [2000, 3500, 5000, 6500].map((x) => ({ at: at(x, W / 2) }));
  const r = trollLoop({ ...BASE, daFeatures: DA2, catches: creek });
  assert.ok(!r.error, r.error);
  const p = r.petals[0];
  assert.ok(xOf(p.out[p.out.length - 1]) > 8000, `turned at x ${xOf(p.out[p.out.length - 1]).toFixed(0)} -- up the creek`);
  assert.ok(r.sharedM < 0.1 * r.trolledM, `${r.sharedM} m of ${r.trolledM} m trolled twice`);
  // What it measures: a way home laid on the way out is all shared but its two ends.
  const line = [at(8000, 300), at(4000, 300)];
  const m = sharedWaterM(line, [...line].reverse());
  assert.ok(m > 4000 - 4 * SAME_WATER_M - 50 && m < 4000, `${m.toFixed(0)} m`);
  assert.equal(sharedWaterM(line, [at(4000, 300), at(4000, 0), at(8000, 0), at(8000, 300)]), 0);
  // And water a loop earlier in the day trolled, away from the cove mouth they all leave by.
  const earlier = [at(8000, 300), at(6000, 300), at(6000, 500), at(8000, 300)];
  const again = sharedWaterM(line, [at(4000, 300), at(4000, 0), at(8000, 0), at(8000, 300)], SAME_WATER_M, [earlier]);
  assert.ok(again > 2000 - 2 * SAME_WATER_M - 50 && again < 2000 + 50, `${again.toFixed(0)} m`);
});

test('9. the lines go in where a loop fits, not in a hole nearer the ramp', () => {
  // A 45 ft hole 75 m across right off the ramp, cut off from the channel by 15 ft water.
  const ramp = at(8000, W - 10);
  const hole = rect(7960, W - 120, 8040, W - 45, 45);
  const DA3 = [...DA.map((f) => ({ ...f, geometry: { ...f.geometry,
    coordinates: [f.geometry.coordinates[0].map(([x, y]) => [x, Math.min(y, LAT0 + (W - 150) / KY)])] } })),
    // 15 ft all round it (the shallowest band covering a cell is its depth, so not over it).
    rect(0, W - 150, 7960, W, 15), rect(8040, W - 150, L, W, 15),
    rect(7960, W - 150, 8040, W - 120, 15), rect(7960, W - 45, 8040, W, 15), hole];
  const r = trollLoop({ ...BASE, ramp, daFeatures: DA3 });
  assert.ok(!r.error, r.error);
  assert.ok(yAt(r.start) < W - 150, `started at y ${yAt(r.start).toFixed(0)} -- in the hole`);
  assert.ok(r.trolledM > 0.85 * r.budgetMin * M_PER_MIN - 2 * r.coveM - 1000, `trolled ${r.trolledM} m`);
});

test('10. the line is the depth with the most of his catches inside his band, then the research\'s water, then the band', () => {
  // Moultrie's 17 stripers of 10/3 over 19-58 ft of charted water. 19-24 ft holds 7 of them inside
  // 5 ft of 19, and 19 is the depth the most were caught over (3). The middle, 30, held 6 inside its band.
  const moultrie = [19, 19, 19, 21, 22, 23, 24, 30, 30, 31, 38, 40, 41, 47, 57, 57, 58];
  const catches = moultrie.map((ft, i) => ({ at: [i, 0], ft }));
  const depthAt = ([i]) => (moultrie[i] ?? null);
  const fromCatches = loopLine({ catches, depthAt, offsetFt: 0, waterFt: [30, 45], band: [40, 50] });
  assert.deepEqual(fromCatches, { lineFt: 19, from: 'catches', n: 17, inBand: 7, rangeFt: [19, 58] });
  // His Wyboo Creek stripers within reach of Rowland Subdivision, 10/4: 28 ft, four of five inside 23-33.
  assert.deepEqual(lineFromDepths([12, 28, 28, 28, 30]), { lineFt: 28, from: 'catches', n: 5, inBand: 4, rangeFt: [12, 30] });
  // In today's water: the lake 2 ft below its chart takes 2 ft off every catch.
  assert.equal(loopLine({ catches, depthAt, offsetFt: 2 }).lineFt, 17);
  // A catch on another lake reads no depth on this one and does not count.
  const elsewhere = [...catches, { at: [99, 0] }];
  assert.equal(loopLine({ catches: elsewhere, depthAt }).n, 17);
  // No catches here: the water the research names, then the band. No floor on any of them.
  assert.deepEqual(loopLine({ catches: [{ at: [99, 0] }], depthAt, waterFt: [19, 22], band: [10, 20] }),
    { lineFt: 21, from: 'research', rangeFt: [19, 22] });
  assert.deepEqual(loopLine({ band: [40, 50] }), { lineFt: 55, from: 'band', rangeFt: [40, 50] });
  assert.equal(loopLine({ band: [40, 50], holding: 'bottom' }).lineFt, 45);
  assert.equal(loopLine({}), null);
  // Troll it for me hands the loop his catches with the chart under each and the research's or the
  // band's line for when none within reach says one; the loop decides from the ones within reach.
  const ui = read('js/modules/plan-water-ui.js');
  assert.match(ui, /const fallback = loopLine\(\{ waterFt: guide, band, holding: T\.holding, steerFt: steer \}\);/);
  assert.match(ui, /return \{ at, date: c\.date \|\| null, chartFt:/);
  assert.doesNotMatch(ui, /const \{ lineFt, floorFt \} = line;/);
  assert.doesNotMatch(ui, /never over water under/);
});

test('11. a leg is named for its loop and its half', () => {
  const r = trollLoop({ ...BASE, maxPetals: 2, windowMin: 300 });
  const depthAt = (pt) => { const v = grid.at(pt); return Number.isFinite(v) ? v : null; };
  const pieces = loopPieces(r, { depthAt, slug: 'test_lake' });
  assert.deepEqual(pieces.map((p) => p.runId),
    ['test_lake#loop1-out', 'test_lake#loop1-back', 'test_lake#loop2-out', 'test_lake#loop2-back']);
});

test('12. a loop added to the day is mostly new water, or the day stops before it', () => {
  // Every loop after the first trolls more new water than old, whatever the water allows.
  for (const windowMin of [180, 300, 420]) {
    const r = trollLoop({ ...BASE, maxPetals: 4, windowMin });
    for (const p of r.petals.slice(1)) assert.ok(p.sharedM <= p.m - p.sharedM, `${p.sharedM} of ${p.m} m trolled twice`);
  }
  // The rule, where the loops are assembled: a loop laid for a turn he asked for is kept (a turn no
  // loop could reach is laid like any other loop since 10/4, and that one is held to the rule).
  assert.match(read('js/modules/plan-troll-loop.js'), /if \(petals\.length && !asked && pt\.sharedM > pt\.newM\) break;/);
});
