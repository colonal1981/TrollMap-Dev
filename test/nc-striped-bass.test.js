// NORTH CAROLINA'S STRIPED BASS RULE REACHED NO WATER IN THE STATE.
//
// Striped bass and hybrids are what this app is for, and NC's statewide limit for them --
// 20-inch minimum, 4 in combination -- bound nothing. Not because it was misread: the band
// `STRIPED BASS AND BODIE BASS (STRIPED BASS HYBRID)` is in the book and mapped to both
// checkboxes. The address was the problem. NC writes it as
//
//     Impounded inland waters and their tributaries except those listed below:
//
// and STATEWIDE only recognised `statewide`, `all public/inland waters` and `all waters of the
// state`. So the row resolved to `unresolved` and NC answered nothing for its main species.
//
// WIDENING STATEWIDE WOULD HAVE BEEN WORSE THAN LEAVING IT. `Impounded` is not `all` -- NC
// governs its rivers and sounds by management area (Roanoke, Albemarle, Central-Southern), and
// we offer 17 rivers and 3 coastal waters in that state. A plain statewide record would have
// handed every one of them a 20-inch minimum the book gives them nowhere.
//
// Separately, of 18 striped bass rows only 3 bound, and one of the misses was a plain comma
// list: `Hyco Lake, Moss Lake, Oak Hollow Lake, Lake Townsend, Farmer Lake and Salem Lake` --
// six lakes, all six of which we offer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(path.join(REPO, 'Scripts/build_regulations_table.py'), 'utf8');
const WORKER = readFileSync(path.join(REPO, 'Worker/trollmap-worker.js'), 'utf8');

test('a default that covers one kind of water says so', () => {
  assert.match(SRC, /^SCOPED_STATEWIDE = \[/m);
  assert.match(SRC, /impounded\\s\+inland\\s\+waters/);
  assert.match(SRC, /'applies_to_feature_types': list\(kinds\)/);
  // And it is NOT folded into STATEWIDE, which is unscoped by construction. The slice is the
  // pattern itself and not the prose around it -- the comment explaining WHY the impounded
  // form is kept out of it naturally contains the word, and an earlier version of this
  // assertion read its own explanation and failed.
  const i = SRC.indexOf('STATEWIDE = re.compile');
  const sw = SRC.slice(i, SRC.indexOf('\n\n', i));
  assert.ok(!/impounded/i.test(sw), 'STATEWIDE itself stays unscoped');
});

test('the scope travels onto the record', () => {
  assert.match(SRC, /rec\['applies_to_feature_types'\] = list\(r\['applies_to_feature_types'\]\)/);
});

test('the Worker withholds a scoped default from the wrong kind of water', () => {
  const blk = WORKER.slice(WORKER.indexOf('let bookStatewide = []'),
                           WORKER.indexOf('bookStatewide.push({'));
  assert.match(blk, /if \(Array\.isArray\(r\.applies_to_feature_types\) && r\.applies_to_feature_types\.length\) \{/);
  assert.match(blk, /const ft = row && row\.feature_type \? String\(row\.feature_type\) : null;/);
  // An unresolved water has no feature type to test, so the record is withheld rather than
  // guessed at -- the same direction every other unknown in this route resolves in.
  assert.match(blk, /if \(!ft \|\| !r\.applies_to_feature_types\.includes\(ft\)\) continue;/);
});

test('a plain comma list of names is split, a described reach is not', () => {
  const fn = SRC.slice(SRC.indexOf('# A PLAIN COMMA LIST OF NAMES'),
                       SRC.indexOf('waters, unresolved, kinds = [], [], set()'));
  assert.match(fn, /QUALIFIER_PHRASE\.search\(b\)/);
  // Two must resolve, so a single incidental name in a sentence cannot trigger a split.
  assert.match(fn, /sum\(1 for b in bits if resolve\(b, name_map\)\) >= 2/);
  // A name we do not offer is not a reason to refuse the ones we do -- the book lists six
  // lakes and requiring all six to resolve kept the list whole.
  assert.ok(!/all\(resolve\(b, name_map\) for b in bits\)/.test(fn), 'not an all() gate');
  assert.match(SRC, /^QUALIFIER_PHRASE = re\.compile/m);
});
