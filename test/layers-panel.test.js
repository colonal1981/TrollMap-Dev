/**
 * test/layers-panel.test.js — the bar stays slim and no toggle goes missing.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS FILE EXISTS
 *
 * The thirteen overlay toggles were MOVED out of #mapToolBar into #layersPanel, not
 * rewritten. That is what makes the change cheap — ramps.js still does
 * getElementById('btnRamps') and neither knows nor cares which container it sits in — and it
 * is also what makes it fragile: a button dropped during the move fails silently, because a
 * missing element and a button nobody clicked look identical to every module involved.
 *
 * So these are assertions about index.html itself. They fail loudly if a toggle is deleted,
 * duplicated, or quietly migrates back onto the bottom bar.
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const HTML = readFileSync(join(ROOT, 'index.html'), 'utf8');

/**
 * The overlay toggles that must live inside the panel.
 *
 * Was 13. btnCastingRings went with casting-rings.js on 2026-08-07 -- and this list is why
 * that deletion could not be done quietly: the count is asserted, so removing a button
 * without removing it here fails rather than passing with one fewer control on screen.
 */
const TOGGLES = [
  'btnRamps', 'btnBankPier', 'btnPaddle',
  'btnAttractors', 'btnFishingSpots', 'btnPOI', 'btnFetchOsm',
  'btnOysterBeds', 'btnMarshEdges', 'btnSoundings',
  'btnShowCatches',
];

function panelHtml() {
  const i = HTML.indexOf('id="layersPanel"');
  const j = HTML.indexOf('<div id="mapToolBar"');
  expect(i).toBeGreaterThan(0);
  expect(j).toBeGreaterThan(i);
  return HTML.slice(i, j);
}

function toolbarHtml() {
  const i = HTML.indexOf('<div id="mapToolBar"');
  const j = HTML.indexOf('id="basemap"', i);
  return HTML.slice(i, j);
}

describe('layers panel — every toggle survived the move', () => {
  for (const id of TOGGLES) {
    it(`${id} exists exactly once in the document`, () => {
      // Twice means the move copied instead of relocating, and two elements share an id:
      // getElementById returns the first, the registry paints the first, and the one the
      // user can see never changes colour.
      expect((HTML.match(new RegExp(`id="${id}"`, 'g')) || []).length).toBe(1);
    });

    it(`${id} is inside the panel, not the toolbar`, () => {
      expect(panelHtml().includes(`id="${id}"`)).toBe(true);
      expect(toolbarHtml().includes(`id="${id}"`)).toBe(false);
    });
  }

  // Counted from TOGGLES rather than written out, so the number in the name cannot go stale
  // the way "all 13" did the moment a button was removed.
  it(`the panel holds all ${TOGGLES.length} and nothing else`, () => {
    const ids = [...panelHtml().matchAll(/<button id="(btn\w+)"/g)].map((m) => m[1]);
    expect(ids.sort()).toEqual([...TOGGLES].sort());
  });
});

describe('layers panel — the bottom bar stayed slim', () => {
  it('holds only the opener and the three non-layer tools', () => {
    const ids = [...toolbarHtml().matchAll(/<(?:button|label) id="(\w+)"/g)].map((m) => m[1]);
    expect(ids).toEqual([
      'btnLayers',          // opens the panel
      'btnGarminParser',    // GPX import, a file input rather than an overlay
      'btnQuickdrawKey',    // a legend
      'btnGpsPanel',        // opens a panel
      'btnContourRoutes',   // opens a panel
    ]);
  });

  it('is far shorter than it was', () => {
    // 17 controls before. The number is asserted so a future addition to the bar is a
    // deliberate decision rather than a drift back to a scrolling strip.
    const n = (toolbarHtml().match(/<(?:button|label) id=/g) || []).length;
    expect(n).toBeLessThanOrEqual(6);
  });
});

describe('layers panel — the pieces other modules depend on', () => {
  it('coastalLayerGroup survived, so freshwater still hides the coastal three', () => {
    // coastal-layers.js does `getElementById('coastalLayerGroup').style.display = ...`.
    expect((HTML.match(/id="coastalLayerGroup"/g) || []).length).toBe(1);
    const grp = panelHtml();
    const i = grp.indexOf('id="coastalLayerGroup"');
    const j = grp.indexOf('</span>', i);
    const inside = grp.slice(i, j);
    for (const id of ['btnOysterBeds', 'btnMarshEdges', 'btnSoundings']) {
      expect(inside.includes(`id="${id}"`)).toBe(true);
    }
  });

  it('the opener and close button exist', () => {
    expect(HTML.includes('id="btnLayers"')).toBe(true);
    expect(HTML.includes('id="closeLayersBtn"')).toBe(true);
  });

  it('the layers panel still steps aside for a button that opens its own panel', () => {
    // A panel-opening button carries `data-opens-panel` and layers-panel.js closes itself when
    // one is clicked; without it two panels stack over the map and the one underneath is the
    // one you have finished with.
    //
    // #btnCustomVectors was the only marked button and it went with the QuickDraw structure
    // mapper on 2026-08-07, so ZERO buttons carry the attribute today. The handler is kept and
    // asserted anyway: it is three lines, a panel-opening button is a normal thing to add back,
    // and a mechanism deleted for being unused is a bug waiting to be re-discovered.
    //
    // Every marked button that DOES exist must be inside the panel -- vacuously true at zero,
    // and the assertion that starts working the moment one is added.
    const src = readFileSync(join(ROOT, 'js/modules/layers-panel.js'), 'utf8');
    expect(src.includes('[data-opens-panel]')).toBe(true);
    const marked = [...HTML.matchAll(/id="([^"]+)"\s+data-opens-panel/g)].map(m => m[1]);
    const inPanel = panelHtml();
    expect(marked.filter(id => !inPanel.includes(`id="${id}"`))).toEqual([]);
  });

  it('the panel starts hidden', () => {
    const tag = HTML.slice(HTML.indexOf('<div id="layersPanel"'), HTML.indexOf('>', HTML.indexOf('<div id="layersPanel"')));
    expect(/display:\s*none/.test(tag)).toBe(true);
  });

  it('main.js loads the panel module', () => {
    expect(readFileSync(join(ROOT, 'js/main.js'), 'utf8').includes("modules/layers-panel.js")).toBe(true);
  });

  it('the panel module holds no layer state of its own', () => {
    // If visibility state creeps in here, there are two answers to "is this layer up" again.
    const src = readFileSync(join(ROOT, 'js/modules/layers-panel.js'), 'utf8')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).filter((l) => !/^\s*\*/.test(l)).join('\n');
    expect(/^\s*(let|var)\s+\w*(VISIBLE|Visible|Layer|LAYER)\w*\s*=/m.test(src)).toBe(false);
    expect(/addTo\(|removeLayer\(/.test(src)).toBe(false);
  });
});

describe('layers panel — one style for all of them', () => {
  it('every toggle is styled by the panel rule, not per-button inline CSS', () => {
    // The two-layout problem: some buttons carried their own inline style, some did not.
    const inline = [...panelHtml().matchAll(/<button id="(btn\w+)"[^>]*style="([^"]+)"/g)]
      .map((m) => `${m[1]} (${m[2].slice(0, 30)})`);
    expect(inline).toEqual([]);
  });

  it('the stylesheet carries the panel rules', () => {
    for (const sel of ['.layers-panel', '.layer-group-title', '.layers-panel-head']) {
      expect(HTML.includes(sel)).toBe(true);
    }
  });
});
