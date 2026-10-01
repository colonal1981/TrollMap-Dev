// Pick Water shows the shallowest to the deepest water on the line.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-09-27: "pick water showing the shallowest to deepest is fine".
//
// A row used to print optionality()'s two medians -- the median of the shallow side and the median
// of the deep side. That was a range only while every lane followed one contour. Since the 9/26
// refit, ledge and hump passes run on into deeper water: the 9/27 leg 5 runs 10 -> 56 -> 14 ft
// under the line and its row read "0.35 mi unbroken, 18.4-28.4 ft of water". His 8/30 rule is
// "One run only if one bait covers it", and that can only be checked against the whole range.
//
// What these hold:
//   1. waterRange() is the line's shallowest and deepest, and the headline prints it -- the
//      shallowest being the sustained floor, the one the bait ceiling and the card use;
//   2. it is today's water when the lake is down;
//   3. a piece with no line profile falls back to the shallowest and deepest of its two sides;
//   4. the row, the slider and the filter read it, not the medians;
//   5. the plan card prints the same two numbers for the leg built from the piece.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from './expect-shim.mjs';
import assert from 'node:assert/strict';
import { waterRange, optionality, reasons } from '../js/modules/plan-water.js';
import { planFromWater } from '../js/modules/plan-from-water.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');

// Leg 5 of 9/27, as a piece: 10 -> 56 -> 14 ft under the line, and the two sides' medians 18/28.
const LEG5 = {
  key: 'l5', runId: 'lake_murray#leg5', lengthM: 560, holdsFt: 8, near: [], chartedFrac: 1,
  envelope: [8, 14, 18, 18, 18, 20, 22, 12],
  envelopeDeep: [12, 24, 28, 28, 30, 58, 28, 16],
  water: { line: { minFt: 10, medianFt: 24, maxFt: 56, sustainedMinFt: 10 },
           side: { minFt: 8, medianFt: 18, maxFt: 22 } },
};

describe('the row says the shallowest and the deepest on the line', () => {
  it('is the line, not the medians of the two sides', () => {
    assert.deepEqual(waterRange(LEG5), { fromFt: 10, toFt: 56 });
    const o = optionality(LEG5);
    assert.deepEqual([o.fromFt, o.toFt], [18, 28], 'the medians the row used to print');
  });

  it('and the headline prints it', () => {
    const r = reasons(LEG5, { minM: 400, partners: [] });
    assert.equal(r.for[0], '0.35 mi unbroken, 10–56 ft of water');
  });

  it('starts at the sustained floor, the one the bait ceiling names', () => {
    // One 50 m station at 6 ft with 12 ft beside it: the ceiling sentence says 12 and calls the
    // 6 one spot, so the range starts at 12 too, and the three numbers cannot disagree.
    const spot = { ...LEG5, water: { line: { minFt: 6, medianFt: 24, maxFt: 56, sustainedMinFt: 12 },
                                     side: { minFt: 5, medianFt: 18, maxFt: 22 } } };
    assert.deepEqual(waterRange(spot), { fromFt: 12, toFt: 56 });
    const r = reasons(spot, { minM: 400, partners: [] });
    assert.equal(r.for[0], '0.35 mi unbroken, 12–56 ft of water');
    assert.ok(r.for.some((x) => /nothing may run deeper than 12 ft/.test(x)), r.for.join(' | '));
  });

  it('in today\'s water when the lake is down', () => {
    const r = reasons(LEG5, { minM: 400, partners: [], todayOffsetFt: 5.5 });
    assert.equal(r.for[0], '0.35 mi unbroken, 4.5–50.5 ft of water');
  });

  it('reads the band against the same water', () => {
    // 10-56 reaches below and above a 15-40 band, so all of the band is on this piece.
    const r = reasons(LEG5, { minM: 400, partners: [], fishBandFt: [15, 40] });
    assert.ok(r.for.includes('15–40 ft of it sits inside the 15–40 ft band the research puts the fish at'),
      r.for.join(' | '));
    // and water that tops out above the band is still objected to, on its deepest point
    const shallow = { ...LEG5, water: { line: { minFt: 4, medianFt: 7, maxFt: 9 }, side: null } };
    const s = reasons(shallow, { minM: 400, partners: [], fishBandFt: [15, 40] });
    assert.ok(s.against.some((x) => /tops out at 9 ft/.test(x)), s.against.join(' | '));
  });

  it('falls back to the two sides when a pack has no line profile', () => {
    const old = { ...LEG5, water: null };
    assert.deepEqual(waterRange(old), { fromFt: 8, toFt: 58 });
    assert.deepEqual(waterRange({ envelope: [-1, 22, 23], envelopeDeep: null }), { fromFt: 22, toFt: 23 },
      'an unsounded station is not a depth, and no deep side reads the shallow one');
    assert.deepEqual(waterRange({ envelope: [] }), { fromFt: null, toFt: null });
  });
});

describe('the row, the slider and the filter read the same range', () => {
  it('corridorOf() is waterRange(), not optionality()', () => {
    const ui = src('js/modules/plan-water-ui.js');
    const body = ui.slice(ui.indexOf('function corridorOf('), ui.indexOf('function tf('));
    assert.match(body, /waterRange\(p\)/);
    assert.doesNotMatch(body, /optionality\(/);
  });
});

describe('the plan card prints the same two numbers', () => {
  it('a leg built from the piece carries the row\'s range', async () => {
    const piece = { ...LEG5, coords: [[-81.30, 34.06], [-81.297, 34.062], [-81.294, 34.064]],
                    partners: [] };
    const r = await planFromWater({
      picked: [piece], ramp: [-81.301, 34.059], slug: 'lake_murray',
      usableAh: 80, windowMin: 300, launchTime: '06:00', returnTime: '15:00',
      planArgs: { water: 'Lake Murray, SC', species: ['Striped Bass'], tackle: [] },
      askModel: async () => JSON.stringify({
        loadout: { rods: [{ id: 'R1', lure: 'x', leadFt: 40, role: 'troll' }] },
        legs: [{ runId: piece.runId, speedMph: 2, deploy: { port: 'R1', starboard: null } }],
        stops: [], changes: [], notes: {},
      }),
    });
    const leg = r.plan.legs.find((l) => l.type === 'troll');
    const w = waterRange(piece);
    assert.deepEqual([leg.depthMinFt, leg.depthMaxFt], [w.fromFt, w.toFt]);
  });
});
