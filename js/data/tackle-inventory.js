/**
 * tackle-inventory.js — Ryan's personal lure inventory.
 *
 * This file ONLY answers: "What does Ryan own?"
 * All fishing behavior lives in lure-knowledge.js.
 * Species strategy USED to live in species-strategies.js, which nothing imported and which was
 * removed on 2026-09-15. What the plan actually reads is the researched profile first and
 * species-intel.js second — see depthBandFor() in plan-inputs.js.
 *
 * Strict boundaries:
 *   ✅ What lures Ryan owns
 *   ✅ Physical specs (weight, sizes)
 *   ✅ WHICH INLINE TROLLING WEIGHTS ARE IN THE BOX -- as `type:'trolling_weight'` entries,
 *      and nowhere else. A weight is hardware Ryan owns, so it is this file's business; what
 *      a weight DOES to the depth of the bait behind it is lure-knowledge.js's.
 *   ✅ WHICH JIGHEADS ARE IN THE BOX -- as `type:'jighead'` entries, and nowhere else.
 *      Each paddle tail used to carry its own `jigWeights` list. Nothing ever read one,
 *      all three disagreed with the box (they offered 1/8 and 3/16oz heads Ryan does not
 *      own), and reading one is what made a session tell him a 4.6" bait tops out at
 *      1/2oz. WHICH heads fit WHICH bait is a function of length -- lure-knowledge owns
 *      that rule -- crossed with this list. Storing the answer is what put dive depths in
 *      three files.
 *   ❌ NO trolling speed -- moved to lure-knowledge.js. Speed is a HARD limit only
 *      for lipped baits (>3mph and they leave their rated depth). For everything
 *      else speed is a math game against lead length, and the real ceiling is
 *      FISHING_STYLE.rigging.maxLeadFt, which is a rig fact, not a lure fact.
 *   ❌ NO dive depth -- moved to lure-knowledge.js. Depth is a stored number
 *      only when it is printed on the lure (crankbait bills). Everything else is
 *      f(weight, speed, lead) and lived in THREE files until 2026-08-02.
 *   ❌ NO presentationSignature -- it was written here on all 58 entries, read
 *      here zero times, and had already drifted from the knowledge copy on 11.
 *   ✅ IDB persistence
 *   ✅ Planner API (selectBestLure — delegates scoring to lure-knowledge)
 *   ✅ WHICH COLOURS HE HAS OF EACH LURE -- `colors`, from tackle-colors.js (his photos, 2026-11-21/22).
 *      Which colour suits the water is not here; the plan picks from his list.
 *   ❌ No fishing tactics
 *   ❌ No jighead selection logic
 *   ❌ No species knowledge
 */

/* THE BOX AS BOUGHT. `trollable` on these entries is the flag AS TYPED; what the app reads is the
 * derived list below, where it comes from Ryan's own rule instead. Left visible rather than edited
 * out so a disagreement between the two is findable -- and on 2026-09-14 there were two, the
 * buzzbait and the fluke, both of which he ruled trollable. */
const AS_BOUGHT = [

  // ── Crankbaits ────────────────────────────────────────────────────────────
  { id:'cb_squarebill', name:'Squarebill Crankbait',
    type:'crankbait_squarebill', trollable:true, castable:true, weightOz:0.375 },

  { id:'cb_sr', name:'SR Crankbait (3-5ft)',
    type:'crankbait_sr', trollable:true, castable:true, weightOz:0.25 },

  { id:'cb_mr', name:'MR Crankbait (6-12ft)',
    type:'crankbait_mr', trollable:true, castable:true, weightOz:0.5 },

  // THE DD NAMES WERE PLACEHOLDERS. Ryan, 2026-11-22: "Either have it as an alias or remove the dd markings. Those were
  // created because I don't know the brand of every crankbait. More of a place holder / guess". The DD2, DD3 and DD4
  // entries had no bait behind them and are retired (RETIRED_IDS); this one holds his five unlabelled ~3" long-lip
  // cranks (the hard-bait list's photos 13 and 15), named for what they are like the other no-label entries. Its depth
  // is still its type's 14-18 ft band, a guess, because no maker's chart can be read for a bait with no label.
  // 'DD1 Crankbait (14-18ft)' is kept as an alias (LURE_ALIASES) so a catch or plan written under it still finds it.
  { id:'cb_dd1', name:'Deep Crankbait ~3", long lip (no label)',
    type:'crankbait_dd1', trollable:true, castable:true, weightOz:0.75 },

  // ── Lipless & Blade Vibes ─────────────────────────────────────────────────
  { id:'lipless_2in', name:'2" Lipless Crankbait',
    type:'lipless', trollable:true, castable:true, weightOz:0.25, sizes:['2"'] },

  { id:'lipless_3in', name:'3" Lipless Crankbait',
    type:'lipless', trollable:true, castable:true, weightOz:0.5, sizes:['3"'] },

  { id:'lipless_4in', name:'4" Lipless Crankbait',
    type:'lipless', trollable:true, castable:true, weightOz:0.75, sizes:['4"'] },

  // HIS BOMBER SUPER POGY, 1 1/4 oz, "hi p mullet" (the only colour he has, so it is in the name), bought in Miami in
  // October and never added: on his 11/11 Wateree plan the cast rod for breaking fish went to a Spook for want of it.
  // Ryan, 2026-11-10: "i think the super pogy would work just as well... cast it forever and just rip it under the
  // surface", then "we never added it after i bought it last month". Its ceiling on the troll is levelsOffFt()'s, by its
  // weight from the 1/2 oz figure (mine, unmeasured): about 16 ft at 2 mph.
  { id:'lipless_super_pogy', name:'Bomber Super Pogy 1-1/4oz (hi p mullet)',
    type:'lipless', trollable:true, castable:true, weightOz:1.25 },

  { id:'blade_3in', name:'3" Blade Vibe Bait',
    type:'blade_vibe', trollable:true, castable:true, weightOz:0.5, sizes:['3"'] },

  // ── A-Rigs / Umbrella Rigs ────────────────────────────────────────────────
  // ONE RIG, WEIGHTED THREE WAYS. Ryan, 2026-11-04: "this is the only a-rig i buy and the lightest
  // jigs heads i have are 3/8oz", a 1.6 oz frame with 4 blades and 5 baits; "the heaviest i would
  // run probably is 4 3/4oz weights with a 1oz in the middle"; and, asked for a third, five 1/2 oz
  // heads. weightOz is the frame plus its five heads; the plastics are not weighed. The ids are
  // kept. The 1.65 / 2.65 / 3.5 oz rigs they used to name came with the first upload and are not
  // his; replaceShippedBuiltins() below brings a saved tackle box over.
  //
  // `headsOz` is what each arm carries, so the plan can name a trailer that fits it (trailerFits()). Ryan, 11/22: "it
  // tells me the weight of the jig head but not which of the million soft plastics i have to put on it", and of the
  // middle, "i absolutely will run a different size or color on the middle".
  { id:'arig_light',  name:'A-Rig – five 3/8oz heads (~3.5oz)',
    type:'umbrella_rig', trollable:true, castable:true, weightOz: 1.6 + 5 * 0.375, headsOz: { outside: 0.375, middle: 0.375 } },

  { id:'arig_medium', name:'A-Rig – five 1/2oz heads (~4.1oz)',
    type:'umbrella_rig', trollable:true, castable:true, weightOz: 1.6 + 5 * 0.5, headsOz: { outside: 0.5, middle: 0.5 } },

  { id:'arig_heavy',  name:'A-Rig – four 3/4oz heads, 1oz middle (~5.6oz)',
    type:'umbrella_rig', trollable:true, castable:true, weightOz: 1.6 + 4 * 0.75 + 1, headsOz: { outside: 0.75, middle: 1.0 } },

  // AND A LIGHT ONE FOR SHALLOWER WATER, on his 1/4 oz pre-rigged swimbaits as they come. Ryan, 11/22: "And an arig is
  // shallower water can run them. You told me you wanted 3 sizes for the a rigs and I picked based on what weights I
  // have the most of". So the three above were never his limit, and five 1/4 oz baits on the same frame is a fourth.
  { id:'arig_quarter', name:'A-Rig – five 1/4oz heads (~2.85oz)',
    type:'umbrella_rig', trollable:true, castable:true, weightOz: 1.6 + 5 * 0.25, headsOz: { outside: 0.25, middle: 0.25 } },

  // ── Swimbaits (Paddle Tail) ───────────────────────────────────────────────
  { id:'swimbait_3in', name:'Swimbait 3.8" – Jighead',
    type:'swimbait_paddle', trollable:true, castable:true, weightOz:null, lengthIn: 3.8 },

  { id:'swimbait_4in', name:'Swimbait 4.6" – Jighead',
    type:'swimbait_paddle', trollable:true, castable:true, weightOz:null, lengthIn: 4.6 },

  { id:'swimbait_5in', name:'Swimbait 5" – Jighead',
    type:'swimbait_paddle', trollable:true, castable:true, weightOz:null, lengthIn: 5.0 },

  // Ryan, 2026-08-30: "the 6 inch that is not in the inventory that i do have".
  { id:'swimbait_6in', name:'Swimbait 6" – Jighead',
    type:'swimbait_paddle', trollable:true, castable:true, weightOz:null, lengthIn: 6.0 },

  // HIS 3" AND 4" BODIES. Ryan, 2026-11-16, Bass Pro Shops in Miami: Johnny Morris BioBait Shadow
  // Swimmers in 3" (live threadfin, live gizzard shad, live menhaden) and 4" (live threadfin, live
  // gizzard shad), and Bass Assassin 4" Sea Shads (pearl, chartreuse tail). The box had no 3" or
  // 4" swimbait; the 3.8" and 4.6" above stay as they were. His word: "Sure makes sense to have
  // them in there". Sizes only, like the others: the head band comes from the length (a 3" body
  // takes 1/4-1/2 oz, a 4" takes 1/2-1 oz, `jigheadOzByLengthIn`), and the colour is the plan's to
  // name. On his A-rigs that is the 3" for the 3/8 and 1/2 oz heads and the 4" for the 3/4 oz.
  { id:'swimbait_3_0in', name:'Swimbait 3" – Jighead',
    type:'swimbait_paddle', trollable:true, castable:true, weightOz:null, lengthIn: 3.0 },

  { id:'swimbait_4_0in', name:'Swimbait 4" – Jighead',
    type:'swimbait_paddle', trollable:true, castable:true, weightOz:null, lengthIn: 4.0 },

  // ── Underspins ────────────────────────────────────────────────────────────
  { id:'underspin_owner', name:'Underspin Jig (Flashy Swimmer)',
    type:'underspin', trollable:true, castable:true, weightOz:0.375 },

  // ── Spoons ────────────────────────────────────────────────────────────────
  // NO SPOON IS "THE ONE TIED ON" ANY MORE. Ryan, 2026-11-06, had the 4" behind his 2 oz weight, and a plan that picked the
  // other spoon called it a re-tie at the truck. 2026-11-22: "weight moved over... no weight on the 4 inch right now",
  // then "i am not going to run the spoons without a weight for trolling... so if it is for trolling it needs to tell
  // which spoon and what weight and i will rig it. i have 1,2,3 oz weights". So spoonRig() names the spoon and the
  // weight, and nothing is a re-tie.
  { id:'spoon_3quarter', name:'Nichols Lake Fork Flutter Spoon 3/4oz',
    type:'flutter_spoon', trollable:true, castable:true, weightOz:0.75, lengthIn:4 },

  // The Dr.Fish diamond jig and the 3/4 oz marabou jig left the box 2026-11-22, Ryan: "i think the diamond jig and the
  // marabou are at the bottom of a lake and i dont think i ever had the haruki jigs". RETIRED_IDS below takes them out
  // of a saved box too.

  { id:'spoon_nichols_118', name:'Nichols Lake Fork Flutter Spoon 5" 1-1/8oz (FS14-118)',
    type:'flutter_spoon', trollable:true, castable:true, weightOz:1.125 },

  // TWO SIZES, ONE OF EACH. Ryan, 2026-11-22: "p-line lures that are the same color i believe are 2 different sizes",
  // then, measured, "no stamp or label the big one is 4 inches and the smaller one looks to be 3.75". P-Line makes the
  // 1 oz at 3", the 2 oz at 3-3/4" and the 3 oz at 4-1/4" and nothing between, so his are the 2 and the 3 (my read
  // of his tape against the maker's lengths). Both Chartreuse Silver Blue (PLM-04).
  { id:'spoon_laser_minnow_2oz', name:'P-Line Laser Minnow 2oz (PLM2)',
    type:'spoon_casting', trollable:true, castable:true, weightOz:2.0, lengthIn:3.75 },

  { id:'spoon_laser_minnow_3oz', name:'P-Line Laser Minnow 3oz (PLM3)',
    type:'spoon_casting', trollable:true, castable:true, weightOz:3.0, lengthIn:4.25 },

  // ── Inline trolling weights ───────────────────────────────────────────────
  //
  // THE WEIGHT IS HARDWARE RYAN OWNS, NOT A SENTENCE IN A COMMENT. It was named in three
  // comments in this repo -- here, and twice in lure-knowledge.js -- and was an object in
  // none of them, so nothing could add its mass to anything. Ryan, 2026-09-14, asked the
  // question that found it: "is the spoon depths assuming that i am using the 2oz trolling
  // weight rig? because a 3/4oz spoon unweighted at 2mph is a surface lure not these depths".
  //
  // WHAT IS RIGGED, in his words, same day: "Currently i have the 3/4 oz spoon, a 3/4 oz
  // bucktail, a 1/2 oz jighead with a 4inch swimbait, and the last 2 oz weight i have tied to
  // a swivel snap that could be used with whatever other lure like a lipless or even a
  // standard crankbait. I have 1 and 3 oz weights that could be used that are not rigged
  // currently."
  //
  // So the box is 1, 2 and 3oz, and 2oz is what is actually tied on. `trollable` and
  // `castable` are both FALSE: a weight is not a bait and must never be offered as one. Both
  // bag builders filter on `trollable || castable`, so this block is invisible to them.
  //
  // THE WEIGHT RIDES THE SNAP AND THE LURE IS TIED TO A LEADER BEHIND IT. That is why a
  // flutter spoon has always been snap-legal in TERMINAL_CONNECTION -- the snap holds the
  // weight, not the spoon. It also means changing the bait behind one costs a KNOT, whatever
  // rod it is on. See TERMINAL_CONNECTION and `changeCostFor()` in lure-knowledge.js.
  { id:'troll_weight_1oz', name:'1oz Inline Trolling Weight',
    type:'trolling_weight', trollable:false, castable:false, weightOz:1.0, rigged:false },

  { id:'troll_weight_2oz', name:'2oz Inline Trolling Weight',
    type:'trolling_weight', trollable:false, castable:false, weightOz:2.0, rigged:true },

  { id:'troll_weight_3oz', name:'3oz Inline Trolling Weight',
    type:'trolling_weight', trollable:false, castable:false, weightOz:3.0, rigged:false },

  // HIS SPREADERS, hardware like the weights. Ryan, 2026-11-22, with the maker's page: G. Pucci T-Bead Spreader, 3" x 5",
  // chartreuse, two of them, and how he runs them: "with whatever weight tied on using lightweight line... then the lure is
  // tied to the longer arm using 25lb fluro 5-6 ft long with whatever lure we want behind it". The weights: "i have bank,
  // bell, pyramid sinkers along with the trolling weights... assume 1,2,3 oz"; behind it, "spoons, bucktails, paddle
  // tails... haven't tried cranks yet" (spreaderCarries()). How many he has is the colour count, as for every bait.
  { id:'spreader_tbead', name:'G. Pucci T-Bead Spreader 3"x5"',
    type:'spreader', trollable:false, castable:false, weightOz:null },

  // ── Vertical / Knife Jigs ────────────────────────────────────
  // None. The two P-Line Haruki jigs that stood here were never his (2026-11-22, above). The type stays in
  // lure-knowledge.js for the day one is bought.

  // ── Spinnerbaits ──────────────────────────────────────────────────────────
  { id:'spinner_quarter',  name:'1/4oz Spinnerbait',
    type:'spinnerbait', trollable:true, castable:true, weightOz:0.25 },

  { id:'spinner_3eighth',  name:'3/8oz Spinnerbait',
    type:'spinnerbait', trollable:true, castable:true, weightOz:0.375 },

  { id:'spinner_half',     name:'1/2oz Spinnerbait',
    type:'spinnerbait', trollable:true, castable:true, weightOz:0.5 },

  // ── Chatterbaits ──────────────────────────────────────────────────────────
  { id:'chatter_quarter',  name:'1/4oz Chatterbait',
    type:'chatterbait', trollable:true, castable:true, weightOz:0.25 },

  { id:'chatter_3eighth',  name:'3/8oz Chatterbait',
    type:'chatterbait', trollable:true, castable:true, weightOz:0.375 },

  { id:'chatter_half',     name:'1/2oz Chatterbait',
    type:'chatterbait', trollable:true, castable:true, weightOz:0.5 },

  // ── Bucktail & Marabou Jigs ───────────────────────────────────────────────
  { id:'bucktail_3quarter', name:'3/4oz Bucktail Jig',
    type:'bucktail', trollable:true, castable:true, weightOz:0.75 },

  { id:'bucktail_1oz',      name:'SPRO Prime Bucktail Jig 1oz (SBTJ-1)',
    type:'bucktail', trollable:true, castable:true, weightOz:1.0 },

  { id:'bucktail_3oz',      name:'SPRO Prime Bucktail Jig 3oz (SBTJ-3)',
    type:'bucktail', trollable:true, castable:true, weightOz:3.0 },

  { id:'bucktail_shark_shooter', name:'Shark Shooter Bucktail w/ Spinner 3/4oz',
    type:'bucktail', trollable:true, castable:true, weightOz:0.75 },


  // ── Jigheads ─────────────────────────────────────────────────────────────
  { id:'jighead_quarter',  name:'1/4oz Jighead',
    type:'jighead', trollable:true, castable:true, weightOz:0.25 },

  { id:'jighead_3eighth',  name:'3/8oz Jighead',
    type:'jighead', trollable:true, castable:true, weightOz:0.375 },

  { id:'jighead_half',     name:'1/2oz Jighead',
    type:'jighead', trollable:true, castable:true, weightOz:0.5 },

  { id:'jighead_3quarter', name:'3/4oz Jighead',
    type:'jighead', trollable:true, castable:true, weightOz:0.75 },

  { id:'jighead_1oz',      name:'1oz Jighead',
    type:'jighead', trollable:true, castable:true, weightOz:1.0 },

  { id:'jighead_1_25oz', name:'1-1/4oz Jighead', type:'jighead', trollable:true, castable:true, weightOz:1.25 },

  { id:'jighead_1_5oz',  name:'1-1/2oz Jighead', type:'jighead', trollable:true, castable:true, weightOz:1.5 },

  // ↑ Ryan, 2026-08-30: "I have everything from 1/4 oz up to i believe 1.5oz... so 1/4, 3/8,
  // 1/2, 3/4, 1, 1 1/4, 1 1/2 is what i own". Those seven entries ARE that sentence. Add a head
  // to the box and every picker sees it; there is no second list to remember.

  // ── Finesse and Heavy Casting Jigs (New Casting) ──────────────────────────
  { id:'jig_football', name:'Football Jig (Craw/Bluegill Trailer)',
    type:'jig_football', trollable:false, castable:true, weightOz:0.5 },

  { id:'jig_finesse_ned', name:'Ned Rig / Finesse Jig',
    type:'jig_finesse_ned', trollable:false, castable:true, weightOz:0.1875 },

  // ── Inline Spinners ───────────────────────────────────────────
  // NOT a Road Runner and not a spinnerbait. Blade spins around a straight shaft,
  // which generates lift: it rides high and the blade fouls above ~2mph.
  { id:'inline_rooster_3quarter', name:"Worden's Joe Thomas Rooster Tail 3/4oz (217JT)",
    type:'inline_spinner', trollable:true, castable:true, weightOz:0.75 },

  // ── Road Runner / Beetle Spin ─────────────────────────────────────────────
  { id:'road_runner_eighth',  name:'1/8oz Road Runner / Beetle Spin',
    type:'road_runner', trollable:true, castable:true, weightOz:0.125 },

  { id:'road_runner_quarter', name:'1/4oz Road Runner / Beetle Spin',
    type:'road_runner', trollable:true, castable:true, weightOz:0.25 },

  { id:'road_runner_3eighth', name:'3/8oz Road Runner / Beetle Spin',
    type:'road_runner', trollable:true, castable:true, weightOz:0.375 },

  // ── Popping Cork Rig (Restored & Enhanced Coastal/Inshore) ───────────────
  { id:'popping_cork_rig', name:'Popping Cork with Gulp/Vudu Shrimp',
    type:'popping_cork', trollable:true, castable:true, weightOz:0.75 },

  // ── Topwater (Surface Action) ─────────────────────────────────────────────
  { id:'tw_walker',  name:'Walking Bait / Spook',
    type:'topwater_troll', trollable:true, castable:true, weightOz:0.75 },

  { id:'tw_prop',    name:'Prop Bait / Choppo',
    type:'topwater_troll', trollable:true, castable:true, weightOz:0.5 },

  { id:'tw_plopper', name:'Whopper Plopper',
    type:'topwater_troll', trollable:true, castable:true, weightOz:0.625 },

  { id:'tw_wake',    name:'Wake Bait',
    type:'topwater_troll', trollable:true, castable:true, weightOz:0.75 },

  { id:'tw_popper',      name:'Popper / Chugger',       type:'topwater_cast', trollable:false, castable:true, weightOz:0.375 },

  { id:'tw_buzzbait',    name:'Buzzbait',               type:'topwater_cast', trollable:false, castable:true, weightOz:0.5 },

  { id:'tw_frog',        name:'Hollow Body Frog',       type:'topwater_cast', trollable:false, castable:true, weightOz:0.625 },

  // ── Soft plastics that only fish on a rod stroke ──────────────────────────
  //
  // These three stay cast-only, and for two DIFFERENT reasons, which is worth keeping straight.
  // The Senko and the straight-tail worm track perfectly well on a head -- they just have no
  // swimming action when towed. Ryan, 2026-09-14, and the chart he brought agree: weighted, a
  // Senko is "a dead plastic stick with no built-in swimming action when towed horizontally". It
  // is cast-only because it is BORING, not because it fouls. The creature bait is the other
  // reason: "the action of the claws or tails when the rod tip moves is what really makes them
  // work". No rigging replaces a rod tip.
  { id:'cast_stickbait', name:'Stick Bait (Senko)',     type:'cast_only',     trollable:false, castable:true, weightOz:0.375 },

  { id:'cast_creature',  name:'Creature Bait / Craw',  type:'cast_only',     trollable:false, castable:true, weightOz:0.5 },

  // "the worm it depends... they actually make paddletail style worms so i argue those could be
  // trollable". So the one `Plastic Worm` entry became two, because it was covering two objects:
  // a straight tail, which barrel-rolls with no keel and does nothing with one, and a swimming
  // tail, which is a swimbait by any other name. Sizes are his, 2026-09-14.
  { id:'cast_worm_straight', name:'Straight Tail Worm 6-7"', type:'cast_only', trollable:false, castable:true, weightOz:0.25 },

  // ── Soft plastics that troll once something gives them a keel ─────────────
  //
  // RYAN'S RULE, 2026-09-14: "those soft plastics only become non trollable if weightless or
  // t-rigged". Ballasted by a jighead or a belly weight, a fluke and a speedworm are mechanically
  // the same object as a paddle tail -- a soft body with its weight at the nose and a tail that
  // works off the tow. So they are filed under the type that already models exactly that, and the
  // jighead fitter that has priced every paddle tail since 2026-08-30 prices these too.
  //
  // FILED THERE RATHER THAN GIVEN NEW TYPES ON PURPOSE. A new type needs its own
  // species/season/clarity block, and those are 386 numbers in this repo that nobody has measured.
  // Reusing a type whose BEHAVIOUR is identical invents nothing.
  //
  // `weightOz: null` is the ballast statement: the head IS the weight. An unweightd or T-rigged
  // one is a different rig and is not in this box -- Ryan owns the T-rig gear and has never
  // entered it: "it is not something that is really used for striper or for trolling obviously".
  // If it is ever added it is cast-only, and this is where the reason is written down.
  { id:'cast_fluke_3in', name:'Fluke 3.5" – Jighead',
    type:'swimbait_paddle', trollable:true, castable:true, weightOz:null, lengthIn: 3.5 },

  { id:'cast_fluke_4in', name:'Fluke 4" – Jighead',
    type:'swimbait_paddle', trollable:true, castable:true, weightOz:null, lengthIn: 4.0 },

  { id:'cast_fluke_5in', name:'Fluke 5" – Jighead',
    type:'swimbait_paddle', trollable:true, castable:true, weightOz:null, lengthIn: 5.0 },

  { id:'cast_worm_speed_6in', name:'Speedworm 6" – Jighead',
    type:'swimbait_paddle', trollable:true, castable:true, weightOz:null, lengthIn: 6.0 },

  { id:'cast_worm_speed_7in', name:'Speedworm 7" – Jighead',
    type:'swimbait_paddle', trollable:true, castable:true, weightOz:null, lengthIn: 7.0 },

  // ══ HIS BAITS BY NAME, FROM HIS PHOTOS (2026-11-21/22) ═══════════════════════════════════════════════════════════
  //
  // Ryan, 11/21: "if an entry doesn't exist why not just make one that matches... you know what the lures are... dont
  // try to force them into a category if they belong in their own". So each of these is HIS bait, by the name he knows
  // it by or by what it is. The `type` is only the physics the planner already models for it (how its depth is set,
  // what speed it keeps, snap or tie); it is not what the bait is called. The colours are tackle-colors.js. The lists
  // he checked: claude/LURE_INVENTORY_HARD_BAITS_2026-11-21.md, LURE_INVENTORY_SOFT_PLASTICS_2026-11-21.md,
  // LURE_REVIEW_CHECKED_2026-11-22.md.
  //
  // `ratedDepthFt` IS THE MAKER'S NUMBER for a crankbait with a name, looked up 11/22 (the hard-bait list's "Dive
  // depths from the makers" table), and it replaces the type's band for that bait (ratedDepthOf() in
  // lure-knowledge.js). Where the maker gives only a top depth ("to 27 ft"), the shallow end is 4 ft above it: that
  // gap is mine, the width of the app's own DD bands, and the shallow end is the one the plan counts on. Weights are the
  // maker's where printed and a common weight for the size where not (his rule for the lipless, 11/21).

  // ── Crankbaits he has by name ──────────────────────────────────────────────────────────────
  { id:'cb_knockoff_10ft', name:'Amazon Knock-off Minnow Crankbait (to 10ft)',
    type:'crankbait_mr', trollable:true, castable:true, weightOz:0.375, ratedDepthFt:{ min:6, max:10 } },
  { id:'cb_flicker_9d', name:'Berkley Flicker Minnow 9D',
    type:'crankbait_dd2', trollable:true, castable:true, weightOz:0.333, ratedDepthFt:{ min:18, max:23 } },
  { id:'cb_flicker_11d', name:'Berkley Flicker Minnow 11D',
    type:'crankbait_dd2', trollable:true, castable:true, weightOz:0.5, ratedDepthFt:{ min:18, max:23 } },
  { id:'cb_hitstick_9', name:'Berkley Deep Hit Stick 9',
    type:'crankbait_dd2', trollable:true, castable:true, weightOz:0.333, ratedDepthFt:{ min:18, max:24 } },
  { id:'cb_hitstick_12', name:'Berkley Deep Hit Stick 12',
    type:'crankbait_dd4', trollable:true, castable:true, weightOz:0.75, ratedDepthFt:{ min:26, max:33 } },
  { id:'cb_bandit_wd', name:'Bandit Walleye Deep',
    type:'crankbait_dd4', trollable:true, castable:true, weightOz:0.625, ratedDepthFt:{ min:23, max:27 } },
  { id:'cb_reef_runner_800', name:'Reef Runner Deep Diver 800',
    type:'crankbait_dd4', trollable:true, castable:true, weightOz:0.625, ratedDepthFt:{ min:24, max:28 } },
  { id:'cb_bomber_b24a', name:'Bomber Deep Long A B24A',
    type:'crankbait_dd1', trollable:true, castable:true, weightOz:0.375, ratedDepthFt:{ min:15, max:20 } },
  { id:'cb_bomber_bd7f', name:'Bomber Fat Free Shad BD7F',
    type:'crankbait_dd1', trollable:true, castable:true, weightOz:0.75, ratedDepthFt:{ min:14, max:18 } },
  { id:'cb_ultradiver_80', name:'Freedom Tackle Ultra Diver Shad 80',
    type:'crankbait_dd4', trollable:true, castable:true, weightOz:0.875, ratedDepthFt:{ min:26, max:30 } },
  // The 65 is published as "12-plus" cranked and the 50 not at all: they keep their type's band.
  { id:'cb_ultradiver_65', name:'Freedom Tackle Ultra Diver Shad 65',
    type:'crankbait_dd1', trollable:true, castable:true, weightOz:0.375 },
  { id:'cb_ultradiver_50', name:'Freedom Tackle Ultra Diver Shad 50',
    type:'crankbait_mr', trollable:true, castable:true, weightOz:0.3125 },
  { id:'cb_rapala_jdhj12', name:'Rapala Jointed Deep Husky Jerk 12',
    type:'crankbait_mr', trollable:true, castable:true, weightOz:0.5, ratedDepthFt:{ min:8, max:13 } },
  { id:'cb_yozuri_cmdd130', name:'Yo-Zuri Crystal Minnow Deep Diver 130mm',
    type:'crankbait_dd2', trollable:true, castable:true, weightOz:0.875, ratedDepthFt:{ min:18, max:20 } },
  // No label showing; filed by the lip.
  { id:'cb_deep_minnow', name:'Deep Minnow Crankbait ~4.5" (no label)',
    type:'crankbait_dd1', trollable:true, castable:true, weightOz:0.5 },
  { id:'cb_jointed_minnow', name:'Jointed Minnow Crankbait ~5" (no label)',
    type:'crankbait_dd1', trollable:true, castable:true, weightOz:0.5 },
  { id:'cb_micro', name:'Micro Crankbait 1-1.6"',
    type:'crankbait_sr', trollable:true, castable:true, weightOz:0.125 },
  // Ryan, 11/22, of the 3.6" firetiger: "jerkbait i think".
  { id:'cb_jerkbait', name:'Jerkbait ~3.6"',
    type:'crankbait_sr', trollable:true, castable:true, weightOz:0.25 },
  { id:'cb_jointed_swimbait', name:'Jointed Hard Swimbait 3.7"',
    type:'crankbait_sr', trollable:true, castable:true, weightOz:0.375 },

  // ── Tail spinners: a lead body with a blade on the tail; depth from weight, lead and speed like a blade bait ──
  // Ryan, 11/22: "I found my order on amazon for the small tail spinners they are 1/2 oz". The rest by size.
  { id:'ts_half', name:'Tail Spinner 1/2oz',
    type:'blade_vibe', trollable:true, castable:true, weightOz:0.5 },
  { id:'ts_small', name:'Tail Spinner, small (~1/4oz)',
    type:'blade_vibe', trollable:true, castable:true, weightOz:0.25 },
  { id:'ts_large', name:'Tail Spinner, large (~3/4oz)',
    type:'blade_vibe', trollable:true, castable:true, weightOz:0.75 },
  { id:'tsj_30g', name:'Tail-Spinner Metal Jig 30g (~1oz)',
    type:'spoon_casting', trollable:true, castable:true, weightOz:1.06 },
  { id:'spoon_small_cast', name:'Small Casting Spoon (Kastmaster type)',
    type:'spoon_casting', trollable:false, castable:true, weightOz:0.375 },
  // Ryan, 2026-11-22, with the maker's picture of them: "some of the "small spoons" on the saltwater lures pic were
  // these" -- a metal jig 2.56" long and 1.16 oz with a feathered treble on the tail, sold five to a box. Which ones,
  // asked: "I see 3 on the board they are all together 1 below the 2 above" -- the three with a feather low on board 14
  // (silver/blue, red head/silver, yellow/black). The other five stay small spoons. Its
  // own entry, not the 30 g jig's: a third shorter for the same weight. No ruling of its own on the troll, so it trolls
  // as the type does, like the 30 g jig.
  { id:'jig_metal_116', name:'Metal Jig 2.56" 1.16oz (feathered treble)',
    type:'spoon_casting', trollable:true, castable:true, weightOz:1.16, lengthIn:2.56 },

  // ── Topwater ───────────────────────────────────────────────────────────────────────────────
  { id:'tw_plopper_small', name:'Whopper Plopper, small (~2.5")',
    type:'topwater_troll', trollable:true, castable:true, weightOz:0.25 },
  { id:'tw_jitterbug', name:'Jitterbug',
    type:'topwater_cast', trollable:false, castable:true, weightOz:0.25 },

  // ── Skirted and spinner baits ──────────────────────────────────────────────────────────────
  { id:'jig_swim', name:'Swim Jig (skirted)',
    type:'jig_football', trollable:false, castable:true, weightOz:0.375 },
  { id:'inline_small', name:'Inline Spinner 1/8oz (Rooster Tail type)',
    type:'inline_spinner', trollable:true, castable:true, weightOz:0.125 },
  { id:'underspin_painted', name:'Underspin Swimbait (painted head)',
    type:'underspin', trollable:true, castable:true, weightOz:0.375 },
  { id:'bucktail_soft_jerk', name:'Bucktail Soft Jerk 6" (chartreuse head)',
    type:'bucktail', trollable:true, castable:true, weightOz:1.0 },

  // ── Soft plastics ──────────────────────────────────────────────────────────────────────────
  { id:'swimbait_7in', name:'Swimbait 7" – Jighead',
    type:'swimbait_paddle', trollable:true, castable:true, weightOz:null, lengthIn: 7.0 },
  { id:'thin_tail_4in', name:'Thin-Tail Minnow 4.3" – Jighead',
    type:'swimbait_paddle', trollable:true, castable:true, weightOz:null, lengthIn: 4.3 },
  // Cast by my read; he left the troll-or-cast list at my guesses (11/21).
  { id:'cast_flap_swimbait', name:"Flapping-Tail Swimbait (Flapp'n Shad / Escape Swim Twin)",
    type:'cast_only', trollable:false, castable:true, weightOz:0.25 },
  { id:'cast_ribbon_8in', name:'Ribbon-Tail Worm 8" (Mad Wag)',
    type:'cast_only', trollable:false, castable:true, weightOz:0.25 },
  { id:'cast_feather_worm', name:'Feather-Tail Worm ~6"',
    type:'cast_only', trollable:false, castable:true, weightOz:0.25 },
  { id:'cast_leech', name:'Leech 3.8" (Zaza)',
    type:'cast_only', trollable:false, castable:true, weightOz:0.25 },
  { id:'cast_shrimp', name:'Rigged Soft Shrimp (Prawn StarZ / D.O.A.)',
    type:'cast_only', trollable:false, castable:true, weightOz:0.5 },
  { id:'arig_mini', name:'Mini A-Rig (1 willow, 4 minnows)',
    type:'umbrella_rig', trollable:false, castable:true, weightOz:null },
  // His crappie box, shot as it is. Cast baits here: the box has no 1/16-1/8 oz heads to troll them on.
  { id:'crappie_minnow', name:'Crappie Ribbed Minnow 2.5-3"',
    type:'cast_only', trollable:false, castable:true, weightOz:0.125 },
  { id:'crappie_tube', name:'Crappie Tube 1.5-2"',
    type:'cast_only', trollable:false, castable:true, weightOz:0.125 },
  { id:'crappie_grub', name:'Curly-Tail Grub ~2"',
    type:'cast_only', trollable:false, castable:true, weightOz:0.125 },
  { id:'crappie_paddle', name:'Small Paddle Tail ~2"',
    type:'cast_only', trollable:false, castable:true, weightOz:0.125 },
  // A marabou jig is its own kind (the 3/4 oz one he lost was the type's only lure until now).
  { id:'crappie_marabou', name:'Marabou Crappie Jig',
    type:'marabou_jig', trollable:false, castable:true, weightOz:0.125 },
];

/**
 * Resolve a display name to its inventory entry. Rod rows, Groq output and the
 * spread UI all carry names rather than ids, so this is the one place that
 * conversion happens. Exact match first, then containment for annotated names.
 */
/**
 * OLD NAMES THAT STILL MEAN A BAIT IN THE BOX, by id. A catch logged or a plan saved under the old name resolves to the
 * entry it was renamed to; nothing new is written under one.
 */
export const LURE_ALIASES = Object.freeze({
  'dd1 crankbait (14-18ft)': 'cb_dd1',
  'dd1 crankbait': 'cb_dd1',
});

export function lureByName(name) {
  if (!name) return null;
  const n = String(name).toLowerCase().trim();
  const alias = LURE_ALIASES[n] || Object.keys(LURE_ALIASES).filter((a) => n.includes(a))
    .sort((a, b) => b.length - a.length).map((a) => LURE_ALIASES[a])[0];
  return TACKLE_INVENTORY.find(l => l.name.toLowerCase() === n)
      || TACKLE_INVENTORY.find(l => n.includes(l.name.toLowerCase()))
      || (alias && TACKLE_INVENTORY.find(l => l.id === alias))
      || null;
}

// ── IDB persistence ───────────────────────────────────────────────────────────
const IDB_NAME    = 'trollmap-tackle';
const IDB_STORE   = 'inventory';
const IDB_VERSION = 1;
const IDB_KEY     = 'lure_inventory';
let _db = null, _inventory = null;

async function openDB() {
  if (_db) return _db;
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE, { keyPath:'key' });
    req.onsuccess = e => { _db = e.target.result; res(_db); };
    req.onerror   = e => rej(e.target.error);
  });
}

async function idbLoad() {
  try {
    const db = await openDB();
    return new Promise((res, rej) => {
      const req = db.transaction(IDB_STORE).objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => res(req.result?.value || null);
      req.onerror   = () => rej(req.error);
    });
  } catch { return null; }
}

export async function saveInventory(inv) {
  // Ryan's tackle box. Unlike every other store in the app this cannot be re-fetched from
  // anywhere -- it is typed in by hand, once. Two things were wrong: the failure was
  // swallowed, and the put was never awaited, so this resolved before the transaction
  // committed and a failure afterwards had nowhere to go at all.
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put({ key: IDB_KEY, value: inv });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('tackle inventory write failed'));
      tx.onabort = () => reject(tx.error || new Error('tackle inventory write aborted'));
    });
    _inventory = inv;
    return true;
  } catch (err) {
    console.error('[tackle] inventory NOT saved — your changes are in memory only:', err && err.message);
    return false;
  }
}

const IDB_SEEN_KEY = 'builtin_ids_seen';

async function idbGet(key) {
  try {
    const db = await openDB();
    return new Promise((res, rej) => {
      const req = db.transaction(IDB_STORE).objectStore(IDB_STORE).get(key);
      req.onsuccess = () => res(req.result?.value ?? null);
      req.onerror   = () => rej(req.error);
    });
  } catch { return null; }
}

async function idbPut(key, value) {
  try {
    const db = await openDB();
    db.transaction(IDB_STORE,'readwrite').objectStore(IDB_STORE).put({ key, value });
  } catch (err) {
    // A WRITE. The same rule as js/utils/db.js: a read may fall back to a default, a write
    // may not fail in silence -- the user's tackle box appears to save and does not.
    console.error('[tackle-inventory] could not persist %s:', key, err);
  }
}

/**
 * Merge newly shipped built-in lures into a saved inventory.
 *
 * Without this, adding a lure to TACKLE_INVENTORY does NOTHING for anyone who has
 * ever opened the Plan tab: getInventory() returned the IndexedDB copy wholesale and
 * the new entry was never seen.
 *
 * A lure is added only if its id is absent from the saved inventory AND has never
 * been merged before, so a lure the user deleted in the UI stays deleted.
 */
async function mergeNewBuiltins(saved) {
  const seen  = (await idbGet(IDB_SEEN_KEY)) || [];
  const have  = new Set(saved.map(l => l.id));
  const known = new Set(seen);
  const added = TACKLE_INVENTORY.filter(l => !have.has(l.id) && !known.has(l.id));
  const allIds = TACKLE_INVENTORY.map(l => l.id);
  if (!added.length) {
    if (seen.length !== allIds.length) await idbPut(IDB_SEEN_KEY, allIds);
    return saved;
  }
  const merged = saved.concat(JSON.parse(JSON.stringify(added)));
  await idbPut(IDB_SEEN_KEY, allIds);
  await saveInventory(merged);
  console.log(`[tackle-inventory] merged ${added.length} new lure(s): ${added.map(l=>l.name).join(', ')}`);
  return merged;
}

/**
 * A BUILT-IN REPLACED IN PLACE REACHES A SAVED BOX ONLY IF IT IS STILL AS IT SHIPPED.
 *
 * mergeNewBuiltins() adds ids the box has never had and never touches one it has, so on
 * 2026-11-04 his saved box would have kept the three A-rigs he does not run. An entry whose name
 * and weight are still exactly what shipped takes the new name and weight (and loses the old
 * swimbait size); anything else on it is kept. An entry he edited is left as he left it.
 */
const SHIPPED_BEFORE = {
  arig_light:  { name: 'A-Rig Light (~1.65oz) – 3.8" Swimbait', weightOz: 1.65 },
  arig_medium: { name: 'A-Rig Medium (~2.65oz) – 4.6" Swimbait', weightOz: 2.65 },
  arig_heavy:  { name: 'A-Rig Heavy (~3.5oz) – 5" Swimbait', weightOz: 3.5 },
  // the placeholder name, 2026-11-22 (see the entry)
  cb_dd1:      { name: 'DD1 Crankbait (14-18ft)', weightOz: 0.75 },
};

export function replaceShippedBuiltins(saved) {
  let changed = 0;
  const inventory = saved.map((l) => {
    const was = SHIPPED_BEFORE[l?.id];
    const now = was && TACKLE_INVENTORY.find((b) => b.id === l.id);
    if (!now || l.name !== was.name || l.weightOz !== was.weightOz) return l;
    changed++;
    const { sizes, ...kept } = l;
    return { ...kept, name: now.name, weightOz: now.weightOz };
  });
  return { inventory, changed };
}

/**
 * BUILT-INS HE DOES NOT HAVE, taken out of a saved box. Ryan, 2026-11-22: "i think the diamond jig and the marabou are at
 * the bottom of a lake and i dont think i ever had the haruki jigs". Only the shipped entry goes: a lure he typed in
 * under another id is his.
 */
//
// And the same night, of the DD1-DD4 crankbaits: "Those were created because I don't know the brand of every crankbait.
// More of a place holder / guess". DD2, DD3 and DD4 had no bait behind them.
export const RETIRED_IDS = ['spoon_casting_dr_fish', 'marabou_3quarter', 'jig_haruki_21', 'jig_haruki_29',
  'cb_dd2', 'cb_dd3', 'cb_dd4'];

export function dropRetired(saved) {
  const inventory = (saved || []).filter((l) => !RETIRED_IDS.includes(l && l.id));
  return { inventory, dropped: (saved || []).length - inventory.length };
}

export async function getInventory() {
  if (_inventory) return _inventory;
  const saved = await idbLoad();
  if (saved) {
    const gone = dropRetired(saved);
    if (gone.dropped) {
      await saveInventory(gone.inventory);
      console.log(`[tackle-inventory] took ${gone.dropped} lure(s) he no longer has out of the saved box`);
    }
    const r = replaceShippedBuiltins(await mergeNewBuiltins(gone.inventory));
    if (r.changed) {
      await saveInventory(r.inventory);
      console.log(`[tackle-inventory] brought ${r.changed} built-in(s) in the saved box over to their new names`);
    }
    _inventory = r.inventory;
    return _inventory;
  }
  _inventory = JSON.parse(JSON.stringify(TACKLE_INVENTORY));
  await idbPut(IDB_SEEN_KEY, TACKLE_INVENTORY.map(l => l.id));
  return _inventory;
}

/**
 * WHAT MAY GO BEHIND THE BOAT IS A RULE, NOT NINE HAND-SET FLAGS.
 *
 * Ryan, 2026-09-14: "the rule should be if it needs a varied or specific type of retrieve or rod
 * motion then it probably needs to be cast only". `ACTION_SOURCE` in lure-knowledge.js is that
 * sentence, per bait, in his words -- and `trollable` is derived from it here so there is ONE
 * answer. Nine booleans with no stated reason were the old answer, and six of them justified
 * themselves with a `technique` string that read "Cast only", which is the flag restated.
 *
 * Every reader of `l.trollable` keeps working untouched; what changed is where the value comes
 * from. `AS_BOUGHT` above still carries what was typed, so the two can be compared.
 */
export const TACKLE_INVENTORY = AS_BOUGHT.map((l) => {
  const trollable = trollsBehindTheBoat(l);
  const colors = (COLORS_BY_ID[l.id] || []).map(([name, n, bag]) => ({ name, n: Number.isFinite(n) ? n : null, ...(bag ? { bag } : {}) }));
  return { ...l, trollable, colors };
});

// ── A-RIG TRAILERS ──────────────────────────────────────────────────────────────────────────────────────────────────
// The soft plastics that go on an A-rig's heads: his paddle-tail swimbaits (`swimbait_*`, `thin_tail_*`), not the flukes
// or worms filed under the same type. One the maker sold on its own head (pre-rigged) goes only on a rig whose heads
// weigh what its own does (colorFitsHead()).  Whether a body fits a head is the app's head table by length (jigheadRangeOz() in lure-knowledge.js), whose
// heavy end is the hook rule he gave on 8/3 ("for 2-3 inch nothing more than 1/2 oz, for 3-4 inch nothing more than 1oz").
export const TRAILER_COUNT = 4;     // the four outside arms take the same bait; the middle is its own
const isTrailerId = (id) => /^(swimbait_|thin_tail_)/.test(String(id || ''));
// A bait the maker sold on its own head goes on the rig AS IT IS, so only on a rig whose heads weigh what its own head
// does (Ryan, 11/22: "an arig is shallower water can run them"); one whose head weight nobody read, or with a belly
// treble, does not go on. A body he put on a jighead himself is a body: of the 6" on a 1 oz head, "The 6 inch isn't pre
// rigged it was just already set up by me".
const OZ_WORDS = { '1/8': 0.125, '1/4': 0.25, '3/8': 0.375, '1/2': 0.5, '3/4': 0.75, '1': 1 };
/** null: a loose body; a number: the oz of the head it came on; NaN: it came on a head of unknown weight. */
export function ownHeadOz(c) {
  const s = `${(c && c.name) || ''} ${(c && c.bag) || ''}`;
  if (/belly treble/i.test(s)) return NaN;
  if (!/pre-rigged/i.test(s)) return null;
  const m = /pre-rigged\s+(1\/8|1\/4|3\/8|1\/2|3\/4|1)\s*oz/i.exec(s);
  return m ? OZ_WORDS[m[1]] : NaN;
}
/** Whether this colour of a swimbait can go on a rig head of `headOz`: a body always, a pre-rigged one on its own weight. */
export function colorFitsHead(c, headOz) {
  const own = ownHeadOz(c);
  return own === null || Math.abs(own - Number(headOz)) < 1e-9;
}
const onItsOwnHead = (c) => ownHeadOz(c) !== null;

/** The A-rig's heads, {outside, middle} in oz, or null when the lure is not one of his A-rigs. */
export function arigHeadsOz(name) {
  const l = lureByName(name);
  return l && l.headsOz ? l.headsOz : null;
}

/**
 * Whether the swimbait by this name fits a head of `headOz`, and why not: {ok, why}. Pure but for the inventory.
 */
export function trailerFits(lureName, headOz) {
  const l = lureByName(lureName);
  if (!l || !isTrailerId(l.id)) return { ok: false, why: 'not one of his paddle-tail swimbaits' };
  const r = jigheadRangeOz(l.lengthIn, l.type);
  if (!r) return { ok: true, why: null };
  const h = Number(headOz);
  // The light end is the app's own head table for that length, the band every paddle tail's head is picked from.
  if (h < r.startOz - 1e-9) return { ok: false, why: `the head table puts a ${l.lengthIn}" body on ${ozLabel(r.startOz)} to ${ozLabel(r.maxOz)}, not ${ozLabel(h)}` };
  if (h > r.maxOz + 1e-9) return { ok: false, why: `a ${ozLabel(h)} head's hook tears a ${l.lengthIn}" body (it takes up to ${ozLabel(r.maxOz)})` };
  return { ok: true, why: null };
}

/** The swimbaits (inventory names) whose bodies fit a head of `headOz`, with their colours that can go on a rig head. */
export function trailersFor(headOz) {
  return TACKLE_INVENTORY.filter((l) => isTrailerId(l.id) && trailerFits(l.name, headOz).ok)
    .map((l) => ({ name: l.name, lengthIn: l.lengthIn, colors: (l.colors || []).filter((c) => colorFitsHead(c, headOz)) }))
    .filter((x) => x.colors.length)
    .sort((a, b) => (a.lengthIn || 0) - (b.lengthIn || 0));
}

/** Whether this colour of a swimbait came from the maker on a head of its own. */
export function colorOnItsOwnHead(c) { return !!c && onItsOwnHead(c); }

/** The colours he has of the lure by this name (inventory spelling), [] when none are listed. */
export function colorsOf(name) {
  const hit = lureByName(name);
  return hit && Array.isArray(hit.colors) ? hit.colors : [];
}

/**
 * THE COLOUR HE HAS THAT A WRITTEN COLOUR MEANS, in the box's own spelling, or null.
 *
 * The plan is asked for a colour off the lure's list. Matching is forgiving about case, spaces and punctuation and
 * about a colour written inside a longer phrase ("Live Threadfin" in "live threadfin shad"), because that is still his
 * colour; anything else is not, and the caller says so rather than keeping a colour he does not own.
 */
export function colorInBox(lureName, written) {
  const list = colorsOf(lureName);
  const FILLER = new Set(['w', 'with', 'and', 'back', 'belly', 'the', 'a', 'on', 'of']);
  const words = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((t) => t && !FILLER.has(t));
  const w = words(written);
  if (!w.length || !list.length) return null;
  const same = list.find((c) => words(c.name).join(' ') === w.join(' '));
  if (same) return same;
  // Every word of one inside the other, either way round: "gold orange black" is his "Black Gold",
  // and "chartreuse" alone is not his "chartreuse/white" when he also has a plain "chartreuse".
  let best = null, bestScore = 0;
  for (const c of list) {
    const cw = words(c.name);
    if (!cw.length) continue;
    const inside = cw.every((t) => w.includes(t)) || w.every((t) => cw.includes(t));
    if (!inside) continue;
    const score = cw.filter((t) => w.includes(t)).length / Math.max(cw.length, w.length);
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

// ── Planner API — delegates all scoring to lure-knowledge.js ─────────────────
/**
 * Every jighead weight in the box, ascending. Derived, never typed: this is the
 * `type:'jighead'` entries above and nothing else.
 *
 * It lives HERE and not in lure-knowledge.js because it answers "what does Ryan own", which is
 * this file's only job. lure-knowledge.js owns the RULE for which of these a given bait may
 * carry, takes this list as an argument, and keeps no copy of it -- a copy is what the six
 * deleted `jigWeights` arrays were.
 */
export const JIGHEADS_OWNED_OZ = TACKLE_INVENTORY
  .filter((l) => l.type === 'jighead' && l.weightOz > 0)
  .map((l) => l.weightOz)
  .sort((a, b) => a - b);

/**
 * Every inline trolling weight in the box, ascending. Derived exactly like the jigheads
 * above -- the `type:'trolling_weight'` entries and nothing else.
 *
 * `RIGGED_TROLLING_WEIGHT_OZ` is the one actually tied on. It is the default the planner
 * starts from, because an instruction to go and fit a weight that is in a bag at home is not
 * an instruction Ryan can follow on the water. Going heavier is a thing the plan may ASK for,
 * and when it does it says so out loud.
 */
export const TROLLING_WEIGHTS_OWNED_OZ = TACKLE_INVENTORY
  .filter((l) => l.type === 'trolling_weight' && l.weightOz > 0)
  .map((l) => l.weightOz)
  .sort((a, b) => a - b);

/**
 * HIS SPREADERS: how many, and what goes behind one. The weight on a spreader comes from TROLLING_WEIGHTS_OWNED_OZ (his
 * 1, 2 and 3 oz: "assume 1,2,3 oz but i probably have others"); the plan picks it, as it does a spoon's.
 */
export const SPREADERS_OWNED = TACKLE_INVENTORY.filter((l) => l.type === 'spreader')
  .reduce((n, l) => n + (Array.isArray(l.colors) && l.colors.length
    ? l.colors.reduce((a, c) => a + (Number(c.n) > 0 ? Number(c.n) : 1), 0) : 1), 0);
export const SPREADER_NAME = (TACKLE_INVENTORY.find((l) => l.type === 'spreader') || { name: 'spreader' }).name;
/** Whether this bait goes behind a spreader: a spoon, a bucktail or a paddle tail he trolls ("haven't tried cranks yet"). */
export function spreaderCarries(lure) {
  if (!lure || !lure.trollable) return false;
  return ['flutter_spoon', 'spoon_casting', 'bucktail'].includes(lure.type) || isTrailerId(lure.id);
}

/** The spoon tied behind the rigged weight now, or null. Null since 2026-11-22: he rigs whichever the plan names. */
export const RIGGED_SPOON = TACKLE_INVENTORY.find((l) => l.type === 'flutter_spoon' && l.riggedOn) || null;

export const RIGGED_TROLLING_WEIGHT_OZ =
  (TACKLE_INVENTORY.find((l) => l.type === 'trolling_weight' && l.rigged)
   || { weightOz: null }).weightOz;

// selectBestLure() and getRecommendedSpeed() stood here, the lure scorer's only callers, and
// were called by nothing. Both went with scoreLureForContext() on 2026-09-25.
import { trollsBehindTheBoat, jigheadRangeOz } from './lure-knowledge.js';
import { COLORS_BY_ID } from './tackle-colors.js';
import { ozLabel } from '../utils/oz.js';

console.log(`[tackle-inventory] ${TACKLE_INVENTORY.filter(l=>l.trollable).length} trollable lures loaded`);
