/**
 * Worker/conditions.js — one call that answers "what is this water doing right now".
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 *   GET /conditions/{slug}?lat=&lon=&date=YYYY-MM-DD&tz=-4
 *
 * WHY ONE ENDPOINT AND NOT TWELVE
 *
 * The dataset sweep found roughly a dozen feeds worth building. The mistake sitting in front of
 * that is a dozen endpoints, so the client makes eight calls from a boat ramp on one bar of
 * signal. This assembles everything true about a water at a moment, Worker-side, in parallel,
 * and returns it once. SmartPlan needs all of it together anyway.
 *
 * PARTIAL BY DESIGN
 *
 * Sources fail independently and say so. One dead upstream degrades a field, never the
 * response: every source lands in `sources[]` with `ok`, `fetched_at`, and — separately — the
 * time the OBSERVATION was made, because those are different questions and conflating them is
 * how a five-week-old reading gets presented as current.
 *
 * WHAT IS NOT HERE YET
 *
 * Water level, flow, tide and currents need `registry/water_bindings.json` — which gauge, which
 * CO-OPS station, which NWM reach serves which water. Today the registry carries 9 bindings
 * across 1,722 waters, so those slots are declared and empty rather than faked. See
 * GAUGE_AND_UTILITY_PLAN_2026-08-06.md and build_water_bindings.py.
 *
 * Everything below keys on a lat/lon alone, which every water already has.
 *
 * VERIFIED 2026-08-06 against Wateree's centroid (34.437616, -80.818179)
 *
 *   USNO      sundata Begin Civil Twilight 06:10, Rise 06:38, Upper Transit 13:29,
 *             Set 20:20, End Civil Twilight 20:47; moondata Rise 00:06, Upper Transit 07:23,
 *             Set 14:49; curphase "Waning Crescent", fracillum "44%"
 *   MapClick  location.wfo "CAE", location.radar "KCAE", location.zone "SCZ022",
 *             plus 13 forecast periods and a current observation from KCUB
 *
 * NOTE THAT USNO IS THE US NAVY, NOT NOAA. NOAA has no sun/moon API — its solar calculator is
 * client-side JavaScript. This is the authoritative source and it is a different agency.
 */
import { CORS, JSON_HEADERS } from './worker-core.js';

const UA = 'TrollMap/1.0 (personal fishing app)';

// Per-source TTL, not one global number. A convective outlook and a moonrise do not go stale at
// the same rate, and caching them together means either re-fetching the almanac every five
// minutes or serving a four-hour-old storm risk.
const TTL = { usno: 6 * 3600, point: 1800, spc: 900, wwa: 300, nwm: 900 };  // WWA 5 min, NWM hourly

const _cache = new Map();

function cached(key, ttl, fn) {
  const hit = _cache.get(key);
  const now = Date.now();
  if (hit && now - hit.t < ttl * 1000) return Promise.resolve(hit.v);
  return fn().then((v) => {
    _cache.set(key, { t: now, v });
    if (_cache.size > 64) _cache.delete(_cache.keys().next().value);
    return v;
  });
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── sun, moon and the solunar periods ───────────────────────────────────────────────────────

function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function minToHhmm(m) {
  const x = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
}

/**
 * Solunar periods from USNO's own numbers.
 *
 * MAJOR periods are the moon overhead and the moon underfoot; MINOR are moonrise and moonset.
 * USNO reports Upper Transit but not Lower, so the second major is derived at +12h25m — half a
 * lunar day, the interval between successive transits. That derivation is stated in the output
 * (`derived: true`) rather than presented as measured, because it is arithmetic on top of a
 * measurement and the difference matters if it is ever wrong.
 *
 * This replaces the hardcoded Julian approximation in catch-journal.js, which cannot produce a
 * transit at all — it only gives phase.
 */
function solunar(sundata, moondata) {
  const pick = (arr, phen) => {
    const e = (arr || []).find((x) => x && x.phen === phen);
    return e ? hhmmToMin(e.time) : null;
  };
  const upper = pick(moondata, 'Upper Transit');
  const rise = pick(moondata, 'Rise');
  const set = pick(moondata, 'Set');
  const HALF_LUNAR_DAY = 745;                 // 12 h 25 m
  const out = [];
  if (upper !== null) {
    out.push({ kind: 'major', reason: 'moon overhead', start: minToHhmm(upper - 60), peak: minToHhmm(upper), end: minToHhmm(upper + 60) });
    const lower = upper + HALF_LUNAR_DAY;
    out.push({ kind: 'major', reason: 'moon underfoot', start: minToHhmm(lower - 60), peak: minToHhmm(lower), end: minToHhmm(lower + 60), derived: true });
  }
  if (rise !== null) out.push({ kind: 'minor', reason: 'moonrise', start: minToHhmm(rise - 30), peak: minToHhmm(rise), end: minToHhmm(rise + 30) });
  if (set !== null) out.push({ kind: 'minor', reason: 'moonset', start: minToHhmm(set - 30), peak: minToHhmm(set), end: minToHhmm(set + 30) });
  out.sort((a, b) => hhmmToMin(a.peak) - hhmmToMin(b.peak));
  return out;
}

async function skyAlmanac(lat, lon, date, tz) {
  const url = `https://aa.usno.navy.mil/api/rstt/oneday?date=${encodeURIComponent(date)}`
            + `&coords=${lat},${lon}&tz=${tz}`;
  const j = await cached(`usno:${lat},${lon},${date},${tz}`, TTL.usno, () => getJson(url));
  const d = (j && j.properties && j.properties.data) || {};
  const grab = (arr, phen) => {
    const e = (arr || []).find((x) => x && x.phen === phen);
    return e ? e.time : null;
  };
  return {
    date, tz,
    sun: {
      civil_dawn: grab(d.sundata, 'Begin Civil Twilight'),
      rise: grab(d.sundata, 'Rise'),
      transit: grab(d.sundata, 'Upper Transit'),
      set: grab(d.sundata, 'Set'),
      civil_dusk: grab(d.sundata, 'End Civil Twilight'),
    },
    moon: {
      rise: grab(d.moondata, 'Rise'),
      transit: grab(d.moondata, 'Upper Transit'),
      set: grab(d.moondata, 'Set'),
      phase: d.curphase || null,
      illumination: d.fracillum || null,
      closest_phase: d.closestphase
        ? { phase: d.closestphase.phase, on: `${d.closestphase.year}-${String(d.closestphase.month).padStart(2, '0')}-${String(d.closestphase.day).padStart(2, '0')}`, time: d.closestphase.time }
        : null,
    },
    solunar: solunar(d.sundata, d.moondata),
    source: 'USNO (US Navy — NOAA has no sun/moon API)',
  };
}

// ── point forecast, and the identifiers that come free with it ──────────────────────────────

async function pointForecast(lat, lon) {
  const url = `https://forecast.weather.gov/MapClick.php?lat=${lat}&lon=${lon}&FcstType=json`;
  const j = await cached(`mapclick:${lat},${lon}`, TTL.point, () => getJson(url));
  const loc = j.location || {};
  const t = j.time || {};
  const d = j.data || {};
  const co = j.currentobservation || {};
  const periods = [];
  const names = t.startPeriodName || [];
  for (let i = 0; i < Math.min(names.length, 6); i++) {
    periods.push({
      name: names[i],
      starts: (t.startValidTime || [])[i] || null,
      temp_f: (d.temperature || [])[i] ?? null,
      temp_is: (t.tempLabel || [])[i] || null,
      pop_pct: (d.pop || [])[i] ?? null,
      summary: (d.weather || [])[i] || null,
      text: (d.text || [])[i] || null,
    });
  }
  return {
    // These are the reason to call MapClick even if the forecast text is never shown: they are
    // derived from the point rather than looked up in a table. NWS renumbered the marine zones
    // in April 2026 and the old ids still return an expired file with a 200, so any hardcoded
    // zone table is wrong the moment it goes stale and gives no sign of it.
    wfo: loc.wfo || null,
    radar: loc.radar || null,
    zone: loc.zone || null,
    place: loc.areaDescription || null,
    observation: co.Temp ? {
      station: co.id || null, name: co.name || null,
      temp_f: co.Temp, weather: co.Weather || null,
      observed_at: co.Date || null,          // the OBSERVATION time, not the fetch time
    } : null,
    hazards: (d.hazard || []).length ? d.hazard : [],
    periods,
  };
}

// ── convective outlook ──────────────────────────────────────────────────────────────────────

/**
 * SPC Day 1 categorical outlook, filtered to a point.
 *
 * This is the lightning answer, and on an SC afternoon it is a safety field rather than a
 * fishing one. NOAA ships the render colours with the risk categories, so anything drawn from
 * this matches SPC's own map instead of inventing a scale.
 */
async function convective(lat, lon) {
  const url = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/'
            + 'SPC_wx_outlks/MapServer/1/query'
            + `?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326`
            + '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false&f=json';
  const j = await cached(`spc:${lat.toFixed(2)},${lon.toFixed(2)}`, TTL.spc, () => getJson(url));
  const feats = (j && j.features) || [];
  if (!feats.length) return { risk: null, label: 'no categorical risk area over this point' };
  const a = feats[0].attributes || {};
  return {
    risk: a.label || a.LABEL || null,
    label: a.label2 || a.LABEL2 || null,
    valid: a.valid || a.VALID || null,
    expire: a.expire || a.EXPIRE || null,
    stroke: a.stroke || null, fill: a.fill || null,
  };
}

// ── active watches, warnings and advisories ─────────────────────────────────────────────────

/**
 * NWS WWA filtered to a point. VERIFIED 2026-08-06 by Ryan against Wateree's centroid: the
 * point query works and the layer declares exactly these fields —
 *
 *   prod_type (Hazard Type, 40 chars)  event (4)  issuance (25)  expiration (25)  url (254)
 *
 * It returned `"features": []`, which is the RIGHT answer and worth saying out loud: no warning
 * was active over that lake at that moment. An empty array here is good news, not a failure,
 * and code that treats "no features" as an error will cry wolf on every clear day.
 *
 * `prod_type` is the useful one for a kayak — it carries "Small Craft Advisory" and "Special
 * Weather Statement" rather than a numeric code.
 */
async function hazards(lat, lon) {
  const url = 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/'
            + 'watch_warn_adv/MapServer/1/query'
            + `?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326`
            + '&spatialRel=esriSpatialRelIntersects'
            + '&outFields=prod_type,event,issuance,expiration,url&returnGeometry=false&f=json';
  const j = await cached(`wwa:${lat.toFixed(3)},${lon.toFixed(3)}`, TTL.wwa, () => getJson(url));
  const feats = (j && j.features) || [];
  return {
    active: feats.length,
    // Empty means clear, and the field says so rather than leaving a caller to infer it.
    all_clear: feats.length === 0,
    items: feats.map((f) => {
      const a = f.attributes || {};
      return { type: a.prod_type || null, event: a.event || null,
               issued: a.issuance || null, expires: a.expiration || null, url: a.url || null };
    }),
  };
}

// ── rivers: what is actually running, right now ─────────────────────────────────────────────

/**
 * National Water Model analysis, filtered to a box around the water.
 *
 * VERIFIED 2026-08-06 by Ryan, over Wateree. Two things this settles that were recorded as
 * hard limits elsewhere:
 *
 *   1. `raw.feature_id` IS the NHDPlus COMID / NWM reach id. The gauge plan and the dataset
 *      sweep both state that `/nwps/v1/reaches?bbox` returns 404, so "you must arrive with a
 *      COMID" and the only route to one was `/nwps/v1/gauges/{lid}` — which needs a gauge, and
 *      95 of 230 rivers have none. This layer enumerates them geographically. The no-gauge
 *      problem is not parked any more.
 *
 *   2. `raw.gnis_name` carries real stream names — "Grannies Quarter Creek", "White Oak
 *      Creek". White Oak Creek is one of Wateree's own arms and is named in its POI layer,
 *      which is the cross-check that this is the right network.
 *
 * Sample rows, verbatim:
 *
 *   feature_id 9715605  order 4  "Grannies Quarter Creek"  streamflow 76.98  anomaly_cat 6
 *   feature_id 9714867  order 1  "White Oak Creek"         streamflow 0      anomaly_cat 3
 *   cg_valid_time 1786024800000 = 14:00 UTC, ingested 15:09 — about 40 minutes old.
 *
 * TWO THINGS DELIBERATELY NOT INTERPRETED HERE.
 *
 * **Units.** Physics says CFS: 77 for a 4th-order creek is ordinary, 77 cms would be 2,718 cfs
 * and it is not that. The dataset sweep independently recorded CFS. Two signals agreeing is
 * still not a measurement, so the value is passed through with `units: 'cfs (unconfirmed)'`
 * until one reach is checked against a USGS gauge on the same water. A flow number rendered
 * with a confident unit that turns out to be wrong by 35x is worse than one that admits it.
 *
 * **`anomaly_category`.** 6 and 3 are codes into a legend nobody here has read. Passed through
 * raw rather than translated into "high" or "low", because guessing the direction of an anomaly
 * is exactly the kind of confident wrong answer this project keeps paying for.
 */
async function rivers(lat, lon, boxDeg) {
  const b = Math.min(Math.max(boxDeg || 0.15, 0.02), 0.6);
  const env = [lon - b, lat - b, lon + b, lat + b].map((n) => n.toFixed(4)).join(',');
  const url = 'https://mapservices.weather.noaa.gov/vector/rest/services/obs/'
            + 'NWM_Stream_Analysis/MapServer/19/query'
            + `?where=${encodeURIComponent('raw.stream_order>=2')}`
            + `&geometry=${env}&geometryType=esriGeometryEnvelope&inSR=4326`
            + '&spatialRel=esriSpatialRelIntersects'
            + '&outFields=' + encodeURIComponent('raw.feature_id,raw.stream_order,raw.gnis_name,'
              + 'analysis_assim.streamflow,analysis_assim.streamflow_anomaly,'
              + 'analysis_assim.anomaly_category,analysis_assim.cg_valid_time')
            + '&returnGeometry=false&resultRecordCount=200&f=json';
  const j = await cached(`nwm:${lat.toFixed(2)},${lon.toFixed(2)}`, TTL.nwm, () => getJson(url));
  const feats = (j && j.features) || [];
  const seen = new Map();
  let newest = null;
  for (const f of feats) {
    const a = f.attributes || {};
    const id = a['raw.feature_id'];
    if (id == null || seen.has(id)) continue;
    const vt = a['analysis_assim.cg_valid_time'];
    if (vt && (!newest || vt > newest)) newest = vt;
    seen.set(id, {
      comid: Math.round(id),
      name: (a['raw.gnis_name'] || '').trim() || null,
      order: a['raw.stream_order'] ?? null,
      flow: a['analysis_assim.streamflow'] ?? null,
      anomaly: a['analysis_assim.streamflow_anomaly'] ?? null,
      anomaly_category: a['analysis_assim.anomaly_category'] ?? null,
    });
  }
  const all = [...seen.values()].sort((x, y) => (y.order || 0) - (x.order || 0) || (y.flow || 0) - (x.flow || 0));
  return {
    // Named streams first — an angler recognises "Beaver Creek", not COMID 9714867.
    named: all.filter((r) => r.name).slice(0, 12),
    unnamed: all.filter((r) => !r.name).length,
    units: 'cfs (unconfirmed — verify one reach against a USGS gauge before displaying)',
    observed_at: newest ? new Date(newest).toISOString() : null,
    truncated: !!(j && j.exceededTransferLimit),
    note: 'anomaly_category is NOAA\'s own code, passed through untranslated',
  };
}

// ── assembly ────────────────────────────────────────────────────────────────────────────────

function nowIso() { return new Date().toISOString(); }

export async function handleConditions(request, env, url) {
  const mm = url.pathname.match(/^\/conditions\/([^/]+)$/);
  if (!mm) return null;
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (request.method !== 'GET') {
    return new Response('{"error":"method not allowed"}', { status: 405, headers: { ...CORS, ...JSON_HEADERS } });
  }
  const slug = mm[1];
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return new Response(JSON.stringify({
      error: 'lat and lon are required',
      why: 'the Worker has no lake registry; the client knows the centroid it selected',
    }), { status: 400, headers: { ...CORS, ...JSON_HEADERS } });
  }
  const tz = Number(url.searchParams.get('tz')) || -4;
  const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);

  // allSettled, never all: one dead upstream degrades a field, not the response.
  const jobs = [
    ['almanac', skyAlmanac(lat, lon, date, tz)],
    ['forecast', pointForecast(lat, lon)],
    ['convective', convective(lat, lon)],
    ['hazards', hazards(lat, lon)],
    ['rivers', rivers(lat, lon, Number(url.searchParams.get('box')))],
  ];
  const settled = await Promise.allSettled(jobs.map((j) => j[1]));

  const out = { slug, at: nowIso(), point: { lat, lon }, sources: [] };
  settled.forEach((r, i) => {
    const name = jobs[i][0];
    if (r.status === 'fulfilled') {
      out[name] = r.value;
      out.sources.push({ name, ok: true, fetched_at: nowIso() });
    } else {
      out[name] = null;
      out.sources.push({ name, ok: false, fetched_at: nowIso(), error: String(r.reason && r.reason.message || r.reason) });
    }
  });

  // Declared, not faked. These need registry/water_bindings.json — which gauge, which CO-OPS
  // station, which NWM reach serves this water. Returning nulls with a reason is honest; a
  // missing key reads as "the app forgot", and a zero reads as a measurement.
  out.water = null;
  out.tide = null;
  out.pending = {
    water: 'needs water_bindings.json (gauge / pool / tailwater / NWM reach)',
    tide: 'needs water_bindings.json (CO-OPS tide and currents station); coastal waters only',
  };

  return new Response(JSON.stringify(out), {
    headers: { ...CORS, ...JSON_HEADERS, 'Cache-Control': 'public, max-age=300' },
  });
}

export const CONDITIONS_ROUTES = [
  '/conditions/<slug>?lat=&lon=&date=YYYY-MM-DD&tz=-4  — sun, moon, solunar, forecast, storm risk, warnings, live river flow',
];
