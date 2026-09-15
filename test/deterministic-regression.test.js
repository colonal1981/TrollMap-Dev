// ONE OPTIONAL ENRICHMENT COULD TAKE THE WHOLE HANDLER DOWN.
//
// This file went red when the SC inshore floor landed: the block that decides whether a water is
// coastal reads `_registry/lake_index.json`, and it read it with a bare `await lakeIndex(env)`.
// A bucket without that object -- this test's bucket, and any bucket where the pipeline has not
// run upload_garmin_to_r2.py -- threw, and the throw came out of a handler whose other dozen
// blocks do not need the index at all. Losing the coastal floor costs five species names;
// failing the request costs the whole profile.
//
// The registry read now degrades and SAYS SO, which is what limnology.js already does one file
// over. `registryError` is the difference between "this water is not coastal" and "we could not
// find out" -- two answers that produce the same empty roster and must not read the same.
import { describe, expect, it } from './expect-shim.mjs';
import { handleResearchDeterministicFacts } from '../Worker/research/deterministic.js';

const ask = (env) => handleResearchDeterministicFacts(
  new Request('https://worker/research/deterministic-facts', {
    method: 'POST', body: JSON.stringify({ lakeName: 'Lake Wateree, SC', state: 'SC' }),
  }), env);

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

  it('A MISSING REGISTRY IS A SILENCE THAT SAYS SO, not a failed request', async () => {
    const response = await ask({ R2_TROLLMAP_CHARTPACKS: { get: async () => null } });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    // Named, not swallowed. An empty coastal roster on a water nobody could look up is not the
    // same answer as an empty roster on a water that is genuinely inland.
    expect(String(data.registryError)).toMatch(/lake_index\.json/);
  });

  it('...and a bucket that answers carries no such flag', async () => {
    const index = JSON.stringify({ lakes: { wateree_lake: {
      slug: 'wateree_lake', name: 'Lake Wateree, SC', display_name: 'Lake Wateree, SC',
      state: 'SC', feature_type: 'reservoir' } } });
    const response = await ask({ R2_TROLLMAP_CHARTPACKS: {
      get: async (k) => (k === '_registry/lake_index.json'
        ? { text: async () => index, body: index, arrayBuffer: async () => new TextEncoder().encode(index).buffer }
        : null),
    } });
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.registryError).toBe(undefined);
  });
});
