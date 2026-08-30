// THE REGULATIONS REACHED THE BROWSER AND STOPPED ONE FIELD SHORT OF THE PLANNER.
//
// Ryan ran a plan on 2026-08-30 and the preflight said:
//
//     No regulation data for Lake Wateree, SC — verify with the state before you keep one.
//
// South Carolina's book has 88 statewide records in the offline table, and its nongame section
// names the Wateree by name for blue catfish. The data was there. What was missing was one word.
//
// `checkRegulations(lake, species, date, state)` needs the state, because `livePolicyFor` keys
// its cache on it. plan-preflight.js gets it from
//
//     st || (lakeDbEntryFor(lakeName) || {}).state || null
//
// under a comment reading "THE STATE IS WHAT UNLOCKS THE DIGEST. Inland it comes off the registry
// row". The row does carry it -- the registry builder sets `state: rec.state`. But
// lakeDbEntryFor() builds its return object field by field and `state` was not one of the fields,
// so that expression was `null` for EVERY inland water, `livePolicyFor` was never asked, and the
// planner fell to the branch that means "we know nothing about this lake".
//
// A projection that silently lacks a field its callers read is the same shape as
// THE_VIEW_IS_NOT_THE_RECORD and SIX_TEMPTING_COLUMNS_AND_ALL_OF_THEM_EMPTY. This asserts the
// field survives the projection, and that the caller still reads it, because either half alone
// passes while the planner stays blind.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from './expect-shim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, 'fixtures/lake_index.sample.json'), 'utf8'));

globalThis.window = globalThis;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => raw });

const reg = await import('../js/data/lake-registry.js');
await reg.loadLakeRegistry();

const src = (f) => readFileSync(join(here, '..', f), 'utf8');

describe('lakeDbEntryFor carries the state', () => {
  it('by slug', () => {
    expect(reg.lakeDbEntryFor('wateree_lake').state).toBe('SC');
  });

  it('by the display name the picker offers, county parenthetical and all', () => {
    const e = reg.lakeDbEntryFor('Wateree Lake (Kershaw Co, SC)');
    expect(e).toBeTruthy();
    expect(e.state).toBe('SC');
  });

  it('for every shipped water in the fixture, not just this one', () => {
    const missing = reg.filterLakes({}).filter((r) => {
      const e = reg.lakeDbEntryFor(r.slug);
      return !e || !e.state;
    });
    expect(missing.map((r) => r.slug)).toEqual([]);
  });

  it('and it agrees with the record it was projected from', () => {
    for (const slug of ['wateree_lake']) {
      expect(reg.lakeDbEntryFor(slug).state).toBe(reg.lakeRecordFor(slug).state);
    }
  });
});

describe('the preflight still reads it, or the field above is decoration', () => {
  const pre = src('js/modules/plan-preflight.js');

  it('derives an inland state from the registry entry', () => {
    expect(/lakeDbEntryFor\(lakeName\)\s*\|\|\s*\{\}\)\.state/.test(pre)).toBe(true);
  });

  it('and hands it to checkRegulations as the fourth argument', () => {
    // checkRegulations(lakeName, species, date, state) -- drop the fourth and `livePolicyFor`
    // is never consulted, which is the outage this file exists for.
    expect(pre.includes('checkRegulations(lakeName, species, date, inlandState)')).toBe(true);
  });
});
