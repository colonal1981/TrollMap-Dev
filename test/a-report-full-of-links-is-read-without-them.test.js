// Personal use only, not for distribution or resale; not for navigation.
//
// A REPORT FULL OF LINKS IS READ WITHOUT THEM, NOT REFUSED.
//
// extract.js refused any page with more than 40 URLs making up over 15% of its words as an
// "index/search page". AHQ's weekly fishing reports sit inside a sidebar and archive of links, and
// the Lake Jocassee 2023 Week 38 report (239 URLs, 323 words of report) and the Monticello Week 40
// report were refused with "All documents were index/search pages". Now such a page is read with its
// link targets taken out. These run the real handler against a stubbed Gemini.
//
//   node --test test/a-report-full-of-links-is-read-without-them.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleResearchAnalyzeFacts } from '../Worker/research/extract.js';

const archive = Array.from({ length: 60 }, (_, i) =>
  `[Week ${i + 1} report](https://www.example.com/lake-jocassee-2023-week-${i + 1}?ref=side&id=${i})`).join('\n');
const REPORT = `${archive}\n\nSeptember 21, 2023. Lake Jocassee water temperature is 78 degrees. Spotted bass `
  + 'are schooling over points in 25-35 feet of water and anglers are catching them on drop shots. '
  + 'Trout are holding 80-100 feet down near the dam and trollers are pulling spoons behind downriggers.\n'
  + `${archive}`;
const INDEX = archive + '\n' + archive;

function stubGemini() {
  const prompts = [];
  globalThis.fetch = async (url, init) => {
    prompts.push(JSON.parse(init.body).contents[0].parts[0].text);
    return { ok: true, status: 200, json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ extracted_facts: [] }) }] } }] }) };
  };
  return prompts;
}

const ask = async (docs) => handleResearchAnalyzeFacts(new Request('https://w.example/x', {
  method: 'POST', body: JSON.stringify({ lakeName: 'Lake Jocassee, SC', state: 'SC', docIndex: -1,
    documents: docs }) }), { GEMINI_FREE_API_KEY: 'k' });

test('the weekly report is read, and the model sees the report without the links', async () => {
  const prompts = stubGemini();
  const res = await ask([{ title: 'AHQ INSIDER Lake Jocassee (SC) 2023 Week 38', url: 'https://a.example/w38', text: REPORT }]);
  assert.equal(res.status, 200, 'not "All documents were index/search pages"');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Spotted bass are schooling over points in 25-35 feet of water/);
  assert.match(prompts[0], /Week 12 report/, 'a link keeps its text');
  assert.doesNotMatch(prompts[0], /lake-jocassee-2023-week-12\?ref=side/, 'and loses its address');
});

test('a page that is only links still gets no model call and no refusal', async () => {
  const prompts = stubGemini();
  const res = await ask([{ title: 'Search results', url: 'https://s.example/q', text: INDEX }]);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.extracted_facts || [], []);
  assert.ok(prompts.length <= 1, 'at most the one read of what little text is left');
});

test('only a page that trips the test is changed, and the reply says how many were', async () => {
  stubGemini();
  const text = 'See [the SCDNR page](https://dnr.sc.gov/lakes/jocassee) for rules. '
    + REPORT.split('\n\n')[1].split('\n')[0];
  const plain = await (await ask([{ title: 'Jocassee notes', url: 'https://n.example/1', text }])).json();
  assert.equal(plain.meta.delinkedPages, 0);
  const both = await (await ask([{ title: 'Jocassee notes', url: 'https://n.example/1', text },
    { title: 'AHQ Week 38', url: 'https://a.example/w38', text: REPORT }])).json();
  assert.equal(both.meta.delinkedPages, 1);
  assert.equal(both.meta.totalDocs, 2);
});
