/**
 * NOAA Coastal Tides — Plan-tab tide panel.
 *
 * Renders the tide table, current stage and current height for the selected
 * coastal zone. All NOAA fetching / interpolation / stage classification now
 * lives in tide-engine.js so coastal SmartPlan can share it; this file is
 * only the DOM layer.
 *
 * The panel auto-reveals when a `coast_*` zone is chosen in #lakeSelect and
 * auto-selects that zone's NOAA station, so the angler never has to know
 * which station serves their water.
 */

import { esc } from '../utils/escape.js';
import {
  COASTAL_ZONES,
  COASTAL_SLUGS,
  isCoastalKey,
} from '../data/coastal-zones.js';
import { resolveR2Key } from '../data/lake-keys.js';
import { getTideState, stageLabel } from './tide-engine.js';

function fmtTime(date) {
  if (!date) return '—';
  const h = date.getHours();
  const m = date.getMinutes();
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

/**
 * Unique stations across the catalog, labelled by the zones they serve.
 * Several adjacent zones legitimately share one station (e.g. 8670870 covers
 * St. Helena, Beaufort and Hilton Head), so we group rather than duplicate.
 */
function buildStationOptions() {
  const byStation = new Map();
  for (const slug of COASTAL_SLUGS) {
    const z = COASTAL_ZONES[slug];
    if (!byStation.has(z.tideStation)) {
      byStation.set(z.tideStation, { state: z.state, zones: [] });
    }
    byStation.get(z.tideStation).zones.push(z.name.replace(/,\s*[A-Z]{2}$/, ''));
  }
  return [...byStation.entries()].map(([id, info]) => ({
    id,
    label: `${info.zones[0]} (${id})`,
    title: `${info.state} — serves: ${info.zones.join(', ')}`,
  }));
}

function populateStations(sel) {
  if (!sel || sel.dataset.populated === '1') return;
  const frag = document.createDocumentFragment();
  for (const opt of buildStationOptions()) {
    const o = document.createElement('option');
    o.value = opt.id;
    o.textContent = opt.label;
    o.title = opt.title;
    frag.appendChild(o);
  }
  sel.appendChild(frag);
  sel.dataset.populated = '1';
}

function wire() {
  const panel     = document.getElementById('tidePanel');
  const stationSel = document.getElementById('noaaStationSelect');
  const syncBtn   = document.getElementById('syncTidesBtn');
  const statusEl  = document.getElementById('tideSyncStatus');
  const stageEl   = document.getElementById('liveTideStageReadout');
  const heightEl  = document.getElementById('liveTideHeightReadout');
  const tableWrap = document.getElementById('tidesAssessmentTableWrap');
  const tbody     = document.getElementById('tidesAssessmentBody');
  if (!panel || !stationSel || !syncBtn) return;

  populateStations(stationSel);

  function say(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color =
      kind === 'err' ? 'var(--bad)' :
      kind === 'ok'  ? 'var(--accent2)' : 'var(--muted)';
  }

  // ── Reveal the panel + preselect the station for coastal zones ──────────
  function syncToSelectedZone() {
    const lakeName = document.getElementById('lakeSelect')?.value || '';
    const key = lakeName ? resolveR2Key(lakeName) : null;

    if (!isCoastalKey(key)) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = '';
    const zone = COASTAL_ZONES[key];
    if (zone && stationSel.value !== zone.tideStation) {
      stationSel.value = zone.tideStation;
      say(`Station auto-set for ${zone.name}`, null);
      fetchTides();
    }
  }

  async function fetchTides() {
    const stationId = stationSel.value;
    if (!stationId) { say('Select a station first', 'err'); return; }

    say('Fetching NOAA CO-OPS…', null);
    if (tableWrap) tableWrap.style.display = 'block';
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#888">⏳ Processing tidal harmonics…</td></tr>';
    }

    const dateStr = document.getElementById('planDate')?.value
      || new Date().toISOString().slice(0, 10);

    try {
      const tide = await getTideState({ station: stationId, dateStr });

      if (stageEl)  stageEl.value = tide.stageLabel || '—';
      if (heightEl) {
        heightEl.value = Number.isFinite(tide.heightFt)
          ? `${tide.heightFt.toFixed(1)} ft`
          : '—';
      }

      if (tbody) {
        const rows = tide.hilo.map((p) => {
          const isHigh = p.type === 'H';
          const at = p.t;
          const bg  = isHigh ? 'rgba(0,229,255,.08)' : 'rgba(255,82,82,.06)';
          const col = isHigh ? 'var(--accent)' : 'var(--bad)';
          const note = isHigh
            ? '🌊 Fish flood into grass/marsh. Work creek mouths and oyster points.'
            : '📉 Fish pull to deep channels and holes. Watch oyster bar clearance.';
          const timeStr = fmtTime(
            (() => { const m = String(at).match(/(\d{2}):(\d{2})/);
                     if (!m) return null;
                     const d = new Date(); d.setHours(+m[1], +m[2], 0, 0); return d; })()
          );
          return `<tr style="background:${bg}">
            <td style="padding:4px"><b style="color:${col}">${isHigh ? '▲ HIGH' : '▼ LOW'}</b></td>
            <td style="padding:4px"><b>${esc(timeStr)}</b></td>
            <td style="padding:4px;font-family:monospace;font-weight:700">${parseFloat(p.v).toFixed(1)} ft</td>
            <td style="padding:4px" class="muted" style="font-size:12px">${note}</td>
          </tr>`;
        }).join('');
        tbody.innerHTML = rows || '<tr><td colspan="4" style="text-align:center;color:#888">No events</td></tr>';
      }

      // Cache for plan-builder.js / offline use.
      if (window.DB?.db) {
        try {
          await window.DB.put('settings', {
            key: `tide_${stationId}_${dateStr.replace(/-/g, '')}`,
            predictions: tide.hilo,
            stage: tide.stageLabel,
            heightFt: tide.heightFt,
            syncedAt: new Date().toISOString(),
          });
        } catch (_) { /* cache is best-effort */ }
      }

      const rangeTxt = Number.isFinite(tide.rangeFt) ? ` · range ${tide.rangeFt.toFixed(1)} ft` : '';
      say(`✓ ${tide.hilo.length} events synced${rangeTxt}`, 'ok');
      window._trollmapTide = tide;
    } catch (err) {
      say(`API error — ${err.message}`, 'err');
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="4" style="color:var(--bad);text-align:center">❌ ${esc(err.message)}</td></tr>`;
      }
    }
  }

  stationSel.addEventListener('change', () => {
    if (stationSel.value) fetchTides();
    else {
      if (tableWrap) tableWrap.style.display = 'none';
      if (stageEl) stageEl.value = '';
      if (heightEl) heightEl.value = '';
      say('Offline', null);
    }
  });
  syncBtn.addEventListener('click', fetchTides);
  document.getElementById('lakeSelect')?.addEventListener('change', syncToSelectedZone);
  document.getElementById('planDate')?.addEventListener('change', () => {
    if (stationSel.value) fetchTides();
  });

  syncToSelectedZone();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wire, { once: true });
} else {
  wire();
}

// ── Back-compat accessors used by plan-builder.js ───────────────────────────
window.getNoaaTideRows = function () {
  const tbody = document.getElementById('tidesAssessmentBody');
  return tbody ? tbody.innerHTML : '';
};
window.getNoaaTideStage = function () {
  return document.getElementById('liveTideStageReadout')?.value || '';
};
window.getNoaaStationName = function () {
  const sel = document.getElementById('noaaStationSelect');
  return sel?.selectedOptions[0]?.text || '';
};
/** Current tide state object (or null) for SmartPlan depth adjustment. */
window.getTideState = function () {
  return window._trollmapTide || null;
};

export { stageLabel };
