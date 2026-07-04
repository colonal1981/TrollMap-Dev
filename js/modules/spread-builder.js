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
  // Added 2026-07-03: 2oz inline trolling weight rig — 5ft fluoro leader,
  // swivel snap, any lure (spoon/bucktail/swimbait) tied on. Different
  // sink/depth behavior than a jighead-weighted A-Rig — see
  // autoCalculateLead() in smart-plan.js for the lead-length formula.
  'Spinning / 30lb braid + 2oz inline trolling weight + 5ft fluoro leader + swivel snap',
];

export const LURE_PRESETS = [
  '— A-Rigs —',
  'A-Rig Light (~1.65oz) – 3.8" Swimbait',
  'A-Rig Medium (~2.65oz) – 4.6" Swimbait',
  'A-Rig Heavy (~3.5oz) – 5" Swimbait',
  '— Crankbaits —',
  'Flicker Minnow 11 – Crankbait',
  'Deep Hit Stick – Crankbait',
  'Bandit 300 Series – Crankbait',
  'Rapala DT-10 – Crankbait (shallow/medium, ~10ft)',
  'Rapala DT-14 – Crankbait (medium/deep, ~14ft)',
  'Lipless Crankbait 1/2oz',
  '— Swimbaits —',
  'Swimbait 3.8" – Jighead',
  'Swimbait 4.6" – Jighead',
  'Swimbait 5" – Jighead',
  '— Spoons —',
  'Flutter Spoon 2oz',
  'Flutter Spoon 3oz',
  'Kastmaster 3/4oz',
  '— Topwater —',
  'Choppo 90 – Topwater',
  'Zara Spook – Topwater',
  'Whopper Plopper 110 – Topwater',
  'Buzzbait 1/2oz – Topwater',
  '— Popping Cork (troll or cast) —',
  'Popping Cork',
  '— Jigs / Reaction —',
  'ChatterBait 3/4oz',
  'Bucktail Jig 1oz',
  'Marabou Jig 3/4oz',
  'Spinnerbait 1/2oz',
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
  const reel = (rod.reel || '').toLowerCase();
  if (depth <= 0 || lure.includes('topwater') || lure.includes('plopper') || lure.includes('wake') || lure.includes('buzz') || lure.includes('spook')) {
    return 80;  // professional flat-line topwater setback
  }
  if (isNaN(depth)) return rod.lead || '';

  const spd = speedMph || 2.4;

  // Added 2026-07-03: 2oz inline trolling weight rig. This is a fixed known
  // weight independent of which lure is tied to the swivel snap, so check
  // the reel/rig field rather than the lure field. Inline weight dive depth
  // is meaningfully speed-sensitive (unlike the fixed-ratio formulas below,
  // which don't currently account for speed at all) — faster trolling needs
  // more line out for the same depth, based on standard 2oz inline weight
  // trolling charts (~1.5mph baseline, roughly -8% line-out efficiency per
  // +0.5mph above that).
  if (reel.includes('inline') && reel.includes('weight')) {
    const baseMultiplier = 3.6; // ft of line per ft of depth at ~1.5mph
    const speedPenalty = 1 + Math.max(0, (spd - 1.5)) * 0.16;
    return Math.round(depth * baseMultiplier * speedPenalty);
  }

  if (lure.includes('light') || lure.includes('1.65')) return Math.round(depth * 4.5);
  if (lure.includes('medium') || lure.includes('2.65')) return Math.round(depth * 3.8);
  if (lure.includes('heavy') || lure.includes('3.5')) return Math.round(depth * 3.2);
  if (lure.includes('spoon') || lure.includes('flutter')) return Math.round(depth * 3.5);
  if (lure.includes('lipless')) return Math.round(depth * 3.3); // denser/faster-sinking than a standard crank
  if (lure.includes('spinnerbait')) return Math.round(depth * 4.8); // blade lift keeps it running shallower for a given lead
  if (lure.includes('popping cork')) return 90; // surface presentation, short flat-line lead regardless of depth input — same logic as topwater
  if (lure.includes('flicker minnow 11') || lure.includes('crankbait')) {
    if (depth <= 12) return Math.round(depth * 3.0);
    if (depth <= 20) return Math.round(depth * 3.8);
    return Math.round(depth * 5.2);
  }
  if (lure.includes('hit stick') || lure.includes('rapala')) return Math.round(depth * 4.2);
  return Math.round(depth * 4.0);
}

// ── Main renderer ─────────────────────────────────────────────────────────

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
