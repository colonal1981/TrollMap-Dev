/**
 * smart-plan-v2.js — the whole plan, one path.
 *
 * pack → candidates → prompt → model → assemble → render. Six steps, each in its own module,
 * each tested, and nothing between them that reinterprets what a plan is. The old orchestrator
 * ran to nine hundred lines because it did all of that inline and every stage invented its own
 * vocabulary on the way past.
 *
 * WHY THIS EXISTS ALONGSIDE runSmartPlan() RATHER THAN INSIDE IT. The v1 path builds a
 * band1/band2/timeline prompt and four out-and-back routes, and its renderer reads a shape that
 * no longer exists. Rewriting it in place would mean a half-migrated file where a bug could hide
 * in either half. So v2 is whole and separate, and v1 gets DELETED once this has caught fish —
 * it is on the deletion tab, not left to rot beside this.
 *
 * Everything external is injected: `fetchJson` for the pack, `askModel` for the LLM. That is not
 * ceremony — it is what lets the whole path run in a test with no network, which is the only way
 * the seams between six modules stay honest.
 */

import { selectCandidates, structureIndex, forModel } from './plan-candidates.js';
import { buildPlanRequest, parsePlanResponse, planArgsFrom } from './plan-prompt.js';
import { assemblePlan, validatePlan } from './plan-assemble.js';
import { connectionFor } from '../data/lure-knowledge.js';

// How many candidates the model is shown. Enough to make the ordering a real choice, few enough
// that the prompt does not turn into a phone book. NOT a cap on what it may fish — it may use all
// of them if the day fits.
export const CANDIDATE_LIMIT = 12;

/**
 * @param {object}   o
 * @param {string}   o.r2Key        chartpack slug, e.g. 'wateree_lake'
 * @param {number[]} o.ramp         [lon, lat]
 * @param {number[]} o.depthFt      [min, max] the species is using — from trollingIntelligence
 * @param {number}   o.usableAh     already carries the 20% LiFePO4 reserve
 * @param {string[]} o.tackle       exact lure names, from the inventory
 * @param {object[]} [o.inventory]  [{name, type}] so lure names resolve to a connection
 * @param {object[]} [o.catches]    the catch journal, for `yourHistory`
 * @param {function} o.fetchJson    (url) => Promise<object|null>
 * @param {function} o.askModel     ({system, user}) => Promise<string>  raw text
 * @param {function} [o.transitM]   (a, b) => metres over water. Straight line if omitted, which
 *                                  UNDERSTATES cost on a reservoir.
 */
export async function buildSmartPlanV2(o) {
  const base = o.chartpackBase || '';
  const [runsFc, structFc, waterFc, docksFc] = await Promise.all([
    o.fetchJson(`${base}/${o.r2Key}/trolling_runs.geojson`),
    o.fetchJson(`${base}/${o.r2Key}/structure.geojson`),
    o.fetchJson(`${base}/${o.r2Key}/water_features.geojson`),
    // Docks are fourth in the citation count and the pipeline never joined them to the runs.
    // Joined app-side until it does — see dockHits() in plan-candidates.js.
    o.fetchJson(`${base}/${o.r2Key}/docks.geojson`),
  ]);
  const runs = (runsFc && runsFc.features) || [];
  if (!runs.length) {
    // A real and common state: not every pack has trolling runs. Say which, and stop — a plan
    // built without them would be the old "route by re-deriving the lake on a phone" path.
    return { plan: null, problems: [`${o.r2Key} has no trolling runs in its chartpack`], candidates: [] };
  }

  const structures = structureIndex(
    (structFc && structFc.features) || [], (waterFc && waterFc.features) || [],
    (docksFc && docksFc.features) || []);
  const docks = structureIndex((docksFc && docksFc.features) || []);

  const candidates = selectCandidates(runs, {
    ramp: o.ramp, slug: o.r2Key, depthFt: o.depthFt,
    usableAh: o.usableAh, windowMin: o.windowMin,
    structures, catches: o.catches, catchSpecies: o.species, month: o.month,
    // Per species, per season, per lake, from the research profile — see structureWeights().
    weights: o.weights, reliefWeights: o.reliefWeights, docks,
    transitM: o.transitM, limit: CANDIDATE_LIMIT,
  });
  if (!candidates.length) {
    return { plan: null, candidates: [],
             problems: [`nothing on ${o.r2Key} is both inside ${o.depthFt?.[0]}–${o.depthFt?.[1]} ft `
                      + 'and reachable from this ramp inside the day'] };
  }

  // What the lure needs at the business end, resolved by name. Injected as a function so this
  // module never has to know how the inventory is shaped.
  const typeOf = new Map((o.inventory || []).map((l) => [l.name, l.type]));
  const connectionOf = (name) => (typeOf.has(name) ? connectionFor(typeOf.get(name)) : null);
  const snapEligible = (o.inventory || [])
    .filter((l) => connectionFor(l.type) !== 'tie').map((l) => l.name);

  const req = buildPlanRequest({
    candidates: candidates.map((c) => forModel(c)),
    water: o.water, ramp: o.rampName, date: o.date,
    launchTime: o.launchTime, returnTime: o.returnTime,
    species: o.species ? [].concat(o.species) : [],
    conditions: o.conditions, tackle: o.tackle, snapEligible,
    usableAh: o.usableAh, hazards: o.hazards, intel: o.intel,
  });

  let res;
  try {
    res = parsePlanResponse(await o.askModel(req));
  } catch (e) {
    // No fallback plan. The old path had one and it quietly produced a whole day of generic
    // advice that read exactly like a real answer. Failing visibly is better than that.
    return { plan: null, candidates, request: req,
             problems: [`the model's answer could not be read: ${e.message}`] };
  }

  const args = planArgsFrom(res, candidates, { tackle: o.tackle, connectionOf });
  const plan = assemblePlan({
    ...args,
    launch: o.ramp, slug: o.r2Key, water: o.water, ramp: o.rampName, date: o.date,
    launchTime: o.launchTime, returnTime: o.returnTime,
    species: o.species ? [].concat(o.species) : [],
    conditions: o.conditions, usableAh: o.usableAh,
    transit: o.transit,
  });
  plan.notes = args.notes;

  const broken = validatePlan(plan);
  return {
    plan, candidates, request: req, response: res,
    problems: [...args.problems, ...plan.warnings, ...broken],
  };
}

/** The default pack reader: the Worker's chartpack route, which ETags and 304s. */
export function packFetcher(workerUrl) {
  return async (path) => {
    try {
      const r = await fetch(`${workerUrl}/chartpacks${path}`);
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
}

/**
 * The default model caller.
 *
 * The Worker route is still spelled `/groq-query` and it has not called Groq in some time — the
 * chain resolves to Gemini. The route name is history and renaming it would break every existing
 * caller, so it stays; this function is named for what it does. If you are debugging and the
 * X-LLM-Provider header says gemini, that is not a fallback firing, that is normal.
 *
 * JSON mode does survive the hop: `Worker/worker-core.js` translates
 * `response_format: {type:'json_object'}` into Gemini's `responseMimeType: 'application/json'`,
 * and passes `max_tokens` through as `maxOutputTokens`.
 */
export function modelAsker(workerUrl, opts = {}) {
  return async ({ system, user }) => {
    const r = await fetch(`${workerUrl}/groq-query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        // Six rods with a reason each, a leg per candidate, stops carrying presentation and
        // positioning, and a 150-word sonar narrative. Truncation here does not degrade the
        // answer, it DESTROYS it — a cut-off JSON object will not parse, and this path has no
        // fallback plan on purpose. Worker/worker-core.js passes this straight through as
        // Gemini's maxOutputTokens, so it is the real ceiling and it is cheap to be generous.
        max_tokens: opts.maxTokens ?? 8000,
        temperature: opts.temperature ?? 0.25,
        response_format: { type: 'json_object' },
      }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    const raw = data.choices?.[0]?.message?.content;
    const content = Array.isArray(raw)
      ? raw.map((p) => (typeof p === 'string' ? p : (p?.text || p?.content || ''))).join('')
      : (raw || data.output_text || '');
    if (!content) throw new Error(`empty content (finish_reason=${data.choices?.[0]?.finish_reason})`);
    return content;
  };
}
