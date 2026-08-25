// THE CORPS PUBLISHES ITS OWN UNIT TABLE, AND OURS WAS A HAND-TYPED SUBSET OF IT.
//
// FIXTURE IS REAL. Every alias below is transcribed from `/cwms-data/units?office=SAS`, fetched
// 2026-08-25 -- 424 rows, each carrying its `abstract-parameter`, its `unit-system` and its
// registered `alternate-names`. Grouped here by the long-name the Corps files them under and
// lower-cased, which is the form conditions.js matches on.
//
// The point of driving the converters with the SOURCE'S OWN list rather than with examples is
// that it can fail for a reason nobody thought of. It did: `foot`, `meter`, `metre`, `ft3/sec`,
// `cu-ft/sec`, `cuft/sec`, `cusecs`, `m3/sec` and `cu-meters/sec` are all registered spellings
// of units this app already accepted under a different spelling, and every one of them used to
// return null -- an elevation or a release that silently was not there.
import { describe, it, expect } from './expect-shim.mjs';
import { cwmsToFeet, cwmsToCfs, cwmsUnitKind } from '../Worker/conditions.js';

// abstract-parameter: Length
const LENGTH = {
  'Feet':        { system: 'EN', aliases: ['feet', 'foot', 'ft'] },
  'Survey Feet': { system: 'EN', aliases: ['ftus', 'survey feet', 'survey foot'] },
  'Meters':      { system: 'SI', aliases: ['m', 'meter', 'meters', 'metre', 'metres'] },
  'Inches':      { system: 'EN', aliases: ['in', 'inch', 'inches'] },
  'Miles':       { system: 'EN', aliases: ['mi', 'mile', 'miles'] },
  'Centimeters': { system: 'SI', aliases: ['centimeter', 'centimeters', 'cm'] },
  'Kilometers':  { system: 'SI', aliases: ['kilometer', 'kilometers', 'km'] },
  'Millimeters': { system: 'SI', aliases: ['millimeter', 'millimeters', 'mm'] },
};

// abstract-parameter: Volume Rate
const VOLUME_RATE = {
  'Cubic feet per second':
    { system: 'EN', aliases: ['cfs', 'cu-ft/sec', 'cuft/sec', 'cusecs', 'ft3/s', 'ft3/sec', 'ft^3/s'] },
  'Cubic meters per second':
    { system: 'SI', aliases: ['cms', 'cu-meters/sec', 'm3/s', 'm3/sec'] },
  'Kilo-cubic feet per second':
    { system: 'EN', aliases: ['1000 cfs', '1000 cu-ft/sec', '1000 ft3/sec', 'kcfs'] },
  'Kilo-cubic meters per second':
    { system: 'SI', aliases: ['1000 cms', 'kcms'] },
  'Gallons per minute':
    { system: 'EN', aliases: ['gal/min', 'gallons per minute', 'gpm'] },
  'Millions of gallons per day':
    { system: 'EN', aliases: ['mgd', 'million gallons/day'] },
  'Million cubic meters per month':
    { system: 'EN', aliases: ['mcm/mon'] },
  '1000 acre-feet per month':
    { system: 'EN', aliases: ['1000 ac-ft/mon', 'kaf/mon'] },
};

const all = (t) => Object.values(t).flatMap((v) => v.aliases);

describe('zero units the Corps publishes that this file has no opinion about', () => {
  it('every registered Length alias is length or declined, never unknown', () => {
    const unknown = all(LENGTH).filter((u) => cwmsUnitKind(u) === 'unknown');
    expect(unknown).toEqual([]);
  });

  it('every registered Volume Rate alias is flow or declined, never unknown', () => {
    const unknown = all(VOLUME_RATE).filter((u) => cwmsUnitKind(u) === 'unknown');
    expect(unknown).toEqual([]);
  });

  it('still says unknown for something genuinely off the table', () => {
    // A check that cannot fail is not a check.
    expect(cwmsUnitKind('furlongs')).toBe('unknown');
    expect(cwmsUnitKind('')).toBe('unknown');
    expect(cwmsUnitKind(null)).toBe('unknown');
    expect(cwmsUnitKind(undefined)).toBe('unknown');
  });

  it('declined is a different answer from unknown', () => {
    // Miles are a registered Length and are never a lake level. Understood, and refused.
    expect(cwmsUnitKind('miles')).toBe('declined');
    expect(cwmsUnitKind('gpm')).toBe('declined');
    expect(cwmsToFeet(100, 'miles')).toBe(null);
    expect(cwmsToCfs(100, 'gpm')).toBe(null);
  });
});

describe('the nine spellings that used to return null', () => {
  // Each of these is a REGISTERED alias of a unit the old hand-typed ladder already accepted
  // under a different spelling. Every one produced an absence.
  const WAS_MISSING = [
    ['foot', 660, 660],
    ['meter', 201.2, 660.1],
    ['metre', 201.2, 660.1],
  ];
  for (const [unit, value, feet] of WAS_MISSING) {
    it(`${unit} converts instead of vanishing`, () => {
      expect(cwmsToFeet(value, unit)).toBe(feet);
    });
  }

  const WAS_MISSING_FLOW = ['ft3/sec', 'cu-ft/sec', 'cuft/sec', 'cusecs'];
  for (const unit of WAS_MISSING_FLOW) {
    it(`${unit} is cubic feet per second, not nothing`, () => {
      expect(cwmsToCfs(4000, unit)).toBe(4000);
    });
  }

  for (const unit of ['m3/sec', 'cu-meters/sec']) {
    it(`${unit} is cubic metres per second, not nothing`, () => {
      expect(cwmsToCfs(100, unit)).toBe(3531);
    });
  }
});

describe('kcfs, which this app has already been burned by once', () => {
  it('is a thousand times cfs, not the same as cfs', () => {
    expect(cwmsToCfs(4, 'kcfs')).toBe(4000);
    expect(cwmsToCfs(4, 'cfs')).toBe(4);
  });

  it('covers the long spellings the Corps registers for it', () => {
    for (const u of ['1000 cfs', '1000 cu-ft/sec', '1000 ft3/sec']) {
      expect(cwmsToCfs(4, u)).toBe(4000);
    }
  });

  it('and the metric kilo unit too', () => {
    expect(cwmsToCfs(1, 'kcms')).toBe(35315);
    expect(cwmsToCfs(1, '1000 cms')).toBe(35315);
  });
});

describe('nothing that used to work stopped working', () => {
  // The exact set the hand-typed ladders accepted before 2026-08-25. A silent narrowing shows
  // up as an absence, and an absence is the one thing no output shows.
  it('every previously-accepted length spelling still converts', () => {
    expect(cwmsToFeet(660, 'ft')).toBe(660);
    expect(cwmsToFeet(660, 'feet')).toBe(660);
    expect(cwmsToFeet(201.2, 'm')).toBe(660.1);
    expect(cwmsToFeet(201.2, 'meters')).toBe(660.1);
    expect(cwmsToFeet(201.2, 'metres')).toBe(660.1);
  });

  it('every previously-accepted flow spelling still converts', () => {
    expect(cwmsToCfs(4000, 'cfs')).toBe(4000);
    expect(cwmsToCfs(4000, 'ft3/s')).toBe(4000);
    expect(cwmsToCfs(4000, 'ft^3/s')).toBe(4000);
    expect(cwmsToCfs(100, 'cms')).toBe(3531);
    expect(cwmsToCfs(100, 'm3/s')).toBe(3531);
  });

  it('keeps `m^3/s`, which we invented and the Corps does not register', () => {
    // Dropping a spelling this file already accepted would be a narrowing. It can only ever
    // mean cubic metres per second, registered or not.
    expect(cwmsToCfs(100, 'm^3/s')).toBe(3531);
    expect(cwmsUnitKind('m^3/s')).toBe('flow');
  });
});

describe('survey feet', () => {
  it('are feet, to two parts per million', () => {
    // 0.0013 ft at a 660 ft full pool. Refusing an elevation over that would buy an absence
    // and nothing else.
    expect(cwmsToFeet(660, 'ftUS')).toBe(660);
    expect(cwmsToFeet(660, 'survey feet')).toBe(660);
    expect(cwmsToFeet(660, 'survey foot')).toBe(660);
  });

  it('are still a distinct registered unit, not an alias of ft', () => {
    // Large enough and the difference shows, which is how we know the factor is applied.
    expect(cwmsToFeet(1000000, 'ftUS')).toBe(1000002);
    expect(cwmsToFeet(1000000, 'ft')).toBe(1000000);
  });
});

describe('case and whitespace, because the catalogue is not consistent about either', () => {
  it('matches regardless of case', () => {
    expect(cwmsToFeet(660, 'FEET')).toBe(660);
    expect(cwmsToFeet(201.2, 'METERS')).toBe(660.1);
    expect(cwmsToCfs(4, 'KCFS')).toBe(4000);
  });

  it('trims', () => {
    expect(cwmsToFeet(660, '  ft  ')).toBe(660);
    expect(cwmsToCfs(4000, ' cfs')).toBe(4000);
  });
});

describe('a value that is not a number is not a reading', () => {
  for (const bad of [null, undefined, NaN, Infinity, -Infinity, '660']) {
    it(`refuses ${String(bad)}`, () => {
      expect(cwmsToFeet(bad, 'ft')).toBe(null);
      expect(cwmsToCfs(bad, 'cfs')).toBe(null);
    });
  }

  it('does not swallow a legitimate zero', () => {
    expect(cwmsToFeet(0, 'ft')).toBe(0);
    expect(cwmsToCfs(0, 'cfs')).toBe(0);
  });
});

describe('a real reading', () => {
  it('Hartwell reads the same through either unit system', () => {
    // Hartwell.Elev-Pool.Inst.1Hour.0.Raw-SHEF_SAS answered 651.59 ft on 2026-08-24, and the
    // catalogue declares the same series in metres. 198.605 m is that number.
    expect(cwmsToFeet(651.59, 'ft')).toBe(651.59);
    expect(cwmsToFeet(198.605, 'm')).toBe(651.59);
  });
});
