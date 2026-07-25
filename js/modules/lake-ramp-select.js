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
import { loadAccessIndex } from '../data/access-index.js';
import { loadContourForLake } from './contour-data.js';
import { COASTAL_ZONES, isCoastalKey, coastalNamesByState } from '../data/coastal-zones.js';
import { resolveR2Key } from '../data/lake-keys.js';

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
  idx.lakeNames.forEach((lakeName) => {
    const opt = document.createElement('option');
    opt.value = lakeName;
    opt.textContent = lakeName;
    inlandGroup.appendChild(opt);
  });
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

  // Coastal ramps come from the generated catalog; the worker access index
  // only covers inland DNR boat ramps.
  const accessPoints = zone
    ? Object.entries(zone.ramps || {}).map(([name, c]) => ({
        name, lat: c[0], lon: c[1], typeLabel: 'Coastal ramp', marker: '⛵',
        sourcePath: 'coastal-zones', sourceState: zone.state,
      }))
    : (idx.byLake.get(selLakeName) || []);

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
