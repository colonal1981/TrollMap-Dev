/**
 * route-builder.js — Unified route generation panel.
 *
 * Replaces: smart-route.js + troll-generator.js
 *
 * Two path sources, one pattern engine:
 *   - Contour mode: follows a depth contour band from the active dataset
 *   - Manual mode:  start/end points picked on map, generates parallel lanes
 *
 * Patterns (both modes): straight, sine, zigzag, sine+straight, zigzag+straight
 *
 * Exports:
 *   buildRouteBuilderPanel(container)  — render the panel UI into a container
 */

import { state, CF_WORKER_URL } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { distFt } from '../utils/geo.js';
import { setBanner, showPreview, clearPreview, renderAll } from '../core/map-init.js';
import { getActiveContour, onContourChange } from './contour-data.js';
import { getDepthAreaGeoJSON } from './supplemental-layers.js';

// ── Shared state ──────────────────────────────────────────────────────────────

let routeLayer = null;
let clipPolygon = null;
window._routeBuilderClipActive = false;
let clipLayer   = null;
let pendingTracks = [];
let pickingMode = null;  // 'start' | 'end' | 'clip'
let manualWaypoints = [];   // [[lat,lon], ...] for waypoint manual mode
let waypointMarkers = [];   // Leaflet markers for waypoints

// ── Math helpers (from troll-generator.js) ────────────────────────────────────

function distBearing(lat1, lon1, lat2, lon2) {
  const R = 20902231, D = Math.PI / 180, R2D = 180 / Math.PI;
  const p1 = lat1*D, p2 = lat2*D, dp = (lat2-lat1)*D, dl = (lon2-lon1)*D;
  const a = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const y = Math.sin(dl)*Math.cos(p2);
  const x = Math.cos(p1)*Math.sin(p2) - Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
  return [dist, (Math.atan2(y,x)*R2D + 360) % 360];
}

function destination(lat, lon, bearing, dist) {
  const R = 20902231, D = Math.PI / 180, R2D = 180 / Math.PI;
  const br = bearing*D, lr = lat*D, d = dist/R;
  const lat2 = Math.asin(Math.sin(lr)*Math.cos(d) + Math.cos(lr)*Math.sin(d)*Math.cos(br));
  const lon2 = lon*D + Math.atan2(Math.sin(br)*Math.sin(d)*Math.cos(lr), Math.cos(d)-Math.sin(lr)*Math.sin(lat2));
  return [lat2*R2D, lon2*R2D];
}

// ── Pattern generators ────────────────────────────────────────────────────────

function genStraight(p1, p2, cfg) {
  const [dist, brng] = distBearing(p1[0], p1[1], p2[0], p2[1]);
  const n = Math.max(2, Math.ceil(dist / Math.max(50, cfg.spacing)));
  return Array.from({length: n+1}, (_, i) => destination(p1[0], p1[1], brng, dist*i/n));
}

function genSine(p1, p2, cfg) {
  const MIN_TURN_RADIUS_FT = 35;
  if (cfg.amplitude > 0 && cfg.wave > 0) {
    const minWave = Math.PI * Math.sqrt(cfg.amplitude * MIN_TURN_RADIUS_FT);
    if (cfg.wave < minWave) cfg = { ...cfg, wave: Math.ceil(minWave) };
  }
  // Direct port of the original Kayak Troll Generator genSine — the version that
  // actually worked. Adds: configurable points-per-wave, dynamic amplitude (fatter
  // in the middle of each leg, softer at the ends), asymmetric depth bias (push
  // the curve harder toward the deep/contour side), and minimum-spacing thinning.
  const [dist, brng] = distBearing(p1[0], p1[1], p2[0], p2[1]);
  if (dist < 1) return [];
  const wave = Math.max(20, cfg.wave || 300);
  const ppw  = Math.max(6, cfg.ppw || 16);
  const n    = Math.max(Math.floor((dist / wave) * ppw), ppw);
  const perp = (brng + 90) % 360;
  const minSpacing = cfg.minSpacing || 0;
  const pts = [];
  let prev = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const c = destination(p1[0], p1[1], brng, dist * t);
    let amp = cfg.amplitude;
    if (cfg.dynamic) amp *= 0.65 + 0.35 * Math.sin(Math.PI * t);  // bulge in middle
    let offset = Math.sin((2 * Math.PI * dist * t) / wave) * amp;
    if (cfg.bias > 0 && offset > 0) offset *= (1 + cfg.bias);     // lean deep side
    const f = destination(c[0], c[1], perp, offset);
    if (prev && minSpacing > 0) {
      const [d] = distBearing(prev[0], prev[1], f[0], f[1]);
      if (d < minSpacing) continue;                              // thin dense points
    }
    pts.push(f);
    prev = f;
  }
  return pts;
}

function genZigzag(p1, p2, cfg) {
  // Port of the original genZigzag: wave_ft/2 step, min_turns floor.
  const [dist, brng] = distBearing(p1[0], p1[1], p2[0], p2[1]);
  if (dist < 1) return [];
  const perp = (brng + 90) % 360;
  const step = Math.max(20, (cfg.wave || 300) / 2);
  const n = Math.max(cfg.minTurns || 1, Math.floor(dist / step));
  const spacing = dist / n;
  const pts = [p1];
  let dir = 1;
  for (let i = 1; i < n; i++) {
    const c = destination(p1[0], p1[1], brng, i * spacing);
    let amp = cfg.amplitude;
    if (cfg.bias > 0 && dir > 0) amp *= (1 + cfg.bias); // lean deep side
    pts.push(destination(c[0], c[1], perp, amp * dir));
    dir *= -1;
  }
  pts.push(p2);
  return pts;
}

function genMixed(p1, p2, cfg, curveFn) {
  const [dist, brng] = distBearing(p1[0], p1[1], p2[0], p2[1]);
  if (dist < 1) return [];

  const wave = Math.max(20, cfg.wave || 300);
  let straightFt = cfg.straightFt || 350;

  // Adaptive straight length: on SHORT segments (e.g. close waypoints ~150ft) a
  // fixed 350ft straight swallows the whole segment and you never see a curve.
  // Cap the straight run so it's at most ~40% of the segment and always leaves
  // room for at least one full wave of curve.
  if (dist < straightFt + wave) {
    straightFt = Math.min(straightFt, dist * 0.4);
  }
  // If the segment is too short to hold any curve at all, just go straight.
  if (dist < wave * 0.75) return genStraight(p1, p2, cfg);

  const pts = [p1];
  let cursor = 0;
  let guard = 0;
  while (cursor < dist - 1 && guard++ < 1000) {
    const endS = Math.min(cursor + straightFt, dist);
    const s = destination(p1[0], p1[1], brng, cursor);
    const e = destination(p1[0], p1[1], brng, endS);
    pts.push(...genStraight(s, e, cfg).slice(1));
    cursor = endS;
    if (cursor >= dist - 1) break;
    const endC = Math.min(cursor + wave, dist);
    const cs = destination(p1[0], p1[1], brng, cursor);
    const ce = destination(p1[0], p1[1], brng, endC);
    pts.push(...curveFn(cs, ce, cfg).slice(1));
    cursor = endC;
  }
  return pts;
}

function applyPattern(p1, p2, cfg) {
  switch (cfg.pattern) {
    case 'sine':     return genSine(p1, p2, cfg);
    case 'zigzag':   return genZigzag(p1, p2, cfg);
    case 'sine+straight':   return genMixed(p1, p2, cfg, genSine);
    case 'zigzag+straight': return genMixed(p1, p2, cfg, genZigzag);
    default:         return genStraight(p1, p2, cfg);
  }
}

// ── Manual mode: parallel lanes ───────────────────────────────────────────────

function generateManualLanes(cfg) {
  const { start, end, lanes, spacing, pattern, amplitude, wave, straightFt } = cfg;
  const tracks = [];
  const dLat = end[0] - start[0];
  const dLon = end[1] - start[1];
  const lat0 = start[0];
  const angle = Math.atan2(dLon * Math.cos(lat0 * Math.PI / 180), dLat);
  const perp = angle + Math.PI / 2;
  const dLatPerFt = Math.cos(perp) / 364000;
  const dLonPerFt = Math.sin(perp) / (364000 * Math.cos(lat0 * Math.PI / 180));

  for (let i = 0; i < lanes; i++) {
    const off = i * spacing;
    const p1 = [start[0] + off*dLatPerFt, start[1] + off*dLonPerFt];
    const p2 = [end[0]   + off*dLatPerFt, end[1]   + off*dLonPerFt];
    const pts = applyPattern(p1, p2, { pattern, amplitude, wave, straightFt, spacing });
    if (pts.length > 1) tracks.push({ name: `Lane${i+1}`, pts });
  }
  return tracks;
}

// ── Clip polygon helpers ──────────────────────────────────────────────────────

function featureIntersectsClip(feat) {
  if (!clipPolygon) return true;
  const coords = feat.geometry?.coordinates;
  if (!coords?.length) return false;
  // Sample up to 9 evenly-spaced points — a long contour may cross the clip
  // polygon without its midpoint being inside it.
  const step = Math.max(1, Math.floor(coords.length / 8));
  for (let i = 0; i < coords.length; i += step) {
    if (pointInPolygon([coords[i][1], coords[i][0]], clipPolygon)) return true;
  }
  const last = coords[coords.length - 1];
  return pointInPolygon([last[1], last[0]], clipPolygon);
}

function pointInPolygon([lat, lon], polygon) {
  let inside = false;
  const pts = polygon;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [yi, xi] = pts[i];
    const [yj, xj] = pts[j];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// ── Geometry helpers shared by contour route generators ───────────────────────

// Total arc length of a LineString feature (coords are [lon,lat]).
function contourArcLength(coords) {
  let len = 0;
  for (let i = 1; i < coords.length; i++) {
    const [d] = distBearing(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0]);
    len += d;
  }
  return len;
}

// Resample a [lon,lat] LineString into evenly spaced [lat,lon] waypoints.
function resampleContour(coords, intervalFt) {
  const wp = [[coords[0][1], coords[0][0]]];
  let carry = 0;
  for (let i = 1; i < coords.length; i++) {
    const [d] = distBearing(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0]);
    carry += d;
    if (carry >= intervalFt) { wp.push([coords[i][1], coords[i][0]]); carry = 0; }
  }
  const last = coords[coords.length - 1];
  const lastLL = [last[1], last[0]];
  const prev = wp[wp.length - 1];
  if (prev[0] !== lastLL[0] || prev[1] !== lastLL[1]) wp.push(lastLL);
  return wp;
}

// Apply the chosen pattern along a sequence of spine waypoints, returning a
// single continuous point list. Pattern oscillates perpendicular to travel.
function patternAlongSpine(waypoints, cfg) {
  // zoneSpineOffset: shift entire spine laterally before generating pattern.
  // Positive = deep side (right of travel), negative = shallow side (left of travel).
  // Used for zone-based routing where the spine IS the ledge/contour and the
  // trolling line should run parallel to it at a species-appropriate offset.
  let spine = waypoints;
  if (cfg.zoneSpineOffset && Math.abs(cfg.zoneSpineOffset) > 1) {
    spine = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const [, brng] = distBearing(waypoints[i][0], waypoints[i][1], waypoints[i+1][0], waypoints[i+1][1]);
      const perp = (brng + 90) % 360;
      spine.push(destination(waypoints[i][0], waypoints[i][1], perp, cfg.zoneSpineOffset));
    }
    const last = waypoints[waypoints.length - 1];
    const [, lastBrng] = distBearing(waypoints[waypoints.length - 2][0], waypoints[waypoints.length - 2][1], last[0], last[1]);
    spine.push(destination(last[0], last[1], (lastBrng + 90) % 360, cfg.zoneSpineOffset));
  }

  const out = [];
  for (let i = 0; i < spine.length - 1; i++) {
    const p1 = spine[i], p2 = spine[i + 1];
    const [segDist] = distBearing(p1[0], p1[1], p2[0], p2[1]);
    if (segDist < 20) continue;
    const pts = applyPattern(p1, p2, cfg);
    if (!out.length) out.push(...pts);
    else out.push(...pts.slice(1));
  }
  return out;
}

// Keep generated points on the water: if a clip polygon is set, pull any point
// that strays outside it back onto the nearest spine waypoint. This prevents
// the sine swing from throwing the route over land.
// Keep generated points on the water. Rather than SNAP out-of-polygon points to a
// far spine vertex (which created huge fold-backs / triangles), we simply DROP the
// points that fall outside the clip polygon and keep the largest contiguous run
// that stays inside. This trims the route to the box cleanly without teleporting.
// Extract all rings from a GeoJSON MultiPolygon or Polygon as [lat,lon][] arrays
function extractLakeBoundaryRings(geo) {
  const rings = [];
  const addRing = (coords) => rings.push(coords.map(([lon, lat]) => [lat, lon]));
  if (!geo?.features?.length) return rings;
  for (const f of geo.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') g.coordinates.forEach(addRing);
    else if (g.type === 'MultiPolygon') g.coordinates.forEach(poly => poly.forEach(addRing));
  }
  return rings;
}

function pointInLakeBoundary(pt) {
  const boundary = window.LAKE_BOUNDARY_GEOJSON;
  if (!boundary) return true; // no boundary loaded — assume on water
  const rings = extractLakeBoundaryRings(boundary);
  if (!rings.length) return true;
  // Point must be inside at least one ring
  return rings.some(ring => pointInPolygon(pt, ring));
}

function clampToClip(pts) {
  if (!clipPolygon || !pts.length) return pts;
  // Split into runs of consecutive in-polygon points; return the longest run.
  let best = [], cur = [];
  for (const p of pts) {
    if (pointInPolygon(p, clipPolygon)) {
      cur.push(p);
    } else {
      if (cur.length > best.length) best = cur;
      cur = [];
    }
  }
  if (cur.length > best.length) best = cur;
  return best;
}

// Trim a spine (array of [lat,lon]) to the largest contiguous portion that lies
// inside the clip polygon. Done BEFORE patterning so the sine develops only over
// the in-box stretch and never has to be snapped back.
function trimSpineToClip(spine) {
  if (!clipPolygon || spine.length < 2) return spine;
  let best = [], cur = [];
  for (const p of spine) {
    if (pointInPolygon(p, clipPolygon)) {
      cur.push(p);
    } else {
      if (cur.length > best.length) best = cur;
      cur = [];
    }
  }
  if (cur.length > best.length) best = cur;
  return best;
}

// Shortest distance (ft) from a [lat,lon] point to the nearest VERTEX of any
// contour in `others`. Vertices are dense enough on these datasets that nearest-
// vertex is a good proxy for nearest-point and far cheaper. Returns Infinity if
// no others. Used to measure true band width = distance across the gradient.
function nearestContourDistFt([lat, lon], others) {
  let best = Infinity;
  for (const o of others) {
    const cs = o.coords;
    // Sample coarsely (every ~4th vertex) — we only need an approximate width.
    const step = Math.max(1, Math.floor(cs.length / 24));
    for (let i = 0; i < cs.length; i += step) {
      const [d] = distBearing(lat, lon, cs[i][1], cs[i][0]);
      if (d < best) best = d;
    }
  }
  return best;
}

// ── Contour stitching ─────────────────────────────────────────────────────────
//
// The smart GeoJSON is OCR-traced per map TILE, so a single physical depth line
// is shattered into many short fragments (median ~120ft on Monticello) whose
// endpoints nearly touch across tile seams. Generating a route per-fragment gives
// dozens of unusable 100ft stubs (and a too-short sweep spine). Stitching merges
// same-depth fragments end-to-end into long continuous polylines first.

// A "there-and-back" stub: <=3 coords whose start ≈ end. Pure OCR noise.
function isContourStub(coords) {
  if (coords.length <= 3) {
    const [d] = distBearing(coords[0][1], coords[0][0],
                            coords[coords.length-1][1], coords[coords.length-1][0]);
    if (d < 30) return true;
  }
  return false;
}

// Greedily chain [lon,lat] fragments whose endpoints fall within TOL feet.
function angleDiff(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Bearing of the last/first short segment of a chain, in the direction of travel
// AT that endpoint (tail = outgoing, head = incoming).
function endBearing(coordsLL, atTail) {
  // coordsLL: [lat,lon][]; return bearing of travel leaving the tail / entering head.
  if (coordsLL.length < 2) return 0;
  if (atTail) {
    const a = coordsLL[coordsLL.length - 2], b = coordsLL[coordsLL.length - 1];
    return distBearing(a[0], a[1], b[0], b[1])[1];
  } else {
    const a = coordsLL[1], b = coordsLL[0];
    return distBearing(a[0], a[1], b[0], b[1])[1];
  }
}

function stitchFragments(fragments, TOL = 18, MAX_TURN = 30) {
  // Work in [lat,lon] internally for bearing math; inputs/outputs are [lon,lat].
  // MAX_TURN tightened from 45° to 30° — fragments that require a sharp turn
  // to join are almost always from opposite sides of the contour or different
  // structural features. Allowing 45° was letting U-turns sneak through.
  const segs = fragments
    .filter(c => c.length >= 2 && !isContourStub(c))
    .map(c => c.map(([lo, la]) => [la, lo]));      // -> [lat,lon]
  const used = new Array(segs.length).fill(false);
  const chains = [];

  // Minimum distance (ft) required to compute a reliable bearing on a fragment.
  // Fragments shorter than this give garbage bearings due to floating-point noise.
  const MIN_BEARING_DIST_FT = 25;

  // Safe bearing helper: walk away from endpoint until we've moved MIN_BEARING_DIST_FT
  function safeBearingFrom(coords, fromStart) {
    // fromStart=true → bearing leaving coords[0]; false → bearing leaving coords[last]
    const n = coords.length;
    if (n < 2) return 0;
    const ref = fromStart ? coords[0] : coords[n - 1];
    if (fromStart) {
      for (let i = 1; i < n; i++) {
        if (distBearing(ref[0], ref[1], coords[i][0], coords[i][1])[0] >= MIN_BEARING_DIST_FT)
          return distBearing(ref[0], ref[1], coords[i][0], coords[i][1])[1];
      }
    } else {
      for (let i = n - 2; i >= 0; i--) {
        if (distBearing(ref[0], ref[1], coords[i][0], coords[i][1])[0] >= MIN_BEARING_DIST_FT)
          return distBearing(ref[0], ref[1], coords[i][0], coords[i][1])[1];
      }
    }
    // Fragment too short — return bearing between endpoints as fallback
    return distBearing(coords[0][0], coords[0][1], coords[n-1][0], coords[n-1][1])[1];
  }

  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    let chain = segs[s].slice();
    let grew = true;
    while (grew) {
      grew = false;
      const head = chain[0], tail = chain[chain.length - 1];
      const tailBrng = endBearing(chain, true);
      const headBrng = endBearing(chain, false);

      let bestJ = -1, bestScore = Infinity, bestOp = null;
      for (let j = 0; j < segs.length; j++) {
        if (used[j]) continue;
        const c = segs[j];
        const a = c[0], b = c[c.length - 1];
        // Use safe bearings that skip past noise at very short distances
        const cFwdBrng = safeBearingFrom(c, true);   // bearing leaving c[0]
        const cRevBrng = safeBearingFrom(c, false);  // bearing leaving c[last]
        const cands = [
          { d: distBearing(tail[0], tail[1], a[0], a[1])[0], op: 'TA',
            turn: angleDiff(tailBrng, cFwdBrng) },
          { d: distBearing(tail[0], tail[1], b[0], b[1])[0], op: 'TB',
            turn: angleDiff(tailBrng, cRevBrng) },
          { d: distBearing(head[0], head[1], a[0], a[1])[0], op: 'HA',
            turn: angleDiff(headBrng, cFwdBrng) },
          { d: distBearing(head[0], head[1], b[0], b[1])[0], op: 'HB',
            turn: angleDiff(headBrng, cRevBrng) },
        ];
        for (const cand of cands) {
          if (cand.d > TOL || cand.turn > MAX_TURN) continue;
          const score = cand.d + cand.turn * 2;
          if (score < bestScore) { bestScore = score; bestJ = j; bestOp = cand.op; }
        }
      }

      if (bestJ >= 0) {
        const c = segs[bestJ].slice(); used[bestJ] = true; grew = true;
        if (bestOp === 'TA') chain = chain.concat(c);
        else if (bestOp === 'TB') chain = chain.concat(c.reverse());
        else if (bestOp === 'HA') chain = c.reverse().concat(chain);
        else chain = c.concat(chain);
      }
    }
    // Remove micro-reversals at tile boundaries — points that briefly go
    // backwards (>120° from general travel direction) before resuming.
    // These are coordinate direction artifacts at PBF tile seams.
    const cleaned = [];
    for (let i = 0; i < chain.length; i++) {
      if (cleaned.length < 2) { cleaned.push(chain[i]); continue; }
      const prev2 = cleaned[cleaned.length - 2];
      const prev1 = cleaned[cleaned.length - 1];
      const curr  = chain[i];
      // General direction from 2 points ago to now
      const [, genBrng] = distBearing(prev2[0], prev2[1], curr[0], curr[1]);
      // Direction of the previous step
      const [prevDist, prevBrng] = distBearing(prev1[0], prev1[1], curr[0], curr[1]);
      if (prevDist < 1) continue; // skip duplicate points
      const turn = angleDiff(genBrng, prevBrng);
      // If the step to the current point reverses sharply vs general direction, skip prev1
      // This catches tile boundary direction changes regardless of distance
      const [stepDist] = distBearing(prev1[0], prev1[1], curr[0], curr[1]);
      if (turn > 120 && stepDist < 500) {
        cleaned.pop(); // remove the reversal point
      }
      cleaned.push(curr);
    }
    chains.push(cleaned.map(([la, lo]) => [lo, la]));
  }
  return chains;
}

// Build stitched, length-tagged spines for a set of features, grouped by depth.
// Returns [{ coords:[lon,lat][], len, depth, mid:[lon,lat] }] sorted longest-first.
function buildStitchedSpines(features) {
  const byDepth = new Map();
  for (const f of features) {
    const d = f.properties?.depth_ft;
    const c = f.geometry?.coordinates;
    if (d == null || !c || c.length < 2) continue;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d).push(c);
  }
  const spines = [];
  for (const [depth, frags] of byDepth) {
    for (const chain of stitchFragments(frags)) {
      if (chain.length < 2) continue;
      spines.push({
        coords: chain,
        len: contourArcLength(chain),
        depth,
        mid: chain[Math.floor(chain.length / 2)],
      });
    }
  }
  // Cap individual spine length at 3x the clip radius to prevent lake-spanning loops
  // A single stitched contour shouldn't span the entire lake
  const clipRadiusFt = (window._clipRadiusMi || 4.0) * 5280;
  const MAX_SPINE_LEN = clipRadiusFt * 3;
  spines.forEach(s => { if (s.len > MAX_SPINE_LEN) s.len = MAX_SPINE_LEN; });
  spines.sort((a, b) => b.len - a.len);
  return spines;
}

// Sample every Nth vertex of a [lon,lat] spine and return the closest
// distance in feet to [refLat, refLon]. Using only endpoints+midpoint misses
// the case where a lake-length spine passes right next to the ref point in the
// middle — dense sampling is much more accurate and still cheap (≤60 samples).
function closestPointOnSpineFt(refLat, refLon, coords) {
  if (!coords?.length) return Infinity;
  const step = Math.max(1, Math.floor(coords.length / 60));
  let best = Infinity;
  for (let i = 0; i < coords.length; i += step) {
    const [d] = distBearing(refLat, refLon, coords[i][1], coords[i][0]);
    if (d < best) best = d;
  }
  const [dLast] = distBearing(refLat, refLon,
    coords[coords.length-1][1], coords[coords.length-1][0]);
  return Math.min(best, dLast);
}

// ── Contour mode: follow depth band ──────────────────────────────────────────

function generateContourRoutes(cfg) {
  // SWEEP mode: run ALONG the depth band, sine oscillating ACROSS it so you
  // weave between depthMin and depthMax. Direction of travel is PARALLEL to the
  // contours — and the only reliable source of "parallel to the contours" is
  // the contour geometry itself. So we anchor each pass to a REAL contour line
  // and oscillate perpendicular to it, rather than synthesising a straight
  // centreline from the bbox (which flew over land).
  //
  // Multi-pass ("lanes"): when cfg.lanes > 1 we use the N longest DISTINCT
  // contours in the band as parallel spines — a lawnmower pattern that still
  // hugs real water the whole way. Passes are stitched end-to-start (boustro-
  // phedon) so the route flows continuously without big dead-runs across land.
  const contour = getActiveContour();
  const gj = contour?.smart || contour?.raw;
  if (!gj?.features?.length) return [];

  const { depthMin, depthMax, spacing, wave, straightFt } = cfg;
  const lanes = Math.max(1, Math.min(12, cfg.lanes || 1));
  // Smart Plan: always use straight pattern with no amplitude — sine oscillation
  // causes clipping artifacts that create reversals in the route
  const pattern = cfg.smartPlan ? 'straight' : (cfg.pattern || 'sine+straight');
  const amplitude = cfg.smartPlan ? 0 : (cfg.amplitude || 30);

  const inRange = gj.features.filter(f => {
    const d = f.properties?.depth_ft;
    return d != null && d >= depthMin && d <= depthMax;
  });
  if (!inRange.length) return [];

  // DIAGNOSTIC (2026-07-03): added after three different requested depth
  // bands (e.g. 8-16ft, 14-22ft, 9-17ft) produced byte-identical output
  // tracks. This logs the actual distinct depth values found for THIS
  // band's filter, so we can tell whether that's because the contour data
  // in the clip area is genuinely dominated by one depth value that
  // satisfies all three overlapping ranges, or something else is stale.
  const distinctDepths = [...new Set(inRange.map(f => f.properties?.depth_ft))].sort((a, b) => a - b);
  console.log(`[route-builder] depth band ${depthMin}-${depthMax}ft: ${inRange.length} features, distinct depths found: [${distinctDepths.join(', ')}]`);

  // Stitch fragmented same-depth contours into long continuous spines first, then
  // keep those long enough to be useful. (On Monticello raw fragments are ~120ft;
  // stitched chains reach 1500-2000ft.)
  const scoped = clipPolygon ? inRange.filter(featureIntersectsClip) : inRange;
  let candidates = buildStitchedSpines(scoped)
    .map(s => ({ ...s, coords: s.coords, mid: s.mid }))
    .filter(s => s.len >= 250);
  if (!candidates.length) return [];

  // SMART TROLLING CIRCUIT BRAIN:
  // Prioritize contour spines closest to the phase start point (where boat currently is).
  const refLat = cfg.startLat != null ? cfg.startLat : cfg.rampLat;
  const refLon = cfg.startLon != null ? cfg.startLon : cfg.rampLon;
  const lockedBearing = cfg.lockedBearing ?? null;
  if (refLat != null && refLon != null) {
    // For singleBestTrack (smart plan) phases, cap how far the chosen spine
    // can be from the phase start. A lake-length spine that happens to pass
    // nearby in the middle would score huge on length but start the route
    // miles away — the cap forces it to use the nearby section or be rejected.
    const MAX_SPINE_DIST_FT = cfg.singleBestTrack ? 5280 : Infinity; // 1mi cap for smart plan
    const eLat = cfg.endLat;
    const eLon = cfg.endLon;
    // lenCap at 4× target: a 2361ft stub and a 132k ft spine should NOT tie
    // on lenScore just because both exceed the old 15000ft cap. 4× lets the
    // longer spine win clearly while still bounding absurd lake-length spines.
    const lenCap = (cfg.targetLengthFt || 15000) * 3;

    candidates.forEach(s => {
      const closestFt = closestPointOnSpineFt(refLat, refLon, s.coords);
      if (s.len < 500) { s.trollScore = -Infinity; s._closestFt = closestFt; return; }
      if (closestFt > MAX_SPINE_DIST_FT) { s.trollScore = -Infinity; s._closestFt = closestFt; return; }
      // Reject spines that don't travel anywhere useful — start-to-end displacement
      // must be at least 1500ft so tangled cove knots don't score as long spines
      const spineStart = s.coords[0], spineEnd = s.coords[s.coords.length - 1];
      const displacement = distBearing(spineStart[1], spineStart[0], spineEnd[1], spineEnd[0])[0];
      if (displacement < 1500) { s.trollScore = -Infinity; s._closestFt = closestFt; return; }
      const startPenalty = closestFt * 3;
      const lenScore = Math.min(s.len, lenCap);
      // End penalty for return passes only (Phase 3): light 1× weight so long
      // spines that don't end exactly at the ramp still compete —
      // prepareSpineForPhase trims the actual route toward the ramp.
      let endPenalty = 0;
      if (cfg.isReturnPass && eLat != null && eLon != null) {
        const endDistFt = closestPointOnSpineFt(eLat, eLon, s.coords);
        endPenalty = endDistFt * 7; // heavier for return pass — keeps lake-length monsters from winning over well-positioned spines
      }
      let bearingBonus = 0;
      if (lockedBearing !== null && s.coords.length >= 2) {
        const [, spineBrng] = distBearing(s.coords[0][1], s.coords[0][0], s.coords[s.coords.length-1][1], s.coords[s.coords.length-1][0]);
        const diff = Math.abs(((spineBrng - lockedBearing + 540) % 360) - 180);
        bearingBonus = diff < 90 ? (1 - diff / 90) * 5000 : -3000;
      }
      s.trollScore = (lenScore * 2) - startPenalty - endPenalty + bearingBonus;
      s._closestFt = closestFt;
    });
    candidates.sort((a, b) => (b.trollScore || 0) - (a.trollScore || 0));
    console.log('[route-builder] top 3 spines: ' + candidates.slice(0,3).map(c => 'd=' + Math.round(c._closestFt) + 'ft len=' + Math.round(c.len) + 'ft score=' + Math.round(c.trollScore)).join(' | '));
  }

  const DEDUP = Math.max(spacing * 0.6, 150);
  const chosen = [];
  for (const c of candidates) {
    const dup = chosen.some(k => distBearing(c.mid[1], c.mid[0], k.mid[1], k.mid[0])[0] < DEDUP);
    if (!dup) chosen.push(c);
    if (chosen.length >= lanes) break;
  }
  if (!chosen.length) return [];

  // DIAGNOSTIC (2026-07-03): part of the same investigation above — logs
  // which physical spine(s) actually got selected after stitching/dedup,
  // so we can tell if different depth bands are landing on the exact same
  // contour line (which would explain identical output even with a
  // correctly-varying depth filter upstream).
  console.log(`[route-builder] depth band ${depthMin}-${depthMax}ft: chose ${chosen.length} spine(s) — ${chosen.map(c => `depth=${c.depth}ft@[${c.mid[1].toFixed(4)},${c.mid[0].toFixed(4)}] len=${Math.round(c.len)}ft`).join(' | ')}`);
  if (chosen[0]) {
    const s0 = chosen[0].coords;
    const first = s0[0], last = s0[s0.length-1];
    console.log(`[route-builder] spine[0] first=[${first[1].toFixed(5)},${first[0].toFixed(5)}] last=[${last[1].toFixed(5)},${last[0].toFixed(5)}] pts=${s0.length}`);
  }

  // ── TRUE band width (across the depth gradient) ──────────────────────────────
  // The amplitude must carry you from the shallow edge of the band (depthMin) to
  // the deep edge (depthMax). Measure that by taking the shallowest-depth and
  // deepest-depth contours in range as the band EDGES, then sampling, at points
  // along the spine, the perpendicular distance from the spine out to each edge.
  // Median of those samples = real band half-width. This is what was missing —
  // the old midpoint-to-midpoint measure was along-contour, not across it.
  const minD = Math.min(...candidates.map(c => c.depth));
  const maxD = Math.max(...candidates.map(c => c.depth));
  const shallowEdge = candidates.filter(c => c.depth <= minD + 1);
  const deepEdge    = candidates.filter(c => c.depth >= maxD - 1);

  function bandHalfWidthForSpine(spineCoords) {
    const samp = resampleContour(spineCoords, 250); // sample the spine every 250ft
    const widths = [];
    for (const pt of samp) {
      const toShallow = nearestContourDistFt(pt, shallowEdge);
      const toDeep    = nearestContourDistFt(pt, deepEdge);
      // Full local band width ≈ distance to shallow edge + distance to deep edge.
      // (Spine sits somewhere inside the band; summing both reaches edge-to-edge.)
      const w = (isFinite(toShallow) ? toShallow : 0) + (isFinite(toDeep) ? toDeep : 0);
      if (w > 0 && w < 4000) widths.push(w);
    }
    if (!widths.length) return amplitude;
    widths.sort((a, b) => a - b);
    // Use the 70th percentile (not median) so the swing reaches into the wider
    // parts of the band rather than being held down by the tightest pinch points.
    const p70 = widths[Math.min(widths.length - 1, Math.floor(widths.length * 0.7))];
    return p70 / 2; // half-width = amplitude basis
  }

  // The amplitude input now acts as a MULTIPLIER on the measured band half-width
  // (default 30 → ~1.0x; treat the slider's 30 as the neutral "fill the band"
  // value). Users can dial it down to stay nearer the centre or up to overshoot.
  const ampScale = (amplitude || 30) / 30;
  const waveFt = Math.max(wave || 300, 150);

  // Order passes by position ALONG the band so the lawnmower runs in sequence
  // rather than jumping around. Project each spine midpoint onto the dominant
  // contour bearing and sort by that scalar.
  let sinSum = 0, cosSum = 0;
  for (const c of chosen) {
    for (let i = 1; i < c.coords.length; i++) {
      const [segLen, brng] = distBearing(c.coords[i-1][1], c.coords[i-1][0], c.coords[i][1], c.coords[i][0]);
      if (segLen < 5) continue;
      const r = ((brng % 180) * 2) * Math.PI / 180;
      sinSum += Math.sin(r) * segLen; cosSum += Math.cos(r) * segLen;
    }
  }
  const acrossBrng = (((Math.atan2(sinSum, cosSum) * 180 / Math.PI / 2) + 180) % 180 + 90) % 360;
  const ref = chosen[0].mid; // [lon,lat]
  chosen.forEach(c => {
    const [d, b] = distBearing(ref[1], ref[0], c.mid[1], c.mid[0]);
    c.acrossProj = d * Math.cos(((b - acrossBrng + 540) % 360 - 180) * Math.PI / 180);
  });
  chosen.sort((a, b) => a.acrossProj - b.acrossProj);

  const tracks = [];
  let flip = false;
  for (let i = 0; i < chosen.length; i++) {
    const src = chosen[i];
    let spine = resampleContour(src.coords, waveFt);
    // Trim the spine to the part inside the area box BEFORE patterning, so the
    // route runs only over the in-box stretch (no fold-backs from snapping).
    spine = trimSpineToClip(spine);
    if (spine.length < 2) continue;

    // True local band half-width for THIS spine, scaled by the amplitude input.
    // Floored at the raw amplitude so a degenerate measurement never collapses
    // the swing to nothing.
    // Use the user's amplitude setting directly.
    // The auto-measured band half-width was overriding user input with huge values
    // on narrow water bodies like creeks, causing routes to swing over land.
    const passAmplitude = amplitude;

    // SMART ONE-WAY CONTINUOUS CIRCUIT SHAPING:
    // App route points are [lat,lon]. Raw GeoJSON is [lon,lat] only before
    // resampleContour(). The old code accidentally swapped these during the
    // nearest-to-ramp/orientation step, which made tracks pass near the ramp but
    // begin a mile away. Prepare the spine by slicing at the point nearest the
    // phase start, then choose the direction that best fits this phase.
    const targetPassFt = cfg.targetLengthFt || 15000;
    spine = prepareSpineForPhase(spine, cfg);
    if (spine.length < 2) continue;

    let pts = patternAlongSpine(spine, {
      pattern, amplitude: passAmplitude, wave: waveFt, straightFt, spacing,
    });
    pts = clampToClip(pts);
    if (targetPassFt > 0) pts = trimPolylineToLength(pts, targetPassFt);
    if (pts.length < 2) continue;

    // Max-gap split: don't draw lines across land gaps > 400ft
    const MAX_GAP_FT = 400;
    const segments = [];
    let seg = [pts[0]];
    for (let k = 1; k < pts.length; k++) {
      const [gapFt] = distBearing(pts[k-1][0], pts[k-1][1], pts[k][0], pts[k][1]);
      if (gapFt > MAX_GAP_FT) {
        if (seg.length >= 2) segments.push(seg);
        seg = [pts[k]];
      } else { seg.push(pts[k]); }
    }
    if (seg.length >= 2) segments.push(seg);
    const MAX_PTS_PER_TRACK = 3000;
    const baseName = lanes > 1 ? 'Sweep_' + depthMin + '-' + depthMax + 'ft_L' + (i+1) : 'Sweep_' + depthMin + '-' + depthMax + 'ft';
    for (let si = 0; si < segments.length; si++) {
      let segPts = segments[si];
      if (segPts.length > MAX_PTS_PER_TRACK) segPts = segPts.slice(0, MAX_PTS_PER_TRACK);
      tracks.push({
        name: segments.length > 1 ? baseName + '_S' + (si+1) : baseName,
        pts: segPts,
        depth: (depthMin + depthMax) / 2,
      });
    }
  }
  return tracks;
}


// ── Depth polygon edge routing ────────────────────────────────────────────────
//
// Uses the DEPARE depth zone polygons from supplemental-layers.js instead of
// contour lines. Extracts the boundary edges between depth zones and routes
// along them — this gives the actual drop-off line where fish hold.
//
// Edge extraction strategy:
//   For each polygon in the target depth band, iterate its outer ring edges.
//   An edge is a "drop-off edge" if it borders a shallower polygon.
//   We approximate this by keeping edges on the shallow side of the polygon
//   boundary — i.e. the outer ring segments where the polygon is transitioning
//   from shallow to deep. In practice we keep all outer ring edges and let
//   the spine scoring (proximity to start point + bearing lock) pick the
//   right ones near the current position.

// ── Depth polygon shared-edge extraction ─────────────────────────────────────
//
// Previous approach: dump ALL outer ring edges of any polygon overlapping the
// target band → 57k+ raw edges, mostly internal polygon noise.
//
// New approach: dynamically discover band boundaries in the loaded GeoJSON,
// find which transition edge sits inside the requested depth range, then
// extract only edges that are SHARED between the shallow polygon and its
// adjacent deeper neighbor. Those shared edges are the true drop-off lines.
//
// Works for any lake — no hardcoded depth values.

function ftBetweenLonLat([lon1, lat1], [lon2, lat2]) {
  const R = 20902231, D = Math.PI / 180;
  const dlat = (lat2 - lat1) * D, dlon = (lon2 - lon1) * D;
  const a = Math.sin(dlat/2)**2 + Math.cos(lat1*D)*Math.cos(lat2*D)*Math.sin(dlon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Extract all outer-ring edges of a feature as [lonA, lonB] pairs.
function featureEdges(feat) {
  const geom = feat.geometry;
  if (!geom) return [];
  let rings = [];
  if (geom.type === 'Polygon') rings = [geom.coordinates[0]];
  else if (geom.type === 'MultiPolygon') rings = geom.coordinates.map(p => p[0]);
  const edges = [];
  for (const ring of rings) {
    if (!ring || ring.length < 3) continue;
    for (let i = 0; i < ring.length - 1; i++) edges.push([ring[i], ring[i + 1]]);
  }
  return edges;
}

// Cache shared edges by depth range key to avoid recomputing on every phase
// Persisted to sessionStorage so reloads don't require full recompute
const _depthEdgeCache = new Map();
const _EDGE_CACHE_PREFIX = 'trollmap_edges_';

function _loadEdgeCache(cacheKey) {
  if (_depthEdgeCache.has(cacheKey)) return _depthEdgeCache.get(cacheKey);
  try {
    const raw = sessionStorage.getItem(_EDGE_CACHE_PREFIX + cacheKey);
    if (raw) {
      const edges = JSON.parse(raw);
      _depthEdgeCache.set(cacheKey, edges);
      return edges;
    }
  } catch (_) {}
  return null;
}

function _saveEdgeCache(cacheKey, edges) {
  _depthEdgeCache.set(cacheKey, edges);
  try { sessionStorage.setItem(_EDGE_CACHE_PREFIX + cacheKey, JSON.stringify(edges)); } catch (_) {}
}

function getDepthPolygonEdges(depthMinFt, depthMaxFt) {
  const cacheKey = `${depthMinFt}|${depthMaxFt}`;
  const cached = _loadEdgeCache(cacheKey);
  if (cached) return cached;
  const gj = getDepthAreaGeoJSON()
    || window.SUPPLEMENTAL_DEPTH_GEOJSON
    || globalThis.SUPPLEMENTAL_DEPTH_GEOJSON;

  if (!gj?.features?.length) {
    console.log('[route-builder] no depth polygon GeoJSON available — falling back to contour routing');
    return [];
  }

  // ── Step 1: discover all distinct depth bands present in this lake's data ──
  const bandSet = new Set();
  for (const f of gj.features) {
    const p = f.properties || {};
    const mn = p.depth_min_ft, mx = p.depth_max_ft;
    if (mn != null && mx != null) bandSet.add(`${mn}|${mx}`);
  }
  // Sort bands by depth_min so adjacency is positional
  const allBands = [...bandSet].map(s => {
    const [mn, mx] = s.split('|').map(Number);
    return { min: mn, max: mx };
  }).sort((a, b) => a.min - b.min);

  // ── Step 2: find all adjacent band pairs whose shared boundary falls inside
  //    the requested depth range. The boundary between band A (max=N) and
  //    band B (min=N) is at depth N — keep it if depthMinFt < N < depthMaxFt.
  //    Also include the shallowest band edge if depthMinFt == band.min, and
  //    deepest band edge if depthMaxFt == band.max (explicit band boundaries).
  const transitionDepths = new Set();
  for (let i = 0; i < allBands.length - 1; i++) {
    const boundary = allBands[i].max; // == allBands[i+1].min for adjacent bands
    if (boundary > depthMinFt && boundary < depthMaxFt) {
      transitionDepths.add(boundary);
    }
  }
  if (transitionDepths.size === 0) {
    for (const b of allBands) {
      if (b.min >= depthMinFt && b.max <= depthMaxFt) {
        transitionDepths.add(b.min);
        transitionDepths.add(b.max);
      }
    }
    // If still empty, find band boundary nearest the range midpoint
    if (transitionDepths.size === 0) {
      const mid = (depthMinFt + depthMaxFt) / 2;
      let bestBoundary = null, bestDist = Infinity;
      for (let i = 0; i < allBands.length - 1; i++) {
        const boundary = allBands[i].max;
        const dist = Math.abs(boundary - mid);
        if (dist < bestDist) { bestDist = dist; bestBoundary = boundary; }
      }
      if (allBands.length) {
        if (Math.abs(allBands[0].min - mid) < bestDist) bestBoundary = allBands[0].min;
        if (Math.abs(allBands[allBands.length-1].max - mid) < bestDist) bestBoundary = allBands[allBands.length-1].max;
      }
      if (bestBoundary != null) transitionDepths.add(bestBoundary);
    }
  }

  console.log(`[route-builder] depth polygon edges: target ${depthMinFt}-${depthMaxFt}ft, transition boundaries at [${[...transitionDepths].sort((a,b)=>a-b).join(', ')}]ft`);

  // ── Step 3: for each transition depth N, collect edges from the shallower
  //    polygon (depth_max_ft == N) and the deeper polygon (depth_min_ft == N).
  //    An edge is a TRUE shared boundary if a geometrically near-identical edge
  //    exists in the adjacent polygon (within SHARED_TOL_FT). These are the
  //    actual drop-off lines fish hold on.
  const SHARED_TOL_FT = 25; // vertices must be within 25ft to be "shared"
  const sharedEdges = [];

  for (const boundary of transitionDepths) {
    const shallowFeats = gj.features.filter(f => (f.properties?.depth_max_ft ?? -1) === boundary);
    const deepFeats    = gj.features.filter(f => (f.properties?.depth_min_ft ?? -1) === boundary);

    if (!shallowFeats.length || !deepFeats.length) {
      // Only one side found — just use those edges directly (lake edge / dam boundary)
      const soloFeats = shallowFeats.length ? shallowFeats : deepFeats;
      for (const f of soloFeats) sharedEdges.push(...featureEdges(f));
      continue;
    }

    // Build a flat list of all deep-polygon edge midpoints for proximity check
    const deepEdgeMids = [];
    for (const f of deepFeats) {
      for (const [a, b] of featureEdges(f)) {
        deepEdgeMids.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      }
    }

    // Keep only shallow edges whose midpoint is within SHARED_TOL_FT of any
    // deep edge midpoint — those are the geometrically shared boundary edges.
    for (const f of shallowFeats) {
      for (const edge of featureEdges(f)) {
        const mid = [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2];
        const isShared = deepEdgeMids.some(dm => ftBetweenLonLat(mid, dm) < SHARED_TOL_FT);
        if (isShared) sharedEdges.push(edge);
      }
    }
  }

  console.log(`[route-builder] depth polygon edges: ${sharedEdges.length} shared transition edges for ${depthMinFt}-${depthMaxFt}ft`);
  _saveEdgeCache(cacheKey, sharedEdges);
  return sharedEdges;
}

// Clear edge cache when lake changes
export function clearDepthEdgeCache() { _depthEdgeCache.clear(); }

// Convert raw edges into spine-format objects compatible with buildStitchedSpines output
function edgesToSpines(edges, depthMin, depthMax) {
  if (!edges.length) return [];

  const TOL_FT = 30;
  const MAX_TURN_DEG = 30; // same as stitchFragments — no U-turns
  const MIN_BEARING_DIST = 25; // ft before bearing is reliable
  const used = new Set();
  const chains = [];

  // Get a stable bearing leaving a point along a chain direction
  function chainExitBearing(chain) {
    const n = chain.length;
    if (n < 2) return null;
    const ref = chain[n - 1];
    for (let k = n - 2; k >= 0; k--) {
      const [d, b] = distBearing(ref[1], ref[0], chain[k][1], chain[k][0]);
      if (d >= MIN_BEARING_DIST) return (b + 180) % 360; // reverse = exit direction
    }
    const [, b] = distBearing(chain[0][1], chain[0][0], chain[n-1][1], chain[n-1][0]);
    return b;
  }

  function angleDiff2(a, b) {
    const d = Math.abs(((a - b + 540) % 360) - 180);
    return d;
  }

  // Build chains greedily — connect edges within TOL_FT AND within MAX_TURN_DEG
  for (let i = 0; i < edges.length; i++) {
    if (used.has(i)) continue;
    const chain = [...edges[i]];
    used.add(i);
    let extended = true;
    while (extended) {
      extended = false;
      const tail = chain[chain.length - 1];
      const exitBrng = chainExitBearing(chain);

      let bestJ = -1, bestScore = Infinity, bestPushPt = null;
      for (let j = 0; j < edges.length; j++) {
        if (used.has(j)) continue;
        const [ea, eb] = edges[j];
        // Try connecting ea to tail (push eb), or eb to tail (push ea)
        const dA = ftBetweenLonLat(tail, ea);
        const dB = ftBetweenLonLat(tail, eb);
        for (const [d, pushPt, inPt] of [[dA, eb, ea], [dB, ea, eb]]) {
          if (d > TOL_FT) continue;
          // Check turn angle if we have a reliable exit bearing
          if (exitBrng !== null) {
            // Direction from tail toward inPt (the connecting end)
            const [dd, inBrng] = distBearing(tail[1], tail[0], inPt[1], inPt[0]);
            if (dd >= MIN_BEARING_DIST) {
              const turn = angleDiff2(exitBrng, inBrng);
              if (turn > MAX_TURN_DEG) continue; // too sharp — skip
              const score = d + turn * 2;
              if (score < bestScore) { bestScore = score; bestJ = j; bestPushPt = pushPt; }
            } else {
              // inPt too close to measure — accept on distance alone
              if (d < bestScore) { bestScore = d; bestJ = j; bestPushPt = pushPt; }
            }
          } else {
            if (d < bestScore) { bestScore = d; bestJ = j; bestPushPt = pushPt; }
          }
        }
      }

      if (bestJ >= 0) {
        chain.push(bestPushPt);
        used.add(bestJ);
        extended = true;
      }
    }
    if (chain.length >= 3) chains.push(chain);
  }

  const depth = (depthMin + depthMax) / 2;
  return chains.map(chain => ({
    coords: chain,
    len:    contourArcLength(chain),
    depth,
    mid:    chain[Math.floor(chain.length / 2)],
  })).filter(s => s.len >= 200).sort((a, b) => b.len - a.len);
}

function generateDepthPolygonRoutes(cfg) {
  const { depthMin, depthMax } = cfg;

  // Get edges from depth polygons
  const edges = getDepthPolygonEdges(depthMin, depthMax);
  if (!edges.length) {
    console.log(`[route-builder] no depth polygon edges for ${depthMin}-${depthMax}ft — falling back to contour routing`);
    return null; // signal to fall back
  }

  console.log(`[route-builder] depth polygon routing: ${edges.length} edges for ${depthMin}-${depthMax}ft`);

  // Build spines from edges
  let candidates = edgesToSpines(edges, depthMin, depthMax);
  if (!candidates.length) return null;

  // Apply clip polygon filter
  if (clipPolygon) {
    candidates = candidates.filter(s => {
      // Keep spines that have at least one point inside the clip
      return s.coords.some(([lon, lat]) => pointInPolygon([lat, lon], clipPolygon));
    });
  }
  if (!candidates.length) return null;

  // Score candidates by proximity to start point and bearing — same as contour routing
  const refLat = cfg.startLat != null ? cfg.startLat : cfg.rampLat;
  const refLon = cfg.startLon != null ? cfg.startLon : cfg.rampLon;
  const lockedBearing = cfg.lockedBearing ?? null;

  if (refLat != null && refLon != null) {
    // For singleBestTrack (smart plan) phases, cap how far the chosen spine
    // can be from the phase start — same logic as contour routing.
    const MAX_SPINE_DIST_FT = cfg.singleBestTrack ? 5280 : Infinity; // 1mi cap for smart plan
    const eLat = cfg.endLat;
    const eLon = cfg.endLon;
    const lenCap = (cfg.targetLengthFt || 15000) * 3;

    candidates.forEach(s => {
      const closestFt = closestPointOnSpineFt(refLat, refLon, s.coords);
      if (s.len < 500) { s.trollScore = -Infinity; s._closestFt = closestFt; return; }
      if (closestFt > MAX_SPINE_DIST_FT) { s.trollScore = -Infinity; s._closestFt = closestFt; return; }
      // Reject cove-loop spines that don't travel anywhere — start-to-end displacement < 1500ft
      if (s.coords?.length >= 2) {
        const sc = s.coords[0], ec = s.coords[s.coords.length-1];
        const disp = distBearing(sc[1], sc[0], ec[1], ec[0])[0];
        if (disp < 1500) { s.trollScore = -Infinity; s._closestFt = closestFt; return; }
      }
      const startPenalty = closestFt * 3;
      const lenScore = Math.min(s.len, lenCap);
      let endPenalty = 0;
      if (cfg.isReturnPass && eLat != null && eLon != null) {
        const endDistFt = closestPointOnSpineFt(eLat, eLon, s.coords);
        endPenalty = endDistFt * 7; // heavier for return pass — keeps lake-length monsters from winning over well-positioned spines
      }
      let bearingBonus = 0;
      if (lockedBearing !== null && s.coords.length >= 2) {
        const [, spineBrng] = distBearing(s.coords[0][1], s.coords[0][0], s.coords[s.coords.length-1][1], s.coords[s.coords.length-1][0]);
        const diff = Math.abs(((spineBrng - lockedBearing + 540) % 360) - 180);
        bearingBonus = diff < 90 ? (1 - diff / 90) * 5000 : -3000;
      }
      s.trollScore = (lenScore * 2) - startPenalty - endPenalty + bearingBonus;
      s._closestFt = closestFt;
    });
    candidates.sort((a, b) => (b.trollScore || 0) - (a.trollScore || 0));
    console.log('[route-builder] polygon top 3 spines: ' + candidates.slice(0,3).map(c =>
      `closest=${Math.round(c._closestFt)}ft len=${Math.round(c.len)}ft score=${Math.round(c.trollScore)}`
    ).join(' | '));
  }

  // Pick best spine
  const spine = candidates[0];
  if (!spine) return null;

  // Trim to clip and prepare for patterning — same pipeline as contour routing
  let trimmed = trimSpineToClip(spine.coords.map(([lon, lat]) => [lat, lon]));
  if (trimmed.length < 2) return null;

  // Pre-trim the spine to targetLengthFt before patterning so we don't
  // generate a 100mi sine wave over a 629,903ft contour and then try to
  // trim after the fact. Pattern inflates distance (sine traverses more
  // ground than the spine), so cap the spine at targetLengthFt first.
  // The post-pattern trim below handles any remaining overshoot.
  const targetPassFt = (Number.isFinite(cfg.targetLengthFt) && cfg.targetLengthFt > 0)
    ? cfg.targetLengthFt : 15000;
  // DEBUG: log spine before and after prepareSpineForPhase
  const _dbgRaw = trimmed;
  const _dbgRawStart = _dbgRaw.slice(0,3).map(p=>`(${p[0].toFixed(5)},${p[1].toFixed(5)})`).join('→');
  const _dbgRawEnd = _dbgRaw.slice(-3).map(p=>`(${p[0].toFixed(5)},${p[1].toFixed(5)})`).join('→');
  console.log(`[SPINE-DEBUG] raw: ${_dbgRaw.length}pts start=${_dbgRawStart} end=${_dbgRawEnd}`);
  trimmed = prepareSpineForPhase(trimmed, cfg);
  if (trimmed.length < 2) return null;
  const _dbgPrep = trimmed;
  const _dbgPrepStart = _dbgPrep.slice(0,3).map(p=>`(${p[0].toFixed(5)},${p[1].toFixed(5)})`).join('→');
  const _dbgPrepEnd = _dbgPrep.slice(-3).map(p=>`(${p[0].toFixed(5)},${p[1].toFixed(5)})`).join('→');
  console.log(`[SPINE-DEBUG] prepared: ${_dbgPrep.length}pts start=${_dbgPrepStart} end=${_dbgPrepEnd}`);
  // Write to a visible element so it can be read without console
  try {
    const el = document.getElementById('planSmartPlanOutput') || document.getElementById('planRationale') || document.getElementById('planOutput');
    if (el) el.value = (el.value||'') + '\n[SPINE] raw:' + _dbgRawStart + '...' + _dbgRawEnd + '\n[SPINE] prep:' + _dbgPrepStart + '...' + _dbgPrepEnd;
  } catch(_) {}

  // Apply pattern along the (now properly bounded) spine
  // Smart Plan always uses straight pattern — sine causes clipping artifacts
  const spPattern = cfg.smartPlan ? 'straight' : (cfg.pattern || 'sine+straight');
  const spAmplitude = cfg.smartPlan ? 0 : (cfg.amplitude || 25);
  let pts = clampToClip(patternAlongSpine(trimmed, {
    ...cfg,
    pattern: spPattern,
    amplitude: spAmplitude,
  }));
  if (pts.length < 2) return null;

  // Post-pattern trim: sine inflates distance beyond spine length, so trim
  // the patterned output to the target length as the final hard cap.
  pts = trimPolylineToLength(pts, targetPassFt);
  if (pts.length < 2) return null;

  const MAX_PTS = 3000;
  const finalPts = pts.length > MAX_PTS ? pts.slice(0, MAX_PTS) : pts;

  return [{
    name:  `Sweep_${depthMin}-${depthMax}ft`,
    pts:   finalPts,
    depth: (depthMin + depthMax) / 2,
  }];
}


// ── Follow mode: trace a specific contour with pattern applied along its shape ─

function generateFollowRoutes(cfg) {
  // FOLLOW mode: spine = the target contour line itself.
  // Sine oscillates perpendicular to direction of travel, naturally crossing
  // into neighbouring depths (17/19ft when targeting 18ft) based on local
  // contour spacing — tight contours = small depth swing, wide = larger swing.
  const contour = getActiveContour();
  const gj = contour?.smart || contour?.raw;
  if (!gj?.features?.length) return [];

  const { depthMin, depthMax, spacing, wave, straightFt } = cfg;
  const pattern = cfg.smartPlan ? 'straight' : (cfg.pattern || 'sine+straight');
  const amplitude = cfg.smartPlan ? 0 : (cfg.amplitude || 30);

  const inRange = gj.features.filter(f => {
    const d = f.properties?.depth_ft;
    return d != null && d >= depthMin && d <= depthMax;
  });
  if (!inRange.length) return [];

  const scoped = clipPolygon ? inRange.filter(f => featureIntersectsClip(f)) : inRange;
  if (!scoped.length) return [];

  // Tunables: with an area box drawn the user has explicitly scoped things, so we
  // can relax. Without one, be more selective and cap output — otherwise the lake
  // sprays many short fragments (the "lanes everywhere" problem).
  const MIN_LEN_FT = clipPolygon ? 250 : 500;   // drop short stitched chains
  const MAX_ROUTES = clipPolygon ? 12  : 6;      // cap total emitted routes

  // Stitch same-depth fragments into long chains, then keep the longest usable
  // ones. Stitching is what turns dozens of 120ft stubs into a handful of real
  // 1000ft+ contours.
  const spines = buildStitchedSpines(scoped).filter(s => s.len >= MIN_LEN_FT);
  if (!spines.length) return [];

  // Dedup near-duplicate chains (stacked / overlapping lines). Sample points and
  // drop any chain that overlaps an already-kept one for most of its length.
  const DEDUP = Math.max(spacing, 200);
  const keptSpines = [];
  for (const sp of spines) {
    const sample = resampleContour(sp.coords, 300);
    const dup = keptSpines.some(k => {
      let near = 0;
      for (const p of sample) if (nearestContourDistFt(p, [{ coords: k.coords }]) < DEDUP) near++;
      return near / sample.length > 0.6;
    });
    if (!dup) keptSpines.push(sp);
    if (keptSpines.length >= MAX_ROUTES) break;
  }
  const kept = keptSpines.map(s => ({ feat: { properties: { depth_ft: s.depth } }, coords: s.coords, pathLen: s.len }));

  // For each kept contour: resample to wave-length intervals, apply pattern
  // between consecutive waypoints so sine has room to develop along the contour.
  const RESAMPLE_FT = Math.max(wave || 300, 150);
  const tracks = [];

  for (const { feat, coords } of kept) {
    const depth = feat.properties.depth_ft;
    let waypoints = resampleContour(coords, RESAMPLE_FT);
    // Trim to the in-box stretch before patterning (no fold-backs).
    waypoints = trimSpineToClip(waypoints);
    if (waypoints.length < 2) continue;

    let allPts = patternAlongSpine(waypoints, { pattern, amplitude, wave, straightFt, spacing });
    allPts = clampToClip(allPts);
    // After trimming, only keep routes that are still a useful length.
    if (allPts.length > 1 && trackLengthFt(allPts) >= MIN_LEN_FT * 0.6) {
      tracks.push({ name: `Follow_${depth}ft`, pts: allPts, depth });
    }
  }
  return tracks;
}

// Arc length of a [lat,lon] point list, in feet.
function trackLengthFt(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) {
    const [d] = distBearing(pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1]);
    l += d;
  }
  return l;
}

function isValidLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function distancePointToRefFt(pt, lat, lon) {
  if (!pt || !isValidLatLon(lat, lon)) return Infinity;
  // App route points are ALWAYS [lat, lon]. Raw GeoJSON is the only lon/lat source.
  return distBearing(lat, lon, pt[0], pt[1])[0];
}

function nearestPointIndex(pts, lat, lon) {
  if (!pts?.length || !isValidLatLon(lat, lon)) return 0;
  let bestIdx = 0;
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = distancePointToRefFt(pts[i], lat, lon);
    if (d < best) { best = d; bestIdx = i; }
  }
  return bestIdx;
}

function trimPolylineToLength(pts, maxFt) {
  if (!pts?.length || !Number.isFinite(maxFt) || maxFt <= 0) return pts || [];
  if (pts.length < 2) return pts;
  const out = [pts[0]];
  let used = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const [segFt, brng] = distBearing(a[0], a[1], b[0], b[1]);
    if (used + segFt <= maxFt) {
      out.push(b);
      used += segFt;
      continue;
    }
    const remain = Math.max(0, maxFt - used);
    if (remain > 5) out.push(destination(a[0], a[1], brng, remain));
    break;
  }
  return out.length >= 2 ? out : pts.slice(0, 2);
}

function availableLength(pts) {
  return pts?.length >= 2 ? trackLengthFt(pts) : 0;
}

function prepareSpineForPhase(spine, cfg) {
  if (!spine?.length) return spine || [];
  const sLat = cfg.startLat != null ? cfg.startLat : cfg.rampLat;
  const sLon = cfg.startLon != null ? cfg.startLon : cfg.rampLon;
  const eLat = cfg.endLat;
  const eLon = cfg.endLon;

  let candidates = [];
  if (isValidLatLon(sLat, sLon)) {
    // Prefer starting from whichever END of the spine is closest to the phase start.
    // This gives the full spine length to travel rather than a half-spine from the middle.
    const dStart = distancePointToRefFt(spine[0], sLat, sLon);
    const dEnd   = distancePointToRefFt(spine[spine.length - 1], sLat, sLon);
    if (dEnd < dStart) {
      // End is closer — run the spine in reverse (end → start)
      candidates.push(spine.slice().reverse());
      candidates.push(spine);
    } else {
      // Start is closer — run forward
      candidates.push(spine);
      candidates.push(spine.slice().reverse());
    }
    // Also offer the mid-slice options as fallback candidates
    const idx = nearestPointIndex(spine, sLat, sLon);
    const forward = spine.slice(idx);
    const reverse = spine.slice(0, idx + 1).reverse();
    if (forward.length >= 2) candidates.push(forward);
    if (reverse.length >= 2) candidates.push(reverse);
  } else {
    candidates = [spine];
    if (spine.length >= 2) candidates.push(spine.slice().reverse());
  }

  if (!candidates.length) return spine;

  const target = Number.isFinite(cfg.targetLengthFt) && cfg.targetLengthFt > 0 ? cfg.targetLengthFt : 0;
  const scoreCandidate = (pts) => {
    const len = availableLength(pts);
    const startPenalty = isValidLatLon(sLat, sLon) ? distancePointToRefFt(pts[0], sLat, sLon) : 0;
    const lengthPenalty = target ? Math.max(0, target - len) * 0.35 : 0;
    let endPenalty = 0;
    if (cfg.isReturnPass && isValidLatLon(eLat, eLon)) {
      endPenalty = distancePointToRefFt(pts[pts.length - 1], eLat, eLon);
    }
    let bearingPenalty = 0;
    if (!cfg.isReturnPass && cfg.lockedBearing != null && pts.length >= 2) {
      const [, brng] = distBearing(pts[0][0], pts[0][1], pts[Math.min(pts.length - 1, 2)][0], pts[Math.min(pts.length - 1, 2)][1]);
      const diff = Math.abs(((brng - cfg.lockedBearing + 540) % 360) - 180);
      bearingPenalty = diff > 90 ? 500 : diff * 2;
    }
    // Lower is better. For return phases, ending close to ramp matters most.
    return startPenalty + lengthPenalty + endPenalty + bearingPenalty - Math.min(len, target || 5000) * 0.02;
  };

  candidates.sort((a, b) => scoreCandidate(a) - scoreCandidate(b));
  let out = candidates[0];
  if (target > 0) out = trimPolylineToLength(out, target);


  // Guarantee the trimmed route starts within 500ft  // Guarantee the trimmed route starts within 500ft of the phase start point.
  // If it doesn't, the angler has to cross good water to reach the route —
  // unacceptable. Snap the first point to the nearest spine vertex within 500ft.
  if (isValidLatLon(sLat, sLon) && out?.length >= 2) {
    const startDist = distancePointToRefFt(out[0], sLat, sLon);
    if (startDist > 500) {
      // Walk the trimmed route to find the closest point to phase start
      let bestIdx = 0, bestDist = startDist;
      for (let i = 1; i < Math.min(out.length, 50); i++) {
        const d = distancePointToRefFt(out[i], sLat, sLon);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      // Slice from the closest point if it meaningfully reduces start distance
      if (bestDist < startDist * 0.5 && out.length - bestIdx >= 2) {
        out = out.slice(bestIdx);
      }
    }
  }

  // For return passes: after trimming, check if the actual trimmed endpoint
  // ends near the ramp. If more than 3000ft away, try other candidates and
  // take whichever trimmed version ends closest to the ramp.
  if (cfg.isReturnPass && isValidLatLon(eLat, eLon) && out?.length >= 2) {
    const endDistFt = distancePointToRefFt(out[out.length - 1], eLat, eLon);
    if (endDistFt > 3000 && candidates.length > 1) {
      let bestEndDist = endDistFt;
      let bestOut = out;
      for (let i = 1; i < candidates.length; i++) {
        const alt = target > 0 ? trimPolylineToLength(candidates[i], target) : candidates[i];
        if (!alt?.length) continue;
        const altEndDist = distancePointToRefFt(alt[alt.length - 1], eLat, eLon);
        if (altEndDist < bestEndDist) { bestEndDist = altEndDist; bestOut = alt; }
      }
      out = bestOut;
    }
  }

  return out;
}

function buildConnectorTrack(name, fromLat, fromLon, toLat, toLon, role = 'connector') {
  if (!isValidLatLon(fromLat, fromLon) || !isValidLatLon(toLat, toLon)) return null;
  const [connDistFt, brng] = distBearing(fromLat, fromLon, toLat, toLon);
  if (!Number.isFinite(connDistFt) || connDistFt < 3) return null;
  const stepFt = 250;
  const n = Math.max(1, Math.ceil(connDistFt / stepFt));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    pts.push(destination(fromLat, fromLon, brng, connDistFt * i / n));
  }
  // Force exact endpoints so GPX exports prove the route is anchored.
  pts[0] = [fromLat, fromLon];
  pts[pts.length - 1] = [toLat, toLon];
  return { name, pts, role, connector: true, smartPlan: true, lengthFt: connDistFt };
}

function addOrSnapConnector(out, name, fromLat, fromLon, targetTrack, role) {
  if (!targetTrack?.pts?.length || !isValidLatLon(fromLat, fromLon)) return;
  const first = targetTrack.pts[0];
  const [d] = distBearing(fromLat, fromLon, first[0], first[1]);
  if (d <= 25) {
    targetTrack.pts[0] = [fromLat, fromLon];
    return;
  }
  const c = buildConnectorTrack(name, fromLat, fromLon, first[0], first[1], role);
  if (c) out.push(c);
}


// ── Existing saved waypoints (auto-detected from state.DATA) ──────────────────

// Field names we'll look for, in priority order. Each should hold an array of
// objects with some flavour of lat/lon (lat/lon, lat/lng, latitude/longitude)
// or a [lon,lat]/[lat,lon] coords pair.
const WPT_FIELDS = ['waypoints', 'wpts', 'marks', 'markers', 'catches', 'points', 'pins'];

function coerceLatLon(o) {
  if (!o) return null;
  // Direct lat/lon-ish properties
  const lat = o.lat ?? o.latitude ?? o.y;
  const lon = o.lon ?? o.lng ?? o.long ?? o.longitude ?? o.x;
  if (typeof lat === 'number' && typeof lon === 'number') {
    return { lat, lon, name: o.name || o.label || o.title || '' };
  }
  const name = o.name || o.label || o.title || '';

  // True GeoJSON geometry is ALWAYS [lon, lat] by spec — handle explicitly so we
  // never mis-swap when both values happen to be < 90 (e.g. SC: lon ~-81, lat ~34).
  const gjc = o.geometry?.coordinates;
  if (Array.isArray(gjc) && gjc.length >= 2 && typeof gjc[0] === 'number' && typeof gjc[1] === 'number') {
    return { lat: gjc[1], lon: gjc[0], name };
  }

  // Leaflet LatLng array convention is [lat, lon].
  if (Array.isArray(o.latlng) && o.latlng.length >= 2) {
    return { lat: o.latlng[0], lon: o.latlng[1], name };
  }

  // Generic coords/coordinates pair of unknown order — use magnitude heuristic
  // (longitude in the continental US has |v| > 90; latitude does not).
  const c = o.coords || o.coordinates;
  if (Array.isArray(c) && c.length >= 2 && typeof c[0] === 'number' && typeof c[1] === 'number') {
    const [a, b] = c;
    if (Math.abs(a) > 90 && Math.abs(b) <= 90) return { lat: b, lon: a, name }; // [lon,lat]
    if (Math.abs(b) > 90 && Math.abs(a) <= 90) return { lat: a, lon: b, name }; // [lat,lon]
    return { lat: a, lon: b, name }; // ambiguous → assume [lat,lon]
  }
  return null;
}

// Returns [{lat,lon,name}, ...] from whichever DATA field holds waypoints.
function getSavedWaypoints() {
  const D = state.DATA;
  if (!D) return [];
  for (const field of WPT_FIELDS) {
    const arr = D[field];
    if (Array.isArray(arr) && arr.length) {
      const out = arr.map(coerceLatLon).filter(Boolean);
      if (out.length) return out;
    }
  }
  return [];
}

// ── Waypoint manual mode: connect clicked points with pattern ─────────────────

function generateWaypointRoute(cfg) {
  if (manualWaypoints.length < 2) return [];
  const { pattern, amplitude, wave, straightFt, spacing, closeLoop } = cfg;
  // Optionally append the first waypoint to the end to close the loop back to start.
  const seq = closeLoop ? [...manualWaypoints, manualWaypoints[0]] : manualWaypoints;
  const allPts = [];
  for (let i = 0; i < seq.length - 1; i++) {
    const p1 = seq[i];
    const p2 = seq[i + 1];
    const [segDist] = distBearing(p1[0], p1[1], p2[0], p2[1]);
    if (segDist < 5) continue;
    const pts = applyPattern(p1, p2, { pattern, amplitude, wave, straightFt, spacing });
    if (allPts.length === 0) allPts.push(...pts);
    else allPts.push(...pts.slice(1));
  }
  return allPts.length > 1 ? [{ name: closeLoop ? 'Waypoint Loop' : 'Waypoint Route', pts: allPts }] : [];
}

function renderWaypointMarkers() {
  waypointMarkers.forEach(m => state.MAP?.removeLayer(m));
  waypointMarkers = [];
  manualWaypoints.forEach(([lat, lon], i) => {
    const m = L.circleMarker([lat, lon], {
      radius: 5, color: '#00e5ff', fillColor: '#00e5ff', fillOpacity: 1, weight: 2
    }).addTo(state.MAP);
    m.bindTooltip(`WP${i+1}`, { permanent: false, direction: 'top' });
    waypointMarkers.push(m);
  });
  // Draw connecting line preview (closing back to WP1 if close-loop is checked)
  if (waypointMarkers._previewLine) state.MAP?.removeLayer(waypointMarkers._previewLine);
  if (manualWaypoints.length > 1) {
    const closeLoop = document.getElementById('rbCloseLoop')?.checked;
    const previewPts = closeLoop ? [...manualWaypoints, manualWaypoints[0]] : manualWaypoints;
    waypointMarkers._previewLine = L.polyline(previewPts, {
      color: '#00e5ff', weight: 1, opacity: 0.4, dashArray: '4 4'
    }).addTo(state.MAP);
    waypointMarkers.push(waypointMarkers._previewLine);
  }
  renderWaypointList();
}

function renderWaypointList() {
  const el = document.getElementById('rbWptList');
  if (!el) return;
  if (!manualWaypoints.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:10px;text-align:center;padding:4px">No waypoints yet — click map to add</div>';
    return;
  }
  el.innerHTML = manualWaypoints.map(([lat, lon], i) => `
    <div style="display:flex;align-items:center;gap:4px;padding:2px 0;border-bottom:1px solid var(--line)">
      <span style="font-size:10px;color:var(--accent);font-weight:600;min-width:22px">WP${i+1}</span>
      <span style="font-size:10px;color:var(--muted);flex:1">${lat.toFixed(5)}, ${lon.toFixed(5)}</span>
      <button onclick="window._rbRemoveWpt(${i})" style="height:18px;padding:0 5px;font-size:10px;border:1px solid var(--bad);background:transparent;color:var(--bad);border-radius:3px;cursor:pointer">✕</button>
    </div>`).join('');
}


// ── Render generated routes ───────────────────────────────────────────────────

function renderRoutes(tracks) {
  if (!state.MAP_OK) return;
  if (routeLayer) state.MAP.removeLayer(routeLayer);
  routeLayer = L.layerGroup();
  for (const t of tracks) {
    if (t.pts.length < 2) continue;
    L.polyline(t.pts, { color: '#000', weight: 5, opacity: 0.4 }).addTo(routeLayer);
    L.polyline(t.pts, { color: '#ff00e6', weight: 2, opacity: 1 }).addTo(routeLayer);
  }
  routeLayer.addTo(state.MAP);
  if (tracks.length) {
    const allPts = tracks.flatMap(t => t.pts);
    state.MAP.fitBounds(allPts, { padding: [40, 40] });
  }
}

// ── Panel UI ──────────────────────────────────────────────────────────────────

/**
 * generateAndCommitRoute(overrides) — callable by Smart Plan to auto-generate
 * and immediately commit a contour sweep route for a given phase.
 *
 * Merges phase-specific overrides (depthMin, depthMax, trackName) with
 * whatever settings are currently in the Route Builder panel UI (pattern,
 * spacing, amplitude, etc.) so the user's preferred settings are respected.
 *
 * Returns the committed tracks array (may be empty if no contours found).
 */
// ── Set clip polygon directly (called by Smart Plan Phase 3) ─────────────────
export function setClipPolygon(polygon) {
  clipPolygon = polygon;
  window._routeBuilderClipActive = !!polygon;
  if (polygon) {
    console.log(`[route-builder] clip set: custom polygon (${polygon.length} points)`);
  }
}

// ── Set clip polygon from ramp coords + range (called by Smart Plan) ──────────
export function setClipFromRamp(rampLat, rampLon, rangeMiles) {
  if (!rampLat || !rampLon || !rangeMiles) {
    clipPolygon = null;
    window._routeBuilderClipActive = false;
    return;
  }
  // Cap the clip radius. computeRangeMiles() falls back to full-battery range
  // (~16.7mi) when BLE isn't connected, which produces a bbox wider than most
  // SC lakes — the clip filter then admits every contour fragment and stitched
  // spines span the whole lake (see July 2 handoff known issue). A fishing
  // route has no business being a 33-mile-wide box regardless of how much
  // battery is theoretically left, so clamp to a sane planning radius.
  const MAX_CLIP_RADIUS_MI = 4.0; // Upgraded: 4.0mi planning box allows full day 9-hour trolling circuits around ramp
  const MIN_CLIP_RADIUS_MI = 0.5;
  const clippedRangeMiles = Math.min(MAX_CLIP_RADIUS_MI, Math.max(MIN_CLIP_RADIUS_MI, rangeMiles));
  window._clipRadiusMi = clippedRangeMiles;
  if (clippedRangeMiles !== rangeMiles) {
    console.warn(`[route-builder] clip radius ${rangeMiles.toFixed(1)}mi exceeds cap — using ${clippedRangeMiles}mi instead`);
  }
  // Convert range miles to degrees (approximate)
  const latDeg = clippedRangeMiles / 69.0;
  const lonDeg = clippedRangeMiles / (69.0 * Math.cos(rampLat * Math.PI / 180));
  // Create a rectangular bounding box around the ramp
  clipPolygon = [
    [rampLat - latDeg, rampLon - lonDeg],
    [rampLat + latDeg, rampLon - lonDeg],
    [rampLat + latDeg, rampLon + lonDeg],
    [rampLat - latDeg, rampLon + lonDeg],
    [rampLat - latDeg, rampLon - lonDeg],
  ];
  window._routeBuilderClipActive = true;
  console.log(`[route-builder] clip set: ${clippedRangeMiles.toFixed(1)}mi radius around ramp (${rampLat.toFixed(4)}, ${rampLon.toFixed(4)})`);
}

export function generateAndCommitRoute(overrides = {}) {
  // Read current panel settings as base config — falls back to defaults
  // if panel hasn't been opened yet (inputs don't exist in DOM)

  // Ramp start point — if provided, orient route so it starts nearest the ramp
  const rampLat = overrides.rampLat ?? null;
  const rampLon = overrides.rampLon ?? null;

  const cfg = {
    rampLat:        rampLat,
    rampLon:        rampLon,
    startLat:       overrides.startLat ?? rampLat,
    startLon:       overrides.startLon ?? rampLon,
    endLat:         overrides.endLat ?? null,
    endLon:         overrides.endLon ?? null,
    targetLengthFt: overrides.targetLengthFt ?? null,
    isReturnPass:   overrides.isReturnPass ?? false,
    lockedBearing:  overrides.lockedBearing ?? null,
    depthMin:       overrides.depthMin   != null ? overrides.depthMin   : (parseInt(document.getElementById('rbDepthMin')?.value)    || 18),
    depthMax:   overrides.depthMax   != null ? overrides.depthMax   : (parseInt(document.getElementById('rbDepthMax')?.value)    || 28),
    pattern:    overrides.pattern    != null ? overrides.pattern    : (document.getElementById('rbPattern')?.value               || 'sine+straight'),
    spacing:    overrides.spacing    != null ? overrides.spacing    : (parseFloat(document.getElementById('rbSpacing')?.value)   || 150),
    amplitude:  overrides.amplitude  != null ? overrides.amplitude  : (parseFloat(document.getElementById('rbAmplitude')?.value) || 30),
    lanes:      overrides.lanes      != null ? overrides.lanes      : (parseInt(document.getElementById('rbLanes')?.value)       || 1),
    closeLoop:  false,
    wave:       parseFloat(document.getElementById('rbWave')?.value)      || 350,
    straightFt: parseFloat(document.getElementById('rbStraight')?.value)  || 500,
    ppw:        parseInt(document.getElementById('rbPpw')?.value)          || 16,
    dynamic:    document.getElementById('rbDynamic')?.checked             || false,
    bias:       parseFloat(document.getElementById('rbBias')?.value)      || 0,
    minSpacing:      parseFloat(document.getElementById('rbMinSpacing')?.value)|| 25,
    zoneSpineOffset: overrides.zoneSpineOffset ?? 0,
  };

  // If manual waypoints are provided (e.g. dock spine for Phase 1), use them
  // directly as the spine instead of depth polygon or contour routing.
  let tracks;
  if (overrides.useWaypointSpine && overrides.manualWaypoints?.length >= 2) {
    const spine = overrides.manualWaypoints; // [[lat,lon], ...]
    let pts = clampToClip(patternAlongSpine(spine, {
      pattern:         cfg.pattern,
      amplitude:       cfg.amplitude,
      wave:            cfg.wave,
      straightFt:      cfg.straightFt,
      spacing:         cfg.spacing,
      ppw:             cfg.ppw,
      dynamic:         cfg.dynamic,
      bias:            cfg.bias,
      minSpacing:      cfg.minSpacing,
      zoneSpineOffset: cfg.zoneSpineOffset || 0,
    }));
    if (pts.length < 2) pts = spine; // fallback to raw waypoints if clamp kills it
    if (cfg.targetLengthFt > 0) pts = trimPolylineToLength(pts, cfg.targetLengthFt);
    tracks = pts.length >= 2 ? [{ name: 'dock_spine', pts, depth: (cfg.depthMin + cfg.depthMax) / 2 }] : null;
    console.log(`[route-builder] dock waypoint spine: ${pts.length} pts`);
  }

  // Try depth polygon routing first (uses DEPARE zone boundaries from supplemental-layers)
  // Falls back to contour routing if no polygon data is available for this lake/depth
  if (!tracks) {
    tracks = generateDepthPolygonRoutes(cfg);
  }
  if (!tracks) {
    tracks = generateContourRoutes(cfg);
  }

  if (!tracks || !tracks.length) {
    console.warn(`[route-builder] generateAndCommitRoute: no route found in ${cfg.depthMin}-${cfg.depthMax}ft range`);
    return [];
  }

  // Name each track by phase so it's identifiable in the plan/GPX export
  const prefix = overrides.trackName || `Smart Plan ${cfg.depthMin}-${cfg.depthMax}ft`;

  // Smart Plan should use one coherent fishing pass per phase. If clipping or
  // stitching emitted several fragments, choose the fragment that starts nearest
  // the phase start and, for the return phase, finishes nearest the return ramp.
  if (overrides.singleBestTrack !== false && tracks.length > 1) {
    const sLat = cfg.startLat ?? cfg.rampLat;
    const sLon = cfg.startLon ?? cfg.rampLon;
    const eLat = cfg.endLat;
    const eLon = cfg.endLon;
    tracks.sort((a, b) => {
      const af = a.pts?.[0], al = a.pts?.[a.pts.length - 1];
      const bf = b.pts?.[0], bl = b.pts?.[b.pts.length - 1];
      const aStart = isValidLatLon(sLat, sLon) ? distancePointToRefFt(af, sLat, sLon) : 0;
      const bStart = isValidLatLon(sLat, sLon) ? distancePointToRefFt(bf, sLat, sLon) : 0;
      const aEnd = (cfg.isReturnPass && isValidLatLon(eLat, eLon)) ? distancePointToRefFt(al, eLat, eLon) : 0;
      const bEnd = (cfg.isReturnPass && isValidLatLon(eLat, eLon)) ? distancePointToRefFt(bl, eLat, eLon) : 0;
      return (aStart + aEnd) - (bStart + bEnd);
    });
    tracks = tracks.slice(0, 1);
  }

  tracks = tracks.map((t, i) => ({
    ...t,
    name: tracks.length > 1 ? `${prefix} (${i + 1})` : prefix,
    role: t.role || 'fishing',
    smartPlan: overrides.smartPlan !== false,
    connector: false,
    lengthFt: trackLengthFt(t.pts || []),
  }));

  // Final orientation safety: app route points are [lat,lon]. Reverse a track if
  // its far end is closer to the requested phase start. This used to be swapped.
  const startLat = cfg.startLat ?? rampLat;
  const startLon = cfg.startLon ?? rampLon;
  if (isValidLatLon(startLat, startLon) && !overrides.useWaypointSpine) {
    tracks = tracks.map(track => {
      if (!track.pts || track.pts.length < 2) return track;
      const first = track.pts[0];
      const last  = track.pts[track.pts.length - 1];
      const dFirst = distBearing(startLat, startLon, first[0], first[1])[0];
      const dLast  = distBearing(startLat, startLon, last[0],  last[1])[0];
      if (dLast < dFirst) return { ...track, pts: track.pts.slice().reverse() };
      return track;
    });
    console.log(`[route-builder] oriented ${tracks.length} track(s) toward phase start (${startLat.toFixed(4)}, ${startLon.toFixed(4)})`);
  }

  const commitTracks = [];
  const emitConnectors = overrides.emitConnectors !== false;
  if (emitConnectors && tracks[0]) {
    const startLabel = overrides.startLabel || 'Start';
    addOrSnapConnector(commitTracks, `Connector: ${startLabel} → ${prefix}`, startLat, startLon, tracks[0], 'start_connector');
  }

  for (let i = 0; i < tracks.length; i++) {
    if (i > 0 && emitConnectors) {
      const prev = tracks[i - 1].pts?.[tracks[i - 1].pts.length - 1];
      const next = tracks[i].pts?.[0];
      if (prev && next) {
        const c = buildConnectorTrack(`Connector: ${tracks[i - 1].name} → ${tracks[i].name}`, prev[0], prev[1], next[0], next[1], 'phase_gap_connector');
        if (c) commitTracks.push(c);
      }
    }
    tracks[i].lengthFt = trackLengthFt(tracks[i].pts || []);
    commitTracks.push(tracks[i]);
  }

  if (emitConnectors && cfg.endLat != null && cfg.endLon != null && commitTracks.length) {
    const lastTrack = commitTracks[commitTracks.length - 1];
    const lastPt = lastTrack.pts?.[lastTrack.pts.length - 1];
    const endLabel = overrides.endLabel || 'Return';
    if (lastPt) {
      const [d] = distBearing(lastPt[0], lastPt[1], cfg.endLat, cfg.endLon);
      if (d <= 25) {
        lastTrack.pts[lastTrack.pts.length - 1] = [cfg.endLat, cfg.endLon];
      } else {
        const c = buildConnectorTrack(`Connector: ${prefix} → ${endLabel}`, lastPt[0], lastPt[1], cfg.endLat, cfg.endLon, 'return_connector');
        if (c) commitTracks.push(c);
      }
    }
  }

  if (!state.DATA.tracks) state.DATA.tracks = [];
  state.DATA.tracks.push(...commitTracks);
  renderAll();

  const fishingFt = tracks.reduce((sum, t) => sum + (t.lengthFt || trackLengthFt(t.pts || [])), 0);
  const connectorFt = commitTracks.filter(t => t.connector).reduce((sum, t) => sum + (t.lengthFt || trackLengthFt(t.pts || [])), 0);
  window._lastRouteBuildAudit = { prefix, trackCount: commitTracks.length, fishingFt, connectorFt, startLat, startLon, endLat: cfg.endLat, endLon: cfg.endLon };
  console.log(`[route-builder] auto-committed ${commitTracks.length} track(s): ${prefix} · fishing=${Math.round(fishingFt)}ft connector=${Math.round(connectorFt)}ft`);
  return commitTracks;
}

export function buildRouteBuilderPanel(container) {
  container.innerHTML = `
    <!-- Path source -->
    <div style="margin-bottom:12px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Path source</div>
      <div style="display:flex;gap:6px">
        <label style="flex:1;display:flex;align-items:center;gap:5px;padding:6px 8px;border:1px solid var(--accent);border-radius:6px;background:rgba(0,229,255,.08);cursor:pointer">
          <input type="radio" name="rbSrc" value="contour" id="rbSrcContour" checked style="accent-color:var(--accent)">
          <span style="font-size:11px;color:var(--accent);font-weight:600">Contour</span>
        </label>
        <label style="flex:1;display:flex;align-items:center;gap:5px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;cursor:pointer">
          <input type="radio" name="rbSrc" value="manual" id="rbSrcManual" style="accent-color:var(--accent)">
          <span style="font-size:11px;color:var(--text)">Waypoints</span>
        </label>
      </div>
    </div>

    <!-- Active contour info -->
    <div id="rbContourInfo" style="margin-bottom:10px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:8px 10px;font-size:11px">
      <div id="rbContourInfoText" style="color:var(--muted)">Loading contour data...</div>
    </div>

    <!-- Contour mode: sub-mode toggle + depth range -->
    <div id="rbDepthSection" style="margin-bottom:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">Contour mode</div>
      <div style="display:flex;gap:6px;margin-bottom:8px">
        <label style="flex:1;display:flex;align-items:center;gap:5px;padding:5px 8px;border:1px solid var(--accent);border-radius:6px;background:rgba(0,229,255,.08);cursor:pointer" id="rbSweepLabel">
          <input type="radio" name="rbContourMode" value="sweep" id="rbModeSweep" checked style="accent-color:var(--accent)">
          <span style="font-size:11px;color:var(--accent);font-weight:600">↔ Sweep band</span>
        </label>
        <label style="flex:1;display:flex;align-items:center;gap:5px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;cursor:pointer" id="rbFollowLabel">
          <input type="radio" name="rbContourMode" value="follow" id="rbModeFollow" style="accent-color:var(--accent)">
          <span style="font-size:11px;color:var(--text)">〰 Follow line</span>
        </label>
      </div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:5px" id="rbDepthLabel">Depth band (ft) — route runs along band, sine oscillates across it</div>
      <div style="display:flex;align-items:center;gap:6px">
        <input id="rbDepthMin" type="number" value="18" min="0" max="200" style="width:55px;padding:4px 6px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:12px;text-align:center">
        <span style="color:var(--muted);font-size:11px">to</span>
        <input id="rbDepthMax" type="number" value="28" min="0" max="200" style="width:55px;padding:4px 6px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:12px;text-align:center">
        <span style="color:var(--muted);font-size:11px">ft</span>
      </div>
      <!-- Sweep lanes (lawnmower passes) — only meaningful in sweep mode -->
      <div id="rbLanesRow" style="display:flex;align-items:center;gap:6px;margin-top:8px">
        <span style="color:var(--muted);font-size:11px">Passes</span>
        <input id="rbLanes" type="number" value="1" min="1" max="12" style="width:50px;padding:4px 6px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:12px;text-align:center">
        <span style="color:var(--muted);font-size:10px;flex:1">parallel passes across the band (lawnmower)</span>
      </div>
    </div>

    <!-- Manual/waypoint mode -->
    <div id="rbManualSection" style="margin-bottom:10px;display:none">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">Waypoints</div>
      <div style="display:flex;gap:5px;margin-bottom:6px">
        <button id="rbAddWpt" style="flex:1;height:28px;font-size:11px;border:1px solid var(--accent);background:rgba(0,229,255,.08);color:var(--accent);border-radius:5px;cursor:pointer;font-weight:600">📍 Add waypoint</button>
        <button id="rbClearWpts" style="height:28px;padding:0 10px;font-size:11px;border:1px solid var(--bad);background:transparent;color:var(--bad);border-radius:5px;cursor:pointer">Clear all</button>
      </div>
      <!-- Add from existing saved waypoints -->
      <div style="display:flex;gap:5px;margin-bottom:6px">
        <select id="rbSavedWptSelect" style="flex:1;min-width:0;height:28px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;padding:0 6px">
          <option value="">— saved waypoints —</option>
        </select>
        <button id="rbAddSavedWpt" style="height:28px;padding:0 10px;font-size:11px;border:1px solid var(--accent);background:rgba(0,229,255,.08);color:var(--accent);border-radius:5px;cursor:pointer;font-weight:600">➕ Add</button>
        <button id="rbAddAllSaved" title="Add all saved waypoints in order" style="height:28px;padding:0 8px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;cursor:pointer">All</button>
      </div>
      <div id="rbWptList" style="max-height:120px;overflow-y:auto;background:var(--panel2);border:1px solid var(--line);border-radius:5px;padding:4px 6px;margin-bottom:6px">
        <div style="color:var(--muted);font-size:10px;text-align:center;padding:4px">No waypoints — click Add waypoint then click the map</div>
      </div>
      <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text);margin-bottom:4px">
        <input type="checkbox" id="rbCloseLoop" style="accent-color:var(--accent)">
        Close loop (return to first waypoint)
      </label>
    </div>

    <!-- Pattern -->
    <div style="margin-bottom:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">Pattern</div>
      <select id="rbPattern" style="width:100%;padding:5px 7px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:12px;margin-bottom:8px">
        <option value="sine+straight">Sine + straight (recommended)</option>
        <option value="sine">Sine S-curves only</option>
        <option value="straight">Straight</option>
        <option value="zigzag">Zigzag</option>
        <option value="zigzag+straight">Zigzag + straight</option>
      </select>
      <div style="display:flex;gap:8px">
        <div style="flex:1">
          <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Spacing (ft)</div>
          <input id="rbSpacing" type="number" value="150" min="50" max="500" style="width:100%;padding:4px 6px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:12px;box-sizing:border-box">
        </div>
        <div style="flex:1">
          <div style="font-size:10px;color:var(--muted);margin-bottom:3px" title="Sweep mode: 30 = fill the band edge-to-edge. Lower = stay nearer centre, higher = overshoot. Follow mode: literal feet of swing.">Amplitude (ft) <span style="opacity:.6">ⓘ</span></div>
          <input id="rbAmplitude" type="number" value="30" min="5" max="200" style="width:100%;padding:4px 6px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:12px;box-sizing:border-box">
        </div>
      </div>
      <!-- Wave cycle + straight stretch (ported from original generator) -->
      <div style="display:flex;gap:8px;margin-top:8px">
        <div style="flex:1">
          <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Weave cycle</div>
          <select id="rbWave" style="width:100%;padding:4px 6px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:12px;box-sizing:border-box">
            <option value="200">Tight — every 200 ft</option>
            <option value="350" selected>Normal — every 350 ft</option>
            <option value="528">Loose — every 528 ft</option>
            <option value="800">Very loose — 800 ft</option>
          </select>
        </div>
        <div style="flex:1" id="rbStraightWrap">
          <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Straight stretch</div>
          <select id="rbStraight" style="width:100%;padding:4px 6px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:12px;box-sizing:border-box">
            <option value="200">200 ft</option>
            <option value="350">350 ft</option>
            <option value="500" selected>500 ft</option>
          </select>
        </div>
      </div>
      <!-- Advanced curve quality (collapsible) -->
      <details style="margin-top:8px">
        <summary style="font-size:10px;color:var(--muted);cursor:pointer;user-select:none">Advanced curve quality</summary>
        <div style="margin-top:6px;display:flex;flex-direction:column;gap:6px">
          <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text)">
            <input type="checkbox" id="rbDynamic" style="accent-color:var(--accent)">
            Dynamic weave (wider in middle of each leg)
          </label>
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:11px;color:var(--muted);flex:1">Lean toward deep side</span>
            <select id="rbBias" style="padding:3px 6px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:11px">
              <option value="0" selected>None</option>
              <option value="0.1">Slight 10%</option>
              <option value="0.2">Medium 20%</option>
              <option value="0.35">Strong 35%</option>
            </select>
          </div>
          <div style="display:flex;gap:8px">
            <div style="flex:1">
              <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Detail (pts/weave)</div>
              <input id="rbPpw" type="number" value="16" min="6" max="40" style="width:100%;padding:4px 6px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:12px;box-sizing:border-box">
            </div>
            <div style="flex:1">
              <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Min spacing (ft)</div>
              <input id="rbMinSpacing" type="number" value="25" min="1" style="width:100%;padding:4px 6px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:12px;box-sizing:border-box">
            </div>
          </div>
        </div>
      </details>
    </div>

    <!-- Area filter -->
    <div style="margin-bottom:12px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">Area filter (optional)</div>
      <div style="display:flex;gap:6px">
        <button id="rbDrawClip" style="flex:1;height:28px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;cursor:pointer">✏️ Draw area</button>
        <button id="rbClearClip" style="height:28px;padding:0 10px;font-size:11px;border:1px solid var(--bad);background:transparent;color:var(--bad);border-radius:5px;cursor:pointer">✕</button>
      </div>
      <div id="rbClipStatus" style="font-size:10px;color:var(--muted);margin-top:3px"></div>
    </div>

    <!-- Generate / Commit / Reverse / Clear -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:5px;padding-top:8px;border-top:1px solid var(--line)">
      <button id="rbGenerate" style="height:32px;font-size:11px;font-weight:700;border:1px solid var(--line);border-radius:5px;background:var(--panel2);color:var(--text);cursor:pointer">⚡ Generate</button>
      <button id="rbCommit" style="height:32px;font-size:11px;font-weight:700;border:1px solid var(--line);border-radius:5px;background:var(--panel2);color:var(--text);cursor:pointer;display:none">✅ Commit</button>
      <button id="rbReverse" style="height:32px;font-size:11px;border:1px solid var(--line);border-radius:5px;background:var(--panel2);color:var(--muted);cursor:pointer;display:none">🔄 Reverse</button>
      <button id="rbClear" style="height:32px;width:32px;font-size:12px;border:1px solid var(--line);background:var(--panel2);color:var(--muted);border-radius:5px;cursor:pointer">✕</button>
    </div>
    <div id="rbStatus" style="margin-top:6px;font-size:11px;color:var(--muted)"></div>

    <!-- Pinch points -->
    <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)">
      <button id="rbPinch" style="width:100%;height:28px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;cursor:pointer">🎯 Find Pinch Points</button>
    </div>
  `;

  wireRouteBuilder();
  updateContourInfo();
  onContourChange(updateContourInfo);
  // Apply any Smart Plan depth recommendation that was set before this
  // panel was opened (the panel is lazy-loaded on first open, so the
  // inputs didn't exist when Smart Plan ran).
  if (typeof window.applyStoredSmartPlanDepth === 'function') {
    window.applyStoredSmartPlanDepth();
  }
}

function readCfg() {
  const num = (id, def) => {
    const v = parseFloat(document.getElementById(id)?.value);
    return Number.isFinite(v) ? v : def;
  };
  return {
    depthMin:   parseInt(document.getElementById('rbDepthMin')?.value)   || 18,
    depthMax:   parseInt(document.getElementById('rbDepthMax')?.value)   || 28,
    pattern:    document.getElementById('rbPattern')?.value || 'sine+straight',
    spacing:    num('rbSpacing', 150),
    amplitude:  num('rbAmplitude', 30),
    lanes:      parseInt(document.getElementById('rbLanes')?.value)        || 1,
    closeLoop:  document.getElementById('rbCloseLoop')?.checked || false,
    // Wave cycle + straight-stretch defaults from the original generator.
    wave:       num('rbWave', 350),
    straightFt: num('rbStraight', 500),
    // Advanced curve-quality knobs (ported from the original that worked).
    ppw:        parseInt(document.getElementById('rbPpw')?.value) || 16,
    dynamic:    document.getElementById('rbDynamic')?.checked || false,
    bias:       num('rbBias', 0),
    minSpacing: num('rbMinSpacing', 25),
  };
}

function setStatus(msg, color) {
  const el = document.getElementById('rbStatus');
  if (el) { el.textContent = msg; el.style.color = color || 'var(--muted)'; }
}

function updateContourInfo() {
  const el = document.getElementById('rbContourInfoText');
  if (!el) return;
  const c = getActiveContour();
  const lakes = state.ACTIVE_CONTOUR_LAKES;
  const count = (c?.smart?.features?.length || c?.raw?.features?.length || 0);
  if (!count) {
    el.style.color = 'var(--muted)';
    el.textContent = 'No contour data loaded yet — check Contour Data tab';
    return;
  }
  el.style.color = 'var(--accent)';
  if (Array.isArray(lakes) && lakes.length) {
    const lakeNames = lakes.map(l => l.replace(/^lake_/, '').replace(/_/g, ' ')).join(', ');
    el.innerHTML = `<span style="font-weight:600">${esc(lakeNames)}</span><br><span style="color:var(--muted)">${esc(count.toLocaleString())} features</span>`;
  } else {
    el.innerHTML = `<span style="font-weight:600">${esc(state.ACTIVE_CONTOUR_KEY || 'Loaded data')}</span><br><span style="color:var(--muted)">${esc(count.toLocaleString())} features</span>`;
  }
}


function wireRouteBuilder() {
  // Source toggle
  document.querySelectorAll('input[name="rbSrc"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const isContour = document.getElementById('rbSrcContour')?.checked;
      document.getElementById('rbContourInfo').style.display  = isContour ? 'block' : 'none';
      document.getElementById('rbDepthSection').style.display = isContour ? 'block' : 'none';
      document.getElementById('rbManualSection').style.display = isContour ? 'none' : 'block';
      if (!isContour) refreshSavedWptDropdown();
    });
  });

  // Contour sub-mode toggle: update depth label hint
  document.querySelectorAll('input[name="rbContourMode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const isFollow = document.getElementById('rbModeFollow')?.checked;
      const lbl = document.getElementById('rbDepthLabel');
      const toLbl = document.getElementById('rbDepthToLabel');
      if (lbl) lbl.textContent = isFollow
        ? 'Target depth (ft) — narrow band recommended (e.g. 28–30)'
        : 'Depth band (ft) — sweep generates lanes across this range';
      // Lanes/passes only apply to sweep mode
      const lanesRow = document.getElementById('rbLanesRow');
      if (lanesRow) lanesRow.style.display = isFollow ? 'none' : 'flex';
      // Style the border of the active sub-mode label
      document.querySelectorAll('input[name="rbContourMode"]').forEach(r => {
        const lel = r.closest('label');
        if (!lel) return;
        const active = r.checked;
        lel.style.border = active ? '1px solid var(--accent)' : '1px solid var(--line)';
        lel.style.background = active ? 'rgba(0,229,255,.08)' : '';
        r.nextElementSibling.style.color = active ? 'var(--accent)' : 'var(--text)';
      });
    });
  });

  // Waypoint manual mode
  document.getElementById('rbAddWpt')?.addEventListener('click', () => {
    window._rbPickMode = 'waypoint';
    setBanner('📍 Click map to add waypoint — click Add again when done');
  });

  document.getElementById('rbClearWpts')?.addEventListener('click', () => {
    manualWaypoints = [];
    renderWaypointMarkers();
    window._rbPickMode = null;
    setBanner('');
  });

  // Populate the saved-waypoints dropdown from state.DATA (auto-detected field)
  const refreshSavedWptDropdown = () => {
    const sel = document.getElementById('rbSavedWptSelect');
    if (!sel) return;
    const saved = getSavedWaypoints();
    if (!saved.length) {
      sel.innerHTML = '<option value="">— no saved waypoints —</option>';
      sel.disabled = true;
      const addBtn = document.getElementById('rbAddSavedWpt');
      const allBtn = document.getElementById('rbAddAllSaved');
      if (addBtn) addBtn.disabled = true;
      if (allBtn) allBtn.disabled = true;
      return;
    }
    sel.disabled = false;
    document.getElementById('rbAddSavedWpt') && (document.getElementById('rbAddSavedWpt').disabled = false);
    document.getElementById('rbAddAllSaved') && (document.getElementById('rbAddAllSaved').disabled = false);
    sel.innerHTML = '<option value="">— saved waypoints —</option>' + saved.map((w, i) => {
      const label = w.name ? esc(w.name) : `${w.lat.toFixed(4)}, ${w.lon.toFixed(4)}`;
      return `<option value="${i}">${label}</option>`;
    }).join('');
    window._rbSavedWptCache = saved;
  };

  // Refresh dropdown whenever the user switches to Waypoints source
  document.getElementById('rbSrcManual')?.addEventListener('change', refreshSavedWptDropdown);
  refreshSavedWptDropdown();

  document.getElementById('rbAddSavedWpt')?.addEventListener('click', () => {
    const sel = document.getElementById('rbSavedWptSelect');
    const idx = parseInt(sel?.value);
    const saved = window._rbSavedWptCache || getSavedWaypoints();
    if (Number.isNaN(idx) || !saved[idx]) {
      setStatus('Pick a saved waypoint from the list first.', 'var(--muted)');
      return;
    }
    const w = saved[idx];
    manualWaypoints.push([w.lat, w.lon]);
    renderWaypointMarkers();
    setStatus(`Added "${w.name || 'waypoint'}" to route sequence.`, 'var(--accent2)');
  });

  document.getElementById('rbAddAllSaved')?.addEventListener('click', () => {
    const saved = window._rbSavedWptCache || getSavedWaypoints();
    if (!saved.length) return;
    saved.forEach(w => manualWaypoints.push([w.lat, w.lon]));
    renderWaypointMarkers();
    setStatus(`Added all ${saved.length} saved waypoints to route sequence.`, 'var(--accent2)');
  });

  window._rbRemoveWpt = (idx) => {
    manualWaypoints.splice(idx, 1);
    renderWaypointMarkers();
  };

  // Re-draw preview when close-loop toggles
  document.getElementById('rbCloseLoop')?.addEventListener('change', renderWaypointMarkers);

  // Single map click handler for all pick modes
  const handleMapClick = (e) => {
    if (!window._rbPickMode) return;
    const { lat, lng } = e.latlng;
    if (window._rbPickMode === 'waypoint') {
      manualWaypoints.push([lat, lng]);
      renderWaypointMarkers();
      // Stay in waypoint mode so user can keep clicking
    } else if (window._rbPickMode === 'clip') {
      // handled by L.Draw
    }
  };

  if (state.MAP) {
    state.MAP.on('click', handleMapClick);
  } else {
    setTimeout(() => state.MAP?.on('click', handleMapClick), 2000);
  }

  // Clip drawing
  document.getElementById('rbDrawClip')?.addEventListener('click', () => {
    if (!window.L?.Draw) { alert('Draw plugin not available'); return; }
    setBanner('Draw a polygon to filter the route area. Double-click to finish.');
    const drawer = new L.Draw.Polygon(state.MAP, { shapeOptions: { color: '#76ff03', weight: 2 } });
    drawer.enable();
    state.MAP.once(L.Draw.Event.CREATED, (e) => {
      if (clipLayer) state.MAP.removeLayer(clipLayer);
      clipLayer = e.layer.addTo(state.MAP);
      clipPolygon = e.layer.getLatLngs()[0].map(ll => [ll.lat, ll.lng]);
      window._routeBuilderClipActive = true;
      const el = document.getElementById('rbClipStatus');
      if (el) el.textContent = `Area set (${clipPolygon.length} points)`;
      setBanner('');
    });
  });

  document.getElementById('rbClearClip')?.addEventListener('click', () => {
    if (clipLayer) { state.MAP?.removeLayer(clipLayer); clipLayer = null; }
    clipPolygon = null;
    window._routeBuilderClipActive = false;
    const el = document.getElementById('rbClipStatus');
    if (el) el.textContent = '';
  });

  // Generate
  document.getElementById('rbGenerate')?.addEventListener('click', () => {
    const cfg = readCfg();
    const isContour = document.getElementById('rbSrcContour')?.checked;
    const isFollow  = document.getElementById('rbModeFollow')?.checked;
    let tracks = [];

    if (isContour) {
      tracks = isFollow ? generateFollowRoutes(cfg) : generateContourRoutes(cfg);
      if (!tracks.length) {
        setStatus('No contours found in depth range. Try adjusting range or loading a dataset.', 'var(--bad)');
        return;
      }
    } else {
      if (manualWaypoints.length < 2) {
        setStatus('Add at least 2 waypoints on the map first.', 'var(--bad)');
        return;
      }
      tracks = generateWaypointRoute(cfg);
    }

    pendingTracks = tracks;
    renderRoutes(tracks);
    let msg = `Generated ${tracks.length} route(s). Commit to add to plan.`;
    // Nudge toward the area box when follow mode emits a lot of routes whole-lake.
    if (isContour && isFollow && tracks.length >= 5 && !clipPolygon) {
      msg += ' Tip: Draw area to focus on one spot.';
    }
    setStatus(msg, 'var(--accent2)');
    document.getElementById('rbCommit').style.display = '';
    document.getElementById('rbReverse').style.display = '';
  });

  // Commit — guard against double-clicks creating duplicate tracks.
  // Disable immediately on click rather than waiting for pendingTracks to
  // clear, since a fast double-click can fire both handlers before the
  // first one finishes hiding the button.
  document.getElementById('rbCommit')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    if (btn.disabled || !pendingTracks.length) return;
    btn.disabled = true;
    state.DATA.tracks.push(...pendingTracks);
    pendingTracks = [];
    renderAll();
    btn.style.display = 'none';
    btn.disabled = false; // reset for next generate/commit cycle
    setStatus(`✅ ${state.DATA.tracks.length} track(s) in plan.`, 'var(--accent2)');
  });

  // Clear
  document.getElementById('rbClear')?.addEventListener('click', () => {
    if (routeLayer) { state.MAP?.removeLayer(routeLayer); routeLayer = null; }
    pendingTracks = [];
    document.getElementById('rbCommit').style.display = 'none';
    document.getElementById('rbReverse').style.display = 'none';
    setStatus('');
  });

  // Reverse — flip direction of all pending tracks and re-render
  document.getElementById('rbReverse')?.addEventListener('click', () => {
    if (!pendingTracks.length) return;
    pendingTracks = pendingTracks.map(t => ({ ...t, pts: [...t.pts].reverse() }));
    renderRoutes(pendingTracks);
    setStatus('Route reversed. Commit to add to plan.', 'var(--accent2)');
  });

  // Pinch points
  document.getElementById('rbPinch')?.addEventListener('click', () => {
    // Trigger pinch finder — it reads from window._smartRouteGeoJSON
    const ppPanel = document.getElementById('pinchPanel');
    if (ppPanel) {
      ppPanel.style.display = ppPanel.style.display === 'none' ? 'block' : 'none';
    } else {
      // Fall back to clicking the old button if it exists
      document.getElementById('btnPinchFinder')?.click();
    }
  });

  // Expose for waypoint popup — appends to waypoint list and switches to manual mode
  window.sendWptToRouteBuilder = (lat, lon, role) => {
    manualWaypoints.push([lat, lon]);
    renderWaypointMarkers();
    const manual = document.getElementById('rbSrcManual');
    if (manual) { manual.checked = true; manual.dispatchEvent(new Event('change')); }
  };

  // Legacy compatibility
  window.sendWptToGenerator = window.sendWptToRouteBuilder;
}

console.log('[route-builder] module ready');