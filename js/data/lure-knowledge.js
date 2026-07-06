/**
 * lure-knowledge.js — Lure behavior profiles and scoring engine.
 *
 * Strict boundaries:
 *   ✅ Physical depth limits (hard filter — what the lure can actually reach)
 *   ✅ Tactical depth suitability (scored — what depth is ideal for this lure)
 *   ✅ Species effectiveness scores
 *   ✅ Seasonal effectiveness scores
 *   ✅ Clarity effectiveness scores
 *   ✅ Speed range and ideal
 *   ✅ Preferred structure types
 *   ✅ Color recommendations
 *   ✅ Jighead selection logic
 *   ❌ No species behavioral strategy
 *   ❌ No route logic
 *   ❌ No planner orchestration
 *   ❌ No inventory management
 *
 * Physical depth = hard filter (crankbaits, true topwaters only)
 * Tactical depth = scoring factor (everything else)
 */

export const LURE_KNOWLEDGE = {

  // ── Crankbaits — PHYSICAL depth limits apply ──────────────────────────────

  crankbait_squarebill: {
    label: 'Squarebill Crankbait',
    physicalDepth: { min: 2, max: 5 },   // hard limit — bill design
    tacticalDepth: { ideal: 3 },
    species:   { striped_bass:5, largemouth_bass:9, smallmouth_bass:7, crappie:1, bowfin:5, catfish:1 },
    season:    { spring:10, summer:6, fall:8, winter:3 },
    clarity:   { clear:7, stained:9, muddy:6 },
    structure: ['riprap','dock','laydown','shallow_flat','creek_arm','point'],
    speed:     { min:1.8, ideal:2.4, max:3.2 },
    technique: 'Deflects off wood and rock — slow roll over shallow cover',
  },

  crankbait_sr: {
    label: 'SR Crankbait (Shallow Runner)',
    physicalDepth: { min:3, max:5 },
    tacticalDepth: { ideal:4 },
    species:   { striped_bass:5, largemouth_bass:8, smallmouth_bass:7, crappie:2, bowfin:4, catfish:1 },
    season:    { spring:9, summer:5, fall:8, winter:3 },
    clarity:   { clear:8, stained:7, muddy:4 },
    structure: ['point','flat','dock_edge','creek_mouth','riprap'],
    speed:     { min:2.0, ideal:2.5, max:3.5 },
    technique: 'Shallow flat runner — points and creek mouths at dawn',
  },

  crankbait_mr: {
    label: 'MR Crankbait (Medium Runner)',
    physicalDepth: { min:6, max:12 },
    tacticalDepth: { ideal:9 },
    species:   { striped_bass:7, largemouth_bass:9, smallmouth_bass:8, crappie:2, bowfin:3, catfish:1 },
    season:    { spring:9, summer:7, fall:9, winter:5 },
    clarity:   { clear:8, stained:8, muddy:5 },
    structure: ['ledge_edge','secondary_point','hump_top','channel_swing','flat'],
    speed:     { min:1.8, ideal:2.4, max:3.2 },
    technique: 'Mid-range ledge runner — secondary points and hump tops',
  },

  crankbait_dd1: {
    label: 'DD1 Deep Diver (14-18ft)',
    physicalDepth: { min:14, max:18 },
    tacticalDepth: { ideal:16 },
    species:   { striped_bass:8, largemouth_bass:9, smallmouth_bass:8, crappie:1, bowfin:2, catfish:1 },
    season:    { spring:7, summer:9, fall:8, winter:6 },
    clarity:   { clear:9, stained:7, muddy:3 },
    structure: ['channel_ledge','main_lake_point','hump','channel_swing'],
    speed:     { min:1.6, ideal:2.2, max:2.8 },
    technique: 'Primary ledge crankbait — run on channel swing drop-offs',
  },

  crankbait_dd2: {
    label: 'DD2 Deep Diver (16-20ft)',
    physicalDepth: { min:16, max:20 },
    tacticalDepth: { ideal:18 },
    species:   { striped_bass:9, largemouth_bass:8, smallmouth_bass:7, crappie:1, bowfin:1, catfish:1 },
    season:    { spring:6, summer:10, fall:8, winter:6 },
    clarity:   { clear:9, stained:6, muddy:2 },
    structure: ['channel_ledge','main_lake_point','hump','thermocline_zone'],
    speed:     { min:1.5, ideal:2.0, max:2.6 },
    technique: 'Deep ledge and thermocline zone — summer striper primary',
  },

  crankbait_dd3: {
    label: 'DD3 Deep Diver (20-25ft)',
    physicalDepth: { min:20, max:25 },
    tacticalDepth: { ideal:22 },
    species:   { striped_bass:9, largemouth_bass:6, smallmouth_bass:5, crappie:1, bowfin:1, catfish:1 },
    season:    { spring:5, summer:10, fall:7, winter:5 },
    clarity:   { clear:10, stained:5, muddy:1 },
    structure: ['deep_channel','hump_edge','dam_face','thermocline_zone'],
    speed:     { min:1.4, ideal:1.8, max:2.4 },
    technique: 'Deep channel and hump edges — thermocline bottom in peak summer',
  },

  crankbait_dd4: {
    label: 'DD4 Deep Diver (25ft+)',
    physicalDepth: { min:25, max:35 },
    tacticalDepth: { ideal:28 },
    species:   { striped_bass:8, largemouth_bass:4, smallmouth_bass:3, crappie:1, bowfin:1, catfish:1 },
    season:    { spring:4, summer:9, fall:6, winter:5 },
    clarity:   { clear:10, stained:4, muddy:1 },
    structure: ['deep_channel','dam_face','main_lake_point_deep'],
    speed:     { min:1.3, ideal:1.6, max:2.0 },
    technique: 'Deepest available — dam face and thermocline bottom in peak summer',
  },

  // ── Variable-depth lures — NO physical depth limit, tactical scoring only ─

  lipless: {
    label: 'Lipless Crankbait',
    physicalDepth: null,  // variable by speed + lead
    tacticalDepth: { ideal:6 },
    species:   { striped_bass:6, largemouth_bass:8, smallmouth_bass:7, crappie:4, bowfin:5, catfish:1 },
    season:    { spring:9, summer:6, fall:9, winter:8 },
    clarity:   { clear:7, stained:9, muddy:7 },
    structure: ['grass_edge','flat','point','channel_swing','dock_edge'],
    speed:     { min:1.6, ideal:2.2, max:3.0 },
    technique: 'Vibration/rattle — depth by lead and speed — excellent cold/stained water',
  },

  blade_vibe: {
    label: 'Blade Vibe Bait',
    physicalDepth: null,
    tacticalDepth: { ideal:5 },
    species:   { striped_bass:5, largemouth_bass:7, smallmouth_bass:8, crappie:6, bowfin:4, catfish:1 },
    season:    { spring:8, summer:5, fall:9, winter:9 },
    clarity:   { clear:6, stained:9, muddy:8 },
    structure: ['flat','point','grass_edge','riprap'],
    speed:     { min:1.4, ideal:1.8, max:2.4 },
    technique: 'Maximum vibration — stained/cold water — variable depth by lead',
  },

  umbrella_rig: {
    label: 'A-Rig / Umbrella Rig',
    physicalDepth: null,
    tacticalDepth: { ideal:16 },
    species:   { striped_bass:10, largemouth_bass:7, smallmouth_bass:6, crappie:1, bowfin:3, catfish:1 },
    season:    { spring:8, summer:10, fall:9, winter:6 },
    clarity:   { clear:9, stained:8, muddy:5 },
    structure: ['open_water','channel','suspended_bait','main_lake_point','thermocline_zone'],
    speed:     { min:1.4, ideal:1.8, max:2.4 },
    technique: 'Schooling bait mimic — most effective open-water striper presentation',
  },

  swimbait_paddle: {
    label: 'Paddle Tail Swimbait',
    physicalDepth: null,
    tacticalDepth: { ideal:14 },
    species:   { striped_bass:8, largemouth_bass:8, smallmouth_bass:7, crappie:5, bowfin:6, catfish:2 },
    season:    { spring:8, summer:9, fall:8, winter:5 },
    clarity:   { clear:9, stained:7, muddy:4 },
    structure: ['open_water','channel','suspended_bait','point','flat'],
    speed:     { min:1.4, ideal:1.8, max:2.4 },
    technique: 'Natural baitfish profile — depth via jighead weight and lead',
  },

  flutter_spoon: {
    label: 'Flutter Spoon',
    physicalDepth: null,
    tacticalDepth: { ideal:20 },
    species:   { striped_bass:10, largemouth_bass:6, smallmouth_bass:5, crappie:3, bowfin:4, catfish:1 },
    season:    { spring:7, summer:10, fall:9, winter:7 },
    clarity:   { clear:10, stained:7, muddy:3 },
    structure: ['channel','suspended_bait','thermocline_zone','dam_face','main_lake_point'],
    speed:     { min:1.3, ideal:1.7, max:2.2 },
    technique: 'Flash + flutter at slow troll — primary deep striper presentation in clear water',
  },

  spinnerbait: {
    label: 'Spinnerbait',
    physicalDepth: null,
    tacticalDepth: { ideal:5 },
    species:   { striped_bass:4, largemouth_bass:9, smallmouth_bass:7, crappie:3, bowfin:6, catfish:1 },
    season:    { spring:10, summer:6, fall:8, winter:3 },
    clarity:   { clear:6, stained:10, muddy:8 },
    structure: ['dock_edge','point','flat','riprap','laydown','creek_arm'],
    speed:     { min:1.4, ideal:2.0, max:2.8 },
    technique: 'Vibration and flash — stained water specialist — slow-roll near cover',
  },

  chatterbait: {
    label: 'Chatterbait',
    physicalDepth: null,
    tacticalDepth: { ideal:4 },
    species:   { striped_bass:3, largemouth_bass:9, smallmouth_bass:7, crappie:2, bowfin:7, catfish:1 },
    season:    { spring:10, summer:6, fall:8, winter:4 },
    clarity:   { clear:5, stained:10, muddy:8 },
    structure: ['grass_edge','dock_edge','laydown','flat','creek_arm'],
    speed:     { min:1.4, ideal:2.0, max:2.8 },
    technique: 'Maximum vibration/flash — stained water bass — vegetation edges',
  },

  bucktail: {
    label: 'Bucktail Jig',
    physicalDepth: null,
    tacticalDepth: { ideal:18 },
    species:   { striped_bass:9, largemouth_bass:6, smallmouth_bass:7, crappie:4, bowfin:5, catfish:2 },
    season:    { spring:8, summer:9, fall:9, winter:7 },
    clarity:   { clear:8, stained:7, muddy:5 },
    structure: ['channel','open_water','suspended_bait','dam_face','current_seam'],
    speed:     { min:1.3, ideal:1.7, max:2.2 },
    technique: 'Pulsing hair action — classic striper slow-troll — depth by lead',
  },

  marabou_jig: {
    label: 'Marabou Jig',
    physicalDepth: null,
    tacticalDepth: { ideal:10 },
    species:   { striped_bass:6, largemouth_bass:6, smallmouth_bass:6, crappie:9, bowfin:5, catfish:3 },
    season:    { spring:9, summer:7, fall:8, winter:8 },
    clarity:   { clear:8, stained:7, muddy:5 },
    structure: ['brush_pile','dock','channel_edge','flat','point'],
    speed:     { min:1.2, ideal:1.6, max:2.0 },
    technique: 'Pulsing soft action — crappie and bass — slow troll near structure',
  },

  road_runner: {
    label: 'Road Runner / Beetle Spin',
    physicalDepth: null,
    tacticalDepth: { ideal:4 },
    species:   { striped_bass:4, largemouth_bass:7, smallmouth_bass:7, crappie:8, bowfin:9, catfish:4 },
    season:    { spring:9, summer:8, fall:8, winter:6 },
    clarity:   { clear:7, stained:8, muddy:7 },
    structure: ['dock_edge','laydown','creek_arm','flat','brush_pile'],
    speed:     { min:1.2, ideal:1.6, max:2.2 },
    technique: 'Spinner + soft plastic trailer — bowfin and bass in shallow cover',
  },

  jighead: {
    label: 'Jighead (bare or with swimbait)',
    physicalDepth: null,
    tacticalDepth: { ideal:12 },
    species:   { striped_bass:7, largemouth_bass:7, smallmouth_bass:6, crappie:7, bowfin:5, catfish:2 },
    season:    { spring:7, summer:8, fall:7, winter:6 },
    clarity:   { clear:8, stained:7, muddy:5 },
    structure: ['open_water','channel','point','flat','brush_pile'],
    speed:     { min:1.2, ideal:1.7, max:2.2 },
    technique: 'Depth controlled by head weight and lead — versatile year-round',
  },

  // ── Topwater — PHYSICAL depth limit (surface only) ────────────────────────

  topwater_troll: {
    label: 'Topwater (Trollable)',
    physicalDepth: { min:0, max:1 },  // surface lures — hard limit
    tacticalDepth: { ideal:0 },
    species:   { striped_bass:8, largemouth_bass:9, smallmouth_bass:7, crappie:1, bowfin:6, catfish:1 },
    season:    { spring:8, summer:9, fall:8, winter:2 },
    clarity:   { clear:9, stained:7, muddy:4 },
    structure: ['open_water','flat','point','creek_mouth','dock_edge'],
    speed:     { min:1.2, ideal:1.6, max:2.0 },
    technique: 'Surface troll at dawn — schooling striper and largemouth — slow retrieve',
  },

  topwater_cast: {
    label: 'Topwater (Cast Only)',
    physicalDepth: { min:0, max:0 },
    tacticalDepth: { ideal:0 },
    species:   { striped_bass:5, largemouth_bass:10, smallmouth_bass:7, crappie:1, bowfin:7, catfish:1 },
    season:    { spring:9, summer:8, fall:8, winter:1 },
    clarity:   { clear:8, stained:7, muddy:5 },
    structure: ['grass_mat','lily_pad','dock','shallow_flat','creek_arm'],
    speed:     null,  // cast only
    technique: 'Cast only — suggest as casting stop near shallow cover',
  },

  cast_only: {
    label: 'Cast Only (Soft Plastics)',
    physicalDepth: null,
    tacticalDepth: { ideal:6 },
    species:   { striped_bass:3, largemouth_bass:10, smallmouth_bass:8, crappie:5, bowfin:6, catfish:3 },
    season:    { spring:9, summer:7, fall:8, winter:6 },
    clarity:   { clear:8, stained:7, muddy:6 },
    structure: ['dock','laydown','grass','brush_pile','rock'],
    speed:     null,
    technique: 'Cast only — suggest as casting stop at structure',
  },
};

// ── Scoring engine ────────────────────────────────────────────────────────────

/**
 * Score a lure type for a given fishing context.
 *
 * Returns a rich result object:
 * {
 *   score:        number (higher = better)
 *   confidence:   0.0–1.0
 *   reasons:      string[]   (positive factors)
 *   warnings:     string[]   (cautions)
 *   disqualifiers: string[]  (hard fails — score = -999)
 * }
 *
 * context = {
 *   species:       'striped_bass',
 *   season:        'summer',
 *   clarity:       'Clear',
 *   clarityKey:    'clear',
 *   targetDepthFt: 18,
 *   depthMin:      15,
 *   depthMax:      21,
 *   speedMph:      1.8,
 *   structure:     ['channel', 'thermocline_zone'],
 *   preferredTypes: ['umbrella_rig', 'flutter_spoon', ...],  // from species-strategies
 * }
 */
export function scoreLureForContext(lureType, context = {}) {
  const knowledge = LURE_KNOWLEDGE[lureType];
  if (!knowledge) return { score:-999, confidence:0, reasons:[], warnings:[], disqualifiers:[`Unknown lure type: ${lureType}`] };

  const {
    species, season, clarityKey, targetDepthFt,
    depthMin, depthMax, speedMph, structure, preferredTypes,
  } = context;

  let score = 0;
  const reasons       = [];
  const warnings      = [];
  const disqualifiers = [];

  // ── 1. Physical depth hard gate (crankbaits + topwater only) ─────────────
  if (knowledge.physicalDepth !== null && targetDepthFt !== undefined) {
    const pd = knowledge.physicalDepth;
    if (targetDepthFt < pd.min || targetDepthFt > pd.max) {
      const msg = `Cannot physically reach ${targetDepthFt}ft (range: ${pd.min}–${pd.max}ft)`;
      disqualifiers.push(msg);
      return { score:-999, confidence:0, reasons:[], warnings:[], disqualifiers:[msg] };
    }
    // Check if near physical limit
    if (targetDepthFt > pd.max * 0.9) {
      warnings.push(`Running near maximum physical depth (${pd.max}ft)`);
    }
    reasons.push(`Reaches target depth (${pd.min}–${pd.max}ft range)`);
  }

  // ── 2. Species effectiveness (0-10, weight: 3×) ───────────────────────────
  const speciesScore = knowledge.species?.[species] ?? 5;
  score += speciesScore * 3;
  if (speciesScore >= 8) reasons.push(`Highly effective for ${species.replace(/_/g,' ')}`);
  else if (speciesScore <= 3) warnings.push(`Low effectiveness for ${species.replace(/_/g,' ')}`);

  // ── 3. Season match (0-10, weight: 1.5×) ─────────────────────────────────
  const seasonScore = knowledge.season?.[season] ?? 5;
  score += seasonScore * 1.5;
  if (seasonScore >= 8) reasons.push(`Strong ${season} presentation`);
  else if (seasonScore <= 4) warnings.push(`Below-average ${season} effectiveness`);

  // ── 4. Clarity match (0-10, weight: 1×) ──────────────────────────────────
  const clarityScore = knowledge.clarity?.[clarityKey] ?? 5;
  score += clarityScore;
  if (clarityScore >= 8) reasons.push(`Excellent choice for ${clarityKey} water`);
  else if (clarityScore <= 4) warnings.push(`Less effective in ${clarityKey} water`);

  // ── 5. Tactical depth suitability (variable-depth lures only) ────────────
  if (knowledge.physicalDepth === null && knowledge.tacticalDepth && targetDepthFt !== undefined) {
    const ideal = knowledge.tacticalDepth.ideal;
    const delta = Math.abs(ideal - targetDepthFt);
    const depthScore = Math.max(0, 10 - delta * 0.8);
    score += depthScore;
    if (delta <= 4)  reasons.push(`Good tactical depth match (ideal: ${ideal}ft)`);
    if (delta > 10)  warnings.push(`Far from ideal depth — adjust lead/weight`);
  }

  // ── 6. Preferred type priority (from species-strategies) (weight: 2×) ────
  if (preferredTypes?.length) {
    const typeIdx = preferredTypes.indexOf(lureType);
    if (typeIdx === 0)      { score += 20; reasons.push('Top priority presentation for these conditions'); }
    else if (typeIdx === 1) { score += 15; reasons.push('Second priority presentation'); }
    else if (typeIdx === 2) { score += 10; reasons.push('Third priority presentation'); }
    else if (typeIdx > 2)   { score += Math.max(0, 8 - typeIdx); }
    else                    { score += 2; } // not in preferred list but not penalized
  }

  // ── 7. Speed match (weight: 1×) ──────────────────────────────────────────
  if (speedMph && knowledge.speed) {
    const spd = knowledge.speed;
    if (speedMph >= spd.min && speedMph <= spd.max) {
      const speedScore = Math.max(0, 5 - Math.abs(speedMph - spd.ideal) * 2);
      score += speedScore;
      if (Math.abs(speedMph - spd.ideal) <= 0.2) reasons.push(`Ideal trolling speed match (${spd.ideal}mph)`);
    } else {
      score -= 5;
      warnings.push(`Outside recommended speed range (${spd.min}–${spd.max}mph)`);
    }
  }

  // ── 8. Structure match (0-6 bonus) ────────────────────────────────────────
  if (structure?.length && knowledge.structure?.length) {
    const matches = structure.filter(s => knowledge.structure.includes(s));
    if (matches.length > 0) {
      score += Math.min(6, matches.length * 2);
      reasons.push(`Structure match: ${matches.slice(0,2).join(', ')}`);
    }
  }

  // ── Confidence — based on score spread and data quality ───────────────────
  // Normalized 0–1 from score range of roughly 0–80
  const confidence = Math.min(0.97, Math.max(0.30, score / 75));

  return { score, confidence: Math.round(confidence * 100) / 100, reasons, warnings, disqualifiers };
}

// ── Color recommendations ─────────────────────────────────────────────────────

export function getLureColor(lureType, clarityKey) {
  const c = clarityKey || 'clear';
  const colorMap = {
    umbrella_rig:         { clear:'Blueback Herring',       stained:'Chartreuse / White UV', muddy:'Dark Shad / Black' },
    crankbait_squarebill: { clear:'Natural Shad',           stained:'Chartreuse Shad',       muddy:'Black/Blue Shad' },
    crankbait_sr:         { clear:'Blue / Silver Herring',  stained:'Chartreuse Shad',       muddy:'Black/Blue Shad' },
    crankbait_mr:         { clear:'Blue / Silver Herring',  stained:'Chartreuse Shad',       muddy:'Black/Blue Shad' },
    crankbait_dd1:        { clear:'Sexy Shad',              stained:'Firetiger',             muddy:'Black/Blue Shad' },
    crankbait_dd2:        { clear:'Sexy Shad',              stained:'Firetiger',             muddy:'Black/Blue Shad' },
    crankbait_dd3:        { clear:'Tennessee Shad',         stained:'Chartreuse / Orange',   muddy:'Dark Crawdad' },
    crankbait_dd4:        { clear:'Tennessee Shad',         stained:'Chartreuse / Orange',   muddy:'Dark Crawdad' },
    lipless:              { clear:'Chrome / Silver',        stained:'Gold / Copper',         muddy:'Black/Blue' },
    blade_vibe:           { clear:'Chrome / Silver',        stained:'Gold / Copper',         muddy:'Black Nickel' },
    flutter_spoon:        { clear:'Shattered Glass Silver', stained:'Chartreuse Gold',       muddy:'Black Nickel' },
    swimbait_paddle:      { clear:'Blueback Herring',       stained:'Chartreuse / White',    muddy:'Black/Blue Shad' },
    spinnerbait:          { clear:'White / Nickel',         stained:'Chartreuse / White',    muddy:'Black / Blue' },
    chatterbait:          { clear:'Natural Shad',           stained:'Chartreuse / White',    muddy:'Black / Blue' },
    bucktail:             { clear:'White / Natural',        stained:'Chartreuse / White',    muddy:'Black / Dark' },
    marabou_jig:          { clear:'White / Natural',        stained:'Chartreuse / White',    muddy:'Black / Dark' },
    road_runner:          { clear:'White / Nickel',         stained:'Chartreuse / Gold',     muddy:'Black / Copper' },
    topwater_troll:       { clear:'Bone / Natural Shad',   stained:'White / Chartreuse',    muddy:'Black / Dark' },
    topwater_cast:        { clear:'Bone / Natural',         stained:'White / Chartreuse',    muddy:'Black / Dark' },
    jighead:              { clear:'Natural',                stained:'Chartreuse / White',    muddy:'Black / Blue' },
    cast_only:            { clear:'Natural',                stained:'Chartreuse / White',    muddy:'Black / Blue' },
  };
  return colorMap[lureType]?.[c] || 'Natural';
}

// ── Jighead selection ─────────────────────────────────────────────────────────

/**
 * Select best jighead weight for a swimbait or A-rig at target depth.
 * Moved here from tackle-inventory.js — this is fishing knowledge, not inventory.
 */
export function getJigheadForDepth(availableWeights, targetDepthFt, speedMph = 1.8) {
  if (!availableWeights?.length) return null;
  // At 1.8mph: each 1/8oz gets ~4-5ft deeper per 50ft of lead
  // Simple heuristic: lighter = shallower, heavier = deeper
  if (targetDepthFt <= 8)  return availableWeights[0];
  if (targetDepthFt <= 14) return availableWeights[Math.floor(availableWeights.length / 2)];
  return availableWeights[availableWeights.length - 1];
}

// ── Speed helper ──────────────────────────────────────────────────────────────

export function getIdealSpeed(lureType) {
  return LURE_KNOWLEDGE[lureType]?.speed?.ideal ?? null;
}

export function getSpeedRange(lureType) {
  return LURE_KNOWLEDGE[lureType]?.speed ?? null;
}

// ── Season helper ─────────────────────────────────────────────────────────────

export function getSeason(date) {
  const d = date ? new Date(date) : new Date();
  const m = d.getMonth() + 1;
  if (m >= 3 && m <= 5)  return 'spring';
  if (m >= 6 && m <= 8)  return 'summer';
  if (m >= 9 && m <= 11) return 'fall';
  return 'winter';
}
