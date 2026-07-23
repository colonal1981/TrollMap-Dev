import { describe, expect, it } from 'vitest';
import { handleResearchDeterministicFacts } from '../Worker/research/deterministic.js';

describe('deterministic facts regression', () => {
  it('returns successfully without seededDiscoveryTargets reference error', async () => {
    const request = new Request('https://worker/research/deterministic-facts', {
      method: 'POST',
      body: JSON.stringify({ lakeName: 'Lake Wateree, SC', state: 'SC' })
    });
    const response = await handleResearchDeterministicFacts(request, { R2_TROLLMAP_CHARTPACKS: { get: async () => null } });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.seededDiscoveryTargets).toEqual([]);
  });
});
