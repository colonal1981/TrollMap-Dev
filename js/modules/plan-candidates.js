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

// ONE MEASUREMENT, BOTH PLANNERS. plan-pieces.js owns what the envelope profiles mean and how a
// stretch of one is summarised; Smart Plan reads the same function rather than growing its own
// answer to the same question. Nothing else crosses between the two files.
import { waterBand } from './plan-pieces.js';

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

/**
 * WHICH WAY ROUND EACH PASS GETS TROLLED.
 *
 * Ryan, 2026-08-09, on a day that fished 4.7 km and drove 7.3, of which 6.3 was the single run
 * home: "the distance trolling is significantly less than the time transiting in this plan".
 *
 * A trolling pass is fishable in BOTH directions — it is a depth contour, not a one-way street —
 * and until now the direction was whichever way the geometry happened to have been stitched in
 * the pack. selectCandidates() already knew that and ranked with `Math.min(inM, outM)`, saying so
 * in as many words; the assembler then ignored it and always ran start → end. So an artefact of
 * how a contour was drawn decided where the day ended, and one day ended four miles from the ramp.
 *
 * THE ORDER STAYS THE MODEL'S. It is a fishing call — light, time of day, which water fishes when
 * — and it is not this function's business. The DIRECTION is fishing-neutral travel arithmetic,
 * so the app takes it. That is the same split PLAN_SCHEMA_V2 draws everywhere else: judgement to
 * the model, computation to the app.
 *
 * It is solved exactly rather than greedily. With the order fixed, each leg has two states and
 * the cost of a state depends only on the one before it, so this is a two-row shortest path and
 * the optimum falls out in 4n comparisons — cheaper than the greedy lookahead it replaces and
 * with no case where a locally cheap flip strands the day. The run home is part of the chain,
 * because it is a real leg now and it was the expensive one.
 *
 * STRAIGHT-LINE DISTANCE ON PURPOSE, never the water router. This has to reproduce identically in
 * prefetchTransits() — which decides which pairs to ask the router for — and in assemblePlan(),
 * which walks them. Two callers, one answer, no network in between: if the router were consulted
 * here the two could disagree and every flipped leg would fall back to an unrouted straight line.
 *
 * FISHED BACK. A leg carrying `trollPasses: n` is trolled n times, turning at each end, so it
 * ends where it started when n is even. The chain is solved over that: the hop into the next leg
 * is priced from `finish`, not from the end of the first pass. A leg without the field is fished
 * once and behaves exactly as it always has.
 *
 * @param {{start:number[], end:number[], trollPasses?:number}[]} candidates  IN THE MODEL'S ORDER
 * @param {number[]} launch                              [lon, lat] of the ramp
 * @returns {{flipped:boolean, start:number[], end:number[], passes:number, finish:number[]}[]}
 *          one per candidate, in order. `start`/`end` are the FIRST pass's ends; `finish` is where
 *          the boat stands when every pass is done.
 */
export function orientLegs(candidates, launch) {
  const legs = Array.isArray(candidates) ? candidates : [];
  const n = legs.length;
  if (!n) return [];
  // A candidate with an end missing cannot be costed and must not throw. Treating the hop as free
  // leaves it where it was drawn, which is exactly the old behaviour for exactly that leg.
  const hop = (a, b) => (Array.isArray(a) && Array.isArray(b) ? metresBetween(a, b) : 0);
  // HOW MANY TIMES THIS PASS IS FISHED, which decides which end the boat leaves from.
  //
  // Ryan, 2026-08-31, looking at a Colonel Creek plan with seven legs and eight transits between
  // them: "its because they have no concept of running back the other direction... there should
  // be almost no deadheading there". Measured off that plan's own GPX: L1 finished at the head of
  // the cove, the plan then paid 499 m of deadhead to reach L2's far end, and L2 ran back to
  // finish 77 m from where L1 had ended. The boat crossed the same water three times and fished
  // it once.
  //
  // A pass fished an EVEN number of times ends where it started; an odd number ends at the far
  // end. That parity is the whole of it, and it is what this function has to know: the hop to the
  // next leg is measured from where the boat actually stands, not from the end of one pass. Absent
  // or malformed means one pass, which is what every caller did before this existed.
  // WHOLE PASSES ONLY, and never by truncation. `Math.trunc(1.5)` is a finite 1, which would have
  // turned "fish it one and a half times" into a silent single pass -- the model asking for
  // something impossible and the app quietly agreeing. There is no half pass; anything that is not
  // a whole number of them is not a pass count, and one is what this leg has always been.
  const laps = (i) => {
    const n = Number(legs[i] && legs[i].trollPasses);
    return Number.isInteger(n) && n >= 1 ? n : 1;
  };
  // [ where it starts if forward, where it ends if forward ]. Reversed swaps the two.
  const enter = (i, o) => (o ? legs[i].end : legs[i].start);
  const leave = (i, o) => (laps(i) % 2 ? (o ? legs[i].start : legs[i].end) : enter(i, o));

  const cost = [], from = [];
  for (let i = 0; i < n; i++) { cost.push([Infinity, Infinity]); from.push([0, 0]); }
  for (let o = 0; o < 2; o++) cost[0][o] = hop(launch, enter(0, o));
  for (let i = 1; i < n; i++) {
    for (let o = 0; o < 2; o++) {
      for (let p = 0; p < 2; p++) {
        const t = cost[i - 1][p] + hop(leave(i - 1, p), enter(i, o));
        if (t < cost[i][o]) { cost[i][o] = t; from[i][o] = p; }
      }
    }
  }
  let best = 0, bestCost = Infinity;
  for (let o = 0; o < 2; o++) {
    const t = cost[n - 1][o] + hop(leave(n - 1, o), launch);
    if (t < bestCost) { bestCost = t; best = o; }
  }
  // Ties go to the drawn direction: `<` never displaces an equal-cost forward state, so a plan
  // does not sprout `trolledReversed` flags that buy nothing.
  const chosen = new Array(n);
  for (let i = n - 1; i >= 0; i--) { chosen[i] = best; best = from[i][best]; }
  return legs.map((c, i) => {
    const flipped = chosen[i] === 1;
    const start = flipped ? c.end : c.start;
    const end = flipped ? c.start : c.end;
    // `start` and `end` are the FIRST pass's two ends and have never meant anything else, so the
    // assembler's leg geometry and prefetchTransits' first pair are untouched by pass counts.
    // `finish` is where the boat stands when the leg is done — the only new thing — and it equals
    // `end` on every leg fished once, which is every leg that existed before `trollPasses` did.
    const passes = laps(i);
    return { flipped, start, end, passes, finish: passes % 2 ? end : start };
  });
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

// ── The four kinds that had marks and no position ────────────────────────────────────────────
//
// Measured on wateree_lake, 2026-08-13: of 11,616 `near[]` marks, 1,998 — SEVENTEEN PERCENT —
// are of a kind that exists in neither structure.geojson nor water_features.geojson. timber 654,
// hazard 697, shallow 398, attractor 162, pile 65, bridge 22. `timber` and `attractor` carry the
// two highest weights in DEFAULT_WEIGHTS, 27 each, because they are the most-cited things on the
// lake. Every one of them resolved to an estimate with a null depth, and the comment above this
// one has said so since 08-07: "timber, attractor, bridge, pile: 0 of 48."
//
// They were never missing. They are in `pois.geojson`, which no planner fetched.
//
// THIS TABLE IS COPIED FROM THE PRODUCER, NOT INVENTED HERE. build_trolling_runs.py's POI_KINDS
// is what turned those points into marks in the first place, keyed the same way — `name`, then
// `class`, then a poi_type containing 'timber'. Resolving against a DIFFERENT table than the one
// that made the marks is how a hit gets snapped to a thing that is not what the pipeline saw.
// If that table changes, this one changes with it.
export const POI_KINDS = {
  'Flooded Timber': 'timber',
  'Shallow Area': 'shallow',
  'Hazard, Spar/Spindle Buoy': 'hazard',
  'Hazard Area': 'hazard',
  'Pile': 'pile',
  'Piles': 'pile',
  'Fish Attractor Buoy, Spar/Spindle Buoy': 'attractor',
  'Fish Attractor Buoy': 'attractor',
  'Bridge': 'bridge',
};

/**
 * pois.geojson -> features shaped like the pack layers, so both consumers take them unchanged.
 *
 * structureIndex() reads `properties.kind` and castSpots() in plan-water.js buckets on the same
 * field, so one normalisation serves the whole app and neither matcher needed touching.
 *
 * NO DEPTH, deliberately. A Garmin POI carries a position and a label and not a sounding, so
 * these resolve to a real identity and a null depth — which prompt rule 5 already tells the model
 * to say out loud rather than guess around. DEPTH_FIELD has no entry for any of these kinds and
 * must not grow one.
 *
 * NOT THE DNR ATTRACTOR FEED. build_trolling_runs.py:449 is explicit that `near[]`'s `attractor`
 * marks come from Garmin's own Fish Attractor Buoy symbols, and Ryan drew that line on 08-06:
 * "fish attractors aren't going to show you stump fields or submerged timber, they will just show
 * where dnr has dropped a brushpile." The state feed has no marks in `near[]` to resolve, so
 * feeding it in here would snap a Garmin mark onto a DNR point and call that a match.
 */
/**
 * WHAT THE CHART SAYS YOU MAY NOT ENTER, AND WHAT IT SAYS TO AVOID.
 *
 * The prompt's SAFETY section has always said "there are N marked hazard zones on this water" and
 * nothing ever filled it, because the app looked for hazards in the research profile -- prose an
 * agent wrote -- while the packs carried charted, typed, positioned ones nobody read.
 *
 * THE CLASSIFICATION IS RYAN'S AND IT IS MEASURED, not mine. EVERY_POI_TYPE_ON_THE_CARD_2026-08-27
 * counted all 39 `poi_type` values across the 281 indexed packs and he sorted them, and a first
 * pass at this function ignored that document and got three of five wrong. `poi_type` is the
 * vocabulary to read; `class` is 2,278 strings of raw Garmin text with typos and buoy SHAPES in it.
 *
 * CANNOT ENTER -- a hard routing constraint.
 *   restricted_area  198 pts / 25 lakes   Entry Prohibited, No Boats, Swimming Area
 *   dam               98 pts / 54 lakes   Ryan: "can't go here either lol"
 *
 * AVOID -- a routing warning.
 *   hazard_area      587 pts / 47 lakes   Shoaling, Missing Marker, Charts Incorrect
 *   danger_buoy    1,587 pts / 37 lakes   Hazard Buoy, Danger Shoal Marker
 *   caution_buoy     271 pts / 15 lakes   "IDK what to do with that one... i guess be careful"
 *
 * NOT HAZARDS, AND THIS IS THE PART A LIST WRITTEN FROM INTUITION GETS WRONG. In a kayak these
 * are where you are TRYING to go:
 *   pile           1,330 / 40   bridge pilings -- Ryan: "target", confirmed at 3 m against his
 *                               own photo
 *   submerged_bridge 3,362 / 33  Ryan: "not a hazard it is a target"
 *   creek_bed, road_bed, flooded_timber                     structure, belongs with structure.geojson
 *   obstruction    3,546 / 77   MEASURED AS TARGETS, at least on Wateree: they sit a median 49 m
 *                               from the SCDNR attractor coordinates, 59% within 150 m, against
 *                               fish_attractor_buoy's own 39 m / 62% on the same test. They are
 *                               brush piles that Garmin charts because they take a prop off. The
 *                               document is explicit that this must not be routed around until it
 *                               is checked on a second water, so it is in neither list here.
 *   shallow_area   1,062 / 23   BOTH, and the only entry whose category depends on the activity:
 *                               "avoid if in a deep area when trolling - target possibly when
 *                               casting". Deciding that needs the leg type, which this function
 *                               does not have. Left out rather than guessed.
 *   slow_no_wake, height_marker, nav_buoy, ramps, marinas   Ryan: "a no wake buoy is not a hazard
 *                               to a kayak fisherman"
 *
 * Named, not just counted, because the names are the meaning -- "No Boats", "Hazard Area", "Water
 * Intake Keep Clear". They are quoted as charted, buoy shape and all, rather than cleaned: a rule
 * for stripping "Spar/Spindle Buoy" off the end would also strip "Danger Shoal Marker", which is a
 * meaning and not a shape.
 */
export const NO_GO_POI_TYPES = { restricted_area: 1, dam: 1 };
export const AVOID_POI_TYPES = { hazard_area: 1, danger_buoy: 1, caution_buoy: 1 };

// 3,453 of the 3,704 caution_buoy points card-wide carry this instead of a warning -- the source
// disclaimer, which EVERY_POI_TYPE_ON_THE_CARD flagged as the reason caution_buoy was parked
// ("if it survives, that string must be filtered first"). Measured across all 1,075 packs on
// 2026-08-30: filtering this one prefix leaves 251 real warnings, including Wateree's single
// "Water Intake Keep Clear".
const SOURCE_DISCLAIMER = /^The location of all buoys within this cell/i;

function nameCounts(poisFc, types) {
  const n = new Map();
  for (const f of ((poisFc && poisFc.features) || [])) {
    const p = (f && f.properties) || {};
    if (!types[p.poi_type]) continue;
    const name = String(p.name || '').trim();
    if (SOURCE_DISCLAIMER.test(name)) continue;
    const label = name || p.poi_type;
    n.set(label, (n.get(label) || 0) + 1);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1])
    .map(([label, c]) => `${c}× ${label}`);
}

export function chartedHazards(poisFc) {
  const out = [];
  const noGo = nameCounts(poisFc, NO_GO_POI_TYPES);
  const avoid = nameCounts(poisFc, AVOID_POI_TYPES);
  if (noGo.length) {
    out.push(`CANNOT ENTER — charted on this water by Garmin's survey: ${noGo.join(' · ')}. `
           + `Do not route a leg through one or put a stop in one.`);
  }
  if (avoid.length) {
    out.push(`AVOID — charted warnings: ${avoid.join(' · ')}. Each is at a position on the chart; `
           + `this is what they say, not where they are.`);
  }
  return out;
}

export function poiSpotFeatures(poisFc) {
  const out = [];
  for (const f of ((poisFc && poisFc.features) || [])) {
    const p = f.properties || {};
    const g = f.geometry;
    if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
    let kind = POI_KINDS[p.name] || POI_KINDS[p.class];
    if (!kind && String(p.poi_type || '').includes('timber')) kind = 'timber';
    if (!kind) continue;
    out.push({ type: 'Feature', geometry: g,
               properties: { kind, name: p.name || null, poi_type: p.poi_type || null } });
  }
  return out;
}

/**
 * The state feed -> attractor features, deduped against Garmin's own.
 *
 * TWO SOURCES, ONE KIND OF THING. Garmin charts a Fish Attractor Buoy where it sees one; the
 * state publishes where it dropped the brushpile. They are the same object described by two
 * people, and both are worth stopping on. What they are NOT is submerged timber — Ryan,
 * 2026-08-06, correcting a session that had conflated them: "fish attractors aren't going to show
 * you stump fields or submerged timber, they will just show where dnr has dropped a brushpile or
 * a clump of old bridge." That is a statement about what an attractor IS. It was read once as a
 * reason to leave the state feed out of the planner, which is the opposite of what it says.
 *
 * Only the Garmin ones are in `near[]`, because only they were in the pack when the pipeline ran.
 * So the state rows join per-run in the app, exactly as docks do — see dockHits().
 *
 * Deduped at 30 m: wider than any plausible disagreement between a state survey point and a
 * charted buoy over the same pile, narrower than the gap between two piles anyone would bother
 * mapping separately. Without it the same brushpile scores twice on the same leg.
 */
/**
 * An occupancy grid of everywhere this pack has charted something.
 *
 * THE PACK IS THE LAKE. Both callers hold the water's own contours, runs and features and neither
 * holds the registry, so the honest test for "is this point on this water" is not a name and not
 * a bounding box -- a box around Wateree, which runs north-west to south-east, contains a good
 * deal of Fishing Creek Reservoir. It is whether the point sits near something this pack charted.
 *
 * Cells of `cellM`; a point counts as on-water if its own cell or any of the eight touching it
 * holds a charted coordinate. That makes the real tolerance one to two cells, which is what the
 * default is chosen for. O(n) either side, which matters at 5,263 attractor rows.
 */
export function chartedGrid(featureArrays, cellM = 250) {
  const cells = new Set();
  let lat0 = null;
  const add = (c) => {
    if (lat0 == null) lat0 = c[1];
    const dLat = cellM / 111320;
    const dLon = cellM / (111320 * Math.max(0.2, Math.cos(lat0 * Math.PI / 180)));
    cells.add(`${Math.floor(c[0] / dLon)},${Math.floor(c[1] / dLat)}`);
  };
  const walk = (c) => {
    if (!Array.isArray(c) || !c.length) return;
    if (Number.isFinite(c[0]) && Number.isFinite(c[1])) { add(c); return; }
    for (const x of c) walk(x);
  };
  for (const arr of (featureArrays || [])) {
    for (const f of (arr || [])) walk(f && f.geometry && f.geometry.coordinates);
  }
  if (!cells.size) return null;              // nothing charted: cannot judge, so do not
  const dLat = cellM / 111320;
  const dLon = cellM / (111320 * Math.max(0.2, Math.cos((lat0 || 34) * Math.PI / 180)));
  return (lon, lat) => {
    const cx = Math.floor(lon / dLon), cy = Math.floor(lat / dLat);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) if (cells.has(`${cx + a},${cy + b}`)) return true;
    }
    return false;
  };
}

/**
 * The state feed -> attractor features ON THIS WATER, deduped against Garmin's own.
 *
 * WHY I WOULD NOT FISH FISHING CREEK FROM A KAYAK ON WATEREE. Ryan, 2026-08-30: "why would i fish
 * the fish attractor at fishing creek, lancaster reservoir or lake monticello when i am lake
 * wateree? i dont think my kayak will make it there and i am damn sure i can't cast that far".
 *
 * There was no spatial filter here at all. The Worker returns every attractor it has -- 5,263
 * rows across South Carolina, North Carolina, Georgia and Tennessee -- and every one of them
 * became a cast spot on whatever lake was open. Pick Water listed 5,258 of them. Smart Plan was
 * scoring days against the same set.
 *
 * `onWater` is the grid above, built from the pack the caller already loaded. Passing it is not
 * optional in practice: without it this cannot tell one lake from another, so its absence is said
 * out loud rather than quietly reverting to four states of brushpiles.
 */
export function attractorSpotFeatures(dnrRows, poiSpots = [], opts = {}) {
  const { dedupeM = 30, onWater = null, where = 'attractors' } = (
    typeof opts === 'number' ? { dedupeM: opts } : opts);
  if (!onWater) {
    console.warn(`[candidates] ${where}: no charted grid given, so every state's attractors are `
      + `in play. This is what listed 5,258 of them on one lake.`);
  }
  const charted = [];
  for (const f of (poiSpots || [])) {
    if ((f.properties || {}).kind === 'attractor' && f.geometry) charted.push(f.geometry.coordinates);
  }
  const out = [];
  let offWater = 0;
  for (const r of (dnrRows || [])) {
    const lon = Number(r && r.lon), lat = Number(r && r.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (onWater && !onWater(lon, lat)) { offWater += 1; continue; }
    let dup = false;
    for (const c of charted) {
      if (metresBetween([lon, lat], c) <= dedupeM) { dup = true; break; }
    }
    if (dup) continue;
    out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] },
               properties: { kind: 'attractor', name: r.name || null,
                             source: r.source || 'state DNR', waterbody: r.waterbody || null } });
  }
  if (offWater) {
    console.log(`[candidates] ${where}: ${out.length} on this water, ${offWater} elsewhere and `
      + `not listed`);
  }
  return out;
}

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
  } else if (kind === 'timber' || kind === 'shallow' || kind === 'pile'
             || kind === 'bridge' || kind === 'attractor' || kind === 'hazard') {
    // Garmin's own label beats the slug: "Flooded Timber" says more than "timber", and it is what
    // is printed on the chart the angler is looking at. No depth — see poiSpotFeatures().
    bits.push(p.name || kind);
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

// ---------------------------------------------------------------------------------------------
// WORTH FISHING AND WORTH KNOWING ARE TWO DIFFERENT QUESTIONS, AND ONE NUMBER WAS ANSWERING BOTH.
//
// `weight` answers the first: how much is this worth catching a fish on. A hazard's answer is
// zero and that is CORRECT -- it is not a citation ranking, it is a thing to steer around. But
// this loop then read that zero as "nothing here" and dropped the mark on the floor, so it never
// reached `hits`, never reached `candidate.passes`, and never reached the model. Logged as an
// open violation in claude/WHAT_SMARTPLAN_IS_2026-08-09.md since 2026-08-09:
//
//     hazards carry weight 0 ... so hazards are stripped out of the model's list entirely and it
//     receives a bare number. It is being asked to route around things it cannot see.
//
// Measured on wateree_lake/trolling_runs.geojson, 2026-08-11: `near[]` carries 1,142 hazard and
// 989 obstruction marks -- 2,131 of 19,059, ELEVEN PERCENT of everything the pipeline joined to
// the runs -- and every one of them was being deleted here. Obstruction was lost twice over: it
// has no entry in DEFAULT_WEIGHTS at all, so `?? 0` zeroed it and this line finished the job.
//
// The hit is now kept whatever it is worth. NOTHING ABOUT WHICH WATER GETS CHOSEN CHANGES: only
// `score` walks the window (see growWindow's `got > 0`), a zero-weight mark adds nothing to it,
// so the same legs come back at the same lengths -- they just arrive knowing what is on them.
function scoreWindow(near, fromM, toM, weights, maxOffM, capPerType = SCORE_CAP_PER_TYPE) {
  let score = 0;
  const hits = [];
  const counted = {};
  for (const n of near) {
    if (n.s < fromM || n.s > toM) continue;
    if (n.d > maxOffM) continue;
    const w = weights[n.t] ?? 0;
    // Something 20 m off the line is worth more than the same thing 95 m off it.
    const proximity = 1 - (n.d / maxOffM) * 0.5;
    // The per-type cap is a SCORING device -- it stops 191 docks on one leg from burying
    // everything else. A mark worth nothing cannot swamp a ranking, so it does not use up a slot
    // that a real target would otherwise have had.
    if (w > 0) {
      counted[n.t] = (counted[n.t] || 0) + 1;
      if (counted[n.t] <= capPerType) score += w * proximity;
    }
    // The hit is kept either way: it is still a place to stop, it just stops adding to the score.
    hits.push({ atM: Math.round(n.s - fromM), type: n.t, offM: n.d, weight: w,
                n: n.n, spanM: n.spanM, scored: w > 0 && counted[n.t] <= capPerType });
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

/**
 * Every feature of `kind` in `index` that passes within `maxOffM` of this run, as `near`-shaped
 * hits. Docks were the first layer to need this because the pipeline never joined them; the state
 * attractor feed is the second, for the same reason — it is not in the pack the pipeline read.
 */
export function kindHits(coords, cum, index, maxOffM, kind, asType = kind) {
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
          if (r.kind !== kind) continue;
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
          if (best <= maxOffM) out.push({ s: bestAt, t: asType, d: best });
        }
      }
    }
  }
  return out;
}

function dockHits(coords, cum, index, maxOffM) {
  return groupDocks(kindHits(coords, cum, index, maxOffM, 'dock'));
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

/**
 * docks.geojson -> dock lines, pockets and singles, WITHOUT a lane.
 *
 * Ryan, 2026-08-30: "docks need to be there... they would be a primary target for casting for
 * largemouth". They were not there at all: groupDocks() below chains docks by `s`, their distance
 * along a trolling lane, so a dock only became anything if a run went past it -- and Pick Water
 * never even fetched the file. Wateree ships 2,796 docks and offered none of them.
 *
 * Same numbers as groupDocks and for the same reasons, because they are shoreline geometry and
 * not tuning knobs: residential docks sit 30-60 m apart, a gap over DOCK_GAP_M is a break between
 * groups, and past DOCK_LINE_M a row of docks stops being a spot and becomes a stretch you run a
 * bait down. What changes is the chaining -- along the shore instead of along somebody's route --
 * so the groups are single-link clusters at DOCK_GAP_M, found through a grid so 2,796 docks do
 * not cost 7.8 million distance checks.
 *
 * Three shapes, kept from groupDocks: a line is placed at one end because that is where you start
 * running it; a pocket and a lone dock are placed at their middle because that is what you stop on.
 */
/** The mean of every coordinate in any GeoJSON geometry, or null if it holds none. */
function centreOf(coords) {
  let sx = 0, sy = 0, n = 0;
  const walk = (c) => {
    if (!Array.isArray(c) || !c.length) return;
    if (Number.isFinite(c[0]) && Number.isFinite(c[1])) { sx += c[0]; sy += c[1]; n += 1; return; }
    for (const x of c) walk(x);
  };
  walk(coords);
  return n ? [sx / n, sy / n] : null;
}

export function dockSpotFeatures(docksFc) {
  const pts = [];
  for (const f of ((docksFc && docksFc.features) || [])) {
    const g = f && f.geometry;
    if (!g) continue;
    // A DOCK IS A POLYGON. Every one of Wateree's 2,796 is `Polygon`, an outline of the
    // structure — the first version of this handled Point and LineString, so `coordinates[0]`
    // came back as a whole ring, `Number.isFinite` refused it, and all 2,796 were silently
    // dropped. What is wanted is where the dock IS, so any shape collapses to the mean of its
    // vertices.
    const c = centreOf(g.coordinates);
    if (c) pts.push(c);
  }
  if (!pts.length) return [];

  // ~DOCK_GAP_M cells, so every neighbour within the gap is in this cell or one touching it.
  const lat0 = pts[0][1];
  const dLat = DOCK_GAP_M / 111320;
  const dLon = DOCK_GAP_M / (111320 * Math.max(0.2, Math.cos(lat0 * Math.PI / 180)));
  const cell = new Map();
  pts.forEach(([x, y], i) => {
    const k = `${Math.floor(x / dLon)},${Math.floor(y / dLat)}`;
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(i);
  });
  const near = (i) => {
    const [x, y] = pts[i];
    const cx = Math.floor(x / dLon), cy = Math.floor(y / dLat);
    const out = [];
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (const j of (cell.get(`${cx + a},${cy + b}`) || [])) {
          if (j !== i && metresBetween(pts[i], pts[j]) <= DOCK_GAP_M) out.push(j);
        }
      }
    }
    return out;
  };

  const seen = new Array(pts.length).fill(false);
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    if (seen[i]) continue;
    const group = [i];
    seen[i] = true;
    for (let h = 0; h < group.length; h++) {
      for (const j of near(group[h])) {
        if (!seen[j]) { seen[j] = true; group.push(j); }
      }
    }
    // The span is the group's longest reach, which is what decides line against pocket.
    let span = 0, ai = group[0], bi = group[0];
    for (const a of group) {
      for (const b of group) {
        const d = metresBetween(pts[a], pts[b]);
        if (d > span) { span = d; ai = a; bi = b; }
      }
    }
    const kind = span >= DOCK_LINE_M && group.length >= DOCK_LINE_MIN ? 'dock_line'
      : group.length > 1 ? 'dock_cluster' : 'dock';
    const at = kind === 'dock_line' ? pts[ai]
      : [(pts[ai][0] + pts[bi][0]) / 2, (pts[ai][1] + pts[bi][1]) / 2];
    out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: at },
               properties: { kind, n: group.length, spanM: Math.round(span) } });
  }
  return out;
}

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
 * WHAT DEPTH OF WATER THIS PASS IS OVER, measured where the measurement exists.
 *
 * `depth_ft` is the contour's nominal value — the number the line was stitched at. `mean_depth_ft`
 * is what fit_trolling_runs.py measured off the depth raster every 10 m along the finished pass
 * and length-weighted, which is a strictly better answer about the water the boat will actually
 * be over. It only exists on FITTED passes, which on Wateree and Marion is about a quarter of the
 * runs — the rest could not hold a leg of the minimum length inside one band and were left with
 * their original geometry, so they fall back to the nominal value.
 *
 * The mixed source is stated on the candidate as `waterDepthMeasured` rather than hidden, because
 * "this pass averages 26 ft" and "this line was drawn at the 26 ft contour" deserve different
 * amounts of trust and only one of them was measured.
 */
function passWaterFt(p) {
  const measured = Number(p && p.mean_depth_ft);
  if (Number.isFinite(measured) && measured > 0) return { ft: measured, measured: true };
  const nominal = Number(p && p.depth_ft);
  return { ft: Number.isFinite(nominal) ? nominal : NaN, measured: false };
}

/**
 * IS THIS WATER ELIGIBLE FOR FISH AT THIS DEPTH, HOLDING THIS WAY?
 *
 * This replaces the single line that compared a fish band against a contour's water depth and had
 * done so since it was written. The two are different quantities; which one constrains the water
 * depends entirely on `holding`, and until the research pass populated that field there was no
 * honest way to write this. See claude/WHAT_SMARTPLAN_IS_2026-08-09.md.
 *
 * BOTTOM — the floor is the target, so the water should MATCH the band. A blue cat in 18–25 ft is
 * on the bottom in 18–25 ft of water; 40 ft of water is not deep water holding those fish, it is
 * the wrong water. This is the one case where the old line was accidentally right, and it is kept
 * unchanged rather than rewritten into something equivalent.
 *
 * SUSPENDED — the fish are up in the column and the bottom is only a floor to stay off. Ryan,
 * 2026-08-10: "fish absolutely could be suspended at 25ft in 40ft of water... so realistically the
 * baits need to not exceed that depth... not the boat." So there is NO upper limit, and the only
 * requirement is that the water be deeper than where the fish start.
 *
 * WHY THE FLOOR IS dMin AND NOT dMax. A 15–40 ft band means fish are found anywhere in that
 * range. Water 25 ft deep can hold them at 15–25 ft — that is real, fishable water and requiring
 * more than 40 ft would delete it. Water 10 ft deep cannot hold a fish at 15 ft at all. So the
 * test is the shallow end of the band, which is exactly "any portion that is deeper than the fish".
 *
 * BOTH — the suspended rule, per Ryan: "yeah use the suspended number so that you could fish any
 * portion that is deeper than the fish." The ambiguity is real and belongs on the page rather than
 * buried in a threshold, so the plan is also made to say it in words; see the wiring module.
 *
 * NULL — DELIBERATELY UNDECIDED. Ryan, asked which way it should fail: "for null i dont know...
 * cross that bridge when we get to it." So nothing is invented here. The pre-existing behaviour is
 * kept EXACTLY as it was for this case and nowhere else, which means an unresearched lake plans
 * today the way it planned yesterday — no silent new guess landing in water he cannot see. The
 * `holdingUnknown` flag on the result is how the caller says so out loud.
 *
 * NO CLEARANCE CONSTANT ANYWHERE IN HERE. How far above the fish a bait rides is species-dependent
 * and, in his words, "not a math equation" — a foot for bottom-hugging catfish, just above the
 * suspension for stripers. That is the research's answer, not a number for this function, and a
 * margin invented here would be exactly the category error this whole rewrite is undoing.
 *
 * @returns {{ok:boolean, waterFt:number, measured:boolean, rule:string}}
 */
export function eligibleForHolding(p, fishBand, holding) {
  const [dMin, dMax] = Array.isArray(fishBand) && fishBand.length === 2
    ? fishBand : [0, Infinity];
  const { ft, measured } = passWaterFt(p);
  if (!Number.isFinite(ft)) return { ok: false, waterFt: NaN, measured, rule: 'no charted depth' };

  if (holding === 'suspended' || holding === 'both') {
    return { ok: ft > dMin, waterFt: ft, measured,
             rule: `suspended: water must be deeper than ${dMin} ft, no ceiling` };
  }
  if (holding === 'bottom') {
    return { ok: ft >= dMin && ft <= dMax, waterFt: ft, measured,
             rule: `bottom: water must be inside ${dMin}–${dMax} ft` };
  }
  // Unknown. The old comparison, unchanged, so behaviour on unresearched water does not move.
  return { ok: ft >= dMin && ft <= dMax, waterFt: ft, measured,
           rule: `holding unknown — old fish-band-vs-water-depth test, ${dMin}–${dMax} ft` };
}

/**
 * @param {object[]} runs        features from trolling_runs.geojson
 * @param {object}   o
 * @param {number[]} o.ramp      [lon, lat]
 * @param {number[]} o.fishDepthFt [min, max] where the FISH are — from trollingIntelligence.
 *                                Renamed from `depthFt` on 2026-08-10 because this file already
 *                                used `depthFt` for a candidate's WATER depth, so one name meant
 *                                both quantities in the same module. That collision is the whole
 *                                bug in miniature and it is not surviving the fix that undoes it.
 * @param {string}   [o.holding] 'bottom' | 'suspended' | 'both' | null — which constraint the
 *                                water is under. See eligibleForHolding().
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
  // A STALE CALLER MUST NOT FAIL QUIETLY. When `depthFt` became `fishDepthFt` the old name stopped
  // being read, which meant any caller still passing it got `[0, Infinity]` -- no depth filter at
  // all -- and a plan full of water for the wrong fish that looked entirely normal. The suite
  // caught it immediately on smart-plan-v2.test.js and it would not have been caught in the app.
  // So the old name is an error, permanently, and not an alias: the two names meant different
  // quantities and accepting either is the ambiguity this rename exists to remove.
  if (o.depthFt !== undefined) {
    throw new Error('selectCandidates: `depthFt` was renamed to `fishDepthFt` on 2026-08-10 '
                  + 'because this module already used `depthFt` for a leg\'s WATER depth. Pass '
                  + '`fishDepthFt` (where the fish are) and `holding`.');
  }
  const fishBand = o.fishDepthFt || [0, Infinity];
  const holding = o.holding || null;
  // Counted so the caller can say WHY nothing came back. "nothing is inside 15-40 ft" and "every
  // pass on this lake is shallower than 15 ft" are different problems with different fixes, and
  // the old code could only report the first because it never knew which test it had applied.
  const rejected = { depth: 0, unroutable: 0, noWindow: 0, scoreless: 0, unfitted: 0,
                     // Filled below, after scoring. Declared here so every bucket lives in one
                     // object and the total can be checked against `considered`.
                     battery: 0, window: 0, dedupe: 0, limit: 0 };

  // ── A LANE THE FITTER REFUSED IS NOT A LANE ────────────────────────────────────────────────
  //
  // Ryan, on the Sep 5 Wateree plan and the GPX that came out of it: "look at leg 5 the entire
  // leg is full of sharp turns and literally hugs the shore inside the dock line... if i trolled
  // this as written i would take out every dock in clearwater cove". Then: "are these fitted
  // lanes? i thought fitted fixed these angles".
  //
  // They were not fitted, and fitting does fix the angles. Counted on wateree_lake's
  // trolling_runs.geojson, 2026-09-05:
  //
  //     2,843 runs      800 fitted      2,043 not
  //     shallowest_ft present on exactly the 800 fitted and on none of the 2,043
  //     the four legs the model was handed: all four `fitted: false`; #4 had 44 turns
  //       over 45 degrees and 16 over 90
  //     the two fitted candidates in the same set: zero turns over 45 degrees
  //
  // The unfitted ones carry `fit_note` recording the refusal in the fitter's own words -- "no
  // fitted pass of 1500 m survived: this contour is not 2.0 ft deep for..." -- and NOTHING IN
  // THIS FILE HAS EVER READ `fitted`, `fit_note` OR `shallowest_ft`. The selector offered the
  // refusals alongside the passes and scored them the same.
  //
  // The gate is measured, not chosen: if this pack HAS fitted lanes, only fitted lanes are
  // offered. A pack with none behaves exactly as it did, because a lake with no fitted runs and
  // no candidates is worse than a lake with rough ones -- and `selection.fittedAvailable` says
  // which case the caller is in rather than leaving a silent zero to be guessed at.
  const fittedAvailable = runs.some((r) => (r.properties || {}).fitted === true);
  let depthRule = null;
  const straight = (a, b) => metresBetween(a, b);
  const transitM = o.transitM || straight;

  const out = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i], p = run.properties || {};
    if (p.routable === false) { rejected.unroutable++; continue; }
    if (fittedAvailable && p.fitted !== true) { rejected.unfitted++; continue; }
    // THE LINE THAT WAS KNOWN WRONG FOR THREE DAYS. It read:
    //
    //     if (!(p.depth_ft >= dMin && p.depth_ft <= dMax)) continue;
    //
    // `p.depth_ft` is the WATER depth of the contour; `dMin`/`dMax` came from depthBandFor() and
    // are where the FISH are. It compared them directly and had done so since it was written.
    //
    // It stayed because the fix needed a fact nobody had: which of the two quantities the
    // research was quoting. A ceiling built here on 2026-08-10 was worse than the bug -- requiring
    // the pass's measured mean AND max inside the band deleted exactly the deep water suspended
    // fish live over, which on Wateree in summer is the entire pattern. Wrong sign, reverted the
    // same day. Ryan: "fish absolutely could be suspended at 25ft in 40ft of water."
    //
    // What unblocked it was the research pass finally populating `holding` per lake and season,
    // cited -- 35 of 35 entries on Wateree's v140 profile, 34 of them quoting the sentence they
    // came from. So the question "does this water have to MATCH the band or merely be DEEPER than
    // it" now has a per-lake, per-season, sourced answer, and eligibleForHolding() applies it.
    //
    // The old comparison still runs, unchanged, for exactly one case: holding unknown. That is
    // deliberate and it is Ryan's call to make, not this file's.
    const elig = eligibleForHolding(p, fishBand, holding);
    if (!depthRule) depthRule = elig.rule;
    if (!elig.ok) { rejected.depth++; continue; }
    const coords = run.geometry && run.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;

    // Docks join here rather than in the pipeline -- see dockHits(). Merged into `near` before
    // the window slides, so a dock counts toward WHICH window is chosen, not just what the chosen
    // one happens to contain.
    const cum0 = cumulative(coords);
    const docks = o.docks ? dockHits(coords, cum0, o.docks, opts.maxOffM) : [];
    // The state attractor feed joins here for the same reason docks do: it is not in the pack, so
    // the pipeline could not have put it in `near[]`. Same `maxOffM` as docks — how far off a line
    // a thing can be and still be on the way is one question, and it already has one answer.
    const dnr = o.attractors
      ? kindHits(coords, cum0, o.attractors, opts.maxOffM, 'attractor') : [];
    const joined = docks.concat(dnr);
    const win = bestWindow(joined.length ? withNear(run, joined) : run, opts);
    if (!win) { rejected.noWindow++; continue; }
    // Relief is a property of the whole run, so it is added once rather than per hit. River
    // channel and channel edge are 12 cites across 7 species -- more species than anything else
    // in the count -- and nothing scored them until 2026-08-08.
    const reliefScore = opts.reliefWeights[p.relief] || 0;
    win.score += reliefScore;
    if (win.score <= 0) { rejected.scoreless++; continue; }

    const cum = cumulative(coords);
    const start = pointAt(coords, cum, win.startM);
    const end = pointAt(coords, cum, win.startM + win.lengthM);
    // The geometry of the leg itself, sliced once and carried on the candidate. Without this the
    // assembler has a leg with a length and no line, so nothing can be drawn or exported and a
    // stop has nowhere to sit.
    const line = sliceLine(coords, cum, win.startM, win.startM + win.lengthM);
    const lineCum = cumulative(line);
    // WHAT IS UNDER THE BOAT ON THE WINDOW ACTUALLY CHOSEN, not on the whole pass and not the
    // name of the contour it was cut from. Null on a pack fitted before envelope profiles existed,
    // and every reader below falls back to what it used to use.
    const band = waterBand(p, win.startM, win.startM + win.lengthM);

    const inM = transitM(o.ramp, start);
    const outM = transitM(end, o.ramp);
    // HOW FAR THIS WATER IS FROM THE RAMP HE PICKED. The nearer end, because a leg can be run in
    // either direction and what matters is how far out the water is, not which way the contour
    // happens to be drawn.
    //
    // TRIED AND REVERTED, 2026-08-10 -- leaving the note so it is not tried a third time. The
    // direction fix established that a leg costs `inM + outM` whichever way it is trolled, and it
    // looked like the min was therefore understating a long leg pointing away from the ramp: on
    // the plan Ryan objected to, L2's near end was 2.5 km out and its far end 6.3 km, and it
    // scored as 2.5 km water.
    //
    // Replacing it with the midpoint made things WORSE, and the suite said so immediately. The min
    // and the midpoint answer different questions: min says HOW CLOSE this water comes to the
    // ramp, the midpoint says WHERE IT SITS. Because a far leg's two ends are both far while a
    // near leg's are near and not-so-near, the midpoint COMPRESSES the gap between them -- near
    // water went from 8x closer to 3.7x closer, its proximity dropped from 0.81 to 0.67, and 6.5
    // km of better water four miles out took first place over 2.2 km beside the ramp. That is
    // "why would i launch at clearwater cove and then go fish the opposite side of the lake",
    // reintroduced by a change meant to help.
    //
    // The cost of the far end is real, and it is already charged -- `moveAh` below uses
    // `inM + outM`, and the model is quoted the honest run home. This factor is not a cost. It is
    // a preference about location, and the min is the right shape for that.
    const fromRampM = Math.min(inM, outM);
    const proximity = 1 / (1 + fromRampM / rampBiasM);
    const fishAh = ampHours(win.lengthM, trollMph);
    const moveAh = ampHours(inM + outM, transitMph);
    const totalAh = fishAh + moveAh;
    const totalMin = minutesFor(win.lengthM, trollMph) + minutesFor(inM + outM, transitMph);

    // Reachable means: fish this one thing and get home, inside the day. A plan chains several,
    // so this is a ceiling on what is worth offering, not a promise the whole set fits.
    if (o.usableAh && totalAh > o.usableAh) { rejected.battery++; continue; }
    if (o.windowMin && totalMin > o.windowMin) { rejected.window++; continue; }

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
      // THIS IS THE WATER'S DEPTH, NOT THE FISH'S. Kept as `depthFt` because plan-builder,
      // plan-to-timeline, plan-prompt and plan-assemble all read that name and renaming it is a
      // separate change; `waterDepthFt` is emitted alongside as the unambiguous one, carrying the
      // measured value where fit_trolling_runs.py stamped one. `waterDepthMeasured` says which.
      depthFt: band ? band.line.medianFt : p.depth_ft,
      depthMinFt: band ? band.line.minFt : null,
      depthMaxFt: band ? band.line.maxFt : null,
      // THE CEILING SMART PLAN NEVER HAD. plan-prompt.js has explained `maxRunDepthFt` to the
      // model since it was written -- "A leg reading 25-31 ft of water with maxRunDepthFt: 20 has
      // a 20 ft shoal somewhere along it" -- and only the Pick Water path ever sent one. Smart
      // Plan legs arrived with none, plan-assemble.js fell back to `depthFt`, and the fallback
      // was the contour's NAME, so the shallowest water on the leg was never checked at all.
      maxRunDepthFt: band ? band.line.minFt : null,
      wholeRun: win.whole,
      waterDepthFt: Number.isFinite(elig.waterFt) ? Number(elig.waterFt.toFixed(1)) : null,
      waterDepthMeasured: elig.measured,
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
    // COUNTED, BECAUSE THIS IS THE BIGGEST FILTER IN THE FUNCTION AND IT WAS THE ONLY SILENT ONE.
    //
    // Measured 2026-08-26 on the real Wateree pack: 1,750 runs in, 504 cut on depth, 639 as
    // unroutable, 301 for no scoring window -- all three counted and reportable -- leaving 306
    // scored candidates, of which 22 came out. The other 284 went here, and `selection.rejected`
    // said nothing about them. So a thin day looked like a depth problem or a routing problem
    // when it was neither, and the diagnostic whose whole job is explaining absence was blind to
    // the step that removed 93% of what survived everything else.
    if (!duplicate) kept.push(c); else rejected.dedupe++;
    // The cap is a cut like any other, and a cut nobody can see is how "top N" gets mistaken for
    // "all of them" -- see the same rule in build_water_bindings.py and planCueRoute.
    if (o.limit && kept.length >= o.limit) { rejected.limit = out.length - kept.length - rejected.dedupe; break; }
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
  // what it costs to follow THIS leg with THAT one. `transitToRampM` closes the day, since the
  // route home is a real leg now and its cost is the ordering's too.
  //
  // THE HOP THE APP WILL ACTUALLY PAY, not the one the geometry happened to be drawn in. Since
  // 2026-08-09 the app picks which way round each pass is trolled (orientLegs, above), so quoting
  // `a.end → b.start` describes a boat that no longer exists: the assembler may well troll `a`
  // the other way and start `b` from its far end, and the model was ordering the day around a
  // price it would never be charged.
  //
  // So the number comes from orientLegs itself, run on the two-leg day this pair would be. That
  // matters more than it looks. The tempting shortcut -- take the smallest of the four end
  // pairings -- is a LOWER BOUND AND NOT REACHABLE, because a leg's two ends are not independent:
  // the end you enter by decides the end you leave by, and the day still has to get home. On the
  // plan of 2026-08-09 the four-way minimum for L1→L2 was 1442 m while every realisable ordering
  // paid at least 5357, so two pieces of water five kilometres apart would have been quoted to
  // the model as neighbours. That is the same class of mistake as the one being fixed, pointing
  // the other way, and it is worse: it invites exactly the sprawling day Ryan objected to.
  //
  // Running the real chooser on a two-leg day cannot drift from what the assembler does, because
  // it IS what the assembler does.
  //
  // Only over `kept`, so the keys are exactly the candidates the model is shown and it can never
  // be handed a distance to a leg it may not choose. n <= o.limit (12 in the app), so this is at
  // most ~144 solves of a four-comparison problem.
  //
  // AND WHAT IT COSTS AFTER FISHING IT BACK. A leg fished twice ends where it started, so the hop
  // to the next leg is measured from the OTHER end and `transitToM` no longer describes the boat.
  // Ryan's Colonel Creek plan is the case: L1 → L2 was quoted and paid at 499 m, while L2's far
  // end sat 77 m from where L1 finished. Both numbers are real; which one the day pays is decided
  // by how many times L1 gets fished, and that is the model's call — so it is shown both prices
  // rather than one of them. Same solver, same two-leg day, `trollPasses: 2` on the first leg.
  for (const a of kept) {
    const to = {};
    const back = {};
    const twice = { ...a, trollPasses: 2 };
    for (const b of kept) {
      if (b.runId === a.runId) continue;
      const [fa, fb] = orientLegs([a, b], o.ramp);
      to[b.runId] = Math.round(transitM(fa.end, fb.start));
      const [ga, gb] = orientLegs([twice, b], o.ramp);
      back[b.runId] = Math.round(transitM(ga.finish, gb.start));
    }
    a.transitToM = to;
    a.transitToMIfFishedBack = back;
  }

  // WHY NOTHING CAME BACK, WHEN NOTHING COMES BACK. Attached to the returned array rather than
  // changing the return type, because eleven call sites index it, map it and read `.length`, and
  // a shape change to carry a diagnostic would be the tail wagging the dog.
  //
  // It matters most in exactly the case this rewrite creates. "Nothing on this lake is inside
  // 15-40 ft" and "every pass on this lake is shallower than 15 ft" are different problems --
  // the first is the wrong band, the second is the wrong lake for this fish -- and until now the
  // caller could only report the first, because it did not know which test had been applied.
  kept.selection = {
    considered: runs.length,
    rejected,
    // EVERY RUN ACCOUNTED FOR. If this does not equal `considered` a filter has been added
    // without a counter, which is exactly how the dedupe went unreported for as long as it did.
    accountedFor: kept.length + rejected.depth + rejected.unroutable + rejected.noWindow
                + rejected.scoreless + rejected.battery + rejected.window + rejected.dedupe
                + rejected.limit + rejected.unfitted,
    depthRule: depthRule || 'no runs reached the depth test',
    // WHETHER THIS PACK HAD FITTED LANES AT ALL, because "800 unfitted runs were refused" and
    // "this lake has no fitted lanes so rough ones were offered" are different days on the water
    // and only this field separates them.
    fittedAvailable,
    holding: holding || null,
    // SAID OUT LOUD, NOT ASSUMED. When holding is unknown the old fish-band-vs-water-depth
    // comparison is what ran, and that comparison is known to be wrong -- it is kept only because
    // deciding the null case is Ryan's call and he has not made it. A plan built this way should
    // be readable as such rather than looking like the researched path.
    holdingUnknown: !holding,
  };
  if (!holding) {
    console.warn('[plan-candidates] holding unknown for this species/season — water was filtered '
               + 'with the old fish-band-vs-water-depth test. Bands from the built-in table never '
               + 'carry holding; only a researched profile does.');
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

/**
 * THINGS WORTH KNOWING ABOUT EVEN THOUGH THEY ARE NOT WORTH FISHING.
 *
 * scoreWindow() now keeps zero-weight marks, so they reach `c.passes`. The cap must not then
 * throw them away again. A leg that passes twelve brush piles and one rock is not improved by
 * showing the twelve and hiding the rock -- ranking by weight puts the rock last by construction,
 * which is the same deletion wearing a different hat.
 *
 * So these are added back OUTSIDE the cap. Measured on Wateree: 18% of runs carry at least one
 * within 100 m of the line, median 1, worst case 12 -- few enough that the prompt does not
 * notice, and the one leg where it is twelve is exactly the leg you want told.
 */
const ALWAYS_SHOW = new Set(['hazard', 'obstruction', 'pile', 'shallow', 'bridge']);

// NOT ADDED HERE, ON PURPOSE: a `depthIsFloor` flag saying whether a mark's depth describes the
// thing or the bottom it stands on. It would be true zero times. DEPTH_FIELD maps hump, ledge,
// point and cove and nothing else, and all four are measured features -- every type whose depth
// would be a floor already arrives with `depthFt: null`, which rule 5 of the prompt already tells
// the model to say out loud rather than guess around. A flag that is never true is a claim
// waiting to be wrong, and this file is not the place to record what the pipeline might do later.

/** Trim a candidate to what the model needs to choose. Geometry stays server-side. */
export function forModel(c, cap = MODEL_STRUCTURE_CAP) {
  const counts = {};
  for (const h of c.passes) counts[h.type] = (counts[h.type] || 0) + 1;
  // Rank the fishable ones and take the best `cap` of them...
  const fishable = c.passes
    .filter((h) => h.weight > 0)
    .slice()
    .sort((a, b) => (b.weight - a.weight) || (a.offM - b.offM))
    .slice(0, cap);
  // ...then add back everything that can cost you a lure, whatever it is worth catching a fish on.
  const seen = new Set(fishable.map((h) => h.id));
  const shown = fishable
    .concat(c.passes.filter((h) => ALWAYS_SHOW.has(h.type) && !seen.has(h.id)))
    .sort((a, b) => a.atM - b.atM)
    // No coordinates. The model names `id` and the app turns it back into a place; `structureId`
    // is the lake's own name for the thing and is there to be read, not returned.
    .map((h) => ({ id: h.id, structureId: h.structureId, type: h.type,
                   atM: h.atM, offM: Math.round(h.offM),
                   depthFt: h.depthFt, what: h.what,
                   // TARGET OR THREAT IS NOT A PROPERTY OF THE OBJECT. The same stand of timber is
                   // a target under a plan that puts the bait above it and a snag under a plan
                   // that puts the bait into it -- it depends entirely on where it sits against
                   // the baits, which is a day decision. So this says what the thing is worth and
                   // leaves the verdict to whoever is holding the rod.
                   worthFishing: h.weight > 0 || undefined }));
  return {
    runId: c.runId,
    // THE WATER, AS THREE NUMBERS, because it is not one. Ryan, 2026-08-30: "it runs from 25-32 ft
    // median 29 shallowest is 25ft deepest is 32 allows me to know that the lure depth that is
    // chosen is right or wrong". The model is judging exactly that, so it gets exactly that.
    depthFt: c.depthFt,
    depthMinFt: c.depthMinFt ?? undefined,
    depthMaxFt: c.depthMaxFt ?? undefined,
    maxRunDepthFt: c.maxRunDepthFt ?? undefined,
    lengthM: c.lengthM,
    transitFromRampM: c.transitInM,
    // WHAT THE ORDERING COSTS. `transitToM` is metres of deadhead from this leg to each other leg
    // it could be followed by, priced for the orientation the app will actually choose -- see
    // selectCandidates() above. The model owns the order (PLAN_SCHEMA_V2, "MODEL DECIDES: which
    // runId, in which order"), so the model is the thing that has to see these -- and see
    // selectCandidates() for what happened when it did not.
    transitToM: c.transitToM || undefined,
    // THE SAME HOPS, PRICED FOR A LEG FISHED AN EVEN NUMBER OF TIMES. See selectCandidates(). It
    // is a second price on the same decision, not a second decision: `trollPasses` is what picks
    // between them, and this is here so that choice can be made with both numbers in view.
    transitToMIfFishedBack: c.transitToMIfFishedBack || undefined,
    // `transitToRampM` is metres from the end of this leg back to the launch, which the day pays
    // once. LEFT AS DRAWN ON PURPOSE, even though the app may troll the pass the other way. On a
    // single leg the direction cannot save a metre: the boat leaves the ramp and returns to it, so
    // it pays `transitInM + transitOutM` either way round and only the order of the two changes.
    // Quoting the nearer end here would understate the pair while `transitFromRampM` still quoted
    // the other -- a day that looks cheaper at both ends than any route can be.
    transitToRampM: c.transitOutM,
    batteryAh: c.batteryAh,
    estMin: c.estMin,
    passes: counts,
    structures: shown,
    structuresShown: shown.length,
    // EVERYTHING ON THE LEG, not everything worth fishing. This number exists so a truncated list
    // never reads as the whole leg, and it was counting only `weight > 0` -- so it agreed with the
    // shown list about how much was hidden and was wrong about both. `passes` above breaks the
    // same total down by type, hazards included, so the gap is readable rather than just numeric.
    structuresTotal: c.passes.length,
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
