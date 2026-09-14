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
 * THE PAGE, STANDALONE.
 *
 * The stylesheets are copied from the live document rather than written out here, so the file
 * cannot drift from the app: `document.styleSheets` is walked for rules, and any sheet that throws
 * on `.cssRules` is a cross-origin one (Leaflet from unpkg) and is re-linked by href instead.
 * The custom properties come off `:root` as computed, which is what makes the dark theme survive.
 */
export function benchHtml(lastMode, inputs, doc = (typeof document !== 'undefined' ? document : null)) {
  if (!doc) return '';
  const i = inputs || {};
  const el = (id) => (doc.getElementById ? doc.getElementById(id) : null);
  const varNames = [];
  for (const sheet of Array.from(doc.styleSheets || [])) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const r of Array.from(rules || [])) {
      if (!r.style) continue;
      for (const prop of Array.from(r.style)) if (prop.startsWith('--')) varNames.push(prop);
    }
  }
  const root = (doc.defaultView || globalThis).getComputedStyle(doc.documentElement);
  const vars = [...new Set(varNames)]
    .map((n) => `  ${n}: ${root.getPropertyValue(n).trim()};`).join('\n');

  const css = [];
  const links = [];
  for (const sheet of Array.from(doc.styleSheets || [])) {
    let rules;
    try { rules = sheet.cssRules; } catch {
      if (sheet.href) links.push(`<link rel="stylesheet" href="${esc(sheet.href)}">`);
      continue;
    }
    for (const r of Array.from(rules || [])) css.push(r.cssText);
  }

  // EVERY SECTION OPEN IN THE FILE. On the page a long block is collapsed so the thing is
  // scannable; in a file it is a page to read end to end, and a reader who has to click twenty
  // triangles to find out what was sent has been handed the same problem the copy-and-paste was.
  // `open` is an attribute, not a style, so this is markup and not CSS.
  const openAll = (h) => String(h || '').replace(/<details(?![^>]*\bopen\b)/g, '<details open');

  const head = el('benchPlanHead');
  const plan = el('benchPlan');
  const out = el('benchOut');
  const title = `TrollMap bench — ${i.lakeName || 'no water'} — ${i.dateStr || ''}`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${links.join('\n')}
<style>
:root {
${vars}
}
${css.join('\n')}
/* The app's chrome is not in this file, so the panel has to stand on its own. */
body { margin: 0; padding: 16px; }
.bench-export-hdr { font-size: 12px; color: var(--muted); margin: 0 0 14px;
                    padding-bottom: 10px; border-bottom: 1px solid var(--line); }
</style></head><body>
<div class="bench-export-hdr">
  <b>${esc(title)}</b><br>
  ${esc(i.rampName || 'no ramp')} · ${esc(i.launchTime || '?')}–${esc(i.returnTime || '?')} ·
  ${esc((i.species || []).join(', ') || 'no species')}<br>
  ${esc(lastMode === 'bench' ? 'Sent to the model.' : 'Dry run — the prompt only, nothing sent.')}
  Exported ${esc(new Date().toLocaleString())}. Nothing in this file was saved, sent to the phone,
  or written to GPX.<br>
  Personal use only, not for distribution or resale; not for navigation.
</div>
${head && !head.hidden ? `<div class="bench-head">${head.innerHTML}</div>` : ''}
${plan ? openAll(plan.innerHTML) : ''}
${out ? openAll(out.innerHTML) : ''}
</body></html>`;
}
