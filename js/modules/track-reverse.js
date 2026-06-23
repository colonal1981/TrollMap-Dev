/**
 * Track Reversal Studio — append a reversed copy of the first
 * track to make a continuous-loop trolling pattern.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';

let loopActive = false;
let loopLayer = null;
let baseTrackPts = null;

const btn = document.getElementById('btnTrackReverse');
if (btn) {
  btn.addEventListener('click', () => {
    if (!state.MAP_OK) return;

    if (loopActive) {
      if (loopLayer) { state.MAP.removeLayer(loopLayer); loopLayer = null; }
      loopActive = false;
      btn.style.background = '';
      btn.style.color = '';
      btn.title = 'Toggle continuous loop — reverses selected track for return trolling pass';
      return;
    }

    const tracks = state.DATA.tracks;
    if (!tracks || !tracks.length) {
      alert('No tracks loaded. Load a GPX file with trolling lanes first.');
      return;
    }

    const t = tracks[0];
    if (!t.pts || t.pts.length < 2) {
      alert('Track has no coordinates to reverse.');
      return;
    }

    baseTrackPts = t.pts.map((p) => [p[0], p[1]]);
    const reversed = [...baseTrackPts].reverse().slice(1);  // drop duplicate midpoint
    const loopPts = [...baseTrackPts, ...reversed];

    if (loopLayer) state.MAP.removeLayer(loopLayer);
    loopLayer = L.polyline(loopPts, {
      color: '#76ff03',
      weight: 3,
      dashArray: '10, 6',
      opacity: 0.85,
    }).addTo(state.MAP);
    loopLayer.bindTooltip(`🔄 ${esc(t.name || 'Track 1')} — Loop (${loopPts.length} pts)`, { sticky: true });

    loopActive = true;
    btn.style.background = '#76ff03';
    btn.style.color = '#000';
    btn.title = 'Loop active — click to disable';
    state.MAP.fitBounds(loopLayer.getBounds(), { padding: [30, 30] });
    console.log(`✓ Track Reversal: ${baseTrackPts.length} pts → ${loopPts.length} loop pts`);
  });
}
