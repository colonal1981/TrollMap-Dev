// reach_places.mjs -- js/utils/reach-places.js, run for research_lakes.py.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Reads ONE JSON object on stdin and writes one on stdout, the way gate_documents() runs
// doc-relevance.js: the rule lives in one JavaScript file and Python never learns it.
//
//   {"mode": "places", "registry": "<dir>", "lakeName": "...", "slug": "..."}
//       -> {target, group, siblings, search, own, other}
//   {"mode": "sort", "reach": {...}, "facts": [...], "documents": [...]}
//       -> {facts: {keep, elsewhere}, documents: {keep, elsewhere}}
//
// By hand, from F:\TrollMapPipeline:
//   '{"mode":"places","registry":"registry","lakeName":"Saluda River, SC","slug":"saluda_river_2"}' |
//     node .\TrollMap-Dev\Scripts\reach_places.mjs
import fs from 'node:fs';
import path from 'node:path';
import { reachPlaces, sortFacts, sortDocuments } from '../js/utils/reach-places.js';
import { researchStorageId, stripLakeQualifiers } from '../js/data/research-ids.js';

const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const say = (o) => process.stdout.write(JSON.stringify(o));

if (input.mode === 'places') {
  const reg = String(input.registry || 'registry');
  const index = JSON.parse(fs.readFileSync(path.join(reg, 'lake_index.json'), 'utf8'));
  // THE GAUGES ARE OPTIONAL. Without water_bindings.json the places come from launches alone,
  // which is less to search on and the same rule -- not a reason to refuse the water.
  let bindings = {};
  const wbp = path.join(reg, 'water_bindings.json');
  if (fs.existsSync(wbp)) {
    const wb = JSON.parse(fs.readFileSync(wbp, 'utf8'));
    bindings = (wb && wb.bindings) || wb || {};
  }
  // THE STATE'S OWN WATER NAMES, from the ramp and paddle feeds the app reads -- the only place
  // "North Saluda River" is written down as a water. Every feed file is read; a name from another
  // state that happens to end in this river's name is still a different water.
  const feedNames = [];
  for (const f of fs.readdirSync(reg)) {
    if (!/^_dnr_(ramps|paddle)_[a-z]{2}\.json$/.test(f)) continue;
    try {
      const wbs = (JSON.parse(fs.readFileSync(path.join(reg, f), 'utf8')) || {}).waterbodies;
      if (wbs && typeof wbs === 'object') feedNames.push(...Object.keys(wbs));
    } catch { /* a feed that does not parse adds no names; the registry's still apply */ }
  }
  say(reachPlaces({
    index, bindings, lakeName: String(input.lakeName || ''), slug: input.slug || null,
    storageId: researchStorageId, stripQualifiers: stripLakeQualifiers, feedNames,
  }));
} else if (input.mode === 'sort') {
  say({
    facts: sortFacts(input.facts || [], input.reach || {}),
    documents: sortDocuments(input.documents || [], input.reach || {}),
  });
} else {
  process.stderr.write(`reach_places.mjs: unknown mode ${JSON.stringify(input.mode)}\n`);
  process.exit(2);
}
