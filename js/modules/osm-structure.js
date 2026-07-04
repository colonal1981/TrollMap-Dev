import { state } from '../core/state.js';
import { setBanner } from '../core/map-init.js';

(function initOsmStructureModule() {
  const btn = document.getElementById('btnFetchOsm');
  if (!btn) return;

  let osmLayer = null;
  let osmVisible = false;
  let loading = false;

  function getMap() {
    return state?.MAP || window.MAP || null;
  }

  function mapReady() {
    return !!(state?.MAP_OK && getMap());
  }

  async function fetchAndDrawOsmStructure() {
    const map = getMap();
    if (!mapReady() || !map) {
      alert('Map is not ready.');
      return;
    }
    if (loading) return;
    loading = true;

    const bounds = map.getBounds();
    const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;

    const query = `
      [out:json][timeout:25][bbox:${bbox}];
      (
        way["man_made"="pier"];
        way["waterway"~"river|stream|canal"];
        way["historic"~"ruins|bridge"];
      );
      out geom;
    `;

    btn.textContent = '⏳ Querying OSM...';
    btn.style.background = 'var(--accent)';
    btn.style.color = '#000';
    setBanner('Fetching structure and waterways from OpenStreetMap...');

    try {
      const response = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!response.ok) {
        throw new Error(`Overpass API returned status ${response.status}`);
      }

      const osmData = await response.json();
      const geojsonData = osmtogeojsonFallback(osmData);
      if (!geojsonData.features.length) {
        alert('No relevant OSM features were found in the current map view.');
        osmVisible = false;
        return;
      }

      if (osmLayer) {
        map.removeLayer(osmLayer);
      }

      osmLayer = L.geoJSON(geojsonData, {
        style(feature) {
          let color = '#FFC107';
          const props = feature.properties || {};
          if (props.man_made === 'pier') color = '#03A9F4';
          if (props.historic) color = '#E91E63';
          if (props.waterway) color = '#FFFFFF';
          return { color, weight: 3, opacity: 0.8, fillOpacity: props.waterway ? 0 : 0.1 };
        },
        pointToLayer(feature, latlng) {
          const props = feature.properties || {};
          let emoji = '📍';
          let color = '#FFC107';
          if (props.man_made === 'pier') { emoji = '🛥️'; color = '#03A9F4'; }
          if (props.historic) { emoji = '🏚️'; color = '#E91E63'; }
          return L.circleMarker(latlng, {
            radius: 6,
            color,
            fillColor: color,
            fillOpacity: 0.9,
            weight: 2,
          }).bindPopup(buildPopup(props, emoji));
        },
        onEachFeature(feature, layer) {
          if (layer.getPopup && layer.getPopup()) return;
          const props = feature.properties || {};
          layer.bindPopup(buildPopup(props, '🧭'));
        },
      }).addTo(map);

      osmVisible = true;
      btn.textContent = '🙈 Hide OSM';
      setBanner(`✅ Loaded ${geojsonData.features.length} OSM features.`);
      setTimeout(() => setBanner(''), 3000);
    } catch (err) {
      alert('OSM Fetch Error: ' + err.message);
      console.error('OSM Fetch Error:', err);
      osmVisible = false;
    } finally {
      loading = false;
      if (!osmVisible) {
        btn.textContent = '🌐 Live OSM Structure';
        btn.style.background = '';
        btn.style.color = '';
      }
    }
  }

  function buildPopup(props, emoji) {
    const rows = [];
    if (props.name) rows.push(`<div><b>Name:</b> ${props.name}</div>`);
    if (props.historic) rows.push(`<div><b>Historic:</b> ${props.historic}</div>`);
    if (props.man_made) rows.push(`<div><b>Man-made:</b> ${props.man_made}</div>`);
    if (props.waterway) rows.push(`<div><b>Waterway:</b> ${props.waterway}</div>`);
    return `<div style="font-family:system-ui,sans-serif;font-size:13px;color:#111;min-width:180px"><b>${emoji} OSM Structure</b>${rows.join('')}</div>`;
  }

  btn.addEventListener('click', () => {
    const map = getMap();
    if (!mapReady() || !map) return;

    if (osmLayer) {
      if (osmVisible) {
        if (map.hasLayer(osmLayer)) map.removeLayer(osmLayer);
        osmVisible = false;
        btn.textContent = '🌐 Show OSM';
        btn.style.background = '';
        btn.style.color = '';
      } else {
        map.addLayer(osmLayer);
        osmVisible = true;
        btn.textContent = '🙈 Hide OSM';
        btn.style.background = 'var(--accent)';
        btn.style.color = '#000';
      }
      return;
    }

    fetchAndDrawOsmStructure();
  });

  function osmtogeojsonFallback(osm) {
    if (window.osmtogeojson) {
      return window.osmtogeojson(osm);
    }

    const features = [];
    const nodes = {};

    for (const el of osm.elements || []) {
      if (el.type === 'node') {
        nodes[el.id] = [el.lon, el.lat];
      }
    }

    for (const el of osm.elements || []) {
      if (el.type === 'way') {
        let coords;
        if (Array.isArray(el.geometry)) {
          // out geom format — geometry comes inline as [{lat,lon}]
          coords = el.geometry.map(p => [p.lon, p.lat]).filter(p => p[0] != null);
        } else if (Array.isArray(el.nodes)) {
          // out body + > format — resolve node ids from nodes dict
          coords = el.nodes.map((nid) => nodes[nid]).filter(Boolean);
        }
        if (coords && coords.length >= 2) {
          features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: coords },
            properties: el.tags || {},
          });
        }
      } else if (el.type === 'node' && el.tags && Object.keys(el.tags).length) {
        // only render tagged nodes as points, not bare geometry nodes
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [el.lon, el.lat] },
          properties: el.tags || {},
        });
      }
    }

    return { type: 'FeatureCollection', features };
  }

  console.log('✓ OSM structure module armed');
})();
