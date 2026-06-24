/**
 * Pinch Point Finder — analyzes vectorized depth contours to locate
 * underwater saddles, funnels, and ambush zones where predators stack.
 *
 * A "pinch point" is where contour lines narrow between two deeper areas —
 * the baitfish highway that stripers and bass ambush from both sides.
 *
 * Algorithm:
 *   1. For each depth band, find contour lines in the target range
 *   2. Build a grid of contour density (lines per 100m cell)
 *   3. Find local maxima in density = pinch zones
 *   4. Score by: density, depth transition sharpness, proximity to structure
 *   5. Output: markers on map with score and tactical description
 *
 * Requires: vectorized contours loaded via smart-route.js (activeGeoJSON)
 * or loaded independently here.
 */

import { state, CF_WORKER_URL } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { setBanner } from '../core/map-init.js';

let pinchLayer = null;
let pinchPanelOpen = false;
let localGeoJSON = null;  // contours loaded in this module

// ── Pinch detection algorithm ─────────────────────────────────────────────────

const GRID_CELL_M = 100;   // grid cell size in meters
const MIN_SCORE   = 3;     // minimum density score to flag as pinch point

function latToM(lat) { return lat * 111320; }
function lonToM(lon, lat) { return lon * 111320 * Math.cos(lat * Math.PI / 180); }
function mToLat(m) { return m / 111320; }
function mToLon(m, lat) { return m / (111320 * Math.cos(lat * Math.PI / 180)); }

/**
 * Build a 2D density grid over the contour lines.
 * Each cell counts how many contour line segments pass through it.
 */
function buildDensityGrid(features, bounds) {
  const { minLat, maxLat, minLon, maxLon } = bounds;
  const heightM = latToM(maxLat - minLat);
  const widthM  = lonToM(maxLon - minLon, (minLat + maxLat) / 2);
  const rows = Math.max(1, Math.ceil(heightM / GRID_CELL_M));
  const cols = Math.max(1, Math.ceil(widthM  / GRID_CELL_M));

  // Initialize grid
  const grid = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ count: 0, depths: [] }))
  );

  for (const feat of features) {
    const coords = feat.geometry.coordinates; // [lon, lat] pairs
    const depth = feat.properties?.depth_ft || 0;

    for (let i = 0; i < coords.length - 1; i++) {
      const [lon1, lat1] = coords[i];
      const [lon2, lat2] = coords[i + 1];
      const midLat = (lat1 + lat2) / 2;
      const midLon = (lon1 + lon2) / 2;

      // Map to grid cell
      const rFrac = (maxLat - midLat) / (maxLat - minLat);
      const cFrac = (midLon - minLon) / (maxLon - minLon);
      const r = Math.min(rows - 1, Math.max(0, Math.floor(rFrac * rows)));
      const c = Math.min(cols - 1, Math.max(0, Math.floor(cFrac * cols)));

      grid[r][c].count++;
      if (!grid[r][c].depths.includes(depth)) grid[r][c].depths.push(depth);
    }
  }

  return { grid, rows, cols, bounds };
}

/**
 * Find local maxima in the density grid.
 * A cell is a pinch point if its count is >= MIN_SCORE and higher than
 * all 8 neighbors.
 */
function findPinchPoints(gridData, targetDepthMin, targetDepthMax) {
  const { grid, rows, cols, bounds } = gridData;
  const { minLat, maxLat, minLon, maxLon } = bounds;
  const pinches = [];

  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const cell = grid[r][c];
      if (cell.count < MIN_SCORE) continue;

      // Check if local maximum
      let isMax = true;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          if (grid[r+dr][c+dc].count > cell.count) { isMax = false; break; }
        }
        if (!isMax) break;
      }
      if (!isMax) continue;

      // Check depth range overlap
      const hasTargetDepth = cell.depths.some(d => d >= targetDepthMin && d <= targetDepthMax);
      const depthRange = cell.depths.length;

      // Calculate center lat/lon of this cell
      const rFrac = (r + 0.5) / rows;
      const cFrac = (c + 0.5) / cols;
      const lat = maxLat - rFrac * (maxLat - minLat);
      const lon = minLon + cFrac * (maxLon - minLon);

      // Score: density × depth variety × target match
      const score = Math.round(cell.count * (hasTargetDepth ? 1.5 : 1.0) * Math.min(3, depthRange));

      pinches.push({
        lat, lon,
        score,
        density: cell.count,
        depths: [...cell.depths].sort((a, b) => a - b),
        hasTargetDepth,
        row: r, col: c,
      });
    }
  }

  // Sort by score descending
  return pinches.sort((a, b) => b.score - a.score);
}

/**
 * Generate a tactical description for a pinch point.
 */
function describePinch(pinch, targetMin, targetMax) {
  const depths = pinch.depths;
  const minD = depths[0];
  const maxD = depths[depths.length - 1];
  const hasTarget = pinch.hasTargetDepth;

  const parts = [];

  if (depths.length >= 3) {
    parts.push(`${depths.length}-depth contour convergence`);
  } else if (depths.length === 2) {
    parts.push(`Depth transition ${minD}→${maxD}ft`);
  } else {
    parts.push(`${minD}ft contour concentration`);
  }

  if (hasTarget) {
    parts.push(`✅ In your target zone (${targetMin}-${targetMax}ft)`);
  }

  if (maxD - minD >= 15) {
    parts.push('Sharp drop-off — predator ambush staging area');
  } else if (maxD - minD >= 8) {
    parts.push('Moderate depth change — good ledge structure');
  }

  if (pinch.density >= 10) {
    parts.push('High contour density — likely a saddle or underwater hump');
  } else if (pinch.density >= 6) {
    parts.push('Notable contour pinch — funnel point');
  }

  return parts.join('. ');
}

// ── Map rendering ─────────────────────────────────────────────────────────────

function renderPinchPoints(pinches, targetMin, targetMax) {
  if (!state.MAP_OK) return;
  if (pinchLayer) state.MAP.removeLayer(pinchLayer);
  pinchLayer = L.layerGroup();

  const top = Math.min(pinches.length, 20); // show top 20
  pinches.slice(0, top).forEach((p, i) => {
    const rank = i + 1;
    const isTarget = p.hasTargetDepth;
    const bgColor = isTarget ? '#76ff03' : '#ffb703';
    const txColor = '#000';
    const size = Math.max(18, Math.min(32, 14 + p.score));

    const marker = L.marker([p.lat, p.lon], {
      icon: L.divIcon({
        className: '',
        html: `<div style="
          background:${bgColor};color:${txColor};
          font-size:${Math.round(size * 0.55)}px;font-weight:800;
          width:${size}px;height:${size}px;
          border-radius:50%;border:2px solid rgba(0,0,0,0.4);
          display:flex;align-items:center;justify-content:center;
          box-shadow:0 2px 8px rgba(0,0,0,0.6);cursor:pointer;
          font-family:system-ui,sans-serif
        ">${rank}</div>`,
        iconAnchor: [size/2, size/2],
      }),
    });

    const depthStr = p.depths.join(', ') + ' ft';
    const scoreBar = '█'.repeat(Math.min(10, Math.round(p.score / 2)));
    const desc = describePinch(p, targetMin, targetMax);

    marker.bindPopup(`
      <div style="font-size:13px;min-width:200px">
        <b style="color:#76ff03">🎯 Pinch Point #${rank}</b>
        <div style="margin:4px 0;font-size:11px;color:#aaa">Score: <b style="color:#76ff03">${p.score}</b> ${scoreBar}</div>
        <div style="font-size:11px"><b>Depths:</b> ${depthStr}</div>
        <div style="font-size:11px"><b>Density:</b> ${p.density} contour segments</div>
        <hr style="border-color:#333;margin:6px 0">
        <div style="font-size:11px;color:#ccc">${esc(desc)}</div>
        <button onclick="window.sendWptToGenerator?.(${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}, 'start')"
          style="margin-top:8px;padding:3px 10px;background:#76ff03;color:#000;border:none;font-weight:700;font-size:11px;cursor:pointer;border-radius:3px">
          → Set as route start
        </button>
      </div>
    `);

    pinchLayer.addLayer(marker);
  });

  pinchLayer.addTo(state.MAP);
  return top;
}

// ── Panel ─────────────────────────────────────────────────────────────────────

function buildPanel() {
  const existing = document.getElementById('pinchPanel');
  if (existing) return existing;

  const panel = document.createElement('div');
  panel.id = 'pinchPanel';
  panel.style.cssText = `
    display:none;position:absolute;bottom:60px;right:8px;z-index:650;
    background:rgba(11,22,35,.96);border:1px solid #76ff03;
    border-radius:10px;padding:12px 14px;font-size:12px;width:280px;
    box-shadow:0 4px 20px rgba(0,0,0,.7);
  `;
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <span style="color:#76ff03;font-weight:700;font-size:13px">🎯 Pinch Point Finder</span>
      <button id="ppClose" style="background:none;border:none;color:var(--muted);font-size:15px;cursor:pointer">✕</button>
    </div>
    <div style="color:var(--muted);font-size:10px;margin-bottom:8px">
      Finds underwater saddles, funnels, and ambush zones from vectorized contours.
      Load contours via Smart Route first, or upload here.
    </div>
    <div style="margin-bottom:8px">
      <label style="color:var(--muted);font-size:10px;display:block;margin-bottom:3px">TARGET DEPTH RANGE (ft)</label>
      <div style="display:flex;gap:6px;align-items:center">
        <input id="ppDepthMin" type="number" value="18" min="1" max="200"
          style="width:55px;background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:4px;font-size:12px">
        <span style="color:var(--muted)">to</span>
        <input id="ppDepthMax" type="number" value="28" min="1" max="200"
          style="width:55px;background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:4px;font-size:12px">
        <span style="color:var(--muted);font-size:10px">ft</span>
      </div>
    </div>
    <button id="ppFind" class="small primary" style="width:100%;background:#76ff03;color:#000;font-weight:700;margin-bottom:8px">🔍 Find Pinch Points</button>
    <div id="ppStatus" style="font-size:11px;color:var(--muted)"></div>
    <button id="ppClear" class="small" style="width:100%;margin-top:6px;display:none;color:var(--bad);border-color:var(--bad)">✕ Clear markers</button>
  `;
  document.getElementById('panel-map')?.appendChild(panel);
  return panel;
}

function ppSetStatus(msg, isErr = false) {
  const el = document.getElementById('ppStatus');
  if (el) { el.textContent = msg; el.style.color = isErr ? 'var(--bad)' : 'var(--muted)'; }
}

async function runPinchFinder() {
  // Try to use contours from smart-route module first, then fall back to own load
  const geojson = localGeoJSON || window._smartRouteGeoJSON;
  if (!geojson || !geojson.features?.length) {
    ppSetStatus('No contours loaded. Use Smart Route panel to load contours first.', true);
    return;
  }

  const minFt = parseInt(document.getElementById('ppDepthMin')?.value) || 18;
  const maxFt = parseInt(document.getElementById('ppDepthMax')?.value) || 28;
  ppSetStatus('Analyzing contour density...');

  // Calculate bounds
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const feat of geojson.features) {
    for (const [lon, lat] of feat.geometry.coordinates) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }

  if (!isFinite(minLat)) {
    ppSetStatus('Could not determine contour bounds', true);
    return;
  }

  const gridData = buildDensityGrid(geojson.features, { minLat, maxLat, minLon, maxLon });
  const pinches  = findPinchPoints(gridData, minFt, maxFt);

  if (!pinches.length) {
    ppSetStatus('No pinch points detected — try widening the depth range', true);
    return;
  }

  const shown = renderPinchPoints(pinches, minFt, maxFt);
  ppSetStatus(`✅ Found ${pinches.length} pinch points, showing top ${shown}`);

  const clearBtn = document.getElementById('ppClear');
  if (clearBtn) clearBtn.style.display = '';
}

function init() {
  const panel = buildPanel();

  document.getElementById('btnPinchFinder')?.addEventListener('click', () => {
    pinchPanelOpen = !pinchPanelOpen;
    panel.style.display = pinchPanelOpen ? 'block' : 'none';
  });
  document.getElementById('ppClose')?.addEventListener('click', () => {
    panel.style.display = 'none';
    pinchPanelOpen = false;
  });
  document.getElementById('ppFind')?.addEventListener('click', runPinchFinder);
  document.getElementById('ppClear')?.addEventListener('click', () => {
    if (pinchLayer) { state.MAP?.removeLayer(pinchLayer); pinchLayer = null; }
    ppSetStatus('');
    document.getElementById('ppClear').style.display = 'none';
  });
}

setTimeout(init, 1600);
console.log('✓ Pinch Point Finder armed');
