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
import { renderAll } from '../core/map-init.js';
import { esc } from '../utils/escape.js';
import { newRodRow } from '../utils/rod-row.js';
import { renderSpread, autoCalculateLead, LURE_DIVE_DEPTHS } from './spread-builder.js';
import { onContourChange } from './contour-data.js';
import { selectBestLure, getRecommendedSpeed } from '../data/tackle-inventory.js';
import { getLureColor } from '../data/lure-knowledge.js';
import { getPhaseDepth, getStrategySpeed, normalizeSpecies, getPresentationPriority, getPhaseNotes } from '../data/species-strategies.js';
import { buildFishingContext, buildGroqCoachPayload } from './smart-plan-context.js';
import { startCoachSession } from './groq-coach.js';
import {
  SPECIES_BEHAVIOR, REGULATIONS,
  getSeason, getTimeOfDay, checkRegulations, resolveLakeKey,
} from '../data/species-intel.js';
import { LAKE_DB } from '../data/lakes.js';
// v2 multi-species brain — if present, use it; fall back to v1 for legacy lakes
import * as IntelV2 from '../data/species-intel-v2.js';
import { isLiveBaitAvailable } from '../data/fishing-style-profile.js';

// ── Constants ────────────────────────────────────────────────────────────────
const MAX_RODS_PER_PHASE = 2;       // kayak: 2 rods in water at a time
const TOTAL_RODS = 6;               // 6 rod rows in spread (2 per depth tier × 3 tiers)
const SUB_PHASES_PER_TIER = 2;      // split each depth tier into 2 sub-phases to avoid route doubling
const BATTERY_AH_DEFAULT = 100;     // LiFePO4 100Ah
const MOTOR_AMP_AVG = 6;            // NK180 Pro avg draw at ~2mph trolling
const PHASE_1_END_OFFSET_MIN = 60;  // minutes after sunrise Phase 1 ends (default)
const PHASE_2_END_OFFSET_MIN = 210; // minutes after sunrise Phase 2 ends (3.5hrs)

// ── Lure presets (must exactly match spread-builder.js LURE_PRESETS) ─────────
// FIX (2026-07-03): generalized to broad categories (matching the
// COLOR_PRESETS group headers in spread-builder.js: Natural, Bright, Dark,
// Metallic) instead of ultra-specific named patterns like "Blueback
// Herring" or "Sexy Shad". This app doesn't know exactly which specific
// colorway of a lure the angler owns — a general steer ("Natural" vs
// "Bright") is honest about that; a hyper-specific name implies a
// precision the recommendation doesn't actually have.
const LURE_COLOR_DEFAULTS = {
  'Choppo 90 – Topwater':                    'Natural',
  'Zara Spook – Topwater':                   'Natural',
  'Whopper Plopper 110 – Topwater':          'Natural',
  'Buzzbait 1/2oz – Topwater':                'Bright',
  'Popping Cork':                             'Natural',
  'Bucktail Jig 1oz':                        'Bright',
  'Marabou Jig 3/4oz':                       'Bright',
  'A-Rig Light (~1.65oz) – 3.8" Swimbait':  'Natural',
  'A-Rig Medium (~2.65oz) – 4.6" Swimbait': 'Natural',
  'A-Rig Heavy (~3.5oz) – 5" Swimbait':     'Natural',
  'Deep Hit Stick – Crankbait':              'Natural',
  'Flicker Minnow 11 – Crankbait':          'Natural',
  'Bandit 300 Series – Crankbait':           'Bright',
  'Rapala DT-10 – Crankbait (shallow/medium, ~10ft)': 'Natural',
  'Rapala DT-14 – Crankbait (medium/deep, ~14ft)':    'Natural',
  'Lipless Crankbait 1/2oz':                 'Bright',
  'Spinnerbait 1/2oz':                       'Bright',
  'Swimbait 3.8" – Jighead':                'Natural',
  'Swimbait 4.6" – Jighead':                'Natural',
  'Swimbait 5" – Jighead':                  'Natural',
  'Flutter Spoon 2oz':                       'Metallic',
  'Flutter Spoon 3oz':                       'Metallic',
  'Kastmaster 3/4oz':                        'Metallic',
  'ChatterBait 3/4oz':                       'Bright',
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
  // Added 2026-07-03: matches the gear the angler actually owns/fishes.
  'Spinnerbait':            'Spinnerbait 1/2oz',
  'Lipless crankbait':      'Lipless Crankbait 1/2oz',
  'Lipless Crankbait':      'Lipless Crankbait 1/2oz',
  'ChatterBait':            'ChatterBait 3/4oz',
  'Buzzbait':               'Buzzbait 1/2oz – Topwater',
  'Shallow crankbait':      'Rapala DT-10 – Crankbait (shallow/medium, ~10ft)',
  'Medium crankbait':       'Rapala DT-14 – Crankbait (medium/deep, ~14ft)',
  'Swimbait on jighead':    'Swimbait 4.6" – Jighead',
  // v2 species-intel-v2.js presentation keys
  'medium_diving_crankbait': 'Rapala DT-14 – Crankbait (medium/deep, ~14ft)',
  'deep_diving_crankbait':   'Deep Hit Stick – Crankbait',
  'spinnerbait':             'Spinnerbait 1/2oz',
  'chatterbait':             'ChatterBait 3/4oz',
  'paddle_tail':             'Swimbait 4.6" – Jighead',
  'swim_jig':                'Swimbait 4.6" – Jighead',
  'lipless_crankbait':       'Lipless Crankbait 1/2oz',
  'road_runner':             'Marabou Jig 3/4oz',
  'hair_jig':                'Marabou Jig 3/4oz',
  'inline_spinner':          'Spinnerbait 1/2oz',
  'gold_spoon':              'Kastmaster 3/4oz',
  'topwater_walker':         'Zara Spook – Topwater',
  'topwater_frog_casting':   'Buzzbait 1/2oz – Topwater',
  'squarebill':              'Rapala DT-10 – Crankbait (shallow/medium, ~10ft)',
  'flutter_spoon':           'Flutter Spoon 2oz',
  'bucktail':                'Bucktail Jig 1oz',
  'umbrella_rig':            'A-Rig Medium (~2.65oz) – 4.6" Swimbait',
  'umbrella_rig_medium':     'A-Rig Medium (~2.65oz) – 4.6" Swimbait',
  'umbrella_rig_light':      'A-Rig Light (~1.65oz) – 3.8" Swimbait',
  'umbrella_rig_heavy':      'A-Rig Heavy (~3.5oz) – 5" Swimbait',
  'swimbait_jighead':        'Swimbait 4.6" – Jighead',
  'jigging_spoon':           'Flutter Spoon 2oz',
  'jigging_spoon_vertical':  'Flutter Spoon 2oz',
  'bucktail_slow':           'Bucktail Jig 1oz',
  'bucktail_jig':            'Bucktail Jig 1oz',
  'medium_crankbait':        'Flicker Minnow 11 – Crankbait',
  'deep_crankbait':          'Deep Hit Stick – Crankbait',
  'spinnerbait_slow':        'Spinnerbait 1/2oz',
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

// ── Technique classification: trolled vs. static/casting ─────────────────────
// A trolling sweep route only makes sense for lures actually presented while
// the boat is moving along a controlled path (crankbaits, A-Rigs, flutter
// spoons on a set lead length). Topwater and free-lined/downlined live bait
// are cast or drifted/anchored at a spot — dragging a "trolling lane" for
// those techniques produces a route the angler was never going to run.
function isStaticTechnique(rawLureName) {
  if (!rawLureName) return false;
  const s = rawLureName.toLowerCase();
  // Cast/surface presentations
  if (s.includes('topwater') || s.includes('buzz') || s.includes('plopper') || s.includes('spook')) return true;
  // Live/cut bait — not trolled from this kayak setup
  if (s.includes('free-line') || s.includes('freeline') || s.includes('free line')) return true;
  if (s.includes('downline') || s.includes('down-line') || s.includes('down line')) return true;
  if (s.includes('live') && !s.includes('lead-core')) return true;
  if (s.includes('cut bait') || s.includes('cut_bait')) return true;
  // v2 key names — anchor/finesse techniques with no useful trolling route
  if (s.includes('anchor')) return true;
  if (s.includes('finesse')) return true;
  if (s.includes('wacky') || s.includes('drop_shot') || s.includes('ned_rig') || s.includes('jig_n_pig')) return true;
  if (s.includes('texas_rig') || s.includes('carolina_rig')) return true;
  if (s.includes('live_bluegill') || s.includes('live_bream') || s.includes('live_shad')) return true;
  const resolved = resolveLure(rawLureName);
  if (resolved && resolved.toLowerCase().includes('topwater')) return true;
  return false;
}

// A phase counts as "static" for route-generation purposes if its PRIMARY
// (first-listed) recommended lure is a static technique — that's the one
// species-intel.js entries treat as the lead presentation for the phase.
function isStaticPhase(phaseRec) {
  const lures = getEffectiveLures(phaseRec);
  if (!lures.length) return false;
  return isStaticTechnique(lures[0]);
}

// FIX (2026-07-03): species-intel.js entries frequently list freshwater
// live-bait presentations (herring, shad, menhaden) as the recommended
// technique — but this angler has no livewell, freshwater live bait is
// fragile even with a portable aerated tank, and cast-netting for it near
// where it's needed isn't a safe kayak operation. Filters those out per
// the confirmed profile in fishing-style-profile.js, falling back to the
// next listed option, or a generic trolled default if every option in the
// phase was unavailable live bait. Both buildPhaseRods (lure selection)
// and isStaticPhase (route generation) use this SAME filtered list so a
// substituted lure doesn't create inconsistency between what shows in the
// spread and whether a trolling route gets generated for it.
function getEffectiveLures(phaseRec) {
  if (!phaseRec?.lures?.length) return [];
  const available = phaseRec.lures.filter(l => isLiveBaitAvailable(l));
  if (available.length) return available;
  // Every listed option was unavailable live bait (fully-freshwater-livebait
  // phase entry) — fall back to a sensible generic trolled default instead
  // of leaving the phase with nothing at all.
  return ['A-Rig Medium'];
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

// ── Smart Plan route audit helpers ────────────────────────────────────────────
function geoDistanceFt(lat1, lon1, lat2, lon2) {
  const R = 20902231, D = Math.PI / 180;
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const p1 = lat1 * D, p2 = lat2 * D, dp = (lat2 - lat1) * D, dl = (lon2 - lon1) * D;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function geoBearingDeg(lat1, lon1, lat2, lon2) {
  const D = Math.PI / 180, R2D = 180 / Math.PI;
  const p1 = lat1 * D, p2 = lat2 * D, dl = (lon2 - lon1) * D;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

function geoDestinationFt(lat, lon, bearingDeg, distFt) {
  const R = 20902231, D = Math.PI / 180, R2D = 180 / Math.PI;
  const br = bearingDeg * D, lr = lat * D, d = distFt / R;
  const lat2 = Math.asin(Math.sin(lr) * Math.cos(d) + Math.cos(lr) * Math.sin(d) * Math.cos(br));
  const lon2 = lon * D + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lr), Math.cos(d) - Math.sin(lr) * Math.sin(lat2));
  return [lat2 * R2D, lon2 * R2D];
}

function buildSmartPlanConnectorTrack(name, fromLat, fromLon, toLat, toLon, role = 'connector') {
  const distFt = geoDistanceFt(fromLat, fromLon, toLat, toLon);
  if (!Number.isFinite(distFt) || distFt <= 25) return null;
  const brng = geoBearingDeg(fromLat, fromLon, toLat, toLon);
  const stepFt = 250;
  const n = Math.max(1, Math.ceil(distFt / stepFt));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(geoDestinationFt(fromLat, fromLon, brng, distFt * i / n));
  pts[0] = [fromLat, fromLon];
  pts[pts.length - 1] = [toLat, toLon];
  return { name, pts, role, connector: true, smartPlan: true, lengthFt: distFt };
}

function appendConnectorThenTracks(out, fromLat, fromLon, tracks, labelFrom, labelTo) {
  if (!tracks?.length) return { lat: fromLat, lon: fromLon };
  const first = tracks[0]?.pts?.[0];
  if (!first) return { lat: fromLat, lon: fromLon };
  const d = geoDistanceFt(fromLat, fromLon, first[0], first[1]);
  if (Number.isFinite(d) && d <= 25) {
    tracks[0].pts[0] = [fromLat, fromLon];
  } else {
    const c = buildSmartPlanConnectorTrack(`Connector: ${labelFrom} → ${labelTo}`, fromLat, fromLon, first[0], first[1], 'phase_connector');
    if (c) out.push(c);
  }
  out.push(...tracks);
  const lastTrack = [...tracks].reverse().find(t => t?.pts?.length >= 2);
  const last = lastTrack?.pts?.[lastTrack.pts.length - 1];
  return last ? { lat: last[0], lon: last[1] } : { lat: fromLat, lon: fromLon };
}

function buildRetraceReturnTrack(existingTracks, rampLat, rampLon, name = 'Retrace return to launch') {
  // Last-resort safety: if a direct return line would cut across land, retrace
  // already-generated water route points back to the point nearest the ramp.
  const flat = [];
  for (const t of existingTracks || []) {
    for (const p of (t.pts || [])) {
      const last = flat[flat.length - 1];
      if (!last || geoDistanceFt(last[0], last[1], p[0], p[1]) > 3) flat.push(p);
    }
  }
  if (flat.length < 2) return null;
  let bestIdx = 0, bestFt = Infinity;
  for (let i = 0; i < flat.length; i++) {
    const d = geoDistanceFt(rampLat, rampLon, flat[i][0], flat[i][1]);
    if (d < bestFt) { bestFt = d; bestIdx = i; }
  }
  const pts = flat.slice(bestIdx).reverse();
  const last = pts[pts.length - 1];
  if (geoDistanceFt(last[0], last[1], rampLat, rampLon) > 25) pts.push([rampLat, rampLon]);
  else pts[pts.length - 1] = [rampLat, rampLon];
  return { name, pts, role: 'return_retrace', connector: true, smartPlan: true, lengthFt: trackLengthFtFromPts(pts) };
}

function trackLengthFtFromPts(pts) {
  if (!pts?.length) return 0;
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += geoDistanceFt(pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1]);
  return total;
}

function planDurationHours(launchTimeStr, returnTimeStr) {
  const parse = s => {
    const m = String(s || '').match(/(\d+):(\d+)\s*(AM|PM)?/i);
    if (!m) return null;
    let h = parseInt(m[1]), min = parseInt(m[2]);
    if (m[3]?.toUpperCase() === 'PM' && h < 12) h += 12;
    if (m[3]?.toUpperCase() === 'AM' && h === 12) h = 0;
    return h + min / 60;
  };
  const s = parse(launchTimeStr), e0 = parse(returnTimeStr);
  if (s == null || e0 == null) return null;
  let e = e0;
  if (e < s) e += 24;
  return Math.max(0, e - s);
}

function isSmartPlanTrack(t) {
  const name = String(t?.name || '');
  return !!(t?.smartPlan || name.startsWith('Phase ') || name.startsWith('Connector:'));
}

function clearExistingSmartPlanTracks() {
  if (!state.DATA?.tracks?.length) return 0;
  const before = state.DATA.tracks.length;
  state.DATA.tracks = state.DATA.tracks.filter(t => !isSmartPlanTrack(t));
  return before - state.DATA.tracks.length;
}

function upsertSmartPlanRampWaypoint(rampName, lat, lon) {
  if (![lat, lon].every(Number.isFinite)) return;
  if (!state.DATA) state.DATA = {};
  if (!Array.isArray(state.DATA.waypoints)) state.DATA.waypoints = [];
  const name = rampName || 'Launch Ramp';
  const existing = state.DATA.waypoints.find(w => w?.role === 'launch_ramp' || w?.name === name);
  const payload = { name, lat, lon, role: 'launch_ramp', smartPlan: true };
  if (existing) Object.assign(existing, payload);
  else state.DATA.waypoints.push(payload);
  state.DATA.rampCoords = { name, lat, lon, source: 'smart_plan_locked', locked: true };
  window._smartPlanRamp = state.DATA.rampCoords;
}

function auditSmartPlanRoute(tracks, rampLat, rampLon, launchTime, returnTime, speedMph) {
  const out = { ok: true, flags: [], trackCount: tracks?.length || 0 };
  const list = (tracks || []).filter(t => t?.pts?.length >= 2);
  if (!list.length) {
    out.ok = false; out.flags.push('No route tracks were generated.');
    return out;
  }
  const first = list[0].pts[0];
  const lastTrack = list[list.length - 1];
  const last = lastTrack.pts[lastTrack.pts.length - 1];
  out.startFt = geoDistanceFt(rampLat, rampLon, first[0], first[1]);
  out.endFt = geoDistanceFt(rampLat, rampLon, last[0], last[1]);
  out.totalFt = list.reduce((sum, t) => sum + trackLengthFtFromPts(t.pts), 0);
  out.connectorFt = list.filter(t => t.connector || String(t.role || '').includes('connector')).reduce((sum, t) => sum + trackLengthFtFromPts(t.pts), 0);
  out.fishingFt = out.totalFt - out.connectorFt;
  out.maxGapFt = 0;
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1].pts[list[i - 1].pts.length - 1];
    const cur = list[i].pts[0];
    out.maxGapFt = Math.max(out.maxGapFt, geoDistanceFt(prev[0], prev[1], cur[0], cur[1]));
  }
  const durH = planDurationHours(launchTime, returnTime);
  out.durationH = durH;
  out.speedMph = speedMph || 2.0;
  out.budgetFt = durH ? durH * out.speedMph * 5280 : null;
  out.estimatedH = out.totalFt / 5280 / out.speedMph;

  if (out.startFt > 35) { out.ok = false; out.flags.push(`First GPX point is ${Math.round(out.startFt)}ft from the locked ramp.`); }
  if (out.endFt > 35) { out.ok = false; out.flags.push(`Final GPX point is ${Math.round(out.endFt)}ft from the locked ramp.`); }
  if (out.maxGapFt > 75) { out.ok = false; out.flags.push(`Tracks have an unconnected gap of ${Math.round(out.maxGapFt)}ft.`); }
  if (out.budgetFt && out.totalFt > out.budgetFt * 1.05) {
    out.ok = false;
    out.flags.push(`Route is ${(out.totalFt / 5280).toFixed(1)}mi, but ${durH.toFixed(1)}hr at ${out.speedMph.toFixed(1)}mph supports about ${(out.budgetFt / 5280).toFixed(1)}mi.`);
  }
  return out;
}

function buildRouteAuditText(audit, rampName, rampLat, rampLon) {
  if (!audit) return '';
  const lines = ['', '── Route Audit ──'];
  lines.push(`Ramp locked: ${rampName || 'selected ramp'} (${Number(rampLat).toFixed(5)}, ${Number(rampLon).toFixed(5)})`);
  if (!audit.trackCount) {
    lines.push('✗ No route tracks generated.');
    return lines.join('\n');
  }
  lines.push(`${audit.ok ? '✓' : '⚠'} Starts at ramp: ${Math.round(audit.startFt || 0)}ft from locked coordinate`);
  lines.push(`${audit.ok ? '✓' : '⚠'} Returns to ramp: ${Math.round(audit.endFt || 0)}ft from locked coordinate`);
  lines.push(`${audit.maxGapFt <= 75 ? '✓' : '⚠'} Phase/track continuity max gap: ${Math.round(audit.maxGapFt || 0)}ft`);
  lines.push(`Total route: ${(audit.totalFt / 5280).toFixed(2)}mi · fishing ${(audit.fishingFt / 5280).toFixed(2)}mi · connectors ${(audit.connectorFt / 5280).toFixed(2)}mi`);
  if (audit.durationH) lines.push(`Estimated moving time: ${audit.estimatedH.toFixed(1)}hr at ${audit.speedMph.toFixed(1)}mph · plan window ${audit.durationH.toFixed(1)}hr`);
  if (audit.flags?.length) {
    lines.push('Route flags:');
    audit.flags.forEach(f => lines.push(`  • ${f}`));
  }
  return lines.join('\n');
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
      { num: 1, tier: 1, name: 'Dawn',       start: launchH, end: p1End,   startStr: hToStr(launchH), endStr: hToStr(p1End) },
      { num: 2, tier: 2, name: 'Transition', start: p1End,   end: p2End,   startStr: hToStr(p1End),   endStr: hToStr(p2End) },
      { num: 3, tier: 3, name: 'Deep',       start: p2End,   end: returnH, startStr: hToStr(p2End),   endStr: hToStr(returnH) },
    ],
  };
}

// ── Per-phase behavior lookup ─────────────────────────────────────────────────
function getPhaseRecommendation(species, lakeName, season, phaseNum, waterTempF) {
  // Try v2 multi-species brain first
  const v2sp = IntelV2?.SPECIES_BEHAVIOR_V2?.[species];
  if (v2sp) {
    const lakeKeyV2 = (IntelV2.resolveLakeKey
      ? (IntelV2.resolveLakeKey(lakeName, v2sp) || 'default_SC_reservoir')
      : (v2sp[lakeName] ? lakeName : 'default_SC_reservoir'));
    const lakeNode = v2sp[lakeKeyV2] || v2sp['default_SC_reservoir'] || v2sp['Coastal SC Inshore'];
    const sNode = lakeNode?.[season];
    if (sNode) {
      let [dMin, dMax] = typeof sNode.preferredDepth === 'function'
        ? sNode.preferredDepth(waterTempF)
        : (sNode.preferredDepth || [5, 15]);

      // Phase-aware depth from species-strategies (authoritative)
      try {
        const sd = getPhaseDepth(species, season, phaseNum);
        if (sd) [dMin, dMax] = sd;
      } catch (_) {
        // Fallback band split
        const spread = dMax - dMin;
        if (phaseNum === 1)      { dMax = Math.round(dMin + spread * 0.45); }
        else if (phaseNum === 2) { dMin = Math.round(dMin + spread * 0.25); dMax = Math.round(dMin + spread * 0.5); }
        else                     { dMin = Math.round(dMin + spread * 0.55); }
      }

      let speed = Array.isArray(sNode.preferredSpeed) ? sNode.preferredSpeed[0] : (sNode.preferredSpeed || 1.8);
      try { const ss = getStrategySpeed(species, season); if (ss?.ideal) speed = ss.ideal; } catch (_) {}

      return {
        depthMin: Math.round(dMin), depthMax: Math.round(dMax),
        lures: sNode.preferredPresentation || [],
        speed,
        // Use phase-specific note if available (species-strategies.js phaseNotes),
        // otherwise fall back to the flat season notes array.
        notes: (() => {
          try {
            const pn = getPhaseNotes(species, season, phaseNum);
            if (pn) return pn;
          } catch (_) {}
          return Array.isArray(sNode.notes) ? sNode.notes.join(' · ') : (sNode.notes || '');
        })(),
        _v2meta: {
          structure: sNode.preferredStructure,
          lureFamilies: sNode.lureFamilies,
          colors: sNode.preferredColors,
          lead: sNode.leadDistance,
          rod: sNode.rodArchitecture,
          forage: sNode.forage,
          reactionStrike: sNode.reactionStrike,
          confidence: sNode.confidence,
          fallback: sNode.fallbackPresentation,
        },
      };
    }
  }

  // Fallback → v1 species-intel.js
  const lakeKey = resolveLakeKey(lakeName, SPECIES_BEHAVIOR);
  const seasonData = SPECIES_BEHAVIOR[lakeKey]?.[species]?.[season];
  if (!seasonData) return null;

  const todKeys = { 1: 'dawn', 2: 'day', 3: 'day' };
  const tod = seasonData.timeOfDay[todKeys[phaseNum]] || seasonData.timeOfDay['day'];
  if (!tod) return null;

  let [dMin, dMax] = typeof seasonData.depthBand === 'function'
    ? seasonData.depthBand(waterTempF) : [...seasonData.depthBand];

  try { const sd = getPhaseDepth(species, season, phaseNum); if (sd) [dMin, dMax] = sd; } catch (_) {}

  return {
    depthMin: Math.round(dMin), depthMax: Math.round(dMax),
    lures: tod.lures || [],
    speed: tod.speed || 2.0,
    notes: tod.notes || '',
  };
}

// ── Tactical Lure Matcher ──────────────────────────────────────────────────
function getTacticallyAlignedLure(targetDepth, preferredLures, slotIndex = 0) {
  const depth = parseFloat(targetDepth);
  if (isNaN(depth)) return null;

  // Build list of all valid lures for this depth from the preferred list
  const validMatches = [];
  for (const rawLure of preferredLures) {
    const resolved = resolveLure(rawLure);
    if (!resolved) continue;
    const dive = LURE_DIVE_DEPTHS[resolved];
    if (dive && depth >= dive.minDive && depth <= dive.maxDive) {
      if (!validMatches.includes(resolved)) validMatches.push(resolved);
    }
  }

  // slotIndex 0 = port (first valid lure), slotIndex 1 = starboard (second distinct lure)
  if (validMatches.length > slotIndex) return validMatches[slotIndex];
  if (validMatches.length > 0) return validMatches[0];

  // Tactical fallback by depth band
  if (depth < 5) {
    const shallows = ['Choppo 90 – Topwater', 'Zara Spook – Topwater', 'Whopper Plopper 110 – Topwater', 'ChatterBait 3/4oz'];
    return shallows[Math.floor(Math.random() * shallows.length)];
  } else if (depth < 12) {
    const midShallows = ['Rapala DT-10 – Crankbait', 'Flicker Minnow 11 – Crankbait', 'Bucktail Jig 1oz', 'Marabou Jig 3/4oz', 'Kastmaster 3/4oz'];
    return midShallows[Math.floor(Math.random() * midShallows.length)];
  } else if (depth < 20) {
    const midDepths = ['A-Rig Medium (~2.65oz) – 4.6" Swimbait', 'Rapala DT-14 – Crankbait', 'Flutter Spoon 2oz', 'Swimbait 4.6" – Jighead'];
    return midDepths[Math.floor(Math.random() * midDepths.length)];
  } else {
    const deeps = ['Deep Hit Stick – Crankbait', 'A-Rig Heavy (~3.5oz) – 5" Swimbait', 'Flutter Spoon 3oz', 'Swimbait 5" – Jighead'];
    return deeps[Math.floor(Math.random() * deeps.length)];
  }
}

// ── Build 2 rods for a phase ──────────────────────────────────────────────────
async function buildPhaseRods(phaseRec, phaseNum, sides, fishingContext) {
  if (!phaseRec) return [newRodRow(), newRodRow()];

  const dMin    = phaseRec.depthMin || 10;
  const dMax    = phaseRec.depthMax || 18;
  const bandMid = (dMin + dMax) / 2;
  const rod1Depth = Math.round(((dMin + bandMid) / 2) * 2) / 2;
  const rod2Depth = Math.round(((bandMid + dMax) / 2) * 2) / 2;

  const clarity    = document.getElementById('planClarity')?.value || 'Clear';
  const clarityKey = clarity.toLowerCase().includes('mud') ? 'muddy'
    : clarity.toLowerCase().includes('stain') ? 'stained' : 'clear';
  const speedMph   = parseFloat(document.getElementById('planSpeed')?.value) || phaseRec.speed || 1.8;
  const speciesNorm = normalizeSpecies(fishingContext?.species || '');
  const season      = fishingContext?.season || 'summer';
  const structure   = fishingContext?.structureTypes || [];

  // Get presentation priority from species-strategies
  let preferredTypes = [];
  try {
    const timePhase = phaseNum === 1 ? 'dawn' : phaseNum === 3 ? 'deep' : 'morning';
    preferredTypes  = getPresentationPriority(speciesNorm, season, { timeOfDay: timePhase, clarityKey });
  } catch (_) {}

  const results = [];
  for (let i = 0; i < sides.length; i++) {
    const side        = sides[i];
    const targetDepth = i === 0 ? rod1Depth : rod2Depth;
    let selectedLure  = null;
    let scoreResult   = null;

    // Try inventory-based selection first
    try {
      const result = await selectBestLure({
        species: speciesNorm, season, clarity, clarityKey,
        targetDepthFt: targetDepth, depthMin: dMin, depthMax: dMax,
        speedMph, structure, preferredTypes, slotIndex: i,
      });
      selectedLure = result?.lure || null;
      scoreResult  = result?.scoreResult || null;
    } catch (_) {}

    // Fallback to old tactical matcher if inventory select fails
    if (!selectedLure) {
      const lures   = getEffectiveLures(phaseRec);
      const rawLure = getTacticallyAlignedLure(targetDepth, lures, i);
      if (rawLure) selectedLure = { name: rawLure, type: null };
    }

    const rod = newRodRow({
      side,
      position: 'Mid',
      rod: "7' M Mod-Fast Spinning (Ugly Stik Lite Pro)",
      reel: 'Spinning / 30lb 8-strand braid + 20lb fluoro leader',
      depth: String(targetDepth),
    });

    if (selectedLure) {
      rod.lure  = selectedLure.name || selectedLure;
      rod.color = getLureColor(selectedLure.type || selectedLure, clarityKey);
      rod.lead  = String(autoCalculateLead({ ...rod, lure: rod.lure }, speedMph));

      // Jighead for A-rigs and swimbaits
      if (selectedLure.jigWeights?.length) {
        try {
          const { getJigheadForDepth: getJighead } = await import('../data/lure-knowledge.js');
          const jigOz = getJighead(selectedLure.jigWeights, targetDepth, speedMph);
          if (jigOz) {
            rod.jigWeight   = `${jigOz}oz`;
            rod.arigWeight  = selectedLure.weightOz ? `~${selectedLure.weightOz}oz` : '';
            rod.trailerSize = selectedLure.sizes?.[0] || '';
          }
        } catch (_) {
          // Fallback A-rig labels from name string
          if (rod.lure?.includes('A-Rig')) {
            const isLight  = rod.lure.includes('Light')  || rod.lure.includes('1.65');
            const isMedium = rod.lure.includes('Medium') || rod.lure.includes('2.65');
            rod.arigWeight  = isLight ? '~1.65oz (5-wire light)' : isMedium ? '~2.65oz (5-wire medium)' : '~3.5oz (5-wire heavy)';
            rod.trailerSize = isLight ? '3.8" swimbait' : isMedium ? '4.6" swimbait' : '5" swimbait';
            rod.jigWeight   = isLight ? '1/8oz × 5' : isMedium ? '3/16oz × 5' : '1/4oz × 5';
          }
        }
      }
      rod._scoreResult = scoreResult;
    }

    if (phaseRec.notes) {
      const trimmed = phaseRec.notes.length > 220
        ? phaseRec.notes.slice(0, 220).replace(/\s+\S*$/, '') + '…'
        : phaseRec.notes;
      rod.notes = (rod.notes ? rod.notes + ' · ' : '') + trimmed;
    }

    if (scoreResult?.confidence) {
      const pct = Math.round(scoreResult.confidence * 100);
      rod.notes = (rod.notes ? rod.notes + ' · ' : '') + `Confidence: ${pct}%`;
      if (scoreResult.warnings?.length) rod.notes += ` ⚠ ${scoreResult.warnings[0]}`;
    }

    const v2 = phaseRec._v2meta;
    if (v2?.structure?.length) rod.notes = (rod.notes ? rod.notes + ' · ' : '') + 'Structure: ' + v2.structure.slice(0, 2).join(', ');
    if (v2?.lureFamilies?.length) rod.notes = (rod.notes ? rod.notes + ' · ' : '') + 'Families: ' + v2.lureFamilies.slice(0, 2).join(', ');

    results.push(rod);
  }
  return results;
}

// ── Route generation per phase ────────────────────────────────────────────────
async function generateRouteForPhase(phase, phaseRec, lakeName, rampLat, rampLon, rangeMiles, targetLengthFt = null, startLat = null, startLon = null, endLat = null, endLon = null, isReturnPass = false, lockedBearing = null) {
  if (!phaseRec) return [];

  window._smartPlanPhaseRoutes = window._smartPlanPhaseRoutes || [];
  window._smartPlanPhaseRoutes.push({
    phase: phase.num,
    phaseName: phase.name,
    depthMin: phaseRec.depthMin,
    depthMax: phaseRec.depthMax,
    speed: phaseRec.speed,
    window: `${phase.startStr} – ${phase.endStr}`,
  });

  if (isStaticPhase(phaseRec)) {
    const primaryLure = phaseRec.lures[0];
    console.log(`[smart-plan] Phase ${phase.num} ${phase.name}: primary technique "${primaryLure}" is static/casting, not trolled — skipping route generation.`);
    window._smartPlanPhaseRoutes[window._smartPlanPhaseRoutes.length - 1].staticTechnique = true;
    window._smartPlanPhaseRoutes[window._smartPlanPhaseRoutes.length - 1].technique = primaryLure;
    return [];
  }

  const minEl = document.getElementById('rbDepthMin');
  const maxEl = document.getElementById('rbDepthMax');
  if (minEl) minEl.value = phaseRec.depthMin;
  if (maxEl) maxEl.value = phaseRec.depthMax;

  try {
    const { generateAndCommitRoute, setClipFromRamp, setClipPolygon } = await import('./route-builder.js');

    const phaseTier = phase.tier ?? phase.num;
    if (phaseTier === 1) {
      // Phase 1 (Dawn): shallow dock-edge trolling near ramp.
      // Ryan's Ln1 stays within ~4mi of ramp — expand from old 1.5mi cap.
      setClipFromRamp(rampLat, rampLon, Math.min(rangeMiles, 4.0));

    } else if (phaseTier === 2) {
      // Phase 2 (Transition): Ryan's Ln2 sweeps out to ~3mi from Phase 1 end.
      // Clip centered on Phase 1 end with 3.5mi radius.
      const p1EndLat = startLat ?? rampLat;
      const p1EndLon = startLon ?? rampLon;
      setClipFromRamp(p1EndLat, p1EndLon, Math.min(rangeMiles, 3.5));

    } else {
      // Phase 3 (Deep): Ryan's Ln3 covers ~4.7mi from Phase 2 end back toward ramp.
      // Clip centered on Phase 2 end with enough radius to cover the return arc.
      const p2EndLat = startLat ?? rampLat;
      const p2EndLon = startLon ?? rampLon;
      const distToRampMi = Math.sqrt(
        ((p2EndLat - rampLat) * 69) ** 2 +
        ((p2EndLon - rampLon) * 69 * Math.cos(rampLat * Math.PI / 180)) ** 2
      );
      const clipRadiusMi = Math.min(rangeMiles, Math.max(3.0, distToRampMi + 0.5));
      setClipFromRamp(p2EndLat, p2EndLon, clipRadiusMi);
    }
    
    // TACTICAL PATTERN SELECTION:
    // Phase 1: Meandering / Exploring (Sine)
    // Phase 2: Direct Head-out / Ledge-hunting (Sine+Straight)
    // Phase 3: Return to Ramp (Sine+Straight)
    let pattern = 'sine+straight';
    let amplitude = 30;
    const pt = phase.tier ?? phase.num;
    if (pt === 1) {
      pattern = 'sine';
      amplitude = 40;
    } else if (pt === 2) {
      pattern = 'sine+straight';
      amplitude = 25;
    } else {
      pattern = 'sine+straight';
      amplitude = 30;
    }

    const rCfg = {
      pattern,
      amplitude,
      spacing: 150,
      lanes: 1,
      rationale: (phase.tier??phase.num) === 1 ? 'Meandering outbound explore' : ((phase.tier??phase.num) === 2 ? 'Direct ledge swing' : 'Return circuit to ramp'),
    };

    // Let the Route Builder make the fishing pass, then immediately pull those
    // tracks back out. Smart Plan assembles launch/phase/return connectors itself
    // so stale route-builder code or browser cache cannot drop the connectors.
    const beforeCount = state.DATA?.tracks?.length || 0;
    const returnedTracks = generateAndCommitRoute({
      ...rCfg,
      depthMin:       phaseRec.depthMin,
      depthMax:       phaseRec.depthMax,
      trackName:      `Phase ${phase.num} ${phase.name} (${phase.startStr}–${phase.endStr})`,
      rampLat:        rampLat ?? null,
      rampLon:        rampLon ?? null,
      startLat:       startLat ?? rampLat ?? null,
      startLon:       startLon ?? rampLon ?? null,
      endLat:         endLat ?? null,
      endLon:         endLon ?? null,
      targetLengthFt: targetLengthFt || null,
      isReturnPass:   isReturnPass,
      lockedBearing:  lockedBearing,
      smartPlan:      true,
      emitConnectors: false,
      singleBestTrack:true,
    });

    const addedTracks = state.DATA?.tracks?.slice(beforeCount) || [];
    if (state.DATA?.tracks) state.DATA.tracks.splice(beforeCount);

    const tracks = (addedTracks.length ? addedTracks : (returnedTracks || []))
      .filter(t => t?.pts?.length >= 2)
      .map(t => ({ ...t, smartPlan: true, role: 'fishing', connector: false }));

    if (tracks.length) {
      console.log(`[smart-plan] Phase ${phase.num} ${phase.name}: built ${tracks.length} fishing track(s) at ${phaseRec.depthMin}-${phaseRec.depthMax}ft`);
    }
    return tracks;
  } catch (e) {
    console.warn('[smart-plan] Route generation failed:', e.message);
    return [];
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

// ── Phase Trolling Pattern & Route Config Brain ───────────────────────────────
function getRouteConfigForPhase(rec, phaseNum) {
  if (!rec) return null;
  if (phaseNum === 1) {
    return {
      pattern: 'sine+straight',
      amplitude: 18,
      spacing: 180,
      lanes: 1,
      rationale: 'Sine+Straight pattern with 18ft amplitude glides parallel along the shallow ledge breakline and executes smooth S-curve turns across primary points. Keeps presentations in prime morning ambush zones without overshooting onto shallow flats.'
    };
  } else if (phaseNum === 2) {
    return {
      pattern: 'sine',
      amplitude: 28,
      spacing: 140,
      lanes: 1,
      rationale: 'Continuous Sine S-curve oscillation (28ft amplitude) weaves back and forth across the primary channel drop-off. Speed changes on turns accelerate the outside lure and stall/drop the inside lure to trigger following predators.'
    };
  } else {
    return {
      pattern: 'sine+straight',
      amplitude: 22,
      spacing: 160,
      lanes: 1,
      rationale: 'Controlled weave along the deep channel ledge edge returning toward launch ramp. Keeps deep-diving crankbaits and heavy A-Rigs patrolling right above suspended thermocline fish.'
    };
  }
}

// ── Rationale text ────────────────────────────────────────────────────────────
function buildRationaleText(species, lakeName, season, phases, phaseRecs, phaseInfo, totalRoutes, staticPhaseCount = 0) {
  const lines = [];
  lines.push(`${species} — ${lakeName}, ${season}`);
  lines.push(`Sunrise: ${phaseInfo.phases[0].startStr} → Phase boundaries computed from sunrise + solunar`);
  if (totalRoutes > 0) lines.push(`Routes: ${totalRoutes} auto-generated and committed to plan${staticPhaseCount ? ` · ${staticPhaseCount} phase(s) static-technique, no route needed` : ''}`);
  else if (staticPhaseCount === phases.length) lines.push(`Routes: 0 — every phase is a static/casting technique this trip, no trolling routes needed`);
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
      const tierLabel = phase.tier ?? phase.num;
      const isFirstOfTier = phases.findIndex(p => (p.tier ?? p.num) === tierLabel) === phases.indexOf(phase);
      if (isFirstOfTier) {
        lines.push(`  Rod setup (Tier ${tierLabel}) · Port + Stbd · Depth: ${rec.depthMin}-${rec.depthMax}ft · Speed: ${rec.speed}mph`);
      }
      lines.push(`  Lures: ${rec.lures.slice(0, 3).join(', ')}`);
      // FIX (2026-07-03): Smart Plan used to generate a trolling sweep route
      // for every phase, including phases whose primary technique is
      // topwater or free-lined/downlined live bait — techniques nobody
      // trolls. Those phases now skip route generation entirely (see
      // generateRouteForPhase / isStaticPhase); call that out explicitly
      // here instead of silently having no route with no explanation, and
      // surface the notes field prominently since it's usually the only
      // spot guidance this phase has (points, creek mouths, dam schooling
      // areas, etc.) — it was previously just tacked on as a minor line.
      if (isStaticPhase(rec)) {
        lines.push(`  ⚠ STATIC TECHNIQUE (${rec.lures[0]}) — no trolling route generated for this phase.`);
        lines.push(`  Where to fish: ${rec.notes || 'No specific area guidance in the data for this entry — use local structure knowledge (points, creek mouths, breaklines).'}`);
      } else {
        if (rec.notes) lines.push(`  Notes: ${rec.notes}`);
      }
      // FIX (2026-07-03): getRouteConfigForPhase is not defined anywhere in
      // this codebase — no local function, no import. This was crashing
      // buildRationaleText entirely (ReferenceError), which in turn left
      // plan-builder.js's rationaleHtml undefined and crashed the whole
      // plan preview render, even though route generation itself had
      // already succeeded. Guarded so a missing optional line can't take
      // down the rest of the plan. TODO: restore real per-phase route
      // config (pattern/amplitude/spacing/lanes) once the intended source
      // of this function is found — it may have been renamed/removed in
      // route-builder.js during a prior refactor.
      if (!isStaticPhase(rec) && typeof getRouteConfigForPhase === 'function') {
        const routeCfg = getRouteConfigForPhase(rec, phase.tier ?? phase.num);
        if (routeCfg) {
          lines.push(`  Route: ${routeCfg.pattern} · amplitude ${routeCfg.amplitude}ft · spacing ${routeCfg.spacing}ft · ${routeCfg.lanes} lane(s)`);
          lines.push(`  Why: ${routeCfg.rationale}`);
        }
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
  const phaseRecs = phases.map(p => getPhaseRecommendation(sp, lakeName, season, p.tier ?? p.num, waterTempF));

  if (phaseRecs.every(r => !r)) {
    setStatus('No behavior data for this lake/species yet', false);
    if (outEl) outEl.value = `No behavior data available for ${sp} on ${lakeName}. Add entries to species-intel.js.`;
    return;
  }

  // Build fishing context — gathers structures, catches, attractors for lure scoring
  const fishingContext = await buildFishingContext({
    species: sp, lakeName, season,
    clarity:    document.getElementById('planClarity')?.value || 'Clear',
    waterTempF, speedMph, dateStr, launchTime,
    rampLat: null, rampLon: null, // ramp coords locked below, context builds with map center
  });

  // Build 6-rod spread (2 rods × 3 phases)
  const sides = ['Port', 'Starboard'];
  const newSpread = [];
  for (const phase of phases) {
    const i    = phases.indexOf(phase);
    const tier = phase.tier ?? phase.num;
    const rods = await buildPhaseRods(phaseRecs[i], tier, sides, fishingContext);
    rods.forEach(r => {
      r.notes = `[Ph${phase.num}: ${phase.startStr}-${phase.endStr}] ` + (r.notes || '');
      newSpread.push(r);
    });
  }
  state.SPREAD = newSpread;
  renderSpread();

  // Remove stale Smart Plan tracks before regenerating. Manual/user tracks stay.
  const clearedSmartPlanTracks = clearExistingSmartPlanTracks();
  if (clearedSmartPlanTracks) console.log(`[smart-plan] Cleared ${clearedSmartPlanTracks} stale Smart Plan route track(s)`);
  window._smartPlanCommittedTracks = [];

  // Get and lock ramp coordinates for route anchoring. The ramp may be
  // challenged later by the coach as a recommendation, but the route engine
  // must never silently change the selected launch.
  let rampLat = null, rampLon = null;
  const selectedRampKey = document.getElementById('planRamp')?.value || '';
  const normalizeName = (v) => String(v || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cleanLakeName = normalizeName(String(lakeName || '').replace(/\([^)]*\)/g, ' ').replace(/,.*$/, ''));
  const normRampKey = normalizeName(selectedRampKey);
  const rampMatches = (a, b) => {
    const x = normalizeName(a), y = normalizeName(b);
    return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
  };

  try {
    const { WATEREE_RAMPS, MARION_RAMPS, MOULTRIE_RAMPS, MURRAY_RAMPS, MONTICELLO_RAMPS } = await import('./ryan-ramps.js');
    const lakeRampMap = {
      'lake wateree': WATEREE_RAMPS, 'wateree': WATEREE_RAMPS,
      'lake marion': MARION_RAMPS, 'marion': MARION_RAMPS,
      'lake moultrie': MOULTRIE_RAMPS, 'moultrie': MOULTRIE_RAMPS,
      'lake murray': MURRAY_RAMPS, 'murray': MURRAY_RAMPS,
      'lake monticello': MONTICELLO_RAMPS, 'monticello': MONTICELLO_RAMPS,
    };
    const rampList = lakeRampMap[cleanLakeName]
      || Object.entries(lakeRampMap).find(([k]) => cleanLakeName.includes(k) || k.includes(cleanLakeName))?.[1]
      || [];

    const GUARANTEED_SC_RAMPS = {
      'clearwater cove': [34.37927, -80.72881],
      'clearwater cove marina': [34.37927, -80.72881],
      'clearwater': [34.37927, -80.72881],
      'colonel creek': [34.36885, -80.79724],
      'colonel creek landing': [34.36885, -80.79724],
      'taylor creek': [34.3830, -80.7374],
      'taylor creek boat ramp': [34.3830, -80.7374],
      'lake wateree state park': [34.3830, -80.7374],
      'beaver creek': [34.4199, -80.7989],
      'wateree creek': [34.4800, -80.8800],
    };

    if (normRampKey) {
      for (const [k, coords] of Object.entries(GUARANTEED_SC_RAMPS)) {
        if (rampMatches(normRampKey, k)) {
          rampLat = coords[0]; rampLon = coords[1];
          console.log(`[smart-plan] Locked guaranteed ramp coords for "${selectedRampKey}": (${rampLat}, ${rampLon})`);
          break;
        }
      }
    }

    if ((rampLat == null || rampLon == null) && typeof LAKE_DB !== 'undefined') {
      const dbEntry = LAKE_DB[lakeName] || LAKE_DB[cleanLakeName]
        || Object.entries(LAKE_DB).find(([k]) => cleanLakeName.includes(normalizeName(k)))?.[1];
      if (dbEntry?.ramps) {
        const found = Object.entries(dbEntry.ramps).find(([k]) => rampMatches(k, selectedRampKey));
        const coords = dbEntry.ramps[selectedRampKey] || found?.[1];
        if (coords) {
          rampLat = Array.isArray(coords) ? coords[0] : coords.lat;
          rampLon = Array.isArray(coords) ? coords[1] : (coords.lon || coords.lng);
          console.log(`[smart-plan] Locked LAKE_DB ramp coords for "${selectedRampKey}": (${rampLat}, ${rampLon})`);
        }
      }
    }

    if (rampLat == null || rampLon == null) {
      const selectedRamp = rampList.find(r => rampMatches(r.key, selectedRampKey) || rampMatches(r.name, selectedRampKey)) || rampList[0];
      if (selectedRamp) {
        rampLat = selectedRamp.lat; rampLon = selectedRamp.lon;
        console.log(`[smart-plan] Locked ryan-ramps coords for ${selectedRamp.name}: (${rampLat}, ${rampLon})`);
      }
    }
  } catch (e) {
    console.warn('[smart-plan] Could not load ramp coords:', e.message);
  }

  if (rampLat == null || rampLon == null) {
    console.warn(`[smart-plan] No ramp coords found for "${lakeName}" / "${selectedRampKey}" — route will generate without a locked launch anchor.`);
  } else {
    upsertSmartPlanRampWaypoint(selectedRampKey || 'Launch ramp', rampLat, rampLon);
  }

  // Generate continuous trolling circuit routes for each phase
  window._smartPlanPhaseRoutes = [];
  function calcDurHrs(sStr, eStr) {
    const parse = s => {
      const m = String(s||'').match(/(\d+):(\d+)\s*(AM|PM)?/i);
      if (!m) return 2.0;
      let h = parseInt(m[1]), min = parseInt(m[2]);
      if (m[3]?.toUpperCase() === 'PM' && h < 12) h += 12;
      if (m[3]?.toUpperCase() === 'AM' && h === 12) h = 0;
      return h + (min / 60.0);
    };
    let s = parse(sStr), e = parse(eStr);
    if (e < s) e += 24.0;
    return Math.max(0.5, e - s);
  }

  let curLat = rampLat, curLon = rampLon;
  let lockedBearing = null;
  const assembledSmartPlanTracks = [];

  for (let i = 0; i < phases.length; i++) {
    const durHrs = calcDurHrs(phases[i].startStr, phases[i].endStr);
    const spd = phaseRecs[i]?.speed || 2.2;

    // Each phase gets a distance budget based on its own time window. Keep the
    // fishing pass under the full phase mileage so there is room for launch,
    // phase-to-phase, and return connectors.
    const isLastPhase = (i === phases.length - 1);
    // Raised from 0.60-0.70 — Ryan's manual route shows 15.7mi for a 9hr day
    // at 1.8mph = 0.97 coverage. Use 0.90 to leave room for connectors.
    // Phase 1 (shallow, slower 1.5mph casting) gets slightly less distance.
    const phaseFishingFraction = (phases[i].tier ?? phases[i].num) === 1 ? 0.75 : 0.92;
    const targetFt = Math.round(durHrs * spd * 5280 * phaseFishingFraction);

    const phaseTracks = await generateRouteForPhase(
      phases[i], phaseRecs[i], lakeName, rampLat, rampLon, rangeMiles,
      targetFt, curLat, curLon,
      isLastPhase ? rampLat : null, isLastPhase ? rampLon : null,
      isLastPhase, // isReturnPass — only true for the final sub-phase
      lockedBearing
    );

    if (phaseTracks?.length) {
      const fromLabel = i === 0 ? (selectedRampKey || 'Launch ramp') : `Phase ${phases[i - 1].num} ${phases[i - 1].name}`;
      const toLabel = `Phase ${phases[i].num} ${phases[i].name}`;
      const next = appendConnectorThenTracks(assembledSmartPlanTracks, curLat, curLon, phaseTracks, fromLabel, toLabel);
      curLat = next.lat; curLon = next.lon;

      if (i === 0 && lockedBearing === null && Number.isFinite(rampLat) && Number.isFinite(rampLon)) {
        const lastFishingTrack = [...phaseTracks].reverse().find(t => t?.pts?.length >= 2);
        const farPt = lastFishingTrack?.pts?.[lastFishingTrack.pts.length - 1];
        if (farPt) {
          const dLat = (farPt[0] - rampLat) * 111320;
          const dLon = (farPt[1] - rampLon) * 111320 * Math.cos(rampLat * Math.PI / 180);
          lockedBearing = Math.atan2(dLon, dLat) * 180 / Math.PI;
        }
      }
    }
  }

  // Hard return-to-ramp rule. Prefer a short direct connector only. If the
  // final point is still far from launch, do NOT draw a long overland line;
  // retrace known water route points back toward the ramp instead.
  if (assembledSmartPlanTracks.length && Number.isFinite(rampLat) && Number.isFinite(rampLon)) {
    const directReturnFt = geoDistanceFt(curLat, curLon, rampLat, rampLon);
    // Raised from 1200ft — almost any fishing session ends more than 0.23mi
    // from the ramp, so the old threshold always triggered the retrace monster
    // (925-point spaghetti). Now we always draw a direct return connector and
    // label it clearly so the angler knows it's a transit line, not a fishing
    // route. The retrace fallback is kept only for sub-25ft snapping.
    if (directReturnFt <= 25) {
      const lastTrack = assembledSmartPlanTracks[assembledSmartPlanTracks.length - 1];
      if (lastTrack?.pts?.length) lastTrack.pts[lastTrack.pts.length - 1] = [rampLat, rampLon];
    } else {
      const ret = buildSmartPlanConnectorTrack(
        `Return: Phase ${phases[phases.length - 1].num} ${phases[phases.length - 1].name} → ${selectedRampKey || 'Launch ramp'}`,
        curLat, curLon, rampLat, rampLon, 'return_connector'
      );
      if (ret) assembledSmartPlanTracks.push(ret);
    }
  }

  if (!state.DATA.tracks) state.DATA.tracks = [];
  state.DATA.tracks.push(...assembledSmartPlanTracks);
  window._smartPlanCommittedTracks = assembledSmartPlanTracks;
  renderAll();

  applyToPlanFields(phaseRecs, phases);
  applyStoredSmartPlanDepth();

  // Build rationale
  // FIX (2026-07-03): this was hardcoded to 0 unconditionally, so the
  // rationale header always said "No contour data loaded" even when routes
  // had genuinely just been generated above. Now reflects the real count,
  // and separately reports how many phases were static-technique (no route
  // expected) so the summary line is accurate either way.
  const generatedRoutes = (window._smartPlanPhaseRoutes || []).filter(r => !r.staticTechnique).length;
  const staticPhaseCount = (window._smartPlanPhaseRoutes || []).filter(r => r.staticTechnique).length;
  const totalRoutes = generatedRoutes;
  let rationale = buildRationaleText(sp, lakeName, season, phases, phaseRecs, phaseInfo, totalRoutes, staticPhaseCount);

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

  const routeAudit = auditSmartPlanRoute(window._smartPlanCommittedTracks || [], rampLat, rampLon, launchTime, returnTime, speedMph);
  if (Number.isFinite(rampLat) && Number.isFinite(rampLon)) {
    rationale += buildRouteAuditText(routeAudit, selectedRampKey, rampLat, rampLon);
  }

  if (outEl) outEl.value = rationale;

  // ── Write computed values back to plan form fields so collectPlan() saves them ──
  const sol = phaseInfo.solunar;
  function solFmt(h) {
    const hh = Math.floor(((h % 24) + 24) % 24);
    const mm = String(Math.round((h % 1) * 60)).padStart(2, '0');
    return `${hh % 12 || 12}:${mm} ${hh < 12 ? 'AM' : 'PM'}`;
  }
  const solunarStr = `Majors: ${solFmt(sol.major1)}, ${solFmt(sol.major2)} · Minors: ${solFmt(sol.minor1)}, ${solFmt(sol.minor2)}`;
  const solunarEl = document.getElementById('planSolunar');
  if (solunarEl && !solunarEl.value) solunarEl.value = solunarStr;

  const structureEl = document.getElementById('planStructure');
  if (structureEl && !structureEl.value) {
    const recStructures = phaseRecs.filter(Boolean).flatMap(r =>
      (r.notes || '').match(/structure[:\s]+([^\n·]+)/gi) || []
    );
    if (recStructures.length) structureEl.value = recStructures[0].replace(/structure[:\s]+/i, '').trim();
  }

  // ── Groq iterative coach — replaces one-shot audit ───────────────────────────
  // Builds rich context payload and starts the coaching session as a floating panel.
  // Non-blocking — plan is already visible before coach starts.
  try {
    const coachPayload = buildGroqCoachPayload(fishingContext, {
      phases,
      phaseRecs,
      spread:    state.SPREAD,
      solunarStr,
      poolLevel: document.getElementById('planPoolLevel')?.value || null,
      weather:   document.getElementById('planWeather')?.value || '',
      rationale: rationale.slice(0, 1500),
      rampName:  selectedRampKey || document.getElementById('planRamp')?.value || '',
      rangeMiles,
    });
    startCoachSession(coachPayload);
  } catch (e) {
    console.warn('[smart-plan] Coach session failed to start:', e.message);
  }

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
  // FIX (2026-07-03): this was importing from '../data/ryan-ramps.js', which
  // doesn't exist and 404s — the real file lives alongside this module and
  // is already imported correctly elsewhere in this file (see the ramp
  // lookup in runSmartPlan) as './ryan-ramps.js'. The wrong path here was
  // crashing runSmartPlan at the ramp-evaluation step, after routes had
  // already generated successfully, aborting before the rationale text and
  // status line ever got written.
  const { evaluateRamps, parseWindDeg } = await import('./ryan-ramps.js');

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
