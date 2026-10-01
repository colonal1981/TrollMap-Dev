// A report Ryan read himself, pasted in, reaches the plan with the guides'.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-01, on what would help the plan: "for 6 i do not have AHQ subscription... we could
// use this for current facebook or other posts i guess though", then "You can do #5-6". The case
// behind it: Santee Cooper Country's October post, which the Worker can only find as a search
// preview ("anglers should start looking for fish in 30-45 ...") and he can read on his phone.
//
// What these hold:
//   1. a paste is kept only with its date and its water, and a lake only on Marion and Moultrie;
//   2. a Santee Cooper paste is read on both lakes' plans;
//   3. "who wrote it" in his words finds the source it names, so the paste is the newer report by
//      the same guides and the preview and the September page step aside the usual way;
//   4. its depth of water marks lanes on the lake he said, or on the lake its sentence says, and on
//      neither when neither is said -- the guides' own rule;
//   5. it reaches the plan when the Worker cannot be read, and the prompt says it is his;
//   6. one from this month in an earlier year is history, and marks nothing;
//   7. the card is on the page, wired, and the paste syncs as type `report`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pastedRecord, pastedForWater, sameGuidesAs, pastedAsReports, PASTE_KIND }
  from '../js/modules/pasted-reports.js';
import { askGuideReports, guideReportsBlock, reportWaterForLanes } from '../js/modules/guide-reports.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, '..', f), 'utf8');

const SCC = 'Capt. Joe Dennis and Capt. Kyle Austin';
// What the Worker answered on 2026-10-01, trimmed: the September page and the October preview.
const WORKER_BODY = {
  readAt: '2026-10-01T20:50:00Z',
  reports: [
    { kind: 'page', label: 'Santee Cooper Country fishing report', guides: SCC, published: '2026-09-04',
      publishedFrom: "the page's own last-modified time", url: 'https://www.santeecoopercountry.org/fishing/fishing-reports/',
      text: '## Striper\n\nStriper season is closed.\n\nThe drift fishing at night has also been good in 10 to 15 ft of water.' },
    { kind: 'facebook', label: 'Santee Cooper Country on Facebook', guides: SCC, author: 'Santee Cooper Country',
      preview: true, monthYear: '2026-10', url: 'https://www.facebook.com/santeecoopercountrysouthcarolina',
      text: 'OCTOBER 2026 FISHING REPORT Santee Cooper & Cooper River STRIPERS Striper season opens October 1st, and anglers should start looking for fish in 30–45 ...' },
  ],
  checked: [],
};
// The post itself, as he would paste it (its striper sentence, as Santee Cooper Country wrote it).
const POST = 'OCTOBER 2026 FISHING REPORT\nSantee Cooper & Cooper River\n\nSTRIPERS\nStriper season opens October 1st, and anglers should start looking for fish in 30-45 feet of water along flats and creek areas.';

const worker = 'https://w.example';
const fakeFetch = (body) => async (url) => (String(url).includes('/guide-reports/')
  ? { ok: true, status: 200, json: async () => body }
  : { ok: false, status: 404, json: async () => null });
const paste = (over = {}) => pastedRecord({ text: POST, date: '2026-10-01', from: 'Santee Cooper Country',
  slug: 'lake_marion', now: new Date('2026-10-01T21:00:00Z'), ...over }).record;

test('a paste is kept only with its text, its date and its water; a lake only on Marion and Moultrie', () => {
  assert.equal(pastedRecord({ text: POST, slug: 'lake_marion' }).ok, false);
  assert.match(pastedRecord({ text: POST, slug: 'lake_marion' }).why, /date/);
  assert.match(pastedRecord({ text: ' ', date: '2026-10-01', slug: 'lake_marion' }).why, /Paste/);
  assert.match(pastedRecord({ text: POST, date: '2026-10-01' }).why, /water/);
  const r = paste({ aboutLake: 'lake_moultrie' });
  assert.equal(r.kind, PASTE_KIND);
  assert.equal(r.aboutLake, 'lake_moultrie');
  assert.equal(r.key, r.id);
  assert.equal(pastedRecord({ text: POST, date: '2026-10-01', slug: 'wateree_lake', aboutLake: 'lake_marion' }).record.aboutLake, null);
});

test('a Santee Cooper paste is read on both lakes, and on no other water', () => {
  const r = paste();
  assert.equal(pastedForWater([r], 'lake_marion').length, 1);
  assert.equal(pastedForWater([r], 'lake_moultrie').length, 1);
  assert.equal(pastedForWater([r], 'wateree_lake').length, 0);
});

test('who wrote it, in his words, finds the source it names -- or none', () => {
  const src = WORKER_BODY.reports;
  assert.equal(sameGuidesAs('Santee Cooper Country', src).guides, SCC);
  assert.equal(sameGuidesAs('capt joe dennis', src).guides, SCC);
  assert.equal(sameGuidesAs('a friend at the ramp', src), null);
  assert.equal(sameGuidesAs('', src), null);
});

test('the paste is the newer report by the same guides: the preview and the September page step aside', async () => {
  const g = await askGuideReports({ worker, slug: 'lake_marion', date: '2026-10-02',
    fetchImpl: fakeFetch(WORKER_BODY), pasted: [paste()] });
  const byLabel = Object.fromEntries(g.reports.map((r) => [r.label, r]));
  const mine = byLabel['Pasted by Ryan: Santee Cooper Country'];
  assert.ok(mine && mine.pasted);
  assert.equal(mine.guides, SCC);
  assert.ok(byLabel['Santee Cooper Country on Facebook'].supersededBy);
  assert.ok(byLabel['Santee Cooper Country fishing report'].supersededBy);
  assert.equal(mine.supersededBy, undefined);
});

test('its water marks lanes on the lake he said, or the lake its sentence says, and on neither when neither is said', async () => {
  const ask = (slug, rec) => askGuideReports({ worker, slug, date: '2026-10-02', fetchImpl: fakeFetch(WORKER_BODY), pasted: [rec] });
  const ft = async (slug, rec) => reportWaterForLanes(await ask(slug, rec), ['Striped Bass'], '2026-10-02').map((w) => w.ft);
  // He did not say, and the sentence does not: the guides' rule, no lane on either lake.
  assert.deepEqual(await ft('lake_marion', paste()), []);
  assert.deepEqual(await ft('lake_moultrie', paste()), []);
  // He said Moultrie: Moultrie's lanes, not Marion's.
  assert.deepEqual(await ft('lake_moultrie', paste({ aboutLake: 'lake_moultrie' })), [[30, 45]]);
  assert.deepEqual(await ft('lake_marion', paste({ aboutLake: 'lake_moultrie' })), []);
  // He said Marion, but the sentence names Moultrie: the sentence wins.
  const named = paste({ aboutLake: 'lake_marion', text: POST.replace('look', 'on Lake Moultrie look') });
  assert.deepEqual(await ft('lake_marion', named), []);
  assert.deepEqual(await ft('lake_moultrie', named), [[30, 45]]);
  // Off Santee Cooper there is no lake to say: the paste is about the water it was pasted for.
  const wateree = pastedRecord({ text: 'Stripers are in 25-35 feet of water near the dam.', date: '2026-09-28',
    slug: 'wateree_lake', now: new Date('2026-10-01T21:00:00Z') }).record;
  const gw = await askGuideReports({ worker, slug: 'wateree_lake', date: '2026-10-02',
    fetchImpl: fakeFetch({ reports: [] }), pasted: [wateree] });
  assert.deepEqual(reportWaterForLanes(gw, ['Striped Bass'], '2026-10-02').map((w) => w.ft), [[25, 35]]);
});

test('it reaches the plan when the Worker cannot be read, and the prompt says it is his', async () => {
  const down = async () => { throw new Error('network down'); };
  const g = await askGuideReports({ worker, slug: 'lake_moultrie', date: '2026-10-02', fetchImpl: down,
    pasted: [paste({ aboutLake: 'lake_moultrie' })] });
  assert.match(g.error, /network down/);
  assert.equal(g.reports.length, 1);
  const block = guideReportsBlock(g, ['Striped Bass'], '2026-10-02');
  assert.match(block, /could not be read today \(network down\)/);
  assert.match(block, /--- Pasted by Ryan: Santee Cooper Country -- 2026-10-01 \(the date Ryan gave it when he pasted it\) -- about Lake Moultrie, he said/);
  assert.match(block, /one he read himself/);
  assert.match(block, /30-45 ft of water on Moultrie \(said in Ryan's own note on it\)/);
  assert.deepEqual(reportWaterForLanes(g, ['Striped Bass'], '2026-10-02').map((w) => w.ft), [[30, 45]]);
  // With nothing pasted the Worker's failure reads as it always did.
  const none = await askGuideReports({ worker, slug: 'lake_moultrie', date: '2026-10-02', fetchImpl: down, pasted: [] });
  assert.equal(none.reports, undefined);
  assert.match(guideReportsBlock(none, ['Striped Bass'], '2026-10-02'), /^\nWHAT THE GUIDES ON THIS WATER REPORTED\nThey could not be read today/);
});

test('one from this month in an earlier year is history, printed and marking nothing', () => {
  const old = paste({ date: '2025-10-20', aboutLake: 'lake_moultrie' });
  const [r] = pastedAsReports([old], '2026-10-02', []);
  assert.equal(r.role, 'same month, an earlier year');
  const block = guideReportsBlock({ reports: [r] }, ['Striped Bass'], '2026-10-02');
  assert.match(block, /-- same month, an earlier year/);
  assert.deepEqual(reportWaterForLanes({ reports: [r] }, ['Striped Bass'], '2026-10-02'), []);
});

test('the card is on the page and wired, and a paste syncs as type report', () => {
  const html = read('index.html');
  for (const id of ['pastedReportsCard', 'pastedReportText', 'pastedReportDate', 'pastedReportFrom',
    'pastedReportLake', 'pastedReportSave', 'pastedReportList']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(read('js/modules/smart-plan-v2-wiring.js'), /wirePasteBox\(\{/);
  assert.match(read('js/modules/cloud-sync.js'), /report: 'settings'/);
  assert.match(read('Worker/trollmap-worker.js'), /SYNC_STORES = \[[^\]]*"report"/);
});
