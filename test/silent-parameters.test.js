// THE THIRD STATE: a parameter a bound site PUBLISHES and did not answer with.
//
// Until 2026-08-25 the response could tell two states apart -- a reading, and "no bound site
// measures this" -- and the gap between them rendered as nothing at all. Ryan's Lower Saluda
// card showed no water temperature and no reason: three bound sites catalogue 00010, which put
// it in `published` and so excluded it from "Not published", and none of them returned a number.
// Site 02168504 below the Murray dam was carrying 14.0 degC / 57.2 degF at the time.
import { handleConditions } from '../Worker/conditions.js';

const BINDINGS = { _note: 'test fixture', bindings: {
  // The registry already knows what this site publishes, so no catalogue request is made and
  // there is no period of record to report. `last: null` must mean "we do not know", never
  // "the series is dead".
  silent_lake: {
    slug: 'silent_lake', display_name: 'Silent Lake (Lexington Co, SC)', state: 'SC',
    feature_type: 'lake', centroid: [-81.22, 34.05], ramps: [],
    pool: { usgs_site: '02168504', name: 'Saluda River below Lake Murray Dam',
            lat: 34.05, lon: -81.22, usgs_parms: ['00060', '00065', '00010', '00300'] },
  },
  // Asked and did not answer at all. A dead gauge and a live gauge with one quiet sensor are
  // different problems and only one of them is worth driving to.
  dead_site: {
    slug: 'dead_site', display_name: 'Dead Gauge Lake (Aiken Co, SC)', state: 'SC',
    feature_type: 'lake', centroid: [-81.5, 33.5], ramps: [],
    pool: { usgs_site: '99999999', name: 'a site that 503s', lat: 33.5, lon: -81.5,
            usgs_parms: ['00065', '00010'] },
  },
  // No `usgs_parms`, so the catalogue is fetched and carries USGS's own period of record. Two
  // sites publish 00010 and the FIRST one walked is the one that stopped in 2019.
  dated_lake: {
    slug: 'dated_lake', display_name: 'Dated Lake (Kershaw Co, SC)', state: 'SC',
    feature_type: 'lake', centroid: [-80.7, 34.3], ramps: [],
    pool: { usgs_site: '11111111', name: 'the retired sonde', lat: 34.3, lon: -80.7 },
    gauges: [{ usgs_site: '22222222', name: 'the live sonde', lat: 34.31, lon: -80.71 }],
  },
} };

const bodyText = JSON.stringify(BINDINGS);
const env = { R2_TROLLMAP_CHARTPACKS: { async get(key) {
  return key === '_registry/water_bindings.json'
    ? { httpMetadata: {}, text: async () => bodyText } : null;
} } };

// One flow series and nothing else. Every site here publishes temperature and reports none.
const FLOW_ONLY = { value: { timeSeries: [{
  variable: { variableCode: [{ value: '00060' }] },
  values: [{ method: [{ methodDescription: '' }],
             value: [{ value: '1240', dateTime: '2026-08-25T14:00:00-04:00' }] }] }] } };

const T = '\t';
const rdb = (rows) => ['# catalogue',
  ['agency_cd', 'site_no', 'parm_cd', 'begin_date', 'end_date', 'count_nu'].join(T),
  ['5s', '15s', '5s', '10d', '10d', '8n'].join(T),
  ...rows.map((r) => ['USGS', r.site, r.code, r.begin, r.end, r.count].join(T)),
].join('\n');

const CATALOGS = {
  11111111: rdb([{ site: '11111111', code: '00060', begin: '1988-10-01', end: '2026-08-25', count: '13000' },
                 { site: '11111111', code: '00010', begin: '1988-10-01', end: '2019-09-30', count: '11200' }]),
  22222222: rdb([{ site: '22222222', code: '00010', begin: '2020-05-01', end: '2026-08-22', count: '2280' }]),
};

globalThis.fetch = async (url) => {
  const u = String(url);
  const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => '' });
  if (u.includes('seriesCatalogOutput=true')) {
    const site = (u.match(/sites=(\d+)/) || [])[1];
    if (CATALOGS[site]) return { ok: true, status: 200, text: async () => CATALOGS[site] };
    return { ok: false, status: 404, text: async () => '' };
  }
  if (u.includes('waterservices.usgs.gov/nwis/iv')) {
    if (u.includes('99999999')) return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
    return ok(FLOW_ONLY);
  }
  return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
};

async function run(slug, lat, lon) {
  const url = new URL(`https://x/conditions/${slug}?lat=${lat}&lon=${lon}&date=2026-08-25&tz=-4`);
  return JSON.parse(await (await handleConditions(new Request(url, { method: 'GET' }), env, url)).text());
}

let fails = 0;
const check = (label, cond, extra) => {
  if (cond) console.log(`  ok   ${label}`);
  else { fails++; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const find = (list, code) => (list || []).find((x) => x.code === code);

console.log('== a published parameter that returned nothing says so ==');
{
  const r = await run('silent_lake', 34.05, -81.22);
  const s = r.water?.silent_parameters;
  const temp = find(s, '00010');
  check('water temperature is reported silent, not absent', !!temp, s);
  check('and it names the site to go look at', temp?.usgs_site === '02168504', temp?.usgs_site);
  check('and the gauge by name', temp?.name === 'Saluda River below Lake Murray Dam', temp?.name);
  check('the registry has no period of record, so none is claimed', temp?.last === null, temp?.last);
  check('the reason is a quiet sensor, not a dead site', temp?.reason === 'no_reading', temp?.reason);
  check('dissolved oxygen is silent too', !!find(s, '00300'), s);
  // THE BUG THIS FIXES. 00010 is catalogued, so it can never appear under "Not published" --
  // which is why it rendered as nothing at all.
  check('a silent parameter is NOT called unpublished',
    !find(r.water?.unpublished_parameters, '00010'), r.water?.unpublished_parameters);
  check('what nobody publishes is still reported',
    !!find(r.water?.unpublished_parameters, '63680'), r.water?.unpublished_parameters);
}

console.log('\n== a site that did not answer is a different problem ==');
{
  const r = await run('dead_site', 33.5, -81.5);
  const temp = find(r.water?.silent_parameters, '00010');
  check('still reported', !!temp, r.water?.silent_parameters);
  check('and blamed on the whole gauge, not one sensor', temp?.reason === 'site_silent', temp?.reason);
}

console.log('\n== two sites publish it; the LIVE one is the one worth chasing ==');
{
  const r = await run('dated_lake', 34.3, -80.7);
  const temp = find(r.water?.silent_parameters, '00010');
  check('temperature is silent', !!temp, r.water?.silent_parameters);
  // The retired sonde is walked first. First-wins would name a series that stopped seven
  // years ago and send somebody to a gauge that is not there any more.
  check('names the site with the newest period of record', temp?.usgs_site === '22222222', temp?.usgs_site);
  check('and carries USGS\'s own end date', temp?.last === '2026-08-22', temp?.last);
  check('and its observation count', temp?.count === 2280, temp?.count);
  check('flow answered, so flow is not silent', !find(r.water?.silent_parameters, '00060'), r.water?.silent_parameters);
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}`);
process.exit(fails ? 1 : 0);
