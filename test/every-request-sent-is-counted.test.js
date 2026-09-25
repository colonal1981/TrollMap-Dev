// every-request-sent-is-counted.test.js
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan's five AI Studio dashboards, 2026-09-25: about 5,500 requests counted against the day
// (both Lite models 503 / 500 RPD, every Flash model 21-23 / 20, on all five projects). That day's
// two run logs got back about 900 answers. Four requests in five produced nothing, and the batch's
// screen could not show it: a call that walked ten refusals before an answer printed as one answer.
//
// These hold the measurement: callLLM writes down every request it sends -- key, model, HTTP
// status, answered -- and /research/analyze-facts and /research/agent-llm hand that record back in
// meta, answered or not, so Scripts/research_lakes.py can print requests sent per answer.
//
//   node --test test/every-request-sent-is-counted.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callLLM, countRequests } from '../Worker/worker-core.js';
import { handleResearchAnalyzeFacts } from '../Worker/research/extract.js';
import { handleResearchAgent } from '../Worker/research/agents.js';

const KEYS = { GEMINI_FREE_API_KEY: 'k1', GEMINI_FREE2_API_KEY: 'k2', GEMINI_FREE3_API_KEY: 'k3',
               GEMINI_FREE4_API_KEY: 'k4', GEMINI_FREE5_API_KEY: 'k5' };
const DEMAND = 'This model is currently experiencing high demand. Spikes in demand are usually '
             + 'temporary. Please try again later.';

const json = (body, status = 200) => new Response(JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } });
const answer = (obj) => json({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });

/** Gemini refuses the first `refuse` requests with "high demand", then answers `obj`. */
function gemini(refuse, obj) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (!u.includes('generativelanguage')) return json({});
    seen.push({ key: /key=([^&]+)/.exec(u)[1], model: /models\/([^:]+):/.exec(u)[1] });
    if (seen.length <= refuse) return json({ error: { code: 503, message: DEMAND, status: 'UNAVAILABLE' } }, 503);
    return answer(typeof obj === 'function' ? obj() : obj);
  };
  return { seen, restore: () => { globalThis.fetch = real; } };
}

test('callLLM returns one entry per request it sent, and the one that answered', async () => {
  const g = gemini(3, { ok: true });
  try {
    const r = await callLLM({ ...KEYS }, { messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.requests.length, g.seen.length, 'every request that left is in the record');
    assert.equal(r.requests.length, 4);
    assert.deepEqual(r.requests.map((q) => q.http), [503, 503, 503, 200]);
    assert.deepEqual(r.requests.map((q) => q.answered), [false, false, false, true]);
    for (const [i, q] of r.requests.entries()) {
      assert.equal(`k${q.key}`, g.seen[i].key, 'the key is the free key\'s number, 1-5');
      assert.equal(q.model, g.seen[i].model);
    }
    assert.deepEqual(countRequests(r.requests), { sent: 4, answered: 1 });
  } finally { g.restore(); }
});

test('a call that never answered still says what it spent', async () => {
  const g = gemini(Infinity, {});
  try {
    await assert.rejects(callLLM({ ...KEYS }, { messages: [{ role: 'user', content: 'x' }] }), (e) => {
      assert.equal(e.requests.length, g.seen.length);
      assert.ok(e.requests.length > 0);
      assert.ok(e.requests.every((q) => q.http === 503 && q.answered === false));
      return true;
    });
  } finally { g.restore(); }
});

test('/research/analyze-facts returns the record in meta', async () => {
  const g = gemini(2, { extracted_facts: [] });
  try {
    const res = await handleResearchAnalyzeFacts(new Request('https://w.example/x', {
      method: 'POST', body: JSON.stringify({ lakeName: 'Lake Murray, SC', baseName: 'Murray', state: 'SC',
        docIndex: 0, documents: [{ title: 'Lake Murray report', url: 'https://a.example/1',
          text: 'Striped bass on Lake Murray hold on the main lake points at 30 to 40 feet in late summer, '
            + 'following the herring schools that stay near the thermocline.' }] }) }),
      { ...KEYS });
    const body = await res.json();
    assert.equal(body.meta.llmRequests.length, g.seen.length);
    assert.deepEqual(body.meta.llm, { sent: 3, answered: 1 });
  } finally { g.restore(); }
});

test('/research/agent-llm returns the record for every group, answered or not', async () => {
  const season = { preferredDepth: [8, 20], holding: 'suspended', structures: [], forage: [],
                   recommendedPresentations: [], notes: '' };
  // The first group walks every slot and is refused; the rest answer first time.
  const g = gemini(10, () => ({ trollingIntelligence: { 'Channel Catfish': { summer: season } } }));
  try {
    const res = await handleResearchAgent(new Request('https://x/research/agent-llm', {
      method: 'POST', body: JSON.stringify({ lakeName: 'Nottely Lake', state: 'GA', agent: 'fisheries',
        groups: ['bass', 'catfish'],
        previousResults: { biology: { predatorSpecies: ['Largemouth Bass', 'Crappie', 'Channel Catfish',
          'Bluegill', 'Rainbow Trout'], primaryForage: [], secondaryForage: [] } } }) }), { ...KEYS });
    const body = await res.json();
    assert.equal(body.meta.llmRequests.length, g.seen.length, 'the refused group\'s ten are in it too');
    assert.deepEqual(body.meta.llm, { sent: 11, answered: 1 });
  } finally { g.restore(); }
});
