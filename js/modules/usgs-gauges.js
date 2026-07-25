/**
 * usgs-gauges.js — river discharge as a salinity proxy for coastal zones.
 *
 * The brief specifies "discharge > 130% of 30-day mean" as the freshwater
 * intrusion trigger, but the instantaneous-values endpoint it cites returns
 * only the current reading. The 30-day baseline needs the daily-values
 * service, so this module queries both:
 *
 *   /nwis/iv/  parameterCd=00060                  -> current discharge (cfs)
 *   /nwis/dv/  parameterCd=00060&statCd=00003     -> 30 days of daily means
 *
 * Zones with no gauge (see coastal-zones.js usgsGauges) simply skip the
 * check; guessing from an unrelated basin would be worse than no signal.
 */

import { COASTAL_ZONES, isCoastalKey } from '../data/coastal-zones.js';
import { assessFreshwaterIntrusion } from './coastal-scoring.js';

const IV_BASE = 'https://waterservices.usgs.gov/nwis/iv/';
const DV_BASE = 'https://waterservices.usgs.gov/nwis/dv/';
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

/** Pull every numeric value out of a NWIS timeSeries payload. */
export function extractValues(payload) {
  const series = payload?.value?.timeSeries;
  if (!Array.isArray(series)) return [];
  const out = [];
  for (const s of series) {
    for (const block of s.values || []) {
      for (const v of block.value || []) {
        const n = parseFloat(v.value);
        // NWIS uses -999999 as its no-data sentinel.
        if (Number.isFinite(n) && n > -999999) out.push(n);
      }
    }
  }
  return out;
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
  const url = `${IV_BASE}?sites=${encodeURIComponent(siteId)}` +
    `&parameterCd=${DISCHARGE}&format=json&siteStatus=all`;
  const values = extractValues(await getJson(url));
  return values.length ? values[values.length - 1] : null;
}

/** Mean of the last `days` daily-mean discharges for a site, or null. */
export async function fetchMeanDischarge(siteId, days = 30) {
  const url = `${DV_BASE}?sites=${encodeURIComponent(siteId)}` +
    `&parameterCd=${DISCHARGE}&statCd=${MEAN_STAT}` +
    `&period=P${days}D&format=json&siteStatus=all`;
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
