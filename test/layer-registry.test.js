/**
 * test/layer-registry.test.js — one owner for layer visibility, and it stays one.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS FILE EXISTS
 *
 * Fourteen layer buttons across nine modules each hand-rolled the same layer handle, visible
 * flag, lazy build, addTo/removeLayer and button styling. `grep -ri "layer" test/` found no
 * test that ever toggled one, so every one of those copies was free to drift — and they had:
 * some tracked visibility in a flag, some asked the map, and only some restored the button
 * when a layer failed to load.
 *
 * The double-click test below is the one that matters most. Every module wrote
 * `if (!_layer) _layer = await build()`, and an `await` is a place a second click gets in.
 * Two builds resolved, both called addTo, and the first layer stayed on the map with nothing
 * holding a reference to remove it.
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as R from '../js/core/layer-registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

/** Smallest thing that behaves like a Leaflet map for the calls the registry makes. */
function fakeMap() {
  const on = new Set();
  return {
    on,
    hasLayer: (l) => on.has(l),
    removeLayer: (l) => { on.delete(l); },
    _add: (l) => on.add(l),
  };
}
function fakeLayer(name) {
  const l = { name, addTo(map) { map._add(this); return this; } };
  return l;
}

function useMap(map) { R.setMapAccessor(() => map); }

describe('layer-registry — registration', () => {
  it('requires an id and a build function', () => {
    R._reset();
    expect(() => R.registerLayer({})).toThrow();
    expect(() => R.registerLayer({ id: 'x' })).toThrow();
    expect(R.registerLayer({ id: 'x', build: () => null })).toBe('x');
    expect(R.layerIds()).toEqual(['x']);
    expect(R.hasLayer('x')).toBe(true);
  });

  it('re-registering keeps the built layer rather than orphaning it on the map', async () => {
    R._reset();
    const map = fakeMap(); useMap(map);
    const layer = fakeLayer('a');
    R.registerLayer({ id: 'a', build: () => layer });
    await R.show('a');
    expect(map.hasLayer(layer)).toBe(true);

    R.registerLayer({ id: 'a', build: () => fakeLayer('a2') });   // module re-imported
    expect(R.getLayer('a')).toBe(layer);       // same handle, still removable
    expect(R.isVisible('a')).toBe(true);
    R.hide('a');
    expect(map.hasLayer(layer)).toBe(false);   // ← the orphan case
  });
});

describe('layer-registry — show / hide / toggle', () => {
  it('toggles on and off and reports where it landed', async () => {
    R._reset();
    const map = fakeMap(); useMap(map);
    const layer = fakeLayer('t');
    R.registerLayer({ id: 't', build: () => layer });

    expect(R.isVisible('t')).toBe(false);
    expect(await R.toggle('t')).toBe(true);
    expect(map.hasLayer(layer)).toBe(true);
    expect(await R.toggle('t')).toBe(false);
    expect(map.hasLayer(layer)).toBe(false);
  });

  it('builds at most once across repeated shows', async () => {
    R._reset();
    const map = fakeMap(); useMap(map);
    let builds = 0;
    R.registerLayer({ id: 'lazy', build: () => { builds++; return fakeLayer('l'); } });
    await R.show('lazy'); R.hide('lazy'); await R.show('lazy'); await R.show('lazy');
    expect(builds).toBe(1);
  });

  it('a double click cannot build twice or strand a layer', async () => {
    // THE BUG THIS GUARDS. Two concurrent shows, one slow async build.
    R._reset();
    const map = fakeMap(); useMap(map);
    let builds = 0;
    R.registerLayer({
      id: 'slow',
      build: async () => { builds++; await new Promise((r) => setTimeout(r, 10)); return fakeLayer('s'); },
    });
    await Promise.all([R.show('slow'), R.show('slow'), R.show('slow')]);
    expect(builds).toBe(1);
    expect(map.on.size).toBe(1);
    R.hide('slow');
    expect(map.on.size).toBe(0);     // nothing left behind
  });

  it('adding twice does not duplicate, hiding twice does not throw', async () => {
    R._reset();
    const map = fakeMap(); useMap(map);
    R.registerLayer({ id: 'i', build: () => fakeLayer('i') });
    await R.show('i'); await R.show('i');
    expect(map.on.size).toBe(1);
    expect(R.hide('i')).toBe(true);
    expect(R.hide('i')).toBe(true);
    expect(map.on.size).toBe(0);
  });

  it('build() returning null leaves the layer hidden, not falsely active', async () => {
    // coastal-layers.js had this: no data for the zone, but _oysterVisible was already true,
    // so the button lit up over an empty map.
    R._reset();
    useMap(fakeMap());
    R.registerLayer({ id: 'empty', build: () => null, emptyMessage: 'no data here' });
    expect(await R.show('empty')).toBe(false);
    expect(R.isVisible('empty')).toBe(false);
    expect(await R.toggle('empty')).toBe(false);
  });

  it('with no map, show is a no-op rather than a crash', async () => {
    R._reset();
    useMap(null);
    R.registerLayer({ id: 'nomap', build: () => fakeLayer('n') });
    expect(await R.show('nomap')).toBe(false);
    expect(R.isVisible('nomap')).toBe(false);
  });

  it('an unknown id is inert', async () => {
    R._reset();
    useMap(fakeMap());
    expect(await R.show('ghost')).toBe(false);
    expect(R.hide('ghost')).toBe(false);
    expect(R.isVisible('ghost')).toBe(false);
    expect(R.getLayer('ghost')).toBeNull();
  });
});

describe('layer-registry — enabled()', () => {
  it('a disabled layer will not show', async () => {
    R._reset();
    useMap(fakeMap());
    let ok = false;
    R.registerLayer({ id: 'gated', build: () => fakeLayer('g'), enabled: () => ok });
    expect(R.isEnabled('gated')).toBe(false);
    expect(await R.show('gated')).toBe(false);
    ok = true;
    expect(await R.show('gated')).toBe(true);
  });

  it('an enabled() that throws reads as disabled instead of taking the app down', async () => {
    R._reset();
    useMap(fakeMap());
    R.registerLayer({ id: 'boom', build: () => fakeLayer('b'),
                      enabled: () => { throw new Error('zone lookup failed'); } });
    expect(R.isEnabled('boom')).toBe(false);
    expect(await R.show('boom')).toBe(false);
  });
});

describe('layer-registry — invalidate', () => {
  it('rebuilds against the new subject and drops the old markers', async () => {
    // Switching lakes used to leave the previous lake's layer on the map.
    R._reset();
    const map = fakeMap(); useMap(map);
    let zone = 'wateree';
    const built = [];
    R.registerLayer({ id: 'zoned', build: () => { const l = fakeLayer(zone); built.push(l); return l; } });

    await R.show('zoned');
    expect(built.length).toBe(1);
    const first = built[0];

    zone = 'marion';
    R.invalidate('zoned');
    await new Promise((r) => setTimeout(r, 5));      // invalidate re-shows asynchronously
    expect(built.length).toBe(2);
    expect(map.hasLayer(first)).toBe(false);          // old lake gone
    expect(map.hasLayer(built[1])).toBe(true);        // new lake up
    expect(built[1].name).toBe('marion');
  });

  it('a hidden layer is not resurrected by invalidate', async () => {
    R._reset();
    const map = fakeMap(); useMap(map);
    R.registerLayer({ id: 'off', build: () => fakeLayer('o') });
    R.invalidate('off');
    await new Promise((r) => setTimeout(r, 5));
    expect(map.on.size).toBe(0);
    expect(R.isVisible('off')).toBe(false);
  });

  it('invalidate() with no id covers every layer', async () => {
    R._reset();
    const map = fakeMap(); useMap(map);
    let n = 0;
    R.registerLayer({ id: 'p', build: () => fakeLayer('p' + n++) });
    R.registerLayer({ id: 'q', build: () => fakeLayer('q' + n++) });
    await R.show('p'); await R.show('q');
    const before = [...map.on];
    R.invalidate();
    await new Promise((r) => setTimeout(r, 5));
    for (const l of before) expect(map.hasLayer(l)).toBe(false);
    expect(map.on.size).toBe(2);
  });
});

describe('layer-registry — rebuild layers re-derive from live state', () => {
  it('a rebuild layer builds again on every show', async () => {
    // Casting rings come from state.DATA.waypoints and catch markers from state.CATCHES;
    // both change while the app runs. Caching the first draw meant loading a new GPX and
    // then toggling rings showed the PREVIOUS file's waypoints.
    R._reset();
    const map = fakeMap(); useMap(map);
    let n = 0;
    R.registerLayer({ id: 'live', rebuild: true, build: () => fakeLayer('gen' + (++n)) });

    await R.show('live'); R.hide('live');
    await R.show('live'); R.hide('live');
    expect(n).toBe(2);
    expect(map.on.size).toBe(0);      // each rebuild's predecessor was removed, not stranded
  });

  it('a rebuild layer that goes empty turns the button off', async () => {
    R._reset();
    useMap(fakeMap());
    let hasData = true;
    R.registerLayer({ id: 'maybe', rebuild: true, build: () => (hasData ? fakeLayer('m') : null) });
    expect(await R.show('maybe')).toBe(true);
    R.hide('maybe');
    hasData = false;
    expect(await R.show('maybe')).toBe(false);
    expect(R.isVisible('maybe')).toBe(false);
  });
});

describe('layer-registry — button labels', () => {
  it('label() drives the text and cannot disagree with the state', () => {
    // The old handlers set colour and text at separate statements, so an early return
    // could leave "Hide Rings (14)" on a button that was no longer showing anything.
    R._reset();
    const btn = { style: {}, dataset: {}, setAttribute() {}, textContent: 'start' };
    globalThis.document = { getElementById: (id) => (id === 'btnX' ? btn : null) };
    useMap(fakeMap());
    R.registerLayer({
      id: 'labelled', button: 'btnX', build: () => fakeLayer('x'),
      label: (on) => (on ? 'Hide (7)' : 'Show'),
    });
    expect(btn.textContent).toBe('Show');
    return R.show('labelled').then(() => {
      expect(btn.textContent).toBe('Hide (7)');
      R.hide('labelled');
      expect(btn.textContent).toBe('Show');
      delete globalThis.document;
    });
  });
});

describe('layer-registry — hooks', () => {
  it('onShow and onHide fire, and a throwing hook does not break the toggle', async () => {
    R._reset();
    const map = fakeMap(); useMap(map);
    const seen = [];
    R.registerLayer({
      id: 'h', build: () => fakeLayer('h'),
      onShow: () => { seen.push('show'); throw new Error('handler blew up'); },
      onHide: () => { seen.push('hide'); },
    });
    expect(await R.show('h')).toBe(true);
    expect(R.hide('h')).toBe(true);
    expect(seen).toEqual(['show', 'hide']);
  });
});

describe('layer-registry — it does not collide with chart-import', () => {
  it('the registry never assigns window.toggleLayer', () => {
    // chart-import.js owns window.toggleLayer for IMPORTED contour layers, which have a
    // different lifecycle. Redefining it would silently break the chart panel.
    const src = readFileSync(join(ROOT, 'js/core/layer-registry.js'), 'utf8');
    expect(/window\.\w+\s*=/.test(src.replace(/^\s*\*.*$/gm, ''))).toBe(false);
  });

  it('chart-import still owns it', () => {
    const src = readFileSync(join(ROOT, 'js/modules/chart-import.js'), 'utf8');
    expect(src.includes('window.toggleLayer = function toggleLayer')).toBe(true);
  });
});

describe('layer-registry — migrated modules keep no private visibility state', () => {
  // The point of the registry is that there is ONE answer to "is this layer up". A module
  // that keeps its own flag alongside is the drift coming back.
  const MIGRATED = [
    'js/modules/gis-toggles.js', 'js/modules/coastal-layers.js',
    'js/modules/ramps.js', 'js/modules/catch-plot.js',
    'js/modules/osm-structure.js',
    // casting-rings.js was here until 2026-08-07. Ryan: "cast rings can get completely
    // deleted when we have time." Superseded by the structure pipeline and the Garmin POIs.
  ];
  // supplemental-layers.js is PARTIALLY migrated and deliberately not in that list. Its eight
  // GARMIN_LAYERS entries lost their handle/flag pair to the registry on 2026-08-03; five
  // singleton layers did not -- _depthAreaVisible, _fishingVisible, _visionVisible,
  // _poiVisible, _labelsVisible. Those carry behaviour the others do not: depth areas recolour
  // on a tide change, and the POI layer is REBUILT rather than toggled whenever its filters
  // move. Listing the file here would assert a migration that has not happened.

  for (const rel of MIGRATED) {
    it(`${rel.split('/').pop()} has no private *_VISIBLE / _*Visible flag`, () => {
      const src = readFileSync(join(ROOT, rel), 'utf8')
        .split('\n').map((l) => l.replace(/\/\/.*$/, '')).filter((l) => !/^\s*\*/.test(l))
        .join('\n');
      const offenders = [...src.matchAll(/^\s*(?:let|var)\s+(\w*(?:VISIBLE|Visible)\w*)\s*=/gm)]
        .map((m) => m[1]);
      expect(offenders).toEqual([]);
    });

    it(`${rel.split('/').pop()} imports the registry`, () => {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(/from ['"][^'"]*core\/layer-registry\.js['"]/.test(src)).toBe(true);
    });
  }
});
