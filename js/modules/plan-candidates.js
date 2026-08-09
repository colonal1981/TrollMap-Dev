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

/** Mean of a polygon's outer ring. Good enough for a boathouse; these are metres across. */
function ringCentroid(g) {
  const ring = g.type === 'Polygon' ? g.coordinates[0]
    : g.type === 'MultiPolygon' ? g.coordinates[0] && g.coordinates[0][0] : null;
  if (!Array.isArray(ring) || !ring.length) return [null, null];
  let x = 0, y = 0, n = 0;
  for (const c of ring) {
    if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    x += c[0]; y += c[1]; n++;
  }
  return n ? [x / n, y / n] : [null, null];
}

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
  } else if (kind === 'dock_line' || kind === 'dock_cluster' || kind === 'dock') {
    bits.push(kind === 'dock_line' ? 'line of docks'
      : kind === 'dock_cluster' ? 'cluster of docks' : 'dock');
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
      if (!g || !Array.isArray(g.coordinates)) continue;
      const p = f.properties || {};
      // `layer` is how docks.geojson names itself; it carries no kind, no type and no id.
      const kind = p.kind || p.type || (p.layer === 'docks' ? 'dock' : null);
      if (!kind) continue;
      // Docks are POLYGONS. Everything else in the packs is a point, so reduce to a centroid
      // rather than adding polygon maths the rest of this file would never use.
      const [lon, lat] = g.type === 'Point' ? g.coordinates : ringCentroid(g);
      if (lon === null) continue;
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

// ---------------------------------------------------------------------------------------------
// WEIGHTS COME FROM trollingIntelligence. THIS TABLE IS THE FALLBACK, AND IT IS MEASURED.
//
// Corrected 2026-08-08 after Ryan: "i already answered how to weight each of the types of
// structure... this should have already been in the build docs... did you even build it to spec?"
// He had, it was, and I had not.
//
// TROLLING_RUNS_THE_LINE_WAS_ALWAYS_THERE_2026-08-06.md is explicit on both counts. On where the
// score belongs: "There is deliberately no score. Whether six stands of flooded timber beat nine
// humps depends on the species, the season and where the forage is, and that judgement lives in
// the app's trollingIntelligence, not in a pipeline script." Putting a constant table in the app
// instead is the same mistake moved one file over.
//
// And on the ranking itself, counted from Wateree's own trollingIntelligence across 11 species
// and 4 seasons — 104 structure citations:
//
//     brush / wood / stumps          27 cites, 5 species
//     river channel / channel edge   12 cites, 7 species
//     points                         11 cites, 6 species
//     docks                          10 cites, 4 species
//     creek mouths                   10 cites, 6 species
//     flats                           8 cites, 6 species
//     ledges                          4 cites, 2 species
//     humps                           3 cites, 3 species
//
// My first table put HUMPS TOP at 3 and flats at 0, described in a comment as "navigational
// marks, not targets". The measurement says humps are last, 3 of 104, and flats are cited by more
// species than anything but the channel edge. The doc says it in one line: "Humps and ledges — the
// whole of structure.geojson — are 7 of 104. The layer answers a question the intel is barely
// asking." Every candidate ranking produced before this commit was ordered by that inversion.
//
// These numbers are the citation counts, used directly. They are a measurement, not a taste, so
// there is nothing to tune — if the ranking should change, recount it on more lakes.
//
// TWO KNOWN GAPS, both visible rather than papered over:
//   - DOCKS are 10 cites across 4 species and are NOT in `near[]`. docks.geojson exists and the
//     pipeline never joins it to the runs. Until it does, no weight here can reach them.
//   - `hazard` stays 0. Hazard marks are things to avoid; that is not a citation ranking, it is
//     the one place where "not a target" is the right reading.
// ---------------------------------------------------------------------------------------------
export const DEFAULT_WEIGHTS = {
  timber: 27,          // brush / wood / stumps — the most-cited thing on the lake
  attractor: 27,       // DNR brushpiles are the same ask; Garmin's timber outnumbers them 14:1
  point: 11,
  creek_mouth: 10,
  // Docks are 10 cites across 4 species. Grouped rather than counted -- see groupDocks().
  dock_line: 10,       // a stretch to run a bait down
  dock_cluster: 10,    // a pocket to stop and cast at
  dock: 4,             // a lone dock. Real, but not the ask -- the ask is a line or a pocket.
  shallow: 8,          // flats. Cited by six species. NOT a navigational mark.
  ledge: 4,
  hump: 3,
  pile: 3,             // counted within brush/wood; scarce, so it keeps its own low weight
  bridge: 3,
  cove: 8,             // coves are how creek arms and flats present on this lake
  hazard: 0,           // things to steer around, not fish
};

// `relief` is a property of the whole run, not a feature it passes, so it is scored once per leg
// rather than per hit. It carries the SECOND most-cited thing in the table above — river channel
// and channel edge, 12 cites across 7 species, more species than anything else — and until now
// nothing scored it at all.
export const DEFAULT_RELIEF_WEIGHTS = {
  channel_edge: 12,
  break: 6,
  flat: 8,
  steep_bank: 4,
};

/**
 * Score one window of a run by what it passes.
 *
 * Deliberately NOT normalised by length: a 4 km leg passing eight humps is better water than a
 * 1 km leg passing two, and the caller is already spending battery per metre. Dividing by length
 * would make a 200 m stub with one hump outrank a real trolling pass.
 */
// A LEG CANNOT BE TWENTY TIMES BETTER FOR HAVING TWENTY TIMES THE DOCKS.
//
// Wateree carries 2,796 docks. Scored one for one they returned 1,560 passes across twelve
// candidates and 191 on a single leg, so any dock-lined shoreline outscored everything else on
// the lake by an order of magnitude and nothing else could move the ranking.
//
// This is the same failure TROLLING_RUNS_THE_LINE_WAS_ALWAYS_THERE recorded for ledges --
// "Ledges ran 36-55 on every single leg, which is the discrimination problem in one line" -- and
// the pipeline solved it by collapsing them to a count. Docks need their positions kept, because
// a dock is a legitimate cast target, so the SCORE is capped instead of the list.
//
// SUPERSEDED FOR DOCKS by clustering -- see groupDocks(). Kept as a general backstop, because any
// type that ever arrives listed rather than summarised would swamp the ranking the same way.
const SCORE_CAP_PER_TYPE = 8;

function scoreWindow(near, fromM, toM, weights, maxOffM, capPerType = SCORE_CAP_PER_TYPE) {
  let score = 0;
  const hits = [];
  const counted = {};
  for (const n of near) {
    if (n.s < fromM || n.s > toM) continue;
    if (n.d > maxOffM) continue;
    const w = weights[n.t] ?? 0;
    if (!w) continue;
    // Something 20 m off the line is worth more than the same thing 95 m off it.
    const proximity = 1 - (n.d / maxOffM) * 0.5;
    counted[n.t] = (counted[n.t] || 0) + 1;
    if (counted[n.t] <= capPerType) score += w * proximity;
    // The hit is kept either way: it is still a place to stop, it just stops adding to the score.
    hits.push({ atM: Math.round(n.s - fromM), type: n.t, offM: n.d, weight: w,
                n: n.n, spanM: n.spanM, scored: counted[n.t] <= capPerType });
  }
  return { score, hits };
}

// ---------------------------------------------------------------------------------------------
// DOCKS ARE 10 CITATIONS ACROSS 4 SPECIES AND THE PIPELINE NEVER JOINED THEM.
//
// Ryan, 2026-08-08: "docks should definitely be factored in, especially for largemouth bass."
//
// TROLLING_RUNS_THE_LINE_WAS_ALWAYS_THERE puts docks fourth in the citation count, above creek
// mouths, flats, ledges and humps. `docks.geojson` ships in every pack — 2,796 polygons on
// Wateree — and `build_trolling_runs.py` does not join it to the runs, so `near[]` has no dock
// entry and no weight in the app could ever reach one.
//
// The right long-term fix is in the pipeline, beside the joins that produced `near` in the first
// place. Doing it there means re-running across 1,566 packs and re-uploading them, so until that
// happens this joins docks to a run in the app, in exactly the `near` shape, and everything
// downstream — scoring, passes, stops — treats them like any other feature.
//
// WHEN THE PIPELINE EMITS DOCKS, DELETE THIS. Two implementations of the same join will drift,
// which is the reason build_trolling_runs.py refuses to re-derive hump-versus-basin.
// ---------------------------------------------------------------------------------------------

/** A shallow copy of a run with extra `near` entries merged in, leaving the original alone. */
function withNear(run, extra) {
  return { ...run, properties: { ...run.properties, near: [...(run.properties.near || []), ...extra] } };
}

function dockHits(coords, cum, index, maxOffM) {
  if (!index || !index.grid) return [];
  const out = [];
  const seen = new Set();
  const cell = RESOLVE_CELL;
  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];
    const cx = Math.floor(lon / cell), cy = Math.floor(lat / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const r of (index.grid.get(`${cx + dx},${cy + dy}`) || [])) {
          if (r.kind !== 'dock') continue;
          const key = `${r.lon},${r.lat}`;
          if (seen.has(key)) continue;
          seen.add(key);
          // Nearest point on the RUN, not the nearest vertex -- a dock beside a long straight
          // segment would otherwise measure to whichever end happened to be closer.
          let best = Infinity, bestAt = 0;
          for (let k = 0; k < coords.length - 1; k++) {
            const d = pointToSegmentM([r.lon, r.lat], coords[k], coords[k + 1]);
            if (d < best) { best = d; bestAt = cum[k]; }
          }
          if (best <= maxOffM) out.push({ s: bestAt, t: 'dock', d: best });
        }
      }
    }
  }
  return groupDocks(out);
}

// ---------------------------------------------------------------------------------------------
// A DOCK ON ITS OWN IS NOISE. A LINE OF THEM IS A TROLL, A CLUSTER IS A CAST.
//
// Ryan, 2026-08-08: "do them as clusters... or a long line of them... that would be great to
// troll past... cluster to cast at... that sort of thing."
//
// Scoring 2,796 individual docks was wrong in a way a cap only softened: it treated a dock as a
// unit of value, so a leg with 191 of them read as 191 times better than a leg with one. What
// actually differs is the SHAPE. Docks strung along 600 m of residential shoreline are water to
// troll past with a crankbait; eight packed into a pocket are somewhere to stop and cast.
//
// So docks are grouped along the run and each group becomes ONE feature with a type that says
// which it is. Everything downstream — scoring, the model's structure list, stops — then reads a
// dock line and a dock cluster as the different things they are.
//
// The numbers are shoreline geometry, not tuning knobs: residential docks sit 30-60 m apart, so
// a gap over 120 m is a break between groups rather than a wider berth. 250 m is about where a
// row of docks stops being a spot and starts being a stretch you would run a bait down.
// ---------------------------------------------------------------------------------------------

const DOCK_GAP_M = 120;
const DOCK_LINE_M = 250;
const DOCK_LINE_MIN = 4;

export function groupDocks(hits) {
  if (!hits.length) return [];
  const sorted = [...hits].sort((a, b) => a.s - b.s);
  const groups = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].s - cur[cur.length - 1].s <= DOCK_GAP_M) cur.push(sorted[i]);
    else { groups.push(cur); cur = [sorted[i]]; }
  }
  groups.push(cur);

  return groups.map((g) => {
    const span = g[g.length - 1].s - g[0].s;
    const d = Math.min(...g.map((x) => x.d));
    // Three shapes, not two. A single dock that grouped with nothing is not a cluster -- calling
    // it "a cluster of 1 dock" is how a plan starts sounding like it is padding.
    const kind = span >= DOCK_LINE_M && g.length >= DOCK_LINE_MIN ? 'dock_line'
      : g.length > 1 ? 'dock_cluster' : 'dock';
    return {
      // A line is placed at its start, because that is where you begin running it. A cluster or a
      // single dock is placed at its middle, because that is what you are stopping on.
      s: kind === 'dock_line' ? g[0].s : (g[0].s + g[g.length - 1].s) / 2,
      t: kind,
      d,
      n: g.length,
      spanM: Math.round(span),
    };
  });
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
    reliefWeights: o.reliefWeights || DEFAULT_RELIEF_WEIGHTS,
  };
  const trollMph = o.trollMph ?? 2.0;
  const transitMph = o.transitMph ?? 3.5;
  // THIS NUMBER IS A GUESS AND IT NEEDS RYAN'S EYE.
  //
  // It is the distance from the ramp at which a leg is worth HALF what the identical leg would be
  // worth right off the ramp: `proximity = 1 / (1 + fromRampM / rampBiasM)`. At 4 km (2.5 mi) a
  // leg is worth half, at 1 km about four fifths, at 8 km a third. Nothing measured it -- it is
  // set where it is because 2.5 miles is the range at which he stopped describing water as
  // "near the ramp" in the on-the-water notes, and because it puts the Colonel Creek cove (about
  // 4 miles from Clearwater Cove) at a third of its face value rather than at zero.
  //
  // What it is NOT is a feasibility filter -- those are the usableAh and windowMin checks below
  // and they still cut hard. This is a preference, and it must stay one: if the best water on
  // the lake genuinely is four miles away it should still be offered, just outranked by good
  // water nearby. Raise it to flatten the preference, lower it to sharpen it, and if the plans
  // start hugging the ramp when they should not, that is this number.
  const rampBiasM = o.rampBiasM ?? 4000;
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

    // Docks join here rather than in the pipeline -- see dockHits(). Merged into `near` before
    // the window slides, so a dock counts toward WHICH window is chosen, not just what the chosen
    // one happens to contain.
    const docks = o.docks ? dockHits(coords, cumulative(coords), o.docks, opts.maxOffM) : [];
    const win = bestWindow(docks.length ? withNear(run, docks) : run, opts);
    if (!win) continue;
    // Relief is a property of the whole run, so it is added once rather than per hit. River
    // channel and channel edge are 12 cites across 7 species -- more species than anything else
    // in the count -- and nothing scored them until 2026-08-08.
    const reliefScore = opts.reliefWeights[p.relief] || 0;
    win.score += reliefScore;
    if (win.score <= 0) continue;

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
    // HOW FAR THIS WATER IS FROM THE RAMP HE PICKED. The nearer end, because a leg can be run in
    // either direction and what matters is how far out the water is, not which way the contour
    // happens to be drawn.
    const fromRampM = Math.min(inM, outM);
    const proximity = 1 / (1 + fromRampM / rampBiasM);
    const fishAh = ampHours(win.lengthM, trollMph);
    const moveAh = ampHours(inM + outM, transitMph);
    const totalAh = fishAh + moveAh;
    const totalMin = minutesFor(win.lengthM, trollMph) + minutesFor(inM + outM, transitMph);

    // Reachable means: fish this one thing and get home, inside the day. A plan chains several,
    // so this is a ceiling on what is worth offering, not a promise the whole set fits.
    if (o.usableAh && totalAh > o.usableAh) continue;
    if (o.windowMin && totalMin > o.windowMin) continue;

    out.push({
      // THE PACK'S OWN ID WHEN IT HAS ONE, the array index only as a fallback.
      //
      // This used to be index-based unconditionally, with a note saying it breaks whenever the
      // pipeline reruns because build_trolling_runs.py emits no stable id. fit_trolling_runs.py
      // now writes one, and it has to: fitting SPLITS a run into passes where the lake turns too
      // hard to tow through, so a re-fit changes what every later index means and silently
      // repoints every saved plan at different water. A pack without ids still works exactly as
      // before -- it just keeps the old fragility until it is refitted.
      runId: p.id || `${o.slug || 'run'}#${i}`,
      runIndex: i,
      startM: Math.round(win.startM), lengthM: Math.round(win.lengthM),
      depthFt: p.depth_ft, wholeRun: win.whole,
      start, end, coordinates: line,
      transitInM: Math.round(inM), transitOutM: Math.round(outM),
      fromRampM: Math.round(fromRampM),
      proximity: Number(proximity.toFixed(3)),
      batteryAh: Number((fishAh + moveAh).toFixed(2)),
      estMin: Math.round(totalMin),
      score: Number(win.score.toFixed(1)),
      reliefScore,
      // Rank on structure passed, discounted by how much of the trip is deadhead, and again by
      // how far the water is from the ramp he actually launched at.
      //
      // NOT score/Ah. That was the first version and it ranked 500 m stubs top of the list,
      // because a stub costs almost nothing and any per-cost ratio therefore loves it. The
      // question is not "cheapest per point", it is "most fishing for a day, with the travel
      // taxed" -- so discount by the transit share instead of dividing by total cost.
      //
      // The transit share alone was not enough, and the plan he took out proves it: launched at
      // Clearwater Cove, sent across the lake to the cove beside Colonel Creek ramp. "why would i
      // launch at clearwater cove and then go fish the opposite side of the lake in the cove
      // where colonel creek boat ramp is????" The transit share is a RATIO -- a long leg has a
      // large fishAh, which dilutes the deadhead in the denominator, so an 8 km leg four miles
      // out is barely taxed while a 2 km leg four miles out is taxed hard. Distance from the ramp
      // is not a property of the leg's length and should not be scaled by it.
      value: Number((win.score / (1 + moveAh / Math.max(0.1, fishAh)) * proximity).toFixed(2)),
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
            what: s ? s.what
              : h.type === 'dock_line' ? `line of ${h.n} docks over ${h.spanM} m — run a bait down it`
              : h.type === 'dock_cluster' ? `cluster of ${h.n} docks — worth stopping on`
              : h.type === 'dock' ? 'a single dock'
              : h.type.replace(/_/g, ' '),
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
  //
  // COMPARING START POINTS IS NOT ENOUGH, and the plan he took out on 2026-08-09 is the proof:
  //
  //     L1 · 23 ft    runs WEST from -80.7337 to -80.7856
  //     L2 · 25.9 ft  starts at -80.7666 and runs EAST back through -80.7337
  //
  // Roughly half of L2 retraces L1's water in the opposite direction, two feet deeper. Their
  // START points are 2.7 km apart, so the distance rule waved it through -- a start-point test
  // cannot see an overlap, only a coincidence. Ryan: "from what i can tell the 2 routes fish
  // almost the exact same water." Two legs on one shoreline a few feet apart are one leg.
  //
  // So the geometry is compared as well: a candidate that spends more than `dedupeOverlap` of
  // its length inside a corridor around a candidate already kept is the same water and is
  // dropped. Both directions, because a short leg swallowed by a long one and a long leg that
  // swallows a short one are the same duplicate seen from either end.
  //
  // BOTH NUMBERS BELOW ARE ESTIMATES FROM THAT ONE MEASURED CASE. 100 m is wider than the gap
  // between two contours a few feet apart on a reservoir bank and narrower than the width of an
  // arm, so opposite banks of a creek stay two legs. 0.35 catches "about half of it retraces"
  // while letting two legs that merely cross stand. Both are options; if plans start losing water
  // that is genuinely separate, widen the overlap threshold before touching the corridor.
  const apart = o.dedupeM ?? 1200;
  const corridorM = o.dedupeCorridorM ?? 100;
  const maxOverlap = o.dedupeOverlap ?? 0.35;
  const kept = [];
  for (const c of out) {
    const duplicate = kept.some((k) =>
      metresBetween(k.start, c.start) < apart
      || overlapFraction(c.coordinates, k.coordinates, corridorM) >= maxOverlap
      || overlapFraction(k.coordinates, c.coordinates, corridorM) >= maxOverlap);
    if (!duplicate) kept.push(c);
    if (o.limit && kept.length >= o.limit) break;
  }

  // ── WHAT IT COSTS TO GO FROM THIS LEG TO THE NEXT ONE ────────────────────────────────────────
  //
  // Every number on a candidate up to this point describes the candidate ALONE: its structure,
  // its length, its distance from the ramp. Nothing here or anywhere downstream costed the gap
  // BETWEEN two legs, and PLAN_SCHEMA_V2 gives the ordering to the model -- so the model was
  // being asked to order a day while being shown nothing about what the ordering costs.
  //
  // The plan Ryan took out on 2026-08-09 is what that produces. Measured off it: totalM 28040,
  // fishingM 15250, transitM 12790 -- 46% of the day deadheading. L1 was `wateree_lake#27` and
  // L2 was `wateree_lake#34`, each a fine leg near Clearwater Cove on its own merits, and about
  // six miles from each other. T2 between them was 9687 m, 103 minutes and 22.97 Ah: 43% of the
  // day's whole 54.02 Ah budget spent on one leg with nothing in the water.
  //
  // So the matrix goes to the model, because the model owns the order. `transitToM[runId]` is
  // metres from THIS leg's end to THAT leg's start -- directional, because that is exactly what
  // the assembler will travel: it trolls each candidate start → end and transits between them.
  // `transitToRampM` closes the day, since the route home is a real leg now and its cost is the
  // ordering's too.
  //
  // Only over `kept`, so the keys are exactly the candidates the model is shown and it can never
  // be handed a distance to a leg it may not choose. n <= o.limit (12 in the app), so this is at
  // most ~144 calls of an already-cheap function.
  for (const a of kept) {
    const to = {};
    for (const b of kept) {
      if (b.runId === a.runId) continue;
      to[b.runId] = Math.round(transitM(a.end, b.start));
    }
    a.transitToM = to;
  }
  return kept;
}

/**
 * How much of `line` runs inside a corridor `corridorM` wide around `other`, as a fraction of
 * `line`'s length. Direction-blind on purpose: a contour run east and the same contour run west
 * are the same water.
 *
 * Sampled at even intervals rather than tested vertex by vertex, because the two lines come off
 * different contours and their vertices do not correspond -- a vertex test would report the
 * density of the source geometry, not the overlap.
 *
 * @param {number[][]} line      [lon, lat] the line being judged
 * @param {number[][]} other     [lon, lat] the line it might be duplicating
 * @param {number}     corridorM half-width of the corridor, metres
 * @param {number}     samples   points along `line` to test
 */
export function overlapFraction(line, other, corridorM = 100, samples = 25) {
  if (!Array.isArray(line) || line.length < 2) return 0;
  if (!Array.isArray(other) || other.length < 2) return 0;

  // Cheap rejection first: boxes that do not touch cannot overlap, and most pairs do not touch.
  // The padding is degrees, deliberately generous -- it only decides whether to do the real work.
  const box = (l) => l.reduce((a, p) => [Math.min(a[0], p[0]), Math.min(a[1], p[1]),
                                         Math.max(a[2], p[0]), Math.max(a[3], p[1])],
                              [Infinity, Infinity, -Infinity, -Infinity]);
  const A = box(line), B = box(other);
  const pad = corridorM / 85000;
  if (A[0] > B[2] + pad || B[0] > A[2] + pad || A[1] > B[3] + pad || B[1] > A[3] + pad) return 0;

  const cum = cumulative(line);
  const total = cum[cum.length - 1];
  if (!(total > 0)) return 0;

  let inside = 0;
  for (let i = 0; i < samples; i++) {
    const p = pointAt(line, cum, (total * (i + 0.5)) / samples);
    let best = Infinity;
    for (let k = 1; k < other.length; k++) {
      const d = pointToSegmentM(p, other[k - 1], other[k]);
      if (d < best) best = d;
      if (best <= corridorM) break;
    }
    if (best <= corridorM) inside++;
  }
  return inside / samples;
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
    // WHAT THE ORDERING COSTS. `transitToM` is metres of deadhead from the END of this leg to the
    // START of each other leg it could be followed by; `transitToRampM` is metres from the end of
    // this leg back to the launch, which the day pays once. The model owns the order
    // (PLAN_SCHEMA_V2, "MODEL DECIDES: which runId, in which order"), so the model is the thing
    // that has to see these -- see selectCandidates() for what happens when it does not.
    transitToM: c.transitToM || undefined,
    transitToRampM: c.transitOutM,
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
