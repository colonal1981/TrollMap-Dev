import { describe, it, expect } from './expect-shim.mjs';
import { buildSmartPlanV2, CANDIDATE_LIMIT } from '../js/modules/smart-plan-v2.js';

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

