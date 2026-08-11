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
import { buildPlanRequest, parsePlanResponse } from './plan-prompt.js';
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
    lengthM,
    depthFt: piece.holdsFt,
    passes,
    transitInM: ramp ? Math.round(metresBetween(ramp, a)) : 0,
    transitOutM: ramp ? Math.round(metresBetween(b, ramp)) : 0,
    batteryAh: Number(ampHours(lengthM, TROLL_MPH).toFixed(2)),
    estMin: Math.round(minutesFor(lengthM, TROLL_MPH)),
    runLedges: null,
    support: null,
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

  // Spots priced against the water he actually picked -- a spot in a picked corridor is a free
  // stop, one outside every corridor is a trip. § 6.
  const spots = priceSpots(o.spots || [], picked, { ramp: o.ramp });
  const freeSpots = spots.filter((s) => s.free);

  const req = buildPlanRequest({
    ...o.planArgs,
    candidates: legs.map((l) => ({
      runId: l.runId,
      depthFt: l.depthFt,
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
    freeCastSpots: freeSpots.map((s) => ({ what: s.what, onLeg: s.onPiece, offM: s.detourM })),
  });

  let res;
  try {
    res = parsePlanResponse(await o.askModel(req));
  } catch (e) {
    return { plan: null, problems: [`The model did not answer usably: ${e.message}`], dayCost: cheapest };
  }

  const plan = assemblePlan({
    // IN THE ORDER ALREADY DECIDED. assemblePlan documents `candidates` as "IN THE ORDER THE MODEL
    // CHOSE"; on this path the model chose nothing and the array is already the day.
    candidates: legs,
    launch: o.ramp,
    loadout: res.loadout,
    deploy: res.deploy,
    stops: res.stops,
    changes: res.changes,
    launchTime: o.launchTime,
    returnTime: o.returnTime,
    usableAh: o.usableAh,
    transit: o.transit,
  });

  return {
    plan,
    problems: [],
    dayCost: cheapest,
    order,
    // So the UI can say "the app put them in this order, and here is why" rather than silently
    // reordering what he ticked.
    orderWasOverridden: Array.isArray(o.order) && o.order.length === picked.length,
    spots,
  };
}
