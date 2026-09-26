// A THERMOMETER IN THE LAKE BEATS THE RELEASE BELOW THE DAM.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Lake Murray, 2026-09-26. The lake has two live thermometers in its own water, at the heads of the
// Saluda and Little Saluda arms -- 02167600 SALUDA R NEAR PROSPERITY (78.8 F) and 02167716 LITTLE
// SALUDA R NEAR PROSPERITY (80.8 F), inside the registry boundary about 40 m from its edge. Both
// publish temperature and oxygen and no level, so build_water_bindings.py dropped them with every
// other level-less site, and the only temperature Murray's card and plan ever had was the Saluda
// BELOW the dam: 60.3 F. The pool site, 02168500, lists 00010 but its equipment was moved for
// construction and it has read only stage since 2024-02-27. Ryan named both Prosperity sites.
//
// The binder now writes level-less water-quality sites to their own `quality` list. The Worker
// reads it for the parameters it probes and never for stage or flow; and on a LAKE, a temperature
// seeded from below the dam is provisional -- a reading taken on the lake replaces it, and the
// below-dam one is kept beside it. On a river the tailrace is the water being fished and stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleConditions, usgsSitesFor } from '../Worker/conditions.js';

const POOL = { usgs_site: '02168500', name: 'LAKE MURRAY NEAR COLUMBIA, SC', lat: 34.0521,
               lon: -81.2207, confidence: 'name+geom', usgs_parms: ['00010', '00062', '00300'] };
const TAIL = { usgs_site: '02168504', name: 'Saluda River below Lake Murray Dam', lat: 34.0510,
               lon: -81.2095, confidence: 'name+near',
               usgs_parms: ['00010', '00060', '00065', '00300'] };
const LITTLE = { usgs_site: '02167716', name: 'LITTLE SALUDA R NEAR PROSPERITY, SC', lat: 34.0796,
                 lon: -81.5618, confidence: 'name+geom', km_outside: 0, source: 'usgs',
                 site_type: 'ST', parms: ['00010', '00300'] };
const BIG = { usgs_site: '02167600', name: 'SALUDA R NEAR PROSPERITY, SC', lat: 34.0993,
              lon: -81.5684, confidence: 'name+geom', km_outside: 0, source: 'usgs',
              site_type: 'ST', parms: ['00010', '00300'] };

const BINDINGS = { _note: 'test fixture', bindings: {
  lake_murray: { slug: 'lake_murray', display_name: 'Lake Murray (Lexington Co, SC)', state: 'SC',
                 feature_type: 'lake', centroid: [-81.4533, 34.0857],
                 pool: POOL, tailwater: TAIL, quality: [LITTLE, BIG] },
  // Same instruments, filed as a RIVER: the release is the water being fished.
  lower_river: { slug: 'lower_river', display_name: 'A river below a dam', state: 'SC',
                 feature_type: 'river', centroid: [-81.2, 34.04],
                 tailwater: TAIL, quality: [LITTLE] },
  // A lake whose only thermometer is below the dam: nothing to replace it with, so it stands.
  release_only: { slug: 'release_only', display_name: 'A lake with one thermometer, below its dam',
                  state: 'SC', feature_type: 'lake', centroid: [-81.4533, 34.0857],
                  pool: POOL, tailwater: TAIL },
} };
const body = JSON.stringify(BINDINGS);
const env = { R2_TROLLMAP_CHARTPACKS: { async get(key) {
  return key === '_registry/water_bindings.json' ? { httpMetadata: {}, text: async () => body } : null;
} } };

// Readings as the sites gave them on 2026-09-26 at 16:00 EDT. The pool's temperature series is
// the -999999 sentinel, which is what a moved instrument publishes.
const READ = {
  '02168500': { '00062': '357.9', '00010': '-999999', '00300': '-999999' },
  '02168504': { '00010': '15.7', '00300': '8.6', '00060': '1900', '00065': '3.4' },
  '02167716': { '00010': '27.1', '00300': '7.4' },
  '02167600': { '00010': '26.0', '00300': '7.9' },
};
globalThis.fetch = async (url) => {
  const u = String(url);
  const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (u.includes('waterservices.usgs.gov/nwis/iv')) {
    const site = Object.keys(READ).find((s) => u.includes(s));
    if (!site) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    return ok({ value: { timeSeries: Object.entries(READ[site]).map(([code, v]) => ({
      sourceInfo: { siteCode: [{ value: site }] },
      variable: { variableCode: [{ value: code }], noDataValue: -999999 },
      values: [{ method: [{ methodDescription: '' }],
                 value: [{ value: v, dateTime: '2026-09-26T16:00:00-04:00', qualifiers: ['P'] }] }],
    })) } });
  }
  return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
};

async function run(slug, lat, lon) {
  const url = new URL(`https://x/conditions/${slug}?lat=${lat}&lon=${lon}&date=2026-09-27&tz=-4`);
  const res = await handleConditions(new Request(url, { method: 'GET' }), env, url);
  return JSON.parse(await res.text());
}
const HILTON = [34.094287, -81.328882];

test('the quality list is read by the parameter probe, and nothing in it is a stage gauge', () => {
  const sites = usgsSitesFor(BINDINGS.bindings.lake_murray, HILTON[0], HILTON[1]);
  const q = sites.filter((s) => s.role === 'quality').map((s) => s.site).sort();
  assert.deepEqual(q, ['02167600', '02167716']);
  // On the lake, a site on the water comes before the release.
  assert.equal(sites.at(-1).site, '02168504');
  assert.equal(sites.at(-1).below_dam, true);
});

test('on Lake Murray the lake\'s own thermometer replaces the release, which is kept beside it', async () => {
  const j = await run('lake_murray', ...HILTON);
  const w = j.water || j;
  assert.ok(w.water_temp, JSON.stringify(w).slice(0, 400));
  assert.equal(w.water_temp.usgs_site, '02167716', 'the nearer of the two arm thermometers to Hilton');
  assert.equal(w.water_temp.f, 80.8);
  assert.equal(w.water_temp.below_dam, false);
  assert.ok(Number.isFinite(w.water_temp.km_from_point) && w.water_temp.km_from_point > 20);
  assert.equal(w.water_temp_below_dam && w.water_temp_below_dam.f, 60.3);
  // Oxygen from the lake's water too, not the release.
  assert.equal(w.dissolved_oxygen && w.dissolved_oxygen.usgs_site, '02167716');
  // And the stage is still the pool's, not a thermometer's.
  assert.notEqual(w.gauge && w.gauge.usgs_site, '02167716');
});

test('on a river below the dam the release is the water, and it stands', async () => {
  const j = await run('lower_river', 34.04, -81.2);
  const w = j.water || j;
  assert.equal(w.water_temp && w.water_temp.usgs_site, '02168504');
  assert.equal(w.water_temp_below_dam, null);
});

test('a lake whose only thermometer is below the dam keeps it, labelled as below the dam', async () => {
  const j = await run('release_only', ...HILTON);
  const w = j.water || j;
  assert.equal(w.water_temp && w.water_temp.usgs_site, '02168504');
  assert.equal(w.water_temp.below_dam, true);
  assert.equal(w.water_temp_below_dam, null);
});
