// EVERY FISH ID GOES TO CLAUDE ON THIS PC FIRST, AND GEMINI WHEN IT IS NOT THERE.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-08, after the Gemini ID called his rig shots at 0007 "on the board": "what AI did
// you use... it should be using Claude Opus 5.5 same as what i am talking to you on and you can tell
// the difference lol", "if its not then use the same route that smartplan now uses for the plans",
// and, asked whether that was every fish or only a mark with several, "All fish to claude".
//
// The same day's 7 photos went to claude_fish_sorter.py's questions on Opus 5.5 on his PC: the two
// rig shots and the deck shot were not on the board, the other four were four fish. These hold the
// app to asking those questions, through the plan bridge's /look, and to reading the answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeLook, CLAUDE_BRIDGE_URL } from '../js/modules/claude-bridge.js';
import { SORT_PX, MEASURE_PX, jsonOf, sortPrompt, photoLabel, boardsOf, measurePrompt, aiFromMeasure }
  from '../js/utils/claude-fish-id.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SPECIES = ['Striped Bass', 'White Bass / Hybrid', 'Largemouth Bass', 'Other Fish'];
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

// Opus 5.5's sort of the 10/08 photos, as it answered on his PC (trimmed to what is read)
const SORTED_1008 = {
  photos: [
    { i: 1, fish: true, board: false, lure_shot: true, what: 'Striper hanging from blue umbrella rig, another striper on deck' },
    { i: 2, fish: true, board: false, lure_shot: false, what: 'Three stripers lying on kayak deck, rig beside them' },
    { i: 3, fish: true, board: true, what: 'Striper on bump board, two more fish on deck behind' },
    { i: 4, fish: true, board: true, what: 'Second striper on bump board, one fish left on deck' },
    { i: 5, fish: true, board: true, what: 'Third striper on bump board, deck now empty' },
  ],
};

test('photos go to the bridge as one simple request, and the answer is its text and who wrote it', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return json(200, { text: '{"species":"Striped Bass"}', _trollmap: { model: 'claude-opus-5-5', seconds: 12.1 } });
  };
  const out = await claudeLook('measure it', [{ label: 'Photo A (the board shot)', data: '/9j/AA' }], { fetchImpl });
  assert.equal(calls[0].url, `${CLAUDE_BRIDGE_URL}/look`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers, undefined, 'no Content-Type, so the browser sends no preflight');
  assert.deepEqual(JSON.parse(calls[0].init.body), { prompt: 'measure it', images: [{ label: 'Photo A (the board shot)', data: '/9j/AA' }] });
  assert.deepEqual(out, { text: '{"species":"Striped Bass"}', model: 'claude-opus-5-5', seconds: 12.1 });
});

test('a usage limit comes back as one, and any other failure as an error', async () => {
  const limit = async () => json(502, { error: "claude: You've hit your weekly limit", usageLimit: true });
  await assert.rejects(claudeLook('p', [{ data: 'x' }], { fetchImpl: limit }), (e) => e.usageLimit === true);
  const down = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(claudeLook('p', [{ data: 'x' }], { fetchImpl: down }), /Failed to fetch/);
});

test('the sort asks for every photo and the fish among them, and a rig shot is not a board shot', () => {
  const p = sortPrompt(5, '2026-10-08', SPECIES);
  assert.match(p, /These are 5 photos/);
  assert.match(p, /after one waypoint he marked at a bite/);
  assert.match(p, /not a board shot, even with the board somewhere in the frame/);
  assert.ok(p.includes(JSON.stringify(SPECIES)));
  assert.equal(photoLabel(3, '15:03:37'), 'Photo 3 -- 15:03:37');
  assert.deepEqual([...boardsOf(SORTED_1008, 5)], [3, 4, 5]);
});

test('a board answer out of range, or with no fish, is not a board shot', () => {
  const a = { photos: [{ i: 0, board: true }, { i: 6, board: true }, { i: 2, fish: false, board: true },
                       { i: 3, board: 'yes' }, { i: 4, fish: true, board: true }] };
  assert.deepEqual([...boardsOf(a, 5)], [4]);
  assert.deepEqual([...boardsOf(null, 5)], []);
});

test('the measure asks for the species off his list and the length off the board, to the quarter inch', () => {
  const p = measurePrompt({ day: '2026-10-08', time: '16:23', lat: 33.5446078, lon: -80.2197326, species: SPECIES });
  assert.match(p, /caught on 2026-10-08 at 16:23 near 33\.54461, -80\.21973/);
  assert.match(p, /nearest 0\.25 inch/);
  assert.ok(p.includes(JSON.stringify(SPECIES)));
  assert.doesNotMatch(measurePrompt({ day: 'd', time: 't', lat: null, lon: null, species: SPECIES }), / near /);
});

test('the answer comes into review in the shape the Gemini ID used, saying it was Claude', () => {
  const ai = aiFromMeasure(jsonOf('Here it is: {"species": "Striped Bass", "length_in": 21.0, "confidence": "medium", '
    + '"how_read": "tail at the 21 mark", "problems": ["tail slightly curled"]}'), 'claude-opus-5-5', SPECIES);
  assert.equal(ai.species, 'Striped Bass');
  assert.equal(ai.lengthInches, 21);
  assert.equal(ai.confidence, 'medium');
  assert.equal(ai.on_bump_board, true);
  assert.equal(ai.model, 'Claude claude-opus-5-5 (this PC)');
  assert.match(ai.notes, /tail at the 21 mark/);
  assert.match(ai.notes, /tail slightly curled/);
});

test('a species off the list comes in as Other Fish, named in the notes; no length is no length', () => {
  const ai = aiFromMeasure({ species: 'Hybrid Striper', length_in: null }, null, SPECIES);
  assert.equal(ai.species, 'Other Fish');
  assert.match(ai.notes, /"Hybrid Striper"/);
  assert.equal(ai.lengthInches, null);
  assert.equal(ai.confidence, 'low');
  assert.throws(() => jsonOf('no json here'), /no JSON object/);
});

test('the sizes are the sorter\'s', () => {
  const sorter = src('Scripts/claude_fish_sorter.py');
  assert.match(sorter, new RegExp(`SORT_PX = ${SORT_PX}\\b`));
  assert.match(sorter, new RegExp(`MEASURE_PX = ${MEASURE_PX}\\b`));
});

test('the nightly upload asks Claude first for every catch, and Gemini only when Claude did not answer', () => {
  const journal = src('js/modules/catch-journal.js');
  const start = journal.indexOf('async function handleNightlyPhotoUpload(');
  const drop = journal.slice(start, journal.indexOf('\n}\n', start));
  assert.ok(drop.includes('await claudeBridgeStatus()'));
  const iClaude = drop.indexOf('ai = await claudeMeasure(board');
  const iGemini = drop.indexOf('if (!ai) try {');
  assert.ok(iClaude > 0 && iGemini > iClaude, 'Claude, then Gemini only if there is no answer');
  assert.ok(drop.includes("claudeWhy = \"Claude's usage limit is reached\""), 'a usage limit stops the asking');
  // the model that answered is on the row, not a fixed Gemini name
  assert.ok(drop.includes("model: ai.model || 'Gemini 2.5-flash v13 (SC trolling taxonomy)'"));
});

test('the bridge has the photo route the app calls', () => {
  const bridge = src('Scripts/claude_plan_bridge.py');
  assert.ok(bridge.includes('if path not in ("/ask", "/look"):'));
  assert.ok(bridge.includes('"--input-format", "stream-json"'));
});
