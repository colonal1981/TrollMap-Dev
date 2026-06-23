/**
 * Trolling Lane Generator — the Generate tab.
 *
 * Two modes:
 *
 *   1. Start / End mode
 *      Enter a start and end coordinate, pick a lane spacing and
 *      count, and the generator builds N parallel lanes between them
 *      using your choice of pattern (straight / s-curve / zigzag /
 *      s-curve+straight / zigzag+straight).
 *
 *   2. Waypoint-lane mode
 *      Name your existing waypoints with the LN<n> convention (e.g.
 *      "LN1_001", "LN1_002", "LN2_001") and the generator builds one
 *      track per lane group.
 *
 * Both modes use a `pick on the map` helper to set start/end coords.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { distFt } from '../utils/geo.js';
import { setBanner, showPreview, clearPreview, renderAll, getFilename, setFilename } from '../core/map-init.js';

// ── Math helpers ─────────────────────────────────────────────────────────

/** Great-circle distance + bearing from point 1 to point 2. */
function tmDistBearing(lat1, lon1, lat2, lon2) {
  const R = 20902231, D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dp = (lat2 - lat1) * D2R, dl = (lon2 - lon1) * D2R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return [dist, (Math.atan2(y, x) * R2D + 360) % 360];
}

/** Destination point given a start, bearing (deg), and distance (ft). */
function tmDestination(lat, lon, bearingDeg, distFt) {
  const R = 20902231, D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const br = bearingDeg * D2R, lr = lat * D2R, d = distFt / R;
  const lat2 = Math.asin(Math.sin(lr) * Math.cos(d) + Math.cos(lr) * Math.sin(d) * Math.cos(br));
  const lon2 = lon * D2R + Math.atan2(
    Math.sin(br) * Math.sin(d) * Math.cos(lr),
    Math.cos(d) - Math.sin(lr) * Math.sin(lat2),
  );
  return [lat2 * R2D, lon2 * R2D];
}

// ── Start / end mode ──────────────────────────────────────────────────────

/**
 * Generate `cfg.lanes` parallel lanes from start to end using the
 * chosen pattern. Returns { tracks, wpts }.
 */
export function generateTroll(cfg) {
  const tracks = [], wpts = [];
  const lat0 = cfg.start[0];
  const dLat = cfg.end[0] - cfg.start[0];
  const dLon = cfg.end[1] - cfg.start[1];
  const baseLenFt = distFt(cfg.start, cfg.end);
  if (baseLenFt < 1) return { tracks, wpts };

  const angle = Math.atan2(dLon * Math.cos(lat0 * Math.PI / 180), dLat);
  const perpAngle = angle + Math.PI / 2;
  const dLatPerFt = Math.cos(perpAngle) / 364000;
  const dLonPerFt = Math.sin(perpAngle) / (364000 * Math.cos(lat0 * Math.PI / 180));
  const ptsPerLane = Math.max(3, cfg.ptsPerLane || 40);
  const cycles = baseLenFt / (cfg.sWave || 300);
  const connected = cfg.connect === 'yes';
  const allPts = [];

  for (let i = 0; i < cfg.lanes; i++) {
    const off = i * cfg.spacing;
    const offLat = off * dLatPerFt;
    const offLon = off * dLonPerFt;
    const lanePts = [];

    for (let j = 0; j <= ptsPerLane; j++) {
      const t = j / ptsPerLane;
      let lat = cfg.start[0] + t * dLat + offLat;
      let lon = cfg.start[1] + t * dLon + offLon;

      if (cfg.pattern === 's-curve') {
        const phase = t * cycles * 2 * Math.PI;
        const amp = cfg.sAmp || 30;
        lat += amp * dLatPerFt * Math.sin(phase);
        lon += amp * dLonPerFt * Math.sin(phase);
      } else if (cfg.pattern === 'zigzag') {
        const amp = cfg.sAmp || 30;
        const phase = (t * cycles * 2) % 2;
        const z = phase < 1 ? phase : 2 - phase;
        lat += amp * dLatPerFt * z;
        lon += amp * dLonPerFt * z;
      }
      lanePts.push([lat, lon]);
    }

    const laneName = `${cfg.lakeCode}L${i + 1}`;
    let ptsForTrack = lanePts;

    if (connected) {
      if (i % 2 === 1) ptsForTrack = lanePts.slice().reverse();
      if (i > 0) {
        const prev = allPts[allPts.length - 1];
        const next = ptsForTrack[0];
        const mid = [(prev[0] + next[0]) / 2, (prev[1] + next[1]) / 2];
        allPts.push(mid);
      }
      allPts.push(...ptsForTrack);
    } else {
      tracks.push({ name: laneName, pts: lanePts });
    }

    wpts.push({ lat: ptsForTrack[0][0], lon: ptsForTrack[0][1], name: `${laneName}T1`, sym: 'Waypoint' });
    wpts.push({ lat: ptsForTrack[ptsForTrack.length - 1][0], lon: ptsForTrack[ptsForTrack.length - 1][1], name: `${laneName}T${ptsPerLane}`, sym: 'Waypoint' });
  }

  if (connected && allPts.length > 1) {
    tracks.push({ name: `${cfg.lakeCode}Connected`, pts: allPts });
  }
  return { tracks, wpts };
}

// ── Waypoint-lane mode ────────────────────────────────────────────────────

/**
 * Group existing waypoints by the lane index extracted from their
 * name. Lane index is parsed from:
 *   - "LN<n>"      (e.g. LN1_001, LN1, LN2)
 *   - "L<n>"       (e.g. L1, L2_001)
 *   - "L<n>_…"
 *
 * Returns { laneIndex: [{lat, lon, name, order, idx}, ...] }
 */
function groupWaypointLanes() {
  const lanes = {};
  state.DATA.waypoints.forEach((w, idx) => {
    const name = String(w.name || '');
    const m = name.match(/LN\s*(\d+)/i)
            || name.match(/\bL\s*(\d+)\b/i)
            || name.match(/(?:^|[^A-Z])L(\d+)[_\- ]/i);
    if (!m) return;
    const lane = String(parseInt(m[1], 10));
    const nums = (name.match(/\d+/g) || []).map(Number);
    const order = nums.length ? nums[nums.length - 1] : idx;
    (lanes[lane] = lanes[lane] || []).push({ lat: +w.lat, lon: +w.lon, name, order, idx });
  });
  Object.keys(lanes).forEach((k) => lanes[k].sort((a, b) => a.order - b.order || a.idx - b.idx));
  return lanes;
}

/** Generate a straight line of points between two coords. */
function genSegStraight(a, b, cfg) {
  const [dist, brng] = tmDistBearing(a.lat, a.lon, b.lat, b.lon);
  const n = Math.max(1, Math.ceil(dist / Math.max(50, cfg.ptsPerLane ? dist / cfg.ptsPerLane : 120)));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(tmDestination(a.lat, a.lon, brng, dist * i / n));
  return pts;
}

/** Generate a sine-wave weave between two coords. */
function genSegSine(a, b, cfg) {
  const [dist, brng] = tmDistBearing(a.lat, a.lon, b.lat, b.lon);
  if (dist < 1) return [];
  const n = Math.max(8, Math.ceil((dist / Math.max(20, cfg.sWave)) * 16));
  const perp = (brng + 90) % 360;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const c = tmDestination(a.lat, a.lon, brng, dist * t);
    const off = Math.sin((2 * Math.PI * dist * t) / Math.max(20, cfg.sWave)) * cfg.sAmp;
    pts.push(tmDestination(c[0], c[1], perp, off));
  }
  return pts;
}

/** Generate a zigzag between two coords. */
function genSegZigzag(a, b, cfg) {
  const [dist, brng] = tmDistBearing(a.lat, a.lon, b.lat, b.lon);
  if (dist < 1) return [];
  const step = Math.max(20, cfg.sWave / 2);
  const n = Math.max(1, Math.ceil(dist / step));
  const perp = (brng + 90) % 360;
  const pts = [[a.lat, a.lon]];
  let dir = 1;
  for (let i = 1; i < n; i++) {
    const c = tmDestination(a.lat, a.lon, brng, dist * i / n);
    pts.push(tmDestination(c[0], c[1], perp, cfg.sAmp * dir));
    dir *= -1;
  }
  pts.push([b.lat, b.lon]);
  return pts;
}

/** Generate an alternating straight + curve (sine or zigzag) between two coords. */
function genSegMixed(a, b, cfg, curveFn) {
  const [dist, brng] = tmDistBearing(a.lat, a.lon, b.lat, b.lon);
  if (dist < 1) return [];
  const pts = [[a.lat, a.lon]];
  let cursor = 0;
  while (cursor < dist) {
    const endS = Math.min(cursor + cfg.straightFt, dist);
    const s = tmDestination(a.lat, a.lon, brng, cursor);
    const e = tmDestination(a.lat, a.lon, brng, endS);
    const straight = genSegStraight({ lat: s[0], lon: s[1] }, { lat: e[0], lon: e[1] }, cfg);
    pts.push(...straight.slice(1));
    cursor = endS;
    if (cursor >= dist) break;
    const endC = Math.min(cursor + cfg.sWave, dist);
    const cs = tmDestination(a.lat, a.lon, brng, cursor);
    const ce = tmDestination(a.lat, a.lon, brng, endC);
    const cur = curveFn({ lat: cs[0], lon: cs[1] }, { lat: ce[0], lon: ce[1] }, cfg);
    pts.push(...cur.slice(1));
    cursor = endC;
  }
  return pts;
}

/** Build one track per waypoint-lane group using the configured pattern. */
export function buildWaypointLaneTracks(cfg) {
  const lanes = groupWaypointLanes();
  const keys = Object.keys(lanes).map(Number).sort((a, b) => a - b).map(String);
  const tracks = [];

  keys.forEach((k) => {
    const raw = lanes[k];
    if (raw.length < 2) return;
    const pts = [];
    for (let i = 0; i < raw.length - 1; i++) {
      const a = raw[i], b = raw[i + 1];
      let seg;
      if (cfg.pattern === 'straight')            seg = genSegStraight(a, b, cfg);
      else if (cfg.pattern === 'zigzag')        seg = genSegZigzag(a, b, cfg);
      else if (cfg.pattern === 's-straight')    seg = genSegMixed(a, b, cfg, genSegSine);
      else if (cfg.pattern === 'z-straight')    seg = genSegMixed(a, b, cfg, genSegZigzag);
      else                                       seg = genSegSine(a, b, cfg);
      if (i > 0) seg = seg.slice(1);
      pts.push(...seg);
    }
    if (pts.length > 1) tracks.push({ name: `${cfg.lakeCode || 'LN'}L${k}`, pts });
  });

  return { tracks, laneCount: keys.length, usableCount: tracks.length };
}

// ── UI helpers ───────────────────────────────────────────────────────────

/** Read the current generator form values into a config object. */
export function readGenCfg() {
  return {
    lakeCode: document.getElementById('gLake')?.value.trim() || 'UNK',
    start: [parseFloat(document.getElementById('gLat1')?.value), parseFloat(document.getElementById('gLon1')?.value)],
    end:   [parseFloat(document.getElementById('gLat2')?.value), parseFloat(document.getElementById('gLon2')?.value)],
    lanes: parseInt(document.getElementById('gLanes')?.value) || 1,
    spacing: parseFloat(document.getElementById('gSpacing')?.value) || 150,
    ptsPerLane: parseInt(document.getElementById('gPts')?.value) || 40,
    pattern: document.getElementById('gPattern')?.value,
    sAmp: parseFloat(document.getElementById('gAmp')?.value) || 30,
    sWave: parseFloat(document.getElementById('gWave')?.value) || 300,
    straightFt: parseFloat(document.getElementById('gStraight')?.value) || 350,
    connect: document.getElementById('gConnect')?.value,
  };
}

function setGenMsg(s, ok) {
  const el = document.getElementById('gMsg');
  if (!el) return;
  el.innerHTML = ok ? `<div class="okbox">${esc(s)}</div>` : `<div class="warnbox">${esc(s)}</div>`;
}

// ── Wire buttons ─────────────────────────────────────────────────────────

function wireButtons() {
  document.getElementById('gPickStart')?.addEventListener('click', () => {
    window.pickTarget = { field: 'start' };
    setBanner('Click map to set START point');
  });
  document.getElementById('gPickEnd')?.addEventListener('click', () => {
    window.pickTarget = { field: 'end' };
    setBanner('Click map to set END point');
  });

  document.getElementById('gPreview')?.addEventListener('click', () => {
    const cfg = readGenCfg();
    if (isNaN(cfg.start[0]) || isNaN(cfg.start[1]) || isNaN(cfg.end[0]) || isNaN(cfg.end[1])) {
      setGenMsg('Enter start and end coordinates, or pick on map.');
      return;
    }
    const { tracks } = generateTroll(cfg);
    showPreview(tracks);
    setGenMsg(`Preview: ${tracks.length} track(s) shown.`, true);
  });

  document.getElementById('gPreviewWpt')?.addEventListener('click', () => {
    const cfg = readGenCfg();
    const { tracks, laneCount, usableCount } = buildWaypointLaneTracks(cfg);
    if (!laneCount) {
      setGenMsg('No waypoint lanes found. Rename guide waypoints like LN1_001, LN1_002, LN2_001, etc.');
      return;
    }
    if (!tracks.length) {
      setGenMsg(`Found ${laneCount} lane group(s), but none had at least 2 points.`);
      return;
    }
    showPreview(tracks);
    setGenMsg(`Preview from waypoint lanes: ${usableCount} track(s) shown. Pattern: ${cfg.pattern}.`, true);
  });

  document.getElementById('gClearPreview')?.addEventListener('click', () => {
    clearPreview();
    setGenMsg('Preview cleared.');
  });

  document.getElementById('gCommit')?.addEventListener('click', () => {
    const cfg = readGenCfg();
    if (isNaN(cfg.start[0]) || isNaN(cfg.start[1])) { setGenMsg('Need start coordinates.'); return; }
    const { tracks, wpts } = generateTroll(cfg);
    state.DATA.tracks.push(...tracks);
    state.DATA.waypoints.push(...wpts);
    clearPreview();
    renderAll();
    setGenMsg(`Committed ${tracks.length} track(s), ${wpts.length} waypoints.`, true);
    const fl = document.getElementById('fileLabel');
    if (fl) fl.textContent = `${getFilename()} — ${state.DATA.waypoints.length} wpts, ${state.DATA.tracks.length} tracks`;
  });

  document.getElementById('gCommitWpt')?.addEventListener('click', () => {
    const cfg = readGenCfg();
    const { tracks, laneCount, usableCount } = buildWaypointLaneTracks(cfg);
    if (!laneCount) {
      setGenMsg('No waypoint lanes found. Rename guide waypoints like LN1_001, LN1_002, LN2_001, etc.');
      return;
    }
    if (!tracks.length) {
      setGenMsg(`Found ${laneCount} lane group(s), but none had at least 2 points.`);
      return;
    }
    state.DATA.tracks.push(...tracks);
    clearPreview();
    renderAll();
    setGenMsg(`Committed ${usableCount} waypoint-lane trolling track(s). Export GPX when ready.`, true);
    const fl = document.getElementById('fileLabel');
    if (fl) fl.textContent = `${getFilename()} — ${state.DATA.waypoints.length} wpts, ${state.DATA.tracks.length} tracks`;
  });
}

wireButtons();
