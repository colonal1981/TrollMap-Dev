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

import { selectCandidates, structureIndex, forModel, orientLegs, poiSpotFeatures,
         attractorSpotFeatures, chartedGrid, chartedHazards } from './plan-candidates.js';
import { buildPlanRequest, parsePlanResponse, planArgsFrom } from './plan-prompt.js';
// THE PACK'S OWN FACTS. Pure, and it takes the layers fetched below -- see researchIntel() in
// plan-inputs.js and THE_PROFILE_BECAME_A_CACHE_AND_NOBODY_MOVED_THE_READS_2026-09-01.md item 1.
import { packDerivedFacts } from '../utils/pack-facts.js';
import { assemblePlan, validatePlan } from './plan-assemble.js';
import { connectionFor, snapEligibleFrom } from '../data/lure-knowledge.js';

// How many candidates the model is shown. Enough to make the ordering a real choice, few enough
// that the prompt does not turn into a phone book. NOT a cap on what it may fish — it may use all
// of them if the day fits.
export const CANDIDATE_LIMIT = 12;

/**
 * @param {object}   o
 * @param {string}   o.r2Key        chartpack slug, e.g. 'wateree_lake'
 * @param {number[]} o.ramp         [lon, lat]
 * @param {number[]} o.fishDepthFt  [min, max] where the FISH are — from trollingIntelligence.
 *                                 Renamed from `depthFt` 2026-08-10: that name already meant a
 *                                 leg's WATER depth downstream, and one name for two quantities
 *                                 is what let a fish band be compared against a contour.
 * @param {string}   [o.holding]   'bottom' | 'suspended' | 'both' | null — which constraint the
 *                                 water is under. See eligibleForHolding() in plan-candidates.js.
 * @param {number}   o.usableAh     already carries the 20% LiFePO4 reserve
 * @param {string[]} o.tackle       exact lure names, from the inventory
 * @param {object[]} [o.inventory]  [{name, type}] so lure names resolve to a connection
 * @param {object[]} [o.catches]    the catch journal, for `yourHistory`
 * @param {function} o.fetchJson    (url) => Promise<object|null>
 * @param {function} o.askModel     ({system, user}) => Promise<string|{content, meta}>
 *                                  A bare string is still valid; modelAsker() returns the pair
 *                                  so the plan can record what the call cost and how it ended.
 * @param {function} [o.transitM]   (a, b) => metres over water. Straight line if omitted, which
 *                                  UNDERSTATES cost on a reservoir.
 * @param {function} [o.routeWater] async (from, to) => {distanceM, coordinates} | null, backed by
 *                                  POST /water/<slug>/route. Without it every transit is a
 *                                  straight line between two leg ends, which can cross land.
 * @param {function} [o.transit]    a synchronous transit function, for tests. Wins over routeWater.
 * @param {object}   [o.waterState] fetchWaterState() output — {featureType, river, tidal}
 */
export async function buildSmartPlanV2(o) {
  const base = o.chartpackBase || '';
  const [runsFc, structFc, waterFc, docksFc, poisFc] = await Promise.all([
    o.fetchJson(`${base}/${o.r2Key}/trolling_runs.geojson`),
    o.fetchJson(`${base}/${o.r2Key}/structure.geojson`),
    o.fetchJson(`${base}/${o.r2Key}/water_features.geojson`),
    // Docks are fourth in the citation count and the pipeline never joined them to the runs.
    // Joined app-side until it does — see dockHits() in plan-candidates.js.
    o.fetchJson(`${base}/${o.r2Key}/docks.geojson`),
    // FIFTH, AND THE ONE THAT WAS MISSING. timber, shallow, hazard, attractor, pile and bridge
    // are 17% of Wateree's near[] marks and live only here — see poiSpotFeatures(). Optional:
    // a pack without pois is a pack whose runs carry no marks of those kinds either.
    Promise.resolve(o.fetchJson(`${base}/${o.r2Key}/pois.geojson`)).catch(() => null),
  ]);
  const runs = (runsFc && runsFc.features) || [];
  if (!runs.length) {
    // A real and common state: not every pack has trolling runs. Say which, and stop — a plan
    // built without them would be the old "route by re-deriving the lake on a phone" path.
    return { plan: null, problems: [`${o.r2Key} has no trolling runs in its chartpack`], candidates: [] };
  }

  const poiSpots = poiSpotFeatures(poisFc);
  const structures = structureIndex(
    (structFc && structFc.features) || [], (waterFc && waterFc.features) || [],
    (docksFc && docksFc.features) || [], poiSpots);
  const docks = structureIndex((docksFc && docksFc.features) || []);
  // The state's own attractors, minus the ones Garmin already charted. Injected as rows rather
  // than fetched, like everything else this module reads, so the whole path still runs in a test
  // with no network.
  // SAME FILTER, SAME REASON. Smart Plan was scoring days against every attractor in four
  // states; a brushpile on Lake Monticello has no business weighting a leg on Wateree.
  const onWater = chartedGrid([runs, (structFc && structFc.features) || [],
                               (waterFc && waterFc.features) || [],
                               (docksFc && docksFc.features) || []]);
  const attractors = structureIndex(attractorSpotFeatures(o.dnrAttractors, poiSpots,
                                    { onWater, where: `smart-plan ${o.r2Key}` }));

  const candidates = selectCandidates(runs, {
    ramp: o.ramp, slug: o.r2Key, fishDepthFt: o.fishDepthFt, holding: o.holding,
    usableAh: o.usableAh, windowMin: o.windowMin,
    structures, catches: o.catches, catchSpecies: o.species, month: o.month,
    // Per species, per season, per lake, from the research profile — see structureWeights().
    weights: o.weights, reliefWeights: o.reliefWeights, docks, attractors,
    transitM: o.transitM, limit: CANDIDATE_LIMIT,
  });
  if (!candidates.length) {
    // SAY WHICH TEST EMPTIED IT. selectCandidates now reports the rule it applied and how many
    // runs each stage rejected, so "the band is wrong" and "this fish does not live on this lake"
    // stop reading as the same failure. The old message named a band and a ramp and left him to
    // guess which of the two was the problem.
    const s = candidates.selection || {};
    const r = s.rejected || {};
    const [lo, hi] = o.fishDepthFt || [];
    return { plan: null, candidates: [],
             problems: [`nothing on ${o.r2Key} is both fishable for ${lo}–${hi} ft fish `
                      + `(${s.depthRule || 'depth rule unknown'}) and reachable from this ramp `
                      + `inside the day — of ${s.considered ?? runs.length} runs, ${r.depth ?? 0} `
                      + `failed the depth rule, ${r.noWindow ?? 0} had no window worth trolling, `
                      + `${r.scoreless ?? 0} passed nothing worth trolling`
                      + (s.holdingUnknown ? ' · holding unknown for this species and season, so '
                                          + 'the old fish-band-vs-water-depth test was used' : '')] };
  }

  // What the lure needs at the business end, resolved by name. Injected as a function so this
  // module never has to know how the inventory is shaped.
  const typeOf = new Map((o.inventory || []).map((l) => [l.name, l.type]));
  const connectionOf = (name) => (typeOf.has(name) ? connectionFor(typeOf.get(name)) : null);
  // Was `connectionFor(l.type) !== 'tie'` written out here, which is canTakeSnap() with the
  // table's own name filed off -- and Pick Water, reading the same bag, had no copy at all.
  const snapEligible = snapEligibleFrom(o.inventory);
  // The other half of the same idea: which of the bag may be trolled at all.
  const trollable = (o.inventory || []).filter((l) => l && l.trollable).map((l) => l.name);

  // THE CHART THIS PLAN IS BEING BUILT ON, not the chart that was current the day somebody
  // clicked research. structFc, waterFc and poisFc were fetched at the top of this function; the
  // derivation is the same one a research run makes and is free on what is already in hand.
  //
  // NO DEPTH AREAS HERE, DELIBERATELY. This planner does not fetch them and they are the biggest
  // file in the pack -- 18.6 MB on Wateree. So max and average depth still come from the profile
  // on this path, and structure, coves, creek mouths, POIs, attractors and bottom come from the
  // chart. Pick Water fetches depth_areas for its own reasons and gets the depths with them.
  //
  // `intelFor` is a callback rather than a value because the caller holds the profile, the species
  // and the season while this function holds the pack, and neither can build the line alone. A
  // caller that passes plain `intel` still works, which is what every test does.
  const packFacts = packDerivedFacts({
    lakeName: o.water || o.r2Key, structGeo: structFc, featGeo: waterFc, poiGeo: poisFc,
    depthGeo: null, boundaryGeo: null, contourGeo: null,
  });
  const intel = typeof o.intelFor === 'function' ? o.intelFor(packFacts) : o.intel;

  const req = buildPlanRequest({
    candidates: candidates.map((c) => forModel(c)),
    water: o.water, ramp: o.rampName, date: o.date,
    launchTime: o.launchTime, returnTime: o.returnTime,
    species: o.species ? [].concat(o.species) : [],
    conditions: o.conditions, tackle: o.tackle, snapEligible, trollable,
    // So the prompt can say HOW each bait reaches a depth rather than leaving the model to read
    // one off the lure's name -- see depthNote() in plan-prompt.js.
    lureByName: o.lureByName,
    usableAh: o.usableAh, intel,
    // THE CHART FIRST, THE RESEARCH SECOND. The charted ones come out of the pack this function
    // already fetched; the wiring adds the profile's prose. Each line says which it is, so when
    // navigation.hazards retires this half simply goes empty and the sentence still stands.
    // The charted POI layer, and nothing else. `o.hazards` was the research agent's prose and the
    // wiring stopped filling it on 2026-09-01 when the navigation agent retired -- a spread over a
    // value nobody sets is a dead object, so it is gone rather than left looking optional.
    hazards: chartedHazards(poisFc),
    // WHAT THE WATER IS DOING TODAY -- tide on the coast, flow and generation on a river.
    // Absent on a reservoir, and absent is the prompt this file has always built.
    waterState: o.waterState,
  });

  // ── STOP HERE AND HAND BACK THE PROMPT, WITHOUT SPENDING A CALL ───────────────────────────
  //
  // Ryan, 2026-09-04: "i need to see what the agent sees", and the frame that goes with it --
  // "with the refactor we expect the research profile to be thin... so we need to show all of the
  // other data that used to be in the profile that is now live fetched".
  //
  // The research profile is ONE of the 21 inputs buildPlanRequest() reads. The other twenty --
  // conditions, water state, candidates, hazards, the bag, the cast spots -- only exist once the
  // pack has been fetched and the envelope answered, which is everything above this line. So a
  // viewer that lists them from a table would be describing the prompt; this returns the prompt
  // ITSELF, built by the same code on the same inputs, and simply does not send it.
  //
  // `plan: null` and no `response`, because there is no answer. A caller that forgets to check
  // `dryRun` gets a plan-shaped nothing rather than a stale plan, which is the safe way round.
  if (o.dryRun) {
    return { plan: null, candidates, request: req, response: null, exchange: null,
             dryRun: true, problems: [] };
  }

  // AN ASKER MAY RETURN THE TEXT, OR THE TEXT AND WHAT THE CALL COST.
  //
  // 2026-09-04, Ryan: "i want to see the full response from the LLM". modelAsker() below read the
  // HTTP body, kept `choices[0].message.content` and dropped everything else -- finish reason,
  // usage, the body itself -- ONE LINE before it is needed. When a model is cut off mid-JSON the
  // parse fails here, and the single field that would have said WHY had already been thrown away.
  //
  // Widened rather than changed: a plain string is still a valid answer, so every test asker and
  // every other caller keeps working untouched. Only modelAsker() returns the richer shape.
  const answered = await o.askModel(req);
  const raw = (answered && typeof answered === 'object' && typeof answered.content === 'string')
    ? answered
    : { content: String(answered == null ? '' : answered), meta: null };

  let res;
  try {
    res = parsePlanResponse(raw.content);
  } catch (e) {
    // No fallback plan. The old path had one and it quietly produced a whole day of generic
    // advice that read exactly like a real answer. Failing visibly is better than that.
    //
    // AND THE REASON RIDES WITH THE FAILURE. `finish_reason: "length"` beside an unreadable answer
    // is the difference between "the model wrote nonsense" and "we did not give it room to
    // finish", and those have opposite fixes.
    const m = raw.meta || {};
    const cut = m.finishReason && m.finishReason !== 'stop'
      ? ` (finish_reason=${m.finishReason}${m.completionTokens ? `, ${m.completionTokens} tokens out` : ''})`
      : '';
    return { plan: null, candidates, request: req, exchange: raw.meta || null,
             problems: [`the model's answer could not be read: ${e.message}${cut}`] };
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
    // THE SAME RESOLVER THE PROMPT GOT, HANDED TO THE CHECK ON THE ANSWER.
    //
    // Ryan, 2026-09-04: "so you are saying that smartplan can hand me a trolling lane and a lure
    // and not know whether that lure will be lost trolling that lane?" It could, and it did.
    //
    // This line was in plan-from-water.js and not here. capBaitDepth() opens with
    // `if (typeof lureByName !== 'function' ...) return null` -- a silent no-op -- so on this path
    // the ceiling was computed, carried onto every candidate as `maxRunDepthFt`, and then never
    // asked. The model was told how deep each bait runs (buildPlanRequest above gets the same
    // resolver) and the app's own check on what came back never ran once: no lead shortened over
    // a shoal, no jighead fitted, no cast-only rod called out. Every test in
    // test/bait-depth-ceiling.test.js passed throughout, because every one of them called
    // assemblePlan directly and passed the resolver itself.
    lureByName: o.lureByName,
  });
  plan.notes = args.notes;

  const broken = validatePlan(plan);
  return {
    plan, candidates, request: req, response: res, exchange: raw.meta || null,
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
    const u = data.usage || {};
    // EVERYTHING THE BODY SAID ABOUT THE CALL, not just the half we parse. `provider` is read off
    // the response header because the route is still spelled /groq-query and the chain resolves
    // to Gemini -- a plan that says which model answered it is a plan that can be argued with.
    const meta = {
      finishReason: data.choices?.[0]?.finish_reason ?? null,
      model: data.model || null,
      provider: r.headers.get('X-LLM-Provider') || null,
      promptTokens: u.prompt_tokens ?? u.promptTokenCount ?? null,
      completionTokens: u.completion_tokens ?? u.completionTokenCount ?? null,
      totalTokens: u.total_tokens ?? u.totalTokenCount ?? null,
      maxTokens: opts.maxTokens ?? 8000,
      temperature: opts.temperature ?? 0.25,
      bodyBytes: text.length,
      contentChars: content.length,
      askedAt: new Date().toISOString(),
    };
    if (!content) throw new Error(`empty content (finish_reason=${meta.finishReason})`);
    return { content, meta };
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
  // THE SAME ORIENTATION THE ASSEMBLER WILL WALK. A pass can be trolled either way and the app
  // picks which (orientLegs, plan-candidates.js) — so this cannot assume start → end. It did, and
  // the moment the assembler started flipping legs the prefetched pair no longer matched the pair
  // it asked for: `routed.get()` missed, the transit fell back to a straight line and marked
  // itself unrouted. Both callers now read the decision from one place rather than each deriving
  // its own, which is the only way they cannot drift apart.
  const facing = orientLegs(candidates, launch);
  for (const [i, c] of candidates.entries()) {
    const f = facing[i] || { start: c.start, end: c.end };
    if (Array.isArray(cursor) && Array.isArray(f.start)) pairs.push([cursor, f.start]);
    // WHERE THE BOAT STANDS WHEN THE LEG IS DONE, which is not the end of its first pass once a
    // leg can be fished back. `finish` equals `end` on every leg fished once, so this is the same
    // cursor it always was until the model asks for a second pass — and on the leg that does ask,
    // reading `end` here would prefetch a pair the assembler never walks and drop that transit to
    // an unrouted straight line. Same failure the orientation fix above was written for.
    cursor = f.finish || f.end;
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
  // HOW SHALLOW HE WILL CROSS, AND NOBODY HAS EVER ASKED.
  //
  // Ryan, on a transit drawn through a 2-3 ft neck beside an island: "your water graphs are
  // letting the boat go too shallow... i am not portaging the kayak over an island."
  //
  // The Worker has taken `min_depth_ft` since it was written and not one caller has ever sent
  // one, so `minDepth` defaulted to 0 and every route was optimised for distance across anything
  // the graph called water. That was DELIBERATE on the Garmin mesh -- 45% of its nodes are tagged
  // 0 ft, so asking for 3 ft discarded half the lake and the boat could not leave the ramp. The
  // bathymetric graph is 5.2% at 0 ft, so the floor is affordable for the first time.
  //
  // Six feet is his answer, asked directly, and it is the figure the graph was measured against:
  // every transit on the 2026-08-30 Wateree plan came out 1.09-1.13x the straight line with it
  // enforced. It is an option rather than a constant because it is a fact about his boat and his
  // day, not about this module.
  const minDepthFt = opts.minDepthFt ?? 0;
  return async (from, to) => {
    const r = await fetch(`${workerUrl}/water/${encodeURIComponent(slug)}/route`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minDepthFt > 0 ? { from, to, min_depth_ft: minDepthFt } : { from, to }),
      signal: AbortSignal.timeout?.(timeoutMs),
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!Array.isArray(d.coordinates) || d.coordinates.length < 2) return null;
    // `min_depth_held` IS THE HALF THAT WAS BEING THROWN AWAY. The Worker relaxes the floor
    // rather than failing -- "a plan that quietly ignores the request is as bad as one that
    // fails" -- and says so on the response. This read `distance_m` and `coordinates` and
    // dropped the rest, so the relaxation was silent all the way to the water.
    return { distanceM: Number(d.distance_m) || 0, coordinates: d.coordinates,
             minDepthHeld: d.min_depth_held, askedDepthFt: minDepthFt || undefined,
             shallowM: d.shallow_m, shallowestFt: d.shallowest_ft };
  };
}
