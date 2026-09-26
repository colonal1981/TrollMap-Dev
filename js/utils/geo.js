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
 * The same great-circle distance in metres and in kilometres. THE ONE HAVERSINE, since
 * 2026-09-25: plan-candidates.js, utils/cameras.js, Worker/conditions.js,
 * Worker/river-geometry.js and Worker/worker-data.js each carried their own, on two earth radii
 * (6371 and 6371.0088 km); the differences were parts per million. They call these now, and the
 * Worker imports this file.
 */
export function geoDistanceM(lat1, lon1, lat2, lon2) {
  return geoDistanceFt(lat1, lon1, lat2, lon2) * 0.3048;
}

export function geoDistanceKm(lat1, lon1, lat2, lon2) {
  return geoDistanceFt(lat1, lon1, lat2, lon2) * 0.0003048;
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
 * Destination point given start, bearing, and distance.
 * ORPHANED 2026-08-07. Its only caller was route-builder.js, which went with the manual
 * routing. Left in place rather than deleted because it is 12 lines of correct spherical
 * geometry beside nine siblings that ARE used, and a SmartPlan rebuild that lays out legs
 * wants exactly this. Listed on DELETION_TAB.md so it is a decision and not an oversight.
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
 * Two boxes, or one box with a pair pasted into it, to a lat/lon.
 *
 * THE JUMP BUTTON RETURNED ON ITS FIRST LINE FOR WEEKS. `topbar.js` read a single element
 * called `coordInput`; the page has had two, `coordLat` and `coordLon`, since the search modal
 * was rebuilt. `getElementById` returned null, `?.value` gave undefined, and the handler's own
 * `if (!raw) return;` swallowed every click. Ryan: "you put coords in and hit go or whatever
 * the button says and nothing happens". The button was wired the whole time.
 *
 * A COMMA SEPARATES LAT FROM LON; WHITESPACE DOES NOT. Whitespace inside one coordinate is how
 * degrees, minutes and seconds are written -- `34 05 39` -- so splitting a box on spaces would
 * read a pasted `34.377 -80.731` correctly and a typed `34 05 39` as two coordinates. The one
 * exception is a leading minus on the second token, because minutes are never negative: that
 * can only be a longitude. Anything else ambiguous is REFUSED with a reason rather than jumping
 * somewhere plausible and wrong, which on a chartplotter's numbers is the worse failure.
 *
 * @param {string|null} latText  the Lat box
 * @param {string|null} lonText  the Lon box, empty when a pair was pasted into the first
 * @returns {{lat:number, lon:number}|{why:string, blame:'lat'|'lon'}}
 */
export function parseLatLonPair(latText, lonText) {
  const a = String(latText == null ? '' : latText).trim();
  const b = String(lonText == null ? '' : lonText).trim();
  if (!a && !b) return { why: 'Enter a latitude and a longitude.', blame: 'lat' };

  let latRaw = a, lonRaw = b;
  if (!b) {
    // One box holding both. A comma is the separator; failing that, a negative second token.
    const i = a.indexOf(',');
    if (i >= 0) {
      latRaw = a.slice(0, i);
      lonRaw = a.slice(i + 1);
    } else {
      const t = a.split(/\s+/).filter(Boolean);
      const cut = t.findIndex((x, k) => k > 0 && /^-/.test(x));
      if (cut > 0) {
        latRaw = t.slice(0, cut).join(' ');
        lonRaw = t.slice(cut).join(' ');
      } else {
        return { why: 'Put the longitude in its own box, or separate the pair with a comma.',
                 blame: 'lon' };
      }
    }
  }

  const lat = parseCoord(latRaw);
  const lon = parseCoord(lonRaw);
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
    return { why: `"${latRaw.trim()}" is not a latitude between -90 and 90.`, blame: 'lat' };
  }
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) {
    return { why: `"${lonRaw.trim()}" is not a longitude between -180 and 180.`, blame: 'lon' };
  }
  return { lat, lon };
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
