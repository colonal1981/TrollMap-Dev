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
 */

export const LURE_KNOWLEDGE = {

  // ── Crankbaits — PHYSICAL depth limits apply ──────────────────────────────

  crankbait_squarebill: {
    label: 'Squarebill Crankbait',
    depthMode: 'rated',
    ratedDepth: { min: 2, max: 5 },
    leadRatio: { byDepthFt: [[12, 3.0], [20, 3.8], [null, 5.2]] },
    speedAffectsLead: false,
    tacticalDepth: { ideal: 3 },
    species:   { striped_bass:5, largemouth_bass:9, smallmouth_bass:7, crappie:1, bowfin:5, catfish:1, redfish:7 },
    season:    { spring:10, summer:6, fall:8, winter:3 },
    clarity:   { clear:7, stained:9, muddy:6 },
    structure: ['riprap','dock','laydown','shallow_flat','creek_arm','point'],
    speed:     { min:1.8, ideal:2.4, max:3.0 },
    speedIsHardLimit: true,
    technique: 'Deflects off wood and rock — slow roll over shallow cover',
    presentationSignature: { noise:'rattle', flash:'medium', profile:'baitfish', water_column:'upper', cover_friendly:['wood','rock','shallow_flat'] }
  },

  crankbait_sr: {
    label: 'SR Crankbait (Shallow Runner)',
    depthMode: 'rated',
    ratedDepth: { min:3, max:5 },
    leadRatio: { byDepthFt: [[12, 3.0], [20, 3.8], [null, 5.2]] },
    speedAffectsLead: false,
    tacticalDepth: { ideal:4 },
    species:   { striped_bass:5, largemouth_bass:8, smallmouth_bass:7, crappie:2, bowfin:4, catfish:1, redfish:6 },
    season:    { spring:9, summer:5, fall:8, winter:3 },
    clarity:   { clear:8, stained:7, muddy:4 },
    structure: ['point','flat','dock_edge','creek_mouth','riprap'],
    speed:     { min:2.0, ideal:2.5, max:3.0 },
    speedIsHardLimit: true,
    technique: 'Shallow flat runner — points and creek mouths at dawn',
    presentationSignature: { noise:'rattle', flash:'medium', profile:'baitfish', water_column:'upper', cover_friendly:['open_water','rock'] }
  },

  crankbait_mr: {
    label: 'MR Crankbait (Medium Runner)',
    depthMode: 'rated',
    ratedDepth: { min:6, max:12 },
    leadRatio: { byDepthFt: [[12, 3.0], [20, 3.8], [null, 5.2]] },
    speedAffectsLead: false,
    tacticalDepth: { ideal:9 },
    species:   { striped_bass:7, largemouth_bass:9, smallmouth_bass:8, crappie:2, bowfin:3, catfish:1 },
    season:    { spring:9, summer:7, fall:9, winter:5 },
    clarity:   { clear:8, stained:8, muddy:5 },
    structure: ['ledge_edge','secondary_point','hump_top','channel_swing','flat'],
    speed:     { min:1.8, ideal:2.4, max:3.0 },
    speedIsHardLimit: true,
    technique: 'Mid-range ledge runner — secondary points and hump tops',
    presentationSignature: { noise:'rattle', flash:'medium', profile:'baitfish', water_column:'middle', cover_friendly:['open_water','rock'] }
  },

  crankbait_dd1: {
    label: 'DD1 Deep Diver (14-18ft)',
    depthMode: 'rated',
    ratedDepth: { min:14, max:18 },
    leadRatio: { byDepthFt: [[12, 3.0], [20, 3.8], [null, 5.2]] },
    speedAffectsLead: false,
    tacticalDepth: { ideal:16 },
    species:   { striped_bass:8, largemouth_bass:9, smallmouth_bass:8, crappie:1, bowfin:2, catfish:1 },
    season:    { spring:7, summer:9, fall:8, winter:6 },
    clarity:   { clear:9, stained:7, muddy:3 },
    structure: ['channel_ledge','main_lake_point','hump','channel_swing'],
    speed:     { min:1.6, ideal:2.2, max:2.8 },
    speedIsHardLimit: true,
    technique: 'Primary ledge crankbait — run on channel swing drop-offs',
    presentationSignature: { noise:'rattle', flash:'medium', profile:'baitfish', water_column:'lower', cover_friendly:['open_water','rock'] }
  },

  crankbait_dd2: {
    label: 'DD2 Deep Diver (16-20ft)',
    depthMode: 'rated',
    ratedDepth: { min:16, max:20 },
    leadRatio: { byDepthFt: [[12, 3.0], [20, 3.8], [null, 5.2]] },
    speedAffectsLead: false,
    tacticalDepth: { ideal:18 },
    species:   { striped_bass:9, largemouth_bass:8, smallmouth_bass:7, crappie:1, bowfin:1, catfish:1 },
    season:    { spring:6, summer:10, fall:8, winter:6 },
    clarity:   { clear:9, stained:6, muddy:2 },
    structure: ['channel_ledge','main_lake_point','hump','thermocline_zone'],
    speed:     { min:1.5, ideal:2.0, max:2.6 },
    speedIsHardLimit: true,
    technique: 'Deep ledge and thermocline zone — summer striper primary',
    presentationSignature: { noise:'rattle', flash:'medium', profile:'baitfish', water_column:'lower', cover_friendly:['open_water','rock'] }
  },

  crankbait_dd3: {
    label: 'DD3 Deep Diver (20-25ft)',
    depthMode: 'rated',
    ratedDepth: { min:20, max:25 },
    leadRatio: { byDepthFt: [[12, 3.0], [20, 3.8], [null, 5.2]] },
    speedAffectsLead: false,
    tacticalDepth: { ideal:22 },
    species:   { striped_bass:9, largemouth_bass:6, smallmouth_bass:5, crappie:1, bowfin:1, catfish:1 },
    season:    { spring:5, summer:10, fall:7, winter:5 },
    clarity:   { clear:10, stained:5, muddy:1 },
    structure: ['deep_channel','hump_edge','dam_face','thermocline_zone'],
    speed:     { min:1.4, ideal:1.8, max:2.4 },
    speedIsHardLimit: true,
    technique: 'Deep channel and hump edges — thermocline bottom in peak summer',
    presentationSignature: { noise:'rattle', flash:'medium', profile:'baitfish', water_column:'lower', cover_friendly:['open_water','rock'] }
  },

  crankbait_dd4: {
    label: 'DD4 Deep Diver (25ft+)',
    depthMode: 'rated',
    ratedDepth: { min:25, max:35 },
    leadRatio: { byDepthFt: [[12, 3.0], [20, 3.8], [null, 5.2]] },
    speedAffectsLead: false,
    tacticalDepth: { ideal:28 },
    species:   { striped_bass:8, largemouth_bass:4, smallmouth_bass:3, crappie:1, bowfin:1, catfish:1 },
    season:    { spring:4, summer:9, fall:6, winter:5 },
    clarity:   { clear:10, stained:4, muddy:1 },
    structure: ['deep_channel','dam_face','main_lake_point_deep'],
    speed:     { min:1.3, ideal:1.6, max:2.0 },
    speedIsHardLimit: true,
    technique: 'Deepest available — dam face and thermocline bottom in peak summer',
    presentationSignature: { noise:'rattle', flash:'medium', profile:'baitfish', water_column:'lower', cover_friendly:['open_water','rock'] }
  },

  // ── Variable-depth lures — NO physical depth limit, tactical scoring only ─

  lipless: {
    label: 'Lipless Crankbait',
    depthMode: 'lead',
    ratedDepth: null,
    leadRatio: 4.0,
    speedAffectsLead: true,
    tacticalDepth: { ideal:6 },
    species:   { striped_bass:6, largemouth_bass:8, smallmouth_bass:7, crappie:4, bowfin:5, catfish:1, redfish:8, trout:8 },
    season:    { spring:9, summer:6, fall:9, winter:8 },
    clarity:   { clear:7, stained:9, muddy:7 },
    structure: ['grass_edge','flat','point','channel_swing','dock_edge'],
    speed:     { min:1.6, ideal:2.2, max:3.0 },
    speedIsHardLimit: false,
    technique: 'Vibration/rattle — depth by lead and speed — excellent cold/stained water',
    presentationSignature: { noise:'high_vibe', flash:'medium', profile:'baitfish', water_column:'middle', cover_friendly:['grass','open_water'] }
  },

  blade_vibe: {
    label: 'Blade Vibe Bait',
    depthMode: 'lead',
    ratedDepth: null,
    leadRatio: 4.0,
    speedAffectsLead: true,
    tacticalDepth: { ideal:5 },
    species:   { striped_bass:5, largemouth_bass:7, smallmouth_bass:8, crappie:6, bowfin:4, catfish:1 },
    season:    { spring:8, summer:5, fall:9, winter:9 },
    clarity:   { clear:6, stained:9, muddy:8 },
    structure: ['flat','point','grass_edge','riprap'],
    speed:     { min:1.4, ideal:1.8, max:2.4 },
    speedIsHardLimit: false,
    technique: 'Maximum vibration — stained/cold water — variable depth by lead',
    presentationSignature: { noise:'high_vibe', flash:'medium', profile:'baitfish', water_column:'middle', cover_friendly:['open_water','rock'] }
  },

  umbrella_rig: {
    label: 'A-Rig / Umbrella Rig',
    depthMode: 'lead',
    ratedDepth: null,
    leadRatio: { byWeightOz: [[1.65, 7.5], [2.65, 6.5], [3.5, 5.5]] },
    speedAffectsLead: true,
    tacticalDepth: { ideal:16 },
    species:   { striped_bass:10, largemouth_bass:7, smallmouth_bass:6, crappie:1, bowfin:3, catfish:1 },
    season:    { spring:8, summer:10, fall:9, winter:6 },
    clarity:   { clear:9, stained:8, muddy:5 },
    structure: ['open_water','channel','suspended_bait','main_lake_point','thermocline_zone'],
    speed:     { min:1.4, ideal:1.8, max:2.4 },
    speedIsHardLimit: false,
    technique: 'Schooling bait mimic — most effective open-water striper presentation',
    presentationSignature: { noise:'high_vibe', flash:'high', profile:'baitfish', water_column:'middle', cover_friendly:['open_water'] }
  },

  swimbait_paddle: {
    label: 'Paddle Tail Swimbait',
    depthMode: 'lead',
    ratedDepth: null,
    leadRatio: 4.0,
    // Ryan, 2026-08-03: "larger weights have larger hooks that would rip apart a
    // smaller swimbait... for 2-3 inch nothing more than 1/2 oz, for 3-4 inch
    // nothing more than 1oz... for the 1.25 or 1.5 those would go with 5+".
    //
    // This is a HOOK-SIZE cap, not a depth cap, and the difference decides what the
    // app should say when it binds. The bait is not failing to reach the fish; it is
    // being torn apart by the hook it is sitting on. So the answer when you run out
    // of head weight is a LONGER swimbait, never a heavier head. `lengthIn <= cap`.
    jigheadMaxOzByLengthIn: [[3.0, 0.5], [4.9, 1.0], [null, 1.5]],
    speedAffectsLead: true,
    tacticalDepth: { ideal:14 },
    species:   { striped_bass:8, largemouth_bass:8, smallmouth_bass:7, crappie:5, bowfin:6, catfish:2, redfish:9, trout:9, flounder:7 },
    season:    { spring:8, summer:9, fall:8, winter:5 },
    clarity:   { clear:9, stained:7, muddy:4 },
    structure: ['open_water','channel','suspended_bait','point','flat','grass_edge','oyster_bar'],
    speed:     { min:1.4, ideal:1.8, max:2.4 },
    speedIsHardLimit: false,
    technique: 'Natural baitfish profile — depth via jighead weight and lead',
    presentationSignature: { noise:'silent', flash:'low', profile:'baitfish', water_column:'middle', cover_friendly:['open_water','grass'] }
  },

  flutter_spoon: {
    label: 'Flutter Spoon',
    depthMode: 'lead',
    ratedDepth: null,
    leadRatio: { base: 3.5, refOz: 0.75 },   // quoted for the 3/4oz Nichols
    speedAffectsLead: true,
    tacticalDepth: { ideal:20 },
    species:   { striped_bass:10, largemouth_bass:6, smallmouth_bass:5, crappie:3, bowfin:4, catfish:1 },
    season:    { spring:7, summer:10, fall:9, winter:7 },
    clarity:   { clear:10, stained:7, muddy:3 },
    structure: ['channel','suspended_bait','thermocline_zone','dam_face','main_lake_point'],
    speed:     { min:1.3, ideal:1.7, max:2.2 },
    speedIsHardLimit: false,
    technique: 'Flash + flutter at slow troll — primary deep striper presentation in clear water',
    presentationSignature: { noise:'silent', flash:'high', profile:'baitfish', water_column:'lower', cover_friendly:['open_water'] }
  },

  spinnerbait: {
    label: 'Spinnerbait',
    depthMode: 'lead',
    ratedDepth: null,
    leadRatio: 4.0,
    speedAffectsLead: true,
    tacticalDepth: { ideal:5 },
    species:   { striped_bass:4, largemouth_bass:9, smallmouth_bass:7, crappie:3, bowfin:6, catfish:1 },
    season:    { spring:10, summer:6, fall:8, winter:3 },
    clarity:   { clear:6, stained:10, muddy:8 },
    structure: ['dock_edge','point','flat','riprap','laydown','creek_arm'],
    speed:     { min:1.4, ideal:2.0, max:2.8 },
    speedIsHardLimit: false,
    technique: 'Vibration and flash — stained water specialist — slow-roll near cover',
    presentationSignature: { noise:'high_vibe', flash:'high', profile:'baitfish', water_column:'middle', cover_friendly:['wood','grass'] }
  },

  chatterbait: {
    label: 'Chatterbait',
    depthMode: 'lead',
    ratedDepth: null,
    leadRatio: 4.0,
    speedAffectsLead: true,
    tacticalDepth: { ideal:4 },
    species:   { striped_bass:3, largemouth_bass:9, smallmouth_bass:7, crappie:2, bowfin:7, catfish:1 },
    season:    { spring:10, summer:6, fall:8, winter:4 },
    clarity:   { clear:5, stained:10, muddy:8 },
    structure: ['grass_edge','dock_edge','laydown','flat','creek_arm'],
    speed:     { min:1.4, ideal:2.0, max:2.8 },
    speedIsHardLimit: false,
    technique: 'Maximum vibration/flash — stained water bass — vegetation edges',
    presentationSignature: { noise:'high_vibe', flash:'medium', profile:'baitfish', water_column:'middle', cover_friendly:['grass','wood'] }
  },

  vertical_jig: {
    label: 'Vertical / Knife Jig',
    depthMode: 'lead',
    ratedDepth: null,
    leadRatio: 4.0,
    speedAffectsLead: true,
    tacticalDepth: { ideal: 30 },
    species:   { striped_bass:9, largemouth_bass:5, smallmouth_bass:6, crappie:2, bowfin:2, catfish:3, redfish:6, flounder:5, trout:4 },
    season:    { spring:6, summer:9, fall:9, winter:9 },
    clarity:   { clear:9, stained:6, muddy:3 },
    structure: ['deep_channel','channel_ledge','hump','suspended_bait','dam_face','thermocline_zone','open_water'],
    speed:     { min:1.5, ideal:2.2, max:3.0 },
    speedIsHardLimit: false,
    technique: 'Dense wire-through chrome body. Drops fast and HOLDS depth at speed instead of planing up, so it trolls deep on a long lead as well as it jigs vertically. Depth is lead and speed, not a dive lip.',
    presentationSignature: { noise:'silent', flash:'high', profile:'baitfish', water_column:'bottom', cover_friendly:['open_water','rock'] }
  },

  inline_spinner: {
    label: 'Inline Spinner',
    depthMode: 'lead',
    ratedDepth: null,
    leadRatio: 4.0,
    speedAffectsLead: true,
    tacticalDepth: { ideal: 6 },
    species:   { striped_bass:6, largemouth_bass:7, smallmouth_bass:8, crappie:7, bowfin:6, catfish:3, redfish:5, trout:9 },
    season:    { spring:9, summer:7, fall:8, winter:5 },
    clarity:   { clear:8, stained:8, muddy:5 },
    structure: ['creek_arm','creek_mouth','flat','shallow_flat','point','laydown','current_seam','brush_pile'],
    speed:     { min:1.0, ideal:1.5, max:2.0 },
    speedIsHardLimit: false,
    technique: 'Blade turns around a straight shaft, so it generates constant LIFT — it rides high and the blade stalls and fouls above about 2mph. Long lead or an inline keel weight to get it down; never the fast rod in a spread.',
    presentationSignature: { noise:'high_vibe', flash:'high', profile:'baitfish', water_column:'upper', cover_friendly:['open_water','wood','laydown'] }
  },

  bucktail: {
    label: 'Bucktail Jig',
    depthMode: 'lead',
    ratedDepth: null,
    leadRatio: 4.0,
    speedAffectsLead: true,
    tacticalDepth: { ideal:18 },
    species:   { striped_bass:9, largemouth_bass:6, smallmouth_bass:7, crappie:4, bowfin:5, catfish:2, redfish:8 },
    season:    { spring:8, summer:9, fall:9, winter:7 },
    clarity:   { clear:8, stained:7, muddy:5 },
    structure: ['channel','open_water','suspended_bait','dam_face','current_seam','bridge_piling'],
    speed:     { min:1.3, ideal:1.7, max:2.2 },
    speedIsHardLimit: false,
    technique: 'Pulsing hair action — classic striper slow-troll — depth by lead',
    presentationSignature: { noise:'silent', flash:'low', profile:'baitfish', water_column:'lower', cover_friendly:['open_water','rock','bridge_piling'] }
  },

  marabou_jig: {
    label: 'Marabou Jig',
    depthMode: 'lead',
    ratedDepth: null,
    leadRatio: 4.0,
    speedAffectsLead: true,
    tacticalDepth: { ideal:10 },
    species:   { striped_bass:6, largemouth_bass:6, smallmouth_bass:6, crappie:9, bowfin:5, catfish:3 },
    season:    { spring:9, summer:7, fall:8, winter:8 },
    clarity:   { clear:8, stained:7, muddy:5 },
    structure: ['brush_pile','dock','channel_edge','flat','point'],
    speed:     { min:1.2, ideal:1.6, max:2.0 },
    speedIsHardLimit: false,
    technique: 'Pulsing soft action — crappie and bass — slow troll near structure',
    presentationSignature: { noise:'silent', flash:'none', profile:'baitfish', water_column:'middle', cover_friendly:['open_water','brush_pile'] }
  },

  road_runner: {
    label: 'Road Runner / Beetle Spin',
    depthMode: 'lead',
    ratedDepth: null,
    leadRatio: 4.0,
    speedAffectsLead: true,
    tacticalDepth: { ideal:4 },
    species:   { striped_bass:4, largemouth_bass:7, smallmouth_bass:7, crappie:8, bowfin:9, catfish:4 },
    season:    { spring:9, summer:8, fall:8, winter:6 },
    clarity:   { clear:7, stained:8, muddy:7 },
    structure: ['dock_edge','laydown','creek_arm','flat','brush_pile'],
    speed:     { min:1.2, ideal:1.6, max:2.2 },
    speedIsHardLimit: false,
    technique: 'Spinner + soft plastic trailer — bowfin and bass in shallow cover',
    presentationSignature: { noise:'silent', flash:'medium', profile:'baitfish', water_column:'upper', cover_friendly:['wood','dock_edge','laydown'] }
  },

  jighead: {
    label: 'Jighead (bare or with swimbait)',
    depthMode: 'lead',
    ratedDepth: null,
    leadRatio: 4.0,
    speedAffectsLead: true,
    tacticalDepth: { ideal:12 },
    species:   { striped_bass:7, largemouth_bass:7, smallmouth_bass:6, crappie:7, bowfin:5, catfish:2, redfish:8, trout:8 },
    season:    { spring:7, summer:8, fall:7, winter:6 },
    clarity:   { clear:8, stained:7, muddy:5 },
    structure: ['open_water','channel','point','flat','brush_pile'],
    speed:     { min:1.2, ideal:1.7, max:2.2 },
    speedIsHardLimit: false,
    technique: 'Depth controlled by head weight and lead — versatile year-round',
    presentationSignature: { noise:'silent', flash:'none', profile:'baitfish', water_column:'middle', cover_friendly:['open_water','rock','brush_pile'] }
  },

  // ── Topwater — PHYSICAL depth limit (surface only) ────────────────────────

  topwater_troll: {
    label: 'Topwater (Trollable)',
    depthMode: 'surface',
    ratedDepth: { min:0, max:1 },
    tacticalDepth: { ideal:0 },
    species:   { striped_bass:8, largemouth_bass:9, smallmouth_bass:7, crappie:1, bowfin:6, catfish:1 },
    season:    { spring:8, summer:9, fall:8, winter:2 },
    clarity:   { clear:9, stained:7, muddy:4 },
    structure: ['open_water','flat','point','creek_mouth','dock_edge'],
    speed:     { min:1.2, ideal:1.6, max:2.0 },
    speedIsHardLimit: true,
    technique: 'Surface troll at dawn — schooling striper and largemouth — slow retrieve',
    presentationSignature: { noise:'rattle', flash:'medium', profile:'baitfish', water_column:'surface', cover_friendly:['open_water'] }
  },

  topwater_cast: {
    label: 'Topwater (Cast Only)',
    depthMode: 'surface',
    ratedDepth: { min:0, max:0 },
    tacticalDepth: { ideal:0 },
    species:   { striped_bass:5, largemouth_bass:10, smallmouth_bass:7, crappie:1, bowfin:7, catfish:1, redfish:9, trout:8 },
    season:    { spring:9, summer:8, fall:8, winter:1 },
    clarity:   { clear:8, stained:7, muddy:5 },
    structure: ['grass_mat','lily_pad','dock','shallow_flat','creek_arm','grass_edge'],
    speed:     null,
    speedIsHardLimit: false,   // never trolled — no trolling speed to cap
    technique: 'Cast only — suggest as casting stop near shallow cover',
    presentationSignature: { noise:'rattle', flash:'low', profile:'baitfish', water_column:'surface', cover_friendly:['open_water','wood','rock'] }
  },

  cast_only: {
    label: 'Cast Only (Soft Plastics)',
    depthMode: 'lead',
    ratedDepth: null,
    leadRatio: 4.0,
    speedAffectsLead: true,
    tacticalDepth: { ideal:6 },
    species:   { striped_bass:3, largemouth_bass:10, smallmouth_bass:8, crappie:5, bowfin:6, catfish:3, redfish:8, trout:7 },
    season:    { spring:9, summer:7, fall:8, winter:6 },
    clarity:   { clear:8, stained:7, muddy:6 },
    structure: ['dock','laydown','grass','brush_pile','rock'],
    speed:     null,
    speedIsHardLimit: false,   // never trolled — no trolling speed to cap
    technique: 'Cast only — suggest as casting stop at structure',
    presentationSignature: { noise:'silent', flash:'none', profile:'worm', water_column:'bottom', cover_friendly:['wood','grass','rock','dock_edge'] }
  },

  // ── New Rig / Method Categories (Merged from New List) ────────────────────

  underspin: {
    label: 'Underspin Jig',
    depthMode: 'lead',
    ratedDepth: null,
    leadRatio: 4.0,
    speedAffectsLead: true,
    tacticalDepth: { ideal: 10 },
    species:   { striped_bass:8, largemouth_bass:8, smallmouth_bass:8, crappie:4, bowfin:4, catfish:1 },
    season:    { spring:8, summer:9, fall:8, winter:6 },
    clarity:   { clear:9, stained:8, muddy:4 },
    structure: ['point', 'rocky_point', 'channel_ledge', 'suspended_bait', 'flat'],
    speed:     { min:1.4, ideal:1.8, max:2.2 },
    speedIsHardLimit: false,
    technique: 'Rotating belly blade provides flash on steady retrieve or slow troll',
    presentationSignature: { noise:'silent', flash:'medium', profile:'baitfish', water_column:'middle', cover_friendly:['open_water','grass','rock'] }
  },

  spoon_casting: {
    label: 'Casting Spoon / Diamond Jig',
    depthMode: 'lead',
    ratedDepth: null,
    leadRatio: { base: 3.5, refOz: 1.0 },    // quoted for the 1oz Dr.Fish diamond jig
    speedAffectsLead: true,
    tacticalDepth: { ideal: 18 },
    species:   { striped_bass:9, largemouth_bass:6, smallmouth_bass:7, crappie:2, bowfin:3, catfish:2 },
    season:    { spring:7, summer:9, fall:9, winter:8 },
    clarity:   { clear:9, stained:7, muddy:3 },
    structure: ['deep_channel', 'channel_ledge', 'hump', 'suspended_bait', 'open_water'],
    speed:     { min:1.6, ideal:2.2, max:2.8 },
    speedIsHardLimit: false,
    technique: 'Heavy casting or vertical jigging - high speed or deep flutter',
    presentationSignature: { noise:'silent', flash:'high', profile:'baitfish', water_column:'bottom', cover_friendly:['open_water','rock'] }
  },

  jig_football: {
    label: 'Football Jig',
    depthMode: 'lead',
    ratedDepth: null,
    leadRatio: 4.0,
    speedAffectsLead: true,
    tacticalDepth: { ideal: 12 },
    species:   { striped_bass:2, largemouth_bass:10, smallmouth_bass:9, crappie:1, bowfin:4, catfish:2 },
    season:    { spring:9, summer:8, fall:8, winter:7 },
    clarity:   { clear:8, stained:9, muddy:5 },
    structure: ['rocky_point', 'channel_ledge', 'hump', 'clay_bank', 'point'],
    speed:     null,
    speedIsHardLimit: false,   // never trolled — no trolling speed to cap
    technique: 'Cast and drag slowly over deep rock or gravel points, deflecting off structure',
    presentationSignature: { noise:'silent', flash:'none', profile:'crawfish', water_column:'bottom', cover_friendly:['rock','gravel'] }
  },

  jig_finesse_ned: {
    label: 'Ned Rig / Finesse Jig',
    depthMode: 'lead',
    ratedDepth: null,
    leadRatio: 4.0,
    speedAffectsLead: true,
    tacticalDepth: { ideal: 8 },
    species:   { striped_bass:3, largemouth_bass:9, smallmouth_bass:10, crappie:6, bowfin:4, catfish:3 },
    season:    { spring:9, summer:7, fall:8, winter:8 },
    clarity:   { clear:9, stained:8, muddy:4 },
    structure: ['dock', 'dock_edge', 'rock', 'laydown', 'point'],
    speed:     null,
    speedIsHardLimit: false,   // never trolled — no trolling speed to cap
    technique: 'Dead-stick or hop slowly on bottom - highly effective under tough/cold conditions',
    presentationSignature: { noise:'silent', flash:'none', profile:'worm', water_column:'bottom', cover_friendly:['rock','wood','dock_edge'] }
  },

  popping_cork: {
    label: 'Popping Cork Rig',
    depthMode: 'rated',
    ratedDepth: { min:2, max:6 },
    leadRatio: 4.0,
    speedAffectsLead: false,
    tacticalDepth: { ideal: 4 },
    species:   { striped_bass:6, largemouth_bass:6, smallmouth_bass:4, crappie:2, bowfin:4, catfish:1, redfish:10, trout:10, flounder:7 },
    season:    { spring:9, summer:10, fall:9, winter:4 },
    clarity:   { clear:8, stained:10, muddy:6 },
    structure: ['grass_edge', 'shallow_flat', 'oyster_bar', 'creek_mouth', 'creek_arm'],
    speed:     { min:1.0, ideal:1.3, max:1.6 },
    speedIsHardLimit: true,
    technique: 'Troll or cast near grass/oysters. Heavy pop sound triggers fish, keeping lure suspended',
    presentationSignature: { noise:'high_vibe', flash:'low', profile:'shrimp', water_column:'upper', cover_friendly:['grass','shallow_flat','oyster_bar'] }
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
 */
export function scoreLureForContext(lureType, context = {}) {
  const knowledge = LURE_KNOWLEDGE[lureType];
  if (!knowledge) return { score:-999, confidence:0, reasons:[], warnings:[], disqualifiers:[`Unknown lure type: ${lureType}`] };

  const {
    species, season, clarityKey, targetDepthFt,
    depthMin, depthMax, speedMph, structure, preferredTypes,
    presentationTarget,
  } = context;

  let score = 0;
  const reasons       = [];
  const warnings      = [];
  const disqualifiers = [];

  // ── 1. Physical depth hard gate (crankbaits + topwater only) ─────────────
  if (knowledge.ratedDepth !== null && targetDepthFt !== undefined) {
    const pd = knowledge.ratedDepth;
    if (targetDepthFt < pd.min || targetDepthFt > pd.max) {
      const msg = `Cannot physically reach ${targetDepthFt}ft (range: ${pd.min}–${pd.max}ft)`;
      disqualifiers.push(msg);
      return { score:-999, confidence:0, reasons:[], warnings:[], disqualifiers:[msg] };
    }
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
  if (knowledge.ratedDepth === null && knowledge.tacticalDepth && targetDepthFt !== undefined) {
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
    else                    { score += 2; }
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

  // ── 9. Presentation Signature Match (Enriched Presentation-First) ────────
  if (presentationTarget && knowledge.presentationSignature) {
    let presScore = 0;
    const target = presentationTarget;
    const sig = knowledge.presentationSignature;

    // Profile match (baitfish, crawfish, shrimp, worm etc)
    if (target.profile && sig.profile) {
      if (target.profile === sig.profile) {
        presScore += 10;
        reasons.push(`Matches target profile: ${sig.profile}`);
      } else {
        presScore -= 3;
      }
    }

    // Noise match (silent, rattle, high_vibe)
    if (target.noise && sig.noise) {
      if (target.noise === sig.noise) {
        presScore += 6;
        reasons.push(`Matches target noise level: ${sig.noise}`);
      } else {
        presScore -= 1;
      }
    }

    // Flash match (none, low, medium, high)
    if (target.flash && sig.flash) {
      if (target.flash === sig.flash) {
        presScore += 6;
        reasons.push(`Matches target flash level: ${sig.flash}`);
      } else {
        presScore -= 1;
      }
    }

    // Cover friendliness match
    if (target.cover && sig.cover_friendly) {
      if (sig.cover_friendly.includes(target.cover)) {
        presScore += 8;
        reasons.push(`Highly cover-friendly for ${target.cover}`);
      } else {
        presScore -= 5;
        warnings.push(`Warning: lure is not cover-friendly for ${target.cover}`);
      }
    }

    // Water Column match
    if (target.water_column && sig.water_column) {
      if (target.water_column === sig.water_column) {
        presScore += 6;
      }
    }

    score += presScore;
  }

  // ── Confidence — based on score spread and data quality ───────────────────
  const confidence = Math.min(0.97, Math.max(0.30, score / 75));

  return { score, confidence: Math.round(confidence * 100) / 100, reasons, warnings, disqualifiers };
}

// ── Color recommendations ─────────────────────────────────────────────────────

/**
 * Colour recommendation per type per clarity.
 * EXPORTED so test/tackle-parity.test.js can assert every inventory type has an
 * entry. Reached only through getLureColor() the fallback is invisible: a missing
 * type silently returns 'Natural Pearl / Smoke', which is a legal answer for some
 * types, so the gap cannot be detected from the outside.
 */
export const LURE_COLORS = {
    umbrella_rig:         { clear:'Blueback Herring',      stained:'Chartreuse / White',  muddy:'Dark Shad' },
    crankbait_squarebill: { clear:'Natural Pearl / Smoke', stained:'Chartreuse / Shad',   muddy:'Black / Blue' },
    crankbait_sr:         { clear:'Blue / Silver Herring', stained:'Chartreuse / Shad',   muddy:'Black / Blue' },
    crankbait_mr:         { clear:'Blue / Silver Herring', stained:'Chartreuse / Shad',   muddy:'Black / Blue' },
    crankbait_dd1:        { clear:'Sexy Shad',             stained:'Firetiger',           muddy:'Black / Blue' },
    crankbait_dd2:        { clear:'Sexy Shad',             stained:'Firetiger',           muddy:'Black / Blue' },
    crankbait_dd3:        { clear:'Tennessee Shad',        stained:'Firetiger',           muddy:'Dark Shad' },
    crankbait_dd4:        { clear:'Tennessee Shad',        stained:'Chartreuse / Shad',   muddy:'Dark Shad' },
    lipless:              { clear:'Chrome / Silver',       stained:'Gold / Copper',       muddy:'Black / Blue' },
    blade_vibe:           { clear:'Chrome / Silver',       stained:'Gold / Copper',       muddy:'Black / Blue' },
    flutter_spoon:        { clear:'Shattered Glass Silver',stained:'Shattered Glass Silver',muddy:'Shattered Glass Silver' },
    swimbait_paddle:      { clear:'Blueback Herring',      stained:'Chartreuse / White',  muddy:'Dark Shad' },
    spinnerbait:          { clear:'White / UV',            stained:'Chartreuse / White',  muddy:'Black / Blue' },
    chatterbait:          { clear:'Natural Pearl / Smoke', stained:'Chartreuse / White',  muddy:'Black / Blue' },
    vertical_jig:         { clear:'Chrome / Blue',          stained:'Chartreuse / Chrome', muddy:'Gold / Chartreuse' },
    inline_spinner:       { clear:'White / Silver Blade',   stained:'Chartreuse / Gold',   muddy:'Black / Copper' },
    bucktail:             { clear:'Natural Pearl / Smoke', stained:'Chartreuse / White',  muddy:'Black / Blue' },
    marabou_jig:          { clear:'Natural Pearl / Smoke', stained:'Chartreuse / White',  muddy:'Black / Blue' },
    road_runner:          { clear:'White / UV',            stained:'Chartreuse / White',  muddy:'Black / Blue' },
    topwater_troll:       { clear:'Bone / Natural',        stained:'White / UV',          muddy:'Black / Blue' },
    topwater_cast:        { clear:'Bone / Natural',        stained:'White / UV',          muddy:'Black / Blue' },
    jighead:              { clear:'Natural Pearl / Smoke', stained:'Chartreuse / White',  muddy:'Black / Blue' },
    cast_only:            { clear:'Natural Pearl / Smoke', stained:'Chartreuse / White',  muddy:'Black / Blue' },
    underspin:            { clear:'Blueback Herring',      stained:'Chartreuse / White',  muddy:'Dark Shad' },
    spoon_casting:        { clear:'Silver / Chrome',       stained:'Gold / Brass',        muddy:'Shattered Glass' },
    jig_football:         { clear:'Green Pumpkin',         stained:'Green Pumpkin Candy', muddy:'Black / Blue' },
    jig_finesse_ned:      { clear:'Green Pumpkin',         stained:'Coppertreuse',        muddy:'Black / Blue' },
    popping_cork:         { clear:'Natural Shrimp',        stained:'Vudu Orange',         muddy:'Gulp Chartreuse' },
};

export function getLureColor(lureType, clarityKey) {
  const c = clarityKey || 'clear';
  return LURE_COLORS[lureType]?.[c] || 'Natural Pearl / Smoke';
}

// ── Jighead selection ─────────────────────────────────────────────────────────

export function getJigheadForDepth(availableWeights, targetDepthFt, speedMph = 1.8) {
  if (!availableWeights?.length) return null;
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


// ── Depth: one source, three modes ────────────────────────────────────────────
//
// Ryan's rule, 2026-08-02: "for things that have fixed depths by category —
// crankbaits — saying that a SR runs 3-5ft makes sense, it is printed right on
// the bill. Almost everything else directly depends on speed and lineout.
// Sinking lures you slow down and they are going to go to the bottom."
//
// So depth is a STORED number only when someone printed it on the lure. Everything
// else is a function of weight, speed and lead. Storing the result of that function
// is what put dive depths in three files (tackle-inventory.js, lure-knowledge.js and
// spread-builder.js's name-keyed LURE_DIVE_DEPTHS) and let them drift apart.
//
//   'rated'   the lip/leader fixes it. Band comes from ratedDepth. Casting and
//             trolling agree, because the lip does not care how it got there.
//   'lead'    sinking bait. depth = f(lead, speed, weight) via leadRatio.
//   'surface' on top. ratedDepth is 0-1ft and lead is a flat setback.
//
// leadRatio is feet of lead per foot of depth, seeded from the numbers
// autoCalculateLead() already used so this refactor changes NO behaviour. The
// ratios are working values, not measurements — calibrate against sonar before
// treating any of them as fact.

// speedAffectsLead was, until 2026-08-03, a faithful reproduction of a quirk in the
// old autoCalculateLead(): it multiplied by a speed factor for the three A-rig
// branches ONLY, and ignored speed for spoons, crankbaits and the default branch.
// The refactor that lifted these numbers deliberately preserved it, on the grounds
// that moving the numbers and changing them in the same pass makes both unreviewable.
//
// Ryan settled it: "the faster you go the more line you have to out." So every
// depthMode:'lead' type now has it true, and the A-rigs are the rule rather than the
// exception. Rated baits stay false on purpose — a crankbait's depth is its bill, and
// its speed is a hard cap (nothing over 3 mph) rather than a lead input.
//
// speedFactor itself is still a three-step function, not a curve, and STILL
// UNCALIBRATED. It says 15% more line above 2.2 mph and 12% less below 1.6. That
// shape is a working value inherited from autoCalculateLead, not a measurement.

function speedFactor(speedMph) {
  const s = speedMph || 2.4;                    // autoCalculateLead's default
  return s > 2.2 ? 1.15 : s < 1.6 ? 0.88 : 1.0;
}

// ── Weight ────────────────────────────────────────────────────────────────────
// Depth for a sinking bait scales with weight, and leadRatio alone could not say
// so: a 1/8oz Road Runner and a 1oz jighead both claimed 30ft, which is nonsense.
//
// The exponent is not invented. Two independent derivations agree:
//   * fitting ratio = C * w^-a across all 21 entries of the old name-keyed
//     LURE_DIVE_DEPTHS table                      -> a = 0.391  (R2 0.745)
//   * the A-rig series alone, which came from autoCalculateLead and reflects
//     Ryan's actual working leads rather than that table
//                                                 -> a = 0.412
// Different sources, written at different times by different means, landing 5%
// apart. Call it 0.4.
//
// The residuals are structured rather than random, and that structure is the
// argument for keeping a per-type ratio as well: the model runs 5-10ft DEEP on
// A-rigs (five baits of drag) and 10-13ft SHALLOW on spoons and diamond jigs
// (dense, low drag). Weight is universal physics; drag belongs to the shape. So
// weight gets one exponent and each shape keeps its own constant.
//
// STILL UNCALIBRATED against sonar. A defensible shape with a working constant,
// not a measurement.
const WEIGHT_EXPONENT = 0.4;

/** Scale a ratio quoted at refOz to the actual weight. Heavier needs less lead. */
function applyWeight(ratio, weightOz, refOz) {
  if (!weightOz || weightOz <= 0) return ratio;
  return ratio * Math.pow(weightOz / refOz, -WEIGHT_EXPONENT);
}

function resolveLeadRatio(lr, { weightOz, targetDepthFt }) {
  if (lr == null) return 4.0;
  // A plain number is a ratio quoted at refOz (default 1oz); scale by weight.
  if (typeof lr === 'number') return applyWeight(lr, weightOz, 1.0);
  if (lr.base != null) return applyWeight(lr.base, weightOz, lr.refOz ?? 1.0);
  if (lr.byWeightOz) {
    const pts = lr.byWeightOz;
    if (weightOz == null) return pts[Math.floor(pts.length / 2)][1];
    let best = pts[0];
    for (const p of pts) if (Math.abs(p[0] - weightOz) < Math.abs(best[0] - weightOz)) best = p;
    return best[1];
  }
  if (lr.byDepthFt) {
    for (const [cap, v] of lr.byDepthFt) if (cap == null || targetDepthFt <= cap) return v;
  }
  return 4.0;
}

/**
 * Feet of lead to put the lure at targetDepthFt. Replaces autoCalculateLead()'s
 * substring matching on the display name with a type lookup plus weight.
 */
export function leadForDepth(lure, targetDepthFt, speedMph) {
  const k = LURE_KNOWLEDGE[lure?.type];
  if (!k) return Math.round(targetDepthFt * 4.0);
  if (k.depthMode === 'surface') return 80;                 // flat-line topwater setback
  // A rated bait CANNOT be leaded past its bill. The old autoCalculateLead would
  // happily hand an SR crankbait 76ft of lead for a 20ft target, which buys you
  // nothing but a longer tangle -- it still runs 3-5ft.
  if (k.depthMode === 'rated' && k.ratedDepth) {
    targetDepthFt = Math.min(targetDepthFt, k.ratedDepth.max);
  }
  const ratio = resolveLeadRatio(k.leadRatio, { weightOz: lure.weightOz, targetDepthFt });
  const sf = k.speedAffectsLead ? speedFactor(speedMph) : 1;
  return Math.round(targetDepthFt * ratio * sf);
}

/**
 * Where this lure actually runs. `rated` returns the printed band regardless of
 * lead. `lead` inverts leadForDepth. `surface` is the top.
 * Returns { min, max, mode, controlledBy }.
 */
export function depthWindow(lure, { speedMph, leadFt } = {}) {
  const k = LURE_KNOWLEDGE[lure?.type];
  if (!k) return { min: null, max: null, mode: 'unknown', controlledBy: 'unknown' };
  if (k.depthMode !== 'lead') {
    const d = k.ratedDepth || { min: 0, max: 1 };
    return { ...d, mode: k.depthMode,
             controlledBy: k.depthMode === 'surface' ? 'surface' : 'the lure itself' };
  }
  if (leadFt == null) {
    return { min: null, max: null, mode: 'lead', controlledBy: 'lead length + speed + weight' };
  }
  const sf = speedFactor(speedMph);
  const guess = d => leadForDepth(lure, d, speedMph);
  let lo = 0, hi = 120;                                     // invert numerically; ratio may be banded
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (guess(mid) < leadFt) lo = mid; else hi = mid;
  }
  const d = Math.round(lo);
  return { min: Math.max(0, d - 2), max: d + 2, mode: 'lead',
           controlledBy: 'lead length + speed + weight', speedFactor: sf };
}

/**
 * Which jighead to clip on a paddle tail, and how much lead it then needs.
 *
 * Two independent constraints, and they fail differently:
 *   * DEPTH wants the lightest head that still reaches, because a head heavier
 *     than the job kills the action for nothing.
 *   * HOOK SIZE caps how heavy you may go at all, by the bait's length. Exceed it
 *     and the hook tears the plastic apart.
 *
 * When the cap is what stops you, `cappedBy` is 'length' and the fix is a longer
 * bait -- reporting that as "cannot reach depth" would send you looking for more
 * weight, which is exactly the thing that destroys the bait.
 *
 * Weight is not cosmetic here: leadRatio 4.0 is quoted at 1oz and scales by
 * w^-0.4, so a 1/4oz head needs ~74% more lead than a 1oz head for the same depth.
 */
export const JIGHEADS_OWNED_OZ = [0.25, 0.375, 0.5, 0.75, 1.0, 1.25, 1.5];

export function jigheadCapOz(lengthIn, type = 'swimbait_paddle') {
  const table = LURE_KNOWLEDGE[type]?.jigheadMaxOzByLengthIn;
  if (!table) return Infinity;
  if (lengthIn == null) return table[table.length - 1][1];   // unknown length: least restrictive
  for (const [cap, maxOz] of table) if (cap == null || lengthIn <= cap) return maxOz;
  return table[table.length - 1][1];
}

export function jigheadForSwimbait(swimbait, targetDepthFt, speedMph, opts = {}) {
  // Returns null for anything that is not a paddle tail. Without this the function
  // defaults the type and happily prices a jighead for a crankbait -- and the caller
  // in spread-builder, which uses a truthy result to override the lead, would then
  // hand every lure in the box a swimbait's lead.
  if (!LURE_KNOWLEDGE[swimbait?.type]?.jigheadMaxOzByLengthIn) return null;
  const maxLeadFt = opts.maxLeadFt ?? 120;
  const heads = [...(opts.jigheads || JIGHEADS_OWNED_OZ)].sort((a, b) => a - b);
  const cap = jigheadCapOz(swimbait?.lengthIn, swimbait?.type || 'swimbait_paddle');
  const legal = heads.filter(w => w <= cap);
  const lead = w => leadForDepth({ type: swimbait?.type || 'swimbait_paddle', weightOz: w },
                                 targetDepthFt, speedMph);

  if (!legal.length) {
    return { weightOz: null, leadFt: null, capOz: cap, cappedBy: 'length',
             note: `no owned jighead is light enough for a ${swimbait?.lengthIn}" bait` };
  }
  for (const w of legal) {
    const l = lead(w);
    if (l <= maxLeadFt) return { weightOz: w, leadFt: l, capOz: cap, cappedBy: null, note: null };
  }
  const w = legal[legal.length - 1];
  return {
    weightOz: w, leadFt: lead(w), capOz: cap,
    cappedBy: cap < heads[heads.length - 1] ? 'length' : 'lead',
    note: cap < heads[heads.length - 1]
      ? `${cap}oz is the most a ${swimbait?.lengthIn}" bait will carry — go to a longer swimbait for ${targetDepthFt}ft`
      : `even ${w}oz needs more than ${maxLeadFt}ft of lead at ${targetDepthFt}ft`
  };
}

/** True when depth comes from lead rather than from the lure. */
export function isLeadControlled(lure) {
  return LURE_KNOWLEDGE[lure?.type]?.depthMode === 'lead';
}

/**
 * Can this lure be put at this depth, at this speed, within the lead you are
 * willing to run? Returns what stops you, if anything.
 *
 * This replaces "is the boat speed inside the lure's window?" as the feasibility
 * question, because for everything except a lipped bait the speed window was never
 * the real constraint.
 */
export function canReachDepth(lure, depthFt, speedMph, { maxLeadFt } = {}) {
  const k = LURE_KNOWLEDGE[lure?.type];
  if (!k) return { ok: false, limitedBy: 'unknown lure type' };

  if (k.speedIsHardLimit && speedMph > k.speed.max) {
    return { ok: false, limitedBy: 'speed',
             detail: `${k.label} runs outside its rated depth above ${k.speed.max}mph` };
  }
  if (k.depthMode === 'surface') return { ok: depthFt <= 2, leadFt: 80, limitedBy: null };
  if (k.depthMode === 'rated') {
    const within = depthFt >= k.ratedDepth.min && depthFt <= k.ratedDepth.max;
    return { ok: within, leadFt: leadForDepth(lure, depthFt, speedMph),
             limitedBy: within ? null : 'rating',
             detail: within ? null : `${k.label} is rated ${k.ratedDepth.min}-${k.ratedDepth.max}ft` };
  }
  const leadFt = leadForDepth(lure, depthFt, speedMph);
  if (maxLeadFt != null && leadFt > maxLeadFt) {
    return { ok: false, leadFt, limitedBy: 'lead',
             detail: `needs ${leadFt}ft of lead, limit is ${maxLeadFt}ft — slow down or go heavier` };
  }
  return { ok: true, leadFt, limitedBy: null };
}


/* ==============================================================================================
 * TERMINAL CONNECTION — whether a lure may hang off a swivel snap.
 *
 * This is not a preference and it is not about convenience. Ryan, 2026-08-07:
 *
 *   "certain lures should not have a swivel snap added to them because the weight and the extra
 *    metal messes with it... crankbaits, topwater, spinnerbaits, buzz baits... lipless crankbaits
 *    it effect less... for the swivel snap i use those with A-rig, spoons, the spoon trolling rig
 *    that has a trolling weight tied on, blade baits, bladed jigs (chatterbait), bucktails"
 *
 * The snap adds mass and hardware right at the nose, which kills the action of anything that
 * swims on its own lip or blade. So it is a property of the LURE, and the app can enforce it
 * rather than hoping the model remembers.
 *
 * WHY IT MATTERS TO A PLAN: four of the six rods carry a 20 lb fluoro leader and two carry swivel
 * snaps, permanently. A lure that cannot take a snap must therefore be TIED to one of the four,
 * and changing it later costs a knot. Which two rods end up in the water is a consequence of this
 * — pick two deep divers and the snap rods sit behind the seat all day; pick a spoon and an A-rig
 * and the leader rods do.
 *
 *   'snap'  — fine on a swivel snap. May go on either kind of rod.
 *   'tie'   — must be tied direct. Leader rods only.
 *   'either'— the snap measurably affects it less. Ryan said this of lipless crankbaits only.
 *
 * Every type in the inventory as of 2026-08-07 has been ruled on by Ryan directly. Anything ADDED
 * later and not listed defaults to 'tie', which is the safe direction: tying a lure on never
 * hurts how it swims, and clipping the wrong one does. `unratedTypes()` names any such gaps so
 * they get answered rather than quietly assumed.
 * ============================================================================================ */

export const TERMINAL_CONNECTION = {
  // Ryan's snap list, verbatim: A-rig, spoons, the spoon trolling rig with a trolling weight tied
  // on, blade baits, bladed jigs (chatterbait), bucktails.
  umbrella_rig: 'snap',
  flutter_spoon: 'snap',
  spoon_casting: 'snap',
  blade_vibe: 'snap',
  chatterbait: 'snap',
  bucktail: 'snap',

  // "crankbaits, topwater, spinnerbaits, buzz baits" — buzzbaits live under topwater_cast here.
  crankbait_sr: 'tie', crankbait_mr: 'tie', crankbait_squarebill: 'tie',
  crankbait_dd1: 'tie', crankbait_dd2: 'tie', crankbait_dd3: 'tie', crankbait_dd4: 'tie',
  topwater_troll: 'tie', topwater_cast: 'tie',
  spinnerbait: 'tie',

  // "lipless crankbaits it effect less"
  lipless: 'either',

  // Ruled on individually, 2026-08-07, going down the inventory.
  cast_only: 'tie',            // Senko, plastic worm, creature bait, fluke
  jig_finesse_ned: 'tie',
  jig_football: 'tie',
  inline_spinner: 'snap',      // Rooster Tail
  jighead: 'snap',             // "those go with swimbaits so swivel snap"
  swimbait_paddle: 'snap',     // same answer as the jigheads they ride on
  marabou_jig: 'snap',         // "just a weird spoon to me lol"
  popping_cork: 'snap',
  road_runner: 'snap',
  underspin: 'snap',
  vertical_jig: 'snap',
};

/**
 * THE CONSTRAINT THAT ACTUALLY BITES. Ryan, 2026-08-07:
 *
 *   "honestly i am going to choose the rod and put the right bait on it... the only way this can
 *    get screwed up is if you try to do 6 things that all should be direct tie... that would
 *    require me to cut off the swivel snap, tie on a leader, and then tie the leader to the lure
 *    — prefer not to do that on the water... night before different story."
 *
 * Four leader rods and two snap rods. So a loadout is legal as long as no more than FOUR of the
 * six lures must be tied direct; the other two can be anything, because a snap rod will take a
 * snap-friendly lure and a leader rod will take anything at all. Five ties means cutting a snap
 * off in a moving kayak.
 */
export const MAX_TIE_ONLY = 4;

/** 'snap' | 'tie' | 'either' — unlisted types are 'tie'. See the note above. */
export function connectionFor(lureType) {
  return TERMINAL_CONNECTION[lureType] || 'tie';
}

/** Can this lure hang off one of the two snap rods? */
export function canTakeSnap(lureType) {
  return connectionFor(lureType) !== 'tie';
}

/**
 * The lure types nobody has ruled on yet, so the gap is visible instead of hiding inside the
 * 'tie' default. Pass the inventory; get back the types it holds that are not in the table.
 */
export function unratedTypes(inventory) {
  const out = new Set();
  for (const l of (inventory || [])) {
    if (l && l.type && !(l.type in TERMINAL_CONNECTION)) out.add(l.type);
  }
  return [...out].sort();
}
