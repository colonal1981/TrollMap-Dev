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

// THE APP'S OWN LIST, NOT A RECONSTRUCTION OF IT. access-index.js merges /ramps, /paddle and
// the 3DHP registry, folds duplicate spellings onto the water they share a launch with, and drops
// access points that sit outside the lake they were filed under. Enumerating the raw feeds skips
// all of that and produces names the picker never shows -- "Lake Russell, SC" among them, which
// is how this script cleared Richard B Russell twice. Ryan: "Lake Russell, SC does not show in my
// picker at all". So `fetch` is stubbed with the saved feeds and getUniversalLakeNamesAsync() --
// the function the research picker itself awaits -- is called.
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;

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

// The saved feeds stand in for the Worker. These four files ARE the /ramps and /paddle responses.
globalThis.fetch = async (url) => {
  const u = String(url);
  const m = u.match(/\/(ramps|paddle)\?state=([A-Za-z]{2})/);
  let f = null;
  if (m) f = path.join(REG, `_dnr_${m[1]}_${m[2].toLowerCase()}.json`);
  else if (u.includes('/chartpacks/_registry/lake_index.json')) f = path.join(REG, 'lake_index.json');
  if (!f || !fs.existsSync(f)) return { ok: false, status: 404, json: async () => ({}) };
  const body = JSON.parse(fs.readFileSync(f, 'utf8'));
  return { ok: true, status: 200, json: async () => body };
};
await import('../js/data/access-index.js');
const pickerNames = await globalThis.getUniversalLakeNamesAsync();

const line = (id, mark) => `      ${mark} ${id.padEnd(34)} ${String(species[id]).padStart(2)} species  ` +
  `${status[id].padEnd(9)} ${String(detail[id].sources).padStart(2)} sources  updated ${updated[id]}`;

const reached = new Set();
const serves = new Map();               // picker name -> stored id
for (const name of pickerNames) {
  const alts = identityNamesForLake(index, name) || [];
  const probe = (id) => Promise.resolve(has.has(id) ? { id } : null);
  // eslint-disable-next-line no-await-in-loop
  const found = await resolveResearchStorageId(name, probe, alts);
  if (found) { serves.set(name, found.id); reached.add(found.id); }
}

// A FORK is a stored profile the picker cannot reach whose WATER it can. Measured against the
// app's real list there are no waters offered twice -- access-index folds those -- so the shape
// is not two entries disagreeing, it is one entry landing on the wrong half of a pair. Nottely
// and Watauga each serve a three-source batch draft while their verified profile sits unreachable.
const rowFor = (name) => {
  const alts = identityNamesForLake(index, name) || [];
  return alts.length ? alts[0] : null;      // identityNamesForLake leads with display_name
};
const servedByRow = new Map();
for (const [name, id] of serves) {
  const row = rowFor(name);
  if (row && !servedByRow.has(row)) servedByRow.set(row, { name, id });
}
// TWO NAMES FOR ONE WATER THAT REACH DIFFERENT PROFILES. The universal list holds both
// "Lake Sidney Lanier (Hall Co, GA)" and "Lake Lanier, GA"; the research picker shows only the
// first, and it lands on the thin draft while the verified profile is reachable ONLY by a name
// that never appears on screen. Neither profile is an orphan, so the orphan pass below cannot
// see it -- both conditions have to be checked or a lake falls between them.
const forksFromNames = [];
const idsByRow = new Map();
for (const [name, id] of serves) {
  const row = rowFor(name);
  if (!row) continue;
  if (!idsByRow.has(row)) idsByRow.set(row, new Map());
  idsByRow.get(row).set(id, name);
}
for (const [row, byId] of idsByRow) {
  if (byId.size < 2) continue;
  const ranked = [...byId.keys()].sort((a, b) =>
    (status[b] === 'verified') - (status[a] === 'verified')
    || (detail[b].sources || 0) - (detail[a].sources || 0));
  const [best, ...rest] = ranked;
  for (const worse of rest) {
    forksFromNames.push({
      slug: row, name: row,
      picker_names: [{ pickerName: byId.get(worse), id: worse }],
      served: worse, hits: [worse, best], best,
    });
  }
}

const orphans = ids.filter((id) => !reached.has(id)).sort();
const forks = [...forksFromNames];
const stranded = [];
for (const id of orphans) {
  const prof = JSON.parse(fs.readFileSync(path.join(MIRROR, `${id}.json`), 'utf8'));
  const row = rowFor(String(prof.lakeName || ''));
  const live = row ? servedByRow.get(row) : null;
  if (live && live.id !== id) {
    forks.push({
      slug: row, name: row, picker_names: [{ pickerName: live.name, id: live.id }],
      served: live.id, hits: [live.id, id], best: id,
    });
  } else {
    stranded.push(id);
  }
}

console.log(`${pickerNames.length} picker names, ${ids.length} mirrored profiles, ` +
  `${serves.size} names reach one, ${reached.size} profiles are reachable`);

console.log(`\nFORKS -- the picker reaches one half of a pair (${forks.length}):`);
if (!forks.length) console.log('   none.');
for (const f of forks) {
  console.log(`   ${f.name}   picker shows "${f.picker_names[0].pickerName}"`);
  console.log(line(f.served, 'SERVED  '));
  console.log(line(f.best, 'hidden  '));
}

console.log(`\nSTRANDED -- stored profiles no picker name reaches, and no live sibling (${stranded.length}):`);
if (!stranded.length) console.log('   none.');
for (const id of stranded) console.log(line(id, '        '));

const out = arg('--json', '');
if (out) {
  fs.writeFileSync(out, `${JSON.stringify({
    generated: new Date().toISOString().slice(0, 10),
    mirror: MIRROR,
    asked_with: 'displayLakeName over registry/_dnr_ramps_<st>.json -- the picker\'s own names',
    forks: forks.map((f) => ({
      slug: f.slug, name: f.name, picker_names: f.picker_names,
      served: f.served, served_detail: detail[f.served], shadowed: [detail[f.best]],
    })),
    orphans: stranded.map((id) => detail[id]),
  }, null, 1)}\n`);
  console.log(`\n-> ${out}`);
}


