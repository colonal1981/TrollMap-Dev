/**
 * nws-wind.js -- the wind the National Weather Service forecasts, for the plan: its blend (NBM), through Open-Meteo.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-11-06, of his Sunday on Moultrie: "something is wayyyy off... i am not seeing anything close those wind
 * forecasts on any of the apps i am checking for this sunday", then "i am pretty much showing a north wind at 2-3mph
 * most of the day online... i thought it was supposed to be calm".
 *
 * The plan asked Open-Meteo with no model named, and for the US its default is the GFS. At the middle of Lake Moultrie
 * for 11/8 that had 12 mph gusting 18 at 06:00 and 19 at 02:00. Every other source had about half: the National
 * Weather Service 7 mph there and 3 at Moncks Corner, its blend (NBM) 6.5, the ECMWF 6.5, ICON 5, the Canadian 10;
 * only the HRRR was windier (16.5). So the hourly wind is now the NWS blend, which is what the forecasts he checks
 * show, and the default model's is kept beside it and said when it is clearly windier: over open water the wind can
 * run stronger than at the towns, and the call is his.
 *
 * The blend reaches about ten days ahead. Past that, or when it answers nothing, the default model is used and the
 * plan says which.
 */

export const NBM = 'ncep_nbm_conus';
export const NBM_NAME = 'the National Weather Service blend (NBM)';
export const DEFAULT_NAME = "Open-Meteo's default model (the GFS in the US)";

const has = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/**
 * The NBM wind for one day at a point, in Open-Meteo's own shape and units (km/h):
 * {hourly: {time, windspeed_10m, winddirection_10m, windgusts_10m}, daily: {...}|null}, or null when it has none.
 * Never throws.
 */
export async function nbmWind(lat, lon, dateStr, { fetchImpl = (typeof fetch !== 'undefined' ? fetch : null), timeoutMs = 4500 } = {}) {
  if (!fetchImpl || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return null;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + '&daily=windspeed_10m_max,winddirection_10m_dominant'
      + '&hourly=windspeed_10m,winddirection_10m,windgusts_10m'
      + `&models=${NBM}&timezone=auto&start_date=${dateStr}&end_date=${dateStr}`;
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    const res = await fetchImpl(url, { signal });
    if (!res || !res.ok) return null;
    const j = await res.json();
    const h = j && j.hourly;
    if (!h || !Array.isArray(h.time) || !(h.windspeed_10m || []).some(has)) return null;
    return { hourly: h, daily: (j && j.daily) || null };
  } catch (e) {
    return null;
  }
}

/** The blend's daily maximum and its direction, in km/h and degrees, where it gives them; else null. */
export function nbmDaily(n) {
  const D = n && n.daily;
  if (!D) return null;
  const max = (D.windspeed_10m_max || [])[0];
  const dir = (D.winddirection_10m_dominant || [])[0];
  return has(max) ? { maxKmh: Number(max), dirDeg: has(dir) ? Number(dir) : null } : null;
}

/**
 * Open-Meteo's hourly arrays with the blend's wind written over the default's, hour by hour where the blend has one.
 * The rest of the hour (cloud, rain, fog, temperature) stays the default's: the blend is asked for the wind only.
 */
export function withNbmWind(hourly, n) {
  if (!hourly || !n || !n.hourly) return hourly;
  const out = { ...hourly };
  const at = new Map((n.hourly.time || []).map((t, i) => [t, i]));
  for (const k of ['windspeed_10m', 'winddirection_10m', 'windgusts_10m']) {
    const mine = hourly[k] || [];
    const theirs = n.hourly[k] || [];
    out[k] = (hourly.time || []).map((t, i) => {
      const j = at.get(t);
      return j !== undefined && has(theirs[j]) ? theirs[j] : mine[i];
    });
  }
  return out;
}

/**
 * The hour another model is most clearly windier than the blend, in the trip window: at least `byMph` more and
 * half again as much. {hour, mph, otherMph, otherGustMph} or null. Both arguments are hourlyWind() output (mph).
 */
export function windierHour(blend, other, { byMph = 4, byRatio = 1.5 } = {}) {
  let best = null;
  for (const o of other || []) {
    const b = (blend || []).find((x) => x.hour === o.hour);
    if (!b || !has(o.mph) || !has(b.mph)) continue;
    const d = o.mph - b.mph;
    if (d >= byMph && o.mph >= byRatio * b.mph && (!best || d > best.otherMph - best.mph)) {
      best = { hour: o.hour, mph: b.mph, otherMph: o.mph, otherGustMph: has(o.gustMph) ? o.gustMph : null };
    }
  }
  return best;
}
