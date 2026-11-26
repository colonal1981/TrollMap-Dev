// Personal use only, not for distribution or resale; not for navigation.
//
// THE PANEL READS THE STEERING BOX'S OWN LINES.
//
// The lines are garage_test.ino's, as the terminal app showed them at Second Mill on 2026-11-26. The box's
// heading is its board arrow, magnetic: the bow's true heading is HDG + DECL - 90 (the firmware's trueToHdg
// turned round).
import test from 'node:test';
import assert from 'node:assert/strict';
import { newStatus, applyLine, bowTrue, offLineText, distText, motorText } from '../js/utils/autopilot-status.js';

test("the bow's true heading from the box's number", () => {
  assert.equal(bowTrue(98), 0);           // 98 - 8.2 - 90 = -0.2, which is north, not 360
  assert.equal(bowTrue(188), 90);
  assert.equal(bowTrue(48), 310);
  assert.equal(bowTrue(null), null);
});

test('a day of lines: fix, hold, follow, a lap, a pause at the mount', () => {
  const s = newStatus();
  applyLine(s, 'HDG 213 47uT r0 q0 GPS s9 2.1mph c128 h0.9 33.91829,-80.38016', 0);
  assert.equal(s.fix, true);
  assert.equal(s.sats, 9);
  assert.equal(s.lat, 33.91829);
  assert.equal(s.lon, -80.38016);
  assert.equal(applyLine(s, 'HOLD on 214', 100).type, 'hold-on');
  applyLine(s, 'HOLD 214 h213 e+1 r+0 m+2 g1.0', 200);
  assert.equal(s.mode, 'holding');
  assert.equal(s.motorDeg, 2);
  assert.equal(applyLine(s, 'ROUTE cleared', 300).type, 'cleared');
  applyLine(s, 'WP 1', 310);
  applyLine(s, 'WP 2', 320);
  assert.equal(s.wpAck, 2);
  assert.equal(applyLine(s, 'ROUTE 2 points, loop', 330).type, 'route');
  assert.deepEqual(s.route, { n: 2, loop: true });
  assert.equal(applyLine(s, 'FOLLOW on: 2 points, loop, toward point 1', 400).type, 'follow-on');
  applyLine(s, 'FOLLOW wp 1/2 d140 x-4 aim 128', 1000);
  applyLine(s, 'HOLD 220 h219 e+1 r+0 m-3 g1.0', 1100);
  assert.equal(s.mode, 'following', 'a HOLD line while following is the follow steering');
  assert.equal(s.xteM, -4);
  assert.equal(s.aimTrue, 128);
  assert.equal(applyLine(s, 'LAP', 1200).type, 'lap');
  assert.equal(applyLine(s, 'HOLD off: pause (press again to rejoin the route)', 1300).type, 'paused');
  assert.equal(s.mode, 'paused');
  applyLine(s, 'HDG 213 47uT r0 q0 GPS nofix s3', 1400);
  assert.equal(s.fix, false);
  assert.equal(applyLine(s, 'NO: no GPS fix', 1500).text, 'no GPS fix');
});

test('the compass on the boat: the circle, the fit, the trim', () => {
  const s = newStatus();
  assert.equal(applyLine(s, 'LEARN boat on: turn the whole boat one slow flat circle, box mounted; L to finish').type, 'compass');
  assert.equal(s.flat, true);
  assert.equal(applyLine(s, 'LEARN boat: 412 readings, turned through 195 of 360'), null);
  assert.equal(s.flatTurned, 195);
  assert.equal(applyLine(s, 'LEARN boat off: 900 readings, turned through 345 of 360').type, 'compass');
  assert.equal(s.flat, false);
  assert.equal(applyLine(s, 'boat pull 4.9 uT on a level field of 22.3 uT: up to 13 deg of heading').type, 'compass');
  applyLine(s, 'CAL saved (boat): moved 2.5,-4.2,0.1 uT, trim cleared');
  assert.equal(s.trim, 0);
  assert.equal(applyLine(s, 'TRIM -4.5 deg: the bow reads 240 now').type, 'compass');
  assert.equal(s.trim, -4.5);
  applyLine(s, 'compass cal -18,-6,-19 r48 trim +2.0');
  assert.equal(s.trim, 2);
});

test('what the panel says', () => {
  assert.equal(offLineText(-4), '13 ft left');
  assert.equal(offLineText(0.5), 'on the line');
  assert.equal(distText(128), '140 yd');
  assert.equal(distText(1609.34), '1.00 mi');
  assert.equal(motorText(-8), '8° left');
  assert.equal(motorText(0), 'straight');
});
