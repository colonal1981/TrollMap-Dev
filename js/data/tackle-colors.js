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
 * Each entry is [colour, count] -- and, for a soft plastic, [colour, count, bag] (below). The count is how many of that colour he has, as read off the package or counted on
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
  // THE BAG IS THE THIRD FIELD. Ryan, 11/22: "for the ones that were in a package with a brand, color and size it would
  // be really nice if it called that out? that would make it easier for me to make sure the right bag is in my tackle
  // bag i bring on the water with me... most stay at home in the garage so i need to know what to grab". So each colour
  // of a soft plastic says the bag it is in: the brand, model and size printed on the package where it was read off
  // his photos ('?' where the label was worn), 'loose' for bodies with no package, and the box he shot as it is.
  swimbait_3_0in: [['Live Threadfin', 8, 'BioBait Shadow Swimmer 3"'], ['Live Gizzard Shad', 8, 'BioBait Shadow Swimmer 3"'],
    ['Live Menhaden', 8, 'BioBait Shadow Swimmer 3"'], ['Bluegill Flash', 10, 'Keitech Easy Shiner 3"'],
    ['pearl/lavender (pre-rigged 1/4 oz)', 2, 'Z-Man HerculeZ 3"'], ['Pearl Red Eye (pre-rigged 1/4 oz)', 5, 'Berkley PowerBait Swim Shad 3"'],
    ['Perch (pre-rigged 1/4 oz)', 5, 'Berkley PowerBait Swim Shad 3"']],
  swimbait_3in: [['blue-black back, silver (pre-rigged)', 4, '"Winnow 95" 3.75" (brand torn off)'],
    ['Orange Pearl', 2, 'Berkley PowerBait Ripple Shad 3.5"'], ['green/chartreuse flake', 6, 'LunkerHunt Hive Seeker Swimbait 3.5"'],
    ['dark w/ gold flake', 3, '"Flable Shad" 3.5" (Japanese pack)'], ['blue-purple back, pearl belly', 4, 'Big Bite Baits Suicide Shad 3.5"'],
    ['clear/silver', 4, 'LunkerHunt Hive Versa Fish 3.5"'], ['white/pearl', 5, 'Missile Baits Bomb Shad 3.5" (label faded)'],
    ['rootbeer/orange tail (rigged on 3/8 oz)', 2, 'Bass Pro Crappie Maxx Paddle-Tail Minnow'],
    ['chartreuse/black bars (rigged)', 2, 'Bass Pro Crappie Maxx Paddle-Tail Minnow'],
    ['blue/chartreuse bars (rigged)', 2, 'Bass Pro Crappie Maxx Paddle-Tail Minnow'],
    ['blue/green back, silver, red gill', 7, 'loose'], ['green back, pink gill (on jigheads)', 3, 'loose'],
    ['grey/silver shad', 1, 'loose'], ['green pumpkin/gold flake, orange tail', 5, 'loose'], ['brown/perch spots', 1, 'loose'],
    ['dark, chartreuse tail', 1, 'loose'], ['brown', 2, 'loose (ribbed)']],
  swimbait_4_0in: [['Live Sardine', 12, 'BioBait Shadow Swimmer 4" (2 packs)'], ['Live Gizzard Shad', 6, 'BioBait Shadow Swimmer 4"'],
    ['Live Threadfin Shad', 6, 'BioBait Shadow Swimmer 4"'], ['Chartreuse/Pearl', 6, 'BioBait Shadow Swimmer 4"'],
    ['Plum/Chart Tail', 10, 'Saltwater Assassin Sea Shad 4"'], ['Butt Naked', 10, 'Saltwater Assassin Sea Shad 4"'],
    ['Pearl/Chart Tail', 10, 'Saltwater Assassin Sea Shad 4"'], ['brown/Lime Tail', 10, 'Saltwater Assassin Sea Shad 4"'],
    ['Plum/Chart Tail (Cocahoe)', null, 'H&H Queen Cocahoe Minnow 4"'], ['Smallmouth Magic', 8, 'Keitech Swing Impact 4"'],
    ['Silver Flash Minnow', 8, 'Keitech Swing Impact 4"'], ['blue/black', 7, 'Keitech Easy Shiner 4"'],
    ['Flash', 7, 'Keitech Easy Shiner 4" (color name worn)'], ['Pinfish', 4, 'Z-Man DieZel MinnowZ 4"'],
    ['Bloody Mary Sunday', 5, 'Z-Man DieZel MinnowZ 4"'], ['Green Pumpkin Disco', 6, 'Rapala CrushCity The Mayor 4"'],
    ['Sight Flash', 5, 'Berkley PowerBait PowerStinger 4.25"'], ['chartreuse/yellow', 1, 'loose'],
    ['brown/green pumpkin flake', 5, 'loose (segmented)'], ['tan/gold flake', 2, 'loose (ribbed)'], ['brown/gold scale', 1, 'loose'],
    ['pearl/black flake (on a jighead)', 1, 'loose'], ['smoke/purple', null, 'in the swimbait box'], ['pearl', null, 'in the swimbait box'],
    ['perch bars', null, 'in the swimbait box']],
  swimbait_4in: [['Green Pumpkin D', 5, 'Missile Baits Bomb Shad 4.5"'], ['pearl', 1, 'Truscend swimbait card 4.3-4.5"'],
    ['gold', 3, 'Truscend swimbait card 4.3-4.5"'], ['olive/gold', 1, 'Truscend swimbait card 4.3-4.5"'],
    ['green back', 1, 'Truscend swimbait card 4.3-4.5"'], ['silver shad', 1, 'Truscend swimbait card 4.3-4.5"'],
    ['pearl, orange tail', 1, 'Truscend swimbait card 4.3-4.5"'], ['silver, orange belly', 1, 'Truscend swimbait card 4.3-4.5"'],
    ['black back, gold sides', 6, 'loose (most on jigheads)'], ['dark green pumpkin flake', 1, 'loose'],
    ['dark green pumpkin/gold', null, 'in the swimbait box']],
  swimbait_5in: [['Purple Demon', 4, 'Z-Man DieZel MinnowZ 5"'], ['Mulletron', 4, 'Z-Man DieZel MinnowZ 5"'],
    ['Plum/Chart Tail', 8, 'Saltwater Assassin Sea Shad 5"'], ['Houdini', 6, 'Reaction Innovations Skinny Dipper'],
    ['Plum Chartreuse', 16, 'Down South Lures 5" (model not read), 2 packs'], ['black/blue flake', null, 'in the swimbait box']],
  swimbait_6in: [['Smoky Shad', 4, 'BioBait Shadow Swimmer 6"'], ['pearl/gold flake (pre-rigged)', 1, 'loose (belly treble)'],
    ['yellow perch, pink glitter tail', 1, 'loose'], ['black/silver flake', 1, 'loose (on a 1 oz head he set up)'],
    ['green pumpkin, orange belly', null, 'in the swimbait box']],
  swimbait_7in: [['mackerel, red tail', 2, 'loose (saltwater board)']],
  thin_tail_4in: [['tan/gold', 1, 'loose (ribbed)']],
  cast_fluke_4in: [['black/dark green', 5, 'loose (split tail)']],
  cast_fluke_5in: [['Baitfish', null, 'Zoom Salty Super Fluke'], ['The Deal', 4, 'Z-Man RaZor ShadZ']],

  // ── Cast-only soft plastics ─────────────────────────────────────────────────────────────────
  cast_stickbait: [['Smallmouth Magic', 10, 'Yamamoto Senko type (YAM-9FAT)'], ['Junebug', 5, 'Z-Man Turbo FattyZ'],
    ['green pumpkin/blue flake', 6, 'deps stick (model not read)'], ['dark plum flake', null, 'unknown, red and black bag'],
    ['black/blue flake', null, 'in the worm box'], ['cinnamon/red flake', null, 'in the worm box'], ['rootbeer', null, 'in the worm box'],
    ['black (ribbed)', null, 'in the worm box']],
  cast_worm_straight: [['Green Pumpkin Magic', 4, 'Rapala CrushCity Janitor 6"'], ['Sprayed Grass', 4, 'Rapala CrushCity Janitor 6"'],
    ['plum/blue flake', 5, 'Rapala CrushCity Janitor 6"'], ['Candy Bug', 8, 'Rapala CrushCity Janitor 6"'],
    ['Watermelon Red', 8, 'Rapala CrushCity Janitor 6"'], ['Baby Bass', 8, 'Rapala CrushCity Janitor 6"'],
    ['Watermelon Red (Nekorama)', 12, 'Big Bite Baits Nekorama 7"'], ['Matte Junebug', 12, 'Big Bite Baits Nekorama 7"'],
    ['Plum Fleck', 8, '6th Sense Divine Shakey Worm 7"'], ['Green Pumpkin', 20, 'Zoom Super Salt Plus Trick Worm'],
    ['Junebug/Red Glitter', 12, 'Bass Assassin Bang Tapout 7.5"'], ['black', 10, 'Jackall Flick Shake 4.8"'],
    ['plum', 9, 'Jackall ribbed finesse worm'], ['black/blue flake', 6, 'deps ribbed worm'], ['clear/white', 4, 'deps ribbed worm'],
    ['Watermelon Seed', 15, 'Zoom, Trick Worm? (code 019)'], ['pearl/smoke', 8, 'Big Bite Baits "…Thumper"'],
    ['plum/red', null, 'in the worm box']],
  cast_creature: [['black/dark green', 6, 'Fishlab Kickin Craw 3-1/2"'], ['black/blue', 8, 'Ozark Trail Creature Craw'],
    ['green pumpkin', null, 'Ozark Trail Creature Craw (label worn)'], ['green pumpkin (flat bait)', null, 'YUM flat bait'],
    ['green pumpkin/black flake', null, 'Jackall Jugg Pod 3.6" (2 packs)'], ['brown/purple flake', null, 'Jackall FIVOSS 3.0"'],
    ['Green Pumpkin Gold', 7, 'Keitech Crazy Flapper 3.6"'], ['light tan/green pumpkin', null, 'Keitech Crazy Flapper 2.8"'],
    ['Summer Gill', 8, 'YUM Christie Craw 3.5"'], ['black/blue flake', 12, 'YUM creature (2 packs)'],
    ['Black-Blue', 8, 'Berkley PowerBait Pit Boss 4"'], ['Tonic', 6, 'Berkley PowerBait MaxScent 3.5"'],
    ['Junebug', 6, 'Berkley PowerBait MaxScent 3.5"'], ['brown/red', null, 'deps lizard'], ['plum', 8, 'LunkerHunt finesse bait'],
    ['dark green', null, '1HD Tackle creature'], ['plum/red', null, 'in the worm box'], ['red/black', null, 'in the worm box']],
  jig_finesse_ned: [['red/plum', 6, 'Strike King Rage Ned Bug'], ['black/blue', 6, 'Strike King Rage Ned Bug'],
    ['Green Pumpkin', 6, 'Z-Man TRD CrawZ 2.5"'], ['Smoke Clear Purple Flake', null, 'Great Lakes Finesse Snack Craw 2.1"']],
  cast_flap_swimbait: [['Green Pumpkin Black Flake / Watermelon Red (3-1/4")', 6, 'Nories Escape Swim Twin 3-1/4"'],
    ['copper/orange flake, chartreuse tail (6")', 8, 'Gambler Flapp\'n Shad 6"']],
  cast_ribbon_8in: [['Green Pumpkin PP/Blue', 7, 'Keitech Mad Wag Long 8"']],
  cast_feather_worm: [['June Bug', 5, 'feather-tail ribbed worm (no brand read)'],
    ['dark green flake, purple feather', 6, 'feather-tail ribbed worm (no brand read)']],
  cast_leech: [['purple', null, 'Zaza Leech 3.8"']],
  cast_shrimp: [['plum, chartreuse head', 2, 'Z-Man Prawn StarZ 5" 1/2 oz (cards)'],
    ['smoke/black flake, chartreuse head', 2, 'Z-Man Prawn StarZ 5" 1/2 oz (cards)'], ['clear/gold glitter', 3, 'D.O.A. Shrimp 3" 1/4 oz'],
    ['rootbeer/orange, red head', 7, 'Vmsixvm rigged shrimp (small box)'], ['rootbeer/gold', null, 'in the shrimp box'],
    ['black', null, 'in the shrimp box'], ['chartreuse tiger', null, 'in the shrimp box'], ['smoke', null, 'in the shrimp box'],
    ['natural', null, 'in the shrimp box'], ['pink speckle', null, 'in the shrimp box'], ['grey, chartreuse tail', 4, 'in the shrimp box']],
  crappie_minnow: [['orange/rootbeer', null, 'in the crappie box'], ['pearl/orange', null, 'in the crappie box'],
    ['smoke/black', null, 'in the crappie box'], ['black/blue', null, 'in the crappie box'], ['green pumpkin', null, 'in the crappie box']],
  crappie_tube: [['red', null, 'in the crappie box'], ['white', null, 'in the crappie box'], ['yellow', null, 'in the crappie box'],
    ['blue', null, 'in the crappie box'], ['orange', null, 'in the crappie box']],
  crappie_grub: [['orange/red flake', null, 'in the crappie box'], ['red/chartreuse', null, 'in the crappie box'],
    ['rootbeer', null, 'in the crappie box'], ['pearl', null, 'in the crappie box'], ['chartreuse', null, 'in the crappie box'],
    ['green pumpkin flake', null, 'in the crappie box']],
  crappie_paddle: [['green/chartreuse', null, 'in the crappie box'], ['pearl', null, 'in the crappie box'],
    ['smoke', null, 'in the crappie box'], ['teal', null, 'in the crappie box']],
  crappie_marabou: [['brown', null, 'in the crappie box'], ['grey', null, 'in the crappie box']],

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
  // Ryan, 11/22: "The 'tan' bucktails are white that are slightly stained."
  bucktail_3quarter: [['white (a little stained), silver head', 1], ['black/white', 2]],
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
    ['gold, red bead', 1], ['gold (Kastmaster)', 1]],
  // Three of the "small spoons" were these jigs (Ryan, 11/22, with the maker's picture): "I see 3 on the board they are all
  // together 1 below the 2 above".
  jig_metal_116: [['silver/blue', 1], ['red head/silver', 1], ['yellow/black', 1]],
};
