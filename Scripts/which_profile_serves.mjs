// which_profile_serves.mjs -- which stored profile the PICKER's names actually reach.
//
// Personal use only, not for distribution or resale; not for navigation.
//
//     node .\Scripts\which_profile_serves.mjs --registry "F:\TrollMapPipeline\registry" `
//                                             --json "F:\TrollMapPipeline\registry\_profile_conflicts.json"
//
// IT ASKS WITH THE NAME THE CALLER PASSES, WHICH IS NOT THE REGISTRY'S.
//
// Ryan, 2026-09-04, twice: *"you are using county names when the research picker uses the name
// from the dnr feeds"*, and then, after the first version of this script cleared Richard B
// Russell: *"The app is showing me Lake Richard Russell, GA"* -- with the thin draft attached.
//
// He was right both times. The picker fills from getUniversalLakeNames, which keys every
// waterbody in the DNR feeds through displayLakeName(rawName, stateCode) -- the feed's own
// spelling plus ONE state. Georgia's feed calls the reservoir "Lake Richard Russell", so the
// picker offers "Lake Richard Russell, GA", which sanitizes straight onto lake_richard_russell_ga
// and never gets near the verified lake_russell_sc. Resolving from the registry's
// "Richard B Russell Lake (Abbeville Co, SC/GA)" answers a question the app never asks.
//
// So this enumerates the PICKER's names -- displayLakeName over registry\_dnr_ramps_<st>.json,
// the same four feeds the app fetches -- and imports displayLakeName itself rather than
// reimplementing it. It also imports keys.js and registry.js and runs the real resolver over the
// mirror. Nothing here restates a rule that lives in the app.
//
// WHAT IT FINDS
//
// A COLLISION: one water offered under two picker names that reach DIFFERENT profiles. Georgia
// and South Carolina both list the same reservoir under their own spelling, so the lake appears
// twice and the two entries can carry different research. Which one Ryan taps decides what he
// reads.
//
// AN UNREACHED PROFILE: stored research no picker name arrives at. It is storage nobody can read.
//
// IT READS THE MIRROR, NOT R2. Run mirror_research_profiles.py first.
import fs from 'node:fs';
import path from 'node:path';
import { resolveResearchStorageId } from '../Worker/research/keys.js';
import { identityNamesForLake } from '../Worker/registry.js';

// access-index.js publishes legacy helpers on `window` at module scope, so it needs one before it
// can be imported under node -- the shim test/live-ramps-reach-the-filter.test.js uses.
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const { displayLakeName } = await import('../js/data/access-index.js');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const REG = arg('--registry', 'F:\\TrollMapPipeline\\registry');
const MIRROR = path.join(REG, '_research_profiles');

if (!fs.existsSync(MIRROR)) {
  console.log(`no mirror at ${MIRROR} -- run mirror_research_profiles.py first`);
  process.exit(2);
}
const index = JSON.parse(fs.readFileSync(path.join(REG, 'lake_index.json'), 'utf8'));
const files = fs.readdirSync(MIRROR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
const ids = files.map((f) => f.slice(0, -5));
const has = new Set(ids);

/** {id: [species]} and {id: status}, for saying WHICH of a pair is the one worth keeping. */
const species = {}, status = {}, updated = {}, detail = {};
for (const id of ids) {
  const p = JSON.parse(fs.readFileSync(path.join(MIRROR, `${id}.json`), 'utf8'));
  species[id] = ((p.biology || {}).predatorSpecies || []).length;
  status[id] = (p.metadata || {}).status || '?';
  updated[id] = String((p.metadata || {}).lastUpdated || '').slice(0, 10);
  detail[id] = {
    id,
    species: species[id],
    status: status[id],
    updated: updated[id],
    version: (p.metadata || {}).versionNumber,
    sources: (p.sources || []).length,
    facts: p._extractedFactsCount || 0,
    maxDepthFt: p.maxDepthFt || (p.limnology || {}).maxDepthFt || null,
    // Species count alone does not separate a thin profile from a good one -- Lanier's two both
    // carry six -- so what backs them travels with the count.
    biologyReason: ((p.confidence || {}).biology || {}).reason || null,
  };
}

const STATES = ['ga', 'nc', 'sc', 'tn'];
const pickerNames = new Map();          // display name -> the feed spelling it came from
for (const st of STATES) {
  const f = path.join(REG, `_dnr_ramps_${st}.json`);
  if (!fs.existsSync(f)) continue;
  const feed = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const wb of Object.keys(feed.waterbodies || {})) {
    const shown = displayLakeName(wb, (feed.state || st).toUpperCase());
    if (shown) pickerNames.set(shown, wb);
  }
}

const reached = new Set();
const serves = new Map();               // picker name -> stored id
for (const name of pickerNames.keys()) {
  const alts = identityNamesForLake(index, name) || [];
  const probe = (id) => Promise.resolve(has.has(id) ? { id } : null);
  // eslint-disable-next-line no-await-in-loop
  const found = await resolveResearchStorageId(name, probe, alts);
  if (found) { serves.set(name, found.id); reached.add(found.id); }
}

// A COLLISION is one profile-bearing water offered twice. Two picker names that resolve to
// different profiles AND share a registry row are the same lake wearing two states' spellings.
const rowFor = (name) => {
  const alts = identityNamesForLake(index, name) || [];
  return alts.length ? alts[0] : null;          // identityNamesForLake leads with display_name
};
const byRow = new Map();
for (const [name, id] of serves) {
  const row = rowFor(name);
  if (!row) continue;
  if (!byRow.has(row)) byRow.set(row, new Map());
  byRow.get(row).set(name, id);
}
const forks = [];
for (const [row, entries] of byRow) {
  const idsHere = new Set(entries.values());
  if (idsHere.size < 2) continue;
  const ranked = [...idsHere].sort((a, b) =>
    (status[b] === 'verified') - (status[a] === 'verified')
    || (detail[b].sources || 0) - (detail[a].sources || 0));
  forks.push({
    slug: row, name: row,
    entries: [...entries].map(([n, id]) => ({ pickerName: n, id })),
    hits: [...idsHere],
    best: ranked[0],
  });
}

const line = (id, mark) => `      ${mark} ${id.padEnd(34)} ${String(species[id]).padStart(2)} species  ` +
  `${status[id].padEnd(9)} updated ${updated[id]}`;

console.log(`${pickerNames.size} picker names, ${ids.length} mirrored profiles, ` +
  `${serves.size} names reach one, ${reached.size} profiles are reachable`);

console.log(`\nCOLLISIONS -- one water offered under names that reach DIFFERENT profiles (${forks.length}):`);
if (!forks.length) console.log('   none.');
for (const f of forks) {
  console.log(`   ${f.name}`);
  for (const e of f.entries) {
    console.log(`      "${e.pickerName}"`);
    console.log(line(e.id, e.id === f.best ? 'KEEP    ' : 'thin    '));
  }
}

const orphans = ids.filter((id) => !reached.has(id)).sort();
console.log(`\nUNREACHED -- stored profiles no picker name arrives at (${orphans.length}):`);
if (!orphans.length) console.log('   none.');
for (const id of orphans) console.log(line(id, '        '));

// THE REPORT IS ALSO A FILE, because the thing that acts on it is a Python script and the only
// correct answer to "which key wins" comes from running the Worker's own resolver, which is here.
// prune_shadowed_profiles.py refuses to delete anything this file does not list as shadowed.
const out = arg('--json', '');
if (out) {
  fs.writeFileSync(out, `${JSON.stringify({
    generated: new Date().toISOString().slice(0, 10),
    mirror: MIRROR,
    asked_with: 'displayLakeName over registry/_dnr_ramps_<st>.json -- the picker\'s own names',
    forks: forks.map((f) => ({
      slug: f.slug,
      name: f.name,
      picker_names: f.entries,
      served: f.hits.find((id) => id !== f.best) || null,
      served_detail: detail[f.hits.find((id) => id !== f.best)] || null,
      shadowed: [detail[f.best]],
    })),
    orphans: orphans.map((id) => detail[id]),
  }, null, 1)}\n`);
  console.log(`\n-> ${out}`);
}


