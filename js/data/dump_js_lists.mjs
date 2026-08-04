// Dump the hardcoded JS lake lists to JSON so the Python side never has to parse JS.
// Node imports the modules for real, so a trailing comma or a template string cannot break it
// the way a regex would.
//
// WRITES THE FILE ITSELF. Do not redirect with `>`: PowerShell's redirection encodes as
// UTF-16LE with a BOM, and Python's json.load then dies on byte 0xff at position 0. Passing
// the path in keeps the shell out of the encoding entirely.
//
//   node .\dump_js_lists.mjs "F:\TrollMapPipeline\registry\js_lists.json"
//
// LAKE_DB IS NO LONGER DUMPED HERE. It was the third list, and js/data/lakes.js has been
// deleted -- its 50 curated entries now live at registry/curated_lakes.json, which
// consolidate_lake_index.py reads directly. The round trip through this file existed only
// because the data was trapped inside a JS module; it disguised pipeline data as app code
// well enough to get the file queued for deletion three times, while it was the only source
// of every USGS gauge, Duke/Dominion binding, pool curve and curated ramp list in the index.
//
// The two lists below are still JS because access-index.js imports them at runtime. When the
// SCDNR and user-known lakes get registry boundaries they follow LAKE_DB out of js/, and
// this file goes with them.
import { writeFileSync } from 'node:fs';
import { SCDNR_STATE_LAKES } from './scdnr-state-lakes.js';
import { USER_KNOWN_LAKES } from './user-known-lakes.js';

const payload = JSON.stringify({
  scdnr_state_lakes: SCDNR_STATE_LAKES,
  user_known_lakes: USER_KNOWN_LAKES,
}, null, 1);

const out = process.argv[2];
if (out) {
  writeFileSync(out, payload, 'utf8');
  console.log(`wrote ${out}  (${SCDNR_STATE_LAKES.length} SCDNR, ` +
              `${USER_KNOWN_LAKES.length} user-known)`);
} else {
  process.stdout.write(payload);
}
