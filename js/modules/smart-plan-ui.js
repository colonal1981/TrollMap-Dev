/**
 * smart-plan-ui.js — Plan UI rebuilt around Smart Plan's 4-route output and hybrid timeline
 *
 * Renders route cards with rod assignments directly into the Plan tab.
 * Self-injects a container before the spread table if one doesn't exist.
 *
 * One rule: A-rig or spoon -> straight braid to swivel snap
 *           Everything else -> fluoro leader
 *
 * Updated 2026-07-25: Restructured to render sequential chronological hybrid timeline
 * containing trolling passes and casting stops with active kayak boat control suggestions.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { LURE_PRESETS, LURE_DIVE_DEPTHS, autoCalculateLead } from './spread-builder.js';
import { getLureColor } from '../data/lure-knowledge.js';

// ── Reel assignment rule ──────────────────────────────────────────────────────
export function reelForLure(lureName) {
  if (!lureName) return 'Spinning / 30lb 8-strand braid + 20lb fluoro leader';
  const l = lureName.toLowerCase();
  if (l.includes('a-rig') || l.includes('umbrella') ||
      l.includes('flutter spoon') || l.includes('kastmaster') ||
      l.includes('torpedo') || l.includes('diamond')) {
    return 'Spinning / 30lb 8-strand braid directly tied to swivel snap';
  }
  return 'Spinning / 30lb 8-strand braid + 20lb fluoro leader';
}

// ── Track stats from committed tracks ────────────────────────────────────────
function getTrackStats(trackName, speedMph) {
  const track = (state.DATA?.tracks || []).find(t => t.name === trackName);
  if (!track?.pts?.length) return { distMi: null, timeMin: null };
  let totalFt = 0;
  for (let i = 1; i < track.pts.length; i++) {
    const a = track.pts[i-1], b = track.pts[i];
    const aLat = Array.isArray(a) ? a[0] : a.lat;
    const aLon = Array.isArray(a) ? a[1] : a.lon;
    const bLat = Array.isArray(b) ? b[0] : b.lat;
    const bLon = Array.isArray(b) ? b[1] : b.lon;
    const dLat = (bLat - aLat) * 364000;
    const dLon = (bLon - aLon) * 364000 * Math.cos(aLat * Math.PI / 180);
    totalFt += Math.sqrt(dLat*dLat + dLon*dLon);
  }
  const distMi = totalFt / 5280;
  const timeMin = Math.round(distMi / Math.max(0.5, speedMph || 1.8) * 60);
  return { distMi: distMi.toFixed(1), timeMin };
}

// ── Route card definitions ────────────────────────────────────────────────────
function buildCards(fallbackSpeedMph, routeSpeeds = {}) {
  const fallbackSpeed = Number(fallbackSpeedMph) || 1.8;
  return [
    { key: 'Ph1 Outbound', label: 'Ph1 — Outbound', icon: '🌅', color: '#00e5ff', desc: 'Dawn — shallow structure, heading out' },
    { key: 'Ph1 Inbound',  label: 'Ph1 — Inbound',  icon: '↩️',  color: '#00bcd4', desc: 'Return pass on same depth' },
    { key: 'Ph2 Outbound', label: 'Ph2 — Outbound', icon: '☀️',  color: '#ffb300', desc: 'Mid-depth ledge run — heading out' },
    { key: 'Ph2 Inbound',  label: 'Ph2 — Inbound',  icon: '🏠',  color: '#ff9800', desc: 'Heading home — deeper channel' },
  ].map((card) => {
    const routeSpeed = Number(routeSpeeds?.[card.key]);
    const speedMph = Number.isFinite(routeSpeed) && routeSpeed > 0 ? routeSpeed : fallbackSpeed;
    return { ...card, speedMph, stats: getTrackStats(card.key, speedMph) };
  });
}

// ── Rod slot HTML ─────────────────────────────────────────────────────────────
function rodSlotHtml(rod, cardIdx, slotIdx) {
  const label = slotIdx === 0 ? '🔵 Port' : '🔴 Stbd';
  if (!rod) {
    return `<div style="border:1px dashed var(--line);border-radius:7px;padding:8px 10px;opacity:0.4;font-size:11px;color:var(--muted)">${label} — no lure assigned</div>`;
  }
  const reel = reelForLure(rod.lure);
  const isSwivel = reel.includes('swivel snap');
  const reelBadge = isSwivel
    ? `<span style="color:#ffb300;font-size:10px">⚡ Direct braid → swivel snap</span>`
    : `<span style="color:#76ff03;font-size:10px">🔗 Braid + fluoro leader</span>`;

  let arigLine = '';
  if (rod.lure?.toLowerCase().includes('a-rig') || rod.lure?.toLowerCase().includes('umbrella')) {
    const parts = [
      rod.arigWeight  ? `Frame: ${rod.arigWeight}`    : '',
      rod.jigWeight   ? `Heads: ${rod.jigWeight}`     : '',
      rod.trailerSize ? `Trailer: ${rod.trailerSize}` : '',
    ].filter(Boolean).join(' · ');
    if (parts) arigLine = `<div style="font-size:10px;color:var(--muted);margin-top:2px">${esc(parts)}</div>`;
  }

  return `
  <div style="border:1px solid var(--line);border-radius:7px;padding:8px 10px;display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:start">
    <div style="font-size:11px;font-weight:700;color:var(--muted);white-space:nowrap;padding-top:2px">${label}</div>
    <div>
      <div style="font-size:12px;font-weight:600;color:var(--text)">${esc(rod.lure || '—')}</div>
      <div style="font-size:11px;color:var(--muted)">${esc(rod.color || '—')}</div>
      ${arigLine}
      <div style="margin-top:3px">${reelBadge}</div>
    </div>
    <div style="text-align:right;font-size:11px;white-space:nowrap">
      <div style="color:var(--accent);font-weight:700">${esc(String(rod.lead || '—'))}<span style="color:var(--muted);font-weight:400">ft</span></div>
      <div style="color:var(--muted)">${esc(String(rod.depth || '—'))}ft</div>
      <button onclick="window._spEditRod(${cardIdx},${slotIdx})"
        style="margin-top:4px;font-size:10px;padding:2px 7px;border:1px solid var(--line);background:var(--panel);color:var(--muted);border-radius:4px;cursor:pointer">
        ✏️
      </button>
    </div>
  </div>`;
}

// ── Main render ───────────────────────────────────────────────────────────────
export function renderSmartPlanUI({ routeRods, scoutReport, speedMph, routeSpeeds = {}, phases, solunar, stopCandidates, timeline }) {
  let container = document.getElementById('smartPlanUIContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'smartPlanUIContainer';
    container.style.marginBottom = '14px';
    const anchor = document.getElementById('spreadTable')?.closest('.card')
      || document.getElementById('spreadBody')?.closest('.card');
    if (anchor) anchor.parentNode.insertBefore(container, anchor);
    else document.getElementById('plan-builder')?.appendChild(container);
  }
  if (!container) return;

  const cards = buildCards(speedMph || 1.8, routeSpeeds);
  const totalTime = cards.reduce((s, c) => s + (c.stats.timeMin || 0), 0);
  const totalDist = cards.reduce((s, c) => s + parseFloat(c.stats.distMi || 0), 0);
  const passSpeeds = [...new Set(cards.map((card) => card.speedMph))];
  const speedSummary = passSpeeds.join(' / ');

  let html = `
  <!-- Trip summary -->
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px">
    ${[
      ['Routes', cards.length, ''],
      ['Distance', totalDist.toFixed(1), 'mi'],
      ['Trolling', `${Math.floor(totalTime/60)}h ${totalTime%60}m`, ''],
      ['Pass speeds', speedSummary, 'mph'],
    ].map(([label, val, unit]) => `
    <div style="background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px;text-align:center">
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">${label}</div>
      <div style="font-size:20px;font-weight:700;color:var(--accent)">${val}<span style="font-size:12px;color:var(--muted)">${unit}</span></div>
    </div>`).join('')}
  </div>`;

  if (solunar) {
    html += `<div style="background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin-bottom:14px;font-size:11px;color:var(--muted)">🌙 ${esc(solunar)}</div>`;
  }

  // ── Render Chronological Hybrid Timeline (If Present) ──────────────────────
  if (timeline && Array.isArray(timeline) && timeline.length > 0) {
    html += `
    <div style="background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:14px">
      <div style="font-size:11px;font-weight:700;color:var(--accent2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;display:flex;align-items:center;gap:6px">
        🏆 Chronological Trip Timeline (Troll & Cast)
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;position:relative;padding-left:10px;border-left:2px solid var(--line)">`;

    timeline.forEach((step, idx) => {
      if (step.type === 'troll') {
        html += `
        <div style="position:relative;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 14px">
          <!-- Dot marker -->
          <div style="position:absolute;left:-16px;top:16px;width:10px;height:10px;border-radius:50%;background:#00e5ff;box-shadow:0 0 0 3px var(--panel)"></div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <span style="font-size:12px;font-weight:700;color:#00e5ff">🌅 STEP ${step.step || idx+1}: TROLLING (${esc(step.phaseName || 'Pass')})</span>
            <span style="font-size:11px;font-weight:600;color:var(--muted);background:rgba(0,229,255,0.15);padding:2px 6px;border-radius:4px">${step.speed || speedMph} mph</span>
          </div>
          <div style="font-size:12px;color:var(--text);margin-bottom:4px">Targeting depth: <b>${step.depthMin}–${step.depthMax}ft</b></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
            <div style="font-size:11px;background:rgba(255,255,255,0.03);border:1px solid var(--line);border-radius:6px;padding:4px 8px">
              <span style="color:var(--muted)">🔵 Port:</span> <b style="color:var(--text)">${esc(step.port)}</b>
              <div style="color:var(--muted);font-size:10px;margin-top:2px">Lead: ${step.portLeadFt || 50}ft</div>
            </div>
            <div style="font-size:11px;background:rgba(255,255,255,0.03);border:1px solid var(--line);border-radius:6px;padding:4px 8px">
              <span style="color:var(--muted)">🔴 Stbd:</span> <b style="color:var(--text)">${esc(step.starboard)}</b>
              <div style="color:var(--muted);font-size:10px;margin-top:2px">Lead: ${step.starboardLeadFt || 60}ft</div>
            </div>
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:6px;font-style:italic">Why: ${esc(step.why || '')}</div>
        </div>`;
      } else if (step.type === 'stop_and_cast') {
        html += `
        <div style="position:relative;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 14px">
          <!-- Dot marker -->
          <div style="position:absolute;left:-16px;top:16px;width:10px;height:10px;border-radius:50%;background:#ffb300;box-shadow:0 0 0 3px var(--panel)"></div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <span style="font-size:12px;font-weight:700;color:#ffb300">🎯 STEP ${step.step || idx+1}: STOP & CAST (${esc(step.name || 'Structure Stop')})</span>
            <span style="font-size:10px;font-weight:600;color:#ffb300;background:rgba(255,179,0,0.15);padding:2px 6px;border-radius:4px;text-transform:uppercase">No Spot-Lock</span>
          </div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Target: <b>${esc(step.targetStructure || '')}</b> | Depth: <b>${step.targetDepth || 6}ft</b></div>
          <div style="font-size:11px;color:var(--text);margin-bottom:8px">Presentation: <i>${esc(step.presentation || '')}</i></div>
          
          <div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:4px">✨ Recommended Casting Baits:</div>
          <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:8px">
            ${(step.recommendedLures || []).map(lure => `
            <div style="display:flex;justify-content:space-between;font-size:11px;background:rgba(255,179,0,0.05);border:1px solid rgba(255,179,0,0.15);border-radius:4px;padding:4px 8px">
              <span style="color:var(--text)">🎣 ${esc(lure.name)}</span>
              <span style="color:#76ff03;font-weight:700">${esc(lure.confidence || '90%')} Match</span>
            </div>`).join('')}
          </div>

          <div style="font-size:11px;background:rgba(0,0,0,0.15);border:1px solid var(--line);border-radius:6px;padding:8px;color:var(--text);line-height:1.4">
            <b style="color:#ffb300">🛶 Active Positioning Plan:</b> ${esc(step.tacticalNote || '')}
          </div>
        </div>`;
      }
    });

    html += `
      </div>
    </div>`;
  }

  html += `<div style="display:flex;flex-direction:column;gap:12px">`;

  cards.forEach((card, cardIdx) => {
    const rods = routeRods?.[card.key] || [];
    const hasStats = card.stats.distMi !== null;
    html += `
    <div style="background:var(--panel2);border:1px solid var(--line);border-radius:10px;overflow:hidden">
      <div style="background:${card.color}18;border-bottom:1px solid ${card.color}44;padding:10px 14px;display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:18px">${card.icon}</span>
          <div>
            <div style="font-weight:700;color:${card.color};font-size:13px">${esc(card.label)}</div>
            <div style="font-size:11px;color:var(--muted)">${esc(card.desc)}</div>
          </div>
        </div>
        <div style="text-align:right;font-size:11px;color:var(--muted)">
          <span style="color:${card.color};font-weight:700">${card.speedMph} mph</span><br>
          ${hasStats
            ? `<span style="color:${card.color};font-weight:600">${card.stats.distMi}mi</span> · ${card.stats.timeMin}min`
            : 'no track yet'}
        </div>
      </div>
      <div style="padding:10px 14px;display:flex;flex-direction:column;gap:8px">
        ${rodSlotHtml(rods[0] || null, cardIdx, 0)}
        ${rodSlotHtml(rods[1] || null, cardIdx, 1)}
      </div>
    </div>`;
  });

  html += `</div>`;

  if (scoutReport) {
    html += `
    <div style="margin-top:14px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:14px">
      <div style="font-size:11px;font-weight:700;color:var(--accent2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">🧠 Scout Report</div>
      <pre style="white-space:pre-wrap;font-family:inherit;font-size:12px;color:var(--text);margin:0;line-height:1.6">${esc(scoutReport)}</pre>
    </div>`;
  }

  // ── Casting Stops ────────────────────────────────────────────────────────────
  const groundedStops = (stopCandidates || []).filter(s => s.lat && s.lon && s.routeContext);
  const ungroundedStops = (stopCandidates || []).filter(s => !s.lat || !s.lon);

  if (!stopCandidates) {
    // skip
  } else if (!groundedStops.length && !ungroundedStops.length) {
    html += `
    <div style="margin-top:14px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:12px 14px;font-size:11px;color:var(--muted)">
      🎯 <b style="color:var(--text)">Casting Stops</b> — No mapped structure found within 500ft of your route. Load QuickDraw pins or enable the Structure layer to add OSM bridges, piers, and docks.
    </div>`;
  } else if (groundedStops.length || ungroundedStops.length) {
    html += `
    <div style="margin-top:14px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:14px">
      <div style="font-size:11px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">🎯 Casting Stops Near Your Route</div>`;

    if (groundedStops.length) {
      html += `<div style="display:flex;flex-direction:column;gap:8px">`;
      groundedStops.forEach((stop, i) => {
        const ctx = stop.routeContext;
        const trackColor = ctx.trackName?.includes('Ph2') ? '#ffb300' : '#00e5ff';
        const sideNote = ctx.distFromRouteFt < 100 ? 'on route' : `${ctx.distFromRouteFt}ft off route`;
        html += `
        <div style="border:1px solid var(--line);border-radius:7px;padding:8px 10px;display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center">
          <div style="font-size:20px;line-height:1">${
            stop.type === 'DOCK_CLUSTER' || stop.type === 'dock_field' ? '⚓' :
            stop.type === 'RIPRAP' || stop.type === 'riprap' ? '🪨' :
            stop.type === 'BRIDGE' ? '🌉' :
            stop.type === 'FLOODED_TIMBER' || stop.type === 'timber' ? '🪵' :
            stop.type === 'fish_attractor' ? '🎣' :
            stop.type === 'community_spot' ? '📍' :
            stop.type === 'hump' ? '⛰️' :
            stop.type === 'ledge' ? '📉' : '🎯'
          }</div>
          <div>
            <div style="font-size:12px;font-weight:600;color:var(--text)">${esc(stop.name || stop.structureType || stop.type)}</div>
            <div style="font-size:11px;color:var(--muted)">${esc(stop.reason || stop.description || '')}</div>
          </div>
          <div style="text-align:right;font-size:11px;white-space:nowrap">
            <div style="color:${trackColor};font-weight:700">${esc(ctx.trackName)}</div>
            <div style="color:var(--muted)">~${ctx.etaMin}min in</div>
            <div style="color:var(--muted);font-size:10px">${sideNote}</div>
          </div>
        </div>`;
      });
      html += `</div>`;
    }

    if (ungroundedStops.length) {
      html += `<div style="margin-top:${groundedStops.length ? '10px' : '0'};padding-top:${groundedStops.length ? '10px' : '0'};${groundedStops.length ? 'border-top:1px solid var(--line);' : ''}">
        <div style="font-size:10px;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">Lake-Wide Structure Context</div>
        <div style="display:flex;flex-direction:column;gap:5px">`;
      ungroundedStops.forEach(stop => {
        html += `<div style="font-size:11px;color:var(--muted);padding:4px 0">
          <span style="color:var(--text);font-weight:600">${esc(stop.name)}</span> — ${esc(stop.reason || '')}
        </div>`;
      });
      html += `</div></div>`;
    }

    html += `</div>`;
  }

  container.innerHTML = html;

  // Wire edit buttons
  window._spEditRod = (cardIdx, slotIdx) => {
    const card = cards[cardIdx];
    const rod = (routeRods?.[card.key] || [])[slotIdx];
    if (!rod) return;
    const lureList = LURE_PRESETS.filter(l => !l.startsWith('—')).slice(0, 20).join('\n');
    const picked = prompt(`Edit ${card.label} ${slotIdx === 0 ? 'Port' : 'Stbd'}\nCurrent: ${rod.lure}\n\n${lureList}`, rod.lure);
    if (!picked || picked === rod.lure) return;
    rod.lure  = picked;
    rod.reel  = reelForLure(picked);
    rod.color = getLureColor(picked, 'clear');
    rod.lead  = String(autoCalculateLead({ ...rod, lure: picked }, card.speedMph));
    renderSmartPlanUI({ routeRods, scoutReport, speedMph, routeSpeeds, phases, solunar, stopCandidates, timeline });
    syncSpread(cards, routeRods, routeSpeeds);
  };
}

// ── Sync to state.SPREAD ──────────────────────────────────────────────────────
export function syncSpread(cards, routeRods, routeSpeeds = {}) {
  const allCards = cards || buildCards(1.8, routeSpeeds);
  state.SPREAD = [];
  for (const card of allCards) {
    for (const rod of (routeRods?.[card.key] || [])) {
      if (!rod) continue;
      state.SPREAD.push({
        ...rod,
        reel: reelForLure(rod.lure),
        speedMph: card.speedMph,
        notes: `[${card.label} @ ${card.speedMph} mph] ${rod.notes || ''}`.trim(),
      });
    }
  }
}

// ── Lure resolver ─────────────────────────────────────────────────────────────
const LURE_MAP = {
  'A-Rig Light':             'A-Rig Light (~1.65oz) – 3.8" Swimbait',
  'A-Rig Medium':            'A-Rig Medium (~2.65oz) – 4.6" Swimbait',
  'A-Rig Heavy':             'A-Rig Heavy (~3.5oz) – 5" Swimbait',
  'umbrella_rig':            'A-Rig Medium (~2.65oz) – 4.6" Swimbait',
  'umbrella_rig_light':      'A-Rig Light (~1.65oz) – 3.8" Swimbait',
  'umbrella_rig_medium':     'A-Rig Medium (~2.65oz) – 4.6" Swimbait',
  'umbrella_rig_heavy':      'A-Rig Heavy (~3.5oz) – 5" Swimbait',
  'flutter_spoon':           'Nichols Lake Fork Flutter Spoon 3/4oz',
  'jigging_spoon':           'Dr.Fish Diamond Jig / Jigging Spoon 1oz',
  'Flutter Spoon':           'Nichols Lake Fork Flutter Spoon 3/4oz',
  'Bucktail':                '1oz Bucktail Jig',
  'bucktail':                '1oz Bucktail Jig',
  'bucktail_jig':            '1oz Bucktail Jig',
  'deep_diving_crankbait':   'DD2 Crankbait (16-20ft)',
  'medium_diving_crankbait': 'MR Crankbait (6-12ft)',
  'spinnerbait':             '1/2oz Spinnerbait',
  'Spinnerbait':             '1/2oz Spinnerbait',
  'lipless_crankbait':       '3" Lipless Crankbait',
  'chatterbait':             '1/2oz Chatterbait',
  'paddle_tail':             'Swimbait 4.6" – Jighead',
  'swimbait_jighead':        'Swimbait 4.6" – Jighead',
  'topwater_walker':         'Walking Bait / Spook',
  'Choppo 90':               'Prop Bait / Choppo',
};

function resolveLureName(raw) {
  if (!raw) return null;
  if (LURE_MAP[raw]) return LURE_MAP[raw];
  if (LURE_PRESETS.includes(raw)) return raw;
  return null;
}

function fallbackLure(depth, exclude, slotIdx = 0) {
  const opts = depth < 10
    ? [['3" Lipless Crankbait', '1/2oz Spinnerbait'],
       ['MR Crankbait (6-12ft)', '3" Lipless Crankbait']]
    : depth < 18
    ? [['A-Rig Light (~1.65oz) – 3.8" Swimbait', 'A-Rig Medium (~2.65oz) – 4.6" Swimbait'],
       ['MR Crankbait (6-12ft)', 'Nichols Lake Fork Flutter Spoon 3/4oz']]
    : depth < 26
    ? [['A-Rig Medium (~2.65oz) – 4.6" Swimbait', 'A-Rig Heavy (~3.5oz) – 5" Swimbait'],
       ['DD2 Crankbait (16-20ft)', 'Nichols Lake Fork Flutter Spoon 3/4oz']]
    : [['A-Rig Heavy (~3.5oz) – 5" Swimbait', '1oz Bucktail Jig'],
       ['DD4 Crankbait (25ft+)', 'Dr.Fish Diamond Jig / Jigging Spoon 1oz']];
  const slotOpts = opts[Math.min(slotIdx, opts.length - 1)];
  return slotOpts.find(l => l !== exclude) || slotOpts[0];
}

function buildOneRod(targetDepth, rec, timeOfDay, clarityKey, speedMph, slotIdx, excludeLure) {
  const candidates = (rec?.lures || [])
    .map(l => resolveLureName(l))
    .filter(l => l && l !== excludeLure)
    .filter(l => {
      const dive = LURE_DIVE_DEPTHS?.[l];
      if (!dive) return true;
      return targetDepth >= dive.minDive - 3 && targetDepth <= dive.maxDive + 3;
    });

  let lureName = candidates[slotIdx] || candidates[0] || fallbackLure(targetDepth, excludeLure, slotIdx);

  if (slotIdx === 0 && timeOfDay === 'dawn' && targetDepth < 22) {
    const topwaterMap = {
      clear:   'Walking Bait / Spook',
      stained: 'Whopper Plopper',
      muddy:   'Whopper Plopper',
    };
    lureName = topwaterMap[clarityKey] || 'Whopper Plopper';
  }

  const color = getLureColor(lureName, clarityKey);
  const reel  = reelForLure(lureName);
  const rod = {
    side:     slotIdx === 0 ? 'Port' : 'Starboard',
    position: 'Mid',
    rod:      "7' M Mod-Fast Spinning (Ugly Stik Lite Pro)",
    reel, lureName, color,
    lure:     lureName,
    depth:    String(Math.round(targetDepth)),
    lead:     '0',
    notes:    '',
    trailerSize: '', arigWeight: '', jigWeight: '',
  };

  if (lureName?.toLowerCase().includes('a-rig')) {
    const isLight  = lureName.includes('Light')  || lureName.includes('1.65');
    const isMedium = lureName.includes('Medium') || lureName.includes('2.65');
    rod.arigWeight  = isLight ? '~1.65oz (5-wire light)' : isMedium ? '~2.65oz (5-wire medium)' : '~3.5oz (5-wire heavy)';
    rod.trailerSize = isLight ? '3.8" swimbait' : isMedium ? '4.6" swimbait' : '5" swimbait';
    rod.jigWeight   = isLight ? '1/8oz × 5' : isMedium ? '3/16oz × 5' : '1/4oz × 5';
  }

  rod.lead = String(autoCalculateLead(rod, speedMph || 1.8));
  return rod;
}

// ── Assign rods to routes ─────────────────────────────────────────────────────
export function assignRouteRods(phaseRecs, tracks, speedMph, season, clarity, species) {
  const clarityKey = (clarity || '').toLowerCase().includes('mud') ? 'muddy'
    : (clarity || '').toLowerCase().includes('stain') ? 'stained' : 'clear';

  const routeDefs = [
    { key: 'Ph1 Outbound', phaseIdx: 0, timeOfDay: 'dawn' },
    { key: 'Ph1 Inbound',  phaseIdx: 0, timeOfDay: 'morning' },
    { key: 'Ph2 Outbound', phaseIdx: 1, timeOfDay: 'morning' },
    { key: 'Ph2 Inbound',  phaseIdx: 1, timeOfDay: 'afternoon' },
  ];

  const routeRods = {};
  for (const def of routeDefs) {
    const rec = phaseRecs[def.phaseIdx];
    if (!rec) { routeRods[def.key] = []; continue; }
    const dMin = rec.depthMin, dMax = rec.depthMax;
    const mid  = (dMin + dMax) / 2;
    const d1   = dMin + (mid - dMin) * 0.4;
    const d2   = mid  + (dMax - mid) * 0.4;
    const rod1 = buildOneRod(d1, rec, def.timeOfDay, clarityKey, speedMph, 0, null);
    const rod2 = buildOneRod(d2, rec, def.timeOfDay, clarityKey, speedMph, 1, rod1.lure);
    routeRods[def.key] = [rod1, rod2];
  }
  return routeRods;
}

console.log('[smart-plan-ui] module ready');
