/**
 * osm-structure.js — Structure Detection via Grok Vision
 *
 * Replaces the original OSM Overpass query approach (which returned unusable
 * state-wide stream networks). Instead captures the current map viewport as
 * a canvas screenshot and sends it to the /detect-structure worker route
 * (Grok grok-2-vision-1212) to identify docks, piers, boat ramps, timber,
 * and fish attractors visible in the satellite imagery.
 *
 * The worker converts pixel coordinates back to lat/lon using the bounds
 * passed with the request. Results are dropped as interactive markers on
 * the map and cached by viewport quadkey in R2 so repeat views don't
 * re-charge the API.
 */

import { state } from '../core/state.js';
import { setBanner } from '../core/map-init.js';

(function initStructureDetectionModule() {
  const btn = document.getElementById('btnFetchOsm');
  if (!btn) return;

  const WORKER_URL = (typeof CF_WORKER_URL !== 'undefined'
    ? CF_WORKER_URL
    : (window.CF_WORKER_URL || 'https://trollmap-worker.colonal1981.workers.dev'));

  const STRUCTURE_ICONS = {
    dock:          { emoji: '🪵', color: '#03A9F4', label: 'Dock' },
    pier:          { emoji: '🛟', color: '#03A9F4', label: 'Pier' },
    boat_ramp:     { emoji: '🛥️',  color: '#4CAF50', label: 'Boat Ramp' },
    boathouse:     { emoji: '🏠', color: '#FF9800', label: 'Boathouse' },
    fish_attractor:{ emoji: '🎣', color: '#E91E63', label: 'Fish Attractor' },
    timber:        { emoji: '🪵', color: '#795548', label: 'Timber/Log' },
    unknown:       { emoji: '📍', color: '#9E9E9E', label: 'Structure' },
  };

  let structureLayer = null;
  let visible = false;
  let loading = false;

  function getMap() { return state?.MAP || window.MAP || null; }
  function mapReady() { return !!(state?.MAP_OK && getMap()); }

  // How fine the grid is. 16x12 on an 800px-wide image → ~50x50px per cell,
  // which is plenty for Gemini to read the labels clearly.
  const GRID_COLS = 12; // A..L
  const GRID_ROWS = 9;  // 1..9

  function colLetter(i) {
    let s = '';
    i += 1;
    while (i > 0) {
      const rem = (i - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }

  // Burns a yellow grid (column letters across the top, row numbers down the
  // left) onto the captured blob and returns a new base64 JPEG plus the grid
  // geometry the worker needs for coordinate conversion.
  async function drawGridOverlay(blob, width, height) {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      const url = URL.createObjectURL(blob);
      im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
      im.onerror = reject;
      im.src = url;
    });

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);

    const cellW = width / GRID_COLS;
    const cellH = height / GRID_ROWS;

    // Grid lines — thin, semi-transparent yellow so imagery stays visible.
    ctx.strokeStyle = 'rgba(255,255,0,0.65)';
    ctx.lineWidth = 1;
    for (let c = 1; c < GRID_COLS; c++) {
      const x = Math.round(c * cellW);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let r = 1; r < GRID_ROWS; r++) {
      const y = Math.round(r * cellH);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }

    // Column letters along the top, row numbers along the left. Dark backing
    // box behind each label so it reads over bright imagery.
    ctx.font = 'bold 13px monospace';
    ctx.textBaseline = 'top';
    for (let c = 0; c < GRID_COLS; c++) {
      const label = colLetter(c);
      const x = c * cellW + 3;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x - 1, 0, ctx.measureText(label).width + 4, 15);
      ctx.fillStyle = '#FFFF00';
      ctx.fillText(label, x, 1);
    }
    for (let r = 0; r < GRID_ROWS; r++) {
      const label = String(r + 1);
      const y = r * cellH + 2;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, y - 1, ctx.measureText(label).width + 4, 15);
      ctx.fillStyle = '#FFFF00';
      ctx.fillText(label, 2, y);
    }

    const gridBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(gridBlob);
    });

    return { base64, gridCols: GRID_COLS, gridRows: GRID_ROWS };
  }

  // Fetch a satellite image of the current viewport directly from ESRI's
  // export endpoint — much faster and cleaner than trying to screenshot the
  // DOM with html2canvas (which re-fetches every tile through CORS and times
  // out on ESRI's servers). Returns { base64, width, height, bounds }.
  async function captureViewport() {
    const map = getMap();
    const bounds = map.getBounds();
    const size = map.getSize();

    // Calculate image dimensions that match the geographic aspect ratio
    // so ESRI doesn't pad/expand the bbox to fit a mismatched aspect ratio.
    const latRange = bounds.getNorth() - bounds.getSouth();
    const lonRange = bounds.getEast() - bounds.getWest();
    const cosLat = Math.cos((bounds.getCenter().lat) * Math.PI / 180);
    const geoAspect = (lonRange * cosLat) / latRange; // geographic width:height ratio

    // Fix width at 800, calculate height to match geographic ratio
    const W = 600;
    const H = Math.round(W / geoAspect);
    console.log(`[structure] Geographic aspect ratio: ${geoAspect.toFixed(3)}, requesting ${W}x${H}`);

    const bbox = [
      bounds.getWest(), bounds.getSouth(),
      bounds.getEast(), bounds.getNorth()
    ].join(',');

    const url = `https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?` +
      `bbox=${encodeURIComponent(bbox)}` +
      `&bboxSR=4326&imageSR=4326` +
      `&size=${W},${H}` +
      `&format=jpg&transparent=false&f=image`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) throw new Error(`ESRI export HTTP ${resp.status}`);
      const blob = await resp.blob();

      // Verify actual image dimensions match what we requested
      const actualDims = await new Promise(resolve => {
        const img = new Image();
        const objUrl = URL.createObjectURL(blob);
        img.onload = () => { URL.revokeObjectURL(objUrl); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
        img.onerror = () => { URL.revokeObjectURL(objUrl); resolve({ w: W, h: H }); };
        img.src = objUrl;
      });
      console.log(`[structure] ESRI image: requested ${W}x${H}, got ${actualDims.w}x${actualDims.h}`);

      // Burn the grid onto the actual downloaded image so labels line up
      // with exactly what Gemini will see.
      const { base64, gridCols, gridRows } = await drawGridOverlay(blob, actualDims.w, actualDims.h);

      return { base64, width: actualDims.w, height: actualDims.h, gridCols, gridRows };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function detectAndDraw() {
    const map = getMap();
    if (!mapReady() || !map) { alert('Map not ready.'); return; }
    if (loading) return;

    const zoom = map.getZoom();
    if (zoom < 15) {
      alert('Zoom in to at least level 15 before running structure detection. Docks aren\'t clearly visible at this scale.');
      return;
    }

    loading = true;
    btn.textContent = '⏳ Detecting...';
    btn.style.background = 'var(--accent)';
    btn.style.color = '#000';
    setBanner('Fetching satellite image and running Groq vision analysis — allow up to 30 seconds...');

    // Hide overlays so Groq sees clean satellite imagery only
    const hiddenLayers = [];
    if (state.CONTOUR_LAYER && map.hasLayer(state.CONTOUR_LAYER)) {
      map.removeLayer(state.CONTOUR_LAYER);
      hiddenLayers.push({ type: 'layer', layer: state.CONTOUR_LAYER });
    }
    const overlayPanes = ['markerPane', 'overlayPane', 'shadowPane'];
    const hiddenPanes = [];
    overlayPanes.forEach(pane => {
      const el = map.getPane(pane);
      if (el) { hiddenPanes.push({ el, prev: el.style.display }); el.style.display = 'none'; }
    });

    const restoreLayers = () => {
      hiddenLayers.forEach(h => { if (h.type === 'layer') map.addLayer(h.layer); });
      hiddenPanes.forEach(h => { h.el.style.display = h.prev; });
    };

    try {
      const bounds = map.getBounds();
      const { base64, width, height, gridCols, gridRows } = await captureViewport();

      console.log(`[structure] Sending to worker: ${width}x${height} grid=${gridCols}x${gridRows}, bounds N=${bounds.getNorth().toFixed(5)} S=${bounds.getSouth().toFixed(5)} E=${bounds.getEast().toFixed(5)} W=${bounds.getWest().toFixed(5)}`);

      const resp = await fetch(`${WORKER_URL}/detect-structure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_base64: base64,
          mime_type: 'image/jpeg',
          bounds: {
            north: bounds.getNorth(),
            south: bounds.getSouth(),
            east: bounds.getEast(),
            west: bounds.getWest(),
          },
          image_width: width,
          image_height: height,
          grid_cols: gridCols,
          grid_rows: gridRows,
        }),
      });

      if (!resp.ok) throw new Error(`Worker ${resp.status}`);
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Unknown error');

      const features = data.features || [];

      // Remove previous layer
      if (structureLayer) { map.removeLayer(structureLayer); structureLayer = null; }

      if (!features.length) {
        setBanner(`No structures detected. ${data.image_notes || ''}`);
        btn.textContent = '🏗 Structure';
        btn.style.background = '';
        btn.style.color = '';
        loading = false;
        return;
      }

      const markers = features.map(f => {
        const icon = STRUCTURE_ICONS[f.type] || STRUCTURE_ICONS.unknown;
        const conf = Math.round((f.confidence || 0) * 100);
        const marker = L.circleMarker([f.lat, f.lon], {
          radius: 8,
          color: icon.color,
          fillColor: icon.color,
          fillOpacity: 0.75,
          weight: 2,
        });
        marker.bindPopup(`
          <b>${icon.emoji} ${icon.label}</b><br>
          ${f.description || ''}<br>
          <i>Confidence: ${conf}%</i><br>
          <span style="color:#888;font-size:11px">${f.fishing_notes || ''}</span><br>
          <span style="color:#aaa;font-size:10px;font-family:monospace">grid: ${f.col}${f.row} ${f.position || ''} → ${f.lat?.toFixed(5)}, ${f.lon?.toFixed(5)}</span>
        `);
        return marker;
      });

      structureLayer = L.layerGroup(markers).addTo(map);
      visible = true;
      restoreLayers();
      setBanner(`Found ${features.length} structure${features.length === 1 ? '' : 's'}. ${data.image_notes || ''}`);
      btn.textContent = '🏗 Hide Structure';
      btn.style.background = '#4CAF50';
      btn.style.color = '#fff';

    } catch (e) {
      console.error('[structure-detection]', e);
      restoreLayers();
      setBanner(`Structure detection failed: ${e.message}`);
      btn.textContent = '🏗 Structure';
      btn.style.background = '';
      btn.style.color = '';
    }

    loading = false;
  }

  function toggle() {
    const map = getMap();
    if (!map) return;
    if (visible && structureLayer) {
      map.removeLayer(structureLayer);
      visible = false;
      btn.textContent = '🏗 Structure';
      btn.style.background = '';
      btn.style.color = '';
    } else if (structureLayer && !visible) {
      structureLayer.addTo(map);
      visible = true;
      btn.textContent = '🏗 Hide Structure';
      btn.style.background = '#4CAF50';
      btn.style.color = '#fff';
    } else {
      detectAndDraw();
    }
  }

  btn.addEventListener('click', toggle);
  console.log('✓ Structure Detection module armed (Grok Vision)');
})();
