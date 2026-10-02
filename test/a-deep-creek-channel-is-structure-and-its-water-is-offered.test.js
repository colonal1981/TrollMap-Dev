// A deep creek channel is structure, and its water over the band is offered.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-01, on Lake Marion from Rowland Subdivision: "why does there need to be some sort
// of structure to draw a trolling lane? just the fact that it is a deep creek channel is structure in
// itself... it is called out as something to fish for striper", then "I just want that water in the
// middle of the creek and the east to west channel to be offered in smart plan... Whatever the best
// method is to get it added". What these hold:
//   1. the rule's two numbers are the app's own: the relief radius, and classify()'s flat cutoff;
//   2. a station is in a channel when the bottom rises more than that on BOTH sides, the bank
//      counting as a rise, and a slope that rises on one side only is not;
//   3. a lane's channel stretch the structure window leaves unfished becomes a leg of its own,
//      named by where it starts, scored as the channel once, with the run's relief word not added
//      on top and no channel in its passes;
//   4. a leg that runs a pass of channel over the band is added past the limit, says so, and every
//      window is accounted for;
//   5. without channels.json nothing changes, and the model is told what the two fields mean.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { channelStretches, channelHits, channelMetres, FLAT_DROP_FT, RELIEF_RADIUS_M, CHANNEL_KIND }
  from '../js/modules/plan-channels.js';
import { selectCandidates, forModel, DEFAULT_RELIEF_WEIGHTS } from '../js/modules/plan-candidates.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAT = 34.38, LON = -80.725;
const KX = 111320 * Math.cos((LAT * Math.PI) / 180), KY = 110540;
// Metres east and north of the lane's start.
const xy = ([lon, lat]) => [(lon - LON) * KX, (lat - LAT) * KY];
// A straight lane due east, `n` stations 40 m apart, 30 ft under the line all the way.
const straight = (id, n, extra = {}) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: Array.from({ length: n }, (_, k) => [LON + (k * 40) / KX, LAT]) },
  properties: { id, fitted: true, envelope_step_m: 40, envelope_m: 25, length_m: (n - 1) * 40,
                envelope_line_ft: Array(n).fill(30), ...extra },
});

test('the two numbers are the app\'s own, not new ones', () => {
  assert.equal(RELIEF_RADIUS_M, 250);
  const py = fs.readFileSync(path.join(HERE, '..', 'Scripts', 'build_water_features.py'), 'utf8');
  const m = py.match(/if drop <= (\d+):\s*\n\s*return 'flat'/);
  assert.ok(m, 'classify() still draws the line between flat and the rest');
  assert.equal(Number(m[1]), FLAT_DROP_FT);
});

test('a trough is a channel, a one-sided slope is not, and the bank counts as a rise', () => {
  // West of 1,000 m the bottom comes up 1 ft every 10 m on both sides; east of it, only to the south.
  const depthAt = (q) => {
    const [x, y] = xy(q);
    return x < 1000 ? 30 - Math.abs(y) / 10 : 30 + y / 10;
  };
  assert.deepEqual(channelStretches(straight('a', 51), depthAt), [[0, 960]]);
  // A flat-bottomed cut 100 m either side of the lane, then the bank (no depth area): a channel.
  const cut = (q) => (Math.abs(xy(q)[1]) <= 100 ? 30 : null);
  assert.deepEqual(channelStretches(straight('b', 26), cut), [[0, 1000]]);
  // A rise of exactly the flat cutoff is flat.
  const shelf = (q) => 30 - Math.min(FLAT_DROP_FT, Math.abs(xy(q)[1]) / 10);
  assert.deepEqual(channelStretches(straight('c', 26), shelf), []);
});

test('hits along a stretch, and metres of a window in one', () => {
  const h = channelHits([[0, 600], [1000, 1100]], 250);
  assert.deepEqual(h.map((x) => x.s), [0, 250, 500, 600, 1000, 1100]);
  assert.ok(h.every((x) => x.t === CHANNEL_KIND && x.d === 0));
  assert.equal(channelMetres([[0, 600], [1000, 1100]], 500, 1050), 150);
});

// The selector. Two lanes along the bank, thick with points and over the band themselves, so the
// band step has nothing to add and the channel step is what is tested; and a 3.3 km deep lane whose
// points are all at its far end, more than a leg's quiet water away from the 1,000 m of channel it
// starts with.
const bank = (id, lat, n) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: Array.from({ length: 41 }, (_, k) => [LON + k * 0.0006, lat]) },
  properties: { id, depth_ft: 22, length_m: 2200, routable: true, relief: 'flat', fitted: true,
                envelope_step_m: 100, envelope_line_ft: Array(23).fill(22), envelope_ft: Array(23).fill(21),
                near: Array.from({ length: n }, (_, k) => ({ s: 200 + k * 200, t: 'point', d: 25 })) },
});
const deep = {
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: Array.from({ length: 61 }, (_, k) => [LON + k * 0.0006, 34.389]) },
  properties: { id: 'creek', depth_ft: 29, length_m: 3300, routable: true, relief: 'flat', fitted: true,
                envelope_step_m: 100, envelope_line_ft: Array(34).fill(30), envelope_ft: Array(34).fill(28),
                near: Array.from({ length: 4 }, (_, k) => ({ s: 2700 + k * 150, t: 'point', d: 25 })) },
};
const RUNS = [bank('bank1', 34.392, 8), bank('bank2', 34.386, 7), deep];
const STRIPER = { ramp: [-80.73, 34.38], slug: 'w', fishDepthFt: [20, 30], holding: 'suspended',
                  usableAh: 999, windowMin: 9999, transitMph: 10 };
const CHANNELS = { creek: [[0, 1000]] };

test('a channel stretch the structure left unfished is a leg of its own, scored as the channel once', () => {
  const all = selectCandidates(RUNS, { ...STRIPER, channels: CHANNELS });
  const first = all.find((c) => c.runId === 'creek');
  const ch = all.find((c) => c.runId === 'creek@0');
  assert.ok(first && ch, 'both windows of the creek lane are candidates');
  assert.ok(first.startM >= 1500, 'the first window is where the points are');
  assert.equal(ch.startM, 0);
  assert.equal(ch.lengthM, 1000);
  assert.equal(ch.channelM, 1000);
  // The channel's relief weight, once, and NOT the run's own word ("flat") on top of it.
  assert.equal(ch.score, DEFAULT_RELIEF_WEIGHTS.channel_edge);
  assert.ok(ch.passes.every((p) => p.type !== CHANNEL_KIND), 'the channel is not a place to stop');
  assert.equal(all.selection.channelWindows, 1);
  assert.equal(all.selection.considered, RUNS.length + 1);
  assert.equal(all.selection.accountedFor, all.selection.considered);
});

test('a leg running a pass of channel over the band is added past the limit, and says so', () => {
  const out = selectCandidates(RUNS, { ...STRIPER, limit: 2, channels: CHANNELS });
  const added = out.find((c) => c.runId === 'creek@0');
  assert.ok(added, 'the channel leg is on the list');
  assert.equal(added.offeredForChannel, true);
  assert.equal(out.selection.offeredForChannel, 1);
  assert.equal(out.selection.accountedFor, out.selection.considered);
  // Not when its water is outside a bottom fish's band.
  const bass = selectCandidates(RUNS, { ...STRIPER, fishDepthFt: [5, 15], holding: 'bottom', limit: 2, channels: CHANNELS });
  assert.equal(bass.find((c) => c.runId === 'creek@0')?.offeredForChannel, undefined);
  assert.equal(bass.selection.offeredForChannel, 0);
});

test('without channels.json nothing changes, and the model is told what the fields mean', () => {
  const key = (l) => JSON.stringify(l.map((c) => [c.runId, c.startM, c.lengthM, c.score, c.value]));
  const none = selectCandidates(RUNS, { ...STRIPER, limit: 2 });
  const empty = selectCandidates(RUNS, { ...STRIPER, limit: 2, channels: {} });
  assert.equal(key(none), key(empty));
  assert.ok(none.every((c) => !c.channelM && !c.offeredForChannel));
  assert.equal(none.selection.channelWindows, 0);
  const out = selectCandidates(RUNS, { ...STRIPER, limit: 2, channels: CHANNELS });
  const m = forModel(out.find((c) => c.runId === 'creek@0'));
  assert.equal(m.channelM, 1000);
  assert.equal(m.offeredForChannel, true);
  assert.equal(forModel(out.find((c) => c.runId === 'bank1')).channelM, undefined);
  const prompt = fs.readFileSync(path.join(HERE, '..', 'js', 'modules', 'plan-prompt.js'), 'utf8');
  assert.match(prompt, /A CHANNEL IS STRUCTURE/);
  assert.match(prompt, /\\`offeredForChannel\\`/);
});
