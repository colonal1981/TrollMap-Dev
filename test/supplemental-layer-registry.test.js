/**
 * test/supplemental-layer-registry.test.js — the last two hand-rolled layers stay migrated.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS FILE EXISTS
 *
 * Stage 7 moved layer identity, lazy build, add/remove, the visibility flag and the button
 * paint into js/core/layer-registry.js. supplemental-layers.js was migrated in halves: its
 * eight Garmin vector layers went through the registry, but `fishingSpots` and `pois` kept
 * their own `_fishingLayer` / `_poiLayer` handles, their own `_fishingVisible` /`_poiVisible`
 * flags, their own `_updateButtonState` painter and their own click listeners.
 *
 * That is four behaviours duplicated twice, and they had already drifted: the POI handler
 * remembered to redraw the labels after a toggle and the fishing handler had no equivalent to
 * forget. Nothing failed — which is exactly why it survived a stage that was meant to remove
 * it, and why this is a source-level assertion rather than a behavioural one.
 *
 * These are deliberately narrow. They do not test that a layer draws; they test that this
 * module is not keeping a second copy of the machinery that decides whether it draws.
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'js/modules/supplemental-layers.js'), 'utf8');

/** Source with comments stripped — an explanation that mentions `_poiVisible` is not a use. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('supplemental-layers uses the layer registry, not its own copy of it', () => {
  it('registers fishingSpots and pois', () => {
    for (const id of ['fishingSpots', 'pois']) {
      expect(CODE, `${id} is not registered`).toMatch(
        new RegExp(`layerRegister\\(\\{[\\s\\S]{0,200}id:\\s*'${id}'`));
    }
  });

  it('keeps no visibility flag of its own for either', () => {
    for (const flag of ['_fishingVisible', '_poiVisible']) {
      expect(CODE.includes(flag), `${flag} is back`).toBe(false);
    }
  });

  it('keeps no layer handle of its own for either', () => {
    for (const handle of ['_fishingLayer', '_poiLayer']) {
      expect(CODE.includes(handle), `${handle} is back`).toBe(false);
    }
  });

  it('does not paint toggle buttons itself', () => {
    // _updateButtonState() set background and colour by hand on two buttons the registry
    // already paints. Any reappearance means a third painter disagreeing with the registry
    // about what "on" looks like.
    expect(CODE.includes('_updateButtonState'), '_updateButtonState is back').toBe(false);
  });

  it('wires both buttons through the registry', () => {
    expect(CODE).toContain("layerWireButton('fishingSpots')");
    expect(CODE).toContain("layerWireButton('pois')");
  });

  it('drops both layers on a lake change so the next show refetches', () => {
    // The failure this prevents is the quiet one: keep the built layer across a lake change
    // and the new lake shows the old lake's docks.
    expect(CODE).toMatch(/layerDropAll\(\[\s*'fishingSpots',\s*'pois'\s*\]\)/);
  });

  it('the POI filters rebuild the layer rather than nulling a handle', () => {
    // toggleUnidentified and togglePoiOffWater change what the layer CONTAINS. Both used to
    // remove the layer and re-run the loader by hand; both now invalidate so the registry
    // refetches through the new filter.
    expect(CODE).toContain('layerInvalidate');
    const rebuilds = CODE.match(/rebuildPois\(\)/g) || [];
    expect(rebuilds.length, 'both POI filters should call rebuildPois()').toBeGreaterThan(2);
  });

  it('the build functions return a layer instead of assigning one', () => {
    // A build() that assigns a module singleton and adds to the map defeats the registry:
    // it would own the handle and the registry would own the flag, which is the split that
    // produced the drift in the first place.
    for (const fn of ['buildFishingLayer', 'buildPoiLayer']) {
      expect(CODE, `${fn} missing`).toContain(`async function ${fn}(`);
    }
    expect(CODE.includes('loadFishingSpots'), 'loadFishingSpots survived').toBe(false);
    expect(CODE.includes('loadPOIs'), 'loadPOIs survived').toBe(false);
  });
});
