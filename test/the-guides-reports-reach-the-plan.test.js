// The guides' monthly reports reach the plan, and the water they name is offered.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-01 (APP_CHANGE_REQUESTS 42): "Did my idea of pulling guide reports from the top
// guides for the 5 main lakes around me get built?", "I think the plan could benefit from these
// reports, don't you?", and, on a Marion striper plan whose lanes were all shallow, "depth itself
// shouldn't be weighted i dont think... but guide reports that put fish in certain depth of water
// should count towards something". Then "yes" to building it.
//
// Fixtures are the real texts read 2026-10-01 (TinyFish fetch, no login), trimmed to the parts the
// parsers read.
//
// What these hold:
//   1. each source is parsed the way it is published: SCDNR's lake section, Santee Cooper Country's
//      page with its modified date, a Facebook post or a share of one with the date Facebook shows,
//      a YouTube feed and transcript;
//   2. the depth of water is read only from "N feet of water", for the species the report's own
//      headings put it under;
//   3. this month's or last month's report counts for the lanes, an older one is reading only, and
//      the newer report from the same guides supersedes the older;
//   4. a lane over the guide's water is marked, and when the ranking offered none, the best one is
//      added past the limit; nothing is weighted and nothing is removed;
//   5. the prompt carries the reports verbatim, dated, and both planners pass them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScdnrSection, parseSccSite, parseFacebookPost, facebookDate, parseYoutubeFeed,
         pickYoutube, parseYoutubeScrape, monthsNamed, GUIDE_SOURCES, handleGuideReports }
  from '../Worker/guide-reports.js';
import { reportWaterFor, waterRangesIn, isCurrentReport, supersede, reportWaterForPlan }
  from '../js/utils/report-water.js';
import { guideReportsBlock, reportWaterForLanes, askGuideReports } from '../js/modules/guide-reports.js';
import { selectCandidates, forModel } from '../js/modules/plan-candidates.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, '..', f), 'utf8');
const live = (js) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SCDNR_MD = `# Freshwater Fishing Trends

Information on fishing trends provided courtesy of www.anglersheadquarters.com/.

## Midlands Area

### Lake Monticello

Catfish: Captain William Attaway (803-924-0857) reports that in September numbers of fish will still be caught free line drifting over deep water.

Most detailed Lake Monticello Updates

### Lake Wateree

Striped bass: Captain Justin Whiteside (803-417-0070) reports that it was a strong August on Lake Wateree and September should offer more of the same. There should be schooling activity this month, and fishing down-rods and free-lines at the mouths of creeks will also be effective.

Catfish: Captain Rodger Taylor (803-517-7828) reports that in September fishing cut shad in the mid-lake area is the best pattern.

Most detailed Lake Wateree Updates

### Santee Cooper

Black bass: Captain David Murdaugh Sr. (843-452-9566) reports that September should see a significant improvement in the bass fishing after a slower late summer.

Upper Lake Marion: At the top of the upper lake, Pack's Landing (803-452-5514) reports that in late August fishing activity was a little down.

Most detailed Santee Cooper System Updates

## Mountains Area

### Lake Jocassee

Trout: Guide Sam Jones reminds anglers that deep Lake Jocassee cools slower.`;

const SCC_SITE_MD = `# Latest Santee Cooper Fishing Report

September Fishing Report, proudly submitted each month by Captain Joe Dennis and pro angler Kyle Austin.

## Striper

Striper season is closed.

Anchoring up in 5 to 10 foot at night fishing with Carolina Rigs With cut shad cut perch cut Herring has been good. The drift fishing at night has also been good in 10 to 15 ft of water.

## Crappie

Crappie are being caught in 20-30 ft on brush.

#### April

#### March`;
const SCC_SITE_META = { article: { published_time: '2022-12-09T11:10:35+00:00', modified_time: '2026-09-04T13:51:22+00:00' } };

const OCT_SHARE_MD = `## New Country 105.3 The Cat's Post

---

### **New Country 105.3 The Cat**

5h

#### **Santee Cooper Country**

5h

Striper Season is OPEN! Thanks to Captain Joe Joseph Dennis and Captain Kyle Austin Fishing

for providing this monthly fishing report.

OCTOBER 2026 FISHING REPORT

Santee Cooper & Cooper River

STRIPERS

Striper season opens October 1st, and anglers should start looking for fish in 30–45 feet of water along flats and creek areas.

For the best results, fish a Carolina rig with live herring or live shad. Some schooling activity has also been reported on Lake Moultrie.

⸻

CATFISH

There are still plenty of catfish being caught on top of the 8–12 foot hills, as well as in 20–25 feet of water.

⸻

CAPTAIN KYLE AUSTIN — BASS REPORT

GRASS BITE

Look for grass lines and isolated grass clumps in 8–15 feet of water.

Seen by Joseph Dennis at Wed 4:13 PM`;

const APRIL_MD = `## Santee Cooper Country's Post

---

### **Santee Cooper Country**

April 3

April 2026 Fishing report provided by Captain Joe Joseph Dennis and Kyle Austin.

Stripers

Look for Stripers in 35 to 45 foot of water mainly in the creek channels and up on the hills. Fish live blueback herring on Carolina Rigs.`;

const WOLFE_MD = `## Wolfe's Guide Service LLC's Post

---

### **Wolfe's Guide Service LLC**

September 1 at 5:04 PM

Lake wateree sept fishing report. Stripers are literally scattered from the state park to clear water. Perch are thick in 15ft on humps and points.`;

const FEED_XML = `<feed><entry><yt:videoId>OdnMCXPtNVU</yt:videoId><title>Lake Murray June 2026 Fishing Report</title><published>2026-06-14T21:00:00+00:00</published></entry>
<entry><yt:videoId>abc</yt:videoId><title>Big bass on a frog</title><published>2026-07-01T00:00:00+00:00</published></entry>
<entry><yt:videoId>oct25</yt:videoId><title>Lake Murray October 2025 Fishing Report</title><published>2025-10-10T00:00:00+00:00</published></entry></feed>`;

const YT_MD = `# [Lake Murray June 2026 Fishing Report](https://www.youtube.com/watch?v=OdnMCXPtNVU)

**Uploaded by**: [Chris Blanchette](https://www.youtube.com/@BigFishBlanch)
**Uploaded at**: 2026-06-14

## Description

\`\`\`
Captain Chris and Captain Chip discuss Lake Murray's fishing conditions.
\`\`\`

## Transcript

We went from 3 to 4 ft down to a full pool.
The stripers have been out there
in 35 to 50 foot of water off the creek mouths.`;

const NOW = Date.parse('2026-10-01T22:00:00Z');   // 6 pm EDT on 10/1

test('SCDNR: one lake\'s section, without the next lake or the "Most detailed" link, and undated', () => {
  const w = parseScdnrSection(SCDNR_MD, 'Lake Wateree');
  assert.match(w.text, /^Striped bass: Captain Justin Whiteside/);
  assert.ok(!/Santee Cooper|Most detailed|Monticello/.test(w.text));
  assert.deepEqual(w.monthsNamed, ['August', 'September']);
  assert.match(parseScdnrSection(SCDNR_MD, 'Santee Cooper').text, /Pack's Landing/);
  assert.equal(parseScdnrSection(SCDNR_MD, 'Lake Murray'), null);
});

test('Santee Cooper Country\'s page: the report, dated by its own modified time, archive links cut', () => {
  const p = parseSccSite(SCC_SITE_MD, SCC_SITE_META);
  assert.equal(p.published, '2026-09-04');
  assert.equal(p.monthNamed, 'September');
  assert.ok(!/April|March/.test(p.text.split('\n').slice(-3).join(' ')));
});

test('Facebook: a share of the post is the author\'s report, says whose share, and is dated as shown', () => {
  const p = parseFacebookPost(OCT_SHARE_MD, 'Santee Cooper Country', NOW);
  assert.equal(p.via, 'shared by New Country 105.3 The Cat');
  assert.equal(p.published, '2026-10-01');
  assert.match(p.publishedFrom, /Facebook shows "5h", read 2026-10-01/);
  assert.equal(p.monthNamed, 'October');
  assert.ok(!/Seen by/.test(p.text));
  assert.equal(parseFacebookPost(OCT_SHARE_MD, "Wolfe's Guide Service LLC", NOW), null);
  const w = parseFacebookPost(WOLFE_MD, "Wolfe's Guide Service LLC", NOW);
  assert.equal(w.published, '2026-09-01');
  assert.equal(w.via, null);
  assert.equal(w.monthNamed, 'September');           // "sept"
});

test('Facebook dates: relative, yesterday, a day with no year, a day with one', () => {
  assert.equal(facebookDate('3d', NOW).date, '2026-09-28');
  assert.equal(facebookDate('Yesterday at 4:13 PM', NOW).date, '2026-09-30');
  assert.equal(facebookDate('April 3', NOW).date, '2026-04-03');
  assert.equal(facebookDate('December 5', NOW).date, '2025-12-05');   // not in the future
  assert.equal(facebookDate('December 5, 2024', NOW).date, '2024-12-05');
  assert.equal(facebookDate('Sep 9', NOW).date, '2026-09-09');
  assert.equal(facebookDate('4y', NOW), null);
});

test('YouTube: the newest report video for the water, and last year\'s for the plan\'s month', () => {
  const feed = parseYoutubeFeed(FEED_XML);
  assert.equal(feed.length, 3);
  const { newest, sameMonth } = pickYoutube(feed, /\blake murray\b/i, 'October');
  assert.equal(newest.videoId, 'OdnMCXPtNVU');
  assert.equal(sameMonth.videoId, 'oct25');
  const t = parseYoutubeScrape(YT_MD);
  assert.equal(t.uploaded, '2026-06-14');
  assert.match(t.transcript, /35 to 50 foot of water off the creek mouths/);
  assert.ok(!/Captain Chris and Captain Chip discuss/.test(t.transcript));
});

test('the depth of WATER is "N feet of water" and nothing else', () => {
  assert.deepEqual(waterRangesIn('look for fish in 30–45 feet of water along flats'), [[30, 45]]);
  assert.deepEqual(waterRangesIn('in 35 to 45 foot of water mainly'), [[35, 45]]);
  assert.deepEqual(waterRangesIn('cut herring in less than 15 feet of water'), [[0, 15]]);
  assert.deepEqual(waterRangesIn('over brush in 15-25 plus feet of water'), [[15, null]]);
  assert.deepEqual(waterRangesIn('35-50 ft of open water'), [[35, 50]]);
  for (const s of ['caught in 20-30 ft on brush', 'toward 25–30 foot brush piles',
                   'on top of the 8–12 foot hills', 'Perch are thick in 15ft on humps',
                   'the top 10 feet of the water column']) {
    assert.deepEqual(waterRangesIn(s), [], s);
  }
});

test('which fish a sentence is about comes from the report\'s own headings', () => {
  const oct = parseFacebookPost(OCT_SHARE_MD, 'Santee Cooper Country', NOW).text;
  assert.deepEqual(reportWaterFor(oct, 'Striped Bass').map((w) => w.ft), [[30, 45]]);
  assert.deepEqual(reportWaterFor(oct, 'Catfish').map((w) => w.ft), [[20, 25]]);
  // Under "GRASS BITE", a heading that names no fish, the sentence does not name bass either.
  assert.deepEqual(reportWaterFor(oct, 'Largemouth Bass'), []);
  const apr = parseFacebookPost(APRIL_MD, 'Santee Cooper Country', NOW).text;
  assert.deepEqual(reportWaterFor(apr, 'Striped Bass').map((w) => w.ft), [[35, 45]]);
  assert.deepEqual(reportWaterFor(parseYoutubeScrape(YT_MD).transcript, 'Striped Bass').map((w) => w.ft), [[35, 50]]);
});

test('this month\'s or last month\'s report counts; the same guides\' newer one supersedes the older', () => {
  const site = { label: 'site', guides: 'G', published: '2026-09-04', text: '' };
  const post = { label: 'post', guides: 'G', published: '2026-10-01', text: '' };
  const june = { label: 'june', guides: 'Y', published: '2026-06-14', text: '' };
  const lastOct = { label: 'oct25', guides: 'Y', published: '2025-10-10', role: 'same month, an earlier year', text: '' };
  const scdnr = { label: 'scdnr', published: null, monthsNamed: ['August', 'September'], text: '' };
  for (const r of [site, post, scdnr]) assert.equal(isCurrentReport(r, '2026-10-02'), true, r.label);
  for (const r of [june, lastOct]) assert.equal(isCurrentReport(r, '2026-10-02'), false, r.label);
  const s = supersede([site, post, june, lastOct]);
  assert.equal(s.find((r) => r.label === 'site').supersededBy, 'post');
  assert.equal(s.find((r) => r.label === 'post').supersededBy, undefined);
  assert.equal(s.find((r) => r.label === 'oct25').supersededBy, undefined);
});

// Two lanes 2.2 km long at different depths; the shallow one ranks first.
const lane = (id, lat, lo, hi, n) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: Array.from({ length: 41 }, (_, k) => [-80.725 + k * 0.0006, lat]) },
  properties: {
    id, depth_ft: (lo + hi) / 2, length_m: 2200, routable: true, relief: 'flat', fitted: true,
    envelope_step_m: 100,
    envelope_line_ft: Array.from({ length: 23 }, (_, k) => lo + ((hi - lo) * ((k * 7) % 23)) / 22),
    envelope_ft: Array.from({ length: 23 }, (_, k) => lo + ((hi - lo) * ((k * 5) % 23)) / 22),
    near: Array.from({ length: n }, (_, k) => ({ s: 200 + k * 300, t: 'point', d: 25 })),
  },
});
const OPTS = { ramp: [-80.73, 34.38], slug: 'w', fishDepthFt: [0, 99], holding: 'bottom',
               usableAh: 999, windowMin: 9999, limit: 1 };
const GUIDE = { reports: [{ label: 'Santee Cooper Country on Facebook', guides: 'G', published: '2026-10-01',
  text: parseFacebookPost(OCT_SHARE_MD, 'Santee Cooper Country', NOW).text }], checked: [] };

test('a lane over the guide\'s water is offered past the limit when the ranking left none, and says why', () => {
  const runs = [lane('shallow', 34.38, 3, 15, 6), lane('deep', 34.40, 28, 40, 2)];
  const before = selectCandidates(runs, OPTS);
  assert.deepEqual(before.map((c) => c.runId), ['shallow']);
  const reportWater = reportWaterForLanes(GUIDE, 'Striped Bass', '2026-10-02', null);
  assert.deepEqual(reportWater.map((w) => w.chartFt), [[30, 45]]);
  const after = selectCandidates(runs, { ...OPTS, reportWater });
  assert.deepEqual(after.map((c) => c.runId), ['shallow', 'deep']);
  const deep = after.find((c) => c.runId === 'deep');
  assert.equal(deep.offeredForReport, true);
  assert.match(deep.reportWater[0].quote, /30–45 feet of water/);
  assert.equal(after[0].reportWater, undefined);
  assert.equal(after.selection.offeredForReports, 1);
  assert.equal(after.selection.accountedFor, after.selection.considered);
  const m = forModel(deep);
  assert.deepEqual(m.reportWater[0].waterFt, [30, 45]);
  assert.equal(m.offeredForReport, true);
});

test('a measured chart level moves the guide\'s water onto the chart; nothing is added when a lane already covers it', () => {
  const w = reportWaterForLanes(GUIDE, 'Striped Bass', '2026-10-02', 1.2);
  assert.deepEqual(w[0].chartFt, [31.2, 46.2]);
  const runs = [lane('deep', 34.40, 28, 40, 6), lane('shallow', 34.38, 3, 15, 2)];
  const out = selectCandidates(runs, { ...OPTS, reportWater: w });
  assert.deepEqual(out.map((c) => c.runId), ['deep']);
  assert.equal(out[0].offeredForReport, undefined);
  assert.equal(out[0].reportWater.length, 1);
});

test('the prompt carries the reports verbatim and dated, the superseded one by name only, and the failures', () => {
  const g = { readAt: '2026-10-01T22:00:00Z', checked: [{ label: 'X', ok: false, why: 'search found no post by URL' }],
    reports: supersede([
      { label: 'SCC site', guides: 'G', published: '2026-09-04', publishedFrom: "the page's own last-modified time", text: 'September text' },
      { ...GUIDE.reports[0], via: 'shared by New Country 105.3 The Cat', publishedFrom: 'Facebook shows "5h", read 2026-10-01' },
      { label: 'SCDNR -- Santee Cooper', published: null, monthsNamed: ['August', 'September'], text: 'Black bass: ...' },
    ]) };
  const b = guideReportsBlock(g, ['Striped Bass'], '2026-10-02');
  assert.match(b, /WHAT THE GUIDES ON THIS WATER REPORTED/);
  assert.match(b, /2026-10-01 \(Facebook shows "5h", read 2026-10-01\), shared by New Country 105\.3 The Cat/);
  assert.match(b, /Striper season opens October 1st/);
  assert.match(b, /NO DATE STATED; the text speaks of August and September/);
  assert.ok(!b.includes('September text'));
  assert.match(b, /An older report by the same guides, SCC site/);
  assert.match(b, /X: search found no post by URL/);
  assert.match(b, /Striped Bass: 30-45 ft of water/);
  assert.equal(guideReportsBlock(undefined, [], '2026-10-02'), '');
  assert.match(guideReportsBlock({ error: 'no answer in 60 s' }, [], '2026-10-02'), /could not be read today \(no answer in 60 s\)/);
});

test('askGuideReports never throws and supersedes on the way in', async () => {
  const ok = await askGuideReports({ worker: 'https://w', slug: 'lake_marion', date: '2026-10-02',
    fetchImpl: async (u) => { assert.equal(u, 'https://w/guide-reports/lake_marion?date=2026-10-02');
      return { ok: true, json: async () => ({ reports: [{ label: 'a', guides: 'G', published: '2026-09-04' }, { label: 'b', guides: 'G', published: '2026-10-01' }] }) }; } });
  assert.equal(ok.reports[0].supersededBy, 'b');
  const bad = await askGuideReports({ worker: 'https://w', slug: 's', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(bad.error, 'offline');
  assert.equal((await askGuideReports({ worker: 'https://w', slug: 's', fetchImpl: async () => ({ ok: false, status: 500 }) })).error,
    'the Worker answered HTTP 500');
});

test('the route: the individual guides\' waters, a day\'s copy from KV, and fresh only with the token', async () => {
  // Only the individual guides are listed by water since 2026-10-02; SCDNR, AHQ and the search
  // come by name for every water with a research profile (generalSources()).
  assert.deepEqual(Object.keys(GUIDE_SOURCES).sort(),
    ['lake_marion', 'lake_moultrie', 'lake_murray', 'wateree_lake']);
  const store = new Map();
  const env = { KV: { get: async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null),
                      put: async (k, v) => store.set(k, v) } };
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  store.set(`guide:reports:v6:lake_marion:2026-10:${day}`, JSON.stringify({ reports: [{ label: 'kept' }] }));
  const get = (q) => handleGuideReports(new Request(`https://w/guide-reports/lake_marion${q}`), env, new URL(`https://w/guide-reports/lake_marion${q}`));
  const hit = await (await get('?date=2026-10-02')).json();
  assert.equal(hit.cached, true);
  assert.equal(hit.reports[0].label, 'kept');
  assert.equal((await get('?date=2026-10-02&fresh=1')).status, 401);
  assert.equal(await handleGuideReports(new Request('https://w/reports/x'), env, new URL('https://w/reports/x')), null);
});

// The evening of 2026-10-01: the October post was only a preview on the PAGE in search; the newest
// post search could give by URL was August's.
const PAGE = 'https://www.facebook.com/santeecoopercountrysouthcarolina/';
const AUG_URL = 'https://www.facebook.com/santeecoopercountrysouthcarolina/posts/august-fishing-report-2026/1544620447683398/';
const AUG_MD = `## Santee Cooper Country's Post\n\n---\n\n### **Santee Cooper Country**\n\nAugust 5\n\nAugust Fishing Report 2026.\n\nStriper season is closed.`;
const PREVIEW = 'OCTOBER 2026 FISHING REPORT Santee Cooper & Cooper River STRIPERS Striper season opens October 1st, and anglers should start looking for fish in 30–45 feet of water along flats and creek areas.';

const AHQ_LINKS = ['https://www.anglersheadquarters.com/pages/santee-cooper-lake-marion-lake-moultrie-fishing-report',
  'https://www.anglersheadquarters.com/blogs/ahq-report/tagged/santee-cooper'];
const MARION_ROW = { slug: 'lake_marion', name: 'Lake Marion', display_name: 'Lake Marion (Clarendon Co, SC)', state: 'SC',
  feature_type: 'lake', legacy_display_names: ['Lake Marion, SC'] };
const MARION_BUCKET = {
  async get(key) {
    if (key !== '_registry/lake_index.json') return null;
    const body = JSON.stringify({ lake_marion: MARION_ROW });
    return { text: async () => body };
  },
  async head(key) { return /^lakes\/lake_marion/.test(key) ? { key } : null; },
};

test('a newer post seen only as a preview in search goes in, labelled, and supersedes the older ones', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    const url = String(u);
    if (url.startsWith('https://api.search.tinyfish.ai')) {
      return Response.json({ results: [{ url: PAGE, snippet: PREVIEW }, { url: AUG_URL, snippet: 'August Fishing Report 2026.' }] });
    }
    if (url.startsWith('https://api.fetch.tinyfish.ai')) {
      const body = JSON.parse(init.body);
      const page = (x) => (x === 'https://www.dnr.sc.gov/news/freshwater.html' ? { text: SCDNR_MD }
        : x.startsWith('https://www.santeecoopercountry.org/') ? { text: SCC_SITE_MD, page_metadata: SCC_SITE_META }
        : x === AUG_URL ? { text: AUG_MD }
        : x === 'https://www.anglersheadquarters.com/blogs/ahq-report' ? { text: '* Santee Cooper', links: AHQ_LINKS } : null);
      return Response.json({ results: body.urls.map((x) => ({ url: x, final_url: x, ...page(x) })).filter((x) => x.text), errors: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const { gatherGuideReports, _resetAhqIndex } = await import('../Worker/guide-reports.js');
    const { _resetIndexCache } = await import('../Worker/registry.js');
    _resetIndexCache();
    _resetAhqIndex();
    // Since 2026-10-02 SCDNR comes by name for a water with a research profile, so the bucket holds
    // Marion's registry row and a profile, and AHQ's blog lists the page that says Santee Cooper is
    // Marion and Moultrie (the bridge to SCDNR's "Santee Cooper" heading).
    const g = await gatherGuideReports('lake_marion', { TINYFISH_API_KEY: 'k', R2_TROLLMAP_CHARTPACKS: MARION_BUCKET }, '2026-10-02');
    const by = (label) => g.checked.find((c) => c.label === label);
    assert.equal(by('Santee Cooper Country fishing report').ok, true);
    assert.equal(by('Santee Cooper Country on Facebook').ok, true);
    assert.equal(by('SCDNR Freshwater Fishing Trends').ok, true);
    // Angler's Headquarters: this fake serves its blog but none of its listing pages.
    assert.equal(by("Angler's Headquarters weekly report").ok, false);
    _resetIndexCache();
    _resetAhqIndex();
    const pv = g.reports.find((r) => r.preview);
    assert.equal(pv.monthYear, '2026-10');
    assert.match(pv.label, /search preview only/);
    assert.equal(g.reports.find((r) => r.url === AUG_URL).published, '2026-08-05');
    const s = supersede(g.reports);
    // The preview supersedes nothing; the September page supersedes August's post.
    assert.deepEqual(s.filter((r) => !r.supersededBy).map((r) => r.kind).sort(), ['facebook', 'page', 'scdnr']);
    assert.equal(s.find((r) => r.url === AUG_URL).supersededBy, 'Santee Cooper Country fishing report');
    assert.deepEqual(reportWaterForPlan(s, 'Striped Bass', '2026-10-02').map((w) => w.ft), [[30, 45]]);
    assert.match(guideReportsBlock({ reports: s, checked: g.checked }, ['Striped Bass'], '2026-10-02'),
      /NOT DATED: a search preview of a post naming 2026-10/);
  } finally {
    globalThis.fetch = real;
  }
});

test('both planners pass the reports, Smart Plan passes the water to the lanes, and the prompt prints them', () => {
  const prompt = live(read('js/modules/plan-prompt.js'));
  assert.match(prompt, /guideReportsBlock\(o\.guideReports, o\.species, o\.date\)/);
  const sp = live(read('js/modules/smart-plan-v2.js'));
  assert.match(sp, /guideReports: o\.guideReports \|\| null/);
  assert.match(sp, /reportWater: o\.reportWater \|\| null/);
  // AND THE PATTERN FACTS, which Smart Plan was handed by its wiring and never passed on.
  assert.match(sp, /patternFacts: o\.patternFacts \|\| null/);
  const wiring = live(read('js/modules/smart-plan-v2-wiring.js'));
  assert.match(wiring, /askGuideReports\(/);
  assert.match(wiring, /reportWaterForLanes\(/);
  const pw = live(read('js/modules/plan-water-ui.js'));
  assert.match(pw, /askGuideReports\(/);
  assert.match(pw, /guideReports:/);
  assert.match(live(read('Worker/trollmap-worker.js')), /handleGuideReports\(request, env, url\)/);
  assert.deepEqual(monthsNamed('sept and October'), ['September', 'October']);
  assert.deepEqual(monthsNamed('in September. Fish may also move shallower. MAY 2026'), ['September', 'May']);
});
