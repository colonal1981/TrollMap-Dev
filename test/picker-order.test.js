import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A GROUP IS ORDERED BY WHAT IT SAYS, NOT BY WHEN IT WAS COLLECTED
//
// Ryan, 2026-09-04, on Richard B Russell in the map bar: "its at the bottom of the SC list not
// alphabetically where it should have been."
//
// Two modules disagreed about which state that lake is in, and both were reasonable:
//
//   access-index.js  sorts `lakeNames` with lakeStatePriority(), off the NAME's suffix.
//                    "Lake Richard Russell, GA" -> GA -> after every SC name.
//   lake-ramp-select buckets with stateOf(name, rec), off the REGISTRY RECORD.
//                    richard_b_russell_lake is "(Abbeville Co, SC/GA)" -> SC.
//
// Sorted by one, grouped by the other, and the render loop never sorted the bucket -- so the row
// was correctly placed in "SC — Lakes" and arrived after everything already in it.
//
// This imports the real module rather than restating its rules. That needs an `L` and a
// `document`, because lake-ramp-select reaches Leaflet through contour-data.js:140 at module
// scope and wires its filter bar on import -- the same two stubs Scripts/which_profile_serves.mjs
// carries. lake-picker-groups.test.js re-implements the pure decisions "from the SOURCE OF TRUTH
// constants rather than imported" for exactly this reason; it no longer has to.
// ─────────────────────────────────────────────────────────────────────────────────────────────
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (typeof globalThis.L === 'undefined') {
  const anything = new Proxy(function () {}, {
    get: () => anything, apply: () => anything, construct: () => anything,
  });
  globalThis.L = anything;
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, dataset: {}, appendChild() {}, setAttribute() {},
                            addEventListener() {}, classList: { add() {}, remove() {} } }),
    addEventListener: () => {}, body: { appendChild() {} },
  };
  globalThis.window.document = globalThis.document;
}
// AND A FETCH, or the import never returns: access-index.js loads the four DNR feeds at module
// scope and node has no network here. Every request answers "nothing", which builds an empty
// index -- fine, because the two functions under test are pure and read no index at all.
if (typeof globalThis.fetch === 'undefined' || !globalThis.__pickerOrderStub) {
  globalThis.__pickerOrderStub = true;
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({}), text: async () => '{}',
  });
}
const { sortForDisplay, pickerLabel } = await import('../js/modules/lake-ramp-select.js');

describe('the picker orders a group by the row a person reads', () => {
  // The SC — Lakes neighbourhood Richard Russell belongs in, in the order access-index hands
  // them over: every SC-suffixed name first, then the GA-suffixed one that the registry places
  // in South Carolina.
  const AS_COLLECTED = [
    'Lake Robinson (Greer), SC',
    'Lake Marion, SC',
    'Lake Murray, SC',
    'Lake Rhodhiss, SC',
    'Lake Wateree, SC',
    'Lake Richard Russell, GA',      // pushed last -- sorted as GA, grouped as SC
  ];

  it('puts the border lake where its label sorts, not where it arrived', () => {
    const rows = sortForDisplay(AS_COLLECTED).map(pickerLabel);
    expect(rows).toEqual([
      'Lake Marion', 'Lake Murray', 'Lake Rhodhiss',
      'Lake Richard Russell', 'Lake Robinson (Greer)', 'Lake Wateree',
    ]);
    // The specific complaint: not last any more, and Rh < Ri < Ro holds.
    expect(rows[rows.length - 1]).toBe('Lake Wateree');
    expect(rows.indexOf('Lake Richard Russell')).toBe(3);
  });

  it('does not depend on the order it was handed', () => {
    const forwards = sortForDisplay(AS_COLLECTED);
    const backwards = sortForDisplay([...AS_COLLECTED].reverse());
    expect(backwards).toEqual(forwards);
  });

  it('sorts on the visible label, not on the raw name', () => {
    // Raw, "Lake Richard Russell, GA" would sort beside nothing in particular; the point is that
    // the state suffix -- which the group heading already says -- takes no part in the order.
    const a = sortForDisplay(['Lake Rhodhiss, SC', 'Lake Richard Russell, GA', 'Lake Robinson, SC']);
    expect(a.map(pickerLabel)).toEqual(['Lake Rhodhiss', 'Lake Richard Russell', 'Lake Robinson']);
  });

  it('is stable when two waters read the same', () => {
    // pickerLabel strips the county parenthetical, so these two render alike. The raw name breaks
    // the tie rather than leaving the order to the engine.
    const both = ['Lake Russell, GA', 'Lake Russell, SC'];
    expect(sortForDisplay(both)).toEqual(both);
    expect(sortForDisplay([...both].reverse())).toEqual(both);
  });

  it('leaves an empty or missing group alone', () => {
    expect(sortForDisplay([])).toEqual([]);
    expect(sortForDisplay(null)).toEqual([]);
  });

  it('and the render loop actually calls it, for both the groups and the orphans', () => {
    // A correct sorter nobody calls is what was already there -- `lakeNames` IS sorted upstream,
    // just by a different notion of state. So the assertion is on the call site.
    const src = readFileSync(new URL('../js/modules/lake-ramp-select.js', import.meta.url), 'utf8');
    const calls = src.match(/for \(const name of sortForDisplay\(/g) || [];
    expect(calls.length).toBe(2);
    expect(/for \(const name of names\)/.test(src)).toBe(false);
    expect(/for \(const name of orphans\)/.test(src)).toBe(false);
  });
});
