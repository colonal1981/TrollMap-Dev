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
    const best = deepestUsable(curve, minM);
    if (!best) continue;
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
