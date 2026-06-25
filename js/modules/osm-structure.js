// js/modules/osm-structure.js

import { state } from '../core/state.js';
import { setBanner } from '../core/map-init.js';

(function initImprovedOsmStructureModule() {
  const btn = document.getElementById('btnFetchOsm');
  if (!btn) return;

  let osmLayer = null;
  let osmVisible = false;

  // This function fetches from Overpass API and builds a GeoJSON layer
  async function fetchAndDrawOsmStructure() {
    if (!state.MAP_OK || !state.MAP) {
      alert('Map is not ready.');
      return;
    }

    const bounds = state.MAP.getBounds();
    const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;

    // Specific query targeting relevant bass-fishing structure (Docks, Rivers, Ruins)
    const query = `
      [out:json][timeout:30][bbox:${bbox}];
      (
        way["man_made"="pier"];
        way["waterway"~"river|stream|canal"];
        way["historic"~"ruins|bridge"];
      );
      out body;
      >;
      out skel qt;
    `;

    btn.textContent = '⏳ Querying OSM…';
    btn.style.background = 'var(--accent)';
    btn.style.color = '#000';
    setBanner('Fetching submerged structure & docks from OpenStreetMap...');

    try {
      const response = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'data=' + encodeURIComponent(query),
      });

      if (!response.ok) {
        throw new Error(`Overpass API returned status ${response.status}`);
      }

      const osmData = await response.json();
      
      // Use the fallback converter to create GeoJSON
      const geojsonData = osmtogeojsonFallback(osmData);

      if (!geojsonData.features.length) {
        alert('No relevant OSM features (docks, ruins, old riverbeds) found in the current map view.');
        return;
      }

      // Clear previous layer if it exists
      if (osmLayer) {
        state.MAP.removeLayer(osmLayer);
      }

      // Draw the new layer
      osmLayer = L.geoJSON(geojsonData, {
        style: function (feature) {
          let color = '#FFC107'; // Amber for default
          const props = feature.properties;
          if (props.man_made === 'pier') color = '#03A9F4'; // Blue for docks
          if (props.historic) color = '#E91E63'; // Pink for ruins
          if (props.waterway) color = '#FFFFFF'; // White for old river beds
          return { color: color, weight: 3, opacity: 0.8 };
        },
        onEachFeature: function (feature, layer) {
          const props = feature.properties;
          let popupContent = '<b>OSM Structure</b><br>';
          if (props.name) popupContent += `Name: ${props.name}<br>`;
          if (props.historic) popupContent += `Type: ${props.historic}<br>`;
          if (props.man_made) popupContent += `Type: ${props.man_made}<br>`;
          layer.bindPopup(popupContent);
        }
      }).addTo(state.MAP);

      osmVisible = true;
      btn.textContent = '🙈 Hide OSM';
      setBanner(`✅ Loaded ${geojsonData.features.length} OSM features.`);
      setTimeout(() => setBanner(''), 3000);

    } catch (err) {
      alert('OSM Fetch Error: ' + err.message);
      console.error("OSM Fetch Error:", err);
    } finally {
      if (!osmVisible) {
        btn.textContent = '🌐 Live OSM Structure';
        btn.style.background = '';
        btn.style.color = '';
      }
    }
  }

  // Main button logic
  btn.addEventListener('click', (event) => {
    if (osmLayer) {
      // Layer exists, so toggle visibility
      if (osmVisible) {
        state.MAP.removeLayer(osmLayer);
        osmVisible = false;
        btn.textContent = '🌐 Show OSM';
        btn.style.background = '';
        btn.style.color = '';
      } else {
        state.MAP.addLayer(osmLayer);
        osmVisible = true;
        btn.textContent = '🙈 Hide OSM';
        btn.style.background = 'var(--accent)';
        btn.style.color = '#000';
      }
    } else {
      // No layer yet, run the fetch
      fetchAndDrawOsmStructure();
    }
  });

  // A simple fallback converter since turf.js isn't used for this specific task
  function osmtogeojsonFallback(osm) {
    if (window.osmtogeojson) {
       return window.osmtogeojson(osm);
    }
    
    const features = [];
    const nodes = {};
    
    // Pass 1: Map all nodes
    osm.elements.forEach(el => {
        if (el.type === 'node') {
            nodes[el.id] = [el.lon, el.lat];
        }
    });
    
    // Pass 2: Map ways and standalone nodes with tags
    osm.elements.forEach(el => {
        if (el.type === 'way' && el.nodes) {
            const coords = el.nodes.map(nid => nodes[nid]).filter(Boolean);
            if (coords.length >= 2) {
                features.push({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: coords },
                    properties: el.tags || {}
                });
            }
        } else if (el.type === 'node' && el.tags) {
             features.push({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [el.lon, el.lat] },
                    properties: el.tags || {}
                });
        }
    });
    
    return { type: 'FeatureCollection', features };
  }

  console.log('✓ Improved OpenStreetMap structure module armed.');
})();
