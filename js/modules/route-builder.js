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

// ── Shared state ──────────────────────────────────────────────────────────────

let routeLayer = null;
let clipPolygon = null;
let clipLayer   = null;
let pendingTracks = [];
let pickingMode = null;  // 'start' | 'end' | 'clip'

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
  const [dist, brng] = distBearing(p1[0], p1[1], p2[0], p2[1]);
  if (dist < 1) return [];
  const perp = (brng + 90) % 360;
  const n = Math.max(8, Math.ceil((dist / Math.max(20, cfg.wave)) * 16));
  return Array.from({length: n+1}, (_, i) => {
    const t = i / n;
    const c = destination(p1[0], p1[1], brng, dist*t);
    const off = Math.sin(2*Math.PI*dist*t / Math.max(20, cfg.wave)) * cfg.amplitude;
    return destination(c[0], c[1], perp, off);
  });
}

function genZigzag(p1, p2, cfg) {
  const [dist, brng] = distBearing(p1[0], p1[1], p2[0], p2[1]);
  if (dist < 1) return [];
  const perp = (brng + 90) % 360;
  const step = Math.max(20, cfg.wave / 2);
  const n = Math.max(1, Math.ceil(dist / step));
  const pts = [p1];
  let dir = 1;
  for (let i = 1; i < n; i++) {
    const c = destination(p1[0], p1[1], brng, dist*i/n);
    pts.push(destination(c[0], c[1], perp, cfg.amplitude * dir));
    dir *= -1;
  }
  pts.push(p2);
  return pts;
}

function genMixed(p1, p2, cfg, curveFn) {
  const [dist, brng] = distBearing(p1[0], p1[1], p2[0], p2[1]);
  if (dist < 1) return [];
  const pts = [p1];
  let cursor = 0;
  const straightFt = cfg.straightFt || 350;
  while (cursor < dist) {
    const endS = Math.min(cursor + straightFt, dist);
    const s = destination(p1[0], p1[1], brng, cursor);
    const e = destination(p1[0], p1[1], brng, endS);
    pts.push(...genStraight(s, e, cfg).slice(1));
    cursor = endS;
    if (cursor >= dist) break;
    const endC = Math.min(cursor + cfg.wave, dist);
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

// ── Contour mode: follow depth band ──────────────────────────────────────────

function generateContourRoutes(cfg) {
  const contour = getActiveContour();
  const gj = contour?.smart || contour?.raw;
  if (!gj?.features?.length) return [];

  const { depthMin, depthMax, spacing, pattern, amplitude, wave, straightFt } = cfg;

  // 1. Filter by depth range
  const inRange = gj.features.filter(f => {
    const d = f.properties?.depth_ft;
    return d != null && d >= depthMin && d <= depthMax;
  });
  if (!inRange.length) return [];

  // 2. Apply clip polygon if set
  const candidates = clipPolygon
    ? inRange.filter(f => featureIntersectsClip(f))
    : inRange;
  if (!candidates.length) return [];

  // 3. Collect all coordinates in the depth band and compute bbox
  const allCoords = [];
  for (const f of candidates) {
    for (const c of (f.geometry?.coordinates || [])) allCoords.push(c);
  }
  if (allCoords.length < 2) return [];

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [lon, lat] of allCoords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  const centerLat = (minLat + maxLat) / 2;
  const centerLon = (minLon + maxLon) / 2;

  // 4. Compute dominant bearing of the contours using weighted circular mean.
  //    Normalize each bearing to [0,180) to treat opposing directions as equal,
  //    weight by segment length so long contours dominate.
  let sinSum = 0, cosSum = 0;
  for (const f of candidates) {
    const coords = f.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    for (let i = 1; i < coords.length; i++) {
      const [segLen, brng] = distBearing(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0]);
      if (segLen < 5) continue;
      const bRad = ((brng % 180) * 2) * Math.PI / 180;
      sinSum += Math.sin(bRad) * segLen;
      cosSum += Math.cos(bRad) * segLen;
    }
  }
  const dominantBrng = ((Math.atan2(sinSum, cosSum) * 180 / Math.PI / 2) + 180) % 180;

  // Troll lanes run PERPENDICULAR to the contours (across the depth gradient)
  const trollBrng = (dominantBrng + 90) % 360;
  const stepBrng  = dominantBrng; // step along the contour direction

  // 5. Project bbox corners onto both axes to get lane length and band width
  const corners = [
    [minLat, minLon], [minLat, maxLon],
    [maxLat, minLon], [maxLat, maxLon],
  ];
  let minTroll = Infinity, maxTroll = -Infinity;
  let minStep  = Infinity, maxStep  = -Infinity;
  for (const [lat, lon] of corners) {
    const [d, b] = distBearing(centerLat, centerLon, lat, lon);
    const trollProj = d * Math.cos(((b - trollBrng + 180 + 360) % 360 - 180) * Math.PI / 180);
    const stepProj  = d * Math.cos(((b - stepBrng  + 180 + 360) % 360 - 180) * Math.PI / 180);
    if (trollProj < minTroll) minTroll = trollProj;
    if (trollProj > maxTroll) maxTroll = trollProj;
    if (stepProj  < minStep)  minStep  = stepProj;
    if (stepProj  > maxStep)  maxStep  = stepProj;
  }

  // 6. Generate parallel lanes sweeping across the depth band.
  //    Each lane runs the full bbox length along the troll bearing.
  //    Lanes alternate direction (boustrophedon) so the track connects end-to-end.
  const tracks = [];
  let offset = minStep;
  let laneIdx = 0;

  while (offset <= maxStep + spacing * 0.1) {
    const laneCenter = destination(centerLat, centerLon, stepBrng, offset);
    let p1 = destination(laneCenter[0], laneCenter[1], trollBrng, minTroll);
    let p2 = destination(laneCenter[0], laneCenter[1], trollBrng, maxTroll);
    if (laneIdx % 2 === 1) [p1, p2] = [p2, p1]; // alternate direction

    const pts = applyPattern(p1, p2, { pattern, amplitude, wave, straightFt, spacing });
    if (pts.length > 1) {
      tracks.push({
        name: `Lane${laneIdx + 1}_${depthMin}-${depthMax}ft`,
        pts,
        depth: (depthMin + depthMax) / 2,
      });
    }
    offset += spacing;
    laneIdx++;
  }

  return tracks;
}
// ── Follow mode: trace a specific contour with pattern applied along its shape ─

function generateFollowRoutes(cfg) {
  const contour = getActiveContour();
  const gj = contour?.smart || contour?.raw;
  if (!gj?.features?.length) return [];

  const { depthMin, depthMax, spacing, pattern, amplitude, wave, straightFt } = cfg;

  // Filter by depth range (use a narrow band — ideally 2-4ft for follow mode)
  const inRange = gj.features.filter(f => {
    const d = f.properties?.depth_ft;
    return d != null && d >= depthMin && d <= depthMax;
  });
  if (!inRange.length) return [];

  const candidates = clipPolygon
    ? inRange.filter(f => featureIntersectsClip(f))
    : inRange;
  if (!candidates.length) return [];

  // Compute true path length for each feature
  const withLen = candidates.map(f => {
    const coords = f.geometry?.coordinates;
    if (!coords || coords.length < 2) return null;
    let len = 0;
    for (let i = 1; i < coords.length; i++) {
      const [d] = distBearing(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0]);
      len += d;
    }
    return len >= 300 ? { feat: f, coords, pathLen: len } : null;
  }).filter(Boolean);

  if (!withLen.length) return [];

  // Deduplicate tile-seam duplicates: same depth, midpoints within spacing/2
  const DEDUP_RADIUS = Math.max(spacing * 0.6, 150);
  withLen.sort((a, b) => b.pathLen - a.pathLen);
  const kept = [];
  for (const item of withLen) {
    const depth = item.feat.properties.depth_ft;
    const mid = item.coords[Math.floor(item.coords.length / 2)];
    const isDup = kept.some(k => {
      if (k.feat.properties.depth_ft !== depth) return false;
      const km = k.coords[Math.floor(k.coords.length / 2)];
      const [d] = distBearing(mid[1], mid[0], km[1], km[0]);
      return d < DEDUP_RADIUS;
    });
    if (!isDup) kept.push(item);
  }

  // For each kept contour, resample to wave-length intervals then apply pattern
  // between consecutive waypoints so the sine/zigzag has room to develop.
  const RESAMPLE_FT = Math.max(wave || 300, 150);
  const tracks = [];

  for (const { feat, coords } of kept) {
    const depth = feat.properties.depth_ft;

    // Resample: one waypoint every RESAMPLE_FT of actual path distance
    const waypoints = [[coords[0][1], coords[0][0]]];
    let carry = 0;
    for (let i = 1; i < coords.length; i++) {
      const [d] = distBearing(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0]);
      carry += d;
      if (carry >= RESAMPLE_FT) {
        waypoints.push([coords[i][1], coords[i][0]]);
        carry = 0;
      }
    }
    const last = coords[coords.length - 1];
    waypoints.push([last[1], last[0]]);

    if (waypoints.length < 2) continue;

    // Apply pattern between each pair of resampled waypoints and stitch together
    const allPts = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const p1 = waypoints[i], p2 = waypoints[i + 1];
      const [segDist] = distBearing(p1[0], p1[1], p2[0], p2[1]);
      if (segDist < 20) continue;
      const pts = applyPattern(p1, p2, { pattern, amplitude, wave, straightFt, spacing });
      if (i === 0) allPts.push(...pts);
      else allPts.push(...pts.slice(1));
    }

    if (allPts.length > 1) {
      tracks.push({ name: `Follow_${depth}ft`, pts: allPts, depth });
    }
  }

  return tracks;
}


function featureIntersectsClip(feat) {
  if (!clipPolygon) return true;
  const coords = feat.geometry?.coordinates;
  if (!coords?.length) return false;
  // Sample up to 9 evenly-spaced points along the feature.
  // A long contour may cross the clip polygon without its midpoint being inside.
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
  for (let i = 0, j = pts.length-1; i < pts.length; j = i++) {
    const [yi, xi] = pts[i];
    const [yj, xj] = pts[j];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj-xi)*(lat-yi)/(yj-yi)+xi)) {
      inside = !inside;
    }
  }
  return inside;
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

export function buildRouteBuilderPanel(container) {
  container.innerHTML = `
    <!-- Path source -->
    <div style="margin-bottom:12px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Path source</div>
      <div style="display:flex;gap:6px">
        <label id="rbSrcContourLabel" style="flex:1;display:flex;align-items:center;gap:5px;padding:6px 8px;border:1px solid var(--accent);border-radius:6px;background:rgba(0,229,255,.08);cursor:pointer">
          <input type="radio" name="rbSrc" value="contour" id="rbSrcContour" checked style="accent-color:var(--accent)">
          <span style="font-size:11px;color:var(--accent);font-weight:600">Contour</span>
        </label>
        <label id="rbSrcManualLabel" style="flex:1;display:flex;align-items:center;gap:5px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;cursor:pointer">
          <input type="radio" name="rbSrc" value="manual" id="rbSrcManual" style="accent-color:var(--accent)">
          <span style="font-size:11px;color:var(--text)">Manual</span>
        </label>
      </div>
    </div>

    <!-- Active contour info (contour mode) -->
    <div id="rbContourInfo" style="margin-bottom:10px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:8px 10px;font-size:11px">
      <div id="rbContourInfoText" style="color:var(--muted)">No contour dataset loaded — go to Contour Data tab</div>
    </div>

    <!-- Contour mode: sub-mode toggle + depth range -->
    <div id="rbDepthSection" style="margin-bottom:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">Contour mode</div>
      <div style="display:flex;gap:6px;margin-bottom:8px">
        <label style="flex:1;display:flex;align-items:center;gap:5px;padding:5px 8px;border:1px solid var(--accent);border-radius:6px;background:rgba(0,229,255,.08);cursor:pointer">
          <input type="radio" name="rbContourMode" value="sweep" id="rbModeSweep" checked style="accent-color:var(--accent)">
          <span style="font-size:11px;color:var(--accent);font-weight:600">↔ Sweep band</span>
        </label>
        <label style="flex:1;display:flex;align-items:center;gap:5px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;cursor:pointer">
          <input type="radio" name="rbContourMode" value="follow" id="rbModeFollow" style="accent-color:var(--accent)">
          <span style="font-size:11px;color:var(--text)">〰 Follow line</span>
        </label>
      </div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:5px" id="rbDepthLabel">Depth band (ft)</div>
      <div style="display:flex;align-items:center;gap:6px">
        <input id="rbDepthMin" type="number" value="18" min="0" max="200" style="width:55px;padding:4px 6px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:12px;text-align:center">
        <span style="color:var(--muted);font-size:11px" id="rbDepthToLabel">to</span>
        <input id="rbDepthMax" type="number" value="28" min="0" max="200" style="width:55px;padding:4px 6px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:12px;text-align:center">
        <span style="color:var(--muted);font-size:11px">ft</span>
      </div>
    </div>

    <!-- Manual mode: start/end -->
    <div id="rbManualSection" style="margin-bottom:10px;display:none">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">Start / end points</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:4px">
        <input id="rbLat1" placeholder="Start lat" style="padding:4px 5px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:11px;width:100%;box-sizing:border-box">
        <input id="rbLon1" placeholder="Start lon" style="padding:4px 5px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:11px;width:100%;box-sizing:border-box">
      </div>
      <button id="rbPickStart" style="width:100%;height:26px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:11px;cursor:pointer;margin-bottom:6px">📍 Pick start on map</button>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:4px">
        <input id="rbLat2" placeholder="End lat" style="padding:4px 5px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:11px;width:100%;box-sizing:border-box">
        <input id="rbLon2" placeholder="End lon" style="padding:4px 5px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:11px;width:100%;box-sizing:border-box">
      </div>
      <button id="rbPickEnd" style="width:100%;height:26px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:11px;cursor:pointer;margin-bottom:6px">🏁 Pick end on map</button>
      <div style="display:flex;align-items:center;gap:6px">
        <label style="font-size:11px;color:var(--muted);white-space:nowrap">Lanes</label>
        <input id="rbLanes" type="number" value="4" min="1" max="20" style="width:55px;padding:4px 6px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:12px;text-align:center">
      </div>
    </div>

    <!-- Pattern (both modes) -->
    <div style="margin-bottom:10px">
      <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">Pattern</div>
      <select id="rbPattern" style="width:100%;padding:5px 7px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:12px;margin-bottom:8px">
        <option value="sine+straight">Sine + straight (recommended)</option>
        <option value="sine">Sine S-curves</option>
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

    <!-- Generate -->
    <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:5px;padding-top:8px;border-top:1px solid var(--line)">
      <button id="rbGenerate" style="height:32px;font-size:11px;font-weight:700;border:1px solid var(--line);border-radius:5px;background:var(--panel2);color:var(--text);cursor:pointer">⚡ Generate</button>
      <button id="rbCommit" style="height:32px;font-size:11px;font-weight:700;border:1px solid var(--line);border-radius:5px;background:var(--panel2);color:var(--text);cursor:pointer;display:none">✅ Commit</button>
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
}

function readCfg() {
  return {
    depthMin:   parseInt(document.getElementById('rbDepthMin')?.value)   || 18,
    depthMax:   parseInt(document.getElementById('rbDepthMax')?.value)   || 28,
    pattern:    document.getElementById('rbPattern')?.value || 'sine+straight',
    spacing:    parseFloat(document.getElementById('rbSpacing')?.value)   || 150,
    amplitude:  parseFloat(document.getElementById('rbAmplitude')?.value) || 30,
    wave:       300,
    straightFt: 350,
    lanes:      parseInt(document.getElementById('rbLanes')?.value) || 4,
    start:      [parseFloat(document.getElementById('rbLat1')?.value), parseFloat(document.getElementById('rbLon1')?.value)],
    end:        [parseFloat(document.getElementById('rbLat2')?.value), parseFloat(document.getElementById('rbLon2')?.value)],
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
  const key = state.ACTIVE_CONTOUR_KEY;
  if (!key || (!c?.smart && !c?.raw)) {
    el.style.color = 'var(--muted)';
    el.textContent = 'No contour dataset loaded — go to Contour Data tab';
    return;
  }
  const count = (c.smart?.features?.length || c.raw?.features?.length || 0).toLocaleString();
  const type = c.smart ? 'Smart' : 'Raw';
  el.style.color = 'var(--accent)';
  el.innerHTML = `<span style="font-weight:600">${esc(key)}</span><br><span style="color:var(--muted)">${type} · ${count} features</span>`;
}

function wireRouteBuilder() {
  // Source toggle
  document.querySelectorAll('input[name="rbSrc"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const isContour = document.getElementById('rbSrcContour')?.checked;
      document.getElementById('rbContourInfo').style.display  = isContour ? 'block' : 'none';
      document.getElementById('rbDepthSection').style.display = isContour ? 'block' : 'none';
      document.getElementById('rbManualSection').style.display = isContour ? 'none' : 'block';
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

  // Map point picking
  document.getElementById('rbPickStart')?.addEventListener('click', () => {
    pickingMode = 'start';
    setBanner('📍 Click map to set START point');
    window._rbPickMode = 'start';
  });
  document.getElementById('rbPickEnd')?.addEventListener('click', () => {
    pickingMode = 'end';
    setBanner('🏁 Click map to set END point');
    window._rbPickMode = 'end';
  });

  // Hook into map click for point picking
  // We do this by checking window._rbPickMode in a listener
  if (state.MAP) {
    state.MAP.on('click', (e) => {
      if (!window._rbPickMode) return;
      const { lat, lng } = e.latlng;
      if (window._rbPickMode === 'start') {
        const l1 = document.getElementById('rbLat1');
        const o1 = document.getElementById('rbLon1');
        if (l1) l1.value = lat.toFixed(5);
        if (o1) o1.value = lng.toFixed(5);
      } else if (window._rbPickMode === 'end') {
        const l2 = document.getElementById('rbLat2');
        const o2 = document.getElementById('rbLon2');
        if (l2) l2.value = lat.toFixed(5);
        if (o2) o2.value = lng.toFixed(5);
      }
      window._rbPickMode = null;
      setBanner('');
    });
  } else {
    // Map not ready yet, try again after init
    setTimeout(() => {
      state.MAP?.on('click', (e) => {
        if (!window._rbPickMode) return;
        const { lat, lng } = e.latlng;
        if (window._rbPickMode === 'start') {
          if (document.getElementById('rbLat1')) document.getElementById('rbLat1').value = lat.toFixed(5);
          if (document.getElementById('rbLon1')) document.getElementById('rbLon1').value = lng.toFixed(5);
        } else {
          if (document.getElementById('rbLat2')) document.getElementById('rbLat2').value = lat.toFixed(5);
          if (document.getElementById('rbLon2')) document.getElementById('rbLon2').value = lng.toFixed(5);
        }
        window._rbPickMode = null;
        setBanner('');
      });
    }, 2000);
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
      const el = document.getElementById('rbClipStatus');
      if (el) el.textContent = `Area set (${clipPolygon.length} points)`;
      setBanner('');
    });
  });

  document.getElementById('rbClearClip')?.addEventListener('click', () => {
    if (clipLayer) { state.MAP?.removeLayer(clipLayer); clipLayer = null; }
    clipPolygon = null;
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
      if (isNaN(cfg.start[0]) || isNaN(cfg.end[0])) {
        setStatus('Set start and end points first.', 'var(--bad)');
        return;
      }
      tracks = generateManualLanes(cfg);
    }

    pendingTracks = tracks;
    renderRoutes(tracks);
    setStatus(`Generated ${tracks.length} route(s). Commit to add to plan.`, 'var(--accent2)');
    document.getElementById('rbCommit').style.display = '';
  });

  // Commit
  document.getElementById('rbCommit')?.addEventListener('click', () => {
    if (!pendingTracks.length) return;
    state.DATA.tracks.push(...pendingTracks);
    pendingTracks = [];
    renderAll();
    document.getElementById('rbCommit').style.display = 'none';
    setStatus(`✅ ${state.DATA.tracks.length} track(s) in plan.`, 'var(--accent2)');
  });

  // Clear
  document.getElementById('rbClear')?.addEventListener('click', () => {
    if (routeLayer) { state.MAP?.removeLayer(routeLayer); routeLayer = null; }
    pendingTracks = [];
    document.getElementById('rbCommit').style.display = 'none';
    setStatus('');
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

  // Expose for waypoint popup "Set as Start/End Spot" buttons
  window.sendWptToRouteBuilder = (lat, lon, role) => {
    if (role === 'start') {
      const l = document.getElementById('rbLat1'); const o = document.getElementById('rbLon1');
      if (l) l.value = lat.toFixed(5); if (o) o.value = lon.toFixed(5);
    } else {
      const l = document.getElementById('rbLat2'); const o = document.getElementById('rbLon2');
      if (l) l.value = lat.toFixed(5); if (o) o.value = lon.toFixed(5);
    }
    // Switch to manual mode
    const manual = document.getElementById('rbSrcManual');
    if (manual) { manual.checked = true; manual.dispatchEvent(new Event('change')); }
  };

  // Legacy compatibility
  window.sendWptToGenerator = window.sendWptToRouteBuilder;
}

console.log('[route-builder] module ready');
