/**
 * test/the-rivers-with-no-roster-get-their-watershed.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * 2026-09-23. Four rivers had no species roster in any registry file -- Clinch, First Broad,
 * Nolichucky, Holston -- and discover mode, which can only admit a fish an agency document in hand
 * names, came back with 4, 2, 0 and never-run. registrySpeciesFor() now has a last rung under the
 * NC file, the agency pages, the regulations and advisory floors and the ramp feeds: the fish
 * recorded in the water's own 8-digit watershed (NatureServe 2010 natives; USGS NAS introductions
 * recorded as established or stocked), from registry/watershed_fish.json.
 *
 * Measured the same evening against the 124 waters with a roster we already trust: the watershed
 * lists name 95.4% of those species and about five times as many again. That second number is the
 * whole design of the rung -- it fills an EMPTY roster and never adds to one.
 *
 * The fixture is the real registry rows for five waters, cut by _scratch/make_watershed_fixture.py.
 *
 *   node --test test/the-rivers-with-no-roster-get-their-watershed.test.js
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { registrySpeciesFor } from '../Worker/research/deterministic.js';
import { _resetIndexCache } from '../Worker/registry.js';

const FX = JSON.parse(readFileSync(
  new URL('./fixtures/watershed-fish.2026-09-23.json', import.meta.url), 'utf8'));

const bucket = (keys) => ({
  R2_TROLLMAP_CHARTPACKS: {
    get: async (key) => (keys[key]
      ? { text: async () => JSON.stringify(keys[key]),
          arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(keys[key])).buffer }
      : null),
  },
});
const WITH = {
  '_registry/lake_index.json': FX.lake_index,
  '_registry/nc_species_by_lake.json': FX.nc_species_by_lake,
  '_registry/watershed_fish.json': FX.watershed_fish,
};
const WITHOUT = { ...WITH };
delete WITHOUT['_registry/watershed_fish.json'];

const ask = async (keys, slug) => {
  _resetIndexCache();
  const row = FX.lake_index[slug];
  return registrySpeciesFor(bucket(keys), row.display_name, row.state, slug);
};

describe('a river with no roster anywhere gets the fish recorded in its watershed', () => {
  for (const slug of ['nolichucky_river', 'clinch_river', 'first_broad_river']) {
    it(`${slug}: empty without the file, the watershed's fish with it`, async () => {
      const before = await ask(WITHOUT, slug);
      expect(before.predatorSpecies.length).toBe(0);
      const after = await ask(WITH, slug);
      const listed = FX.watershed_fish.waters[slug].targets.map((t) => t.name);
      expect(after.predatorSpecies.length).toBe(new Set(listed).size);
      for (const n of after.predatorSpecies) expect(listed.includes(n)).toBe(true);
    });
  }

  it('the Nolichucky, which had none at all, now has its bass, crappie and catfish', async () => {
    const r = await ask(WITH, 'nolichucky_river');
    for (const n of ['Smallmouth Bass', 'Largemouth Bass', 'Channel Catfish', 'Black Crappie'])
      expect(r.predatorSpecies.includes(n)).toBe(true);
  });

  it('it says what kind of claim it is, to every reader', async () => {
    const r = await ask(WITH, 'nolichucky_river');
    const s = r.sources.find((x) => x.kind === 'watershed');
    expect(Boolean(s)).toBe(true);
    expect(s.trust).toBe('REFERENCE');
    expect(s.url).toBe('registry:watershed_fish.json');
    const ev = r.evidence.find((e) => e.field === 'predatorSpecies').entries[0];
    expect(ev.method).toBe('watershed_species_fallback');
    expect(ev.hucs.some((h) => h.startsWith('06010108'))).toBe(true);
  });

  it('an introduced fish recorded INSIDE the water is named as such in the evidence', async () => {
    const r = await ask(WITH, 'nolichucky_river');
    const ev = r.evidence.find((e) => e.field === 'predatorSpecies').entries[0];
    const inside = FX.watershed_fish.waters.nolichucky_river.targets
      .filter((t) => t.in_water > 0).map((t) => t.name);
    expect(inside.length > 0).toBe(true);
    expect(JSON.stringify(ev.introducedRecordsInsideThisWater)).toBe(JSON.stringify(inside));
  });
});

describe('a water with a roster keeps exactly its roster', () => {
  it('broad_river: NC WRC names its fish, and the watershed adds nothing', async () => {
    const withFile = await ask(WITH, 'broad_river');
    const without = await ask(WITHOUT, 'broad_river');
    expect(without.predatorSpecies.length > 0).toBe(true);
    expect(JSON.stringify(withFile.predatorSpecies)).toBe(JSON.stringify(without.predatorSpecies));
    expect(withFile.sources.some((x) => x.kind === 'watershed')).toBe(false);
  });

  it('wateree_lake: whatever the registry names, the watershed rung does not touch', async () => {
    const withFile = await ask(WITH, 'wateree_lake');
    const without = await ask(WITHOUT, 'wateree_lake');
    if (without.predatorSpecies.length) {
      expect(JSON.stringify(withFile.predatorSpecies)).toBe(JSON.stringify(without.predatorSpecies));
      expect(withFile.sources.some((x) => x.kind === 'watershed')).toBe(false);
    }
  });
});

describe('the file missing is not an error', () => {
  it('no watershed object in the bucket: the roster is simply empty, and nothing throws', async () => {
    const r = await ask(WITHOUT, 'clinch_river');
    expect(r.slug).toBe('clinch_river');
    expect(r.predatorSpecies.length).toBe(0);
    expect(r.unresolved).toBe(null);
  });
});

describe('the rung is the last one, by construction', () => {
  const code = readFileSync(new URL('../Worker/research/deterministic.js', import.meta.url), 'utf8');
  it('it is read only under an empty roster', () => {
    const i = code.indexOf('await watershedFish(env)');
    expect(i > 0).toBe(true);
    const guard = code.lastIndexOf('if (!out.predatorSpecies.length) {', i);
    expect(guard > 0 && i - guard < 200).toBe(true);
  });
  it('and it comes after the ramp floor, the last of the rungs above it', () => {
    expect(code.indexOf('await watershedFish(env)') > code.indexOf("'ramp_species_floor'")).toBe(true);
  });
});
