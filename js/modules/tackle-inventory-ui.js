/**
 * tackle-inventory-ui.js — Collapsible tackle inventory panel in the Plan tab.
 * Collapsed by default — click to expand, edit, add, or remove lures.
 * All changes persist to IndexedDB via tackle-inventory.js.
 */

import { getInventory, saveInventory } from '../data/tackle-inventory.js';
import { LURE_KNOWLEDGE } from '../data/lure-knowledge.js';
import { LURE_KNOWLEDGE } from '../data/lure-knowledge.js';

const TYPE_LABELS = {
  crankbait_squarebill: 'Squarebill',
  crankbait_sr:         'SR Crankbait',
  crankbait_mr:         'MR Crankbait',
  crankbait_dd1:        'DD1 (14-18ft)',
  crankbait_dd2:        'DD2 (16-20ft)',
  crankbait_dd3:        'DD3 (20-25ft)',
  crankbait_dd4:        'DD4 (25ft+)',
  lipless:              'Lipless Crankbait',
  blade_vibe:           'Blade Vibe',
  umbrella_rig:         'A-Rig',
  swimbait_paddle:      'Paddle Tail Swimbait',
  flutter_spoon:        'Flutter Spoon',
  spinnerbait:          'Spinnerbait',
  chatterbait:          'Chatterbait',
  bucktail:             'Bucktail Jig',
  marabou_jig:          'Marabou Jig',
  jighead:              'Jighead',
  road_runner:          'Road Runner / Beetle Spin',
  topwater_troll:       'Topwater (Troll)',
  topwater_cast:        'Topwater (Cast)',
  cast_only:            'Cast Only',
};

function depthLabel(lure) {
  if (lure.minDepth === null || lure.maxDepth === null) return 'Variable';
  if (lure.minDepth === 0 && lure.maxDepth <= 1) return 'Surface';
  return `${lure.minDepth}–${lure.maxDepth}ft`;
}

async function renderTable(body) {
  const inv = await getInventory();
  const trollable = inv.filter(l => l.trollable);
  const castOnly  = inv.filter(l => !l.trollable);

  body.innerHTML = `
    <div style="font-size:10px;color:var(--muted);margin-bottom:6px">
      ${trollable.length} trollable · ${castOnly.length} cast-only · auto-saves to device
    </div>
    <div style="max-height:260px;overflow-y:auto;border:1px solid var(--line);border-radius:6px">
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <thead>
          <tr style="background:var(--panel2);position:sticky;top:0;z-index:1">
            <th style="padding:5px 8px;text-align:left;color:var(--muted)">Lure</th>
            <th style="padding:5px 8px;text-align:left;color:var(--muted)">Type</th>
            <th style="padding:5px 8px;text-align:center;color:var(--muted)">Depth</th>
            <th style="padding:5px 8px;text-align:center;color:var(--muted)">Troll</th>
            <th style="width:24px"></th>
          </tr>
        </thead>
        <tbody>
          ${inv.map((lure, i) => `
            <tr style="border-top:1px solid var(--line);${!lure.trollable ? 'opacity:0.5' : ''}">
              <td style="padding:4px 8px;color:var(--text)">${lure.name}</td>
              <td style="padding:4px 8px;color:var(--muted);font-size:10px">${TYPE_LABELS[lure.type] || lure.type}</td>
              <td style="padding:4px 8px;text-align:center;color:var(--accent2);font-size:10px">${depthLabel(lure)}</td>
              <td style="padding:4px 8px;text-align:center">${lure.trollable ? '✅' : '—'}</td>
              <td style="padding:2px 4px;text-align:center">
                <button data-del="${i}" style="background:none;border:none;color:var(--bad);cursor:pointer;font-size:13px;line-height:1;padding:0" title="Remove">✕</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <div style="margin-top:8px;display:flex;gap:5px;flex-wrap:wrap;align-items:center">
      <input id="tackleNewName" placeholder="Lure name..." style="flex:2;min-width:110px;padding:4px 7px;font-size:11px;border:1px solid var(--line);border-radius:5px;background:var(--panel2);color:var(--text)">
      <select id="tackleNewType" style="flex:1;min-width:110px;padding:4px 5px;font-size:11px;border:1px solid var(--line);border-radius:5px;background:var(--panel2);color:var(--text)">
        ${Object.entries(TYPE_LABELS).map(([k,v]) => `<option value="${k}">${v}</option>`).join('')}
      </select>
      <input id="tackleNewMin" placeholder="Min ft" type="number" min="0" max="100" style="width:56px;padding:4px 5px;font-size:11px;border:1px solid var(--line);border-radius:5px;background:var(--panel2);color:var(--text)">
      <input id="tackleNewMax" placeholder="Max ft" type="number" min="0" max="100" style="width:56px;padding:4px 5px;font-size:11px;border:1px solid var(--line);border-radius:5px;background:var(--panel2);color:var(--text)">
      <button id="tackleAddBtn" style="padding:4px 12px;font-size:11px;font-weight:700;border:1px solid var(--accent);border-radius:5px;background:var(--accent);color:#000;cursor:pointer;white-space:nowrap">+ Add</button>
    </div>
  `;

  // Delete handler
  body.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const inv2 = await getInventory();
      inv2.splice(+btn.dataset.del, 1);
      await saveInventory(inv2);
      renderTable(body);
    });
  });

  // Add handler
  body.querySelector('#tackleAddBtn')?.addEventListener('click', async () => {
    const name = body.querySelector('#tackleNewName')?.value?.trim();
    const type = body.querySelector('#tackleNewType')?.value;
    const minD = body.querySelector('#tackleNewMin')?.value;
    const maxD = body.querySelector('#tackleNewMax')?.value;
    if (!name) return;
    const castOnlyTypes = ['topwater_cast', 'cast_only'];
    const inv2 = await getInventory();
    inv2.push({
      id: `custom_${Date.now()}`,
      name, type,
      trollable: !castOnlyTypes.includes(type),
      minDepth: minD ? parseFloat(minD) : null,
      maxDepth: maxD ? parseFloat(maxD) : null,
      weightOz: null,
    });
    await saveInventory(inv2);
    body.querySelector('#tackleNewName').value = '';
    renderTable(body);
  });
}

export async function initTackleInventoryPanel() {
  const planTab = document.getElementById('panel-plan');
  if (!planTab) return;

  // Find insertion point — after #planTackle textarea or at end of plan pad
  const tackleField = planTab.querySelector('#planTackle');
  const insertAfter = tackleField?.closest('div, section, .plan-section') || planTab.querySelector('.pad');
  if (!insertAfter) return;

  const wrapper = document.createElement('div');
  wrapper.id = 'tackleInventoryWrapper';
  wrapper.style.cssText = 'margin-top:12px;border-top:1px solid var(--line);padding-top:10px';
  wrapper.innerHTML = `
    <div id="tackleInventoryToggle" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;padding:2px 0">
      <span style="font-size:11px;font-weight:700;color:var(--accent)">🎣 Tackle Inventory</span>
      <span id="tackleChevron" style="font-size:11px;color:var(--muted)">▶ collapsed</span>
    </div>
    <div id="tackleInventoryBody" style="display:none;margin-top:8px"></div>
  `;

  insertAfter.after ? insertAfter.after(wrapper) : insertAfter.parentNode.appendChild(wrapper);

  const toggle  = wrapper.querySelector('#tackleInventoryToggle');
  const chevron = wrapper.querySelector('#tackleChevron');
  const body    = wrapper.querySelector('#tackleInventoryBody');
  let open = false;

  toggle.addEventListener('click', async () => {
    open = !open;
    body.style.display = open ? 'block' : 'none';
    chevron.textContent = open ? '▼ expanded' : '▶ collapsed';
    if (open) await renderTable(body);
  });

  console.log('[tackle-inventory-ui] panel ready');
}
