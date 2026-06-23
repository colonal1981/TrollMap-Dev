/**
 * Lake Intelligence + Clarity Forecast — pulls fisherman-focused
 * briefings and zone-based clarity predictions from the worker.
 * Writes results into the Plan tab textareas and the callout boxes.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';

/* Lake Intel: species, forage, habitat, hazards, seasonal patterns */
export async function syncLakeIntelData() {
  const lakeSel = document.getElementById('planLake');
  const statusEl = document.getElementById('lakeIntelStatus');
  const btn = document.getElementById('syncLakeIntelBtn');
  const out = document.getElementById('planLakeIntel');
  const summary = document.getElementById('lakeIntelSummary');
  const lakeVal = lakeSel?.value || '';
  const label = isPlanRiverValue(lakeVal) ? (getPlanRiverDef(lakeVal)?.label || lakeVal) : lakeVal;
  const worker = (typeof CF_WORKER_URL !== 'undefined' ? CF_WORKER_URL : (window.CF_WORKER_URL || 'https://trollmap-worker.colonal1981.workers.dev'));
  function say(msg, bad){ if(statusEl){ statusEl.textContent=msg; statusEl.style.color=bad?'var(--bad)':'var(--accent2)'; } }
  if(!label){ say('Select waterbody first', true); return null; }
  if(isPlanRiverValue(lakeVal)){
    say('Lake intel is lake-focused', true);
    if(out) out.value = `River selected: ${label}
Use the river fields above for live dam schedule, streamflow, surge ETA, and kayak Go/No-Go. Lake Intelligence is currently focused on lakes/reservoirs.`;
    return null;
  }
  try{
    say('Building intel…', false);
    if(btn){ btn.disabled=true; btn.textContent='⏳ Building…'; }
    const res = await fetch(`${worker}/lake-intel?lake=${encodeURIComponent(label)}`);
    if(!res.ok) throw new Error(`Worker HTTP ${res.status}`);
    const d = await res.json();
    const p = d.profile || {};
    const lines=[];
    lines.push(`${d.lake || label} — Lake Intelligence Briefing`);
    if(d.confidence && String(d.confidence).includes('generic')) lines.push('VERIFY: No curated lake profile is available yet; this is a research checklist, not confirmed lake intelligence.');
    lines.push(`Primary sport fish: ${(p.primarySportFish||[]).join(', ') || 'Unknown / verify locally'}`);
    lines.push(`Known forage: ${(p.forage||[]).join(', ') || 'Unknown'}`);
    if(p.stocking) lines.push(`Stocking / management: ${p.stocking}`);
    if(p.spottedBass) lines.push(`Spotted bass / invasive pressure: ${p.spottedBass}`);
    if(p.habitat) lines.push(`Habitat / cover: ${p.habitat}`);
    if(p.bottom) lines.push(`Bottom composition: ${p.bottom}`);
    if(p.hazards) lines.push(`Navigation hazards: ${p.hazards}`);
    if(p.seasonalPattern) lines.push(`Seasonal pattern: ${p.seasonalPattern}`);
    if(p.tacticalNotes?.length){ lines.push('Tactical notes:'); p.tacticalNotes.forEach(x=>lines.push(`• ${x}`)); }
    if(d.sourceRegistry){
      lines.push('Source Trust Stack:');
      const sr=d.sourceRegistry;
      if(sr.summary) lines.push(`• ${sr.summary.trustModel}`);
      if(sr.official?.length) lines.push(`• OFFICIAL sources: ${sr.official.map(x=>x.label).join('; ')}`);
      if(sr.habitat?.length) lines.push(`• OFFICIAL GIS / habitat sources: ${sr.habitat.map(x=>x.label).join('; ')}`);
      if(sr.reports?.length) lines.push(`• VERIFY fishing-report sources: ${sr.reports.map(x=>x.label).join('; ')}`);
      if(sr.model?.length) lines.push(`• VERIFY model/aggregate sources: ${sr.model.map(x=>x.label).join('; ')}`);
    }
    if(d.lakeMonster){
      lines.push('LakeMonster supplemental context (VERIFY — third-party/model source, not official):');
      const lm=[];
      if(d.lakeMonster.waterTemp_F) lm.push(`surface temp estimate ${d.lakeMonster.waterTemp_F}°F`);
      if(d.lakeMonster.biteRating) lm.push(`bite rating ${d.lakeMonster.biteRating}`);
      if(d.lakeMonster.wind) lm.push(`wind ${d.lakeMonster.wind}`);
      if(d.lakeMonster.pressure) lm.push(`pressure ${d.lakeMonster.pressure}`);
      if(lm.length) lines.push(`• ${lm.join(' · ')}`);
      lines.push('• Note: LakeMonster species/elevation lists are intentionally NOT used as facts here; they can be generic or wrong for this lake.');
      if(d.lakeMonster.context) lines.push(`• ${d.lakeMonster.context}`);
    }
    if(d.latestReport?.summary){
      lines.push('Latest scraped fishing-report intel (VERIFY — third-party report, may be stale or promotional):');
      lines.push(d.latestReport.summary);
    }
    if(d.sources?.length){ lines.push('Sources / verify links:'); d.sources.forEach(src=>lines.push(`• ${src.label}: ${src.url}`)); }
    if(out) out.value = lines.join('\n');
    if(summary){
      summary.style.display='block';
      summary.innerHTML = `<b style="color:var(--accent)">🧠 ${esc(d.lake||label)}</b><br><span>${esc((p.primarySportFish||[]).join(', ')||'Profile generated')}</span>${d.confidence&&String(d.confidence).includes('generic')?`<br><span style="color:var(--warn);font-weight:700">⚠ VERIFY: generic/unconfirmed profile</span>`:''}${d.latestReport?.source?`<br><span class="muted">Latest scraped report source — verify before relying: ${esc(d.latestReport.source)}</span>`:''}`;
    }
    say('✓ Intel ready', false);
    window.LAST_LAKE_INTEL = d;
    return d;
  } catch(err){
    console.warn('Lake intel failed', err);
    say('Intel error', true);
    if(out) out.value = `Lake Intelligence fetch failed for ${label}: ${err.message}
Manual checklist: species, forage, stocking, invasive/spotted bass, bottom composition, cover, hazards, recent fishing reports.`;
    return null;
  } finally {
    if(btn){ btn.disabled=false; btn.textContent='⚡ Build Lake Intel'; }
  }
}

/* Clarity Forecast: zone-based clarity + lure recommendations */
export async function syncClarityIntelData() {
  const lakeSel = document.getElementById('planLake');
  const statusEl = document.getElementById('clarityIntelStatus');
  const btn = document.getElementById('syncClarityIntelBtn');
  const out = document.getElementById('planClarityIntel');
  const summary = document.getElementById('clarityIntelSummary');
  const lakeVal = lakeSel?.value || '';
  const label = isPlanRiverValue(lakeVal) ? (getPlanRiverDef(lakeVal)?.lakeKey || getPlanRiverDef(lakeVal)?.label || lakeVal) : lakeVal;
  const date = document.getElementById('planDate')?.value || new Date().toISOString().slice(0,10);
  const worker = (typeof CF_WORKER_URL !== 'undefined' ? CF_WORKER_URL : (window.CF_WORKER_URL || 'https://trollmap-worker.colonal1981.workers.dev'));
  function say(msg,bad){ if(statusEl){ statusEl.textContent=msg; statusEl.style.color=bad?'var(--bad)':'var(--accent2)'; } }
  if(!label){ say('Select lake first', true); return null; }
  try{
    say('Modeling runoff…', false);
    if(btn){ btn.disabled=true; btn.textContent='⏳ Modeling…'; }
    const res = await fetch(`${worker}/lake-clarity?lake=${encodeURIComponent(label)}&date=${encodeURIComponent(date)}`);
    if(!res.ok) throw new Error(`Worker HTTP ${res.status}`);
    const d = await res.json();
    const lines=[];
    lines.push(`${d.lake} — Clarity & Runoff Forecast for ${d.tripDate}`);
    lines.push(`${d.summary}`);
    lines.push(`Confidence: ${d.confidence}. ${d.verify}`);
    if(d.rain){ lines.push(`Rain/runoff signal: ${d.rain.weighted72_in}" weighted 72h rain · trip-day rain ${Math.round((d.rain.precipTrip_mm||0)/25.4*100)/100}" · wind max ${d.rain.windMax_mph||'—'} mph`); }
    if(d.overall){ lines.push(`Overall predicted clarity: ${d.overall.clarity} (score ${d.overall.score}/100)`); lines.push(`Recommended colors: ${d.overall.lureColors.join(', ')}`); lines.push(`Tactics: ${d.overall.tactics.join('; ')}`); }
    if(d.bestZones?.length){ lines.push('Best clarity / safer starting zones:'); d.bestZones.forEach(z=>lines.push(`• ${z.name}: ${z.clarity} — ${z.likely}`)); }
    if(d.dirtyZones?.length){ lines.push('Likeliest dirty/muddy zones:'); d.dirtyZones.forEach(z=>lines.push(`• ${z.name}: ${z.clarity} — ${z.likely}`)); }
    if(d.rampRecommendations?.length){ lines.push('Ramp / zone recommendations:'); d.rampRecommendations.forEach(r=>lines.push(`• ${r.zone}${r.ramps?.length?` (${r.ramps.join(', ')})`:''}: score ${r.score}/100 — ${r.why}`)); }
    if(d.note) lines.push(`Lake profile note: ${d.note}`);
    if(out) out.value = lines.join('\n');
    // Drive existing lure-color engine by updating Water Clarity select.
    if(d.overall?.select){ const claritySel=document.getElementById('planClarity'); if(claritySel) claritySel.value=d.overall.select; }
    if(summary){
      summary.style.display='block';
      summary.innerHTML = `<b style="color:var(--warn)">🌦 ${esc(d.lake)}</b><br><span>Predicted: <b>${esc(d.overall?.clarity||'Unknown')}</b></span>${d.rain?`<br><span class="muted">Rain signal: ${esc(d.rain.weighted72_in)}&quot; weighted 72h · verify at ramp</span>`:''}`;
    }
    say('✓ Clarity ready', false);
    window.LAST_CLARITY_INTEL=d;
    return d;
  } catch(err){
    console.warn('Clarity intel failed', err);
    say('Clarity error', true);
    if(out) out.value = `Clarity model failed for ${label}: ${err.message}\nManual rule: after significant rain, upper/northern creeks and backs muddy first; lower/deeper main lake is usually clearest. Verify at ramp.`;
    return null;
  } finally {
    if(btn){ btn.disabled=false; btn.textContent='⚡ Build Clarity Forecast'; }
  }
}

setTimeout(() => {
  document.getElementById('syncLakeIntelBtn')?.addEventListener('click', () => syncLakeIntelData?.());
  document.getElementById('syncClarityIntelBtn')?.addEventListener('click', () => syncClarityIntelData?.());
}, 800);

// Expose for tab-switcher and other legacy window.X callers
window.syncLakeIntelData = syncLakeIntelData;
window.syncClarityIntelData = syncClarityIntelData;
