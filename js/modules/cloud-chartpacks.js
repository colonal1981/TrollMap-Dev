/**
 * Cloud Chartpacks library browser — fetches a list of uploaded
 * depth-contour chartpacks from the Cloudflare worker (R2-backed)
 * and lets the user import any lake's tiles with one click.
 *
 * Tile fetches use a cache-bust query string so the worker's edge
 * cache can't serve a stale 404 from before a tile existed.
 */

import { CF_WORKER_URL } from '../core/state.js';

function initCloudChartpacks() {
  if (!window.L) { setTimeout(initCloudChartpacks, 200); return; }

  const panel = () => document.getElementById('cloudChartpacksPanel');
  const listEl = () => document.getElementById('cloudChartpacksList');
  const statusEl = () => document.getElementById('cloudChartpacksStatus');

  function fmtMB(b) {
    return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`;
  }

  // Cache-bust every request so the worker's edge cache can't serve
  // a stale 404 from before the file existed.
  const CB = `?v=${Date.now()}`;

  async function loadCloudList() {
    statusEl().textContent = 'Loading from worker...';
    statusEl().style.color = 'var(--muted)';
    listEl().innerHTML = '';
    try {
      const r = await fetch(`${CF_WORKER_URL}/chartpacks/list${CB}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      renderCloudList(data);
    } catch (e) {
      statusEl().textContent = `Could not reach worker: ${e.message}`;
      statusEl().style.color = 'var(--bad)';
    }
  }

  function renderCloudList(data) {
    const list = data.chartpacks || [];
    if (!list.length) {
      statusEl().textContent = 'No chartpacks in your library yet.';
      statusEl().style.color = 'var(--muted)';
      return;
    }
    statusEl().textContent = `${list.length} lake${list.length === 1 ? '' : 's'} available · ${fmtMB(list.reduce((a, c) => a + (c.bytes || 0), 0))} total`;
    statusEl().style.color = 'var(--accent2)';

    list.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
    listEl().innerHTML = list.map((lake) => {
      const tileCount = (lake.files || []).filter((f) => f.endsWith('.png')).length;
      return `
        <div data-lake="${lake.name}" style="background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
            <div style="flex:1;min-width:0">
              <div style="color:var(--accent);font-weight:700;font-size:13px">${lake.name}</div>
              <div style="color:var(--muted);font-size:11px;margin-top:2px">${tileCount} tile${tileCount === 1 ? '' : 's'} · ${fmtMB(lake.bytes || 0)}</div>
            </div>
            <button data-import="${lake.name}" style="background:var(--accent2);color:#000;border:none;border-radius:4px;padding:4px 10px;font-weight:700;font-size:11px;cursor:pointer;flex-shrink:0">Import</button>
          </div>
          <div data-status="${lake.name}" style="color:var(--muted);font-size:10px;margin-top:4px;display:none"></div>
        </div>
      `;
    }).join('');

    listEl().querySelectorAll('button[data-import]').forEach((btn) => {
      btn.addEventListener('click', () => importCloudChartpack(btn.dataset.import, btn));
    });
  }

  async function importCloudChartpack(lakeName, btn) {
    btn.disabled = true;
    btn.textContent = '⏳';
    const statusDiv = listEl().querySelector(`[data-status="${lakeName}"]`);
    statusDiv.style.display = 'block';
    statusDiv.textContent = 'Fetching tile index...';
    statusDiv.style.color = 'var(--muted)';

    try {
      const idxResp = await fetch(`${CF_WORKER_URL}/chartpacks/${lakeName}/index.json${CB}`, { cache: 'no-store' });
      if (!idxResp.ok) throw new Error(`index.json: HTTP ${idxResp.status}`);
      const idx = await idxResp.json();
      const stems = idx.tiles || [];
      if (!stems.length) throw new Error('No tiles in this chartpack');

      statusDiv.textContent = `Fetching ${stems.length} tiles...`;
      const files = [];
      let done = 0;
      for (const stem of stems) {
        try {
          const pngR = await fetch(`${CF_WORKER_URL}/chartpacks/${lakeName}/contours/${stem}_contours.png${CB}`);
          const jsonR = await fetch(`${CF_WORKER_URL}/chartpacks/${lakeName}/contours/${stem}_contours.georef.json${CB}`);
          if (!pngR.ok || !jsonR.ok) {
            console.warn('[cloud] failed to fetch', stem);
            continue;
          }
          const pngBlob = await pngR.blob();
          const jsonBlob = await jsonR.blob();
          files.push(new File([pngBlob], `${stem}_contours.png`, { type: 'image/png' }));
          files.push(new File([jsonBlob], `${stem}_contours.georef.json`, { type: 'application/json' }));
          done++;
          if (done % 4 === 0 || done === stems.length) {
            statusDiv.textContent = `Fetched ${done}/${stems.length}...`;
          }
        } catch (e) {
          console.warn('[cloud] fetch error for', stem, e);
        }
      }

      if (!files.length) throw new Error('Fetched 0 tiles');

      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      const input = document.getElementById('batchImportInput');
      if (!input) throw new Error('TrollMap bulk importer not found');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));

      statusDiv.textContent = `✓ Imported ${files.length / 2} tiles`;
      statusDiv.style.color = 'var(--accent2)';
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = 'Import'; btn.disabled = false; }, 4000);
    } catch (e) {
      statusDiv.textContent = `✕ ${e.message}`;
      statusDiv.style.color = 'var(--bad)';
      btn.textContent = 'Retry';
      btn.disabled = false;
    }
  }

  document.getElementById('btnCloudChartpacks')?.addEventListener('click', () => {
    panel().style.display = 'block';
    loadCloudList();
  });
  document.getElementById('cloudChartpacksRefresh')?.addEventListener('click', loadCloudList);
  document.getElementById('cloudChartpacksClose')?.addEventListener('click', () => {
    panel().style.display = 'none';
  });

  // Auto-refresh list every 60s while panel is open.
  setInterval(() => {
    if (panel().style.display !== 'none') loadCloudList();
  }, 60000);

  console.log('[cloud-chartpacks] library browser ready');
}

initCloudChartpacks();
