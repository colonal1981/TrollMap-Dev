// Personal use only, not for distribution or resale; not for navigation.
//
// THE DAY IS SPENT IN THE AREAS THE REPORTS NAME, NOT TURNED AT THEM; A RUN IS TROLLED AT 3 MPH WITH TWO DEEP DIVERS;
// AND SPEED SETS HOW DEEP A SINKING BAIT RUNS.
//
// Ryan, 2026-11-06, on the loops laid through the report places from Short Stay on Moultrie: "we shouldn't let the
// route length dictate trolling speed... faster you go the shallower the sinking lures run... why is that loop is so
// long does it need to be that long... do all 3 loops need to be ran"; "just because a place is mentioned in a report
// why would there be a turn there?"; of the dam and the Bonneau flats, "those are 2 different areas to concentrate
// in"; of the run, "lets do it at about 3 mph and during that time put 2 deep diving crankbaits that match the fishing
// depth and allowable depth for that run"; and of the crankbaits, "anything 3.5 and higher is where i have seen the
// most issues". Shown a sample of the day laid that way: "yeah that works... i think...".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { layAreas, optionLoop, optionLines, runDivers, runCrankbaits, RUN_MPH, AREA_R_M, MIN_MOVE_M } from '../js/modules/plan-areas.js';
import { loopSteps } from '../js/modules/plan-troll-loop.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';
import { LURE_KNOWLEDGE, CRANK_MAX_MPH, depthWindow, leadForDepth } from '../js/data/lure-knowledge.js';
import { planArgsFrom, areaDayBlock } from '../js/modules/plan-prompt.js';
import { dayCost } from '../js/modules/plan-water.js';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const CRANKS = runCrankbaits(TACKLE_INVENTORY);

test('his deep divers top out under 3.5 mph, and a run picks two of them', () => {
  for (const [t, k] of Object.entries(LURE_KNOWLEDGE)) if (/^crankbait_/.test(t)) assert.equal(k.speed.max, CRANK_MAX_MPH, t);
  assert.ok(CRANK_MAX_MPH < 3.5 && CRANK_MAX_MPH >= RUN_MPH);
  assert.equal(RUN_MPH, 3);
  assert.ok(CRANKS.some((c) => c.type === 'crankbait_dd3') && CRANKS.some((c) => c.type === 'crankbait_dd2'));
});

// A run out of a cove: 600 m under 20 ft, then 34 ft or more the rest of the way, as from Short Stay to Bonneau.
const station = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const RUN = station(150, (i) => (i < 15 ? 8 + i : 34 + (i % 7)));
const CUM = station(150, (i) => i * 40);

test('the two divers clear the run and sit near the fish; the lines go in where the water holds for them', () => {
  const r = runDivers(RUN, CUM, CRANKS, { fishFt: [20, 23] });
  assert.deepEqual(r.rods.map((x) => x.type).sort(), ['crankbait_dd2', 'crankbait_dd3']);
  assert.ok(r.floorFt >= 34 && r.needFt === 30, `floor ${r.floorFt}, need ${r.needFt}`);
  assert.ok(r.linesInM >= 560 && r.linesInM <= 640, `lines in at ${r.linesInM} m`);
  // fish shallower: the pair that covers them
  const s = runDivers(RUN, CUM, CRANKS, { fishFt: [14, 17] });
  assert.ok(s.rods.some((x) => x.type === 'crankbait_dd1'), s.rods.map((x) => x.type).join());
  // a run over 22 ft water: nothing rated past 17 ft goes out
  const low = runDivers(station(150, (i) => (i < 5 ? 6 : 22)), CUM, CRANKS, { fishFt: [20, 23] });
  assert.ok(low.rods.length && low.rods.every((x) => x.max <= 17), low.rods.map((x) => x.name).join());
  // never water for a deep diver past the cove: lines up, and why
  const none = runDivers(station(150, () => 7), CUM, CRANKS, {});
  assert.equal(none.rods.length, 0);
  assert.match(none.why, /never holds water deep enough|under/);
});

// A lake on a grid: a rectangle 1.9 km by 6.7 km, deepening to a 45 ft core, the ramp on the south shore.
// Each band a ring round the next deeper one, the way a pack's depth areas are cut.
const ring = ([w, s, e, n]) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const band = (outer, inner, ft) => ({ type: 'Feature', properties: { depth_max_ft: ft },
  geometry: { type: 'Polygon', coordinates: inner ? [ring(outer), ring(inner).reverse()] : [ring(outer)] } });
const B10 = [-80.0, 33.2, -79.98, 33.26], B20 = [-79.998, 33.2015, -79.982, 33.2585];
const B35 = [-79.996, 33.203, -79.984, 33.257], B45 = [-79.993, 33.206, -79.987, 33.254];
const LAKE = [band(B10, B20, 10), band(B20, B35, 20), band(B35, B45, 35), band(B45, null, 45)];
const RAMP = [-79.99, 33.2004];
const PLACES = [{ at: [-79.99, 33.25], name: 'Far Flats', n: 5, why: 'x' }, { at: [-79.99, 33.208], name: 'Near Point', n: 3, why: 'y' }];
const DAY = layAreas({ ramp: RAMP, daFeatures: LAKE, places: PLACES, waterFt: [30, 43], fishFt: [20, 23], windowMin: 540,
                       stopMin: 0, cranks: CRANKS, launchTime: '06:00' });

test('each place is an area, measured by water from the ramp; the near one has no run', () => {
  assert.ok(!DAY.error, DAY.error);
  assert.equal(DAY.radiusM, AREA_R_M);
  assert.deepEqual(DAY.lines, [37, 42]);
  const far = DAY.areas.find((a) => a.name === 'Far Flats'), near = DAY.areas.find((a) => a.name === 'Near Point');
  assert.ok(far && near);
  assert.ok(near.near, 'the near point is lines in by the ramp');
  assert.ok(!far.near && far.run.trolledM > 2000, `far run ${far.run.trolledM} m`);
  assert.deepEqual(far.run.rods.map((r) => r.type).sort(), ['crankbait_dd2', 'crankbait_dd3']);
  assert.ok(far.acres > 0 && near.acres > 0);
  for (const a of DAY.areas) {
    assert.ok(a.laps.length >= 1);
    for (const l of a.laps) assert.ok(l.minutes > 10 && l.minutes <= 90, `${a.name} loop ${l.lineFt}: ${l.minutes} min`);
  }
});

// "i think for trolling by the dam we could find some more loops instead of just repeating the same exact ones", and
// "lets try the bigger area so that i am not doing 10 laps right in front of the dam... i might go crazy" (11/6).
test('an area is 1.5 miles round the place, and its day is different loops before any is gone round again', () => {
  assert.equal(AREA_R_M, 2414);
  const far = DAY.areas.find((a) => a.name === 'Far Flats');
  assert.ok(far.laps.length >= 3, `${far.laps.length} loops`);
  // no two loops the same water
  const keyOf = (l) => `${l.lineFt}|${l.start.map((v) => v.toFixed(4))}|${l.legs[0].coords[l.legs[0].coords.length - 1].map((v) => v.toFixed(4))}`;
  assert.equal(new Set(far.laps.map(keyOf)).size, far.laps.length);
  const op = DAY.options.find((o) => o.label === 'Far Flats all day');
  const step = op.steps.find((x) => x.kind === 'area');
  const seen = new Set();
  let repeated = false;
  for (const l of step.lapList) {
    if (seen.has(l)) repeated = true;
    else assert.ok(!repeated, 'a new loop after one was gone round again');
    seen.add(l);
  }
  assert.equal(step.distinct, seen.size);
  assert.ok(step.distinct >= Math.min(3, far.laps.length));
  // and the moves between loops are said: at 3 mph with the area's two divers
  assert.match(optionLines(DAY, op).join('\n'), /on them, \d.* moving between them at 3 mph with DD3 Crankbait \(20-25ft\) and DD2/);
});

test('the options: each area all day and both, every minute of the window accounted for, no filler loop', () => {
  const labels = DAY.options.map((o) => o.label);
  assert.ok(labels.includes('Far Flats all day') && labels.includes('Near Point all day'));
  assert.ok(labels.some((l) => /, then /.test(l)), labels.join(' | '));
  for (const op of DAY.options) {
    const up = op.steps.filter((s) => s.kind === 'up').reduce((a, s) => a + s.min, 0);
    const total = op.fishingMin + op.runningMin + op.leftMin + up;
    assert.ok(Math.abs(total - 540) <= 4, `${op.label}: ${total} of 540`);
    for (const s of op.steps.filter((x) => x.kind === 'area')) {
      const area = DAY.areas.find((a) => a.key === s.area);
      assert.ok(s.leftMin < Math.max(...area.laps.map((l) => l.minutes)), 'less than a lap is left over');
    }
  }
  const both = DAY.options.find((o) => /, then /.test(o.label));
  assert.match(both.label, /^Near Point, then Far Flats$/, 'the nearer first');
  const lines = optionLines(DAY, both);
  assert.match(lines[0], /^06:00 lines up out of the cove/);
  assert.ok(lines.some((l) => / run to Far Flats at 3 mph, .* trolling DD/.test(l)), lines.join('\n'));
  assert.match(lines[lines.length - 1], /at the ramp$/);
});

test('an option is laid as the loop the app builds from: run out, laps, run home; a run carries its speed and baits', () => {
  const i = DAY.options.findIndex((o) => o.label === 'Far Flats all day');
  const loop = optionLoop(DAY, i);
  assert.equal(loop.mode, 'areas');
  assert.equal(loop.legs[0].name, 'run-out');
  assert.equal(loop.legs[loop.legs.length - 1].name, 'run-home');
  assert.ok(loop.legs.slice(1, -1).every((l) => /^area1-(lap\d+-(out|back)|move\d+)$/.test(l.name)), loop.legs.map((l) => l.name).join());
  const moves = loop.legs.filter((l) => /-move\d+$/.test(l.name));
  assert.ok(moves.length >= 1, 'a move between loops is a leg of its own');
  for (const l of [loop.legs[0], loop.legs[loop.legs.length - 1], ...moves]) {
    assert.equal(l.run.mph, 3);
    assert.equal(l.run.rods.length, 2);
  }
  for (const l of moves) {
    assert.ok(l.lengthM >= MIN_MOVE_M && l.run.floorFt >= l.run.needFt, `${l.name}: ${l.lengthM} m over ${l.run.floorFt} ft`);
    assert.equal(l.half, 'run');
  }
  // the laps go round the two lines in turn
  const lines = loop.legs.filter((l) => l.half === 'out').map((l) => l.lineFt);
  assert.ok(new Set(lines).size === 2, lines.join());
});

// "as long as the app has me travelling at 3mph with double crankbaits in the water then the transit time is still
// fishing time"; and of a cue on the water to pull them: "adding more things to the fish finder map is not going to help
// me" (11/6). Two deep pockets with a 10 ft bar across the whole lake between them.
const poly = (outer, holes, ft) => ({ type: 'Feature', properties: { depth_max_ft: ft },
  geometry: { type: 'Polygon', coordinates: [ring(outer), ...holes.map((h) => ring(h).reverse())] } });
const BAR = (() => {
  const OUT = [-80.0, 33.2, -79.98, 33.242];
  const S20 = [-79.998, 33.2015, -79.982, 33.2185], N20 = [-79.998, 33.2215, -79.982, 33.2405];
  const S35 = [-79.996, 33.203, -79.984, 33.217], N35 = [-79.996, 33.223, -79.984, 33.239];
  const S45 = [-79.993, 33.206, -79.987, 33.214], N45 = [-79.993, 33.226, -79.987, 33.236];
  return [poly(OUT, [S20, N20], 10), poly(S20, [S35], 20), poly(N20, [N35], 20), poly(S35, [S45], 35), poly(N35, [N45], 35),
          poly(S45, [], 45), poly(N45, [], 45)];
})();
const BAR_DAY = layAreas({ ramp: RAMP, daFeatures: BAR, places: [{ at: [-79.99, 33.22], name: 'The Bar', n: 5, why: 'x' }],
                           waterFt: [30, 43], fishFt: [20, 23], windowMin: 540, stopMin: 0, cranks: CRANKS, launchTime: '06:00' });

test('a move between loops goes with the divers only over water they clear; over the bar it is lines up, said on the plan', () => {
  assert.ok(!BAR_DAY.error, BAR_DAY.error);
  const op = BAR_DAY.options[0];
  const step = op.steps.find((x) => x.kind === 'area');
  const kinds = step.moveList.map((m) => m.kind);
  assert.ok(kinds.includes('divers') && kinds.includes('up'), kinds.join());
  for (const m of step.moveList) {
    if (m.kind === 'divers') assert.ok(m.floorFt >= m.needFt && Math.abs(m.minutes - m.m / (3 * 1609.344 / 60)) < 1, `${m.m} m over ${m.floorFt}`);
    if (m.kind === 'up') assert.ok(m.floorFt < 30 && m.m >= MIN_MOVE_M, `${m.m} m over ${m.floorFt}`);
    if (m.kind === 'join') assert.ok(m.m < MIN_MOVE_M);
  }
  // every minute: the loops, the moves, what is his
  const onLoops = step.lapList.reduce((a, l) => a + l.minutes, 0);
  const moving = step.moveList.reduce((a, m) => a + m.minutes, 0);
  assert.ok(Math.abs(onLoops + moving - step.min) <= 2, `${onLoops} + ${moving} vs ${step.min}`);
  const said = optionLines(BAR_DAY, op).join('\n');
  assert.match(said, /moving between them at 3 mph with DD3 Crankbait \(20-25ft\) and DD2 Crankbait \(16-20ft\)/);
  assert.match(said, /moving with the lines up where the water between is too shallow for them/);
  // the loop after a lines-up move says so, and the join to it is run with the lines up -- nothing on the water
  const loop = optionLoop(BAR_DAY, 0);
  const pieces = loop.legs.map((l, k) => ({ key: `L${k + 1}`, coords: l.coords, lengthM: l.lengthM, holdsFt: 35,
                                             ...(l.upBefore ? { upBefore: true } : {}) }));
  const ups = pieces.filter((p) => p.upBefore);
  assert.equal(ups.length, kinds.filter((k) => k === 'up').length);
  const steps = loopSteps(loop, pieces, {});
  for (const p of ups) {
    const i = steps.findIndex((x) => x.kind === 'piece' && x.key === p.key);
    assert.equal(steps[i - 1].kind, 'run', `the move to ${p.key} is lines up`);
  }
  // and no move leg crosses the bar
  for (const l of loop.legs.filter((x) => /-move\d+$/.test(x.name))) {
    assert.ok(l.coords.every((c) => c[1] < 33.2185 || c[1] > 33.2215), `${l.name} stays off the bar`);
  }
});

test('the price of a day counts a run at its own 3 mph', () => {
  const c = [[-79.99, 33.21], [-79.99, 33.24]];
  const lengthM = 3336;
  const at2 = dayCost([{ coords: c, lengthM }], { ramp: RAMP, usableAh: 80, windowMin: 540 });
  const at3 = dayCost([{ coords: c, lengthM, run: { mph: 3 } }], { ramp: RAMP, usableAh: 80, windowMin: 540 });
  assert.ok(at3.min < at2.min - 15, `${at3.min} vs ${at2.min}`);
});

test('the plan holds a run at its speed and puts its two divers out, whatever the model sent', () => {
  const run = { mph: 3, rods: ['DD3 Crankbait (20-25ft)', 'DD2 Crankbait (16-20ft)'], floorFt: 34 };
  const cands = [{ runId: 'w#run-out', run }, { runId: 'w#area1-lap1-out' }];
  const res = {
    loadout: { rods: [{ id: 'R1', lure: 'DD3 Crankbait (20-25ft)' }, { id: 'R2', lure: 'DD2 Crankbait (16-20ft)' },
                      { id: 'R5', lure: 'A-Rig – five 1/2oz heads (~4.1oz)' }, { id: 'R3', lure: 'SPRO Prime Bucktail Jig 1oz (SBTJ-1)' }] },
    legs: [{ runId: 'w#run-out', speedMph: 2.2, deploy: { port: 'R5', starboard: 'R3' } },
           { runId: 'w#area1-lap1-out', speedMph: 2.0, deploy: { port: 'R5', starboard: 'R3' } }],
  };
  const a = planArgsFrom(res, cands, { tackle: TACKLE_INVENTORY.map((l) => l.name) });
  const runLeg = a.candidates.find((c) => c.runId === 'w#run-out');
  assert.equal(runLeg.speedMph, 3);
  const dep = a.deploy['w#run-out'];
  const lures = [dep.port, dep.starboard].map((id) => a.loadout.rods.find((r) => r.id === id).lure).sort();
  assert.deepEqual(lures, ['DD2 Crankbait (16-20ft)', 'DD3 Crankbait (20-25ft)']);
  assert.equal(a.candidates.find((c) => c.runId === 'w#area1-lap1-out').speedMph, 2.0);
});

test('the model is told what a run and a lap are, and never to change the speed to fit the day', () => {
  assert.equal(areaDayBlock([{ runId: 'x' }]), '');
  const b = areaDayBlock([{ runId: 'w#run-out', theRun: { mph: 3, baits: ['DD3 Crankbait (20-25ft)', 'DD2 Crankbait (16-20ft)'] } }]);
  assert.match(b, /A LEG CARRYING `theRun` IS A RUN: the run out, across or home, or a move from one loop to the next/);
  assert.match(b, /`areaN-moveK`/);
  assert.match(b, /has no leg: it is run with the lines up from its start, and the plan says so/);
  assert.match(b, /NEVER RAISE IT TO FIT THE DISTANCE INTO THE TIME/);
  const pp = read('../js/modules/plan-prompt.js');
  assert.match(pp, /\$\{areaDayBlock\(candidates\)\}/);
  assert.match(pp, /AND NEVER BY TROLLING FASTER OR SLOWER THAN THE BAITS WANT/);
  const pf = read('../js/modules/plan-from-water.js');
  assert.match(pf, /run: piece\.run \|\| undefined,/);
  assert.match(pf, /theRun: l\.run \? \{ mph: l\.run\.mph, baits: l\.run\.rods/);
});

test('the one troll is laid in the areas where the reports name them, and the map lets him pick the day', () => {
  const ui = read('../js/modules/plan-water-ui.js');
  assert.match(ui, /T\.reportAreas = areasFromReports\(tw, T\.species, \{ ramp: T\.ramp, reachM: runReachM \}\);/);
  assert.match(ui, /day = layAreas\(\{/);
  assert.match(ui, /export function layAreaOption\(i\)/);
  const lom = read('../js/modules/loop-on-map.js');
  // a pick is not a click on the water: stopped at the bar, and laid once the click is done (live check, 11/6)
  assert.match(lom, /else if \(what === 'area-opt'\) \{\s+[\s\S]{0,400}e\.stopPropagation\(\);\s+const i = Number\(a\.dataset\.i\);\s+setTimeout\(\(\) => pickArea\(i\), 0\);/);
  assert.match(lom, /if \(loop\.mode === 'areas'\) drawAreas\(loop, g, pts\);/);
  assert.match(lom, /'Build this day<\/button><\/div>'/);
});

// "faster you go the shallower the sinking lures run": between 1.6 and 2.2 mph the old steps said speed changed nothing.
test('speed sets a sinking bait\'s depth at every speed, and his one measured A-rig point still holds', () => {
  const arig = { type: 'umbrella_rig', weightOz: 1.6 + 5 * 0.375 };
  const at = (s) => depthWindow(arig, { speedMph: s, leadFt: 100 }).max - 2;
  assert.equal(at(1.4), 28, 'the 11/2 snag: 28 ft on 100 ft at 1.4 mph');
  const d = [1.6, 1.8, 2.0, 2.2, 2.5].map(at);
  for (let k = 1; k < d.length; k++) assert.ok(d[k] < d[k - 1], `faster is shallower: ${d.join(', ')}`);
  const buck = { type: 'bucktail', weightOz: 1 };
  assert.ok(leadForDepth(buck, 20, 2.2) > leadForDepth(buck, 20, 2.0) && leadForDepth(buck, 20, 2.0) > leadForDepth(buck, 20, 1.8));
  // a crankbait's bill sets its depth: speed changes nothing under its ceiling
  assert.deepEqual(depthWindow({ type: 'crankbait_dd3' }, { speedMph: 3 }).max, 25);
});

// THE SEAM: an area day built end to end through planFromWater() with the model stubbed, so a run leg reaches the plan
// at 3 mph with its two divers out, and the laps after it at the speed the model set.
test('an area day builds: the run at 3 mph with its divers, the laps at the model\'s speed', async () => {
  const { planFromWater } = await import('../js/modules/plan-from-water.js');
  const { loopPieces, loopSteps } = await import('../js/modules/plan-troll-loop.js');
  const { connectionFor } = await import('../js/data/lure-knowledge.js');
  const i = DAY.options.findIndex((o) => o.label === 'Far Flats all day');
  const loop = optionLoop(DAY, i);
  const depthAt = (pt) => {
    const [x, y] = pt;
    const inn = (b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
    return inn(B45) ? 45 : inn(B35) ? 35 : inn(B20) ? 20 : inn(B10) ? 10 : null;
  };
  const pieces = loopPieces(loop, { depthAt, spots: [], slug: 'test_lake', rampName: 'Ramp' });
  pieces.forEach((p, k) => { const leg = loop.legs[k]; p.runId = `test_lake#${leg.name}`; if (leg.run) p.run = leg.run; });
  const steps = loopSteps(loop, pieces);
  const RUN_BAITS = ['DD3 Crankbait (20-25ft)', 'DD2 Crankbait (16-20ft)'];
  const ARIG = 'A-Rig – five 1/2oz heads (~4.1oz)', BUCK = 'SPRO Prime Bucktail Jig 1oz (SBTJ-1)';
  let prompt = '';
  const askModel = async ({ user }) => {
    prompt = user;
    return JSON.stringify({
      loadout: { rods: [{ id: 'R1', lure: RUN_BAITS[0], leadFt: 60 }, { id: 'R2', lure: RUN_BAITS[1], leadFt: 60 },
                        { id: 'R5', lure: ARIG, leadFt: 105 }, { id: 'R6', lure: BUCK, leadFt: 80 }] },
      legs: pieces.map((p) => ({ runId: p.runId, speedMph: 2.0, deploy: { port: 'R5', starboard: 'R6' }, why: 'w' })),
      stops: [], changes: [],
    });
  };
  const r = await planFromWater({
    picked: pieces, order: pieces.map((_, k) => k), troll: steps, spots: [], ramp: RAMP, slug: 'test_lake', usableAh: 80,
    windowMin: 540, launchTime: '06:00', returnTime: '15:00', askModel,
    tackle: TACKLE_INVENTORY.filter((l) => l.trollable).map((l) => l.name),
    connectionOf: (n) => { const hit = TACKLE_INVENTORY.find((l) => l.name === n); return hit ? connectionFor(hit.type) : null; },
    planArgs: { water: 'Test Lake', ramp: 'Ramp', date: '2026-11-08', species: ['Striped Bass'], usableAh: 80,
                tackle: TACKLE_INVENTORY.map((l) => l.name), conditions: {} },
  });
  assert.ok(r.plan, (r.problems || []).join('; '));
  assert.match(prompt, /THE DAY IS SPENT IN AN AREA THE FISHING REPORTS NAME/);
  assert.match(prompt, /"theRun":\{"mph":3,"baits":\["DD3 Crankbait \(20-25ft\)","DD2 Crankbait \(16-20ft\)"\]/);
  const legs = (r.plan.route || r.plan.legs || []).filter((l) => l && l.runId);
  const runOut = legs.find((l) => /#run-out$/.test(l.runId));
  const lap = legs.find((l) => /lap1-out$/.test(l.runId));
  assert.ok(runOut && lap, legs.map((l) => l.runId).join(', '));
  assert.equal(runOut.speedMph, 3);
  assert.equal(lap.speedMph, 2);
  // the two divers are the pair on the run, the model's pair on the lap
  assert.deepEqual(runOut.deploy, { port: 'R1', starboard: 'R2' });
  assert.deepEqual(lap.deploy, { port: 'R5', starboard: 'R6' });
});

// THE WATER UNDER A JOIN IS THE JOIN'S. His 11/8 dam day (rerun, 11/6): every back leg was given the next piece's
// shallowest wander water, 20-24 ft, as its floor through a 122 m join, over 50+ ft of water; the A-rig was lifted to
// 15-19 ft and the DD3 taken off for 1.5 km.
test('a join between pieces is measured on its own water, and one over shallow water is run with the lines up', async () => {
  const { loopSteps } = await import('../js/modules/plan-troll-loop.js');
  const piece = (key, coords, holdsFt, sustainedMinFt) => ({ key, runId: key, coords, lengthM: 1500, holdsFt,
    water: { line: { sustainedMinFt } } });
  const a = piece('L1', [[-80, 33.2], [-80, 33.21]], 22, 45);
  const b = piece('L2', [[-80.002, 33.21], [-80.002, 33.2]], 20, 50);
  const loop = { ramp: [-80, 33.199] };
  const deep = loopSteps(loop, [a, b], { depthAt: () => 48 });
  const join = deep.find((st, i) => i > 0 && st.kind !== 'piece');
  assert.equal(join.kind, 'troll');
  assert.equal(join.shallowestFt, 48, 'its own water, not the next piece\'s 20');
  const shoal = loopSteps(loop, [a, b], { depthAt: (p) => (p[0] < -80.001 && p[0] > -80.0015 ? 18 : 48) });
  assert.equal(shoal.find((st, i) => i > 0 && st.kind !== 'piece').kind, 'run', 'lines up over the shoal');
  // without the chart, as before
  assert.equal(loopSteps(loop, [a, b]).find((st, i) => i > 0 && st.kind !== 'piece').shallowestFt, 20);
});
