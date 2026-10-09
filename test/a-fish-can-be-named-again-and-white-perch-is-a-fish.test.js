// A FISH CAN BE NAMED AGAIN, AND WHITE PERCH IS A FISH.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-09, after a perch on a jerkbait at Wyboo: "somehow we never put white perch in the
// app... i just used hybrid / white bass... there are a lot that are in there that way i think". The
// plan's species picker had White Perch; the journal's list, which the review form and Claude's fish
// ID read, did not. And of 30 fish filed as White Bass / Hybrid, 25 were white perch, stripers ("most
// of those 16-22 in fish with stripes are probably actually stripers... hybrids are fairly uncommon
// here") and one largemouth, with nothing on a journal card to change a fish's species. He said
// "sounds good" to a ✎ beside the species like the one beside the water. This pins both.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../js/modules/catch-journal.js', import.meta.url), 'utf8');
const fnBody = (name) => {
  const i = src.indexOf(`function ${name}(`);
  return src.slice(i, src.indexOf('\n}\n', i));
};

test('White Perch is on the list the review form and Claude read, and a note can name it', () => {
  const list = src.slice(src.indexOf('const SPECIES = ['), src.indexOf('];', src.indexOf('const SPECIES = [')));
  assert.match(list, /'White Bass \/ Hybrid', 'White Perch'/);
  assert.ok(src.includes("const FISH_SPECIES = () => SPECIES.filter(s => s && s !== 'Not Fish');"),
    "Claude's fish ID reads the same list");
  const infer = fnBody('inferSpeciesFromNotes');
  assert.ok(infer.indexOf("['White Perch', /\\bwhite perch\\b/]") > 0);
  assert.ok(infer.indexOf("['White Perch'") < infer.indexOf("['White Bass / Hybrid'"),
    'checked before white bass, so "white perch" is never read as a white bass');
});

test('every journal card can change the species of its fish', () => {
  assert.ok(src.includes('<button data-editspecies="${i}" class="small" title="Change the species of this fish"'));
  assert.ok(src.includes("body.querySelectorAll('[data-editspecies]').forEach((btn) => btn.addEventListener('click', () => editCatchSpecies(body, +btn.dataset.editspecies, btn)));"));
  const edit = fnBody('editCatchSpecies');
  assert.match(edit, /speciesOptions\(c\.species \|\| ''\)/, "the review form's list, with the fish's species selected");
  assert.match(edit, /c\.species = species;/);
  assert.match(edit, /await saveCatches\(\);\s*renderJournalOnly\(body\);/);
  assert.match(edit, /if \(!species \|\| species === c\.species\) \{ box\.remove\(\); btn\.disabled = false; return; \}/,
    'the same species, or none, changes nothing');
  // only the species: the length, the water and the pin are what they were
  assert.doesNotMatch(edit, /c\.(length|lake|lat|lon)\s*=/);
});
