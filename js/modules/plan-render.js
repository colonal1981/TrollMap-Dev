/**
 * plan-render.js — a schema v2 plan, drawn.
 *
 * ONE SOURCE, ONE READER. The old timeline was assembled by `buildUnifiedTimeline()` out of
 * `band1`, `band2`, a `timeline` array and four route objects, each of which had its own idea of
 * what a pass was — which is precisely how a stop ended up with `lat: null` and nowhere to go.
 * This reads the plan object and nothing else. If a fact is not in the plan it does not get
 * drawn, and if it is in the plan it gets drawn from the plan rather than recomputed here.
 *
 * DISTANCE, NOT TIME, IS WHAT THE ANGLER READS. Every row leads with metres along the day,
 * because the clock starts drifting the moment he hooks a fish. Times are shown greyed and
 * labelled `est` so nothing reads as a promise. See PLAN_SCHEMA_V2.md.
 *
 * Returns an HTML string rather than touching the DOM, so it is testable without a browser and
 * the caller decides where it goes.
 */

import { planCues } from './plan-assemble.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Metres as the angler thinks of them: "1.4 km" out on the water, "480 m" up close. */
export function metres(m) {
  const v = Number(m) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)} km` : `${Math.round(v)} m`;
}

export function miles(m) { return `${((Number(m) || 0) / 1609.34).toFixed(1)} mi`; }

function depth(ft) {
  // Null means the pipeline has no depth for that kind of feature. Say so — the alternative is
  // the `?? 6` that once put a stop on a 41 ft hump at six feet and sized the jighead from it.
  return ft == null ? '<span class="pv-unknown">depth not charted</span>' : `${Number(ft).toFixed(0)} ft`;
}

function rodChip(rod) {
  if (!rod) return '';
  if (rod.staged) {
    return `<span class="pv-rod pv-staged" title="not rigged by this plan — whatever was already on it">`
         + `${esc(rod.id)} · staged</span>`;
  }
  const cost = rod.rig === 'snap' ? 'snap · seconds to change' : '20 lb fluoro · a retie to change';
  return `<span class="pv-rod pv-${esc(rod.rig)}" title="${esc(cost)}">${esc(rod.id)} `
       + `<b>${esc(rod.lure || '—')}</b>${rod.color ? ` · ${esc(rod.color)}` : ''}`
       + `${rod.leadFt ? ` · ${Math.round(rod.leadFt)} ft back` : ''}</span>`;
}

function loadoutSection(loadout) {
  const rods = (loadout && loadout.rods) || [];
  const rigged = rods.filter((r) => !r.staged);
  const staged = rods.filter((r) => r.staged);
  return `<section class="pv-loadout">
    <h3>The six rods</h3>
    ${loadout && loadout.why ? `<p class="pv-why">${esc(loadout.why)}</p>` : ''}
    <ul class="pv-rods">${rigged.map((r) => `<li>${rodChip(r)}${
      r.runsDepthFt ? `<span class="pv-band">runs ${r.runsDepthFt[0]}–${r.runsDepthFt[1]} ft</span>` : ''
    }${r.why ? `<span class="pv-note">${esc(r.why)}</span>` : ''}</li>`).join('')}</ul>
    ${staged.length ? `<p class="pv-staged-note">${staged.map((r) => esc(r.id)).join(', ')} stay behind `
      + `the seat with whatever is already on them.</p>` : ''}
  </section>`;
}

function stopRow(leg, s) {
  return `<li class="pv-stop">
    <span class="pv-at">${metres(leg.startM + s.atM)}</span>
    <span class="pv-body">
      <b>Stop — ${esc(s.structure || s.structureType || 'structure')}</b>
      <span class="pv-meta">${depth(s.depthFt)} · ${s.durationMin} min${
        s.rods && s.rods.length ? ` · ${s.rods.map(esc).join(', ')}` : ''}</span>
      ${s.why ? `<span class="pv-note">${esc(s.why)}</span>` : ''}
      ${s.presentation ? `<span class="pv-note">${esc(s.presentation)}</span>` : ''}
      ${s.positioning ? `<span class="pv-note pv-hold">Holding: ${esc(s.positioning)}</span>` : ''}
    </span></li>`;
}

function legSection(leg, byId) {
  if (leg.type === 'transit') {
    return `<li class="pv-leg pv-transit">
      <span class="pv-at">${metres(leg.startM)}</span>
      <span class="pv-body"><b>Run ${metres(leg.lengthM)}</b>
      <span class="pv-meta">${leg.speedMph} mph · ${leg.batteryAh} Ah · est ${leg.estDurationMin} min</span>
      </span></li>`;
  }
  const d = leg.deploy || {};
  const spread = [byId[d.port], byId[d.starboard]].filter(Boolean);
  const hist = leg.yourHistory;
  return `<li class="pv-leg pv-troll">
    <span class="pv-at">${metres(leg.startM)}</span>
    <span class="pv-body">
      <b>Troll ${metres(leg.lengthM)} · ${depth(leg.depthFt)}</b>
      <span class="pv-meta">${leg.speedMph} mph · ${leg.batteryAh} Ah · est ${leg.estDurationMin} min
        · <span class="pv-est">from ${esc(leg.estStartTime)}</span></span>
      ${leg.why ? `<span class="pv-note">${esc(leg.why)}</span>` : ''}
      <span class="pv-spread">${spread.map(rodChip).join('')}</span>
      ${hist && hist.catchesWithin300m ? `<span class="pv-hist" title="${esc(hist.note || '')}">`
        + `You have caught ${hist.catchesWithin300m} here${
          hist.thisSpecies ? `, ${hist.thisSpecies} of this species` : ''}${
          hist.lastCaught ? ` · last ${esc(hist.lastCaught)}` : ''}</span>` : ''}
      ${leg.stops && leg.stops.length ? `<ul class="pv-stops">${
        leg.stops.map((s) => stopRow(leg, s)).join('')}</ul>` : ''}
    </span></li>`;
}

function changeRow(c) {
  const cost = c.cost === 'snap' ? 'snap — seconds' : '20 lb fluoro — a retie';
  return `<li class="pv-change pv-${esc(c.cost)}">
    <span class="pv-at">${metres(c.atM)}</span>
    <span class="pv-body"><b>${esc(c.rodId)} → ${esc(c.to)}</b>
    <span class="pv-meta">${esc(cost)}${c.from ? ` · off comes ${esc(c.from)}` : ''}</span>
    ${c.why ? `<span class="pv-note">${esc(c.why)}</span>` : ''}</span></li>`;
}

/** The whole plan as HTML. */
export function renderPlan(plan, opts = {}) {
  if (!plan || plan.planVersion !== 2) return '<p class="pv-empty">No plan.</p>';
  const m = plan.meta || {}, b = plan.budget || {};
  const byId = Object.fromEntries(((plan.loadout && plan.loadout.rods) || []).map((r) => [r.id, r]));
  const safety = plan.safety || {};

  // Interleave: legs carry their own stops, changes sit on the day's spine between them.
  const rows = [];
  const changes = [...(plan.changes || [])];
  for (const leg of (plan.legs || [])) {
    while (changes.length && changes[0].atM <= leg.startM) rows.push(changeRow(changes.shift()));
    rows.push(legSection(leg, byId));
  }
  rows.push(...changes.map(changeRow));

  const overAh = b.usableAh && b.plannedAh > b.usableAh;
  const overTime = b.windowMin && b.estPlannedMin > b.windowMin;

  return `<div class="plan-v2">
  <header class="pv-head">
    <h2>${esc(m.water || 'Plan')}${m.ramp ? ` · ${esc(m.ramp)}` : ''}</h2>
    <p class="pv-sub">${esc(m.date || '')} · ${esc(m.launchTime || '')}–${esc(m.returnTime || '')}
      ${m.species && m.species.length ? ` · ${m.species.map(esc).join(', ')}` : ''}</p>
  </header>

  ${safety.isGo === false
    ? `<div class="pv-nogo"><b>NO-GO</b> ${esc(safety.warning || 'Conditions are unsafe for a kayak.')}</div>`
    : `<div class="pv-go">${esc(safety.rampEvaluation || 'Conditions look workable.')}</div>`}

  ${(plan.warnings || []).length ? `<ul class="pv-warnings">${
    plan.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}

  ${loadoutSection(plan.loadout)}

  <section class="pv-budget">
    <h3>The day</h3>
    <table><tbody>
      <tr><th>Distance</th><td>${metres(b.totalM)} (${miles(b.totalM)})</td></tr>
      <tr><th>Fishing</th><td>${metres(b.fishingM)} of it · ${metres(b.transitM)} getting there</td></tr>
      <tr class="${overAh ? 'pv-over' : ''}"><th>Battery</th><td>${b.plannedAh} Ah${
        b.usableAh ? ` of ${b.usableAh} usable` : ''}</td></tr>
      <tr class="${overTime ? 'pv-over' : ''}"><th>Time</th><td class="pv-est">est ${
        b.estPlannedMin} min${b.windowMin ? ` in a ${b.windowMin} min window` : ''}</td></tr>
    </tbody></table>
    <p class="pv-fineprint">Amp-hours come from a two-point fit to your own two readings, not a
      published curve. Times are estimates and will drift the first time you hook something —
      the plan runs on distance, so it does not matter.</p>
  </section>

  <section class="pv-timeline">
    <h3>The day, by distance</h3>
    <ol class="pv-rows">${rows.join('')}</ol>
  </section>

  ${plan.notes && Object.keys(plan.notes).length ? `<section class="pv-notes">
    ${plan.notes.scoutNotes ? `<p>${esc(plan.notes.scoutNotes)}</p>` : ''}
    ${plan.notes.structureFocus ? `<p><b>On the sonar:</b> ${esc(plan.notes.structureFocus)}</p>` : ''}
    ${plan.notes.adjustmentTip ? `<p><b>If nothing hits:</b> ${esc(plan.notes.adjustmentTip)}</p>` : ''}
    ${plan.notes.fishfinderNarrative ? `<p class="pv-narrative">${esc(plan.notes.fishfinderNarrative)}</p>` : ''}
  </section>` : ''}

  ${opts.problems && opts.problems.length ? `<details class="pv-problems">
    <summary>${opts.problems.length} thing${opts.problems.length === 1 ? '' : 's'} the app had to
      fix in the model's answer</summary>
    <ul>${opts.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></details>` : ''}
</div>`;
}

/**
 * The one-line cue list the phone reads: what is next, and how far to it.
 * Distance-keyed, so fighting a fish for twenty minutes changes nothing.
 */
export function renderCues(plan) {
  const cues = planCues(plan);
  if (!cues.length) return '<p class="pv-empty">Nothing to cue.</p>';
  return `<ol class="pv-cues">${cues.map((c) => `<li class="pv-cue-${esc(c.kind)}">
    <span class="pv-at">${metres(c.atM)}</span>
    <span>${c.kind === 'change' ? 'Change' : 'Stop'} — ${esc(c.what || '')}${
      c.rods && c.rods.length ? ` · ${c.rods.map(esc).join(', ')}` : ''}${
      c.depthFt != null ? ` · ${Math.round(c.depthFt)} ft` : ''}</span></li>`).join('')}</ol>`;
}
