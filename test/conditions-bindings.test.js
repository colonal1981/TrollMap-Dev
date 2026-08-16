// Harness: exercise handleConditions with a stubbed R2 + stubbed upstreams.
// Response shapes below are the ones VERIFIED live on 2026-08-09, trimmed.
import { handleConditions } from '../Worker/conditions.js';

const BINDINGS = {
  _note: 'test fixture',
  bindings: {
    lake_murray: {
      slug: 'lake_murray', display_name: 'Lake Murray (Lexington Co, SC)', state: 'SC',
      feature_type: 'lake', centroid: [-81.4533, 34.0857],
      pool: { lid: 'IRMS1', name: 'Saluda River at Lake Murray Dam near Irmo',
              lat: 34.0519, lon: -81.2208, confidence: 'name+geom', km_outside: 0.0 },
      tailwater: { lid: 'MURS1', name: 'Saluda River below Lake Murray Dam',
                   lat: 34.0508, lon: -81.2097, confidence: 'name+near', km_outside: 0.8 },
      ramps: [], reach: { comid: '12345', from_lid: 'IRMS1' },
    },
    coast_pamlico_sound_nc: {
      slug: 'coast_pamlico_sound_nc', display_name: 'Pamlico Sound / Neuse River, NC',
      state: 'NC', feature_type: 'coastal', centroid: [-76.45, 35.1],
      pool: { lid: 'CBFN7', name: 'Neuse River at Cherry Branch Ferry Terminal',
              lat: 34.9378, lon: -76.8107, confidence: 'name+geom' },
      gauges: [
        { lid: 'BYBN7', name: 'Bay River at Bayboro', lat: 35.141, lon: -76.7651,
          confidence: 'geom_only_inside' },
        { lid: 'BERN7', name: 'Trent River at New Bern', lat: 35.1028, lon: -77.0366,
          confidence: 'geom_only_inside' },
      ],
      ramps: [],
      tides: [
        { id: '8655875', name: 'Sea Level', lat: 34.875, lon: -76.3433,
          kind: 'tidepredictions', measured: false },
        { id: '8654467', name: 'Hatteras measured', lat: 35.208, lon: -75.704,
          kind: 'waterlevels', measured: true },
        { id: 'ACT7846', name: 'Entrance', lat: 34.98667, lon: -76.405,
          kind: 'currentpredictions', measured: false },
      ],
    },
    dry_lake: {
      slug: 'dry_lake', display_name: 'Dry Lake', state: 'GA', feature_type: 'lake',
      centroid: [-83, 33],
      gauges: [{ lid: 'BOOMS1', name: 'gauge that 500s', lat: 33, lon: -83 }],
      ramps: [],
    },
  },
};

// ── stub R2 ─────────────────────────────────────────────────────────────────────────────────
const bodyText = JSON.stringify(BINDINGS);
function makeEnv({ present = true } = {}) {
  return {
    R2_TROLLMAP_CHARTPACKS: {
      async get(key) {
        if (!present) return null;
        if (key !== '_registry/water_bindings.json') return null;
        return { httpMetadata: {}, text: async () => bodyText };
      },
    },
  };
}

// ── stub fetch ──────────────────────────────────────────────────────────────────────────────
const NWPS = {
  IRMS1: {
    lid: 'IRMS1', name: 'Saluda River at Lake Murray Dam near Irmo',
    usgsId: '02168504', reachId: '9752696',
    status: {
      observed: { primary: 356.93, primaryUnit: 'ft', secondary: -999, secondaryUnit: 'kcfs',
                  floodCategory: 'no_flooding', validTime: '2026-08-09T18:30:00Z' },
      forecast: { primary: -999, primaryUnit: '', secondary: -999, secondaryUnit: '',
                  floodCategory: 'fcst_not_current', validTime: '0001-01-01T00:00:00Z' },
    },
    flood: { stageUnits: 'ft', flowUnits: 'kcfs', categories: {
      major: { stage: 365, flow: -9999 }, moderate: { stage: 363, flow: -9999 },
      minor: { stage: 360, flow: -9999 }, action: { stage: 359, flow: -9999 } } },
    datums: { vertical: { value: [{ label: 'NAVD88', abbrev: 'NAVD88', value: -1.31 }] } },
    inService: { enabled: true, message: '' },
  },
  MURS1: {
    lid: 'MURS1', name: 'Saluda River below Lake Murray Dam', usgsId: '02168504', reachId: null,
    status: {
      observed: { primary: 3.4, primaryUnit: 'ft', secondary: 1.9, secondaryUnit: 'kcfs',
                  floodCategory: 'no_flooding', validTime: '2026-08-09T18:15:00Z' },
      forecast: { primary: 4.1, primaryUnit: 'ft', secondary: -999, secondaryUnit: '',
                  floodCategory: 'no_flooding', validTime: '2026-08-10T00:00:00Z' },
    },
    flood: { categories: { action: { stage: 12, flow: -9999 } } },
    inService: { enabled: true, message: '' },
  },
  CBFN7: {
    lid: 'CBFN7', name: 'Neuse River at Cherry Branch Ferry Terminal', reachId: '8441317',
    status: { observed: { primary: 1.22, primaryUnit: 'ft', secondary: -999,
                          floodCategory: 'no_flooding', validTime: '2026-08-09T18:00:00Z' } },
    flood: { categories: {} }, inService: { enabled: true, message: '' },
  },
  BYBN7: {
    lid: 'BYBN7', name: 'Bay River at Bayboro', reachId: '8441999',
    status: { observed: { primary: 1.05, primaryUnit: 'ft', secondary: -999,
                          floodCategory: 'no_flooding', validTime: '2026-08-09T18:00:00Z' } },
    flood: { categories: {} }, inService: { enabled: true, message: '' },
  },
  BERN7: {
    lid: 'BERN7', name: 'Trent River at New Bern', reachId: '8441111',
    status: { observed: { primary: 0.9, primaryUnit: 'ft', secondary: -999,
                          floodCategory: 'no_flooding', validTime: '2026-08-09T18:00:00Z' } },
    flood: { categories: {} }, inService: { enabled: false, message: 'gauge under repair' },
  },
};

const TIDE_HILO = { predictions: [
  { t: '2026-08-09 03:08', v: '0.665', type: 'L' },
  { t: '2026-08-09 08:04', v: '3.794', type: 'H' },
  { t: '2026-08-09 15:15', v: '-0.121', type: 'L' },
  { t: '2026-08-09 20:41', v: '4.76', type: 'H' },
] };
const CURRENTS = { current_predictions: { units: 'feet, knots', cp: [
  { Type: 'slack', meanFloodDir: 268, Bin: '1', meanEbbDir: 103, Time: '2026-08-09 00:33' },
  { Type: 'flood', meanFloodDir: 268, Bin: '1', meanEbbDir: 103, Time: '2026-08-09 03:22',
    Velocity_Major: '1.4' },
] } };
const WATER_LEVEL = { data: [{ t: '2026-08-09 18:24', v: '2.113', s: '0.02', f: '0,0,0,0' }] };

const calls = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  const ok = (o) => ({ ok: true, status: 200, json: async () => o });
  const m = /nwps\/v1\/gauges\/([A-Z0-9]+)$/.exec(u);
  if (m) {
    if (NWPS[m[1]]) return ok(NWPS[m[1]]);
    return { ok: false, status: 500, json: async () => ({}) };
  }
  if (u.includes('tidesandcurrents')) {
    if (u.includes('product=currents_predictions')) return ok(CURRENTS);
    if (u.includes('product=water_level')) return ok(WATER_LEVEL);
    if (u.includes('product=predictions')) return ok(TIDE_HILO);
  }
  // everything else (USNO, MapClick, SPC, WWA, NWM) — make it fail so the harness proves
  // the water/tide fields survive dead neighbours.
  return { ok: false, status: 503, json: async () => ({}) };
};

async function run(slug, lat, lon, env) {
  const url = new URL(`https://x/conditions/${slug}?lat=${lat}&lon=${lon}&date=2026-08-09&tz=-4`);
  const res = await handleConditions(new Request(url, { method: 'GET' }), env, url);
  return JSON.parse(await res.text());
}

let fails = 0;
const check = (label, cond, extra) => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { fails++; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};

const env = makeEnv();

if (process.argv[2] === 'absent') {
  console.log('\n== bindings object absent from R2 (cold isolate) ==');
  const r0 = await run('lake_murray', 34.0857, -81.4533, makeEnv({ present: false }));
  check('water null', r0.water === null, r0.water);
  check('pending explains and names the fix',
    /upload_garmin_to_r2/.test(r0.pending?.water || ''), r0.pending);
  check('water source marked not-ok', r0.sources.find((s) => s.name === 'water')?.ok === false);
  check('response is still 200-shaped with almanac slot', 'almanac' in r0);
  console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}`);
  process.exit(fails ? 1 : 0);
}

console.log('\n== lake_murray (pool + tailwater, no tide) ==');
let r = await run('lake_murray', 34.0857, -81.4533, env);
check('water present', !!r.water);
check('pool stage 356.93', r.water?.pool?.stage === 356.93, r.water?.pool?.stage);
check('pool flow -999 dropped to null', r.water?.pool?.flow === null, r.water?.pool?.flow);
check('pool forecast -999 dropped to null', r.water?.pool?.forecast === null, r.water?.pool?.forecast);
check('flood thresholds kept, -9999 flow not leaked',
  JSON.stringify(r.water?.pool?.flood_thresholds) === '{"action":359,"minor":360,"moderate":363,"major":365}',
  r.water?.pool?.flood_thresholds);
check('datum NAVD88 -1.31', r.water?.pool?.datum?.value === -1.31, r.water?.pool?.datum);
check('reach comid from gauge call', r.water?.pool?.reach_comid === '9752696', r.water?.pool?.reach_comid);
// 1.9 KCFS IS 1,900 CFS. This fixture has carried `secondaryUnit: 'kcfs'` since it was written
// and this assertion checked the raw 1.9, so the unit was recorded and never read — which is
// exactly how the Congaree card printed "Flow 4 ft3/s" on a river running four thousand.
// NWPS publishes discharge in kcfs; USGS publishes 00060 in ft3/s; both arrived in `flow`.
check('tailwater flow 1.9 kcfs becomes 1900 cfs',
      r.water?.tailwater?.flow === 1900, r.water?.tailwater?.flow);
check('and the unit it arrived in is still reported',
      r.water?.tailwater?.flow_reported_units === 'kcfs', r.water?.tailwater?.flow_reported_units);
check('tailwater forecast kept', r.water?.tailwater?.forecast?.stage === 4.1, r.water?.tailwater?.forecast);
check('tidal false', r.water?.tidal === false, r.water?.tidal);
check('tide null', r.tide === null, r.tide);
check('no pending key (water is bound)', !('pending' in r), r.pending);
check('water in sources[] ok', r.sources.find((s) => s.name === 'water')?.ok === true);
check('dead neighbours still reported failed', r.sources.filter((s) => !s.ok).length === 5,
  r.sources.filter((s) => !s.ok).map((s) => s.name));

console.log('\n== coast_pamlico_sound_nc (tide + currents + measured level) ==');
r = await run('coast_pamlico_sound_nc', 35.1, -76.45, env);
check('tidal true', r.water?.tidal === true);
check('nearest gauge picked by requested point = BERN7 or BYBN7',
  ['BERN7', 'BYBN7'].includes(r.water?.gauge?.lid), r.water?.gauge?.lid);
check('out-of-service surfaced', r.water?.gauge?.lid !== 'BERN7' || r.water?.gauge?.in_service === false,
  r.water?.gauge?.in_service);
check('other_gauges sorted by distance',
  (r.water?.other_gauges || []).every((g, i, a) => i === 0 || a[i - 1].km_from_point <= g.km_from_point),
  r.water?.other_gauges);
check('4 highs/lows', r.tide?.highs_lows?.length === 4, r.tide?.highs_lows?.length);
check('hilo ft parsed as number', r.tide?.highs_lows?.[1]?.ft === 3.794, r.tide?.highs_lows?.[1]);
check('negative low kept (not treated as no-data)', r.tide?.highs_lows?.[2]?.ft === -0.121,
  r.tide?.highs_lows?.[2]);
check('covers two days', JSON.stringify(r.tide?.covers) === '["2026-08-09","2026-08-10"]', r.tide?.covers);
check('currents events present', r.tide?.currents?.events?.length === 2, r.tide?.currents);
check('slack has null speed, flood has 1.4',
  r.tide?.currents?.events?.[0]?.speed_kn === null && r.tide?.currents?.events?.[1]?.speed_kn === 1.4,
  r.tide?.currents?.events);
const measuredAsked = calls.some((u) => u.includes('product=water_level'));
check('measured level fetched only when station.measured',
  measuredAsked === (r.tide?.station?.measured === true), { measuredAsked, st: r.tide?.station });

console.log('\n== dry_lake (gauge 500s) ==');
r = await run('dry_lake', 33, -83, env);
check('water block still returned', !!r.water);
check('failure recorded, not thrown', r.water?.failed?.length === 1, r.water?.failed);
check('gauge null', r.water?.gauge === null);

console.log('\n== unbound slug ==');
r = await run('some_pond_nobody_bound', 34, -81, env);
check('water null', r.water === null);
check('pending names the slug and the count',
  /some_pond_nobody_bound/.test(r.pending?.water || '') && /3 waters are bound/.test(r.pending?.water || ''),
  r.pending);
check('pending has no tide key for an inland miss', !('tide' in (r.pending || {})), r.pending);

console.log('\n== cache: warm isolate serves a deleted object, ?fresh=1 does not ==');
r = await run('lake_murray', 34.0857, -81.4533, makeEnv({ present: false }));
check('warm cache still answers after the object goes away', r.water?.pool?.stage === 356.93,
  r.water?.pool?.stage);
{
  const u = new URL('https://x/conditions/lake_murray?lat=34.0857&lon=-81.4533&date=2026-08-09&tz=-4&fresh=1');
  const res = await handleConditions(new Request(u, { method: 'GET' }), makeEnv({ present: false }), u);
  const rf = JSON.parse(await res.text());
  check('fresh=1 bypasses the cache and reports the truth', rf.water === null, rf.water);
  check('fresh=1 pending names the fix', /upload_garmin_to_r2/.test(rf.pending?.water || ''), rf.pending);
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}`);
process.exit(fails ? 1 : 0);
