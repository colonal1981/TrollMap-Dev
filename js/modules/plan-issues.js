/**
 * plan-issues.js — what the plan says about itself, in the shape the tab can show.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * 2026-08-09. Every refusal the assembler makes — a dropped stop, a dropped lure change, an
 * unknown rod, over budget, over window, "last leg ends 2.8 km from the ramp" — was pushed onto
 * `plan.warnings`, folded into `problems` by smart-plan-v2.js, and then shown ONLY when the plan
 * was null (smart-plan-v2-wiring.js:181-186). The moment a plan was successfully produced the
 * whole list was discarded.
 *
 * PLAN_SCHEMA_V2 says a stop naming a structure the model was not handed "is refused with a
 * warning". That clause describes an emission, not a display, and is fully satisfied by code that
 * shows the user nothing — which is what it got. From the user's side a refused stop and a stop
 * that was never asked for are indistinguishable, and that is how "only gave me 1 spot to stop
 * and cast" hid for a day.
 *
 * A refusal is not a smaller kind of error than a failure. It is the plan saying it is not the
 * plan you asked for. Rendering a plan while withholding a non-empty warning list is a defect of
 * the same severity as rendering the wrong plan.
 *
 * Pure: a string in, a string out, no DOM. The caller inserts it.
 */

const html = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * Everything the plan says about itself, rendered WITH the plan rather than instead of it.
 *
 * 2026-08-09. Every refusal the assembler makes — a dropped stop, a dropped lure change, an
 * unknown rod, over budget, over window, "last leg ends 2.8 km from the ramp" — was pushed onto
 * `plan.warnings`, folded into `problems`, and then shown only when `r.plan` was null. The moment
 * a plan was successfully produced the whole list was discarded. From the user's side a refused
 * stop and a stop that was never asked for are indistinguishable, which is exactly how "only gave
 * 1 spot to stop and cast" hid for a day.
 *
 * A refusal is not a smaller kind of error than a failure. It is the plan telling you it is not
 * the plan you asked for.
 *
 * `problems` already contains `plan.warnings` (smart-plan-v2.js folds them in with
 * validatePlan()'s return), so the list is deduped by text rather than by source.
 */
/**
 * WHAT the plan says about itself, with no opinion about how it is drawn.
 *
 * 2026-09-04. Ryan's own plan for the printable report --
 * THE_RESEARCH_TAB_BECOMES_THE_SMART_PLAN_INPUT_VIEWER_2026-09-02.md -- is "i want to know what
 * it suggested that the app changed because of x,y,z". The 42 override points that answer that
 * were already written, already worded as the pair, and already reaching this file. They were
 * rendered ONLY into the tab, because planIssuesHtml() emits the tab's CSS variables and the
 * printable report has its own classes.
 *
 * A SECOND COPY OF THE LIST IS A SECOND ANSWER WAITING TO DISAGREE. So the list is computed here
 * once and the two surfaces skin it: planIssuesHtml() below is unchanged in behaviour, and
 * plan-builder.js renders the same object with `rp-callout`.
 */
export function planIssues(plan, problems = []) {
  const safety = (plan && plan.safety) || {};
  const seen = new Set();
  const list = [...((plan && plan.warnings) || []), ...(problems || [])]
    .map((w) => String(w == null ? '' : w).trim())
    .filter((w) => w && !seen.has(w) && seen.add(w) !== false);
  return { safety, list, noGo: safety.isGo === false };
}


export function planIssuesHtml(plan, problems = []) {
  const { safety, list } = planIssues(plan, problems);

  let out = '';
  // THE MODEL CAN CALL A NO-GO AND v2 RENDERED THE DAY ANYWAY. v1 stopped for this
  // (smart-plan.js:1066) and the rewrite lost it. Over 15 sustained or 20 gusting is a no-go for
  // a 12.5 ft kayak; the plan below is what the day WOULD have been, not an invitation.
  if (safety.isGo === false) {
    out += `<div style="border:2px solid var(--warn);border-radius:10px;padding:12px 14px;`
        +  `margin-bottom:12px;background:rgba(255,82,82,0.08)">`
        +  `<div style="font-size:14px;font-weight:800;color:var(--warn)">🚨 NO-GO — DO NOT LAUNCH</div>`
        +  (safety.warning ? `<div style="font-size:12px;margin-top:6px">${html(safety.warning)}</div>` : '')
        +  (safety.rampEvaluation ? `<div style="font-size:11px;color:var(--muted);margin-top:6px">`
             + `${html(safety.rampEvaluation)}</div>` : '')
        +  `<div style="font-size:11px;color:var(--muted);margin-top:6px">The plan below is what `
        +  `the day would have been. It is not a recommendation to go.</div></div>`;
  }
  if (list.length) {
    out += `<div style="border:1px solid var(--warn);border-radius:10px;padding:10px 12px;`
        +  `margin-bottom:12px;background:rgba(255,179,0,0.06)">`
        +  `<div style="font-size:11px;font-weight:700;color:var(--warn);text-transform:uppercase;`
        +  `letter-spacing:.06em;margin-bottom:6px">⚠ ${list.length} thing`
        +  `${list.length === 1 ? '' : 's'} the plan wants to tell you</div>`
        +  `<ul style="margin:0;padding-left:18px;font-size:11px;color:var(--text);line-height:1.5">`
        +  list.map((w) => `<li>${html(w)}</li>`).join('')
        +  `</ul></div>`;
  }
  return out;
}

