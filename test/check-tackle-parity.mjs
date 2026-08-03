/**
 * check-tackle-parity.mjs — runner-free tackle parity check.
 *
 * Same assertions as test/tackle-parity.test.js, but plain node so it runs with
 * no node_modules. Mirrors the existing `npm run lint:keys` /
 * test/check-lake-keys-parity.mjs pattern.
 *
 *     node test/check-tackle-parity.mjs        (or: npm run lint:tackle)
 *
 * Exits 1 on any failure.
 */
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';
import { LURE_KNOWLEDGE, LURE_COLORS, depthWindow, leadForDepth, canReachDepth,
         jigheadCapOz, jigheadForSwimbait } from '../js/data/lure-knowledge.js';
import { TYPE_LABELS } from '../js/modules/tackle-inventory-ui.js';
import { FISHING_STYLE } from '../js/data/fishing-style-profile.js';

const types = [...new Set(TACKLE_INVENTORY.map(l => l.type))];
const trollable = TACKLE_INVENTORY.filter(l => l.trollable);
let failures = 0;

function check(name, fn) {
  try {
    const bad = fn();
    if (bad && bad.length) {
      console.error(`  FAIL  ${name}`);
      for (const b of bad.slice(0, 12)) console.error(`          ${b}`);
      if (bad.length > 12) console.error(`          ... and ${bad.length - 12} more`);
      failures++;
    } else {
      console.log(`  ok    ${name}`);
    }
  } catch (e) {
    console.error(`  ERROR ${name}: ${e.message}`);
    failures++;
  }
}

console.log(`\ntackle parity — ${TACKLE_INVENTORY.length} lures, ${types.length} types\n`);

// ── inventory integrity ──────────────────────────────────────────────────────
check('no duplicate ids', () => {
  const ids = TACKLE_INVENTORY.map(l => l.id);
  return ids.filter((id, i) => ids.indexOf(id) !== i);
});
check('no duplicate names (names are used as keys elsewhere)', () => {
  const n = TACKLE_INVENTORY.map(l => l.name);
  return n.filter((x, i) => n.indexOf(x) !== i);
});
check('every entry has id, name, type', () =>
  TACKLE_INVENTORY.filter(l => !l.id || !l.name || !l.type).map(l => JSON.stringify(l)));

// ── every type resolves everywhere it must ───────────────────────────────────
check('every type has a LURE_KNOWLEDGE block', () => types.filter(t => !LURE_KNOWLEDGE[t]));
check('every type has a LURE_COLORS entry',    () => types.filter(t => !LURE_COLORS[t]));
check('every type has a TYPE_LABELS entry',    () => types.filter(t => !TYPE_LABELS[t]));
check('no orphan knowledge types',             () =>
  Object.keys(LURE_KNOWLEDGE).filter(t => !types.includes(t)));
check('every colour map has clear/stained/muddy', () =>
  Object.entries(LURE_COLORS)
    .filter(([, m]) => ['clear', 'muddy', 'stained'].some(k => !(k in m)))
    .map(([t]) => t));

// ── the duplicates that are supposed to be gone ──────────────────────────────
check('no inventory entry carries a dive depth', () =>
  TACKLE_INVENTORY.filter(l => 'diveDepthMin' in l || 'diveDepthMax' in l).map(l => l.id));
check('no inventory entry carries a troll speed', () =>
  TACKLE_INVENTORY.filter(l => 'trollSpeedMin' in l || 'trollSpeedMax' in l).map(l => l.id));
check('no inventory entry carries a presentationSignature', () =>
  TACKLE_INVENTORY.filter(l => 'presentationSignature' in l).map(l => l.id));

// ── depth model ──────────────────────────────────────────────────────────────
check('every type declares a depthMode; only rated/surface carry a band', () =>
  Object.entries(LURE_KNOWLEDGE).flatMap(([t, k]) => {
    const out = [];
    if (!['rated', 'lead', 'surface'].includes(k.depthMode)) out.push(`${t}: bad depthMode ${k.depthMode}`);
    if (k.depthMode === 'lead' && k.ratedDepth !== null) out.push(`${t}: lead mode must have ratedDepth null`);
    if (k.depthMode !== 'lead' && !k.ratedDepth) out.push(`${t}: ${k.depthMode} mode needs a ratedDepth`);
    return out;
  }));
check('every non-surface type has a leadRatio', () =>
  Object.entries(LURE_KNOWLEDGE)
    .filter(([, k]) => k.depthMode !== 'surface' && k.leadRatio === undefined).map(([t]) => t));
check('leadForDepth is monotonic and non-negative', () => {
  const bad = [];
  for (const l of trollable) {
    if (LURE_KNOWLEDGE[l.type].depthMode === 'surface') continue;
    let prev = -1;
    for (const d of [2, 5, 10, 15, 20, 30, 40]) {
      const lead = leadForDepth(l, d, 1.8);
      if (!(lead >= 0) || lead < prev) bad.push(`${l.id} @${d}ft -> ${lead}`);
      prev = lead;
    }
  }
  return bad;
});
check('a rated bait is never leaded past its bill', () =>
  trollable.filter(l => LURE_KNOWLEDGE[l.type].depthMode === 'rated')
    .filter(l => leadForDepth(l, 60, 1.8) !== leadForDepth(l, LURE_KNOWLEDGE[l.type].ratedDepth.max, 1.8))
    .map(l => l.id));
check('lead-controlled baits round-trip depth -> lead -> depth', () => {
  const bad = [];
  for (const l of trollable) {
    if (LURE_KNOWLEDGE[l.type].depthMode !== 'lead') continue;
    for (const d of [8, 15, 25, 35]) {
      const lead = leadForDepth(l, d, 1.8);
      const back = depthWindow(l, { speedMph: 1.8, leadFt: lead });
      if (back.min > d || back.max < d) bad.push(`${l.id} ${d}ft -> ${lead}ft -> ${back.min}-${back.max}ft`);
    }
  }
  return bad;
});

// ── speed model ──────────────────────────────────────────────────────────────
check('every type declares whether its speed limit is hard', () =>
  Object.entries(LURE_KNOWLEDGE)
    .filter(([, k]) => typeof k.speedIsHardLimit !== 'boolean').map(([t]) => t));
check('no lipped bait allowed past 3mph', () =>
  Object.entries(LURE_KNOWLEDGE)
    .filter(([, k]) => k.depthMode === 'rated' && (k.speed?.max > 3.0 || !k.speedIsHardLimit))
    .map(([t, k]) => `${t}: max ${k.speed?.max}, hard=${k.speedIsHardLimit}`));
check('lead-controlled baits impose no hard speed limit', () =>
  Object.entries(LURE_KNOWLEDGE)
    .filter(([, k]) => k.depthMode === 'lead' && k.speed && k.speedIsHardLimit).map(([t]) => t));
check('speed windows sane (min <= ideal <= max)', () =>
  Object.entries(LURE_KNOWLEDGE)
    .filter(([, k]) => k.speed && !(k.speed.min <= k.speed.ideal && k.speed.ideal <= k.speed.max))
    .map(([t, k]) => `${t}: ${JSON.stringify(k.speed)}`));
check('canReachDepth blames lead, not speed, for a sinking bait', () => {
  const b = TACKLE_INVENTORY.find(l => l.id === 'bucktail_1oz');
  const cap = FISHING_STYLE.rigging.maxLeadFt;
  const bad = [];
  if (canReachDepth(b, 20, 2.8, { maxLeadFt: cap }).limitedBy === 'speed') bad.push('bucktail speed-limited at 2.8mph');
  if (canReachDepth(b, 40, 1.8, { maxLeadFt: cap }).limitedBy !== 'lead') bad.push('bucktail at 40ft should be lead-limited');
  return bad;
});


// ── speed and lead ───────────────────────────────────────────────────────────
// Ryan, 2026-08-03: "the faster you go the more line you have to out" — and
// speedAffectsLead was false on every lead-controlled bait except the A-rigs, so
// the app returned the same lead at 1.2 mph as at 2.6. A crankbait is exempt on
// purpose: its depth is the bill, and its speed is a hard cap, not a lead input.
check('every lead-controlled type lets speed change the lead', () =>
  Object.entries(LURE_KNOWLEDGE)
    .filter(([, k]) => k.depthMode === 'lead' && !k.speedAffectsLead).map(([t]) => t));
check('faster really does mean more line, for every trollable lead bait', () => {
  const bad = [];
  for (const l of trollable) {
    if (LURE_KNOWLEDGE[l.type].depthMode !== 'lead') continue;
    const slow = leadForDepth(l, 20, 1.4), fast = leadForDepth(l, 20, 2.6);
    if (!(fast > slow)) bad.push(`${l.id}: 1.4mph -> ${slow}ft, 2.6mph -> ${fast}ft`);
  }
  return bad;
});

// ── swimbait / jighead pairing ───────────────────────────────────────────────
// Ryan, 2026-08-03: "larger weights have larger hooks that would rip apart a
// smaller swimbait... for 2-3 inch nothing more than 1/2 oz, for 3-4 inch nothing
// more than 1oz... for the 1.25 or 1.5 those would go with 5+".
check('every paddle tail declares its length', () =>
  TACKLE_INVENTORY.filter(l => l.type === 'swimbait_paddle' && !(l.lengthIn > 0)).map(l => l.id));
check('a paddle tail carries no weight of its own — the jighead is the weight', () =>
  TACKLE_INVENTORY.filter(l => l.type === 'swimbait_paddle' && l.weightOz != null).map(l => l.id));
check('the hook-size cap matches the rule as stated', () => {
  const bad = [];
  for (const [len, want] of [[2.5, 0.5], [3.0, 0.5], [3.8, 1.0], [4.6, 1.0], [5.0, 1.5], [6.0, 1.5]]) {
    const got = jigheadCapOz(len);
    if (got !== want) bad.push(`${len}" -> ${got}oz, expected ${want}oz`);
  }
  return bad;
});
check('the picker never clips on a head heavier than the bait can carry', () => {
  const bad = [];
  for (const sb of TACKLE_INVENTORY.filter(l => l.type === 'swimbait_paddle')) {
    const cap = jigheadCapOz(sb.lengthIn);
    for (const d of [5, 12, 20, 30, 40, 55]) {
      const r = jigheadForSwimbait(sb, d, 1.8);
      if (r.weightOz != null && r.weightOz > cap) bad.push(`${sb.id} @${d}ft picked ${r.weightOz}oz over a ${cap}oz cap`);
    }
  }
  return bad;
});
check('every head the picker can choose is one Ryan owns', () => {
  const owned = new Set(TACKLE_INVENTORY.filter(l => l.type === 'jighead').map(l => l.weightOz));
  const bad = [];
  for (const sb of TACKLE_INVENTORY.filter(l => l.type === 'swimbait_paddle'))
    for (const d of [5, 15, 25, 40]) {
      const r = jigheadForSwimbait(sb, d, 1.8);
      if (r.weightOz != null && !owned.has(r.weightOz)) bad.push(`${sb.id} @${d}ft -> ${r.weightOz}oz, not in the box`);
    }
  return bad;
});
check('running out of hook capacity says "longer bait", not "cannot reach"', () => {
  // The distinction decides what you do next. Blaming depth sends you looking for a
  // heavier head, which is the exact thing that tears the bait apart.
  const short = TACKLE_INVENTORY.find(l => l.type === 'swimbait_paddle' && l.lengthIn < 4.0);
  const r = jigheadForSwimbait(short, 55, 1.8);
  return r.cappedBy === 'length' ? [] : [`3.8" at 55ft reported cappedBy=${r.cappedBy}, expected 'length'`];
});
check('a heavier head needs less lead than a lighter one', () => {
  const bad = [];
  let prev = Infinity;
  for (const w of [0.25, 0.375, 0.5, 0.75, 1.0, 1.25, 1.5]) {
    const lead = leadForDepth({ type: 'swimbait_paddle', weightOz: w }, 20, 1.8);
    if (lead > prev) bad.push(`${w}oz needs ${lead}ft, more than the lighter head's ${prev}ft`);
    prev = lead;
  }
  return bad;
});

// ── gear profile ─────────────────────────────────────────────────────────────
check('FISHING_STYLE.gear has every key safety-checklist reads', () =>
  ['stakeoutPoleFt', 'anchorRopeFt', 'maxStationaryDepthFt', 'driftSock', 'sternLight360',
   'headlamp', 'whistle', 'pfd', 'drySuit', 'wadersWithBelt', 'selfRescueLadder', 'spareClothes']
    .filter(k => !(k in (FISHING_STYLE.gear || {}))));
check('stationary depth consistent with the rope and pole owned', () => {
  const g = FISHING_STYLE.gear, bad = [];
  if (g.maxStationaryDepthFt > g.anchorRopeFt) bad.push('maxStationaryDepthFt exceeds the rope');
  if (g.stakeoutPoleFt >= g.maxStationaryDepthFt) bad.push('pole should be shorter than max stationary depth');
  return bad;
});
check('no key is stated in two sections of FISHING_STYLE', () => {
  // Added 2026-08-02 after this checker's own author put maxRodsInWater in both
  // `watercraft` and `rigging`, in the file whose whole job is to be the single
  // source of truth for the boat. The rule has to apply to the person writing it.
  const seen = {};
  for (const [sec, obj] of Object.entries(FISHING_STYLE)) {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const k of Object.keys(obj)) (seen[k] ??= []).push(sec);
    }
  }
  return Object.entries(seen).filter(([, s]) => s.length > 1)
    .map(([k, s]) => `${k} appears in ${s.join(' and ')}`);
});

check('rigging.maxLeadFt is set', () =>
  FISHING_STYLE.rigging?.maxLeadFt > 0 ? [] : ['rigging.maxLeadFt missing or zero']);

console.log(failures
  ? `\n${failures} check(s) FAILED\n`
  : `\nall checks passed\n`);
process.exit(failures ? 1 : 0);
