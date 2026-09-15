import { describe, it, expect } from './expect-shim.mjs';
import { lightAt, lightWindows, lightTimeline, lightSummary, legLightFor, lightLabel,
         lightPhrasesIn, lightKindsIn, lightAgrees, skyDims, skyWord,
         hhmmToHours, hoursToHhmm } from '../js/utils/light-state.js';
import { lightWindowFor } from '../js/data/lure-knowledge.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';
import { assemblePlan } from '../js/modules/plan-assemble.js';
import { planToTimeline } from '../js/modules/plan-to-timeline.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// IT IS LIGHT BLINDNESS, NOT HOUR BLINDNESS
//
// Ryan, 2026-09-14, correcting how I had written the problem up: "we need to be careful with just
// saying hour blindness... it really is light blindness... meaning if it was an overcast day then
// topwater all day might be ok... i still say might because you just never know with fish".
//
// And then, 2026-09-15: "lets go ahead and make sure that the app is light aware through out the
// whole day... so that techniques that work in low light or colors that should be used during low
// light are known".
//
// What this replaced was the purest form of the thing he is warning about, in species-intel.js:
//
//     if (hour < 8) return TOD.DAWN;  if (hour < 17) return TOD.DAY;
//     if (hour < 20) return TOD.DUSK; return TOD.NIGHT;
//
// read off the LAUNCH time, so it answered once for a nine-hour day. Four numbers nobody can cite,
// no almanac, no sky. Nothing imported it, which is the only reason it never did harm.
//
// Everything asserted below comes out of two measured sources: civil twilight and sunrise/sunset
// from USNO through /conditions, and the hourly WMO weather code from Open-Meteo. There is no
// threshold in this file, because there is none in the code: "overcast" is WMO 3 because that is
// what the word means in the code table, not because a percentage was compared to a number.
//
// The almanac is Lake Wateree's for 2026-09-20 in shape: civil dawn 06:32, sunrise 06:58.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ALMANAC = { civilDawn: '06:32', sunrise: '06:58', sunset: '19:41', civilDusk: '20:07' };
const OVERCAST_AM = [{ hour: 6, code: 3, cloudPct: 95 }, { hour: 7, code: 3, cloudPct: 92 },
                     { hour: 8, code: 2, cloudPct: 40 }, { hour: 9, code: 0, cloudPct: 5 }];
const CLEAR = [6, 7, 8, 9, 10, 11, 12, 13, 14].map((h) => ({ hour: h, code: 0, cloudPct: 4 }));
const OVERCAST_ALL = [6, 7, 8, 9, 10, 11, 12, 13, 14].map((h) => ({ hour: h, code: 3, cloudPct: 97 }));

describe('the light comes from the almanac and the sky, never from the clock', () => {
  it('reads the four boundaries off the water state and nothing else', () => {
    const w = lightWindows(ALMANAC);
    expect([w.dawn, w.rise, w.set, w.dusk]).toEqual([6 + 32 / 60, 6 + 58 / 60,
                                                     19 + 41 / 60, 20 + 7 / 60]);
    expect(w.partial).toBe(false);
  });

  it('is silent, not approximate, when there is no almanac', () => {
    expect(lightWindows(null)).toBe(null);
    expect(lightWindows({ featureType: 'lake' })).toBe(null);
    expect(lightWindows({ error: 'timeout', civilDawn: '06:32' })).toBe(null);
    expect(lightAt(null, OVERCAST_AM, '07:00')).toBe(null);
  });

  it('marks an almanac with sunrise but no twilight as partial rather than answering the ends', () => {
    const half = { sunrise: '06:58', sunset: '19:41' };
    expect(lightWindows(half).partial).toBe(true);
    expect(lightAt(half, null, '12:00').state).toBe('daylight');
    // Before sunrise it cannot tell dark from first light, so it says neither.
    expect(lightAt(half, null, '06:40').state).toBe(null);
  });

  it('puts each moment in the state its own boundaries put it in', () => {
    const at = (t) => lightAt(ALMANAC, null, t).state;
    expect(at('06:00')).toBe('dark');
    expect(at('06:32')).toBe('first light');       // inclusive at the boundary it starts
    expect(at('06:57')).toBe('first light');
    expect(at('06:58')).toBe('daylight');          // and exclusive at the one it ends
    expect(at('19:40')).toBe('daylight');
    expect(at('19:41')).toBe('last light');
    expect(at('20:07')).toBe('dark');
  });
});

describe('a sky the light does not get through is low light at any hour', () => {
  it('reads overcast, fog and everything falling out of the sky off the WMO table', () => {
    expect([0, 1, 2].map(skyDims)).toEqual([false, false, false]);
    expect([3, 45, 48, 51, 61, 71, 80, 95, 99].map(skyDims))
      .toEqual([true, true, true, true, true, true, true, true, true]);
    expect(skyDims(undefined)).toBe(null);          // absent is not clear
  });

  it('names the sky in words that match the code, so a sentence can quote it', () => {
    expect([0, 2, 3, 45, 61, 80, 95].map(skyWord))
      .toEqual(['clear', 'partly cloudy', 'overcast', 'fog', 'rain', 'showers', 'thunderstorm']);
  });

  // THE OLD TEST FOR THIS WAS `code === 3` AND CALLED A NOON THUNDERSTORM FULL DAYLIGHT.
  it('calls a thunderstorm at noon low light, because it is', () => {
    const storm = [{ hour: 12, code: 95, cloudPct: 88 }];
    const l = lightAt(ALMANAC, storm, '12:30');
    expect(l.state).toBe('daylight');
    expect(l.low).toBe(true);
    expect(l.lowBySun).toBe(false);
    expect(l.lowBySky).toBe(true);
  });

  it('never reads a missing forecast as a clear sky', () => {
    const l = lightAt(ALMANAC, [], '12:30');
    expect(l.state).toBe('daylight');
    expect(l.skyKnown).toBe(false);
    expect(l.low).toBe(false);                      // the sun alone decides
    expect(l.why).toMatch(/no sky forecast for this hour/);
  });

  it('says which of the two causes made it low, every time', () => {
    expect(lightAt(ALMANAC, CLEAR, '06:40').lowBySun).toBe(true);     // first light, clear
    expect(lightAt(ALMANAC, CLEAR, '06:40').lowBySky).toBe(false);
    expect(lightAt(ALMANAC, OVERCAST_AM, '07:30').lowBySun).toBe(false);  // daylight, overcast
    expect(lightAt(ALMANAC, OVERCAST_AM, '07:30').lowBySky).toBe(true);
  });
});

describe('the day is sampled where the answer can change, not on the hour', () => {
  // THE FIRST DRAFT WALKED WHOLE HOURS AND LOST FIRST LIGHT ON THE CASE IT WAS WRITTEN FOR.
  //
  // A 06:30 launch with civil dawn at 06:32 reported "dark at 06:00, daylight at 07:00": the
  // twenty-six minutes of first light sat inside hour 6, and hour 6 had been sampled at 06:30,
  // two minutes before it started. Every boundary in this system sits inside an hour.
  it('finds a twilight window that falls inside a single hour', () => {
    const rows = lightTimeline(ALMANAC, OVERCAST_AM, '06:30', '15:00');
    const states = rows.map((r) => `${r.at} ${r.state}`);
    expect(states.includes('06:32 first light')).toBe(true);
    expect(states.includes('06:58 daylight')).toBe(true);
    expect(rows[0].at).toBe('06:30');
  });

  it('adds up to the trip, in minutes, and every run has a finish', () => {
    const s = lightSummary(ALMANAC, OVERCAST_AM, '06:30', '15:00');
    expect(s.totalMin).toBe(510);
    expect(s.runs.reduce((a, r) => a + r.minutes, 0)).toBe(510);
    expect(s.runs[s.runs.length - 1].to).toBe('15:00');
    for (let i = 1; i < s.runs.length; i++) expect(s.runs[i].from).toBe(s.runs[i - 1].to);
  });

  it('reports a run\'s cloud as the range it really covered', () => {
    // 08:00 is 40% and 09:00 is 5%, and both are "not low light", so they merge into one run.
    // Reporting the first hour alone would state a constancy nobody measured.
    const s = lightSummary(ALMANAC, OVERCAST_AM, '06:30', '10:00');
    const day = s.runs.find((r) => !r.low);
    expect([day.cloudMax, day.cloudMin]).toEqual([40, 5]);
  });

  it('gives a run the sky of any hour of it that was forecast, not only its first', () => {
    // A 09:00 launch into a forecast starting at 10:00 said "sky not forecast for these hours"
    // across two hours that were.
    const late = [{ hour: 10, code: 0, cloudPct: 3 }, { hour: 11, code: 1, cloudPct: 18 }];
    const s = lightSummary(ALMANAC, late, '09:00', '12:00');
    expect(s.runs[0].skyWord).toBe('clear');
  });

  it('separates a day that is all low light from one that is none of it', () => {
    expect(lightSummary(ALMANAC, OVERCAST_ALL, '09:00', '15:00').allLow).toBe(true);
    expect(lightSummary(ALMANAC, CLEAR, '09:00', '15:00').noneLow).toBe(true);
    // And the mixed day is neither, which is what makes the third sentence in the prompt possible.
    const mixed = lightSummary(ALMANAC, OVERCAST_AM, '06:30', '15:00');
    expect(mixed.allLow).toBe(false);
    expect(mixed.noneLow).toBe(false);
  });

  it('round-trips a clock string through hours without drift', () => {
    for (const t of ['00:00', '06:32', '12:59', '19:41', '23:59']) {
      expect(hoursToHhmm(hhmmToHours(t))).toBe(t);
    }
    expect(hhmmToHours('not a time')).toBe(null);
    expect(hoursToHhmm(NaN)).toBe('');
  });
});

describe('a leg is a stretch of time, so it can start in one light and end in another', () => {
  it('names the light it starts in and the one it turns into', () => {
    const l = legLightFor(ALMANAC, OVERCAST_AM, '06:35', 40);
    expect(l.state).toBe('first light');
    expect(l.changesTo).toBe('daylight');
    expect(l.changesAt).toBe('06:58');
    expect(lightLabel(l)).toBe('first light · overcast 95% → daylight at 06:58');
  });

  it('says nothing about a change on a leg that does not cross one', () => {
    const l = legLightFor(ALMANAC, CLEAR, '10:00', 45);
    expect(l.state).toBe('daylight');
    expect(l.low).toBe(false);
    expect(l.changesTo).toBe(null);
    expect(lightLabel(l)).toBe('daylight · clear 4%');
  });

  it('calls an overcast midday leg low light and labels it as such', () => {
    const l = legLightFor(ALMANAC, OVERCAST_ALL, '12:00', 60);
    expect(l.low).toBe(true);
    expect(l.lowBySky).toBe(true);
    expect(lightLabel(l)).toMatch(/daylight · LOW LIGHT · overcast 97%/);
  });

  it('is absent rather than blank without an almanac, and its label is an empty string', () => {
    expect(legLightFor(null, CLEAR, '10:00', 45)).toBe(null);
    expect(legLightFor(ALMANAC, CLEAR, null, 45)).toBe(null);
    expect(lightLabel(null)).toBe('');
  });
});

describe('the words that mean light are one lexicon, read by two things', () => {
  it('finds the phrases a source actually uses, longest first', () => {
    expect(lightPhrasesIn('Surface troll at dawn — schooling striper')).toEqual(['dawn']);
    expect(lightPhrasesIn('points and creek mouths at dawn')).toEqual(['dawn']);
    // 'first light' before 'light' would be, and 'early morning' before 'morning'.
    expect(lightPhrasesIn('fish the first light window')).toEqual(['first light']);
    expect(lightPhrasesIn('Deep ledge and thermocline zone — summer striper')).toEqual([]);
  });

  it('does not match a light word inside another word', () => {
    expect(lightPhrasesIn('a nightcrawler on a drop-shot')).toEqual([]);
  });

  it('keeps both halves of a source that names two lights', () => {
    // Lake Marion's, verbatim from its profile's _extractedFacts.
    const f = 'fishing shallow flats less than 6 feet deep early and late, and drift-fishing '
            + 'deeper water along channels mid-day';
    expect(lightKindsIn(f)).toEqual(['low', 'bright']);
    // A text that names both is satisfied by any light, because it covers both.
    expect(lightAgrees({ low: true }, ['low', 'bright'])).toBe(true);
    expect(lightAgrees({ low: false }, ['low', 'bright'])).toBe(true);
  });

  it('agrees or disagrees off the leg\'s measured `low`, and says nothing where there is nothing to say', () => {
    expect(lightAgrees({ low: true }, ['low'])).toBe(true);
    expect(lightAgrees({ low: false }, ['low'])).toBe(false);
    expect(lightAgrees({ low: false }, ['bright'])).toBe(true);
    expect(lightAgrees({ low: true }, ['bright'])).toBe(false);
    expect(lightAgrees({ low: true }, [])).toBe(null);          // the text named no light
    expect(lightAgrees(null, ['low'])).toBe(null);              // no almanac
    expect(lightAgrees({ low: true }, ['night'])).toBe(null);   // not a thing he fishes
  });

  it('reads the light out of a bait\'s own recorded technique, and only where one is written', () => {
    const spook = TACKLE_INVENTORY.find((l) => /Spook/.test(l.name));
    expect(lightWindowFor(spook).kinds).toEqual(['low']);
    expect(lightWindowFor(spook).says).toMatch(/Surface troll at dawn/);
    const lipless = TACKLE_INVENTORY.find((l) => l.type === 'lipless');
    expect(lightWindowFor(lipless)).toBe(null);
    expect(lightWindowFor(null)).toBe(null);
  });

  // THE COUNT IS THE POINT, AND IT IS THE ANSWER TO THE COLOUR HALF OF RYAN'S REQUEST.
  //
  // He asked for "techniques that work in low light or colors that should be used during low light"
  // to be known. The technique half has five baits with a light in their own record. The colour
  // half has NONE: LURE_COLORS is 28 types by clear/stained/muddy with no light axis at all, and
  // inventing one would be 28 more strings in a file whose own header says its numbers are
  // "working values, not measurements". This test states the number so that when a source turns up
  // and the number moves, the move is deliberate.
  it('counts how many of his baits name a light at all, because the rest cannot be checked', () => {
    const named = TACKLE_INVENTORY.filter((l) => lightWindowFor(l));
    expect(named.length).toBe(5);
    expect(named.every((l) => lightWindowFor(l).kinds.includes('low'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// AND IT REACHES THE LEG, THE WARNING AND THE CARD — NOT JUST THE PROMPT
//
// The failure this pipeline keeps making is a value computed correctly and addressed to nobody.
// The light is measured in one place and has four readers, so each one is asserted here.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const LIPLESS = TACKLE_INVENTORY.find((l) => l.type === 'lipless' && l.weightOz === 0.5);
const SPOOK = TACKLE_INVENTORY.find((l) => /Spook/.test(l.name));
const lureByName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;
const LEG = {
  runId: 'wateree_lake#216', lengthM: 2400, depthFt: 26, depthMinFt: 24, depthMaxFt: 29,
  maxRunDepthFt: 24, start: [-80.70, 34.35], end: [-80.68, 34.36],
  coordinates: [[-80.70, 34.35], [-80.68, 34.36]], passes: [], speedMph: 2.0,
};
const dayWith = (lure, launchTime, weatherByHour) => assemblePlan({
  candidates: [LEG], launch: [-80.71, 34.348],
  loadout: { rods: [{ id: 'R1', lure: lure.name, rig: 'snap', role: 'troll', leadFt: 60 }] },
  deploy: { [LEG.runId]: { port: 'R1' } },
  stops: [], changes: [], launchTime, returnTime: '15:00', usableAh: 80, lureByName,
  waterState: ALMANAC, weatherByHour,
});
const trollLeg = (p) => p.legs.find((l) => l.type === 'troll');
const said = (p) => (p.warnings || []).filter((w) => /recorded technique/.test(w));

describe('the light reaches the leg, the warning and the card', () => {
  it('stamps every leg with the light it is fished in, transits included', () => {
    const p = dayWith(LIPLESS, '06:30', OVERCAST_AM);
    expect(p.legs.length > 1).toBe(true);
    for (const l of p.legs) expect(!!l.light).toBe(true);
    expect(trollLeg(p).light.state).toBe('first light');
  });

  it('gives a leg fished back its own light, not the first pass\'s', () => {
    // Two passes launched at first light: the way down and the way back are not the same light.
    const p = assemblePlan({
      candidates: [{ ...LEG, passes: [] }], launch: [-80.71, 34.348],
      loadout: { rods: [{ id: 'R1', lure: LIPLESS.name, rig: 'snap', role: 'troll', leadFt: 60 }] },
      deploy: { [LEG.runId]: { port: 'R1' } }, stops: [], changes: [],
      launchTime: '06:30', returnTime: '15:00', usableAh: 80, lureByName,
      waterState: ALMANAC, weatherByHour: CLEAR,
    });
    const trolls = p.legs.filter((l) => l.type === 'troll');
    if (trolls.length > 1) expect(trolls[0].light.from !== trolls[1].light.from).toBe(true);
    expect(trolls[0].light.state).toBe('first light');
  });

  it('carries no light at all rather than a guess when the almanac never arrived', () => {
    const p = assemblePlan({
      candidates: [LEG], launch: [-80.71, 34.348],
      loadout: { rods: [{ id: 'R1', lure: LIPLESS.name, rig: 'snap', role: 'troll', leadFt: 60 }] },
      deploy: { [LEG.runId]: { port: 'R1' } }, stops: [], changes: [],
      launchTime: '06:30', returnTime: '15:00', usableAh: 80, lureByName,
    });
    for (const l of p.legs) expect(l.light).toBe(undefined);
    expect(said(p)).toEqual([]);
  });

  it('flags a dawn bait on a bright midday leg, quoting the record and refusing nothing', () => {
    const w = said(dayWith(SPOOK, '10:00', CLEAR));
    expect(w.length).toBe(1);
    expect(w[0]).toMatch(/Surface troll at dawn/);
    expect(w[0]).toMatch(/in daylight — clear at 4% cloud, so NOT low light/);
    expect(w[0]).toMatch(/That note has no source behind it and this is not a refusal/);
  });

  // RYAN'S OWN CASE, AND THE WHOLE REASON THE LIGHT IS MEASURED RATHER THAN READ OFF A CLOCK.
  //
  // "if it was an overcast day then topwater all day might be ok... i still say might because you
  // just never know with fish". An overcast midday leg IS low light here, by the sky, so the app
  // has nothing to say about a topwater on it — and an hour-based version would have flagged it.
  it('says nothing about the same bait at the same hour on an overcast day', () => {
    expect(said(dayWith(SPOOK, '10:00', OVERCAST_ALL))).toEqual([]);
  });

  it('says nothing about a bait whose record names no light', () => {
    expect(said(dayWith(LIPLESS, '10:00', CLEAR))).toEqual([]);
  });

  it('puts the light on the card, as words and as an object', () => {
    const p = dayWith(LIPLESS, '06:30', OVERCAST_AM);
    const t = planToTimeline(p, { warnings: p.warnings });
    const card = t.timeline.find((c) => c.legType === 'troll');
    expect(card.desc).toMatch(/first light · overcast 95% → daylight at 06:58/);
    expect(card.light.state).toBe('first light');
    // And the run home, where the light is the thing that matters most.
    const home = t.timeline.find((c) => c.legType === 'transit' && /ramp/.test(c.label));
    expect(!!home.light).toBe(true);
  });
});
