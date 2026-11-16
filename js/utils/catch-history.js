/**
 * catch-history.js -- the lake and the weather at the hour of a catch, filled when the catch is
 * made, not when a button is pressed.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-11-15: "for the catch log is there way for the gpx and photo import to trigger the
 * history check automatically so i don't have to press a button to get lake and weather", and,
 * told it would run on the drop's own catches with the button kept for the rest: "please we can
 * test it the next time".
 *
 * WHAT THE CHECK IS. One pass over some review-queue items (catch-journal.js supplies both halves):
 *   - `enrich(item)`: the lake from the catch's position, and a chart depth only where there is no
 *     depth (enrichItemFromGps(): a depth his sounder gave at the waypoint is never looked up again);
 *   - `fetchWeather(item)`: air temperature, wind, cloud and pressure at the hour of the catch from
 *     the Open-Meteo archive, with the moon (fetchHistoricalWeatherForItem()).
 * The Nightly Catch Upload runs it on the catches it has just added, and "Check Missing History"
 * runs it on the whole queue -- the same function, so the two cannot drift apart.
 *
 * AN EMPTY ANSWER IS NOT WEATHER. The archive answers a date it has no hours for with nulls, and
 * the journal used to store that as `weather: {tempF: null, ...}`. That is truthy, so the button
 * skipped it from then on and the catch kept "?°F" for good. Weather is only had when at least one
 * of its numbers is (hasWeather()); otherwise the catch is flagged and the button tries it again.
 * Checked the night of 11/15: the archive already held every hour of that day at Wateree, so a
 * same-evening drop gets its weather.
 *
 * Nothing here touches the DOM or the network; both come in as functions, so it runs under node.
 */

/** The numbers that make a weather record. The moon is worked out locally and does not count. */
export const WEATHER_NUMBERS = ['tempF', 'windMph', 'cloudPct', 'pressureHpa'];

/** True when the record holds at least one of the weather numbers. */
export function hasWeather(w) {
  return !!w && typeof w === 'object' && WEATHER_NUMBERS.some(k => Number.isFinite(w[k]));
}

const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const num = (v) => (Number.isFinite(v) ? v : null);

/**
 * The weather at one hour of an Open-Meteo archive answer (hourly temperature_2m, surface_pressure,
 * cloudcover, windspeed_10m, winddirection_10m, local time), or null when that hour holds none.
 */
export function weatherAtHour(data, hour, moonPhase = '', fetchedAt = new Date().toISOString()) {
  const h = data?.hourly || {};
  const at = (k) => (Array.isArray(h[k]) ? h[k][hour] : undefined);
  const w = {
    tempF: round1(at('temperature_2m')),
    pressureHpa: Number.isFinite(at('surface_pressure')) ? Math.round(at('surface_pressure')) : null,
    cloudPct: num(at('cloudcover')),
    windMph: round1(at('windspeed_10m')),
    windDir: num(at('winddirection_10m')),
    moonPhase,
    source: 'open-meteo-archive',
    fetchedAt,
  };
  return hasWeather(w) ? w : null;
}

function flag(item, f) {
  if (!Array.isArray(item.reviewFlags)) item.reviewFlags = [];
  if (!item.reviewFlags.includes(f)) item.reviewFlags.push(f);
}
function unflag(item, f) {
  if (Array.isArray(item.reviewFlags)) item.reviewFlags = item.reviewFlags.filter(x => x !== f);
}

/**
 * Fill the lake, a missing depth and missing weather on each item, in order.
 *
 * items: review-queue items (changed in place)
 * o.enrich(item):        sync; fills lake and depth (catch-journal.js: enrichItemFromGps)
 * o.fetchWeather(item):  async; a weather record, or null, or throws
 * o.onStep(i, n, item):  before each item, for a status line
 * o.wait(ms), o.pause:   between archive calls (250 ms, as the button always waited)
 *
 * Returns { lakeFilled, depthFilled, weatherFilled, failed, checked }.
 */
export async function checkHistory(items, o = {}) {
  const list = Array.isArray(items) ? items : [];
  const enrich = o.enrich || ((x) => x);
  const fetchWeather = o.fetchWeather || (async () => null);
  const wait = o.wait || ((ms) => new Promise(r => setTimeout(r, ms)));
  const pause = Number.isFinite(o.pause) ? o.pause : 250;
  let lakeFilled = 0, depthFilled = 0, weatherFilled = 0, failed = 0;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item) continue;
    o.onStep?.(i, list.length, item);
    const lakeBefore = item.lake, depthBefore = item.depth;
    enrich(item);
    if (!lakeBefore && item.lake) lakeFilled++;
    if (!depthBefore && item.depth) depthFilled++;
    const when = item.datetime || item.date;
    if (!hasWeather(item.weather) && when) {
      if (item.lat && item.lon) {
        try {
          const w = await fetchWeather(item);
          if (hasWeather(w)) {
            item.weather = w;
            weatherFilled++;
            flag(item, 'weather_from_archive');
            unflag(item, 'weather_lookup_failed');
          } else {
            failed++;
            flag(item, 'weather_lookup_failed');
          }
        } catch (e) {
          failed++;
          flag(item, 'weather_lookup_failed');
        }
        if (i < list.length - 1) await wait(pause);   // avoid hammering Open-Meteo
      } else {
        flag(item, 'weather_missing_gps');
      }
    }
    item.updatedAt = new Date().toISOString();
  }
  return { lakeFilled, depthFilled, weatherFilled, failed, checked: list.length };
}

/** The drop's status-line sentence for what the check found on its n catches. */
export function historySentence(r, n) {
  if (!r || !n) return '';
  if (r.lakeFilled === n && r.weatherFilled === n) {
    return n === 1 ? 'Lake and weather filled in.' : `Lake and weather filled in for all ${n}.`;
  }
  return `Lake found for ${r.lakeFilled} of ${n}, weather for ${r.weatherFilled} of ${n}`
    + (r.failed ? `; the weather archive had nothing for ${r.failed}, and “Check Missing History” will try again` : '')
    + '.';
}
