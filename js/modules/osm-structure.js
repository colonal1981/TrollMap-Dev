/**
 * osm-structure.js — OSM Structure Layer Toggle
 *
 * Loads osm-structures.geojson from R2 ({lakeKey}/osm-structures.geojson)
 * and renders bridges, dams, piers, boat ramps, and islands as map markers.
 * Data is fetched once per lake and cached in IndexedDB via the supplemental
 * layer infrastructure.
 *
 * Populated by fetch_osm_structures.py which queries Overpass API.
 */

import { state, CF_WORKER_URL } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { registerLayer, wireButton, dropAll, refreshButton } from '../core/layer-registry.js';

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

  // The layer handle and its visibility live in core/layer-registry.js. What stays local is
  // _loading, which is button feedback rather than layer state, and _lakeKey, which is the
  // reason this layer gets dropped when you switch lakes.
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
    const url = `${CF_WORKER_URL}/chartpacks/${lakeKey}/osm-structures.geojson?v=${Date.now()}`;
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

  // setBtn() is gone: the registry paints background/colour from `activeBg`/`activeColor`
  // and the text from `label`, so on/off/loading can no longer disagree with each other.

  registerLayer({
    id: 'osmStructures',
    button: 'btnFetchOsm',
    activeBg: '#4CAF50',
    activeColor: '#fff',
    label: (on) => (_loading ? '\u23F3 Loading...' : (on ? '\u{1F3D7}\uFE0F Hide Structure' : '\u{1F3D7}\uFE0F Structure')),
    enabled: () => mapReady() && !_loading,
    build: async () => {
      const lakeKey = getActiveLakeKey();
      if (!lakeKey) { alert('Select a lake first.'); return null; }
      _loading = true;
      refreshButton('osmStructures');           // paint "Loading..." before the await
      try {
        const gj = await fetchOsmStructures(lakeKey);
        _lakeKey = lakeKey;
        console.log(`[osm-structure] loaded ${gj.features.length} features for ${lakeKey}`);
        return buildLayer(gj);
      } catch (e) {
        console.warn('[osm-structure]', e.message);
        if (e.message.includes('404') || e.message.includes('no OSM')) {
          alert(`No OSM structure data for this lake yet.\nRun fetch_osm_structures.py to populate it.`);
        } else {
          alert(`Failed to load OSM structures: ${e.message}`);
        }
        return null;                            // registry leaves the button off
      } finally {
        _loading = false;
        refreshButton('osmStructures');
      }
    },
  });

  // A different lake means different structures. Dropping the built layer makes the next
  // click re-fetch; the old code did this by hand and had to remember three variables.
  window.addEventListener('trollmap:lakeChanged', () => {
    dropAll(['osmStructures']);
    _lakeKey = null;
  });

  wireButton('osmStructures');
  console.log('✓ OSM Structure module armed');
})();
