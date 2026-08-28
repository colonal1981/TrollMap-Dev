// SC'S SEASONS BLOCK, AND THE CLOSURE THAT MUST NOT SHUT A LAKE.
//
// Page 20 of the SC book carries the area closures -- the per-species windows are in the ruled
// tables, but `All watercraft and fishing are prohibited Nov. 1 through Feb. 28 on Cantey Bay,
// Black Bottom and Savannah Branch in Lake Marion` is only here, and so is the one that made
// this test necessary:
//
//   Hatchery WMA on Lake Moultrie is closed to fishing each Saturday until 12:00 noon
//
// That sentence matches closures_in()'s undated branch exactly -- `closed to fishing` plus the
// word closed, no dates -- so it typed as Lake Moultrie, all fishing, PERMANENTLY SHUT. A
// planner refusing every trip to Moultrie on a Saturday-morning rule is the failure direction
// that costs a day on the water.
//
// These assert the shape of what the builder writes, which is what the Worker serves and
// closuresFor() reads. The builder is Python; this is the contract its output has to keep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(path.join(REPO, 'Scripts/build_regulations_table.py'), 'utf8');

test('an area closure shuts the arm, not the lake', () => {
  // SUPERSEDES the original rule here, which forced every repeating closure to `unknown` so it
  // could not gate a lake. That was the right instinct and the wrong scope. Ryan: "i disagree
  // that we cant express that... hatchery is a boat launch... i mean they are waters... but they
  // have boat ramps at them". These sentences shut Cantey Bay, the Hatchery WMA, Potato Creek --
  // named arms of a lake that is otherwise open, each of them somewhere a person launches.
  //
  // Scoped to the WATER there were only two answers and both were wrong: shut Lake Moultrie,
  // which is absurd, or file it unknown and warn about a lake nobody closed. Scoped to the AREA
  // it is what the book says and it can never gate the water.
  assert.match(SRC, /RECURRING = re\.compile/);
  assert.match(SRC, /each\|every\|weekly\|daily/);
  assert.match(SRC, /def area_closed\(text\)/);
  const block = SRC.slice(SRC.indexOf("area = row.get('area')"));
  assert.match(block.slice(0, 3000), /c\['applies_to'\] = 'area'/);
  assert.match(block.slice(0, 3000), /c\['area'\] = area/);
  // With no area to name, the old guard still stands -- unknown rather than shutting a water.
  assert.match(block.slice(0, 3000), /c\['effect'\], c\['applies_to'\] = 'unknown', 'unknown'/);
});

test('what cannot be expressed is the dates, and it says so', () => {
  // `each Saturday until noon` and `one week prior to the Federal Waterfowl Season` are not date
  // ranges. The record keeps its start and end but marks them untrustworthy, rather than the
  // whole closure being thrown away as unreadable.
  const block = SRC.slice(SRC.indexOf("area = row.get('area')"));
  assert.match(block.slice(0, 3000), /c\['dates_not_expressible'\] = True/);
  assert.match(block.slice(0, 3000), /cannot be trusted/);
});

test('a closed arm names the ramp somebody would have launched from', () => {
  // Lake Moultrie has a ramp called Hatchery in registry/_dnr_ramps_sc.json, which is the
  // closure's own subject. Better to name it than to let somebody drive there and find out.
  assert.match(SRC, /def ramps_named\(area, slug, ramps\)/);
  assert.match(SRC, /def load_ramps\(registry, name_map\)/);
  assert.match(SRC, /c\['ramps_closed'\] = rr/);
});

test('the sentence is carried once, not repeated across cells', () => {
  // Carrying it in three cells made closures_in() read it three times and Lake Marion's area
  // closure arrived in triplicate.
  assert.match(SRC, /'cells': \[text, None, ''\], 'species': None,\s*\n\s*'season': True/);
});

test('a water named inside a sentence is matched on its WHOLE registry name', () => {
  // Not substring matching, which this project ruled out. Two words minimum and word bounds,
  // so a single distinctive token like `Marion` is never matched on its own.
  const fn = SRC.slice(SRC.indexOf('def waters_named_in'));
  assert.match(fn.slice(0, 1600), /len\(name\.split\(\)\) < 2/);
  assert.ok(fn.slice(0, 1600).includes("r'\\b%s\\b'"),
    'the name is matched on word boundaries, not as a substring');
  assert.match(fn.slice(0, 1600), /state not in \(row\.get\('state'\) or ''\)/);
});
