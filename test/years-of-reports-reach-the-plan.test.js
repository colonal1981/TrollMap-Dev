/**
 * test/years-of-reports-reach-the-plan.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 11/6: "I am a fisherman... i am not a striper fisherman... I troll... just knowing whether the
 * fish are on the bottom, suspended or feeding on bait on the surface helps... if the app can tell me
 * that i should be throwing a certain type of topwater bait in a certain area at a certain time i will
 * do that... the one thing i am not going to do... is live bait in freshwater on my kayak".
 *
 * Scripts/reports_step.py keeps a water's reports at lake_packages/<id>/reports.json. What is held here:
 *   - the gated GET /research/reports finds the file beside the water's profile by the slug the
 *     planner holds, refuses a file kept for another water, and sends the stored gzip bytes as they
 *     are, never parsed (10 ms of CPU a request);
 *   - the planner keeps the reports from three weeks either side of the plan's day in any year from
 *     2008, and writes his fish first with where they sat, how deep, the places on his chart, the lures
 *     (and which are trolled) and the time of day; other fish follow with the facts only; bait is
 *     struck but the bait report still counts for where and how deep;
 *   - the read rides askGuideReports() on both planners, with his token, and a failure is said, not
 *     planned around; a saved plan keeps the block it read, not the statements.
 *
 *   node --test test/years-of-reports-reach-the-plan.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { handleResearchReports } from '../Worker/research/storage.js';
import { inWindow, pickThisWeek, reportFish, thisWeekBlock, forSaving, askThisWeek } from '../js/modules/reports-this-week.js';
import { askGuideReports, guideReportsBlock, savedGuide } from '../js/modules/guide-reports.js';
import { placesThisWeek, srcName, turnsFromReports, rampsByReports, crowM } from '../js/modules/reports-this-week.js';
import { spotHtml, pinRadiusPx, onTheWater } from '../js/modules/report-spots-layer.js';

// ── the Worker's door ────────────────────────────────────────────────────────────────────────────

const MURRAY = 'Lake Murray (Lexington Co, SC)';
const INDEX = JSON.stringify({ lake_murray: { display_name: MURRAY, name: 'Lake Murray', legacy_display_names: ['Lake Murray, SC'] } });

function env(store, custom = {}) {
  const asObj = (k) => (store[k] === undefined ? null
    : { body: store[k], customMetadata: custom[k] || {}, httpMetadata: {}, text: async () => String(store[k]) });
  return { R2_TROLLMAP_CHARTPACKS: {
    get: async (k) => asObj(k), head: async (k) => asObj(k),
    list: async () => { throw new Error('the read must not list the bucket'); },
    put: async () => { throw new Error('a read writes nothing'); },
  } };
}
const get = (water) => new Request(`https://w.test/research/reports?water=${encodeURIComponent(water)}`);
const GZ = gzipSync(Buffer.from(JSON.stringify({ water: 'lake_murray', statements: [] })));
const STORE = () => ({
  '_registry/lake_index.json': INDEX,
  'lakes/lake_murray_sc.json': JSON.stringify({ lakeName: MURRAY }),
  'lake_packages/lake_murray_sc/reports.json': GZ,
});

test('the reports file is found beside the profile by the slug, and sent as it is kept', async () => {
  const res = await handleResearchReports(get('lake_murray'),
    env(STORE(), { 'lake_packages/lake_murray_sc/reports.json': { water: 'lake_murray' } }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Encoding'), 'gzip', 'the browser unzips it');
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  assert.equal(res.headers.get('X-Reports-Key'), 'lake_packages/lake_murray_sc/reports.json');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), GZ, 'byte for byte');
});

test('a file kept for another water is refused, and so is a water with no profile or no file', async () => {
  const wrong = await handleResearchReports(get('lake_murray'),
    env(STORE(), { 'lake_packages/lake_murray_sc/reports.json': { water: 'lake_greenwood' } }));
  assert.equal(wrong.status, 409);
  const none = await handleResearchReports(get('lake_murray'), env({ '_registry/lake_index.json': INDEX }));
  assert.equal(none.status, 404);
  const s = STORE(); delete s['lake_packages/lake_murray_sc/reports.json'];
  assert.equal((await handleResearchReports(get('lake_murray'), env(s))).status, 404);
  for (const bad of ['', '../lakes/x', 'Lake Murray']) {
    assert.equal((await handleResearchReports(get(bad), env(STORE()))).status, 400, bad);
  }
});

test('the read never parses the file and never lists the bucket', () => {
  const src = readFileSync(new URL('../Worker/research/storage.js', import.meta.url), 'utf8');
  const at = src.indexOf('async function handleResearchReports');
  assert.ok(at > 0, 'the handler moved -- this guard needs updating');
  const after = src.slice(at + 10);
  const body = src.slice(at, at + 10 + after.search(/\n(?:export\s+)?(?:async\s+)?function\s+\w+/));
  for (const read of ['JSON.parse', '.json(', 'r2Text(', 'DecompressionStream', '.list(']) {
    assert.equal(body.includes(read), false, `${read} in handleResearchReports`);
  }
  assert.match(body, /encodeBody: 'manual'/, 'or Cloudflare zips the zipped bytes again');
});

test('the route is a gated GET dispatched to this handler', () => {
  const worker = readFileSync(new URL('../Worker/trollmap-worker.js', import.meta.url), 'utf8');
  const list = worker.slice(worker.indexOf('const GATED_READS'), worker.indexOf('async function allowMutation'));
  assert.ok(list.includes('"/research/reports"'));
  assert.match(worker, /path === "\/research\/reports" && request\.method === "GET"\) \{\s*return handleResearchReports\(request, env\);/);
});

// ── the planner's pick ───────────────────────────────────────────────────────────────────────────

const st = (o) => ({
  source: 'AHQ', date: '2024-11-20', species: ['striped bass'], text: 'Stripers on Murray.', who: [],
  lures: [], bait: [], time_of_day: [], sentences: [], depths: [], places: [], area: [], kinds_of_water: [],
  water_temp_f_said: null, ...o,
});
const STATEMENTS = [
  st({ date: '2024-11-20', text: 'Captain Brad Taylor reports stripers schooling on top at Blacks Bridge at first light; trolling bucktails and a topwater plug.',
    who: ['Brad Taylor'], lures: ['bucktail', 'topwater'], time_of_day: ['first light'],
    sentences: [{ said: 'x', fish: ['top'], lures: ['bucktail', 'topwater'], his_way: ['bucktail'], time: ['first light'], ft: [] }],
    depths: [{ ft: [20, 30], kind: 'water' }], places: [{ name: 'Blacks Bridge', lon: -81.5691, lat: 34.0982 }],
    area: ['upper lake'], kinds_of_water: ['creek channels'], water_temp_f_said: 62 }),
  st({ date: '2013-11-24', source: 'Item', text: 'Free-lining herring from mid-lake up to Macedonia, fish 25 feet down over 40 feet.',
    bait: ['live'], sentences: [{ said: 'x', fish: ['suspended'], lures: [], his_way: [], time: [], ft: [25] }],
    depths: [{ ft: [25], kind: 'fish' }, { ft: [40], kind: 'water' }], area: ['mid lake'] }),
  st({ date: '2019-11-21', species: ['black bass'], text: 'Bass on rocky points with a crankbait in 8 feet.',
    lures: ['crankbait'], sentences: [{ said: 'x', fish: [], lures: ['crankbait'], his_way: [], time: [], ft: [] }],
    depths: [{ ft: [8], kind: 'water' }], kinds_of_water: ['points'] }),
  st({ date: '2022-11-01', species: ['crappie'], text: 'Crappie trolled with jigs in 15 feet in the creeks.',
    lures: ['jig'], sentences: [{ said: 'x', fish: ['suspended'], lures: ['jig'], his_way: ['jig'], time: [], ft: [] }] }),
  st({ date: '2006-11-15', text: 'An old report from before 2008.' }),
  st({ date: '2024-06-15', text: 'A June report, nowhere near November.' }),
  st({ date: '2025-11', source: 'YT-BigFishBlanch', species: ['largemouth bass'], text: 'Largemouth on main lake points with a topwater first thing.',
    lures: ['topwater'], time_of_day: ['first light'], sentences: [{ said: 'x', fish: ['top'], lures: ['topwater'], his_way: [], time: ['first light'], ft: [] }] }),
];

test('the window: three weeks either side, round the new year, a month counts when any of it is in', () => {
  assert.equal(inWindow('2019-11-21', '2026-11-14'), true);
  assert.equal(inWindow('2019-12-20', '2026-11-14'), false);
  assert.equal(inWindow('2018-01-03', '2026-12-28'), true, 'across the new year');
  assert.equal(inWindow('2025-11', '2026-11-14'), true, 'a month alone');
  assert.equal(inWindow('2025-10', '2026-11-14'), true, 'late October is within three weeks');
  assert.equal(inWindow('2025-09', '2026-11-14'), false);
  assert.equal(inWindow('', '2026-11-14'), false);
});

test('the pick keeps this time of year from 2008, counts the older ones, and puts his way first', () => {
  const tw = pickThisWeek(STATEMENTS, '2026-11-14');
  assert.equal(tw.near, 6, 'the June one is out');
  assert.equal(tw.older, 1, 'the 2006 one is counted, not used');
  assert.equal(tw.statements.length, 5);
  assert.equal(tw.statements[0].d, '2024-11-20', 'the trolled report with a place, a depth and a time first');
  assert.deepEqual(tw.statements[0].way, ['bucktail']);
  assert.deepEqual(tw.statements[0].pl, [{ n: 'Blacks Bridge', lon: -81.5691, lat: 34.0982 }]);
});

test('his species to the reports\' fish', () => {
  assert.deepEqual([...reportFish(['Striped Bass'])].sort(), ['hybrid striped bass', 'striped bass']);
  assert.deepEqual([...reportFish(['Largemouth Bass'])].sort(), ['black bass', 'largemouth bass']);
  assert.deepEqual([...reportFish('Hybrid')], ['hybrid striped bass']);
  assert.deepEqual([...reportFish('White Bass')], ['white bass']);
  assert.deepEqual([...reportFish(['Catfish', 'Crappie'])].sort(), ['catfish', 'crappie']);
  assert.equal(reportFish(['Bowfin']).size, 0, 'no report names one');
});

test('the block: his fish in full, the others with the facts, no bait, and the places with their positions', () => {
  const tw = pickThisWeek(STATEMENTS, '2026-11-14');
  const b = thisWeekBlock(tw, ['Striped Bass'], '2026-11-14');
  assert.match(b, /WHAT YEARS OF FISHING REPORTS SAY FOR THIS TIME OF YEAR/);
  assert.match(b, /NO live bait on fresh water/);
  assert.match(b, /Stripers: 2 reports/);
  assert.match(b, /Where they sat: top 1, suspended 1/);
  assert.match(b, /Named places: Blacks Bridge 1 \(34\.0982, -81\.5691\)/);
  assert.match(b, /bucktail 1 \(trolled 1\) \[first light 1\]/);
  assert.match(b, /1 of these fished bait only: read them for where and how deep/);
  assert.match(b, /Fish depth stated: 25 ft \(one figure\)/);
  assert.match(b, /- 2024-11-20 AHQ \(Brad Taylor\): "Captain Brad Taylor/, 'his fish speak in their own words');
  assert.match(b, /ALSO IN THESE REPORTS/);
  const also = b.slice(b.indexOf('ALSO IN THESE REPORTS'));
  assert.match(also, /Bass: 1 reports/);
  assert.match(also, /Crappie: 1 reports/);
  assert.equal(/ - \d{4}-/.test(also), false, 'the other fish get the facts, not the quotes');
  assert.ok(b.indexOf('Stripers:') < b.indexOf('ALSO IN THESE REPORTS'), 'his fish first');
});

test('the block says what it cannot say', () => {
  const tw = pickThisWeek(STATEMENTS, '2026-11-14');
  assert.match(thisWeekBlock(tw, ['Bowfin'], '2026-11-14'), /None of these reports names Bowfin; below are the fish they say most about/);
  assert.match(thisWeekBlock({ error: 'the Worker answered HTTP 500' }, [], '2026-11-14'), /could not be read today \(the Worker answered HTTP 500\)/);
  assert.match(thisWeekBlock({ none: 'no reports kept for x', statements: [] }, [], '2026-11-14'), /No fishing reports are kept for this water yet/);
  assert.match(thisWeekBlock(pickThisWeek(STATEMENTS, '2026-03-01'), [], '2026-03-01'), /No report kept for this water falls within 21 days of 2026-03-01/);
  assert.equal(thisWeekBlock(null, [], '2026-11-14'), '');
});

test('his own pastes are counted with the rest, and said to be his', () => {
  const mine = [...STATEMENTS, st({ date: '2025-11-08', source: 'PASTED', who: ['Lakemurraystriper'], text: 'Stripers schooling at Buffalo Creek on top.',
    sentences: [{ said: 'x', fish: ['top'], lures: [], his_way: [], time: [], ft: [] }] })];
  const b = thisWeekBlock(pickThisWeek(mine, '2026-11-14'), ['Striped Bass'], '2026-11-14');
  assert.match(b, /Stripers: 3 reports \([^)]*Pasted by Ryan 1/);
  assert.match(b, /- 2025-11-08 Pasted by Ryan \(Lakemurraystriper\): "Stripers schooling/);
});

test('a saved plan keeps the block it read, not the statements', () => {
  const tw = pickThisWeek(STATEMENTS, '2026-11-14');
  const saved = forSaving(tw, ['Striped Bass'], '2026-11-14');
  assert.equal(saved.statements, undefined);
  assert.equal(saved.kept, 5);
  assert.equal(saved.block, thisWeekBlock(tw, ['Striped Bass'], '2026-11-14'));
  assert.equal(thisWeekBlock(saved, ['Crappie'], '2026-12-25'), saved.block, 'printed as it was read');
});

// ── the read, on both planners ───────────────────────────────────────────────────────────────────

function fakeFetch({ reports = 200, guide = 200 } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/research/reports?water=')) {
      if (reports !== 200) return new Response(JSON.stringify({ ok: false }), { status: reports });
      return new Response(JSON.stringify({ water: 'lake_murray', statements: STATEMENTS }), { status: 200 });
    }
    if (String(url).includes('/guide-reports/')) {
      if (guide !== 200) return new Response('{}', { status: guide });
      return new Response(JSON.stringify({ readAt: '2026-11-06', reports: [{ label: 'AHQ', published: '2026-11-05', text: 'Stripers are schooling.' }] }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  return { f, calls };
}

test('the reports read goes to his Worker with his token, and comes back picked for the day', async () => {
  const { f, calls } = fakeFetch();
  const tw = await askThisWeek({ worker: 'https://w.test/', slug: 'lake_murray', date: '2026-11-14', fetchImpl: f });
  assert.equal(calls[0].url, 'https://w.test/research/reports?water=lake_murray');
  assert.ok(calls[0].init.headers && 'X-Sync-Token' in calls[0].init.headers, 'the route is gated');
  assert.equal(calls[0].init.headers['Content-Type'], undefined, 'a GET carries no body');
  assert.equal(tw.statements.length, 5);
});

test('a water with no file is "none", and a failure is an error, never a throw', async () => {
  assert.ok((await askThisWeek({ worker: 'https://w.test', slug: 'lake_x', date: '2026-11-14', fetchImpl: fakeFetch({ reports: 404 }).f })).none);
  assert.match((await askThisWeek({ worker: 'https://w.test', slug: 'lake_x', date: '2026-11-14', fetchImpl: fakeFetch({ reports: 500 }).f })).error, /HTTP 500/);
  const boom = async () => { throw new Error('offline'); };
  assert.equal((await askThisWeek({ worker: 'https://w.test', slug: 'lake_x', date: '2026-11-14', fetchImpl: boom })).error, 'offline');
  assert.equal(await askThisWeek({ worker: 'https://w.test', slug: 'lake_x', fetchImpl: boom }), null, 'no day, nothing to pick around');
});

test('askGuideReports carries the years of reports, and the plan reads them after this month\'s', async () => {
  const g = await askGuideReports({ worker: 'https://w.test', slug: 'lake_murray', date: '2026-11-14', fetchImpl: fakeFetch().f, pasted: [] });
  assert.equal(g.thisWeek.statements.length, 5);
  const b = guideReportsBlock(g, ['Striped Bass'], '2026-11-14');
  const month = b.indexOf('WHAT THE GUIDES ON THIS WATER REPORTED');
  const years = b.indexOf('WHAT YEARS OF FISHING REPORTS SAY FOR THIS TIME OF YEAR');
  assert.ok(month >= 0 && years > month, 'this month first, then the years');
});

test('when the guides cannot be read the years still reach the plan, and the other way round', async () => {
  const g = await askGuideReports({ worker: 'https://w.test', slug: 'lake_murray', date: '2026-11-14', fetchImpl: fakeFetch({ guide: 503 }).f, pasted: [] });
  assert.match(g.error, /HTTP 503/);
  assert.equal(g.thisWeek.statements.length, 5);
  assert.match(guideReportsBlock(g, ['Striped Bass'], '2026-11-14'), /Stripers: 2 reports/);
  const h = await askGuideReports({ worker: 'https://w.test', slug: 'lake_murray', date: '2026-11-14', fetchImpl: fakeFetch({ reports: 500 }).f, pasted: [] });
  assert.equal(h.reports.length, 1);
  assert.match(guideReportsBlock(h, ['Striped Bass'], '2026-11-14'), /could not be read today \(the Worker answered HTTP 500\)/);
});

test('savedGuide keeps the guides\' reports whole and only the block of the years', async () => {
  const g = await askGuideReports({ worker: 'https://w.test', slug: 'lake_murray', date: '2026-11-14', fetchImpl: fakeFetch().f, pasted: [] });
  const s = savedGuide(g, 'Striped Bass', '2026-11-14');
  assert.deepEqual(s.reports, g.reports);
  assert.equal(s.thisWeek.statements, undefined);
  assert.equal(guideReportsBlock(s, ['Striped Bass'], '2026-11-14'), guideReportsBlock(g, ['Striped Bass'], '2026-11-14'),
    'the trip report shows what the plan read');
  assert.equal(savedGuide(null), null);
});

test('both planners save the guide through savedGuide', () => {
  for (const f of ['smart-plan-v2-wiring.js', 'plan-water-ui.js']) {
    const src = readFileSync(new URL(`../js/modules/${f}`, import.meta.url), 'utf8');
    assert.match(src, /r\.plan\.guideReports = savedGuide\(guide, /, f);
  }
});

// ── the map: the places the reports name for this time of year ──────────────────────────────────

test('the places for this time of year: one a place, every fish there, most-named first', () => {
  const more = [...STATEMENTS,
    st({ date: '2023-11-10', species: ['crappie'], text: 'Crappie trolled on jigs off Blacks Bridge in 18 feet.',
      lures: ['jig'], sentences: [{ said: 'x', fish: ['suspended'], lures: ['jig'], his_way: ['jig'], time: [], ft: [] }],
      places: [{ name: 'Blacks Bridge', lon: -81.5691, lat: 34.0982 }] }),
    st({ date: '2022-11-03', text: 'Stripers busting at Shull Island at first light.', places: [{ name: 'Shull Island', lon: -81.3565, lat: 34.0539 }],
      sentences: [{ said: 'x', fish: ['top'], lures: [], his_way: [], time: ['first light'], ft: [] }], time_of_day: ['first light'] }),
  ];
  const pl = placesThisWeek(pickThisWeek(more, '2026-11-14'));
  assert.deepEqual(pl.map((p) => [p.name, p.n]), [['Blacks Bridge', 2], ['Shull Island', 1]]);
  const bb = pl[0];
  assert.deepEqual(bb.fish.map((f) => [f.name, f.n]), [['Stripers', 1], ['Crappie', 1]]);
  assert.deepEqual(bb.fish[1].lures, [{ lure: 'jig', n: 1, trolled: 1 }], 'he trolls jigs for crappie');
  assert.equal(bb.years, '2023-2024');
  assert.equal(pl[1].fish[0].times[0][0], 'first light');
  assert.deepEqual(placesThisWeek(null), []);
});

test('a pin\'s popup says what the reports say there, in their words, and is safe', () => {
  const p = { name: 'Blacks <Bridge>', lat: 34.1, lon: -81.5, far: true, approx: false, n: 2, years: '2023-2024',
    fish: [{ name: 'Stripers', n: 1, position: [['top', 1]], lures: [{ lure: 'bucktail', n: 1, trolled: 1 }], times: [['first light', 1]],
      fishDepth: null, waterDepth: { n: 1, mid: 25, lo: 25, hi: 25 }, baitOnly: 0 }],
    quotes: [{ d: '2024-11-20', src: srcName('PASTED'), who: ['Brad Taylor'], t: 'Stripers on top at first light.' }] };
  const h = spotHtml(p, { planDate: '2026-11-14', days: 21 });
  assert.match(h, /Blacks &lt;Bridge&gt;/);
  assert.match(h, /2 reports within 21 days of 2026-11-14, 2023-2024/);
  assert.match(h, /more than one spot/);
  assert.match(h, /Stripers 1<\/b>: sat top 1; bucktail 1 \(trolled 1\); first light 1; over 25 ft/);
  assert.match(h, /2024-11-20 Pasted by Ryan \(Brad Taylor\): “Stripers on top at first light.”/);
  assert.equal(pinRadiusPx(1, 1), 13);
  assert.equal(pinRadiusPx(0, 10), 5);
  assert.ok(pinRadiusPx(1, 16) < pinRadiusPx(16, 16));
});

test('the button is on the map\'s layer panel and the module is loaded', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<button id="btnReportSpots"[^>]*>📍 Report spots<\/button>/);
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(main, /import '\.\/modules\/report-spots-layer\.js';/);
  const mod = readFileSync(new URL('../js/modules/report-spots-layer.js', import.meta.url), 'utf8');
  assert.match(mod, /askThisWeek\(\{ worker: CF_WORKER_URL, slug, date \}\)/, 'the same read as the plan');
  assert.match(mod, /pick a lake/, 'greyed and said, never silent, with no water picked');
});

// ── the reports choose the water, and the ramp ──────────────────────────────────────────────────

// Five places on a made-up lake: two near the north ramp, three near the south one, a stripers' report each.
const P = { A: [-81.40, 34.10], B: [-81.38, 34.10], A2: [-81.4005, 34.1003], C: [-81.40, 34.00], D: [-81.38, 34.00] };
const at = (name, n, species = ['striped bass'], extra = {}) => Array.from({ length: n }, (_, i) => st({
  date: `${2010 + i}-11-1${i % 9}`, species, text: `${name} report ${i}.`, places: [{ name, lon: P[name][0], lat: P[name][1] }],
  depths: [{ ft: [25, 35], kind: 'water' }], ...extra }));
const LAKE = [...at('A', 5), ...at('A2', 4), ...at('B', 2), ...at('C', 6), ...at('D', 6), ...at('B', 3, ['crappie'])];

test('the reports choose where the loops turn: most-named for his fish, within reach, apart', () => {
  const tw = pickThisWeek(LAKE, '2026-11-14');
  const north = turnsFromReports(tw, ['Striped Bass'], { ramp: [-81.39, 34.11], reachM: 5000 });
  assert.deepEqual(north.turns.map((t) => [t.name, t.n]), [['A', 5], ['B', 2]],
    'A2 is 40 m from A: one turn; C and D are 11 km off, past half the day');
  assert.match(north.turns[0].why, /^A: 5 reports within 21 days of this date \(2010-2014\) — Stripers 5/);
  assert.deepEqual(north.waterFt, [30, 30], 'the water those reports put his fish over');
  assert.equal(north.anyFish, false);
  const crappie = turnsFromReports(tw, ['Crappie'], { ramp: [-81.39, 34.11], reachM: 5000 });
  assert.deepEqual(crappie.turns.map((t) => t.name), ['B']);
  const bowfin = turnsFromReports(tw, ['Bowfin'], { ramp: [-81.39, 34.11], reachM: 5000 });
  assert.equal(bowfin.anyFish, true, 'no report names one: the places for any fish, said so');
  assert.deepEqual(bowfin.turns.map((t) => t.name), ['A', 'B']);
  assert.deepEqual(turnsFromReports(tw, ['Striped Bass'], { ramp: [-80, 33], reachM: 5000 }).turns, []);
});

// His Short Stay day on Moultrie, 11/6: the reports talk about stripers around the date but put none of them on a place
// near the ramp; the places they do name are the Cooper River (the reader put it at the edge of the lake's box, on the
// houses at Moncks Corner) and B, for crappie. The day was laid at those, for "any fish", turn 1 on land.
const COOPER = { name: 'Cooper River', lon: -81.395, lat: 34.105, approx: 'the edge of the water toward it' };
const SHORT_STAY = [
  ...Array.from({ length: 8 }, (_, i) => st({ date: `${2013 + i}-11-0${(i % 8) + 1}`, species: ['crappie'], text: `Tailrace ${i}.`,
    places: [COOPER], depths: [{ ft: [10], kind: 'water' }] })),
  ...at('B', 2, ['crappie']),
  ...Array.from({ length: 3 }, (_, i) => st({ date: `${2015 + i}-11-12`, text: `Stripers stacked up ${i}.`,
    depths: [{ ft: [30, 40], kind: 'water' }] })),
];

test('a river put at the edge of the lake is no turn and no pin, and his fish is never swapped for another', () => {
  const tw = pickThisWeek(SHORT_STAY, '2026-11-06');
  const pl = placesThisWeek(tw);
  assert.deepEqual(pl.map((p) => [p.name, p.n, p.approx]), [['Cooper River', 8, true], ['B', 2, false]]);
  assert.deepEqual(onTheWater(pl).map((p) => p.name), ['B'], 'not pinned on the land at Moncks Corner');
  const striper = turnsFromReports(tw, ['Striped Bass'], { ramp: [-81.39, 34.11], reachM: 5000 });
  assert.deepEqual(striper.turns, [], 'the reports talk about stripers and name no place for them: no crappie places');
  assert.equal(striper.mentioned, true);
  assert.equal(striper.anyFish, false);
  assert.deepEqual([striper.waterFt, striper.waterN], [[35, 35], 3], 'the depth is the stripers\' and says how many');
  const bowfin = turnsFromReports(tw, ['Bowfin'], { ramp: [-81.39, 34.11], reachM: 5000 });
  assert.equal(bowfin.anyFish, true, 'nothing about bowfin at all: the places for any fish, said so');
  assert.deepEqual(bowfin.turns.map((t) => t.name), ['B'], 'and never the river at the edge');
});

test('the words say whose turns they are and how many depths the line came from', () => {
  const ui = readFileSync(new URL('../js/modules/plan-water-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /via\.length && !\(byReports && viaFromReports\) \?/, 'the reports\' turns are not "the places you clicked"');
  assert.match(ui, /\(\$\{rep\.waterN\} depth\$\{rep\.waterN === 1 \? '' : 's'\} stated\)/, 'never "undefined depths"');
  assert.match(ui, /the reports talk about \$\{T\.species \|\| 'this fish'\} around this date, but none of them names a place for it/);
  assert.doesNotMatch(ui, /rep\.n\} depth/);
  const map = readFileSync(new URL('../js/modules/loop-on-map.js', import.meta.url), 'utf8');
  assert.match(map, /no report place: the same depth, where the day had time left/);
  const pins = readFileSync(new URL('../js/modules/report-spots-layer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(pins, /where it meets the lake/, 'a pin at the box edge is not where a river meets the lake');
});

test('which ramp: every landing by the same reports, and a heads-up only when another is clearly better', () => {
  const tw = pickThisWeek(LAKE, '2026-11-14');
  const landings = [{ name: 'North Ramp', lon: -81.39, lat: 34.11 }, { name: 'South Ramp', lon: -81.39, lat: 34.01 }];
  const a = rampsByReports(tw, ['Striped Bass'], landings, { reachM: 5000, current: [-81.39, 34.11] });
  assert.deepEqual(a.rows.map((r) => [r.name, r.score]), [['South Ramp', 12], ['North Ramp', 7]]);
  assert.equal(a.mine.name, 'North Ramp');
  assert.equal(a.better.name, 'South Ramp');
  assert.deepEqual(a.better.spots, [{ name: 'C', n: 6 }, { name: 'D', n: 6 }]);
  const b = rampsByReports(tw, ['Striped Bass'], landings, { reachM: 5000, current: [-81.39, 34.01] });
  assert.equal(b.better, null, 'from the better ramp, nothing to say');
  assert.ok(crowM([-81.40, 34.10], [-81.40, 34.00]) > 11000);
});

test('the one-troll button lays the reports\' turns, his catches only noted, and says the ramp', () => {
  const ui = readFileSync(new URL('../js/modules/plan-water-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /catches: byReports \? \[\] : catches, via, contourOnly: byReports/, 'his catches choose nothing');
  assert.match(ui, /askThisWeek\(\{ worker: CF_WORKER_URL, slug: T\.r2Key, date: T\.dateStr \}\)/);
  assert.match(ui, /rampsByReports\(tw, T\.species, landings/);
  assert.match(ui, /your catches did not choose this water/);
  assert.match(ui, /reportTurns: T\.reportTurns \|\| \[\], reportSaid/);
  const map = readFileSync(new URL('../js/modules/loop-on-map.js', import.meta.url), 'utf8');
  assert.match(map, /S\.turns = snap\.reportTurns\.slice\(0, MAX_TURNS\)/, 'the report turns are his turns on the map');
  assert.match(map, /noReportTurns: S\.reportsCleared/);
  assert.match(map, /Laid by the fishing reports/);
  assert.match(map, /snap\.rampAdvice/);
});
