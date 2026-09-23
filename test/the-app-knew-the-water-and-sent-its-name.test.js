/**
 * test/the-app-knew-the-water-and-sent-its-name.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * 2026-09-23, the 33-river research batch. Three names came back thin:
 *
 *     the name the batch asked with     species written   NC WRC's file holds
 *     "Broad River, SC"                        4                  8
 *     "PEE DEE RIVER, NC"                      1                  8
 *     "French Broad River, TN"                 2                  7
 *
 * The app had ALREADY bound all three to the right registry row -- research_todo.mjs's
 * registryRecordFor(), which answers a stripped name only when the feed's own access points sit on
 * that row's water (bound_by: access-index, measured on Ryan's machine the same afternoon). Then
 * it sent the NAME, and the Worker re-resolved it with resolveRegistryRow(), which deliberately
 * will not strip a state suffix -- "Goose Creek, TN" matched exactly one record, the SC one, and
 * borrowed it. Null. registrySpeciesFor() returned an empty roster WITHOUT A WORD, the fisheries
 * agent had nothing to group, and discover mode wrote intel for whatever the documents named.
 *
 * Where the name DID resolve the roster matched the file exactly, water after water -- Yadkin 12
 * and 12, Tuckasegee 11 and 11, Neuse 20 and 20 -- which is how the mechanism was proven.
 *
 * THE FIX IS NOT A LOOSER RESOLVER. Loosening resolveRegistryRow to strip ", SC" would reach these
 * three and would also reach Silver Lake, GA -> an SC lake, which is the bug access-index.js was
 * rewritten to kill. The answer already existed at the caller; it is carried now instead of thrown
 * away. And a name that reaches nothing is REPORTED, because "could not look" and "no fish on file"
 * are different claims that used to be the same empty list.
 *
 *   node --test test/the-app-knew-the-water-and-sent-its-name.test.js
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { registrySpeciesFor } from '../Worker/research/deterministic.js';
import { _resetIndexCache } from '../Worker/registry.js';

const FX = JSON.parse(readFileSync(
  new URL('./fixtures/the-app-knew-the-water.2026-09-23.json', import.meta.url), 'utf8'));
const KEYS = {
  '_registry/lake_index.json': FX.lake_index,
  '_registry/nc_species_by_lake.json': FX.nc_species_by_lake,
};
const env = () => ({
  R2_TROLLMAP_CHARTPACKS: {
    get: async (key) => (KEYS[key]
      ? { text: async () => JSON.stringify(KEYS[key]),
          arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(KEYS[key])).buffer }
      : null),
  },
});
const ask = async (name, state, slug) => {
  _resetIndexCache();
  return registrySpeciesFor(env(), name, state, slug);
};
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const THREE = [
  ['Broad River, SC', 'broad_river', 8],
  ['PEE DEE RIVER, NC', 'pee_dee_river_2', 8],
  ['French Broad River, TN', 'french_broad_river', 7],
];

describe('the three names the batch used, asked the way it asked', () => {
  for (const [name] of THREE) {
    it(`"${name}" alone reaches no row -- and now SAYS so`, async () => {
      const r = await ask(name, 'NC');
      expect(r.slug).toBe(null);
      expect(r.predatorSpecies.length).toBe(0);
      expect(r.unresolved).toBe(name);
    });
  }
});

describe('the same three, with the slug the app had already bound', () => {
  for (const [name, slug] of THREE) {
    it(`"${name}" + ${slug} gets exactly what the registry gives that water by its own name`, async () => {
      const r = await ask(name, 'NC', slug);
      expect(r.slug).toBe(slug);
      expect(r.resolvedBy).toBe('slug');
      expect(r.unresolved).toBe(null);
      // THE CONTROL IS THE SAME FUNCTION ASKED WITH THE REGISTRY'S OWN DISPLAY NAME, which
      // resolves by name. Not a hard-coded count: uniqueResearchSpecies() canonicalises the file's
      // spellings -- "North American Freshwater Catfishes" becomes Catfish -- and drops what is not
      // a target, which is why Pee Dee's eight become seven (American Shad). The slug path must
      // produce the identical roster, no more and no less.
      const control = await ask(FX.lake_index[slug].display_name, 'NC');
      expect(control.resolvedBy).toBe('name');
      expect(JSON.stringify(r.predatorSpecies)).toBe(JSON.stringify(control.predatorSpecies));
      expect(r.predatorSpecies.length >= 7).toBe(true);
    });
  }

  it('the Broad gets its muskellunge stocking, which the batch never saw', async () => {
    const r = await ask('Broad River, SC', 'NC', 'broad_river');
    expect(r.knownStockings.some((s) => /muskellunge/i.test(s.species))).toBe(true);
  });
});

describe('a slug is a claim, not a key to anything', () => {
  it('a slug the index does not hold is ignored and the name gets its chance', async () => {
    const r = await ask('YADKIN RIVER, NC', 'NC', 'no_such_water');
    expect(r.slug).toBe('yadkin_river');
    expect(r.resolvedBy).toBe('name');
    expect(r.predatorSpecies.length >= 12).toBe(true);
  });

  it('and when neither reaches anything, it is unresolved, not empty', async () => {
    const r = await ask('Nowhere Creek, ZZ', 'NC', 'no_such_water');
    expect(r.slug).toBe(null);
    expect(r.unresolved).toBe('Nowhere Creek, ZZ');
  });

  it('a name that already resolved is unchanged, with or without a slug', async () => {
    const a = await ask('YADKIN RIVER, NC', 'NC');
    const b = await ask('YADKIN RIVER, NC', 'NC', 'yadkin_river');
    expect(a.slug).toBe('yadkin_river');
    expect(b.slug).toBe('yadkin_river');
    expect(a.predatorSpecies.length).toBe(b.predatorSpecies.length);
  });
});

describe('the resolver was NOT loosened, because a looser one reintroduces Goose Creek', () => {
  it('resolveRegistryRow still does not strip a state suffix', () => {
    const reg = src('../Worker/registry.js');
    const fn = reg.slice(reg.indexOf('export function resolveRegistryRow'),
                         reg.indexOf('export function resolveRegistryRow') + 3500);
    expect(/replace\([^)]*,\\s\*\[A-Z\]\{2\}/.test(fn)).toBe(false);
  });
});

describe('every caller that holds the binding now passes it', () => {
  it('the app sends the slug on /species', () => {
    expect(src('../js/modules/plan-inputs.js').includes("u.searchParams.set('slug', slug)")).toBe(true);
  });

  it('both plan paths pass the same row whose state they already sent', () => {
    for (const f of ['../js/modules/smart-plan-v2-wiring.js', '../js/modules/plan-water-ui.js']) {
      expect(src(f).includes("(regRow || {}).slug || ''")).toBe(true);
    }
  });

  it('GET /species and deterministic-facts both read it', () => {
    expect(src('../Worker/trollmap-worker.js').includes('url.searchParams.get("slug")')).toBe(true);
    const det = src('../Worker/research/deterministic.js');
    expect(det.includes('const slug = String(body.slug')).toBe(true);
    expect(det.includes('registrySpeciesFor(env, lakeName, state, slug)')).toBe(true);
    expect(det.includes('registryUnresolved')).toBe(true);
  });

  it('research_todo.mjs emits the slug AND which binding produced it', () => {
    const t = src('../Scripts/research_todo.mjs');
    expect(t.includes('slug: (rec && rec.slug) || null')).toBe(true);
    expect(t.includes("bound_by: viaIndex ? 'access-index'")).toBe(true);
  });

  it('research_lakes.py forwards only a slug the access index earned', () => {
    const p = src('../Scripts/research_lakes.py');
    expect(p.includes('r.get("bound_by") == "access-index"')).toBe(true);
    expect(p.includes('det_body["slug"] = bound')).toBe(true);
  });
});
