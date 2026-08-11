/**
 * plan-tab-wiring.js
 * Rewires the Plan tab subtabs.
 * Replaces the old 3-tab (Builder / Preview / Library) wiring in plan-builder.js.
 * Import this AFTER plan-builder.js in main.js.
 */

// SUBTABS ARE DATA NOW, NOT A PAIR OF `toggle` CALLS.
//
// This used to name `plan-builder` and `plan-preview` explicitly and toggle each against the
// clicked tab. That works for exactly two panels and fails silently for a third: the new button
// highlights, both existing panels hide because neither matches, and the tab looks broken rather
// than unwired. Adding Pick Water is what surfaced it.
//
// The panel now carries the same `data-plansub` its button does, so the two are matched on that
// and not on the id. Matching `#plan-<name>` would have been the obvious move and it is wrong:
// the first panel is `#plan-builder` behind a button reading `plan`, so `#plan-plan` matches
// nothing and the default tab comes up blank. A new tab is now a button and a div, and nothing
// here changes.
document.querySelectorAll('#planSubtabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.plansub;
    document.querySelectorAll('#planSubtabs button').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('#panel-plan .plan-sub').forEach(panel => {
      panel.classList.toggle('hidden', panel.dataset.plansub !== tab);
    });
  });
});

// Back button goes to Plan tab
document.getElementById('backToBuilderBtn')?.addEventListener('click', () => {
  document.querySelector('#planSubtabs button[data-plansub="plan"]')?.click();
});

// #buildPreviewBtn is bound in plan-builder.js, which owns buildPlanPreviewHtml. A second
// listener lived here doing the same job, so every click built the report TWICE and raced to
// write the result -- which is why one click produced two identical console errors. One button,
// one handler, in the module that owns the function.

// Export buttons
document.getElementById('exportPlanHtmlBtn')?.addEventListener('click', async () => {
  const { collectPlan, buildPlanPreviewHtml } = await import('./plan-builder.js');
  const p = collectPlan();
  const inner = await buildPlanPreviewHtml(p);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${p.meta.name || 'Fishing Plan'}</title></head><body style="background:#f3f6f9;margin:0;padding:20px">${inner}</body></html>`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  a.download = (p.meta.name || 'fishing_plan').replace(/\s+/g, '_') + '.html';
  a.click();
});

document.getElementById('exportPlanJsonBtn')?.addEventListener('click', async () => {
  const { collectPlan } = await import('./plan-builder.js');
  const p = collectPlan();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }));
  a.download = (p.meta.name || 'fishing_plan').replace(/\s+/g, '_') + '.json';
  a.click();
});

// Auto-set today's date
const planDate = document.getElementById('planDate');
if (planDate && !planDate.value) {
  planDate.value = new Date().toISOString().slice(0, 10);
}

console.log('[plan-tab-wiring] ready');
