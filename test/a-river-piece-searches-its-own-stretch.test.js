/**
 * test/a-river-piece-searches-its-own-stretch.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-09-24: "how do we fix the slim upper saluda research then? How do we ensure we get
 * facts for the correct area".
 *
 * Every discovery query for the upper Saluda said `"Saluda River" ...`, and on the web that means
 * the tailwater in Columbia. Of the 76 facts on the served profile, saluda_river_sc, 24 name the
 * Lower Saluda outright and 10 name one of the mountain forks. The registry already knows where
 * each piece is -- its gauges are named for towns, its launches for landings -- so discovery now
 * searches the piece's own towns, and a fact or document about another piece is sorted out with
 * the piece and the place that decided it.
 *
 * The fixture is cut from the real registry, the state feeds and the served profile by
 * _scratch/make_reach_fixture.py.
 *
 *   node --test test/a-river-piece-searches-its-own-stretch.test.js
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';

const FX = JSON.parse(readFileSync(
  new URL('./fixtures/a-river-piece-searches-its-own-stretch.2026-09-24.json', import.meta.url), 'utf8'));
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const R = await import('../js/utils/reach-places.js');
const { researchStorageId, stripLakeQualifiers } = await import('../js/data/research-ids.js');
const { waterTypeSearch, searchablePlaces } = await import('../Worker/research/water-type-hints.js');

const reachFor = (lakeName, slug) => R.reachPlaces({
  index: FX.index, bindings: FX.bindings, lakeName, slug, feedNames: FX.feedNames,
  storageId: researchStorageId, stripQualifiers: stripLakeQualifiers });
const UPPER = reachFor('Saluda River, SC', 'saluda_river_2');

// ── 1. the places, read out of names the agencies already wrote ─────────────────────────────
describe('a gauge is named river, locative, place -- and only a gauge ON the river gives one', () => {
  it('reads the town after the locative, in the agencies\' own abbreviations', () => {
    expect(R.placesInStationName('Saluda River near WARE SHOALS', 'Saluda River')).toEqual(['Ware Shoals']);
    expect(R.placesInStationName('SALUDA RIVER NEAR PELZER, S. C.', 'Saluda River')).toEqual(['Pelzer']);
    expect(R.placesInStationName('SALUDA RIVER ABOVE I-85 NR GOLDEN GROVE, SC', 'Saluda River'))
      .toEqual(['Golden Grove']);
    expect(R.placesInStationName('SALUDA R ABOVE I-26, #5, AT COLUMBIA, SC', 'Saluda River'))
      .toEqual(['Columbia']);
  });
  it('a tributary\'s gauge names its creek, so it gives the river nothing', () => {
    expect(R.placesInStationName('WILSON CREEK AT NINETY SIX, SC', 'Saluda River')).toEqual([]);
    expect(R.placesInStationName('TRIBUTARY TO SALUDA RIVER AT COLUMBIA, SC', 'Saluda River')).toEqual([]);
  });
  it('a launch gives its name, split where it lists two, and never a one-word leftover', () => {
    expect(R.placesInLaunchName('James R. Metts (Hope Ferry)')).toEqual(['Hope Ferry', 'James R. Metts']);
    expect(R.placesInLaunchName('Ware Shoals/Irvin Pitts Park')).toEqual(['Ware Shoals', 'Irvin Pitts Park']);
    expect(R.placesInLaunchName('Saluda Shoals (Lower)')).toEqual(['Saluda Shoals']);
  });
  it('a bracket that tells two rows apart is a place; a county, a number and a road are not', () => {
    expect(R.qualifiersOf('Saluda River (Lower Saluda) (Lexington Co, SC)')).toEqual(['Lower Saluda']);
    expect(R.qualifiersOf('Saluda River (2) (Newberry Co, SC)')).toEqual([]);
    expect(R.qualifiersOf('Congaree River (to SC-601) (Richland Co, SC)')).toEqual([]);
  });
});

// ── 2. which rows are this research, and which are not ───────────────────────────────────────
describe('the rows that store together research together; the rest of the river is not them', () => {
  it('the upper Saluda is both upper rows, and the Lower Saluda is its sibling', () => {
    expect(UPPER.target).toBe('saluda_river_sc');
    expect(UPPER.group).toEqual(['saluda_river', 'saluda_river_2']);
    expect(UPPER.siblings).toEqual(['saluda_river_lower_saluda']);
  });
  it('and from the other side, the Lower Saluda is alone and both upper rows are its siblings', () => {
    const low = reachFor('Saluda River (Lower Saluda), SC', 'saluda_river_lower_saluda');
    expect(low.group).toEqual(['saluda_river_lower_saluda']);
    expect(low.siblings).toEqual(['saluda_river', 'saluda_river_2']);
  });
  it('searches the upper river\'s own towns, from both of its rows', () => {
    for (const p of ['Ware Shoals', 'Pelzer', 'Williamston', 'Chappells', 'Silverstreet']) {
      expect(UPPER.search).toContain(p);
    }
    expect(UPPER.search).not.toContain('Columbia');
  });
  it('knows the Lower Saluda by its bracket and its landings, and the forks by the state\'s names', () => {
    const low = UPPER.other.saluda_river_lower_saluda;
    for (const p of ['Lower Saluda', 'Hope Ferry', 'Saluda Shoals Park', 'Columbia']) expect(low).toContain(p);
    for (const n of ['North Saluda River', 'Middle Saluda River', 'South Saluda River']) {
      expect(UPPER.other[n]).toEqual([n]);
    }
    // A lake at either end is neither a sibling nor a "longer" name: facts about Lake Murray stay.
    expect(JSON.stringify(UPPER.other).includes('Lake Murray')).toBe(false);
  });
});

// ── 3. the sort, on the served profile's own facts and sources ───────────────────────────────
describe('what names another piece and none of this one goes to that piece', () => {
  const s = R.sortFacts(FX.facts, UPPER);
  it('38 of the 76 facts are another piece\'s, and every one says which and why', () => {
    expect(FX.facts.length).toBe(76);
    expect(s.elsewhere.length).toBe(38);
    expect(s.keep.length).toBe(38);
    expect(s.elsewhere.every((f) => f.belongs_to && f.because)).toBe(true);
    expect(s.elsewhere.filter((f) => f.belongs_to === 'saluda_river_lower_saluda').length).toBe(28);
  });
  it('a fact that names this piece stays even when it names another too', () => {
    const both = { fact: 'Float from Ware Shoals down toward Columbia.' };
    expect(R.sortFacts([both], UPPER).keep.length).toBe(1);
  });
  it('a word is not a place: "lower water" is not the Lower Saluda', () => {
    const f = { fact: 'Catfish bite best on lower water in late summer.' };
    expect(R.sortFacts([f], UPPER).keep.length).toBe(1);
  });
  it('documents are judged on their title', () => {
    const titles = [...new Set(FX.facts.map((f) => f.source))].map((title) => ({ title }));
    const d = R.sortDocuments(titles, UPPER);
    const out = d.elsewhere.map((x) => x.title);
    expect(out).toContain('Catch the drift for lower Saluda trout, stripers');
    expect(out).toContain('Fishing at Saluda Shoals Park');
    expect(d.keep.map((x) => x.title)).toContain('Top Saluda River Fishing Spots in South Carolina');
  });
  it('a river with no other piece sorts nothing out', () => {
    const lone = { own: ['Somewhere'], other: {} };
    expect(R.sortFacts(FX.facts, lone).keep.length).toBe(76);
  });
});

// ── 4. discovery asks for the places ──────────────────────────────────────────────────────────
describe('a river\'s discovery searches each of its places', () => {
  const typed = waterTypeSearch('river', 'fisheries', 'Saluda River', 'SC', [],
    ['Ware Shoals', 'Chappells', 'Saluda River', 'x" OR site:evil.com', 'ware shoals']);
  it('one open-web query per place, after the three it always ran', () => {
    expect(typed.queries.length).toBe(5);
    expect(typed.queries[3]).toBe('"Saluda River" "Ware Shoals" fishing');
    expect(typed.queries[4]).toBe('"Saluda River" "Chappells" fishing');
    expect(typed.pressScoped).toEqual([false, false, true, false, false]);
  });
  it('the Worker holds the caller\'s places to a place\'s shape before quoting them', () => {
    expect(searchablePlaces(['Pelzer', 'Saluda River', 'a"b', 'I-85', 'Pelzer'], 'Saluda River'))
      .toEqual(['Pelzer']);
  });
  it('a lake is unchanged: it runs the state table, as it did', () => {
    expect(waterTypeSearch('lake', 'fisheries', 'Lake Murray', 'SC', [], ['Ballentine'])).toBe(null);
  });
  it('research_lakes.py sends the places, sorts the corpus and the facts, and reports both', () => {
    const py = src('../Scripts/research_lakes.py');
    expect(py.includes('disc_body["places"] = reach["search"]')).toBe(true);
    expect(py.includes('sort_by_reach(repo, reach, documents=keep)')).toBe(true);
    expect(py.includes('sort_by_reach(repo, reach, facts=facts)')).toBe(true);
    expect(py.includes('out["facts_other_reach"]')).toBe(true);
    expect(src('../Worker/research/discover.js').includes('reachPlacesSent')).toBe(true);
  });
});
