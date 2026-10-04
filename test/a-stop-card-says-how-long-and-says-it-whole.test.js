// A stop card says how long the stop is and about when he gets there, shows the positioning in the
// positioning box, and prints the reason whole; a leg card says trolling minutes apart from stop
// minutes.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-04, on his Marion loop: "where on the plan tab does it say that the length of time for
// each of these stops?", "A submerged bridge is the hardest cover on the route ... You r -- it just cuts
// off here", and on a 2.9 mi leg reading "est 202 min": "i have ran this loop for real and i feel like
// it only takes about half this amount of time". It was 87 min trolling and 115 at three stops.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../js/modules/smart-plan-ui.js', import.meta.url), 'utf8');

test('the reason is not cut to 120 characters any more', () => {
  assert.ok(!src.includes('esc(entry.reason).slice(0,120)'));
  assert.ok(src.includes("💡 ${esc(entry.reason || entry.tacticalNote)}"));
});

test('the positioning box shows the positioning, not the reason again', () => {
  assert.ok(src.includes("esc(entry.positioning || entry.tacticalNote || 'Pedal-hover or tie-off to hold position.')"));
});

test('a stop card says its minutes and about when he gets there', () => {
  assert.ok(src.includes('const stopMinutes = Number(entry.estDurationMin) || null;'));
  assert.ok(src.includes('⏱ ${stopMinutes} min${reachAt ? ` · about ${reachAt}` : \'\'}'));
  // the leg's start, the trolling to the stop at the leg's speed, and the stops before it on the leg
  assert.ok(src.includes('Number(entry.atLegM) / (mph * 1609.34 / 60)'));
});

test('a leg card says trolling minutes apart from the minutes at its stops', () => {
  assert.ok(src.includes('min trolling + ${stopMin} min at ${legStops.length} stop'));
});
