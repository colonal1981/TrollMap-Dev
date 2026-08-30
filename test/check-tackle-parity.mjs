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
import { TACKLE_INVENTORY, JIGHEADS_OWNED_OZ } from '../js/data/tackle-inventory.js';
import { LURE_KNOWLEDGE, LURE_COLORS, depthWindow, leadForDepth, canReachDepth,
         jigheadRangeOz, jigheadForSwimbait } from '../js/data/lure-knowledge.js';
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
// 'none' is a fourth mode, added 2026-08-30 with the cast-only fix: a bait that PLANES at
// trolling speed has no running depth at any lead, and saying so is what stopped a Fluke sitting
// on a troll rod for three legs. This check listed three modes and failed the fourth ever since.
check('every type declares a depthMode; only rated/surface carry a band', () =>
  Object.entries(LURE_KNOWLEDGE).flatMap(([t, k]) => {
    const out = [];
    if (!['rated', 'lead', 'surface', 'none'].includes(k.depthMode)) out.push(`${t}: bad depthMode ${k.depthMode}`);
    // A band is a claim about where the bait runs. Only the two modes that HAVE a running depth
    // may carry one; 'lead' computes it and 'none' has none to carry.
    if (['lead', 'none'].includes(k.depthMode) && k.ratedDepth !== null) out.push(`${t}: ${k.depthMode} mode must have ratedDepth null`);
    if (['rated', 'surface'].includes(k.depthMode) && !k.ratedDepth) out.push(`${t}: ${k.depthMode} mode needs a ratedDepth`);
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
// Ryan, 2026-08-30: "3.8 in can go with 1/4-1/2, 4.6 should go with 1/2-1, 5 inch can 3/4 - 1oz
// and the 6 inch that is not in the inventory that i do have can go 1-1.5oz" — then, on being
// asked whether the low end was a wall: "i mean the 1/4 can go with a 4.6 i was just trying to
// make it a little easier on the app". So the top of each pair is a hard hook-size limit and the
// bottom is where the picker starts.
const fit = (sb, d, mph = 1.8) =>
  jigheadForSwimbait(sb, d, mph, { jigheads: JIGHEADS_OWNED_OZ, maxLeadFt: FISHING_STYLE.rigging.maxLeadFt });
const paddleTails = TACKLE_INVENTORY.filter(l => l.type === 'swimbait_paddle');

check('every paddle tail declares its length', () =>
  paddleTails.filter(l => !(l.lengthIn > 0)).map(l => l.id));
check('a paddle tail carries no weight of its own — the jighead is the weight', () =>
  paddleTails.filter(l => l.weightOz != null).map(l => l.id));
check('the head range matches the rule as stated', () => {
  const bad = [];
  for (const [len, want] of [[3.8, [0.25, 0.5]], [4.6, [0.5, 1.0]],
                             [5.0, [0.75, 1.0]], [6.0, [1.0, 1.5]]]) {
    const got = jigheadRangeOz(len);
    if (got.startOz !== want[0] || got.maxOz !== want[1])
      bad.push(`${len}" -> ${got.startOz}-${got.maxOz}oz, expected ${want[0]}-${want[1]}oz`);
  }
  return bad;
});
check('the picker never clips on a head heavier than the bait can carry', () => {
  const bad = [];
  for (const sb of paddleTails) {
    const { maxOz } = jigheadRangeOz(sb.lengthIn);
    for (const d of [5, 12, 20, 30, 40, 55]) {
      const r = fit(sb, d);
      if (r.weightOz != null && r.weightOz > maxOz)
        bad.push(`${sb.id} @${d}ft picked ${r.weightOz}oz over a ${maxOz}oz cap`);
    }
  }
  return bad;
});
check('the picker never goes lighter than where the bait starts', () => {
  // Lighter is legal by hand — it is not the app's to choose, because the only thing it buys is
  // action. Going lighter on its own is what put a 1/4oz head on a 4.6" bait asking 104ft of lead.
  const bad = [];
  for (const sb of paddleTails) {
    const { startOz } = jigheadRangeOz(sb.lengthIn);
    for (const d of [3, 5, 12, 20, 30, 40]) {
      const r = fit(sb, d);
      if (r.weightOz != null && r.weightOz < startOz)
        bad.push(`${sb.id} @${d}ft picked ${r.weightOz}oz below a ${startOz}oz start`);
    }
  }
  return bad;
});
check('a deeper target never asks for a lighter head', () => {
  const bad = [];
  for (const sb of paddleTails) {
    let prev = 0;
    for (const d of [5, 10, 15, 20, 25, 30, 35, 40]) {
      const w = fit(sb, d).weightOz;
      if (w != null && w < prev) bad.push(`${sb.id}: ${d}ft picked ${w}oz after ${prev}oz`);
      if (w != null) prev = w;
    }
  }
  return bad;
});
check('every head the picker can choose is one Ryan owns', () => {
  const owned = new Set(TACKLE_INVENTORY.filter(l => l.type === 'jighead').map(l => l.weightOz));
  const bad = [];
  for (const sb of paddleTails)
    for (const d of [5, 15, 25, 40]) {
      const r = fit(sb, d);
      if (r.weightOz != null && !owned.has(r.weightOz)) bad.push(`${sb.id} @${d}ft -> ${r.weightOz}oz, not in the box`);
    }
  return bad;
});
check('JIGHEADS_OWNED_OZ is the box and nothing else', () => {
  const owned = TACKLE_INVENTORY.filter(l => l.type === 'jighead').map(l => l.weightOz).sort((a, b) => a - b);
  return JIGHEADS_OWNED_OZ.join(',') === owned.join(',')
    ? [] : [`derived ${JIGHEADS_OWNED_OZ.join(',')} vs entries ${owned.join(',')}`];
});
check('the picker without a box says so instead of guessing one', () => {
  const r = jigheadForSwimbait(paddleTails[0], 15, 2, {});
  return r && r.cappedBy === 'no jigheads' && r.weightOz == null
    ? [] : [`got ${JSON.stringify(r)}`];
});
check('running out of hook capacity says "longer bait", not "cannot reach"', () => {
  // The distinction decides what you do next. Blaming depth sends you looking for a
  // heavier head, which is the exact thing that tears the bait apart.
  const short = paddleTails.find(l => l.lengthIn < 4.0);
  const r = fit(short, 55);
  return r.cappedBy === 'length' ? [] : [`3.8" at 55ft reported cappedBy=${r.cappedBy}, expected 'length'`];
});
check('the longest bait blames the lead, not the bait', () => {
  // Nothing longer to reach for, so "go to a longer swimbait" would be a dead end.
  const longest = paddleTails.reduce((a, b) => (b.lengthIn > a.lengthIn ? b : a));
  const r = fit(longest, 55);
  return r.cappedBy === 'lead' ? [] : [`${longest.id} at 55ft reported cappedBy=${r.cappedBy}, expected 'lead'`];
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
