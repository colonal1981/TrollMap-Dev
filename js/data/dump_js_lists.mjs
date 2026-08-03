// Dump the three hardcoded JS lake lists to JSON so the Python side never has to parse JS.
// Node imports the modules for real, so a trailing comma or a template string cannot break it
// the way a regex would.
//
// WRITES THE FILE ITSELF. Do not redirect with `>`: PowerShell's redirection encodes as
// UTF-16LE with a BOM, and Python's json.load then dies on byte 0xff at position 0. Passing
// the path in keeps the shell out of the encoding entirely.
//
//   node .\dump_js_lists.mjs "F:\TrollMapPipeline\registry\js_lists.json"
import { writeFileSync } from 'node:fs';
import { LAKE_DB } from './lakes.js';
import { SCDNR_STATE_LAKES } from './scdnr-state-lakes.js';
import { USER_KNOWN_LAKES } from './user-known-lakes.js';

const payload = JSON.stringify({
  lake_db: LAKE_DB,
  scdnr_state_lakes: SCDNR_STATE_LAKES,
  user_known_lakes: USER_KNOWN_LAKES,
}, null, 1);

const out = process.argv[2];
if (out) {
  writeFileSync(out, payload, 'utf8');
  console.log(`wrote ${out}  (${LAKE_DB && Object.keys(LAKE_DB).length} LAKE_DB, ` +
              `${SCDNR_STATE_LAKES.length} SCDNR, ${USER_KNOWN_LAKES.length} user-known)`);
} else {
  process.stdout.write(payload);
}
