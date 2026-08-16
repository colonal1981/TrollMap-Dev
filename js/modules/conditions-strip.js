/**
 * The state of the water, above the map, before you plan anything.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-08-16: *"is the only way to get any of this information to run a plan on a given
 * lake/river and look at the preview or html report?"* — it was. And before that, the box that
 * was supposed to show it (`utilityAssessmentBox`, `utilitySyncStatus`, `uTitle`, `uDesc`,
 * `uLink`, `syncDukeBtn`) appeared ZERO times in index.html, so `utility-sync.js` had been
 * painting into elements that do not exist. The only visible field it ever changed was Water
 * Temp; everything else went into hidden inputs and surfaced only in a generated report.
 *
 * Then: *"topbar might work but there might not be room for what i would actually want to know
 * before i start planning... current level, current water temp, current water clarity... and if
 * it is a river current flow rate and projected releases if applicable."*
 *
 * So: one line that always fits, and a card underneath it that does not have to. The line is
 * built by `conditionsStrip()` in js/utils/water-conditions.js, which is pure and tested; this
 * module is the DOM and the caching around it.
 */

import { CF_WORKER_URL } from '../core/state.js';
import { lakeRecordFor } from '../data/lake-registry.js';
import { fetchWaterConditions, conditionsStrip, levelSentence } from '../utils/water-conditions.js';

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();          // slug -> { at, c }
let openState = false;
let lastSlug = null;
let seq = 0;                      // guards against an out-of-order response

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (m) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function els() {
  return {
    bar: document.getElementById('condStrip'),
    line: document.getElementById('condLine'),
    caret: document.getElementById('condCaret'),
    card: document.getElementById('condCard'),
  };
}

function row(label, value) {
  return value ? `<div class="cond-row"><span class="cond-k">${esc(label)}</span>`
               + `<span class="cond-v">${value}</span></div>` : '';
}

/** The expanded card. Every number says where it came from and when. */
function cardHtml(rec, c) {
  if (!c || c.error) {
    return `<div class="cond-row"><span class="cond-v">`
         + `Live conditions could not be read${c && c.error ? `: ${esc(c.error)}` : ''}.`
         + `</span></div>`;
  }
  const out = [];

  if (c.belowFullPoolFt != null || c.levelFt != null) {
    const lines = [esc(levelSentence(c))];
    if (c.observedAt) lines.push(`<span class="cond-sub">observed ${esc(c.observedAt)}</span>`);
    if (c.levelUrl) lines.push(`<span class="cond-sub"><a href="${esc(c.levelUrl)}" target="_blank" rel="noopener">source page</a></span>`);
    out.push(row('Level', lines.join('<br>')));
  } else if (c.pending) {
    out.push(row('Level', `<span class="cond-sub">${esc(c.pending)}</span>`));
  }

  // A TARGET IS NOT A READING and the label says so on the same line as the number.
  if (c.usaceTargetFt != null) {
    out.push(row('Corps target', `${c.usaceTargetFt} ft`
      + `<span class="cond-sub"> — what ${esc(c.usaceProject || 'this project')} is supposed to be at today, not a reading</span>`));
  }

  if (c.currentKn != null || c.currentType) {
    out.push(row('Current', `${esc(c.currentType || '')} ${c.currentKn != null ? `${Math.abs(c.currentKn).toFixed(2)} kn` : ''}`.trim()
      + `<span class="cond-sub">${c.currentAt ? ` at ${esc(c.currentAt)}` : ''}`
      + `${c.currentStation ? ` · ${esc(c.currentStation)}` : ''} — NOAA CO-OPS MAX_SLACK prediction</span>`));
  }
  if (c.nextTide) {
    out.push(row('Next tide', `${esc(c.nextTide.type)} ${c.nextTide.ft != null ? `${c.nextTide.ft} ft` : ''}`.trim()
      + `<span class="cond-sub">${c.nextTide.at ? ` at ${esc(c.nextTide.at)}` : ''}`
      + `${c.tideStation ? ` · ${esc(c.tideStation)}` : ''} — MLLW, predicted</span>`));
  }
  if (c.tidalFlowCfs != null) {
    out.push(row('Net flow', `${Math.round(c.tidalFlowCfs).toLocaleString()} ft³/s`
      + '<span class="cond-sub"> — tidally filtered, USGS 72137. The raw discharge on a tidal '
      + 'river reverses twice a day; this is what is actually leaving.</span>'));
  }
  if (c.salinityPpt != null || c.conductanceUsCm != null) {
    const v = c.salinityPpt != null
      ? `${c.salinityPpt} ppt<span class="cond-sub"> — salinity, USGS 00480`
      : `${c.conductanceUsCm.toLocaleString()} µS/cm<span class="cond-sub"> — specific conductance, `
        + `USGS 00095. NOT converted to salinity: the conversion exists and a converted number `
        + `would look like a measurement without being one`;
    out.push(row('Salt', `${v}${c.saltGauge ? ` (${esc(c.saltGauge)})` : ''}.</span>`));
  }
  if (c.flowCfs != null) {
    out.push(row('Flow', `${Math.round(c.flowCfs).toLocaleString()} ft³/s`
      + (c.flowGauge ? `<span class="cond-sub"> (${esc(c.flowGauge)})</span>` : '')));
  }
  if (c.stageFt != null) {
    const vs = c.stageVsActionFt != null
      ? `<span class="cond-sub"> — ${Math.abs(c.stageVsActionFt).toFixed(2)} ft `
        + `${c.stageVsActionFt >= 0 ? 'ABOVE' : 'below'} action stage of ${c.floodActionFt} ft</span>`
      : '';
    out.push(row('Stage', `${c.stageFt.toFixed(2)} ft${vs}`));
  }
  if (c.floodCategory) {
    out.push(row('Flood status', `${esc(String(c.floodCategory).replace(/_/g, ' '))}`
      + '<span class="cond-sub"> — NWPS category</span>'));
  }
  if (c.flowAnomaly != null) {
    out.push(row('Flow vs normal', `${c.flowAnomaly > 0 ? '+' : ''}${c.flowAnomaly}`
      + `<span class="cond-sub"> — NOAA National Water Model anomaly`
      + `${c.flowAnomalyOf ? ` on ${esc(c.flowAnomalyOf)}` : ''}, published without units or a legend. `
      + `The sign is the usable part.</span>`));
  }
  if (c.generatingNow != null || c.generationNext) {
    const now = c.generatingNow === true ? '<b>generating now</b>'
              : c.generatingNow === false ? 'not generating' : '';
    const nxt = c.generationNext
      ? `<span class="cond-sub"> — next in the published schedule: `
        + `${esc(c.generationNext.generators)} generator${c.generationNext.generators === 1 ? '' : 's'}`
        + `${c.generationNext.day || c.generationNext.time ? ` ${esc([c.generationNext.day, c.generationNext.time].filter(Boolean).join(' '))}` : ''}</span>`
      : '';
    out.push(row('TVA generation', `${now}${nxt}`
      + '<span class="cond-sub"> — on a tailwater the generation IS the current.</span>'));
  }
  if (c.tvaVsGuideFt != null) {
    out.push(row('Vs guide curve', `${c.tvaVsGuideFt > 0 ? '+' : ''}${c.tvaVsGuideFt} ft`
      + `<span class="cond-sub"> — against today's seasonal target`
      + `${c.tvaGuideFt != null ? ` of ${c.tvaGuideFt} ft` : ''}. TVA runs a curve, not a full pool.</span>`));
  }
  if (c.droughtLevels && c.droughtLevels.length) {
    const at = c.droughtLevel;
    const lines = c.droughtLevels.map((d) =>
      `${esc(d.level)} at ${d.ft} ft${d.comment ? ` — ${esc(d.comment)}` : ''}`).join('<br>');
    out.push(row('Corps drought', at
      ? `<b>at ${esc(at.level)}</b><span class="cond-sub"> — ${esc(at.comment || 'no comment published')}</span><br><span class="cond-sub">${lines}</span>`
      : `<span class="cond-sub">above every published drought level.<br>${lines}</span>`));
  }
  if (c.gaugeOutOfService) {
    out.push(row('Gauge', `<b>OUT OF SERVICE</b>`
      + `<span class="cond-sub"> — ${esc(c.gaugeOutOfService.name || c.gaugeOutOfService.role)}`
      + `${c.gaugeOutOfService.message ? `: ${esc(c.gaugeOutOfService.message)}` : ''}. `
      + `A switched-off gauge and a gauge reading zero are not the same thing.</span>`));
  }

  if (c.waterTempF != null) {
    out.push(row('Water temp', `${c.waterTempF} °F`
      + (c.waterTempFrom === 'tide_station'
        ? `<span class="cond-sub"> — NOAA CO-OPS tide station${c.waterTempGauge ? ` (${esc(c.waterTempGauge)})` : ''}. No USGS site on this water.</span>`
        : c.waterTempFrom === 'tailwater'
        ? `<span class="cond-sub"> — TAILWATER gauge${c.waterTempGauge ? ` (${esc(c.waterTempGauge)})` : ''}, below the dam, not the lake</span>`
        : c.waterTempGauge ? `<span class="cond-sub"> (${esc(c.waterTempGauge)})</span>` : '')));
  }

  if (c.turbidityFnu != null) {
    out.push(row('Turbidity', `${c.turbidityFnu} FNU`
      + `<span class="cond-sub"> — MEASURED, USGS 63680${c.turbidityGauge ? ` (${esc(c.turbidityGauge)})` : ''}</span>`));
  }
  if (c.oxygenMgL != null) {
    out.push(row('Dissolved O₂', `${c.oxygenMgL} mg/L`
      + `<span class="cond-sub"> — USGS 00300${c.oxygenGauge ? ` (${esc(c.oxygenGauge)})` : ''}. `
      + `Below about 4 mg/L is not holding fish.</span>`));
  }

  if (c.clarity) {
    out.push(row('Clarity', `${esc(c.clarity)}`
      + (c.clarityIsMeasured
        ? '<span class="cond-sub"> — measured Secchi baseline, adjusted for recent rain</span>'
        : `<span class="cond-sub"> — MODELLED from rainfall. ${esc(c.clarityNote || 'No clarity measurements exist for this water.')}</span>`)));
  }

  if (c.releases) {
    const r = c.releases;
    const kind = r.kind === 'projected' ? 'projected arrivals'
               : r.kind === 'scheduled' ? 'published schedule'
               : 'observed right now — NOT a forecast';
    const items = (r.items || []).slice(0, 4).map((it) => {
      if (it.cfs != null) return `${Math.round(it.cfs).toLocaleString()} ft³/s ${esc(it.into || '')}`;
      if (it.arrival) return `${esc(it.arrival)} → ${esc(it.mileMarkerName || it.damName || '')}`;
      if (it.generators != null) return `${it.generators} generator${it.generators === 1 ? '' : 's'}`;
      return null;
    }).filter(Boolean);
    out.push(row(`Releases (${esc(r.operator || 'operator')})`,
      `<span class="cond-sub">${esc(kind)}</span>`
      + (items.length ? `<br>${items.map(esc).join('<br>')}` : '')));
  }

  if (c.releasesRefused) {
    const r = c.releasesRefused;
    out.push(row('Releases', `<span class="cond-sub">refused — ${esc(r.why || '')}</span>`));
  }

  return out.join('') || `<div class="cond-row"><span class="cond-v">Nothing published for this water.</span></div>`;
}

/**
 * The strip is position:fixed like everything else in this layout, so it does not take space in
 * the flow -- `--condH` is what makes room for it. Zero when there is nothing to report, which
 * leaves the app looking exactly as it did before.
 *
 * The first build of this made the strip a normal-flow child of #app. #topbar and #main are BOTH
 * position:fixed, so it rendered at the top of the document flow, underneath the fixed topbar,
 * and Ryan saw no change at all when he picked a lake.
 */
const STRIP_H = '26px';
function setRoom(on) {
  document.documentElement.style.setProperty('--condH', on ? STRIP_H : '0px');
}

function paint(rec, c) {
  const e = els();
  if (!e.bar) return;
  if (!rec) { e.bar.style.display = 'none'; if (e.card) e.card.style.display = 'none'; setRoom(false); return; }
  if (!rec.slug) openState = false;
  e.bar.style.display = '';
  setRoom(true);
  const s = conditionsStrip(c);
  const name = rec.displayName || rec.name || rec.slug;
  if (e.line) e.line.innerHTML = `<b>${esc(name)}</b> · ${esc(s.text)}`;
  e.bar.dataset.tone = s.tone;
  if (e.caret) e.caret.textContent = openState ? '▴' : '▾';
  // Leaflet sizes itself once and does not watch its container. Shrinking #main by 26px without
  // telling it leaves the map drawing into space it no longer has.
  setTimeout(() => { try { window.MAP?.invalidateSize?.(); } catch (_) {} }, 60);
  if (e.card) {
    e.card.style.display = openState ? '' : 'none';
    if (openState) {
      const notes = (s.footnotes || []).map((f) => `<div class="cond-note">${esc(f)}</div>`).join('');
      e.card.innerHTML = cardHtml(rec, c) + notes;
    }
  }
}

/** Read (or reuse) the conditions for a record and paint. */
export async function showConditionsFor(rec, opts = {}) {
  if (!rec || !rec.slug) { paint(null, null); return null; }
  lastSlug = rec.slug;
  const mine = ++seq;
  const hit = cache.get(rec.slug);
  if (hit && Date.now() - hit.at < CACHE_MS && !opts.force) { paint(rec, hit.c); return hit.c; }

  paint(rec, { ok: true, pending: 'reading…' });
  const worker = CF_WORKER_URL || window.CF_WORKER_URL;
  const c = await fetchWaterConditions(worker, rec, { date: opts.date });
  // A slower answer for a lake you already moved off must not overwrite the newer one.
  if (mine !== seq || lastSlug !== rec.slug) return c;
  cache.set(rec.slug, { at: Date.now(), c });
  paint(rec, c);
  return c;
}

/** Resolve whatever the picker holds and show it. */
export function refreshConditions(opts = {}) {
  const v = document.getElementById('lakeSelect')?.value
         || document.getElementById('planLake')?.value
         || '';
  if (!v) { paint(null, null); return Promise.resolve(null); }
  const rec = lakeRecordFor(v) || lakeRecordFor(v.split(',')[0].trim());
  if (!rec) {
    // A NAME THE PICKER OFFERS AND THE REGISTRY DOES NOT KNOW is a real defect, not a reason to
    // show nothing. Hiding the strip here would make a registry gap look like a working app.
    paint({ slug: null, displayName: v, name: v },
          { ok: true, error: null, pending: `"${v}" does not resolve to a registry record` });
    return Promise.resolve(null);
  }
  return showConditionsFor(rec, opts);
}

window.refreshConditions = refreshConditions;

function wire() {
  const e = els();
  if (!e.bar) return;
  e.bar.addEventListener('click', (ev) => {
    if (ev.target && ev.target.tagName === 'A') return;   // let the source link through
    openState = !openState;
    refreshConditions();
  });
  document.getElementById('lakeSelect')?.addEventListener('change', () => refreshConditions());
  document.getElementById('planLake')?.addEventListener('change', () => refreshConditions());
  document.getElementById('planDate')?.addEventListener('change', () => refreshConditions({ force: true }));
  refreshConditions();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
else setTimeout(wire, 300);
