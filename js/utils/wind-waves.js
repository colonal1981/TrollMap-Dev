/**
 * wind-waves.js — how much open water the wind has to build waves on, and what it builds.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Change request 22. Ryan, 2026-09-26, on why he left the Wateree plan: *"The routes would have
 * taken me way too far from the ramp with 1-2 ft swells due to the wind... So as you can see i kept
 * in closer to the coves so i had somewhere to get out of the wind if it got too bad"*. The plan
 * had the hourly wind and the water's own outline all along, and never asked which legs the wind
 * was blowing across.
 *
 * TWO MEASUREMENTS AND NO CUT-OFF OF OURS.
 *
 * FETCH is the open water upwind of a point: a ray from the point toward where the wind comes FROM,
 * to the first edge of the water's boundary. Islands are rings in that boundary, so an island
 * upwind ends the fetch the way it ends the waves.
 *
 * WAVE HEIGHT is the Shore Protection Manual's (1984) fetch-limited formula for shallow water --
 * wind speed, fetch and depth in, significant wave height out. It is the standard engineering
 * answer for an enclosed lake, not a threshold: the numbers come out of physics, and what counts as
 * too rough is his to say (1-2 ft was, on 2026-09-26).
 */

const M_PER_DEG = 111320;
const G = 9.81;

/**
 * A function that measures fetch on this water, or null when there is no boundary to measure on.
 *
 * Built once per plan: the rings are flattened into one array of edges, and each question is one
 * pass over them. 50,000 edges (Lake Murray) is about a millisecond a ray.
 *
 * @param {object} boundaryFc   the water's boundary.geojson
 * @returns {?function(number, number, number): ?number}  (lon, lat, fromDeg) -> metres, or null
 *          when the ray meets no edge (a point off this water)
 */
export function shoreRays(boundaryFc) {
  const rings = [];
  for (const f of ((boundaryFc && boundaryFc.features) || (boundaryFc ? [boundaryFc] : []))) {
    const g = f && f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') rings.push(...g.coordinates);
    else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) rings.push(...poly);
  }
  let n = 0;
  for (const r of rings) n += Math.max(0, r.length - 1);
  if (!n) return null;
  const E = new Float64Array(n * 4);            // lon0, lat0, lon1, lat1 per edge
  let k = 0;
  for (const r of rings) {
    for (let i = 1; i < r.length; i++) {
      E[k++] = r[i - 1][0]; E[k++] = r[i - 1][1]; E[k++] = r[i][0]; E[k++] = r[i][1];
    }
  }
  return (lon, lat, fromDeg) => {
    if (![lon, lat, fromDeg].every(Number.isFinite)) return null;
    const kx = M_PER_DEG * Math.cos(lat * Math.PI / 180), ky = M_PER_DEG;
    const th = fromDeg * Math.PI / 180;
    const dx = Math.sin(th), dy = Math.cos(th);   // toward where the wind comes FROM
    let best = Infinity;
    for (let i = 0; i < E.length; i += 4) {
      const ax = (E[i] - lon) * kx, ay = (E[i + 1] - lat) * ky;
      const ex = (E[i + 2] - E[i]) * kx, ey = (E[i + 3] - E[i + 1]) * ky;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = (ax * ey - ay * ex) / den;        // along the ray
      if (t <= 0 || t >= best) continue;
      const s = (ax * dy - ay * dx) / den;        // along the edge
      if (s < 0 || s > 1) continue;
      best = t;
    }
    return Number.isFinite(best) ? best : null;
  };
}

/**
 * Significant wave height from wind, fetch and depth -- Shore Protection Manual (1984), eq. 3-39,
 * with its wind-stress factor U_A = 0.71 U^1.23 (U in m/s at 10 m, which is what Open-Meteo sends).
 *
 * @param {number} mph      sustained wind
 * @param {number} fetchM   open water upwind
 * @param {number} [depthFt] water depth; absent means deep water
 * @returns {?number} feet, or null when an input is missing
 */
export function waveHeightFt(mph, fetchM, depthFt) {
  if (!Number.isFinite(mph) || !Number.isFinite(fetchM)) return null;
  if (mph <= 0 || fetchM <= 0) return 0;
  const U = mph * 0.44704;
  const UA = 0.71 * Math.pow(U, 1.23);
  const u2 = UA * UA;
  const d = Number.isFinite(depthFt) && depthFt > 0 ? depthFt * 0.3048 : null;
  const tA = d == null ? 1 : Math.tanh(0.530 * Math.pow(G * d / u2, 0.75));
  const B = 0.00565 * Math.sqrt(G * fetchM / u2);
  const H = (u2 / G) * 0.283 * tA * Math.tanh(B / tA);
  return H / 0.3048;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

/**
 * How exposed a line is to one wind: the most open point on it (the two ends and the middle).
 *
 * @param {number[][]} coords   [[lon, lat], ...]
 * @param {function} rays       shoreRays() output
 * @param {{mph:number, deg:number}} wind
 * @param {number} [depthFt]    the water under it, for the shallow-water term
 * @returns {?{fetchM:number, waveFt:number, mph:number, fromDeg:number, from:string}}
 */
export function exposure(coords, rays, wind, depthFt, cache = null) {
  if (!Array.isArray(coords) || !coords.length || typeof rays !== 'function' || !wind) return null;
  const mph = Number(wind.mph), deg = Number(wind.deg);
  if (!Number.isFinite(mph) || !Number.isFinite(deg)) return null;
  // The fetch depends on the direction only, so hours that share one share the measurement.
  let fetchM = cache && cache.has(deg) ? cache.get(deg) : undefined;
  if (fetchM === undefined) {
    fetchM = null;
    const pts = [coords[0], coords[Math.floor(coords.length / 2)], coords[coords.length - 1]];
    for (const p of pts) {
      const f = rays(p[0], p[1], deg);
      if (f != null && (fetchM == null || f > fetchM)) fetchM = f;
    }
    if (cache) cache.set(deg, fetchM);
  }
  if (fetchM == null) return null;
  return { fetchM: Math.round(fetchM), waveFt: Number(waveHeightFt(mph, fetchM, depthFt).toFixed(1)),
           mph: Math.round(mph), fromDeg: Math.round(deg), from: compass(deg) };
}

/**
 * The waves on one line at every forecast hour, `{ "07:00": 0.4, ... }`, or null with nothing to
 * measure. For the model, which orders the legs and so decides which hour each one is fished in.
 */
export function wavesByHour(coords, rays, windByHour, depthFt) {
  if (typeof rays !== 'function' || !Array.isArray(windByHour) || !windByHour.length) return null;
  const cache = new Map();
  const out = {};
  for (const w of windByHour) {
    const x = exposure(coords, rays, w, depthFt, cache);
    if (x && Number.isFinite(Number(w.hour))) out[`${String(w.hour).padStart(2, '0')}:00`] = x.waveFt;
  }
  return Object.keys(out).length ? out : null;
}

// ── HIS NUMBER, NOT OURS ───────────────────────────────────────────────────────────────────────
//
// Ryan, Wateree 2026-09-26: *"The routes would have taken me way too far from the ramp with 1-2 ft
// swells due to the wind"*. The low end of what he called too much, in the kayak. The wave heights
// themselves come out of the formula above; this is only where a leg starts being worth saying.
export const TOO_ROUGH_FT = 1;

/**
 * Stamps each troll leg with its roughest exposure over the hours it is fished, and returns a
 * sentence for every leg whose waves reach TOO_ROUGH_FT. The plan legs carry `estStartTime`,
 * `estDurationMin` and `depthFt`.
 */
export function roughLegs(plan, rays, windByHour) {
  const out = [];
  if (!plan || !Array.isArray(plan.legs) || typeof rays !== 'function') return out;
  for (const leg of plan.legs) {
    if (!leg || leg.type !== 'troll' || !Array.isArray(leg.coordinates)) continue;
    const m = /^(\d{1,2}):(\d{2})/.exec(String(leg.estStartTime || ''));
    if (!m) continue;
    const startMin = Number(m[1]) * 60 + Number(m[2]);
    const endMin = startMin + Math.max(0, Number(leg.estDurationMin) || 0);
    const cache = new Map();
    let worst = null, worstAt = null;
    for (let h = Math.floor(startMin / 60); h <= Math.floor(endMin / 60); h++) {
      const w = windAt(windByHour, `${h}:00`);
      const x = w ? exposure(leg.coordinates, rays, w, Number(leg.depthFt), cache) : null;
      if (x && (!worst || x.waveFt > worst.waveFt)) { worst = x; worstAt = `${String(h).padStart(2, '0')}:00`; }
    }
    if (!worst) continue;
    leg.exposure = { ...worst, at: worstAt };
    if (worst.waveFt >= TOO_ROUGH_FT) {
      out.push(`${leg.id} (${leg.estStartTime}) is exposed: at ${worstAt}, ${exposureSentence(worst)}`
             + ' — you found 1-2 ft too much on Wateree. Fish it in a calmer hour, or keep a cove '
             + 'close.');
    }
  }
  return out;
}

/** The forecast hour a clock time falls in, from hourlyWind() rows. */
export function windAt(windByHour, hhmm) {
  const m = /^(\d{1,2}):/.exec(String(hhmm || ''));
  if (!m || !Array.isArray(windByHour)) return null;
  const h = Number(m[1]);
  return windByHour.find((w) => w && Number(w.hour) === h) || null;
}

/** "1.4 mi of open water to the NW; 12 mph from there makes waves about 0.9 ft". */
export function exposureSentence(x) {
  if (!x) return '';
  return `${(x.fetchM / 1609.34).toFixed(1)} mi of open water to the ${x.from}; `
       + `${x.mph} mph from there makes waves about ${x.waveFt} ft`;
}
