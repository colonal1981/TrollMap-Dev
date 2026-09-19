import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');
const live = (js) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const noop = () => {};
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, dataset: {} }), addEventListener: noop, readyState: 'complete',
};
const { planToTimeline } = await import('../js/modules/plan-to-timeline.js');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE LEG CARD PRINTED A RANGE NOBODY STATED, AFTER THE PROMPT HAD STOPPED
//
// 8760a66 fixed the note the MODEL reads: it no longer ends an evidence caveat by handing the
// inferred range back as a fish depth. Then Ryan ran a plan and said:
//
//   "so i still see a thing about 0-5ft suspended on troll legs"
//
// He was reading the LEG CARD — the third place this claim gets made, and the only one of the
// three he looks at on the water. smart-plan-ui.js built "fish 0–5 ft · suspended" from
// `speciesBandFt` and `holding` alone, in the same words it uses for a range a source gave out
// loud, over a leg whose own water runs 13–21 ft. The evidence was never passed to it.
//
// The POSITION survives — a quote can evidence "suspended" and give no number, and it is what
// tells him whether to fish the column or the floor. The RANGE does not.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const LINE = [[-80.70, 34.40], [-80.70, 34.41]];
const PLAN = () => ({
  meta: { water: 'Congaree River, SC', ramp: 'Bates Bridge', date: '2026-09-19',
          launchTime: '06:00', returnTime: '15:00', species: ['Largemouth Bass'] },
  loadout: { rods: [{ id: 'R1', lure: 'Squarebill Crankbait', color: 'Chartreuse Shad',
                      role: 'troll', leadFt: 15 }] },
  legs: [{ id: 'L1', type: 'troll', runId: 'congaree_river:drift:channel@127500',
           startM: 0, lengthM: 6500, depthFt: 16, depthMinFt: 13, depthMaxFt: 21,
           speedMph: 2.8, coordinates: LINE, start: LINE[0], end: LINE[1],
           deploy: { port: 'R1' }, stops: [] }],
  stops: [], changes: [],
});
// THE TIMELINE ENTRY, NOT THE CARD. planToTimeline returns both: `cards` is the bare card and
// `timeline` is the enriched entry, and it is the entry smart-plan-ui.js renders -- `speciesBandFt`
// and `holding` only ever existed on that one.
const troll = (opts) => planToTimeline(PLAN(), opts).timeline.find((e) => e.legType === 'troll');

describe('the card is told whether the band was measured', () => {
  it('marks a band cited to a sentence with no depth in it as not stated', () => {
    const c = troll({ depthBand: [0, 5], holding: 'suspended',
                      fishDepthEvidence: 'quote-has-no-depth' });
    expect(c.speciesBandFt).toEqual([0, 5]);   // the band still travels; it is still the best guess
    expect(c.bandEvidence).toBe('quote-has-no-depth');
    expect(c.bandStated).toBe(false);
    // The position is a separate claim and it survives.
    expect(c.holding).toBe('suspended');
  });

  it('marks a band a source actually gave as stated', () => {
    const c = troll({ depthBand: [15, 27], holding: 'suspended', fishDepthEvidence: 'stated' });
    expect(c.bandStated).toBe(true);
  });

  it('treats a caller that says nothing as not stated, never as measured', () => {
    // The Pick Water path passes no evidence and its own T.depth has never been set, so a band
    // arriving from there is vouched for by nobody. Defaulting the other way would print exactly
    // the sentence this file exists to stop.
    const c = troll({ depthBand: [0, 5], holding: 'suspended' });
    expect(c.bandStated).toBe(false);
    expect(c.bandEvidence).toBe(null);
  });

  it('and the one-number and no-citation cases are not stated either', () => {
    for (const ev of ['one-number', 'no-citation']) {
      expect(troll({ depthBand: [3, 15], holding: 'bottom', fishDepthEvidence: ev }).bandStated)
        .toBe(false);
    }
  });
});

describe('and the label does not put the number in front of him', () => {
  const ui = live(src('js/modules/smart-plan-ui.js'));

  it('prints the range only on the stated branch', () => {
    // The stated branch is the ONLY place the two numbers appear in this label.
    expect(/`fish \$\{bandFt\[0\]\}–\$\{bandFt\[1\]\} ft`/.test(ui)).toBe(true);
    const unstated = ui.slice(ui.indexOf('entry.bandStated === false'),
                              ui.indexOf('`fish ${bandFt[0]}'));
    expect(/bandFt\[0\]|bandFt\[1\]/.test(unstated)).toBe(false);
  });

  it('says the holding position and sends him to the sounder instead', () => {
    expect(/depth not stated, read the sounder/.test(ui)).toBe(true);
    expect(/fish \$\{holdWord\} — depth not stated/.test(ui)).toBe(true);
  });

  it('and still says nothing at all when there is no band to talk about', () => {
    expect(/const bandLabel = !bandFt \? ''/.test(ui)).toBe(true);
  });
});

describe('the evidence reaches the card from the planner, not from a guess', () => {
  const w = live(src('js/modules/smart-plan-v2-wiring.js'));

  it('both timeline calls on the v2 path pass fishDepthEvidence', () => {
    expect((w.match(/fishDepthEvidence: fishDepthEvidence\(depth\)/g) || []).length).toBe(2);
  });

  it('and it is the same function the prompt note is built with', () => {
    // One definition of "did a source state a fish depth", in plan-inputs.js, read by both the
    // sentence the model gets and the label Ryan reads.
    expect(/fishDepthEvidence.*from '\.\/plan-inputs\.js'/s.test(w)).toBe(true);
    expect(/export function fishDepthEvidence/.test(src('js/modules/plan-inputs.js'))).toBe(true);
  });
});
