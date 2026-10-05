// EVERY FIELD A CATCH CARRIES IS SHOWN TO HIM OR SENT TO THE PLAN -- or it is named here as neither.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 10/4, on being told the journal had the weather at the hour of 239 of his 426 catches and nothing
// that plans read it: "these type of things need to be included in the checks for things we gather that
// nothing uses... everything in this app is either supposed to be shown to me to help me plan or shown to
// smartplan to help it plan... if it doesn't do either and should then it needs to be fixed... if it
// doesn't do either and doesn't add to them then it shouldn't be gathered in the first place". The rule
// is WHERE_A_FIELD_GOES_IS_DECIDED_BY_WHO_ACTS_ON_IT (8/25) and THE_RESEARCH_PROFILE_EXISTS_TO_FEED_ONE_
// PROMPT (9/02); data-reaches-the-app.test.js checks layers and routes, and nothing checked the fields
// of a catch. This does: the record approveQueueItem() saves is read off catch-journal.js, and a field
// added to it without a destination here turns this red.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { catchSupport, catchWhen, historyForModel } from '../js/modules/plan-candidates.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const journal = read('../js/modules/catch-journal.js');
const candidates = read('../js/modules/plan-candidates.js');

// The saved record: the top-level keys of `const entry = { ... };` in approveQueueItem().
function savedFields() {
  const start = journal.indexOf('const entry = {', journal.indexOf('async function approveQueueItem'));
  let depth = 0, i = journal.indexOf('{', start), body = '';
  for (; i < journal.length; i++) {
    const ch = journal[i];
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    body += ch;
    if (depth === 0) break;
  }
  const keys = new Set();
  let d = 0;
  for (const line of body.slice(1, -1).split('\n')) {
    const t = line.replace(/\/\/.*$/, '');
    // `key: value`, and the shorthand `key,` (sourceFile is written that way)
    if (d === 0) for (const m of t.matchAll(/(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::|,|$)/g)) keys.add(m[1]);
    for (const ch of t) { if (ch === '{' || ch === '[') d++; if (ch === '}' || ch === ']') d--; }
  }
  return keys;
}

const fnBody = (src, name) => {
  const i = src.indexOf(`export function ${name}(`);
  const j = src.indexOf('\n}\n', i);
  return src.slice(i, j);
};

// SENT TO THE PLAN: read by catchWhen() / catchSupport() into each leg's `yourHistory`, or by the loop.
const TO_THE_PLAN = ['species', 'lat', 'lon', 'date', 'time', 'length', 'lure', 'depth', 'depthSource',
                     'waterTempF', 'weather'];
// SHOWN TO HIM, and where.
const SHOWN = {
  lake: 'the journal card, and which water a pin is filed under on the map (catch-plot.js)',
  notes: 'the journal card and the pin',
  sourceFile: 'the journal card, and the photo it came from on re-import (journal-merge.js)',
  verification: 'the journal card says how the length was measured',
  structure: "the depth text on the card and the pin: how far off the contour a looked-up depth was (catch-depth.js)",
  waypoint: 'garmin-marks.js: a mark he dropped at a catch is not asked about again',
};
// NEITHER: gathered and read by nothing that plans or shows. Empty since 2026-10-05, when the four that
// stood here stopped being gathered (Ryan: "Catch fields that aren't used and shouldn't be used should
// disappear if they do not help the app"). A new field with no destination goes HERE only as a line
// someone has to justify -- and then either gets wired or is not gathered.
const NEITHER = {};
// No longer gathered on a confirmed catch. Catches saved before may still carry them; nothing reads them.
const NOT_GATHERED = ['importedFrom', 'sourcePath', 'data_generation', 'trollmap_tags'];

test('every field the journal saves on a catch has a destination', () => {
  const fields = savedFields();
  assert.ok(fields.size >= 15, [...fields].join(','));   // the parser found the record
  const known = new Set([...TO_THE_PLAN, ...Object.keys(SHOWN), ...Object.keys(NEITHER)]);
  const unclassified = [...fields].filter((f) => !known.has(f));
  assert.deepEqual(unclassified, [], `a catch field with no destination: ${unclassified.join(', ')}`);
  const gone = [...known].filter((f) => !fields.has(f));
  assert.deepEqual(gone, [], `listed here but no longer saved: ${gone.join(', ')}`);
});

test('the fields sent to the plan are read where the plan reads a catch', () => {
  const when = fnBody(candidates, 'catchWhen'), support = fnBody(candidates, 'catchSupport');
  for (const f of TO_THE_PLAN) {
    assert.ok(when.includes(`c.${f}`) || support.includes(`c.${f}`), `nothing that plans reads c.${f}`);
  }
  // every part of the weather then
  for (const w of ['tempF', 'cloudPct', 'windMph', 'windDir', 'pressureHpa', 'moonPhase']) {
    assert.ok(when.includes(`w.${w}`), `catchWhen() drops weather.${w}`);
  }
  // and it reaches the model on both planners' legs, and the prompt says what to do with it
  assert.ok(read('../js/modules/plan-from-water.js').includes('yourHistory: historyForModel(l.support),'));
  assert.ok(candidates.includes('yourHistory: historyForModel(c.support, c.markSupport),'));
  assert.match(read('../js/modules/plan-prompt.js'), /HIS OWN FISH ON A LEG, AND THE WEATHER THEY CAME IN[\s\S]*thisSpeciesWhen[\s\S]*SET THEM AGAINST TODAY/);
  // and the loop's own build hands the legs his whole records
  assert.ok(read('../js/modules/plan-water-ui.js').includes('catches: catchesOnThisWater(),'));
});

test('a leg past his fish tells the model when he caught each one and the weather then', () => {
  const line = [[-79.99, 33.25], [-79.98, 33.25]];
  const c = { species: 'Striped Bass', lat: '33.2502', lon: '-79.985', date: '2025-01-25', time: '12:58 PM',
              length: '24', lure: 'A-Rig Heavy', depth: '31', depthSource: 'sounder_at_waypoint', waterTempF: 49.1,
              weather: { tempF: 44.4, cloudPct: 0, windMph: 1.3, windDir: 310, pressureHpa: 1031, moonPhase: 'Waning Crescent' } };
  const other = { species: 'Largemouth Bass', lat: '33.2501', lon: '-79.986', date: '2024-06-01' };
  const s = catchSupport(line, [c, other], { species: ['Striped Bass'], month: 1 });
  const h = historyForModel(s);
  assert.equal(h.catchesWithin300m, 2);
  assert.deepEqual(h.thisSpeciesWhen, [{
    date: '2025-01-25', time: '12:58 PM', lengthIn: 24, lure: 'A-Rig Heavy', depthFt: 31,
    depthFrom: 'his sounder at the bite', waterF: 49.1,
    then: { airF: 44.4, cloudPct: 0, windMph: 1.3, windFromDeg: 310, pressureHpa: 1031, moon: 'Waning Crescent' },
  }]);
  assert.deepEqual(h.lures, { 'A-Rig Heavy': 1 });
  // a catch with nothing but a date says only that
  assert.deepEqual(catchWhen({ date: '2024-12-22', time: '1:15 PM', lure: '', weather: null }), { date: '2024-12-22', time: '1:15 PM' });
  // and its pin shows the same weather to him
  assert.match(read('../js/modules/catch-plot.js'), /\$\{weatherThen\(c\)\}/);
});

test('the lead is not gathered', () => {
  // Ryan, 10/4: "stop gathering it unless you know an exact way to know how much line is in the water".
  // Nothing ever filled it; the pin printed "Lead: — ft" on every catch.
  assert.ok(!savedFields().has('lead'));
  assert.doesNotMatch(read('../js/modules/catch-plot.js'), /c\.lead\b/);
  assert.doesNotMatch(journal, /lead: c\.lead/);
});

test('a field nothing reads is not gathered', () => {
  // Ryan, 10/5: "Catch fields that aren't used and shouldn't be used should disappear if they do not help
  // the app". The four that sat in NEITHER, and every part of `verification` but the length the card shows.
  const fields = savedFields();
  for (const f of NOT_GATHERED) assert.ok(!fields.has(f), `${f} is still saved on a catch`);
  const entry = journal.slice(journal.indexOf('const entry = {', journal.indexOf('async function approveQueueItem')));
  assert.match(entry, /verification: \{ length: q\.verified\.length \? 'human-visual' : 'ai-unverified' \},/);
  for (const sub of ['reviewed', 'onBoard', 'sourceModel', 'approvedAt', 'length_source', 'board_detected', 'data_quality']) {
    assert.doesNotMatch(entry.slice(0, entry.indexOf('};')), new RegExp(`\\b${sub}:`), `verification.${sub} is still saved`);
  }
  // the journal's CSV export carries none of them, and a manual catch is not stamped
  const csv = journal.slice(journal.indexOf('function exportJournalCsv('), journal.indexOf('function renderAnalytics('));
  for (const f of ['sourcePath', 'importedFrom', 'speciesVerification']) assert.doesNotMatch(csv, new RegExp(`\\b${f}\\b`));
  assert.doesNotMatch(journal.slice(journal.indexOf('async function addManualCatch(')), /^[^\n]*importedFrom: 'manual'/);
  // and nothing that plans or shows reads them -- so a catch saved before that still carries them is inert
  const all = fs.readdirSync(new URL('../js/modules/', import.meta.url))
    .filter((f) => f.endsWith('.js') && f !== 'catch-journal.js')
    .map((f) => read(`../js/modules/${f}`)).join('\n');
  for (const f of ['importedFrom', 'data_generation', 'trollmap_tags']) {
    assert.ok(!new RegExp(`\\.${f}\\b`).test(all), `${f} is read somewhere now`);
  }
});
