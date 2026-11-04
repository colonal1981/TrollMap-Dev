/**
 * wood-layer.js — the wood he has gone over, on the map, behind one button that is off by default.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-11-03: *"not necessarily looking for waypoints per se... i am more thinking for planning
 * purposes... i just don't want to clutter up the screen with waypoints so i am looking for
 * alternatives"*. So: a layer he turns on when he is planning, from the selected water's
 * wood.geojson (Scripts/build_wood.py), loaded the way osm-structure.js loads its file.
 *
 *   - one mark per piece, sized by its height against the tallest piece on that water
 *     (markRadiusPx() in js/utils/wood.js); a piece with no height -- never gone over, or read two
 *     ways -- is a hollow mark with no number
 *   - beside each mark, its top today ("6 ft"), or as read with its date where the water has no
 *     level ("10 ft on 11/1") -- see topToday()
 *   - tap it for every read: when, top over bottom, who read it, whether he confirmed it, the level
 *     then, and Claude's why
 *
 * TODAY'S LEVEL IS WHATEVER THE SELECTED WATER'S CONDITIONS ALREADY HOLD (conditions-strip.js). No
 * fetch is added for it. Until they arrive the tops are shown as read, with their dates, and the
 * marks are relabelled when they do.
 */
import { state, CF_WORKER_URL } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { registerLayer, wireButton, dropAll, refreshButton, replaceLayer, getLayer }
  from '../core/layer-registry.js';
import { belowFullPoolTodayFt } from '../utils/water-conditions.js';
import { heldConditions } from './conditions-strip.js';
import { woodPieces, topToday, woodMarkLabel, markRadiusPx, readByText, kindText, ftText, NO_TOP_KINDS }
  from '../utils/wood.js';

// THE LARGEST MARK, TAKEN FROM THE MAP'S OWN: osm-structure.js draws its biggest structure, a dam, at
// a 10 px radius. The tallest piece on a water is drawn that size and every other piece by area
// against it, so the wood sits in the range of everything else on the water.
const MAX_PX = 10;
const COLOR = '#a1887f';

(function initWoodLayer() {
  if (typeof document === 'undefined' || !document.getElementById('btnWood')) return;

  let _loading = false;
  let _none = false;        // the selected water has no wood.geojson
  let _lakeKey = null;      // the water the built layer is of
  let _fc = null;           // its wood.geojson, kept so a new level relabels without a refetch

  const getMap = () => state?.MAP || window.MAP || null;
  const mapReady = () => !!(state?.MAP_OK && getMap());
  const activeLakeKey = () => window._osmActiveLakeKey || null;

  async function fetchWood(lakeKey) {
    const r = await fetch(`${CF_WORKER_URL}/chartpacks/${lakeKey}/wood.geojson`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const gj = await r.json();
    return gj && Array.isArray(gj.features) && gj.features.length ? gj : null;
  }

  function readHtml(r) {
    const when = String(r.at || '').replace('T', ' ').slice(0, 16) || 'time not recorded';
    const depth = r.top_ft != null
      ? `top ${ftText(r.top_ft)} ft over ${r.bottom_ft != null ? `${ftText(r.bottom_ft)} ft` : 'a bottom not read'}`
      : `no top${r.bottom_ft != null ? ` (bottom ${ftText(r.bottom_ft)} ft)` : ''}`;
    const level = r.level_ft != null
      ? `lake at ${r.level_ft} ft${r.below_full_pool_ft != null ? `, ${r.below_full_pool_ft} below full pool` : ''}`
      : 'no level for this water';
    const why = r.claude_api && r.claude_api.why ? r.claude_api.why : null;
    const lines = [
      `<b>${esc(when)}</b> — ${esc(depth)}`,
      `read by ${esc(readByText(r.read_by))}; ${r.confirmed_by_ryan ? 'confirmed by you' : 'not confirmed by you'}`,
      esc(level),
      r.note ? `<i>${esc(r.note)}</i>` : '',
      r.desktop ? `desktop: ${esc(r.desktop)}` : '',
      why ? `Claude: ${esc(why)}` : '',
    ].filter(Boolean);
    return `<div style="margin-top:6px">${lines.join('<br>')}</div>`;
  }

  function buildWoodLayer(fc) {
    const pieces = woodPieces(fc);
    const below = belowFullPoolTodayFt(heldConditions(_lakeKey));
    const heights = pieces.map((p) => p.heightFt).filter((h) => Number.isFinite(h));
    const tallest = heights.length ? Math.max(...heights) : null;
    const group = L.layerGroup();
    for (const p of pieces) {
      const hollow = NO_TOP_KINDS.has(p.kind) || !Number.isFinite(p.heightFt);
      const top = topToday(p, below);
      const m = L.circleMarker([p.at[1], p.at[0]], {
        radius: hollow ? MAX_PX : Math.max(1, markRadiusPx(p.heightFt, tallest, MAX_PX)),
        color: COLOR, weight: 2, fillColor: COLOR, fillOpacity: hollow ? 0 : 0.85,
      });
      const label = hollow ? '' : woodMarkLabel(top);
      if (label) {
        m.bindTooltip(esc(label), { permanent: true, direction: 'right', offset: [6, 0],
                                    opacity: 0.85, className: 'wood-label' });
      }
      const head = `<b style="color:${COLOR}">🪵 ${esc(kindText(p))}</b>`
        + (top ? `<br>top ${esc(ftText(top.ft))} ft ${top.basis === 'today' ? 'at today\'s level'
                                                     : `as read on ${esc(top.on || '?')}`}` : '')
        + (p.seen ? `<br><span style="color:#aaa">seen ${esc(p.seen)}</span>` : '');
      const reads = p.reads.length ? p.reads.map(readHtml).join('')
        : '<div style="margin-top:6px">never gone over — no read</div>';
      m.bindPopup(`<div style="max-width:280px;font-size:12px">${head}${reads}`
                  + `<div style="color:#555;font-size:10px;margin-top:4px">${esc(p.id)}</div></div>`);
      group.addLayer(m);
    }
    return group;
  }

  registerLayer({
    id: 'wood',
    button: 'btnWood',
    activeBg: COLOR,
    activeColor: '#000',
    label: (on) => (_loading ? '⏳ Loading...' : _none ? '\u{1FAB5} No wood here'
                    : (on ? '\u{1FAB5} Hide Wood' : '\u{1FAB5} Wood')),
    enabled: () => mapReady() && !_loading,
    emptyMessage: 'No wood has been read on this water yet',
    build: async () => {
      const lakeKey = activeLakeKey();
      if (!lakeKey) return null;
      _loading = true;
      refreshButton('wood');
      try {
        const fc = await fetchWood(lakeKey);
        _lakeKey = lakeKey;
        _fc = fc;
        _none = !fc;
        return fc ? buildWoodLayer(fc) : null;
      } catch (e) {
        console.warn('[wood]', e.message);
        return null;
      } finally {
        _loading = false;
        refreshButton('wood');
      }
    },
  });

  // A NEW WATER IS NEW WOOD. Dropped, so the next press reads the new water's file.
  window.addEventListener('trollmap:lakeChanged', () => {
    dropAll(['wood']);
    _lakeKey = null; _fc = null; _none = false;
    refreshButton('wood');
  });

  // TODAY'S LEVEL ARRIVED: the same pieces, brought to it. Nothing is refetched.
  window.addEventListener('trollmap:conditions', (ev) => {
    const slug = ev && ev.detail && ev.detail.slug;
    if (!_fc || !slug || slug !== _lakeKey || !getLayer('wood')) return;
    replaceLayer('wood', buildWoodLayer(_fc));
  });

  wireButton('wood');
})();
