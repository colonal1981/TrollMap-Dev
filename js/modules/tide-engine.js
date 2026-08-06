/**
 * tide-engine.js — NOAA CO-OPS tide data as a reusable module.
 *
 * Split out of noaa-tides.js (which is DOM-only and self-invoking) because
 * coastal SmartPlan needs a *continuous* tide height, not just the high/low
 * table the panel renders.
 *
 * Why continuous: i-Boating coastal contours are MLLW-referenced, matching
 * NOAA charts. To route a boat we need the real depth under the keel at the
 * time we will actually be there:
 *
 *     actual_depth_ft = charted_depth_ft + tide_height_ft
 *
 * `interval=hilo` only yields 4-ish points a day, so this module also pulls
 * `interval=h` (hourly) predictions and interpolates between them.
 *
 * Everything here is pure data + fetch. No DOM. noaa-tides.js owns the panel.
 */

import { COASTAL_ZONES, isCoastalKey } from '../data/coastal-zones.js';

const COOPS_BASE = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const APP_NAME   = 'TrollMapStudio';

// Predictions for a given station+date are immutable, so cache hard.
const _cache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  _cache.set(key, { ts: Date.now(), value });
}

/** 'YYYY-MM-DD' -> 'YYYYMMDD' as CO-OPS wants it. */
export function toNoaaDate(dateStr) {
  return String(dateStr || '').replace(/-/g, '');
}

/**
 * CO-OPS returns local station time as 'YYYY-MM-DD HH:MM' with no zone.
 * Parsing that with `new Date()` is implementation-defined, so build the
 * Date explicitly from parts and treat it as local wall-clock time — which
 * is what the angler's phone shows and what `lst_ldt` already gives us.
 */
export function parseNoaaTime(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

async function fetchPredictions({ station, dateStr, interval, range = 24 }) {
  const noaaDate = toNoaaDate(dateStr);
  const key = `${station}|${noaaDate}|${interval}|${range}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = `${COOPS_BASE}?begin_date=${noaaDate}&range=${range}` +
    `&station=${encodeURIComponent(station)}&product=predictions&datum=MLLW` +
    `&time_zone=lst_ldt&interval=${interval}&units=english` +
    `&application=${APP_NAME}&format=json`;

  const res = await fetch(url, { signal: AbortSignal.timeout?.(8000) });
  if (!res.ok) throw new Error(`NOAA HTTP ${res.status}`);
  const data = await res.json();
  if (data?.error) throw new Error(data.error.message || 'NOAA station unavailable');

  const preds = data?.predictions;
  if (!Array.isArray(preds) || !preds.length) {
    throw new Error('No tide predictions returned for this date');
  }
  cacheSet(key, preds);
  return preds;
}

/** High/low events only — what the tide table renders. */
export function fetchHiLo(station, dateStr) {
  return fetchPredictions({ station, dateStr, interval: 'hilo' });
}

/** Hourly heights — what depth adjustment interpolates over. */
export function fetchHourly(station, dateStr) {
  return fetchPredictions({ station, dateStr, interval: 'h' });
}

/**
 * Linearly interpolate tide height (ft above MLLW) at `when` from a series
 * of hourly predictions. Hourly spacing makes linear interpolation accurate
 * to well under a tenth of a foot, which is far finer than chart resolution.
 *
 * Returns null when `when` sits outside the series rather than extrapolating.
 */
export function interpolateHeight(hourly, when) {
  if (!Array.isArray(hourly) || hourly.length === 0 || !when) return null;
  const t = when.getTime();

  const pts = hourly
    .map((p) => ({ t: parseNoaaTime(p.t)?.getTime(), v: parseFloat(p.v) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);

  if (!pts.length) return null;
  if (t <= pts[0].t) return t === pts[0].t ? pts[0].v : null;
  if (t >= pts[pts.length - 1].t) {
    return t === pts[pts.length - 1].t ? pts[pts.length - 1].v : null;
  }

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      if (span === 0) return a.v;
      const frac = (t - a.t) / span;
      return a.v + (b.v - a.v) * frac;
    }
  }
  return null;
}

/**
 * Classify the tide stage at `when`.
 *
 * Returns one of: 'flood' | 'ebb' | 'high' | 'low'.
 *
 * 'high' / 'low' are slack windows around the turn, where water is barely
 * moving. That distinction matters tactically: moving water positions fish
 * on structure, slack water does not. SLACK_WINDOW_MIN is deliberately
 * generous (45 min either side) because bite quality falls off well before
 * the exact astronomical turn.
 */
const SLACK_WINDOW_MIN = 45;

export function classifyStage(hilo, when) {
  if (!Array.isArray(hilo) || !hilo.length || !when) return null;
  const t = when.getTime();

  const events = hilo
    .map((p) => ({
      t: parseNoaaTime(p.t)?.getTime(),
      v: parseFloat(p.v),
      type: p.type === 'H' ? 'high' : 'low',
    }))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t);

  if (!events.length) return null;

  // Inside the slack window of any turn?
  for (const e of events) {
    if (Math.abs(t - e.t) <= SLACK_WINDOW_MIN * 60 * 1000) {
      return e.type;
    }
  }

  // Otherwise we are between two events — rising toward a high is flood,
  // falling toward a low is ebb.
  let next = events.find((e) => e.t > t);
  if (!next) {
    // Past the last event of the series; infer from the final turn.
    const last = events[events.length - 1];
    return last.type === 'high' ? 'ebb' : 'flood';
  }
  return next.type === 'high' ? 'flood' : 'ebb';
}

/** Human-facing label for a stage. */
export function stageLabel(stage) {
  switch (stage) {
    case 'flood': return 'Incoming / Flood 🌊';
    case 'ebb':   return 'Outgoing / Ebb 📉';
    case 'high':  return 'High Slack ⏸';
    case 'low':   return 'Low Slack ⏬';
    default:      return '';
  }
}

/**
 * Full tide picture for a zone at a moment in time.
 *
 * @param {object} opts
 * @param {string} opts.station     NOAA CO-OPS station id
 * @param {string} opts.dateStr     'YYYY-MM-DD'
 * @param {Date}   [opts.when]      defaults to now
 * @returns {Promise<{
 *   station: string, dateStr: string, when: Date,
 *   heightFt: number|null, stage: string|null, stageLabel: string,
 *   hilo: Array, hourly: Array,
 *   nextEvent: {type: string, at: Date, heightFt: number}|null,
 *   previousEvent: {type: string, at: Date, heightFt: number}|null,
 *   rangeFt: number|null
 * }>}
 */
export async function getTideState({ station, dateStr, when } = {}) {
  if (!station) throw new Error('getTideState: station is required');
  const day = dateStr || new Date().toISOString().slice(0, 10);
  const at = when || new Date();

  // Fetch both series together; a failure in one should not lose the other.
  const [hiloRes, hourlyRes] = await Promise.allSettled([
    fetchHiLo(station, day),
    fetchHourly(station, day),
  ]);

  const hilo   = hiloRes.status === 'fulfilled' ? hiloRes.value : [];
  const hourly = hourlyRes.status === 'fulfilled' ? hourlyRes.value : [];

  if (!hilo.length && !hourly.length) {
    const reason = hiloRes.reason || hourlyRes.reason;
    throw new Error(reason?.message || 'NOAA tide fetch failed');
  }

  const heightFt = interpolateHeight(hourly, at);
  const stage    = classifyStage(hilo, at);

  const events = hilo
    .map((p) => ({
      type: p.type === 'H' ? 'high' : 'low',
      at: parseNoaaTime(p.t),
      heightFt: parseFloat(p.v),
    }))
    .filter((e) => e.at)
    .sort((a, b) => a.at - b.at);

  const nextEvent     = events.find((e) => e.at.getTime() > at.getTime()) || null;
  const previousEvent = [...events].reverse().find((e) => e.at.getTime() <= at.getTime()) || null;

  const highs = events.filter((e) => e.type === 'high').map((e) => e.heightFt);
  const lows  = events.filter((e) => e.type === 'low').map((e) => e.heightFt);
  const rangeFt = (highs.length && lows.length)
    ? Math.max(...highs) - Math.min(...lows)
    : null;

  return {
    station, dateStr: day, when: at,
    heightFt, stage, stageLabel: stageLabel(stage),
    hilo, hourly, nextEvent, previousEvent, rangeFt,
  };
}

/**
 * Same as getTideState but resolves the station from a coastal zone slug.
 * Returns null for freshwater keys so callers can branch cheaply.
 */
export async function getTideStateForZone(zoneKey, { dateStr, when } = {}) {
  if (!isCoastalKey(zoneKey)) return null;
  const zone = COASTAL_ZONES[zoneKey];
  if (!zone) return null;
  const state = await getTideState({ station: zone.tideStation, dateStr, when });
  return { ...state, zone };
}

/**
 * Tide-correct a charted (MLLW) depth.
 *
 * Charted depths are the *minimum* expected water; a positive tide height
 * adds to them, and a negative height (below-datum spring low) subtracts.
 * Returns the charted depth unchanged when no tide height is available, so
 * callers degrade to conservative MLLW numbers rather than NaN.
 */
export function tideAdjustedDepth(chartedDepthFt, tideHeightFt) {
  // Guard null/'' explicitly: Number(null) and Number('') are both 0, which
  // would quietly turn "no depth recorded" into "0 ft of water".
  if (chartedDepthFt === null || chartedDepthFt === undefined || chartedDepthFt === '') {
    return null;
  }
  const d = Number(chartedDepthFt);
  if (!Number.isFinite(d)) return null;
  const t = Number(tideHeightFt);
  if (!Number.isFinite(t)) return d;
  return d + t;
}
