// A THRESHOLD IS NOT A CONTOUR, AND THE CARD CALLED IT THE TARGET.
//
// Ryan, 2026-08-30, on a Pick Water day for Lake Wateree: "this thing is completely broken.... if
// the water is only 20 feet how is the target 20-25ft... this thing still has no understanding of
// suspended fish."
//
// The leg was `wateree_lake#362`. Measured off the pack that day:
//
//     depth_ft 15.1   shallowest_ft 7.0   deepest_ft 24.9   mean_depth_ft 20.0
//     envelope_ft (50 stations) min 7 max 25
//
// Pick Water's own row described it correctly -- "1.2 mi unbroken, 17-24 ft of water ... nothing
// may run deeper than 6 ft here, that is the shallowest water within a wander anywhere on the
// 1.2 mi, AND IT IS ONE SPOT, NOT THE WHOLE STRETCH". Then plan-from-water.js set BOTH `depthFt`
// and `maxRunDepthFt` to that one spot, and the card printed "The 6 ft line" and "Target Depth
// 6ft" over 17-24 ft of water, with three warnings that every crankbait aboard was "the wrong
// bait for this pass".
//
// Smart Plan never had it: plan-candidates.js set `depthFt: p.depth_ft`, the charted contour.
// One more place the two planners meant different things by the same field name.
//
// AND THE CONTOUR WAS NOT THE ANSWER EITHER. Ryan, the same day, on being shown the fitted lanes:
// "a contour is 1 singular depth... so you can't be using the same countor????" He is right --
// fit_trolling_runs.py smooths a contour into something a kayak can follow, and the result sits a
// median 29-51 m off the line it is named for, up to 224 m. Told the fitting is deliberate,
// because tracing a contour makes "very short very curved and unfollowable lines", he wrote the
// replacement: "it runs from 25-32 ft median 29 shallowest is 25ft deepest is 32 allows me to know
// that the lure depth that is chosen is right or wrong."
//
// So the leg is described by the depth profile along the line the boat will steer, measured on the
// stations the piece was TRIMMED to. #362 again, all four answers for the same leg:
//
//     "The 6 ft line"     holdsFt -- a bait depth, and the shallowest spot on the whole pass
//     "The 15 ft line"    depth_ft -- the name of the contour it was cut from
//     "The 12 ft line"    shallowest_line_ft -- the whole pass, including water this leg skips
//     17-25 ft, median 23 what is under the boat on the 720 m the app actually offers
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from './expect-shim.mjs';
import { planFromWater } from '../js/modules/plan-from-water.js';
import { waterBand } from '../js/modules/plan-pieces.js';
import { planToTimeline } from '../js/modules/plan-to-timeline.js';
import { describeDepthBand } from '../js/modules/plan-inputs.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');
const live = (js) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// The real numbers off wateree_lake#362, as a picked piece. `water` is what waterBand() returns
// for the 720 m stretch buildPieces() trims this 2 km pass down to -- NOT the whole pass, whose
// line runs 13-25 and whose shallow side touches 7 ft on a shoal the piece stops short of.
const PIECE = {
  key: 'w0', runId: 'wateree_lake#362',
  coords: [[-80.7360, 34.3819], [-80.7290, 34.3760], [-80.7220, 34.3713]],
  lengthM: 720, laneLengthM: 1962,
  water: { line: { minFt: 17, medianFt: 23, maxFt: 25 },
           side: { minFt: 16, medianFt: 20, maxFt: 25 } },
  holdsFt: 12,              // deepest bait that runs it unbroken, off the SHALLOW SIDE of the
                            // wander -- 16 ft less the 4 ft of clearance the pick was made with
  near: [], partners: [],
};

const build = (extra = {}) => planFromWater({
  picked: [PIECE], ramp: [-80.7288, 34.3793], slug: 'wateree_lake',
  usableAh: 80, windowMin: 300, launchTime: '06:00', returnTime: '15:00',
  planArgs: { water: 'Lake Wateree, SC', species: ['Striped Bass'], tackle: [] },
  askModel: async () => JSON.stringify({
    loadout: { rods: [{ id: 'R1', lure: 'x', leadFt: 80, role: 'troll' }] },
    legs: [{ runId: 'wateree_lake#362', speedMph: 2,
             deploy: { port: 'R1', starboard: null } }],
    stops: [], changes: [], notes: {},
  }),
  ...extra,
});

describe('the leg depth is the water under it, not one shoal and not a contour name', () => {
  it('reports the range and the median of it', async () => {
    const r = await build();
    const leg = r.plan.legs.find((l) => l.type === 'troll');
    expect(leg.depthFt).toBe(23);
    expect(leg.depthMinFt).toBe(17);
    expect(leg.depthMaxFt).toBe(25);
  });

  it('and the card says so instead of naming a contour', async () => {
    const r = await build();
    const built = planToTimeline(r.plan, { depthBand: [15, 27] });
    const leg = built.timeline.find((e) => e.type === 'troll' && e.legType !== 'transit');
    expect(leg.desc).toMatch(/17–25 ft under the boat · median 23/);
    expect(leg.desc).not.toMatch(/ft line/);
    expect(leg.depthMin).toBe(17);
    expect(leg.depthMax).toBe(25);
    // and the fish band is still its own number, in its own field
    expect(leg.speciesBandFt).toEqual([15, 27]);
  });

  it('measures on the stations the piece was trimmed to, not on the whole pass', () => {
    // Station 0 is a 3 ft shoal. A piece that starts at station 5 never crosses it, and saying
    // "3 ft" about that leg is the same fault as "The 6 ft line" pointed the other way -- it
    // condemns baits over water the boat does not go near. Measured on Wateree: 41 of 70 pieces
    // read shallower off the whole pass than off themselves, by up to 8 ft.
    const props = { envelope_step_m: 40,
                    envelope_line_ft: [3, 4, 6, 9, 14, 20, 21, 22, 23, 24],
                    envelope_ft: [3, 3, 5, 8, 12, 18, 19, 20, 21, 22] };
    expect(waterBand(props, 200, 360).line).toEqual({ minFt: 20, medianFt: 22, maxFt: 24 });
    expect(waterBand(props, 0, 360).line.minFt).toBe(3);
  });

  it('drops uncharted stations rather than counting them as zero', () => {
    const props = { envelope_step_m: 40,
                    envelope_line_ft: [-1, 20, 24, -1],
                    envelope_ft: [-1, 18, 22, -1] };
    expect(waterBand(props, 0, 120).line).toEqual({ minFt: 20, medianFt: 20, maxFt: 24 });
  });

  it('says nothing at all when the pack carried no profile', () => {
    expect(waterBand({ envelope_step_m: 40 }, 0, 100)).toBe(null);
    expect(waterBand({ envelope_step_m: 40, envelope_line_ft: [-1], envelope_ft: [-1] }, 0, 40))
      .toBe(null);
  });

  // The ceiling is not emitted on the leg, so it is read where it is felt: the warning
  // capBaitDepth writes names it. A DD3 runs to 25 ft and is over the ceiling either way; what
  // the sentence says the ceiling IS, is the thing under test.
  const DD3 = TACKLE_INVENTORY.find((l) => l.type === 'crankbait_dd3');
  const SR = TACKLE_INVENTORY.find((l) => l.type === 'crankbait_sr');
  const withDeepBait = (picked) => build({
    picked,
    tackle: [DD3.name, SR.name],
    connectionOf: () => 'tie',
    planArgs: { water: 'Lake Wateree, SC', species: ['Striped Bass'],
                tackle: [DD3.name, SR.name] },
    lureByName: (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null,
    askModel: async () => JSON.stringify({
      loadout: { rods: [{ id: 'R1', lure: DD3.name, rig: 'fluoro', role: 'troll', leadFt: 100 },
                        { id: 'R2', lure: SR.name, rig: 'fluoro', role: 'troll', leadFt: 40 }] },
      legs: [{ runId: 'wateree_lake#362', speedMph: 2,
               deploy: { port: 'R1', starboard: 'R2' } }],
      stops: [], changes: [], notes: {},
    }),
  });

  it('ceilings the bait on the LINE, not on the bank 25 m off it', async () => {
    // `envelope_ft` is the shallowest water within 25 m of the line -- a wander warning. A
    // channel edge always has shallower water beside it; that is what makes it an edge. Sizing
    // the bait with it condemned every crankbait on a lane whose line never comes above 13 ft.
    const r = await withDeepBait([PIECE]);
    const said = r.problems.find((w) => /shallowest water on this leg/.test(w));
    expect(said.includes('17 ft')).toBe(true);
    expect(said.includes('16 ft')).toBe(false);   // the shallow side, 25 m off the line
    expect(said.includes('12 ft')).toBe(false);   // the whole pass, including water this leg skips
    const t = live(src('js/modules/plan-from-water.js'));
    expect(t).toMatch(/maxRunDepthFt: line \? line\.minFt : piece\.holdsFt/);
  });

  it('falls back to holdsFt when the pack stamped no profile', async () => {
    const r = await withDeepBait([{ ...PIECE, water: null }]);
    const said = r.problems.find((w) => /shallowest water on this leg/.test(w));
    expect(said.includes('12 ft')).toBe(true);
    const leg = r.plan.legs.find((l) => l.type === 'troll');
    expect(leg.depthFt).toBe(12);
    expect(leg.depthMinFt).toBe(null);
  });

  it('agrees with Smart Plan, which calls the same function on the window it chose', () => {
    const c = live(src('js/modules/plan-candidates.js'));
    expect(c).toMatch(/import \{ waterBand \} from '\.\/plan-pieces\.js'/);
    expect(c).toMatch(/waterBand\(p, win\.startM, win\.startM \+ win\.lengthM\)/);
    expect(c).toMatch(/depthFt: band \? band\.line\.medianFt : p\.depth_ft/);
    // and it now sends a ceiling, which it never did -- plan-prompt.js has explained
    // `maxRunDepthFt` to the model since it was written and only Pick Water ever supplied one.
    expect(c).toMatch(/maxRunDepthFt: band \? band\.line\.minFt : null/);
    expect(c).toMatch(/maxRunDepthFt: c\.maxRunDepthFt/);
  });
});

describe('the card says which depth is which', () => {
  const ui = live(src('js/modules/smart-plan-ui.js'));
  const t2t = live(src('js/modules/plan-to-timeline.js'));

  it('the water tile is labelled as water, not as the target', () => {
    expect(ui.includes('>Water on this leg</div>')).toBe(true);
    expect(ui.includes('>Target Depth</div>')).toBe(false);
  });

  it('and the fish band sits under it, with what the fish are doing', () => {
    expect(ui).toMatch(/entry\.speciesBandFt/);
    expect(ui).toMatch(/entry\.holding/);
    expect(t2t).toMatch(/holding,/);
  });

  it('the warnings the app already wrote reach the leg they name', () => {
    // They went to console.warn on the Pick Water path and nowhere else.
    expect(t2t).toMatch(/warnings: leg\.runId \? legWarnings\.filter/);
    expect(ui).toMatch(/\(entry\.warnings \|\| \[\]\)\.length/);
    for (const f of ['js/modules/plan-water-ui.js', 'js/modules/smart-plan-v2-wiring.js']) {
      expect(live(src(f))).toMatch(/warnings: r\.problems \|\| \[\]/);
    }
  });
});

describe('what holding means, said in words, to both planners', () => {
  const band = (holding) => describeDepthBand({ band: [15, 27], holding }, 'Striped Bass', 'summer');

  it('suspended says the water only has to be deeper than the fish', () => {
    expect(band('suspended').note).toMatch(/depth of water is not the target/);
    expect(band('suspended').note.includes('15–27 ft')).toBe(true);
  });

  it('bottom says the opposite, in the same place', () => {
    expect(band('bottom').note).toMatch(/the depth of water IS the target/);
  });

  it('both names the ambiguity instead of resolving it', () => {
    expect(band('both').note).toMatch(/BOTH hugging the bottom and suspended/);
    expect(band('both').note).toMatch(/watch the sounder/);
  });

  it('unknown says the test being used is only right for bottom fish', () => {
    expect(band(null).note).toMatch(/only right if they are on the bottom/);
    expect(band(null).holding).toBe('unknown');
  });

  it('and BOTH planners build it here rather than each their own', () => {
    for (const f of ['js/modules/plan-water-ui.js', 'js/modules/smart-plan-v2-wiring.js']) {
      expect(live(src(f))).toMatch(/describeDepthBand\(/);
    }
    // the stub Pick Water used to send is gone
    expect(live(src('js/modules/plan-water-ui.js')))
      .not.toMatch(/depthBand: \{ ft: T\.band/);
  });
});
