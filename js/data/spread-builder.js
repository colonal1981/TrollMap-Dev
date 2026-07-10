/**
 * Rod Spread Builder — the table UI in the Plan tab where each rod
 * is configured (side, position, rod, reel, lure, color, depth,
 * lead, notes). Also covers the per-lure detail rows (A-Rig
 * framework / jighead keel / swim trailer profile) that show up
 * when an A-Rig or swimbait is selected, and the speed→lead
 * auto-calculation.
 *
 * The plan-builder module consumes this to wire the spread into
 * the full plan preview / save / load flow.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { newRodRow } from '../utils/rod-row.js';

// ── Catalog of presets ────────────────────────────────────────────────────

export const ROD_PRESETS = [
  '6\'6" M Mod-Fast Spinning (Ugly Stik Lite Pro)',
  '7\' M Mod-Fast Spinning (Ugly Stik Lite Pro)',
];

export const REEL_PRESETS = [
  'Spinning / 30lb 8-strand braid + 20lb fluoro leader',
  'Spinning / 30lb 8-strand braid directly tied to swivel snap',
];

export const LURE_PRESETS = [
  '— A-Rigs —',
  'A-Rig Light (~1.65oz)',
  'A-Rig Medium (~2.65oz)',
  'A-Rig Heavy (~3.5oz)',
  '— Crankbaits —',
  'Squarebill Crankbait',
  'SR Crankbait (3-5ft)',
  'MR Crankbait (6-12ft)',
  'DD1 Crankbait (14-18ft)',
  'DD2 Crankbait (16-20ft)',
  'DD3 Crankbait (20-25ft)',
  'DD4 Crankbait (25ft+)',
  '— Lipless & Blade Vibes —',
  '2" Lipless Crankbait',
  '3" Lipless Crankbait',
  '4" Lipless Crankbait',
  '3" Blade Vibe Bait',
  '— Swimbaits —',
  '3" Paddle Tail Swimbait',
  '4" Paddle Tail Swimbait',
  '5" Paddle Tail Swimbait',
  '— Spoons —',
  'Flutter Spoon 2oz',
  'Flutter Spoon 3oz',
  '— Spinnerbaits & Chatterbaits —',
  '1/4oz Spinnerbait',
  '3/8oz Spinnerbait',
  '1/2oz Spinnerbait',
  '1/4oz Chatterbait',
  '3/8oz Chatterbait',
  '1/2oz Chatterbait',
  '— Jigs —',
  '3/4oz Bucktail Jig',
  '1oz Bucktail Jig',
  '3/4oz Marabou Jig',
  '1/8oz Road Runner / Beetle Spin',
  '1/4oz Road Runner / Beetle Spin',
  '3/8oz Road Runner / Beetle Spin',
  '— Topwater (Trollable) —',
  'Walking Bait / Spook',
  'Prop Bait / Choppo',
  'Whopper Plopper',
  'Wake Bait',
  '— Topwater (Cast Only) —',
  'Popper / Chugger',
  'Buzzbait',
  'Hollow Body Frog',
];

export const COLOR_PRESETS = [
  '— Natural —',
  'Natural Pearl / Smoke',
  'Blueback Herring',
  'Alewife / Silver Flash',
  'Tennessee Shad',
  'Ghost / Transparent',
  'Grey Shad',
  '— Bright / High Contrast —',
  'Chartreuse / White',
  'Chartreuse / Shad',
  'Firetiger',
  'Hot Pink',
  'White / UV',
  'Clown / Multi',
  '— Dark / Muddy —',
  'Black / Blue',
  'Dark Shad',
  'Junebug / Purple',
  '— Metallic —',
  'Chrome / Silver',
  'Shattered Glass Silver',
  'Gold / Copper',
  'Blue / Silver Herring',
  'Sexy Shad',
  'Bone / Natural',
];

export const ARIG_WEIGHTS = [
  '~1.65oz (5-wire light)',
  '~2.0oz (5-wire medium-light)',
  '~2.65oz (5-wire medium)',
  '~3.5oz (5-wire heavy)',
  '~4.0oz (5-wire XH)',
];

export const JIGHEAD_WEIGHTS = ['1/8oz', '3/16oz', '1/4oz', '3/8oz', '1/2oz', '3/4oz', '1oz'];

export const TRAILER_SIZES = [
  '3.3" swimbait', '3.8" swimbait', '4.6" swimbait',
  '5" swimbait', '5.5" swimbait', '7" swimbait',
];

/**
 * Lure dive depth characteristics at typical trolling speed (1.8-2.2mph).
 * minDive: shallowest the lure runs (ft) — used to flag "too shallow for target"
 * maxDive: deepest the lure runs at max lead without weight (ft)
 * needsWeight: true if reaching deeper requires inline weight
 * weightPerFoot: approximate ft of depth per oz of inline weight added
 */
export const LURE_DIVE_DEPTHS = {
  // A-Rigs — depth fully controlled by lead length + jighead weight
  'A-Rig Light (~1.65oz)':  { minDive: 2,  maxDive: 40, needsWeight: false },
  'A-Rig Medium (~2.65oz)': { minDive: 2,  maxDive: 45, needsWeight: false },
  'A-Rig Heavy (~3.5oz)':   { minDive: 2,  maxDive: 50, needsWeight: false },
  // Crankbaits — fixed dive curves
  'Squarebill Crankbait':    { minDive: 1,  maxDive: 4,  needsWeight: false },
  'SR Crankbait (3-5ft)':    { minDive: 3,  maxDive: 6,  needsWeight: false },
  'MR Crankbait (6-12ft)':   { minDive: 6,  maxDive: 12, needsWeight: false },
  'DD1 Crankbait (14-18ft)': { minDive: 14, maxDive: 18, needsWeight: false },
  'DD2 Crankbait (16-20ft)': { minDive: 16, maxDive: 20, needsWeight: false },
  'DD3 Crankbait (20-25ft)': { minDive: 20, maxDive: 25, needsWeight: false },
  'DD4 Crankbait (25ft+)':   { minDive: 25, maxDive: 35, needsWeight: false },
  // Lipless & Blade
  '2" Lipless Crankbait':    { minDive: 2,  maxDive: 20, needsWeight: false },
  '3" Lipless Crankbait':    { minDive: 2,  maxDive: 20, needsWeight: false },
  '4" Lipless Crankbait':    { minDive: 2,  maxDive: 20, needsWeight: false },
  '3" Blade Vibe Bait':      { minDive: 2,  maxDive: 25, needsWeight: false },
  // Swimbaits — depth by lead + jighead
  '3" Paddle Tail Swimbait': { minDive: 2,  maxDive: 30, needsWeight: false },
  '4" Paddle Tail Swimbait': { minDive: 2,  maxDive: 35, needsWeight: false },
  '5" Paddle Tail Swimbait': { minDive: 2,  maxDive: 40, needsWeight: false },
  // Spoons
  'Flutter Spoon 2oz':       { minDive: 4,  maxDive: 45, needsWeight: false },
  'Flutter Spoon 3oz':       { minDive: 6,  maxDive: 55, needsWeight: false },
  // Spinnerbaits
  '1/4oz Spinnerbait':       { minDive: 1,  maxDive: 8,  needsWeight: false },
  '3/8oz Spinnerbait':       { minDive: 1,  maxDive: 10, needsWeight: false },
  '1/2oz Spinnerbait':       { minDive: 1,  maxDive: 12, needsWeight: false },
  // Chatterbaits
  '1/4oz Chatterbait':       { minDive: 1,  maxDive: 8,  needsWeight: false },
  '3/8oz Chatterbait':       { minDive: 1,  maxDive: 10, needsWeight: false },
  '1/2oz Chatterbait':       { minDive: 1,  maxDive: 12, needsWeight: false },
  // Jigs
  '3/4oz Bucktail Jig':      { minDive: 2,  maxDive: 35, needsWeight: false },
  '1oz Bucktail Jig':        { minDive: 2,  maxDive: 40, needsWeight: false },
  '3/4oz Marabou Jig':       { minDive: 2,  maxDive: 30, needsWeight: false },
  '1/8oz Road Runner / Beetle Spin': { minDive: 1, maxDive: 10, needsWeight: false },
  '1/4oz Road Runner / Beetle Spin': { minDive: 1, maxDive: 15, needsWeight: false },
  '3/8oz Road Runner / Beetle Spin': { minDive: 1, maxDive: 20, needsWeight: false },
  // Topwater
  'Walking Bait / Spook':    { minDive: 0,  maxDive: 1,  needsWeight: false },
  'Prop Bait / Choppo':      { minDive: 0,  maxDive: 1,  needsWeight: false },
  'Whopper Plopper':         { minDive: 0,  maxDive: 1,  needsWeight: false },
  'Wake Bait':               { minDive: 0,  maxDive: 2,  needsWeight: false },
  'Popper / Chugger':        { minDive: 0,  maxDive: 1,  needsWeight: false },
  'Buzzbait':                { minDive: 0,  maxDive: 1,  needsWeight: false },
  'Hollow Body Frog':        { minDive: 0,  maxDive: 1,  needsWeight: false },
};

// ── Per-row select builders (return HTML strings) ─────────────────────────

function rodSelect(val, i) {
  const opts = ROD_PRESETS.map((v) => `<option value="${esc(v)}" ${val === v ? 'selected' : ''}>${esc(v)}</option>`).join('');
  return `<select data-f="rod" data-i="${i}" class="spread-select" style="min-width:140px;max-width:280px"><option value="">— select —</option>${opts}</select>`;
}

function reelSelect(val, i) {
  const opts = REEL_PRESETS.map((v) => `<option value="${esc(v)}" ${val === v ? 'selected' : ''}>${esc(v)}</option>`).join('');
  return `<select data-f="reel" data-i="${i}" class="spread-select" style="min-width:160px;max-width:360px"><option value="">— select —</option>${opts}</select>`;
}

function lureSelect(val, i) {
  const opts = LURE_PRESETS.map((v) => {
    if (v.startsWith('—')) return `<option disabled>${v}</option>`;
    return `<option value="${esc(v)}" ${val === v ? 'selected' : ''}>${esc(v)}</option>`;
  }).join('');
  return `<select data-f="lure" data-i="${i}" class="spread-select" style="min-width:160px;max-width:300px"><option value="">— select —</option>${opts}</select>`;
}

function colorSelect(val, i) {
  const opts = COLOR_PRESETS.map((v) => {
    if (v.startsWith('—')) return `<option disabled>${v}</option>`;
    return `<option value="${esc(v)}" ${val === v ? 'selected' : ''}>${esc(v)}</option>`;
  }).join('');
  return `<select data-f="color" data-i="${i}" class="spread-select" style="min-width:130px;max-width:240px"><option value="">— select —</option>${opts}</select>`;
}

/**
 * The detail row that appears below an A-Rig or swimbait row.
 * Shows framework weight, jighead keel config, and trailer profile.
 */
function arigDetailRow(rod, i) {
  const isARig = rod.lure && rod.lure.includes('Rig');
  const isSwimbait = rod.lure && rod.lure.toLowerCase().includes('swimbait');
  if (!isARig && !isSwimbait) return '';

  const arigCols = isARig ? (
    '<td colspan="2">' +
      '<label style="font-size:10px;color:var(--muted)">Rig wire framework</label>' +
      '<select data-f="arigWeight" data-i="' + i + '" style="font-size:11px;width:100%">' +
      '<option value="">— select —</option>' +
      ARIG_WEIGHTS.map((w) => '<option value="' + w + '" ' + ((rod.arigWeight || '') === w ? 'selected' : '') + '>' + w + '</option>').join('') +
      '</select></td>' +
    '<td colspan="2">' +
      '<label style="font-size:10px;color:var(--muted)">Tactical Keel / Jighead Weights</label>' +
      '<select data-f="jigWeight" data-i="' + i + '" style="font-size:11.5px;width:100%;background:var(--panel2);color:var(--accent2);font-weight:700">' +
      '<option value="">— choose hybrid keel or uniform setup —</option>' +
      '<optgroup label="Tournament Hybrid Keels (Upright Tracking)">' +
      ['1/8oz Top (×3) + 1/4oz Bottom (×2)','1/8oz Top (×3) + 3/8oz Bottom (×2)','3/16oz Top (×3) + 3/8oz Bottom (×2)','1/4oz Top (×3) + 1/2oz Bottom (×2)']
        .map((w) => '<option value="' + w + '" ' + ((rod.jigWeight || '') === w ? 'selected' : '') + '>' + w + '</option>').join('') +
      '</optgroup>' +
      '<optgroup label="3-Hook Maximum Legal Rigs">' +
      ['2 Dummy Blades Top + three 1/4oz Hook Baits Bottom', '2 Dummy Blades Top + two 1/8oz Mid + one 3/8oz Hook Bottom']
        .map((w) => '<option value="' + w + '" ' + ((rod.jigWeight || '') === w ? 'selected' : '') + '>' + w + '</option>').join('') +
      '</optgroup>' +
      '<optgroup label="Uniform Setup">' +
      JIGHEAD_WEIGHTS.map((w) => '<option value="' + w + ' × 5" ' + ((rod.jigWeight || '') === (w + ' × 5') ? 'selected' : '') + '>' + w + ' × 5 (Uniform)</option>').join('') +
      '</optgroup></select></td>'
  ) : '<td colspan="4"></td>';

  return '<tr class="arig-detail-row" data-arig="' + i + '" style="background:var(--panel2)">' +
    '<td></td>' +
    '<td colspan="2" style="font-size:11px;color:var(--accent);padding:4px 6px;vertical-align:middle">↳ ' + (isARig ? 'A-Rig Setup' : 'Swimbait Profile') + '</td>' +
    arigCols +
    '<td colspan="3">' +
      '<label style="font-size:10px;color:var(--muted)">Swimbait Trailer Profile</label>' +
      '<select data-f="trailerSize" data-i="' + i + '" style="font-size:11px;width:100%">' +
      '<option value="">— select —</option>' +
      TRAILER_SIZES.map((w) => '<option value="' + w + '" ' + ((rod.trailerSize || '') === w ? 'selected' : '') + '>' + w + '</option>').join('') +
      '</select></td>' +
    '<td></td></tr>';
}

// ── Lead-length auto-calculation ─────────────────────────────────────────

/**
 * Approximate line-out needed to put the lure at the target depth,
 * given the lure type and trolling speed. Rules-of-thumb calibrated
 * for Carolina reservoir trolling.
 *
 * @param {Object} rod — { depth, lure, lead }
 * @param {number} speedMph — trolling speed
 * @returns {number} lead length in feet
 */
export function autoCalculateLead(rod, speedMph) {
  const depth = parseFloat(rod.depth);
  const lure = (rod.lure || '').toLowerCase();
  if (depth <= 0 || lure.includes('topwater') || lure.includes('plopper') || lure.includes('wake') || lure.includes('buzz') || lure.includes('spook')) {
    return 80;  // professional flat-line topwater setback
  }
  if (isNaN(depth)) return rod.lead || '';

  const spd = speedMph || 2.4;
  // A-Rig lead calc: 5-wire umbrella rigs have massive drag at trolling speed.
  // At 1.8mph, 3/16oz jigs: ~7.5ft of lead per foot of depth for light, ~6.5 for medium, ~5.5 for heavy.
  // These are calibrated for 1.8-2.0mph. At higher speeds lures run shallower — add lead.
  const speedFactor = spd > 2.2 ? 1.15 : spd < 1.6 ? 0.88 : 1.0;
  if (lure.includes('light') || lure.includes('1.65')) return Math.round(depth * 7.5 * speedFactor);
  if (lure.includes('medium') || lure.includes('2.65')) return Math.round(depth * 6.5 * speedFactor);
  if (lure.includes('heavy') || lure.includes('3.5')) return Math.round(depth * 5.5 * speedFactor);
  if (lure.includes('spoon') || lure.includes('flutter')) return Math.round(depth * 3.5);
  if (lure.includes('squarebill') || lure.includes('sr crankbait')) return Math.round(depth * 2.5);
  if (lure.includes('mr crankbait')) return Math.round(depth * 3.0);
  if (lure.includes('dd')) return Math.round(depth * 3.5);
  if (lure.includes('lipless') || lure.includes('blade vibe')) return Math.round(depth * 3.8);
  if (lure.includes('paddle tail') || lure.includes('swimbait')) return Math.round(depth * 4.5);
  if (lure.includes('spinnerbait') || lure.includes('chatterbait')) return Math.round(depth * 3.0);
  if (lure.includes('bucktail') || lure.includes('marabou') || lure.includes('road runner')) return Math.round(depth * 4.0);
  return Math.round(depth * 4.0);
}

/**
 * Render the rod-spread table from state.SPREAD. Each row has a
 * delete button and inline-editable selects/inputs. Changes to
 * lure or depth trigger lead re-calculation (if speed is set).
 */
export function renderSpread() {
  const tbody = document.getElementById('spreadBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  state.SPREAD.forEach((rod, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="text-align:center">${i + 1}</td>
      <td><select data-f="side" data-i="${i}" class="spread-select">
        <option ${rod.side === 'Port' ? 'selected' : ''}>Port</option>
        <option ${rod.side === 'Starboard' ? 'selected' : ''}>Starboard</option>
        <option ${rod.side === 'Center' ? 'selected' : ''}>Center</option>
      </select></td>
      <td><select data-f="position" data-i="${i}" class="spread-select">
        ${['Bow', 'Mid', 'Stern'].map((p) => `<option ${rod.position === p ? 'selected' : ''}>${p}</option>`).join('')}
      </select></td>
      <td>${rodSelect(rod.rod, i)}</td>
      <td>${reelSelect(rod.reel, i)}</td>
      <td>${lureSelect(rod.lure, i)}</td>
      <td>${colorSelect(rod.color, i)}</td>
      <td><input data-f="depth" data-i="${i}" class="spread-input" value="${esc(rod.depth)}" placeholder="e.g. 28" style="width:70px"></td>
      <td><input data-f="lead" data-i="${i}" class="spread-input" value="${esc(rod.lead)}" placeholder="Auto" readonly style="width:75px;background:rgba(0,229,255,0.1);color:var(--accent)"></td>
      <td><input data-f="notes" data-i="${i}" class="spread-select" value="${esc(rod.notes)}" placeholder="Structure pass notes" style="min-width:120px"></td>
      <td style="text-align:center"><button class="small" data-del="${i}" style="color:var(--bad);background:transparent">✕</button></td>
    `;
    tbody.appendChild(tr);

    const detailHtml = arigDetailRow(rod, i);
    if (detailHtml) {
      const tbl = document.createElement('table');
      tbl.innerHTML = '<tbody>' + detailHtml + '</tbody>';
      const detailRow = tbl.querySelector('tr');
      if (detailRow) tbody.appendChild(detailRow);
    }
  });

  // Post-render explicit value sync for trailer/arig/jig selects.
  // The 'selected' attrs in arigDetailRow HTML sometimes don't take for the
  // dynamically appended detail <tr> after loadPlanIntoForm/renderSpread.
  // This guarantees the swimbait trailer profile (and A-rig weights) survive
  // load/save and appear correctly in the editable table.
  state.SPREAD.forEach((rod, i) => {
    const trailerSel = tbody.querySelector(`select[data-f="trailerSize"][data-i="${i}"]`);
    if (trailerSel) trailerSel.value = rod.trailerSize || '';

    const arigSel = tbody.querySelector(`select[data-f="arigWeight"][data-i="${i}"]`);
    if (arigSel) arigSel.value = rod.arigWeight || '';

    const jigSel = tbody.querySelector(`select[data-f="jigWeight"][data-i="${i}"]`);
    if (jigSel) jigSel.value = rod.jigWeight || '';
  });

  // Wire change handlers
  tbody.querySelectorAll('input,select').forEach((el) => {
    el.addEventListener('change', (e) => {
      const i = +e.target.dataset.i;
      const f = e.target.dataset.f;
      if (!state.SPREAD[i]) return;
      state.SPREAD[i][f] = e.target.value;

      // Re-calc lead if lure/depth/speed changed
      if (f === 'lure' || f === 'depth') {
        const spd = parseFloat(document.getElementById('planSpeed')?.value) || 2.4;
        state.SPREAD[i].lead = String(autoCalculateLead(state.SPREAD[i], spd));
        renderSpread();
      }
    });
  });

  // Delete button
  tbody.querySelectorAll('[data-del]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const i = +e.target.dataset.del;
      state.SPREAD.splice(i, 1);
      renderSpread();
    });
  });
}

// ── Button wiring ─────────────────────────────────────────────────────────

function wireButtons() {
  document.getElementById('addRodBtn')?.addEventListener('click', () => {
    state.SPREAD.push(newRodRow());
    renderSpread();
  });

  document.getElementById('fillDefaultSpreadBtn')?.addEventListener('click', () => {
    state.SPREAD = [
      newRodRow({ side: 'Port', position: 'Bow', reel: 'Spinning / 30lb 8-strand braid + 20lb fluoro leader', lure: 'A-Rig Medium (~2.65oz) – 4.6" Swimbait', color: 'Blueback Herring', depth: '25', lead: '95', notes: 'Port ledge channel' }),
      newRodRow({ side: 'Starboard', position: 'Bow', reel: 'Spinning / 30lb 8-strand braid + 20lb fluoro leader', lure: 'A-Rig Medium (~2.65oz) – 4.6" Swimbait', color: 'Natural Pearl / Smoke', depth: '25', lead: '95', notes: 'Starboard ledge' }),
      newRodRow({ side: 'Port', position: 'Mid', reel: 'Spinning / 30lb 8-strand braid + 20lb fluoro leader', lure: 'Flicker Minnow 11 – Crankbait', color: 'Blue / Silver Herring', depth: '28', lead: '106', notes: 'Port secondary bottom drop' }),
      newRodRow({ side: 'Starboard', position: 'Mid', reel: 'Spinning / 30lb 8-strand braid + 20lb fluoro leader', lure: 'Flicker Minnow 11 – Crankbait', color: 'Sexy Shad', depth: '28', lead: '106', notes: 'Starboard secondary bottom drop' }),
      newRodRow({ side: 'Port', position: 'Stern', reel: 'Spinning / 30lb 8-strand braid directly tied to swivel snap', lure: 'Flutter Spoon 2oz', color: 'Shattered Glass Silver', depth: '32', lead: '112', notes: 'Port deep flutter tail' }),
      newRodRow({ side: 'Starboard', position: 'Stern', reel: 'Spinning / 30lb 8-strand braid directly tied to swivel snap', lure: 'Flutter Spoon 2oz', color: 'Chrome / Silver', depth: '32', lead: '112', notes: 'Starboard deep flutter tail' }),
    ];
    renderSpread();
  });

  // Re-calculate all leads when trolling speed changes
  document.getElementById('planSpeed')?.addEventListener('change', (e) => {
    const spd = parseFloat(e.target.value) || 2.4;
    state.SPREAD.forEach((rod) => {
      if (rod.depth) rod.lead = String(autoCalculateLead(rod, spd));
    });
    renderSpread();
  });
}

wireButtons();
