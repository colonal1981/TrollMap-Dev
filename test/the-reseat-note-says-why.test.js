// THE RE-SEAT NOTE SAYS WHY IT MOVED THE RODS.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Change request 18, seen on the 2026-09-25 Wateree plans: "The re-seat note says 'so every lure
// is on a rod that can carry it' even when every bait already could." seatRods() moves rods either
// way -- snap-friendly baits fill the snap rods, where a change is seconds -- so the note has to
// say which of the two it was. A correction wants him; bookkeeping goes with what the app settled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatRods, planArgsFrom } from '../js/modules/plan-prompt.js';

const connectionOf = (name) => (String(name).startsWith('Tie') ? 'tie' : 'snap');

test('seatRods counts the baits that could not go where the model put them', () => {
  assert.equal(seatRods([{ id: 'R5', lure: 'Tie Crank' }], connectionOf).illegal, 1);
  assert.equal(seatRods([{ id: 'R1', lure: 'Snap Spoon' }], connectionOf).illegal, 0);
  assert.equal(seatRods([{ id: 'R1', lure: 'Tie Crank' }], connectionOf).illegal, 0);
});

test('a tie-only bait on a snap rod is a correction, and it is a warning', () => {
  const a = planArgsFrom({ loadout: { rods: [{ id: 'R5', lure: 'Tie Crank' }] }, legs: [] }, [],
                         { connectionOf });
  assert.ok(a.problems.some((p) => /^re-seated R5→R1 so every lure is on a rod that can carry it$/.test(p)));
  assert.equal(a.decisions.length, 0);
});

test('a move that only puts a snap bait on a snap rod is bookkeeping, and it is settled quietly', () => {
  const a = planArgsFrom({ loadout: { rods: [{ id: 'R1', lure: 'Snap Spoon' }] }, legs: [] }, [],
                         { connectionOf });
  assert.equal(a.problems.filter((p) => /re-seated/.test(p)).length, 0);
  assert.equal(a.decisions.length, 1);
  assert.match(a.decisions[0], /^re-seated R1→R5 so the snap rods carry the baits that can hang off a snap/);
  assert.match(a.decisions[0], /every bait could already go where the model put it$/);
});

test('nothing moved, nothing said', () => {
  const a = planArgsFrom({ loadout: { rods: [{ id: 'R5', lure: 'Snap Spoon' }] }, legs: [] }, [],
                         { connectionOf });
  assert.equal([...a.problems, ...a.decisions].filter((p) => /re-seated/.test(p)).length, 0);
});
