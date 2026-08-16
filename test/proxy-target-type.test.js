// Whether a proxy target is a PDF, and why the URL has to outrank the caller's type param.
//
// From wrangler tail against the live Worker, 2026-08-16:
//
//   GET /research/proxy-download?url=...J_Strom_Thurmond_Project_2022_Master_Plan.pdf
//       ...&type=HTML - Exceeded CPU Limit
//   (warn) TinyFish fetch error ...: selector_unsupported
//   (warn) TinyFish insufficient content (0 chars) ... — trying Firecrawl
//   (log) [scrape.do] cost=1 remaining=477
//   ✘ [ERROR] Error: Worker exceeded CPU time limit.
//
// A caller asked for a .pdf with type=HTML. `sourceType === 'HTML'` won unconditionally, so
// the HTML chain ran on a binary document: TinyFish cannot select against a PDF, then
// scrape.do fetched the whole file and .text() decoded megabytes of binary as UTF-8 — which is
// where the Free plan's 10 ms went. It could never have produced HTML, it burned a scrape.do
// credit per attempt, and it skipped the USACE PDF branch that exists for this exact document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPdfTarget } from '../Worker/research/download.js';

const MASTER_PLAN = 'https://www.sas.usace.army.mil/Portals/61/docs/lakes/thurmond/'
  + 'J_Strom_Thurmond_Project_2022_Master_Plan.pdf?ver=WO6BrF10fdgh4N03fWlyCg%3D%3D';

test('the real URL that was killing the Worker is a PDF, whatever the caller said', () => {
  assert.equal(isPdfTarget(MASTER_PLAN, 'HTML'), true);
  assert.equal(isPdfTarget(MASTER_PLAN, 'PDF'), true);
  assert.equal(isPdfTarget(MASTER_PLAN, ''), true);
});

test('a query string after .pdf does not hide it', () => {
  assert.equal(isPdfTarget('https://x.gov/a/b.pdf?ver=abc', 'HTML'), true);
  assert.equal(isPdfTarget('https://x.gov/a/b.pdf#page=3', 'HTML'), true);
  assert.equal(isPdfTarget('https://x.gov/a/b.PDF', 'HTML'), true);
});

test('an ordinary page is still HTML', () => {
  assert.equal(isPdfTarget('https://www.dnr.sc.gov/lakes/wateree/description.html', 'HTML'), false);
  assert.equal(isPdfTarget('https://georgiawildlife.blog/category/fishing/feed/', ''), false);
});

test('a page that merely mentions pdf in a parameter is not forced to PDF by the URL rule', () => {
  // .pdf is not at the end, so the strict rule does not fire and the caller's type decides.
  const viewer = 'https://x.gov/viewer.html?doc=report.pdf&mode=read';
  assert.equal(isPdfTarget(viewer, 'HTML'), false);
});

test('type=PDF still works when the URL gives nothing away', () => {
  assert.equal(isPdfTarget('https://nepis.epa.gov/Exe/ZyPURL.cgi?Dockey=00001K2S', 'PDF'), true);
  assert.equal(isPdfTarget('https://nepis.epa.gov/Exe/ZyPURL.cgi?Dockey=00001K2S', 'HTML'), false);
});

test('no target at all is not a PDF, and does not throw', () => {
  assert.equal(isPdfTarget('', 'HTML'), false);
  assert.equal(isPdfTarget(null), false);
  assert.equal(isPdfTarget(undefined, undefined), false);
});
