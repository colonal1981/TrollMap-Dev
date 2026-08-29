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

test('an area closure is not carried at all, and says so on the way out', () => {
  // SUPERSEDES the rule that put these on the card. Scoping them to the ARM rather than the lake
  // was right about the book and wrong about the app: the mechanism that made an area
  // expressible was naming the ramps inside it, and that cannot work where the only access is
  // not public -- which is what Potato Creek turned out to be.
  //
  // Both sentences that reach this branch are waterfowl management. Ryan, on the Marion one:
  // "this is a partial closure for waterfowl management... why is it here". On the Moultrie one:
  // "this is for hunting... dont go get shot... that is what this rule says". So they are dropped
  // at the SOURCE -- the report reads the built file directly, so withholding them in the Worker
  // alone left them on his screen after he had already said to remove them.
  assert.match(SRC, /RECURRING = re\.compile/);
  assert.match(SRC, /each\|every\|weekly\|daily/);
  assert.match(SRC, /def area_closed\(text\)/);
  const block = SRC.slice(SRC.indexOf("area = row.get('area')"));
  assert.ok(!/c\['applies_to'\] = 'area'/.test(block.slice(0, 4000)),
    'no closure is emitted with an area scope any more');
  // NOT SILENTLY. A dropped record that nothing counts is how a rule goes missing.
  assert.match(block.slice(0, 4000), /doc\.setdefault\('area_scoped_dropped', \[\]\)\.append\(/);
  assert.match(block.slice(0, 4000), /continue/);
  // With no area to name, the old guard still stands -- unknown rather than shutting a water.
  assert.match(block.slice(0, 4000), /c\['effect'\], c\['applies_to'\] = 'unknown', 'unknown'/);
});

test('the sentence is kept even though the closure is not', () => {
  // The row still carries the book's words in `cells`; only the closure record goes. A parse
  // that forgets what it read cannot be re-decided later.
  const block = SRC.slice(SRC.indexOf("area = row.get('area')"));
  assert.match(block.slice(0, 4000), /'text': c\.get\('text'\)/);
  assert.match(block.slice(0, 4000), /'area': area/);
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
