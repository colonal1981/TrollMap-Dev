import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { checkPlanLegality, fetchForecast, detectCoastalZone, hourlyWind } from '../js/modules/plan-preflight.js';

// ---------------------------------------------------------------------------
// Ryan, 2026-08-08, after a day where every layer had something wrong under it:
// "you have over 1000k tests but none of them finds the real issues..."
//
// He was right, and the reason is that unit tests check functions while the failures were all
// WIRING: v2 never called the research pipeline, then never called the regulations check, and a
// mask override kept an old signature. So this file tests the function AND the wiring, because a
// preflight nobody calls is worth exactly nothing.
// ---------------------------------------------------------------------------
const SRC = readFileSync(new URL('../js/modules/smart-plan-v2-wiring.js', import.meta.url), 'utf8');
// THE PICK WATER WIRING TOO, since 2026-09-04 -- it fetches the same forecast, from the same
// function, and until that day it kept the answer to itself. Ryan: "both options should have the
// exact same information and work the exact same way with the exception that v2 the model picks
// the routes and pickwater i pick the routes."
const PW = readFileSync(new URL('../js/modules/plan-water-ui.js', import.meta.url), 'utf8');
// AND conditionsFrom() LIVES HERE NOW. It was private to the Smart Plan wiring, which is exactly
// why only that tab sent the model any weather.
const INPUTS = readFileSync(new URL('../js/modules/plan-inputs.js', import.meta.url), 'utf8');

describe('plan-preflight — regulations', () => {
  it('answers with the four fields the caller branches on', () => {
    const r = checkPlanLegality('Lake Wateree', 'Largemouth Bass', new Date('2026-08-08T12:00:00'));
    expect(typeof r.legal).toBe('boolean');
    expect(Array.isArray(r.warnings)).toBe(true);
    expect(typeof r.coastal).toBe('boolean');
    expect(typeof r.reason).toBe('string');
  });

  it('does not block a plan when the lookup knows nothing about the water', () => {
    // Absence of a rule is not a closed season. Blocking here would make every unlisted pond
    // unfishable, which is worse than the thing the check exists to prevent.
    expect(checkPlanLegality('Nowhere Pond', 'Largemouth Bass', new Date()).legal).toBe(true);
  });

  it('does not block when the regulation table itself throws', () => {
    // A bad row in a data file must not cancel a morning. It warns instead, and the warning
    // rides with the plan — see the wiring test below.
    const r = checkPlanLegality(null, undefined, new Date('nonsense'));
    expect(r.legal).toBe(true);
  });

  it('knows a coastal zone from an inland lake', () => {
    expect(detectCoastalZone('Lake Wateree')).toBe(null);
  });
});

describe('plan-preflight — the forecast', () => {
  it('returns nothing rather than throwing when there is no centre to ask about', async () => {
    // null, not a partly-filled object: a caller cannot tell a missing forecast from a calm
    // morning otherwise, and one of those is a reason not to trust the safety call.
    expect(await fetchForecast('Nowhere Pond That Has No Entry', '2026-08-08')).toBe(null);
  });

  it('returns nothing rather than throwing when the network is gone', async () => {
    // No forecast is a worse plan, not a cancelled one.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('offline'); };
    try {
      expect(await fetchForecast('Lake Wateree', '2026-08-08')).toBe(null);
    } finally { globalThis.fetch = realFetch; }
  });

  // -------------------------------------------------------------------------
  // THE HOURS, NOT THE DAILY MAXIMUM
  //
  // The request asked for `daily=windspeed_10m_max,winddirection_10m_dominant` and flattened it
  // to one sentence, and the prompt then asks the model to rule on wind safety for a 12.5 ft
  // kayak against it. A calm 06:00 and a 15 mph noon were the same number. PLAN_SCHEMA_V2 asks
  // for conditions.windByHour and the app was computing something else and calling it
  // conditions.
  // -------------------------------------------------------------------------
  const HOURLY = {
    time: Array.from({ length: 24 }, (_, h) => `2026-08-10T${String(h).padStart(2, '0')}:00`),
    windspeed_10m: Array.from({ length: 24 }, (_, h) => h * 2),          // km/h
    winddirection_10m: Array.from({ length: 24 }, () => 250),
    windgusts_10m: Array.from({ length: 24 }, (_, h) => h * 3),
  };

  it('keeps one entry per hour, converted to mph', () => {
    const w = hourlyWind(HOURLY);
    expect(w.length).toBe(24);
    expect(w[0]).toEqual({ hour: 0, mph: 0, deg: 250, gustMph: 0 });
    expect(w[10].mph).toBe(Math.round(20 * 0.621371));   // km/h in, mph out
    expect(w[10].gustMph).toBe(Math.round(30 * 0.621371));
  });

  it('clips to the trip window — wind at 22:00 is not a fact about a 06:00–15:00 day', () => {
    const w = hourlyWind(HOURLY, '06:00', '15:00');
    expect(w[0].hour).toBe(6);
    expect(w[w.length - 1].hour).toBe(15);
    expect(w.length).toBe(10);
  });

  it('survives an API that answers with no hourly block at all', () => {
    expect(hourlyWind(null)).toEqual([]);
    expect(hourlyWind({ time: ['2026-08-10T06:00'] })).toEqual([]);   // no speeds — nothing to say
  });

  it('reads the whole shape off one Open-Meteo answer', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      expect(String(url)).toContain('hourly=windspeed_10m,winddirection_10m');
      return { ok: true, json: async () => ({
        daily: { windspeed_10m_max: [24], winddirection_10m_dominant: [250],
                 precipitation_sum: [0], temperature_2m_max: [33],
                 sunrise: ['2026-08-10T06:41'], sunset: ['2026-08-10T20:15'] },
        hourly: HOURLY,
      }) };
    };
    try {
      // A coastal zone, because it carries its own centre. The lake registry is a Worker feed
      // and there is no network in here.
      const f = await fetchForecast('Winyah Bay / Georgetown, SC', '2026-08-10',
                                    { launchTime: '06:00', returnTime: '15:00' });
      expect(f.summary).toContain('mph');
      expect(f.windByHour.length).toBe(10);
      expect(f.windByHour[0].hour).toBe(6);
      expect(f.sunrise).toBe('06:41');       // the first leg is a dawn leg
      expect(f.sunset).toBe('20:15');
    } finally { globalThis.fetch = realFetch; }
  });
});

describe('plan-preflight — the hours reach the model', () => {
  it('both wirings pass the trip window in and take windByHour out', () => {
    for (const src of [SRC, PW]) {
      expect(src).toContain('launchTime: inp.launchTime, returnTime: inp.returnTime');
      expect(src).toContain('forecast.summary');
      // The hours only reach the model through this one builder, so calling it is the test.
      expect(/conditionsFrom\(inp, ramp,/.test(src)).toBe(true);
    }
    expect(INPUTS).toContain('c.windByHour = forecast.windByHour');
  });

  it('and both say so when they had to fall back to a daily maximum', () => {
    expect(SRC).toContain('made on a daily maximum');
    expect(PW).toContain('made on a daily maximum');
  });
});

describe('plan-preflight — actually wired into Generate', () => {
  // The check that would have caught the research pipeline sitting unused for a week.
  it('the v2 path imports it', () => {
    expect(SRC.includes("from './plan-preflight.js'")).toBe(true);
    expect((SRC.match(/from '\.\/plan-preflight\.js'/g) || []).length).toBe(1);
  });

  it('checks the law BEFORE spending a model call', () => {
    // Order is the whole point. A regulation block after the Gemini call still costs the call,
    // the pack fetch and the wait.
    const reg = SRC.indexOf('checkPlanLegality(');
    const build = SRC.indexOf('buildSmartPlanV2({');
    expect(reg > 0).toBe(true);
    expect(build > 0).toBe(true);
    expect(reg < build).toBe(true);
  });

  it('fetches the forecast before the plan is built, not after', () => {
    // The prompt judges a 12.5 ft kayak against sustained wind. Fetching after the build would
    // hand the model a blank where the wind should be.
    expect(SRC.indexOf('fetchForecast(') < SRC.indexOf('buildSmartPlanV2({')).toBe(true);
  });

  it('returns on a block instead of carrying on', () => {
    const i = SRC.indexOf('if (!legality.legal)');
    expect(i > 0).toBe(true);
    expect(SRC.slice(i, i + 400).includes('return')).toBe(true);
  });

  it('carries advisories into the plan rather than into the console', () => {
    expect(SRC.includes('legality.warnings')).toBe(true);
  });

  it('puts the forecast on the form as well as into the plan', () => {
    // So what the model saw and what the screen shows cannot disagree.
    expect(SRC.includes("$('planWeather')")).toBe(true);
  });
});
