// THE TWO PLACES A PAID SERVICE'S BALANCE WAS A NUMBER SOMEBODY TYPED.
//
// Ryan, 2026-08-20: *"jina.ai does not replenish credits monthly... apparently the 10M credits
// were just a 1 time trial... we need to swap it out"*, alongside *"i have 1764 firecrawl, 1000
// tavily, and 1000 scrape.do credits available"*.
//
// Both guards had the same defect in different clothes: a balance restated locally, going stale
// the moment the account changed, and failing in the direction that quietly disables the service.
import { describe, it, expect } from './expect-shim.mjs';
import {
  FIRECRAWL_HARD_STOP, FIRECRAWL_KV_KEY, FIRECRAWL_TTL_MS,
  fetchFirecrawlBalance, checkFirecrawlBudget, recordFirecrawlUsage,
} from '../Worker/research/clients.js';
import { jinaRead } from '../Worker/research/download.js';

/** A KV good enough for the guard: get/put over a Map, plus a peek for assertions. */
function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    _raw: (k) => m.get(k),
  };
}

const cached = (remaining, at) => JSON.stringify({ remaining, at });

/** Swap global fetch for one call, always restoring it. */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

const okBalance = (n) => async () => ({
  ok: true, status: 200, json: async () => ({ success: true, data: { remainingCredits: n } }),
});

describe('the Firecrawl balance comes from Firecrawl', () => {
  it('reads remainingCredits off the account endpoint', async () => {
    let seenUrl = null, seenAuth = null;
    const out = await withFetch(async (url, init) => {
      seenUrl = url; seenAuth = init.headers.Authorization;
      return { ok: true, status: 200, json: async () => ({ data: { remainingCredits: 1764 } }) };
    }, () => fetchFirecrawlBalance({ FIRECRAWL_API_KEY: 'k' }));
    expect(out).toBe(1764);
    expect(seenUrl).toBe('https://api.firecrawl.dev/v2/team/credit-usage');
    expect(seenAuth).toBe('Bearer k');
  });

  it('a top-up is picked up without anyone reseeding anything', async () => {
    // The whole point. The cache says 269 — the number that was pasted in by hand — and the
    // account says 1,764. The account wins on the next refresh.
    const KV = fakeKV({ [FIRECRAWL_KV_KEY]: cached(269, 0) });
    const r = await withFetch(okBalance(1764),
      () => checkFirecrawlBudget({ KV, FIRECRAWL_API_KEY: 'k' }, 1));
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(1764);
    expect(JSON.parse(KV._raw(FIRECRAWL_KV_KEY)).remaining).toBe(1764);
  });

  it('reads the OLD bare-number format rather than throwing the balance away', async () => {
    // KV held `'269'`, not JSON. Losing that on the first deploy would look like a zero balance.
    const KV = fakeKV({ [FIRECRAWL_KV_KEY]: '900' });
    // ...and it is treated as infinitely old, so it refreshes immediately.
    const r = await withFetch(okBalance(1764),
      () => checkFirecrawlBudget({ KV, FIRECRAWL_API_KEY: 'k' }, 1));
    expect(r.remaining).toBe(1764);
  });

  it('a fresh cache is not re-fetched', async () => {
    let calls = 0;
    const KV = fakeKV({ [FIRECRAWL_KV_KEY]: cached(800, Date.now()) });
    const r = await withFetch(async () => { calls++; return okBalance(1)(); },
      () => checkFirecrawlBudget({ KV, FIRECRAWL_API_KEY: 'k' }, 1));
    expect(calls).toBe(0);
    expect(r.remaining).toBe(800);
  });

  it('a stale cache is re-fetched', async () => {
    let calls = 0;
    const KV = fakeKV({ [FIRECRAWL_KV_KEY]: cached(800, Date.now() - FIRECRAWL_TTL_MS - 1) });
    await withFetch(async () => { calls++; return okBalance(1764)(); },
      () => checkFirecrawlBudget({ KV, FIRECRAWL_API_KEY: 'k' }, 1));
    expect(calls).toBe(1);
  });
});

describe('an unknown balance is not a zero balance', () => {
  it('nothing cached and the account unreachable REFUSES, and says why', async () => {
    // The old code read `parseInt(KV.get(key) || '0')`. A missing key became 0, 0 is below the
    // hard stop, and Firecrawl was disabled silently in a way that read as "out of credits".
    const KV = fakeKV();
    const r = await withFetch(async () => { throw new Error('network down'); },
      () => checkFirecrawlBudget({ KV, FIRECRAWL_API_KEY: 'k' }, 1));
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBeNull();
    expect(r.reason).toMatch(/UNKNOWN/);
    expect(r.reason).toMatch(/not the same as being out of credits/);
  });

  it('a 200 with no number in it is a shape change, not a zero', async () => {
    const out = await withFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) }),
      () => fetchFirecrawlBalance({ FIRECRAWL_API_KEY: 'k' }));
    expect(out).toBeNull();
  });

  it('an unreachable account falls back to the cache rather than to zero', async () => {
    const KV = fakeKV({ [FIRECRAWL_KV_KEY]: cached(900, 0) });
    const r = await withFetch(async () => { throw new Error('502'); },
      () => checkFirecrawlBudget({ KV, FIRECRAWL_API_KEY: 'k' }, 1));
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(900);
  });

  it('no API key configured is also unknown, not zero', async () => {
    const KV = fakeKV();
    const r = await checkFirecrawlBudget({ KV }, 1);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBeNull();
  });
});

describe('the hard stop still holds', () => {
  it('refuses at or below the floor', async () => {
    const KV = fakeKV({ [FIRECRAWL_KV_KEY]: cached(FIRECRAWL_HARD_STOP, Date.now()) });
    expect((await checkFirecrawlBudget({ KV }, 1)).allowed).toBe(false);
  });

  it('refuses a spend that would breach the floor', async () => {
    const KV = fakeKV({ [FIRECRAWL_KV_KEY]: cached(FIRECRAWL_HARD_STOP + 1, Date.now()) });
    expect((await checkFirecrawlBudget({ KV }, 1)).allowed).toBe(false);
  });

  it('a burst inside one TTL window cannot spend past the floor', async () => {
    // recordFirecrawlUsage is the guard BETWEEN refreshes. Without it, twenty pages would all
    // test against the balance read at the start of the window.
    const KV = fakeKV({ [FIRECRAWL_KV_KEY]: cached(FIRECRAWL_HARD_STOP + 3, Date.now()) });
    const env = { KV };
    expect((await checkFirecrawlBudget(env, 1)).allowed).toBe(true);
    await recordFirecrawlUsage(env, 1);
    expect((await checkFirecrawlBudget(env, 1)).allowed).toBe(true);
    await recordFirecrawlUsage(env, 1);
    expect((await checkFirecrawlBudget(env, 1)).allowed).toBe(false);
  });

  it('recording a spend never INVENTS a balance', async () => {
    // Writing a number derived from a spend would put a figure in KV that nobody measured —
    // which is the entire thing this rewrite removes.
    const KV = fakeKV();
    await recordFirecrawlUsage({ KV }, 1);
    expect(KV._raw(FIRECRAWL_KV_KEY)).toBeUndefined();
  });
});

describe('Jina reading never spends the token pool', () => {
  const PAGE = 'x'.repeat(400);

  it('reads KEYLESS by default, even when a key exists', async () => {
    // The pool's only real value is s.jina.ai search, which has no keyless tier at all. Tokens
    // spent reading buy nothing but rate, so reading does not spend them.
    let sawAuth = 'unset';
    const r = await withFetch(async (_u, init) => {
      sawAuth = 'Authorization' in init.headers;
      return { ok: true, status: 200, text: async () => PAGE };
    }, () => jinaRead('https://example.com', 'k'));
    expect(sawAuth).toBe(false);
    expect(r.keyed).toBe(false);
    expect(r.markdown.length).toBe(400);
  });

  it('spends a token only on 429 — the one failure a key actually fixes', async () => {
    // Keyless is 20 rpm, keyed is 500. That is the only thing paying changes.
    const seen = [];
    const r = await withFetch(async (_u, init) => {
      seen.push('Authorization' in init.headers);
      return seen.length === 1
        ? { ok: false, status: 429, text: async () => '' }
        : { ok: true, status: 200, text: async () => PAGE };
    }, () => jinaRead('https://example.com', 'k'));
    expect(seen).toEqual([false, true]);
    expect(r.keyed).toBe(true);
  });

  for (const status of [401, 403, 404, 500]) {
    it(`does NOT pay to retry an HTTP ${status}`, async () => {
      // These are about the page or the block. The same answer at a price is still the same
      // answer, and the pool does not refill.
      let calls = 0;
      const r = await withFetch(async () => { calls++; return { ok: false, status, text: async () => '' }; },
        () => jinaRead('https://example.com', 'k'));
      expect(calls).toBe(1);
      expect(r.keyed).toBe(false);
      expect(r.why).toBe(`HTTP ${status} (keyless)`);
    });
  }

  it('does not reach for a key it does not have', async () => {
    let calls = 0;
    await withFetch(async () => { calls++; return { ok: false, status: 429, text: async () => '' }; },
      () => jinaRead('https://example.com', null));
    expect(calls).toBe(1);
  });

  it('a short body is a failure, not a page', async () => {
    // Jina answers 200 with a stub on some blocks; 200 is not the same as content.
    const r = await withFetch(async () => ({ ok: true, status: 200, text: async () => 'nope' }),
      () => jinaRead('https://example.com', null));
    expect(r.markdown.length < 200).toBe(true);
    expect(r.why).toBeTruthy();
  });

  it('the source label distinguishes paid from free', () => {
    // X-Source is how `wrangler tail` shows how often throughput is costing tokens, rather than
    // it being invisible until the pool is gone.
    const src = readSrc();
    expect(src).toContain("jina.keyed ? 'jina-keyed' : 'jina'");
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
function readSrc() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return readFileSync(path.join(repo, 'Worker/research/download.js'), 'utf8');
}
