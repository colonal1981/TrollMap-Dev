// Approving a profile must reach the SAME object /research/get returns.
//
// 2026-09-04. `restore_verified_stamps.py` sent 46 approvals, by the exact display_name the app
// uses, for 46 profiles that /research/get had just returned. All 46 came back
// `no profile for <name>`, because handleResearchApprove resolved with `researchStorageId`
// alone -- one spelling, the county-stamped one:
//
//   "Wateree Lake (Kershaw Co, SC)"  ->  lake_wateree_kershaw_co_sc   does not exist
//   the object                       ->  lake_wateree_sc
//
// handleResearchDelete was fixed for precisely this and carries the lesson in a comment. The
// approve path, one function away in the same file, was not. This pins both halves of the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleResearchApprove } from '../Worker/research/storage.js';

const WATEREE = 'Wateree Lake (Kershaw Co, SC)';
const STORED_AT = 'lakes/lake_wateree_sc.json';

function profile(status) {
  return JSON.stringify({ lakeName: WATEREE, metadata: { status, versionNumber: 141 } });
}

// The registry rows, verbatim from registry/lake_index.json. `legacy_display_names` is what
// carries "Lake Wateree, SC" -- the spelling the profile was filed under before the county
// parenthetical existed -- and registryIdentityNames() feeds it to the resolver. Without the
// index in the bucket the resolver has only the caller's own name to try, which is exactly the
// state handleResearchApprove was permanently in.
const INDEX = JSON.stringify({
  wateree_lake: {
    display_name: WATEREE, name: 'Wateree Lake',
    legacy_display_names: ['Wateree Lake, SC', 'Lake Wateree', 'Lake Wateree, SC'],
  },
  watauga_lake: {
    display_name: 'Watauga Lake (Carter Co, TN)', name: 'Watauga Lake',
    legacy_display_names: ['Watauga Lake, TN', 'Watauga', 'Watauga, TN'],
  },
});

/** An R2 stand-in holding ONE object, at the legacy key, exactly as the bucket does. */
function bucket(initial = { [STORED_AT]: profile('draft') }) {
  const store = { '_registry/lake_index.json': INDEX, ...initial };
  const asObj = (key) => store[key] === undefined ? null : {
    httpMetadata: {}, text: async () => store[key],
  };
  return {
    store,
    reads: [],
    r2: {
      get(key) { this._parent.reads.push(key); return Promise.resolve(asObj(key)); },
      head(key) { return Promise.resolve(asObj(key)); },
      put(key, body) { store[key] = body; return Promise.resolve(); },
      list() { return Promise.resolve({ objects: [] }); },
    },
  };
}

function env(b) {
  b.r2._parent = b;
  return { R2_TROLLMAP_CHARTPACKS: b.r2 };
}

const req = (body) => new Request('https://x/research/approve', {
  method: 'POST', body: JSON.stringify(body),
});

test('the county-stamped name reaches the profile stored under the legacy key', async () => {
  const b = bucket();
  const res = await handleResearchApprove(req({ lakeName: WATEREE }), env(b));
  const out = await res.json();
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(out)}`);
  assert.equal(out.ok, true);
  assert.equal(out.lakeId, 'lake_wateree_sc');
  assert.equal(JSON.parse(b.store[STORED_AT]).metadata.status, 'verified');
});

test('it stamps verified, verifiedAt and the approver, and keeps the version', async () => {
  const b = bucket();
  await handleResearchApprove(req({ lakeName: WATEREE }), env(b));
  const m = JSON.parse(b.store[STORED_AT]).metadata;
  assert.equal(m.verified, true);
  assert.ok(m.verifiedAt, 'verifiedAt must be written -- it is the record a human approved this');
  assert.equal(m.versionNumber, 141, 'approve must not bump the version; it changes one field');
});

test('an explicit id is used verbatim and never resolved', async () => {
  // Two waters carry two profiles each. Resolving by name picks one of the pair by candidate
  // order; stamping the wrong one of a pair is not something a second run fixes.
  const b = bucket({
    'lakes/watauga_tn.json': profile('draft'),
    'lakes/watauga_lake_tn.json': profile('draft'),
  });
  const res = await handleResearchApprove(
    req({ lakeName: 'Watauga Lake (Carter Co, TN)', id: 'watauga_tn' }), env(b));
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.lakeId, 'watauga_tn');
  assert.equal(JSON.parse(b.store['lakes/watauga_tn.json']).metadata.status, 'verified');
  assert.equal(JSON.parse(b.store['lakes/watauga_lake_tn.json']).metadata.status, 'draft',
    'the sibling profile must be untouched');
});

test('a string that is not a storage id is refused, not sanitised into one', async () => {
  const b = bucket();
  const res = await handleResearchApprove(
    req({ lakeName: WATEREE, id: 'Lake Wateree (Kershaw Co, SC)' }), env(b));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not a storage id/);
});

test('a genuinely absent profile still 404s, and the error names the key it tried', async () => {
  // The old message said only the display name, which reads as "this lake has no research" when
  // what it means is "nothing is stored at the one key I tried".
  const b = bucket({});
  const res = await handleResearchApprove(req({ lakeName: WATEREE }), env(b));
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /wateree/);
});
