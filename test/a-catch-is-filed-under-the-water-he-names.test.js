// A CATCH IS FILED UNDER THE WATER HE NAMES.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-04: "South East Park Pond - this is a miss marking... i dont know where that is", and
// "great falls are probably mis markings too and should be wateree as i have never been on great
// falls". The import files a catch under the nearest access point's water within two miles, and the
// journal card could only delete a catch: nothing in the app could change a confirmed catch's water.
// Re-check Lakes flags a disagreement and overwrites nothing, on purpose. This pins the card's ✎.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../js/modules/catch-journal.js', import.meta.url), 'utf8');
const fnBody = (name) => {
  const i = src.indexOf(`function ${name}(`);
  return src.slice(i, src.indexOf('\n}\n', i));
};

test('every journal card can change the water its fish is filed under', () => {
  assert.ok(src.includes('<button data-editlake="${i}" class="small" title="Change the water this fish is filed under"'));
  assert.ok(src.includes("body.querySelectorAll('[data-editlake]').forEach((btn) => btn.addEventListener('click', () => editCatchWater(body, +btn.dataset.editlake, btn)));"));
  // the names offered: every registry water and every name already in his journal
  assert.ok(src.includes('<datalist id="catchWaterNames">${catchWaterNames(catches)'));
  const names = fnBody('catchWaterNames');
  assert.match(names, /c\.lake/);
  assert.match(names, /getLoadedRegistry\(\)\?\.list/);
});

test('saving sets the water he typed, answers the re-check flag, and saves the journal', () => {
  const edit = fnBody('editCatchWater');
  assert.match(edit, /c\.lake = name;/);
  assert.match(edit, /filter\(\(f\) => f !== 'lake_mismatch_on_recheck'\)/);
  assert.match(edit, /delete c\.lakeRecheckSuggestion;/);
  assert.match(edit, /await saveCatches\(\);\s*renderJournalOnly\(body\);/);
  // an empty box or the same name changes nothing
  assert.match(edit, /if \(!name \|\| name === c\.lake\) \{ box\.remove\(\); btn\.disabled = false; return; \}/);
  // and only the name: the pin is the phone's, and the map still judges it
  assert.doesNotMatch(edit, /c\.lat\s*=|c\.lon\s*=/);
});

test('Re-check Lakes still never overwrites a water already on a catch', () => {
  const recheck = src.slice(src.indexOf('async function recheckJournalLakes('), src.indexOf('function renderJournalOnly('));
  assert.match(recheck, /\} else if \(c\.lake !== spatial\.lake\) \{[\s\S]*c\.lakeRecheckSuggestion = spatial\.lake;/);
  assert.doesNotMatch(recheck.slice(recheck.indexOf('} else if (c.lake !== spatial.lake)')), /c\.lake = spatial\.lake/);
});
