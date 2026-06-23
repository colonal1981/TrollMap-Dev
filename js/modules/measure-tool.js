/**
 * Distance & Bearing Measurement Tool — click two points on the
 * map to get a great-circle distance (ft / mi / nm) + bearing
 * (compass quadrant) readout.
 */

import { state } from '../core/state.js';
import { distFt } from '../utils/geo.js';
import { setBanner } from '../core/map-init.js';

let measuring = false;
let measurePts = [];
let measurePolyline = null;
let measureTooltip = null;
let measureMarkers = null;

const btn = document.getElementById('btnMeasure');

function calcBearing(p1, p2) {
  const dLon = (p2.lng - p1.lng) * Math.cos((p1.lat + p2.lat) / 2 * Math.PI / 180);
  const dLat = p2.lat - p1.lat;
  const deg = (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return `${Math.round(deg)}° ${dirs[Math.round(deg / 22.5) % 16]}`;
}

function exitMeasure() {
  measuring = false;
  if (btn) {
    btn.style.background = '';
    btn.style.color = '';
    btn.textContent = '📏 Measure';
  }
  if (measureMarkers) measureMarkers.clearLayers();
  if (measurePolyline) { state.MAP.removeLayer(measurePolyline); measurePolyline = null; }
  if (measureTooltip)  { state.MAP.removeLayer(measureTooltip);  measureTooltip = null; }
  document.getElementById('map').style.cursor = '';
  setBanner('');
  if (state.MAP_OK) state.MAP.off('click', onMeasureClick);
}

function onMeasureClick(e) {
  measurePts.push(e.latlng);
  const m = L.circleMarker(e.latlng, {
    radius: 6,
    color: '#00e5ff',
    fillColor: '#ff5252',
    fillOpacity: 1,
    weight: 2,
  });
  measureMarkers.addLayer(m);

  if (measurePts.length === 1) {
    setBanner('📏 Click END spot to measure…');
    m.bindTooltip('Start', { permanent: true, direction: 'top', offset: [0, -5] }).openTooltip();
  } else if (measurePts.length >= 2) {
    const p1 = measurePts[0], p2 = measurePts[1];
    const nm = distFt([p1.lat, p1.lng], [p2.lat, p2.lng]) / 5280 / 1.15078;
    const mi = nm * 1.15078;
    const ft = mi * 5280;
    const bearing = calcBearing(p1, p2);
    const mid = L.latLng((p1.lat + p2.lat) / 2, (p1.lng + p2.lng) / 2);

    measurePolyline = L.polyline([p1, p2], {
      color: '#76ff03',
      weight: 3,
      dashArray: '8, 6',
      opacity: 0.9,
    }).addTo(state.MAP);

    measureTooltip = L.tooltip({
      permanent: true,
      direction: 'center',
      className: 'measure-readout',
    })
      .setLatLng(mid)
      .setContent(`<div style="background:rgba(11,22,35,.92);color:#76ff03;border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px;font-family:monospace;white-space:nowrap">
        ${ft < 5280 ? `${Math.round(ft)} ft` : `${mi.toFixed(2)} mi`} · ${nm.toFixed(2)} nm · ${bearing}
      </div>`)
      .addTo(state.MAP);
  }
}

if (btn) {
  btn.addEventListener('click', () => {
    measuring = !measuring;
    btn.style.background = measuring ? 'var(--accent)' : '';
    btn.style.color = measuring ? '#000' : '';
    btn.textContent = measuring ? '📏 Cancel' : '📏 Measure';
    if (!state.MAP_OK) return;
    if (measuring) {
      measurePts = [];
      if (!measureMarkers) measureMarkers = L.layerGroup();
      measureMarkers.clearLayers();
      if (measurePolyline) { state.MAP.removeLayer(measurePolyline); measurePolyline = null; }
      if (measureTooltip)  { state.MAP.removeLayer(measureTooltip);  measureTooltip = null; }
      measureMarkers.addTo(state.MAP);
      setBanner('📏 Click START spot on map…');
      document.getElementById('map').style.cursor = 'crosshair';
      state.MAP.on('click', onMeasureClick);
    } else {
      exitMeasure();
    }
  });
}
