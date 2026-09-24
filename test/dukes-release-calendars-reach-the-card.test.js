// Personal use only, not for distribution or resale; not for navigation.
//
// DUKE'S RELEASE CALENDARS REACH THE CARD.
//
// /calendar-v2 is where Duke publishes its recreation release schedules as PDFs -- the Nantahala,
// the Tuckasegee, Tillery's boating times, Walters, the Catawba-Wateree Stage 2 message -- beside
// the USGS gauges those releases are read on. It was read on 2026-09-24 and nothing in the app
// used it (register: duke-calendar-v2-unfetched). A water now gets its location's calendars when
// the registry bound it to one of the gauges Duke names there: evidence, not name matching.
//
//   node --test test/dukes-release-calendars-reach-the-card.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDukeCalendar } from '../Worker/worker-data.js';
import { dukeCalendarFor, usgsSitesFor } from '../Worker/conditions.js';
import { readConditions } from '../js/utils/water-conditions.js';

// Ryan's capture of the live endpoint, 2026-09-23: the body arrives as a JSON string in an envelope.
const CAPTURE = JSON.parse(readFileSync(new URL('./fixtures/operators/duke-calendar-v2.2026-09-23.json',
  import.meta.url), 'utf8'));

test('the wrapped capture is read: every row, the PDF flagged, the gauge site pulled out', () => {
  const rows = parseDukeCalendar(CAPTURE);
  assert.equal(rows.length, 4);
  const pdf = rows.filter((r) => r.isPdf);
  assert.deepEqual(pdf.map((r) => r.name), ['Recommended Boating Times Recreation Calendar 2026']);
  assert.equal(pdf[0].locationId, 3);
  assert.match(pdf[0].url, /^https:\/\/lakes\.hydro-derived\.duke-energy\.app\/recreation_calendar\//);
  assert.deepEqual(rows.filter((r) => r.usgsSite).map((r) => r.usgsSite).sort(),
    ['02126375', '02147801', '02148000']);
});

test('the bare shape the browser showed is read the same way, and junk is null', () => {
  const inner = JSON.parse(CAPTURE.body);
  assert.equal(parseDukeCalendar(inner).length, 4);
  assert.equal(parseDukeCalendar(inner.calendar).length, 4);
  assert.equal(parseDukeCalendar({ body: 'not json' }), null);
  assert.equal(parseDukeCalendar({ nothing: [] }), null);
});

const ROWS = [
  { locationId: 3, name: 'Tillery 2026 Recreation Calendar FINAL-R1', url: 'https://x/t.pdf', isPdf: true, published: '2026-07-30T13:28:55' },
  { locationId: 3, name: 'Pee Dee River Map Recreation Calendar 2026', url: 'https://x/m.pdf', isPdf: true, published: '2026-09-14T23:27:11' },
  { locationId: 3, name: 'USGS Flow Gage, Pee Dee River at Hwy 731 Below Tillery near Norwood, NC', url: 'https://waterdata.usgs.gov/monitoring-location/USGS-0212378405/', isPdf: false, usgsSite: '0212378405' },
  { locationId: 1, name: 'CW Stage 2 Recreation Release Update Message', url: 'https://x/cw.pdf', isPdf: true, published: '2026-05-01T11:34:31' },
  { locationId: 1, name: 'USGS Flow Gage Wateree Hydro', url: 'https://waterdata.usgs.gov/monitoring-location/USGS-02147801/', isPdf: false, usgsSite: '02147801' },
];

test('a water bound to a gauge Duke names gets that location\'s calendars, newest first', () => {
  const peeDee = { gauges: [{ usgs_site: '0212378405', name: 'PEE DEE RIVER AT HWY 731 BELOW TILLERY' }] };
  const c = dukeCalendarFor(ROWS, usgsSitesFor(peeDee).map((s) => s.site));
  assert.deepEqual(c.calendars.map((k) => k.name),
    ['Pee Dee River Map Recreation Calendar 2026', 'Tillery 2026 Recreation Calendar FINAL-R1']);
  assert.equal(c.calendars[0].published, '2026-09-14');
  assert.deepEqual(c.location_ids, [3]);
  assert.equal(c.matched_on[0].usgs_site, '0212378405');
  assert.ok(!c.calendars.some((k) => /CW Stage 2/.test(k.name)), 'another location\'s PDFs stay there');
});

test('a tailwater gauge counts: Lake Wateree is bound to the gauge below its own dam', () => {
  const wateree = { tailwater: { usgs_site: '02147801', name: 'WATEREE RIVER BELOW WATEREE HYDRO' } };
  const c = dukeCalendarFor(ROWS, usgsSitesFor(wateree).map((s) => s.site));
  assert.deepEqual(c.calendars.map((k) => k.name), ['CW Stage 2 Recreation Release Update Message']);
});

test('a water Duke names no gauge on gets nothing, not a guess', () => {
  const hartwell = { pool: { usgs_site: '02187010', name: 'HARTWELL LAKE NEAR HARTWELL' } };
  assert.equal(dukeCalendarFor(ROWS, usgsSitesFor(hartwell).map((s) => s.site)), null);
  assert.equal(dukeCalendarFor(null, ['02147801']), null);
});

test('the app reads them off the wire and the card links them', () => {
  const c = readConditions({ ok: true, water: { duke_calendar: {
    calendars: [{ name: 'Tillery 2026 Recreation Calendar FINAL-R1', url: 'https://x/t.pdf', published: '2026-07-30' }],
    matched_on: [{ usgs_site: '0212378405', name: 'USGS Flow Gage, Pee Dee River at Hwy 731' }] } } });
  assert.equal(c.dukeCalendars.length, 1);
  assert.equal(c.dukeCalendarMatchedOn[0].usgs_site, '0212378405');
  assert.deepEqual(readConditions({ ok: true, water: {} }).dukeCalendars, []);
  const card = readFileSync(new URL('../js/modules/conditions-strip.js', import.meta.url), 'utf8');
  assert.match(card, /c\.dukeCalendars\.slice\(0, 8\)\.map/);
  assert.match(card, /target="_blank" rel="noopener">\$\{esc\(k\.name\)\}<\/a>/);
});
