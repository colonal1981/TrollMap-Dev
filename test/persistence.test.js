/**
 * test/persistence.test.js — one persistence path, and a readiness check that can actually fail.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS FILE EXISTS
 *
 * `main.js` used to build `window.DB` and label it a "legacy alias — some older modules
 * reference window.DB instead of importing from utils/db.js". The truth was the reverse:
 * main.js was the ONLY file that imported utils/db.js directly, and all twelve consumers went
 * through the global exclusively, each call paying a dynamic `import(...).then(...)`.
 *
 * The alias also hid a bug. `window.DB.db` was a getter returning `openDB()` — a Promise, and
 * a Promise is always truthy — so the readiness guard `if (!window.DB?.db) return;`, used at
 * 21 call sites across 12 files, could never be true. Twelve modules believed they were
 * checking whether the database was open. None of them were. When it genuinely was not open,
 * put/get silently no-opped, so "the database is not ready" and "the store is empty" were the
 * same observable to every caller in the app.
 */
import { describe, it, expect } from './expect-shim.mjs';
import { installFakeIndexedDB, resetFakeIndexedDB } from './fake-indexeddb.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const JS = join(here, '..', 'js');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.js')) out.push(p);
  }
  return out;
}
const FILES = walk(JS);

/**
 * Source with comments removed. Every check in this file is about what the code DOES, and
 * the first test in it says so outright: "Comments may still explain the history; executable
 * references may not exist." Two of the three tests stripped comments and the third did not,
 * which made db.js itself register as a consumer of db.js the moment its own documentation
 * quoted `dbPut(...)` while explaining the bug that documentation exists to prevent.
 */
function codeOnly(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments, including JSDoc
    .replace(/\/\/.*$/gm, '');          // line comments
}

describe('persistence — the global alias is gone and stays gone', () => {
  it('no module reads or writes window.DB', () => {
    // Comments may still explain the history; executable references may not exist.
    const offenders = [];
    for (const f of FILES) {
      for (const [i, line] of readFileSync(f, 'utf8').split('\n').entries()) {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (/window\.DB\b/.test(code)) offenders.push(`${f.slice(JS.length + 1)}:${i + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('nothing dynamically imports the db module', () => {
    const offenders = FILES.filter((f) => {
      const src = readFileSync(f, 'utf8')
        .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
      return /import\(\s*['"][^'"]*utils\/db\.js['"]\s*\)/.test(src);
    }).map((f) => f.slice(JS.length + 1));
    expect(offenders).toEqual([]);
  });

  it('every consumer imports it statically', () => {
    // If a module persists anything, it must say so at the top of the file.
    const consumers = FILES.filter((f) =>
      /\bdb(Get|Put|GetAll|Del|Clear|IsReady)\s*\(/.test(codeOnly(f)));
    expect(consumers.length).toBeGreaterThan(5);
    const missing = consumers
      .filter((f) => !/from ['"][^'"]*utils\/db\.js['"]/.test(codeOnly(f)))
      .map((f) => f.slice(JS.length + 1));
    expect(missing).toEqual([]);
  });
});

describe('persistence — isReady() reports something real', () => {
  it('is false before the database opens and true after', async () => {
    resetFakeIndexedDB();
    // Fresh module instance: utils/db.js caches its handle, so a plain re-import would
    // report the state left by another test file.
    const db = await import(`../js/utils/db.js?fresh=${'a'.repeat(3)}`);
    expect(db.isReady()).toBe(false);        // ← the assertion the old guard could never make
    installFakeIndexedDB({ reset: true });
    await db.openDB();
    expect(db.isReady()).toBe(true);
  });
});

describe('persistence — the store round-trips', () => {
  it('put / get / getAll / del / clear', async () => {
    installFakeIndexedDB({ reset: true });
    const db = await import('../js/utils/db.js');
    await db.openDB();

    await db.put('settings', { key: 'gear', value: 42 });
    expect((await db.get('settings', 'gear')).value).toBe(42);

    await db.put('settings', { key: 'lake', value: 'Wateree' });
    expect((await db.getAll('settings')).length).toBeGreaterThanOrEqual(2);

    await db.del('settings', 'gear');
    expect(await db.get('settings', 'gear')).toBeNull();

    await db.clear('settings');
    expect(await db.getAll('settings')).toEqual([]);
  });

  it('a missing key reads as null, not undefined', async () => {
    installFakeIndexedDB({ reset: true });
    const db = await import('../js/utils/db.js');
    await db.openDB();
    // Callers branch on this. `undefined` and `null` are both falsy, but `?? []` and
    // `|| []` behave differently on them, so the contract matters.
    expect(await db.get('settings', 'never-written')).toBeNull();
  });
});
