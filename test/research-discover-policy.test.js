import { afterEach, describe, expect, it, vi } from './expect-shim.mjs';
import { handleResearchDiscover } from '../Worker/research/discover.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockDiscoveryFetch() {
  globalThis.fetch = vi.fn(async (url) => {
    const target = String(url);
    if (target.startsWith('https://api.search.tinyfish.ai')) {
      const query = new URL(target).searchParams.get('query') || '';
      if (query.includes('wikipedia.org')) return Response.json({ results: [] });
      return Response.json({
        results: [{
          title: 'Lake Wateree fisheries survey',
          url: 'https://www.dnr.sc.gov/fish/lake-wateree-survey.pdf',
          snippet: 'Lake Wateree South Carolina fisheries survey and habitat assessment.'
        }]
      });
    }
    if (target === 'https://api.fetch.tinyfish.ai') {
      return Response.json({ results: [{ text: '', links: [] }] });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  });
}

describe('research discovery source policy', () => {
  it('uses search results and generic allowed sources instead of a Wateree live URL seed', async () => {
    mockDiscoveryFetch();
    const request = new Request('https://worker/research/discover', {
      method: 'POST',
      body: JSON.stringify({ lakeName: 'Lake Wateree, SC', state: 'SC', agent: 'biology' })
    });

    const response = await handleResearchDiscover(request, { TINYFISH_API_KEY: 'test-key' });
    const data = await response.json();
    const urls = data.sources.map(source => source.url);

    expect(data.success).toBe(true);
    expect(urls).toContain('https://www.dnr.sc.gov/fish/lake-wateree-survey.pdf');
    expect(urls).not.toContain('https://www.dnr.sc.gov/lakes/wateree/description.html');
    expect(urls.some(url => /duke-energy\.com/.test(url))).toBe(false);
  });

  // The R2 regulation digest was seeded here for the `regulations` agent. That agent and five others
  // were deleted on 2026-09-25, and the route now refuses an agent it has no queries for -- as it
  // refuses a request that names none -- instead of answering 200 having searched nothing.
  for (const [label, agent] of [['names no agent', undefined], ['names a deleted agent', 'regulations'],
                                ['names another deleted agent', 'identity']]) {
    it(`answers 400 when the request ${label}, and says which agent it runs`, async () => {
      globalThis.fetch = vi.fn(async (url) => { throw new Error(`nothing may be fetched: ${url}`); });
      const request = new Request('https://worker/research/discover', {
        method: 'POST',
        body: JSON.stringify({ lakeName: 'Lake Wateree, SC', state: 'SC', ...(agent ? { agent } : {}) })
      });
      const response = await handleResearchDiscover(request, { TINYFISH_API_KEY: 'test-key' });
      const data = await response.json();
      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toMatch(/fisheries/);
      expect(data.error).toMatch(agent ? new RegExp(`unknown agent "${agent}"`) : /missing agent/);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  }

  it('builds SC biology discovery queries without crashing', async () => {
    mockDiscoveryFetch();
    const request = new Request('https://worker/research/discover', {
      method: 'POST',
      body: JSON.stringify({ lakeName: 'Lake Wateree, SC', state: 'SC', agent: 'biology' })
    });

    const response = await handleResearchDiscover(request, { TINYFISH_API_KEY: 'test-key' });
    const data = await response.json();
    const urls = data.sources.map(source => source.url);

    expect(response.ok).toBe(true);
    expect(data.success).toBe(true);
    expect(data.queryLog.join('\n')).not.toMatch(/SC_FWFI_QUERY|query builder failed/i);
    expect(urls).toContain('https://www.dnr.sc.gov/fish/lake-wateree-survey.pdf');
  });
});
