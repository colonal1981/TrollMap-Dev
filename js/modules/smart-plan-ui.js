/**
 * smart-plan-ui.js — Plan UI rebuilt around Smart Plan's 4-route output
 *
 * Renders route cards with rod assignments directly into the Plan tab.
 * Self-injects a container before the spread table if one doesn't exist.
 *
 * One rule: A-rig or spoon -> straight braid to swivel snap
 *           Everything else -> fluoro leader
 *
 * Exported:
 *   renderSmartPlanUI({ routeRods, scoutReport, speedMph, phases, solunar })
 *   assignRouteRods(phaseRecs, tracks, speedMph, season, clarity, species)
 *   syncSpread(cards, routeRods)
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { LURE_PRESETS, LURE_DIVE_DEPTHS, autoCalculateLead } from './spread-builder.js';
import { getLureColor } from '../data/lure-knowledge.js';

// ── Reel assignment rule ──────────────────────────────────────────────────────
function reelForLure(lureName) {
  if (!lureName) return 'Spinning / 30lb 8-strand braid + 20lb fluoro leader';
  const l = lureName.toLowerCase();
  if (l.includes('a-rig') || l.includes('umbrella') ||
      l.includes('flutter spoon') || l.includes('kastmaster') ||
      l.includes('torpedo')) {
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
function buildCards(speedMph) {
  return [
    { key: 'Ph1 Outbound', label: 'Ph1 — Outbound', icon: '🌅', color: '#00e5ff', desc: 'Dawn — shallow structure, heading out' },
    { key: 'Ph1 Inbound',  label: 'Ph1 — Inbound',  icon: '↩️',  color: '#00bcd4', desc: 'Return pass on same depth' },
    { key: 'Ph2 Outbound', label: 'Ph2 — Outbound', icon: '☀️',  color: '#ffb300', desc: 'Mid-depth ledge run — heading out' },
    { key: 'Ph2 Inbound',  label: 'Ph2 — Inbound',  icon: '🏠',  color: '#ff9800', desc: 'Heading home — deeper channel' },
  ].map(c => ({ ...c, stats: getTrackStats(c.key, speedMph) }));
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
export function renderSmartPlanUI({ routeRods, scoutReport, speedMph, phases, solunar }) {
  // Self-inject container before spread table if needed
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

  const cards = buildCards(speedMph || 1.8);
  const totalTime = cards.reduce((s, c) => s + (c.stats.timeMin || 0), 0);
  const totalDist = cards.reduce((s, c) => s + parseFloat(c.stats.distMi || 0), 0);

  let html = `
  <!-- Trip summary -->
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px">
    ${[
      ['Routes', cards.length, ''],
      ['Distance', totalDist.toFixed(1), 'mi'],
      ['Trolling', `${Math.floor(totalTime/60)}h ${totalTime%60}m`, ''],
      ['Speed', speedMph || 1.8, 'mph'],
    ].map(([label, val, unit]) => `
    <div style="background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px;text-align:center">
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">${label}</div>
      <div style="font-size:20px;font-weight:700;color:var(--accent)">${val}<span style="font-size:12px;color:var(--muted)">${unit}</span></div>
    </div>`).join('')}
  </div>`;

  if (solunar) {
    html += `<div style="background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin-bottom:14px;font-size:11px;color:var(--muted)">🌙 ${esc(solunar)}</div>`;
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
    rod.lead  = String(autoCalculateLead({ ...rod, lure: picked }, speedMph || 1.8));
    renderSmartPlanUI({ routeRods, scoutReport, speedMph, phases, solunar });
    syncSpread(cards, routeRods);
  };
}

// ── Sync to state.SPREAD ──────────────────────────────────────────────────────
export function syncSpread(cards, routeRods) {
  const allCards = cards || buildCards(1.8);
  state.SPREAD = [];
  for (const card of allCards) {
    for (const rod of (routeRods?.[card.key] || [])) {
      if (!rod) continue;
      state.SPREAD.push({
        ...rod,
        reel: reelForLure(rod.lure),
        notes: `[${card.label}] ${rod.notes || ''}`.trim(),
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
  'flutter_spoon':           'Flutter Spoon 2oz',
  'jigging_spoon':           'Flutter Spoon 2oz',
  'Flutter Spoon':           'Flutter Spoon 2oz',
  'Bucktail':                'Bucktail Jig 1oz',
  'bucktail':                'Bucktail Jig 1oz',
  'bucktail_jig':            'Bucktail Jig 1oz',
  'deep_diving_crankbait':   'Deep Hit Stick – Crankbait',
  'medium_diving_crankbait': 'Rapala DT-14 – Crankbait (medium/deep, ~14ft)',
  'spinnerbait':             'Spinnerbait 1/2oz',
  'Spinnerbait':             'Spinnerbait 1/2oz',
  'lipless_crankbait':       'Lipless Crankbait 1/2oz',
  'chatterbait':             'ChatterBait 3/4oz',
  'paddle_tail':             'Swimbait 4.6" – Jighead',
  'swimbait_jighead':        'Swimbait 4.6" – Jighead',
  'topwater_walker':         'Zara Spook – Topwater',
  'Choppo 90':               'Choppo 90 – Topwater',
};

function resolveLureName(raw) {
  if (!raw) return null;
  if (LURE_MAP[raw]) return LURE_MAP[raw];
  if (LURE_PRESETS.includes(raw)) return raw;
  return null;
}

function fallbackLure(depth, exclude) {
  const opts = depth < 10
    ? ['Lipless Crankbait 1/2oz', 'Spinnerbait 1/2oz', 'Flicker Minnow 11 – Crankbait']
    : depth < 18
    ? ['A-Rig Light (~1.65oz) – 3.8" Swimbait', 'Rapala DT-10 – Crankbait (shallow/medium, ~10ft)', 'Flutter Spoon 2oz']
    : depth < 26
    ? ['A-Rig Medium (~2.65oz) – 4.6" Swimbait', 'Rapala DT-14 – Crankbait (medium/deep, ~14ft)', 'Flutter Spoon 2oz']
    : ['A-Rig Heavy (~3.5oz) – 5" Swimbait', 'Deep Hit Stick – Crankbait', 'Flutter Spoon 3oz'];
  return opts.find(l => l !== exclude) || opts[0];
}

function buildOneRod(targetDepth, rec, timeOfDay, clarityKey, speedMph, slotIdx, excludeLure) {
  // Try to pick a lure from species-intel recommendations that fits the depth
  const candidates = (rec?.lures || [])
    .map(l => resolveLureName(l))
    .filter(l => l && l !== excludeLure)
    .filter(l => {
      const dive = LURE_DIVE_DEPTHS?.[l];
      if (!dive) return true; // no depth data, include it
      return targetDepth >= dive.minDive - 3 && targetDepth <= dive.maxDive + 3;
    });

  let lureName = candidates[slotIdx] || candidates[0] || fallbackLure(targetDepth, excludeLure);

  // Dawn + shallow -> topwater on port rod
  if (slotIdx === 0 && timeOfDay === 'dawn' && targetDepth < 15) {
    const topwaterMap = {
      clear:   'Zara Spook – Topwater',
      stained: 'Whopper Plopper 110 – Topwater',
      muddy:   'Whopper Plopper 110 – Topwater',
    };
    lureName = topwaterMap[clarityKey] || 'Whopper Plopper 110 – Topwater';
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
