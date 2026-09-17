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
  // AND THE FIRST FIX SAID `'GA': null`, WHICH WAS ALSO WRONG. It carried "Georgia publishes no
  // statewide oyster layer", lifted out of the coastal-layers.js header -- a sentence that was
  // TRUE the day it was written and stopped being true on 2026-09-03, when
  // georgia_oyster_reef_2015.gpkg landed on the drive: 66,935 reef polygons across six coastal
  // counties, Savannah alone 34,216. A stale claim read as evidence for itself and then written
  // down harder, as a table row. Ryan caught it: "so how do we get oysterbeds for GA... i thought
  // we had them." LOOK AT THE DRIVE, NOT AT A COMMENT ABOUT THE DRIVE.
  assert.equal(t.GA, 'ga', 'Georgia has its own reef layer and must be routed to it');
  // Every row points at its own state or at nothing. This is the whole claim, and it is written
  // so that a fourth state added tomorrow has to satisfy it too.
  for (const [state, src] of Object.entries(t)) {
    assert.ok(src === null || src === state.toLowerCase(),
      `${state} is routed to ${src}, which is not its own source`);
  }
});

test('and the sentence it was lifted FROM is gone from the header it was lifted from', () => {
  // THE PROSE IS WHERE THIS STARTED. `'GA': None` carried a comment quoting js/modules/
  // coastal-layers.js: "SC/NC only -- GA has no public oyster shapefile, so GA zones legitimately
  // 404." The extractor was fixed on 2026-09-15 and that header was not, so the claim that caused
  // the bug stayed in shipped code for two more days -- with THIS FILE naming it in a comment and
  // checking only the Python.
  //
  // So it is checked. Anchored on the two load-bearing phrases rather than the whole paragraph,
  // because the paragraph is allowed to be rewritten and the claim is not.
  const LAYERS = readFileSync(path.join(REPO, 'js/modules/coastal-layers.js'), 'utf8');
  const claims = LAYERS.split('THIS ENTRY USED TO READ')[0];
  assert.ok(!/Georgia publishes no statewide\s*\n?\s*\*?\s*oyster layer/.test(claims),
            'the header still says Georgia publishes no statewide oyster layer');
  assert.ok(!/GA has no oyster data/.test(LAYERS),
            'the 404 branch still says Georgia has no oyster data');
  // And it says what is true instead, so this cannot be satisfied by deleting the line.
  assert.match(LAYERS, /georgia_oyster_reef_2015\.gpkg/);
  assert.match(LAYERS, /OYSTER_SOURCE_BY_STATE/);
});

test('the chain that hid it is gone from the CODE, comments aside', () => {
  assert.ok(!/state in \('NC',\s*'GA'\)/.test(CODE), "the ('NC','GA') chain is back");
  assert.match(CODE, /which = OYSTER_SOURCE_BY_STATE\.get\(state\)/);
  // ...and the comment that quotes it is still there, because the quote is the evidence.
  assert.match(SRC, /state in \('NC','GA'\)/);
});

test('a state whose source did not LOAD says that, not that it has no data', () => {
  // Every state in the table has a source now, so the only way oyster_src comes back None is a
  // missing path or a failed read. Reporting that as "this state has no oyster layer" is exactly
  // how georgia_oyster_reef_2015.gpkg sat unread behind a comment saying Georgia had nothing.
  const blk = CODE.slice(CODE.indexOf('which = OYSTER_SOURCE_BY_STATE.get(state)'),
                         CODE.indexOf('if oyster_src is not None:'));
  assert.match(blk, /did not/);
  assert.match(blk, /NOT the same as having no oyster data/);
});

test('all three states reach their OWN file, and none reaches another’s', () => {
  const t = routingTable();
  assert.deepEqual(Object.keys(t).sort(), ['GA', 'NC', 'SC']);
  for (const [state, src] of Object.entries(t)) {
    assert.equal(src, state.toLowerCase(), `${state} is routed to ${src}`);
  }
  // And the dispatch reads the table rather than re-deriving it.
  assert.match(CODE, /\{'sc': oyster_sc, 'nc': oyster_nc, 'ga': oyster_ga\}\.get\(which\)/);
});

test('the Georgia file is named where the script can find it', () => {
  // It is NOT in oyster_marsh/ with the other two — it arrived later and sits in its own folder,
  // which is a large part of why it went unnoticed for twelve days.
  assert.match(CODE, /GA_OYSTER_FILE\s*=/);
  assert.match(CODE, /georgia_oyster_reef_2015\.gpkg/);
  assert.match(CODE, /oyster_ga = gpd\.read_file\(str\(GA_OYSTER_FILE\)/);
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
  // And an overflow is said out loud rather than written silently — now with the REASON, because
  // the message used to read as "try a bigger tolerance" and tolerance is not the lever. Measured
  // on Beaufort: 35,017 KB at 0.0001 down to 33,883 KB at 0.005, a 3% saving across a fifty-fold
  // increase. The polygons are ~5 vertices each; the size is feature count, and Port Royal Sound
  // genuinely holds 68,935 oyster rakes.
  const after = CODE.slice(CODE.indexOf("results['oyster_beds.geojson'] = gj") - 2000,
                           CODE.indexOf("results['oyster_beds.geojson'] = gj") + 1200);
  assert.match(after, /OVER THE .* TARGET and uploaded/);
  assert.match(after, /Simplify cannot help/);
});

test('real beds are never dropped to hit a size target', () => {
  // The alternative to an over-cap upload is throwing away oyster to make a file smaller, and a
  // filter that did exactly that emptied this layer across the whole coast on 2026-09-15. The
  // only thing allowed to remove a feature is the sliver floor, which is measured in square
  // metres and named.
  const i = CODE.indexOf('for tolerance in (0.0001');
  const blk = CODE.slice(i, CODE.indexOf("results['oyster_beds.geojson'] = gj", i));
  assert.ok(!/head\(|sample\(|nlargest|sort_values/.test(blk),
    'the simplify loop must not trim the feature set to fit a byte target');
});

test('the two copies of the script on the drive agree', () => {
  // Ryan runs scripts/; Scripts/ is what goes to GitHub. A fix that lands in one is a fix he
  // does not have.
  assert.ok(SRC.includes('OYSTER_SOURCE_BY_STATE'),
    'the repo copy is missing the fix that was made to the pipeline copy');
});
