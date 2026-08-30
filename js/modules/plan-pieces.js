/**
 * plan-pieces.js — turning charted lanes into the water a fisherman actually chooses from.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT A PIECE IS, AND WHY IT IS NOT A CONTOUR
 *
 * Ryan, 2026-08-10, after three days of arguing about how long a trolling leg should be:
 *
 *   > the point is to follow somewhere in say a 14-18ft zone... its not exact science... its not
 *   > an algorythm... the line doesn't have to perfectly follow anything
 *
 * and on why a lane ever ends:
 *
 *   > for tight coves you just draw a straight line past them because for trolling it isn't worth
 *   > going back into the cove because no matter what you are pulling your lines out to get back out
 *
 * That second one is the whole rule, and it is the only one this module needs:
 *
 *          A ROUTE IS A STRETCH OF WATER YOU CAN FISH WITHOUT TOUCHING THE RODS.
 *
 * No turn hard enough to tangle a spread. No shallow spot that snags a bait. No depth change that
 * would force a change of lead. It is not a length, not a threshold and not a contour — it is the
 * thing he actually experiences, and it ends exactly where he would reach for a rod anyway.
 *
 * Everything that used to decide this — `--min-leg-m`, the depth-band split, the length floor —
 * is gone. They were build-time constants standing in for a decision that depends on which bait is
 * on the rod, which depends on which fish, which depends on the day. See
 * claude/WHAT_SMARTPLAN_IS_2026-08-09.md and claude/THE_FISHERMAN_CHOOSES_2026-08-10.md.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ONE NUMBER EVERYTHING READS
 *
 * `envelope_ft` on every fitted pass: the SHALLOWEST water within 25 m either side of the line,
 * every 40 m along it. Stamped by fit_trolling_runs.py (commit fe37479) because he cannot hold a
 * line and never claimed to:
 *
 *   > remember i do not have gps steering... i am going to be weaving between those lines no
 *   > matter what we decide
 *
 * The gap between that and the old centreline depth is not academic. Measured across 5,977 Wateree
 * passes, the centreline overstates the shallowest water by a median of 3.9 ft, by more than 5 ft
 * on 42% of passes, and by up to 47 ft. That is the difference between a bait that clears and a
 * bait on the bottom, and every routing decision before 2026-08-11 used the wrong one.
 *
 * `-1` in that array means uncharted. It is NOT zero and NOT "probably deep" — treating it as
 * either has cost two bugs in the pipeline already, and it costs one here too if you forget.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE DOES NOT DO
 *
 * It does not decide anything. It reports what each piece of water OFFERS — how much unbroken
 * water at each depth you might want to fish — and the app decides which of those offers suits the
 * day, the species and the lure that is actually tied on. Clearance is a required argument for
 * exactly that reason: how much water a bait needs under it is a fishing judgement and there is no
 * defensible default.
 */

/** Metres per degree, matching the pipeline's own projection. Do not "improve" these. */
const M_PER_DEG_LAT = 110540.0;
const m_per_deg_lon = (lat) => 111320.0 * Math.cos((lat * Math.PI) / 180);

/** Flat projection to metres, good over a lake and consistent with fit_trolling_runs.py. */
function project(coords, lat0) {
  const kx = m_per_deg_lon(lat0);
  return coords.map((c) => [c[0] * kx, c[1] * M_PER_DEG_LAT]);
}

const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * HOW MUCH UNBROKEN WATER THIS LANE OFFERS AT EACH DEPTH.
 *
 * The heart of it, and it is deliberately simple: walk the envelope, and a station is usable if
 * the shallowest water within reach is deeper than the bait plus its clearance. The answer is the
 * LONGEST RUN OF CONSECUTIVE USABLE STATIONS — not the total, and not a percentage.
 *
 * Ryan, on being shown a lane that was 54% fishable in six fragments:
 *
 *   > 54% fishable for a route is not fishable at all honestly
 *
 * He is right, and it is the reason this returns one number per depth rather than a coverage
 * figure. Six broken pieces are six excuses to reset the spread; one continuous stretch is a pass.
 *
 * UNCHARTED BREAKS THE RUN. A -1 station is not deep enough and not shallow enough — it is
 * unknown, and trolling a bait through water nobody sounded on the strength of an assumption is
 * how you lose it. Unknown ends the stretch, same as a shoal.
 *
 * @param {number[]} envelope   shallowest ft within the wander envelope, -1 = uncharted
 * @param {number}   stepM      spacing of those samples along the pass
 * @param {number[]} depths     bait depths to test, ft
 * @param {number}   clearFt    water wanted UNDER the bait — a fishing judgement, no default
 * @returns {Map<number,{lengthM:number, from:number, to:number}>} only depths that offer anything
 */
export function reachCurve(envelope, stepM, depths, clearFt) {
  const out = new Map();
  if (!Array.isArray(envelope) || envelope.length < 2 || !(stepM > 0)) return out;
  if (!Number.isFinite(clearFt)) {
    throw new Error('reachCurve: clearFt is required — how much water a bait needs under it is a '
                  + 'fishing judgement and this module does not get to invent one');
  }
  for (const ft of depths) {
    const need = ft + clearFt;
    let best = 0, bi = 0, bj = 0, i = 0;
    while (i < envelope.length) {
      if (!(envelope[i] >= need)) { i++; continue; }   // -1 and NaN both fail this, on purpose
      let j = i;
      while (j + 1 < envelope.length && envelope[j + 1] >= need) j++;
      const len = (j - i) * stepM;
      if (len > best) { best = len; bi = i; bj = j; }
      i = j + 1;
    }
    if (best > 0) out.set(ft, { lengthM: Math.round(best), from: bi, to: bj });
  }
  return out;
}

/**
 * The deepest bait this lane will carry for at least `minM` without a break.
 *
 * This is the single most useful summary of a piece of water, and it is the question a fisherman
 * actually asks: not "how deep is it" but "how deep can I fish it and still make a pass". On
 * Wateree the two answers routinely differ by a mile — a contour stitched at 25.9 ft carries a
 * 40 ft bait, one stitched at 17.1 ft carries 26.
 *
 * @returns {?{depthFt:number, lengthM:number, from:number, to:number}}
 */
export function deepestUsable(curve, minM) {
  let best = null;
  for (const [ft, v] of curve) {
    if (v.lengthM >= minM && (!best || ft > best.depthFt)) best = { depthFt: ft, ...v };
  }
  return best;
}

/** The stretch of a lane's geometry between two envelope stations, as [lon,lat] pairs. */
export function stretchCoords(coords, stepM, from, to) {
  const a = from * stepM, b = to * stepM;
  const out = [];
  let acc = 0;
  for (let i = 0; i < coords.length; i++) {
    if (i) {
      const p = coords[i - 1], q = coords[i];
      const lat = (p[1] + q[1]) / 2;
      acc += Math.hypot((q[0] - p[0]) * m_per_deg_lon(lat), (q[1] - p[1]) * M_PER_DEG_LAT);
    }
    if (acc >= a && acc <= b) out.push(coords[i]);
  }
  return out.length >= 2 ? out : coords.slice(0, 2);
}

/**
 * WHAT IS UNDER THE BOAT ON THIS STRETCH.
 *
 * Ryan, 2026-08-30, after being shown that a "lane" sits a median 29-51 m off the contour it is
 * named for, and up to 224 m:
 *
 *   > a contour is 1 singular depth... so you can't be using the same countor????
 *
 * and, when told the fitted path is deliberately not a contour:
 *
 *   > the lane used to be a singular contour but it made for very short very curved and
 *   > unfollowable lines... your second thought is more honest... it runs from 25-32 ft median 29
 *   > shallowest is 25ft deepest is 32 allows me to know that the lure depth that is chosen is
 *   > right or wrong
 *
 * That is the whole specification, and it is a DESCRIPTION fix rather than a geometry one. The
 * fitting is doing its job -- it smooths a contour into something a kayak can actually follow --
 * and the label was the part that lied about it. "The 26.9 ft line" names a contour the boat is
 * never on; 25-32 median 29 names the water it is over, which is the number a lure depth is
 * judged against.
 *
 * MEASURED ON THIS STRETCH, NOT THE WHOLE LANE. The pack stamps `depth_ft`, `shallowest_ft` and
 * `shallowest_line_ft` for the pass end to end, and a piece is a TRIM of that pass -- reachCurve
 * cuts it at the first station a bait cannot clear. Across Wateree's 70 pieces the trimmed
 * shallowest sits a median 1 ft, and up to 8 ft, deeper than the whole-lane figure, and 41 of the
 * 70 differ at all. wateree_lake#157 is the case that names the problem: the pack says the pass
 * touches 8 ft, the piece the app actually offers never comes above 45. Sizing a bait off the
 * whole lane condemns baits over water that is not on the leg -- the same fault as "The 6 ft
 * line", pointed the other way.
 *
 * THE LINE AND THE SHALLOW SIDE ARE BOTH RETURNED and they answer different questions.
 * `line` is the chart under the centreline: what he is over, and what a lure depth is judged
 * against. `side` is the shallowest within the wander: what can take a bait off. Nothing here
 * picks between them -- see plan-from-water.js for which one becomes the ceiling and why.
 *
 * @param {object} props   a fitted pass's properties, carrying `envelope_line_ft`/`envelope_ft`
 * @param {number} fromM   start of the stretch, metres along the pass
 * @param {number} toM     end of it
 * @returns {?{line:{minFt,medianFt,maxFt}, side:{minFt,medianFt,maxFt}}}
 */
export function waterBand(props, fromM, toM) {
  const step = props && props.envelope_step_m;
  const line = props && props.envelope_line_ft;
  const side = props && props.envelope_ft;
  if (!(step > 0) || !Array.isArray(line) || !Array.isArray(side)) return null;
  const n = Math.min(line.length, side.length);
  const a = Math.max(0, Math.min(n - 1, Math.floor(fromM / step)));
  const b = Math.max(a, Math.min(n - 1, Math.ceil(toM / step)));
  const l = spread(line.slice(a, b + 1)), s = spread(side.slice(a, b + 1));
  return l && s ? { line: l, side: s } : null;
}

/**
 * Min, median and max of one profile, in the units the pack stamped: whole feet.
 *
 * -1 IS DROPPED, NOT COUNTED AS ZERO. It means nobody sounded that station, and a station nobody
 * sounded cannot make the water shallower than it is -- the run has already been cut at uncharted
 * water by reachCurve, so anything left here is a hole in the survey rather than a hole in the
 * lake.
 *
 * The median is the LOWER middle on an even count. No interpolation: the pack rounds every probe
 * to the foot (`int(round(x))` in fit_trolling_runs.py), so a half-foot median would be precision
 * this never measured.
 */
function spread(vals) {
  const v = vals.filter((d) => Number.isFinite(d) && d >= 0).sort((x, y) => x - y);
  if (!v.length) return null;
  return { minFt: v[0], medianFt: v[(v.length - 1) >> 1], maxFt: v[v.length - 1] };
}

/**
 * HOW HARD THIS PACK'S OWN LANES TURN.
 *
 * Ryan, on a plan whose legs did not connect: "it has 2 sharp v shaped turns when all it needs is
 * a straight line between the 2", and "the trolling runs don't really make sense... they are
 * still too short and stubby and do not link where they should".
 *
 * Joining two pieces means steering from the end of one to the start of the next, and a turn hard
 * enough to tangle a spread is not a join. What counts as too hard is NOT a number to pick: the
 * fitting has already answered it. fit_trolling_runs.py smooths a stitched contour into a line a
 * kayak can tow a spread along, so the sharpest bend it is willing to leave INSIDE a lane is this
 * pack's own definition of followable. Measured on Wateree: median 0.1 deg per 80 m of travel,
 * p99 19.3, worst 42.4.
 *
 * Per pack, computed from the lanes in hand, so it tightens on its own if the fitting improves.
 *
 * @param {object[]} lanes   the same features buildPieces() was given
 * @param {number}   stepM   the sampling interval; the envelope step, so the two agree
 * @returns {number} degrees per 80 m of travel
 */
export function followBar(lanes, stepM = 40) {
  let bar = 0;
  for (const f of (lanes || [])) {
    if (!f || !f.properties || !f.properties.fitted) continue;
    const c = f.geometry && f.geometry.coordinates;
    if (!Array.isArray(c) || c.length < 3) continue;
    let acc = 0;
    const pts = [c[0]];
    for (let i = 1; i < c.length; i++) {
      acc += metresBetween(c[i - 1], c[i]);
      if (acc >= stepM) { pts.push(c[i]); acc = 0; }
    }
    for (let i = 2; i < pts.length; i++) {
      const d = metresBetween(pts[i - 2], pts[i - 1]) + metresBetween(pts[i - 1], pts[i]);
      if (!(d > 0)) continue;
      const r = turnBetween(bearingOf(pts[i - 2], pts[i - 1]), bearingOf(pts[i - 1], pts[i]))
              * (80 / d);
      if (r > bar) bar = r;
    }
  }
  return bar;
}

const metresBetween = (a, b) => Math.hypot((a[0] - b[0]) * m_per_deg_lon((a[1] + b[1]) / 2),
                                           (a[1] - b[1]) * M_PER_DEG_LAT);
const bearingOf = (a, b) => (Math.atan2((b[0] - a[0]) * m_per_deg_lon((a[1] + b[1]) / 2),
                                        (b[1] - a[1]) * M_PER_DEG_LAT) * 180 / Math.PI + 360) % 360;
const turnBetween = (x, y) => { const d = Math.abs(x - y) % 360; return d > 180 ? 360 - d : d; };

/**
 * WHERE TWO PIECES ARE ONE RUN.
 *
 * Ryan, looking at three legs the app had drawn across water he fishes as one line:
 *
 *   > blue and purple to me are pretty much one line / see how i routed around that shallow spot
 *   > and combined the 2 lines... that is how i would fish that
 *
 * A piece ends where reachCurve ran out of water for the bait, not where the fishing ends. Often
 * the next piece starts a few hundred metres on, on the same heading, over the same kind of
 * bottom. Measured on Wateree: 103 pairs of piece-ends sit within his own `minM` of each other on
 * a heading inside the pack's follow bar, and 57 of the 70 pieces have at least one.
 *
 * WHAT MAKES A JOIN, AND WHERE EACH RULE COMES FROM
 *
 *   the turn      the pack's own sharpest fitted bend -- see followBar(). Not a chosen angle.
 *   the gap       no longer than `minM`, HIS number for the day. A stretch of water longer than
 *                 the shortest thing he would call a pass is not a seam between two passes.
 *   the bait      one bait, unbroken, the whole way. His rule, given 2026-08-30 when asked
 *                 whether a depth change across a join makes it two runs: "One run only if one
 *                 bait covers it." So the joined profile goes through the same reachCurve that
 *                 judges a single lane -- A's stations, the gap's, then B's.
 *
 * AND NOTHING HERE DECIDES WHAT "OPEN WATER" IS, because there is no such thing. Ryan, when I
 * called a 249 m gap over 41 ft of flat bottom open water:
 *
 *   > when fish are suspended there is no such thing as open water... if fish are hugging bottom
 *   > or i am fishing for catfish that hug bottom then that might mean something... so the
 *   > fisherman's answer is that it depends
 *
 * It depends on `holding`, which is researched per lake and per season and is not this module's
 * business. So `depths` -- the bait depths worth testing -- comes IN, exactly as it does for
 * buildPieces(), and the caller supplies the band the fish are actually in. A join reports the
 * deepest of those that runs the whole thing, plus the floor beneath it so a bottom-relating day
 * can see how far the floor moves and judge whether one lure tracks it. Measured on Wateree, the
 * floor moves a median 17 ft across a joined run, which is why joining is mostly a suspended
 * tool -- but that is a fact about the water, reported, not a rule applied here.
 *
 * @param {object[]} pieces      buildPieces() output
 * @param {object}   o
 * @param {function} o.depthAt   ([lon,lat]) -> ft, or null where nobody sounded it. The pack's
 *                               depth_areas sampler -- see depthSampler() in plan-water-index.js.
 * @param {number}   o.clearFt   water wanted under the bait. REQUIRED, same as buildPieces().
 * @param {number}   o.bar       degrees per 80 m from followBar()
 * @param {number}   [o.minM]    longest gap that is a seam rather than a stretch of water
 * @param {number[]} [o.depths]  bait depths worth testing -- THE FISH BAND, from the caller
 * @param {number}   [o.envelopeM] half-width of the wander, to match the pack's own envelope
 * @returns {object[]} one entry per joinable pair, both directions collapsed into one
 */
export function joinsFor(pieces, o) {
  const depthAt = o && o.depthAt;
  const clearFt = o && o.clearFt;
  const bar = o && o.bar;
  if (typeof depthAt !== 'function') throw new Error('joinsFor: depthAt is required');
  if (!Number.isFinite(clearFt)) throw new Error('joinsFor: clearFt is required');
  if (!Number.isFinite(bar)) throw new Error('joinsFor: bar is required — see followBar()');
  const minM = (o && o.minM) ?? 600;
  const envM = (o && o.envelopeM) ?? 25;
  const depths = (o && o.depths) || Array.from({ length: 18 }, (_, i) => 6 + i * 2);

  // Two ends per piece, each with the heading it is travelling AS IT LEAVES.
  const ends = [];
  (pieces || []).forEach((p, i) => {
    const c = p && p.coords;
    if (!Array.isArray(c) || c.length < 3 || !Array.isArray(p.envelope)) return;
    const n = c.length;
    ends.push({ i, side: 0, at: c[0], out: bearingOf(c[Math.min(3, n - 1)], c[0]) });
    ends.push({ i, side: 1, at: c[n - 1], out: bearingOf(c[Math.max(0, n - 4)], c[n - 1]) });
  });

  const out = [];
  for (let a = 0; a < ends.length; a++) {
    for (let b = a + 1; b < ends.length; b++) {
      const A = ends[a], B = ends[b];
      if (A.i === B.i) continue;
      const gapM = metresBetween(A.at, B.at);
      if (!(gapM >= 1) || gapM > minM) continue;
      // THE TURN IS AT THE JUNCTION, NOT SPREAD OVER THE GAP. Dividing the angle by the gap's
      // length was the first cut and it is wrong in the direction that matters: a 90 deg change
      // met at the end of a 2 km straight line is still a 90 deg corner, and dividing it down
      // made every long gap pass. The boat turns where the lane meets the gap, so the angle at
      // each junction is compared against the bar directly.
      const g = bearingOf(A.at, B.at);
      const turn = Math.max(turnBetween(A.out, g), turnBetween(g, (B.out + 180) % 360));
      if (turn > bar) continue;

      const pa = pieces[A.i], pb = pieces[B.i];
      const step = pa.envelopeStepM || 40;
      const gap = gapProfile(A.at, B.at, step, envM, depthAt);
      if (!gap) continue;                       // nobody sounded any of it -- not a claim to make
      const ea = A.side === 0 ? pa.envelope.slice().reverse() : pa.envelope.slice();
      const eb = B.side === 0 ? pb.envelope.slice() : pb.envelope.slice().reverse();
      const joined = ea.concat(gap.shallow, eb);
      const lengthM = (joined.length - 1) * step;
      const curve = reachCurve(joined, step, depths, clearFt);
      let baitFt = null;
      for (const [ft, v] of curve) {
        // The whole stretch, not the longest part of it: a join that needs the rods touched
        // halfway is two runs, which is what he said when asked.
        if (v.lengthM >= lengthM - step && (baitFt === null || ft > baitFt)) baitFt = ft;
      }
      if (baitFt === null) continue;

      out.push({
        // Only the depths that run the WHOLE joined stretch. A curve quoting the longest
        // fragment would read like a promise about the run and be about half of it.
        offers: [...curve.entries()]
          .filter(([, v]) => v.lengthM >= lengthM - step)
          .sort((x, y) => x[0] - y[0])
          .map(([ft, v]) => ({ depthFt: ft, lengthM: v.lengthM })),
        from: A.i, fromRunId: pa.runId, fromEnd: A.side ? 'end' : 'start',
        to: B.i, toRunId: pb.runId, toEnd: B.side ? 'end' : 'start',
        gapM: Math.round(gapM),
        turnDeg: Number(turn.toFixed(1)),
        lengthM,
        baitFt,
        // The floor under the whole joined run. A suspended day does not care; a bottom-relating
        // one cares about nothing else, because a lure holds one depth and this is how far the
        // bottom moves out from under it.
        floorFt: spread(joined),
        gapCoords: gap.coords,
        // Everything joinedPiece() needs to build the run without sounding the gap twice.
        _gap: gap, _step: step, _sideA: A.side, _sideB: B.side,
      });
    }
  }
  out.sort((x, y) => y.lengthM - x.lengthM);
  return out;
}

/**
 * A JOIN, TAKEN. Two pieces and the water between them, as ONE PIECE.
 *
 * It returns the same shape buildPieces() does, and that is the whole design. `legFrom()`,
 * `waterBand()`, `optionality()`, `depthCues()`, the strip chart and the GPX all read a piece;
 * none of them should have to learn what a join is. A joined run is not a new kind of thing, it
 * is a longer piece of water, which is exactly what Ryan said it was: "blue and purple to me are
 * pretty much one line".
 *
 * WHAT IS MEASURED AND WHAT IS INHERITED
 *
 * The profiles, the length, the offer curve and the band are all recomputed from the joined
 * stations -- they are properties of the run and the run is new. `chartedFrac` is recomputed too,
 * because the gap is water the pipeline never surveyed for a lane and the fraction has to include
 * it or it describes something else.
 *
 * `relief` is kept ONLY when both halves agree. A channel edge joined to a flat is not a channel
 * edge, and naming it one would put a reason on the card that is true of half the run.
 * `duplicates` takes the smaller of the two: "eight charted contours run through this water" has
 * to hold for the whole run to be said about the whole run.
 *
 * @param {object[]} pieces  the array joinsFor() was given -- `from` and `to` index into it
 * @param {object}   join    one entry from joinsFor()
 * @returns {object} a piece
 */
export function joinedPiece(pieces, join) {
  const a = pieces[join.from], b = pieces[join.to];
  const step = join._step, gap = join._gap;
  if (!a || !b || !gap || !(step > 0)) return null;
  // Orient each half so the two meet at the gap: a piece joined at its START is travelled
  // backwards, and its profiles have to turn round with its geometry or every station lands on
  // the wrong water -- the same fault that put a shoal warning on a leg trimmed to avoid it.
  const flipA = join._sideA === 0, flipB = join._sideB === 1;
  const take = (arr, flip) => (Array.isArray(arr) ? (flip ? arr.slice().reverse() : arr.slice())
                                                  : null);
  const chain = (x, mid, y) => (x && y ? x.concat(mid, y) : null);

  const coords = take(a.coords, flipA).concat(gap.coords, take(b.coords, flipB));
  const envelope = chain(take(a.envelope, flipA), gap.shallow, take(b.envelope, flipB));
  const envelopeLine = chain(take(a.envelopeLine, flipA), gap.line, take(b.envelopeLine, flipB));
  const envelopeDeep = chain(take(a.envelopeDeep, flipA), gap.deep, take(b.envelopeDeep, flipB));
  const lengthM = (envelope.length - 1) * step;

  return {
    // TRACEABLE TO BOTH HALVES. Every warning, every cue and every saved plan names a run by this,
    // so a joined run has to say which two it is -- "wateree_lake#256+wateree_lake#218" is
    // findable on the card and in the pack; a fresh id would not be.
    runId: `${a.runId}+${b.runId}`,
    joinedFrom: [a.runId, b.runId],
    holdsFt: join.baitFt,
    lengthM,
    gapM: join.gapM,
    turnDeg: join.turnDeg,
    // THE CURVE IS THE ROW, same as it is for a single piece -- what going deeper costs in
    // unbroken water. Computed in joinsFor(), which is where the clearance he chose for the day
    // lives; recomputing it here would need that number passed in twice.
    offers: join.offers,
    water: bandOf(envelopeLine, envelope),
    envelope,
    envelopeLine,
    envelopeDeep,
    envelopeStepM: step,
    envelopeM: a.envelopeM ?? b.envelopeM ?? null,
    // THE SMALLER OF THE TWO, NOT A RECOUNT. Recomputing it from the joined stations always
    // returns 1 -- reachCurve breaks a run on an uncharted station, so neither half nor the gap
    // can contain one -- and a field that is always 1 would quietly overwrite the real thing.
    // `charted_frac` is a property of the PASS a piece was cut from; see reasons() in
    // plan-water.js for what it is allowed to say. A claim about the whole run has to hold for
    // both halves, so the weaker one wins.
    chartedFrac: Math.min(a.chartedFrac ?? 1, b.chartedFrac ?? 1),
    relief: a.relief && a.relief === b.relief ? a.relief : null,
    near: [...(a.near || []), ...(b.near || [])],
    duplicates: Math.min(a.duplicates || 1, b.duplicates || 1),
    coords,
    fullCoords: coords,
    // The nearest point of the union is the nearer of the two, and the gap lies between them.
    rampM: mergeRampM(a.rampM, b.rampM),
  };
}

/** waterBand()'s answer, from profiles already in hand rather than from a pass's properties. */
function bandOf(line, side) {
  const l = spread(line || []), s = spread(side || []);
  return l && s ? { line: l, side: s } : null;
}

function mergeRampM(x, y) {
  if (!x && !y) return undefined;
  const out = { ...(y || {}) };
  for (const [k, v] of Object.entries(x || {})) out[k] = k in out ? Math.min(out[k], v) : v;
  return out;
}

/**
 * The shallowest water within the wander, every `stepM` across a gap, in the shape the pack
 * stamps for a lane -- seven probes across, the shallowest wins, -1 where nobody sounded it.
 *
 * Matching `envelope_ft`'s definition matters: the result is concatenated with two real envelopes
 * and handed to reachCurve, which cannot tell them apart and must not have to.
 */
function gapProfile(a, b, stepM, envM, depthAt) {
  const d = metresBetween(a, b);
  const n = Math.max(1, Math.round(d / stepM));
  const brg = bearingOf(a, b) * Math.PI / 180;
  const nx = Math.cos(brg), ny = -Math.sin(brg);          // unit normal, metres
  const shallow = [], line = [], deep = [], coords = [];
  let charted = 0;
  for (let s = 1; s < n; s++) {
    const x = a[0] + (b[0] - a[0]) * s / n;
    const y = a[1] + (b[1] - a[1]) * s / n;
    coords.push([x, y]);
    // THREE PROFILES OUT OF ONE SWEEP, the same three fit_trolling_runs.py stamps on a lane:
    // shallowest within the wander (what can take a bait off), the centreline (what he is over)
    // and the deep side (how much depth the wander buys). A joined run is handed to readers that
    // expect all three, and a gap that carried only one would leave the strip chart and
    // waterBand() with a hole in the middle of the run.
    let sh = null, mid = null, dp = null;
    for (let k = -3; k <= 3; k++) {
      const off = (k * envM) / 3;
      const z = depthAt([x + (nx * off) / m_per_deg_lon(y), y + (ny * off) / M_PER_DEG_LAT]);
      if (z == null) continue;
      if (k === 0) mid = z;
      if (sh === null || z < sh) sh = z;
      if (dp === null || z > dp) dp = z;
    }
    if (sh === null) { shallow.push(-1); line.push(-1); deep.push(-1); }
    else { shallow.push(sh); line.push(mid == null ? -1 : mid); deep.push(dp); charted++; }
  }
  return (n <= 1 || charted > 0) ? { shallow, line, deep, coords } : null;
}

/**
 * HOW FAR THE WATER RUNS from a point on a bearing, capped at `capM`.
 *
 * `inWater` is waterMask(), not depthSampler(): this asks water-versus-land and nothing else, and
 * the exact sampler costs about sixty microseconds a lookup because the depth bands nest twenty-
 * five deep. The mask agrees with it on that question 99.94% of the time over 20,000 points along
 * Wateree's lanes, and is two thousand times faster. It returns a boolean so it cannot be
 * mistaken for a depth -- 10.6% of its cells are 2 ft or more off the true band, which is fine
 * for "is this lake" and nowhere near good enough to size a bait with.
 */
function waterRun(pt, inWater, deg, capM = 1000, stepM = 40) {
  const th = (deg * Math.PI) / 180, dx = Math.sin(th), dy = Math.cos(th);
  for (let m = stepM; m <= capM; m += stepM) {
    if (!inWater([pt[0] + (dx * m) / m_per_deg_lon(pt[1]), pt[1] + (dy * m) / M_PER_DEG_LAT])) {
      return m - stepM;
    }
  }
  return capM;
}

/**
 * DOES THIS END POINT INTO A DEAD END.
 *
 * Ryan, on Leg 2 of a Wateree day: "the orange lane needs to either keep going past that cove it
 * turns into or just stop", and earlier, on the same shape: "i would never turn into the cove
 * just to end the trolling run... no matter what you are pulling your lines out to get back out."
 *
 * Measured at that leg's exact end, 34.371333/-80.722038: the water runs 160 m along the heading
 * it is travelling and 1,000 m straight back the way it came. Every bearing from 203 to 270
 * degrees hits the cap; everything else dies inside 360 m. It is in a pocket that opens only
 * behind it.
 *
 * DIRECTIONAL, AND THE FIRST VERSION OF THIS WAS NOT. That one asked whether water was closing in
 * on ALL sides within 240 m, which is a question about a small pond rather than a cove: a real
 * cove mouth is wider than that, so it missed this leg entirely, while flagging ordinary water
 * often enough to cost 12.6 miles and 11 pieces to fix a single bad end. The honest question is
 * narrower -- ahead of you the lake dies, behind you it opens -- and it cannot fire on a lane
 * running along a shore, because open water behind is the normal case. On Wateree it picks 19 of
 * 200 piece ends where the median end has the full 1,000 m ahead of it.
 */
function pointsIntoADeadEnd(coords, i, inWater, forward, baseM = 120) {
  const n = coords.length;
  // THE HEADING NEEDS A BASELINE IN METRES, NOT IN VERTICES. Four vertices of a stitched contour
  // can be four metres, and a heading taken over four metres is noise -- it swings with every
  // wiggle in the chart line and the fan then points somewhere the boat is not going.
  let j = i, acc = 0;
  while (acc < baseM) {
    const k = forward ? j - 1 : j + 1;
    if (k < 0 || k > n - 1) break;
    acc += metresBetween(coords[j], coords[k]);
    j = k;
  }
  const a = coords[j], b = coords[i];
  if (!a || !b || (a[0] === b[0] && a[1] === b[1])) return false;
  const head = (Math.atan2((b[0] - a[0]) * m_per_deg_lon((a[1] + b[1]) / 2),
                           (b[1] - a[1]) * M_PER_DEG_LAT) * 180) / Math.PI;
  // AHEAD IS THE BEST WAY ON, BEHIND IS THE WAY HE CAME. Two different questions, so two
  // different reductions, and taking the median of both was wrong on each count.
  //
  // Ahead: is there ANY way onward. One open bearing in the forward arc is a way out of here, so
  // the arc's maximum is the answer -- a median said "mostly blocked ahead" about a mouth with a
  // perfectly good exit through it.
  //
  // Behind: he came down the lane, so the way back is the lane, not an arc around it. Straight
  // astern is the exact question and a fan around it just measures how wide the cove is -- which
  // made the rule quieter the deeper into a cove the lane ran, i.e. exactly where it should be
  // loudest.
  const ahead = Math.max(...[-45, -22.5, 0, 22.5, 45]
    .map((d) => waterRun(b, inWater, (head + d + 720) % 360)));
  const astern = waterRun(b, inWater, (head + 180 + 720) % 360);
  // A RATIO, BECAUSE THE ABSOLUTE METRES DEPEND ON THE LAKE AND THE RATIO DOES NOT.
  //
  // Measured across 168 of Wateree's piece ends, astern divided by the best way forward:
  //
  //     p50 1.0    p75 1.0    p90 1.0    p95 1.4    max 3.1
  //     2x or worse: 4 ends.  3x: 2.
  //
  // Nine ends in ten have the way on exactly as good as the way back, which is what open water
  // looks like. Leg 2 -- the one Ryan drew -- measures 400 m ahead against 1,000 m astern, 2.5x.
  // Anything from about 1.5 to 2.5 picks out the same handful, which is the mark of a real gap
  // rather than a knob: the population is not spread across the range, it is piled at 1.0 with
  // four outliers.
  //
  // The astern floor stops it firing on noise in a pond, where 40 m ahead and 120 m behind is 3x
  // and means nothing.
  // `ahead === 0` IS THE STRONGEST CASE, NOT AN EXCLUDED ONE. This read `ahead > 0` to dodge a
  // divide by zero, and so silently exempted the one shape it exists to catch: an end with no
  // water in front of it at all.
  if (!(astern >= 600)) return false;
  return ahead === 0 || astern / ahead >= 2;
}

/**
 * WALK A DEAD-END HOOK OFF THE END OF A PIECE.
 *
 * Returns the station the piece should stop at. It never eats more than half: past that this is
 * not a hook on the end of a pass, it is a pass that lives up a cove, and that is a thing to say
 * rather than to trim away.
 *
 * WHAT HAPPENS NEXT IS ALREADY BUILT. Ryan, asked whether a trimmed lane should just end short or
 * carry on: "if there is something to join to it should pick it up... yes". Pulling the end back
 * to the bend puts it in open water, which is exactly where joinsFor() can see across to the next
 * lane -- so the carrying-on is the join machinery doing its job, not a second mechanism.
 */
function trimDeadEnd(coords, inWater, from, to, stepM) {
  // BOTH ENDS, because a lane that STARTS up a cove is the same mistake facing the other way --
  // he would have to get into the pocket before he could begin. Returns { from, to }.
  if (typeof inWater !== 'function' || to - from < 4) return to;
  // A STATION IS AN ARC LENGTH, NOT A FRACTION OF THE VERTEX LIST, and the first cut used the
  // fraction. stretchCoords() cuts the geometry at `station * stepM` metres along the lane; a
  // lane whose vertices are unevenly spaced -- which is all of them, they are stitched contours
  // -- puts the two in different places. The walk was therefore testing a point the trim would
  // not actually cut at, and stopped after a single station on wateree_lake#362 while its end
  // was still a dead end.
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + metresBetween(coords[i - 1], coords[i]));
  }
  const at = (station) => {
    const want = station * stepM;
    let lo = 0, hi = coords.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < want) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  const half = Math.ceil((to - from) / 2);
  let t = to, h = from;
  if (pointsIntoADeadEnd(coords, at(to), inWater, true)) {
    const floor = from + half;
    while (t > floor) {
      t -= 1;
      if (!pointsIntoADeadEnd(coords, at(t), inWater, true)) break;
    }
  }
  if (pointsIntoADeadEnd(coords, at(from), inWater, false)) {
    const ceiling = to - half;
    while (h < ceiling) {
      h += 1;
      if (!pointsIntoADeadEnd(coords, at(h), inWater, false)) break;
    }
  }
  // Never both to the point of meeting: if each end wants half, this lane lives in a pocket and
  // that is water rather than a mistake.
  return (t - h) >= half ? { from: h, to: t } : { from, to };
}

/**
 * COLLAPSE THE DUPLICATES.
 *
 * Contours nest. Around one Wateree shoreline there are eighty-two of them, and by his own
 * measure they are not eighty-two lanes:
 *
 *   > i agree with you about the 14-18ft lines being basically the same route... to me they are
 *   > the same route
 *
 * Two stretches are the same water when one spends most of its length inside the other's swath.
 * The swath is 2 x the envelope half-width — if he wanders 25 m either side of both lines, lines
 * 50 m apart put the boat in the same place. So the threshold is DERIVED from the envelope rather
 * than picked, and it changes if his wander ever does.
 *
 * How much this matters is entirely lake-shaped, which is why it cannot be a constant: on Wateree
 * it removes 73% of the rows, on Monticello 82%, on Moultrie only 34%. Flat open water barely
 * nests; a steep river shoreline nests enormously.
 *
 * The survivor of a group is the one that carries the DEEPEST bait, ties broken by length —
 * because that is the member that offers the most, and every other member is a subset of the same
 * water offering less.
 */
function collapse(entries, swathM) {
  const cell = Math.max(30, swathM);
  const grid = new Map();
  const key = (p) => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
  entries.forEach((e, n) => {
    for (let i = 0; i < e.xy.length; i += 2) {
      const k = key(e.xy[i]);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(n);
    }
  });
  const parent = entries.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  const frac = (A, B) => {
    let hit = 0, n = 0;
    for (let i = 0; i < A.length; i += 2) {
      n++;
      let d = Infinity;
      for (const q of B) { const t = dist2(A[i], q); if (t < d) d = t; }
      if (d <= swathM) hit++;
    }
    return n ? hit / n : 0;
  };
  const seen = new Set();
  entries.forEach((e, n) => {
    const cand = new Set();
    for (let i = 0; i < e.xy.length; i += 2) {
      const [gx, gy] = key(e.xy[i]).split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const m of grid.get(`${gx + dx},${gy + dy}`) || []) cand.add(m);
        }
      }
    }
    for (const m of cand) {
      if (m <= n) continue;
      const kk = `${n}:${m}`;
      if (seen.has(kk)) continue;
      seen.add(kk);
      if (frac(e.xy, entries[m].xy) > 0.6 || frac(entries[m].xy, e.xy) > 0.6) union(n, m);
    }
  });
  const groups = new Map();
  entries.forEach((_, n) => {
    const r = find(n);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(n);
  });
  return [...groups.values()];
}

/**
 * Lanes in, pieces of water out.
 *
 * @param {object[]} lanes   features from trolling_runs.geojson; only `fitted` ones with an
 *                           `envelope_ft` are considered — anything else has not been measured
 *                           against a boat that wanders and cannot be judged.
 * @param {object}   o
 * @param {number}   o.clearFt   water wanted under the bait. REQUIRED — see reachCurve.
 * @param {number}   [o.minM]    how long a pass has to be to count as one. This is HIS number for
 *                               the day, not a constant: "if i want to spend the day doing cast
 *                               and stops on tiny contours i should be able to do that".
 * @param {number[]} [o.depths]  bait depths to test
 * @param {object[]} [o.ramps]   [{name, lonLat}] to measure from
 * @returns {{pieces:object[], laneCount:number, usableCount:number}}
 */
export function buildPieces(lanes, o) {
  const clearFt = o && o.clearFt;
  const minM = (o && o.minM) ?? 600;
  const depths = (o && o.depths) || Array.from({ length: 18 }, (_, i) => 6 + i * 2);
  // OPTIONAL AND SILENT WHEN ABSENT. Without it a dead-end hook cannot be seen, and inferring
  // where the land is from the contours would be a guess. See trimDeadEnd().
  const inWater = (o && o.inWater) || null;

  const usable = (lanes || []).filter(
    (f) => f && f.properties && f.properties.fitted && Array.isArray(f.properties.envelope_ft),
  );
  if (!usable.length) return { pieces: [], laneCount: (lanes || []).length, usableCount: 0 };

  // One projection origin for the whole lake, as the pipeline does, so metres are comparable.
  let latSum = 0, latN = 0;
  for (const f of usable) {
    const c = f.geometry.coordinates;
    latSum += c[0][1] + c[c.length - 1][1];
    latN += 2;
  }
  const lat0 = latSum / latN;

  const entries = [];
  for (const f of usable) {
    const p = f.properties;
    const step = p.envelope_step_m || 40;
    const curve = reachCurve(p.envelope_ft, step, depths, clearFt);
    if (!curve.size) continue;
    // NO FALLBACK. A lane that cannot give `minM` at ANY depth is not a short piece of water, it
    // is not a piece of water at all — and `minM` is HIS number for the day, not a constant, so
    // wanting the short stuff means lowering it rather than having this quietly admit fragments.
    //
    // The first cut did have a fallback, and it is worth saying what it cost: 3,539 entries
    // instead of ~900, and the extra ones were all stubs. Stubs chain. Two stubs 40 m apart merge,
    // that pair reaches a third, and the union walks the shoreline — one Wateree group came back
    // holding 981 members, which is not a piece of water, it is most of the lake.
    let best = deepestUsable(curve, minM);
    if (!best) continue;
    // A HOOK INTO A DEAD END IS NOT PART OF THE PASS. reachCurve trims where the water runs out
    // for the BAIT; it has no idea the last stretch turns into a pocket he would have to pull the
    // rods to get out of. See trimDeadEnd().
    const cut = trimDeadEnd(f.geometry.coordinates, inWater, best.from, best.to, step);
    if (cut.from > best.from || cut.to < best.to) {
      best = { ...best, from: cut.from, to: cut.to, lengthM: (cut.to - cut.from) * step };
      if (best.lengthM < minM) continue;   // what is left is not a pass by his own measure
    }
    const coords = stretchCoords(f.geometry.coordinates, step, best.from, best.to);
    entries.push({
      runId: p.id || null,
      // THE PROFILE TRAVELS WITH THE PIECE, and until 2026-08-11 it did not.
      //
      // A row can say "0.55 mi at 25 ft" and still leave him blind to WHERE the shallow bit is,
      // which hump is under the baits and which is in them. The strip view needs the raw envelope
      // and optionality() needs both its sides; both are already measured, and carrying them costs
      // a few hundred numbers and saves a round trip to the pack.
      //
      // These were dropped here, silently. plan-pieces.test.js asserts holdsFt, offers, duplicates
      // and rampM and none of them touch the envelope, so 15 tests passed over a module that
      // threw it away -- and the strip chart drew nothing while optionality() reported every
      // corridor as "undefined-undefined ft, 0 ft span". Found by running the whole chain on a
      // real pack and reading the sentences it produced.
      // SLICED TO THE PIECE, BECAUSE `coords` IS. Station 0 of these arrays used to be station 0
      // of the whole PASS while the geometry beside them started wherever reachCurve cut it, and
      // 56 of Wateree's 70 pieces start past station 0. Everything that walks the array against
      // the line was therefore reading the wrong place on it:
      //
      //   depthCues() puts a cue at `i * stepM` into the leg. On #123 -- a 3.0 km piece that
      //   begins 360 m along a 3.5 km pass -- the shallowest station on the pass is 3 ft at 40 m,
      //   so the phone announced "3 ft in 27 m, the shallowest water on this leg" 13 m into a leg
      //   whose own shallowest is 18 ft. A shoal warning for water the boat never goes near, on
      //   the leg it was trimmed to avoid.
      //
      //   the strip chart in the Water tab drew the whole pass under a row describing the piece.
      //
      //   optionality() took its corridor medians across stations outside the piece.
      //
      // The whole pass is still on the piece as `fullCoords` for anything that wants the lane.
      envelope: p.envelope_ft.slice(best.from, best.to + 1),
      // Deep side and centreline. `deep` minus `envelope` is how much depth 25 m of wander buys:
      // narrow means relaxed water, wide means a steep edge that wants steering. `line` is what
      // the chart says about the centreline, kept ONLY so the gap between it and the shallow side
      // stays visible -- nothing should ever decide on it.
      envelopeDeep: p.envelope_deep_ft ? p.envelope_deep_ft.slice(best.from, best.to + 1) : null,
      envelopeLine: p.envelope_line_ft ? p.envelope_line_ft.slice(best.from, best.to + 1) : null,
      envelopeStepM: step,
      envelopeM: p.envelope_m ?? null,
      // THE WATER THIS PIECE IS ACTUALLY OVER, measured on the stations it was trimmed to. It
      // replaces `depth_ft`, `shallowest_ft` and `shallowest_line_ft` -- three whole-lane numbers
      // that were standing in for a piece-local one. See waterBand().
      water: waterBand(p, best.from * step, best.to * step),
      chartedFrac: p.charted_frac ?? null,
      relief: p.relief ?? null,
      near: p.near || [],
      holdsFt: best.depthFt,
      lengthM: best.lengthM,
      curve,
      coords,
      xy: project(coords, lat0),
      full: f.geometry.coordinates,
    });
  }

  const swath = 2 * ((usable[0].properties.envelope_m) || 25);
  const groups = collapse(entries, swath);

  const pieces = groups.map((g) => {
    const members = g.map((i) => entries[i]);
    const win = members.reduce((a, b) => (b.holdsFt > a.holdsFt
      || (b.holdsFt === a.holdsFt && b.lengthM > a.lengthM) ? b : a));
    // THE CURVE IS THE ROW. Not a depth and a length — the whole trade, so he can read what
    // going deeper costs him in unbroken water and pick the point on it that suits the day.
    const offers = [...win.curve.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ft, v]) => ({ depthFt: ft, lengthM: v.lengthM }));
    const out = {
      runId: win.runId,
      holdsFt: win.holdsFt,
      lengthM: win.lengthM,
      offers,
      water: win.water,
      chartedFrac: win.chartedFrac,
      relief: win.relief,
      near: win.near,
      envelope: win.envelope,
      envelopeDeep: win.envelopeDeep,
      envelopeLine: win.envelopeLine,
      envelopeStepM: win.envelopeStepM,
      envelopeM: win.envelopeM,
      coords: win.coords,
      fullCoords: win.full,
      duplicates: members.length,
    };
    if (o && Array.isArray(o.ramps) && o.ramps.length) {
      out.rampM = {};
      for (const r of o.ramps) {
        const rp = project([r.lonLat], lat0)[0];
        let best = Infinity;
        for (const p of win.xy) { const d = dist2(p, rp); if (d < best) best = d; }
        out.rampM[r.name] = Math.round(best);
      }
    }
    return out;
  });

  pieces.sort((a, b) => b.lengthM - a.lengthM);
  return { pieces, laneCount: (lanes || []).length, usableCount: entries.length };
}
