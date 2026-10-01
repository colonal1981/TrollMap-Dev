// A loaded plan arms its trip alerts.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Item 20. The trip watch has been one per fishing day since 2026-09-26, so building the next trip
// no longer moves the alerts off this one. What was left: a plan brought back from Saved Plans or a
// JSON file drew its legs and armed nothing, and said "The phone's trip alerts are armed only when a
// plan is built." The file holds what the alerts read -- each leg's line as a track, each stop as
// a timeline entry -- and alertsFromSaved() puts them back on the legs.
//
// What these hold:
//   1. each leg gets its own line back, in [lon, lat], and each stop its position and leg;
//   2. the launch is the plan's own first point;
//   3. a day that has gone by, or a file with no plan, arms nothing and says why;
//   4. the cue list loadSessionFromPlan() walks finds the stop on its leg;
//   5. restorePlanView() arms it, the way the build path does, and no longer says it cannot.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from './expect-shim.mjs';
import assert from 'node:assert/strict';
import { alertsFromSaved } from '../js/modules/saved-plan-alerts.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');

// The shape collectPlan() writes, cut down to one transit, one leg with a stop, and the run home.
const RAMP = [34.3793, -80.7288];                         // [lat, lon], as a track carries it
const FILE = {
  meta: { date: '2026-10-03', lake: 'Lake Wateree, SC', returnTime: '12:00' },
  plan: {
    meta: { slug: 'wateree_lake', water: 'Lake Wateree, SC', date: '2026-10-03', returnTime: '12:00' },
    legs: [
      { id: 'T1', type: 'transit', startM: 0, lengthM: 400 },
      { id: 'L1', type: 'troll', startM: 400, lengthM: 1000, stopIds: ['S1.1'] },
      { id: 'T2', type: 'transit', role: 'return', startM: 1400, lengthM: 500 },
    ],
    changes: [],
  },
  unifiedTimeline: [
    { type: 'troll', legId: 'L1' },
    { type: 'stop_and_cast', id: 'S1.1', parentLegId: 'L1', atLegM: 400, lat: 34.3810, lon: -80.7240,
      name: 'point', targetDepth: 19 },
  ],
  gpx: { trackList: [
    { name: 'T1 · transit', pts: [RAMP, [34.3800, -80.7260]] },
    { name: 'L1 · 2-12ft', pts: [[34.3800, -80.7260], [34.3810, -80.7240], [34.3820, -80.7200]] },
    { name: 'T2 · home', pts: [[34.3820, -80.7200], RAMP] },
  ] },
};
const BEFORE = new Date('2026-10-01T10:14:00');

describe('the saved file holds what the alerts read', () => {
  it('puts each leg\'s line back on it, in [lon, lat]', () => {
    const a = alertsFromSaved(FILE, BEFORE);
    assert.ok(a.plan, a.why);
    const l1 = a.plan.legs.find((l) => l.id === 'L1');
    assert.deepEqual(l1.coordinates[0], [-80.7260, 34.3800]);
    assert.equal(a.positions, 3);
  });

  it('and each stop its position, its leg and how far into the leg it is', () => {
    const l1 = alertsFromSaved(FILE, BEFORE).plan.legs.find((l) => l.id === 'L1');
    assert.deepEqual(l1.stops, [{ id: 'S1.1', at: [-80.7240, 34.3810], atM: 400, structure: 'point',
                                   depthFt: 19 }]);
  });

  it('launches from the plan\'s own first point', () => {
    const a = alertsFromSaved(FILE, BEFORE);
    assert.deepEqual(a.launch, { lat: RAMP[0], lon: RAMP[1] });
    assert.equal(a.date, '2026-10-03');
    assert.equal(a.returnTime, '12:00');
    assert.equal(a.slug, 'wateree_lake');
  });

  it('arms the day itself, and nothing for a day that has gone by', () => {
    assert.ok(alertsFromSaved(FILE, new Date('2026-10-03T05:00:00')).plan);
    const gone = alertsFromSaved(FILE, new Date('2026-10-04T05:00:00'));
    assert.equal(gone.plan, null);
    assert.match(gone.why, /2026-10-03 has gone by/);
  });

  it('says why when the file cannot arm anything', () => {
    assert.match(alertsFromSaved({ meta: { date: '2026-10-03' } }, BEFORE).why, /no plan block/);
    assert.match(alertsFromSaved({ ...FILE, meta: {}, plan: { ...FILE.plan, meta: {} } }, BEFORE).why,
      /no date/);
    assert.match(alertsFromSaved({ ...FILE, gpx: { trackList: [] } }, BEFORE).why, /no line/);
  });
});

describe('the restored plan becomes cues', () => {
  it('planCues() -- what loadSessionFromPlan() walks -- finds the stop, on its leg', async () => {
    // notifications.js itself wires to `document` as it loads, so the cue list it walks is checked
    // here; it places a stop cue at the stop's own `at`, which the test above puts back.
    const { planCues } = await import('../js/modules/plan-assemble.js');
    const cues = planCues(alertsFromSaved(FILE, BEFORE).plan);
    const stop = cues.find((c) => c.kind === 'stop');
    assert.deepEqual([stop.legId, stop.ref, stop.atM], ['L1', 'S1.1', 800]);
  });
});

describe('loading a saved plan arms it', () => {
  const pb = src('js/modules/plan-builder.js');
  const restore = pb.slice(pb.indexOf('function restorePlanView('), pb.indexOf('function armSavedPlan('));
  const arm = pb.slice(pb.indexOf('function armSavedPlan('), pb.indexOf('\n}\n', pb.indexOf('function armSavedPlan(')));

  it('restorePlanView() calls it, and no longer says alerts arm only on a build', () => {
    assert.match(restore, /armSavedPlan\(p\)/);
    assert.doesNotMatch(pb, /are armed only when a plan is built/);
  });

  it('with the call the build path makes: the worker, the launch, the date and the solunar', () => {
    assert.match(arm, /loadSessionFromPlan\(a\.plan, \{/);
    for (const k of ['worker: CF_WORKER_URL', 'launch: a.launch', 'date: a.date', 'solunar: sol',
                     'returnTime: a.returnTime']) assert.ok(arm.includes(k), k);
  });

  it('and says what it did', () => {
    assert.match(arm, /Trip alerts re-armed for/);
    assert.match(arm, /Trip alerts not armed: \$\{a\.why\}/);
  });
});
