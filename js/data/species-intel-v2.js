/**
 * species-intel-v2.js — TrollMap Trolling-First Multi-Species Brain
 * South Carolina – Freshwater reservoirs + inshore salt
 *
 * Replaces species-intel.js depthBand/lures[] with:
 *   preferredMethod, seasonal{ structure, presentation, lureFamilies,
 *   preferredDepth, preferredSpeed, leadDistance, ... }
 *
 * Drop-in: smart-plan.js reads preferredDepth / preferredPresentation /
 * preferredSpeed with a 6-line adapter (see smart-plan-adapter.patch)
 *
 * Author: TrollMap / Ryan – kayak trolling-first
 * Updated: 2026-07-03
 */

export const REGULATIONS = {
  lastVerified: '2026-07-03',
  source: 'SCDNR Freshwater + Saltwater regs, Title 50 Ch.13',
  // … keep your existing REGULATIONS block from v1, add below …
  'Lake Wateree': {
    'Striped Bass': { closedSeason:null, creelLimit:null, sizeLimit:null, note:'Stocked striper-only, verify statewide limit', stocked:true },
    'Largemouth Bass': { creelLimit:5, sizeLimit:{min:14}, note:'14" min, 5/day – statewide black bass' },
    'Crappie': { creelLimit:null, sizeLimit:null, note:'No size/bag limit statewide' },
    'Blue Catfish': { creelLimit:null, sizeLimit:null, note:'No limit – statewide catfish' },
    'Channel Catfish': { creelLimit:null, sizeLimit:null },
    'Flathead Catfish': { creelLimit:null, sizeLimit:null },
    'Bowfin': { creelLimit:null, sizeLimit:null, note:'Nongame – no limit' },
    'Chain Pickerel': { creelLimit:null, sizeLimit:null },
  },
  'Lake Murray': {
    'Striped Bass': { creelLimit:5, sizeLimit:{byMonth:{1:{min:21},2:{min:21},3:{min:21},4:{min:21},5:{min:21},6:{min:null},7:{min:null},8:{min:null},9:{min:null},10:{min:21},11:{min:21},12:{min:21}}}, note:'5/day combined striper+hybrid' },
  },
  'Lake Marion': {
    'Striped Bass': { closedSeason:[6,16,9,30], creelLimit:2, sizeLimit:{min:23,max:25,exception:'one fish per day may exceed 26 inches'}, note:'Santee Cooper slot – CLOSED Jun16-Sep30' },
  },
  'Lake Moultrie': {
    'Striped Bass': { closedSeason:[6,16,9,30], creelLimit:2, sizeLimit:{min:23,max:25,exception:'one fish per day may exceed 26 inches'} },
  },
  'Coastal SC Inshore': {
    'Red Drum (Redfish)': { creelLimit:3, sizeLimit:{min:15,max:23}, note:'SC slot 15-23", 3/day, 1 over 23" prohibited – check current' },
    'Speckled Trout (Spotted Seatrout)': { creelLimit:10, sizeLimit:{min:14}, note:'14" TL min, 10/day – verify cold-stun closures' },
    'Flounder': { creelLimit:5, sizeLimit:{min:16}, note:'Southern Flounder – verify seasonal closure, was closed Nov-Dec historically' },
  }
};

// ── helpers ─────────────────────────────────────────────
export function getSeason(date) {
  const month = (date instanceof Date ? date : new Date(date)).getMonth()+1;
  if (month>=6 && month<=8) return 'summer';
  if (month>=9 && month<=11) return 'fall';
  if (month===12 || month<=2) return 'winter';
  return 'spring';
}
export const TOD = { DAWN:'dawn', DAY:'day', DUSK:'dusk', NIGHT:'night' };
export function getTimeOfDay(t) { if(!t) return TOD.DAY; const h=parseInt(String(t).split(':')[0],10); if(isNaN(h)) return TOD.DAY; if(h<8)return TOD.DAWN; if(h<17)return TOD.DAY; if(h<20)return TOD.DUSK; return TOD.NIGHT; }
// ── lake key resolver + regulations check (ported from species-intel.js v1)
export function resolveLakeKey(lakeName, table) {
  if (!lakeName) return null;
  if (table[lakeName]) return lakeName;
  const stripped = lakeName.replace(/,\s*[A-Za-z]{2}$/, '').trim();
  if (table[stripped]) return stripped;
  const lower = stripped.toLowerCase();
  const found = Object.keys(table).find((k) => {
    const kl = k.toLowerCase();
    return lower.includes(kl) || kl.includes(lower);
  });
  return found || null;
}

export function checkRegulations(lakeName, species, date) {
  const key = resolveLakeKey(lakeName, REGULATIONS);
  const lakeRegs = key ? REGULATIONS[key] : null;
  if (!lakeRegs || !lakeRegs[species]) {
    return { legal: true, reason: null, regInfo: null, note: 'No specific regulation data available — verify locally before fishing.' };
  }
  const reg = lakeRegs[species];
  if (reg.notPresent) {
    return { legal: false, reason: reg.note, regInfo: reg };
  }
  if (reg.closedSeason) {
    const [sm, sd, em, ed] = reg.closedSeason;
    const d = date instanceof Date ? date : new Date(date);
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const mdVal = month * 100 + day;
    const startVal = sm * 100 + sd;
    const endVal = em * 100 + ed;
    const inClosedWindow = startVal <= endVal
      ? (mdVal >= startVal && mdVal <= endVal)
      : (mdVal >= startVal || mdVal <= endVal);
    if (inClosedWindow) {
      return { legal: false, reason: `Closed season: ${reg.note}`, regInfo: reg };
    }
  }
  return { legal: true, reason: null, regInfo: reg };
}

// ── SPECIES BEHAVIOR V2 ──────────────────────────────────
// structure keys used throughout:
// preferredMethod, preferredStructure[], preferredPresentation[],
// lureFamilies[], preferredColors[], preferredDepth:[min,max],
// preferredSpeed:[min,max], leadDistance:[min,max],
// rodArchitecture, reactionStrike:boolean,
// waterClarity[], forage[], confidence{}, notes[], fallbackPresentation[]

const baseSCReservoir = (overrides={})=>({
  preferredMethod:'trolling',
  waterClarity:['clear','stained'],
  reactionStrike:false,
  rodArchitecture:'M/MH Spinning / 30lb braid + 20lb fluoro leader',
  confidence:{source:'Literature',evidence:['SCDNR / guide reports']},
  ...overrides
});

export const SPECIES_BEHAVIOR_V2 = {

  /* ══════════════ STRIPED BASS ══════════════ */
  'Striped Bass': {
    'Lake Wateree': {
      summer: baseSCReservoir({
        preferredStructure:['channel_ledge','humps','creek_channel_swing','bridge','main_lake_points'],
        preferredPresentation:['umbrella_rig_medium','deep_diving_crankbait','flutter_spoon','bucktail'],
        lureFamilies:['A-Rig','Deep Crankbait','Flutter Spoon','Bucktail'],
        preferredColors:['Blueback Herring','Pearl','Sexy Shad','Chrome'],
        preferredDepth: (tempF)=> tempF>84 ? [18,24] : [14,22],
        preferredSpeed:[1.8,2.5],
        leadDistance:[45,80],
        reactionStrike:true,
        forage:['threadfin_shad','blueback_herring'],
        confidence:{source:'Field Validated',evidence:['Carolina Sportsman guide interviews – Heinning, Whiteside','Repeated catches by user – Wateree trolling']},
        notes:['Thermocline 16-20ft Aug – fish scatter to ledges mid-morning','Early AM 12-15ft topwater/schooling window','Umbrella rig 1/4oz jigheads + 4-5" trailers – match shad size']
      }),
      fall: baseSCReservoir({
        preferredStructure:['creek_mouth','channel_edge','secondary_points'],
        preferredPresentation:['medium_crankbait','umbrella_rig_medium','bucktail'],
        lureFamilies:['Medium Crankbait','A-Rig','Bucktail'],
        preferredDepth:[10,20],
        preferredSpeed:[1.8,2.2],
        notes:['Shad migration – fish push shallower as water cools','Schooling action common dusk/dawn']
      }),
      winter: baseSCReservoir({
        preferredStructure:['channel','deep_humps','bridge_pilings'],
        preferredPresentation:['jigging_spoon','bucktail_slow','live_shad_downline'],
        lureFamilies:['Flutter Spoon','Hair Jig'],
        preferredDepth:[15,30],
        preferredSpeed:[1.0,1.5],
        reactionStrike:false,
        notes:['Slower presentation – suspended deeper – use electronics']
      }),
      spring: baseSCReservoir({
        preferredStructure:['points','creek_mouths','flats_near_channel'],
        preferredPresentation:['topwater_walker','medium_crankbait','swimbait_jighead','live_herring_freeline'],
        lureFamilies:['Topwater','Medium Crankbait','Swimbait'],
        preferredDepth:[5,15],
        preferredSpeed:[1.5,2.0],
        notes:['Pre/post spawn shallow push']
      }),
      fallbackPresentation:['jigging_spoon_vertical','live_bait_downline']
    },
    'Lake Murray': {
      summer: baseSCReservoir({
        preferredStructure:['thermocline_30ft','dam_basin','humps','channel_ledges'],
        preferredPresentation:['umbrella_rig','live_herring_downline','flutter_spoon'],
        lureFamilies:['A-Rig','Flutter Spoon'],
        preferredDepth:[28,36],
        preferredSpeed:[1.2,1.8],
        notes:['Two groups: suspended near 30ft thermocline, and deep/bottom 70-100ft near dam','Free-line one rod early, topwater other – both kayak fishable']
      }),
      spring: baseSCReservoir({
        preferredStructure:['creek_backs','shallow_points','buffalo_creek_mouth','rocky_creek_mouth'],
        preferredPresentation:['casting_plug','a_rig_light','fluke','free_line_herring'],
        lureFamilies:['Medium Crankbait','A-Rig Light','Fluke'],
        preferredDepth:[3,15],
        preferredSpeed:[1.5,1.8],
        notes:['Herring spawn Apr-May – Buffalo/Rocky Creek mouths key']
      }),
      fall: baseSCReservoir({ preferredStructure:['creek_mouths','points'], preferredPresentation:['a_rig_medium','crankbait'], lureFamilies:['A-Rig','Crankbait'], preferredDepth:[10,25], preferredSpeed:[1.5,2.0]}),
      winter: baseSCReservoir({ preferredStructure:['upper_lake','channel'], preferredPresentation:['live_shad','jigging_spoon'], lureFamilies:['Flutter Spoon'], preferredDepth:[15,30], preferredSpeed:[1.0,1.3], notes:['Follow threadfin shad upper lake']}),
    },
    'Lake Marion': {
      summer: baseSCReservoir({ preferredStructure:['pinopolis_dam','deep_holes_40_55ft'], preferredPresentation:['live_herring_downline','bucktail'], lureFamilies:['Bucktail','Live Bait'], preferredDepth:[40,55], preferredSpeed:[1.0,1.5], notes:['VERIFY SEASON – CLOSED Jun16-Sep30 Santee system'], confidence:{source:'Regulation Critical',evidence:['SCDNR Santee Cooper closure']}}),
      winter: baseSCReservoir({ preferredStructure:['humps','ledges'], preferredPresentation:['bucktail_jig','rockport_rattler','live_blueback_herring'], lureFamilies:['Bucktail','Hair Jig'], preferredDepth:[20,50], preferredSpeed:[1.2,1.5], notes:['December prime – vary jig color chartreuse/white – mark fish, drop slightly above']}),
      fall: baseSCReservoir({ preferredStructure:['open_water_schools','points'], preferredPresentation:['bucktail','jig_plastic_trailer','topwater'], lureFamilies:['Bucktail','Topwater'], preferredDepth:[20,40], preferredSpeed:[1.5,1.8]}),
      spring: baseSCReservoir({ preferredStructure:['congaree_river_run','wateree_river_run','diversion_canal','deep_holes'], preferredPresentation:['live_herring','cut_bait'], lureFamilies:['Live Bait'], preferredDepth:[10,30], preferredSpeed:[1.0,1.3], notes:['Spawning run – fish concentrated']}),
    },
    'Lake Moultrie': { /* mirrors Marion, slightly more open water */
      summer: baseSCReservoir({ preferredStructure:['pinopolis_dam','open_water_40_50ft'], preferredPresentation:['topwater_dawn','bucktail','live_herring_bottom'], lureFamilies:['Topwater','Bucktail','Live Bait'], preferredDepth:[40,50], preferredSpeed:[1.2,1.5], notes:['CLOSED Jun16-Sep30 – verify']}),
      winter: baseSCReservoir({ preferredStructure:['dam_area','humps'], preferredPresentation:['bucktail_jig','live_menhaden'], lureFamilies:['Bucktail'], preferredDepth:[20,50], preferredSpeed:[1.2,1.5], notes:['Menhaden migrate via lock/fish lift – 3-finger size preferred']}),
      fall: baseSCReservoir({ preferredStructure:['ledges','points'], preferredPresentation:['bucktail','live_herring_downline'], preferredDepth:[20,40], preferredSpeed:[1.2,1.5]}),
      spring: baseSCReservoir({ preferredStructure:['pre_spawn_staging','diversion_canal_approach'], preferredPresentation:['live_herring'], preferredDepth:[10,30], preferredSpeed:[1.0,1.3]}),
    }
  },

  /* ══════════════ LARGEMOUTH BASS ══════════════ */
  'Largemouth Bass': {
    'default_SC_reservoir': {
      spring: baseSCReservoir({
        preferredStructure:['secondary_points','creek_arms','laydowns','docks','grass_edge','riprap'],
        preferredPresentation:['medium_crankbait','spinnerbait','chatterbait','swimbait_jighead'],
        lureFamilies:['Medium Crankbait','Spinnerbait','Chatterbait','Swimbait'],
        preferredColors:['Sexy Shad','Chartreuse/White','Firetiger','Bluegill'],
        preferredDepth:[4,12],
        preferredSpeed:[1.8,2.4],
        leadDistance:[40,65],
        reactionStrike:true,
        forage:['bluegill','shad','crawfish'],
        notes:['Troll secondary points and creek channel swings – cover water','Deflection off wood/rock triggers reaction'],
        fallbackPresentation:['texas_rig','wacky_rig','jig_n_pig']
      }),
      summer: baseSCReservoir({
        preferredStructure:['offshore_humps','deep_points','dock_shade','grass_lines','bridge_pilings'],
        preferredPresentation:['deep_crankbait','swimbait_jighead','spinnerbait_slow'],
        lureFamilies:['Deep Crankbait','Swimbait','Spinnerbait'],
        preferredDepth:[8,18],
        preferredSpeed:[1.6,2.2],
        notes:['Early/late low-light topwater window – buzzbait / walker trolled with popping cork','Mid-day deep – 10-18ft']
      }),
      fall: baseSCReservoir({
        preferredStructure:['creek_mouths','flats','points','bait_schools'],
        preferredPresentation:['lipless_crankbait','spinnerbait','medium_crankbait','chatterbait'],
        lureFamilies:['Lipless Crankbait','Spinnerbait','Chatterbait'],
        preferredDepth:[3,10],
        preferredSpeed:[2.0,2.6],
        reactionStrike:true,
        notes:['Bait migration – aggressive chasing – faster troll effective']
      }),
      winter: baseSCReservoir({
        preferredStructure:['channel_bluffs','deep_docks','bridge','steep_points'],
        preferredPresentation:['jigging_spoon_slow','swimbait_slow_roll','hair_jig'],
        lureFamilies:['Flutter Spoon','Swimbait','Hair Jig'],
        preferredDepth:[12,25],
        preferredSpeed:[1.2,1.6],
        reactionStrike:false,
        notes:['Slow down – vertical capable but troll slow along bluff walls'],
        fallbackPresentation:['ned_rig','drop_shot','jig_n_pig']
      })
    }
  },

  /* ══════════════ WHITE BASS / HYBRID ══════════════ */
  'White Bass / Hybrid': {
    'default_SC_reservoir': {
      spring: baseSCReservoir({
        preferredStructure:['wind_blown_points','river_runs','creek_mouths','shoals'],
        preferredPresentation:['inline_spinner','small_crankbait','road_runner','swimbait_3in'],
        lureFamilies:['Inline Spinner','Road Runner','Small Crankbait','Swimbait'],
        preferredDepth:[4,12],
        preferredSpeed:[2.0,2.8],
        reactionStrike:true,
        notes:['Schooling – when you find one, circle/work area – aggressive chasers – perfect trolling target'],
        confidence:{source:'Field Validated',evidence:['SC reservoir schooling behavior – user validated']}
      }),
      summer: baseSCReservoir({
        preferredStructure:['main_lake_humps','channel_edges','open_water_bait'],
        preferredPresentation:['small_flutter_spoon','inline_spinner','small_crankbait'],
        preferredDepth:[12,25],
        preferredSpeed:[2.0,2.6]
      }),
      fall:{ preferredStructure:['creek_mouths','points'], preferredPresentation:['inline_spinner','lipless_crankbait'], preferredDepth:[5,15], preferredSpeed:[2.2,2.8]},
      winter:{ preferredStructure:['deep_channel','river_bends'], preferredPresentation:['jigging_spoon','hair_jig'], preferredDepth:[20,35], preferredSpeed:[1.2,1.6], reactionStrike:false }
    }
  },

  /* ══════════════ CRAPPIE ══════════════ */
  'Crappie': {
    'default_SC_reservoir': {
      spring: baseSCReservoir({
        preferredMethod:'trolling',
        preferredStructure:['brush_piles','docks','laydowns','bridge_pilings','stake_beds'],
        preferredPresentation:['road_runner','hair_jig','small_swimbait_jighead','trolling_spider_rig_slow'],
        lureFamilies:['Road Runner','Hair Jig','Small Swimbait'],
        preferredColors:['Chartreuse/White','Pink/White','Monkey Milk','Electric Chicken'],
        preferredDepth:[3,8],
        preferredSpeed:[0.8,1.4],
        leadDistance:[25,50],
        reactionStrike:false,
        notes:['Slow troll – 0.8-1.3mph ideal – brush pile hopping – use 2 rods staggered depth','Best SC trolling crappie technique – long line road runners'],
        fallbackPresentation:['vertical_jig','slip_float']
      }),
      summer: baseSCReservoir({ preferredStructure:['deep_brush','bridge','timber','channel_edges'], preferredPresentation:['hair_jig','road_runner_deep'], preferredDepth:[12,22], preferredSpeed:[0.7,1.2]}),
      fall: baseSCReservoir({ preferredStructure:['docks','brush','creek_channels'], preferredPresentation:['road_runner','hair_jig'], preferredDepth:[6,14], preferredSpeed:[0.9,1.4]}),
      winter: baseSCReservoir({ preferredStructure:['deep_brush','bridge_pilings','standing_timber'], preferredPresentation:['hair_jig_vertical','small_spoon'], preferredDepth:[15,28], preferredSpeed:[0.5,1.0], notes:['Near-vertical slow troll / controlled drift']})
    }
  },

  /* ══════════════ BLUE CATFISH ══════════════ */
  'Blue Catfish': {
    'default_SC_reservoir': {
      summer: baseSCReservoir({
        preferredMethod:'trolling',
        preferredStructure:['channel_ledges','humps','deep_flats','river_channel'],
        preferredPresentation:['santee_cooper_rig_dragging','cut_bait_slow_troll','deep_diving_crankbait_incidental'],
        lureFamilies:['Cut Bait','Santee Rig'],
        preferredDepth:[15,35],
        preferredSpeed:[0.5,1.0],
        notes:['Slow drift / slow troll dragging cut shad / herring – Santee Cooper rig – 0.5-0.8mph – rod holders – clickers on','Santee Cooper lakes (Marion/Moultrie) = world class blue cats'],
        reactionStrike:false,
        fallbackPresentation:['anchor_cut_bait']
      }),
      spring:{ preferredStructure:['flats_near_channel','creek_mouths'], preferredPresentation:['cut_bait_dragging'], preferredDepth:[8,20], preferredSpeed:[0.4,0.8]},
      fall:{ preferredStructure:['channel_edges','humps'], preferredPresentation:['cut_bait_dragging'], preferredDepth:[15,30], preferredSpeed:[0.5,0.9]},
      winter:{ preferredStructure:['deep_holes','channel_bends','dam_area'], preferredPresentation:['cut_bait_anchor','slow_drag'], preferredDepth:[25,55], preferredSpeed:[0.3,0.6]}
    }
  },
  'Channel Catfish': {
    'default_SC_reservoir': {
      // similar to Blue but shallower, more willing to chase
      spring: baseSCReservoir({ preferredStructure:['flats','creek_mouths','riprap'], preferredPresentation:['santee_rig_dragging','spinnerbait_slow_incidental','crankbait_incidental'], preferredDepth:[4,14], preferredSpeed:[0.6,1.2], notes:['Channel cats will absolutely crush trolled crankbaits / spinnerbaits – more aggressive than blues']}),
      summer:{ preferredStructure:['channel_edges','flats'], preferredPresentation:['cut_bait_dragging'], preferredDepth:[10,25], preferredSpeed:[0.5,1.0]},
      fall:{ preferredStructure:['points','flats'], preferredPresentation:['cut_bait_dragging','crankbait'], preferredDepth:[6,18], preferredSpeed:[0.8,1.3]},
      winter:{ preferredStructure:['deep_holes'], preferredPresentation:['cut_bait_anchor'], preferredDepth:[20,40], preferredSpeed:[0.3,0.6]}
    }
  },
  'Flathead Catfish': {
    'default_SC_reservoir': {
      // nocturnal ambush – trolling less effective, but included
      spring: baseSCReservoir({ preferredMethod:'anchor/finesse', preferredStructure:['wood','timber','boulders','bridge_pilings'], preferredPresentation:['live_bluegill','live_bream'], preferredDepth:[5,20], preferredSpeed:[0,0.3], notes:['Flatheads = live bait ambush – not a primary trolling target – included for completeness – set live bluegill on Santee rig and SLOW drift 0.2-0.4mph max at night'], reactionStrike:false, fallbackPresentation:['anchor_live_bait_night']}),
      summer:{ preferredStructure:['deep_wood','timber','ledges'], preferredPresentation:['live_bream','live_shad'], preferredDepth:[12,30], preferredSpeed:[0,0.4]},
      fall:{ preferredStructure:['wood','channel_bends'], preferredPresentation:['live_bait'], preferredDepth:[10,25], preferredSpeed:[0,0.4]},
      winter:{ preferredStructure:['deep_holes','timber'], preferredPresentation:['live_bait_slow'], preferredDepth:[25,45], preferredSpeed:[0,0.3]}
    }
  },

  /* ══════════════ BOWFIN ══════════════ */
  'Bowfin': {
    'default_SC_reservoir': {
      spring: baseSCReservoir({
        preferredStructure:['lily_pads','grass_edge','wood','backwater_slough','creek_mouth','cypress_knees'],
        preferredPresentation:['medium_diving_crankbait','deep_diving_crankbait','spinnerbait','chatterbait','paddle_tail'],
        lureFamilies:['Medium Crankbait','Deep Crankbait','Spinnerbait','Chatterbait','Paddle Tail','Swim Jig'],
        preferredColors:['Firetiger','Chartreuse/White','Black/Blue','White'],
        preferredDepth:[4,10],
        preferredSpeed:[1.4,2.0],
        leadDistance:[35,55],
        reactionStrike:true,
        waterClarity:['stained','dirty'],
        forage:['bluegill','shad','crawfish'],
        confidence:{source:'Field Validated',evidence:['Repeated catches by user trolling crankbaits – SC reservoirs','31 of 47 bowfin caught trolling medium/deep diving crankbaits']},
        notes:['Highly aggressive reaction feeder – will chase moving lures farther than most anglers expect','Excellent trolling target around submerged vegetation and wood','Often strikes diving crankbaits intended for striped bass','Do NOT sit – cover water – move pocket to pocket','User-validated: medium/deep diving crankbaits OUTPERFORM frogs/spinnerbaits for trolling bowfin in SC'],
        fallbackPresentation:['topwater_frog_casting','swim_jig_pitch']
      }),
      summer:{ preferredStructure:['grass_mats','lily_pads','shaded_wood','backwater'], preferredPresentation:['spinnerbait','chatterbait','paddle_tail','buzzbait'], preferredDepth:[2,8], preferredSpeed:[1.3,1.8], notes:['Low light / shade – thick vegetation edges']},
      fall:{ preferredStructure:['grass_edge','wood','creek_backs'], preferredPresentation:['spinnerbait','medium_crankbait','chatterbait'], preferredDepth:[3,9], preferredSpeed:[1.5,2.0]},
      winter:{ preferredStructure:['deep_sloughs','canal_bends','warm_water_discharge'], preferredPresentation:['slow_roll_spinnerbait','jig_n_pig'], preferredDepth:[6,14], preferredSpeed:[1.0,1.4], reactionStrike:false }
    }
  },

  /* ══════════════ CHAIN PICKEREL ══════════════ */
  'Chain Pickerel': {
    'default_SC_reservoir': {
      spring: baseSCReservoir({
        preferredStructure:['grass_edge','lily_pads','wood','docks','creek_backs'],
        preferredPresentation:['inline_spinner','spinnerbait','jerkbait_trolled_slow','paddle_tail'],
        lureFamilies:['Inline Spinner','Spinnerbait','Jerkbait','Paddle Tail'],
        preferredColors:['Firetiger','Gold','Silver/Black','Chartreuse'],
        preferredDepth:[3,8],
        preferredSpeed:[1.6,2.2],
        leadDistance:[40,60],
        reactionStrike:true,
        notes:['Ambush – vegetation edges – likes flash/vibration – wire leader recommended – will absolutely crush trolled spinnerbaits'],
        fallbackPresentation:['jerkbait_cast','inline_spinner_cast']
      }),
      summer:{ preferredStructure:['deep_grass_edge','shade','docks'], preferredPresentation:['spinnerbait','paddle_tail'], preferredDepth:[5,12], preferredSpeed:[1.5,2.0]},
      fall:{ preferredStructure:['grass','wood','points'], preferredPresentation:['spinnerbait','jerkbait','inline_spinner'], preferredDepth:[3,9], preferredSpeed:[1.8,2.3], reactionStrike:true },
      winter:{ preferredStructure:['deep_vegetation_edge','canals','warm_pockets'], preferredPresentation:['jerkbait_slow','hair_jig'], preferredDepth:[6,14], preferredSpeed:[1.2,1.6], reactionStrike:false }
    }
  },

  /* ══════════════ RED DRUM (REDFISH) – INSHORE ══════════════ */
  'Red Drum (Redfish)': {
    'Coastal SC Inshore': {
      spring: baseSCReservoir({
        preferredMethod:'trolling',
        preferredStructure:['oyster_bars','creek_mouths','grass_edges','dock_pilings','channel_edges'],
        preferredPresentation:['paddle_tail_jighead_trolled','gold_spoon_slow','swimbait'],
        lureFamilies:['Paddle Tail','Gold Spoon','Swimbait','Gulp Shrimp'],
        preferredColors:['Rootbeer/Gold','New Penny','White','Chartreuse'],
        preferredDepth:[2,6],
        preferredSpeed:[1.2,2.0],
        leadDistance:[30,50],
        waterClarity:['clear','stained'],
        forage:['mullet','shrimp','crab','mud_minnows'],
        notes:['Slow troll creek edges and oyster bar drop-offs – 1.2-1.8mph – popping cork with live shrimp/mullet also deadly','Incoming tide – push up onto flats – outgoing – stage at creek mouths'],
        confidence:{source:'Literature + Inshore Guide Consensus',evidence:['SCDNR inshore creel','Charleston inshore guide reports']},
        fallbackPresentation:['popping_cork_live_shrimp','cut_mullet_bottom']
      }),
      summer:{ preferredStructure:['grass_flats','docks_shade','oyster_rakes'], preferredPresentation:['paddle_tail','topwater_early','gold_spoon'], preferredDepth:[1,5], preferredSpeed:[1.0,1.8], notes:['Early morning topwater – flood tide tailing']},
      fall:{ preferredStructure:['creek_mouths','j etties','oyster_bars','beach_troughs'], preferredPresentation:['mullet_imitation_swimbait','gold_spoon','paddle_tail','cut_mullet'], lureFamilies:['Swimbait','Gold Spoon','Paddle Tail'], preferredDepth:[2,8], preferredSpeed:[1.4,2.2], reactionStrike:true, notes:['Fall bull red run – big mullet pattern – gold spoon / mullet swimbait trolled along beach troughs and inlet edges – PRIME TIME']},
      winter:{ preferredStructure:['deep_holes','creek_bends','dock_pilings','warm_water_discharge'], preferredPresentation:['g u l p_shrimp_slow','paddle_tail_slow'], preferredDepth:[4,12], preferredSpeed:[0.8,1.3], reactionStrike:false, notes:['Schools stacked deep – slow and subtle']}
    }
  },

  /* ══════════════ SPECKLED TROUT ══════════════ */
  'Speckled Trout (Spotted Seatrout)': {
    'Coastal SC Inshore': {
      spring: baseSCReservoir({
        preferredMethod:'trolling',
        preferredStructure:['grass_edges','oyster_bars','creek_mouths','dock_lights','drop_offs'],
        preferredPresentation:['paddle_tail_jighead','mirrodine_twitch_trolled','gulp_shrimp_popping_cork'],
        lureFamilies:['Paddle Tail','Twitchbait','Gulp Shrimp'],
        preferredColors:['Opening Night','New Penny','Pearl/Chartreuse','Electric Chicken'],
        preferredDepth:[2,6],
        preferredSpeed:[1.0,1.8],
        leadDistance:[30,50],
        notes:['Troll grass edges and oyster bar drop-offs slow – 1.0-1.5mph – trout suspend – keep bait ABOVE them','Popping cork with live shrimp / Voodoo shrimp deadly – can slow-troll corks'],
        fallbackPresentation:['popping_cork_live_shrimp','twitchbait_cast']
      }),
      summer:{ preferredStructure:['deep_grass_edges','channel_drop_offs','bridge_pilings','dock_lights_night'], preferredPresentation:['paddle_tail','gulp_shrimp'], preferredDepth:[4,10], preferredSpeed:[0.9,1.5]},
      fall:{ preferredStructure:['creek_mouths','oyster_bars','flats'], preferredPresentation:['paddle_tail','mirrodine','topwater_early'], preferredDepth:[2,6], preferredSpeed:[1.2,1.8], reactionStrike:true, notes:['Fall feed – aggressive – shrimp migration']},
      winter:{ preferredStructure:['deep_holes','canals','warm_water_discharge','creek_bends'], preferredPresentation:['mirrolure_slow_suspend','gulp_shrimp_slow'], preferredDepth:[6,14], preferredSpeed:[0.6,1.2], reactionStrike:false, notes:['Cold-stun risk – check SCDNR closures – very slow presentation']}
    }
  }

  // ── Tier 2 stubs – fill same pattern ──
  // 'Bluegill': { 'default_SC_reservoir': { … } },
  // 'Redear Sunfish (Shellcracker)': { … },
  // 'Warmouth': { … },
  // 'White Perch': { … },
  // 'Longnose Gar': { … },
  // 'Gar': { … },
};

// ── Adapter: expose v1-compatible lookup so smart-plan.js keeps working
// during migration. Translates V2 → {depthBand, lures[], speed, notes}
export function getBehaviorV1Compat(species, lake, season, timeOfDay){
  const sp = SPECIES_BEHAVIOR_V2[species];
  if(!sp) return null;
  const lakeData = sp[lake] || sp['default_SC_reservoir'] || sp['Coastal SC Inshore'];
  if(!lakeData) return null;
  const s = lakeData[season];
  if(!s) return null;
  const depth = Array.isArray(s.preferredDepth) ? s.preferredDepth : [5,15];
  const speed = Array.isArray(s.preferredSpeed) ? s.preferredSpeed[0] : (s.preferredSpeed||2.0);
  return {
    depthBand: depth,
    lures: s.preferredPresentation || [],
    speed,
    notes: (s.notes||[]).join(' · '),
    _v2: s // full v2 object attached for new planner code
  };
}

// Re-export v1 helpers for drop-in compat
export { getSeason, getTimeOfDay, resolveLakeKey } from './species-intel.js'; // or inline copy
// NOTE: in production, copy checkRegulations() fully from v1 – stub above is placeholder

// ── Bluegill / Redear Sunfish (Shellcracker) ───────────────────────────────
// Confirmed trolling targets at SC small ponds (Prestwood Lake etc.) on
// 2" lipless cranks. Slow pass along shoreline structure, not a deep sweep.
// Ryan confirmed: "I get plenty of bream/shellcracker in Prestwood on
// 2 inch lipless cranks — works great trolling honestly."
SPECIES_BEHAVIOR_V2['Bluegill'] = {
  default_SC_reservoir: {
    spring: {
      preferredStructure: ['shoreline_flats','dock_edges','submerged_vegetation','gravel_beds'],
      preferredPresentation: ['lipless_crankbait','inline_spinner','road_runner'],
      lureFamilies: ['lipless crankbait','inline spinner','road runner'],
      preferredDepth: [1, 6], // tight to structure, shallow
      preferredSpeed: [0.8, 1.3],
      leadDistance: [20, 35],
      preferredColors: ['Bright','chartreuse/white'],
      notes: ['Slow, tight shoreline pass — hug the bank edge · 2" lipless crank proven at Prestwood · Spawning beds = gravel/hard bottom shallow', 'Speed at low end of range — fast enough to deflect off bottom structure, slow enough for short-striking fish'],
      confidence: { source: 'Angler-confirmed – Prestwood Lake SC 2024-2026', level: 'high' },
      reactionStrike: true,
    },
    summer: {
      preferredStructure: ['dock_shade','deeper_vegetation_edge','channel_adjacent_flats'],
      preferredPresentation: ['road_runner','inline_spinner','lipless_crankbait'],
      lureFamilies: ['road runner','inline spinner'],
      preferredDepth: [3, 10],
      preferredSpeed: [0.7, 1.1],
      leadDistance: [25, 40],
      notes: ['Move slightly deeper in heat — follow shaded dock edges · Early morning shoreline bite goes fast, transitions deeper by 9am'],
      confidence: { source: 'Standard SC panfish summer pattern', level: 'medium' },
      reactionStrike: true,
    },
    fall: {
      preferredStructure: ['shoreline_flats','points','vegetation_edges'],
      preferredPresentation: ['lipless_crankbait','inline_spinner'],
      lureFamilies: ['lipless crankbait','inline spinner'],
      preferredDepth: [2, 8],
      preferredSpeed: [0.9, 1.4], // slightly faster in fall — fish more active
      leadDistance: [20, 35],
      notes: ['Fall = active feeding push — slightly faster retrieve than summer · Follow shoreline contours around points'],
      confidence: { source: 'Standard SC panfish fall pattern', level: 'medium' },
      reactionStrike: true,
    },
    winter: {
      preferredStructure: ['deep_flats','channel_adjacent','sunny_shallows_midday'],
      preferredPresentation: ['road_runner','lipless_crankbait'],
      lureFamilies: ['road runner','lipless crankbait'],
      preferredDepth: [4, 12],
      preferredSpeed: [0.6, 0.9],
      leadDistance: [30, 45],
      notes: ['Slow way down — cold water fish much less aggressive · Midday sun-warmed shallows worth checking · Road Runner jig works well at low speed'],
      confidence: { source: 'Standard SC panfish winter pattern', level: 'medium' },
      reactionStrike: false,
    },
  },
};
// Shellcracker (Redear Sunfish) — same trolling approach as bluegill,
// slightly deeper and heavier cover preference (likes hard/shell bottom for
// the snail/clam diet, beds are on harder substrate than bluegill).
SPECIES_BEHAVIOR_V2['Redear Sunfish (Shellcracker)'] = {
  default_SC_reservoir: {
    spring: {
      preferredStructure: ['hard_bottom_flats','shell_substrate','dock_edges','gravel_beds'],
      preferredPresentation: ['lipless_crankbait','road_runner','inline_spinner'],
      lureFamilies: ['lipless crankbait','road runner'],
      preferredDepth: [2, 8],
      preferredSpeed: [0.8, 1.2],
      leadDistance: [20, 35],
      preferredColors: ['Bright','chartreuse/white'],
      notes: ['Shellcracker key = hard bottom – shell/gravel substrate preferred over soft mud · Spring spawn in deeper structure than bluegill – 3-8ft · Lipless crank ticking bottom is the move'],
      confidence: { source: 'Angler-confirmed – Prestwood Lake SC', level: 'high' },
      reactionStrike: true,
    },
    summer: {
      preferredStructure: ['deeper_flats','channel_edges','dock_shade'],
      preferredPresentation: ['road_runner','lipless_crankbait'],
      lureFamilies: ['road runner','lipless crankbait'],
      preferredDepth: [5, 12],
      preferredSpeed: [0.7, 1.0],
      leadDistance: [30, 45],
      notes: ['Deeper than bluegill in summer – follow hard bottom into 8-12ft range'],
      confidence: { source: 'Standard SC shellcracker pattern', level: 'medium' },
      reactionStrike: true,
    },
    fall: {
      preferredStructure: ['flats','points','hard_bottom'],
      preferredPresentation: ['lipless_crankbait','inline_spinner'],
      lureFamilies: ['lipless crankbait'],
      preferredDepth: [3, 10],
      preferredSpeed: [0.8, 1.3],
      leadDistance: [25, 40],
      notes: ['Fall feeding push – similar to spring activity · Hard bottom flats near points'],
      confidence: { source: 'Standard SC shellcracker pattern', level: 'medium' },
      reactionStrike: true,
    },
    winter: {
      preferredStructure: ['deep_holes','channel_adjacent','hard_bottom_deep'],
      preferredPresentation: ['road_runner','lipless_crankbait'],
      lureFamilies: ['road runner'],
      preferredDepth: [8, 18],
      preferredSpeed: [0.5, 0.8],
      leadDistance: [35, 50],
      notes: ['Deepest of the panfish in winter – follow hard bottom to 10-18ft · Very slow presentation required'],
      confidence: { source: 'Standard SC shellcracker pattern', level: 'medium' },
      reactionStrike: false,
    },
  },
};



console.log('[species-intel-v2] Trolling-first multi-species brain loaded – Tier 1: Striper, Largemouth, White Bass/Hybrid, Crappie, Blue Cat, Channel Cat, Flathead, Bowfin, Pickerel, Redfish, Trout, Bluegill/Shellcracker');
