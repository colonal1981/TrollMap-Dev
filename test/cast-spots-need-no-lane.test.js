// A CAST SPOT HAS NOTHING TO DO WITH A TROLLING LANE.
//
// Ryan, 2026-08-30: "I should be able to make a plan that is all cast stops... cast stops should
// have nothing to do with the trolling lanes at all... now if i am picking lanes i will probably
// pick cast spots that are close by... but i should be able to choose that... pickwater is
// supposed to be fisherman decides".
//
// Every cast spot except the DNR feed was discovered by walking each lane's `near[]`, which
// quietly made "worth stopping on" mean "worth stopping on while trolling past". castSpots() said
// so in its own comment and let the DNR feed in above the loop precisely because it "must not
// need a lane's permission to be listed" -- and then left every other source needing exactly
// that. On Lake Wateree:
//
//     on the lake     offered as a cast spot
//     ledge   573                          0     `ledge` is not a near[] code at all
//     hump     52                        412     4,060 lane sightings, distance-merged
//     point   339                        369
//     cove    279                        209     70 coves no lane passes
//     creek     11                          2     9 of the 11 unreachable
//     docks 2,796                          0     grouped by distance ALONG a lane, and the file
//                                                was never even fetched by Pick Water
//
// Proximity did not stop mattering. It stopped being a gate: priceSpots() still marks a spot free
// when it sits on water he has ticked, which is the same information offered as a choice.
import { describe, it, expect } from './expect-shim.mjs';
import { castSpots, SPOT_KINDS } from '../js/modules/plan-water.js';
import { dockSpotFeatures } from '../js/modules/plan-candidates.js';

const pt = (kind, lon, lat, extra = {}) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { kind, ...extra },
});

describe('castSpots lists the charted features with no lanes at all', () => {
  const features = [
    pt('ledge', -80.7300, 34.3700, { id: 'L1' }), pt('ledge', -80.7400, 34.3750, { id: 'L2' }),
    pt('hump', -80.7350, 34.3720, { id: 'H1', depth_ft: 18 }),
    pt('point', -80.7250, 34.3680), pt('cove', -80.7450, 34.3800),
    pt('creek_mouth', -80.7500, 34.3850),
  ];

  it('offers every one of them with an empty lane list', () => {
    const spots = castSpots([], { features });
    expect(spots.length).toBe(6);
    const kinds = spots.map((s) => s.type).sort();
    expect(kinds).toEqual(['cove', 'creek_mouth', 'hump', 'ledge', 'ledge', 'point']);
  });

  it('names them from SPOT_KINDS, and carries the pack id and depth', () => {
    const spots = castSpots([], { features });
    const hump = spots.find((s) => s.type === 'hump');
    expect(hump.what).toBe(SPOT_KINDS.hump);
    expect(hump.structureId).toBe('H1');
    expect(hump.depthFt).toBe(18);
  });

  it('ledges are listed, which they never were before', () => {
    // `ledge` is not among the near[] codes the packs emit -- hump, point, cove, timber, hazard,
    // shallow, obstruction, pile, attractor, creek_mouth -- so no lane could ever surface one.
    expect(castSpots([], { features }).filter((s) => s.type === 'ledge').length).toBe(2);
  });

  it('a lane sighting of the same thing does not double it', () => {
    const lane = { type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[-80.7355, 34.3719], [-80.7345, 34.3721]] },
      properties: { length_m: 200, near: [{ t: 'hump', s: 100, d: 30 }] } };
    const spots = castSpots([lane], { features });
    expect(spots.filter((s) => s.type === 'hump').length).toBe(1);
    expect(spots.length).toBe(6);
  });

  it('a lane sighting that matches nothing in the file is DROPPED, not kept', () => {
    // `near[]` is computed when the RUNS are built. Wateree's were annotated before the
    // 2026-08-29 relief rebuild took the lake from 7,315 structures to 625, so they carry 4,060
    // hump sightings of humps that no longer exist. Those used to fall through to the distance
    // merge and become spots in their own right -- 412 humps on a lake with 52. The file is the
    // whole truth for a kind the pack has a file for.
    const ghost = { type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[-80.60, 34.30], [-80.59, 34.31]] },
      properties: { length_m: 200, near: [{ t: 'hump', s: 100, d: 30 }] } };
    const spots = castSpots([ghost], { features });
    expect(spots.filter((s) => s.type === 'hump').length).toBe(1);   // the one in the file
  });

  it('but a kind with NO file keeps its estimate, because that is all there is', () => {
    // Timber, piles and attractors live only in near[] on packs without a pois layer.
    const lane = { type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[-80.7355, 34.3719], [-80.7345, 34.3721]] },
      properties: { length_m: 200, near: [{ t: 'pile', s: 100, d: 20 }] } };
    expect(castSpots([lane], { features }).filter((s) => s.type === 'pile').length).toBe(1);
  });

  it('a kind the form cannot express is not a cast spot', () => {
    // pois.geojson also yields hazards, shallows and bridges. Things to know about, not to cast at.
    const spots = castSpots([], { features: [pt('hazard', -80.73, 34.37), pt('shallow', -80.74, 34.38)] });
    expect(spots.length).toBe(0);
  });
});

describe('dockSpotFeatures groups docks along the shore, not along a route', () => {
  // ~30 m apart at this latitude, which is how residential docks actually sit.
  const row = (n, lon0) => Array.from({ length: n }, (_, i) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [lon0 + i * 0.00033, 34.37] },
    properties: {},
  }));

  it('a long row is a line you run a bait down', () => {
    const out = dockSpotFeatures({ features: row(12, -80.75) });
    expect(out.length).toBe(1);
    expect(out[0].properties.kind).toBe('dock_line');
    expect(out[0].properties.n).toBe(12);
    expect(out[0].properties.spanM > 250).toBe(true);
  });

  it('a short group is a pocket you stop on', () => {
    const out = dockSpotFeatures({ features: row(3, -80.75) });
    expect(out[0].properties.kind).toBe('dock_cluster');
    expect(out[0].properties.n).toBe(3);
  });

  it('a lone dock is a dock, not a cluster of one', () => {
    const out = dockSpotFeatures({ features: row(1, -80.75) });
    expect(out[0].properties.kind).toBe('dock');
    expect(SPOT_KINDS.dock).toBeTruthy();
  });

  it('a gap wider than a berth breaks the group', () => {
    const far = [...row(3, -80.75), ...row(3, -80.70)];
    const out = dockSpotFeatures({ features: far });
    expect(out.length).toBe(2);
  });

  it('and they reach the list as cast spots', () => {
    const docks = dockSpotFeatures({ features: row(12, -80.75) });
    const spots = castSpots([], { features: docks });
    expect(spots.length).toBe(1);
    expect(spots[0].what).toBe(SPOT_KINDS.dock_line);
  });

  it('a dock drawn as a POLYGON collapses to its centre', () => {
    // Every one of Wateree's 2,796 docks is a Polygon outline of the structure. The first version
    // handled Point and LineString, so `coordinates[0]` came back as a whole ring, Number.isFinite
    // refused it, and all 2,796 were silently dropped -- no dock chip at all on a lake full of
    // them.
    const poly = (lon, lat) => ({ type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: [[[lon, lat], [lon + 0.0001, lat],
                                                  [lon + 0.0001, lat + 0.0001], [lon, lat]]] } });
    const out = dockSpotFeatures({ features: [poly(-80.75, 34.37)] });
    expect(out.length).toBe(1);
    expect(out[0].geometry.coordinates[0] > -80.7502).toBe(true);
    expect(out[0].geometry.coordinates[0] < -80.7498).toBe(true);
  });

  it('survives an empty or absent file', () => {
    expect(dockSpotFeatures(null)).toEqual([]);
    expect(dockSpotFeatures({ features: [] })).toEqual([]);
  });
});
