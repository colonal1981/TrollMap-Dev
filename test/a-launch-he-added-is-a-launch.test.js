// Personal use only, not for distribution or resale; not for navigation.
//
// A LAUNCH HE ADDED IS A LAUNCH ON ITS WATER, UNDER HIS NAME.
//
// Ryan, 2026-11-26: "second mill doesn't show up in the waterbody dropdown on the planner tab". The planner
// preset offers a water only when it has a launch, and the one he added with Scripts/my_launch.py lived only
// in the pack's launches.json, read after a water is picked. Bates showed only because it is on the
// hand-written KEEP_ALWAYS list. access-index.js now puts his launches on their water (addOwnLaunch()).
import { describe, it, expect } from './expect-shim.mjs';
// access-index.js publishes legacy helpers on `window` at module scope.
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const { ryanLaunches, primeLaunchNames } = await import('../js/data/launch-reach.js');
const { ownLaunchItem, addOwnLaunch, liveAccessFor } = await import('../js/data/access-index.js');

const REC = { slug: 'second_millpond', state: 'SC' };
const SECOND_MILL = { lat: 33.91829, lon: -80.38016, name: 'Second Mill ramp', water: 'second_millpond', why: '' };
const index = () => ({ lakeNames: [], byLake: new Map(), registryByName: new Map() });
const M = 1 / 111320;

describe('a launch he added is a launch on its water', () => {
  it('reads only the entries he ADDED, with the water they are on', async () => {
    const doc = { names: {
      '33.91829,-80.38016': { add: true, name: 'Second Mill ramp', water: 'second_millpond', why: 'his put-in' },
      '33.78543,-80.63566': { add: true, name: 'Dirt road kayak launch', water: 'bates_old_river' },
      '33.50000,-80.20000': { name: 'Pack\'s Landing' },                   // a rename, not an addition
      '33.60000,-80.30000': { drop: true },                                 // a drop
      '33.70000,-80.40000': { add: true, name: 'No water given' },          // nowhere to put it
    } };
    const was = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => doc });
    try { await primeLaunchNames('https://worker.test'); } finally { globalThis.fetch = was; }
    const got = ryanLaunches();
    expect(got.length).toBe(2);
    expect(got.map((l) => l.water).sort()).toEqual(['bates_old_river', 'second_millpond']);
    const sm = got.find((l) => l.water === 'second_millpond');
    expect(sm.lat).toBe(33.91829);
    expect(sm.lon).toBe(-80.38016);
    expect(sm.name).toBe('Second Mill ramp');
  });

  it('on a water with no landing listed, it is the water\'s launch -- and a ramp when he called it one', () => {
    const ix = index();
    expect(addOwnLaunch(ix, 'Second Millpond', ownLaunchItem(SECOND_MILL, REC))).toBe(true);
    const n = liveAccessFor('Second Millpond', ix);
    expect(n.launches).toBe(1);        // the planner preset's has-a-launch test
    expect(n.ramps).toBe(1);           // the map's has-a-ramp box
    const bates = ownLaunchItem({ ...SECOND_MILL, name: 'Dirt road kayak launch' }, REC);
    expect(bates.typeLabel).toBe('Launch (yours)');
    const ix2 = index();
    addOwnLaunch(ix2, 'Bates Old River', bates);
    expect(liveAccessFor('Bates Old River', ix2).launches).toBe(1);
    expect(liveAccessFor('Bates Old River', ix2).ramps).toBe(0);   // a dirt road is not a ramp
  });

  it('on a landing already listed at the same place, it is that landing, under his name', () => {
    const ix = index();
    ix.byLake.set('Second Millpond', [{ name: 'Unnamed slipway', unnamed: true, lat: SECOND_MILL.lat + 3 * M,
      lon: SECOND_MILL.lon, typeLabel: 'Slipway (OSM)', launch: true }]);
    expect(addOwnLaunch(ix, 'Second Millpond', ownLaunchItem(SECOND_MILL, REC))).toBe(false);
    const list = ix.byLake.get('Second Millpond');
    expect(list.length).toBe(1);
    expect(list[0].name).toBe('Second Mill ramp');
    expect(list[0].typeLabel).toBe('Slipway (OSM) / Boat ramp (yours)');
  });

  it('a listed landing 100 m away is another landing, not his (unlike an ActiveCaptain ramp)', () => {
    const ix = index();
    ix.byLake.set('Second Millpond', [{ name: 'Mill Pond Park', lat: SECOND_MILL.lat + 100 * M,
      lon: SECOND_MILL.lon, typeLabel: 'Boat Ramp', launch: true }]);
    expect(addOwnLaunch(ix, 'Second Millpond', ownLaunchItem(SECOND_MILL, REC))).toBe(true);
    const names = ix.byLake.get('Second Millpond').map((x) => x.name).sort();
    expect(names).toEqual(['Mill Pond Park', 'Second Mill ramp']);
  });
});
