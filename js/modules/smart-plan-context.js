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
import { distMiFromCoords as distMi } from '../utils/geo.js';
import { normalizeSpecies } from '../data/species-strategies.js';

import { callGlobal } from '../utils/call-global.js';
// distMi now from utils/geo.js (canonical)

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
function getCatchHistory(species, lakeName, limit = 20, season = null) {
  const SEASON_MONTHS = {
    spring: [3, 4, 5],
    summer: [6, 7, 8],
    fall:   [9, 10, 11],
    winter: [12, 1, 2],
  };
  const seasonMonths = season ? (SEASON_MONTHS[season] || null) : null;

  try {
    const catches = state.CATCHES || [];
    const spKey = normalizeSpecies(species);
    return catches
      .filter(c => {
        if (!c.lat || !c.lon) return false;
        const matchSpecies = !species || normalizeSpecies(c.species || '') === spKey;
        const matchLake = !lakeName ||
          (c.lake || '').toLowerCase().includes(lakeName.toLowerCase().split(',')[0].toLowerCase());
        if (!matchSpecies || !matchLake) return false;
        // Filter by season if specified
        if (seasonMonths && c.date) {
          const month = new Date(c.date).getMonth() + 1;
          if (!seasonMonths.includes(month)) return false;
        }
        return true;
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
  const catchHistory = getCatchHistory(species, lakeName, 20, season);
  const catchSummary = summarizeCatches(catchHistory);

  // ── Supplemental (attractors + fishing spots) ─────────────────────────────
  let supplementalContext = { attractors: [], fishingPoints: [], pois: [], structures: [], docks: [] };
  if (centerLat && centerLon) {
    // The `if (window.getSupplementalContext)` guard that used to wrap this handled ABSENCE
    // correctly -- callGlobal keeps that behaviour. What neither handled was the function
    // existing and throwing: the plan then built with the empty default above and looked
    // exactly like a plan for a lake that genuinely has no supplemental data.
    supplementalContext = callGlobal('getSupplementalContext', centerLat, centerLon, 2.0)
      || supplementalContext;
  }

  // ── Charted structure, from the Garmin chartpack ──────────────────────────
  //
  // The research profile says WHAT matters for a species -- habitat.dockDensity,
  // standingTimber, timberFields, namedCreekMouths, shallowFlatAreas. This says WHERE it
  // actually is, measured off the chart. The two are the halves of one answer, and neither is
  // useful alone: knowing largemouth hold on docks is worthless without the docklines, and 287
  // dock clusters mean nothing without knowing the angler is after catfish today.
  //
  // NOTHING IS SCORED OR FILTERED HERE, deliberately. Which structure a species wants is
  // knowledge that belongs in the research profile where Ryan can correct it, not a constant
  // baked into a planner. Hand the model the full inventory and its own research, and let it
  // choose: catfish and live bait means route the bridge pilings, largemouth means work the
  // dock line, crappie means the brush piles.
  const chartedStructure = (() => {
    const byType = {};
    let n = 0;
    for (const st of (supplementalContext.structures || [])) {
      const t = st.poi_type || 'unknown';
      // STABLE ID PER ENTRY. The model picks by id and we resolve the position from this table;
      // it never supplies a coordinate itself. A language model asked for a lat/lon will happily
      // produce a plausible one, and a waypoint invented 200 m inland is worse than no waypoint
      // -- it looks exactly like a real one on the map.
      (byType[t] = byType[t] || []).push({
        id: `st_${t}_${n++}`, lat: st.lat, lon: st.lon, name: st.name || null,
      });
    }
    const counts = {};
    for (const [t, v] of Object.entries(byType)) counts[t] = v.length;
    const docks = (supplementalContext.docks || []).map((c, i) => ({ id: `dk_${i}`, ...c }));
    return {
      counts,
      // Nearest handful per type. A model cannot plan against hundreds of coordinates, and the
      // count already carries "there is a lot of this here".
      byType: Object.fromEntries(Object.entries(byType).map(([t, v]) => [t, v.slice(0, 12)])),
      // Docks arrive as CLUSTERS, not 2,839 polygons. `run_m` is what tells a long shoreline
      // dockline apart from a tight pocket worth stopping on.
      dockClusters: docks.slice(0, 12),
      dockClusterCount: docks.length,
      dockTotal: docks.reduce((a, c) => a + (c.count || 0), 0),
      source: 'Garmin LakeVu chart decode',
    };
  })();

  // Flat id -> position lookup, so an accepted suggestion resolves against OUR data.
  const chartedStructureIndex = {};
  for (const v of Object.values(chartedStructure.byType)) {
    for (const e of v) chartedStructureIndex[e.id] = e;
  }
  for (const c of chartedStructure.dockClusters) chartedStructureIndex[c.id] = c;

  const chartedStructureSummary = (() => {
    const bits = [];
    const d = chartedStructure.dockClusters;
    if (d.length) {
      const lines = d.filter(c => c.run_m > 600).length;
      const pockets = d.filter(c => c.run_m <= 600 && c.count >= 8).length;
      bits.push(`${chartedStructure.dockTotal} charted docks in ${chartedStructure.dockClusterCount} clusters`
              + (lines ? `, ${lines} long docklines` : '')
              + (pockets ? `, ${pockets} tight pockets` : ''));
    }
    for (const [t, n] of Object.entries(chartedStructure.counts)) {
      bits.push(`${n} ${t.replace(/_/g, ' ')}`);
    }
    return bits.length ? bits.join('; ') : null;
  })();

  // ── Researched Lake Intelligence (from Lake Research module) ──────────────
  let researchedProfile = null;
  let hasResearchedProfile = false;
  // A profile that throws on load is not the same as a lake with no profile, and producing
  // these is what the whole research pipeline is for. Absence stays silent; a failure does not.
  if (lakeName) {
    researchedProfile = callGlobal('getResearchedProfile', lakeName);
    hasResearchedProfile = !!researchedProfile
      && (researchedProfile.metadata?.status === 'verified' || researchedProfile.metadata?.verified);
  }

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

    // Charted structure (Garmin) — inventory only, unscored. See the comment above.
    chartedStructure,
    chartedStructureSummary,
    chartedStructureIndex,

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
    chartedStructure, chartedStructureSummary,
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

    // Charted structure actually present on this water, from the Garmin chart decode.
    // Paired with the researched habitat profile below, this is what lets the model pick
    // structure BY SPECIES rather than by a hardcoded score: bridge pilings for catfish,
    // docklines for largemouth, brush piles for crappie. Unfiltered on purpose -- the model
    // needs the alternatives to fall back on when the primary pattern is dead.
    chartedStructure: chartedStructure ? {
      summary:      chartedStructureSummary,
      counts:       chartedStructure.counts,
      byType:       chartedStructure.byType,
      dockClusters: chartedStructure.dockClusters,
      note: 'Positions decoded from the Garmin LakeVu chart. dockClusters carry `count`, '
          + '`run_m` and `bearing`: a long run is a shoreline to troll, a short run with a '
          + 'high count is a pocket to stop and work. Choose structure using the researched '
          + 'habitat and species profile; do not assume every type suits the target species. '
          + 'To place a casting stop on one of these, return its `id` as `structure_id` in the '
          + 'suggestion and DO NOT invent lat/lon — the app resolves the position from the id.',
    } : null,

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

    // Stop candidates — nearby structures that the coach can suggest as casting stops
    // Convert nearby structures to the format the coach expects
    stopCandidates: nearbyStructures?.length > 0 ? nearbyStructures.map(s => ({
      type: s.type,
      name: s.name || s.type,
      lat: s.lat,
      lon: s.lon,
      description: `${s.type}${s.name ? ` (${s.name})` : ''}`,
    })) : [],

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
