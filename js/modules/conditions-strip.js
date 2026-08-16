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

  if (c.flowCfs != null) {
    out.push(row('Flow', `${Math.round(c.flowCfs).toLocaleString()} ft³/s`
      + (c.flowGauge ? `<span class="cond-sub"> (${esc(c.flowGauge)})</span>` : '')));
  }
  if (c.stageFt != null) out.push(row('Stage', `${c.stageFt.toFixed(2)} ft`));

  if (c.waterTempF != null) {
    out.push(row('Water temp', `${c.waterTempF} °F`
      + (c.waterTempFrom === 'tailwater'
        ? `<span class="cond-sub"> — TAILWATER gauge${c.waterTempGauge ? ` (${esc(c.waterTempGauge)})` : ''}, below the dam, not the lake</span>`
        : c.waterTempGauge ? `<span class="cond-sub"> (${esc(c.waterTempGauge)})</span>` : '')));
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
