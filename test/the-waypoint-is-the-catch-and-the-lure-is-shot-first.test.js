// THE WAYPOINT IS THE CATCH, AND THE LURE IS SHOT FIRST.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-09-27, two bowfin on Bates Old River:
//
//   "my standard process from here on is going to be to mark a waypoint when the fish bites and
//   then reel it in and take the photos like said above... the reason for the waypoint is because
//   of the phone location issue and it gives water depth for the fish"
//
//   "i do normally shoot the lure first because i take a pic of the fish with the lure in its
//   mouth... then remove the lure and stow the rod then take a pic of the fish"
//
// The nightly drop paired photos inside 90 s and called the EARLIER one the fish, so it would have
// sent both lure shots to the fish ID -- and the second fish's photos were 112 s apart, so that
// pair would have split. It also never ran the ID at all: `dt` was read in the AI call's arguments
// and declared below it, a temporal-dead-zone ReferenceError the try swallowed, so every nightly
// catch said "AI call failed".
//
// The data below is his 9/27 export and photos, as read on the PC:
//   27SEP26EXPORT.GPX: 59 waypoints; 57 stamped 2026-09-26T02:23:01Z (a TrollMap plan loaded onto
//   the unit), 0002 at 18:53:27Z (2.94 m, 24.11 C) and 0003 at 20:06:23Z (3.81 m, 22.35 C).
//   PXL_20260927_185451892 lure, _185602230 board, _200828987 lure, _201020230 board
//   (Pixel names are UTC; the EXIF clock is Eastern, 4 h behind).
process.env.TZ = 'America/New_York';

import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  groupPhotosByWaypoint, fishAtMark, markedWaypoints, waypointReadings, localIso, fmtGap
} from '../js/utils/catch-waypoints.js';
import { describeCatchDepth } from '../js/utils/catch-depth.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');
const utc = (s) => Date.parse(s) / 1000;

const LOADED = Array.from({ length: 57 }, (_, i) => ({
  name: `plan ${i}`, time: '2026-09-26T02:23:01Z', lat: 34.37, lon: -80.73, depthM: null, tempC: null,
}));
const W2 = { name: '0002', time: '2026-09-27T18:53:27Z', lat: 33.7810462341, lon: -80.6261066347, depthM: 2.94, tempC: 24.11 };
const W3 = { name: '0003', time: '2026-09-27T20:06:23Z', lat: 33.7850221898, lon: -80.6327523105, depthM: 3.81, tempC: 22.35 };
const WAYPOINTS = [...LOADED, W2, W3];

const photo = (name, iso) => ({ file: { name }, timestamp: utc(iso) });
const LURE1 = photo('PXL_20260927_185451892.MP.jpg', '2026-09-27T18:54:51Z');
const BOARD1 = photo('PXL_20260927_185602230.jpg', '2026-09-27T18:56:02Z');
const LURE2 = photo('PXL_20260927_200828987.MP.jpg', '2026-09-27T20:08:28Z');
const BOARD2 = photo('PXL_20260927_201020230.jpg', '2026-09-27T20:10:20Z');

describe('his 9/27 drop makes two catches, one per waypoint', () => {
  // Shuffled on purpose: a drop's file order is whatever the file picker hands over.
  const g = groupPhotosByWaypoint([BOARD2, LURE1, LURE2, BOARD1], WAYPOINTS);

  it('two catches, on 0002 and 0003, and nothing left over', () => {
    expect(g.catches.map(c => c.waypoint.name)).toEqual(['0002', '0003']);
    expect(g.unanchored.length).toBe(0);
  });

  it('the first photo after the mark is the lure, the second goes to the fish ID', () => {
    expect(g.catches[0].lure.file.name).toBe(LURE1.file.name);
    expect(g.catches[0].board.file.name).toBe(BOARD1.file.name);
    expect(g.catches[1].lure.file.name).toBe(LURE2.file.name);
    expect(g.catches[1].board.file.name).toBe(BOARD2.file.name);
  });

  it('keeps the second fish whole, 112 s between shots, which the 90 s window split', () => {
    expect(BOARD2.timestamp - LURE2.timestamp).toBe(112);
    expect(g.catches[1].onePhoto).toBe(false);
  });

  it('never used one of the 57 loaded waypoints', () => {
    expect(g.marked).toBe(2);
    expect(g.loaded).toBe(57);
  });

  it('the catch time is the bite, on his clock', () => {
    expect(localIso(g.catches[0].waypoint.epochS)).toBe('2026-09-27T14:53:27');
    expect(localIso(g.catches[1].waypoint.epochS)).toBe('2026-09-27T16:06:23');
  });

  it('depth and water temperature are the sounder\'s at the mark', () => {
    expect(waypointReadings(W2)).toEqual({ depthFt: 9.6, waterTempF: 75.4 });
    expect(waypointReadings(W3)).toEqual({ depthFt: 12.5, waterTempF: 72.2 });
  });
});

describe('a waypoint is a mark on the water, not anything with a time', () => {
  it('a timestamp shared by two waypoints means they were loaded, not marked', () => {
    const { marked, loaded } = markedWaypoints([...LOADED, W2]);
    expect(marked.map(w => w.name)).toEqual(['0002']);
    expect(loaded.length).toBe(57);
  });

  it('a waypoint with no time cannot anchor anything', () => {
    const { marked, untimed } = markedWaypoints([{ name: 'x', lat: 1, lon: 1 }, W2]);
    expect(marked.length).toBe(1);
    expect(untimed.length).toBe(1);
  });
});

describe('a photo that is not this catch\'s is handed back with the reason, never dropped', () => {
  it('a third photo after a mark stays on the mark, as several fish -- never orphaned', () => {
    const extra = photo('third.jpg', '2026-09-27T18:58:00Z');
    const g = groupPhotosByWaypoint([LURE1, BOARD1, extra], WAYPOINTS);
    expect(g.catches.length).toBe(1);
    expect(g.catches[0].several).toBe(true);
    expect(g.catches[0].photos.map(p => p.file.name)).toEqual([LURE1.file.name, BOARD1.file.name, 'third.jpg']);
    expect(g.unanchored.length).toBe(0);
  });

  it('a photo before any mark says so', () => {
    const early = photo('early.jpg', '2026-09-27T12:00:00Z');
    const g = groupPhotosByWaypoint([early], WAYPOINTS);
    expect(g.unanchored.map(u => u.reason)).toEqual(['no_waypoint_before']);
  });

  it('the unit keeps old marks, so a mark from another day is not this fish', () => {
    const nextTrip = photo('next.jpg', '2026-10-04T15:00:00Z');
    const g = groupPhotosByWaypoint([nextTrip], WAYPOINTS);
    expect(g.catches.length).toBe(0);
    expect(g.unanchored[0].reason).toBe('waypoint_other_day');
    expect(g.unanchored[0].waypoint.name).toBe('0003');
  });

  it('a photo with no time says so', () => {
    const g = groupPhotosByWaypoint([{ file: { name: 'x.jpg' }, timestamp: null }], WAYPOINTS);
    expect(g.unanchored[0].reason).toBe('no_photo_time');
  });

  it('one photo after a mark is the one sent to the ID', () => {
    const g = groupPhotosByWaypoint([BOARD1], WAYPOINTS);
    expect(g.catches[0].board.file.name).toBe(BOARD1.file.name);
    expect(g.catches[0].lure).toBe(null);
    expect(g.catches[0].onePhoto).toBe(true);
  });
});

// SEVERAL FISH AT ONE MARK -- his 10/08 drop, as it is on the drive (08Oct26_Trip):
//   "The first 3 fish were all caught at the same time at waypoint 0007... all 3 fish were caught
//   on A-rig 2 of them on the same A-rig and the third was on its own. 4th fish was also on a A-rig"
// 0007 19:00:01Z 6.49 m 24.53 C; 0008 20:23:14Z 5.89 m 8.08 C (the temperature sensor was failing
// by then -- THE_TEMP_SENSOR_FAILED_AT_350_AND_THE_DEPTH_NEVER_DID_2026-10-08.md).
// Photos (Pixel names are UTC): 190150 fish on a rig, 190157 the rig with fish on the deck,
// 190337 / 190353 / 190415 three board shots; 202447 fish on a rig, 202736 board.
const W7 = { name: '0007', time: '2026-10-08T19:00:01Z', lat: 33.5197084676, lon: -80.2143453062, depthM: 6.49, tempC: 24.53 };
const W8 = { name: '0008', time: '2026-10-08T20:23:14Z', lat: 33.5446078330, lon: -80.2197326068, depthM: 5.89, tempC: 8.08 };
const OCT = [
  photo('PXL_20261008_190150441.jpg', '2026-10-08T19:01:50Z'),
  photo('PXL_20261008_190157081.jpg', '2026-10-08T19:01:57Z'),
  photo('PXL_20261008_190337648.MP.jpg', '2026-10-08T19:03:37Z'),
  photo('PXL_20261008_190353906.jpg', '2026-10-08T19:03:53Z'),
  photo('PXL_20261008_190415632.jpg', '2026-10-08T19:04:15Z'),
  photo('PXL_20261008_202447438.MP.jpg', '2026-10-08T20:24:47Z'),
  photo('PXL_20261008_202736659.jpg', '2026-10-08T20:27:36Z'),
];
const ON_BOARD = new Set(['PXL_20261008_190337648.MP.jpg', 'PXL_20261008_190353906.jpg',
                          'PXL_20261008_190415632.jpg', 'PXL_20261008_202736659.jpg']);
const onBoard = (p) => ON_BOARD.has(p.file.name);

describe('his 10/08 triple on A-rigs is three fish at 0007, and the fourth is on 0008', () => {
  const g = groupPhotosByWaypoint([...OCT].reverse(), [...LOADED, W7, W8]);

  it('0007 carries all five photos as several fish; 0008 is the usual pair', () => {
    expect(g.catches.map(c => [c.waypoint.name, c.several, c.photos.length]))
      .toEqual([['0007', true, 5], ['0008', false, 2]]);
    expect(g.unanchored.length).toBe(0);
  });

  it('one fish per board shot, every one of them at 0007', () => {
    const fish = fishAtMark(g.catches[0].photos, onBoard);
    expect(fish.map(f => f.board.file.name)).toEqual([
      'PXL_20261008_190337648.MP.jpg', 'PXL_20261008_190353906.jpg', 'PXL_20261008_190415632.jpg']);
  });

  it('two rig shots for three fish: the third fish shares the last one', () => {
    const fish = fishAtMark(g.catches[0].photos, onBoard);
    expect(fish.map(f => f.lure.file.name)).toEqual([
      'PXL_20261008_190150441.jpg', 'PXL_20261008_190157081.jpg', 'PXL_20261008_190157081.jpg']);
  });

  it('0008 is lure then board, as on 9/27', () => {
    expect(g.catches[1].lure.file.name).toBe('PXL_20261008_202447438.MP.jpg');
    expect(g.catches[1].board.file.name).toBe('PXL_20261008_202736659.jpg');
  });

  it('the readings are the sounder\'s at the mark -- 0007 is good', () => {
    expect(waypointReadings(W7)).toEqual({ depthFt: 21.3, waterTempF: 76.2 });
  });
});

describe('fishAtMark', () => {
  const at = (n, s) => photo(n, `2026-10-08T19:0${s}Z`);
  it('alternating lure and board pairs each board with its own lure', () => {
    const ps = [at('l1', '1:00'), at('b1', '2:00'), at('l2', '3:00'), at('b2', '4:00')];
    const fish = fishAtMark(ps, p => p.file.name.startsWith('b'));
    expect(fish.map(f => [f.board.file.name, f.lure.file.name])).toEqual([['b1', 'l1'], ['b2', 'l2']]);
  });
  it('a lure shot is never one taken after its board shot', () => {
    const ps = [at('b1', '1:00'), at('l1', '2:00'), at('b2', '3:00')];
    const fish = fishAtMark(ps, p => p.file.name.startsWith('b'));
    expect(fish.map(f => [f.board.file.name, f.lure && f.lure.file.name])).toEqual([['b1', null], ['b2', 'l1']]);
  });
  it('no board shot at all is null, so the drop keeps every photo instead', () => {
    expect(fishAtMark([at('a', '1:00'), at('b', '2:00'), at('c', '3:00')], () => false)).toBe(null);
  });
});

describe('a missing reading is not a zero', () => {
  it('no depth, no temperature: both null', () => {
    expect(waypointReadings({ depthM: null, tempC: null })).toEqual({ depthFt: null, waterTempF: null });
    expect(waypointReadings(null)).toEqual({ depthFt: null, waterTempF: null });
  });
  it('0 C is 32 F', () => {
    expect(waypointReadings({ depthM: null, tempC: 0 }).waterTempF).toBe(32);
  });
});

describe('the note says how long after the mark each photo was', () => {
  it('in the words a person reads', () => {
    expect(fmtGap(71)).toBe('1 min 11 s');
    expect(fmtGap(155)).toBe('2 min 35 s');
    expect(fmtGap(30)).toBe('30 s');
    expect(fmtGap(120)).toBe('2 min');
    expect(fmtGap(4320)).toBe('1 h 12 min');
  });
});

describe('a sonar depth reads as a measurement', () => {
  it('the waypoint note is not mistaken for a chart lookup', () => {
    const d = describeCatchDepth({
      depth: '9.6', depthSource: 'sounder_at_waypoint',
      notes: 'Garmin waypoint 0002 at 2:53 PM: position, depth 9.6 ft, water 75.4 °F from the sounder.',
    });
    expect(d.text).toBe('9.6 ft');
    expect(d.trusted).toBe(true);
  });
});

describe('the drop is wired to it', () => {
  const journal = src('js/modules/catch-journal.js');
  const start = journal.indexOf('async function handleNightlyPhotoUpload(');
  const drop = journal.slice(start, journal.indexOf('\n}\n', start));

  it('the date is declared before the AI call that sends it', () => {
    const iDt = drop.indexOf('const dt =');
    // the per-catch call; a several-fish mark asks earlier, with the mark's own date
    const iAi = drop.indexOf('identifyFishWithGemini(board.file');
    expect(iDt > 0 && iAi > iDt).toBe(true);
  });

  it('groups by waypoint, and the board photo is what goes to the ID', () => {
    expect(drop.includes('groupPhotosByWaypoint(withExif, waypoints)')).toBe(true);
    expect(drop.includes('identifyFishWithGemini(board.file')).toBe(true);
  });

  it('a several-fish mark asks Claude which photos are on the board, never the Gemini ID', () => {
    // 10/08: Gemini called both rig shots and the deck shot "on the board" -- the board was in the
    // frame -- and the nightly call tells the Worker to assume one, which writes it into the prompt
    expect(drop.includes('claudeBoards(c.photos')).toBe(true);
    expect(drop.includes('fishAtMark(c.photos, (p) => onBoard.has(p))')).toBe(true);
    expect(drop.includes('assume_board')).toBe(false);
    expect(src('Worker/trollmap-worker.js').includes('on_bump_board = true.` : `TASK 1')).toBe(true);
  });

  it('the status line counts fish on a waypoint, not waypoints', () => {
    expect(drop.includes('plans.filter(p => p.waypoint).length')).toBe(true);
  });

  it('without a waypoint, a time pair is still lure first', () => {
    expect(drop.includes('lure: isPair ? cluster[0] : null')).toBe(true);
    expect(drop.includes('isPair ? [cluster[1]] : cluster')).toBe(true);
  });

  it('the drop box and the file picker take a .gpx', () => {
    expect(journal.includes('accept="image/*,.gpx"')).toBe(true);
    expect(journal.includes("f.type.startsWith('image/') || isGpxFile(f)")).toBe(true);
  });

  it('a sonar depth is not looked up again off a chart', () => {
    const fn = journal.slice(journal.indexOf('function enrichItemFromGps('));
    const iGuard = fn.indexOf("item.depthSource === 'sounder_at_waypoint'");
    const iBand = fn.indexOf('if (spatial.depthBand)');
    expect(iGuard > 0 && iBand > iGuard).toBe(true);
  });

  it('water temperature reaches the journal', () => {
    expect(journal.includes('waterTempF: q.waterTempF ?? null')).toBe(true);
    expect(journal.includes('id="rvWaterTemp"')).toBe(true);
  });

  it('the comment that said the ID could not name a bowfin is gone', () => {
    expect(journal.includes('hard-restricted')).toBe(false);
  });

  it('parseGPX reads the waypoint time and the sounder readings', () => {
    const parsers = src('js/utils/parsers.js');
    expect(parsers.includes("time: ctext(el, 'time') || null")).toBe(true);
    expect(parsers.includes("depthM: dnum(el, 'Depth')")).toBe(true);
    expect(parsers.includes("tempC: dnum(el, 'Temperature')")).toBe(true);
  });
});
