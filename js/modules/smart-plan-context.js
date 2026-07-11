/**
 * smart-plan-context.js — Context builder for Smart Plan.
 *
 * Gathers all available fishing intelligence into a single rich object
 * that smart-plan.js uses for lure selection, rationale, and Groq coaching.
 *
 * Sources:
 *   - window.getMyStructures()     QuickDraw pins (docks, brush piles, etc)
 *   - state.CATCHES                Catch journal with GPS/species/depth/lure
 *   - window.getSupplementalContext() Attractors + fishing points near coord
 *   - state.MAP                    Current map bounds / lake area
 *
 * Returns a context object used by:
 *   - buildLureContext() in species-strategies.js
 *   - selectBestLure() in tackle-inventory.js
 *   - buildGroqCoachPayload() for the iterative Groq coach
 */

import { state } from '../core/state.js';
import { normalizeSpecies } from '../data/species-strategies.js';

// ── Distance helper ───────────────────────────────────────────────────────────
function distMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/**
 * Get all QuickDraw structures within radiusMi of a coordinate.
 * Returns array of { type, lat, lon, name } objects.
 */
function getNearbyStructures(lat, lon, radiusMi = 2.0) {
  try {
    const all = window.getMyStructures?.() || [];
    return all
      .filter(s => {
        const sLat = s.lat ?? s.geometry?.coordinates?.[1];
        const sLon = s.lon ?? s.geometry?.coordinates?.[0];
        if (!sLat || !sLon) return false;
        return distMi(lat, lon, sLat, sLon) <= radiusMi;
      })
      .map(s => ({
        type: s.type || s.properties?.type || 'unknown',
        lat:  s.lat ?? s.geometry?.coordinates?.[1],
        lon:  s.lon ?? s.geometry?.coordinates?.[0],
        name: s.name || s.properties?.name || '',
      }));
  } catch (_) { return []; }
}

/**
 * Get catch history for a species on a lake.
 * Returns array of recent catches with GPS, depth, lure, date.
 */
function getCatchHistory(species, lakeName, limit = 20) {
  try {
    const catches = state.CATCHES || [];
    const spKey = normalizeSpecies(species);
    return catches
      .filter(c => {
        if (!c.lat || !c.lon) return false;
        const matchSpecies = !species || normalizeSpecies(c.species || '') === spKey;
        const matchLake = !lakeName ||
          (c.lake || '').toLowerCase().includes(lakeName.toLowerCase().split(',')[0].toLowerCase());
        return matchSpecies && matchLake;
      })
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      .slice(0, limit)
      .map(c => ({
        species:  c.species,
        date:     c.date,
        time:     c.time,
        lat:      parseFloat(c.lat),
        lon:      parseFloat(c.lon),
        depth:    c.depth ? parseFloat(c.depth) : null,
        lure:     c.lure || null,
        lead:     c.lead ? parseFloat(c.lead) : null,
        length:   c.length ? parseFloat(c.length) : null,
        lake:     c.lake,
        notes:    c.notes || '',
      }));
  } catch (_) { return []; }
}

/**
 * Summarize catch history into planner-usable insights.
 */
function summarizeCatches(catches) {
  if (!catches.length) return null;

  const withDepth = catches.filter(c => c.depth);
  const avgDepth = withDepth.length
    ? Math.round(withDepth.reduce((s, c) => s + c.depth, 0) / withDepth.length)
    : null;

  const lureFreq = {};
  catches.forEach(c => {
    if (c.lure) lureFreq[c.lure] = (lureFreq[c.lure] || 0) + 1;
  });
  const topLures = Object.entries(lureFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([lure, count]) => ({ lure, count }));

  const timeFreq = {};
  catches.forEach(c => {
    if (c.time) {
      const h = parseInt(c.time.split(':')[0]);
      const slot = h < 7 ? 'dawn' : h < 10 ? 'morning' : h < 13 ? 'midday' : 'afternoon';
      timeFreq[slot] = (timeFreq[slot] || 0) + 1;
    }
  });
  const bestTime = Object.entries(timeFreq).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    totalCatches: catches.length,
    avgDepthFt:   avgDepth,
    topLures,
    bestTime,
    recentCatches: catches.slice(0, 5).map(c => ({
      date: c.date, depth: c.depth, lure: c.lure, lat: c.lat, lon: c.lon,
    })),
  };
}

/**
 * Get structure type summary for Groq context.
 */
function summarizeStructures(structures) {
  if (!structures.length) return null;
  const typeCounts = {};
  structures.forEach(s => {
    typeCounts[s.type] = (typeCounts[s.type] || 0) + 1;
  });
  return {
    total: structures.length,
    types: typeCounts,
    list: structures.slice(0, 10).map(s => `${s.type}${s.name ? ` (${s.name})` : ''}`),
  };
}

/**
 * Main context builder — call this before running Smart Plan.
 *
 * @param {object} params
 *   species    string   primary target species
 *   lakeName   string   display lake name
 *   rampLat    number
 *   rampLon    number
 *   season     string
 *   clarity    string
 *   waterTempF number
 *   speedMph   number
 *   dateStr    string
 *   launchTime string
 *
 * @returns {object} Full fishing context
 */
export async function buildFishingContext(params = {}) {
  const {
    species, lakeName, rampLat, rampLon,
    season, clarity, waterTempF, speedMph,
    dateStr, launchTime,
  } = params;

  const centerLat = rampLat || state.MAP?.getCenter()?.lat;
  const centerLon = rampLon || state.MAP?.getCenter()?.lng;

  // ── Structures ────────────────────────────────────────────────────────────
  const nearbyStructures = centerLat && centerLon
    ? getNearbyStructures(centerLat, centerLon, 3.0)
    : [];

  // Structure type keys for lure scoring
  const structureTypes = [...new Set(nearbyStructures.map(s => {
    const typeMap = {
      dock:           'dock_edge',
      brush_pile:     'brush_pile',
      riprap:         'riprap',
      timber:         'laydown',
      fish_attractor: 'brush_pile',
      point:          'point',
      cove_mouth:     'creek_mouth',
      hazard:         null,
    };
    return typeMap[s.type] || null;
  }).filter(Boolean))];

  // ── Catch history ─────────────────────────────────────────────────────────
  const catchHistory = getCatchHistory(species, lakeName);
  const catchSummary = summarizeCatches(catchHistory);

  // ── Supplemental (attractors + fishing spots) ─────────────────────────────
  let supplementalContext = { attractors: [], fishingPoints: [], pois: [] };
  if (centerLat && centerLon && window.getSupplementalContext) {
    try {
      supplementalContext = window.getSupplementalContext(centerLat, centerLon, 2.0);
    } catch (_) {}
  }

  // ── Researched Lake Intelligence (from Lake Research module) ──────────────
  let researchedProfile = null;
  let hasResearchedProfile = false;
  try {
    if (typeof window.getResearchedProfile === 'function' && lakeName) {
      researchedProfile = window.getResearchedProfile(lakeName);
      hasResearchedProfile = !!researchedProfile && (researchedProfile.metadata?.status === 'verified' || researchedProfile.metadata?.verified);
    }
  } catch {}

  // ── Clarity key ───────────────────────────────────────────────────────────
  const clarityKey = (clarity || 'Clear').toLowerCase().includes('mud') ? 'muddy'
    : (clarity || 'Clear').toLowerCase().includes('stain') ? 'stained'
    : 'clear';

  return {
    // Core fishing params
    species:          normalizeSpecies(species),
    speciesDisplay:   species,
    lakeName,
    season,
    clarity,
    clarityKey,
    waterTempF,
    speedMph,
    dateStr,
    launchTime,

    // Location
    rampLat,
    rampLon,
    centerLat,
    centerLon,

    // Structure intelligence
    nearbyStructures,
    structureTypes,
    structureSummary: summarizeStructures(nearbyStructures),

    // Catch history
    catchHistory,
    catchSummary,

    // Supplemental (i-Boating crowdsourced)
    nearbyAttractors:    supplementalContext.attractors,
    nearbyFishingSpots:  supplementalContext.fishingPoints,
    attractorCount:      supplementalContext.attractors.length,
    fishingSpotCount:    supplementalContext.fishingPoints.length,

    // Lake Research — permanent intelligence
    researchedProfile,
    hasResearchedProfile,
    researchedTrolling: researchedProfile?.trollingIntelligence || researchedProfile?.trolling || null,
    researchedSummary: researchedProfile?.summary?.text || researchedProfile?.summary || null,
  };
}

/**
 * Build the Groq coach payload from the fishing context + current plan state.
 * This is the rich payload sent to /coach-plan for iterative suggestions.
 */
export function buildGroqCoachPayload(fishingContext, planState) {
  const {
    species, speciesDisplay, lakeName, season, clarity, waterTempF,
    catchSummary, structureSummary, attractorCount, fishingSpotCount,
    nearbyStructures, nearbyAttractors,
  } = fishingContext;

  const {
    phases, phaseRecs, spread, solunarStr, poolLevel,
    weather, rationale, rampName, rangeMiles,
    speed, phaseSpeeds, speedRationale,
  } = planState;

  return {
    // Angler profile
    anglerProfile: {
      gear:        'Native Watersports Slayer Propel Max 12.5, NK180 bow-mount trolling motor',
      rodSetup:    'Spinning rods only, 30lb 8-strand braid + 20lb fluoro leader',
      noLiveBait:  true,
      maxRods:     2,
    },
    // Conditions
    conditions: {
      lake:      lakeName,
      species:   speciesDisplay,
      season,
      date:      fishingContext.dateStr,
      waterTemp: waterTempF ? `${waterTempF}°F` : null,
      clarity,
      weather,
      poolLevel,
      solunar:   solunarStr,
    },

        // Plan phases
    phases: phases?.map((phase, i) => {
      const rec = phaseRecs?.[i];
      
      // Look for rods assigned to this phase's route (e.g., 'Ph1 Outbound')
      const phaseRods = spread?.filter(r => r.route?.startsWith(`Ph${phase.num}`)) || [];
      const portRod = phaseRods.find(r => r.side === 'Port');
      const stbdRod = phaseRods.find(r => r.side === 'Starboard');

      return {
        name:     phase.name,
        window:   `${phase.startStr}–${phase.endStr}`,
        depthMin: rec?.depthMin,
        depthMax: rec?.depthMax,
        speed:    rec?.speed,
        port: portRod ? {
          lure:  portRod.lure,
          color: portRod.color,
          lead:  portRod.lead,
          depth: portRod.depth,
          confidence: portRod._scoreResult?.confidence,
          reasons:    portRod._scoreResult?.reasons?.slice(0,3),
          warnings:   portRod._scoreResult?.warnings,
        } : null,
        starboard: stbdRod ? {
          lure:  stbdRod.lure,
          color: stbdRod.color,
          lead:  stbdRod.lead,
          depth: stbdRod.depth,
          confidence: stbdRod._scoreResult?.confidence,
          reasons:    stbdRod._scoreResult?.reasons?.slice(0,3),
          warnings:   stbdRod._scoreResult?.warnings,
        } : null,
      };
    }) || [],


    // Fishing intelligence
    intelligence: {
      catchHistory: catchSummary ? {
        totalCatches:  catchSummary.totalCatches,
        avgDepthFt:    catchSummary.avgDepthFt,
        topLures:      catchSummary.topLures,
        bestTime:      catchSummary.bestTime,
        recentCatches: catchSummary.recentCatches,
      } : null,
      nearbyStructure: structureSummary,
      attractors: attractorCount > 0 ? {
        count: attractorCount,
        sample: nearbyAttractors.slice(0,5).map(a => a.name || 'attractor'),
      } : null,
      communityFishingSpots: fishingSpotCount > 0 ? {
        count: fishingSpotCount,
        note: `${fishingSpotCount} community-marked fishing spots within 2mi of ramp`,
      } : null,
      researchedProfile: fishingContext.researchedProfile ? {
        exists: true,
        lakeName: fishingContext.researchedProfile.lakeName,
        version: fishingContext.researchedProfile.metadata?.version,
        status: fishingContext.researchedProfile.metadata?.status,
        overallConfidence: fishingContext.researchedProfile.confidence?.overall,
        summary: typeof fishingContext.researchedProfile.summary === 'string' ? fishingContext.researchedProfile.summary : fishingContext.researchedProfile.summary?.text,
        trollingIntelligence: fishingContext.researchedProfile.trollingIntelligence || fishingContext.researchedProfile.trolling,
        limnology: fishingContext.researchedProfile.limnology,
        habitat: fishingContext.researchedProfile.habitat,
      } : null,
    },

    // Route summary
    route: {
      ramp:       rampName,
      rangeMiles: rangeMiles,
      phases:     phases?.length || 3,
    },

    // What the coach is allowed to modify
    allowedModifications: [
      'lure', 'lure_size', 'lure_color', 'lead_length',
      'trolling_speed', 'target_depth', 'phase_timing',
      'rod_assignment', 'inline_weight', 'route_pattern',
      'casting_stop_suggestion',
    ],

  // What the coach must never touch
    forbiddenModifications: [
      'species', 'lake', 'launch_ramp', 'weather',
      'safety_limits', 'battery_limits', 'gear_not_owned',
      'live_bait', 'conventional_reels',
    ],

    // Full rod spread — route, side, lure, color, depth, lead for every rod slot
    // This is what the chat coach reads to answer specific rig questions
    spread: spread || [],

    // Speed decision metadata — each band is a distinct out-and-back pass.
    planMeta: {
      source:         'groq_smart_plan',
      speed:          speed || null,
      phaseSpeeds:    phaseSpeeds || null,
      speedRationale: speedRationale || null,
      note: phaseSpeeds
        ? `Use the applied per-pass speeds: Band 1 ${phaseSpeeds.band1}mph and Band 2 ${phaseSpeeds.band2}mph. Each is capped by the two lures in that pass; do not suggest exceeding either cap.`
        : (speedRationale
          ? `Speed was set to ${speed}mph by the primary AI guide: "${speedRationale}". Do not suggest changing speed unless there is a compelling safety or species-behavior reason that directly overrides this.`
          : null),
    },
  };
}
