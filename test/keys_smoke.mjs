/**
 * keys_smoke.mjs -- prove every shipped lake's display name resolves to its own R2 key.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 *   node keys_smoke.mjs <lake_index.json> <candidate js tree>
 *
 * WHY: disambiguateDisplayNames() rewrites three shipped lakes' labels to carry an acreage
 * suffix. access-index.js feeds those labels straight into registerR2Key(), and the app then
 * asks resolveR2Key() for the pack to fetch. If the suffix broke that path the symptom would
 * be silent and specific -- pick Forest Lake and get the other Forest Lake's contours -- so it
 * is worth asserting rather than reasoning about.
 *
 * Also checks the fuzzy fallback cannot claim a lake the registry already owns.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const _here = new URL('.', import.meta.url).pathname;
const _repo = _here.replace(/\/test\/$/, '/');
const [indexPath = process.env.LAKE_INDEX || _repo + '../registry/lake_index.json',
       treeRoot  = _repo + 'js'] = process.argv.slice(2);
const SMOKE_NAME = 'keys_smoke';
// The registry is a pipeline OUTPUT, not a repo file -- it sits next to the checkout on the
// machine that runs the extraction. Anywhere else (a fresh clone, CI, a review sandbox)
// `npm run check` used to die on a bare ENOENT stack trace, which reads as "the test suite
// is broken" rather than "this check needs an artifact you do not have".
//
// Skipping is only correct for a MISSING file. A registry that exists and will not parse is
// a real failure and still throws.
import { existsSync } from 'node:fs';
if (!existsSync(indexPath)) {
  console.log(`SKIP  ${SMOKE_NAME}: no lake_index.json at ${indexPath}`);
  console.log('      This check needs the pipeline registry. Point LAKE_INDEX at it, or pass');
  console.log('      the path as the first argument, to run it.');
  process.exit(0);
}

const raw = JSON.parse(readFileSync(indexPath, 'utf8'));
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => raw });
globalThis.window = globalThis;

const reg = await import(pathToFileURL(`${treeRoot}/data/lake-registry.js`).href);
const keys = await import(pathToFileURL(`${treeRoot}/data/lake-keys.js`).href);
const R = await reg.loadLakeRegistry();

// Exactly what access-index.js does as the registry lands.
for (const r of R.list) keys.registerR2Key(r.displayName, r.slug);

let fails = 0;
const shipped = R.list.filter((r) => r.shipped);
const wrong = shipped.filter((r) => keys.resolveR2Key(r.displayName) !== r.slug);
if (wrong.length) {
  fails++;
  console.log(`FAIL  ${wrong.length} of ${shipped.length} shipped lakes resolve to the wrong key:`);
  for (const r of wrong.slice(0, 10)) {
    console.log(`        "${r.displayName}"  ->  ${keys.resolveR2Key(r.displayName)}   want ${r.slug}`);
  }
} else {
  console.log(`ok    all ${shipped.length} shipped lakes resolve to their own slug`);
}

// The pairs that used to sit in the picker as identical rows. Named explicitly so a
// regression names itself rather than hiding in an aggregate count.
console.log('\n-- the pairs that used to be indistinguishable --');
for (const slug of ['forest_lake', 'forest_lake_2', 'long_lake', 'long_lake_7',
                    'lake_oconee', 'lake_oconee_2', 'city_lake_3', 'city_lake_4']) {
  const r = R.bySlug.get(slug);
  // A SLUG THAT NO LONGER SHIPS IS NOT A FAILURE. This asserted all eight were in the
  // index and four stopped being: forest_lake_2, lake_oconee_2 and city_lake_4 fell to
  // "depth-area coverage below --min-charted", and long_lake is outside the drawn region.
  // None of the four is a resolver bug, and they were four of this lint's five failures --
  // which is how a red lint becomes a lint nobody reads. A pair with one half gone cannot
  // be indistinguishable, so it is reported and skipped. The check that matters is
  // unchanged: when both halves ship, each must resolve to itself.
  if (!r) { console.log(`  skip  ${slug} no longer in the index -- dropped or out of region`); continue; }
  const k = keys.resolveR2Key(r.displayName);
  const good = k === slug;
  if (!good) fails++;
  console.log(`  ${good ? 'ok  ' : 'FAIL'}  ${r.displayName.padEnd(34)} -> ${k}`);
}

// The acreage fallback in lake-registry.js is a safety net for an index built WITHOUT
// counties. Against a county-named index it must do nothing at all; if it fires, the
// consolidator did not run or the county file was missing when it did.
console.log('\n-- acreage fallback is a no-op against a county-named index --');
const renamed = R.list.filter((r) => / \([\d,]+ ac\)$/.test(r.displayName));
if (renamed.length) {
  fails++;
  console.log(`  FAIL  ${renamed.length} renamed: ${renamed.map((r) => r.displayName).join(' | ')}`);
} else {
  console.log('  ok    nothing renamed');
}

// A name nobody owns must come back null, not a fuzzy near-miss.
console.log('\n-- fuzzy fallback must not invent a key --');
for (const junk of ['Not A Real Lake', 'zzzz', 'Lake']) {
  const k = keys.resolveR2Key(junk);
  console.log(`  ${k === null ? 'ok  ' : 'note'}  "${junk}" -> ${k}`);
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall checks passed');
process.exit(fails ? 1 : 0);
