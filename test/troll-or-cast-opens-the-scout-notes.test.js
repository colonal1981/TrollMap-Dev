// TROLL OR CAST OPENS THE SCOUT NOTES.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Change request 19, the cheap version first. Ryan, 2026-09-25: "the way i want the app to work in
// the future is for it to actually tell me whether i should troll or cast". The research already
// records every method its sources describe (casting 672 entries, live or cut bait 440, trolling
// 171 over the game species), so the model is asked to answer from it, in the one field the plan
// tab already renders -- `notes.scoutNotes`, via plan-to-timeline.js. No schema change.
//
// And his correction on live bait: "live shad on planer boards is the live bait equivalent of
// trolling shad looking deep crankbaits". Strike the bait, keep the report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanRequest } from '../js/modules/plan-prompt.js';

const user = buildPlanRequest({
  water: 'Test Water', ramp: 'A ramp', date: '2026-09-27', launchTime: '06:00',
  returnTime: '13:00', species: ['Striped Bass'], conditions: {}, candidates: [],
}).user;

test('the return shape asks scoutNotes to open with troll, cast or both', () => {
  assert.match(user, /"scoutNotes": "FIRST one sentence: troll, cast or both today, and which reports say so/);
});

// The instruction is written as a comment line inside the return shape, so a sentence may wrap
// onto the next `// ` line; `W` is whitespace with that prefix allowed.
const W = String.raw`\s+(?:\/\/\s+)?`;

test('a live-bait report is read as trolling evidence, and live bait is never the answer on fresh water', () => {
  assert.match(user, /Live bait is never the answer on fresh water/);
  assert.match(user, new RegExp(`a${W}live-bait report is still a trolling report`));
  assert.match(user, new RegExp(`strike the bait and keep the report`));
});

test('with nothing in the research about method, the model says so', () => {
  assert.match(user, new RegExp(`Where the research says nothing${W}about method, say that instead of guessing`));
});
