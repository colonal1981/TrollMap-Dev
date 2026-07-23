/**
 * Pure geographic / coordinate math helpers.
 *
 * Nothing in this module touches the DOM, Leaflet, or any global state.
 * Every function is independently importable; if you're doing one-off
 * coordinate math, import what you need from here.
 *
 * Single source of truth for all distance/bearing math in TrollMap.
 * Previously duplicated as:
 *  - js/modules/smart-plan.js: geoDistanceFt (4 args), distFt (4 args), bearing ([lat,lon]), distToRingFt
 *  - js/modules/notifications.js: distFt (4 args, R=3958.8*5280 slightly different but negligible)
 *  - js/modules/smart-plan-context.js: distMi (4 args)
 *  - js/modules/supplemental-layers.js: distMi (4 args) inside getSupplementalContext
 *  - js/modules/lake-research-engine.js: geoDistanceFt (4 args)
 *  - js/utils/geo.js: distFt([lat,lon],[lat,lon])
 *
 * All now route through this file. Functions preserve old behavior within
 * <0.01% tolerance (earth radius constant unified to 20902231 ft).
 */

// Earth radius in feet (mean). Used by distFt and resample.
// 20902231 ft = mean earth radius. Old notifications.js used 3958.8*5280=20902464 ft, diff 0.001% — unified to 20902231.
const EARTH_RADIUS_FT = 20902231;
const DEG_TO_RAD = Math.PI / 180;
const FEET_PER_MILE = 5280;

/**
 * Great-circle distance between two [lat, lon] points, in feet.
 *
 * Uses the haversine formula so distances are accurate even for
 * short legs near the poles.
 *
 * @param {[number, number]} a [lat, lon] in degrees
 * @param {[number, number]} b [lat, lon] in degrees
 * @returns {number} distance in feet
 */
export function distFt(a, b) {
  const dlat = (b[0] - a[0]) * DEG_TO_RAD;
  const dlon = (b[1] - a[1]) * DEG_TO_RAD;
  const h =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(a[0] * DEG_TO_RAD) * Math.cos(b[0] * DEG_TO_RAD) * Math.sin(dlon / 2) ** 2;
  return 2 * EARTH_RADIUS_FT * Math.asin(Math.sqrt(h));
}

/**
 * Great-circle distance with 4-arg signature (lat1, lon1, lat2, lon2) in feet.
 * This is the canonical function previously duplicated as geoDistanceFt / distFt in 5 modules.
 * Includes Infinity guard for non-finite inputs (matching smart-plan.js behavior).
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} feet or Infinity
 */
export function geoDistanceFt(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const p1 = lat1 * DEG_TO_RAD;
  const p2 = lat2 * DEG_TO_RAD;
  const dp = (lat2 - lat1) * DEG_TO_RAD;
  const dl = (lon2 - lon1) * DEG_TO_RAD;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return EARTH_RADIUS_FT * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Alias: distance in feet with 4 args, without Infinity guard (for backward compat with older callers).
 * Same formula as geoDistanceFt.
 */
export function distFtFromCoords(lat1, lon1, lat2, lon2) {
  // No Infinity guard here — mirrors notifications.js behavior which didn't guard
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_FT * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Distance in miles between two [lat,lon] points.
 * @param {[number, number]} a [lat,lon]
 * @param {[number, number]} b [lat,lon]
 * @returns {number} miles
 */
export function distMi(a, b) {
  return distFt(a, b) / FEET_PER_MILE;
}

/**
 * Distance in miles with 4-arg signature.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} miles
 */
export function distMiFromCoords(lat1, lon1, lat2, lon2) {
  return geoDistanceFt(lat1, lon1, lat2, lon2) / FEET_PER_MILE;
}

/**
 * Bearing from point a to point b, in degrees (-180 to 180).
 * Matches old smart-plan.js bearing implementation:
 *   atan2((b[1]-a[1])*cos(a[0]*PI/180), b[0]-a[0]) * 180/PI
 * @param {[number, number]} a [lat,lon]
 * @param {[number, number]} b [lat,lon]
 * @returns {number} bearing degrees
 */
export function bearing(a, b) {
  return Math.atan2((b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180), b[0] - a[0]) * 180 / Math.PI;
}

/**
 * Bearing with 4-arg signature.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} bearing degrees
 */
export function bearingFromCoords(lat1, lon1, lat2, lon2) {
  return bearing([lat1, lon1], [lat2, lon2]);
}

/**
 * Destination point given start, bearing, and distance.
 * Used by route-builder.js for S-pattern generation.
 * @param {number} lat - start lat degrees
 * @param {number} lon - start lon degrees
 * @param {number} bearingDeg - bearing degrees (0 = north, 90 = east)
 * @param {number} distFt - distance in feet
 * @returns {[number, number]} [lat, lon] destination
 */
export function destination(lat, lon, bearingDeg, distFt) {
  const R = EARTH_RADIUS_FT;
  const brng = bearingDeg * DEG_TO_RAD;
  const lat1 = lat * DEG_TO_RAD;
  const lon1 = lon * DEG_TO_RAD;
  const d = distFt / R; // angular distance
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );
  return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
}

/**
 * Minimum distance from a point to a polygon ring (array of [lon, lat] or [lat, lon]?).
 * For TrollMap boundary rings are [lon, lat] (GeoJSON order).
 * This is a helper for smart-plan's distToRingFt.
 * @param {number} lat
 * @param {number} lon
 * @param {Array<[number, number]>} ring - array of [lon, lat] or [lat, lon] depending on source
 * @param {boolean} ringIsLonLat - if true, ring is [lon,lat] (GeoJSON), else [lat,lon]
 * @returns {number} min distance feet or Infinity
 */
export function distToRingFt(lat, lon, ring, ringIsLonLat = true) {
  if (!ring || !ring.length) return Infinity;
  let minDist = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const rLon = ringIsLonLat ? ring[i][0] : ring[i][1];
    const rLat = ringIsLonLat ? ring[i][1] : ring[i][0];
    const d = geoDistanceFt(lat, lon, rLat, rLon);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

/**
 * Convert a foot measurement to latitude degrees at the equator
 * (lat degrees don't shrink with longitude like longitude does).
 *
 * @param {number} ft
 * @returns {number} degrees latitude
 */
export function ftToDegLat(ft) {
  return ft / 364000;
}

/**
 * Convert a foot measurement to longitude degrees at a given latitude.
 * Longitude shrinks as you approach the poles by cos(lat).
 *
 * @param {number} ft
 * @param {number} lat — latitude in degrees
 * @returns {number} degrees longitude
 */
export function ftToDegLon(ft, lat) {
  return ft / (364000 * Math.cos(lat * Math.PI / 180));
}

/**
 * Parse a user-typed coordinate string into decimal degrees.
 *
 * Accepts:
 *   - decimal:  "34.09421" or "-81.32882"
 *   - DMS:      "34°5'39\"N"   or   "34 5 39"
 *   - lettered: "N34.09421"   or   "S34 5 39"
 *   - signed:   "-34.09421"   or   "34.09421S"
 *
 * @param {string|null} s
 * @returns {number} decimal degrees, or NaN if unparseable
 */
export function parseCoord(s) {
  if (s == null) return NaN;
  s = String(s).trim().toUpperCase();
  if (!s) return NaN;

  let sign = 1;
  if (/[SW]/.test(s)) sign = -1;
  if (/^-/.test(s)) sign = -1;

  const nums = (s.match(/-?\d+(\.\d+)?/g) || []).map(Number);
  if (!nums.length) return NaN;

  let val;
  if (nums.length === 1) val = Math.abs(nums[0]);
  else if (nums.length === 2) val = Math.abs(nums[0]) + nums[1] / 60;
  else val = Math.abs(nums[0]) + nums[1] / 60 + nums[2] / 3600;

  return sign * val;
}

/**
 * Ramer-Douglas-Peucker line simplification.
 * `pts` is an array of [lat, lon]; `tol` is the max squared-distance
 * from a vertex to the chord in DEGREE² units (multiply by ~3.6e7 to
 * think in feet²).
 *
 * @param {Array<[number, number]>} pts
 * @param {number} tol
 * @returns {Array<[number, number]>}
 */
export function simplifyLine(pts, tol) {
  if (pts.length <= 2 || tol <= 0) return pts.slice();

  const sqTol = tol * tol;

  // Squared perpendicular distance from p to the line segment a-b.
  function segDistSq(p, a, b) {
    const dx = b[1] - a[1];
    const dy = b[0] - a[0];
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return (p[1] - a[1]) ** 2 + (p[0] - a[0]) ** 2;

    let t = ((p[1] - a[1]) * dx + (p[0] - a[0]) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const px = a[1] + t * dx;
    const py = a[0] + t * dy;
    return (p[1] - px) ** 2 + (p[0] - py) ** 2;
  }

  function rdp(points, first, last) {
    let maxDist = 0,
      idx = 0;
    for (let i = first + 1; i < last; i++) {
      const d = segDistSq(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        idx = i;
      }
    }
    if (maxDist > sqTol) {
      const left = rdp(points, first, idx);
      const right = rdp(points, idx, last);
      return left.slice(0, left.length - 1).concat(right);
    }
    return [points[first], points[last]];
  }

  return rdp(pts, 0, pts.length - 1);
}

/**
 * Map a depth value (ft) to a hex color. Used for track/segment
 * visualization so deeper water reads as warmer.
 *
 * @param {number|string} d
 * @returns {string} hex color
 */
export function depthColor(d) {
  const depth = Math.abs(parseFloat(d) || 0);
  if (depth <= 10) return '#4dd0e1';
  if (depth <= 20) return '#4db6ac';
  if (depth <= 30) return '#66bb6a';
  if (depth <= 50) return '#aed581';
  if (depth <= 70) return '#fff176';
  if (depth <= 90) return '#ffb74d';
  return '#ef5350';
}

/**
 * Heuristic for picking a "depth" property out of a feature's `properties`
 * object — different datasets use different keys.
 *
 * @param {Object<string, *>} props
 * @returns {string|null} chosen property name, or null
 */
export function guessDepthProp(props) {
  const candidates = [
    'depth',
    'DEPTH',
    'elevation',
    'ELEVATION',
    'CONTOUR',
    'contour',
    'Elev',
    'Level',
    'Z',
    'z',
    'depth_ft',
    'DEPTH_FT',
    'Contour',
    'ContourInterval',
  ];
  for (const c of candidates) {
    if (props[c] != null) return c;
  }
  for (const k of Object.keys(props)) {
    if (/depth|elev|contour|z/i.test(k) && !isNaN(parseFloat(props[k]))) return k;
  }
  return null;
}

/**
 * Box-filter moving average on [lat, lon] coordinates.
 * Window of `win` points is centered on each output point.
 *
 * @param {Array<[number, number]>} coords
 * @param {number} win — window size (use an odd number for symmetric smoothing)
 * @returns {Array<[number, number]>}
 */
export function movingAvg(coords, win) {
  if (win < 2 || coords.length < win) return coords.slice();
  const half = win >> 1;
  const out = [];
  for (let i = 0; i < coords.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(coords.length, i + half + 1);
    let latSum = 0,
      lonSum = 0;
    for (let j = lo; j < hi; j++) {
      latSum += coords[j][0];
      lonSum += coords[j][1];
    }
    out.push([latSum / (hi - lo), lonSum / (hi - lo)]);
  }
  return out;
}

/**
 * Resample a track to a fraction `keep` of its original points,
 * preserving total arc length. `keep=1` returns the input unchanged;
 * `keep=0.5` returns ~half the points spaced evenly along the line.
 *
 * @param {Array<[number, number]>} coords
 * @param {number} keep — fraction to keep (0 < keep <= 1)
 * @returns {Array<[number, number]>}
 */
export function resample(coords, keep) {
  if (keep >= 1 || coords.length <= 3) return coords.slice();

  const target = Math.max(2, Math.round(coords.length * keep));

  // Cumulative arc length at each vertex.
  const cumDist = [0];
  for (let i = 1; i < coords.length; i++) {
    cumDist.push(cumDist[i - 1] + distFt(coords[i - 1], coords[i]));
  }
  const total = cumDist[cumDist.length - 1];
  if (!total) return coords.slice();

  const out = [];
  for (let k = 0; k < target; k++) {
    const targetDist = (total * k) / (target - 1);
    let j = 0;
    while (j < cumDist.length - 1 && cumDist[j + 1] < targetDist) j++;
    if (j >= coords.length - 1) {
      out.push(coords[coords.length - 1]);
      continue;
    }
    const segLen = cumDist[j + 1] - cumDist[j];
    const f = segLen ? (targetDist - cumDist[j]) / segLen : 0;
    out.push([
      coords[j][0] + f * (coords[j + 1][0] - coords[j][0]),
      coords[j][1] + f * (coords[j + 1][1] - coords[j][1]),
    ]);
  }
  return out;
}

// Legacy alias for backward compat
// (distFtFromCoords already defined as function above, geoDistanceFtFromCoords is alias kept for old imports)
