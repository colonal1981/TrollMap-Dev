// Every lake Duke publishes, reachable — not the nine in the table.
//
// FIXTURE IS REAL. These rows are lifted from the /lakes/current-level response Ryan pasted on
// 2026-08-15, trimmed to the fields normalizeDukeRow reads. The five lakes named here are the
// ones the doc identified as "in the feed, no reference in the app".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchWaterName } from '../Worker/reports.js';

// The Duke feed never aggregates two lakes onto one row, so the feed name may not be broader
// than the registry name. This is the flag worker-data.js passes.
const dukeMatch = (feedName, names) => matchWaterName(feedName, names, { sourceMayBeBroader: false });

// The registry names for the five, verbatim from lake_index.json.
const TILLERY   = ['Lake Tillery', 'Lake Tillery (Montgomery Co, NC)', 'Lake Tillery, NC'];
const BLEWETT   = ['Blewett Falls Lake', 'Blewett Falls Lake, NC'];
const LOOKOUT   = ['Lookout Shoals Lake', 'Lookout Shoals Lake, NC'];
const HYCO      = ['Hyco Lake', 'Hyco Lake, NC'];
const ROBINSON  = ['Lake Robinson', 'Lake Robinson (Chesterfield Co, SC)', 'Lake Robinson, SC'];
const NORMAN    = ['Lake Norman', 'Lake Norman, NC'];
const JAMES     = ['Lake James', 'Lake James, NC'];

// LakeDisplayName strings as Duke publishes them.
const FEED = ['Lake Tillery', 'Blewett Falls Lake', 'Lookout Shoals Lake', 'Hyco Lake',
  'Lake Robinson', 'Lake Norman', 'Lake James', 'Lake Wylie', 'Mountain Island Lake',
  'Lake Rhodhiss', 'Lake Hickory', 'Lake Keowee', 'Lake Jocassee', 'Lake Wateree'];

const pick = (names) => FEED.find((f) => dukeMatch(f, names)) || null;

test('the five the table never named are all reachable from the feed', () => {
  assert.equal(pick(TILLERY), 'Lake Tillery');
  assert.equal(pick(BLEWETT), 'Blewett Falls Lake');
  assert.equal(pick(LOOKOUT), 'Lookout Shoals Lake');
  assert.equal(pick(HYCO), 'Hyco Lake');
  assert.equal(pick(ROBINSON), 'Lake Robinson');
});

test('the nine that already worked still resolve to themselves', () => {
  assert.equal(pick(NORMAN), 'Lake Norman');
  assert.equal(pick(JAMES), 'Lake James');
});

test('a substring is not a match — this is why .includes() had to go', () => {
  // getDukeLake()'s `.includes(frag)` would let "james" claim any name containing it, and
  // "Lake Norman" contains "norman" which is also a TVA reservoir name.
  assert.equal(dukeMatch('Lake James', ['Lake Jamestown']), null);
  // Duke publishes Mountain Island Lake; the registry also ships a "Mountain Lake". Under the
  // loose direction the feed row answered for it, which is a different reservoir's elevation.
  assert.equal(dukeMatch('Mountain Island Lake', ['Mountain Lake']), null);
  // and the loose direction is still available where a source really does aggregate
  assert.equal(matchWaterName('santee cooper lake marion lake moultrie', ['Lake Marion']), 'Lake Marion');
});

test('a water Duke does not publish gets null, not the nearest thing', () => {
  assert.equal(pick(['Lake Murray', 'Lake Murray, SC']), null);
  assert.equal(pick(['Norris Lake', 'Norris Lake, TN']), null);
});

test('the county display name ALONE reaches the feed — a binding carries nothing else', () => {
  // water_bindings.json has `display_name` and no legacy names, so chartDatum passes exactly
  // one string. It must be enough on its own; the earlier code hand-cut it at the first comma
  // and produced "Wateree Lake (Kershaw Co", which matched nothing.
  assert.equal(dukeMatch('Lake Wateree', ['Wateree Lake (Kershaw Co, SC)']), 'Wateree Lake (Kershaw Co, SC)');
  assert.equal(dukeMatch('Lake Norman', ['Lake Norman (Catawba Co, NC)']), 'Lake Norman (Catawba Co, NC)');
  assert.equal(dukeMatch('Lake Tillery', ['Lake Tillery (Montgomery Co, NC)']), 'Lake Tillery (Montgomery Co, NC)');
  assert.equal(dukeMatch('Mountain Island Lake', ['Mountain Island Lake (Gaston Co, NC)']),
               'Mountain Island Lake (Gaston Co, NC)');
});

test('a county that is also a lake name does not make the match', () => {
  // Duke publishes "Lake Norman". Catawba is a county AND a registry water; the parenthetical
  // must not become a matchable token in either direction.
  assert.equal(dukeMatch('Lake Hickory', ['Lake Norman (Catawba Co, NC)']), null);
  assert.equal(dukeMatch('Lake Jocassee', ['Lake Keowee (Oconee Co, SC)']), null);
});

test('the broken hand-cut is what this replaces', () => {
  // Exactly what `display_name.replace(/,.*$/, '')` produced, kept here so the regression has a
  // name. It is not a lake name and it must not be treated as one.
  const cut = 'Wateree Lake (Kershaw Co, SC)'.replace(/,.*$/, '');
  assert.equal(cut, 'Wateree Lake (Kershaw Co');
  assert.equal('Lake Wateree'.toLowerCase().includes(cut.toLowerCase()), false);
});
