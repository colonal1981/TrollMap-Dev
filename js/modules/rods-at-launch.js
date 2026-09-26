/**
 * rods-at-launch.js — what every rod on the boat is rigged with before the boat leaves the ramp,
 * and every lure change after that.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-09-25, reading the report for the plan he fished the next morning: "the one thing the
 * plan html is really missing that would make it better is a section that just shows what all 6
 * rods are rigged with to start the day and then any lure changes... i do not see that section on
 * this html".
 *
 * THE REPORT HAD ONE, AND IT ONLY PRINTED ON DAYS WITH A CAST-ONLY ROD. plan-builder.js built its
 * "Pre-Rig Before Launch" table inside `if (castRods.length)`, so the ordinary day -- every rigged
 * rod trolls -- printed no rigging list at all. And on the days it did print, the trolling rows came
 * off the spread, which lists the rods that go in the WATER: a rod the plan rigged and never
 * deployed was not on it, so "every rod on the boat" was four rods.
 *
 * This reads the plan's own loadout for the rods, because that is every rod, and the exported
 * timeline for when each one fishes, because that is the order the day happens in. Nothing here is
 * computed that the plan does not already say; it is the same facts, arranged as a rigging list.
 */
import { ROD_IDS, ROD_RIG } from './plan-prompt.js';

const str = (v) => (v == null ? '' : String(v).trim());

const sideOf = (v) => {
  const t = str(v).toLowerCase();
  if (t.startsWith('p')) return 'port';
  if (t.startsWith('s')) return 'starboard';
  return t;
};

// The cast stops name their baits as "R6: 3\" Lipless Crankbait" -- the rod id is the part that is
// the fact; the lure after it is the stop's own wording. Objects are accepted for older exports.
const rodIdIn = (l) => {
  const t = typeof l === 'string' ? l : (l && (l.rod || l.rodId || l.name || l.lure)) || '';
  const m = /^\s*(R\d+)\b/.exec(String(t));
  return m ? m[1] : null;
};

// The same two sentences plan-to-timeline.js prints for a change's cost, so the rigging list and
// the swap cue can never describe one rod two ways.
const TERMINAL = { fluoro: '20 lb fluoro leader — tie direct', snap: 'swivel snap' };

const idOrder = (a, b) => {
  const ia = ROD_IDS.indexOf(a); const ib = ROD_IDS.indexOf(b);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
  return a.localeCompare(b, undefined, { numeric: true });
};

// In the order they happen. Consecutive legs on the same side read as one stretch -- "L1–L4
// starboard", not four lines -- and a cast stop part-way through a stretch does not split it: the
// rod comes out of the holder for the stop and goes back on the same side.
function whereItFishes(uses) {
  const out = [];
  let lastLeg = null;
  for (const u of uses) {
    if (u.kind === 'stop') { out.push({ text: `cast at ${u.label}` }); continue; }
    if (lastLeg && lastLeg.side === u.side && u.n === lastLeg.lastN + 1) {
      lastLeg.to = u.leg; lastLeg.lastN = u.n;
      continue;
    }
    lastLeg = { from: u.leg, to: u.leg, side: u.side, at: u.at, lastN: u.n };
    out.push(lastLeg);
  }
  return out.map((s) => (s.text != null ? s.text
    : `${s.from === s.to ? s.from : `${s.from}–${s.to}`} ${s.side}${s.at ? ` (${s.at})` : ''}`));
}

/**
 * Every rod on the boat, the lure it starts the day with, and what happens to it afterwards.
 *
 * @param {object} p  the object collectPlan() exports (and a saved plan file is)
 * @returns {{rods: object[], changes: object[], swaps: object[]}}
 */
export function rodsAtLaunch(p) {
  const plan = (p && p.plan) || {};
  const timeline = (p && (p.timeline || p.unifiedTimeline)) || [];

  // The loadout on the plan block is the seated one -- every id, its rig, and `staged` for a rod
  // the plan left alone. A file saved before collectPlan carried it has only the model's own
  // loadout, which is still the only record of a rod rigged and never deployed; the rods that do
  // deploy are read off the timeline either way, so the fallback only ever names the others.
  const planRods = plan.loadout && Array.isArray(plan.loadout.rods) ? plan.loadout.rods : null;
  const modelRods = !planRods && p && p.model && p.model.response && p.model.response.loadout
    && Array.isArray(p.model.response.loadout.rods) ? p.model.response.loadout.rods : null;
  const loadout = new Map((planRods || modelRods || []).filter((r) => r && r.id).map((r) => [str(r.id), r]));
  const cast = new Map(((p && p.castRods) || []).filter((r) => r && r.rod).map((r) => [str(r.rod), r]));

  const first = new Map();    // rod id -> the first thing that happens to it: a leg row or a change
  const uses = new Map();     // rod id -> legs and stops, in timeline order
  const push = (id, v) => { if (!uses.has(id)) uses.set(id, []); uses.get(id).push(v); };
  const changes = [];
  const swaps = [];
  let pending = [];
  let lastPair = null;
  let n = 0;

  for (const e of timeline) {
    if (!e) continue;
    if (e.type === 'change') {
      const c = { id: str(e.id), rodId: str(e.rodId), from: str(e.from), to: str(e.to),
                  why: str(e.why), cost: str(e.costLabel || e.cost), mark: str(e.mark),
                  beforeLeg: null, at: null };
      changes.push(c);
      pending.push(c);
      if (c.rodId && !first.has(c.rodId)) first.set(c.rodId, { change: c });
      continue;
    }
    if (e.type === 'troll') {
      const rods = Array.isArray(e.rods) ? e.rods : [];
      if (!rods.length) continue;               // a transit: nothing in the water
      n += 1;
      const leg = str(e.key || e.legId);
      const at = str(e.estStartTime);
      for (const c of pending) { c.beforeLeg = leg; c.at = at; }
      pending = [];
      const pair = { leg, at, port: null, starboard: null };
      for (const r of rods) {
        const id = str(r && r.rod);
        if (!id) continue;
        if (!first.has(id)) first.set(id, { row: r });
        const side = sideOf(r.side);
        push(id, { kind: 'leg', leg, at, side, n });
        if (side === 'port' || side === 'starboard') pair[side] = { rod: id, lure: str(r.lure) };
      }
      const key = `${pair.port ? pair.port.rod : ''}|${pair.starboard ? pair.starboard.rod : ''}`;
      if (key !== lastPair) { swaps.push(pair); lastPair = key; }
      continue;
    }
    if (e.type === 'stop_and_cast') {
      const what = str(e.typeDetail || e.targetStructure).replace(/_/g, ' ');
      const deep = Number.isFinite(Number(e.targetDepth)) && e.targetDepth != null && e.targetDepth !== ''
        ? ` ${Math.round(Number(e.targetDepth))} ft` : '';
      const label = `${str(e.id)}${what ? ` ${what}` : ''}${deep}`.trim();
      for (const l of (e.recommendedLures || [])) {
        const id = rodIdIn(l);
        if (id) push(id, { kind: 'stop', stop: str(e.id), label });
      }
    }
  }

  // An export from before the timeline carried change events still has them on the plan block.
  if (!changes.length && Array.isArray(plan.changes)) {
    const trollLegs = (plan.legs || []).filter((l) => l && l.type === 'troll');
    for (const ch of plan.changes) {
      if (!ch) continue;
      const next = trollLegs.find((l) => Number(l.startM) >= Number(ch.atM));
      changes.push({ id: str(ch.id), rodId: str(ch.rodId), from: str(ch.from), to: str(ch.to),
                     why: str(ch.why), cost: ch.cost === 'fluoro' ? 'retie — 20 lb fluoro leader'
                       : ch.cost === 'snap' ? 'swivel snap' : str(ch.cost),
                     mark: '', beforeLeg: next ? str(next.id) : null,
                     at: next ? str(next.estStartTime) : null });
    }
  }

  const ids = new Set([...ROD_IDS, ...loadout.keys(), ...first.keys(), ...cast.keys(),
                       ...uses.keys()]);
  const rods = [...ids].sort(idOrder).map((id) => {
    const lo = loadout.get(id) || null;
    const f = first.get(id) || {};
    const row = f.row || null;
    const castRow = cast.get(id) || null;
    // THE LURE IT LEAVES THE RAMP WITH. When the first thing that happens to a rod is a change,
    // what is on it at launch is what that change takes OFF -- not what the leg after it shows.
    const lure = row ? str(row.lure)
      : (f.change && f.change.from) || str(lo && lo.lure) || str(castRow && castRow.lure);
    const color = row ? str(row.color) : str(lo && lo.color);
    const weight = row ? [
      row.arigWeight ? `Frame: ${str(row.arigWeight)}` : '',
      row.inlineWeight ? `Weight: ${str(row.inlineWeight)} inline` : '',
      row.jigWeight ? `Head: ${str(row.jigWeight)}` : '',
      row.trailerSize ? `Trailer: ${str(row.trailerSize)}` : '',
    ].filter(Boolean).join(' · ') : str(castRow && castRow.jigheadWeight);
    const rig = str(lo && lo.rig) || ROD_RIG[id] || '';
    const mine = uses.get(id) || [];
    const used = mine.length > 0 || changes.some((c) => c.rodId === id);
    let status;
    if (used) status = 'fishes';
    else if (!lure || (lo && lo.staged)) status = 'staged';
    else status = 'idle';
    return {
      id, rig, terminal: TERMINAL[rig] || rig, lure, color, weight,
      runs: row ? str(row.depth) : '',
      where: whereItFishes(mine),
      presentation: str(castRow && castRow.presentation),
      status,
    };
  });

  return { rods, changes, swaps };
}

/**
 * The report section. `esc` is the report's own escaper, passed in so this module has no DOM.
 */
export function rodsAtLaunchHtml(p, esc) {
  const { rods, changes, swaps } = rodsAtLaunch(p);
  if (!rods.length) return '';
  const byRig = (rig) => rods.filter((r) => r.rig === rig).map((r) => r.id);
  const fluoro = byRig('fluoro');
  const snap = byRig('snap');

  const where = (r) => {
    if (r.status === 'fishes') return r.where.length ? r.where.map(esc).join('<br>') : '—';
    if (r.status === 'staged') return '<i>Not in this plan — keeps whatever is already on it</i>';
    return '<i>Not used on any leg or stop — no need to tie it on today</i>';
  };
  const rodRows = rods.map((r) => `<tr${r.status === 'fishes' ? '' : ' style="color:#6b7785"'}>
      <td><b>${esc(r.id)}</b></td>
      <td>${esc(r.terminal || '—')}</td>
      <td>${r.lure ? `<b>${esc(r.lure)}</b>${r.color ? ` · ${esc(r.color)}` : ''}` : '—'}</td>
      <td>${esc(r.weight || '—')}</td>
      <td>${r.runs ? `${esc(r.runs)} ft` : '—'}</td>
      <td class="rp-small">${where(r)}${r.presentation ? `<br>${esc(r.presentation)}` : ''}</td>
    </tr>`).join('');

  const changeBlock = changes.length
    ? `<table><thead><tr style="background:#fffde7"><th>Before</th><th>Rod</th><th>Take off → Tie on</th><th>Change</th><th>Why</th></tr></thead><tbody>${
      changes.map((c) => `<tr>
      <td>${c.beforeLeg ? `<b>${esc(c.beforeLeg)}</b>${c.at ? ` · ${esc(c.at)}` : ''}` : '—'}${c.mark ? `<br><span class="rp-small">${esc(c.mark)} in</span>` : ''}</td>
      <td><b>${esc(c.rodId)}</b></td>
      <td>${esc(c.from || '—')} → <b>${esc(c.to || '—')}</b></td>
      <td class="rp-small">${esc(c.cost || '—')}</td>
      <td class="rp-small">${esc(c.why || '')}</td>
    </tr>`).join('')}</tbody></table>`
    : '<p><b>None.</b> Every rod keeps what it was rigged with at launch for the whole day.</p>';

  const pairCell = (x) => (x ? `<b>${esc(x.rod)}</b> ${esc(x.lure)}` : '—');
  const swapBlock = swaps.length
    ? `<h3>Rods In The Holders — Each Time The Pair Changes</h3>
    <p class="rp-small">No retying here — only which two rods are out. The rest wait in the rod holders behind the seat.</p>
    <table><thead><tr style="background:#eef4fa"><th>Leg</th><th>Port</th><th>Starboard</th></tr></thead><tbody>${
      swaps.map((s) => `<tr><td><b>${esc(s.leg)}</b>${s.at ? ` · ${esc(s.at)}` : ''}</td><td>${pairCell(s.port)}</td><td>${pairCell(s.starboard)}</td></tr>`).join('')}</tbody></table>`
    : '';

  const rigLine = fluoro.length || snap.length
    ? `${rods.length} rods: <b>${fluoro.length} on a 20 lb fluoro leader</b>${fluoro.length ? ` (${esc(fluoro.join(', '))})` : ''}, `
      + `<b>${snap.length} on swivel snaps</b>${snap.length ? ` (${esc(snap.join(', '))})` : ''}. `
    : '';

  return `
    <h2>🎣 Rods At Launch — What Every Rod Is Rigged With</h2>
    <p class="rp-small">${rigLine}Two are in the water at a time, one port and one starboard. Tie these on before you leave the ramp.</p>
    <table><thead><tr style="background:#eef4fa"><th>Rod</th><th>Tied to</th><th>Lure</th><th>Weight</th><th>Runs</th><th>Where it fishes</th></tr></thead><tbody>${rodRows}</tbody></table>
    <h3>Lure Changes</h3>
    ${changeBlock}
    ${swapBlock}`;
}
