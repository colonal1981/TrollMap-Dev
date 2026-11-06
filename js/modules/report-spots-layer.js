/**
 * report-spots-layer.js -- the places the fishing reports name for this time of year, on the map, behind one button.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 11/6: "if the app can tell me that i should be throwing a certain type of topwater bait in a certain area at a
 * certain time i will do that". The water's kept reports (Scripts/reports_step.py) name places, and the reader put each
 * one on his chart (report_places.py). This draws the ones named within three weeks either side of the day he is
 * planning, in any year from 2008: one pin a place, sized by how many reports name it, labelled with its name and that
 * count. Tap one for what the reports there say, fish by fish: where the fish sat, the lures and which ones were
 * trolled, the time of day, the depths, and the guides' own words, dated. Every fish: he takes whatever bites.
 *
 * Read the same way the plan reads them (askThisWeek in reports-this-week.js: the gated /research/reports, his token),
 * so the pins and the plan's block are the same reports. The day is the Smart Plan's date (#planDate), else today.
 *
 * With no water picked the button is greyed and says so, rather than doing nothing (11/6, the wood button: "it does not
 * appear to do anything... nevermind... you have to have a lake selected first").
 */
import { state, CF_WORKER_URL } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { registerLayer, wireButton, dropAll, refreshButton } from '../core/layer-registry.js';
import { askThisWeek, placesThisWeek, WINDOW_DAYS, SINCE_YEAR } from './reports-this-week.js';

// A COLOUR NOTHING ELSE ON THE WATER USES: the depth shading runs red to purple and white, the wood is magenta, the OSM
// layer green. Amber, with the same black halo the wood uses so it reads on any ground.
const COLOR = '#ffb300';
const HALO = '#000';
const MIN_PX = 5;
const MAX_PX = 13;

/** The pin's radius: by the square root of the reports naming it, against the most-named place. */
export function pinRadiusPx(n, most) {
  if (!(n > 0) || !(most > 0)) return MIN_PX;
  return Math.round(MIN_PX + (MAX_PX - MIN_PX) * Math.sqrt(Math.min(n, most) / most));
}

const pairs = (xs, k = 4) => xs.slice(0, k).map(([w, n]) => `${w} ${n}`).join(', ');
const band = (b, what) => (b ? `${what} ${b.n === 1 ? `${b.mid} ft` : b.lo === b.hi ? `${b.lo} ft` : `${b.lo}-${b.hi} ft`}` : '');

/** The popup for one place. Pure, so the words are tested under node. */
export function spotHtml(p, { planDate, days = WINDOW_DAYS, since = SINCE_YEAR } = {}) {
  const head = `<b style="color:${COLOR}">📍 ${esc(p.name)}</b><br>`
    + `${p.n} report${p.n === 1 ? '' : 's'} within ${days} days of ${esc(planDate || 'today')}, ${esc(p.years || `${since} on`)}`
    + (p.far ? '<br><span style="color:#aaa">The chart prints this name in more than one spot; the pin is one of them.</span>' : '');
  const fish = p.fish.map((f) => {
    const bits = [
      f.position.length ? `sat ${pairs(f.position, 3)}` : '',
      f.lures.length ? f.lures.slice(0, 4).map((l) => `${l.lure} ${l.n}${l.trolled ? ` (trolled ${l.trolled})` : ''}`).join(', ') : '',
      f.times.length ? pairs(f.times, 3) : '',
      band(f.fishDepth, 'fish at'), band(f.waterDepth, 'over'),
      f.baitOnly ? `${f.baitOnly} bait only` : '',
    ].filter(Boolean);
    return `<div style="margin-top:4px"><b>${esc(f.name)} ${f.n}</b>${bits.length ? `: ${esc(bits.join('; '))}` : ''}</div>`;
  }).join('');
  const quotes = p.quotes.map((q) => `<div style="margin-top:6px;color:#333">${esc(q.d)} ${esc(q.src)}`
    + `${q.who && q.who.length ? ` (${esc(q.who.join(', '))})` : ''}: “${esc(q.t)}”</div>`).join('');
  return `<div style="max-width:300px;font-size:12px">${head}${fish}${quotes}</div>`;
}

/** The places with a spot on this water: not a river put at the edge of the lake's box. */
export const onTheWater = (places) => (places || []).filter((p) => !p.approx);

const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

(function initReportSpotsLayer() {
  if (typeof document === 'undefined' || !document.getElementById('btnReportSpots')) return;

  let _loading = false;
  let _none = null;          // why there is nothing to draw on the built water, said on the button

  const getMap = () => state?.MAP || window.MAP || null;
  const mapReady = () => !!(state?.MAP_OK && getMap());
  const activeLakeKey = () => window._osmActiveLakeKey || null;
  const planDate = () => {
    const v = document.getElementById('planDate')?.value || '';
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : today();
  };

  function build(places, date, tw) {
    const most = places.length ? places[0].n : 0;
    const group = L.layerGroup();
    for (const p of places) {
      const radius = pinRadiusPx(p.n, most);
      group.addLayer(L.circleMarker([p.lat, p.lon], { radius, color: HALO, weight: 5, opacity: 0.9, fill: false, interactive: false }));
      const m = L.circleMarker([p.lat, p.lon], { radius, color: '#fff', weight: 1.5, opacity: 1, fillColor: COLOR, fillOpacity: 0.9 });
      m.bindTooltip(esc(`${p.name} ${p.n}`), { permanent: true, direction: 'right', offset: [radius, 0], opacity: 0.85,
                                               className: 'wood-label' });
      m.bindPopup(spotHtml(p, { planDate: date, days: tw.days, since: tw.since }));
      group.addLayer(m);
    }
    return group;
  }

  registerLayer({
    id: 'reportSpots',
    button: 'btnReportSpots',
    activeBg: COLOR,
    activeColor: '#000',
    label: (on) => (_loading ? '⏳ Reading the reports...'
      : !activeLakeKey() ? '📍 Report spots (pick a lake)'
        : _none ? `📍 ${_none}` : (on ? '📍 Hide report spots' : '📍 Report spots')),
    enabled: () => mapReady() && !!activeLakeKey() && !_loading,
    emptyMessage: 'No report names a place on this water for this time of year',
    build: async () => {
      const slug = activeLakeKey();
      if (!slug) return null;
      _loading = true; _none = null;
      refreshButton('reportSpots');
      try {
        const date = planDate();
        const tw = await askThisWeek({ worker: CF_WORKER_URL, slug, date });
        if (!tw || tw.error) { _none = 'Reports could not be read'; console.warn('[report spots]', tw && tw.error); return null; }
        if (tw.none) { _none = 'No reports kept here'; return null; }
        // A RIVER THE READER COULD ONLY PUT AT THE EDGE OF THE LAKE'S BOX (`approx`) IS NOT PINNED: on Moultrie that put
        // "Cooper River 7" on the houses at Moncks Corner, below the dam (11/6). It is not a spot on this water.
        const places = onTheWater(placesThisWeek(tw));
        if (!places.length) { _none = 'No spots named this time of year'; return null; }
        return build(places, date, tw);
      } finally {
        _loading = false;
        refreshButton('reportSpots');
      }
    },
  });

  // A NEW WATER, OR A NEW DAY, IS NEW SPOTS: dropped, so the next press reads them again.
  const drop = () => { dropAll(['reportSpots']); _none = null; refreshButton('reportSpots'); };
  window.addEventListener('trollmap:lakeChanged', drop);
  document.getElementById('planDate')?.addEventListener('change', drop);

  wireButton('reportSpots');
})();
