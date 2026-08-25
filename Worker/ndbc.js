/**
 * NDBC realtime2 — the measured half of the weather this app shows.
 *
 * WHY THIS EXISTS. Every wind number in TrollMap comes from NWS MapClick, which is a MODEL.
 * NDBC station LMFS1 sits ON Lake Murray, owned by NWS WFO Columbia, and publishes wind, gust
 * and air temperature every ten minutes. Nothing in the pipeline could see it: NDBC ids are a
 * separate namespace from the NWPS lids and USGS site numbers the registry is built from.
 * `bind_ndbc_stations.py` closes that, and this module reads what it binds.
 *
 * THE FORMAT, verified against live files on 2026-08-25:
 *
 *   https://www.ndbc.noaa.gov/data/realtime2/<ID>.txt      met
 *     #YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
 *     #yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft
 *     2026 08 25 22 50  80  3.6  6.2    MM    MM    MM  MM     MM  31.2    MM    MM   MM   MM    MM
 *
 *   https://www.ndbc.noaa.gov/data/realtime2/<ID>.ocean    water quality
 *     #YY  MM DD hh mm   DEPTH  OTMP   COND   SAL   O2% O2PPM  CLCON  TURB    PH    EH
 *     #yr  mo dy hr mn       m  degC  mS/cm   psu     %   ppm   ug/l   FTU     -    mv
 *     2026 08 25 23 00     2.6 28.80  55.54 36.70 110.0  6.90     MM    12  8.00    MM
 *
 * Two header lines, whitespace-delimited, NEWEST ROW FIRST, `MM` for every missing value, and
 * the timestamp is UTC in five separate columns.
 *
 * PARSED BY HEADER NAME, NEVER BY COLUMN POSITION. The two files have different columns in
 * different orders and NDBC has changed them before; the RDB parser in this codebase learned
 * the same lesson when `loc_web_ds` went empty and every counted offset moved by one.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE:
 *
 *   TURB IS FTU AND USGS 63680 IS FNU. Different instruments, different scattering geometry,
 *   and not interchangeable. It travels as `turbidity_ftu` so nothing can quietly merge it into
 *   the turbidity field the app already renders from USGS. Same rule this codebase already
 *   applies to salinity against specific conductance: convertible-looking is not the same as
 *   the same measurement.
 *
 *   SAL IS PSU AND USGS SALINITY IS PPT. Numerically close on the Practical Salinity Scale and
 *   still a different declared unit, so it keeps its own field and its own label.
 *
 *   A MET STATION IS NOT A GUST STATION. NIWS1 at Oyster Landing publishes WDIR and WSPD with
 *   GST `MM` on every row. `plan-preflight.js` calls a no-go at 20 mph gusts, so a null gust has
 *   to stay null and reach that check as "not measured here" rather than as calm.
 */

// m/s to mph. Every wind number this app displays is mph; NDBC publishes m/s.
const MPS_TO_MPH = 2.236936;

/** `MM` is NDBC's missing marker and it appears in every column of every file. */
function num(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === 'MM') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * One realtime2 file, parsed by header name.
 *
 * Returns { columns, units, observedAt, latest, rows } or null when the file has no data rows.
 * `latest` is the newest observation as a { COLUMN: number|null } map; `rows` is every row in
 * file order, newest first, because a trend needs more than one point and the caller may want
 * one without a second request.
 */
export function parseRealtime2(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\r$/, ''));
  const head = lines.find((l) => l.startsWith('#'));
  if (!head) return null;
  const unitLine = lines.slice(lines.indexOf(head) + 1).find((l) => l.startsWith('#'));
  const columns = head.replace(/^#/, '').trim().split(/\s+/);
  const unitCols = unitLine ? unitLine.replace(/^#/, '').trim().split(/\s+/) : [];
  const units = {};
  columns.forEach((c, i) => { units[c] = unitCols[i] || null; });

  const rows = [];
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const f = line.trim().split(/\s+/);
    // A SHORT ROW IS A TRUNCATED ROW, NOT A ROW OF NULLS. Zipping a short row against the header
    // shifts every value left of the gap into the wrong column, which is how a dewpoint becomes
    // a water temperature. Refuse it instead.
    if (f.length !== columns.length) continue;
    const r = {};
    columns.forEach((c, i) => { r[c] = num(f[i]); });
    rows.push(r);
  }
  if (!rows.length) return null;

  // HOW OFTEN THIS STATION REPORTS, TAKEN FROM THE STATION. LMFS1 writes every 10 minutes and
  // the NERRS sondes every 15, and nothing in the file states which. The gap between the two
  // newest rows IS the interval, so staleness can be judged against what this station actually
  // does instead of against a number somebody picked. A reading is stale here at three missed
  // reports, which is the station being down rather than a late one.
  const gapMin = (a, b) => {
    const t = (r) => Date.UTC(r.YY, (r.MM ?? 1) - 1, r.DD, r.hh, r.mm);
    const d = (t(a) - t(b)) / 60000;
    return Number.isFinite(d) && d > 0 ? Math.round(d) : null;
  };
  const intervalMin = rows.length > 1 ? gapMin(rows[0], rows[1]) : null;

  const l = rows[0];
  // The five date columns are UTC and are always the first five, in both file kinds. They are
  // read by NAME anyway, so a future file that reorders them still lands right.
  // `MM` is the MONTH column here and also NDBC's missing marker elsewhere in the same file.
  // They never collide because this is read by column name, not by scanning for the string.
  const { YY: y, MM: mo, DD: d, hh: h, mm: mi } = l;
  const observedAt = [y, mo, d, h, mi].every((v) => Number.isFinite(v))
    ? new Date(Date.UTC(y, mo - 1, d, h, mi)).toISOString()
    : null;
  return { columns, units, observedAt, intervalMin, latest: l, rows };
}

/**
 * The met file, in the units this app displays, with every absence preserved as null.
 *
 * `MM` in NDBC and `null` here mean the same thing and neither means zero. A station that
 * publishes no gust must not read as a station reporting no gusts.
 */
function freshness(parsed, now) {
  const t = Date.parse(parsed.observedAt || '');
  const age = Number.isFinite(t) ? Math.max(0, Math.round(((now || Date.now()) - t) / 60000)) : null;
  // THREE MISSED REPORTS, measured against this station's own clock. Without an interval we
  // cannot say, and saying nothing is correct: `stale` stays null rather than guessing false.
  const iv = parsed.intervalMin;
  const stale = (age != null && Number.isFinite(iv)) ? age > iv * 3 : null;
  return { age_minutes: age, interval_min: Number.isFinite(iv) ? iv : null, stale };
}

export function shapeMet(parsed, station, now) {
  if (!parsed) return null;
  const l = parsed.latest;
  const mph = (v) => (v == null ? null : Math.round(v * MPS_TO_MPH * 10) / 10);
  const f = (c) => (c == null ? null : Math.round((c * 9 / 5 + 32) * 10) / 10);
  return {
    station: station && station.feed_id ? station.feed_id : null,
    name: (station && station.name) || null,
    km_from_water: station && Number.isFinite(station.km_outside) ? station.km_outside : null,
    observed_at: parsed.observedAt,
    ...freshness(parsed, now),
    wind_dir_deg: l.WDIR,
    wind_mph: mph(l.WSPD),
    gust_mph: mph(l.GST),
    air_c: l.ATMP, air_f: f(l.ATMP),
    dewpoint_c: l.DEWP, dewpoint_f: f(l.DEWP),
    pressure_mb: l.PRES,
    // PRESSURE TENDENCY, which nothing else in this app carries. NDBC publishes the three-hour
    // change in hPa, signed. A falling barometer is a fishing signal older than the app.
    pressure_tendency_mb: l.PTDY,
    // Present in the met file's header and `MM` at every NERRS station measured so far; the
    // reservoir C-MAN stations do not publish it either. Read anyway, because a station that
    // starts publishing it should not need a code change to be believed.
    water_c: l.WTMP, water_f: f(l.WTMP),
    source: 'NDBC — realtime2 met',
  };
}

/**
 * The .ocean file. This is the one that matters on the coast: it is a water-quality sonde, and
 * it carries the water temperature those cards have never had.
 *
 * Measured at Oyster Landing (NIQS1) 2026-08-25 23:00Z: 28.80 degC, 36.70 psu, 6.90 ppm O2,
 * TURB 12 FTU, pH 8.00, sonde at 2.6 m — with salinity climbing 32.4 to 36.7 psu across four
 * hours while the sonde depth rose 1.7 to 2.6 m. That is the flood tide pushing salt upstream,
 * which is a fishing fact and not a water-quality one.
 */
export function shapeOcean(parsed, station, now) {
  if (!parsed) return null;
  const l = parsed.latest;
  const f = (c) => (c == null ? null : Math.round((c * 9 / 5 + 32) * 10) / 10);
  return {
    station: station && station.feed_id ? station.feed_id : null,
    name: (station && station.name) || null,
    km_from_water: station && Number.isFinite(station.km_outside) ? station.km_outside : null,
    observed_at: parsed.observedAt,
    ...freshness(parsed, now),
    // The DEPTH the sonde sat at when it took the reading. On a tidal creek this is not a lake
    // level and must never be rendered as one -- it moves with the tide by design.
    sonde_depth_m: l.DEPTH,
    water_c: l.OTMP, water_f: f(l.OTMP),
    // psu, NOT the ppt USGS publishes under 00480. Kept apart on purpose; see the file header.
    salinity_psu: l.SAL,
    conductance_ms_cm: l.COND,
    oxygen_pct: l['O2%'],
    oxygen_ppm: l.O2PPM,
    chlorophyll_ug_l: l.CLCON,
    // FTU, NOT the FNU of USGS 63680. Kept apart on purpose; see the file header.
    turbidity_ftu: l.TURB,
    ph: l.PH,
    source: 'NDBC — realtime2 ocean',
  };
}

export const NDBC_BASE = 'https://www.ndbc.noaa.gov/data/realtime2';

export function ndbcUrl(feedId, kind) {
  return `${NDBC_BASE}/${String(feedId).toUpperCase()}.${kind === 'ocean' ? 'ocean' : 'txt'}`;
}

/**
 * Read every station a water binds, met and ocean, and return the best of each.
 *
 * NEAREST WINS, AND ONLY AMONG STATIONS THAT ANSWERED. A station 0 km away that returned
 * nothing must not beat one 2 km away that returned a reading -- the binding order is a
 * preference, not a result. `stations` is the water's `ndbc` block, already sorted by distance
 * by the binder.
 *
 * `getText` is injected so this is testable without a network and so it shares the caller's
 * cache and TTL rather than opening a second one.
 */
export async function ndbcReadings(stations, getText) {
  const list = Array.isArray(stations) ? stations : [];
  if (!list.length) return null;
  let met = null;
  let ocean = null;
  for (const s of list) {
    if (!s || !s.feed_id) continue;
    if (!met && s.met) {
      try {
        const p = parseRealtime2(await getText(ndbcUrl(s.feed_id, 'met')));
        const shaped = shapeMet(p, s);
        // A file that parsed but carries no wind is not a wind station today.
        if (shaped && (shaped.wind_mph != null || shaped.air_c != null)) met = shaped;
      } catch (_) { /* try the next station rather than failing the water */ }
    }
    if (!ocean && s.water_quality) {
      try {
        const p = parseRealtime2(await getText(ndbcUrl(s.feed_id, 'ocean')));
        const shaped = shapeOcean(p, s);
        if (shaped && (shaped.water_c != null || shaped.salinity_psu != null)) ocean = shaped;
      } catch (_) { /* same */ }
    }
    if (met && ocean) break;
  }
  return (met || ocean) ? { met, ocean } : null;
}
