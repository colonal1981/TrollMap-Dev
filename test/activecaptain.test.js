// Personal use only, not for distribution or resale; not for navigation.
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// access-index.js publishes legacy helpers on `window` at module scope.
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const { mergeActiveCaptain, acAccessPointsFor, AC_RAMP_LABEL } = await import('../js/data/activecaptain.js');
const { foldActiveCaptainRamp, accessKinds, hideUnnamedSlipways } = await import('../js/data/access-index.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The markers stopped living in the packs on 2026-11-26 -- every pack rebuild had taken them back
 * out -- and are joined in the browser instead. These hold the join to the rule it replaced.
 */
const doc = {
  lakes: {
    wateree_lake: [
      { ac_id: 1, name: 'Clearwater Cove Marina', poi_type: 'marina', ac_poi_type: 8, on_water: false, lon: -80.8700, lat: 34.4000 },
      { ac_id: 2, name: 'Some Other Dock', poi_type: 'marina', ac_poi_type: 8, on_water: true, lon: -80.8701, lat: 34.4001 },
      { ac_id: 3, name: 'Wateree Boat Ramp', poi_type: 'boat_ramp', ac_poi_type: 64, on_water: true, lon: -80.9000, lat: 34.5000 },
      { ac_id: 4, name: 'Collar Ramp', poi_type: 'boat_ramp', ac_poi_type: 64, on_water: false, lon: -80.9500, lat: 34.5500 },
    ],
  },
};
const garmin = (name, type, lon, lat, extra = {}) => ({
  type: 'Feature', properties: { name, poi_type: type, ...extra }, geometry: { type: 'Point', coordinates: [lon, lat] },
});

describe('the pack POIs take the markers by merge_pois() rule', () => {
  it('same name within 50 m is one feature; a different name beside it is not', () => {
    const gj = { type: 'FeatureCollection', features: [
      garmin('Clearwater Cove Marina', 'boat_ramp', -80.87030, 34.40010, { mode: '83/0', on_water: true }),
      garmin('Beaver Creek', 'place_name', -80.87005, 34.40005),
    ] };
    const r = mergeActiveCaptain(gj, 'wateree_lake', doc);
    expect(r.merged).toBe(1);
    expect(r.added).toBe(3);
    const cc = r.gj.features.find((f) => f.properties.name === 'Clearwater Cove Marina');
    expect(cc.geometry.coordinates).toEqual([-80.87, 34.4]);    // ActiveCaptain's surveyed spot
    expect(cc.properties.poi_type).toBe('boat_ramp');           // Garmin's card said Ramp
    expect(cc.properties.on_water).toBe(true);                  // either source's yes
    expect(cc.properties.mode).toBe('83/0');
    expect(r.gj.features.length).toBe(5);
  });

  it('a marker the pack already carries is not drawn twice, and a pack with none still gets them', () => {
    const gj = { type: 'FeatureCollection', features: [garmin('Wateree Boat Ramp', 'boat_ramp', -80.9, 34.5, { ac_id: 3 })] };
    expect(mergeActiveCaptain(gj, 'wateree_lake', doc).already).toBe(1);
    expect(mergeActiveCaptain(null, 'wateree_lake', doc).gj.features.length).toBe(4);
    expect(mergeActiveCaptain(null, 'no_such_lake', doc).gj).toBe(null);
  });
});

describe('ActiveCaptain ramps in the access index', () => {
  const rec = { slug: 'wateree_lake', state: 'SC' };

  it('only ramps on the water, labelled so the planner counts them', () => {
    const pts = acAccessPointsFor(rec, doc);
    expect(pts.map((p) => p.name)).toEqual(['Wateree Boat Ramp']);
    expect(accessKinds({ typeLabel: AC_RAMP_LABEL })).toEqual(['ramp']);
  });

  it('joins the landing within 150 m without renaming it, and stands alone past that', () => {
    const near = { name: 'Clearwater Cove', lat: 34.5, lon: -80.9009, typeLabel: 'Boat ramp (DNR)', launch: true };
    const pier = { name: 'Fishing pier', lat: 34.5, lon: -80.9006, typeLabel: 'Bank / pier access', launch: false };
    const index = { byLake: new Map([['Lake Wateree, SC', [pier, near]]]) };
    const [p] = acAccessPointsFor(rec, doc);
    expect(foldActiveCaptainRamp(index, 'Lake Wateree, SC', p)).toBe(false);
    expect(near.name).toBe('Clearwater Cove');
    expect(near.typeLabel).toBe(`Boat ramp (DNR) / ${AC_RAMP_LABEL}`);
    expect(pier.typeLabel).toBe('Bank / pier access');
    const far = { ...p, name: 'Atkins Boat Landing', lat: 34.52 };
    expect(foldActiveCaptainRamp(index, 'Lake Wateree, SC', far)).toBe(true);
  });

  it('names an unnamed row, and an unnamed ActiveCaptain row hides like an OSM one', () => {
    const osm = { name: 'Unnamed access point', unnamed: true, lat: 34.5, lon: -80.9005, typeLabel: 'Slipway (OSM)', sourcePath: 'registry:osm' };
    const index = { byLake: new Map([['W', [osm]]]) };
    foldActiveCaptainRamp(index, 'W', acAccessPointsFor(rec, doc)[0]);
    expect(osm.name).toBe('Wateree Boat Ramp');
    expect(osm.unnamed).toBe(false);
    const generic = { name: 'Boat Ramp', unnamed: true, lat: 34.6, lon: -80.9, typeLabel: AC_RAMP_LABEL, sourcePath: 'activecaptain' };
    const byLake = new Map([['W', [osm, generic]]]);
    expect(hideUnnamedSlipways(byLake)).toBe(1);
  });
});

describe('the file the app fetches is one the uploader ships', () => {
  it('_registry/activecaptain_by_lake.json on both sides', () => {
    const up = readFileSync(path.join(ROOT, 'Scripts', 'upload_garmin_to_r2.py'), 'utf8');
    const js = readFileSync(path.join(ROOT, 'js', 'data', 'activecaptain.js'), 'utf8');
    expect(up.includes('_registry/activecaptain_by_lake.json')).toBe(true);
    expect(js.includes("'/chartpacks/_registry/activecaptain_by_lake.json'")).toBe(true);
  });
});
