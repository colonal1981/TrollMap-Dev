/**
 * smart-plan-ui.js — Unified Trip Timeline (Trolling + Stop-and-Cast interleaved)
 *
 * One timeline, top to bottom chronological. No separate phase cards block,
 * no separate casting stops block. All entries rendered as cards in one component.
 *
 * Updated 2026-07-25: Unified refactor — single chronological timeline per brief:
 *  🌅 TROLL — Phase 1 Outbound (Dawn Shallow)
 *  🎯 STOP & CAST — Main Lake Point Ledge
 *  ↩️ TROLL — Phase 1 Inbound
 *  🎯 STOP & CAST — Channel Swing
 *  ☀️ TROLL — Phase 2 Outbound
 *  🏠 TROLL — Phase 2 Inbound (Heading Home)
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { LURE_PRESETS, autoCalculateLead } from './spread-builder.js';
import { getLureColor, canReachDepth } from '../data/lure-knowledge.js';
import { lureByName } from '../data/tackle-inventory.js';
import { FISHING_STYLE } from '../data/fishing-style-profile.js';

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

// ── Route card definitions (still used for building troll entries) ────────────
/**
 * The cards a plan is made of.
 *
 * The four below are v1's shape and v1's story — dawn shallow, out, back, deeper, home. That was
 * never a fact about fishing, it was the only route the old generator could build. A v2 plan is N
 * legs in whatever order the day is best fished, so it passes its own `cardDefs` and none of this
 * applies to it.
 *
 * Ryan, 2026-08-08, when I treated this list as a contract to satisfy rather than a layout to
 * borrow: "use the original as a guide not a rule... just the general layout idea stays not the
 * out and back or that the morning needs to be more shallow all of that can go."
 *
 * What genuinely stays is everything below the header — the card, the depth and spread tiles, the
 * two rod slots, the italic why. That is entry-driven already and does not care how many there
 * are or what they are called.
 */
function buildCards(fallbackSpeedMph, routeSpeeds = {}, cardDefs = null) {
  const fallbackSpeed = Number(fallbackSpeedMph) || 1.8;
  return (cardDefs || [
    { key: 'Ph1 Outbound', label: 'Phase 1 Outbound', shortLabel: 'Ph1 Out', icon: '🌅', color: '#00e5ff', desc: 'Dawn Shallow — heading out', longDesc: 'Dawn Shallow' },
    { key: 'Ph1 Inbound',  label: 'Phase 1 Inbound',  shortLabel: 'Ph1 In',  icon: '↩️',  color: '#00bcd4', desc: 'Return pass on same depth', longDesc: 'Return' },
    { key: 'Ph2 Outbound', label: 'Phase 2 Outbound', shortLabel: 'Ph2 Out', icon: '☀️',  color: '#ffb300', desc: 'Mid-depth ledge run — heading out', longDesc: 'Mid-Depth Ledge' },
    { key: 'Ph2 Inbound',  label: 'Phase 2 Inbound',  shortLabel: 'Ph2 In',  icon: '🏠',  color: '#ff9800', desc: 'Heading Home — deeper channel', longDesc: 'Heading Home' },
  ]).map((card) => {
    const routeSpeed = Number(routeSpeeds?.[card.key]);
    const speedMph = Number.isFinite(routeSpeed) && routeSpeed > 0 ? routeSpeed : fallbackSpeed;
    // A caller that already knows its distance and time says so. getTrackStats() reads
    // state.DATA.tracks by name, which only ever holds v1's four phase tracks.
    return { ...card, speedMph, stats: card.stats || getTrackStats(card.key, speedMph) };
  });
}

// ── Rod slot HTML (used inside trolling timeline cards) ──────────────────────
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

// ── Build canonical unified timeline (chronological, single source of truth) ──
export function buildUnifiedTimeline({ routeRods, timeline, stopCandidates, routeSpeeds = {}, speedMph = 1.8 }) {
  const phaseOrder = ['Ph1 Outbound', 'Ph1 Inbound', 'Ph2 Outbound', 'Ph2 Inbound'];
  const cards = buildCards(speedMph, routeSpeeds);
  const cardMap = Object.fromEntries(cards.map(c => [c.key, c]));

  function stripAnnotation(raw) {
    if (!raw) return raw;
    return String(raw).replace(/\s*\[.*$/, '').trim();
  }

  // Extract coordinates embedded in a name string like "Hazard at [34.3758, -80.7366]"
  function extractCoordsFromName(name) {
    if (!name) return null;
    const m = String(name).match(/\[\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*\]/);
    if (!m) return null;
    const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  // Match a stop name against candidates to get coordinates
  function resolveStopCoords(step) {
    if (step.lat && step.lon) return { lat: step.lat, lon: step.lon };
    // Try extracting from name string
    const fromName = extractCoordsFromName(step.name);
    if (fromName) return fromName;
    // Try fuzzy name match against candidates
    if (!Array.isArray(stopCandidates)) return { lat: null, lon: null };
    const stepName = (step.name || '').toLowerCase().trim();
    const match = stopCandidates.find(c => {
      if (!c.lat || !c.lon) return false;
      const candName = (c.name || '').toLowerCase().trim();
      return candName === stepName || stepName.includes(candName) || candName.includes(stepName);
    });
    if (match) return { lat: match.lat, lon: match.lon };
    return { lat: null, lon: null };
  }

  function makeTrollEntry(key, overrides = {}) {
    const card = cardMap[key];
    const rods = routeRods?.[key] || [];
    return {
      type: 'troll',
      key,
      label: overrides.label || card?.label || key,
      shortLabel: card?.shortLabel || key,
      icon: overrides.icon || card?.icon || '🎣',
      color: overrides.color || card?.color || '#00e5ff',
      desc: overrides.desc || card?.desc || '',
      longDesc: card?.longDesc || '',
      speedMph: Number(overrides.speedMph ?? overrides.speed ?? card?.speedMph ?? speedMph) || 1.8,
      stats: card?.stats || { distMi: null, timeMin: null },
      depthMin: overrides.depthMin ?? null,
      depthMax: overrides.depthMax ?? null,
      port: stripAnnotation(overrides.port || rods[0]?.lure || ''),
      starboard: stripAnnotation(overrides.starboard || rods[1]?.lure || ''),
      portColor: overrides.portColor || rods[0]?.color || '',
      starboardColor: overrides.starboardColor || rods[1]?.color || '',
      portLeadFt: overrides.portLeadFt ?? rods[0]?.lead ?? '',
      starboardLeadFt: overrides.starboardLeadFt ?? rods[1]?.lead ?? '',
      why: overrides.why || '',
      rods,
      phaseName: overrides.phaseName || card?.label || key,
      original: overrides.original || null,
    };
  }

  function makeStopFromGroq(step, idx) {
    const coords = resolveStopCoords(step);
    // Clean name — strip embedded coordinates from name string
    const cleanName = (step.name || `Structure Stop ${idx+1}`).replace(/\s*at\s*\[.*?\]\s*/i, '').trim();
    return {
      type: 'stop_and_cast',
      subType: 'groq',
      id: `groq-${idx}-${cleanName.replace(/\W+/g,'_')}`,
      name: cleanName,
      targetStructure: step.targetStructure || step.structureType || '',
      targetDepth: step.targetDepth ?? step.depth ?? 6,
      presentation: step.presentation || '',
      recommendedLures: Array.isArray(step.recommendedLures) ? step.recommendedLures : [],
      tacticalNote: step.tacticalNote || step.tactical || '',
      positioning: step.tacticalNote || '',
      lat: coords.lat,
      lon: coords.lon,
      routeContext: step.routeContext || null,
      original: step,
    };
  }

  function makeStopFromCandidate(cand, idx) {
    return {
      type: 'stop_and_cast',
      subType: 'candidate',
      id: `cand-${idx}-${(cand.name||cand.type||'stop').replace(/\W+/g,'_')}`,
      name: cand.name || cand.structureType || cand.type || `Structure ${idx+1}`,
      targetStructure: cand.structureType || cand.type || cand.targetStructure || '',
      targetDepth: cand.targetDepth ?? cand.depth ?? 6,
      presentation: cand.presentation || cand.reason || cand.description || '',
      recommendedLures: Array.isArray(cand.recommendedLures) ? cand.recommendedLures : [],
      tacticalNote: cand.tacticalNote || cand.reason || cand.tactical || '',
      positioning: cand.tacticalNote || cand.reason || '',
      lat: cand.lat ?? null,
      lon: cand.lon ?? null,
      routeContext: cand.routeContext || null,
      score: cand.score,
      reason: cand.reason,
      typeDetail: cand.type,
      original: cand,
    };
  }

  let unified = [];

  if (timeline && Array.isArray(timeline) && timeline.length > 0) {
    // Use Groq timeline order as authoritative for interleaving
    let trollCursor = 0;
    for (let i = 0; i < timeline.length; i++) {
      const step = timeline[i];
      if (!step) continue;
      if (step.type === 'troll') {
        const assignedKey = phaseOrder[trollCursor] || phaseOrder[phaseOrder.length-1];
        unified.push(makeTrollEntry(assignedKey, {
          depthMin: step.depthMin,
          depthMax: step.depthMax,
          speedMph: step.speed,
          port: step.port,
          starboard: step.starboard,
          portColor: step.portColor,
          starboardColor: step.starboardColor,
          portLeadFt: step.portLeadFt,
          starboardLeadFt: step.starboardLeadFt,
          why: step.why,
          label: step.phaseName ? `${assignedKey}${step.phaseName ? ` (${step.phaseName})` : ''}` : assignedKey,
          phaseName: step.phaseName || assignedKey,
          icon: cardMap[assignedKey]?.icon,
          color: cardMap[assignedKey]?.color,
          desc: cardMap[assignedKey]?.desc,
          original: step,
        }));
        trollCursor++;
      } else if (step.type === 'stop_and_cast') {
        unified.push(makeStopFromGroq(step, i));
      } else if (step.type === 'cast' || step.type === 'stop') {
        // tolerate alternate naming
        unified.push(makeStopFromGroq({ ...step, type: 'stop_and_cast' }, i));
      }
    }
    // Fill any missing troll phases that weren't in Groq timeline (e.g., fallback had only 2)
    while (trollCursor < phaseOrder.length) {
      const key = phaseOrder[trollCursor];
      if (!unified.some(e => e.type === 'troll' && e.key === key)) {
        unified.push(makeTrollEntry(key));
      }
      trollCursor++;
    }

    // Merge extra geographic stopCandidates not already represented
    if (Array.isArray(stopCandidates) && stopCandidates.length) {
      const existingNames = new Set(unified.filter(e => e.type === 'stop_and_cast').map(e => (e.name||'').toLowerCase().trim()));
      const extra = [];
      for (let i = 0; i < stopCandidates.length; i++) {
        const cand = stopCandidates[i];
        if (!cand) continue;
        // Only bring in grounded stops (need lat/lon) to avoid duplicating lake-wide ungrounded context that Groq already summarized
        if (!cand.lat || !cand.lon) continue;
        const n = (cand.name||'').toLowerCase().trim();
        if (n && existingNames.has(n)) continue;
        // dedup by proximity 250ft
        const isDup = unified.some(e => e.type === 'stop_and_cast' && e.lat && e.lon &&
          Math.abs(e.lat - cand.lat) < 0.0007 && Math.abs(e.lon - cand.lon) < 0.0007);
        if (isDup) continue;
        extra.push(makeStopFromCandidate(cand, i));
      }

      const orderMap = { 'Ph1 Outbound':0, 'Ph1 Inbound':1, 'Ph2 Outbound':2, 'Ph2 Inbound':3 };
      extra.sort((a,b)=>{
        const ao = a.routeContext ? (orderMap[a.routeContext.trackName] ?? 99) : 99;
        const bo = b.routeContext ? (orderMap[b.routeContext.trackName] ?? 99) : 99;
        if (ao !== bo) return ao - bo;
        // SORTED ON DISTANCE. PLAN_SCHEMA_V2: "THE PLAN IS INDEXED BY DISTANCE, NOT TIME...
        // The clock starts drifting the moment he hooks a fish, and it never catches up."
        // This read `progressPct || etaMin`, and plan-to-timeline stopped emitting both when the
        // spine was fixed -- so every entry scored 0, the comparator was a no-op, and the order
        // happened to be right only because planCues() had already sorted it. Dead keys that
        // silently work are worse than dead keys that break.
        return (a.atM ?? a.routeContext?.atM ?? 0) - (b.atM ?? b.routeContext?.atM ?? 0);
      });

      for (const stop of extra) {
        const tn = stop.routeContext?.trackName;
        if (tn && orderMap[tn] !== undefined) {
          // Insert after corresponding troll, before next troll
          const tIdx = unified.findIndex(e => e.type === 'troll' && e.key === tn);
          if (tIdx >= 0) {
            let insertAt = tIdx + 1;
            // Skip over existing stops that belong to same track and have earlier progress
            while (insertAt < unified.length && unified[insertAt].type === 'stop_and_cast') {
              const cur = unified[insertAt];
              if (cur.routeContext && stop.routeContext && cur.routeContext.trackName === tn) {
                if ((cur.atM ?? 0) <= (stop.atM ?? 0)) {
                  insertAt++;
                  continue;
                }
              }
              break;
            }
            unified.splice(insertAt, 0, stop);
            continue;
          }
        }
        // Generic between-phase logic: place between Ph1 In and Ph2 Out if we have it
        const ph1InIdx = unified.findIndex(e => e.type === 'troll' && e.key === 'Ph1 Inbound');
        if (ph1InIdx >= 0) {
          unified.splice(ph1InIdx + 1, 0, stop);
        } else {
          unified.push(stop);
        }
      }
    }

  } else {
    // No Groq timeline — build from routeRods + stopCandidates chronologically
    const grouped = { 'Ph1 Outbound':[], 'Ph1 Inbound':[], 'Ph2 Outbound':[], 'Ph2 Inbound':[], '_between':[] };
    (stopCandidates||[]).forEach((c,i)=>{
      const e = makeStopFromCandidate(c,i);
      const tn = c.routeContext?.trackName;
      if (tn && grouped[tn]) grouped[tn].push(e);
      else grouped._between.push(e);
    });
    // Sort each by progress
    Object.values(grouped).forEach(arr=> arr.sort((a,b)=>(a.atM ?? 0)-(b.atM ?? 0)));

    // Desired order per brief: Ph1 Out, stops, Ph1 In, stops (Channel Swing between phases), Ph2 Out, Ph2 In
    unified.push(makeTrollEntry('Ph1 Outbound'));
    unified.push(...grouped['Ph1 Outbound']);
    // Per rule: stops between outbound and inbound of phase they belong to
    unified.push(...grouped['Ph1 Inbound']);
    // Distribute _between stops: split between Ph1 and Ph2
    const half = Math.ceil(grouped._between.length/2);
    unified.push(...grouped._between.slice(0, half));

    unified.push(makeTrollEntry('Ph1 Inbound'));

    unified.push(...grouped._between.slice(half));

    unified.push(makeTrollEntry('Ph2 Outbound'));
    unified.push(...grouped['Ph2 Outbound']);

    unified.push(makeTrollEntry('Ph2 Inbound'));
    unified.push(...grouped['Ph2 Inbound']);
    // If any leftover unassigned, already distributed
  }

  // Final sanitization: assign step numbers, ensure trolling entries have rods
  unified.forEach((e, idx) => {
    e.step = idx + 1;
    if (e.type === 'troll') {
      const key = e.key;
      if ((!e.rods || !e.rods.length) && routeRods?.[key]) e.rods = routeRods[key];
    }
  });

  // Deduplicate consecutive duplicate troll keys (defensive)
  const deduped = [];
  for (let i=0;i<unified.length;i++) {
    const cur = unified[i];
    const prev = deduped[deduped.length-1];
    if (cur.type==='troll' && prev && prev.type==='troll' && prev.key===cur.key) continue;
    deduped.push(cur);
  }

  return deduped;
}

// ── Unified Timeline Renderer (single component, no separate blocks) ─────────
/**
 * @param {object[]} [o.cardDefs] one card per leg, in order. v2 supplies these; v1 omits them and
 *                               gets its four phases.
 * @param {object[]} [o.unified]  an already-ordered timeline. Supplied, it is used AS IS —
 *                               `buildUnifiedTimeline()` weaves stops into phases by guessing
 *                               from `progressPct`, and v2's assembler already placed every stop
 *                               at its own `atM` along its own leg. Weaving it twice would move
 *                               stops the plan had put in the right place.
 */
export function renderSmartPlanUI({ routeRods, scoutReport, speedMph, routeSpeeds = {}, phases, solunar, stopCandidates, timeline, cardDefs = null, unified = null }) {
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

  const cards = buildCards(speedMph || 1.8, routeSpeeds, cardDefs);
  // `estTimeMin` is v2's; `timeMin` is what v1's getTrackStats() still returns. The `est`
  // prefix travels with the value -- an estimate that loses its name downstream is an
  // estimate nothing can argue with.
  const totalTime = cards.reduce((s, c) => s + (c.stats.estTimeMin ?? c.stats.timeMin ?? 0), 0);
  const totalDist = cards.reduce((s, c) => s + parseFloat(c.stats.distMi || 0), 0);
  const passSpeeds = [...new Set(cards.map((card) => card.speedMph))];
  const speedSummary = passSpeeds.join(' / ');

  // Build canonical unified timeline once — unless the caller already has one in order.
  const unifiedTimeline = unified
    || buildUnifiedTimeline({ routeRods, timeline, stopCandidates, routeSpeeds, speedMph });
  // Persist for collectPlan and GPX interleaving
  window._smartPlanTimeline = unifiedTimeline;
  window._smartPlanRouteRods = routeRods;
  window._smartPlanStopCandidates = stopCandidates;
  window._smartPlanRouteSpeeds = routeSpeeds;

  // For GPX interleaving: also ensure casting waypoints exist and are sorted into state.DATA
  try {
    if (typeof window !== 'undefined' && window._smartPlanTimeline && state?.DATA?.waypoints) {
      // Remove previous auto-generated casting waypoints to avoid duplication
      state.DATA.waypoints = state.DATA.waypoints.filter(w => !w.castingStop);
      // Create Casting waypoints from unified stop entries that have lat/lon
      const castWpts = unifiedTimeline
        .filter(e => e.type === 'stop_and_cast' && e.lat && e.lon)
        .map(e => ({
          name: `CAST: ${e.name}`.slice(0, 32),
          lat: e.lat,
          lon: e.lon,
          sym: 'Fishing Area',
          castingStop: true,
          routeContext: e.routeContext || null,
          depth: e.targetDepth,
          structureType: e.targetStructure,
          tacticalNote: e.tacticalNote,
        }));
      if (castWpts.length) {
        // Build route-ordered waypoint list: mirror unified timeline order
        const ordered = [];
        const baseWpts = state.DATA.waypoints.slice();
        const baseByPhase = {
          1: baseWpts.filter(w => w.phase === 1 || String(w.name||'').startsWith('Ph1-')),
          2: baseWpts.filter(w => w.phase === 2 || String(w.name||'').startsWith('Ph2-')),
          other: baseWpts.filter(w => !(w.phase === 1 || w.phase === 2 || String(w.name||'').startsWith('Ph1-') || String(w.name||'').startsWith('Ph2-'))),
        };
        let ph1Added = false, ph2Added = false;
        // Ensure Launch stays first
        const launch = baseWpts.find(w => (w.role === 'launch_ramp') || String(w.name||'').toLowerCase().includes('launch'));
        const otherNonPhase = baseByPhase.other.filter(w => !launch || w !== launch);
        if (launch) ordered.push(launch);
        // Walk unified timeline
        for (const entry of unifiedTimeline) {
          if (entry.type === 'troll') {
            const phaseNum = entry.key?.includes('Ph1') ? 1 : entry.key?.includes('Ph2') ? 2 : null;
            if (phaseNum === 1 && !ph1Added) {
              ordered.push(...baseByPhase[1]);
              ph1Added = true;
            } else if (phaseNum === 2 && !ph2Added) {
              ordered.push(...baseByPhase[2]);
              ph2Added = true;
            }
            // inbound phases don't add duplicate contour waypoints
          } else if (entry.type === 'stop_and_cast') {
            const match = castWpts.find(cw => cw.name === `CAST: ${entry.name}`.slice(0,32) || (cw.lat===entry.lat && cw.lon===entry.lon));
            if (match && !ordered.includes(match)) ordered.push(match);
          }
        }
        // Append any remaining base waypoints not yet added (fallback)
        for (const w of baseWpts) {
          if (!ordered.includes(w) && !w.castingStop) ordered.push(w);
        }
        // Append any cast waypoints missed
        for (const cw of castWpts) {
          if (!ordered.includes(cw)) ordered.push(cw);
        }
        // Place other non-phase after launch before phases if not yet
        // Already handled, but ensure ordering makes sense: launch, ph1, casts between, ph2, casts etc is already done via walk
        // Replace
        state.DATA.waypoints = ordered;
        if (typeof window.renderAll === 'function') {
          // Don't trigger full render here to avoid flicker; but update stats if visible
        }
      }
    }
  } catch (e) {
    console.warn('[smart-plan-ui] GPX interleave waypoint sort failed', e.message);
  }

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

  // ── Single Unified Chronological Timeline ──────────────────────────────────
  html += `
    <div style="background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:14px">
      <div style="font-size:11px;font-weight:700;color:var(--accent2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;display:flex;align-items:center;gap:6px">
        🧭 Unified Trip Timeline — Troll & Cast Interleaved (Chronological)
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;position:relative;padding-left:10px;border-left:2px solid var(--line)">`;

  unifiedTimeline.forEach((entry) => {
    if (entry.type === 'troll') {
      const cardDef = cards.find(c => c.key === entry.key) || {};
      const rods = entry.rods || routeRods?.[entry.key] || [];
      // THE RANGE, AND THE MIDDLE OF IT. `depthMin`/`depthMax` are the shallowest and deepest
      // water the leg crosses and `depthFt` is the median — see plan-to-timeline.js for why the
      // leg stopped being described by one contour. Flat water still reads as one number.
      const depthLabel = entry.depthMin != null && entry.depthMax != null
        ? (entry.depthMin === entry.depthMax ? `${entry.depthMin}ft` : `${entry.depthMin}–${entry.depthMax}ft`)
        : (entry.depthMin ? `${entry.depthMin}ft` : '—');
      const medianLabel = entry.depthFt != null && entry.depthMin != null
        && entry.depthMax != null && entry.depthMin !== entry.depthMax
        ? `median ${entry.depthFt}ft` : '';
      // THE CARD CALLED THE WATER "TARGET DEPTH" AND NEVER SHOWED THE FISH.
      //
      // `depthMin/depthMax` are the charted line the leg follows -- plan-to-timeline.js:282 sets
      // them from `leg.depthFt` on purpose, and says why. The label over them said "Target
      // Depth", so the card announced "Target Depth 6ft" and then listed a bait running 20-25 ft
      // underneath it, with the 15-27 ft the fish are actually holding at appearing nowhere.
      // Ryan, 2026-08-30: "if the water is only 20 feet how is the target 20-25ft... this thing
      // still has no understanding of suspended fish."
      //
      // Both numbers, each under its own name. `speciesBandFt` was already on the entry.
      const bandLabel = Array.isArray(entry.speciesBandFt) && entry.speciesBandFt.length === 2
        ? `fish ${entry.speciesBandFt[0]}–${entry.speciesBandFt[1]} ft`
          + (entry.holding && entry.holding !== 'unknown' ? ` · ${entry.holding}` : '')
        : '';
      const speedLabel = entry.speedMph ? `${entry.speedMph} mph` : `${speedMph} mph`;
      const estMin = entry.stats?.estTimeMin ?? entry.stats?.timeMin;
      const statsBadge = entry.stats?.distMi != null ? `${entry.stats.distMi}mi · est ${estMin}min` : '';
      // Where this leg starts on the day's spine. Distance is the spine; the clock starts
      // drifting the moment he hooks a fish and never catches up.
      const markBadge = entry.atM != null ? `${(entry.atM / 1609.34).toFixed(2)} mi in` : '';

      // A TRANSIT IS NOT A TROLL AND HAS NO SPREAD.
      //
      // Ryan, off the water 2026-08-09: "if this is the leg to get to the start of the first
      // troll run it doesn't need this information." The deadhead card was rendering the full
      // trolling body — Target Depth, Spread / Leads, and two "no lure assigned" rod rows — all
      // four of them dashes, because there is nothing in the water. Under a heading that read
      // "TROLL — Run", which is a contradiction on its face.
      //
      // A transit card is distance, speed, battery and time. That is the whole of it.
      if (entry.legType === 'transit') {
        const note = entry.unrouted
          ? `<div style="font-size:11px;color:var(--bad,#ef5350);font-weight:600;border-top:1px dashed var(--line);padding-top:6px;margin-top:6px">⚠ ${esc(entry.longDesc || entry.why || '')}</div>`
          : (entry.why ? `<div style="font-size:11px;color:var(--muted);font-style:italic;border-top:1px dashed var(--line);padding-top:6px;margin-top:6px">💡 ${esc(entry.why)}</div>` : '');
        html += `
        <div style="position:relative;background:var(--panel);border:1px dashed ${entry.color}66;border-radius:10px;padding:10px 14px;overflow:hidden">
          <div style="position:absolute;left:-16px;top:16px;width:12px;height:12px;border-radius:50%;background:${entry.color};box-shadow:0 0 0 3px var(--panel2)"></div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:18px">${entry.icon}</span>
              <div>
                <div style="font-size:12px;font-weight:800;color:${entry.color};letter-spacing:.02em">${entry.role === 'return' ? 'RETURN' : 'TRANSIT'} — ${esc(entry.label)}</div>
                <div style="font-size:11px;color:var(--muted)">${esc(entry.desc || '')}</div>
              </div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">
              <span style="font-size:11px;font-weight:700;color:${entry.color};background:${entry.color}18;border:1px solid ${entry.color}44;padding:2px 7px;border-radius:999px">${esc(speedLabel)}</span>
              ${statsBadge ? `<span style="font-size:10px;color:var(--muted)">${esc(statsBadge)}</span>` : ''}
              ${markBadge ? `<span style="font-size:10px;color:var(--muted)">📏 ${esc(markBadge)}</span>` : ''}
            </div>
          </div>
          ${note}
        </div>`;
        return;
      }

      html += `
        <div style="position:relative;background:var(--panel);border:1px solid ${entry.color}44;border-radius:10px;padding:12px 14px;overflow:hidden">
          <div style="position:absolute;left:-16px;top:18px;width:12px;height:12px;border-radius:50%;background:${entry.color};box-shadow:0 0 0 3px var(--panel2),0 0 8px ${entry.color}66"></div>
          <!-- Header -->
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:18px">${entry.icon}</span>
              <div>
                <div style="font-size:12px;font-weight:800;color:${entry.color};letter-spacing:.02em">TROLL — ${esc(entry.label)}</div>
                <div style="font-size:11px;color:var(--muted)">${esc(entry.desc || entry.longDesc || entry.phaseName || '')}</div>
              </div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">
              <span style="font-size:11px;font-weight:700;color:${entry.color};background:${entry.color}18;border:1px solid ${entry.color}44;padding:2px 7px;border-radius:999px">${esc(speedLabel)}</span>
              ${statsBadge ? `<span style="font-size:10px;color:var(--muted)">${esc(statsBadge)}</span>` : ''}
              ${markBadge ? `<span style="font-size:10px;color:var(--muted)">📏 ${esc(markBadge)}</span>` : ''}
            </div>
          </div>
          <!-- Body meta -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
            <div style="font-size:11px;background:rgba(255,255,255,0.03);border:1px solid var(--line);border-radius:6px;padding:6px 8px">
              <div style="color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.05em">Water on this leg</div>
              <div style="font-weight:700;color:var(--text);font-size:12px">${esc(depthLabel)}${medianLabel ? `<span style="font-weight:500;color:var(--muted);font-size:10px"> · ${esc(medianLabel)}</span>` : ''}</div>
              ${bandLabel ? `<div style="color:var(--accent);font-size:10px;margin-top:2px">${esc(bandLabel)}</div>` : ''}
            </div>
            <div style="font-size:11px;background:rgba(255,255,255,0.03);border:1px solid var(--line);border-radius:6px;padding:6px 8px">
              <div style="color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.05em">Spread / Leads</div>
              <div style="font-weight:600;color:var(--muted);font-size:11px">
                Port ${entry.portLeadFt || rods[0]?.lead || '—'}ft · Stbd ${entry.starboardLeadFt || rods[1]?.lead || '—'}ft
              </div>
            </div>
          </div>
          <!-- Rods -->
          <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:8px">
            ${rodSlotHtml(rods[0] || null, phaseOrderIndex(entry.key, cards), 0)}
            ${rodSlotHtml(rods[1] || null, phaseOrderIndex(entry.key, cards), 1)}
          </div>
          ${(entry.warnings || []).length ? `<div style="font-size:11px;color:var(--warn);border-top:1px dashed var(--line);padding-top:6px">
            ${entry.warnings.map((w) => `<div style="margin:2px 0">⚠ ${esc(w)}</div>`).join('')}
          </div>` : ''}
          ${entry.why ? `<div style="font-size:11px;color:var(--muted);font-style:italic;border-top:1px dashed var(--line);padding-top:6px">💡 ${esc(entry.why)}</div>` : ''}
        </div>`;
    } else if (entry.type === 'stop_and_cast') {
      const lureChips = (entry.recommendedLures || []).map(lure => {
        const n = lure.name || lure.lure || lure;
        const conf = lure.confidence || '';
        return `<div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;background:rgba(255,179,0,0.06);border:1px solid rgba(255,179,0,0.18);border-radius:6px;padding:5px 8px">
          <span style="color:var(--text)">🎣 ${esc(String(n))}</span>
          ${conf ? `<span style="color:#76ff03;font-weight:700;font-size:11px">${esc(String(conf))} Match</span>` : ''}
        </div>`;
      }).join('');
      const hasCoords = entry.lat != null && entry.lon != null;
      const ctx = entry.routeContext;
      // A STOP IS A PAUSE INSIDE A LEG, NOT A STEP BESIDE ONE. It is indented under the leg it
      // sits on and keeps the assembler's own S<leg>.<n> name -- renumbering stops into the leg
      // sequence is what made "Step 3" a cast stop and "Step 4" the rest of the leg it is on.
      const nest = entry.parentLegId ? 'margin-left:22px;' : '';
      const parentCard = entry.parentLegId ? cards.find(c => c.key === entry.parentLegId) : null;
      const stopId = entry.id ? String(entry.id) : '';
      const mark = ctx && ctx.mark ? ctx.mark : (entry.atM != null ? `${(entry.atM / 1609.34).toFixed(2)} mi` : '');
      const stopLine = [stopId ? `${stopId}${parentCard ? ` on ${parentCard.shortLabel}` : ''}` : '',
                        mark ? `${mark} in` : '',
                        entry.targetStructure || entry.typeDetail || 'Structure'].filter(Boolean).join(' · ');
      const geoBadge = hasCoords
        ? `<span style="font-size:10px;color:#ffb300;background:rgba(255,179,0,0.12);border:1px solid rgba(255,179,0,0.25);padding:2px 6px;border-radius:999px">📍 ${Number(entry.lat).toFixed(4)}, ${Number(entry.lon).toFixed(4)}</span>`
        : `<span style="font-size:10px;color:var(--muted);background:rgba(255,255,255,0.04);border:1px solid var(--line);padding:2px 6px;border-radius:999px">No GPS — visual target</span>`;
      const ctxLine = ctx ? `<span style="font-size:10px;color:#00e5ff;background:rgba(0,229,255,0.12);padding:2px 6px;border-radius:999px;border:1px solid rgba(0,229,255,0.2)">${esc(ctx.trackName)}${ctx.mark ? ` · ${esc(ctx.mark)} in` : ''} · ${ctx.distFromRouteFt}ft off</span>` : '';
      html += `
        <div style="position:relative;${nest}background:linear-gradient(135deg,rgba(255,179,0,0.06),rgba(255,179,0,0.01));border:1px solid rgba(255,179,0,0.28);border-radius:10px;padding:12px 14px;overflow:hidden">
          <div style="position:absolute;left:-16px;top:18px;width:12px;height:12px;border-radius:50%;background:#ffb300;box-shadow:0 0 0 3px var(--panel2),0 0 8px rgba(255,179,0,0.5)"></div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:18px">🎯</span>
              <div>
                <div style="font-size:12px;font-weight:800;color:#ffb300;letter-spacing:.02em">STOP & CAST — ${esc(entry.name)}</div>
                <div style="font-size:11px;color:var(--muted)">${esc(stopLine)}</div>
              </div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
              <span style="font-size:10px;font-weight:700;color:#ffb300;background:rgba(255,179,0,0.14);padding:3px 7px;border-radius:999px;border:1px solid rgba(255,179,0,0.25);text-transform:uppercase">No Spot-Lock</span>
              ${hasCoords ? `<span style="font-size:10px;color:#00e5ff;background:rgba(0,229,255,0.12);padding:3px 7px;border-radius:999px;border:1px solid rgba(0,229,255,0.2)">📏 ${esc(mark ? `${mark} in` : 'On route')}</span>` : ''}
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
            <div style="font-size:11px;background:rgba(0,0,0,0.16);border:1px solid var(--line);border-radius:6px;padding:6px 8px">
              <div style="color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.05em">Target / Depth</div>
              <div style="font-weight:600;color:var(--text);font-size:12px">${esc(entry.targetStructure || 'Structure')} · <b>${esc(String(entry.targetDepth||'—'))}ft</b></div>
            </div>
            <div style="font-size:11px;background:rgba(0,0,0,0.16);border:1px solid var(--line);border-radius:6px;padding:6px 8px">
              <div style="color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.05em">Presentation</div>
              <div style="font-weight:400;color:var(--text);font-size:11px;line-height:1.35"><i>${esc(entry.presentation || '—')}</i></div>
            </div>
          </div>

          ${lureChips ? `
          <div style="margin-bottom:8px">
            <div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:4px">✨ Casting Bait Recommendations</div>
            <div style="display:flex;flex-direction:column;gap:4px">${lureChips}</div>
          </div>` : ''}

          <div style="font-size:11px;background:rgba(0,0,0,0.22);border:1px solid var(--line);border-radius:7px;padding:8px 10px;color:var(--text);line-height:1.45;margin-bottom:8px">
            <b style="color:#ffb300">🛶 Positioning Note:</b> ${esc(entry.tacticalNote || entry.positioning || 'Pedal-hover or tie-off to hold position.')}
          </div>

          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${geoBadge}
            ${ctxLine}
            ${entry.reason ? `<span style="font-size:10px;color:var(--muted);background:rgba(255,255,255,0.03);border:1px solid var(--line);padding:2px 6px;border-radius:999px">${esc(entry.reason).slice(0,120)}</span>` : ''}
          </div>
        </div>`;
    } else if (entry.type === 'change') {
      // A LURE CHANGE IS AN EVENT WITH A COST. These were built correctly by the assembler and
      // then dropped at the timeline boundary, so a day with three swaps shipped as a day with
      // none. A snap is seconds; a fluoro retie is a knot with cold wet hands in a moving kayak,
      // which is why the cost is on the card and not just in the object.
      const mark = entry.mark || (entry.atM != null ? `${(entry.atM / 1609.34).toFixed(2)} mi` : '');
      html += `
        <div style="position:relative;background:rgba(255,213,79,0.05);border:1px dashed rgba(255,213,79,0.4);border-radius:10px;padding:9px 12px">
          <div style="position:absolute;left:-15px;top:14px;width:10px;height:10px;border-radius:50%;background:${entry.color || '#ffd54f'};box-shadow:0 0 0 3px var(--panel2)"></div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
            <div style="font-size:12px;font-weight:700;color:#ffd54f">🔁 SWAP — ${esc(entry.rodId || '')}: ${esc(entry.from || '—')} → ${esc(entry.to || '')}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              ${mark ? `<span style="font-size:10px;color:var(--muted)">📏 ${esc(mark)} in</span>` : ''}
              <span style="font-size:10px;color:#ffd54f;background:rgba(255,213,79,0.12);border:1px solid rgba(255,213,79,0.25);padding:2px 6px;border-radius:999px">${esc(entry.costLabel || entry.cost || '')}</span>
            </div>
          </div>
          ${entry.why ? `<div style="font-size:11px;color:var(--muted);font-style:italic;margin-top:4px">💡 ${esc(entry.why)}</div>` : ''}
        </div>`;
    }
  });

  html += `
      </div>
    </div>`;

  if (scoutReport) {
    html += `
    <div style="margin-top:14px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:14px">
      <div style="font-size:11px;font-weight:700;color:var(--accent2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">🧠 Scout Report</div>
      <pre style="white-space:pre-wrap;font-family:inherit;font-size:12px;color:var(--text);margin:0;line-height:1.6">${esc(scoutReport)}</pre>
    </div>`;
  }

  container.innerHTML = html;

  // Wire edit buttons for unified timeline troll cards
  window._spEditRod = (cardIdx, slotIdx) => {
    const key = ['Ph1 Outbound','Ph1 Inbound','Ph2 Outbound','Ph2 Inbound'][cardIdx];
    const rod = (routeRods?.[key] || [])[slotIdx];
    if (!rod) return;
    const card = cards[cardIdx];
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

// Which card a rod-edit click belongs to. Was a lookup in the hardcoded four, which meant any key
// outside them silently returned 0 and the pencil edited the FIRST leg's rod instead of the one
// under your finger. Indexes the cards actually on screen now, so it holds for a plan of any
// length; -1 rather than 0 when there is no match, and the caller disables the control.
function phaseOrderIndex(key, cards) {
  const idx = (cards || []).findIndex((c) => c.key === key);
  if (idx >= 0) return idx;
  return ['Ph1 Outbound', 'Ph1 Inbound', 'Ph2 Outbound', 'Ph2 Inbound'].indexOf(key);
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
      // Was: a lookup in spread-builder's LURE_DIVE_DEPTHS, keyed by display
      // name. Now asks the lure whether it can actually fish this depth --
      // a rated bait is filtered by its bill, a sinking bait by whether the
      // lead it needs fits inside FISHING_STYLE.rigging.maxLeadFt.
      const entry = lureByName(l);
      if (!entry) return true;
      return canReachDepth(entry, targetDepth, speedMph,
                           { maxLeadFt: FISHING_STYLE.rigging.maxLeadFt }).ok;
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

console.log('[smart-plan-ui] module ready — unified timeline');
