import { afterEach, describe, expect, it, vi } from 'vitest';
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
      body: JSON.stringify({ lakeName: 'Lake Wateree, SC', state: 'SC', agent: 'identity' })
    });

    const response = await handleResearchDiscover(request, { TINYFISH_API_KEY: 'test-key' });
    const data = await response.json();
    const urls = data.sources.map(source => source.url);

    expect(data.success).toBe(true);
    expect(urls).toContain('https://www.dnr.sc.gov/fish/lake-wateree-survey.pdf');
    expect(urls).not.toContain('https://www.dnr.sc.gov/lakes/wateree/description.html');
    expect(urls.some(url => /duke-energy\.com/.test(url))).toBe(false);
  });

  it('keeps the approved R2 regulation digest as the regulation source', async () => {
    mockDiscoveryFetch();
    const request = new Request('https://worker/research/discover', {
      method: 'POST',
      body: JSON.stringify({ lakeName: 'Lake Wateree, SC', state: 'SC', agent: 'regulations' })
    });

    const response = await handleResearchDiscover(request, { TINYFISH_API_KEY: 'test-key' });
    const data = await response.json();

    expect(data.success).toBe(true);
    const r2Digest = data.sources.find(source => /\.r2\.dev\/regulations\/sc_digest_2025_2026\.pdf$/.test(source.url));
    expect(r2Digest).toBeTruthy();
    expect(r2Digest.priority).toBe(1);
  });

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
