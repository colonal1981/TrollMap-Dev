// HIS CATCHES GO TO THE UNIT ONE WATER AT A TIME: a waypoint per fish.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 10/4: "i want a gpx export of my catch history by body of water", then "just waypoints of each
// caught fish". What his ECHOMAP keeps of a waypoint is a 10-character name and a 20-character comment
// (plan-tracks.js, UNIT_CHARS), and it ate the period out of a name.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { catchWaters, catchesGpx, catchIsoUtc, speciesCode } from '../js/utils/catch-gpx.js';

const at = (lat, lon) => ({ lat: String(lat), lon: String(lon) });
const J = [
  { species: 'Striped Bass', length: '24.75', date: '2025-01-25', time: '2:17 PM', lake: 'Lake Moultrie, SC', ...at(33.2626, -80.0158),
    lure: 'A-Rig Heavy', depth: '31', depthSource: 'sounder_at_waypoint', waterTempF: 49.1,
    weather: { tempF: 51.3, cloudPct: 0, windMph: 1.7, windDir: 247, pressureHpa: 1029, moonPhase: 'Waning Crescent' } },
  { species: 'Striped Bass', length: '22.5', date: '2025-01-25', time: '12:58 PM', lake: 'Lake Moultrie, SC', ...at(33.2617, -80.0153) },
  // the same fish photographed twice, a second apart: one waypoint
  { species: 'Striped Bass', length: '22.5', date: '2025-01-25', time: '12:58 PM', lake: 'Lake Moultrie, SC', ...at(33.26171, -80.01531) },
  { species: 'Striped Bass', length: '19', date: '2024-12-22', time: '1:15 PM', lake: 'Lake Moultrie, SC', ...at(33.2387, -80.0039) },
  { species: 'Largemouth Bass', length: '18', date: '2025-06-01', time: '7:05 AM', lake: 'Lake Moultrie, SC', ...at(33.25, -79.99) },
  // a pin off the water, filed under Moultrie
  { species: 'Striped Bass', length: '20', date: '2024-12-30', time: '2:02 PM', lake: 'Lake Moultrie, SC', ...at(33.30, -80.10) },
  // no position: not a waypoint
  { species: 'Striped Bass', length: '26', date: '2024-12-28', time: '4:05 PM', lake: 'Lake Moultrie, SC', lat: '', lon: '' },
  { species: 'Striped Bass', length: '27', date: '2025-03-01', time: '9:00 AM', lake: 'Lake Wateree, SC', ...at(34.38, -80.73) },
];

test('the waters are listed by the fish caught on them, each fish once, with a position', () => {
  const w = catchWaters(J);
  assert.deepEqual(w.map((x) => [x.name, x.n]), [['Lake Moultrie, SC', 5], ['Lake Wateree, SC', 1]]);
  assert.ok(w.every((x) => x.key));
});

test('one waypoint per fish on the water picked, numbered in the order he caught them', () => {
  const key = catchWaters(J)[0].key;
  const r = catchesGpx(J, { key, name: 'Lake Moultrie, SC', offWater: (c) => Number(c.lat) > 33.29 });
  assert.equal(r.n, 4);
  assert.equal(r.offWater, 1);
  const names = [...r.gpx.matchAll(/<name>([^<]*)<\/name>/g)].map((m) => m[1]).slice(1);   // first is the file's
  assert.deepEqual(names, ['STR 01', 'STR 02', 'STR 03', 'LMB 01']);
  const cmts = [...r.gpx.matchAll(/<cmt>([^<]*)<\/cmt>/g)].map((m) => m[1]);
  assert.deepEqual(cmts, ['12/22/24 1:15P 19in', '1/25/25 12:58P 23in', '1/25/25 2:17P 25in', '6/1/25 7:05A 18in']);
  // what his unit keeps: ten and twenty characters, and no period in a name
  for (const n of names) { assert.ok(n.length <= 10, n); assert.ok(!n.includes('.'), n); }
  for (const c of cmts) assert.ok(c.length <= 20, c);
  // and the whole of it in the desc, for anything else that reads the file
  assert.match(r.gpx, /<desc>Striped Bass, 24\.75 in; 2025-01-25 2:17 PM; A-Rig Heavy; 31 ft \(his sounder at the bite\); water 49\.1 F; then: air 51\.3 F, 0% cloud, wind 1\.7 mph from WSW, 1029 hPa, Waning Crescent<\/desc>/);
  assert.equal((r.gpx.match(/<sym>Fish<\/sym>/g) || []).length, 4);
  // not the photo model's notes on the length
  assert.doesNotMatch(catchesGpx([{ ...J[3], notes: 'Tail tip reaches the 19' }], { key }).gpx, /Tail tip/);
  // the Wateree fish is not in Moultrie's file
  assert.doesNotMatch(r.gpx, /34\.38/);
});

test('the time on a waypoint is the moment of the catch, in UTC', () => {
  assert.equal(catchIsoUtc({ date: '2024-12-22', time: '1:15 PM' }), '2024-12-22T18:15:00Z');   // EST
  assert.equal(catchIsoUtc({ date: '2025-06-01', time: '7:05 AM' }), '2025-06-01T11:05:00Z');   // EDT
  assert.equal(catchIsoUtc({ date: '2025-06-01', time: '' }), null);
  assert.equal(speciesCode('Hybrid'), 'HYB');
  assert.equal(speciesCode('Bowfin'), 'BOW');
  assert.equal(speciesCode('Gar'), 'GAR');
});

test('the Catch Journal offers it, water by water, and leaves out a pin off the water it can read', () => {
  const src = fs.readFileSync(new URL('../js/modules/catch-journal.js', import.meta.url), 'utf8');
  assert.ok(src.includes('<select id="catchGpxWater"'));
  assert.ok(src.includes("body.querySelector('#exportCatchGpxBtn')?.addEventListener('click', () => exportCatchGpx(body));"));
  assert.ok(src.includes('offWater = (c) => pinOffItsWater(c, { key, keyOf: resolveR2Key, inside });'));
});
