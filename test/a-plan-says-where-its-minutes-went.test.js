// Personal use only, not for distribution or resale; not for navigation.
//
// A PLAN SAYS WHERE ITS MINUTES WENT, AND A RE-ASK DOES NOT PLAN THE DAY TWICE.
//
// Ryan, 2026-10-02: "the next thing i want to look at is how long it takes for claude to build the
// plan... it is taking anywhere from 8-13 minutes now to run a plan", and then his bridge log:
//
//   17:27:36  asking sonnet: 194 + 98351 characters
//   17:39:00  answered by claude-sonnet-5 in 683.8 s, 41539 in / 62212 out
//   17:39:00  asking sonnet: 194 + 98821 characters
//   17:48:49  answered by claude-sonnet-5 in 588.9 s, 41735 in / 51104 out
//
// One plan, two asks: the second is the planner's re-ask after a bait rule was broken, and it asked
// for the whole plan again. He chose to time the app's own steps and to make the re-ask cheaper.
//
//   node --test test/a-plan-says-where-its-minutes-went.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stepTimer, timingNote, isModelStep, fmtDuration, ANSWER_STEP } from '../js/utils/step-timer.js';
import { claudeFirstAsker } from '../js/modules/claude-bridge.js';
import { correctedRequest, RE_ASK_EFFORT, withRodsFrom } from '../js/modules/plan-prompt.js';

const read = (...p) => readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// His 17:27 plan, on a clock the test controls: the app's steps around two asks.
function hisPlan() {
  let t = 0;
  const T = stepTimer(() => t);
  const at = (s, step) => { t = s * 1000; T.mark(step); };
  at(0, 'Checking the regulations…');
  at(3, 'Checking the forecast…');
  at(5, 'Reading the guide reports…');
  at(46, 'Reading the pack…');
  at(58, 'Asking the model…');
  at(58.2, 'Asking Claude (sonnet) on this PC…');
  at(742, ANSWER_STEP);
  at(743, 'Asking the model…');
  at(743.1, 'Asking Claude (sonnet, low effort) on this PC…');
  at(1332, ANSWER_STEP);
  at(1334, 'Checking the other landings…');
  t = 1350 * 1000;
  return T.report();
}

test('each step lasts until the next one is announced', () => {
  const r = hisPlan();
  assert.equal(r.totalMs, 1350000);
  assert.equal(r.steps.reduce((a, s) => a + s.ms, 0), r.totalMs);
  assert.deepEqual(r.steps.find((s) => s.step === 'Reading the guide reports…'), { step: 'Reading the guide reports…', ms: 41000 });
});

test('the model is the asker\'s own steps, and the answers count the asks', () => {
  assert.equal(isModelStep('Asking Claude (sonnet) on this PC…'), true);
  assert.equal(isModelStep('Claude on this PC failed: HTTP 502 — asking Gemini.'), true);
  assert.equal(isModelStep('Asking the model…'), false);      // the health check, the app's
  assert.equal(isModelStep(ANSWER_STEP), false);
  const note = timingNote(hisPlan());
  assert.match(note, /^this plan took 22 min 30 s: the model 21 min 13 s over 2 answers, the app 1 min 17 s/);
  assert.match(note, /Reading the guide reports 41 s/);
  assert.match(note, /Reading the answer 3 s/, 'summed under one name');
  assert.equal(fmtDuration(604000), '10 min 4 s');
  assert.equal(timingNote(null), null);
});

const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const CLAUDE_BODY = { choices: [{ finish_reason: 'stop', message: { content: '{"legs":[]}' } }],
  model: 'claude-sonnet-5', usage: {}, _trollmap: { provider: 'claude (this PC)', seconds: 60, effort: 'low' } };

test('the asker sends the effort it was handed, says it, and marks the answer', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/health')) return json({ ok: true, model: 'sonnet', claude: true });
    sent.push(JSON.parse(init.body));
    return json(CLAUDE_BODY);
  };
  const said = [];
  const ask = claudeFirstAsker(async () => ({ content: '' }), { fetchImpl, say: (m) => said.push(m) });
  const out = await ask({ system: 's', user: 'u', effort: 'low' });
  assert.deepEqual(sent[0], { system: 's', user: 'u', effort: 'low' });
  assert.equal(out.meta.effort, 'low');
  assert.deepEqual(said, ['Asking Claude (sonnet, low effort) on this PC…', ANSWER_STEP]);
  await ask({ system: 's', user: 'u' });
  assert.deepEqual(sent[1], { system: 's', user: 'u' }, 'no effort named, none sent');
  assert.doesNotMatch(code(read('js', 'modules', 'claude-bridge.js')), /a minute or two/);
});

test('the re-ask carries the answer it corrects, is built from the first prompt, and asks low', () => {
  const r = correctedRequest('sys', 'PLAN THE DAY', '{"legs":[1]}', 'R1 is a CAST-ONLY bait.');
  assert.equal(r.system, 'sys');
  assert.equal(r.effort, RE_ASK_EFFORT);
  assert.equal(RE_ASK_EFFORT, 'low');
  assert.ok(r.user.startsWith('PLAN THE DAY\n\nYOUR ANSWER, AS YOU SENT IT:\n{"legs":[1]}'));
  assert.match(r.user, /THAT ANSWER BROKE A RULE AND IS COMING BACK TO YOU\.\nR1 is a CAST-ONLY bait\./);
  assert.match(r.user, /changed only where it has to be/);
  // Both of Smart Plan's re-asks start from the prompt the day was first asked with.
  const sp = code(read('js', 'modules', 'smart-plan-v2.js'));
  assert.equal((sp.match(/correctedRequest\(req\.system, asked, raw\.content,/g) || []).length, 2);
  assert.ok(sp.indexOf('const asked = req.user;') < sp.indexOf('correctedRequest(req.system, asked'));
  assert.match(code(read('js', 'modules', 'plan-from-water.js')),
    /correctedRequest\(req\.system, req\.user, answer\.content,/);
});

test('both planners mark the clock on their own status line and keep the report', () => {
  const sp = code(read('js', 'modules', 'smart-plan-v2-wiring.js'));
  assert.match(sp, /const timer = stepTimer\(\);\s*const say = \(msg, bad\) => \{\s*timer\.mark\(msg\);/);
  const rep = sp.indexOf('r.timings = timer.report();');
  assert.ok(rep > 0 && rep < sp.indexOf("say(r.problems[0] || 'No plan', true);"),
    'before the no-plan branch, so a failed build carries it too');
  const pw = code(read('js', 'modules', 'plan-water-ui.js'));
  assert.match(pw, /const timer = stepTimer\(\);\s*const say = \(m, bad\) => \{\s*timer\.mark\(m\);/);
  assert.match(pw, /r\.timings = timer\.report\(\);/);
  const pb = code(read('js', 'modules', 'plan-builder.js'));
  assert.match(pb, /timings: r\.timings \|\| null,/);
  assert.match(pb, /timings: \(m && m\.timings\) \|\| null,/);
});

test('a re-ask can change the rods and nothing else', () => {
  // 2026-10-02, the Moultrie request asked from scratch at low effort: the safety warning came back
  // empty. A low-effort re-ask is told to keep everything else; this is what holds it to that.
  const first = { safety: { isGo: true, warning: '5 Danger marks' }, notes: { scoutNotes: 'troll' },
    stops: [{ spotId: 'a' }], changes: [],
    loadout: { rods: [{ id: 'R1', lure: 'Creature Bait / Craw' }] },
    legs: [{ runId: 'x#1', speedMph: 1.6, trollPasses: 2, deploy: { port: 'R1', starboard: 'R2' } },
           { runId: 'x#2', speedMph: 1.8, deploy: { port: 'R3', starboard: 'R4' } }] };
  const second = { safety: { isGo: true, warning: '' }, notes: { scoutNotes: '' }, stops: [],
    changes: [{ at: 'x#2' }],
    loadout: { rods: [{ id: 'R1', lure: 'Swimbait 5in – Jighead' }] },
    legs: [{ runId: 'x#1', speedMph: 2, trollPasses: 1, deploy: { port: 'R2', starboard: 'R1' } },
           { runId: 'x#9', deploy: { port: 'R5', starboard: 'R6' } }] };
  const r = withRodsFrom(first, second);
  assert.deepEqual(r.safety, first.safety);
  assert.deepEqual(r.notes, first.notes);
  assert.deepEqual(r.stops, first.stops);
  assert.deepEqual(r.loadout, second.loadout);
  assert.deepEqual(r.changes, second.changes);
  assert.deepEqual(r.legs.map((l) => l.runId), ['x#1', 'x#2'], 'its own legs, not the second answer\'s');
  assert.deepEqual(r.legs[0], { runId: 'x#1', speedMph: 1.6, trollPasses: 2, deploy: { port: 'R2', starboard: 'R1' } });
  assert.deepEqual(r.legs[1], first.legs[1]);
  assert.equal(withRodsFrom(first, null), first);
  for (const f of ['smart-plan-v2.js', 'plan-from-water.js']) {
    assert.match(code(read('js', 'modules', f)), /withRodsFrom\(res, parsePlanResponse\(/, f);
  }
});
