/**
 * test/a-waters-reports-are-kept-beside-its-profile.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-11-05: "small sample size build the parsers then wire what is needed into research and
 * see how that goes". Scripts/reports_step.py reads a water's fishing reports, checks every
 * statement against Scripts/report_contract.py, and sends the file gzipped to
 * /research/save-reports. The Worker keeps it at lake_packages/<id>/reports.json, beside the
 * profile, by the same id resolution the profile uses.
 *
 * What is held here:
 *   - the bytes are stored as they came, marked gzip, under the PROFILE's id (the county-stamped
 *     name still finds lake_wateree_sc), and the read of the profile then lists the file;
 *   - a body that is not gzip, a water that is not a slug, and a water with no profile are refused,
 *     and nothing is stored;
 *   - the handler never parses the file. The Worker is on the free plan, 10 ms of CPU a request,
 *     and Wateree's file is 2.9 MB of JSON.
 *
 *   node --test test/a-waters-reports-are-kept-beside-its-profile.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { handleResearchSaveReports, handleResearchGet } from '../Worker/research/storage.js';

const WATEREE = 'Wateree Lake (Kershaw Co, SC)';
const INDEX = JSON.stringify({
  wateree_lake: {
    display_name: WATEREE, name: 'Wateree Lake',
    legacy_display_names: ['Wateree Lake, SC', 'Lake Wateree', 'Lake Wateree, SC'],
  },
});

function env(store, meta = {}) {
  const asObj = (k) => store[k] === undefined ? null
    : { httpMetadata: meta[k]?.httpMetadata || {}, text: async () => store[k] };
  return { R2_TROLLMAP_CHARTPACKS: {
    get: async (k) => asObj(k),
    head: async (k) => asObj(k),
    put: async (k, v, opts) => {
      store[k] = v; meta[k] = opts || {};
      return { key: k, size: v.byteLength ?? v.length };
    },
    list: async ({ prefix }) => ({ objects: Object.keys(store)
      .filter((k) => k.startsWith(prefix)).sort()
      .map((k) => ({ key: k, size: store[k].byteLength ?? store[k].length })) }),
  } };
}

const STORE = () => ({
  '_registry/lake_index.json': INDEX,
  'lakes/lake_wateree_sc.json': JSON.stringify({ lakeName: WATEREE, metadata: { versionNumber: 141 } }),
});

const FILE = { water: 'wateree_lake', name: WATEREE, built_by: 'reports_step.py',
  statements: [{ id: 'a1', source: 'AHQ', date: '2023-03-16', text: 'The crappie are moving shallow on Wateree.' }] };

function post(body, { lake = WATEREE, water = 'wateree_lake', statements = 1 } = {}) {
  const q = new URLSearchParams({ lake, water, statements: String(statements) });
  return new Request(`https://w.test/research/save-reports?${q}`, {
    method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body });
}

test('the file is kept beside the profile, as it came, marked gzip', async () => {
  const store = STORE(), meta = {};
  const gz = gzipSync(Buffer.from(JSON.stringify(FILE)));
  const res = await handleResearchSaveReports(post(gz), env(store, meta));
  const out = await res.json();
  assert.equal(res.status, 200, out.error);
  assert.equal(out.key, 'lake_packages/lake_wateree_sc/reports.json',
    'the county-stamped name finds the profile filed as lake_wateree_sc, and the reports go beside it');
  assert.equal(out.bytes, gz.length, 'the pipeline compares this with what it sent');
  const kept = Buffer.from(store[out.key]);
  assert.deepEqual(JSON.parse(gunzipSync(kept).toString('utf8')), FILE, 'stored byte for byte');
  assert.equal(meta[out.key].httpMetadata.contentEncoding, 'gzip', 'so r2Text and r2Body unwrap it');
  assert.equal(meta[out.key].httpMetadata.contentType, 'application/json');
  assert.equal(meta[out.key].customMetadata.water, 'wateree_lake');
  assert.equal(meta[out.key].customMetadata.statements, '1');
});

test('the profile read lists the reports with the rest of its package', async () => {
  const store = STORE();
  await handleResearchSaveReports(post(gzipSync(Buffer.from(JSON.stringify(FILE)))), env(store));
  const out = await (await handleResearchGet(env(store), WATEREE)).json();
  assert.ok(out.packageFiles.some((f) => f.name === 'reports.json'));
});

test('a body that is not gzip is refused, and nothing is kept', async () => {
  const store = STORE();
  const res = await handleResearchSaveReports(post(JSON.stringify(FILE)), env(store));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /gzip/);
  assert.equal(Object.keys(store).some((k) => k.startsWith('lake_packages/')), false);
});

test('a water with no profile is refused: the reports go beside one', async () => {
  const store = { '_registry/lake_index.json': INDEX };
  const res = await handleResearchSaveReports(post(gzipSync(Buffer.from('{}'))), env(store));
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /no research profile/);
  assert.equal(Object.keys(store).some((k) => k.startsWith('lake_packages/')), false);
});

test('the water must be a registry slug, and the count a whole number', async () => {
  const gz = gzipSync(Buffer.from('{}'));
  for (const bad of [{ water: '' }, { water: '../lakes/x' }, { water: 'Wateree Lake' }, { statements: 'many' }]) {
    const store = STORE();
    const res = await handleResearchSaveReports(post(gz, bad), env(store));
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(Object.keys(store).some((k) => k.startsWith('lake_packages/')), false);
  }
});

test('an empty body is refused', async () => {
  const res = await handleResearchSaveReports(post(new Uint8Array(0)), env(STORE()));
  assert.equal(res.status, 400);
});

test('the handler never parses the file: 10 ms of CPU would not cover 3 MB of JSON', () => {
  const src = readFileSync(new URL('../Worker/research/storage.js', import.meta.url), 'utf8');
  const at = src.indexOf('async function handleResearchSaveReports');
  assert.ok(at > 0, 'the handler moved -- this guard needs updating');
  const after = src.slice(at + 10);
  const body = src.slice(at, at + 10 + after.search(/\n(?:export\s+)?(?:async\s+)?function\s+\w+/));
  for (const read of ['JSON.parse', 'request.json(', 'request.text(', 'r2Text(', 'DecompressionStream']) {
    assert.equal(body.includes(read), false, `${read} in handleResearchSaveReports`);
  }
});

test('the route is gated and dispatched to this handler', () => {
  const worker = readFileSync(new URL('../Worker/trollmap-worker.js', import.meta.url), 'utf8');
  const list = worker.slice(worker.indexOf('const MUTATING_ROUTES'), worker.indexOf('const SPENDING_ROUTES'));
  assert.ok(list.includes('"/research/save-reports"'));
  assert.match(worker, /path === "\/research\/save-reports" && request\.method === "POST"\) \{\s*return handleResearchSaveReports\(request, env\);/);
});

test('the public chart-pack route does not serve a research package', () => {
  // Found 11/5: /chartpacks/lake_packages/lake_wateree_sc/reports.json answered 200 with no key, because
  // chartpackKey("lake_packages", "lake_wateree_sc/reports.json") is exactly the package's R2 key.
  const worker = readFileSync(new URL('../Worker/trollmap-worker.js', import.meta.url), 'utf8');
  const route = worker.slice(worker.indexOf('const cpMatch = path.match('));
  const refuse = route.indexOf('key.startsWith("lake_packages/")');
  const read = route.indexOf('R2_TROLLMAP_CHARTPACKS.get(');
  assert.ok(refuse > 0, 'the chart-pack route no longer refuses lake_packages/');
  assert.ok(refuse < read, 'the refusal must come before the read, or the bytes are fetched first');
  assert.match(route.slice(refuse, read), /status: 404/);
});
