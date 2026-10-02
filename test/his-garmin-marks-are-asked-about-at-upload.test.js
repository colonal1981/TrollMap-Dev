// Personal use only, not for distribution or resale; not for navigation.
//
// HIS GARMIN MARKS THAT ARE NOT CATCHES ARE ASKED ABOUT AT UPLOAD, KEPT, AND REACH THE PLAN.
//
// Item 40. On 9/28 on Wateree he marked 0005 at 10:13, "0005 was a bite that i didn't land", and
// 0006 was a catch. The nightly drop made 0006 a catch and dropped 0005 on the floor. Ryan,
// 2026-10-01, on how to tell them apart: "Ask me at upload". 2026-10-02: "you can build that for
// the garmin marks".
//
//   node --test test/his-garmin-marks-are-asked-about-at-upload.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { marksToAsk, markRecord, marksForPlan, markId, MARK_LABELS } from '../js/modules/garmin-marks.js';
import { marksSupport, forModel, yourMarks } from '../js/modules/plan-candidates.js';
import { readFileSync } from 'node:fs';

const LOADED = '2026-09-26T02:23:01Z';
const W = [
  // a plan put on the unit: every waypoint shares one timestamp
  { name: 'L1 start', time: LOADED, lat: 34.37, lon: -80.75 },
  { name: 'L1 end', time: LOADED, lat: 34.38, lon: -80.76 },
  // 9/28: the missed bite and the catch
  { name: '0005', time: '2026-09-28T14:13:40Z', lat: 34.378661, lon: -80.754753, depthM: 6.4, tempC: 24.1 },
  { name: '0006', time: '2026-09-28T15:02:11Z', lat: 34.3712, lon: -80.7488, depthM: 7.0 },
  // 9/27's bowfin marks, already catches in the journal from that night's drop
  { name: '0002', time: '2026-09-27T18:40:00Z', lat: 33.8, lon: -80.9 },
  // an older mark of his the unit still exports, already labelled
  { name: '0001', time: '2026-09-20T13:00:00Z', lat: 34.2, lon: -80.7 },
];

test('only his own marks with no photos, not a catch and not labelled before, are asked about', () => {
  const ask = marksToAsk(W, {
    withPhotos: [W[3]],                                   // 0006's photos were in this drop
    journal: [{ species: 'Bowfin', waypoint: { name: '0002', time: W[4].time } }],
    known: [{ id: markId(W[5]), label: 'skip' }],
  });
  assert.deepEqual(ask.map((w) => w.name), ['0005']);
});

test('newest first, so the day he just fished is at the top', () => {
  const ask = marksToAsk(W, {});
  assert.deepEqual(ask.map((w) => w.name), ['0006', '0005', '0002', '0001']);
});

test('the id is the same every time the unit exports the mark', () => {
  assert.equal(markId({ ...W[2], depthM: 99 }), markId(W[2]));
  assert.notEqual(markId(W[2]), markId(W[3]));
});

test('the record carries the sounder at the mark, and nothing it did not read', () => {
  const r = markRecord({ ...W[2], file: '28SEP26EXPORT.GPX' }, 'missed_bite', new Date('2026-10-02T12:00:00Z'));
  assert.equal(r.label, 'missed_bite');
  assert.equal(r.kind, 'garmin_mark');
  assert.equal(r.key, r.id);
  assert.equal(r.depthFt, 21);
  assert.equal(r.waterTempF, 75.4);
  assert.equal(r.lat, 34.378661);
  assert.equal(markRecord(W[3], 'fish_on_sonar').waterTempF, null, 'no temperature in the GPX is null, not 0');
  assert.equal(markRecord(W[2], 'caught'), null, 'only the four answers are kept');
  assert.deepEqual(MARK_LABELS.map((l) => l.id), ['missed_bite', 'fish_on_sonar', 'hazard', 'skip']);
});

test('skip is remembered but never reaches the plan', () => {
  const recs = [markRecord(W[2], 'missed_bite'), markRecord(W[5], 'skip'), markRecord(W[3], 'hazard')];
  assert.deepEqual(marksForPlan(recs).map((m) => m.name), ['0005', '0006']);
});

test('the plan counts them by what he said they were, in the same pocket as his catches', () => {
  // A line past 0005, about 60 m from it; 0006 is about 900 m off.
  const line = [[-80.7560, 34.3792], [-80.7530, 34.3792]];
  const marks = marksForPlan([markRecord(W[2], 'missed_bite'), markRecord(W[3], 'fish_on_sonar'),
                              markRecord(W[5], 'skip')]);
  const m = marksSupport(line, marks);
  assert.equal(m.missedBite, 1);
  assert.equal(m.fishOnSonar, 0);
  assert.equal(m.hazard, 0);
  assert.equal(m.lastMarked, '2026-09-28');
});

test('and the model reads them in yourHistory, beside the catches, only when he has marks', () => {
  const c = { runId: 'wateree_lake#48', coords: [[-80.756, 34.3792], [-80.753, 34.3792]], near: [], passes: [],
              support: { n: 0, speciesN: 0, seasonN: 0, lastDate: null, offWater: 0 } };
  assert.equal(forModel(c).yourHistory.missedBitesWithin300m, undefined);
  const h = forModel({ ...c, markSupport: { missedBite: 1, fishOnSonar: 2, hazard: 0, lastMarked: '2026-09-28', offWater: 0 } }).yourHistory;
  assert.equal(h.missedBitesWithin300m, 1);
  assert.equal(h.fishOnSonarWithin300m, 2);
  assert.equal(h.hazardsWithin300m, 0);
  assert.equal(h.catchesWithin300m, 0);
  assert.match(h.marksNote, /labelled himself/);
  assert.deepEqual(yourMarks(null), {});
});

test('the assembled plan and the sync carry them too', () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  assert.match(read('js/modules/plan-assemble.js'), /\.\.\.yourMarks\(c\.markSupport\)/);
  assert.match(read('js/modules/cloud-sync.js'), /mark: 'settings'/);
  assert.match(read('Worker/trollmap-worker.js'), /SYNC_STORES = \[[^\]]*"mark"/);
  assert.match(read('js/modules/smart-plan-v2-wiring.js'), /marks: marksForPlan\(state\.GARMIN_MARKS\)/);
});
