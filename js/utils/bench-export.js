/**
 * WRITING OUT WHAT THE BENCH SHOWS — the two pure builders behind the export buttons.
 *
 * Split out of plan-bench.js for the same reason bench-read.js was: that file touches the DOM at
 * import time through the wiring it pulls in, and these do not, so these can be tested without a
 * browser. `benchHtml` takes the document as an argument rather than reaching for the global one,
 * which is what makes the three things it touches -- getElementById, styleSheets, getComputedStyle
 * -- provable rather than assumed.
 *
 * Ryan, 2026-09-14: "can i get json and html export buttons on the bench... that way i do not have
 * to copy and paste the whole json to you?"
 *
 * Two files because they answer two questions. The JSON is the WHOLE RUN -- the prompt as sent,
 * the model's raw answer, the args the app built from it, the assembled plan and every warning --
 * which is the thing to hand over when something is wrong and nobody knows which side of the seam
 * it is on. The HTML is the PAGE, the drawn plan included, which is the thing to open and read.
 *
 * NEITHER IS A SECOND RENDERER. The HTML is the live document's own markup with the live
 * document's own stylesheets: whatever the bench shows is exactly what the file shows, and a file
 * that drifted from the page would be a bench that tests itself.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * EVERYTHING THE RUN PRODUCED, in the order the bench shows it.
 *
 * `request.user` is left as one string on purpose. It is what was sent, byte for byte; splitting
 * it into sections here would make the file a reading of the prompt rather than the prompt.
 */
export function benchJson(lastRun, lastMode, i) {
  return JSON.stringify({
    note: 'TrollMap bench export. Personal use only, not for distribution or resale; '
        + 'not for navigation.',
    exportedAt: new Date().toISOString(),
    mode: lastMode === 'bench' ? 'sent to the model' : 'dry run — prompt only, nothing sent',
    inputs: i,
    request: (lastRun && lastRun.request) || null,
    response: (lastRun && lastRun.response) ?? null,
    args: (lastRun && lastRun.args) ?? null,
    plan: (lastRun && lastRun.plan) ?? null,
    warnings: (lastRun && lastRun.problems) || [],
  }, null, 2);
}

/**
 * THE BENCH RUN, SHAPED THE WAY THE PLAN REPORT EXPECTS IT.
 *
 * Ryan, 2026-09-14, on the first version of this export: "the html output is not what i was
 * looking for... i was looking for the html plan output just like if i ran a plan."
 *
 * Fair. The first version wrote out the bench PAGE -- the prompt sections, the warnings, the
 * dropped-value list -- which is what the JSON is for. What he wants out of the HTML button is the
 * report: the same document `exportPlanHtmlBtn` writes on the Plan tab.
 *
 * ONE REPORT BUILDER, AND THIS IS NOT IT. `buildPlanPreviewHtml(p)` renders the document and lives
 * in plan-builder.js, where the Plan tab's own export calls it. All this does is produce the `p`
 * it takes.
 *
 * AND ONE `p` BUILDER, WHICH IS ALSO NOT THIS. `collectPlan()` reads the Plan tab -- the name, the
 * date, the ramp, the pool level, the times, the tackle and safety notes -- and every one of those
 * fields is filled in on a bench run, because the bench runs off that same form. What it CANNOT
 * read is the plan, because the bench deliberately writes none of the `window._smartPlan*` globals
 * and never calls installTimeline() or syncSpread(). So the form half is collectPlan's and the
 * plan half is replaced here, field for field, from the run being exported.
 *
 * THE GPX BLOCK IS EMPTIED RATHER THAN LEFT. `collectPlan()` reads `state.DATA.tracks`, and on a
 * bench run those are whatever real plan was last materialised -- another day's geometry, another
 * day's waypoints. Carrying it would put a route in this file that this plan never described,
 * which is the exact failure collectPlan's own `_planV2` guard exists to prevent. Same for
 * `model`, which reaches for `_planV2Result`: the run's own request and answer are in the JSON
 * export, in full, and do not belong in a printed report.
 *
 * @param {object} run       what runSmartPlanV2({bench:true}) returned; needs `plan` and `shown`
 * @param {object} formPlan  collectPlan()'s output — the Plan tab half
 * @param {function} spreadRowsFrom  from smart-plan-ui.js; builds the rod rows without storing them
 */
export function benchReportPlan(run, formPlan, spreadRowsFrom) {
  const shown = (run && run.shown) || null;
  const plan = (run && run.plan) || null;
  const rows = (shown && typeof spreadRowsFrom === 'function')
    ? spreadRowsFrom(shown.cards, shown.routeRods, shown.routeSpeeds || {})
    : [];
  return {
    ...(formPlan || {}),
    meta: {
      ...((formPlan || {}).meta || {}),
      // SAID ON THE DOCUMENT, not only known by whoever pressed the button. A bench report that
      // looks exactly like a real one and is not one is a thing to take on the water by mistake.
      name: `${((formPlan || {}).meta || {}).name || 'Fishing Plan'} — BENCH (not saved, not sent)`,
    },
    plan: plan ? {
      planVersion: plan.planVersion, meta: plan.meta, conditions: plan.conditions,
      loadout: plan.loadout, legs: plan.legs, changes: plan.changes,
      budget: plan.budget, safety: plan.safety, notes: plan.notes,
      // THE UNION THE BENCH SHOWS, not `plan.warnings` alone -- which is the assembler's third of
      // it and leaves out everything the app refused while reading the answer.
      warnings: (run && run.problems) || plan.warnings || [],
    } : null,
    timeline: (shown && shown.timeline) || null,
    unifiedTimeline: (shown && shown.timeline) || null,
    castRods: (shown && shown.castRods) || [],
    routeRods: (shown && shown.routeRods) || null,
    routeSpeeds: (shown && shown.routeSpeeds) || null,
    rationale: (shown && shown.rationale) || '',
    spread: rows,
    // EMPTY-SHAPED, NOT NULL. `buildPlanPreviewHtml` reads `p.gpx.waypoints` in one place among
    // four that use `p.gpx?.`, so a null here threw "Cannot read properties of null (reading
    // 'waypoints')" and killed the export -- Ryan hit it on the first try. The deref is guarded
    // now as well, but the shape is supplied regardless: a caller that hands a renderer a null
    // where it has always had an object is the caller's bug, and the next field added there would
    // break this again.
    //
    // EMPTY rather than carried: collectPlan() reads state.DATA.tracks, and on a bench run those
    // are whatever real plan was last materialised. Another day's route in a file describing this
    // one is the failure collectPlan's own `_planV2` guard exists to prevent.
    gpx: { waypoints: 0, tracks: 0, trackPoints: 0, waypointList: [], trackList: [] },
    model: null,
  };
}

/** The document, wrapped the way the Plan tab's own export wraps it. */
export function wrapReport(inner, title) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title || 'Fishing Plan')}`
       + `</title></head><body style="background:#f3f6f9;margin:0;padding:20px">${inner}</body></html>`;
}
