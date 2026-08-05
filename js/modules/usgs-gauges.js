/**
 * usgs-gauges.js — river discharge as a salinity proxy for coastal zones.
 *
 * The brief specifies "discharge > 130% of 30-day mean" as the freshwater
 * intrusion trigger, but the instantaneous-values endpoint it cites returns
 * only the current reading. The 30-day baseline needs the daily-values
 * service, so this module queries both:
 *
 *   latest-continuous  parameter_code=00060                      -> current discharge (cfs)
 *   daily              parameter_code=00060 statistic_id=00003   -> 30 days of daily means
 *
 * Zones with no gauge (see coastal-zones.js usgsGauges) simply skip the
 * check; guessing from an unrelated basin would be worse than no signal.
 */

import { COASTAL_ZONES, isCoastalKey } from '../data/coastal-zones.js';
import { assessFreshwaterIntrusion } from './coastal-scoring.js';

// Migrated off waterservices.usgs.gov on 2026-08-06; that host is decommissioned in Q1 2027.
// The browser can call this directly -- api.waterdata.usgs.gov answers with
// `Access-Control-Allow-Origin: *`, checked before the change rather than assumed, because a
// missing CORS header fails only in a real browser and passes every test in this file.
const OGC = 'https://api.waterdata.usgs.gov/ogcapi/v0/collections';
const DISCHARGE = '00060';
const MEAN_STAT = '00003';

const _cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // discharge moves slowly

function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) { _cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) { _cache.set(key, { ts: Date.now(), value }); }

/**
 * Pull every numeric value out of a USGS payload, in either shape.
 *
 * The OGC API returns a GeoJSON FeatureCollection, one feature per observation. The old NWIS
 * WaterML-JSON nested them under value.timeSeries[].values[].value[]. Both are handled: NWIS
 * survives until its Q1 2027 decommission, and the tests that pin the -999999 sentinel and the
 * "Ice" case are written against it, so they keep proving those rules through the transition.
 *
 * `value` is a STRING in both shapes -- deliberately in OGC's case, "to preserve precision".
 */
export function extractValues(payload) {
  const out = [];
  const push = (raw) => {
    // '' and null must not reach Number(): Number('') is 0, and a phantom 0 cfs in a 30-day
    // mean is the difference between a flooding river and a drought.
    if (raw === null || raw === undefined || raw === '') return;
    const n = Number(raw);
    if (Number.isFinite(n) && n > -999999) out.push(n);
  };

  const feats = Array.isArray(payload) ? payload
              : (Array.isArray(payload?.features) ? payload.features : null);
  if (feats) {
    for (const f of feats) push(((f && f.properties) || f || {}).value);
    return out;
  }

  const series = payload?.value?.timeSeries;
  if (!Array.isArray(series)) return [];
  for (const s of series) {
    for (const block of s.values || []) {
      for (const v of block.value || []) push(v.value);
    }
  }
  return out;
}

/** `02171700` -> `USGS-02171700`, and leave an already-qualified id alone. */
function locId(siteId) {
  const s = String(siteId);
  return s.startsWith('USGS-') ? s : `USGS-${s}`;
}

export function mean(values) {
  if (!values?.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout?.(8000) });
  if (!res.ok) throw new Error(`USGS HTTP ${res.status}`);
  return res.json();
}

/** Most recent instantaneous discharge (cfs) for a site, or null. */
export async function fetchCurrentDischarge(siteId) {
  const url = `${OGC}/latest-continuous/items?monitoring_location_id=${encodeURIComponent(locId(siteId))}` +
    `&parameter_code=${DISCHARGE}&limit=10&f=json`;
  const values = extractValues(await getJson(url));
  return values.length ? values[values.length - 1] : null;
}

/** Mean of the last `days` daily-mean discharges for a site, or null. */
export async function fetchMeanDischarge(siteId, days = 30) {
  // `period=P30D` has no OGC equivalent -- it takes an explicit RFC 3339 interval, and `..`
  // is its spelling of "to now".
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const url = `${OGC}/daily/items?monitoring_location_id=${encodeURIComponent(locId(siteId))}` +
    `&parameter_code=${DISCHARGE}&statistic_id=${MEAN_STAT}` +
    `&datetime=${encodeURIComponent(since + '/..')}&limit=${days + 10}&f=json`;
  return mean(extractValues(await getJson(url)));
}

/**
 * Assess intrusion for a single gauge site.
 * Returns an inert result rather than throwing so one dead gauge cannot take
 * down a whole SmartPlan run.
 */
export async function assessSite(siteId) {
  const cached = cacheGet(siteId);
  if (cached) return cached;
  try {
    const [current, mean30d] = await Promise.all([
      fetchCurrentDischarge(siteId),
      fetchMeanDischarge(siteId, 30),
    ]);
    const result = {
      siteId,
      currentCfs: current,
      mean30dCfs: mean30d,
      ...assessFreshwaterIntrusion(current, mean30d),
    };
    cacheSet(siteId, result);
    return result;
  } catch (err) {
    const result = {
      siteId, currentCfs: null, mean30dCfs: null,
      active: false, ratio: null, severity: 0, message: null,
      error: err.message,
    };
    cacheSet(siteId, result);
    return result;
  }
}

/**
 * Assess every gauge for a coastal zone and reduce to the worst case, since
 * any one flooding river is enough to freshen the system.
 *
 * @returns {Promise<{active:boolean, severity:number, message:string|null,
 *                    sites:Array, rivers:string[]}>}
 */
export async function assessZoneIntrusion(zoneKey) {
  const inert = { active: false, severity: 0, message: null, sites: [], rivers: [] };
  if (!isCoastalKey(zoneKey)) return inert;
  const zone = COASTAL_ZONES[zoneKey];
  if (!zone?.usgsGauges?.length) return inert;

  const sites = await Promise.all(zone.usgsGauges.map(assessSite));
  const active = sites.filter((s) => s.active);
  if (!active.length) return { ...inert, sites };

  const worst = active.reduce((a, b) => (b.severity > a.severity ? b : a));
  return {
    active: true,
    severity: worst.severity,
    ratio: worst.ratio,
    message: worst.message,
    sites,
    rivers: zone.usgsRivers || [],
  };
}
