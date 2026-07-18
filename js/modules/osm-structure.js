/**
 * osm-structure.js — OSM Structure Layer Toggle
 *
 * Loads osm-structures.geojson from R2 (supplemental/<lakeKey>/osm-structures.geojson)
 * and renders bridges, dams, piers, boat ramps, and islands as map markers.
 * Data is fetched once per lake and cached in IndexedDB via the supplemental
 * layer infrastructure.
 *
 * Populated by fetch_osm_structures.py which queries Overpass API.
 */

import { state, CF_WORKER_URL } from '../core/state.js';
import { esc } from '../utils/escape.js';

(function initOsmStructureModule() {
  const btn = document.getElementById('btnFetchOsm');
  if (!btn) return;

  const STRUCTURE_STYLE = {
    DAM:         { emoji: '🚧', color: '#F44336', label: 'Dam',          radius: 10 },
    ROAD_BRIDGE: { emoji: '🌉', color: '#2196F3', label: 'Road Bridge',  radius: 7  },
    RAIL_BRIDGE: { emoji: '🚂', color: '#9C27B0', label: 'Rail Bridge',  radius: 7  },
    FOOT_BRIDGE: { emoji: '🚶', color: '#00BCD4', label: 'Foot Bridge',  radius: 5  },
    BRIDGE:      { emoji: '🌉', color: '#2196F3', label: 'Bridge',       radius: 7  },
    PIER:        { emoji: '🪵', color: '#03A9F4', label: 'Pier/Dock',    radius: 5  },
    BOAT_RAMP:   { emoji: '🛥️',  color: '#4CAF50', label: 'Boat Ramp',   radius: 6  },
    ISLAND:      { emoji: '🏝️',  color: '#FF9800', label: 'Island',      radius: 6  },
    BREAKWATER:  { emoji: '🪨', color: '#795548', label: 'Breakwater',   radius: 5  },
    GROYNE:      { emoji: '🪨', color: '#795548', label: 'Groyne',       radius: 5  },
    WEIR:        { emoji: '🌊', color: '#00BCD4', label: 'Weir',         radius: 7  },
  };

  const DEFAULT_STYLE = { emoji: '📍', color: '#9E9E9E', label: 'Structure', radius: 5 };

  let _osmLayer   = null;
  let _visible    = false;
  let _loading    = false;
  let _lakeKey    = null;   // lake key for currently loaded layer

  function getMap()   { return state?.MAP || window.MAP || null; }
  function mapReady() { return !!(state?.MAP_OK && getMap()); }

  // Read active lake key from supplemental-layers' shared state
  function getActiveLakeKey() {
    // supplemental-layers.js exposes this via window for cross-module access
    return window._osmActiveLakeKey || null;
  }

  async function fetchOsmStructures(lakeKey) {
    const url = `${CF_WORKER_URL}/chartpacks/supplemental/${lakeKey}/osm-structures.geojson?v=${Date.now()}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const gj = await r.json();
    if (!gj?.features?.length) throw new Error('no OSM structures for this lake');
    return gj;
  }

  function buildLayer(gj) {
    const group = L.layerGroup();
    let count = 0;
    gj.features.forEach(feat => {
      const coords = feat.geometry?.coordinates;
      if (!coords) return;
      const p     = feat.properties || {};
      const type  = p.structure_type || 'UNKNOWN';
      const style = STRUCTURE_STYLE[type] || DEFAULT_STYLE;
      const name  = p.name ? esc(p.name) : style.label;

      const marker = L.circleMarker([coords[1], coords[0]], {
        radius:      style.radius,
        color:       '#fff',
        weight:      1.5,
        fillColor:   style.color,
        fillOpacity: 0.85,
      });

      const coordStr = `${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}`;
      const hwTag    = p.highway ? `<br><span style="color:#aaa;font-size:11px">Hwy: ${esc(p.highway)}</span>` : '';
      const rwTag    = p.railway ? `<br><span style="color:#aaa;font-size:11px">Rail: ${esc(p.railway)}</span>` : '';
      const opTag    = p.operator ? `<br><span style="color:#aaa;font-size:11px">Op: ${esc(p.operator)}</span>` : '';

      marker.bindTooltip(`${style.emoji} ${name}`, { sticky: true, direction: 'top', opacity: 0.9 });
      marker.bindPopup(`
        <b style="color:${style.color}">${style.emoji} ${name}</b><br>
        <span style="color:#ccc">${style.label}</span>
        ${hwTag}${rwTag}${opTag}
        <br><span style="color:#555;font-size:10px;font-family:monospace">${coordStr}</span>
        <br><span style="color:#555;font-size:10px">OSM ${esc(p.osm_type || '')}/${p.osm_id || ''}</span>
      `);

      group.addLayer(marker);
      count++;
    });
    console.log(`[osm-structure] rendered ${count} features`);
    return group;
  }

  function setBtn(state) {
    if (state === 'on') {
      btn.textContent = '🏗️ Hide Structure';
      btn.style.background = '#4CAF50';
      btn.style.color = '#fff';
    } else if (state === 'loading') {
      btn.textContent = '⏳ Loading...';
      btn.style.background = 'var(--accent)';
      btn.style.color = '#000';
    } else {
      btn.textContent = '🏗️ Structure';
      btn.style.background = '';
      btn.style.color = '';
    }
  }

  async function load() {
    const map = getMap();
    if (!mapReady() || !map) { alert('Map not ready.'); return; }

    const lakeKey = getActiveLakeKey();
    if (!lakeKey) { alert('Select a lake first.'); return; }

    // If already loaded for this lake, just show it
    if (_osmLayer && _lakeKey === lakeKey) {
      _osmLayer.addTo(map);
      _visible = true;
      setBtn('on');
      return;
    }

    // New lake or first load
    if (_osmLayer) { map.removeLayer(_osmLayer); _osmLayer = null; }
    _loading = true;
    setBtn('loading');

    try {
      const gj = await fetchOsmStructures(lakeKey);
      _osmLayer = buildLayer(gj);
      _lakeKey  = lakeKey;
      _osmLayer.addTo(map);
      _visible  = true;
      setBtn('on');
      console.log(`[osm-structure] loaded ${gj.features.length} features for ${lakeKey}`);
    } catch (e) {
      console.warn('[osm-structure]', e.message);
      setBtn('off');
      if (e.message.includes('404') || e.message.includes('no OSM')) {
        alert(`No OSM structure data for this lake yet.\nRun fetch_osm_structures.py to populate it.`);
      } else {
        alert(`Failed to load OSM structures: ${e.message}`);
      }
    }

    _loading = false;
  }

  function toggle() {
    const map = getMap();
    if (!map || _loading) return;

    if (_visible && _osmLayer) {
      map.removeLayer(_osmLayer);
      _visible = false;
      setBtn('off');
    } else {
      load();
    }
  }

  // Re-clear layer when lake changes so next click fetches fresh data
  window.addEventListener('trollmap:lakeChanged', () => {
    const map = getMap();
    if (_osmLayer && map) { map.removeLayer(_osmLayer); }
    _osmLayer = null;
    _visible  = false;
    _lakeKey  = null;
    setBtn('off');
  });

  btn.addEventListener('click', toggle);
  console.log('✓ OSM Structure module armed');
})();
