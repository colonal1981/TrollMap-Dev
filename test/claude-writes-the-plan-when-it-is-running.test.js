// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-09-26: "i already pay for this so i might as well use it... my computer stays on and
// connected to claude". The planners ask Claude on this PC (Scripts/claude_plan_bridge.py) first,
// and Gemini whenever the bridge is not there, fails, or is at the usage limit -- and the plan says
// which one answered and, when Gemini did, why Claude did not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeFirstAsker, claudeBridgeStatus, CLAUDE_BRIDGE_URL } from '../js/modules/claude-bridge.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQ = { system: 'sys', user: 'plan the day' };
const json = (status, body) => ({ ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body) });

function bridge({ health, ask }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/health')) { if (health instanceof Error) throw health; return health; }
    if (url.endsWith('/ask')) { if (ask instanceof Error) throw ask; return ask; }
    throw new Error('unexpected ' + url);
  };
  return { fetchImpl, calls };
}
const gemini = () => {
  const g = async () => { g.calls++;
    return { content: '{"from":"gemini"}', meta: { provider: 'gemini', model: 'gemini-3.5-flash-lite' } }; };
  g.calls = 0;
  return g;
};
const CLAUDE_BODY = {
  choices: [{ finish_reason: 'stop', message: { content: '{"from":"claude"}' } }],
  model: 'claude-sonnet-5', usage: { prompt_tokens: 31000, completion_tokens: 4000, total_tokens: 35000 },
  _trollmap: { provider: 'claude (this PC)', model: 'claude-sonnet-5', seconds: 71.2 },
};

test('the bridge is running: Claude answers, Gemini is never asked, and the plan says who wrote it', async () => {
  const { fetchImpl, calls } = bridge({ health: json(200, { ok: true, model: 'sonnet', claude: true }),
                                        ask: json(200, CLAUDE_BODY) });
  const g = gemini();
  const said = [];
  const out = await claudeFirstAsker(g, { fetchImpl, say: (m) => said.push(m) })(REQ);
  assert.equal(out.content, '{"from":"claude"}');
  assert.equal(out.meta.provider, 'claude (this PC)');
  assert.equal(out.meta.model, 'claude-sonnet-5');
  assert.equal(out.meta.promptTokens, 31000);
  assert.equal(g.calls, 0);
  const sent = JSON.parse(calls.find((c) => c.url.endsWith('/ask')).init.body);
  assert.deepEqual(sent, { system: 'sys', user: 'plan the day' }, 'the same request the planner built, untouched');
  assert.match(said.join(' '), /Asking Claude \(sonnet\) on this PC/);
});

test('the bridge is not running: Gemini answers exactly as before, and the plan says why', async () => {
  const { fetchImpl } = bridge({ health: new TypeError('Failed to fetch') });
  const g = gemini();
  const said = [];
  const out = await claudeFirstAsker(g, { fetchImpl, say: (m) => said.push(m) })(REQ);
  assert.equal(out.content, '{"from":"gemini"}');
  assert.equal(out.meta.provider, 'gemini');
  assert.match(out.meta.claudeBridge, /not running on this PC/);
  assert.equal(g.calls, 1);
  assert.match(said.join(' '), /asking Gemini/);
});

test('Claude at the usage limit: Gemini answers and the plan says it was the limit', async () => {
  const { fetchImpl } = bridge({ health: json(200, { ok: true, model: 'sonnet', claude: true }),
    ask: json(502, { error: "claude: You've hit your weekly limit", usageLimit: true }) });
  const g = gemini();
  const out = await claudeFirstAsker(g, { fetchImpl })(REQ);
  assert.equal(g.calls, 1);
  assert.match(out.meta.claudeBridge, /usage limit/);
});

test('a bridge that cannot find the claude CLI is not up', async () => {
  const { fetchImpl } = bridge({ health: json(200, { ok: true, model: 'sonnet', claude: false }) });
  const st = await claudeBridgeStatus(CLAUDE_BRIDGE_URL, { fetchImpl });
  assert.equal(st.up, false);
  assert.match(st.why, /cannot find the claude CLI/);
});

test('the bridge dropping mid-answer falls back rather than failing the plan', async () => {
  const { fetchImpl } = bridge({ health: json(200, { ok: true, model: 'opus', claude: true }),
                                 ask: new TypeError('network error') });
  const g = gemini();
  const out = await claudeFirstAsker(g, { fetchImpl })(REQ);
  assert.equal(out.content, '{"from":"gemini"}');
  assert.match(out.meta.claudeBridge, /stopped answering/);
});

test('the ask is a simple request, so the browser sends no preflight to the loopback address', async () => {
  // 2026-10-01: the GET to /health went through and the preflighted POST to /ask was refused by
  // Chrome's local network check, with the site's permissions allowed.
  const seen = [];
  const fetchImpl = async (u, init = {}) => {
    seen.push({ u, init });
    if (u.endsWith('/health')) return new Response(JSON.stringify({ ok: true, model: 'sonnet', claude: true }), { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":1}' } }] }), { status: 200 });
  };
  const out = await claudeFirstAsker(async () => ({ content: 'gemini' }), { fetchImpl })(REQ);
  assert.equal(out.content, '{"ok":1}');
  const ask = seen.find((s) => s.u.endsWith('/ask'));
  assert.equal(ask.init.method, 'POST');
  assert.equal(ask.init.headers, undefined);
  assert.equal(typeof ask.init.body, 'string');
  assert.deepEqual(Object.keys(JSON.parse(ask.init.body)).sort(), ['system', 'user']);
});

test('both planners ask through it, and the app and the bridge agree on the port', () => {
  for (const f of ['js/modules/smart-plan-v2-wiring.js', 'js/modules/plan-water-ui.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(src, /askModel:[\s\S]{0,200}claudeFirstAsker\(modelAsker\(CF_WORKER_URL\)/, f);
  }
  const py = fs.readFileSync(path.join(ROOT, 'Scripts/claude_plan_bridge.py'), 'utf8');
  const port = /^PORT = (\d+)$/m.exec(py)[1];
  assert.equal(CLAUDE_BRIDGE_URL, `http://127.0.0.1:${port}`);
});
