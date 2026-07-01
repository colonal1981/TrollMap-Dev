/**
 * Worker-backed Lake / Access dropdowns in the map toolbar.
 *
 * Populates #lakeSelect and #rampSelect from the Cloudflare Worker access-data
 * routes instead of the legacy hard-coded LAKE_DB / TRISTATE_MASTER_RAMPS files.
 *
 * Sources pulled from the worker:
 *   /ramps       — boat ramps
 *   /paddle      — kayak / paddle launches
 *   /bank-pier   — bank and pier fishing access
 *   /attractors  — fish attractors
 *
 * This module intentionally does NOT import ../data/lakes.js or ../data/ramps.js.
 * Mixing those old curated/static lists with the worker data was causing duplicate
 * lake and launch entries after the worker routes became authoritative.
 */

import { state } from '../core/state.js';

const STATES = ['SC', 'NC', 'GA'];
const ACCESS_SOURCES = [
  { path: '/ramps', label: 'Boat ramp', marker: '🛥️' },
  { path: '/paddle', label: 'Kayak / paddle launch', marker: '🛶' },
  { path: '/bank-pier', label: 'Bank / pier fishing', marker: '🎣' },
  { path: '/attractors', label: 'Fish attractor', marker: '◆' },
];

let accessIndexPromise = null;
let accessIndex = {
  lakeNames: [],
  byLake: new Map(),
};

// ── Worker URL helpers ──────────────────────────────────────────────────

function getWorkerBase() {
  // Prefer an app-provided worker URL if one exists. On GitHub Pages there is
  // no same-origin /ramps route, so same-origin gives 404s like:
  //   https://colonal1981.github.io/TrollMap-Dev/ramps?state=SC
  // Default to the deployed Cloudflare Worker instead.
  const explicit =
    window.TROLLMAP_WORKER_URL ||
    window.TROLLMAP_WORKER_BASE ||
    window.WORKER_URL ||
    window.API_BASE ||
    'https://trollmap-worker.colonal1981.workers.dev';
  return String(explicit || '').replace(/\/$/, '');
}

function workerUrl(path, stateCode) {
  return `${getWorkerBase()}${path}?state=${encodeURIComponent(stateCode)}`;
}

// ── Normalization / dedupe helpers ───────────────────────────────────────

function normalizeWaterbodyName(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .replace(/\b(reservoir|lake)\s+lake\b/ig, 'Lake')
    .trim();
}

function displayLakeName(rawName, stateCode) {
  const name = normalizeWaterbodyName(rawName);
  if (!name || /^unknown/i.test(name)) return '';

  // If the official data already carries state context, keep it as-is.
  if (/\b(SC|NC|GA|AL|VA)\b/.test(name)) return name;

  // Do not force state suffixes for rivers/coastal waterways; for lakes, a
  // suffix helps distinguish same-named waterbodies while remaining readable.
  if (/\blake\b|\breservoir\b/i.test(name)) return `${name}, ${stateCode}`;
  return name;
}

function normalizeNameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(boat ramp|ramp|landing|access area|access|launch|public|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function coordKey(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  // ~35-40 ft buckets: tight enough to merge the same site from different
  // layers without collapsing genuinely separate access points in one park.
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

function accessDedupeKey(item) {
  const cKey = coordKey(item.lat, item.lon);
  const nKey = normalizeNameKey(item.name);
  if (cKey && nKey) return `${cKey}|${nKey}`;
  return cKey || nKey;
}

function formatAccessLabel(item) {
  const prefix = item.marker ? `${item.marker} ` : '';
  return `${prefix}${item.name}${item.typeLabel ? ` — ${item.typeLabel}` : ''}`;
}

function addAccessItem(index, lakeName, item) {
  if (!lakeName || !item || !Number.isFinite(item.lat) || !Number.isFinite(item.lon)) return;

  if (!index.byLake.has(lakeName)) index.byLake.set(lakeName, []);
  const list = index.byLake.get(lakeName);
  const nextKey = accessDedupeKey(item);

  const existing = list.find((x) => accessDedupeKey(x) === nextKey);
  if (existing) {
    // Preserve all source categories if a spot appears in more than one worker
    // route, but keep only one dropdown entry.
    const labels = new Set([...(existing.sourceLabels || [existing.typeLabel]), item.typeLabel].filter(Boolean));
    existing.sourceLabels = [...labels];
    existing.typeLabel = existing.sourceLabels.join(' / ');
    return;
  }

  list.push(item);
}

// ── Worker data load ─────────────────────────────────────────────────────

async function fetchAccessSource(source, stateCode) {
  const res = await fetch(workerUrl(source.path, stateCode), { cache: 'no-store' });
  if (!res.ok) throw new Error(`${source.path}?state=${stateCode} returned HTTP ${res.status}`);
  const data = await res.json();
  return { source, stateCode, data };
}

async function buildAccessIndex() {
  const index = { lakeNames: [], byLake: new Map() };

  const jobs = [];
  ACCESS_SOURCES.forEach((source) => {
    STATES.forEach((stateCode) => jobs.push(fetchAccessSource(source, stateCode)));
  });

  const results = await Promise.allSettled(jobs);
  const failures = [];

  results.forEach((result) => {
    if (result.status === 'rejected') {
      failures.push(result.reason?.message || String(result.reason));
      return;
    }

    const { source, stateCode, data } = result.value;
    const waterbodies = data?.waterbodies || {};

    Object.entries(waterbodies).forEach(([rawWaterbody, items]) => {
      const lakeName = displayLakeName(rawWaterbody, stateCode);
      if (!lakeName || !Array.isArray(items)) return;

      items.forEach((raw) => {
        const lat = Number(raw.lat);
        const lon = Number(raw.lon);
        const name = String(raw.name || 'Unnamed access point').trim();
        if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return;

        addAccessItem(index, lakeName, {
          name,
          lat,
          lon,
          typeLabel: source.label,
          sourcePath: source.path,
          sourceState: stateCode,
          marker: source.marker,
          meta: raw.meta || {},
          raw,
        });
      });
    });
  });

  index.lakeNames = [...index.byLake.keys()].sort((a, b) => a.localeCompare(b));
  for (const list of index.byLake.values()) {
    list.sort((a, b) => formatAccessLabel(a).localeCompare(formatAccessLabel(b)));
  }

  if (failures.length) {
    console.warn('[lake-ramp-select] Some worker access feeds failed:', failures);
  }

  return index;
}

function loadAccessIndex() {
  if (!accessIndexPromise) {
    accessIndexPromise = buildAccessIndex().then((idx) => {
      accessIndex = idx;
      return idx;
    });
  }
  return accessIndexPromise;
}

// Keep the old global helper name synchronous for legacy callers. It returns
// the latest loaded worker-backed lake list; callers that need to force the
// first async load can use getUniversalLakeNamesAsync.
window.getUniversalLakeNames = function getUniversalLakeNames() {
  return accessIndex.lakeNames;
};
window.getUniversalLakeNamesAsync = async function getUniversalLakeNamesAsync() {
  const idx = await loadAccessIndex();
  return idx.lakeNames;
};

// ── Populate lake dropdown ───────────────────────────────────────────────

async function populateLakeSelect() {
  const lakeSelect = document.getElementById('lakeSelect');
  if (!lakeSelect) return;

  const currentValue = lakeSelect.value;
  const idx = await loadAccessIndex();

  // Preserve the first placeholder option if one already exists, then rebuild
  // the dynamic options so repeated calls cannot append duplicates.
  const placeholder = lakeSelect.querySelector('option[value=""]')?.outerHTML || '<option value="">-- Select lake / waterbody --</option>';
  lakeSelect.innerHTML = placeholder;

  idx.lakeNames.forEach((lakeName) => {
    const opt = document.createElement('option');
    opt.value = lakeName;
    opt.textContent = lakeName;
    lakeSelect.appendChild(opt);
  });

  if (currentValue && idx.byLake.has(currentValue)) lakeSelect.value = currentValue;
}

// ── Lake change handler ──────────────────────────────────────────────────

async function onLakeChange(selLakeName) {
  const rampSel = document.getElementById('rampSelect');
  if (rampSel) rampSel.innerHTML = '<option value="">-- Access Points Index --</option>';

  if (!selLakeName) {
    if (rampSel) rampSel.disabled = true;
    return;
  }

  const idx = await loadAccessIndex();
  const accessPoints = idx.byLake.get(selLakeName) || [];

  // Fly map to available worker-provided access points for this waterbody.
  if (state.MAP_OK && accessPoints.length) {
    const coords = accessPoints.map((p) => [p.lat, p.lon]);
    if (coords.length === 1) {
      state.MAP.setView(coords[0], 15);
    } else {
      state.MAP.fitBounds(coords, { padding: [40, 40] });
    }
  }

  // Sync planLake if not already set
  const planLakeEl = document.getElementById('planLake');
  if (planLakeEl && !planLakeEl.value) planLakeEl.value = selLakeName;

  // Populate access dropdown
  if (!rampSel) return;
  rampSel.disabled = false;

  if (accessPoints.length) {
    accessPoints.forEach((point) => {
      const opt = document.createElement('option');
      opt.value = point.name;
      opt.textContent = formatAccessLabel(point);
      opt.dataset.coords = `${point.lat},${point.lon}`;
      opt.dataset.type = point.typeLabel || '';
      opt.dataset.source = point.sourcePath || '';
      opt.dataset.state = point.sourceState || '';
      rampSel.appendChild(opt);
    });
  } else {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— no worker access points found —';
    rampSel.appendChild(opt);
  }
}

// ── Ramp / access change handler ─────────────────────────────────────────

function onRampChange(selOpt) {
  if (!selOpt.value || !selOpt.dataset.coords || !state.MAP_OK) return;
  const [lat, lon] = selOpt.dataset.coords.split(',').map(Number);
  state.MAP.setView([lat, lon], 15);
  const planRampEl = document.getElementById('planRamp');
  if (planRampEl) planRampEl.value = selOpt.value;
}

// ── Wire everything ──────────────────────────────────────────────────────

function wire() {
  populateLakeSelect().catch((err) => {
    console.error('[lake-ramp-select] Failed to populate worker-backed lake list:', err);
  });

  document.getElementById('lakeSelect')?.addEventListener('change', (e) => {
    onLakeChange(e.target.value).catch((err) => {
      console.error('[lake-ramp-select] Failed to populate access points:', err);
    });
  });

  document.getElementById('rampSelect')?.addEventListener('change', function () {
    onRampChange(this.options[this.selectedIndex]);
  });
}

wire();
