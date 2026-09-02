// The off-lake gate, which could not be tested where it used to live.
//
// It ran inside handleResearchSaveNormalized on a Worker that is on the Cloudflare FREE plan:
// 10 ms of CPU per request, and unlike the paid plan's 30 s that number is NOT configurable.
// Parsing 1.8 MB of JSON, scanning the first 3,000 characters of every document and
// re-serialising the array does not fit in 10 ms. From wrangler tail, 2026-08-16:
//
//     POST /research/save-normalized - Exceeded CPU Limit
//     ✘ [ERROR] Error: Worker exceeded CPU time limit.
//
// Behaviour is a straight port. The point of the move is that the browser has no CPU ceiling
// and already holds the documents — and that the rule is now something a test can run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lakeTerms, isOnLakeDoc, prepareNormalizedDocuments, offLakeReason } from '../js/utils/doc-relevance.js';

const doc = (o) => ({ title: '', url: '', fullText: '', ...o });

test('the county suffix does not leak into the base name', () => {
  // The bug that cost a 95% profile earlier the same day, in a third place.
  assert.deepEqual(lakeTerms('Wateree Lake (Kershaw Co, SC)'), { baseName: 'Wateree Lake', state: 'SC' });
  assert.deepEqual(lakeTerms('Lake Marion, SC'), { baseName: 'Marion', state: 'SC' });
  assert.deepEqual(lakeTerms('Norris Lake'), { baseName: 'Norris Lake', state: '' });
});

test('name AND state — this is what keeps Marion, Minnesota out', () => {
  const mn = doc({ title: 'Marion Lake fisheries survey', url: 'https://dnr.state.mn.us/marion',
    fullText: 'Marion Lake in Minnesota supports walleye and northern pike.' });
  assert.equal(isOnLakeDoc(mn, 'Lake Marion, SC'), false);

  const sc = doc({ title: 'Lake Marion striper report', url: 'https://example.com/marion',
    fullText: 'Lake Marion, South Carolina — the Santee Cooper system.' });
  assert.equal(isOnLakeDoc(sc, 'Lake Marion, SC'), true);
});

test('an official source is never dropped for failing a substring test', () => {
  const scdnr = doc({ title: 'Lake description', url: 'https://www.dnr.sc.gov/lakes/wateree/description.html',
    fullText: 'nothing here repeats the name' });
  assert.equal(isOnLakeDoc(scdnr, 'Wateree Lake (Kershaw Co, SC)'), true);
  const epa = doc({ url: 'https://nepis.epa.gov/Exe/ZyPURL.cgi?Dockey=00001K2S.TXT', fullText: '' });
  assert.equal(isOnLakeDoc(epa, 'Lake Marion, SC'), true);
});

test('a document that never names the water is dropped', () => {
  const off = doc({ title: 'Trout stocking in western North Carolina',
    url: 'https://example.com/x', fullText: 'Delayed harvest waters open in October.' });
  assert.equal(isOnLakeDoc(off, 'Lake Marion, SC'), false);
});

test('only the first 3,000 characters are scanned, which is the CPU the Worker did not have', () => {
  const buried = doc({ title: 'Report', url: 'https://example.com/y',
    fullText: `${'x'.repeat(5000)} Lake Marion South Carolina` });
  assert.equal(isOnLakeDoc(buried, 'Lake Marion, SC'), false);
  const early = doc({ title: 'Report', url: 'https://example.com/y',
    fullText: `Lake Marion South Carolina ${'x'.repeat(5000)}` });
  assert.equal(isOnLakeDoc(early, 'Lake Marion, SC'), true);
});

test('the prepared array is exactly what the Worker will store, counts included', () => {
  const docs = [
    doc({ title: 'Lake Marion striper report', url: 'https://a.com', fullText: 'Lake Marion, South Carolina.' }),
    doc({ title: 'Minnesota walleye', url: 'https://b.com', fullText: 'Marion Lake, Minnesota.' }),
    doc({ title: 'SCDNR', url: 'https://www.dnr.sc.gov/lakes/marion/description.html', fullText: '' }),
  ];
  const out = prepareNormalizedDocuments(docs, 'Lake Marion, SC', [['biology'], ['habitat'], ['identity']], '2026-08-16T00:00:00.000Z');
  assert.equal(out.total, 3);
  assert.equal(out.rejected, 1);
  assert.equal(out.documents.length, 2);
  assert.deepEqual(out.documents[0].agentTags, ['biology']);
  assert.equal(out.documents[0].discoveredBy, 'biology');
  assert.equal(out.documents[0].fetchedAt, '2026-08-16T00:00:00.000Z');
  // agentTags are positional against the ORIGINAL list, so a dropped doc must not shift them.
  // The SCDNR page is index 2 of the input and was tagged 'identity'. The Worker's version
  // mapped over the filtered array and would call it 'habitat' — document 1's tag, slid down.
  assert.equal(out.documents[1].discoveredBy, 'identity');
  assert.deepEqual(out.documents[1].agentTags, ['identity']);
});

test('an empty payload is not an error, it is an empty payload', () => {
  const out = prepareNormalizedDocuments([], 'Lake Marion, SC');
  assert.deepEqual(out, { documents: [], refused: [], rejected: 0, total: 0 });
  assert.equal(prepareNormalizedDocuments(null, 'x').total, 0);
});

test("NC WRC's own stocking system is an official source", () => {
  // Dropped from NANTAHALA LAKE (Macon Co, NC) on the 64-water run of 2026-09-02 -- the only one
  // of 77 distinct refusals that was about the water it was refused for. The county PDF names no
  // lake in its title and no state anywhere, so both halves of the name/state test fail it, which
  // is exactly what OFFICIAL_SOURCE is for: this pipeline reads ncpaws.org in four other places
  // and every NC profile's stocking plan is built from it.
  const doc = {
    title: 'Macon County - 2026 MASTER TROUT STOCKING LIST',
    url: 'https://www.ncpaws.org/RSReports/FishStock/TroutCountyPDF.aspx?countyID=56',
    text: 'Hatchery Supported Trout Waters',
  };
  assert.equal(isOnLakeDoc(doc, 'Nantahala Lake (Macon Co, NC)'), true);
});

test('the operator that built the lake writes about it without saying which state it is in', () => {
  // RANDLEMAN LAKE (Randolph Co, NC). Piedmont Triad Regional Water Authority built and runs this
  // reservoir; the page prices the fishing pier and says which launches take gasoline, electric
  // only and paddle. Refused on the 2026-09-02 run for never writing "North Carolina" -- which a
  // local authority writing for local people does not.
  const doc = {
    title: 'Reservoir Recreation – Piedmont Triad Regional Water Authority',
    url: 'https://triadncwater.gov/reservoir-recreation',
    fullText: 'Randleman Regional Reservoir Operating Hours for 2026. Click to view current '
            + 'conditions at Randleman Lake. Pier Fishing $3 per person. Gasoline boats, '
            + 'electric motors, kayaks and canoes.',
  };
  assert.equal(offLakeReason(doc, 'Randleman Lake (Randolph Co, NC)'), null);
});

test('a riverkeeper naming the reservoir at the top of its own reach is about that reservoir', () => {
  // PARR SHOALS RESERVOIR (Fairfield Co, SC). The page names the species in the water, gives the
  // mean flow, and names the one public landing below the dam.
  const doc = {
    title: 'Congaree Riverkeeper | Broad River',
    url: 'https://www.congareeriverkeeper.org/lower-broad-river',
    fullText: "The Congaree Riverkeeper's geographical scope includes a 22-mile stretch of the "
            + 'Broad River, from the Parr Shoals Reservoir located in Newberry County down to its '
            + 'confluence with the Lower Saluda River. Largemouth and smallmouth bass, bluegill, '
            + 'catfish and shad. Average flow 5,316 cubic feet per second.',
  };
  assert.equal(offLakeReason(doc, 'Parr Shoals Reservoir (Fairfield Co, SC)'), null);
});

test('the reason says which half refused it', () => {
  const noName = { title: 'Lake Fork Crappie Fishing Report | Seasonal Patterns',
                   url: 'https://lakeforktrophybass.com/seasonal-patterns', fullText: 'crappie' };
  assert.equal(offLakeReason(noName, 'Lake Wateree, SC'), 'no_name');

  // Named in the title, and the title says Texas.
  const elsewhere = { title: 'Crappie and White Bass on Cedar Creek Lake Texas',
                      url: 'https://www.bigcrappie.com/how-to-guides/cedar-creek',
                      fullText: 'Cedar Creek Lake' };
  assert.equal(offLakeReason(elsewhere, 'Cedar Creek Reservoir (Lancaster Co, SC)'), 'other_state');

  // An agency domain never needs either half.
  assert.equal(offLakeReason({ url: 'https://www.ncpaws.org/RSReports/FishStock/x.aspx' },
                             'Nantahala Lake (Macon Co, NC)'), null);
});
