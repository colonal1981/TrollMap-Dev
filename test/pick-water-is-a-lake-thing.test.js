// PICK WATER IS A LAKE THING, AND ON A RIVER IT NOW SAYS SO.
//
// Ryan, 2026-09-17, after the count: up one bank and back down the other passes 145 of the
// Congaree's 189 holes against 91 for the best single line, and 43 of the 57 rivers have a median
// channel under 80 m -- narrower than the corridor his rods cover, so there is no side to pick.
//
//   "up one side and down the other is probably the right answer... that is probably the easiest...
//    so for rivers pickwater will just not be applicable that is more of a lake thing anyways"
//
// The Water tab lays out pieces to tick. A river day is ONE path. So the tab refuses a river before
// it fetches anything, and `riverCurrent: null` in plan-from-water.js stops being a named gap and
// becomes a decision that is not waiting on anything.
//
// AND THE QUESTION IS ASKED ONCE. Smart Plan has the live waterState and the Water tab has the
// registry row; both go through saysRiver(). Two spellings of one question is how two planners come
// to disagree about the same water, which is this project's most repeated defect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { saysRiver } from '../js/modules/plan-inputs.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(REPO, p), 'utf8');
const UI = read('js/modules/plan-water-ui.js');
const V2 = read('js/modules/smart-plan-v2.js');
const PFW = read('js/modules/plan-from-water.js');

test('both casings of the same field, because the registry and the Worker disagree about it', () => {
  // registry/lake_index.json writes `feature_type`; the Worker hands back `featureType`.
  assert.equal(saysRiver({ feature_type: 'river' }), true);
  assert.equal(saysRiver({ featureType: 'river' }), true);
  assert.equal(saysRiver({ feature_type: 'River' }), true, 'case is not a fact about the water');
  assert.equal(saysRiver({ feature_type: ' river ' }), true);
});

test('a lake and a coastal zone are not rivers, and neither is silence', () => {
  // The registry knows 57 rivers, 285 lakes and 13 coastal zones. Only the first is refused.
  assert.equal(saysRiver({ feature_type: 'lake' }), false);
  assert.equal(saysRiver({ feature_type: 'coastal' }), false);
  // ABSENCE IS NOT A CLAIM THAT IT IS A LAKE. It is the absence of a claim, and false is what a
  // caller with no second signal must do with it -- Smart Plan's second signal is the centreline.
  assert.equal(saysRiver(null), false);
  assert.equal(saysRiver(undefined, null, {}), false);
  assert.equal(saysRiver(), false);
  assert.equal(saysRiver('river'), false, 'a bare string is not a carrier');
});

test('any carrier will do, so a caller offers whichever it holds', () => {
  assert.equal(saysRiver(null, { featureType: 'river' }), true);
  assert.equal(saysRiver({ feature_type: 'lake' }, { featureType: 'river' }), true);
});

test('NOT waterState.river, which is a details object and is truthy on a lake', () => {
  // A Duke tailwater with `generatingNow` carries one. Testing it would have planned the Congaree
  // over contour lanes on any /conditions timeout and refused to plan a tailwater reservoir at all.
  assert.equal(saysRiver({ river: { flowCfs: 3000, generatingNow: true }, feature_type: 'lake' }), false);
});

test('the Water tab refuses a river before it fetches anything', () => {
  assert.ok(UI.includes('saysRiver(registryRecordFor(inp.lakeName))'),
            'the gate asks the registry row through the shared predicate');
  // BEFORE the work, not after. The gate has to sit above the regulations fetch and the layer
  // fetches, or the tab does a lake's worth of downloading to tell him it is the wrong tab.
  const gate = UI.indexOf('saysRiver(registryRecordFor(inp.lakeName))');
  const regs = UI.indexOf("say('Checking the regulations…')");
  const layers = UI.indexOf("say('Measuring the water…')");
  assert.ok(gate > 0 && regs > 0 && layers > 0);
  assert.ok(gate < regs, 'the river gate must come before the regulations fetch');
  assert.ok(gate < layers, 'and before the layers are measured');
  // AND IT SAYS WHERE TO GO. A refusal that does not name the other tab is a dead end.
  assert.match(UI, /is a river — Pick Water lays out pieces to tick/);
  assert.match(UI, /Use Smart Plan for this one/);
});

test('one spelling of the question, in both planners', () => {
  assert.ok(V2.includes('const stateSaysRiver = saysRiver(o.waterState);'),
            'Smart Plan asks through the same predicate');
  // The old inline compare must not come back in either file.
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const [name, src] of [['smart-plan-v2.js', V2], ['plan-water-ui.js', UI]]) {
    assert.ok(!/featureType\s*\|\|\s*''\)\s*===\s*'river'/.test(code(src)),
              `${name} has grown its own string compare again`);
  }
});

test('riverCurrent is a decision now, not a gap waiting on work', () => {
  assert.ok(PFW.includes('riverCurrent: null'), 'the field is still named rather than absent');
  assert.match(PFW, /findWater\(\) refuses a river before/);
  assert.match(PFW, /It is not waiting on anything/);
  // The old wording said Pick Water plans rivers off contour pieces. If that sentence comes back,
  // so has the gap.
  assert.ok(!/which on a river are still contour-shaped/.test(PFW));
});
