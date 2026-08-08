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
 * The day's forecast for this water, as the one line the plan form and the prompt both read.
 *
 * Wind is the whole reason this matters. The prompt judges a 12.5 ft kayak against it — sustained
 * over 15 mph or gusts over 20 is a no-go — and a windward ramp on the wrong day is the safety
 * call the model is asked to make. Without this it was being asked to judge wind it had never
 * been told about.
 *
 * @returns {Promise<string>} '' when there is no centre to ask about, or the fetch fails.
 */
export async function fetchForecast(lakeName, dateStr) {
  try {
    const zoneKey = detectCoastalZone(lakeName);
    const centre = (zoneKey && (COASTAL_ZONES[zoneKey] || {}).center)
                || (lakeDbEntryFor(lakeName) || {}).center;
    if (!centre) return '';
    const [lat, lon] = centre;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,'
      + 'windspeed_10m_max,winddirection_10m_dominant,precipitation_sum'
      + `&timezone=auto&start_date=${dateStr}&end_date=${dateStr}`;
    const res = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(4500) : undefined });
    if (!res.ok) return '';
    const d = await res.json();
    const D = d && d.daily;
    if (!D) return '';
    const dir = DIRS[Math.round(((D.winddirection_10m_dominant || [])[0] || 0) / 22.5) % 16];
    const mph = Math.round(((D.windspeed_10m_max || [])[0] || 0) * 0.621371);
    const precip = (D.precipitation_sum || [])[0] || 0;
    const hi = (D.temperature_2m_max || [])[0];
    return `Wind ${dir} ${mph} mph · Precip ${precip}mm`
         + (hi != null ? ` · High ${Math.round(hi)}°` : '');
  } catch (e) {
    console.warn('[preflight] forecast fetch failed:', e && e.message);
    return '';
  }
}

export { getSeason };
