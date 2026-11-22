/**
 * tackle-colors.js -- the colours Ryan has of each lure in the tackle box, and how many of each.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHERE THESE CAME FROM. Ryan photographed every bait he owns on 2026-11-21 (F:\TrollMapPipeline\lure_photos):
 * the bagged soft plastics by the front of the package, the hard baits laid out on a board with a tape, and some
 * tackle boxes shot as they are. Claude read every photo; Ryan corrected the lists
 * (claude/LURE_INVENTORY_SOFT_PLASTICS_2026-11-21.md) and then checked all 260 hard baits one by one on the
 * "Tackle Box Check" page (claude/LURE_REVIEW_CHECKED_2026-11-22.md: 228 right, 32 fixed). This file is those lists.
 * APP_CHANGE_REQUESTS item 88; his ask, 11/19: "the app tackle box doesn't track color but it probably should. That
 * would help with lure assignments from the llm during the plan creation".
 *
 * Each entry is [colour, count]. The count is how many of that colour he has, as read off the package or counted on
 * the board; null where nobody counted (the boxes he shot as they are: "you should be able to tell what is in them not
 * necessarily the count... and that is ok"). A colour named on a package is the package's name for it; anything else is
 * what the bait looks like, in his words where he gave them ("Pink Lemonade").
 *
 * WHAT THE PLAN DOES WITH THEM: picks the lure as before, then a colour from that lure's list, never one he would have
 * to buy (the design he agreed 11/19). A lure with no list here gets no colour from his box, and the plan says the
 * colour it names is a suggestion.
 *
 * Loose plastics in his trays are not here, on purpose: "im not counting the tackle trays full of loose baits that was
 * the whole point of leaving them in there". Nor is the shad box: "the shad box is for catching shad in feb/march...
 * dont really need help planning".
 */

export const COLORS_BY_ID = {
  // ── Crankbaits ────────────────────────────────────────────────────────────────────────────────
  cb_squarebill: [['chartreuse/green w/ black bars', 1], ['chartreuse w/ black dot', 1]],
  cb_sr: [['silver w/ blue back (shad)', 1], ['silver w/ green back', 1], ['pearl, red gill', 1], ['firetiger', 1],
    ['red/orange w/ black back', 2], ['red craw', 1], ['pearl w/ blue back', 3], ['green shad', 1],
    ['clown', 1], ['yellow perch', 1], ['brown/gold', 1], ['ghost shad', 1], ['pearl w/ green back', 1],
    ['chartreuse w/ black spots', 1], ['tan/brown w/ black back', 1], ['grey ghost', 1]],
  cb_mr: [['chartreuse/purple sexy shad', 1], ['firetiger', 1], ['chartreuse', 1], ['sexy shad', 1],
    ['blue back/chartreuse', 1], ['orange craw', 2], ['silver/black, orange throat', 1]],
  cb_dd1: [['chartreuse/blue, orange throat', 1], ['chrome/black', 1], ['bone', 1], ['bluegill', 1],
    ['brown/yellow perch', 1]],
  cb_micro: [['black', 1], ['red/black', 1], ['white w/ red head', 1], ['gold/black', 1], ['tan/brown cricket', 1],
    ['bluegill', 1]],
  cb_knockoff_10ft: [['pink/pearl', 3], ['silver w/ dark back', 1], ['firetiger', 2], ['pearl, red throat', 1],
    ['silver, pink head', 2], ['pearl, red throat, black dot', 1], ['ghost silver w/ gold back', 1],
    ['rainbow trout', 2], ['silver, red throat', 1], ['pearl w/ green back', 1], ['Pink Lemonade', 2],
    ['pearl/purple', 1], ['silver w/ blue back, red eye', 1]],
  cb_flicker_9d: [['orange throat, silver/green back', 1]],
  cb_flicker_11d: [['silver w/ dark back', 1], ['firetiger', 1], ['purple head, silver', 1]],
  cb_hitstick_9: [['red head, white w/ pink dots', 1]],
  cb_hitstick_12: [['gold/orange w/ black back', 3], ['green/black back', 1], ['Pink Lemonade', 2]],
  cb_bandit_wd: [['chartreuse back/silver', 1], ['purple/teal w/ chartreuse spots', 1], ['pearl', 1],
    ['orange, red throat', 1], ['orange head, perch w/ green spots', 1], ['chrome w/ blue back, orange belly', 1],
    ['chartreuse w/ black dot', 1], ['pink head, white', 1]],
  cb_reef_runner_800: [['Chrome Joker', 1]],
  cb_bomber_b24a: [['white w/ black-red spots', 2], ['purple w/ white spots', 1], ['orange/ghost', 1],
    ['chartreuse w/ pink flowers', 1]],
  cb_bomber_bd7f: [['ghost/pearl holographic', 1]],
  cb_ultradiver_80: [['chartreuse/white', 1], ['green back, pink belly', 1]],
  cb_ultradiver_65: [['orange/purple clear', 1]],
  cb_ultradiver_50: [['green back, pink belly', 1]],
  cb_rapala_jdhj12: [['firetiger', 1]],
  cb_yozuri_cmdd130: [['black back, clear crystal sides', 1]],
  cb_deep_minnow: [['chartreuse/blue tiger', 1], ['clear ghost', 1]],
  cb_jointed_minnow: [['gold/bone', 1]],
  cb_jerkbait: [['firetiger', 1]],
  cb_jointed_swimbait: [['natural perch bars', 1]],

  // ── Lipless, blade baits and tail spinners ──────────────────────────────────────────────────
  lipless_2in: [['chartreuse/green w/ black bars', 1], ['brown/gold perch', 1], ['black w/ blue lines', 3],
    ['firetiger', 1], ['blue back/silver', 1], ['red', 1], ['black/silver glitter, chartreuse tail', 1],
    ['silver/pink', 2], ['silver/green', 1], ['silver', 1], ['gold', 1], ['chrome, red tail', 1],
    ['chartreuse/silver', 1], ['rootbeer', 1], ['chartreuse/blue', 1]],
  lipless_3in: [['firetiger', 1], ['chrome w/ black back', 2], ['pearl ghost, purple belly', 1],
    ['chartreuse/olive scale back', 1], ['olive/black glitter back, chartreuse belly', 1], ['red craw', 4], ['plum', 1],
    ['red w/ black spots', 1], ['maroon', 1], ['ghost blue back, orange throat', 1], ['chrome/gold head', 1],
    ['blue/gold', 1], ['fall craw', 1], ['blue back chrome', 3], ['chartreuse/green scale', 1], ['olive fishbone', 1],
    ['blue/chartreuse w/ white bars', 1], ['white w/ red gills', 1], ['silver/orange belly', 1],
    ['green w/ black stripes', 1], ['bluegill', 1], ['blue back chartreuse scale', 1], ['gold/orange', 1],
    ['pink/white', 1], ['chartreuse/black scale', 1], ['red/black/orange', 1], ['sexy shad', 1], ['purple/pink', 1],
    ['gold, red throat', 1], ['blue/black tiger, chartreuse head', 1]],
  lipless_super_pogy: [['hi-p mullet', 1]],
  blade_3in: [['white/pearl', 1], ['black w/ white scale (skull)', 1], ['gold', 3]],
  // Ryan, 11/22, of his Amazon order: "1/2 oz tail spinner". The red one is in the set by my read; he marked it right.
  ts_half: [['red head/white', 1], ['chartreuse', 1], ['white, red eye', 1], ['chartreuse scale', 1],
    ['blue head/chartreuse', 1], ['chartreuse/green', 1], ['red', 1]],
  ts_small: [['brown/gold glitter', 1], ['silver/brown', 1], ['blue/silver shad', 1], ['black', 1],
    ['blue back/white', 1], ['pale chartreuse/silver', 1], ['chartreuse/black perch bars', 1],
    ['silver w/ black dots', 1], ['silver scale, red eye', 1], ['chartreuse w/ green spots', 1], ['white, red eye', 1],
    ['chartreuse firetiger, purple blade', 1], ['white w/ red head', 1], ['chartreuse perch', 1],
    ['chartreuse/orange', 1]],
  ts_large: [['firetiger', 1], ['chartreuse firetiger', 4], ['chartreuse tiger', 1]],

  // ── Soft plastics on a jighead ──────────────────────────────────────────────────────────────
  swimbait_3_0in: [['Live Threadfin', 8], ['Live Gizzard Shad', 8], ['Live Menhaden', 8], ['Bluegill Flash', 10],
    ['pearl/lavender (pre-rigged 1/4 oz)', 2], ['Pearl Red Eye (pre-rigged 1/4 oz)', 5],
    ['Perch (pre-rigged 1/4 oz)', 5]],
  swimbait_3in: [['blue-black back, silver', 4], ['Orange Pearl', 2], ['green/chartreuse flake', 6],
    ['dark w/ gold flake', 3], ['blue-purple back, pearl belly', 4], ['clear/silver', 4], ['white/pearl', 5],
    ['rootbeer/orange tail', 2], ['chartreuse/black bars', 2], ['blue/chartreuse bars', 2],
    ['blue/green back, silver, red gill', 7], ['green back, pink gill', 3], ['grey/silver shad', 1],
    ['green pumpkin/gold flake, orange tail', 5], ['brown/perch spots', 1], ['dark, chartreuse tail', 1],
    ['brown', 2]],
  swimbait_4_0in: [['Live Sardine', 12], ['Live Gizzard Shad', 6], ['Live Threadfin Shad', 6], ['Chartreuse/Pearl', 6],
    ['Plum/Chart Tail', 10], ['Butt Naked', 10], ['Pearl/Chart Tail', 10], ['brown/Lime Tail', 10],
    ['Plum/Chart Tail (Cocahoe)', null], ['Smallmouth Magic', 8], ['Silver Flash Minnow', 8], ['blue/black', 7],
    ['Flash', 7], ['Pinfish', 4], ['Bloody Mary Sunday', 5], ['Green Pumpkin Disco', 6], ['Sight Flash', 5],
    ['chartreuse/yellow', 1], ['brown/green pumpkin flake', 5], ['tan/gold flake', 2], ['brown/gold scale', 1],
    ['pearl/black flake', 1], ['smoke/purple', null], ['pearl', null], ['perch bars', null]],
  swimbait_4in: [['Green Pumpkin D', 5], ['pearl', 1], ['gold', 3], ['olive/gold', 1], ['green back', 1],
    ['silver shad', 1], ['pearl, orange tail', 1], ['silver, orange belly', 1], ['black back, gold sides', 6],
    ['dark green pumpkin flake', 1], ['dark green pumpkin/gold', null]],
  swimbait_5in: [['Purple Demon', 4], ['Mulletron', 4], ['Plum/Chart Tail', 8], ['Houdini', 6],
    ['Plum Chartreuse', 16], ['black/blue flake', null]],
  swimbait_6in: [['Smoky Shad', 4], ['pearl/gold flake (pre-rigged)', 1], ['yellow perch, pink glitter tail', 1],
    ['black/silver flake (on a 1 oz head)', 1], ['green pumpkin, orange belly', null]],
  swimbait_7in: [['mackerel, red tail', 2]],
  thin_tail_4in: [['tan/gold', 1]],
  cast_fluke_4in: [['black/dark green', 5]],
  cast_fluke_5in: [['Baitfish', null], ['The Deal', 4]],

  // ── Cast-only soft plastics ─────────────────────────────────────────────────────────────────
  cast_stickbait: [['Smallmouth Magic', 10], ['Junebug', 5], ['green pumpkin/blue flake', 6], ['dark plum flake', null],
    ['black/blue flake', null], ['cinnamon/red flake', null], ['rootbeer', null], ['black (ribbed)', null]],
  cast_worm_straight: [['Green Pumpkin Magic', 4], ['Sprayed Grass', 4], ['plum/blue flake', 5], ['Candy Bug', 8],
    ['Watermelon Red', 20], ['Baby Bass', 8], ['Plum Fleck', 8], ['Green Pumpkin', 20], ['Matte Junebug', 12],
    ['Junebug/Red Glitter', 12], ['black', 10], ['plum', 9], ['black/blue flake', 6], ['clear/white', 4],
    ['Watermelon Seed', 15], ['pearl/smoke', 8], ['plum/red', null]],
  cast_creature: [['black/dark green', 6], ['black/blue', 8], ['green pumpkin', null],
    ['green pumpkin/black flake', null], ['brown/purple flake', null], ['Green Pumpkin Gold', 7],
    ['light tan/green pumpkin', null], ['Summer Gill', 8], ['black/blue flake', 12], ['Black-Blue', 8],
    ['Tonic', 6], ['Junebug', 6], ['brown/red', null], ['plum', 8], ['dark green', null], ['plum/red', null],
    ['red/black', null]],
  jig_finesse_ned: [['red/plum', 6], ['black/blue', 6], ['Green Pumpkin', 6], ['Smoke Clear Purple Flake', null]],
  cast_flap_swimbait: [['Green Pumpkin Black Flake / Watermelon Red (3-1/4")', 6],
    ['copper/orange flake, chartreuse tail (6")', 8]],
  cast_ribbon_8in: [['Green Pumpkin PP/Blue', 7]],
  cast_feather_worm: [['June Bug', 5], ['dark green flake, purple feather', 6]],
  cast_leech: [['purple', null]],
  cast_shrimp: [['plum, chartreuse head', 2], ['smoke/black flake, chartreuse head', 2], ['clear/gold glitter', 3],
    ['rootbeer/orange, red head', 7], ['rootbeer/gold', null], ['black', null], ['chartreuse tiger', null],
    ['smoke', null], ['natural', null], ['pink speckle', null], ['grey, chartreuse tail', 4]],
  crappie_minnow: [['orange/rootbeer', null], ['pearl/orange', null], ['smoke/black', null], ['black/blue', null],
    ['green pumpkin', null]],
  crappie_tube: [['red', null], ['white', null], ['yellow', null], ['blue', null], ['orange', null]],
  crappie_grub: [['orange/red flake', null], ['red/chartreuse', null], ['rootbeer', null], ['pearl', null],
    ['chartreuse', null], ['green pumpkin flake', null]],
  crappie_paddle: [['green/chartreuse', null], ['pearl', null], ['smoke', null], ['teal', null]],
  crappie_marabou: [['brown', null], ['grey', null]],

  // ── Topwater ────────────────────────────────────────────────────────────────────────────────
  tw_walker: [['bone', 1]],
  // Ryan, 11/22, of the three I read as walking baits: "these have tail spinners that pop out".
  tw_prop: [['bone w/ green scale back', 1], ['silver shad', 1], ['gold/brown frog', 1], ['red head/silver', 1],
    ['chartreuse/green', 1], ['spotted trout', 1], ['bone w/ chartreuse head', 1],
    ['black/white snakeskin, pink head', 1]],
  // and of the jointed bait I read as a wake bait: "plopper not wake".
  tw_plopper: [['black w/ chartreuse fin', 1], ['black/silver scale', 1], ['yellow tiger', 1], ['green tiger', 1],
    ['red w/ black bars', 1], ['silver w/ black back', 1], ['clear w/ red head', 1], ['black', 1], ['blue/silver', 1],
    ['green firetiger', 1], ['lavender/purple', 1]],
  tw_plopper_small: [['gold/orange', 1], ['chartreuse glow', 1], ['pink', 1], ['silver', 1],
    ['blue back, pink belly', 1], ['purple holographic', 1], ['rootbeer/orange', 1], ['chartreuse w/ green back', 1],
    ['gold perch', 1]],
  tw_popper: [['silver/pearl, red eye', 1], ['firetiger', 1], ['red head/silver', 1], ['gold w/ black spots', 1],
    ['bone w/ teal head', 1], ['black/white (Hula Popper)', 1], ['frog (Hula Popper)', 1],
    ['white w/ red head (Hula Popper)', 1]],
  tw_jitterbug: [['black/silver', 1]],

  // ── Spinnerbaits, bladed jigs, spinners ─────────────────────────────────────────────────────
  // NONE IS MARKED WITH A WEIGHT. Ryan, 11/21: "i am not going to go weigh each type". 3/8 oz is the common size, and
  // the one clearly small one is put at 1/4.
  spinner_3eighth: [['chartreuse w/ black-green bars', 1], ['chartreuse/blue-green bars', 5], ['white/blue', 1],
    ['chartreuse, red head', 5], ['orange/yellow w/ green bars', 1], ['yellow/olive barred', 1],
    ['pink/orange, chartreuse head', 3], ['chartreuse/brown-green bars', 2], ['red/yellow/orange', 1],
    ['yellow/orange, white head', 1], ['pink/orange/red, chartreuse head', 1], ['white/brown barred', 1],
    ['brown/black', 1], ['pale chartreuse/white', 2], ['chartreuse/green barred', 3], ['white/chartreuse, red eye', 1],
    ['chartreuse/orange/green', 1], ['chartreuse/grey barred', 1], ['white/black barred', 1], ['black/red (night)', 1],
    ['fire red/orange/yellow', 2], ['tan/brown', 1], ['yellow/orange w/ green bars', 1],
    ['brown/olive/tan barred, chartreuse head', 2], ['red/black', 1], ['yellow w/ black bars, white head', 1],
    ['yellow/orange w/ black bars', 1], ['black', 1], ['red/black w/ brown trailer', 1], ['white/cream', 1],
    ['brown/orange', 1], ['chartreuse', 1]],
  spinner_quarter: [['orange/chartreuse', 1]],
  chatter_3eighth: [['green pumpkin, black trailer', 1], ['black/blue', 1], ['blue/chartreuse', 1]],
  jig_swim: [['black/blue', 2]],
  inline_small: [['chartreuse dotted, brown tail', 1], ['chartreuse dotted, olive tail', 1],
    ['chartreuse/green, yellow tail', 1], ['yellow marabou', 1], ['yellow, brown tail', 1],
    ['white, brown tail', 1], ['silver blade', 1]],
  road_runner_quarter: [['chartreuse (beetle spin)', 1]],
  underspin_painted: [['firetiger', 3], ['perch', 1]],

  // ── Bucktails, spoons, metal ────────────────────────────────────────────────────────────────
  // The head weights are my read off head size, given to him 11/22; he did not correct them.
  bucktail_shark_shooter: [['white, white head, red eye', 1], ['pink, pink head', 1],
    ['white, pink head (tied under the popping cork)', 1]],
  bucktail_3oz: [['blue/black, gold perch head', 1]],
  bucktail_1oz: [['white, red throat', 1]],
  bucktail_3quarter: [['tan, silver head', 1], ['black/white', 2]],
  bucktail_soft_jerk: [['firetiger/green', 1]],
  popping_cork_rig: [['orange cork', 1]],
  // Ryan, 11/22: the 4" is "nichols lake fork flutter spoon in shattered glass", the 5" "super shad".
  spoon_3quarter: [['shattered glass', 1]],
  spoon_nichols_118: [['super shad', 1]],
  // One of each size, 11/22 (his tape: 3.75" and 4"). The name is P-Line's own for it, PLM-04.
  spoon_laser_minnow_2oz: [['Chartreuse Silver Blue', 1]],
  spoon_laser_minnow_3oz: [['Chartreuse Silver Blue', 1]],
  tsj_30g: [['blue holographic w/ black dots', 1], ['white/pearl, red head', 1], ['silver scale, red head', 1],
    ['silver scale, red eye', 1], ['chartreuse scale', 1]],
  spoon_small_cast: [['silver/blue (Kastmaster)', 1], ['silver, red bead, orange tube', 1], ['brass', 1],
    ['gold, red bead', 1], ['gold (Kastmaster)', 1], ['yellow/black', 1], ['silver/blue w/ feather', 1],
    ['silver, red head, feather', 1]],
};
