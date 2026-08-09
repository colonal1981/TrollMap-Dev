import { describe, it, expect } from './expect-shim.mjs';
import { buildSmartPlanV2, CANDIDATE_LIMIT, prefetchTransits, waterRouter } from '../js/modules/smart-plan-v2.js';
import { metresBetween } from '../js/modules/plan-candidates.js';

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
  species: 'Striped Bass', depthFt: [15, 40], usableAh: 80, windowMin: 540,
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
    const r = await buildSmartPlanV2({ ...OPTS, depthFt: [200, 300],
                                       askModel: async () => { throw new Error('must not be called'); } });
    expect(r.plan).toBe(null);
    expect(r.problems[0].includes('reachable from this ramp')).toBe(true);
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
    expect(asked.length).toBe(3);
    expect(asked[0][0]).toEqual([-80.73, 34.38]);       // launch -> first leg's head
    expect(asked[1][0]).toEqual([-80.70, 34.38]);       // first leg's tail -> second leg's head
    expect(asked[2]).toEqual([[-80.66, 34.39], [-80.73, 34.38]]);   // last leg's tail -> the ramp
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
