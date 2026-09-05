/**
 * THE BENCH — test the app before a plan is a plan.
 *
 * Ryan, 2026-09-06: "i want this as something to test the app before a plan is a plan... this way
 * i am not firing alerts off on my phone for a plan that i will never fish." And, on what it has
 * to show: "the 1st thing shows me what the LLM gets... to see what is missing... to see how it
 * responds to the inputs it is given... to see if additional inputs are needed... then the second
 * thing is the output... what the LLM gives us and what we do with it."
 *
 * So: three panes, one run.
 *
 *   THE INPUT              every section of the prompt the model is actually handed, plus the
 *                          water it may fish. Built by runSmartPlanV2({dryRun:true}), which
 *                          spends nothing.
 *   THE ANSWER             the model's raw JSON, untouched.
 *   WHAT THE APP MADE      the assembled plan and every warning, so a field the model wrote and
 *                          the app dropped is visible as a difference rather than a rumour.
 *
 * NOT A SECOND PLANNER. It calls runSmartPlanV2() — the same inputs, the same prompt builder, the
 * same assembler — and that function returns before materialisePlan() writes a GPX,
 * loadSessionFromPlan() arms the phone and planToTimeline() installs the globals. A parallel
 * implementation here would be a bench that tests itself.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */

import { runSmartPlanV2, readInputs } from './smart-plan-v2-wiring.js';
import { splitPrompt, droppedFromAnswer } from '../utils/bench-read.js';

const $ = (id) => document.getElementById(id);

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A section is collapsed when it is long. A SHORT one is left open, and an EMPTY one is the
 *  interesting case -- a block that ran and had nothing to say. */
function sectionHtml(s) {
  const body = s.body.join('\n').replace(/^\n+|\n+$/g, '');
  const chars = body.length;
  return `<details class="bench-sec"${chars > 900 ? '' : ' open'}>`
       + `<summary>${esc(s.title)} <span class="bench-n">${chars.toLocaleString()} ch</span>`
       + `</summary><pre class="bench-pre">${esc(body)}</pre></details>`;
}

function jsonBlock(label, value, open) {
  const txt = value == null ? '(nothing)' : JSON.stringify(value, null, 2);
  return `<details class="bench-sec"${open ? ' open' : ''}>`
       + `<summary>${esc(label)} <span class="bench-n">${txt.length.toLocaleString()} ch</span>`
       + `</summary><pre class="bench-pre">${esc(txt)}</pre></details>`;
}

function render(r, mode) {
  const box = $('benchOut');
  if (!box) return;
  if (!r) { box.innerHTML = '<p class="pv-empty">Nothing came back.</p>'; return; }

  const user = (r.request && r.request.user) || '';
  const system = (r.request && r.request.system) || '';
  const secs = splitPrompt(user);
  const empties = secs.filter((s) => !s.body.join('').trim());

  let html = `<div class="bench-head">`
    + `<b>THE INPUT</b> — ${user.length.toLocaleString()} characters in `
    + `${secs.length} sections, ${(r.candidates || []).length} candidate legs offered`
    + (empties.length ? ` · <span class="bench-warn">${empties.length} section(s) had nothing `
        + `to say: ${empties.map((s) => esc(s.title)).join(', ')}</span>` : '')
    + `</div>`;
  html += jsonBlock('SYSTEM PROMPT', system, false).replace('(nothing)', esc(system));
  html += secs.map(sectionHtml).join('');
  html += jsonBlock('THE WATER IT MAY FISH (candidates, as sent)', r.candidates || [], false);

  if (mode === 'bench') {
    html += `<div class="bench-head" style="margin-top:14px"><b>THE ANSWER</b> — raw, `
          + `exactly as the model returned it</div>`;
    html += jsonBlock('MODEL RESPONSE', r.response ?? null, true);

    html += `<div class="bench-head" style="margin-top:14px"><b>WHAT THE APP MADE OF IT</b></div>`;
    // BOTH READINGS, or the answer is wrong in the direction that matters. planArgsFrom() holds
    // the loadout and the deploys; assemblePlan() holds the legs. Comparing against the plan
    // alone reported every rod, colour and rationale the model wrote as "dropped", which is the
    // kind of confident wrong number this whole bench exists to catch.
    const dropped = droppedFromAnswer(r.response, { args: r.args || null, plan: r.plan || null });
    html += dropped.length
      ? `<details class="bench-sec" open><summary class="bench-warn">`
        + `${dropped.length} value(s) the model wrote that are not in the plan</summary>`
        + `<pre class="bench-pre">${dropped.map((d) => `${esc(d.path)}\n    ${esc(d.value)}`)
            .join('\n\n')}</pre></details>`
      : `<details class="bench-sec" open><summary>Nothing the model said was dropped</summary>`
        + `<pre class="bench-pre">Every value in the answer appears in the assembled plan.`
        + `</pre></details>`;
    html += jsonBlock(`WARNINGS (${(r.problems || []).length})`, r.problems || [], true);
    html += jsonBlock('ASSEMBLED PLAN', r.plan ?? null, false);
  }

  box.innerHTML = html;
}

async function run(mode) {
  const say = (m, bad) => {
    const el = $('benchStatus');
    if (el) { el.textContent = m; el.style.color = bad ? 'var(--warn)' : 'var(--muted)'; }
  };
  const inp = readInputs();
  if (!inp.lakeName) return say('Pick a lake on the Plan tab first — the bench runs the same '
                             + 'inputs the planner would.', true);
  if (!inp.species.length) return say('Check at least one species on the Plan tab first.', true);
  say(mode === 'bench' ? 'Building and sending…' : 'Building the input…');
  const r = await runSmartPlanV2(mode === 'bench' ? { bench: true } : { dryRun: true });
  render(r, mode);
  return r;
}

export function wirePlanBench() {
  const a = $('benchBuildBtn'); const b = $('benchSendBtn');
  if (a && !a.dataset.wired) {
    a.dataset.wired = '1';
    a.addEventListener('click', async () => {
      a.disabled = true; if (b) b.disabled = true;
      try { await run('dry'); } finally { a.disabled = false; if (b) b.disabled = false; }
    });
  }
  if (b && !b.dataset.wired) {
    b.dataset.wired = '1';
    b.addEventListener('click', async () => {
      a && (a.disabled = true); b.disabled = true;
      try { await run('bench'); } finally { a && (a.disabled = false); b.disabled = false; }
    });
  }
  const s = $('benchInputs');
  if (s) {
    const i = readInputs();
    s.textContent = i.lakeName
      ? `${i.lakeName} · ${i.rampName || 'no ramp'} · ${i.dateStr} · ${i.launchTime}–${i.returnTime}`
        + ` · ${i.species.join(', ') || 'no species'}`
      : 'Nothing selected on the Plan tab yet.';
  }
}

if (typeof window !== 'undefined') window.wirePlanBench = wirePlanBench;
