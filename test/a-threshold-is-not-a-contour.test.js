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
// Smart Plan never had it: plan-candidates.js sets `depthFt: p.depth_ft`, the charted contour.
// One more place the two planners meant different things by the same field name.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from './expect-shim.mjs';
import { planFromWater } from '../js/modules/plan-from-water.js';
import { describeDepthBand } from '../js/modules/plan-inputs.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');
const live = (js) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// The real numbers off wateree_lake#362, as a picked piece.
const PIECE = {
  key: 'w0', runId: 'wateree_lake#362',
  coords: [[-80.7360, 34.3819], [-80.7290, 34.3760], [-80.7220, 34.3713]],
  lengthM: 1961, laneLengthM: 1962,
  chartedFt: 15.1,          // the line the lane follows
  shallowestLineFt: 12.1,   // how shallow that line gets
  holdsFt: 6,               // deepest bait that runs it unbroken, off the SHALLOW SIDE of the
                            // wander -- the bank 25 m away, not the water under the boat
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

describe('the leg depth is the line it follows, not the one shoal on it', () => {
  it('takes the charted contour, rounded', async () => {
    const r = await build();
    const leg = r.plan.legs.find((l) => l.type === 'troll');
    expect(leg.depthFt).toBe(15);
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
    expect(said.includes('12.1 ft')).toBe(true);
    expect(said.includes('6 ft')).toBe(false);
    const t = live(src('js/modules/plan-from-water.js'));
    expect(t).toMatch(/depthFt: Number\.isFinite\(piece\.chartedFt\)/);
    expect(t).toMatch(/maxRunDepthFt: Number\.isFinite\(piece\.shallowestLineFt\)/);
  });

  it('falls back to holdsFt when the pack stamped no line depth', async () => {
    const r = await withDeepBait([{ ...PIECE, shallowestLineFt: null }]);
    const said = r.problems.find((w) => /shallowest water on this leg/.test(w));
    expect(said.includes('6 ft')).toBe(true);
  });

  it('falls back to holdsFt only when the pack charted no depth at all', async () => {
    const r = await build({ picked: [{ ...PIECE, chartedFt: null }] });
    expect(r.plan.legs.find((l) => l.type === 'troll').depthFt).toBe(6);
  });

  it('agrees with Smart Plan, which reads the same field off the pack', () => {
    expect(live(src('js/modules/plan-candidates.js'))).toMatch(/depthFt: p\.depth_ft/);
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
