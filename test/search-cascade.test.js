// FIVE OF SIX SEARCHES HAD NO FALLBACK AT ALL.
//
// Ryan, 2026-08-20: *"these are the tools i have tinyfish, jina.ai, tavily, firecrawl, and
// scrape.do -- wire them in as appropriate for the skills that they all have"*.
//
// The research engine ran a web search in six places. FIVE called tinyfishSearch() bare, so an
// empty TinyFish answer ended the question. The sixth had a full TinyFish -> Tavily -> Firecrawl
// cascade written inline. The capability existed, was paid for, and one caller in six could
// reach it. searchWeb() is that cascade lifted out — not a new one invented.
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  searchWeb, daysFromRecency, tbsForDays, startDateForDays, normaliseHit,
} from '../Worker/research/clients.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(path.join(REPO, f), 'utf8');

const KV = (remaining = 1764) => ({
  get: async () => JSON.stringify({ remaining, at: Date.now() }),
  put: async () => {},
});

const ENV = (over = {}) => ({
  TINYFISH_API_KEY: 'tf', TAVILY_API_KEY: 'tv', FIRECRAWL_API_KEY: 'fc', JINA_API_KEY: 'jn',
  KV: KV(), ...over,
});

/** Route each provider's URL to a canned outcome. `null` means "answer with nothing". */
async function withProviders(routes, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const who = u.includes('tinyfish') ? 'tinyfish'
              : u.includes('tavily') ? 'tavily'
              : u.includes('s.jina.ai') ? 'jina'
              : u.includes('firecrawl') ? 'firecrawl' : 'other';
    calls.push({ who, url: u, body: init && init.body ? JSON.parse(init.body) : null });
    const r = routes[who];
    if (r === 'throw') throw new Error(`${who} down`);
    if (r === 'empty' || r === undefined) {
      return { ok: true, status: 200, json: async () => ({ results: [], data: [] }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => r, text: async () => '' };
  };
  try { return { out: await fn(), calls }; } finally { globalThis.fetch = real; }
}

const hits = (n, key = 'results') => ({
  [key]: Array.from({ length: n }, (_, i) => ({ url: `https://x/${i}`, title: `t${i}`, content: 'c' })),
});

describe('the ladder is walked in cost order', () => {
  it('stops at TinyFish when TinyFish answers — nothing metered is touched', async () => {
    const { out, calls } = await withProviders({ tinyfish: hits(3) },
      () => searchWeb({ query: 'lake murray striper' }, ENV()));
    expect(out.provider).toBe('tinyfish');
    expect(calls.map((c) => c.who)).toEqual(['tinyfish']);
  });

  it('falls to Tavily when TinyFish is empty', async () => {
    const { out, calls } = await withProviders({ tinyfish: 'empty', tavily: hits(2) },
      () => searchWeb({ query: 'q' }, ENV()));
    expect(out.provider).toBe('tavily');
    expect(calls.map((c) => c.who)).toEqual(['tinyfish', 'tavily']);
  });

  it('falls to Firecrawl when Tavily is empty too', async () => {
    const { out, calls } = await withProviders({
      tinyfish: 'empty', tavily: 'empty', firecrawl: { data: { web: [{ url: 'https://x', title: 't' }] } },
    }, () => searchWeb({ query: 'q' }, ENV()));
    expect(out.provider).toBe('firecrawl');
    expect(calls.map((c) => c.who)).toEqual(['tinyfish', 'tavily', 'firecrawl']);
  });

  it('reaches Jina only when everything cheaper failed', async () => {
    // 10,000 tokens flat, off a pool that does not refill. It is last on purpose.
    const { out, calls } = await withProviders({
      tinyfish: 'empty', tavily: 'empty', firecrawl: 'empty', jina: { data: [{ url: 'https://x', title: 't' }] },
    }, () => searchWeb({ query: 'q' }, ENV()));
    expect(out.provider).toBe('jina');
    expect(calls.map((c) => c.who)).toEqual(['tinyfish', 'tavily', 'firecrawl', 'jina']);
  });

  it('a provider that throws does not end the ladder', async () => {
    const { out } = await withProviders({ tinyfish: 'throw', tavily: 'throw', firecrawl: hits(1, 'data') },
      () => searchWeb({ query: 'q' }, ENV()));
    expect(out.provider).toBe('firecrawl');
  });

  it('nobody answering is an answer, and it says who was skipped', async () => {
    const { out } = await withProviders({},
      () => searchWeb({ query: 'q' }, ENV({ TAVILY_API_KEY: null, FIRECRAWL_API_KEY: null, JINA_API_KEY: null })));
    expect(out.results).toEqual([]);
    expect(out.provider).toBeNull();
    expect(out.skipped.join(' ')).toMatch(/no TAVILY_API_KEY/);
    expect(out.skipped.join(' ')).toMatch(/no JINA_API_KEY/);
  });
});

describe('a fallback must not silently answer a different question', () => {
  it('rounds a recency window UP into whole days, so it can only narrow', () => {
    expect(daysFromRecency(1440)).toBe(1);
    expect(daysFromRecency(1441)).toBe(2);      // not 1 — that would widen nothing but lose an hour
    expect(daysFromRecency(64800)).toBe(45);
    expect(daysFromRecency(0)).toBeNull();
    expect(daysFromRecency(undefined)).toBeNull();
  });

  it('never gives Firecrawl a bucket WIDER than the window', () => {
    // The first version of tbsForDays read `days <= 31 ? 'qdr:m' : 'qdr:y'`, which turned a
    // 45-day request into "the past YEAR" — results eight months too old, returned as though
    // they answered the question. It picks the largest bucket at or UNDER the request instead,
    // so it can only ever narrow.
    expect(tbsForDays(1)).toBe('qdr:d');
    expect(tbsForDays(3)).toBe('qdr:d');        // narrows: 1d window for a 3d request
    expect(tbsForDays(7)).toBe('qdr:w');
    expect(tbsForDays(45)).toBe('qdr:m');       // NOT qdr:y
    expect(tbsForDays(400)).toBe('qdr:y');      // narrows
    expect(tbsForDays(0)).toBeNull();
    expect(tbsForDays(null)).toBeNull();
  });

  it('gives Tavily an EXACT start_date rather than a bucket', () => {
    // Tavily takes real dates, so nothing has to be approximated at all.
    const at = Date.parse('2026-08-20T12:00:00Z');
    expect(startDateForDays(1, at)).toBe('2026-08-19');
    expect(startDateForDays(45, at)).toBe('2026-07-06');
    expect(startDateForDays(0, at)).toBeNull();
  });

  it('passes an exact date window to Tavily, which can express it', async () => {
    // This is why Tavily sits directly under TinyFish: start_date/end_date are exact, so
    // falling here loses nothing. fetchLiveRegsAmendments depends on it — an amendment from
    // before the digest took effect is not an amendment.
    const { calls } = await withProviders({ tinyfish: 'empty', tavily: hits(2) },
      () => searchWeb({ query: 'q', after_date: '2026-08-14' }, ENV()));
    const tv = calls.find((c) => c.who === 'tavily');
    expect(tv.body.start_date).toBe('2026-08-14');
  });

  it('translates a recency window into an exact Tavily start_date', async () => {
    const { calls } = await withProviders({ tinyfish: 'empty', tavily: hits(1) },
      () => searchWeb({ query: 'q', recency_minutes: 1440 }, ENV()));
    const body = calls.find((c) => c.who === 'tavily').body;
    expect(/^\d{4}-\d{2}-\d{2}$/.test(body.start_date)).toBe(true);
    expect(body.time_range).toBeUndefined();
  });

  it('SKIPS Jina entirely when a date window was asked for', async () => {
    // s.jina.ai takes no date filter, so it cannot honour the query even approximately.
    // Answering the wrong question is worse than not answering.
    const { out, calls } = await withProviders({ tinyfish: 'empty', tavily: 'empty', firecrawl: 'empty' },
      () => searchWeb({ query: 'q', after_date: '2026-08-14' }, ENV()));
    expect(calls.some((c) => c.who === 'jina')).toBe(false);
    expect(out.skipped.join(' ')).toMatch(/jina: s\.jina\.ai takes no date filter/);
  });

  it('SKIPS Firecrawl for an ABSOLUTE window, which tbs cannot express at all', async () => {
    // `tbs` is a relative bucket. "after 2026-08-14" is not expressible in it, so this rung is
    // skipped outright rather than approximated into something else.
    const { out, calls } = await withProviders({ tinyfish: 'empty', tavily: 'empty' },
      () => searchWeb({ query: 'q', after_date: '2026-08-14' }, ENV()));
    expect(calls.some((c) => c.who === 'firecrawl')).toBe(false);
    expect(out.skipped.join(' ')).toMatch(/cannot express the requested date window/);
  });

  it('respects the Firecrawl budget rather than spending past the floor', async () => {
    const { out, calls } = await withProviders({ tinyfish: 'empty', tavily: 'empty' },
      () => searchWeb({ query: 'q' }, ENV({ KV: KV(10) })));
    expect(calls.some((c) => c.who === 'firecrawl')).toBe(false);
    expect(out.skipped.join(' ')).toMatch(/hard stop/);
  });
});

describe('one result shape, whoever answered', () => {
  it('carries content under every field the existing callers read', () => {
    // Callers variously read .markdown / .content / .snippet / .description. Switching provider
    // must not silently empty the one a given call site happens to use.
    const h = normaliseHit({ url: 'https://x', title: 't', content: 'body' }, 'tavily');
    expect(h.markdown).toBe('body');
    expect(h.snippet).toBe('body');
    expect(h.description).toBe('body');
    expect(h.provider).toBe('tavily');
  });

  it('reads Firecrawl markdown and Tavily raw_content alike', () => {
    expect(normaliseHit({ url: 'u', markdown: 'm' }, 'firecrawl').content).toBe('m');
    expect(normaliseHit({ url: 'u', raw_content: 'r' }, 'tavily').content).toBe('r');
  });
});

describe('every search in the engine goes through it', () => {
  it('no module outside clients.js calls tinyfishSearch directly any more', () => {
    for (const f of ['Worker/research/discover.js', 'Worker/research/storage.js',
                     'Worker/research/extract.js']) {
      const code = src(f).replace(/\/\/.*$/gm, '');   // comments may still name it historically
      expect(code.includes('tinyfishSearch'), `${f} still calls tinyfishSearch`).toBe(false);
    }
  });

  it('the gap-search cascade was moved, not copied', () => {
    // It was the only caller with fallbacks. Leaving a second copy behind is how two ladders
    // drift into disagreeing about which provider is cheapest.
    const code = src('Worker/research/extract.js');
    expect(code).toContain('searchWeb');
    expect(code.includes('api.tavily.com')).toBe(false);
    expect(code.includes('api.firecrawl.dev/v2/search')).toBe(false);
  });

  it('the discovery query log names the provider that answered', () => {
    // A run that fell through to the metered rungs used to look identical in the log to one
    // TinyFish answered for free.
    expect(src('Worker/research/discover.js')).toContain('tfResult.provider');
  });
});

describe('the fetch ladder puts the free rung above the paid ones', () => {
  const dl = src('Worker/research/download.js');

  it('Jina is attempted before scrape.do and Firecrawl', () => {
    // Until 2026-08-20 this ran TinyFish -> scrape.do (1 credit) -> Firecrawl (1 credit) -> Jina,
    // so every fallback spent two credits before reaching the rung that costs nothing.
    //
    // ANCHOR ON THE GENERIC BRANCH'S OWN GUARD, not on the API URL. `api.firecrawl.dev/v2/scrape`
    // appears five times in this file and the FIRST is the NEPIS two-step, hundreds of lines
    // above the ladder — indexOf() on it compared the wrong two positions and failed a correct
    // ordering. Counting the right thing applies to tests as much as to pipelines.
    const jina = dl.indexOf('const jina = await jinaRead(');
    const scrapedo = dl.indexOf('const sdText = await scrapeDoFetch(');
    const firecrawl = dl.indexOf('!tfSucceeded && !jinaSucceeded && !scrapeDoSucceeded && firecrawlKey');
    expect(jina > 0 && scrapedo > 0 && firecrawl > 0).toBe(true);
    expect(jina < scrapedo, 'Jina must come before scrape.do').toBe(true);
    expect(scrapedo < firecrawl, 'scrape.do must come before Firecrawl').toBe(true);
  });

  it('the paid rungs are skipped once the free one succeeded', () => {
    expect(dl).toContain('!tfSucceeded && !jinaSucceeded && isHtml');
    expect(dl).toContain('!tfSucceeded && !jinaSucceeded && !scrapeDoSucceeded && firecrawlKey');
  });
});
