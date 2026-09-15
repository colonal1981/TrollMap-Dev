// GEORGIA'S OYSTER WAS SEARCHED FOR IN NORTH CAROLINA, AND THE RUN SAID "none in bbox".
//
// extract_coastal_habitat.py chose a zone's oyster source with
//
//     oyster_src = oyster_sc if state == 'SC' else oyster_nc if state in ('NC', 'GA') else None
//
// so every Georgia zone was clipped against NCDMF's reef guide. The two coasts are four hundred
// kilometres apart, the clip returned nothing, and the run printed "oyster_beds: none in bbox" --
// which reads as a fact about Georgia and is a fact about a search of the wrong state. An answer
// out of the wrong book is worse than no answer, because no answer gets looked into.
//
// It matters NOW rather than eventually: of the thirteen coastal zones the app offers, twelve
// have no oyster or marsh extracted at all -- only Charleston does -- and four of the twelve are
// Georgia. This is the routing those runs would have used.
//
// THE FIX IS A TABLE, NOT A REPAIRED CHAIN, because the chain is what hid it. `state in
// ('NC','GA')` reads as deliberate; a row spelling `'GA': None` cannot. Georgia is None because
// there is no public statewide Georgia oyster layer -- the header names the only two sources on
// the drive, SCDNR's 2015 live layer and NCDMF's reef guide. Where Georgia DOES map shell bottom
// it is inside its own ESI geodatabase as a BENTHIC layer, and the ESI loop already merges any
// BENTHIC layer into oyster_beds.geojson for whatever state carries one.
//
// ANCHORED ON THE TABLE, NOT ON PROSE. Four guards in this suite have failed by matching their
// own comments; a dict literal is code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(path.join(REPO, 'Scripts/extract_coastal_habitat.py'), 'utf8');

/**
 * The script with its comments removed.
 *
 * WRITTEN AFTER THIS FILE CAUGHT ITSELF. The guard below asserts the `state in ('NC','GA')` chain
 * is gone, and it went red on its own FIRST RUN -- because the comment three lines above the fix
 * quotes the chain it replaced, which is exactly the thing worth quoting. That is the fifth time
 * in this suite a source-reading guard has matched prose instead of code. A guard about what the
 * script DOES must not be able to see what the script SAYS.
 */
const CODE = SRC.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/** The table as the script will read it, parsed rather than restated. */
function routingTable() {
  const m = /OYSTER_SOURCE_BY_STATE = \{([\s\S]*?)\n\}/.exec(CODE);
  assert.ok(m, 'OYSTER_SOURCE_BY_STATE is not a dict literal any more');
  const out = {};
  for (const [, k, v] of m[1].matchAll(/'([A-Z]{2})':\s*(None|'[a-z]{2}')/g)) {
    out[k] = v === 'None' ? null : v.slice(1, -1);
  }
  return out;
}

test('no state is ever handed another state’s oyster file', () => {
  const t = routingTable();
  assert.equal(t.SC, 'sc');
  assert.equal(t.NC, 'nc');
  assert.equal(t.GA, null, 'Georgia must not be routed to the North Carolina reef guide');
  // Every row points at its own state or at nothing. This is the whole claim, and it is written
  // so that a fourth state added tomorrow has to satisfy it too.
  for (const [state, src] of Object.entries(t)) {
    assert.ok(src === null || src === state.toLowerCase(),
      `${state} is routed to ${src}, which is not its own source`);
  }
});

test('the chain that hid it is gone from the CODE, comments aside', () => {
  assert.ok(!/state in \('NC',\s*'GA'\)/.test(CODE), "the ('NC','GA') chain is back");
  assert.match(CODE, /which = OYSTER_SOURCE_BY_STATE\.get\(state\)/);
  // ...and the comment that quotes it is still there, because the quote is the evidence.
  assert.match(SRC, /state in \('NC','GA'\)/);
});

test('a state with no source SAYS it was not searched, rather than reporting an empty bbox', () => {
  // "none in bbox" and "there is no such file" are different sentences and only one of them is
  // about Georgia.
  const blk = CODE.slice(CODE.indexOf('which = OYSTER_SOURCE_BY_STATE.get(state)'),
                         CODE.indexOf('if oyster_src is not None:'));
  assert.match(blk, /publishes no statewide oyster layer/);
  assert.match(blk, /not searched/);
});

test('the simplify loop reports the file it actually wrote', () => {
  // A second bug in the same block: `clipped` was replaced only on the break, so a zone that
  // never got under the size cap wrote the most-simplified geojson and printed the feature count
  // of the UNSIMPLIFIED set beside it. simplify() drops empty geometries, so the two genuinely
  // differ — the line reported a count for a file that was never written.
  const i = CODE.indexOf('for tolerance in (0.0001');
  const blk = CODE.slice(i, CODE.indexOf("results['oyster_beds.geojson'] = gj", i));
  const assign = blk.indexOf('clipped = simplified');
  const brk = blk.indexOf('break');
  assert.ok(assign > -1 && assign < brk,
    'clipped must be replaced on every pass, not only on the one that breaks');
  // And an overflow is said out loud rather than written silently.
  assert.match(blk, /STILL OVER THE CAP/);
});

test('the two copies of the script on the drive agree', () => {
  // Ryan runs scripts/; Scripts/ is what goes to GitHub. A fix that lands in one is a fix he
  // does not have.
  assert.ok(SRC.includes('OYSTER_SOURCE_BY_STATE'),
    'the repo copy is missing the fix that was made to the pipeline copy');
});
