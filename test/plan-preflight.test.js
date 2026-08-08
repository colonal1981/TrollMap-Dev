import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { checkPlanLegality, fetchForecast, detectCoastalZone } from '../js/modules/plan-preflight.js';

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
  it('returns empty rather than throwing when there is no centre to ask about', async () => {
    expect(await fetchForecast('Nowhere Pond That Has No Entry', '2026-08-08')).toBe('');
  });

  it('returns empty rather than throwing when the network is gone', async () => {
    // No forecast is a worse plan, not a cancelled one.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('offline'); };
    try {
      expect(await fetchForecast('Lake Wateree', '2026-08-08')).toBe('');
    } finally { globalThis.fetch = realFetch; }
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
