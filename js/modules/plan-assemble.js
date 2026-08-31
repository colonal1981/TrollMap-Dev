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

import { ampHours, minutesFor, metresBetween, cumulative, pointAt, orientLegs } from './plan-candidates.js';
import { depthWindow, leadForDepth, jigheadForSwimbait } from '../data/lure-knowledge.js';
import { JIGHEADS_OWNED_OZ } from '../data/tackle-inventory.js';
import { FISHING_STYLE } from '../data/fishing-style-profile.js';
import { ozLabel } from '../utils/oz.js';

/**
 * A PADDLE TAIL HAS NO WEIGHT UNTIL A HEAD IS ON IT, AND THE LEAD MATHS NEEDS ONE.
 *
 * Ryan, 2026-08-30, reading his own plan: "for the jig head with a 4.6in swimbait... what weight
 * jig head is it using for the lead, speed, and depth calculations?"
 *
 * The answer was 1oz, and nothing chose it. `Swimbait 4.6" – Jighead` carries `weightOz: null`
 * in the inventory -- correctly, the head IS the weight -- and `applyWeight()` short-circuits on
 * a falsy weight and hands back the ratio unchanged. That ratio, 4.0, is quoted at refOz 1.0. So
 * every paddle tail in every plan was silently priced as a 1oz head.
 *
 * The Spread tab never had this bug: `autoCalculateLead()` calls `jigheadForSwimbait()` first
 * and leads for the head it picked. This path just never called it. Two code paths, two answers,
 * ~44 ft of lead apart on the same bait at the same depth.
 *
 * WHICH DEPTH IS THE TARGET. The model's `runsDepthFt` -- where IT wants the bait -- and not the
 * lead it asked for in the same breath. That is the division of labour this whole file is built
 * on: depth is judgement, and the head plus the lead that reaches it is arithmetic. The model was
 * never told a head weight, so its lead was a number about a bait with no mass. Falling back to
 * the leg's ceiling when it names no depth is not a guess either -- it is the deepest the bait
 * may legally run here, measured off this leg's own envelope.
 */
function fitJighead(lure, rod, speedMph, ceilingFt, id, runId, warnings) {
  const runs = Array.isArray(rod.runsDepthFt) && rod.runsDepthFt.every(Number.isFinite)
    ? (rod.runsDepthFt[0] + rod.runsDepthFt[1]) / 2 : null;
  const target = Number.isFinite(runs) ? runs : ceilingFt;
  if (!Number.isFinite(target) || target <= 0) return null;

  const fit = jigheadForSwimbait(lure, target, speedMph,
                                 { jigheads: JIGHEADS_OWNED_OZ,
                                   maxLeadFt: FISHING_STYLE.rigging?.maxLeadFt });
  if (!fit) return null;                       // not a paddle tail; the lure carries its own weight
  if (fit.weightOz == null) {
    warnings.push(`${id} on ${runId}: a ${rod.lure} has no head the app can fit — ${fit.note}`);
    return null;
  }
  // The two ways it binds mean opposite things, so they are never said the same way.
  if (fit.cappedBy === 'length') {
    warnings.push(`${id} on ${runId}: a ${rod.lure} tops out at a ${fit.range.maxOz}oz head — any `
                + `heavier and the hook tears the bait apart — so ${Math.round(target)} ft needs `
                + `${fit.leadFt} ft of lead. Go to a longer swimbait if you want that depth.`);
  } else if (fit.cappedBy === 'lead') {
    warnings.push(`${id} on ${runId}: a ${rod.lure} on the heaviest head it will carry `
                + `(${ozLabel(fit.weightOz)}) still needs ${fit.leadFt} ft of lead to make `
                + `${Math.round(target)} ft, past the ${FISHING_STYLE.rigging?.maxLeadFt} ft you run.`);
  }
  return fit;
}

/**
 * THE SHALLOWEST WATER ON THE LEG IS A CEILING ON HOW DEEP THE BAIT MAY RUN.
 *
 * Ryan, 2026-08-11: "the shallowest that water runs is 20ft... well then even if the water is
 * 25-35ft don't give me a bait that runs deeper than 20ft with the lead and speed that you gave."
 *
 * This is the number the model needed and never had. `holdsFt` is a THRESHOLD — the shallowest
 * point the whole stretch clears, set by one shoal somewhere along it — so a leg described as
 * "22-31 ft of water" can still have a single 20 ft rise on it, and a bait running 26 drags
 * bottom there on every pass. The app has measured that number since the envelope landed; it was
 * being shown to Ryan in the reasons and never told to the model.
 *
 * IT IS CHECKED, NOT ASKED FOR. Same reasoning as the lure-change validator below: a constraint
 * stated in a prompt is a request, and this one is arithmetic the app owns outright.
 * `depthWindow()` inverts `leadForDepth()` numerically, so it answers exactly the question in
 * Ryan's sentence — where does THIS lure run at THIS lead and THIS speed.
 *
 * AND THE FIX IS TO SHORTEN THE LEAD, NOT TO REFUSE THE PLAN. `leadForDepth(lure, ceiling, mph)`
 * is the lead that puts the same bait at the ceiling. Lead length for a target depth is
 * computation, which is the app's half of the split PLAN_SCHEMA_V2 draws everywhere: judgement to
 * the model, arithmetic to the app. Refusing would throw away a good bait over a number the app
 * can just correct — and the correction is said out loud so it is never silent.
 *
 * Needs `o.lureByName` to resolve a rod's lure NAME to the inventory object, because that is all
 * the loadout carries — `LURE_KNOWLEDGE` is keyed by `type` and the lead maths needs `weightOz`.
 * Without a resolver this does nothing at all and says nothing, exactly like a pack with no
 * shoreline: an absent input must not become a claim.
 */
function capBaitDepth(rods, deploy, ceilingFt, speedMph, lureByName, runId, warnings) {
  // RETURNS WHAT THIS LEG FISHES; IT DOES NOT CHANGE THE BAG.
  //
  // This used to write `rod.leadFt = shorter` straight into the loadout, and the loadout is ONE
  // array shared by every leg -- plan-to-timeline.js:151 builds `rodsById` from it and looks each
  // leg's rods up by id. So the shallowest leg of the day set the lead for all of them.
  //
  // Ryan's 2026-08-30 Wateree plan is the whole bug in one line of its own warnings: "R2 on
  // wateree_lake#362: a Fluke / Soft Jerkbait on 80 ft of lead at 2 mph runs to 15 ft, and the
  // shallowest water on this leg is 6 ft -- shortened the lead to 24 ft so it clears". Leg 2 is
  // the 6 ft line and that cap is right FOR LEG 2. Legs 1 and 3 are the 24 ft line with the
  // stripers at 15-27 ft, and they inherited it: the fluke came out at 24 ft of lead running
  // 2-6 ft for 78 of the day's 115 trolling minutes, nine to twenty-one feet above the fish.
  // Nothing in the plan said so, because as far as the plan knew there was one lead.
  //
  // A lead IS per-pass -- you let line out on the deep leg and reel it in on the shallow one.
  // The loadout is the bag; the leg is what is behind the boat on that leg.
  if (typeof lureByName !== 'function' || !Number.isFinite(ceilingFt) || ceilingFt <= 0) return null;
  const ids = [deploy && deploy.port, deploy && deploy.starboard].filter(Boolean);
  const forThisLeg = {};
  for (const id of ids) {
    const rod = rods.find((r) => r.id === id);
    if (!rod) continue;
    const lureAsBought = lureByName(rod.lure);
    if (!lureAsBought) continue;

    // Fit a head FIRST, or every number after this is about a bait with no mass. See fitJighead().
    //
    // Before the lead guard, not after: a paddle tail's lead is DERIVED from the head, so a rod
    // the model gave a depth and no lead is answerable here. Skipping it -- which is what the
    // guard used to do to every rod without a lead -- is the same silence that let a swimbait
    // fish a whole day at a weight nobody picked.
    const fit = fitJighead(lureAsBought, rod, speedMph, ceilingFt, id, runId, warnings);
    const lure = fit ? { ...lureAsBought, weightOz: fit.weightOz } : lureAsBought;
    let leadFt = fit ? fit.leadFt : rod.leadFt;

    // A LEAD OF ZERO IS NOT A LEAD.
    //
    // Ryan's plan of 2026-08-31 quoted `DD2 Crankbait (16-20ft) @ 0ft` on every leg it was on.
    // The model had answered `leadFt: 0` for all three of its lipped baits, and it is easy to see
    // why: rule 7 tells it a bill sets how deep a crankbait runs and no length of lead lifts it,
    // which is true about DEPTH and says nothing about DISTANCE. At 0 ft the bait is at the rod
    // tip, in the boat's wake, which is not a thing to go and do.
    //
    // Nothing caught it. `0` is finite, so the guard below let it through; `depthWindow()` on a
    // rated bait reports the printed band whatever the lead, so the leg read 16-20 ft and every
    // check after it passed. The zero rode all the way to the card.
    //
    // The replacement is not a number anyone made up -- it is `leadForDepth()`, the same function
    // this file already uses to shorten a lead, asked for the depth the bait is built to run. A
    // lead-controlled bait with no lead still cannot be answered here (its window IS the lead, so
    // there is nothing to invert) and falls through to the skip below, as it always did.
    if (!fit && !(Number.isFinite(leadFt) && leadFt > 0)) {
      const rated = depthWindow(lure, { speedMph, leadFt: null });
      const want = rated.claimed && Number.isFinite(rated.max)
        ? leadForDepth(lure, rated.max, speedMph) : null;
      if (Number.isFinite(want) && want > 0) {
        warnings.push(`${id} on ${runId}: the plan put a ${rod.lure} on `
                    + `${Number.isFinite(leadFt) ? `${leadFt} ft of lead` : 'no lead at all'}. The `
                    + 'bill sets how DEEP it runs, not how far BEHIND the boat it is — at the rod '
                    + `tip it is in the wake. Let out ${want} ft, which is what it takes to work `
                    + `a bait rated to ${rated.max} ft.`);
        leadFt = want;
        forThisLeg[id] = { ...(forThisLeg[id] || {}), leadFt };
      }
    }
    if (!Number.isFinite(leadFt)) continue;
    // A fitted head is reported whether or not anything else about this leg had to move. It is
    // the number Ryan asked for and could not find: `jigWeight` was an empty string on every row
    // of every plan, because nothing had ever chosen one.
    if (fit) forThisLeg[id] = { jigheadOz: fit.weightOz, leadFt };

    const w = depthWindow(lure, { speedMph, leadFt });

    // A BAIT WITH NO RUNNING DEPTH IS NOT A QUIET PASS, IT IS A ROD FISHING NOTHING.
    //
    // This was `continue` — silence — and silence is how a Fluke ended up on the starboard troll
    // rod for all three legs of Ryan's 2026-08-30 Wateree day. It is `trollable: false` in his own
    // inventory and `technique: 'Cast only'` in LURE_KNOWLEDGE, and nothing between the model and
    // the water said either of those out loud. His question when he found it: "and if it is
    // weightless you think a fluke at 2mph is even going to sink?" It does not. It planes.
    if (w.mode === 'none') {
      warnings.push(`${id} on ${runId}: a ${rod.lure} is a CAST-ONLY bait. It planes at `
                  + `${speedMph} mph instead of sinking, so it has no running depth and no lead `
                  + `puts it at one — that rod is fishing nothing on this leg.`);
      continue;
    }
    if (!Number.isFinite(w.max)) continue;

    // The model also CLAIMS a running depth. Nothing has ever checked that claim against the
    // lead it asked for in the same breath, and the two can disagree by a lot.
    if (Array.isArray(rod.runsDepthFt) && Number.isFinite(rod.runsDepthFt[1])
        && Math.abs(rod.runsDepthFt[1] - w.max) > 4) {
      warnings.push(`${id} on ${runId} says it runs to ${rod.runsDepthFt[1]} ft, but `
                  + `${leadFt} ft of lead at ${speedMph} mph`
                  + `${fit ? ` on a ${ozLabel(fit.weightOz)} head` : ''} puts a ${rod.lure} at `
                  + `${w.max} ft — going with the measured number`);
      forThisLeg[id] = { ...(forThisLeg[id] || {}), runsDepthFt: [w.min, w.max] };
    }

    if (w.max <= ceilingFt) continue;

    // AIMING AT THE CEILING IS NOT CLEARING IT, and the first version of this did exactly that.
    //
    // `leadForDepth()` places the CENTRE of the window at the depth asked for; `depthWindow()`
    // reports a band either side. Measured on a 3" Lipless Crankbait: leadForDepth(18 ft, 2.0) is
    // 95 ft of lead, and 95 ft of lead runs **16-20 ft**. So asking for the ceiling leaves the
    // bottom of the bait's range 2 ft BELOW the shallowest water -- still dragging, and now with
    // a warning saying it had been fixed, which is worse than not fixing it.
    //
    // So the target walks down until the WINDOW clears, because that is the thing that has to be
    // true. Six passes is far more than the band ever needs and bounds it against a lure whose
    // ratio makes it not converge.
    let shorter = null;
    for (let target = ceilingFt, i = 0; i < 6 && target > 0; i++) {
      const lead = leadForDepth(lure, target, speedMph);
      if (!Number.isFinite(lead) || lead <= 0) break;
      const got = depthWindow(lure, { speedMph, leadFt: lead });
      if (!Number.isFinite(got.max)) break;
      if (got.max <= ceilingFt) { shorter = lead; break; }
      target -= Math.max(1, got.max - ceilingFt);
    }

    // Lead-controlled baits can be brought up by shortening the lead. A lipped or weighted bait
    // that dives on its own cannot, and there the honest answer is that it is the wrong bait for
    // this leg -- said plainly rather than corrected into something it is not.
    if (w.mode === 'lead' && shorter && shorter < leadFt) {
      warnings.push(`${id} on ${runId}: a ${rod.lure}${fit ? ` on a ${ozLabel(fit.weightOz)} head` : ''} `
                  + `on ${leadFt} ft of lead at ${speedMph} mph runs to ${w.max} ft, and the `
                  + `shallowest water on this leg is ${ceilingFt} ft — shortened the lead to `
                  + `${shorter} ft so it clears`);
      const nw = depthWindow(lure, { speedMph, leadFt: shorter });
      forThisLeg[id] = { ...(forThisLeg[id] || {}), leadFt: shorter,
                         runsDepthFt: Number.isFinite(nw.max) ? [nw.min, nw.max]
                                                              : (forThisLeg[id] || {}).runsDepthFt };
    } else {
      warnings.push(`${id} on ${runId}: a ${rod.lure} runs to ${w.max} ft and the shallowest water `
                  + `on this leg is ${ceilingFt} ft. Its depth is ${w.controlledBy}, so lead will `
                  + `not lift it — it is the wrong bait for this pass`);
    }
  }
  return Object.keys(forThisLeg).length ? forThisLeg : null;
}

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

// The share of the day's distance that may be deadhead before the plan says so out loud.
//
// THIS IS A JUDGEMENT AND NOT A MEASUREMENT. Nothing measured where a day stops being a fishing
// trip and starts being a commute, and Ryan has never been asked to put a number on it. It is set
// at a third because the plan of 2026-08-09 came in at 46% — totalM 28040, fishingM 15250,
// transitM 12790 — and he called that stranded and wasteful, while the schema's own worked
// example in PLAN_SCHEMA_V2 sits at 18% (2697 of 14697) and reads as a normal day. A third is
// between them and nearer the good one. If a plan that is genuinely fine starts tripping this,
// that is this number and not the plan.
//
// It is a WARNING and never a filter. Some water is far apart and some days are worth the ride;
// the plan's job is to say what it costs, not to refuse it.
const TRANSIT_SHARE_WARN = 0.35;

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
 * @param {function} [o.lureByName] (name) => inventory lure, so the bait-depth ceiling can be
 *                                  checked. Absent = not checked, and nothing is claimed.
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

  /**
   * MAKE THE TRANSIT ACTUALLY TOUCH WHAT IT CONNECTS.
   *
   * Ryan, 2026-08-09: "the transit legs do not actually connect to the trolling legs". Measured
   * off that plan's GPX: T1 ends 70 m from where L1 starts, L1 ends 77 m from T2, L2 ends 55 m
   * from T3. The dashed line stops short of the cyan one and nothing carries the boat the last
   * two hundred feet.
   *
   * The router walks the water graph and returns a path of CELL CENTROIDS, so its first and last
   * points are the centres of the cells containing the endpoints -- not the endpoints. That is
   * the same centroid-versus-geometry mistake as the old zigzag, surviving at the two ends after
   * being fixed in the middle.
   *
   * So the true endpoints are stitched back on. The joining hop is tens of metres between two
   * points already known to be on water -- a graph cell centre, and a vertex of a fitted trolling
   * line that lives inside its own depth band -- which is a far better bet than a visible gap the
   * boat is left to guess at. The distance is recomputed from the joined geometry so the budget
   * counts the metres it just added.
   */
  const joinEnds = (p, from, to) => {
    const c = (p.coordinates || []).slice();
    if (!c.length) return { ...p, coordinates: [from, to] };
    const same = (a, b) => a && b && metresBetween(a, b) < 1;
    if (!same(c[0], from)) c.unshift(from);
    if (!same(c[c.length - 1], to)) c.push(to);
    let d = 0;
    for (let i = 1; i < c.length; i++) d += metresBetween(c[i - 1], c[i]);
    return { ...p, coordinates: c, distanceM: d };
  };
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
  // WHERE IS EACH ROD USED, AND HOW LATE?
  //
  // Ryan, 2026-08-09, on a plan that swapped R5 at 8,993 m: "has me change a lure for what
  // reason i can't tell... as there is no other stop and cast planned after it has me change
  // it." He was right -- the day's only stop was at 6,705 m, BEFORE the swap, and R5 was never
  // in the water or at a stop again. The reason given ("maintain vertical contact with fish
  // holding deeper") was a presentation argument for a rod that would not be presented.
  //
  // This is checkable without asking the model to behave better, so it is checked here: a change
  // is justified only if the rod it touches is deployed on, or cast at, a leg at or after the
  // one the change happens before. Stops are read RAW here, before structure resolution -- a
  // change justified by a stop that is later refused stays, because dropping a legitimate change
  // is a worse failure than keeping a marginal one.
  const legOrder = new Map(candidates.map((c, i) => [c.runId, i]));
  const rodLastUsed = new Map();
  const useRod = (id, i) => {
    if (!id) return;
    if (!rodLastUsed.has(id) || rodLastUsed.get(id) < i) rodLastUsed.set(id, i);
  };
  candidates.forEach((c, i) => {
    const d = (o.deploy && o.deploy[c.runId]) || {};
    useRod(d.port, i);
    useRod(d.starboard, i);
    for (const s of (stopsByRun.get(c.runId) || [])) for (const r of (s.rods || [])) useRod(r, i);
  });

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

  // WHICH WAY ROUND EACH PASS IS TROLLED — decided once, in plan-candidates.js, from straight-line
  // distance only. prefetchTransits() calls the same function on the same list before it asks the
  // router for anything, so the pairs it fetched are exactly the pairs walked below. If this ever
  // stops matching, every flipped leg silently degrades to an unrouted straight line.
  const facing = orientLegs(candidates, o.launch);

  for (const [ci, c] of candidates.entries()) {
    // A lure change happens where the boat is, before the leg starts — so it carries the current
    // cumulative distance, not a time. Cost comes from the rod's rig, not from the model's
    // opinion: a snap is seconds, a fluoro leader is a knot with wet hands. A change naming a rod
    // that is not in the loadout is a change to a seventh rod, and is refused.
    for (const ch of (changeByRun.get(c.runId) || [])) {
      const rod = rods.find((r) => r.id === ch.rodId);
      if (!rod) { warnings.push(`dropped a lure change on ${ch.rodId} — no such rod in the loadout`); continue; }
      const usedAt = rodLastUsed.has(ch.rodId) ? rodLastUsed.get(ch.rodId) : -1;
      if (usedAt < (legOrder.get(c.runId) ?? 0)) {
        warnings.push(`dropped a lure change on ${ch.rodId} before ${c.runId} — that rod is `
                    + 'never trolled or cast again after it, so the swap costs a retie and '
                    + 'buys nothing');
        continue;
      }
      changes.push({
        id: `C${changes.length + 1}`, atM: runM, rodId: ch.rodId,
        cost: rod.rig === 'fluoro' ? 'fluoro' : 'snap',
        from: ch.from ?? rod.lure ?? null, to: ch.to ?? null, why: ch.why ?? null,
      });
    }

    const { flipped, start: legStart, end: legEnd,
            passes: legPasses = 1, finish: legFinish = legEnd } = facing[ci];

    // Transit to the head of the leg.
    const p = joinEnds(transit(cursor, legStart) || straight(cursor, legStart), cursor, legStart);
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
      // A FLOOR THAT WAS ASKED FOR AND NOT HELD IS A THING HE HAS TO KNOW BEFORE HE GETS THERE.
      // The Worker relaxes `min_depth_ft` rather than refusing to route, which is right -- but a
      // relaxation nobody is told about is the same as never asking. See waterRouter().
      if (p.minDepthHeld === false) {
        tleg.minDepthHeld = false;
        tleg.shallowM = p.shallowM;
        // THE METRES, NOT THE VERDICT. The router spends the least shallow water it can rather
        // than abandoning the floor, so "40 m of it" is usually the boat leaving the bank and
        // "600 m of it" is a leg worth looking at. Saying only "the floor was dropped" made
        // those two read the same. See pathPreferringDepth() in Worker/water.js.
        warnings.push(`${tleg.id} crosses ${p.shallowM ?? '?'} m of water shallower than the `
                    + `${p.askedDepthFt ?? '?'} ft you asked for`
                    + (Number.isFinite(p.shallowestFt) ? `, down to ${p.shallowestFt} ft` : '')
                    + ' — it is the least shallow water there is between those two points, so '
                    + 'look at it before you run it.');
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
        // `hit.atM` is metres along the line AS DRAWN. Trolled the other way, the same piece of
        // structure sits the same distance from the OTHER end — so the mark has to be mirrored or
        // every stop on a flipped leg lands at its own reflection. `at` is a coordinate and does
        // not move; only the distance along does.
        atM: flipped ? Math.max(0, Math.round(c.lengthM - hit.atM)) : hit.atM,
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

    // A LEG WITH NOTHING IN THE WATER IS SAID OUT LOUD. IT IS NOT FILLED IN.
    //
    // Ryan, 2026-08-11: "i think baits are missing in a couple of lanes." Measured off that plan:
    // L1, L3, L5 and L7 carried rods; L2, L4 and L6 carried nothing. The model had rigged a DD2
    // (16-20 ft) and a DD3 (20-25 ft) and deployed them only where the WATER was 16-25 ft deep,
    // skipping the 30, 32 and 36 ft legs — it was matching bait depth to the lake bed.
    //
    // "the fish aren't on the bottom." A bait at 20 ft over 36 ft of water is right, and those
    // legs should have carried the same two rods. The fix belongs in the prompt (rules 6 and 7),
    // NOT here: carrying the previous leg's rods forward would paper over a wrong plan and make
    // it look complete, which is the one thing worse than an empty leg. So this reports and stops.
    if (!deploy) {
      warnings.push(`${c.runId} has no rods in the water for `
                  + `${(c.lengthM / 1609.34).toFixed(1)} mi. A leg is not fished by being in the `
                  + `list — check what got rigged and for what depth.`);
    }
    if (deploy) {
      for (const side of ['port', 'starboard']) {
        const id = deploy[side];
        if (id && !rods.some((r) => r.id === id)) {
          warnings.push(`${c.runId} deploys ${id} on the ${side} — no such rod in the loadout`);
        }
      }
    }

    // No bait may run deeper than the shallowest water on this leg. See capBaitDepth().
    // `maxRunDepthFt` is preferred over `depthFt` because the two answer different questions:
    // the ceiling is the SHALLOWEST water on the leg, `depthFt` the MEDIAN. Both planners now
    // measure both from the same envelope profile — see waterBand() in plan-pieces.js — so the
    // fallback below only fires on a pack fitted before those profiles existed.
    const rodPlan = capBaitDepth(rods, deploy, Number(c.maxRunDepthFt ?? c.depthFt), legMph,
                                 o.lureByName, c.runId, warnings);

    legs.push({
      id: `L${++li}`, type: 'troll',
      runId: c.runId, runIndex: c.runIndex,
      startM: legStartM, lengthM: legLen,
      // THE LEG IS A RANGE OF WATER AND SAYS SO. The median is what it is called; the two ends
      // are what a lure depth is judged against. Absent on a pack with no envelope profile.
      depthFt: c.depthFt, depthMinFt: c.depthMinFt ?? null, depthMaxFt: c.depthMaxFt ?? null,
      speedMph: legMph,
      deploy,
      // WHAT THIS LEG ACTUALLY FISHES, where it differs from the bag. Only the rods capBaitDepth
      // had to move, keyed by rod id: { R2: { leadFt, runsDepthFt } }. Absent when the loadout's
      // own lead clears this leg, and every reader falls back to the rod.
      rodPlan: rodPlan || undefined,
      batteryAh: round2(a),
      estDurationMin: Math.round(mins + stopMin), estStartTime: formatClock(clock),
      why: c.why ?? null,
      // Drawn the way it will be RUN. The GPX, the map and the phone's "what is next" all read
      // this array in order, so a flipped leg whose geometry still ran the other way would draw
      // the boat backwards along its own track.
      coordinates: flipped
        ? (c.coordinates ? c.coordinates.slice().reverse() : [legStart, legEnd])
        : (c.coordinates || [legStart, legEnd]),
      trolledReversed: flipped || undefined,
      // Reversed with the geometry, because station 0 is the start of the line AS DRAWN and a
      // flipped leg meets the stations the other way round. Absent on candidates that never
      // measured one, and every reader treats absent as "not known".
      envelope: c.envelope ? (flipped ? c.envelope.slice().reverse() : c.envelope) : undefined,
      envelopeStepM: c.envelopeStepM,
      stops,
      // WHAT THE LEG GOES BY, not just what the model chose to stop on.
      //
      // Ryan wants these on the Echomap as waypoints for a reason that is not navigation: "so i
      // can see them on the echomap to compare if they are actually showing where 1 garmin says
      // the structure is and 2 where the actual fish finder shows the structure is".
      //
      // That is a ground-truth loop, and it is the only instrument that can close the gaps this
      // project keeps writing down as unmeasurable. `near[]` carries no depth for timber, piles or
      // attractors, and how far a stand of wood rises off the bottom is "how tall is every tree
      // claude??? that is the answer lol" -- but a sounder passing over a marked stand answers it
      // one mark at a time. Same for whether the charted offsets are trustworthy at all.
      //
      // Mirrored on a flipped leg for the same reason `stops` are: `atM` is distance along the
      // line AS DRAWN, and the boat may run it the other way.
      marks: (c.passes || []).map((h) => ({
        id: h.id, type: h.type, what: h.what, at: h.at,
        atM: flipped ? Math.max(0, Math.round(legLen - h.atM)) : h.atM,
        offM: h.offM,
        // Null stays null. A waypoint labelled with a guessed depth would poison the very
        // comparison it exists to enable.
        depthFt: h.depthFt ?? null,
        worthFishing: h.weight === undefined ? undefined : h.weight > 0,
      })),
      // Reported, never scored. See catchSupport() in plan-candidates.js for why this is kept
      // out of the ranking, and why the resolution is "in this pocket" and not "on this line".
      yourHistory: c.support
        ? { catchesWithin300m: c.support.n, thisSpecies: c.support.speciesN,
            sameSeason: c.support.seasonN, lastCaught: c.support.lastDate,
            note: 'positions are post-fight photo locations, accurate to a few hundred metres' }
        : undefined,
    });
    const first = legs[legs.length - 1];
    runM += legLen; fishingM += legLen; ah += a; clock += mins + stopMin;

    // ── FISHING IT BACK ────────────────────────────────────────────────────────────────────────
    //
    // Ryan, 2026-08-31, on a Colonel Creek plan of seven legs and eight transits: "its because
    // they have no concept of running back the other direction... there should be almost no
    // deadheading there". He was right and it was structural, not a tuning problem: a runId could
    // appear once, so a pass could be fished once, and every return over water that had just
    // produced had to be spent as a transit to somewhere else. Measured off that plan's GPX, the
    // in-field deadhead was 2093 m against 4272 m fished; letting a leg be fished back takes it to
    // 1638 m against 5455 m. Clearwater went from 31% to 16% the same way.
    //
    // A pass is a piece of water, not an errand. `trollPasses` is the model's call -- the fishing
    // judgement about whether this stretch deserves a second look -- and everything below is the
    // arithmetic that call implies, which is the app's. Same split as orientLegs.
    //
    // EACH PASS IS A REAL LEG. It gets its own id, its own minutes, its own amp-hours and its own
    // geometry, because the boat really does run it and the budget really does pay for it. The
    // alternative -- one leg carrying a multiplier -- would have every reader of `lengthM`,
    // `coordinates` and `estDurationMin` quietly understating the day, and the GPX would draw one
    // track for two runs.
    //
    // STOPS AND LURE CHANGES BELONG TO THE FIRST PASS ONLY. A stop is a place he stops and casts;
    // repeating it because the trolling pass repeated would invent time he never agreed to spend.
    if (legPasses > 1) { first.pass = 1; first.ofPasses = legPasses; }
    for (let np = 2; np <= legPasses; np++) {
      // NO INVENTED CEILING ON THE PASS COUNT. What bounds the day is the time he has to be off
      // the water, which is already known here and already what the budget is judged against. So
      // the passes stop at the first one that would end after it, and say which one.
      if (returnMin != null && clock + mins > returnMin) {
        warnings.push(`${c.runId} asked for ${legPasses} passes — stopped after ${np - 1}, `
                    + `pass ${np} would end after ${formatClock(returnMin)}`);
        break;
      }
      const prev = legs[legs.length - 1];
      legs.push({
        ...first,
        id: `L${++li}`,
        startM: runM,
        // No `stopMin`: the stops are on the first pass and are not repeated.
        estDurationMin: Math.round(mins), estStartTime: formatClock(clock),
        // Drawn the way it will be RUN, which is the way the pass before it was not.
        coordinates: (prev.coordinates || []).slice().reverse(),
        trolledReversed: prev.trolledReversed ? undefined : true,
        envelope: prev.envelope ? prev.envelope.slice().reverse() : undefined,
        // Mirrored off the pass before, for the same reason that one was mirrored off the line as
        // drawn: `atM` is distance along THIS pass, and this pass runs the other way.
        marks: (prev.marks || []).map((m) => ({
          ...m, atM: Math.max(0, Math.round(legLen - m.atM)),
        })),
        stops: [],
        pass: np, ofPasses: legPasses,
      });
      runM += legLen; fishingM += legLen; ah += a; clock += mins;
    }

    // WHERE THE BOAT STANDS WHEN THE LEG IS DONE. Fished an even number of times it is back at
    // the end it came in by, and the transit to the next leg is measured from there -- which is
    // the whole saving, and reading `legEnd` here would throw it away and route the next transit
    // from a place the boat is not.
    cursor = legFinish;
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
      const p = joinEnds(transit(cursor, o.launch) || straight(cursor, o.launch),
                         cursor, o.launch);
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
      if (p.minDepthHeld === false) {
        homeLeg.minDepthHeld = false;
        homeLeg.shallowM = p.shallowM;
        warnings.push(`THE ROUTE HOME crosses ${p.shallowM ?? '?'} m of water shallower than the `
                    + `${p.askedDepthFt ?? '?'} ft you asked for`
                    + (Number.isFinite(p.shallowestFt) ? `, down to ${p.shallowestFt} ft` : '')
                    + ' — look at it before you run it.');
      }
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
  // HOW MUCH OF THE DAY IS SPENT GETTING THERE. The budget has separated fishingM from transitM
  // since the schema was written and nothing ever read the split back. The ordering is the
  // model's (PLAN_SCHEMA_V2, "MODEL DECIDES: which runId, in which order") and it is now shown
  // the inter-leg distances to order on — see `transitToM` in plan-candidates.js — so this is
  // the check on whether it used them, in the plan where Ryan will see it rather than in a
  // console.
  if (plan.budget.totalM > 0 && transitM / plan.budget.totalM > TRANSIT_SHARE_WARN) {
    const pct = Math.round((transitM / plan.budget.totalM) * 100);
    warnings.push(`${pct}% of the day is deadheading — ${(transitM / 1000).toFixed(1)} km of `
                + `${(plan.budget.totalM / 1000).toFixed(1)} km with nothing in the water. `
                + 'The legs are good ones; the order they are in is expensive.');
  }
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
  cues.push(...depthCues(plan));
  return cues.sort((a, b) => a.atM - b.atM);
}

/**
 * THE SHALLOW SPOT, ANNOUNCED BEFORE YOU REACH IT.
 *
 * Ryan's notification list: "depth change, lure change, weather warnings, stop and cast coming
 * up". Three of those already exist as cues. This is the fourth, and it is the one only the
 * envelope can answer — the sounder finds a shoal when the boat is on it, which is late, because
 * THE BAITS ARE STILL BEHIND THE BOAT.
 *
 * WHICH IS WHERE THE LEAD COMES FROM, and it is derived rather than invented. The spread runs
 * 60–100 ft behind — "a number the app already sets" — so a bait reaches a spot roughly one
 * spread-length after the boat does. Firing the cue one spread-length early means the warning
 * arrives while there is still water between the baits and the shoal. No reaction-time constant
 * is guessed at; if he wants more warning that is a longer spread, and the number moves with it.
 *
 * WHAT COUNTS AS A CHANGE is measured against the leg's own water, not a constant. A 6 ft rise on
 * a leg that runs 40 ft deep is scenery; the same rise on a leg that holds 12 ft is the spot that
 * decides the whole pass. So the trigger is the shallowest station on the leg and anything within
 * a stone's throw of it, which is exactly the water `holdsFt` was already reporting.
 *
 * Silent when the leg carries no envelope. Absent is not flat.
 */
export function depthCues(plan, { spreadM = 27 } = {}) {
  const out = [];
  for (const leg of ((plan && plan.legs) || [])) {
    const env = leg.envelope;
    const step = leg.envelopeStepM;
    if (!Array.isArray(env) || env.length < 3 || !(step > 0)) continue;
    const real = env.filter((d) => d >= 0);
    if (!real.length) continue;
    const min = Math.min(...real);
    // A DEPTH-CHANGE CUE HAS TO FIRE ON A CHANGE, and the first version did not check for one.
    // `min` is the shallowest station, so on FLAT water every station is the shallowest and it
    // fired at all of them -- a 30 ft leg announcing "30 ft ahead, the shallowest water on this
    // leg" every 40 m, which is noise dressed as a warning.
    //
    // The bar is 2 ft below the leg's own median, and 2 ft is not a preference: the chart is
    // contoured in feet, the corridor spans 1-4 ft on Wateree, and the pool sits about two feet
    // down. A rise smaller than that is inside the measurement, not a shoal.
    const sorted = real.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    if (min > median - 2) continue;
    // Within 2 ft of the shallowest is the same spot as far as a bait is concerned.
    let fired = -Infinity;
    for (let i = 0; i < env.length; i++) {
      if (env[i] < 0 || env[i] > min + 2) continue;
      const spotM = i * step;
      // One cue per shoal, not one per station: consecutive stations are the same shallow water.
      if (spotM - fired < spreadM * 3) continue;
      fired = spotM;
      const atM = Math.max(0, spotM - spreadM);
      out.push({
        atM: (leg.startM || 0) + atM,
        kind: 'depth', legId: leg.id, ref: `${leg.id}:d${i}`,
        depthFt: env[i],
        aheadM: spreadM,
        what: `${env[i]} ft in ${spreadM} m — the shallowest water on this leg, and your baits `
            + `are still behind you`,
      });
    }
  }
  return out;
}

/**
 * WEATHER — THE ONE LEGITIMATE EXCEPTION TO DISTANCE-INDEXING, AND IT SAYS SO.
 *
 * PLAN_SCHEMA_V2 is emphatic that every trigger is metres, because "the clock starts drifting the
 * moment he hooks a fish, and it never catches up". That reasoning is about the BOAT. Weather does
 * not care where the boat is: a storm arrives at two o'clock whether he has covered three miles or
 * eight, so a distance-keyed storm warning would fire late on exactly the day he stopped to fish.
 *
 * So these carry `atHour` and no `atM`, deliberately. Do not "fix" this by deriving a distance —
 * that would reintroduce the drift the schema exists to keep out, pointing the other way.
 *
 * THUNDER IS NOT WEATHER, IT IS AN EVACUATION. Ryan: "not just wind... thunderstorms/rain would be
 * a big one too". Lightning is the one hazard a pedal kayak has no answer to.
 *
 * AND THE LEAD TIME IS DERIVED, not chosen — the same move as the spread-length lead on a depth
 * cue. Getting off the water takes as long as the run home takes, and the plan knows the furthest
 * point of the day from the ramp. So the warning is "leave by", computed from that distance at
 * transit speed. It uses the FURTHEST point rather than a guess at where he will be, because
 * where he will be depends on the clock and the clock is the thing that cannot be trusted. A
 * bound, not a prediction.
 */
export function weatherCues(plan, weatherByHour, o = {}) {
  const transitMph = o.transitMph ?? 3.5;
  const out = [];
  // The furthest any leg gets from the ramp: the worst run home this plan can owe.
  let farthestM = 0;
  for (const leg of ((plan && plan.legs) || [])) {
    for (const key of ['transitFromRampM', 'transitToRampM']) {
      const v = Number(leg[key]);
      if (Number.isFinite(v) && v > farthestM) farthestM = v;
    }
  }
  if (!farthestM && Number.isFinite(o.farthestM)) farthestM = o.farthestM;
  const homeMin = Math.round(minutesFor(farthestM, transitMph));
  const hhmm = (h) => `${String(Math.floor(((h % 24) + 24) % 24)).padStart(2, '0')}:`
                    + `${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;

  // ── NWS WATCHES, WARNINGS AND ADVISORIES ────────────────────────────────────────────────
  //
  // Ryan, 2026-08-25: *"the weather alerts absolutely need to be included in the
  // notifications.js that sends alerts from my phone to the garmin echomap ... but are these
  // current alerts or forecasted?"*
  //
  // BOTH, AND `severity` IS WHICH. Measured off the live layer the same day:
  //
  //     Flash Flood Watch   issued 12:17   onset 14:00 same day     1h43m out
  //     Flash Flood Watch   issued 12:17   onset 12:00 NEXT DAY      ~24h out
  //     Fire Weather Watch  issued 10:39   onset 12:00 in TWO DAYS   ~2 days out
  //
  // A Warning is in effect. A Watch is a forecast. An Advisory is in effect and milder. So a
  // Watch gets the same treatment as forecast thunder -- the leave-by, computed from the run
  // home -- and a Warning already in effect fires on the next tick because its hour is behind us.
  // One formula covers both: the cue's hour is the hazard's start minus the run home.
  //
  // ONLY TODAY'S. A watch whose onset is noon on Thursday must not fire a notification on
  // Tuesday, and hour-of-day alone cannot tell those apart -- the date has to be read.
  const nowMs = Number.isFinite(o.now) ? o.now : Date.now();
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const today = dayKey(new Date(nowMs));
  const SEVERITY = { Warning: 'stop', Watch: 'stop', Advisory: 'note', Statement: 'note' };

  for (const h of (o.hazards || [])) {
    if (!h || !h.begins) continue;
    const begins = new Date(h.begins);
    if (!Number.isFinite(begins.getTime())) continue;
    // Already over. A lapsed warning is not a warning.
    if (h.ends) {
      const ends = new Date(h.ends);
      if (Number.isFinite(ends.getTime()) && ends.getTime() < nowMs) continue;
    }
    const begun = begins.getTime() <= nowMs;
    if (!begun && dayKey(begins) !== today) continue;   // a future day is not today's cue

    // A STATEMENT IS A NOTE UNTIL ITS OWN TEXT SAYS THUNDERSTORM.
    //
    // This is the only lightning signal available to this app. NWS publishes no strike data and
    // NOAA's GOES strike-density service was retired in 2023, so what is left is the forecaster
    // saying so in a Special Weather Statement -- issued for exactly the storm that throws
    // lightning without clearing the severe bar. `storm` is read from the CAP text in the Worker.
    //
    // NULL IS NOT FALSE. An unreadable statement stays a note rather than being escalated on a
    // guess or dismissed as fog; the label says the text could not be read, so the silence is
    // visible instead of being mistaken for an all-clear.
    let sev = SEVERITY[h.severity] || 'note';
    let unread = false;
    if (h.severity === 'Statement') {
      if (h.storm === true) sev = 'stop';
      else if (h.storm !== false) unread = true;
    }
    const startH = begins.getHours() + begins.getMinutes() / 60;
    // In effect already -> its own hour, which is behind us, so the next tick fires it.
    // Still coming -> back it off by the run home, the same arithmetic the thunder cue uses.
    const atHour = begun ? startH : Math.max(0, startH - homeMin / 60);
    const label = (h.type || `${h.severity || 'Weather'} in effect`)
      + (unread ? ' (statement text could not be read — check it)' : '');
    out.push({
      atHour, kind: 'hazard', severity: sev, code: h.id || null,
      what: begun
        ? `${label} IN EFFECT now${h.ends ? ` until ${hhmm(new Date(h.ends).getHours()
            + new Date(h.ends).getMinutes() / 60)}` : ''}. Issued by NWS for this point.`
        : `${label} from ${hhmm(startH)}. The furthest this plan gets from the ramp is `
          + `${(farthestM / 1609.34).toFixed(1)} mi, which is ${homeMin} min home at `
          + `${transitMph} mph — so leave by ${hhmm(atHour)}.`,
    });
  }

  let saidThunder = false;
  for (const w of (weatherByHour || [])) {
    if (!w || !Number.isFinite(w.hour)) continue;
    if (w.thunder && !saidThunder) {
      saidThunder = true;                       // one evacuation notice, not one per stormy hour
      const leaveBy = w.hour - homeMin / 60;
      out.push({
        atHour: Math.max(0, leaveBy), kind: 'weather', severity: 'stop', code: w.code,
        what: `Thunderstorms forecast from ${hhmm(w.hour)}. The furthest this plan gets from the `
            + `ramp is ${(farthestM / 1609.34).toFixed(1)} mi, which is ${homeMin} min home at `
            + `${transitMph} mph — so leave by ${hhmm(leaveBy)} to be off the water before it. `
            + `You cannot outrun lightning in a kayak.`,
      });
    } else if (w.rain && (w.chancePct == null || w.chancePct >= 50)) {
      out.push({
        atHour: w.hour, kind: 'weather', severity: 'note', code: w.code,
        what: `Rain likely around ${hhmm(w.hour)}`
            + (w.chancePct != null ? ` (${w.chancePct}%)` : '')
            + ` — visibility and comfort, not a reason to come in.`,
      });
    }
  }
  // Rain hours run in blocks; the first of each block is the useful one.
  const seen = new Set();
  return out.filter((c) => {
    // A hazard is one notice about one product, never a block of hours to thin out.
    if (c.kind === 'hazard') return true;
    if (c.severity === 'stop') return true;
    const k = Math.floor(c.atHour);
    if (seen.has(k - 1) || seen.has(k - 2)) { seen.add(k); return false; }
    seen.add(k);
    return true;
  });
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
