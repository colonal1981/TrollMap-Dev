/**
 * layers-panel.js — the one place every map overlay is turned on and off.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS EXISTS
 *
 * `#mapToolBar` carried sixteen buttons in a single inline row. Thirteen of them were overlay
 * toggles, and on a phone the row became a horizontally-scrolling strip that ate the bottom
 * of the map — the part of the screen you are actually trying to look at from a kayak. They
 * had also drifted into two different layouts, because the coastal three live inside a
 * `<span id="coastalLayerGroup">` that hides itself on freshwater while the other ten sat
 * loose in the bar.
 *
 * Ryan, 2026-08-03: "there are 6 different freaking buttons in 2 different types of layout
 * that all do basically the same type of thing... and take up all of the space across the
 * bottom."
 *
 * THE BUTTONS ARE THE ORIGINALS
 *
 * They were MOVED in index.html, not replaced. `#btnRamps` is still `#btnRamps`, so
 * ramps.js's `getElementById('btnRamps')` still finds it, coastal-layers.js still hides
 * `#coastalLayerGroup` on freshwater, and core/layer-registry.js still paints them. This file
 * owns opening and closing the panel and nothing else — no layer state lives here, because
 * the entire point of the registry was that layer state lives in one place.
 */
import { refreshButtons } from '../core/layer-registry.js';

const PANEL = 'layersPanel';
const OPENER = 'btnLayers';

function panel() { return document.getElementById(PANEL); }
function opener() { return document.getElementById(OPENER); }

export function isOpen() {
  const p = panel();
  return !!p && p.style.display !== 'none';
}

export function open() {
  const p = panel();
  if (!p) return false;
  p.style.display = '';
  // Repaint from the registry on every open. A layer can be toggled from somewhere other
  // than its button — smart-plan turning on POIs, a lake change disabling the coastal
  // group — and a stale panel that says "off" over a visible layer is worse than no panel.
  refreshButtons();
  const btn = opener();
  if (btn) {
    btn.style.background = 'var(--accent)';
    btn.style.color = '#000';
    btn.setAttribute('aria-expanded', 'true');
  }
  return true;
}

export function close() {
  const p = panel();
  if (!p) return false;
  p.style.display = 'none';
  const btn = opener();
  if (btn) {
    btn.style.background = '';
    btn.style.color = '';
    btn.setAttribute('aria-expanded', 'false');
  }
  return true;
}

export function toggle() { return isOpen() ? close() : open(); }

function init() {
  const btn = opener();
  const p = panel();
  if (!btn || !p) { setTimeout(init, 250); return; }

  btn.setAttribute('aria-controls', PANEL);
  btn.setAttribute('aria-expanded', 'false');
  btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  document.getElementById('closeLayersBtn')?.addEventListener('click', close);

  // Clicking a layer button must NOT close the panel — turning on three layers in a row is
  // the normal case, and re-opening between each is exactly the fiddliness this replaces.
  //
  // The exception is a button that opens a panel of its own. #btnCustomVectors was the only
  // one and it went with the QuickDraw structure mapper on 2026-08-07, so nothing carries
  // `data-opens-panel` today -- the handler stays because it is three lines and a
  // panel-opening button is a normal thing to add back. Leaving this
  // one up would stack two panels over the map, and the one underneath is the one the user
  // has finished with. Marked in index.html with `data-opens-panel` rather than by id, so the
  // next one added does not need this file edited.
  p.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.closest('[data-opens-panel]')) close();
  });

  // Tapping the map closes it, so it never sits over the water you are trying to read.
  document.addEventListener('click', () => { if (isOpen()) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });

  console.log('✓ Layers panel ready');
}

init();
