// Personal use only, not for distribution or resale; not for navigation.
//
// EVERY FREE GEMINI KEY THE WORKER HOLDS IS USED, NOT THE FIRST FIVE.
//
// Ryan, 2026-09-25, after adding projects six to nine as Worker secrets (GEMINI_FREE6_API_KEY ...
// GEMINI_FREE9_API_KEY): the provider list was five copied entries and callLLM named them a second
// time, so the new four were never asked. These run the real callLLM() against a stubbed Gemini
// that records which key each call went out on.
//
//   node --test test/every-free-key-is-used.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callLLM } from '../Worker/worker-core.js';

const PAYLOAD = { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
  response_format: { type: 'json_object' } };

function envWith(n) {
  const env = {};
  for (let i = 1; i <= n; i++) env[i === 1 ? 'GEMINI_FREE_API_KEY' : `GEMINI_FREE${i}_API_KEY`] = `k${i}`;
  return env;
}

function stub(refuse = () => false) {
  const keys = [];
  globalThis.fetch = async (url, init) => {
    const key = init?.headers?.['x-goog-api-key'] || (String(url).match(/key=(\w+)/) || [])[1];
    keys.push(key);
    return refuse(key)
      ? { ok: false, status: 429, json: async () => ({ error: { message: 'Resource has been exhausted (e.g. check quota).' } }) }
      : { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }) };
  };
  return keys;
}

test('nine keys: nine calls go out on nine different keys', async () => {
  const keys = stub();
  const env = envWith(9);
  for (let i = 0; i < 9; i++) await callLLM(env, PAYLOAD);
  assert.deepEqual([...new Set(keys)].sort(), ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9']);
});

test('a refused key falls to the others, all nine of them, and never to groq or the rest', async () => {
  const env = { ...envWith(9), GROQ_API_KEY: 'g', OPENROUTER_API_KEY: 'o', CEREBRAS_API_KEY: 'c' };
  const keys = stub((k) => k !== 'k9');
  const got = await callLLM(env, PAYLOAD);
  assert.ok(got);
  assert.ok(keys.includes('k9'), 'the ninth key was reached');
  assert.ok(!keys.some((k) => ['g', 'o', 'c'].includes(k)), 'nothing left the free Gemini keys');
});

test('five keys still behave as five', async () => {
  const keys = stub();
  const env = envWith(5);
  for (let i = 0; i < 10; i++) await callLLM(env, PAYLOAD);
  assert.deepEqual([...new Set(keys)].sort(), ['k1', 'k2', 'k3', 'k4', 'k5']);
});
