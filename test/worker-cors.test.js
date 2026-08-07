import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every Worker module that answers the browser must send CORS headers.
 *
 * Worker/cameras.js shipped without them. The route was correct, the S3 URL it derived was
 * correct, and the image behind that URL returned 200 image/jpeg -- and the popup still said
 * "unreachable", because the app is served from trollmap-dev.pages.dev and the Worker is a
 * different origin, so the fetch never reached JS at all.
 *
 * It got through because it was verified with curl. curl sends no Origin and enforces no
 * policy, so it is the one client that CANNOT see a CORS failure. A green curl on a browser
 * route means the route exists, and nothing more than that.
 *
 * This test is the cheap standing version of that lesson: a module that builds a Response has
 * to get its headers from worker-core.js rather than hand-rolling an object.
 */
describe('every browser-facing Worker module sends CORS', () => {
  const files = readdirSync(path.join(ROOT, 'Worker'))
    .filter((f) => f.endsWith('.js'))
    .filter((f) => f !== 'worker-core.js');

  for (const f of files) {
    const src = readFileSync(path.join(ROOT, 'Worker', f), 'utf8');
    if (!/new Response\(/.test(src)) continue;
    it(`${f} imports CORS from worker-core`, () => {
      expect(/import\s*\{[^}]*\bCORS\b[^}]*\}\s*from\s*['"]\.\/worker-core\.js['"]/.test(src)).toBe(true);
    });
    it(`${f} builds no Response header object without spreading CORS`, () => {
      // A hand-rolled `headers = { "content-type": ... }` is the exact shape that shipped
      // broken. Anything setting content-type inline must spread CORS in the same literal.
      const bad = [...src.matchAll(/headers\s*=\s*\{([^}]*)\}/g)]
        .map((m) => m[1])
        .filter((body) => /content-type/i.test(body) && !/\.\.\.CORS/.test(body));
      expect(bad).toEqual([]);
    });
  }
});
