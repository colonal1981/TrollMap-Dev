import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from './expect-shim.mjs';
import { RAMP_SOURCES, RAMP_STATES } from '../Worker/core/ramp-sources.js';
// access-index.js publishes legacy global helpers on `window` at module scope, so it needs one
// before it can be imported under node. Same shim live-ramps-reach-the-filter.test.js uses.
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const { rampMeta } = await import('../js/data/access-index.js');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE SPECIES WAS ON THE FEED AND TWO SEPARATE PLACES THREW IT AWAY
//
// Ryan, 2026-09-04: "why not stop the worker from throwing away the species lists that comes in
// with the ramps feed". There were two throws, one behind the other.
//
// FIRST, in the Worker. `RAMP_SOURCES` in trollmap-worker.js served /ramps and
// `RESEARCH_RAMP_SOURCES` in research/facts-util.js served the research pipeline, off the SAME
// four ArcGIS layers. They had drifted one way: the research copy read a species list, the app
// copy read one for South Carolina and asked Georgia for South Carolina's field name.
//
// SECOND, in the browser. access-index.js read `raw.meta || {}` and there has never been a
// `raw.meta` -- groupFeaturesByWaterbody() flattens meta onto the record with Object.assign. So
// South Carolina's species DID arrive and were dropped one line from being usable, and
// lake-research-engine.js:1160 read `r.meta?.lanes` into undefined for the same reason.
//
// Measured off the saved feeds, which are the app copy's own output:
//     _dnr_ramps_sc.json  438 ramps / 144 waterbodies   species PRESENT
//     _dnr_ramps_ga.json  659 ramps / 218 waterbodies   species absent
//     _dnr_ramps_nc.json  265 ramps / 114 waterbodies   species absent  (layer has none)
//     _dnr_ramps_tn.json  678 ramps / 136 waterbodies   species absent  (layer has none)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');
const live = (js) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('there is one ramp source table', () => {
  it('and neither caller declares its own', () => {
    for (const f of ['Worker/trollmap-worker.js', 'Worker/research/facts-util.js']) {
      const t = live(src(f));
      expect(/RAMP_SOURCES\s*=\s*\{\s*\n?\s*SC:/.test(t)).toBe(false);
      expect(/from '\.\.?\/core\/ramp-sources\.js'/.test(t)).toBe(true);
    }
  });

  it('covers the four states the app has always asked for', () => {
    expect(Object.keys(RAMP_SOURCES).sort()).toEqual(['GA', 'NC', 'SC', 'TN']);
    expect(RAMP_STATES.slice().sort()).toEqual(['GA', 'NC', 'SC', 'TN']);
  });

  it('has no metaMode, which nothing ever read', () => {
    // groupFeaturesByWaterbody() flattens meta unconditionally. A property that looks like a
    // switch and is not one is worse than no property.
    expect(live(src('Worker/core/ramp-sources.js')).includes('metaMode')).toBe(false);
    expect(live(src('Worker/trollmap-worker.js')).match(/metaMode/g)?.length ?? 0)
      .toBe(4);   // the four ATTRACTOR_SOURCES entries, which are a different table
  });
});

describe('every layer that publishes species now yields one', () => {
  it('South Carolina passes SpeciesList straight through', () => {
    const m = RAMP_SOURCES.SC.meta({
      WaterAccessName: 'Clearwater Cove', SpeciesList: 'Largemouth Bass, Blue Catfish',
      LaunchLanes: 2, County: 'Fairfield', Owner: 'SCDNR',
    });
    expect(m.species).toBe('Largemouth Bass, Blue Catfish');
  });

  it('Georgia is read off its forty-eight columns, NOT off SpeciesList', () => {
    // Asking this layer for `SpeciesList` is what returned undefined on 892 of 895 access points.
    const p = { Name: 'Clarks Bridge', NumLanes: 4, County: 'Hall', Ramp: 'Y', Status: 'Active',
                SpeciesList: 'THIS FIELD DOES NOT EXIST ON THIS LAYER',
                Largemouth: 'Y', SpotBass: 'Y', StripBass: 'Y', Smallmouth: 'N', ShoalBass: 'U' };
    const m = RAMP_SOURCES.GA.meta(p);
    expect(m.species).toBe('Largemouth Bass, Spotted Bass, Striped Bass');
    expect(m.species.includes('DOES NOT EXIST')).toBe(false);
    // `U` is unknown, which is not a fish.
    expect(m.species.includes('Shoal Bass')).toBe(false);
  });

  it('and the two states whose layers have none emit no key at all', () => {
    // Absent is "not published". `species: ''` reads as "published, and empty" and would be a
    // column that is null on every NC and TN row forever. NC's species come from
    // registry/nc_species_by_lake.json instead.
    expect('species' in RAMP_SOURCES.NC.meta({})).toBe(false);
    expect('species' in RAMP_SOURCES.TN.meta({})).toBe(false);
  });
});

describe('where the two copies disagreed', () => {
  it('Georgia keeps the wider ramp flag', () => {
    // flagIsYes accepts y/yes/1/true/t; the research copy accepted only exactly 'Y'.
    for (const v of ['Y', 'y', 'yes', 'true', 1, true]) {
      expect(RAMP_SOURCES.GA.filter({ Ramp: v, Status: 'Active' })).toBe(true);
    }
    expect(RAMP_SOURCES.GA.filter({ Ramp: 'N', Status: 'Active' })).toBe(false);
    expect(RAMP_SOURCES.GA.filter({ Ramp: 'Y', Status: 'Closed' })).toBe(false);
  });

  it('Tennessee keeps BOTH predicates, because they test different things', () => {
    // app copy      Status not closed/inactive   -- is the site open
    // research copy Ramps not none/0             -- is there a ramp at all
    // Two of the three copies of this table checked one and not the other. A closed site is not
    // a ramp, and a launch site with no ramp is not a ramp either.
    const ok = { Type: 'Boat Launch', IncludeWeb: 'Yes', Status: 'Active', Ramps: '2' };
    expect(RAMP_SOURCES.TN.filter(ok)).toBe(true);
    expect(RAMP_SOURCES.TN.filter({ ...ok, Status: 'Closed' })).toBe(false);
    expect(RAMP_SOURCES.TN.filter({ ...ok, Ramps: 'None' })).toBe(false);
    expect(RAMP_SOURCES.TN.filter({ ...ok, Ramps: '0' })).toBe(false);
    expect(RAMP_SOURCES.TN.filter({ ...ok, Type: 'Marina' })).toBe(false);
    // IncludeWeb reaches flagIsYes now rather than an exact 'Yes' compare.
    expect(RAMP_SOURCES.TN.filter({ ...ok, IncludeWeb: 'yes' })).toBe(true);
  });
});

describe('the browser stops throwing it away too', () => {
  const SC_RAMP = { name: 'B & C', lat: 32.485351, lon: -81.207779, lanes: 1, dock: 'No',
                    fee: false, species: 'Bluegill, Largemouth Bass, Striped Bass',
                    county: 'Jasper', owner: 'SCDNR' };

  it('lifts the flat feed record into the meta shape both readers ask for', () => {
    // This is the exact shape of a row in registry/_dnr_ramps_sc.json.
    const m = rampMeta(SC_RAMP);
    expect(m.species).toBe('Bluegill, Largemouth Bass, Striped Bass');
    expect(m.lanes).toBe(1);
    expect(m.county).toBe('Jasper');
  });

  it('does not invent keys the feed did not send', () => {
    const m = rampMeta({ name: 'x', lat: 1, lon: 2 });
    expect(Object.keys(m)).toEqual([]);
    expect(rampMeta(null)).toEqual({});
  });

  it('and a feed that ever does nest its meta still wins', () => {
    expect(rampMeta({ meta: { species: 'Walleye' }, species: 'ignored' }).species).toBe('Walleye');
  });
});

describe('the third copy is deliberate, and still points at the same layers', () => {
  // Scripts/build_dnr_ramps_by_lake.py keeps its own table ON PURPOSE and its header says why:
  // "a second independent implementation is the only thing that catches a predicate which
  // silently rejects every row -- the failure that left TN at count:0 and GA ramps empty."
  // So it is not collapsed. It is held to the same four services.
  // Whitespace-collapsed: the URLs are split across lines by Python string concatenation and
  // the header sentence is wrapped by the comment width.
  const py = src('Scripts/build_dnr_ramps_by_lake.py')
    .replace(/'\s*\n\s*'/g, '')          // rejoin split string literals
    .replace(/\n#\s*/g, ' ')              // unwrap comment lines
    .replace(/\s+/g, ' ');

  it('names the same ArcGIS service for every state', () => {
    for (const st of Object.keys(RAMP_SOURCES)) {
      const service = RAMP_SOURCES[st].url.split('/rest/services/')[1].split('/FeatureServer')[0];
      expect(py.includes(service)).toBe(true);
    }
  });

  it('and still says out loud that it is a second implementation', () => {
    expect(py.includes('second independent implementation')).toBe(true);
  });
});
