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
 * THE RULE ONLY READS SENTENCES THAT NAME THE WATER, WITH THE NAME TAKEN OUT. The desktop review of
 * 2026-09-25 ran the first version over 758 stored documents and found it refusing real pages: the
 * Little Tennessee's own name counted as Tennessee, a nav link or a football score outvoted a page
 * that never names its state, and "constructor" was a state. Its re-measure of eee0d06 then found a
 * state given to the wrong water ("the New River in Virginia" on a Deep River page). So a state
 * counts only when the page gives it to THIS water. Section 3b is those pages.
 *
 * The fixture's documents are the pages those searches returned, fetched 2026-09-25. Its index rows
 * are copied from the repo's registry fixtures where one exists and marked `constructed` where not.
 *
 *   node --test test/this-water-in-this-state.test.js
 */
import { afterEach, describe, it, expect, vi } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { registryMissing, registryPath } from './registry-here.mjs';

const FX = JSON.parse(readFileSync(
  new URL('./fixtures/this-water-in-this-state.2026-09-25.json', import.meta.url), 'utf8'));
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const S = await import('../js/utils/water-scope.js');
const G = await import('../js/utils/doc-relevance.js');
const R = await import('../js/utils/reach-places.js');
const { stripLakeQualifiers } = await import('../js/data/research-ids.js');
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
    if (d.review) continue;   // section 3b
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
  it('Virginia DWR gives the New River Virginia 5 times and North Carolina 3: Virginia\'s, not a tie', () => {
    const d = FX.documents.new_river_virginia_dwr;
    expect(S.statesTiedToWater(`${d.title}\n${d.url}\n${d.text}`, scopeOf('new_river').names))
      .toEqual({ VA: 5, NC: 3 });
  });
  it('a page that never ties the name to a state is kept, even for the other piece: a miss, left to the Claude step', () => {
    // Legacy Parks names "North Carolina" in a sentence that does not name the French Broad, and the
    // Asheville guide names neither state beside it. Both pass for either piece now.
    for (const slug of ['french_broad_river', 'french_broad_river_2']) {
      for (const key of ['french_broad_legacy_parks', 'french_broad_mt_yonder']) {
        const d = FX.documents[key];
        expect(G.offLakeReason(asDoc(d), appName(slug), [], G.LOCAL_NAME_WINDOW, scopeOf(slug)), `${key} for ${slug}`)
          .toBe(null);
      }
    }
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

// ── 3b. the desktop review's false refusals ────────────────────────────────────────────────────
describe('a real page about the right water is not refused over a word that is not about it', () => {
  // Each of these was refused by the first version of the rule; `review` says what it counted.
  const force = (slug) => scopeOf(slug) || { why: 'forced', states: S.statesOf(FX.index[slug]),
    counties: [], namesakes: [], ownPlaces: [], rivalPlaces: [], names: S.namesOf(FX.index[slug]) };
  for (const [key, d] of Object.entries(FX.documents).filter(([, x]) => x.review)) {
    it(`${key} (${d.review}) is kept`, () => {
      expect(G.offLakeReason(asDoc(d), appName(d.water), [FX.index[d.water].name], G.LOCAL_NAME_WINDOW,
        force(d.water))).toBe(null);
    });
  }
  it('the water\'s own name is taken out before counting: "Little Tennessee" is not Tennessee', () => {
    const names = S.namesOf(FX.index.little_tennessee_river);
    expect(names).toEqual(['little tennessee river', 'little tennessee']);
    expect(S.stateMentions(S.nameSentences('The Little Tennessee River near Franklin.', names))).toEqual({});
  });
  it('a one-word remainder is never a name on its own: "Johns", "New", "Black" are words first', () => {
    expect(S.namesOf(FX.index.johns_river)).toEqual(['johns river']);
    expect(S.namesOf(FX.index.new_river)).toEqual(['new river']);
  });
  it('no fixture water\'s own names count as a state once taken out', () => {
    for (const [slug, row] of Object.entries(FX.index)) {
      const names = S.namesOf(row);
      const text = names.map((n) => `We fished the ${n} today.`).join(' ');
      expect(S.stateMentions(S.nameSentences(text, names)), slug).toEqual({});
    }
  });
  // The cloud checkout has no registry; the desktop does. Skipped with the reason, never passed.
  it('and none in the real registry either, where it is beside the repo',
    { skip: registryMissing('lake_index.json') }, () => {
    const rows = JSON.parse(readFileSync(registryPath('lake_index.json'), 'utf8'));
    for (const [slug, row] of Object.entries(rows.lakes || rows)) {
      const names = S.namesOf(row);
      const text = names.map((n) => `We fished the ${n} today.`).join(' ');
      expect(S.stateMentions(S.nameSentences(text, names)), slug).toEqual({});
    }
  });
  it('a state goes to the water named before it, not to every water in the sentence', () => {
    expect(S.statesTiedToWater('fishing on the New River in Virginia, but Deep River Fly Fishing took us out on the Deep River',
      ['deep river'])).toEqual({});
    expect(S.statesTiedToWater('The Deep River in North Carolina', ['deep river'])).toEqual({ NC: 1 });
  });
  it('a possessive goes forward: "Florida\'s St. Johns River" is Florida\'s', () => {
    expect(S.statesTiedToWater("Florida's St. Johns River is running high", ['johns river'])).toEqual({ FL: 1 });
    expect(S.statesTiedToWater("The Little Tennessee is North Carolina's best stream",
      S.namesOf(FX.index.little_tennessee_river))).toEqual({ NC: 1 });
  });
  it('"St." does not end a sentence, and a state before a water word is that water', () => {
    expect(S.statesTiedToWater('Florida St. Johns River', ['johns river'])).toEqual({ FL: 1 });
    expect(S.statesTiedToWater('The New River empties into the great Mississippi River.', ['new river'])).toEqual({});
  });
  it('the title, the URL and the body are separate sentences on the gate\'s path', () => {
    expect(gate('congaree_noaa_gauge', true)).toBe(null);
  });
  it('an inherited member is not a state', () => {
    expect(S.stateMentions('constructor toString valueOf hasOwnProperty __proto__')).toEqual({});
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
describe('a document is sorted to another piece of the river by its title only, as before', () => {
  // A body test was tried and taken out. The desktop review ran it over the stored corpora: it
  // moved 43 documents, among them a Chattahoochee report on "willow leaf" blades (the place
  // "Leaf"), a Travelers Rest trip on the upper Saluda on one "Columbia", and a Broad River page on
  // one "Carlisle". A page about the whole river names every piece, which is why the title test
  // never read the body.
  const reach = { own: ['Ware Shoals', 'Pelzer'], other: { saluda_river_lower_saluda: ['Columbia'] } };
  it('a page on the upper river that mentions Columbia once stays', () => {
    const d = { title: 'Saluda River Fishing Trip', url: 'https://travelersresthere.com/saluda-river-fishing-trip/',
      text: 'We put in above Pelzer and fished down; the river reaches Columbia a long way below.' };
    expect(R.sortDocuments([d], reach).keep.length).toBe(1);
  });
  it('the reach sort is back to exactly what it was', () => {
    expect(src('../js/utils/reach-places.js').includes('busiestElsewhere')).toBe(false);
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
