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
  const label = window.isPlanRiverValue?.(lakeVal) ? (window.getPlanRiverDef?.(lakeVal)?.label || lakeVal) : lakeVal;
  const worker = (typeof CF_WORKER_URL !== 'undefined' ? CF_WORKER_URL : (window.CF_WORKER_URL || 'https://trollmap-worker.colonal1981.workers.dev'));
  function say(msg, bad){ if(statusEl){ statusEl.textContent=msg; statusEl.style.color=bad?'var(--bad)':'var(--accent2)'; } }
  if(!label){ say('Select waterbody first', true); return null; }
  if(window.isPlanRiverValue?.(lakeVal)){
    say('Lake intel is lake-focused', true);
    if(out) out.value = `River selected: ${label}\nUse the river fields above for live dam schedule, streamflow, surge ETA, and kayak Go/No-Go. Lake Intelligence is currently focused on lakes/reservoirs.`;
    return null;
  }
  try{
    say('Building intel...', false);
    if(btn){ btn.disabled=true; btn.textContent='Building...'; }
    const res = await fetch(`${worker}/lake-intel?lake=${encodeURIComponent(label)}`);
    if(!res.ok) throw new Error(`Worker HTTP ${res.status}`);
    const d = await res.json();
    const p = d.profile || {};
    const lines=[];
    lines.push(`${d.lake || label} \u2014 Lake Intelligence Briefing`);
    if(d.confidence && String(d.confidence).includes('generic')) lines.push('VERIFY: No curated lake profile is available yet; this is a research checklist, not confirmed lake intelligence.');
    lines.push(`Primary sport fish: ${(p.primarySportFish||[]).join(', ') || 'Unknown / verify locally'}`);
    lines.push(`Known forage: ${(p.forage||[]).join(', ') || 'Unknown'}`);
    if(p.stocking) lines.push(`Stocking / management: ${p.stocking}`);
    if(p.spottedBass) lines.push(`Spotted bass / invasive pressure: ${p.spottedBass}`);
    if(p.habitat) lines.push(`Habitat / cover: ${p.habitat}`);
    if(p.bottom) lines.push(`Bottom composition: ${p.bottom}`);
    if(p.hazards) lines.push(`Navigation hazards: ${p.hazards}`);
    if(p.seasonalPattern) lines.push(`Seasonal pattern: ${p.seasonalPattern}`);
    if(p.tacticalNotes?.length){ lines.push('Tactical notes:'); p.tacticalNotes.forEach(x=>lines.push(`\u2022 ${x}`)); }
    if(d.sourceRegistry){
      lines.push('Source Trust Stack:');
      const sr=d.sourceRegistry;
      if(sr.summary) lines.push(`\u2022 ${sr.summary.trustModel}`);
      if(sr.official?.length) lines.push(`\u2022 OFFICIAL sources: ${sr.official.map(x=>x.label).join('; ')}`);
      if(sr.habitat?.length) lines.push(`\u2022 OFFICIAL GIS / habitat sources: ${sr.habitat.map(x=>x.label).join('; ')}`);
      if(sr.reports?.length) lines.push(`\u2022 VERIFY fishing-report sources: ${sr.reports.map(x=>x.label).join('; ')}`);
      if(sr.model?.length) lines.push(`\u2022 VERIFY model/aggregate sources: ${sr.model.map(x=>x.label).join('; ')}`);
    }
    if(d.lakeMonster){
      lines.push('LakeMonster supplemental context (VERIFY \u2014 third-party/model source, not official):');
      const lm=[];
      if(d.lakeMonster.waterTemp_F) lm.push(`surface temp estimate ${d.lakeMonster.waterTemp_F}\u00B0F`);
      if(d.lakeMonster.biteRating) lm.push(`bite rating ${d.lakeMonster.biteRating}`);
      if(d.lakeMonster.wind) lm.push(`wind ${d.lakeMonster.wind}`);
      if(d.lakeMonster.pressure) lm.push(`pressure ${d.lakeMonster.pressure}`);
      if(lm.length) lines.push(`\u2022 ${lm.join(' \u00B7 ')}`);
      lines.push('\u2022 Note: LakeMonster species/elevation lists are intentionally NOT used as facts here; they can be generic or wrong for this lake.');
      if(d.lakeMonster.context) lines.push(`\u2022 ${d.lakeMonster.context}`);
    }
    if(d.latestReport?.summary){
      lines.push('Latest scraped fishing-report intel (VERIFY \u2014 third-party report, may be stale or promotional):');
      lines.push(d.latestReport.summary);
    }
    if(d.sources?.length){ lines.push('Sources / verify links:'); d.sources.forEach(src=>lines.push(`\u2022 ${src.label}: ${src.url}`)); }
    if(out) out.value = lines.join('\n');
    if(summary){
      summary.style.display='block';
      summary.innerHTML = `<b style="color:var(--accent)">🧠 ${esc(d.lake||label)}</b><br><span>${esc((p.primarySportFish||[]).join(', ')||'Profile generated')}</span>${d.confidence&&String(d.confidence).includes('generic')?`<br><span style="color:var(--warn);font-weight:700">⚠ VERIFY: generic/unconfirmed profile</span>`:''}${d.latestReport?.source?`<br><span class="muted">Latest scraped report source \u2014 verify before relying: ${esc(d.latestReport.source)}</span>`:''}`;
    }
    say('Intel ready', false);
    window.LAST_LAKE_INTEL = d;
    return d;
  } catch(err){
    console.warn('Lake intel failed', err);
    say('Intel error', true);
    if(out) out.value = `Lake Intelligence fetch failed for ${label}: ${err.message}\nManual checklist: species, forage, stocking, invasive/spotted bass, bottom composition, cover, hazards, recent fishing reports.`;
    return null;
  } finally {
    if(btn){ btn.disabled=false; btn.textContent='Build Lake Intel'; }
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
  const label = window.isPlanRiverValue?.(lakeVal) ? (window.getPlanRiverDef?.(lakeVal)?.lakeKey || window.getPlanRiverDef?.(lakeVal)?.label || lakeVal) : lakeVal;
  const date = document.getElementById('planDate')?.value || new Date().toISOString().slice(0,10);
  const worker = (typeof CF_WORKER_URL !== 'undefined' ? CF_WORKER_URL : (window.CF_WORKER_URL || 'https://trollmap-worker.colonal1981.workers.dev'));
  function say(msg,bad){ if(statusEl){ statusEl.textContent=msg; statusEl.style.color=bad?'var(--bad)':'var(--accent2)'; } }
  if(!label){ say('Select lake first', true); return null; }
  try{
    say('Modeling runoff...', false);
    if(btn){ btn.disabled=true; btn.textContent='Modeling...'; }
    const res = await fetch(`${worker}/lake-clarity?lake=${encodeURIComponent(label)}&date=${encodeURIComponent(date)}`);
    if(!res.ok) throw new Error(`Worker HTTP ${res.status}`);
    const d = await res.json();
    const lines=[];
    lines.push(`${d.lake} \u2014 Clarity & Runoff Forecast for ${d.tripDate}`);
    lines.push(`${d.summary}`);
    lines.push(`Confidence: ${d.confidence}. ${d.verify}`);
    if(d.rain){ lines.push(`Rain/runoff signal: ${d.rain.weighted72_in}" weighted 72h rain \u00B7 trip-day rain ${Math.round((d.rain.precipTrip_mm||0)/25.4*100)/100}" \u00B7 wind max ${d.rain.windMax_mph||'\u2014'} mph`); }
    if(d.overall){ lines.push(`Overall predicted clarity: ${d.overall.clarity} (score ${d.overall.score}/100)`); lines.push(`Recommended colors: ${d.overall.lureColors.join(', ')}`); lines.push(`Tactics: ${d.overall.tactics.join('; ')}`); }
    if(d.bestZones?.length){ lines.push('Best clarity / safer starting zones:'); d.bestZones.forEach(z=>lines.push(`\u2022 ${z.name}: ${z.clarity} \u2014 ${z.likely}`)); }
    if(d.dirtyZones?.length){ lines.push('Likeliest dirty/muddy zones:'); d.dirtyZones.forEach(z=>lines.push(`\u2022 ${z.name}: ${z.clarity} \u2014 ${z.likely}`)); }
    if(d.rampRecommendations?.length){ lines.push('Ramp / zone recommendations:'); d.rampRecommendations.forEach(r=>lines.push(`\u2022 ${r.zone}${r.ramps?.length?` (${r.ramps.join(', ')})`:''}: score ${r.score}/100 \u2014 ${r.why}`)); }
    if(d.note) lines.push(`Lake profile note: ${d.note}`);
    if(out) out.value = lines.join('\n');
    // Drive existing lure-color engine by updating Water Clarity select.
    if(d.overall?.select){ const claritySel=document.getElementById('planClarity'); if(claritySel) claritySel.value=d.overall.select; }

    // Populate planWeather hidden field for Smart Plan / Groq consumption
    const weatherEl = document.getElementById('planWeather');
    if (weatherEl && d.rain && !weatherEl.value) {
      const wind = d.rain.windMax_mph != null ? `${Math.round(d.rain.windMax_mph)} mph` : 'calm';
      const precipIn = d.rain.precipTrip_mm != null ? (d.rain.precipTrip_mm / 25.4).toFixed(2) : '0';
      const precip72 = d.rain.weighted72_in != null ? d.rain.weighted72_in.toFixed(2) : '0';
      const dir = d.rain.windDirection_deg != null ? ` ${d.rain.windDirection_deg}\u00B0` : '';
      weatherEl.value = `Wind ${wind}${dir} \u00B7 Precip ${precipIn}" (trip) / ${precip72}" (72h weighted)`;
    }

    if(summary){
      summary.style.display='block';
      const windSummary = d.rain?.windMax_mph != null
        ? `Wind: ${Math.round(d.rain.windMax_mph)} mph${d.rain.windDirection_deg != null ? ` ${Math.round(d.rain.windDirection_deg)}\u00B0` : ''} \u00B7 `
        : '';
      summary.innerHTML = `<b style="color:var(--warn)">🌦 ${esc(d.lake)}</b><br><span>Predicted: <b>${esc(d.overall?.clarity||'Unknown')}</b></span>${d.rain?`<br><span class="muted">${esc(windSummary)}Rain signal: ${esc(d.rain.weighted72_in)}" weighted 72h \u00B7 verify at ramp</span>`:''}`;
    }
    say('Clarity ready', false);
    window.LAST_CLARITY_INTEL=d;
    return d;
  } catch(err){
    console.warn('Clarity intel failed', err);
    say('Clarity error', true);
    if(out) out.value = `Clarity model failed for ${label}: ${err.message}\nManual rule: after significant rain, upper/northern creeks and backs muddy first; lower/deeper main lake is usually clearest. Verify at ramp.`;
    return null;
  } finally {
    if(btn){ btn.disabled=false; btn.textContent='Build Clarity Forecast'; }
  }
}

setTimeout(() => {
  document.getElementById('syncLakeIntelBtn')?.addEventListener('click', () => syncLakeIntelData?.());
  document.getElementById('syncClarityIntelBtn')?.addEventListener('click', () => syncClarityIntelData?.());

  // Auto-trigger clarity forecast when lake selection changes (like utility-sync.js)
  const lakeSel = document.getElementById('planLake');
  if (lakeSel) {
    lakeSel.addEventListener('change', () => {
      // Small delay to let other handlers run first
      setTimeout(() => syncClarityIntelData?.(), 300);
    });
  }

  // Auto-trigger once on app load
  setTimeout(() => syncClarityIntelData?.(), 1000);
}, 800);

// Expose for tab-switcher and other legacy window.X callers
window.syncLakeIntelData = syncLakeIntelData;
window.syncClarityIntelData = syncClarityIntelData;