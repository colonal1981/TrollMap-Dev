/**
 * plan-tab-wiring.js
 * Rewires the Plan tab subtabs for the new 2-tab layout (Plan / Preview).
 * Replaces the old 3-tab (Builder / Preview / Library) wiring in plan-builder.js.
 * Import this AFTER plan-builder.js in main.js.
 */

// Rewire subtabs: Plan and Preview only
document.querySelectorAll('#planSubtabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#planSubtabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.plansub;
    const builder = document.getElementById('plan-builder');
    const preview = document.getElementById('plan-preview');
    if (builder) builder.classList.toggle('hidden', tab !== 'plan');
    if (preview) preview.classList.toggle('hidden', tab !== 'preview');
  });
});

// Back button goes to Plan tab
document.getElementById('backToBuilderBtn')?.addEventListener('click', () => {
  document.querySelector('#planSubtabs button[data-plansub="plan"]')?.click();
});

// Preview button auto-generates preview and switches tab
document.getElementById('buildPreviewBtn')?.addEventListener('click', async () => {
  const { collectPlan, buildPlanPreviewHtml } = await import('./plan-builder.js');
  const p = collectPlan();
  const previewEl = document.getElementById('planPreviewHtml');
  if (previewEl) previewEl.innerHTML = '<p style="color:#888;padding:20px">⏳ Building preview…</p>';
  document.querySelector('#planSubtabs button[data-plansub="preview"]')?.click();
  if (previewEl) previewEl.innerHTML = await buildPlanPreviewHtml(p);
});

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
