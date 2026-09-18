// THE GARMIN DREW ONE ICON FOR EVERYTHING, AND IT WAS PROBABLY THE BLANK ONE.
//
// Ryan, 2026-09-18: *"i dont remember any symbols being used on my echomap..."*. He would not have:
// every chart mark this app wrote carried `sym: 'Shallow Water'`. In the day he exported, 80 of the
// 81 waypoints had that one symbol and the 81st was the launch.
//
// AND `Shallow Water` IS PROBABLY NOT A SYMBOL HIS UNIT HAS. His ECHOMAP UHD2 93sv wrote its own
// GPX -- `creator="ECHOMAP UHD2 93sv"`, 788 waypoints -- and used seven symbols, none of them that
// one. A string the unit does not know falls back to the default pin, which is why they all looked
// the same and why nothing was lost by guessing here: a wrong name is exactly the status quo.
//
// THE NAMES ARE FROM HIS HARDWARE. `Triangle, Red` and `Square, Red` came out of an ActiveCaptain
// export he made on 2026-09-18, which is what settled the shape-comma-colour form; `Flag, Green`,
// `Flag, Red`, `Underwater Tree`, `Boat Ramp` and `Waypoint` came from the unit's own file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markSymbol } from '../js/modules/plan-tracks.js';
import { markLabel } from '../js/modules/plan-candidates.js';

test('a thing with a symbol of its own keeps it, whatever the depth', () => {
  // These are the ones Ryan read off the picker. A ledge is a ledge at 4 ft and at 40.
  for (const [kind, sym] of [['ledge', 'Ledge'], ['hump', 'Hump'], ['pile', 'Brush Pile'],
                             ['timber', 'Underwater Tree'], ['dock', 'Dock'],
                             ['attractor', 'Fish Attractor']]) {
    assert.equal(markSymbol(kind, null, 4), sym);
    assert.equal(markSymbol(kind, null, 40), sym);
    assert.equal(markSymbol(kind, null, null), sym, 'and with no depth at all');
  }
});

test('the shape says what it is and the colour says how deep', () => {
  assert.equal(markSymbol('hole', null, 25), 'Diamond, Blue');
  assert.equal(markSymbol('hole', null, 8), 'Diamond, Green');
  assert.equal(markSymbol('hole', null, 4), 'Diamond, Yellow');
  assert.equal(markSymbol('hole', null, 2), 'Diamond, Red');
  // Six feet is TRANSIT_MIN_DEPTH_FT, the figure he gave for water he will cross but not fish.
  assert.equal(markSymbol('hole', null, 6), 'Diamond, Green');
  assert.equal(markSymbol('hole', null, 5.9), 'Diamond, Yellow');
});

test('the two halves of a bend are two shapes, and the lake words keep the lake shapes', () => {
  assert.equal(markSymbol('cove', 'outside', 14), 'Circle, Blue');
  assert.equal(markSymbol('point', 'inside', 3), 'Triangle, Yellow');
  // No bend stamped: a lake cove is still a cove and still gets the cove's shape.
  assert.equal(markSymbol('cove', null, 7), 'Circle, Green');
  assert.equal(markSymbol('point', null, 7), 'Triangle, Green');
});

test('nothing measured draws the default pin, and does not invent a colour', () => {
  // A coloured icon is a claim about depth. `0 ft relief` is the standing lesson: a missing
  // measurement must not arrive wearing the clothes of a real one.
  assert.equal(markSymbol('hole', null, null), 'Waypoint');
  assert.equal(markSymbol('hole', null, 0), 'Waypoint');
  assert.equal(markSymbol('creek_mouth', null, undefined), 'Waypoint');
  assert.equal(markSymbol('something_new', null, 12), 'Waypoint', 'and an unknown kind is not guessed');
});

test('shallow is red without being measured, because that is what the word means', () => {
  assert.equal(markSymbol('shallow', null, null), 'Triangle, Red');
  assert.equal(markSymbol('shallow', null, 20), 'Triangle, Red');
});

test('a hazard is a warning shape and never a fish', () => {
  assert.equal(markSymbol('hazard', null, 30), 'Rocks');
  assert.equal(markSymbol('obstruction', null, null), 'Rocks');
});

test('nothing in the set is the string the unit never wrote', () => {
  const kinds = ['hole', 'ledge', 'point', 'cove', 'creek_mouth', 'hump', 'timber', 'pile',
                 'dock', 'attractor', 'hazard', 'obstruction', 'shallow', 'bridge'];
  const sides = [null, 'inside', 'outside'];
  const depths = [null, 1, 4, 8, 25];
  for (const k of kinds) {
    for (const s of sides) {
      for (const d of depths) {
        assert.notEqual(markSymbol(k, s, d), 'Shallow Water',
                        `${k} still carries the symbol his unit has never once written`);
      }
    }
  }
});

test('the name on the waypoint is the name in the plan', () => {
  // One function, two readers. The GPX name and the model's `what` string came from two different
  // pieces of code, which is how a river bend reached the chartplotter called a cove.
  assert.equal(markLabel('cove', 'outside'), 'outside bend');
  assert.equal(markLabel('point', 'inside'), 'inside bend');
  assert.equal(markLabel('cove', 'inside'), 'cove');
  assert.equal(markLabel('point', 'outside'), 'point');
  assert.equal(markLabel('creek_mouth', null), 'creek mouth', 'underscores are not read at 2 mph');
  assert.equal(markLabel(undefined, null), 'mark');
});
