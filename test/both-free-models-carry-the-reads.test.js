// Personal use only, not for distribution or resale; not for navigation.
//
// BOTH FREE MODELS CARRY THE READS, EACH ON ITS OWN QUOTA.
//
// Ryan, 2026-09-24, with one key's AI Studio usage page open: "and we could make it so it hits
// both models separately right" -- Gemini 3.5 Flash Lite at 8/15 RPM and 43/500 RPD, Gemini 3.1
// Flash Lite at 2/15 and 0/500. Each model is metered on its own, and the ladder in callLLM()
// reached 3.1 only when 3.5 had failed. These run the real callLLM() against a stubbed Gemini
// that records which model each request named.
//
//   node --test test/both-free-models-carry-the-reads.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callLLM } from '../Worker/worker-core.js';
import { handleResearchAnalyzeFacts } from '../Worker/research/extract.js';

const ENV = { GEMINI_FREE_API_KEY: 'k1', GEMINI_FREE2_API_KEY: 'k2', GEMINI_FREE3_API_KEY: 'k3',
  GEMINI_FREE4_API_KEY: 'k4', GEMINI_FREE5_API_KEY: 'k5' };
const PAYLOAD = { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] };
const OK = { candidates: [{ content: { parts: [{ text: '{"extracted_facts":[]}' }] } }] };

// WHERE AN ISOLATE STARTS IS DRAWN IN ITS FIRST REQUEST (drawStart, worker-core.js), so these draw
// from a seeded generator: the same draws every run. mulberry32, a standard 32-bit generator.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const realRandom = Math.random;
test.beforeEach(() => { Math.random = seeded(20260924); });
test.afterEach(() => { Math.random = realRandom; });

// `refuse(model)` -> an error message for that model, or null to answer.
function stub(refuse = () => null) {
  const asked = [];
  globalThis.fetch = async (url) => {
    const m = String(url).match(/models\/([^:]+):generateContent\?key=(\w+)/);
    assert.ok(m, `a Gemini request, not ${url}`);
    asked.push({ model: m[1], key: m[2] });
    const why = refuse(m[1]);
    return why
      ? { ok: false, status: 429, json: async () => ({ error: { message: why } }) }
      : { ok: true, status: 200, json: async () => OK };
  };
  return asked;
}

test('calls that ask for the spread start on both models', async () => {
  const asked = stub();
  for (let i = 0; i < 20; i++) await callLLM(ENV, PAYLOAD, null, { spreadModels: true });
  const n = (id) => asked.filter((a) => a.model === id).length;
  assert.equal(asked.length, 20, 'one request a call -- nothing failed, nothing fell over');
  assert.ok(n('gemini-3.5-flash-lite') >= 5, `3.5 started ${n('gemini-3.5-flash-lite')} of 20`);
  assert.ok(n('gemini-3.1-flash-lite') >= 5, `3.1 started ${n('gemini-3.1-flash-lite')} of 20`);
  assert.ok(new Set(asked.map((a) => a.key)).size >= 4, 'and the keys spread underneath');
});

test('a call that does not ask keeps 3.5 first', async () => {
  const asked = stub();
  for (let i = 0; i < 6; i++) await callLLM(ENV, PAYLOAD, null);
  assert.deepEqual([...new Set(asked.map((a) => a.model))], ['gemini-3.5-flash-lite']);
});

test('a call that starts on a refused model falls to the other on the same key', async () => {
  const asked = stub((model) => (model === 'gemini-3.1-flash-lite'
    ? 'This model is currently experiencing high demand.' : null));
  const got = [];
  for (let i = 0; i < 8; i++) got.push(await callLLM(ENV, PAYLOAD, null, { spreadModels: true }));
  assert.ok(got.every((g) => g.model === 'gemini-3.5-flash-lite'), 'every call was answered');
  const refused = asked.filter((a) => a.model === 'gemini-3.1-flash-lite');
  assert.ok(refused.length >= 1 && refused.length < 8, `${refused.length} of 8 calls started on 3.1`);
  assert.equal(asked.length, 8 + refused.length, 'one extra request per call that started on 3.1');
  for (const r of refused) {
    const next = asked[asked.indexOf(r) + 1];
    assert.equal(next.model, 'gemini-3.5-flash-lite');
    assert.equal(next.key, r.key, 'the other model on the same key, before any other key');
  }
});

test('document extraction asks for the spread and says which model read each document', async () => {
  const asked = stub();
  const docs = Array.from({ length: 4 }, (_, i) => ({ title: `Doc ${i}`, url: `https://e.example/${i}`,
    text: `Lake Murray striped bass hold on the channel ledges in summer, document ${i}. `.repeat(3) }));
  const models = [];
  for (const d of docs) {
    const r = await (await handleResearchAnalyzeFacts(new Request('https://w.example/x', {
      method: 'POST', body: JSON.stringify({ lakeName: 'Lake Murray, SC', baseName: 'Lake Murray',
        state: 'SC', docIndex: 0, documents: [d] }) }), ENV)).json();
    models.push(r.meta.docResults[0].model);
  }
  assert.deepEqual(models, asked.map((a) => a.model), 'docResults names the model that answered');
  assert.equal(new Set(models).size, 2, 'four reads, both models');
});
