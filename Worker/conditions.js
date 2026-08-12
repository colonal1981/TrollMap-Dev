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
import { getDukeLake, fetchUsgs } from './worker-data.js';

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
async function usgsSite(site, role, bound, lat, lon) {
  const u = await cached(`usgs:${site}`, TTL.gauge,
    () => fetchUsgs(site, '00062,62614,62615,00065,00060,00010'));
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
  // Whether `tide: null` on this response is a FACT or a GAP. An inland lake has no tide and
  // that is the right answer; a coastal zone with no station bound is a hole in the registry.
  out.tidal = !!(b.tides || []).length;
  out.source = 'NWPS — api.water.noaa.gov/nwps/v1/gauges/{lid}';
  out.chart_datum = await chartDatum(b);
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
 * every Duke reservoir it publishes across SC and NC in one response, which getDukeLake() then
 * matches by name. An earlier draft of this comment said "the eleven Catawba-Wateree reservoirs",
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
async function chartDatum(b) {
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
  const name = String(b.display_name || '').replace(/,.*$/, '').trim();
  if (!name) { out.pending = 'no display name to match against the level feed'; return out; }
  let d = null;
  try {
    d = await cached(`duke:${name.toLowerCase()}`, 900, () => getDukeLake(name.toLowerCase()));
  } catch (e) {
    out.pending = `level feed failed: ${String((e && e.message) || e)}`;
    return out;
  }
  if (!d || !Number.isFinite(d.belowFullPoolFt) || !Number.isFinite(d.fullPool)) {
    out.pending = 'no full-pool level feed names this water — Duke\'s /lakes/current-level is the '
                + 'only one wired, and it publishes its own reservoirs in SC and NC';
    return out;
  }
  out.level_ft = d.ft;
  out.full_pool_ft = d.fullPool;
  out.below_full_pool_ft = round2(d.belowFullPoolFt);
  out.source = 'Duke Energy — api.hydro-derived.duke-energy.app/lakes/current-level; `Actual` is '
             + 'feet inside a 100 ft band under full pond, so the drawdown is 100 minus it';
  return out;
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

  const [p, c, w] = await Promise.all([
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
  ]);

  // CO-OPS answers a bad request with HTTP 200 and {"error":{"message":...}}, so a thrown error
  // is not the only failure mode to check for.
  const errOf = (x) => (x && (x.__err || (x.error && (x.error.message || x.error)))) || null;
  const preds = (p && p.predictions) || [];
  const wl = (w && w.data && w.data.length) ? w.data[w.data.length - 1] : null;

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
