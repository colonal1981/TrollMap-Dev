import { afterEach, describe, expect, it, vi } from 'vitest';

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalLeaflet = globalThis.L;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalLeaflet === undefined) delete globalThis.L;
  else globalThis.L = originalLeaflet;
  vi.restoreAllMocks();
});

describe('summary agent orchestration', () => {
  it('uses saved profile and cached normalized docs when summary discovery returns no sources', async () => {
    vi.resetModules();
    globalThis.window = { TROLLMAP_RESEARCHED_CACHE: {} };
    globalThis.document = { getElementById: () => null };
    globalThis.L = { canvas: () => ({}) };
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const fetchMock = vi.fn(async (url, options = {}) => {
      const target = String(url);

      if (target.includes('/research/get?')) {
        return Response.json({
          ok: true,
          profile: {
            lakeName: 'Lake Wateree, SC',
            identity: { surfaceAreaAcres: 13864, archetype: 'river-run reservoir' },
            biology: { predatorSpecies: ['Largemouth Bass', 'Striped Bass'] },
            summary: { text: 'Existing deterministic summary.' },
            _extractedFacts: [{ category: 'surfaceArea', fact: 'Lake Wateree has 13,864 acres.', source: 'Wateree source' }],
            sources: [{ label: 'Wateree source', url: 'https://example.com/wateree' }]
          }
        });
      }

      if (target.includes('/research/discover')) {
        return Response.json({ success: true, sources: [], queryLog: [] });
      }

      if (target.includes('/research/get-normalized')) {
        return Response.json({
          ok: true,
          documents: [{
            title: 'Wateree watershed plan',
            url: 'https://example.com/wateree-plan.pdf',
            fullText: 'Lake Wateree source document text. '.repeat(20)
          }]
        });
      }

      if (target.includes('/research/agent-llm')) {
        const body = JSON.parse(options.body);
        expect(body.agent).toBe('summary');
        expect(body.previousResults.identity.surfaceAreaAcres).toBe(13864);
        expect(body.previousResults._normalizedDocuments).toHaveLength(1);
        expect(body.previousResults._normalizedDocuments[0].title).toBe('Wateree watershed plan');
        return Response.json({
          success: true,
          agent: 'summary',
          section: { text: 'Grounded Wateree summary.', keywords: ['Wateree'] },
          sources: [{ label: 'Derived from saved lake profile and cached source documents', trust: 'DERIVED' }]
        });
      }

      throw new Error(`Unexpected fetch: ${target}`);
    });
    globalThis.fetch = fetchMock;

    const { runAgent } = await import('../js/modules/lake-research-engine.js');
    const result = await runAgent('Lake Wateree, SC', 'summary', 'full');

    expect(result.success).toBe(true);
    expect(result.docsUsed).toBe(1);
    expect(result.factsCount).toBe(1);
    expect(result.section.text).toBe('Grounded Wateree summary.');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/research/agent-llm'), expect.any(Object));
  });
});
