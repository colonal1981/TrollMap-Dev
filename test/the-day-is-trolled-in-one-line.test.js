/**
 * the-day-is-trolled-in-one-line.test.js
 *
 * 2026-10-03. Ryan: "Honestly i just troll... i don't jump from spot to spot... i keep an eye on the
 * map to make sure i do not go to shallow for the baits i am running and i just troll", and "there
 * doesn't seem to be an automated way to troll". js/modules/plan-troll-day.js strings Pick Water's
 * pieces into one troll: whole pieces, each started where the last ended, a hop trolled only over
 * water one bait covers and never through a wall or a keep-out zone, lines up only when nothing can be
 * reached, and the day turning home on its own.
 *
 *   node --test test/the-day-is-trolled-in-one-line.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */
import { describe, it, expect } from './expect-shim.mjs';
import { trollDay, barrierIndex, hopShallowestFt } from '../js/modules/plan-troll-day.js';

const LAT = 33.25;
const KX = 111320 * Math.cos(LAT * Math.PI / 180);
const ll = (x, y) => [-80 + x / KX, LAT + y / 110540];
const piece = (key, x0, y0, x1, y1, holdsFt = 40) => {
  const coords = [];
  for (let i = 0; i <= 10; i++) coords.push(ll(x0 + (x1 - x0) * i / 10, y0 + (y1 - y0) * i / 10));
  return { key, runId: `lake#${key}`, coords, holdsFt, lengthM: Math.hypot(x1 - x0, y1 - y0) };
};
const flat = (ft) => () => ft;
const RAMP = ll(0, 0);
const base = { ramp: RAMP, floorFt: 30, windowMin: 600, usableAh: 200 };

describe('one troll, whole pieces, each started where the last ended', () => {
  it('takes the nearest piece the baits can reach, back the other way a bit deeper', () => {
    const pieces = [
      piece('a', 0, 200, 0, 1200, 40),
      piece('b', 30, 1200, 30, 200, 44),        // beside a's far end: back the other way, deeper
      piece('c', 2000, 200, 2000, 1200, 40),    // across the lake
    ];
    const day = trollDay(pieces, { ...base, depthAt: flat(50) });
    expect(day.keys.slice(0, 2)).toEqual(['a', 'b']);
    const hop = day.steps[2];
    expect(hop.kind).toBe('troll');
    expect(hop.m).toBeLessThan(40);
    expect(day.steps[1].m).toBe(1000);           // whole: the piece's full length
  });

  it('does not troll a hop over water shallower than the shallower of the two pieces holds', () => {
    const pieces = [piece('a', 0, 200, 0, 1200, 40), piece('b', 300, 1200, 300, 200, 40)];
    // a 20 ft shoal between them
    const depthAt = ([lon]) => ((lon - -80) * KX > 100 && (lon - -80) * KX < 200 ? 20 : 50);
    const day = trollDay(pieces, { ...base, depthAt });
    expect(day.keys).toEqual(['a', 'b']);
    expect(day.steps[2].kind).toBe('run');        // lines up across it
  });

  it('uncharted water is not deep water', () => {
    expect(hopShallowestFt(ll(0, 0), ll(500, 0), () => null)).toBe(-1);
  });

  it('a piece shallower than the deepest bait is not the day', () => {
    const pieces = [piece('a', 0, 200, 0, 1200, 24), piece('b', 30, 1200, 30, 200, 40)];
    const day = trollDay(pieces, { ...base, depthAt: flat(50) });
    expect(day.keys).toEqual(['b']);
  });
});

describe('never through a wall, never into a keep-out zone', () => {
  const pieces = [piece('a', 0, 200, 0, 1200, 40), piece('b', 200, 1200, 200, 200, 40)];
  const wall = { type: 'Feature', geometry: { type: 'LineString', coordinates: [ll(100, 1300), ll(100, 0)] } };

  it('a hop across the charted shore is not trolled', () => {
    const shore = [wall, { type: 'Feature', geometry: { type: 'LineString', coordinates: [ll(100, 0), ll(-500, 0)] } }];
    const day = trollDay(pieces, { ...base, depthAt: flat(50), barriers: barrierIndex(shore, []) });
    expect(day.steps.filter((s) => s.kind === 'troll').length).toBe(0);
  });

  it('an outline standing free in the water is steered round, not a wall', () => {
    const pier = { type: 'Feature', geometry: { type: 'LineString',
      coordinates: [ll(90, 1150), ll(110, 1150), ll(110, 1250), ll(90, 1250), ll(90, 1150)] } };
    const day = trollDay(pieces, { ...base, depthAt: flat(50), barriers: barrierIndex([pier], []) });
    expect(day.steps[2].kind).toBe('troll');
  });

  it('a hop into a keep-out zone is not trolled', () => {
    const zone = { type: 'Feature', geometry: { type: 'Polygon',
      coordinates: [[ll(80, 1100), ll(120, 1100), ll(120, 1400), ll(80, 1400), ll(80, 1100)]] } };
    const day = trollDay(pieces, { ...base, depthAt: flat(50), barriers: barrierIndex([], [zone]) });
    // the near end of b is through the zone; the hop goes round it to b's far end instead
    expect(day.keys).toEqual(['a', 'b']);
    expect(day.steps[3].reversed).toBe(true);
    expect(day.steps[2].m).toBeGreaterThan(900);
  });

  it('a piece cut AT the wall can still troll away from it', () => {
    const pcs = [piece('a', 0, 200, 100, 1200, 40), piece('b', 100, 1200, 200, 200, 40)];
    const day = trollDay(pcs, { ...base, depthAt: flat(50), barriers: barrierIndex([wall], []) });
    expect(day.keys.length).toBe(2);
  });
});

describe('the day ends at the ramp, and starts where he says', () => {
  it('a piece he could not troll home from in the time left is not taken', () => {
    const pieces = [piece('near', 0, 200, 0, 1200, 40), piece('far', 20, 1300, 20, 9000, 40)];
    // 1.2 km out and a 7.7 km piece: trolling home from 9 km does not fit in 2 hours
    const day = trollDay(pieces, { ...base, windowMin: 120, depthAt: flat(50) });
    expect(day.keys).toEqual(['near']);
  });

  it('starts on the piece he ticked', () => {
    const pieces = [piece('a', 0, 200, 0, 1200, 40), piece('b', 30, 1200, 30, 200, 40), piece('c', 500, 200, 500, 1200, 40)];
    const day = trollDay(pieces, { ...base, depthAt: flat(50), startKey: 'c' });
    expect(day.keys[0]).toBe('c');
  });

  it('a ticked piece that is not water for the day gives an empty day, not a different one', () => {
    const pieces = [piece('a', 0, 200, 0, 1200, 40), piece('shallow', 30, 1200, 30, 200, 12)];
    const day = trollDay(pieces, { ...base, depthAt: flat(50), startKey: 'shallow' });
    expect(day.keys).toEqual([]);
  });

  it('the deepest bait and the sounder are required', () => {
    expect(() => trollDay([], { ramp: RAMP, depthAt: flat(50) })).toThrow();
    expect(() => trollDay([], { ramp: RAMP, floorFt: 30 })).toThrow();
  });
});
