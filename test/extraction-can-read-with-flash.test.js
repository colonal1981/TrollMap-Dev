// Personal use only, not for distribution or resale; not for navigation.
//
// EXTRACTION CAN READ WITH THE FULL FLASH MODELS, WHEN ASKED.
//
// Ryan's batch of 2026-09-25 spent both Lite models' daily quota on all five free keys ("limit:
// 500, model: gemini-3.1-flash-lite") with five waters left, and the Flash allowances -- 3.5 to 3.8
// Flash, 20 a day per model per key -- were untouched. `extractModels: 'flash'` on
// /research/analyze-facts puts them first, as `groupModels: 'flash'` already does for the species
// groups; without it the read is exactly what it was. The real handler, against a stubbed Gemini
// that records which model each call asked for.
//
//   node --test test/extraction-can-read-with-flash.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleResearchAnalyzeFacts } from '../Worker/research/extract.js';
import { GEMINI_FREE_FLASH_MODELS } from '../Worker/worker-core.js';

const DOC = { title: 'Lake Murray striper report', url: 'https://a.example/1',
  text: 'Striped bass on Lake Murray hold on the main lake points at 30 to 40 feet in late summer, '
      + 'following the herring schools that stay near the thermocline.' };

function stubGemini() {
  const models = [];
  globalThis.fetch = async (url) => {
    const m = /models\/([^:]+):/.exec(String(url));
    models.push(m ? m[1] : String(url));
    return { ok: true, status: 200, json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ extracted_facts: [] }) }] } }] }) };
  };
  return models;
}

const ask = (extra = {}) => handleResearchAnalyzeFacts(new Request('https://w.example/x', {
  method: 'POST', body: JSON.stringify({ lakeName: 'Lake Murray, SC', baseName: 'Murray', state: 'SC',
    docIndex: 0, documents: [DOC], ...extra }) }), { GEMINI_FREE_API_KEY: 'k' });

test('extractModels: flash asks a full Flash model first', async () => {
  const models = stubGemini();
  await ask({ extractModels: 'flash' });
  assert.ok(models.length >= 1);
  assert.ok(GEMINI_FREE_FLASH_MODELS.includes(models[0]), `first call asked ${models[0]}`);
});

test('without it the read asks a Lite model, as it always has', async () => {
  const models = stubGemini();
  await ask();
  assert.ok(models.length >= 1);
  assert.ok(!GEMINI_FREE_FLASH_MODELS.includes(models[0]), `first call asked ${models[0]}`);
  assert.match(models[0], /lite/);
});
