// The catch journal is one sync record, and a pull no longer adds it to itself.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-03, after importing his rebuilt catch history: "this is a problem" -- Catch Center
// showed 663 confirmed, "Unknown: 504". His journal export: 159 real catches and 504 rows with every
// field blank. catch-journal.js pushes the whole journal as `catch/catches`, and cloud-sync's pull
// appended each pulled copy of that record to the journal as one more catch.
//
// What these hold:
//   1. a copy of the journal inside it comes out on load, and the real catches stay as they are;
//   2. a catch that exists only inside a copy (logged elsewhere, never merged) stays, once;
//   3. copies nested in copies are walked, and a copy of the review queue adds nothing;
//   4. a corrected catch is the same catch: an older copy of it with another species does not come back;
//   5. a pull adds what the device lacks and overwrites nothing;
//   6. cloud-sync merges a pulled journal through it and no longer pushes the record into the array,
//      and the journal is repaired when it loads;
//   7. an import whose rows all went straight to the Journal opens the Journal, and an empty queue
//      says what the last import did.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flattenJournal, mergePulledJournal, isJournalRecord, catchKey } from '../js/utils/journal-merge.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, '..', f), 'utf8');

const bowfin = { species: 'Bowfin', length: '24', date: '2026-09-27', time: '2:53 PM', lat: '34.37', lon: '-80.73',
                 sourceFile: 'PXL_20260927_185501.jpg' };
const striper = { species: 'Striped Bass', length: '22', date: '2025-01-25', time: '2:33 PM', lat: '33.26', lon: '-80.01',
                  sourceFile: 'PXL_20250125_193358428.jpg' };
const handLogged = { species: 'Largemouth Bass', length: '', date: '2026-06-01', time: '7:10 AM', lat: '33.9', lon: '-80.4' };

test('1. a copy of the journal inside it comes out, and the real catches stay', () => {
  const copy = { name: 'catches', data: [bowfin, striper] };
  const r = flattenJournal([bowfin, striper, copy, copy, { name: 'catches', data: [] }]);
  assert.equal(r.catches.length, 2);
  assert.equal(r.records, 3);
  assert.equal(r.recovered, 0);
  assert.equal(r.catches[0], bowfin);
  assert.ok(isJournalRecord(copy));
  assert.ok(!isJournalRecord(bowfin));
});

test('2. a catch only inside a copy stays, once', () => {
  const r = flattenJournal([bowfin, { name: 'catches', data: [bowfin, handLogged] }, { name: 'catches', data: [handLogged] }]);
  assert.equal(r.catches.length, 2);
  assert.equal(r.recovered, 1);
  assert.deepEqual(r.catches.map((c) => c.species), ['Bowfin', 'Largemouth Bass']);
});

test('3. copies inside copies are walked; a copy of the review queue adds nothing', () => {
  const deep = { name: 'catches', data: [{ name: 'catches', data: [{ name: 'catches', data: [striper] }] }] };
  const queue = { name: 'catch_import_queue', data: [{ species: 'Crappie', date: '2023-04-16', filename: 'IMG.jpg' }] };
  const r = flattenJournal([bowfin, deep, queue]);
  assert.deepEqual(r.catches.map((c) => c.species), ['Bowfin', 'Striped Bass']);
  assert.equal(r.records, 4);
});

test('4. a corrected catch is the same catch', () => {
  const fixed = { ...handLogged, species: 'Spotted Bass' };
  const r = flattenJournal([fixed, { name: 'catches', data: [handLogged] }]);
  assert.equal(r.catches.length, 1);
  assert.equal(r.catches[0].species, 'Spotted Bass');
  assert.equal(catchKey(fixed), catchKey(handLogged));
});

test('5. a pull adds what the device lacks and overwrites nothing', () => {
  const mine = [{ ...bowfin, lure: 'Spook' }];
  const pulled = { name: 'catches', data: [{ ...bowfin, lure: '' }, striper] };
  const r = mergePulledJournal(mine, pulled);
  assert.equal(r.catches.length, 2);
  assert.equal(r.catches[0].lure, 'Spook');
  assert.equal(r.recovered, 1);
  assert.equal(mergePulledJournal(mine, handLogged).catches.length, 2);
});

test('6. cloud-sync merges a pulled journal, and the journal is repaired on load', () => {
  const sync = read('js/modules/cloud-sync.js');
  assert.match(sync, /mergePulledJournal\(cur\?\.data \|\| \[\], local\)/);
  assert.doesNotMatch(sync, /else merged2\.push\(local\)/);
  const cj = read('js/modules/catch-journal.js');
  assert.match(cj, /const fixed = flattenJournal\(r\.data \|\| \[\]\);/);
  assert.match(cj, /if \(fixed\.records \|\| fixed\.dropped\)[\s\S]{0,600}await saveCatches\(\);/);
});

test('7. an import opens the tab its rows went to; an empty queue says what the last import did', () => {
  const cj = read('js/modules/catch-journal.js');
  assert.match(cj, /currentSubtab = added \? 'review' : autoApproved \? 'journal' : 'import';/);
  assert.match(cj, /The queue is empty\. The last import/);
});
