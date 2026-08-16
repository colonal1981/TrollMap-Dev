// The agency profile tables are keyed by the AGENCY's name for the lake, not by ours.
//
// Ryan, 2026-08-16: "the agency pages for georgia should fix it... that was why they were
// added in... is it a name mismatch... not in aliases or what?"
//
// It is a name mismatch, and the alias was already there:
//
//     parseLakeBaseName("J. Strom Thurmond Reservoir (Lincoln Co, GA/SC)")  ->  "j. strom thurmond"
//     the GADNR_LAKE_PAGES key                                             ->  "clarks hill"
//
// Georgia calls it Clarks Hill. legacy_display_names has carried
// "Clarks Hill / Thurmond, SC/GA" all along, and a lookup keyed on one derived name could
// never reach it — which is why Thurmond's run reported "0 seeds" on every agent while a
// GADNR page for the lake sat in the table.
//
// Table keys below are verbatim from discover.js; alias sets are verbatim from lake_index.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchWaterName, reportTokens } from '../Worker/reports.js';
import { parseLakeBaseName } from '../Worker/research/keys.js';

// The lookup discover.js performs, in one place so the behaviour can be pinned.
function agencyTableHit(table, waterNames, baseLower, baseName) {
  let best = null;
  for (const key of Object.keys(table)) {
    const matched = matchWaterName(key, waterNames, { sourceMayBeBroader: false });
    if (!matched) continue;
    const kt = reportTokens(key); const wt = reportTokens(matched);
    let overlap = 0;
    for (const t of kt) if (wt.has(t)) overlap += 1;
    if (!best || overlap > best.overlap) best = { key, url: table[key], matched, overlap };
  }
  return best || (table[baseLower] ? { key: baseLower, url: table[baseLower], matched: baseName, overlap: 0 } : null);
}

// A slice of the real GADNR table — keys exactly as discover.js spells them.
const GADNR = {
  'allatoona': 'r2/allatoona.html', 'burton': 'r2/burton.html',
  'clarks hill': 'r2/clarks-hill.html', 'hartwell': 'r2/hartwell.html',
  'jackson': 'r2/jackson.html', 'lanier': 'r2/lanier.html',
  'oconee': 'r2/oconee.html', 'russell': 'r2/russell.html',
  'seed': 'r2/seed.html', 'walter f george': 'r2/walter-f-george.html',
  'west point': 'r2/west-point.html', 'yonah': 'r2/yonah.html',
};
const TWRA = {
  'boone': 'r2/boone.html', 'cherokee': 'r2/cherokee.html',
  'fort loudoun': 'r2/fort-loudoun.html', 'norris': 'r2/norris.html',
};

const names = (display, ...legacy) => [display.replace(/\s*\([^)]*\)/, ''), display, ...legacy];
const lookup = (table, display, ...legacy) => agencyTableHit(
  table, names(display, ...legacy),
  parseLakeBaseName(display).toLowerCase(), parseLakeBaseName(display));

test('Thurmond reaches the Clarks Hill page through its legacy name', () => {
  const hit = lookup(GADNR, 'J. Strom Thurmond Reservoir (Lincoln Co, GA/SC)',
    'J. Strom Thurmond Reservoir, GA/SC', 'Clarks Hill / Thurmond, SC/GA');
  assert.equal(hit.key, 'clarks hill');
  assert.equal(hit.url, 'r2/clarks-hill.html');
  assert.equal(hit.matched, 'Clarks Hill / Thurmond, SC/GA');
});

test('and the derived name alone still cannot — this is the bug, pinned', () => {
  assert.equal(parseLakeBaseName('J. Strom Thurmond Reservoir (Lincoln Co, GA/SC)').toLowerCase(),
    'j. strom thurmond');
  assert.equal(GADNR['j. strom thurmond'], undefined);
});

test('the lakes that already worked still work', () => {
  assert.equal(lookup(GADNR, 'Hartwell Lake (Anderson Co, SC/GA)', 'Lake Hartwell, SC/GA').key, 'hartwell');
  assert.equal(lookup(TWRA, 'Fort Loudoun Lake (Knox Co, TN)', 'Fort Loudoun Lake, TN').key, 'fort loudoun');
  assert.equal(lookup(TWRA, 'Norris Lake (Union Co, TN)').key, 'norris');
});

test('an agency short name inside a longer registry name resolves', () => {
  // GADNR says "russell"; the registry says "Richard B Russell Lake".
  assert.equal(lookup(GADNR, 'Richard B Russell Lake (Abbeville Co, SC/GA)', 'Lake Russell, SC/GA').key, 'russell');
});

test('a table key may not be BROADER than the lake — George does not get Walter F George', () => {
  assert.equal(lookup(GADNR, 'George Lake (Bibb Co, GA)'), null);
  // and the real one still resolves
  assert.equal(lookup(GADNR, 'Walter F George Reservoir (Clay Co, GA)').key, 'walter f george');
});

test('a lake the agency does not publish gets nothing, not the nearest key', () => {
  assert.equal(lookup(GADNR, 'Tobesofkee Lake (Bibb Co, GA)'), null);
  assert.equal(lookup(TWRA, 'Calderwood Lake (Monroe Co, TN)'), null);
});
