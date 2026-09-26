// a-refused-group-is-asked-in-a-new-request.test.js
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan's lake batch, 2026-09-25, 30 waters, `--group-models claude`:
//
//     warn [Nottely Lake, GA]: fisheries group "catfish" returned nothing (Too many subrequests
//          by single Worker invocation. ...)   -- and "panfish", and "other"
//     [ 22/30] ok  484.8s  Nottely Lake, GA  5/10 species ... 7 retries
//              LOST: Channel Catfish, Flathead Catfish, Bluegill, Redbreast Sunfish, Catfish
//
// Every species group of a water ran inside ONE Worker invocation, and Workers Free allows an
// invocation 50 external subrequests (developers.cloudflare.com/workers/platform/limits/). Each
// group retried the whole free-key ladder three times inside it, so the early groups spent the
// allowance and the later ones failed on their first fetch without ever reaching a model.
//
// These hold the fix: the Worker makes one pass per group, a group after the allowance is spent is
// reported NOT ASKED rather than failed with the platform's error, and the caller asks the groups
// that were not answered again in a NEW request -- which has a fresh allowance -- and merges.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleResearchAgent } from '../Worker/research/agents.js';

// Workers Free, per invocation: developers.cloudflare.com/workers/platform/limits/#subrequests.
const FREE_PLAN_SUBREQUESTS = 50;
// The error text the platform throws, as it appeared in the batch log.
const SPENT = 'Too many subrequests by single Worker invocation. To configure this limit, refer to '
            + 'https://developers.cloudflare.com/workers/wrangler/configuration/#limits';

// One species per group, in the Worker's own group order: bass, crappie, catfish, panfish, other.
const ROSTER = ['Largemouth Bass', 'Crappie', 'Channel Catfish', 'Bluegill', 'Rainbow Trout'];
const KEYS = { GEMINI_FREE_API_KEY: 'k1', GEMINI_FREE2_API_KEY: 'k2', GEMINI_FREE3_API_KEY: 'k3',
               GEMINI_FREE4_API_KEY: 'k4', GEMINI_FREE5_API_KEY: 'k5' };

const season = { preferredDepth: [8, 20], holding: 'suspended', structures: [], forage: [],
                 recommendedPresentations: [], notes: '' };

// NOT A RATE REFUSAL, SO IT IS STILL WALKED. Since the rate-refusal change (stopOnRefusal in
// Worker/worker-core.js) a "high demand" 503 ends a group's pass after ONE request and the caller
// waits; a failure Google does not describe as a rate or demand refusal still walks every slot,
// and that walk is what can spend the invocation's 50 subrequests.
const BROKEN = { status: 500, body: { error: { code: 500, status: 'INTERNAL',
  message: 'An internal error has occurred. Please retry or report in https://developers.generativeai.google/guide/troubleshooting' } } };
const DEMAND = { status: 503, body: { error: { code: 503, status: 'UNAVAILABLE', message:
  'This model is currently experiencing high demand. Spikes in demand are usually temporary. '
  + 'Please try again later.' } } };

/**
 * One Worker invocation's fetch. Counts every call, throws the platform's error past the free
 * plan's allowance, and answers Gemini with `demand(n)` -- true means call n is refused with
 * `refusal` ("high demand" unless given). An answer names the roster species the group's prompt
 * names, and nothing else.
 */
function invocation(demand, refusal = DEMAND) {
  const real = globalThis.fetch;
  const seen = { calls: 0 };
  globalThis.fetch = async (url, init = {}) => {
    seen.calls += 1;
    if (seen.calls > FREE_PLAN_SUBREQUESTS) throw new Error(SPENT);
    if (!String(url).includes('generativelanguage')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (demand(seen.calls)) {
      return new Response(JSON.stringify(refusal.body),
        { status: refusal.status, headers: { 'content-type': 'application/json' } });
    }
    const prompt = JSON.parse(init.body).contents[0].parts[0].text;
    // The prompt's own list: "CONFIRMED SPECIES (ONLY these — do not add others):" then one line.
    const listed = (prompt.split('CONFIRMED SPECIES (ONLY these')[1] || '').split('\n')[1] || '';
    const named = listed.split(', ').map((s) => s.trim()).filter(Boolean);
    const answer = {
      trollingIntelligence: Object.fromEntries(named.map((s) => [s, { summer: season }])),
      lakeForage: { primary: ['Threadfin Shad'], secondary: [] },
    };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { seen, restore: () => { globalThis.fetch = real; } };
}

async function ask({ groupModels, groups, demand, refusal }) {
  const inv = invocation(demand, refusal);
  try {
    const res = await handleResearchAgent(new Request('https://x/research/agent-llm', {
      method: 'POST',
      body: JSON.stringify({
        lakeName: 'Nottely Lake', state: 'GA', agent: 'fisheries',
        ...(groupModels ? { groupModels } : {}), ...(groups ? { groups } : {}),
        previousResults: { biology: { predatorSpecies: ROSTER, primaryForage: [], secondaryForage: [] } },
      }),
    }), { ...KEYS });
    return { body: await res.json(), calls: inv.seen.calls };
  } finally { inv.restore(); }
}

const byGroup = (body) => Object.fromEntries(body.meta.groups.map((g) => [g.group, g]));

describe('the arithmetic, counted by the stub rather than argued', () => {
  test('one group on a "high demand" minute is one request per MODEL, and the caller waits', async () => {
    // It was one request per free key per model -- 10 on Lite, 5 x 4 Flash + 10 Lite = 30 with
    // Flash first -- every one of them counted against the day and sent into the same minute.
    // Google names the model that is in demand, so each model is asked once and left out on the
    // other keys (stopOnRefusal, worker-core.js): 2 on Lite, 4 + 2 with Flash first.
    const { body, calls } = await ask({ groups: ['bass'], demand: () => true });
    assert.equal(calls, 2);
    assert.equal(byGroup(body).bass.ok, false);
    assert.equal(byGroup(body).bass.attempts, 1);
    assert.equal(byGroup(body).bass.refusal, 'demand');
    const flash = await ask({ groupModels: 'flash', groups: ['bass'], demand: () => true });
    assert.equal(flash.calls, 4 + 2);
  });

  test('a failure that is not a rate refusal is still walked: one request per key per model', async () => {
    const { calls } = await ask({ groups: ['bass'], demand: () => true, refusal: BROKEN });
    assert.equal(calls, 5 * 2);
    const flash = await ask({ groupModels: 'flash', groups: ['bass'], demand: () => true, refusal: BROKEN });
    assert.equal(flash.calls, 5 * 4 + 5 * 2);
  });

  test('`groups` answers only the groups named', async () => {
    const { body, calls } = await ask({ groups: ['catfish', 'other'], demand: () => false });
    assert.deepEqual(body.meta.askedGroups, ['catfish', 'other']);
    assert.deepEqual(Object.keys(body.section).sort(), ['Channel Catfish', 'Rainbow Trout']);
    assert.deepEqual(body.meta.missingSpecies, [], 'the rest of the roster was not this request\'s to answer');
    assert.equal(calls, 2);
  });
});

describe('a group that spends the allowance does not take the next one with it', () => {
  // Flash on a bad minute of errors that are walked: bass walks all 30, crappie walks 20 more and
  // hits the platform's wall.
  const spend = () => ask({ groupModels: 'flash', demand: () => true, refusal: BROKEN });

  test('the groups after it come back NOT ASKED, not failed with the platform error', async () => {
    const { body, calls } = await spend();
    assert.equal(calls, FREE_PLAN_SUBREQUESTS + 1, 'the 51st fetch is the one the platform refused');
    const g = byGroup(body);
    assert.equal(g.bass.ok, false);
    assert.equal(g.bass.asked, true);
    assert.equal(g.crappie.asked, true);
    assert.match(g.crappie.reason, /Too many subrequests/, 'the group that met the wall says so');
    for (const name of ['catfish', 'panfish', 'other']) {
      assert.equal(g[name].ok, false);
      assert.equal(g[name].asked, false, `${name} was never asked`);
      assert.equal(g[name].attempts, 0);
      assert.match(g[name].reason, /^not asked/);
    }
    assert.deepEqual(body.meta.notAskedGroups.map((x) => x.group), ['catfish', 'panfish', 'other']);
    assert.deepEqual(body.meta.failedGroups.map((x) => x.group), ['bass', 'crappie']);
    assert.ok(!body.warnings.some((w) => /"(catfish|panfish|other)" returned nothing/.test(w)),
      'no group that was never asked is reported as having answered nothing');
    assert.ok(body.warnings.some((w) => /"catfish" was not asked/.test(w)));
  });

  // THE CALLER'S HALF -- asking the unanswered groups again in a new request, and merging -- was
  // tested here against js/utils/species-group-retry.js, the Research tab's copy of the rule.
  // The tab and that copy were deleted on 2026-09-25. The batch's copy,
  // Scripts/species_group_retry.py, is tested by Scripts/test_species_group_retry.py.
});
