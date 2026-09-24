import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { parseActiveRun, parseDukeRunTime } from '../Worker/conditions.js';
import { easternOffsetFor, RIVERS } from '../Worker/worker-data.js';

// ---------------------------------------------------------------------------
// Ryan, 2026-09-23: "but all of that at least for duke rivers is available on
// their api... and the worker pulls it... or at least i thought i did.. is it
// just not used?"
//
// He was right. Three endpoints, all keyed on the same basin id that
// dukeBasinFor() already derives from the live roster plus the bound gauge
// names, and he pasted all three live:
//
//   /rivers/active-run            the generation window per dam, start AND end
//   /rivers/flow-arrivals/{basin} arrival + recession at named mile markers
//   /calendar-v2                  the USGS site Duke itself calls authoritative
//                                 per reach, with the parameter code on it
//
// /conditions reads the first two properly. /river -- the route that makes the
// kayak go/no-go -- reads neither, and reconstructs the generation start from
// two hand-typed Wateree constants instead. The fixtures below are his captures
// and the arithmetic is what they prove.
// ---------------------------------------------------------------------------

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/operators/${n}`, import.meta.url), 'utf8'));
const ACTIVE = fx('duke-active-run.2026-09-23.json');
const ARRIVALS = fx('duke-flow-arrivals-1.2026-09-23.json');
const CAL = fx('duke-calendar-v2.2026-09-23.json');

describe('Duke publishes the generation window the app was inventing', () => {
  const rows = parseActiveRun(ACTIVE);

  it('parses all four basins and eleven dams out of the live payload', () => {
    expect(new Set(ACTIVE.map((r) => r.riverName)).size).toBe(11);
    expect([...new Set(rows.map((r) => r.basin_id))].sort((a, b) => a - b)).toEqual([1, 2, 3, 11]);
  });

  it('gives Wateree a real two-hour window on 2026-09-24', () => {
    const w = rows.filter((r) => r.dam === 'Wateree' && !r.no_release);
    expect(w.length).toBe(1);
    expect(w[0].start).toBe('2026-09-24T17:00:00-04:00');
    expect((w[0].end_epoch - w[0].start_epoch) / 36e5).toBe(2);
  });

  it('reports no generator count, because Duke sends none', () => {
    // `Units` is "" on every real release and "N/A" on every no-release row. The generator count
    // is TVA's field, not Duke's -- so a release's SIZE has to come from the gauge below the dam,
    // which is exactly what /calendar-v2 names.
    expect(rows.filter((r) => !r.no_release).every((r) => r.generators === null)).toBe(true);
  });

  it('keeps a no-release day as a dated fact with no epoch', () => {
    const nr = rows.filter((r) => r.no_release);
    expect(nr.length).toBe(25);
    expect(nr.every((r) => r.date && r.start_epoch === null)).toBe(true);
  });

  it('refuses a window that ends before it starts', () => {
    // Live in the feed: Nantahala 09/24 start 07:30 PM, end 07:00 PM. Minus thirty minutes.
    const bad = rows.find((r) => r.dam === 'Nantahala' && r.date === '2026-09-24');
    expect(bad.start).toBe('2026-09-24T19:30:00-04:00');
    expect(bad.end_epoch).toBe(null);
    expect(bad.end_before_start).toBe('2026-09-24T19:00:00-04:00');
    // And every window that survives has a positive duration.
    for (const r of rows.filter((x) => x.end_epoch != null)) {
      expect(r.end_epoch > r.start_epoch).toBe(true);
    }
  });
});

describe('the typed surge speed against what Duke actually published', () => {
  // Duke: generation 17:00-19:00, arrival at Highway 1/Highway 601 Landing 18:48, recedes 23:48.
  const ev = ARRIVALS.Dams[0].FlowArrivalRecessions[0];
  const genStart = Date.parse('2026-09-24T17:00:00-04:00');
  const arrival = Date.parse(`${ev.Arrival}-04:00`);
  const recedes = Date.parse(`${ev.Recedes}-04:00`);

  // THE ANCHOR IS A HISTORICAL VALUE NOW, WHICH IS WHY IT IS WRITTEN HERE AND NOT READ.
  // `RIVERS.wateree.dukeAnchorRiverMi` was 7.4 and is deleted: /river's back-computation was its
  // only reader. The number stays in this file because it is what the arithmetic below is ABOUT,
  // and a measurement that loses its inputs stops being checkable.
  const ANCHOR_MI_AS_TYPED = 7.4;

  it('is the landing the deleted anchor was calibrated on', () => {
    expect(ev.MileMarkerName).toBe('Highway 1/Highway 601 Landing');
    expect(RIVERS.wateree.dukeAnchorRiverMi).toBe(undefined);
  });

  // THE TYPED SPEED IS A HISTORICAL VALUE NOW TOO. `RIVERS.wateree.surgeSpeed_mph` was 2.5 and
  // was deleted 2026-09-24, when getRiver started reading the time off Duke's own timed places on
  // the pack's centreline (see the-surge-is-timed-by-dukes-own-clock.test.js). Kept here for the
  // same reason as the anchor above: it is what the arithmetic below is ABOUT.
  const SPEED_AS_TYPED = 2.5;

  it('measures 4.1 mph where the table said 2.5', () => {
    const travelH = (arrival - genStart) / 36e5;
    expect(Math.round(travelH * 60)).toBe(108);
    expect(Math.round((ANCHOR_MI_AS_TYPED / travelH) * 100) / 100).toBe(4.11);
    // The typed constant's own comment claimed "arrives ~3h after generation start". It is 1.8 h.
    expect(RIVERS.wateree.surgeSpeed_mph).toBe(undefined);
    expect(Math.round(ANCHOR_MI_AS_TYPED / SPEED_AS_TYPED * 60)).toBe(178);
  });

  it('would have put the reconstructed generation start 70 minutes early', () => {
    // What /river DID until 2026-09-23: arrivalEpoch - (7.4 mi / 2.5 mph), to invent a start time
    // Duke publishes outright one endpoint over.
    const reconstructed = arrival - (ANCHOR_MI_AS_TYPED / SPEED_AS_TYPED) * 36e5;
    expect(Math.round((genStart - reconstructed) / 6e4)).toBe(70);
  });

  it('and /river now takes the start from the feed instead', () => {
    const src = readFileSync(new URL('../Worker/trollmap-worker.js', import.meta.url), 'utf8');
    expect(src.includes('anchorTravelMs')).toBe(false);
    expect(src.includes('generationStartEpoch = next.start_epoch')).toBe(true);
    // parseActiveRun's start_epoch IS the published window start -- the same rows this fixture
    // exercises above.
    expect(src.includes('parseActiveRun(await fetchDukeActiveRun()')).toBe(true);
  });

  it('carries a recession nothing reads — five hours for the pulse to pass', () => {
    expect((recedes - arrival) / 36e5).toBe(5);
  });
});

describe('/river resolves its basin instead of reading a typed one', () => {
  const src = readFileSync(new URL('../Worker/trollmap-worker.js', import.meta.url), 'utf8');
  const data = readFileSync(new URL('../Worker/worker-data.js', import.meta.url), 'utf8');

  it('no RIVERS entry carries a basin id any more', () => {
    expect(data.includes('dukeBasinId:')).toBe(false);
    for (const key of Object.keys(RIVERS)) {
      expect(RIVERS[key].dukeBasinId).toBe(undefined);
    }
  });

  it('getRiver asks dukeBasinFor with the water and its own gauge names', () => {
    expect(src.includes('dukeBasinFor(roster, cfg.label || key, gaugeNames)')).toBe(true);
    expect(src.includes("(cfg.gauges || []).map((g) => g && g.name)")).toBe(true);
  });

  it('every one of the six rivers now has gauge names to match on', () => {
    // The basin match is only as good as its evidence, and the gauge names ARE the evidence --
    // NWS names a gauge for the river it sits on. A river with no named gauge would resolve to
    // null and silently lose its schedule, which is the failure this replaced.
    for (const [key, cfg] of Object.entries(RIVERS)) {
      const names = (cfg.gauges || []).map((g) => g && g.name).filter(Boolean);
      expect(`${key}: ${names.length}`).not.toBe(`${key}: 0`);
    }
  });
});

describe('US/Eastern, not EDT year-round', () => {
  it('is -04:00 in September and -05:00 in December', () => {
    expect(easternOffsetFor(2026, 9, 24)).toBe('-04:00');
    expect(easternOffsetFor(2026, 12, 15)).toBe('-05:00');
  });

  it('stamps a Duke release time with the offset in force on its own date', () => {
    // Duke sends local time with no offset. A literal -04:00 made every release, arrival and
    // recession an hour late from the first Sunday in November to the second in March.
    expect(parseDukeRunTime('09/24/2026 05:00:00 PM').iso).toBe('2026-09-24T17:00:00-04:00');
    expect(parseDukeRunTime('12/15/2026 05:00:00 PM').iso).toBe('2026-12-15T17:00:00-05:00');
  });

  it('falls back to standard time rather than summer when it cannot tell', () => {
    expect(easternOffsetFor('nope', 'nope', 'nope')).toBe('-05:00');
  });
});

describe('/calendar-v2 names the gauge Duke itself trusts per reach', () => {
  const inner = JSON.parse(CAL.body);

  it('arrives inside a Lambda envelope whose body is a JSON string', () => {
    expect(CAL.statusCode).toBe(200);
    expect(typeof CAL.body).toBe('string');
    expect(Array.isArray(inner.calendar)).toBe(true);
  });

  it('carries the USGS site number and the parameter code in the url', () => {
    const rows = inner.calendar
      .filter((r) => !r.is_pdf)
      .map((r) => ({
        loc: r.location_id,
        site: (/USGS-(\d+)/.exec(r.url) || [])[1] || null,
        param: (/dataTypeId=continuous-(\d{5})/.exec(r.url) || [])[1] || null,
      }));
    // The Camden gauge is the one RIVERS.wateree's own comment names as its anchor, and Duke
    // publishes it against basin 1 rather than leaving it to be typed.
    expect(rows.some((r) => r.loc === 1 && r.site === '02148000' && r.param === '00060')).toBe(true);
    // And a reach where the operator cares about STAGE, not discharge.
    expect(rows.some((r) => r.loc === 3 && r.site === '02126375' && r.param === '00065')).toBe(true);
  });

  it('keys on the same basin id as the other two endpoints', () => {
    const basins = new Set(parseActiveRun(ACTIVE).map((r) => r.basin_id));
    expect(inner.calendar.every((r) => basins.has(r.location_id))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AND THE ROSTER NAMES SEVEN BASINS, TWO OF WHICH HE FISHES.
//
// /rivers/get-rivers, pasted live 2026-09-23. active-run only carried 1, 2, 3
// and 11 because those are the basins with a release scheduled this week. The
// roster itself has Broad River (10) and Keowee-Toxaway (6) as well.
//
// RIVERS types `dukeBasinId` on two of its six entries. dukeBasinFor() resolves
// all seven from the live roster plus the water's own bound gauge names, with no
// table -- which is the whole argument for deleting the typed id.
// ---------------------------------------------------------------------------
import { dukeBasinFor } from '../Worker/conditions.js';

describe('the basin is derivable for every basin Duke publishes', () => {
  const roster = fx('duke-get-rivers.2026-09-23.json');

  it('names seven basins, not the four that happen to have releases today', () => {
    expect(roster.length).toBe(7);
    expect(roster.map((r) => r.RiverId).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 6, 10, 11]);
  });

  it('resolves the two basins RIVERS has no id for', () => {
    // "BroadRiver" with no space, and a two-word basin name. Both match.
    expect(dukeBasinFor(roster, 'Broad River', ['Broad River near Carlisle, SC'])).toBe(10);
    expect(dukeBasinFor(roster, 'Lake Keowee', ['Keowee River at Keowee Dam'])).toBe(6);
  });

  it('resolves a lake through its gauge name when its own name carries no river', () => {
    expect(dukeBasinFor(roster, 'Lake Norman', ['Catawba River at Lake Norman'])).toBe(1);
    expect(dukeBasinFor(roster, 'Great Pee Dee River', ['Pee Dee River near Rockingham, NC'])).toBe(3);
  });

  it('refuses water that is not Duke, and never falls into "Others"', () => {
    for (const [nm, g] of [['Saluda River', ['Saluda River below Lake Murray Dam']],
                           ['Congaree River', ['Congaree River at Columbia, SC']],
                           ['Cooper River', ['Cooper River at Mobley Landing']]]) {
      expect(dukeBasinFor(roster, nm, g)).toBe(null);
    }
  });
});

// ---------------------------------------------------------------------------
// /lakes/current-level, pasted live 2026-09-23. This one IS fully consumed --
// the feet-vs-index scale, the newest special message, the full message array --
// and two things in it were still wrong.
// ---------------------------------------------------------------------------
import { normalizeDukeRow } from '../Worker/worker-data.js';

describe('the Duke level feed, against the live rows', () => {
  const rows = fx('duke-current-level.2026-09-23.json').map(normalizeDukeRow);
  const by = (n) => rows.find((r) => r.name === n);

  it('"NA" is a null target, never NaN', () => {
    // parseFloat("NA") is NaN and `NaN != null` is TRUE, so a consumer guarding with `!= null`
    // took NaN as a target. Twelve lakes in the live feed send Target "NA".
    const t = by('Lake Tillery');
    expect(t.target).toBe(null);
    expect(rows.every((r) => r.target === null || Number.isFinite(r.target))).toBe(true);
    expect(by('Lake Wateree').target).toBe(97);
  });

  it('-1 is no drought declared, and is not stage minus one', () => {
    expect(by('Lake Tillery').lowInflowStage).toBe(null);
    expect(by('Lake Tillery').lowInflowStageRaw).toBe(-1);
    // 0 is a real stage and must survive the guard.
    expect(by('Ninety-Nine Islands Reservoir').lowInflowStage).toBe(0);
  });

  it('carries a stage that genuinely differs by basin', () => {
    // Catawba-Wateree is at Stage 2 and the Tuckasegee at Stage 3 on the same day, which is why
    // one basin's recreation releases are SUSPENDED and the other's are REDUCED.
    expect(by('Lake Wateree').lowInflowStage).toBe(2);
    expect(by('Tanasee Creek Lake').lowInflowStage).toBe(3);
  });

  it('takes the NEWEST special message, not the first in the array', () => {
    // Wylie carries the May LIP notice and a September note about floodgate testing at Norman
    // drawing it down. The September one is the reason the lake is low TODAY.
    // pickNewestMessage() returns the TEXT, not the row -- sorted by EventDate, not array order.
    expect(by('Lake Wylie').specialMessage).toMatch(/floodgate testing/);
    expect(by('Lake Wylie').specialMessages.map((x) => x.eventDate))
      .toEqual(['2026-05-01T09:10:00', '2026-09-05T10:31:00']);
    expect(by('Lake Wylie').specialMessages.length).toBe(2);
  });

  it('reads both scales in one feed, including the awkward elevation strings', () => {
    // Index lakes have Max 100; the "Others" basin reports true feet. And the elevation field is
    // inconsistent in the feed itself -- Wateree's parenthesis is unclosed, Ninety-Nine Islands
    // has no "ft" at all -- so the parser takes the leading number and nothing else.
    expect(by('Lake Wateree').ft).toBe(222.2);
    expect(by('Hyco Afterbay Reservoir').ft).toBe(365.04);
    expect(by('Ninety-Nine Islands Reservoir').ft).toBe(510.9);
  });
});
