/**
 * test/solunar.test.js — one solunar model, and the two consumers cannot drift apart again.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS FILE EXISTS
 *
 * TrollMap shipped two solunar implementations that disagreed by up to eleven hours for the
 * same lake on the same date. `plan-builder.js` wrote `window._trollmapSolunar`, which
 * `notifications.js` reads to fire bite-window alerts. `smart-plan.js` wrote
 * `window._smartPlanSolunar`, which nothing read. So the timeline on screen and the alert on
 * your phone were computed by different maths, and the Smart Plan number was discarded.
 *
 * `grep -ri solunar test/` returned ZERO hits before this file. Neither module was executed by
 * any test, so nothing could have caught it.
 *
 * The assertions here are structural rather than a table of expected times. Pinning
 * "2026-08-02 major1 is 02:56" would freeze the model and make any future correction —
 * including the DST fix noted in utils/solunar.js — look like a regression. What must never
 * change is that ONE model exists and both callers use it.
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { solunarFor, hourToStr } from '../js/utils/solunar.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(here, '..', p), 'utf8');

const LAT = 34.44, LON = -80.82;                 // Wateree
const DATES = ['2026-08-02', '2026-08-10', '2026-08-17', '2026-01-01', '2026-12-31'];

describe('solunar — there is exactly one implementation', () => {
  it('smart-plan.js no longer defines its own', () => {
    expect(/function\s+computeSolunar\s*\(/.test(src('js/modules/smart-plan.js'))).toBe(false);
  });

  it('plan-builder.js no longer defines its own', () => {
    expect(/function\s+calcSolunar\s*\(/.test(src('js/modules/plan-builder.js'))).toBe(false);
  });

  it('both import the shared model', () => {
    for (const f of ['js/modules/smart-plan.js', 'js/modules/plan-builder.js']) {
      expect(/from ['"]\.\.\/utils\/solunar\.js['"]/.test(src(f))).toBe(true);
    }
  });

  it('nothing writes the global that nothing reads', () => {
    // _smartPlanSolunar was computed, assigned, and never consulted. If it comes back, the
    // second implementation has probably come back with it.
    for (const f of ['js/modules/smart-plan.js', 'js/modules/plan-builder.js',
                     'js/modules/notifications.js']) {
      expect(src(f).includes('window._smartPlanSolunar =')).toBe(false);
    }
  });

  it('the global the alerts DO read is still written', () => {
    expect(src('js/modules/plan-builder.js').includes('window._trollmapSolunar')).toBe(true);
    expect(src('js/modules/notifications.js').includes('_trollmapSolunar')).toBe(true);
  });
});

describe('solunar — the model returns usable windows', () => {
  for (const d of DATES) {
    it(`${d}: four windows, all real hours in order`, () => {
      const s = solunarFor(d, LAT, LON);
      for (const k of ['major1', 'major2', 'minor1', 'minor2']) {
        expect(Number.isFinite(s[k])).toBe(true);
        expect(s[k]).toBeGreaterThanOrEqual(0);
        expect(s[k]).toBeLessThan(24);
      }
      // The two majors are half a day apart, the minors sit a quarter-day off the majors.
      expect(Math.abs(((s.major2 - s.major1) + 24) % 24 - 12)).toBeLessThan(1e-9);
      expect(Math.abs(((s.minor1 - s.major1) + 24) % 24 - 6)).toBeLessThan(1e-9);
      expect(Math.abs(((s.minor2 - s.major1) + 24) % 24 - 18)).toBeLessThan(1e-9);
    });
  }

  it('illumination stays a percentage and the phase name is one of the eight', () => {
    const names = new Set(['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous',
                           'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent']);
    // A full synodic month, so every phase boundary gets crossed.
    for (let i = 0; i < 30; i++) {
      const d = new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10);
      const s = solunarFor(d, LAT, LON);
      expect(s.illum).toBeGreaterThanOrEqual(0);
      expect(s.illum).toBeLessThanOrEqual(100);
      expect(names.has(s.phaseName)).toBe(true);
    }
  });

  it('a bad date degrades to dashes instead of NaN on screen', () => {
    const s = solunarFor('not-a-date', LAT, LON);
    expect(s.major1Str).toBe('—');
    expect(s.phaseName).toBe('');
  });
});

describe('solunar — hourToStr', () => {
  it('formats the ordinary cases', () => {
    expect(hourToStr(0)).toBe('12:00 AM');
    expect(hourToStr(12)).toBe('12:00 PM');
    expect(hourToStr(13.5)).toBe('1:30 PM');
    expect(hourToStr(6.25)).toBe('6:15 AM');
  });

  it('never produces :60 — the bug the old copies had', () => {
    // Both previous formatters rounded minutes independently of the hour, so 13.999 printed
    // as "1:60 PM". Sweep a fine grid and assert no output can end in :60.
    for (let h = 0; h < 24; h += 0.0007) {
      expect(/:60 /.test(hourToStr(h))).toBe(false);
    }
    expect(hourToStr(13.999)).toBe('2:00 PM');
    expect(hourToStr(23.9999)).toBe('12:00 AM');
  });

  it('handles negatives and overflow rather than printing NaN', () => {
    expect(hourToStr(-1)).toBe('11:00 PM');
    expect(hourToStr(25)).toBe('1:00 AM');
    expect(hourToStr(NaN)).toBe('—');
  });
});
