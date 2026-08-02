/**
 * tackle-inventory.js — Ryan's personal lure inventory.
 *
 * This file ONLY answers: "What does Ryan own?"
 * All fishing behavior lives in lure-knowledge.js.
 * All species strategy lives in species-strategies.js.
 *
 * Strict boundaries:
 *   ✅ What lures Ryan owns
 *   ✅ Physical specs (weight, sizes, jighead options)
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

export const TACKLE_INVENTORY = [

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
    jigWeights:[0.125,0.1875,0.25], sizes:['3.8"'] },

  { id:'arig_medium', name:'A-Rig Medium (~2.65oz) – 4.6" Swimbait',
    type:'umbrella_rig', trollable:true, castable:true, weightOz:2.65,
    jigWeights:[0.1875,0.25,0.375], sizes:['4.6"'] },

  { id:'arig_heavy',  name:'A-Rig Heavy (~3.5oz) – 5" Swimbait',
    type:'umbrella_rig', trollable:true, castable:true, weightOz:3.5,
    jigWeights:[0.25,0.375,0.5], sizes:['5"'] },

  // ── Swimbaits (Paddle Tail) ───────────────────────────────────────────────
  { id:'swimbait_3in', name:'Swimbait 3.8" – Jighead',
    type:'swimbait_paddle', trollable:true, castable:true, weightOz:null,
    jigWeights:[0.125,0.1875,0.25], sizes:['3"'] },

  { id:'swimbait_4in', name:'Swimbait 4.6" – Jighead',
    type:'swimbait_paddle', trollable:true, castable:true, weightOz:null,
    jigWeights:[0.1875,0.25,0.375,0.5], sizes:['4"'] },

  { id:'swimbait_5in', name:'Swimbait 5" – Jighead',
    type:'swimbait_paddle', trollable:true, castable:true, weightOz:null,
    jigWeights:[0.25,0.375,0.5,0.75], sizes:['5"'] },

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

  // ── Vertical / Knife Jigs ────────────────────────────────────
  // Trollable, not cast-only — a dense wire-through body holds depth at speed.
  // 2-3oz is not heavy in context: a 1oz bucktail behind a 2oz trolling weight is
  // already 3oz through the water. Depth comes from lead length, so diveDepth stays
  // null and the planner works it out from tacticalDepth.
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

  // ── Soft Plastics / Cast Only ─────────────────────────────────────────────
  { id:'cast_stickbait', name:'Stick Bait (Senko)',     type:'cast_only',     trollable:false, castable:true, weightOz:0.375 },

  { id:'cast_worm',      name:'Plastic Worm',           type:'cast_only',     trollable:false, castable:true, weightOz:0.25 },

  { id:'cast_creature',  name:'Creature Bait / Craw',  type:'cast_only',     trollable:false, castable:true, weightOz:0.5 },

  { id:'cast_fluke',     name:'Fluke / Soft Jerkbait', type:'cast_only',     trollable:false, castable:true, weightOz:0.375 },
];

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
  try {
    const db = await openDB();
    db.transaction(IDB_STORE,'readwrite').objectStore(IDB_STORE).put({ key:IDB_KEY, value:inv });
    _inventory = inv;
  } catch {}
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
  } catch {}
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

// ── Planner API — delegates all scoring to lure-knowledge.js ─────────────────
import { scoreLureForContext, getIdealSpeed } from './lure-knowledge.js';

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
