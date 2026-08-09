/**
 * smart-plan.js — TrollMap Smart Plan Orchestrator
 *
 * Scout waypoint mode: Groq picks depth bands + lures, contour data places
 * waypoints, 4 out-and-back routes are built. Coach reviews the full plan.
 *
 * Updated 2026-07-25: Redesigned around "Stop-and-Cast" chronological timeline
 * and "Presentation-First" matching philosophy, fully supporting Newport NK180 Pro
 * (No Spot-Lock) manual positioning.
 */

import { state, CF_WORKER_URL } from '../core/state.js';
import { renderAll } from '../core/map-init.js';
import { esc } from '../utils/escape.js';
import { newRodRow } from '../utils/rod-row.js';
import { renderSpread, autoCalculateLead } from './spread-builder.js';
import { getActiveContour } from './contour-data.js';
import { selectBestLure, getInventory } from '../data/tackle-inventory.js';
import { getLureColor, depthWindow, LURE_KNOWLEDGE } from '../data/lure-knowledge.js';
import { getPhaseDepth, getStrategySpeed, normalizeSpecies, getPresentationPriority, getPhaseNotes } from '../data/species-strategies.js';
import { SPECIES_BEHAVIOR, SPECIES_BEHAVIOR_V2, getSeason, checkRegulations, resolveLakeKey } from '../data/species-intel.js';
import { isLiveBaitAvailable } from '../data/fishing-style-profile.js';
import { buildFishingContext, buildGroqCoachPayload } from './smart-plan-context.js';
import { startCoachSession } from './groq-coach.js';
import { renderSmartPlanUI, syncSpread, reelForLure } from './smart-plan-ui.js';

// Pull from the universal worker-backed access database
import { getLoadedAccessIndex } from '../data/access-index.js';
import { lakeDbEntryFor } from '../data/lake-registry.js';
import { geoDistanceFt, bearing as geoBearing, distToRingFt as distToRingGeneric, distFtFromCoords as distFtGeneric } from '../utils/geo.js';
import { solunarFor } from '../utils/solunar.js';

// ── Coastal / tidal support ────────────────────────────────────────────────
import { resolveR2Key } from '../data/lake-keys.js';
import { requestPlan, renderPlan, describePlan } from './smart-plan-route.js';
import { COASTAL_ZONES, isCoastalKey } from '../data/coastal-zones.js';
import { getTideStateForZone } from './tide-engine.js';
import { assessZoneIntrusion } from './usgs-gauges.js';
import {
  normalizeCoastalSpecies, classifyStructure, tacticalNote, DEPTH_BANDS,
} from './coastal-scoring.js';
import { checkCoastalRegulations, formatCoastalLimit } from '../data/coastal-regulations.js';
import { callSafely } from '../utils/call-global.js';

const BATTERY_AH_DEFAULT = 100;
const MOTOR_AMP_AVG      = 6;
const PHASE_1_END_OFFSET_MIN = 60;
const PHASE_2_END_OFFSET_MIN = 210;

// ── Dynamic inventory name list (loaded from tackle-inventory.js at runtime) ──
let _cachedTrollableNames = null;
let _cachedCastableNames = null;

// Maps annotated prompt string → clean inventory name
let _cachedAnnotatedToClean = null;

async function getTrollableNames() {
  if (_cachedTrollableNames) return _cachedTrollableNames;
  const inv = await getInventory();
  _cachedAnnotatedToClean = {};
  _cachedTrollableNames = inv.filter(l => l.trollable).map(l => {
    const w = depthWindow(l);
    const depthStr = w.mode === 'surface' ? 'surface'
      : w.mode === 'rated' ? `${w.min}-${w.max}ft rated dive`
      : 'variable depth (lead controls)';
    const sk = LURE_KNOWLEDGE[l.type]?.speed;
    const speedStr = sk
      ? `${sk.min}-${sk.max}mph${LURE_KNOWLEDGE[l.type].speedIsHardLimit ? ' MAX' : ' pref'}`
      : 'any speed';
    const annotated = `${l.name} [${depthStr} | ${speedStr}]`;
    _cachedAnnotatedToClean[annotated.toLowerCase()] = l.name;
    return annotated;
  });
  return _cachedTrollableNames;
}

async function getCastableNames() {
  if (_cachedCastableNames) return _cachedCastableNames;
  const inv = await getInventory();
  _cachedCastableNames = inv.filter(l => l.castable).map(l => l.name);
  return _cachedCastableNames;
}

/**
 * Build a casting tackle description that includes jighead weight guidance
 * for swimbait presentations based on target depth.
 * Depth → jighead weight: <8ft=1/4oz, 8-15ft=3/8oz, 15-25ft=1/2oz, >25ft=3/4oz
 */
function castingTackleBlock(castableNames, targetDepth) {
  const jigOz = !targetDepth ? '3/8oz' :
    targetDepth < 8  ? '1/4oz'  :
    targetDepth < 15 ? '3/8oz'  :
    targetDepth < 25 ? '1/2oz'  : '3/4oz';

  const swimbaitNote = `CASTING ROD RULES:
- You have 6 rods total. 2 are trolling (port + starboard). 2 stowed rods are PRE-RIGGED as dedicated cast rods before launch.
- The angler has ONE of each lure. If a lure appears in band1 or band2 trolling spread it CANNOT also be a cast rod — pick different lures.
- Trolling rods use inline weight systems and cannot be repurposed for casting without full re-rigging.
- When recommending a swimbait for casting at ~${targetDepth||15}ft, specify a ${jigOz} jighead (cast, count down, slow retrieve or hop).
- Output a "castRods" array with exactly 2 entries — the 2 pre-rigged stowed rods ready to grab at any casting stop.
- Each castRod entry: { "rod": 1or2, "lure": "<exact name>", "rigging": "<e.g. direct braid to snap, no weight>", "jigheadWeight": "<oz if swimbait, else null>", "presentation": "<one sentence>" }
- CRITICAL: castRods lures must be DIFFERENT from the lures you assign to band1 and band2 trolling. The angler has ONE of each lure. If a lure is trolling it cannot also be a cast rod. Choose cast rod lures that are NOT in the trolling spread.`;

  return `AVAILABLE TACKLE FOR STOP-AND-CAST — use ONLY these exact names for casting:
${castableNames.join(', ')}

${swimbaitNote}`;
}

// Strip the [...] annotation bracket from a lure name returned by Groq
function stripLureAnnotation(raw) {
  if (!raw) return raw;
  return String(raw).replace(/\s*\[.*$/, '').trim();
}

/**
 * Apply the physical speed ceiling for one trolling pass.
 */
export function capPassSpeed(requestedSpeed, lureNames, inventory, fallbackSpeed = 1.8) {
  const requested = Number.parseFloat(requestedSpeed);
  const requestedMph = Number.isFinite(requested) && requested > 0 ? requested : fallbackSpeed;
  const selectedLures = (lureNames || []).map((name) => {
    const cleanName = String(stripLureAnnotation(name) || '').toLowerCase();
    return (inventory || []).find((lure) =>
      lure?.trollable && String(lure.name || '').toLowerCase() === cleanName,
    );
  }).filter(Boolean);
  // Only a lure whose speed limit is PHYSICAL caps the pass. A lipped bait above
  // ~3mph leaves its rated depth, so it does. A bucktail does not — you can pull it
  // as fast as you like, you just need more lead, and lead is checked separately
  // against FISHING_STYLE.rigging.maxLeadFt. Before 2026-08-02 every lure's
  // inventory trollSpeedMax capped the pass, so a bucktail in the spread quietly
  // pinned the whole spread to 2.2mph.
  const maxSpeeds = selectedLures
    .map((lure) => LURE_KNOWLEDGE[lure.type])
    .filter((k) => k?.speedIsHardLimit)
    .map((k) => k.speed.max)
    .filter((speed) => Number.isFinite(speed) && speed > 0);
  const maxMph = maxSpeeds.length ? Math.min(...maxSpeeds) : null;
  const appliedMph = maxMph == null ? requestedMph : Math.min(requestedMph, maxMph);
  const limitingLures = maxMph == null ? [] : selectedLures
    .filter((lure) => LURE_KNOWLEDGE[lure.type]?.speedIsHardLimit
                   && LURE_KNOWLEDGE[lure.type].speed.max === maxMph);

  return {
    requestedMph,
    appliedMph,
    maxMph,
    selectedLures,
    limitingLures,
    wasCapped: maxMph != null && requestedMph > maxMph,
  };
}

// ── Groq lure name sanitizer ──────────────────────────────────────────────────
// Always returns the CLEAN inventory name (no [...] annotation). The prompt
// sends annotated names for depth/speed context, but the UI and JSON export
// must never contain the bracket annotation — it caused the reported bug where
// timeline port/starboard showed "[6-12ft dive | 1.4-2mph]" etc.
function sanitizeGroqLureName(raw, targetDepthFt, inventoryNames) {
  if (!raw) return stripLureAnnotation(depthFallbackLure(targetDepthFt, inventoryNames));
  const stripped = stripLureAnnotation(raw);
  if (_cachedAnnotatedToClean) {
    const direct = _cachedAnnotatedToClean[String(raw).toLowerCase().trim()];
    if (direct) return direct;
    const directStripped = _cachedAnnotatedToClean[stripped.toLowerCase().trim()];
    if (directStripped) return directStripped;
  }
  const r = String(stripped).toLowerCase().trim();

  // Compare against CLEAN names (strip annotation from inventory list)
  const cleanMap = inventoryNames.map(orig => ({
    orig,
    clean: stripLureAnnotation(orig),
  }));

  const exact = cleanMap.find(m => m.clean.toLowerCase() === r);
  if (exact) return exact.clean;

  const substr = cleanMap.find(m => {
    const nl = m.clean.toLowerCase();
    return nl.includes(r) || r.includes(nl);
  });
  if (substr) return substr.clean;

  const rWords = r.replace(/[^a-z0-9"]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  let bestName = null, bestScore = 0;
  for (const { clean } of cleanMap) {
    const nl = clean.toLowerCase();
    const score = rWords.filter(w => nl.includes(w)).length;
    if (score > bestScore) { bestScore = score; bestName = clean; }
  }
  if (bestScore >= 1) return bestName;

  return stripLureAnnotation(depthFallbackLure(targetDepthFt, inventoryNames));
}

function depthFallbackLure(depthFt, inventoryNames) {
  const d = parseFloat(depthFt) || 15;
  const findMatch = (...keywords) => {
    return inventoryNames.find(n => keywords.some(k => n.toLowerCase().includes(k)));
  };
  let picked = null;
  if (d < 8)  picked = findMatch('squarebill', 'sr crankbait', 'lipless', 'spinnerbait');
  else if (d < 14) picked = findMatch('mr crankbait', 'dd1', 'a-rig light', 'swimbait 3.8');
  else if (d < 20) picked = findMatch('dd1', 'dd2', 'a-rig medium', 'swimbait 4.6', 'umbrella');
  else if (d < 26) picked = findMatch('dd2', 'dd3', 'a-rig heavy', 'swimbait 5"', 'flutter spoon');
  else picked = findMatch('dd3', 'dd4', 'flutter spoon', 'bucktail');
  picked = picked || inventoryNames[0] || 'DD1 Crankbait (14-18ft)';
  // Always return CLEAN name
  return stripLureAnnotation(picked);
}

// ── Sunrise & Solunar ─────────────────────────────────────────────────────────
function computeSunrise(lat, lon, dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const JD = Math.floor(d / 86400000) + 2440587.5;
  const n = JD - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * Math.PI / 180;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * Math.PI / 180;
  const sinDec = Math.sin(23.439 * Math.PI / 180) * Math.sin(lambda);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(90.833 * Math.PI / 180) - sinDec * Math.sin(lat * Math.PI / 180))
               / (cosDec * Math.cos(lat * Math.PI / 180));
  if (Math.abs(cosH) > 1) return 6.0;
  const H = Math.acos(cosH) * 180 / Math.PI;
  const RA = Math.atan2(Math.cos(23.439 * Math.PI / 180) * Math.sin(lambda), Math.cos(lambda)) * 180 / Math.PI;
  const t = 720 - 4 * (lon + H) - (RA - 15 * ((JD - 2451545) / 36525 * 360.9856474 % 360)) / 15;
  return ((t / 60) + 24) % 24 - 5;
}

// computeSolunar() lived here until 2026-08-03. It used the moon's mean longitude with no
// hour-angle correction and a hardcoded `- 5` baking in Eastern time, and it disagreed with
// plan-builder.js's model by up to ELEVEN HOURS for the same lake and date. The Smart Plan
// timeline showed these numbers while notifications.js fired bite alerts on the other set.
// Both now call utils/solunar.js. See that file for the two-year diff proving the surviving
// model was moved intact.

function computeRangeMiles(speedMph) {
  const spd = speedMph || 2.0;
  const bms = window.ACTIVE_BLE_BMS;
  if (bms?.connected && bms.remainingAh > 0 && bms.current > 0.1)
    return (bms.remainingAh / bms.current * spd) / 2;
  return (BATTERY_AH_DEFAULT / MOTOR_AMP_AVG * spd) / 2;
}

// ── Phase boundaries ──────────────────────────────────────────────────────────
function computePhases(launchTimeStr, returnTimeStr, dateStr, lat, lon) {
  const sunriseH = computeSunrise(lat, lon, dateStr);
  const sol = solunarFor(dateStr, lat, lon);

  function parseT(t) {
    if (!t) return null;
    const m = t.match(/(\d+):(\d+)\s*(am|pm)?/i);
    if (!m) return null;
    let h = parseInt(m[1]), min = parseInt(m[2]);
    if (m[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
    if (m[3]?.toLowerCase() === 'am' && h === 12) h = 0;
    return h + min / 60;
  }

  const launchH = parseT(launchTimeStr) || 6.0;
  const returnH = parseT(returnTimeStr) || 12.0;
  let p1End = sunriseH + PHASE_1_END_OFFSET_MIN / 60;
  let p2End = sunriseH + PHASE_2_END_OFFSET_MIN / 60;

  [sol.major1, sol.major2].forEach(t => {
    if (t >= launchH && t <= p1End + 0.5) p1End = Math.max(p1End, t + 1.0);
    if (t >= p1End  && t <= p2End + 0.5) p2End = Math.max(p2End, t + 1.0);
  });
  [sol.minor1, sol.minor2].forEach(t => {
    if (t >= launchH && t <= p1End + 0.25) p1End = Math.max(p1End, t + 0.5);
  });

  p1End = Math.min(p1End, returnH - 1.0);
  p2End = Math.min(p2End, returnH - 0.5);
  if (p1End >= p2End) p1End = launchH + (returnH - launchH) / 3;
  if (p2End >= returnH) p2End = launchH + 2 * (returnH - launchH) / 3;

  function hStr(h) {
    const hh = Math.floor(((h % 24) + 24) % 24);
    const mm = Math.round((h % 1) * 60);
    return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
  }

  return {
    sunriseH, solunar: sol,
    phases: [
      { num:1, name:'Dawn',       start:launchH, end:p1End,   startStr:hStr(launchH), endStr:hStr(p1End)   },
      { num:2, name:'Transition', start:p1End,   end:p2End,   startStr:hStr(p1End),   endStr:hStr(p2End)   },
      { num:3, name:'Deep',       start:p2End,   end:returnH, startStr:hStr(p2End),   endStr:hStr(returnH) },
    ],
  };
}

// ── Per-phase species-intel lookup ───────────────────────────────────────────
function getPhaseRecommendation(species, lakeName, season, phaseNum, waterTempF) {
  const v2sp = SPECIES_BEHAVIOR_V2?.[species];
  if (v2sp) {
    const lakeKeyV2 = (resolveLakeKey
      ? (resolveLakeKey(lakeName, v2sp) || 'default_SC_reservoir')
      : (v2sp[lakeName] ? lakeName : 'default_SC_reservoir'));
    const lakeNode = v2sp[lakeKeyV2] || v2sp['default_SC_reservoir'] || v2sp['Coastal SC Inshore'];
    const sNode = lakeNode?.[season];
    if (sNode) {
      let [dMin, dMax] = typeof sNode.preferredDepth === 'function'
        ? sNode.preferredDepth(waterTempF) : (sNode.preferredDepth || [5, 15]);
      const spread = dMax - dMin;
      if (phaseNum === 1)      { dMax = Math.round(dMin + spread * 0.45); }
      else if (phaseNum === 2) { dMin = Math.round(dMin + spread * 0.25); dMax = Math.round(dMin + spread * 0.5); }
      else                     { dMin = Math.round(dMin + spread * 0.55); }
      const speed = Array.isArray(sNode.preferredSpeed) ? sNode.preferredSpeed[0] : (sNode.preferredSpeed || 1.8);
      return {
        depthMin: Math.round(dMin), depthMax: Math.round(dMax),
        lures: sNode.preferredPresentation || [], speed,
        notes: Array.isArray(sNode.notes) ? sNode.notes.join(' · ') : (sNode.notes || ''),
        structure: sNode.preferredStructure || [],
      };
    }
  }
  const lakeKey = resolveLakeKey(lakeName, SPECIES_BEHAVIOR);
  const seasonData = SPECIES_BEHAVIOR[lakeKey]?.[species]?.[season];
  if (!seasonData) return null;
  const todKeys = { 1:'dawn', 2:'day', 3:'day' };
  const tod = seasonData.timeOfDay[todKeys[phaseNum]] || seasonData.timeOfDay['day'];
  if (!tod) return null;
  let [dMin, dMax] = typeof seasonData.depthBand === 'function'
    ? seasonData.depthBand(waterTempF) : [...seasonData.depthBand];
  return { depthMin:Math.round(dMin), depthMax:Math.round(dMax), lures:tod.lures||[], speed:tod.speed||2.0, notes:tod.notes||'' };
}
// stitchContourFragments() and walkContourForWaypoints() were here until 2026-08-07.
//
// They joined contour fragments in the browser and walked the join dropping a waypoint every
// 150 ft -- roughly 160 lines re-deriving, per plan, on a phone, what build_trolling_runs.py
// now does once against the whole pack. The pipeline version is not just faster, it is better:
// it stitches Garmin's 12.1 ft line on Wateree into 45.34 km and records for each run whether
// it is REACHABLE FROM WATER, which the browser had no way to know.
//
// Their caller now sends intent to POST /water/{slug}/plan. See smart-plan-route.js.

async function generateScoutWaypoints(phases, bands, rampLat, rampLon, rangeMiles, speedsMph=2.0, phaseInfo) {
  // THE ROUTE IS NO LONGER BUILT HERE. It is built by POST /water/{slug}/plan against the water
  // graph and the stitched trolling runs, and this function only turns the model's depth bands
  // into that request and renders what comes back.
  //
  // What used to live in these lines: stitchContourFragments() joined contour pieces in the
  // browser, walkContourForWaypoints() walked the join dropping a waypoint every 150 ft, and
  // buildScoutRoutes() connected those waypoints with straight lines plus a 20 ft sine wave so
  // the result LOOKED like trolling passes. The sine wave is the tell -- it was decoration on a
  // route that was never following anything.
  //
  // All three of Ryan's complaints came from that: it could not follow a contour (i-Boating's
  // longest run was 1.68 km), it could not leave the boat positioned for the next leg (a leg
  // had an end coordinate but no end state), and it drew connecting lines over land (a straight
  // line goes wherever a straight line goes). See PHASE3_THE_LEG_MODEL_2026-08-06.md.
  const p = phaseInfo?.phases || phases;
  const totalDurH = p.length ? (p[p.length - 1].end - p[0].start) : 6;

  // How far the angler can actually fish in each phase, which is the ONLY thing the old code
  // computed that is still wanted. Halved because a phase is out and back, capped at 3 miles.
  const budgetsFt = (bands || []).map((_, i) => {
    const raw = Array.isArray(speedsMph) ? speedsMph[i] : speedsMph;
    const spd = Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : 2.0;
    return Math.min(totalDurH / 2 * spd * 5280 * 0.8, 3.0 * 5280);
  });

  // Same source the rest of this file uses (readPlanInputs), not the map toolbar picker:
  // the Plan tab's lake is what the plan is FOR, and the two can legitimately differ while
  // you are looking at one lake and planning another. #lakeSelect is the fallback only.
  const lakeName = document.getElementById('planLake')?.value
                || document.getElementById('lakeSelect')?.value || '';
  const res = await requestPlan({ lakeName, bands, rampLat, rampLon, rangeMiles, budgetsFt });

  if (!res.ok) {
    // Loudly, and with no fallback. The old walker is the thing being removed; reaching for it
    // on failure would keep it alive forever, and a plan drawn over land is worse than none.
    console.warn('[smart-plan] no route: ' + res.reason);
    window._smartPlanRouteError = res.reason;
    clearExistingSmartPlanTracks();
    if (Number.isFinite(rampLat) && Number.isFinite(rampLon)) {
      if (!state.DATA) state.DATA = {};
      if (!Array.isArray(state.DATA.waypoints)) state.DATA.waypoints = [];
      state.DATA.waypoints = state.DATA.waypoints.filter(w => !w.scoutWaypoint);
      state.DATA.waypoints.push({ name: 'Launch', lat: rampLat, lon: rampLon,
                                  sym: 'Boat Ramp', role: 'launch_ramp', scoutWaypoint: true });
    }
    renderAll();
    return 0;
  }

  window._smartPlanRouteError = null;
  window._smartPlanLastPlan = res.plan;
  const counts = renderPlan(res.plan, { rampLat, rampLon });
  console.log('[smart-plan] ' + describePlan(res.plan)
            + ` — ${counts.trollN} troll, ${counts.transitN} transit`);
  for (const n of (res.plan.notes || [])) console.warn('[smart-plan] ' + n);
  renderAll();
  return counts.waypoints;
}

function isSmartPlanTrack(t) {
  // A SmartPlan track from an EARLIER run. The run-id test is the whole point: renderPlan stamps
  // planRunId on what it builds, so a track carrying the current id is this run's output and must
  // survive no matter when the cleaner happens to run. Without that test this function matched
  // the tracks renderPlan had just created and the plan shipped with zero.
  const name=String(t?.name||'');
  const isOurs = !!(t?.smartPlan||name.startsWith('Phase ')||name.startsWith('Connector:'));
  if (!isOurs) return false;
  const cur = (typeof window !== 'undefined') ? window._smartPlanRunId : null;
  return !(cur && t?.planRunId === cur);
}

function clearExistingSmartPlanTracks() {
  if (!state.DATA?.tracks?.length) return 0;
  const before=state.DATA.tracks.length;
  state.DATA.tracks=state.DATA.tracks.filter(t=>!isSmartPlanTrack(t));
  return before-state.DATA.tracks.length;
}

function readPlanInputs() {
  return {
    lakeName:   document.getElementById('planLake')?.value||'',
    dateStr:    document.getElementById('planDate')?.value||new Date().toISOString().slice(0,10),
    launchTime: document.getElementById('planLaunchTime')?.value||'6:00 AM',
    returnTime: document.getElementById('planReturnTime')?.value||'12:00 PM',
    waterTempF: parseFloat(document.getElementById('planWaterTemp')?.value)||null,
    speedMph:   parseFloat(document.getElementById('planSpeed')?.value)||2.0,
    species:    [...document.querySelectorAll('#planSpeciesChecks input:checked')].map(c=>c.value),
  };
}

export function applyStoredSmartPlanDepth() {
  const routes=window._smartPlanPhaseRoutes;
  if (!routes?.length) return;
  const p1=routes.find(r=>r.phase===1);
  if (!p1) return;
  const minEl=document.getElementById('rbDepthMin');
  const maxEl=document.getElementById('rbDepthMax');
  if (minEl) minEl.value=p1.depthMin;
  if (maxEl) maxEl.value=p1.depthMax;
}

// ── Coastal mode ───────────────────────────────────────────────────────────

export function detectCoastalZone(lakeName) {
  const key = lakeName ? resolveR2Key(lakeName) : null;
  return isCoastalKey(key) ? key : null;
}

export async function buildCoastalContext({ zoneKey, dateStr, launchTime, species }) {
  const zone = COASTAL_ZONES[zoneKey];
  if (!zone) return null;

  let when = new Date(`${dateStr}T12:00:00`);
  const hm = String(launchTime || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (hm) {
    let h = parseInt(hm[1], 10);
    const m = parseInt(hm[2], 10);
    const ap = (hm[3] || '').toUpperCase();
    if (ap === 'PM' && h < 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    when = new Date(`${dateStr}T00:00:00`);
    when.setHours(h, m, 0, 0);
  }

  const [tideRes, intrusionRes] = await Promise.allSettled([
    getTideStateForZone(zoneKey, { dateStr, when }),
    assessZoneIntrusion(zoneKey),
  ]);

  const tide = tideRes.status === 'fulfilled' ? tideRes.value : null;
  const intrusion = intrusionRes.status === 'fulfilled'
    ? intrusionRes.value
    : { active: false, severity: 0, message: null, sites: [], rivers: [] };

  const structures = [];
  for (const feat of (window.getOsmStructures?.() || [])) {
    const type = classifyStructure(feat);
    const c = feat.geometry?.coordinates;
    if (!type || !c) continue;
    structures.push({ type, lat: c[1], lon: c[0] });
  }

  const primary = normalizeCoastalSpecies(species?.[0]);
  const stage = tide?.stage || null;
  const regulation = species?.[0]
    ? checkCoastalRegulations(zone.state, species[0], dateStr)
    : null;

  return {
    zoneKey, zone, tide, stage, intrusion, structures, regulation,
    species: primary,
    tideHeightFt: tide?.heightFt ?? null,
    depthBand: (primary && stage) ? DEPTH_BANDS[primary]?.[stage] : null,
    note: (primary && stage) ? tacticalNote(primary, stage) : '',
  };
}

export function buildCoastalPromptBlock(ctx) {
  if (!ctx) return '';
  const L = [];
  L.push(`\n🌊 COASTAL / TIDAL MODE — ${ctx.zone.name} (${ctx.zone.state})`);
  L.push(`STRICT SAFETY CONSTRAINT: You are strictly restricted to INSHORE areas (marshes, tidal creeks, estuary mouths, oyster bars, and shallow flats). NEVER plan routes or suggest traveling past the jetties, into the open ocean, or into high-energy open-water surf areas. This is a 12.5ft kayak, not an offshore boat.`);
  L.push(`NOAA station ${ctx.zone.tideStation}. Depths are MLLW-referenced; add tide height for actual water.`);

  if (ctx.tide) {
    const h = Number.isFinite(ctx.tide.heightFt) ? `${ctx.tide.heightFt.toFixed(1)} ft` : 'unknown';
    L.push(`Tide at launch: ${ctx.tide.stageLabel || ctx.stage || 'unknown'} · height ${h} above MLLW`);
    if (ctx.tide.nextEvent) {
      const e = ctx.tide.nextEvent;
      const t = e.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      L.push(`Next turn: ${e.type.toUpperCase()} at ${t} (${e.heightFt.toFixed(1)} ft)`);
    }
    if (Number.isFinite(ctx.tide.rangeFt)) L.push(`Daily range: ${ctx.tide.rangeFt.toFixed(1)} ft`);
  } else {
    L.push('Tide data unavailable — treat charted depths as MLLW minimums and stay conservative on the flats.');
  }

  if (ctx.depthBand) L.push(`Target depth band for this species/stage: ${ctx.depthBand[0]}–${ctx.depthBand[1]} ft (tide-corrected)`);
  if (ctx.note) L.push(`Tactic: ${ctx.note}`);

  if (ctx.structures.length) {
    const counts = ctx.structures.reduce((a, s) => { a[s.type] = (a[s.type] || 0) + 1; return a; }, {});
    L.push(`Structure available: ${Object.entries(counts).map(([k, v]) => `${k} x${v}`).join(', ')}`);
  }

  if (ctx.intrusion?.active) {
    const rivers = ctx.intrusion.rivers?.length ? ` (${ctx.intrusion.rivers.join(', ')})` : '';
    L.push(`⚠ FRESHWATER INTRUSION${rivers}: ${ctx.intrusion.message}`);
    L.push('Penalise upper creeks; favour inlet-adjacent structure.');
  }

  if (ctx.regulation?.regInfo) {
    const limit = formatCoastalLimit(ctx.regulation.regInfo);
    if (limit) L.push(`Harvest limit (${ctx.zone.state}): ${limit}`);
  }
  for (const w of (ctx.regulation?.warnings || [])) L.push(`⚠ ${w}`);

  return L.join('\n');
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function runSmartPlan() {
  const {lakeName,dateStr,launchTime,returnTime,waterTempF,speedMph,species}=readPlanInputs();
  const outEl   =document.getElementById('planSmartPlanOutput');
  const statusEl=document.getElementById('smartPlanStatus');
  function setStatus(msg,ok){ if(statusEl){statusEl.textContent=msg;statusEl.style.color=ok?'var(--accent2)':'var(--warn)';} }

  if (!lakeName)       { setStatus('Select a lake first',false); return; }
  if (!species.length) { setStatus('Check at least one target species',false); return; }

  const date=new Date(dateStr+'T12:00:00');
  const sp=species[0];

  const _coastalKeyForRegs = detectCoastalZone(lakeName);
  const _coastalState = _coastalKeyForRegs ? COASTAL_ZONES[_coastalKeyForRegs]?.state : null;
  const regCheck = _coastalState
    ? checkCoastalRegulations(_coastalState, sp, date)
    : checkRegulations(lakeName, sp, date);

  if (!regCheck.legal) {
    setStatus(`⚠ ${sp} not legal: ${regCheck.reason?.slice(0,60)}`,false);
    if (outEl) outEl.value=`REGULATION BLOCK:\n${regCheck.reason}`;
    return;
  }

  const regWarnings = regCheck.warnings || [];
  if (regWarnings.length) {
    console.warn('[smart-plan] regulation advisories:', regWarnings);
  }

  setStatus('Asking Groq for fishing plan…',true);
  if (outEl) outEl.value='⏳ Loading inventory + building plan…';

  const season    =getSeason(date);
  const clarity   =document.getElementById('planClarity')?.value||'Clear';
  const rampName  =document.getElementById('planRamp')?.value||'unknown ramp';

  const coastalZoneKey = detectCoastalZone(lakeName);

  let weatherStr = document.getElementById('planWeather')?.value || '';
  try {
    const coastalCenter = coastalZoneKey ? COASTAL_ZONES[coastalZoneKey]?.center : null;
    // Was: exact LAKE_DB hit, else a substring scan over its 50 keys. That matcher was one
    // of four written independently across the app, and they did not agree -- the planner and
    // the journal could resolve the same lake name to different entries. lakeDbEntryFor() is
    // the single resolver, and it returns null instead of guessing.
    const lakeEntry = lakeDbEntryFor(lakeName);
    const center = coastalCenter || lakeEntry?.center;
    if (center) {
      const [lat, lon] = center;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,windspeed_10m_max,winddirection_10m_dominant,precipitation_sum` +
        `&timezone=auto&start_date=${dateStr}&end_date=${dateStr}`;
      const res = await fetch(url, { signal: AbortSignal.timeout?.(4500) });
      if (res.ok) {
        const data = await res.json();
        if (data?.daily) {
          const D = data.daily;
          const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
          const windD = dirs[Math.round((D.winddirection_10m_dominant?.[0] || 0) / 22.5) % 16];
          const windMph = Math.round((D.windspeed_10m_max?.[0] || 0) * 0.621371);
          const precip = D.precipitation_sum?.[0] || 0;
          const weatherVal = `Wind ${windD} ${windMph} mph · Precip ${precip}mm`;
          const weatherEl = document.getElementById('planWeather');
          if (weatherEl) weatherEl.value = weatherVal;
          weatherStr = weatherVal;
        }
      }
    }
  } catch (_) {
    console.warn(`[smart-plan] coastal zone lookup failed:`, _ && _.message);
  }

  let coastalCtx = null;
  let coastalBlock = '';
  if (coastalZoneKey) {
    setStatus('Reading tides + river gauges…', true);
    try {
      coastalCtx = await buildCoastalContext({
        zoneKey: coastalZoneKey, dateStr, launchTime, species,
      });
      coastalBlock = buildCoastalPromptBlock(coastalCtx);
      window._coastalContext = coastalCtx;
      if (coastalCtx?.tide?.heightFt != null) {
        window.refreshSoundingLabels?.(coastalCtx.tide.heightFt);
      }
    } catch (err) {
      console.warn('[smart-plan] coastal context failed:', err.message);
    }
  }

  // ── Universal DNR Ramp Lookup ───────────────────────────────────────────
  clearExistingSmartPlanTracks();
  window._smartPlanCommittedTracks=[];

  let rampLat=null, rampLon=null;
  const idx = getLoadedAccessIndex();

  const _coastalZoneForRamp = coastalZoneKey ? COASTAL_ZONES[coastalZoneKey] : null;
  let lakePoints = idx.byLake.get(lakeName) || [];
  if (lakePoints.length === 0 && _coastalZoneForRamp) {
    lakePoints = Object.entries(_coastalZoneForRamp.ramps || {}).map(([name, c]) => ({ name, lat: c[0], lon: c[1] }));
  }
  
  const normN = v => String(v||'').toLowerCase().replace(/[_-]+/g,' ').replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
  const rampMatch = (a,b) => { const x=normN(a), y=normN(b); return !!x && !!y && (x===y || x.includes(y) || y.includes(x)); };
  
  const found = lakePoints.find(p => rampMatch(p.name, rampName)) || lakePoints[0];
  if (found) { rampLat = found.lat; rampLon = found.lon; }
  
  if (rampLat == null) {
    const opt = document.querySelector('#planRamp option:checked');
    if (opt && opt.dataset.lat) { rampLat = parseFloat(opt.dataset.lat); rampLon = parseFloat(opt.dataset.lon); }
  }
  if (rampLat == null) {
    const c = _coastalZoneForRamp?.center;
    if (c) { rampLat = c[0]; rampLon = c[1]; }
    else { rampLat = 34.0; rampLon = -81.0; }
  }

  const phaseInfo = computePhases(launchTime, returnTime, dateStr, rampLat, rampLon);
  const sol       = phaseInfo.solunar;
  let rangeMiles= computeRangeMiles(speedMph);
  
  const inventory = await getInventory();
  const inventoryNames = await getTrollableNames();
  const castableNames = await getCastableNames();

  function hStr(h){
    const hh=Math.floor(((h%24)+24)%24),mm=String(Math.round((h%1)*60)).padStart(2,'0');
    return `${hh%12||12}:${mm} ${hh<12?'AM':'PM'}`;
  }

  const solunarStr=`Majors: ${hStr(sol.major1)}, ${hStr(sol.major2)} · Minors: ${hStr(sol.minor1)}, ${hStr(sol.minor2)}`;
  const totalDurH=phaseInfo.phases.length?(phaseInfo.phases[phaseInfo.phases.length-1].end-phaseInfo.phases[0].start):6;

  const fishingContext = await buildFishingContext({
    species: sp, lakeName, season, clarity, waterTempF,
    speedMph: speedMph,
    dateStr, launchTime, rampLat, rampLon
  });
  
  const researchedSummary = fishingContext?.researchedSummary || null;
  const researchedTrolling = fishingContext?.researchedTrolling || null;
  const hasResearched = fishingContext?.hasResearchedProfile || false;
  const researchedMeta = fishingContext?.researchedProfile?.metadata || null;

  let researchedTrollingSlice = null;
  if (hasResearched && researchedTrolling) {
    const targetKey = Object.keys(researchedTrolling).find(k => k.toLowerCase().includes(sp.toLowerCase().split(' ')[0]) || sp.toLowerCase().includes(k.toLowerCase().split(' ')[0]));
    if (targetKey) {
      researchedTrollingSlice = { [targetKey]: researchedTrolling[targetKey] };
    } else {
      researchedTrollingSlice = { _note: `Research profile exists but does not contain ${sp}. Use generic species intel for ${sp}.`, availableSpecies: Object.keys(researchedTrolling).slice(0,6) };
    }
  }

  const speciesBehavior = fishingContext?.researchedProfile?.biology?.speciesBehavior || null;
  const targetBehavior = speciesBehavior
    ? Object.entries(speciesBehavior).find(([k]) =>
        k.toLowerCase().includes(sp.toLowerCase().split(' ')[0]) ||
        sp.toLowerCase().includes(k.toLowerCase().split(' ')[0])
      )?.[1]
    : null;

  const researchedBlock = hasResearched && researchedMeta ? `
🧠 VERIFIED LAKE RESEARCH (v${researchedMeta.version||'?'} ${researchedMeta.status||''} ${fishingContext.researchedProfile?.confidence?.overall?.percent||'?'}% — prioritize for permanent facts, adapt for today's conditions):
Summary: ${String(researchedSummary||'').slice(0,350)}
${researchedTrollingSlice ? `Trolling (target species only ${sp}): ${JSON.stringify(researchedTrollingSlice, null, 0).slice(0,900)}` : ''}
Limnology: archetype=${String(fishingContext.researchedProfile?.archetype||'').slice(0,60)} trophic=${String(fishingContext.researchedProfile?.limnology?.trophicStatus||'')} thermocline=${fishingContext.researchedProfile?.limnology?.thermocline?.summerDepthFt ? `${fishingContext.researchedProfile.limnology.thermocline.summerDepthFt}ft (${fishingContext.researchedProfile.limnology.thermocline.strength||'unknown strength'})` : 'unknown'} anoxicBelow=${fishingContext.researchedProfile?.limnology?.oxygen?.anoxicBelowFt ? `${fishingContext.researchedProfile.limnology.oxygen.anoxicBelowFt}ft` : 'unknown'} clarity=${String(fishingContext.researchedProfile?.limnology?.waterClarity?.typical||'unknown')}${fishingContext.researchedProfile?.limnology?.waterClarity?.secchiFt ? ` secchi=${fishingContext.researchedProfile.limnology.waterClarity.secchiFt}ft` : ''} flow=${String(fishingContext.researchedProfile?.limnology?.flowCharacteristics||'').slice(0,120)||'none'}${fishingContext.researchedProfile?.limnology?.dailyFluctuationFt ? ` dailySwing=${fishingContext.researchedProfile.limnology.dailyFluctuationFt}ft` : ''}
Habitat key: ${(() => {
  const se = fishingContext.researchedProfile?.habitat?.structuralElements;
  if (!se) return '';
  const fmt = (v) => {
    if (Array.isArray(v)) {
      if (!v.length) return '';
      if (v[0] && typeof v[0] === 'object' && 'lat' in v[0] && 'lon' in v[0]) {
        return v.slice(0,3).map(c => `${Number(c.lat).toFixed(4)}, ${Number(c.lon).toFixed(4)}`).join('; ');
      }
      return v.slice(0,4).map(x => typeof x==='string'?x:JSON.stringify(x)).join(', ');
    }
    if (typeof v === 'string') return v.slice(0,80);
    return String(v).slice(0,80);
  };
  return Object.entries(se).map(([k,v])=>`${k}: ${fmt(v)}`).join('; ').slice(0,200);
})()}
` : '';

  const v2sp = SPECIES_BEHAVIOR_V2?.[sp];
  const oxygenFloor = fishingContext?.researchedProfile?.limnology?.oxygen?.anoxicBelowFt || null;
  const oxygenConstraint = oxygenFloor
    ? `\nCRITICAL: Oxygen depletion floor is ${oxygenFloor}ft on this lake in summer — all depth bands MUST stay above ${oxygenFloor}ft.`
    : '';

  let speciesIntelBlock = '';
  if (targetBehavior) {
    const sb = targetBehavior[season] || targetBehavior.summer || {};
    const depth = Array.isArray(sb.depthRange) ? `${sb.depthRange[0]}–${sb.depthRange[1]}ft` : null;
    const structs = Array.isArray(sb.structure) ? sb.structure.join(', ') : null;
    const spawnNote = targetBehavior.spawnTiming?.waterTempF
      ? `Spawn trigger: ${targetBehavior.spawnTiming.waterTempF[0]}–${targetBehavior.spawnTiming.waterTempF[1]}°F`
      : null;
    const lakeNote = targetBehavior.lakeSpecificNotes || null;
    speciesIntelBlock = `
SPECIES INTEL — ${sp} in ${season} on ${lakeName} (LAKE-SPECIFIC from verified research):
${depth ? `- Preferred depth range: ${depth}` : ''}
${structs ? `- Key structure: ${structs}` : ''}
${sb.notes ? `- Notes: ${sb.notes}` : ''}
${spawnNote ? `- ${spawnNote}` : ''}
${lakeNote ? `- Lake context: ${lakeNote}` : ''}
${oxygenConstraint}`;
  } else if (v2sp) {
    const lakeKeyV2 = (resolveLakeKey
      ? (resolveLakeKey(lakeName, v2sp) || 'default_SC_reservoir')
      : (v2sp[lakeName] ? lakeName : 'default_SC_reservoir'));
    const sNode = v2sp[lakeKeyV2]?.[season] || v2sp['default_SC_reservoir']?.[season];
    if (sNode) {
      const depthRange = typeof sNode.preferredDepth === 'function'
        ? sNode.preferredDepth(waterTempF) : (sNode.preferredDepth || [5, 20]);
      const speedRange = Array.isArray(sNode.preferredSpeed)
        ? sNode.preferredSpeed : [sNode.preferredSpeed || 1.8, sNode.preferredSpeed || 1.8];
      const notes = Array.isArray(sNode.notes) ? sNode.notes.join(' · ') : (sNode.notes || '');
      speciesIntelBlock = `
SPECIES INTEL — ${sp} in ${season} on ${lakeName}:
- Preferred depth range: ${depthRange[0]}–${depthRange[1]}ft
- Preferred trolling speed: ${speedRange[0]}–${speedRange[1]} mph
- Key structure: ${(sNode.preferredStructure || []).join(', ') || 'general structure'}
- Presentations: ${(sNode.preferredPresentation || []).join(', ') || 'general trolling'}
- Lure families: ${(sNode.lureFamilies || []).join(', ') || 'see tackle list'}
- Colors: ${(sNode.preferredColors || []).join(', ') || 'match forage'}
${notes ? `- Notes: ${notes}` : ''}`;
    }
  }

  const catchSummary = fishingContext?.catchSummary;
  let catchBlock = '';
  if (catchSummary && catchSummary.totalCatches > 0) {
    catchBlock = `
ANGLER CATCH HISTORY — ${sp} on ${lakeName} in ${season} (${catchSummary.totalCatches} catches logged):
- Average catch depth: ${catchSummary.avgDepthFt != null ? catchSummary.avgDepthFt + 'ft' : 'unknown'}
- Best time of day: ${catchSummary.bestTime || 'unknown'}
- Top lures: ${catchSummary.topLures.map(l => `${l.lure} (${l.count}x)`).join(', ') || 'none logged'}`;
  }

  const coastalSafetyBlock = coastalZoneKey
    ? `\n- COASTAL KAYAK RESTRICTION: You are strictly restricted to INSHORE areas (marshes, tidal creeks, estuary mouths, oyster bars, and shallow flats). NEVER plan routes or suggest traveling past the jetties, into the open ocean, or into high-energy open-water surf areas. Safety first: stay in sheltered, inshore waters.`
    : '';

  // Build hazard exclusion list from user waypoints with hazard names/symbols
  const HAZARD_PATTERNS = /hazard|danger|shallow|rock|snag|stump|no.go|avoid|warning/i;
  const HAZARD_SYMS = ['Hazard', 'Skull and Crossbones', 'Block, Red', 'Pin, Red', 'Danger'];
  const hazardZones = (state.DATA?.waypoints || [])
    .filter(w => !w.scoutWaypoint && (
      HAZARD_PATTERNS.test(w.name || '') ||
      HAZARD_SYMS.includes(w.sym || '')
    ))
    .map(w => ({ lat: w.lat, lon: w.lon }));

  // Format pre-Groq stop candidates lists
  const preGroqStructures = fishingContext?.nearbyStructures || [];
  const candidateList = preGroqStructures.length > 0 ? preGroqStructures.map((s, i) => {
    return `${i+1}) ${s.name || s.type} at [${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}]`;
  }).join('\n') : 'None mapped nearby.';

  const planPrompt=`You are an expert fishing guide for ${lakeName}.
Build a hybrid trolling and casting plan for today targeting ${sp}.

TRIP & CONDITIONS:
- Date: ${dateStr}
- Launch: ${hStr(phaseInfo.phases[0]?.start||6)} from ${rampName}
- Return: ${hStr(phaseInfo.phases[phaseInfo.phases.length-1]?.end||12)}
- Duration: ${totalDurH.toFixed(1)} hours on water
- Season: ${season}
- Weather/Wind Forecast: ${weatherStr || 'Unknown'}
- Water temp: ${waterTempF?waterTempF+'°F':'unknown'}
- Clarity: ${clarity}
- Solunar majors: ${hStr(sol.major1)}, ${hStr(sol.major2)}

SAFETY & RAMP EVALUATION (GO / NO-GO):
You must evaluate the weather and wind forecast against the platform (12.5ft Kayak). 
- Sustained winds > 15mph or gusts > 20mph are NO-GO conditions for a kayak.
- Evaluate the launch ramp (${rampName}) against the wind direction. Will it be a dangerous windward launch?
- If conditions are unsafe, set "isGo" to false and explain why in "safetyWarning".
${speciesIntelBlock}
${catchBlock}
${coastalBlock}

${researchedBlock}

YOUR ROLE:
You are the expert guide on the water *today*. Leverage the SPECIES INTEL baseline and verified research to form sequential depth bands for trolling, but ALSO define highly-strategic chronologically woven "Casting Stops" where the angler stops the motor and casts to key structures.

KAYAK STEERING & ACTIVE BOAT POSITIONING CONSTRAINTS:
- Kayak: Native Watersports Slayer Propel Max 12.5 with a manual pedal drive and a Newport NK180 Pro stern-mounted electric motor.
- **IMPORTANT**: Your Newport NK180 Pro trolling motor has **NO Spot-Lock / GPS auto-anchor** capability.
- **ADVANTAGE**: The pedal drive is a Propel drive which features instant mechanical reverse (pedal backward to instantly reverse).
- In any stop_and_cast "tacticalNote", you must detail the exact manual boat control strategy:
  - If deep/open-water structure in wind/current: suggest using the instant-reverse pedals to "Pedal-Hover" hands-free.
  - If standing timber, brush piles, or docks: suggest using a physical "Brush Gripper" clamp or dock ropes to tie off silently.
  - If shallow flats: suggest using a physical stakeout pole or anchoring with a trolley line.
  - If drifting parallel to shore/riprap: suggest natural wind drifts with 5% NK180 steer control.
- 2 rods max in water simultaneously while trolling (port + starboard). No live bait, no downriggers, spinning rods only.${coastalSafetyBlock}

AVAILABLE TACKLE FOR TROLLING — use ONLY these exact names for trolling:
${inventoryNames.join(', ')}

${castingTackleBlock(castableNames, fishingContext?.stopTargetDepth || 15)}

MAPPED STRUCTURES NEAR YOUR ROUTE (use these EXACT names for stop_and_cast entries that target these locations):
${candidateList}

HAZARD ZONES (do NOT plan stops near these — route around them):
${hazardZones.length ? hazardZones.map(h => `[${h.lat}, ${h.lon}] — 500ft exclusion zone`).join('\n') : 'None marked'}

CRITICAL: When creating a stop_and_cast that targets one of the mapped structures above, use the EXACT name from the list (e.g. "Depth Ledge / Drop-off #1") so the waypoint can be placed on the map. You may add additional LLM-generated stops with creative names for structures not in the list.

Return ONLY valid JSON, no markdown:
{
  "isGo": <boolean>,
  "safetyWarning": "<If isGo is false, explain the hazard. If true, write 'Conditions look safe for a kayak.'>",
  "rampEvaluation": "<One sentence evaluating the wind exposure for the selected boat ramp>",
  "speed": <legacy fallback mph; set this equal to band1.speed>,
  "speedRationale": "<one sentence covering the two pass speeds>",
  "band1": {
    "depthMin": <ft>, "depthMax": <ft>, "speed": <mph>,
    "speedRationale": "<why this pass speed fits both selected lures>",
    "port": "<exact name from AVAILABLE_TROLLING_TACKLE>", "starboard": "<exact name from AVAILABLE_TROLLING_TACKLE>",
    "portColor": "<color>", "starboardColor": "<color>",
    "portLeadFt": <ft>, "starboardLeadFt": <ft>,
    "why": "<one sentence species behavior>"
  },
  "band2": {
    "depthMin": <ft>, "depthMax": <ft>, "speed": <mph>,
    "speedRationale": "<why this pass speed fits both selected lures>",
    "port": "<exact name from AVAILABLE_TROLLING_TACKLE>", "starboard": "<exact name from AVAILABLE_TROLLING_TACKLE>",
    "portColor": "<color>", "starboardColor": "<color>",
    "portLeadFt": <ft>, "starboardLeadFt": <ft>,
    "why": "<one sentence species behavior>"
  },
  "castRods": [
    { "rod": 1, "lure": "<exact name from AVAILABLE_CASTING_TACKLE not used in band1/band2>", "rigging": "<e.g. direct braid to snap, no weight>", "jigheadWeight": "<oz or null>", "presentation": "<one sentence>" },
    { "rod": 2, "lure": "<exact name from AVAILABLE_CASTING_TACKLE not used in band1/band2>", "rigging": "<e.g. 20lb fluoro leader>", "jigheadWeight": "<oz or null>", "presentation": "<one sentence>" }
  ],
  "structureFocus": "<fishfinder signature to find>",
  "adjustmentTip": "<if no bites after 30min, do this>",
  "scoutNotes": "<2-3 sentence tactical overview>",
  "fishfinderNarrative": "<A short 150-word narrative telling the angler what to look for on the sonar screen during these routes, and how to work the specific lures rigged.>",
  "timeline": [
    NOTE: The timeline MUST have 4 troll entries (Ph1 Out, Ph1 In, Ph2 Out, Ph2 In) AND at least 2-3 stop_and_cast entries interleaved between them. Place stops where structure warrants — between Ph1 Out and Ph1 In, between Ph1 In and Ph2 Out, and/or between Ph2 Out and Ph2 In. Never return only 1 stop_and_cast.
    {
      "step": 1,
      "type": "troll",
      "phaseName": "Dawn Shallow",
      "depthMin": <ft>, "depthMax": <ft>, "speed": <mph>,
      "port": "<exact name from AVAILABLE_TROLLING_TACKLE>", "starboard": "<exact name from AVAILABLE_TROLLING_TACKLE>",
      "portColor": "<color>", "starboardColor": "<color>",
      "portLeadFt": <ft>, "starboardLeadFt": <ft>,
      "why": "<one sentence behavior>"
    },
    {
      "step": 2,
      "type": "stop_and_cast",
      "name": "Dutchmans Point Ledge",
      "targetStructure": "rocky point / shallow flat",
      "targetDepth": 6,
      "presentation": "Upper water column, high-vibe baitfish profile (aggressive morning bite)",
      "recommendedLures": [
        { "name": "<exact name from AVAILABLE_CASTING_TACKLE>", "confidence": "95%" },
        { "name": "<exact name from AVAILABLE_CASTING_TACKLE>", "confidence": "92%" }
      ],
      "tacticalNote": "Position the kayak 40 yards downwind off the point. Use Propel instant-reverse pedals to hover against the wind while casting a walking bait."
    },
    {
      "step": 3,
      "type": "troll",
      "phaseName": "Ph1 Inbound",
      ...
    },
    {
      "step": 4,
      "type": "stop_and_cast",
      "name": "Channel Swing Drop",
      ...
    },
    {
      "step": 5, "type": "troll", "phaseName": "Ph2 Outbound", ...
    },
    {
      "step": 6, "type": "troll", "phaseName": "Ph2 Inbound", ...
    }
  ]
}`;

  let groqPlan=null;
  let rawGroqText = '';
  let isFallback = false;
  let llmProviderInfo = null;

  try {
    if (outEl) outEl.value='⏳ Calling Groq (/groq-query)… [openai/gpt-oss-120b → fallback chain]';
    const res=await fetch(`${CF_WORKER_URL}/groq-query`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        messages:[
          {role:'system',content:'You are TrollMap Smart Plan. Return only one valid JSON object and no markdown.'},
          {role:'user',content:planPrompt}
        ],
        max_tokens:3000,
        temperature:0.25,
        response_format:{type:'json_object'}
      }),
    });

    rawGroqText = await res.text();
    const provHeader = res.headers.get('X-LLM-Provider');
    const modelHeader = res.headers.get('X-LLM-Model');
    if (provHeader) {
      llmProviderInfo = `${provHeader}/${modelHeader}`;
      console.log(`[smart-plan] LLM provider: ${llmProviderInfo}`);
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${rawGroqText.slice(0,400)}`);
    }

    const data = JSON.parse(rawGroqText);
    if (data._trollmap) {
      llmProviderInfo = `${data._trollmap.provider}/${data._trollmap.model}`;
      console.log(`[smart-plan] LLM resolved to ${llmProviderInfo}`);
    }
    const rawContent = data.choices?.[0]?.message?.content;
    const content = (Array.isArray(rawContent)
      ? rawContent.map(part => (typeof part === 'string' ? part : (part?.text || part?.content || ''))).join('')
      : (rawContent || data.output_text || '')).trim();

    if (!content) {
      const finish = data.choices?.[0]?.finish_reason;
      throw new Error(`LLM returned empty content${finish ? ` (finish_reason=${finish})` : ''}`);
    }

    const clean = content.replace(/```json|```/g,'').trim();
    const si = clean.indexOf('{'), ei = clean.lastIndexOf('}');

    if (si === -1 || ei === -1) throw new Error(`No JSON object in response: ${clean.slice(0,200)}`);

    groqPlan = JSON.parse(clean.slice(si, ei+1));
    console.log(`[smart-plan] ✓ Groq plan parsed via ${llmProviderInfo || 'unknown provider'}`);

  } catch(e) {
    console.error('[smart-plan] Groq Error:', e.message, e.stack || '');
    isFallback = true;
    
    const phaseRecs=phaseInfo.phases.map(p=>getPhaseRecommendation(sp,lakeName,season,p.num,waterTempF));
    const r1=phaseRecs[0]||{depthMin:12,depthMax:18,speed:1.8};
    const r2=phaseRecs[1]||{depthMin:22,depthMax:28,speed:1.8};
    
    const fallPort1  = depthFallbackLure(r1.depthMin + 2, inventoryNames);
    const fallStbd1  = depthFallbackLure(r1.depthMax - 2, inventoryNames);
    const fallPort2  = depthFallbackLure(r2.depthMin + 2, inventoryNames);
    const fallStbd2  = depthFallbackLure(r2.depthMax - 2, inventoryNames);
    
    const defaultFallbackTimeline = [
      {
        step: 1,
        type: 'troll',
        phaseName: 'Dawn Shallow Patrol',
        depthMin: r1.depthMin,
        depthMax: r1.depthMax,
        speed: r1.speed || 1.8,
        port: fallPort1,
        starboard: fallStbd1,
        portColor: 'Natural',
        starboardColor: 'Metallic',
        portLeadFt: 40,
        starboardLeadFt: 50,
        why: 'Fallback: mid-depth morning run'
      },
      {
        step: 2,
        type: 'stop_and_cast',
        name: 'Dutchman Creek Shallow Point',
        targetStructure: 'rocky point / shallow flat',
        targetDepth: 6,
        presentation: 'Upper water column, high-vibe baitfish profile (aggressive morning bite)',
        recommendedLures: [
          { name: 'Walking Bait / Spook', confidence: '95%' },
          { name: 'Underspin Jig (Flashy Swimmer)', confidence: '92%' }
        ],
        tacticalNote: 'Position the kayak 40 yards downwind off the point. Use Propel instant-reverse pedals to hover against the wind while casting a walking bait.'
      },
      {
        step: 3,
        type: 'troll',
        phaseName: 'Mid-Morning Transition',
        depthMin: r2.depthMin,
        depthMax: r2.depthMax,
        speed: r2.speed || 1.8,
        port: fallPort2,
        starboard: fallStbd2,
        portColor: 'Natural',
        starboardColor: 'Natural',
        portLeadFt: 50,
        starboardLeadFt: 60,
        why: 'Fallback: deep mid-morning run'
      }
    ];

    groqPlan={
      isGo: true,
      safetyWarning: `Groq API Failed (${e.message}). Proceed with caution.`,
      rampEvaluation: "Could not evaluate wind exposure due to API failure.",
      speed:r1.speed||1.8, speedRationale:'Species-intel fallback — Groq unavailable',
      band1:{depthMin:r1.depthMin,depthMax:r1.depthMax,speed:r1.speed||1.8,speedRationale:'Species-intel fallback speed for Band 1',port:fallPort1,starboard:fallStbd1,portColor:'Natural',starboardColor:'Metallic',portLeadFt:40,starboardLeadFt:50,why:'Fallback: mid-depth morning run'},
      band2:{depthMin:r2.depthMin,depthMax:r2.depthMax,speed:r2.speed||1.8,speedRationale:'Species-intel fallback speed for Band 2',port:fallPort2,starboard:fallStbd2,portColor:'Natural',starboardColor:'Natural',portLeadFt:50,starboardLeadFt:60,why:'Fallback: deep mid-morning run'},
      structureFocus:'Look for baitfish marks suspended over channel edges on the fishfinder.',
      adjustmentTip:'Shorten lead 10ft and slow to 1.5mph if no bites.',
      scoutNotes:`Groq API Failed (${e.message}). Running Fallback Plan.`,
      fishfinderNarrative: `⚠ Groq Narrative Failed. Fallback: Look for baitfish marks suspended over drop-offs.`,
      timeline: defaultFallbackTimeline
    };
  }

  // ── Safety Abort ────────────────────────────────────────────────────────
  if (groqPlan.isGo === false) {
    setStatus(`🚨 NO-GO: Unsafe Conditions for Kayak`, false);
    const abortMessage = `🚨 ABORT TRIP 🚨\n\nAI Guide Evaluation:\n${groqPlan.safetyWarning}\n\nRamp Evaluation:\n${groqPlan.rampEvaluation}\n\nDo not launch the kayak in these conditions.`;
    
    renderSmartPlanUI({
      routeRods: {},
      scoutReport: `${abortMessage}\n\n── RAW JSON OUTPUT ──\n${JSON.stringify(groqPlan, null, 2)}`,
      speedMph: 0,
      phases: [],
      solunar: solunarStr
    });
    return;
  }

  const b1mid=(groqPlan.band1.depthMin+groqPlan.band1.depthMax)/2;
  const b2mid=(groqPlan.band2.depthMin+groqPlan.band2.depthMax)/2;
  groqPlan.band1.port      =sanitizeGroqLureName(groqPlan.band1.port,      b1mid-2, inventoryNames);
  groqPlan.band1.starboard =sanitizeGroqLureName(groqPlan.band1.starboard,  b1mid+2, inventoryNames);
  groqPlan.band2.port      =sanitizeGroqLureName(groqPlan.band2.port,      b2mid-2, inventoryNames);
  groqPlan.band2.starboard =sanitizeGroqLureName(groqPlan.band2.starboard,  b2mid+2, inventoryNames);

  // Sanitize chronological timeline items
  if (groqPlan.timeline && Array.isArray(groqPlan.timeline)) {
    groqPlan.timeline.forEach(step => {
      if (step.type === 'troll') {
        const stepMid = (step.depthMin + step.depthMax)/2 || 15;
        step.port = sanitizeGroqLureName(step.port, stepMid - 2, inventoryNames);
        step.starboard = sanitizeGroqLureName(step.starboard, stepMid + 2, inventoryNames);
      } else if (step.type === 'stop_and_cast') {
        if (step.recommendedLures && Array.isArray(step.recommendedLures)) {
          step.recommendedLures.forEach(lure => {
            lure.name = sanitizeGroqLureName(lure.name, step.targetDepth || 8, castableNames);
          });
        }
      }
    });
  }

  const band1SpeedGuard = capPassSpeed(
    groqPlan.band1?.speed ?? groqPlan.speed,
    [groqPlan.band1.port, groqPlan.band1.starboard],
    inventory,
  );
  const band2SpeedGuard = capPassSpeed(
    groqPlan.band2?.speed ?? groqPlan.speed,
    [groqPlan.band2.port, groqPlan.band2.starboard],
    inventory,
  );
  const band1Speed = band1SpeedGuard.appliedMph;
  const band2Speed = band2SpeedGuard.appliedMph;
  const passSpeedGuards = [
    { label: 'Band 1', guard: band1SpeedGuard },
    { label: 'Band 2', guard: band2SpeedGuard },
  ];
  const speedCapNotes = passSpeedGuards.filter(({ guard }) => guard.wasCapped).map(({ label, guard }) => {
    const limitingNames = [...new Set(guard.limitingLures.map((lure) => lure.name))].join(' + ');
    console.warn(
      `[smart-plan] ${label} speed override: Groq requested ${guard.requestedMph} mph; ` +
      `${limitingNames} limits this pass to ${guard.maxMph} mph.`,
    );
    return `⚠ ${label} speed capped at ${guard.appliedMph} mph (Groq requested ${guard.requestedMph} mph; ${limitingNames} max ${guard.maxMph} mph).`;
  });

  groqPlan.band1.speed = band1Speed;
  groqPlan.band2.speed = band2Speed;
  groqPlan.speed = band1Speed;
  const routeSpeeds = {
    'Ph1 Outbound': band1Speed,
    'Ph1 Inbound': band1Speed,
    'Ph2 Outbound': band2Speed,
    'Ph2 Inbound': band2Speed,
  };
  const speedEl = document.getElementById('planSpeed');
  if (speedEl) speedEl.value = String(band1Speed);
  rangeMiles = computeRangeMiles(Math.max(band1Speed, band2Speed));

  // ── Build rod rows ────────────────────────────────────────────────────────
  function buildRodFromGroq(lureName,colorName,depthFt,slotIdx,phaseLabel,bandSpeedMph) {
    const cleanLureName = stripLureAnnotation(lureName);
    const bareNames = inventoryNames.map(n => stripLureAnnotation(n));
    const finalLure = bareNames.includes(cleanLureName)
      ? cleanLureName
      : (inventoryNames.map(n => stripLureAnnotation(n)).find(n => n === cleanLureName) || bareNames[0]);
    const reel=reelForLure(finalLure);
    const rod={
      side:slotIdx===0?'Port':'Starboard', position:'Mid',
      rod:"7' M Mod-Fast Spinning (Ugly Stik Lite Pro)", reel,
      lure:finalLure, color:colorName||getLureColor(finalLure,clarity.toLowerCase().includes('mud')?'muddy':clarity.toLowerCase().includes('stain')?'stained':'clear'),
      depth:String(depthFt), lead:'0', notes:phaseLabel,
      trailerSize:'', arigWeight:'', jigWeight:'',
    };
    if (finalLure?.toLowerCase().includes('a-rig')) {
      const isLight=finalLure.includes('Light')||finalLure.includes('1.65');
      const isMedium=finalLure.includes('Medium')||finalLure.includes('2.65');
      rod.arigWeight =isLight?'~1.65oz (5-wire light)':isMedium?'~2.65oz (5-wire medium)':'~3.5oz (5-wire heavy)';
      rod.trailerSize=isLight?'3.8" swimbait':isMedium?'4.6" swimbait':'5" swimbait';
      rod.jigWeight  =isLight?'1/8oz × 5':isMedium?'3/16oz × 5':'1/4oz × 5';
    }
    let calcLead = autoCalculateLead(rod, bandSpeedMph || band1Speed);
    const lureL = (rod.lure||'').toLowerCase();
    const isVarDepth = lureL.includes('a-rig') || lureL.includes('swimbait') ||
      lureL.includes('spoon') || lureL.includes('spinnerbait') ||
      lureL.includes('chatterbait') || lureL.includes('bucktail') ||
      lureL.includes('marabou') || lureL.includes('jighead') ||
      lureL.includes('road runner');
    if (isVarDepth && calcLead > 80) calcLead = 80;
    const isCrankbait = lureL.includes('crankbait') || lureL.includes('lipless') ||
      lureL.includes('blade vibe');
    if (isCrankbait && calcLead > 100) calcLead = 100;
    rod.lead = String(calcLead);
    return rod;
  }

  const routeRods = {
    'Ph1 Outbound': [
      buildRodFromGroq(groqPlan.band1.port,      groqPlan.band1.portColor,  b1mid-2, 0, 'Ph1 Out', band1Speed),
      buildRodFromGroq(groqPlan.band1.starboard,  groqPlan.band1.starboardColor, b1mid+2, 1, 'Ph1 Out', band1Speed),
    ],
    'Ph1 Inbound': [
      buildRodFromGroq(groqPlan.band1.port,      groqPlan.band1.portColor,  b1mid-2, 0, 'Ph1 In',  band1Speed),
      buildRodFromGroq(groqPlan.band1.starboard,  groqPlan.band1.starboardColor, b1mid+2, 1, 'Ph1 In',  band1Speed),
    ],
    'Ph2 Outbound': [
      buildRodFromGroq(groqPlan.band2.port,      groqPlan.band2.portColor,  b2mid-2, 0, 'Ph2 Out', band2Speed),
      buildRodFromGroq(groqPlan.band2.starboard,  groqPlan.band2.starboardColor, b2mid+2, 1, 'Ph2 Out', band2Speed),
    ],
    'Ph2 Inbound': [
      buildRodFromGroq(groqPlan.band2.port,      groqPlan.band2.portColor,  b2mid-2, 0, 'Ph2 In',  band2Speed),
      buildRodFromGroq(groqPlan.band2.starboard,  groqPlan.band2.starboardColor, b2mid+2, 1, 'Ph2 In',  band2Speed),
    ],
  };

  // ── Generate waypoints ────────────────────────────────────────────────────
  setStatus('Routing over the water graph…',true);
  const totalWaypoints=await generateScoutWaypoints(
    phaseInfo.phases,
    [{depthMin:groqPlan.band1.depthMin,depthMax:groqPlan.band1.depthMax},{depthMin:groqPlan.band2.depthMin,depthMax:groqPlan.band2.depthMax}],
    rampLat,rampLon,rangeMiles,[band1Speed, band2Speed],phaseInfo
  );

  if (phaseInfo?.phases?.length) {
    window._trollmapPhases = phaseInfo.phases.map(p => ({ startH: p.start, endH: p.end, num: p.num }));
    if (window.trollmapLoadPhaseNotifications) window.trollmapLoadPhaseNotifications(phaseInfo.phases);
  }
  window._smartPlanPhaseRoutes = [
    { phase:1, phaseName:'Shallow', depthMin:groqPlan.band1.depthMin, depthMax:groqPlan.band1.depthMax, speed:band1Speed, window:'Band 1' },
    { phase:2, phaseName:'Deep',    depthMin:groqPlan.band2.depthMin, depthMax:groqPlan.band2.depthMax, speed:band2Speed, window:'Band 2' },
  ];
  applyStoredSmartPlanDepth();
  const targetDepthEl = document.getElementById('planTargetDepth');
  if (targetDepthEl) {
    targetDepthEl.value = `${groqPlan.band1.depthMin}-${groqPlan.band1.depthMax}ft / ${groqPlan.band2.depthMin}-${groqPlan.band2.depthMax}ft`;
  }
  syncSpread(null,routeRods,routeSpeeds);
  window._smartPlanRouteRods=routeRods;

  // ── Build route-aware casting stop candidates ───────────────────────────
  const STOP_RADIUS_FT = 1500; // kayak casting range — structures within ~0.3mi of route are reachable
  const stopCandidates = [];
  const addedCoords = [];

  // hazardZones is built ABOVE, before planPrompt -- the prompt reads it.


  function isNearHazard(lat, lon, radiusFt = 500) {
    return hazardZones.some(h => distFtGeneric(lat, lon, h.lat, h.lon) < radiusFt);
  }

  const distFt = distFtGeneric;

  function nearestRoutePoint(lat, lon) {
    const tracks = (state.DATA?.tracks || []).filter(t => t.smartPlan);
    let best = null;
    for (const track of tracks) {
      const pts = track.pts || [];
      for (let i = 0; i < pts.length; i++) {
        const d = distFt(lat, lon, pts[i][0], pts[i][1]);
        if (!best || d < best.distFt) {
          best = { distFt: d, trackName: track.name, ptIdx: i, progressPct: Math.round(i / pts.length * 100) };
        }
      }
    }
    return best;
  }

  function etaMinutes(trackName, progressPct, rangeMiles, phaseSpeeds) {
    const speed = trackName?.includes('Ph2') ? (phaseSpeeds?.band2 || 2) : (phaseSpeeds?.band1 || 1.8);
    const trackMiles = rangeMiles / 4;
    const elapsedMiles = trackMiles * progressPct / 100;
    return Math.round(elapsedMiles / speed * 60);
  }

  function tryAddStop(candidate) {
    // Skip hazard waypoints and anything named like a hazard
    if (HAZARD_PATTERNS.test(candidate.name || '') || HAZARD_SYMS.includes(candidate.sym || '')) return;
    if (!candidate.lat || !candidate.lon) {
      const ungrounded = stopCandidates.filter(s => !s.lat);
      if (ungrounded.length >= 2) return;
      stopCandidates.push(candidate);
      return;
    }
    // Skip candidates within 500ft of a user-marked hazard
    if (isNearHazard(candidate.lat, candidate.lon)) return;
    if (addedCoords.some(c => distFt(candidate.lat, candidate.lon, c.lat, c.lon) < 300)) return;
    const nearest = nearestRoutePoint(candidate.lat, candidate.lon);
    if (!nearest || nearest.distFt > STOP_RADIUS_FT) return;
    candidate.routeContext = {
      trackName: nearest.trackName,
      distFromRouteFt: Math.round(nearest.distFt),
      progressPct: nearest.progressPct,
      etaMin: etaMinutes(nearest.trackName, nearest.progressPct, rangeMiles, { band1: band1Speed, band2: band2Speed }),
    };
    addedCoords.push({ lat: candidate.lat, lon: candidate.lon });
    stopCandidates.push(candidate);
  }

  try {
    const researchedProfile = fishingContext?.researchedProfile;
    const habitat = researchedProfile?.habitat || {};
    const biology = researchedProfile?.biology || {};
    const season = fishingContext?.season || getSeason(new Date());

    if (rampLat && rampLon && window.getSupplementalContext) {
      try {
        const routeTracks = (state.DATA?.tracks || []).filter(t => t.smartPlan);
        const allPts = routeTracks.flatMap(t => t.pts || []);
        if (allPts.length) {
          const lats = allPts.map(p => p[0]);
          const lons = allPts.map(p => p[1]);
          const cLat = (Math.min(...lats) + Math.max(...lats)) / 2;
          const cLon = (Math.min(...lons) + Math.max(...lons)) / 2;
          const radiusMi = Math.max(1.0,
            distFt(Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)) / 5280 / 2
          );
          const ctx = window.getSupplementalContext(cLat, cLon, radiusMi);
          for (const a of (ctx.attractors || [])) {
            if (!a.lat || !a.lon) continue;
            tryAddStop({
              type: 'fish_attractor',
              name: a.name || 'Fish Attractor',
              lat: a.lat, lon: a.lon,
              score: 9,
              reason: 'Mapped fish attractor on or near route — confirmed brush pile / structure',
              structureType: 'artificial attractor',
            });
          }
          for (const sp of (ctx.fishingPoints || [])) {
            if (!sp.lat || !sp.lon) continue;
            tryAddStop({
              type: 'community_spot',
              name: sp.name || 'Community Fishing Spot',
              lat: sp.lat, lon: sp.lon,
              score: 6,
              reason: 'Community-marked fishing location on or near route',
              structureType: 'community spot',
            });
          }
        }
      } catch (err) {
        // Community spots are a bonus layer over the plan. Non-fatal, but a silent failure
        // here is indistinguishable from "nobody has marked anything on this lake".
        console.warn('[smart-plan] community spot scoring failed:', err);
      }
    }

    // The angler-marked structure block was here until 2026-08-07. It read getMyStructures()
    // -- the QuickDraw pin store, deleted with the structure mapper. Its replacement is
    // water_features.geojson and the Garmin POI layer, which carry the same kinds measured
    // rather than hand-dropped, and which this planner does not read yet. Tracked in
    // APP_CHANGE_REQUESTS.md under the SmartPlan rebuild.

    const structuralElements = researchedProfile?.habitat?.structuralElements || {};
    for (const hump of (structuralElements.humpCoordinates || [])) {
      if (!hump.lat || !hump.lon) continue;
      tryAddStop({
        type: 'hump',
        name: `Offshore Hump ${hump.id?.replace('hump_', '#') || ''}${hump.areaAcres ? ` (~${hump.areaAcres}ac)` : ''}`,
        lat: hump.lat, lon: hump.lon,
        score: 8,
        reason: `Offshore high spot${hump.reliefFt ? `, ${hump.reliefFt}ft of relief` : ''}${hump.depth ? `, crown at ~${hump.depth}ft` : ''}.`,
        structureType: 'offshore hump',
      });
    }
    for (const ledge of (structuralElements.ledgeCoordinates || [])) {
      if (!ledge.lat || !ledge.lon) continue;
      tryAddStop({
        type: 'ledge',
        name: `Depth Ledge / Drop-off ${ledge.id?.replace('ledge_', '#') || ''}`,
        lat: ledge.lat, lon: ledge.lon,
        score: 7,
        reason: `${ledge.dropFt ?? '?'} ft drop over ${ledge.runFt ?? '?'} ft — ${ledge.slopeFtPer100Ft ?? '?'} ft per 100 ft of bottom.`,
        structureType: 'channel ledge / drop-off',
      });
    }

    const attractorCount = habitat.artificialHabitatDetails?.attractorCount;
    if (attractorCount > 0) {
      tryAddStop({
        type: 'fish_attractor',
        name: `${attractorCount} Mapped Fish Attractors (lake-wide)`,
        score: 7,
        reason: `${attractorCount} official attractors on this lake — watch sonar`,
        structureType: 'artificial attractor',
      });
    }
    const spawnTiming = biology.spawnTiming || {};
    const targetSpawn = spawnTiming[sp] || spawnTiming[Object.keys(spawnTiming).find(k => k.toLowerCase().includes((sp||'').toLowerCase().split(' ')[0])) || ''];
    if (targetSpawn && (season === 'spring' || season === 'winter')) {
      tryAddStop({
        type: 'spawn_flat',
        name: 'Spawning Flats / Coves',
        score: 8,
        reason: `${sp} spawn timing: ${targetSpawn} — shallow coves/flats spawn targets`,
        structureType: 'shallow flat / spawning area',
      });
    }

    stopCandidates.sort((a, b) => b.score - a.score);
    stopCandidates.splice(8);

  } catch (stopErr) {
    console.warn('[smart-plan] Stop candidate build failed:', stopErr.message);
  }

  // Persist raw Groq timeline for debugging and for collectPlan fallback
  try {
    window._groqPlanTimeline = groqPlan.timeline ? JSON.parse(JSON.stringify(groqPlan.timeline)) : null;
    window._smartPlanStopCandidates = stopCandidates.slice();
    window._smartPlanRouteRods = routeRods;
    window._smartPlanRouteSpeeds = routeSpeeds;
    window._smartPlanCastRods = Array.isArray(groqPlan.castRods) ? groqPlan.castRods : [];
  } catch (_) {
    // This is JSON.parse(JSON.stringify(x)) -- a deep clone, not a parse of foreign input.
    // It can only throw on a cycle or a non-serialisable value, which is a bug in whatever
    // built the timeline, not a bad feed. Silence turned that into an empty plan.
    console.warn(`[smart-plan] timeline clone failed:`, _ && _.message);
  }

  const b1p=routeRods['Ph1 Outbound'][0], b1s=routeRods['Ph1 Outbound'][1];
  const b2p=routeRods['Ph2 Outbound'][0], b2s=routeRods['Ph2 Outbound'][1];

  const scoutText=[
    `════════ TACTICAL OVERVIEW ════════`,
    llmProviderInfo ? `LLM: ${llmProviderInfo}${isFallback ? ' (FALLBACK)' : ''}` : (isFallback ? 'LLM: fallback (Groq unavailable)' : ''),
    groqPlan.scoutNotes||'',
    `Pass speeds: Band 1 outbound + inbound ${band1Speed} mph · Band 2 outbound + inbound ${band2Speed} mph.`,
    ...speedCapNotes,
    '',
    `════════ SAFETY & RAMP ════════`,
    groqPlan.safetyWarning,
    groqPlan.rampEvaluation,
    '',
    `════════ BAND 1 — ${groqPlan.band1.depthMin}-${groqPlan.band1.depthMax}ft ════════`,
    `Why: ${groqPlan.band1.why}`,
    `Pass speed: ${band1Speed} mph (outbound + inbound)`,
    `Port: ${b1p.lure} (${b1p.color}) — Lead: ${b1p.lead}ft`,
    `Stbd: ${b1s.lure} (${b1s.color}) — Lead: ${b1s.lead}ft`,
    '',
    `════════ BAND 2 — ${groqPlan.band2.depthMin}-${groqPlan.band2.depthMax}ft ════════`,
    `Why: ${groqPlan.band2.why}`,
    `Pass speed: ${band2Speed} mph (outbound + inbound)`,
    `Port: ${b2p.lure} (${b2p.color}) — Lead: ${b2p.lead}ft`,
    `Stbd: ${b2s.lure} (${b2s.color}) — Lead: ${b2s.lead}ft`,
    '',
    `════════ FISHFINDER GUIDE ════════`,
    `Target: ${groqPlan.structureFocus||''}`,
    groqPlan.fishfinderNarrative ? '\n'+groqPlan.fishfinderNarrative : '',
    '',
    `💡 Tip: ${groqPlan.adjustmentTip||''}`,
    '',
    `════════ RAW JSON DEBUG ════════`,
    rawGroqText || JSON.stringify(groqPlan, null, 2)
  ].filter(l=>l!==null&&l!==undefined).join('\n');

  if (outEl) outEl.value = scoutText;
  window._smartPlanRationale = scoutText;

  renderSmartPlanUI({
    routeRods,
    scoutReport: scoutText,
    speedMph: band1Speed,
    routeSpeeds,
    phases: phaseInfo.phases,
    solunar: solunarStr,
    stopCandidates,
    timeline: groqPlan.timeline || null, // Unified timeline source
  });

  // After UI builds unified timeline and interleaves CAST waypoints, re-render map to show new ordering
  callSafely(renderAll, 'renderAll (post-timeline map refresh)');

  const intelSection=document.getElementById('planIntelSection');
  if (intelSection) intelSection.style.display='block';
  const solunarDisplay=document.getElementById('planSolunarDisplay');
  if (solunarDisplay) solunarDisplay.textContent=solunarStr;
  // `window._smartPlanSolunar` was written here and read by nothing -- grep the tree.
  // The global that actually drives the bite alerts is `_trollmapSolunar`,
  // written by plan-builder.js. Removed 2026-08-03.
  const solunarMetaEl = document.getElementById('planSolunar');
  if (solunarMetaEl) solunarMetaEl.value = solunarStr;
  const lakeIntelVal=document.getElementById('planLakeIntel')?.value||'';
  const lakeIntelDisplay=document.getElementById('planLakeIntelDisplay');
  if (lakeIntelDisplay&&lakeIntelVal) lakeIntelDisplay.textContent=lakeIntelVal;
  const clarityIntelVal=document.getElementById('planClarityIntel')?.value||'';
  const clarityIntelDisplay=document.getElementById('planClarityIntelDisplay');
  if (clarityIntelDisplay&&clarityIntelVal) clarityIntelDisplay.textContent=clarityIntelVal;
  const safetyDisplay=document.getElementById('planSafetyDisplay');
  if (safetyDisplay) {
    safetyDisplay.innerHTML=['• File a float plan with someone onshore before launching.','• Kayak: Native Watersports Slayer Propel Max 12.5 — confirm bilge plug is in.','• Motor: NK180 Pro 24V — check battery level before launch.','• PFD on at all times. Phone in dry bag.','• Check weather before launch — conditions can change rapidly on open water.',`• Return time: ${document.getElementById('planReturnTime')?.value||'set return time'}`].map(s=>`<div style="margin-bottom:4px">${s}</div>`).join('');
  }

  try {
    const coachSpread=Object.entries(routeRods).flatMap(([routeName,rods])=>
      rods.map(r=>({route:routeName,side:r.side,rod:r.rod||'',lure:r.lure||'',color:r.color||'',depth:r.depth||'',lead:r.lead||'',notes:(r.notes||'').slice(0,80)}))
    );

    const coachPayload=buildGroqCoachPayload(fishingContext,{
      phases:phaseInfo.phases,
      phaseRecs:[
        {depthMin:groqPlan.band1.depthMin,depthMax:groqPlan.band1.depthMax,speed:band1Speed,lures:[groqPlan.band1.port,groqPlan.band1.starboard],notes:groqPlan.band1.why},
        {depthMin:groqPlan.band2.depthMin,depthMax:groqPlan.band2.depthMax,speed:band2Speed,lures:[groqPlan.band2.port,groqPlan.band2.starboard],notes:groqPlan.band2.why},
      ],
      spread:coachSpread, solunarStr,
      speed: band1Speed,
      phaseSpeeds: { band1: band1Speed, band2: band2Speed },
      speedRationale: groqPlan.speedRationale,
      poolLevel:document.getElementById('planPoolLevel')?.value||null,
      weather:weatherStr, rationale: "Raw JSON dump sent", rampName:rampName||'', rangeMiles,
      stopCandidates: stopCandidates.length > 0 ? stopCandidates : undefined,
    });
    startCoachSession(coachPayload);
  } catch(e){console.warn('[smart-plan] Coach session failed:',e.message);}

  const wayptMsg=totalWaypoints>0
    ? (isFallback
        ? `⚠ Fallback plan — ${totalWaypoints} waypoints; Band1 ${band1Speed}mph, Band2 ${band2Speed}mph (Groq down, using local intel)`
        : `✓ Plan built via ${llmProviderInfo || 'Groq'} — ${totalWaypoints} waypoints; Band1 ${band1Speed}mph, Band2 ${band2Speed}mph, coach reviewing…`)
    : isFallback
      ? `⚠ Plan built with fallback logic but no contour data — load contours first.`
      : '⚠ No waypoints — load contour data first (Contour Data tab)';
  setStatus(wayptMsg,totalWaypoints>0 && !isFallback);

  if (window.trollmapReloadNotificationSession) window.trollmapReloadNotificationSession();
  return {groqPlan,phaseInfo,rangeMiles};
}

// v2 owns Generate now. It sets the flag when it binds, and both modules load before this fires.
// Checked rather than unbound because this handler was attached anonymously from a setTimeout and
// there is no reference left to removeEventListener with. When v1 is deleted this goes with it.
setTimeout(()=>{
  if (window.__smartPlanV2Owns) { console.log('[smart-plan] v2 owns Generate — v1 not bound'); return; }
  document.getElementById('runSmartPlanBtn')?.addEventListener('click',runSmartPlan);
},800);

window.runSmartPlan=runSmartPlan;
window.applyStoredSmartPlanDepth=applyStoredSmartPlanDepth;

console.log('[smart-plan] module ready — universal access + dynamic safety');
