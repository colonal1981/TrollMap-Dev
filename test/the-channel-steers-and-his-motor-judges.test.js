/**
 * test/the-channel-steers-and-his-motor-judges.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-09-24, on his boat: *"18 inches or so probably if the pedal drive is down...
 * otherwise 6 inches or less because the nk180pro will kick up"*, the motor at about 12 inches.
 *
 * Routing every landing at his motor's foot was measured before it was made and put MORE of the
 * way out under that foot, not less -- 126 m against 10 from Pack's Landing, 984 against 295 on
 * the Wateree -- because a search indifferent between two feet and twenty takes the margins. So
 * build_ramp_reach.py still steers toward deep water and now MEASURES each drawn route against his
 * foot: `under_motor_m`. This is the app half: it reaches the dropdown text on both tabs, it rides
 * with the route through the collapse, and it says nothing below the tenth of a mile the distance
 * beside it already uses.
 *
 *   node --test test/the-channel-steers-and-his-motor-judges.test.js
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';

const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const REACH = src('../js/data/launch-reach.js');

// shallowAt() and samePlace() are pure; lift them out and run the real code, the way
// the-canal-is-shorter-than-the-crow lifts reachLabel(), rather than importing a module that
// pulls the Worker URL and the lake keys in with it.
const lift = (name) => {
  const m = REACH.match(new RegExp(`export function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`${name}() is not in js/data/launch-reach.js`);
  return m[0].replace('export ', '');
};
const shallowAt = new Function(`${lift('samePlace')}\n${lift('shallowAt')}\nreturn shallowAt;`)();

const PACKS = { name: "Pack's Landing", lat: 33.7461, lon: -80.6252 };

describe('shallowAt() says how far out is under his motor, on the chart', () => {
  it('says nothing under a tenth of a mile -- the resolution of the distance beside it', () => {
    expect(shallowAt([{ ...PACKS, under_motor_m: 10 }], PACKS.lat, PACKS.lon)).toBe('');
    expect(shallowAt([{ ...PACKS, under_motor_m: 159 }], PACKS.lat, PACKS.lon)).toBe('');
  });

  it('a tenth and up, in miles to one decimal, and says it is the chart speaking', () => {
    expect(shallowAt([{ ...PACKS, under_motor_m: 400 }], PACKS.lat, PACKS.lon))
      .toBe('0.2 mi under 1 ft on the chart');
    // The Lower Saluda from Saluda Shoals reads 10,428 m of the 0-1 ft band.
    expect(shallowAt([{ ...PACKS, under_motor_m: 10428 }], PACKS.lat, PACKS.lon))
      .toBe('6.5 mi under 1 ft on the chart');
  });

  it('past ten miles, whole miles -- the same rule reachLabel() keeps', () => {
    expect(shallowAt([{ ...PACKS, under_motor_m: 25612 }], PACKS.lat, PACKS.lon))
      .toBe('16 mi under 1 ft on the chart');
  });

  it('a pack built before the field, or another landing, says nothing', () => {
    expect(shallowAt([{ ...PACKS }], PACKS.lat, PACKS.lon)).toBe('');
    expect(shallowAt([{ ...PACKS, under_motor_m: null }], PACKS.lat, PACKS.lon)).toBe('');
    expect(shallowAt([{ ...PACKS, under_motor_m: 5000 }], PACKS.lat + 0.01, PACKS.lon)).toBe('');
    expect(shallowAt([], PACKS.lat, PACKS.lon)).toBe('');
    expect(shallowAt([{ ...PACKS, under_motor_m: 5000 }], NaN, PACKS.lon)).toBe('');
  });
});

describe('it is wired, and it travels with the route it measures', () => {
  it('collapse() moves it with the route, not with the name', () => {
    const block = REACH.slice(REACH.indexOf('THE ROUTE COMES WITH THE SHORTEST WATER DISTANCE'));
    const carry = block.slice(0, block.indexOf('hit.filed = union'));
    expect(carry.includes('hit.route = r.route;')).toBe(true);
    expect(carry.includes('hit.under_motor_m = r.under_motor_m;')).toBe(true);
  });

  it('the Plan tab puts it on the TEXT, never the value', () => {
    const plan = src('../js/modules/plan-builder.js');
    const fn = plan.slice(plan.indexOf('const optText = (value, lat, lon) =>'));
    expect(fn.slice(0, 400).includes('shallowAt(reach, Number(lat), Number(lon))')).toBe(true);
    // The value line is the 2026-09-17 guard and is untouched.
    expect(/opt\.value = reachLabel\(r\); opt\.textContent = optText\(opt\.value, r\.lat, r\.lon\);/
      .test(plan)).toBe(true);
  });

  it('the map tab asks the same function of the same list', () => {
    const map = src('../js/modules/lake-ramp-select.js');
    expect(map.includes('shallowAt(reach, Number(point.lat), Number(point.lon))')).toBe(true);
    expect((map.match(/function shallowAt\(/g) || []).length).toBe(0);
  });

  it('the producer writes the field the app reads, and stopped writing the one nothing read', () => {
    const py = src('../Scripts/build_ramp_reach.py');
    expect(py.includes("'under_motor_m': (None if not motor_polys or not route")).toBe(true);
    expect(py.includes("'shoal_m':")).toBe(false);
    expect(/^MOTOR_DRAFT_FT = 1\.0$/m.test(py)).toBe(true);
  });
});
