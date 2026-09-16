// THE EXTRACTED BUILDER WAS TYPE-CHECKED AND NEVER RUN.
//
// 2026-09-16. Extracting the map's picker builder into js/data/water-picker.js, I cut the block at
// the wrong place and left its entire RENDER loop inside bucketWaters() -- optgroups, options, a
// `lakeSelect` that does not exist there, and a call to lakeBadge() that stayed behind in
// lake-ramp-select.js.
//
// `node --check` passed, because render code is valid JavaScript wherever it sits. The tests I
// wrote read the source for strings and imported typeOf and stateOf. NOTHING CALLED THE FUNCTION I
// HAD JUST WRITTEN. So on the first load after the deploy both pickers threw
//
//     Uncaught ReferenceError: lakeBadge is not defined
//         at bucketWaters (water-picker.js:236:27)
//         at populatePlanLakeDropdown (plan-builder.js:2516:19)
//
// and neither the map nor the plan dropdown populated at all. Ryan: "you broke it."
//
// The lesson is the cheap one and this file is it: a function that has just been extracted gets
// RUN against a stub, not type-checked. Everything below calls bucketWaters for real.
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'js', 'data', 'water-picker.js'), 'utf8');
const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

globalThis.window = globalThis;
const { bucketWaters, STATE_ORDER, TYPE_ORDER } = await import('../js/data/water-picker.js');

// The smallest access index bucketWaters reads: a list of names. It is passed in through
// `opts.index`, the same injection ndbcReadings() takes for its fetcher -- an ES module export
// cannot be monkeypatched, and the first draft of this test tried and got "Cannot redefine
// property", which is the argument for the injection rather than an obstacle to it.
//
// The registry is empty under node, so `rec` is null for every name here and stateOf() falls
// through to the name's own state suffix -- exactly the path a DNR-fed name takes in the browser.
const withIndex = (names, fn) => fn({ lakeNames: names, byLake: new Map(names.map((n) => [n, []])) });

describe('bucketWaters runs, and returns buckets rather than drawing them', () => {
  it('does not throw on a plain call, which is the whole bug', () => {
    // Before the fix this reached `lakeBadge(name)` and died before returning anything.
    let out, err = null;
    try { out = bucketWaters(() => true); } catch (e) { err = e; }
    expect(err).toBe(null);
    expect(out instanceof Map).toBe(true);
  });

  it('survives an access index that has not loaded yet', () => {
    // populateLakeSelect and populatePlanLakeDropdown both run at boot. An empty picker that fills
    // on the next call is recoverable; a thrown ReferenceError is not.
    const out = bucketWaters(() => true);
    expect(out instanceof Map).toBe(true);
  });

  it('buckets by state and type, keyed the way both callers read it', () => {
    // NOT "Buggy Branch" for the lake case: RIVERISH matches \bbranch\b, so it is a river here and
    // lake-picker-groups.test.js has asserted exactly that since it was written. The first draft of
    // this test expected a lake and was wrong about the app, not the other way round.
    const out = withIndex(['Andrew Jackson State Park Lake, SC', 'Enoree River, SC',
                           'Broadway Lake, NC'],
                          (index) => bucketWaters(() => true, { index }));
    expect(out.get('SC|river')).toEqual(['Enoree River, SC']);
    expect(out.get('SC|lake')).toEqual(['Andrew Jackson State Park Lake, SC']);
    expect(out.get('NC|lake')).toEqual(['Broadway Lake, NC']);
  });

  it('honours the caller predicate, which is the only thing a surface varies', () => {
    const names = ['Andrew Jackson State Park Lake, SC', 'Enoree River, SC'];
    const rivers = withIndex(names, (index) => bucketWaters((rec, n) => /river/i.test(n), { index }));
    expect(rivers.get('SC|river')).toEqual(['Enoree River, SC']);
    expect(rivers.has('SC|lake')).toBe(false);
    // A predicate that keeps nothing keeps nothing FROM THE INDEX. The coastal zones below it are
    // gated on the same predicate, so they go too -- which is what `!f && !keep(null, name)` is for.
    const none = withIndex(names, (index) => bucketWaters(() => false, { index }));
    expect(none.size).toBe(0);
  });

  it('passes the record to the predicate, not only the name', () => {
    let sawSecondArg = false;
    withIndex(['Enoree River, SC'], (index) => bucketWaters(
      (rec, n) => { if (n === 'Enoree River, SC') sawSecondArg = true; return true; }, { index }));
    expect(sawSecondArg).toBe(true);
  });

  it('drops a name with no state rather than filing it under undefined', () => {
    // put() returns early on a falsy state, so the name appears in NO bucket. The coastal zones are
    // still added under their own states, which is why this counts occurrences of the name rather
    // than the size of the map -- the first draft asserted size 0 and found 2 coastal groups.
    const out = withIndex(['Some Pond'], (index) => bucketWaters(() => true, { index }));
    const everywhere = [...out.values()].flat();
    expect(everywhere.includes('Some Pond')).toBe(false);
    expect([...out.keys()].some((k) => k.startsWith('undefined') || k.startsWith('null'))).toBe(false);
  });

  it('is stable across calls — no state kept between them', () => {
    const a = withIndex(['Enoree River, SC'], (index) => bucketWaters(() => true, { index }));
    const b = withIndex(['Enoree River, SC'], (index) => bucketWaters(() => true, { index }));
    expect(a.get('SC|river')).toEqual(b.get('SC|river'));
    expect(a.get('SC|river').length).toBe(1);
  });
});

describe('the shared builder answers which waters, and nothing about drawing them', () => {
  it('touches no DOM', () => {
    // The exact mistake, pinned. Every one of these belongs to the caller.
    expect(CODE.includes('document.')).toBe(false);
    expect(CODE.includes('createElement')).toBe(false);
    expect(CODE.includes('appendChild')).toBe(false);
    expect(CODE.includes('lakeSelect')).toBe(false);
  });

  it('calls nothing that lives in the map module', () => {
    // lakeBadge() reads the live access index for a row's "3 ramps, 71% charted" suffix and is the
    // map's own. The planner deliberately does not show it.
    expect(CODE.includes('lakeBadge')).toBe(false);
  });

  it('imports no renderer, which is why it is in js/data and not js/modules', () => {
    // lake-ramp-select.js imports contour-data.js, which touches Leaflet at load. That is what made
    // plan-builder.js untestable when this code lived there.
    expect(CODE.includes('contour-data')).toBe(false);
    expect(CODE.includes('viewport-cull')).toBe(false);
    expect(/^import .*from '\.\.\/modules\//m.test(CODE)).toBe(false);
  });

  it('returns the buckets to its caller', () => {
    expect(CODE).toContain('return buckets;');
  });
});

describe('both callers await the index and hand it over', () => {
  const read = (f) => readFileSync(join(here, '..', f), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('neither picker lets bucketWaters reach for whatever is loaded', () => {
    // `[plan] picker offers 1 water(s)`, printed at boot BEFORE access-index's own
    // "registry contributed 163 lakes" line. The plan picker was bucketing an index that had not
    // arrived, because I replaced an awaited getUniversalLakeNamesAsync() with a synchronous read
    // and asserted in a comment that the caller had already waited. main.js does not wait.
    for (const f of ['js/modules/lake-ramp-select.js', 'js/modules/plan-builder.js']) {
      const src = read(f);
      expect(src, `${f} must await the index`).toContain('await loadAccessIndex()');
      expect(src, `${f} must pass it to bucketWaters`).toMatch(/bucketWaters\([\s\S]{0,200}index/);
    }
  });

  it('the fallback to module state stays, for a caller that has one already', () => {
    // opts.index || getLoadedAccessIndex() -- the fallback is not the bug, calling it too early was.
    expect(CODE).toContain('opts.index || getLoadedAccessIndex()');
  });
});

describe('both callers render the buckets themselves', () => {
  const read = (f) => readFileSync(join(here, '..', f), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('the map renders with its badge, the planner without', () => {
    const map = read('js/modules/lake-ramp-select.js');
    const plan = read('js/modules/plan-builder.js');
    expect(map).toContain('pickerLabel(name) + lakeBadge(name)');
    expect(plan).toContain('bucketWaters(');
    expect(plan.includes('lakeBadge')).toBe(false);
  });

  it('both walk the same two orders, so the groups line up', () => {
    for (const f of ['js/modules/lake-ramp-select.js', 'js/modules/plan-builder.js']) {
      const src = read(f);
      expect(src).toContain('for (const stateCode of STATE_ORDER)');
      expect(src).toContain('for (const [type, typeLabel] of TYPE_ORDER)');
    }
    expect(STATE_ORDER.length).toBe(4);
    expect(TYPE_ORDER.length).toBe(3);
  });
});
