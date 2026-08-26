import { describe, it, expect } from './expect-shim.mjs';
import { buildSmartPlanV2, CANDIDATE_LIMIT, prefetchTransits, waterRouter } from '../js/modules/smart-plan-v2.js';
import { metresBetween, selectCandidates } from '../js/modules/plan-candidates.js';

// ---------------------------------------------------------------------------
// Why this test exists
//
// Six modules with five seams between them. Each is tested on its own; this is
// the one that runs the whole path -- pack, candidates, prompt, model, assemble,
// render -- with no network, so a seam cannot quietly come apart.
//
// The model is a stub that answers correctly, and then variants of it that
// answer badly on purpose: naming a run that does not exist, inventing a
// structure, asking for five tie-only lures. None of those may produce a plan
// that LOOKS fine. Either the thing is dropped and said out loud, or there is
// no plan at all.
// ---------------------------------------------------------------------------

const RAMP = [-80.7300, 34.3800];

// One run with structure the whole way, one with a quiet middle.
function run(i, lon0, lat, lenM, near) {
  const n = 40;
  const coords = Array.from({ length: n + 1 }, (_, k) => [lon0 + (k * lenM) / n / 91000, lat]);
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
           properties: { depth_ft: 22 + i, length_m: lenM, routable: true, near } };
}
const PACK = {
  '/w/trolling_runs.geojson': { features: [
    run(0, -80.720, 34.380, 4000, Array.from({ length: 16 }, (_, k) => ({ s: 200 + k * 240, t: k % 2 ? 'hump' : 'point', d: 25 + k }))),
    run(1, -80.700, 34.390, 3000, Array.from({ length: 10 }, (_, k) => ({ s: 150 + k * 280, t: 'hump', d: 30 }))),
  ] },
  '/w/structure.geojson': { features: [] },
  '/w/water_features.geojson': { features: [] },
};
const fetchJson = async (p) => PACK[p] ?? null;

const INVENTORY = [
  { name: 'DD2 Crankbait (16-20ft)', type: 'crankbait_dd2' },
  { name: 'Squarebill Crankbait', type: 'crankbait_squarebill' },
  { name: 'MR Crankbait (6-12ft)', type: 'crankbait_mr' },
  { name: 'SR Crankbait (3-5ft)', type: 'crankbait_sr' },
  { name: '3/8oz Spinnerbait', type: 'spinnerbait' },
  { name: 'Nichols Lake Fork Flutter Spoon 3/4oz', type: 'flutter_spoon' },
  { name: 'A-Rig Medium', type: 'umbrella_rig' },
];
const TACKLE = INVENTORY.map((l) => l.name);

const OPTS = {
  r2Key: 'w', chartpackBase: '', ramp: RAMP, rampName: 'Clearwater Cove',
  water: 'Lake Wateree, SC', date: '2026-08-10', launchTime: '06:00', returnTime: '15:00',
  // WHERE THE FISH ARE, AND HOW THEY ARE HOLDING. `depthFt` until 2026-08-10, when it turned out
  // this name already meant a leg's WATER depth downstream and the two were being compared to each
  // other. 15-40 ft suspended is Wateree striped bass in summer, straight off the v140 research
  // profile, quote and all: "the depths fish are marked range from 15-40 feet, but the fish are
  // often suspended when they're active."
  species: 'Striped Bass', fishDepthFt: [15, 40], holding: 'suspended',
  usableAh: 80, windowMin: 540,
  conditions: { waterTempF: 84, clarity: 'Muddy' }, tackle: TACKLE, inventory: INVENTORY,
  fetchJson,
};

// A model that reads the prompt properly: it takes the runIds and structure ids it was handed.
function goodModel(tweak = (x) => x) {
  return async ({ user }) => {
    const runIds = [...user.matchAll(/"runId":\s*"([^"]+)"/g)].map((m) => m[1]);
    const structIds = [...user.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);
    const answer = {
      safety: { isGo: true, warning: '', rampEvaluation: 'sheltered from the west' },
      loadout: { why: 'covering 15 to 40 ft', rods: [
        { id: 'R1', lure: 'DD2 Crankbait (16-20ft)', color: 'Citrus Shad', role: 'troll', leadFt: 60, runsDepthFt: [16, 20], why: 'the mid band' },
        { id: 'R2', lure: 'MR Crankbait (6-12ft)', color: 'Chartreuse', role: 'troll', leadFt: 50, runsDepthFt: [6, 12], why: 'if they push up' },
        { id: 'R5', lure: 'Nichols Lake Fork Flutter Spoon 3/4oz', color: 'Chrome', role: 'troll', leadFt: 100, runsDepthFt: [28, 36], why: 'deep and quick to swap' },
        { id: 'R6', lure: 'A-Rig Medium', color: 'Blueback', role: 'cast', why: 'the cast rod' },
      ] },
      legs: runIds.map((id, i) => ({
        runId: id, speedMph: 2.0,
        deploy: { port: 'R1', starboard: 'R5' }, why: `leg ${i + 1}`,
      })),
      stops: structIds.length ? [{ runId: runIds[0], structureId: structIds[0], rods: ['R6'],
        durationMin: 15, why: 'better cast than trolled', presentation: 'count it down',
        positioning: 'pedal-hover off the up-wind side' }] : [],
      changes: runIds.length > 1
        ? [{ beforeRunId: runIds[1], rodId: 'R5', to: 'A-Rig Medium', why: 'bait moved up' }] : [],
      notes: { scoutNotes: 'shad on the break', structureFocus: 'bait balls over the ledge' },
    };
    return JSON.stringify(tweak(answer, { runIds, structIds }));
  };
}

describe('smart-plan-v2 — the whole path with no network', () => {
  it('produces a plan whose spine is sound', async () => {
    const r = await buildSmartPlanV2({ ...OPTS, askModel: goodModel() });
    expect(r.plan.planVersion).toBe(2);
    expect(r.plan.legs.length > 0).toBe(true);
    expect(r.candidates.length <= CANDIDATE_LIMIT).toBe(true);
    let at = 0;
    for (const l of r.plan.legs) { expect(l.startM).toBe(at); at += l.lengthM; }
    expect(r.plan.budget.totalM).toBe(at);
  });

  it('sends the model ids and no coordinates, and gets ids back', async () => {
    const r = await buildSmartPlanV2({ ...OPTS, askModel: goodModel() });
    // The candidate block in the prompt must not contain the lake's geometry.
    const block = r.request.user.slice(r.request.user.indexOf('THE WATER YOU MAY FISH'));
    expect(/-80\.\d{3}/.test(block)).toBe(false);
    expect(r.plan.legs.filter((l) => l.type === 'troll').every((l) => l.runId.startsWith('w#'))).toBe(true);
  });

  it('seats the crankbaits on leader rods and the spoon on a snap rod', async () => {
    const r = await buildSmartPlanV2({ ...OPTS, askModel: goodModel() });
    const byLure = Object.fromEntries(r.plan.loadout.rods.filter((x) => x.lure).map((x) => [x.lure, x]));
    expect(byLure['DD2 Crankbait (16-20ft)'].rig).toBe('fluoro');
    expect(byLure['MR Crankbait (6-12ft)'].rig).toBe('fluoro');
    expect(byLure['Nichols Lake Fork Flutter Spoon 3/4oz'].rig).toBe('snap');
    expect(byLure['A-Rig Medium'].rig).toBe('snap');
    // ...so the mid-day swap is the cheap kind, and the plan says which.
    expect(r.plan.changes[0].cost).toBe('snap');
  });

  it('leaves the rods it never rigged staged, not invented', async () => {
    const r = await buildSmartPlanV2({ ...OPTS, askModel: goodModel() });
    const staged = r.plan.loadout.rods.filter((x) => x.staged);
    expect(staged.length).toBe(2);
    expect(staged.every((x) => x.lure === null)).toBe(true);
  });

  it('refuses a run the app never offered', async () => {
    const model = goodModel((a) => { a.legs.push({ runId: 'Secret Honey Hole',
      deploy: { port: 'R1', starboard: 'R5' } }); return a; });
    const r = await buildSmartPlanV2({ ...OPTS, askModel: model });
    expect(r.problems.some((p) => p.includes('no such run'))).toBe(true);
    expect(JSON.stringify(r.plan).includes('Secret Honey Hole')).toBe(false);
  });

  it('refuses an invented structure rather than placing it somewhere', async () => {
    const model = goodModel((a, { runIds }) => {
      a.stops = [{ runId: runIds[0], structureId: 'Main Lake Point Alpha', rods: ['R6'] }];
      return a;
    });
    const r = await buildSmartPlanV2({ ...OPTS, askModel: model });
    expect(r.plan.legs.every((l) => !l.stops || l.stops.length === 0)).toBe(true);
    expect(r.problems.some((p) => p.includes('no structure'))).toBe(true);
  });

  it('says when a loadout cannot physically be rigged', async () => {
    const model = goodModel((a) => {
      a.loadout.rods = [
        { id: 'R1', lure: 'DD2 Crankbait (16-20ft)' }, { id: 'R2', lure: 'Squarebill Crankbait' },
        { id: 'R3', lure: 'MR Crankbait (6-12ft)' }, { id: 'R4', lure: 'SR Crankbait (3-5ft)' },
        { id: 'R5', lure: '3/8oz Spinnerbait' },
      ];
      return a;
    });
    const r = await buildSmartPlanV2({ ...OPTS, askModel: model });
    expect(r.problems.some((p) => p.includes('cutting a snap off'))).toBe(true);
  });

  it('fails visibly when the model returns rubbish, and builds no fallback day', async () => {
    const r = await buildSmartPlanV2({ ...OPTS, askModel: async () => 'the fish are biting!' });
    expect(r.plan).toBe(null);
    expect(r.problems[0].includes('could not be read')).toBe(true);
  });

  it('stops early when the pack has no trolling runs', async () => {
    const r = await buildSmartPlanV2({ ...OPTS, fetchJson: async () => null,
                                       askModel: async () => { throw new Error('must not be called'); } });
    expect(r.plan).toBe(null);
    expect(r.problems[0].includes('no trolling runs')).toBe(true);
  });

  it('stops when nothing on the lake matches the depth band', async () => {
    // 200-300 ft SUSPENDED, so the suspended rule's floor (water deeper than 200 ft) is what
    // empties it. On a reservoir with a 225 ft maximum this is water that does not exist.
    const r = await buildSmartPlanV2({ ...OPTS, fishDepthFt: [200, 300], holding: 'suspended',
                                       askModel: async () => { throw new Error('must not be called'); } });
    expect(r.plan).toBe(null);
    expect(r.problems[0].includes('reachable from this ramp')).toBe(true);
  });

  // ── THE ELIGIBILITY RULE, END TO END — 2026-08-10 ──────────────────────────────────────────
  //
  // The rule these three cover is the one thing SmartPlan got wrong for months: `preferredDepth`
  // is where the FISH are and a contour's depth is the WATER, and which of them constrains the
  // other depends on `holding`. See claude/WHAT_SMARTPLAN_IS_2026-08-09.md.
  //
  // They are written against buildSmartPlanV2 rather than eligibleForHolding directly, because a
  // unit test of the predicate would have passed happily the whole time the value never reached
  // it -- researchedBand() dropped `holding` on the floor for as long as it existed, and the
  // symptom was a correct rule that nothing ever invoked.

  // THE FIXTURE RUNS SIT AT 22 AND 23 FT, which is what makes a 10-20 ft band the discriminator:
  // on the bottom that water is outside the band and the day is empty; suspended, the only
  // requirement is water deeper than 10 ft and both runs qualify. One input, two answers,
  // decided entirely by `holding` -- which is the proof that the value survives depthBandFor,
  // the wiring, buildSmartPlanV2 and selectCandidates rather than being dropped somewhere in
  // between. researchedBand() dropped it silently for as long as it existed.
  it('lets holding decide the outcome through the whole path', async () => {
    const bottom = await buildSmartPlanV2({ ...OPTS, fishDepthFt: [10, 20], holding: 'bottom',
                                            askModel: goodModel() });
    expect(bottom.plan).toBe(null);
    const susp = await buildSmartPlanV2({ ...OPTS, fishDepthFt: [10, 20], holding: 'suspended',
                                          askModel: goodModel() });
    expect(susp.plan).not.toBe(null);
  });

  it('says which rule emptied the day', async () => {
    const r = await buildSmartPlanV2({ ...OPTS, fishDepthFt: [10, 20], holding: 'bottom',
                                       askModel: goodModel() });
    // "The band is wrong" and "this fish does not live on this lake" used to read as one failure.
    expect(r.problems[0].includes('bottom: water must be inside 10–20 ft')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE ELIGIBILITY RULE — 2026-08-10
//
// `preferredDepth` is where the FISH are; a contour's depth is the WATER. Which one constrains
// the other depends on `holding`, and comparing them directly is what SmartPlan did for months.
// See claude/WHAT_SMARTPLAN_IS_2026-08-09.md.
//
// Three runs, deliberately unlike: 12 ft is too shallow to hold a fish at 15 ft at all, 22 ft is
// inside a bottom band, and 55 ft is deep water that a bottom fish is not on and a suspended one
// very much is. Every assertion below is about which of those three survives.
// ---------------------------------------------------------------------------
describe('the eligibility rule — fish depth is not water depth', () => {
  const DEPTHS = [12, 22, 55];
  // SEPARATED IN LATITUDE, NOT LONGITUDE. run() lays 4000 m eastward from lon0, which spans about
  // 0.044 deg -- stepping lon0 by anything less than that makes the runs retrace each other and
  // the spatial dedupe eats the later ones before the depth rule is ever the reason. That is what
  // happened on the first cut of this test: 55 ft vanished and it looked like the suspended rule
  // had rejected it. Parallel lines 0.02 deg of latitude apart are 2.2 km clear of each other,
  // past the 1200 m dedupe, and stay the same short hop from the ramp.
  const runsAt = () => DEPTHS.map((ft, i) => {
    const r = run(i, -80.720, 34.380 + i * 0.02, 4000,
                  Array.from({ length: 16 }, (_, k) => ({ s: 200 + k * 240, t: 'hump', d: ft })));
    r.properties.depth_ft = ft;
    return r;
  });
  const base = { ramp: RAMP, slug: 'w', usableAh: 200, windowMin: 600 };
  const depthsOf = (out) => out.map((c) => c.depthFt).sort((a, b) => a - b);

  it('suspended: keeps everything deeper than the fish, with no ceiling', () => {
    const out = selectCandidates(runsAt(), { ...base, fishDepthFt: [15, 40], holding: 'suspended' });
    // 55 ft is the one that matters. It is below the band, the old test deleted it, and it is
    // exactly the water Ryan described: "fish absolutely could be suspended at 25ft in 40ft of
    // water." 12 ft goes because a fish cannot suspend at 15 ft in 12 ft of water.
    expect(depthsOf(out)).toEqual([22, 55]);
  });

  it('suspended: the floor is the top of the band, not the bottom of it', () => {
    // 22 ft water holds a 15-40 ft fish in its shallower half. Requiring water deeper than 40
    // would throw it away, and that is real fishable water.
    const out = selectCandidates(runsAt(), { ...base, fishDepthFt: [15, 40], holding: 'suspended' });
    expect(out.some((c) => c.depthFt === 22)).toBe(true);
  });

  it('bottom: the water has to match the band', () => {
    const out = selectCandidates(runsAt(), { ...base, fishDepthFt: [18, 25], holding: 'bottom' });
    // 55 ft is not deep water holding bottom catfish that are in 18-25 ft. It is the wrong water.
    expect(depthsOf(out)).toEqual([22]);
  });

  it('both: exactly what suspended selects, not a compromise between the two', () => {
    // Ryan: "yeah use the suspended number so that you could fish any portion that is deeper than
    // the fish."
    const b = selectCandidates(runsAt(), { ...base, fishDepthFt: [15, 40], holding: 'both' });
    const s = selectCandidates(runsAt(), { ...base, fishDepthFt: [15, 40], holding: 'suspended' });
    expect(depthsOf(b)).toEqual(depthsOf(s));
  });

  it('unknown holding: behaves exactly as it did before, and says so', () => {
    // NOT A DEFAULT -- a deferral. Ryan, asked which way null should fail: "for null i dont
    // know... cross that bridge when we get to it." So the old comparison still runs here and
    // nowhere else, and the result is flagged rather than passed off as the researched path.
    const out = selectCandidates(runsAt(), { ...base, fishDepthFt: [18, 25], holding: null });
    expect(depthsOf(out)).toEqual([22]);
    expect(out.selection.holdingUnknown).toBe(true);
    expect(out.selection.depthRule.includes('holding unknown')).toBe(true);
  });

  it('prefers the fitted pass measurement over the contour nominal', () => {
    // fit_trolling_runs.py stamps `mean_depth_ft` off the depth raster every 10 m along the
    // finished pass. Where it exists it is a better answer about the water the boat is over than
    // the value the contour was stitched at, and it is what the rule reads.
    const [shallow] = runsAt();
    shallow.properties.depth_ft = 12;          // nominal: too shallow for a 15 ft fish
    shallow.properties.mean_depth_ft = 34.5;   // measured: comfortably deeper than the band's floor
    const out = selectCandidates([shallow], { ...base, fishDepthFt: [15, 40], holding: 'suspended' });
    expect(out.length).toBe(1);
    expect(out[0].waterDepthFt).toBe(34.5);
    expect(out[0].waterDepthMeasured).toBe(true);
  });

  it('refuses the old option name instead of silently dropping the filter', () => {
    // The rename's own failure mode, pinned. A caller left on `depthFt` got `[0, Infinity]` -- no
    // depth filter at all -- and a plan that looked perfectly normal. The suite caught it; the
    // app would not have.
    let threw = false;
    try {
      selectCandidates([], { ...base, depthFt: [15, 40] });
    } catch (e) { threw = /fishDepthFt/.test(e.message); }
    expect(threw).toBe(true);
  });
});



// ---------------------------------------------------------------------------
// THE TRANSITS — 2026-08-09
//
// "Transit is still straight-line in both selectCandidates and assemblePlan ... Both take the
// router as an injected function; wire waterPath from Worker/water.js into them." Carried as
// advice through three revisions of PLAN_SCHEMA_V2 and built in none: buildSmartPlanV2 was
// called with no transit at all, so `transit: o.transit` forwarded undefined and every transit
// in every plan was a straight line between two leg ends. Worker/water.js has answered
// POST /water/<slug>/route since it was written and nothing in js/ ever called it.
// ---------------------------------------------------------------------------
describe('smart-plan-v2 — transits are routed over water, or they say they are not', () => {
  // Stands in for the Worker: bends every route through one point, so a routed leg is
  // recognisable by its geometry rather than by a flag the test itself set.
  //
  // NOTE THE distanceM IS A LIE, DELIBERATELY. It claims 500 m for a path its own coordinates
  // put at about 5.3 km. This used to be asserted verbatim, which meant the suite was checking
  // that the app repeats whatever number the router hands it. The assembler now measures the
  // geometry instead -- it has to, because it stitches the true endpoints onto the routed path
  // and those metres are real -- so the test asserts the length MATCHES THE LINE.
  const BEND = [-80.7100, 34.4000];
  const routeWater = async (from, to) => ({
    distanceM: 500, coordinates: [from, BEND, to],
  });
  // metresBetween, not a second distance formula written here. A test that measures the line a
  // different way than the code does is testing the two formulas against each other.
  const walk = (c) => {
    let d = 0;
    for (let i = 1; i < c.length; i++) d += metresBetween(c[i - 1], c[i]);
    return d;
  };

  it('routes them when the endpoint answers', async () => {
    const r = await buildSmartPlanV2({ ...OPTS, askModel: goodModel(), routeWater });
    const transits = r.plan.legs.filter((l) => l.type === 'transit');
    expect(transits.length).toBeGreaterThan(0);
    for (const t of transits) {
      expect(t.unrouted).toBeUndefined();
      expect(t.coordinates.some((c) => c[0] === BEND[0] && c[1] === BEND[1])).toBe(true);
      expect(Math.abs(t.lengthM - walk(t.coordinates)) <= 2).toBe(true);
    }
    expect(r.problems.some((p) => p.includes('not water-routed'))).toBe(false);
  });

  it('marks them and says so when there is no router', async () => {
    const r = await buildSmartPlanV2({ ...OPTS, askModel: goodModel() });
    const transits = r.plan.legs.filter((l) => l.type === 'transit');
    expect(transits.every((t) => t.unrouted === true)).toBe(true);
    // Both halves: the plan's own warning, and validatePlan's problem. Both reach the screen.
    expect(r.plan.warnings.some((w) => w.includes('straight line'))).toBe(true);
    expect(r.problems.some((p) => p.includes('not water-routed'))).toBe(true);
  });

  it('does not fake a route when the router throws', async () => {
    const r = await buildSmartPlanV2({ ...OPTS, askModel: goodModel(),
                                       routeWater: async () => { throw new Error('502'); } });
    expect(r.plan.legs.filter((l) => l.type === 'transit').every((t) => t.unrouted === true)).toBe(true);
    expect(r.problems.some((p) => p.includes('not water-routed'))).toBe(true);
  });

  it('asks for exactly the pairs the ordered plan walks, once each', async () => {
    const asked = [];
    const cands = [{ start: [-80.72, 34.38], end: [-80.70, 34.38] },
                   { start: [-80.69, 34.39], end: [-80.66, 34.39] }];
    const lookup = await prefetchTransits(cands, [-80.73, 34.38], async (a, b) => {
      asked.push([a, b]);
      return { distanceM: 42, coordinates: [a, b] };
    });
    // Three pairs, not two: launch -> head, tail -> head, and the LAST leg's tail back to the
    // ramp. That third one is the route home, and it became a real leg on 2026-08-09 -- a pair
    // nobody prefetches comes back null, which would leave the one leg he cannot do without as
    // a straight line on every single plan.
    //
    // AND THE PAIRS ARE THE ORIENTED ONES. The second leg here is drawn west-to-east, which would
    // finish the day at [-80.66] and 6519 m from the ramp. Trolled the other way it finishes at
    // [-80.69] and 3835 m out; the extra 2393 m of getting to its far end first is well under the
    // 2684 m saved on the way home, so orientLegs() flips it and the day is 291 m shorter. What
    // matters more than the 291 m is that this function and assemblePlan() now ask the SAME
    // question of the SAME helper -- when this asked for start → end and the assembler trolled
    // end → start, the prefetched pair never matched the pair looked up and the transit fell back
    // to an unrouted straight line.
    expect(asked.length).toBe(3);
    expect(asked[0][0]).toEqual([-80.73, 34.38]);       // launch -> first leg's head
    expect(asked[1][0]).toEqual([-80.70, 34.38]);       // first leg's tail -> second leg's head
    expect(asked[1][1]).toEqual([-80.66, 34.39]);       // ...which is its EAST end, because it flips
    expect(asked[2]).toEqual([[-80.69, 34.39], [-80.73, 34.38]]);   // last leg's tail -> the ramp
    expect(lookup([-80.73, 34.38], [-80.72, 34.38]).distanceM).toBe(42);
    // A pair nobody routed is null, not a guess -- assemblePlan then draws a marked straight line.
    expect(lookup([0, 0], [1, 1])).toBe(null);
  });

  it('hands back nothing rather than a half-empty lookup when no pair answered', async () => {
    expect(await prefetchTransits([{ start: [0, 0], end: [1, 1] }], [2, 2], async () => null)).toBe(null);
    expect(await prefetchTransits([{ start: [0, 0], end: [1, 1] }], [2, 2], undefined)).toBe(null);
  });

  it('posts [lon, lat] to /water/{slug}/route and reads the Worker\'s own field names', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body), method: init.method });
      return { ok: true, json: async () => ({ distance_m: 812, coordinates: [[-80.7, 34.3], [-80.6, 34.4]] }) };
    };
    try {
      const out = await waterRouter('https://w.example', 'wateree_lake')([-80.7, 34.3], [-80.6, 34.4]);
      expect(calls[0].url).toBe('https://w.example/water/wateree_lake/route');
      expect(calls[0].method).toBe('POST');
      expect(calls[0].body).toEqual({ from: [-80.7, 34.3], to: [-80.6, 34.4] });
      expect(out.distanceM).toBe(812);
      expect(out.coordinates.length).toBe(2);
    } finally { delete globalThis.fetch; }
  });

  it('returns null on a 404 — a pack with no water graph is a real state, not a crash', async () => {
    globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: 'no water graph' }) });
    try {
      expect(await waterRouter('https://w.example', 'nowhere')([0, 0], [1, 1])).toBe(null);
    } finally { delete globalThis.fetch; }
  });
});

// ---------------------------------------------------------------------------
// EVERY RUN ACCOUNTED FOR — 2026-08-26
//
// `selection.rejected` exists for one reason: to say why nothing came back. It counted the depth
// rule, the routing flag and the scoring window, and said nothing at all about the spatial
// dedupe -- which is the largest cut in the function.
//
// Measured on the real Wateree pack the day this was written: 1,750 runs considered, 504 cut on
// depth, 639 unroutable, 301 with no scoring window, 22 offered. The remaining 284 were eaten by
// the dedupe and appeared in no bucket, so a thin day read as a depth problem or a routing
// problem when it was neither.
//
// This was already known and already written down. The eligibility fixture above carries the
// note: "That is what happened on the first cut of this test: 55 ft vanished and it looked like
// the suspended rule had rejected it." Diagnosed by hand, twice, because the number was not there
// to read.
// ---------------------------------------------------------------------------
describe('the selection report accounts for every run it was given', () => {
  const near = Array.from({ length: 16 }, (_, k) => ({ s: 200 + k * 240, t: 'hump', d: 25 }));
  const base = { ramp: RAMP, slug: 'w', usableAh: 200, windowMin: 600,
                 fishDepthFt: [0, 99], holding: 'bottom' };

  it('counts the dedupe, which used to remove candidates into silence', () => {
    // Four runs laid on the SAME line. The first is kept and the other three are the same water.
    const stacked = [0, 1, 2, 3].map((i) => run(i, -80.720, 34.380, 4000, near));
    const out = selectCandidates(stacked, base);
    expect(out.length).toBe(1);
    expect(out.selection.rejected.dedupe).toBe(3);
  });

  it('adds up: kept plus every rejection bucket equals what it was handed', () => {
    const mixed = [
      ...[0, 1, 2].map((i) => run(i, -80.720, 34.380, 4000, near)),        // dedupe
      run(3, -80.720, 34.440, 4000, near),                                  // kept
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-80.72, 34.5], [-80.71, 34.5]] },
        properties: { depth_ft: 22, length_m: 900, routable: false, near } }, // unroutable
    ];
    const out = selectCandidates(mixed, base);
    const r = out.selection.rejected;
    expect(out.selection.considered).toBe(mixed.length);
    expect(out.selection.accountedFor).toBe(mixed.length);
    expect(r.unroutable >= 1).toBe(true);
  });

  it('counts the battery and the day, which were also silent continues', () => {
    // A leg that cannot be reached and fished inside the day is a real answer -- "your battery
    // is the constraint" is a different sentence from "there is no water at that depth".
    const far = [run(0, -80.300, 34.380, 8000, near)];
    const out = selectCandidates(far, { ...base, usableAh: 0.5, windowMin: 600 });
    expect(out.length).toBe(0);
    expect(out.selection.rejected.battery + out.selection.rejected.window >= 1).toBe(true);
    expect(out.selection.accountedFor).toBe(1);
  });
});
