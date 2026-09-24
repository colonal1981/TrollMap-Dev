/**
 * Lake Intelligence + Clarity Forecast — pulls fisherman-focused
 * briefings and zone-based clarity predictions from the worker.
 * Writes results into the Plan tab textareas and the callout boxes.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { coerceList, coerceLabels } from '../utils/coerce.js';
import { clarityForPlan, versusNormalAt } from '../utils/clarity-at-ramp.js';
import { lakeRecordFor } from '../data/lake-registry.js';

/* Lake Intel: species, forage, habitat, hazards, seasonal patterns */
export async function syncLakeIntelData() {
  const lakeSel = document.getElementById('planLake');
  const statusEl = document.getElementById('lakeIntelStatus');
  const btn = document.getElementById('syncLakeIntelBtn');
  const out = document.getElementById('planLakeIntel');
  const summary = document.getElementById('lakeIntelSummary');
  const lakeVal = lakeSel?.value || '';
  // Two different questions, and they used to share one wrong answer. The LABEL comes from a
  // curated entry when there is one, so it is asked of getPlanRiverDef; whether lake intel applies
  // at all is asked of isRiverWater, below, which knows all 58 river rows and not just six.
  const label = window.getPlanRiverDef?.(lakeVal)?.label || lakeVal;
  const worker = (typeof CF_WORKER_URL !== 'undefined' ? CF_WORKER_URL : (window.CF_WORKER_URL || 'https://trollmap-worker.colonal1981.workers.dev'));
  function say(msg, bad){ if(statusEl){ statusEl.textContent=msg; statusEl.style.color=bad?'var(--bad)':'var(--accent2)'; } }
  if(!label){ say('Select waterbody first', true); return null; }
  if(window.isRiverWater?.(lakeVal)){
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
    // NO STATUS GATE. Until 2026-09-23 this line read `&& d.researched?.status === 'verified'`
    // and threw the whole profile away otherwise, so sixteen lakes researched after the tab
    // stopped being used were told "no curated lake profile is available yet" while their
    // research sat in R2. `verified` only ever meant somebody clicked Approve in July; 54 of the
    // 61 profiles carrying it held zero extracted facts. A profile that exists is the profile.
    const rp = d.hasResearchedProfile ? (d.researched?.fullProfile || null) : null;
    const lines=[];

    // Header
    lines.push(`${d.lake || label} \u2014 Lake Intelligence Briefing`);
    if(rp) {
      // NO CONFIDENCE ON THIS LINE. It was a percentage out of a source count that decided
      // nothing -- see Worker/research/agents.js. The version and the date are facts about the
      // profile; the score was a claim about it.
      lines.push(`\uD83E\uDDE0 Research Profile v${rp.metadata?.version||'?'} \u00B7 ${new Date(rp.metadata?.lastUpdated||Date.now()).toLocaleDateString()}`);
      // WHAT IS BEHIND THE FISH, which is what the retired flag pretended to say. Derived on
      // every save by the biology agent, present on all 78 profiles measured 2026-09-23.
      const bioWhy = rp.confidence?.biology?.reason;
      if (bioWhy) lines.push(`Sources behind the biology: ${bioWhy}`);
    } else if(d.confidence && String(d.confidence).includes('generic')) {
      lines.push('VERIFY: No curated lake profile is available yet; this is a research checklist, not confirmed lake intelligence.');
    }

    // Species / forage
    if(rp?.biology) {
      const bio = rp.biology;
      // Biology agent outputs predatorSpecies; fallback to primaryGameFish for backward compat.
      // Coerce to arrays defensively — a malformed string value (e.g. from a prior
      // run) would otherwise crash .join()/.map(); the assembly path now repairs it.
      const gameFish = [bio.predatorSpecies, bio.primaryGameFish].map(coerceList).find((l) => l.length) || [];
      if(gameFish.length) lines.push(`Primary sport fish: ${gameFish.join(', ')}`);
      const forage = coerceList(bio.primaryForage).map(f => typeof f === 'string' ? f : f?.species).filter(Boolean);
      if(forage.length) lines.push(`Known forage: ${forage.join(', ')}`);
      const stockings = coerceList(bio.knownStockings);
      if(stockings.length) {
        lines.push(`Stocking / management: ${stockings.map(s => typeof s === 'string' ? s : `${s.species}${s.note ? ` (${s.note})` : ''}`).join('; ')}`);
      } else if(bio.stocking) lines.push(`Stocking / management: ${bio.stocking}`);
    } else {
      lines.push(`Primary sport fish: ${coerceList(p.primarySportFish).join(', ') || 'Unknown / verify locally'}`);
      lines.push(`Known forage: ${coerceList(p.forage).join(', ') || 'Unknown'}`);
      if(p.stocking) lines.push(`Stocking / management: ${p.stocking}`);
      if(p.spottedBass) lines.push(`Spotted bass / invasive pressure: ${p.spottedBass}`);
    }

    // Habitat / cover / bottom
    if(rp?.habitat) {
      const h = rp.habitat;

      // Helper: format a single coordinate object as lat/lon pair
      const fmtCoord = (c) => {
        if (!c || typeof c !== 'object') return String(c);
        const lat = Number(c.lat);
        const lon = Number(c.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          // Extra context if available (id, acres, depth, density) but keep primary as lat/lon
          const extras = [];
          if (c.areaAcres != null) extras.push(`~${c.areaAcres}ac`);
          if (c.depth != null) extras.push(`@${c.depth}ft`);
          if (c.contourDensity != null) extras.push(`density ${c.contourDensity}`);
          const base = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
          return extras.length ? `${base} (${extras.join(' ')})` : base;
        }
        // Fallback for generic object
        return JSON.stringify(c);
      };

      // Helper: format any structural element value into human-readable lat/lon or text
      const fmtStructVal = (v) => {
        if (v == null) return '';
        if (Array.isArray(v)) {
          if (!v.length) return '';
          if (typeof v[0] === 'object' && v[0] !== null && ('lat' in v[0] || 'lon' in v[0])) {
            // Array of coordinate objects -> format as lat/lon pairs
            return v.map(fmtCoord).join('; ');
          }
          if (typeof v[0] === 'string') return v.join(', ');
          // Mixed / generic objects
          return v.map(item => {
            if (item && typeof item === 'object' && 'lat' in item && 'lon' in item) return fmtCoord(item);
            if (typeof item === 'string') return item;
            return JSON.stringify(item);
          }).join('; ');
        }
        if (typeof v === 'string') return v;
        if (typeof v === 'object') {
          if ('lat' in v && 'lon' in v) return fmtCoord(v);
          // Generic object map — show key: value, filtering low/empty
          const entries = Object.entries(v).filter(([k, val]) => k !== 'note' && val && val !== 'low');
          if (!entries.length) return '';
          return entries.map(([k2, val2]) => {
            if (typeof val2 === 'object') return `${k2}: ${fmtStructVal(val2)}`;
            return `${k2} (${val2})`;
          }).join(', ');
        }
        return String(v);
      };

      const cover = coerceList(h.cover).map(c => typeof c === 'string' ? c : fmtStructVal(c)).filter(Boolean);
      if(cover.length) lines.push(`Habitat / cover: ${cover.join(', ')}`);
      if(h.structuralElements && typeof h.structuralElements === 'object') {
        const structParts = Object.entries(h.structuralElements)
          .map(([k, v]) => {
            const formatted = fmtStructVal(v);
            if (!formatted) return null;
            return `${k}: ${formatted}`;
          })
          .filter(Boolean);
        if (structParts.length) lines.push(`Structure: ${structParts.join('; ')}`);
      }
      if(h.bottomComposition) {
        const bc = h.bottomComposition;
        if (typeof bc === 'string') {
          lines.push(`Bottom composition: ${bc}`);
        } else if (Array.isArray(bc)) {
          // Array of strings or objects
          const txt = bc.map(item => typeof item === 'string' ? item : fmtStructVal(item)).filter(Boolean).join(', ');
          if (txt) lines.push(`Bottom composition: ${txt}`);
        } else if (typeof bc === 'object') {
          const entries = Object.entries(bc).filter(([k, v]) => k !== 'note' && v && v !== 'low');
          if (entries.length) {
            const txt = entries.map(([k, v]) => {
              if (typeof v === 'object') return `${k}: ${fmtStructVal(v)}`;
              return `${k} (${v})`;
            }).join(', ');
            if (txt) lines.push(`Bottom composition: ${txt}`);
          } else if (bc.note) {
            lines.push(`Bottom composition: ${bc.note}`);
          }
        }
      }
      if(h.notes) lines.push(`Habitat notes: ${h.notes}`);
    } else {
      if(p.habitat) lines.push(`Habitat / cover: ${p.habitat}`);
      if(p.bottom) lines.push(`Bottom composition: ${p.bottom}`);
    }

    // NAVIGATION HAZARDS WERE HERE AND ARE GONE -- 2026-09-01.
    //
    // The block read researchHazards(rp), which read the navigation agent's prose. That agent is
    // retired: of 88 hazard sentences across 42 profiles, nine were TVA boilerplate, nine named a
    // marina rather than a hazard, and Wateree's own two were a weather-history line the live wind
    // path answers better and a bridge replacement stored with no date on it.
    //
    // The charted hazards -- 33 Hazard, 34 No Wake, 13 No Boats on Wateree, typed and positioned
    // off Garmin's survey -- reach the PLAN through chartedHazards(), which needs the pack's POI
    // layer. This briefing does not load one, so it says nothing rather than saying prose. If it
    // should carry them, it needs the pack, not a research field.

    // Seasonal pattern / trolling intel
    if(rp?.trollingIntelligence) {
      const ti = rp.trollingIntelligence;
      const species = Object.keys(ti);
      if(species.length) {
        lines.push('Seasonal trolling patterns (verified):');
        species.forEach(sp => {
          const seasons = ti[sp];
          const parts = [];
          if(seasons?.summer?.preferredDepth) parts.push(`Summer: ${seasons.summer.preferredDepth[0]}-${seasons.summer.preferredDepth[1]}ft`);
          if(seasons?.winter?.preferredDepth) parts.push(`Winter: ${seasons.winter.preferredDepth[0]}-${seasons.winter.preferredDepth[1]}ft`);
          if(parts.length) lines.push(`\u2022 ${sp}: ${parts.join(' \u00B7 ')}`);
        });
      }
    } else {
      if(p.seasonalPattern) lines.push(`Seasonal pattern: ${p.seasonalPattern}`);
      const tacticalNotes = coerceList(p.tacticalNotes);
      if(tacticalNotes.length){ lines.push('Tactical notes:'); tacticalNotes.forEach(x=>lines.push(`\u2022 ${x}`)); }
    }

    // Regulations
    if(rp?.regulations) {
      const reg = rp.regulations;
      lines.push('Regulations (verified \u2014 always confirm with SCDNR):');
      if(reg.lengthLimits) Object.entries(reg.lengthLimits).forEach(([sp,limit])=>lines.push(`\u2022 ${sp}: ${limit}`));
      if(reg.creelLimits) Object.entries(reg.creelLimits).forEach(([sp,limit])=>lines.push(`\u2022 ${sp} creel: ${limit} fish/day`));
      if(reg.notes) lines.push(`\u2022 ${reg.notes}`);
    }
    if(d.sourceRegistry){
      lines.push('Source Trust Stack:');
      const sr=d.sourceRegistry;
      if(sr.summary) lines.push(`\u2022 ${sr.summary.trustModel}`);
      const srList_official = coerceLabels(sr.official);
      if(srList_official.length) lines.push(`\u2022 OFFICIAL sources: ${srList_official.join('; ')}`);
      const srList_habitat = coerceLabels(sr.habitat);
      if(srList_habitat.length) lines.push(`\u2022 OFFICIAL GIS / habitat sources: ${srList_habitat.join('; ')}`);
      const srList_reports = coerceLabels(sr.reports);
      if(srList_reports.length) lines.push(`\u2022 VERIFY fishing-report sources: ${srList_reports.join('; ')}`);
      const srList_model = coerceLabels(sr.model);
      if(srList_model.length) lines.push(`\u2022 VERIFY model/aggregate sources: ${srList_model.join('; ')}`);
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
      const profileBadge = rp ? `<br><span style="color:var(--accent2);font-weight:700">\uD83E\uDDE0 Research v${rp.metadata?.version||'?'}</span>` : (d.confidence&&String(d.confidence).includes('generic')?`<br><span style="color:var(--warn);font-weight:700">\u26A0 VERIFY: generic/unconfirmed profile</span>`:'');
      const spList = [rp?.biology?.predatorSpecies, rp?.biology?.primaryGameFish, p.primarySportFish]
        .map(coerceList).find((l) => l.length) || [];
      const speciesDisplay = spList.join(', ') || 'Profile generated';
      summary.innerHTML = `<b style="color:var(--accent)">\uD83E\uDDE0 ${esc(d.lake||label)}</b><br><span>${esc(speciesDisplay)}</span>${profileBadge}${d.latestReport?.source?`<br><span class="muted">Latest scraped report source \u2014 verify before relying: ${esc(d.latestReport.source)}</span>`:''}`;
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
/**
 * @param {object} [o]
 * @param {string} [o.rampName] the ramp this forecast is FOR. Defaults to the plan tab's select,
 *        which is where the event handlers get it, but it is a parameter because the answer depends
 *        on it and a function that reaches into the DOM for an input answers differently depending
 *        on what has rendered. That is the whole of the bug below.
 * @param {object} [o.payload] a /lake-clarity response already in hand. The planners fetch it to
 *        resolve the clarity the plan is built on — see fetchClarityAtRamp() — and pass it here so
 *        the briefing is rendered from the SAME response rather than a second request that could
 *        answer differently.
 *
 * ── AND WHY A PLANNER CALLS THIS AT ALL ─────────────────────────────────────────────────────────
 *
 * The briefing is a SNAPSHOT: it is written into the #planClarityIntel textarea whenever this last
 * ran, saved into the plan from there, and restored into the textarea when a plan is loaded. It runs
 * on lake change, tab switch, app load and a button — and a restored form does not fire a change
 * event, so on a reload the only run is the one at +1000ms, while the ramp dropdown is still being
 * filled from the access index. Ryan, 2026-09-15, with Clearwater Cove selected the whole time:
 * "I did have a ramp selected". He did. The briefing was rendered before the box had it, and nothing
 * regenerated it when he built the plan.
 *
 * So the planners refresh it with the ramp on the request, before they collect the plan.
 */
export async function syncClarityIntelData(o = {}) {
  const lakeSel = document.getElementById('planLake');
  const statusEl = document.getElementById('clarityIntelStatus');
  const btn = document.getElementById('syncClarityIntelBtn');
  const out = document.getElementById('planClarityIntel');
  const summary = document.getElementById('clarityIntelSummary');
  const lakeVal = lakeSel?.value || '';
  const label = window.getPlanRiverDef?.(lakeVal)?.lakeKey
             || window.getPlanRiverDef?.(lakeVal)?.label || lakeVal;
  const date = document.getElementById('planDate')?.value || new Date().toISOString().slice(0,10);
  const worker = (typeof CF_WORKER_URL !== 'undefined' ? CF_WORKER_URL : (window.CF_WORKER_URL || 'https://trollmap-worker.colonal1981.workers.dev'));
  function say(msg,bad){ if(statusEl){ statusEl.textContent=msg; statusEl.style.color=bad?'var(--bad)':'var(--accent2)'; } }
  if(!label){ say('Select lake first', true); return null; }
  try{
    say('Modeling runoff...', false);
    if(btn){ btn.disabled=true; btn.textContent='Modeling...'; }
    let d = o.payload || null;
    if (!d) {
      // Same reason as fetchClarityAtRamp(): with no point the Worker reads the rain near
      // Columbia for any water that has no hand-authored clarity profile.
      const cRec = lakeRecordFor(label);
      const cPt = cRec && Number.isFinite(Number(cRec.lat)) && Number.isFinite(Number(cRec.lon)) ? cRec : null;
      const res = await fetch(`${worker}/lake-clarity?lake=${encodeURIComponent(label)}&date=${encodeURIComponent(date)}`
        + (cPt ? `&lat=${Number(cPt.lat)}&lon=${Number(cPt.lon)}` : ''));
      if(!res.ok) throw new Error(`Worker HTTP ${res.status}`);
      d = await res.json();
    }
    const lines=[];
    lines.push(`${d.lake} \u2014 Clarity & Runoff Forecast for ${d.tripDate}`);
    lines.push(`${d.summary}`);
    lines.push(`Confidence: ${d.confidence}. ${d.verify}`);
    if(d.rain){ lines.push(`Rain/runoff signal: ${d.rain.weighted72_in}" weighted 72h rain \u00B7 trip-day rain ${Math.round((d.rain.precipTrip_mm||0)/25.4*100)/100}" \u00B7 wind max ${d.rain.windMax_mph||'\u2014'} mph`); }
    // ── THE CLARITY WHERE HE IS LAUNCHING, NOT THE AVERAGE OF THE WHOLE LAKE ──────────────────
    //
    // Ryan, 2026-09-14, on a CAUTION line that said the lake was muddy: "this is probably correct
    // in the creeks or the northern section of the lake but i highly doubt it is applicable near
    // clearwater cove... what is it using to calculate the clarity??? i thought we made it
    // location aware?"
    //
    // It IS location aware and nothing was reading that half. `overall.score` is the mean of every
    // zone's score, and Wateree has six: the upper river and Dutchmans Creek run sensitivity 1.45
    // and 1.35 over clay banks, the dam basin runs 0.70. Averaging them produces a verdict about
    // water he is not going anywhere near, and the profile names his ramp in the CLEAREST zone --
    // "Lower main-lake channel / dam basin", ramps: ["Clearwater Cove Marina", ...]. The answer was
    // in the payload, keyed by the ramp he picked, and the risk line was reading the average.
    //
    // NAMED, NOT SUBSTITUTED. Both numbers go in: his zone is the one a decision should rest on,
    // and the lake-wide figure still says what the rest of the water is doing, because a mudline
    // upstream is a thing to know about even when you are launching in clear water.
    const rampNow = String(o.rampName != null ? o.rampName
      : (document.getElementById('planRamp')?.value || '')).trim();
    // ONE RESOLUTION, TWO READERS: this sentence and the Water Clarity select further down. See
    // js/utils/clarity-at-ramp.js for why it is not inlined here any more.
    const forPlan = clarityForPlan(d, rampNow);
    const zoneForRamp = forPlan.zone;
    if(forPlan.source === 'station' && d.atLaunch){
      // MEASURED NEAR THE LAUNCH. The station, its distance and its own readings, then the same
      // how-far-off-normal sentence the zone line gives -- read at that station, not the lake.
      lines.push(`AT YOUR LAUNCH${rampNow ? ` (${rampNow})` : ''}: ${d.atLaunch.clarity} `
               + `(score ${d.atLaunch.score}/100) — ${d.atLaunch.why}.`);
      const vs = versusNormalAt(d, rampNow);
      if (vs) lines.push(vs.sentence);
      lines.push(`Colors for that water: ${coerceList(d.atLaunch.lureColors).join(', ')}`);
    } else if(zoneForRamp){
      lines.push(`AT YOUR RAMP (${rampNow}) — ${zoneForRamp.name}: ${zoneForRamp.clarity} `
               + `(score ${zoneForRamp.score}/100). ${zoneForRamp.likely}.`);
      // THE HALF THAT SAYS WHETHER TO CARE. "Stained" on Wateree is Tuesday; "stained" on a lake
      // that usually reads eight feet has just been rained on. Same word, and only the water's own
      // baseline tells them apart -- see versusNormalAt().
      const vs = versusNormalAt(d, rampNow);
      if (vs) lines.push(vs.sentence);
      lines.push(`Colors for that zone: ${coerceList(zoneForRamp.lureColors).join(', ')}`);
    } else if(rampNow){
      lines.push(`No clarity zone in this lake's model lists ${rampNow}, so only the lake-wide `
               + `figure below applies to it.`);
    } else {
      // ── SILENCE HERE READ AS "THERE IS NO RAMP-SPECIFIC ANSWER" ────────────────────────────
      //
      // With no ramp selected, both branches above were skipped and the briefing simply had no line
      // about the launch -- so a reader saw the lake-wide figure and nothing telling him it was the
      // lake-wide figure BY DEFAULT rather than by finding. This runs on lake change, tab switch and
      // app load, and on a reload the ramp dropdown is filled asynchronously after the access index
      // lands, so the +1000ms run genuinely has no launch to answer about.
      //
      // Ryan's 2026-09-15 briefing had neither line, which is how I knew the ramp was empty when it
      // ran rather than unmatched. An absent input says so now, the same rule the rest of this app
      // follows.
      lines.push('No launch was selected when this was modelled, so everything below is LAKE-WIDE. '
               + 'Pick a ramp and this recomputes for the zone it is in.');
    }
    if(d.overall){ lines.push(`Overall predicted clarity (LAKE-WIDE MEAN of ${coerceList(d.zones).length || '?'} zones, not your ramp): ${d.overall.clarity} (score ${d.overall.score}/100)`); lines.push(`Recommended colors: ${coerceList(d.overall.lureColors).join(', ')}`); lines.push(`Tactics: ${coerceList(d.overall.tactics).join('; ')}`); }
    if(coerceList(d.bestZones).length){ lines.push('Best clarity / safer starting zones:'); coerceList(d.bestZones).forEach(z=>lines.push(`\u2022 ${z.name}: ${z.clarity} \u2014 ${z.likely}`)); }
    if(coerceList(d.dirtyZones).length){ lines.push('Likeliest dirty/muddy zones:'); coerceList(d.dirtyZones).forEach(z=>lines.push(`\u2022 ${z.name}: ${z.clarity} \u2014 ${z.likely}`)); }
    if(coerceList(d.rampRecommendations).length){ lines.push('Ramp / zone recommendations:'); coerceList(d.rampRecommendations).forEach(r=>lines.push(`\u2022 ${r.zone}${coerceList(r.ramps).length?` (${coerceList(r.ramps).join(', ')})`:''}: score ${r.score}/100 \u2014 ${r.why}`)); }
    if(d.note) lines.push(`Lake profile note: ${d.note}`);
    if(out) out.value = lines.join('\n');
    // ── THE CLARITY THE PLAN IS BUILT ON, NOT JUST THE SENTENCE ABOVE IT ─────────────────────
    //
    // This line was `claritySel.value = d.overall.select` — the LAKE-WIDE MEAN — and that select is
    // not a label. smart-plan-v2-wiring.js:49 reads it as `clarity`, it reaches the model as
    // `conditions.clarity`, and getLureColor() picks every colour off it.
    //
    // Measured on Ryan's 2026-09-14 Wateree bench: the prompt carried `"clarity": "Muddy"` — the
    // mean of six zones — two lines above the profile's own `Typical clarity: stained`. Two clarity
    // verdicts for one lake in one prompt, and the one that reads as TODAY was an average of water
    // he was not going anywhere near. His ramp is in "Lower main-lake channel / dam basin", the
    // CLEAREST zone on the lake at 39/100, Stained.
    //
    // Ryan, the day before: "this is probably correct in the creeks or the northern section of the
    // lake but i highly doubt it is applicable near clearwater cove... what is it using to
    // calculate the clarity??? i thought we made it location aware?"
    //
    // I answered that by adding the AT YOUR RAMP sentence and left this line alone, so the app said
    // the right thing in prose and reasoned with the wrong number. The zone he launches in is the
    // one the plan is built on now, and the lake-wide figure stays in the text where it belongs.
    // When no zone names his ramp the mean is still used — it is the only answer there is — and the
    // sentence above already says so rather than implying the number is about here.
    const claritySel = document.getElementById('planClarity');
    if (claritySel && forPlan.select) claritySel.value = forPlan.select;

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
      // THE BADGE SAYS WHICH WATER IT IS ABOUT. It read `Predicted: Muddy` off the lake-wide mean,
      // which is the same unattributed number the CAUTION line and the clarity select were reading.
      // With a zone resolved it names his ramp's zone and keeps the mean beside it; without one it
      // says lake-wide, so the word "Predicted" is never standing over an unqualified average.
      const st = forPlan.station || null;
      const badge = forPlan.source === 'station'
        ? `At ${esc(rampNow || 'the launch')}: <b>${esc(forPlan.clarity || 'Unknown')}</b>`
          + `<span class="muted"> · measured at ${esc(st?.name || st?.id || 'the nearest station')}`
          + `${st && st.km != null ? `, ${esc(st.km)} km away` : ''}`
          + ` · lake-wide ${esc(d.overall?.clarity || '?')}</span>`
        : forPlan.source === 'ramp'
        ? `At ${esc(rampNow)}: <b>${esc(forPlan.clarity || 'Unknown')}</b>`
          + `<span class="muted"> · lake-wide ${esc(d.overall?.clarity || '?')}</span>`
        : `Predicted (lake-wide): <b>${esc(d.overall?.clarity || 'Unknown')}</b>`;
      summary.innerHTML = `<b style="color:var(--warn)">🌦 ${esc(d.lake)}</b><br><span>${badge}</span>${d.rain?`<br><span class="muted">${esc(windSummary)}Rain signal: ${esc(d.rain.weighted72_in)}" weighted 72h \u00B7 verify at ramp</span>`:''}`;
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

  // ── AND WHEN HE PICKS THE RAMP, BECAUSE THE ANSWER DEPENDS ON IT ────────────────────────────
  //
  // The forecast fired on lake change, on tab switch, on load and on the button — never on the
  // ramp. So it ran while `planRamp` was still empty or still the previous lake's ramp, wrote a
  // briefing with no AT YOUR RAMP line and the lake-wide clarity into the select, and nothing
  // recomputed when he chose Clearwater Cove. Measured on the 2026-09-14 Wateree bench: the card
  // said "muddy water LAKE-WIDE" on a day his own zone modelled Stained at 39/100.
  //
  // The ramp is passed rather than re-read, so what this run is ABOUT is the ramp that changed.
  const rampSel = document.getElementById('planRamp');
  if (rampSel) {
    rampSel.addEventListener('change', (e) => {
      const rampName = (e.target && e.target.value) || '';
      setTimeout(() => syncClarityIntelData?.({ rampName }), 300);
    });
  }

  // Auto-trigger once on app load
  setTimeout(() => syncClarityIntelData?.(), 1000);
}, 800);

// Expose for tab-switcher and other legacy window.X callers
window.syncLakeIntelData = syncLakeIntelData;
window.syncClarityIntelData = syncClarityIntelData;