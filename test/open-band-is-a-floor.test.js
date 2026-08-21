// GARMIN STOPS BANDING AT 83 FEET AND MARKS THE REST "DEEPER THAN".
//
// Ryan, on the deep lakes rendering as spaghetti: *"i am sure the depth areas are there..."* He
// was right, and they are not a wider field. There are three band tags in the area records and
// the walker knew one:
//
//   bc <lo> <hi>    fine ladder, 0-253 dm          102,637 recs on C4E0CE   recognised
//   bf <lo> <hi>    coarse ladder, 0-238 dm          4,935 recs             was "areas"
//   be <lo> 00      OPEN band, "deeper than <lo>"      764 recs             was "areas"
//
// `be` carries only 219, 238 and 253 dm -- 71.9, 78.1 and 83.0 ft, the top three rungs. There is
// no band below 83 ft anywhere on the card, only the open one, which is why no depth-area byte
// ever exceeds 255 and why the contours' two-byte fix has no counterpart here.
//
// The open polygons are the deep basin, measured on C4E0CE within 6 km of Jocassee's centroid:
// mean distance from the lake centre 2,791 m for `be`, 3,051 m for `bf`, 3,240 m for `bc`, and
// the deepest `be` rung is the most central of all at 2,616 m. Deeper is more central.
//
// WHAT THAT MEANS FOR THE AVERAGE, which is the whole reason this file exists. Every open band
// contributes its FLOOR to the hypsometric volume, because a ceiling it does not have cannot be
// invented. So the mean that falls out is a lower bound, and anything that prints it has to be
// able to say "at least". Printing a floor as a mean is the same failure as calling a December
// water temperature "recent": the number is fine, the tense is wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = readFileSync(path.join(ROOT, 'js/modules/lake-research-engine.js'), 'utf8');
const INPUTS = readFileSync(path.join(ROOT, 'js/modules/plan-inputs.js'), 'utf8');

test('an open band contributes its floor, never an invented ceiling', () => {
  const i = ENGINE.indexOf('} else if (isFinite(zMin)) {');
  assert.ok(i > 0, 'the open-band branch must exist');
  const branch = ENGINE.slice(i, i + 1400);
  assert.ok(/zEffective = zMin;/.test(branch),
    'the floor is the only honest term for a band with no ceiling');
  assert.ok(!/zMax|midpoint|\* 1\.5|\* 2/.test(branch.split('zEffective = zMin;')[1].slice(0, 200)),
    'nothing may scale or extrapolate the floor into a pretend midpoint');
  assert.ok(/openBandArea \+= acres;/.test(branch),
    'the open area must be tracked so the caller can qualify the average');
});

test('the average is flagged as a lower bound whenever any open band contributed', () => {
  assert.ok(/out\.averageDepthIsLowerBound = openBanded;/.test(ENGINE),
    'a mean built over floors is a floor');
  assert.ok(/out\.openBandAreaAcres/.test(ENGINE) && /out\.openBandAreaShare/.test(ENGINE),
    'how much of the lake is open-banded travels with the number');
});

test('the flag reaches the saved profile', () => {
  assert.ok(/geoMeta\.averageDepthIsLowerBound/.test(ENGINE),
    '_bathymetryMeta is what survives save/load, so the flag has to ride in it');
  assert.ok(/geoMeta\.bathymetryOpenBandShare/.test(ENGINE));
});

test('the plan prompt says "at least" rather than printing a floor as a mean', () => {
  assert.ok(/_bathymetryMeta\?\.averageDepthIsLowerBound/.test(INPUTS),
    'researchIntel must read the flag');
  assert.ok(/at least /.test(INPUTS), 'and must say so in words the model reads');
  assert.ok(!/put\('Average depth', id\.averageDepthFt/.test(INPUTS),
    'the unqualified put() is what printed a bound as a measurement');
});

test('a lake with no open bands is not hedged', () => {
  // The flag is `openBanded`, which is only set inside the open branch -- so a fully closed
  // hypsometry prints the plain number. Hedging everything would make the hedge meaningless.
  const i = ENGINE.indexOf('let openBanded = false;');
  assert.ok(i > 0);
  assert.equal((ENGINE.match(/openBanded = true;/g) || []).length, 1,
    'exactly one place may raise the flag: the branch with no ceiling');
});
