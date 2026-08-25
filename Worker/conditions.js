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
import { waterChain, damTable } from './registry.js';
// RIVERS and lakeKeyFromName came out with dukeBasinFor: the basin is resolved from Duke's own
// /rivers/get-rivers roster now, so this file no longer reads the six-entry hand table at all.
import { dukeRowForNames, fetchDukeFlowArrivals, fetchDukeRivers, fetchDukeActiveRun,
         fetchDukeAccessAlerts, fetchDukeOperatingRange, fetchUsgs, getLakeClarity }
  from './worker-data.js';
import { parseCubeLevels, parseSouthernCoLevels, parseBrookfieldFacility,
         parseSanteeCooper } from './operators.js';
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

/** The same, for the services that answer in USGS's tab-delimited RDB rather than JSON. */
async function getText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/plain' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
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

/**
 * A MapClick observation value as a number, or null.
 *
 * Every field on `currentobservation` is a STRING, and the missing ones are the literal
 * characters "NA" rather than null or an empty string. `Number("NA")` is NaN — survivable — but
 * an un-guarded template prints "NA mph", which is not.
 */
function obsNum(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s === 'NA' || s === 'N/A' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * A COMPASS BEARING, OR NULL. 999 IS NOT A DIRECTION.
 *
 * Reported by Ryan 2026-08-25, off a live card: **"Wind 5 mph from 999°"**.
 *
 * `obsNum` catches this feed's STRING sentinels -- the literal characters "NA" -- and 999 is a
 * NUMERIC one. It is the positive member of the -999 / -9999 / -999999 family this file already
 * filters in four other places, and `NO_DATA` cannot catch it precisely because it is positive:
 * a set of negative sentinels has nothing to say about 999.
 *
 * SO THE TEST IS THE DOMAIN, NOT THE SENTINEL. A bearing is 0 to 360 and there is no reading
 * outside that range which means anything. Listing 999 would leave the next one through;
 * bounding the field cannot.
 *
 * THE SPEED IS KEPT. 5 mph with a missing direction is what a light and variable wind looks
 * like on this feed, and dropping a real speed because its direction is absent would trade one
 * wrong field for one missing one.
 */
export function obsBearing(v) {
  const n = obsNum(v);
  if (n === null) return null;
  return (n >= 0 && n <= 360) ? n : null;
}

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
    // THE OBSERVATION BLOCK WAS BEING THROWN AWAY, and it is the only barometer this app can
    // get on an inland lake. MapClick returns the nearest ASOS reading on the same request we
    // already make for every water: pressure, wind, gust, dewpoint and visibility, all free.
    // CO-OPS answers this on the 16 coastal zones; there are 348 lakes.
    //
    // "NA" IS A STRING SENTINEL. `Gust` and `WindChill` come back as the literal characters N and
    // A, and every number arrives as a string. Feeding "NA" to Number() gives NaN, which is
    // survivable, but feeding it to a template gives "NA mph" on the screen, which is not.
    //
    // THE STATION CAN BE A LONG WAY OFF. The point requested above was 34.41,-80.86 and the
    // observation came back from KCUB at 33.97,-80.99 — about 50 km. The payload carries the
    // station's own coordinates, so the distance is measured and reported rather than assumed
    // to be small. A wind reading from 50 km away is a different claim from one at the ramp.
    observation: co.Temp ? {
      station: co.id || null, name: co.name || null,
      temp_f: obsNum(co.Temp), weather: co.Weather || null,
      dewpoint_f: obsNum(co.Dewp),
      humidity_pct: obsNum(co.Relh),
      wind_mph: obsNum(co.Winds),
      wind_dir_deg: obsBearing(co.Windd),
      gust_mph: obsNum(co.Gust),
      visibility_mi: obsNum(co.Visibility),
      // Altimeter is millibars and SLP is inches of mercury on this feed. Both are carried
      // under names that say which, because 1016 and 30.01 are the same pressure.
      pressure_mb: obsNum(co.Altimeter),
      sea_level_pressure_inhg: obsNum(co.SLP),
      wind_chill_f: obsNum(co.WindChill),
      km_from_point: (Number.isFinite(Number(co.latitude)) && Number.isFinite(Number(co.longitude)))
        ? round1(kmBetween(lat, lon, Number(co.latitude), Number(co.longitude))) : null,
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
 * A BLANK WWA FIELD IS A SINGLE SPACE, NOT NULL AND NOT EMPTY.
 *
 * Measured 2026-08-25 off layer 1 itself: `"ends":" "`, `"sig":" "`, `"phenom":" "`, `"wfo":" "`.
 * `a.ends || null` therefore yields `" "` — truthy, so every downstream guard passes and a
 * blank renders as a timestamp-shaped hole. Trim first, then decide.
 */
export function wwaText(v) {
  const s = String(v == null ? '' : v).trim();
  return s || null;
}

/**
 * VTEC significance, which is NWS's own codebook (NWSI 10-1703), not a scale invented here.
 *
 * This is the field that separates "a storm MIGHT form over you this afternoon" from "one is
 * over you now", and until 2026-08-25 the app could not tell them apart without string-matching
 * the words out of `prod_type`.
 */
const VTEC_SIGNIFICANCE = { W: 'Warning', A: 'Watch', Y: 'Advisory', S: 'Statement',
                            F: 'Forecast', O: 'Outlook', N: 'Synopsis' };

/**
 * WORDS THAT MEAN A STATEMENT IS ABOUT A STORM.
 *
 * Deliberately narrow. A Special Weather Statement is issued for dense fog, patchy frost, blowing
 * dust and a dozen other things, and escalating all of them would train someone to ignore the one
 * that matters. `lightning` and `thunderstorm` are the words NWS actually uses in the ones that
 * do — "frequent cloud to ground lightning" is close to boilerplate in a strong-storm SPS.
 */
const STORM_TEXT = /\b(thunderstorm|thunderstorms|lightning|cloud[-\s]to[-\s]ground|waterspout)\b/i;

/** `sig` when the product carries one; the product's own trailing noun when it does not. */
export function wwaSeverity(sig, prodType) {
  const s = wwaText(sig);
  const mapped = s && VTEC_SIGNIFICANCE[s.toUpperCase()];
  if (mapped) return mapped;
  // Special Weather Statements and a few siblings ship `sig` blank. The name still ends in it.
  const m = /\b(Warning|Watch|Advisory|Statement)\b/i.exec(prodType || '');
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : null;
}

/**
 * NWS WWA filtered to a point. VERIFIED 2026-08-06 by Ryan against Wateree's centroid: the
 * point query works, and it returned `"features": []` — the RIGHT answer, worth saying out
 * loud: no warning was active over that lake at that moment. An empty array here is good news,
 * not a failure, and code that treats "no features" as an error will cry wolf on every clear day.
 *
 * WHAT WAS WRONG WAS THE LINE UNDER HIS VERIFICATION, NOT THE VERIFICATION. This comment used to
 * read "the layer declares exactly these fields — prod_type, event, issuance, expiration,
 * url". Those five are what the query ASKED FOR. Restating our own request as the upstream's
 * schema is how a field nobody fetched becomes a field everybody believes does not exist.
 *
 * The layer declares fifteen, measured 2026-08-25 with `outFields=*`:
 *
 *   objectid  prod_type  msg_type  phenom  url  expiration  onset  ends  issuance
 *   event  sig  wfo  idp_filedate  idp_ingestdate  cap_id
 *
 * FOUR OF THEM CHANGE WHAT A PADDLER IS TOLD.
 *
 *   `sig`      W / A / Y — Warning, Watch, Advisory. See wwaSeverity.
 *   `onset`    when the hazard BEGINS, which is not when the message was issued. A watch cut at
 *              06:00 for a 14:00 storm has issuance 06:00 and onset 14:00, and this app showed
 *              the 06:00.
 *   `ends`     when the HAZARD ends. `expiration` is when the MESSAGE lapses and gets reissued.
 *              They are routinely hours apart and only one of them answers "can I still fish".
 *   `msg_type` carries cancellations, so a lifted warning stops looking active.
 *
 * `event` IS NOT AN EVENT NAME. It is the four-digit VTEC event tracking number — a real
 * sample is `"0038"` — and it was returned under the key `event`, which reads as a label and
 * is not one. It keeps its place here under the name it actually has.
 *
 * LAYER 0 IS NOT A GAP. It is `CurrentWarnings`, the short-fuse convective and marine subset
 * (tornado, severe thunderstorm, flash flood, snow squall, special marine). Layer 1 renders 177
 * distinct `prod_type` values and contains those already, so a second request would buy nothing.
 */
async function hazards(lat, lon) {
  const url = 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/'
            + 'watch_warn_adv/MapServer/1/query'
            + `?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326`
            + '&spatialRel=esriSpatialRelIntersects'
            + '&outFields=prod_type,sig,phenom,msg_type,onset,ends,issuance,expiration,'
            + 'wfo,cap_id,event,url&returnGeometry=false&f=json';
  const j = await cached(`wwa:${lat.toFixed(3)},${lon.toFixed(3)}`, TTL.wwa, () => getJson(url));
  const feats = (j && j.features) || [];
  const items = feats.map((f) => {
      const a = f.attributes || {};
      return {
        type: wwaText(a.prod_type),
        severity: wwaSeverity(a.sig, a.prod_type),
        // Fall back to the message's own clock when the hazard clock is blank, which is common.
        begins: wwaText(a.onset) || wwaText(a.issuance),
        ends: wwaText(a.ends) || wwaText(a.expiration),
        issued: wwaText(a.issuance),
        expires: wwaText(a.expiration),
        message_type: wwaText(a.msg_type),
        phenomenon: wwaText(a.phenom),
        office: wwaText(a.wfo),
        etn: wwaText(a.event),
        id: wwaText(a.cap_id),
        url: wwaText(a.url),
      };
    });

  // A STATEMENT CAN BE A THUNDERSTORM OR IT CAN BE FOG, AND `prod_type` SAYS "Special Weather
  // Statement" FOR BOTH.
  //
  // This is the gap between the two signals this app already has. The hourly forecast's thunder
  // flag is a prediction made this morning; a Severe Thunderstorm Warning is live but requires
  // 58 mph winds or one-inch hail. A storm that throws lightning and clears neither bar earns an
  // SPS and nothing else — and that is most thunderstorms, and where most lightning deaths are.
  // 30 were active nationally when this was written.
  //
  // Lightning DETECTION was the other route and it is closed: NWS publishes none (their own API
  // discussion says so), and NOAA's nowCOAST GOES strike-density service was retired in 2023
  // without a REST replacement. The forecaster's own words are what is actually available.
  //
  // SO THE TEXT IS READ, ONCE, AND ONLY FOR STATEMENTS. Warnings, Watches and Advisories already
  // carry a usable severity in `sig`; a Statement does not, so it is the only product worth
  // spending a request on. `url` is already `api.weather.gov/alerts/{cap_id}` and needs no
  // building.
  //
  // `storm` IS A MEASUREMENT, NOT A SEVERITY. `severity` stays what VTEC says it is. A caller
  // that wants to escalate a thunderstorm statement has a fact to do it with, and a NULL means
  // the text could not be read — which is not the same as a statement about fog and must never
  // be rendered as one.
  await Promise.all(items.map(async (it) => {
    if (it.severity !== 'Statement' || !it.url) return;
    try {
      const cap = await cached(`cap:${it.id}`, TTL.wwa, () => getJson(it.url));
      const p = (cap && cap.properties) || {};
      const text = [p.event, p.headline, p.description].filter(Boolean).join(' ');
      it.storm = text ? STORM_TEXT.test(text) : null;
    } catch (e) {
      it.storm = null;                       // unreadable, and saying so beats guessing quiet
    }
  }));

  return {
    active: items.length,
    // Empty means clear, and the field says so rather than leaving a caller to infer it.
    all_clear: items.length === 0,
    items,
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
/**
 * An NWPS secondary value as cubic feet per second.
 *
 * NWPS publishes discharge in KCFS on the gauges this app binds — the stageflow envelope names
 * it outright, `"secondaryUnits": "kcfs"`. USGS publishes 00060 in ft3/s. A consumer handed both
 * under one field name has no way to know which it got, and the one that guessed printed the
 * Congaree at 4 ft3/s while it was running four thousand.
 *
 * ONLY `status.observed.secondaryUnit` MAY BE READ FOR THIS. The first version of this function
 * fell back to `flood.flowUnits` and, failing that, treated an absent unit as cfs. Both of those
 * are the same 1000x bug wearing a different hat, and `flood.flowUnits` is not a near-miss — it
 * is systematically wrong. Measured 2026-08-16 against the live API:
 *
 *   GADS1  Congaree at Congaree NP      observed.secondaryUnit "kcfs"   flood.flowUnits "cfs"
 *   WATS1  Wateree River at the dam     observed.secondaryUnit "kcfs"   flood.flowUnits "cfs"
 *   AUGG1  Savannah River at Augusta    observed.secondaryUnit "kcfs"   flood.flowUnits "cfs"
 *   KEOS1  Seneca River at Keowee Dam   observed.secondaryUnit "kcfs"   flood.flowUnits "cfs"
 *   CLTT1  Little Tennessee at Chilhowee observed.secondaryUnit ""      flood.flowUnits "cfs"
 *
 * Four for four, the two fields disagree, and GADS1 settles which one is right: 4.17 kcfs is the
 * Congaree in August and 4.17 cfs is a ditch. `flood.flowUnits` describes the units of the flood
 * threshold table, which is a different quantity that happens to share a word. Read the field
 * that travels with the value, never the field that describes it from somewhere else.
 *
 * And CLTT1 shows the empty string is real: NWPS does publish a blank unit. An empty unit is not
 * cfs, it is silence, and it returns null here. An unrecognised or missing unit returns null
 * rather than the raw number, because a discharge in unknown units is not a discharge.
 */
export function nwpsFlowCfs(v, units) {
  if (!Number.isFinite(v)) return null;
  const u = String(units == null ? '' : units).trim().toLowerCase();
  if (u === 'kcfs') return Math.round(v * 1000);
  if (u === 'cfs' || u === 'ft3/s') return v;
  return null;
}

/**
 * WHAT FLOODS AT WHAT STAGE, AND WHERE TODAY SITS AGAINST THIS GAUGE'S OWN RECORD.
 *
 * `/gauges/{lid}` has carried all of this since before the app read it, and the audit reported
 * it as unread for weeks because the only NWPS gauge in `_captures` was ERJS1 -- a tidal gauge
 * with no flood stage, where every one of these fields is empty. Deciding them off that fixture
 * would have been deciding them off a guess, so it stayed open until Ryan captured WATS1, Lake
 * Wateree at the dam, on 2026-08-25. That one answers with all of it.
 *
 * `impacts` IS THE FISHING FACT AND IT IS NOT A FLOOD FACT. On Wateree, at 100.4 ft the piers on
 * the Wildlife Road bridge over Singleton Creek submerge; at 100.5 yards and docks in the low
 * lying areas start to flood; at 103 the boat launch on U.S. 1 closes. The lake sat at 97.34
 * when this was read. Duke's access alerts say a ramp IS shut; this says at what level it WILL
 * be, which is the difference between a notice and a plan.
 *
 * THE NEXT ONE UP IS THE WHOLE POINT. A list of five stages is a table; "three feet of rise from
 * here puts the Singleton Creek bridge piers under" is a sentence somebody can act on.
 *
 * `crests` IS THE HISTORY THIS APP HAS NOWHERE ELSE for an NWPS-only water. It already answers
 * "is this normal for the date" from USGS daily percentiles for flow and from the operator's own
 * five years for a Duke lake; a gauge with neither had nothing. 34 crests on file here, the
 * highest 107.00 ft on 1989-10-03.
 *
 * `historic` AND `recent` ARE THE SAME SET on this gauge -- compared element by element, not
 * assumed -- so only one is carried and the equality is checked rather than trusted.
 *
 * `hydronotes` CARRIES A CAVEAT ABOUT THE READING ITSELF. Wateree's first one is "Gauge reading
 * affected by reservoir operations", which is exactly the thing a person needs told when the
 * level moved and the weather did not. Their `effective` and `expiration` are MMDD strings, so a
 * note can be seasonal, and the ones outside today's window are left out rather than shown.
 *
 * `forecastReliability` TURNS A SILENT NULL INTO A STATED REASON. The forecast block on this
 * gauge is the -999 sentinel, which the reader already drops; this says why -- "Forecasts are
 * issued as needed during times of high water, but are not routinely available."
 *
 * ZERO IS NOT A THRESHOLD. `normalThreshold` and `lowThreshold` both read `{value: 0}` here,
 * which is how this service spells "none set", and a 0 ft low-water threshold on a lake that
 * runs at 97 would read as a gauge permanently in the clear.
 */
/** Today as MM/DD in UTC, which is the form NWPS's seasonal note windows use.
 *
 * NOT named todayMmDd: tvaShape and tvaReservoir both take a PARAMETER by that name, and a
 * module function a caller can shadow without noticing is a trap for whoever edits next.
 */
function utcMmDd() {
  const d = new Date();
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function nwpsFloodContext(j, stageFt, nowMmDd) {
  if (!j || typeof j !== 'object') return null;
  const fl = j.flood || {};
  const stage = num(stageFt);
  const out = {};

  const impacts = (Array.isArray(fl.impacts) ? fl.impacts : [])
    .map((i) => ({ stage: num(i && i.stage), statement: String((i && i.statement) || '').trim() }))
    .filter((i) => i.stage !== null && i.statement)
    .sort((a, b) => a.stage - b.stage);
  if (impacts.length) {
    const next = stage === null ? null : impacts.find((i) => i.stage > stage);
    out.impacts = {
      count: impacts.length,
      // Signed and named: how far the water has to come up before this one happens.
      next: next ? { ...next, ft_to_go: round2(next.stage - stage) } : null,
      passed: stage === null ? [] : impacts.filter((i) => i.stage <= stage),
      all: impacts,
      units: fl.stageUnits || null,
    };
  }
  const low = (Array.isArray(j.impactsLowWaters) ? j.impactsLowWaters : [])
    .map((i) => ({ stage: num(i && i.stage), statement: String((i && i.statement) || '').trim() }))
    .filter((i) => i.statement);
  if (low.length) out.low_water_impacts = low;

  const crestList = (fl.crests && Array.isArray(fl.crests.historic)) ? fl.crests.historic : [];
  const crests = crestList
    .map((c) => ({ stage: num(c && c.stage), at: (c && c.occurredTime) || null,
                   // Carried, never interpreted -- this codebase has no reference for NWPS's
                   // preliminary vocabulary, the same call it makes on CWMS quality codes.
                   preliminary: (c && c.preliminary) || null,
                   old_datum: !!(c && c.olddatum) }))
    .filter((c) => c.stage !== null)
    .sort((a, b) => b.stage - a.stage);
  if (crests.length) {
    const record = crests[0];
    out.crests = {
      on_file: crests.length,
      record,
      latest: crests.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)))[0],
      // Negative is below the record, which is where a lake nearly always is.
      vs_record_ft: stage === null ? null : round2(stage - record.stage),
      // `recent` was identical to `historic` element for element on the gauge this was written
      // against. Checked rather than assumed, and said out loud when they diverge.
      recent_differs: !!(fl.crests && Array.isArray(fl.crests.recent)
        && fl.crests.recent.length !== crestList.length),
    };
  }

  const notes = (Array.isArray(j.hydronotes) ? j.hydronotes : [])
    .filter((n) => n && String(n.statement || '').trim())
    .filter((n) => {
      // MMDD in, MMDD out, and a window may wrap the year end.
      const a = String(n.effective || '').trim();
      const b = String(n.expiration || '').trim();
      if (!/^\d{4}$/.test(a) || !/^\d{4}$/.test(b) || !/^\d{2}\/\d{2}$/.test(String(nowMmDd || ''))) {
        return true;                                   // undated notes always apply
      }
      const today = String(nowMmDd).replace('/', '');
      return a <= b ? (today >= a && today <= b) : (today >= a || today <= b);
    })
    .map((n) => String(n.statement).replace(/\s+/g, ' ').trim());
  if (notes.length) out.notes = notes;

  const reliability = String(j.forecastReliability || '').trim();
  if (reliability) out.forecast_reliability = reliability;

  for (const [key, src] of [['low_threshold_ft', j.lowThreshold],
                            ['normal_threshold_ft', j.normalThreshold]]) {
    const v = num(src && src.value);
    // 0 is how this service spells "none set", not a threshold at the waterline.
    if (v !== null && v !== 0) out[key] = v;
  }

  const up = String(j.upstreamLid || '').trim();
  const down = String(j.downstreamLid || '').trim();
  if (up || down) out.chain = { upstream_lid: up || null, downstream_lid: down || null };

  return Object.keys(out).length ? out : null;
}

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
  const flow = nwpsFlowCfs(num(st.secondary), st.secondaryUnit);

  return {
    lid,
    role,                                     // pool | tailwater | gauge
    name: j.name || (bound && bound.name) || null,
    stage: num(st.primary),
    stage_units: st.primaryUnit || (j.flood && j.flood.stageUnits) || null,
    // NWPS REPORTS FLOW IN KCFS AND USGS REPORTS IT IN FT3/S, and both used to arrive in a
    // field called `flow` with nothing but a units string to tell them apart. The client printed
    // "ft³/s" on both, so the Congaree at roughly 4,000 cfs rendered as "4 ft³/s" — and that
    // number was then compared against USGS daily percentiles in real cfs, which turned a
    // thousandfold error into a confident sentence about the river's history.
    //
    // Normalised HERE, at the point the unit is known, rather than left for every consumer to
    // remember. `flow_units` still travels so nothing has to trust this comment.
    flow,
    // Null when the unit was unreadable, matching usgsSite. A flow with no units attached is
    // worse than no flow: it renders as a number and reads as a fact.
    flow_units: flow === null ? null : 'ft3/s',
    flow_reported_units: st.secondaryUnit || null,
    // The OBSERVATION time, not the fetch time. NWPS writes year 0001 for "never".
    observed_at: st.validTime && !String(st.validTime).startsWith('0001') ? st.validTime : null,
    flood_category: st.floodCategory || null,
    flood_thresholds: Object.keys(thresholds).length ? thresholds : null,
    // WHAT FLOODS AT WHAT STAGE, AND WHERE TODAY SITS AGAINST THIS GAUGE'S RECORD. Already on
    // the wire in the same response the stage came from -- no extra request. See
    // nwpsFloodContext for why it went unread until a gauge with a flood stage was captured.
    flood_context: nwpsFloodContext(j, num(st.primary), utcMmDd()),
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
export function tvaShape(observed, guide, releases, messages, todayMmDd, predicted) {
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
    // THE ONLY LAKE-LEVEL FORECAST THIS APP HAS. /predicted-data runs three days out and says
    // what TVA intends the water to do: average inflow, average outflow, and the elevation it
    // expects at midnight. Everything else here is what the lake IS; this is what it is about
    // to be, which is the question a trip planned for tomorrow actually asks.
    //
    // MidnightElevation arrives as a bare NUMBER while the two flows arrive as display strings
    // with thousands separators -- "2,422". Same object, two conventions. tvaNum takes both.
    forecast: (Array.isArray(predicted) ? predicted : [])
      .map((r) => ({
        day: r.Day || null,
        inflow_cfs: tvaNum(r.AverageInflow),
        outflow_cfs: tvaNum(r.AverageOutflow),
        midnight_elevation_ft: tvaNum(r.MidnightElevation),
      }))
      .filter((r) => r.day && (r.inflow_cfs !== null || r.outflow_cfs !== null
                               || r.midnight_elevation_ft !== null))
      .slice(0, 5),
    source: 'TVA — tva.com/RestApi',
  };
}

async function tvaReservoir(lid, todayMmDd) {
  const one = (route) => cached(`tva:${route}:${lid}`, TTL.gauge,
    () => getJson(`${TVA_API}/${route}/${encodeURIComponent(lid)}?format=json`))
    .catch(() => null);
  const [observed, guide, releases, messages, predicted] = await Promise.all([
    one('observed-data-48-hours'), one('operating-guide'),
    one('generation-releases'), one('lake-messages'), one('predicted-data'),
  ]);
  if (!observed && !guide) return null;
  return { lid, ...tvaShape(observed, guide, releases, messages, todayMmDd, predicted) };
}

/* ══ THE USGS NATIONAL WATER DASHBOARD ════════════════════════════════════════════════════════
 *
 * TWO FACTS THIS APP HAD FOR SOME WATERS AND NOT OTHERS, FOR NO REASON A PERSON WOULD ACCEPT.
 *
 * Ryan, 2026-08-25: *"any data that is available for any and all lakes should be available for
 * any and all lakes"* and *"nothing hand written... everything expandable... if i decide to add
 * every single lake that garmin has in the US into the app tomorrow this stuff should be able to
 * expand with it"*.
 *
 *   WHICH WAY THE WATER IS GOING. `out.trend` comes from NWPS /stageflow, which needs an NWS
 *   handbook-5 lid. Measured against the bindings on 2026-08-25: 45 of 221 waters carry NO lid
 *   on any gauge, so they got no trend at all — and every one of those 45 has a USGS site
 *   number. Issaqueena, Chauga River, Hyco Lake, John H. Moss, Fort Gordon Reservoir.
 *
 *   WHETHER IT IS IN FLOOD. `usgsSite()` writes `flood_category: null` with a comment saying
 *   USGS does not publish one. Not through /nwis/iv, it does not. It publishes one here.
 *
 * FILTERED ON THE BINDING'S OWN SITE NUMBERS — no bounding box, no state list, no table of
 * lakes. `water_bindings.json` says which USGS sites belong to this water; those site numbers go
 * into the `$filter` verbatim. Add a lake in Montana tomorrow and the binder gives it sites and
 * this call covers it, with nothing here to edit. A bbox would have had to be widened by hand,
 * which is the thing that was asked not to exist.
 *
 * AN ACCELERATOR, NEVER A SOLE DEPENDENCY. Every VALUE on the card still comes from fetchUsgs
 * and NWPS. This fills two fields that are otherwise null and touches nothing else, so the day
 * this endpoint is renamed the app loses a trend arrow on 45 waters and nothing more. That
 * matters because `@odata.context` points at `int-noms.er.usgs.gov`: it is the dashboard's own
 * backing service, exposed publicly but documented nowhere this project can cite.
 *
 * NO 24-HOUR CHANGE IS SYNTHESISED. The dashboard gives `RateOfChangeUnitPerHour` and nothing
 * else, and multiplying a rate by 24 to fill `change_24h` would be inventing a trend — the same
 * refusal stageflowTrend already makes when its window is too short. The rate travels under its
 * own name and the change fields stay null.
 */
const USGS_DASHBOARD =
  'https://dashboard.waterdata.usgs.gov/service/cwis/1.0/odata/CurrentConditions';

// Units are fixed per parameter code on this service — it publishes a code and a bare number,
// never a unit string. Only the codes whose readings this app already shows are mapped; anything
// else travels with a null unit rather than a guessed one.
//
// THE THREE ELEVATION CODES ARE NAMED APART, AND THAT IS NOT PEDANTRY. Site 02077280 on Hyco
// Lake (Person Co, NC) answered this service with 00062 = 8.81 and 62614 = 408.6 in the same
// response, read live 2026-08-25. Both are "the reservoir's elevation"; 00062 is above a datum
// USGS does not name, which at that site is a local staff gage, and 62614 is above NGVD 1929.
// Four hundred feet apart, and only one of them is a number anybody would recognise as Hyco.
//
// There is no universal winner, which is why nothing here picks one. On Lake Murray the same
// pair reads 00062 = 356.57 and 62615 = 355.26 against a 358 ft full pool, and there it is the
// UNNAMED datum that matches what the operator publishes. So the label carries the datum and the
// reader can see which they were handed, instead of two different questions sharing one answer.
const DASHBOARD_UNITS = {
  '00065': { units: 'ft', measures: 'Gage height' },
  '00062': { units: 'ft', measures: 'Reservoir elevation above datum' },
  '62614': { units: 'ft', measures: 'Reservoir elevation, NGVD29' },
  '62615': { units: 'ft', measures: 'Reservoir elevation, NAVD88' },
  '63160': { units: 'ft', measures: 'Water level, NAVD88' },
  '00060': { units: 'ft3/s', measures: 'Streamflow' },
  '00010': { units: 'degC', measures: 'Water temperature' },
};
// The level codes a trend is worth having on, best first. A lake wants its elevation and a river
// wants its stage; discharge is the fallback because a rising flow is still a fact about the day.
const DASHBOARD_TREND_PARMS = ['00062', '62615', '62614', '00065', '63160', '00060'];

/**
 * The dashboard's rows, indexed site -> parameter code. Pure.
 *
 * `Value` is absent on 10 of 320 rows in the capture this was written against, and a row with a
 * rate of change and no reading is not a reading. Those are dropped rather than carried as
 * nulls that read like zeroes downstream.
 */
export function dashboardIndex(rows) {
  const out = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const site = String((r && r.SiteNumber) || '').trim();
    const parm = String((r && r.ParameterCode) || '').trim();
    // `num()`, not `Number()`. Number(null) is 0, and a null reading that arrives as a zero is
    // a phantom dry river — the same class as the '' -> 0 guard in js/modules/usgs-gauges.js.
    // It rejects the -999 family too, which this service has no documented position on.
    const value = num(r && r.Value);
    if (!site || !parm || value === null) continue;
    const rate = num(r.RateOfChangeUnitPerHour);
    if (!out.has(site)) out.set(site, new Map());
    out.get(site).set(parm, {
      value: round2(value),
      at: r.TimeLocal || null,
      tz: r.TimeZoneCode || null,
      // A rate of exactly zero IS a reading — it means holding steady — so this cannot collapse
      // to a falsy test.
      rate_per_hour: rate === null ? null : round2(rate),
      // "NOFLOOD" and the flood classes. Null means USGS states nothing for this site, which is
      // not the same as "not flooding" and must not render as it.
      flood: r.FloodStageStatusCode || null,
      // A quality flag on 10 of 320 rows in the capture ("DIS"). Carried, never interpreted —
      // this codebase has no reference for the vocabulary, same call as the CWMS quality code.
      flag: r.ValueFlagCode || null,
      parameter: parm,
    });
  }
  return out;
}

/**
 * A trend from a rate of change, in the same shape stageflowTrend returns, or null.
 *
 * The shape matches on purpose: a caller that already knows how to render a trend must not need
 * to learn a second layout to render this one. What differs is honest — `change_24h` and
 * `change_7d` are null because this source publishes no history, and `rate_per_hour` carries
 * what it does publish.
 */
export function dashboardTrend(byParm) {
  if (!byParm) return null;
  for (const parm of DASHBOARD_TREND_PARMS) {
    const row = byParm.get(parm);
    if (!row || row.rate_per_hour === null) continue;
    const u = DASHBOARD_UNITS[parm] || { units: null, measures: null };
    return {
      latest: row.value,
      at: row.at,
      units: u.units,
      measures: u.measures,
      // The code, beside its label, so a consumer comparing two waters can tell whether it is
      // comparing the same measurement.
      parameter_code: parm,
      // NOT DERIVED FROM THE RATE. See the block comment above.
      change_24h: null,
      change_7d: null,
      rate_per_hour: row.rate_per_hour,
      points: 1,
      covers_hours: null,
      source: 'USGS National Water Dashboard — CurrentConditions',
    };
  }
  return null;
}

/** The OData request for one set of site numbers. Pure, so the filter can be asserted. */
export function dashboardUrl(sites) {
  const list = [...new Set((sites || []).map((s) => String(s || '').trim()).filter(Boolean))]
    // A site number is digits. Anything else is not one, and it would go into a filter string.
    .filter((s) => /^\d{8,15}$/.test(s))
    .sort();
  if (!list.length) return null;
  // BUILT BY HAND, NOT BY URLSearchParams, WHICH ENCODES A SPACE AS `+`. An OData $filter is
  // full of spaces, and this codebase has already been bitten once by that exact substitution --
  // see the WQP URL in Worker/research/limnology.js, which says so in a comment. %20 throughout.
  const enc = (v) => encodeURIComponent(v).replace(/%20/g, '%20');
  const q = [
    // AccessLevelCode 'P' is the public tier. Without it the service answers with rows this app
    // has no right to and USGS has no obligation to keep serving.
    ['$filter', `(AccessLevelCode eq 'P') and (SiteNumber in(${list.map((s) => `'${s}'`).join(',')}))`],
    ['$select', 'SiteNumber,ParameterCode,TimeLocal,TimeZoneCode,Value,ValueFlagCode,'
              + 'RateOfChangeUnitPerHour,FloodStageStatusCode'],
    ['$orderby', 'SiteNumber,ParameterCode'],
    // Every parameter this app maps, times a handful of sites, cannot approach this. A ceiling
    // that can be hit silently is worse than one that cannot be reached.
    ['$top', '500'],
    ['caller', 'TrollMap personal use'],
  ].map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
  return `${USGS_DASHBOARD}?${q}`;
}

/** One call for a whole water. Null on anything at all going wrong — this is never load-bearing. */
async function dashboardFor(sites) {
  const url = dashboardUrl(sites);
  if (!url) return null;
  try {
    const j = await cached(`dash:${url}`, TTL.gauge, () => getJson(url));
    const rows = (j && j.value) || null;
    return rows ? dashboardIndex(rows) : null;
  } catch (_) {
    return null;
  }
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
//
// THE DISPATCH IS DATA, NOT A TERNARY. It was `key === 'cube' ? parseCubeLevels : parseSouthern`,
// which is fine for two and wrong for four -- adding an operator meant editing a conditional in
// the middle of a fetch. Each row now carries its own parser, so the next utility is one line.
//
// AND ONE OF THEM IS NOT HTML. Dominion publishes JSON at a real endpoint; Santee Cooper, Cube
// and Southern Company render server-side. `json: true` is the only difference and it lives in
// the row rather than in a branch.
const OPERATOR_PAGES = {
  cube: {
    url: 'https://ww4.cubecarolinas.com/lake/levels?orgID=3',
    label: 'Cube Carolinas', parse: parseCubeLevels,
  },
  southernco: {
    url: 'https://lakes.southernco.com/default.aspx',
    label: 'Southern Company / Georgia Power', parse: parseSouthernCoLevels,
  },
  // ONE PAGE, EVERY SANTEE COOPER ANSWER. A ten-day forward generation schedule per hydro,
  // Marion and Moultrie against the rule curve, discharge and spill per facility, and upstream
  // inflows for four rivers. santeecooper.com itself only links out to USGS -- the data is in
  // this iframe, which is why it went unfound for so long.
  santeecooper: {
    url: 'https://azapp-lakespublic-prd-001.azurewebsites.net/',
    label: 'Santee Cooper', parse: parseSanteeCooper,
  },
  // Lake Murray's operating band. USGS gives the level; only Dominion gives the 345-360 range it
  // is judged against, and `Difference` is already computed against full pond.
  //
  // `LakeDischarge?lake=saluda` is NOT here on purpose: its `LakeName` is literally the USGS
  // station name and it returns the same number as site 02168504, which the binder now binds to
  // the Lower Saluda directly. A second request for a number already on the wire is not a source.
  dominion: {
    url: 'https://publicservice.dominionenergyse.com/api/lakeMurray',
    label: 'Dominion Energy South Carolina', json: true,
    parse: (j) => (j && j.Status === 'successful' && Number.isFinite(Number(j.CurrentLevel)))
      ? j : null,
  },
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
    if (r.ok) parsed = cfg.parse(cfg.json ? await r.json() : await r.text());
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

  // TWO OPERATORS DO NOT PUBLISH A LIST OF LAKES, so they are answered before the guard that
  // requires one. Cube and Southern Company each render one table of many lakes; Santee Cooper
  // renders one page about two lakes and two hydros, and Dominion answers one lake per endpoint.
  if (op.operator === 'santeecooper') {
    const page = await operatorPage('santeecooper');
    if (!page || !page.elevations || !page.elevations.length) return null;
    const cfg = OPERATOR_PAGES.santeecooper;
    const last = page.elevations[page.elevations.length - 1];
    const moultrie = /moultrie/i.test(op.feed_name);
    const level = moultrie ? last.moultrie_ft : last.marion_ft;
    if (level == null) return null;
    const flow = page.flows[page.flows.length - 1] || null;
    return {
      source: cfg.label, url: cfg.url, feed_name: op.feed_name,
      elevation_ft: level,
      // THE RULE CURVE IS THE POINT. USGS gives Marion's level and only Santee Cooper says what
      // it is supposed to be, which is the same line this app already draws on Duke and Corps
      // lakes. Moultrie has NO rule curve and that is deliberate, not missing -- its elevation
      // is dependent on Marion's, in Santee Cooper's own words -- so it reports null rather
      // than borrowing Marion's target and reading as if it had one.
      rule_curve_ft: moultrie ? null : last.rule_curve_ft,
      vs_rule_curve_ft: moultrie ? null : last.marion_vs_rule_ft,
      rule_curve_note: moultrie
        ? 'Lake Moultrie has no rule curve of its own; its elevation follows Lake Marion.' : null,
      spilling_cfs: flow ? flow.spilling_cfs : null,
      inflow_cfs: flow ? flow.inflow_cfs : null,
      discharge_cfs: flow ? flow.discharge_cfs : null,
      observed_at: last.date,
      last_updated: page.updated,
      bound_by: op.why,
    };
  }

  if (op.operator === 'dominion') {
    const j = await operatorPage('dominion');
    if (!j) return null;
    const cfg = OPERATOR_PAGES.dominion;
    const cur = Number(j.CurrentLevel);
    const full = Number(j.FullLevel);
    const low = Number(j.LowLevel);
    return {
      source: cfg.label, url: cfg.url, feed_name: op.feed_name,
      elevation_ft: Number.isFinite(cur) ? cur : null,
      full_pond_ft: Number.isFinite(full) ? full : null,
      // `Difference` is current MINUS full, so it is negative when the lake is down. Every other
      // operator in this file reports below-full as a POSITIVE number of feet, and one field
      // meaning opposite things by operator is how a drawdown reads as a rise.
      below_full_pond_ft: Number.isFinite(Number(j.Difference))
        ? Math.round(-Number(j.Difference) * 100) / 100
        : (Number.isFinite(full) && Number.isFinite(cur)
            ? Math.round((full - cur) * 100) / 100 : null),
      // The floor Dominion operates to. USGS publishes the level and nothing publishes this.
      low_level_ft: Number.isFinite(low) ? low : null,
      observed_at: j.FileDate || null,
      bound_by: op.why,
    };
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
export function releaseShape({ duke, dukeRun, tva, operator, usace } = {}) {
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
  // THE DAM'S OWN SCHEDULE. Ranked below arrivals, and the reason is narrower than I first
  // wrote it: on a RIVER an arrival says when the water reaches you, which beats knowing when it
  // left the powerhouse. On a lake there is no competition at all, because an arrival is a river
  // product and never applies.
  //
  // RYAN'S MODEL OF A RESERVOIR, 2026-08-17, correcting mine: *"releases mean flow out as well...
  // so for wateree if fishing north end then cedar creek dam release would flow down into the
  // lake... but it would not have an arrival because it is not a river. for the south end water
  // leaving the wateree dam may cause a slight current but probably not noticeable"*.
  //
  // So a lake has TWO dams that matter and they matter differently. The one ABOVE is inflow —
  // it pushes water and bait down onto the upper end, and it is the one worth fishing. The
  // lake's OWN dam is outflow — it draws the pool down over hours and makes some current at that
  // end, and on a body this size it may not be noticeable at all. Neither is an arrival, and
  // saying which of the two a row is remains open: Duke publishes one row per powerhouse and
  // nothing in the payload says which side of a given lake it sits on.
  //
  // A NO-RELEASE DAY IS AN ITEM, NOT AN ABSENCE. Duke says "08/19/26 No Flow Release" in the
  // datetime field itself, and dropping those rows would turn a stated zero into silence. Today
  // that is Lake Wateree's entire answer, three days running.
  if (Array.isArray(dukeRun) && dukeRun.length) {
    // INFLOW IS THE ONE WORTH FISHING. The dam above pushes water and bait onto the upper end;
    // the lake's own dam draws the pool down and, on a body this size, may not be noticeable.
    // Split rather than ranked, because which one matters depends on which end you are on.
    const inflow = dukeRun.filter((r) => r.direction === 'inflow');
    const outflow = dukeRun.filter((r) => r.direction === 'outflow');
    return {
      kind: 'scheduled',
      operator: 'Duke Energy',
      basin: (dukeRun[0] && dukeRun[0].dam) || null,
      last_updated: null,
      next: dukeRun.find((r) => !r.no_release) || dukeRun[0] || null,
      items: dukeRun.slice(0, 6),
      inflow: inflow.length ? inflow.slice(0, 6) : null,
      outflow: outflow.length ? outflow.slice(0, 6) : null,
      inflow_from: (inflow[0] && inflow[0].from) || null,
      all_no_release: dukeRun.every((r) => r.no_release),
      source: 'https://api.hydro-derived.duke-energy.app/rivers/active-run',
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
  // THE CORPS, WHICH PUBLISHES WHAT WENT THROUGH AND NOT WHAT WILL. Ranked below anything
  // SCHEDULED, because a schedule tells you about the trip you have not taken yet and this tells
  // you about the hour that just passed. Ranked above nothing, which is what a Corps lake used to
  // get. Same `kind: 'observed'` as safewaters, for the same reason.
  if (usace && (usace.outflow || usace.through_turbines || usace.spill)) {
    const item = (key, label) => (usace[key]
      ? { label, cfs: usace[key].value, at: usace[key].at, series: usace[key].series } : null);
    const items = [item('outflow', 'Total release'), item('through_turbines', 'Through turbines'),
                   item('spill', 'Spillway'), item('inflow', 'Inflow')].filter(Boolean);
    return {
      kind: 'observed',
      operator: 'US Army Corps of Engineers',
      basin: usace.project || null,
      last_updated: usace.observed_at || null,
      next: null,
      items,
      flow_units: 'ft3/s',
      tailwater_ft: usace.tailwater_ft ?? null,
      // Reported, never hidden. This district's SHEF feed can run behind, and a caller that is
      // not told how old a release figure is cannot decide whether to use it.
      age_hours: usace.age_hours ?? null,
      source: usace.source || null,
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
 * WHICH DUKE BASIN THIS WATER IS ON, ANSWERED FROM DUKE'S OWN LIST.
 *
 * `RIVERS.dukeBasinId` was hand-typed on two of six rivers and this function read it. Ryan,
 * 2026-08-17, on the Wateree being refused: *"this is for wateree... which is part of the
 * catawba chain... doesn't duke have releases on their api"* — and pasted `/rivers/get-rivers`,
 * which is the index that makes the typing unnecessary. Seven basins, published, versus two ids
 * somebody entered.
 *
 * THE FIELD THAT NAMES THE WATERS IS `riverDescription`, NOT `RiverName`. Basin 1 is RiverName
 * "Catawba" and riverDescription "Catawba - Wateree". The refusal Ryan hit compared "Catawba"
 * against "Wateree Lake", found nothing in common, and called a correct id unverified — while
 * the field that says "Wateree" in so many words was sitting beside it, unread. Same shape as
 * the CWMS catalogue saying metres while the data endpoint said feet.
 *
 * AND `RiverName` IS CONCATENATED ON TWO OF THEM. "BroadRiver" and "PigeonRiver" are ONE token
 * to any splitter that breaks on non-word characters, so "Broad River" would never have matched
 * basin 10 either. Split on the case boundary before tokenising, or the index is unusable.
 *
 * BASIN 4 IS "Other Lakes and Rivers" AND MUST NEVER AGREE WITH ANYTHING. A catch-all that
 * matches on the word "lakes" would put a release projection on every water in the app.
 */
const BASIN_CATCH_ALL = /^others?$/i;

/** "BroadRiver" -> "Broad River". Leaves "Keowee Toxaway" alone. */
export function splitCamel(s) {
  return String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/**
 * Words every one of these names carries, on both sides, so they distinguish nothing. Dropping
 * them is what stops every basin agreeing with every river.
 */
function distinctive(s) {
  const out = new Set();
  for (const t of reportTokens(splitCamel(s))) {
    if (!/^(river|creek|canal|branch|run|fork|basin|dam|hydro|project|area|tailwater|tailrace|other|others)$/.test(t)) {
      out.add(t);
    }
  }
  return out;
}

/**
 * The river a gauge sits on: the part of its name BEFORE the locative.
 *
 * Agencies name gauges "<RIVER> at <PLACE>", and the place half is a minefield — "Long Creek at
 * PAW CREEK", "McDowell Creek at Beatties Ford Rd.", "CATAWBA RIVER BL LAKE WYLIE DAM FEWELL
 * ISLAND, SC". Tokenising the whole string would let a town or a road agree with a basin. The
 * river is the part in front, and that is the only part read.
 */
export function gaugeRiverPart(name) {
  return String(name || '').split(/\s+(?:at|near|nr|below|bl|above|ab|blw|abv|on|to)\s+/i)[0];
}

/**
 * Everything this water is allowed to be called, for basin matching.
 *
 * THE BINDING ALREADY CARRIES THE RIVER SYSTEM and nothing was reading it. Wateree Lake's pool
 * gauge is "Catawba River at Cedar Creek Reservoir/Rocky Ck-Cedar Ck Dam"; Lake Wylie's is
 * "Catawba River at Lake Wylie Dam"; every one of the seven Catawba-chain lakes in the registry
 * is bound to a gauge whose name begins "Catawba River". NWS names a gauge for the river it is
 * on, so the river system travels with every binding for free.
 *
 * That matters because the lake's own name usually does NOT contain its river. "Catawba -
 * Wateree" happens to name Wateree; it does not name Wylie, Norman, James, Hickory, Rhodhiss or
 * Mountain Island, and all six are on that basin.
 */
export function waterBasinEvidence(waterName, gaugeNames = []) {
  const out = distinctive(waterName);
  for (const n of gaugeNames || []) for (const t of distinctive(gaugeRiverPart(n))) out.add(t);
  return out;
}

/**
 * The basin id for a water, or null. `roster` is `/rivers/get-rivers`; null roster, null answer —
 * a release projection is not worth guessing an id for.
 */
export function dukeBasinFor(roster, waterName, gaugeNames = []) {
  if (!Array.isArray(roster) || !roster.length) return null;
  const want = waterBasinEvidence(waterName, gaugeNames);
  if (!want.size) return null;
  let best = null;
  for (const row of roster) {
    const id = Number(row && (row.RiverId ?? row.riverId));
    if (!Number.isFinite(id)) continue;
    if (BASIN_CATCH_ALL.test(String(row.RiverName || '').trim())) continue;
    const have = new Set([...distinctive(row.RiverName), ...distinctive(row.riverDescription)]);
    const hits = [...have].filter((t) => want.has(t));
    // MOST SPECIFIC WINS. "Catawba - Wateree" shares two tokens with the Wateree and one with
    // Lake Norman; both are right, and preferring the stronger overlap keeps a one-word
    // coincidence from outranking a real one.
    if (hits.length && (!best || hits.length > best.hits.length)) {
      best = { id, name: row.RiverName || null, description: row.riverDescription || null, hits };
    }
  }
  return best ? best.id : null;
}

/** The same match, with its working shown, for the refusal message. */
export function dukeBasinWhy(roster, waterName, gaugeNames = []) {
  const id = dukeBasinFor(roster, waterName, gaugeNames);
  if (id == null) return null;
  const row = roster.find((r) => Number(r.RiverId ?? r.riverId) === id) || {};
  const want = waterBasinEvidence(waterName, gaugeNames);
  const have = new Set([...distinctive(row.RiverName), ...distinctive(row.riverDescription)]);
  return { id, name: row.RiverName || null, description: row.riverDescription || null,
           matched: [...have].filter((t) => want.has(t)) };
}

/**
 * WHICH OF A BASIN'S ARRIVALS ARE ABOUT THIS WATER — AND WHETHER ANY OF THEM CAN BE.
 *
 * Ryan, 2026-08-17, on the Wateree card the moment the basin started resolving: *"all of these
 * are north of wateree so why would they be projected releases for lake wateree"*. Morganton is
 * at the TOP of the Catawba below Lake James; Rock Hill is at Wylie; Lake Wateree is the last
 * impoundment on the chain. Basin 1 is a quarter of a state and eleven dams.
 *
 * THEN HE PASTED THE RAW PAYLOAD, and it answers the question I had left open.
 *
 * `/rivers/flow-arrivals/1`, 2026-08-16, in full: two dams publishing — "BW 2 Units"
 * (Bridgewater, at Lake James) and "Wylie" — nine entries each, which are three mile markers
 * repeated across three days. Every entry carries `DamName`, `MileMarkerName`, `Arrival`,
 * `Recedes` and a `RiverSection` that is null on all eighteen. The `Dams[]` wrapper carries a
 * name and nothing else.
 *
 * SO THERE IS NO GEOMETRY IN IT. No river mile, no coordinates, no ordering field. "Downstream
 * of this dam" cannot be computed from this endpoint, and the name test is not a stopgap for
 * something better — it is what the payload supports.
 *
 * AND THE MILE MARKERS SAY WHAT THIS PRODUCT IS FOR:
 *
 *   Watermill Road Access Area      Rock Hill River Park
 *   Catawba River Water Intake      Catawba Indian Reservation
 *   Morganton Greenway              Lansford Canal State Park
 *
 * Every one is a RIVER ACCESS POINT below a dam. Duke publishes these so somebody standing in
 * the river knows when the surge reaches them. They are not lake facts and they never were: a
 * release from the dam above a reservoir raises it imperceptibly, and a release from its own dam
 * lowers it. The endpoint is `/rivers/`.
 *
 * So a lake is refused outright, with the reason, rather than filtered and found wanting. That
 * is the rule that would have prevented this bug instead of catching it, and it makes the name
 * matching below a river-only concern.
 */
export function arrivalsAppliesTo(featureType) {
  return String(featureType || '').toLowerCase() === 'river';
}

/**
 * The same schedule with the repeats collapsed.
 *
 * Duke publishes each dam-and-marker pair once per day for the next three days — eighteen
 * entries for six real places. The card shows four, sorted by time, so three days of Bridgewater
 * filled it and Wylie never appeared. One row per place, the next one due.
 */
export function nextArrivalPerMarker(arrivals, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const best = new Map();
  for (const a of arrivals || []) {
    if (!a) continue;
    const key = `${a.damName || ''}|${a.mileMarkerName || ''}`;
    const t = Number.isFinite(a.arrivalEpoch) ? a.arrivalEpoch : Date.parse(a.arrival || '');
    // An arrival already past is not a projection. Keep it only if nothing later exists for
    // this place, so a marker never disappears entirely mid-surge.
    const prev = best.get(key);
    if (!prev) { best.set(key, { a, t }); continue; }
    const prevFuture = Number.isFinite(prev.t) && prev.t >= now;
    const thisFuture = Number.isFinite(t) && t >= now;
    if (thisFuture && (!prevFuture || t < prev.t)) best.set(key, { a, t });
    else if (!prevFuture && !thisFuture && Number.isFinite(t) && t > (prev.t || -Infinity)) {
      best.set(key, { a, t });
    }
  }
  return [...best.values()]
    .sort((x, y) => (x.t || 0) - (y.t || 0))
    .map((v) => v.a);
}

/**
 * The arrivals that name this water or one of its gauges.
 *
 * THE BASIN'S OWN RIVER NAME CANNOT DO THE FILTERING. Every gauge on this chain is named
 * "Catawba River at ...", and one of the markers is "Catawba River Water Intake" — so a match on
 * "catawba" keeps exactly the wrong one. The river token is excluded and PLACE is what is left.
 *
 * `RiverName` ONLY, NOT `riverDescription`. Basin 1's description is "Catawba - Wateree", and
 * "wateree" is not basin-wide — it is the downstream half. Excluding it would throw away the one
 * word that identifies that water, and the first run of the test caught exactly that.
 *
 * AND A WATER NAMED AFTER ITS RIVER KEEPS ITS NAME. Basin 6 is "Keowee Toxaway"; on the Keowee
 * "keowee" is both river and water, and excluding it would leave it unable to match its own dam.
 * Anything the water's own name carries is never excluded.
 */
export function arrivalsForWater(sched, waterName, gaugeNames = [], basinRow = null) {
  const arrivals = (sched && sched.arrivals) || [];
  if (!arrivals.length) return [];

  const mine = distinctive(waterName);

  const shared = new Set();
  for (const t of [...distinctive(basinRow && basinRow.RiverName),
                   ...distinctive(sched && sched.basinName)]) {
    if (!mine.has(t)) shared.add(t);
  }

  const want = new Set(mine);
  for (const n of gaugeNames || []) for (const t of distinctive(n)) want.add(t);
  if (!want.size) return [];

  const hits = (s2) => {
    for (const t of distinctive(s2)) if (want.has(t) && !shared.has(t)) return true;
    return false;
  };
  return arrivals.filter((a) => hits(a.damName) || hits(a.mileMarkerName));
}

/**
 * A Duke release datetime, or a stated no-release.
 *
 * "08/16/2026 04:00:00 PM" is a time. "08/19/26 No Flow Release" is the SAME FIELD carrying a
 * sentence instead, with `Units: "N/A"` beside it — and the year loses two digits when it does.
 * Date.parse returns NaN on it, so a parser that only kept finite dates would drop the row and
 * turn "Duke has explicitly scheduled no release that day" into "we have no information", which
 * is the single most common failure in this whole app.
 *
 * A STATED ZERO IS AN ANSWER. It is the answer Lake Wateree gets today, three days running, and
 * it is worth more to a trip than most of what is on the card.
 *
 * Duke publishes local time with no offset. Eastern is assumed, the same assumption
 * fetchDukeFlowArrivals already makes, and the offset travels so nothing downstream has to guess.
 */
export function parseDukeRunTime(v, offset = '-04:00') {
  const raw = String(v == null ? '' : v).trim();
  if (!raw) return null;
  if (/no\s*flow\s*release/i.test(raw)) {
    const d = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!d) return { noRelease: true, date: null, epoch: null, raw };
    const yr = d[3].length === 2 ? `20${d[3]}` : d[3];
    return { noRelease: true, date: `${yr}-${d[1].padStart(2, '0')}-${d[2].padStart(2, '0')}`,
             epoch: null, raw };
  }
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return null;
  const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
  let hh = Number(m[4]);
  const ap = (m[7] || '').toUpperCase();
  if (ap === 'PM' && hh !== 12) hh += 12;
  if (ap === 'AM' && hh === 12) hh = 0;
  const iso = `${yr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
            + `T${String(hh).padStart(2, '0')}:${m[5]}:${m[6]}${offset}`;
  const t = Date.parse(iso);
  return Number.isFinite(t)
    ? { noRelease: false, date: iso.slice(0, 10), epoch: t, iso, raw }
    : null;
}

/**
 * /rivers/active-run, flattened to one row per scheduled window.
 *
 * `Units` is the generator count and is EMPTY on most dams — "" is "published without a count",
 * not zero, and "N/A" rides along with a no-release. Number('') is 0 and this is the eighth time
 * that has mattered this week, so absence is checked before the conversion.
 */
export function parseActiveRun(json) {
  const out = [];
  for (const row of Array.isArray(json) ? json : []) {
    if (!row) continue;
    const basinId = Number(row.riverId ?? row.RiverId);
    // riverName IS THE DAM on this endpoint. Named `dam` here so nothing downstream repeats the
    // mistake of reading it as a river.
    const dam = row.riverName || row.RiverName || null;
    if (!dam) continue;
    for (const rel of row.Releases || row.releases || []) {
      if (!rel) continue;
      const start = parseDukeRunTime(rel.StartDateTime);
      const end = parseDukeRunTime(rel.EndDateTime);
      if (!start) continue;
      const u = rel.Units;
      const units = (typeof u === 'string' && u.trim() !== '' && u.trim().toUpperCase() !== 'N/A')
        ? (Number.isFinite(Number(u)) ? Number(u) : null)
        : (typeof u === 'number' && Number.isFinite(u) ? u : null);
      out.push({
        dam,
        basin_id: Number.isFinite(basinId) ? basinId : null,
        no_release: !!start.noRelease,
        date: start.date,
        start: start.iso || null,
        end: (end && end.iso) || null,
        start_epoch: start.epoch,
        end_epoch: (end && end.epoch) || null,
        generators: units,
      });
    }
  }
  out.sort((a, b) => (a.start_epoch ?? Number.MAX_SAFE_INTEGER) - (b.start_epoch ?? Number.MAX_SAFE_INTEGER));
  return out;
}

/**
 * The dam schedule that belongs to this water.
 *
 * UNLIKE A FLOW ARRIVAL, THIS APPLIES TO A LAKE. The release from a reservoir's own dam is what
 * draws it down and what makes the current at the dam; on the river below it is the surge. Both
 * are the same fact read from different banks, and Duke publishes it per powerhouse.
 *
 * The dam names match through the SAME evidence the basin match uses. Lake Hickory is bound to
 * "Catawba River at Lake Hickory/Oxford Dam" and Duke's dam is "Oxford"; Lake James is bound to
 * "OLD CATAWBA R BL CATAWBA DAM NEAR BRIDGEWATER, NC" and Duke's dam is "Bridgewater". Neither
 * lake's own name contains its powerhouse. The gauge names carry it, again.
 *
 * SCOPED TO THE BASIN FIRST, so a dam name cannot reach across river systems.
 */
export function activeRunForWater(runs, basinId, waterName, gaugeNames = [], basinRow = null) {
  const rows = (runs || []).filter((r) => r && (basinId == null || r.basin_id === basinId));
  if (!rows.length) return [];

  const mine = distinctive(waterName);
  const shared = new Set();
  for (const t of distinctive(basinRow && basinRow.RiverName)) if (!mine.has(t)) shared.add(t);

  const want = new Set(mine);
  for (const n of gaugeNames || []) for (const t of distinctive(n)) want.add(t);
  if (!want.size) return [];

  return rows.filter((r) => {
    for (const t of distinctive(r.dam)) if (want.has(t) && !shared.has(t)) return true;
    return false;
  });
}

/**
 * Which side of this lake a dam sits on.
 *
 * `activeRunForWater` already returns BOTH dams that matter to a reservoir, because the gauge
 * bindings carry both: wateree_lake is bound to "Catawba River at Cedar Creek Reservoir/Rocky Ck-
 * Cedar Ck Dam" AND "Wateree River at Lake Wateree Dam". Lake Hickory carries Rhodhiss's dam
 * alongside its own Oxford. What the payload cannot say is WHICH IS WHICH, and until now neither
 * could this file -- the note on releaseShape said exactly that.
 *
 * RYAN'S MODEL, which this implements: *"for wateree if fishing north end then cedar creek dam
 * release would flow down into the lake... for the south end water leaving the wateree dam may
 * cause a slight current but probably not noticeable"*. The dam ABOVE is INFLOW and is the one
 * worth fishing; the lake's OWN dam is OUTFLOW.
 *
 * A LOOKUP, NOT A MATCH. `damOwner` maps a Duke dam name to the slug it impounds, built offline
 * from the gauge bindings, where one string names both -- "Catawba River at Lake Hickory/Oxford
 * Dam". The first version of this compared tokens here instead, and Lake Marion called a Cedar
 * Creek release "inflow from wateree_lake": Cedar Creek's dam appears in Wateree's gauge list, so
 * a token test cannot tell a lake's own dam from the one feeding it. Cedar Creek is two dams above
 * Marion and is not adjacent to it at all. Bridgewater, Oxford and Cowans Ford appear in no lake
 * name, so guessing was never going to work.
 *
 * WHAT COUNTS AS "ABOVE" -- and why this is a WALK and not chain[slug].upstream.
 *
 * The first working version read chain[slug].upstream directly, and it was right for the wrong
 * reason. water_chain.json held 283 of 450 waters because it matched on GNIS id alone, and
 * almost every river was among the 167 it missed. With the rivers absent, two reservoirs with a
 * river between them appeared ADJACENT, so an adjacency test happened to give the right answer.
 *
 * Reading _nhd_bindings.json added 140 waters, 47 of them river reaches, and the accident ended:
 *
 *     before   wateree_lake -> lake_marion
 *     after    wateree_lake -> wateree_river -> lake_marion
 *
 * Nothing about the water moved; the chain merely stopped omitting the river it runs through.
 * Under an adjacency test Lake Marion would have gone from correctly labelling a Wateree release
 * as inflow to labelling nothing at all -- a fuller map making the answer worse, which is the
 * surest sign the rule was wrong rather than the data.
 *
 * THE RULE, stated the way Ryan states it: a release is inflow if the water it comes from drains
 * INTO this one WITHOUT BEING CAUGHT BY ANOTHER IMPOUNDMENT ON THE WAY. So walk `downstream`
 * from the releasing water and stop at the first water that owns a dam of its own. A river reach
 * has no dam, so it is transparent; a reservoir has one, so it is opaque.
 *
 * That subsumes the adjacency rule instead of bolting onto it, and it still refuses the case
 * adjacency was introduced to refuse: Cedar Creek -> wateree_lake -> lake_marion stops dead at
 * Wateree, because Wateree impounds a dam. Cedar Creek is two dams above Marion and a release
 * there reaches Marion only as whatever Wateree chooses to pass on, which is Wateree's release,
 * not Cedar Creek's. It is also correct against the OLD published chain, where the walk finds
 * lake_marion in one hop -- so this can deploy before or after the fuller chain.
 *
 * A row that matches no dam stays null. Lake Hickory's feeders include old_millpond and
 * shuford_pond, which have no powerhouse and never appear in a release payload at all.
 */

// A reservoir and the next one down are separated by a handful of river reaches at most. The cap
// is a runaway guard for a malformed or cyclic chain, not a tuning knob -- the real stop is
// hitting a water that impounds a dam.
const RELEASE_WALK_MAX_HOPS = 12;

export function releaseDirection(rows, { slug, chain, damOwner } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const owner = damOwner || {};
  const nodes = chain || {};
  // Every water that impounds a dam anyone publishes. These are what stop the walk, and the set
  // comes from the dam table rather than from a feature type: "does something dam this water" is
  // the question, and the dam table is the only thing that actually answers it.
  const impounds = new Set(Object.values(owner).filter(Boolean));

  // A WATER MAY DRAIN TO MORE THAN ONE PLACE, so this follows every outlet rather than the
  // single `downstream`. Lake Moultrie has two: St Stephen to the Santee, which NHD routes,
  // and Pinopolis to the Cooper, which it does not and which registry/_chain_links.json
  // asserts. A one-value walk reaches whichever NHD happened to pick and never labels a
  // release on the other. Falls back to [downstream] so a chain published before `outlets`
  // existed behaves exactly as it did.
  const outletsOf = (s) => {
    const n = nodes[s];
    if (!n) return [];
    if (Array.isArray(n.outlets) && n.outlets.length) return n.outlets;
    return n.downstream ? [n.downstream] : [];
  };

  const drainsInto = (from) => {
    // Breadth-first, and `seen` is what makes a braided system terminate -- the lower Santee
    // rejoins itself, so a depth-first walk down two outlets can revisit the same water.
    let front = outletsOf(from);
    const seen = new Set([from]);
    for (let hop = 0; front.length && hop < RELEASE_WALK_MAX_HOPS; hop += 1) {
      const next = [];
      for (const at of front) {
        if (at === slug) return true;       // arrived, uninterrupted
        if (seen.has(at)) continue;
        seen.add(at);
        if (impounds.has(at)) continue;     // caught by another dam; other branches carry on
        next.push(...outletsOf(at));
      }
      front = next;
    }
    return false;
  };

  return list.map((r) => {
    const key = normalizeDamName(r && r.dam);
    const who = key ? owner[key] : null;
    if (!who) return { ...r, direction: null, from: null };
    if (who === slug) return { ...r, direction: 'outflow', from: slug };
    if (drainsInto(who)) return { ...r, direction: 'inflow', from: who };
    return { ...r, direction: null, from: null };
  });
}

/**
 * One spelling for a dam name, so the offline table and the live payload meet.
 *
 * Duke says "Cedar Creek"; the gauge says "Rocky Ck-Cedar Ck Dam". Case, punctuation and a
 * trailing "Dam" or "Dams" are noise, and matching on them is how a table stops working the day
 * an operator adds a hyphen.
 */
export function normalizeDamName(v) {
  const NOISE = new Set(['dam', 'dams', 'hydro', 'powerhouse', 'project', 'lake', 'reservoir']);
  return String(v == null ? '' : v).toLowerCase()
    .replace(/&[a-z]+;/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !NOISE.has(t))
    .join(' ') || null;
}

/**
 * Duke's alert HTML as sentences.
 *
 * Every space in this payload is a `&nbsp;` entity — "On&nbsp;May&nbsp;1,&nbsp;2026,&nbsp;the..." —
 * so a naive tag strip yields one unbroken word. Entities are decoded FIRST, then tags, and the
 * block-level ones become breaks so a bulleted safety list does not run into a paragraph.
 *
 * LINKS ARE KEPT SEPARATELY. Several alerts are nothing but a pointer at the county that actually
 * runs the ramp — Gaston County for South Point, York County for Ebenezer and Allison Creek — and
 * dropping the href turns "here is who to ask" into "there is a notice".
 */
const HTML_ENTITY = {
  nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', ndash: '–', mdash: '—',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…',
};
export function decodeEntities(v) {
  return String(v == null ? '' : v)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const k = HTML_ENTITY[name.toLowerCase()];
      return k === undefined ? m : k;
    });
}

export function alertText(html) {
  const withBreaks = String(html == null ? '' : html)
    .replace(/<\s*(br|\/p|\/li|\/ul|\/div)\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(withBreaks)
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

export function alertLinks(html) {
  const out = [];
  for (const m of String(html == null ? '' : html).matchAll(/href\s*=\s*"([^"]+)"/gi)) {
    const u = decodeEntities(m[1]);
    if (/^https?:/i.test(u) && !out.includes(u)) out.push(u);
  }
  return out;
}

/**
 * The "All Projects" notice is SEVERAL notices in one field.
 *
 * `riverbasinId: 0` carries the Keowee-Toxaway LIP, the Catawba-Wateree LIP, the Helene debris
 * warning and a recreation-safety list, concatenated and separated by a paragraph containing
 * nothing but a hyphen. Shown whole it is a wall of text about two river systems on every Duke
 * water in the app. Split, and only the part naming this basin has to travel.
 */
export function splitNotices(text) {
  return String(text || '').split('\n')
    .reduce((acc, line) => {
      if (/^[-–—\s]+$/.test(line)) { acc.push([]); return acc; }
      acc[acc.length - 1].push(line);
      return acc;
    }, [[]])
    .map((lines) => lines.join('\n').trim())
    .filter(Boolean);
}

/**
 * The drought / Low Inflow Protocol notice for a basin, if there is one.
 *
 * THIS IS THE REASON BEHIND THE ZERO. Lake Wateree reads "No Flow Release" three days running,
 * and the cause is one sentence in a different endpoint: the Catawba-Wateree basin went to Stage 2
 * of the LIP on 2026-05-01 and recreation flows are suspended under Stage 2. A stated zero with
 * its cause beside it is a different fact from a stated zero on its own.
 */
export function droughtNoticeFor(alerts, basinRow) {
  const want = new Set([...distinctive(basinRow && basinRow.RiverName),
                        ...distinctive(basinRow && basinRow.riverDescription)]);
  if (!want.size) return null;
  for (const a of alerts || []) {
    for (const notice of splitNotices(a.text)) {
      if (!/low\s*inflow\s*protocol|\bLIP\b|drought/i.test(notice)) continue;
      let hit = false;
      for (const t of distinctive(notice)) if (want.has(t)) { hit = true; break; }
      if (!hit) continue;
      const stage = notice.match(/Stage\s+(\d+)/i);
      return {
        stage: stage ? Number(stage[1]) : null,
        suspends_recreation_flows: /recreation\s+flow[^.]*suspend/i.test(notice),
        text: notice,
        last_updated: a.last_updated || null,
        source: 'https://api.hydro-derived.duke-energy.app/access-alerts',
      };
    }
  }
  return null;
}

/** access-alerts, flattened. `locationType` is RIVERBASIN | LAKEPOND | POI. */
export function parseAccessAlerts(json) {
  const out = [];
  for (const group of Array.isArray(json) ? json : []) {
    for (const a of (group && group.alerts) || []) {
      if (!a) continue;
      const basinId = Number(a.riverbasinId ?? a.riverBasinId);
      out.push({
        id: a.alertId ?? null,
        // -1 is Duke's "Unknown" basin and it carries an Ohio River notice. Not everything a
        // service publishes is about you.
        basin_id: Number.isFinite(basinId) && basinId >= 0 ? basinId : null,
        basin_name: group.riverName || null,
        water: a.lakepondDesc || null,
        // THE KEY TO /lakes/operating-range/{id}. Ryan found that endpoint on 2026-08-17 and the
        // 24 in it is this field for Lake Wateree. A foreign key that cannot be derived and did
        // not have to be typed either — it is published here, for every Duke lake.
        water_location_id: Number.isFinite(Number(a.lakepondLocationId))
          ? Number(a.lakepondLocationId) : null,
        place: a.locationDesc || a.locationName || null,
        kind: a.locationType || null,
        text: alertText(a.alertText),
        links: alertLinks(a.alertText),
        last_updated: a.lastUpdated || null,
      });
    }
  }
  return out;
}

/**
 * THE TOKENS THAT NAME THIS WATER -- AND A GAUGE'S PLACE HALF IS NOT ONE OF THEM.
 *
 * Reported by Ryan 2026-08-25. A conditions card for the Lower Saluda carried three Duke access
 * alerts, and all three belong to other rivers in other basins:
 *
 *     Mountain Island Tailrace Fishing Area and Mountain Island Park   filed under Lake Wylie
 *     Mile Creek Park                                                  filed under Lake Keowee
 *     Morrow Mountain State Park                                       filed under Lake Tillery
 *
 * ONE WORD DID IT: `park`. It enters this water's token set from its OWN gauge --
 * `SALUDA RIVER AT SALUDA SHOALS PARK AT COLUMBIA, SC` -- and `park` is not in the stop list,
 * so a fishing area on the Catawba and a county park on Keowee both "named" the Lower Saluda.
 * `columbia` and `shoals` were in there for the same reason and are the next two waiting to do it.
 *
 * THE ANSWER WAS ALREADY WRITTEN. `gaugeRiverPart()` exists precisely for this and says so:
 * "the place half is a minefield ... Tokenising the whole string would let a town or a road agree
 * with a basin. The river is the part in front, and that is the only part read." It was being
 * used for the basin match and not for this one. Now both.
 *
 * Extending the stop list with `park` was the other option and it is the wrong one: the next
 * name is `landing`, then `access`, then `point`, and the list is never finished. Reading only
 * the river half cannot be outrun by a new place name.
 *
 * THE ALERT'S OWN PLACE IS STILL READ IN FULL, deliberately. "Mountain Island Tailrace Fishing
 * Area" is filed under Lake WYLIE and names a different lake in its own title, so Mountain
 * Island Lake has to be able to find it there. That is the alert side; this is the water side.
 */
function wantedTokens(waterName, gaugeNames = []) {
  const want = new Set(distinctive(waterName));
  for (const n of gaugeNames || []) {
    for (const t of distinctive(gaugeRiverPart(n))) want.add(t);
  }
  return want;
}

/**
 * The alerts about this water.
 *
 * MATCHED ON THE PLACE, NOT THE BASIN. A basin-level notice is about a quarter of a state and
 * would sit on every water in it; those are handled by droughtNoticeFor, which extracts the one
 * sentence that explains a number the card is already showing. What comes back here is specific:
 * a ramp that is shut, a fishing area that is posted, a county that runs the park instead.
 *
 * `lakepondDesc` is the field that names the water — "Lake Wateree", "Lake Hickory", "Mountain
 * Island Lake" — and it matches the registry through the same whole-token test everything else
 * uses. The POI name is also read, because "Mountain Island Tailrace Fishing Area" is filed under
 * Lake WYLIE and names a different lake in its own title.
 */
export function alertsForWater(alerts, waterName, gaugeNames = []) {
  const want = wantedTokens(waterName, gaugeNames);
  if (!want.size) return [];
  // HOW MANY OF THIS WATER'S OWN WORDS THE TEXT CARRIES.
  const score = (v) => {
    let n = 0;
    for (const t of distinctive(v)) if (want.has(t)) n++;
    return n;
  };

  // A POI NAME NEEDS TWO WORDS; THE ALERT'S OWN WATER NEEDS ONE.
  //
  // Reading a place name against a token set over-matches on generic geography, and reading only
  // the river half of the gauge names does not save it: with `park` gone, Mountain Island Lake
  // picked up "Morrow Mountain State Park" -- Lake Tillery, Yadkin basin, a hundred km away -- on
  // the single word `mountain`. The next one is `creek`, then `island`, then `point`.
  //
  // `lakepondDesc` is Duke naming the water itself, so one word is evidence. A POI title is free
  // text about a place, so it takes two -- which is the same second-signal rule the gauge binder
  // and the picker both already use, and it is what keeps the case this function was built for:
  // "Mountain Island Tailrace Fishing Area and Mountain Island Park" is filed under Lake WYLIE
  // and still reaches Mountain Island Lake, because it names it twice.
  //
  // AN ALERT WITH NO WATER AT ALL falls back to one word on the place, because the place is then
  // the only thing it has. Three of the twenty-eight captured alerts are shaped that way.
  return (alerts || []).filter((a) => {
    if (!a || a.kind === 'RIVERBASIN') return false;
    const named = distinctive(a.water).size > 0;
    if (named && score(a.water) >= 1) return true;
    return score(a.place) >= (named ? 2 : 1);
  });
}

/**
 * Duke's location id for a water, out of the alert feed rather than out of a table.
 *
 * `lakepondDesc` names the lake and `lakepondLocationId` is the key /lakes/operating-range wants.
 * Both are already on the wire. Matched with the same whole-token test everything else uses, and
 * an ambiguous name returns nothing rather than the first id that looked close.
 */
export function dukeLocationIdFor(alerts, waterName, gaugeNames = []) {
  const want = wantedTokens(waterName, gaugeNames);
  if (!want.size) return null;
  const found = new Set();
  for (const a of alerts || []) {
    if (!a || a.water_location_id == null || !a.water) continue;
    for (const t of distinctive(a.water)) {
      if (want.has(t)) { found.add(a.water_location_id); break; }
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * THE GUIDE CURVE, THE DROUGHT STAGE AND FIVE YEARS OF THIS DATE.
 *
 * Everything in this payload is on Duke's 100-ft index, where 100 is full pond and one unit is
 * one foot — the same scale normalizeDukeRow decodes for the current level. So `average - target`
 * is feet above or below the guide curve directly, with no conversion, and the card can say it
 * the same way it already says TVA's.
 *
 * `droughtStage` IS THE LOW INFLOW PROTOCOL AS A NUMBER, and -1 IS NOT A STAGE. It means none
 * declared. Reading it as a level would put every lake in the country at "stage minus one", which
 * is the -999 family again: a sentinel in a field that otherwise holds a measurement.
 *
 * THE DATE IT CHANGED IS IN THE ROW BEFORE IT. The access-alerts endpoint says "the Catawba
 * Wateree River Basin entered Stage 2 on May 1, 2026" in a paragraph of HTML; the history says it
 * by changing from 1 to 2 between 2026-05-01 and 2026-05-02. Two sources, one fact, and now they
 * can be checked against each other.
 */
export function parseOperatingRange(json, nowIso = null) {
  if (!json) return null;
  const rows = (json.history || [])
    .map((r) => ({
      date: String(r.date || '').slice(0, 10),
      level: numOrNull(r.average),
      target: numOrNull(r.target),
      min: numOrNull(r.min),
      max: numOrNull(r.max),
      // -1 is "no drought declared", not stage minus one.
      stage: Number.isFinite(Number(r.droughtStage)) && Number(r.droughtStage) >= 0
        ? Number(r.droughtStage) : null,
      stage_raw: Number.isFinite(Number(r.droughtStage)) ? Number(r.droughtStage) : null,
    }))
    .filter((r) => r.date);
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!rows.length) return null;

  const last = rows[rows.length - 1];
  // When the current stage began: walk back while the raw value is unchanged.
  let since = last.date;
  for (let i = rows.length - 1; i > 0; i -= 1) {
    if (rows[i - 1].stage_raw !== last.stage_raw) break;
    since = rows[i - 1].date;
  }

  const monthly = (json.operatingRange || [])
    .map((r) => ({ month: Number(r.Month ?? r.month), day: Number(r.Day ?? r.day),
                   min: numOrNull(r.Min ?? r.min), max: numOrNull(r.Max ?? r.max),
                   target: numOrNull(r.Target ?? r.target) }))
    .filter((r) => Number.isFinite(r.month));
  monthly.sort((a, b) => a.month - b.month);

  const forecast = (json.forecast || [])
    .map((r) => ({ date: String(r.date || '').slice(0, 10), min: numOrNull(r.min),
                   max: numOrNull(r.max), target: numOrNull(r.target) }))
    .filter((r) => r.date);

  const lake = (json.lakeDetails || {});
  // "225.5 ft (AMSL, NGVD 29 datum" — the parenthesis is never closed in the live payload. The
  // number is taken with a regex for that reason, not for tidiness.
  const fullPondFt = (() => {
    const m = String(lake.Elevation || '').match(/([0-9]+(?:\.[0-9]+)?)/);
    return m ? Number(m[1]) : null;
  })();

  return {
    name: lake.LakeName || null,
    full_pond_ft: fullPondFt,
    last_updated: lake.lastUpdated || null,
    today: last,
    // FEET ABOVE OR BELOW DUKE'S OWN GUIDE CURVE. The index is a hundred-foot band under full
    // pond, so this subtraction is already in feet.
    vs_target_ft: (last.level != null && last.target != null)
      ? Math.round((last.level - last.target) * 100) / 100 : null,
    drought_stage: last.stage,
    drought_since: last.stage == null ? null : since,
    monthly,
    forecast,
    days: rows.length,
    first_date: rows[0].date,
  };
}

/** Number, but an empty string and a null are absence rather than zero. Eighth time this week. */
function numOrNull(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * WHERE TODAY SITS AGAINST THE SAME DAY IN EVERY OTHER YEAR.
 *
 * "97.9" means nothing on its own and neither does "2.1 ft below full pond": Wateree runs a
 * three-foot summer band and spends most of August within a foot of target. The question worth
 * answering is the one USGS daily statistics answer for flow — is this normal for the seventeenth
 * of August on THIS lake — and five years of daily history is enough to say it as a rank rather
 * than as an invented percentile.
 *
 * A WINDOW, NOT AN EXACT DATE. One reading per year is four other numbers; a plus-or-minus three
 * day window around the same calendar date gives about thirty-five, which is enough to place a
 * value without pretending to a distribution.
 */
export function levelVsSameDate(json, isoDate, windowDays = 3) {
  const rows = (json && json.history) || [];
  const d = String(isoDate || '').slice(0, 10);
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || !rows.length) return null;
  const target = new Date(Date.UTC(2000, Number(m[2]) - 1, Number(m[3])));

  const sameWindow = [];
  let todayLevel = null;
  for (const r of rows) {
    const rd = String(r.date || '').slice(0, 10);
    const rm = rd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!rm) continue;
    const lvl = numOrNull(r.average);
    if (lvl == null) continue;
    if (rd === d) { todayLevel = lvl; continue; }
    const day = new Date(Date.UTC(2000, Number(rm[2]) - 1, Number(rm[3])));
    let diff = Math.abs(day - target) / 86400000;
    if (diff > 182) diff = 365 - diff;               // the window wraps the new year
    if (diff <= windowDays) sameWindow.push({ year: rm[1], level: lvl });
  }
  if (todayLevel == null || sameWindow.length < 5) return null;

  const below = sameWindow.filter((x) => x.level < todayLevel).length;
  const years = [...new Set(sameWindow.map((x) => x.year))].sort();
  return {
    level: todayLevel,
    n: sameWindow.length,
    years: years.length,
    from: years[0] || null,
    to: years[years.length - 1] || null,
    // A RANK, NOT A PERCENTILE. Thirty-five readings do not support a percentile and saying one
    // would be inventing precision, which is the objection this app already raises to
    // interpolated flow percentiles.
    higher_than: below,
    window_days: windowDays,
    band: below >= sameWindow.length * 0.9 ? 'higher than almost every other year'
        : below >= sameWindow.length * 0.66 ? 'on the high side'
        : below <= sameWindow.length * 0.1 ? 'lower than almost every other year'
        : below <= sameWindow.length * 0.34 ? 'on the low side'
        : 'about normal',
  };
}

/**
 * KEEP THE ALERTS, BECAUSE THE FEED IS A SNAPSHOT AND THE EFFECT OUTLIVES THE EXPLANATION.
 *
 * Ryan, 2026-08-17, on the card reporting Lake Wateree higher than 24 of 30 readings for this
 * week while the basin sits in Stage 2 drought:
 *
 *   *"i can tell you why it is high... and if we were reading their alert messages last week you
 *    would know too... they had to bring it to 99ft to float a barge that is working near the dam
 *    which is why buckhill landing is closed"*
 *
 * That notice is NOT in today's `/access-alerts`. What survives is the consequence — "Buck Hill
 * Access Area will close on March 2, 2026 for approximately one year due to construction work at
 * the Wateree hydro facility" — with the reason for the level gone. The lake is still high. The
 * sentence explaining it has rotated out.
 *
 * SO THE STATISTIC OUTLIVED ITS CAUSE, and a rank that reads "higher than almost every other year"
 * invites exactly one inference — that it has been wet — when the actual answer is a barge. This
 * app has spent a week on numbers that render as facts about the world when they are facts about
 * a field; this is a number that renders as a fact about the weather when it is a fact about an
 * operating decision.
 *
 * There is nothing clever to do about that except STOP THROWING THE NOTICES AWAY. One object per
 * day, written the first time an isolate reads the feed on a date it has not seen. It costs one
 * HEAD and, once a day, one PUT. From today forward an explanation posted in March is still
 * readable in August.
 *
 * A FAILED WRITE IS NOT A FAILED READ. The archive is a convenience; the live feed is the answer.
 * Nothing here may make /conditions fail.
 */
export const ALERT_ARCHIVE_PREFIX = '_duke/access_alerts/';

export async function archiveAlerts(env, alerts, isoDate) {
  const bucket = env && env.R2_TROLLMAP_CHARTPACKS;
  const day = String(isoDate || '').slice(0, 10);
  if (!bucket || !day || !Array.isArray(alerts) || !alerts.length) return false;
  const key = `${ALERT_ARCHIVE_PREFIX}${day}.json`;
  try {
    if (await bucket.head(key)) return false;          // already have today
    await bucket.put(key, JSON.stringify({ captured: day, alerts }), {
      httpMetadata: { contentType: 'application/json' },
    });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Alerts about this water that Duke has since taken down.
 *
 * An expired notice is not a live one and must never read as one — it is labelled with the date
 * it was captured and the date it was last seen, and it is offered as HISTORY. Its whole value is
 * that it may be the reason for a number the card is showing today.
 *
 * Read newest-first and stopped at `limit` objects, because the point is the recent past. An
 * archive that has to be read whole to answer a question is one nobody will keep reading.
 */
export async function expiredAlertsFor(env, liveAlerts, waterName, gaugeNames = [], limit = 45) {
  const bucket = env && env.R2_TROLLMAP_CHARTPACKS;
  if (!bucket) return [];
  const liveIds = new Set((liveAlerts || []).map((a) => a.id).filter((v) => v != null));
  let listed;
  try {
    listed = await bucket.list({ prefix: ALERT_ARCHIVE_PREFIX, limit: 400 });
  } catch (_) {
    return [];
  }
  const keys = (listed && listed.objects ? listed.objects : [])
    .map((o) => o.key).sort().reverse().slice(0, limit);

  const seen = new Set();
  const out = [];
  for (const key of keys) {
    let snap;
    try {
      const obj = await bucket.get(key);
      if (!obj) continue;
      snap = JSON.parse(await r2Text(obj));
    } catch (_) { continue; }
    for (const a of alertsForWater(snap && snap.alerts, waterName, gaugeNames)) {
      if (a.id == null || liveIds.has(a.id) || seen.has(a.id)) continue;
      seen.add(a.id);
      out.push({ ...a, no_longer_posted: true, last_seen: (snap && snap.captured) || null });
    }
  }
  return out;
}

/**
 * THE DRAWDOWN SCHEDULE, FROM THE API INSTEAD OF OUT OF A PDF.
 *
 * Ryan, 2026-08-17: *"so the operating range should show the operating range for every duke lake
 * right... so for draw down schedule research should point at that api instead of scraping the
 * webpages that it has been doing for duke"*. Yes, and the research prompt says so itself:
 *
 *   "DUKE ENERGY CRA POOL LEVEL TABLE — IF PRESENT IN DOCUMENTS: The CRA agreement PDF has a
 *    table: Month(s) | Guide Curve (target ft) | Minimum ft | Maximum ft (local datum, typically
 *    93-100 range). Extract into poolManagement... Set drawdownType 'scheduled' and normalPoolFt
 *    to the Maximum column value."
 *
 * That is a description of `operatingRange`, which this endpoint returns as JSON for every Duke
 * lake that has a location id. The pipeline has been paying an LLM to read it out of a PDF, on
 * the lakes where the PDF was found at all.
 *
 * AND THE PROMPT HAS A DATUM BUG IN IT. "normalPoolFt to the Maximum column value" gives 100 on a
 * Duke lake — the top of the index — when normalPoolFt is meant to be feet NGVD/NAVD. Wateree's
 * full pond is 225.5. The prompt even half-notices, allowing "2-digit numbers representing local
 * datum (e.g. 97 for Duke Energy lakes)", which means the field has been holding two different
 * quantities depending on which document a run happened to read.
 *
 * `lakeDetails.Elevation` settles it: full pond in feet AMSL, on the same object as the index. So
 * both are published here, each labelled, and neither has to be guessed:
 *
 *     amsl = fullPondFt - (100 - index)
 */
export function dukePoolManagement(opRange) {
  const g = parseOperatingRange(opRange);
  if (!g || !g.monthly.length) return null;
  const full = g.full_pond_ft;
  const toAmsl = (v) => (full != null && v != null ? Math.round((full - (100 - v)) * 100) / 100 : null);
  const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const byMonth = g.monthly.map((m) => ({
    month: m.month,
    monthName: MONTHS[m.month] || String(m.month),
    targetIndex: m.target, minIndex: m.min, maxIndex: m.max,
    targetFt: toAmsl(m.target), minFt: toAmsl(m.min), maxFt: toAmsl(m.max),
  }));

  // The drawdown is the swing in the TARGET across the year. A lake Duke holds flat all year has
  // no seasonal drawdown, and saying "0 ft" is the honest answer rather than omitting the field.
  const targets = byMonth.map((m) => m.targetIndex).filter((v) => v != null);
  const swing = targets.length ? Math.round((Math.max(...targets) - Math.min(...targets)) * 100) / 100 : null;

  return {
    // NOT the Maximum column. That is 100, the top of the index, and it is not an elevation.
    normalPoolFt: full,
    normalPoolDatum: 'ft AMSL, NGVD 29, from lakeDetails.Elevation',
    fullPondIndex: 100,
    drawdownType: swing != null && swing > 0 ? 'scheduled' : (swing === 0 ? 'none' : null),
    seasonalDrawdownFt: swing,
    poolManagement: {
      scale: 'Duke local index — 100 is full pond, one unit is one foot',
      byMonth,
      // What it is doing today, which the PDF could never say.
      todayIndex: g.today ? g.today.level : null,
      todayTargetIndex: g.today ? g.today.target : null,
      droughtStage: g.drought_stage,
      droughtSince: g.drought_since,
    },
    source: 'https://api.hydro-derived.duke-energy.app/lakes/operating-range',
  };
}

/** The dams a schedule actually carries, for a refusal that names them. */
export function arrivalDams(sched) {
  const out = [];
  for (const a of (sched && sched.arrivals) || []) {
    if (a && a.damName && !out.includes(a.damName)) out.push(a.damName);
  }
  return out;
}

/**
 * DOES THE SCHEDULE THAT CAME BACK ACTUALLY NAME THIS WATER'S RIVER?
 *
 * Still a verifier, and still worth having now that the id is resolved rather than typed: Duke
 * can renumber a basin, and a release projection on the wrong river is worse than none. What
 * changed is what counts as agreement. It used to compare the basin name against the LAKE name
 * only, which is the wrong kind of name — a basin names a river system and a lake is a water on
 * it. Now the water's evidence includes the rivers its bound gauges are named for.
 */
export function dukeBasinAgrees(sched, waterName, gaugeNames = []) {
  const want = waterBasinEvidence(waterName, gaugeNames);
  if (!want.size || !sched) return false;
  if (BASIN_CATCH_ALL.test(String(sched.basinName || '').trim())) return false;
  const haystacks = [sched.basinName, sched.basinDescription];
  for (const a of sched.arrivals || []) haystacks.push(a.damName, a.mileMarkerName);
  for (const h of haystacks) {
    for (const t of distinctive(h)) if (want.has(t)) return true;
  }
  return false;
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
/** A binding's parameter list, whichever key and shape it was written in. */
function parmList(g) {
  const raw = (g && (g.usgs_parms || g.parms)) || null;
  const arr = Array.isArray(raw) ? raw
    : (typeof raw === 'string' ? raw.split(',') : []);
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

// Level and flow. A binding carrying ONLY these is indistinguishable from one written by the
// old builder, which narrowed every site to exactly this set -- so it is treated as "unknown"
// rather than as "publishes nothing else". See registryCatalog().
const LEVEL_ONLY = new Set(['00060', '00065', '00062', '62614', '62615']);

/**
 * The registry's own answer to "what does this site publish", or null if it cannot be trusted.
 *
 * TRUSTED ONLY WHEN IT NAMES SOMETHING OUTSIDE LEVEL AND FLOW. Bindings written before
 * 2026-08-25 hold `00060,00065` and nothing more, because the builder intersected the catalogue
 * away before writing. Believing such a list would have `waterProbe` conclude that no site on
 * any water publishes 00010 and skip every temperature request -- turning a stale registry into
 * a silent, total loss of water temperature. A list that names 00010, 00300, 63680 or anything
 * else outside the level set can only have come from the new builder, so it is believed.
 *
 * The cost of being wrong in the safe direction is one HTTP request. The cost of being wrong in
 * the other direction is every reading on the strip going blank with no error.
 */
export function registryCatalog(parms) {
  const list = Array.isArray(parms) ? parms.filter(Boolean) : [];
  if (!list.length) return null;
  if (!list.some((c) => !LEVEL_ONLY.has(c))) return null;
  const out = {};
  for (const c of list) out[c] = { from: 'water_bindings.json' };
  return out;
}

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
      // WHAT THE REGISTRY ALREADY KNOWS THIS SITE PUBLISHES. `build_water_bindings.py` fetches
      // the full series catalogue for every site; until 2026-08-25 it intersected the answer
      // down to level and flow one line before writing, so the Worker re-fetched a catalogue
      // per site at runtime to relearn it. Carried here so `waterProbe` can skip that request.
      parms: parmList(g),
    });
  };
  add(b.pool, 'pool');
  add(b.tailwater, 'tailwater');
  for (const g of b.gauges || []) add(g, 'gauge');
  // Nearest first, but a site on the lake itself beats a nearer one below the dam.
  return out.sort((x, y) => (x.below_dam - y.below_dam) || (x.km - y.km));
}

/**
 * WHICH PARAMETERS A SITE ACTUALLY PUBLISHES, instead of asking for twelve and seeing what
 * comes back.
 *
 * `seriesCatalogOutput=true&outputDataTypeCd=iv` returns one row per published series with its
 * parameter code, period of record and observation count. Verified 2026-08-16 against 02147801,
 * the Wateree tailrace: 00010, 00060, 00065, 00300 and 63160 — exactly the five found by
 * experiment this morning, and it also says 63160 only began on 2025-10-01.
 *
 * WHAT THIS IS FOR IS EXPLAINING A NULL. Until now "no water temperature on this lake" and "the
 * temperature request failed" were the same silence. With the catalog the response can say that
 * NO site bound to this water publishes 00010, which is a registry gap somebody can close, not
 * a mystery. This codebase's own words: a gap that is visible is a gap that can be closed.
 *
 * It also stops the probe walking sites that were never going to answer.
 *
 * Parsed by header name for the same reason the daily-statistics parser is: `loc_web_ds` and
 * `stat_cd` are empty on this site and counting columns drifts the moment they are not.
 */
export function parseSiteCatalog(rdb) {
  const lines = String(rdb || '').split('\n').filter((l) => l && !l.startsWith('#'));
  if (lines.length < 3) return null;
  const head = lines[0].split('\t');
  const iP = head.indexOf('parm_cd');
  const iB = head.indexOf('begin_date');
  const iE = head.indexOf('end_date');
  const iN = head.indexOf('count_nu');
  if (iP < 0) return null;
  const out = {};
  for (const line of lines.slice(2)) {
    const f = line.split('\t');
    const code = (f[iP] || '').trim();
    if (!code) continue;
    const n = Number((f[iN] || '').trim());
    out[code] = {
      begin: (f[iB] || '').trim() || null,
      end: (f[iE] || '').trim() || null,
      // Number('') is 0 and isFinite(0) is true. An empty count is not a count of zero.
      count: (f[iN] || '').trim() && Number.isFinite(n) ? n : null,
    };
  }
  return Object.keys(out).length ? out : null;
}

async function siteParameters(site) {
  if (!site) return null;
  // A site's published series change on the order of years, not minutes.
  return cached(`cat:${site}`, 24 * 3600, async () => parseSiteCatalog(await getText(
    'https://waterservices.usgs.gov/nwis/site/?format=rdb&seriesCatalogOutput=true'
    + `&outputDataTypeCd=iv&sites=${encodeURIComponent(site)}`)));
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
                oxygen: null, turbidity: null, salt: null, tidalFlow: null,
                // What no bound site publishes at all, so a null can say WHY.
                unpublished: [],
                // What a bound site DOES publish and did not answer with. The third state.
                silent: [], catalogued: 0 };
  const WANT = { '00010': 'water temperature', '00300': 'dissolved oxygen',
                 '63680': 'turbidity', '00095': 'specific conductance',
                 '00480': 'salinity', '72137': 'tidally filtered discharge' };
  const published = new Set();
  // code -> the site that publishes it, so a field that ends up empty can name where to look.
  const cataloguedBy = new Map();
  // Sites that were asked and came back with NOTHING -- no series at all, whether the request
  // failed or the site answered empty. "The whole gauge is quiet" and "the gauge is reporting
  // and this one sensor is not" are different problems and only one of them is worth a drive.
  // fetchUsgs swallows its own transport errors and returns {}, so a throw is not the test.
  const siteSilent = new Set();
  for (const s of usgsSitesFor(b, lat, lon).slice(0, 4)) {
    if (out.temp && out.oxygen && out.turbidity && out.salt && out.tidalFlow) break;

    // Ask the catalog first. A site that publishes none of what is still missing is not worth a
    // request, and knowing that is also what lets the response explain an empty field.
    // The registry first; the network only when the registry cannot answer.
    let cat = registryCatalog(s.parms);
    if (!cat) {
      try { cat = await siteParameters(s.site); } catch (_) { cat = null; }
    }
    if (cat) {
      out.catalogued += 1;
      for (const code of Object.keys(cat)) {
        published.add(code);
        if (!WANT[code]) continue;
        // NEWEST PERIOD OF RECORD WINS. If two bound sites both publish 00010 and one of them
        // stopped in 2019, the live one is the one worth sending somebody to look at.
        const prev = cataloguedBy.get(code);
        const end = (cat[code] && cat[code].end) || null;
        if (!prev || (end && (!prev.last || end > prev.last))) {
          cataloguedBy.set(code, { usgs_site: s.site, name: s.name, last: end,
                                   count: (cat[code] && cat[code].count) || null });
        }
      }
      const stillWanted = [
        !out.temp && '00010', !out.oxygen && '00300', !out.turbidity && '63680',
        !out.salt && '00480', !out.salt && '00095', !out.tidalFlow && '72137',
      ].filter(Boolean);
      if (!stillWanted.some((code) => cat[code])) continue;
    }

    let u = null;
    try { u = await cached(`usgs:${s.site}`, TTL.gauge, () => fetchUsgs(s.site, USGS_PARMS)); }
    catch (_) { siteSilent.add(s.site); continue; }
    if (!u) { siteSilent.add(s.site); continue; }
    // `timestamp` is bookkeeping, not a reading: a response carrying only that is still a
    // gauge that told us nothing.
    if (!Object.keys(u).some((k) => k !== 'timestamp' && u[k] != null)) siteSilent.add(s.site);
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
  // Only claimed where a catalogue was actually read. Without one, silence about a field means
  // "not fetched", and saying "nobody publishes it" would be a stronger claim than we hold.
  if (out.catalogued) {
    out.unpublished = Object.entries(WANT)
      .filter(([code]) => !published.has(code))
      .map(([code, label]) => ({ code, label }));
    // THE THIRD STATE, AND UNTIL NOW IT RENDERED AS NOTHING AT ALL.
    //
    // A field can be empty for three reasons and the response could only tell two of them
    // apart. `unpublished` says no bound site measures this -- a registry gap. A value says
    // it was measured. The gap between them is a site that DOES publish the parameter and
    // returned no number, and that is neither: it is a live gauge to go look at.
    //
    // Not hypothetical. The Lower Saluda card on 2026-08-25 showed no water temperature and no
    // reason, because three bound sites catalogue 00010 -- which put it in `published` and so
    // excluded it from "Not published" -- and none of them answered with one. Meanwhile site
    // 02168504 below the Murray dam was carrying 14.0 degC, last written 2026-08-22.
    //
    // NOTHING HERE IS GUESSED. `last` is the period of record USGS publishes for that exact
    // series, and it is null when the catalogue came from the registry, which does not record
    // one. A null `last` says we do not know, not that the series is dead.
    const FIELD = { '00010': 'temp', '00300': 'oxygen', '63680': 'turbidity',
                    '00095': 'salt', '00480': 'salt', '72137': 'tidalFlow' };
    out.silent = Object.entries(WANT)
      .filter(([code]) => !out[FIELD[code]] && cataloguedBy.has(code))
      .map(([code, label]) => {
        const at = cataloguedBy.get(code);
        return { code, label, ...at,
                 reason: siteSilent.has(at.usgs_site) ? 'site_silent' : 'no_reading' };
      });
  }
  return out;
}

/**
 * A CWMS time series as points, in the unit CWMS SAYS IT SENT.
 *
 * Read live 2026-08-16 for Hartwell.Elev-Pool.Inst.1Hour.0.Raw-SHEF_SAS:
 *
 *   { "name", "office-id", "units": "ft", "time-zone": "US/Central", "total": 0,
 *     "value-columns": [ {"name":"date-time","ordinal":1}, {"name":"value","ordinal":2},
 *                        {"name":"quality-code","ordinal":3} ],
 *     "values": [] }
 *
 * THE UNIT IS ON THE RESPONSE, NOT THE CATALOG, AND THEY DISAGREE. The catalogue entry for this
 * exact series declares `"units": "m"` — that is the STORAGE unit — while the data endpoint
 * returns `"units": "ft"`. Converting on the catalogue's metres would have turned 660 ft into
 * 2,165 ft. The trap has a mirror: reading the catalogue and assuming feet would have shown a
 * lake at 201. Neither guess is safe, so nothing is guessed — `cwmsToFeet` is handed the unit
 * that arrived beside the numbers.
 *
 * COLUMNS ARE LOCATED BY NAME. `value-columns` exists precisely so the row layout can change,
 * and reading rows by ordinal would break silently the day it does. Same discipline as the USGS
 * RDB parsers, which needed it for `loc_web_ds`.
 *
 * QUALITY CODES ARE CARRIED, NOT INTERPRETED. CWMS packs screening, validity and replacement
 * into bit fields, and this codebase has no reference for them. Passing the integer through is
 * honest; inventing a meaning for it is what `anomaly_category` is deliberately not doing.
 */
export function parseCwmsTimeseries(j) {
  if (!j || typeof j !== 'object') return null;
  const cols = Array.isArray(j['value-columns']) ? j['value-columns'] : [];
  const at = (name) => {
    const i = cols.findIndex((c) => c && c.name === name);
    return i < 0 ? null : i;
  };
  const iT = at('date-time'), iV = at('value'), iQ = at('quality-code');
  if (iT === null || iV === null) return null;

  const rows = Array.isArray(j.values) ? j.values : [];
  const points = [];
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const raw = r[iT];
    // java.sql.Timestamp reaches JSON as epoch milliseconds on this API, but an ISO string is
    // just as unambiguous and costs one branch to accept.
    const t = typeof raw === 'number' ? raw : Date.parse(String(raw));
    const v = Number(r[iV]);
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    points.push({ t, v, quality: iQ === null ? null : r[iQ] });
  }
  points.sort((a, b) => a.t - b.t);
  const last = points.length ? points[points.length - 1] : null;
  return {
    name: j.name || null,
    office: j['office-id'] || null,
    units: j.units || null,
    time_zone: j['time-zone'] || null,
    points: points.length,
    latest: last ? { at: new Date(last.t).toISOString(), value: last.v, quality: last.quality } : null,
    // `total: 0` with an empty `values` is a real answer: the series exists and has nothing in
    // the window asked for. Distinct from a failed request, and it is how we learned this SHEF
    // series runs about two days behind.
    empty_window: rows.length === 0,
  };
}

/** The latest Corps reading as feet, with its age, or null. */
export function cwmsLevel(parsed, nowMs, maxAgeHours = 48) {
  if (!parsed || !parsed.latest) return null;
  const ft = cwmsToFeet(parsed.latest.value, parsed.units);
  if (ft === null) return null;
  const ageH = Number.isFinite(nowMs)
    ? Math.round(((nowMs - Date.parse(parsed.latest.at)) / 3600000) * 10) / 10 : null;
  return {
    elevation_ft: ft,
    observed_at: parsed.latest.at,
    age_hours: ageH,
    // Reported, not hidden — the Charleston barometer taught this. A caller that is never told
    // a reading is two days old cannot decide whether to use it.
    stale: ageH != null && ageH > maxAgeHours,
    units_reported: parsed.units,
    series: parsed.name,
    office: parsed.office,
    quality_code: parsed.latest.quality,
    source: 'USACE CWMS — /cwms-data/timeseries',
  };
}

/**
 * PICKING THE CORPS' POOL ELEVATION SERIES OUT OF FORTY-TWO CANDIDATES.
 *
 * `/cwms-data/catalog/TIMESERIES?office=SAS&like=^Hartwell\.Elev` returns 42 entries for one
 * lake. Read live 2026-08-16. Only one of them is "how high is the water":
 *
 *   Hartwell.Elev-Pool.Inst.1Hour.0.Raw-SHEF_SAS        <- the reading
 *   Hartwell.Elev-GC / Elev-Guide-Curve / Elev-Head     <- guide curve and head, not the pool
 *   Hartwell.Elev-L1 / L2 / L3, Elev-Level1..3          <- drought levels, already read elsewhere
 *   Hartwell.Elev-Pool_Avg / _Max / _Min / _p02.._p40   <- STATISTICS over the record
 *
 * `Elev-Pool_p10` is a tenth-percentile statistic and `Elev-Pool` is today's water, and they
 * differ by one underscore. The match is anchored on `.Elev-Pool.` with the trailing dot for
 * exactly that reason.
 *
 * UNITS ARE METRES AND THAT IS THE TRAP. Every entry carries `"units": "m"`. Hartwell's full
 * pool is 660 FEET, which is 201.2 m. Reading the number without converting would put Hartwell
 * forty feet below its own bottom of conservation — a catastrophic drawdown rendered on a lake
 * sitting at normal pool. The conversion is explicit, gated on the declared unit, and anything
 * that is neither m nor ft is REFUSED rather than assumed.
 *
 * THE ID IS DISCOVERED, NEVER HARDCODED. The version suffix is district-specific — Savannah
 * writes `Raw-SHEF_SAS` and `HISTORIAN_SAS` — so a name that works for Hartwell says nothing
 * about Jordan Lake in Wilmington. That is the `dukeBasinId` lesson: a foreign key that nobody
 * checked, sitting in a table, being wrong quietly.
 */
export function pickElevSeries(catalog) {
  return pickCwmsSeries(catalog, /\.Elev-Pool\./i);
}

/**
 * The same choice, for any parameter. `want` is matched against the whole ts-id.
 *
 * Generalised out of pickElevSeries on 2026-08-25 so the release series can use the identical
 * ranking. A Corps project publishes Flow-In, Flow-Out, Flow-Power and Flow-Spill alongside its
 * pool, in the same shapes and with the same HISTORIAN copies four months behind the live ones,
 * so a second implementation would be a second chance to pick the dead one.
 *
 * THE TRAILING DOT IN THE CALLER'S PATTERN IS LOAD-BEARING. `Elev-Pool_p10` is a tenth-percentile
 * statistic and `Elev-Pool` is today's water; they differ by one underscore.
 */
export function pickCwmsSeries(catalog, want) {
  const entries = (catalog && Array.isArray(catalog.entries)) ? catalog.entries : [];
  const pool = entries.filter((e) => want.test(String(e && e.name || '')));
  if (!pool.length) return null;

  const rank = (e) => {
    const iv = String(e.interval || '');
    // An irregular interval (~1Day) is not a reading cadence; a real one is. Shorter is better.
    if (/^~/.test(iv)) return 0;
    if (/^\d+Minute/i.test(iv)) return 4;
    if (/^\d+Hour/i.test(iv)) return 3;
    if (/^\d+Day/i.test(iv)) return 2;
    return 1;
  };
  const latestOf = (e) => {
    const ex = Array.isArray(e.extents) ? e.extents : [];
    let best = 0;
    for (const x of ex) {
      const t = Date.parse(x && x['latest-time']);
      if (Number.isFinite(t) && t > best) best = t;
    }
    return best;
  };

  let best = null;
  for (const e of pool) {
    const cand = { entry: e, rank: rank(e), latest: latestOf(e) };
    if (!best
        || cand.rank > best.rank
        || (cand.rank === best.rank && cand.latest > best.latest)) best = cand;
  }
  if (!best) return null;
  const e = best.entry;
  return {
    name: e.name,
    office: e.office || null,
    units: e.units || null,
    interval: e.interval || null,
    latest_time: best.latest ? new Date(best.latest).toISOString() : null,
    time_zone: e['time-zone'] || null,
    candidates: pool.length,
    of_total: Number.isFinite(catalog.total) ? catalog.total : entries.length,
  };
}

/**
 * THE CORPS' POOL ELEVATION, FETCHED.
 *
 * `pickElevSeries`, `parseCwmsTimeseries` and `cwmsLevel` were written on 2026-08-16, tested
 * against a real 42-entry catalogue, and NEVER CALLED. Nothing in this repo fetched a CWMS
 * catalogue. Meanwhile `worker-data.js` carried a second CWMS reader that WAS wired, and it
 * asked for a series that does not exist:
 *
 *   it asked for   Hartwell.Elev.Inst.0.0.USACE-RAW      office=SA    unit=ft
 *   SAS publishes  Hartwell.Elev-Pool.Inst.1Hour.0.Raw-SHEF_SAS   office=SAS   units=m
 *
 * Wrong parameter (Elev vs Elev-Pool), wrong interval (0 vs 1Hour), wrong version (USACE-RAW
 * vs Raw-SHEF_SAS), wrong office (SA is the division, SAS is the district), and it asked for
 * feet from a service that publishes metres. Four ways wrong, one of them silently dangerous.
 * Verified 2026-08-25 against registry/_cwms_inventory.json, which holds all 3,328 catalogued
 * series for these districts: Hartwell 84, Russell 104, Thurmond 82, on the PROJECT locations
 * the site-number join never reached.
 *
 * Two implementations of one thing, one right and dead, one wired and wrong. This connects the
 * right one and the wrong one is deleted.
 *
 * THE `like` PATTERN IS UPPERCASE ON PURPOSE. CWMS matches it as a regex against the ts-id
 * AFTER upper-casing the id — proven in this session by base64-decoding the pagination cursor,
 * which carries the pattern verbatim. An upper-case pattern matches whether or not the
 * comparison itself is case-sensitive; `^Hartwell\.` gambles on it not being.
 */
/**
 * THE CORPS' RELEASE, WHICH DUKE LAKES AND TVA LAKES HAVE HAD AND CORPS LAKES HAVE NOT.
 *
 * Ryan, 2026-08-25: *"any data that is available for any and all lakes should be available for
 * any and all lakes"*.
 *
 * `releaseShape` has answered for Duke (flow arrivals, then the run schedule) and for TVA
 * (generation-releases) since those were wired. A Corps lake got nothing — not because the Corps
 * publishes nothing, but because nothing here asked. Savannah District publishes Flow-Out,
 * Flow-Power, Flow-Spill and Flow-In hourly on every project, alongside Elev-Tail, and the
 * inventory of 3,328 catalogued series shows the same shape on Russell and Thurmond.
 *
 * THE PROJECT NAME IS NOT TYPED ANYWHERE. It arrives as `out.usace.project`, which `usaceLevels`
 * already derived by intersecting the binding's own `usace[].cwms_name` list with the district's
 * published roster of conservation pools. A new Corps lake added to the registry tomorrow gets
 * this with nothing here to edit, which is the whole point.
 *
 * NO `unit=` PARAMETER, AND THE CATALOGUE'S UNIT IS NOT THE DATA'S UNIT. Verified against the
 * live service 2026-08-25, both calls, same series:
 *
 *   catalog/TIMESERIES   Hartwell.Elev-Pool.Inst.1Hour.0.Raw-SHEF_SAS   "units": "m"
 *   timeseries           the same name                                  "units": "ft"
 *
 * One service, two answers, and only the second one is beside the numbers. Whatever unit arrives
 * with the values is the unit the converter is handed, and an unrecognised one is refused.
 *
 * THE `like` PATTERN IS UPPERCASE ON PURPOSE. CWMS matches it as a regex against the ts-id AFTER
 * upper-casing the id — proven by base64-decoding the pagination cursor, which carries the
 * pattern verbatim — so `^Hartwell\\.` gambles on a case-sensitivity that is not there.
 */
const CWMS_FLOW_SERIES = [
  ['outflow', /\.Flow-Out\./i, 'total release'],
  ['through_turbines', /\.Flow-Power\./i, 'generation'],
  ['spill', /\.Flow-Spill\./i, 'spillway'],
  ['inflow', /\.Flow-In\./i, 'inflow'],
];

/**
 * THE UNIT SPELLINGS ARE THE CORPS', NOT OURS.
 *
 * Both converters below used to carry a hand-typed handful of spellings. `/cwms-data/units`
 * publishes the whole table -- 424 rows, each with its `abstract-parameter`, its `unit-system`
 * and its registered `alternate-names` -- and fetched on 2026-08-25 it says the hand-typed lists
 * were wrong in both directions:
 *
 *   MISSING, and every one of them is a REGISTERED spelling of a unit we already accept:
 *       foot                            (we had ft, feet)
 *       meter, metre                    (we had m, meters, metres)
 *       ft3/sec, cu-ft/sec, cuft/sec, cusecs      (we had cfs, ft3/s)
 *       m3/sec, cu-meters/sec                     (we had cms, m3/s)
 *
 *   INVENTED: `ft^3/s` is in the Corps' table, `m^3/s` is NOT. We made it up and it has never
 *       matched anything.
 *
 *   AND THE LANDMINE: `kcfs` is a registered unit -- "Kilo-cubic feet per second", aliases
 *       `1000 cfs`, `1000 cu-ft/sec`, `1000 ft3/sec`. This app has already been bitten once by
 *       kcfs arriving in a field that assumed cfs: the Congaree at roughly 4,000 cfs rendered
 *       as "4 ft3/s" and was then compared against USGS percentiles in real cfs. Here it
 *       currently returns null, which is the safe half of wrong -- an absence rather than a
 *       thousandfold error -- but it is an absence nobody can see.
 *
 * AN UNRECOGNISED UNIT AND A DECLINED ONE ARE DIFFERENT FACTS. Miles and inches are registered
 * Lengths and are never an elevation; gallons per minute is a registered Volume Rate and is
 * never a dam release. Those are DECLINED on purpose. Anything not in either list is UNKNOWN,
 * and `cwmsUnitKind` says which -- so the tests can assert that the Corps' own published table
 * contains zero units this file has no opinion about.
 *
 * Every alias below is transcribed from that fetch, lower-cased. Nothing here is invented.
 */
const CWMS_UNIT_TABLE = [
  // Length, and plausible as an elevation. Factor converts TO international feet.
  [['ft', 'feet', 'foot'], 'length', 1],
  // Survey feet differ from international feet by 2 parts per million -- 0.0013 ft at a 660 ft
  // full pool. Accepted, because refusing an elevation over two thousandths of a foot would be
  // an absence bought with nothing.
  [['ftus', 'survey feet', 'survey foot'], 'length', 1.000002],
  [['m', 'meter', 'metre', 'meters', 'metres'], 'length', 3.280839895],

  // Volume Rate, and plausible as a release. Factor converts TO ft3/s.
  [['cfs', 'cu-ft/sec', 'cuft/sec', 'cusecs', 'ft3/s', 'ft3/sec', 'ft^3/s'], 'flow', 1],
  // `m^3/s` is NOT in the Corps' table. It was in ours, so it stays: dropping a spelling this
  // file already accepted would be a silent narrowing, and a narrowing shows up as an absence.
  // Registered or not, it can only ever mean cubic metres per second.
  [['cms', 'cu-meters/sec', 'm3/s', 'm3/sec', 'm^3/s'], 'flow', 35.3147],
  [['kcfs', '1000 cfs', '1000 cu-ft/sec', '1000 ft3/sec'], 'flow', 1000],
  [['kcms', '1000 cms'], 'flow', 35314.7],

  // Registered, understood, and REFUSED. A lake level in miles is a mis-parameterised series,
  // not a lake, and converting it would produce a number that reads like one.
  [['in', 'inch', 'inches', 'mi', 'mile', 'miles', 'cm', 'centimeter', 'centimeters',
    'km', 'kilometer', 'kilometers', 'mm', 'millimeter', 'millimeters'], 'declined', 0],
  [['gal/min', 'gallons per minute', 'gpm', 'mgd', 'million gallons/day',
    'mcm/mon', '1000 ac-ft/mon', 'kaf/mon'], 'declined', 0],
];

const CWMS_UNITS = new Map();
for (const [names, kind, factor] of CWMS_UNIT_TABLE) {
  for (const n of names) CWMS_UNITS.set(n, { kind, factor });
}

/**
 * What this file makes of a CWMS unit string: 'length', 'flow', 'declined' or 'unknown'.
 *
 * Exported so a test can walk the Corps' published table and assert nothing in it is 'unknown'.
 */
export function cwmsUnitKind(units) {
  const u = String(units == null ? '' : units).trim().toLowerCase();
  if (!u) return 'unknown';
  return (CWMS_UNITS.get(u) || {}).kind || 'unknown';
}

/** A CWMS flow value as ft3/s, or null. */
export function cwmsToCfs(value, units) {
  if (!Number.isFinite(value)) return null;
  const hit = CWMS_UNITS.get(String(units == null ? '' : units).trim().toLowerCase());
  if (!hit || hit.kind !== 'flow') return null;
  return Math.round(value * hit.factor);
}

/**
 * One project's release picture, or null. Pure apart from the two fetches.
 *
 * A series that answers and a series that does not are different facts, so a project publishing
 * only Flow-Out still returns a block rather than nothing.
 */
export async function usaceRelease(project, office, nowMs = Date.now()) {
  const proj = String(project || '').trim();
  const off = String(office || '').trim();
  if (!proj || !off) return null;
  const like = encodeURIComponent(
    '^' + proj.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.(FLOW|ELEV-TAIL)');
  let catalog;
  try {
    catalog = await cached(`cwms:rel:${off}:${proj}`, TTL.bindings,
      () => getJson(`${CWMS}/catalog/TIMESERIES?office=${encodeURIComponent(off)}`
                  + `&like=${like}&page-size=500`));
  } catch (_) {
    return null;
  }
  const read = async (picked, convert) => {
    if (!picked || !picked.name) return null;
    try {
      const parsed = parseCwmsTimeseries(await cached(`cwms:ts:${picked.name}`, TTL.level,
        () => getJson(`${CWMS}/timeseries?name=${encodeURIComponent(picked.name)}`
                    + `&office=${encodeURIComponent(picked.office || off)}`)));
      if (!parsed || !parsed.latest) return null;
      const v = convert(parsed.latest.value, parsed.units);
      if (v === null) return null;
      return { value: v, at: parsed.latest.at, series: picked.name,
               units_reported: parsed.units };
    } catch (_) {
      return null;
    }
  };
  const flows = {};
  for (const [key, re] of CWMS_FLOW_SERIES) {
    const got = await read(pickCwmsSeries(catalog, re), cwmsToCfs);
    if (got) flows[key] = got;
  }
  const tail = await read(pickCwmsSeries(catalog, /\.Elev-Tail\./i), cwmsToFeet);
  if (!Object.keys(flows).length && !tail) return null;
  const newest = [...Object.values(flows), tail].filter(Boolean)
    .map((x) => Date.parse(x.at)).filter(Number.isFinite).sort().slice(-1)[0] || null;
  return {
    project: proj,
    office: off,
    // Every flow in ft3/s, converted at the point the unit is known rather than left for a
    // consumer to remember — the same rule nwpsFlowCfs follows for NWPS kcfs.
    flow_units: 'ft3/s',
    ...flows,
    tailwater_ft: tail ? tail.value : null,
    tailwater: tail,
    observed_at: newest ? new Date(newest).toISOString() : null,
    age_hours: newest ? Math.round(((nowMs - newest) / 3600000) * 10) / 10 : null,
    source: `${CWMS}/timeseries — ${proj}`,
  };
}

/**
 * A CWMS value in the unit CWMS declared, as feet — or null.
 *
 * Refuses anything it does not recognise. A silent pass-through of an unknown unit is how 201.2
 * becomes a lake level.
 */
export function cwmsToFeet(value, units) {
  if (!Number.isFinite(value)) return null;
  const hit = CWMS_UNITS.get(String(units == null ? '' : units).trim().toLowerCase());
  if (!hit || hit.kind !== 'length') return null;
  return Math.round(value * hit.factor * 100) / 100;
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

/**
 * WHERE TODAY'S FLOW SITS IN THIS RIVER'S OWN HISTORY.
 *
 * 1,240 ft3/s is not a fact anyone can act on. "1,240, below the 10th percentile for August 16
 * across 96 years" is. Until now the only answer this app had was NOAA's `anomaly_category`,
 * which conditions.js passes through untranslated and says why: it is a code into a legend
 * nobody here has read, and guessing the direction of an anomaly is worse than not reporting it.
 *
 * VERIFIED 2026-08-16 against site 02148000, Wateree River near Camden. `statReportType=daily`
 * returns one row per calendar day with `begin_yr 1930`, `end_yr 2026`, `count_nu 96` and the
 * requested percentile columns.
 *
 * PARSED BY HEADER NAME, NOT BY COLUMN POSITION. `loc_web_ds` comes back empty on this site, so
 * counting fields off the front of a row drifts by one the moment a site fills it in.
 *
 * A BAND, NOT A NUMBER. The published set points are p10/p25/p50/p75/p90 and this reports which
 * pair today's flow falls between. Interpolating a precise percentile between two of them would
 * be a derived value wearing a measurement's clothes — the same refusal usaceSeasonalValue makes
 * about interpolating a Corps level, for the same reason.
 */
export function parseDailyStats(rdb, month, day) {
  const lines = String(rdb || '').split('\n').filter((l) => l && !l.startsWith('#'));
  if (lines.length < 3) return null;
  const head = lines[0].split('\t');
  const idx = (name) => head.indexOf(name);
  const iM = idx('month_nu'), iD = idx('day_nu');
  if (iM < 0 || iD < 0) return null;
  for (const line of lines.slice(2)) {
    const f = line.split('\t');
    if (Number(f[iM]) !== month || Number(f[iD]) !== day) continue;
    // Number('') IS 0 AND isFinite(0) IS TRUE. An RDB cell for a percentile a site has no
    // record for comes back EMPTY, and without this guard it parses as a flow of zero — which
    // then reads as the driest day in 96 years on a river that simply was not gauged for it.
    // Caught by this function's own test, which is the fourth instance of this exact bug found
    // in one day: an empty Rain cell on Southern Company, an empty saved ramps array, an empty
    // COASTAL_PRIMARY set, and now this.
    const num = (name) => {
      const i = idx(name);
      if (i < 0) return null;
      const raw = (f[i] || '').trim();
      if (!raw) return null;
      const v = Number(raw);
      return Number.isFinite(v) ? v : null;
    };
    const p = { p10: num('p10_va'), p25: num('p25_va'), p50: num('p50_va'),
                p75: num('p75_va'), p90: num('p90_va') };
    if (Object.values(p).every((v) => v === null)) return null;
    return { ...p, begin_yr: num('begin_yr'), end_yr: num('end_yr'), years: num('count_nu'),
             month, day, source: 'USGS — /nwis/stat, daily statistics over the period of record' };
  }
  return null;
}

/** Which published pair today's value falls between, in words a person can act on. */
export function statBand(value, st) {
  if (!st || !Number.isFinite(value)) return null;
  const steps = [['p10', 10], ['p25', 25], ['p50', 50], ['p75', 75], ['p90', 90]]
    .filter(([k]) => Number.isFinite(st[k]));
  if (!steps.length) return null;
  let label = null, below = null, above = null;
  if (value < st[steps[0][0]]) {
    label = `below the ${steps[0][1]}th percentile`;
    above = steps[0][1];
  } else if (value >= st[steps[steps.length - 1][0]]) {
    label = `above the ${steps[steps.length - 1][1]}th percentile`;
    below = steps[steps.length - 1][1];
  } else {
    for (let i = 0; i < steps.length - 1; i += 1) {
      if (value >= st[steps[i][0]] && value < st[steps[i + 1][0]]) {
        below = steps[i][1]; above = steps[i + 1][1];
        label = `between the ${below}th and ${above}th percentile`;
        break;
      }
    }
  }
  if (!label) return null;
  return {
    label,
    percentile_at_least: below,
    percentile_below: above,
    median: Number.isFinite(st.p50) ? st.p50 : null,
    years: st.years,
    period: (st.begin_yr && st.end_yr) ? `${st.begin_yr}–${st.end_yr}` : null,
    // Said out loud so nobody reads the band as a precise figure.
    note: 'a band between published set points, not an interpolated percentile',
    source: st.source,
  };
}

async function flowVsHistory(site, flow, nowMs) {
  if (!site || !Number.isFinite(flow)) return null;
  const d = new Date(nowMs);
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  // Statistics over a period of record do not change during a day; cached accordingly.
  const rdb = await cached(`stat:${site}`, 6 * 3600, () => getText(
    'https://waterservices.usgs.gov/nwis/stat/?format=rdb&statReportType=daily'
    + `&statTypeCd=p10,p25,p50,p75,p90&parameterCd=00060&sites=${encodeURIComponent(site)}`));
  const st = parseDailyStats(rdb, month, day);
  return st ? { ...statBand(flow, st), flow_cfs: flow, usgs_site: site } : null;
}

// `env` IS A PARAMETER BECAUSE THE ALERT ARCHIVE NEEDS THE BUCKET. It was used here without
// being passed and every bound water's `water` block failed with "env is not defined" - caught
// by conditions-bindings.test.js on the first run, which is the whole reason that harness
// stubs R2 and the upstreams instead of asserting shapes.
async function waterBlock(b, lat, lon, env) {
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

  // THE DASHBOARD, ONCE, FOR EVERY USGS SITE THIS WATER BINDS. Filled in below wherever a
  // reading is missing something the dashboard has and nothing else does. One request per water
  // regardless of how many gauges it carries, and skipped entirely for a water with no USGS
  // site — which costs nothing and covers every water the binder will ever produce.
  const dashSites = [b.pool, b.tailwater, ...(b.gauges || [])]
    .map((g) => g && g.usgs_site).filter(Boolean);
  const dash = await dashboardFor(dashSites);

  // WHETHER IT IS IN FLOOD, on the gauges that had no way to say. usgsSite() writes null here
  // because /nwis/iv publishes no flood category; the dashboard publishes one for the same site.
  // NWPS readings are left alone — they already carry their own, from the agency that sets the
  // thresholds, and a second opinion on one fact is how two numbers start disagreeing on a card.
  if (dash) {
    for (const role of ['pool', 'tailwater', 'gauge']) {
      const r = out[role];
      if (!r || !r.usgs_site || r.flood_category != null) continue;
      const row = (dash.get(r.usgs_site) || new Map());
      const flood = ['00065', '00062', '62615', '62614', '63160', '00060']
        .map((pc) => (row.get(pc) || {}).flood).find(Boolean) || null;
      if (flood) {
        r.flood_category = flood;
        r.flood_category_source = 'USGS National Water Dashboard';
      }
    }
  }

  const used = new Set(picks.map(([, g]) => gaugeId(g)));
  out.other_gauges = (b.gauges || [])
    .filter((g) => g && gaugeId(g) && !used.has(gaugeId(g)) && Number.isFinite(g.lat))
    .map((g) => ({ lid: g.lid || null, usgs_site: g.usgs_site || null, name: g.name,
                   lat: g.lat, lon: g.lon,
                   km_from_point: round1(kmBetween(lat, lon, g.lat, g.lon)) }))
    .sort((x, y) => x.km_from_point - y.km_from_point);

  // Declared, not fetched. The NWM reach and the CWMS locations already have callers elsewhere
  // (`/rivers`); repeating those fetches here would be two code paths that can disagree about
  // the same number. The Corps' own numbers arrive below through usaceLevels and usaceRelease,
  // which answer questions no gauge does: what the pool is SUPPOSED to be today, and what is
  // going through the dam.
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

  // AND WHAT IS GOING THROUGH THE DAM. Duke lakes and TVA lakes have had a release since those
  // were wired; a Corps lake got nothing, not because the Corps publishes nothing but because
  // nothing asked. The project name is the one usaceLevels already derived from the binding and
  // the district's own roster, so this reaches a Corps lake added tomorrow with nothing to edit.
  out.usace_release = (out.usace && out.usace.project)
    ? await usaceRelease(out.usace.project, out.usace.office).catch(() => null)
    : null;

  // Cube, Southern Company and Brookfield. Null when the pipeline bound no operator to this
  // water -- which for Cube's "Falls" is the correct answer, not a gap.
  out.operator = await operatorLevel(b).catch(() => null);

  // Release schedules. The Duke call only happens for a water that has a basin, so the common
  // case costs nothing.
  // THE RIVER SYSTEM TRAVELS WITH THE BINDING and nothing was reading it. Every Catawba-chain
  // lake in the registry is bound to a gauge named "Catawba River at ...", because NWS names a
  // gauge for the river it sits on. The lake's own name almost never contains its river.
  const gaugeNames = [b.pool, b.tailwater, ...(b.gauges || [])]
    .filter((g) => g && g.name).map((g) => g.name);
  const roster = await fetchDukeRivers().catch(() => null);
  const basin = dukeBasinFor(roster, b.display_name || b.slug, gaugeNames);
  const basinRow = (roster || []).find((r) => Number(r.RiverId ?? r.riverId) === basin) || null;
  const dukeSched = basin ? await fetchDukeFlowArrivals(basin).catch(() => null) : null;
  // THE DAM SCHEDULE APPLIES TO A LAKE and the arrival schedule does not, so it is fetched for
  // any water that resolved a basin. Duke publishes eleven dams across four basins; Wateree is
  // one of them and had nothing to say through /flow-arrivals at all.
  const dukeRun = basin
    ? activeRunForWater(parseActiveRun(await fetchDukeActiveRun().catch(() => null)),
                        basin, b.display_name || b.slug, gaugeNames, basinRow)
    : [];

  // WHICH SIDE OF THIS LAKE EACH RELEASE CAME FROM.
  //
  // activeRunForWater already returns BOTH dams that matter to a reservoir -- the gauge bindings
  // carry both, so wateree_lake arrives holding Cedar Creek's dam and its own. Until now nothing
  // said which was which, and releaseShape's own note admitted it.
  //
  // Ryan: "for wateree if fishing north end then cedar creek dam release would flow down into
  // the lake... for the south end water leaving the wateree dam may cause a slight current".
  //
  // Both lookups are per-isolate cached for an hour, so this costs one R2 read per hour, not
  // one per request. FAILURE IS NOT FATAL: an unpublished chain or dam table leaves every row
  // unlabelled, which is exactly what the app showed yesterday, rather than losing the schedule
  // altogether. A release with no direction is still a release.
  let dukeRunLabelled = dukeRun;
  if (dukeRun.length && b.slug) {
    try {
      const [chain, dams] = await Promise.all([waterChain(env), damTable(env)]);
      dukeRunLabelled = releaseDirection(dukeRun, { slug: b.slug, chain, damOwner: dams });
    } catch (err) {
      out.releases_direction_unavailable = String((err && err.message) || err);
    }
  }

  // A hand-typed basin id has to prove itself before it is allowed to describe this river.
  // Refused rather than dropped: a projection that was rejected and one that was never
  // available are different facts, and only the first one names a table that needs fixing.
  out.releases_refused = null;
  let duke = dukeSched;

  const basinLabel = (basinRow && basinRow.riverDescription) || `basin ${basin}`;

  // A FLOW ARRIVAL IS A RIVER FACT. Every mile marker Duke publishes on this basin is a river
  // access point below a dam - Watermill Road Access Area, Morganton Greenway, Rock Hill River
  // Park, Lansford Canal State Park - and the endpoint is /rivers/. A release from the dam above
  // a reservoir raises it imperceptibly and a release from its own dam lowers it; neither is an
  // arrival. Refused by KIND, before any name matching, because that is the rule that would have
  // prevented this rather than caught it.
  if (dukeSched && !arrivalsAppliesTo(b.feature_type)) {
    duke = null;
    out.releases_refused = {
      operator: 'Duke Energy',
      basin_id: basin,
      basin_name: dukeSched.basinName || null,
      dams_publishing: arrivalDams(dukeSched),
      why: `Duke publishes flow arrivals for river access points below its dams - this water is `
         + `a ${b.feature_type || 'still water'}, not a river reach. The ${basinLabel} schedule `
         + `is real and it is not about this water.`,
    };
  } else if (dukeSched && dukeBasinAgrees(dukeSched, b.display_name || b.slug, gaugeNames)) {
    // A BASIN IS NOT A REACH. Keep only the arrivals that name this water or one of its gauges,
    // and collapse Duke's three-day repeat to the next one due per place.
    const mine = nextArrivalPerMarker(
      arrivalsForWater(dukeSched, b.display_name || b.slug, gaugeNames, basinRow), Date.now());
    if (mine.length) {
      duke = { ...dukeSched, arrivals: mine, arrivals_in_basin: dukeSched.arrivals.length };
    } else {
      duke = null;
      const dams = arrivalDams(dukeSched);
      out.releases_refused = {
        operator: 'Duke Energy',
        basin_id: basin,
        basin_name: dukeSched.basinName || null,
        arrivals_in_basin: dukeSched.arrivals.length,
        dams_publishing: dams,
        // NAMING THE DAMS IS THE USEFUL PART. On 2026-08-16 the whole Catawba basin had exactly
        // two dams publishing, Bridgewater at the top and Wylie in the middle, and neither is
        // adjacent to most of the chain. "Nothing for you" and "nothing for you because only
        // these two are releasing" are different answers.
        why: `Duke published arrivals for ${dams.length} dam${dams.length === 1 ? '' : 's'} on the `
           + `${basinLabel} basin${dams.length ? ` - ${dams.join(', ')}` : ''} - and none of them `
           + `reaches ${b.display_name || b.slug} or any gauge bound to it.`,
      };
    }
  } else if (dukeSched) {
    duke = null;
    const why = dukeBasinWhy(roster, b.display_name || b.slug, gaugeNames);
    out.releases_refused = {
      operator: 'Duke Energy',
      basin_id: basin,
      basin_name: dukeSched.basinName || null,
      // THE OLD MESSAGE BLAMED THE WRONG THING. It said "the id is hand-typed and unverified" —
      // and on the Wateree the id was RIGHT and the comparison was wrong, because it held a basin
      // name up against a LAKE name. The id is Duke's own now, so if this fires it means the
      // schedule that came back does not name the river any of this water's gauges are on, which
      // is a renumbering or a bad binding, and the message says which evidence was used.
      matched_on: why ? why.matched : [],
      rivers_considered: gaugeNames.map(gaugeRiverPart),
      why: `Duke basin ${basin}${why && why.description ? ` ("${why.description}")` : ''} returned a `
         + `schedule named "${dukeSched.basinName || 'an unnamed basin'}", which shares no river `
         + `name with ${b.display_name || b.slug} or with the gauges bound to it.`,
    };
  }
  out.releases = releaseShape({ duke, dukeRun: dukeRunLabelled, tva: out.tva,
                                usace: out.usace_release,
                               operator: out.operator });

  // WHAT IS SHUT, AND WHY THE WATER IS WHERE IT IS.
  //
  // Duke's access-alerts carries both, and the second half is the reason behind a number the card
  // is already showing: Lake Wateree reads "No Flow Release" three days running because the
  // Catawba-Wateree basin went to Stage 2 of the Low Inflow Protocol on 2026-05-01 and recreation
  // flows are suspended under Stage 2. A stated zero with its cause beside it is a different fact
  // from a stated zero on its own.
  //
  // Fetched for any Duke water, not only one that resolved a basin, because a closed ramp is a
  // closed ramp whether or not anybody is releasing.
  const alertsRaw = parseAccessAlerts(await fetchDukeAccessAlerts().catch(() => null));
  // KEEP THEM. The feed is a snapshot and the effect outlives the explanation - see
  // archiveAlerts. A failed write is not a failed read.
  await archiveAlerts(env, alertsRaw, new Date().toISOString().slice(0, 10)).catch(() => false);
  const mineAlerts = alertsForWater(alertsRaw, b.display_name || b.slug, gaugeNames);
  out.access_alerts = mineAlerts.length ? mineAlerts : null;
  // Notices Duke has since taken down, offered as HISTORY and labelled as such. The one that
  // explains why Wateree is high this week is already gone from the live feed.
  const expired = await expiredAlertsFor(env, mineAlerts, b.display_name || b.slug, gaugeNames)
    .catch(() => []);
  out.access_alerts_expired = expired.length ? expired : null;
  const drought = basinRow ? droughtNoticeFor(alertsRaw, basinRow) : null;
  out.operator_drought = drought;

  // DUKE'S GUIDE CURVE, AND WHERE THIS DATE USUALLY SITS.
  //
  // The card can say how far below full pond the lake is and nothing about whether that is where
  // it is supposed to be. TVA lakes have had a guide curve since 2026-08-15; Duke lakes had no
  // equivalent until Ryan found /lakes/operating-range on 2026-08-17. The id it wants is
  // published in the alert feed, so nothing is hand-typed to reach it.
  const dukeLocId = dukeLocationIdFor(alertsRaw, b.display_name || b.slug, gaugeNames);
  const opRange = dukeLocId != null
    ? await fetchDukeOperatingRange(dukeLocId).catch(() => null) : null;
  const guide = parseOperatingRange(opRange);
  out.duke_guide = guide ? {
    ...guide,
    // The rank against the same week in every year on file. Five years of daily history is
    // enough to place a number and not enough to claim a percentile.
    vs_same_date: levelVsSameDate(opRange, guide.today && guide.today.date),
    location_id: dukeLocId,
    source: `https://api.hydro-derived.duke-energy.app/lakes/operating-range/${dukeLocId}`,
    // A RESERVOIR LEVEL IS AN OPERATING DECISION, NOT A WEATHER READING, and a rank that says
    // "higher than almost every other year" invites exactly one wrong inference. Ryan, 2026-08-17,
    // on this very lake and this very week: they raised it to 99 to float a barge working near the
    // dam, which is also why Buck Hill is shut. Nothing in any feed says that today.
    caveat: 'A reservoir level is set by its operator. A reading above or below the usual for this '
          + 'date is as likely to be a drawdown, a refill or construction as it is to be weather - '
          + 'check the access notices before reading anything into it.',
  } : null;

  // TWO SOURCES, ONE FACT, AND NOW THEY CAN DISAGREE OUT LOUD. access-alerts says the stage in a
  // paragraph of prose; operating-range says it in a field. A mismatch means one of them is stale.
  if (guide && drought && guide.drought_stage != null && drought.stage != null
      && guide.drought_stage !== drought.stage) {
    out.duke_guide.stage_disagrees = {
      from_alert_text: drought.stage,
      from_operating_range: guide.drought_stage,
      why: 'Duke publishes the Low Inflow Protocol stage in two places and they do not match. '
         + 'The operating-range field is dated; the alert paragraph may not have been rewritten.',
    };
  }
  // Attached to the schedule as well, so a consumer reading `releases` alone cannot show the zero
  // without the reason. The number and its explanation must not be reachable by different paths.
  if (out.releases && drought) out.releases.suspended_by = drought;

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
  // AND WHEN THERE IS NO LID, WHICH IS 45 OF 221 WATERS. NWPS is preferred whenever it answers
  // — a month of observations beats a single rate — but a water with no handbook-5 id anywhere
  // in its binding could never reach it, and used to get nothing rather than something. Same
  // shape either way; `source` says which answered.
  if (!out.trend && dash) {
    const trendSite = [b.pool, ...(b.gauges || []), b.tailwater]
      .map((g) => g && g.usgs_site).filter(Boolean)
      .find((site) => dashboardTrend(dash.get(site)));
    out.trend = trendSite ? dashboardTrend(dash.get(trendSite)) : null;
    if (out.trend) out.trend.usgs_site = trendSite;
  }

  // Only where there is a flow to place. A lake's percentile of discharge is not a question
  // anyone is asking, and the fetch is skipped rather than made and discarded.
  const flowGauge = ['gauge', 'tailwater', 'pool']
    .map((role) => out[role]).find((g) => g && Number.isFinite(g.flow) && g.usgs_site);
  out.flow_vs_history = flowGauge
    ? await flowVsHistory(flowGauge.usgs_site, flowGauge.flow, Date.now()).catch(() => null)
    : null;

  const probe = await waterProbe(b, lat, lon, seeded).catch(() => ({ temp: seeded }));
  out.water_temp = probe.temp || null;
  // A MEASURED clarity number, where one exists. `clarity` on this response is a rainfall model
  // over a historical Secchi baseline; this is an instrument reading from today, and the two
  // must not be presented as the same kind of thing.
  out.turbidity = probe.turbidity || null;
  out.dissolved_oxygen = probe.oxygen || null;
  out.salt = probe.salt || null;
  out.tidal_flow = probe.tidalFlow || null;
  // A null with a reason. "No USGS site bound to this water publishes dissolved oxygen" is a
  // registry gap somebody can close; an empty field is a mystery.
  out.unpublished_parameters = (probe.unpublished && probe.unpublished.length)
    ? probe.unpublished : null;
  // Measured by a bound site and still empty -- a gauge to go read, not a registry gap.
  out.silent_parameters = (probe.silent && probe.silent.length) ? probe.silent : null;
  out.sites_catalogued = probe.catalogued || 0;
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
 * (Vestigial, noted not fixed: fetchDamLevels() in the deleted js/modules/duke-energy.js looped basins 1, 2
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
    // THE OPERATOR'S OWN SENTENCE ABOUT THE LEVEL, WHICH WAS FETCHED AND DROPPED.
    //
    // normalizeDukeRow has parsed SpecialMessage since it was written, and picks the NEWEST of the
    // array rather than the first because Duke does not sort it. `/lake` and `/duke` carried it;
    // /conditions - the route the card actually uses - never did. Fetched on every request and
    // thrown away, which is the fifth instance of that family this week.
    //
    // Ryan pasted the message on 2026-08-17, after the card told him the lake was higher than 24
    // of 30 readings for this week and could not say why:
    //
    //   "Due to planned maintenance at the Wateree Hydro Station the week of August 17, 2026,
    //    Lake Wateree water levels are expected to rise over the weekend and remain near 99.0 feet
    //    (local datum) during the week. The higher water level is needed to support barge
    //    operations related to maintenance activities."
    //
    // 99.0 "local datum" is the same 100-is-full-pond index everything else on this feed uses, and
    // it is the entire answer to a question five years of history could only pose. It also names
    // the reason Buck Hill Access Area is shut. One sentence, on the wire the whole time.
    if (d.specialMessage) out.operator_message = d.specialMessage;
    if (Array.isArray(d.specialMessages) && d.specialMessages.length) {
      out.operator_messages = d.specialMessages;
    }
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

/**
 * `/hazards?lat=&lon=` -- the NWS watches, warnings and advisories over one point, and nothing else.
 *
 * WHY A ROUTE OF ITS OWN, WHEN /conditions ALREADY RETURNS THIS.
 *
 * Ryan, 2026-08-25: *"if there is a forecast that is going to drive a watch or warning i am not
 * going to plan to be on the water... now if weather creeps on while i am on the water that
 * wasn't forecasted then that is where the alert to my phone would be absolutely beneficial."*
 *
 * That is a LIVE question, asked repeatedly from a boat, and `/conditions` is the wrong shape for
 * it: it fans out to USGS, CWMS, NWPS, the Corps, the tide tables and the clarity model to answer
 * one that costs a single ArcGIS query. Polling it every five minutes on a phone would spend the
 * whole payload to re-read one field.
 *
 * FIVE MINUTES IS THE SERVICE'S OWN CADENCE. `TTL.wwa` is 300 s because the WWA MapServer
 * republishes on that interval, so a caller polling faster is reading its own cache.
 *
 * The point is the BOAT'S, not the launch's. A warning polygon has an edge, and the whole value
 * of this is being told when you have drifted under one.
 */
export async function handleHazards(request, env, url) {
  if (url.pathname !== '/hazards') return null;
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (request.method !== 'GET') {
    return new Response('{"error":"method not allowed"}',
      { status: 405, headers: { ...CORS, ...JSON_HEADERS } });
  }
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return new Response(JSON.stringify({ error: 'lat and lon are required' }),
      { status: 400, headers: { ...CORS, ...JSON_HEADERS } });
  }
  try {
    const out = await hazards(lat, lon);
    return new Response(JSON.stringify({ ...out, at: [lon, lat], asked_at: nowIso() }),
      { headers: { ...CORS, ...JSON_HEADERS } });
  } catch (e) {
    // A FAILED LOOKUP IS NOT AN ALL-CLEAR, and this is the one route where that distinction can
    // put someone under a storm. `all_clear` is absent on an error, never false.
    return new Response(JSON.stringify({ error: String((e && e.message) || e) }),
      { status: 502, headers: { ...CORS, ...JSON_HEADERS } });
  }
}

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
      return b ? waterBlock(b, lat, lon, env) : null;
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
