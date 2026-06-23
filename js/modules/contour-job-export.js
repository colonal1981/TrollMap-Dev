/**
 * Contour Job Export — drives the i-Boating → TrollMap contour
 * capture pipeline. After drawing a polygon in TrollMap, the user
 * clicks Run Capture Now and this module POSTs the job to a local
 * Python capture server which kicks off the build_contours.py run.
 *
 * Once the server reports "done", this module auto-imports the
 * resulting chartpack tiles back into TrollMap.
 */

(function initContourJobExport() {
  if (!window.MAP || !window.L) {
    setTimeout(initContourJobExport, 200);
    return;
  }

  const IBOATING_BASE = 'https://fishing-app.gpsnauticalcharts.com/i-boating-fishing-web-app/fishing-marine-charts-navigation.html';

  let contourLayer = null;
  let drawingMode = false;

  function clearContour() {
    if (contourLayer) {
      window.MAP.removeLayer(contourLayer);
      contourLayer = null;
    }
    document.getElementById('contourJobPanel').style.display = 'none';
  }

  function polygonCentroid(latlngs) {
    let lat = 0, lon = 0, n = 0;
    for (const p of latlngs) {
      // Leaflet LatLng exposes .lat and .lng
      lat += p.lat;
      lon += p.lng;
      n++;
    }
    return [lat / n, lon / n];
  }

  function showSavePanel(latlngs) {
    const [cLat, cLon] = polygonCentroid(latlngs);
    const zoom = window.MAP.getZoom();
    const iBoatingUrl = `${IBOATING_BASE}#${zoom.toFixed(1)}/${cLat.toFixed(7)}/${cLon.toFixed(7)}`;
    const bounds = L.latLngBounds(latlngs);
    const n = latlngs.length;

    const info = document.getElementById('contourJobInfo');
    info.innerHTML = `
      <div><b style="color:var(--accent)">${n}</b> points</div>
      <div>Centroid: <code>${cLat.toFixed(5)}, ${cLon.toFixed(5)}</code></div>
      <div>Zoom: <b style="color:var(--accent)">${zoom.toFixed(1)}</b></div>
      <div>Bounds: ${bounds.getNorth().toFixed(4)}°N to ${bounds.getSouth().toFixed(4)}°S<br>
                  ${bounds.getWest().toFixed(4)}°W to ${bounds.getEast().toFixed(4)}°E</div>
      <div style="margin-top:4px;word-break:break-all;font-size:10px;color:var(--muted)">${iBoatingUrl}</div>
    `;

    // Default job name
    const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const defaultName = `trollmap_${ts}_z${Math.round(zoom)}`;
    const nameInput = document.getElementById('contourJobName');
    if (!nameInput.value) nameInput.value = defaultName;

    document.getElementById('contourJobPanel').style.display = 'block';
  }

  function downloadJobJson(latlngs) {
    const [cLat, cLon] = polygonCentroid(latlngs);
    const zoom = window.MAP.getZoom();
    const source_url = `${IBOATING_BASE}#${zoom.toFixed(1)}/${cLat.toFixed(7)}/${cLon.toFixed(7)}`;

    // Convert Leaflet LatLng[] → [lon, lat][] for the Python script.
    const polygon = latlngs.map(p => [+p.lng.toFixed(7), +p.lat.toFixed(7)]);
    // Close the ring if not already closed.
    if (polygon.length && (polygon[0][0] !== polygon[polygon.length-1][0] || polygon[0][1] !== polygon[polygon.length-1][1])) {
      polygon.push(polygon[0]);
    }

    const rawName = (document.getElementById('contourJobName').value || 'trollmap_job').trim().replace(/[^A-Za-z0-9_\-]/g, '_');
    const filename = `${rawName}.json`;

    const job = {
      name: rawName,
      source_url,
      polygon,
      viewport: [2400, 1400],
      overlap: 0.25,
      wait: 12.0,
      retries: 4,
    };

    const blob = new Blob([JSON.stringify(job, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    return { filename, job };
  }

  // ── Wire up the toolbar button ──
  const btn = document.getElementById('btnDrawContour');
  btn?.addEventListener('click', () => {
    if (drawingMode) {
      // Already drawing — disable.
      window.MAP.drawer?.disable?.();
      drawingMode = false;
      btn.textContent = '✏️ Contour Area';
      btn.style.background = '';
      return;
    }
    clearContour();
    // Start a fresh polygon draw using Leaflet.Draw's Polygon handler.
    const drawer = new L.Draw.Polygon(window.MAP, {
      shapeOptions: { color: '#76ff03', weight: 3, fillOpacity: 0.1 },
      allowIntersection: false,
      showArea: false,
    });
    drawer.enable();
    drawingMode = true;
    btn.textContent = '✏️ Cancel';
    btn.style.background = 'rgba(118,255,3,.2)';

    window.MAP.once(L.Draw.Event.CREATED, (e) => {
      drawingMode = false;
      btn.textContent = '✏️ Contour Area';
      btn.style.background = '';

      // Remove previous polygon if any.
      if (contourLayer) window.MAP.removeLayer(contourLayer);
      contourLayer = e.layer;
      contourLayer.addTo(window.MAP);
      const latlngs = e.layer.getLatLngs()[0]; // outer ring
      showSavePanel(latlngs);
    });

    // If user cancels mid-draw, reset button state.
    window.MAP.once(L.Draw.Event.DRAWSTOP, () => {
      if (drawingMode) {
        drawingMode = false;
        btn.textContent = '✏️ Contour Area';
        btn.style.background = '';
      }
    });
  });

  document.getElementById('contourJobSave')?.addEventListener('click', () => {
    if (!contourLayer) return;
    const latlngs = contourLayer.getLatLngs()[0];
    const { filename, job } = downloadJobJson(latlngs);
    lastJob = job;
    const info = document.getElementById('contourJobInfo');
    const saved = document.createElement('div');
    saved.style.cssText = 'margin-top:6px;color:var(--accent2);font-weight:700';
    saved.textContent = `✓ Saved ${filename}`;
    info.appendChild(saved);
  });

  // ── Job Queue ──────────────────────────────────────────────────────────────
  let captureQueue = [];  // array of job objects
  let queueMapLayers = [];  // Leaflet layers showing queued job footprints
  window._trollmapCaptureQueue = captureQueue;
  window._trollmapRenderQueue = renderQueue;

  function clearQueueMap() {
    queueMapLayers.forEach(l => { try { window.MAP.removeLayer(l); } catch(_){} });
    queueMapLayers = [];
  }

  function drawQueueOnMap() {
    clearQueueMap();
    if (!window.MAP) return;
    const colors = ['#00e5ff','#76ff03','#ffb703','#ff5252','#b39ddb','#4dd0e1','#f48fb1'];
    captureQueue.forEach((job, idx) => {
      const color = colors[idx % colors.length];
      const b = job.bbox;
      if (!b) return;
      // Draw bbox rectangle
      const rect = L.rectangle(
        [[b.south, b.west],[b.north, b.east]],
        { color, weight: 2, dashArray: '6 4', fillOpacity: 0.08, interactive: false }
      ).addTo(window.MAP);
      // Label at center
      const lat = (b.north + b.south) / 2;
      const lon = (b.west + b.east) / 2;
      const label = L.marker([lat, lon], {
        icon: L.divIcon({
          className: '',
          html: `<div style="background:rgba(11,22,35,.85);color:${color};border:1px solid ${color};border-radius:4px;padding:2px 6px;font-size:10px;font-weight:700;white-space:nowrap">${idx+1}. ${job.name||'unnamed'}</div>`,
          iconAnchor: [0, 0]
        }),
        interactive: false
      }).addTo(window.MAP);
      queueMapLayers.push(rect, label);
    });
  }

  function renderQueue() {
    window._trollmapCaptureQueue = captureQueue;
    window._trollmapRenderQueue = renderQueue;
    drawQueueOnMap();
    const list = document.getElementById('contourQueueList');
    const runBtn = document.getElementById('contourQueueRun');
    const clearBtn = document.getElementById('contourQueueClear');
    if (!captureQueue.length) {
      list.innerHTML = '<span style="color:var(--muted)">Queue empty — draw polygons or load job JSONs</span>';
      runBtn.style.display = 'none';
      clearBtn.style.display = 'none';
      return;
    }
    list.innerHTML = captureQueue.map((j, idx) =>
      `<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
        <span style="color:var(--text)">${idx + 1}. ${j.name || 'unnamed'}</span>
        <button onclick="window._trollmapCaptureQueue.splice(${idx},1);window._trollmapRenderQueue()" style="background:none;border:none;color:var(--bad);cursor:pointer;font-size:12px;padding:0 4px">✕</button>
      </div>`
    ).join('');
    runBtn.style.display = '';
    clearBtn.style.display = '';
  }

  // Add current polygon to queue
  document.getElementById('contourJobQueue')?.addEventListener('click', () => {
    if (!contourLayer) { alert('Draw a polygon first'); return; }
    const latlngs = contourLayer.getLatLngs()[0];
    const rawName = (document.getElementById('contourJobName').value || '').trim().replace(/[^A-Za-z0-9_\-]/g, '_');
    const ts = new Date().toISOString().slice(0,10).replace(/-/g,'');
    const zoom = window.MAP ? Math.round(window.MAP.getZoom() * 10) / 10 : 17;
    const name = rawName || `trollmap_${ts}_z${Math.round(zoom)}`;
    const bounds = L.latLngBounds(latlngs);
    const polygon = latlngs.map(p => [+p.lng.toFixed(7), +p.lat.toFixed(7)]);
    if (polygon.length && (polygon[0][0] !== polygon[polygon.length-1][0] || polygon[0][1] !== polygon[polygon.length-1][1])) polygon.push(polygon[0]);
    const centLat = latlngs.reduce((a,p)=>a+p.lat,0)/latlngs.length;
    const centLon = latlngs.reduce((a,p)=>a+p.lng,0)/latlngs.length;
    const job = {
      name,
      source_url: `https://fishing-app.gpsnauticalcharts.com/i-boating-fishing-web-app/fishing-marine-charts-navigation.html#${zoom.toFixed(1)}/${centLat.toFixed(7)}/${centLon.toFixed(7)}`,
      polygon,
      bbox: { north: bounds.getNorth(), south: bounds.getSouth(), west: bounds.getWest(), east: bounds.getEast() },
      zoom,
    };
    captureQueue.push(job);
    renderQueue();
    document.getElementById('contourJobPanel').style.display = 'block';
    setBanner(`✅ Added "${name}" to queue (${captureQueue.length} total)`);
    setTimeout(()=>setBanner(''), 2000);
    // Clear polygon so user can draw next one
    clearContour();
    document.getElementById('contourJobName').value = '';
  });

  // Load job JSONs from file picker
  document.getElementById('contourQueueFileInput')?.addEventListener('change', async e => {
    const files = Array.from(e.target.files);
    for (const f of files) {
      try {
        const txt = await f.text();
        const job = JSON.parse(txt);
        if (!job.name) job.name = f.name.replace(/\.json$/i,'');
        captureQueue.push(job);
      } catch(err) { console.warn('Bad job JSON:', f.name, err); }
    }
    renderQueue();
    e.target.value = '';
    document.getElementById('contourJobPanel').style.display = 'block';
  });

  // Clear queue
  document.getElementById('contourQueueClear')?.addEventListener('click', () => {
    captureQueue = [];
    clearQueueMap();
    renderQueue();
  });

  // Run queue — sends jobs one at a time, waits for done/error before next
  document.getElementById('contourQueueRun')?.addEventListener('click', async () => {
    if (!captureQueue.length) return;
    if (!(await pingServer())) {
      alert('Capture server is offline.\n\nStart it in a terminal:\n  py trollmap_capture_server.py');
      return;
    }
    const runBtn = document.getElementById('contourQueueRun');
    const clearBtn = document.getElementById('contourQueueClear');
    runBtn.disabled = true;
    runBtn.textContent = '⏳ Running queue…';
    clearQueueMap();  // clear footprints when capture starts

    async function waitForIdle() {
      return new Promise((resolve) => {
        const t = setInterval(async () => {
          try {
            const r = await fetch(SERVER_BASE + '/status', { cache: 'no-store' });
            const s = await r.json();
            setStatusRow(s.status, s.tiles_saved, s.current_tile, s.elapsed_seconds, s.error);
            if (s.status === 'done' || s.status === 'idle' || s.status === 'error') {
              clearInterval(t);
              // Auto-import if done
              if (s.status === 'done' && s.chartpack_url) {
                const importBtn = document.getElementById('contourJobImport');
                importBtn.dataset.url = s.chartpack_url;
                importBtn.dataset.job = s.job_name || 'trollmap_job';
                document.getElementById('contourJobImportRow').style.display = 'block';
              }
              resolve(s.status);
            }
          } catch(e) { /* server hiccup, keep polling */ }
        }, 2000);
      });
    }

    const total = captureQueue.length;
    for (let i = 0; i < total; i++) {
      const job = captureQueue[0];
      renderQueue();
      setBanner(`▶ Running job ${i+1}/${total}: ${job.name}`);
      try {
        const r = await fetch(SERVER_BASE + '/capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(job),
        });
        const j = await r.json();
        if (!r.ok) {
          setBanner(`✕ Job ${job.name} rejected: ${j.error}`);
          setTimeout(()=>setBanner(''),3000);
        } else {
          setStatusRow('running', 0, '—', 0, null);
          if (statusPollTimer) clearInterval(statusPollTimer);
          statusPollTimer = setInterval(pollStatus, 1500);
          await waitForIdle();
          if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; }
        }
      } catch(e) {
        setBanner(`✕ Network error: ${e.message}`);
        setTimeout(()=>setBanner(''),3000);
      }
      captureQueue.shift();  // remove completed job
    }

    renderQueue();
    runBtn.disabled = false;
    runBtn.textContent = '▶ Run Queue';
    setBanner('✅ Queue complete');
    setTimeout(()=>setBanner(''),3000);
  });
  // ── End queue ──────────────────────────────────────────────────────────────

  document.getElementById('contourJobDiscard')?.addEventListener('click', () => {
    clearContour();
    document.getElementById('contourJobName').value = '';
  });

  document.getElementById('contourJobClose')?.addEventListener('click', () => {
    document.getElementById('contourJobPanel').style.display = 'none';
  });

  // ── Capture server integration (run capture now / auto-import) ──
  const SERVER_BASE = 'http://127.0.0.1:8765';
  let serverOnline = false;
  let lastJob = null;        // last job dict (from save)
  let statusPollTimer = null;

  async function pingServer() {
    const dot = document.getElementById('contourServerDot');
    const label = document.getElementById('contourServerStatus');
    try {
      const r = await fetch(SERVER_BASE + '/status', { cache: 'no-store' });
      if (!r.ok) throw new Error('status ' + r.status);
      serverOnline = true;
      dot.style.background = '#76ff03';
      label.textContent = 'Server: online';
      label.style.color = 'var(--accent2)';
      return true;
    } catch (e) {
      serverOnline = false;
      dot.style.background = '#ff5252';
      label.textContent = 'Server: offline (run py trollmap_capture_server.py)';
      label.style.color = 'var(--bad)';
      return false;
    }
  }

  // lastJob is set inside the Save button handler below.

  function setStatusRow(state, tiles, current, elapsed, error) {
    const row = document.getElementById('contourJobStatusRow');
    row.style.display = 'block';
    let color = 'var(--muted)';
    let text = '';
    if (state === 'idle')    { color = 'var(--accent2)'; text = 'Server idle'; }
    else if (state === 'running') {
      color = 'var(--warn)';
      text = `Capturing… tile ${current || '—'} (${tiles} done, ${elapsed}s)`;
    }
    else if (state === 'done') {
      color = 'var(--accent2)';
      text = `✓ Done — ${tiles} tiles in ${elapsed}s`;
    }
    else if (state === 'error') {
      color = 'var(--bad)';
      text = `✕ Error: ${error || 'unknown'}`;
    }
    row.innerHTML = `<div style="color:${color};font-weight:700">${text}</div>`;
  }

  async function pollStatus() {
    try {
      const r = await fetch(SERVER_BASE + '/status', { cache: 'no-store' });
      if (!r.ok) return;
      const s = await r.json();
      setStatusRow(s.status, s.tiles_saved, s.current_tile, s.elapsed_seconds, s.error);

      const runBtn = document.getElementById('contourJobRun');
      const cancelBtn = document.getElementById('contourJobCancel');
      const importRow = document.getElementById('contourJobImportRow');
      const importBtn = document.getElementById('contourJobImport');

      if (s.status === 'idle' || s.status === 'done' || s.status === 'error') {
        runBtn.style.display = '';
        cancelBtn.style.display = 'none';
        if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; }
      } else if (s.status === 'running') {
        runBtn.style.display = 'none';
        cancelBtn.style.display = '';
      }

      if (s.status === 'done' && s.chartpack_url) {
        importBtn.dataset.url = s.chartpack_url;
        importBtn.dataset.job = s.job_name || (lastJob && lastJob.name) || 'trollmap_job';
        importRow.style.display = 'block';
      } else {
        importRow.style.display = 'none';
      }
    } catch (e) {
      // server offline mid-poll; just try again next tick
    }
  }

  document.getElementById('contourJobRun')?.addEventListener('click', async () => {
    if (!lastJob) {
      alert('Save the job first (💾 Save job.json) so we have something to send.');
      return;
    }
    if (!(await pingServer())) {
      alert('Capture server is offline.\n\nStart it in a terminal:\n  py trollmap_capture_server.py');
      return;
    }
    try {
      const r = await fetch(SERVER_BASE + '/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lastJob),
      });
      const j = await r.json();
      if (!r.ok) {
        alert('Server rejected: ' + (j.error || r.status));
        return;
      }
      setStatusRow('running', 0, '—', 0, null);
      if (statusPollTimer) clearInterval(statusPollTimer);
      statusPollTimer = setInterval(pollStatus, 1500);
    } catch (e) {
      alert('Network error: ' + e.message);
    }
  });

  document.getElementById('contourJobCancel')?.addEventListener('click', async () => {
    try {
      await fetch(SERVER_BASE + '/cancel', { method: 'POST' });
    } catch (e) {}
  });

  // ── Auto-import chartpack via fetch + DataTransfer ──
  async function importChartpackFromServer(urlPrefix, jobName) {
    const importBtn = document.getElementById('contourJobImport');
    importBtn.disabled = true;
    importBtn.textContent = '⏳ Fetching tiles…';

    // Try to discover available tiles by listing the chartpack.
    // Fall back to "fetch known files" if /list doesn't know the path.
    const contoursUrl = `${SERVER_BASE}${urlPrefix}contours/`;
    const files = [];

    // Get list of sidecar JSONs (they pair with PNGs of the same stem).
    let tileNames = [];
    try {
      // We use a HEAD-style probe: try to fetch the manifest, which lists counts
      // but not names. We'll get names from the chartpack.json "bounds" or by
      // scanning. Simpler: ask the server to enumerate via /list, but that
      // gives chartpacks, not files. So we'll do a discovery via index.
      // For now, fetch chartpack.json which contains metadata only.
      // We'll brute-force discover by trying common tile name patterns.
      const meta = await fetch(`${SERVER_BASE}${urlPrefix}chartpack.json`).then(r => r.ok ? r.json() : null);
      // No filenames in meta — fall back to fetching row/col pairs by index.
      const total = meta?.tile_count || 0;
      for (let i = 0; i < total; i++) {
        // We don't know the row/col from index. Try a small id-space probe.
        // Strategy: fetch a sentinel via /chartpack/<name>/contours/R000_C000_contours.png
        // and stop when 404.
      }
      // Simpler reliable approach: list via sequential probing — fetch sidecar
      // JSONs by index guess. Instead, expose a /list_files endpoint? Use /list
      // which already returns chartpacks, not files.
      //
      // Simpler still: ask server for an index. We'll add this below.
      const idxResp = await fetch(`${SERVER_BASE}${urlPrefix}index.json`, { cache: 'no-store' });
      if (idxResp.ok) {
        const idx = await idxResp.json();
        tileNames = idx.tiles || [];
      }
    } catch (e) {
      console.warn('[contour-job] index discovery failed', e);
    }

    if (!tileNames.length) {
      // No index — abort with a clear message.
      importBtn.disabled = false;
      importBtn.textContent = '📥 Import chartpack';
      alert('Could not enumerate chartpack tiles.\nUse 📂 Import Batch and pick chartpack_' + jobName + '\\contours\\ manually.');
      return;
    }

    // Fetch every tile's PNG + sidecar JSON.
    for (const stem of tileNames) {
      try {
        const pngR = await fetch(`${contoursUrl}${stem}.png`);
        const jsonR = await fetch(`${contoursUrl}${stem}.georef.json`);
        if (!pngR.ok || !jsonR.ok) continue;
        const pngBlob = await pngR.blob();
        const jsonBlob = await jsonR.blob();
        files.push(new File([pngBlob], `${stem}.png`, { type: 'image/png' }));
        files.push(new File([jsonBlob], `${stem}.georef.json`, { type: 'application/json' }));
      } catch (e) {
        console.warn('[contour-job] failed to fetch', stem, e);
      }
    }

    if (!files.length) {
      importBtn.disabled = false;
      importBtn.textContent = '📥 Import chartpack';
      alert('Fetched 0 tiles. Check the server and try again.');
      return;
    }

    // Feed into the existing bulk-import path via DataTransfer.
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    const input = document.getElementById('batchImportInput');
    if (!input) {
      alert('TrollMap bulk importer not found in this page.');
      return;
    }
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));

    importBtn.disabled = false;
    importBtn.textContent = `✓ Imported ${files.length / 2} tiles`;
    setTimeout(() => { importBtn.textContent = '📥 Import chartpack'; }, 4000);
  }

  document.getElementById('contourJobImport')?.addEventListener('click', e => {
    const btn = e.currentTarget;
    importChartpackFromServer(btn.dataset.url, btn.dataset.job);
  });

  // Ping server on load; ping every 5s while the panel is open.
  pingServer();
  setInterval(() => {
    const panel = document.getElementById('contourJobPanel');
    if (panel && panel.style.display !== 'none') pingServer();
  }, 5000);

  console.log('[contour-job] export module ready');
})();
