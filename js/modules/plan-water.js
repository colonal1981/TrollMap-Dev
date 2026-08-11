/**
 * plan-water.js — offer the water, with reasons, and let the fisherman choose.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Ryan, 2026-08-10, after watching the app produce three plans in a row that each read like the
 * last one:
 *
 *   > the problem is you keep coding things that should be decided by the conditions not by some
 *   > algorithm
 *
 * and, on what a plan is actually for:
 *
 *   > the purpose of the plan is to find fish
 *
 * So this module does not pick water. It measures what each piece of water OFFERS, writes down
 * what is good and bad about it in words, and hands the whole set over to be chosen from. The
 * model's job shrinks to assigning baits and speeds to what he ticked. See
 * claude/THE_FISHERMAN_CHOOSES_2026-08-10.md, which governs.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEPTH AXIS IS WATER DEPTH, NOT BAIT DEPTH — AND THAT IS THE WHOLE DESIGN DECISION HERE
 *
 * `reachCurve()` computes water >= depth + clearance, and clearance is "how much water a bait
 * wants under it". That number was asked for three times and refused three times, the last time
 * plainly:
 *
 *   > i dont know what this i have no idea how to answer
 *
 * That is not a gap in his knowledge, it is a badly-posed question. How much water a bait needs
 * under it depends on which bait, how fast, how much lead, and what the bottom is made of — and
 * at PICK time none of those exist yet, because tackle is assigned after the water is chosen.
 *
 * So clearance is set to zero and the axis is relabelled. Every depth in this module is a
 * MINIMUM WATER DEPTH, and a row reads "1.2 mi where the shallowest water is at least 26 ft".
 * He decides what runs in 26 ft, which is a judgement he makes per lure on the water anyway. The
 * arithmetic is identical; the difference is that nothing is invented and the number on the
 * screen is one the chart actually measured.
 *
 * The standing rule this follows: if the answer would be a number he would have to make up, the
 * app measures something and shows it instead.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * NO DOM, NO NETWORK, NO GLOBALS
 *
 * Everything here is pure so the whole path runs in a test. `plan-water-ui.js` is the only thing
 * that knows about `document`, and the fetch comes in as an argument.
 */

import { buildPieces } from './plan-pieces.js';
import { ampHours, minutesFor, metresBetween } from './plan-candidates.js';

/**
 * CLEARANCE IS ZERO BECAUSE THE AXIS IS WATER DEPTH. Not a tuning constant — see the header. If
 * this ever becomes non-zero the labels in plan-water-ui.js become lies, so it lives here, named,
 * rather than as a bare 0 at the call site.
 */
const AXIS_IS_WATER_DEPTH = 0;

/** Trolling and deadhead speeds, matching what plan-assemble.js costs a day at. */
export const TROLL_MPH = 2.0;
export const TRANSIT_MPH = 3.5;

/**
 * THE DEPTH LADDER THE OFFER CURVE IS MEASURED ON.
 *
 * Two feet is the finest step worth drawing: the chart is contoured in feet, Wateree sits about
 * two feet below full pool, and the wander envelope already moves the answer by a median 3.9 ft.
 * A one-foot ladder would draw a precision the inputs do not have.
 *
 * It spans the fish band with room either side ON PURPOSE. The band is where the research says
 * the fish are, and a piece of water that only just covers it is a piece of water with no room to
 * be wrong -- which is the optionality the doc asks to be scored rather than assumed away.
 */
export function depthLadder(bandFt, { stepFt = 2, padFt = 8 } = {}) {
  const [lo, hi] = Array.isArray(bandFt) && bandFt.length === 2 ? bandFt : [6, 40];
  const from = Math.max(stepFt, Math.floor((lo - padFt) / stepFt) * stepFt);
  const to = Math.ceil((hi + padFt) / stepFt) * stepFt;
  const out = [];
  for (let d = from; d <= to; d += stepFt) out.push(d);
  return out;
}

const median = (arr) => {
  const s = (arr || []).filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : null;
};

/**
 * HOW MUCH DEPTH THIS ONE PIECE HOLDS — WHICH IS ALMOST NONE, AND THAT IS THE FINDING.
 *
 * The first version of this read the offer curve and reported "6–18 ft available, about 4 laps".
 * That was wrong, and wrong in the flattering direction. THE OFFER CURVE IS MONOTONE: water at
 * least 18 ft deep is also water at least 6 ft deep, so the curve's span is not a range of
 * different lanes, it is the same lane thresholded four times. Measured on Wateree, the six
 * longest pieces read 3360/3360/3200/3120/3120/3080/3000 m at 6/8/10/12/14/16/18 ft — one piece
 * of water, counted seven times.
 *
 * The honest measure is what the corridor actually contains, and the pipeline stamps both sides
 * of it: `envelope_ft` is the shallowest water within 25 m of the line and `envelope_deep_ft` the
 * deepest. The gap between them is how much depth the wander buys.
 *
 * On Wateree that gap is 1–4 ft. Which is not a defect — a fitted contour is a narrow band of
 * depth BY CONSTRUCTION. It means a single piece offers one pattern and the laps have to come
 * from somewhere else. See ladderPartners().
 */
export function optionality(piece) {
  const shallow = median(piece.envelope);
  const deep = median(piece.envelopeDeep);
  if (shallow == null) return { spanFt: 0, fromFt: null, toFt: null };
  const toFt = deep == null ? shallow : deep;
  return { spanFt: Math.max(0, toFt - shallow), fromFt: shallow, toFt };
}

/**
 * WHERE THE LAPS ACTUALLY COME FROM.
 *
 * Ryan does not stop at the end of a pass:
 *
 *   > i will slowly turn around and run back the same general direction i came but either deeper
 *   > or shallower depending on what depth the original path was on... the only real stopping
 *   > point is when i catch fish, stop to cast or i am done for the day
 *
 * and on why a shortish piece is fine if the app can find its partner:
 *
 *   > i agree with you that 3/4 of a mile is fine as long as the app can draw the line back the
 *   > other way at the other depth... it doesn't seem to be good at linking them together
 *
 * So the unit he experiences is not one pass, it is a piece of water worked as a serpentine, and
 * a piece's real optionality is HOW MANY DIFFERENT DEPTHS SIT WITHIN A TURN OF IT. Measured on
 * Wateree, 2026-08-10: two lanes 104 m apart, 882 m out and 877 m back with a 619 m turn between
 * them, is 74% of the distance with lines in the water.
 *
 * Two pieces are partners when they run close enough to turn between and hold water that differs
 * by enough to be a different presentation. Neither number is invented: `linkM` defaults to the
 * corridor width the doc already fixed at 50 m either side, doubled, because that is the same
 * "is this the same water" test used to collapse duplicates in the first place — anything closer
 * has already been merged into this piece. `stepFt` defaults to 3, the shallow end of his own
 * "3-5 ft" description of a lap-to-lap shift, so a partner that only just differs still counts.
 */
export function ladderPartners(pieces, { linkM = 100, stepFt = 3 } = {}) {
  const cell = Math.max(linkM, 50);
  const grid = new Map();
  const key = (c) => `${Math.floor((c[0] * 91000) / cell)},${Math.floor((c[1] * 110540) / cell)}`;
  pieces.forEach((p, i) => {
    for (const c of (p.coords || [])) {
      const k = key(c);
      if (!grid.has(k)) grid.set(k, new Set());
      grid.get(k).add(i);
    }
  });
  const near = (a, b) => {
    let best = Infinity;
    // Sampled, not exhaustive: the coordinates are ~10 m apart and the answer only has to
    // separate "you can turn into it" from "that is a move", which 40 m of sampling settles.
    for (let i = 0; i < a.length; i += 4) {
      for (let j = 0; j < b.length; j += 4) {
        const d = metresBetween(a[i], b[j]);
        if (d < best) best = d;
        if (best <= 1) return best;
      }
    }
    return best;
  };
  return pieces.map((p, i) => {
    const cand = new Set();
    for (const c of (p.coords || [])) {
      const [gx, gy] = key(c).split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const m of grid.get(`${gx + dx},${gy + dy}`) || []) if (m !== i) cand.add(m);
        }
      }
    }
    const out = [];
    for (const m of cand) {
      const q = pieces[m];
      if (Math.abs((q.holdsFt || 0) - (p.holdsFt || 0)) < stepFt) continue;
      const d = near(p.coords, q.coords);
      if (d <= linkM) out.push({ key: q.key ?? m, index: m, holdsFt: q.holdsFt,
                                 lengthM: q.lengthM, turnM: Math.round(d) });
    }
    out.sort((a, b) => a.turnM - b.turnM);
    return out;
  });
}

/**
 * DOES THE WATER OVERLAP THE BAND THE FISH ARE IN?
 *
 * Answered against the CORRIDOR, not the offer curve, and the difference is not academic. The
 * first version asked the curve, and on the first Wateree piece it drew that produced a row
 * reading "0.60 mi in water 8 ft or deeper ... 17-24 ft inside the corridor ... none of it sits
 * in the 15-40 ft the research puts the fish at". All three sentences were about the same water
 * and the third one was flatly wrong: 17-24 ft is inside 15-40.
 *
 * `holdsFt` is a THRESHOLD -- the shallowest point the whole stretch clears, set by one shoal
 * somewhere along it. The corridor is the WATER. Describing a piece by its threshold is how a
 * stretch of 17-24 ft water ends up announced as 8 ft.
 */
function bandOverlap(piece, bandFt) {
  if (!Array.isArray(bandFt) || bandFt.length !== 2) return null;
  const [lo, hi] = bandFt;
  const { fromFt, toFt } = optionality(piece);
  if (fromFt == null) return { covers: 0, fromFt: null, toFt: null };
  const a = Math.max(lo, fromFt), b = Math.min(hi, toFt);
  const overlapFt = Math.max(0, b - a);
  return {
    covers: hi > lo ? overlapFt / (hi - lo) : (overlapFt > 0 || (fromFt >= lo && fromFt <= hi) ? 1 : 0),
    inBand: b >= a,
    fromFt: a, toFt: b, waterFrom: fromFt, waterTo: toFt,
  };
}

const mi = (m) => m / 1609.34;
const fmtMi = (m) => `${mi(m).toFixed(mi(m) < 1 ? 2 : 1)} mi`;

/**
 * REASONS FOR, AND REASONS AGAINST.
 *
 * Ryan: "the reasons against needs to be built... there needs to be consequences for trying to
 * route over hazard instead of just trying to ignore it".
 *
 * Every line is assembled from something already measured, so it is instant, consistent and can
 * be checked. NOT model-written: a generated sentence can only be taken or left, and the reason
 * this list exists is so he can argue with it.
 *
 * NOTHING HERE RETURNS A VERDICT. It returns two lists of sentences and the numbers behind them.
 * Which of these matter today is his call and the whole point of handing him the choice.
 */
export function reasons(piece, o) {
  const minM = o.minM;
  const band = o.fishBandFt;
  const holding = o.holding || null;
  const forIt = [];
  const against = [];

  const opt = optionality(piece);
  const partners = o.partners || [];
  const near = piece.near || [];
  const avoid = near.filter((n) => n.t === 'hazard' || n.t === 'obstruction');
  const cover = near.filter((n) => n.t === 'timber' || n.t === 'attractor' || n.t === 'pile');

  // DESCRIBE THE WATER, THEN THE THING THAT LIMITS IT. `holdsFt` is a threshold set by the
  // shallowest point on the stretch; the corridor is what he is actually fishing. Leading with
  // the threshold is how 17-24 ft water got announced as "8 ft or deeper".
  if (opt.fromFt != null && opt.toFt - opt.fromFt >= 2) {
    forIt.push(`${fmtMi(piece.lengthM)} unbroken, ${opt.fromFt}–${opt.toFt} ft of water`);
  } else if (opt.fromFt != null) {
    forIt.push(`${fmtMi(piece.lengthM)} unbroken, about ${opt.fromFt} ft of water`);
  } else {
    forIt.push(`${fmtMi(piece.lengthM)} unbroken`);
  }
  // The shallowest point is the one that decides whether a bait clears the whole pass, so it is
  // named separately whenever it is meaningfully shallower than the water around it.
  if (opt.fromFt != null && opt.fromFt - piece.holdsFt >= 3) {
    against.push(`it clears ${piece.holdsFt} ft at its shallowest — one spot that shallow is what `
               + `sets how deep you can fish the whole ${fmtMi(piece.lengthM)}`);
  }

  // THE LAPS ARE THE PARTNERS, not the offer curve — see ladderPartners(). A piece with three
  // partners is a morning; a piece with none is one pass and then a decision.
  if (partners.length) {
    const depths = [...new Set(partners.map((q) => q.holdsFt))].sort((a, b) => a - b);
    forIt.push(`${partners.length} other piece${partners.length > 1 ? 's' : ''} within `
             + `${partners[partners.length - 1].turnM} m holding ${depths.join(', ')} ft — `
             + `turn at the end and come back on one of those without a real move`);
  } else {
    against.push(`nothing within a turn of it at a different depth — one pass, and then you are `
               + `deciding where to go rather than swinging round onto the next band`);
  }

  // The headline already gives the range, so this only speaks when it has something to add: the
  // corridor is too tight to change anything by wandering, or wide enough that it does on its own.
  if (opt.spanFt <= 2) {
    against.push(`the corridor only spans ${opt.spanFt} ft, so wandering off the line does not `
               + `change the water much either way — what you set is what you fish`);
  } else if (opt.spanFt >= 6) {
    forIt.push(`${opt.spanFt} ft of depth inside the corridor, so easing either side of the line `
             + `changes the water without steering for it`);
  }

  const ov = bandOverlap(piece, band);
  if (ov && band) {
    if (!ov.inBand) {
      // NOT a filter. Suspended fish live over water deeper than the band, and `holding` is what
      // says whether that is fine -- see the eligibility rule in WHAT_SMARTPLAN_IS.
      const deeperOnly = ov.waterFrom != null && ov.waterFrom > band[1];
      against.push(deeperOnly && (holding === 'suspended' || holding === 'both')
        ? `all of it is deeper than the ${band[0]}–${band[1]} ft the fish are holding at — fine `
          + `for suspended fish, but the bottom here tells you nothing about them`
        : `the water here is ${ov.waterFrom}–${ov.waterTo} ft, outside the ${band[0]}–${band[1]} ft `
          + `the research puts the fish at`);
    } else if (ov.covers >= 0.6) {
      forIt.push(`${ov.fromFt}–${ov.toFt} ft of it sits inside the ${band[0]}–${band[1]} ft band `
               + `the research puts the fish at`);
    } else {
      forIt.push(`reaches into the ${band[0]}–${band[1]} ft band at ${ov.fromFt}–${ov.toFt} ft`);
    }
  }

  if (cover.length) {
    forIt.push(`${cover.length} piece${cover.length > 1 ? 's' : ''} of wood or brush within `
             + `${Math.round(Math.min(...cover.map((n) => n.d)))}–`
             + `${Math.round(Math.max(...cover.map((n) => n.d)))} m of the line`);
  }

  // THE SAME OBJECT IS A REASON FOR OR AGAINST DEPENDING ON WHERE IT SITS. Ryan, on timber at 30
  // ft under fish suspended at 25: "not information... TARGET!!!" -- so this says where the thing
  // is and how deep the water is there, and never which of the two it is today.
  if (avoid.length) {
    against.push(`${avoid.length} charted hazard${avoid.length > 1 ? 's' : ''} within `
               + `${Math.round(Math.min(...avoid.map((n) => n.d)))} m of the line — whether that `
               + `is a snag or the reason to be here depends on how deep the baits run`);
  }

  // ALREADY STAMPED BY THE PIPELINE AND NEVER READ UNTIL NOW. "we do not actually know what is
  // down there for a third of this" is honest and useful, and it is the difference between water
  // that is shallow and water nobody sounded.
  if (Number.isFinite(piece.chartedFrac) && piece.chartedFrac < 0.85) {
    against.push(`only ${Math.round(piece.chartedFrac * 100)}% of this is charted — the rest is `
               + `water nobody sounded, which is not the same as water that is deep`);
  }

  // THE CENTRELINE LIES AND THE PIPELINE MEASURED BY HOW MUCH. Across 5,977 Wateree passes the
  // line overstates the shallowest water by a median 3.9 ft. Where the gap is big on THIS piece,
  // the edge is steep and it wants steering rather than relaxing.
  if (Number.isFinite(piece.shallowestLineFt) && Number.isFinite(piece.shallowestFt)) {
    const gap = piece.shallowestLineFt - piece.shallowestFt;
    if (gap >= 5) {
      against.push(`the chart line reads ${Math.round(gap)} ft deeper than the shallowest water `
                 + `within a wander of it — a steep edge, so this one wants steering`);
    }
  }

  if (piece.duplicates > 2) {
    forIt.push(`${piece.duplicates} charted contours run through this same water, so the line is `
             + `a suggestion rather than something to hold`);
  }

  if (piece.relief) forIt.push(`sits on ${String(piece.relief).replace(/_/g, ' ')}`);

  return { for: forIt, against, optionality: opt, bandOverlap: ov };
}

/**
 * WHAT A DAY OF TICKED PIECES COSTS, AND WHETHER IT FITS.
 *
 * Ryan, on the one thing allowed to be rigid:
 *
 *   > if it is a battery thing i would say we need a safety hard stop... if they are going to run
 *   > out of battery because of choice they shouldn't be able to make that choice
 *
 * IT IS ORDER-DEPENDENT, so the check runs against the BEST realisable ordering rather than the
 * order they happen to be ticked in. That is what makes the refusal useful: not "no", but "yes,
 * if you fish it second instead of last". Display order is not a fact about the day.
 *
 * `usableAh` already has the LiFePO4 reserve removed upstream — see usableAhFrom(). Nothing here
 * takes a second bite at it.
 *
 * @param {object[]} picked   pieces, in any order
 * @param {object}   o        {ramp:[lon,lat], usableAh, windowMin, trollMph, transitMph}
 */
export function dayCost(picked, o) {
  const ramp = o.ramp;
  const trollMph = o.trollMph || TROLL_MPH;
  const transitMph = o.transitMph || TRANSIT_MPH;
  const ends = picked.map((p) => {
    const c = p.coords || [];
    return [c[0], c[c.length - 1]];
  });

  // Straight-line between leg ends. THE ROUTER IS NOT CALLED HERE and the result says so:
  // routing every candidate ordering over the water graph would be dozens of round trips while
  // he is still ticking boxes. A straight line is always the OPTIMISTIC answer, so a set this
  // says will not fit definitely will not fit, and one it passes gets re-checked when the plan is
  // actually assembled. Understating the cost of the refusal is the safe direction; overstating
  // the cost of an accept is not, which is why `overWater` is false until the router has run.
  const hop = (a, b) => metresBetween(a, b);

  const legAh = picked.map((p) => ampHours(p.lengthM, trollMph));
  const legMin = picked.map((p) => minutesFor(p.lengthM, trollMph));

  const n = picked.length;
  const best = { order: [], flips: [], moveM: Infinity };
  if (n === 0) {
    return { fits: true, order: [], moveM: 0, trollM: 0, ah: 0, min: 0,
             usableAh: o.usableAh, overWater: false, reason: null };
  }

  // n! is fine to n=8 (40,320 orderings x 2^8 flips is too much, so direction is chosen greedily
  // inside each ordering, which is exact for a chain: at each step take the nearer end).
  const idx = [...Array(n).keys()];
  const walk = (order) => {
    let at = ramp, m = 0;
    const flips = [];
    for (const i of order) {
      const [a, b] = ends[i];
      const da = hop(at, a), db = hop(at, b);
      // A pass fishes the same both ways, so start from whichever end is nearer -- the same rule
      // orientLegs() applies in the assembler.
      if (db < da) { m += db; at = a; flips.push(true); } else { m += da; at = b; flips.push(false); }
    }
    m += hop(at, ramp);
    return { m, flips };
  };
  const permute = (arr, k = 0) => {
    if (k === arr.length) {
      const r = walk(arr);
      if (r.m < best.moveM) { best.moveM = r.m; best.order = [...arr]; best.flips = r.flips; }
      return;
    }
    for (let i = k; i < arr.length; i++) {
      [arr[k], arr[i]] = [arr[i], arr[k]];
      permute(arr, k + 1);
      [arr[k], arr[i]] = [arr[i], arr[k]];
    }
  };
  if (n <= 8) {
    permute(idx);
  } else {
    // Nearest-neighbour then 2-opt. SAID OUT LOUD in the return value rather than presented as
    // the best order, because past that size this is a heuristic and a heuristic that claims to
    // be exact is how a refusal becomes wrong in the direction that costs a paddle home.
    const left = new Set(idx);
    const order = [];
    let at = ramp;
    while (left.size) {
      let pick = null, d = Infinity;
      for (const i of left) {
        const [a, b] = ends[i];
        const t = Math.min(hop(at, a), hop(at, b));
        if (t < d) { d = t; pick = i; }
      }
      left.delete(pick);
      order.push(pick);
      const [a, b] = ends[pick];
      at = hop(at, a) <= hop(at, b) ? b : a;
    }
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < order.length - 1; i++) {
        for (let j = i + 1; j < order.length; j++) {
          const cand = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
          if (walk(cand).m < walk(order).m - 1) { order.splice(0, order.length, ...cand); improved = true; }
        }
      }
    }
    const r = walk(order);
    best.moveM = r.m; best.order = order; best.flips = r.flips;
  }

  const trollM = picked.reduce((s, p) => s + p.lengthM, 0);
  const moveAh = ampHours(best.moveM, transitMph);
  const ah = legAh.reduce((s, x) => s + x, 0) + moveAh;
  const min = legMin.reduce((s, x) => s + x, 0) + minutesFor(best.moveM, transitMph);
  const fits = !(o.usableAh > 0) || ah <= o.usableAh;

  return {
    fits,
    exact: n <= 8,
    order: best.order,
    flips: best.flips,
    moveM: Math.round(best.moveM),
    trollM: Math.round(trollM),
    ah: Number(ah.toFixed(1)),
    moveAh: Number(moveAh.toFixed(1)),
    min: Math.round(min),
    usableAh: o.usableAh,
    overWater: false,
    // TIME IS FEEDBACK, NOT A GATE. Ryan: only the battery is a hard stop, and the clock is his
    // to spend -- a day that runs long is a day he chose to run long.
    overWindowMin: o.windowMin ? Math.max(0, Math.round(min - o.windowMin)) : 0,
    reason: fits ? null
      : `${ah.toFixed(1)} Ah against ${o.usableAh} usable — over by ${(ah - o.usableAh).toFixed(1)} Ah`,
  };
}

/**
 * The whole offer, ready for the screen.
 *
 * @param {object[]} lanes    features from trolling_runs.geojson
 * @param {object}   o        {minM, fishBandFt, holding, ramps, ramp, usableAh}
 */

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CAST SPOTS — the second unit, and the same object priced two different ways.
//
//   > those spots if they overlap a trolling lane are perfect stop and casts... so it helps with
//   > the trolling as well
//
// THE_FISHERMAN_CHOOSES § 6 is exact about this and it is the whole design:
//
//     A spot inside a chosen route's corridor IS the stop-and-cast, at no extra travel. A spot
//     away from every chosen route is a destination that costs the trip. Same object, priced by
//     where it lands.
//
// So a spot is never "on route" or "not on route" as a property of itself. It is priced against
// WHAT HAS BEEN TICKED, which changes every time he ticks something — which is why this takes the
// picked set as an argument and is recomputed, rather than being stamped on once at load.
//
// Cast-all-day is not a mode. It is simply the day where spots are all he picks.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * CORRIDOR WIDTH IS HIS NUMBER, NOT A TUNING CONSTANT.
 *
 * 50 m either side, § 6. Not to be confused with the 100 m the dedupe uses to call two lanes the
 * same water — that one is derived from the wander envelope and answers a different question.
 */
const CORRIDOR_M = 50;

/** What the packs can name as something worth stopping on, and what to call it. */
const SPOT_KINDS = {
  timber:      'flooded timber',
  attractor:   'DNR brushpile',
  pile:        'brush pile',
  hump:        'offshore hump',
  ledge:       'ledge',
  point:       'point',
  creek_mouth: 'creek mouth',
  cove:        'cove',
  dock_line:   'line of docks',
  dock_cluster:'pocket of docks',
};

/**
 * Every markable thing on the lake, once, with its position — gathered from the lanes' own `near`
 * arrays because that is where the pipeline has already joined structure to geometry.
 *
 * DEDUPED BY POSITION. A stand of timber beside eight nested contours appears in eight `near`
 * arrays and is one stand of timber. Same failure the lanes themselves had, same fix: collapse on
 * where it is, not on which row mentioned it.
 */
export function castSpots(lanes, { cellM = 40 } = {}) {
  const seen = new Map();
  for (const f of (lanes || [])) {
    const p = (f && f.properties) || {};
    const coords = (f.geometry && f.geometry.coordinates) || [];
    const total = p.length_m || 0;
    if (!coords.length || !total) continue;
    for (const n of (p.near || [])) {
      const label = SPOT_KINDS[n.t];
      if (!label || n.s == null) continue;
      // `near` gives metres along the lane, not a position, so the position is read off the lane's
      // own geometry at that distance. Approximate by fraction of length -- the lanes are sampled
      // at ~10 m and a cast spot is a place to stop, not a waypoint to steer to.
      const at = coords[Math.max(0, Math.min(coords.length - 1,
                                             Math.round((n.s / total) * (coords.length - 1))))];
      if (!at) continue;
      const key = `${n.t}:${Math.round(at[0] * 111320 / cellM)},${Math.round(at[1] * 110540 / cellM)}`;
      const prev = seen.get(key);
      // Keep the sighting closest to a charted line: it is the best-positioned one.
      if (!prev || n.d < prev.offM) {
        seen.set(key, { key: `s${seen.size}`, type: n.t, what: label, at, offM: n.d,
                        // DEPTH ONLY WHERE THE PACK HAS ONE. Timber, piles and attractors carry
                        // none anywhere in the packs, and the height a stand of wood rises off the
                        // bottom is not a number that exists: "how tall is every tree claude???"
                        depthFt: Number.isFinite(n.depth_ft) ? n.depth_ft : null });
      }
    }
  }
  return [...seen.values()];
}

/** Metres from a point to the nearest part of a piece's line. */
function toPiece(at, piece) {
  let best = Infinity;
  for (const c of (piece.coords || [])) {
    const d = metresBetween(at, c);
    if (d < best) best = d;
  }
  return best;
}

/**
 * PRICE EVERY SPOT AGAINST WHAT IS CURRENTLY TICKED.
 *
 * Returns each spot with `onPiece` (the key of the picked water whose corridor it sits in, or
 * null) and `detourM` — how far off the day it actually is. A spot on a picked route costs
 * nothing but the minutes spent casting; a spot off every picked route costs the run out and back.
 *
 * Recompute on every tick. That is the point: the same brush pile is a free stop when he picks the
 * water beside it and a trip when he does not, and nothing about the pile changed.
 */
export function priceSpots(spots, picked, { ramp, corridorM = CORRIDOR_M } = {}) {
  return (spots || []).map((s) => {
    let onPiece = null, best = Infinity;
    for (const p of (picked || [])) {
      const d = toPiece(s.at, p);
      if (d < best) { best = d; if (d <= corridorM) onPiece = p.key; }
    }
    return {
      ...s,
      onPiece,
      // Distance to the nearest ticked water, or to the ramp when nothing is ticked yet.
      detourM: Number.isFinite(best) && best < Infinity ? Math.round(best)
             : (ramp ? Math.round(metresBetween(s.at, ramp)) : null),
      free: onPiece != null,
    };
  }).sort((a, b) => (a.free === b.free ? a.detourM - b.detourM : (a.free ? -1 : 1)));
}

/**
 * THE ORDER OF THE DAY IS A SEARCH ORDER, AND IT IS THE APP'S — WITH HIS VETO.
 *
 * THE_FISHERMAN_CHOOSES § 14, which I asked about and should not have:
 *
 *     Who orders the day. Now a SEARCH order — most diagnostic first, not highest scoring. His
 *     "maybe" was about keeping veto: "my maybe was that i have veto or override authority."
 *
 * And § 0, on why:
 *
 *     Diversity beats quality, early. Four hours on the single best-scoring stretch finds fish
 *     more slowly than two hours across three different patterns.
 *     The most diagnostic water goes first. The best first leg is the one that tells you the most
 *     when it fails.
 *
 * THIS IS NOT dayCost()'s ORDER. That one is the cheapest realisable route and it exists for the
 * battery hard stop -- § 9, "the check runs against the best realisable ordering of the ticked
 * set". Cheapest and most-diagnostic are different questions and I had them as one.
 *
 * HOW DIAGNOSTIC IS MEASURED, from what is already on a piece.
 *
 * First leg: the most REPRESENTATIVE of the ticked set, because if it produces nothing it rules
 * out the most. Representativeness is how close a piece sits to the middle of the set on the two
 * axes the day actually turns on -- the depth of its water, and what kind of place it is.
 *
 * After that: whatever is most UNLIKE everything already fished, because a search learns from
 * water that turns out to be dead and repeating a pattern learns nothing.
 *
 * The model is not asked. It stops choosing water and stops ordering -- § 12.
 */
export function searchOrder(picked) {
  const n = (picked || []).length;
  if (n < 3) return (picked || []).map((_, i) => i);
  // Two axes, both already measured: how deep the water is, and what kind of place it is.
  const depth = picked.map((p) => p.holdsFt || 0);
  const lo = Math.min(...depth), hi = Math.max(...depth);
  const span = hi - lo || 1;
  const kinds = picked.map((p) => new Set((p.near || []).map((q) => q.t)));
  const relief = picked.map((p) => String(p.relief || ''));
  // Distance between two picks: depth difference, plus how little structure they share, plus
  // whether they sit on the same kind of bottom.
  const apart = (i, j) => {
    const dd = Math.abs(depth[i] - depth[j]) / span;
    const a = kinds[i], b = kinds[j];
    const union = new Set([...a, ...b]).size || 1;
    let shared = 0;
    for (const k of a) if (b.has(k)) shared++;
    return dd + (1 - shared / union) + (relief[i] === relief[j] ? 0 : 0.5);
  };
  // Most representative = smallest total distance to everything else.
  let first = 0, bestSum = Infinity;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) if (i !== j) sum += apart(i, j);
    if (sum < bestSum) { bestSum = sum; first = i; }
  }
  // Then farthest-first: each next leg is the one least like anything already fished.
  const order = [first];
  const left = new Set([...Array(n).keys()]);
  left.delete(first);
  while (left.size) {
    let pick = null, best = -Infinity;
    for (const i of left) {
      let nearest = Infinity;
      for (const j of order) nearest = Math.min(nearest, apart(i, j));
      if (nearest > best) { best = nearest; pick = i; }
    }
    left.delete(pick);
    order.push(pick);
  }
  return order;
}

export function offerWater(lanes, o) {
  const minM = o.minM;
  if (!(minM > 0)) {
    // HIS NUMBER FOR THE DAY, and there is no constant behind it: "if i want to spend the day
    // doing cast and stops on tiny contours i should be able to do that".
    throw new Error('offerWater: minM is required — how long a pass has to be to count as one is '
                  + 'a decision for the day, not a constant this module gets to hold');
  }
  const built = buildPieces(lanes, {
    clearFt: AXIS_IS_WATER_DEPTH,
    minM,
    depths: depthLadder(o.fishBandFt),
    ramps: o.ramps,
  });
  const keyed = built.pieces.map((p, i) => ({ ...p, key: `w${i}` }));
  // Partners first: a piece's best argument is usually the one next to it, so reasons() cannot
  // be written until the whole set is known.
  const partners = ladderPartners(keyed, { linkM: o.linkM ?? 100 });
  const pieces = keyed.map((p, i) => ({
    ...p,
    partners: partners[i],
    reasons: reasons(p, { minM, fishBandFt: o.fishBandFt, holding: o.holding,
                          partners: partners[i] }),
  }));
  // Spots are gathered here and PRICED later, by priceSpots(), because their price depends on what
  // has been ticked and that is not known yet. Gathering is expensive; pricing is cheap.
  const spots = castSpots(lanes);
  return { ...built, pieces, spots, minM, depthAxis: 'minimum water depth, ft' };
}
