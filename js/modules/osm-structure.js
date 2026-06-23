/**
 * OpenStreetMap Submerged Structure — fetches pre-impoundment
 * roadbeds, old bridges, historic ruins, and original river
 * centerlines from the OSM Overpass API. Result is added as a
 * vector layer (use addCustomVectorLayer from custom-vectors.js).
 */

(function initFetchOsmStructureModule(){
  const btn = document.getElementById('btnFetchOsm');
  if(!btn) return;
  let osmLayerNames = [];
  let osmVisible = false;

  btn.addEventListener('click', async (event) => {
    // Once fetched, the button becomes a simple show/hide toggle. Hold Shift while clicking to refresh/re-query.
    if(osmLayerNames.length && !event.shiftKey){
      if(osmVisible){
        osmLayerNames.forEach(n => window.CUSTOM_VECTOR_LAYERS?.[n] && MAP.removeLayer(window.CUSTOM_VECTOR_LAYERS[n]));
        osmVisible = false;
        btn.textContent = '🌐 Show OSM Structure';
        btn.style.background = ''; btn.style.color = '';
      } else {
        osmLayerNames.forEach(n => window.CUSTOM_VECTOR_LAYERS?.[n] && window.CUSTOM_VECTOR_LAYERS[n].addTo(MAP));
        osmVisible = true;
        btn.textContent = '🙈 Hide OSM Structure';
        btn.style.background = 'var(--accent)'; btn.style.color = '#000';
      }
      return;
    }

  
    if(!MAP_OK) return;
    const lakeName = document.getElementById('lakeSelect')?.value || document.getElementById('planLake')?.value || 'Active Bounding Area';
    const cleanLake = lakeName.split(',')[0].trim();
    
    // Get exact current Leaflet map view bounds
    const bounds = MAP.getBounds();
    const s = bounds.getSouth().toFixed(4);
    const n = bounds.getNorth().toFixed(4);
    const w = bounds.getWest().toFixed(4);
    const e = bounds.getEast().toFixed(4);

    btn.textContent = '⏳ Querying OSM Overpass…';
    btn.style.background = 'var(--accent)';
    btn.style.color = '#000';

    // Formulate robust Overpass API query for submerged roadbeds, original waterways, historical ruins, and old bridges
    const query = `[out:json][timeout:25][bbox:${s},${w},${n},${e}];
(
  way["highway"]["submerged"="yes"];
  way["submerged"="yes"];
  way["historic"];
  way["ruins"];
  way["waterway"="river"];
  way["waterway"="stream"];
  way["waterway"="canal"];
  way["bridge"="yes"]["submerged"="yes"];
  node["historic"];
  node["submerged"="yes"];
);
out body;
>;
out skel qt;`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!res.ok) throw new Error(`Overpass API server returned status ${res.status}`);
      const data = await res.json();
      if (!data || !data.elements) throw new Error('No elements in Overpass response');

      // Coordinate dictionary
      const nodes = {};
      data.elements.forEach(el => {
        if(el.type === 'node') nodes[el.id] = [el.lon, el.lat];
      });

      const features = [];
      data.elements.forEach(el => {
        const tags = el.tags || {};
        let name = tags.name || tags.Name || '';
        let category = 'Submerged Structure';
        let color = '#ff00ff';
        let dash = null;
        let weight = 3;

        if (tags.submerged === 'yes' || tags.ruins) {
          category = tags.highway ? `Inundated Old Roadbed (${tags.highway})` : 'Submerged Foundation / Ruin';
          color = '#ffb703'; // golden amber
          dash = '6, 6';
          weight = 4;
        } else if (tags.historic) {
          category = tags.historic === 'yes' ? 'Historic Submerged Landmark' : `Historic ${tags.historic}`;
          color = '#ffb703';
          dash = '6, 6';
          weight = 4;
        } else if (tags.waterway) {
          category = `Original ${tags.waterway.toUpperCase()} Centerline`;
          color = '#00e5ff'; // cyan
          dash = '4, 4';
          weight = 3;
        } else if (tags.highway) {
          category = `Historic Old Highway / Roadbed (${tags.highway})`;
          color = '#ff5252'; // red
          dash = '8, 4';
          weight = 3;
        }

        const dispName = name ? `${name} (${category})` : category;

        // Line features
        if (el.type === 'way' && el.nodes) {
          const coords = el.nodes.map(nid => nodes[nid]).filter(Boolean);
          if (coords.length >= 2) {
            features.push({
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: coords },
              properties: { name: dispName, category, color, dash, weight, tags }
            });
          }
        }
        // Independent Point POIs
        else if (el.type === 'node' && (tags.submerged === 'yes' || tags.historic || tags.ruins)) {
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [el.lon, el.lat] },
            properties: { name: dispName, category, color: '#ffb703', radius: 8, tags }
          });
        }
      });

      if (!features.length) {
        alert(`No submerged OSM roads, historic building ruins, or original river centerlines found inside this exact map view (${s}, ${w} to ${n}, ${e}).\n\nTry zooming out or moving to known inundated structural landmarks (like Lake Murray Dam or Wateree).`);
        return;
      }

      if(osmLayerNames.length){ osmLayerNames.forEach(n => window.removeCustomVectorLayer?.(n)); osmLayerNames = []; }
      const layerName = `OSM_Structure_${cleanLake.replace(/\s+/g, '_')}_${Date.now().toString().slice(-4)}`;
      const geojsonFC = { type: 'FeatureCollection', features };

      if(window.addCustomVectorLayer) {
        window.addCustomVectorLayer(layerName, geojsonFC);
      } else {
        // Direct fallback if addCustomVectorLayer not available
        L.geoJSON(geojsonFC, {
          style: f => ({ color: f.properties?.color || '#00e5ff', weight: f.properties?.weight || 3, dashArray: f.properties?.dash, opacity: 0.9 })
        }).addTo(MAP);
      }

      osmLayerNames = [layerName];
      osmVisible = true;
      btn.textContent = '🙈 Hide OSM Structure';
      btn.style.background = 'var(--accent)';
      btn.style.color = '#000';

      alert(`✅ Fetched ${features.length} OSM structure features.\n\nThe same button now toggles this OSM layer on/off. Shift-click it later to refresh/re-query.`);

    } catch(err) {
      alert(`OSM Overpass Query Error: ${err.message}\n\nPlease check your internet connection or verify Overpass API availability.`);
    } finally {
      if(!osmVisible){
        btn.textContent = osmLayerNames.length ? '🌐 Show OSM Structure' : '🌐 Live OSM Structure';
        btn.style.background = '';
        btn.style.color = '';
      }
    }
  });

  console.log('✓ OpenStreetMap Overpass live structure pull module armed.');
})();


/* ── Active Garmin Quickdraw 8-Band Depth Key & Tactical Trolling Guide ── */
