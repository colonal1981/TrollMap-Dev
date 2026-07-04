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

  // Capture the current map viewport as a JPEG base64 string.
  // Leaflet renders via multiple <img> tile elements — we composite them
  // onto a canvas to get a screenshot of what's visible.
  async function captureViewport() {
    const map = getMap();
    const container = map.getContainer();
    const w = container.clientWidth;
    const h = container.clientHeight;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    // Draw all visible tile images
    const imgs = container.querySelectorAll('.leaflet-tile-container img.leaflet-tile');
    const promises = [...imgs].map(img => new Promise(resolve => {
      if (img.complete && img.naturalWidth) {
        try {
          const r = img.getBoundingClientRect();
          const cr = container.getBoundingClientRect();
          ctx.drawImage(img, r.left - cr.left, r.top - cr.top, r.width, r.height);
        } catch (_) {}
        resolve();
      } else {
        img.onload = () => {
          try {
            const r = img.getBoundingClientRect();
            const cr = container.getBoundingClientRect();
            ctx.drawImage(img, r.left - cr.left, r.top - cr.top, r.width, r.height);
          } catch (_) {}
          resolve();
        };
        img.onerror = resolve;
      }
    }));
    await Promise.all(promises);

    // Return base64 JPEG (compressed — Grok vision doesn't need full quality)
    return {
      base64: canvas.toDataURL('image/jpeg', 0.82).split(',')[1],
      width: w,
      height: h,
    };
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
    setBanner('Capturing map view and running Grok vision — this may take 5-10 seconds...');

    try {
      const bounds = map.getBounds();
      const { base64, width, height } = await captureViewport();

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
          <span style="color:#888;font-size:11px">${f.fishing_notes || ''}</span>
        `);
        return marker;
      });

      structureLayer = L.layerGroup(markers).addTo(map);
      visible = true;

      setBanner(`Found ${features.length} structure${features.length === 1 ? '' : 's'}. ${data.image_notes || ''}`);
      btn.textContent = '🏗 Hide Structure';
      btn.style.background = '#4CAF50';
      btn.style.color = '#fff';

    } catch (e) {
      console.error('[structure-detection]', e);
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
