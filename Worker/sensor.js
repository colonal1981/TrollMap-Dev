/**
 * sensor.js — operator-run sensors that are not USGS, not CWMS and not NWS.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * NO CREDENTIALS, AND IT MUST NEVER BE GIVEN ONE. No Authorization header, no cookie, no key.
 * A public LI-COR Cloud dashboard authorises the call with `dashboardUUID` in the BODY -- the
 * dashboard's own public id -- which is why a bare request to the endpoint 404s: without it the
 * server does not know what is being asked for. The request shape here is not inferred; it is
 * the one `scripts/fetch_licor_dashboard.py` captured from the browser on 2026-08-27, and that
 * script's docstring carries the same prohibition.
 *
 * WHY THIS EXISTS. Randleman Lake (Randolph Co, NC) is 2,919 acres with no USGS, CWMS or NWS
 * level gauge on it -- its only bound USGS site is DEEP RIVER NEAR RANDLEMAN, below the dam,
 * which answers `no current value`. The Piedmont Triad Regional Water Authority runs a
 * temperature and level sensor on the lake and publishes it on a public dashboard. That feed
 * was recorded in registry/_sensor_feeds.json on 2026-08-27, bound into water_bindings.json as
 * `levels.primary: 'sensor'`, and then read by nothing at all, so the card kept saying
 * `full pool is known; today's level is not`. Ryan, 2026-08-28: "Randleman lake does not show
 * the gauge we added when i look at the map for it".
 */

const BASE = 'https://www.licor.cloud';

/** The reading a `sensor` levels-source describes, or null. Pure, so it can be tested. */
export function shapeSensor(json, source) {
  const recs = ((json && json.value) || {}).records || [];
  if (!recs.length) return null;
  const want = String((source && source.key && source.key.metric) || '').toLowerCase();
  const chan = String((source && source.key && source.key.channel) || '').toLowerCase();
  const out = { level_ft: null, water_f: null, observed_at: null, station: null, series: [] };
  for (const r of recs) {
    const pts = ((r && r.datum) || {}).valid || [];
    if (!pts.length) continue;
    const [ts, v] = pts[pts.length - 1];
    if (!Number.isFinite(v)) continue;
    const units = String(r.metricUnits || '').toLowerCase();
    const at = Number.isFinite(ts) ? new Date(ts).toISOString() : null;
    const isThis = String(r.channelUUID || '').toLowerCase() === chan
      || String(r.metricName || '').toLowerCase() === want;
    // FEET IS NOT A DEPTH HERE AND THE MAGNITUDE IS WHAT SAYS SO. Randleman's sensor reads
    // 681.46 against a full pool of 682: an ELEVATION in the same frame, not a stage above a
    // local zero. The caller checks that against full pool before subtracting; this only
    // reports what the instrument said and in what units.
    if (units.includes('feet') || units.includes('ft')) {
      if (isThis || out.level_ft == null) {
        out.level_ft = Math.round(v * 100) / 100;
        out.observed_at = at;
        out.units = r.metricUnits || null;
        out.metric = r.metricName || null;
        out.station = r.sensorSerialNumber || r.deviceSerialNumber || null;
      }
    } else if (units.includes('f')) {
      out.water_f = Math.round(v * 10) / 10;
      out.water_observed_at = at;
    }
  }
  return (out.level_ft == null && out.water_f == null) ? null : out;
}

/**
 * Ask a public dashboard for the last day of one channel.
 *
 * `limit` and the five-minute bucket are the dashboard's own defaults; a day is asked for so a
 * sensor that reports slowly still answers, and only the LAST point is used.
 */
export async function sensorReading(source, postJson) {
  const key = (source && source.key) || {};
  if (!key.dashboard || !key.channel || !key.metric) return null;
  const body = {
    channels: [{
      channelUUID: key.channel,
      channelType: 'dataChannel',
      metricName: key.metric,
      limit: 500,
      aggregationFunction: 'avg',
      aggregationInterval: { value: 5, unit: 'minutes' },
    }],
    time: { relative: { last: 1, unit: 'days' } },
    dashboardUUID: key.dashboard,
  };
  const json = await postJson(`${BASE}/api/v2/timeseriesdata`, body,
                              `${BASE}/dashboards/public/${key.dashboard}/true`);
  const shaped = shapeSensor(json, source);
  if (shaped) shaped.name = source.name || null;
  return shaped;
}

/** The `sensor` source on a binding's levels block, if there is one. */
export function sensorSourceOf(b) {
  const list = ((b && b.levels) || {}).sources || [];
  return list.find((s) => s && s.source === 'sensor') || null;
}
