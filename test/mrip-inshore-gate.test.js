import { describe, it, expect } from './expect-shim.mjs';
import { isTidalWater } from '../Worker/conditions.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * MRIP IS AN ESTUARY SURVEY AND IT MUST NOT LAND ON A RESERVOIR.
 *
 * `mripSeasonBlock()` was keyed on the STATE alone when it shipped on 2026-09-03. Every roster
 * carries freshwater species, because they are genuinely caught in the brackish upper estuary --
 * NC has largemouth 224, white perch 217, chain pickerel 31, bluegill 22; SC has blue catfish 59
 * and striped bass 21. The species filter was the only thing between that and a lake, and
 * striped bass walks straight through it. A striped bass plan on Lake Wateree drew twenty-one
 * estuarine intercepts under the heading "WHAT IS ACTUALLY CAUGHT HERE, AND WHEN" with
 * "where this and a recollection disagree, this wins" printed beneath it.
 *
 * THE GATE IS THE TIDE BINDING, NOT `feature_type`. `cooper_river` is a river and the tide runs
 * up it to Bushy Park, which is the water Ryan fishes most -- a `feature_type === 'coastal'`
 * test would have called the Cooper freshwater and lost it.
 *
 * The fixtures below are the four cases that decide the rule, each a real row from
 * registry/water_bindings.json.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

const BINDINGS = {
  _note: 'test fixture',
  bindings: {
    // A reservoir. No tides key at all -- this is the shape 177 of the 207 bindings have.
    wateree_lake: {
      slug: 'wateree_lake', display_name: 'Lake Wateree (Kershaw Co, SC)', state: 'SC',
      feature_type: 'lake', centroid: [-80.72, 34.36],
      pool: { lid: 'WATS1', name: 'Wateree Lake near Camden' }, ramps: [],
    },
    // A coastal zone.
    coast_charleston_sc: {
      slug: 'coast_charleston_sc', display_name: 'Charleston Harbor, SC (Charleston Co, SC)',
      state: 'SC', feature_type: 'coastal', centroid: [-79.92, 32.78], ramps: [],
      tides: [{ id: '8665530', name: 'Charleston', lat: 32.780834, lon: -79.923615,
                kind: 'waterlevels', measured: true }],
    },
    // THE CASE THAT DECIDES THE RULE. feature_type 'river', and salt.
    cooper_river: {
      slug: 'cooper_river', display_name: 'Cooper River (Berkeley Co, SC)', state: 'SC',
      feature_type: 'river', centroid: [-79.95, 33.0], ramps: [],
      tides: [{ id: '8664131', name: 'Back River Reservoir, West Branch', lat: 32.995,
                lon: -79.9, kind: 'tidepredictions', measured: false }],
    },
    // A water whose NAME says lake and whose water does not. Greenfield Lake is in Wilmington
    // and drains to the Cape Fear; a name test would have thrown it out.
    greenfield_lake: {
      slug: 'greenfield_lake', display_name: 'Greenfield Lake (New Hanover Co, NC)', state: 'NC',
      feature_type: 'lake', centroid: [-77.94, 34.21], ramps: [],
      tides: [{ id: '8658163', name: 'Wrightsville Beach', lat: 34.2133, lon: -77.7867,
                kind: 'tidepredictions', measured: false }],
    },
    // Present in the table, tides explicitly empty. Not the same as absent, and not tidal.
    empty_tides_lake: {
      slug: 'empty_tides_lake', display_name: 'Somewhere, SC', state: 'SC',
      feature_type: 'lake', centroid: [-81, 34], ramps: [], tides: [],
    },
  },
};

function makeEnv({ present = true, body = JSON.stringify(BINDINGS) } = {}) {
  return {
    R2_TROLLMAP_CHARTPACKS: {
      async get(key) {
        if (!present) return null;
        if (key !== '_registry/water_bindings.json') return null;
        return { httpMetadata: {}, text: async () => body };
      },
    },
  };
}

describe('isTidalWater — does the tide reach this water', () => {
  it('a reservoir is not tidal', async () => {
    expect(await isTidalWater(makeEnv(), 'wateree_lake')).toBe(false);
  });

  it('a coastal zone is tidal', async () => {
    expect(await isTidalWater(makeEnv(), 'coast_charleston_sc')).toBe(true);
  });

  it('THE COOPER IS TIDAL although its feature_type says river', async () => {
    // Bushy Park is brackish and it is the water this whole gate must not lose.
    const env = makeEnv();
    expect(await isTidalWater(env, 'cooper_river')).toBe(true);
    expect(BINDINGS.bindings.cooper_river.feature_type).toBe('river');
  });

  it('a tidal water called "Lake" is still tidal', async () => {
    expect(await isTidalWater(makeEnv(), 'greenfield_lake')).toBe(true);
  });

  it('an empty tides array is not a tide station', async () => {
    expect(await isTidalWater(makeEnv(), 'empty_tides_lake')).toBe(false);
  });

  it('a water with no binding at all is false, not a throw', async () => {
    // ABSENT MEANS UNKNOWN, NOT FRESH. The caller drops a block; it must not assert.
    expect(await isTidalWater(makeEnv(), 'not_in_the_table')).toBe(false);
  });

  it('a missing or unreadable bindings object never throws', async () => {
    // waterBindings() THROWS when the object is absent, on purpose -- that failure belongs to
    // /conditions, which must not answer a level with a silent gap. Here it means "cannot tell",
    // and a research run must not die because one registry object is mid-upload. So the catch
    // returns false rather than propagating.
    //
    // THE ANSWER HERE IS NOT ALWAYS false, AND ASSERTING THAT IT WAS IS WHAT THIS TEST GOT WRONG
    // FIRST TIME. waterBindings() holds a module-level cache with a TTL, so once any test above
    // has loaded the table a later call with a broken env is answered from memory and returns
    // true. That is the real behaviour and it is the right one -- a mid-upload gap does not
    // blank the block for every water. What must hold is that neither shape throws.
    for (const env of [makeEnv({ present: false }), makeEnv({ body: 'not json' })]) {
      const answer = await isTidalWater(env, 'coast_charleston_sc');
      expect(typeof answer).toBe('boolean');
    }
    // And on a slug the cache cannot know about, a broken env is still false rather than a throw.
    expect(await isTidalWater(makeEnv({ present: false }), 'never_seen_slug')).toBe(false);
  });

  it('junk in the slug is false and never a lookup', async () => {
    for (const bad of [null, undefined, '', '   ', 42, {}]) {
      expect(await isTidalWater(makeEnv(), bad)).toBe(false);
    }
  });
});
