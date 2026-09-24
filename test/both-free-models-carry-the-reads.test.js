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

test('a call that asks for the spread starts on each model in turn', async () => {
  const asked = stub();
  for (let i = 0; i < 10; i++) await callLLM(ENV, PAYLOAD, null, { spreadModels: true });
  const n = (id) => asked.filter((a) => a.model === id).length;
  assert.equal(asked.length, 10, 'one request a call -- nothing failed, nothing fell over');
  assert.equal(n('gemini-3.5-flash-lite'), 5);
  assert.equal(n('gemini-3.1-flash-lite'), 5);
  for (let i = 1; i < asked.length; i++) {
    assert.notEqual(asked[i].model, asked[i - 1].model, 'consecutive calls alternate');
  }
  assert.equal(new Set(asked.map((a) => a.key)).size, 5, 'and the keys still rotate underneath');
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
  for (let i = 0; i < 4; i++) got.push(await callLLM(ENV, PAYLOAD, null, { spreadModels: true }));
  assert.ok(got.every((g) => g.model === 'gemini-3.5-flash-lite'), 'every call was answered');
  const refused = asked.filter((a) => a.model === 'gemini-3.1-flash-lite');
  assert.equal(refused.length, 2, 'half the calls started on 3.1');
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
