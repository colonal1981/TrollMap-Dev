// Personal use only, not for distribution or resale; not for navigation.
//
// EVERY WATER WITH A RESEARCH PROFILE GETS SCDNR, ANGLER'S HEADQUARTERS AND A SEARCH, BY NAME.
//
// Ryan, 2026-10-02: "remember my rule no lake gets something that isn't available to all", then
// "build the general version of both the gauges and the guides... the individual guide reports can
// probably stay but we can do general searches for the other major lakes... i would keep it to the
// ones that have research profiles". The page names and headings below are the live ones of that
// day; the registry rows are the app's own.
//
//   node --test test/every-water-with-a-profile-gets-the-guides.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { nameTokens, rowNames, rowStates, parseAhqIndex, matchAhq, matchScdnr, scdnrTitles,
         pickSearchHits, generalSources, GUIDE_SOURCES } from '../Worker/guide-reports.js';
import { _resetIndexCache } from '../Worker/registry.js';

const AHQ = 'https://www.anglersheadquarters.com';
const PAGES = ['clarks-hill-lake-thurmond', 'lake-greenwood', 'lake-hartwell', 'lake-keowee', 'lake-jocassee',
  'lake-monticello', 'lake-murray', 'lake-russell', 'lake-wateree', 'lake-wylie',
  'santee-cooper-lake-marion-lake-moultrie', 'north-grand-strand', 'south-grand-strand', 'georgetown',
  'charleston', 'edisto-island', 'beaufort', 'hilton-head'];
const TAGS = ['lake-russell', 'lake-murray', 'lake-jocassee', 'lake-wylie', 'clarks-hill', 'santee-cooper',
  'lake-keowee', 'lake-hartwell', 'lake-monticello', 'lake-greenwood', 'lake-wateree', 'charleston',
  'north-grand-strand', 'edisto-island', 'south-grand-strand', 'hilton-head', 'georgetown', 'beaufort'];
const LINKS = [...PAGES.map((p) => `${AHQ}/pages/${p}-fishing-report`), ...TAGS.map((t) => `${AHQ}/blogs/ahq-report/tagged/${t}`)];
const MD = '* Exclusive Content\n* Lake Russell\n* Clarks Hill\n* Santee Cooper\n* Lake Wylie';
const SCDNR = ['Lake Russell', 'Clarks Hill (Lake Thurmond)', 'Lake Wylie', 'Lake Greenwood', 'Lake Monticello',
  'Lake Murray', 'Lake Wateree', 'Santee Cooper', 'Lake Jocassee', 'Lake Keowee', 'Lake Hartwell'];

const ROWS = {
  lake_marion: { name: 'Lake Marion', display_name: 'Lake Marion (Clarendon Co, SC)', state: 'SC', feature_type: 'lake',
    legacy_display_names: ['Lake Marion, SC'] },
  j_strom_thurmond_reservoir: { name: 'J. Strom Thurmond Reservoir', display_name: 'J. Strom Thurmond Reservoir (Lincoln Co, GA/SC)',
    state: 'GA', feature_type: 'lake', legacy_display_names: ['Clark Hill', 'Clarks Hill / Thurmond, GA/SC', 'Lake Thurmond',
      'Murray Creek - Clarks Hill Lake'] },
  richard_b_russell_lake: { name: 'Richard B Russell Lake', display_name: 'Richard B Russell Lake (Abbeville Co, SC/GA)',
    state: 'SC', feature_type: 'lake', legacy_display_names: ['Lake Richard B. Russell', 'Rocky River - Lake Richard B. Russell'] },
  coast_santee_delta_sc: { name: 'Santee River Delta / North Inlet, SC', display_name: 'Santee River Delta / North Inlet, SC (Charleston Co, SC)',
    state: 'SC', feature_type: 'coastal', legacy_display_names: ['North Santee River', 'Mosquito Creek'] },
  coast_charleston_sc: { name: 'Charleston Harbor, SC', display_name: 'Charleston Harbor, SC (Charleston Co, SC)', state: 'SC',
    feature_type: 'coastal', legacy_display_names: ['Stono River', 'Wando River'] },
  lake_lanier: { name: 'Lake Sidney Lanier', display_name: 'Lake Sidney Lanier (Hall Co, GA)', state: 'GA', feature_type: 'lake' },
};
const W = (slug) => {
  const r = ROWS[slug];
  return { names: rowNames(r), primary: [r.name, r.display_name], featureType: r.feature_type, tokens: [...nameTokens(rowNames(r))] };
};
const INDEX = parseAhqIndex(MD, LINKS);

test('AHQ\'s page names carry their tag and title, and say which are lakes', () => {
  const sc = INDEX.find((e) => e.page === 'santee-cooper-lake-marion-lake-moultrie');
  assert.deepEqual([sc.tag, sc.title, sc.lake, sc.tokens], ['santee-cooper', 'Santee Cooper', true, ['santee', 'cooper', 'marion', 'moultrie']]);
  const ch = INDEX.find((e) => e.page === 'charleston');
  assert.deepEqual([ch.tag, ch.lake], ['charleston', false]);
});

test('each water is matched by its own names, and Santee Cooper reaches Marion through AHQ\'s page name', () => {
  const ahq = (slug) => matchAhq(INDEX, W(slug)).hit.map((e) => e.tag);
  const scdnr = (slug) => matchScdnr(SCDNR, matchAhq(INDEX, W(slug)).bridge);
  assert.deepEqual(ahq('lake_marion'), ['santee-cooper']);
  assert.deepEqual(scdnr('lake_marion'), ['Santee Cooper']);
  assert.deepEqual(ahq('j_strom_thurmond_reservoir'), ['clarks-hill']);
  assert.deepEqual(scdnr('j_strom_thurmond_reservoir'), ['Clarks Hill (Lake Thurmond)']);
  assert.deepEqual(ahq('richard_b_russell_lake'), ['lake-russell']);
  assert.deepEqual(scdnr('richard_b_russell_lake'), ['Lake Russell']);
  assert.deepEqual(ahq('coast_charleston_sc'), ['charleston']);
  // "North Santee River" is one of the delta's creeks, not what AHQ's Santee Cooper page is about.
  assert.deepEqual(ahq('coast_santee_delta_sc'), []);
  // "Murray Creek - Clarks Hill Lake" is Thurmond's creek, not Lake Murray.
  assert.ok(!ahq('j_strom_thurmond_reservoir').includes('lake-murray'));
});

test('states come off the display name, so a border lake is in both', () => {
  assert.deepEqual(rowStates(ROWS.j_strom_thurmond_reservoir).sort(), ['GA', 'SC']);
  assert.deepEqual(rowStates(ROWS.lake_lanier), ['GA']);
  assert.deepEqual(scdnrTitles('# x\n### Lake Russell\ntext\n### Santee Cooper\n'), ['Lake Russell', 'Santee Cooper']);
});

test('the search keeps a fishing report on this water from this month or last, and nothing else', () => {
  // The ten hits "Lake Greenwood" fishing report October 2026 returned on 2026-10-02.
  const hits = [
    { title: 'Lake Greenwood Fishing Report Sep 6th, 2026', url: 'https://www.lakegreenwoodfishing.com/lake-greenwood-fishing-report-sep-6th-2026/', date: 'Sep 6, 2026' },
    { title: 'How Summer Thermocline Affects Lake Greenwood Fishing', url: 'https://www.lakegreenwoodfishing.com/x/', date: '6 days ago' },
    { title: 'How to Fish Lake Greenwood: Best Patterns & Techniques', url: 'https://www.omniafishing.com/w/x', date: 'Sep 5, 2026' },
    { title: "Capt. Charlie's Louisiana fishing forecast for September 10", url: 'https://www.facebook.com/x/posts/1/' },
    { title: 'Fishing Reports', url: 'https://www.carolinasportsman.com/field-reports/fishing-reports/', date: 'Sep 11, 2026' },
    { title: 'Goose Creek Reservoir Water Temp Today: 76°F', url: 'https://lakemonster.com/lake/x', date: '6 days ago' },
    { title: 'Lake Greenwood Fishing Report July 2026', url: 'https://www.lakegreenwoodfishing.com/july/', date: 'Jul 2, 2026' },
  ];
  const tokens = nameTokens(['Lake Greenwood']);
  const got = pickSearchHits(hits, tokens, '2026-10-02', Date.parse('2026-10-02T15:00:00Z'), ['facebook.com']);
  assert.deepEqual(got.map((h) => [h.title, h.when]), [['Lake Greenwood Fishing Report Sep 6th, 2026', '2026-09-06']]);
});

const bucket = (rows, profiles) => ({
  async get(key) {
    if (key !== '_registry/lake_index.json') return null;
    const body = JSON.stringify(rows);
    return { text: async () => body };
  },
  async head(key) { return profiles.some((p) => key === `lakes/${p}.json`) ? { key } : null; },
});

test('only a water with a research profile is searched, and the SC sources only for SC water', async () => {
  _resetIndexCache();
  const rows = { lake_marion: ROWS.lake_marion, lake_lanier: ROWS.lake_lanier,
                 some_pond: { name: 'Some Pond', display_name: 'Some Pond (X Co, SC)', state: 'SC', feature_type: 'lake' } };
  const env = { R2_TROLLMAP_CHARTPACKS: bucket(rows, ['lake_marion_sc', 'lake_sidney_lanier_ga', 'lake_lanier_ga']) };
  const m = await generalSources('lake_marion', env);
  assert.deepEqual(m.sources.map((s) => s.kind), ['ahq-any', 'scdnr-any', 'search']);
  assert.equal(m.sources[2].name, 'Lake Marion');
  const l = await generalSources('lake_lanier', env);
  assert.deepEqual(l.sources.map((s) => s.kind), ['search']);
  assert.match(l.why[0], /South Carolina water only/);
  const p = await generalSources('some_pond', env);
  assert.deepEqual(p.sources, []);
  assert.match(p.why[0], /has no research profile/);
  _resetIndexCache();
});

test('the individual guides are the only waters named, and none of them is SCDNR or AHQ', () => {
  for (const [slug, list] of Object.entries(GUIDE_SOURCES)) {
    for (const s of list) assert.ok(!['scdnr', 'ahq'].includes(s.kind), `${slug} lists ${s.kind}`);
  }
});
