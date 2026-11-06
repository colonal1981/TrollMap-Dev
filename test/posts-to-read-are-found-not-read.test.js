/**
 * test/posts-to-read-are-found-not-read.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Facebook's robots.txt prohibits automated collection. Ryan, 11/6: "is there an automated way to
 * search for it but not collect it? can i manually collect it after the automatic search?" So the
 * Worker asks a search engine for the water's recent posts and lists them (GET
 * /guide-reports/<slug>/posts); the app shows the list beside "A report you read"; he opens one,
 * reads it and pastes it; the paste keeps the post's link and the post drops off the list.
 *
 * What is held here:
 *   - only the search is asked: no post, no facebook.com address, no fetch service is ever called;
 *   - the list is the water's posts about fishing, from the water's own guides or naming it, newest
 *     first, each with its page, its date as the search gave it, and its link;
 *   - "Look again" is token-guarded; a day's list is kept;
 *   - a paste keeps its link, the plan prints the link, and a pasted post leaves the list.
 *
 *   node --test test/posts-to-read-are-found-not-read.test.js
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickPosts, searchDay, postPage, findPosts, handleGuideReports } from '../Worker/guide-reports.js';
import { _resetIndexCache } from '../Worker/registry.js';
import { pastedRecord, pastedAsReports, postsToRead, postKey, askPosts } from '../js/modules/pasted-reports.js';

const NOW = Date.parse('2026-11-06T17:00:00Z');

// The shapes TinyFish search gave on 11/6 for these two questions, cut down.
const MURRAY_HITS = [
  { title: 'Lake Murray fishing report after front change', snippet: 'Mike - Lake Murray Guide | Lake Murray fishing report after front change.',
    url: 'https://www.facebook.com/Lakemurraystriper/posts/went-out-this-morning-to-do-a-little-scouting/1747506037376816/' },
  { title: 'Lake Murray fishing report: tough morning bite', snippet: 'Lake Murray fishing report: tough morning bite.', date: '2 weeks ago',
    url: 'https://www.facebook.com/Lakemurraystriper/posts/bite-this-morning-was-tough/1729749505819136/' },
  { title: 'Lake Murray striper and crappie fishing guide', snippet: 'Crappie: Captain Brad Taylor reports that the spawn started in March on Lake Murray',
    date: '4 days ago', url: 'https://www.facebook.com/groups/1382229715433705/posts/4598408087149169/' },
  { title: 'Lake Wylie fishing report', snippet: 'Wylie crappie on the docks.', date: '1 day ago',
    url: 'https://www.facebook.com/somebody/posts/wylie/123/' },
  { title: 'Lake Murray Marina', snippet: 'Lake Murray Marina is open 7 days a week.', date: '1 day ago',
    url: 'https://www.facebook.com/lakemurraymarina/posts/hours/456/' },
  { title: 'Lake Murray Fishing', snippet: 'A page about Lake Murray fishing.', url: 'https://www.facebook.com/lakemurrayfishing/' },
  { title: 'Lake Murray fishing report', snippet: 'Lake Murray fishing report', url: 'https://lakemurrayfishing.example.com/report' },
  { title: 'Lake Murray fishing report after front change', snippet: 'the same post on the mobile site',
    url: 'https://m.facebook.com/Lakemurraystriper/posts/went-out-this-morning-to-do-a-little-scouting/1747506037376816/?mibextid=abc' },
];
const SCC_HITS = [
  { title: 'Santee Cooper Country', snippet: 'November 2026 FISHING REPORT Thanks, as always to two of the best guys fishing guides on the lakes',
    date: '4 days ago', url: 'https://www.facebook.com/santeecoopercountrysouthcarolina/posts/november-2026-fishing-report/1631606482318127/' },
];
const SCC_PAGE = { kind: 'facebook', label: 'Santee Cooper Country on Facebook', author: 'Santee Cooper Country',
  url: 'https://www.facebook.com/santeecoopercountrysouthcarolina' };

test('the list: posts about fishing on this water, one each, newest first, undated last', () => {
  const posts = pickPosts(MURRAY_HITS, { tokens: new Set(['murray']), nowMs: NOW });
  assert.deepEqual(posts.map((p) => p.url), [
    'https://www.facebook.com/groups/1382229715433705/posts/4598408087149169/',
    'https://www.facebook.com/Lakemurraystriper/posts/bite-this-morning-was-tough/1729749505819136/',
    'https://www.facebook.com/Lakemurraystriper/posts/went-out-this-morning-to-do-a-little-scouting/1747506037376816/',
  ], 'not Wylie, not the marina hours, not a page, not another site, and the mobile copy is the same post');
  assert.equal(posts[0].page, 'a Facebook group');
  assert.equal(posts[0].when, '2026-11-02');
  assert.equal(posts[1].page, 'Lakemurraystriper');
  assert.equal(posts[2].when, null, 'no date in the search, and it says so');
});

test('a post on the water\'s own guides\' page counts by the page, and is named for it', () => {
  const [p] = pickPosts(SCC_HITS, { tokens: new Set(['marion']), pages: [SCC_PAGE], nowMs: NOW });
  assert.equal(p.page, 'Santee Cooper Country');
  assert.equal(p.source, 'Santee Cooper Country on Facebook');
  assert.equal(p.when, '2026-11-02');
});

test('a guide\'s page counts by the post\'s address, never by what the search\'s preview says', () => {
  const WOLFE = { kind: 'facebook', label: "Wolfe's Guide Service on Facebook", author: "Wolfe's Guide Service LLC",
    url: 'https://www.facebook.com/p/Wolfes-Guide-Service-LLC-100068648221854/' };
  const hits = [
    // measured 11/6: a reel of ladyfish, with the guide's name in a preview the search wrote
    { title: 'Joseph Garcia on Reels', snippet: "A male narrator notes he has caught about a dozen ladyfish. Wolfe's Guide Service LLC ...",
      url: 'https://www.facebook.com/joseph.garcia.526875/videos/27882891198053153/' },
    { title: 'November fishing report', snippet: 'Crappie are on the brush.', date: '3 days ago',
      url: 'https://www.facebook.com/100068648221854/posts/pfbid0abc/' },
  ];
  const posts = pickPosts(hits, { tokens: new Set(['wateree']), pages: [WOLFE], nowMs: NOW });
  assert.deepEqual(posts.map((p) => p.source), ["Wolfe's Guide Service on Facebook"]);
  assert.equal(posts[0].page, "Wolfe's Guide Service LLC");
});

test('a post the search gives no date is dated by the month it names, said as a month', () => {
  // measured live 11/6: the search's API gave none of Santee Cooper Country's posts a date
  const hits = [{ title: 'Santee Cooper Country', snippet: 'Santee Cooper Country. 2d. November 2026 FISHING REPORT Thanks, as always',
    url: 'https://www.facebook.com/santeecoopercountrysouthcarolina/posts/november-2026-fishing-report/1631606482318127/' }];
  const [p] = pickPosts(hits, { tokens: new Set(['marion']), pages: [SCC_PAGE], nowMs: NOW });
  assert.equal(p.when, '2026-11');
  assert.equal(p.whenApprox, true);
  assert.equal(p.whenSaid, 'the post names November 2026');
});

test('the day a search names, and whose post it is', () => {
  assert.deepEqual(searchDay('4 days ago', NOW), { date: '2026-11-02', approx: false });
  assert.deepEqual(searchDay('1 month ago', NOW), { date: '2026-10-07', approx: true });
  assert.equal(searchDay('', NOW), null);
  assert.equal(searchDay('Oct 3, 2026', NOW).date, '2026-10-03');
  assert.equal(searchDay('2026-10-03', NOW).date, '2026-10-03');
  assert.equal(postPage('https://www.facebook.com/p/Wolfes-Guide-Service-LLC-100068648221854/'), 'Wolfes Guide Service LLC');
  assert.equal(postPage('https://www.facebook.com/groups/123/posts/456/'), 'a Facebook group');
});

// ── the Worker asks the search and nothing else ──────────────────────────────────────────────────

const INDEX = JSON.stringify({ lake_murray: { name: 'Lake Murray', display_name: 'Lake Murray (Lexington Co, SC)', legacy_display_names: ['Lake Murray, SC'] } });
const kv = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), put: async (k, v) => { m.set(k, v); } }; };
const ENV = (KV = kv()) => ({
  TINYFISH_API_KEY: 'test-only', KV,
  R2_TROLLMAP_CHARTPACKS: { get: async (k) => (k === '_registry/lake_index.json' ? { httpMetadata: {}, text: async () => INDEX } : null) },
});
let calls; let realFetch;
beforeEach(() => {
  _resetIndexCache();
  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://api.search.tinyfish.ai')) {
      return new Response(JSON.stringify({ results: MURRAY_HITS }), { status: 200 });
    }
    return new Response('not for the finder', { status: 599 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

test('findPosts asks the search engine, only, about facebook.com, and never opens a post', async () => {
  const out = await findPosts('lake_murray', ENV(), '2026-11-14');
  assert.ok(calls.length >= 2);
  for (const u of calls) {
    assert.ok(u.startsWith('https://api.search.tinyfish.ai?'), `only the search: ${u}`);
    assert.equal(new URL(u).searchParams.get('include_domains'), 'facebook.com');
    assert.equal(new URL(u).searchParams.get('after_date'), '2026-10-01', 'this month and last');
  }
  assert.equal(out.posts.length, 3);
  assert.deepEqual(out.searched, ['"Lake Murray" fishing report', '"Lake Murray" fishing']);
});

test('the finder\'s code calls no fetch service and reads no post', () => {
  const src = readFileSync(new URL('../Worker/guide-reports.js', import.meta.url), 'utf8');
  const a = src.indexOf('// ── POSTS TO READ');
  const b = src.indexOf('async function transcriptOf');
  assert.ok(a > 0 && b > a, 'the finder moved -- this guard needs updating');
  const finder = src.slice(a, b) + src.slice(src.indexOf('async function handleFindPosts'));
  for (const no of ['tinyfishFetch(', 'fetch(', 'tfPage(', 'firecrawl']) assert.equal(finder.includes(no), false, no);
});

test('the route: a day\'s list is kept, and "Look again" needs the token', async () => {
  const store = kv();
  const ask = (q = '', headers = {}) => handleGuideReports(new Request(`https://w.test/guide-reports/lake_murray/posts${q}`, { headers }),
    ENV(store), new URL(`https://w.test/guide-reports/lake_murray/posts${q}`));
  const first = await (await ask('?date=2026-11-14')).json();
  assert.equal(first.posts.length, 3);
  const n = calls.length;
  const again = await (await ask('?date=2026-11-14')).json();
  assert.equal(again.cached, true);
  assert.equal(calls.length, n, 'the day\'s list, not a new search');
  assert.equal((await ask('?date=2026-11-14&fresh=1')).status, 401);
  const ENV2 = { ...ENV(store), SYNC_TOKEN: 'a-stand-in-not-his' };
  const fresh = await handleGuideReports(new Request('https://w.test/guide-reports/lake_murray/posts?date=2026-11-14&fresh=1',
    { headers: { 'X-Sync-Token': 'a-stand-in-not-his' } }), ENV2, new URL('https://w.test/guide-reports/lake_murray/posts?date=2026-11-14&fresh=1'));
  assert.equal(fresh.status, 200);
  assert.equal((await fresh.json()).cached, undefined, 'a fresh look searches again');
  assert.ok(calls.length > n);
  assert.equal(await handleGuideReports(new Request('https://w.test/guide-reports/lake_murray/other'), ENV(store),
    new URL('https://w.test/guide-reports/lake_murray/other')), null, 'not its route');
});

// ── the app: a paste keeps its link, and the post leaves the list ───────────────────────────────

test('a paste keeps the post\'s link, and the plan prints it', () => {
  const r = pastedRecord({ text: 'Stripers on the points.', date: '2026-11-02', from: 'Lakemurraystriper', slug: 'lake_murray',
    link: 'https://www.facebook.com/Lakemurraystriper/posts/x/1/' }).record;
  assert.equal(r.link, 'https://www.facebook.com/Lakemurraystriper/posts/x/1/');
  assert.equal(pastedRecord({ text: 't', date: '2026-11-02', slug: 'lake_murray', link: 'javascript:alert(1)' }).record.link, null);
  assert.equal(pastedRecord({ text: 't', date: '2026-11-02', slug: 'lake_murray' }).record.link, null);
  assert.equal(pastedAsReports([r], '2026-11-14')[0].url, r.link);
});

test('a post already pasted leaves the list, however its address was spelled', () => {
  const posts = pickPosts(MURRAY_HITS, { tokens: new Set(['murray']), nowMs: NOW });
  const pasted = [{ link: 'https://m.facebook.com/Lakemurraystriper/posts/bite-this-morning-was-tough/1729749505819136?mibextid=x' }];
  assert.equal(postKey(pasted[0].link), postKey(posts[1].url));
  assert.deepEqual(postsToRead(posts, pasted).map((p) => p.url), [posts[0].url, posts[2].url]);
  assert.equal(postsToRead(posts, []).length, 3);
});

test('the app asks his Worker, with the token only for "Look again", and never throws', async () => {
  const seen = [];
  const f = async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify({ posts: [{ url: 'u' }] }), { status: 200 }); };
  assert.deepEqual((await askPosts({ worker: 'https://w.test', slug: 'lake_murray', date: '2026-11-14', fetchImpl: f })).posts, [{ url: 'u' }]);
  assert.equal(seen[0].url, 'https://w.test/guide-reports/lake_murray/posts?date=2026-11-14');
  assert.equal(seen[0].init, undefined);
  await askPosts({ worker: 'https://w.test', slug: 'lake_murray', fresh: true, fetchImpl: f });
  assert.equal(seen[1].url, 'https://w.test/guide-reports/lake_murray/posts?fresh=1');
  assert.ok('X-Sync-Token' in seen[1].init.headers);
  assert.match((await askPosts({ worker: 'https://w.test', slug: 'x', fetchImpl: async () => new Response('', { status: 500 }) })).error, /HTTP 500/);
  assert.match((await askPosts({ worker: 'https://w.test', slug: 'x', fetchImpl: async () => { throw new Error('offline'); } })).error, /offline/);
  assert.match((await askPosts({ worker: 'https://w.test', slug: null, fetchImpl: f })).error, /Pick the water/);
});

test('the card has the list, and the planner hands it the Worker', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['pastedReportFinds', 'pastedReportFindAgain', 'pastedReportLink']) assert.ok(html.includes(`id="${id}"`), id);
  const wiring = readFileSync(new URL('../js/modules/smart-plan-v2-wiring.js', import.meta.url), 'utf8');
  assert.match(wiring, /wirePasteBox\(\{[\s\S]{0,400}worker: CF_WORKER_URL/);
});
