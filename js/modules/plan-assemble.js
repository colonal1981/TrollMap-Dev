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

import { ampHours, ampHoursAlong, minutesFor, metresBetween, cumulative, pointAt,
         travelOrder, trimReach, riverPassFlipped } from './plan-candidates.js';
import { depthWindow, lightWindowFor, leadForDepth, jigheadForSwimbait,
         requiresInlineWeight, changeCostFor, presentationDelta,
         LURE_KNOWLEDGE, gpsWindowFor, sharedSpeedWindow } from '../data/lure-knowledge.js';
import { JIGHEADS_OWNED_OZ, TROLLING_WEIGHTS_OWNED_OZ,
         RIGGED_TROLLING_WEIGHT_OZ } from '../data/tackle-inventory.js';
import { FISHING_STYLE } from '../data/fishing-style-profile.js';
import { ozLabel } from '../utils/oz.js';
import { legLightFor, lightAgrees } from '../utils/light-state.js';

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
 * A FLUTTER SPOON HAS NO DEPTH UNTIL A WEIGHT IS AHEAD OF IT, AND THE LEAD MATHS NEEDS ONE.
 *
 * Exactly the shape of `fitJighead` above, for exactly the same reason: a bait whose mass is
 * incomplete makes every number after it a number about something that is not on the line.
 *
 * Ryan, 2026-09-14, reading his own plan: "is the spoon depths assuming that i am using the 2oz
 * trolling weight rig? because a 3/4oz spoon unweighted at 2mph is a surface lure not these
 * depths??? unless i am thinking wrong?" He was not. The app had no weight in it anywhere; the
 * only reason the spoon's number came out right is that the ratio it inherited had been quoted
 * for the weighted rig by someone who never wrote that down.
 *
 * IT STARTS AT THE WEIGHT THAT IS ACTUALLY TIED ON and goes heavier only to reach the depth
 * inside the lead budget -- the same rule as the jighead picker, and for a harder reason: "I
 * have 1 and 3 oz weights that could be used that are not rigged currently." A plan that opens
 * by telling him to re-rig with a weight sitting in a bag at home is a plan that starts with a
 * job. When the heavier weight IS what the depth needs, it is asked for out loud, once.
 */
function fitInlineWeight(lure, rod, speedMph, ceilingFt, id, runId, warnings) {
  if (!requiresInlineWeight(lure?.type)) return null;
  if (Number(lure.inlineWeightOz) > 0) return Number(lure.inlineWeightOz);

  const runs = Array.isArray(rod.runsDepthFt) && rod.runsDepthFt.every(Number.isFinite)
    ? (rod.runsDepthFt[0] + rod.runsDepthFt[1]) / 2 : null;
  const target = Number.isFinite(runs) ? runs : ceilingFt;
  const maxLeadFt = FISHING_STYLE.rigging?.maxLeadFt ?? 120;

  // The box, rigged one first, then the rest ascending. Nothing is sorted by "best" — the order
  // IS the preference, and the first one that reaches inside the lead budget wins.
  const owned = [...TROLLING_WEIGHTS_OWNED_OZ].sort((a, b) => a - b);
  const rigged = Number(RIGGED_TROLLING_WEIGHT_OZ) > 0 ? Number(RIGGED_TROLLING_WEIGHT_OZ) : null;
  const order = rigged ? [rigged, ...owned.filter((w) => w !== rigged)] : owned;

  if (!order.length) {
    warnings.push(`${id} on ${runId}: a ${rod.lure} only fishes behind an inline trolling weight `
                + 'and the app has no weight in the box to give it.');
    return null;
  }
  if (!Number.isFinite(target) || target <= 0) return rigged || order[0];

  for (const w of order) {
    const lead = leadForDepth({ ...lure, inlineWeightOz: w }, target, speedMph);
    if (Number.isFinite(lead) && lead > 0 && lead <= maxLeadFt) {
      if (rigged && w !== rigged) {
        warnings.push(`${id} on ${runId}: the ${ozLabel(rigged)} weight that is tied on now needs `
                    + `more than the ${maxLeadFt} ft you run to get a ${rod.lure} to `
                    + `${Math.round(target)} ft — put the ${ozLabel(w)} weight on instead, which `
                    + `reaches it on ${lead} ft of lead. That is a change to make at the truck.`);
      }
      return w;
    }
  }
  // Nothing in the box reaches it. Say so with the heaviest, rather than silently using the
  // lightest and reporting a depth it cannot make.
  const heaviest = order.reduce((a, b) => (b > a ? b : a), order[0]);
  warnings.push(`${id} on ${runId}: a ${rod.lure} behind the heaviest weight you own `
              + `(${ozLabel(heaviest)}) still needs more than the ${maxLeadFt} ft of lead you run `
              + `to make ${Math.round(target)} ft. That depth is not reachable with this rig.`);
  return heaviest;
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
function capBaitDepth(rods, deploy, ceilingFt, speedMph, lureByName, runId, warnings, fish,
                      legDepth = null, legLight = null) {
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
    // THE WEIGHT GOES ON BEFORE THE HEAD IS PRICED. `fitJighead` leads for the head it picks, and
    // a head picked against a bare bait is a head picked for a rig that is not on the line.
    const inlineOz = fitInlineWeight(lureAsBought, rod, speedMph, ceilingFt, id, runId, warnings);
    const rigged = inlineOz ? { ...lureAsBought, inlineWeightOz: inlineOz } : lureAsBought;

    const fit = fitJighead(rigged, rod, speedMph, ceilingFt, id, runId, warnings);
    const lure = fit ? { ...rigged, weightOz: fit.weightOz } : rigged;
    let leadFt = fit ? fit.leadFt : rod.leadFt;
    if (inlineOz) forThisLeg[id] = { ...(forThisLeg[id] || {}), inlineWeightOz: inlineOz };

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

    // SAME SYMPTOM, OPPOSITE ANSWER. A cast-only bait planing is a bait in the wrong place; a
    // spoon planing is a weight that is not on it, and the fix is in the tackle box. This branch
    // should be unreachable in practice -- `fitInlineWeight` runs above and supplies one -- so
    // reaching it means the box is empty or the fit refused, and that is worth saying rather
    // than falling through into a `continue` that reports nothing.
    if (w.mode === 'needs_weight') {
      warnings.push(`${id} on ${runId}: a ${rod.lure} has no inline trolling weight on it — `
                  + `${w.reason}. That rod is fishing the top of the water column on this leg.`);
      continue;
    }
    if (!Number.isFinite(w.max)) continue;

    // The model also CLAIMS a running depth. Nothing has ever checked that claim against the
    // lead it asked for in the same breath, and the two can disagree by a lot.
    //
    // THE TOLERANCE IS FOR AN ESTIMATE, AND A RATED BAIT IS NOT ONE. `> 4` exists because a
    // lead-controlled window is computed by inverting leadForDepth() numerically, so the model
    // being a couple of feet off is noise. A bait whose depth comes off the box is not estimated
    // at all -- `depthWindow()` marks it `claimed: true` and returns the manufacturer's own pair
    // -- so any restatement of it is the model writing a number nobody measured.
    //
    // Ryan, 2026-09-06, on an MR Crankbait the inventory rates 6-12 ft, printed on the card as
    // "6-10ft": "you want me to fish at 6-10 ft but give me a bait that is probably going to run
    // closer to 12". |10 - 12| is 2, so the tolerance swallowed it and the invented number went
    // to the card. On a rated bait the test is equality, which is not a threshold at all.
    const claimedTol = w.claimed === true ? 0 : 4;
    if (Array.isArray(rod.runsDepthFt) && Number.isFinite(rod.runsDepthFt[1])
        && Math.abs(rod.runsDepthFt[1] - w.max) > claimedTol) {
      // "GOING WITH THE MEASURED NUMBER" WAS A LIE THIS FILE TOLD ABOUT ITS OWN ARITHMETIC.
      //
      // Nothing measured it. lure-knowledge.js says so three times in its own header -- "working
      // values, not measurements", "STILL UNCALIBRATED" -- and then this line called the output
      // measured and used that standing to overrule the model. The app's number is still the one
      // to go with, because it is at least computed from the lead and the rig rather than
      // recalled; but it is computed, and on the one rig Ryan has put a number to, it is his.
      warnings.push(`${id} on ${runId} says it runs to ${rod.runsDepthFt[1]} ft, but `
                  + `${leadFt} ft of lead at ${speedMph} mph`
                  + `${inlineOz ? ` behind the ${ozLabel(inlineOz)} inline weight` : ''}`
                  + `${fit ? ` on a ${ozLabel(fit.weightOz)} head` : ''} puts a ${rod.lure} at `
                  + `${w.max} ft — going with the app's number, worked from ${w.controlledBy}`);
      forThisLeg[id] = { ...(forThisLeg[id] || {}), runsDepthFt: [w.min, w.max] };
    }

    // ── THE APP'S NUMBER, RECORDED WHETHER OR NOT ANYTHING IS WRONG ────────────────────────
    //
    // `runsDepthFt` was written only inside the two failure branches, so the one case where the
    // computed window was never kept was the case where nothing was the matter with it. The card
    // then printed whatever the model had written in the spread row. Ryan, 2026-09-06, reading a
    // row that said 6-10 ft under a bait the inventory rates 6-12: "you want me to fish at 6-10
    // ft but give me a bait that is probably going to run closer to 12". Neither number came
    // from here; depthWindow() had both ends and was not asked.
    if (!(forThisLeg[id] && forThisLeg[id].runsDepthFt)) {
      forThisLeg[id] = { ...(forThisLeg[id] || {}),
                         runsDepthFt: [w.min, w.max], depthClaimed: w.claimed === true };
    }

    // ── TOO DEEP WAS CAUGHT AND TOO SHALLOW WAS INVISIBLE ──────────────────────────────────
    //
    // Everything else in this function asks one question: is the bait deeper than the bottom.
    // Nothing has ever asked whether it is anywhere near the FISH. On the Sep 6 Wateree plan the
    // legs were 26-36, 15-25, 21-31 and 39-49 ft of water and the port rod on four of the five
    // was a 6-12 ft crankbait -- twenty to thirty feet above the band, with no warning of any
    // kind, because it was not dragging.
    //
    // An interval test, not a threshold: the bait's window and the fish band either overlap or
    // they do not. And it is a WARNING, not a refusal -- a shallow bait at first light is a real
    // choice, which is why lightPromptBlock() exists. It states the two numbers and lets the
    // plan justify itself.
    //
    // Skipped entirely when the band is not a fish depth. `fishDepthWasStated()` decides that,
    // and when it is false the band is the depth of the WATER -- "above the fish" would be a
    // claim about a quantity nobody measured.
    if (fish && fish.stated && Array.isArray(fish.bandFt) && fish.bandFt.length === 2
        && Number.isFinite(w.min) && Number.isFinite(w.max)) {
      const [fMin, fMax] = fish.bandFt;
      if (Number.isFinite(fMin) && Number.isFinite(fMax) && (w.max < fMin || w.min > fMax)) {
        warnings.push(`${id} on ${runId}: a ${rod.lure} works ${w.min}-${w.max} ft and the fish `
                    + `are ${fMin}-${fMax} ft on this water. Those do not overlap, so this rod is `
                    + `fishing ${w.max < fMin ? `${Math.round(fMin - w.max)} ft ABOVE`
                                              : `${Math.round(w.min - fMax)} ft BELOW`} them. Say `
                    + `why in the leg's notes or put a different bait on it.`);
      }
    }

    // ── AND WHETHER THE LIGHT ON THIS LEG IS THE LIGHT THE BAIT'S OWN RECORD NAMES ──────────
    //
    // Ryan, 2026-09-15: "make sure that the app is light aware through out the whole day... so that
    // techniques that work in low light or colors that should be used during low light are known".
    // The light is now measured per leg -- see lightOn() above -- and five of the baits in his bag
    // carry a light in their own recorded technique ('Surface troll at dawn'). Nothing had ever
    // compared the two.
    //
    // IT QUOTES THE RECORD AND ASSERTS NOTHING. Those technique lines are unsourced free text, the
    // standing problem with lure-knowledge.js, so the app is not entitled to say "topwater is a
    // low-light bait" -- only that its own note says dawn and this leg is measured not to be. That
    // is the shape Ryan asked for on the shoal the day before: "flag the rise and let me decide."
    //
    // And it is not a refusal in either direction. His own words on the case this must not get
    // wrong: "if it was an overcast day then topwater all day might be ok... i still say might
    // because you just never know with fish". An overcast leg IS low light here, by the sky rather
    // than the hour, so on that day this says nothing at all -- which is the point of measuring the
    // light instead of reading the clock.
    if (legLight && legLight.state) {
      const named = lightWindowFor(lure);
      const agrees = named ? lightAgrees(legLight, named.kinds) : null;
      if (agrees === false) {
        const sky = legLight.skyWord
          ? `${legLight.skyWord}${legLight.cloudPct != null ? ` at ${legLight.cloudPct}% cloud`
                                                           : ''}`
          : 'no sky forecast for that hour';
        warnings.push(`${id} on ${runId}: the app's own recorded technique for a ${rod.lure} is `
                    + `"${named.says}", and this leg starts ${legLight.from} in ${legLight.state} `
                    + `— ${sky}, so ${legLight.low ? 'low light' : 'NOT low light'}`
                    + `${legLight.changesTo ? `, turning ${legLight.changesTo} at `
                                            + `${legLight.changesAt}` : ''}. That note has no `
                    + `source behind it and this is not a refusal — say why the bait suits this `
                    + `light, or put it on a leg whose light it does.`);
      }
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
    // ── A ONE-SHOAL CEILING IS A RISE TO AVOID, NOT A REASON TO FISH THE WHOLE PASS SHALLOW ──
    //
    // `maxRunDepthFt` is a THRESHOLD -- the shallowest point the whole stretch clears, set by one
    // rise somewhere along it -- and this function's own note says so. It then shortened the lead
    // for the ENTIRE pass to clear that rise. On wateree_lake#216, 2026-09-14, that meant pulling a
    // lipless off 17 ft down to 11 across a leg that runs 11-25 ft with a MEDIAN of 20.
    //
    // Ryan, reading it: "i dont see anything wrong with leg 8... 11-25ft of water with the median
    // being 20ft... it is not much different than the other water offered". Asked whether he wanted
    // the cap kept or the rise flagged: "flag the rise and let me decide."
    //
    // AND THIS IS A NARROWING OF HIS 2026-08-11 RULE, NOT A RESTATEMENT OF IT. That rule was "the
    // shallowest that water runs is 20ft... even if the water is 25-35ft don't give me a bait that
    // runs deeper than 20ft" -- 25-35 ft of water with a 20 ft shoal is the SAME SHAPE as leg 8,
    // so pretending the two situations differ would be this file telling itself a story. What
    // changed is that he read the rule's output on real water and narrowed it. Do not "restore"
    // the cap on the strength of the August quote; the September one was written knowing it.
    //
    // The flag is not a smaller answer than the cap was. It hands him the identical number the cap
    // would have applied -- `shorter`, below -- and leaves the applying to him, which is the whole
    // of what he asked for: "flag the rise and let me decide."
    //
    // THE SPLIT USES THE LEG'S OWN TWO NUMBERS, so there is no threshold to invent: a bait that
    // clears the MEDIAN is a bait for this water with a rise to get over, and it is flagged with
    // the lead that would clear so he can shorten there if he wants. A bait that does not clear the
    // median is too deep for the stretch generally, and that is still corrected as before.
    const medianFt = Number(legDepth && legDepth.medianFt);
    const clearsMedian = Number.isFinite(medianFt) && medianFt > ceilingFt && w.max <= medianFt;
    if (w.mode === 'lead' && clearsMedian) {
      const env = [legDepth.minFt, legDepth.maxFt].every(Number.isFinite)
        ? `${legDepth.minFt}-${legDepth.maxFt} ft` : `${ceilingFt} ft at its shallowest`;
      warnings.push(`${id} on ${runId}: a ${rod.lure}`
                  + `${inlineOz ? ` behind the ${ozLabel(inlineOz)} inline weight` : ''}`
                  + `${fit ? ` on a ${ozLabel(fit.weightOz)} head` : ''} `
                  + `runs ${w.min}-${w.max} ft, and this leg is ${env} with a median of `
                  + `${medianFt} ft. THE LEAD IS LEFT WHERE YOU SET IT — the bait clears the water `
                  + `this pass mostly is, and there is a rise to ${ceilingFt} ft on it somewhere `
                  + `that it will not clear. Shorten to ${shorter ?? '—'} ft over the rise if you `
                  + `want it off the bottom there; the chart does not say where the rise is.`);
      forThisLeg[id] = { ...(forThisLeg[id] || {}),
                         runsDepthFt: [w.min, w.max],
                         clearsAt: shorter ?? null };
      continue;
    }
    if (w.mode === 'lead' && shorter && shorter < leadFt) {
      warnings.push(`${id} on ${runId}: a ${rod.lure}`
                  + `${inlineOz ? ` behind the ${ozLabel(inlineOz)} inline weight` : ''}`
                  + `${fit ? ` on a ${ozLabel(fit.weightOz)} head` : ''} `
                  + `on ${leadFt} ft of lead at ${speedMph} mph runs to ${w.max} ft, and this leg `
                  + `runs ${ceilingFt} ft at its shallowest with a median of `
                  + `${Number.isFinite(medianFt) ? `${medianFt} ft` : 'no median on the pack'} — `
                  + `too shallow for it along the whole stretch, so shortened the lead to `
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

/**
 * WHAT THE PAIR IN THE WATER REACHES, AND WHAT IS IN THE BOAT THAT REACHES PAST IT.
 *
 * ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────────────────────────
 *
 * Ryan, 2026-09-18, on the day the app stopped claiming a fish depth it had no evidence for:
 * *"which is actually ok for it not to have a depth... as long as the app still routes over the
 * holes with a bait that is appropriate for that reach of river... if i go over a hole and see that
 * the fish are much deeper than what my current bait can do i can always turn around run back the
 * other way with a different rod... the plan is a mechanism to get me onto the fish with a high
 * probability of catching... but it can't know exactly where the fish are... if someone could invent
 * that they would be an instant billionaire... but i have the electronics on the kayak to tell me if
 * i need to change something... but a note in the plan that says hey check your sonar if fish are
 * deeper than x change to this bait... something like that"*
 *
 * The 93sv is the only instrument in this whole system that measures where the fish actually are.
 * Everything upstream of it -- the chart, the profile, the research band -- is where they PROBABLY
 * are. So the plan's job on a leg is not to be right about the depth; it is to hand him the two
 * numbers he needs the moment the sounder disagrees with it: how deep what is behind the boat
 * reaches, and which rod standing behind the seat reaches further.
 *
 * ── EVERY NUMBER IN HERE IS ALREADY OWNED ─────────────────────────────────────────────────────
 *
 * `x` is not a threshold anybody picked. It is the deeper end of the pair that is in the water,
 * which capBaitDepth() has already computed for this leg at this leg's speed with this leg's lead
 * (`rodPlan[id].runsDepthFt`), and which falls back to depthWindow() on the bag's own lead for a rod
 * the cap never had to touch. The rods offered are the rest of HIS loadout, priced through the same
 * depthWindow() at the same speed. Nothing here invents a number, and nothing here re-rigs a rod:
 * a bait that planes, or that wants an inline weight it has not been given, reports a null max and
 * is left out rather than talked up.
 *
 * `controlledBy` comes along because it is the difference between two answers he can act on. A
 * lead-controlled bait goes deeper on more line, with no rod change at all; a lipped bait's bill
 * sets its depth and no amount of line moves it. Telling him to swap rods when letting out line
 * would do is a worse answer than saying nothing.
 *
 * Returns undefined when the pair in the water has no measurable depth between them, because then
 * there is no `x` and the sentence would be about nothing.
 *
 * @param {Array}  rods         the loadout -- every rod in the boat, not just the two deployed
 * @param {object} deploy       { port, starboard } rod ids for this leg
 * @param {object|null} rodPlan capBaitDepth()'s per-leg answer, keyed by rod id
 * @param {number} speedMph     the leg's WATER speed, the same one capBaitDepth was priced at
 * @param {function} lureByName
 *
 * The water on the leg is deliberately NOT carried in here. The card already prints the leg's own
 * depth range, and how much more lead the shallow end of a leg leaves him is the call capBaitDepth()
 * hands to him on purpose -- "flag the rise and let me decide" -- not a number to re-answer here.
 */
function sonarContingency(rods, deploy, rodPlan, speedMph, lureByName) {
  if (typeof lureByName !== 'function' || !deploy) return undefined;
  const out = [deploy.port, deploy.starboard].filter(Boolean);

  // The window a rod is fishing on THIS leg, and WHAT SETS IT.
  //
  // The numbers prefer capBaitDepth()'s answer, because on a deployed rod the cap may have shortened
  // the lead for this leg's ceiling and the bag's lead is then not what is behind the boat.
  //
  // `mode` NEVER comes from the cap. The first cut of this read it as "did the cap write a leadFt",
  // which is a question about whether this leg was shallow, not about what controls the bait -- so
  // the identical rod reported lead-controlled while it sat on the bench and NOT lead-controlled the
  // moment it was deployed, and leg 3 of Ryan's 2026-09-18 Congaree day said "nothing else in the
  // boat reaches them" over 13 ft of water while holding two lead-controlled baits that more line
  // would have taken straight down to the fish. What controls a bait is a property of the bait:
  // depthWindow() answers it ('lead', 'surface', a rated bill), and it is asked every time.
  const windowFor = (rod) => {
    const lure = lureByName(rod.lure);
    if (!lure) return null;
    const planned = rodPlan && rodPlan[rod.id] ? rodPlan[rod.id] : null;
    const leadFt = (planned && planned.leadFt) ?? rod.leadFt;
    const w = depthWindow(planned && planned.jigheadOz
      ? { ...lure, weightOz: planned.jigheadOz } : lure, { speedMph, leadFt });
    const pair = planned && Array.isArray(planned.runsDepthFt)
                 && planned.runsDepthFt.every((v) => Number.isFinite(v))
      ? planned.runsDepthFt : (Number.isFinite(w.min) && Number.isFinite(w.max) ? [w.min, w.max]
                                                                               : null);
    return pair ? { min: pair[0], max: pair[1], mode: w.mode } : null;
  };

  const inWater = [];
  for (const id of out) {
    const rod = rods.find((r) => r.id === id);
    const w = rod && windowFor(rod);
    if (w) inWater.push({ rodId: id, lure: rod.lure, runsDepthFt: [w.min, w.max], mode: w.mode });
  }
  if (!inWater.length) return undefined;

  const pairFt = [Math.min(...inWater.map((r) => r.runsDepthFt[0])),
                  Math.max(...inWater.map((r) => r.runsDepthFt[1]))];
  const floorFt = pairFt[1];

  const bench = [];
  for (const rod of rods) {
    if (out.includes(rod.id)) continue;
    const w = windowFor(rod);
    if (!w || !(w.max > floorFt)) continue;
    bench.push({ rodId: rod.id, lure: rod.lure, runsDepthFt: [w.min, w.max],
                 // The one fact that decides whether he swaps a rod or just lets line out.
                 leadWillGoDeeper: w.mode === 'lead' });
  }
  bench.sort((a, b) => a.runsDepthFt[1] - b.runsDepthFt[1]);

  const everyMax = [...inWater, ...bench].map((r) => r.runsDepthFt[1]);
  return {
    pairFt,
    // "check your sonar if fish are deeper than x" -- x, and it is the pair's own floor.
    ifDeeperThanFt: floorFt,
    // Can the pair itself be sent deeper on more line, before any rod comes out of the holder?
    pairLeadWillGoDeeper: inWater.some((r) => r.mode === 'lead'),
    // BOTH RODS WORKED ON TOP, which makes "if the sounder puts fish below 1 ft" a sentence about
    // nothing -- they are always below 1 ft. depthWindow() calls this mode 'surface' itself, so the
    // case is read off the bait and not off a depth anybody chose to call shallow.
    pairSurfaceOnly: inWater.every((r) => r.mode === 'surface'),
    reach: bench,
    deepestInBoatFt: Math.max(...everyMax),
  };
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

/* ==============================================================================================
 * THE SPEED COMES FROM THE BAIT, AND ON A RIVER THE APP HOLDS THE PENCIL.
 *
 * Ryan, 2026-09-17, asked what is actually left to decide on a river once the app draws the path:
 * "so what should we leave to the LLM on river planning? bait choice? speed doesn't seem to make
 * sense unless you give it all that math you just gave me... where does that leave us?"
 *
 * It leaves the model the bait and leaves the app the number, because the number is arithmetic the
 * model cannot do from the prompt: the bait's window is a speed THROUGH THE WATER, the screen shows
 * speed over the GROUND, and on a river those differ by the current -- one way up, the other way
 * back. See gpsWindowFor() and sharedSpeedWindow() in lure-knowledge.js.
 *
 * SCOPED TO RIVERS, AND THAT IS A DECISION RATHER THAN A HALF-MEASURE. On still water the two speeds
 * are the same number, the box already prints each bait's rated range, and the model picking a pair
 * and a speed together is not wrong there. Nothing about the lake path is changed, including the
 * amp-hours: `ampHours()` and `ampHoursAlong()` agree exactly when there is nothing to resolve.
 * ============================================================================================== */

/**
 * The baits ACTUALLY IN THE WATER on a leg, with the rod each came from -- so a speed conflict can
 * be named rather than counted. Port first, then starboard; a rod with no known lure type has no
 * speed window and is skipped, which is the same silence the depth ceiling keeps.
 */
function deployedBaits(rods, deploy, lureByName) {
  const byId = new Map((rods || []).map((r) => [r.id, r]));
  const out = [];
  for (const side of ['port', 'starboard']) {
    const rod = byId.get(deploy && deploy[side]);
    if (!rod) continue;
    const lure = typeof lureByName === 'function' ? lureByName(rod.lure) : null;
    const k = lure && LURE_KNOWLEDGE[lure.type];
    if (!k || !k.speed) continue;
    out.push({ side, rodId: rod.id, name: rod.lure, type: lure.type, speed: k.speed });
  }
  return out;
}

/**
 * ONE PASS OVER ONE REACH, PRICED AT THE SPEED ITS BAITS WILL ACTUALLY BE TROLLED AT.
 *
 * Called twice and deliberately so: once by fitRiverDay() BEFORE any leg is built, to decide how many
 * reaches the window and the battery can still afford now that the speed is known, and once per leg
 * while they are built. Two assemblies of one measurement is the defect this project keeps finding,
 * so there is one.
 *
 * `mph` is null when this is not a river pass with baits in the water — a lake leg, or a river leg
 * with no measured current — and the caller falls back to whatever it fell back to before.
 *
 * @param {object}   c        the candidate, already one entry per pass (see travelOrder)
 * @param {boolean}  flipped  the boat travels the drawn line in reverse, i.e. UPSTREAM
 */
function riverPassNumbers(c, flipped, deploy, rods, lureByName) {
  const riverCur = (c.drift && Number.isFinite(Number(c.currentMph)) && Number(c.currentMph) > 0)
    ? Number(c.currentMph) : null;
  const baits = riverCur != null ? deployedBaits(rods, deploy, lureByName) : [];
  const baitBand = baits.length ? sharedSpeedWindow(baits.map((b) => b.speed)) : null;
  const upstream = !!flipped;
  const held = baitBand ? groundSpeedFor(baitBand, riverCur, upstream) : null;
  const coords = flipped
    ? (c.coordinates ? c.coordinates.slice().reverse() : null)
    : (c.coordinates || null);
  const mph = held ? held.mph : null;
  const min = mph != null ? minutesFor(c.lengthM, mph) : null;
  const ah = (mph != null && riverCur != null && coords && coords.length > 1)
    ? ampHoursAlong(coords, mph, { alongCurrentMph: upstream ? riverCur : -riverCur }).ah
    : (mph != null ? ampHours(c.lengthM, mph) : null);
  return { riverCur, baits, baitBand, upstream, held, coords, mph, min, ah };
}

/**
 * ── HOW FAR OUT THE DAY CAN GO ONCE THE BAITS ARE KNOWN ─────────────────────────────────────────
 *
 * riverDay() decides how many reaches to take, against the battery and the window, and it has to do
 * it BEFORE the model picks a bait -- so it prices the out-and-back at the app's 2.0 mph through the
 * water. The moment the speed follows from the bait that stops being the cost. On his 2026-09-17
 * Congaree bench the two reaches were budgeted at 541 minutes of a 540 minute window and came out at
 * 630, because a Whopper Plopper's window tops out at 2.0 and its best is 1.6.
 *
 *     reach A, 7,983 m, 0.44 mph of current
 *       riverDay, 2.0 mph both ways        298 min
 *       direction-aware at 2.0             313 min
 *       what the baits actually cost       397 min   (149 down at 2.0, 248 up at 1.2)
 *
 * SO THE DAY IS RE-FITTED HERE, WHERE THE SPEED IS REAL, AND WHOLE REACHES COME OFF THE FAR END.
 * Whole ones, because half a reach is incoherent on a path that comes back over itself: fishing B
 * out and not back leaves the boat 6.5 km from the ramp with the rods in. And from the FAR end,
 * because that is the water the turnaround was always going to give up first.
 *
 * This replaces a guard that used to live in the pass loop -- "asked for N passes, stopped after
 * N-1, pass N would end after <returnTime>". That loop does not run on a river any more, and
 * dropping the second pass of the last reach was the wrong shape anyway: it left him at the far end.
 *
 * NOTHING IS DROPPED WITHOUT SAYING SO, and the sentence names the reach and what it would have cost.
 *
 * @returns {{legs: object[], facing: object[], dropped: string[]}}
 */
/**
 * ── WHICH TWO RODS ARE IN THE WATER ON ONE PASS ─────────────────────────────────────────────────
 *
 * Ryan, 2026-09-17: *"but if it is only an up and back am i using the same rods all day long... no
 * matter what? that doesn't make sense... and this dashboard doesn't tell me to switch if they aren't
 * working or even mention the other 4 rods?"*
 *
 * He was reading the app correctly. `deploy` is keyed by `runId`, a river reach is fished out and
 * back, and both passes carry the same runId -- so the two rods on the run out were the two rods on
 * the run back BY CONSTRUCTION, with no way for a plan to say otherwise. The only tool for changing
 * the day was `changes`, which reties a lure on a deployed rod, and that is the EXPENSIVE move on the
 * water: a fluoro leader is a knot with cold wet hands in a moving kayak. The cheap move -- put the
 * two rods down and pick up two of the four already rigged behind the seat -- could not be expressed
 * at all, which is why the other four rods never got mentioned.
 *
 * `deployBack` is that second pair, one per reach, and it is OPTIONAL: absent, the run back keeps the
 * rods from the run out, which is what every plan before 2026-09-18 did and is still the right answer
 * on a day whose light and current do not change.
 */
function deployOn(o, c, pass) {
  if (!c) return null;
  const p = Number(pass ?? c.pass ?? 1);
  return (p === 2 && o.deployBack && o.deployBack[c.runId])
    || (o.deploy && o.deploy[c.runId]) || null;
}

function fitRiverDay(cands, launch, o, rods, windowMin, transitMph) {
  const n = Array.isArray(cands) ? cands.length : 0;
  if (!n) return { legs: cands || [], facing: [], dropped: [], droppedRuns: [] };
  const usableAh0 = Number(o.usableAh) > 0 ? Number(o.usableAh) : Infinity;

  // ── THE HOP TO THE WATER IS SPENT BEFORE A ROD GOES IN, SO IT COMES OFF THE BUDGET FIRST ────────
  //
  // `fromRampM` IS THE NEAR END AND `transitInM` IS NOT. `transitInM` is the distance to the reach's
  // `start` AS DRAWN, and a drift is drawn downstream -- so on a reach ABOVE the ramp that is the FAR
  // end. This read `transitInM` and on Ryan's 2026-09-18 Bates Bridge bench reserved 170 MINUTES for
  // a 49 m hop, because the first reach was upstream and its `transitInM` was 8,000. That reserve ate
  // the whole remainder and the second arm of his day was dropped as unaffordable while the budget
  // printed beside it showed 99 minutes and 50 Ah still unspent. A warning that contradicts the
  // number next to it is the tell.
  //
  // Charged BOTH WAYS: every arm of a river day starts and ends at the launch, so the same hop is
  // also the run home unless it is inside HOME_TOLERANCE_M, and reserving it when it turns out free is
  // the safe direction to be wrong in.
  const nearM = [cands[0].fromRampM, cands[0].transitInM, cands[0].transitOutM]
    .map(Number).filter((x) => Number.isFinite(x) && x >= 0);
  const hopM = nearM.length ? Math.min(...nearM) : 0;
  const hopMin = hopM > 0 ? 2 * minutesFor(hopM, transitMph) : 0;
  const hopAh = hopM > 0 ? 2 * ampHours(hopM, transitMph) : 0;
  const usableAh = usableAh0 - hopAh;
  const room0 = (Number.isFinite(windowMin) && windowMin > 0 ? windowMin : Infinity) - hopMin;

  // Each reach's own out-and-back, at the speed its own two baits will be held at. The orientation
  // comes from riverPassFlipped(), the same function travelOrder() lays the day out with.
  const costOf = (c) => {
    // EACH PASS AT ITS OWN PAIR'S SPEED. A plan may put a different two rods in the water for the run
    // back (`deployBack`, see deployOn), and two different baits are two different speed windows --
    // so pricing both halves off the outward pair would fit the day to a speed half of it is not
    // trolled at, and the half it got wrong is the half nearest the end of the battery.
    const out = riverPassNumbers(c, riverPassFlipped(c, true), deployOn(o, c, 1), rods, o.lureByName);
    const back = riverPassNumbers(c, riverPassFlipped(c, false), deployOn(o, c, 2), rods, o.lureByName);
    return { min: (out.min ?? 0) + (back.min ?? 0), ah: (out.ah ?? 0) + (back.ah ?? 0),
             // A reach with no priced pass is one this function cannot judge, so it is never cut on.
             priced: out.min != null && back.min != null };
  };
  const cost = cands.map(costOf);
  const total = (k) => cost.slice(0, k).reduce((t, x) => ({ min: t.min + x.min, ah: t.ah + x.ah }),
                                               { min: 0, ah: 0 });
  let keep = n;
  while (keep > 1) {
    const t = total(keep);
    if (t.min <= room0 && t.ah <= usableAh) break;
    keep -= 1;
  }
  if (keep === n) {
    const t = travelOrder(cands, launch);
    return { legs: t.legs, facing: t.facing, dropped: [], droppedRuns: [] };
  }

  // ── AND THE FIRST REACH THAT DOES NOT FIT WHOLE IS CUT, NOT BINNED ──────────────────────────────
  //
  // Dropping whole reaches alone left 142 of 540 minutes unspendable on his own bench -- two hours of
  // his day handed back because one 6.5 km reach would not fit. riverDay() already solved this shape
  // and the cut is its own: trimReach(), from the NEAR end, because the water given up is the water
  // furthest out. Below a tenth of a reach there is no leg worth drawing, which is riverDay's floor
  // and is here for its reason rather than a second opinion about it.
  const spent = total(keep);
  const left = { min: room0 - spent.min, ah: usableAh - spent.ah };
  let frac = 0;
  if (cost[keep].priced && cost[keep].min > 0) {
    frac = Math.max(0, Math.min(Number.isFinite(left.min) ? left.min / cost[keep].min : 1,
                                Number.isFinite(left.ah) && cost[keep].ah > 0
                                  ? left.ah / cost[keep].ah : 1));
  }
  const cut = frac >= 0.1 ? trimReach(cands[keep], frac) : null;

  // REBUILT THROUGH travelOrder(), NOT SPLICED OUT OF ITS OUTPUT. A river day can be TWO
  // out-and-backs from one launch -- riverDay fills the richer arm and carries on into the other --
  // and only travelOrder knows how to order that. Slicing a mirror was right for one arm and wrong
  // for two.
  const kept = cands.slice(0, keep);
  if (cut) kept.push(cut);
  const t = travelOrder(kept, launch);

  const dropped = [];
  for (let i = keep; i < n; i++) {
    const what = (i === keep && cut)
      ? `is cut to ${Math.round(100 * frac)}% of itself — ${cut.lengthM} m of ${Math.round(cands[i].lengthM)}`
      : 'is off the day';
    dropped.push(`${cands[i].runId} ${what}: with the baits chosen for it, trolling it out and `
               + `back whole costs ${Math.round(cost[i].min)} min and ${cost[i].ah.toFixed(1)} Ah, `
               + `and the day has neither. The reaches were chosen against 2.0 mph before a bait was `
               + `picked; this is the same day priced at the speed those baits are actually held at.`);
  }
  return { legs: t.legs, facing: t.facing, dropped,
           droppedRuns: cands.slice(cut ? keep + 1 : keep, n).map((c) => c.runId) };
}

/**
 * THE GROUND SPEED TO HOLD so the baits in the water are inside their own window, one direction at
 * a time.
 *
 * `held: false` is the case where no speed this boat can troll at puts them there -- the current is
 * faster than the bait's ceiling, or what is left after subtracting it is below the slowest speed
 * the motor holds. Then the floor is what it returns, because over-driven and fishing is a thing he
 * can see and correct and a ground speed of zero is not a troll.
 *
 * @param {?object} window     shared through-water window, from sharedSpeedWindow()
 * @param {number}  currentMph unsigned current along the leg
 * @param {boolean} upstream   which way the boat is pointed on this pass
 */
function groundSpeedFor(window, currentMph, upstream) {
  const g = gpsWindowFor(window, currentMph);
  const band = g && (upstream ? g.up : g.down);
  const clamp = (v) => Number(Math.min(TROLL_MPH_MAX, Math.max(TROLL_MPH_MIN, v)).toFixed(1));
  if (!band) return { mph: TROLL_MPH_MIN, held: false, band: null };
  const lo = Math.max(TROLL_MPH_MIN, band.min);
  const hi = Math.min(TROLL_MPH_MAX, band.max);
  if (hi < lo) return { mph: clamp(hi), held: false, band };
  return { mph: clamp(Math.min(hi, Math.max(lo, band.ideal))), held: true, band };
}

/**
 * @param {object}   o
 * @param {object[]} o.candidates  from selectCandidates(), IN THE ORDER THE MODEL CHOSE
 * @param {number[]} o.launch      [lon, lat] of the ramp
 * @param {object}   o.loadout     the model's six rods; passed through untouched
 * @param {object}   [o.deploy]    { [runId]: {port, starboard} } — which two rods go in the water
 * @param {object} [o.deployBack]  the same, for the RUN BACK over a river reach. Optional, and
 *                               absent means the run back keeps the rods from the run out.
 *                               See deployOn().
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
  // WHERE THE FISH ARE, FOR THE ONE CHECK THAT NEEDS IT.
  //
  // Read off `conditions.depthBand` rather than added as a new argument, because both planners
  // already build that object from the same describeDepthBand() and both already pass
  // `conditions` -- so there is one source and no new plumbing from the UI. `fishDepthStated` is
  // the field describeDepthBand() writes when the band and the water depth are the same pair;
  // false means the number is a WATER depth and "above the fish" is not a claim anyone can make.
  const _db = (o.conditions && o.conditions.depthBand) || null;
  const fish = _db ? { bandFt: Array.isArray(_db.ft) ? _db.ft : null,
                       stated: _db.fishDepthStated !== false } : null;
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

  // WHAT THE BOAT ACTUALLY DOES, IN ORDER — decided once, in plan-candidates.js. On a lake that is
  // the candidates as given with orientLegs' orientation; ON A RIVER IT IS ONE PATH OUT AND ONE PATH
  // BACK, so `legList` carries one entry per PASS and the hops between them are zero by construction.
  // See travelOrder(). prefetchTransits() calls the same function on the same list before it asks the
  // router for anything, so the pairs it fetched are exactly the pairs walked below. If this ever
  // stops matching, every flipped leg silently degrades to an unrouted straight line.
  //
  // READ HERE, ABOVE THE ROD-USAGE MAPS, because "is this rod ever used again" has to be asked of the
  // day the boat really does. On a river a reach appears twice, so a change before the second reach
  // is justified by the rods coming back over the first -- and asked of the unexpanded list it read
  // as wasted. That warning fired on his 2026-09-17 bench and was wrong.
  const t0 = travelOrder(candidates, o.launch);
  // AND ON A RIVER, RE-FITTED TO THE WINDOW NOW THAT THE SPEED IS KNOWN. See fitRiverDay(): the
  // reaches were chosen against 2.0 mph before a bait existed, and the bait is what sets the speed.
  // It takes the CANDIDATES and rebuilds through travelOrder(), because a river day can be two
  // out-and-backs from one launch and only that function knows how to order them.
  const riverDayPath = t0.river;
  const fitted = riverDayPath
    ? fitRiverDay(candidates, o.launch, o, (o.loadout && o.loadout.rods) || [],
                  returnMin != null ? returnMin - launchMin : Infinity, transitMph)
    : { legs: t0.legs, facing: t0.facing, dropped: [], droppedRuns: [] };
  const legList = fitted.legs;
  const facing = fitted.facing;

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

  // ── WHAT THE LIGHT IS ON THIS LEG ───────────────────────────────────────────────────────────
  //
  // Ryan, 2026-09-15: "lets go ahead and make sure that the app is light aware through out the
  // whole day... so that techniques that work in low light or colors that should be used during
  // low light are known". And the correction that sets how: "we need to be careful with just
  // saying hour blindness... it really is light blindness... meaning if it was an overcast day then
  // topwater all day might be ok".
  //
  // The clock is already here -- every leg's `estStartTime` comes off it -- so each leg knows WHEN
  // it is fished and has never known what that means. legLightFor() turns the when into the light,
  // from the almanac and that hour's own WMO code, and stamps it on the leg, so the card, the
  // export, the phone and the warning further down read one answer instead of four.
  //
  // Undefined when there is no almanac, and that silence is deliberate: a guess about first light
  // is worse than no sentence about it.
  const lightOn = (startMin, minutes) =>
    legLightFor(o.waterState, o.weatherByHour, formatClock(startMin), minutes) || undefined;

  for (const w of fitted.dropped) warnings.push(w);

  // ── WHAT HAS ALREADY BEEN SAID ABOUT EACH REACH ─────────────────────────────────────────────
  //
  // A river reach is fished out and back, so a warning about the rig on it can arrive twice about one
  // decision -- and whether it SHOULD depends entirely on whether the thing it is about changed
  // between the two passes. This used to be answered two ad-hoc ways, both keyed on the pass: the
  // bait-ceiling answer was cached on the runId and copied onto the return pass, and the no-overlap
  // sentence was gated on `firstVisit`. Both are wrong now for the same reason -- the two passes can
  // carry DIFFERENT RODS (`deployBack`) and always carried DIFFERENT LIGHT, and capBaitDepth's light
  // check is exactly the one that catches a first-light topwater note being dragged back at two in
  // the afternoon. Keyed on the pass, that check never ran on the half of the day it was written for.
  //
  // So the rule is one rule, and it is about the sentence rather than the pass: identical news is
  // said once, different news is said twice, because two different sentences are two different facts.
  const saidForRun = new Map();

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
  // WHERE IN THE DAY EACH PASS OF EACH RUN SITS, because that is where a change "before" it happens.
  //
  // KEYED BY RUN **AND PASS**, which is the whole of how a change gets a time on a river. A reach
  // appears twice in `legList` under one `runId`, so a Map keyed by runId alone can only ever point
  // at one of the two -- it pointed at the run out, and the run back could not be reached. The two
  // are hours and a light change apart. `c.pass` is undefined on every lake leg and resolves to 1, so
  // a lake day keys exactly as it did.
  const passKey = (runId, pass) => `${runId}\u0000${Number(pass ?? 1) === 2 ? 2 : 1}`;
  const legOrder = new Map();
  legList.forEach((c, i) => {
    const k = passKey(c.runId, c.pass);
    if (!legOrder.has(k)) legOrder.set(k, i);
  });
  const rodLastUsed = new Map();
  const useRod = (id, i) => {
    if (!id) return;
    if (!rodLastUsed.has(id) || rodLastUsed.get(id) < i) rodLastUsed.set(id, i);
  };
  legList.forEach((c, i) => {
    const d = deployOn(o, c) || {};
    useRod(d.port, i);
    useRod(d.starboard, i);
    for (const s of (stopsByRun.get(c.runId) || [])) for (const r of (s.rods || [])) useRod(r, i);
  });

  const planned = new Set(legList.map((c) => c.runId));
  for (const s of (o.stops || [])) {
    if (!planned.has(s.runId)) warnings.push(`dropped a stop on ${s.runId} — that run is not in the plan`);
  }
  // WHICH PASS EACH CHANGE LANDS ON, resolved once here so the leg loop below is a lookup and not a
  // decision. A change that names the run back on a stretch fished only once has no home, and it is
  // put on the one pass there is rather than silently vanishing -- a dropped change is a bait he does
  // not put on, which is worse than a change placed a few hours early.
  const changeAtPass = new Map();
  for (const c of (o.changes || [])) {
    if (c.beforeRunId && !planned.has(c.beforeRunId)) {
      warnings.push(`dropped a lure change before ${c.beforeRunId} — that run is not in the plan`);
      continue;
    }
    const asked = Number(c.pass ?? 1) === 2 ? 2 : 1;
    const has = legOrder.has(passKey(c.beforeRunId, asked));
    if (asked === 2 && !has) {
      warnings.push(`the lure change on ${c.rodId} asked to happen before the run back over `
                  + `${c.beforeRunId}, which is fished once — put it before the one pass instead`);
    }
    changeAtPass.set(c, has ? asked : 1);
  }

  const rods = (o.loadout && o.loadout.rods) || [];

  for (const [ci, c] of legList.entries()) {
    // THE OUTWARD PASS OWNS THE STOPS AND THE LURE CHANGES. On a river a reach appears twice in this
    // list, and repeating a stop or a retie because the boat came back over the same water would
    // invent time and knots he never agreed to spend. Same rule the pass loop already applied when
    // the second pass was an inner loop; it just has to be said here now that it is a sibling.
    const firstVisit = (c.pass ?? 1) === 1;
    // A lure change happens where the boat is, before the leg starts — so it carries the current
    // cumulative distance, not a time. Cost comes from the rod's rig, not from the model's
    // opinion: a snap is seconds, a fluoro leader is a knot with wet hands. A change naming a rod
    // that is not in the loadout is a change to a seventh rod, and is refused.
    // A CHANGE HAPPENS BEFORE ONE PASS, NOT BEFORE A RUN. This used to be `firstVisit ? ... : []`,
    // which put every change on the run out and made a swap at the turnaround impossible -- see
    // changeAtPass above and `pass` in planArgsFrom().
    const thisPass = (c.pass ?? 1) === 2 ? 2 : 1;
    for (const ch of (changeByRun.get(c.runId) || [])
           .filter((ch) => (changeAtPass.get(ch) ?? 1) === thisPass)) {
      const rod = rods.find((r) => r.id === ch.rodId);
      if (!rod) { warnings.push(`dropped a lure change on ${ch.rodId} — no such rod in the loadout`); continue; }
      const usedAt = rodLastUsed.has(ch.rodId) ? rodLastUsed.get(ch.rodId) : -1;
      if (usedAt < (legOrder.get(passKey(c.runId, thisPass)) ?? 0)) {
        warnings.push(`dropped a lure change on ${ch.rodId} before ${c.runId} — that rod is `
                    + 'never trolled or cast again after it, so the swap costs a retie and '
                    + 'buys nothing');
        continue;
      }
      // ── DOES THE SWAP BUY ANYTHING? ────────────────────────────────────────────────────
      //
      // The test above asks whether the change is WASTED (the rod never fishes again). This one
      // asks whether it is EMPTY — whether the bait going on does anything different from the
      // bait coming off. See `presentationDelta()`, which is the first reader
      // `presentationSignature` has ever had.
      //
      // A WARNING, NOT A DROP, for the reason stated eighty lines up: dropping a legitimate
      // change is a worse failure than keeping a marginal one. A noise-and-flash change on a
      // slow day is a real thing to do. What Ryan cannot have is a plan that does it while
      // writing prose about suspended fish.
      const nameOf = typeof o.lureByName === 'function' ? o.lureByName : null;
      const fromL = nameOf ? nameOf(ch.from ?? rod.lure) : null;
      const toL = nameOf ? nameOf(ch.to) : null;
      const delta = fromL && toL
        ? presentationDelta(fromL, toL, { speedMph: trollMph, leadFt: rod.leadFt })
        : null;
      if (delta && !delta.differs.filter((f) => f !== 'noise' && f !== 'flash').length) {
        const moved = delta.differs.length ? delta.differs.join(' and ') : 'nothing at all';
        const [dl, dh] = delta.depth.to;
        warnings.push(`the lure change on ${ch.rodId} before ${c.runId} changes ${moved}. Both `
                    + `baits run ${dl}-${dh} ft on ${rod.leadFt} ft of lead, sit in the same part `
                    + `of the water column, read the same to a fish and troll at the same speed — `
                    + `so it is a change of sound, not of presentation. Keep it if that is the `
                    + `plan and say so; it is a job on the water either way.`);
      }

      changes.push({
        id: `C${changes.length + 1}`, atM: runM, rodId: ch.rodId,
        // NOT `rod.rig` ALONE. A bait tied to five feet of fluorocarbon behind a trolling
        // weight is a knot to change even though the snap is what the rod is wearing.
        cost: changeCostFor(toL ? toL.type : null, rod.rig),
        from: ch.from ?? rod.lure ?? null, to: ch.to ?? null, why: ch.why ?? null,
        buys: delta ? { same: delta.same, differs: delta.differs } : null,
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
        light: lightOn(clock, mins),
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

    // WHICH TWO RODS GO IN THE WATER, read here rather than eighty lines down because on a river it
    // is what SETS THE SPEED -- see riverCur below. Everything else about it is unchanged.
    const deploy = deployOn(o, c);

    // ── ON A RIVER THE APP SETS THE SPEED, AND THE MODEL IS NOT ASKED FOR ONE ────────────────────
    //
    // `drift` exists only on the lines river-drifts.js lays out, and `currentMph` is Q/A off the
    // centreline's charted cross-section against the live discharge. Both present is a river leg
    // carrying a measured current, which is the only case where the GPS number and the bait's number
    // differ -- so it is the only case that takes this path. riverPassNumbers() is the same call
    // fitRiverDay() made a hundred lines up to decide this leg was affordable at all.
    const P = riverPassNumbers(c, flipped, deploy, rods, o.lureByName);
    const { riverCur, baits, baitBand } = P;
    // TWO RODS SHARE ONE BOAT, SO A PAIR WHOSE WINDOWS DO NOT MEET COSTS ONE OF THEM. Naming both
    // baits, because the fix is a bait change and that is the model's call. Through sayOnce(), so a
    // reach fished out and back says it once about one pair -- and TWICE where the two passes carry
    // different pairs, which is two pairs and therefore two decisions. The over-driven warning
    // further down is not deduped at all, on purpose: that one is about the direction, and the two
    // directions are genuinely different news.
    // WHAT THIS LEG MAY SAY, ONCE. See saidForRun: the two passes over one reach are siblings in
    // `legList`, so anything said about the rig has to decide whether it is one piece of news or two.
    if (!saidForRun.has(c.runId)) saidForRun.set(c.runId, new Set());
    const said = saidForRun.get(c.runId);
    // THE SAME NEWS AT A DIFFERENT MINUTE IS THE SAME NEWS. Several of these sentences quote the
    // leg's own start clock -- "this leg starts 09:12 in daylight" -- and the two passes over one
    // reach never start at the same minute, so comparing the rendered text would call every sentence
    // new and dedupe nothing. The clock is masked out of the KEY only: what is left is the light
    // words, the rod, the bait and the depths, which is the news. So a reach fished twice in the same
    // light says it once, and a reach fished once at dawn and once at noon says it twice, because
    // "low light" and "NOT low light" are different words and survive the mask.
    const newsOf = (w) => String(w).replace(/\b\d{1,2}:\d{2}\b/g, '\u00b7');
    const sayOnce = (w) => {
      const k = newsOf(w);
      if (!said.has(k)) { said.add(k); warnings.push(w); }
    };
    if (baitBand && baitBand.overlap === false) {
      const [slow, fast] = baits[0].speed.max <= baits[1].speed.max ? [baits[0], baits[1]]
                                                                    : [baits[1], baits[0]];
      sayOnce(`${c.runId} has no one speed that fishes both baits: ${fast.name} needs at `
                  + `least ${baitBand.needsAtLeast} mph through the water and ${slow.name} blows `
                  + `out above ${baitBand.max}. Held at ${baitBand.max} so nothing blows out, `
                  + `which leaves the ${fast.name} under its window all day -- pick a pair whose `
                  + `speed ranges overlap.`);
    }
    // WHICH WAY THE BOAT IS POINTED ON EACH PASS. A drift is drawn DOWNSTREAM -- 3DHP's
    // `flowdirection` sets vertex order, see river-drifts.js -- so the line as drawn is the
    // downstream run and `flipped` is the upstream one. Each further pass turns around again, so the
    // parity of the pass number is the rest of the answer.
    const upstreamOn = (np) => (np % 2 === 1 ? !!flipped : !flipped);

    // The trolling leg, AT THE SPEED THE MODEL SET FOR IT -- on still water. `trollMph` was a
    // scaffold from before the prompt asked for a speed at all, and it outlived its reason:
    // plan-prompt.js validates `speedMph` on every leg and rides it in on the candidate, and this
    // file used to overwrite it with one day-wide number -- so a day running one leg at 1.8 and the
    // next at 2.2 reported both at 2.0 and budgeted both at 2.0. It is a DEFAULT now, used only for
    // a leg the model gave no speed for, and the minutes and the amp-hours come from the leg's own
    // speed. A speed outside the bounds is refused the way everything else here is refused:
    // ignored, said out loud, fallen back from.
    let legMph = trollMph;
    let legHeld = null;
    if (P.mph != null) {
      legMph = P.mph; legHeld = P.held;
    } else if (c.speedMph != null) {
      const want = Number(c.speedMph);
      if (want >= TROLL_MPH_MIN && want <= TROLL_MPH_MAX) legMph = want;
      else warnings.push(`${c.runId} asked for ${c.speedMph} mph -- outside `
                       + `${TROLL_MPH_MIN}-${TROLL_MPH_MAX} mph, trolled at ${trollMph} instead`);
    }
    const legStartM = runM;
    const legLen = Math.round(c.lengthM);
    // Drawn the way it will be RUN, and priced the same way. The GPX, the map and the phone's "what
    // is next" all read this array in order, so a flipped leg whose geometry still ran the other way
    // would draw the boat backwards along its own track -- and cost the current the wrong way round.
    const trollCoords = P.coords && P.coords.length ? P.coords
      : (flipped ? (c.coordinates ? c.coordinates.slice().reverse() : [legStart, legEnd])
                 : (c.coordinates || [legStart, legEnd]));
    const mins = minutesFor(c.lengthM, legMph);
    // ── THE AMPS COME FROM THE WATER SPEED AND THE CLOCK FROM THE GROUND SPEED ───────────────────
    //
    // `ampHours()` uses its one speed argument for both, which is right on still water and wrong the
    // moment the water moves -- and it is WRONG IN THE DIRECTION THAT STRANDS HIM, because setting
    // the speed from the bait makes the upstream pass the SLOWER one over the ground, so a
    // current-blind cost reads the dearer direction as the cheaper. `ampHoursAlong()` walks the real
    // geometry and charges the draw at through-water speed; see its note in plan-candidates.js. No
    // wind here -- the assembler is never handed one -- and with nothing to resolve the two agree.
    const a = (P.ah != null && legMph === P.mph) ? P.ah
      : (riverCur != null
          ? ampHoursAlong(trollCoords, legMph,
                          { alongCurrentMph: upstreamOn(1) ? riverCur : -riverCur }).ah
          : ampHours(c.lengthM, legMph));
    if (legHeld && legHeld.held === false) {
      warnings.push(`${c.runId} cannot be trolled slow enough going `
                  + `${upstreamOn(1) ? 'upstream' : 'downstream'}: ${riverCur} mph of current puts `
                  + `the baits above their window at every speed this boat holds, so it runs at `
                  + `${legMph} mph over the ground and they are over-driven. Watch for blow-out.`);
    }
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
    for (const s of (firstVisit ? (stopsByRun.get(c.runId) || []) : [])) {
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

    // THE LIGHT THIS LEG IS FISHED IN, worked out before the rods are checked because the check
    // reads it: a bait whose own recorded technique names a light window is worth a word when the
    // leg is measured to be in another one. See capBaitDepth().
    const legLight = lightOn(clock, mins + stopMin);

    // No bait may run deeper than the shallowest water on this leg. See capBaitDepth().
    // `maxRunDepthFt` is preferred over `depthFt` because the two answer different questions:
    // the ceiling is the SHALLOWEST water on the leg, `depthFt` the MEDIAN. Both planners now
    // measure both from the same envelope profile — see waterBand() in plan-pieces.js — so the
    // fallback below only fires on a pack fitted before those profiles existed.
    // ── AND THE BAIT'S DEPTH IS SET BY THE WATER SPEED, NOT THE GROUND SPEED ────────────────────
    //
    // `capBaitDepth` runs the same physics the box does -- leadForDepth(), depthWindow() -- and every
    // one of those takes a speed THROUGH THE WATER, because that is the only speed a lip or a blade
    // or a lead responds to. It was handed `legMph`, which is now a GROUND speed on a river and is
    // out by the whole current in one direction and the whole current the other way: the same bait
    // on the same lead would have been reported running two different depths on the pass out and the
    // pass back, when in fact it runs the same depth both ways. That identity is also why `rodPlan`
    // may be copied onto pass 2 unchanged.
    const waterMph = riverCur != null
      ? Number((legMph + (upstreamOn(1) ? riverCur : -riverCur)).toFixed(2)) : legMph;
    // ── JUDGED ON EVERY PASS, AND SAID ONCE PER SENTENCE ────────────────────────────────────────
    //
    // The bait's DEPTH really is identical both ways on a river -- that is the whole point of handing
    // this the WATER speed rather than the ground speed, a few lines up -- so this was computed once
    // per reach and the answer copied onto the return pass, which stopped "put a Squarebill on no
    // lead at all" arriving twice about one rig.
    //
    // TWO THINGS IN HERE ARE NOT THE SAME ON BOTH PASSES, THOUGH. The rods can differ now
    // (`deployBack`), and the LIGHT never was the same: this call carries `legLight`, and the check it
    // feeds is the one that catches a bait whose own technique note says first light being dragged
    // back through full sun. Cached on the runId, the return pass inherited the outward answer and
    // that check never ran on the afternoon -- the half of the day it exists for.
    //
    // So it runs every pass, into a scratch list, and saidForRun decides what is news. Identical
    // sentences collapse; a sentence that differs because the hour or the pair differs is kept.
    const fresh = [];
    const rodPlan = capBaitDepth(rods, deploy, Number(c.maxRunDepthFt ?? c.depthFt), waterMph,
                                 o.lureByName, c.runId, fresh, fish,
                                 // THE LEG'S OWN ENVELOPE, so a one-shoal ceiling can be told apart
                                 // from water that is shallow all the way along. See capBaitDepth.
                                 { medianFt: Number(c.depthFt), minFt: Number(c.depthMinFt),
                                   maxFt: Number(c.depthMaxFt) }, legLight);
    for (const w of fresh) sayOnce(w);

    legs.push({
      id: `L${++li}`, type: 'troll',
      runId: c.runId, runIndex: c.runIndex,
      startM: legStartM, lengthM: legLen,
      // THE LEG IS A RANGE OF WATER AND SAYS SO. The median is what it is called; the two ends
      // are what a lure depth is judged against. Absent on a pack with no envelope profile.
      depthFt: c.depthFt, depthMinFt: c.depthMinFt ?? null, depthMaxFt: c.depthMaxFt ?? null,
      speedMph: legMph,
      // WHICH PASS OVER THIS WATER THIS IS. Stamped here for a river day, whose two passes are
      // siblings in `legList` rather than an inner loop, and by the pass loop below for a lake.
      pass: c.pass, ofPasses: c.ofPasses,
      deploy,
      // ── WHAT TO REACH FOR IF THESE TWO ARE NOT WORKING ─────────────────────────────────────
      //
      // Checked in planArgsFrom() against the pair this leg deploys, and checked AGAIN here against
      // the pair actually in the water on THIS PASS. The two can differ: `deployBack` may put a
      // different two rods on the run back, and a fallback that names a rod already out, or offers
      // to replace a rod that is not out, is worse than no sentence. Absent rather than adjusted,
      // because which rod is worth reaching for on the afternoon pass is a fishing call and not
      // arithmetic the app is entitled to make.
      ifNotProducing: (() => {
        const f = c.ifNotProducing;
        if (!f || !f.rodId || !f.insteadOf || !deploy) return undefined;
        const outThere = deploy.port === f.insteadOf || deploy.starboard === f.insteadOf;
        const alreadyIn = deploy.port === f.rodId || deploy.starboard === f.rodId;
        return outThere && !alreadyIn ? f : undefined;
      })(),
      // WHAT THIS LEG ACTUALLY FISHES, where it differs from the bag. Only the rods capBaitDepth
      // had to move, keyed by rod id: { R2: { leadFt, runsDepthFt } }. Absent when the loadout's
      // own lead clears this leg, and every reader falls back to the rod.
      rodPlan: rodPlan || undefined,
      // ── AND WHAT THE SOUNDER IS FOR, WHEN THE PLAN CANNOT KNOW WHERE THE FISH ARE ──────────
      //
      // A sibling of `ifNotProducing` above, and deliberately not the same thing. That one answers
      // "these two baits are not getting bitten" and is the model's fishing call. This one answers
      // "the sonar says the fish are deeper than what I am pulling", which is arithmetic off his own
      // loadout, so the app owns it outright and states it on every troll leg whether or not
      // anything is wrong. See sonarContingency() for where each number comes from.
      //
      // Priced at the WATER speed, the same one capBaitDepth() judged the pair at, so the two can
      // never disagree about how deep the same rod is running on the same leg.
      sonarCheck: sonarContingency(rods, deploy, rodPlan, waterMph, o.lureByName),
      batteryAh: round2(a),
      estDurationMin: Math.round(mins + stopMin), estStartTime: formatClock(clock),
      light: legLight,
      why: c.why ?? null,
      // WHICH WAY THE BOAT IS POINTED ON A RIVER, which is why the pass up and the pass back carry
      // two different `speedMph` over the same water. Read by laneTelemetry() in plan-builder.js,
      // which labels the leg with it; absent on a lake, where the question has no answer.
      heading: riverCur != null ? (upstreamOn(1) ? 'upstream' : 'downstream') : undefined,
      // Drawn the way it will be RUN -- see trollCoords, which is also what the leg was priced on.
      coordinates: trollCoords,
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
        // WHETHER `at` IS THE CHART'S POSITION OR JUST A POINT ON THE LINE. Set by the passes
        // builder in plan-candidates.js; the GPX note reads it so a pin the chart cannot place
        // stops claiming to be a charted position.
        charted: h.charted,
        // WHICH SIDE OF THE BEND, so the GPX waypoint can be called what it is. See markLabel().
        side: h.side,
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
      const prev = legs[legs.length - 1];
      const passCoords = (prev.coordinates || []).slice().reverse();
      // ── AND ITS OWN SPEED, BECAUSE IT IS POINTED THE OTHER WAY ──────────────────────────────
      //
      // The pass back is not the pass out at the same number. On a river the bait's window is fixed
      // through the water and the current has changed sign, so the ground speed that holds it is a
      // different number -- and so are the minutes it takes and the amp-hours it costs. This is the
      // whole reason each pass is a real leg rather than one leg carrying a multiplier.
      const up = upstreamOn(np);
      const g = baitBand ? groundSpeedFor(baitBand, riverCur, up) : null;
      const passMph = g ? g.mph : legMph;
      const passMin = g ? minutesFor(c.lengthM, passMph) : mins;
      const passAh = riverCur != null
        ? ampHoursAlong(passCoords, passMph, { alongCurrentMph: up ? riverCur : -riverCur }).ah
        : a;
      // NO INVENTED CEILING ON THE PASS COUNT. What bounds the day is the time he has to be off
      // the water, which is already known here and already what the budget is judged against. So
      // the passes stop at the first one that would end after it, and say which one.
      if (returnMin != null && clock + passMin > returnMin) {
        warnings.push(`${c.runId} asked for ${legPasses} passes — stopped after ${np - 1}, `
                    + `pass ${np} would end after ${formatClock(returnMin)}`);
        break;
      }
      // Once per direction, not once per pass: passes 3 and 4 repeat 1 and 2 and the warning with
      // them, and the same sentence four times reads as four problems.
      if (np === 2 && g && g.held === false) {
        warnings.push(`${c.runId} cannot be trolled slow enough going ${up ? 'upstream' : 'downstream'}: `
                    + `${riverCur} mph of current puts the baits above their window at every speed `
                    + `this boat holds, so pass ${np} runs at ${passMph} mph over the ground and they `
                    + `are over-driven. Watch for blow-out.`);
      }
      legs.push({
        ...first,
        id: `L${++li}`,
        startM: runM,
        speedMph: passMph,
        heading: riverCur != null ? (up ? 'upstream' : 'downstream') : undefined,
        batteryAh: round2(passAh),
        // No `stopMin`: the stops are on the first pass and are not repeated.
        estDurationMin: Math.round(passMin), estStartTime: formatClock(clock),
        // ITS OWN LIGHT, NOT THE FIRST PASS'S. A leg fished back is a later leg, and on a first-
        // light launch the pass down and the pass back are not in the same light at all.
        light: lightOn(clock, passMin),
        // Drawn the way it will be RUN, which is the way the pass before it was not.
        coordinates: passCoords,
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
      runM += legLen; fishingM += legLen; ah += passAh; clock += passMin;
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
        light: lightOn(clock, mins),
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

  /* ── A ROD RIGGED AND NEVER PUT IN THE WATER IS A KNOT TIED FOR NOTHING ────────────────────────
   *
   * The mirror of "A LEG WITH NOTHING IN THE WATER IS SAID OUT LOUD", and nothing said it. Ryan,
   * 2026-09-18, reading a plan whose loadout carried a lipless crankbait: *"but a rod with a lipless
   * crankbait isnt offered on any leg?"* It was offered -- on the one reach the APP had removed.
   *
   * TWO DIFFERENT SENTENCES, BECAUSE THEY ARE TWO DIFFERENT FAULTS.
   *
   * A rod the MODEL rigged and then never deployed is its own miss, and it is the same currency as the
   * lure-change guard above: "a snap change is seconds, a fluoro leader is a knot with cold wet hands
   * in a moving kayak". The schema tells it that two rods is a complete answer and that rods it does
   * not name stay staged with whatever is already on them -- so naming a rod is asking for a retie.
   *
   * A rod stranded because fitRiverDay() CUT THE REACH IT WAS FOR is the app's doing, not the model's,
   * and saying "you rigged this for nothing" about it would be blaming him for our arithmetic. That
   * one names the reach that went, because the fix is a different day and not a different bait.
   */
  const inWater = new Set();
  for (const l of legs) {
    for (const side of ['port', 'starboard']) {
      if (l.deploy && l.deploy[side]) inWater.add(l.deploy[side]);
    }
    for (const st of (l.stops || [])) for (const r of (st.rods || [])) inWater.add(r);
  }
  const strandedBy = new Map();
  for (const runId of (fitted.droppedRuns || [])) {
    // BOTH PAIRS, because a reach that came off the day may have had a second pair named for the run
    // back, and a rod rigged only for that is stranded by the cut exactly as an outward one is.
    for (const d of [(o.deploy && o.deploy[runId]) || {},
                     (o.deployBack && o.deployBack[runId]) || {}]) {
      for (const side of ['port', 'starboard']) {
        const id = d[side];
        if (id && !inWater.has(id) && !strandedBy.has(id)) strandedBy.set(id, runId);
      }
    }
  }
  // A PLAN WITH NO WATER IN IT HAS NOTHING TO DEPLOY ON, and saying "this rod never fishes" six times
  // about an empty day is noise on top of the one thing that matters. The emptiness is already the
  // story -- `assemblePlan({candidates: []})` must warn about nothing, which is its own test.
  const anyFished = legs.some((l) => l.type === 'troll');
  for (const r of (anyFished ? rods : [])) {
    if (!r || r.staged || !r.id || inWater.has(r.id)) continue;
    const lure = r.lure ? `a ${r.lure}` : 'a bait';
    if (strandedBy.has(r.id)) {
      warnings.push(`${r.id} is rigged with ${lure} and its only water came off the day — it was `
                  + `deployed on ${strandedBy.get(r.id)} and nothing else. THAT IS THE APP'S DOING, `
                  + `not a bad pick: re-plan with a shorter day or a later return and it fishes.`);
    } else {
      warnings.push(`${r.id} is rigged with ${lure} and never goes in the water on any leg. Two rods `
                  + `is a complete answer and the other four stay staged with whatever is on them, so `
                  + `a rod this plan names is a retie it is asking for — and this one buys nothing.`);
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
  // AND THE OTHER DIRECTION, WHICH NOTHING CHECKED. The over case above has been here since the
  // schema; a plan that fills a QUARTER of the window went through silently -- 131 minutes of 540
  // on Lake Wateree, 2026-09-14, finished at 08:12 on a day that runs to 15:00.
  //
  // THE THRESHOLD IS THE PLAN'S OWN SHORTEST LEG, not a number somebody picked. If the time left
  // over is at least as long as the shortest leg already in the plan, then one more leg of the
  // kind it already chose would have fit, and that is a fact about this plan rather than a rule
  // about days in general. A plan that leaves less than one leg of slack is simply full.
  if (windowMin && plan.budget.estPlannedMin < windowMin) {
    const spans = legs
      .filter((l) => l && l.type !== 'transit')
      .map((l) => Number(l.estDurationMin))
      .filter((n) => Number.isFinite(n) && n > 0);
    const shortest = spans.length ? Math.min(...spans) : 0;
    const unspent = windowMin - plan.budget.estPlannedMin;
    if (shortest > 0 && unspent >= shortest) {
      warnings.push(`fills ${plan.budget.estPlannedMin} of ${windowMin} min — ${unspent} unspent, `
        + `and the shortest leg in it runs ${Math.round(shortest)} min, so about `
        + `${Math.floor(unspent / shortest)} more like it would have fit. A short day is a fine `
        + 'answer; an unexplained one is not.');
    }
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
