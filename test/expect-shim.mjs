/**
 * test/expect-shim.mjs -- `describe`/`it`/`expect` on top of node:test and node:assert.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 *   -import { describe, it, expect } from 'vitest';
 *   +import { describe, it, expect } from './expect-shim.mjs';
 *
 * WHY THIS EXISTS RATHER THAN `npm i vitest`
 *
 * The suite did not rot because the tests were bad -- seven of them are genuinely good. It
 * rotted because `npm test` fails before a single test runs: vitest is the only devDependency
 * and `node_modules` is not in the checkout. A test suite that needs an install step to prove
 * anything gets run once and then never again, and that is how 72% of the source ended up with
 * no test at all. The three checks that HAVE caught live bugs in this project
 * (registry_smoke, keys_smoke, sync_smoke) are all dependency-free .mjs, and that is not a
 * coincidence.
 *
 * `node --test test/` needs nothing installed. This shim is the whole migration cost: one
 * file, and one import line changed per test.
 *
 * Only the matchers the kept tests actually use are implemented, deliberately -- an unused
 * matcher is a thing that can be subtly wrong without anyone noticing. Anything not listed
 * here throws a clear error naming the matcher, so a future test fails loudly instead of
 * silently passing against `undefined`.
 */
import { test, describe as nodeDescribe, before, after, beforeEach as nodeBeforeEach,
         afterEach as nodeAfterEach } from 'node:test';
import assert from 'node:assert/strict';

export const describe = nodeDescribe;
export const it = test;
export const beforeEach = nodeBeforeEach;
export const afterEach = nodeAfterEach;
export { before, after };

const show = (v) => {
  try { return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v); }
  catch { return String(v); }
};

const ASYMMETRIC = Symbol('asymmetric-matcher');

function core(actual, negated) {
  const ok = (cond, msg) => {
    if (negated ? cond : !cond) {
      assert.fail(`expected ${show(actual)} ${negated ? 'NOT ' : ''}${msg}`);
    }
  };
  return {
    toBe: (e) => ok(Object.is(actual, e), `to be ${show(e)}`),
    toEqual: (e) => {
      // Asymmetric matchers (expect.arrayContaining(...)) are compared by their own predicate
      // rather than by deep equality, which is the whole point of them.
      if (e && e[ASYMMETRIC]) {
        ok(e.test(actual), e.describe());
        return;
      }
      if (negated) {
        assert.notDeepStrictEqual(actual, e);
      } else {
        assert.deepStrictEqual(actual, e);
      }
    },
    toBeNull: () => ok(actual === null, 'to be null'),
    toBeUndefined: () => ok(actual === undefined, 'to be undefined'),
    toBeDefined: () => ok(actual !== undefined, 'to be defined'),
    toBeTruthy: () => ok(!!actual, 'to be truthy'),
    toBeFalsy: () => ok(!actual, 'to be falsy'),
    toBeGreaterThan: (e) => ok(actual > e, `to be > ${show(e)}`),
    toBeGreaterThanOrEqual: (e) => ok(actual >= e, `to be >= ${show(e)}`),
    toBeLessThan: (e) => ok(actual < e, `to be < ${show(e)}`),
    toBeLessThanOrEqual: (e) => ok(actual <= e, `to be <= ${show(e)}`),
    // vitest's default precision is 2 decimal places: |a-b| < 10**-p / 2
    toBeCloseTo: (e, p = 2) =>
      ok(Math.abs(actual - e) < Math.pow(10, -p) / 2, `to be within ${p}dp of ${show(e)}`),
    toMatch: (re) =>
      ok(typeof re === 'string' ? String(actual).includes(re) : re.test(String(actual)),
         `to match ${re}`),
    toContain: (e) =>
      ok(typeof actual === 'string' ? actual.includes(e) : Array.from(actual || []).includes(e),
         `to contain ${show(e)}`),
    toHaveLength: (n) => ok((actual?.length ?? -1) === n,
      `to have length ${n} (got ${actual?.length})`),
    toHaveProperty: (path, val) => {
      const got = String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), actual);
      ok(got !== undefined && (val === undefined || Object.is(got, val)),
         `to have property ${path}${val === undefined ? '' : ' === ' + show(val)}`);
    },
    toHaveBeenCalled: () => ok((actual?.mock?.calls?.length ?? 0) > 0, 'to have been called'),
    toHaveBeenCalledTimes: (n) => ok((actual?.mock?.calls?.length ?? -1) === n,
      `to have been called ${n}x (was ${actual?.mock?.calls?.length})`),
    toHaveBeenCalledWith: (...want) => {
      const calls = actual?.mock?.calls ?? [];
      const match = calls.some((args) => want.every((w, i) => {
        if (w && w[ASYMMETRIC]) return w.test(args[i]);
        try { assert.deepStrictEqual(args[i], w); return true; } catch { return false; }
      }));
      ok(match, `to have been called with ${show(want)} (got ${calls.length} calls)`);
    },
    toThrow: (want) => {
      let threw = null;
      try { actual(); } catch (e) { threw = e; }
      if (negated) {
        if (threw) assert.fail(`expected not to throw, threw ${threw.message}`);
        return;
      }
      if (!threw) assert.fail('expected function to throw, it did not');
      if (want instanceof RegExp && !want.test(threw.message)) {
        assert.fail(`threw ${show(threw.message)}, expected to match ${want}`);
      }
      if (typeof want === 'string' && !threw.message.includes(want)) {
        assert.fail(`threw ${show(threw.message)}, expected to include ${show(want)}`);
      }
    },
  };
}

export function expect(actual) {
  const api = core(actual, false);
  return new Proxy({ ...api, not: core(actual, true) }, {
    get(t, k) {
      if (k in t) return t[k];
      throw new Error(
        `expect(...).${String(k)}() is not implemented in test/expect-shim.mjs. ` +
        `Add it there rather than reaching for vitest -- the point of this file is that ` +
        `\`node --test\` runs with nothing installed.`);
    },
  });
}

/** `expect(list).toEqual(expect.arrayContaining([...]))` -- a subset check, not equality. */
expect.arrayContaining = (want) => ({
  [ASYMMETRIC]: true,
  test: (got) => Array.isArray(got) && want.every((w) =>
    got.some((g) => { try { assert.deepStrictEqual(g, w); return true; } catch { return false; } })),
  describe: () => `to be an array containing ${show(want)}`,
});

/** `expect(fn).toHaveBeenCalledWith(expect.stringContaining('/x'), ...)`. */
expect.stringContaining = (sub) => ({
  [ASYMMETRIC]: true,
  test: (got) => typeof got === 'string' && got.includes(sub),
  describe: () => `to be a string containing ${show(sub)}`,
});

/** `expect(x).toEqual(expect.any(String))`. */
expect.any = (Ctor) => ({
  [ASYMMETRIC]: true,
  test: (got) => got != null && (Object(got) instanceof Ctor
    || (Ctor === String && typeof got === 'string')
    || (Ctor === Number && typeof got === 'number')
    || (Ctor === Boolean && typeof got === 'boolean')),
  describe: () => `to be any ${Ctor?.name}`,
});

/**
 * The sliver of `vi` the kept tests use: fake timers are never used, only spies/stubs on
 * globals. `vi.fn()` returns a recording function; `vi.stubGlobal` / `restoreAllMocks` let a
 * test swap `fetch` and put it back.
 */
const _stubs = [];
const _spies = [];
export const vi = {
  fn(impl = () => {}) {
    const calls = [];
    const f = (...a) => { calls.push(a); return impl(...a); };
    f.mock = { calls };
    f.mockClear = () => { calls.length = 0; };
    f.mockImplementation = (next) => { impl = next; return f; };
    f.mockResolvedValue = (v) => { impl = async () => v; return f; };
    return f;
  },
  stubGlobal(name, value) {
    _stubs.push([name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    globalThis[name] = value;
  },
  restoreAllMocks() {
    while (_spies.length) _spies.pop()();
    while (_stubs.length) {
      const [name, desc] = _stubs.pop();
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete globalThis[name];
    }
  },
  unstubAllGlobals() { vi.restoreAllMocks(); },

  /**
   * Replace a method on an object and remember how to put it back.
   * `.mockImplementation(fn)` is chained onto the result, matching vitest.
   */
  spyOn(obj, key) {
    const original = obj[key];
    const calls = [];
    let impl = original;
    const f = (...a) => { calls.push(a); return impl?.apply(obj, a); };
    f.mock = { calls };
    f.mockImplementation = (next) => { impl = next; return f; };
    f.mockRestore = () => { obj[key] = original; };
    obj[key] = f;
    _spies.push(() => { obj[key] = original; });
    return f;
  },

  /**
   * No-op, deliberately, and it is NOT equivalent to vitest's.
   *
   * vitest clears its module registry so the next dynamic import re-evaluates. Plain ESM has
   * no supported way to evict a module from the loader cache -- there is no `delete
   * require.cache` for `import`. A test that genuinely needs a fresh module instance has to
   * import it with a changing query string (`?t=${n}`) instead.
   *
   * Left as a no-op rather than removed so the one test that calls it keeps running: it uses
   * resetModules for isolation between a single test's setup and its import, and its module
   * has no load-time state that survives, so the reset was not doing anything for it anyway.
   * If a future test depends on real isolation this will look like it worked and quietly
   * won't -- hence this comment rather than a silent stub.
   */
  resetModules() {},
};
