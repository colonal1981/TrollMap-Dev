// Personal use only, not for distribution or resale; not for navigation.
//
// EVERY DEPTH HE READS AGAINST THE SOUNDER IS TODAY'S, AND PICK WATER SENDS THE HOP TABLES.
//
// Ryan's 9/27 Murray plan, with the lake 5.56 ft below full pool:
//   - the leg card said "27–54 ft under the boat · median 34" directly above a bottom note that
//     said the bottom was 21.4 ft today;
//   - the GPX named a ledge "ledge 47ft" over 41 ft of water, the track "L1 · 34 ft", and the
//     Contour alarm cue "L1 29-39ft" -- a band the boat would have sat under the whole pass.
// And Claude, handed the Pick Water request for that day: "I cannot total the hops myself because
// the per-leg transit table was not in the data" -- the prompt describes `transitToM` and
// `transitToMIfFishedBack` and Pick Water sent neither.
// Ryan: "go ahead and fix those 3".
import { describe, it, expect } from './expect-shim.mjs';
import { planFromWater } from '../js/modules/plan-from-water.js';
import { planToTimeline } from '../js/modules/plan-to-timeline.js';
import { trackName, stopName, stopUnit, planWaypoints, planCueLines } from '../js/modules/plan-tracks.js';
import { buildGPX } from '../js/utils/parsers.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';

const DD = 5.56;
const legOf = (dd) => ({
  id: 'L1', type: 'troll', depthFt: 34, depthMinFt: 27, depthMaxFt: 54, drawdownFt: dd,
  runId: 'lake_murray#12606', startM: 0, lengthM: 900,
  coordinates: [[-81.3200, 34.0877], [-81.3100, 34.0878]],
  marks: [{ id: 'm1', type: 'ledge', depthFt: 46.9, at: [-81.3150, 34.0870], atM: 450, charted: true }],
  stops: [{ id: 'S1.1', structureType: 'hump', depthFt: 42, at: [-81.3105, 34.0880], atM: 860 }],
});
const planOf = (dd) => ({ legs: [legOf(dd)] });
const LAUNCH = [-81.3289, 34.0943];

describe('the GPX carries the depth the sounder will read', () => {
  it('names the track by today\'s median', () => {
    expect(trackName(legOf(DD))).toBe('L1 · 28 ft');
    expect(trackName(legOf(undefined))).toBe('L1 · 34 ft');
  });

  it('names a stop by today\'s depth of the thing it stops on', () => {
    // His unit keeps ten characters of a name (2026-09-28), so the depth is in the comment.
    expect(stopName(legOf(DD).stops[0], DD)).toBe('S1.1 hump');
    expect(stopUnit(legOf(DD).stops[0], DD).cmt).toBe('hump 36ft');
    expect(stopUnit(legOf(DD).stops[0]).cmt).toBe('hump 42ft');
  });

  it('names a charted mark by today\'s depth and keeps the chart\'s in the note', () => {
    const w = planWaypoints(planOf(DD), LAUNCH, 'r', { marks: true }).find((x) => x.chartMark);
    expect(w.name).toBe('ledge 41ft');
    expect(w.depth).toBe(41.3);
    expect(w.chartDepth).toBe(46.9);
    expect(w.tacticalNote).toMatch(/46\.9 ft on the chart, 41\.3 ft today with the lake 5\.56 ft below the level its chart was made at/);
  });

  it('and with no level published the chart stands, unannotated', () => {
    const w = planWaypoints(planOf(undefined), LAUNCH, 'r', { marks: true }).find((x) => x.chartMark);
    expect(w.name).toBe('ledge 47ft');
    expect(w.tacticalNote).toBe('charted position — compare with the sounder');
  });

  it('the stop waypoint\'s depth is today\'s too, so the GPX comment matches its name', () => {
    const w = planWaypoints(planOf(DD), LAUNCH, 'r').find((x) => x.castingStop);
    expect(w.name).toBe('S1.1 hump');
    expect(w.cmt).toBe('hump 36ft');
    expect(buildGPX({ waypoints: [w], tracks: [], routes: [] })).toMatch(/<cmt>hump 36ft<\/cmt>/);
    expect(w.depth).toBe(36.4);
    expect(w.chartDepth).toBe(42);
  });

  it('sets the Contour alarm band around today\'s water', () => {
    const plan = planOf(DD);
    const cues = planCueLines(plan, planWaypoints(plan, LAUNCH, 'r'), 'r');
    const band = cues.find((c) => /^L1 /.test(c.name));
    expect(band.name).toBe('L1 23-33ft');
  });
});

describe('the leg card says what is under the boat today', () => {
  const PIECE = {
    key: 'w0', runId: 'wateree_lake#362',
    coords: [[-80.7360, 34.3819], [-80.7290, 34.3760], [-80.7220, 34.3713]],
    lengthM: 720, laneLengthM: 1962,
    water: { line: { minFt: 17, medianFt: 23, maxFt: 25 }, side: { minFt: 16, medianFt: 20, maxFt: 25 } },
    holdsFt: 12, near: [], partners: [],
  };
  const build = () => planFromWater({
    picked: [PIECE], ramp: [-80.7288, 34.3793], slug: 'wateree_lake',
    usableAh: 80, windowMin: 300, launchTime: '06:00', returnTime: '15:00',
    planArgs: { water: 'Lake Wateree, SC', species: ['Striped Bass'], tackle: [] },
    askModel: async () => JSON.stringify({
      loadout: { rods: [{ id: 'R1', lure: 'x', leadFt: 80, role: 'troll' }] },
      legs: [{ runId: 'wateree_lake#362', speedMph: 2, deploy: { port: 'R1', starboard: null } }],
      stops: [], changes: [], notes: {},
    }),
  });

  it('as the chart less the drawdown, with "today" on it', async () => {
    const r = await build();
    // What assemblePlan() stamps on a troll leg when the lake publishes a level.
    for (const l of r.plan.legs) if (l.type === 'troll') l.drawdownFt = 3.4;
    const card = planToTimeline(r.plan, { depthBand: [15, 27] }).timeline
      .find((e) => e.type === 'troll' && e.legType !== 'transit');
    expect(card.desc).toMatch(/13\.6–21\.6 ft under the boat today · median 19\.6/);
  });

  it('and without a level it is the chart, and does not claim to be today', async () => {
    const r = await build();
    const card = planToTimeline(r.plan, { depthBand: [15, 27] }).timeline
      .find((e) => e.type === 'troll' && e.legType !== 'transit');
    // 2026-09-27: it SAYS it is the chart -- every lake whose chart level his sounder has not
    // measured lands here now, and Ryan's call for those was the chart as it stands, said so.
    expect(card.desc).toMatch(/17–25 ft on the chart · median 23/);
    expect(card.desc).not.toMatch(/today/);
  });
});

describe('Pick Water sends the hop tables its prompt describes', () => {
  const piece = (key, lon, lat) => ({
    key, runId: `wateree_lake#${key}`, lengthM: 1800, laneLengthM: 4000, holdsFt: 22,
    coords: Array.from({ length: 40 }, (_, i) => [lon + i * 0.0004, lat + i * 0.00012]),
    near: [], partners: [], reasons: { for: ['1.1 mi unbroken'], against: [] },
    envelope: Array(20).fill(24), envelopeStepM: 90, chartedFrac: 1,
  });
  const A = piece(81, -80.70, 34.35), B = piece(82, -80.69, 34.36);

  it('every leg carries transitToM and transitToMIfFishedBack to every other leg', async () => {
    let asked = null;
    await planFromWater({
      picked: [A, B], spots: [], ramp: [-80.7107, 34.3486], slug: 'wateree_lake', usableAh: 80,
      windowMin: 480, launchTime: '06:30', returnTime: '13:00',
      askModel: async (req) => {
        asked = req;
        return JSON.stringify({ loadout: { rods: [{ id: 'R1', lure: '3" Lipless Crankbait', role: 'troll', leadFt: 60 }] },
          legs: [A, B].map((p) => ({ runId: p.runId, speedMph: 2, deploy: { port: 'R1', starboard: 'R1' } })),
          stops: [], changes: [] });
      },
      tackle: TACKLE_INVENTORY.filter((l) => l.trollable).map((l) => l.name),
      planArgs: { water: 'Lake Wateree, SC', species: ['Striped Bass'], conditions: {} },
    });
    const cands = JSON.parse(asked.user.split('\n').find((l) => l.startsWith('[{"runId"')));
    expect(cands.length).toBe(2);
    for (const c of cands) {
      const other = cands.find((x) => x.runId !== c.runId).runId;
      expect(Number.isFinite(c.transitToM[other])).toBe(true);
      expect(Number.isFinite(c.transitToMIfFishedBack[other])).toBe(true);
    }
    // Fished back, A ends where it started, which is further from B's start than A's far end is.
    const a = cands.find((c) => c.runId === A.runId);
    expect(a.transitToMIfFishedBack[B.runId] > a.transitToM[B.runId]).toBe(true);
  });
});
