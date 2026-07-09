/**
 * smart-plan.js — TrollMap Smart Plan Orchestrator
 *
 * Reads the Plan tab fields and generates a 3-phase fishing plan:
 *   - Phase 1: Dawn (launch → ~90min post-sunrise, topwater/shallow)
 *   - Phase 2: Transition (90min → 3.5hrs post-sunrise, mid-depth)
 *   - Phase 3: Deep (3.5hrs post-sunrise → return, thermocline)
 *
 * NEW APPROACH (2026-07-09):
 *   Instead of trying to auto-generate trolling routes from depth contour
 *   spines (which produced reversals, bad directions, and geometry errors),
 *   Smart Plan now:
 *     1. Samples real points directly off the depth contour data at the
 *        correct depth for each phase
 *     2. Drops those as named waypoints on the map (Ph1-1, Ph1-2, etc.)
 *     3. Calls Groq to produce a written scout report — what to look for,
 *        where, why, what to throw
 *     4. You connect the waypoints manually in the route builder
 *
 *   The waypoint system + manual route builder already works perfectly.
 *   This gives you the fishing intelligence to use it without drawing blind.
 *
 * Platform: Kayak (Native Watersports Slayer Propel Max 12.5),
 *   NK180 Pro motor (24V brushless, ~6A avg draw at trolling speed),
 *   100Ah LiFePO4 battery, 2 rods max in water at any time.
 */

import { state, CF_WORKER_URL } from '../core/state.js';
import { renderAll } from '../core/map-init.js';
import { esc } from '../utils/escape.js';
import { newRodRow } from '../utils/rod-row.js';
import { renderSpread, autoCalculateLead, LURE_DIVE_DEPTHS } from './spread-builder.js';
import { onContourChange } from './contour-data.js';
import { getActiveContour } from './contour-data.js';
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
import * as IntelV2 from '../data/species-intel-v2.js';
import { isLiveBaitAvailable } from '../data/fishing-style-profile.js';

// ── Constants ────────────────────────────────────────────────────────────────
const MAX_RODS_PER_PHASE = 2;
const BATTERY_AH_DEFAULT = 100;
const MOTOR_AMP_AVG = 6;
const PHASE_1_END_OFFSET_MIN = 60;
const PHASE_2_END_OFFSET_MIN = 210;

// ── Lure color defaults ───────────────────────────────────────────────────────
const LURE_COLOR_DEFAULTS = {
  'Choppo 90 – Topwater':                    'Natural',
  'Zara Spook – Topwater':                   'Natural',
  'Whopper Plopper 110 – Topwater':          'Natural',
  'Buzzbait 1/2oz – Topwater':               'Bright',
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
  'Spinnerbait':            'Spinnerbait 1/2oz',
  'Lipless crankbait':      'Lipless Crankbait 1/2oz',
  'Lipless Crankbait':      'Lipless Crankbait 1/2oz',
  'ChatterBait':            'ChatterBait 3/4oz',
  'Buzzbait':               'Buzzbait 1/2oz – Topwater',
  'Shallow crankbait':      'Rapala DT-10 – Crankbait (shallow/medium, ~10ft)',
  'Medium crankbait':       'Rapala DT-14 – Crankbait (medium/deep, ~14ft)',
  'Swimbait on jighead':    'Swimbait 4.6" – Jighead',
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

function isStaticTechnique(rawLureName) {
  if (!rawLureName) return false;
  const s = rawLureName.toLowerCase();
  if (s.includes('topwater') || s.includes('buzz') || s.includes('plopper') || s.includes('spook')) return true;
  if (s.includes('free-line') || s.includes('freeline') || s.includes('free line')) return true;
  if (s.includes('downline') || s.includes('down-line') || s.includes('down line')) return true;
  if (s.includes('live') && !s.includes('lead-core')) return true;
  if (s.includes('cut bait') || s.includes('cut_bait')) return true;
  if (s.includes('anchor') || s.includes('finesse')) return true;
  if (s.includes('wacky') || s.includes('drop_shot') || s.includes('ned_rig') || s.includes('jig_n_pig')) return true;
  if (s.includes('texas_rig') || s.includes('carolina_rig')) return true;
  if (s.includes('live_bluegill') || s.includes('live_bream') || s.includes('live_shad')) return true;
  const resolved = resolveLure(rawLureName);
  if (resolved && resolved.toLowerCase().includes('topwater')) return true;
  return false;
}

function isStaticPhase(phaseRec) {
  const lures = getEffectiveLures(phaseRec);
  if (!lures.length) return false;
  return isStaticTechnique(lures[0]);
}

function getEffectiveLures(phaseRec) {
  if (!phaseRec?.lures?.length) return [];
  const available = phaseRec.lures.filter(l => isLiveBaitAvailable(l));
  if (available.length) return available;
  return ['A-Rig Medium'];
}

// ── Geo helpers ───────────────────────────────────────────────────────────────
function geoDistanceFt(lat1, lon1, lat2, lon2) {
  const R = 20902231, D = Math.PI / 180;
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const p1 = lat1*D, p2 = lat2*D, dp = (lat2-lat1)*D, dl = (lon2-lon1)*D;
  const a = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Sunrise computation ───────────────────────────────────────────────────────
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
  const utcHour = ((t / 60) + 24) % 24;
  return utcHour - 5;
}

// ── Solunar computation ───────────────────────────────────────────────────────
function computeSolunar(lat, lon, dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const JD = Math.floor(d / 86400000) + 2440587.5;
  const T = (JD - 2451545.0) / 36525;
  const Lm = 218.3164 + 481267.8812 * T;
  const moonTransitUT = (360 - (Lm % 360)) / 15;
  const offsetH = lon / 15;
  const major1 = ((moonTransitUT + offsetH + 24) % 24) - 5;
  const major2 = (major1 + 12) % 24;
  const minor1 = (major1 + 6) % 24;
  const minor2 = (major1 + 18) % 24;
  return { major1, major2, minor1, minor2 };
}

const LAKE_CENTERS = {
  'Lake Wateree':    { lat: 34.37, lon: -80.73 },
  'Lake Murray':     { lat: 34.06, lon: -81.32 },
  'Lake Marion':     { lat: 33.55, lon: -80.30 },
  'Lake Moultrie':   { lat: 33.28, lon: -80.05 },
  'Lake Monticello': { lat: 34.44, lon: -81.21 },
  'Parr Reservoir':  { lat: 34.30, lon: -81.16 },
};

function getLakeCenter(lakeName) {
  const key = Object.keys(LAKE_CENTERS).find(k =>
    lakeName.toLowerCase().includes(k.toLowerCase().replace('lake ', ''))
  );
  return key ? LAKE_CENTERS[key] : { lat: 34.37, lon: -80.73 };
}

function computeRangeMiles(speedMph) {
  const spd = speedMph || 2.0;
  const bms = window.ACTIVE_BLE_BMS;
  if (bms && bms.connected && bms.remainingAh > 0 && bms.current > 0.1) {
    return (bms.remainingAh / bms.current * spd) / 2;
  }
  return (BATTERY_AH_DEFAULT / MOTOR_AMP_AVG * spd) / 2;
}

// ── Phase boundary computation ────────────────────────────────────────────────
function computePhases(launchTimeStr, returnTimeStr, dateStr, lakeName) {
  const center = getLakeCenter(lakeName);
  const sunriseH = computeSunrise(center.lat, center.lon, dateStr);
  const sol = computeSolunar(center.lat, center.lon, dateStr);

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

  let p1End = sunriseH + PHASE_1_END_OFFSET_MIN / 60;
  let p2End = sunriseH + PHASE_2_END_OFFSET_MIN / 60;

  [sol.major1, sol.major2].forEach(t => {
    if (t >= launchH && t <= p1End + 0.5) p1End = Math.max(p1End, t + 1.0);
    if (t >= p1End && t <= p2End + 0.5) p2End = Math.max(p2End, t + 1.0);
  });
  [sol.minor1, sol.minor2].forEach(t => {
    if (t >= launchH && t <= p1End + 0.25) p1End = Math.max(p1End, t + 0.5);
  });

  p1End = Math.min(p1End, returnH - 1.0);
  p2End = Math.min(p2End, returnH - 0.5);
  if (p1End >= p2End) p1End = launchH + (returnH - launchH) / 3;
  if (p2End >= returnH) p2End = launchH + 2 * (returnH - launchH) / 3;

  function hToStr(h) {
    const hh = Math.floor(((h % 24) + 24) % 24);
    const mm = Math.round((h % 1) * 60);
    return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
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
      try {
        const sd = getPhaseDepth(species, season, phaseNum);
        if (sd) [dMin, dMax] = sd;
      } catch (_) {
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
        notes: (() => {
          try { const pn = getPhaseNotes(species, season, phaseNum); if (pn) return pn; } catch (_) {}
          return Array.isArray(sNode.notes) ? sNode.notes.join(' · ') : (sNode.notes || '');
        })(),
        _v2meta: {
          structure: sNode.preferredStructure,
          lureFamilies: sNode.lureFamilies,
          colors: sNode.preferredColors,
          lead: sNode.leadDistance,
          forage: sNode.forage,
        },
      };
    }
  }

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

// ── Rod builder ───────────────────────────────────────────────────────────────
function getTacticallyAlignedLure(targetDepth, preferredLures, slotIndex = 0) {
  const depth = parseFloat(targetDepth);
  if (isNaN(depth)) return null;
  const validMatches = [];
  for (const rawLure of preferredLures) {
    const resolved = resolveLure(rawLure);
    if (!resolved) continue;
    const dive = LURE_DIVE_DEPTHS[resolved];
    if (dive && depth >= dive.minDive && depth <= dive.maxDive) {
      if (!validMatches.includes(resolved)) validMatches.push(resolved);
    }
  }
  if (validMatches.length > slotIndex) return validMatches[slotIndex];
  if (validMatches.length > 0) return validMatches[0];
  if (depth < 5)  return 'Choppo 90 – Topwater';
  if (depth < 12) return 'Flicker Minnow 11 – Crankbait';
  if (depth < 20) return 'A-Rig Medium (~2.65oz) – 4.6" Swimbait';
  return 'Deep Hit Stick – Crankbait';
}

async function buildPhaseRods(phaseRec, phaseNum, sides, fishingContext) {
  if (!phaseRec) return [newRodRow(), newRodRow()];
  const dMin = phaseRec.depthMin || 10;
  const dMax = phaseRec.depthMax || 18;
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
    try {
      const result = await selectBestLure({
        species: speciesNorm, season, clarity, clarityKey,
        targetDepthFt: targetDepth, depthMin: dMin, depthMax: dMax,
        speedMph, structure, preferredTypes, slotIndex: i,
      });
      selectedLure = result?.lure || null;
      scoreResult  = result?.scoreResult || null;
    } catch (_) {}
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
    results.push(rod);
  }
  return results;
}

// ── Scout waypoint generation ─────────────────────────────────────────────────
// Walks stitched contour fragments at the right depth, sampling a point every
// STEP_FT feet. This produces a dense chain of points that follows the actual
// depth edge geometry — no direction math, no spine reversal problems, no
// tile boundary artifacts. Short enough steps mean connecting them in order
// never crosses land.
//
// Strategy:
//   1. Collect all contour features in the depth band within range of ramp
//   2. Stitch same-depth fragments end-to-end (reuse route-builder logic inline)
//   3. Pick the longest stitched chain closest to the ramp
//   4. Walk it sampling a point every STEP_FT feet
//   5. Trim to the phase fishing budget (time × speed)

// Simple fragment stitcher — chains [lon,lat] fragments whose endpoints are
// within TOL_FT of each other. Same logic as route-builder stitchFragments
// but self-contained so smart-plan doesn't need to import route-builder.
function stitchContourFragments(fragments, TOL_FT = 50) {
  const segs = fragments
    .filter(c => c.length >= 2)
    .map(c => c.map(([lo, la]) => [la, lo])); // [lon,lat] → [lat,lon]
  const used = new Array(segs.length).fill(false);
  const chains = [];

  function dist2(a, b) {
    const dlat = (a[0] - b[0]) * 364000;
    const dlon = (a[1] - b[1]) * 364000 * Math.cos(a[0] * Math.PI / 180);
    return Math.sqrt(dlat * dlat + dlon * dlon);
  }

  // Turn angle between two bearings — reject joins that would double back
  function bearing(a, b) {
    return Math.atan2((b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180), b[0] - a[0]) * 180 / Math.PI;
  }
  function angleDiff(a, b) {
    let d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    let chain = segs[s].slice();
    let grew = true;
    while (grew) {
      grew = false;
      const head = chain[0], tail = chain[chain.length - 1];
      const tailBrng = chain.length >= 2 ? bearing(chain[chain.length - 2], tail) : 0;
      const headBrng = chain.length >= 2 ? bearing(chain[1], head) : 0;
      let bestJ = -1, bestScore = Infinity, bestOp = null;
      for (let j = 0; j < segs.length; j++) {
        if (used[j]) continue;
        const c = segs[j];
        const a = c[0], b = c[c.length - 1];
        const cands = [
          { d: dist2(tail, a), op: 'TA', turn: angleDiff(tailBrng, bearing(a, c[Math.min(1, c.length-1)])) },
          { d: dist2(tail, b), op: 'TB', turn: angleDiff(tailBrng, bearing(b, c[Math.max(0, c.length-2)])) },
          { d: dist2(head, a), op: 'HA', turn: angleDiff(headBrng, bearing(a, c[Math.min(1, c.length-1)])) },
          { d: dist2(head, b), op: 'HB', turn: angleDiff(headBrng, bearing(b, c[Math.max(0, c.length-2)])) },
        ];
        for (const cand of cands) {
          if (cand.d > TOL_FT || cand.turn > 90) continue; // allow up to 90° — contours bend
          const score = cand.d + cand.turn;
          if (score < bestScore) { bestScore = score; bestJ = j; bestOp = cand.op; }
        }
      }
      if (bestJ >= 0) {
        const c = segs[bestJ].slice(); used[bestJ] = true; grew = true;
        if (bestOp === 'TA') chain = chain.concat(c);
        else if (bestOp === 'TB') chain = chain.concat(c.reverse());
        else if (bestOp === 'HA') chain = c.reverse().concat(chain);
        else chain = c.concat(chain);
      }
    }
    chains.push(chain); // [lat,lon][]
  }
  return chains;
}

function walkContourForWaypoints(depthMin, depthMax, refLat, refLon, maxDistFt, budgetFt, stepFt = 150, endTarget = null) {
  const contour = getActiveContour();
  const gj = contour?.smart || contour?.raw;
  if (!gj?.features?.length) return [];

  // Filter to depth band and within range
  const inRange = gj.features.filter(f => {
    const d = f.properties?.depth_ft;
    if (d == null || d < depthMin || d > depthMax) return false;
    const coords = f.geometry?.coordinates;
    if (!coords?.length) return false;
    // Quick bbox check — any vertex within range
    return coords.some(([lo, la]) => geoDistanceFt(refLat, refLon, la, lo) <= maxDistFt);
  });

  if (!inRange.length) {
    console.warn(`[scout] no features in ${depthMin}-${depthMax}ft within ${Math.round(maxDistFt)}ft`);
    return [];
  }

  // Group by depth and stitch each depth's fragments
  const byDepth = new Map();
  for (const f of inRange) {
    const d = f.properties.depth_ft;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d).push(f.geometry.coordinates);
  }

  // Build all stitched chains across all depths, compute length + proximity
  const allChains = [];
  for (const [depth, frags] of byDepth) {
    const chains = stitchContourFragments(frags);
    for (const chain of chains) {
      if (chain.length < 2) continue;
      // Arc length
      let len = 0;
      for (let i = 1; i < chain.length; i++) {
        len += geoDistanceFt(chain[i-1][0], chain[i-1][1], chain[i][0], chain[i][1]);
      }
      if (len < stepFt * 2) continue; // too short to be useful
      // Closest point on chain to ramp
      let closest = Infinity;
      const step = Math.max(1, Math.floor(chain.length / 40));
      for (let i = 0; i < chain.length; i += step) {
        const d = geoDistanceFt(refLat, refLon, chain[i][0], chain[i][1]);
        if (d < closest) closest = d;
      }
      if (closest > maxDistFt) continue;
      allChains.push({ chain, len, closest, depth });
    }
  }

  if (!allChains.length) return [];

  // Score: prefer long chains close to ref point.
  // For Phase 3 (endTarget set): also prefer chains whose far end is near the ramp.
  allChains.sort((a, b) => {
    const eA = endTarget ? geoDistanceFt(endTarget.endLat, endTarget.endLon, a.chain[a.chain.length-1][0], a.chain[a.chain.length-1][1]) * 0.5 : 0;
    const eB = endTarget ? geoDistanceFt(endTarget.endLat, endTarget.endLon, b.chain[b.chain.length-1][0], b.chain[b.chain.length-1][1]) * 0.5 : 0;
    return (a.closest * 2 - a.len + eA) - (b.closest * 2 - b.len + eB);
  });
  const best = allChains[0];
  console.log(`[scout] best chain: depth=${best.depth}ft len=${Math.round(best.len)}ft closest=${Math.round(best.closest)}ft`);



  // For homeward phases: start from the point on the chain nearest the RAMP
  // so we walk from home-side outward (budget-limited), naturally ending
  // closer to the ramp than where we started.
  // For outbound phases: start from the point nearest curLat/curLon (ref point).
  const anchorLat = endTarget ? endTarget.endLat : refLat;
  const anchorLon = endTarget ? endTarget.endLon : refLon;
  let nearIdx = 0, nearDist = Infinity;
  for (let i = 0; i < best.chain.length; i++) {
    const d = geoDistanceFt(anchorLat, anchorLon, best.chain[i][0], best.chain[i][1]);
    if (d < nearDist) { nearDist = d; nearIdx = i; }
  }

  // Walk forward from nearIdx, sampling every stepFt, up to budgetFt total
  const fwdPts = [];
  let traveled = 0, carry = 0;
  fwdPts.push({ lat: best.chain[nearIdx][0], lon: best.chain[nearIdx][1], depth: best.depth });
  for (let i = nearIdx + 1; i < best.chain.length && traveled < budgetFt; i++) {
    const prev = best.chain[i - 1], curr = best.chain[i];
    const segFt = geoDistanceFt(prev[0], prev[1], curr[0], curr[1]);
    carry += segFt; traveled += segFt;
    if (carry >= stepFt) { fwdPts.push({ lat: curr[0], lon: curr[1], depth: best.depth }); carry = 0; }
  }

  // Also walk backward from nearIdx
  const revPts = [];
  traveled = 0; carry = 0;
  revPts.push({ lat: best.chain[nearIdx][0], lon: best.chain[nearIdx][1], depth: best.depth });
  for (let i = nearIdx - 1; i >= 0 && traveled < budgetFt; i--) {
    const prev = best.chain[i + 1], curr = best.chain[i];
    const segFt = geoDistanceFt(prev[0], prev[1], curr[0], curr[1]);
    carry += segFt; traveled += segFt;
    if (carry >= stepFt) { revPts.push({ lat: curr[0], lon: curr[1], depth: best.depth }); carry = 0; }
  }

  // Pick the longer walk, unless endTarget is set (Phase 3) — then pick the walk
  // whose last point is closer to the ramp so the phase naturally heads home.
  let waypoints;
  if (endTarget && fwdPts.length >= 2 && revPts.length >= 2) {
    const fwdEndDist = geoDistanceFt(endTarget.endLat, endTarget.endLon, fwdPts[fwdPts.length-1].lat, fwdPts[fwdPts.length-1].lon);
    const revEndDist = geoDistanceFt(endTarget.endLat, endTarget.endLon, revPts[revPts.length-1].lat, revPts[revPts.length-1].lon);
    waypoints = fwdEndDist < revEndDist ? fwdPts : revPts;
  } else {
    waypoints = fwdPts.length >= revPts.length ? fwdPts : revPts;
  }

  console.log(`[scout] ${waypoints.length} waypoints at ${stepFt}ft spacing`);
  return waypoints;
}

// Hard depth bands per phase — non-overlapping so each phase finds different water.
// All phases start from where the previous one ended (curLat/curLon).
// Phases 3+4: if walk ends farther from ramp than it started, reverse it.
const SCOUT_DEPTH_BANDS = [
  { depthMin: 15, depthMax: 20 }, // Phase 1: shallow, outbound
  { depthMin: 22, depthMax: 26 }, // Phase 2: mid-ledge, outbound
  { depthMin: 28, depthMax: 32 }, // Phase 3: deep channel
  { depthMin: 18, depthMax: 23 }, // Phase 4: mid-shallow, home
];

// ── Groq-driven waypoint generation ─────────────────────────────────────────
// Ask Groq to place fishing waypoints along a route it knows from local knowledge.
// Validate every coordinate against lake boundary + contour depth data before
// dropping it on the map. If Groq hallucinates coordinates outside the lake they
// get thrown out silently. Worst case = zero waypoints, same as before.

function pointInPolygonSimple(lat, lon, polygon) {
  // polygon = [[lat,lon], ...] GeoJSON outer ring
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function isCoordInLake(lat, lon) {
  // Check against loaded lake boundary if available
  const boundary = window.LAKE_BOUNDARY_GEOJSON;
  if (!boundary?.features?.length) return true; // no boundary loaded — trust it
  for (const f of boundary.features) {
    const g = f.geometry;
    if (!g) continue;
    const rings = g.type === 'Polygon' ? [g.coordinates[0]]
      : g.type === 'MultiPolygon' ? g.coordinates.map(p => p[0]) : [];
    for (const ring of rings) {
      const ll = ring.map(([lo, la]) => [la, lo]);
      if (pointInPolygonSimple(lat, lon, ll)) return true;
    }
  }
  return false;
}

function getDepthAtCoord(lat, lon) {
  // Find the nearest contour feature and return its depth
  const contour = getActiveContour();
  const gj = contour?.smart || contour?.raw;
  if (!gj?.features?.length) return null;
  let bestDepth = null, bestDist = Infinity;
  const step = Math.max(1, Math.floor(gj.features.length / 200));
  for (let fi = 0; fi < gj.features.length; fi += step) {
    const f = gj.features[fi];
    const coords = f.geometry?.coordinates;
    const depth = f.properties?.depth_ft;
    if (!coords || depth == null) continue;
    const mid = coords[Math.floor(coords.length / 2)];
    const d = geoDistanceFt(lat, lon, mid[1], mid[0]);
    if (d < bestDist) { bestDist = d; bestDepth = depth; }
  }
  return bestDist < 2000 ? bestDepth : null; // only trust within 2000ft
}

async function generateScoutWaypoints(phases, phaseRecs, rampLat, rampLon, rangeMiles, speedMph = 2.0, phaseInfo) {
  if (!state.DATA) state.DATA = {};
  if (!Array.isArray(state.DATA.waypoints)) state.DATA.waypoints = [];
  state.DATA.waypoints = state.DATA.waypoints.filter(w => !w.scoutWaypoint);

  // Add ramp waypoint
  if (Number.isFinite(rampLat) && Number.isFinite(rampLon)) {
    state.DATA.waypoints.push({
      name: 'Launch',
      lat: rampLat, lon: rampLon,
      sym: 'Boat Ramp',
      role: 'launch_ramp',
      scoutWaypoint: true,
    });
  }

  const p = phaseInfo?.phases || phases;
  const totalDurH = p.length ? (p[p.length-1].end - p[0].start) : 6;
  const rec1 = phaseRecs[0];
  const rec3 = phaseRecs[2] || phaseRecs[1];
  const outDepthMin = rec1?.depthMin || 10;
  const outDepthMax = rec1?.depthMax || 20;
  const inDepthMin  = rec3?.depthMin || 20;
  const inDepthMax  = rec3?.depthMax || 30;
  const species = phaseRecs.find(Boolean)?.lures?.[0] ? 'Striped Bass' : 'fish';

  // Build Groq prompt — full fishing context + two equal legs
  const totalDistFt = Math.round(totalDurH * speedMph * 5280 * 0.8);
  const halfDistFt  = Math.round(totalDistFt / 2);
  const numWpts     = Math.max(10, Math.round(halfDistFt / 800)); // ~800ft spacing per leg — keep response small
  const season      = phaseInfo?.season || getSeason(new Date());
  const sp          = phaseRecs.find(Boolean)?._v2meta?.forage ? 'Striped Bass' : 'Striped Bass';
  const timeOfDay   = phaseInfo?.phases?.[0]?.startStr || 'dawn';
  const waterTemp   = phaseRecs.find(Boolean)?.waterTempF ? `${phaseRecs.find(Boolean).waterTempF}°F` : 'unknown';
  const clarity     = document.getElementById('planClarity')?.value || 'unknown';
  const weather     = document.getElementById('planWeather')?.value || 'unknown';

  const prompt = `You are an expert fishing guide for Lake Wateree, South Carolina.

TRIP DETAILS:
- Species: Striped Bass
- Season: ${season}
- Launch time: ${timeOfDay}
- Water temp: ${waterTemp}
- Clarity: ${clarity}
- Weather: ${weather}
- Platform: Kayak with pedal drive and electric motor (Native Watersports Slayer Propel Max 12.5)
- Rods: 2 max in water simultaneously, no downriggers, depth controlled by lead length only
- No live bait
- Launch ramp: Clearwater Cove (${rampLat.toFixed(5)}, ${rampLon.toFixed(5)})
- Trip duration: ${totalDurH.toFixed(1)} hours at ${speedMph}mph = ${Math.round(totalDistFt/5280*10)/10} miles total

LAKE ORIENTATION:
Lake Wateree runs roughly north-south. The main lake body extends southwest from the ramp. Deep channel water is further west. The lake is about 3 miles wide in this area with the deepest water near the center channel.

YOUR JOB:
Plan a trolling route as exactly two legs of ${numWpts} waypoints each.

LEG 1 (outbound, exactly ${numWpts} waypoints):
- Target depth: ${outDepthMin}-${outDepthMax}ft
- Start at ramp (${rampLat.toFixed(5)}, ${rampLon.toFixed(5)})
- Travel ${Math.round(halfDistFt/5280*10)/10} miles from the ramp along fishable structure
- Choose water based on where stripers will be at ${timeOfDay} in ${season}
- Space waypoints ~400ft apart following the contour edge
- MUST spread the full ${Math.round(halfDistFt/5280*10)/10} miles — do not cluster near ramp

LEG 2 (inbound, exactly ${numWpts} waypoints):
- Target depth: ${inDepthMin}-${inDepthMax}ft (slightly deeper than leg 1 — channel side)
- Start where Leg 1 ends
- Return toward ramp over ${Math.round(halfDistFt/5280*10)/10} miles
- Fish the deeper channel structure on the way home
- End within 0.5 miles of ramp

Return ONLY a JSON array of {"lat", "lon", "leg"} objects. No notes, no explanation, no markdown, no extra fields:
[
  {"lat": 34.37800, "lon": -80.72900, "leg": 1},
  ...
]

Use real Lake Wateree coordinates. Stay in the water. No land. Both legs must have exactly ${numWpts} waypoints.`;


  let groqWaypoints = [];
  try {
    // Two separate calls — one per leg — keeps each response under token limit

    async function groqLeg(legNum, depthMin, depthMax, startLat, startLon, endLat, endLon, nWpts, direction) {
      const legPrompt = `You are a fishing guide for Lake Wateree SC.
Place exactly ${nWpts} waypoints for a kayak trolling route.
Ramp: (${rampLat.toFixed(5)}, ${rampLon.toFixed(5)})
${legNum === 1
  ? `LEG 1 (outbound): Start at (${startLat.toFixed(5)}, ${startLon.toFixed(5)}). Fish ${depthMin}-${depthMax}ft water heading ${direction} for ${nWpts} waypoints spaced ~800ft apart. Follow the depth contour edge.`
  : `LEG 2 (inbound): Your outbound leg just ended at (${startLat.toFixed(5)}, ${startLon.toFixed(5)}). Now fish back to the ramp at (${endLat.toFixed(5)}, ${endLon.toFixed(5)}) on slightly deeper water (${depthMin}-${depthMax}ft). Travel ${direction}. Place ${nWpts} waypoints spaced ~800ft apart following the depth contour. First waypoint near (${startLat.toFixed(5)}, ${startLon.toFixed(5)}), last waypoint near (${endLat.toFixed(5)}, ${endLon.toFixed(5)}).`
}
Return ONLY a JSON array, no explanation:
[{"lat":34.378,"lon":-80.729,"leg":${legNum}},...]`;

      const res = await fetch(`${CF_WORKER_URL}/groq-query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: legPrompt }],
          max_tokens: 3000,
          temperature: 0.3,
        }),
      });
      if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content?.trim() || '';
      console.log(`[scout] Leg ${legNum} response length: ${text.length}`);
      const clean = text.replace(/```json|```/g, '').trim();
      const si = clean.indexOf('['), ei = clean.lastIndexOf(']');
      if (si === -1 || ei === -1) { console.warn(`[scout] Leg ${legNum}: no JSON array`); return []; }
      try {
        const pts = JSON.parse(clean.slice(si, ei + 1));
        console.log(`[scout] Leg ${legNum}: ${pts.length} waypoints`);
        return pts;
      } catch(e) { console.warn(`[scout] Leg ${legNum} parse failed:`, e.message); return []; }
    }

    const nWpts = Math.max(8, Math.round((totalDurH / 2 * speedMph * 5280 * 0.8) / 800));
    console.log(`[scout] Requesting ${nWpts} waypoints per leg`);

    // Leg 1: outbound shallow
    const leg1 = await groqLeg(1, outDepthMin, outDepthMax, rampLat, rampLon, null, null, nWpts, 'southwest');

    // Use last leg1 point as leg2 start
    const turnLat = leg1.length ? leg1[leg1.length-1].lat : rampLat;
    const turnLon = leg1.length ? leg1[leg1.length-1].lon : rampLon;

    // Leg 2: inbound deeper
    const leg2 = await groqLeg(2, inDepthMin, inDepthMax, turnLat, turnLon, rampLat, rampLon, nWpts, 'northeast');

    groqWaypoints = [...leg1, ...leg2];
    console.log(`[scout] Total: ${groqWaypoints.length} waypoints from Groq`);

  } catch (e) {
    console.warn('[scout] Groq waypoint generation failed:', e.message);
  }

  if (!groqWaypoints.length) {
  if (!groqWaypoints.length) {
    console.warn('[scout] No waypoints from Groq — falling back to contour walk');
    // Fallback: simple contour walk outbound only
    const fallback = walkContourForWaypoints(outDepthMin, outDepthMax, rampLat, rampLon,
      Math.min(rangeMiles, 4.0) * 5280, totalDurH * speedMph * 5280 * 0.4, 150, null);
    fallback.forEach((pt, j) => {
      state.DATA.waypoints.push({
        name: `Ph1-${j+1}`, lat: pt.lat, lon: pt.lon,
        sym: 'Fishing Area', scoutWaypoint: true, phase: 1, depth: pt.depth,
      });
    });
    renderAll();
    return fallback.length;
  }

  // Validate each waypoint against lake boundary and contour depth
  let totalAdded = 0;
  const phaseCounts = {};

  for (const wpt of groqWaypoints) {
    const lat = parseFloat(wpt.lat);
    const lon = parseFloat(wpt.lon);
    const leg = wpt.leg || 1;
    const phNum = leg <= 1 ? 1 : leg >= 2 ? 2 : leg;

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      console.warn(`[scout] Invalid coords: ${lat}, ${lon} — skipped`);
      continue;
    }

    // Hard bbox check — must be in Wateree's general area
    if (lat < 34.20 || lat > 34.55 || lon < -81.00 || lon > -80.60) {
      console.warn(`[scout] Coord (${lat.toFixed(4)},${lon.toFixed(4)}) outside Wateree bbox — skipped`);
      continue;
    }

    // Lake boundary check
    if (!isCoordInLake(lat, lon)) {
      console.warn(`[scout] Coord (${lat.toFixed(4)},${lon.toFixed(4)}) not in lake — skipped`);
      continue;
    }



    phaseCounts[phNum] = (phaseCounts[phNum] || 0) + 1;
    state.DATA.waypoints.push({
      name: `Ph${phNum}-${phaseCounts[phNum]}`,
      lat, lon,
      sym: 'Fishing Area',
      scoutWaypoint: true,
      phase: phNum,
      depth: parseFloat(wpt.depth) || null,
      note: wpt.note || '',
    });
    totalAdded++;
  }

  console.log(`[scout] ${totalAdded}/${groqWaypoints.length} waypoints passed validation`);
  renderAll();
  return totalAdded;
}

// ── Groq scout report ─────────────────────────────────────────────────────────
// Groq gets the fishing intelligence question — NOT coordinates. It tells you
// what to look for, why, and what to throw. Code handles where.

async function buildGroqScoutReport(species, lakeName, season, phases, phaseRecs, phaseInfo, rampName, waterTempF, clarity) {
  const phaseLines = phases.map((phase, i) => {
    const rec = phaseRecs[i];
    if (!rec) return '';
    const lures = getEffectiveLures(rec).slice(0, 3).join(', ');
    return `Phase ${phase.num} — ${phase.name} (${phase.startStr}–${phase.endStr}): ${rec.depthMin}-${rec.depthMax}ft, ${rec.speed}mph, lures: ${lures}. Notes: ${rec.notes || 'none'}`;
  }).filter(Boolean).join('\n');

  const sol = phaseInfo.solunar;
  function hToStr(h) {
    const hh = Math.floor(((h % 24) + 24) % 24);
    const mm = String(Math.round((h % 1) * 60)).padStart(2, '0');
    return `${hh % 12 || 12}:${mm} ${hh < 12 ? 'AM' : 'PM'}`;
  }

  const prompt = `You are an expert freshwater fishing guide for ${lakeName}, South Carolina. 
Give me a practical scout report for today's trip targeting ${species}.

Conditions:
- Season: ${season}
- Water temp: ${waterTempF ? waterTempF + '°F' : 'unknown'}
- Water clarity: ${clarity || 'unknown'}
- Launch ramp: ${rampName || 'unknown'}
- Sunrise: ${hToStr(phaseInfo.sunriseH)}
- Solunar majors: ${hToStr(sol.major1)}, ${hToStr(sol.major2)}
- Solunar minors: ${hToStr(sol.minor1)}, ${hToStr(sol.minor2)}

Phase plan:
${phaseLines}

For each phase, tell me:
1. WHAT to look for on the fishfinder and on the map (specific structure, depth transitions, bottom composition)
2. WHERE to focus relative to the ramp (what direction, what kind of water)
3. HOW to work the lures through that structure (speed variations, depth, presentation)
4. One key adjustment if fish aren't responding in the first 20 minutes

Be specific and practical. This angler is in a kayak with a pedal drive and electric motor, 2 rods max, no live bait, no downriggers — depth controlled by lead length only.
Keep it under 400 words total. Use plain language, no fluff.`;

  try {
    const res = await fetch(`${CF_WORKER_URL}/groq-query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 600,
        temperature: 0.4,
      }),
    });
    if (!res.ok) {
      console.warn('[scout] Groq HTTP failed:', res.status);
      return null;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.warn('[scout] Groq scout report failed:', e.message);
    return null;
  }
}

// ── Ramp lookup helpers (unchanged from original) ─────────────────────────────
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

// ── Apply to plan fields ──────────────────────────────────────────────────────
function applyToPlanFields(phaseRecs, phases) {
  const p1 = phaseRecs[0];
  if (!p1) return;
  const depthEl = document.getElementById('planTargetDepth');
  const speedEl = document.getElementById('planSpeed');
  if (depthEl) depthEl.value = `${p1.depthMin}-${p1.depthMax}`;
  if (speedEl) speedEl.value = String(p1.speed);
}

export function applyStoredSmartPlanDepth() {
  const routes = window._smartPlanPhaseRoutes;
  if (!routes || !routes.length) return;
  const p1 = routes.find(r => r.phase === 1);
  if (!p1) return;
  const minEl = document.getElementById('rbDepthMin');
  const maxEl = document.getElementById('rbDepthMax');
  if (minEl) minEl.value = p1.depthMin;
  if (maxEl) maxEl.value = p1.depthMax;
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

  const date = new Date(dateStr + 'T12:00:00');
  const sp = species[0];
  const regCheck = checkRegulations(lakeName, sp, date);
  if (!regCheck.legal) {
    setStatus(`⚠ ${sp} not legal: ${regCheck.reason?.slice(0, 60)}`, false);
    if (outEl) outEl.value = `REGULATION BLOCK:\n${regCheck.reason}`;
    return;
  }

  setStatus('Building scout report…', true);

  const season = getSeason(date);
  const phaseInfo = computePhases(launchTime, returnTime, dateStr, lakeName);
  const { phases } = phaseInfo;
  const rangeMiles = computeRangeMiles(speedMph);
  const phaseRecs = phases.map(p => getPhaseRecommendation(sp, lakeName, season, p.tier ?? p.num, waterTempF));

  if (phaseRecs.every(r => !r)) {
    setStatus('No behavior data for this lake/species yet', false);
    if (outEl) outEl.value = `No behavior data available for ${sp} on ${lakeName}.`;
    return;
  }

  // Build fishing context for rod selection
  const fishingContext = await buildFishingContext({
    species: sp, lakeName, season,
    clarity:    document.getElementById('planClarity')?.value || 'Clear',
    waterTempF, speedMph, dateStr, launchTime,
    rampLat: null, rampLon: null,
  });

  // Build rod spread
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

  // Clear stale smart plan tracks
  const cleared = clearExistingSmartPlanTracks();
  if (cleared) console.log(`[smart-plan] Cleared ${cleared} stale tracks`);

  // ── Ramp lookup ───────────────────────────────────────────────────────────
  let rampLat = null, rampLon = null;
  const selectedRampKey = document.getElementById('planRamp')?.value || '';
  const normalizeName = (v) => String(v || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const cleanLakeName = normalizeName(String(lakeName || '').replace(/\([^)]*\)/g, ' ').replace(/,.*$/, ''));
  const normRampKey = normalizeName(selectedRampKey);
  const rampMatches = (a, b) => { const x = normalizeName(a), y = normalizeName(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };

  try {
    const { WATEREE_RAMPS, MARION_RAMPS, MOULTRIE_RAMPS, MURRAY_RAMPS, MONTICELLO_RAMPS } = await import('./ryan-ramps.js');
    const lakeRampMap = {
      'lake wateree': WATEREE_RAMPS, 'wateree': WATEREE_RAMPS,
      'lake marion': MARION_RAMPS, 'marion': MARION_RAMPS,
      'lake moultrie': MOULTRIE_RAMPS, 'moultrie': MOULTRIE_RAMPS,
      'lake murray': MURRAY_RAMPS, 'murray': MURRAY_RAMPS,
      'lake monticello': MONTICELLO_RAMPS, 'monticello': MONTICELLO_RAMPS,
    };

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
      'wateree creek': [34.4696, -80.9139],
      'wateree creek access area': [34.4696, -80.9139],
    };

    if (normRampKey) {
      for (const [k, coords] of Object.entries(GUARANTEED_SC_RAMPS)) {
        if (rampMatches(normRampKey, k)) {
          rampLat = coords[0]; rampLon = coords[1];
          console.log(`[smart-plan] Ramp locked: "${selectedRampKey}" (${rampLat}, ${rampLon})`);
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
        }
      }
    }

    if (rampLat == null || rampLon == null) {
      const rampList = lakeRampMap[cleanLakeName]
        || Object.entries(lakeRampMap).find(([k]) => cleanLakeName.includes(k) || k.includes(cleanLakeName))?.[1]
        || [];
      const selectedRamp = rampList.find(r => rampMatches(r.key, selectedRampKey) || rampMatches(r.name, selectedRampKey)) || rampList[0];
      if (selectedRamp) { rampLat = selectedRamp.lat; rampLon = selectedRamp.lon; }
    }
  } catch (e) {
    console.warn('[smart-plan] Ramp lookup failed:', e.message);
  }

  if (rampLat == null || rampLon == null) {
    console.warn(`[smart-plan] No ramp coords for "${selectedRampKey}" — waypoints will use lake center`);
    const center = getLakeCenter(lakeName);
    rampLat = center.lat; rampLon = center.lon;
  }

  // ── Drop scout waypoints ──────────────────────────────────────────────────
  setStatus('Asking Groq for fishing spots…', true);
  const totalWaypoints = await generateScoutWaypoints(phases, phaseRecs, rampLat, rampLon, rangeMiles, speedMph, phaseInfo);

  // ── Store phase routes for depth pre-fill in route builder ───────────────
  window._smartPlanPhaseRoutes = phases.map((phase, i) => ({
    phase: phase.num,
    phaseName: phase.name,
    depthMin: phaseRecs[i]?.depthMin,
    depthMax: phaseRecs[i]?.depthMax,
    speed: phaseRecs[i]?.speed,
    window: `${phase.startStr} – ${phase.endStr}`,
  })).filter(r => r.depthMin != null);

  applyToPlanFields(phaseRecs, phases);
  applyStoredSmartPlanDepth();

  // ── Build rationale header ────────────────────────────────────────────────
  const sol = phaseInfo.solunar;
  function hToStr(h) {
    const hh = Math.floor(((h % 24) + 24) % 24);
    const mm = String(Math.round((h % 1) * 60)).padStart(2, '0');
    return `${hh % 12 || 12}:${mm} ${hh < 12 ? 'AM' : 'PM'}`;
  }

  const lines = [];
  lines.push(`${sp} — ${lakeName}, ${season}`);
  lines.push(`Sunrise: ${hToStr(phaseInfo.sunriseH)} · Solunar majors: ${hToStr(sol.major1)}, ${hToStr(sol.major2)} · minors: ${hToStr(sol.minor1)}, ${hToStr(sol.minor2)}`);
  lines.push(`Range: ${rangeMiles.toFixed(1)}mi`);
  lines.push('');

  phases.forEach((phase, i) => {
    const rec = phaseRecs[i];
    lines.push(`Phase ${phase.num} — ${phase.name} (${phase.startStr} – ${phase.endStr})`);
    if (rec) {
      lines.push(`  Depth: ${rec.depthMin}-${rec.depthMax}ft · Speed: ${rec.speed}mph`);
      lines.push(`  Lures: ${getEffectiveLures(rec).slice(0, 3).join(', ')}`);
      if (rec.notes) lines.push(`  Notes: ${rec.notes}`);
    }
    lines.push('');
  });

  if (totalWaypoints > 0) {
    lines.push(`── Scout Waypoints ──`);
    lines.push(`${totalWaypoints} waypoints dropped on map (Ph1-1 through Ph3-${Math.ceil(totalWaypoints / 3)}).`);
    lines.push(`Connect them in the Route Builder to build your track, then export to Garmin.`);
    lines.push('');
  } else {
    lines.push(`── No Waypoints ──`);
    lines.push(`No contour data loaded or no features in range. Load a contour dataset first.`);
    lines.push('');
  }

  lines.push('── Scout Report (loading…) ──');
  if (outEl) outEl.value = lines.join('\n');

  setStatus('Asking Groq for scout report…', true);

  // ── Groq scout report (non-blocking) ─────────────────────────────────────
  const clarity = document.getElementById('planClarity')?.value || 'Clear';
  buildGroqScoutReport(sp, lakeName, season, phases, phaseRecs, phaseInfo, selectedRampKey, waterTempF, clarity)
    .then(report => {
      if (report) {
        lines[lines.length - 1] = '── Scout Report ──';
        lines.push('');
        lines.push(report);
      } else {
        lines[lines.length - 1] = '── Scout Report unavailable (Groq timeout) ──';
      }
      if (outEl) outEl.value = lines.join('\n');
    });

  // ── Solunar field ─────────────────────────────────────────────────────────
  const solunarStr = `Majors: ${hToStr(sol.major1)}, ${hToStr(sol.major2)} · Minors: ${hToStr(sol.minor1)}, ${hToStr(sol.minor2)}`;
  const solunarEl = document.getElementById('planSolunar');
  if (solunarEl && !solunarEl.value) solunarEl.value = solunarStr;

  // ── Groq coach (non-blocking) ─────────────────────────────────────────────
  try {
    const coachPayload = buildGroqCoachPayload(fishingContext, {
      phases, phaseRecs,
      spread:    state.SPREAD,
      solunarStr,
      poolLevel: document.getElementById('planPoolLevel')?.value || null,
      weather:   document.getElementById('planWeather')?.value || '',
      rationale: lines.slice(0, 20).join('\n'),
      rampName:  selectedRampKey || '',
      rangeMiles,
    });
    startCoachSession(coachPayload);
  } catch (e) {
    console.warn('[smart-plan] Coach session failed:', e.message);
  }

  const wayptMsg = totalWaypoints > 0
    ? `✓ ${totalWaypoints} scout waypoints on map — connect in Route Builder`
    : '⚠ No waypoints — load contour data first';
  setStatus(wayptMsg, totalWaypoints > 0);

  return { phases, phaseRecs, phaseInfo, rangeMiles };
}

// Wire the button
setTimeout(() => {
  document.getElementById('runSmartPlanBtn')?.addEventListener('click', runSmartPlan);
}, 800);

window.runSmartPlan = runSmartPlan;
window.applyStoredSmartPlanDepth = applyStoredSmartPlanDepth;

console.log('[smart-plan] module ready — scout waypoint mode');
