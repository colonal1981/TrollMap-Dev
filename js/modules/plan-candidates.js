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
 * Slide a window along one run and keep the best placement.
 * Runs shorter than `minM` are offered whole rather than discarded — a 400 m pass over a hump
 * is a legitimate thing to fish, it just is not a whole leg on its own.
 */
function bestWindow(run, opts) {
  const p = run.properties || {};
  const total = p.length_m || 0;
  const near = p.near || [];
  const { targetM, minM, stepM, weights, maxOffM } = opts;

  if (total <= targetM) {
    if (total < minM) return null;
    const { score, hits } = scoreWindow(near, 0, total, weights, maxOffM);
    return { startM: 0, lengthM: total, score, hits, whole: true };
  }
  let best = null;
  for (let s = 0; s + targetM <= total; s += stepM) {
    const { score, hits } = scoreWindow(near, s, s + targetM, weights, maxOffM);
    if (!best || score > best.score) best = { startM: s, lengthM: targetM, score, hits, whole: false };
  }
  return best;
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
    targetM: o.targetM ?? 4000,
    // A LEG IS A TROLLING PASS, NOT A STUB. First cut allowed 400 m and every candidate came
    // back a 500 m fragment, because short runs cost almost no battery and any per-Ah ranking
    // rewards that hardest. A pass you would actually set two rods for is over a kilometre.
    minM: o.minM ?? 1500,
    stepM: o.stepM ?? 250,
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
      start, end,
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
      passes: win.hits.sort((a, b) => a.atM - b.atM),
      // Present only when the caller supplied a journal. Never affects `value` -- see catchSupport().
      support: o.catches
        ? catchSupport(sliceLine(coords, cum, win.startM, win.startM + win.lengthM), o.catches,
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

/** Trim a candidate to what the model needs to choose. Geometry stays server-side. */
export function forModel(c) {
  const counts = {};
  for (const h of c.passes) counts[h.type] = (counts[h.type] || 0) + 1;
  return {
    runId: c.runId,
    depthFt: c.depthFt,
    lengthM: c.lengthM,
    transitFromRampM: c.transitInM,
    batteryAh: c.batteryAh,
    estMin: c.estMin,
    passes: counts,
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
