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
 * THE REGISTRY HALF — WATER LEVEL, FLOW AND TIDE
 *
 * Everything above keys on a lat/lon alone. Level, flow and tide cannot: they need to know WHICH
 * gauge and WHICH CO-OPS station serve this particular water, and no coordinate answers that.
 * That answer lives in `registry/water_bindings.json`, built offline by build_water_bindings.py
 * on the rule this codebase applies to ramps — name relation AND geometry, never either alone.
 *
 * It is read here from R2 at `_registry/water_bindings.json`, once per Worker isolate per hour,
 * because it is one object serving every request. 244 of the registry's 1,746 waters carry a
 * row: 102 lakes, 121 rivers, 21 of the 22 coastal zones. Every one of those 244 has at least a
 * pool, a tailwater or a gauge, so a bound water always produces a real reading. A water with no
 * row returns `pending` naming itself — that is a gap in the registry, not a gap in the code,
 * and it is fixed by rerunning the builder, not by editing this file.
 *
 * VERIFIED 2026-08-09 against live upstreams:
 *
 *   NWPS      /nwps/v1/gauges/IRMS1 → status.observed {primary 356.93, primaryUnit "ft",
 *             secondary -999, floodCategory "no_flooding", validTime}; flood.categories
 *             action 359 / minor 360 / moderate 363 / major 365; datums.vertical NAVD88 -1.31.
 *             /nwps/v1/gauges/MEMT1 additionally carries usgsId 07032000 and reachId 7474830 —
 *             so the NWM COMID comes back FROM the gauge call and needs no second lookup.
 *   CO-OPS    predictions/hilo at 8665737 → {"predictions":[{"t","v","type"}]};
 *             currents_predictions/MAX_SLACK at ACT7846 → current_predictions.cp
 *             [{Type "slack|flood|ebb", Time, meanFloodDir, meanEbbDir}].
 *
 * -999 AND -9999 ARE NOT MEASUREMENTS. NWPS uses them for "no data" and CO-OPS thresholds use
 * -9999 for "no flow stage defined". Both are dropped to null here. A river showing 0 cfs when
 * the gauge simply is not reporting flow is the exact failure this endpoint exists to avoid.
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
import { CORS, JSON_HEADERS, r2Text } from './worker-core.js';
import { dukeRowForNames, fetchDukeFlowArrivals, fetchUsgs, getLakeClarity, RIVERS, lakeKeyFromName }
  from './worker-data.js';
import { parseCubeLevels, parseSouthernCoLevels, parseBrookfieldFacility } from './operators.js';
import { reportTokens } from './reports.js';

const UA = 'TrollMap/1.0 (personal fishing app)';

// Per-source TTL, not one global number. A convective outlook and a moonrise do not go stale at
// the same rate, and caching them together means either re-fetching the almanac every five
// minutes or serving a four-hour-old storm risk.
//
// `gauge` is 900 because NWPS republishes on a 15-minute cadence; asking more often returns the
// same row. `tide` is six hours because a high-water time is astronomy — it was correct last
// week and will be correct next week. `level` is a MEASURED water level, which is weather.
const TTL = {
  usno: 6 * 3600, point: 1800, spc: 900, wwa: 300, nwm: 900,
  bindings: 3600, gauge: 900, tide: 6 * 3600, level: 600,
};

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

// ── the bindings: which gauge, which station, actually serves this water ────────────────────

const BINDINGS_KEY = '_registry/water_bindings.json';

// Deliberately NOT in `_cache`. That map evicts at 64 entries on a first-in rule, and this is
// one large object that every request touches — it would be thrown away by a run of lake
// lookups and re-fetched from R2 for no reason. One slot, one hour, its own variables.
let _bindings = null;
let _bindingsAt = 0;

/**
 * The registry, read from the bucket rather than bundled into the Worker.
 *
 * Bundling it would mean a Worker deploy every time the pipeline learns about a gauge, and this
 * repo auto-deploys on push — so a registry change would become a code change. It is an R2
 * object for the same reason lake_index.json is: the pipeline owns it, and publishing it is
 * `upload_garmin_to_r2.py`, not `git push`.
 *
 * The object is stored gzipped, so it goes through r2Text rather than obj.text().
 */
async function waterBindings(env, fresh) {
  const now = Date.now();
  if (!fresh && _bindings && now - _bindingsAt < TTL.bindings * 1000) return _bindings;
  const bucket = env && env.R2_TROLLMAP_CHARTPACKS;
  if (!bucket) throw new Error('R2_TROLLMAP_CHARTPACKS is not bound to this Worker');
  const obj = await bucket.get(BINDINGS_KEY);
  if (!obj) throw new Error(`${BINDINGS_KEY} is not in the bucket — run upload_garmin_to_r2.py`);
  const parsed = JSON.parse(await r2Text(obj));
  const b = parsed && (parsed.bindings || parsed);
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw new Error(`${BINDINGS_KEY} has no \`bindings\` object`);
  }
  _bindings = b;
  _bindingsAt = now;
  return b;
}

// -999 is NWPS for "no reading"; -9999 is its flood table for "no flow stage defined". Neither
// is a number anyone should see. NaN lands here too, which is what Number(undefined) gives when
// an optional CO-OPS field is absent.
const NO_DATA = new Set([-999, -9999, -99999]);
const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && !NO_DATA.has(n) ? n : null;
};

function kmBetween(aLat, aLon, bLat, bLon) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const s = Math.sin(dLat / 2) ** 2
          + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const round1 = (n) => Math.round(n * 10) / 10;
// Hundredths, because the whole point of the chart-datum block is a difference of a few feet and
// rounding it to tenths before anyone has decided whether to trust it throws away the evidence.
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Nearest to the point the CLIENT asked about — its selected ramp or centroid — not nearest to
 * the water's own centroid.
 *
 * This is the answer to the open question in GAUGE_AND_UTILITY_PLAN_2026-08-06.md §"What counts
 * as a binding for a river". A lake has one gauge; a 90 km river reach may have four and the
 * useful one depends on where you launch. Picking by the requested point makes that decision
 * per request instead of per registry row, and the ones not picked are still listed in
 * `other_gauges` so nothing is hidden.
 */
function nearest(list, lat, lon) {
  let best = null, bestKm = Infinity;
  for (const x of list || []) {
    if (!x || !Number.isFinite(x.lat) || !Number.isFinite(x.lon)) continue;
    const d = kmBetween(lat, lon, x.lat, x.lon);
    if (d < bestKm) { best = x; bestKm = d; }
  }
  return best ? { ...best, km: round1(bestKm) } : null;
}

/**
 * One NWPS gauge, read whole.
 *
 * `/gauges/{lid}` is used rather than `/gauges/{lid}/stageflow` on purpose: stageflow returns
 * roughly 470 rows of 15-minute history to answer "what is it now", while this returns the
 * current value, the forecast, the flood thresholds, the datum, the USGS site and the NWM reach
 * id in one object. The reach id matters — the gauge plan recorded that a COMID could only be
 * reached via a gauge lookup, and this IS that lookup, so the NWM binding comes back free.
 */
async function nwpsGauge(lid, role, bound, lat, lon) {
  const j = await cached(`nwps:${lid}`, TTL.gauge,
    () => getJson(`https://api.water.noaa.gov/nwps/v1/gauges/${encodeURIComponent(lid)}`));
  const st = (j.status && j.status.observed) || {};
  const fc = (j.status && j.status.forecast) || {};
  const cats = (j.flood && j.flood.categories) || {};

  const thresholds = {};
  for (const k of ['action', 'minor', 'moderate', 'major']) {
    const s = num(cats[k] && cats[k].stage);
    if (s !== null) thresholds[k] = s;
  }
  const vert = (((j.datums || {}).vertical || {}).value || [])[0] || null;
  const fcStage = num(fc.primary);

  return {
    lid,
    role,                                     // pool | tailwater | gauge
    name: j.name || (bound && bound.name) || null,
    stage: num(st.primary),
    stage_units: st.primaryUnit || (j.flood && j.flood.stageUnits) || null,
    flow: num(st.secondary),
    flow_units: st.secondaryUnit || (j.flood && j.flood.flowUnits) || null,
    // The OBSERVATION time, not the fetch time. NWPS writes year 0001 for "never".
    observed_at: st.validTime && !String(st.validTime).startsWith('0001') ? st.validTime : null,
    flood_category: st.floodCategory || null,
    flood_thresholds: Object.keys(thresholds).length ? thresholds : null,
    forecast: fcStage === null ? null : {
      stage: fcStage,
      units: fc.primaryUnit || null,
      valid: fc.validTime || null,
      flood_category: fc.floodCategory || null,
    },
    datum: vert ? { abbrev: vert.abbrev || null, value: num(vert.value) } : null,
    in_service: (j.inService || {}).enabled !== false,
    out_of_service_message: ((j.inService || {}).message) || null,
    // NWPS publishes none of the three. Present as null so a caller cannot tell an NWPS gauge
    // from a USGS one by key presence — the same reason flood_category is null on usgsSite.
    water_temp_c: null,
    dissolved_oxygen_mg_l: null,
    turbidity_fnu: null,
    tidal_flow_cfs: null,
    specific_conductance_us_cm: null,
    salinity_ppt: null,
    usgs_site: j.usgsId || null,
    reach_comid: j.reachId || null,
    // Registry fields, passed through: TVA's own numbers for the dam this pool sits behind, and
    // how the binding was made. `name+geom` is a stronger claim than `geom_only_inside` and the
    // caller is entitled to know which one it got.
    tva: (bound && bound.tva) || null,
    binding_confidence: (bound && bound.confidence) || null,
    km_from_point: bound && Number.isFinite(bound.lat) && Number.isFinite(bound.lon)
      ? round1(kmBetween(lat, lon, bound.lat, bound.lon)) : null,
  };
}

/**
 * One USGS site, read whole — the same shape `nwpsGauge` returns, from a different agency.
 *
 * NOT EVERY GAUGE HAS A HANDBOOK-5 ID. NWS ingests most USGS sites and republishes them under an
 * LID, which is why `nwpsGauge` covers the great majority. But it does not ingest all of them,
 * and the ones it misses are disproportionately the ones that matter here: reservoir-pool
 * gauges. Monticello Reservoir, Thurmond, Blalock, Bowen, North Saluda, Table Rock, Hyco and
 * Greenwood all have a USGS site reporting pool and no NWPS gauge on the water at all. Reading
 * only `.lid` meant the binder could publish those bindings and this Worker would step over
 * every one of them — data on disk, and an empty panel on the screen.
 *
 * `00062` is elevation of the reservoir surface above datum and `00065` is stage on a local
 * datum. Both are "how high is the water" and which one it is travels in `stage_basis`, so the
 * response never presents a local gage stage as an elevation above NAVD88.
 *
 * THE FETCH IS NOT WRITTEN HERE. `worker-data.js` already has `fetchUsgs`, audited 2026-08-03,
 * which does the JSON read, falls back to RDB when a site only answers RDB, filters USGS's
 * `-999999` sentinel, and knows that `62614` and `62615` are also reservoir elevation. A second
 * implementation in this file would be two code paths that can disagree about the same number —
 * which is the objection this file already raises against re-fetching the NWM reach. So this
 * wraps it and shapes the result like `nwpsGauge`'s; it does not re-derive it.
 */
// One parameter list, one cache key, so the temperature lookup below and the gauge read above
// share a single request per site rather than issuing two that can disagree.
//
// 63160 WAS ALREADY MAPPED AND NEVER REQUESTED. `fetchUsgs` has read
// "Stream water level elevation above NAVD 1988" into `elevationNavd88` for as long as it has
// existed, and `usgsSite` below already prefers it when 00062 is absent — but this string did
// not ask for it. In South Carolina alone 202 sites publish it, against 244 for gage height,
// and 02147801 — the Wateree tailrace this app reads for temperature — is one of them.
// A capability that exists and is never reached is the same as no capability.
//
// 00300 and 63680 are new. Verified against this endpoint rather than from memory:
//   00300  Dissolved oxygen, water, unfiltered, mg/L        39 SC sites
//   63680  Turbidity, FNU (monochrome near-IR, 90 degrees)   8 SC sites
// Both are fishing facts, not telemetry. The summer oxygen squeeze decides what depth holds
// fish, and a measured turbidity is a real clarity number where the model otherwise runs on
// rainfall.
//
// DELIBERATELY NOT REQUESTED, so the omission is a decision and not an oversight:
//   00400 pH                               no consumer. Fetching a number nothing reads is how
//                                          a response grows without getting better.
//   00045 precipitation, 00025 barometric  NWS already answers both, per water, in `forecast`.
//
// ADDED FOR THE COAST, and one of them is a reversal I should own: 00095 was skipped above as
// having no consumer. The coastal strip is the consumer. On an estuary, specific conductance is
// what separates fresh water from brackish from salt, and trout and redfish sit on that line.
//
//   72137  Streamflow, tidally filtered    net flow with the tidal sloshing removed. On a tidal
//                                          river it is the only discharge figure that means
//                                          anything. 2 SC series live.
//   00095  Specific conductance            8 SC series live.
//   00480  Salinity, ppt                   REQUESTED AND EXPECTED ABSENT. The state inventory
//                                          lists 14 SC locations, and the instantaneous-values
//                                          service returned ZERO series for it on 2026-08-16
//                                          while returning 8 for 00095 and 2 for 72137 — those
//                                          14 are discrete samples, not a live feed. Asked for
//                                          because GA and NC are separate services and because
//                                          mapped-but-never-requested is exactly the 63160 bug.
//                                          Its absence must never render as fresh water.
const USGS_PARMS = '00062,62614,62615,63160,00065,00060,00010,00300,63680,72137,00095,00480';

async function usgsSite(site, role, bound, lat, lon) {
  const u = await cached(`usgs:${site}`, TTL.gauge, () => fetchUsgs(site, USGS_PARMS));
  const elev = Number.isFinite(u.elevation) ? u.elevation
             : (Number.isFinite(u.elevationNavd88) ? u.elevationNavd88 : null);
  const stage = Number.isFinite(u.gageHeight) ? u.gageHeight : null;
  const flow = Number.isFinite(u.streamflow) ? u.streamflow : null;
  const level = elev !== null ? elev : stage;
  if (level === null && flow === null) throw new Error(`no current value for USGS ${site}`);

  return {
    lid: null,
    usgs_site: site,
    role,
    name: (bound && bound.name) || null,
    stage: level,
    stage_units: level === null ? null : 'ft',
    // WHICH NUMBER THIS IS. A reservoir elevation above NAVD88 and a stage above a local gage
    // datum are both feet and mean different things; saying which one it is costs one field and
    // stops anything downstream from subtracting one from the other.
    stage_basis: level === null ? null : (elev !== null ? 'elevation_above_datum' : 'gage_height'),
    flow,
    flow_units: flow === null ? null : 'ft3/s',
    water_temp_c: Number.isFinite(u.tempC) ? u.tempC : null,
    // Null means THIS SITE does not publish it, not that the water has none.
    dissolved_oxygen_mg_l: Number.isFinite(u.doMgL) ? u.doMgL : null,
    turbidity_fnu: Number.isFinite(u.turbidityFnu) ? u.turbidityFnu : null,
    tidal_flow_cfs: Number.isFinite(u.tidalFlow) ? u.tidalFlow : null,
    specific_conductance_us_cm: Number.isFinite(u.spCond) ? u.spCond : null,
    salinity_ppt: Number.isFinite(u.salinityPpt) ? u.salinityPpt : null,
    observed_at: u.timestamp || null,
    // NWPS carries flood categories and a forecast; USGS publishes neither. Null here means
    // "this agency does not report it", not "no flooding" — the field exists so the shape
    // matches nwpsGauge and a caller cannot tell the two apart by key presence alone.
    flood_category: null,
    flood_thresholds: null,
    forecast: null,
    datum: null,
    in_service: true,
    out_of_service_message: null,
    reach_comid: null,
    source: 'usgs',
    site_type: (bound && bound.site_type) || null,
    tva: (bound && bound.tva) || null,
    binding_confidence: (bound && bound.confidence) || null,
    km_from_point: bound && Number.isFinite(bound.lat) && Number.isFinite(bound.lon)
      ? round1(kmBetween(lat, lon, bound.lat, bound.lon)) : null,
  };
}

/** Whichever id this binding entry actually carries. Used as its identity everywhere below. */
/**
 * TVA, which publishes more than anybody else and was being read for one static field.
 *
 * `build_water_bindings.py` has fetched `www.tva.com/RestApi/locations` since the beginning and
 * kept four columns off it -- dam, top-of-gates, river, river mile -- which travel on the
 * binding as `tva` and, until now, were the whole of what the app knew. Ryan traced the rest of
 * the API on 2026-08-15. It is a ServiceStack app and every route is open:
 *
 *   /observed-data-48-hours/{LID}  Day, Time, ReservoirElevation, TailwaterElevation,
 *                                  AverageHourlyDischarge -- ~51 rows over 48 h
 *   /operating-guide/{LID}         MidNightElevation + items[]: Day, TopOfGates, PrevYrElev,
 *                                  CurYrElev, BtmOpZone, TopOpZone, FloodGuide, GuideCurve,
 *                                  LowExptdElevRange, UpperExptdEleRange
 *   /generation-releases/{LID}     Day, Time (a RANGE), Generators (count running)
 *   /lake-messages/{LID}           EffectiveSince, Message, DisplayGeneration
 *
 * THE LID IS ALREADY THE RIGHT KEY. NWPS handbook-5 ids and TVA LocationIDs are one identifier
 * space -- CHAN7 is Chatuge in both -- and all 17 tva-flagged binding entries carry a lid that
 * appears in TVA's own locations list, 0 mismatches. So no registry change was needed to reach
 * this; the binding already said which dam to ask about.
 *
 * WHY GuideCurve MATTERS MORE THAN TopOfGates. Top of gates is the spillway crest. Norris on
 * 08/15: gates 1034, guide curve 1020, actual 1016.76. Publishing gates as "normal pool" reads
 * as 17 ft down on a lake that is 3 ft under guide. Chatuge is close enough to look right
 * (1928 / 1924.29 / 1923.36), which is exactly why one spot-check would not have caught it.
 * TVA runs a SEASONAL curve, so the reference is a number for today's date, not for the year.
 *
 * THE YEAR ON `Day` IS NOT TRUSTED. `observed-data-48-hours` and `generation-releases` return
 * 2026 dates; `operating-guide` returns 2025 while its `CurYrElev` matches today's reading.
 * Rather than guess which is authoritative, the guide is matched on MM/DD alone.
 */
const TVA_API = 'https://www.tva.com/RestApi';

// "1,923.38" -> 1923.38. TVA sends numbers as display strings, thousands separator included,
// and one of them (MidnightElevation) as a bare number, so this has to take both.
function tvaNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const n = Number(v.replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

const mmdd = (day) => String(day || '').slice(0, 5);   // "08/15/2026" -> "08/15"

/**
 * Pure: everything the four responses say, shaped. Separated from the fetch so the shapes can
 * be tested against captured fixtures without a network -- which is the only way this file gets
 * verified at all from a sandbox that cannot reach tva.com.
 */
export function tvaShape(observed, guide, releases, messages, todayMmDd) {
  const rows = Array.isArray(observed) ? observed : [];
  const last = rows.length ? rows[rows.length - 1] : null;
  const items = (guide && Array.isArray(guide.items)) ? guide.items : [];
  // MM/DD only -- see the year note above. Falls back to the last item so a leap-day or a short
  // feed reports something rather than nothing.
  const g = items.find((x) => mmdd(x.Day) === todayMmDd) || items[items.length - 1] || null;

  const elevation = last ? tvaNum(last.ReservoirElevation) : tvaNum(guide && guide.MidNightElevation);
  const guideCurve = g ? tvaNum(g.GuideCurve) : null;

  const gen = (Array.isArray(releases) ? releases : [])
    .map((r) => ({ day: r.Day || null, time: r.Time || null, generators: tvaNum(r.Generators) }))
    .filter((r) => r.generators !== null);

  const msg = (Array.isArray(messages) ? messages : [])
    .map((m) => (m && typeof m.Message === 'string' ? m.Message.trim() : ''))
    .find((m) => m.length) || null;

  return {
    elevation_ft: elevation,
    tailwater_ft: last ? tvaNum(last.TailwaterElevation) : null,
    discharge_cfs: last ? tvaNum(last.AverageHourlyDischarge) : null,
    observed_at: last ? [last.Day, last.Time].filter(Boolean).join(' ') || null : null,
    guide_curve_ft: guideCurve,
    flood_guide_ft: g ? tvaNum(g.FloodGuide) : null,
    top_of_gates_ft: g ? tvaNum(g.TopOfGates) : null,
    expected_range_ft: g && tvaNum(g.LowExptdElevRange) !== null
      ? [tvaNum(g.LowExptdElevRange), tvaNum(g.UpperExptdEleRange)] : null,
    // The number a person actually reads: how far off the seasonal target the lake is.
    // Signed, so negative is below guide.
    vs_guide_ft: (elevation !== null && guideCurve !== null)
      ? round2(elevation - guideCurve) : null,
    // Generation IS the current, and on a TVA tailwater the current is the whole question.
    // Capped because the feed runs days out and a plan is about today.
    generation: gen.slice(0, 12),
    generating_now: gen.length ? gen[0].generators > 0 : null,
    message: msg,
    source: 'TVA — tva.com/RestApi',
  };
}

async function tvaReservoir(lid, todayMmDd) {
  const one = (route) => cached(`tva:${route}:${lid}`, TTL.gauge,
    () => getJson(`${TVA_API}/${route}/${encodeURIComponent(lid)}?format=json`))
    .catch(() => null);
  const [observed, guide, releases, messages] = await Promise.all([
    one('observed-data-48-hours'), one('operating-guide'),
    one('generation-releases'), one('lake-messages'),
  ]);
  if (!observed && !guide) return null;
  return { lid, ...tvaShape(observed, guide, releases, messages, todayMmDd) };
}

function gaugeId(g) {
  if (!g) return null;
  return g.lid || (g.usgs_site ? `usgs:${g.usgs_site}` : null);
}

/** Dispatch on the id the entry carries, not on the one we hope it has. */
function readGauge(g, role, lat, lon) {
  return g.lid ? nwpsGauge(g.lid, role, g, lat, lon)
               : usgsSite(g.usgs_site, role, g, lat, lon);
}

/**
 * Level and flow for one water.
 *
 * Three reads at most — pool, tailwater, and the gauge nearest the requested point — in
 * parallel, each failing on its own. A dam has two numbers that mean different things: the pool
 * is what you launch onto and the tailwater is what the release is doing, and collapsing them
 * into one "level" throws away the half that decides whether the fish are moving.
 */
/* ══ USACE ═══════════════════════════════════════════════════════════════════════════════════
 *
 * https://cwms-data.usace.army.mil/cwms-data/levels — public, no key, no login.
 *
 * WHAT THIS ANSWERS is the one thing NWPS never does for a Corps lake: what elevation the lake
 * is SUPPOSED to be at today. `Top of Conservation` is the summer/winter pool target, and like
 * TVA's guide curve it is a SEASONAL CURVE, not a constant -- Hartwell runs 656 in winter and
 * 660 from April to mid-October. That 660 is the number hand-typed into worker-data.js, and it
 * no longer has to be.
 *
 * THE MASK RETURNS TURBINES AS WELL AS LAKES. Alongside `Hartwell` the bindings carry `HDam`,
 * `HartwellPowerhouse`, `Hartwell-Powerhouse`, `Hartwell-Unit1` and the bare USGS site number
 * `02187010`; Thurmond adds `Thurmond_Basin`, `Thurmond-O2System-Line3` and `Thurmond-Line1`.
 * Guessing which is the project is how a lake ends up reporting a generator's elevation, so it
 * is not guessed: one call per district returns EVERY location that has a Top of Conservation
 * at all, and the candidate is chosen from that roster. Measured 2026-08-16, the whole Savannah
 * district returns four -- Hartwell, NSBLD, Russell, Thurmond.
 *
 * TWO FIELDS DISAGREE WITH THEMSELVES AND ARE REPORTED RATHER THAN SMOOTHED:
 *
 *   Thurmond's Top of Conservation carries `interval-months: 13` while its seasonal offsets
 *   span 0..12. Read strictly, a 13-month cycle since a 1953 origin would put summer pool
 *   somewhere random in the calendar, and Thurmond's summer pool is 330 every year. It is
 *   evaluated annually and the anomaly travels with the answer.
 *
 *   Hartwell says `interpolate-string: "T"`; Thurmond says nothing at all. A value invented
 *   between two published set points is a derived number wearing a fact's clothes, so when the
 *   flag is absent the previous set point is HELD, and `interpolated` says which happened.
 */
const CWMS = 'https://cwms-data.usace.army.mil/cwms-data';
const TOP_OF_CONSERVATION = 'Top of Conservation';

// A location that is a generator, a valve, a line, a gate or a gauge -- not the reservoir.
const NOT_A_PROJECT = /(?:^\d+$)|(?:-(?:unit|line)\s*\d*)|powerhouse|o2system|gate|spillway|_basin\b|\bblw\b|\bbelow\b/i;

/** The project segment of a dotted location-level-id: "Hartwell.Elev.Inst.0.Top of ..." */
export function usaceProjectOf(levelId) {
  const s = String(levelId || '');
  const i = s.indexOf('.');
  return i > 0 ? s.slice(0, i) : null;
}

/**
 * Which of a binding's CWMS candidates is the reservoir. `roster` is the set of project names
 * the district actually publishes a conservation pool for, so this never invents one.
 */
export function usacePickProject(candidates, roster) {
  const ok = (candidates || [])
    .map((c) => c && c.cwms_name)
    .filter((n) => n && !NOT_A_PROJECT.test(n) && roster.has(n));
  if (!ok.length) return null;
  // Shortest wins: "Hartwell" over "HartwellPowerhouse" if both somehow survived the filter.
  return ok.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

/**
 * A CWMS seasonal level, evaluated for one instant. Pure -- `nowMs` is passed, never read.
 *
 * Offsets are months-and-minutes from the interval origin's anniversary. 20160 minutes is
 * exactly 14 days, which is how Hartwell's "October 15" is expressed as month 9 + 20160.
 */
export function usaceSeasonalValue(level, nowMs) {
  if (!level) return null;
  const vals = level['seasonal-values'];
  if (!Array.isArray(vals) || !vals.length) {
    const c = Number(level['constant-value']);
    return Number.isFinite(c) ? { value: c, seasonal: false, interpolated: false } : null;
  }
  const originMs = Date.parse(level['interval-origin'] || '');
  if (!Number.isFinite(originMs)) return null;
  const o = new Date(originMs);
  const yearNow = new Date(nowMs).getUTCFullYear();

  // Three cycles so a point before the first offset or after the last still has a bracket.
  const pts = [];
  for (const yr of [-1, 0, 1]) {
    for (const v of vals) {
      const base = Date.UTC(yearNow + yr, o.getUTCMonth() + Number(v['offset-months'] || 0),
        o.getUTCDate(), o.getUTCHours(), o.getUTCMinutes());
      pts.push({ t: base + Number(v['offset-minutes'] || 0) * 60000, value: Number(v.value) });
    }
  }
  pts.sort((a, b) => a.t - b.t);

  let prev = null; let next = null;
  for (const p of pts) {
    if (p.t <= nowMs) prev = p;
    else { next = p; break; }
  }
  if (!prev) return null;

  const linear = String(level['interpolate-string'] || '').toUpperCase() === 'T';
  let value = prev.value;
  let interpolated = false;
  if (linear && next && next.t > prev.t && next.value !== prev.value) {
    const f = (nowMs - prev.t) / (next.t - prev.t);
    value = prev.value + (next.value - prev.value) * f;
    interpolated = true;
  }
  const months = Number(level['interval-months']);
  return {
    value: Math.round(value * 100) / 100,
    seasonal: true,
    interpolated,
    prev: { value: prev.value, at: new Date(prev.t).toISOString() },
    next: next ? { value: next.value, at: new Date(next.t).toISOString() } : null,
    // Said, not smoothed. Both of these are real in the live feed.
    caution: [
      Number.isFinite(months) && months !== 12
        ? `USACE publishes interval-months ${months} on this level while its offsets span a year; evaluated annually`
        : null,
      linear ? null : 'no interpolate flag published — the previous set point is held, not interpolated',
    ].filter(Boolean).join('; ') || null,
  };
}

/** Every level for one project, shaped. Pure. */
export function usaceShape(levels, project, nowMs) {
  const mine = (levels || []).filter((l) => usaceProjectOf(l['location-level-id']) === project);
  if (!mine.length) return null;
  const by = (id) => mine.find((l) => l['specified-level-id'] === id) || null;
  const pool = usaceSeasonalValue(by(TOP_OF_CONSERVATION), nowMs);
  const floor = usaceSeasonalValue(by('Bottom of Conservation'), nowMs);
  const drought = ['Drought Level 1', 'Drought Level 2', 'Drought Level 3']
    .map((id) => {
      const l = by(id);
      const v = usaceSeasonalValue(l, nowMs);
      return v ? { level: id, ft: v.value, comment: (l['level-comment'] || '').replace(/\s+/g, ' ').trim() || null } : null;
    })
    .filter(Boolean);
  return {
    project,
    office: mine[0]['office-id'] || null,
    // The target elevation for TODAY, which is the whole point -- a Corps lake has no single
    // "full pool" and publishing one would be wrong for half the year.
    conservation_pool_ft: pool ? pool.value : null,
    conservation_pool: pool,
    bottom_of_conservation_ft: floor ? floor.value : null,
    drought_levels: drought,
    levels_published: mine.map((l) => l['specified-level-id']).filter(Boolean).sort(),
    source: `${CWMS}/levels?office=${mine[0]['office-id']}&level-id-mask=${project}.Elev.*`,
  };
}

async function cwmsJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`cwms ${r.status}`);
  return r.json();
}

// One roster per district per isolate. Savannah's is four entries.
const _roster = new Map();
async function usaceRoster(office) {
  if (_roster.has(office)) return _roster.get(office);
  const url = `${CWMS}/levels?office=${encodeURIComponent(office)}`
    + `&level-id-mask=${encodeURIComponent(`*.Elev.Inst.*.${TOP_OF_CONSERVATION}`)}&unit=EN&page-size=500`;
  const set = new Set();
  try {
    const j = await cwmsJson(url);
    for (const l of (j && j.levels) || []) {
      const p = usaceProjectOf(l['location-level-id']);
      if (p) set.add(p);
    }
  } catch (_) { /* an unreachable district is not a project that publishes nothing */ }
  _roster.set(office, set);
  return set;
}

/** The Corps' own answer for one water, or null. `candidates` is the binding's usace[]. */
async function usaceLevels(candidates, nowMs) {
  const list = (candidates || []).filter((c) => c && c.office && c.cwms_name);
  if (!list.length) return null;
  for (const office of [...new Set(list.map((c) => c.office))]) {
    const roster = await usaceRoster(office);
    if (!roster.size) continue;
    const project = usacePickProject(list.filter((c) => c.office === office), roster);
    if (!project) continue;
    const url = `${CWMS}/levels?office=${encodeURIComponent(office)}`
      + `&level-id-mask=${encodeURIComponent(`${project}.Elev.*`)}&unit=EN&page-size=100`;
    try {
      const j = await cwmsJson(url);
      const shaped = usaceShape((j && j.levels) || [], project, nowMs);
      if (shaped) return shaped;
    } catch (_) { /* try the next district */ }
  }
  return null;
}

/* ══ UTILITY OPERATORS THAT PUBLISH HTML ══════════════════════════════════════════════════════
 *
 * Duke and TVA return JSON, USACE has a REST API. Cube Carolinas, Southern Company and
 * Brookfield render their levels server-side, so the numbers come out of the markup --
 * Worker/operators.js does that parsing against page source Ryan saved on 2026-08-16.
 *
 * WHICH LAKE IS WHICH IS NOT DECIDED HERE. A feed publishes a NAME, and several registry rows
 * can carry it: Cube's "Falls" matches three, none of them Cube's. That join needs every row's
 * centroid and every row's existing dam bindings, which the Worker does not have, so
 * scripts/bind_operator_lakes.py does it offline by geometry and writes the answer into
 * water_bindings.json as `operator: {operator, feed_name, url, why}`. Same division of labour
 * as build_water_bindings.py. This function just reads its own binding.
 *
 * ONE FETCH PER OPERATOR PER ISOLATE. Cube publishes four lakes on one page and Southern
 * Company twenty on another, so a per-lake fetch would pull the same table over and over.
 */
const OPERATOR_PAGES = {
  cube: { url: 'https://ww4.cubecarolinas.com/lake/levels?orgID=3', label: 'Cube Carolinas' },
  southernco: { url: 'https://lakes.southernco.com/default.aspx', label: 'Southern Company / Georgia Power' },
};
const _opCache = new Map();

async function operatorPage(key) {
  const cfg = OPERATOR_PAGES[key];
  if (!cfg) return null;
  const hit = _opCache.get(key);
  if (hit && Date.now() - hit.t < 15 * 60 * 1000) return hit.v;
  let parsed = null;
  try {
    const r = await fetch(cfg.url, { headers: { 'User-Agent': 'TrollMap/1.0 (personal fishing app)' } });
    if (r.ok) {
      const html = await r.text();
      parsed = key === 'cube' ? parseCubeLevels(html) : parseSouthernCoLevels(html);
    }
  } catch (_) { parsed = null; }
  _opCache.set(key, { t: Date.now(), v: parsed });
  return parsed;
}

/**
 * A parsed safewaters.com facility page as a conditions reading, or null.
 *
 * AN ABSOLUTE ELEVATION IS NOT THE ONLY ANSWER, and on this operator it is the rarer one.
 * Santeetlah and Cheoah publish both conventions. Chilhowee and Calderwood publish ONLY
 * feet-below-full-pool -- Chilhowee read `-1.05 ft` on 2026-08-16 with no elevation anywhere on
 * the page. The gate here was `f.elevationFt != null`, which returned null for both of those
 * lakes and threw away the number a kayak angler actually wants, which is how far down the
 * lake is. Same shape as the empty-array and empty-set bugs found the same day: a field that is
 * ABSENT read as a reading that FAILED.
 *
 * `observed_at` follows whichever reading is present and is not defaulted to the drawdown
 * timestamp when an elevation exists -- on a page carrying both they are separate observations
 * minutes apart, and stamping one with the other's time would be inventing an observation.
 *
 * Pure, so it can be tested without the network. Same reason `usaceShape` is out here.
 */
export function brookfieldShape(f, op) {
  if (!f) return null;
  const discharges = f.discharges || [];
  if (f.elevationFt == null && f.belowFullPondFt == null && !discharges.length) return null;
  return {
    source: 'Brookfield / safewaters.com',
    url: (op && op.url) || null,
    feed_name: (op && op.feed_name) || f.facility || null,
    elevation_ft: f.elevationFt,
    below_full_pond_ft: f.belowFullPondFt,
    full_pond_ft: f.fullPondFt,
    observed_at: f.elevationAt || f.drawdownAt || null,
    discharges,
    note: f.note,
    bound_by: (op && op.why) || null,
  };
}

/** The operator's reading for this water, or null. `b.operator` is written by the pipeline. */
async function operatorLevel(b) {
  const op = b && b.operator;
  if (!op || !op.operator || !op.feed_name) return null;

  if (op.operator === 'brookfield') {
    try {
      const r = await fetch(op.url, { headers: { 'User-Agent': 'TrollMap/1.0 (personal fishing app)' } });
      if (!r.ok) return null;
      return brookfieldShape(parseBrookfieldFacility(await r.text()), op);
    } catch (_) { return null; }
  }

  const page = await operatorPage(op.operator);
  if (!page || !Array.isArray(page.lakes)) return null;
  const row = page.lakes.find((l) => l.name === op.feed_name);
  if (!row) return null;
  const cfg = OPERATOR_PAGES[op.operator];

  if (op.operator === 'cube') {
    return {
      source: cfg.label, url: cfg.url, feed_name: row.name,
      elevation_ft: row.elevationFt,
      below_full_pond_ft: row.belowFullPondFt,
      full_pond_ft: row.fullPondFt,
      forecast: row.forecast,
      observed_at: page.observedAt,
      bound_by: op.why,
    };
  }
  return {
    source: cfg.label, url: cfg.url, feed_name: row.name,
    elevation_ft: row.currentFt,
    full_pond_ft: row.fullFt,
    below_full_pond_ft: (row.fullFt != null && row.currentFt != null)
      ? Math.round((row.fullFt - row.currentFt) * 100) / 100 : null,
    rain_in: row.rainIn,
    generating: row.generating,
    // A lake the operator lists but is not reading today is a different answer from a lake it
    // does not publish, and the caller can tell them apart.
    reporting: row.reporting,
    observed_at: page.readingsFor,
    last_updated: page.lastUpdated,
    bound_by: op.why,
  };
}

/**
 * WHEN THE WATER MOVES, from whichever operator says so — one shape, not three.
 *
 * Three sources answer this question and they answer different halves of it:
 *
 *   Duke     /rivers/flow-arrivals/{basin} — a PROJECTION. When the surge from a generation
 *            run reaches a named mile marker downstream. This is the only true forecast here.
 *   TVA      generation-releases — how many generators are running now and in the published
 *            schedule. Already fetched for `out.tva`; reused rather than re-requested.
 *   Brookfield  the facility page's own discharge readings — OBSERVED, this minute, not a
 *            projection. Labelled `observed` so nothing downstream reads it as a forecast.
 *
 * `kind` is the field that keeps them apart. A number that says what the river WILL do and a
 * number that says what it IS doing are not interchangeable, and collapsing them is how a
 * person launches into a surge that already passed.
 */
export function releaseShape({ duke, tva, operator } = {}) {
  if (duke && Array.isArray(duke.arrivals) && duke.arrivals.length) {
    return {
      kind: 'projected',
      operator: 'Duke Energy',
      basin: duke.basinName || null,
      last_updated: duke.lastUpdated || null,
      next: duke.arrivals[0] || null,
      items: duke.arrivals.slice(0, 6),
      source: duke.source || null,
    };
  }
  if (tva && (Array.isArray(tva.generation) ? tva.generation.length : false)) {
    return {
      kind: 'scheduled',
      operator: 'TVA',
      basin: null,
      last_updated: tva.observed_at || null,
      next: tva.generation[0] || null,
      items: tva.generation.slice(0, 6),
      source: tva.source || null,
    };
  }
  if (operator && Array.isArray(operator.discharges) && operator.discharges.length) {
    return {
      // NOT a forecast. safewaters publishes what is going through the turbines right now.
      kind: 'observed',
      operator: operator.source || null,
      basin: null,
      last_updated: operator.observed_at || null,
      next: null,
      items: operator.discharges,
      source: operator.url || null,
    };
  }
  return null;
}

/**
 * The Duke basin for a water, or null.
 *
 * RIVERS is a hand-written table of six and only two entries carry a `dukeBasinId`. That is not
 * a gate to delete like the LAKES one was: the surge model needs river-mile geometry that
 * exists nowhere else, so a river Duke publishes arrivals for is genuinely unknown to us until
 * someone measures its centerline. Stated so the next reader does not mistake it for an
 * oversight.
 */
/**
 * DOES THE BASIN DUKE RETURNED ACTUALLY NAME THIS RIVER?
 *
 * Ryan, 2026-08-16: *"broad river has nothing to do with duke so that dukeBasinId doesn't make
 * sense but ok"* — and the entry agrees with him against itself. `RIVERS.broad` reads
 * `operator: "SCE&G / Dominion (Parr Shoals)"`, `damName: "Parr Shoals Dam"`, and then carries
 * `dukeBasinId: 10` with a comment asserting it is Duke's Broad River basin. Nobody checked.
 * The id was typed, not measured.
 *
 * It cannot be derived — a foreign key never can. But it CAN BE VERIFIED, and that is the same
 * move `agencyPageAgrees` made this morning after TWRA region 1's "Davy Crockett Lake" bound to
 * a Davy Crockett Lake 300 km away: do not trust the id, check that what came back names the
 * thing you asked about.
 *
 * `/rivers/flow-arrivals/{id}` returns `RiverBasinName` and every arrival carries `DamName` and
 * `MileMarkerName`. If none of them shares a distinctive token with the river, the id is wrong
 * or the basin was renumbered, and a release projection on the wrong river is worse than none.
 *
 * FLOWING WORDS ARE NOT DISTINCTIVE. "river" is in every one of these names on both sides, so it
 * is dropped before comparing — otherwise every basin agrees with every river.
 */
export function dukeBasinAgrees(sched, waterName) {
  const distinctive = (s) => {
    const out = new Set();
    for (const t of reportTokens(s)) {
      if (!/^(river|creek|canal|branch|run|fork|basin|dam|hydro|project)$/.test(t)) out.add(t);
    }
    return out;
  };
  const want = distinctive(waterName);
  if (!want.size || !sched) return false;
  const haystacks = [sched.basinName];
  for (const a of sched.arrivals || []) haystacks.push(a.damName, a.mileMarkerName);
  for (const h of haystacks) {
    for (const t of distinctive(h)) if (want.has(t)) return true;
  }
  return false;
}

export function dukeBasinFor(name) {
  const key = lakeKeyFromName(String(name || ''));
  const row = key && RIVERS[key];
  return row && row.dukeBasinId ? row.dukeBasinId : null;
}

/**
 * WATER TEMPERATURE IS ITS OWN LOOKUP, not a byproduct of whichever gauge answered the level.
 *
 * Ryan, 2026-08-16: *"the only thing the topbar is missing for wateree now is the temperature...
 * if the noaa gauges do not have it you can pull it from the usgs one from the tailrace... i
 * think that is what we were doing before."* He is right on both counts.
 *
 * NWPS PUBLISHES NO TEMPERATURE AT ALL. `nwpsGauge` has no such field, and Wateree's pool is
 * NWPS lid WATS1, so the lake's own gauge can never answer this. The old code got it from
 * `UTILITY_FEEDS[lake].usgsId` — a seven-lake hand table whose whole purpose, per its own
 * comment, was "the river gauge BELOW the dam, used ONLY for water temperature fallback."
 *
 * So this does the same thing over the BINDING instead of over seven names: every USGS site the
 * water knows about, nearest first, until one reports 00010. Wateree Lake reaches
 * 02147801 "LAKE WATEREE TAILRACE ABOVE CAMDEN"; Wateree River reaches the same site, which is
 * why both were blank.
 *
 * `usgsSite()` cannot be reused for this: it THROWS when a site has neither a level nor a flow,
 * so a temperature-only site never contributes one.
 *
 * WHERE IT CAME FROM TRAVELS WITH IT. A tailrace reading is the river below the dam, not the
 * lake, and on a generating day they are not the same water. `below_dam` says so and the strip
 * marks it.
 */
export function usgsSitesFor(b, lat, lon) {
  const seen = new Set();
  const out = [];
  const add = (g, role) => {
    const site = g && g.usgs_site;
    if (!site || seen.has(site)) return;
    seen.add(site);
    out.push({
      site,
      name: g.name || null,
      role,
      km: (Number.isFinite(g.lat) && Number.isFinite(g.lon)) ? kmBetween(lat, lon, g.lat, g.lon) : Infinity,
      below_dam: role === 'tailwater' || /tailrace|tailwater|below\b/i.test(String(g.name || '')),
    });
  };
  add(b.pool, 'pool');
  add(b.tailwater, 'tailwater');
  for (const g of b.gauges || []) add(g, 'gauge');
  // Nearest first, but a site on the lake itself beats a nearer one below the dam.
  return out.sort((x, y) => (x.below_dam - y.below_dam) || (x.km - y.km));
}

/**
 * One pass over the water's USGS sites, three readings out of it.
 *
 * Each reading records ITS OWN site, because they do not have to come from the same one: a lake
 * can carry temperature from a mid-lake sonde and dissolved oxygen from the tailrace, and
 * stamping both with one site would be inventing provenance.
 */
async function waterProbe(b, lat, lon, seededTemp) {
  const out = { temp: seededTemp && Number.isFinite(seededTemp.c) ? seededTemp : null,
                oxygen: null, turbidity: null, salt: null, tidalFlow: null };
  for (const s of usgsSitesFor(b, lat, lon).slice(0, 4)) {
    if (out.temp && out.oxygen && out.turbidity && out.salt && out.tidalFlow) break;
    let u = null;
    try { u = await cached(`usgs:${s.site}`, TTL.gauge, () => fetchUsgs(s.site, USGS_PARMS)); }
    catch (_) { continue; }
    if (!u) continue;
    const where = {
      usgs_site: s.site, name: s.name, role: s.role, below_dam: s.below_dam,
      km_from_point: Number.isFinite(s.km) ? round1(s.km) : null,
    };
    if (!out.temp && Number.isFinite(u.tempC)) {
      out.temp = { ...where, c: round2(u.tempC), f: round1(u.tempC * 9 / 5 + 32),
                   source: 'USGS — parameter 00010' };
    }
    if (!out.oxygen && Number.isFinite(u.doMgL)) {
      out.oxygen = { ...where, mg_l: round2(u.doMgL), source: 'USGS — parameter 00300' };
    }
    if (!out.turbidity && Number.isFinite(u.turbidityFnu)) {
      out.turbidity = { ...where, fnu: round2(u.turbidityFnu), source: 'USGS — parameter 63680' };
    }
    // SALINITY IF PUBLISHED, CONDUCTANCE OTHERWISE, AND THEY ARE NOT THE SAME NUMBER.
    // Salinity is derivable from conductance through the Practical Salinity Scale, and that
    // conversion is deliberately not done here: a converted value would look like a measurement
    // and would not be one. `basis` says which of the two answered.
    if (!out.salt && Number.isFinite(u.salinityPpt)) {
      out.salt = { ...where, basis: 'salinity', ppt: round2(u.salinityPpt),
                   source: 'USGS — parameter 00480' };
    } else if (!out.salt && Number.isFinite(u.spCond)) {
      out.salt = { ...where, basis: 'specific_conductance', us_cm: Math.round(u.spCond),
                   source: 'USGS — parameter 00095' };
    }
    if (!out.tidalFlow && Number.isFinite(u.tidalFlow)) {
      out.tidalFlow = { ...where, cfs: round1(u.tidalFlow), source: 'USGS — parameter 72137' };
    }
  }
  return out;
}

/**
 * WHICH WAY THE WATER HAS BEEN GOING, from `/gauges/{lid}/stageflow`.
 *
 * A level is a point and a trip is a decision. Two feet below full pool and steady is a
 * different lake from two feet below and falling half a foot a week, and until now the app had
 * no way to tell them apart. `plan-builder.js` has carried a `riverRise` field with nothing
 * feeding it.
 *
 * Verified against CMDS1, CFMS1 and WATS1 on 2026-08-16. The payload carries roughly a month of
 * observations plus its OWN unit labels — `primaryName`/`primaryUnits` and the secondary pair —
 * so nothing here has to assume feet or kcfs.
 *
 * -999 IS A SENTINEL, NOT A READING. Both river gauges returned `secondary: -999` on every
 * point. It is the same shape as USGS's -999999, which `fetchUsgs` has filtered since it was
 * audited, and reporting it would put a flow of minus nine hundred and ninety-nine on a river.
 * Anything at or below -998 is dropped.
 *
 * NO FORECAST HERE. Only `observed` came back on all three gauges. The single forecast value on
 * the base `/gauges/{lid}` response is still the only forecast this app has.
 */
export function stageflowTrend(j, nowMs) {
  const src = (j && (j.observed || j)) || null;
  const rows = (src && Array.isArray(src.data)) ? src.data : [];
  const pts = [];
  for (const r of rows) {
    const t = Date.parse(r && r.validTime);
    const v = Number(r && r.primary);
    if (!Number.isFinite(t) || !Number.isFinite(v) || v <= -998) continue;
    pts.push({ t, v });
  }
  if (pts.length < 2) return null;
  pts.sort((a, b) => a.t - b.t);
  const last = pts[pts.length - 1];

  // The reading nearest to N hours before the latest one, and only if the series actually
  // reaches back that far. Extrapolating a 24 h change out of 6 h of data is inventing a trend.
  const back = (hours) => {
    const want = last.t - hours * 3600 * 1000;
    if (pts[0].t > want) return null;
    let best = null;
    for (const p of pts) {
      if (best === null || Math.abs(p.t - want) < Math.abs(best.t - want)) best = p;
    }
    return best;
  };
  const delta = (hours) => {
    const p = back(hours);
    return p ? round2(last.v - p.v) : null;
  };
  return {
    latest: round2(last.v),
    at: new Date(last.t).toISOString(),
    units: src.primaryUnits || null,
    measures: src.primaryName || null,
    change_24h: delta(24),
    change_7d: delta(24 * 7),
    points: pts.length,
    covers_hours: Math.round((last.t - pts[0].t) / 3600000),
    source: 'NOAA NWPS — /nwps/v1/gauges/{lid}/stageflow',
  };
}

async function gaugeTrend(lid) {
  if (!lid) return null;
  const j = await cached(`sf:${lid}`, TTL.gauge,
    () => getJson(`https://api.water.noaa.gov/nwps/v1/gauges/${encodeURIComponent(lid)}/stageflow`));
  return stageflowTrend(j, Date.now());
}

async function waterBlock(b, lat, lon) {
  const picks = [];
  if (gaugeId(b.pool)) picks.push(['pool', b.pool]);
  if (gaugeId(b.tailwater)) picks.push(['tailwater', b.tailwater]);
  const near = nearest(b.gauges, lat, lon);
  if (gaugeId(near) && !picks.some(([, g]) => gaugeId(g) === gaugeId(near))) {
    picks.push(['gauge', near]);
  }

  const settled = await Promise.allSettled(
    picks.map(([role, g]) => readGauge(g, role, lat, lon)));

  const out = {
    slug: b.slug, display_name: b.display_name, state: b.state, feature_type: b.feature_type,
    pool: null, tailwater: null, gauge: null, failed: [],
  };
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') out[picks[i][0]] = r.value;
    else out.failed.push({ lid: picks[i][1].lid || null,
                           usgs_site: picks[i][1].usgs_site || null, role: picks[i][0],
                           error: String((r.reason && r.reason.message) || r.reason) });
  });

  const used = new Set(picks.map(([, g]) => gaugeId(g)));
  out.other_gauges = (b.gauges || [])
    .filter((g) => g && gaugeId(g) && !used.has(gaugeId(g)) && Number.isFinite(g.lat))
    .map((g) => ({ lid: g.lid || null, usgs_site: g.usgs_site || null, name: g.name,
                   lat: g.lat, lon: g.lon,
                   km_from_point: round1(kmBetween(lat, lon, g.lat, g.lon)) }))
    .sort((x, y) => x.km_from_point - y.km_from_point);

  // Declared, not fetched. The NWM reach and the CWMS locations already have callers elsewhere
  // (worker-data.js fetchCwmsLakeLevel, and /rivers above); repeating those fetches here would
  // be two code paths that can disagree about the same number.
  out.reach = b.reach || null;
  out.usace = b.usace || null;
  out.curated = b.curated || null;

  // TVA, when the binding says the water sits behind one of its dams. Fetched here rather than
  // inside nwpsGauge because it is not a gauge reading -- it is the operator's own account of
  // the reservoir, and it answers a question NWPS cannot: how far off the seasonal guide curve
  // the lake is, and whether they are generating. One call set per water, not per gauge.
  const tvaLid = [b.pool, b.tailwater, ...(b.gauges || [])]
    .find((g) => g && g.tva && g.lid);
  if (tvaLid) {
    const d = new Date();
    const todayMmDd = `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
    out.tva = await tvaReservoir(tvaLid.lid, todayMmDd).catch(() => null);
  } else {
    out.tva = null;
  }

  // The Corps publishes a target, not a reading: what this lake is SUPPOSED to be at today.
  // Null here means the district publishes no conservation pool for it, which is a different
  // answer from "we did not look" -- `usace_candidates` says whether there was anything to try.
  out.usace = await usaceLevels(b.usace, Date.now()).catch(() => null);
  out.usace_candidates = (b.usace || []).length;

  // Cube, Southern Company and Brookfield. Null when the pipeline bound no operator to this
  // water -- which for Cube's "Falls" is the correct answer, not a gap.
  out.operator = await operatorLevel(b).catch(() => null);

  // Release schedules. The Duke call only happens for a water that has a basin, so the common
  // case costs nothing.
  const basin = dukeBasinFor(b.display_name || b.slug);
  const dukeSched = basin ? await fetchDukeFlowArrivals(basin).catch(() => null) : null;

  // A hand-typed basin id has to prove itself before it is allowed to describe this river.
  // Refused rather than dropped: a projection that was rejected and one that was never
  // available are different facts, and only the first one names a table that needs fixing.
  out.releases_refused = null;
  let duke = dukeSched;
  if (dukeSched && !dukeBasinAgrees(dukeSched, b.display_name || b.slug)) {
    duke = null;
    out.releases_refused = {
      operator: 'Duke Energy',
      basin_id: basin,
      basin_name: dukeSched.basinName || null,
      why: `RIVERS.dukeBasinId ${basin} returned "${dukeSched.basinName || 'an unnamed basin'}", `
         + `which does not name ${b.display_name || b.slug}. The id is hand-typed and unverified.`,
    };
  }
  out.releases = releaseShape({ duke, tva: out.tva, operator: out.operator });

  // One resolved temperature rather than three places a caller has to look. Seeded with whatever
  // a gauge read already produced, so the common case costs no extra request.
  const seeded = ['pool', 'tailwater', 'gauge']
    .map((role) => (out[role] && Number.isFinite(out[role].water_temp_c))
      ? { c: out[role].water_temp_c, f: round1(out[role].water_temp_c * 9 / 5 + 32),
          usgs_site: out[role].usgs_site || null, name: out[role].name || null, role,
          below_dam: role === 'tailwater', km_from_point: null, source: 'USGS — parameter 00010' }
      : null)
    .find(Boolean) || null;
  // ONE gauge, not three. The series is a month long and this Worker has a 10 ms CPU ceiling on
  // the free plan; parsing three of them per request is how the research routes started dying.
  // The pool is the water you launch onto, so it is the one that gets the trend.
  const trendLid = (b.pool && b.pool.lid)
                || (picks.find(([role]) => role === 'gauge') || [])[1]?.lid
                || (b.tailwater && b.tailwater.lid) || null;
  out.trend = await gaugeTrend(trendLid).catch(() => null);

  const probe = await waterProbe(b, lat, lon, seeded).catch(() => ({ temp: seeded }));
  out.water_temp = probe.temp || null;
  // A MEASURED clarity number, where one exists. `clarity` on this response is a rainfall model
  // over a historical Secchi baseline; this is an instrument reading from today, and the two
  // must not be presented as the same kind of thing.
  out.turbidity = probe.turbidity || null;
  out.dissolved_oxygen = probe.oxygen || null;
  out.salt = probe.salt || null;
  out.tidal_flow = probe.tidalFlow || null;
  // Whether `tide: null` on this response is a FACT or a GAP. An inland lake has no tide and
  // that is the right answer; a coastal zone with no station bound is a hole in the registry.
  out.tidal = !!(b.tides || []).length;
  out.source = 'NWPS — api.water.noaa.gov/nwps/v1/gauges/{lid}';
  out.chart_datum = await chartDatum(b, out.operator);
  return out;
}

/**
 * HOW FAR THE WATER IS BELOW THE LEVEL THE CHART WAS DRAWN AT.
 *
 * Garmin states it plainly: LakeVü and Navionics reference soundings and contours to the lake's
 * FULL POOL elevation, and seasonal change, drought and managed drawdowns are not factored in.
 * So every depth in every chartpack is a full-pool depth, and on a drawn-down lake every one of
 * them reads deeper than the water actually is. That is not a chart error; it is a datum, and a
 * datum only becomes a correction once you know today's level against it.
 *
 * REPORTED, NEVER APPLIED. Nothing subtracts this from a depth, here or downstream. Reporting a
 * measurement and acting on it are different commitments, and only the first one is earned yet.
 *
 * THE NUMBER, AND HOW LONG IT TOOK TO STOP GETTING IT WRONG.
 *
 * Duke's `Actual` for Wateree is "98.00" and `Elevation` is "225.5 ft (AMSL, NGVD 29 datum".
 * `Actual` is feet inside a 100 ft band hung under full pond -- see normalizeDukeRow() in
 * worker-data.js for why `Min` and Norman settle that -- so the drawdown is 100 minus it: 2.00 ft,
 * and the level is 223.50 ft AMSL.
 *
 * Three independent things agree with 2.00 and nothing disagrees. NWPS WATS1 read 97.86 on its
 * own datum. Third-party trackers publish 2.13 ft below full pool. And Ryan, from the water:
 * "im about 95% sure the depths are about 2ft lower than the what the map says everywhere i go".
 *
 * What disagreed was a number this codebase computed about itself. The old normalizeDukeRow
 * treated the index as a fraction of the elevation above sea level and returned 220.99 ft, which
 * implies 4.51 ft of drawdown. That value was then read back OUT of the Worker during this
 * session and cited as evidence of what Duke serves. It never was. It was an assumption written
 * into a parser months earlier, laundered through code, and returned looking like a source.
 *
 * Ryan, 2026-08-10, on being shown that number: "what are the chances that our worker was
 * programmed by claude with the information that claude just cited as fact". Near certainty. The
 * rule this leaves behind is worth more than the fix: A DERIVED VALUE IN THIS CODEBASE IS NOT
 * EVIDENCE ABOUT THE WORLD. The raw upstream response is. When those two disagree, fetch the raw
 * row -- do not reason about which of your own outputs is more plausible.
 *
 * COVERAGE IS WHATEVER THE FEED RETURNS, which is not a number to be hardcoded here. Duke's
 * /lakes/current-level takes no basin argument -- fetchDukeApi() requests the bare URL and gets
 * every Duke reservoir it publishes across SC and NC in one response, which dukeRowForNames()
 * then matches by whole tokens. An earlier draft of this comment said "the eleven Catawba-Wateree
 * reservoirs",
 * counted off a screenshot of one basin. That is the same mistake as the one this block exists to
 * document, at a smaller scale: stating as fact something never actually checked.
 *
 * A water the feed does not name returns a null offset saying so, the same way an unbound water
 * returns `pending`. A gap that is visible is a gap that can be closed.
 *
 * (Vestigial, noted not fixed: fetchDamLevels() in js/modules/duke-energy.js loops basins 1, 2
 * and 3 and the /duke route forwards a `basin` parameter, but fetchDukeApi ignores it and every
 * one of those calls returns the identical full list. Three requests for one answer.)
 */
export function chartDatumShape(b, sources = {}) {
  const out = {
    // True of every Garmin-derived pack in R2, not just the ones with a level feed.
    charted_at: 'full_pool',
    charted_at_source: 'Garmin — soundings and contours are referenced to full pool; drawdown is '
                     + 'not applied to the base map',
    applied: false,
    below_full_pool_ft: null,
    full_pool_ft: null,
    level_ft: null,
    source: null,
    pending: null,
  };
  if (b.feature_type && b.feature_type !== 'lake') {
    out.pending = 'not a lake — a river or coastal zone has no full pool to be below';
    return out;
  }
  if (!String(b.display_name || '').trim()) {
    out.pending = 'no display name to match against the level feed';
    return out;
  }

  // THE OPERATOR FIRST, because it is the dam's own account of its own reservoir and it
  // publishes the drawdown directly rather than leaving it to be derived. Nineteen waters carry
  // one as of 2026-08-16; Duke publishes thirty-four; the two sets barely overlap.
  //
  // ASSUMPTION, STATED: an operator's "full pond" is taken to be the full pool Garmin charted
  // to. That holds for a normal-operation reservoir and is what the Duke path has always
  // assumed. It is not a datum conversion and no vertical datum is reconciled here — which is
  // exactly why this is REPORTED and never APPLIED.
  const op = sources.operator;
  if (op && Number.isFinite(op.below_full_pond_ft)) {
    out.below_full_pool_ft = round2(op.below_full_pond_ft);
    out.full_pool_ft = Number.isFinite(op.full_pond_ft) ? op.full_pond_ft : null;
    out.level_ft = Number.isFinite(op.elevation_ft) ? op.elevation_ft : null;
    out.source = `${op.source} — ${op.feed_name}`;
    return out;
  }

  const d = sources.duke;
  if (d && Number.isFinite(d.belowFullPoolFt) && Number.isFinite(d.fullPool)) {
    out.level_ft = d.ft;
    out.full_pool_ft = d.fullPool;
    out.below_full_pool_ft = round2(d.belowFullPoolFt);
    out.source = 'Duke Energy — api.hydro-derived.duke-energy.app/lakes/current-level; `Actual` '
               + 'is feet inside a 100 ft band under full pond, so the drawdown is 100 minus it';
    if (d.duke_feed_name) out.feed_name = d.duke_feed_name;
    return out;
  }

  // NOT LISTED HERE ON PURPOSE: the Corps. `usace.conservation_pool_ft` is a TARGET, not a
  // reading, and turning it into a drawdown needs today's elevation from a gauge whose vertical
  // datum is not guaranteed to be the Corps'. Subtracting across two datums produces a number
  // that looks like feet and is not. It stays out until the datums are reconciled.
  out.pending = 'no full-pool level feed names this water — the operator feeds (Cube, Southern '
              + 'Company, Brookfield) and Duke\'s /lakes/current-level are what is wired, and '
              + 'between them they do not publish this reservoir';
  return out;
}

async function chartDatum(b, operator) {
  if ((b.feature_type && b.feature_type !== 'lake') || !String(b.display_name || '').trim()) {
    return chartDatumShape(b, {});
  }
  if (operator && Number.isFinite(operator.below_full_pond_ft)) {
    return chartDatumShape(b, { operator });
  }
  // THE COUNTY PARENTHETICAL BROKE THIS, and it broke it for every lake at once. The name was
  // built with `display_name.replace(/,.*$/, '')`, written when a display name looked like
  // "Wateree Lake, SC". It now looks like "Wateree Lake (Kershaw Co, SC)", so that strip
  // returned "Wateree Lake (Kershaw Co" and `getDukeLake`'s `.includes()` matched nothing --
  // measured live on 2026-08-16: every lake, including all nine Duke waters that used to work,
  // answered `chart_datum.pending`.
  //
  // The fix is not a better strip. It is to stop hand-cutting names: `dukeRowForNames` tokenises
  // through `reportTokens`, which drops the parenthetical and the state suffix already, and
  // matches whole tokens in both directions with the flowing-water guard. It also searches the
  // WHOLE feed rather than the nine names in the LAKES table.
  let d = null;
  try {
    d = await cached(`duke:${b.slug}`, 900, () => dukeRowForNames([b.display_name]));
  } catch (e) {
    const out = chartDatumShape(b, {});
    out.pending = `level feed failed: ${String((e && e.message) || e)}`;
    return out;
  }
  return chartDatumShape(b, { duke: d });
}

// ── tide and currents ───────────────────────────────────────────────────────────────────────

const COOPS = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';

function dayAfter(d) {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/**
 * Highs, lows, and — where a station exists — slack and max current.
 *
 * The window is the trip date PLUS the following day, deliberately. A trip that ends at dusk
 * still runs on the evening cycle, and the last low of a day frequently falls after midnight;
 * asking for one calendar day drops the tide that ends the trip.
 *
 * Times come back on the station's own local clock (`lst_ldt`) because that is the clock a
 * launch time is written in. Converting them to UTC here would mean converting them back in
 * every renderer.
 */
/**
 * BAROMETRIC PRESSURE AND ITS TREND, from the tide station we are already bound to.
 *
 * A falling barometer is one of the few weather facts anglers act on directly, and it is the
 * TREND that matters — 1018 mb tells you nothing, 1018 and down 4 in six hours tells you a lot.
 * `datagetter` takes `range=<hours>`, so one request returns the trend rather than a point:
 * verified at Wilmington 8658120 on 2026-08-16, `range=24` returned 240 entries six minutes
 * apart.
 *
 * WHY THIS NEEDS A STALENESS GUARD, with the case that proves it. Charleston 8665530 answered
 * `date=latest` with `2026-08-05 14:36` — an ELEVEN DAY OLD reading, returned with no error and
 * no flag. `date=latest` means the latest that exists, not the latest that is current. A
 * barometer reading from last week presented as now is worse than no barometer.
 *
 * Pressure is in millibars because the query says `units=english`; CO-OPS reports air pressure
 * in mb regardless, so it is labelled rather than converted.
 */
export function pressureTrend(j, nowMs, maxAgeMin = 180) {
  const rows = (j && Array.isArray(j.data)) ? j.data : [];
  const pts = [];
  for (const r of rows) {
    // "2026-08-16 17:30" is station local time with no offset. Parsed as UTC deliberately: the
    // AGE is a difference between two of these, and the trend is a difference between two of
    // these, so a constant offset cancels out of both. Never use one of these as a wall clock.
    const t = Date.parse(String(r && r.t).replace(' ', 'T') + 'Z');
    const v = Number(r && r.v);
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    pts.push({ t, v });
  }
  if (!pts.length) return null;
  pts.sort((a, b) => a.t - b.t);
  const last = pts[pts.length - 1];

  const ageMin = Number.isFinite(nowMs) ? Math.round((nowMs - last.t) / 60000) : null;
  const stale = ageMin != null && ageMin > maxAgeMin;

  const back = (hours) => {
    const want = last.t - hours * 3600 * 1000;
    if (pts[0].t > want) return null;
    let best = null;
    for (const p of pts) if (best === null || Math.abs(p.t - want) < Math.abs(best.t - want)) best = p;
    return best;
  };
  const delta = (h) => { const p = back(h); return p ? Math.round((last.v - p.v) * 10) / 10 : null; };
  return {
    mb: Math.round(last.v * 10) / 10,
    at: String(last.t && rows.length ? rows[rows.length - 1].t : '') || null,
    age_minutes: ageMin,
    // Reported rather than hidden. A caller that wants to ignore a stale reading can; a caller
    // that is never told cannot.
    stale,
    change_3h: delta(3),
    change_6h: delta(6),
    change_24h: delta(24),
    units: 'mb',
    station_id: (j && j.metadata && j.metadata.id) || null,
    source: 'NOAA CO-OPS — air_pressure',
  };
}

async function tideBlock(b, lat, lon, date) {
  const all = b.tides || [];
  const levels = all.filter((t) => t && (t.kind === 'tidepredictions' || t.kind === 'waterlevels'));
  const st = nearest(levels, lat, lon);
  if (!st || !st.id) return null;
  const cur = nearest(all.filter((t) => t && t.kind === 'currentpredictions'), lat, lon);

  const b1 = date.replace(/-/g, '');
  const b2 = dayAfter(date).replace(/-/g, '');
  const q = (extra) => `${COOPS}?application=TrollMap&time_zone=lst_ldt&units=english`
                     + `&format=json&${extra}`;
  const soft = (p) => p.catch((e) => ({ __err: String((e && e.message) || e) }));

  const [p, c, w, t, ap] = await Promise.all([
    soft(cached(`tide:${st.id}:${date}`, TTL.tide, () => getJson(q(
      `product=predictions&interval=hilo&datum=MLLW&station=${st.id}`
      + `&begin_date=${b1}&end_date=${b2}`)))),
    cur && cur.id
      ? soft(cached(`cur:${cur.id}:${date}`, TTL.tide, () => getJson(q(
          `product=currents_predictions&interval=MAX_SLACK&station=${cur.id}`
          + `&begin_date=${b1}&end_date=${b2}`))))
      : Promise.resolve(null),
    // Only for the 10 stations the registry marks `measured`. A predicted tide is astronomy; a
    // measured one carries the surge, and on a blow that is the difference that matters.
    st.measured
      ? soft(cached(`wl:${st.id}`, TTL.level, () => getJson(q(
          `product=water_level&datum=MLLW&station=${st.id}&date=latest`))))
      : Promise.resolve(null),
    // WATER TEMPERATURE AT THE TIDE STATION. On a coastal zone there is frequently no USGS site
    // at all, so 00010 cannot answer and the app has shown no water temperature on the coast
    // since it had a coast. The tide station is already bound, already nearest-matched, and
    // publishes this as its own product.
    //
    // Asked unconditionally rather than behind a flag, because the registry records which
    // stations are `measured` for WATER LEVEL and says nothing about temperature — gating on the
    // wrong flag would hide it at stations that do publish it. A station that does not answers
    // with CO-OPS's 200-plus-error body, which errOf() already reads.
    soft(cached(`wt:${st.id}`, TTL.gauge, () => getJson(q(
      `product=water_temperature&station=${st.id}&date=latest`)))),
    // 24 hours of barometric pressure in one request. `range` rather than `date=latest` because
    // the trend is the fishing fact and a single reading is not.
    soft(cached(`ap:${st.id}`, TTL.gauge, () => getJson(q(
      `product=air_pressure&station=${st.id}&range=24`)))),
  ]);

  // CO-OPS answers a bad request with HTTP 200 and {"error":{"message":...}}, so a thrown error
  // is not the only failure mode to check for.
  const errOf = (x) => (x && (x.__err || (x.error && (x.error.message || x.error)))) || null;
  const preds = (p && p.predictions) || [];
  const wl = (w && w.data && w.data.length) ? w.data[w.data.length - 1] : null;
  // units=english on the query, so `v` is already Fahrenheit.
  const wtRow = (t && t.data && t.data.length) ? t.data[t.data.length - 1] : null;

  return {
    station: { id: st.id, name: st.name || null, lat: st.lat, lon: st.lon,
               km_from_point: st.km, measured: !!st.measured },
    datum: 'MLLW',
    time_zone: 'station local (lst_ldt)',
    covers: [date, dayAfter(date)],
    highs_lows: preds.map((x) => ({ time: x.t, ft: num(x.v), type: x.type })),
    predictions_error: errOf(p),
    measured_level: wl ? { ft: num(wl.v), at: wl.t } : null,
    measured_level_error: errOf(w),
    currents: (c && c.current_predictions) ? {
      station: { id: cur.id, name: cur.name || null, km_from_point: cur.km },
      units: c.current_predictions.units || null,
      events: (c.current_predictions.cp || []).map((x) => ({
        time: x.Time, type: x.Type,
        speed_kn: num(x.Velocity_Major),
        mean_flood_dir: x.meanFloodDir ?? null,
        mean_ebb_dir: x.meanEbbDir ?? null,
      })),
    } : null,
    currents_error: errOf(c),
    water_temp: (wtRow && Number.isFinite(num(wtRow.v)))
      ? { f: num(wtRow.v), at: wtRow.t, station_id: st.id, name: st.name || null,
          source: 'NOAA CO-OPS — water_temperature' }
      : null,
    water_temp_error: errOf(t),
    pressure: errOf(ap) ? null : pressureTrend(ap, Date.now()),
    pressure_error: errOf(ap),
    other_stations: levels.length - 1,
    source: 'NOAA CO-OPS — api.tidesandcurrents.noaa.gov',
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

  // Started here, awaited by the two jobs below. Resolving to a shape rather than rejecting
  // keeps one failed R2 read from being three separate unhandled rejections.
  //
  // `?fresh=1` skips the hour-long isolate cache. The registry changes when the PIPELINE
  // uploads, not when the Worker deploys, so after a `upload_garmin_to_r2.py` run there is no
  // event that would otherwise clear it and a new binding stays invisible for up to an hour.
  const bindingsP = waterBindings(env, url.searchParams.get('fresh') === '1').then(
    (all) => ({ all }),
    (e) => ({ err: String((e && e.message) || e) }));

  // allSettled, never all: one dead upstream degrades a field, not the response.
  //
  // `water` and `tide` need the registry before they know what to ask for, so they chain off
  // bindingsP rather than starting cold — but they still land in the same settle and the same
  // `sources[]` as everything else, because a gauge that failed and a forecast that failed are
  // the same kind of event and should be reported the same way.
  const jobs = [
    ['almanac', skyAlmanac(lat, lon, date, tz)],
    ['forecast', pointForecast(lat, lon)],
    ['convective', convective(lat, lon)],
    ['hazards', hazards(lat, lon)],
    ['rivers', rivers(lat, lon, Number(url.searchParams.get('box')))],
    ['water', bindingsP.then(({ all, err }) => {
      if (err) throw new Error(err);
      const b = all[slug];
      return b ? waterBlock(b, lat, lon) : null;
    })],
    ['tide', bindingsP.then(({ all, err }) => {
      if (err) throw new Error(err);
      const b = all[slug];
      return (b && (b.tides || []).length) ? tideBlock(b, lat, lon, date) : null;
    })],
    // CLARITY MOVED HERE from its own /lake-clarity route, so a caller that wants the state of
    // the water makes ONE request instead of three. It is a model, not a reading: a measured
    // Secchi or turbidity baseline from the WQP where one exists, plus 72 h of rainfall through
    // per-zone sensitivities. `measured` inside the payload says which half answered, and the
    // client must not print it as an observation.
    //
    // It takes the DISPLAY NAME rather than the slug because getLakeClarity keys its profiles
    // through lakeKeyFromName. The registry name is the one the rest of this route uses too.
    ['clarity', bindingsP.then(({ all, err }) => {
      if (err) throw new Error(err);
      const b = all[slug];
      const nm = (b && b.display_name) || slug;
      return getLakeClarity(nm, date, env);
    })],
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

  // `pending` was once unconditional, which meant a water with a working gauge still announced
  // that gauges were not built yet. It now carries only what is genuinely absent, and the key
  // is omitted entirely when nothing is — a permanent "not built" on a field that works is the
  // same lie as a zero on a field that does not.
  //
  // Note what is NOT pending: an inland lake with `tide: null`. That is the right answer, and
  // `water.tidal` says whether the null is a fact or a gap.
  const bres = await bindingsP;
  if (bres.err) {
    out.pending = {
      water: `${BINDINGS_KEY} could not be read: ${bres.err}`,
      tide: `${BINDINGS_KEY} could not be read: ${bres.err}`,
    };
  } else if (!bres.all[slug]) {
    out.pending = {
      water: `no row for "${slug}" in ${BINDINGS_KEY} — `
           + `${Object.keys(bres.all).length} waters are bound; `
           + 'add one by rerunning build_water_bindings.py, not by editing the Worker',
    };
  }

  return new Response(JSON.stringify(out), {
    headers: { ...CORS, ...JSON_HEADERS, 'Cache-Control': 'public, max-age=300' },
  });
}

export const CONDITIONS_ROUTES = [
  '/conditions/<slug>?lat=&lon=&date=YYYY-MM-DD&tz=-4  — sun, moon, solunar, forecast, storm risk, warnings, live river flow, pool/tailwater level from NWPS, tide and currents from CO-OPS',
];
