// which_profile_serves.mjs -- which stored profile each water actually gets, and what is shadowed.
//
// Personal use only, not for distribution or resale; not for navigation.
//
//     node .\Scripts\which_profile_serves.mjs --registry "F:\TrollMapPipeline\registry"
//
// WHY THIS IS JAVASCRIPT AND NOT ANOTHER PYTHON SCRIPT
//
// The question is "which key does resolveResearchStorageId land on", and the only correct answer
// comes from running that function. This project has now guessed at that resolver twice in one
// day and been wrong both times -- once reporting 25 unreachable profiles that were all fine, and
// once sending 46 approvals that all 404ed. So this imports Worker/research/keys.js and
// Worker/registry.js and runs them, with the mirror on the drive standing in for the bucket.
//
// WHAT IT FINDS
//
// A FORK: two or more mirrored profiles reachable from one water's names. Four exist, all created
// 2026-09-01 by research_lakes.py driving from the registry's county-stamped display names before
// /research/save learned to resolve through legacy_display_names. In every one the older profile
// is the better one, and in three of the four the app serves the newer, thinner one.
//
// AN ORPHAN: a mirrored profile no water's names reach. It is storage nobody can read, and it is
// also the state a fork's loser lands in if the resolution order ever shifts again.
//
// IT READS THE MIRROR, NOT R2. Run mirror_research_profiles.py first. The mirror carries every
// key /research/list returns, so the key SET is the bucket's; if the two have drifted this
// answers for the drive, which is the honest thing a drive-side script can answer.
import fs from 'node:fs';
import path from 'node:path';
import { resolveResearchStorageId } from '../Worker/research/keys.js';
import { identityNamesForLake } from '../Worker/registry.js';

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

const reached = new Set();
const forks = [], served = new Map();

for (const [slug, row] of Object.entries(index)) {
  if (!row || typeof row !== 'object') continue;
  const name = row.display_name || row.name || slug;
  const alts = identityNamesForLake(index, name) || [];
  // EVERY id this water can reach, found by removing the winner and asking again. A fork is only
  // visible from the loser's side, and the loser is exactly what a single resolve never returns.
  const hits = [];
  const excluded = new Set();
  for (;;) {
    const probe = (id) => Promise.resolve(has.has(id) && !excluded.has(id) ? { id } : null);
    // eslint-disable-next-line no-await-in-loop
    const found = await resolveResearchStorageId(name, probe, alts);
    if (!found) break;
    hits.push(found.id);
    excluded.add(found.id);
    if (hits.length > 6) break;                 // a runaway is a bug, not a water with seven
  }
  for (const id of hits) reached.add(id);
  if (hits.length) served.set(slug, hits);
  if (hits.length > 1) forks.push({ slug, name, hits });
}

const line = (id, mark) => `      ${mark} ${id.padEnd(34)} ${String(species[id]).padStart(2)} species  ` +
  `${status[id].padEnd(9)} updated ${updated[id]}`;

console.log(`${Object.keys(index).length} waters, ${ids.length} mirrored profiles, ` +
  `${served.size} waters reach one, ${reached.size} profiles are reachable`);

console.log(`\nFORKS -- more than one profile reachable from one water (${forks.length}):`);
if (!forks.length) console.log('   none.');
for (const f of forks) {
  console.log(`   ${f.name}`);
  f.hits.forEach((id, i) => console.log(line(id, i === 0 ? 'SERVED  ' : 'shadowed')));
}

const orphans = ids.filter((id) => !reached.has(id)).sort();
console.log(`\nORPHANS -- mirrored profiles no water's names reach (${orphans.length}):`);
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
    forks: forks.map((f) => ({
      slug: f.slug,
      name: f.name,
      served: f.hits[0],
      shadowed: f.hits.slice(1).map((id) => detail[id]),
      served_detail: detail[f.hits[0]],
    })),
    orphans: orphans.map((id) => detail[id]),
  }, null, 1)}\n`);
  console.log(`\n-> ${out}`);
}

const blank = [...served.entries()].filter(([, h]) => !species[h[0]]);
if (blank.length) {
  console.log(`\nSERVED A PROFILE WITH NO SPECIES (${blank.length}):`);
  for (const [slug, h] of blank) console.log(`   ${(index[slug].display_name || slug)} -> ${h[0]}`);
}
