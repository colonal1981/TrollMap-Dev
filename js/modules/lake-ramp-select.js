/**
 * Worker-backed Lake / Access dropdowns in the map toolbar.
 *
 * Populates #lakeSelect and #rampSelect from the shared access-index module
 * (data/access-index.js), which pulls from the Cloudflare Worker access-data
 * routes instead of the legacy hard-coded LAKE_DB / TRISTATE_MASTER_RAMPS
 * files.
 *
 * REFACTORED 2026-07-03: the worker-fetch/build/dedupe logic that used to
 * live in this file was pulled out into data/access-index.js so that
 * catch-journal.js's nearest-lake lookup could share the same live index
 * instead of the worker being queried twice.
 */

import { state } from '../core/state.js';
import { loadAccessIndex, registryRecordFor } from '../data/access-index.js';
import { loadContourForLake } from './contour-data.js';
import { COASTAL_ZONES, isCoastalKey, coastalNamesByState } from '../data/coastal-zones.js';
import { resolveR2Key } from '../data/lake-keys.js';
import { registryStats } from '../data/lake-registry.js';

// ── Filter state ─────────────────────────────────────────────────────────
//
// The registry contributes hundreds of lakes the DNR feeds never listed, and a flat
// alphabetical <select> of that size is unusable — you cannot scroll to a 40-acre pond you
// half remember the name of. These filters run over the ALREADY-BUILT index rather than
// re-querying, so toggling is instant.
//
// Defaults are deliberately conservative: everything on, nothing hidden, so the first load
// after this ships looks like a superset of what was there before rather than a surprise.
const filters = {
  state: '',        // '' = all
  size: '',         // '' | 'small' (<200 ac) | 'mid' (200-1000) | 'big' (>1000)
  rampOnly: false,
  chartedOnly: false,
};

const SIZE_BANDS = {
  small: [0, 200],
  mid: [200, 1000],
  big: [1000, Infinity],
};

/**
 * True if a picker entry survives the current filters.
 *
 * A lake with NO registry record — i.e. one that came from a DNR feed — always passes.
 * Those are the 213 that already worked, and silently filtering them out because the
 * registry has nothing to say about them would be a regression disguised as a feature.
 */
function passesFilters(lakeName) {
  const rec = registryRecordFor(lakeName);
  if (!rec) return true;
  if (filters.state && rec.state !== filters.state) return false;
  if (filters.size) {
    const [lo, hi] = SIZE_BANDS[filters.size] || [0, Infinity];
    if (!(rec.areaAcres >= lo && rec.areaAcres < hi)) return false;
  }
  if (filters.rampOnly && !rec.rampSources) return false;
  // charted === null means the Garmin extraction has not run for this lake yet. Treating
  // that as "no soundings" would empty the list entirely until the card-wide run finishes.
  if (filters.chartedOnly && rec.charted !== null && !(rec.charted > 0)) return false;
  return true;
}

/** Short suffix telling you what is known about a lake before you select it. */
function lakeBadge(lakeName) {
  const rec = registryRecordFor(lakeName);
  if (!rec) return '';
  const bits = [];
  if (rec.areaAcres) bits.push(`${Math.round(rec.areaAcres)} ac`);
  if (rec.rampSources) bits.push(rec.rampSources > 1 ? `${rec.rampSources} ramp srcs` : 'ramp');
  else bits.push('no ramp listed');
  // Say WHICH credential opened it. "Open With Credential" on its own reads like a
  // formality; "Fort Bragg" tells you to bring your ID and check in.
  if (rec.accessForMe === 'Open With Credential') bits.push(`ID: ${rec.accessVia || 'credential'}`);
  else if (rec.accessForMe && rec.accessForMe !== 'Open Access') bits.push(rec.accessForMe);
  if (rec.charted === 0) bits.push('no soundings');
  return bits.length ? `  — ${bits.join(', ')}` : '';
}

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

  const inlandGroup = document.createElement('optgroup');
  inlandGroup.label = 'Lakes / Reservoirs';
  let shown = 0;
  idx.lakeNames.forEach((lakeName) => {
    if (isCoastalKey(resolveR2Key(lakeName))) return;
    if (!passesFilters(lakeName)) return;
    const opt = document.createElement('option');
    opt.value = lakeName;
    opt.textContent = lakeName + lakeBadge(lakeName);
    inlandGroup.appendChild(opt);
    shown += 1;
  });
  inlandGroup.label = `Lakes / Reservoirs (${shown})`;
  lakeSelect.appendChild(inlandGroup);

  // Coastal / tidal zones. The worker access index only covers inland DNR
  // boat ramps, so without this the 21 coastal zones are unreachable from the
  // map toolbar and none of the tide / oyster / marsh layers can be loaded.
  const coastalByState = coastalNamesByState();
  for (const [stateCode, label] of [['SC', 'SC Coast'], ['GA', 'GA Coast'], ['NC', 'NC Coast']]) {
    const names = coastalByState[stateCode];
    if (!names?.length) continue;
    const grp = document.createElement('optgroup');
    grp.label = label;
    names.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name.replace(/,\s*[A-Z]{2}$/, '');
      grp.appendChild(opt);
    });
    lakeSelect.appendChild(grp);
  }

  if (currentValue && (idx.byLake.has(currentValue) || isCoastalKey(resolveR2Key(currentValue)))) {
    lakeSelect.value = currentValue;
  }
}

// ── Lake change handler ──────────────────────────────────────────────────

function formatAccessLabel(item) {
  const prefix = item.marker ? `${item.marker} ` : '';
  return `${prefix}${item.name}${item.typeLabel ? ` — ${item.typeLabel}` : ''}`;
}

async function onLakeChange(selLakeName) {
  const rampSel = document.getElementById('rampSelect');
  if (rampSel) rampSel.innerHTML = '<option value="">-- Access Points Index --</option>';

  if (!selLakeName) {
    if (rampSel) rampSel.disabled = true;
    return;
  }

  const idx = await loadAccessIndex();
  const coastalKey = resolveR2Key(selLakeName);
  const zone = isCoastalKey(coastalKey) ? COASTAL_ZONES[coastalKey] : null;

  // Coastal ramps are pulled from the fish & wildlife API via the worker access index.
  // We fall back to the hardcoded ones if the API results are empty.
  let accessPoints = [];
  if (zone) {
    accessPoints = idx.byLake.get(selLakeName) || [];
    if (accessPoints.length === 0) {
      accessPoints = Object.entries(zone.ramps || {}).map(([name, c]) => ({
        name, lat: c[0], lon: c[1], typeLabel: 'Coastal ramp', marker: '⛵',
        sourcePath: 'coastal-zones', sourceState: zone.state,
      }));
    }
  } else {
    accessPoints = idx.byLake.get(selLakeName) || [];
  }

  // Fly the map to the zone bbox for coastal (a sound is far larger than its
  // handful of ramps), or to the access points for inland lakes.
  if (state.MAP_OK && zone) {
    state.MAP.fitBounds(zone.bbox, { padding: [40, 40] });
  } else if (state.MAP_OK && accessPoints.length) {
    const coords = accessPoints.map((p) => [p.lat, p.lon]);
    if (coords.length === 1) {
      state.MAP.setView(coords[0], 15);
    } else {
      state.MAP.fitBounds(coords, { padding: [40, 40] });
    }
  } else if (state.MAP_OK) {
    // No access point at all. That is not an error, it is 141 of the 322 accessible lakes —
    // public land on the bank and nobody has mapped a launch. Without this the map sits
    // wherever it was and selecting the lake looks broken. Fit the registry bounds when we
    // have them so a 5-mile reservoir is not framed at zoom 14 on its centroid.
    const rec = registryRecordFor(selLakeName);
    if (rec) {
      const b = rec.boundsWSEN;
      if (Array.isArray(b) && b.length === 4) {
        state.MAP.fitBounds([[b[1], b[0]], [b[3], b[2]]], { padding: [40, 40] });
      } else {
        state.MAP.setView([rec.lat, rec.lon], 14);
      }
    }
  }

  // Sync planLake if not already set
  const planLakeEl = document.getElementById('planLake');
  if (planLakeEl && !planLakeEl.value) {
    planLakeEl.value = selLakeName;
    planLakeEl.dispatchEvent(new Event('change'));
  }

// Load contours for this lake
  loadContourForLake(selLakeName);
  window.loadSupplementalForLake?.(selLakeName);

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

// ── Filter bar ───────────────────────────────────────────────────────────
//
// Injected next to #lakeSelect rather than added to index.html, for the same reason
// injectGarminPanel() builds itself: the toolbar markup is shared and a hand-edited control
// here would have to be kept in sync by hand forever. If #lakeSelect has no parent the bar
// is simply skipped and the dropdown behaves as it always did.

const BAR_ID = 'lakeFilterBar';

function buildFilterBar() {
  const lakeSelect = document.getElementById('lakeSelect');
  if (!lakeSelect || document.getElementById(BAR_ID)) return;
  const host = lakeSelect.parentElement;
  if (!host) return;

  const bar = document.createElement('div');
  bar.id = BAR_ID;
  bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;'
                    + 'margin:4px 0 6px 0;font-size:12px;line-height:1.6;';

  const sel = (id, label, opts) => {
    const s = document.createElement('select');
    s.id = id;
    s.title = label;
    s.style.cssText = 'font-size:12px;padding:1px 4px;';
    for (const [v, t] of opts) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      s.appendChild(o);
    }
    return s;
  };

  const stateSel = sel('lakeFilterState', 'State', [
    ['', 'All states'], ['SC', 'SC'], ['NC', 'NC'], ['GA', 'GA'], ['TN', 'TN'],
  ]);
  const sizeSel = sel('lakeFilterSize', 'Size', [
    ['', 'Any size'], ['small', '< 200 ac'], ['mid', '200–1000 ac'], ['big', '> 1000 ac'],
  ]);

  const check = (id, label, title) => {
    const w = document.createElement('label');
    w.style.cssText = 'display:inline-flex;align-items:center;gap:3px;cursor:pointer;';
    w.title = title;
    const c = document.createElement('input');
    c.type = 'checkbox'; c.id = id;
    w.appendChild(c);
    w.appendChild(document.createTextNode(label));
    return w;
  };

  const rampWrap = check('lakeFilterRamp', 'has ramp',
    'Only lakes with a launch in at least one source. Absence is not evidence — Wee Tee has '
    + 'a ramp Ryan has used that OSM and Garmin both miss.');
  const chartWrap = check('lakeFilterCharted', 'has soundings',
    'Only lakes with Garmin depth data. Lakes not yet measured are kept, not hidden.');

  const count = document.createElement('span');
  count.id = 'lakeFilterCount';
  count.style.cssText = 'opacity:.7;margin-left:auto;';

  bar.append(stateSel, sizeSel, rampWrap, chartWrap, count);
  host.insertBefore(bar, lakeSelect);

  const refresh = () => {
    filters.state = stateSel.value;
    filters.size = sizeSel.value;
    filters.rampOnly = document.getElementById('lakeFilterRamp').checked;
    filters.chartedOnly = document.getElementById('lakeFilterCharted').checked;
    populateLakeSelect().catch((e) => console.error('[lake-ramp-select] refilter failed:', e));
  };
  stateSel.addEventListener('change', refresh);
  sizeSel.addEventListener('change', refresh);
  bar.querySelectorAll('input[type=checkbox]').forEach((c) => c.addEventListener('change', refresh));

  loadAccessIndex().then(() => {
    const s = registryStats();
    if (!s.total) return;                      // registry unavailable; leave the bar quiet
    count.textContent = `${s.reachable} reachable of ${s.total}`;
    count.title = `Registry: ${s.total} lakes, ${s.open} open to the public, ${s.reachable} `
                + `reachable (incl. permit/unknown), ${s.ramps} with a mapped ramp.`;
  }).catch(() => {});
}

// ── Wire everything ──────────────────────────────────────────────────────

function wire() {
  buildFilterBar();
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
