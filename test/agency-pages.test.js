// The state's own lake index, resolved to the water this app ships.
//
// FIXTURES ARE REAL. Every name and path below was read off the live index on 2026-08-16 --
// dnr.sc.gov/lakes/search.html, tn.gov/twra/fishing/where-to-fish.html and its region pages --
// and the registry names come from registry/lake_index.json. The <a> scaffolding around the
// links is minimal, because this sandbox reaches those hosts only through a markdown-converting
// fetcher and cannot capture raw bytes; the hrefs and the anchor text are what is being pinned
// and both are verbatim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScdnrIndex, parseTwraRegions, parseTwraRegion, pickAgencyPage, resolveAgencyPage, tnUrl,
  agencyPageAgrees,
} from '../Worker/research/agency-pages.js';

// ── SCDNR: all 31 pages the index offers ────────────────────────────────────────────────────
const SCDNR = [
  ['Fishing Creek Reservoir', '/lakes/fishingcreek/description.html'],
  ['Lake Greenwood', '/lakes/greenwood/description.html'],
  ['Lake Hartwell', '/lakes/hartwell/description.html'],
  ['Lake Jocassee', '/lakes/jocassee/description.html'],
  ['Lake Keowee', '/lakes/keowee/description.html'],
  ['Lake Marion', '/lakes/marion/description.html'],
  ['Lake Monticello', '/lakes/monticello/description.html'],
  ['Lake Moultrie', '/lakes/moultrie/description.html'],
  ['Lake Murray', '/lakes/murray/description.html'],
  ['Lake Russell', '/lakes/russell/description.html'],
  ['Lake Secession', '/lakes/secession/description.html'],
  ['Lake Thurmond', '/lakes/thurmond/description.html'],
  ['Lake Wateree', '/lakes/wateree/description.html'],
  ['Lake Wylie', '/lakes/wylie/description.html'],
  ['Ashwood Lake', '/lakes/state/ashwood/index.html'],
  ['Cherokee Lake', '/lakes/state/cherokee/index.html'],
  ["Dargan's Pond", '/lakes/state/dargans/index.html'],
  ['Draper WMA Lake', '/lakes/state/draper/index.html'],
  ['Edgar Brown Lake', '/lakes/state/edgarbrown/index.html'],
  ['Edwin Johnson Lake', '/lakes/state/edwinjohnson/index.html'],
  ['George Warren Lake', '/lakes/state/georgewarren/index.html'],
  ['John D. Long Lake', '/lakes/state/johndlong/index.html'],
  ['Jonesville Lake', '/lakes/state/jonesville/index.html'],
  ['Lancaster Reservoir', '/lakes/state/lancasterreservoir/index.html'],
  ['Mountain Lake 1', '/lakes/state/mountainlakes/index.html'],
  ['Mountain Lake 2', '/lakes/state/mountainlakes/index.html'],
  ['Oliphant Lake', '/lakes/state/oliphant/index.html'],
  ['Paul Wallace Lake', '/lakes/state/paulwallace/index.html'],
  ['Star Fort Pond', '/lakes/state/starfort/index.html'],
  ['Sunrise Lake', '/lakes/state/sunrise/index.html'],
  ['Thicketty Lake', '/lakes/state/thicketty/index.html'],
];
const SCDNR_INDEX_HTML = `<html><body><ul>${SCDNR
  .map(([n, p]) => `<li><a href="${p}">${n}</a></li>`).join('')}</ul></body></html>`;

// ── TWRA: the four regions, and two of the region pages ─────────────────────────────────────
const TWRA_INDEX_HTML = `<html><body>
<a href="https://www.tn.gov/content/tn/twra/fishing/where-to-fish/west-tennessee-r1.html">Region 1</a>
<a href="https://www.tn.gov/content/tn/twra/fishing/where-to-fish/middle-tennessee-r2.html">Region 2</a>
<a href="https://www.tn.gov/content/tn/twra/fishing/where-to-fish/cumberland-plateau-r3.html">Region 3</a>
<a href="https://www.tn.gov/content/tn/twra/fishing/where-to-fish/east-tennessee-r4.html">Region 4</a>
</body></html>`;

const R4 = [
  ['Calderwood Reservoir', 'calderwood-lake'], ['Boone Reservoir', 'boone-lake'],
  ['Cherokee Reservoir', 'cherokee-reservoir'], ['Chilhowee Reservoir', 'chilhowee-reservoir'],
  ['Douglas Reservoir', 'douglas-reservoir'], ['Ft. Loudoun Reservoir', 'fort-loudoun-reservoir'],
  ['Ft Patrick Henry Reservoir', 'fort-patrick-henry'], ['Melton Hill Reservoir', 'melton-hill-reservoir'],
  ['Norris Reservoir', 'norris-reservoir'], ['South Holston Reservoir', 'south-holston-reservoir'],
  ['Tellico Reservoir', 'tellico-reservoir'], ['Watauga Reservoir', 'watauga-reservoir'],
];
const R1 = [
  ['Barkley Reservoir', 'barkley-reservoir'], ["Brown's Creek Lake", 'browns-creek-lake'],
  ['Carroll Lake', 'carroll-lake'], ['Davy Crockett Lake', 'davy-crockett-lake'],
  ['Garrett Lake', 'garrett-lake'], ['Gibson County Lake', 'gibson-county-lake'],
  ['Glenn Springs Lake', 'glenn-springs-lake'], ['Bill Dance Lake', 'Bill-Dance-Lake'],
  ['Kentucky Reservoir', 'kentucky-reservoir'], ['Lake Graham', 'lake-graham'],
  ['Lake Halford', 'lake-halford'], ['Maples Creek Lake', 'maples-creek-lake'],
  ['Pickwick Reservoir', 'pickwick-reservoir'], ['Reelfoot Reservoir', 'reelfoot-lake'],
  ['Whiteville Lake', 'whiteville-lake'],
];
const regionHtml = (region, rows) => `<html><body>${rows
  .map(([n, slug]) => `<a href="https://www.tn.gov/content/tn/twra/fishing/where-to-fish/${region}/${slug}.html">${n}</a>`)
  .join('')}</body></html>`;

// ── registry names, verbatim ────────────────────────────────────────────────────────────────
const MARION      = ['Lake Marion', 'Lake Marion (Clarendon Co, SC)', 'Lake Marion, SC'];
const MOULTRIE    = ['Lake Moultrie', 'Lake Moultrie (Berkeley Co, SC)', 'Lake Moultrie, SC'];
const THURMOND    = ['J. Strom Thurmond Reservoir', 'J. Strom Thurmond Reservoir, GA/SC', 'Clarks Hill / Thurmond, SC/GA'];
const WATEREE_LK  = ['Wateree Lake', 'Wateree Lake (Kershaw Co, SC)', 'Lake Wateree, SC'];
const WATEREE_RIV = ['Wateree River', 'Wateree River (Richland Co, SC)', 'Wateree River, SC'];
const FT_LOUDOUN  = ['Fort Loudoun Lake', 'Fort Loudoun Lake (Knox Co, TN)', 'Fort Loudoun Lake, TN'];
const CALDERWOOD  = ['Calderwood Lake', 'Calderwood Lake, TN'];
const DAVY        = ['Davy Crockett Lake', 'Davy Crockett Lake, TN'];
const CHEROKEE_TN = ['Cherokee Lake', 'Cherokee Lake (Hawkins Co, TN)', 'Cherokee Lake, TN'];
const CHILHOWEE   = ['Chilhowee Lake', 'Chilhowee Lake, TN'];

// ── parsers ─────────────────────────────────────────────────────────────────────────────────

test('SCDNR: all thirty-one lake pages are found, both URL shapes', () => {
  const e = parseScdnrIndex(SCDNR_INDEX_HTML);
  assert.equal(e.length, 31);
  assert.equal(e.filter((x) => x.url.includes('/lakes/state/')).length, 17);
  assert.equal(e.find((x) => x.name === 'Lake Marion').url,
    'https://www.dnr.sc.gov/lakes/marion/description.html');
});

test('SCDNR: two entries share one URL and both survive', () => {
  // Mountain Lake 1 and Mountain Lake 2 both point at /lakes/state/mountainlakes/index.html.
  // Keying on URL alone would silently drop one.
  const e = parseScdnrIndex(SCDNR_INDEX_HTML).filter((x) => x.url.includes('mountainlakes'));
  assert.equal(e.length, 2);
});

test('TWRA: all four regions come off the index', () => {
  const r = parseTwraRegions(TWRA_INDEX_HTML);
  assert.equal(r.length, 4);
  assert.ok(r.includes('https://www.tn.gov/twra/fishing/where-to-fish/west-tennessee-r1.html'));
});

test('TWRA: the /content/tn/ path is rewritten, because only the bare path answered', () => {
  assert.equal(tnUrl('https://www.tn.gov/content/tn/twra/fishing/where-to-fish/east-tennessee-r4.html'),
    'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4.html');
});

test('TWRA: a region page yields every lake it lists', () => {
  assert.equal(parseTwraRegion(regionHtml('east-tennessee-r4', R4)).length, 12);
  assert.equal(parseTwraRegion(regionHtml('west-tennessee-r1', R1)).length, 15);
});

// ── matching ────────────────────────────────────────────────────────────────────────────────

test('the two Santee lakes do not claim each other', () => {
  const e = parseScdnrIndex(SCDNR_INDEX_HTML);
  assert.equal(pickAgencyPage(e, MARION).url, 'https://www.dnr.sc.gov/lakes/marion/description.html');
  assert.equal(pickAgencyPage(e, MOULTRIE).url, 'https://www.dnr.sc.gov/lakes/moultrie/description.html');
});

test('SCDNR names a lake nothing else calls it, and the alias set carries it', () => {
  // The index says "Lake Thurmond". The registry says "J. Strom Thurmond Reservoir".
  const e = parseScdnrIndex(SCDNR_INDEX_HTML);
  assert.equal(pickAgencyPage(e, THURMOND).url, 'https://www.dnr.sc.gov/lakes/thurmond/description.html');
  // and with only the registry's primary name it still resolves, because subset works both ways
  assert.equal(pickAgencyPage(e, ['J. Strom Thurmond Reservoir']).name, 'Lake Thurmond');
});

test('the river does not take the lake page', () => {
  const e = parseScdnrIndex(SCDNR_INDEX_HTML);
  assert.equal(pickAgencyPage(e, WATEREE_LK).url, 'https://www.dnr.sc.gov/lakes/wateree/description.html');
  assert.equal(pickAgencyPage(e, WATEREE_RIV), null);
});

test('TWRA abbreviates and the registry does not', () => {
  const e = parseTwraRegion(regionHtml('east-tennessee-r4', R4));
  // "Ft. Loudoun Reservoir" -> "Fort Loudoun Lake". Three characters, one shipped lake.
  assert.equal(pickAgencyPage(e, FT_LOUDOUN).name, 'Ft. Loudoun Reservoir');
  assert.ok(pickAgencyPage(e, FT_LOUDOUN).url.endsWith('/fort-loudoun-reservoir.html'));
});

test('Calderwood is the one shipped TN lake the static table actually misses', () => {
  // Nine of the ten shipped TN lakes are on region 4's index; Calderwood is the one that was
  // never copied into the R2 static set.
  const r4 = parseTwraRegion(regionHtml('east-tennessee-r4', R4));
  assert.ok(pickAgencyPage(r4, CALDERWOOD).url.endsWith('/calderwood-lake.html'));
});

test('TWRA region 1 Davy Crockett is a DIFFERENT lake and must not bind', () => {
  // Ryan, 2026-08-16: "region 1 lakes are probably not eastern TN are these lakes even
  // shipped?" He is right, and it is worse than scope. TWRA's r1 page describes a lake of
  // "approximately 87 acres" in CROCKETT County, west Tennessee. The registry's
  // davy_crockett_lake is 204.4 acres in GREENE County on the Nolichucky, 400 km east.
  // Two lakes, one name. Name matching alone cannot tell them apart -- which is exactly why
  // build_water_bindings.py refuses name-only matches -- so the county on the page is the
  // discriminator, and a page that names a different county is refused.
  const r1 = parseTwraRegion(regionHtml('west-tennessee-r1', R1));
  const hit = pickAgencyPage(r1, DAVY);
  assert.ok(hit, 'the name does match -- that is the trap');
  assert.equal(agencyPageAgrees(hit, { county: 'Greene' }, 'Davy Crockett Lake is approximately 87 acres in Crockett County'), false);
  // and the east-Tennessee lake it IS about would be accepted
  assert.equal(agencyPageAgrees(hit, { county: 'Crockett' }, 'Davy Crockett Lake is approximately 87 acres in Crockett County'), true);
  // a page that states no county at all cannot discriminate, so it is allowed through
  assert.equal(agencyPageAgrees(hit, { county: 'Greene' }, 'A pleasant lake with bluegill and bass.'), true);
});

test('Cherokee and Chilhowee sit next to each other and do not swap', () => {
  const e = parseTwraRegion(regionHtml('east-tennessee-r4', R4));
  assert.ok(pickAgencyPage(e, CHEROKEE_TN).url.endsWith('/cherokee-reservoir.html'));
  assert.ok(pickAgencyPage(e, CHILHOWEE).url.endsWith('/chilhowee-reservoir.html'));
});

test('a water the state does not publish returns null, not a guess', () => {
  const e = parseScdnrIndex(SCDNR_INDEX_HTML);
  assert.equal(pickAgencyPage(e, ['Lake Robinson', 'Lake Robinson, SC']), null);
});

// ── end to end, no network ──────────────────────────────────────────────────────────────────

test('SC resolves from the index alone, with the fetcher injected', async () => {
  const calls = [];
  const fake = async (url) => { calls.push(url); return SCDNR_INDEX_HTML; };
  const hit = await resolveAgencyPage('SC', MARION, fake);
  assert.equal(hit.authority, 'SCDNR');
  assert.equal(hit.url, 'https://www.dnr.sc.gov/lakes/marion/description.html');
  assert.equal(hit.matched, 'Lake Marion');
  assert.equal(calls[0], 'https://www.dnr.sc.gov/lakes/search.html');
});

test('TN reads all four regions, not just the one the lake is in', async () => {
  const seen = [];
  const fake = async (url) => {
    seen.push(url);
    if (url.endsWith('where-to-fish.html')) return TWRA_INDEX_HTML;
    if (url.includes('west-tennessee-r1')) return regionHtml('west-tennessee-r1', R1);
    if (url.includes('east-tennessee-r4')) return regionHtml('east-tennessee-r4', R4);
    return '<html></html>';
  };
  const hit = await resolveAgencyPage('TN', DAVY, fake);
  assert.equal(hit.authority, 'TWRA');
  assert.ok(hit.url.endsWith('/davy-crockett-lake.html'));
  assert.equal(seen.length, 5);   // one index + four regions
});

test('Georgia is deliberately not here, and a dead index returns null rather than throwing', async () => {
  assert.equal(await resolveAgencyPage('GA', ['Lake Oconee'], async () => '<html></html>'), null);
  assert.equal(await resolveAgencyPage('NC', ['Lake Norman'], async () => '<html></html>'), null);
});
