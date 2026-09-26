/**
 * Edit tab — table-based view of waypoints + tracks with inline
 * editing, selection, deletion, bulk rename, dedupe, and the
 * "connect selected → track" + "curve selected → S-curve" helpers.
 *
 * Also includes the S-curve reconstruction tool (recoverBtn):
 * given a series of CODE+L#T# waypoints, build a smoothed track
 * that approximates the original lane centerline.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { movingAvg, resample } from '../utils/geo.js';
import { renderMap, renderAll } from '../core/map-init.js';

// ── Tables ────────────────────────────────────────────────────────────────

/**
 * Render the waypoint + track tables in the Edit tab. Wires up
 * inline editing so each input change immediately updates DATA
 * and re-renders the map.
 */
export function renderEditTables() {
  const host = document.getElementById('editTables');
  if (!host) return;
  if (!state.DATA.waypoints.length && !state.DATA.tracks.length) {
    host.innerHTML = '<p class="muted">No data yet.</p>';
    return;
  }

  let html = `<h3 style="color:var(--accent)">Waypoints (${state.DATA.waypoints.length})</h3>`;
  html += `<table><thead><tr><th>✓</th><th>Name</th><th>Symbol</th><th>Lat</th><th>Lon</th></tr></thead><tbody>`;
  state.DATA.waypoints.forEach((w, i) => {
    html += `<tr>
      <td><input type="checkbox" data-sel="${i}"></td>
      <td><input value="${esc(w.name || '')}" data-wn="${i}"></td>
      <td><input value="${esc(w.sym || '')}" data-ws="${i}"></td>
      <td><input type="number" step="0.00001" value="${w.lat.toFixed(5)}" data-wlat="${i}" style="width:90px"></td>
      <td><input type="number" step="0.00001" value="${w.lon.toFixed(5)}" data-wlon="${i}" style="width:90px"></td>
    </tr>`;
  });
  html += `</tbody></table>`;

  html += `<h3 style="color:var(--accent);margin-top:18px">Tracks (${state.DATA.tracks.length})</h3>`;
  html += `<table><thead><tr><th>Name</th><th>Points</th><th></th></tr></thead><tbody>`;
  state.DATA.tracks.forEach((t, i) => {
    html += `<tr>
      <td><input value="${esc(t.name || '')}" data-tn="${i}"></td>
      <td class="muted">${t.pts.length}</td>
      <td><button data-tdel="${i}">🗑️</button></td>
    </tr>`;
  });
  html += `</tbody></table>`;

  host.innerHTML = html;

  host.querySelectorAll('[data-wn]').forEach((el) => el.addEventListener('input', (e) => {
    state.DATA.waypoints[+e.target.dataset.wn].name = e.target.value;
    renderMap();
  }));
  host.querySelectorAll('[data-ws]').forEach((el) => el.addEventListener('input', (e) => {
    state.DATA.waypoints[+e.target.dataset.ws].sym = e.target.value;
  }));
  host.querySelectorAll('[data-wlat]').forEach((el) => el.addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v)) { state.DATA.waypoints[+e.target.dataset.wlat].lat = v; renderMap(); }
  }));
  host.querySelectorAll('[data-wlon]').forEach((el) => el.addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v)) { state.DATA.waypoints[+e.target.dataset.wlon].lon = v; renderMap(); }
  }));
  host.querySelectorAll('[data-tn]').forEach((el) => el.addEventListener('input', (e) => {
    state.DATA.tracks[+e.target.dataset.tn].name = e.target.value;
  }));
  host.querySelectorAll('[data-tdel]').forEach((el) => el.addEventListener('click', (e) => {
    state.DATA.tracks.splice(+e.target.dataset.tdel, 1);
    renderAll();
  }));
}

// ── Connect / curve selected waypoints ───────────────────────────────────
// connectSelectedWaypoints() and curveSelectedWaypoints() (with its S-curve builder) stood here,
// bound to #connectSelBtn and #curveSelBtn. Neither button is in index.html; both went on
// 2026-09-25.

// ── Delete selected ──────────────────────────────────────────────────────

function deleteSelectedWaypoints() {
  const sel = [...document.querySelectorAll('[data-sel]:checked')].map((c) => +c.dataset.sel).sort((a, b) => b - a);
  if (!sel.length) { alert('No waypoints checked'); return; }
  sel.forEach((i) => state.DATA.waypoints.splice(i, 1));
  renderAll();
}

function setAllEditCheckboxes(checked) {
  document.querySelectorAll('#editTables [data-sel]').forEach((c) => {
    if (c.type === 'checkbox') c.checked = checked;
  });
}

// ── Bulk rename + dedupe ──────────────────────────────────────────────────

function bulkPrefixRename() {
  const find = prompt('Find leading prefix:');
  if (find === null) return;
  const repl = prompt(`Replace "${find}" with:`);
  if (repl === null) return;
  let n = 0;
  state.DATA.waypoints.forEach((w) => {
    if (w.name && w.name.startsWith(find)) {
      w.name = repl + w.name.slice(find.length);
      n++;
    }
  });
  alert(`Renamed ${n} waypoints`);
  renderAll();
}

function dedupeWaypoints() {
  const seen = new Set();
  const before = state.DATA.waypoints.length;
  state.DATA.waypoints = state.DATA.waypoints.filter((w) => {
    const k = `${w.name}|${w.lat.toFixed(6)}|${w.lon.toFixed(6)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  alert(`Removed ${before - state.DATA.waypoints.length} duplicates`);
  renderAll();
}

// ── Centerline recovery from S-curve waypoints ──────────────────────────

function toggleRecoverCard() {
  const card = document.getElementById('recoverCard');
  card.style.display = card.style.display === 'none' ? 'block' : 'none';
}

function runCenterlineRecovery() {
  const code = document.getElementById('recCode')?.value.trim().toUpperCase();
  const win = parseInt(document.getElementById('recWindow')?.value) || 3;
  const keep = parseFloat(document.getElementById('recKeep')?.value) || 0.45;
  const lanes = {};

  state.DATA.waypoints.forEach((w) => {
    const m = (w.name || '').match(/^([A-Za-z]+?)L?(\d+)T(\d+)$/i);
    if (!m) return;
    const c = m[1].toUpperCase();
    if (code && c !== code && !c.startsWith(code)) return;
    const key = `${c}|${m[2]}`;
    (lanes[key] = lanes[key] || []).push([parseInt(m[3]), [w.lat, w.lon]]);
  });

  const keys = Object.keys(lanes);
  if (!keys.length) {
    document.getElementById('recoverMsg').innerHTML = '<div class="warnbox">No CODE+L#T# waypoints found.</div>';
    return;
  }

  let added = 0;
  keys.forEach((k) => {
    const pts = lanes[k].sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    if (pts.length < 2) return;
    const rec = resample(movingAvg(pts, win), keep);
    state.DATA.tracks.push({ name: `RECOVERED ${k.replace('|', ' L')}`, pts: rec });
    added++;
  });

  document.getElementById('recoverMsg').innerHTML = `<div class="okbox">Recovered ${added} lane centerline(s) into tracks.</div>`;
  renderAll();
}

// ── Wire buttons ─────────────────────────────────────────────────────────

function wireButtons() {
  document.getElementById('delSelBtn')?.addEventListener('click', deleteSelectedWaypoints);
  document.getElementById('selectAllWptBtn')?.addEventListener('click', () => setAllEditCheckboxes(true));
  document.getElementById('deselectAllWptBtn')?.addEventListener('click', () => setAllEditCheckboxes(false));
  document.getElementById('bulkPrefixBtn')?.addEventListener('click', bulkPrefixRename);
  document.getElementById('dedupeBtn')?.addEventListener('click', dedupeWaypoints);
  document.getElementById('recoverBtn')?.addEventListener('click', toggleRecoverCard);
  document.getElementById('runRecoverBtn')?.addEventListener('click', runCenterlineRecovery);
}

wireButtons();
