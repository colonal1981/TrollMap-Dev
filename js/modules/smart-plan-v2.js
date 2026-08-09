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
 * @param {function} [o.routeWater] async (from, to) => {distanceM, coordinates} | null, backed by
 *                                  POST /water/<slug>/route. Without it every transit is a
 *                                  straight line between two leg ends, which can cross land.
 * @param {function} [o.transit]    a synchronous transit function, for tests. Wins over routeWater.
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

  // THE TRANSITS ARE ROUTED OVER WATER, OR THEY SAY THEY ARE NOT.
  //
  // PLAN_SCHEMA_V2 has carried "Transit is still straight-line ... wire waterPath from
  // Worker/water.js into them" as advice through three revisions and it was built in none. Every
  // transit in every shipped plan was a straight line between two leg ends: it understates the
  // amp-hours on a reservoir, and it can cross land. The Worker has answered this since
  // Worker/water.js:579 and nothing in js/ had ever called it.
  //
  // assemblePlan() is synchronous and its transit hook is synchronous, so the routes are fetched
  // HERE, up front, for the pairs the ordered plan will ask for -- launch to the first leg's
  // head, each leg's tail to the next leg's head, and the last leg's tail back to the ramp. The lookup handed to the assembler is a
  // plain map read. A pair the router could not answer returns null and the assembler falls back
  // to a straight line that MARKS ITSELF unrouted; nothing pretends a straight line was routed.
  const transit = o.transit || await prefetchTransits(args.candidates, o.ramp, o.routeWater);

  const plan = assemblePlan({
    ...args,
    launch: o.ramp, slug: o.r2Key, water: o.water, ramp: o.rampName, date: o.date,
    launchTime: o.launchTime, returnTime: o.returnTime,
    species: o.species ? [].concat(o.species) : [],
    conditions: o.conditions, usableAh: o.usableAh,
    transit,
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


/** Six decimals is ~11 cm — the same point twice always lands on the same key. */
const pairKey = (a, b) => `${a[0].toFixed(6)},${a[1].toFixed(6)}>${b[0].toFixed(6)},${b[1].toFixed(6)}`;

/**
 * Fetch every transit the ordered plan will ask for, in parallel, and hand back a synchronous
 * lookup. Returns null when there is no router or nothing answered, which leaves assemblePlan on
 * its straight-line fallback — and that fallback marks itself.
 *
 * A router that throws or times out is not an error worth failing a plan over: the plan is still
 * fishable, it just has a transit nobody water-tested, and the leg, the warnings list and
 * validatePlan() all say so.
 */
export async function prefetchTransits(candidates, launch, routeWater) {
  if (typeof routeWater !== 'function' || !Array.isArray(candidates) || !candidates.length) return null;
  const pairs = [];
  let cursor = launch;
  for (const c of candidates) {
    if (Array.isArray(cursor) && Array.isArray(c.start)) pairs.push([cursor, c.start]);
    cursor = c.end;
  }
  // AND THE PAIR HOME. assemblePlan() asks for the last leg's tail back to the ramp now that the
  // route home is a real leg, and a pair nobody prefetched comes back null -- which would leave
  // the one leg he cannot do without as a straight line every single time.
  if (Array.isArray(cursor) && Array.isArray(launch)) pairs.push([cursor, launch]);
  const routed = new Map();
  await Promise.all(pairs.map(async ([a, b]) => {
    try {
      const r = await routeWater(a, b);
      if (r && Array.isArray(r.coordinates) && r.coordinates.length >= 2 && Number.isFinite(r.distanceM)) {
        routed.set(pairKey(a, b), { distanceM: r.distanceM, coordinates: r.coordinates });
      }
    } catch (e) {
      console.warn('[plan-v2] transit not routed:', e.message);
    }
  }));
  if (!routed.size) return null;
  return (a, b) => routed.get(pairKey(a, b)) || null;
}

/**
 * The default water router: POST /water/{slug}/route, the endpoint Worker/water.js has answered
 * since it was written and that nothing in the browser had ever called.
 *
 * Coordinates in and out are [lon, lat], which is what the plan uses everywhere. A 404 means this
 * pack has no water_graph — a real and common state while an upload catches up — and it is not
 * distinguished from any other failure here, because the caller's response to all of them is the
 * same: leave the transit unrouted and say so.
 */
export function waterRouter(workerUrl, slug, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 12000;
  return async (from, to) => {
    const r = await fetch(`${workerUrl}/water/${encodeURIComponent(slug)}/route`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from, to }),
      signal: AbortSignal.timeout?.(timeoutMs),
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!Array.isArray(d.coordinates) || d.coordinates.length < 2) return null;
    return { distanceM: Number(d.distance_m) || 0, coordinates: d.coordinates };
  };
}
