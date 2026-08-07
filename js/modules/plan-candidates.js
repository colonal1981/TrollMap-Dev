/**
 * Candidate legs for a day's plan — the payload the model chooses from.
 *
 * Ryan, 2026-08-07, on what the model should be handed: "the most applicable for that species
 * i would think within a given area of the ramp."
 *
 * So: REACHABLE from this ramp inside the day's budget, RELEVANT to the depth the species is
 * using, RANKED by what the water passes. The model never sees the whole lake and never emits a
 * coordinate — it picks a candidate by id. See PLAN_SCHEMA_V2.md.
 *
 * A LEG IS A SLICE OF A RUN, NOT A WHOLE RUN. trolling_runs.geojson on Wateree holds 1,609 runs
 * with a median length of 517 m — but 185 are over 5 km and the longest is 50,637 m, because a
 * "run" is a whole stitched contour. At 2 mph a 60–90 minute leg is 3–5 km. So this slides a
 * window along each run and keeps the best-scoring placement, which is why a leg carries
 * `startM` and `lengthM`.
 *
 * Structure positions are NOT re-derived here. build_trolling_runs.py already emits
 * `near: [{s, t, d}]` — metres along the run, type, and metres off it — so a stop's `atM` comes
 * straight out of the pipeline.
 *
 * NO SCORING OF FISH. This ranks water by what it PASSES and what it COSTS. Which structure
 * matters for which species on which day is `trollingIntelligence`'s job, and the weights come
 * in from the caller. Ryan, 2026-08-06: "depends on the species, time of year, lake forage...
 * like this isn't something a script can solve."
 */

// Fitted to Ryan's own two observations, 2026-08-07, because Newport publishes no curve:
// trolling 1.8–2.2 mph draws 3–7 A; 100% throttle (~5 mph, no wind or current) draws 25 A.
// Anchoring 5 A at 2.0 and 25 A at 5.0 gives an exponent of ln(5)/ln(2.5) = 1.756, which lands
// at 4.2 A at 1.8 mph and 5.9 A at 2.2 — inside his range without being told to.
//
// THIS IS A TWO-POINT FIT, NOT A MEASUREMENT. The BMS reports live draw and the GPS reports
// speed, so the real curve is learnable from his own trips. Say so wherever it surfaces.
export const AMPS_REF_MPH = 2.0;
export const AMPS_REF_A = 5.0;
export const AMPS_EXP = 1.756;

export function ampsAtMph(mph) {
  const v = Math.max(0.1, Number(mph) || 0);
  return AMPS_REF_A * Math.pow(v / AMPS_REF_MPH, AMPS_EXP);
}

/** Amp-hours to cover `metres` at `mph`. Trolling ~2.5 Ah/mile; transit at 3.5 mph ~3.8. */
export function ampHours(metres, mph) {
  const v = Math.max(0.1, Number(mph) || 0);
  return ampsAtMph(v) * (metres / 1609.34) / v;
}

export function minutesFor(metres, mph) {
  const v = Math.max(0.1, Number(mph) || 0);
  return (metres / 1609.34) / v * 60;
}

const R = 6371000;
export function metresBetween(a, b) {
  const p1 = a[1] * Math.PI / 180, p2 = b[1] * Math.PI / 180;
  const dp = p2 - p1, dl = (b[0] - a[0]) * Math.PI / 180;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** Cumulative distance along a LineString, so `s` from the pipeline resolves to a coordinate. */
export function cumulative(coords) {
  const out = [0];
  for (let i = 1; i < coords.length; i++) out.push(out[i - 1] + metresBetween(coords[i - 1], coords[i]));
  return out;
}

/** The coordinate `m` metres along a run. */
export function pointAt(coords, cum, m) {
  if (m <= 0) return coords[0];
  const last = cum[cum.length - 1];
  if (m >= last) return coords[coords.length - 1];
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= m) lo = mid; else hi = mid; }
  const span = cum[hi] - cum[lo] || 1;
  const t = (m - cum[lo]) / span;
  return [coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t,
          coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t];
}

// ---------------------------------------------------------------------------------------------
// RESOLVING A PASS TO A REAL STRUCTURE
//
// `near: [{s, t, d}]` tells you a hump goes by at 1,395 m, 41 m off the line. It does not tell
// you WHICH hump — build_trolling_runs.py carries no id into `near`. So a stop could name a type
// and a distance but never a thing, and its depth would have to be invented. That invention is
// exactly what PLAN_SCHEMA_V2 forbids: "a stop at targetDepth: 6 on a 41 ft hump — depth comes
// from the structure, not a `?? 6`."
//
// So the app resolves it: take the point `s` metres along the run, look for a feature of the same
// kind within the recorded offset plus a margin, take the nearest. structure.geojson has real ids
// (hump_2, ledge_57) and real depths; water_features.geojson has neither an id nor, for
// creek_mouths, a depth — so those resolve to a description and a null depth rather than a guess.
//
// This is a PICK, not a certainty, and here is how good a pick. Measured over Wateree's top 60
// candidates, 2026-08-07 — 532 passes:
//
//     hump      303 of 304 resolved      point  173 of 185      cove  56 of 59 (11 with a depth)
//     timber, attractor, bridge, pile:   0 of 48. Those types are in `near[]` but in neither
//     structure.geojson nor water_features.geojson, so a stop on one gets a position and no depth.
//
// A correct match should land at the offset `near[]` recorded, and it does: |matchM − offM| has a
// median of 6 m and a p90 of 29 m, with 71% inside 15 m. The tail is where several of a kind sit
// close together and the nearest one wins. `matchM` is on every pass so that ambiguity is visible
// instead of implied away. When the pipeline finally emits an id in `near[]` this whole thing
// collapses into a lookup and should be deleted, not kept alongside it.
//
// NOT USED AS A DEPTH: `deepest_within_m`. It is metres, and a run 8.9 ft deep carries a value of
// 57 — whatever it measures, it is not feet of water, and reading it as depth would put a stop on
// the bottom of a hole that does not exist.
// ---------------------------------------------------------------------------------------------

const RESOLVE_CELL = 0.004;          // ~440 m of longitude here; one bucket comfortably covers a pass
const RESOLVE_MARGIN_M = 40;         // slack over the recorded offset, for the sign of `d`

const DEPTH_FIELD = {
  hump: 'depth_ft', ledge: 'depth_ft', point: 'deep_side_ft', cove: 'deep_side_ft',
};

function describeStructure(kind, p) {
  const n = (v, u, d = 0) => (Number.isFinite(Number(v)) ? `${Number(v).toFixed(d)}${u}` : null);
  const bits = [];
  if (kind === 'hump') {
    bits.push('offshore hump');
    if (n(p.area_acres, ' ac', 1)) bits.push(n(p.area_acres, ' ac', 1));
    if (n(p.relief_ft, ' ft of relief')) bits.push(n(p.relief_ft, ' ft of relief'));
    if (n(p.depth_ft, ' ft')) bits.push(`crown ${n(p.depth_ft, ' ft')}`);
  } else if (kind === 'ledge') {
    bits.push('ledge');
    if (n(p.drop_ft, ' ft drop', 1)) bits.push(n(p.drop_ft, ' ft drop', 1));
    if (n(p.slope_ft_per_100ft, ' ft per 100 ft')) bits.push(n(p.slope_ft_per_100ft, ' ft per 100 ft'));
    if (n(p.depth_ft, ' ft')) bits.push(`at ${n(p.depth_ft, ' ft')}`);
  } else if (kind === 'creek_mouth') {
    bits.push(p.name ? `${p.name} mouth` : 'creek mouth');
    if (n(p.cove_m, ' m of cove behind it')) bits.push(n(p.cove_m, ' m of cove behind it'));
  } else {
    bits.push(kind === 'point' ? 'point' : kind);
    if (n(p.bulge_m, ' m bulge')) bits.push(n(p.bulge_m, ' m bulge'));
    if (n(p.deep_side_ft, ' ft on the deep side', 1)) bits.push(n(p.deep_side_ft, ' ft on the deep side', 1));
  }
  if (p.relief) bits.push(String(p.relief).replace(/_/g, ' '));
  return bits.filter(Boolean).join(', ');
}

/**
 * A lookup from structure.geojson + water_features.geojson, bucketed so a pass costs a handful of
 * distance checks instead of 7,900. Pass the FEATURES, in any order; kinds are read off each one.
 */
export function structureIndex(...featureLists) {
  const grid = new Map();
  let n = 0;
  for (const list of featureLists) {
    for (const f of (list || [])) {
      const g = f && f.geometry;
      if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
      const p = f.properties || {};
      const kind = p.kind || p.type;
      if (!kind) continue;
      const [lon, lat] = g.coordinates;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const depth = Number(p[DEPTH_FIELD[kind]]);
      const rec = {
        kind, lon, lat,
        id: p.id || null,
        depthFt: Number.isFinite(depth) && depth > 0 ? Number(depth.toFixed(1)) : null,
        what: describeStructure(kind, p),
      };
      const key = `${Math.floor(lon / RESOLVE_CELL)},${Math.floor(lat / RESOLVE_CELL)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(rec);
      n++;
    }
  }
  return { grid, n };
}

/** Nearest feature of `kind` to `at`, within `withinM`. Null when nothing matches. */
export function resolveStructure(at, kind, withinM, index) {
  if (!index || !index.grid || !at) return null;
  const cx = Math.floor(at[0] / RESOLVE_CELL), cy = Math.floor(at[1] / RESOLVE_CELL);
  let best = null, bestM = Infinity;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const r of (index.grid.get(`${cx + dx},${cy + dy}`) || [])) {
        if (r.kind !== kind) continue;
        const m = metresBetween(at, [r.lon, r.lat]);
        if (m < bestM) { bestM = m; best = r; }
      }
    }
  }
  return best && bestM <= withinM ? { ...best, matchM: Math.round(bestM) } : null;
}

export const DEFAULT_WEIGHTS = {
  hump: 3, creek_mouth: 3, point: 2, ledge: 2, cove: 1,
  timber: 2, attractor: 2, pile: 1, bridge: 1,
  shallow: 0, hazard: 0,        // navigational marks, not targets
};

/**
 * Score one window of a run by what it passes.
 *
 * Deliberately NOT normalised by length: a 4 km leg passing eight humps is better water than a
 * 1 km leg passing two, and the caller is already spending battery per metre. Dividing by length
 * would make a 200 m stub with one hump outrank a real trolling pass.
 */
function scoreWindow(near, fromM, toM, weights, maxOffM) {
  let score = 0;
  const hits = [];
  for (const n of near) {
    if (n.s < fromM || n.s > toM) continue;
    if (n.d > maxOffM) continue;
    const w = weights[n.t] ?? 0;
    if (!w) continue;
    // Something 20 m off the line is worth more than the same thing 95 m off it.
    const proximity = 1 - (n.d / maxOffM) * 0.5;
    score += w * proximity;
    hits.push({ atM: Math.round(n.s - fromM), type: n.t, offM: n.d, weight: w });
  }
  return { score, hits };
}

/**
 * LET THE WATER DECIDE HOW LONG A LEG IS.
 *
 * Ryan, 2026-08-07, asked whether a pass should be 2, 4 or 6 km: "let the water decide — stop
 * forcing a fixed window, fish whatever the run offers."
 *
 * The first cut fixed every leg at `targetM` = 4,000 m, so every candidate on Wateree came back
 * exactly 4,000 m long whether the structure ran for eight kilometres or stopped after one. That
 * is a number I chose showing up in the plan as if the lake had said it.
 *
 * So: find the densest stretch the run has, then grow it outward until the water goes quiet.
 *
 * FIRST ATTEMPT, AND WHY IT FAILED, because the failure is instructive. The rule was "accept a
 * step if it carries at least some fraction of the density the leg already has." But the seed is
 * by construction the DENSEST stretch of the run, so every comparison was against the peak and
 * almost nothing qualified: on Wateree every candidate came back 1,500-2,000 m — the minimum —
 * at every threshold from 0.15 to 0.7. Swapping a fixed 4,000 m for a fixed 1,500 m is not
 * letting the water decide, it just moves which number of mine is doing the deciding.
 *
 * So the test is absolute, not relative: keep going while there is anything out there, and stop
 * after `quietM` metres of nothing. Then drop the quiet tail, so a leg never ends with half a
 * kilometre of blank water tacked on. A run with structure the whole way grows until it runs out
 * or hits `maxM`; a run with one good pocket and four kilometres of nothing stops at the pocket.
 *
 * `maxM` is a ceiling on a single leg, not on the day — at 2 mph, 8 km is about two and a half
 * hours on one line, and Wateree's longest stitched run is 50,637 m. It is the only fixed length
 * left, and it is there so one run cannot eat the whole trip.
 *
 * Runs shorter than `minM` are skipped, not offered whole: a 400 m pass over a hump is a
 * legitimate thing to fish but it is not a leg, and offering it as one is what filled the first
 * shortlist with 500 m stubs.
 */
function bestWindow(run, opts) {
  const p = run.properties || {};
  const total = p.length_m || 0;
  const near = p.near || [];
  const { minM, maxM, stepM, weights, maxOffM, quietM } = opts;
  if (total < minM) return null;

  const ceiling = Math.min(total, maxM);
  const at = (a, b) => scoreWindow(near, a, b, weights, maxOffM);

  // Seed: the densest `minM` the run has. Ties go to the earlier one, which keeps the result
  // stable when a run passes nothing at all.
  let lo = 0, hi = Math.min(minM, ceiling), seed = at(lo, hi).score;
  for (let s = stepM; s + minM <= total; s += stepM) {
    const sc = at(s, s + minM).score;
    if (sc > seed) { lo = s; hi = s + minM; seed = sc; }
  }

  // Forward, then backward. Each end walks until it has gone `quietM` with nothing, then falls
  // back to the last step that had something on it.
  const grow = (from, dir) => {
    let edge = from, lastGood = from, quiet = 0;
    while (quiet < quietM) {
      if (dir > 0 ? edge >= total : edge <= 0) break;
      if ((dir > 0 ? edge - lo : hi - edge) >= ceiling) break;
      const next = dir > 0 ? Math.min(total, edge + stepM) : Math.max(0, edge - stepM);
      const got = dir > 0 ? at(edge, next).score : at(next, edge).score;
      edge = next;
      if (got > 0) { quiet = 0; lastGood = edge; } else quiet += stepM;
    }
    return lastGood;
  };
  hi = grow(hi, +1);
  lo = grow(lo, -1);

  const win = at(lo, hi);
  return { startM: lo, lengthM: hi - lo, score: win.score, hits: win.hits,
           whole: lo === 0 && hi >= total };
}

/**
 * @param {object[]} runs        features from trolling_runs.geojson
 * @param {object}   o
 * @param {number[]} o.ramp      [lon, lat]
 * @param {number[]} o.depthFt   [min, max] the species is using — from trollingIntelligence
 * @param {number}   o.usableAh  BMS usable amp-hours (already carries the 20% reserve)
 * @param {number}   o.windowMin minutes between launch and return
 * @param {function} [o.transitM] (fromLonLat, toLonLat) => metres over water. Straight-line if
 *                                omitted, which UNDERSTATES cost on a reservoir — pass the
 *                                Worker-backed one for real numbers.
 * @param {object}   [o.structures] structureIndex(structure.geojson.features,
 *                                water_features.geojson.features). Without it every pass still
 *                                gets an id and a position, but no structure id and no depth —
 *                                so stops can be placed and cannot be sized.
 */
/** The coordinates of a run between two distances along it. */
export function sliceLine(coords, cum, fromM, toM) {
  const out = [pointAt(coords, cum, fromM)];
  for (let i = 0; i < coords.length; i++) if (cum[i] > fromM && cum[i] < toM) out.push(coords[i]);
  out.push(pointAt(coords, cum, toM));
  return out;
}

export function selectCandidates(runs, o) {
  const opts = {
    // A LEG IS A TROLLING PASS, NOT A STUB. First cut allowed 400 m and every candidate came
    // back a 500 m fragment, because short runs cost almost no battery and any per-Ah ranking
    // rewards that hardest. A pass you would actually set two rods for is over a kilometre.
    minM: o.minM ?? 1500,
    // The one fixed length left, and it is a ceiling rather than a target — see bestWindow().
    maxM: o.maxM ?? 8000,
    stepM: o.stepM ?? 250,
    // How much blank water ends a leg. 500 m is four minutes of trolling over nothing, which is
    // about as far as anyone would carry a set of rods on faith.
    quietM: o.quietM ?? 500,
    maxOffM: o.maxOffM ?? 100,
    weights: o.weights || DEFAULT_WEIGHTS,
  };
  const trollMph = o.trollMph ?? 2.0;
  const transitMph = o.transitMph ?? 3.5;
  const [dMin, dMax] = o.depthFt || [0, Infinity];
  const straight = (a, b) => metresBetween(a, b);
  const transitM = o.transitM || straight;

  const out = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i], p = run.properties || {};
    if (p.routable === false) continue;
    if (!(p.depth_ft >= dMin && p.depth_ft <= dMax)) continue;
    const coords = run.geometry && run.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;

    const win = bestWindow(run, opts);
    if (!win || win.score <= 0) continue;

    const cum = cumulative(coords);
    const start = pointAt(coords, cum, win.startM);
    const end = pointAt(coords, cum, win.startM + win.lengthM);
    // The geometry of the leg itself, sliced once and carried on the candidate. Without this the
    // assembler has a leg with a length and no line, so nothing can be drawn or exported and a
    // stop has nowhere to sit.
    const line = sliceLine(coords, cum, win.startM, win.startM + win.lengthM);
    const lineCum = cumulative(line);

    const inM = transitM(o.ramp, start);
    const outM = transitM(end, o.ramp);
    const fishAh = ampHours(win.lengthM, trollMph);
    const moveAh = ampHours(inM + outM, transitMph);
    const totalAh = fishAh + moveAh;
    const totalMin = minutesFor(win.lengthM, trollMph) + minutesFor(inM + outM, transitMph);

    // Reachable means: fish this one thing and get home, inside the day. A plan chains several,
    // so this is a ceiling on what is worth offering, not a promise the whole set fits.
    if (o.usableAh && totalAh > o.usableAh) continue;
    if (o.windowMin && totalMin > o.windowMin) continue;

    out.push({
      // NOTE: index-based. build_trolling_runs.py emits no stable id, so this reference breaks
      // if the pipeline reruns. Wants a real id in the pack.
      runId: `${o.slug || 'run'}#${i}`,
      runIndex: i,
      startM: Math.round(win.startM), lengthM: Math.round(win.lengthM),
      depthFt: p.depth_ft, wholeRun: win.whole,
      start, end, coordinates: line,
      transitInM: Math.round(inM), transitOutM: Math.round(outM),
      batteryAh: Number((fishAh + moveAh).toFixed(2)),
      estMin: Math.round(totalMin),
      score: Number(win.score.toFixed(1)),
      // Rank on structure passed, discounted by how much of the trip is deadhead.
      //
      // NOT score/Ah. That was the first version and it ranked 500 m stubs top of the list,
      // because a stub costs almost nothing and any per-cost ratio therefore loves it. The
      // question is not "cheapest per point", it is "most fishing for a day, with the travel
      // taxed" -- so discount by the transit share instead of dividing by total cost.
      value: Number((win.score / (1 + moveAh / Math.max(0.1, fishAh))).toFixed(2)),
      // Every pass gets an id and, where the lake data can name it, the real structure behind it.
      // The id is what the model returns to ask for a stop -- it can only name something it was
      // handed, which is what makes an invented stop like "Main Lake Point Alpha" impossible
      // rather than something the renderer has to cope with.
      passes: win.hits
        .sort((a, b) => a.atM - b.atM)
        .map((h, k) => {
          const at = pointAt(line, lineCum, h.atM);
          const s = resolveStructure(at, h.type, h.offM * 1.25 + RESOLVE_MARGIN_M, o.structures);
          return {
            ...h,
            id: `${o.slug || 'run'}#${i}:p${k}`,
            at,
            structureId: s ? s.id : null,
            what: s ? s.what : h.type.replace(/_/g, ' '),
            // From the structure or not at all. There is no fallback depth on purpose.
            depthFt: s ? s.depthFt : null,
            matchM: s ? s.matchM : null,
          };
        }),
      // Present only when the caller supplied a journal. Never affects `value` -- see catchSupport().
      support: o.catches
        ? catchSupport(line, o.catches,
                       { species: o.catchSpecies, month: o.month, radiusM: o.catchRadiusM })
        : null,
      // WHOLE-RUN, not windowed. build_trolling_runs.py reports ledges per run and gives no
      // positions, so these cannot be clipped to the window the way `near` can. Named so that
      // nothing downstream mistakes them for "ledges on this leg".
      runLedges: p.ledge_n ? { n: p.ledge_n, minFt: p.ledge_min_ft, maxFt: p.ledge_max_ft } : null,
      relief: p.relief ?? null,
    });
  }

  out.sort((a, b) => b.value - a.value);

  // SPATIAL DEDUPE. Contours nest, so the 15, 16, 17 and 18 ft runs through the same pocket are
  // four descriptions of one piece of water passing the same humps. Without this the first cut
  // returned twelve candidates inside 800 m of the ramp and offered the model no choice at all.
  // Greedy: take the best, then require each next one to start a real distance from every
  // candidate already kept.
  const apart = o.dedupeM ?? 1200;
  const kept = [];
  for (const c of out) {
    if (kept.every((k) => metresBetween(k.start, c.start) >= apart)) kept.push(c);
    if (o.limit && kept.length >= o.limit) break;
  }
  return kept;
}


/**
 * How much of Ryan's own catch history backs this water.
 *
 * Ryan, 2026-08-07, looking at the first shortlist: "1 is probably good, ill be honest i dont
 * think i have ever caught any fish on that side of the lake lol." The ranker had put it FIRST
 * on geometry alone. His log said otherwise, and the log was already in the app — just not
 * reaching the ranking.
 *
 * REPORTED SEPARATELY, DELIBERATELY NOT FOLDED INTO `value`.
 *
 * Two reasons. First, a feedback loop: you fish where you have caught fish, so you catch fish
 * there, so it ranks higher, so you fish there. Fold catch history into the score and the app
 * slowly stops showing you anything new. Second, "great geometry, never fished" and "ordinary
 * geometry, always produces" are BOTH useful and they are not the same fact — collapsing them
 * into one number throws away the more interesting of the two.
 *
 * So this inventories; `trollingIntelligence` and the angler decide what it means. Same standing
 * rule as everything else in the pipeline.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT A "CATCH POSITION" ACTUALLY IS. READ THIS BEFORE TIGHTENING ANY RADIUS.
 *
 * Ryan, 2026-08-07: "keep in mind that is the depth where the picture was taken... not
 * necessarily where it was caught."
 *
 * The position is where the PHOTO was taken, which is after the fight -- hook up, fight it, land
 * it, unhook, get the phone out. In a kayak with wind on you that is easily 100-300 m of drift
 * from where the fish bit. So a catch is a BLOB a few hundred metres wide, not a point.
 *
 * Consequences, all of which have already been got wrong once:
 *
 *   - `nearestM` is the distance to a DRIFTED PHOTO, not to a fish. Reporting "within 1 m of the
 *     line" is false precision. It is kept because it is a cheap sanity check on whether a
 *     candidate is in the right pocket at all -- never present it as where the fish was.
 *   - The `depth` column is WORSE: it is flagged `depth_from_contours`, so it is the charted
 *     depth at the drifted position. It is not the depth the fish was taken at and must not be
 *     used to derive a species depth band.
 *   - Do not shrink `radiusM` to make matches look sharper. The radius exists to cover the drift,
 *     and a tight one would reject real catches while implying an accuracy the data has not got.
 *
 * The CLUSTER is the signal. Ten stripers in one pocket says the pocket, reliably, even though
 * each point is fuzzy. Anything finer than "which pocket" is reading noise.
 *
 * Better data exists if it is ever wanted: a Garmin catch waypoint is dropped at the moment of
 * the catch, not after the photo. `garmin-parser.js` already reads them.
 * ---------------------------------------------------------------------------------------------
 */
export function catchSupport(line, catches, o = {}) {
  // 300 m, sized to the drift between hooking a fish and photographing it -- not to any claim
  // about GPS accuracy. See the provenance note above before changing it.
  const radiusM = o.radiusM ?? 300;
  const species = o.species ? [].concat(o.species).map((x) => String(x).toLowerCase()) : null;
  const month = o.month ?? null;              // 1-12, to weigh the same season
  const out = { n: 0, speciesN: 0, seasonN: 0, nearestM: null, lastDate: null, lures: {} };
  if (!Array.isArray(catches) || !catches.length || !Array.isArray(line) || line.length < 2) return out;

  // Bounding box with a margin, so most catches are rejected without any segment maths.
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const p of line) {
    if (p[0] < minLon) minLon = p[0]; if (p[0] > maxLon) maxLon = p[0];
    if (p[1] < minLat) minLat = p[1]; if (p[1] > maxLat) maxLat = p[1];
  }
  const padLat = radiusM / 110540, padLon = radiusM / (111320 * Math.cos(((minLat + maxLat) / 2) * Math.PI / 180) || 1);

  for (const c of catches) {
    const lat = Number(c.lat), lon = Number(c.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lon < minLon - padLon || lon > maxLon + padLon || lat < minLat - padLat || lat > maxLat + padLat) continue;

    let best = Infinity;
    for (let i = 0; i < line.length - 1; i++) {
      const d = pointToSegmentM([lon, lat], line[i], line[i + 1]);
      if (d < best) best = d;
      if (best <= 1) break;
    }
    if (best > radiusM) continue;

    out.n++;
    if (out.nearestM === null || best < out.nearestM) out.nearestM = Math.round(best);
    const sp = String(c.species || '').toLowerCase();
    if (species && species.some((x) => sp.includes(x) || x.includes(sp))) out.speciesN++;
    if (month && c.date) {
      const m = Number(String(c.date).split('-')[1]);
      // Within a month either side counts as the same season.
      if (Number.isFinite(m) && Math.min(Math.abs(m - month), 12 - Math.abs(m - month)) <= 1) out.seasonN++;
    }
    if (c.date && (!out.lastDate || String(c.date) > out.lastDate)) out.lastDate = String(c.date);
    if (c.lure) out.lures[c.lure] = (out.lures[c.lure] || 0) + 1;
  }
  return out;
}

/** Perpendicular distance in metres from a point to a segment, in a local planar frame. */
export function pointToSegmentM(p, a, b) {
  const kx = 111320 * Math.cos((p[1] * Math.PI) / 180), ky = 110540;
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky;
  const bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  const t = L > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

// A 4 km leg down a ledge line can pass eighty things. The model does not need eighty; it needs
// the ones worth stopping for. Ranked by weight, then by how close to the line, then re-sorted
// into the order they come up. THE CAP IS REAL AND THE PLAN SAYS SO -- `structuresShown` and
// `structuresTotal` both go to the model so a truncated list never reads as the whole leg.
const MODEL_STRUCTURE_CAP = 12;

/** Trim a candidate to what the model needs to choose. Geometry stays server-side. */
export function forModel(c, cap = MODEL_STRUCTURE_CAP) {
  const counts = {};
  for (const h of c.passes) counts[h.type] = (counts[h.type] || 0) + 1;
  const shown = c.passes
    .filter((h) => h.weight > 0)
    .slice()
    .sort((a, b) => (b.weight - a.weight) || (a.offM - b.offM))
    .slice(0, cap)
    .sort((a, b) => a.atM - b.atM)
    // No coordinates. The model names `id` and the app turns it back into a place; `structureId`
    // is the lake's own name for the thing and is there to be read, not returned.
    .map((h) => ({ id: h.id, structureId: h.structureId, type: h.type,
                   atM: h.atM, offM: Math.round(h.offM),
                   depthFt: h.depthFt, what: h.what }));
  return {
    runId: c.runId,
    depthFt: c.depthFt,
    lengthM: c.lengthM,
    transitFromRampM: c.transitInM,
    batteryAh: c.batteryAh,
    estMin: c.estMin,
    passes: counts,
    structures: shown,
    structuresShown: shown.length,
    structuresTotal: c.passes.filter((h) => h.weight > 0).length,
    runLedges: c.runLedges,
    // "You have caught 6 fish along this stretch, 4 of them stripers" is a fact the model should
    // weigh. "You have never fished here" is equally a fact, and equally worth saying.
    //
    // No distances go to the model. Catch positions are post-fight photo locations carrying a few
    // hundred metres of drift, so a count within the search radius is the honest resolution --
    // "in this pocket", not "on this line".
    yourHistory: c.support
      ? { catchesWithin300m: c.support.n, thisSpecies: c.support.speciesN,
          sameSeason: c.support.seasonN, lastCaught: c.support.lastDate,
          note: 'positions are post-fight photo locations, accurate to a few hundred metres' }
      : undefined,
  };
}
