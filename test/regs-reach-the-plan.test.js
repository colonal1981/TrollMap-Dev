// THE BOOK WAS PARSED, SHIPPED, SERVED — AND THE PLANNER NEVER SAW IT.
//
// Ryan, twice on the same lake: "No regulation data for Lake Wateree, SC — verify with the state
// before you keep one." South Carolina's digest carries 88 statewide records in the offline table
// and names the Wateree by name for blue catfish. Two separate faults kept every one of them out
// of the plan, and fixing the first did not fix the symptom, which is why this file exists.
//
// ONE: the state. plan-preflight read `(lakeDbEntryFor(lakeName) || {}).state`, and that
// projection was built field by field without `state`. Null for every inland water. Fixed in
// lake-registry.js; covered by preflight-knows-the-state.test.js.
//
// TWO: the cache. `checkRegulations()` is synchronous by design and answers out of
// regulations-live.js's cache, treating cold as "unknown" — correct, and useless if nobody warms
// it. `primeRegulations()` had exactly one caller in the whole app: a fire-and-forget line in
// conditions-strip.js, on a different trigger. And smart-plan-v2-wiring.js read the law at line
// 117 while its only async water work sat at line 150. The cache was reliably cold at the moment
// it was read.
//
// `regulationsPrimed()` was exported for precisely this check and had NO CALLERS.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from './expect-shim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, 'fixtures/lake_index.sample.json'), 'utf8'));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');

globalThis.window = globalThis;

// The registry answers from the fixture; /regulations answers with a South Carolina digest that
// sets a statewide striped bass limit, which is the shape build_regulations_table.py emits.
const REGS = {
  state: 'SC', parse_failed: false, general: {}, lake_specific: null,
  book_statewide: [{
    species: 'Striped Bass, White Bass and/or Hybrid White-Striped Bass',
    plan_species: ['Striped Bass', 'White Bass', 'Hybrid'],
    size_limit: '26-inch minimum', creel_limit: '5 per person per day',
    source: 'SC Regs2627.pdf', page: 20,
  }],
  book_statewide_source: 'SC Regs2627.pdf',
  closures: [], closures_source: 'SC Regs2627.pdf',
};
let regsCalls = 0;
globalThis.fetch = async (url) => {
  if (String(url).includes('/regulations')) {
    regsCalls += 1;
    return { ok: true, status: 200, json: async () => REGS };
  }
  return { ok: true, status: 200, json: async () => raw };
};

const reg = await import('../js/data/lake-registry.js');
await reg.loadLakeRegistry();
const pre = await import('../js/modules/plan-preflight.js');
const live = await import('../js/data/regulations-live.js');

const LAKE = 'Wateree Lake (Kershaw Co, SC)';

describe('the digest is primed before the law is read', () => {
  it('the state resolves from the registry', () => {
    expect(pre.regulationStateFor(LAKE)).toBe('SC');
  });

  it('nothing is primed until somebody primes it', () => {
    expect(live.regulationsPrimed('SC', LAKE)).toBe(false);
  });

  it('ensureRegulations fetches it and says so', async () => {
    expect(await pre.ensureRegulations(LAKE, { worker: 'https://w' })).toBe(true);
    expect(live.regulationsPrimed('SC', LAKE)).toBe(true);
    expect(regsCalls).toBe(1);
  });

  it('and does not fetch it twice', async () => {
    expect(await pre.ensureRegulations(LAKE, { worker: 'https://w' })).toBe(true);
    expect(regsCalls).toBe(1);
  });

  it('now the plan gets the book instead of a shrug', () => {
    const r = pre.checkPlanLegality(LAKE, 'Striped Bass', new Date('2026-08-30T12:00:00'));
    const all = (r.warnings || []).join(' ');
    expect(/No regulation data/.test(all)).toBe(false);
    expect(all).toMatch(/26-inch minimum/);
    expect(all).toMatch(/5 per person per day/);
  });

  it('an unprimed water still warns rather than granting permission', () => {
    // A cold cache must never read as "you are fine". This is the branch that was firing on
    // every lake, and it is still the right answer when the digest genuinely is not in hand.
    const r = pre.checkPlanLegality('Lake Nowhere', 'Striped Bass', new Date('2026-08-30T12:00:00'));
    expect(r.legal).toBe(true);
    expect((r.warnings || []).join(' ')).toMatch(/verify/i);
  });
});

describe('the plan path awaits it, in that order', () => {
  const wiring = src('js/modules/smart-plan-v2-wiring.js');
  const strip = (js) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('smart-plan awaits ensureRegulations', () => {
    expect(strip(wiring).includes('await ensureRegulations(')).toBe(true);
  });

  it('BEFORE it checks legality, which is the whole bug', () => {
    // Source order is the assertion because the defect was source order: the read ran 33 lines
    // ahead of the only await on the path.
    const js = strip(wiring);
    const primed = js.indexOf('await ensureRegulations(');
    const checked = js.indexOf('checkPlanLegality(');
    expect(primed).toBeGreaterThan(-1);
    expect(checked).toBeGreaterThan(-1);
    expect(primed < checked).toBe(true);
  });
});
