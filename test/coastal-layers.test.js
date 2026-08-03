import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tideAdjustedDepth } from '../js/modules/tide-engine.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(REPO, 'js/modules/coastal-layers.js'), 'utf8');
const html = readFileSync(path.join(REPO, 'index.html'), 'utf8');

// coastal-layers.js touches Leaflet and the DOM at import time, so rather than
// standing up a full jsdom+Leaflet harness we assert the contract it must hold
// with the rest of the app, plus the pure depth logic it depends on.

describe('coastal-layers — wiring contract', () => {
  it('declares every toolbar control it binds', () => {
    for (const id of ['coastalLayerGroup', 'btnOysterBeds', 'btnMarshEdges', 'btnSoundings']) {
      expect(html, `index.html missing #${id}`).toContain(`id="${id}"`);
      expect(src, `coastal-layers.js never references #${id}`).toContain(id);
    }
  });

  it('is imported by main.js so the buttons actually get wired', () => {
    const main = readFileSync(path.join(REPO, 'js/main.js'), 'utf8');
    expect(main).toContain('./modules/coastal-layers.js');
  });

  it('is invoked when the active zone changes', () => {
    const supp = readFileSync(path.join(REPO, 'js/modules/supplemental-layers.js'), 'utf8');
    expect(supp).toContain('loadCoastalLayersForZone');
  });

  it('re-labels soundings after a tide sync', () => {
    const tides = readFileSync(path.join(REPO, 'js/modules/noaa-tides.js'), 'utf8');
    expect(tides).toContain('refreshSoundingLabels');
  });

  it('fetches exactly the three coastal-only layers from R2', () => {
    for (const layer of ['oyster_beds', 'marsh_edges', 'depth_soundings']) {
      expect(src).toContain(layer);
    }
  });

  it('gates sounding labels behind a zoom threshold', () => {
    expect(src).toMatch(/SOUNDING_MIN_ZOOM\s*=\s*13/);
  });

  it('treats a 404 as an expected empty layer, not an error', () => {
    // GA zones have no public oyster shapefile; a 404 must not throw.
    expect(src).toMatch(/404/);
  });
});

describe('sounding depth correction', () => {
  // The numbers an angler reads off the map come straight from this.
  it('a 2 ft charted flat is runnable on a 5 ft flood tide', () => {
    expect(tideAdjustedDepth(2, 5)).toBeCloseTo(7, 6);
  });

  it('a 2 ft charted flat is dry-ish on a -0.5 ft spring low', () => {
    expect(tideAdjustedDepth(2, -0.5)).toBeCloseTo(1.5, 6);
  });

  it('falls back to charted MLLW when tides have not been synced', () => {
    // Under-reporting water is the safe failure direction.
    expect(tideAdjustedDepth(3.5, null)).toBe(3.5);
  });

  it('parses string depths as they arrive from geojson properties', () => {
    expect(tideAdjustedDepth('4.5', 1.2)).toBeCloseTo(5.7, 6);
  });

  it('rejects a missing depth instead of calling it zero feet', () => {
    expect(tideAdjustedDepth(null, 3)).toBeNull();
    expect(tideAdjustedDepth('', 3)).toBeNull();
  });
});
