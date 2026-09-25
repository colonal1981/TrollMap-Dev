/**
 * test/a-quiet-lake-is-searched-without-a-date-limit.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * LAKE JORDAN, NC, 2026-09-25. The fisheries report search is limited to the last 45 days, and on
 * Jordan it returned ten results -- an Apex pond, TikToks, a bald-eagle thread, a Maine listing -- of
 * which no title named the lake. The existing fallback asks only how MANY came back (fewer than
 * three), so it never ran. The same query with no date limit returned nine pages about Jordan Lake.
 * Now, when no dated result's title names the water by any name its registry row carries, the same
 * search is sent once more with no date limit. A lake whose dated search names it is unchanged.
 *
 *   node --test test/a-quiet-lake-is-searched-without-a-date-limit.test.js
 */
import { afterEach, describe, it, expect, vi } from './expect-shim.mjs';

const { handleResearchDiscover, waterNamesOf, titleNamesWater } = await import('../Worker/research/discover.js');
const { _resetIndexCache } = await import('../Worker/registry.js');

// The registry row as it is, 2026-09-25.
const JORDAN = { slug: 'b_everett_jordan_lake', display_name: 'B. Everett Jordan Lake (Chatham Co, NC)',
  name: 'B. Everett Jordan Lake', state: 'NC', county: 'Chatham', feature_type: 'lake',
  legacy_display_names: ['B. Everett Jordan Lake, NC', 'JORDAN RESERVOIR', 'JORDAN RESERVOIR, NC', 'Jordan Lake',
    'Jordan Lake, NC', 'LAKE JORDAN', 'LAKE JORDAN, NC'] };
const MURRAY = { slug: 'lake_murray', display_name: 'Lake Murray (Lexington Co, SC)', name: 'Lake Murray',
  state: 'SC', county: 'Lexington', feature_type: 'lake' };
const INDEX = { b_everett_jordan_lake: JORDAN, lake_murray: MURRAY };

// The titles the 45-day search returned on 2026-09-25, and three the undated one did.
const DATED_JORDAN = ['ᐅ Apex Lake fishing reports🎣• Cary, NC (United States) ...',
  'What Is The Best Fishing Spot in Fish in 2026 September', 'Tirando la línea en Jordan Dam Lake North Carolina',
  'Potential bald eagle? : r/whatsthisbird', '12 Bayview Drive Raymond, ME 04071 | 1661652'];
const UNDATED_JORDAN = ['Lake of the Month: Jordan Lake -- Bass fishing in North ...', 'Jordan Lake crappie fishing report',
  'B. Everett Jordan Lake NC Fishing Reports, Maps & Hot ...'];

describe('the names a result title is judged by', () => {
  it('are every name the row carries, without brackets or state', () => {
    const n = waterNamesOf('LAKE JORDAN, NC', JORDAN);
    for (const x of ['lake jordan', 'jordan lake', 'jordan reservoir', 'b everett jordan lake']) expect(n).toContain(x);
  });
  it('none of the dated titles names Jordan; the undated ones do', () => {
    const n = waterNamesOf('LAKE JORDAN, NC', JORDAN);
    expect(DATED_JORDAN.some((t) => titleNamesWater(t, n))).toBe(false);
    expect(UNDATED_JORDAN.every((t) => titleNamesWater(t, n))).toBe(true);
  });
});

describe('discovery sends the report search again, undated, only when nothing dated was about the water', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  const run = async (body, dated, undated) => {
    _resetIndexCache();
    const sent = [];
    globalThis.fetch = vi.fn(async (url) => {
      const u = new URL(String(url));
      if (u.hostname !== 'api.search.tinyfish.ai') return Response.json({ results: [] });
      const q = u.searchParams.get('query') || '';
      const r = u.searchParams.get('recency_minutes');
      sent.push({ q, r });
      const titles = !/fishing report/.test(q) ? [] : r ? dated : undated;
      return Response.json({ results: titles.map((t, i) => ({ title: t, url: `https://x.example/${r ? 'd' : 'u'}${i}`, snippet: t })) });
    });
    const env = { TINYFISH_API_KEY: 'test-key', R2_TROLLMAP_CHARTPACKS: {
      get: async (key) => (key === '_registry/lake_index.json' ? { text: async () => JSON.stringify(INDEX) } : null) } };
    const res = await handleResearchDiscover(new Request('https://worker/research/discover',
      { method: 'POST', body: JSON.stringify({ agent: 'fisheries', ...body }) }), env);
    return { sent, data: await res.json() };
  };

  it('Jordan: the report query goes out a second time with no date limit', async () => {
    const { sent, data } = await run({ lakeName: 'LAKE JORDAN, NC', state: 'NC', slug: 'b_everett_jordan_lake' },
      DATED_JORDAN, UNDATED_JORDAN);
    const report = sent.filter((s) => /fishing report/.test(s.q));
    expect(report.some((s) => s.r)).toBe(true);
    expect(report.some((s) => !s.r)).toBe(true);
    expect(data.queryLog.join('\n')).toMatch(/no dated result's title named the water: the same search with no date limit added 3/);
  });

  it('Murray: a dated result names the lake, so nothing more is sent', async () => {
    const { sent, data } = await run({ lakeName: 'Lake Murray, SC', state: 'SC', slug: 'lake_murray' },
      ['AHQ INSIDER Lake Murray (SC) 2026 Week 38 Fishing Report', 'x', 'y'], UNDATED_JORDAN);
    const report = sent.filter((s) => /fishing report/.test(s.q));
    expect(report.every((s) => s.r)).toBe(true);
    expect(data.queryLog.join('\n')).not.toMatch(/no dated result's title named the water/);
  });
});
