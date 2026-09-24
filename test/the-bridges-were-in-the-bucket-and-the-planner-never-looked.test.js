/**
 * test/the-bridges-were-in-the-bucket-and-the-planner-never-looked.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * osm-structures.geojson has been in R2 beside the packs since fetch_osm_structures.py ran, and the
 * map draws it behind a toggle. The planner never read it: 3,367 bridges across 371 freshwater
 * waters, invisible to the thing that ranks a leg by what it passes. And measured before wiring
 * them: 2,580 of 3,572 freshwater OSM piers are within 30 m of a dock Garmin already charts.
 *
 *   node --test test/the-bridges-were-in-the-bucket-and-the-planner-never-looked.test.js
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { osmShoreFeatures, OSM_SHORE_KINDS, DEFAULT_WEIGHTS, chartedGrid } from '../js/modules/plan-candidates.js';

const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const pt = (lon, lat, props) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: props });
const square = (lon, lat, d = 0.00005) => ({ type: 'Feature', geometry: { type: 'Polygon',
  coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] }, properties: {} });

describe('which OSM things are structure, and what kind', () => {
  it('every bridge is a bridge, a pier is a pier, and nothing else comes through', () => {
    expect(OSM_SHORE_KINDS.ROAD_BRIDGE).toBe('bridge');
    expect(OSM_SHORE_KINDS.RAIL_BRIDGE).toBe('bridge');
    expect(OSM_SHORE_KINDS.FOOT_BRIDGE).toBe('bridge');
    expect(OSM_SHORE_KINDS.PIER).toBe('pier');
    const fc = { features: [pt(-80, 34, { structure_type: 'DAM' }), pt(-80, 34, { structure_type: 'BOAT_RAMP' }),
                            pt(-80, 34, { structure_type: 'ISLAND' }), pt(-80, 34, { structure_type: 'ROAD_BRIDGE', name: 'US 1' })] };
    const out = osmShoreFeatures(fc, null);
    expect(out.map((f) => f.properties.kind)).toEqual(['bridge']);
    expect(out[0].properties.name).toBe('US 1');
  });
  it('both kinds already carry a measured weight -- nothing new is invented for them', () => {
    expect(DEFAULT_WEIGHTS.bridge).toBe(3);
    expect(DEFAULT_WEIGHTS.pier).toBe(4);
  });
});

describe('a pier Garmin already charts as a dock is not counted twice', () => {
  const dock = square(-80.0, 34.0);
  it('within 30 m of a charted dock: dropped', () => {
    const fc = { features: [pt(-80.0001, 34.0001, { structure_type: 'PIER' })] };   // ~14 m
    expect(osmShoreFeatures(fc, { features: [dock] }).length).toBe(0);
  });
  it('beyond it: kept', () => {
    const fc = { features: [pt(-80.001, 34.001, { structure_type: 'PIER' })] };     // ~145 m
    expect(osmShoreFeatures(fc, { features: [dock] }).length).toBe(1);
  });
  it('a bridge is never a dock, however close', () => {
    const fc = { features: [pt(-80.0001, 34.0001, { structure_type: 'ROAD_BRIDGE' })] };
    expect(osmShoreFeatures(fc, { features: [dock] }).length).toBe(1);
  });
});

describe('on this water, and not on a coastal zone', () => {
  const fc = { features: [pt(-80.0, 34.0, { structure_type: 'ROAD_BRIDGE' }),
                          pt(-81.0, 35.0, { structure_type: 'ROAD_BRIDGE' })] };
  it('the charted grid the state attractors pass through decides "on this water"', () => {
    const onWater = chartedGrid([[pt(-80.0, 34.0, {})]]);
    expect(osmShoreFeatures(fc, null, { onWater }).length).toBe(1);
  });
  it('a coastal zone takes none: its ENC layer already puts them in near[]', () => {
    expect(osmShoreFeatures(fc, null, { coastal: true }).length).toBe(0);
  });
});

describe('the planner reads them', () => {
  it('smart-plan fetches the file, builds the index, and hands it to the selector', () => {
    const s = src('../js/modules/smart-plan-v2.js');
    expect(s).toContain('/osm-structures.geojson`)).catch(() => null)');
    expect(s).toContain('const shore = structureIndex(osmShoreFeatures(osmFc, docksFc,');
    expect(s).toContain('docks, attractors, pois, shore,');
  });
  it('the selector joins bridges and piers per run, like the state attractors', () => {
    const c = src('../js/modules/plan-candidates.js');
    expect(c).toContain("kindHits(coords, cum0, o.shore, opts.maxOffM, 'bridge')");
    expect(c).toContain('const joined = docks.concat(dnr, poi, shore);');
  });
});

describe('Wateree, when its files are on this machine', () => {
  const o = new URL('../../osm_out/wateree_lake.geojson', import.meta.url);
  const d = new URL('../../chartpack/wateree_lake/docks.geojson', import.meta.url);
  const have = existsSync(o) && existsSync(d);
  it(have ? 'twelve bridges and one pier that is not already a dock' : 'skipped: files not on this machine', () => {
    if (!have) return;
    const out = osmShoreFeatures(JSON.parse(readFileSync(o, 'utf8')), JSON.parse(readFileSync(d, 'utf8')));
    expect(out.filter((f) => f.properties.kind === 'bridge').length).toBe(12);
    expect(out.filter((f) => f.properties.kind === 'pier').length).toBe(1);
  });
});
