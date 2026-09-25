/**
 * test/this-water-in-this-state.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * The Claude step of 2026-09-24/25 ran 53 rivers; 17 failed, 14 because the stored documents were
 * about a different water. Johns River, NC got Florida's St. Johns. New River, NC got Virginia's.
 * Black River, SC got Vermont's. Pee Dee, NC got South Carolina's. French Broad, TN got
 * Asheville's. Lake Robinson, SC (H.B. Robinson, Chesterfield Co) got the Greer one.
 *
 * THE RULE (js/utils/water-scope.js): when a water's name does not pick out one water -- every
 * river, and any water another registry row also answers to -- discovery asks for it in its own
 * county, and the gate refuses a page that names another state (or, for a lake, the namesake's
 * county) more often than this water's own.
 *
 * The fixture's documents are the pages those searches returned, fetched 2026-09-25. Its index rows
 * are copied from the repo's registry fixtures where one exists and marked `constructed` where not.
 *
 *   node --test test/this-water-in-this-state.test.js
 */
import { afterEach, describe, it, expect, vi } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';

const FX = JSON.parse(readFileSync(
  new URL('./fixtures/this-water-in-this-state.2026-09-25.json', import.meta.url), 'utf8'));
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const S = await import('../js/utils/water-scope.js');
const G = await import('../js/utils/doc-relevance.js');
const R = await import('../js/utils/reach-places.js');
const { researchStorageId, stripLakeQualifiers } = await import('../js/data/research-ids.js');
const { handleResearchDiscover } = await import('../Worker/research/discover.js');
const { _resetIndexCache } = await import('../Worker/registry.js');

const scopeOf = (slug) => S.waterScope(FX.index, slug);
const appName = (slug) => {
  const r = FX.index[slug];
  return (r.legacy_display_names && r.legacy_display_names[0]) || `${stripLakeQualifiers(r.name)}, ${r.state}`;
};
const asDoc = (d) => ({ title: d.title, url: d.url, fullText: d.text });
const gate = (key, withScope = true) => {
  const d = FX.documents[key];
  return G.offLakeReason(asDoc(d), appName(d.water), [FX.index[d.water].name], G.LOCAL_NAME_WINDOW,
    withScope ? scopeOf(d.water) : null);
};

// ── 1. the measurement the rule stands on ────────────────────────────────────────────────────
describe('the county finds this water where the state term did not', () => {
  const measured = FX.searches.filter((s) => s.county_query);
  it('every county-anchored search measured came back at least 6 in 7 about this water', () => {
    for (const s of measured) {
      expect(s.county_on_water / s.county_total >= 6 / 7, `${s.water}: ${s.county_query}`).toBe(true);
    }
  });
  it('and every state-term search measured came back worse than its county search', () => {
    for (const s of measured.filter((x) => x.state_query)) {
      expect(s.state_on_water / s.state_total < s.county_on_water / s.county_total, s.water).toBe(true);
    }
  });
  it('quoting the state was tried and did not help the Johns River', () => {
    const quoted = FX.searches.find((s) => s.note && /quoting/.test(s.note));
    expect(quoted.state_on_water).toBe(3);
  });
});

// ── 2. which names need a place ──────────────────────────────────────────────────────────────
describe('a river always needs its place; a lake only when another row shares its name', () => {
  it('every river in the fixture is scoped, with its county off the row', () => {
    expect(scopeOf('johns_river').counties).toEqual(['Burke']);
    expect(scopeOf('new_river').counties).toEqual(['Ashe']);
    expect(scopeOf('black_river').counties).toEqual(['Williamsburg']);
    expect(scopeOf('congaree_river').why).toBe('river');
  });
  it('a row with no county field gives the county in its display name', () => {
    // pee_dee_river_2 and french_broad_river are copied from the-app-knew-the-water, which has none.
    expect(scopeOf('pee_dee_river_2').counties).toEqual(['Stanly']);
    expect(scopeOf('french_broad_river').counties).toEqual(['Haywood']);
    expect(S.countiesOf({ display_name: 'Congaree (Richland/Calhoun Co, SC)' })).toEqual(['Richland', 'Calhoun']);
  });
  it('Lake Robinson is two rows, and each is the other\'s rival -- by county and by the "(Greer)" bracket', () => {
    expect(scopeOf('lake_robinson').why).toBe('namesake');
    expect(scopeOf('lake_robinson').rivalPlaces).toEqual(['Greenville', 'Greer']);
    expect(scopeOf('lake_robinson_greer').rivalPlaces).toEqual(['Chesterfield']);
  });
  it('Lake Murray and Wateree have no namesake and get no scope, so nothing about them changes', () => {
    expect(scopeOf('lake_murray')).toBe(null);
    expect(scopeOf('wateree_lake')).toBe(null);
  });
  it('a water in two states keeps both: the Broad, filed NC, is measured into SC too', () => {
    expect(scopeOf('broad_river').states).toEqual(['NC', 'SC']);
  });
});

// ── 3. the gate ──────────────────────────────────────────────────────────────────────────────
describe('the gate refuses a page about another state\'s water', () => {
  for (const [key, d] of Object.entries(FX.documents)) {
    if (d.expect === 'other_piece') continue;   // the reach sort's, section 4
    it(`${key} for ${appName(d.water)}: ${d.expect || 'kept'}`, () => {
      expect(gate(key)).toBe(d.expect);
    });
  }
  it('four of those passed the gate before: the riverapp St. Johns, Virginia\'s New River, SCDNR\'s Great Pee Dee and Greer CPW', () => {
    for (const key of ['st_johns_riverapp', 'new_river_virginia_dwr', 'pee_dee_scdnr', 'robinson_greer_cpw']) {
      expect(gate(key, false), key).toBe(null);
    }
  });
  it('an official source does not save a page about another state: SCDNR\'s Pee Dee is not NC\'s', () => {
    expect(FX.documents.pee_dee_scdnr.url.includes('dnr.sc.gov')).toBe(true);
    expect(gate('pee_dee_scdnr')).toBe('another_state');
  });
  it('a page that names North Carolina 3 times and Virginia 7 is Virginia\'s, not a tie', () => {
    const d = FX.documents.new_river_virginia_dwr;
    const m = S.stateMentions(`${d.title} ${d.url} ${d.text}`);
    expect(m.VA).toBe(7);
    expect(m.NC).toBe(3);
  });
  it('the same page is the TENNESSEE French Broad\'s: Legacy Parks names Tennessee 3 times and NC once', () => {
    expect(gate('french_broad_legacy_parks')).toBe(null);
    const nc = { ...FX.documents.french_broad_legacy_parks, water: 'french_broad_river' };
    expect(G.offLakeReason(asDoc(nc), appName('french_broad_river'), [], G.LOCAL_NAME_WINDOW,
      scopeOf('french_broad_river'))).toBe('another_state');
  });
  it('a water in two states keeps a page that names its other state more', () => {
    const doc = { title: 'Broad River fishing below Gaffney', url: 'https://example.org/broad',
      fullText: 'The Broad River crosses from North Carolina into South Carolina. Below Gaffney, South Carolina, '
        + 'the river runs wide and shallow; South Carolina anglers take redbreast and smallmouth.' };
    expect(G.offLakeReason(doc, 'Broad River, NC', [], G.LOCAL_NAME_WINDOW, scopeOf('broad_river'))).toBe(null);
    expect(G.offLakeReason(doc, 'Broad River (2), SC', [], G.LOCAL_NAME_WINDOW, scopeOf('broad_river_2'))).toBe(null);
  });
  it('a page that names no state at all is not "plainly" anywhere, and falls to the old rules', () => {
    expect(S.elsewhereReason('Johns River smallmouth on a fly rod', scopeOf('johns_river'))).toBe(null);
  });
});

describe('a word that looks like a state is not always one', () => {
  it('Texas rig and Carolina rig are bass fishing', () => {
    expect(S.stateMentions('Fish a Texas rig on the bank, then a Carolina rig on the flat.')).toEqual({});
  });
  it('Washington County is a county, in NC, GA and TN', () => {
    expect(S.stateMentions('Ramps in Washington County, North Carolina')).toEqual({ NC: 1 });
  });
  it('"Washington, NC" is a town in North Carolina; the state after it is the one counted', () => {
    expect(S.stateMentions('Tar River at Washington, NC')).toEqual({ NC: 1 });
  });
  it('West Virginia is not Virginia, and "N.C." is North Carolina', () => {
    expect(S.stateMentions('the New River in West Virginia')).toEqual({ WV: 1 });
    expect(S.stateMentions('Morganton, N.C.')).toEqual({ NC: 1 });
  });
});

describe('without a scope the gate answers exactly as it did', () => {
  it('prepareNormalizedDocuments with no scope argument refuses what it refused before, and no more', () => {
    const docs = Object.values(FX.documents).map(asDoc);
    const before = G.prepareNormalizedDocuments(docs, 'Johns River, NC', [], '2026-09-25T00:00:00Z',
      ['Johns River'], G.LOCAL_NAME_WINDOW);
    const nulled = G.prepareNormalizedDocuments(docs, 'Johns River, NC', [], '2026-09-25T00:00:00Z',
      ['Johns River'], G.LOCAL_NAME_WINDOW, null);
    expect(nulled.refused).toEqual(before.refused);
    expect(before.refused.every((r) => r.why !== 'another_state' && r.why !== 'namesake_place')).toBe(true);
  });
});

// ── 4. the other piece of the same river ─────────────────────────────────────────────────────
describe('a page about another piece is that piece\'s even when its title does not say so', () => {
  // Gauge names in USGS's own grammar. The Asheville and Rosman stations are on the NC French
  // Broad; Newport is on the Tennessee one. Bindings constructed for the test.
  const bindings = {
    french_broad_river: { gauges: [{ name: 'FRENCH BROAD RIVER AT ASHEVILLE, NC' },
                                   { name: 'FRENCH BROAD RIVER AT ROSMAN, NC' }] },
    french_broad_river_2: { gauges: [{ name: 'FRENCH BROAD RIVER NEAR NEWPORT, TN' }] },
  };
  const reach = R.reachPlaces({ index: FX.index, bindings, lakeName: 'French Broad River (2), TN',
    slug: 'french_broad_river_2', storageId: researchStorageId, stripQualifiers: stripLakeQualifiers });
  const yonder = FX.documents.french_broad_mt_yonder;

  it('the NC French Broad is the Tennessee piece\'s sibling, with its towns', () => {
    expect(reach.siblings).toEqual(['french_broad_river']);
    expect(reach.other.french_broad_river).toEqual(['Asheville', 'Rosman']);
  });
  it('Mt. Yonder\'s Asheville guide passes the title test and the state count, and the body sends it to NC', () => {
    expect(R.sortDocuments([{ title: yonder.title }], reach).keep.length).toBe(1);
    expect(gate('french_broad_mt_yonder')).toBe(null);
    const d = R.sortDocuments([{ title: yonder.title, url: yonder.url, text: yonder.text }], reach);
    expect(d.elsewhere.map((x) => x.belongs_to)).toEqual(['french_broad_river']);
  });
  it('a page naming this piece in its title stays, whatever its body says about the other', () => {
    const doc = { title: 'French Broad below Newport', text: 'From Asheville and Rosman the river runs west.' };
    expect(R.sortDocuments([doc], reach).keep.length).toBe(1);
  });
  it('a body naming both pieces equally is kept', () => {
    const doc = { title: 'French Broad River', text: 'Asheville to Newport is a long float.' };
    expect(R.sortDocuments([doc], reach).keep.length).toBe(1);
  });
});

// ── 5. discovery sends the county, and only where the name needs it ───────────────────────────
describe('discovery adds one county query for a water whose name does not pick it out', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  const run = async (body) => {
    _resetIndexCache();
    const sent = [];
    globalThis.fetch = vi.fn(async (url) => {
      const u = new URL(String(url));
      if (u.hostname === 'api.search.tinyfish.ai') sent.push(u.searchParams.get('query') || '');
      return Response.json({ results: [] });
    });
    const index = FX.index;
    const env = { TINYFISH_API_KEY: 'test-key', R2_TROLLMAP_CHARTPACKS: {
      get: async (key) => (key === '_registry/lake_index.json'
        ? { text: async () => JSON.stringify(index) } : null) } };
    const res = await handleResearchDiscover(new Request('https://worker/research/discover',
      { method: 'POST', body: JSON.stringify({ agent: 'fisheries', ...body }) }), env);
    return { sent, data: await res.json() };
  };

  it('Johns River asks for "Burke County", without a loose state term diluting it', async () => {
    const { sent } = await run({ lakeName: 'Johns River, NC', state: 'NC', slug: 'johns_river' });
    expect(sent).toContain('"Johns River" "Burke County" fishing');
  });
  it('and still runs every query it ran before, so nothing it found is lost', async () => {
    const { sent } = await run({ lakeName: 'Johns River, NC', state: 'NC', slug: 'johns_river' });
    expect(sent).toContain('"Johns River" fishing report water level flow North Carolina');
  });
  it('Lake Robinson asks for Chesterfield, because the client names the row the Worker cannot pick', async () => {
    const { sent, data } = await run({ lakeName: 'Lake Robinson, SC', state: 'SC', slug: 'lake_robinson' });
    expect(sent).toContain('"Lake Robinson" "Chesterfield County" fishing');
    expect(sent.some((q) => /Greenville County/.test(q))).toBe(false);
    expect(data.queryLog.join('\n')).toMatch(/also lake_robinson_greer/);
  });
  it('Lake Murray sends exactly what it sent before: no county query', async () => {
    const { sent } = await run({ lakeName: 'Lake Murray, SC', state: 'SC', slug: 'lake_murray' });
    expect(sent.some((q) => /County" fishing$/.test(q))).toBe(false);
    expect(sent.length > 0).toBe(true);
  });
});

describe('research_lakes.py carries the scope to both halves', () => {
  const py = src('../Scripts/research_lakes.py');
  it('sends the bound slug to discovery, and the scope to the gate', () => {
    expect(py.includes('disc_body["slug"] = slug')).toBe(true);
    expect(py.includes('gate_documents(repo, merged, lake, alt_names, scope)')).toBe(true);
  });
  it('reach_places.mjs returns the scope beside the places', () => {
    expect(src('../Scripts/reach_places.mjs').includes('scope: waterScope(index, input.slug || null)')).toBe(true);
  });
});
