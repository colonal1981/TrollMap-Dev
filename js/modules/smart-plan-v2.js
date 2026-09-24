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

import { selectCandidates, structureIndex, forModel, travelOrder, poiSpotFeatures,
         attractorSpotFeatures, osmShoreFeatures, chartedGrid, chartedHazards,
         turnaroundMiles, riverDay, metresBetween,
         pointToSegmentM } from './plan-candidates.js';
import { buildPlanRequest, parsePlanResponse, planArgsFrom,
         resolveTackleName } from './plan-prompt.js';
// A RIVER LEG IS A DRIFT, NOT A LANE. See river-drifts.js for what that means, what it measures
// and why the trolling runs are the wrong object on moving water.
import { riverDriftRuns, driftCurrentSummary, centrelineTransit, waterTest } from './river-drifts.js';
// THE PACK'S OWN FACTS. Pure, and it takes the layers fetched below -- see researchIntel() in
// plan-inputs.js and THE_PROFILE_BECAME_A_CACHE_AND_NOBODY_MOVED_THE_READS_2026-09-01.md item 1.
import { packDerivedFacts } from '../utils/pack-facts.js';
import { assemblePlan, validatePlan } from './plan-assemble.js';
import { connectionFor, snapEligibleFrom } from '../data/lure-knowledge.js';
// ONE SPELLING OF "IS THIS A RIVER", shared with the Water tab -- see saysRiver() for why it is not
// a string compare in two files, and why it is not `waterState.river`.
import { saysRiver } from './plan-inputs.js';
import { launchRouteFor } from '../data/launch-reach.js';

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
 * @param {string[]} [o.lightFacts] the profile's light-tagged sourced facts, from lightFactsFrom()
 * @param {object}   [o.inshoreSeason] inshoreSeasonFor() output — the intercept survey's answer
 *                                 for this fish, this state, this two-month wave. Coastal only.
 * @param {object}   [o.seabedHabitat] seabedHabitatFor() output — the habitat matrix beside the
 *                                 ENC's charted bottom for this zone. Coastal only.
 */
export async function buildSmartPlanV2(o) {
  const base = o.chartpackBase || '';
  const [runsFc, structFc, waterFc, docksFc, poisFc, centrelineFc, boundaryFc, osmFc] = await Promise.all([
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
    // SIXTH, AND RIVERS ONLY. build_river_centrelines.py put one of these in all 57 river packs on
    // 2026-09-16 -- the 3DHP mainstem in downstream order, a station every 50 m carrying a bearing,
    // a bend radius, a channel width and a charted cross-section -- and until now NOTHING in js/ or
    // Worker/ opened it. A lake pack has none, which is why this is optional in exactly the way
    // pois.geojson is.
    //
    // IT IS NOT CLIPPED TO THE RIVER'S OWN BOUNDARY, whatever this comment used to say. A geoconnex
    // mainstem does not stop where a river's name does: congaree_river's line starts on the Broad
    // above Columbia and carries on 26 km past the Wateree junction into Lake Marion. That is what
    // the boundary below is fetched for.
    Promise.resolve(o.fetchJson(`${base}/${o.r2Key}/centreline.geojson`)).catch(() => null),
    // SEVENTH: WHERE THIS WATER ACTUALLY IS. The same polygon the research engine has fetched for a
    // year, asked here for one number per end -- see waterSpanM() in river-drifts.js. Optional and
    // caught like the two above: without it the reaches cover the whole traced line, which is what
    // they did until 2026-09-19, and the day Ryan got ran 3.4 km of Congaree and 4.6 km of Lake
    // Marion under one name.
    Promise.resolve(o.fetchJson(`${base}/${o.r2Key}/boundary.geojson`)).catch(() => null),
    // EIGHTH: THE OSM BRIDGES AND PIERS. In R2 beside the pack since fetch_osm_structures.py ran
    // and drawn by the map's OSM toggle; the planner never read them. Optional like the three above.
    // See osmShoreFeatures() in plan-candidates.js for what is kept and why.
    Promise.resolve(o.fetchJson(`${base}/${o.r2Key}/osm-structures.geojson`)).catch(() => null),
  ]);
  const runs = (runsFc && runsFc.features) || [];
  // A RIVER DOES NOT NEED LANES, AND THIS REFUSED TO PLAN ONE WITHOUT THEM.
  //
  // `legRuns = drifts || runs` below: on moving water the candidates come from the centreline and
  // `runs` is never read again. But this guard fired first and did not know what water it was on, so
  // a river pack was unplannable unless it shipped a trolling_runs.geojson -- which is the very
  // object the drift work replaced, because a fitted lane is the wrong shape on a river. The
  // Congaree's is 87 MB of it, kept alive in R2 by this line alone.
  //
  // Ryan, 2026-09-19: "why would we need trolling runs for a river... i thought we decided that they
  // are not needed for rivers". We did, on 2026-09-16, and this is the line that never heard.
  //
  // So the question is now the right one: is there anything to plan FROM. A centreline is enough on
  // its own; the river branch below still refuses a river whose centreline is missing or empty, and a
  // lake with no lanes is refused here exactly as before.
  const centrelineReady = !!(centrelineFc && Array.isArray(centrelineFc.features)
                             && centrelineFc.features.length);
  // WHAT WAS WRONG WITH THE PACK ITSELF, CARRIED OUT OF EVERY EXIT.
  //
  // A complaint about a missing layer belongs to the pack and not to the outcome, so it must not
  // depend on the day getting as far as a plan. Written here, where the layers land, and spread into
  // each return below -- there are seven, and a note that only speaks from the last one is a guard
  // that goes quiet exactly when something else has already gone wrong.
  const packProblems = [];
  if (centrelineReady && !boundaryFc) {
    packProblems.push(`${o.r2Key} is a river and its chartpack carries no boundary.geojson, so the `
                    + 'reaches cover the whole traced mainstem -- which runs past this river at both '
                    + 'ends, into whatever water is next. Publish the boundary for this pack and the '
                    + 'day stops where the water does.');
  }
  if (!runs.length && !centrelineReady) {
    return { plan: null, candidates: [],
             problems: [...packProblems, `${o.r2Key} has no trolling runs in its chartpack and no centreline either, `
                      + 'so there is nothing to lay a day out on'] };
  }

  const poiSpots = poiSpotFeatures(poisFc);
  const structures = structureIndex(
    (structFc && structFc.features) || [], (waterFc && waterFc.features) || [],
    (docksFc && docksFc.features) || [], poiSpots);
  const docks = structureIndex((docksFc && docksFc.features) || []);
  // THE CHARTED POIs, FOR THE PER-RUN JOIN. `poiSpots` already feeds structureIndex above, which
  // is RESOLUTION -- turning a `near[]` mark into a position. This is the other half: the index
  // the selector walks to find the POIs a run passes, now that the pipeline no longer writes them
  // into `near[]`. Same object, two jobs, one build.
  const pois = structureIndex(poiSpots);
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
  // THE OSM BRIDGES AND PIERS: on this water, not already a Garmin dock, not on a coastal zone
  // whose ENC layer already carries them. See osmShoreFeatures().
  const shore = structureIndex(osmShoreFeatures(osmFc, docksFc,
    { onWater, coastal: String(o.r2Key || '').startsWith('coast_') }));

  // ── A RIVER LEG IS A DRIFT, NOT A LANE ───────────────────────────────────────────────────────
  //
  // Ryan, 2026-09-16, after this function came back with nothing twice on congaree_river: "for most
  // narrower rivers there aren't going to be a bunch of different lanes you can follow... you are
  // going to either pick a side or the middle... i am not equipped on the kayak to really anchor on
  // a river so i am going to be moving no matter what." Then: "its the routes just like i thought."
  //
  // He was right about where it broke. Of the Congaree's 1,473 trolling runs, 915 were rejected as
  // unreachable over the water graph and 415 as not fitted -- 90% of the water gone to two tests
  // that are both about LANES, before depth was consulted at all. The graph could not route them
  // because its cells are wider than a 145 m channel, so the chord between two cell centres cuts
  // the inside of every bend. The charted water's own continuity, measured with no land test, is
  // 88-99%. The river was never discontinuous; the lane routing was.
  //
  // So on a river the lines come from the centreline instead, and EVERYTHING AFTER THIS POINT IS
  // UNCHANGED -- same window slider, same structure scoring, same per-type caps, same battery and
  // trip-window checks, same spatial dedupe, same ranking. A drift differs from a contour lane in
  // where the line comes from, not in what a leg is.
  //
  // AND THERE IS NO SILENT FALLBACK TO THE LANES. A river whose pack has no centreline says so and
  // stops, because quietly planning a river as a reservoir is exactly how this failure stayed
  // invisible while the bench blamed the depth rule.
  // WHAT MAKES THIS A RIVER, AND WHY IT IS NOT `waterState.river`.
  //
  // The first version of this tested `!!o.waterState.river` and it was wrong twice over.
  // `waterState.river` is a DETAILS OBJECT -- flow, stage, gauge, generating -- not a flag, and
  // fetchWaterState() only builds it when the live /conditions call came back: `const river = c &&
  // (isRiver || c.flowCfs != null || c.generatingNow != null) ? prune({...})`. So a timeout on that
  // request would have quietly planned the Congaree as a reservoir over lanes, which is the failure
  // the comment beside that very line warns about -- "a network failure quietly deleting a
  // constraint". And it fires on a LAKE: a Duke tailwater with `generatingNow` gets a river block
  // too, which would have sent this function looking for a centreline in a reservoir pack and made
  // it refuse to plan the lake at all.
  //
  // `featureType` is the real answer and it falls back to the registry record, so it survives a
  // dead gauge. Beside it, the PACK ITSELF is evidence that needs no network: only a river pack has
  // a centreline, because build_river_centrelines.py only writes one for a river. Either signal is
  // enough, and together they mean a river with a silent gauge still gets drifts while a lake can
  // never be mistaken for one.
  // saysRiver() rather than a string compare written out here, because the Water tab asks the same
  // question of a registry row and two spellings of one question is how they would come to disagree
  // about the same water. See its note in plan-inputs.js.
  const stateSaysRiver = saysRiver(o.waterState);
  // The same test the guard above already made. One spelling, because two of them are how they come
  // to disagree about one pack.
  const packHasCentreline = centrelineReady;
  const isRiver = stateSaysRiver || packHasCentreline;
  if (isRiver && !packHasCentreline) {
    return { plan: null, candidates: [],
             problems: [...packProblems, `${o.r2Key} is a river and its chartpack carries no centreline.geojson, so `
                      + 'a drift cannot be laid out — and its trolling runs are lanes, which is the '
                      + 'wrong object on moving water. Build and upload the centreline layer for '
                      + 'this pack before planning it.'] };
  }
  // ONE NUMBER, TWO READERS. How far off a line a feature can be and still be on the way is one
  // question with one answer, and both the drift builder and the selector need it; the leg ceiling
  // is the same. Set here once and handed to both, rather than defaulted in two files where they
  // would come apart the first time either was tuned.
  const maxOffM = o.maxOffM ?? 100;
  const legMaxM = o.maxM ?? 8000;
  // BUILT BEFORE THE DRIFTS, BECAUSE THE DRIFTS NOW NEED IT. It memoises every point it is asked
  // about and the ramp is the same point on every call, so projecting the ramp here costs the one
  // scan the transit was going to pay for anyway.
  const riverTransit = isRiver && packHasCentreline ? centrelineTransit(centrelineFc) : null;
  // WHERE HE LAUNCHES, AS A STATION ON THIS RIVER. The day is one path through it -- out, turn,
  // back -- so this is what the reaches are laid out from; see riverDriftRuns(). Null only when the
  // centreline could not be projected at all, and the reaches then fall back to the whole river,
  // which is the layout that produced the 731-minute bench.
  // THE RAMP'S OWN ROUTE DECIDES WHERE THE DAY STARTS, NOT THE RAMP. Fetched here rather than
  // below because the reaches are laid out from this station and a station taken from the wrong
  // point lays every one of them from the wrong place.
  //
  // Ryan, 2026-09-21, on a plan off Pack's Landing: *"this connection from the transit to the
  // first leg makes 0 sense"*. T1 ran the canal to its mouth, jumped 90 m south-east to where the
  // leg began, and L1 then doubled straight back over the same water. That spur is this line: the
  // ramp sits 1.8 km down a canal, its own projection onto the Congaree lands downstream of where
  // the canal actually comes out, and the reaches were anchored there. He does not arrive at his
  // ramp's projection. He arrives at the END OF THE ROUTE HE TRAVELLED, which build_ramp_reach
  // measured and launches.json already carries, channel end first.
  const rampRoute = await launchRouteFor(o.r2Key, o.ramp && o.ramp[1], o.ramp && o.ramp[0]);
  const arriveAt = (Array.isArray(rampRoute) && rampRoute.length >= 2) ? rampRoute[0] : o.ramp;
  const rampStationM = riverTransit && typeof riverTransit.stationAt === 'function'
    ? riverTransit.stationAt(arriveAt) : null;
  const drifts = isRiver && packHasCentreline
    ? riverDriftRuns(centrelineFc, { structures, slug: o.r2Key, maxOffM, maxM: legMaxM,
                                     rampStationM,
                                     // WHERE THE RIVER ENDS. Null on a pack whose boundary is not
                                     // published, and the reaches then cover the whole line.
                                     boundary: boundaryFc,
                                     // Q FOR Q/A, FROM THE READING THE PREFLIGHT ALREADY TOOK. The
                                     // discharge has been reaching the prompt as a raw ft3/s number
                                     // since plan-prompt.js was written; this is what turns it into
                                     // a speed and a direction. 53 of 57 rivers publish 00060 and 47
                                     // carry an NWM reach, so it can be forecast as well as read.
                                     flowCfs: (o.waterState && o.waterState.river
                                               && o.waterState.river.flowCfs) ?? null,
                                     // AND THE ELEVEN WHERE IT DOES NOT APPLY. A tidal river's
                                     // current reverses twice a day, so an instantaneous discharge
                                     // is not its flow -- the drift says so rather than quoting a
                                     // number that is wrong half of every day.
                                     tidal: !!(o.waterState && o.waterState.tidal) })
    : null;
  if (drifts && !drifts.length) {
    return { plan: null, candidates: [],
             problems: [...packProblems, `${o.r2Key} has a centreline and it yielded no drift at all — no reach of `
                      + 'it carried two stations and a length, so the layer is present and empty'] };
  }
  const legRuns = drifts || runs;
  // THE DAY'S CURRENT AND WHERE IT TURNS HIM AROUND, for the prompt block that has been asking for
  // both since it was written and had only a raw discharge in ft3/s to answer with -- which is not a
  // speed. Computed HERE, where the drifts are: the prompt formats and does not calculate. Null on a
  // lake, so that block cannot print a river sentence about still water.
  const driftCurrent = drifts ? driftCurrentSummary(drifts) : null;
  const riverCurrent = driftCurrent ? {
    ...driftCurrent,
    turnaround: turnaroundMiles({ usableAh: o.usableAh, windowMin: o.windowMin,
                                  trollMph: o.trollMph ?? 2.0,
                                  currentMph: driftCurrent.medianMph }),
  } : null;

  let candidates = selectCandidates(legRuns, {
    ramp: o.ramp, slug: o.r2Key, fishDepthFt: o.fishDepthFt, holding: o.holding,
    usableAh: o.usableAh, windowMin: o.windowMin, maxOffM, maxM: legMaxM,
    structures, catches: o.catches, catchSpecies: o.species, month: o.month,
    // THE PACK'S OWN OUTLINE, so a catch logged at a position that is not on this water cannot
    // stand in as evidence about it. Null where the pack ships no boundary -- and then nothing is
    // screened, because "outside" and "nothing to be outside of" are different answers.
    water: waterTest(boundaryFc),
    // Per species, per season, per lake, from the research profile — see structureWeights().
    weights: o.weights, reliefWeights: o.reliefWeights, docks, attractors, pois, shore,
    // ── ON A RIVER THE HOP IS RIVER MILES, NOT A STRAIGHT LINE ────────────────────────────────
    //
    // The straight line is the right answer on a lake and a wrong one on moving water -- see
    // centrelineTransit(). It is passed INSTEAD of `o.transitM` rather than beside it, because a
    // river has one honest transit distance and offering two would be the same field disagreeing
    // with itself. Null centreline falls back to whatever the caller had, which is the lake path.
    transitM: (isRiver && riverTransit) || o.transitM,
    limit: CANDIDATE_LIMIT,
    // ── THE DAY'S WIND, TO THE THING THAT CHOOSES THE DAY ─────────────────────────────────────
    //
    // The forecast has reached this function since plan-preflight.js started returning it, and it
    // went to the prompt and to the safety call and nowhere else. The selector below picks which
    // water is offered at all, and it was picking in flat calm -- so on a day blowing fifteen the
    // model was handed legs chosen as though it were blowing nothing, and then asked whether the
    // day was safe. Now the same forecast reaches both.
    //
    // Reduced to one wind inside selectCandidates() rather than here, because dayCost() on the
    // other path reduces it there too and two readers of "which hour is this day costed against"
    // is how the two planners start disagreeing about one day.
    windByHour: o.windByHour,
  });
  // ── ON A RIVER THE APP DRAWS THE DAY; THE LIST WAS NEVER A CHOICE ─────────────────────────────
  //
  // selectCandidates has done the work that still matters on moving water -- the depth rule, the
  // structure join, the per-reach current, and the battery and window gates -- and then RANKED what
  // survived, because on a lake the model picks between pieces of water. On a river there are no
  // pieces: it is one path through the launch and the only open number is how far out to turn.
  // riverDay() walks outward from the ramp and stops where the budget stops. See its note for the
  // measurement that settled it, and for why there is no transit in a river day.
  //
  // THE RANKING IS NOT WASTED. `score` is what riverDay() weighs the two banks of the ramp by, so
  // the richer side of the launch is fished first.
  //
  // ── AND THE DAY IS TOLD WHAT TIME IT IS ───────────────────────────────────────────────────────
  //
  // riverDay() is the only thing that knows the ORDER a river day is fished in, so it is the only
  // thing that can say what o'clock each pass is -- and until 2026-09-18 nothing asked it to. The
  // model was handed a reach with a DURATION on it and no hour, and then asked which baits to rig
  // for a nine-hour day. See stampPassClock(): the launch clock, the almanac and the sky by the hour
  // are the whole of what it needs, and all three were already in scope here.
  const day = isRiver ? riverDay(candidates, {
    usableAh: o.usableAh, windowMin: o.windowMin, trollMph: o.trollMph ?? 2.0,
    transitMph: o.transitMph ?? 3.5, launchTime: o.launchTime, launch: o.ramp,
    waterState: o.waterState, weatherByHour: o.weatherByHour,
  }) : null;
  if (day) {
    day.selection = candidates.selection;
    candidates = day;
  }
  if (!candidates.length) {
    // SAY WHICH TEST EMPTIED IT. selectCandidates now reports the rule it applied and how many
    // runs each stage rejected, so "the band is wrong" and "this fish does not live on this lake"
    // stop reading as the same failure. The old message named a band and a ramp and left him to
    // guess which of the two was the problem.
    const s = candidates.selection || {};
    const r = s.rejected || {};
    const [lo, hi] = o.fishDepthFt || [];
    // EVERY REASON, LARGEST FIRST -- and this used to name three of nine.
    //
    // Ryan, 2026-09-16, on a Congaree bench plan that came back empty: "of 1473 runs, 101 failed
    // the depth rule, 42 had no window worth trolling, 0 passed nothing worth trolling". That
    // accounts for 143 of 1,473. The dominant reason was UNROUTABLE -- 915 of them, 62% of the
    // water -- and the sentence whose whole job is to say which test emptied the list did not
    // mention it, because it printed `depth`, `noWindow` and `scoreless` and selectCandidates
    // counts nine.
    //
    // Built from the counter object rather than written out per reason, so a tenth filter appears
    // here the day it starts rejecting something. The old form is how the biggest cause stayed
    // invisible: three hand-picked fields cannot grow with the thing they describe.
    const WHY = {
      unroutable: 'could not be reached from the ramp over this water\'s graph',
      unfitted: 'are not fitted lanes, and this pack has fitted lanes',
      depth: 'failed the depth rule',
      noWindow: 'had no window worth trolling',
      scoreless: 'scored nothing worth trolling',
      battery: 'were over the battery budget',
      window: 'fell outside the trip window',
      dedupe: 'duplicated a lane already offered',
      limit: 'were past the candidate limit',
      geometry: 'carried fewer than two coordinates',
    };
    const why = Object.entries(r)
      .filter(([, n]) => Number(n) > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${n} ${WHY[k] || `were rejected by ${k}`}`);
    // A RUN THAT IS IN NO BUCKET IS A FILTER WITHOUT A COUNTER, which is the defect this whole
    // block exists to prevent. selectCandidates computes accountedFor for exactly this check.
    const gap = (s.considered != null && s.accountedFor != null)
      ? s.considered - s.accountedFor : 0;
    return { plan: null, candidates: [],
             problems: [...packProblems, `nothing on ${o.r2Key} is both fishable for ${lo}–${hi} ft fish `
                      + `(${s.depthRule || 'depth rule unknown'}) and reachable from this ramp `
                      + `inside the day — of ${s.considered ?? legRuns.length} `
                      + `${drifts ? 'drifts' : 'runs'}, `
                      + (why.length ? why.join('; ') : 'none were rejected by any rule, which '
                                                     + 'means none were offered either')
                      + (gap ? ` · ${gap} run(s) fell out of no counted rule at all — a filter `
                             + 'has been added without a counter' : '')
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
  // THE SAME DOOR, FOR THE THING THE PROFILE COULD NOT ANSWER. `thermoclineNormFor()` needs the
  // profile to know whether a cast already answered -- if one did it returns null and the block
  // never prints -- and it needs the pack for the depth. Neither side has both, which is why
  // `intelFor` is a callback, and this rides the same reason rather than inventing a second one.
  const thermoclineNorm = typeof o.thermoclineNormFor === 'function'
    ? o.thermoclineNormFor(packFacts) : (o.thermoclineNorm || null);

  const req = buildPlanRequest({
    candidates: candidates.map((c) => forModel(c)),
    water: o.water, ramp: o.rampName, date: o.date,
    launchTime: o.launchTime, returnTime: o.returnTime,
    species: o.species ? [].concat(o.species) : [],
    conditions: o.conditions, tackle: o.tackle, snapEligible, trollable,
    // So the prompt can say HOW each bait reaches a depth rather than leaving the model to read
    // one off the lure's name -- see depthNote() in plan-prompt.js.
    lureByName: o.lureByName,
    usableAh: o.usableAh, intel, thermoclineNorm, riverCurrent,
    // WHEN THIS FISH IS CAUGHT INSHORE IN THIS STATE, from NOAA's intercept survey. Straight
    // through -- it needs no pack and no profile, only a state, a species and the date, all of
    // which the caller already resolved. Null on every inland water, which is the prompt that
    // was there before.
    inshoreSeason: o.inshoreSeason || null,
    // AND WHAT THE BOTTOM IS UNDER IT. Same shape, same reason: a zone key and a species,
    // both already resolved by the caller, and null on every inland water.
    seabedHabitat: o.seabedHabitat || null,
    // THE ONE MEASURED NUMBER THE BAIT GATE STANDS ON. See the gate in plan-prompt.js: the box
    // offered to the model is filtered to what can physically reach the deepest oxygenated water,
    // and this is that depth. Null until somebody casts the water, and then the gate goes silent
    // rather than inventing a constraint.
    oxygenFloorFt: typeof o.oxygenFloorFor === 'function'
      ? o.oxygenFloorFor(packFacts) : (o.oxygenFloorFt ?? null),
    inventory: o.inventory || null,
    // No dayMin on this path: selectCandidates() trims the OFFER to the window and the model
    // chooses which of them to fish, so there is no picked-set total yet. The window itself is
    // the constraint and it still has to be said.
    windowMin: o.windowMin,
    // THE SKY BY THE HOUR, for lightPromptBlock(). Computed by fetchForecast() since it was
    // written and read only by the post-plan notification cues -- the model was never told
    // whether the day was overcast, which is half of what 'low light' means.
    weatherByHour: o.weatherByHour,
    // AND THE ONLY SOURCED LIGHT GUIDANCE THIS APP HAS, which is the other half. The research
    // agents write `_extractedFacts` with a fact, its quote and its source, and some of those tie a
    // depth or a presentation to the light -- Marion's "shallow flats less than 6 feet deep early
    // and late, then drift-fishing deeper water along the channels mid-day". Nothing outside the
    // research pipeline had ever read one. Selected by lightFactsFrom() at the wiring, where the
    // profile lives, and sent already rendered like `intel` is.
    lightFacts: o.lightFacts || null,
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
    // ── WHERE THE DRAWN DAY TURNS, AND WHAT IT LEFT BEHIND ────────────────────────────────────
    //
    // riverDay() has hung `.day` on its own output since it was written -- the turnaround, the
    // fished total, what stopped the day going further, what is left unspent, and BOTH arms of the
    // launch with the one that was taken first marked. Its own comment says `offered` is there "so a
    // plan can say what it did NOT take and why", and no plan ever said it, because nothing in the
    // codebase read the object. `candidates.map()` below drops it, so it is named here.
    //
    // CALLED `drawnDay` AND NOT `riverDay`, and the reason is the guard in
    // one-prompt-two-planners.test.js: it checks each planner MENTIONS every field the prompt reads,
    // and `riverDay` is already an import in this file -- so a field by that name would have passed
    // the guard on the day it was added whether or not it was ever wired. A name nothing else uses
    // is a name the guard can actually see. That exact failure is why the test exists.
    drawnDay: candidates.day || null,
    // AND WHETHER THIS IS A RIVER, DECIDED ONCE, HERE. The prompt used to re-derive it from
    // `waterState.featureType` alone -- so a river whose /conditions call timed out was handed
    // river candidates under the lake rules: order the legs to save deadhead, and stop and cast on
    // the good structure. This is the same answer the drifts were built from, which is the point.
    isRiver,
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
             dryRun: true, problems: [...packProblems] };
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
             problems: [...packProblems, `the model's answer could not be read: ${e.message}${cut}`] };
  }


  // ── A HARD RULE IS ENFORCED, NOT REPORTED ─────────────────────────────────────────────────
  //
  // Ryan, 2026-09-21, on a plan whose warning list ran to eleven items: *"what is all this
  // noise... if i am going to get 11 things that are wrong on every plan we make out of here i
  // will never read any of it"*. Two of those eleven were real and both were this one: the answer
  // put a Creature Bait / Craw on R4 and a Straight Tail Worm on R1, and deployed both, so on Leg
  // 3 and Leg 4 one of the two rods in the water was fishing nothing. A quarter of the day's
  // rod-time, reported as prose.
  //
  // THE PROMPT ALREADY SAYS IT, IN CAPITALS, OFF THIS EXACT LIST. `trollable` is built once above
  // and handed to buildPlanRequest, which prints "NOT ON THE WATER TODAY ... Do not name one on a
  // rod" from it. Reading the same variable here is the whole point: the rule the answer is
  // checked against cannot drift away from the rule the answer was given.
  //
  // ONE RE-ASK, AND ONLY ONE. A slip costs a round trip to fix and a rod fishing nothing costs
  // hours. Twice is not a slip, and that is when it becomes worth his attention -- so a break that
  // survives the correction is the only version of this he ever reads.
  //
  // The corrected prompt REPLACES `req.user`, so the saved plan shows what was actually asked
  // rather than the first draft of it. Nothing new is stored and nothing reads a field that did
  // not exist before.
  // AND IT IS ONLY A RULE WHERE THE BAG STATES ONE. `trollable` is the inventory's own flag, and
  // an inventory that never sets it produces an EMPTY list -- against which every bait in the box
  // reads as cast-only and every plan gets sent back. A bag that does not say which of it can be
  // trolled has not been contradicted by an answer that trolls something; it has said nothing.
  // ── AND IT IS MATCHED THE WAY THE REST OF THE PLANNER MATCHES, NOT BY THE RAW STRING ────────
  //
  // The bag holds `Straight Tail Worm 6-7"`, and an unescaped inch mark would end the JSON string
  // the model is asked to write -- so promptSafeTackleName() sends `Straight Tail Worm 6-7in` and
  // the model faithfully echoes that back. This compared the echo against a Set of the bag's OWN
  // spelling, so both `inBag.has()` and `trollSet.has()` missed, every inch-marked bait read as
  // "not in the bag", and the re-ask never fired for one.
  //
  // MEASURED ON THE PLAN THAT FOUND IT, 2026-09-21, Pack's Landing: the answer put a Straight Tail
  // Worm on R3, seatRods moved it to R2, and it went in the water as the port rod on BOTH fished-
  // back legs -- 292 of the day's 840 minutes with one of the two rods fishing nothing. The rule
  // had been checked and had silently passed. A fifth of the bag carries an inch mark.
  //
  // resolveTackleName() is the function planArgsFrom() already uses, and its `asShown` tier exists
  // for exactly this substitution -- which is why the LATER warning out of capBaitDepth prints the
  // canonical `6-7"` while this test was still looking at `6-7in`. Two spellings of one bait, and
  // the guard was on the wrong one. Reporting the resolved name keeps the two messages agreeing.
  //
  // RESOLVING ALSO REPLACES THE `inBag` TEST rather than joining it: a name that resolves to
  // nothing in the bag is a bait the inventory does not describe, and the bag's trollable flag has
  // said nothing about it. That is the same abstention the empty-`trollSet` guard above makes.
  const trollSet = new Set(trollable);
  const bagNames = o.tackle || [];
  const castOnlyRods = (r) => (trollSet.size === 0 ? [] : (((r || {}).loadout || {}).rods || [])
    .map((rod) => {
      if (!rod || !rod.lure) return null;
      const hit = resolveTackleName(rod.lure, bagNames);
      if (!hit || trollSet.has(hit.name)) return null;
      return `${rod.id} (${hit.name})`;
    })
    .filter(Boolean));

  const broke = castOnlyRods(res);
  if (broke.length) {
    const verb = broke.length === 1 ? 'is a CAST-ONLY bait' : 'are CAST-ONLY baits';
    const which = broke.length === 1 ? 'that rod' : 'those rods';
    const corrected = `${req.user}\n\nTHAT ANSWER BROKE A RULE AND IS COMING BACK TO YOU.\n`
      + `${broke.join(' and ')} ${verb}. They plane at trolling speed instead of sinking, so `
      + `they have no running depth and no lead puts them at one — a rod carrying one is a rod `
      + `fishing nothing. They are on the NOT ON THE WATER TODAY list above, which said not to `
      + `name one on a rod.\n`
      + `Return the WHOLE plan again in the same shape, with a trollable bait on ${which}. `
      + `Everything else may stay exactly as it was.`;
    let second = null;
    try {
      const answeredAgain = await o.askModel({ system: req.system, user: corrected });
      const rawAgain = (answeredAgain && typeof answeredAgain === 'object'
                        && typeof answeredAgain.content === 'string')
        ? answeredAgain
        : { content: String(answeredAgain == null ? '' : answeredAgain), meta: null };
      second = { res: parsePlanResponse(rawAgain.content), raw: rawAgain };
    } catch {
      second = null;          // an unreadable second answer is not a reason to lose the first
    }
    // Take the second answer when it breaks the rule LESS. Equal is not better: a second answer
    // with the same fault is the first answer's cost paid twice, and the first is the one the
    // rest of this function has already been reasoning about.
    if (second && castOnlyRods(second.res).length < broke.length) {
      res = second.res;
      raw.content = second.raw.content;
      raw.meta = second.raw.meta;
      req.user = corrected;
    }
    const still = castOnlyRods(res);
    if (still.length) {
      packProblems.push(`${still.join(' and ')} ${still.length === 1 ? 'is a bait' : 'are baits'} `
        + `that cannot be trolled, and the model named ${still.length === 1 ? 'it' : 'them'} `
        + `again after being told. ${still.length === 1 ? 'That rod is' : 'Those rods are'} `
        + `fishing nothing — swap ${still.length === 1 ? 'it' : 'them'} on the Plan tab before `
        + `you launch.`);
    }
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
  // ── ON A RIVER THE TRANSIT IS THE RIVER, AND NOTHING IS FETCHED ──────────────────────────────
  //
  // `transitM` has measured river hops along the centreline since it was written; the GEOMETRY
  // still came from the MAR water graph, which is a lake tool. Surveyed across all 57 river packs
  // on 2026-09-18: 8 can route as far as one day, the median river can route 21% of its own line,
  // `broad_river` and `pee_dee_river_2` can route nothing. So on most rivers every pair came back
  // `422 no route`, the transit fell to a straight line between two leg ends -- which can cross
  // land and understates the amp-hours -- and the plan shipped it behind a clean status line.
  //
  // `centrelineTransit().route` answers from the pack's own spine instead. It cannot fail, it needs
  // no network, and it is the same projection `transitM` and the ramp's own station already use.
  // A river plan now makes no route request at all, where it used to make one per leg plus one home.
  const riverRoute = (isRiver && riverTransit && riverTransit.route) || null;
  // The ramp leg comes off the measured water route when the pack has one; every other pair
  // still comes off the centreline, which is what a river day is made of.
  const transit = o.transit
                  || rampLegRouter(o.ramp, rampRoute, riverRoute)
                  || await prefetchTransits(args.candidates, o.ramp, o.routeWater, rampRoute);

  const plan = assemblePlan({
    ...args,
    launch: o.ramp, slug: o.r2Key, water: o.water, ramp: o.rampName, date: o.date,
    launchTime: o.launchTime, returnTime: o.returnTime,
    species: o.species ? [].concat(o.species) : [],
    conditions: o.conditions, usableAh: o.usableAh,
    // THE ALMANAC AND THE SKY, so every leg can carry the light it is fished in.
    //
    // Both already go to buildPlanRequest for lightPromptBlock(); the ASSEMBLER had neither, so a
    // leg knew its own start time and nothing about what that time means. Ryan, 2026-09-15: "make
    // sure that the app is light aware through out the whole day". The card, the export and the
    // phone all read the leg, so the leg is where the light belongs.
    waterState: o.waterState, weatherByHour: o.weatherByHour,
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
    // WHAT THE APP READ OUT OF THE ANSWER, BEFORE THE ASSEMBLER RAN. planArgsFrom() is the first
    // reading -- the six rods seated on rods that can carry them, the deploys, the stops matched
    // to real structure ids, the safety verdict -- and `plan` is the second. Ryan's question,
    // asked twice, is about the gap between them: "what the LLM gives us and what we do with it...
    // do we throw away good data". Answering it needs both readings, and only `plan` was returned.
    args,
    problems: [...packProblems, ...args.problems, ...plan.warnings, ...broken],
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
/**
 * The leg off the ramp, over water build_ramp_reach.py actually measured.
 *
 * Ryan, 2026-09-21, reading his own plan's GPX: *"and yes that transit is over land... so that
 * will need to be fixed of course"*. `T1 · transit` was four points — Pack's Landing straight to
 * the canal's south end, 2.2 km across open lake and swamp.
 *
 * NEITHER OF THE TWO ROUTERS CAN ANSWER THAT PAIR. On a river the transit comes from
 * `centrelineTransit()`, the pack's own spine, and the Congaree's spine runs down the main
 * channel past the canal — so a ramp 1.8 km down a canal projects onto it as a straight line
 * across the swamp. The water graph cannot help either: the river's does not reach Lake Marion,
 * and Marion's has the canal's two ends in its main component with no through-channel between
 * them, answering 14,712 m around the lake against 1,801 m down the canal.
 *
 * `build_ramp_reach.py` already knew. It floods the charted water at 26 m cells outward from the
 * channel to measure each landing BY WATER — Pack's at 1,801 m against 2,367 straight, the
 * number already in the pack — and now writes the path that distance was measured along, channel
 * end first. Steepest descent on a BFS field, so a shortest path by construction, and over
 * charted water, so it cannot cross land.
 *
 * Only pairs with the ramp at one end, and it defers to `base` for everything else.
 *
 * @param {number[]} launch        [lon, lat] of the ramp
 * @param {number[][]} launchRoute [[lon, lat], ...] channel first, from launches.json
 * @param {function} [base]        the router this wraps; answers every other pair
 */
export function rampLegRouter(launch, launchRoute, base) {
  const ok = Array.isArray(launch) && Array.isArray(launchRoute) && launchRoute.length >= 2;
  if (!ok) return base || null;
  // 2e-4 deg is about 20 m, the same order as the flood's own cell -- and the ramp coordinate the
  // planner carries is the landing, while the route's last point is the wet cell beside it.
  const near = (a) => Array.isArray(a) && Math.abs(a[0] - launch[0]) < 2e-4
                                       && Math.abs(a[1] - launch[1]) < 2e-4;
  const len = (cs) => {
    let d = 0;
    for (let i = 1; i < cs.length; i++) d += metresBetween(cs[i - 1], cs[i]);
    return d;
  };
  // ── AND IT STOPS WHERE THE LEG STARTS, NOT WHERE THE FLOOD WAS SEEDED ────────────────────
  //
  // Ryan, 2026-09-21, on a Low Falls plan: *"everything is great except for the transit from the
  // landing to leg 1... the connection is bad"*. Measured off that export: the transit's last two
  // points run **132 m past** the start of leg 1 and then **43 m back** to it.
  //
  // Nothing is mis-routed. build_ramp_reach seeds its search on the river's CENTRELINE, so the
  // measured route ends on the centreline; the lane starts on the deep side of the channel, which
  // at that station is 47 m off it. Handing back the whole route therefore always overshoots by
  // however far past the leg's start the centreline carries, and the plan then draws a connector
  // back — the same shape as the perpendicular between two touching legs he caught on 2026-09-21.
  //
  // The cut is at the route's own closest approach to the leg's first point, measured to the
  // SEGMENT and not to the vertices, so a long leg does not get judged by its ends. What is left
  // is one line from the ramp to where the fishing starts, and the join is as short as the water
  // allows rather than a there-and-back.
  const joinTo = (cs, p) => {
    if (!Array.isArray(p) || p.length < 2 || cs.length < 2) return cs;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < cs.length - 1; i++) {
      const d = pointToSegmentM(p, cs[i], cs[i + 1]);
      if (d < bd) { bd = d; bi = i; }
    }
    const out = cs.slice(0, Math.max(1, bi + 1));
    if (metresBetween(out[out.length - 1], p) > 1) out.push([p[0], p[1]]);
    return out.length >= 2 ? out : cs;
  };
  return (a, b) => {
    const cs = near(a) ? launchRoute.slice().reverse()
             : near(b) ? launchRoute.slice()
             : null;
    if (!cs) return base ? base(a, b) : null;
    // Leaving, the route runs landing -> channel and `b` is where the fishing starts. Coming home
    // it runs channel -> landing and `a` is where the fishing stopped, so the same trim is applied
    // from the other end.
    const out = near(a) ? joinTo(cs, b)
                        : joinTo(cs.slice().reverse(), a).reverse();
    return { distanceM: len(out), coordinates: out, fromLaunchReach: true };
  };
}


export async function prefetchTransits(candidates, launch, routeWater, launchRoute) {
  const hasLaunchRoute = Array.isArray(launchRoute) && launchRoute.length >= 2;
  if ((typeof routeWater !== 'function' && !hasLaunchRoute)
      || !Array.isArray(candidates) || !candidates.length) return null;
  const pairs = [];
  let cursor = launch;
  // THE SAME ORIENTATION THE ASSEMBLER WILL WALK. A pass can be trolled either way and the app
  // picks which (orientLegs, plan-candidates.js) — so this cannot assume start → end. It did, and
  // the moment the assembler started flipping legs the prefetched pair no longer matched the pair
  // it asked for: `routed.get()` missed, the transit fell back to a straight line and marked
  // itself unrouted. Both callers now read the decision from one place rather than each deriving
  // its own, which is the only way they cannot drift apart.
  // AND ON A RIVER THE LIST ITSELF IS DIFFERENT, not just the orientation: travelOrder() expands the
  // day into one pass per entry, out through every reach and back through every reach. Asking for the
  // pairs of the UNEXPANDED list would prefetch a route home from the wrong end.
  const { legs: walked, facing } = travelOrder(candidates, launch);
  for (const [i, c] of walked.entries()) {
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
  if (typeof routeWater === 'function') {
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
  }

  // ── THE LEG OFF THE RAMP, WHEN THE GRAPH CANNOT ANSWER IT ──────────────────────────────────
  //
  // Ryan, 2026-09-21, reading his own plan's GPX: *"and yes that transit is over land... so that
  // will need to be fixed of course"*. `T1 · transit` was four points — Pack's Landing straight
  // to the canal's south end, 2.2 km across open lake and swamp.
  //
  // THE WATER GRAPH CANNOT FIX THAT ONE. It is Garmin's auto-guidance mesh, and the railroad
  // canal has its two ends in it with no through-channel between them: asked for Pack's to the
  // canal's south end, Marion's graph answers 14,712 m around the lake against 1,801 m down the
  // canal. The river's own graph does not reach the lake at all, so `/water/<slug>/route` returns
  // nothing and the leg falls back to the straight line that marks itself `unrouted`.
  //
  // `build_ramp_reach.py` already had the answer and was throwing it away. It floods the charted
  // water at 26 m cells outward from the channel to measure how far each landing is BY WATER --
  // Pack's at 1,801 m against 2,367 straight, the number already in the pack -- and now writes
  // the path that distance was measured along, channel end first. That is a shortest path by
  // construction, being steepest descent on a BFS field, and it is over charted water, so it
  // cannot cross land.
  //
  // Used only for pairs with the ramp at one end, and only where the router gave nothing, so a
  // water whose graph answers properly is untouched.
  if (hasLaunchRoute && Array.isArray(launch)) {
    const ramp = rampLegRouter(launch, launchRoute);
    for (const [a, b] of pairs) {
      const k = pairKey(a, b);
      if (routed.has(k)) continue;
      const r = ramp && ramp(a, b);
      if (r) routed.set(k, r);
    }
  }
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
