/**
 * r2-gzip.test.js — the Worker must unwrap what the pipeline compresses.
 *
 * On 2026-08-01 gzipped uploads were tried, arrived at the browser double-compressed, and the
 * conclusion recorded in upload_garmin_to_r2.py was "storage is cheap, upload raw". That cost
 * 7.8 GB of a 10 GB free tier and nearly cost Tennessee. What actually broke was PASSTHROUGH:
 * the Worker echoed the stored Content-Encoding and Cloudflare's edge compressed the result
 * again, so one header covered two layers.
 *
 * r2Body()/r2Text() strip the stored layer in the Worker instead. These tests pin the two
 * things that must hold for that to be safe, both of which are silent failures otherwise:
 *
 *   1. a gzipped object comes back as the exact bytes that went in, and
 *   2. Content-Encoding does NOT survive onto the response, because if it does the edge adds
 *      a second layer and we are back where we started -- with a bug that only shows up in a
 *      real browser against a real edge, never in a unit test or a curl without --compressed.
 *
 * The fake R2 object here mirrors the real one closely enough to matter: R2's obj.text() hands
 * back STORED bytes and does not honour httpMetadata.contentEncoding. That is the whole trap.
 */
import { describe, it, expect } from './expect-shim.mjs';
import { gzipSync } from 'node:zlib';
import { r2Body, r2Text } from '../Worker/worker-core.js';

/** A stand-in for an R2ObjectBody. `stored` is what R2 actually holds. */
function fakeR2Object(stored, { contentEncoding = undefined, contentType = 'application/json' } = {}) {
  const bytes = typeof stored === 'string' ? new TextEncoder().encode(stored) : stored;
  return {
    httpMetadata: { contentEncoding, contentType },
    get body() {
      return new ReadableStream({
        start(c) { c.enqueue(bytes); c.close(); },
      });
    },
    // R2 does NOT decompress here. Returning the raw bytes as text is the real behaviour and
    // the reason every read-and-parse in the Worker had to move onto r2Text().
    text() { return Promise.resolve(new TextDecoder().decode(bytes)); },
  };
}

const PACK = JSON.stringify({
  type: 'FeatureCollection',
  features: Array.from({ length: 200 }, (_, i) => ({
    type: 'Feature',
    properties: { depth_ft: i % 70 },
    geometry: { type: 'LineString', coordinates: [[-80.5 + i * 1e-5, 34.3], [-80.5 + i * 1e-5, 34.31]] },
  })),
});

describe('r2Body — serving a stored object', () => {
  it('returns a gzipped object as the exact JSON that was uploaded', async () => {
    const obj = fakeR2Object(gzipSync(Buffer.from(PACK)), { contentEncoding: 'gzip' });
    const headers = new Headers({ 'Content-Encoding': 'gzip', 'Content-Type': 'application/json' });
    const out = await new Response(r2Body(obj, headers)).text();
    expect(out).toBe(PACK);
    expect(JSON.parse(out).features.length).toBe(200);
  });

  it('drops Content-Encoding, so the edge does not add a second layer', async () => {
    // This is the 2026-08-01 bug in one assertion. If the header survives, the response says
    // "gzip" once and carries it twice, and r.json() throws in the browser only.
    const obj = fakeR2Object(gzipSync(Buffer.from(PACK)), { contentEncoding: 'gzip' });
    const headers = new Headers({ 'Content-Encoding': 'gzip' });
    r2Body(obj, headers);
    expect(headers.get('Content-Encoding')).toBe(null);
  });

  it('drops Content-Length too — R2 reports the COMPRESSED size', async () => {
    // Announcing the stored length over a decompressed body truncates the response, which
    // reads as corrupt JSON at the tail rather than as a header bug.
    const gz = gzipSync(Buffer.from(PACK));
    const obj = fakeR2Object(gz, { contentEncoding: 'gzip' });
    const headers = new Headers({ 'Content-Length': String(gz.length) });
    r2Body(obj, headers);
    expect(headers.get('Content-Length')).toBe(null);
    expect(gz.length).toBeLessThan(PACK.length);
  });

  it('leaves a raw object completely alone', async () => {
    const obj = fakeR2Object(PACK);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const out = await new Response(r2Body(obj, headers)).text();
    expect(out).toBe(PACK);
    expect(headers.get('Content-Type')).toBe('application/json');
  });
});

describe('r2Text — reading a stored object inside the Worker', () => {
  it('parses a gzipped object that obj.text() alone would mangle', async () => {
    const obj = fakeR2Object(gzipSync(Buffer.from(PACK)), { contentEncoding: 'gzip' });
    const raw = await obj.text();
    let threw = false;
    try { JSON.parse(raw); } catch { threw = true; }
    expect(threw).toBe(true);              // what every call site did before this change
    expect(JSON.parse(await r2Text(obj)).features.length).toBe(200);
  });

  it('passes a raw object through unchanged', async () => {
    expect(await r2Text(fakeR2Object(PACK))).toBe(PACK);
  });

  it('returns null for a missing object so `if (!obj)` callers keep their shape', async () => {
    expect(await r2Text(null)).toBe(null);
    expect(await r2Text(undefined)).toBe(null);
  });

  it('is not fooled by a case-different or absent encoding', async () => {
    expect(await r2Text(fakeR2Object(gzipSync(Buffer.from(PACK)), { contentEncoding: 'GZIP' })))
      .toBe(PACK);
    expect(await r2Text(fakeR2Object(PACK, { contentEncoding: '' }))).toBe(PACK);
  });
});

describe('no Worker code reads an R2 object without going through the pair', () => {
  it('every R2 read-and-parse uses r2Text', async () => {
    // The failure this guards is a new route added six months from now that calls obj.text()
    // on a gzipped key and gets "Unexpected token" on byte 0x1f -- with nothing pointing at
    // the encoding as the cause.
    const { readFileSync, readdirSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const W = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'Worker');

    const files = [];
    (function walk(dir) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
      }
    })(W);

    const offenders = [];
    for (const f of files) {
      // worker-core.js is where the pair is DEFINED -- r2Text's raw-object branch is the one
      // obj.text() in the Worker that is allowed to exist.
      if (path.basename(f) === 'worker-core.js') continue;
      const src = readFileSync(f, 'utf8');
      src.split('\n').forEach((line, i) => {
        // An R2 get is always assigned to a name ending in Obj / obj / cached / stale here.
        if (/\b(\w*[oO]bj|cached|stale)\.(text|json)\(\)/.test(line) && !/r2Text|\*/.test(line)) {
          offenders.push(`${path.basename(f)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
