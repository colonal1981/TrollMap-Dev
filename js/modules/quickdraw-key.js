/**
 * Depth key — the legend for the one depth ladder.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * IT NO LONGER CARRIES ITS OWN COLOURS. It builds itself from depthLegend() in
 * js/utils/depth-palette.js, which is the same table depth polygons, contour lines and
 * soundings all colour from.
 *
 * It used to hardcode eight bands -- 0-10 / 10-20 / 20-28 / 28-36 / 36-45 / 45-55 / 55-65 /
 * 65+ -- in the pre-2026-08-07 colours. That made it the fourth private band table in the app,
 * and the one whose entire job is to tell you what the other three mean. After the palette
 * merge it was showing #d32f2f for everything under 10 ft while the map drew three different
 * reds there, so the legend disagreed with the water it was explaining. Ryan: "the depth key
 * needs to be updated to the new colors that you made as well."
 *
 * A legend that is generated cannot drift. If the ladder changes again, this changes with it
 * and nobody has to remember.
 *
 * The band NOTES are hand-written and keyed by depth range rather than by index, so adding or
 * splitting a band leaves the surrounding notes attached to the right water instead of sliding
 * up by one.
 */

import { depthLegend } from '../utils/depth-palette.js';

// Keyed on the band's lower edge. A band with no note renders without one rather than
// borrowing its neighbour's.
const NOTES = {
  0:  'Skinny — you are dragging',
  2:  'Flats and marsh edge / topwater',
  4:  'Shallow cover / squarebills, weedless',
  8:  'Secondary flats / squarebills',
  20: { text: 'Prime striper ledge / medium A-rig', color: '#76ff03' },
  28: { text: 'Deep river channel drop / 3oz A-rig', color: '#00e5ff' },
  36: 'Deep creek basins / spoons',
  45: 'Main lake deep channel grooves',
  55: 'Reservoir trench bottoms',
  65: 'Abyss / dam face channels',
};

(function initDepthKeyModule() {
  const btn = document.getElementById('btnQuickdrawKey');
  if (!btn) return;
  let keyOpen = false;

  const container = document.createElement('div');
  container.id = 'quickdrawColorKeyOverlay';
  container.className = 'no-print';
  container.style.cssText = 'position:absolute;top:12px;right:58px;z-index:650;'
    + 'background:rgba(11,22,35,0.92);border:1px solid var(--accent);border-radius:10px;'
    + 'padding:8px 12px;font-size:11px;box-shadow:0 4px 16px rgba(0,0,0,0.6);display:none;'
    + 'flex-direction:column;gap:3px;max-width:300px';

  const rows = depthLegend().map((band) => {
    const note = NOTES[band.min];
    const text = typeof note === 'string' ? note : (note?.text || '');
    const noteColor = typeof note === 'object' && note?.color ? note.color : '#aaa';
    const weight = typeof note === 'object' && note?.color ? 'font-weight:700;' : '';
    return '<div style="display:flex;align-items:center;gap:6px">'
      + `<span style="width:16px;height:12px;background:${band.color};border-radius:2px;`
      + 'display:inline-block;flex-shrink:0;border:1px solid rgba(255,255,255,.25)"></span>'
      + `<b style="color:#fff;width:58px;flex-shrink:0;font-weight:600">${band.label}</b>`
      + `<span style="color:${noteColor};${weight}overflow:hidden;text-overflow:ellipsis;`
      + `white-space:nowrap">${text}</span></div>`;
  }).join('');

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;border-bottom:1px solid var(--line);padding-bottom:4px">
      <b style="color:var(--accent);font-size:12px">\u{1F308} Depth Key</b>
      <button id="closeQuickdrawKey" style="background:none;border:none;color:#fff;font-size:14px;padding:0 4px;cursor:pointer">✕</button>
    </div>
    ${rows}
    <div style="margin-top:2px;font-size:10px;color:var(--muted);border-top:1px solid var(--line);padding-top:4px">
      Depth polygons, contour lines and soundings all colour from this ladder, so a colour
      means the same thing on every layer. On coastal water the shading follows the
      TIDE-CORRECTED depth &mdash; the bands do not move, the water does.
    </div>
    <div style="font-size:10px;color:var(--warn)">
      \u{1F4A1} Troll the colour EDGES. A band boundary is a contour you can follow at a glance.
    </div>
  `;
  document.getElementById('panel-map')?.appendChild(container);

  const setOpen = (open) => {
    keyOpen = open;
    container.style.display = open ? 'flex' : 'none';
    btn.style.background = open ? 'var(--accent)' : '';
    btn.style.color = open ? '#000' : '';
  };

  btn.addEventListener('click', () => setOpen(!keyOpen));
  document.getElementById('closeQuickdrawKey')?.addEventListener('click', () => setOpen(false));
})();
