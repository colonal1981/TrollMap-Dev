/**
 * test/worker-auth.test.js — writes to the Worker are gated, and the client can get through.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS FILE EXISTS
 *
 * `isAuthorized()` was called at exactly three places in the Worker — /sync/*, the contour
 * upload and the chartpack upload — and nowhere at all in research/*.js. Anyone who knew the
 * URL could POST /research/delete and remove a lake's master research profile, every version
 * of it and all its package files from R2. No token required, sitting next to a /sync surface
 * that was gated.
 *
 * The two halves have to agree or the app breaks: the Worker rejects what the client does not
 * sign. Both halves are asserted here, against the real source, so they cannot drift.
 *
 * These are source-level assertions rather than a live request, because the Worker needs
 * Cloudflare bindings (R2, D1, KV) that do not exist in Node. What they can prove is the thing
 * that actually went wrong: a write route existing with no gate in front of it.
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SYNC_TOKEN, workerHeaders, workerAuthOnly } from '../js/utils/worker-auth.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const worker = readFileSync(join(ROOT, 'Worker/trollmap-worker.js'), 'utf8');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.js')) out.push(p);
  }
  return out;
}

describe('worker auth — the token has one spelling', () => {
  it('is defined once in the front end', () => {
    // A secret written out twice has already gone wrong; it just has not been noticed yet.
    // cloud-sync.js said trollmap2026, plan-builder.js said trollmap-sync-9a8b7c6d5e, and
    // every tombstone 401'd into a .catch(() => {}).
    const offenders = [];
    for (const f of walk(join(ROOT, 'js'))) {
      if (f.endsWith('utils/worker-auth.js')) continue;
      for (const [i, line] of readFileSync(f, 'utf8').split('\n').entries()) {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (/['"]trollmap[-\w]*\d[-\w]*['"]/.test(code) && /token/i.test(code)) {
          offenders.push(`${f.slice(ROOT.length + 1)}:${i + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the phantom literal is gone from executable code', () => {
    for (const f of walk(join(ROOT, 'js'))) {
      const code = readFileSync(f, 'utf8')
        .split('\n').map((l) => l.replace(/\/\/.*$/, '')).filter((l) => !/^\s*\*/.test(l))
        .join('\n');
      expect(code.includes("'trollmap-sync-9a8b7c6d5e'")).toBe(false);
    }
  });

  it('matches what the Worker expects', () => {
    // wrangler.toml carries SYNC_TOKEN as a plaintext [vars] entry; isAuthorized() is a
    // strict `got === want`. If these two ever diverge, every write 401s silently.
    const toml = readFileSync(join(ROOT, 'Worker/wrangler.toml'), 'utf8');
    const m = toml.match(/SYNC_TOKEN\s*=\s*"([^"]+)"/);
    expect(m).not.toBeNull();
    expect(m[1]).toBe(SYNC_TOKEN);
  });
});

describe('worker auth — headers', () => {
  it('workerHeaders carries JSON content type and the token', () => {
    const h = workerHeaders();
    expect(h['Content-Type']).toBe('application/json');
    expect(h['X-Sync-Token']).toBe(SYNC_TOKEN);
  });

  it('extras override without dropping the token', () => {
    const h = workerHeaders({ 'Content-Type': 'text/plain' });
    expect(h['Content-Type']).toBe('text/plain');
    expect(h['X-Sync-Token']).toBe(SYNC_TOKEN);
  });

  it('workerAuthOnly omits Content-Type for bodyless requests', () => {
    const h = workerAuthOnly();
    expect(h['Content-Type']).toBeUndefined();
    expect(h['X-Sync-Token']).toBe(SYNC_TOKEN);
  });
});

describe('worker auth — every mutating route is gated', () => {
  const ROUTES = ['/research/save', '/research/approve', '/research/delete',
                  '/research/delete-normalized-doc', '/research/save-normalized',
                  '/research/shared/store', '/research/shared/publish',
                  '/research/shared/quarantine'];

  it('the gate runs before any route matching', () => {
    const gateAt = worker.indexOf('await allowMutation(');
    const firstRoute = worker.indexOf('if (path === "/identify-catch"');
    expect(gateAt).toBeGreaterThan(0);
    expect(gateAt).toBeLessThan(firstRoute);
  });

  for (const r of ROUTES) {
    it(`${r} is in MUTATING_ROUTES`, () => {
      const list = worker.slice(worker.indexOf('const MUTATING_ROUTES'),
                                worker.indexOf('const MUTATING_ROUTES') + 900);
      expect(list.includes(`"${r}"`)).toBe(true);
    });
  }

  it('a GET that busts the cache counts as a write', () => {
    // /debug/regs-cache?bust=1 deletes three KV entries. The verb says GET; the effect does
    // not care what the verb says.
    expect(/regs-cache[\s\S]{0,120}searchParams\.get\("bust"\)/.test(worker)).toBe(true);
  });

  it('NO route handler writes to R2 or D1 without appearing in the gate list', () => {
    // The real failure mode is not one unguarded route, it is the NEXT one somebody adds.
    // Any research handler that puts or deletes must have a gated path pointing at it.
    const research = walk(join(ROOT, 'Worker/research'));
    const writers = [];
    for (const f of research) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\basync\s+function\s+(handle\w+)/g)) {
        // Bound the body at the NEXT function declaration. A fixed 4000-char window overran
        // into the following function and flagged handleSharedQuery and handleSharedStatus,
        // which write nothing — a false positive is how a test earns being ignored.
        const start = m.index;
        const after = src.slice(start + m[0].length);
        const nxt = after.search(/\n(?:export\s+)?(?:async\s+)?function\s+\w+/);
        const body = src.slice(start, start + m[0].length + (nxt === -1 ? after.length : nxt));
        // env.<BINDING>.put/delete only. `url.searchParams.delete(...)` is not a store write.
        if (/env\.\w+\.(put|delete)\s*\(/.test(body)) writers.push(m[1]);
      }
    }
    expect(writers.length).toBeGreaterThan(0);

    const gateBlock = worker.slice(worker.indexOf('const MUTATING_ROUTES'),
                                   worker.indexOf('async function allowMutation'));
    const ungated = writers.filter((fn) => {
      // Find the route line that dispatches to this handler and check its path is listed.
      const call = new RegExp(`path === "([^"]+)"[^\\n]*\\n?[^\\n]*${fn}\\b`);
      const hit = worker.match(call);
      if (!hit) return false;                       // not reachable from the router at all
      // /debug/regs-cache is gated conditionally in allowMutation() rather than by the list,
      // because only `?bust=1` mutates.
      if (hit[1] === '/debug/regs-cache') return !/regs-cache[\s\S]{0,120}bust/.test(worker);
      return !gateBlock.includes(`"${hit[1]}"`);
    });
    expect(ungated).toEqual([]);
  });
});

describe('worker auth — the client signs what the Worker checks', () => {
  it('every client POST to a gated route sends the token', () => {
    const files = walk(join(ROOT, 'js'));
    const gated = ['/research/save', '/research/approve', '/research/delete',
                   '/research/delete-normalized-doc', '/research/save-normalized',
                   '/research/shared/store', '/research/shared/publish',
                   '/research/shared/quarantine'];
    const bare = [];
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n');
      for (const [i, ln] of lines.entries()) {
        if (!/fetch\(/.test(ln) || !gated.some((g) => ln.includes(g))) continue;
        const win = lines.slice(i, i + 8).join('\n');
        if (!/workerHeaders\(|X-Sync-Token/.test(win)) {
          bare.push(`${f.slice(ROOT.length + 1)}:${i + 1}`);
        }
      }
    }
    expect(bare).toEqual([]);
  });

  it('the token is never attached to a third-party host', () => {
    // lake-research-engine.js also fetches Open-Meteo, USGS and arbitrary source documents.
    const files = walk(join(ROOT, 'js'));
    const leaks = [];
    for (const f of files) {
      if (f.endsWith('utils/worker-auth.js')) continue;   // where they are DEFINED
      const lines = readFileSync(f, 'utf8').split('\n');
      for (const [i, ln] of lines.entries()) {
        if (!/workerHeaders\(|workerAuthOnly\(/.test(ln)) continue;
        const win = lines.slice(Math.max(0, i - 7), i + 1).join('\n');
        if (!/CF_WORKER_URL|workerBase|getWorkerBase|\$\{worker\}/.test(win)) {
          leaks.push(`${f.slice(ROOT.length + 1)}:${i + 1}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });
});
