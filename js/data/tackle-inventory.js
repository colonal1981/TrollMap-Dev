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
 *   ✅ Trolling speed range (physics — not tactics)
 *   ✅ Dive depth range (physical dive curve at normal trolling speeds)
 *   ✅ IDB persistence
 *   ✅ Planner API (selectBestLure — delegates scoring to lure-knowledge)
 *   ❌ No color logic
 *   ❌ No fishing tactics
 *   ❌ No jighead selection logic
 *   ❌ No species knowledge
 *
 * Speed/depth ranges are PHYSICAL constraints, not suggestions.
 * They exist so the Groq prompt can enforce compatibility between
 * lure selection and trolling speed — preventing choices like
 * "SR Crankbait at 2.5mph" which would blow the lure to the surface.
 *
 * diveDepthMin/Max: feet the lure reaches at typical trolling speeds
 * trollSpeedMin/Max: mph range where the lure performs correctly
 * For variable-depth lures (A-rigs, spoons, swimbaits), depth is
 * controlled by lead length — diveDepth is null.
 */

export const TACKLE_INVENTORY = [

  // ── Crankbaits ────────────────────────────────────────────────────────────
  // Dive depths are at ~40-50ft of 10lb mono equivalent lead.
  // Speed range: too slow = no action, too fast = blows out near surface.
  { id:'cb_squarebill', name:'Squarebill Crankbait',
    type:'crankbait_squarebill', trollable:true, weightOz:null,
    diveDepthMin:2,  diveDepthMax:5,
    trollSpeedMin:1.4, trollSpeedMax:2.2 },

  { id:'cb_sr', name:'SR Crankbait (3-5ft)',
    type:'crankbait_sr', trollable:true, weightOz:null,
    diveDepthMin:3,  diveDepthMax:5,
    trollSpeedMin:1.2, trollSpeedMax:1.8 },

  { id:'cb_mr', name:'MR Crankbait (6-12ft)',
    type:'crankbait_mr', trollable:true, weightOz:null,
    diveDepthMin:6,  diveDepthMax:12,
    trollSpeedMin:1.4, trollSpeedMax:2.0 },

  { id:'cb_dd1', name:'DD1 Crankbait (14-18ft)',
    type:'crankbait_dd1', trollable:true, weightOz:null,
    diveDepthMin:14, diveDepthMax:18,
    trollSpeedMin:1.6, trollSpeedMax:2.2 },

  { id:'cb_dd2', name:'DD2 Crankbait (16-20ft)',
    type:'crankbait_dd2', trollable:true, weightOz:null,
    diveDepthMin:16, diveDepthMax:20,
    trollSpeedMin:1.6, trollSpeedMax:2.2 },

  { id:'cb_dd3', name:'DD3 Crankbait (20-25ft)',
    type:'crankbait_dd3', trollable:true, weightOz:null,
    diveDepthMin:20, diveDepthMax:25,
    trollSpeedMin:1.8, trollSpeedMax:2.4 },

  { id:'cb_dd4', name:'DD4 Crankbait (25ft+)',
    type:'crankbait_dd4', trollable:true, weightOz:null,
    diveDepthMin:25, diveDepthMax:35,
    trollSpeedMin:1.8, trollSpeedMax:2.4 },

  // ── Lipless & Blade Vibes ─────────────────────────────────────────────────
  // Lipless: sink rate controls depth, speed keeps action. Too fast = rises.
  { id:'lipless_2in', name:'2" Lipless Crankbait',
    type:'lipless', trollable:true, weightOz:null, sizes:['2"'],
    diveDepthMin:3,  diveDepthMax:10,
    trollSpeedMin:1.4, trollSpeedMax:2.0 },

  { id:'lipless_3in', name:'3" Lipless Crankbait',
    type:'lipless', trollable:true, weightOz:null, sizes:['3"'],
    diveDepthMin:4,  diveDepthMax:12,
    trollSpeedMin:1.4, trollSpeedMax:2.0 },

  { id:'lipless_4in', name:'4" Lipless Crankbait',
    type:'lipless', trollable:true, weightOz:null, sizes:['4"'],
    diveDepthMin:5,  diveDepthMax:14,
    trollSpeedMin:1.4, trollSpeedMax:2.0 },

  { id:'blade_3in', name:'3" Blade Vibe Bait',
    type:'blade_vibe', trollable:true, weightOz:null, sizes:['3"'],
    diveDepthMin:4,  diveDepthMax:12,
    trollSpeedMin:1.4, trollSpeedMax:2.2 },

  // ── A-Rigs / Umbrella Rigs ────────────────────────────────────────────────
  // Variable depth — lead length controls depth, not lure design.
  // Speed range: too fast = blades spin wrong, too slow = no roll.
  { id:'arig_light',  name:'A-Rig Light (~1.65oz) – 3.8" Swimbait',
    type:'umbrella_rig', trollable:true, weightOz:1.65,
    jigWeights:[0.125,0.1875,0.25], sizes:['3.8"'],
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.4, trollSpeedMax:2.0 },

  { id:'arig_medium', name:'A-Rig Medium (~2.65oz) – 4.6" Swimbait',
    type:'umbrella_rig', trollable:true, weightOz:2.65,
    jigWeights:[0.1875,0.25,0.375], sizes:['4.6"'],
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.4, trollSpeedMax:2.0 },

  { id:'arig_heavy',  name:'A-Rig Heavy (~3.5oz) – 5" Swimbait',
    type:'umbrella_rig', trollable:true, weightOz:3.5,
    jigWeights:[0.25,0.375,0.5], sizes:['5"'],
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.4, trollSpeedMax:2.0 },

  // ── Swimbaits (Paddle Tail) ───────────────────────────────────────────────
  // Variable depth via lead/jighead weight.
  { id:'swimbait_3in', name:'Swimbait 3.8" – Jighead',
    type:'swimbait_paddle', trollable:true, weightOz:null,
    jigWeights:[0.125,0.1875,0.25], sizes:['3"'],
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.4, trollSpeedMax:2.2 },

  { id:'swimbait_4in', name:'Swimbait 4.6" – Jighead',
    type:'swimbait_paddle', trollable:true, weightOz:null,
    jigWeights:[0.1875,0.25,0.375,0.5], sizes:['4"'],
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.4, trollSpeedMax:2.2 },

  { id:'swimbait_5in', name:'Swimbait 5" – Jighead',
    type:'swimbait_paddle', trollable:true, weightOz:null,
    jigWeights:[0.25,0.375,0.5,0.75], sizes:['5"'],
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.4, trollSpeedMax:2.2 },

  // ── Flutter Spoons ────────────────────────────────────────────────────────
  // Variable depth via lead. Must be trolled horizontally, not vertically.
  // Speed too slow = no flutter action; too fast = rolls and tangles.
  { id:'spoon_3quarter', name:'Flutter Spoon 3/4oz + 2oz Torpedo',
    type:'flutter_spoon', trollable:true, weightOz:0.75,
    inlineWeightOz:2.0, systemWeightOz:2.75,
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.6, trollSpeedMax:2.4 },

  // ── Spinnerbaits ──────────────────────────────────────────────────────────
  // Variable depth via blade angle and speed. Too slow = blades don't spin.
  { id:'spinner_quarter',  name:'1/4oz Spinnerbait',
    type:'spinnerbait', trollable:true, weightOz:0.25,
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.6, trollSpeedMax:2.4 },

  { id:'spinner_3eighth',  name:'3/8oz Spinnerbait',
    type:'spinnerbait', trollable:true, weightOz:0.375,
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.6, trollSpeedMax:2.4 },

  { id:'spinner_half',     name:'1/2oz Spinnerbait',
    type:'spinnerbait', trollable:true, weightOz:0.5,
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.6, trollSpeedMax:2.4 },

  // ── Chatterbaits ──────────────────────────────────────────────────────────
  { id:'chatter_quarter',  name:'1/4oz Chatterbait',
    type:'chatterbait', trollable:true, weightOz:0.25,
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.6, trollSpeedMax:2.4 },

  { id:'chatter_3eighth',  name:'3/8oz Chatterbait',
    type:'chatterbait', trollable:true, weightOz:0.375,
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.6, trollSpeedMax:2.4 },

  { id:'chatter_half',     name:'1/2oz Chatterbait',
    type:'chatterbait', trollable:true, weightOz:0.5,
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.6, trollSpeedMax:2.4 },

  // ── Bucktail / Marabou Jigs ───────────────────────────────────────────────
  // Variable depth. Excellent striped bass trolling lures.
  { id:'bucktail_3quarter', name:'3/4oz Bucktail Jig',
    type:'bucktail', trollable:true, weightOz:0.75,
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.6, trollSpeedMax:2.8 },

  { id:'bucktail_1oz',      name:'1oz Bucktail Jig',
    type:'bucktail', trollable:true, weightOz:1.0,
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.6, trollSpeedMax:2.8 },

  { id:'marabou_3quarter',  name:'3/4oz Marabou Jig',
    type:'marabou_jig', trollable:true, weightOz:0.75,
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.4, trollSpeedMax:2.4 },

  // ── Jigheads ─────────────────────────────────────────────────────────────
  { id:'jighead_quarter',  name:'1/4oz Jighead',
    type:'jighead', trollable:true, weightOz:0.25,
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.4, trollSpeedMax:2.2 },

  { id:'jighead_3eighth',  name:'3/8oz Jighead',
    type:'jighead', trollable:true, weightOz:0.375,
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.4, trollSpeedMax:2.2 },

  { id:'jighead_half',     name:'1/2oz Jighead',
    type:'jighead', trollable:true, weightOz:0.5,
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.4, trollSpeedMax:2.2 },

  { id:'jighead_3quarter', name:'3/4oz Jighead',
    type:'jighead', trollable:true, weightOz:0.75,
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.4, trollSpeedMax:2.2 },

  { id:'jighead_1oz',      name:'1oz Jighead',
    type:'jighead', trollable:true, weightOz:1.0,
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.4, trollSpeedMax:2.2 },

  // ── Road Runner / Beetle Spin ─────────────────────────────────────────────
  { id:'road_runner_eighth',  name:'1/8oz Road Runner / Beetle Spin',
    type:'road_runner', trollable:true, weightOz:0.125,
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.2, trollSpeedMax:2.0 },

  { id:'road_runner_quarter', name:'1/4oz Road Runner / Beetle Spin',
    type:'road_runner', trollable:true, weightOz:0.25,
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.2, trollSpeedMax:2.0 },

  { id:'road_runner_3eighth', name:'3/8oz Road Runner / Beetle Spin',
    type:'road_runner', trollable:true, weightOz:0.375,
    diveDepthMin:null, diveDepthMax:null,
    trollSpeedMin:1.2, trollSpeedMax:2.0 },

  // ── Topwater (Trollable) ──────────────────────────────────────────────────
  // Surface lures — depth is always 0. Speed sets the action.
  { id:'tw_walker',  name:'Walking Bait / Spook',
    type:'topwater_troll', trollable:true, weightOz:null,
    diveDepthMin:0, diveDepthMax:1,
    trollSpeedMin:1.6, trollSpeedMax:2.4 },

  { id:'tw_prop',    name:'Prop Bait / Choppo',
    type:'topwater_troll', trollable:true, weightOz:null,
    diveDepthMin:0, diveDepthMax:1,
    trollSpeedMin:1.8, trollSpeedMax:2.6 },

  { id:'tw_plopper', name:'Whopper Plopper',
    type:'topwater_troll', trollable:true, weightOz:null,
    diveDepthMin:0, diveDepthMax:1,
    trollSpeedMin:1.8, trollSpeedMax:2.6 },

  { id:'tw_wake',    name:'Wake Bait',
    type:'topwater_troll', trollable:true, weightOz:null,
    diveDepthMin:0, diveDepthMax:2,
    trollSpeedMin:1.6, trollSpeedMax:2.2 },

  // ── Cast Only ─────────────────────────────────────────────────────────────
  { id:'tw_popper',      name:'Popper / Chugger',       type:'topwater_cast', trollable:false, weightOz:null },
  { id:'tw_buzzbait',    name:'Buzzbait',               type:'topwater_cast', trollable:false, weightOz:null },
  { id:'tw_frog',        name:'Hollow Body Frog',       type:'topwater_cast', trollable:false, weightOz:null },
  { id:'cast_stickbait', name:'Stick Bait (Senko)',     type:'cast_only',     trollable:false, weightOz:null },
  { id:'cast_worm',      name:'Plastic Worm',           type:'cast_only',     trollable:false, weightOz:null },
  { id:'cast_creature',  name:'Creature Bait / Craw',  type:'cast_only',     trollable:false, weightOz:null },
  { id:'cast_fluke',     name:'Fluke / Soft Jerkbait', type:'cast_only',     trollable:false, weightOz:null },
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

export async function getInventory() {
  if (_inventory) return _inventory;
  const saved = await idbLoad();
  _inventory = saved || JSON.parse(JSON.stringify(TACKLE_INVENTORY));
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
