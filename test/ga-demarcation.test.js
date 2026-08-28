// GEORGIA'S SALTWATER DEMARCATION LINE -- the page that defines a word two tables already use.
//
// GA's freshwater striped bass rule ends `...and from saltwater`, and its saltwater table
// carries a separate `Striped bass (Saltwater)` row at 22 inches. Neither page says where
// saltwater starts. Page 22 does, in three clauses that do NOT mean the same thing:
//
//   1. ten rivers that turn salt where U.S. 17 crosses them, and the Savannah where
//      Georgia Highway 25 / South Carolina 170 does
//   2. seven streams that are salt end to end
//   3. a DIFFERENT line -- the Seaboard Coastline Railroad and I-95 -- for crab pots only
//
// Flattening those together moves the boundary by miles on the two rivers named in more than
// one of them, which is why the clause and what it governs are carried on every record.
//
// The page also broke two things that had been quietly wrong:
//
//   * `Little Satilla River` contains `Satilla River` on clean word boundaries. The name
//     matcher bound the tail, so the Satilla we ship came out salt for its entire length --
//     which the book says about the Little Satilla and never about the Satilla.
//   * the bullet grid found two columns of three, because one of the three holds a single
//     bullet, and the crop then cut the first clause in half: four rivers read, six lost.
//
// These assert the shape of what the builder writes. The builder is Python; this is the
// contract its output has to keep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(path.join(REPO, 'Scripts/build_regulations_table.py'), 'utf8');

test('the crab line is read as its own clause, not merged into the finfish line', () => {
  // Three clauses, declared, and the crab test sits ABOVE the loose one -- the crabbing bullet
  // also contains `seaward of the points at which`, so a looser test placed first would file
  // GA's crab line as the finfish line.
  const block = SRC.slice(SRC.indexOf('DEMARC_CLAUSE = ['),
                          SRC.indexOf('CROSSING = re.compile'));
  const crab = block.indexOf("'crabbing only'");
  const entire = block.indexOf("'salt for its entire length'");
  const seaward = block.indexOf("'salt seaward of a named crossing'");
  assert.ok(crab > -1 && entire > -1 && seaward > -1, 'all three clauses are named');
  assert.ok(crab < entire && crab < seaward, 'the crabbing test is tried first');
  // And a record says what it governs, so nothing reads a crab-pot boundary as a finfish one.
  assert.match(SRC, /'governs'\] = \('crab pots only' if row\.get\('clause'\) == 'crabbing only'/);
});

test('a demarcation record is a boundary, not a limit', () => {
  assert.match(SRC, /rec\['kind_of_rule'\] = 'where saltwater begins'/);
  assert.match(SRC, /rec\['crossings'\] = row\.get\('crossings'\) or \[\]/);
});

test('the tail of a longer river name is not that river', () => {
  // `Little Satilla River` is not the Satilla, `South Altamaha River` is not the Altamaha.
  assert.match(SRC, /def _part_of_a_longer_name\(text, at\)/);
  assert.match(SRC, /NAME_LEADERS = \{/);
  // Function words may lead a name -- `the Savannah River` at the start of a sentence must
  // still bind -- so the guard fires only on a capitalised word outside that closed class.
  const fn = SRC.slice(SRC.indexOf('def _part_of_a_longer_name'),
                       SRC.indexOf('def waters_named_in'));
  assert.match(fn, /w\[:1\]\.isupper\(\) and w\.lower\(\) not in NAME_LEADERS/);
  for (const w of ['the', 'and', 'of', 'from', 'including']) {
    assert.ok(SRC.includes(`'${w}'`), `${w} is a permitted leader`);
  }
});

test('a declared column count may promote a lone bullet, but only if the count comes out', () => {
  const fn = SRC.slice(SRC.indexOf('def column_starts'), SRC.indexOf('def column_lines'));
  assert.match(fn, /def column_starts\(pages, min_sep=120\.0, expect=None\)/);
  assert.match(fn, /starts = grid\(2\)/);
  // The fallback is conditional on producing EXACTLY the declared number -- a count that does
  // not come out is evidence the grid is wrong, not licence to use a worse one.
  assert.match(fn, /if expect and len\(starts\) != expect:[\s\S]{0,240}if len\(loose\) == expect:/);
});

test('a rule addressed to a reach says so', () => {
  // GA binds `Ocmulgee River downstream of the GA Hwy 96 bridge`; the registry has one slug for
  // the whole river. The bind is worth having -- the alternative is the rule reaching nothing --
  // but a consumer must not read it as covering every mile.
  assert.match(SRC, /REACH = re\.compile/);
  assert.match(SRC, /r\['address_is_a_reach'\] = True/);
  assert.match(SRC, /rec\['address_is_a_reach'\] = True/);
});

test("a prose row's own sentence flag is honoured, not just the table's", () => {
  // read_ga_prose already marks the bullets whose address is a sentence, and only those. The
  // table-level option would turn the treatment on for `Lake Blackshear: 14 inches` too, which
  // has a perfectly good address column.
  assert.match(SRC, /o\.get\('name_in_sentence'\) or row\.get\('named_in_a_sentence'\)/);
});

test('main() binds smap and not_law before Tennessee, which is read first', () => {
  // TN is read forty lines above the state loop and its page ledger needs both names. Bound
  // down beside the loop, they were local-before-assignment and TN's ledger threw on every run
  // since it was added -- inside a try that files the failure as a `problem`, so the book came
  // out looking like a data question rather than the line-ordering bug it was.
  const main = SRC.slice(SRC.indexOf('def main():'), SRC.indexOf('def load_index') > 0
    ? SRC.length : SRC.length);
  const bound = main.indexOf('smap = load_species_map(R(a.registry))');
  const use = main.indexOf('page_ledger(tnpdf');
  assert.ok(bound > -1 && use > -1, 'both the binding and the TN ledger call are present');
  assert.ok(bound < use, 'smap is bound before the TN page ledger reads it');
  const nl = main.indexOf('not_law = (json.load(');
  assert.ok(nl > -1 && nl < use, 'not_law is bound before the TN page ledger reads it');
});

test('statewide is bound before the first thing that writes to it', () => {
  // The TN block appends to `statewide` and the binding sat forty lines under it, which makes
  // the name local for the whole function and raises UnboundLocalError on the first TN row.
  const fn = SRC.slice(SRC.indexOf('def project_by_water'),
                       SRC.indexOf('    return by, statewide'));
  const bound = fn.indexOf('statewide = {}');
  const firstWrite = fn.indexOf("statewide.setdefault('TN'");
  assert.ok(bound > -1 && firstWrite > -1);
  assert.ok(bound < firstWrite, 'statewide is bound before the TN loop writes to it');
  assert.equal(fn.split('statewide = {}').length - 1, 1, 'bound exactly once');
});
