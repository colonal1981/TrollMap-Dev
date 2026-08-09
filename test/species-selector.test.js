import { describe, it, expect } from './expect-shim.mjs';
import { speciesGroupsFor, researchedExtras } from '../js/modules/species-selector.js';
import { resolveR2Key } from '../js/data/lake-keys.js';

// ---------------------------------------------------------------------------------------------
// Why this test exists
//
// Ryan asked four times for the fish that were missing. The selector was two hardcoded arrays —
// seven freshwater, five saltwater — and it could not express a third of what he fishes: no
// sunfish at all, no perch, and on the saltwater side only the five species the coastal
// regulation table happened to hold, while every coastal zone is a selectable waterbody.
//
// The two things that must not regress:
//   1. Each fish is INDIVIDUALLY selectable. A "Sunfish" group is fine; one checkbox meaning six
//      species is not — the plan carries `species: [...]` into the depth band and the prompt.
//   2. The WATERBODY decides the list. An inland lake must never offer tarpon, and a sound must
//      never offer crappie, because the list is what the depth band and the regulation check are
//      keyed on.
// ---------------------------------------------------------------------------------------------

const values = (groups) => groups.flatMap((g) => g.species.map((s) => s.value));
const labels = (groups) => groups.flatMap((g) => g.species.map((s) => s.label));

const WATEREE = resolveR2Key('Lake Wateree, SC');
const WINYAH = resolveR2Key('Winyah Bay / Georgetown, SC');

describe('the species Ryan asked for four times', () => {
  it('every sunfish is its own checkbox on an inland lake', () => {
    const v = values(speciesGroupsFor(WATEREE, null));
    for (const want of ['Bluegill', 'Warmouth', 'Green Sunfish', 'Pumpkinseed']) {
      expect(v, `${want} missing`).toContain(want);
    }
    // Redear and Redbreast carry their book names in the value; the label is what he calls them.
    expect(v.some((x) => /Redear/.test(x)), 'Redear missing').toBe(true);
    expect(v.some((x) => /Redbreast/.test(x)), 'Redbreast missing').toBe(true);
    expect(labels(speciesGroupsFor(WATEREE, null)).some((l) => /Shellcracker/.test(l))).toBe(true);
  });

  it('a Sunfish grouping does not collapse them into one selection', () => {
    const groups = speciesGroupsFor(WATEREE, null);
    const sunfish = groups.find((g) => g.label === 'Sunfish');
    expect(Boolean(sunfish)).toBe(true);
    expect(sunfish.species.length).toBeGreaterThan(5);
    // No group is ever itself a value.
    expect(values(groups)).not.toContain('Sunfish');
  });

  it('both perch are selectable inland', () => {
    const v = values(speciesGroupsFor(WATEREE, null));
    expect(v).toContain('White Perch');
    expect(v).toContain('Yellow Perch');
  });

  it('the ten saltwater species are selectable on a coastal zone', () => {
    const v = values(speciesGroupsFor(WINYAH, null));
    for (const want of ['Black Drum', 'Sheepshead', 'Tarpon', 'Cobia',
                        'Spanish Mackerel', 'Bluefish', 'Ladyfish']) {
      expect(v, `${want} missing`).toContain(want);
    }
    expect(v.some((x) => /Red Drum/.test(x)), 'Red Drum missing').toBe(true);
    expect(v.some((x) => /Seatrout/.test(x)), 'Spotted Seatrout missing').toBe(true);
    expect(v.some((x) => /Flounder/.test(x)), 'Flounder missing').toBe(true);
  });
});

describe('the waterbody decides the list', () => {
  it('an inland lake offers no tarpon', () => {
    expect(values(speciesGroupsFor(WATEREE, null))).not.toContain('Tarpon');
  });

  it('a coastal zone offers no crappie', () => {
    expect(values(speciesGroupsFor(WINYAH, null))).not.toContain('Crappie');
  });

  it('an unknown waterbody falls to freshwater rather than showing nothing', () => {
    const v = values(speciesGroupsFor(null, null));
    expect(v).toContain('Striped Bass');
    expect(v).not.toContain('Tarpon');
  });

  it('exactly one species is ticked by default, on each side', () => {
    for (const key of [WATEREE, WINYAH]) {
      const checked = speciesGroupsFor(key, null).flatMap((g) => g.species).filter((s) => s.checked);
      expect(checked.length, `${key} default ticks`).toBe(1);
    }
  });

  it('the values a saved plan restores by are unchanged', () => {
    // plan-builder.js:503 reticks a saved plan by matching these exact strings.
    const v = values(speciesGroupsFor(WATEREE, null));
    for (const legacy of ['Striped Bass', 'Hybrid', 'Largemouth Bass', 'Catfish',
                          'Crappie', 'White Bass', 'Bowfin']) {
      expect(v, `${legacy} value changed`).toContain(legacy);
    }
    const s = values(speciesGroupsFor(WINYAH, null));
    for (const legacy of ['Red Drum (Redfish)', 'Speckled Trout (Spotted Seatrout)',
                          'Southern Flounder', 'Black Drum', 'Sheepshead']) {
      expect(s, `${legacy} value changed`).toContain(legacy);
    }
  });
});

describe('the lake research profile extends the list', () => {
  const profile = {
    trollingIntelligence: {
      'Striped Bass': { summer: { preferredDepth: [22, 28] } },
      'Bluegill': { summer: { preferredDepth: [6, 12] } },
      'Chain Pickerel': { summer: { preferredDepth: [4, 9] } },
    },
  };

  it('a species the research names and the catalogue lacks becomes selectable', () => {
    const v = values(speciesGroupsFor(WATEREE, profile));
    expect(v).toContain('Chain Pickerel');
  });

  it('species already in the catalogue are not duplicated', () => {
    const v = values(speciesGroupsFor(WATEREE, profile));
    expect(v.filter((x) => x === 'Bluegill')).toHaveLength(1);
    expect(v.filter((x) => x === 'Striped Bass')).toHaveLength(1);
  });

  it('no profile changes nothing', () => {
    expect(researchedExtras(null, [])).toHaveLength(0);
    expect(researchedExtras({}, [])).toHaveLength(0);
    expect(values(speciesGroupsFor(WATEREE, null)))
      .toEqual(values(speciesGroupsFor(WATEREE, { trollingIntelligence: {} })));
  });

  it('prose where a species name belongs is not turned into a checkbox', () => {
    const junk = { trollingIntelligence: {
      '': {},
      'Fish the lower lake basin early and work the current breaks on the falling tide': {},
    } };
    expect(researchedExtras(junk, speciesGroupsFor(WATEREE, null))).toHaveLength(0);
  });
});
