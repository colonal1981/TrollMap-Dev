/**
 * plan-preflight.js — the two things that must happen before a plan is worth building.
 *
 * WHY THESE TWO AND NOT THE OTHER TWO
 * -----------------------------------
 * v2 took over the Generate button, which left four things v1's `runSmartPlan()` did around the
 * plan without a home. Ryan ruled on each, 2026-08-08:
 *
 *   regulations  KEEP — "reg check is needed so we don't plan on closed waters"
 *   weather      KEEP — "weather is huge for the plan need to fetch"
 *   scout waypoints  KILL — "i think was replaced by the way the new engine handles things"
 *   coach        KILL — "it wasn't as useful as i thought it would be"
 *
 * So this module is the two survivors, lifted out of a 1,510-line file that is on the deletion
 * tab. `detectCoastalZone` came with them because it is what decides which regulation table
 * applies, and leaving it in v1 would have meant v2 importing from the module it replaces —
 * which would make deleting v1 a refactor instead of a delete.
 *
 * A REGULATION BLOCK IS NOT A WARNING. It returns `legal: false` and the caller stops. The point
 * of asking is to not spend a model call, a battery budget and a morning planning a species that
 * cannot be kept, or water that is closed on the day. It is the one check in the whole path that
 * is about the law rather than the fish.
 */

import { getSeason, checkRegulations } from '../data/species-intel.js';
import { checkCoastalRegulations } from '../data/coastal-regulations.js';
import { COASTAL_ZONES, isCoastalKey } from '../data/coastal-zones.js';
import { resolveR2Key } from '../data/lake-keys.js';
import { lakeDbEntryFor } from '../data/lake-registry.js';

/** The coastal zone this water is, or null for everything inland. */
export function detectCoastalZone(lakeName) {
  const key = lakeName ? resolveR2Key(lakeName) : null;
  return isCoastalKey(key) ? key : null;
}

/**
 * May this species be fished on this water on this date?
 *
 * @returns {{legal: boolean, reason: string, warnings: string[], coastal: boolean}}
 */
export function checkPlanLegality(lakeName, species, date) {
  const zoneKey = detectCoastalZone(lakeName);
  const st = zoneKey ? (COASTAL_ZONES[zoneKey] || {}).state : null;
  let r;
  try {
    r = st ? checkCoastalRegulations(st, species, date) : checkRegulations(lakeName, species, date);
  } catch (e) {
    // A THROWN LOOKUP IS NOT PERMISSION. But it is also not a refusal — blocking every plan
    // because a table has a bad row would be worse than the thing it guards against. Say so
    // loudly, let it through, and let the warning carry into the plan.
    console.warn('[preflight] regulation check threw:', e && e.message);
    return { legal: true, reason: '', coastal: !!zoneKey,
             warnings: [`Could not check ${species} regulations here — verify before you keep one.`] };
  }
  return {
    legal: r ? r.legal !== false : true,
    reason: (r && r.reason) || '',
    warnings: (r && r.warnings) || [],
    coastal: !!zoneKey,
  };
}

const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
              'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/**
 * The day's forecast for this water: the line the plan form shows, AND the hourly wind the
 * safety call actually needs.
 *
 * WHY THE HOURLY ARRAY EXISTS
 *
 * This used to request `daily=windspeed_10m_max,winddirection_10m_dominant` and flatten it to one
 * sentence. The prompt then asks the model to rule on wind safety for a 12.5 ft kayak — sustained
 * over 15 mph or gusts over 20 is a no-go — against a DAILY MAXIMUM. A calm 06:00 and a 15 mph
 * noon are the same number, so the model either cancels a fishable dawn or blesses a day that
 * turns on him at eleven. PLAN_SCHEMA_V2 asks for `conditions.windByHour` and the app was
 * computing something else and calling it conditions.
 *
 * The array is clipped to the trip window when one is given, because wind at 22:00 is not a fact
 * about this trip and padding the prompt with it makes the real hours harder to see.
 *
 * @param {string} lakeName
 * @param {string} dateStr    YYYY-MM-DD
 * @param {object} [o]
 * @param {string} [o.launchTime] 'HH:MM' — clips the start of windByHour
 * @param {string} [o.returnTime] 'HH:MM' — clips the end
 * @returns {Promise<null|{summary:string, windByHour:{hour:number,mph:number,deg:number}[],
 *                         sunrise:string|null, sunset:string|null}>}
 *          null when there is no centre to ask about, or the fetch fails. NOT a partly-filled
 *          object: a caller cannot tell a missing forecast from a calm one otherwise.
 */
export async function fetchForecast(lakeName, dateStr, o = {}) {
  try {
    const zoneKey = detectCoastalZone(lakeName);
    const centre = (zoneKey && (COASTAL_ZONES[zoneKey] || {}).center)
                || (lakeDbEntryFor(lakeName) || {}).center;
    if (!centre) return null;
    const [lat, lon] = centre;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,'
      + 'windspeed_10m_max,winddirection_10m_dominant,precipitation_sum'
      // The hour-by-hour wind the safety rule is actually about.
      + '&hourly=windspeed_10m,winddirection_10m,windgusts_10m'
      + `&timezone=auto&start_date=${dateStr}&end_date=${dateStr}`;
    const res = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(4500) : undefined });
    if (!res.ok) return null;
    const d = await res.json();
    const D = d && d.daily;
    if (!D) return null;
    const dir = DIRS[Math.round(((D.winddirection_10m_dominant || [])[0] || 0) / 22.5) % 16];
    const mph = Math.round(((D.windspeed_10m_max || [])[0] || 0) * 0.621371);
    const precip = (D.precipitation_sum || [])[0] || 0;
    const hi = (D.temperature_2m_max || [])[0];
    const summary = `Wind ${dir} ${mph} mph · Precip ${precip}mm`
                  + (hi != null ? ` · High ${Math.round(hi)}°` : '');
    return {
      summary,
      windByHour: hourlyWind(d && d.hourly, o.launchTime, o.returnTime),
      sunrise: clock((D.sunrise || [])[0]),
      sunset: clock((D.sunset || [])[0]),
    };
  } catch (e) {
    console.warn('[preflight] forecast fetch failed:', e && e.message);
    return null;
  }
}

/** '2026-08-10T06:41' → '06:41'. Open-Meteo returns local time when timezone=auto. */
function clock(iso) {
  const m = /T(\d{2}:\d{2})/.exec(String(iso || ''));
  return m ? m[1] : null;
}

/** The hour of an Open-Meteo hourly timestamp, or null. */
function hourOf(iso) {
  const m = /T(\d{2}):/.exec(String(iso || ''));
  return m ? Number(m[1]) : null;
}

const hhToHour = (s) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s || ''));
  return m ? Number(m[1]) : null;
};

/**
 * [{hour, mph, deg}] for the trip window. Open-Meteo answers in km/h by default and the whole
 * app is mph, so the conversion happens here, once, with the same 0.621371 the daily line above
 * already uses. Gusts ride along when the API gives them: the no-go rule has a separate gust
 * threshold (20 mph) and dropping them would leave half of it unanswerable.
 */
export function hourlyWind(hourly, launchTime, returnTime) {
  const times = (hourly && hourly.time) || [];
  const speed = (hourly && hourly.windspeed_10m) || [];
  const deg = (hourly && hourly.winddirection_10m) || [];
  const gust = (hourly && hourly.windgusts_10m) || [];
  const from = hhToHour(launchTime), to = hhToHour(returnTime);
  const out = [];
  for (let i = 0; i < times.length; i++) {
    const h = hourOf(times[i]);
    if (h == null) continue;
    if (from != null && h < from) continue;
    if (to != null && h > to) continue;
    const mph = Number(speed[i]);
    if (!Number.isFinite(mph)) continue;
    const e = { hour: h, mph: Math.round(mph * 0.621371), deg: Math.round(Number(deg[i]) || 0) };
    const g = Number(gust[i]);
    if (Number.isFinite(g)) e.gustMph = Math.round(g * 0.621371);
    out.push(e);
  }
  return out;
}

export { getSeason };
