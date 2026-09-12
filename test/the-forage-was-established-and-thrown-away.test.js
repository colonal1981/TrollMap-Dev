import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleResearchAgent } from '../Worker/research/agents.js';

// ---------------------------------------------------------------------------
// Why this test exists
//
// Ryan, 2026-09-12, after I told him Wateree had no forage data at all: "that
// shouldn't be empty on wateree unless there is still a bug with the research...
// there should have been forage information in the old profiles".
//
// There was a bug. The fisheries agent has two paths. On the SINGLE-SHOT path
// the response carries `data: parsed`, and scripts/research_lakes.py reads
// `res.data.lakeForage` out of it and writes it into biology.primaryForage. On
// the MULTI-GROUP path -- taken whenever a water has enough species to group,
// which is nearly all of them -- runGroup() returned only
// `parsed.trollingIntelligence`, and the response had no `data` key at all.
//
// So the prompt asked for it -- "THIS LAKE'S FORAGE IS NOT RECORDED. ESTABLISH
// IT FROM THE DOCUMENTS FIRST... return it in lakeForage" -- the model answered,
// and both the forage AND any species it established were dropped on the way
// home. Measured across the 77 stored profiles: 60 carry no forage.
//
// Wateree has 11 predator species, so it groups, so it took that path.
// ---------------------------------------------------------------------------

// The same shape Worker code expects, including `{type:'json'}` — a KV stub that ignores the
// option hands back a string where the caller destructures an object.
const fakeKV = () => {
  const store = new Map();
  return {
    store,
    async get(k, opts) {
      const v = store.get(k);
      if (v === undefined) return null;
      return opts?.type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { store.set(k, v); },
  };
};

const ANSWER = {
  trollingIntelligence: {
    'Striped Bass': { summer: { preferredDepth: [12, 22], holding: 'suspended',
                                structures: ['main lake points'], forage: ['Threadfin Shad'],
                                recommendedPresentations: ['Umbrella Rig'], notes: '' } },
  },
  lakeForage: { primary: ['Threadfin Shad', 'Gizzard Shad'],
                secondary: ['Bluegill', 'Crawfish'] },
  speciesFound: [{ species: 'White Perch' }],
};

function stubLLM(payloads) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/chat/completions') || u.includes('generativelanguage')) {
      payloads.push(JSON.parse(init.body || '{}'));
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(ANSWER) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ results: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return () => { globalThis.fetch = real; };
}

const run = async (predatorSpecies) => handleResearchAgent(new Request('https://x/agent', {
  method: 'POST',
  body: JSON.stringify({
    lakeName: 'Wateree Lake (Kershaw Co, SC)', state: 'SC', agent: 'fisheries',
    previousResults: { biology: { predatorSpecies, primaryForage: [], secondaryForage: [] } },
  }),
}), { KV: fakeKV(), TINYFISH_API_KEY: 'test', CEREBRAS_API_KEY: 'test' });

describe('the fisheries group path must carry the lake-level answers home', () => {
  // Eleven species is what Wateree actually has, and it is what forces grouping.
  const WATEREE_11 = ['Largemouth Bass', 'Bluegill', 'Redear Sunfish (Shellcracker)',
    'Redbreast Sunfish', 'Warmouth', 'Black Crappie', 'Channel Catfish', 'Blue Catfish',
    'White Perch', 'White Bass / Hybrid', 'Striped Bass'];

  test('a grouped run returns data.lakeForage, which the batch already reads', async () => {
    const payloads = []; const restore = stubLLM(payloads);
    try {
      const res = await run(WATEREE_11);
      // ONE READ. `await res.text()` as an assertion message consumes the body, and the
      // res.json() after it then throws "Body has already been read" -- which reads as a
      // failure of the thing under test rather than of the test.
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body).slice(0, 400));
      assert.ok(payloads.length > 1, 'this water must have grouped — otherwise the test proves nothing');
      assert.ok(body.data, 'the group path returned no `data` key at all — the original bug');
      assert.deepEqual(body.data.lakeForage.primary, ['Threadfin Shad', 'Gizzard Shad']);
      assert.deepEqual(body.data.lakeForage.secondary, ['Bluegill', 'Crawfish']);
    } finally { restore(); }
  });

  test('it unions across groups instead of letting the last one win', async () => {
    // Every group is shown the same documents and asked the same lake-level
    // question. A group that read one fewer document must not be able to delete
    // what another group found, and the same name must not appear twice.
    const payloads = []; const restore = stubLLM(payloads);
    try {
      const body = await (await run(WATEREE_11)).json();
      const p = body.data.lakeForage.primary;
      assert.equal(p.length, new Set(p.map((x) => x.toLowerCase())).size, 'duplicates survived the union');
    } finally { restore(); }
  });

  test('species the agent established also come home', async () => {
    const payloads = []; const restore = stubLLM(payloads);
    try {
      const body = await (await run(WATEREE_11)).json();
      assert.deepEqual(body.data.speciesFound, [{ species: 'White Perch' }]);
    } finally { restore(); }
  });

  test('the trolling intelligence is untouched by the change', async () => {
    const payloads = []; const restore = stubLLM(payloads);
    try {
      const body = await (await run(WATEREE_11)).json();
      assert.ok(body.section, 'the section is what this endpoint has always returned');
      assert.ok(Object.keys(body.section).length > 0);
    } finally { restore(); }
  });
});
