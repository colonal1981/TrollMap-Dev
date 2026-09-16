// THE STATE WAS HALF THE NAME AND THE RESOLVER DROPPED IT.
//
// Ryan, 2026-09-16, reading the map picker's own optgroups back to me:
//
//     NC — Rivers (17)
//       Broad River, SC          <-- an SC-stamped name, under NC
//
// registryRecordFor() had resolved it to broad_river (Cherokee Co, NC, 4,084 ac) instead of
// broad_river_2 (Union Co, SC, 5,166 ac), and stateOf() then filed it correctly by the record's
// own state. The picker was not wrong; the record it was handed was.
//
// HOW IT GOT THERE. normalizeRegistryKey() strips the county parenthetical AND the trailing state,
// deliberately -- the caller rarely has the county. Both rows collapse to `broad river`, so the
// tie went to the corroboration step: whichever candidate is nearest an access point filed under
// that name, within 15 miles. THE BROAD RIVER CROSSES THE STATE LINE and its ramps sit on both
// sides, so geography answered a question the name had already answered.
//
// lake-registry.js has keyed its own index `${state}|${name}` since it was written, for exactly
// this, and says so in its own note. Two resolvers, one question, and one of them knew about
// states. That is the fourth instance of this shape found in a single night -- planWaterKey,
// typeOf, isRiverWater, and now this.
//
// NARROWING, NOT FILTERING. If the stamp matches no candidate the full set is still used: a DNR
// feed stamping a water with the state of the office that listed it is a real thing, and a name
// that resolved yesterday must not stop resolving today.
import { describe, it, expect } from './expect-shim.mjs';

globalThis.window = globalThis;
const { registryRecordFor } = await import('../js/data/access-index.js');

// The two real rows, with their real centroids and acreages.
const NC = { slug: 'broad_river',   state: 'NC', lat: 35.169, lon: -81.731,
             areaAcres: 4083.7, displayName: 'Broad River (Cherokee Co, NC)' };
const SC = { slug: 'broad_river_2', state: 'SC', lat: 34.675, lon: -81.771,
             areaAcres: 5166.4, displayName: 'Broad River (2) (Union Co, SC)' };

// AND THE FIXTURE THAT ACTUALLY REPRODUCES IT. The first draft filed one SC ramp beside the SC
// centroid, which the old code resolved correctly -- a fixture that passes before and after the
// fix proves nothing. The Broad runs from North Carolina down through Union County, so the names
// carry ramps along its whole length, and the NEAREST ramp to a given name can sit across the
// line from the reach that name means. That is the real shape and this is it.
const index = {
  registryByName: new Map([[NC.displayName, NC], [SC.displayName, SC]]),
  byLake: new Map([
    ['Broad River, SC', [{ lat: 35.150, lon: -81.720 },     // 1.5 mi from the NC centroid
                         { lat: 34.700, lon: -81.775 }]],   // 1.7 mi from the SC centroid
    ['Broad River, NC', [{ lat: 35.160, lon: -81.730 }]],
    // The same water as the row above, spelled the way a feed spelled it. Its own key, because
    // byLake is keyed on the exact name and the corroboration step looks the name up there.
    ['Broad River, sc', [{ lat: 34.700, lon: -81.775 }]],
    ['Goose Creek, TN', [{ lat: 36.200, lon: -82.300 }]],
  ]),
};

describe('a name that says which state resolves to that state', () => {
  it('sends Broad River, SC to the South Carolina reach', () => {
    // THE BUG. Both ramps are filed under the SC name; the nearest is 1.5 miles from the NC
    // centroid and the other 1.7 from the SC one. Nearest-wins therefore returns broad_river and
    // the picker files an SC-stamped name under NC. The second draft of this fixture put the SC
    // ramp 16 miles out, which made the RIGHT answer unreachable too -- so it failed after the fix
    // as well and proved nothing. A fixture has to make the correct answer possible.
    expect(registryRecordFor('Broad River, SC', index).slug).toBe('broad_river_2');
  });

  it('still sends Broad River, NC to the North Carolina one', () => {
    expect(registryRecordFor('Broad River, NC', index).slug).toBe('broad_river');
  });

  it('is unmoved by a full name that hits directly', () => {
    // The whole name is authoritative and never reaches the narrowing at all.
    expect(registryRecordFor('Broad River (2) (Union Co, SC)', index).slug).toBe('broad_river_2');
    expect(registryRecordFor('Broad River (Cherokee Co, NC)', index).slug).toBe('broad_river');
  });

  it('accepts the stamp in either spelling a feed uses', () => {
    // Lower-case, because a DNR feed is not curated. The stamp is upper-cased before comparing.
    expect(registryRecordFor('Broad River, sc', index).slug).toBe('broad_river_2');
  });
});

describe('the two-signal rule it was built on still holds', () => {
  it('declines a namesake in another state rather than borrowing it', () => {
    // Ryan, 2026-08-24: "i still see 2 silvers and 2 goose creeks". A TN name matching exactly one
    // registry record -- the SC one, hundreds of miles away -- must still decline. The stamp
    // narrows to nothing here, so the full candidate set is used and the distance test refuses it.
    expect(registryRecordFor('Goose Creek, TN', index)).toBe(null);
  });

  it('falls back to every candidate when the stamp matches none of them', () => {
    // A feed stamping a water with the office's state, not the water's. The name must keep
    // resolving the way it did before, on distance alone.
    const idx = {
      registryByName: new Map([[SC.displayName, SC]]),
      byLake: new Map([['Broad River, GA', [{ lat: 34.680, lon: -81.775 }]]]),
    };
    expect(registryRecordFor('Broad River, GA', idx).slug).toBe('broad_river_2');
  });

  it('returns null for an unknown name and for nothing at all', () => {
    expect(registryRecordFor('Nowhere Lake, SC', index)).toBe(null);
    expect(registryRecordFor('', index)).toBe(null);
    expect(registryRecordFor(null, index)).toBe(null);
  });
});
