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
import { benchJson, benchHtml } from '../js/utils/bench-export.js';

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

// ── THE HTML ───────────────────────────────────────────────────────────────────────────────────
//
// A document stub, not jsdom: the three things benchHtml touches are getElementById, styleSheets
// and getComputedStyle, and stubbing exactly those is what proves it touches nothing else.
function docStub({ crossOrigin = true } = {}) {
  const els = {
    benchPlanHead: { hidden: false, innerHTML: '<b>THE PLAN AS IT WOULD BE DRAWN</b>' },
    benchPlan: { innerHTML: '<div class="leg">L1 · 06:12</div>' },
    benchOut: { innerHTML: '<details class="bench-sec"><summary>THE DAY</summary>'
                         + '<pre>launch 06:00</pre></details>'
                         + '<details open class="bench-sec"><summary>WARNINGS</summary></details>' },
  };
  const sheets = [
    { cssRules: [{ cssText: ':root{--bg:#111;--text:#eee}', style: { 0: '--bg', 1: '--text',
                     length: 2, [Symbol.iterator]: function* () { yield '--bg'; yield '--text'; } } },
                 { cssText: '.bench-sec{border:1px solid var(--line)}', style: null }] },
  ];
  if (crossOrigin) {
    sheets.push({ href: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
                  get cssRules() { throw new Error('SecurityError'); } });
  }
  return {
    getElementById: (id) => els[id] || null,
    documentElement: {},
    styleSheets: sheets,
    defaultView: { getComputedStyle: () => ({ getPropertyValue: (n) => (n === '--bg' ? '#111' : '#eee') }) },
  };
}

test('the stylesheet is copied from the live document, never written out here', () => {
  const h = benchHtml('bench', INPUTS, docStub());
  assert.match(h, /\.bench-sec\{border:1px solid var\(--line\)\}/, 'the app rule, not a new one');
  assert.match(h, /--bg: #111;/, 'and the resolved custom properties, so the theme survives');
  assert.match(h, /--text: #eee;/);
});

test('a cross-origin sheet is re-linked instead of silently dropped', () => {
  const h = benchHtml('bench', INPUTS, docStub({ crossOrigin: true }));
  assert.match(h, /<link rel="stylesheet" href="https:\/\/unpkg\.com\/leaflet/);
});

test('a page with no cross-origin sheet links nothing', () => {
  assert.doesNotMatch(benchHtml('bench', INPUTS, docStub({ crossOrigin: false })), /<link rel=/);
});

test('the drawn plan and the bench output are both in the file', () => {
  const h = benchHtml('bench', INPUTS, docStub());
  assert.match(h, /THE PLAN AS IT WOULD BE DRAWN/);
  assert.match(h, /L1 · 06:12/, 'the plan as it would have been drawn');
  assert.match(h, /launch 06:00/, 'and what the model was sent');
});

test('every section is open — a file is read, not clicked through', () => {
  const h = benchHtml('bench', INPUTS, docStub());
  assert.equal(/<details(?![^>]*\bopen\b)/.test(h), false, 'no collapsed section survives');
  assert.equal((h.match(/<details open/g) || []).length, 2, 'and none is opened twice');
});

test('the header says which water, which hours, and that nothing was saved', () => {
  const h = benchHtml('bench', INPUTS, docStub());
  assert.match(h, /Lake Wateree, SC/);
  assert.match(h, /Clearwater Cove/);
  assert.match(h, /06:00–15:00/);
  assert.match(h, /Striped Bass/);
  // The source wraps this sentence across two lines, so the test reads it the way a browser
  // would rather than pinning the line break.
  assert.match(h.replace(/\s+/g, ' '),
    /Nothing in this file was saved, sent to the phone, or written to GPX/);
  assert.match(h, /not for distribution or resale; not for navigation/);
});

test('a dry run says so on the page, so a prompt is never read as a plan', () => {
  assert.match(benchHtml('dry', INPUTS, docStub()), /Dry run — the prompt only, nothing sent/);
  assert.match(benchHtml('bench', INPUTS, docStub()), /Sent to the model/);
});

test('no document, no file — and no throw', () => {
  assert.equal(benchHtml('bench', INPUTS, null), '');
});

test('it is a whole document, not a fragment', () => {
  const h = benchHtml('bench', INPUTS, docStub());
  assert.match(h, /^<!doctype html>/);
  assert.match(h, /<\/html>$/);
});
