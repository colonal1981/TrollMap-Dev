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
 *   ❌ No color logic
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

  { id:'cb_dd1', name:'DD1 Crankbait (14-18ft)',
    type:'crankbait_dd1', trollable:true, castable:true, weightOz:0.75 },

  { id:'cb_dd2', name:'DD2 Crankbait (16-20ft)',
    type:'crankbait_dd2', trollable:true, castable:true, weightOz:0.75 },

  { id:'cb_dd3', name:'DD3 Crankbait (20-25ft)',
    type:'crankbait_dd3', trollable:true, castable:true, weightOz:1.0 },

  { id:'cb_dd4', name:'DD4 Crankbait (25ft+)',
    type:'crankbait_dd4', trollable:true, castable:true, weightOz:1.25 },

  // ── Lipless & Blade Vibes ─────────────────────────────────────────────────
  { id:'lipless_2in', name:'2" Lipless Crankbait',
    type:'lipless', trollable:true, castable:true, weightOz:0.25, sizes:['2"'] },

  { id:'lipless_3in', name:'3" Lipless Crankbait',
    type:'lipless', trollable:true, castable:true, weightOz:0.5, sizes:['3"'] },

  { id:'lipless_4in', name:'4" Lipless Crankbait',
    type:'lipless', trollable:true, castable:true, weightOz:0.75, sizes:['4"'] },

  { id:'blade_3in', name:'3" Blade Vibe Bait',
    type:'blade_vibe', trollable:true, castable:true, weightOz:0.5, sizes:['3"'] },

  // ── A-Rigs / Umbrella Rigs ────────────────────────────────────────────────
  { id:'arig_light',  name:'A-Rig Light (~1.65oz) – 3.8" Swimbait',
    type:'umbrella_rig', trollable:true, castable:true, weightOz:1.65,
    sizes:['3.8"'] },

  { id:'arig_medium', name:'A-Rig Medium (~2.65oz) – 4.6" Swimbait',
    type:'umbrella_rig', trollable:true, castable:true, weightOz:2.65,
    sizes:['4.6"'] },

  { id:'arig_heavy',  name:'A-Rig Heavy (~3.5oz) – 5" Swimbait',
    type:'umbrella_rig', trollable:true, castable:true, weightOz:3.5,
    sizes:['5"'] },

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

  // ── Underspins ────────────────────────────────────────────────────────────
  { id:'underspin_owner', name:'Underspin Jig (Flashy Swimmer)',
    type:'underspin', trollable:true, castable:true, weightOz:0.375 },

  // ── Spoons (Preserving spoon_3quarter, Adding Jigging/Diamond Spoon) ──────
  { id:'spoon_3quarter', name:'Nichols Lake Fork Flutter Spoon 3/4oz',
    type:'flutter_spoon', trollable:true, castable:true, weightOz:0.75 },

  { id:'spoon_casting_dr_fish', name:'Dr.Fish Diamond Jig / Jigging Spoon 1oz',
    type:'spoon_casting', trollable:true, castable:true, weightOz:1.0 },

  { id:'spoon_nichols_118', name:'Nichols Lake Fork Flutter Spoon 5" 1-1/8oz (FS14-118)',
    type:'flutter_spoon', trollable:true, castable:true, weightOz:1.125 },

  { id:'spoon_laser_minnow_2oz', name:'P-Line Laser Minnow 2oz (PLM2)',
    type:'spoon_casting', trollable:true, castable:true, weightOz:2.0 },

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

  // ── Vertical / Knife Jigs ────────────────────────────────────
  // Trollable, not cast-only — a dense wire-through body holds depth at speed.
  // 2-3oz is not heavy in context: a 1oz bucktail behind a 2oz trolling weight is
  // already 3oz through the water -- and since 2026-09-14 that is arithmetic the app
  // does, not a remark. See TROLLING_WEIGHTS_OWNED_OZ below. Depth comes from lead
  // length, so diveDepth stays null and the planner works it out from tacticalDepth.
  { id:'jig_haruki_21', name:'P-Line Haruki Jig 2.1oz (PHJ21)',
    type:'vertical_jig', trollable:true, castable:true, weightOz:2.1 },

  { id:'jig_haruki_29', name:'P-Line Haruki Jig 2.9oz (PHJ29)',
    type:'vertical_jig', trollable:true, castable:true, weightOz:2.9 },

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

  { id:'marabou_3quarter',  name:'3/4oz Marabou Jig',
    type:'marabou_jig', trollable:true, castable:true, weightOz:0.75 },

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
];

/**
 * Resolve a display name to its inventory entry. Rod rows, Groq output and the
 * spread UI all carry names rather than ids, so this is the one place that
 * conversion happens. Exact match first, then containment for annotated names.
 */
export function lureByName(name) {
  if (!name) return null;
  const n = String(name).toLowerCase().trim();
  return TACKLE_INVENTORY.find(l => l.name.toLowerCase() === n)
      || TACKLE_INVENTORY.find(l => n.includes(l.name.toLowerCase()))
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

export async function getInventory() {
  if (_inventory) return _inventory;
  const saved = await idbLoad();
  _inventory = saved ? await mergeNewBuiltins(saved)
                     : JSON.parse(JSON.stringify(TACKLE_INVENTORY));
  if (!saved) await idbPut(IDB_SEEN_KEY, TACKLE_INVENTORY.map(l => l.id));
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
  return trollable === l.trollable ? l : { ...l, trollable };
});

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

export const RIGGED_TROLLING_WEIGHT_OZ =
  (TACKLE_INVENTORY.find((l) => l.type === 'trolling_weight' && l.rigged)
   || { weightOz: null }).weightOz;

import { scoreLureForContext, getIdealSpeed,
         trollsBehindTheBoat } from './lure-knowledge.js';

export async function selectBestLure(context = {}) {
  const inv = await getInventory();
  const { slotIndex = 0 } = context;
  const trollable = inv.filter(l => l.trollable);
  const scored = trollable
    .map(lure => ({ lure, result: scoreLureForContext(lure.type, context) }))
    .filter(s => s.result.score > -900)
    .sort((a, b) => b.result.score - a.result.score);
  if (!scored.length) return null;
  if (slotIndex === 0) return { lure: scored[0].lure, scoreResult: scored[0].result };
  const slot0Type = scored[0].lure.type;
  const slot1 = scored.find(s => s.lure.type !== slot0Type);
  const chosen = slot1 || scored[1] || scored[0];
  return { lure: chosen.lure, scoreResult: chosen.result };
}

export function getRecommendedSpeed(portLureType, stbdLureType) {
  const ps = getIdealSpeed(portLureType);
  const ss = getIdealSpeed(stbdLureType);
  if (ps && ss) return Math.round(((ps + ss) / 2) * 10) / 10;
  return ps || ss || 1.8;
}

console.log(`[tackle-inventory] ${TACKLE_INVENTORY.filter(l=>l.trollable).length} trollable lures loaded`);
