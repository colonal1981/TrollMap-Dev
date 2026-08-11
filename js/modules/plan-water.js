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

/** Does this piece hold water at the depth the research puts the fish at? */
function bandOverlap(piece, bandFt, minM) {
  if (!Array.isArray(bandFt) || bandFt.length !== 2) return null;
  const [lo, hi] = bandFt;
  const usable = (piece.offers || []).filter((o) => o.lengthM >= minM).map((o) => o.depthFt);
  if (!usable.length) return { covers: 0, inBand: [] };
  const inBand = usable.filter((d) => d >= lo && d <= hi);
  // How much of the researched band this water can actually put a bait in.
  return { covers: hi > lo ? inBand.length * 2 / (hi - lo) : (inBand.length ? 1 : 0), inBand };
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

  forIt.push(`${fmtMi(piece.lengthM)} unbroken in water at least ${piece.holdsFt} ft deep`);

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

  if (opt.spanFt <= 2) {
    against.push(`the corridor itself only spans ${opt.spanFt} ft (${opt.fromFt}–${opt.toFt}), `
               + `so wandering off the line does not change the water much either way`);
  } else {
    forIt.push(`${opt.fromFt}–${opt.toFt} ft inside the corridor, so a wander either side is `
             + `${opt.spanFt} ft of depth without steering for it`);
  }

  const ov = bandOverlap(piece, band, minM);
  if (ov && band) {
    if (!ov.inBand.length) {
      // NOT a filter. Suspended fish live over water deeper than the band, and `holding` is what
      // says whether that is fine -- see the eligibility rule in WHAT_SMARTPLAN_IS.
      const deeperOnly = opt.fromFt != null && opt.fromFt > band[1];
      against.push(deeperOnly && (holding === 'suspended' || holding === 'both')
        ? `all of it is deeper than the ${band[0]}–${band[1]} ft the fish are holding at — fine `
          + `for suspended fish, but the bottom here tells you nothing about them`
        : `none of it sits in the ${band[0]}–${band[1]} ft the research puts the fish at`);
    } else if (ov.covers >= 0.75) {
      forIt.push(`covers most of the ${band[0]}–${band[1]} ft band the research puts the fish at`);
    } else {
      forIt.push(`reaches into the ${band[0]}–${band[1]} ft band at `
               + `${ov.inBand[0]}–${ov.inBand[ov.inBand.length - 1]} ft`);
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
  return { ...built, pieces, minM, depthAxis: 'minimum water depth, ft' };
}
