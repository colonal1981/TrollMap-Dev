// FIVE FIELDS, TWO ABOUT THE FEATURE AND THREE ABOUT THE RIVER, AND ONLY ONE RESPECTED THE CAP.
//
// build_river_centrelines.py stamps `river_m`, `off_m`, `flow_deg`, `bend_r_m` and `bend_side` onto
// every structure and water feature on the 57 rivers. `river_m` and `off_m` are a position and are
// true at any distance. The other three describe the CHANNEL at one station -- and the script's own
// comment says what "off this river" means: `cap = 3.0 * median channel width`, because "three
// channel widths off the centreline is off this river".
//
// Only `bend_side` was gated on that cap. Measured 2026-09-17 across all 57 rivers, 22,939 stamped
// features: 5,288 (23.1%) are beyond their own pack's cap, and every one of them carried a
// `flow_deg` measured somewhere it is not. Nothing in js/ read it, which is the only reason it cost
// nothing yet -- and `deepest_within_m` is the standing lesson about what that costs the day
// something does read it.
//
// The gate also made three packs say what was wrong with them. Dry run, 2026-09-17:
//
//   congaree_river        7 of 711 (1%)   beyond a 435 m cap, nearest feature    3.8 m
//   south_yadkin_river  171 of 171 (100%) beyond a  75 m cap, nearest feature 1461.0 m
//   pee_dee_river_2     104 of 104 (100%) beyond a 150 m cap, nearest feature 1798.0 m
//   nolichucky_river_2   17 of  17 (100%) beyond a  45 m cap, nearest feature 6001.6 m
//
// Those three are the rivers on the open list that plan to nothing. They are not tight caps: no cap
// reaches 1.5 km. Their centrelines are on water their chartpack never surveyed, which the script
// has ALSO been printing on every run as `section 0/1427 charted` and nobody read.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = readFileSync(path.join(REPO, 'Scripts/build_river_centrelines.py'), 'utf8');
// Comments cannot satisfy a claim about code. A comment in this file once passed a test about the
// code it described; everything below is tested against the stripped source.
const CODE = PY.replace(/^\s*#.*$/gm, '').replace(/"""[\s\S]*?"""/g, '');

describe('build_river_centrelines.py — the cap gates every field that is about the channel', () => {
  test('the cap is still three channel widths, measured not chosen', () => {
    assert.match(CODE, /cap\s*=\s*round\(3\.0\s*\*\s*good_w\[len\(good_w\)\s*\/\/\s*2\],\s*1\)\s*if good_w else None/,
      'the snap cap is no longer 3x the median channel width');
  });

  test('one test decides on-river, and all three channel fields hang off it', () => {
    assert.match(CODE, /on_river\s*=\s*cap is None or d <= cap/,
      'the on-river test is gone or renamed — the three fields below must share ONE test, not '
      + 'three copies of it, or they will drift apart again');
    assert.match(CODE, /props\['flow_deg'\]\s*=\s*round\(brg\[i\], 1\) if on_river else None/,
      'flow_deg is stamped without the cap again: a feature three channel widths off the '
      + 'centreline would carry the direction the water runs somewhere it is not');
    assert.match(CODE, /props\['bend_r_m'\]\s*=\s*\(round\(rad\[i\], 1\)\s*\n?\s*if on_river and rad\[i\] is not None else None\)/,
      'bend_r_m is stamped without the cap again');
    assert.match(CODE, /if on_river and rad\[i\] is not None and turn\[i\] is not None:/,
      'bend_side no longer respects the cap');
  });

  test('the position fields are NOT gated, because they are true at any distance', () => {
    // `off_m` is the evidence for the refusal. Dropping it would leave a reader unable to tell a
    // feature that is off this river from one the index could not place at all.
    assert.match(CODE, /props\['river_m'\]\s*=\s*round\(i \* a\.step, 1\)\s*\n\s*props\['off_m'\]\s*=\s*round\(off, 1\)/,
      'river_m and off_m must stay unconditional — together they are a position, and off_m is '
      + 'what says the thing is off the river at all');
  });

  test('the condition reaches the report and the console, not just the data', () => {
    assert.match(CODE, /rep\['off_cap_frac'\]/, 'the report no longer carries off_cap_frac');
    assert.match(CODE, /rep\['nearest_feature_m'\]/,
      'the report no longer carries the nearest feature — that is the one number separating a '
      + 'tight cap from a pack whose chart and boundary are on different water');
    assert.match(CODE, /OFF THIS RIVER/,
      'the per-river print no longer names the condition; a report that names a condition and '
      + 'does not act on it reads as a decision, and one that never names it reads as health');
  });

  test('a pack with nothing on its own centreline is named in the run summary', () => {
    // ONE TEST, off the pack's own numbers: the nearest feature in the whole pack is further out
    // than three channel widths, so nothing the chart knows about is on the line. It names exactly
    // three of 57 — 6001.6/45, 1798/150, 1461/75 — and the next river along is 27.9 against 105.
    assert.match(CODE, /r\['nearest_feature_m'\] > r\['snap_cap_m'\]/,
      'the dead-river test changed: it must compare the nearest feature against the pack’s own '
      + 'cap, not a number chosen here');
    assert.match(CODE, /WHOSE CHART IS NOT ON THIS CENTRELINE/,
      'the run summary no longer names the packs whose chart and centreline are on different '
      + 'water');
    // The per-river line lives in the verbose branch. This one must not, or a --quiet run — which
    // is how the 57-river rebuild is actually invoked — reports nothing but health.
    const summary = CODE.slice(CODE.indexOf('river(s) built'));
    assert.ok(summary.includes('WHOSE CHART IS NOT ON THIS CENTRELINE'),
      'the summary moved above the totals, where --quiet may skip it');
    assert.equal(/if a\.quiet/.test(summary), false,
      'the dead-river summary is now behind a quiet check — a condition only a verbose run '
      + 'mentions is a condition nobody sees');
  });

  test('every stamped field is still cleared before a rebuild', () => {
    assert.match(CODE, /STAMP_FIELDS\s*=\s*\('river_m',\s*'off_m',\s*'flow_deg',\s*'bend_r_m',\s*'bend_side'\)/,
      'STAMP_FIELDS changed — a field left out of it survives a rebuild that meant to drop it, '
      + 'which is how a stale flow direction would outlive this fix');
    assert.match(CODE, /for k in STAMP_FIELDS:\s*\n\s*props\.pop\(k, None\)/,
      'the pre-stamp clear is gone');
  });
});

describe('and the app never reads a channel field without its side', () => {
  const JS = readFileSync(path.join(REPO, 'js/modules/plan-candidates.js'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '');

  test('bend_r_m only reaches the model inside the bend_side guard', () => {
    // This held before the producer was fixed and is why nothing was told a wrong bend radius.
    // It has to keep holding: `bend_side` is the field that abstains, so it is the gate.
    const m = JS.match(/if \(p\.bend_side === 'outside' \|\| p\.bend_side === 'inside'\) \{[\s\S]{0,400}?\n  \}/);
    assert.ok(m, 'the bend_side guard in describeStructure() is gone');
    assert.ok(m[0].includes('bend_r_m'), 'bend_r_m moved outside the bend_side guard');
    const outside = JS.replace(m[0], '');
    assert.equal(/bend_r_m/.test(outside), false,
      'something reads bend_r_m outside the bend_side guard');
  });
});
