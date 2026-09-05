/**
 * plan-from-water.js — the water is already chosen. Build the day around it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ITEM 10, AND WHAT IT DELETES
 *
 * THE_FISHERMAN_CHOOSES § 12:
 *
 *   > It receives the CHOSEN routes and spots plus the conditions, and assigns baits, speeds and
 *   > presentation. It stops reading candidate lists, stops picking runIds, stops choosing water.
 *   > That deletes a family of failures where the model chose badly, and CANDIDATE_LIMIT = 12
 *   > goes with it.
 *
 * So this path never calls `selectCandidates()`. Not as an optimisation — as the point. Windowing
 * a run by score is how the app decides which water to fish, and the whole premise of Pick Water
 * is that Ryan has already decided. Re-deriving it would quietly hand a leg back that he did not
 * tick, and the difference would be invisible on the map.
 *
 * A piece already carries everything a leg needs: its geometry, its length, the water depth it
 * holds, and what it passes. Everything else here is arithmetic the app owns — distance,
 * amp-hours, the clock, which end to start from.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TWO ORDERINGS, AND THEY ARE NOT THE SAME ORDERING
 *
 *   § 14  the DAY's order is a SEARCH order — most diagnostic first, and Ryan keeps a veto
 *   § 9   the BATTERY check runs against the best realisable ordering of the ticked set
 *
 * `searchOrder()` gives the first. `dayCost()` gives the second. They routinely differ, and using
 * the cheap one to order the day would quietly turn a search into an itinerary — which is the
 * thing the whole rewrite exists to stop.
 *
 * The battery is still the only refusal. § 9: "if they are going to run out of battery because of
 * choice they shouldn't be able to make that choice."
 */

import { ampHours, minutesFor, metresBetween, cumulative } from './plan-candidates.js';
import { assemblePlan } from './plan-assemble.js';
import { buildPlanRequest, parsePlanResponse, planArgsFrom, MODEL_LEG_FIELDS }
  from './plan-prompt.js';
import { prefetchTransits } from './smart-plan-v2.js';
import { searchOrder, dayCost, priceSpots, TROLL_MPH, TRANSIT_MPH } from './plan-water.js';

/** The point on a line nearest a given position, and how far along the line it is. */
function positionOn(coords, cum, fraction) {
  const i = Math.max(0, Math.min(coords.length - 1, Math.round(fraction * (coords.length - 1))));
  return { at: coords[i], atM: Math.round(cum[i]) };
}

/**
 * A picked piece, in the shape assemblePlan already consumes.
 *
 * Deliberately NOT a call into selectCandidates — see the header. The fields below are the ones
 * plan-assemble.js actually reads, and each is either carried by the piece or computed here from
 * geometry the app owns.
 */
function legFrom(piece, i, ramp, slug) {
  const coords = piece.coords || [];
  const cum = cumulative(coords);
  const lengthM = piece.lengthM;
  // The chart under the centreline over this piece's own stations. Null on a pack too old to have
  // been fitted with envelope profiles, and every reader below falls back to `holdsFt` for that.
  const line = (piece.water && piece.water.line) || null;
  const near = piece.near || [];
  const total = cum[cum.length - 1] || lengthM || 1;

  // `near` records metres along the ORIGINAL lane, and a piece is a trimmed stretch of it, so the
  // fraction is taken against the lane's own length where the piece knows it and against the
  // piece otherwise. Approximate on purpose: a pass mark is a place to slow down, not a waypoint.
  const laneM = piece.laneLengthM || total;
  const passes = near
    .filter((n) => n.s != null && n.s <= laneM)
    .map((n, k) => {
      const { at, atM } = positionOn(coords, cum, n.s / laneM);
      return {
        id: `${slug || 'water'}#${i}:p${k}`,
        structureId: null,
        type: n.t,
        atM,
        at,
        offM: Math.round(n.d),
        // From the pack or not at all. `near` carries no depth, and for timber, piles and
        // attractors none exists anywhere in the packs -- "how tall is every tree claude???"
        depthFt: null,
        what: String(n.t).replace(/_/g, ' '),
        weight: (n.t === 'hazard' || n.t === 'obstruction') ? 0 : 1,
      };
    })
    .sort((a, b) => a.atM - b.atM);

  const a = coords[0], b = coords[coords.length - 1];
  return {
    runId: piece.runId || piece.key,
    // WHAT HE PICKED, TO THE METRE. Not a re-derived window.
    coordinates: coords,
    // THE TWO ENDS, NAMED. `orientLegs()` is documented to take `{start, end}[]` and both
    // assemblePlan() and prefetchTransits() read the pair back off it. This function computed
    // `a` and `b` for the ramp transits and then never emitted them, so every leg built from
    // picked water reached the assembler with `start: undefined, end: undefined`.
    //
    // That one omission produced Ryan's whole failure on 2026-08-11, and none of it named the
    // cause. orientLegs()'s hop() guards with Array.isArray and so returns silently; the
    // assembler then asked the water router to route to `undefined`, which the worker rejected
    // 400 eight times; `cursor` advanced to `undefined`; and the run home finally called
    // metresBetween(undefined, launch) -- "Cannot read properties of undefined (reading '1')",
    // thrown three modules away from the field that was missing.
    start: a,
    end: b,
    lengthM,
    // THE LINE THIS LEG FOLLOWS, WHICH IS NOT THE SHOALEST SPOT ON IT.
    //
    // This was `piece.holdsFt` and so was `maxRunDepthFt` below — one number doing two jobs, and
    // wrong at the first. `holdsFt` is a THRESHOLD: the shallowest water within a wander anywhere
    // along the stretch, set by one spot. Pick Water's own row text says so in the same breath it
    // reports it: "nothing may run deeper than 6 ft here — that is the shallowest water within a
    // wander anywhere on the 1.2 mi, AND IT IS ONE SPOT, NOT THE WHOLE STRETCH".
    //
    // Measured on wateree_lake#362, the leg Ryan brought back on 2026-08-30. The pack says
    // `depth_ft: 15.1`, `shallowest_ft: 7.0`, `deepest_ft: 24.9`, `mean_depth_ft: 20.0`, and the
    // corridor medians read 17–24 ft. `holdsFt` is 6. The plan called it "The 6 ft line" and the
    // card printed "Target Depth 6ft" over 17–24 ft of water — then warned three times that every
    // crankbait aboard was "the wrong bait for this pass", which is what a 6 ft ceiling means.
    // Ryan: "if the water is only 20 feet how is the target 20-25ft".
    //
    // plan-water-ui.js:216 already learned this for the tab's own rows -- "HOW DEEP THIS WATER IS
    // -- from the corridor, not from holdsFt... announced a stretch of 17-24 ft water as '8 ft or
    // deeper', which is true and useless". The PLAN never learned it. Smart Plan never had the
    // bug: plan-candidates.js:1240 sets `depthFt: p.depth_ft`, the charted contour. Same number
    // now on both paths.
    // Ryan, 2026-08-30, on being shown that the lane is fitted rather than traced and so has no
    // single depth: "it runs from 25-32 ft median 29 shallowest is 25ft deepest is 32 allows me to
    // know that the lure depth that is chosen is right or wrong". The median is the leg's one
    // number where one is wanted; the two ends ride with it so nothing has to pretend the water
    // is flat. `chartedFt` -- the name of the contour the pass was cut from -- is gone: measured
    // on Wateree it reads 7 ft off the water under the boat (#289: contour 23, line 27-32).
    depthFt: line ? line.medianFt : piece.holdsFt,
    depthMinFt: line ? line.minFt : null,
    depthMaxFt: line ? line.maxFt : null,
    // THE CEILING ON HOW DEEP A BAIT MAY RUN HERE — OFF THE LINE, NOT OFF THE BANK.
    //
    // This was `holdsFt`, which is derived from `envelope_ft`: the shallowest water within 25 m
    // of the line. That is a wander warning. It is not the water under the boat, and sizing a
    // bait with it means sizing it for the bank you are steering away from.
    //
    // wateree_lake#362 is the case. Its line never comes above 13 ft — `shallowest_line_ft` is
    // 12.1, the on-line median is 20 — and 25 m to the shallow side it touches 7 ft. It is a
    // channel edge; there is always shallower water beside one, which is what makes it worth
    // fishing. The ceiling came out at 6 ft and condemned every crankbait aboard.
    //
    // Not one lane: across Wateree's 305 fitted lanes the shallow side reads 4+ ft shallower
    // than the line on 237 of them, 78%, median 7 ft. Deepest bait that runs 800 m unbroken,
    // median across 250 lanes: 22 ft off the shallow side, 26 ft off the line.
    //
    // `shallowest_line_ft` is the pack's own stamped answer to "how shallow does this line get".
    // No margin invented here — how close he steers is his, and `envelope_ft` still feeds the
    // depth cue that warns him before the shallow side arrives. See depthCues().
    //
    // Now measured on THIS PIECE rather than the whole pass. `shallowest_line_ft` is the pack's
    // answer for the pass end to end, and a piece is a trim of that pass -- on 41 of Wateree's 70
    // pieces the two differ, by up to 8 ft, always in the direction of condemning baits over water
    // the leg never crosses. #157 is the case: the pass touches 8 ft, the piece never comes above
    // 45. Same field, same rule, measured where the boat actually goes. See waterBand().
    maxRunDepthFt: line ? line.minFt : piece.holdsFt,
    passes,
    transitInM: ramp ? Math.round(metresBetween(ramp, a)) : 0,
    transitOutM: ramp ? Math.round(metresBetween(b, ramp)) : 0,
    batteryAh: Number(ampHours(lengthM, TROLL_MPH).toFixed(2)),
    estMin: Math.round(minutesFor(lengthM, TROLL_MPH)),
    runLedges: null,
    support: null,
    // THE ENVELOPE RIDES ALONG so the day can warn about a shallow spot before the sounder finds
    // it. It is the shallowest water within the wander at every station, which is the number that
    // decides whether a bait clears -- see plan-pieces.js.
    envelope: piece.envelope,
    envelopeStepM: piece.envelopeStepM,
    // Carried so the prompt can say what this water offers without recomputing it.
    offers: piece.offers,
    partners: (piece.partners || []).length,
    reasons: piece.reasons,
    waterKey: piece.key,
  };
}

/**
 * Build the day from the water Ryan ticked.
 *
 * @param {object}   o
 * @param {object[]} o.picked      pieces from offerWater(), in ANY order
 * @param {object[]} [o.spots]     cast spots from offerWater()
 * @param {number[]} o.ramp        [lon, lat]
 * @param {number}   o.usableAh    LiFePO4 reserve already removed
 * @param {number[]} [o.order]     HIS override. Absent = the app's search order.
 * @param {function} o.askModel    ({system,user}) => Promise<string>
 * @param {function} [o.routeWater] transit router; a straight line is marked `unrouted`
 */
export async function planFromWater(o) {
  const picked = o.picked || [];
  if (!picked.length) {
    return { plan: null, problems: ['No water picked — tick some on the Water tab first'] };
  }

  // THE DAY'S ORDER IS THE SEARCH ORDER, unless he overrode it. § 14: "my maybe was that i have
  // veto or override authority" — so the override is a plain argument, not a setting.
  const order = Array.isArray(o.order) && o.order.length === picked.length
    ? o.order
    : searchOrder(picked);
  const ordered = order.map((i) => picked[i]);

  // THE ONLY REFUSAL, and it is checked against the CHEAPEST possible ordering, not this one --
  // so "it does not fit" means no ordering fits, and the answer is to drop water rather than to
  // shuffle it. § 9.
  const cheapest = dayCost(picked, { ramp: o.ramp, usableAh: o.usableAh, windowMin: o.windowMin });
  if (!cheapest.fits) {
    return {
      plan: null,
      problems: [`${cheapest.reason}. That is the best possible ordering, so no order of this `
               + `water fits the battery — drop a piece.`],
      dayCost: cheapest,
    };
  }

  const legs = ordered.map((p, i) => legFrom(p, i, o.ramp, o.slug));

  // What the ordering costs, leg to leg, for the order actually chosen.
  for (let i = 0; i < legs.length; i++) {
    const to = {};
    for (let j = 0; j < legs.length; j++) {
      if (i === j) continue;
      const from = legs[i].coordinates[legs[i].coordinates.length - 1];
      const start = legs[j].coordinates[0];
      to[legs[j].runId] = Math.round(metresBetween(from, start));
    }
    legs[i].transitToM = to;
  }

  // THE ROUTER IS ASYNC AND THE ASSEMBLER IS NOT, SO THE ROUTES ARE FETCHED FIRST.
  //
  // assemblePlan() calls `transit(from, to)` inline and tests the result with `|| straight(...)`.
  // Hand it `waterRouter()` directly and every call returns a PROMISE -- which is truthy, so the
  // straight-line fallback never fires, `p.coordinates` is undefined, and the transit silently
  // becomes a two-point line with `distanceM: undefined`. It does not throw and it does not warn;
  // the day just quietly stops being water-routed.
  //
  // smart-plan-v2.js:142 has always done this correctly -- `o.transit || await prefetchTransits(...)`
  // -- and this path was written without it, so `o.routeWater` was documented in the signature
  // above and then never read. One resolver, both paths.
  //
  // A router that answers for nothing returns null, and assemblePlan falls back to straight lines
  // that mark themselves `unrouted`. That is a worse plan, not a broken one, and it says so.

  // Spots priced against the water he actually picked -- a spot in a picked corridor is a free
  // stop, one outside every corridor is a trip. § 6.
  const spots = priceSpots(o.spots || [], picked, { ramp: o.ramp });
  const freeSpots = spots.filter((s) => s.free);
  // HIS PICKS OUTRANK THE APP'S OFFER. A spot he ticked is part of the day whether it sits on the
  // water he chose or costs a run out to it -- that was his call and the plan carries it.
  const chosenKeys = new Set(o.chosenSpotKeys || []);
  const chosenSpots = spots.filter((s) => chosenKeys.has(s.key));

  const req = buildPlanRequest({
    ...o.planArgs,
    // THE BUDGET, AND THE APP'S OWN PRICE FOR THE WATER HE PICKED. `cheapest` is dayCost() twenty
    // lines up -- the same number that decides the battery refusal -- so nothing is re-estimated
    // to say this. Until 2026-09-05 the model was handed "06:00" and "15:00" and no minutes at
    // all, and the Sep 6 Wateree day came back at 792 against a 540 minute window.
    windowMin: o.windowMin,
    dayMin: Number.isFinite(cheapest && cheapest.min) ? cheapest.min : undefined,
    // So the prompt can say HOW each bait reaches a depth rather than leaving the model to read
    // one off the lure's name. Same resolver the assembler already gets, one line further up.
    lureByName: o.lureByName,
    candidates: legs.map((l) => ({
      runId: l.runId,
      depthFt: l.depthFt,
      depthMinFt: l.depthMinFt ?? undefined,
      depthMaxFt: l.depthMaxFt ?? undefined,
      maxRunDepthFt: l.maxRunDepthFt,
      lengthM: l.lengthM,
      estMin: l.estMin,
      batteryAh: l.batteryAh,
      transitFromRampM: l.transitInM,
      transitToRampM: l.transitOutM,
      structures: l.passes.map((h) => ({ id: h.id, type: h.type, atM: h.atM, offM: h.offM,
                                         what: h.what, depthFt: h.depthFt,
                                         worthFishing: h.weight > 0 || undefined })),
      structuresShown: l.passes.length,
      structuresTotal: l.passes.length,
      // The reasons the app already computed, so the model is arguing with the same facts Ryan saw.
      whyThisWater: l.reasons ? { for: l.reasons.for, against: l.reasons.against } : undefined,
      ladderPartners: l.partners || undefined,
    })),
    // THE WATER AND THE ORDER ARE DECIDED. Said in the prompt, not just implied by the list
    // length -- a model handed N legs will otherwise rank them out of habit.
    waterIsChosen: true,
    orderIsChosen: true,
    // EVERY free spot goes over, not a best-N. Which water is worth stopping on is a fishing
    // judgement -- "There is water that is worth stopping on today and water that is not" -- so
    // the app supplies the positions and the count he asked for, and the model does the choosing.
    // Truncating here would be the app quietly making that call by ranking.
    freeCastSpots: freeSpots.map((s) => ({ what: s.what, onLeg: s.onPiece, offM: s.detourM })),
    chosenCastSpots: chosenSpots.length
      ? chosenSpots.map((s) => ({ what: s.what, depthFt: s.depthFt, onLeg: s.onPiece,
                                  offM: s.detourM, free: s.free }))
      : undefined,
  });

  let res;
  try {
    res = parsePlanResponse(await o.askModel(req));
  } catch (e) {
    return { plan: null, problems: [`The model did not answer usably: ${e.message}`], dayCost: cheapest };
  }

  // THE MODEL'S ANSWER IS RAW UNTIL planArgsFrom() HAS BEEN OVER IT, AND THIS PATH SKIPPED IT.
  //
  // `parsePlanResponse()` is a JSON.parse and nothing more. The model returns `legs: [{runId,
  // speedMph, deploy:{port,starboard}}]` — deploy lives INSIDE each leg — and it is planArgsFrom()
  // that turns those into the `{[runId]: {port, starboard}}` map the assembler consumes, seats
  // every lure on a rod that can carry it, and resolves lure names against the actual bag.
  //
  // This path read `res.deploy`, which the model never sends and which is therefore ALWAYS
  // undefined. Ryan, 2026-08-11: "didn't assign baits at all". Measured off his saved plan:
  // routeRods was {L1..L9: []} — nine legs, not one rod on any of them, while castRods filled in
  // normally because stops are top-level and survived. Every leg reached the timeline with
  // `deploy: null`, `rodsById.get(undefined)` returned undefined, and the spread came out empty.
  //
  // ITS `candidates` ARE DELIBERATELY DISCARDED. planArgsFrom() reorders to the model's leg list,
  // and on this path the order is already Ryan's — see the header. `deploy` is keyed by runId so
  // it does not care about order, which is what makes taking one and not the other safe.
  //
  // And its `problems` are returned instead of thrown away. A model that names a rod the boat
  // does not carry, or a lure that is not in the bag, said so all along and nobody was listening.
  const args = planArgsFrom(res, legs, { tackle: o.tackle, connectionOf: o.connectionOf });

  // A LEG THE MODEL NEVER MENTIONED IS A LEG TROLLED EMPTY, AND NOTHING SAID WHY.
  //
  // Ryan, 2026-08-31, on a nine-piece Pick Water day: five legs came back with no rods in the
  // water, `wateree_lake#46` among them at 2.0 miles -- the longest piece he picked. The app's
  // problem list said nothing about any of them, because planArgsFrom() can only complain about
  // legs the model DID list: a leg named with a broken `deploy` is refused out loud, and a leg
  // the model simply skipped is invisible to it.
  //
  // On the Smart Plan path that cannot happen -- the day IS the model's leg list, so a leg it
  // omits is water it declined and nothing is missing. HERE the day is Ryan's list and the
  // model's answer is only the rigging for it, so an omission is a hole in the middle of a day he
  // chose. Same silence, opposite meaning, and only this path can tell them apart.
  //
  // It reports and stops there. Carrying the previous leg's rods forward would paper over a wrong
  // plan and make it look complete, which is the one thing worse than an empty leg -- the same
  // call assemblePlan() made in 2026-08-11 and for the same reason.
  const answered = new Set((Array.isArray(res.legs) ? res.legs : [])
    .map((l) => l && l.runId).filter(Boolean));
  const skipped = legs.filter((l) => !answered.has(l.runId));
  if (skipped.length) {
    args.problems.push(`the model rigged ${legs.length - skipped.length} of the ${legs.length} `
      + `pieces you picked and never mentioned ${skipped.map((l) => l.runId).join(', ')} — `
      + `${(skipped.reduce((t, l) => t + l.lengthM, 0) / 1609.34).toFixed(1)} mi of the day is in `
      + 'the plan with nothing in the water. It was asked to rig every one.');
  }

  // HIS ORDER, THE MODEL'S ANSWERS. Both, which is the thing this path was not doing.
  //
  // planArgsFrom() returns `candidates` with the model's per-leg answers merged on, in the
  // MODEL'S order -- and the order here is Ryan's, off a map, and is not the model's to change.
  // So this path took `deploy`, which is keyed by runId and therefore order-blind, and threw the
  // rest away. It threw the answers away with the ordering.
  //
  // Measured off his plan of 2026-08-31: the model asked for a second pass on `#1762`, `#1480`
  // and `#1422` and the day fished every leg once, and it wrote a sentence of `why` for all ten
  // legs and every card came out blank. Both had been computed, validated, and discarded one line
  // apart from the `deploy` map that was kept.
  //
  // Keyed by runId for the same reason `deploy` is: a runId is what a leg IS, and the order it
  // sits in is a separate fact. MODEL_LEG_FIELDS is the list, and it lives where the fields are
  // set so the next one added cannot be lost here the way these were.
  const said = new Map((args.candidates || []).map((c) => [c.runId, c]));
  const candidates = legs.map((l) => {
    const c = said.get(l.runId);
    if (!c) return l;
    const out = { ...l };
    for (const k of MODEL_LEG_FIELDS) if (c[k] !== undefined) out[k] = c[k];
    return out;
  });

  // THE ROUTER IS ASKED AFTER THE MODEL HAS ANSWERED, NOT BEFORE.
  //
  // This was prefetched off `legs` before `askModel`, which was fine while a leg was a leg. A leg
  // fished an even number of times ends where it STARTED, so the transit out of it leaves from
  // the other end -- and a pair prefetched from the wrong end simply misses, dropping that
  // transit to an unrouted straight line. prefetchTransits() reads the pass counts through
  // orientLegs(), so it has to see them.
  const transit = o.transit || await prefetchTransits(candidates, o.ramp, o.routeWater);

  const plan = assemblePlan({
    // IN THE ORDER ALREADY DECIDED. assemblePlan documents `candidates` as "IN THE ORDER THE MODEL
    // CHOSE"; on this path the model chose nothing and the array is already the day.
    candidates,
    launch: o.ramp,
    loadout: args.loadout,
    deploy: args.deploy,
    stops: args.stops,
    changes: args.changes,
    launchTime: o.launchTime,
    returnTime: o.returnTime,
    usableAh: o.usableAh,
    transit,
    // So the assembler can check what the model's lead and speed actually put the bait at
    // against the shallowest water on each leg. See capBaitDepth().
    lureByName: o.lureByName,
    // WHAT THE PLAN IS OF. assemblePlan writes `meta` from exactly these five, and this path sent
    // none of them -- every Pick Water day came out with `meta: {water: null, slug: null,
    // ramp: null, date: null, species: []}` and `conditions: {}`. They are all in `o.planArgs`,
    // which this function already spreads into the PROMPT twelve lines up, so the model was told
    // the water and the plan object was not. Same five names Smart Plan passes.
    slug: o.slug ?? null,
    water: (o.planArgs && o.planArgs.water) ?? null,
    ramp: (o.planArgs && o.planArgs.ramp) ?? null,
    date: (o.planArgs && o.planArgs.date) ?? null,
    species: (o.planArgs && o.planArgs.species) || [],
    conditions: (o.planArgs && o.planArgs.conditions) || {},
    // THE MODEL MAY CALL A NO-GO ON THIS PATH TOO, AND ITS ANSWER WAS BEING THROWN AWAY.
    //
    // planArgsFrom() returns `safety` -- `isGo`, `warning`, `rampEvaluation` -- and Smart Plan
    // spreads the whole of `args` into this call so it arrives. This path picks fields out of
    // `args` one at a time (see the note above about candidates) and `safety` was not one of
    // them, so `plan.safety` was `{}` on every Pick Water day and planIssuesHtml()'s NO-GO banner
    // could never fire. Over 15 sustained is a no-go for a 12.5 ft kayak whichever tab picked
    // the water.
    safety: args.safety,
  });

  plan.notes = args.notes;

  return {
    plan,
    // THE EXCHANGE, so the saved plan can show what was sent and what came back.
    //
    // collectPlan() reads `request`/`response` off `window._planV2Result`, which plan-water-ui.js
    // sets from this object -- and this path built both and returned neither, so a Pick Water day
    // saved a `model` block with two nulls in it and the one question it was added to answer went
    // unanswered. smart-plan-v2.js has returned them since it was written; this is the same two
    // fields on the other path.
    request: req,
    response: res,
    // WHAT THE MODEL GOT WRONG, SAID OUT LOUD. This was a hardcoded empty array, so a rod that is
    // not on the boat, a lure that is not in the bag and a leg with no rods deployed all arrived
    // silently. smart-plan-v2.js has always returned these.
    problems: [...(args.problems || []), ...(plan.warnings || [])],
    dayCost: cheapest,
    order,
    // So the UI can say "the app put them in this order, and here is why" rather than silently
    // reordering what he ticked.
    orderWasOverridden: Array.isArray(o.order) && o.order.length === picked.length,
    spots,
  };
}
