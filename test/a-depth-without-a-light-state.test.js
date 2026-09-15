import { describe, it, expect } from './expect-shim.mjs';
import { lightPromptBlock } from '../js/modules/plan-prompt.js';

// ---------------------------------------------------------------------------
// Why this test exists
//
// Ryan, 2026-09-05, on the Wateree plan: "what the app needs to be able to
// differentiate is the time of day when a depth is given... early morning
// topwater... that doesn't apply to midday."
//
// And on what a source actually says, when I reached for a clock:
//
//   "its not going to say at 6am... early morning... dawn... first thing...
//    first light... midday... evening... overcast vs daylight"
//
// So the record carries a light STATE and the app resolves it into hours.
// Two axes, because they are not the same thing: civil twilight answers the
// hour, cloud answers the sky, and a guide describing fish that "stayed up all
// day because it was cloudy" is describing a dawn bite at noon.
//
// Nothing here is a threshold I chose. The boundaries are civil twilight from
// USNO; "overcast" is WMO weather code 3, which is what the word means in the
// code table Open-Meteo answers in.
//
// The trip below is the real one: Clearwater Cove, 06:00 to 15:00, Sep 5.
//
// ── REWRITTEN 2026-09-15, AND EVERY CLAIM HERE SURVIVED THE REWRITE ────────
//
// Ryan: "lets go ahead and make sure that the app is light aware through out
// the whole day... so that techniques that work in low light or colors that
// should be used during low light are known".
//
// The block used to hand the model two lists -- the twilight boundaries, and
// the cloud percentage for each hour -- and leave it to work out which hours
// were low light. That is the same shape as the time budget, where the model
// "was handed '06:00' and '15:00' and left to do the arithmetic, and it does
// not do the arithmetic". js/utils/light-state.js does the arithmetic now and
// the block prints the ANSWER: each stretch of the trip, its light state,
// whether that light is low, and which of the two causes made it low.
//
// So the assertions below moved from the old sentences to the new ones. What
// they assert did not move: the almanac is quoted and never guessed at, the
// overcast call is the WMO code and not a percentage anybody chose, the
// measured percentages still travel unlabelled, and the block is silent
// without an almanac.
// ---------------------------------------------------------------------------

const ALMANAC = { civilDawn: '06:34', sunrise: '06:59', sunset: '19:52', civilDusk: '20:17' };
const OVERCAST_AM = [
  { hour: 6, code: 3, cloudPct: 96 }, { hour: 7, code: 3, cloudPct: 91 },
  { hour: 8, code: 2, cloudPct: 54 }, { hour: 9, code: 1, cloudPct: 12 },
];

describe('lightPromptBlock — a depth without a light state is not an instruction', () => {
  it('names the twilight windows from the almanac, not from a guess', () => {
    const b = lightPromptBlock(ALMANAC, null, '06:00', '15:00');
    expect(b).toMatch(/First light runs 06:34 to 06:59 \(civil dawn to sunrise\)/);
    expect(b).toMatch(/Last light runs 19:52 to 20:17 \(sunset to civil dusk\)/);
  });

  it('says which stretches of the trip are low light, in minutes, not which hours it overlaps', () => {
    // WAS `/overlaps first light/` AND `/every other hour of it is full daylight/`, which named
    // the windows and left the model to subtract. The claim is the same claim; it is now answered.
    const b = lightPromptBlock(ALMANAC, null, '06:00', '15:00');
    expect(b).toMatch(/THE LIGHT ON THIS TRIP, 06:00 to 15:00 — 540 minutes, of which 59 are LOW LIGHT/);
    expect(b).toMatch(/- 06:34–06:59 \(25 min\): first light · LOW LIGHT — twilight/);
    expect(b).toMatch(/- 06:59–15:00 \(481 min\): daylight · full daylight/);
    // It reaches first light and not last light, which is what the old assertion was about.
    expect(b).toMatch(/first light/);
    expect(b).not.toMatch(/: last light/);
  });

  it('says so plainly when a trip never reaches twilight at all', () => {
    const b = lightPromptBlock(ALMANAC, null, '09:00', '15:00');
    expect(b).toMatch(/NO PART OF THIS TRIP IS LOW LIGHT/);
    expect(b).toMatch(/never reaches twilight and the sky is not closing the light down/);
    // AND THE OTHER HALF, WHICH THE OLD BLOCK COULD NOT SAY. A trip entirely in daylight is not
    // low light only while the sky stays open, and this sentence is the one that told the model not
    // to carry a dawn pattern into it "because it is the only one written down".
    expect(b).toMatch(/do not carry a dawn pattern into it/);
  });

  it('calls a stretch low light off the WMO code, and still carries the measured percentages', () => {
    const b = lightPromptBlock(ALMANAC, OVERCAST_AM, '06:00', '15:00');
    // The percentages are unchanged and still unlabelled — hourlyWeather() keeps them exactly as
    // Open-Meteo sent them, and this block is not the reader that bands them.
    expect(b).toMatch(/Cloud cover by hour: 06:00 96% · 07:00 91% · 08:00 54% · 09:00 12%/);
    // WAS "2 of those hours are OVERCAST", a count. The code now decides the LIGHT, which is the
    // thing a count of overcast hours was standing in for: 06:59–08:00 is daylight by the sun and
    // low light anyway, because WMO 3 is what "overcast" means.
    expect(b).toMatch(/- 06:59–08:00 \(61 min\): daylight · LOW LIGHT — overcast 96–91% cloud/);
    // And the range, not just the first hour of the run — 54% down to 12% is not one sky.
    expect(b).toMatch(/full daylight — partly cloudy 54–12% cloud/);
    expect(b).toMatch(/low light because of the SKY, not the hour/);
  });

  it('does not invent low light on a clear day', () => {
    const clear = [{ hour: 10, code: 0, cloudPct: 3 }, { hour: 11, code: 1, cloudPct: 18 }];
    const b = lightPromptBlock(ALMANAC, clear, '09:00', '15:00');
    expect(b).toMatch(/NO PART OF THIS TRIP IS LOW LIGHT/);
    // On the RUN lines, which is where a wrong call would show. `not.toMatch(/LOW LIGHT — /)` was
    // my own bad assertion: the no-low-light sentence itself reads "IS LOW LIGHT — it never
    // reaches...", so it matched the thing it was written to forbid.
    expect(b).toMatch(/- 09:00–15:00 \(360 min\): daylight · full daylight/);
    expect(b).not.toMatch(/min\): [a-z ]+ · LOW LIGHT/);
    expect(b).not.toMatch(/because of the SKY/);
    // AND THE SKY IT DOES HAVE IS REPORTED. The forecast here starts at 10:00 against a 09:00
    // launch; the run said "sky not forecast for these hours" across two hours that were.
    expect(b).toMatch(/full daylight — clear 18–3% cloud/);
  });

  it('and a day the sky closes down all the way through is said to be that day', () => {
    // RYAN'S OWN CASE, and the reason the light is measured rather than read off the clock:
    // "if it was an overcast day then topwater all day might be ok... i still say might because
    // you just never know with fish". The "might" is his and the block keeps it as permission.
    const ovc = [9, 10, 11, 12, 13, 14].map((h) => ({ hour: h, code: 3, cloudPct: 97 }));
    const b = lightPromptBlock(ALMANAC, ovc, '09:00', '15:00');
    expect(b).toMatch(/EVERY MINUTE OF THIS TRIP IS LOW LIGHT/);
    expect(b).toMatch(/defensible at noon on a day like this/);
    expect(b).not.toMatch(/NO PART OF THIS TRIP/);
  });

  it('always states the rule the whole block exists for', () => {
    // On every shape of day, not only the mixed one -- the tail is outside every branch.
    for (const [lo, hi, wx] of [['06:00', '15:00', null], ['09:00', '15:00', OVERCAST_AM],
                                ['09:00', '15:00', [{ hour: 9, code: 3, cloudPct: 99 }]]]) {
      const b = lightPromptBlock(ALMANAC, wx, lo, hi);
      expect(b).toMatch(/is an instruction for THOSE STRETCHES/);
      expect(b).toMatch(/A topwater fish at first light and a trolled bait at ten\s+o'clock are not the same fish/);
    }
  });

  it('prints the sourced light facts with their source, and drops the regulations', () => {
    // `_extractedFacts` has carried a fact, its quote and its source since the research agents were
    // written, and nothing outside the research pipeline had ever read one.
    const b = lightPromptBlock(ALMANAC, OVERCAST_AM, '06:00', '15:00', [
      'shallow flats less than 6 feet deep early and late, deeper channels mid-day [Carolina Sportsman]',
    ]);
    expect(b).toMatch(/WHAT THE RESEARCH ON THIS WATER SAYS ABOUT LIGHT/);
    expect(b).toMatch(/early and late, deeper channels mid-day \[Carolina Sportsman\]/);
    // And says nothing at all when the profile had none, rather than an empty heading.
    expect(lightPromptBlock(ALMANAC, OVERCAST_AM, '06:00', '15:00', []))
      .not.toMatch(/WHAT THE RESEARCH ON THIS WATER SAYS/);
  });

  it('is silent rather than guessing when the almanac never arrived', () => {
    expect(lightPromptBlock({ featureType: 'lake' }, OVERCAST_AM, '06:00', '15:00')).toBe('');
    expect(lightPromptBlock(null, null, '06:00', '15:00')).toBe('');
    expect(lightPromptBlock({ error: 'timeout', civilDawn: '06:34' }, null, '06:00', '15:00')).toBe('');
  });

  it('prints the twilight half even when no cloud data came back', () => {
    const b = lightPromptBlock(ALMANAC, null, '06:00', '15:00');
    expect(b).not.toMatch(/Cloud cover by hour/);
    expect(b).toMatch(/First light runs/);
    // AND NEVER READS A MISSING FORECAST AS A CLEAR SKY, which is the one way this could lie.
    expect(b).toMatch(/sky not forecast for these hours/);
  });
});
