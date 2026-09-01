/**
 * research_todo.mjs — which waters the Research tab would offer, asked of the app's own code.
 *
 * WHY THIS EXISTS. research_lakes.py needed to know which lakes have no profile yet, and three
 * attempts to answer that offline were all wrong. It matched /research/list against ids derived
 * from lake_index.json's county-stamped display_name — "Wateree Lake (Kershaw Co, SC)" — and
 * nothing is stored under that. The app asks with the access index's name, "Lake Wateree, SC",
 * which is what the profile is filed as. Measured against the live bucket 2026-09-01: of 64
 * research waters only 29 resolved, and 22 of the 35 that did not had a profile the app shows.
 *
 * Ryan, looking at the app: "but all of those are able to be seen in the app..." — and then, of
 * the workaround that had him paste the dropdown's list into a text file: "this is dumb". Both
 * right. The app computes this list on every page load and the answer should come from there.
 *
 * The bind all three offline attempts got wrong is findExistingLakeKey() inside access-index.js:
 * a DNR feed waterbody within 15 km that also matches by name, else the registry's own display
 * name. Name equality missed Lanier. Curated-file name equality missed it too. Geometry alone
 * bound Tuckertown Reservoir to High Rock Lake, whose bounds box contains it. It is a real join,
 * it is tuned, and it was already written.
 *
 * So this is populateResearchLakeDropdown() with the DOM taken out — the same modules, the same
 * order, the same six lines. If the dropdown is right, this is right; if the dropdown changes,
 * this follows it.
 *
 *   node Scripts/research_todo.mjs [--rivers] [--json out.json]
 *
 * Emits JSON -- {worth, researched, todo:[{name, state, aliases}]} -- on stdout, or to --json.
 * Never a bare list: see the note about console.info below.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */

// access-index.js reads the worker base off `window` and publishes its loaders there. That is the
// only browser surface any of this touches; there is no DOM below.
globalThis.window = globalThis;
window.TROLLMAP_WORKER_URL = process.env.TROLLMAP_WORKER_URL
  || 'https://trollmap-worker.colonal1981.workers.dev';

const args = process.argv.slice(2);
const withRivers = args.includes('--rivers');
const jsonAt = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;

// STDOUT IS NOT A CHANNEL THIS SCRIPT OWNS. access-index.js reports what it did with
// console.info -- five lines about folded feed names, contributed registry lakes, dropped access
// points -- and in node console.info goes to STDOUT, not stderr. The first --todo run piped those
// five lines into the batch as if they were waters and started researching "[access-index] folded
// 18 feed name(s) onto the water they share a name and a launch with".
//
// So the app's chatter is pushed to stderr where it belongs, and the answer leaves through a JSON
// file rather than a text stream anything can write to.
for (const k of ['log', 'info', 'debug']) {
  const write = (...a) => process.stderr.write(a.join(' ') + '\n');
  console[k] = write;
}

const { registryRecordFor } = await import('../js/data/access-index.js');
const { isCoastalKey } = await import('../js/data/coastal-zones.js');
const { resolveR2Key } = await import('../js/data/lake-keys.js');
const { makePredicate } = await import('../js/data/water-filter.js');
const { researchedNames } = await import('../js/data/research-ids.js');

let all = [];
try {
  all = await window.getUniversalLakeNamesAsync();
} catch (e) {
  console.error(`!! the access index failed to load: ${e.message}`);
}


// ── populateResearchLakeDropdown(), lake-research-ui.js, minus the DOM ──────────────────────
const inland = all.filter((name) => !isCoastalKey(resolveR2Key(name)));
const keep = makePredicate('research', null, { includeRivers: withRivers });
const worth = inland.filter((n) => keep(registryRecordFor(n), n));

// A RESEARCH POPULATION OF ZERO IS IMPOSSIBLE, so it means the index did not load rather than
// that there is nothing to do. Checked here and not on the raw name count, because a failed load
// still yields a name or two and any threshold on that number would be invented.
if (!worth.length) {
  console.error(`!! ${all.length} name(s) and none of them filterable -- the access index did not`);
  console.error('   load. It is built from live worker feeds, so this has to run where');
  console.error('   research_lakes.py runs: a machine with a route to the worker.');
  process.exit(2);
}

let list;
try {
  const res = await fetch(`${window.TROLLMAP_WORKER_URL}/research/list`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  list = await res.json();
} catch (e) {
  console.error(`!! /research/list failed: ${e.message}`);
  process.exit(1);
}
const done = researchedNames(worth, list.lakes || []);
const todo = worth.filter((n) => !done.has(n));
// ───────────────────────────────────────────────────────────────────────────────────────────

console.error(`${all.length} names offered, ${worth.length} worth researching, `
            + `${list.count} profiles in R2 — ${done.size} researched, ${todo.length} not`);

// THE STATE AND THE ALIASES TRAVEL WITH THE NAME, because the caller cannot work them out.
// These are the app's names -- "HYCO LAKE, NC", "Nottely Lake, GA" -- and they are not keys in
// lake_index.json, so research_lakes.py's registry lookup missed every one of them and fell back
// to state=SC. Georgia and Tennessee waters were about to be researched under South Carolina
// regulations. registryRecordFor() is the binding that produced the name in the first place and
// it is sitting right here, so it answers both questions at the source.
const rows = todo.map((name) => {
  const rec = registryRecordFor(name);
  const suffix = /,\s*([A-Z]{2})(?:\/[A-Z]{2})*\s*$/.exec(name);
  return {
    name,
    state: (rec && rec.state) || (suffix && suffix[1]) || null,
    aliases: rec
      ? [rec.name, rec.displayName, ...(rec.legacyDisplayNames || [])].filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i)
      : [name],
  };
});
const unstated = rows.filter((r) => !r.state).map((r) => r.name);
if (unstated.length) console.error(`!! no state for: ${unstated.join(', ')}`);

const { writeFileSync } = await import('node:fs');
const out = JSON.stringify({ generated: new Date().toISOString(),
  worth: worth.length, researched: [...done].sort(), todo: rows }, null, 2);
if (jsonAt) { writeFileSync(jsonAt, out); console.error(`-> ${jsonAt}`); }
else process.stdout.write(out);
