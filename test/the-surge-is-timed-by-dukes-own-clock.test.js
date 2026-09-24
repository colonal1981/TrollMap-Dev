/**
 * test/the-surge-is-timed-by-dukes-own-clock.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * estimateSurgeAt() walked the surge downriver at a typed 2.5 mph over hand-typed river miles.
 * Duke's 2026-09-24 Wateree release -- generation 17:00, arrival at the Highway 1/Highway 601
 * Landing 18:48 -- measures 4.2 mph, and the hand miles are wrong below Camden: WT Billy Tolar at
 * 29 where the pack's own mainstem puts it at 51.4. Both errors point the same way, late, which is
 * the way that puts a kayak on the water when the surge arrives.
 *
 * The time is now read off the places Duke itself timed for the release, placed on the pack.
 *
 *   node --test test/the-surge-is-timed-by-dukes-own-clock.test.js
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { slimCentreline, slimLandings, stationAt, markerStation, surgeAt } from '../Worker/river-geometry.js';
import { RIVERS } from '../Worker/worker-data.js';

const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const T = (hhmm) => Date.parse(`2026-09-24T${hhmm}:00-04:00`);
const WATEREE = [
  { name: 'WT Billy Tolar (US 378)', station_m: 82800 },
  { name: 'Camden Riverfront Environmental Park', station_m: 14550 },
  { name: 'Wateree River Veterans Park', station_m: 11850 },
  { name: 'Patriots Landing (Hwy 1)', station_m: 12100 },
  { name: 'Lugoff', station_m: 350 },
  { name: 'Bates Bridge', station_m: 123250 },
];

describe('a Duke marker is placed by the pack landing it names', () => {
  const g = { landings: WATEREE };
  it('"Highway 1/Highway 601 Landing" is Patriots Landing (Hwy 1)', () => {
    expect(markerStation(g, 'Highway 1/Highway 601 Landing').name).toBe('Patriots Landing (Hwy 1)');
  });
  it('a shared road prefix alone is not a match -- US 378 is not Highway 1', () => {
    expect(markerStation({ landings: [WATEREE[0]] }, 'Highway 1/Highway 601 Landing')).toBe(null);
  });
  it('a town Duke names and no landing does is null, not the nearest ramp', () => {
    expect(markerStation(g, 'Cullowhee')).toBe(null);
  });
  it('a tie is null', () => {
    const two = { landings: [{ name: 'Hwy 1 North', station_m: 1 }, { name: 'Hwy 1 South', station_m: 2 }] };
    expect(markerStation(two, 'Highway 1 Landing')).toBe(null);
  });
});

describe('the time at a river metre, off the line through Duke\'s timed places', () => {
  const anchors = [
    { station_m: 0, epoch: T('17:00'), recedes_epoch: T('19:00'), label: 'Wateree' },
    { station_m: 12100, epoch: T('18:48'), recedes_epoch: T('23:48'), label: 'Highway 1/Highway 601 Landing' },
  ];
  it('at the marker it is the marker\'s own time', () => {
    const t = surgeAt(anchors, 12100);
    expect(t.epoch).toBe(T('18:48'));
    expect(t.recedes_epoch).toBe(T('23:48'));
    expect(t.extrapolated).toBe(false);
  });
  it('4.2 mph, measured -- not 2.5', () => {
    expect(surgeAt(anchors, 6000).speed_mph).toBe(4.18);
  });
  it('beyond the last timed place the pair\'s speed is carried, and it says so', () => {
    const t = surgeAt(anchors, 82800);          // WT Billy Tolar, 51.4 river miles
    expect(t.extrapolated).toBe(true);
    // 82,800 m at 12,100 m per 108 min is 739 min after the start: 05:19 the next morning.
    expect(Math.round((t.epoch - T('17:00')) / 6e4)).toBe(739);
  });
  it('one timed place is not a speed', () => {
    expect(surgeAt([anchors[1]], 6000)).toBe(null);
  });
  it('a marker timed before the dam started is not this release', () => {
    expect(surgeAt([anchors[0], { ...anchors[1], epoch: T('16:00') }], 6000)).toBe(null);
  });
});

describe('the typed speed is gone, and /river is wired to Duke\'s clock', () => {
  const w = src('../Worker/trollmap-worker.js');
  it('RIVERS.wateree carries no surge speed', () => {
    expect(RIVERS.wateree.surgeSpeed_mph).toBe(undefined);
    expect(src('../Worker/worker-data.js').includes('surgeSpeed_mph: 2.5')).toBe(false);
  });
  it('estimateSurgeAt returns a severity and no time', () => {
    expect(w.includes('userRiverMi / river.surgeSpeed_mph')).toBe(false);
  });
  it('getRiver times the user off the anchors and says when it cannot', () => {
    expect(w).toContain('const t = riverAt ? surgeAt(anchors, riverAt.station_m) : null;');
    expect(w).toContain('out.user_location.surge_eta_unavailable');
    expect(w).toContain('markerStation(geom, a.mileMarkerName)');
  });
});

describe('the real Wateree pack, when it is on this machine', () => {
  const f = new URL('../../chartpack/wateree_river/centreline.geojson', import.meta.url);
  const l = new URL('../../chartpack/wateree_river/launches.json', import.meta.url);
  const have = existsSync(f) && existsSync(l);
  it(have ? 'the dam is the top of the pack, and Highway 1/601 is 7.5 miles below it'
          : 'skipped: the Wateree pack is not on this machine', () => {
    if (!have) return;
    const g = slimCentreline(JSON.parse(readFileSync(f, 'utf8')));
    g.landings = slimLandings(JSON.parse(readFileSync(l, 'utf8')));
    const dam = RIVERS.wateree.centerline.find((w) => w.mi === 0);
    const d = stationAt(g, dam.lat, dam.lon);
    expect(d.off_m <= g.snap_cap_m).toBe(true);
    expect(d.station_m).toBe(0);
    const m = markerStation(g, 'Highway 1/Highway 601 Landing');
    expect(Math.round((m.station_m - d.station_m) / 1609.344 * 10) / 10).toBe(7.5);
  });
});
