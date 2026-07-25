/**
 * species-strategies.js — Fishing behavior and tactical strategies per species.
 *
 * This file answers ONE question:
 *   "How should I fish this species under these conditions?"
 *
 * It returns preferred PRESENTATION TYPES ranked by priority.
 * lure-knowledge.js then scores those types against the actual lure.
 * tackle-inventory.js provides the actual lures Ryan owns.
 * smart-plan.js orchestrates but never decides.
 */

export const SPECIES_STRATEGIES = {

  striped_bass: {
    displayName: 'Striped Bass',
    seasons: {
      spring: {
        depthRange:  [8, 20],
        phaseDepths: [8, 14, 20],
        structure:   ['channel_swing', 'main_lake_point', 'creek_mouth', 'flat', 'suspended_bait'],
        presentations: [
          'umbrella_rig',
          'flutter_spoon',
          'swimbait_paddle',
          'topwater_troll',
          'bucktail',
          'crankbait_mr',
        ],
        speed:  { min: 1.6, ideal: 2.0, max: 2.6 },
        notes:  'Pre/post spawn — fish move shallow. Target creek mouths and points at dawn. Schooling activity increases midday as fish push bait.',
        presentationTarget: { profile: 'baitfish', noise: 'silent', flash: 'high', water_column: 'middle', cover: 'open_water' }
      },
      summer: {
        depthRange:  [16, 30],
        phaseDepths: [17, 23, 27],
        phaseNotes: {
          1: 'Dawn window — stripers schooling near surface. Troll channel-adjacent ledges 18-22ft. A-rig + flutter spoon. First light to sun-over-trees only.',
          2: 'Sun up — fish dropping off shallow ledge to thermocline edge. Transition to 20-24ft water column. Slow down slightly, drop leads.',
          3: 'Mid-morning through afternoon — stripers suspended just above thermocline 24-28ft. Channel ledges and humps. Electronics essential to find suspended fish.',
        },
        structure:   ['thermocline_zone', 'channel_ledge', 'main_lake_point', 'suspended_bait', 'deep_channel'],
        presentations: [
          'umbrella_rig',
          'flutter_spoon',
          'swimbait_paddle',
          'crankbait_dd2',
          'crankbait_dd1',
          'bucktail',
          'topwater_troll',
        ],
        speed:  { min: 1.4, ideal: 1.8, max: 2.2 },
        notes:  'Thermocline-driven. Fish suspend just above thermocline (typically 18-24ft on Wateree in July). Dawn: channel-adjacent ledges and points. As sun rises: drop to thermocline edge. Mid-morning: deep channel and suspended fish.',
        presentationTarget: { profile: 'baitfish', noise: 'silent', flash: 'high', water_column: 'lower', cover: 'open_water' }
      },
      fall: {
        depthRange:  [8, 22],
        phaseDepths: [8, 15, 20],
        structure:   ['channel_swing', 'main_lake_point', 'suspended_bait', 'flat', 'creek_mouth'],
        presentations: [
          'flutter_spoon',
          'umbrella_rig',
          'swimbait_paddle',
          'topwater_troll',
          'bucktail',
          'crankbait_mr',
        ],
        speed:  { min: 1.6, ideal: 2.0, max: 2.6 },
        notes:  'Baitfish migration — stripers actively chase shad into creek arms. Best topwater action of the year at dawn. Follow the birds.',
        presentationTarget: { profile: 'baitfish', noise: 'high_vibe', flash: 'high', water_column: 'middle', cover: 'open_water' }
      },
      winter: {
        depthRange:  [18, 35],
        phaseDepths: [20, 26, 32],
        structure:   ['deep_channel', 'dam_face', 'main_lake_point_deep', 'thermocline_zone'],
        presentations: [
          'flutter_spoon',
          'bucktail',
          'swimbait_paddle',
          'crankbait_dd3',
          'crankbait_dd4',
        ],
        speed:  { min: 1.2, ideal: 1.5, max: 1.8 },
        notes:  'Slow and deep. Fish school tight on bottom structure. Slow troll flutter spoon or bucktail at deepest available channel edge.',
        presentationTarget: { profile: 'baitfish', noise: 'silent', flash: 'high', water_column: 'lower', cover: 'open_water' }
      },
    },
  },

  largemouth_bass: {
    displayName: 'Largemouth Bass',
    seasons: {
      spring: {
        depthRange:  [1, 12],
        phaseDepths: [2, 6, 10],
        structure:   ['dock', 'laydown', 'shallow_flat', 'creek_arm', 'riprap', 'point'],
        presentations: [
          'crankbait_squarebill',
          'spinnerbait',
          'chatterbait',
          'topwater_troll',
          'crankbait_sr',
          'swimbait_paddle',
        ],
        speed:  { min: 1.8, ideal: 2.4, max: 3.0 },
        notes:  'Pre-spawn staging on points and channel swings. Spawn on flats 2-6ft. Squarebill around wood and riprap. Topwater at first light.',
        presentationTarget: { profile: 'crawfish', noise: 'rattle', flash: 'medium', water_column: 'upper', cover: 'wood' }
      },
      summer: {
        depthRange:  [6, 18],
        phaseDepths: [4, 10, 16],
        structure:   ['dock_edge', 'ledge_edge', 'hump_top', 'channel_swing', 'point'],
        presentations: [
          'crankbait_mr',
          'crankbait_dd1',
          'swimbait_paddle',
          'topwater_troll',
          'spinnerbait',
          'flutter_spoon',
        ],
        speed:  { min: 1.8, ideal: 2.2, max: 3.0 },
        notes:  'Moves deep midday. Dawn topwater and shallow edges. Post-dawn: ledges and channel swings at 10-16ft. Key time window is first 2 hours of light.',
        presentationTarget: { profile: 'bluegill', noise: 'silent', flash: 'low', water_column: 'middle', cover: 'wood' }
      },
      fall: {
        depthRange:  [4, 16],
        phaseDepths: [4, 8, 14],
        structure:   ['creek_arm', 'flat', 'point', 'dock_edge', 'laydown'],
        presentations: [
          'topwater_troll',
          'crankbait_mr',
          'spinnerbait',
          'swimbait_paddle',
          'chatterbait',
          'crankbait_sr',
        ],
        speed:  { min: 1.8, ideal: 2.4, max: 3.2 },
        notes:  'Following shad into creek arms. Best topwater of the year. Fish aggressively chasing bait in backs of coves.',
        presentationTarget: { profile: 'baitfish', noise: 'high_vibe', flash: 'medium', water_column: 'upper', cover: 'grass' }
      },
      winter: {
        depthRange:  [10, 22],
        phaseDepths: [12, 16, 20],
        structure:   ['deep_point', 'channel_ledge', 'hump'],
        presentations: [
          'crankbait_dd1',
          'swimbait_paddle',
          'flutter_spoon',
          'marabou_jig',
          'bucktail',
        ],
        speed:  { min: 1.4, ideal: 1.7, max: 2.0 },
        notes:  'Slow and methodical. Crankbaits on main lake points. Dead slow swimbait on jighead.',
        presentationTarget: { profile: 'baitfish', noise: 'silent', flash: 'none', water_column: 'bottom', cover: 'rock' }
      },
    },
  },

  smallmouth_bass: {
    displayName: 'Smallmouth Bass',
    seasons: {
      spring: {
        depthRange:  [4, 14],
        phaseDepths: [4, 8, 12],
        structure:   ['rocky_point', 'riprap', 'gravel_flat', 'channel_swing'],
        presentations: [
          'crankbait_mr',
          'swimbait_paddle',
          'crankbait_sr',
          'spinnerbait',
          'road_runner',
        ],
        speed:  { min: 1.8, ideal: 2.2, max: 2.8 },
        notes:  'Rocky substrate. Crankbaits and swimbaits on gravel points. Spawn earlier than largemouth.',
        presentationTarget: { profile: 'crawfish', noise: 'rattle', flash: 'medium', water_column: 'middle', cover: 'rock' }
      },
      summer: {
        depthRange:  [8, 20],
        phaseDepths: [8, 14, 18],
        structure:   ['rocky_point', 'channel_ledge', 'hump', 'riprap'],
        presentations: [
          'crankbait_dd1',
          'swimbait_paddle',
          'flutter_spoon',
          'crankbait_mr',
          'bucktail',
        ],
        speed:  { min: 1.6, ideal: 2.0, max: 2.6 },
        notes:  'Deeper rocky structure. Channel ledges adjacent to rock. Clear water — natural presentations.',
        presentationTarget: { profile: 'baitfish', noise: 'silent', flash: 'medium', water_column: 'middle', cover: 'rock' }
      },
      fall: {
        depthRange:  [6, 16],
        phaseDepths: [6, 10, 14],
        structure:   ['rocky_point', 'flat', 'channel_swing'],
        presentations: [
          'swimbait_paddle',
          'crankbait_mr',
          'flutter_spoon',
          'topwater_troll',
          'blade_vibe',
        ],
        speed:  { min: 1.8, ideal: 2.2, max: 2.8 },
        notes:  'Feeding heavily pre-winter. Shad imitations on main lake points.',
        presentationTarget: { profile: 'baitfish', noise: 'high_vibe', flash: 'high', water_column: 'middle', cover: 'rock' }
      },
      winter: {
        depthRange:  [14, 25],
        phaseDepths: [16, 20, 24],
        structure:   ['deep_point', 'channel_ledge', 'rocky_hump'],
        presentations: [
          'flutter_spoon',
          'swimbait_paddle',
          'crankbait_dd2',
          'bucktail',
        ],
        speed:  { min: 1.2, ideal: 1.5, max: 1.8 },
        notes:  'Very slow and deep on main lake rock structure.',
        presentationTarget: { profile: 'baitfish', noise: 'silent', flash: 'none', water_column: 'bottom', cover: 'rock' }
      },
    },
  },

  crappie: {
    displayName: 'Crappie',
    seasons: {
      spring: {
        depthRange:  [2, 10],
        phaseDepths: [2, 5, 8],
        structure:   ['brush_pile', 'dock', 'laydown', 'creek_arm', 'shallow_flat'],
        presentations: [
          'marabou_jig',
          'road_runner',
          'swimbait_paddle',
          'lipless',
        ],
        speed:  { min: 1.0, ideal: 1.4, max: 1.8 },
        notes:  'Spawn in brush and docks at 2-6ft. Slow troll marabou jig or small swimbait.',
        presentationTarget: { profile: 'baitfish', noise: 'silent', flash: 'none', water_column: 'upper', cover: 'brush_pile' }
      },
      summer: {
        depthRange:  [8, 20],
        phaseDepths: [8, 14, 18],
        structure:   ['brush_pile', 'dock', 'channel_edge', 'suspended_bait'],
        presentations: [
          'marabou_jig',
          'swimbait_paddle',
          'road_runner',
        ],
        speed:  { min: 1.0, ideal: 1.3, max: 1.6 },
        notes:  'Suspends over deep brush and channel edges. Slow troll small jig at precise depth.',
        presentationTarget: { profile: 'baitfish', noise: 'silent', flash: 'none', water_column: 'middle', cover: 'brush_pile' }
      },
      fall: {
        depthRange:  [6, 16],
        phaseDepths: [6, 10, 14],
        structure:   ['brush_pile', 'dock', 'creek_arm'],
        presentations: [
          'marabou_jig',
          'swimbait_paddle',
          'road_runner',
          'lipless',
        ],
        speed:  { min: 1.0, ideal: 1.4, max: 1.8 },
        notes:  'Moving shallower as temps drop. Brush piles and docks.',
        presentationTarget: { profile: 'baitfish', noise: 'silent', flash: 'low', water_column: 'middle', cover: 'brush_pile' }
      },
      winter: {
        depthRange:  [12, 24],
        phaseDepths: [14, 18, 22],
        structure:   ['brush_pile', 'channel_edge', 'deep_dock'],
        presentations: [
          'marabou_jig',
          'swimbait_paddle',
        ],
        speed:  { min: 0.9, ideal: 1.2, max: 1.5 },
        notes:  'Deepest brush and channel edges. Very slow presentation.',
        presentationTarget: { profile: 'baitfish', noise: 'silent', flash: 'none', water_column: 'lower', cover: 'brush_pile' }
      },
    },
  },

  bowfin: {
    displayName: 'Bowfin',
    seasons: {
      spring: {
        depthRange:  [1, 8],
        phaseDepths: [1, 4, 7],
        structure:   ['grass_mat', 'laydown', 'shallow_flat', 'creek_arm', 'dock'],
        presentations: [
          'road_runner',
          'spinnerbait',
          'chatterbait',
          'swimbait_paddle',
          'crankbait_squarebill',
        ],
        speed:  { min: 1.4, ideal: 1.8, max: 2.4 },
        notes:  'Spawn in very shallow grass and timber. Road runner with trailer is highly effective. Aggressive strike response.',
        presentationTarget: { profile: 'baitfish', noise: 'high_vibe', flash: 'medium', water_column: 'upper', cover: 'wood' }
      },
      summer: {
        depthRange:  [2, 10],
        phaseDepths: [2, 5, 8],
        structure:   ['grass_mat', 'laydown', 'creek_arm', 'dock_edge'],
        presentations: [
          'road_runner',
          'spinnerbait',
          'chatterbait',
          'swimbait_paddle',
          'topwater_troll',
        ],
        speed:  { min: 1.4, ideal: 1.8, max: 2.4 },
        notes:  'Shallow ambush predator. Edges of vegetation and timber. Dawn topwater pass before switching to subsurface.',
        presentationTarget: { profile: 'baitfish', noise: 'high_vibe', flash: 'medium', water_column: 'upper', cover: 'grass' }
      },
      fall: {
        depthRange:  [3, 12],
        phaseDepths: [3, 7, 10],
        structure:   ['grass_edge', 'laydown', 'creek_arm'],
        presentations: [
          'road_runner',
          'spinnerbait',
          'swimbait_paddle',
          'chatterbait',
        ],
        speed:  { min: 1.4, ideal: 1.8, max: 2.2 },
        notes:  'Still shallow, feeding on baitfish in vegetation edges.',
        presentationTarget: { profile: 'baitfish', noise: 'high_vibe', flash: 'medium', water_column: 'upper', cover: 'grass' }
      },
      winter: {
        depthRange:  [4, 14],
        phaseDepths: [6, 10, 13],
        structure:   ['laydown', 'channel_edge', 'dock'],
        presentations: [
          'swimbait_paddle',
          'marabou_jig',
          'road_runner',
        ],
        speed:  { min: 1.2, ideal: 1.5, max: 1.8 },
        notes:  'Less active but still catchable. Slower presentation near woody cover.',
        presentationTarget: { profile: 'baitfish', noise: 'silent', flash: 'none', water_column: 'bottom', cover: 'wood' }
      },
    },
  },

  catfish: {
    displayName: 'Catfish',
    seasons: {
      spring: {
        depthRange:  [4, 16],
        phaseDepths: [4, 10, 14],
        structure:   ['channel_swing', 'laydown', 'deep_flat'],
        presentations: [
          'swimbait_paddle',
          'bucktail',
          'flutter_spoon',
        ],
        speed:  { min: 1.2, ideal: 1.6, max: 2.0 },
        notes:  'Opportunistic — incidental catch while targeting other species. Channel edges.',
        presentationTarget: { profile: 'baitfish', noise: 'silent', flash: 'none', water_column: 'middle', cover: 'open_water' }
      },
      summer: {
        depthRange:  [8, 22],
        phaseDepths: [10, 16, 20],
        structure:   ['deep_channel', 'channel_ledge', 'dam_face'],
        presentations: [
          'swimbait_paddle',
          'flutter_spoon',
          'bucktail',
        ],
        speed:  { min: 1.2, ideal: 1.5, max: 1.8 },
        notes:  'Deep channel structure. Incidental catch on deep trolling presentations.',
        presentationTarget: { profile: 'baitfish', noise: 'silent', flash: 'none', water_column: 'bottom', cover: 'open_water' }
      },
      fall: {
        depthRange:  [6, 18],
        phaseDepths: [8, 12, 16],
        structure:   ['channel_swing', 'flat', 'laydown'],
        presentations: [
          'swimbait_paddle',
          'bucktail',
          'flutter_spoon',
        ],
        speed:  { min: 1.2, ideal: 1.6, max: 2.0 },
        notes:  'Channel edges and flats. Active feeding in fall.',
        presentationTarget: { profile: 'baitfish', noise: 'silent', flash: 'none', water_column: 'middle', cover: 'open_water' }
      },
      winter: {
        depthRange:  [10, 28],
        phaseDepths: [14, 20, 26],
        structure:   ['deep_channel', 'dam_face'],
        presentations: [
          'flutter_spoon',
          'swimbait_paddle',
          'bucktail',
        ],
        speed:  { min: 1.0, ideal: 1.3, max: 1.6 },
        notes:  'Very deep and slow. Dam face and deep channel.',
        presentationTarget: { profile: 'baitfish', noise: 'silent', flash: 'none', water_column: 'bottom', cover: 'open_water' }
      },
    },
  },
};

// ── Strategy helpers ──────────────────────────────────────────────────────────

export function getStrategy(species, season) {
  const key = normalizeSpecies(species);
  const s   = (season || 'summer').toLowerCase();
  return SPECIES_STRATEGIES[key]?.seasons[s] || null;
}

export function getPhaseDepth(species, season, phaseNum) {
  const strategy = getStrategy(species, season);
  if (!strategy) return [8, 20];

  const phases = strategy.phaseDepths || [
    strategy.depthRange[0],
    (strategy.depthRange[0] + strategy.depthRange[1]) / 2,
    strategy.depthRange[1],
  ];

  const idx      = Math.max(0, Math.min(2, phaseNum - 1));
  const targetMid = phases[idx];

  const bandHalf = 3;
  return [
    Math.max(0, targetMid - bandHalf),
    targetMid + bandHalf,
  ];
}

export function getPresentationPriority(species, season, conditions = {}) {
  const strategy = getStrategy(species, season);
  if (!strategy) return [];

  let presentations = [...strategy.presentations];
  const { timeOfDay, clarityKey } = conditions;

  if (timeOfDay === 'dawn') {
    const twIdx = presentations.indexOf('topwater_troll');
    if (twIdx > 0) {
      presentations.splice(twIdx, 1);
      presentations.unshift('topwater_troll');
    }
  }

  if (timeOfDay === 'deep') {
    presentations = presentations.filter(p => p !== 'topwater_troll');
  }

  if (clarityKey === 'stained' || clarityKey === 'muddy') {
    const vibration = ['spinnerbait', 'chatterbait', 'blade_vibe', 'lipless', 'road_runner'];
    vibration.forEach(v => {
      const idx = presentations.indexOf(v);
      if (idx > 2) {
        presentations.splice(idx, 1);
        presentations.splice(2, 0, v);
      }
    });
  }

  return presentations;
}

export function getPreferredStructure(species, season) {
  return getStrategy(species, season)?.structure || [];
}

export function getStrategySpeed(species, season) {
  return getStrategy(species, season)?.speed || { min: 1.6, ideal: 2.0, max: 2.6 };
}

export function getStrategyNotes(species, season) {
  return getStrategy(species, season)?.notes || '';
}

export function getPhaseNotes(species, season, phaseNum) {
  const strategy = getStrategy(species, season);
  if (!strategy) return '';
  if (strategy.phaseNotes?.[phaseNum]) return strategy.phaseNotes[phaseNum];
  return strategy.notes || '';
}

export function normalizeSpecies(species) {
  const s = (species || '').toLowerCase().replace(/\s+/g, '_');
  const map = {
    'striped_bass':    'striped_bass',
    'striper':         'striped_bass',
    'stripers':        'striped_bass',
    'stripe':          'striped_bass',
    'largemouth_bass': 'largemouth_bass',
    'largemouth':      'largemouth_bass',
    'bass':            'largemouth_bass',
    'smallmouth_bass': 'smallmouth_bass',
    'smallmouth':      'smallmouth_bass',
    'crappie':         'crappie',
    'slab':            'crappie',
    'bowfin':          'bowfin',
    'mudfish':         'bowfin',
    'grinnel':         'bowfin',
    'catfish':         'catfish',
    'blue_catfish':    'catfish',
    'channel_catfish': 'catfish',
  };
  return map[s] || 'striped_bass';
}

export function getTimePhase(timeStr) {
  if (!timeStr) return 'morning';
  const [h] = timeStr.split(':').map(Number);
  if (h < 7)  return 'dawn';
  if (h < 10) return 'morning';
  if (h < 13) return 'midday';
  return 'deep';
}

export function buildLureContext(species, season, phaseNum, conditions = {}) {
  const { clarity, speedMph, waterTempF, launchTime } = conditions;
  const strategy  = getStrategy(species, season);
  const [dMin, dMax] = getPhaseDepth(species, season, phaseNum);

  const phaseTimeMap = { 1: 'dawn', 2: 'morning', 3: 'deep' };
  const timeOfDay   = phaseNum === 1 && launchTime
    ? getTimePhase(launchTime)
    : phaseTimeMap[phaseNum] || 'morning';

  const clarityKey = (clarity || 'Clear').toLowerCase().includes('mud') ? 'muddy'
    : (clarity || 'Clear').toLowerCase().includes('stain') ? 'stained'
    : 'clear';

  return {
    species:        normalizeSpecies(species),
    season,
    phaseNum,
    timeOfDay,
    clarity,
    clarityKey,
    targetDepthFt:  (dMin + dMax) / 2,
    depthMin:       dMin,
    depthMax:       dMax,
    speedMph:       speedMph || strategy?.speed?.ideal || 1.8,
    structure:      strategy?.structure || [],
    preferredTypes: getPresentationPriority(species, season, { timeOfDay, clarityKey }),
    waterTempF,
    presentationTarget: strategy?.presentationTarget || null,
  };
}
