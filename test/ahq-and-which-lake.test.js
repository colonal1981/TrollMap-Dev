// Angler's Headquarters' weekly reports, three Octobers back, and which Santee Cooper lake a
// sentence is about.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-01, pasting AHQ's October 19, 2023 Santee Cooper report: "we need notes like
// this", "the difference being that this one calls out upper and lower lake... the new October one
// we found does not". Then "i actually like the idea of the last 3 years", "Reading only" for last
// year's depths, "If place names help lock down which lake why wouldn't we use them?", and "go
// ahead". What these hold:
//   1. a post's date comes off its title, and the listing gives each post's own link;
//   2. the first post after the month is read, the last one inside it when that one fails, and
//      a members-only page says so rather than reading as empty;
//   3. one month's entries come off a post verbatim, dated with the year, newest first;
//   4. the three years are read once and kept, and a second plan reads them from KV;
//   5. last years' reports are reading: they mark no lane;
//   6. on Marion and Moultrie a depth of water counts only on the lake its sentence is about --
//      by name, upper/lower lake, or a place on only one chart -- and one naming neither counts on
//      neither; other lakes are untouched;
//   7. the place names come off both charts in the browser, and the prompt says the rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ahqTitleDate, parseAhqListing, pickAhqPosts, parseAhqEntries, GUIDE_SOURCES }
  from '../Worker/guide-reports.js';
import { santeeLakesIn, reportWaterFor, reportWaterForPlan, placeNamesIn, namesOnlyOn, SANTEE_LAKES }
  from '../js/utils/report-water.js';
import { santeePlaces, askGuideReports, guideReportsBlock, reportWaterForLanes } from '../js/modules/guide-reports.js';

const BASE = 'https://www.anglersheadquarters.com';
const h4 = (slug, title) => `<h4 class="title"> <a class="featured-article--link" href="/blogs/ahq-report/${slug}">${title}</a></h4>`;
const LISTING = [
  h4('ahq-insider-santee-cooper-sc-2025-week-45-fishing-report-updated-november-6', 'AHQ INSIDER Santee Cooper (SC) 2025 Week 45 Fishing Report &#8211; Updated November 6'),
  h4('ahq-insider-santee-cooper-sc-2025-week-44-fishing-report-updated-october-30', 'AHQ INSIDER Santee Cooper (SC) 2025 Week 44 Fishing Report – Updated October 30'),
  h4('10-28-catch-of-the-day-santee-crappie', '10/28 Catch of the Day - Santee Crappie'),
  h4('ahq-insider-lake-murray-sc-2025-week-45-fishing-report-updated-november-5', 'AHQ INSIDER Lake Murray (SC) 2025 Week 45 Fishing Report – Updated November 5'),
  h4('ahq-insider-santee-cooper-sc-2024-week-45-fishing-report-updated-november-7', 'AHQ INSIDER Santee Cooper (SC) 2024 Week 45 Fishing Report – Updated November 7'),
  h4('ahq-insider-santee-cooper-sc-2024-week-43-fishing-report-updated-october-24', 'AHQ INSIDER Santee Cooper (SC) 2024 Week 43 Fishing Report – Updated October 24'),
  h4('ahq-insider-santee-cooper-sc-2023-week-44-fishing-report-updated-november-2', 'AHQ INSIDER Santee Cooper (SC) 2023 Week 44 Fishing Report – Updated November 2'),
].join('');
const post = (dates) => [
  '# AHQ INSIDER Santee Cooper (SC) Fishing Report', '', '* by Jay', '',
  ...dates.flatMap(([d, body]) => [d, '', body, '']),
  'We use cookies on our website to give you the best shopping experience.', '', 'October 1', 'footer text',
].join('\n');
const NOV6_2025 = post([
  ['November 6', 'Striped bass are schooling. In the lower lake they are on humps in 30-50 feet of water.'],
  ['October 30', 'For now Bobby is catching fish drifting lower lake humps in 30-50 feet of water.\n\nIn the upper lake fish are in the main river channel, and stripers hold on hills in 25-35 feet of water.'],
  ['October 16', 'Striped bass season is open again, and Captain Bobby will look around the Hatchery and in the Bonneau area.'],
  ['September 25', 'Catfish are on hills in 25-35 feet of water.'],
]);
const MEMBERS = "**Uh oh! It doesn't look like you have access to this fishing report ... yet!**";

test('a post\'s date comes off its title, and the listing gives each post its own link', () => {
  assert.equal(ahqTitleDate('AHQ INSIDER Santee Cooper (SC) 2025 Week 47 Fishing Report – Updated November 19'), '2025-11-19');
  assert.equal(ahqTitleDate('AHQ INSIDER Santee Cooper (SC) Winter 2017/18 Fishing Report – Updated January 18'), '2018-01-18');
  assert.equal(ahqTitleDate('AHQ INSIDER Santee Cooper (SC) Winter 2017/18 Fishing Report – Updated December 15'), '2017-12-15');
  assert.equal(ahqTitleDate('10/28 Catch of the Day - Santee Crappie'), null);
  const posts = parseAhqListing(LISTING);
  assert.equal(posts.length, 7);
  assert.equal(posts[0].title, 'AHQ INSIDER Santee Cooper (SC) 2025 Week 45 Fishing Report – Updated November 6');
  assert.equal(posts[0].url, `${BASE}/blogs/ahq-report/ahq-insider-santee-cooper-sc-2025-week-45-fishing-report-updated-november-6`);
  assert.equal(posts[0].date, '2025-11-06');
});

test('the first post after the month first, the last one inside it second, and only this lake\'s', () => {
  const posts = parseAhqListing(LISTING);
  assert.deepEqual(pickAhqPosts(posts, 'Santee Cooper', 2025, 9).map((p) => p.date), ['2025-11-06', '2025-10-30']);
  assert.deepEqual(pickAhqPosts(posts, 'Santee Cooper', 2023, 9).map((p) => p.date), ['2023-11-02']);
  assert.deepEqual(pickAhqPosts(posts, 'Lake Murray', 2025, 9).map((p) => p.date), ['2025-11-05']);
  assert.deepEqual(pickAhqPosts(posts, 'Lake Wateree', 2025, 9), []);
});

test('one month\'s entries, verbatim, dated with the year, newest first, and nothing after the footer', () => {
  const e = parseAhqEntries(NOV6_2025, 2025, 9);
  assert.deepEqual(e.dates, ['2025-10-30', '2025-10-16']);
  assert.match(e.text, /^October 30, 2025\nFor now Bobby is catching fish drifting lower lake humps in 30-50 feet of water\.\n\nIn the upper lake/);
  assert.match(e.text, /\n\nOctober 16, 2025\nStriped bass season is open again/);
  assert.doesNotMatch(e.text, /November|September|footer/);
  assert.equal(parseAhqEntries(NOV6_2025, 2025, 0), null);
});

function ahqEnv(pages) {
  const calls = [];
  const store = new Map();
  const env = { TINYFISH_API_KEY: 'k', KV: { get: async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null),
                                             put: async (k, v) => store.set(k, v) } };
  const fetchMock = async (u, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.urls);
    return Response.json({ results: body.urls.filter((x) => pages[x] != null).map((x) => ({ url: x, final_url: x, text: pages[x] })), errors: [] });
  };
  return { env, store, calls, fetchMock };
}

test('three Octobers back, kept for good, and a members-only page says so and falls back', async () => {
  const tag = `${BASE}/blogs/ahq-report/tagged/santee-cooper?page=`;
  const url = (slug) => `${BASE}/blogs/ahq-report/${slug}`;
  const pages = {
    [`${tag}1`]: LISTING,
    [url('ahq-insider-santee-cooper-sc-2025-week-45-fishing-report-updated-november-6')]: NOV6_2025,
    [url('ahq-insider-santee-cooper-sc-2024-week-45-fishing-report-updated-november-7')]: MEMBERS,
    [url('ahq-insider-santee-cooper-sc-2024-week-43-fishing-report-updated-october-24')]: post([['October 24', 'Stripers are on the Hatchery humps.']]),
    [url('ahq-insider-santee-cooper-sc-2023-week-44-fishing-report-updated-november-2')]: post([['October 19', 'Captain Bobby Winters is drifting lower lake humps in 30-50 feet of water.']]),
  };
  const { env, store, calls, fetchMock } = ahqEnv(pages);
  const real = globalThis.fetch;
  globalThis.fetch = fetchMock;
  try {
    const src = GUIDE_SOURCES.lake_marion.find((s) => s.kind === 'ahq');
    assert.equal(src.url, `${BASE}/blogs/ahq-report/tagged/santee-cooper`);
    const { gatherGuideReports } = await import('../Worker/guide-reports.js');
    // Only the AHQ source, so the other sources' failures do not muddy the call count.
    const saved = GUIDE_SOURCES.lake_marion;
    GUIDE_SOURCES.lake_marion = [src];
    try {
      const g = await gatherGuideReports('lake_marion', env, '2026-10-02');
      assert.deepEqual(g.reports.map((r) => r.label), [
        "Angler's Headquarters weekly report -- Santee Cooper, October 2025",
        "Angler's Headquarters weekly report -- Santee Cooper, October 2024",
        "Angler's Headquarters weekly report -- Santee Cooper, October 2023"]);
      assert.deepEqual(g.reports.map((r) => r.published), ['2025-10-30', '2024-10-24', '2023-10-19']);
      assert.ok(g.reports.every((r) => r.role === 'same month, an earlier year'));
      assert.equal(g.checked[0].ok, true);
      assert.equal(g.checked[0].why, undefined);
      // Listing, best posts, then the one fallback (2024's members-only page) -- three calls.
      assert.equal(calls.length, 3);
      assert.equal(calls[0].length, 10);
      assert.deepEqual(calls[2], [url('ahq-insider-santee-cooper-sc-2024-week-43-fishing-report-updated-october-24')]);
      assert.equal(store.get('guide:ahq:v1:santee-cooper:2024-10') != null, true);
      // A second plan reads all three from KV.
      const again = await gatherGuideReports('lake_marion', env, '2026-10-20');
      assert.equal(again.reports.length, 3);
      assert.equal(calls.length, 3);
      // Reading only: none of it is this month's, so none of it marks a lane.
      assert.deepEqual(reportWaterForPlan(g.reports, 'Striped Bass', '2026-10-02'), []);
    } finally {
      GUIDE_SOURCES.lake_marion = saved;
    }
  } finally {
    globalThis.fetch = real;
  }
});

test('a year that cannot be found is said, and the others still come', async () => {
  const pages = { [`${BASE}/blogs/ahq-report/tagged/santee-cooper?page=1`]: LISTING,
    [`${BASE}/blogs/ahq-report/ahq-insider-santee-cooper-sc-2025-week-45-fishing-report-updated-november-6`]: NOV6_2025 };
  const { env, fetchMock } = ahqEnv(pages);
  const real = globalThis.fetch;
  globalThis.fetch = fetchMock;
  const saved = GUIDE_SOURCES.lake_moultrie;
  try {
    GUIDE_SOURCES.lake_moultrie = [saved.find((s) => s.kind === 'ahq')];
    const { gatherGuideReports } = await import('../Worker/guide-reports.js');
    const g = await gatherGuideReports('lake_moultrie', env, '2026-10-02');
    assert.equal(g.reports.length, 1);
    assert.match(g.checked[0].why, /^not found: 2024: .*not fetched.*; 2023: .*not fetched/);
  } finally {
    GUIDE_SOURCES.lake_moultrie = saved;
    globalThis.fetch = real;
  }
});

const PLACES = { lake_marion: ['Jacks Creek', "Pack's Landing", 'Taw Caw Creek'],
                 lake_moultrie: ['Bonneau', 'Cross', 'Hatchery', 'Pinopolis'] };

test('which lake a sentence is about: by name, by upper or lower lake, or by a place on one chart', () => {
  const lakes = (s) => [...santeeLakesIn(s, PLACES)];
  assert.deepEqual(lakes('In the upper lake fish are still in the main river channel.'), ['lake_marion']);
  assert.deepEqual(lakes('drifting lower lake humps in 30-50 feet of water'), ['lake_moultrie']);
  assert.deepEqual(lakes('In lower Lake Marion they are in 20 feet of water.'), ['lake_marion']);
  assert.deepEqual(lakes('around the Hatchery and in the Bonneau area'), ['lake_moultrie']);
  assert.deepEqual(lakes("Fish are biting near Pack's Landing."), ['lake_marion']);
  // A one-word name counts only where it is not the first word: "Cross" is also a verb.
  assert.deepEqual(lakes('Cross over to the dam.'), []);
  assert.deepEqual(lakes('Fish near Cross in 30 feet of water.'), ['lake_moultrie']);
  assert.deepEqual(lakes('near the Francis Marion forest'), []);
  assert.deepEqual(lakes('levels are 72.85 in Lake Marion and 72.83 in Lake Moultrie').sort(), SANTEE_LAKES);
  assert.deepEqual(lakes('Striper season opens October 1st, and anglers should start looking for fish in 30–45 feet of water along flats and creek areas.'), []);
});

const AHQ_LIKE = `October 19, 2023
For now Bobby is still catching most of his stripers drifting lower lake humps in 30-50 feet of water, mostly fishing the middle of the water column. Some days the stripers are deeper over points in 40 feet of water.

In the upper lake stripers are still in the main river channel. Look for stripers on hills in 25-35 feet of water there.

STRIPERS
Striper season opens October 1st, and anglers should start looking for fish in 30–45 feet of water along flats and creek areas.`;

test('a depth counts on the lake its sentence is about, its paragraph carries it, and one naming neither counts on neither', () => {
  const on = (slug) => reportWaterFor(AHQ_LIKE, 'Striped Bass', { slug, places: PLACES });
  assert.deepEqual(on('lake_moultrie').map((w) => [w.ft, w.lakeFrom]),
    [[[30, 50], 'the sentence'], [[40, 40], 'its paragraph']]);
  assert.deepEqual(on('lake_marion').map((w) => [w.ft, w.lakeFrom]), [[[25, 35], 'its paragraph']]);
  // Any other lake reads every depth, as before.
  assert.deepEqual(reportWaterFor(AHQ_LIKE, 'Striped Bass', { slug: 'lake_murray' }).map((w) => w.ft),
    [[30, 50], [40, 40], [25, 35], [30, 45]]);
  assert.equal(reportWaterFor(AHQ_LIKE, 'Striped Bass')[0].lake, undefined);
  // SCDNR's paragraph label carries its lake.
  const scdnr = 'Upper Lake Marion: At the top of the upper lake the striped bass are in 12-15 feet of water.';
  assert.deepEqual(reportWaterFor(scdnr, 'Striped Bass', { slug: 'lake_marion', places: null }).map((w) => w.ft), [[12, 15]]);
  assert.deepEqual(reportWaterFor(scdnr, 'Striped Bass', { slug: 'lake_moultrie', places: null }), []);
});

test('the place names come off both charts, each lake keeping only its own', async () => {
  const fc = (rows) => ({ features: rows.map(([name, poi_type]) => ({ properties: { name, poi_type } })) });
  const packs = {
    'lake_marion/pois.geojson': fc([['Jacks Creek', 'place_name'], ['Spiers', 'place_name'], ['Rocks, Spar/Spindle Buoy', 'nav_buoy'], ['"23"', 'road_shield'], ['Fuel', 'fuel_dock']]),
    'lake_marion/water_features.geojson': { features: [{ properties: { name: 'Taw Caw Creek', kind: 'creek_mouth' } }] },
    'lake_marion/launches.json': { landings: [{ name: "Pack's Landing" }, { name: 'Santee State Park Boat Ramp #2' }] },
    'lake_moultrie/pois.geojson': fc([['Bonneau', 'place_name'], ['Spiers', 'place_name'], ['Cross', 'place_name']]),
    'lake_moultrie/water_features.geojson': { features: [] },
    'lake_moultrie/launches.json': { landings: [{ name: 'Hatchery' }] },
  };
  const fetchImpl = async (u) => {
    const k = String(u).replace('https://w/chartpacks/', '');
    return packs[k] ? { ok: true, json: async () => packs[k] } : { ok: false, status: 404 };
  };
  const p = await santeePlaces({ worker: 'https://w', fetchImpl });
  assert.deepEqual(p, { lake_marion: ['Jacks Creek', "Pack's Landing", 'Taw Caw Creek'],
                        lake_moultrie: ['Bonneau', 'Cross', 'Hatchery'] });
  assert.equal(await santeePlaces({ worker: 'https://w', fetchImpl: async () => ({ ok: false }) }), null);
  assert.deepEqual([...placeNamesIn({})], []);
  assert.deepEqual(namesOnlyOn(new Set(['A b c']), new Set(['A b c'])), { lake_marion: [], lake_moultrie: [] });

  // And askGuideReports brings them with the reports on Marion and Moultrie, and only there.
  const report = { label: 'AHQ', guides: 'G', published: '2026-10-01', text: AHQ_LIKE };
  const withWorker = async (u) => (String(u).includes('/guide-reports/')
    ? { ok: true, json: async () => ({ slug: 'lake_moultrie', reports: [report], checked: [] }) } : fetchImpl(u));
  const g = await askGuideReports({ worker: 'https://w', slug: 'lake_moultrie', date: '2026-10-02', fetchImpl: withWorker });
  assert.deepEqual(g.places.lake_moultrie, ['Bonneau', 'Cross', 'Hatchery']);
  const murray = await askGuideReports({ worker: 'https://w', slug: 'lake_murray', date: '2026-10-02', fetchImpl: withWorker });
  assert.equal(murray.places, undefined);
  assert.deepEqual(reportWaterForLanes(g, 'Striped Bass', '2026-10-02').map((w) => w.chartFt), [[30, 50], [40, 40]]);
  const block = guideReportsBlock(g, ['Striped Bass'], '2026-10-02');
  assert.match(block, /On Marion and Moultrie a depth of water counts for the lanes only from a sentence that says which lake/);
  assert.match(block, /may be Marion's water/);
  assert.match(block, /- Striped Bass: 30-50 ft of water on Moultrie \(said in the sentence\)/);
  assert.match(block, /"same month, an earlier year" is history/);
  assert.doesNotMatch(block, /30-45 ft of water on/);
});
