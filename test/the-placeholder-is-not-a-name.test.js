// Personal use only, not for distribution or resale; not for navigation.
import { describe, it, expect } from './expect-shim.mjs';
// access-index.js publishes legacy global helpers on `window` at module scope, so it needs one
// before it can be imported under node. Same shim live-ramps-reach-the-filter.test.js uses.
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;

const { sameLanding, collapseRenamed, hideUnnamedSlipways } = await import('../js/data/access-index.js');
const { namesALanding } = await import('../js/data/lake-registry.js');

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * RYAN ANSWERED EVERY CARD AND THE LIST STILL SAID UNNAMED.
 *
 * 2026-09-21, on his own app:
 *
 *   > i thought we fixed the unnamed ramp issue with me going through that tool and selecting an
 *   > answer on each... but now i still see unnamed
 *
 * and then, with a screenshot of Lake Marion:
 *
 *   > the list that i am seeing for lake marion has to be like 50 launches... and a whole bunch
 *   > of them are unnamed
 *   > [...] sorry it is 29 lol
 *   > thats what i wanted to show you lol
 *
 * The screenshot carries `Rocks Pond campground & marina` twice, `Taw Caw main lake ramp` twice,
 * one row reading `boat launch — Slipway (OSM)`, and nine reading `Unnamed access point`.
 *
 * FOUR SEPARATE FAULTS PUT THOSE ROWS ON HIS SCREEN, and his roll call could not have reached
 * any of them, because every one happens to the row AFTER he names it or INSTEAD of naming it:
 *
 *   1. `Unnamed access point` is TWENTY CHARACTERS and the merge kept the longer string, so the
 *      placeholder beat `Cherry Point`, `Penny Creek`, `Steamboat`, `Remleys Point`. 263 across
 *      the card.
 *   2. The dedupe key ROUNDED to four decimals and compared the bucket, so two records of one
 *      landing either side of a cell edge stayed two rows. 498 pairs card-wide, one of them
 *      MILTON on the Dan River at 0.0 m, and one of them his own Pack's Landing at 1.9 m.
 *   3. His names arrive AFTER the dedupe, so two rows he had just given the same name were never
 *      re-compared. 19 rows card-wide.
 *   4. OSM contributes 1,441 slipway nodes with no name, 97.7% of them on water that already
 *      names a launch.
 *
 * The numbers in this file are all off `registry/lake_index.json` and
 * `registry/_launch_name_overrides.json` on 2026-09-21, and the coordinates are verbatim.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

const pt = (o) => ({ typeLabel: 'Boat ramp (agency)', sourcePath: 'registry:natl', ...o });

describe('a category typed into the name field is not a name', () => {
  it('keeps a real name, however short', () => {
    for (const n of ['Cherry Point', "Pack's Landing", 'Bates Bridge', 'Spiers', 'Cathead',
                     'Rocks Pond campground & marina', 'Low Falls Landing']) {
      expect(namesALanding(n)).toBe(true);
    }
  });

  it('rejects the category words the source label already says', () => {
    // All 28 of these on the card come from OSM: `Boat Ramp` x23, `boat launch` x3,
    // `Boat Access` x2. The row Ryan screenshotted read `boat launch — Slipway (OSM)`.
    for (const n of ['Boat Ramp', 'boat launch', 'Boat Access', 'Slipway', 'ramp', 'Landing',
                     'Public Boat Ramp', 'Unnamed Ramp']) {
      expect(namesALanding(n)).toBe(false);
    }
  });

  it('ignores case, spacing and punctuation, and treats nothing as nothing', () => {
    expect(namesALanding('BOAT  RAMP')).toBe(false);
    expect(namesALanding('boat-ramp')).toBe(false);
    expect(namesALanding('')).toBe(false);
    expect(namesALanding(null)).toBe(false);
    expect(namesALanding(undefined)).toBe(false);
    expect(namesALanding('   ')).toBe(false);
  });

  it('does not reach past the category word into a real name that contains one', () => {
    // `Taw Caw Creek Boat Ramp` and `Jordan Memorial Boat Ramp` are names. The test is the whole
    // string, never a substring, which is why this list can stay short and literal.
    expect(namesALanding('Taw Caw Creek Boat Ramp')).toBe(true);
    expect(namesALanding('Jordan Memorial Boat Ramp')).toBe(true);
    expect(namesALanding('Wyboo Boat Ramp and Fishing Pier')).toBe(true);
  });
});

describe('two rows are one landing when they are in the same place', () => {
  it('collapses his own Pack\'s Landing, which a rounded key put in two cells', () => {
    // registry/lake_index.json, lake_marion: the national feed and SCDNR both file Rimini, 1.9 m
    // apart -- and toFixed(4) puts them in 33.6594,-80.5150 and 33.6594,-80.5151. The old key
    // compared the CELL, so this was two rows in his picker.
    const natl = pt({ name: 'Rimini', lat: 33.659362, lon: -80.515044 });
    const dnr = pt({ name: 'Rimini', lat: 33.659378, lon: -80.51505, sourcePath: 'registry:dnr' });
    expect(sameLanding([natl], dnr)).toBe(natl);
  });

  it('collapses on position even when the names do not agree at all', () => {
    // 2.5 m apart on Lake Marion: SCDNR says Indian Bluff Park, the OSM node says nothing.
    const dnr = pt({ name: 'Indian Bluff Park', lat: 33.432119, lon: -80.364551 });
    const osm = pt({ name: 'Unnamed access point', unnamed: true, sourcePath: 'registry:osm',
                     lat: 33.4320965, lon: -80.3645463 });
    expect(sameLanding([dnr], osm)).toBe(dnr);
  });

  it('collapses a shared name inside the measured band', () => {
    // norris_lake, Mountain Lake Marina, natl vs osm: 84 m.
    const a = pt({ name: 'Mountain Lake Marina', lat: 36.261007, lon: -84.145504 });
    const b = pt({ name: 'Mountain Lake Marina', lat: 36.2617032, lon: -84.1451422,
                   sourcePath: 'registry:osm' });
    expect(sameLanding([a], b)).toBe(a);

    // hiwassee_lake, HANGING DOG, natl vs ncpaws: 169 m, the widest true duplicate measured.
    const c = pt({ name: 'Hanging Dog', lat: 35.097373, lon: -84.092614 });
    const d = pt({ name: 'HANGING DOG', lat: 35.096293, lon: -84.0913, sourcePath: 'registry:ncpaws' });
    expect(sameLanding([c], d)).toBe(c);
  });

  it('leaves two real ramps that share a park name as two rows', () => {
    // THE GATE IS WHY THIS FILE HAS A NUMBER IN IT. richard_b_russell_lake files
    // `Richard B. Russell State Park` on two ramps 1,614 m apart, and murder_creek_lake files
    // `Charlie Elliott Wildlife Center` on two 192 m apart. Nothing lies between 169 and 192, so
    // 180 m is inside an empty band rather than picked.
    const a = pt({ name: 'Richard B. Russell State Park', lat: 34.165319, lon: -82.748839 });
    const b = pt({ name: 'Richard B. Russell State Park', lat: 34.175599, lon: -82.736449 });
    expect(sameLanding([a], b)).toBe(undefined);

    const c = pt({ name: 'Charlie Elliott Wildlife Center', lat: 33.45563, lon: -83.72939 });
    const d = pt({ name: 'Charlie Elliott Wildlife Center', lat: 33.454156, lon: -83.728314 });
    expect(sameLanding([c], d)).toBe(undefined);
  });

  it('never matches two nameless rows on their placeholder', () => {
    // `Unnamed access point` is a sentence this app writes, not a name two records share. Eight
    // OSM rows on the Ocmulgee carry it across 171 km.
    const a = pt({ name: 'Unnamed access point', unnamed: true, sourcePath: 'registry:osm',
                   lat: 33.4400, lon: -80.4000 });
    const b = pt({ name: 'Unnamed access point', unnamed: true, sourcePath: 'registry:osm',
                   lat: 33.4405, lon: -80.4005 });   // ~70 m: inside the name gate, outside 11 m
    expect(sameLanding([a], b)).toBe(undefined);
  });

  it('does not collapse a row with no usable position', () => {
    const a = pt({ name: 'Spiers', lat: 33.5, lon: -80.3 });
    expect(sameLanding([a], pt({ name: 'Spiers', lat: NaN, lon: NaN }))).toBe(undefined);
  });
});

describe('a name beats a placeholder, and only then does length decide', () => {
  it('keeps Cherry Point over the 20-character placeholder half a metre away', () => {
    // coast_ace_basin_sc: SCDNR names Cherry Point; two OSM nodes sit 0.5 m and 1.4 m off it with
    // no name. `Unnamed access point`.length === 20; `Cherry Point`.length === 12. Measured
    // card-wide on 2026-09-21: 263 landings lost their name to this comparison.
    const byLake = new Map([['coast_ace_basin_sc', [
      pt({ name: 'Cherry Point', lat: 32.597966, lon: -80.18283, sourcePath: 'registry:dnr' }),
      pt({ name: 'Unnamed access point', unnamed: true, sourcePath: 'registry:osm',
           lat: 32.5979707, lon: -80.1828299, typeLabel: 'Slipway (OSM)' }),
    ]]]);
    collapseRenamed(byLake);
    const list = byLake.get('coast_ace_basin_sc');
    expect(list.length).toBe(1);
    expect(list[0].name).toBe('Cherry Point');
    expect(list[0].unnamed).toBe(false);
  });

  it('still prefers the fuller of two real names', () => {
    // The rule this comparison was written for in the first place, 2026-08-22.
    const byLake = new Map([['thurmond', [
      pt({ name: 'Amity RA', lat: 33.8000, lon: -82.3000, sourcePath: 'registry:dnr' }),
      pt({ name: 'Amity Recreation Area', lat: 33.80001, lon: -82.30001 }),
    ]]]);
    collapseRenamed(byLake);
    expect(byLake.get('thurmond')[0].name).toBe('Amity Recreation Area');
  });

  it('keeps both records\' source labels on the surviving row', () => {
    const byLake = new Map([['marion', [
      pt({ name: 'Rimini', lat: 33.659362, lon: -80.515044, typeLabel: 'Boat ramp (agency)' }),
      pt({ name: 'Rimini', lat: 33.659378, lon: -80.51505, typeLabel: 'Boat ramp (DNR)',
           sourcePath: 'registry:dnr' }),
    ]]]);
    collapseRenamed(byLake);
    expect(byLake.get('marion')[0].typeLabel).toBe('Boat ramp (agency) / Boat ramp (DNR)');
  });
});

describe('his names make duplicates the first pass could not see', () => {
  it('folds the two Taw Caw rows he named the same thing', () => {
    // lake_marion: the national feed's `Taw Caw Park` and an OSM node 10.8 m away with no name.
    // They did not share a name when the index was built. HE gave them one, in the roll call, and
    // that happens afterwards -- so his picker showed `Taw Caw main lake ramp` twice.
    const byLake = new Map([['lake_marion', [
      pt({ name: 'Taw Caw main lake ramp', lat: 33.535388, lon: -80.33168 }),
      pt({ name: 'Taw Caw main lake ramp', lat: 33.535371, lon: -80.3317943,
           sourcePath: 'registry:osm', typeLabel: 'Slipway (OSM)' }),
    ]]]);
    expect(collapseRenamed(byLake)).toBe(1);
    expect(byLake.get('lake_marion').length).toBe(1);
  });

  it('leaves the two Taw Caw ramps he named differently as two launches', () => {
    // 152 m apart -- INSIDE the 180 m gate -- and he called one `Taw Caw main lake ramp` and the
    // other `Taw Caw Creek Boat Ramp`. Two ramps, and the gate is `and`, not `or`.
    const byLake = new Map([['lake_marion', [
      pt({ name: 'Taw Caw main lake ramp', lat: 33.535388, lon: -80.33168 }),
      pt({ name: 'Taw Caw Creek Boat Ramp', lat: 33.534123, lon: -80.331067 }),
    ]]]);
    expect(collapseRenamed(byLake)).toBe(0);
    expect(byLake.get('lake_marion').length).toBe(2);
  });

  it('is safe to run on a list that has nothing to fold', () => {
    const byLake = new Map([
      ['a', [pt({ name: 'Bates Bridge', lat: 33.7669, lon: -80.6450 })]],
      ['b', []],
      ['c', [pt({ name: 'Low Falls', lat: 33.6000, lon: -80.4000 }),
             pt({ name: 'Sparkleberry', lat: 33.7000, lon: -80.5000 })]],
    ]);
    expect(collapseRenamed(byLake)).toBe(0);
    expect(byLake.get('c').length).toBe(2);
  });
});

describe('an unlabelled pin is not a launch he can pick', () => {
  const named = (n, extra) => pt({ name: n, unnamed: false, ...extra });
  const blank = (extra) => pt({ name: 'Unnamed access point', unnamed: true,
                                sourcePath: 'registry:osm', typeLabel: 'Slipway (OSM)', ...extra });

  it('drops the unnamed OSM slipways where a named launch already answers', () => {
    // The Congaree: seven `Unnamed access point — Slipway (OSM)` rows in his index, five of them
    // outside the river's own boundary and two within 47 m of a named ramp already on the list.
    const byLake = new Map([['congaree_river', [
      named('Bates Bridge', { lat: 33.7669, lon: -80.6450, sourcePath: 'registry:dnr' }),
      named('Thomas H Newman', { lat: 33.8800, lon: -80.7700, sourcePath: 'registry:dnr' }),
      blank({ lat: 34.2000, lon: -80.6000 }),
      blank({ lat: 34.0100, lon: -81.0500 }),
    ]]]);
    expect(hideUnnamedSlipways(byLake)).toBe(2);
    expect(byLake.get('congaree_river').map((x) => x.name))
      .toEqual(['Bates Bridge', 'Thomas H Newman']);
  });

  it('keeps the named OSM launches no agency files', () => {
    // 133 named OSM rows card-wide are more than 100 m from any agency row, and two of them are
    // on this river: Cedar Creek Canoe Launch and Jordan Memorial Boat Ramp. Filtering on the
    // SOURCE would have taken both.
    const byLake = new Map([['congaree_river', [
      named('Bates Bridge', { lat: 33.7669, lon: -80.6450, sourcePath: 'registry:dnr' }),
      named('Cedar Creek Canoe Launch', { lat: 33.8200, lon: -80.8300,
                                          sourcePath: 'registry:osm', typeLabel: 'Slipway (OSM)' }),
      blank({ lat: 34.2000, lon: -80.6000 }),
    ]]]);
    expect(hideUnnamedSlipways(byLake)).toBe(1);
    expect(byLake.get('congaree_river').map((x) => x.name))
      .toEqual(['Bates Bridge', 'Cedar Creek Canoe Launch']);
  });

  it('keeps the unlabelled pin where it is the only thing saying you can launch', () => {
    // 21 waters have no named access point at all -- berry_shoals_pond, hunt_pond, eureka_lake,
    // diversion_canal. Hiding the row there turns a thin answer into no answer.
    const byLake = new Map([['berry_shoals_pond', [
      blank({ lat: 34.9000, lon: -82.1000 }),
      blank({ lat: 34.9010, lon: -82.1010 }),
    ]]]);
    expect(hideUnnamedSlipways(byLake)).toBe(0);
    expect(byLake.get('berry_shoals_pond').length).toBe(2);
  });

  it('leaves an unnamed row from an agency feed alone', () => {
    // The rule was measured on OSM slipway nodes and it stops there. Three national-feed rows on
    // w_kerr_scott_reservoir carry no name beside seven that do; removing an agency record on the
    // strength of a count taken on OSM would be a claim the measurement never made.
    const byLake = new Map([['w_kerr_scott_reservoir', [
      named('Bandits Roost', { lat: 36.1300, lon: -81.2400 }),
      pt({ name: 'Unnamed access point', unnamed: true, lat: 36.1400, lon: -81.2500 }),
    ]]]);
    expect(hideUnnamedSlipways(byLake)).toBe(0);
    expect(byLake.get('w_kerr_scott_reservoir').length).toBe(2);
  });

  it('does not disturb a water with nothing to hide', () => {
    const byLake = new Map([['santee_river', [
      named('Pack\'s Landing', { lat: 33.6594, lon: -80.5150 }),
    ]]]);
    const before = byLake.get('santee_river');
    expect(hideUnnamedSlipways(byLake)).toBe(0);
    expect(byLake.get('santee_river')).toBe(before);
  });
});
