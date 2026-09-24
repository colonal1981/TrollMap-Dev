/**
 * Worker/river-geometry.js -- the river's own centreline and landings, read by the Worker.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS EXISTS. Every one of the 57 river packs ships a `centreline.geojson` -- the 3DHP
 * mainstem in downstream order, a station every 50 m, with the channel width and the charted
 * cross-section at each -- and a `launches.json` placing every landing on it by river metre.
 * The app has read both since 2026-09-18. The Worker read neither, so the two things /river
 * exists to answer about a river it did not have a hand-typed table for -- where on the river
 * you are, and how fast the water is moving there -- were answered for six rivers out of 57.
 *
 * And on one of the six the hand table was badly wrong. RIVERS.wateree places WT Billy Tolar at
 * river mile 29 and the confluence at 48, from "a sinuosity factor ~1.07" applied to straight
 * lines. The pack's own mainstem puts WT Billy Tolar at 82,800 m -- 51.4 miles -- and the river at
 * 123 km. The Wateree meanders; a 7% allowance for it does not survive the first bend below
 * Camden. Only the first 7.4 miles, which USGS measured, agree.
 *
 * READ ONCE PER ISOLATE, KEPT SLIM. The centreline is ~280 KB with a depth profile at every
 * station; only the arrays this module uses are kept after the parse.
 */
import { chartpackKey, r2Text } from './worker-core.js';

const CFS_TO_CMS = 0.0283168466;
const MS_TO_MPH = 2.2369363;
// THE SAME GUARD THE APP USES, FOR THE SAME REASON. A section with less than 2 ft charted anywhere
// in it is thin chart, not a shallow river, and dividing a discharge by it returns 8 mph on a river
// doing one. Measured by the centreline builder before any of it was wired: see REAL_SECTION_FT in
// js/modules/river-drifts.js, which this must agree with (the test holds them together).
export const REAL_SECTION_FT = 2;

const _geom = new Map();
const TTL_MS = 60 * 60 * 1000;

/** The pack's centreline and landings, slimmed. null when the pack has no centreline. */
export async function riverGeometry(env, slug, nowMs = Date.now()) {
  const key = String(slug || '').trim();
  if (!key) return null;
  const hit = _geom.get(key);
  if (hit && nowMs - hit.at < TTL_MS) return hit.geom;
  const bucket = env && env.R2_TROLLMAP_CHARTPACKS;
  if (!bucket) return null;
  let geom = null;
  try {
    const obj = await bucket.get(chartpackKey(key, 'centreline.geojson'));
    if (obj) {
      geom = slimCentreline(JSON.parse(await r2Text(obj)));
      if (geom) {
        const lo = await bucket.get(chartpackKey(key, 'launches.json'));
        geom.landings = lo ? slimLandings(JSON.parse(await r2Text(lo))) : [];
      }
    }
  } catch (err) {
    console.warn(`[river-geometry] ${key}: ${err && err.message}`);
    geom = null;
  }
  _geom.set(key, { at: nowMs, geom });
  return geom;
}

/** Test seam. */
export function _resetRiverGeometry() { _geom.clear(); }

/** Only what this module reads, as flat arrays. Pure. */
export function slimCentreline(fc) {
  const f = fc && fc.features && fc.features[0];
  const line = f && f.geometry && f.geometry.coordinates;
  const p = (f && f.properties) || {};
  const st = p.station_m || [];
  const n = Math.min(Array.isArray(line) ? line.length : 0, st.length);
  if (n < 2) return null;
  const lon = new Float64Array(n), lat = new Float64Array(n), m = new Float64Array(n);
  const area = new Float64Array(n), deep = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    lon[i] = Number(line[i][0]); lat[i] = Number(line[i][1]); m[i] = Number(st[i]);
    const a = Number((p.area_m2 || [])[i]);
    const d = Number((p.deepest_line_ft || [])[i]);
    area[i] = Number.isFinite(a) ? a : NaN;
    deep[i] = Number.isFinite(d) ? d : NaN;
  }
  return { slug: p.slug || null, n, lon, lat, m, area, deep,
           length_m: Number(p.length_m) || m[n - 1], step_m: Number(p.step_m) || 50,
           // The builder's own limit on how far off the line a point may be and still be ON it.
           snap_cap_m: Number.isFinite(Number(p.snap_cap_m)) ? Number(p.snap_cap_m) : null,
           landings: [] };
}

const GENERIC = new Set(['river', 'creek', 'lake', 'canal', 'below', 'above', 'dam', 'the', 'and',
                         'from', 'near', 'lower', 'upper', 'tailrace']);
const words = (s) => new Set(String(s || '').toLowerCase().replace(/_/g, ' ').match(/[a-z]{3,}/g)
  ?.filter((w) => !GENERIC.has(w)) || []);

/**
 * WHICH PACK A HAND-WRITTEN RIVERS ENTRY IS, derived from the bindings rather than typed.
 *
 * The six RIVERS keys are words -- `wateree`, `broad` -- and the packs are slugs. The binding
 * already carries the same USGS sites the entry lists, so the pack is the bound river that carries
 * one of those gauges AND shares a name with the entry. Both halves are needed, measured
 * 2026-09-24: the Broad's Carlisle gauge is also bound to congaree_river, and the Santee's
 * Pineville gauge to rediversion_canal. Ambiguous or empty answers null, and a null here is a
 * river with no geometry rather than a river with someone else's.
 */
export function packSlugFor(key, cfg, bound) {
  if (bound && bound[key]) return key;
  const sites = new Set(((cfg && cfg.gauges) || []).map((g) => String(g.site)));
  const mine = words(cfg && cfg.label);
  const hits = [];
  for (const [slug, rec] of Object.entries(bound || {})) {
    const gs = [rec.pool, rec.tailwater, ...(rec.gauges || [])].filter(Boolean);
    if (!gs.some((g) => sites.has(String(g.usgs_site)))) continue;
    const theirs = new Set([...words(slug), ...words(rec.display_name)]);
    if ([...mine].some((w) => theirs.has(w))) hits.push(slug);
  }
  return hits.length === 1 ? hits[0] : null;
}

/** Landings with a river metre. Pure. */
export function slimLandings(doc) {
  const rows = (doc && (doc.landings || doc)) || [];
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.name && Number.isFinite(Number(r.station_m)))
    .map((r) => ({ name: String(r.name), station_m: Number(r.station_m),
                   lat: Number(r.lat), lon: Number(r.lon) }))
    .sort((a, b) => a.station_m - b.station_m);
}

function metres(lat1, lon1, lat2, lon2) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const s = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Where a point is on the river: the nearest station, and how far off the line the point is.
 *
 * A FULL SCAN, NOT A COARSE ONE. 2,478 stations on the Wateree is a trivial loop, and the app's
 * coarse-then-fine exists for thousands of calls per plan; this is one per request, and a coarse
 * pass is exactly what lands a point on the wrong arm of a hairpin.
 */
export function stationAt(geom, lat, lon) {
  if (!geom || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let bi = -1, bd = Infinity;
  for (let i = 0; i < geom.n; i += 1) {
    const d = metres(lat, lon, geom.lat[i], geom.lon[i]);
    if (d < bd) { bd = d; bi = i; }
  }
  return bi < 0 ? null : { i: bi, station_m: geom.m[bi], off_m: Math.round(bd) };
}

/**
 * The stretch a day from this point actually lives on: from the nearest landing upstream to the
 * nearest landing downstream, or the river's end where there is none. A LANDING IS WHERE A DAY
 * STARTS AND ENDS, so this is the water between two places he can get out, which is the question
 * a go/no-go on moving water is really asking. No distance is chosen here.
 */
export function stretchAround(geom, stationM) {
  if (!geom) return null;
  const L = geom.landings || [];
  let up = null, down = null;
  for (const l of L) {
    if (l.station_m < stationM - 1) up = l;
    else if (l.station_m > stationM + 1 && !down) down = l;
  }
  return { from_m: up ? up.station_m : geom.m[0], to_m: down ? down.station_m : geom.m[geom.n - 1],
           from: up ? up.name : 'the top of the charted river',
           to: down ? down.name : 'the bottom of the charted river' };
}

/**
 * HOW FAST THE WATER IS MOVING, AS V = Q/A, per station, between two river metres.
 *
 * Per station and then summarised -- not the discharge over a mean section -- exactly as
 * river-drifts.js does it, so the Worker's number and the app's can be checked against each other
 * and against FOUR_THINGS_A_RIVER_DAY_HAS_TO_TELL_HIM's Congaree measurement (p10 0.60, p50 0.96,
 * p90 2.17 mph at 3,000 cfs). The median is the water you are usually on; the 90th percentile is
 * the fastest tenth, which is where a boat going back upstream is stopped.
 *
 * A TIDAL RIVER IS REFUSED, NOT COMPUTED: its current reverses and Q/A does not describe it.
 */
export function currentBetween(geom, fromM, toM, cfs, { tidal = false } = {}) {
  if (!geom) return { basis: 'no centreline for this river' };
  if (tidal) return { basis: 'tidal - the current reverses here, so Q/A does not describe it' };
  if (!Number.isFinite(cfs) || cfs < 0) return { basis: 'no discharge reading for this river' };
  const lo = Math.min(fromM, toM), hi = Math.max(fromM, toM);
  let stations = 0;
  const v = [];
  for (let i = 0; i < geom.n; i += 1) {
    if (geom.m[i] < lo || geom.m[i] > hi) continue;
    stations += 1;
    const a = geom.area[i], d = geom.deep[i];
    if (Number.isFinite(a) && a > 0 && Number.isFinite(d) && d >= REAL_SECTION_FT) {
      v.push((cfs * CFS_TO_CMS / a) * MS_TO_MPH);
    }
  }
  if (!v.length) {
    return { stations, basis: `no station on this stretch has ${REAL_SECTION_FT} ft or more of `
                            + 'charted section, so there is nothing honest to divide the flow by' };
  }
  v.sort((x, y) => x - y);
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
  const mid = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return {
    median_mph: Number(mid.toFixed(2)),
    p90_mph: Number(q(0.9).toFixed(2)),
    stations,
    measured_stations: v.length,
    cfs,
    basis: `Q/A - ${v.length} of ${stations} stations carry ${REAL_SECTION_FT} ft or more of charted `
         + `section, at ${Math.round(cfs).toLocaleString('en-US')} ft3/s from the river's gauge`,
  };
}

/**
 * THE BOAT, IN RYAN'S OWN NUMBER. 2026-09-24: "full speed with the nk180pro flat on a lake is
 * somewhere around 5.5mph pedaling does not add anything to this really".
 *
 * The one input to a moving-water go/no-go that no gauge publishes. Kept in one place, with his
 * words, so that when the boat or the motor changes there is one line to change.
 */
export const BOAT = Object.freeze({ topSpeedMph: 5.5, said: '2026-09-24',
  quote: 'full speed with the nk180pro flat on a lake is somewhere around 5.5mph' });

/**
 * THE MOVING-WATER VERDICT, from how fast the water is going against how fast the boat can go.
 *
 * Agreed with Ryan 2026-09-24, after measuring the alternatives against his own six hand-set
 * bands over 36 years of daily flow: NWS action stage sits ABOVE every one of his danger lines
 * (Wateree 12,031 cfs against his 8,000), and "unusually high for the date" is the wrong axis --
 * a per-date 90th/95th rule called the Wateree GO on 1,601 of the 2,854 days his numbers call
 * no-go, because 8,000 cfs is ordinary in winter and moves just as fast.
 *
 *   no-go    the fastest tenth of the stretch is at or above the boat's top speed: going back up
 *            through it, the boat stands still.
 *   caution  the stretch's usual current is at or above half the boat's top speed: every mile back
 *            up takes at least twice as long as it would on still water.
 *
 * Returns null when there is no current to judge -- the caller says why from `current.basis`.
 */
export function currentVerdict(current, boat = BOAT) {
  if (!current || !Number.isFinite(current.median_mph)) return null;
  const top = boat.topSpeedMph;
  // THE SUPPORT TRAVELS WITH THE NUMBER, AND SO DOES WHAT IT CANNOT SEE. A speed from 7 of 3,815
  // sections (the Nolichucky) and one from 2,192 of 3,133 (the Congaree) are not the same claim,
  // and no threshold on that ratio is invented here -- it is said. And the 2 ft guard that keeps
  // thin chart out also keeps SHOALS out, which is where a river runs fastest: on a shoal river
  // this speed is the pools', and the verdict says so rather than implying it covers the riffles.
  const support = Number.isFinite(current.measured_stations)
    ? ` (from ${current.measured_stations} of ${current.stations} sections; water under `
      + `${REAL_SECTION_FT} ft is not measured and runs faster)` : '';
  const where = current.stretch && current.stretch.from
    ? `between ${current.stretch.from} and ${current.stretch.to}` : 'on this river';
  if (current.p90_mph >= top) {
    return { status: 'no-go',
             reason: `The fastest stretches ${where} are running `
                   + `~${current.p90_mph} mph - at or above the ${top} mph the boat does flat out. `
                   + `Going back up through them, it stands still${support}.` };
  }
  if (current.median_mph >= top / 2) {
    return { status: 'caution',
             reason: `The current here is running ~${current.median_mph} mph, over half the boat's `
                   + `${top} mph top speed - every mile back upstream takes at least twice as long `
                   + `as it would on still water${support}.` };
  }
  return { status: 'go',
           reason: `Current ~${current.median_mph} mph here (fastest stretches ~${current.p90_mph}), `
                 + `well under the boat's ${top} mph${support}.` };
}
