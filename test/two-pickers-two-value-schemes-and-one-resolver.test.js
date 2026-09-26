// TWO PICKERS, TWO VALUE SCHEMES, AND ONE RESOLVER THAT ONLY KNEW ONE OF THEM.
//
// Ryan, 2026-09-15, running a bench plan on the Congaree: "build and send it returns Nothing came
// back", with `No chartpack for river:congaree` in the status line — while the contours and the
// depth areas for that exact water were drawn on the map beside it.
//
// `#lakeSelect` on the map emits ordinary names. `#planLake` emits `river:<key>` for six hardcoded
// river entries. resolveR2Key() had never seen the second shape, so it returned null, and every
// caller on the plan path read that as "this water has no chartpack". It was not one call site:
// runSmartPlanV2, plan-water-ui, detectCoastalZone and smart-plan-route all resolve whatever the
// plan picker holds, so ALL SIX rivers could draw contours and could not produce a plan.
//
// plan-builder.js had a planWaterKey() that translated the shape, written for exactly this, whose
// own docblock said "resolveR2Key('river:wateree') is null — it has never seen that shape — so
// every river selection resolved to no pack at all." It had four callers and all four were inside
// plan-builder. THE THIRD TIME TONIGHT that the right function existed with one caller that never
// adopted it — typeOf() and isRiverWater() are the other two.
//
// So the translation moved to the resolver, planWaterKey() is gone rather than left beside it, and
// the mapping is pinned against PLAN_RIVERS below so the two places it now lives cannot drift.
//
// THE PICKER WILL STOP EMITTING THIS and the alias table still stays: a saved session and a
// restored plan hold the value that was current when they were written.
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { resolveR2Key } = await import('../js/data/lake-keys.js');

const SRC = (f) => readFileSync(join(here, '..', f), 'utf8');
const strip = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// PLAN_RIVERS read out of the source rather than imported: plan-builder.js touches `document` at
// module scope, and standing up a DOM to read six rows would be a bigger lie than a regex. If the
// table's shape ever changes this stops finding rows and the length assertion below fails loudly,
// which is the behaviour wanted -- a drift check that silently matches nothing is not one.
const PLAN_RIVERS = [...strip(SRC('js/modules/plan-builder.js'))
  .matchAll(/key:\s*'([a-z_]+)'\s*,\s*slug:\s*'([a-z_0-9]+)'/g)]
  .map(([, key, slug]) => ({ key, slug }));

describe('the resolver understands the plan picker, not just the map picker', () => {
  it('resolves every river value the plan picker has ever emitted', () => {
    // This is the whole bug, six times. Before the fix each of these was null.
    expect(resolveR2Key('river:congaree')).toBe('congaree_river');
    expect(resolveR2Key('river:wateree')).toBe('wateree_river');
    expect(resolveR2Key('river:saluda')).toBe('saluda_river_lower_saluda');
    expect(resolveR2Key('river:broad')).toBe('broad_river_2');
    expect(resolveR2Key('river:santee')).toBe('santee_river');
    expect(resolveR2Key('river:cooper')).toBe('tail_race_canal');
  });

  it('agrees with PLAN_RIVERS on every row, which is what stops the two copies drifting', () => {
    // The mapping lives in two files now: the picker's table, and the resolver's alias map. A
    // seventh river added to one and not the other is a silent return to this bug.
    expect(PLAN_RIVERS.length).toBe(6);
    for (const r of PLAN_RIVERS) {
      expect(resolveR2Key(`river:${r.key}`)).toBe(r.slug);
    }
  });

  it('refuses an unknown river key instead of guessing at one', () => {
    // `broad` -> broad_river_2 and `cooper` -> tail_race_canal cannot be derived from the string,
    // so a fuzzy fallback here would be inventing a water. Null is the honest answer.
    expect(resolveR2Key('river:enoree')).toBe(null);
    expect(resolveR2Key('river:')).toBe(null);
    expect(resolveR2Key('river:   ')).toBe(null);
  });

  it('is case-insensitive on the prefix and the key, because stored values are not curated', () => {
    expect(resolveR2Key('River:Congaree')).toBe('congaree_river');
    expect(resolveR2Key('RIVER:WATEREE')).toBe('wateree_river');
  });

  it('does not let the prefix reach the fuzzy passes below it', () => {
    // Pass 4 matches on substring containment and prefers the longest key. "river:broad" reaching
    // it could resolve to anything containing "broad", which is exactly the guessing the registry
    // slug pass exists to prevent.
    // Anchored on CODE, not on the "Pass 1" comment heading -- `strip` removes comments, so the
    // first draft of this compared against -1 and passed for the wrong reason.
    const code = strip(SRC('js/data/lake-keys.js'));
    const idx = code.indexOf("startsWith('river:')");
    const pass1 = code.indexOf('LAKE_NAME_TO_R2_KEY[trimmed]');
    expect(idx > 0).toBe(true);
    expect(pass1 > 0).toBe(true);
    expect(idx).toBeLessThan(pass1);
  });

  it('still resolves an ordinary name exactly as before', () => {
    expect(resolveR2Key('Lake Wateree')).toBe('wateree_lake');
    expect(resolveR2Key('')).toBe(null);
    expect(resolveR2Key(null)).toBe(null);
    expect(resolveR2Key(42)).toBe(null);
  });
});

describe('the second resolver is gone, not left beside the first', () => {
  it('planWaterKey no longer exists', () => {
    const code = strip(SRC('js/modules/plan-builder.js'));
    expect(code.includes('function planWaterKey')).toBe(false);
    expect(code.includes('planWaterKey(')).toBe(false);
  });

  it('nothing in js/ still calls it', () => {
    // smart-plan-route.js was a fifth, until it was deleted on 2026-09-25 with no importer.
    for (const f of ['js/modules/plan-builder.js', 'js/modules/smart-plan-v2-wiring.js',
                     'js/modules/plan-water-ui.js', 'js/modules/plan-preflight.js']) {
      expect(strip(SRC(f)).includes('planWaterKey')).toBe(false);
    }
  });

  it('the plan path resolves through the one resolver', () => {
    // These are three of the four that were reading null for a river and calling it "no
    // chartpack"; the fourth, smart-plan-route.js, was deleted on 2026-09-25 with no importer.
    for (const f of ['js/modules/smart-plan-v2-wiring.js', 'js/modules/plan-water-ui.js',
                     'js/modules/plan-preflight.js']) {
      expect(strip(SRC(f))).toContain('resolveR2Key(');
    }
  });
});
