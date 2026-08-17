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
import { camerasForWater, camerasOnWater, nearestSite, cameraFrame, ageLabel, MAX_RAMP_KM }
  from '../utils/cameras.js';
import { primeRegulations } from '../data/regulations-live.js';

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();          // slug -> { at, c }
let openState = false;
let lastSlug = null;
let seq = 0;                      // guards against an out-of-order response
let activeRamp = null;            // the launch the numbers are about, or null for the whole water

/**
 * The selected launch, as a point.
 *
 * lake-ramp-select.js writes `dataset.coords = "lat,lon"` onto every option it builds, so the
 * ramp's position is already in the DOM and needs no second trip through the access index — a
 * second lookup is a second thing that can disagree about where a ramp is.
 */
function selectedRamp() {
  const sel = document.getElementById('rampSelect');
  const opt = sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
  if (!opt || !opt.value || !opt.dataset || !opt.dataset.coords) return null;
  const [lat, lon] = String(opt.dataset.coords).split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { name: opt.value, lat, lon };
}

/**
 * The cameras that answer the question actually being asked.
 *
 * A RAMP IS A POINT AND A WATER IS NOT — the same split utils/cameras.js is built around. With
 * no launch selected the card shows every camera bound to the water; with one selected it shows
 * the nearest camera SITE and every view that site has. Ryan, 2026-08-17, seeing four Congaree
 * views after picking one landing: *"it would be nice to get the gauge and camera just for the
 * ramp that is selected."*
 *
 * Returns the count of what was dropped rather than dropping it silently. A launch 25 km from
 * every camera on its own river would otherwise show nothing, which reads as "this water has no
 * cameras" — and that is a different fact.
 */
function camerasFor(rec, ramp) {
  const all = camerasForWater(rec && rec.slug, rec && (rec.displayName || rec.name));
  if (!ramp) return { cams: all, scope: 'water', hidden: 0 };
  const near = nearestSite(
    camerasOnWater({ slug: rec && rec.slug, name: rec && (rec.displayName || rec.name) }),
    ramp.lat, ramp.lon);
  return { cams: near, scope: 'ramp', hidden: all.length - near.length };
}

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

/**
 * How far the number was measured from, once there is a launch to measure from.
 *
 * Silent with no ramp selected: the distance would be from the water's centroid, which is a
 * point nobody is standing at and a figure that would read as meaningful.
 */
function farLabel(km) {
  if (!activeRamp || !Number.isFinite(km)) return '';
  return km < 0.2 ? ' — at this launch'
       : ` — ${km < 10 ? km.toFixed(1) : Math.round(km)} km from this launch`;
}

function row(label, value) {
  return value ? `<div class="cond-row"><span class="cond-k">${esc(label)}</span>`
               + `<span class="cond-v">${value}</span></div>` : '';
}

/**
 * The cameras bound to this water, as a placeholder the card can paint synchronously.
 *
 * Ryan, 2026-08-16: *"for the cameras we have USGS would it be possible for those to be
 * displayed in the top bar now with all of the other information"*. They are FIRST in the card
 * on purpose — every other row is a number that describes the water and this is the water.
 *
 * A LAKE IS NOT A POINT, so this is every camera bound to the slug rather than the nearest one.
 * The ramp popup asks a different question and gets `nearestSite` instead. On the Congaree that
 * is four cameras from Columbia down to Fort Motte, which are four answers and not three worse
 * copies of one.
 *
 * The frames are NOT fetched here. This function is called on every strip toggle and a fetch
 * per toggle would be a request storm against a picture that changes every 15 minutes; the ids
 * ride in a data attribute and `fillCameras` reads them once the markup is in the document.
 */
function cameraRow(rec, ramp) {
  const { cams, scope, hidden } = camerasFor(rec, ramp);
  if (!cams.length) {
    // Nothing near the launch, but something on the water. Say so; do not render an absence.
    if (ramp && hidden > 0) {
      return row('Cameras', `<span class="cond-sub">none within ${MAX_RAMP_KM} km of `
        + `${esc(ramp.name)}. ${hidden} elsewhere on this water — clear the launch to see them.`
        + `</span>`);
    }
    return '';
  }
  const ids = cams.map((c) => c.camId).join(',');
  const where = scope === 'ramp' ? ` nearest ${esc(ramp.name)}` : '';
  return row('Cameras',
    `<div class="cond-cams" data-cams="${esc(ids)}">`
    + `<span class="cond-sub">reading ${cams.length} live view${cams.length === 1 ? '' : 's'}`
    + `${where}…</span></div>`
    + (hidden > 0
      ? `<span class="cond-sub">${hidden} more on this water, away from this launch.</span>`
      : ''));
}

/**
 * Replace each placeholder with the newest frame, or with why there isn't one.
 *
 * 22 of the 47 visible cameras in this footprint are DAYLIGHT ONLY. Open the app at 22:00 and
 * the newest frame is from 20:15 — a real image, correctly served, and completely misleading
 * with nothing next to it saying so. The age and the STALE flag are not decoration.
 */
async function fillCameras(card, token) {
  const box = card && card.querySelector ? card.querySelector('.cond-cams') : null;
  if (!box || box.dataset.camState) return;
  box.dataset.camState = 'loading';
  const ids = String(box.dataset.cams || '').split(',').filter(Boolean);
  const worker = CF_WORKER_URL || window.CF_WORKER_URL;

  const parts = [];
  for (const camId of ids) {
    let f = null;
    try {
      f = await cameraFrame(camId, { worker });
    } catch (err) {
      parts.push(`<div class="cond-sub" style="color:#e57373">\u{1F4F7} ${esc(camId)} — unreachable</div>`);
      continue;
    }
    if (!f || !f.urls || !f.urls.small) {
      parts.push(`<div class="cond-sub" style="color:#e57373">\u{1F4F7} ${esc(f && f.name || camId)}`
        + ` — ${esc((f && f.error) || 'no frame')}</div>`);
      continue;
    }
    parts.push(`
      <div style="margin-top:6px">
        <img class="cond-cam-img" src="${esc(f.urls.small)}" alt="${esc(f.name || camId)}" loading="lazy"
             style="width:100%;max-width:340px;border-radius:4px;display:block${f.stale ? ';opacity:.6' : ''}">
        <div class="cond-sub" style="color:${f.stale ? '#ffb74d' : '#aed581'}">\u{1F4F7} ${esc(f.name || camId)}`
        + ` · ${esc(ageLabel(f.ageMinutes))}${f.stale ? ' · STALE' : ''}`
        + `${f.period === 'daylight' ? ' · daylight only' : ''}</div>
      </div>`);
  }

  // A CARD REPAINTED WHILE THESE WERE IN FLIGHT IS A DIFFERENT CARD. Writing into the old one
  // would put the Congaree's camera under Lake Murray's numbers, which is the same class of bug
  // the sequence guard on the conditions fetch already exists to stop.
  if (token !== seq || !box.isConnected) return;
  box.innerHTML = parts.join('');
  box.dataset.camState = 'done';

  // Attached rather than inlined as onerror: the handler needs the element it replaces, and an
  // inline attribute is the first thing a content-security-policy would refuse.
  for (const img of box.querySelectorAll('.cond-cam-img')) {
    img.addEventListener('error', () => {
      const d = document.createElement('div');
      d.className = 'cond-sub';
      d.style.color = '#e57373';
      d.textContent = 'frame did not load';
      img.replaceWith(d);
    }, { once: true });
  }
}

/** The expanded card. Every number says where it came from and when. */
function cardHtml(rec, c) {
  if (!c || c.error) {
    // THE CAMERA IS NOT DOWNSTREAM OF THE GAUGE. NIMS is a different agency on a different
    // endpoint, and a water whose conditions could not be read is exactly when a picture of it
    // is worth the most.
    return cameraRow(rec, activeRamp)
         + `<div class="cond-row"><span class="cond-v">`
         + `Live conditions could not be read${c && c.error ? `: ${esc(c.error)}` : ''}.`
         + `</span></div>`;
  }
  const out = [cameraRow(rec, activeRamp)];

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
      + `${c.currentDirDeg != null ? ` setting ${Math.round(c.currentDirDeg)}°` : ''}`
      + `<span class="cond-sub">${c.currentAt ? ` at ${esc(c.currentAt)}` : ''}`
      + `${c.currentStation ? ` · ${esc(c.currentStation)}` : ''} — NOAA CO-OPS MAX_SLACK prediction</span>`));
  }
  if (c.surgeFt != null) {
    out.push(row('Surge', `${c.surgeFt > 0 ? '+' : '−'}${Math.abs(c.surgeFt).toFixed(2)} ft`
      + '<span class="cond-sub"> — measured level against the prediction for the same moment. '
      + 'A predicted tide is astronomy; a measured one carries the wind.</span>'));
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
      + (c.flowGauge ? `<span class="cond-sub"> (${esc(c.flowGauge)})${farLabel(c.flowGaugeKm)}</span>` : '')));
  }
  if (c.stageFt != null) {
    const vs = c.stageVsActionFt != null
      ? `<span class="cond-sub"> — ${Math.abs(c.stageVsActionFt).toFixed(2)} ft `
        + `${c.stageVsActionFt >= 0 ? 'ABOVE' : 'below'} action stage of ${c.floodActionFt} ft</span>`
      : '';
    const basis = c.stageBasis === 'elevation_above_datum'
      ? '<span class="cond-sub"> — elevation above datum, not gage height</span>'
      : c.stageBasis === 'gage_height' ? '<span class="cond-sub"> — gage height</span>' : '';
    out.push(row('Stage', `${c.stageFt.toFixed(2)} ft${vs}${basis}`
      + `${c.stageGauge ? `<span class="cond-sub"> (${esc(c.stageGauge)})${farLabel(c.stageGaugeKm)}</span>` : ''}`));
  }
  if (c.floodCategory) {
    out.push(row('Flood status', `${esc(String(c.floodCategory).replace(/_/g, ' '))}`
      + '<span class="cond-sub"> — NWPS category</span>'));
  }
  if (c.flowBand) {
    out.push(row('Flow vs history', esc(c.flowBand)
      + `<span class="cond-sub"> for today's date`
      + `${c.flowYears ? `, over ${c.flowYears} years` : ''}`
      + `${c.flowPeriod ? ` (${esc(c.flowPeriod)})` : ''}`
      + `${c.flowMedian != null ? `. Median for today is ${Math.round(c.flowMedian).toLocaleString()} ft³/s` : ''}. `
      + `USGS daily statistics — a band between published set points, not an interpolated `
      + `percentile.</span>`));
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
  if (c.tvaDischargeCfs != null || c.tvaTailwaterFt != null) {
    const bits2 = [];
    if (c.tvaDischargeCfs != null) bits2.push(`${Math.round(c.tvaDischargeCfs).toLocaleString()} ft³/s out`);
    if (c.tvaTailwaterFt != null) bits2.push(`tailwater ${c.tvaTailwaterFt} ft`);
    out.push(row('TVA discharge', bits2.join(' · ')
      + '<span class="cond-sub"> — the dam\u2019s own numbers, hourly average.</span>'));
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
  if (c.civilDawn || c.civilDusk) {
    out.push(row('Fishing light', `${esc(c.civilDawn || '—')} to ${esc(c.civilDusk || '—')}`
      + `<span class="cond-sub"> — civil twilight, which is when you can see to launch and to`
      + ` get off. Sun ${esc(c.sunrise || '—')} to ${esc(c.sunset || '—')}.</span>`));
  }
  if (c.moonPhase || c.moonIllumination) {
    out.push(row('Moon', `${esc(c.moonPhase || '')}${c.moonIllumination ? ` · ${esc(c.moonIllumination)} lit` : ''}`));
  }
  if (c.popPct != null) {
    out.push(row('Rain chance', `${c.popPct}%`
      + '<span class="cond-sub"> — first forecast period.</span>'));
  }
  if (c.unpublished) {
    out.push(row('Not published', c.unpublished.map((u) => esc(u.label)).join(', ')
      + '<span class="cond-sub"> — no USGS site bound to this water reports these, per the site '
      + 'catalogue. An empty field with a reason is a gap somebody can close.</span>'));
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

  if (c.windMph != null) {
    out.push(row('Wind', `${Math.round(c.windMph)} mph`
      + `${c.gustMph != null ? ` gusting ${Math.round(c.gustMph)}` : ''}`
      + `${c.windDirDeg != null ? ` from ${Math.round(c.windDirDeg)}°` : ''}`
      + `<span class="cond-sub"> — observed at ${esc(c.obsStation || 'the nearest station')}`
      + `${c.obsKmAway != null ? `, ${c.obsKmAway} km from this water` : ''}.</span>`));
  }
  if (c.pressureMb != null) {
    const d = (v) => v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;
    const src = c.pressureFrom === 'nws_station'
      ? `<span class="cond-sub"> — nearest NWS station${c.obsKmAway != null ? `, ${c.obsKmAway} km away` : ''}. `
        + `One observation, so no trend: a direction invented from a single reading is not a trend.</span>`
      : `<span class="cond-sub"> — 3 h ${d(c.pressure3h)} mb. NOAA CO-OPS at the tide station.</span>`;
    out.push(row('Barometer', `${c.pressureMb} mb${src}`));
  } else if (c.pressureStale) {
    out.push(row('Barometer', '<span class="cond-sub">the station\u2019s last reading is too old to use — '
      + 'reported rather than shown, because a barometer from last week presented as now is worse '
      + 'than none.</span>'));
  }
  if (c.trend24h != null || c.trend7d != null) {
    const fmt = (d) => d == null ? '—'
      : Math.abs(d) < 0.01 ? 'no change'
      : `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(2)}${c.trendUnits ? ` ${esc(c.trendUnits)}` : ''}`;
    out.push(row('Trend', `24 h ${fmt(c.trend24h)} · 7 d ${fmt(c.trend7d)}`
      + `<span class="cond-sub"> — ${esc(c.trendMeasures || 'gauge reading')}, NWPS observed series`
      + `${c.trendCoversHours ? ` covering ${Math.round(c.trendCoversHours / 24)} days` : ''}. `
      + `A dash means the series does not reach back that far.</span>`));
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

  // A MEASURED TURBIDITY AND A MODELLED CLARITY MUST NOT SIT SIDE BY SIDE DISAGREEING. The
  // Congaree card showed "14.4 FNU — MEASURED" directly above "Clarity Clear — MODELLED", and
  // 14.4 FNU is not clear. The strip already suppressed the model; the card did not.
  if (c.clarity && c.turbidityFnu == null) {
    out.push(row('Clarity', `${esc(c.clarity)}`
      + (c.clarityIsMeasured
        ? '<span class="cond-sub"> — measured Secchi baseline, adjusted for recent rain</span>'
        : `<span class="cond-sub"> — MODELLED from rainfall. ${esc(c.clarityNote || 'No clarity measurements exist for this water.')}</span>`)));
  }

  if (c.releases) {
    const r = c.releases;
    const kind = r.kind === 'projected' ? 'projected arrivals'
               : r.kind === 'scheduled'
                 ? (r.all_no_release
                    ? 'published schedule — NO RELEASE on every day published'
                    : 'published schedule')
               : 'observed right now — NOT a forecast';
    const items = (r.items || []).slice(0, 4).map((it) => {
      if (it.cfs != null) return `${Math.round(it.cfs).toLocaleString()} ft³/s ${esc(it.into || '')}`;
      if (it.arrival) return `${esc(it.arrival)} → ${esc(it.mileMarkerName || it.damName || '')}`;
      // A DUKE DAM SCHEDULE ROW. `no_release` is a STATED zero — Duke writes "No Flow Release"
      // into the datetime field itself — and a row that says so must render, or three days of
      // "they are not generating" reads as three days of no information.
      if (it.no_release) return `${esc(it.date || '')} — no flow release scheduled`;
      if (it.start) {
        const t = (v) => (v ? String(v).slice(11, 16) : '');
        return `${esc(it.date || '')} ${esc(t(it.start))}${it.end ? `–${esc(t(it.end))}` : ''}`
             + `${it.generators != null ? ` · ${it.generators} unit${it.generators === 1 ? '' : 's'}` : ''}`;
      }
      if (it.generators != null) return `${it.generators} generator${it.generators === 1 ? '' : 's'}`;
      return null;
    }).filter(Boolean);
    out.push(row(`Releases (${esc(r.operator || 'operator')})`,
      `<span class="cond-sub">${esc(kind)}</span>`
      + (items.length ? `<br>${items.map(esc).join('<br>')}` : '')));
  }

  // WHY THE WATER IS WHERE IT IS, immediately under the schedule it explains. Lake Wateree reads
  // "No Flow Release" three days running because the basin is in Stage 2 of the Low Inflow
  // Protocol and recreation flows are suspended under Stage 2. The zero without the reason is a
  // number nobody can act on.
  if (c.droughtNotice) {
    const d = c.droughtNotice;
    out.push(row('Drought status',
      `<b>${d.stage != null ? `Low Inflow Protocol — Stage ${d.stage}` : 'Low Inflow Protocol'}</b>`
      + (d.suspends_recreation_flows
        ? '<span class="cond-sub"> — recreation flow releases are SUSPENDED under this stage, '
          + 'which is why the schedule reads no release.</span>'
        : '')
      + `<br><span class="cond-sub">${esc(d.text).replace(/\n/g, '<br>')}</span>`
      + (d.last_updated ? `<span class="cond-sub"><br>Duke, updated ${esc(String(d.last_updated).slice(0, 10))}</span>` : '')));
  }

  // A CLOSED RAMP IS A TRIP THAT DOES NOT HAPPEN. Duke names the alternates when it shuts one:
  // "Buck Hill Access Area will close ... Please use alternate sites, such as Colonels Creek or
  // White Oak Creek."
  if (c.accessAlerts && c.accessAlerts.length) {
    const lines = c.accessAlerts.slice(0, 6).map((a) => {
      const link = (a.links || [])[0];
      return `<b>${esc(a.place || a.water || 'Access area')}</b>`
           + `<br><span class="cond-sub">${esc(a.text).replace(/\n/g, '<br>')}</span>`
           + (link ? `<br><span class="cond-sub"><a href="${esc(link)}" target="_blank" rel="noopener">source</a></span>` : '');
    }).join('<br>');
    out.push(row(`Access (${c.accessAlerts.length})`, lines
      + '<span class="cond-sub"><br>Duke Energy access alerts. Applies only to areas Duke manages.</span>'));
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
  // THE BADGE IS BUILT HERE, NOT IN conditionsStrip(). That function is pure and tested and
  // knows nothing about cameras; teaching it would couple the sentence to the roster for one
  // glyph. The line is the only place both facts are already in hand.
  const nCam = camerasFor(rec, activeRamp).cams.length;
  const badge = nCam ? ` · \u{1F4F7}${nCam > 1 ? nCam : ''}` : '';
  // WHOSE NUMBERS THESE ARE. Without this the same strip means two different things depending
  // on a dropdown somewhere else on the page.
  const at = activeRamp ? ` <span class="cond-sub">@ ${esc(activeRamp.name)}</span>` : '';
  if (e.line) e.line.innerHTML = `<b>${esc(name)}</b>${at} · ${esc(s.text)}${badge}`;
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
      fillCameras(e.card, seq);
    }
  }
}

/** Read (or reuse) the conditions for a record and paint. */
export async function showConditionsFor(rec, opts = {}) {
  if (!rec || !rec.slug) { activeRamp = null; paint(null, null); return null; }
  lastSlug = rec.slug;
  activeRamp = opts.ramp !== undefined ? opts.ramp : selectedRamp();
  const mine = ++seq;
  // KEYED ON THE LAUNCH TOO. The response now depends on the point it was asked about, so a
  // cache keyed on the slug alone would hand Bates Bridge the numbers for a landing 40 km up
  // the same river and look like it worked.
  const key = `${rec.slug}|${activeRamp ? activeRamp.name : ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS && !opts.force) { paint(rec, hit.c); return hit.c; }

  paint(rec, { ok: true, pending: 'reading…' });
  const worker = CF_WORKER_URL || window.CF_WORKER_URL;
  // WARM THE REGULATION DIGEST FOR THIS WATER. checkRegulations() is called synchronously deep in
  // the plan path and cannot await anything, so the read happens here, where the water is chosen
  // and its state is already in hand. Fire-and-forget on purpose: a failed prime leaves the cache
  // cold, and a cold cache is the unknown branch, which warns. Nothing here can turn a network
  // problem into permission.
  if (rec.state) primeRegulations(rec.state, rec.displayName || rec.name, { worker });
  const c = await fetchWaterConditions(worker, rec, { date: opts.date, point: activeRamp });
  // A slower answer for a lake you already moved off must not overwrite the newer one.
  if (mine !== seq || lastSlug !== rec.slug) return c;
  cache.set(key, { at: Date.now(), c });
  paint(rec, c);
  return c;
}

/** Resolve whatever the picker holds and show it. */
export function refreshConditions(opts = {}) {
  const v = document.getElementById('lakeSelect')?.value
         || document.getElementById('planLake')?.value
         || '';
  if (!v) { activeRamp = null; paint(null, null); return Promise.resolve(null); }
  const rec = lakeRecordFor(v) || lakeRecordFor(v.split(',')[0].trim());
  if (!rec) {
    activeRamp = null;
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
  // PICKING A NEW WATER CLEARS THE LAUNCH, PASSED EXPLICITLY. lake-ramp-select.js rebuilds
  // #rampSelect asynchronously on the same event, so reading the dropdown here is a race whose
  // outcome is listener registration order — and the losing side shows the previous lake's ramp
  // against the new lake's numbers, which looks exactly like a working app.
  document.getElementById('lakeSelect')?.addEventListener('change', () => refreshConditions({ ramp: null }));
  // The launch changes which gauge and which camera answer, so it changes the strip. This event
  // only fires on a user choice, by which time the list is the current water's.
  document.getElementById('rampSelect')?.addEventListener('change', () => refreshConditions());
  document.getElementById('planRamp')?.addEventListener('change', () => refreshConditions());
  document.getElementById('planLake')?.addEventListener('change', () => refreshConditions({ ramp: null }));
  document.getElementById('planDate')?.addEventListener('change', () => refreshConditions({ force: true }));
  refreshConditions();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
else setTimeout(wire, 300);
