// WHAT FLOODS AT WHAT STAGE, AND WHERE TODAY SITS AGAINST THIS GAUGE'S OWN RECORD.
//
// These fields have been on the wire in the same /gauges/{lid} response the stage comes from
// since before the app read it, and the field audit reported them unread for weeks. They stayed
// unread because the only NWPS gauge in _captures was ERJS1 — a tidal gauge with NO FLOOD STAGE,
// where every one of them is empty. Deciding them off that fixture would have been deciding them
// off a guess.
//
// FIXTURE IS REAL. Everything below is transcribed from nwps_WATS1.json — Lake Wateree at the
// dam, captured 2026-08-25. That gauge answers with all of it: 5 impacts, 34 crests, 2
// hydronotes, a forecast-reliability sentence, and both thresholds set to the 0 that means
// "none".
import { describe, it, expect } from './expect-shim.mjs';
import { nwpsFloodContext } from '../Worker/conditions.js';

const WATS1 = {
  lid: 'WATS1',
  forecastReliability: 'Forecasts are issued as needed during times of high water, '
                     + 'but are not routinely available.',
  upstreamLid: 'CDCS1',
  downstreamLid: 'CMDS1',
  normalThreshold: { value: 0, units: 'ft' },
  lowThreshold: { units: 'ft', value: 0 },
  impactsLowWaters: [],
  hydronotes: [
    { statement: 'Gauge reading affected by reservoir operations.',
      effective: '0101', expiration: '1212' },
  ],
  flood: {
    stageUnits: 'ft',
    categories: { major: { stage: 105, flow: -9999 }, moderate: { stage: 102, flow: -9999 },
                  minor: { stage: 100, flow: -9999 }, action: { stage: 99, flow: -9999 } },
    impacts: [
      { stage: 105, statement: 'Roads and homes nearest the lake shore flood.' },
      { stage: 103, statement: 'Boat launch on U.S. Highway 1 at the lake closed due to flood water.' },
      { stage: 102.5, statement: 'Roadways near Beaver Creek become flooded. ' },
      { stage: 100.5, statement: 'Several yards and docks in low lying areas around Lake Wateree begin to flood.' },
      { stage: 100.4, statement: 'The piers on the Wildlife Road bridge over Singleton Creek become submerged. ' },
    ],
    crests: {
      historic: [
        { occurredTime: '1989-10-03T13:00:00Z', stage: 107, flow: 0, preliminary: 'R', olddatum: false },
        { occurredTime: '2020-02-08T14:00:00Z', stage: 106.04, flow: 0, preliminary: 'O', olddatum: false },
        { occurredTime: '2024-09-30T02:00:00Z', stage: 105.97, flow: 0, preliminary: 'O', olddatum: false },
        { occurredTime: '2025-02-17T15:00:00Z', stage: 99.11, flow: 0, preliminary: 'O', olddatum: false },
      ],
      recent: [
        { occurredTime: '1989-10-03T13:00:00Z', stage: 107, flow: 0, preliminary: 'R', olddatum: false },
        { occurredTime: '2020-02-08T14:00:00Z', stage: 106.04, flow: 0, preliminary: 'O', olddatum: false },
        { occurredTime: '2024-09-30T02:00:00Z', stage: 105.97, flow: 0, preliminary: 'O', olddatum: false },
        { occurredTime: '2025-02-17T15:00:00Z', stage: 99.11, flow: 0, preliminary: 'O', olddatum: false },
      ],
    },
  },
};

// The lake read 97.34 ft when the capture was taken.
const STAGE = 97.34;

describe('impacts — the difference between a notice and a plan', () => {
  const ctx = nwpsFloodContext(WATS1, STAGE, '08/25');

  it('names the next thing that happens if the water comes up', () => {
    // Duke's access alerts say a ramp IS shut. This says at what level it WILL be.
    expect(ctx.impacts.next.stage).toBe(100.4);
    expect(ctx.impacts.next.statement)
      .toBe('The piers on the Wildlife Road bridge over Singleton Creek become submerged.');
  });

  it('says how far the water has to come up to get there', () => {
    // "Three feet of rise from here" is a sentence. A table of five stages is not.
    expect(ctx.impacts.next.ft_to_go).toBe(3.06);
  });

  it('sorts them by stage so the list reads bottom-up', () => {
    expect(ctx.impacts.all.map((i) => i.stage)).toEqual([100.4, 100.5, 102.5, 103, 105]);
  });

  it('nothing is passed on a lake three feet under the first one', () => {
    expect(ctx.impacts.passed).toEqual([]);
  });

  it('and everything below the waterline is passed when it is up', () => {
    const high = nwpsFloodContext(WATS1, 102.6, '08/25');
    expect(high.impacts.passed.map((i) => i.stage)).toEqual([100.4, 100.5, 102.5]);
    expect(high.impacts.next.stage).toBe(103);
  });

  it('past the top one there is no next, and that is not an error', () => {
    expect(nwpsFloodContext(WATS1, 110, '08/25').impacts.next).toBe(null);
  });

  it('trims the trailing space NWS leaves on half of them', () => {
    expect(ctx.impacts.all[0].statement.endsWith('submerged.')).toBe(true);
  });
});

describe('crests — the history an NWPS-only water has nowhere else', () => {
  const ctx = nwpsFloodContext(WATS1, STAGE, '08/25');

  it('the record is the highest, not the newest', () => {
    expect(ctx.crests.record.stage).toBe(107);
    expect(ctx.crests.record.at).toBe('1989-10-03T13:00:00Z');
  });

  it('and the newest is carried separately, because they are different questions', () => {
    expect(ctx.crests.latest.at).toBe('2025-02-17T15:00:00Z');
    expect(ctx.crests.latest.stage).toBe(99.11);
  });

  it('says where today sits against it, signed', () => {
    // Negative is below the record, which is where a lake nearly always is.
    expect(ctx.crests.vs_record_ft).toBe(-9.66);
  });

  it('carries the preliminary flag without interpreting it', () => {
    // This codebase has no reference for NWPS's vocabulary — same call it makes on CWMS quality
    // codes. 'R' travels; nothing pretends to know what it means.
    expect(ctx.crests.record.preliminary).toBe('R');
  });

  it('checks whether recent really is the same set rather than assuming it', () => {
    expect(ctx.crests.recent_differs).toBe(false);
    const diverged = { ...WATS1, flood: { ...WATS1.flood,
      crests: { historic: WATS1.flood.crests.historic, recent: [WATS1.flood.crests.recent[0]] } } };
    expect(nwpsFloodContext(diverged, STAGE, '08/25').crests.recent_differs).toBe(true);
  });
});

describe('the caveats, which are the point of reading this at all', () => {
  it('carries a note about the reading itself', () => {
    // "Gauge reading affected by reservoir operations" is exactly what a person needs told when
    // the level moved and the weather did not.
    expect(nwpsFloodContext(WATS1, STAGE, '08/25').notes)
      .toEqual(['Gauge reading affected by reservoir operations.']);
  });

  it('leaves out a seasonal note that is not in season', () => {
    const winter = { ...WATS1, hydronotes: [
      { statement: 'Ice affects the reading.', effective: '1201', expiration: '0315' },
      { statement: 'Always true.', effective: '0101', expiration: '1231' },
    ] };
    expect(nwpsFloodContext(winter, STAGE, '08/25').notes).toEqual(['Always true.']);
    // And the window that wraps the year end still applies inside it.
    expect(nwpsFloodContext(winter, STAGE, '01/10').notes)
      .toEqual(['Ice affects the reading.', 'Always true.']);
  });

  it('an undated note always applies', () => {
    const undated = { ...WATS1, hydronotes: [{ statement: 'No dates here.' }] };
    expect(nwpsFloodContext(undated, STAGE, '08/25').notes).toEqual(['No dates here.']);
  });

  it('turns a silent null forecast into a stated reason', () => {
    expect(nwpsFloodContext(WATS1, STAGE, '08/25').forecast_reliability)
      .toBe('Forecasts are issued as needed during times of high water, '
          + 'but are not routinely available.');
  });
});

describe('zero is not a threshold', () => {
  it('drops a 0 ft low-water threshold rather than showing a lake permanently in the clear', () => {
    const ctx = nwpsFloodContext(WATS1, STAGE, '08/25');
    expect(ctx.low_threshold_ft).toBe(undefined);
    expect(ctx.normal_threshold_ft).toBe(undefined);
  });

  it('but keeps a real one', () => {
    const set = { ...WATS1, lowThreshold: { value: 94.5, units: 'ft' } };
    expect(nwpsFloodContext(set, STAGE, '08/25').low_threshold_ft).toBe(94.5);
  });
});

describe('the chain, and the empty cases', () => {
  it('carries the gauge above and the gauge below', () => {
    const c = nwpsFloodContext(WATS1, STAGE, '08/25').chain;
    expect(c.upstream_lid).toBe('CDCS1');
    expect(c.downstream_lid).toBe('CMDS1');
  });

  it('an empty string downstream is null, not an empty string', () => {
    const end = { ...WATS1, downstreamLid: '' };
    expect(nwpsFloodContext(end, STAGE, '08/25').chain.downstream_lid).toBe(null);
  });

  it('a tidal gauge with no flood stage returns null, not a hollow object', () => {
    // This is ERJS1, the gauge that kept these fields unread: every one of them empty.
    expect(nwpsFloodContext({
      lid: 'ERJS1', forecastReliability: '', upstreamLid: '', downstreamLid: '',
      normalThreshold: null, lowThreshold: null, hydronotes: [], impactsLowWaters: [],
      flood: { impacts: [], crests: { historic: [], recent: [] }, lowWaters: { historic: [] } },
    }, 11.38, '08/25')).toBe(null);
  });

  it('junk in, null out', () => {
    expect(nwpsFloodContext(null, 1, '08/25')).toBe(null);
    expect(nwpsFloodContext({}, 1, '08/25')).toBe(null);
  });

  it('a gauge with impacts but no reading still lists them', () => {
    // The stage can be the -999 sentinel. The impacts are still facts about the lake.
    const ctx = nwpsFloodContext(WATS1, null, '08/25');
    expect(ctx.impacts.all.length).toBe(5);
    expect(ctx.impacts.next).toBe(null);
    expect(ctx.crests.vs_record_ft).toBe(null);
  });
});
