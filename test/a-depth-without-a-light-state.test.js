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

  it('says which of the trip hours are low light and which are not', () => {
    const b = lightPromptBlock(ALMANAC, null, '06:00', '15:00');
    expect(b).toMatch(/overlaps first light/);
    expect(b).not.toMatch(/and last light/);
    expect(b).toMatch(/every other hour of it is full daylight/);
  });

  it('says so plainly when a trip never reaches twilight at all', () => {
    const b = lightPromptBlock(ALMANAC, null, '09:00', '15:00');
    expect(b).toMatch(/entirely in full daylight/);
    expect(b).toMatch(/does not reach\s+first or last light/);
  });

  it('counts overcast hours by WMO code and carries the measured percentages', () => {
    const b = lightPromptBlock(ALMANAC, OVERCAST_AM, '06:00', '15:00');
    expect(b).toMatch(/06:00 96% · 07:00 91% · 08:00 54% · 09:00 12%/);
    expect(b).toMatch(/2 of those hours are OVERCAST \(WMO code 3\)/);
    expect(b).toMatch(/applies in those hours as well as at first and last light/);
  });

  it('does not invent an overcast hour on a clear day', () => {
    const clear = [{ hour: 10, code: 0, cloudPct: 3 }, { hour: 11, code: 1, cloudPct: 18 }];
    const b = lightPromptBlock(ALMANAC, clear, '06:00', '15:00');
    expect(b).toMatch(/No hour of this trip is overcast/);
    expect(b).toMatch(/only inside the twilight windows/);
  });

  it('always states the rule the whole block exists for', () => {
    const b = lightPromptBlock(ALMANAC, null, '06:00', '15:00');
    expect(b).toMatch(/is an instruction for THOSE HOURS/);
    expect(b).toMatch(/A\s+topwater fish at first light and a trolled bait at ten o'clock are not the same fish/);
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
  });
});
