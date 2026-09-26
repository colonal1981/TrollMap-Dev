// THERE IS NO SUCH THING AS AN OPEN BAND. This file used to assert the opposite, at length.
//
// The claim was that Garmin stops banding at 83 ft and marks everything below it `be <lo> 00`,
// "deeper than <lo>", with no ceiling — so every one of those polygons contributed its FLOOR to
// the hypsometric volume, the mean that fell out was a lower bound, and anything printing it had
// to say "at least". Four fields carried that: `openBanded`, `openBandAreaAcres`,
// `openBandAreaShare` and `averageDepthIsLowerBound`.
//
// The band tag's two low bits are PAGE CARRIES. `be` is the one band that straddles a 256 dm page
// line, so its ceiling byte reads 0 because 256 mod 256 is 0 — `be 253 00` is 253–256 dm, a
// one-foot band, and `be 219 37` is 21.9 m to 29.3 m and appears 288 times. Every polygon on the
// card carries both ends. Measured 2026-08-23 after the re-extract: **0 of 89,835 depth-area
// features across 298 shipped packs** lack a numeric `depth_max_ft`.
//
// So the four fields reported zero on every profile and described a property the data does not
// have. What replaces them is a guard on an UNREADABLE record — counted, never claimed as a fact
// about the lake — and an honest band count.
//
// The old file is the reason this one exists rather than being deleted: a tripwire that asserts a
// deleted concept is present will pass forever if the concept comes back by accident.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

//
// ── THE COMPUTATION MOVED AND THIS FILE KEPT READING ITS OLD ADDRESS ───────────────────────────
//
// d2c0219, 2026-09-04, "Pick Water now derives the pack's facts from the pack it just downloaded",
// lifted the whole depth-band computation out of lake-research-engine.js into js/utils/pack-facts.js
// so both planners derive it from the pack instead of one of them reading a stored profile. Nothing
// about the behaviour below changed. This file went on reading the engine, so three of its tests
// failed looking for code that had moved, and the fourth -- "nothing computes an open band any
// more" -- started passing VACUOUSLY, because a file with none of the computation in it also has
// none of the retired names.
//
// Same defect as `between(UTIL, 'NON_GAME_SPECIES', ...)` in species-form-closes-the-books, fixed
// the same day: a test that reads source by name cannot tell "the concept is gone" from "I am
// looking at the wrong file". So HOME is asserted to still hold the computation before anything is
// asserted about it, and the retired names are checked in the file that computes it and the one it
// passes through. (The engine, the third, was deleted with the Research tab on 2026-09-25.)
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME_PATH = 'js/utils/pack-facts.js';
const HOME = readFileSync(path.join(ROOT, HOME_PATH), 'utf8');
const INPUTS = readFileSync(path.join(ROOT, 'js/modules/plan-inputs.js'), 'utf8');

test('this file is reading the file that holds the computation', () => {
  // If the depth stats move again, THIS fails first and names the problem, instead of three
  // behaviour tests failing as though the behaviour had been deleted.
  for (const anchor of ['const bandsSeen = new Set();', 'unreadableCeilings++;',
                        'out.bandCount = bandsSeen.size;']) {
    assert.ok(HOME.includes(anchor),
      `the depth-band computation is no longer in ${HOME_PATH} — find where it went and repoint `
      + 'this file at it; the tests below are about the behaviour, not about this path');
  }
});

// Comments may discuss the retired names; code may not use them.
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('nothing computes, stores or reads an open band any more', () => {
  // pack-facts.js first, because that is the one that could bring it back. Checking only the
  // engine and plan-inputs was checking two files the computation had left. The engine itself
  // went with the Research tab on 2026-09-25, so two files remain to check.
  const files = [[HOME_PATH, codeOnly(HOME)],
                 ['js/modules/plan-inputs.js', codeOnly(INPUTS)]];
  for (const name of ['openBanded', 'openBandArea', 'openBandAreaAcres', 'openBandAreaShare',
                      'averageDepthIsLowerBound', 'bathymetryOpenBanded',
                      'bathymetryOpenBandAreaAcres', 'bathymetryOpenBandShare']) {
    for (const [label, src] of files) assert.ok(!src.includes(name), `${label} still uses ${name}`);
  }
});

test('a record with no readable ceiling is counted at its floor, not dropped', () => {
  // The area is real water. Dropping it would move coverage and the average with nothing saying
  // so — the failure this whole family of bugs is made of.
  const i = HOME.indexOf('} else if (isFinite(zMin)) {');
  assert.ok(i > 0, 'the guard must still exist');
  const branch = HOME.slice(i, i + 900);
  assert.ok(/zEffective = zMin;/.test(branch), 'the floor is the only honest term');
  assert.ok(/unreadableCeilings\+\+;/.test(branch), 'and it must be counted');
  assert.ok(!/zMax|midpoint|\* 1\.5|\* 2/.test(branch.split('zEffective = zMin;')[1].slice(0, 200)),
    'nothing may invent a ceiling to scale the floor into a pretend midpoint');
});

test('the unreadable count travels with the numbers it could have moved', () => {
  assert.ok(/out\.unreadableCeilings = unreadableCeilings;/.test(HOME));
  assert.ok(/geoMeta\.bathymetryUnreadableCeilings/.test(HOME),
    '_bathymetryMeta is what survives save/load');
  assert.ok(/unreadableCeilings: depthStats\.unreadableCeilings/.test(HOME),
    'and the evidence entry has to carry it too');
});

test('bandCount counts BANDS, and the ring count is its own field', () => {
  // It counted rings until 2026-08-23. That told the habitat agent Lake Jocassee has 18,967
  // depth bands when it has 135, and set the no-boundary trust gate on a number that could be
  // three rings of a single band.
  assert.ok(/const bandsSeen = new Set\(\);/.test(HOME));
  assert.ok(/out\.bandCount = bandsSeen\.size;/.test(HOME));
  assert.ok(/out\.polygonCount = ringCount;/.test(HOME));
  assert.ok(/\(bandsSeen\.size >= 3\)/.test(HOME),
    'the minimum-data bar has to be three distinct bands, not three rings');
  assert.ok(/geoMeta\.bathymetryPolygonCount = depthStats\.polygonCount;/.test(HOME));
});

test('the plan prompt prints a mean as a mean', () => {
  const inputs = codeOnly(INPUTS);
  assert.ok(/put\('Average depth', id\.averageDepthFt, ' ft'\);/.test(inputs),
    'the hedge went with the flag that justified it');
  assert.ok(!/at least \$\{id\.averageDepthFt\}/.test(inputs));
});
