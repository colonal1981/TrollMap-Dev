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
    // A CORPS LAKE. `usace[]` is what the binder writes: the project sits in the list beside the
    // turbine units and the transmission lines, and usaceLevels() is what tells them apart, by
    // intersecting these names against the district's OWN published roster of conservation
    // pools. Nothing here is typed into the Worker, which is the property this fixture pins.
    corps_lake: {
      slug: 'corps_lake', display_name: 'Hartwell-shaped Lake (Anderson Co, SC/GA)',
      state: 'SC', feature_type: 'lake', centroid: [-82.82, 34.42],
      pool: { lid: 'HWDS1', name: 'Savannah River at the dam', lat: 34.42, lon: -82.82,
              confidence: 'name+geom' },
      usace: [
        { office: 'SAS', cwms_name: '02187010', name: 'a bare site number' },
        { office: 'SAS', cwms_name: 'Hartwell-Unit1', name: 'a turbine' },
        { office: 'SAS', cwms_name: 'HartwellPowerhouse', name: 'the powerhouse' },
        { office: 'SAS', cwms_name: 'Hartwell', name: 'HARTWELL DAM' },
      ],
      ramps: [],
    },
    // A WATER WITH NO NWS LID ANYWHERE. 34 of the 204 bound waters look like this -- Monticello
    // Reservoir, Hyco Lake, Randleman, John H. Moss -- and until 2026-08-25 every one of them
    // got `trend: null`, because the only trend this app had came from NWPS /stageflow and that
    // needs a handbook-5 id. All 34 have a USGS site number.
    no_lid_lake: {
      slug: 'no_lid_lake', display_name: 'Monticello-shaped Reservoir (Fairfield Co, SC)',
      state: 'SC', feature_type: 'lake', centroid: [-81.32, 34.31],
      pool: { usgs_site: '02160900', name: 'Reservoir near Jenkinsville', lat: 34.31,
              lon: -81.32, confidence: 'name+geom', usgs_parms: ['00062'] },
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
    // 'cfs' HERE IS NOT A TYPO AND NOT THE OBSERVATION'S UNIT. Live on 2026-08-16 every gauge
    // sampled — GADS1, WATS1, AUGG1, KEOS1, CLTT1 — publishes flood.flowUnits 'cfs' while
    // status.observed.secondaryUnit says 'kcfs'. This fixture used to say 'kcfs' here, which
    // agreed with the bug and so could never catch it.
    flood: { stageUnits: 'ft', flowUnits: 'cfs', categories: {
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
  // THE EMPTY UNIT, WHICH IS REAL: CLTT1 publishes secondaryUnit '' live. A real secondary with
  // a blank unit and a flood table that says 'cfs' is the exact shape that used to slip a kcfs
  // number through labelled as cfs.
  BYBN7: {
    lid: 'BYBN7', name: 'Bay River at Bayboro', reachId: '8441999',
    status: { observed: { primary: 1.05, primaryUnit: 'ft', secondary: 3.2, secondaryUnit: '',
                          floodCategory: 'no_flooding', validTime: '2026-08-09T18:00:00Z' } },
    flood: { flowUnits: 'cfs', categories: {} }, inService: { enabled: true, message: '' },
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
  // THE CORPS. Four calls in order: the district roster of everything publishing a conservation
  // pool, that project's own levels, its Flow/Elev-Tail catalogue, then one series read each.
  // Values transcribed from the live service on 2026-08-25 where they were read, and the units
  // are the real trap: the CATALOGUE says "m" and the DATA endpoint says "ft" for the same
  // series, so the flows arrive as cms and have to come out as cfs.
  if (u.includes('cwms-data.usace.army.mil')) {
    if (u.includes('/levels') && !u.includes('level-id-mask=Hartwell')) {
      // The roster. Savannah publishes four, and 'Hartwell-Unit1' is not one of them.
      return ok({ levels: ['Hartwell', 'NSBLD', 'Russell', 'Thurmond'].map((p) => ({
        'office-id': 'SAS', 'location-level-id': `${p}.Elev.Inst.0.Top of Conservation`,
        'specified-level-id': 'Top of Conservation' })) });
    }
    if (u.includes('/levels')) {
      return ok({ levels: [{
        'office-id': 'SAS', 'location-level-id': 'Hartwell.Elev.Inst.0.Top of Conservation',
        'specified-level-id': 'Top of Conservation', 'constant-value': 660 }] });
    }
    if (u.includes('/catalog/TIMESERIES')) {
      return ok({ total: 5, 'page-size': 500, entries: [
        'Flow-Out.Ave.1Hour.1Hour.Raw-SHEF_SAS', 'Flow-Power.Ave.1Hour.1Hour.Raw-SHEF_SAS',
        'Flow-Spill.Ave.1Hour.1Hour.Raw-SHEF_SAS', 'Flow-In.Ave.1Hour.1Hour.Raw-SHEF_SAS',
        'Elev-Tail.Inst.1Hour.0.Raw-SHEF_SAS',
      ].map((n) => ({ office: 'SAS', name: `Hartwell.${n}`, units: 'm', interval: '1Hour',
        extents: [{ 'latest-time': '2026-08-25T01:00:00Z' }] })) });
    }
    if (u.includes('/timeseries')) {
      const name = decodeURIComponent((u.match(/name=([^&]+)/) || [])[1] || '');
      const v = { 'Flow-Out': 200, 'Flow-Power': 180, 'Flow-Spill': 20, 'Flow-In': 150,
                  'Elev-Tail': 480.2 }[Object.keys({ 'Flow-Out': 0, 'Flow-Power': 0,
                  'Flow-Spill': 0, 'Flow-In': 0, 'Elev-Tail': 0 })
                  .find((k) => name.includes(k))];
      if (v === undefined) return { ok: false, status: 404, json: async () => ({}) };
      return ok({ name, 'office-id': 'SAS', units: name.includes('Elev') ? 'ft' : 'cms',
        'value-columns': [{ name: 'date-time', ordinal: 1 }, { name: 'value', ordinal: 2 },
                          { name: 'quality-code', ordinal: 3 }],
        values: [[Date.parse('2026-08-25T01:00:00Z'), v, 0]] });
    }
  }
  // THE NATIONAL WATER DASHBOARD, for the no-lid water. Two rows transcribed from a live read
  // of site 02160900 on 2026-08-25: 00062 = 422.77 falling 0.3 ft/h, and the 62615 companion
  // 0.17 ft below it on a different datum.
  if (u.includes('dashboard.waterdata.usgs.gov')) {
    return ok({ value: [
      { SiteNumber: '02160900', ParameterCode: '00062', TimeLocal: '2026-08-24T22:00:00Z',
        TimeZoneCode: 'EDT', Value: 422.77, ValueFlagCode: null,
        RateOfChangeUnitPerHour: -0.3, FloodStageStatusCode: 'NOFLOOD' },
      { SiteNumber: '02160900', ParameterCode: '62615', TimeLocal: '2026-08-24T22:00:00Z',
        TimeZoneCode: 'EDT', Value: 422.6, ValueFlagCode: null,
        RateOfChangeUnitPerHour: -0.3, FloodStageStatusCode: null },
    ] });
  }
  // The gauge read itself, so the site resolves to a reading and not to a failure.
  if (u.includes('waterservices.usgs.gov/nwis/iv') && u.includes('02160900')) {
    return ok({ value: { timeSeries: [{
      variable: { variableCode: [{ value: '00062' }] },
      values: [{ method: [{ methodDescription: '' }],
                 value: [{ value: '422.77', dateTime: '2026-08-24T18:00:00-04:00',
                           qualifiers: ['P'] }] }],
    }] } });
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
// AN EMPTY UNIT IS SILENCE, NOT CFS. BYBN7 reports secondary 3.2 with secondaryUnit '' and a
// flood table claiming 'cfs'. Neither may be used: the flow is unknown-unit and must be null,
// and flow_units must be null with it so nothing downstream prints a bare number as a fact.
{
  const all = [r.water?.gauge, ...(r.water?.other_gauges || [])].filter(Boolean);
  const bay = all.find((g) => g.lid === 'BYBN7');
  check('BYBN7 present', !!bay, all.map((g) => g.lid));
  check('empty secondaryUnit does not become cfs', bay?.flow === null, bay?.flow);
  check('flow_units null when the flow is', bay?.flow_units === null, bay?.flow_units);
  check('flow_reported_units null, not the flood table',
    bay?.flow_reported_units === null, bay?.flow_reported_units);
}

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
  /some_pond_nobody_bound/.test(r.pending?.water || '') && /5 waters are bound/.test(r.pending?.water || ''),
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

console.log('\n== a water with no NWS lid still gets a trend and a flood category ==');
{
  const rn = await run('no_lid_lake', 34.31, -81.32, env);
  const w = rn.water || {};
  // THE WIRING, not the shaper. The shapers are unit-tested in usgs-dashboard.test.js; this
  // proves waterBlock actually calls them and puts the result where a caller will find it.
  check('the pool reads from its USGS site', w.pool?.stage === 422.77, w.pool?.stage);
  check('and says the reading is an elevation above a datum, not a gage height',
    w.pool?.stage_basis === 'elevation_above_datum', w.pool?.stage_basis);
  check('trend is not null on a water NWPS cannot answer for', !!w.trend, w.trend);
  check('and it says where it came from, because NWPS answers the same field',
    w.trend?.source === 'USGS National Water Dashboard — CurrentConditions', w.trend?.source);
  check('it carries the hourly rate', w.trend?.rate_per_hour === -0.3, w.trend);
  check('and does NOT invent a 24-hour change out of it',
    w.trend?.change_24h === null && w.trend?.change_7d === null, w.trend);
  check('the datum is named, because 00062 and 62615 are different measurements',
    w.trend?.measures === 'Reservoir elevation above datum', w.trend?.measures);
  check('flood category reaches a USGS-only gauge',
    w.pool?.flood_category === 'NOFLOOD', w.pool?.flood_category);
  check('and says which agency said so',
    w.pool?.flood_category_source === 'USGS National Water Dashboard',
    w.pool?.flood_category_source);
}

console.log('\n== a Corps lake gets a target and a release, both off the registry ==');
{
  const rc = await run('corps_lake', 34.42, -82.82, env);
  const w = rc.water || {};
  // THE PROJECT IS DISCOVERED, NOT TYPED. `usace[]` carries a bare site number, a turbine and a
  // powerhouse alongside the project, and only the district's own roster says which is the lake.
  check('the project is picked out of the binding by the roster',
    w.usace?.project === 'Hartwell', w.usace?.project);
  check('and the target for today comes with it — a Corps lake has no single full pool',
    w.usace?.conservation_pool_ft === 660, w.usace?.conservation_pool_ft);
  check('the release is not null on a Corps lake', !!w.usace_release, w.usace_release);
  check('cms out of the data endpoint arrives as cfs — 200 cms is 7,063 cfs',
    w.usace_release?.outflow?.value === 7063, w.usace_release?.outflow);
  check('turbines and spillway are separate facts, not one number',
    w.usace_release?.through_turbines?.value === 6357
      && w.usace_release?.spill?.value === 706, w.usace_release);
  check('the tailwater comes back in feet, because the DATA said ft',
    w.usace_release?.tailwater_ft === 480.2, w.usace_release?.tailwater_ft);
  check('and it reaches `releases`, where Duke and TVA lakes already were',
    rc.water?.releases?.operator === 'US Army Corps of Engineers',
    rc.water?.releases?.operator);
  check('observed, not scheduled — this is the hour that just passed',
    rc.water?.releases?.kind === 'observed', rc.water?.releases?.kind);
}

console.log('\n== an NWPS water still prefers NWPS for its trend ==');
{
  // A month of observations beats a single rate, and a second opinion on one fact is how two
  // numbers start disagreeing on a card. The dashboard is only consulted where NWPS gave null.
  const rm = await run('lake_murray', 34.0857, -81.4533, env);
  check('murray trend is not the dashboard',
    rm.water?.trend == null
      || rm.water.trend.source !== 'USGS National Water Dashboard — CurrentConditions',
    rm.water?.trend?.source);
  check('an NWPS gauge keeps its own flood category, not a second opinion',
    rm.water?.pool?.flood_category_source === undefined, rm.water?.pool?.flood_category_source);
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}`);
process.exit(fails ? 1 : 0);
