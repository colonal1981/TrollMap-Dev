/**
 * test/the-bench-would-not-hand-me-the-plan.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-09-14: "can i get json and html export buttons on the bench... that way i do not have
 * to copy and paste the whole json to you?"
 *
 * Two files, one run. The JSON is the WHOLE run — the prompt as sent, the model's raw answer, the
 * args the app built, the assembled plan, every warning — for when something is wrong and nobody
 * knows which side of the seam it is on. The HTML is the PAGE, drawn plan included, to open and
 * read.
 *
 * The rule both must keep: neither is a second renderer. The HTML is copied out of the live
 * document with the live document's own stylesheets, so a file that showed something different
 * from the screen would be a bench that tests itself — the exact failure plan-bench.js was written
 * to avoid.
 *
 *   node --test test/the-bench-would-not-hand-me-the-plan.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchJson, benchReportPlan, wrapReport } from '../js/utils/bench-export.js';

const RUN = {
  request: { system: 'You are TrollMap Smart Plan', user: 'THE DAY\n{"launch":"06:00"}' },
  response: { legs: [{ runId: 'wateree_lake#362', runsDepthFt: [10, 16] }] },
  args: { candidates: [{ runId: 'wateree_lake#362' }] },
  plan: { legs: [{ runId: 'wateree_lake#362', estStartTime: '06:12' }], budget: { estPlannedMin: 568 } },
  problems: ['56% of the day is deadheading'],
};
const INPUTS = { lakeName: 'Lake Wateree, SC', rampName: 'Clearwater Cove', dateStr: '2026-09-14',
                 launchTime: '06:00', returnTime: '15:00', species: ['Striped Bass'] };

// ── THE JSON ───────────────────────────────────────────────────────────────────────────────────
test('the JSON carries every side of the run, not just the plan', () => {
  const o = JSON.parse(benchJson(RUN, 'bench', INPUTS));
  assert.equal(o.request.user, RUN.request.user, 'the prompt byte for byte, not a reading of it');
  assert.equal(o.request.system, RUN.request.system);
  assert.deepEqual(o.response, RUN.response);
  assert.deepEqual(o.args, RUN.args);
  assert.deepEqual(o.plan, RUN.plan);
  assert.deepEqual(o.warnings, RUN.problems);
  assert.deepEqual(o.inputs, INPUTS, 'which water, which ramp, which hours');
});

test('it says which kind of run it was, because a dry run sent nothing', () => {
  assert.match(JSON.parse(benchJson(RUN, 'bench', INPUTS)).mode, /sent to the model/);
  assert.match(JSON.parse(benchJson(RUN, 'dry', INPUTS)).mode, /nothing sent/);
});

test('it carries the standing line', () => {
  assert.match(JSON.parse(benchJson(RUN, 'bench', INPUTS)).note,
    /not for distribution or resale; not for navigation/);
});

test('an empty run still produces a readable file rather than throwing', () => {
  const o = JSON.parse(benchJson(null, 'dry', null));
  assert.equal(o.plan, null);
  assert.deepEqual(o.warnings, []);
});

// ── THE REPORT OBJECT ──────────────────────────────────────────────────────────────────────────
//
// The Plan tab half and the plan half, and which one wins where.
const FORM = {
  meta: { name: 'Lake Wateree – Clearwater AM Troll', date: '2026-09-14', ramp: 'Clearwater Cove',
          launchTime: '06:00', returnTime: '15:00', poolLevel: '222.3' },
  trolling: { speed: '2.0' },
  tackle: 'six rods', safety: 'PFD', notes: 'muddy',
  // What collectPlan() read off a PREVIOUS real plan, which this run did not describe.
  plan: { legs: [{ id: 'OLD' }] },
  timeline: [{ type: 'troll', label: 'OLD' }],
  spread: [{ rod: 'OLD' }],
  castRods: [{ rod: 'OLD' }],
  rationale: 'yesterday',
  gpx: { tracks: 9, trackList: [{ name: 'L1 · someone else' }] },
  model: { request: 'yesterday' },
};
const SHOWN = {
  timeline: [{ type: 'troll', label: 'L1', step: 1 }],
  cards: [{ key: 'ph1out', label: 'Leg 1', speedMph: 2.0 }],
  routeRods: { ph1out: [{ rod: 'R3', lure: 'Squarebill Crankbait', notes: 'port' }] },
  routeSpeeds: { ph1out: 2.0 },
  castRods: [{ rod: 'R6', lure: 'Dr.Fish Diamond Jig / Jigging Spoon 1oz' }],
  rationale: 'today',
};
const BENCH = { plan: { planVersion: 2, legs: [{ id: 'L1' }], budget: { estPlannedMin: 1093 },
                        warnings: ['assembler only'] },
                problems: ['assembler only', 'over budget', 'not water-routed'],
                shown: SHOWN };
const spreadRowsFrom = (cards, routeRods) => (cards || []).flatMap(
  (c) => (routeRods?.[c.key] || []).map((r) => ({ ...r, speedMph: c.speedMph })));

test('the Plan tab half is kept — the bench runs off that same form', () => {
  const p = benchReportPlan(BENCH, FORM, spreadRowsFrom);
  assert.equal(p.meta.ramp, 'Clearwater Cove');
  assert.equal(p.meta.poolLevel, '222.3');
  assert.equal(p.tackle, 'six rods');
  assert.equal(p.trolling.speed, '2.0');
});

test('the plan half is replaced, because collectPlan cannot see a bench run', () => {
  const p = benchReportPlan(BENCH, FORM, spreadRowsFrom);
  assert.deepEqual(p.plan.legs, [{ id: 'L1' }], 'this run, not the last real one');
  assert.deepEqual(p.timeline, SHOWN.timeline);
  assert.deepEqual(p.unifiedTimeline, SHOWN.timeline, 'both names, same array');
  assert.deepEqual(p.castRods, SHOWN.castRods);
  assert.equal(p.rationale, 'today');
});

test('the spread is built from what was drawn and never read off state.SPREAD', () => {
  const p = benchReportPlan(BENCH, FORM, spreadRowsFrom);
  assert.equal(p.spread.length, 1);
  assert.equal(p.spread[0].rod, 'R3');
  assert.equal(p.spread[0].speedMph, 2.0);
});

test('the warnings are the union the bench shows, not the assembler third', () => {
  const p = benchReportPlan(BENCH, FORM, spreadRowsFrom);
  assert.equal(p.plan.warnings.length, 3);
  assert.ok(p.plan.warnings.includes('over budget'));
});

test('another day geometry is emptied, never carried', () => {
  const p = benchReportPlan(BENCH, FORM, spreadRowsFrom);
  assert.equal(p.gpx, null, 'state.DATA.tracks belong to whatever was last materialised');
  assert.equal(p.model, null, 'the request and the answer are in the JSON export, in full');
});

test('the document says on its face that it is a bench run', () => {
  const p = benchReportPlan(BENCH, FORM, spreadRowsFrom);
  assert.match(p.meta.name, /BENCH \(not saved, not sent\)/);
  assert.match(p.meta.name, /Lake Wateree/, 'and still says which day it is');
});

test('a run that was never drawn still produces a shaped object rather than throwing', () => {
  const p = benchReportPlan({ plan: { legs: [] } }, FORM, spreadRowsFrom);
  assert.deepEqual(p.spread, []);
  assert.equal(p.timeline, null);
  assert.equal(p.rationale, '');
});

test('no form at all is survivable too', () => {
  const p = benchReportPlan(BENCH, null, spreadRowsFrom);
  assert.match(p.meta.name, /Fishing Plan — BENCH/);
});

// ── THE WRAPPER ────────────────────────────────────────────────────────────────────────────────
test('the wrapper matches the Plan tab export byte for byte in shape', () => {
  const h = wrapReport('<div class="report-page">x</div>', 'Lake Wateree');
  assert.match(h, /^<!DOCTYPE html><html><head><meta charset="utf-8"><title>Lake Wateree<\/title>/);
  assert.match(h, /background:#f3f6f9;margin:0;padding:20px/);
  assert.match(h, /<div class="report-page">x<\/div><\/body><\/html>$/);
});

test('a title with markup in it cannot break out of the tag', () => {
  assert.match(wrapReport('x', 'A <script>alert(1)</script> day'),
    /<title>A &lt;script&gt;alert\(1\)&lt;\/script&gt; day<\/title>/);
});
