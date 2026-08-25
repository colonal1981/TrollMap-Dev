// NWS WATCHES AND WARNINGS AS ECHOMAP ALERTS.
//
// Ryan, 2026-08-25: "the weather alerts absolutely need to be included in the notifications.js
// that sends alerts from my phone to the garmin echomap ... but are these current alerts or
// forecasted?"
//
// BOTH, AND `severity` IS WHICH. Measured off the live WWA layer the same day, `sig=A`:
//
//     Flash Flood Watch   issued 12:17   onset 14:00 same day    ends 20:00   1h43m out
//     Flash Flood Watch   issued 12:17   onset 12:00 NEXT DAY    ends 21:00   ~24h out
//     Fire Weather Watch  issued 10:39   onset 12:00 in TWO DAYS ends 20:00   ~2 days out
//
// On two of those three the message `expiration` falls BEFORE the hazard `onset` — the Fire
// Weather Watch expires 05:00 tomorrow for weather starting noon the day after. An app rendering
// issuance/expiration describes a window with no relationship to when the weather happens, which
// is exactly what this app did until `onset`/`ends` were added.
//
// TIMES ARE ASSERTED RELATIONALLY, not against a literal clock. The fixtures carry real UTC
// offsets and `getHours()` is the runner's local hour, so pinning a number would test the test
// machine's timezone. What matters is the arithmetic: the cue sits one run-home before the
// hazard.
import { describe, it, expect } from './expect-shim.mjs';
import { weatherCues } from '../js/modules/plan-assemble.js';

// Five miles out at 3.5 mph — a real run home, so the leave-by offset is a real number.
const FAR_M = 5 * 1609.34;
const MPH = 3.5;
const HOME_H = Math.round((FAR_M / 1609.34) / MPH * 60) / 60;

const NOW = new Date('2026-08-25T13:00:00-04:00').getTime();
const at = (iso) => { const d = new Date(iso); return d.getHours() + d.getMinutes() / 60; };
const cues = (hazards, now = NOW) =>
  weatherCues(null, null, { farthestM: FAR_M, transitMph: MPH, hazards, now });

const H = (o) => ({ type: 'Flash Flood Watch', severity: 'Watch', begins: null, ends: null, ...o });

describe('a Watch is a forecast, and gets the leave-by', () => {
  const future = H({ severity: 'Watch', type: 'Severe Thunderstorm Watch',
                     begins: '2026-08-25T16:00:00-04:00', ends: '2026-08-25T22:00:00-04:00' });

  it('produces one cue', () => {
    expect(cues([future]).length).toBe(1);
  });

  it('fires one run home BEFORE the hazard starts, not at it', () => {
    const c = cues([future])[0];
    expect(Math.round((at(future.begins) - c.atHour) * 60)).toBe(Math.round(HOME_H * 60));
    expect(c.atHour < at(future.begins)).toBe(true);
  });

  it('is a stop, because a thunderstorm watch is not a note', () => {
    expect(cues([future])[0].severity).toBe('stop');
  });

  it('says the distance and the run home in so many words', () => {
    const w = cues([future])[0].what;
    expect(w.includes('5.0 mi')).toBe(true);
    expect(w.includes('leave by')).toBe(true);
    expect(w.includes('Severe Thunderstorm Watch')).toBe(true);
  });
});

describe('a Warning already in effect fires on the next tick', () => {
  const live = H({ severity: 'Warning', type: 'Severe Thunderstorm Warning',
                   begins: '2026-08-25T12:30:00-04:00', ends: '2026-08-25T14:00:00-04:00' });

  it('sits at or before now, so the tick catches it immediately', () => {
    const c = cues([live])[0];
    expect(c.atHour <= at('2026-08-25T13:00:00-04:00')).toBe(true);
  });

  it('says IN EFFECT rather than offering a leave-by', () => {
    const w = cues([live])[0].what;
    expect(w.includes('IN EFFECT')).toBe(true);
    expect(w.includes('leave by')).toBe(false);
  });

  it('is a stop', () => {
    expect(cues([live])[0].severity).toBe('stop');
  });
});

describe('the day guard — a Thursday watch must not fire on Tuesday', () => {
  it('drops a watch whose onset is tomorrow', () => {
    // The real second fixture: issued 12:17, onset noon the NEXT day.
    expect(cues([H({ begins: '2026-08-26T12:00:00-04:00', ends: '2026-08-26T21:00:00-04:00' })]))
      .toEqual([]);
  });

  it('drops a Fire Weather Watch two days out', () => {
    expect(cues([H({ type: 'Fire Weather Watch', begins: '2026-08-27T12:00:00-04:00',
                     ends: '2026-08-27T20:00:00-04:00' })])).toEqual([]);
  });

  it('keeps one that begins later today', () => {
    expect(cues([H({ begins: '2026-08-25T18:00:00-04:00' })]).length).toBe(1);
  });
});

describe('a hazard that is over is not a hazard', () => {
  it('drops one whose ends is behind us', () => {
    expect(cues([H({ severity: 'Warning', begins: '2026-08-25T09:00:00-04:00',
                     ends: '2026-08-25T10:00:00-04:00' })])).toEqual([]);
  });

  it('keeps one still running', () => {
    expect(cues([H({ severity: 'Warning', begins: '2026-08-25T09:00:00-04:00',
                     ends: '2026-08-25T23:00:00-04:00' })]).length).toBe(1);
  });

  it('keeps one with no end at all rather than guessing it is over', () => {
    expect(cues([H({ severity: 'Warning', begins: '2026-08-25T12:00:00-04:00', ends: null })])
      .length).toBe(1);
  });
});

describe('severity maps to what the boat should do', () => {
  const kinds = [
    ['Warning', 'stop'], ['Watch', 'stop'], ['Advisory', 'note'], ['Statement', 'note'],
  ];
  for (const [sev, expected] of kinds) {
    it(`${sev} -> ${expected}`, () => {
      expect(cues([H({ severity: sev, begins: '2026-08-25T18:00:00-04:00' })])[0].severity)
        .toBe(expected);
    });
  }

  it('an unknown severity is a note, not a stop', () => {
    // Inventing an evacuation from a word we do not recognise is the wrong way to be wrong.
    expect(cues([H({ severity: 'Bulletin', begins: '2026-08-25T18:00:00-04:00' })])[0].severity)
      .toBe('note');
  });

  it('a Small Craft Advisory reads as an advisory', () => {
    const c = cues([H({ type: 'Small Craft Advisory', severity: 'Advisory',
                        begins: '2026-08-25T15:00:00-04:00' })])[0];
    expect(c.severity).toBe('note');
    expect(c.what.includes('Small Craft Advisory')).toBe(true);
  });
});

describe('two hazards in the same hour are two hazards', () => {
  it('the rain-block thinning does not collapse them', () => {
    // That filter exists because rain runs in blocks and only the first hour is useful. A
    // Tornado Watch and a Flood Advisory starting together are not a block.
    const c = cues([
      H({ type: 'Tornado Watch', severity: 'Watch', begins: '2026-08-25T17:00:00-04:00' }),
      H({ type: 'Flood Advisory', severity: 'Advisory', begins: '2026-08-25T17:10:00-04:00' }),
    ]);
    expect(c.length).toBe(2);
    expect(c.map((x) => x.kind)).toEqual(['hazard', 'hazard']);
  });
});

describe('the empty and broken cases', () => {
  it('no hazards changes nothing', () => {
    expect(cues([])).toEqual([]);
    expect(cues(null)).toEqual([]);
    expect(cues(undefined)).toEqual([]);
  });

  it('a hazard with no start time is not a cue', () => {
    expect(cues([H({ begins: null })])).toEqual([]);
    expect(cues([H({ begins: '' })])).toEqual([]);
  });

  it('an unparseable time is dropped rather than thrown', () => {
    expect(cues([H({ begins: 'sometime tuesday' })])).toEqual([]);
  });

  it('survives a null in the list', () => {
    expect(cues([null, H({ begins: '2026-08-25T18:00:00-04:00' })]).length).toBe(1);
  });

  it('labels itself as a hazard so the notifier can title it', () => {
    expect(cues([H({ begins: '2026-08-25T18:00:00-04:00' })])[0].kind).toBe('hazard');
  });
});
