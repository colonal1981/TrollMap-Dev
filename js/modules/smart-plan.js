/**
 * smart-plan.js — TrollMap Smart Plan Orchestrator
 *
 * Reads the Plan tab fields and generates a 3-phase fishing plan:
 *   - Phase 1: Dawn (launch → ~90min post-sunrise, topwater/shallow)
 *   - Phase 2: Transition (90min → 3.5hrs post-sunrise, mid-depth)
 *   - Phase 3: Deep (3.5hrs post-sunrise → return, thermocline)
 *
 * Solunar major/minor periods adjust phase boundaries and can
 * "interrupt" a phase when a major hits (bump back to shallower tactics).
 *
 * For each phase:
 *   - 2 rods pre-rigged with exact lure/color/depth/lead for that phase
 *   - Route auto-generated at that phase's depth band
 *
 * Range computation:
 *   - If BLE connected: remainingAh / draw × speed / 2 = one-way miles
 *   - Fallback: 100Ah / 6A avg × speed / 2 = one-way miles
 *   - Trip duration fallback: duration_hours × speed / 2
 *
 * Platform: Kayak (Native Watersports Slayer Propel Max 12.5),
 *   NK180 Pro motor (24V brushless, ~6A avg draw at trolling speed),
 *   100Ah LiFePO4 battery, 2 rods max in water at any time.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { newRodRow } from '../utils/rod-row.js';
import { renderSpread, autoCalculateLead } from './spread-builder.js';
import { onContourChange } from './contour-data.js';
import {
  SPECIES_BEHAVIOR, REGULATIONS,
  getSeason, getTimeOfDay, checkRegulations, resolveLakeKey,
} from '../data/species-intel.js';

// ── Constants ────────────────────────────────────────────────────────────────
const MAX_RODS_PER_PHASE = 2;       // kayak: 2 rods in water at a time
const TOTAL_RODS = 6;               // 6 rods on kayak, 2 per phase × 3 phases
const BATTERY_AH_DEFAULT = 100;     // LiFePO4 100Ah
const MOTOR_AMP_AVG = 6;            // NK180 Pro avg draw at ~2mph trolling
const PHASE_1_END_OFFSET_MIN = 90;  // minutes after sunrise Phase 1 ends (default)
const PHASE_2_END_OFFSET_MIN = 210; // minutes after sunrise Phase 2 ends (3.5hrs)

// ── Lure presets (must exactly match spread-builder.js LURE_PRESETS) ─────────
const LURE_COLOR_DEFAULTS = {
  'Choppo 90 – Topwater':                    'Bone / Natural',
  'Zara Spook – Topwater':                   'Bone / Natural',
  'Whopper Plopper 110 – Topwater':          'Grey Shad',
  'Bucktail Jig 1oz':                        'Chartreuse / White',
  'Marabou Jig 3/4oz':                       'Chartreuse / Shad',
  'A-Rig Light (~1.65oz) – 3.8" Swimbait':  'Natural Pearl / Smoke',
  'A-Rig Medium (~2.65oz) – 4.6" Swimbait': 'Blueback Herring',
  'A-Rig Heavy (~3.5oz) – 5" Swimbait':     'Alewife / Silver Flash',
  'Deep Hit Stick – Crankbait':              'Blue / Silver Herring',
  'Flicker Minnow 11 – Crankbait':          'Blue / Silver Herring',
  'Bandit 300 Series – Crankbait':           'Sexy Shad',
  'Rapala DT-10 – Crankbait':               'Tennessee Shad',
  'Rapala DT-14 – Crankbait':               'Tennessee Shad',
  'Swimbait 3.8" – Jighead':                'Natural Pearl / Smoke',
  'Swimbait 4.6" – Jighead':                'Blueback Herring',
  'Swimbait 5" – Jighead':                  'Alewife / Silver Flash',
  'Flutter Spoon 2oz':                       'Shattered Glass Silver',
  'Flutter Spoon 3oz':                       'Chrome / Silver',
  'Kastmaster 3/4oz':                        'Chrome / Silver',
  'ChatterBait 3/4oz':                       'Chartreuse / White',
};

// Short behavior-table names → exact LURE_PRESETS strings
const BEHAVIOR_LURE_MAP = {
  'Choppo 90':              'Choppo 90 – Topwater',
  'Rattling Spook':         'Zara Spook – Topwater',
  'Bucktail':               'Bucktail Jig 1oz',
  'A-Rig Light':            'A-Rig Light (~1.65oz) – 3.8" Swimbait',
  'A-Rig Medium':           'A-Rig Medium (~2.65oz) – 4.6" Swimbait',
  'A-Rig Heavy':            'A-Rig Heavy (~3.5oz) – 5" Swimbait',
  'Umbrella Rig 3/4oz':    'A-Rig Medium (~2.65oz) – 4.6" Swimbait',
  'Deep Hit Stick':         'Deep Hit Stick – Crankbait',
  'Crankbait':              'Flicker Minnow 11 – Crankbait',
  'Jigging spoon':          'Flutter Spoon 2oz',
  'Rockport Rattler jig':   'Bucktail Jig 1oz',
  'Jig + plastic trailer':  'Swimbait 4.6" – Jighead',
  'Casting plugs':          'Flicker Minnow 11 – Crankbait',
  'Flukes':                 'Swimbait 3.8" – Jighead',
  'Plugs':                  'Choppo 90 – Topwater',
  // Live-bait → note only, no preset
  'Live herring free-line':         null,
  'Live herring downline':          null,
  'Live blueback herring downline': null,
  'Live blueback herring':          null,
  'Live shad downline':             null,
  'Down-line live herring':         null,
  'Live bait downline':             null,
  'Live menhaden':                  null,
  'Free-line herring':              null,
  'Cut bait':                       null,
  'Live bait':                      null,
};

function resolveLure(rawName) {
  if (!rawName) return null;
  if (LURE_COLOR_DEFAULTS.hasOwnProperty(rawName)) return rawName;
  return BEHAVIOR_LURE_MAP.hasOwnProperty(rawName) ? BEHAVIOR_LURE_MAP[rawName] : null;
}

// ── Sunrise computation ───────────────────────────────────────────────────────
// Approximate astronomical sunrise for a lat/lon/date.
// Accurate to ~2 minutes for SC latitudes — good enough for phase planning.
// Uses the NOAA/Jean Meeus simplified algorithm.
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
  if (Math.abs(cosH) > 1) return 6.0; // fallback 6AM
  const H = Math.acos(cosH) * 180 / Math.PI;
  const RA = Math.atan2(Math.cos(23.439 * Math.PI / 180) * Math.sin(lambda), Math.cos(lambda)) * 180 / Math.PI;
  const t = 720 - 4 * (lon + H) - (RA - 15 * ((JD - 2451545) / 36525 * 360.9856474 % 360)) / 15;
  const utcHour = ((t / 60) + 24) % 24;
  return utcHour - 5; // EST (Wateree is UTC-5 standard, UTC-4 EDT)
}

// ── Solunar computation ───────────────────────────────────────────────────────
// Returns major1, major2, minor1, minor2 as decimal hours local time.
function computeSolunar(lat, lon, dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const JD = Math.floor(d / 86400000) + 2440587.5;
  const T = (JD - 2451545.0) / 36525;
  const Lm = 218.3164 + 481267.8812 * T;
  const moonTransitUT = (360 - (Lm % 360)) / 15; // rough transit hour UTC
  const offsetH = lon / 15; // longitude offset
  const major1 = ((moonTransitUT + offsetH + 24) % 24) - 5; // local
  const major2 = (major1 + 12) % 24;
  const minor1 = (major1 + 6) % 24;
  const minor2 = (major1 + 18) % 24;
  return { major1, major2, minor1, minor2 };
}

// ── Lake center coordinates (for sunrise/solunar) ─────────────────────────────
const LAKE_CENTERS = {
  'Lake Wateree':   { lat: 34.37,  lon: -80.73 },
  'Lake Murray':    { lat: 34.06,  lon: -81.32 },
  'Lake Marion':    { lat: 33.55,  lon: -80.30 },
  'Lake Moultrie':  { lat: 33.28,  lon: -80.05 },
  'Lake Monticello':{ lat: 34.44,  lon: -81.21 },
  'Parr Reservoir': { lat: 34.30,  lon: -81.16 },
};

function getLakeCenter(lakeName) {
  const key = Object.keys(LAKE_CENTERS).find(k =>
    lakeName.toLowerCase().includes(k.toLowerCase().replace('lake ', ''))
  );
  return key ? LAKE_CENTERS[key] : { lat: 34.37, lon: -80.73 }; // default Wateree
}

// ── Range computation ─────────────────────────────────────────────────────────
function computeRangeMiles(speedMph) {
  const spd = speedMph || 2.0;
  const bms = window.ACTIVE_BLE_BMS;
  if (bms && bms.connected && bms.remainingAh > 0 && bms.current > 0.1) {
    const hoursRemaining = bms.remainingAh / bms.current;
    return (hoursRemaining * spd) / 2; // one-way
  }
  // Fallback: full 100Ah battery, 6A avg draw
  return (BATTERY_AH_DEFAULT / MOTOR_AMP_AVG * spd) / 2;
}

// ── Phase boundary computation ────────────────────────────────────────────────
function computePhases(launchTimeStr, returnTimeStr, dateStr, lakeName) {
  const center = getLakeCenter(lakeName);
  const sunriseH = computeSunrise(center.lat, center.lon, dateStr);
  const sol = computeSolunar(center.lat, center.lon, dateStr);

  // Parse launch/return times
  function parseTimeStr(t) {
    if (!t) return null;
    const m = t.match(/(\d+):(\d+)\s*(am|pm)?/i);
    if (!m) return null;
    let h = parseInt(m[1]), min = parseInt(m[2]);
    if (m[3] && m[3].toLowerCase() === 'pm' && h < 12) h += 12;
    if (m[3] && m[3].toLowerCase() === 'am' && h === 12) h = 0;
    return h + min / 60;
  }

  const launchH = parseTimeStr(launchTimeStr) || 6.0;
  const returnH = parseTimeStr(returnTimeStr) || 12.0;

  // Default phase boundaries from sunrise
  let p1End = sunriseH + PHASE_1_END_OFFSET_MIN / 60;
  let p2End = sunriseH + PHASE_2_END_OFFSET_MIN / 60;

  // Solunar adjustment: if a major falls within a phase, extend that phase
  // to include the full feeding window (majors = ~2hr window, minors = ~1hr)
  [sol.major1, sol.major2].forEach(t => {
    if (t >= launchH && t <= p1End + 0.5) p1End = Math.max(p1End, t + 1.0);
    if (t >= p1End && t <= p2End + 0.5) p2End = Math.max(p2End, t + 1.0);
  });
  [sol.minor1, sol.minor2].forEach(t => {
    if (t >= launchH && t <= p1End + 0.25) p1End = Math.max(p1End, t + 0.5);
  });

  // Clamp to trip duration
  p1End = Math.min(p1End, returnH - 1.0);
  p2End = Math.min(p2End, returnH - 0.5);
  if (p1End >= p2End) p1End = launchH + (returnH - launchH) / 3;
  if (p2End >= returnH) p2End = launchH + 2 * (returnH - launchH) / 3;

  function hToStr(h) {
    const hh = Math.floor(((h % 24) + 24) % 24);
    const mm = Math.round((h % 1) * 60);
    const ampm = hh < 12 ? 'AM' : 'PM';
    return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${ampm}`;
  }

  return {
    sunriseH,
    solunar: sol,
    phases: [
      { num: 1, name: 'Dawn',       start: launchH, end: p1End, startStr: hToStr(launchH), endStr: hToStr(p1End) },
      { num: 2, name: 'Transition', start: p1End,   end: p2End, startStr: hToStr(p1End),  endStr: hToStr(p2End) },
      { num: 3, name: 'Deep',       start: p2End,   end: returnH, startStr: hToStr(p2End), endStr: hToStr(returnH) },
    ],
  };
}

// ── Per-phase behavior lookup ─────────────────────────────────────────────────
function getPhaseRecommendation(species, lakeName, season, phaseNum, waterTempF) {
  const lakeKey = resolveLakeKey(lakeName, SPECIES_BEHAVIOR);
  const seasonData = SPECIES_BEHAVIOR[lakeKey]?.[species]?.[season];
  if (!seasonData) return null;

  // Map phase number to time-of-day key
  const todKeys = { 1: 'dawn', 2: 'day', 3: 'day' };
  const tod = seasonData.timeOfDay[todKeys[phaseNum]] || seasonData.timeOfDay['day'];
  if (!tod) return null;

  let [dMin, dMax] = typeof seasonData.depthBand === 'function'
    ? seasonData.depthBand(waterTempF)
    : [...seasonData.depthBand];

  // Phase-specific depth adjustments beyond the standard time-of-day shift
  // Phase 1: Dawn — shallow (positive shift = shallower)
  // Phase 2: Transition — mid depth
  // Phase 3: Deep — push 4-6ft deeper than base band (fish thermocline/channel)
  const baseShift = tod.depthShift || 0;
  const phaseDepthShifts = { 1: baseShift, 2: Math.round(baseShift / 2), 3: -5 };
  const shift = phaseDepthShifts[phaseNum];
  dMin = Math.max(1, dMin + shift);
  dMax = Math.max(dMin + 4, dMax + shift);

  return {
    depthMin: dMin, depthMax: dMax,
    lures: tod.lures || [],
    speed: tod.speed || 2.0,
    notes: tod.notes || '',
  };
}

// ── Build 2 rods for a phase ──────────────────────────────────────────────────
function buildPhaseRods(phaseRec, phaseNum, sides) {
  if (!phaseRec) return [newRodRow(), newRodRow()];
  const depth = Math.round((phaseRec.depthMin + phaseRec.depthMax) / 2);
  const lures = phaseRec.lures.filter(Boolean);

  return sides.map((side, i) => {
    const rawLure = lures[i % Math.max(1, lures.length)];
    const resolved = resolveLure(rawLure);
    const rod = newRodRow({
      side,
      position: 'Mid',
      reel: 'Spinning / 30lb 8-strand braid + 20lb fluoro leader',
      depth: String(depth),
    });
    if (resolved) {
      rod.lure = resolved;
      rod.color = LURE_COLOR_DEFAULTS[resolved] || '';
      rod.lead = String(autoCalculateLead(rod, phaseRec.speed));

      // Auto-populate A-Rig trailer and jig weight fields for build page display
      if (resolved.includes('A-Rig')) {
        const isLight  = resolved.includes('Light')  || resolved.includes('1.65');
        const isMedium = resolved.includes('Medium') || resolved.includes('2.65');
        const isHeavy  = resolved.includes('Heavy')  || resolved.includes('3.5oz');
        rod.arigWeight  = isLight ? '~1.65oz Framework' : isMedium ? '~2.65oz Framework' : '~3.5oz Framework';
        rod.trailerSize = isLight ? '3.8" swimbait' : isMedium ? '4.6" swimbait' : '5" swimbait';
        rod.jigWeight   = isLight ? '1/8oz × 5 (Uniform)' : isMedium ? '3/16oz × 5 (Uniform)' : '1/4oz × 5 (Uniform)';
      }
    } else if (rawLure) {
      rod.notes = rawLure;
    }
    if (phaseRec.notes) {
      rod.notes = (rod.notes ? rod.notes + ' · ' : '') + phaseRec.notes.slice(0, 50);
    }
    return rod;
  });
}

// ── Route generation per phase ────────────────────────────────────────────────
async function generateRouteForPhase(phase, phaseRec, lakeName, rampLat, rampLon) {
  if (!phaseRec) return;

  window._smartPlanPhaseRoutes = window._smartPlanPhaseRoutes || [];
  window._smartPlanPhaseRoutes.push({
    phase: phase.num,
    phaseName: phase.name,
    depthMin: phaseRec.depthMin,
    depthMax: phaseRec.depthMax,
    speed: phaseRec.speed,
    window: `${phase.startStr} – ${phase.endStr}`,
  });

  const minEl = document.getElementById('rbDepthMin');
  const maxEl = document.getElementById('rbDepthMax');
  if (minEl) minEl.value = phaseRec.depthMin;
  if (maxEl) maxEl.value = phaseRec.depthMax;

  try {
    const { generateAndCommitRoute } = await import('./route-builder.js');
    const routeConfig = getRouteConfigForPhase(phaseRec, phase.num);
    const tracks = generateAndCommitRoute({
      ...routeConfig,
      depthMin:  phaseRec.depthMin,
      depthMax:  phaseRec.depthMax,
      trackName: `Phase ${phase.num} ${phase.name} (${phase.startStr}–${phase.endStr})`,
      rampLat:   rampLat ?? null,
      rampLon:   rampLon ?? null,
    });
    if (tracks?.length) {
      console.log(`[smart-plan] Phase ${phase.num} ${phase.name}: generated ${tracks.length} route(s) at ${phaseRec.depthMin}-${phaseRec.depthMax}ft`);
    }
  } catch (e) {
    console.warn('[smart-plan] Route generation failed:', e.message);
  }
}

// ── Apply to plan fields ──────────────────────────────────────────────────────
function applyToPlanFields(phaseRecs, phases) {
  // Use Phase 1 depth/speed as the primary plan fields
  const p1 = phaseRecs[0];
  if (!p1) return;
  const depthEl = document.getElementById('planTargetDepth');
  const speedEl = document.getElementById('planSpeed');
  if (depthEl) depthEl.value = `${p1.depthMin}-${p1.depthMax}`;
  if (speedEl) speedEl.value = String(p1.speed);
}

// ── Route Builder depth pre-fill on lazy open ─────────────────────────────────
export function applyStoredSmartPlanDepth() {
  const routes = window._smartPlanPhaseRoutes;
  if (!routes || !routes.length) return;
  const p1 = routes.find(r => r.phase === 1);
  if (!p1) return;
  const minEl = document.getElementById('rbDepthMin');
  const maxEl = document.getElementById('rbDepthMax');
  if (minEl) minEl.value = p1.depthMin;
  if (maxEl) maxEl.value = p1.depthMax;
  const note = document.getElementById('rbContourInfoText');
  if (note) {
    const phaseList = routes.map(r =>
      `Phase ${r.phase} (${r.phaseName}): ${r.depthMin}-${r.depthMax}ft @ ${r.speed}mph [${r.window}]`
    ).join(' · ');
    if (!note.textContent.includes('Phase 1')) {
      note.insertAdjacentHTML('beforeend',
        `<br><span style="color:var(--accent2);font-size:10px">⚡ Smart Plan phases: ${phaseList}</span>`);
    }
  }
}

// ── Rationale text ────────────────────────────────────────────────────────────
function buildRationaleText(species, lakeName, season, phases, phaseRecs, phaseInfo, totalRoutes) {
  const lines = [];
  lines.push(`${species} — ${lakeName}, ${season}`);
  lines.push(`Sunrise: ${phaseInfo.phases[0].startStr} → Phase boundaries computed from sunrise + solunar`);
  if (totalRoutes > 0) lines.push(`Routes: ${totalRoutes} auto-generated and committed to plan`);
  else lines.push(`Routes: No contour data loaded — open Contour Data tab first`);

  const sol = phaseInfo.solunar;
  function hToStr(h) {
    const hh = Math.floor(((h % 24) + 24) % 24);
    const mm = Math.round((h % 1) * 60);
    return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
  }
  lines.push(`Solunar majors: ${hToStr(sol.major1)} & ${hToStr(sol.major2)} | minors: ${hToStr(sol.minor1)} & ${hToStr(sol.minor2)}`);
  lines.push('');

  phases.forEach((phase, i) => {
    const rec = phaseRecs[i];
    lines.push(`Phase ${phase.num} — ${phase.name} (${phase.startStr} – ${phase.endStr})`);
    if (rec) {
      lines.push(`  Rods ${phase.num * 2 - 1} & ${phase.num * 2} · Depth: ${rec.depthMin}-${rec.depthMax}ft · Speed: ${rec.speed}mph`);
      lines.push(`  Lures: ${rec.lures.slice(0, 3).join(', ')}`);
      if (rec.notes) lines.push(`  Notes: ${rec.notes}`);
      const routeCfg = getRouteConfigForPhase(rec, phase.num);
      if (routeCfg) {
        lines.push(`  Route: ${routeCfg.pattern} · amplitude ${routeCfg.amplitude}ft · spacing ${routeCfg.spacing}ft · ${routeCfg.lanes} lane(s)`);
        lines.push(`  Why: ${routeCfg.rationale}`);
      }
    } else {
      lines.push(`  No data for this phase`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

// ── Ramp rationale text ──────────────────────────────────────────────────────
function buildRampRationaleText(eval_) {
  if (!eval_) return '';
  const lines = ['', '── Ramp Evaluation ──'];

  if (eval_.shouldSwitch) {
    lines.push(`⚠ RAMP RECOMMENDATION: Consider switching to ${eval_.best.name}`);
    lines.push(`  Your selected ramp scores ${eval_.currentScore}/100 vs ${eval_.best.name} at ${eval_.bestScore}/100 (+${eval_.switchDelta} points)`);
    lines.push(`  Reasons to switch:`);
    const current = eval_.current;
    if (current) {
      const currentEntry = eval_.ranked.find(r => r.ramp.key === current.key);
      (currentEntry?.reasons || []).forEach(r => lines.push(`    • ${r}`));
    }
    lines.push(`  Why ${eval_.best.name} is better:`);
    const bestEntry = eval_.ranked[0];
    (bestEntry?.positives || []).forEach(r => lines.push(`    + ${r}`));
    lines.push(`  ${eval_.best.notes}`);
  } else if (eval_.current) {
    lines.push(`✓ ${eval_.current.name} is a good choice for these conditions (score: ${eval_.currentScore}/100)`);
    const currentEntry = eval_.ranked.find(r => r.ramp.key === eval_.current.key);
    (currentEntry?.positives || []).forEach(r => lines.push(`  + ${r}`));
    if (currentEntry?.reasons?.length) {
      lines.push(`  Minor considerations:`);
      (currentEntry.reasons || []).forEach(r => lines.push(`    • ${r}`));
    }
  } else {
    lines.push(`Best ramp for these conditions: ${eval_.best?.name || 'unknown'}`);
  }

  return lines.join('\n');
}

// ── Read DOM inputs ───────────────────────────────────────────────────────────
function readPlanInputs() {
  const lakeName    = document.getElementById('planLake')?.value || '';
  const dateStr     = document.getElementById('planDate')?.value || new Date().toISOString().slice(0, 10);
  const launchTime  = document.getElementById('planLaunchTime')?.value || '6:00 AM';
  const returnTime  = document.getElementById('planReturnTime')?.value || '12:00 PM';
  const waterTempStr= document.getElementById('planWaterTemp')?.value || '';
  const waterTempF  = waterTempStr ? parseFloat(waterTempStr) : null;
  const speedStr    = document.getElementById('planSpeed')?.value || '';
  const speedMph    = speedStr ? parseFloat(speedStr) : 2.0;
  const species     = [...document.querySelectorAll('#planSpeciesChecks input:checked')].map(c => c.value);
  return { lakeName, dateStr, launchTime, returnTime, waterTempF, speedMph, species };
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function runSmartPlan() {
  const { lakeName, dateStr, launchTime, returnTime, waterTempF, speedMph, species } = readPlanInputs();
  const outEl    = document.getElementById('planSmartPlanOutput');
  const statusEl = document.getElementById('smartPlanStatus');

  function setStatus(msg, ok) {
    if (statusEl) { statusEl.textContent = msg; statusEl.style.color = ok ? 'var(--accent2)' : 'var(--warn)'; }
  }

  if (!lakeName) { setStatus('Select a lake first', false); return; }
  if (!species.length) { setStatus('Check at least one target species', false); return; }

  // Regulation check
  const date = new Date(dateStr + 'T12:00:00');
  const sp = species[0];
  const regCheck = checkRegulations(lakeName, sp, date);
  if (!regCheck.legal) {
    setStatus(`⚠ ${sp} not legal: ${regCheck.reason?.slice(0, 60)}`, false);
    if (outEl) outEl.value = `REGULATION BLOCK:\n${regCheck.reason}`;
    return;
  }

  const season = getSeason(date);

  // Compute phase timing
  const phaseInfo = computePhases(launchTime, returnTime, dateStr, lakeName);
  const { phases } = phaseInfo;

  // Compute range
  const rangeMiles = computeRangeMiles(speedMph);

  // Get per-phase behavior recommendations
  const phaseRecs = phases.map(p => getPhaseRecommendation(sp, lakeName, season, p.num, waterTempF));

  if (phaseRecs.every(r => !r)) {
    setStatus('No behavior data for this lake/species yet', false);
    if (outEl) outEl.value = `No behavior data available for ${sp} on ${lakeName}. Add entries to species-intel.js.`;
    return;
  }

  // Build 6-rod spread (2 rods × 3 phases)
  const sides = ['Port', 'Starboard'];
  const newSpread = [];
  phases.forEach((phase, i) => {
    const rods = buildPhaseRods(phaseRecs[i], phase.num, sides);
    rods.forEach(r => {
      // Tag each rod with its phase number for the plan UI
      r.notes = `[Ph${phase.num}: ${phase.startStr}-${phase.endStr}] ` + (r.notes || '');
      newSpread.push(r);
    });
  });
  state.SPREAD = newSpread;
  renderSpread();

  // Get ramp coordinates for route orientation
  let rampLat = null, rampLon = null;
  try {
    const { WATEREE_RAMPS, MARION_RAMPS, MOULTRIE_RAMPS, MURRAY_RAMPS, MONTICELLO_RAMPS } = await import('../data/ryan-ramps.js');
    const lakeRampMap = {
      'lake wateree': WATEREE_RAMPS, 'wateree': WATEREE_RAMPS,
      'lake marion': MARION_RAMPS, 'marion': MARION_RAMPS,
      'lake moultrie': MOULTRIE_RAMPS, 'moultrie': MOULTRIE_RAMPS,
      'lake murray': MURRAY_RAMPS, 'murray': MURRAY_RAMPS,
      'lake monticello': MONTICELLO_RAMPS, 'monticello': MONTICELLO_RAMPS,
    };
    const rampList = lakeRampMap[lakeName.toLowerCase()] || [];
    const selectedRampKey = document.getElementById('planRamp')?.value || '';
    const selectedRamp = rampList.find(r => r.key === selectedRampKey) || rampList[0];
    if (selectedRamp) {
      rampLat = selectedRamp.lat;
      rampLon = selectedRamp.lon;
      console.log(`[smart-plan] Using ramp: ${selectedRamp.name} (${rampLat}, ${rampLon})`);
    }
  } catch (e) {
    console.warn('[smart-plan] Could not load ramp coords:', e.message);
  }

  // Generate routes for each phase oriented toward selected ramp
  window._smartPlanPhaseRoutes = [];
  for (let i = 0; i < phases.length; i++) {
    await generateRouteForPhase(phases[i], phaseRecs[i], lakeName, rampLat, rampLon);
  }
  applyToPlanFields(phaseRecs, phases);
  applyStoredSmartPlanDepth();

  // Build rationale
  const totalRoutes = routeCounts.flat().length;
  let rationale = buildRationaleText(sp, lakeName, season, phases, phaseRecs, phaseInfo, totalRoutes);

  // Ramp evaluation — check if selected ramp is optimal
  const weatherStr = document.getElementById('planWeather')?.value || '';
  // Rough weather = wind > 15mph or plan is marked CAUTION/NO-GO
  const windMatch = weatherStr.match(/(\d+)\s*mph/i);
  const windMph = windMatch ? parseInt(windMatch[1]) : 0;
  const roughWeather = windMph > 15;
  const rampEval = await getRampEvaluation(lakeName, sp, season, phaseRecs, weatherStr, roughWeather);

  if (rampEval) {
    rationale += buildRampRationaleText(rampEval);
  }

  if (outEl) outEl.value = rationale;

  const firstRec = phaseRecs.find(Boolean);
  setStatus(
    `✓ 3-phase plan: ${phases.map((p, i) => phaseRecs[i] ? `Ph${p.num} ${phaseRecs[i].depthMin}-${phaseRecs[i].depthMax}ft` : '').filter(Boolean).join(' → ')} | Range: ${rangeMiles.toFixed(1)}mi`,
    true
  );
  return { phases, phaseRecs, phaseInfo, rangeMiles, rampEval };
}

// Wire the button
setTimeout(() => {
  document.getElementById('runSmartPlanBtn')?.addEventListener('click', runSmartPlan);
}, 800);

window.runSmartPlan = runSmartPlan;
window.applyStoredSmartPlanDepth = applyStoredSmartPlanDepth;

console.log('[smart-plan] module ready');

// ── Ramp evaluation integration ───────────────────────────────────────────────
// Imported lazily so wateree-ramps.js only loads when needed
async function getRampEvaluation(lakeName, species, season, phaseRecs, weatherStr, roughWeather) {
  const { evaluateRamps, parseWindDeg } = await import('../data/ryan-ramps.js');

  // Determine target zones from phase recommendations
  const targetZones = [];
  phaseRecs.forEach((rec, i) => {
    if (!rec) return;
    if (rec.depthMin < 18) targetZones.push('shallow_flats', 'clearwater_cove');
    if (rec.depthMin >= 18 && rec.depthMin < 26) targetZones.push('channel_ledges', 'mid_channel');
    if (rec.depthMin >= 26) targetZones.push('channel_ledges', 'mid_channel');
  });
  // Remove duplicates
  const uniqueZones = [...new Set(targetZones)];

  const windDeg = parseWindDeg(weatherStr);
  const speedMph = parseFloat(document.getElementById('planSpeed')?.value) || 2.0;
  const rangeMiles = computeRangeMiles(speedMph);

  // Get current ramp from plan form
  const rampEl = document.getElementById('planRamp');
  const currentRampKey = rampEl?.value || '';

  return evaluateRamps({
    lakeName,
    currentRampKey,
    targetZones: uniqueZones,
    windDeg,
    rangeMiles,
    roughWeather,
  });
}
