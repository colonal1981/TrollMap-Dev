// `near[]` GREW EVERY TIME THE PIPELINE RAN, AND THE PLANNER SCORES ONCE PER ENTRY.
//
// build_water_features.py annotated each trolling run with the points, coves and creek mouths it
// passes — and it read the existing list first: `near = pr.get("near") or []`, then appended. Its
// `seen2` set only deduped what the CURRENT run was adding, so it could never catch a mark written
// by a previous run. Every rebuild added another full copy.
//
// Found by rebuilding Wateree twice and hashing the file. 15,921 marks -> 20,580 in one rerun,
// +29%, with exact duplicates inside a single run going 4,669 -> 9,328. Before the fix Wateree's
// three owned kinds each read exactly 66.7% duplicate — three copies, because the pack had been
// built three times. After: point 11,316 -> 3,772, cove 2,619 -> 873, creek_mouth 42 -> 14, each
// exactly a third, and every other kind untouched to the mark.
//
// CARD-WIDE, 631 packs and 2,620,437 runs carrying 7,904,456 marks:
//
//     marks of the three owned kinds   3,835,081  (48.5%)
//     exact duplicates, owned kinds    1,340,305  (17.0% of ALL marks, 34.9% of owned)
//     exact duplicates, other kinds      186,967  (2.37% — different features, same rounded
//                                                  distance; not this bug)
//     packs over 1% phantom                  196  of 585, worst at 66.7%
//
// `near_counts` tracks the inflated total exactly and is what reaches the model as `passes`, while
// scoreWindow() scores once per entry in `near` — so a leg's rank grew with the number of times the
// pipeline had been run over it, and no two packs had been run the same number of times.
//
// CLEARING THE WHOLE LIST WOULD HAVE BEEN THE WORSE BUG. `near` has two producers:
// build_trolling_runs.py writes humps, ledges, timber, hazards, obstructions and attractors, and
// this script adds its three afterwards. Wateree run #0 carries five kinds this script never makes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = readFileSync(path.join(REPO, 'Scripts/build_water_features.py'), 'utf8');
// Evidence lives once: a comment in this repo has satisfied a test about the code it described.
const CODE = PY.replace(/^\s*#.*$/gm, '').replace(/"""[\s\S]*?"""/g, '');

describe('build_water_features.py — the annotation is idempotent', () => {
  test('near[] is rebuilt for the kinds this script owns, and only those', () => {
    assert.match(CODE, /near = \[e for e in \(pr\.get\('near'\) or \[\]\) if e\.get\('t'\) not in OWNED_MARKS\]/,
      'the near[] rebuild changed. It must DROP the owned kinds and KEEP every other producer\'s '
      + 'marks — appending re-inflates it every run, and clearing it deletes humps, ledges, '
      + 'timber, hazards, obstructions and attractors with nothing to put them back');
    assert.match(CODE, /OWNED_MARKS = frozenset\(\('point', 'cove', 'creek_mouth'\)\)/,
      'OWNED_MARKS changed — it must be exactly what points_and_coves() and the creek-mouth '
      + 'pairing emit as `kind`, or this script either leaves its own duplicates behind or '
      + 'deletes somebody else\'s marks');
  });

  test('the two depths are named by which is deeper, not by which way the probe went', () => {
    // A point's vertex is its tip, so beyond it is open water. A cove's vertex is its BACK, so
    // beyond it is dry land and the deep side is the one back toward the mouth. Before this, all
    // 65,277 coves on the card had the two swapped — median "deep side" 0 ft, i.e. land.
    assert.match(CODE, /deep, shal = \(do, di\) if do > di else \(di, do\)/,
      'the deep/shallow choice is back to probe direction, which is wrong on every cove');
    assert.match(CODE, /'deep_side_ft': round\(deep, 1\), 'shallow_side_ft': round\(shal, 1\)/,
      'the fields are no longer written from the sorted pair');
  });

  test('a creek mouth inherits the cove it is placed on', () => {
    // It is placed at the paired cove's own vertex — the back of the cove, a median 111 m inland
    // of the water a boat passes — and was built with none of the cove's numbers. `cove_m` is a
    // different thing: how far the creek's NAME was from the cove it was matched to.
    assert.match(CODE, /'bulge_m': best\.get\('bulge_m'\)/, 'creek mouths no longer carry the cove\'s reach');
    assert.match(CODE, /'deep_side_ft': best\.get\('deep_side_ft'\)/, 'creek mouths lost the cove\'s depths');
  });

  test('a code change is visible to the pack stamp', () => {
    // is_current() compares input mtimes and FEAT_PARAMS and can see neither the swap nor the
    // append. Without this, the day those were fixed a plain run reported every pack up to date.
    assert.match(CODE, /RULES_VERSION = \d+/, 'build_water_features.py no longer declares a RULES_VERSION');
    assert.match(CODE, /FEAT_PARAMS = \(RULES_VERSION,/,
      'RULES_VERSION is not in FEAT_PARAMS, so the stamp cannot tell that the code moved and a '
      + 'rebuild would silently skip every pack');
  });

  test('a pack file is backed up and replaced atomically', () => {
    // It used to open the live file for writing and json.dump straight into it — no copy, no temp.
    // An interruption left a truncated trolling_runs.geojson, 7 MB on Wateree, with nothing to
    // restore. build_river_centrelines.py has done this correctly since it was written.
    assert.match(CODE, /tmp = path \+ '\.tmp'/, 'the atomic write is gone');
    assert.match(CODE, /os\.replace\(tmp, path\)/, 'the atomic rename is gone');
    assert.match(CODE, /shutil\.copy2\(path, os\.path\.join\(dest, os\.path\.basename\(path\)\)\)/,
      'the backup before overwrite is gone');
    assert.equal(/with open\(os\.path\.join\(pack, 'water_features\.geojson'\), 'w'/.test(CODE), false,
      'water_features.geojson is being written straight over the live file again');
    assert.equal(/with open\(runs_p, 'w'/.test(CODE), false,
      'trolling_runs.geojson is being written straight over the live file again');
  });
});
