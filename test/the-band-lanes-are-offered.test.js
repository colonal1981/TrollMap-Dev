// The lanes over the fish band that the ranking left out are offered, past the limit.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-01, testing a Marion striper plan from Rowland: "so how do we get the lanes
// fixed". The ranking scores what a lane passes, so for a fish suspended over open water the list
// filled with the bank: 2 of 12 lanes over the 20-30 ft band, with 7 inside the same reach. Asked
// how the deeper lanes should get on the list, he chose "Add the band's lanes". What these hold:
//   1. a lane over the band that the ranking left out is added and says so, and one farther from
//      the ramp than the ranking went is not;
//   2. lanes are added only until the band's lanes on offer hold the day's window in trolling, and
//      only until the list holds as many lanes over the band as outside it (that bound is Claude's,
//      added after Marion largemouth at 5-8 ft took 25);
//   3. nothing is added when no lane is outside the band, or when there is no band;
//   4. a lane added for the band carries the guide's water, and the report then adds nothing;
//   5. the model is told what `offeredForBand` means.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectCandidates, forModel, minutesFor } from '../js/modules/plan-candidates.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// A 2.2 km lane running east from just off the ramp, at its own latitude, passing `n` points.
const lane = (id, lat, lo, hi, n) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: Array.from({ length: 41 }, (_, k) => [-80.725 + k * 0.0006, lat]) },
  properties: {
    id, depth_ft: (lo + hi) / 2, length_m: 2200, routable: true, relief: 'flat', fitted: true,
    envelope_step_m: 100,
    envelope_line_ft: Array.from({ length: 23 }, (_, k) => lo + ((hi - lo) * ((k * 7) % 23)) / 22),
    envelope_ft: Array.from({ length: 23 }, (_, k) => lo + ((hi - lo) * ((k * 5) % 23)) / 22),
    near: Array.from({ length: n }, (_, k) => ({ s: 200 + k * 200, t: 'point', d: 25 })),
  },
});
const STRIPER = { ramp: [-80.73, 34.38], slug: 'w', fishDepthFt: [20, 30], holding: 'suspended',
                  usableAh: 999, windowMin: 9999, transitMph: 10 };
const ids = (list) => list.map((c) => c.runId);
// The ranked part in either order (the two bank lanes are near-equal); what was added, in order.
const ranked = (list) => list.filter((c) => !c.offeredForBand).map((c) => c.runId).sort();
const added = (list) => list.filter((c) => c.offeredForBand).map((c) => c.runId);

const NEAR = [lane('bank1', 34.392, 3, 15, 8), lane('bank2', 34.386, 3, 15, 7),
              lane('deepNear', 34.389, 22, 31, 1), lane('deepFar', 34.42, 22, 31, 1)];

test('a lane over the band that the ranking left out is added; one beyond its reach is not', () => {
  const out = selectCandidates(NEAR, { ...STRIPER, limit: 2 });
  assert.deepEqual(ranked(out), ['bank1', 'bank2']);
  assert.deepEqual(added(out), ['deepNear']);
  assert.equal(out[2].runId, 'deepNear');
  const deep = out[2];
  assert.ok(deep.fromRampM <= Math.max(out[0].fromRampM, out[1].fromRampM));
  assert.equal(out.selection.offeredForBand, 1);
  assert.equal(out.selection.accountedFor, out.selection.considered);
});

test('only until the band\'s lanes on offer hold the day in trolling', () => {
  // Three bank lanes and two deep ones offered, so the list has room for one more over the band.
  const runs = [lane('bank1', 34.381, 3, 15, 9), lane('bank2', 34.392, 3, 15, 8),
                lane('bank3', 34.398, 3, 15, 12), lane('deepA', 34.386, 22, 31, 10),
                lane('deepB', 34.395, 22, 31, 10), lane('deepC', 34.377, 22, 31, 0)];
  const OFFERED = ['bank1', 'bank2', 'bank3', 'deepA', 'deepB'];
  const long = selectCandidates(runs, { ...STRIPER, limit: 5 });
  assert.deepEqual(ranked(long), OFFERED);
  assert.deepEqual(added(long), ['deepC']);
  // The two deep lanes, trolled once each, hold a day exactly that long, and nothing comes in.
  const held = Math.floor(long.filter((c) => c.runId === 'deepA' || c.runId === 'deepB')
    .reduce((t, c) => t + minutesFor(c.lengthM, 2.0), 0));
  const full = selectCandidates(runs, { ...STRIPER, limit: 5, windowMin: held });
  assert.deepEqual(ranked(full), OFFERED);
  assert.deepEqual(added(full), []);
  assert.equal(full.selection.offeredForBand, 0);
});

test('only until the list holds as many lanes over the band as outside it', () => {
  // Two bank lanes offered, three deep ones inside their reach, and a day none of them can fill.
  const runs = [lane('bank1', 34.392, 3, 15, 8), lane('bank2', 34.386, 3, 15, 7),
                lane('deep1', 34.377, 22, 31, 1), lane('deep2', 34.383, 22, 31, 1),
                lane('deep3', 34.389, 22, 31, 1)];
  const out = selectCandidates(runs, { ...STRIPER, limit: 2 });
  assert.deepEqual(ranked(out), ['bank1', 'bank2']);
  assert.equal(added(out).length, 2);
  assert.equal(out.selection.offeredForBand, 2);
  assert.equal(out.selection.accountedFor, out.selection.considered);
});

test('nothing is added when no lane is outside the band, or when there is no band', () => {
  const bass = selectCandidates(NEAR, { ...STRIPER, fishDepthFt: [0, 99], holding: 'bottom', limit: 2 });
  assert.deepEqual(ids(bass).sort(), ['bank1', 'bank2']);
  const { fishDepthFt, ...noBand } = STRIPER;
  const none = selectCandidates(NEAR, { ...noBand, limit: 2 });
  assert.deepEqual(ids(none).sort(), ['bank1', 'bank2']);
  assert.equal(none.selection.offeredForBand, 0);
});

test('a lane added for the band carries the guide\'s water, and the report adds nothing more', () => {
  const reportWater = [{ species: 'Striped Bass', ft: [20, 35], chartFt: [20, 35], label: 'SCC',
                         quote: 'fish in 20-35 feet of water', published: '2026-10-01' }];
  const out = selectCandidates(NEAR, { ...STRIPER, limit: 2, reportWater });
  assert.deepEqual(added(out), ['deepNear']);
  const deep = out.find((c) => c.runId === 'deepNear');
  assert.equal(deep.reportWater.length, 1);
  assert.equal(deep.offeredForReport, undefined);
  assert.equal(out.selection.offeredForReports, 0);
});

test('the model is handed the flag and told what it means', () => {
  const out = selectCandidates(NEAR, { ...STRIPER, limit: 2 });
  assert.equal(forModel(out.find((c) => c.runId === 'deepNear')).offeredForBand, true);
  assert.equal(forModel(out.find((c) => c.runId === 'bank1')).offeredForBand, undefined);
  const prompt = fs.readFileSync(path.join(HERE, '..', 'js', 'modules', 'plan-prompt.js'), 'utf8');
  assert.match(prompt, /THE FISH DEPTH ABOVE DID NOT RANK THIS WATER/);
  assert.match(prompt, /candidate carrying \\`offeredForBand\\` is a lane over the band that the ranking left out/);
});
