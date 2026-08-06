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
import { loadAccessIndex, registryRecordFor, getLoadedAccessIndex } from '../data/access-index.js';
import { loadContourForLake } from './contour-data.js';
import { COASTAL_ZONES, isCoastalKey } from '../data/coastal-zones.js';
import { landOnCoastalZone } from '../utils/viewport-cull.js';
import { appendCoastalOptgroups } from '../utils/coastal-optgroups.js';
import { resolveR2Key } from '../data/lake-keys.js';
import { waterZoneCandidates } from '../data/water-aliases.js';
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
  wellCharted: false,
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
  // The picker already defaults to shipped lakes, so this box narrows further: only lakes
  // whose soundings cover most of their surface. Median charted fraction across the 434 is
  // 0.59, so a 0.5 cut is roughly the better half.
  if (filters.wellCharted && !(rec.charted >= 0.5)) return false;
  return true;
}

/** Short suffix telling you what is known about a lake before you select it. */
function lakeBadge(lakeName) {
  const rec = registryRecordFor(lakeName);

  // Count what the picker ACTUALLY holds for this name, not what the offline access index
  // recorded months ago.
  //
  // `rec.rampSources` comes from lake_access.json, baked at index-build time. Every waterbody
  // whose boundary was cut after that file was last rebuilt has `ramp_sources: 0` -- which is
  // true about the file and false about the world. Congaree River read "no ramp listed" while
  // the Access dropdown directly beneath it listed five, because the SC DNR feed names three
  // ramps on it and /paddle adds more. A badge that contradicts the list under it is worse
  // than no badge: Ryan's rule is that access is a DISPLAYED ATTRIBUTE, and a displayed
  // attribute has to be true.
  //
  // The live index is authoritative because it is the same data the Access dropdown is built
  // from. rampSources stays as the fallback for a lake the feeds do not mention at all.
  const pts = getLoadedAccessIndex()?.byLake?.get(lakeName) || [];
  const ramps = pts.filter(p => /ramp/i.test(p.typeLabel || '')).length;

  if (!rec && !pts.length) return '';
  const bits = [];
  if (rec?.areaAcres) bits.push(`${Math.round(rec.areaAcres)} ac`);
  if (ramps) bits.push(ramps === 1 ? '1 ramp' : `${ramps} ramps`);
  else if (pts.length) bits.push(pts.length === 1 ? '1 access pt' : `${pts.length} access pts`);
  else if (rec?.rampSources) bits.push(rec.rampSources > 1 ? `${rec.rampSources} ramp srcs` : 'ramp');
  else bits.push('no ramp listed');
  // Say WHICH credential opened it. "Open With Credential" on its own reads like a
  // formality; "Fort Bragg" tells you to bring your ID and check in.
  if (rec?.accessForMe === 'Open With Credential') bits.push(`ID: ${rec.accessVia || 'credential'}`);
  else if (rec?.accessForMe && rec.accessForMe !== 'Open Access') bits.push(rec.accessForMe);
  if (rec?.charted != null && rec.charted > 0) bits.push(`${Math.round(rec.charted * 100)}% charted`);
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
  appendCoastalOptgroups(lakeSelect);

  if (currentValue && (idx.byLake.has(currentValue) || isCoastalKey(resolveR2Key(currentValue)))) {
    lakeSelect.value = currentValue;
  }
}

// ── Lake change handler ──────────────────────────────────────────────────

function formatAccessLabel(item) {
  const prefix = item.marker ? `${item.marker} ` : '';
  return `${prefix}${item.name}${item.typeLabel ? ` — ${item.typeLabel}` : ''}`;
}

/**
 * Narrow a coastal key using the waterbody's own landings.
 *
 * Eight DNR names span more than one zone. water-aliases.js can only offer a default -- the
 * zone with the most landings -- and for the Wando, which has one ramp in Cape Romain and one
 * in Charleston, that default is decided alphabetically. The Intracoastal Waterway has
 * landings in eight zones and no default is meaningful at all.
 *
 * The access points for the selected name settle it: count how many fall inside each candidate
 * zone's bbox and take the winner. Ties keep the incoming key so the answer stays stable.
 */
function refineCoastalKey(name, key, accessPoints) {
  if (!isCoastalKey(key) || !accessPoints?.length) return key;
  const cands = waterZoneCandidates(name).filter(isCoastalKey);
  if (cands.length < 2) return key;

  let best = key;
  let bestHits = -1;
  for (const slug of cands) {
    const bbox = COASTAL_ZONES[slug]?.bbox;
    if (!bbox) continue;
    const [[south, west], [north, east]] = bbox;
    let hits = 0;
    for (const p of accessPoints) {
      if (p.lat >= south && p.lat <= north && p.lon >= west && p.lon <= east) hits += 1;
    }
    if (hits > bestHits) { bestHits = hits; best = slug; }
  }
  return bestHits > 0 ? best : key;
}

async function onLakeChange(selLakeName) {
  const rampSel = document.getElementById('rampSelect');
  if (rampSel) rampSel.innerHTML = '<option value="">-- Access Points Index --</option>';

  if (!selLakeName) {
    if (rampSel) rampSel.disabled = true;
    return;
  }

  const idx = await loadAccessIndex();
  let accessPoints = idx.byLake.get(selLakeName) || [];

  // Which zone, when the name spans several. Eight DNR names do: there are three North
  // Rivers, two Wando Rivers, and an Intracoastal Waterway with landings in eight zones.
  // water-aliases.js can only offer a default (the zone with the most landings), and for the
  // Wando that default is a coin toss between Cape Romain and Charleston.
  //
  // Here we can do better than a default, because the ramps for THIS name have just been
  // looked up: whichever zone contains most of them is the one being asked about. No new data
  // and no guessing — the landings say where the water is.
  const coastalKey = refineCoastalKey(selLakeName, resolveR2Key(selLakeName), accessPoints);
  const zone = isCoastalKey(coastalKey) ? COASTAL_ZONES[coastalKey] : null;

  // Coastal ramps are pulled from the fish & wildlife API via the worker access index.
  // We fall back to the hardcoded ones if the API results are empty.
  if (zone && accessPoints.length === 0) {
    accessPoints = Object.entries(zone.ramps || {}).map(([name, c]) => ({
      name, lat: c[0], lon: c[1], typeLabel: 'Coastal ramp', marker: '⛵',
      sourcePath: 'coastal-zones', sourceState: zone.state,
    }));
  }

  // Fly the map to the zone bbox when the ZONE itself was selected — a sound is far larger
  // than its handful of ramps. But 158 DNR waterbody names now resolve to a zone as well, and
  // for those the zone box is the wrong frame: picking "Shem Creek" and being shown the whole
  // of Charleston Harbour is not an answer to the question. Those get their own landings,
  // which is exactly where the creek is.
  const zoneItself = zone && zone.name === selLakeName;
  if (state.MAP_OK && zone && (zoneItself || !accessPoints.length)) {
    landOnCoastalZone(state.MAP, zone.bbox);
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
  const chartWrap = check('lakeFilterCharted', 'well charted',
    'Only lakes whose soundings cover at least half their surface. The list already shows '
    + 'only lakes that have contours at all.');

  const count = document.createElement('span');
  count.id = 'lakeFilterCount';
  count.style.cssText = 'opacity:.7;margin-left:auto;';

  bar.append(stateSel, sizeSel, rampWrap, chartWrap, count);
  host.insertBefore(bar, lakeSelect);

  const refresh = () => {
    filters.state = stateSel.value;
    filters.size = sizeSel.value;
    filters.rampOnly = document.getElementById('lakeFilterRamp').checked;
    filters.wellCharted = document.getElementById('lakeFilterCharted').checked;
    populateLakeSelect().catch((e) => console.error('[lake-ramp-select] refilter failed:', e));
  };
  stateSel.addEventListener('change', refresh);
  sizeSel.addEventListener('change', refresh);
  bar.querySelectorAll('input[type=checkbox]').forEach((c) => c.addEventListener('change', refresh));

  loadAccessIndex().then(() => {
    const s = registryStats();
    if (!s.total) {
      // No registry loaded. The filters would silently do NOTHING -- passesFilters() lets
      // every lake through when it has no registry record, which is correct (it protects the
      // DNR lakes) but reads as broken checkboxes. Say so instead of leaving the user to
      // discover it by ticking a box and watching the list not change.
      count.textContent = 'registry not loaded — filters unavailable';
      count.title = 'lake_index.json did not load; check the browser console. The lake list '
                  + 'is running on the DNR feeds alone, exactly as it did before.';
      bar.querySelectorAll('input,select').forEach((el) => {
        if (el === stateSel) return;           // state still works on the DNR names
        el.disabled = true;
        el.title = 'needs lake_index.json';
      });
      stateSel.disabled = true;
      return;
    }
    count.textContent = `${s.shipped} charted of ${s.total}`;
    count.title = `Registry: ${s.total} lakes, ${s.shipped} with Garmin soundings and a `
                + `chartpack, ${s.open} open to the public, ${s.ramps} with a mapped ramp.`;
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
