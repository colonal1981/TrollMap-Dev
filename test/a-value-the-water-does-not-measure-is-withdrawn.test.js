// Personal use only, not for distribution or resale; not for navigation.
//
// A VALUE THE WATER DOES NOT MEASURE IS WITHDRAWN, NOT KEPT.
//
// From 2026-09-24 the WQP pull counts only the stations inside the water's outline (1037c84). The
// profiles it merges into were built from the whole BOX, and the merge only ever overlaid: it wrote
// what the new pull had and left everything else. Measured that day, 123 of 133 stored profiles
// carried a box merge. The Great Pee Dee's held Secchi 4.5 ft from 229 samples in its box, Lake
// Moultrie's among them; live, its 14 stations on the river have no Secchi at all.
//
// These run the real merge, the real sweep and the real endpoint against a stubbed bucket. No
// network: every pull is served from a cache that says it was tested on the water.
//
//   node --test test/a-value-the-water-does-not-measure-is-withdrawn.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyWqpToLimnology, wqpWithdrawals, wqpEvidenceWithdrawn, dropWqpEvidence,
         buildWqpEvidence, WQP_EVIDENCE_URL } from '../js/utils/wqp-limnology.js';
import { refreshStaleLimnology, handleResearchLimnologyData } from '../Worker/research/limnology.js';
import { _resetIndexCache } from '../Worker/registry.js';

// ── THE GREAT PEE DEE, IN THE SHAPE IT WAS MEASURED ─────────────────────────────────────────────
const BOX_PULL = {                       // what the profile was merged with: no `onWater`
  ok: true, recordCount: 21330, lastObserved: '2024-08-01',
  secchi: { avgSecchiDepthFt: 4.5, sampleCount: 229 },
  surfaceWater: { recentTempF: 80.1, recentTurbidityNTU: 18, programs: ['SCDES'] },
};
const RIVER_PULL = {                     // what the river's own stations give now
  ok: true, recordCount: 2971, lastObserved: '2025-07-01', fetchedAt: '2026-09-24T18:00:00.000Z',
  onWater: { checked: true, water: 'great_pee_dee_river', stationsOn: 14, stationsOff: 146,
             stationsUnplaced: 0, readingsKept: 2971, readingsDropped: 18359, off: [] },
  secchi: null,
  surfaceWater: { recentTempF: 78.4, recentTurbidityNTU: 11, programs: ['SCDES'],
                  note: "stations inside this water's outline" },
  note: 'These are surface grabs with a depth stamp, not a vertical profile.',
};
const BOX_PROFILE = () => ({
  waterClarity: { secchiFt: 4.5, typical: 'stained',
                  note: 'Recent WQP/SCDES surface turbidity around 18 NTU.' },
  trophicStatus: 'eutrophic',
  surfaceWater: { ...BOX_PULL.surfaceWater },
});

test('a Secchi the box gave and the river does not measure is withdrawn, with its reason', () => {
  const out = applyWqpToLimnology(BOX_PROFILE(), RIVER_PULL, BOX_PULL);
  assert.equal(out.waterClarity.secchiFt, null);
  assert.equal(out.waterClarity.typical, null, 'the word for the number goes with the number');
  assert.equal(out.trophicStatus, null);
  assert.match(out.waterClarity.note, /^Withdrawn 2026-09-24: .*bounding box/);
  assert.match(out.waterClarity.note, /14 stations on the water/);
  // THIS pull's turbidity survives beside the withdrawal; the box's 18 NTU does not.
  assert.match(out.waterClarity.note, /around 11 NTU/);
  assert.doesNotMatch(out.waterClarity.note, /18 NTU/);
  assert.match(out.trophicStatusNote, /^Withdrawn/);
  assert.equal(out.surfaceWater.recentTempF, 78.4, 'the river\'s own surface block replaces the box\'s');
});

test('it says which fields went, and which evidence sections lose their WQP rows', () => {
  const gone = wqpWithdrawals(BOX_PROFILE(), RIVER_PULL, BOX_PULL);
  // Not the turbidity note: this pull has a turbidity of its own and rewrites it.
  assert.deepEqual(gone.map((g) => g.field).sort(),
    ['trophicStatus', 'waterClarity.secchiFt', 'waterClarity.typical']);
  // surfaceWater is cited again by this pull, so only the two withdrawn sections lose rows.
  assert.deepEqual(wqpEvidenceWithdrawn(gone, RIVER_PULL).sort(), ['trophicStatus', 'waterClarity']);
});

test('a value that is not the pull\'s -- a document cast -- is left alone', () => {
  const base = { thermocline: { summerDepthFt: 19.7, method: 'document_vertical_profile', note: 'NLA 2012' } };
  const prev = { ok: true, recordCount: 900, thermocline: { depthFt: 24, method: 'derived_from_do_profile' } };
  const out = applyWqpToLimnology(base, { ...RIVER_PULL, secchi: null }, prev);
  assert.equal(out.thermocline.summerDepthFt, 19.7);
  assert.equal(out.thermocline.method, 'document_vertical_profile');
});

test('a thermocline the box derived is withdrawn, and this pull\'s refusal stands beside it', () => {
  const base = { thermocline: { summerDepthFt: 24, method: 'derived_from_do_profile',
                                note: 'Derived from 61 summer DO casts.' } };
  const prev = { ok: true, recordCount: 900, thermocline: { depthFt: 24, method: 'derived_from_do_profile' } };
  const out = applyWqpToLimnology(base, RIVER_PULL, prev);
  assert.equal(out.thermocline.summerDepthFt, null);
  assert.equal(out.thermocline.method, null);
  assert.match(out.thermocline.note, /^Withdrawn/);
  assert.match(out.thermocline.note, /surface grabs with a depth stamp/);
  assert.doesNotMatch(out.thermocline.note, /61 summer DO casts/, 'the old reason goes with the old value');
});

test('a pull that was not tested on the water withdraws nothing -- it is the box again', () => {
  const untested = { ...RIVER_PULL, onWater: { checked: false, why: 'no registry outline for this water' } };
  const out = applyWqpToLimnology(BOX_PROFILE(), untested, BOX_PULL);
  assert.equal(out.waterClarity.secchiFt, 4.5);
  assert.deepEqual(wqpWithdrawals(BOX_PROFILE(), untested, BOX_PULL), []);
});

test('an empty pull is WQP having a bad day and withdraws nothing', () => {
  const bad = { ok: true, recordCount: 0, surfaceWater: null,
                onWater: { checked: true, stationsOn: 0, readingsDropped: 0 } };
  assert.deepEqual(wqpWithdrawals(BOX_PROFILE(), bad, BOX_PULL), []);
  assert.equal(applyWqpToLimnology(BOX_PROFILE(), bad, BOX_PULL).waterClarity.secchiFt, 4.5);
});

test('...unless the test emptied it: then the box\'s surface block goes too', () => {
  const emptied = { ok: true, recordCount: 0, surfaceWater: null, thermocline: null, oxygen: null,
                    onWater: { checked: true, stationsOn: 0, stationsOff: 9, readingsDropped: 500 },
                    note: "WQP had 500 readings inside this water's box and none at a station on the water" };
  const out = applyWqpToLimnology(BOX_PROFILE(), emptied, BOX_PULL);
  assert.equal(out.waterClarity.secchiFt, null);
  assert.equal(out.surfaceWater.recentTempF, null);
  assert.equal(out.surfaceWater.recentTurbidityNTU, null);
  assert.equal(out.surfaceWater.programs, null);
  assert.match(out.surfaceWater.note, /no station on the water has readings/);
});

test('where the new pull has the value it simply replaces it, and nothing is withdrawn', () => {
  const lake = { ...RIVER_PULL, secchi: { avgSecchiDepthFt: 3.1, sampleCount: 40 } };
  assert.deepEqual(wqpWithdrawals(BOX_PROFILE(), lake, BOX_PULL)
    .filter((g) => g.field !== 'waterClarity.note'), []);
  const out = applyWqpToLimnology(BOX_PROFILE(), lake, BOX_PULL);
  assert.equal(out.waterClarity.secchiFt, 3.1);
  assert.equal(out.waterClarity.note, 'Recent WQP/SCDES surface turbidity around 11 NTU.',
               'WQP may rewrite its own note');
});

test('with no previous pull the merge is the overlay it always was', () => {
  const out = applyWqpToLimnology(BOX_PROFILE(), RIVER_PULL);
  assert.equal(out.waterClarity.secchiFt, 4.5);
  assert.equal(out.trophicStatus, 'eutrophic');
});

test('dropping WQP rows leaves a document\'s rows in the same section', () => {
  const doc = { sourceType: 'official_structured', sourceUrl: 'registry:_registry/document_limnology.json' };
  const ev = { limnology: {
    waterClarity: [{ sourceUrl: WQP_EVIDENCE_URL }],
    thermocline: [{ sourceUrl: WQP_EVIDENCE_URL }, doc],
    oxygen: [{ sourceUrl: WQP_EVIDENCE_URL }],
  } };
  dropWqpEvidence(ev, ['waterClarity', 'thermocline']);
  assert.equal(ev.limnology.waterClarity, undefined);
  assert.deepEqual(ev.limnology.thermocline, [doc]);
  assert.equal(ev.limnology.oxygen.length, 1, 'a section that was not named is not touched');
});

// ── THE SWEEP AND THE ENDPOINT, AGAINST A BUCKET ────────────────────────────────────────────────
const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const INDEX = JSON.stringify({ great_pee_dee_river: {
  slug: 'great_pee_dee_river', name: 'Great Pee Dee River', display_name: 'Great Pee Dee River, SC',
  state: 'SC', feature_type: 'river', bounds_wsen: [-79.9, 33.3, -79.1, 34.5] } });

function bucket(objects) {
  _resetIndexCache();
  const store = new Map(Object.entries({
    '_registry/lake_index.json': { uploaded: iso(0), body: INDEX }, ...objects }));
  return {
    puts: [],
    async list({ prefix }) {
      return { objects: [...store.entries()].filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => ({ key: k, uploaded: v.uploaded })) };
    },
    async get(key) { const h = store.get(key); return h ? { text: async () => h.body, body: h.body } : null; },
    async head(key) { return store.has(key) ? { key } : null; },
    async put(key, body) { this.puts.push(key); store.set(key, { uploaded: iso(0), body }); },
    _read: (k) => JSON.parse(store.get(k).body),
  };
}

const STORED = () => JSON.stringify({
  lakeName: 'Great Pee Dee River, SC', state: 'SC',
  limnology: BOX_PROFILE(),
  _wqpLimnology: BOX_PULL,
  evidence: { limnology: {
    ...buildWqpEvidence(BOX_PULL).limnology,
  } },
  metadata: { version: '3.0', versionNumber: 3 },
});
const CACHED = (pull) => JSON.stringify({ ...pull, fetchedAt: iso(2 * DAY) });

test('the thirty-day sweep withdraws the box\'s Secchi and drops the row that cited it', async () => {
  const R2 = bucket({
    'lakes/great_pee_dee_river_sc.json': { uploaded: iso(40 * DAY), body: STORED() },
    'limnology-cache/great_pee_dee_river_sc.json': { uploaded: iso(31 * DAY), body: CACHED(RIVER_PULL) },
  });
  const out = await refreshStaleLimnology({ R2_TROLLMAP_CHARTPACKS: R2 });
  assert.equal(out.merged, 1);
  const saved = R2._read('lakes/great_pee_dee_river_sc.json');
  assert.equal(saved.limnology.waterClarity.secchiFt, null);
  assert.equal(saved.limnology.trophicStatus, null);
  assert.equal(saved.evidence.limnology.waterClarity, undefined, 'no row still says WQP supplied it');
  assert.equal(saved.evidence.limnology.trophicStatus, undefined);
  assert.ok(saved.evidence.limnology.surfaceWater, 'the surface block is cited by this pull');
  assert.equal(saved._wqpLimnology.onWater.checked, true, 'the provenance is the tested pull now');
  const state = R2._read('limnology-cache/_sweep.json').waters;
  assert.ok(state.great_pee_dee_river_sc.withdrawn.includes('waterClarity.secchiFt'),
            'the sweep state says what it withdrew');
});

test('the sweep merges a pull the test emptied, instead of skipping it', async () => {
  const emptied = { ok: true, recordCount: 0, surfaceWater: null, thermocline: null, oxygen: null,
                    onWater: { checked: true, stationsOn: 0, stationsOff: 9, readingsDropped: 500 },
                    note: "WQP had 500 readings inside this water's box and none at a station on the water" };
  const R2 = bucket({
    'lakes/great_pee_dee_river_sc.json': { uploaded: iso(40 * DAY), body: STORED() },
    'limnology-cache/great_pee_dee_river_sc.json': { uploaded: iso(31 * DAY), body: CACHED(emptied) },
  });
  const out = await refreshStaleLimnology({ R2_TROLLMAP_CHARTPACKS: R2 });
  assert.equal(out.merged, 1);
  const saved = R2._read('lakes/great_pee_dee_river_sc.json');
  assert.equal(saved.limnology.waterClarity.secchiFt, null);
  assert.equal(saved.limnology.surfaceWater.recentTempF, null);
  assert.equal(saved.evidence.limnology.surfaceWater, undefined);
  assert.equal(saved._wqpLimnology.recordCount, 0);
});

test('the endpoint the batch calls withdraws too, and says what the batch must drop', async () => {
  const R2 = bucket({
    'lakes/great_pee_dee_river_sc.json': { uploaded: iso(40 * DAY), body: STORED() },
    'limnology-cache/great_pee_dee_river_sc.json': { uploaded: iso(3 * DAY), body: CACHED(RIVER_PULL) },
  });
  const res = await handleResearchLimnologyData(new Request('https://w.example/research/limnology-data', {
    method: 'POST', body: JSON.stringify({ lakeName: 'Great Pee Dee River, SC',
                                           base: BOX_PROFILE(), prev: BOX_PULL }) }),
  { R2_TROLLMAP_CHARTPACKS: R2 });
  const d = await res.json();
  assert.equal(d.merged.waterClarity.secchiFt, null);
  assert.ok(d.withdrawn.some((w) => w.field === 'waterClarity.secchiFt'));
  assert.deepEqual(d.evidenceWithdrawn.sort(), ['trophicStatus', 'waterClarity']);
  assert.ok(d.gaps.includes('limnology.waterClarity.secchiFt'), 'and a document may now be asked for it');
});

test('an old batch that sends no `prev` gets the overlay it always got', async () => {
  const R2 = bucket({
    'lakes/great_pee_dee_river_sc.json': { uploaded: iso(40 * DAY), body: STORED() },
    'limnology-cache/great_pee_dee_river_sc.json': { uploaded: iso(3 * DAY), body: CACHED(RIVER_PULL) },
  });
  const res = await handleResearchLimnologyData(new Request('https://w.example/research/limnology-data', {
    method: 'POST', body: JSON.stringify({ lakeName: 'Great Pee Dee River, SC', base: BOX_PROFILE() }) }),
  { R2_TROLLMAP_CHARTPACKS: R2 });
  const d = await res.json();
  assert.equal(d.merged.waterClarity.secchiFt, 4.5);
  assert.deepEqual(d.withdrawn, []);
});
