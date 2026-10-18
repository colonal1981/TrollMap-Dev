// CLAUDE ON HIS API CREDIT ANSWERS FIRST: THE WORKER, THEN THIS PC, THEN GEMINI.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-18, of the monthly API credit his Max plan now carries: "should we use this instead
// of how we are currently doing the plans and pics?". Put to him: the Worker asks Claude first for
// a plan and for the fish photos, then the bridge on his PC, then Gemini. He put the key in the
// Worker: "its been added to worker".
//
// What these hold:
//   1. a plan and a fish go to the Worker's Claude first, with the gate's header, and say so;
//   2. a spent credit, a missing key or any other failure goes on to the bridge, then Gemini, and
//      the plan says why at each step;
//   3. the fish asking stops for the drop only when neither Claude can answer again;
//   4. the Worker asks the bridge's model in the bridge's words, at the model's own ceiling read
//      off the Models API, answers in the bridge's shape, and reads a spent credit as one;
//   5. the two routes that spend are behind the gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeFirstAsker, claudeLook, claudeStatus, CLAUDE_API_URL, CLAUDE_BRIDGE_URL }
  from '../js/modules/claude-bridge.js';
import { aiFromMeasure } from '../js/utils/claude-fish-id.js';
import { handleClaudeAsk, handleClaudeLook, handleClaudeHealth, CLAUDE_MODEL, ASK, refusalOf }
  from '../Worker/claude-api.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const REQ = { system: 'sys', user: 'plan the day' };
const json = (status, body) => ({ ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body) });

const API_BODY = {
  choices: [{ finish_reason: 'stop', message: { content: '{"from":"api"}' } }],
  model: 'claude-opus-5-5', usage: { prompt_tokens: 75000, completion_tokens: 12500, total_tokens: 87500 },
  _trollmap: { provider: 'claude (API)', model: 'claude-opus-5-5', seconds: 131.4 },
};
const PC_BODY = {
  choices: [{ finish_reason: 'stop', message: { content: '{"from":"pc"}' } }],
  model: 'claude-opus-5-5', usage: {}, _trollmap: { provider: 'claude (this PC)', model: 'claude-opus-5-5' },
};
const CREDIT_OUT = { error: 'Claude API 400: Your credit balance is too low to access the Anthropic API.', creditOut: true };

/** One fetch for both Claudes: `api` answers the Worker's routes, `pc` the bridge's. */
function routes({ api, pc }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const answer = (x) => { if (x instanceof Error) throw x; return x; };
    if (url.startsWith(CLAUDE_API_URL)) return answer(typeof api === 'function' ? api(url, init) : api);
    if (url.startsWith(CLAUDE_BRIDGE_URL)) {
      if (url.endsWith('/health')) return answer(pc.health);
      return answer(pc.ask);
    }
    throw new Error('unexpected ' + url);
  };
  return { fetchImpl, calls };
}
const gemini = () => {
  const g = async () => { g.calls++; return { content: '{"from":"gemini"}', meta: { provider: 'gemini' } }; };
  g.calls = 0;
  return g;
};
const PC_UP = { health: json(200, { ok: true, model: 'opus', claude: true }), ask: json(200, PC_BODY) };
const PC_DOWN = { health: new TypeError('Failed to fetch'), ask: new TypeError('Failed to fetch') };

test('1. a plan goes to the Worker\'s Claude first, with the gate\'s header, and says who wrote it', async () => {
  const { fetchImpl, calls } = routes({ api: json(200, API_BODY), pc: PC_UP });
  const g = gemini();
  const said = [];
  const out = await claudeFirstAsker(g, { fetchImpl, say: (m) => said.push(m) })(REQ);
  assert.equal(out.content, '{"from":"api"}');
  assert.equal(out.meta.provider, 'claude (API)');
  assert.equal(out.meta.model, 'claude-opus-5-5');
  assert.equal(out.meta.promptTokens, 75000);
  assert.equal(g.calls, 0);
  assert.equal(calls.length, 1, 'the bridge is not asked when the Worker answers');
  assert.equal(calls[0].url, `${CLAUDE_API_URL}/claude/ask`);
  assert.ok('X-Sync-Token' in calls[0].init.headers, 'the gate\'s header goes with it');
  assert.deepEqual(JSON.parse(calls[0].init.body), { system: 'sys', user: 'plan the day' });
  assert.match(said[0], /Asking Claude through the Worker/);
});

test('1. the re-ask\'s effort goes to the Worker as the bridge sends it', async () => {
  const { fetchImpl, calls } = routes({ api: json(200, API_BODY), pc: PC_UP });
  const said = [];
  await claudeFirstAsker(gemini(), { fetchImpl, say: (m) => said.push(m) })({ ...REQ, effort: 'low' });
  assert.deepEqual(JSON.parse(calls[0].init.body), { system: 'sys', user: 'plan the day', effort: 'low' });
  assert.match(said[0], /\(low effort\)/);
});

test('2. a spent credit goes on to the bridge, and the plan says why', async () => {
  const { fetchImpl } = routes({ api: json(502, CREDIT_OUT), pc: PC_UP });
  const g = gemini();
  const said = [];
  const out = await claudeFirstAsker(g, { fetchImpl, say: (m) => said.push(m) })(REQ);
  assert.equal(out.content, '{"from":"pc"}');
  assert.equal(out.meta.provider, 'claude (this PC)');
  assert.match(out.meta.claudeApi, /this month's API credit is spent/);
  assert.equal(g.calls, 0);
  assert.match(said.join(' '), /trying Claude on this PC/);
});

test('2. the Worker unreachable and the bridge closed: Gemini answers, and the plan says both', async () => {
  const { fetchImpl } = routes({ api: new TypeError('Failed to fetch'), pc: PC_DOWN });
  const g = gemini();
  const out = await claudeFirstAsker(g, { fetchImpl })(REQ);
  assert.equal(out.content, '{"from":"gemini"}');
  assert.equal(g.calls, 1);
  assert.match(out.meta.claudeApi, /Claude through the Worker failed: Failed to fetch/);
  assert.match(out.meta.claudeBridge, /not running on this PC/);
});

test('2. an empty answer from the Worker is not a plan', async () => {
  const empty = { ...API_BODY, choices: [{ message: { content: '' } }] };
  const { fetchImpl } = routes({ api: json(200, empty), pc: PC_UP });
  const out = await claudeFirstAsker(gemini(), { fetchImpl })(REQ);
  assert.equal(out.content, '{"from":"pc"}');
  assert.match(out.meta.claudeApi, /answered with nothing/);
});

test('1. a fish goes to the Worker\'s Claude first, and the review row says which Claude read it', async () => {
  const { fetchImpl, calls } = routes({
    api: json(200, { text: '{"species":"Striped Bass"}', _trollmap: { model: 'claude-opus-5-5', seconds: 9.8 } }),
    pc: PC_UP });
  const images = [{ label: 'Photo A (the board shot)', data: '/9j/AA' }];
  const out = await claudeLook('measure it', images, { fetchImpl });
  assert.deepEqual(out, { text: '{"species":"Striped Bass"}', model: 'claude-opus-5-5', seconds: 9.8, via: 'API' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${CLAUDE_API_URL}/claude/look`);
  assert.ok('X-Sync-Token' in calls[0].init.headers);
  assert.deepEqual(JSON.parse(calls[0].init.body), { prompt: 'measure it', images });
  assert.equal(aiFromMeasure({ species: 'Striped Bass' }, out.model, ['Striped Bass'], out.via).model,
               'Claude claude-opus-5-5 (API)');
});

test('2. a fish with the credit spent is read on this PC', async () => {
  const { fetchImpl } = routes({ api: json(502, CREDIT_OUT),
    pc: { health: PC_UP.health, ask: json(200, { text: '{"species":"Bowfin"}', _trollmap: { model: 'claude-opus-5-5' } }) } });
  const out = await claudeLook('p', [{ data: 'x' }], { fetchImpl });
  assert.equal(out.via, 'this PC');
  assert.equal(out.text, '{"species":"Bowfin"}');
});

test('3. the fish asking stops only when neither Claude can answer again', async () => {
  const limit = json(502, { error: "claude: You've hit your weekly limit", usageLimit: true });
  // credit spent, bridge at its limit: stop
  let r = routes({ api: json(502, CREDIT_OUT), pc: { health: PC_UP.health, ask: limit } });
  await assert.rejects(claudeLook('p', [{ data: 'x' }], { fetchImpl: r.fetchImpl }),
    (e) => e.usageLimit === true && /credit is spent/.test(e.message) && /weekly limit/.test(e.message));
  // no key on the Worker, bridge closed: stop
  r = routes({ api: json(503, { error: 'the Worker has no ANTHROPIC_API_KEY', noKey: true }), pc: PC_DOWN });
  await assert.rejects(claudeLook('p', [{ data: 'x' }], { fetchImpl: r.fetchImpl }), (e) => e.usageLimit === true);
  // the Worker failed for another reason: it may answer the next fish, so the asking goes on
  r = routes({ api: json(502, { error: 'Claude API 529: Overloaded' }), pc: { health: PC_UP.health, ask: limit } });
  await assert.rejects(claudeLook('p', [{ data: 'x' }], { fetchImpl: r.fetchImpl }), (e) => e.usageLimit === false);
});

test('3. the upload asks whether either Claude is there, the Worker\'s first', async () => {
  let r = routes({ api: json(200, { ok: true, key: true, model: 'claude-opus-5-5' }), pc: PC_DOWN });
  assert.deepEqual(await claudeStatus({ fetchImpl: r.fetchImpl }), { up: true, via: 'API', model: 'claude-opus-5-5' });
  r = routes({ api: json(200, { ok: true, key: false }), pc: PC_UP });
  assert.deepEqual(await claudeStatus({ fetchImpl: r.fetchImpl }), { up: true, via: 'this PC', model: 'opus' });
  r = routes({ api: json(200, { ok: true, key: false }), pc: PC_DOWN });
  const st = await claudeStatus({ fetchImpl: r.fetchImpl });
  assert.equal(st.up, false);
  assert.match(st.why, /no API key for Claude; Claude is not running on this PC/);
});

// ── the Worker ────────────────────────────────────────────────────────────────────────────────

const ENV = { ANTHROPIC_API_KEY: 'test-key-not-real' };
const post = (body) => new Request('https://w.test/claude/ask', { method: 'POST', body: JSON.stringify(body) });
function anthropic(answer, { maxTokens = 128000 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('/v1/models/')) return json(200, { id: CLAUDE_MODEL, max_tokens: maxTokens });
    if (url.endsWith('/v1/messages')) return answer;
    throw new Error('unexpected ' + url);
  };
  return { fetchImpl, calls };
}
const MESSAGE = {
  type: 'message', model: 'claude-opus-5-5', stop_reason: 'end_turn',
  content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: '{"legs":[]}' }],
  usage: { input_tokens: 74000, cache_read_input_tokens: 0, output_tokens: 12512 },
};

test('4. the Worker asks the bridge\'s model in the bridge\'s words, at the model\'s own ceiling', async () => {
  const { fetchImpl, calls } = anthropic(json(200, MESSAGE));
  const r = await handleClaudeAsk(post({ system: 'sys', user: 'PLAN' }), ENV, { fetchImpl });
  assert.equal(r.status, 200);
  const sent = JSON.parse(calls.find((c) => c.url.endsWith('/v1/messages')).init.body);
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.max_tokens, 128000, 'read off the Models API');
  assert.equal(sent.system, 'sys');
  assert.deepEqual(sent.messages, [{ role: 'user', content: [{ type: 'text', text: `${ASK}\n\nPLAN` }] }]);
  assert.equal(sent.output_config, undefined, 'no effort named, none sent: the model\'s own default');
  const h = calls[0].init.headers;
  assert.equal(h['x-api-key'], ENV.ANTHROPIC_API_KEY);
  assert.ok(h['anthropic-version']);
  const body = await r.json();
  assert.equal(body.choices[0].message.content, '{"legs":[]}', 'the text, not the thinking');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(body.model, 'claude-opus-5-5');
  assert.deepEqual(body.usage, { prompt_tokens: 74000, completion_tokens: 12512, total_tokens: 86512 });
  assert.equal(body._trollmap.provider, 'claude (API)');
  // the effort, when the request names one
  const b = anthropic(json(200, MESSAGE));
  await handleClaudeAsk(post({ system: 's', user: 'u', effort: 'low' }), ENV, { fetchImpl: b.fetchImpl });
  assert.deepEqual(JSON.parse(b.calls.find((c) => c.url.endsWith('/v1/messages')).init.body).output_config, { effort: 'low' });
});

test('4. the words are the bridge\'s, and its model is Opus 5.5', () => {
  const py = src('Scripts/claude_plan_bridge.py');
  assert.equal(/^ASK = "(.*)"$/m.exec(py)[1], ASK);
  assert.match(py, /^PLAN_MODEL = "opus"$/m);
  assert.equal(CLAUDE_MODEL, 'claude-opus-5-5');
});

test('4. a spent credit is read as one, and a cut-off answer says so', async () => {
  const spent = { type: 'error', error: { type: 'invalid_request_error',
    message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } };
  const { fetchImpl } = anthropic(json(400, spent));
  const r = await handleClaudeAsk(post({ user: 'u' }), ENV, { fetchImpl });
  assert.equal(r.status, 502);
  const b = await r.json();
  assert.equal(b.creditOut, true);
  assert.match(b.error, /^Claude API 400: Your credit balance is too low/);
  assert.equal(refusalOf(429, { error: { type: 'rate_limit_error', message: 'slow down' } }).creditOut, false);
  const cut = anthropic(json(200, { ...MESSAGE, stop_reason: 'max_tokens' }));
  const c = await (await handleClaudeAsk(post({ user: 'u' }), ENV, { fetchImpl: cut.fetchImpl })).json();
  assert.equal(c.choices[0].finish_reason, 'length');
});

test('4. no key is said plainly, and spends nothing', async () => {
  let asked = 0;
  const r = await handleClaudeAsk(post({ user: 'u' }), {}, { fetchImpl: async () => { asked++; } });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'the Worker has no ANTHROPIC_API_KEY', creditOut: false, noKey: true });
  assert.equal(asked, 0);
  const h = await handleClaudeHealth({}).json();
  assert.deepEqual(h, { ok: true, key: false, model: 'claude-opus-5-5' });
});

test('4. the photos go as the bridge sends them: the prompt, then each label and its photo', async () => {
  const { fetchImpl, calls } = anthropic(json(200, { ...MESSAGE, content: [{ type: 'text', text: '{"photos":[]}' }] }));
  const req = new Request('https://w.test/claude/look', { method: 'POST', body: JSON.stringify({
    prompt: 'sort them', images: [{ label: 'Photo 1 -- 15:03:37', data: 'AAA' }, { data: 'BBB' }] }) });
  const r = await handleClaudeLook(req, ENV, { fetchImpl });
  assert.equal(r.status, 200);
  const sent = JSON.parse(calls.find((c) => c.url.endsWith('/v1/messages')).init.body);
  assert.equal(sent.system, undefined);
  assert.deepEqual(sent.messages[0].content, [
    { type: 'text', text: 'sort them' },
    { type: 'text', text: 'Photo 1 -- 15:03:37' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB' } },
  ]);
  const b = await r.json();
  assert.equal(b.text, '{"photos":[]}');
  assert.equal(b._trollmap.provider, 'claude (API)');
  const bad = new Request('https://w.test/claude/look', { method: 'POST', body: JSON.stringify({ prompt: 'p', images: [{}] }) });
  assert.equal((await handleClaudeLook(bad, ENV, { fetchImpl })).status, 400);
});

test('5. the two routes that spend are behind the gate', () => {
  const w = src('Worker/trollmap-worker.js');
  const list = /const SPENDING_ROUTES = \[([\s\S]*?)\];/.exec(w)[1];
  assert.deepEqual([...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]), ['/claude/ask', '/claude/look']);
  assert.ok(w.includes('let mutating = MUTATING_ROUTES.includes(path) || SPENDING_ROUTES.includes(path);'));
  for (const r of ['/claude/health', '/claude/ask', '/claude/look']) assert.ok(w.includes(`path === "${r}"`), r);
});
