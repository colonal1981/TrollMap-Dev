/**
 * plan-assemble.js — ordered candidates + the model's judgement → a plan v2 object.
 *
 * THE DIVISION OF LABOUR, from PLAN_SCHEMA_V2.md: the model does judgement, the app does
 * arithmetic. The model picks the loadout, which runs, in what order, which structures earn a
 * stop, and why. Everything here is computed. **The model never emits a coordinate** — it names a
 * runId and a structure id from candidates the app handed it, and this file turns those names
 * back into places. That is what makes a route over land structurally impossible rather than
 * something we filter out afterwards, and it is what kills "Main Lake Point Alpha", the invented
 * stop with `lat: null` sitting in the old timeline with nowhere to go.
 *
 * DISTANCE IS THE SPINE. Ryan, 2026-08-07: "every time i catch a fish i am going to slow down or
 * stop completely so more like it needs to be a distance from thing not a time to thing." Every
 * leg carries `startM` — cumulative metres along the whole day — and every stop and change
 * carries `atM`. The phone takes GPS, works out distance travelled, and looks up what is next.
 * Fight a fish for twenty minutes and nothing goes stale.
 *
 * Everything time-shaped is prefixed `est` so no code can quietly treat it as authoritative.
 * `returnTime` and `windowMin` are the exceptions: those are real.
 *
 * NO out-and-back. No inbound, no outbound, no return_to_launch. If the last leg finishes near
 * the ramp it is because the ordering put it there — and if it does not, that is a warning, not a
 * leg this file invents.
 */

import { ampHours, minutesFor, metresBetween, cumulative, pointAt } from './plan-candidates.js';

/** "06:00" → minutes since midnight. */
export function parseClock(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

export function formatClock(mins) {
  if (!Number.isFinite(mins)) return null;
  const t = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

const round2 = (v) => Number(Number(v).toFixed(2));

// How far from the ramp the last leg may finish before the plan admits the trip home is not in
// the budget. 500 m is a few minutes of pedalling; anything past that is a real cost being hidden.
const HOME_TOLERANCE_M = 500;

// Three reties is where a rig plan stops being a plan. Ryan's own framing: a snap change is
// seconds, a fluoro leader is a knot with cold wet hands in a moving kayak.
const FLUORO_RETIE_WARN = 3;

// Sane bounds on a speed the model asked for, taken from the amps curve's own two anchors: 2.0
// mph is the trolling anchor, 5.0 mph is 100% throttle. Outside 0.5-5.0 is not a speed this boat
// has. Nothing upstream bounds it -- plan-prompt.js:369 only checks that it is a number -- so the
// range is enforced here.
const TROLL_MPH_MIN = 0.5;
const TROLL_MPH_MAX = 5.0;

/**
 * @param {object}   o
 * @param {object[]} o.candidates  from selectCandidates(), IN THE ORDER THE MODEL CHOSE
 * @param {number[]} o.launch      [lon, lat] of the ramp
 * @param {object}   o.loadout     the model's six rods; passed through untouched
 * @param {object}   [o.deploy]    { [runId]: {port, starboard} } — which two rods go in the water
 * @param {object[]} [o.stops]     [{runId, structureId, rods, durationMin, why, presentation,
 *                                 positioning}] — structureId names a pass the app supplied
 * @param {object[]} [o.changes]   [{beforeRunId, rodId, from, to, why}]
 * @param {number}   [o.trollMph]  DEFAULT ONLY, for a leg the model gave no `speedMph` for
 * @param {function} [o.transit]   (fromLonLat, toLonLat) => {distanceM, coordinates} or null.
 *                                 MUST be supplied, backed by POST /water/<slug>/route. When it
 *                                 is missing, or answers null for a pair, the leg is a straight
 *                                 line, is marked `unrouted: true`, warns, and fails
 *                                 validatePlan() — a straight line between two leg ends
 *                                 understates cost on a reservoir and can cross land.
 */
export function assemblePlan(o) {
  const trollMph = o.trollMph ?? 2.0;
  const transitMph = o.transitMph ?? 3.5;
  const launchMin = parseClock(o.launchTime) ?? 6 * 60;
  const returnMin = parseClock(o.returnTime);
  // `unrouted` travels with the geometry. Marking it here rather than at the call site is what
  // makes it impossible to forget: every straight line the assembler produces carries the flag,
  // whether it came from a missing router or from a router that could not answer this pair.
  const straight = (a, b) => ({ distanceM: metresBetween(a, b), coordinates: [a, b], unrouted: true });
  const transit = o.transit || straight;
  const candidates = o.candidates || [];

  const legs = [];
  const changes = [];
  const warnings = [];
  let cursor = o.launch;          // where the boat is
  // THE SPINE IS INTEGER METRES, accumulated from already-rounded leg lengths — not a float that
  // gets rounded on the way out. Round a running total and the reported starts drift a metre off
  // the reported lengths, so `startM + lengthM` stops equalling the next `startM` and the phone's
  // "what is next" lookup lands in the gap. Amp-hours and minutes still use the exact distance.
  let runM = 0;
  let clock = launchMin;
  let fishingM = 0, transitM = 0, ah = 0;
  let ti = 0, li = 0;

  const stopsByRun = new Map();
  for (const s of (o.stops || [])) {
    if (!stopsByRun.has(s.runId)) stopsByRun.set(s.runId, []);
    stopsByRun.get(s.runId).push(s);
  }
  const changeByRun = new Map();
  for (const c of (o.changes || [])) {
    if (!changeByRun.has(c.beforeRunId)) changeByRun.set(c.beforeRunId, []);
    changeByRun.get(c.beforeRunId).push(c);
  }
  const planned = new Set(candidates.map((c) => c.runId));
  for (const s of (o.stops || [])) {
    if (!planned.has(s.runId)) warnings.push(`dropped a stop on ${s.runId} — that run is not in the plan`);
  }
  for (const c of (o.changes || [])) {
    if (c.beforeRunId && !planned.has(c.beforeRunId)) {
      warnings.push(`dropped a lure change before ${c.beforeRunId} — that run is not in the plan`);
    }
  }

  const rods = (o.loadout && o.loadout.rods) || [];

  for (const c of candidates) {
    // A lure change happens where the boat is, before the leg starts — so it carries the current
    // cumulative distance, not a time. Cost comes from the rod's rig, not from the model's
    // opinion: a snap is seconds, a fluoro leader is a knot with wet hands. A change naming a rod
    // that is not in the loadout is a change to a seventh rod, and is refused.
    for (const ch of (changeByRun.get(c.runId) || [])) {
      const rod = rods.find((r) => r.id === ch.rodId);
      if (!rod) { warnings.push(`dropped a lure change on ${ch.rodId} — no such rod in the loadout`); continue; }
      changes.push({
        id: `C${changes.length + 1}`, atM: runM, rodId: ch.rodId,
        cost: rod.rig === 'fluoro' ? 'fluoro' : 'snap',
        from: ch.from ?? rod.lure ?? null, to: ch.to ?? null, why: ch.why ?? null,
      });
    }

    // Transit to the head of the leg.
    const p = transit(cursor, c.start) || straight(cursor, c.start);
    if (p.distanceM > 1) {
      const len = Math.round(p.distanceM);
      const mins = minutesFor(p.distanceM, transitMph);
      const a = ampHours(p.distanceM, transitMph);
      const tleg = {
        id: `T${++ti}`, type: 'transit',
        startM: runM, lengthM: len,
        speedMph: transitMph, batteryAh: round2(a),
        estDurationMin: Math.round(mins), estStartTime: formatClock(clock),
        coordinates: p.coordinates,
      };
      // Troll legs are safe by provenance — they are stitched contour geometry out of
      // trolling_runs.geojson. Transits are not: a straight line between two leg ends is water
      // only by luck, and on Wateree it crosses points and islands. Say so on the leg and out
      // loud, rather than drawing it and hoping.
      if (p.unrouted) {
        tleg.unrouted = true;
        warnings.push(`${tleg.id} is a straight line, not a water-routed path — it can cross `
                    + 'land and it understates the amp-hours');
      }
      legs.push(tleg);
      runM += len; transitM += len; ah += a; clock += mins;
    }

    // The trolling leg, AT THE SPEED THE MODEL SET FOR IT. `trollMph` was a scaffold from before
    // the prompt asked for a speed at all, and it outlived its reason: plan-prompt.js validates
    // `speedMph` on every leg and rides it in on the candidate, and this file used to overwrite it
    // with one day-wide number -- so a day running one leg at 1.8 and the next at 2.2 reported
    // both at 2.0 and budgeted both at 2.0. It is a DEFAULT now, used only for a leg the model
    // gave no speed for, and the minutes and the amp-hours come from the leg's own speed. A speed
    // outside the bounds is refused the way everything else here is refused: ignored, said out
    // loud, fallen back from.
    let legMph = trollMph;
    if (c.speedMph != null) {
      const want = Number(c.speedMph);
      if (want >= TROLL_MPH_MIN && want <= TROLL_MPH_MAX) legMph = want;
      else warnings.push(`${c.runId} asked for ${c.speedMph} mph -- outside `
                       + `${TROLL_MPH_MIN}-${TROLL_MPH_MAX} mph, trolled at ${trollMph} instead`);
    }
    const legStartM = runM;
    const legLen = Math.round(c.lengthM);
    const mins = minutesFor(c.lengthM, legMph);
    const a = ampHours(c.lengthM, legMph);
    // BOTH NAMES RESOLVE TO THE SAME PASS. `id` is the app's handle (`wateree_lake#412:p3`);
    // `structureId` is the lake's own name for the thing (`hump_7`) and is null for every type
    // the packs cannot name. The model is shown both and asked for `id`, so a stop that arrives
    // carrying the other one is a naming slip, not an invented structure — resolving it costs
    // one extra map and saves the stop. `id` wins on a collision; it is unique by construction.
    const byId = new Map();
    for (const h of (c.passes || [])) {
      if (h.structureId != null && !byId.has(h.structureId)) byId.set(h.structureId, h);
    }
    for (const h of (c.passes || [])) byId.set(h.id, h);

    const stops = [];
    for (const s of (stopsByRun.get(c.runId) || [])) {
      const hit = byId.get(s.structureId);
      if (!hit) {
        // The model named something it was not handed. This is the whole guard: refuse it, say so,
        // and carry on — never place it at a guessed position.
        warnings.push(`dropped a stop on ${c.runId}: no structure "${s.structureId}" on that leg`);
        continue;
      }
      stops.push({
        id: `S${li + 1}.${stops.length + 1}`,
        atM: hit.atM,
        at: hit.at,
        structureId: hit.structureId,          // hump_2 / ledge_57, when the lake data names it
        structureRef: hit.id,                  // what the model asked for
        structureType: hit.type,
        structure: hit.what,
        // Depth comes from the structure, never a `?? 6`. That default once put a stop on a 41 ft
        // hump at six feet and then sized the jighead from it. Null is the honest answer when the
        // pipeline has no depth for that kind of feature.
        depthFt: hit.depthFt ?? null,
        offM: Math.round(hit.offM),
        rods: s.rods || [],
        durationMin: s.durationMin ?? 15,
        why: s.why ?? null,
        presentation: s.presentation ?? null,
        positioning: s.positioning ?? null,
      });
    }
    stops.sort((x, y) => x.atM - y.atM);
    stops.forEach((s, k) => { s.id = `S${li + 1}.${k + 1}`; });

    const stopMin = stops.reduce((t, s) => t + (s.durationMin || 0), 0);
    const deploy = (o.deploy && o.deploy[c.runId]) || null;
    if (deploy) {
      for (const side of ['port', 'starboard']) {
        const id = deploy[side];
        if (id && !rods.some((r) => r.id === id)) {
          warnings.push(`${c.runId} deploys ${id} on the ${side} — no such rod in the loadout`);
        }
      }
    }

    legs.push({
      id: `L${++li}`, type: 'troll',
      runId: c.runId, runIndex: c.runIndex,
      startM: legStartM, lengthM: legLen,
      depthFt: c.depthFt, speedMph: legMph,
      deploy,
      batteryAh: round2(a),
      estDurationMin: Math.round(mins + stopMin), estStartTime: formatClock(clock),
      why: c.why ?? null,
      coordinates: c.coordinates || [c.start, c.end],
      stops,
      // Reported, never scored. See catchSupport() in plan-candidates.js for why this is kept
      // out of the ranking, and why the resolution is "in this pocket" and not "on this line".
      yourHistory: c.support
        ? { catchesWithin300m: c.support.n, thisSpecies: c.support.speciesN,
            sameSeason: c.support.seasonN, lastCaught: c.support.lastDate,
            note: 'positions are post-fight photo locations, accurate to a few hundred metres' }
        : undefined,
    });
    runM += legLen; fishingM += legLen; ah += a; clock += mins + stopMin;
    cursor = c.end;
  }

  // ── THE ROUTE HOME ───────────────────────────────────────────────────────────────────────────
  //
  // Ryan, 2026-08-09, off the water: "this entire plan leaves me stranded miles from the ramp
  // with no timing included for getting home and no route to do it." Measured off that GPX: the
  // last leg ended 2.8 km from Clearwater Cove, and the plan carried no track home, no minutes
  // for it and no amp-hours for it. What it carried was a warning, in a list he never sees.
  //
  // THIS REVERSES A CLAUSE OF PLAN_SCHEMA_V2, ON PURPOSE, AND ONLY HALF OF IT. The schema says
  // "No return_to_launch ... when it does not [end at the ramp], the plan warns and adds
  // nothing", and it was right at the time: what it deleted was an INVENTED leg — a straight
  // line drawn from wherever the day finished back to the ramp, costed as if a kayak flies. That
  // stays deleted. What is added here is the same thing every other transit in the plan is: a
  // water-routed path from the transit router, with its own distance, its own amp-hours off the
  // curve and its own minutes, in `budget`, in `planRoute()` so it reaches the GPX, and on the
  // map. It is not a special kind of leg; it is a transit that happens to end at the ramp, and
  // `role: 'return'` is a label on it so the card can say "back to the ramp" and the map can
  // colour it, NOT a second leg type.
  //
  // When the router will not answer for this pair the straight line is still refused as a
  // finished answer: the leg is marked `unrouted`, validatePlan() fails it the way it fails any
  // other unrouted transit, and the warning says plainly that the way home has not been checked
  // for land. A straight line home is exactly the invention the schema deleted, so it is never
  // presented as a route — only as the shape of the problem.
  //
  // The over-battery and past-return-time checks below run on the budget AFTER this leg is in
  // it, which is the point: the trip home is now something the day can fail to afford.
  if (candidates.length && Array.isArray(o.launch)) {
    const gap = metresBetween(cursor, o.launch);
    if (gap > HOME_TOLERANCE_M) {
      const p = transit(cursor, o.launch) || straight(cursor, o.launch);
      const len = Math.round(p.distanceM);
      const mins = minutesFor(p.distanceM, transitMph);
      const a = ampHours(p.distanceM, transitMph);
      const homeLeg = {
        id: `T${++ti}`, type: 'transit', role: 'return',
        startM: runM, lengthM: len,
        speedMph: transitMph, batteryAh: round2(a),
        estDurationMin: Math.round(mins), estStartTime: formatClock(clock),
        coordinates: p.coordinates,
      };
      if (p.unrouted) {
        homeLeg.unrouted = true;
        warnings.push(`THE ROUTE HOME IS NOT WATER-ROUTED — ${homeLeg.id} is a straight line from `
                    + `the last leg to the ramp, ${(len / 1000).toFixed(1)} km of it. It can cross `
                    + 'land and it understates the amp-hours. Do not follow it.');
      }
      legs.push(homeLeg);
      runM += len; transitM += len; ah += a; clock += mins;
      cursor = o.launch;
    }
  }

  const windowMin = returnMin != null ? returnMin - launchMin : null;
  const plan = {
    planVersion: 2,
    meta: {
      water: o.water ?? null, slug: o.slug ?? null, ramp: o.ramp ?? null, date: o.date ?? null,
      launchTime: formatClock(launchMin),
      returnTime: returnMin != null ? formatClock(returnMin) : null,
      species: o.species || [],
    },
    conditions: o.conditions || {},
    loadout: o.loadout || { rods: [] },
    legs,
    changes,
    budget: {
      totalM: runM, fishingM, transitM,
      usableAh: o.usableAh ?? null, plannedAh: round2(ah),
      windowMin, estPlannedMin: Math.round(clock - launchMin),
    },
    safety: o.safety || {},
    warnings,
  };

  // Say when the plan does not fit, rather than presenting it as if it does.
  if (o.usableAh && plan.budget.plannedAh > o.usableAh) {
    warnings.push(`needs ${plan.budget.plannedAh} Ah of ${o.usableAh} usable — over budget`);
  }
  if (windowMin && plan.budget.estPlannedMin > windowMin) {
    warnings.push(`estimated ${plan.budget.estPlannedMin} min against a ${windowMin} min window`);
  }
  // The old warning that lived here -- "last leg ends 2.8 km from the ramp ... not in the plan"
  // -- is gone because the thing it warned about is now in the plan. `cursor` is the ramp by
  // the time it gets here, unless the last leg finished inside HOME_TOLERANCE_M of it.
  const fluoro = changes.filter((c) => c.cost === 'fluoro').length;
  if (fluoro >= FLUORO_RETIE_WARN) {
    warnings.push(`${fluoro} fluoro reties — each one is a knot in a moving kayak`);
  }

  return plan;
}

/**
 * The day's route as one line, in order, for GPX and for drawing. Walks `legs` — there is no
 * separate route object to fall out of sync with the plan.
 */
export function planRoute(plan) {
  const out = [];
  for (const leg of (plan.legs || [])) {
    for (const p of (leg.coordinates || [])) {
      const last = out[out.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
  }
  return out;
}

/** Every stop and change in the order the boat meets them, keyed on distance. */
export function planCues(plan) {
  const cues = [];
  for (const leg of (plan.legs || [])) {
    for (const s of (leg.stops || [])) {
      cues.push({ atM: leg.startM + s.atM, kind: 'stop', legId: leg.id, ref: s.id,
                  what: s.structure, rods: s.rods, depthFt: s.depthFt });
    }
  }
  for (const c of (plan.changes || [])) {
    cues.push({ atM: c.atM, kind: 'change', ref: c.id, what: `${c.rodId} → ${c.to}`, cost: c.cost });
  }
  return cues.sort((a, b) => a.atM - b.atM);
}

/** A plan whose distance spine is broken cannot drive the phone. Returns a list of problems. */
export function validatePlan(plan) {
  const bad = [];
  let expect = 0;
  for (const leg of (plan.legs || [])) {
    if (leg.startM !== expect) bad.push(`${leg.id} starts at ${leg.startM}, expected ${expect}`);
    expect = leg.startM + leg.lengthM;
    for (const s of (leg.stops || [])) {
      // +1 m of slack: a pass sits at an integer metre along the unrounded window, and the leg
      // length is that window rounded, so the last structure on a leg can land one metre past it.
      if (s.atM < 0 || s.atM > leg.lengthM + 1) bad.push(`${s.id} at ${s.atM} m is outside ${leg.id}`);
      if (!Array.isArray(s.at) || s.at.length !== 2) bad.push(`${s.id} has no position`);
    }
    if (!Array.isArray(leg.coordinates) || leg.coordinates.length < 2) {
      bad.push(`${leg.id} has no geometry`);
    }
    // NAVIGABILITY. "A plan is emitted only if every vertex of every leg lies in navigable
    // water", and "leg" means every entry in plan.legs, transits included. The full test — every
    // vertex, and every vertex densified at 60 m along a transit, resolved against the pack's
    // water_graph.bin — lives in Worker/water.js:839-857 and needs the graph, which the browser
    // does not have. What IS knowable here is provenance: a routed leg came off the graph, an
    // unrouted one is a straight line nothing water-tested. That is the assertion, and it is not
    // a stand-in for the vertex test: it is the half that can be made without inventing data.
    if (leg.unrouted) {
      bad.push(`${leg.id} is not water-routed — a straight line between two leg ends is never a `
             + 'valid transit');
    }
  }
  if (plan.budget && plan.budget.totalM !== expect) {
    bad.push(`budget.totalM ${plan.budget.totalM} does not match the legs (${expect})`);
  }
  return bad;
}
