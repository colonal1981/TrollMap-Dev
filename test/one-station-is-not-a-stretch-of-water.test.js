// Personal use only, not for distribution or resale; not for navigation.
//
// A leg's bait ceiling must be the shallowest water it SUSTAINS, not its shallowest single
// station. Measured 2026-09-21 on congaree_river:drift:channel@138650: 108 stations, minFt 2,
// median 17 -- and exactly one station under 6 ft, at a point the pack's own depth areas put in
// 22 ft of water. That one sample refused two baits for the whole 5.4 km pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waterBand } from '../js/modules/plan-pieces.js';

const band = (line) => waterBand(
  { envelope_step_m: 50, envelope_line_ft: line, envelope_ft: line.map((v) => v) },
  0, (line.length - 1) * 50,
);

test('the true minimum is still reported', () => {
  const b = band([20, 13, 2, 23, 21, 20]);
  assert.equal(b.line.minFt, 2, 'minFt is the shallowest sample and does not move');
  assert.equal(b.line.medianFt, 20);
});

test('a one-station rise does not set the sustained floor', () => {
  const b = band([20, 13, 2, 23, 21, 20]);
  // 2 is alone: its neighbours are 13 and 23, so the shallowest water two consecutive stations
  // both clear is 13 -- which is what the chart says is under that point.
  assert.equal(b.line.sustainedMinFt, 13);
});

test('a rise across two stations IS the floor', () => {
  const b = band([20, 19, 4, 4, 21, 20]);
  assert.equal(b.line.minFt, 4);
  assert.equal(b.line.sustainedMinFt, 4, '100 m of 4 ft water is water he trolls through');
});

test('an uncharted station cannot vouch for the one beside it', () => {
  //            0    1   2   3    4
  const b = band([20, -1, 3, -1, 20]);
  assert.equal(b.line.minFt, 3);
  // No two ADJACENT sounded stations exist at all, so there is nothing to sustain and the
  // fallback is the true minimum rather than an invented one.
  assert.equal(b.line.sustainedMinFt, 3);
});

test('an uncharted station does not bridge two shallow ones', () => {
  const b = band([20, 2, -1, 2, 20, 19]);
  assert.equal(b.line.minFt, 2);
  // The two 2s are not adjacent, and -1 is not a sounding that joins them. The shallowest pair
  // of adjacent sounded stations is 20/19.
  assert.equal(b.line.sustainedMinFt, 20);
});

test('a leg that is shallow throughout keeps its floor', () => {
  const b = band([4, 3, 3, 4, 5]);
  assert.equal(b.line.minFt, 3);
  assert.equal(b.line.sustainedMinFt, 3, 'nothing is smoothed away when the water really is shallow');
});

test('a single-station leg has no pair and falls back', () => {
  const b = band([7]);
  assert.equal(b.line.minFt, 7);
  assert.equal(b.line.sustainedMinFt, 7);
});
