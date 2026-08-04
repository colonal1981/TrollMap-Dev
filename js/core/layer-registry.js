/**
 * core/layer-registry.js — one owner for every toggleable map layer.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 *   import { registerLayer, toggle, invalidate } from '../core/layer-registry.js';
 *
 *   registerLayer({
 *     id: 'oyster',
 *     button: 'btnOysterBeds',
 *     build: async () => buildOysterLayer(activeZone()),   // L.Layer, or null if no data
 *     enabled: () => !!activeZone(),
 *     emptyMessage: 'No oyster data for this zone',
 *   });
 *
 * WHY THIS EXISTS
 *
 * Fourteen layer buttons across nine modules, and every one of them re-implemented the same
 * five things by hand: a layer handle, a visible flag, a lazy build on first show,
 * addTo/removeLayer, and `btn.style.background = 'var(--accent)'`. gis-toggles.js carries
 * three verbatim copies inside a single file — BANK_LAYER/BANK_VISIBLE/BANK_DATA,
 * PADDLE_*, ATTRACTOR_* — and coastal-layers.js has a 34-line `toggle(kind)` that is the
 * same eleven lines pasted three times with the nouns changed.
 *
 * Ryan, 2026-08-02: "the bottom bar has 8 different buttons for layers on the map... there is
 * a lot of stuff that is bolted on that needs to be fixed."
 *
 * Duplicated state is not just verbose, it drifts. Of the nine modules, some track visibility
 * in a flag and some ask the map; some guard the lazy build and some do not; only some
 * restore button styling when a layer fails to load. Every one of those is a place where the
 * button says one thing and the map shows another.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not own layer CONTENT. `build()` stays in the module that knows how to draw the
 * thing — this owns identity, visibility, the lazy build, the map add/remove, and the button.
 * It also does not touch `window`. `window.toggleLayer` is ALREADY TAKEN by chart-import.js
 * for imported contour layers, which are a different thing with a different lifecycle, and
 * quietly redefining it would break the chart panel.
 */

/** id -> spec + runtime state. Insertion-ordered, which is the order buttons refresh in. */
const _layers = new Map();

/** Resolve the map lazily; modules import this at load time, long before the map exists. */
let _getMap = () => (globalThis.state?.MAP || globalThis.MAP || null);

/**
 * Point the registry at a different map accessor. Tests use this; the app does not need to.
 */
export function setMapAccessor(fn) {
  _getMap = typeof fn === 'function' ? fn : _getMap;
}

function mapOrNull() {
  try { return _getMap() || null; } catch { return null; }
}

/**
 * @typedef {Object} LayerSpec
 * @property {string}   id             unique key
 * @property {string}  [button]        element id of the toggle button
 * @property {Function} build          () => L.Layer | null | Promise<...>. Called at most
 *                                     once per invalidate(); null means "no data here".
 * @property {Function} [onShow]       called after the layer is added
 * @property {Function} [onHide]       called after the layer is removed
 * @property {Function} [enabled]      () => bool. False greys the button and blocks toggling.
 * @property {string}  [emptyMessage]  button tooltip when build() returns null
 * @property {boolean} [visible]       start visible (default false)
 * @property {string}  [activeBg]      default 'var(--accent)'
 * @property {string}  [activeColor]   default '#000'
 */

/**
 * Register a layer. Registering the same id twice replaces the spec but KEEPS the built
 * layer and its visibility, so a hot-reloaded module does not orphan a layer on the map.
 */
export function registerLayer(spec) {
  if (!spec || !spec.id) throw new Error('registerLayer: id is required');
  if (typeof spec.build !== 'function') throw new Error(`registerLayer(${spec.id}): build must be a function`);
  const prev = _layers.get(spec.id);
  _layers.set(spec.id, {
    activeBg: 'var(--accent)',
    activeColor: '#000',
    ...spec,
    layer: prev ? prev.layer : null,
    visible: prev ? prev.visible : !!spec.visible,
    building: null,
  });
  refreshButton(spec.id);
  return spec.id;
}

export function hasLayer(id) { return _layers.has(id); }
export function layerIds() { return [..._layers.keys()]; }
export function isVisible(id) { return !!_layers.get(id)?.visible; }
export function getLayer(id) { return _layers.get(id)?.layer || null; }
export function isEnabled(id) {
  const e = _layers.get(id);
  if (!e) return false;
  try { return typeof e.enabled === 'function' ? !!e.enabled() : true; } catch { return false; }
}

/**
 * Build the layer if it does not exist yet, exactly once even under concurrent calls.
 *
 * The in-flight promise matters. Double-clicking a button used to start two builds; both
 * resolved, both called addTo, and the first layer was left on the map with nothing holding
 * a reference to remove it. Every module had this bug because every module wrote
 * `if (!_layer) _layer = await build()` and an await is a place another click gets in.
 */
async function ensureBuilt(entry) {
  // `rebuild` layers are drawn FROM live app state rather than fetched -- casting rings from
  // state.DATA.waypoints, catch markers from state.CATCHES. Building those once and caching
  // means the second show draws the first show's waypoints, so they re-derive every time.
  if (entry.rebuild) { entry.layer = null; entry.building = null; }
  if (entry.layer) return entry.layer;
  if (!entry.building) {
    entry.building = (async () => {
      try { return (await entry.build()) || null; }
      finally { entry.building = null; }
    })();
  }
  entry.layer = await entry.building;
  return entry.layer;
}

/**
 * Show a layer. Resolves to true if it is now on the map, false if it could not be shown
 * (no map yet, disabled, or build() had no data).
 */
export async function show(id) {
  const e = _layers.get(id);
  if (!e || !isEnabled(id)) return false;
  const map = mapOrNull();
  if (!map) return false;

  const layer = await ensureBuilt(e);
  if (!layer) {
    // No data is not an error, but the button must not be left looking active.
    e.visible = false;
    if (e.button && e.emptyMessage) {
      const btn = document.getElementById(e.button);
      if (btn) btn.title = e.emptyMessage;
    }
    refreshButton(id);
    return false;
  }

  if (!map.hasLayer || !map.hasLayer(layer)) layer.addTo(map);
  e.visible = true;
  refreshButton(id);
  try { e.onShow?.(layer, map); } catch (err) { console.warn(`[layers] ${id} onShow failed:`, err); }
  return true;
}

/** Remove a layer from the map. Safe to call when it was never built or never shown. */
export function hide(id) {
  const e = _layers.get(id);
  if (!e) return false;
  const map = mapOrNull();
  if (map && e.layer && (!map.hasLayer || map.hasLayer(e.layer))) map.removeLayer(e.layer);
  e.visible = false;
  refreshButton(id);
  try { e.onHide?.(e.layer, map); } catch (err) { console.warn(`[layers] ${id} onHide failed:`, err); }
  return true;
}

/** Flip a layer. Resolves to the visibility it ended up at. */
export async function toggle(id) {
  return isVisible(id) ? (hide(id), false) : await show(id);
}

/**
 * Drop the built layer so the next show() rebuilds it. Use when the thing the layer is built
 * FROM changes — a new lake, a new coastal zone. Without this, switching lakes leaves the
 * previous lake's markers on the map, which is how coastal-layers.js behaved whenever
 * `_activeZoneKey` changed while a layer was up.
 *
 * @param {string} [id] omit to invalidate every layer.
 */
export function invalidate(id) {
  const ids = id === undefined ? layerIds() : [id];
  for (const key of ids) {
    const e = _layers.get(key);
    if (!e) continue;
    const wasVisible = e.visible;
    hide(key);
    e.layer = null;
    e.building = null;
    e.visible = false;
    if (wasVisible) show(key);      // fire and forget: rebuild for the new subject
  }
}

/**
 * Swap a layer's contents while keeping its identity and visibility.
 *
 * For layers whose markers are rebuilt from the same data against a changed parameter --
 * coastal soundings re-labelled for a new tide height -- where invalidate() would be wrong
 * because there is nothing to re-fetch and the rebuild is synchronous.
 */
export function replaceLayer(id, layer) {
  const e = _layers.get(id);
  if (!e) return null;
  const map = mapOrNull();
  if (map && e.layer && (!map.hasLayer || map.hasLayer(e.layer))) map.removeLayer(e.layer);
  e.layer = layer || null;
  e.building = null;
  if (e.visible && e.layer && map) {
    if (!map.hasLayer || !map.hasLayer(e.layer)) e.layer.addTo(map);
  }
  refreshButton(id);
  return e.layer;
}

/**
 * Hide and forget the built layers for these ids, WITHOUT rebuilding.
 *
 * The difference from invalidate() is that this does not re-show. Use it when the subject is
 * going away rather than changing -- switching from an estuary back to a freshwater lake,
 * where the coastal layers should end up down and off, not rebuilt for a zone that no
 * longer exists.
 *
 * @param {string[]} [ids] omit for every layer.
 */
export function dropAll(ids) {
  for (const id of (ids || layerIds())) {
    const e = _layers.get(id);
    if (!e) continue;
    hide(id);
    e.layer = null;
    e.building = null;
    e.visible = false;
    refreshButton(id);
  }
}

/** Paint one button to match its layer's state. */
export function refreshButton(id) {
  const e = _layers.get(id);
  if (!e || !e.button) return;
  if (typeof document === 'undefined') return;
  const btn = document.getElementById(e.button);
  if (!btn) return;
  const on = !!e.visible;
  const usable = isEnabled(id);
  btn.style.background = on ? e.activeBg : '';
  btn.style.color = on ? e.activeColor : '';
  btn.style.opacity = usable ? '' : '0.4';
  btn.disabled = !usable;
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  // Some buttons rename themselves with a count -- "Hide Rings (14)". Kept here so the label
  // cannot disagree with the state that decides it, which is what happened whenever an early
  // return skipped the text update but not the colour.
  if (typeof e.label === 'function') {
    try { btn.textContent = e.label(on, e.layer); }
    catch (err) { console.warn(`[layers] ${id} label failed:`, err); }
  }
}

/** Repaint every button. Call after anything that changes `enabled()` for several layers. */
export function refreshButtons() {
  for (const id of _layers.keys()) refreshButton(id);
}

/**
 * Wire a registered layer's button. Separate from registerLayer() because the button often
 * does not exist yet at import time — modules currently solve that with `setTimeout(init, 250)`
 * retry loops. Returns true once wired.
 */
export function wireButton(id) {
  const e = _layers.get(id);
  if (!e || !e.button || typeof document === 'undefined') return false;
  const btn = document.getElementById(e.button);
  if (!btn || btn.dataset.layerWired === id) return !!btn;
  btn.dataset.layerWired = id;
  btn.addEventListener('click', () => { toggle(id); });
  refreshButton(id);
  return true;
}

/**
 * Wire every registered layer that has a button in the DOM, retrying until they appear.
 * One retry loop for all layers instead of one per module.
 */
export function wireAll({ retries = 20, delayMs = 250 } = {}) {
  if (typeof document === 'undefined') return;
  const pending = layerIds().filter((id) => _layers.get(id).button && !wireButton(id));
  if (pending.length && retries > 0) {
    setTimeout(() => wireAll({ retries: retries - 1, delayMs }), delayMs);
  }
}

/** Test seam. Drops every layer from the map and forgets them. */
export function _reset() {
  for (const id of layerIds()) hide(id);
  _layers.clear();
}
