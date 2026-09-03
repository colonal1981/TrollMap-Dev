// THREE ALERTS FROM THREE OTHER RIVER BASINS, ON ONE WORD.
//
// Reported by Ryan 2026-08-25. A conditions card for the Lower Saluda at Saluda Shoals carried:
//
//     Mountain Island Tailrace Fishing Area and Mountain Island Park   -> Lake Wylie, Catawba
//     Mile Creek Park                                                  -> Lake Keowee
//     Morrow Mountain State Park                                       -> Lake Tillery, Yadkin
//
// The word was `park`, and it entered the Lower Saluda's token set from the water's OWN gauge:
// `SALUDA RIVER AT SALUDA SHOALS PARK AT COLUMBIA, SC`. `columbia` and `shoals` were in there
// with it and were the next two waiting to do the same thing.
//
// FIXTURE IS REAL. Every row below is transcribed from
// _captures/api.hydro-derived.duke-energy.app_access-alerts.json — 28 alerts across 10 groups,
// flattened to the shape parseAccessAlerts produces.
import { describe, it, expect } from './expect-shim.mjs';
import { alertsForWater, dukeLocationIdFor } from '../Worker/conditions.js';

const A = (kind, water, place, id) => ({ kind, water, place, water_location_id: id ?? null });

const FEED = [
  A('RIVERBASIN', '', 'All Projects'),
  A('POI', 'Ninety-Nine Islands Reservoir', 'Ninety-Nine Islands Tailrace', 21),
  A('POI', 'Ninety-Nine Islands Reservoir', 'Ninety-Nine Islands Canoe Portage', 21),
  A('LAKEPOND', 'Great Falls Reservoir', 'DEARBORN', 8),
  A('POI', 'Mountain Island Lake', 'Riverbend Access Area', 12),
  A('POI', 'Lake Hickory', 'Oxford Dam Canoe Portage', 9),
  A('LAKEPOND', 'Lake Hickory', 'Lake Hickory', 9),
  A('POI', 'Lake Wateree', 'Taylors Creek Access Area', 17),
  A('POI', 'Lake Wateree', 'Buck Hill Access Area', 17),
  A('POI', 'Lake Wylie', 'Mountain Island Tailrace Fishing Area and Mountain Island Park', 19),
  A('POI', 'Lake Wylie', 'Buster Boyd Access Area', 19),
  A('POI', 'Lake Wylie', 'South Point Access Area - Day Use', 19),
  A('POI', 'Lake Wylie', 'Ebenezer Access Area', 19),
  A('POI', 'Lake Wylie', 'Allison Creek Access Area', 19),
  A('RIVERBASIN', '', 'Duke Energy Swim Beaches'),
  A('POI', 'Lake Keowee', 'Mile Creek Park', 10),
  A('POI', 'Lake Keowee', 'Keowee Town Access Area', 10),
  A('LAKEPOND', 'Bear Creek Lake', 'Bear Creek Lake', 2),
  A('LAKEPOND', 'Lake Glenville', 'THORPE', 11),
  A('POI', 'Tanasee Creek Lake', 'Tanasee Creek Access Area', 15),
  A('LAKEPOND', 'Wolf Creek Lake', 'Wolf Creek Lake', 18),
  A('RIVERBASIN', '', 'Others'),
  A('LAKEPOND', 'Belews Lake', 'Belews Creek Lake', 3),
  A('POI', '', 'Walters Fishing Trail Behind Powerhouse'),
  A('POI', '', 'Walters Picnic Area'),
  A('POI', '', 'Pigeon River Access '),
  A('RIVERBASIN', '', 'Ohio River'),
  A('POI', 'Lake Tillery', 'Morrow Mountain State Park', 16),
];

// The gauges bound to saluda_river_lower_saluda, verbatim from water_bindings.json. The fourth
// is the one that poisoned the token set.
const LOWER_SALUDA_GAUGES = [
  'Saluda River below Lake Murray Dam',
  'Saluda River at I-20 near Columbia',
  'Saluda River near Riverbanks Zoo',
  'SALUDA RIVER AT SALUDA SHOALS PARK AT COLUMBIA, SC',
  'Saluda River at Lake Murray Dam near Irmo',
];
const LOWER_SALUDA = 'Saluda River (Lower Saluda) (Lexington Co, SC)';

const places = (w, g) => alertsForWater(FEED, w, g || []).map((a) => a.place);

describe('the reported bug', () => {
  it('the Lower Saluda gets no Duke alerts at all', () => {
    // Duke does not operate on the Saluda. Lake Murray is Dominion.
    expect(places(LOWER_SALUDA, LOWER_SALUDA_GAUGES)).toEqual([]);
  });

  it('and none of the three specifically', () => {
    const got = places(LOWER_SALUDA, LOWER_SALUDA_GAUGES).join(' | ');
    expect(got.includes('Mountain Island')).toBe(false);
    expect(got.includes('Mile Creek')).toBe(false);
    expect(got.includes('Morrow Mountain')).toBe(false);
  });

  it('holds even without the gauge that carried the word', () => {
    expect(places(LOWER_SALUDA, ['SALUDA RIVER AT SALUDA SHOALS PARK AT COLUMBIA, SC'])).toEqual([]);
  });
});

describe('the waters that own these alerts still get them', () => {
  it('Lake Keowee keeps Mile Creek Park', () => {
    expect(places('Lake Keowee (Oconee Co, SC)')).toContain('Mile Creek Park');
  });

  it('Lake Tillery keeps Morrow Mountain State Park', () => {
    expect(places('Lake Tillery (Montgomery Co, NC)')).toContain('Morrow Mountain State Park');
  });

  it('Lake Wateree keeps both of its access areas', () => {
    const p = places('Wateree Lake (Kershaw Co, SC)', ['Wateree River at Lake Wateree Dam']);
    expect(p).toContain('Taylors Creek Access Area');
    expect(p).toContain('Buck Hill Access Area');
  });

  it('Lake Wylie keeps all five', () => {
    expect(places('Lake Wylie (York Co, SC)').length).toBe(5);
  });
});

describe('the case this function was built for survives', () => {
  it('Mountain Island Lake reaches an alert filed under Lake Wylie, because it is named twice', () => {
    const p = places('Mountain Island Lake (Gaston Co, NC)');
    expect(p).toContain('Mountain Island Tailrace Fishing Area and Mountain Island Park');
    expect(p).toContain('Riverbend Access Area');
  });

  it('but does NOT reach Morrow Mountain, which names it once', () => {
    // `mountain` alone is not a water. This is the second-signal rule, not a stop word.
    expect(places('Mountain Island Lake (Gaston Co, NC)')).not.toContain('Morrow Mountain State Park');
  });
});

describe('an alert with no water of its own falls back to one word', () => {
  it('Pigeon River finds its access, which is all the alert names', () => {
    expect(places('Pigeon River (Haywood Co, NC)')).toContain('Pigeon River Access ');
  });

  it('and a water with nothing in common still gets nothing', () => {
    expect(places('Lake Murray (Lexington Co, SC)')).toEqual([]);
  });
});

describe('basin notices are never place alerts', () => {
  it('no RIVERBASIN row is ever returned', () => {
    for (const w of ['Lake Wylie (York Co, SC)', 'Lake Keowee (Oconee Co, SC)', LOWER_SALUDA]) {
      for (const p of places(w, LOWER_SALUDA_GAUGES)) {
        expect(['All Projects', 'Duke Energy Swim Beaches', 'Others', 'Ohio River']).not.toContain(p);
      }
    }
  });
});

describe('the location id comes back for the right waters only', () => {
  it('finds Wateree', () => {
    expect(dukeLocationIdFor(FEED, 'Wateree Lake (Kershaw Co, SC)')).toBe(17);
  });

  it('finds Keowee', () => {
    expect(dukeLocationIdFor(FEED, 'Lake Keowee (Oconee Co, SC)')).toBe(10);
  });

  it('returns nothing for the Lower Saluda, gauges and all', () => {
    expect(dukeLocationIdFor(FEED, LOWER_SALUDA, LOWER_SALUDA_GAUGES)).toBe(null);
  });

  it('returns nothing rather than guessing on an empty name', () => {
    expect(dukeLocationIdFor(FEED, '')).toBe(null);
    expect(dukeLocationIdFor(FEED, null)).toBe(null);
  });
});

describe('the empty cases', () => {
  it('no alerts is not an error', () => {
    expect(alertsForWater([], LOWER_SALUDA, LOWER_SALUDA_GAUGES)).toEqual([]);
    expect(alertsForWater(null, LOWER_SALUDA)).toEqual([]);
  });

  it('a water with no distinctive words matches nothing rather than everything', () => {
    // "Lake" and "Reservoir" are stop words, so this name reduces to nothing at all.
    expect(alertsForWater(FEED, 'The Lake')).toEqual([]);
  });
});

// ── AND THE SAME BUG AGAIN, ON THE WORD THE FILE PREDICTED ──────────────────────────────────
//
// Reported by Ryan 2026-09-03, from the Conditions tab of a saltwater inlet:
//
//     Vs Duke guide      +0.3 ft against a guide curve of 96 on a scale where 100 is
//                        full pond (647.5 ft AMSL)
//     Duke drought stage Stage 0 - Low Inflow Protocol
//     Access (1)         Riverbend Access Area
//
// 647.5 ft AMSL is Mountain Island Lake, on the Catawba, three hundred kilometres from Murrells
// Inlet. The shared word is `island`, and it enters the inlet's token set from its own display
// name -- "Murrells Inlet / Pawleys Island, SC".
//
// alertsForWater's own comment, written 2026-08-25 for the `park` bug at the top of this file,
// named it in advance: "The next one is `creek`, then `island`, then `point`." It was `island`,
// and it got through because the water branch took ONE token where the place branch took two.
// The water branch now takes two as well.
const MURRELLS = 'Murrells Inlet / Pawleys Island, SC';
const MURRELLS_GAUGES = [
  'Atlantic Intracoastal Waterway at Myrtle Beach',
  'Atlantic Coast at Myrtle Beach Springmaid Pier (IN MLLW)',
  'Atlantic Intracoastal Waterway above Aiw At Hwy 544 At Socastee',
];

describe('a saltwater inlet is not a Duke reservoir', () => {
  it('Murrells Inlet gets no Duke alert on the word island', () => {
    expect(places(MURRELLS, MURRELLS_GAUGES)).toEqual([]);
  });

  it('and no Duke operating range, which is where the 647.5 ft full pond came from', () => {
    // `found.size === 1` could not catch this: exactly one wrong id was found, so the
    // ambiguity guard saw an unambiguous answer and returned it.
    expect(dukeLocationIdFor(FEED, MURRELLS, MURRELLS_GAUGES)).toBe(null);
  });

  it('Mountain Island Lake still gets its own Riverbend alert and its own id', () => {
    // The fix must not be a stopword that deletes the word for everybody.
    const mine = places('Mountain Island Lake (Gaston Co, NC)', ['Catawba River at Mountain Island Dam']);
    expect(mine.includes('Riverbend Access Area')).toBe(true);
    expect(dukeLocationIdFor(FEED, 'Mountain Island Lake (Gaston Co, NC)')).toBe(12);
  });
});
