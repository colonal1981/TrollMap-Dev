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

// ── Math & Geo Helpers ────────────────────────────────────────────────────────

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

function isValidLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function pointInGeoJSONRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
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

// ── Topographical Environment Readers (The "Eyes" of the Algorithm) ───────────

function isWater(lat, lon) {
  const boundary = window.LAKE_BOUNDARY_GEOJSON;
  if (!boundary?.features?.length) return true; // Assume water if no land mask loaded
  
  for (const f of boundary.features) {
    if (f.geometry?.type === 'Polygon') {
      if (pointInGeoJSONRing(lat, lon, f.geometry.coordinates[0])) return true;
    } else if (f.geometry?.type === 'MultiPolygon') {
      for (const poly of f.geometry.coordinates) {
        if (pointInGeoJSONRing(lat, lon, poly[0])) return true;
      }
    }
  }
  return false; // Point hit land
}

function getDepthAt(lat, lon) {
  const gj = getDepthAreaGeoJSON() || window.SUPPLEMENTAL_DEPTH_GEOJSON;
  if (!gj?.features?.length) return null;
  
  for (const f of gj.features) {
    let isInside = false;
    if (f.geometry?.type === 'Polygon') {
      isInside = pointInGeoJSONRing(lat, lon, f.geometry.coordinates[0]);
    } else if (f.geometry?.type === 'MultiPolygon') {
      isInside = f.geometry.coordinates.some(poly => pointInGeoJSONRing(lat, lon, poly[0]));
    }
    
    if (isInside) {
      return ((f.properties?.depth_min_ft || 0) + (f.properties?.depth_max_ft || 0)) / 2;
    }
  }
  return null;
}

// ── Autonomous Steering Algorithm (The AI Guide) ──────────────────────────────

function generateAutonomousRoute(cfg) {
  const sLat = cfg.startLat ?? cfg.rampLat;
  const sLon = cfg.startLon ?? cfg.rampLon;
  if (!isValidLatLon(sLat, sLon)) return [];

  const eLat = cfg.endLat;
  const eLon = cfg.endLon;
  const returning = cfg.isReturnPass && isValidLatLon(eLat, eLon);
  const targetLen = cfg.targetLengthFt || 15000;
  
  const STEP_FT = 150;
  const depthMin = cfg.depthMin || 10;
  const depthMax = cfg.depthMax || 30;
  const targetMid = (depthMin + depthMax) / 2;

  let heading = cfg.lockedBearing;
  
  if (returning) {
    heading = distBearing(sLat, sLon, eLat, eLon)[1];
  } else if (heading == null) {
    let bestH = 0, bestS = -Infinity;
    for (let h = 0; h < 360; h += 45) {
      const pt = destination(sLat, sLon, h, 400);
      let s = 0;
      if (!isWater(pt[0], pt[1])) s -= 10000;
      const d = getDepthAt(pt[0], pt[1]);
      if (d != null) s += (1000 - Math.abs(d - targetMid) * 50);
      if (s > bestS) { bestS = s; bestH = h; }
    }
    heading = bestH;
  }

  const spine = [[sLat, sLon]];
  let curLat = sLat, curLon = sLon;
  let totalDist = 0;
  let stuckCount = 0;

  while (totalDist < targetLen) {
    let bestCand = null;
    let bestScore = -Infinity;

    const curDistToEnd = returning ? distBearing(curLat, curLon, eLat, eLon)[0] : 0;
    if (returning && curDistToEnd < STEP_FT * 1.5) {
      spine.push([eLat, eLon]);
      break; 
    }

    const angles = [0, -20, 20, -40, 40, -60, 60, -90, 90];
    for (const ang of angles) {
      const testH = (heading + ang + 360) % 360;
      const pt = destination(curLat, curLon, testH, STEP_FT);
      
      if (!isWater(pt[0], pt[1])) continue;
      if (clipPolygon && !pointInPolygon([pt[0], pt[1]], clipPolygon)) continue;

      let score = 0;
      
      const d = getDepthAt(pt[0], pt[1]);
      if (d != null) {
        if (d >= depthMin && d <= depthMax) score += 1000;
        else score += (1000 - Math.abs(d - targetMid) * 50);
      } else {
        score -= 500; 
      }

      if (returning) {
        const newDist = distBearing(pt[0], pt[1], eLat, eLon)[0];
        score += (curDistToEnd - newDist) * 3; 
      } else {
        const startDist = distBearing(pt[0], pt[1], sLat, sLon)[0];
        score += startDist * 0.5; 
      }

      score -= Math.abs(ang) * 3;

      let overlap = false;
      for (let i = 0; i < Math.max(0, spine.length - 4); i++) {
        if (distBearing(pt[0], pt[1], spine[i][0], spine[i][1])[0] < 200) { overlap = true; break; }
      }
      if (!overlap && state.DATA?.tracks) {
        for (const trk of state.DATA.tracks) {
          if (!trk.pts) continue;
          const tStep = Math.max(1, Math.floor(trk.pts.length / 10));
          for (let j = 0; j < trk.pts.length; j += tStep) {
            if (distBearing(pt[0], pt[1], trk.pts[j][0], trk.pts[j][1])[0] < 200) { overlap = true; break; }
          }
          if (overlap) break;
        }
      }
      if (overlap) score -= 10000; 

      if (score > bestScore) {
        bestScore = score;
        bestCand = { pt, h: testH };
      }
    }

    if (!bestCand) {
      stuckCount++;
      if (stuckCount > 3) break; 
      heading = (heading + 180) % 360; 
      continue;
    }

    stuckCount = 0;
    spine.push(bestCand.pt);
    curLat = bestCand.pt[0];
    curLon = bestCand.pt[1];
    heading = bestCand.h;
    totalDist += STEP_FT;
  }

  if (spine.length < 3) return [];

  let pts = patternAlongSpine(spine, cfg);
  pts = pts.filter(p => isWater(p[0], p[1]));

  const prefix = cfg.trackName || `Sweep_${depthMin}-${depthMax}ft`;
  return [{
    name: prefix,
    pts: pts,
    depth: targetMid
  }];
}

// ── Pattern generators ────────────────────────────────────────────────────────

function genStraight(p1, p2, cfg) {
  const [dist, brng] = distBearing(p1[0], p1[1], p2[0], p2[1]);
  const n = Math.max(2, Math.ceil(dist / Math.max(50, cfg.spacing || 150)));
  return Array.from({length: n+1}, (_, i) => destination(p1[0], p1[1], brng, dist*i/n));
}

function genSine(p1, p2, cfg) {
  const MIN_TURN_RADIUS_FT = 35;
  if (cfg.amplitude > 0 && cfg.wave > 0) {
    const minWave = Math.PI * Math.sqrt(cfg.amplitude * MIN_TURN_RADIUS_FT);
    if (cfg.wave < minWave) cfg = { ...cfg, wave: Math.ceil(minWave) };
  }
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
    if (cfg.dynamic) amp *= 0.65 + 0.35 * Math.sin(Math.PI * t);
    let offset = Math.sin((2 * Math.PI * dist * t) / wave) * amp;
    if (cfg.bias > 0 && offset > 0) offset *= (1 + cfg.bias);
    const f = destination(c[0], c[1], perp, offset);
    if (prev && minSpacing > 0) {
      const [d] = distBearing(prev[0], prev[1], f[0], f[1]);
      if (d < minSpacing) continue;
    }
    pts.push(f);
    prev = f;
  }
  return pts;
}

function genZigzag(p1, p2, cfg) {
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
    if (cfg.bias > 0 && dir > 0) amp *= (1 + cfg.bias);
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
  if (dist < straightFt + wave) straightFt = Math.min(straightFt, dist * 0.4);
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
    case 'sine':            return genSine(p1, p2, cfg);
    case 'zigzag':          return genZigzag(p1, p2, cfg);
    case 'sine+straight':   return genMixed(p1, p2, cfg, genSine);
    case 'zigzag+straight': return genMixed(p1, p2, cfg, genZigzag);
    default:                return genStraight(p1, p2, cfg);
  }
}

function patternAlongSpine(waypoints, cfg) {
  const out = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const p1 = waypoints[i], p2 = waypoints[i + 1];
    const [segDist] = distBearing(p1[0], p1[1], p2[0], p2[1]);
    if (segDist < 20) continue;
    const pts = applyPattern(p1, p2, cfg);
    if (!out.length) out.push(...pts);
    else out.push(...pts.slice(1));
  }
  return out;
}

// ── Legacy Geometry & Contour Utils (Kept for manual UI) ──────────────────────

function contourArcLength(coords) {
  let len = 0;
  for (let i = 1; i < coords.length; i++) {
    const [d] = distBearing(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0]);
    len += d;
  }
  return len;
}

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

function clampToClip(pts) {
  if (!clipPolygon || !pts.length) return pts;
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

function nearestContourDistFt([lat, lon], others) {
  let best = Infinity;
  for (const o of others) {
    const cs = o.coords;
    const step = Math.max(1, Math.floor(cs.length / 24));
    for (let i = 0; i < cs.length; i += step) {
      const [d] = distBearing(lat, lon, cs[i][1], cs[i][0]);
      if (d < best) best = d;
    }
  }
  return best;
}

function isContourStub(coords) {
  if (coords.length <= 3) {
    const [d] = distBearing(coords[0][1], coords[0][0], coords[coords.length-1][1], coords[coords.length-1][0]);
    if (d < 30) return true;
  }
  return false;
}

function angleDiff(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function endBearing(coordsLL, atTail) {
  if (coordsLL.length < 2) return 0;
  if (atTail) {
    const b = coordsLL[coordsLL.length - 1];
    let a = coordsLL[coordsLL.length - 2];
    for (let i = coordsLL.length - 2; i >= 0; i--) {
      if (distBearing(coordsLL[i][0], coordsLL[i][1], b[0], b[1])[0] > 25) {
        a = coordsLL[i]; break;
      }
    }
    return distBearing(a[0], a[1], b[0], b[1])[1];
  } else {
    const b = coordsLL[0];
    let a = coordsLL[1];
    for (let i = 1; i < coordsLL.length; i++) {
      if (distBearing(coordsLL[i][0], coordsLL[i][1], b[0], b[1])[0] > 25) {
        a = coordsLL[i]; break;
      }
    }
    return distBearing(a[0], a[1], b[0], b[1])[1];
  }
}

function stitchFragments(fragments, TOL = 50, MAX_TURN = 45) {
  const segs = fragments
    .filter(c => c.length >= 2 && !isContourStub(c))
    .map(c => c.map(([lo, la]) => [la, lo]));      
  const used = new Array(segs.length).fill(false);
  const chains = [];

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
        
        const cHeadBrng = endBearing(c, false);
        const cTailBrng = endBearing(c, true);

        const turnTA = angleDiff(tailBrng, (cHeadBrng + 180) % 360);
        const turnTB = angleDiff(tailBrng, (cTailBrng + 180) % 360);
        const turnHA = angleDiff(headBrng, (cHeadBrng + 180) % 360);
        const turnHB = angleDiff(headBrng, (cTailBrng + 180) % 360);

        const cands = [
          { d: distBearing(tail[0], tail[1], a[0], a[1])[0], op: 'TA', turn: turnTA },
          { d: distBearing(tail[0], tail[1], b[0], b[1])[0], op: 'TB', turn: turnTB },
          { d: distBearing(head[0], head[1], a[0], a[1])[0], op: 'HA', turn: turnHA },
          { d: distBearing(head[0], head[1], b[0], b[1])[0], op: 'HB', turn: turnHB },
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
    chains.push(chain.map(([la, lo]) => [lo, la]));
  }
  return chains;
}

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
  spines.sort((a, b) => b.len - a.len);
  return spines;
}

function closestPointOnSpineFt(refLat, refLon, coords) {
  if (!coords?.length) return Infinity;
  const step = Math.max(1, Math.floor(coords.length / 60));
  let best = Infinity;
  for (let i = 0; i < coords.length; i += step) {
    const [d] = distBearing(refLat, refLon, coords[i][1], coords[i][0]);
    if (d < best) best = d;
  }
  const [dLast] = distBearing(refLat, refLon, coords[coords.length-1][1], coords[coords.length-1][0]);
  return Math.min(best, dLast);
}

function ftBetweenLonLat([lon1, lat1], [lon2, lat2]) {
  const R = 20902231, D = Math.PI / 180;
  const dlat = (lat2 - lat1) * D, dlon = (lon2 - lon1) * D;
  const a = Math.sin(dlat/2)**2 + Math.cos(lat1*D)*Math.cos(lat2*D)*Math.sin(dlon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

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

function getDepthPolygonEdges(depthMinFt, depthMaxFt) {
  const gj = getDepthAreaGeoJSON() || window.SUPPLEMENTAL_DEPTH_GEOJSON || globalThis.SUPPLEMENTAL_DEPTH_GEOJSON;
  if (!gj?.features?.length) return [];
  const bandSet = new Set();
  for (const f of gj.features) {
    const p = f.properties || {};
    const mn = p.depth_min_ft, mx = p.depth_max_ft;
    if (mn != null && mx != null) bandSet.add(`${mn}|${mx}`);
  }
  const allBands = [...bandSet].map(s => {
    const [mn, mx] = s.split('|').map(Number);
    return { min: mn, max: mx };
  }).sort((a, b) => a.min - b.min);
  const transitionDepths = new Set();
  for (let i = 0; i < allBands.length - 1; i++) {
    const boundary = allBands[i].max; 
    if (boundary > depthMinFt && boundary < depthMaxFt) transitionDepths.add(boundary);
  }
  if (transitionDepths.size === 0) {
    for (const b of allBands) {
      if (b.min >= depthMinFt && b.max <= depthMaxFt) {
        transitionDepths.add(b.min);
        transitionDepths.add(b.max);
      }
    }
  }
  const SHARED_TOL_FT = 25; 
  const sharedEdges = [];
  for (const boundary of transitionDepths) {
    const shallowFeats = gj.features.filter(f => (f.properties?.depth_max_ft ?? -1) === boundary);
    const deepFeats    = gj.features.filter(f => (f.properties?.depth_min_ft ?? -1) === boundary);
    if (!shallowFeats.length || !deepFeats.length) {
      const soloFeats = shallowFeats.length ? shallowFeats : deepFeats;
      for (const f of soloFeats) sharedEdges.push(...featureEdges(f));
      continue;
    }
    const deepEdgeMids = [];
    for (const f of deepFeats) {
      for (const [a, b] of featureEdges(f)) deepEdgeMids.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    }
    for (const f of shallowFeats) {
      for (const edge of featureEdges(f)) {
        const mid = [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2];
        const isShared = deepEdgeMids.some(dm => ftBetweenLonLat(mid, dm) < SHARED_TOL_FT);
        if (isShared) sharedEdges.push(edge);
      }
    }
  }
  return sharedEdges;
}

function edgesToSpines(edges, depthMin, depthMax) {
  if (!edges.length) return [];
  const TOL_FT = 30;
  const used = new Set();
  const chains = [];
  for (let i = 0; i < edges.length; i++) {
    if (used.has(i)) continue;
    const chain = [...edges[i]];
    used.add(i);
    let extended = true;
    while (extended) {
      extended = false;
      for (let j = 0; j < edges.length; j++) {
        if (used.has(j)) continue;
        const [ea, eb] = edges[j];
        const tail = chain[chain.length - 1];
        if (ftBetweenLonLat(tail, ea) < TOL_FT) {
          chain.push(eb); used.add(j); extended = true;
        } else if (ftBetweenLonLat(tail, eb) < TOL_FT) {
          chain.push(ea); used.add(j); extended = true;
        }
      }
    }
    if (chain.length >= 3) chains.push(chain);
  }
  const depth = (depthMin + depthMax) / 2;
  return chains.map(chain => ({
    coords: chain, len: contourArcLength(chain), depth, mid: chain[Math.floor(chain.length / 2)],
  })).filter(s => s.len >= 200).sort((a, b) => b.len - a.len);
}

function generateDepthPolygonRoutes(cfg) {
  const { depthMin, depthMax } = cfg;
  const edges = getDepthPolygonEdges(depthMin, depthMax);
  if (!edges.length) return null; 
  let candidates = edgesToSpines(edges, depthMin, depthMax);
  if (!candidates.length) return null;
  if (clipPolygon) candidates = candidates.filter(s => s.coords.some(([lon, lat]) => pointInPolygon([lat, lon], clipPolygon)));
  if (!candidates.length) return null;

  const sLat = cfg.startLat != null ? cfg.startLat : cfg.rampLat;
  const sLon = cfg.startLon != null ? cfg.startLon : cfg.rampLon;
  const eLat = cfg.endLat, eLon = cfg.endLon;
  const lockedBearing = cfg.lockedBearing ?? null;

  if (sLat != null && sLon != null) {
    const MAX_SPINE_DIST_FT = cfg.singleBestTrack ? 10560 : Infinity; 
    candidates.forEach(s => {
      const closestFt = closestPointOnSpineFt(sLat, sLon, s.coords);
      if (closestFt > MAX_SPINE_DIST_FT) { s.trollScore = -Infinity; s._closestFt = closestFt; return; }
      const startPenalty = closestFt * 10;
      let endPenalty = 0;
      if (cfg.isReturnPass && eLat != null && eLon != null) {
         endPenalty = closestPointOnSpineFt(eLat, eLon, s.coords) * 10;
      }
      const lenScore  = Math.min(s.len, cfg.targetLengthFt || 15000);
      let bearingBonus = 0;
      if (lockedBearing !== null && s.coords.length >= 2) {
        const [, spineBrng] = distBearing(s.coords[0][1], s.coords[0][0], s.coords[s.coords.length-1][1], s.coords[s.coords.length-1][0]);
        const diff = Math.abs(((spineBrng - lockedBearing + 540) % 360) - 180);
        bearingBonus = diff < 90 ? (1 - diff / 90) * 30000 : -10000;
      }
      s.trollScore = (lenScore * 3) - startPenalty - endPenalty + bearingBonus;
      s._closestFt = closestFt;
    });
    candidates.sort((a, b) => (b.trollScore || 0) - (a.trollScore || 0));
  }

  const spine = candidates[0];
  if (!spine) return null;
  let trimmed = trimSpineToClip(spine.coords.map(([lon, lat]) => [lat, lon]));
  if (trimmed.length < 2) return null;
  const targetPassFt = (Number.isFinite(cfg.targetLengthFt) && cfg.targetLengthFt > 0) ? cfg.targetLengthFt : 15000;
  trimmed = prepareSpineForPhase(trimmed, cfg);
  if (trimmed.length < 2) return null;
  let pts = clampToClip(patternAlongSpine(trimmed, { ...cfg, amplitude: cfg.amplitude || 25 }));
  if (pts.length < 2) return null;
  pts = trimPolylineToLength(pts, targetPassFt);
  if (pts.length < 2) return null;
  return [{ name: `Sweep_${depthMin}-${depthMax}ft`, pts: pts.slice(0, 3000), depth: (depthMin + depthMax) / 2 }];
}

function generateContourRoutes(cfg) {
  const contour = getActiveContour();
  const gj = contour?.smart || contour?.raw;
  if (!gj?.features?.length) return [];
  const { depthMin, depthMax, spacing, pattern, amplitude, wave, straightFt } = cfg;
  const lanes = Math.max(1, Math.min(12, cfg.lanes || 1));
  const depthTolerance = 5; 
  const effectiveDepthMin = depthMin - depthTolerance;
  const effectiveDepthMax = depthMax + depthTolerance;

  const inRange = gj.features.filter(f => f.properties?.depth_ft != null && f.properties.depth_ft >= effectiveDepthMin && f.properties.depth_ft <= effectiveDepthMax);
  if (!inRange.length) return [];
  const scoped = clipPolygon ? inRange.filter(featureIntersectsClip) : inRange;
  let candidates = buildStitchedSpines(scoped).map(s => ({ ...s, coords: s.coords, mid: s.mid })).filter(s => s.len >= 250);
  if (!candidates.length) return [];

  const sLat = cfg.startLat != null ? cfg.startLat : cfg.rampLat;
  const sLon = cfg.startLon != null ? cfg.startLon : cfg.rampLon;
  if (sLat != null && sLon != null) {
    candidates.forEach(s => {
      const closestFt = closestPointOnSpineFt(sLat, sLon, s.coords);
      if (closestFt > (cfg.singleBestTrack ? 10560 : Infinity)) { s.trollScore = -Infinity; return; }
      s.trollScore = Math.min(s.len, cfg.targetLengthFt || 15000) * 3 - (closestFt * 10);
    });
    candidates.sort((a, b) => (b.trollScore || 0) - (a.trollScore || 0));
  }

  const chosen = candidates.slice(0, lanes);
  if (!chosen.length) return [];

  const waveFt = Math.max(wave || 300, 150);
  const tracks = [];
  for (let i = 0; i < chosen.length; i++) {
    let spine = resampleContour(chosen[i].coords, waveFt);
    spine = trimSpineToClip(spine);
    if (spine.length < 2) continue;
    spine = prepareSpineForPhase(spine, cfg);
    if (spine.length < 2) continue;
    let pts = clampToClip(patternAlongSpine(spine, { pattern, amplitude, wave: waveFt, straightFt, spacing }));
    if (cfg.targetLengthFt > 0) pts = trimPolylineToLength(pts, cfg.targetLengthFt);
    if (pts.length >= 2) tracks.push({ name: `Sweep_${depthMin}-${depthMax}ft`, pts: pts.slice(0, 3000), depth: (depthMin + depthMax) / 2 });
  }
  return tracks;
}

function generateFollowRoutes(cfg) {
  const gj = getActiveContour()?.smart || getActiveContour()?.raw;
  if (!gj?.features?.length) return [];
  const inRange = gj.features.filter(f => f.properties?.depth_ft != null && f.properties.depth_ft >= cfg.depthMin - 5 && f.properties.depth_ft <= cfg.depthMax + 5);
  const scoped = clipPolygon ? inRange.filter(f => featureIntersectsClip(f)) : inRange;
  const spines = buildStitchedSpines(scoped).filter(s => s.len >= (clipPolygon ? 250 : 500));
  const tracks = [];
  for (const sp of spines.slice(0, clipPolygon ? 12 : 6)) {
    let waypoints = trimSpineToClip(resampleContour(sp.coords, Math.max(cfg.wave || 300, 150)));
    if (waypoints.length < 2) continue;
    let allPts = clampToClip(patternAlongSpine(waypoints, cfg));
    if (allPts.length > 1) tracks.push({ name: `Follow_${sp.depth}ft`, pts: allPts, depth: sp.depth });
  }
  return tracks;
}

function trackLengthFt(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += distBearing(pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1])[0];
  return l;
}

function distancePointToRefFt(pt, lat, lon) {
  if (!pt || !isValidLatLon(lat, lon)) return Infinity;
  return distBearing(lat, lon, pt[0], pt[1])[0];
}

function nearestPointIndex(pts, lat, lon) {
  if (!pts?.length || !isValidLatLon(lat, lon)) return 0;
  let bestIdx = 0, best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = distancePointToRefFt(pts[i], lat, lon);
    if (d < best) { best = d; bestIdx = i; }
  }
  return bestIdx;
}

function trimPolylineToLength(pts, maxFt) {
  if (!pts?.length || !Number.isFinite(maxFt) || maxFt <= 0) return pts || [];
  const out = [pts[0]];
  let used = 0;
  for (let i = 1; i < pts.length; i++) {
    const [segFt, brng] = distBearing(pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1]);
    if (used + segFt <= maxFt) { out.push(pts[i]); used += segFt; }
    else { out.push(destination(pts[i-1][0], pts[i-1][1], brng, maxFt - used)); break; }
  }
  return out.length >= 2 ? out : pts.slice(0, 2);
}

function prepareSpineForPhase(spine, cfg) {
  if (!spine?.length) return spine || [];
  const sLat = cfg.startLat ?? cfg.rampLat, sLon = cfg.startLon ?? cfg.rampLon;
  let out = spine;
  if (isValidLatLon(sLat, sLon)) {
    const idx = nearestPointIndex(spine, sLat, sLon);
    const forward = spine.slice(idx), reverse = spine.slice(0, idx + 1).reverse();
    out = (forward.length > reverse.length) ? forward : reverse; // simplify direction choice
  }
  if (cfg.targetLengthFt > 0) out = trimPolylineToLength(out, cfg.targetLengthFt);
  return out;
}

function buildConnectorTrack(name, fromLat, fromLon, toLat, toLon, role = 'connector') {
  if (!isValidLatLon(fromLat, fromLon) || !isValidLatLon(toLat, toLon)) return null;
  const [connDistFt, brng] = distBearing(fromLat, fromLon, toLat, toLon);
  if (connDistFt < 3) return null;
  const n = Math.max(1, Math.ceil(connDistFt / 250));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(destination(fromLat, fromLon, brng, connDistFt * i / n));
  pts[0] = [fromLat, fromLon]; pts[pts.length - 1] = [toLat, toLon];
  return { name, pts, role, connector: true, smartPlan: true, lengthFt: connDistFt };
}

function addOrSnapConnector(out, name, fromLat, fromLon, targetTrack, role) {
  if (!targetTrack?.pts?.length || !isValidLatLon(fromLat, fromLon)) return;
  const first = targetTrack.pts[0];
  if (distBearing(fromLat, fromLon, first[0], first[1])[0] <= 25) {
    targetTrack.pts[0] = [fromLat, fromLon]; return;
  }
  const c = buildConnectorTrack(name, fromLat, fromLon, first[0], first[1], role);
  if (c) out.push(c);
}

// ── Waypoints & Manual UI Config ──────────────────────────────────────────────

const WPT_FIELDS = ['waypoints', 'wpts', 'marks', 'markers', 'catches', 'points', 'pins'];

function coerceLatLon(o) {
  if (!o) return null;
  const lat = o.lat ?? o.latitude ?? o.y;
  const lon = o.lon ?? o.lng ?? o.long ?? o.longitude ?? o.x;
  if (typeof lat === 'number' && typeof lon === 'number') return { lat, lon, name: o.name || o.title || '' };
  if (o.geometry?.coordinates?.length >= 2) return { lat: o.geometry.coordinates[1], lon: o.geometry.coordinates[0], name: o.name || '' };
  return null;
}

function getSavedWaypoints() {
  const D = state.DATA;
  if (!D) return [];
  for (const field of WPT_FIELDS) {
    if (Array.isArray(D[field]) && D[field].length) return D[field].map(coerceLatLon).filter(Boolean);
  }
  return [];
}

function renderWaypointMarkers() {
  waypointMarkers.forEach(m => state.MAP?.removeLayer(m));
  waypointMarkers = [];
  manualWaypoints.forEach(([lat, lon], i) => {
    const m = L.circleMarker([lat, lon], { radius: 5, color: '#00e5ff', fillColor: '#00e5ff', fillOpacity: 1, weight: 2 }).addTo(state.MAP);
    m.bindTooltip(`WP${i+1}`, { permanent: false, direction: 'top' });
    waypointMarkers.push(m);
  });
  if (waypointMarkers._previewLine) state.MAP?.removeLayer(waypointMarkers._previewLine);
  if (manualWaypoints.length > 1) {
    const previewPts = document.getElementById('rbCloseLoop')?.checked ? [...manualWaypoints, manualWaypoints[0]] : manualWaypoints;
    waypointMarkers._previewLine = L.polyline(previewPts, { color: '#00e5ff', weight: 1, opacity: 0.4, dashArray: '4 4' }).addTo(state.MAP);
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

function generateWaypointRoute(cfg) {
  if (manualWaypoints.length < 2) return [];
  const seq = cfg.closeLoop ? [...manualWaypoints, manualWaypoints[0]] : manualWaypoints;
  const allPts = [];
  for (let i = 0; i < seq.length - 1; i++) {
    const pts = applyPattern(seq[i], seq[i + 1], cfg);
    allPts.push(...(allPts.length ? pts.slice(1) : pts));
  }
  return allPts.length > 1 ? [{ name: cfg.closeLoop ? 'Waypoint Loop' : 'Waypoint Route', pts: allPts }] : [];
}

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
  if (tracks.length) state.MAP.fitBounds(tracks.flatMap(t => t.pts), { padding: [40, 40] });
}

// ── Exported Interfaces ───────────────────────────────────────────────────────

export function setClipPolygon(polygon) {
  clipPolygon = polygon;
  window._routeBuilderClipActive = !!polygon;
}

export function setClipFromRamp(rampLat, rampLon, rangeMiles) {
  if (!rampLat || !rampLon || !rangeMiles) {
    clipPolygon = null;
    window._routeBuilderClipActive = false;
    return;
  }
  const clippedRangeMiles = Math.min(4.0, Math.max(0.5, rangeMiles));
  const latDeg = clippedRangeMiles / 69.0;
  const lonDeg = clippedRangeMiles / (69.0 * Math.cos(rampLat * Math.PI / 180));
  clipPolygon = [
    [rampLat - latDeg, rampLon - lonDeg],
    [rampLat + latDeg, rampLon - lonDeg],
    [rampLat + latDeg, rampLon + lonDeg],
    [rampLat - latDeg, rampLon + lonDeg],
    [rampLat - latDeg, rampLon - lonDeg],
  ];
  window._routeBuilderClipActive = true;
}

// THE HOOK FOR SMART PLAN - Uses Autonomous Boid Steering logic.
export function generateAndCommitRoute(overrides = {}) {
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
    depthMax:       overrides.depthMax   != null ? overrides.depthMax   : (parseInt(document.getElementById('rbDepthMax')?.value)    || 28),
    pattern:        overrides.pattern    != null ? overrides.pattern    : (document.getElementById('rbPattern')?.value               || 'sine+straight'),
    spacing:        overrides.spacing    != null ? overrides.spacing    : (parseFloat(document.getElementById('rbSpacing')?.value)   || 150),
    amplitude:      overrides.amplitude  != null ? overrides.amplitude  : (parseFloat(document.getElementById('rbAmplitude')?.value) || 30),
    wave:           parseFloat(document.getElementById('rbWave')?.value)      || 350,
    straightFt:     parseFloat(document.getElementById('rbStraight')?.value)  || 500,
    trackName:      overrides.trackName
  };

  // Run the new Geography-Aware Autonomous Route Generator
  let tracks = generateAutonomousRoute(cfg);

  // If Autonomous failed (maybe no map data), fallback to polygon/contour generator
  if (!tracks || !tracks.length) {
    tracks = generateDepthPolygonRoutes(cfg);
    if (!tracks || !tracks.length) tracks = generateContourRoutes(cfg);
  }

  if (!tracks || !tracks.length) return [];

  const prefix = overrides.trackName || `Smart Plan ${cfg.depthMin}-${cfg.depthMax}ft`;
  tracks = tracks.map((t, i) => ({
    ...t,
    name: tracks.length > 1 ? `${prefix} (${i + 1})` : prefix,
    role: 'fishing',
    smartPlan: overrides.smartPlan !== false,
    connector: false,
    lengthFt: trackLengthFt(t.pts || []),
  }));

  const commitTracks = [];
  const startLat = cfg.startLat ?? rampLat;
  const startLon = cfg.startLon ?? rampLon;
  
  if (overrides.emitConnectors !== false && tracks[0]) {
    addOrSnapConnector(commitTracks, `Connector: Start → ${prefix}`, startLat, startLon, tracks[0], 'start_connector');
  }

  commitTracks.push(...tracks);

  if (overrides.emitConnectors !== false && cfg.endLat != null && cfg.endLon != null && commitTracks.length) {
    const lastTrack = commitTracks[commitTracks.length - 1];
    const lastPt = lastTrack.pts?.[lastTrack.pts.length - 1];
    if (lastPt) {
      if (distBearing(lastPt[0], lastPt[1], cfg.endLat, cfg.endLon)[0] <= 25) {
        lastTrack.pts[lastTrack.pts.length - 1] = [cfg.endLat, cfg.endLon];
      } else {
        const c = buildConnectorTrack(`Connector: ${prefix} → Return`, lastPt[0], lastPt[1], cfg.endLat, cfg.endLon, 'return_connector');
        if (c) commitTracks.push(c);
      }
    }
  }

  if (!state.DATA.tracks) state.DATA.tracks = [];
  state.DATA.tracks.push(...commitTracks);
  renderAll();
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
      <div style="display:flex;gap:5px;margin-bottom:6px">
        <select id="rbSavedWptSelect" style="flex:1;min-width:0;height:28px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;padding:0 6px">
          <option value="">— saved waypoints —</option>
        </select>
        <button id="rbAddSavedWpt" style="height:28px;padding:0 10px;font-size:11px;border:1px solid var(--accent);background:rgba(0,229,255,.08);color:var(--accent);border-radius:5px;cursor:pointer;font-weight:600">➕ Add</button>
        <button id="rbAddAllSaved" style="height:28px;padding:0 8px;font-size:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:5px;cursor:pointer">All</button>
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
          <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Amplitude (ft)</div>
          <input id="rbAmplitude" type="number" value="30" min="5" max="200" style="width:100%;padding:4px 6px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:12px;box-sizing:border-box">
        </div>
      </div>
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
    </div>

    <!-- Generate / Commit / Reverse / Clear -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:5px;padding-top:8px;border-top:1px solid var(--line)">
      <button id="rbGenerate" style="height:32px;font-size:11px;font-weight:700;border:1px solid var(--line);border-radius:5px;background:var(--panel2);color:var(--text);cursor:pointer">⚡ Generate</button>
      <button id="rbCommit" style="height:32px;font-size:11px;font-weight:700;border:1px solid var(--line);border-radius:5px;background:var(--panel2);color:var(--text);cursor:pointer;display:none">✅ Commit</button>
      <button id="rbReverse" style="height:32px;font-size:11px;border:1px solid var(--line);border-radius:5px;background:var(--panel2);color:var(--muted);cursor:pointer;display:none">🔄 Reverse</button>
      <button id="rbClear" style="height:32px;width:32px;font-size:12px;border:1px solid var(--line);background:var(--panel2);color:var(--muted);border-radius:5px;cursor:pointer">✕</button>
    </div>
    <div id="rbStatus" style="margin-top:6px;font-size:11px;color:var(--muted)"></div>
  `;

  wireRouteBuilder();
  updateContourInfo();
  onContourChange(updateContourInfo);
}

function readCfg() {
  const num = (id, def) => { const v = parseFloat(document.getElementById(id)?.value); return Number.isFinite(v) ? v : def; };
  return {
    depthMin:   parseInt(document.getElementById('rbDepthMin')?.value)   || 18,
    depthMax:   parseInt(document.getElementById('rbDepthMax')?.value)   || 28,
    pattern:    document.getElementById('rbPattern')?.value || 'sine+straight',
    spacing:    num('rbSpacing', 150),
    amplitude:  num('rbAmplitude', 30),
    lanes:      parseInt(document.getElementById('rbLanes')?.value)        || 1,
    closeLoop:  document.getElementById('rbCloseLoop')?.checked || false,
    wave:       num('rbWave', 350),
    straightFt: num('rbStraight', 500),
    ppw:        16,
    dynamic:    false,
    bias:       0,
    minSpacing: 25,
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
  document.querySelectorAll('input[name="rbSrc"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const isContour = document.getElementById('rbSrcContour')?.checked;
      document.getElementById('rbContourInfo').style.display  = isContour ? 'block' : 'none';
      document.getElementById('rbDepthSection').style.display = isContour ? 'block' : 'none';
      document.getElementById('rbManualSection').style.display = isContour ? 'none' : 'block';
    });
  });

  document.querySelectorAll('input[name="rbContourMode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const isFollow = document.getElementById('rbModeFollow')?.checked;
      const lbl = document.getElementById('rbDepthLabel');
      if (lbl) lbl.textContent = isFollow ? 'Target depth (ft)' : 'Depth band (ft)';
      const lanesRow = document.getElementById('rbLanesRow');
      if (lanesRow) lanesRow.style.display = isFollow ? 'none' : 'flex';
      document.querySelectorAll('input[name="rbContourMode"]').forEach(r => {
        const lel = r.closest('label');
        if (!lel) return;
        lel.style.border = r.checked ? '1px solid var(--accent)' : '1px solid var(--line)';
        lel.style.background = r.checked ? 'rgba(0,229,255,.08)' : '';
        r.nextElementSibling.style.color = r.checked ? 'var(--accent)' : 'var(--text)';
      });
    });
  });

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

  const refreshSavedWptDropdown = () => {
    const sel = document.getElementById('rbSavedWptSelect');
    if (!sel) return;
    const saved = getSavedWaypoints();
    if (!saved.length) {
      sel.innerHTML = '<option value="">— no saved waypoints —</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    sel.innerHTML = '<option value="">— saved waypoints —</option>' + saved.map((w, i) => {
      const label = w.name ? esc(w.name) : `${w.lat.toFixed(4)}, ${w.lon.toFixed(4)}`;
      return `<option value="${i}">${label}</option>`;
    }).join('');
    window._rbSavedWptCache = saved;
  };

  document.getElementById('rbSrcManual')?.addEventListener('change', refreshSavedWptDropdown);
  refreshSavedWptDropdown();

  document.getElementById('rbAddSavedWpt')?.addEventListener('click', () => {
    const sel = document.getElementById('rbSavedWptSelect');
    const idx = parseInt(sel?.value);
    const saved = window._rbSavedWptCache || getSavedWaypoints();
    if (Number.isNaN(idx) || !saved[idx]) return;
    manualWaypoints.push([saved[idx].lat, saved[idx].lon]);
    renderWaypointMarkers();
  });

  document.getElementById('rbAddAllSaved')?.addEventListener('click', () => {
    const saved = window._rbSavedWptCache || getSavedWaypoints();
    saved.forEach(w => manualWaypoints.push([w.lat, w.lon]));
    renderWaypointMarkers();
  });

  window._rbRemoveWpt = (idx) => { manualWaypoints.splice(idx, 1); renderWaypointMarkers(); };
  document.getElementById('rbCloseLoop')?.addEventListener('change', renderWaypointMarkers);

  const handleMapClick = (e) => {
    if (!window._rbPickMode) return;
    if (window._rbPickMode === 'waypoint') {
      manualWaypoints.push([e.latlng.lat, e.latlng.lng]);
      renderWaypointMarkers();
    }
  };

  if (state.MAP) state.MAP.on('click', handleMapClick);
  else setTimeout(() => state.MAP?.on('click', handleMapClick), 2000);

  document.getElementById('rbDrawClip')?.addEventListener('click', () => {
    if (!window.L?.Draw) return;
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

  document.getElementById('rbGenerate')?.addEventListener('click', () => {
    const cfg = readCfg();
    const isContour = document.getElementById('rbSrcContour')?.checked;
    const isFollow  = document.getElementById('rbModeFollow')?.checked;
    let tracks = [];

    if (isContour) {
      tracks = isFollow ? generateFollowRoutes(cfg) : generateContourRoutes(cfg);
      if (!tracks.length) { setStatus('No contours found.', 'var(--bad)'); return; }
    } else {
      if (manualWaypoints.length < 2) { setStatus('Add at least 2 waypoints.', 'var(--bad)'); return; }
      tracks = generateWaypointRoute(cfg);
    }

    pendingTracks = tracks;
    renderRoutes(tracks);
    setStatus(`Generated ${tracks.length} route(s). Commit to add to plan.`, 'var(--accent2)');
    document.getElementById('rbCommit').style.display = '';
    document.getElementById('rbReverse').style.display = '';
  });

  document.getElementById('rbCommit')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    if (btn.disabled || !pendingTracks.length) return;
    btn.disabled = true;
    state.DATA.tracks.push(...pendingTracks);
    pendingTracks = [];
    renderAll();
    btn.style.display = 'none';
    btn.disabled = false; 
    setStatus(`✅ ${state.DATA.tracks.length} track(s) in plan.`, 'var(--accent2)');
  });

  document.getElementById('rbClear')?.addEventListener('click', () => {
    if (routeLayer) { state.MAP?.removeLayer(routeLayer); routeLayer = null; }
    pendingTracks = [];
    document.getElementById('rbCommit').style.display = 'none';
    document.getElementById('rbReverse').style.display = 'none';
    setStatus('');
  });

  document.getElementById('rbReverse')?.addEventListener('click', () => {
    if (!pendingTracks.length) return;
    pendingTracks = pendingTracks.map(t => ({ ...t, pts: [...t.pts].reverse() }));
    renderRoutes(pendingTracks);
    setStatus('Route reversed. Commit to add to plan.', 'var(--accent2)');
  });

  window.sendWptToRouteBuilder = (lat, lon, role) => {
    manualWaypoints.push([lat, lon]);
    renderWaypointMarkers();
    const manual = document.getElementById('rbSrcManual');
    if (manual) { manual.checked = true; manual.dispatchEvent(new Event('change')); }
  };

  window.sendWptToGenerator = window.sendWptToRouteBuilder;
}

console.log('[route-builder] module ready');
