// Personal use only, not for distribution or resale; not for navigation.
//
// THE SPECIES ANSWERS CAN ASK FOR THE FULL FLASH MODELS FIRST.
//
// Ryan, 2026-09-24: 3.5, 3.6, 3.7 and 3.8 Flash each carry 5 RPM / 250K TPM / 20 RPD on every free
// key -- "so you could split that between 4 models and 5 keys... if they are better?" A caller that
// passes { firstModels } gets those tried on every free key before any Lite model, and a spent
// allowance falls to Lite exactly as before. These run the real callLLM() against a stubbed Gemini.
//
//   node --test test/the-species-answers-can-ask-for-flash-first.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callLLM, GEMINI_FREE_FLASH_MODELS } from '../Worker/worker-core.js';

const ENV = { GEMINI_FREE_API_KEY: 'k1', GEMINI_FREE2_API_KEY: 'k2', GEMINI_FREE3_API_KEY: 'k3',
  GEMINI_FREE4_API_KEY: 'k4', GEMINI_FREE5_API_KEY: 'k5' };
const PAYLOAD = { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
  max_tokens: 5000, response_format: { type: 'json_object' } };
const LITE = new Set(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);

function stub(answer) {
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const m = String(url).match(/models\/([^:]+):generateContent\?key=(\w+)/);
    const body = JSON.parse(init.body);
    asked.push({ model: m[1], key: m[2], maxOut: body.generationConfig?.maxOutputTokens });
    const parts = answer(m[1]);
    return parts
      ? { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts } }] }) }
      : { ok: false, status: 429, json: async () => ({ error: { message: 'Resource has been exhausted (e.g. check quota).' } }) };
  };
  return asked;
}

test('the four Flash endpoints, as the models page lists them', () => {
  assert.deepEqual(GEMINI_FREE_FLASH_MODELS,
    ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash']);
});

test('a caller that asks gets a Flash model, with no output cap for the thinking to spend', async () => {
  const asked = stub(() => [{ text: '{"ok":1}' }]);
  const got = await callLLM(ENV, PAYLOAD, null, { firstModels: GEMINI_FREE_FLASH_MODELS });
  assert.ok(GEMINI_FREE_FLASH_MODELS.includes(got.model));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].maxOut, undefined, 'the Lite-sized 5,000 cap is not sent to a thinking model');
});

test('every Flash model on every key is tried before any Lite model, and Lite still answers', async () => {
  const asked = stub((model) => (LITE.has(model) ? [{ text: '{"ok":1}' }] : null));
  const got = await callLLM(ENV, PAYLOAD, null, { firstModels: GEMINI_FREE_FLASH_MODELS });
  assert.ok(LITE.has(got.model), 'a spent Flash allowance costs the species nothing');
  const firstLite = asked.findIndex((a) => LITE.has(a.model));
  assert.equal(firstLite, 20, 'four models x five keys, then Lite');
  const pairs = new Set(asked.slice(0, 20).map((a) => `${a.model}@${a.key}`));
  assert.equal(pairs.size, 20, 'twenty different allowances, none asked twice');
  assert.equal(asked[firstLite].maxOut, 5000, 'Lite keeps the cap it was sized for');
});

test('twenty calls in a row spread over all twenty Flash allowances', async () => {
  const asked = stub(() => [{ text: '{"ok":1}' }]);
  for (let i = 0; i < 20; i++) await callLLM(ENV, PAYLOAD, null, { firstModels: GEMINI_FREE_FLASH_MODELS });
  assert.equal(new Set(asked.map((a) => a.model)).size, 4);
  assert.equal(new Set(asked.map((a) => a.key)).size, 5);
});

test('a caller that does not ask never touches a Flash model', async () => {
  const asked = stub(() => [{ text: '{"ok":1}' }]);
  for (let i = 0; i < 6; i++) await callLLM(ENV, PAYLOAD, null);
  assert.ok(asked.every((a) => LITE.has(a.model)));
});

test('a thinking reply is read whole: thought parts skipped, the rest joined', async () => {
  stub(() => [{ text: 'planning...', thought: true }, { text: '{"a":' }, { text: '1}' }]);
  const got = await callLLM(ENV, PAYLOAD, null, { firstModels: GEMINI_FREE_FLASH_MODELS });
  assert.equal(got.data.choices[0].message.content, '{"a":1}');
});
