/**
 * NOAA Coastal Tides — fetch tide predictions for the trip date
 * from NOAA's CO-OPS API and render them in the Plan tab.
 *
 * Supports SC, NC, and GA coastal stations. Each prediction row
 * includes tactical advice (fish-flood-in-grass, fish-pull-to-deep, etc.).
 */

import { esc } from '../utils/escape.js';

function fmtNoaaTime(str) {
  if (!str) return '—';
  const parts = str.split(' ');
  if (parts.length < 2) return str;
  const [h, m] = parts[1].split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function wireButtons() {
  const syncBtn   = document.getElementById('syncTidesBtn');
  const statusEl  = document.getElementById('tideSyncStatus');
  const stationSel = document.getElementById('noaaStationSelect');
  const stageEl   = document.getElementById('liveTideStageReadout');
  const tableWrap = document.getElementById('tidesAssessmentTableWrap');
  const tbody     = document.getElementById('tidesAssessmentBody');
  if (!syncBtn) return;

  function say(msg, isErr) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = isErr ? 'var(--bad)' : 'var(--accent2)';
  }

  stationSel?.addEventListener('change', (e) => {
    if (e.target.value) fetchNoaaTideData();
    else {
      if (tableWrap) tableWrap.style.display = 'none';
      if (stageEl) stageEl.value = '';
      say('Offline', false);
    }
  });
  syncBtn.addEventListener('click', fetchNoaaTideData);

  async function fetchNoaaTideData() {
    const stationId = stationSel?.value || '';
    if (!stationId) { alert('Select a Coastal Reference Station first.'); return; }
    say('Fetching NOAA CO-OPS API…', false);
    syncBtn.style.background = 'var(--accent)';
    syncBtn.style.color = '#000';
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#888">⏳ Processing tidal harmonics…</td></tr>';
    }
    if (tableWrap) tableWrap.style.display = 'block';

    const tripDate = document.getElementById('planDate')?.value || new Date().toISOString().slice(0, 10);
    const noaaDate = tripDate.replace(/-/g, '');

    try {
      const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${noaaDate}&range=24&station=${stationId}&product=predictions&datum=MLLW&time_zone=lst_ldt&interval=hilo&units=english&application=TrollMapStudio&format=json`;
      const res = await fetch(url);
      const data = await res.json();
      if (data?.error) throw new Error(data.error.message || 'Station unavailable');
      if (!data?.predictions?.length) throw new Error('No tide predictions for this date');

      const preds = data.predictions;
      const now = new Date();
      const upcoming = preds.find((p) => new Date(p.t.replace(' ', 'T')) > now);
      if (stageEl) {
        stageEl.value = upcoming
          ? (upcoming.type === 'H' ? 'Incoming / Flood 🌊' : 'Outgoing / Ebb 📉')
          : 'Slack / Stable';
      }

      if (tbody) {
        tbody.innerHTML = preds.map((p) => {
          const isHigh = p.type === 'H';
          const bg  = isHigh ? 'rgba(0,229,255,.08)' : 'rgba(255,82,82,.06)';
          const col = isHigh ? 'var(--accent)' : 'var(--bad)';
          const note = isHigh
            ? '🌊 Fish flood into grass/marsh. Over-bar kayak runs safe. Work creek mouths and oyster points.'
            : '📉 Fish pull to deep channels and holes. Watch oyster bar clearance on kayak.';
          return `<tr style="background:${bg}">
            <td><b style="color:${col}">${isHigh ? '▲ HIGH' : '▼ LOW'}</b></td>
            <td><b>${fmtNoaaTime(p.t)}</b></td>
            <td style="font-family:monospace;font-weight:700">${parseFloat(p.v).toFixed(1)} ft</td>
            <td class="muted" style="font-size:12px">${note}</td>
          </tr>`;
        }).join('');
      }

      if (window.DB?.db) {
        try {
          await window.DB.put('settings', {
            key: `tide_${stationId}_${noaaDate}`,
            predictions: preds,
            stage: stageEl?.value || '',
            syncedAt: new Date().toISOString(),
          });
        } catch (_) {}
      }

      say(`✓ ${preds.length} events synced`, false);
    } catch (err) {
      say('API Error — check station', true);
      if (tbody) tbody.innerHTML = `<tr><td colspan="4" style="color:var(--bad);text-align:center">❌ ${esc(err.message)}</td></tr>`;
    } finally {
      setTimeout(() => { syncBtn.style.background = ''; syncBtn.style.color = ''; }, 1000);
    }
  }
}

wireButtons();

// Expose for the plan-preview module to read the cached table
window.getNoaaTideRows = function () {
  const tbody = document.getElementById('tidesAssessmentBody');
  return tbody ? tbody.innerHTML : '';
};
window.getNoaaTideStage = function () {
  const stageEl = document.getElementById('liveTideStageReadout');
  return stageEl ? stageEl.value : '';
};
window.getNoaaStationName = function () {
  const sel = document.getElementById('noaaStationSelect');
  return sel?.selectedOptions[0]?.text || '';
};
