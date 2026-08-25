// SANTEE COOPER PUBLISHES MORE THAN DUKE OR DOMINION, AND I TOLD RYAN FIVE TIMES IT PUBLISHED
// NOTHING.
//
// The FAQ page at santeecooper.com/community/lakes/lake-data genuinely does only link out to
// three USGS gauges — all three already bound. What it also carries is an iframe, and the
// iframe's `src` is an ATTRIBUTE, so a tag-stripping text extraction reads the prose around the
// answer and returns a confident "nothing here". That is the most expensive kind of wrong: it
// was believed, and repeated.
//
// FIXTURE IS REAL. Every structure below is transcribed verbatim from santee_lakes.html, saved
// 2026-08-25 from azapp-lakespublic-prd-001.azurewebsites.net — the same page source the three
// parsers beside it were written against.
import { describe, it, expect } from './expect-shim.mjs';
import { parseSanteeCooper, santeeClock, santeeDate } from '../Worker/operators.js';

// The two hidden inputs the page feeds its own charts with, and the three tables. Trimmed to a
// few rows each; the shapes, the escaping and the wording are untouched.
const PAGE = `
<input id="elevationJSON" name="elevationJSON" type="hidden" value="[{&quot;Date&quot;:&quot;2026-08-23T00:00:00&quot;,&quot;Marion&quot;:74.05,&quot;Moultrie&quot;:73.91,&quot;RuleCurve&quot;:75.59},{&quot;Date&quot;:&quot;2026-08-24T00:00:00&quot;,&quot;Marion&quot;:74.05,&quot;Moultrie&quot;:73.9,&quot;RuleCurve&quot;:75.59}]" />
<input id="flowJSON" name="flowJSON" type="hidden" value="[{&quot;Date&quot;:&quot;2026-08-24T00:00:00&quot;,&quot;DateString&quot;:&quot;08/24/2026&quot;,&quot;Spilling&quot;:0.0,&quot;TotalInflow&quot;:5165.0,&quot;TotalDischarge&quot;:5224.0}]" />
<table id="jhTimes" class="table table-bordered table-striped">
<tr><th>Date</th><th>Start Time</th><th>End Time</th></tr>
<tr><td>8/25/2026</td><td>11 AM</td><td>Midnight</td></tr>
<tr><td>8/26/2026</td><td>2 PM</td><td>10 PM</td></tr>
<tr><td>8/27/2026</td><td>12 PM</td><td>8 PM</td></tr>
</table>
<table id="ssTimes" class="table table-bordered table-striped">
<tr><th>Date</th><th>Start Time</th><th>End Time</th></tr>
<tr><td>8/25/2026</td><td>Not scheduled to run</td><td>Not scheduled to run</td></tr>
</table>
<table id="upstreamRivers" class="table table-bordered table-striped">
<tr><th>Date</th><th>Broad River @ Alston</th><th>Saluda River @ River Banks Zoo</th><th>Congaree Inflow @ Columbia</th><th>Wateree Inflow @ Camden</th></tr>
<tr><td>8/24/2026</td><td>2697</td><td>802</td><td>3118</td><td>2047</td></tr>
</table>
<strong>Data last updated 08/25/2026.</strong>
`;

const R = parseSanteeCooper(PAGE);

describe('the rule curve, which is the whole reason this is worth having', () => {
  it('carries Marion, Moultrie and the rule curve together', () => {
    const last = R.elevations.at(-1);
    expect(last.date).toBe('2026-08-24');
    expect(last.marion_ft).toBe(74.05);
    expect(last.moultrie_ft).toBe(73.9);
    expect(last.rule_curve_ft).toBe(75.59);
  });

  it('computes how far off target the lake is', () => {
    // USGS gives the level. Only Santee Cooper says what it is supposed to be.
    expect(R.elevations.at(-1).marion_vs_rule_ft).toBe(-1.54);
  });

  it('does not invent a comparison when either half is missing', () => {
    const p = parseSanteeCooper(
      '<input id="elevationJSON" value="[{&quot;Date&quot;:&quot;2026-08-24T00:00:00&quot;,'
      + '&quot;Marion&quot;:74.05,&quot;Moultrie&quot;:null,&quot;RuleCurve&quot;:null}]" />');
    expect(p.elevations[0].marion_vs_rule_ft).toBe(null);
    expect(p.elevations[0].moultrie_ft).toBe(null);
  });
});

describe('the ten-day forward schedule', () => {
  it('reads Jefferies hours', () => {
    expect(R.schedule.jefferies.length).toBe(3);
    expect(R.schedule.jefferies[0]).toEqual({
      date: '2026-08-25', running: true, start: '11 AM', end: 'Midnight',
      start_min: 660, end_min: 1440,
    });
  });

  it('KEEPS a stated non-run rather than dropping the row', () => {
    // Duke writes "No Flow Release" into a datetime field and this repo already learned that a
    // row saying so must render, or three days of "they are not generating" reads as three days
    // of no information. Santee Cooper writes it into the time columns.
    const ss = R.schedule.st_stephen;
    expect(ss.length).toBe(1);
    expect(ss[0].running).toBe(false);
    expect(ss[0].start).toBe(null);
    expect(ss[0].start_min).toBe(null);
    expect(ss[0].date).toBe('2026-08-25');
  });

  it('drops the header row without dropping data', () => {
    for (const r of R.schedule.jefferies) expect(r.date).not.toBe(null);
  });
});

describe('three traps in a three-word time field', () => {
  it('12 PM is NOON, not midnight', () => {
    // `hour + 12` makes noon into midnight and a generation window starts twelve hours early.
    expect(santeeClock('12 PM')).toBe(720);
  });

  it('12 AM is midnight', () => {
    expect(santeeClock('12 AM')).toBe(0);
  });

  it('the word Midnight is the END of the day, not the start of it', () => {
    // It only ever appears as an end time. Returning 0 would make an overnight run zero-length.
    expect(santeeClock('Midnight')).toBe(1440);
    expect(santeeClock('Midnight')).not.toBe(0);
  });

  it('reads the ordinary cases', () => {
    expect(santeeClock('11 AM')).toBe(660);
    expect(santeeClock('2 PM')).toBe(840);
    expect(santeeClock('10 PM')).toBe(1320);
    expect(santeeClock('1 AM')).toBe(60);
    expect(santeeClock('Noon')).toBe(720);
  });

  it('refuses what it cannot read instead of guessing a number', () => {
    for (const v of ['', null, undefined, 'Not scheduled to run', 'sometime', '25 PM']) {
      const got = santeeClock(v);
      expect(got === null || got <= 1440).toBe(true);
    }
    expect(santeeClock('Not scheduled to run')).toBe(null);
    expect(santeeClock('')).toBe(null);
  });
});

describe('dates', () => {
  it('reads the table form and the JSON form alike', () => {
    expect(santeeDate('8/25/2026')).toBe('2026-08-25');
    expect(santeeDate('2026-08-24T00:00:00')).toBe('2026-08-24');
    expect(santeeDate('12/1/2026')).toBe('2026-12-01');
  });

  it('returns null on anything else, which is how the header row is dropped', () => {
    expect(santeeDate('Date')).toBe(null);
    expect(santeeDate('')).toBe(null);
    expect(santeeDate(null)).toBe(null);
  });
});

describe('flows and spilling', () => {
  it('carries inflow, discharge and whether it is spilling', () => {
    expect(R.flows.at(-1)).toEqual({
      date: '2026-08-24', spilling_cfs: 0, inflow_cfs: 5165, discharge_cfs: 5224,
    });
  });

  it('a zero spill is a reading, not an absence', () => {
    // Number('') is 0 and Number.isFinite(0) is true — the trap this file's `num` was written
    // for. A stated zero and a missing cell must not look the same.
    expect(R.flows.at(-1).spilling_cfs).toBe(0);
    expect(R.flows.at(-1).spilling_cfs).not.toBe(null);
  });
});

describe('upstream inflows', () => {
  it('reads all four rivers', () => {
    expect(R.upstream[0]).toEqual({
      date: '2026-08-24', broad_cfs: 2697, saluda_cfs: 802,
      congaree_inflow_cfs: 3118, wateree_inflow_cfs: 2047,
    });
  });

  it('carries the travel time, which is the fact that links them to Marion', () => {
    expect(R.note).toContain('3-5 days');
  });
});

describe('provenance', () => {
  it('takes the page\'s own updated date rather than the fetch time', () => {
    // A fetch at 3am is not an observation at 3am.
    expect(R.updated).toBe('08/25/2026');
  });

  it('names its source', () => {
    expect(R.source).toContain('azurewebsites.net');
  });
});

describe('the empty cases', () => {
  it('returns null on nothing at all', () => {
    expect(parseSanteeCooper('')).toBe(null);
    expect(parseSanteeCooper(null)).toBe(null);
  });

  it('returns null on a page with none of its tables', () => {
    expect(parseSanteeCooper('<html><body><p>maintenance</p></body></html>')).toBe(null);
  });

  it('survives one section being absent', () => {
    const p = parseSanteeCooper(
      '<table id="jhTimes"><tr><td>8/25/2026</td><td>11 AM</td><td>Midnight</td></tr></table>');
    expect(p.schedule.jefferies.length).toBe(1);
    expect(p.elevations).toEqual([]);
    expect(p.upstream).toEqual([]);
  });

  it('survives malformed JSON in a hidden input rather than throwing', () => {
    const p = parseSanteeCooper(
      '<input id="elevationJSON" value="not json" />'
      + '<table id="jhTimes"><tr><td>8/25/2026</td><td>11 AM</td><td>Midnight</td></tr></table>');
    expect(p.elevations).toEqual([]);
    expect(p.schedule.jefferies.length).toBe(1);
  });
});
