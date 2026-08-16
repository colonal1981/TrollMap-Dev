// The four fishing-report sources, parsed and matched to water this app ships.
//
// WHAT IS REAL HERE, EXACTLY.
//
// Every title, link, pubDate, TWRA heading, AHQ hub path and registry name below was read off
// the live source or the live registry on 2026-08-16 and is reproduced character for character
// -- including which of TWRA's dashes are en dashes and which are hyphens, which is the whole
// reason that parser has the shape it has.
//
// What is NOT byte-real: the <rss><channel> envelope around the feed items, the prose between
// the TWRA headings, and the HTML scaffolding around the AHQ links. This sandbox reaches those
// hosts only through a fetcher that converts pages to markdown, so raw bytes cannot be captured
// here. The scaffolding is minimal and marked. The VALUES are the thing being pinned, and every
// one of those is real -- a made-up fixture pins nothing.
//
// Registry names come from registry/lake_index.json: `name`, `display_name` and every entry of
// `legacy_display_names`, which is exactly what fetchReports() is given at runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRss, parseTwra, parseAhqHub, parseAhqPage, articleText,
  namesWater, matchWaterName, pickAhqEntry, rssScanPlan, shapeReports,
  ARTICLE_SCAN_LIMIT,
} from '../Worker/reports.js';

// ── registry names, verbatim ────────────────────────────────────────────────────────────────
const JUNALUSKA   = ['Lake Junaluska', 'Lake Junaluska (Haywood Co, NC)', 'Lake Junaluska, NC'];
const MARION      = ['Lake Marion', 'Lake Marion (Clarendon Co, SC)', 'Lake Marion, SC'];
const CHARLESTON  = ['Charleston Harbor, SC', 'Charleston Harbor, SC (Charleston Co, SC)'];
const ACE_BASIN   = ['ACE Basin / Edisto, SC', 'ACE Basin / Edisto, SC (Colleton Co, SC)'];
const WATEREE_LK  = ['Wateree Lake', 'Wateree Lake (Kershaw Co, SC)', 'Wateree Lake, SC', 'Lake Wateree, SC'];
const WATEREE_RIV = ['Wateree River', 'Wateree River (Richland Co, SC)', 'Wateree River, SC'];
const NORRIS      = ['Norris Lake', 'Norris Lake (Union Co, TN)', 'Norris Lake, TN'];
const FT_LOUDOUN  = ['Fort Loudoun Lake', 'Fort Loudoun Lake (Knox Co, TN)', 'Fort Loudoun Lake, TN'];
const HARTWELL    = ['Hartwell Lake', 'Hartwell Lake (Anderson Co, SC/GA)', 'Hartwell Lake, SC/GA', 'Lake Hartwell, SC/GA'];

// ── GA feed: 10 real items. Titles, links and pubDates verbatim, 2026-08-16. ─────────────────
const GA_ITEMS = [
  ['Georgia Fishing Report: August 14, 2026', 'https://georgiawildlife.blog/2026/08/14/georgia-fishing-report-august-14-2026/', 'Fri, 14 Aug 2026 16:20:52 +0000'],
  ['Georgia Fishing Report: August 6, 2026',  'https://georgiawildlife.blog/2026/08/07/georgia-fishing-report-august-6-2026/',  'Fri, 07 Aug 2026 19:00:31 +0000'],
  ['Georgia Fishing Report: July 31, 2026',   'https://georgiawildlife.blog/2026/07/31/georgia-fishing-report-july-31-2026/',   'Fri, 31 Jul 2026 15:58:17 +0000'],
  ['Georgia Fishing Report: July 24, 2026',   'https://georgiawildlife.blog/2026/07/24/georgia-fishing-report-july-24-2026/',   'Fri, 24 Jul 2026 14:19:51 +0000'],
  ['Georgia Fishing Report: July 17, 2026',   'https://georgiawildlife.blog/2026/07/17/georgia-fishing-report-july-17-2026/',   'Fri, 17 Jul 2026 18:46:26 +0000'],
  ['Georgia Fishing Report: July 10, 2026',   'https://georgiawildlife.blog/2026/07/10/georgia-fishing-report-july-10-2026/',   'Fri, 10 Jul 2026 18:27:36 +0000'],
  ['Georgia Fishing Report: June 26, 2026',   'https://georgiawildlife.blog/2026/06/26/georgia-fishing-report-june-26-2026/',   'Fri, 26 Jun 2026 16:57:45 +0000'],
  ['Georgia Fishing Report: June 12, 2026',   'https://georgiawildlife.blog/2026/06/12/georgia-fishing-report-june-12-2026/',   'Fri, 12 Jun 2026 17:56:46 +0000'],
  ['Georgia Fishing Report: June 5, 2026',    'https://georgiawildlife.blog/2026/06/05/georgia-fishing-report-june-5-2026/',    'Fri, 05 Jun 2026 15:47:21 +0000'],
  ['Georgia Fishing Report: May 29, 2026',    'https://georgiawildlife.blog/2026/05/29/georgia-fishing-report-may-29-2026/',    'Fri, 29 May 2026 18:50:40 +0000'],
];

// The real excerpt on the newest item. Verbatim, and it names no water -- which is the point.
const GA_NEWEST_EXCERPT = 'Starting this week, the Georgia Fishing Report will highlight one region of the state each week (North, Central, Southeast or Southwest)';

const GA_FEED = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Georgia Wildlife Blog</title>
${GA_ITEMS.map(([t, l, p], i) => `<item><title>${t}</title><link>${l}</link><pubDate>${p}</pubDate>` +
  `<description><![CDATA[<p>${i === 0 ? GA_NEWEST_EXCERPT : 'Weekly fishing report from Georgia DNR.'}</p>]]></description></item>`).join('\n')}
</channel></rss>`;

// ── NC feed: 10 real items. ─────────────────────────────────────────────────────────────────
const NC_RAW = [
  ["Zach Neill&#8217;s Lake Junaluska largemouth", 'https://www.carolinasportsman.com/field-reports/fishing-reports/bass/zach-neills-lake-junaluska-largemouth/', 'Sat, 08 Aug 2026 21:03:19 +0000'],
  ["Brantley Hawkins&#8217; Wilson County bass",   'https://www.carolinasportsman.com/field-reports/fishing-reports/bass/brantley-hawkins-wilson-county-bass/', 'Wed, 05 Aug 2026 19:42:36 +0000'],
  ["John Simmons&#8217;s big bass",                'https://www.carolinasportsman.com/field-reports/fishing-reports/bass/john-simmonss-big-bass/', 'Wed, 05 Aug 2026 16:35:12 +0000'],
  ['August fishing report for southeastern North Carolina', 'https://www.carolinasportsman.com/fishing/inshore-fishing/sheepshead/august-fishing-report-for-southeastern-north-carolina/', 'Sun, 02 Aug 2026 17:50:11 +0000'],
  ['The River',                                    'https://www.carolinasportsman.com/field-reports/fishing-reports/freshwater/the-river/', 'Sun, 02 Aug 2026 17:34:19 +0000'],
  ['Little girls, big fish',                       'https://www.carolinasportsman.com/field-reports/fishing-reports/freshwater/little-girls-big-fish/', 'Tue, 21 Jul 2026 04:26:28 +0000'],
  ['Santee Cooper July fishing report',            'https://www.carolinasportsman.com/field-reports/fishing-reports/freshwater/santee-cooper-july-fishing-report/', 'Tue, 14 Jul 2026 19:50:26 +0000'],
  ['Kat catching Catfish',                         'https://www.carolinasportsman.com/field-reports/fishing-reports/freshwater/kat-catching-catfish/', 'Sun, 12 Jul 2026 19:33:54 +0000'],
  ['Florence angler catches new SC state record flathead', 'https://www.carolinasportsman.com/fishing/freshwater-fishing/catfish/florence-angler-catches-new-sc-state-record-flathead/', 'Fri, 12 Jun 2026 20:03:10 +0000'],
  ['FREE RANGER weighs in 597.4-pound blue marlin at Big Rock', 'https://www.carolinasportsman.com/field-reports/fishing-reports/offshore/free-ranger-weighs-in-597-4-pound-blue-marlin-at-big-rock/', 'Wed, 10 Jun 2026 20:00:54 +0000'],
];
const NC_FEED = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Carolina Sportsman</title>
${NC_RAW.map(([t, l, p]) => `<item><title>${t}</title><link>${l}</link><pubDate>${p}</pubDate><description><![CDATA[Field report.]]></description></item>`).join('\n')}
</channel></rss>`;

// ── TWRA: all 13 headings, verbatim, dashes exactly as published. ────────────────────────────
// Seven en dash, six hyphen. Cordell Hull is rendered here as the numeric entity it arrives as
// on the wire, because decoding it AFTER the blanket &#\d+; rule deletes the separator and the
// entry with it.
const TWRA_HEADINGS = [
  'Center Hill – 4/29/26',
  'Cordell Hull &#8211; 5/27/26',
  'Fall Creek Falls – 5/1/26',
  'Fort Loudoun Reservoir – 5/13/26',
  'Kentucky Lake - 5/20/26',
  'Melton Hill Reservoir – 5/13/26',
  'Nickajack - 5/21/26',
  'Normandy - 5/26/26',
  'Norris Tailwater – 5/4/26',
  'Old Hickory - 4/20/26',
  'Percy Priest - 4/20/26',
  'Reelfoot Lake - 5/27/26',
  'Watts Bar Reservoir – 5/17/26',
];
// Prose between the headings is a stand-in, NOT the real page text -- but it is shaped like the
// real page: sentences that end in a capitalised proper noun, which is what made the original
// unanchored parser produce a lake called "Crappie moving deeper. Cordell Hull".
const TWRA_PAGE = `<html><body><div class="content">
${TWRA_HEADINGS.map((h) => `<h3>${h}</h3><p>Bass fishing has been fair on main lake points. Anglers report Crappie moving deeper near Big Sandy.</p>`).join('\n')}
</div></body></html>`;

// ── AHQ hub: all 18 real paths, 2026-08-16. ─────────────────────────────────────────────────
const AHQ_PATHS = [
  'clarks-hill-lake-thurmond', 'lake-greenwood', 'lake-hartwell', 'lake-keowee', 'lake-jocassee',
  'lake-monticello', 'lake-murray', 'lake-russell', 'lake-wateree', 'lake-wylie',
  'santee-cooper-lake-marion-lake-moultrie', 'north-grand-strand', 'south-grand-strand',
  'georgetown', 'charleston', 'edisto', 'beaufort', 'hilton-head',
];
const AHQ_HUB_HTML = `<html><body><nav>${AHQ_PATHS
  .map((s) => `<a href="/pages/${s}-fishing-report">${s.replace(/-/g, ' ')}</a>`).join('')}</nav></body></html>`;

// Real sentence from the live Lake Wateree page, 2026-08-16.
const AHQ_PAGE = `<html><body><nav><a href="/">Home</a></nav><article><h1>Lake Wateree Fishing Report</h1>
<p>Lake Wateree is up to 97.9% of full pool. Morning surface water temperatures are in the mid-80s.</p></article></body></html>`;

// Real: the eight waters the 2026-08-14 Georgia post actually covers.
const GA_ARTICLE = `<html><body><nav><a href="/">Blog</a></nav><article class="entry-content">
<p>Lake Allatoona, Lake Lanier, Lake Hartwell, West Point Lake, Weiss Lake, Rocky Mountain
Public Fishing Area, Unicoi Lake and Moccasin Creek.</p></article>
<aside>Recent posts: Lake Junaluska, Lake Marion</aside></body></html>`;

// ── parsers ─────────────────────────────────────────────────────────────────────────────────

test('RSS: every item is found and the real pubDate becomes an ISO instant', () => {
  const ga = parseRss(GA_FEED);
  assert.equal(ga.length, 10);
  assert.equal(ga[0].title, 'Georgia Fishing Report: August 14, 2026');
  assert.equal(ga[0].link, 'https://georgiawildlife.blog/2026/08/14/georgia-fishing-report-august-14-2026/');
  assert.equal(ga[0].published_raw, 'Fri, 14 Aug 2026 16:20:52 +0000');
  assert.equal(ga[0].published, '2026-08-14T16:20:52.000Z');
  assert.equal(parseRss(NC_FEED).length, 10);
});

test('RSS: CDATA is unwrapped and the description is stripped of markup', () => {
  const ga = parseRss(GA_FEED);
  assert.ok(!ga[0].description.includes('CDATA'));
  assert.ok(!ga[0].description.includes('<p>'));
  assert.ok(ga[0].description.startsWith('Starting this week'));
});

test('TWRA: all thirteen entries survive BOTH dash forms and the entity form', () => {
  const rows = parseTwra(TWRA_PAGE);
  assert.equal(rows.length, 13);
  const names = rows.map((r) => r.water);
  assert.deepEqual(names, [
    'Center Hill', 'Cordell Hull', 'Fall Creek Falls', 'Fort Loudoun Reservoir', 'Kentucky Lake',
    'Melton Hill Reservoir', 'Nickajack', 'Normandy', 'Norris Tailwater', 'Old Hickory',
    'Percy Priest', 'Reelfoot Lake', 'Watts Bar Reservoir',
  ]);
  // Six of the thirteen publish a plain hyphen. Matching only the en dash loses all six.
  assert.equal(rows.filter((r) => ['Kentucky Lake', 'Nickajack', 'Normandy', 'Old Hickory',
    'Percy Priest', 'Reelfoot Lake'].includes(r.water)).length, 6);
  // Cordell Hull arrives as &#8211; and must not be eaten by the numeric-entity rule.
  assert.equal(rows.find((r) => r.water === 'Cordell Hull').published_raw, '5/27/26');
});

test('TWRA: the name capture does not walk backward into the previous entry', () => {
  // The bug this pins, verbatim from the unanchored version: "Crappie moving deeper. Cordell
  // Hull" and "Big Sandy. Norris Tailwater". Big Sandy is a real Kentucky Lake embayment, so
  // that was a false attachment one registry entry away from happening.
  for (const r of parseTwra(TWRA_PAGE)) {
    assert.ok(!/Crappie|Sandy|Anglers|Bass/.test(r.water), `leaked prose into name: ${r.water}`);
  }
});

test('TWRA: a date is read off the page, never derived', () => {
  const cordell = parseTwra(TWRA_PAGE).find((r) => r.water === 'Cordell Hull');
  assert.equal(cordell.published, '2026-05-27T00:00:00.000Z');
  assert.equal(cordell.published_raw, '5/27/26');
});

test('AHQ hub: all eighteen waters the page lists are found', () => {
  const entries = parseAhqHub(AHQ_HUB_HTML);
  assert.equal(entries.length, 18);
  assert.ok(entries.some((e) => e.slug === 'santee-cooper-lake-marion-lake-moultrie'));
  assert.equal(entries.find((e) => e.slug === 'lake-wateree').url,
    'https://www.anglersheadquarters.com/pages/lake-wateree-fishing-report');
});

test('AHQ page: the report text is lifted and the nav is not', () => {
  const t = parseAhqPage(AHQ_PAGE);
  assert.ok(t.includes('Morning surface water temperatures are in the mid-80s'));
  assert.ok(!t.includes('Home'));
});

test('articleText: the article is kept and the sidebar is not', () => {
  const t = articleText(GA_ARTICLE);
  assert.ok(t.includes('Lake Hartwell'));
  // The sidebar names Junaluska and Marion. Including it would match both to a Georgia post.
  assert.ok(!t.includes('Junaluska'), 'sidebar leaked into the article text');
});

// ── name matching ───────────────────────────────────────────────────────────────────────────

test('a headline naming the water matches it, and only it', () => {
  const title = "Zach Neill's Lake Junaluska largemouth";
  assert.equal(namesWater(title, JUNALUSKA), 'Lake Junaluska');
  assert.equal(namesWater(title, MARION), null);
  assert.equal(namesWater(title, HARTWELL), null);
});

test('a county is not a lake -- the real headline, and the real link it arrives on', () => {
  // "Brantley Hawkins' Wilson County bass", Carolina Sportsman, 2026-08-05. Twenty-one of the
  // 156 county names in the index are also the whole distinctive name of a water it ships.
  const asMarion = 'Brantley Hawkins&#8217; Marion County bass';
  assert.equal(namesWater(asMarion, MARION), null);
  // and the same story in link form, where the separator is a hyphen
  assert.equal(namesWater('https://www.carolinasportsman.com/x/brantley-hawkins-marion-county-bass/', MARION), null);
  // but a post that names the lake AND the county still matches
  assert.equal(namesWater('Lake Marion in Marion County is producing', MARION), 'Lake Marion');
});

test('the whole NC feed against three shipped waters yields exactly one match', () => {
  const shaped = shapeReports({ rssByState: { NC: NC_FEED } }, [...JUNALUSKA, ...MARION, ...HARTWELL], 'NC');
  assert.equal(shaped.items.length, 1);
  assert.equal(shaped.items[0].matched, 'Lake Junaluska');
  assert.equal(shaped.items[0].matched_in, 'excerpt');
});

test('name against name: the registry is longer than the source, and that is fine', () => {
  // AHQ says "charleston"; the registry says "Charleston Harbor, SC". One-way matching loses
  // all five SC coastal reports.
  assert.equal(matchWaterName('charleston', CHARLESTON), 'Charleston Harbor, SC');
  assert.equal(matchWaterName('edisto', ACE_BASIN), 'ACE Basin / Edisto, SC');
});

test('name against name: a river is not the lake, and a tailwater is not the pool', () => {
  assert.equal(matchWaterName('lake wateree', WATEREE_LK), 'Wateree Lake');
  assert.equal(matchWaterName('lake wateree', WATEREE_RIV), null);
  // TWRA publishes "Norris Tailwater". That is the Clinch below the dam.
  assert.equal(matchWaterName('Norris Tailwater', NORRIS), null);
  assert.equal(matchWaterName('Fort Loudoun Reservoir', FT_LOUDOUN), 'Fort Loudoun Lake');
});

test('AHQ: each water resolves to its own entry', () => {
  const entries = parseAhqHub(AHQ_HUB_HTML);
  assert.equal(pickAhqEntry(entries, MARION).entry.slug, 'santee-cooper-lake-marion-lake-moultrie');
  assert.equal(pickAhqEntry(entries, HARTWELL).entry.slug, 'lake-hartwell');
  assert.equal(pickAhqEntry(entries, CHARLESTON).entry.slug, 'charleston');
  assert.equal(pickAhqEntry(entries, WATEREE_LK).entry.slug, 'lake-wateree');
  // The river shares the name and is not the water AHQ is reporting on.
  assert.equal(pickAhqEntry(entries, WATEREE_RIV), null);
});

test('AHQ: best overlap wins, not first past the post', () => {
  // CONSTRUCTED, and deliberately so: on the live SC hub today no water matches two entries, so
  // first-past-the-post would pass every test above and break the first time AHQ adds a page.
  // That bug has already been fixed twice in this repo in one week -- the binder and consolidate.
  const entries = [
    { slug: 'lake-marion', url: 'u1', name: 'lake marion' },
    { slug: 'santee-cooper-lake-marion-lake-moultrie', url: 'u2', name: 'santee cooper lake marion lake moultrie' },
  ];
  const santee = ['Santee Cooper Lake Marion Lake Moultrie'];
  assert.equal(pickAhqEntry(entries, santee).entry.slug, 'santee-cooper-lake-marion-lake-moultrie');
  assert.equal(pickAhqEntry(entries.slice().reverse(), santee).entry.slug, 'santee-cooper-lake-marion-lake-moultrie');
});

// ── the assembled shape ─────────────────────────────────────────────────────────────────────

test('Georgia matches nothing from the feed alone, and everything once the post is read', () => {
  // The excerpt on the newest GA item names no water. This is not a fixture choice; it is what
  // the feed says. A module that stopped at the feed would return nothing for Georgia forever.
  const names = HARTWELL;
  const feedOnly = shapeReports({ rssByState: { GA: GA_FEED } }, names, 'GA');
  assert.equal(feedOnly.items.length, 0);
  assert.equal(feedOnly.none_found, true);

  const link = 'https://georgiawildlife.blog/2026/08/14/georgia-fishing-report-august-14-2026/';
  const withPost = shapeReports(
    { rssByState: { GA: GA_FEED }, articlesByLink: { [link]: articleText(GA_ARTICLE) } }, names, 'GA');
  assert.equal(withPost.items.length, 1);
  // `matched` is the registry name that hit, so a wrong hit is debuggable from the response.
  assert.equal(withPost.items[0].matched, 'Hartwell Lake');
  assert.equal(withPost.items[0].matched_in, 'article');
  assert.equal(withPost.items[0].published, '2026-08-14T16:20:52.000Z');
});

test('the scan plan is capped, and says so', () => {
  const now = Date.parse('2026-08-16T12:00:00Z');
  const plan = rssScanPlan(GA_FEED, HARTWELL, now);
  assert.equal(plan.limit, ARTICLE_SCAN_LIMIT);
  assert.equal(plan.links.length, ARTICLE_SCAN_LIMIT);
  // Ten items; the four older than 45 days are not worth a fetch.
  assert.equal(plan.candidates, 6);
  assert.equal(plan.links[0], 'https://georgiawildlife.blog/2026/08/14/georgia-fishing-report-august-14-2026/');
});

test('TWRA reaches the caller flagged, and its tailwater entry does not reach it at all', () => {
  const ftl = shapeReports({ twraText: TWRA_PAGE }, FT_LOUDOUN, 'TN');
  assert.equal(ftl.items.length, 1);
  assert.equal(ftl.items[0].matched, 'Fort Loudoun Lake');
  assert.equal(ftl.items[0].caution, 'TWRA has not updated this page since 2026-05-27');
  assert.equal(ftl.items[0].published, '2026-05-13T00:00:00.000Z');

  // Norris Lake's only TWRA entry is its tailwater. Nothing is better than the wrong water.
  assert.equal(shapeReports({ twraText: TWRA_PAGE }, NORRIS, 'TN').items.length, 0);
});

test('undated AHQ text is kept apart from dated items, and never sorted among them', () => {
  const s = shapeReports({
    rssByState: { NC: NC_FEED },
    twraText: null,
    ahqText: 'Lake Wateree is up to 97.9% of full pool.',
    ahqUrl: 'https://www.anglersheadquarters.com/pages/lake-wateree-fishing-report',
  }, JUNALUSKA, 'NC');
  assert.equal(s.items.length, 1);
  assert.equal(s.undated.length, 1);
  assert.equal(s.undated[0].published, null);
  assert.equal(s.undated[0].undated, true);
  assert.ok(!s.items.some((i) => i.undated));
  assert.equal(s.none_found, false);
});

test('"nobody looked" and "nothing to report" are different answers', () => {
  const nothingChecked = shapeReports({}, MARION, 'SC');
  assert.deepEqual(nothingChecked.checked, []);
  assert.equal(nothingChecked.none_found, true);

  const lookedAndEmpty = shapeReports({ rssByState: { GA: GA_FEED, NC: NC_FEED } }, MARION, 'SC');
  assert.deepEqual(lookedAndEmpty.checked, ['GA', 'NC']);
  assert.equal(lookedAndEmpty.none_found, true);
  assert.equal(lookedAndEmpty.items.length, 0);
});

test('items are newest first', () => {
  const s = shapeReports({ rssByState: { NC: NC_FEED, GA: GA_FEED } },
    [...JUNALUSKA, 'Santee Cooper'], 'SC');
  const dates = s.items.map((i) => i.published);
  assert.deepEqual(dates, [...dates].sort().reverse());
});
