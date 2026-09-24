// Personal use only, not for distribution or resale; not for navigation.
//
// SNIPPETS ARE READ IN ONE CALL, AND EACH FACT GOES BACK TO ITS SNIPPET.
//
// research_lakes.py sends discovery's search snippets as one /research/analyze-facts request, and
// the extractor read them one model call apiece -- ~45 calls in series inside that request on the
// Lower Saluda, 2026-09-24, in a run that took 636 s. `combine: true` reads them as one labelled
// text. These run the real handler against a stubbed Gemini that counts its calls.
//
//   node --test test/snippets-are-read-in-one-call.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleResearchAnalyzeFacts } from '../Worker/research/extract.js';

const S = [
  { title: 'Lower Saluda River Trout Report', url: 'https://a.example/1',
    text: 'On the Saluda River below the dam, rainbow trout hold in the riffles at Saluda Shoals in the cool months of the year.' },
  { title: 'Saluda River Striper Notes', url: 'https://b.example/2',
    text: 'Striped bass run up the Saluda River in late spring and hold below the Millrace rapids on live herring at first light.' },
  { title: 'Riverbanks Paddle Guide', url: 'https://c.example/3',
    text: 'The Saluda River level rises fast when the dam generates; paddlers take out at Riverbanks before the water comes up.' },
  { title: 'Too short', url: 'https://d.example/4', text: 'Saluda River, short line.' },
];

function stubGemini(reply) {
  const prompts = [];
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /generativelanguage\.googleapis\.com/);
    const body = JSON.parse(init.body);
    prompts.push(body.contents[0].parts[0].text);
    return { ok: true, status: 200, json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(reply(prompts.length)) }] } }] }) };
  };
  return prompts;
}

const ask = async (docs, extra = {}) => (await handleResearchAnalyzeFacts(new Request('https://w.example/x', {
  method: 'POST', body: JSON.stringify({ lakeName: 'Saluda River (Lower Saluda), SC', baseName: 'Saluda River',
    state: 'SC', docIndex: -1, documents: docs, ...extra }) }), { GEMINI_FREE_API_KEY: 'k' })).json();

const FACTS = { extracted_facts: [
  { fact: 'Rainbow trout hold in riffles at Saluda Shoals in cool months on the Saluda River.',
    quote: 'rainbow trout hold in the riffles at Saluda Shoals', source: 'Search result snippets (3 sources)',
    category: 'seasonalPattern' },
  { fact: 'Striped bass hold below the Millrace rapids on the Saluda River at first light.',
    quote: 'hold below the Millrace rapids on live herring', source: 'whatever the model wrote',
    category: 'holdingPattern' },
  { fact: 'Saluda River paddlers take out at Riverbanks when the dam generates.',
    quote: 'not a verbatim line', source: '[S3] Riverbanks Paddle Guide', category: 'hazard' },
] };

test('combined: one model call for every snippet long enough to read', async () => {
  const prompts = stubGemini(() => FACTS);
  const d = await ask(S, { combine: true });
  assert.equal(prompts.length, 1, 'three snippets, one call -- not three');
  assert.match(prompts[0], /\[S1\] Lower Saluda River Trout Report/);
  assert.match(prompts[0], /\[S3\] Riverbanks Paddle Guide/);
  assert.doesNotMatch(prompts[0], /Too short/, 'under 100 characters, left out as the loop leaves it out');
  assert.equal(d.extracted_facts.length, 3);
});

test('combined: each fact is given back to the snippet its quote came from', async () => {
  stubGemini(() => FACTS);
  const d = await ask(S, { combine: true });
  const by = Object.fromEntries(d.extracted_facts.map((f) => [f.category, f.source]));
  assert.equal(by.seasonalPattern, 'Lower Saluda River Trout Report', 'by its verbatim quote');
  assert.equal(by.holdingPattern, 'Saluda River Striper Notes', 'by its quote, whatever source the model wrote');
  assert.equal(by.hazard, 'Riverbanks Paddle Guide', 'no quote match, so by the [S#] tag it wrote');
});

test('without combine, nothing changes: one call per document', async () => {
  const prompts = stubGemini(() => ({ extracted_facts: [] }));
  await ask(S.slice(0, 3));
  assert.equal(prompts.length, 3);
});

test('combine with a single document is just that document', async () => {
  const prompts = stubGemini(() => ({ extracted_facts: [] }));
  await ask([S[0]], { combine: true });
  assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0], /\[S1\]/);
});
