// Personal use only, not for distribution or resale; not for navigation.
//
// THE ROD CARD SAYS WHAT THE ROD CARRIES.
//
// Lake Moultrie from Short Stay, 2026-10-02, 06:00-15:00. The seating was right by Ryan's snap
// list -- A-rig and flutter spoon on leader rods R3/R4, bucktail and jighead swimbait on the snap
// rods R5/R6 -- and four of six cards said the opposite, because the rigging line was guessed from
// the lure's name. These are that plan's routeRods rows, as saved.
//
//   node --test test/the-rod-card-says-what-the-rod-carries.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { reelForRod, reelForLure, spreadRowsFrom } from '../js/modules/smart-plan-ui.js';
import { ROD_RIG } from '../js/modules/plan-prompt.js';

const LEADER = /\+ 20lb fluoro leader/;
const SNAP = /directly tied to swivel snap/;

const ROWS = {
  L3: [{ side: 'Port', rod: 'R3', lure: 'A-Rig Heavy (~3.5oz) – 5" Swimbait', reel: '' },
       { side: 'Stbd', rod: 'R4', lure: 'Nichols Lake Fork Flutter Spoon 5" 1-1/8oz (FS14-118)', reel: '' }],
  L13: [{ side: 'Port', rod: 'R5', lure: 'SPRO Prime Bucktail Jig 3oz (SBTJ-3)', reel: '' },
        { side: 'Stbd', rod: 'R6', lure: 'Swimbait 5" – Jighead', reel: '' }],
};
const CARDS = [{ key: 'L3', label: 'Leg 3', speedMph: 1.8 }, { key: 'L13', label: 'Leg 13', speedMph: 1.6 }];

test('every row of the 10/2 Moultrie plan says what its rod carries', () => {
  const rows = spreadRowsFrom(CARDS, ROWS);
  assert.equal(rows.length, 4);
  for (const r of rows) {
    const want = ROD_RIG[r.rod] === 'snap' ? SNAP : LEADER;
    assert.match(r.reel, want, `${r.rod} (${ROD_RIG[r.rod]}) carrying ${r.lure} printed "${r.reel}"`);
  }
});

test('a snap bait on a leader rod reads leader, and a leader bait on a snap rod reads snap', () => {
  assert.match(reelForRod('R4', 'Nichols Lake Fork Flutter Spoon 5" 1-1/8oz (FS14-118)'), LEADER);
  assert.match(reelForRod('R3', 'A-Rig Heavy (~3.5oz) – 5" Swimbait'), LEADER);
  assert.match(reelForRod('R5', 'SPRO Prime Bucktail Jig 3oz (SBTJ-3)'), SNAP);
  assert.match(reelForRod('R6', 'Swimbait 5" – Jighead'), SNAP);
});

test('a row with no rod id -- the hand-built spread table -- keeps the old guess', () => {
  assert.equal(reelForRod('', 'A-Rig Heavy (~3.5oz) – 5" Swimbait'), reelForLure('A-Rig Heavy (~3.5oz) – 5" Swimbait'));
  assert.equal(reelForRod(undefined, '1/2oz Spinnerbait'), reelForLure('1/2oz Spinnerbait'));
});
