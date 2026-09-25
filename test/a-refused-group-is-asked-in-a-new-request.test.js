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
import { askFailedGroupsAgain, groupsToAskAgain, mergeGroupAnswers, GROUP_RETRY_WAITS_MS }
  from '../js/utils/species-group-retry.js';

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

/**
 * One Worker invocation's fetch. Counts every call, throws the platform's error past the free
 * plan's allowance, and answers Gemini with `demand(n)` -- true means "high demand" for call n.
 * An answer names the roster species the group's prompt names, and nothing else.
 */
function invocation(demand) {
  const real = globalThis.fetch;
  const seen = { calls: 0 };
  globalThis.fetch = async (url, init = {}) => {
    seen.calls += 1;
    if (seen.calls > FREE_PLAN_SUBREQUESTS) throw new Error(SPENT);
    if (!String(url).includes('generativelanguage')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (demand(seen.calls)) {
      return new Response(JSON.stringify({ error: { message:
        'This model is currently experiencing high demand. Spikes in demand are usually temporary. '
        + 'Please try again later.' } }), { status: 503, headers: { 'content-type': 'application/json' } });
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

async function ask({ groupModels, groups, demand }) {
  const inv = invocation(demand);
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
  test('one group on a "high demand" minute is one request per free key per model, once', async () => {
    // Lite: 5 keys x 2 models = 10 per group, and the Worker no longer repeats it inside the request.
    const { body, calls } = await ask({ groups: ['bass'], demand: () => true });
    assert.equal(calls, 5 * 2);
    assert.equal(byGroup(body).bass.ok, false);
    assert.equal(byGroup(body).bass.attempts, 1);
    // Flash first: 5 keys x 4 Flash models, then the Lite ladder -- 30.
    const flash = await ask({ groupModels: 'flash', groups: ['bass'], demand: () => true });
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
  // Flash on a bad minute: bass walks all 30, crappie walks 20 more and hits the platform's wall.
  const spend = () => ask({ groupModels: 'flash', demand: () => true });

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

  test('the caller asks them again in a new request, and the water loses nothing', async () => {
    const { body: first } = await spend();
    assert.deepEqual(groupsToAskAgain(first), ['bass', 'crappie', 'catfish', 'panfish', 'other']);
    const requests = [];
    const waited = [];
    const { res, reasked } = await askFailedGroupsAgain(async (groups) => {
      requests.push(groups);
      // A new request is a new invocation: a fresh allowance, and the spike has passed.
      return (await ask({ groupModels: 'flash', groups, demand: () => false })).body;
    }, first, { sleep: async (ms) => { waited.push(ms); } });
    assert.deepEqual(requests, [['bass', 'crappie', 'catfish', 'panfish', 'other']]);
    assert.deepEqual(waited, [GROUP_RETRY_WAITS_MS[0]]);
    assert.deepEqual(GROUP_RETRY_WAITS_MS, [8000, 20000], 'the waits the code already argued for');
    assert.deepEqual(reasked, ['bass', 'crappie', 'catfish', 'panfish', 'other']);
    assert.deepEqual(Object.keys(res.section).sort(), [...ROSTER].sort());
    assert.deepEqual(res.meta.missingSpecies, []);
    assert.deepEqual(groupsToAskAgain(res), []);
    assert.deepEqual(res.meta.failedGroups, []);
    assert.deepEqual(res.meta.notAskedGroups, []);
    assert.deepEqual(res.data.lakeForage.primary, ['Threadfin Shad']);
    assert.ok(!res.warnings.some((w) => /^fisheries group "/.test(w)), 'no stale per-group warning survives');
  });

  test('a group still refused after both waits stays LOST', async () => {
    const { body: first } = await spend();
    const requests = [];
    // Every later request answers, except catfish, which the provider keeps refusing.
    const refusing = async (groups) => {
      requests.push(groups);
      const again = (await ask({ groups, demand: () => false })).body;
      const g = again.meta.groups.find((x) => x.group === 'catfish');
      if (g) {
        Object.assign(g, { ok: false, asked: true, reason: 'high demand', returned: undefined });
        delete again.section['Channel Catfish'];
        again.meta.missingSpecies = ['Channel Catfish'];
      }
      return again;
    };
    const { res, reasked } = await askFailedGroupsAgain(refusing, first, { sleep: async () => {} });
    // One new request per wait, the second one naming only what the first new one could not answer.
    assert.deepEqual(requests, [['bass', 'crappie', 'catfish', 'panfish', 'other'], ['catfish']]);
    assert.deepEqual(reasked, ['bass', 'crappie', 'catfish', 'panfish', 'other']);
    assert.deepEqual(res.meta.missingSpecies, ['Channel Catfish'], 'the report still says LOST');
    assert.deepEqual(groupsToAskAgain(res), ['catfish']);
    assert.equal(byGroup(res).catfish.attempts, 2, 'asked in both later requests, never in the first');
    assert.ok(!('Channel Catfish' in res.section));
  });
});

test('a failed second request leaves the first answer as it was', () => {
  const first = { success: true, section: { A: {} }, meta: { groups: [{ group: 'bass', ok: false }] } };
  assert.equal(mergeGroupAnswers(first, null), first);
  assert.equal(mergeGroupAnswers(first, { success: false }), first);
});
