/**
 * Plan Builder — the Plan tab form, save/load, preview rendering,
 * and lake/river dropdown management.
 *
 * The single biggest module in the app (about 1,200 lines). It contains
 * collectPlan() (read form to object), loadPlanIntoForm() (write object
 * to form + the entire plan-preview HTML generator), renderPlanStats()
 * (the stats bar), and the lake/river dropdown population logic.
 */

import { state } from "../core/state.js";
import { esc } from "../utils/escape.js";
import { planIssues } from "./plan-issues.js";
import { lakeDbEntryFor, lakeNamesForPicker, lakeRecordFor } from "../data/lake-registry.js";
import { renderSpread } from "./spread-builder.js";
import { newRodRow } from "../utils/rod-row.js";
import { getFilename, setFilename } from "../core/map-init.js";
import { COASTAL_ZONES, isCoastalKey } from "../data/coastal-zones.js";
import { landOnCoastalZone, focusRamp } from "../utils/viewport-cull.js";
import { appendCoastalOptgroups } from "../utils/coastal-optgroups.js";
import { resolveR2Key } from "../data/lake-keys.js";
import { advisoryRows } from "../data/fish-advisories.js";
// The band is defined once, where the cue line that carries it is built.
import { HAND_STEER_BAND_FT } from "./plan-tracks.js";
import { makePredicate } from "../data/water-filter.js";
import { registryRecordFor } from "../data/access-index.js";
// distFt() was CALLED below and never imported -- a latent ReferenceError predating the
// registry refactor. renderPlanStats() died at the distance line whenever a track had two or
// more points, so planDist and planGroups never filled in. Found 2026-08-02 by a scope check
// over the modules that refactor touched, not by the refactor itself.
//
// fetchDamLevels() was the other one, and it is gone rather than fixed -- Module F now reads
// /conditions, which resolves every operator from water_bindings.json instead of four
// hand-written substring matchers. See Module F for what that replaced.
import { fetchWaterConditions } from "../utils/water-conditions.js";
import { distFt } from "../utils/geo.js";
import { solunarFor } from "../utils/solunar.js";
import { get as dbGet, put as dbPut, getAll as dbGetAll, del as dbDel, isReady as dbIsReady } from '../utils/db.js';

// ─────────────────────────────────────────────────────────────
// LANE TELEMETRY, READ OFF THE PLAN.
//
// What was here before computed its own numbers. It walked `state.DATA.tracks`, measured each
// track's polyline itself, and priced every one of them at a single speed taken from
// `#planSpeed` or from a v1 `Ph<n>` phase-speed table that the v2 path never writes. On the
// report Ryan generated on 2026-08-09 that produced a table which contradicted the timeline
// standing three inches above it:
//
//     every lane at 1.8 mph, INCLUDING the transits, which the plan runs at 3.5
//     L1 at 5.0 mi, where the plan's own leg says 4.5
//     T2 at 224 min, where the plan says 103
//
// This is the same disease as the three-conflicting-depths bug fixed in bb980af, and the rule
// from that fix applies unchanged: anything in this document that can be read off the plan MUST
// be, and anything that cannot be read off the plan and cannot be measured stays empty. So there
// is no track walking here and no fallback speed. Legs, or no table.
//
// `estDurationMin` on a troll leg already includes its cast stops -- see assemblePlan(). That is
// why a leg's run time can exceed its distance divided by its speed, and it is the number the
// timeline shows, which is the point.
export function laneTelemetry(plan) {
  const legs = (plan && Array.isArray(plan.legs)) ? plan.legs : [];
  const out = [];
  for (const l of legs) {
    const lengthM = Number(l.lengthM);
    if (!Number.isFinite(lengthM)) continue;
    const mph = Number(l.speedMph);
    const mins = Number(l.estDurationMin);
    const ah = Number(l.batteryAh);
    out.push({
      id: l.id,
      // The label the leg already carries. `role: 'return'` is a label on a transit, not a third
      // leg type -- see the route-home block in plan-assemble.js.
      kind: l.type === 'transit'
        ? (l.role === 'return' ? 'Transit — back to the ramp' : 'Transit — nothing in the water')
        : (l.depthFt != null ? `Troll · ${l.depthFt} ft` : 'Troll'),
      distMi: (lengthM / 1609.34).toFixed(2),
      speedMph: Number.isFinite(mph) ? mph.toFixed(1) : '—',
      mins: Number.isFinite(mins) ? mins : '—',
      batteryAh: Number.isFinite(ah) ? ah.toFixed(2) : '—',
      transit: l.type === 'transit',
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────

function normalizedPhaseSpeeds(phaseSpeeds) {
  return Array.isArray(phaseSpeeds)
    ? phaseSpeeds.filter((pass) => Number.isFinite(Number(pass?.phase)) && Number(pass?.speed) > 0)
      .map((pass) => ({ ...pass, phase: Number(pass.phase), speed: Number(pass.speed) }))
    : [];
}

// speedForTrack() lived here until 2026-08-09. It matched a track name against `Ph<n>` -- v1's
// four-phase naming, which the v2 path never writes -- and fell back to `#planSpeed` for anything
// it could not match, which was every track. That fallback is where the Lane Telemetry table's
// "1.8 mph on every lane, transits included" came from. Its only caller now reads plan.legs.

function formatPhaseSpeeds(phaseSpeeds, fallbackSpeed) {
  const savedPasses = normalizedPhaseSpeeds(phaseSpeeds);
  if (!savedPasses.length) return `${fallbackSpeed} mph`;
  return savedPasses
    .sort((a, b) => a.phase - b.phase)
    .map((pass) => `${pass.phaseName || `Band ${pass.phase}`}: ${pass.speed} mph`)
    .join(' · ');
}

/**
 * The v2 plan itself, if one has been generated this session.
 *
 * WHY THIS IS HERE. collectPlan() rebuilt `meta` and `trolling` from form fields, and
 * `#planTargetDepth` is a hidden input only v1 ever wrote (smart-plan.js:1214). On the v2 path it
 * is empty, so the HTML fell through to hardcoded literals -- '25–35' in the sonar table and the
 * summary row, '18–28' in the AI-reasoning box -- while the timeline said 15–27. Ryan got a
 * document with three different target depths in it, none of which was the depth the legs
 * actually follow.
 *
 * A plan is a document about one day. Anything in it that can be read off the plan MUST be, and
 * anything that cannot be read off the plan and cannot be measured stays empty.
 */
function planV2() {
  try { return (typeof window !== 'undefined' && window._planV2) || null; } catch { return null; }
}

/**
 * THE WHOLE RESULT, not just the plan: the prompt that was sent, the answer that came back, and
 * every problem the app raised reading it.
 *
 * Ryan, 2026-08-31, on a plan with four legs trolled empty and no idea why: "the plan doesn't
 * show what the models get sent to them????" It did not, and every part of it was already in
 * memory. buildSmartPlanV2() returns `{plan, candidates, request, response, problems}` and the
 * wiring parks the lot on `window._planV2Result` -- and then collectPlan() read `window._planV2`
 * and saved the plan alone. So a saved plan carried the assembler's warnings and nothing about
 * the exchange that produced them: whether the model left `deploy` off a leg, or named a rod the
 * app then refused, read identically in the file. Both are one line in `problems`.
 */
function planV2Result() {
  try { return (typeof window !== 'undefined' && window._planV2Result) || null; } catch { return null; }
}

/** "22.4" for one contour, "22.4–31" for several. Never a band the species is using. */
function contourRange(plan) {
  const ft = (plan.legs || []).filter((l) => l.type === 'troll' && l.depthFt != null)
    .map((l) => Number(l.depthFt)).filter(Number.isFinite);
  if (!ft.length) return '';
  const lo = Math.min(...ft), hi = Math.max(...ft);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}

/**
 * THE SAME WALK AS contourRange(), KEPT PER LEG.
 *
 * `Sonar Setup > Alarms > Contour` takes a Shallow and a Deep limit in feet and sounds when the
 * transducer leaves the band -- the manual: "calling attention when encountering a steep drop-off
 * or a sudden shallow area." `Layers > Chart > Depth > Depth Shading` takes the same pair and
 * paints the water between them. One band, heard and seen, per leg.
 *
 * The half-width is HAND_STEER_BAND_FT and it is Ryan's, not a tuning: "i would probably give at
 * least 5 ft offset because i am hand steering."
 */
function contourBands(plan) {
  return (plan.legs || [])
    .filter((l) => l.type === 'troll' && l.depthFt != null && Number.isFinite(Number(l.depthFt)))
    .map((l) => {
      const d = Math.round(Number(l.depthFt));
      return { legId: l.id, depthFt: d,
               shallow: d - HAND_STEER_BAND_FT, deep: d + HAND_STEER_BAND_FT };
    });
}

/** The day's speeds as a range. There is no plan-level trolling speed -- each leg has its own. */
function speedRange(plan) {
  const v = (plan.legs || []).filter((l) => l.type === 'troll')
    .map((l) => Number(l.speedMph)).filter((n) => Number.isFinite(n) && n > 0);
  if (!v.length) return '';
  const lo = Math.min(...v), hi = Math.max(...v);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}

export function collectPlan(){
  function gV(id, fb = '') { const el = document.getElementById(id); return el ? el.value : fb; }
  // AND IT MUST BE THIS DAY'S PLAN.
  //
  // `window._planV2` is a global that any surface can leave behind, and for months only one
  // surface set it. A stale plan here is not a cosmetic mismatch: budget, legs, warnings and the
  // safety verdict all come from it, so the document says one day and its own timeline says
  // another, with no way for a reader to tell which is real.
  //
  // The tracks in state.DATA are written by materialisePlan for the run being exported and are
  // named `L1 · …` / `T1 · transit`, so their leg ids are the ground truth for what is on screen.
  // If the plan does not describe those legs, it is somebody else's plan and none of its numbers
  // belong in this file.
  const v2raw = planV2();
  const v2 = (() => {
    if (!v2raw || !Array.isArray(v2raw.legs)) return null;
    const onScreen = new Set((state.DATA.tracks || [])
      .map((t) => String(t.name || '').split('·')[0].trim()).filter(Boolean));
    if (!onScreen.size) return v2raw;           // nothing drawn to check against
    const planned = new Set(v2raw.legs.map((l) => l.id));
    const shared = [...onScreen].filter((id) => planned.has(id)).length;
    if (shared === onScreen.size) return v2raw;
    console.warn('[plan-builder] _planV2 describes legs '
      + `[${[...planned].join(', ')}] but the day on screen is [${[...onScreen].join(', ')}] — `
      + 'omitting the plan block rather than exporting another day\'s numbers.');
    return null;
  })();
  const species = [...document.querySelectorAll('#planSpeciesChecks input:checked')].map(c=>c.value);
  const lakeVal = gV('planLake');
  const isRiv = isPlanRiverValue(lakeVal);
  const coastalKey = planWaterKey(lakeVal);
  const isCoastal = isCoastalKey(coastalKey);
  const phaseSpeeds = normalizedPhaseSpeeds(window._smartPlanPhaseRoutes);

  // ── Unified Timeline capture (single source of truth) ────────────────────
  // window._smartPlanTimeline is built by smart-plan-ui.js buildUnifiedTimeline()
  // It already interleaves troll passes and stop-and-cast stops in chronological order.
  let unifiedTimeline = null;
  try {
    if (Array.isArray(window._smartPlanTimeline) && window._smartPlanTimeline.length) {
      // Deep clone for JSON but preserve key fields for bait recommendations and positioning notes
      unifiedTimeline = window._smartPlanTimeline.map(e => {
        if (e.type === 'troll') {
          return {
            step: e.step,
            type: e.type,
            key: e.key,
            // THE SPINE, EXPORTED. Every derived entry carries `atM` and `legId`; without them
            // the phone cannot answer "what is next" from a GPS position and the exported plan
            // is a list of times that are wrong by 09:00. `step` numbers legs and only legs.
            legId: e.legId ?? e.key,
            legType: e.legType || 'troll',
            // The run home is a transit with a name. Without this the printed report calls it
            // TRANSIT and the map has nothing to colour it by.
            role: e.role || null,
            atM: e.atM ?? null,
            startM: e.startM ?? null,
            lengthM: e.lengthM ?? null,
            endM: e.endM ?? null,
            stopIds: Array.isArray(e.stopIds) ? e.stopIds.slice() : [],
            estDurationMin: e.estDurationMin ?? null,
            estStartTime: e.estStartTime ?? null,
            label: e.label,
            shortLabel: e.shortLabel,
            icon: e.icon,
            color: e.color,
            desc: e.desc,
            speedMph: e.speedMph,
            depthMin: e.depthMin,
            depthMax: e.depthMax,
            port: e.port,
            starboard: e.starboard,
            portColor: e.portColor,
            starboardColor: e.starboardColor,
            portLeadFt: e.portLeadFt,
            starboardLeadFt: e.starboardLeadFt,
            why: e.why,
            phaseName: e.phaseName,
            pass: e.pass, ofPasses: e.ofPasses,
            // Whether tap-and-reel-up is the right move on this leg. See bottomNote() in
            // plan-to-timeline.js — it is the thing his own technique cannot tell him.
            bottomNote: e.bottomNote,
            stats: e.stats,
            // rods hold full spread info for this pass
            rods: (e.rods||[]).map(r=>({
              side: r.side,
              lure: r.lure,
              color: r.color,
              depth: r.depth,
              lead: r.lead,
              reel: r.reel,
              rod: r.rod,
              trailerSize: r.trailerSize,
              arigWeight: r.arigWeight,
              jigWeight: r.jigWeight,
              // How this bait sits against the bottom he will feel. Carried rather than
              // recomputed: the report and the on-screen card must not be able to disagree.
              clearance: r.clearance,
              notes: r.notes,
            })),
          };
        } else if (e.type === 'change') {
          // A lure change is an event with a cost, at a distance. It was built by the assembler
          // and dropped at the timeline boundary, so a day with three swaps exported as a day
          // with none.
          return {
            type: e.type,
            id: e.id,
            legId: e.legId ?? null,
            atM: e.atM ?? null,
            mark: e.mark || null,
            rodId: e.rodId,
            cost: e.cost,
            costLabel: e.costLabel || null,
            from: e.from,
            to: e.to,
            why: e.why,
          };
        } else {
          // stop_and_cast — a pause INSIDE a leg, so it carries `parentLegId` and no step of its
          // own. It keeps the assembler's S<leg>.<n> identity rather than being renumbered into
          // the leg sequence.
          return {
            type: e.type,
            subType: e.subType,
            id: e.id,
            legId: e.legId ?? null,
            parentLegId: e.parentLegId ?? null,
            atM: e.atM ?? null,
            atLegM: e.atLegM ?? null,
            mark: e.mark || null,
            estDurationMin: e.estDurationMin ?? null,
            name: e.name,
            targetStructure: e.targetStructure,
            targetDepth: e.targetDepth,
            presentation: e.presentation,
            recommendedLures: Array.isArray(e.recommendedLures) ? e.recommendedLures.slice() : [],
            tacticalNote: e.tacticalNote,
            positioning: e.positioning || e.tacticalNote,
            lat: e.lat,
            lon: e.lon,
            routeContext: e.routeContext || null,
            score: e.score,
            reason: e.reason,
            typeDetail: e.typeDetail,
          };
        }
      });
    }
  } catch (err) {
    console.warn('[plan-builder] unifiedTimeline capture failed', err.message);
  }

  // Fallback for older plans or when timeline not yet built — use raw Groq timeline if available
  if (!unifiedTimeline) {
    try {
      const raw = window._smartPlanTimeline || window._smartPlanRouteRods ? null : null;
      // try to pull from last groq plan if stored elsewhere
      if (window._groqPlanTimeline && Array.isArray(window._groqPlanTimeline)) {
        unifiedTimeline = window._groqPlanTimeline;
      }
    } catch (_) {
      // Audited 2026-08-04 -- reading optional window globals another module may never have
      // set. There is nothing to report: no timeline is a normal state, and the caller
      // already handles it.
    }
  }

  // Capture stop candidates with positioning and bait recs as separate field for backward compat
  // New: always include timeline stop_and_cast entries, even if geographic candidates are empty.
  let castingStops = [];
  try {
    const fromTimeline = [];
    if (Array.isArray(unifiedTimeline)) {
      for (const e of unifiedTimeline) {
        if (e.type === 'stop_and_cast' || e.type === 'stop' || e.type === 'cast') {
          fromTimeline.push({
            name: e.name,
            type: e.type,
            subType: e.subType || null,
            lat: e.lat ?? null,
            lon: e.lon ?? null,
            targetStructure: e.targetStructure || null,
            targetDepth: e.targetDepth ?? null,
            presentation: e.presentation || null,
            score: e.score ?? null,
            reason: e.reason || e.tacticalNote || '',
            structureType: e.targetStructure || e.typeDetail || null,
            routeContext: e.routeContext || null,
            recommendedLures: Array.isArray(e.recommendedLures) ? e.recommendedLures.slice() : [],
            tacticalNote: e.tacticalNote || e.positioning || e.reason || '',
          });
        }
      }
    }
    const src = window._smartPlanStopCandidates || [];
    const fromCandidates = src.map(s=>({
      name: s.name,
      type: s.type,
      lat: s.lat,
      lon: s.lon,
      targetStructure: s.structureType || s.targetStructure || null,
      targetDepth: s.targetDepth ?? null,
      presentation: s.presentation || null,
      score: s.score,
      reason: s.reason,
      structureType: s.structureType,
      routeContext: s.routeContext || null,
      recommendedLures: s.recommendedLures || [],
      tacticalNote: s.tacticalNote || s.reason || '',
    }));
    // Merge, prefer timeline entries (they have full presentation data), dedup by name+lat/lon
    const seen = new Map();
    const merged = [...fromTimeline, ...fromCandidates];
    for (const s of merged) {
      const key = `${(s.name||'').toLowerCase()}|${s.lat ?? ''}|${s.lon ?? ''}`;
      if (!seen.has(key)) seen.set(key, s);
    }
    castingStops = [...seen.values()];
  } catch (err) {
    // Not optional data: this is the merged casting-stop list the plan is built from, and an
    // empty one silently produces a plan with no stops in it.
    console.warn('[plan-builder] could not assemble casting stops:', err);
  }

  // Route rods capture per key
  let routeRodsCapture = null;
  try {
    if (window._smartPlanRouteRods) {
      routeRodsCapture = {};
      for (const k of Object.keys(window._smartPlanRouteRods)) {
        routeRodsCapture[k] = (window._smartPlanRouteRods[k]||[]).map(r=>({
          side: r.side,
          lure: r.lure,
          color: r.color,
          depth: r.depth,
          lead: r.lead,
          reel: r.reel,
          rod: r.rod,
          trailerSize: r.trailerSize,
          arigWeight: r.arigWeight,
          jigWeight: r.jigWeight,
        }));
      }
    }
  } catch (err) {
    // Same reasoning as the casting stops above -- the plan still renders, just without the
    // rod setup the user configured, which looks like the app forgot it.
    console.warn('[plan-builder] could not capture route rods:', err);
  }

  return {
    meta:{
      name: gV('planName', 'Fishing Plan'),
      date: gV('planDate'),
      lake: lakeVal,
      waterbodyType: isRiv ? 'river' : (isCoastal ? 'coastal' : 'lake'),
      waterbodyLabel: isRiv ? (getPlanRiverDef(lakeVal)?.label || lakeVal) : lakeVal,
      ramp: gV('planRamp'),
      riverSummary: gV('planRiverSummary'),
      riverSafety: gV('planRiverSafety'),
      riverFlow: gV('planRiverFlow'),
      riverGauge: gV('planRiverGauge'),
      riverTemp: gV('planRiverTemp'),
      riverRise: gV('planRiverRise'),
      riverSurgeEta: gV('planRiverSurgeEta'),
      riverSchedule: gV('planRiverSchedule'),
      launchTime: gV('planLaunchTime', '06:00'),
      returnTime: gV('planReturnTime', '12:00'),
      waterTemp: gV('planWaterTemp'),
      fullPool: (isRiv || isCoastal) ? '' : gV('planFullPool'),
      poolLevel: (isRiv || isCoastal) ? '' : gV('planPoolLevel'),
      // THE DRAWDOWN IS ITS OWN NUMBER, not `poolLevel - fullPool`. Brookfield's Chilhowee and
      // Calderwood publish feet-below-full-pool and no absolute elevation at all, so a
      // subtraction returns nothing on exactly the lakes that stated the answer outright.
      belowFullPool: (isRiv || isCoastal) ? '' : gV('planBelowFullPool'),
      // FEET, ALWAYS. This was `getPlanLakeLevelUnit()`, which returned "% full pond" for nine
      // hardcoded Duke names and "ft" for everything else -- so the trip decision, the level
      // row and the stage line all carried a units branch, and two lakes could not be compared.
      // The percent was never a measurement: Duke hangs a hundred-foot band under full pond, so
      // 98.00 IS two feet down, and normalizeDukeRow converts it in the Worker.
      poolUnit: (isRiv || isCoastal) ? '' : 'ft',
      weather: gV('planWeather'),
      clarity: gV('planClarity', 'Clear'),
      motor: gV('planMotor', 'NK180 Pro 24V, 100Ah LiFePO4'),
      sonar: gV('planSonar', 'Garmin ECHOMAP UHD2 93sv'),
      // The HTML renders a full solunar table while meta.solunar exported as an empty string,
      // which is the same contract violation as the depths: the document computing what the plan
      // already knows. conditions.solunar is on the plan; use it when the form is empty.
      solunar: gV('planSolunar') || (v2 && v2.conditions && v2.conditions.solunar
        ? `Majors ${(v2.conditions.solunar.majors || []).join(', ')} · `
          + `Minors ${(v2.conditions.solunar.minors || []).join(', ')}` : ''),
      structure: gV('planStructure'),
      lakeIntel: gV('planLakeIntel'),
      clarityIntel: gV('planClarityIntel'),
      species,
    },
    trolling:{
      // ONE DEPTH, AND IT IS THE CONTOUR THE LEGS FOLLOW. `targetDepth` used to come from a
      // hidden input only v1 wrote, so on the v2 path it was empty and the HTML printed
      // literals. The species band is a different fact and is exported under its own name --
      // it is what the fish are using, not what the boat is following.
      speed: speedRange(v2 || {}) || gV('planSpeed', '2.4'),
      phaseSpeeds,
      targetDepth: contourRange(v2 || {}) || gV('planTargetDepth'),
      bands: contourBands(v2 || {}),
      speciesBandFt: (v2 && v2.conditions && v2.conditions.depthBand
                      && v2.conditions.depthBand.ft) || null,
      legSpeeds: v2 ? (v2.legs || []).map((l) => ({ legId: l.id, type: l.type, speedMph: l.speedMph })) : null,
      pattern: gV('planPattern', 'Straight lanes'),
    },
    spread: (state.SPREAD || []).slice(),
    tackle: gV('planTackle'),
    safety: gV('planSafety'),
    notes: gV('planNotes'),
    rationale: window._smartPlanRationale || document.getElementById('planSmartPlanOutput')?.value || '',
    // ── Unified timeline (single chronological source) ────────────────────
    // This is the new canonical field per refactor brief: captures full
    // trip order including trolling spreads/leads/speeds and stop-and-cast
    // structure/depth/baits/positioning notes, no duplicate rendering.
    timeline: unifiedTimeline,
    unifiedTimeline: unifiedTimeline, // alias for forward compatibility
    castingStops,
    castRods: window._smartPlanCastRods || [],
    routeRods: routeRodsCapture,
    routeSpeeds: window._smartPlanRouteSpeeds || null,
    // THE PLAN, AS THE SCHEMA DEFINES IT. Everything above is the form's view of the day;
    // this is the plan's own. budget, conditions, meta, safety and warnings had no route into
    // any export at all -- the budget reached the screen as a status one-liner and nothing else,
    // and every warning the assembler produced died at the boundary. `coordinates` are left off
    // the legs on purpose: the geometry ships as tracks in the GPX, and duplicating it here
    // would be a second copy to fall out of sync with.
    plan: v2 ? {
      planVersion: v2.planVersion,
      meta: v2.meta,
      conditions: v2.conditions,
      budget: v2.budget,
      safety: v2.safety,
      warnings: Array.isArray(v2.warnings) ? v2.warnings.slice() : [],
      legs: (v2.legs || []).map((l) => ({
        id: l.id, type: l.type, runId: l.runId ?? null,
        // `role: 'return'` is a label on a transit, not a leg type. Carried so the report can say
        // "back to the ramp" instead of printing the way home as an anonymous deadhead.
        role: l.role ?? undefined,
        startM: l.startM, lengthM: l.lengthM,
        depthFt: l.depthFt ?? null, speedMph: l.speedMph,
        batteryAh: l.batteryAh, estDurationMin: l.estDurationMin, estStartTime: l.estStartTime ?? null,
        unrouted: l.unrouted === true ? true : undefined,
        // WHICH TIME OVER THIS WATER THIS IS. Without it the saved plan shows the same runId on
        // two legs and nothing on the file says why — which is exactly the shape of a bug, and
        // this is the file Ryan exports and reads back.
        pass: l.pass ?? undefined, ofPasses: l.ofPasses ?? undefined,
        stopIds: (l.stops || []).map((x) => x.id),
      })),
      changes: (v2.changes || []).slice(),
    } : null,
    // The one caveat every amp-hour figure in this document needs, carried WITH the figures.
    batteryCurve: v2 ? 'amps(mph) = 5.0 * (mph/2.0)**1.756 — a two-point fit to two observed '
                     + 'readings (3–7 A at 1.8–2.2 mph, 25 A at ~5 mph), not a measurement' : null,
    gpx: {
      waypoints: state.DATA.waypoints.length,
      tracks: state.DATA.tracks.length,
      trackPoints: state.DATA.tracks.reduce((a,t)=>a+t.pts.length,0),
      // Interleaved waypoint list now includes stop-and-cast CAST: waypoints in route order (from smart-plan-ui sorting)
      waypointList: state.DATA.waypoints.map(w=>({
        name:w.name, lat:w.lat, lon:w.lon,
        sym: w.sym || 'Waypoint',
        castingStop: !!w.castingStop,
        depth: w.depth || null,
        structureType: w.structureType || null,
        tacticalNote: w.tacticalNote || null,
      })),
      // THE LINE THE BOAT RUNS, IN THE FILE THAT DESCRIBES THE DAY.
      //
      // `points` was a count and nothing else, so a saved plan could say L5 was 1080 m long and
      // had 52 vertices without saying where any of them were -- nothing about an ordering, an
      // orientation or a deadhead could be measured out of the one file the app hands him.
      //
      // NOT a copy on the legs, which is what it looks like it wants to be. The comment on
      // `plan.legs` above is right and stands: two copies of one geometry in one file is two
      // things to drift. This is not a second copy -- `state.DATA.tracks` is the single source
      // the GPX itself is written from, and `trackList` is already its projection. It was
      // projecting the length of each track and throwing away the track.
      //
      // `pts` is [lat, lon], the way GPX writes it and the way `state.DATA.tracks` holds it --
      // NOT the [lon, lat] the plan uses everywhere else. It is in the `gpx` block, beside the
      // count it belongs to, for exactly that reason.
      trackList: state.DATA.tracks.map(t=>({name:t.name, points:t.pts.length, pts:t.pts}))
    },
    // ── WHAT THE MODEL WAS SENT AND WHAT IT SENT BACK ──────────────────────────────────────────
    //
    // Guarded on identity, not on existence: `_planV2Result` is a global like `_planV2`, and a
    // stale one would attach yesterday's prompt to today's plan -- the same failure the block
    // above rejects a whole plan over. `=== v2raw` is exact and free.
    //
    // `problems` is the union the screen shows -- what the app refused reading the answer, plus
    // the assembler's warnings, plus validatePlan(). `plan.warnings` above is only the middle
    // third, which is why a leg with no rods in the water was in the file and the reason for it
    // was not. Nothing here is a credential or a key: the request is candidate geometry and the
    // day's rules, the response is the model's own JSON.
    model: (() => {
      const r = planV2Result();
      if (!r || !v2 || r.plan !== v2raw) return null;
      return {
        request: r.request || null,
        response: r.response || null,
        // WHAT THE CALL COST AND HOW IT ENDED. Added 2026-09-04 -- modelAsker() used to keep
        // `message.content` and drop finish reason and usage one line before they are needed, so
        // an answer cut off mid-JSON was indistinguishable from an answer that was nonsense.
        exchange: r.exchange || null,
        problems: Array.isArray(r.problems) ? r.problems.slice() : [],
      };
    })(),
    savedAt: new Date().toISOString()
  };
}


function loadPlanIntoForm(p){
  if(!p) return;
  function sV(id, val) { const el = document.getElementById(id); if (el) el.value = val ?? ''; }
  const m=p.meta||{};
  sV('planName', m.name);
  sV('planDate', m.date);
  populatePlanLakeDropdown();
  sV('planLake', m.lake);
  setLakeOnlyFieldsVisible(!isRiverWater(m.lake||''));
  populatePlanRampDropdown(m.lake||'');
  sV('planRamp', m.ramp);
  sV('planSmartPlanOutput', p.rationale);
  sV('planRiverSummary', m.riverSummary);
  sV('planRiverSafety', m.riverSafety);
  sV('planRiverFlow', m.riverFlow);
  sV('planRiverGauge', m.riverGauge);
  sV('planRiverTemp', m.riverTemp);
  sV('planRiverRise', m.riverRise);
  sV('planRiverSurgeEta', m.riverSurgeEta);
  sV('planRiverSchedule', m.riverSchedule);
  sV('planLaunchTime', m.launchTime || '06:00');
  sV('planReturnTime', m.returnTime || '12:00');
  sV('planWaterTemp', m.waterTemp);
  sV('planFullPool', m.fullPool);
  sV('planPoolLevel', m.poolLevel);
  sV('planBelowFullPool', m.belowFullPool);
  sV('planWeather', m.weather);
  if(m.clarity) sV('planClarity', m.clarity);
  sV('planMotor', m.motor || 'NK180 Pro 24V, 100Ah LiFePO4');
  sV('planSonar', m.sonar || 'Garmin ECHOMAP UHD2 93sv');
  sV('planSolunar', m.solunar);
  sV('planStructure', m.structure);
  sV('planLakeIntel', m.lakeIntel);
  sV('planClarityIntel', m.clarityIntel);
  document.querySelectorAll('#planSpeciesChecks input').forEach(c=> c.checked = (m.species||[]).includes(c.value));
  if(p.trolling){
    sV('planSpeed', p.trolling.speed || '2.4');
    if (normalizedPhaseSpeeds(p.trolling.phaseSpeeds).length) {
      // Preserve pass speeds when a saved Smart Plan is loaded and then saved
      // again, even if Smart Plan is not re-run first.
      window._smartPlanPhaseRoutes = normalizedPhaseSpeeds(p.trolling.phaseSpeeds);
    }
    sV('planTargetDepth', p.trolling.targetDepth);
    sV('planPattern', p.trolling.pattern || 'Straight lanes');
  }
  // Robust load using the fixed newRodRow (which now includes rod + trailerSize + arigWeight + jigWeight)
  // This ensures swimbait trailer profile, full A-rig rows, and rod selections persist.
  // FIX (2026-07-03): plans saved while the rod-row default bug was live have
  // rod:'' explicitly stored. Since {...base, ...r} spreads the saved row
  // last, that stored empty string was clobbering the now-restored default
  // right back to blank on every load — old broken saves would stay broken
  // forever even after the underlying bug was fixed. Only let a saved row
  // override rod if it actually has a real (non-empty) value.
  state.SPREAD = (p.spread || []).map(r => {
    const base = newRodRow(r);
    const merged = { ...base, ...r };
    if (!merged.rod && base.rod) merged.rod = base.rod;
    return merged;
  });
  renderSpread();
  const sVBot = (id, v) => { const e = document.getElementById(id); if(e) e.value = v || ''; };
  sVBot('planTackle', p.tackle);
  sVBot('planSafety', p.safety);
  sVBot('planNotes', p.notes);
}

export async function buildPlanPreviewHtml(p){
  function sideClass(s){
    if(s.includes('Port')) return 'rod-side-port';
    if(s.includes('Starboard')) return 'rod-side-starboard';
    return 'rod-side-center';
  }

  // FIX (2026-07-03): was referenced further down as a bare `rationaleHtml`
  // that nothing anywhere declared — a guaranteed ReferenceError on every
  // Preview click, regardless of whether Smart Plan had even been run.
  // Now built from p.rationale (captured in collectPlan() from
  // #planSmartPlanOutput). Matches the <pre> styling already used for the
  // Structure Notes section later in this same template.
  const rationaleHtml = p.rationale
    ? `<pre style="white-space:pre-wrap;font-family:inherit;background:#f7f9fb;padding:10px;border-radius:6px;font-size:13px;border-left:4px solid #0d4f8b">${esc(p.rationale)}</pre>`
    : '';
  const phaseSpeedSummary = formatPhaseSpeeds(p.trolling?.phaseSpeeds, p.trolling?.speed || '2.4');

  // ── Unified timeline preview (single chronological component) ─────────────
  let unifiedPreviewHtml = '';
  const unifiedSrc = p.timeline || p.unifiedTimeline || null;
  if (Array.isArray(unifiedSrc) && unifiedSrc.length) {
    const rows = unifiedSrc.map((e, i) => {
      if (e.type === 'troll') {
        const icon = e.icon || (e.key?.includes('Ph1 Out') ? '🌅' : e.key?.includes('Ph1 In') ? '↩️' : e.key?.includes('Ph2 Out') ? '☀️' : '🏠');
        const label = e.label || e.key || `Troll ${i+1}`;
        const speed = e.speedMph ? `${e.speedMph} mph` : (p.trolling?.speed||'') + ' mph';
        const depth = e.depthMin != null && e.depthMax != null
          ? (e.depthMin === e.depthMax ? `${e.depthMin}ft` : `${e.depthMin}–${e.depthMax}ft`)
          : (e.depthMin ? `${e.depthMin}ft` : '');
        // A TRANSIT HAS NO SPREAD, SO IT PRINTS NONE. Same fix as the on-screen card: the
        // deadhead row was printing a depth column and a rod column it has nothing to put in,
        // under the word TROLL. Distance, speed and time is the whole of a transit.
        if (e.legType === 'transit') {
          const dist = e.stats?.distMi != null ? `${esc(String(e.stats.distMi))} mi` : '';
          const est = e.estDurationMin != null ? `est ${esc(String(e.estDurationMin))} min` : '';
          const kind = e.role === 'return' ? 'RETURN' : 'TRANSIT';
          return `<tr style="background:#f2f4f6"><td><b>${icon} ${kind} — ${esc(label)}</b>`
               + `<br><span class="rp-small">${esc(e.desc||'')}</span></td>`
               + `<td>${esc(speed)}<br><span class="rp-small">${dist}</span></td>`
               + `<td class="rp-small">Nothing in the water</td>`
               + `<td class="rp-small">${est}${e.why ? `<br>${esc(e.why)}` : ''}</td></tr>`;
        }
        // THE HEAD RIDES WITH THE LEAD. `@ 63ft` on a jighead swimbait is half an instruction --
        // the weight is what decides the depth that 63 ft of lead buys, and this row printed the
        // lead alone while the plan had carried the weight all along. See leadWithHead() in
        // smart-plan-ui.js, same fix, the other surface.
        // WHERE IT RUNS AND HOW THAT SITS AGAINST THE BOTTOM, not feet of line.
        //
        // Ryan cannot set a lead -- "i don't have a ruler... there is literally no way for me to
        // answer these questions" -- and finds depth by feel instead: "let out a bunch of line if
        // the rod tips starts bouncing it is tapping bottom... reel up". So the row says the two
        // things he can act on, and the feet stay inside the app where capBaitDepth() uses them.
        const rods = (e.rods||[]).map(r=> {
          const gap = r.clearance ? (r.clearance.taps ? ' · taps bottom' : ` · ${r.clearance.gap} ft up`) : '';
          return `${esc(r.side||'')}: ${esc(r.lure||'')}${r.jigWeight?` ${esc(r.jigWeight)}`:''}`
               + `${r.depth?` — runs ${esc(String(r.depth))} ft`:''}${esc(gap)}`;
        }).join('<br>');
        return `<tr style="background:#eef7ff"><td><b>${icon} TROLL — ${esc(label)}</b><br><span class="rp-small">${esc(e.desc||e.phaseName||'')}</span></td><td>${esc(speed)}<br>${esc(depth)}</td><td class="rp-small">${rods || `${esc(e.port||'')} / ${esc(e.starboard||'')}`}${e.bottomNote?`<br><i>${esc(e.bottomNote)}</i>`:''}</td><td class="rp-small">${esc(e.why||'')}</td></tr>`;
      } else if (e.type === 'change') {
        return `<tr style="background:#fffde7"><td><b>🔁 SWAP — ${esc(String(e.rodId||''))}</b><br><span class="rp-small">${esc(e.mark||'')} in</span></td><td colspan="2">${esc(e.from||'—')} → <b>${esc(e.to||'')}</b><br><span class="rp-small">${esc(e.costLabel||e.cost||'')}</span></td><td class="rp-small">${esc(e.why||'')}</td></tr>`;
      } else {
        const lures = (e.recommendedLures||[]).map(l=> {
          const name = l.name || l.lure || l;
          const conf = l.confidence ? ` (${esc(l.confidence)})` : '';
          return `${esc(String(name))}${conf}`;
        }).join(', ');
        const coord = e.lat != null ? `${Number(e.lat).toFixed(4)}, ${Number(e.lon).toFixed(4)}` : 'No GPS';
        return `<tr style="background:#fff8e1"><td><b>🎯 STOP & CAST — ${esc(e.name||'Structure')}</b><br><span class="rp-small">${esc(e.targetStructure||'')} · ${esc(String(e.targetDepth||''))}ft · ${esc(coord)}</span></td><td colspan="2"><b>Presentation:</b> ${esc(e.presentation||'')}<br><b>Casting Baits:</b> ${esc(lures)||'—'}<br><b style="color:#b06a00">Positioning:</b> ${esc(e.tacticalNote||e.positioning||'')}</td><td class="rp-small">${esc(e.reason||'')}${e.routeContext ? `<br>${esc(e.routeContext.trackName)}${e.routeContext.mark ? ` · ${esc(e.routeContext.mark)} in` : ''}` : ''}</td></tr>`;
      }
    }).join('');
    unifiedPreviewHtml = `
    <h2>🧭 Unified Trip Timeline — Interleaved Trolling & Stop-and-Cast (Chronological)</h2>
    <p class="rp-small">Single source of truth — trolling passes and casting stops in the order you will encounter them on the water. No duplicate blocks.</p>
    <table><thead><tr style="background:#eef4fa"><th>Step</th><th>Speed / Depth</th><th>Spread / Baits / Leads / Positioning</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ── Cast Rods Pre-Rig ─────────────────────────────────────────────────────
  let castRodsHtml = '';
  const castRods = p.castRods || [];
  if (castRods.length) {
    const rows = castRods.map(r => `<tr>
      <td><b>Cast Rod ${esc(String(r.rod||''))}</b></td>
      <td>${esc(r.lure||'—')}</td>
      <td>${esc(r.rigging||'—')}${r.jigheadWeight ? ` · <b>${esc(r.jigheadWeight)} jighead</b>` : ''}</td>
      <td>${esc(r.presentation||'—')}</td>
    </tr>`).join('');
    // The TROLLING rods belong here too. Ryan, 2026-08-09: "i was expecting the troll rod callout
    // to be in the pre-rig before launch section not just in the trolling section... just know
    // that those 2 crankbaits are part of the 4 with fluro leader... it doesn't say that anywhere
    // in the plan."
    //
    // This section answers ONE question -- what do I tie on before I leave the truck -- and it was
    // only answering it for half the boat. The trolling rods appeared solely in the spread table
    // further down, which is a reference for what is in the water, not a rigging list. And nothing
    // anywhere stated which rods carry a leader and which carry a snap.
    //
    // THE BOAT IS SIX RODS AND NEVER CHANGES: four on a 20 lb fluoro leader, two on swivel snaps.
    // Two rods are in the water while trolling, one port and one starboard.
    const trollByRod = new Map();
    for (const r of (p.spread || [])) {
      const id = String(r.rod || '').trim();
      if (!id || trollByRod.has(id)) continue;      // same rod repeats once per leg
      trollByRod.set(id, r);
    }
    const trollRows = [...trollByRod.values()].map(r => `<tr>
      <td><b>Troll Rod ${esc(String(r.rod||''))}</b> <span class="rp-small">(${esc(r.side||'')})</span></td>
      <td>${esc(r.lure||'—')}${r.color ? ` · ${esc(r.color)}` : ''}</td>
      <td>${esc(r.reel||'—')}</td>
      <td>${r.lead ? `${esc(String(r.lead))} ft lead · ` : ''}${esc(r.depth||'—')} ft</td>
    </tr>`).join('');

    const nCast = castRods.filter(r => r.lure).length;
    castRodsHtml = `
    <h2>🎣 Pre-Rig Before Launch — Every Rod on the Boat</h2>
    <p class="rp-small">Six rods: <b>four on a 20 lb fluoro leader</b>, <b>two on swivel snaps</b>.
      Two are in the water while trolling, one port and one starboard. Tie all of this before you
      leave — ${nCast} casting rod(s) stowed in the cockpit for any Stop &amp; Cast, and the
      trolling rods ready to deploy off the launch.</p>
    <table><thead><tr style="background:#eef4fa"><th>Rod</th><th>Lure</th><th>Rigging / Reel</th><th>Presentation / Lead</th></tr></thead><tbody>${trollRows}${rows}</tbody></table>`;
  }

  // ── Clarity tactical ──────────────────────────────────────────────────────
  const clarity = p.meta.clarity || 'Clear';
  let tacticalText = '';
  if(clarity === 'Clear')
    tacticalText = 'Water is <b>CLEAR</b>. Use natural presentations (Bone, Pearl, Silver/flash). <b>Fluorocarbon leaders are critical</b> — fish will inspect. Fish hold deeper; rely on long line deployments and precise depth.';
  else if(clarity === 'Stained')
    tacticalText = 'Water is <b>STAINED</b>. Use high-contrast colors (Chartreuse, Firetiger, white with UV) and baits with strong vibration. Fluoro still helps but mono/co-poly acceptable.';
  else
    tacticalText = 'Water is <b>MUDDY</b>. Deploy dark silhouettes (Black/Blue, dark shad) with maximum vibration or rattles. Fish tight to cover and shallower ambush points. Line clarity matters less.';

  // ── Colors per lure (driven by clarity) ──────────────────────────────────
  const colorTable = {
    Clear: [
      ['A-Rig (light)',   'Natural Pearl / Smoke',        'Silver Flash / Alewife'],
      ['A-Rig (medium)',  'Blueback Herring / Ghost',     'Tennessee Shad'],
      ['Crankbait',       'Blue/Silver Herring',          'Sexy Shad / Chartreuse'],
      ['Flutter Spoon',   'Shattered Glass Silver',       'Chrome / Gold'],
      ['Swimbait 4.6"',   'Blueback Herring',             'Ghost Shad'],
      ['Topwater',        'Bone / Natural Shad',          'Chrome / White'],
    ],
    Stained: [
      ['A-Rig (light)',   'Chartreuse / White UV',        'Firetiger'],
      ['A-Rig (medium)',  'White/Chartreuse',             'Hot Pink / UV'],
      ['Crankbait',       'Chartreuse Shad',              'Firetiger / Orange'],
      ['Flutter Spoon',   'Chartreuse Gold',              'Hot Pink / Hammered Gold'],
      ['Swimbait 4.6"',   'Chartreuse/White',             'Bubble Gum / Hot Shad'],
      ['Topwater',        'White / Chartreuse Belly',     'Clown / Bright'],
    ],
    Muddy: [
      ['A-Rig (light)',   'Black/Blue',                   'Dark Junebug'],
      ['A-Rig (medium)',  'Dark Shad / Black',            'Oxblood / Purple'],
      ['Crankbait',       'Black/Blue Shad',              'Crawdad / Dark Brown'],
      ['Flutter Spoon',   'Black Nickel / Dark Chrome',   'Copper'],
      ['Swimbait 4.6"',   'Black/Blue Shad',              'Dark Watermelon'],
      ['Topwater',        'Black / Dark',                 'Black Chrome'],
    ],
  };
  const colorRows = (colorTable[clarity]||colorTable.Clear).map(([lure,primary,backup])=>
    `<tr><td><b>${lure}</b></td><td style="color:var(--p-teal)">${primary}</td><td style="color:#888">${backup}</td></tr>`
  ).join('');

  // ── Swimbait sizing / match the hatch ─────────────────────────────────────
  const waterTemp = parseFloat(p.meta.waterTemp)||70;
  let swimHatch = '', swimNote = '';
  if(waterTemp < 55){
    swimHatch = '2.8"–3.5" — Finesse shad, small threadfin profile. Fish lethargic, slow your roll.';
    swimNote  = 'Down-size jigheads to 1/4oz. Slow the troll to 1.8–2.0 mph.';
  } else if(waterTemp < 68){
    swimHatch = '3.8"–4.6" — Juvenile blueback herring, shad. Primary forage window.';
    swimNote  = '3/8–1/2oz jigheads. 2.2–2.5 mph troll. Most productive size range year-round.';
  } else if(waterTemp < 78){
    swimHatch = '4.6"–5.5" — Adult blueback herring, gizzard shad. Fish keyed on larger profile.';
    swimNote  = '1/2–3/4oz jigheads. Match the dominant forage size you see on sonar.';
  } else {
    swimHatch = '5.5"–7" — Jumbo shad, large herring. Dog days — go big or go home.';
    swimNote  = '3/4–1oz jigheads. Fish deep and slow. Early/late bite windows only.';
  }

  // ── A-rig breakdown ───────────────────────────────────────────────────────
  const arigRows = p.spread.filter(r=>r.lure && r.lure.toLowerCase().includes('rig')).map(r=>{
    const isLight = (r.lure||'').toLowerCase().includes('light') || (r.lure||'').includes('1.65');
    const rigFramework = r.arigWeight || (isLight ? '~1.65oz Framework' : '~2.65oz Framework');
    const trailer = r.trailerSize || (isLight ? '3.8" swimbait' : '4.6" swimbait');
    const jigheads = r.jigWeight || (isLight ? '1/8oz × 5 (Uniform)' : '3/16oz × 5 (Uniform)');
    return `<tr>
      <td><b>${esc(r.side)} — ${esc(r.position)}</b></td>
      <td>${esc(rigFramework)}</td>
      <td><b style="color:#00e5ff">${esc(trailer)}</b></td>
      <td><b style="color:#76ff03">${esc(jigheads)}</b></td>
      <td>${esc(r.color||'Natural Pattern')}</td>
      <td><b>${esc(r.depth||'—')} ft</b> @ <b>${esc(r.lead||'—')} ft lead</b></td>
    </tr>`;
  }).join('');

  // ── Battery scenarios (NK180 Pro) ─────────────────────────────────────────
  const motorField = p.meta.motor || '';
  const isNK180 = motorField.toLowerCase().includes('nk180') || motorField.toLowerCase().includes('180');
  const battAh = motorField.match(/(\d+)\s*ah/i) ? parseInt(motorField.match(/(\d+)\s*ah/i)[1]) : 100;
  const usableAh = battAh * 0.8; // Exactly reserve 20% LiFePO4
  let activeLiveBleRow = '';
  if(window.ACTIVE_BLE_BMS && window.ACTIVE_BLE_BMS.connected){
    const ble = window.ACTIVE_BLE_BMS;
    const activeFlight = ble.usableAh > 0 ? (ble.usableAh / Math.max(0.1, ble.current)).toFixed(1) + ' Hours' : 'Mandatory Return Hit';
    activeLiveBleRow = `<tr style="background:#08121e;border-left:4px solid #76ff03">
      <td><b style="color:#76ff03">⚡ Active Live BLE Trolling Load ("${esc(ble.name)}")</b></td>
      <td><b style="font-family:monospace;color:#76ff03;font-size:15px">${ble.current.toFixed(1)}A (${Math.round(ble.voltage * ble.current)}W @ ${ble.voltage.toFixed(1)}V)</b></td>
      <td><b style="color:#00e5ff;font-size:16px">${activeFlight}</b> <span class="rp-small" style="color:#76ff03">(${ble.soc}% Reported SOC Active)</span></td>
    </tr>`;
  }

  const battScenarios = [
    ['Easy (slow finesse troll 1.5–2.0 mph, calm water)',  '3.5A (~84W)',   (usableAh/3.5).toFixed(1) + ' hrs'],
    ['Typical (standard tournament troll 2.2–2.5 mph)',    '7.5A (~180W)',  (usableAh/7.5).toFixed(1) + ' hrs'],
    ['Hard (2.8+ mph, heavy headwind or river current)',   '14.0A (~336W)', (usableAh/14.0).toFixed(1) + ' hrs'],
    ['Sprint / Repositioning (100% full throttle)',        '25.0A (~600W)', (usableAh/25.0).toFixed(1) + ' hrs'],
  ].map(([scenario, draw, time])=>
    `<tr><td><b>${scenario}</b></td><td><b style="font-family:monospace;color:var(--accent)">${draw}</b></td><td style="font-weight:700;color:var(--accent2)">${time} <span class="rp-small" style="color:var(--muted)">(80% Usable Capacity)</span></td></tr>`
  ).join('');

  // ── Sonar settings per lane ───────────────────────────────────────────────
  const sonarUnit = p.meta.sonar || 'Garmin ECHOMAP UHD2 93sv';
  // No literal fallback. A depth this document cannot read off the plan is a depth it does not
  // know, and printing a plausible number for it is how the same document ended up claiming
  // 15–27, 18–28 and 25–35 ft on one morning.
  // WHAT WAS HERE WAS INVENTED, AND IT WAS DELETED ON 2026-08-26.
  //
  // Four hand-written rows told him what frequency, sensitivity and scroll speed to run at
  // "Dawn / Structure scan", "Mid-morning troll lanes", "Locating school" and
  // "On fish / fighting". Not one value came off the plan; the only plan-derived cell was Range.
  // Two of the keys were v1 phase names, which SMARTPLAN_REBUILD_DESIGN abandoned -- "no phase
  // names, no outbound and inbound" -- and test/hand-written-tables.test.js never knew the table
  // existed. Ryan, reading it back: "all of that is made up AI stuff trying to tell me how to set
  // my sonar for each period of the day... and who changes sonar settings while trying to reel in
  // a fish?"
  //
  // What replaces it is derived, per leg, and is a setting the unit actually has. Nothing here is
  // advice -- it is two numbers the plan already knows, in the units the alarm screen asks for.
  const sonarRows = (p.trolling.bands || []).map(({ legId, depthFt, shallow, deep }) =>
    `<tr><td><b>${esc(legId)}</b></td><td>${depthFt} ft</td>`
    + `<td style="font-family:monospace">${shallow} / ${deep}</td>`
    + `<td style="font-family:monospace">${shallow}–${deep} ft</td></tr>`
  ).join('');

  // ── Solunar timing table ──────────────────────────────────────────────────
  let solunarRows = '';
  if(p.meta.solunar){
    // Parse free text like "Major 7:15–9:30 AM, Minor 1:45 PM, New Moon"
    const txt = p.meta.solunar;
    const majorMatch = txt.match(/major[:\s]+([0-9:apm –\-]+)/i);
    const minorMatch = txt.match(/minor[:\s]+([0-9:apm –\-]+)/i);
    const moonMatch  = txt.match(/(new|full|waxing|waning|quarter)\s*moon/i);
    if(majorMatch||minorMatch){
      if(majorMatch) solunarRows += `<tr><td><span class="rp-pill rp-best">MAJOR</span></td><td>${majorMatch[1].trim()}</td><td>Peak feeding — prime troll window. Be on fish.</td></tr>`;
      if(minorMatch) solunarRows += `<tr><td><span class="rp-pill rp-strong">MINOR</span></td><td>${minorMatch[1].trim()}</td><td>Secondary feeding — maintain coverage.</td></tr>`;
      if(moonMatch)  solunarRows += `<tr><td colspan="3" class="rp-small">Moon phase: <b>${moonMatch[0]}</b>${moonMatch[1].toLowerCase()==='new'?' — strongest solunar influence of the month':moonMatch[1].toLowerCase()==='full'?' — strong solunar influence':''}</td></tr>`;
    } else {
      solunarRows = `<tr><td colspan="3">${esc(txt)}</td></tr>`;
    }
  } else {
    solunarRows = `<tr><td colspan="3" class="rp-small">No solunar data entered. Add Major/Minor window times in the Solunar Notes field.</td></tr>`;
  }

  // ── Existing rows ─────────────────────────────────────────────────────────
  const wpRows = (p.gpx?.waypointList||[]).map(w=>`<tr><td>${esc(w.name)}</td><td>${w.lat.toFixed(5)}</td><td>${w.lon.toFixed(5)}</td></tr>`).join('');
  const trkRows = (p.gpx?.trackList||[]).map(t=>`<tr><td>${esc(t.name)}</td><td>${t.points}</td></tr>`).join('');
  const spreadRows = p.spread.map((r,i)=>`
    <tr>
      <td>${i+1}</td>
      <td class="${sideClass(r.side)}">${esc(r.side)}</td>
      <td>${esc(r.position)}</td>
      <td>${esc(r.rod)}</td>
      <td>${esc(r.reel)}</td>
      <td><b>${esc(r.lure)}${r.trailerSize ? ` <span style="color:#00e5ff;font-size:12px;display:block;margin-top:2px">↳ Trailer: ${esc(r.trailerSize)}</span>` : ''}${r.jigWeight ? ` <span style="color:#76ff03;font-size:12px;display:block;margin-top:2px">↳ Heads: ${esc(r.jigWeight)}</span>` : ''}</b></td>
      <td>${esc(r.color)}</td>
      <td><b>${esc(r.depth)}</b></td>
      <td><b style="color:var(--accent)">${esc(r.lead)}</b></td>
      <td>${esc(r.notes)}</td>
    </tr>`).join('');

  const dateStr = p.meta.date ? new Date(p.meta.date+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'}) : '—';

  // ── SCDNR Regulations by lake + species ───────────────────────────────────
  const REGS = {
    'Striped Bass': {
      'Lake Murray, SC':    { season:'Year-round', size:'21" min (Oct–May), no min Jun–Sep', bag:'5/day', note:'Jun–Sep no size limit but 5 fish max' },
      'Lake Wateree, SC':   { season:'Year-round', size:'No minimum size limit', bag:'10 per day combined (stripers/hybrids)', note:'⚠ Valid upstream of Wateree Dam. Wateree River downstream of dam CLOSED summer.' },
      'Wateree River':              { season:'Oct 1–May 31 open, Jun 1–Sep 30 CLOSED', size:'26" min', bag:'3/day', note:'⚠ River below Wateree Dam to Lake Marion CLOSED Jun–Sep. Release all stripers immediately.' },
      'Congaree River (to SC-601)': { season:'Oct 1–May 31 open, Jun 1–Sep 30 CLOSED', size:'26" min', bag:'3/day', note:'⚠ Congaree River corridor CLOSED Jun–Sep per Santee system regs. Release all stripers immediately.' },
      'Lake Marion, SC':    { season:'Oct 1–Jun 15 open, Jun 16–Sep 30 CLOSED', size:'23"–25" slot (one fish >26" allowed)', bag:'3/day', note:'⚠ Santee Cooper slot limit — slot rules strictly enforced' },
      'Lake Moultrie, SC':  { season:'Oct 1–Jun 15 open, Jun 16–Sep 30 CLOSED', size:'23"–25" slot (one fish >26" allowed)', bag:'3/day', note:'⚠ Santee Cooper slot limit — same as Marion' },
      'Lake Monticello, SC':{ season:'Year-round', size:'26" min (Oct–May), no min Jun–Sep', bag:'3/day', note:'Santee-Cooper tributary system rules apply' },
      'Parr Reservoir, SC': { season:'Year-round', size:'26" min', bag:'3/day', note:'Broad River system' },
      'default':            { season:'Year-round', size:'26" min', bag:'3/day', note:'Verify with SCDNR for specific water body' },
    },
    'Largemouth Bass': {
      'default': { season:'Year-round', size:'14" min', bag:'5/day', note:'Applies to Marion, Moultrie, Murray, Wateree, Monticello, Wylie. Must be landed head+tail intact on Marion/Moultrie.' },
    },
    'Catfish': {
      'Lake Marion, SC':   { season:'Year-round', size:'No min channel/blue', bag:'No limit channel/blue; max 1 blue catfish >36" per day', note:'⚠ Blue cat over 36" trophy rules on Marion/Moultrie. Head+tail must be intact.' },
      'Lake Moultrie, SC': { season:'Year-round', size:'No min channel/blue', bag:'No limit channel/blue; max 1 blue catfish >36" per day', note:'⚠ Same blue cat trophy rules as Marion' },
      'default':           { season:'Year-round', size:'No minimum', bag:'No daily limit', note:'Standard SC freshwater catfish rules' },
    },
    'Crappie': {
      'default': { season:'Year-round', size:'No minimum', bag:'No daily limit', note:'No size or bag limit statewide' },
    },
    'Hybrid': {
      'Lake Murray, SC': { season:'Year-round', size:'21" min (Oct–May), no min Jun–Sep', bag:'5/day combined with striped bass', note:'Counts toward combined striper/hybrid limit' },
      'default':         { season:'Year-round', size:'26" min', bag:'3/day combined with striped bass', note:'Counts in combined striper limit' },
    },
  };

  function getRegs(species, lake){
    const sr = REGS[species];
    if(!sr) return null;
    return sr[lake] || sr['default'] || null;
  }

  const speciesSelected = p.meta.species || [];
  const lakeForRegs = p.meta.waterbodyLabel || p.meta.lake || '';

  // ── WHAT YOU MAY KEEP, THEN WHAT TO KNOW ABOUT KEEPING IT ────────────────────────────────
  //
  // Ryan put it exactly there: "probably below the regulations entry in the smartplan output
  // html... hey this is what you can keep... but if you keep them know this about them."
  //
  // The advisory is the state's, per species, and it is NOT a legality question -- nothing here
  // blocks or warns a plan. It is printed and left to the person, which is the whole difference
  // between this and the regulations table above it.
  //
  // A CLEARED WATER PRINTS AS ONE. Twenty of the sixty-two bound waters were sampled and had
  // nothing to warn about; that is an answer, not an absent section.
  const advisoryBlock = (() => {
    const adv = advisoryRows(resolveR2Key(lakeForRegs), speciesSelected);
    if (!adv) return '';
    const kinds = adv.kinds.length ? ` — ${esc(adv.kinds.join(', '))}` : '';
    // THE SOURCE IS THE FILE'S OWN WORDS. Six waters we ship are in both states' books, and the
    // sentence that used to sit here named South Carolina on all of them.
    const src = `<p class="rp-small">Source: ${esc(adv.sources.join('; ')) || 'state fish '
      + 'consumption advisories'}. This is a health advisory about eating fish, not a size or `
      + 'creel limit — it does not make a fish illegal to catch or to keep. Check the state\'s '
      + 'current advisory before keeping fish to eat.</p>';
    if (adv.cleared) {
      return `<h2>🍽️ Eating What You Keep — ${esc(adv.displayName)}</h2>
<div class="rp-callout"><b>No advisory on this water.</b> ${esc(adv.notes.join('; '))} — the state
sampled it and published no consumption limit.</div>
${src}`;
    }
    const rows = adv.rows.map((r) => `<tr${r.doNotEat ? ' style="background:#fff0f0"' : ''}>
  <td>${esc(r.species)}${r.targeted ? ' <b>(on the plan)</b>' : ''}${r.size ? ` <span class="rp-small">${esc(r.size)}</span>` : ''}</td>
  <td>${r.doNotEat ? `<b>${esc(r.advice)}</b>` : esc(r.advice)}</td>
  <td class="rp-small">${esc(r.published_as || '')}${r.corrected ? ' — corrected, see registry' : ''}${
    adv.sources.length > 1 && r.source ? `<br>${esc(r.source.split(',')[0])}` : ''}</td>
</tr>`).join('');
    const targetedDNE = adv.rows.filter((r) => r.doNotEat && r.targeted).map((r) => r.species);
    const warn = targetedDNE.length
      ? `<div class="rp-callout rp-warn" style="border-left-width:6px"><b>🚫 DO NOT EAT — `
        + `${esc(targetedDNE.join(', '))}</b><br>You are planning for `
        + `${targetedDNE.length === 1 ? 'this fish' : 'these fish'} today. Catching and releasing `
        + `${targetedDNE.length === 1 ? 'it' : 'them'} is unaffected; the state's advice is not to `
        + `eat ${targetedDNE.length === 1 ? 'it' : 'them'} at all.</div>`
      : '';
    return `<h2>🍽️ Eating What You Keep — ${esc(adv.displayName)}${kinds}</h2>
${warn}<table>
  <thead><tr style="background:#eef4fa"><th>Species</th><th>State advice</th><th>Published as</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
${src}`;
  })();

  let regsRows = '';
  speciesSelected.forEach(sp=>{
    const r = getRegs(sp, lakeForRegs);
    if(!r) return;
    const isWarning = r.note && r.note.includes('⚠');
    const isClosed = r.season && r.season.includes('CLOSED');
    regsRows += `<tr${isClosed?' style="background:#fff0f0"':''}>
      <td><b>${esc(sp)}</b></td>
      <td>${esc(r.season)}</td>
      <td>${esc(r.size)}</td>
      <td>${esc(r.bag)}</td>
      <td class="rp-small"${isWarning?' style="color:#b3261e;font-weight:700"':''}>${esc(r.note||'')}</td>
    </tr>`;
  });

  // Check if today is a closed season for target species
  let closedWarning = '';
  if(p.meta.date){
    const tripDate = new Date(p.meta.date+'T12:00:00');
    const month = tripDate.getMonth()+1; // 1-12
    const day   = tripDate.getDate();
    speciesSelected.forEach(sp=>{
      const r = getRegs(sp, lakeForRegs);
      if(!r) return;
      // Wateree/Marion/Moultrie striper closed Jun16–Sep30
      if(sp==='Striped Bass'){
        const isSantee  = lakeForRegs.includes('Marion')||lakeForRegs.includes('Moultrie');
        const isWatereeRiver = lakeForRegs==='Wateree River';
        const isOtherClosed = lakeForRegs==='Wateree River' || lakeForRegs==='Congaree River (to SC-601)';
        if(isSantee && (month>6||(month===6&&day>=16)) && month<=9)
          closedWarning += `<div class="rp-callout" style="background:#fff0f0;border-left:5px solid #b3261e"><b>🚫 STRIPED BASS SEASON CLOSED on ${lakeForRegs.split(',')[0]}</b><br>Santee Cooper system closed Jun 16 – Sep 30. Any striped bass caught must be released immediately.</div>`;
        else if(isOtherClosed && month>=6 && month<=9)
          closedWarning += `<div class="rp-callout" style="background:#fff0f0;border-left:5px solid #b3261e"><b>🚫 STRIPED BASS SEASON CLOSED on ${lakeForRegs.split(',')[0]}</b><br>Wateree River below dam closed Jun 1 – Sep 30. Release all stripers immediately.</div>`;
      }
    });
  }

  let twilightHtml = "";
  // ── GO / NO-GO decision ──────────────────────────────────────────────────
  let goNoGo = 'UNKNOWN', goClass = 'rp-info', goReasons = [], noGoReasons = [];
  // We'll populate this from weather data after fetch — placeholder for now
  // (populated below after weather fetch section)

  // ── Lane telemetry, one row per leg of the plan ───────────────────────────
  // Reads p.plan.legs. No tracks are walked and no speed is guessed -- see laneTelemetry().
  const trollTimes = laneTelemetry(p.plan);
  let trollTimeRows = '';
  if(trollTimes && trollTimes.length){
    trollTimeRows = trollTimes.map(t=>`<tr${t.transit?' style="color:#666"':''}><td><b>${esc(t.id)}</b></td><td>${esc(t.kind)}</td><td>${t.distMi} mi</td><td>${esc(t.speedMph)} mph</td><td><b>${t.mins} min</b></td><td>${t.batteryAh} Ah</td></tr>`).join('');
    // The day's own totals, off the budget the assembler wrote -- not a sum of the rows above,
    // so a row that disagrees with the budget shows up as the disagreement it is.
    const b = p.plan && p.plan.budget;
    if (b && Number.isFinite(Number(b.totalM))) {
      trollTimeRows += `<tr style="border-top:2px solid var(--accent);font-weight:700">`
        + `<td colspan="2">Whole day — ${(Number(b.fishingM||0)/1609.34).toFixed(2)} mi fishing, `
        + `${(Number(b.transitM||0)/1609.34).toFixed(2)} mi getting there</td>`
        + `<td>${(Number(b.totalM)/1609.34).toFixed(2)} mi</td><td>—</td>`
        + `<td>${Number.isFinite(Number(b.estPlannedMin))?Math.round(Number(b.estPlannedMin)):'—'} min</td>`
        + `<td>${Number.isFinite(Number(b.plannedAh))?Number(b.plannedAh).toFixed(2):'—'} Ah</td></tr>`;
    }
  }


  let weatherHtml = 'Weather data not available.';
  let sunriseStr = '--:--', sunsetStr = '--:--', moonriseStr = '--:--', moonsetStr = '--:--';
  let pressureHtml = '', windHtml = '', uvHtml = '', solunarAutoRows = '';
  let moonPhase = '', moonIllum = 0;
  let damHtml = '', tidesHtml = '', usgsHtml = '';
  let reportsHtml = '';

  // ── WHAT WAS ASKED, WHAT CAME BACK, AND WHERE THE APP OVERRULED IT ────────────────────────
  //
  // Ryan, THE_RESEARCH_TAB_BECOMES_THE_SMART_PLAN_INPUT_VIEWER_2026-09-02.md: "i want to see the
  // full response from the LLM i want to know what it suggested that the app changed because of
  // x,y,z i want that lake intel page on the html to disappear and be replaced with actual
  // information for the plan".
  //
  // THE BRIEFING WAS AN INPUT WEARING AN OUTPUT'S CLOTHES. `lake-intel.js` assembles it from the
  // researched profile, so the printable plan -- the one document whose whole job is to say what
  // the plan DECIDED -- was spending its best callout restating the research. That question now
  // belongs to the research tab. This takes its slot.
  //
  // The 42 override points were already written and already worded as the pair, 25 in
  // plan-assemble.js and 17 in plan-prompt.js: "asked for 12 mph -- outside", "dropped a stop on
  // R3: no structure on that leg", "a jerkbait is a CAST-ONLY bait. It planes at". They reached
  // plan.warnings, folded into `problems`, and rendered ONLY into the tab. plan-issues.js says
  // why that is a defect and the sentence applies here word for word: "A refusal is not a smaller
  // kind of error than a failure. It is the plan saying it is not the plan you asked for."
  //
  // THE RESPONSE IS SHOWN, THE REQUEST IS NOT. The request is candidate geometry -- tens of
  // thousands of characters of coordinates -- and printing it helps nobody standing on a ramp.
  // Both are already saved whole in the plan JSON, which is the half of "the plan html and json
  // are what comes out" that is allowed to be exhaustive.
  let exchangeHtml = '';
  {
    const model = (p.model || {});
    const { list, noGo, safety } = planIssues(p.plan, model.problems || []);
    if (noGo) {
      exchangeHtml += `<div class="rp-callout rp-warn" style="border-left-width:6px">`
        + `<b>🚨 NO-GO — DO NOT LAUNCH</b>`
        + (safety.warning ? `<br>${esc(safety.warning)}` : '')
        + `<br><span style="font-size:11px">The plan below is what the day would have been. `
        + `It is not a recommendation to go.</span></div>`;
    }
    if (list.length) {
      exchangeHtml += `<div class="rp-callout rp-warn"><b>⚠ ${list.length} thing`
        + `${list.length === 1 ? '' : 's'} the plan wants to tell you</b>`
        + `<ul style="margin:6px 0 0;padding-left:18px">`
        + list.map((w) => `<li>${esc(w)}</li>`).join('')
        + `</ul></div>`;
    }
    const answer = typeof model.response === 'string'
      ? model.response
      : (model.response ? JSON.stringify(model.response, null, 1) : '');
    if (answer) {
      // Capped because a plan is printed. The uncut copy is in the JSON beside the request.
      const CAP = 6000;
      const shown = answer.length > CAP ? answer.slice(0, CAP) : answer;
      // The line that says WHICH model answered and whether it was allowed to finish. A plan you
      // can argue with is one that names its source; `finish_reason: length` is the difference
      // between a bad answer and an answer we cut off.
      const x = model.exchange || {};
      const bits = [];
      if (x.provider || x.model) bits.push(esc([x.provider, x.model].filter(Boolean).join(' · ')));
      if (x.finishReason) {
        bits.push(x.finishReason === 'stop'
          ? 'finished'
          : `<b style="color:#b3261e">cut off — finish_reason=${esc(x.finishReason)}</b>`);
      }
      if (x.completionTokens) {
        bits.push(`${x.completionTokens.toLocaleString()} of ${(x.maxTokens || 0).toLocaleString()} tokens out`);
      }
      if (x.temperature != null) bits.push(`temp ${x.temperature}`);
      exchangeHtml += `<div class="rp-callout rp-info"><b>🤖 What the model answered</b>`
        + (bits.length ? `<div style="font-size:11px;color:#555;margin:4px 0 0">${bits.join(' · ')}</div>` : '')
        + `<div style="font-size:11px;color:#555;margin:4px 0 6px">`
        + `${answer.length.toLocaleString()} characters`
        + (answer.length > CAP ? `, first ${CAP.toLocaleString()} shown` : '')
        + `. The prompt it was sent is in the saved plan JSON, with this answer in full.</div>`
        + `<pre style="white-space:pre-wrap;word-break:break-word;font-size:10px;line-height:1.4;`
        + `margin:0;max-height:520px;overflow:auto">${esc(shown)}</pre></div>`;
    } else if (p.meta && p.meta.lakeIntel) {
      // A plan saved before the exchange was recorded still has something to say. Its briefing is
      // shown once, labelled as the older shape, rather than silently vanishing from a reprint.
      exchangeHtml += `<div class="rp-callout rp-info"><b>🧠 Lake Intelligence Briefing</b>`
        + `<div style="font-size:11px;color:#555;margin:4px 0 6px">Saved before this plan `
        + `recorded the model exchange.</div>`
        + `${esc(p.meta.lakeIntel).replace(/\n/g, '<br>')}</div>`;
    }
  }
  const lake = p.meta.waterbodyLabel || p.meta.lake || '';
  const cleanLake = lake.split(',')[0].trim();
  // Substring-matched against LAKE_DB's keys before this. `cleanLake.includes(k)` matches on
  // any shared fragment, so a short key could claim an unrelated lake; one resolver, exact.
  const lakeEntry = lakeDbEntryFor(lake) || lakeDbEntryFor(cleanLake);

  if(lakeEntry && p.meta.date){
    const lat = lakeEntry.center[0], lon = lakeEntry.center[1];
    const date = p.meta.date;

    // Helper: format 24hr time string to 12hr
    function fmt12(t){ if(!t) return '--'; const [h,m]=t.split(':').map(Number); const ap=h>=12?'PM':'AM'; return `${h%12||12}:${String(m).padStart(2,'0')} ${ap}`; }

    // Compass direction from degrees
    function windDir(deg){ const dirs=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']; return dirs[Math.round(deg/22.5)%16]; }
    function weatherCodeText(code){
      code = Number(code);
      const map = {
        0:'Sunny / clear', 1:'Mostly sunny', 2:'Partly cloudy', 3:'Cloudy / overcast',
        45:'Foggy', 48:'Freezing fog',
        51:'Light drizzle', 53:'Drizzle', 55:'Heavy drizzle',
        56:'Freezing drizzle', 57:'Freezing drizzle',
        61:'Light rain', 63:'Rain', 65:'Heavy rain',
        66:'Freezing rain', 67:'Freezing rain',
        71:'Light snow', 73:'Snow', 75:'Heavy snow', 77:'Snow grains',
        80:'Light showers', 81:'Rain showers', 82:'Heavy showers',
        85:'Snow showers', 86:'Heavy snow showers',
        95:'Thunderstorms', 96:'Thunderstorms with hail', 99:'Severe thunderstorms with hail'
      };
      return map[code] || 'Forecast condition unavailable';
    }

    // calcSolunar() was defined inline here. It has moved to utils/solunar.js unchanged --
    // a two-year date-by-date diff in that file's header shows zero divergence -- because
    // smart-plan.js had a SECOND, cruder implementation that disagreed with it by up to
    // eleven hours, and only one of the two reached the bite alerts.
    const sol = solunarFor(date, lat, lon);
    moonPhase = sol.phaseName; moonIllum = sol.illum;
    // Expose solunar times for notifications module
    window._trollmapSolunar = { major1: sol.major1, major2: sol.major2, minor1: sol.minor1, minor2: sol.minor2 };
    if (window.trollmapLoadSolunarNotifications) window.trollmapLoadSolunarNotifications(sol);
    solunarAutoRows = `
      <tr><td><span class="rp-pill ${sol.ratingClass}">MAJOR</span></td><td>${sol.major1Str} &amp; ${sol.major2Str}</td><td>Peak feeding — be on fish. Plan troll to hit structure during this window.</td></tr>
      <tr><td><span class="rp-pill rp-strong">MINOR</span></td><td>${sol.minor1Str} &amp; ${sol.minor2Str}</td><td>Secondary feeding activity — maintain coverage.</td></tr>
      <tr><td colspan="3" class="rp-small">Moon: <b>${sol.phaseName}</b> (${sol.illum}% illuminated) — Overall rating: <span class="rp-pill ${sol.ratingClass}">${sol.rating}</span></td></tr>`;

    // HOISTED, because the go/no-go block below is a DIFFERENT try block and cannot see a
    // `const` declared inside this one. It read `data.daily.temperature_2m_max[0]` from a
    // variable that has never been in scope there, so the safety verdict threw a ReferenceError
    // on every single run since it was written, landed in its own catch, and fell through to
    // whatever `goNoGo` was initialised to. The console said so every time:
    //
    //   [plan-builder] go/no-go assessment failed: ReferenceError: data is not defined
    //
    // Ryan, 2026-08-09: "preview button is broken takes me to the preview/print tab with
    // nothing showing".
    let wxData = null;

    // Fetch Open-Meteo: daily + hourly in one call
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`+
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,windspeed_10m_max,winddirection_10m_dominant,precipitation_sum,uv_index_max`+
        `&hourly=weather_code,cloud_cover,temperature_2m,windspeed_10m,winddirection_10m,precipitation_probability,pressure_msl,uv_index`+
        `&timezone=auto&start_date=${date}&end_date=${date}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      const data = await res.json();
      wxData = data;

      if(data && data.daily){
        const D = data.daily;
        sunriseStr = fmt12(D.sunrise[0].split('T')[1]);
        sunsetStr  = fmt12(D.sunset[0].split('T')[1]);
        const condition = weatherCodeText(D.weather_code?.[0]);
        const tmaxF = Math.round(D.temperature_2m_max[0] * 9/5 + 32);
        const tminF = Math.round(D.temperature_2m_min[0] * 9/5 + 32);
        const windMph = Math.round(D.windspeed_10m_max[0] * 0.621371);
        if (window.trollmapCheckWindAlert) window.trollmapCheckWindAlert(windMph);
        const windD   = windDir(D.winddirection_10m_dominant[0]);
        const precip  = D.precipitation_sum[0];
        const uvMax   = D.uv_index_max[0];
        const hot = tmaxF >= 90;
        const uvWarn = uvMax >= 8 ? ` <b>⚠ UV ${uvMax} (VERY HIGH)</b> — Full sun protection required.` : uvMax >= 6 ? ` UV ${uvMax} (High) — SPF50+ and UV shirt.` : '';

        weatherHtml = `<b>${condition}</b> · High <b>${tmaxF}°F</b> / Low <b>${tminF}°F</b> · Wind <b>${windD} ${windMph} mph</b> · Precip <b>${precip}mm</b> · UV max <b>${uvMax}</b>.`+
          (hot ? ' <b>⚠ HEAT ADVISORY — hydrate hard, consider early exit.</b>' : '') + uvWarn;

        // Give Smart Plan / Groq the same full Open-Meteo forecast used by the report.
        const weatherEl = document.getElementById('planWeather');
        if (weatherEl) {
          weatherEl.value = `Wind ${windD} ${windMph} mph · Precip ${precip}mm`;
        }

        // Hourly wind table for launch window (4 AM to 2 PM = hours 4-14)
        if(data.hourly){
          const H = data.hourly;
          const launchHour = p.meta.launchTime ? parseInt(p.meta.launchTime.split(':')[0])||5 : 5;
          const endHour = Math.min(launchHour + 8, 14);
          let windRows = '';
          for(let h=launchHour; h<=endHour; h++){
            const wSpd = Math.round(H.windspeed_10m[h] * 0.621371);
            const wDir = windDir(H.winddirection_10m[h]);
            const wF   = Math.round(H.temperature_2m[h] * 9/5 + 32);
            const pp   = H.precipitation_probability[h]||0;
            const uv   = H.uv_index[h]||0;
            const warn = pp >= 50 ? '⚠ Rain' : wSpd >= 15 ? '⚠ Wind' : uv >= 8 ? '☀ UV' : '';
            windRows += `<tr${warn?` style="background:#fff4e0"`:''}><td>${h%12||12}${h>=12?'PM':'AM'}</td><td>${wF}°F</td><td>${wDir} ${wSpd}mph</td><td>${pp}%</td><td>${uv}</td><td style="color:#c00;font-size:11px">${warn}</td></tr>`;
          }
          windHtml = `<table>
            <thead><tr style="background:#eef4fa"><th>Hour</th><th>Temp</th><th>Wind</th><th>Rain%</th><th>UV</th><th></th></tr></thead>
            <tbody>${windRows}</tbody></table>`;

          // Pressure trend (compare first vs last hour of window)
          const pStart = H.pressure_msl[launchHour];
          const pEnd   = H.pressure_msl[Math.min(launchHour+6, 23)];
          const pDiff  = pEnd - pStart;
          const pTrend = pDiff > 1 ? '📈 Rising — fish likely active, feeding window improving' :
                         pDiff < -1 ? '📉 Falling — feeding frenzy possible pre-front; watch for weather change' :
                         '➡ Steady — consistent conditions, fish predictable';
          const pClass = pDiff > 1 ? 'rp-good' : pDiff < -1 ? 'rp-warn' : 'rp-info';
          pressureHtml = `<div class="rp-callout ${pClass}">
            <b>⏱ Barometric Pressure Trend</b><br>
            ${Math.round(pStart)} hPa → ${Math.round(pEnd)} hPa (${pDiff>0?'+':''}${pDiff.toFixed(1)} hPa over 6hr) — ${pTrend}
          </div>`;
        }
      }
    } catch(e){
      // The panel already says so. The reason -- DNS, CORS, a 500 -- only lived here.
      console.warn(`[plan] weather fetch failed:`, e && e.message);
      weatherHtml = 'Weather fetch failed — check internet connection.';
    }

    // ── Module F — the state of the water, from one source ────────────────────────────────
    //
    // Ryan, 2026-08-16: *"i hate the bolt on approach... merge reduce make better."*
    //
    // This was fetchDamLevels() and a Duke / Dominion / Santee Cooper if-chain. The Duke arm
    // matched with `lakeLower.includes(k.split(' ')[1] || k)` -- THE SECOND WORD of the feed
    // name -- so "mountain island" reduced to `island` and any water whose name contained it
    // took Mountain Island Lake's elevation. Dominion was `lakeLower.includes('murray')` and
    // Santee Cooper was two more of the same. Four operators, four hand-written matchers, and
    // no way for a fifth to arrive without a fifth branch.
    //
    // /conditions resolves it from water_bindings.json instead: 147 bound lakes, 19 of them
    // with a live operator feed, matched by whole tokens against the registry name. Cube,
    // Southern Company and Brookfield arrived without a line changing here.
    let damHtml = '';
    try {
      const drec = lakeRecordFor(p.meta.waterbodyLabel || p.meta.lake || '') || lakeRecordFor(cleanLake);
      if (drec) {
        const worker = (typeof CF_WORKER_URL !== 'undefined' ? CF_WORKER_URL
                        : (window.CF_WORKER_URL || 'https://trollmap-worker.colonal1981.workers.dev'));
        const c = await fetchWaterConditions(worker, drec, { date: p.meta.date || undefined });
        if (c.error) {
          // "No callout" and "the call failed" looked identical on screen before. They do not now.
          damHtml = `<div class="rp-callout rp-warn"><b>💧 Water Level</b><br>`
                  + `Live conditions could not be read: ${esc(c.error)}.<br>`
                  + `<span class="rp-small">Verify the pool level yourself before launching.</span></div>`;
        } else if (c.belowFullPoolFt == null && c.levelFt == null) {
          damHtml = `<div class="rp-callout rp-info"><b>💧 Water Level</b><br>`
                  + `${esc(c.pending || 'No source publishes a level for this water.')}</div>`;
        } else {
          const rows = [];
          if (c.levelFt != null) rows.push(`Pool: <b>${c.levelFt.toFixed(2)} ft</b>`);
          if (c.belowFullPoolFt != null) {
            const b = c.belowFullPoolFt;
            rows.push(Math.abs(b) < 0.05 ? '<b>at full pool</b>'
              : b > 0 ? `<b>${b.toFixed(2)} ft below full pool</b>`
                      : `<b>${Math.abs(b).toFixed(2)} ft above full pool</b>`);
          }
          if (c.fullPoolFt != null) rows.push(`full pool ${c.fullPoolFt} ft`);
          // A target is not a reading, and the report says which is which.
          const corps = c.usaceTargetFt != null
            ? `<br><span class="rp-small">Corps target pool for ${esc(c.usaceProject || 'this project')} today: `
              + `${c.usaceTargetFt} ft — a target, not a reading.</span>` : '';
          // A tailwater temperature is the river below the dam. It is shown and labelled rather
          // than being written into the plan's water temperature as though it were the lake's.
          const temp = c.waterTempF != null
            ? `<br><span class="rp-small">Water temp ${c.waterTempF} °F`
              + `${c.waterTempFrom === 'tailwater' ? ' — TAILWATER gauge, below the dam' : ''}`
              + `${c.waterTempGauge ? ` (${esc(c.waterTempGauge)})` : ''}.</span>` : '';
          const when = c.observedAt ? ` · observed ${esc(c.observedAt)}` : '';
          const link = c.levelUrl ? ` · <a href="${esc(c.levelUrl)}" target="_blank" rel="noopener">source page</a>` : '';
          damHtml = `<div class="rp-callout rp-info"><b>💧 Water Level — ${esc(c.displayName || drec.displayName || drec.name)}</b><br>`
                  + `${rows.join(' · ')}${corps}${temp}<br>`
                  + `<span class="rp-small">${esc(c.levelSource || 'source not stated')}${when}${link}</span></div>`;
          if (c.waterTempF != null && c.waterTempFrom !== 'tailwater' && !p.meta.waterTemp) {
            p.meta.waterTemp = String(c.waterTempF);
          }
        }
      }
    } catch (err) {
      console.warn('[plan-builder] live conditions unavailable:', err);
      damHtml = `<div class="rp-callout rp-warn"><b>💧 Water Level</b><br>`
              + `Live conditions could not be read.<br>`
              + `<span class="rp-small">Verify the pool level yourself before launching.</span></div>`;
    }

    // Module E — NOAA Tides from builder cache
    let tidesHtml = '';
    const tideRows = window.getNoaaTideRows ? window.getNoaaTideRows() : '';
    const tideStage = window.getNoaaTideStage ? window.getNoaaTideStage() : '';
    const tideStation = window.getNoaaStationName ? window.getNoaaStationName() : '';
    if(tideRows && tideRows.trim() && !tideRows.includes('⏳') && !tideRows.includes('❌')){
      tidesHtml = `<h2>🌊 Tide Predictions — ${esc(tideStation)}</h2>
        ${tideStage ? `<div class="rp-callout rp-info"><b>Current Stage:</b> ${esc(tideStage)}</div>` : ''}
        <table>
          <thead><tr style="background:#eef4fa"><th>Event</th><th>Time</th><th>Level (MLLW)</th><th>Tactical Impact</th></tr></thead>
          <tbody>${tideRows}</tbody>
        </table>
        <div class="rp-callout rp-info" style="margin-top:8px">
          <b>🐟 Redfish / Inshore Tactics</b><br>
          Best bite: last 2hrs incoming + first hr of ebb on structure points ·
          Flood tide = work flooded grass edges, oyster bars, creek mouths ·
          Ebb tide = target channel edges, deep bends, drop-offs ·
          Low tide slack = popping cork over deeper holes ·
          Mullet pattern in fall — gold spoon or paddle tail in chartreuse/copper
        </div>`;
    }

    // ── Module F — Recent fishing reports, verbatim ───────────────────────────
    //
    // Ryan, 2026-08-15: "maybe a way to just scan for updated guide reports during the
    // planning... this doesn't need to go to the llm for anything maybe just to me in the trip
    // html report". So nothing here is summarised or scored. What a person on the water wrote,
    // the date they wrote it, and a link.
    //
    // The DATE IS PRINTED OR THE ITEM SAYS IT HAS NONE. AHQ states no date anywhere, so its
    // text is boxed separately and labelled undated -- printing "3 days ago" on a page that
    // says nothing about when would be a derived number wearing a fact's clothes, which is the
    // mistake that produced a wrong Duke drawdown on 2026-08-10.
    try {
      const rec = lakeRecordFor(p.meta.waterbodyLabel || p.meta.lake || '') || lakeRecordFor(cleanLake);
      if (rec) {
        const worker = (typeof CF_WORKER_URL !== 'undefined' ? CF_WORKER_URL
                        : (window.CF_WORKER_URL || 'https://trollmap-worker.colonal1981.workers.dev'));
        const names = [rec.name, rec.displayName, ...(rec.legacyDisplayNames || [])]
          .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
        const rc = new AbortController();
        const rt = setTimeout(() => rc.abort(), 9000);
        const rr = await fetch(`${worker}/reports/${encodeURIComponent(rec.slug)}`
          + `?names=${encodeURIComponent(names.join('|'))}&state=${encodeURIComponent(rec.state || '')}`,
          { signal: rc.signal });
        clearTimeout(rt);
        const rd = await rr.json();
        const rows = (rd.items || []).map((it) => {
          const when = it.published
            ? new Date(it.published).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
            : 'no date given';
          const days = it.published
            ? Math.floor((Date.now() - Date.parse(it.published)) / 86400000) : null;
          const age = days == null ? '' : days === 0 ? ' · today' : ` · ${days} day${days === 1 ? '' : 's'} old`;
          const body = it.description ? `<br><span class="rp-small">${esc(it.description)}</span>` : '';
          const warn = it.caution ? `<br><span class="rp-small" style="color:#b3261e">⚠ ${esc(it.caution)}</span>` : '';
          const where = it.matched_in === 'article'
            ? '<span class="rp-small" style="color:#94a3b8"> · named in the post body, not the headline</span>' : '';
          return `<tr><td style="white-space:nowrap">${esc(when)}<span class="rp-small">${esc(age)}</span></td>`
               + `<td><b>${it.link ? `<a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a>` : esc(it.title)}</b>`
               + `${where}${body}${warn}</td>`
               + `<td class="rp-small">${esc(it.source || '')}</td></tr>`;
        }).join('');
        const undated = (rd.undated || []).map((u) => `<div class="rp-callout rp-info" style="margin-top:8px">`
          + `<b>${esc(u.source || '')}</b> — <b style="color:#b06a00">no date published</b>. `
          + `Treat as background, not as current.<br><span class="rp-small">${esc(u.text || '')}</span>`
          + `${u.link ? `<br><a href="${esc(u.link)}" target="_blank" rel="noopener">${esc(u.link)}</a>` : ''}</div>`).join('');
        // "Nobody looked" and "nothing to report" are different answers, and the report says which.
        const checked = (rd.checked || []).length
          ? `Checked ${esc((rd.checked || []).join(', '))}.` : 'No source was reachable.';
        if (rows || undated) {
          reportsHtml = `<h2>📰 Recent Fishing Reports — ${esc(rec.displayName || rec.name)}</h2>
            <p class="rp-small">Verbatim from the source, newest first. Nothing here has been summarised or scored. ${checked}</p>
            ${rows ? `<table><thead><tr style="background:#eef4fa"><th>Date</th><th>Report</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
            ${undated}`;
        } else {
          reportsHtml = `<div class="rp-callout rp-info"><b>📰 Recent Fishing Reports</b><br>`
            + `<span class="rp-small">Nothing published about this water. ${checked}</span></div>`;
        }
      }
    } catch (err) {
      // Distinguished on purpose: a failed lookup must not read as "no reports exist".
      console.warn('[plan-builder] fishing reports unavailable:', err);
      reportsHtml = `<div class="rp-callout rp-warn"><b>📰 Recent Fishing Reports</b><br>`
        + `<span class="rp-small">Could not be checked — the report lookup failed. This is not the same as "no reports".</span></div>`;
    }

    // USGS — only temperature is reliable for most lakes.
    // For Wateree (and other Duke lakes) the 00065 river gauge is BELOW the dam and is NOT pool level.
    // We deliberately skip 00065 for Wateree and only show temperature.
    usgsHtml = '';
    if(lakeEntry && lakeEntry.usgs){
      try {
        const {site, params} = lakeEntry.usgs;
        // Always request only temperature to avoid accidentally treating river stage as pool
        const safeParams = params.includes('00065') && (site === '02148000' || (lakeEntry.name||'').toLowerCase().includes('wateree'))
          ? '00010' 
          : params;
        // api.waterdata.usgs.gov -- waterservices is decommissioned Q1 2027. latest-continuous
        // returns every parameter at the site, so safeParams narrows it server-side exactly as
        // parameterCd did, and the "temperature only" guard above still does its job.
        const usgsSite = String(site).startsWith('USGS-') ? site : `USGS-${site}`;
        const usgsUrl = `https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items`
          + `?monitoring_location_id=${encodeURIComponent(usgsSite)}`
          + `&parameter_code=${encodeURIComponent(safeParams)}&limit=50&f=json`;
        const uController = new AbortController();
        const uTimeoutId = setTimeout(() => uController.abort(), 4000);
        const ur = await fetch(usgsUrl, { signal: uController.signal });
        clearTimeout(uTimeoutId);
        const ud = await ur.json();
        // OGC returns one feature per observation with the code on it, so the old
        // s.variable.variableCode[0].value walk is gone.
        const feats = Array.isArray(ud?.features) ? ud.features : [];
        if (feats.length) {
          const pick = (code) => {
            for (const f of feats) {
              const pr = (f && f.properties) || {};
              if (pr.parameter_code !== code) continue;
              if (pr.value === null || pr.value === undefined || pr.value === '') continue;
              const n = Number(pr.value);              // value is a string by design
              if (Number.isFinite(n) && n > -999999) return n;
            }
            return null;
          };
          const tempC = pick('00010');
          let parts = [];
          if (tempC != null) {
            const tempF = Math.round(tempC * 9/5 + 32);
            parts.push(`Water temp: <b>${tempF}°F</b> (${tempC.toFixed(1)}°C)`);
            // Auto-fill water temp field if empty
            if(!p.meta.waterTemp) p.meta.waterTemp = String(tempF);
          }
          // Explicit note for Wateree river gauge
          // THE CAVEAT IS ABOUT THE WATER, NOT ABOUT ONE SITE NUMBER.
          //
          // This was pinned to `site === '02148000'`. On 2026-08-15 consolidate_lake_index.py
          // started taking `usgs` from water_bindings.json, and Wateree's binding has NO pool
          // site at all -- CDCS1 carries no usgs_site -- so it falls through to the gauges[]
          // list and lands on 02147801, LAKE WATEREE TAILRACE ABOVE CAMDEN. Also below the
          // dam, also not pool, and the pin stopped matching, so the one sentence that stops
          // a tailrace reading being taken for lake pool disappeared from the lake it was
          // written for. The temperature-only guard above survived because it was already
          // name-based; this was not.
          //
          // Every USGS site bound to wateree_lake is below the dam, so the name is the right
          // test and the site number is printed rather than asserted.
          if (String(p.meta.lake||'').toLowerCase().includes('wateree')
              || (lakeEntry.name||'').toLowerCase().includes('wateree')) {
            parts.push(`<span class="rp-small" style="color:#c62828">(USGS ${site} is below Wateree dam — temperature proxy only; lake pool comes from Duke Energy)</span>`);
          }
          if(parts.length){
            const usgsTitle = (String(p.meta.lake||'').toLowerCase().includes('wateree')
                               || (lakeEntry.name||'').toLowerCase().includes('wateree'))
              ? '💧 USGS Below-Dam River Temperature Proxy' : `💧 USGS Live Water Data (site ${site})`;
            usgsHtml = `<div class="rp-callout rp-info"><b>${usgsTitle}</b><br>${parts.join(' · ')}<br><span class="rp-small">Data provisional — subject to USGS revision. Managed-lake pool level may come from a different utility source.</span></div>`;
          }
        }
      } catch(e){
        // Optional, but 'no gauge on this lake' and 'USGS is down' produced the same empty
        // panel, and only one of those is worth waiting out.
        console.warn(`[plan] USGS water data fetch failed:`, e && e.message);
        usgsHtml = ''; /* USGS optional, fail silently */
      }
    }

    // GO / NO-GO calculation (needs weather data)
    try {
      if (!wxData || !wxData.daily) {
        // No weather is not a GO. Saying so out loud beats a verdict assembled from nothing.
        noGoReasons.push('Weather forecast unavailable — check conditions yourself before launching');
        throw new Error('no forecast');
      }
      const tmaxF = Math.round(wxData.daily.temperature_2m_max[0] * 9/5 + 32);
      const windMph = Math.round(wxData.daily.windspeed_10m_max[0] * 0.621371);
      const precip = wxData.daily.precipitation_sum[0];
      const uvMax = wxData.daily.uv_index_max[0];
      const maxPP = wxData.hourly ? Math.max(...wxData.hourly.precipitation_probability.slice(0,14)) : 0;

      if(windMph >= 20) noGoReasons.push(`Wind ${windMph}mph — unsafe for kayak`);
      else if(windMph >= 15) goReasons.push(`Wind ${windMph}mph — manageable, stay near shore`);
      else goReasons.push(`Wind ${windMph}mph — good conditions`);

      if(maxPP >= 70) noGoReasons.push(`Rain/storm probability ${maxPP}% — lightning risk`);
      else if(maxPP >= 40) goReasons.push(`Rain chance ${maxPP}% — watch sky, have exit plan`);
      else goReasons.push(`Rain chance ${maxPP}% — low precipitation risk`);

      if(tmaxF >= 98) noGoReasons.push(`NO-GO: heat ${tmaxF}°F — dangerous heat index on open water`);
      else if(tmaxF >= 90) noGoReasons.push(`CAUTION: heat ${tmaxF}°F — hydrate aggressively, consider early exit`);
      else goReasons.push(`Temp ${tmaxF}°F — comfortable`);

      if(uvMax >= 8) noGoReasons.push(`CAUTION: UV ${uvMax.toFixed ? uvMax.toFixed(1) : uvMax} very high — full sun protection required`);

      if(noGoReasons.length >= 2){ goNoGo='NO-GO'; goClass=''; }
      else if(noGoReasons.length === 1){ goNoGo='CAUTION'; goClass='rp-warn'; }
      else { goNoGo='GO'; goClass='rp-good'; }
    } catch (err) {
      // This block decides GO / CAUTION / NO-GO. If it throws, the verdict falls back to
      // whatever it was initialised to -- which is a safety call being made by an accident.
      console.error('[plan-builder] go/no-go assessment failed:', err);
    }

    // Final autonomous trip decision — always produce GO / CAUTION / NO-GO even
    // when the weather API fails. This folds in weather, lake level, water temp,
    // closed seasons, and river go/no-go / dam surge data from the Plan form.
    function addRisk(msg){ if(msg && !noGoReasons.includes(msg)) noGoReasons.push(msg); }
    function addPositive(msg){ if(msg && !goReasons.includes(msg)) goReasons.push(msg); }
    // ONE SET OF THRESHOLDS, IN FEET. There were two, and which one ran was decided by the
    // nine-name Duke list: eight feet down on Wateree was NO-GO while eight feet down on
    // Hartwell was only CAUTION, for the same physical drawdown, because one was labelled a
    // percent. Duke's band is a hundred feet, so those percents were always feet.
    //
    // THE STATED DRAWDOWN WINS over a subtraction. Chilhowee and Calderwood publish feet below
    // full pool and no elevation, so `poolLevel - fullPool` is NaN on the two lakes that
    // answered the question directly.
    const poolVal = parseFloat(p.meta.poolLevel);
    const fullVal = parseFloat(p.meta.fullPool);
    const statedBelow = parseFloat(p.meta.belowFullPool);
    // Positive = below full pool, matching how every operator publishes it. `diff` keeps the
    // old sign convention (negative = down) so the sentences below read the same way.
    const diff = isFinite(statedBelow) ? -statedBelow
               : (isFinite(poolVal) && isFinite(fullVal)) ? poolVal - fullVal : NaN;
    if(isFinite(diff)){
      const at = isFinite(poolVal) ? `${poolVal.toFixed(1)} ft` : 'level';
      if(diff <= -10) addRisk(`NO-GO: lake is ${Math.abs(diff).toFixed(1)} ft below full pool — likely ramp/prop hazards`);
      else if(diff <= -5) addRisk(`CAUTION: lake is ${Math.abs(diff).toFixed(1)} ft below full pool — verify ramps and stump fields`);
      else if(diff >= 5) addRisk(`NO-GO: lake is ${diff.toFixed(1)} ft above full pool — flood/debris risk`);
      else if(diff >= 2) addRisk(`CAUTION: lake is ${diff.toFixed(1)} ft above full pool — floating debris / flooded banks`);
      else addPositive(`Lake ${at} — ${Math.abs(diff) < 0.05 ? 'at full pool' : `${Math.abs(diff).toFixed(1)} ft ${diff < 0 ? 'below' : 'above'} full pool`}, near target`);
    } else if((p.meta.waterbodyType||'lake') === 'lake'){
      addRisk('CAUTION: no verified live lake-level source loaded — manually verify ramp depth and pool level');
    }

    const wt = parseFloat(p.meta.waterTemp);
    if(isFinite(wt)){
      if(wt < 45) addRisk(`NO-GO: water temperature ${wt}°F — extreme cold-water capsize risk`);
      else if(wt < 55) addRisk(`CAUTION: water temperature ${wt}°F — cold-water hypothermia risk; thermal gear required`);
      else if(wt > 88) addRisk(`CAUTION: water temperature ${wt}°F — heat stress / low dissolved oxygen risk`);
      else addPositive(`Water temperature ${wt}°F — acceptable`);
    }

    const clarityIntelText = String(p.meta.clarityIntel || '').toLowerCase();
    if(clarityIntelText){
      if(/muddy\s*\/\s*debris risk|debris risk/.test(clarityIntelText)){
        addRisk('CAUTION: clarity/runoff model predicts muddy water or debris risk — verify ramps, floating debris, and clearer lower-lake zones');
      } else if(/overall predicted clarity:\s*muddy|muddy/.test(clarityIntelText)){
        addRisk('CAUTION: clarity/runoff model predicts muddy water — adjust colors and avoid backs of creeks unless targeting mudlines');
      } else if(/overall predicted clarity:\s*stained|stained/.test(clarityIntelText)){
        addRisk('CAUTION: clarity/runoff model predicts stained water — favor color breaks, vibration, and high-contrast colors');
      }
    }

    // If Open-Meteo failed but the weather text field has wind/storm wording, use it.
    const weatherText = String(p.meta.weather || '').toLowerCase();
    const windMatch = weatherText.match(/(?:wind|winds|gusts?)?[^0-9]{0,12}(\d{1,2})\s*mph/i);
    if(windMatch && !goReasons.some(r=>r.toLowerCase().includes('wind')) && !noGoReasons.some(r=>r.toLowerCase().includes('wind'))){
      const wm = parseInt(windMatch[1],10);
      if(wm >= 20) addRisk(`NO-GO: wind/gusts ${wm} mph — unsafe kayak/open-water trolling`);
      else if(wm >= 15) addRisk(`CAUTION: wind/gusts ${wm} mph — stay protected and shorten trip`);
      else addPositive(`Wind ${wm} mph — acceptable`);
    }
    if(/thunder|lightning|severe|storm warning|small craft|advisory/.test(weatherText)){
      addRisk('NO-GO: weather text includes storm/advisory wording — verify radar before launch');
    }

    const riverSummary = String(p.meta.riverSummary || '');
    if(riverSummary){
      if(/Status:\s*.*NO-GO|🛑|NO GO/i.test(riverSummary)) addRisk('NO-GO: river/dam-release module reports NO-GO conditions');
      else if(/Status:\s*.*CAUTION|⚠/i.test(riverSummary)) addRisk('CAUTION: river/dam-release module reports elevated risk');
      else if(/Status:\s*.*GO|✅/i.test(riverSummary)) addPositive('River/dam-release module reports GO conditions');
      if(/surge arrives|dam surge|scheduled dam release/i.test(riverSummary) && /in\s+(?:[0-9]|[1-9][0-9])\s*min/i.test(riverSummary)){
        addRisk('NO-GO: dam surge/release is imminent at the selected river location');
      }
    }

    if(closedWarning) addRisk('NO-GO: selected target species has a closed-season warning for this waterbody/date');

    const hardRisk = noGoReasons.some(r => /^NO-GO:/i.test(r) || /unsafe|dangerous|lightning|closed-season|imminent|extreme|flood\/debris/i.test(r));
    const cautionRisk = noGoReasons.length > 0;
    if(hardRisk || noGoReasons.filter(r=>/^CAUTION:/i.test(r)).length >= 3){ goNoGo='NO-GO'; goClass=''; }
    else if(cautionRisk){ goNoGo='CAUTION'; goClass='rp-warn'; }
    else { goNoGo='GO'; goClass='rp-good'; }
    if(!goReasons.length && !noGoReasons.length){
      goNoGo='CAUTION'; goClass='rp-warn';
      addRisk('CAUTION: insufficient live weather/water data — verify manually before launch');
    }

    // USNO Moon rise/set
    try {
      const usnoDate = date.replace(/-/g,'');
      const usnoUrl = `https://aa.usno.navy.mil/api/rstt/oneday?date=${date}&coords=${lat},${lon}&tz=${Math.round(lon/15)}&dst=false`;
      const ur = await fetch(usnoUrl);
      const ud = await ur.json();
      if(ud && ud.properties && ud.properties.data){
        const moonData = ud.properties.data.moondata;
        if(moonData){
          const rise = moonData.find(e=>e.phen==='Rise');
          const set  = moonData.find(e=>e.phen==='Set');
          if(rise) moonriseStr = fmt12(rise.time);
          if(set)  moonsetStr  = fmt12(set.time);
        }
      }
    } catch(e){
      // Optional -- the plan renders without solunar times.
      console.warn(`[plan] USNO solunar fetch failed:`, e && e.message);
      /* USNO optional */
    }
  }

  // ── Civil / Nautical twilight ────────────────────────────────────────────
  twilightHtml = '';
  if(lakeEntry && p.meta.date){
    // Approximate civil twilight = sunrise/sunset ± 30 min, nautical ± 60 min
    // We already have sunriseStr and sunsetStr from the weather fetch
    // Parse them back to minutes for math
    function parseTime12(str){
      if(!str||str==='--:--') return null;
      const m = str.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if(!m) return null;
      let h=parseInt(m[1]), mn=parseInt(m[2]);
      if(m[3].toUpperCase()==='PM' && h!==12) h+=12;
      if(m[3].toUpperCase()==='AM' && h===12) h=0;
      return h*60+mn;
    }
    function addMin(str, delta){
      const t=parseTime12(str); if(t===null) return '--';
      const n=t+delta; const h=Math.floor((n+1440)%1440/60); const mn=(n+1440)%60;
      const ap=h>=12?'PM':'AM'; return `${h%12||12}:${String(mn).padStart(2,'0')} ${ap}`;
    }
    if(sunriseStr!=='--:--'){
      twilightHtml = `<table><thead><tr style="background:#eef4fa">
        <th>Event</th><th>Time</th><th>Significance</th></tr></thead><tbody>
        <tr><td>Nautical twilight (AM)</td><td><b>${addMin(sunriseStr,-60)}</b></td><td>Start navigating — visibility improving</td></tr>
        <tr style="background:#e8f5e9"><td>Civil twilight (AM)</td><td><b>${addMin(sunriseStr,-30)}</b></td><td>🎣 Prime topwater window begins</td></tr>
        <tr style="background:#e8f5e9"><td>Sunrise</td><td><b>${sunriseStr}</b></td><td>🎣 Peak dawn bite — be on fish</td></tr>
        <tr><td>Solar noon</td><td><b>${addMin(sunriseStr, Math.round((parseTime12(sunsetStr)-parseTime12(sunriseStr))/2))}</b></td><td>UV peak — fish move deep, slow down</td></tr>
        <tr style="background:#e8f5e9"><td>Sunset</td><td><b>${sunsetStr}</b></td><td>🎣 Evening bite window opens</td></tr>
        <tr style="background:#e8f5e9"><td>Civil twilight (PM)</td><td><b>${addMin(sunsetStr,30)}</b></td><td>🎣 Prime topwater window — last light</td></tr>
        <tr><td>Nautical twilight (PM)</td><td><b>${addMin(sunsetStr,60)}</b></td><td>End of fishable light — wrap up</td></tr>
      </tbody></table>`;
    }
  }

  

  return `
<div class="report-page">
<header>
  <h1>🎣 ${esc(p.meta.name||'Fishing Trip Plan')}</h1>
  <div class="rp-sub">${esc(p.meta.ramp||'')}${(p.meta.waterbodyLabel||p.meta.lake)?' · '+esc(p.meta.waterbodyLabel||p.meta.lake):''} · ${esc((p.meta.species||[]).join(', ')||'—')}</div>
  <div class="rp-meta">
    <span><b>Date:</b> ${dateStr}</span>
    ${p.meta.motor?`<span><b>Motor:</b> ${esc(p.meta.motor)}</span>`:''}
    ${sunriseStr!=='--:--'?`<span><b>Sunrise:</b> ${sunriseStr} · <b>Sunset:</b> ${sunsetStr}</span>`:''}
    ${p.meta.sonar?`<span><b>Sonar:</b> ${esc(p.meta.sonar)}</span>`:''}
    <span><b>Launch:</b> ${esc(p.meta.launchTime||'—')} · <b>Return:</b> ${esc(p.meta.returnTime||'—')}</span>
    ${p.meta.crew?`<span><b>Crew:</b> ${esc(p.meta.crew)}</span>`:''}
  </div>
</header>

<div class="report-body">
<button class="no-print" onclick="window.print()" style="margin:10px 0;background:#0d4f8b;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer">🖨 Print / Save PDF</button>

<div class="rp-callout rp-good">
  <b>☀ Weather Forecast (Open-Meteo)</b>
  ${weatherHtml}
</div>

${usgsHtml}

${damHtml}

${p.meta.riverSummary ? `<div class="rp-callout rp-warn"><b>🌊 River / Dam Release Intel</b><br>${esc(p.meta.riverSummary).replace(/\n/g,'<br>')}</div>` : ''}

${exchangeHtml}

${p.meta.clarityIntel ? `<div class="rp-callout rp-warn"><b>🌦 Clarity & Runoff Intelligence</b><br>${esc(p.meta.clarityIntel).replace(/\n/g,'<br>')}</div>` : ''}

${tidesHtml}

${reportsHtml}

<div class="rp-callout ${goClass}" style="${goNoGo==='NO-GO'?'background:#fff0f0;border-left:5px solid #b3261e':''}">
  <b style="font-size:16px">${goNoGo==='GO'?'✅':goNoGo==='CAUTION'?'⚠':'🚫'} TRIP DECISION: ${goNoGo}</b><br>
  ${noGoReasons.map(r=>`❌ ${r}`).join('<br>')}
  ${goReasons.map(r=>`✓ ${r}`).join('<br>')}
</div>

${closedWarning}

${pressureHtml}


<!-- ── Transparent Autonomous AI Assessment Box (Why This Plan?) ── -->
<div class="rp-callout" style="background:#1e293b;border-left:5px solid #00e5ff;color:#e1e7ed;padding:18px 22px;margin-bottom:30px;border-radius:0 12px 12px 0;box-shadow:0 6px 16px rgba(0,0,0,0.4)">
  <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.15);padding-bottom:10px;margin-bottom:14px">
    <b style="color:#00e5ff;font-size:18px;display:flex;align-items:center;gap:8px">🧠 Autonomous AI Reasoning — "Why This Plan?"</b>
    <span style="font-family:monospace;background:#0f172a;color:#76ff03;padding:2px 8px;border-radius:6px;font-size:11px;border:1px solid #76ff03">100% Transparent Tactical Assessment</span>
  </div>
  
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px;font-size:13.5px">
    <div style="background:#0f172a;padding:14px 16px;border-radius:8px;border:1px solid rgba(255,255,255,0.08)">
      <b style="color:#ffb703;font-size:14.5px;display:block;margin-bottom:6px">📊 Factual Environmental Drivers</b>
      <div style="display:flex;flex-direction:column;gap:5px">
        <span>• <b>Water Temperature</b>: Exactly ${p.meta.waterTemp||'72'}°F</span>
        <span>• <b>Wind Forecast / Gusts</b>: Exactly ${esc(p.meta.weather||'WSW 11 mph')}</span>
        <span>• <b>${p.meta.waterbodyType==='river'?'River Safety / Flow':'Water Level Stage'}</b>: ${p.meta.waterbodyType==='river' ? esc([p.meta.riverSafety, p.meta.riverFlow, p.meta.riverSurgeEta].filter(Boolean).join(' · ') || 'River sync not run') : (() => {
          // `parseFloat(poolLevel) < 98` used to decide "Drawdown Threat". That is a test
          // against DUKE'S PERCENT SCALE, and it was being run on feet: Lake Moultrie sits at
          // 74.5 ft at full pool and read as a threat every single day, while Thurmond at 323
          // never did no matter how far down it was. The drawdown itself is the test.
          const below = parseFloat(p.meta.belowFullPool);
          const lvl = p.meta.poolLevel ? `${esc(p.meta.poolLevel)} ft` : null;
          if (!isFinite(below)) return lvl ? `${lvl} (Lake Level Synced)` : 'No live level source';
          const tag = below >= 5 ? '(Drawdown Threat)' : below <= -2 ? '(Above Full Pool)' : '(Near Full Pool)';
          const d = Math.abs(below) < 0.05 ? 'at full pool'
                  : `${Math.abs(below).toFixed(2)} ft ${below > 0 ? 'below' : 'above'} full pool`;
          return `${lvl ? `${lvl} · ` : ''}${d} ${tag}`;
        })()}</span>
        <span>• <b>Tactical Clarity</b>: Exactly <b style="color:#00e5ff">${esc(p.meta.clarity||'Clear')}</b></span>
        <span>• <b>Solunar Activity</b>: ${solunarAutoRows?solunarAutoRows.split('</td>')[0].replace(/<[^>]*>?/gm, '').trim():'Major Window Active'} — ${moonPhase}</span>
      </div>
    </div>

    <div style="background:#0f172a;padding:14px 16px;border-radius:8px;border:1px solid rgba(255,255,255,0.08)">
      <b style="color:#76ff03;font-size:14.5px;display:block;margin-bottom:6px">🎯 Therefore Protocol Recommendations</b>
      <div style="display:flex;flex-direction:column;gap:5px">
        <span>• <b>Trolling Velocity</b>: Maintain the pass-specific speed: <b>${esc(phaseSpeedSummary)}</b>, so each lure stays within its physical trolling limit.</span>
        <span>• <b>Target Drop-Off</b>: Deploy Core Rod Matrix exactly across <b>${esc(p.trolling.targetDepth||'the charted contour')}${p.trolling.targetDepth ? ' ft' : ''}</b> ledge drop-offs using automated wire let-out helpers.</span>
        <span>• <b>Match-the-Hatch Profile</b>: Force swimbait profile sizing to exactly <b>${parseFloat(p.meta.waterTemp)<65?'3.8" Finesse Threadfin':parseFloat(p.meta.waterTemp)<80?'4.6" Finesse Blueback Herring':'6" Gizzard Shad'}</b>.</span>
        <span>• <b>Color Penetration</b>: ${(p.meta.clarity||'')==='Stained'?'Prioritize <b style="color:#76ff03">Firetiger / Chartreuse UV</b> due to suspended particulate light limits.':(p.meta.clarity||'')==='Muddy'?'Deploy loud rattles and dark Black/Blue silhouettes.':'Focus entirely on natural <b style="color:#fff">Bone / Pearl Flash</b> with fluoro leaders.'}</span>
        <span>• <b>Structure Engagement</b>: Cross directly over creek mouth swings and submerged roadbed intersections.</span>
      </div>
    </div>
  </div>

  <div style="margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.1);font-size:12.5px;color:#94a3b8;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
    <span><b>Wind Protection Score</b>: The active trolling passes run exactly across the protected Lee side of the reservoir with excellent wave-dampening cover.</span>
    <b style="color:#00e5ff">Automatic Launch Ramp Match: Exactly ${esc(p.meta.ramp||'Dutchman Creek')} (Shortest sheltered distance to primary structure)</b>
  </div>
</div>

<h2>1 · ${p.meta.waterbodyType==='river'?'River Conditions &amp; Dam Release Safety':'Water Conditions &amp; Live Pool Elevation'}</h2>
<table>
  <tr><th style="width:28%">Detail</th><th>Telemetry / Readout</th></tr>
  ${p.meta.ramp?`<tr><td>Launch Ramp</td><td>${esc(p.meta.ramp)}</td></tr>`:''}
  <tr><td>Sunrise / Sunset</td><td>${sunriseStr} · ${sunsetStr}</td></tr>
  <tr><td>Moon Phase</td><td>${moonPhase} (${moonIllum}% lit)${moonriseStr!=='--:--'?` · Rise ${moonriseStr} / Set ${moonsetStr}`:''}</td></tr>
  <tr><td>Water Clarity</td><td><span style="display:inline-block;padding:2px 8px;border-radius:4px;background:var(--panel2);color:var(--accent);font-weight:700">${esc(clarity)}</span></td></tr>
  ${p.meta.waterbodyType!=='river' && p.meta.waterTemp?`<tr><td>Water Temperature</td><td><b>${esc(p.meta.waterTemp)} °F</b> ${lakeEntry&&lakeEntry.usgs?'<span class="rp-small" style="color:#00e5ff">(USGS Live Monitoring Relay)</span>':''}</td></tr>`:''}
  ${p.meta.waterbodyType==='river' ? `${p.meta.riverSafety?`<tr><td>Kayak Go / No-Go</td><td><b style="color:${/NO.GO|🛑/i.test(p.meta.riverSafety)?'#c62828':/CAUTION|⚠/i.test(p.meta.riverSafety)?'#e65100':'#2e7d32'}">${esc(p.meta.riverSafety)}</b></td></tr>`:''}${p.meta.riverFlow?`<tr><td>Streamflow</td><td><b>${esc(p.meta.riverFlow)}</b> <span class="rp-small">(USGS real-time)</span></td></tr>`:''}${p.meta.riverGauge?`<tr><td>Gauge Height</td><td><b>${esc(p.meta.riverGauge)}</b></td></tr>`:''}${(p.meta.riverTemp||p.meta.waterTemp)?`<tr><td>Water Temperature</td><td><b>${esc(p.meta.riverTemp||p.meta.waterTemp).replace(/ °F$/,'')} °F</b> <span class="rp-small">(USGS)</span></td></tr>`:''}${p.meta.riverRise?`<tr><td>Rate of Rise</td><td><b>${esc(p.meta.riverRise)}</b></td></tr>`:''}${p.meta.riverSurgeEta?`<tr><td>Surge ETA @ Launch</td><td><b style="color:#e65100">${esc(p.meta.riverSurgeEta)}</b></td></tr>`:''}` : ((p.meta.fullPool || p.meta.poolLevel || p.meta.belowFullPool) ? `<tr><td>Lake Level</td><td><b>${esc(p.meta.poolLevel || '—')} ft</b> <span class="rp-small">(Current Level)</span> · <b>${esc(p.meta.fullPool || '—')} ft</b> <span class="rp-small">(Full Pool)</span> ${
    (() => {
      // The badge reads the STATED drawdown first. Chilhowee publishes 1.18 ft below full pool
      // and no elevation, so the old subtraction printed no badge on a lake that had already
      // answered. The comparison is also `>= 0` on a rounded string in the original, which made
      // "-0.0 Drawdown" render green.
      const stated = parseFloat(p.meta.belowFullPool);
      const lvl = parseFloat(p.meta.poolLevel), full = parseFloat(p.meta.fullPool);
      const below = isFinite(stated) ? stated : (isFinite(lvl) && isFinite(full)) ? full - lvl : NaN;
      if (!isFinite(below)) return '';
      const good = below <= 0;
      const txt = Math.abs(below) < 0.05 ? 'At Full Pool'
                : below > 0 ? `${below.toFixed(2)} ft Drawdown`
                            : `+${Math.abs(below).toFixed(2)} ft Above Full Pool`;
      return `<span style="display:inline-block;margin-left:8px;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700;background:${good ? '#e8f5e9;color:#2e7d32' : '#ffebee;color:#c62828'}">${txt}</span>`;
    })()
  }</td></tr>` : '')}
  ${p.meta.weather?`<tr><td>Air Temp / Wind Forecast</td><td>${esc(p.meta.weather)}</td></tr>`:''}
</table>

<div class="rp-callout rp-info">
  <b>🎯 ${p.meta.waterbodyType==='river'?'River Tactical Assessment':'Tactical Assessment'} — ${esc(clarity)} Water</b><br>
  ${p.meta.waterbodyType==='river' ? 'Prioritize current seams, eddies, safe take-out timing, and dam-release schedule over reservoir-style pool-level tactics.' : tacticalText}
</div>

<h2>2 · Solunar Timing &amp; Feeding Windows</h2>
<table>
  <thead><tr style="background:#eef4fa"><th style="width:20%">Period</th><th style="width:25%">Active Window</th><th>Tactical Strategy</th></tr></thead>
  <tbody>${solunarAutoRows}</tbody>
</table>
${p.meta.solunar?`<p class="rp-small">Manual override note: ${esc(p.meta.solunar)}</p>`:''}

${windHtml?`<h2>3 · Hourly Launch Window Weather</h2>${windHtml}`:''}

${twilightHtml?`<h2>4 · Light &amp; Bite Feed Triggers</h2>${twilightHtml}`:''}

<h2>5 · Core Trolling Strategy &amp; Active Wind Exposure Scoring Engine</h2>
<table style="margin-bottom:14px">
  <thead>
    <tr style="background:#eef4fa"><th>Target Trolling Speed</th><th>Target Drop-Off Depth</th><th>Tactical Pattern</th></tr>
  </thead>
  <tbody>
    <tr><td><b style="font-size:15px;color:#0d4f8b">${esc(phaseSpeedSummary)}</b></td><td><b style="font-size:15px;color:#0d4f8b">${p.trolling.targetDepth ? `${esc(p.trolling.targetDepth)} ft` : '—'}</b></td><td><b style="font-size:15px">${esc(p.trolling.pattern||'—')}</b></td></tr>
  </tbody>
</table>

<!-- Automated Wind Exposure Scoring Matrix -->
<div class="rp-grid2" style="margin-bottom:20px">
  <div style="background:#f7f9fb;border:1px solid #e1e7ed;border-radius:8px;padding:14px">
    <h3 style="color:#0d4f8b;margin:0 0 8px 0;font-size:15px;display:flex;align-items:center;gap:6px">🌬️ Vector Wind Exposure Scoring Engine</h3>
    <div style="font-size:13px;color:#333;display:flex;flex-direction:column;gap:6px">
      ${(() => {
        // Real exposure scoring: compare each track's actual run bearing
        // against the parsed wind compass direction. A track running
        // perpendicular to the wind gets minimal exposure (boat shields
        // the line, less chop pushes you off pattern); a track running
        // parallel/into the wind gets maximal exposure. This replaces the
        // previous placeholder (score = i===0?2:i===1?7:9 regardless of
        // actual geometry) with a genuine bearing-vs-wind comparison.
        const windCompass = { N:0, NNE:22.5, NE:45, ENE:67.5, E:90, ESE:112.5, SE:135, SSE:157.5,
                               S:180, SSW:202.5, SW:225, WSW:247.5, W:270, WNW:292.5, NW:315, NNW:337.5 };
        const wMatch = String(p.meta.weather||'').match(/\b(N|NNE|NE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)\b/);
        const windDeg = wMatch ? windCompass[wMatch[1]] : null;

        function trackBearingDeg(t) {
          const pts = t.pts || [];
          if (pts.length < 2) return null;
          const aRaw = pts[0], bRaw = pts[pts.length - 1];
          // Track points are [lat, lon] arrays (per parsers.js) but can also be {lat, lon} objects
          const aLat = Array.isArray(aRaw) ? aRaw[0] : aRaw.lat;
          const aLon = Array.isArray(aRaw) ? aRaw[1] : aRaw.lon;
          const bLat = Array.isArray(bRaw) ? bRaw[0] : bRaw.lat;
          const bLon = Array.isArray(bRaw) ? bRaw[1] : bRaw.lon;
          if (!Number.isFinite(aLat) || !Number.isFinite(aLon) || !Number.isFinite(bLat) || !Number.isFinite(bLon)) return null;
          const dLat = bLat - aLat, dLon = (bLon - aLon) * Math.cos(aLat * Math.PI / 180);
          let brng = Math.atan2(dLon, dLat) * 180 / Math.PI;
          return (brng + 360) % 360;
        }

        function exposureScore(trackDeg, wDeg) {
          if (trackDeg == null || wDeg == null) return null;
          // Angle between track heading and wind source direction, folded to 0-90
          let diff = Math.abs(trackDeg - wDeg) % 180;
          if (diff > 90) diff = 180 - diff;
          // 0deg (parallel/into wind) = max exposure, 90deg (perpendicular) = min exposure
          return Math.round((1 - diff / 90) * 8 + 1); // 1-9 scale
        }

        const tracks = (state.DATA.tracks && state.DATA.tracks.length) ? state.DATA.tracks : null;
        if (!tracks) {
          return `<span style="color:#666">No tracks loaded yet — generate or import a route to see wind exposure per lane.</span>`;
        }
        return tracks.map((t, i) => {
          const tDeg = trackBearingDeg(t);
          const score = exposureScore(tDeg, windDeg);
          if (score == null) {
            return `<span>• <b>${esc(t.name || 'Lane '+(i+1))}</b>: <span style="color:#666">Exposure unknown — need wind direction + 2+ track points</span></span>`;
          }
          const label = score <= 3 ? 'Lee Shore Cover' : score <= 6 ? 'Partial Fetch' : 'Open Fetch Wind Chop';
          const col   = score <= 3 ? '#2e7d32' : score <= 6 ? '#e65100' : '#c62828';
          const bg    = score <= 3 ? '#e8f5e9' : '#ffebee';
          return `<span>• <b>${esc(t.name || 'Lane '+(i+1))}</b>: <b style="color:${col}">${score}/10 Exposure Score</b> <span style="background:${bg};color:${col};padding:1px 6px;border-radius:4px;font-weight:700;font-size:11px">${label}</span></span>`;
        }).join('');
      })()}
    </div>
  </div>

  <div style="background:#f7f9fb;border:1px solid #e1e7ed;border-radius:8px;padding:14px">
    <h3 style="color:#0d4f8b;margin:0 0 8px 0;font-size:15px;display:flex;align-items:center;gap:6px">⛵ Launch Ramp Status</h3>
    <div style="font-size:13px;color:#333;display:flex;flex-direction:column;gap:6px">
      <span>• <b>Evaluated Physical Wind</b>: ${esc(p.meta.weather||'No wind data synced')}</span>
      <span>• <b>Selected Ramp</b>: <b style="color:#0d4f8b">${esc(p.meta.ramp||'No ramp selected yet')}</b></span>
      <span>• <b>Note</b>: ${p.meta.ramp ? '<span style="color:#94a3b8">Ramp was manually selected on the Plan tab. TrollMap does not yet auto-recommend a ramp based on wind/fetch — verify shelter and launch conditions yourself before committing.</span>' : '<span style="color:#c62828">No ramp selected — choose one on the Plan tab.</span>'}</span>
    </div>
  </div>
</div>
<div class="rp-callout rp-warn">
  <b>⚓ Run every bait AT or slightly ABOVE the fish, never exactly on bottom.</b><br>
  Stripers feed up. A bait a few feet over their heads gets slammed; dragging bottom exactly just snags. <b>A snag = shorten line next pass.</b>
</div>

${rationaleHtml ? `<h2>5.5 · Smart Plan Rationale</h2>${rationaleHtml}` : ''}

${castRodsHtml}

${unifiedPreviewHtml}

<h2>6 · The Professional Spread — Rod by Rod</h2>
<table>
  <thead><tr style="background:#eef4fa">
    <th>#</th><th>Side</th><th>Pos</th><th>Rod Architecture</th><th>Reel / Line Calibration</th><th>Lure / Lure Model</th><th>Pattern Color</th><th>Target Depth</th><th>Lead Let-Out</th><th>Tactical Notes</th>
  </tr></thead>
  <tbody>${spreadRows||'<tr><td colspan="10" style="color:#888">No rods configured</td></tr>'}</tbody>
</table>
<p class="rp-small" style="margin-top:4px">Port = Left side of cockpit · Starboard = Right side of cockpit</p>

${trollTimeRows?`<h3>Lane Telemetry — Every Leg, Read Off The Plan</h3>
<table><thead><tr style="background:#eef4fa"><th>Leg</th><th>What it is</th><th>Distance</th><th>Speed</th><th>Run Time</th><th>Battery</th></tr></thead>
<tbody>${trollTimeRows}</tbody></table>
<p class="rp-small">Every figure here is the plan's own — the same lengths, speeds and estimates the timeline shows. A troll leg's run time includes its cast stops. ${p.batteryCurve?esc(p.batteryCurve):''}</p>`:''}

${p.meta.structure?`<h2>🗺 Structure Notes Per Lane</h2>
<pre style="white-space:pre-wrap;font-family:inherit;background:#f7f9fb;padding:10px;border-radius:6px;font-size:13px;border-left:4px solid #0d4f8b">${esc(p.meta.structure)}</pre>`:''}

<h2>7 · Colors Per Lure — ${esc(clarity)} Water</h2>
<table>
  <thead><tr style="background:#eef4fa"><th>Lure Profile</th><th>Primary Color</th><th>Backup / Change-Up</th></tr></thead>
  <tbody>${colorRows}</tbody>
</table>

<h2>8 · Swimbait Sizing — Match the Hatch</h2>
<div class="rp-callout rp-info">
  <b>Water temp ${p.meta.waterTemp||'—'}°F → ${swimHatch}</b><br>${swimNote}
</div>

${arigRows ? `
<h2>9 · Tactical Umbrella Rig Breakdown</h2>
<table>
  <thead><tr style="background:#eef4fa"><th>Rod / Lane</th><th>Rig Framework Weight</th><th>Trailer Profile Size</th><th>Tactical Keel Jigheads</th><th>Color Pattern</th><th>Target Depth / Wire Lead</th></tr></thead>
  <tbody>${arigRows}</tbody>
</table>` : ''}

${(p.gpx.waypoints||p.gpx.tracks) ? `
<h2>10 · Waypoints &amp; Operational Tracks Summary</h2>
<div class="rp-grid2">
  <div>
    <h3>Waypoints (${p.gpx.waypoints})</h3>
    <table><thead><tr style="background:#eef4fa"><th>Name</th><th>Lat</th><th>Lon</th></tr></thead>
    <tbody>${wpRows||'<tr><td colspan="3" style="color:#888">None</td></tr>'}</tbody></table>
  </div>
  <div>
    <h3>Tracks (${p.gpx.tracks})</h3>
    <table><thead><tr style="background:#eef4fa"><th>Name</th><th>GPS Points</th></tr></thead>
    <tbody>${trkRows||'<tr><td colspan="2" style="color:#888">None</td></tr>'}</tbody></table>
  </div>
</div>` : ''}

<h2>🔋 Telemetry — Core LiFePO4 Battery Scenarios (${battAh}Ah Baseline)</h2>
<table style="border:2px solid var(--accent)">
  <thead><tr style="background:#eef4fa"><th>Operational Trolling Scenario</th><th>Current Draw Profile</th><th>Actual actual usable Flight Time (80% Usable)</th></tr></thead>
  <tbody>${activeLiveBleRow}${battScenarios}</tbody>
</table>
<p class="rp-small">Reserve 20% (${Math.round(battAh*0.2)}Ah) — never run below 20% on LiFePO4. Return when indicator hits 20%.</p>

${sonarRows?`<h2>📡 Set These On The ${esc(sonarUnit)}</h2>
<p class="rp-small">Sonar Setup &gt; Alarms &gt; Contour, and Layers &gt; Chart &gt; Depth &gt; Depth Shading. Reset both at each leg change — the cue line at the leg start carries the numbers.</p>
<table>
  <thead><tr style="background:#eef4fa"><th>Leg</th><th>Charted line</th><th>Contour alarm (shallow / deep)</th><th>Depth shading</th></tr></thead>
  <tbody>${sonarRows}</tbody>
</table>`:''}

${regsRows?`<h2>📋 SC Fishing Regulations — ${esc(lakeForRegs.split(',')[0]||'Selected Lake')}</h2>
<table>
  <thead><tr style="background:#eef4fa"><th>Species</th><th>Season</th><th>Size Limit</th><th>Bag Limit</th><th>Notes</th></tr></thead>
  <tbody>${regsRows}</tbody>
</table>
<p class="rp-small">Source: SCDNR / SC Code § 50-13 via <a href="https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits" target="_blank">eRegulations – SC Freshwater Size & Possession Limits</a>. Always verify current regulations at <strong>eregulations.com/southcarolina/fishing</strong> and <strong>dnr.sc.gov</strong> before fishing. Emergency closures may apply.</p>`:''}

${advisoryBlock}

<h2>🎣 WHEN A FISH IS IN THE BOAT — the thirty seconds that make the next plan smarter</h2>
<div class="rp-callout rp-warn" style="border-left-width:6px">
  <b style="font-size:15px">1 · MARK IT ON THE UNIT. Before the hook comes out.</b><br>
  A fish you did not mark is a fish this plan can never learn from. The mark is the only thing
  that ties the catch to the water — the leg, the depth, the structure it came off.
  <br><br>
  <b style="font-size:15px">2 · GET THE LURE IN A PHOTO.</b><br>
  Lay it on the board beside the fish and shoot one frame, or shoot the fish and then the lure
  separately — either works. <b>What matters is that the lure is on camera before it goes back in
  the water</b>, because a catch with no lure attached to it can tell the next plan where the fish
  was and not what took it. Two separate shots inside about 90 seconds get paired by timestamp on
  their own; one combined shot needs nothing paired at all.
  <br><br>
  <span class="rp-small">Why it is worth the thirty seconds: every marked catch with a named
  lure is one more row that outranks the model next time this water is planned. The research
  profile is a starting guess. <b>Your catch history is the correction, and it wins.</b></span>
</div>

<h2>🐟 Fish-Fight Protocol</h2>
<table>
  <tr><th>Hit on</th><th>Immediate</th><th>Secondary</th></tr>
  <tr><td>Rod (any)</td><td>Reduce motor to 1.5 mph</td><td>Reel the other rod halfway — prevents sag to bottom</td></tr>
  <tr><td>Snag</td><td>0.5 mph, side pressure</td><td>Back motor toward snag; check hooks. Shorten line on next pass for that lane.</td></tr>
</table>

<h2>✅ Pre-Launch Checklist &amp; Safety</h2>
<div class="rp-grid2">
  <div>
    <h3>Tackle / Bait</h3>
    <pre style="white-space:pre-wrap;font-family:inherit;background:#f7f9fb;padding:8px;border-radius:6px;margin:4px 0;font-size:13px">${esc(p.tackle||'(none)')}</pre>
  </div>
  <div>
    <h3>Safety / Kayak</h3>
    <pre style="white-space:pre-wrap;font-family:inherit;background:#f7f9fb;padding:8px;border-radius:6px;margin:4px 0;font-size:13px">${esc(p.safety||'(none)')}</pre>
  </div>
</div>

${p.notes?`
<h2>📝 Notes</h2>
<div style="background:#f7f9fb;padding:10px;border-radius:6px;white-space:pre-wrap;font-size:13px">${esc(p.notes)}</div>`:''}

${state.CATCHES.length?`
<h2>📓 Catch Journal (${state.CATCHES.length} entries)</h2>
<table>
  <thead><tr style="background:#eef4fa"><th>Time</th><th>Species</th><th>Size</th><th>Depth</th><th>Lure / Color</th><th>Lead</th><th>Notes</th></tr></thead>
  <tbody>${state.CATCHES.filter(c=>!p.meta.date||c.date===p.meta.date).map(c=>`<tr>
    <td>${esc(c.time||'')}</td>
    <td><b>${esc(c.species||'')}</b></td>
    <td>${c.length?c.length+'"':''}</td>
    <td>${c.depth?c.depth+' ft':''}</td>
    <td>${esc(c.lure||'')}</td>
    <td>${c.lead?c.lead+' ft':''}</td>
    <td class="rp-small">${esc(c.notes||'')}${c.photo ? `<br><img src="${c.photo}" style="max-height:80px;border-radius:4px;margin-top:6px;border:1px solid #ccc;box-shadow:0 2px 6px rgba(0,0,0,0.2)">` : ''}</td>
  </tr>`).join('')||'<tr><td colspan="7" class="muted">No catches for this trip date</td></tr>'}</tbody>
</table>`:''}

</div><!-- /report-body -->
<div class="rp-footer">
  Generated by TrollMap GPX Studio v3 · ${new Date().toLocaleString()} · ${p.gpx.waypoints} wpts · ${p.gpx.tracks} tracks
</div>
</div><!-- /report-page -->`;
}


export function renderPlanStats(){
  document.getElementById('planWpts').textContent=state.DATA.waypoints.length;
  document.getElementById('planTrks').textContent=state.DATA.tracks.length;
  const pts=state.DATA.tracks.reduce((a,t)=>a+t.pts.length,0);
  document.getElementById('planPts').textContent=pts;
  let dist=0;
  state.DATA.tracks.forEach(t=>{ 
    for(let i=1;i<t.pts.length;i++) dist+=distFt(t.pts[i-1],t.pts[i]); 
  });
  document.getElementById('planDist').textContent=(dist/6076.12).toFixed(2);
  const groups={};
  state.DATA.waypoints.forEach(w=>{ 
    const k=(w.name||'').replace(/\d.*$/,'').trim()||'(other)'; 
    groups[k]=(groups[k]||0)+1; 
  });
  const el=document.getElementById('planGroups');
  if(el) el.innerHTML=Object.keys(groups).sort().map(k=>`<span class="pill">${esc(k)}: ${groups[k]}</span>`).join(' ') || '<span class="muted">No groups</span>';
}

/* Plan UI wiring lives in plan-tab-wiring.js, which says so in its own header: "Replaces the
   old 3-tab (Builder / Preview / Library) wiring in plan-builder.js". The replacement landed
   and the original did not leave, so BOTH bound the same buttons. The old one toggled
   #plan-builder hidden unless the tab was called `builder`, and the first tab is called
   `plan` -- so every click on Smart Plan hid the Smart Plan panel, and the only reason the
   tab worked is that plan-tab-wiring.js is imported second and un-hid it on the same click.
   The old backToBuilderBtn handler queried `[data-plansub="builder"]`, which has matched
   nothing since the rebuild, and called .click() on it with no `?.` -- a TypeError on every
   press of a button that appeared to work, because a throw in one listener does not stop the
   others. Deleted 2026-08-30. One owner. */


/* ---------- Plan tab lake/ramp dropdowns (lakes + rivers merged) ---------- */

/**
 * `slug` ADDED 2026-08-14, AND IT IS WHAT STOPS THESE BEING LISTED TWICE.
 *
 * These six entries predate the registry serving rivers. They are not chartpacks -- selecting
 * one switches the tab into river mode, filling gauge, flow, rise, surge ETA and schedule, and
 * carrying a parent lake for level data plus ramps annotated by hand ("Lugoff, just below dam",
 * "William Dennis, temporarily closed"). None of that exists anywhere else.
 *
 * Then the live DNR ramps reached the planner filter (e098c9d) and the registry rows for the
 * SAME water started passing it, because they finally had ramps. Ryan, 2026-08-14: "planning one
 * has the hard coded rivers still in it so they are actually in there twice." Two entries per
 * river, same name, one with gauges and no contours and one with contours and no gauges.
 *
 * His call was to MERGE rather than pick a winner, which is right -- they are complementary, not
 * redundant. So the river entry now names its registry slug, the picker drops the registry row
 * that a river entry already claims, and the pack resolves through planWaterKey() below. One
 * entry, tailwater conditions AND trolling lanes.
 *
 * COOPER IS HONESTLY PARTIAL. Its label spans "Pinopolis tailrace -> Charleston Harbor" and no
 * single registry row covers that; `tail_race_canal` is the tailrace half, charted 0.94, and the
 * harbour end is coast_charleston_sc. The slug gives it a pack for the water you would troll and
 * does not pretend to cover the rest.
 */
const PLAN_RIVERS = [
  { key:'wateree', slug:'wateree_river', label:'Wateree River', worker:'wateree', center:[34.24,-80.65,11], lakeKey:'Lake Wateree', ramps:[
    {name:'Lugoff (just below dam)', lat:34.33346, lon:-80.69973},
    {name:'Highway 1 (Camden / USGS gauge)', lat:34.24486, lon:-80.65403},
    {name:'WT Billy Tolar (mid-river)', lat:33.94721, lon:-80.62891},
  ]},
  { key:'congaree', slug:'congaree_river', label:'Congaree River', worker:'congaree', center:[33.99,-81.05,11], ramps:[
    {name:'Barney Jordan (Columbia)', lat:33.96490, lon:-81.03570},
    {name:'Thomas H Newman (Columbia)', lat:33.94915, lon:-81.02951},
    {name:'Bates Bridge (near Wateree confluence)', lat:33.75342, lon:-80.64513},
  ]},
  { key:'saluda', slug:'saluda_river_lower_saluda', label:'Lower Saluda River (cold tailwater)', worker:'saluda', center:[34.02,-81.19,12], lakeKey:'Lake Murray', ramps:[
    {name:'Hope Ferry', lat:34.04600, lon:-81.19128},
    {name:'Saluda Shoals Park', lat:34.04679, lon:-81.19058},
    {name:'Saluda Shoals Lower Boat Ramp', lat:34.04333, lon:-81.16340},
  ]},
  { key:'broad', slug:'broad_river_2', label:'Broad River', worker:'broad', center:[34.59,-81.42,11], ramps:[
    {name:'Pick Hill Access', lat:35.04108, lon:-81.49538},
    {name:'99 Island', lat:35.02678, lon:-81.48986},
    {name:"Dalton's Landing", lat:34.93595, lon:-81.47303},
    {name:'Woods Ferry Recreation Area', lat:34.70321, lon:-81.45383},
    {name:'Sandy & Broad River', lat:34.57281, lon:-81.42221},
    {name:'Shelton Ferry', lat:34.48854, lon:-81.42429},
  ]},
  { key:'santee', slug:'santee_river', label:'Santee River', worker:'santee', center:[33.42,-80.01,11], lakeKey:'Lake Marion', ramps:[
    {name:'Wilsons (near Marion dam)', lat:33.44829, lon:-80.15833},
    {name:'Highway 52', lat:33.49487, lon:-79.96049},
    {name:'Arrowhead Landing', lat:33.40441, lon:-79.86331},
    {name:'Lenuds', lat:33.30431, lon:-79.67896},
    {name:'McConnels', lat:33.24514, lon:-79.52085},
  ]},
  { key:'cooper', slug:'tail_race_canal', label:'Cooper River (Pinopolis tailrace → Charleston Harbor)', worker:'cooper', center:[33.04,-79.95,11], lakeKey:'Lake Moultrie', fishingSystem:'Cooper River system (Pinopolis tailrace → Charleston Harbor)', ramps:[
    {name:'William Dennis (Pinopolis tailrace) ⚠ temporarily closed for renovations', lat:33.21311, lon:-79.97347},
    {name:'Rembert C Dennis (Wadboo Creek)', lat:33.19601, lon:-79.95324},
    {name:'Huger Park (upper Cooper)', lat:33.13111, lon:-79.81111},
    {name:'John R Bettis (Goose Creek)', lat:32.93278, lon:-80.02266},
    {name:'Bushy Park - Fresh Water (Back River)', lat:32.96781, lon:-79.93751},
    {name:'Bushy Park - Salt Water (Cooper)', lat:32.96708, lon:-79.93709},
    {name:"R. M. Hendrick's / Virginia Av. Park (Charleston harbor)", lat:32.89113, lon:-79.97103},
  ]},
];
window.PLAN_RIVERS = PLAN_RIVERS;
export function isPlanRiverValue(v){ return String(v||'').startsWith('river:'); }

/**
 * Picker value -> R2 key, for the three places that ask what pack the selection means.
 *
 * `resolveR2Key('river:wateree')` is null -- it has never seen that shape -- so every river
 * selection resolved to no pack at all. That was invisible while rivers had no packs; now they
 * do, and it is the difference between the merged entry loading contours and not.
 */
/**
 * IS THE SELECTED WATER A RIVER -- all 90 of them, not the 6 with a hardcoded entry.
 *
 * Ryan, 2026-08-14: "all rivers should show gauges not just those 5 what is the point of having
 * them" and "river mode should be for all rivers".
 *
 * `isPlanRiverValue` answers a narrower question than its name suggests: it tests for the
 * `river:` VALUE PREFIX, which only the six PLAN_RIVERS entries carry. Every other river in the
 * registry -- Great Pee Dee, Edisto, Lynches, the Catawba, 84 more -- selected as an ordinary
 * lake and got the pool-level fields and no river panel, which is wrong about all of them.
 *
 * It stays as it is, because `getPlanRiverDef()` depends on that prefix meaning exactly what it
 * says. This is the separate question, asked of the registry, and it drives the MODE.
 *
 * THE PANEL WILL BE EMPTY FOR MOST OF THEM UNTIL THE BINDER RUNS, and that is the honest state
 * rather than a reason to keep hiding it: 90 river rows, ZERO with a usgs/duke/dominion
 * binding, and water_bindings.json holds two lakes from 2026-08-06. An empty gauge box on the
 * Edisto is a visible missing binding; the pool-level box was a wrong one.
 */
export function isRiverWater(v){
  if (isPlanRiverValue(v)) return true;
  const rec = registryRecordFor(v || '');
  return !!rec && rec.featureType === 'river';
}

export function planWaterKey(v){
  if (isPlanRiverValue(v)) {
    const def = getPlanRiverDef(v);
    return (def && def.slug) || null;
  }
  return resolveR2Key(v || '');
}
export function getPlanRiverDef(v){ const key=String(v||'').replace(/^river:/,''); return PLAN_RIVERS.find(r=>r.key===key||r.worker===key); }
// isDukePlanLakeName() and getPlanLakeLevelUnit() were here. They were the FOURTH copy of the
// nine-name Duke list in this codebase, matched with `clean.includes(k)||k.includes(clean)` --
// so "mountain island" also claimed anything containing it -- and what they decided was the
// UNIT the whole plan rendered in. Levels are feet on every lake now, from /conditions.
function getPlanRiverRamps(def){
  if(!def) return [];
  if(def.fishingSystem && typeof window.getFishingRamps === 'function'){
    const overlay = window.getFishingRamps(def.fishingSystem);
    if(overlay && overlay.length){
      return overlay.map(r=>({
        name: r.note ? `${r.name} (${r._annotation || r._scdnrKey || ''}) ${r.note}`
             : r._annotation ? `${r.name} (${r._annotation})`
             : r._scdnrKey ? `${r.name} (${r._scdnrKey})`
             : r.name,
        lat:r.lat, lon:r.lon
      }));
    }
  }
  return def.ramps || [];
}
function getSelectedPlanRiverRamp(){
  const def = getPlanRiverDef(document.getElementById('planLake')?.value);
  const name = document.getElementById('planRamp')?.value;
  if(!def || !name) return null;
  return getPlanRiverRamps(def).find(r => r.name === name)
      || getPlanRiverRamps(def).find(r => r.name.toLowerCase().includes(String(name||'').toLowerCase()) || String(name||'').toLowerCase().includes(r.name.toLowerCase().split(' (')[0]))
      || null;
}
function setLakeOnlyFieldsVisible(show){
  ['planFullPool','planPoolLevel'].forEach(id=>{
    const el=document.getElementById(id);
    // Only hide the parent if it's a visible container, not the whole inputs card
    if(el && el.parentElement && el.type !== 'hidden') el.parentElement.style.display = show ? '' : 'none';
  });
  const box=document.getElementById('utilityAssessmentBox');
  if(box && !show) box.style.display='none';
  const riverBox=document.getElementById('planRiverFields');
  if(riverBox) riverBox.style.display = show ? 'none' : 'block';
  const title=document.querySelector('#conditionsCard h4');
  if(title) title.innerHTML = show ? '🌊 Live Water Conditions &amp; Pool Elevation' : '🌊 Live River Conditions, Dam Schedule &amp; Kayak Safety';
  const btn=document.getElementById('syncDukeBtn');
  if(btn) btn.textContent = show ? '⚡ Live Utility Sync' : '⚡ Live River Sync';
}
export async function populatePlanLakeDropdown(){
  const sel = document.getElementById('planLake');
  if(!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— choose lake or river —</option>';
  const lakesGroup = document.createElement('optgroup');
  lakesGroup.label = 'Lakes / Reservoirs';
  
  // Wait for the async worker fetch to populate the global index before asking for the names!
  let lakeNames = [];
  if (window.getUniversalLakeNamesAsync) {
    lakeNames = await window.getUniversalLakeNamesAsync();
  } else if (window.getUniversalLakeNames) {
    lakeNames = window.getUniversalLakeNames();
  } else {
    // Was Object.keys(LAKE_DB).sort() -- a SEVENTH lake list in the UI, 50 curated names,
    // silently different from the map toolbar's. Same registry, same filter, same list.
    lakeNames = lakeNamesForPicker();
  }

  if (lakeNames.length === 0) {
    lakeNames = lakeNamesForPicker();
  }

  // THIS DROPDOWN HAD NO FILTER OF ANY KIND ON IT.
  //
  // `#lakeSelect` on the map toolbar has had state, size, has-ramp and well-charted controls for
  // weeks. `#planLake` — the one you build a day from — took every name the access index returned,
  // 1,196 of them, including the 424 that carry no registry record at all because they arrive
  // live from the DNR ramp feeds. Ryan, 2026-08-11: "i dont think the DNR feeds are going through
  // your filter... then once you fix that in all 3 places i will probably be happy."
  //
  // The planner preset is stricter than the map's on purpose: you cannot plan a trolling day on
  // water with no contours and nowhere to launch, and every such name here is a dead end you have
  // to click to discover. KEEP_ALWAYS still runs first inside the predicate.
  const plannable = makePredicate('planner', null);
  // A river entry below already offers this water, with gauges on top of the pack. Listing the
  // registry row as well is the duplicate Ryan reported on 2026-08-14.
  const claimedByRiver = new Set(PLAN_RIVERS.map(r => r.slug).filter(Boolean));
  let dropped = 0;
  lakeNames.forEach(lakeName => {
    if (isCoastalKey(resolveR2Key(lakeName))) return;
    if (claimedByRiver.has(resolveR2Key(lakeName))) return;
    if (!plannable(registryRecordFor(lakeName), lakeName)) { dropped += 1; return; }
    const opt = document.createElement('option');
    opt.value = lakeName; opt.textContent = lakeName;
    lakesGroup.appendChild(opt);
  });
  if (dropped) {
    console.info('[plan] %d water(s) left out of the planner picker — no bathymetry, no ramp, or '
               + 'not in the registry at all', dropped);
  }
  sel.appendChild(lakesGroup);
  const riversGroup = document.createElement('optgroup');
  riversGroup.label = 'Rivers / Tailwaters';
  PLAN_RIVERS.forEach(r => {
    const opt = document.createElement('option');
    opt.value = `river:${r.key}`; opt.textContent = r.label;
    riversGroup.appendChild(opt);
  });
  sel.appendChild(riversGroup);

  // Coastal / tidal zones, grouped by state. These come from the generated
  // catalog rather than the worker access index, which only indexes inland
  // DNR boat ramps and has no coastal coverage.
  appendCoastalOptgroups(sel);

  if(current) sel.value = current;
  setLakeOnlyFieldsVisible(!isRiverWater(sel.value));
}

export function populatePlanRampDropdown(waterbodyName){
  const sel = document.getElementById('planRamp');
  if(!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— select ramp / launch —</option>';
  if(isPlanRiverValue(waterbodyName)){
    const def = getPlanRiverDef(waterbodyName);
    getPlanRiverRamps(def).forEach(r=>{
      const opt=document.createElement('option');
      opt.value=r.name; opt.textContent=r.name;
      sel.appendChild(opt);
    });
    if(current) sel.value = current;
    return;
  }
  // THE ACCESS INDEX IS FOR EVERY WATER, NOT JUST COASTAL ONES.
  //
  // This branch used to be gated on `isCoastalKey`, so a lake fell through to
  // `lakeDbEntryFor(...).ramps` -- and that getter is `r.ramps?.curated || r.ramps?.natl || []`,
  // a first-match chain that never reaches `osm` at all and, on any lake carrying a curated
  // list, never reaches `natl` either. Measured against the shipped index on 2026-08-12: the
  // 38 lakes with a curated list showed 97 launches here while hiding 456 `natl` and 381 `osm`.
  // Lake Sidney Lanier offered TWO ramps out of 106. Thurmond four out of 73.
  //
  // Meanwhile `access-index.js` already merges the live Worker `/ramps` feed -- SCDNR, NCWRC,
  // GA WRD and TWRA, ~2,040 state-agency launches -- with `natl`, `osm` and the registry into
  // one `byLake` map, and `lake-ramp-select.js` and `smart-plan-v2-wiring.js` have both been
  // reading it that way all along. This was one module on the narrow path while three were on
  // the wide one; it is not new machinery, it is the same call the branch above already makes.
  //
  // Order of preference, unchanged in spirit: the loaded index first, then whatever static list
  // the water has, so a picker opened before the index finishes loading still offers something.
  const coastalKey = planWaterKey(waterbodyName || '');
  const isCoastal = isCoastalKey(coastalKey);
  let accessPoints = [];
  if (waterbodyName && window.getLoadedAccessIndex) {
    const idx = window.getLoadedAccessIndex();
    accessPoints = idx?.byLake?.get(waterbodyName) || [];
  }

  if (!accessPoints.length) {
    // Fallbacks, only until the index is loaded: the coastal zone's own list, or the registry
    // record. `lakeDbEntryFor` stays the lake fallback so a cold picker is never empty.
    if (isCoastal) {
      const zone = COASTAL_ZONES[coastalKey];
      accessPoints = Object.entries((zone && zone.ramps) || {})
        .map(([name, coords]) => ({ name, lat: coords[0], lon: coords[1] }));
    } else {
      const wbEntry = waterbodyName ? lakeDbEntryFor(waterbodyName) : null;
      accessPoints = Object.entries((wbEntry && wbEntry.ramps) || {})
        .map(([name, coords]) => ({ name, lat: coords[0], lon: coords[1] }));
    }
  }

  // FOUR SOURCES MERGED MEANS THE SAME RAMP ARRIVES MORE THAN ONCE. The state agency, the
  // national layer and OSM all name Dreher Island; a dropdown that lists it three times is
  // worse than one that lists it once. Collapse on the name, and on position within ~60 m for
  // the case where two agencies spell it differently -- keeping the FIRST, because
  // access-index.js already adds the registry and live-feed points in preference order.
  const seenName = new Set();
  const kept = [];
  for (const p of accessPoints) {
    const nm = String((p && p.name) || '').trim();
    if (!nm) continue;
    const key = nm.toLowerCase();
    if (seenName.has(key)) continue;
    if (Number.isFinite(p.lat) && Number.isFinite(p.lon)
        && kept.some((q) => Number.isFinite(q.lat)
          && Math.hypot((p.lon - q.lon) * 111 * Math.cos(p.lat * Math.PI / 180),
                        (p.lat - q.lat) * 111) < 0.06)) {
      continue;
    }
    seenName.add(key);
    kept.push({ ...p, name: nm });
  }
  kept.sort((a, b) => a.name.localeCompare(b.name));

  kept.forEach((point) => {
    const opt = document.createElement('option');
    opt.value = point.name; opt.textContent = point.name;
    // The coords ride ON THE OPTION. The change handler used to look the name back up in
    // `lakeDbEntryFor(...).ramps`, which only works while the names in the dropdown come from
    // that same object -- the moment a launch arrives from the live DNR feed the lookup misses
    // and the map does not move. dataset is how the coastal branch already carried them.
    if (Number.isFinite(point.lat)) opt.dataset.lat = point.lat;
    if (Number.isFinite(point.lon)) opt.dataset.lon = point.lon;
    sel.appendChild(opt);
  });
  if(current) sel.value = current;
}

document.getElementById('planLake')?.addEventListener('change', e=>{
  const v=e.target.value;
  const isRiver=isPlanRiverValue(v);
  const coastalKey=planWaterKey(v);
  const isCoastal=isCoastalKey(coastalKey);
  setLakeOnlyFieldsVisible(!isRiver && !isCoastal);
  populatePlanRampDropdown(v);
  if(isRiver){
    ['planFullPool','planPoolLevel'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
    const def=getPlanRiverDef(v);
    if(def && state.MAP_OK) state.MAP.setView([def.center[0], def.center[1]], def.center[2]||11);
    if(window.syncPlanRiverData) window.syncPlanRiverData();
  } else if (isCoastal) {
    ['planFullPool','planPoolLevel'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
    ['planRiverSafety','planRiverFlow','planRiverGauge','planRiverTemp','planRiverRise','planRiverSurgeEta','planRiverSchedule','planRiverSummary'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
    const zone = COASTAL_ZONES[coastalKey];
    if (zone && state.MAP_OK) {
      landOnCoastalZone(state.MAP, zone);
    }
    // Auto-run lake intelligence and clarity forecast
    if(window.syncLakeIntelData) setTimeout(window.syncLakeIntelData, 500);
    if(window.syncClarityIntelData) setTimeout(window.syncClarityIntelData, 800);
  } else {
    ['planRiverSafety','planRiverFlow','planRiverGauge','planRiverTemp','planRiverRise','planRiverSurgeEta','planRiverSchedule','planRiverSummary'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
    // Was LAKE_DB[v] -- an exact-key hit against the 50 curated names, so selecting any of
    // the other ~380 shipped lakes left the map wherever it was. Registry lookup covers all
    // of them; center is derived from the registry geometry, so guard it rather than trust it.
    const lk = lakeDbEntryFor(v);
    if(lk && Number.isFinite(lk.center[0]) && Number.isFinite(lk.center[1]) && state.MAP_OK)
      state.MAP.setView([lk.center[0], lk.center[1]], lk.center[2]||11);
    // Trigger utility sync (Duke/USGS lake levels) when lake changes
    if(window.syncUtilityData) {
      setTimeout(window.syncUtilityData, 300);
    } else {
      setTimeout(()=>{ document.getElementById('syncDukeBtn')?.click(); }, 300);
    }
    // Auto-run lake intelligence and clarity forecast
    if(window.syncLakeIntelData) setTimeout(window.syncLakeIntelData, 500);
    if(window.syncClarityIntelData) setTimeout(window.syncClarityIntelData, 800);
  }
});

document.getElementById('planRamp')?.addEventListener('change', e=>{
  const waterbodyName = document.getElementById('planLake').value;
  const rampName = e.target.value;
  if(isPlanRiverValue(waterbodyName)){
    const ramp = getSelectedPlanRiverRamp();
    if(ramp && state.MAP_OK) focusRamp(state.MAP, ramp.lat, ramp.lon);
    if(window.syncPlanRiverData) window.syncPlanRiverData();
    return;
  }
  if(!waterbodyName || !rampName) return;
  // The selected option carries its own coordinates (see populatePlanRampDropdown). Read them
  // first: a launch from the live DNR feed is not in `lakeDbEntryFor(...).ramps` and never will
  // be, so a name lookup there silently fails to move the map. Keep the lookup as a fallback for
  // an option rendered before this change shipped.
  const optEl = e.target.selectedOptions && e.target.selectedOptions[0];
  const dLat = optEl ? Number(optEl.dataset.lat) : NaN;
  const dLon = optEl ? Number(optEl.dataset.lon) : NaN;
  const coords = (Number.isFinite(dLat) && Number.isFinite(dLon))
    ? [dLat, dLon]
    : lakeDbEntryFor(waterbodyName)?.ramps?.[rampName];
  if(coords && state.MAP_OK) state.MAP.setView(coords, 15);
});

window.syncPlanRiverData = async function syncPlanRiverData(){
  const sel = document.getElementById('planLake');
  const def = getPlanRiverDef(sel?.value);
  if(!def) return null;
  setLakeOnlyFieldsVisible(false);
  const statusEl = document.getElementById('utilitySyncStatus');
  const btn = document.getElementById('syncDukeBtn');
  const worker = (typeof CF_WORKER_URL !== 'undefined' ? CF_WORKER_URL : (window.CF_WORKER_URL || 'https://trollmap-worker.colonal1981.workers.dev'));
  const ramp = getSelectedPlanRiverRamp();
  function put(id, val){ const el=document.getElementById(id); if(el) el.value = val == null ? '' : String(val); }
  try{
    if(statusEl){ statusEl.textContent='Syncing river…'; statusEl.style.color='var(--accent2)'; }
    if(btn){ btn.style.background='var(--accent)'; btn.style.color='#000'; }
    let url = `${worker}/river?river=${encodeURIComponent(def.worker)}`;
    if(ramp) url += `&lat=${encodeURIComponent(ramp.lat)}&lon=${encodeURIComponent(ramp.lon)}`;
    const res = await fetch(url);
    if(!res.ok) throw new Error(`Worker HTTP ${res.status}`);
    const d = await res.json();
    const primary = (d.gauges||[]).find(g=>g.primary) || (d.gauges||[])[0] || {};
    const assess = d.kayak_assessment || {};
    let effectiveStatus = assess.status || 'unknown';
    let tripWindowNote = '';
    // If the only river concern is a scheduled surge that arrives well after
    // the planned return time, display it as informational instead of forcing
    // the whole trip to CAUTION.
    try {
      const dateStr = document.getElementById('planDate')?.value;
      const retStr = document.getElementById('planReturnTime')?.value || '12:00';
      if(dateStr && d.user_location?.surge_arrival_epoch && effectiveStatus === 'caution'){
        const tripEnd = new Date(`${dateStr}T${retStr}:00`).getTime();
        const surgeEpoch = d.user_location.surge_arrival_epoch;
        const hasOnlySurgeCaution = (assess.reasons||[]).some(r=>/dam surge/i.test(r)) && !(assess.reasons||[]).some(r=>/RAPID RISE|DANGER zone|PUSHY|cold-water/i.test(r));
        if(hasOnlySurgeCaution && surgeEpoch > tripEnd + 60*60*1000){
          effectiveStatus = 'go';
          tripWindowNote = 'Scheduled surge is after planned return window; verify if trip runs late.';
        }
      }
    } catch (err) {
      // Dam-surge timing relative to the trip window. Failing here leaves the stricter
      // original status in place, which is the safe direction -- but say why it was not
      // relaxed rather than letting it look like the surge was never considered.
      console.warn('[plan-builder] surge-window check failed, keeping the stricter status:', err);
    }
    const status = effectiveStatus ? effectiveStatus.toUpperCase() : 'UNKNOWN';
    const icon = effectiveStatus==='no-go' ? '🛑 ' : effectiveStatus==='caution' ? '⚠️ ' : effectiveStatus==='go' ? '✅ ' : '';
    put('planRiverSafety', icon + status);
    put('planRiverFlow', primary.streamflow_cfs != null ? `${primary.streamflow_cfs} cfs` : '');
    put('planRiverGauge', primary.gage_height_ft != null ? `${primary.gage_height_ft} ft` : '');
    put('planRiverTemp', primary.water_temperature_F != null ? `${primary.water_temperature_F} °F` : '');
    put('planRiverRise', primary.rate_of_rise_ft_per_hr != null ? `${primary.rate_of_rise_ft_per_hr} ft/hr` : '');
    if(primary.water_temperature_F != null) put('planWaterTemp', primary.water_temperature_F);
    let surge = '';
    if(d.user_location?.surge_arrival_epoch){
      const mins=d.user_location.minutes_until_surge_at_user;
      const when=new Date(d.user_location.surge_arrival_epoch).toLocaleString('en-US',{timeZone:'America/New_York',weekday:'short',hour:'numeric',minute:'2-digit'});
      surge = `${when} ET (${mins>0?'in ':''}${Math.round(mins)} min, ${d.user_location.surge_severity_label} severity)`;
    } else if(d.dam_schedule?.next?.arrivalEpoch){
      const mins=Math.round((d.dam_schedule.next.arrivalEpoch-Date.now())/60000);
      const when=new Date(d.dam_schedule.next.arrivalEpoch).toLocaleString('en-US',{timeZone:'America/New_York',weekday:'short',hour:'numeric',minute:'2-digit'});
      surge = `${when} ET at ${d.dam_schedule.next.mileMarkerName} (${mins>0?'in ':''}${mins} min)`;
    }
    put('planRiverSurgeEta', surge);
    const scheduleLines=[];
    if(d.dam_schedule?.type==='duke_flow_arrivals'){
      scheduleLines.push('Duke scheduled flow arrivals:');
      (d.dam_schedule.upcoming||[]).slice(0,6).forEach(ev=>{
        const when=new Date(ev.arrivalEpoch).toLocaleString('en-US',{timeZone:'America/New_York',weekday:'short',hour:'numeric',minute:'2-digit'});
        scheduleLines.push(`• ${when} ET — ${ev.mileMarkerName} (${ev.damName})`);
      });
    } else if(d.dam_schedule?.type==='dominion_color_status'){
      scheduleLines.push(`Dominion Lower Saluda color status: current ${d.dam_schedule.currentColor||'n/a'}, planned ${d.dam_schedule.plannedColor||'n/a'}`);
      if(d.dam_schedule.currentRange) scheduleLines.push(d.dam_schedule.currentRange);
    }
    if(d.user_location){
      scheduleLines.push(`Your selected launch: river mile ${d.user_location.river_mile_from_dam}, nearest ${d.user_location.nearestWaypoint}, surge severity ${d.user_location.surge_severity_label}.`);
      if(tripWindowNote) scheduleLines.push(`Trip-window note: ${tripWindowNote}`);
    } else if(ramp){
      scheduleLines.push(`Selected launch: ${ramp.name}. Worker did not return location-specific surge ETA; verify ramp coordinates / river centerline coverage.`);
    } else {
      scheduleLines.push('Pick a river ramp/launch to calculate location-specific surge ETA.');
    }
    if(assess.reasons?.length){
      scheduleLines.push('Kayak safety reasons:');
      assess.reasons.forEach(r=>scheduleLines.push(`• ${r}`));
    }
    const summary = `${def.label}${ramp?` @ ${ramp.name}`:''}\nStatus: ${icon}${status}\n${scheduleLines.join('\n')}`;
    put('planRiverSchedule', scheduleLines.join('\n'));
    put('planRiverSummary', summary);
    if(statusEl){ statusEl.textContent=`✓ River synced: ${status}`; statusEl.style.color=effectiveStatus==='no-go'?'var(--bad)':effectiveStatus==='caution'?'var(--warn)':'var(--accent2)'; }
    window.LAST_PLAN_RIVER_DATA = d;
    return d;
  } catch(err){
    console.warn('River sync failed', err);
    if(statusEl){ statusEl.textContent='River sync error'; statusEl.style.color='var(--bad)'; }
    put('planRiverSchedule', `River sync failed: ${err.message}`);
    return null;
  } finally {
    if(btn) setTimeout(()=>{ btn.style.background=''; btn.style.color=''; }, 1000);
  }
};


// Expose river helpers for cross-module use
window.isPlanRiverValue = isPlanRiverValue;
window.getPlanRiverDef = getPlanRiverDef;


// ── Button wiring (was in monolith, extracted here) ──────────────────────────

/**
 * A name for the plan, built from what the form already knows.
 *
 * ONE DERIVATION, TWO CALLERS -- the 🏷 Auto button and Save. Save used to refuse an unnamed plan
 * outright, which was survivable while the name field was visible and impossible once it was not.
 * Refusing is the wrong answer either way: the app knows the water, the ramp, the date and the
 * launch time, so it can name the thing itself and let the fisherman rename it if he cares.
 */
export function autoPlanName() {
  const lake = document.getElementById('planLake')?.value.split(',')[0] || 'Lake';
  const ramp = document.getElementById('planRamp')?.value.split(' ')[0] || '';
  const date = document.getElementById('planDate')?.value;
  const time = document.getElementById('planLaunchTime')?.value;
  const hour = time ? parseInt(time.split(':')[0]) : 6;
  const session = hour < 10 ? 'AM' : hour < 14 ? 'MID' : 'PM';
  const dateShort = date ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  return `${lake}${ramp ? ' – ' + ramp : ''} ${session} Troll${dateShort ? ' ' + dateShort : ''}`;
}

document.getElementById('autoNameBtn')?.addEventListener('click', () => {
  const el = document.getElementById('planName');
  if (el) el.value = autoPlanName();
});

// STRAIGHT TO A RENDERED PREVIEW, NOT TO THE PREVIEW SUBTAB.
//
// Ryan, 2026-08-09: "you wired in a different button the one next to the json html and that went
// straight to a preview instead of the preview tab... this morning or last night when you tied
// smartplan v2 into those buttons is when it started going back to the preview tab."
//
// The `#panel-plan .subtabs [data-plansub="preview"]` pane has been broken since SmartPlan first
// landed, and this button existed precisely to route around it. Pointing it back at that pane
// when v2 was wired in undid the workaround and handed him the blank tab again.
//
// So it opens the built document in its own window, the same HTML the export writes to disk.
// Nothing on the Plan tab is touched and the broken pane is not involved.
document.getElementById('buildPreviewBtn')?.addEventListener('click', async () => {
  const p = collectPlan();
  const w = window.open('', '_blank');
  if (w) w.document.write('<p style="font:14px system-ui;color:#888;padding:20px">Building preview…</p>');
  const inner = await buildPlanPreviewHtml(p);
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8">`
            + `<title>${p.meta?.name || 'Fishing Plan'}</title></head>`
            + `<body style="background:#f3f6f9;margin:0;padding:20px">${inner}</body></html>`;
  if (w) { w.document.open(); w.document.write(doc); w.document.close(); return; }
  // Popup blocked. Fall back to the in-page pane rather than losing the preview entirely, and
  // say which one happened so a blank tab is never the only signal.
  console.warn('[plan-builder] preview popup was blocked — falling back to the in-page pane');
  const previewEl = document.getElementById('planPreviewHtml');
  if (previewEl) previewEl.innerHTML = inner;
  document.querySelector('#panel-plan .subtabs button[data-plansub="preview"]')?.click();
});

document.getElementById('printPlanBtn')?.addEventListener('click', async () => {
  const p = collectPlan();
  const previewEl = document.getElementById('planPreviewHtml');
  if (previewEl) previewEl.innerHTML = '<p style="color:#888;padding:20px">⏳ Building preview…</p>';
  document.querySelector('#panel-plan .subtabs button[data-plansub="preview"]')?.click();
  if (previewEl) previewEl.innerHTML = await buildPlanPreviewHtml(p);
  setTimeout(() => window.print(), 400);
});

document.getElementById('importPlanFile')?.addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = (ev) => {
    try {
      const p = JSON.parse(ev.target.result);
      loadPlanIntoForm(p);
      alert('Plan imported.');
    } catch (err) { alert('Invalid JSON: ' + err.message); }
  };
  r.readAsText(f);
  e.target.value = '';
});

/**
 * The D1 sync key for a plan. ONE definition, because push and delete must agree.
 *
 * They did not. The save path used `p.meta.name.replace(...) || 'plan'`, so a name made only
 * of punctuation fell back to the literal 'plan'. The delete path used
 * `(p.meta?.name || p.name || String(id)).replace(...)` with no fallback, so the same plan
 * produced an EMPTY key -- and `/sync/item/plan/` does not match the worker's item route at
 * all. Two derivations of one identifier is one too many.
 */
function planSyncKey(p, id) {
  const raw = p?.meta?.name || p?.name || (id == null ? '' : String(id));
  return raw.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'plan';
}

document.getElementById('savePlanBtn')?.addEventListener('click', async () => {
  const p = collectPlan();
  // NAME IT RATHER THAN REFUSE IT. This was `alert('Give the plan a name first.'); return;`,
  // which is a reasonable guard next to a visible name box and a dead end without one -- and the
  // box had been `type="hidden"` since July. The name is also the sync key, so an empty one would
  // collide in D1; autoPlanName() gives every plan a distinct, meaningful one from the water,
  // ramp and date, and the box above is right there to change it.
  if (!p.meta.name) {
    p.meta.name = autoPlanName();
    const el = document.getElementById('planName');
    if (el) el.value = p.meta.name;
  }
  try {
    await dbPut('plans', p);
    alert('Plan saved.');
    refreshPlanLibrary();
    // Push to cloud sync. Stable key so re-saves update the same D1 record.
    if (window.pushItemOnSave) window.pushItemOnSave('plan', planSyncKey(p), p);
  } catch (e) { alert('Save failed: ' + e); }
});

export async function refreshPlanLibrary() {
  const host = document.getElementById('planLibraryList');
  if (!host) return;
  let plans = [];
  if (dbIsReady()) {
    try {
      plans = await dbGetAll('plans');
    } catch (err) {
      // An unreadable plan store renders "No saved plans yet", which is indistinguishable
      // from having none. The user's own saved work deserves better than that.
      console.error('[plan-builder] could not read saved plans:', err);
    }
  }
  if (!plans.length) { host.innerHTML = '<p class="muted">No saved plans yet.</p>'; return; }
  plans.reverse();
  host.innerHTML = plans.map((p) => `
    <div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:6px 0">
      <div><b>${esc(p.meta?.name || 'Unnamed')}</b> <span class="muted">${esc(p.meta?.lake || '')} • ${esc(p.meta?.date || '')}</span><br>
      <span class="muted">${(p.spread || []).length} rods • ${p.gpx?.waypoints || 0} wpts</span></div>
      <div>
        <button class="small" onclick="window.loadPlanById(${p.id})">Load</button>
        <button class="small" onclick="window.deletePlanById(${p.id})">Delete</button>
      </div>
    </div>
  `).join('');
}

window.loadPlanById = async function (id) {
  if (!dbIsReady()) return;
  const p = await dbGet('plans', id);
  if (p) {
    loadPlanIntoForm(p);
    // The tab is called `plan`, not `builder`; `builder` is the id of the DIV. This selector
    // had the two confused and quietly matched nothing, so loading a plan left you looking at
    // the library it came from.
    document.querySelector('#planSubtabs button[data-plansub="plan"]')?.click();
    alert('Plan loaded.');
  }
};

window.deletePlanById = async function (id) {
  if (!confirm('Delete plan?')) return;
  // Read the plan BEFORE deleting -- the sync key is derived from its name.
  const p = await dbGet('plans', id).catch(() => null);
  await dbDel('plans', id);
  // Tombstone in D1 so it doesn't come back on the next pull.
  //
  // This used to be a hand-rolled fetch with `X-Sync-Token: 'trollmap-sync-9a8b7c6d5e'` -- a
  // literal that appears nowhere else in the app. The worker's isAuthorized() is a strict
  // equality check against SYNC_TOKEN ('trollmap2026'), so every one of these came back 401,
  // and `.catch(() => {})` threw the error away. The plan disappeared from the library, the
  // server never learned it was deleted, and pullUpdatesOnLoad() put it straight back on the
  // next page load. cloud-sync.js owns the token and now owns the tombstone too.
  if (p && window.deleteItemOnDelete) window.deleteItemOnDelete('plan', planSyncKey(p, id));
  refreshPlanLibrary();
};

// ── Expose river helpers for cross-module use ────────────────────────────────
window.isPlanRiverValue = isPlanRiverValue;
window.getPlanRiverDef = getPlanRiverDef;

// ── Button wiring ─────────────────────────────────────────────────────────────
















