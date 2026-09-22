/**
 * plan-prompt.js — what the model is asked, and what comes back.
 *
 * THE POINT OF THIS FILE: the response shape is *exactly* the arguments `assemblePlan` takes.
 * There is no translation layer in the middle, because a translation layer is where the old
 * planner rotted — the prompt, the timeline and the renderer each drifted their own way and new
 * data got bolted onto the seams. `planArgsFrom()` is the only mapping, and it is tested.
 *
 * THE MODEL NEVER EMITS A COORDINATE. It names a `runId` and a structure `id` out of the
 * candidates the app handed it. That is what makes a route over land structurally impossible
 * instead of something the renderer has to cope with, and it is why nothing here asks for a
 * lat/lon or accepts one.
 *
 * ---------------------------------------------------------------------------------------------
 * THE ROD MODEL, WHICH TOOK THREE TRIES TO GET RIGHT
 *
 * Four rods carry a 20 lb fluoro leader. Two carry swivel snaps. **That is permanent terminal
 * tackle, not something a plan chooses.**
 *
 * What a plan chooses is the lure, and the lure decides which kind of rod it can go on, because
 * some lures will not swim with a snap hanging off the nose. Ryan, 2026-08-07: "certain lures
 * should not have a swivel snap added to them because the weight and the extra metal messes with
 * it." That table lives in `lure-knowledge.js` as `TERMINAL_CONNECTION` and he ruled on every
 * type in the inventory himself.
 *
 * And THAT decides which two rods end up in the water: "if the current plan calls for 2 deep
 * diving crankbaits then 2 of the 4 with fluro would have the crankbaits tied on and they would
 * be the 2 in the water... but if the plan called for 1 flutter spoon and an A-rig then the 2
 * snap rods would be in use."
 *
 * So the failure mode is not "wrong rod" — he seats the rods himself and says so. It is asking
 * for a loadout that **cannot be seated at all**: "the only way this can get screwed up is if you
 * try to do 6 things that all should be direct tie... that would require me to cut off the swivel
 * snap, tie on a leader, and then tie the leader to the lure — prefer not to do that on the
 * water." Hence one hard rule: at most four tie-only lures in a six-rod loadout.
 *
 * `seatRods()` below therefore does not trust the model's rod assignment and does not need to.
 * It re-seats every lure onto a legal rod and rewrites every reference to match, so the only
 * thing the model can actually get wrong is asking for more leaders than there are leader rods.
 *
 * WHAT THE LOADOUT IS FOR, which I got backwards for one commit. Ryan, 2026-08-07: "the whole
 * point is that i am given lures that have the best chance of catching that species of fish at
 * that time of year in that place."
 *
 * So the prompt asks for six considered choices and says why each earns its rod. Read alongside
 * his other remark — "if the LLM wants to use the same 2 lures all day then no big deal, the
 * other 4 just stay staged behind me with whatever was already on them" — that is TOLERANCE for a
 * day that only fishes two of the six, not licence to recommend fewer. Naming two rods is not an
 * error the code should reject, but it is not the job either.
 *
 * Rods the plan does not name come back `staged: true` with a null lure. The app must not invent
 * something for them and must not deploy one or send him to change one, because it has no idea
 * what is on it.
 * ---------------------------------------------------------------------------------------------
 */

// ONE PLACE KNOWS HOW DEEP A BAIT RUNS, and until now the prompt was not one of its readers.
import { levelSentence } from '../utils/water-conditions.js';
import { lakeRecordFor } from '../data/lake-registry.js';
import { compassOf } from '../utils/compass.js';
import { isNum, num } from '../utils/num.js';
import { depthWindow, jigheadRangeOz, trollableBaits, describeBait, LURE_KNOWLEDGE,
         gpsWindowFor } from '../data/lure-knowledge.js';
import { RIGGED_TROLLING_WEIGHT_OZ, JIGHEADS_OWNED_OZ } from '../data/tackle-inventory.js';
import { ozLabel } from '../utils/oz.js';
import { promptSafeTackleName } from '../utils/tackle-name.js';
import { FISHING_STYLE } from '../data/fishing-style-profile.js';
// The radius `relief`, `deepestNearbyFt` and `reliefDropFt` are all measured over. Imported rather
// than typed here so the prompt cannot come to say a distance the selector does not mean; see
// RELIEF_RADIUS_M for why the app holds the number at all instead of reading it off the pack.
import { RELIEF_RADIUS_M } from './plan-candidates.js';
import { lightSummary, lightPhrasesIn, lightLabel } from '../utils/light-state.js';

// Six rods. This never changes; it is the boat, not a setting.
export const ROD_IDS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'];

// Four leader rods, two snap rods. Which physical rod wears which id does not matter — what is
// real is the COUNT, four and two. The ids are handles so the plan can say "the A-rig is on a
// snap rod" without naming a piece of graphite.
export const ROD_RIG = Object.freeze({
  R1: 'fluoro', R2: 'fluoro', R3: 'fluoro', R4: 'fluoro',
  R5: 'snap', R6: 'snap',
});
export const FLUORO_RODS = ROD_IDS.filter((id) => ROD_RIG[id] === 'fluoro');
export const SNAP_RODS = ROD_IDS.filter((id) => ROD_RIG[id] === 'snap');

// Two in the water at once, one per side, in the holders in front of the seat. The other four
// wait in the vertical holders behind it. `side` is which holder a rod is in on this leg, never
// a property of the rod.
export const SIDES = ['port', 'starboard'];

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
// `num` and `isNum` now come from utils/num.js. The local copy read
// `Number.isFinite(Number(v)) ? Number(v) : null` and returned 0 for null, '' and blanks — see
// that file for the five prompt lines it printed and the eight times this family has come back.

// ── The tackle-name resolver, moved from smart-plan.js:111-196 ────────────────────────────────
//
// WHAT WAS WRONG. planArgsFrom() checked the model's lure against `new Set(ctx.tackle)` with
// `Set.has()` — an exact string match. The inventory calls it 'DD3 Crankbait (20-25ft)'; the
// model, handed that exact string in the prompt, answered "DD3 Crankbait". So the plan Ryan took
// on the water said
//
//     R1: "DD3 Crankbait" is not in the tackle inventory
//     R2: "DD2 Crankbait" is not in the tackle inventory
//
// about two lures that were sitting in the bag. His reply was "i see them in the inventory."
// A warning that fires on good data teaches him to ignore warnings, which is worse than no
// warning at all.
//
// WHY THIS IS V1'S MATCHER AND NOT A NEW ONE. v1 never had this bug, because
// `sanitizeGroqLureName()` (smart-plan.js:160-196) resolved in tiers and its third tier is a
// substring test in BOTH directions (`:181-182`) — which is exactly this case. It and
// `stripLureAnnotation()` are moved here tier for tier.
//
// THE ONE DELIBERATE DIFFERENCE. v1's final tier is `depthFallbackLure()`: when nothing matches
// it picks a lure out of the inventory by depth keyword, because v1 had to put SOMETHING on the
// rod. Here an unresolved name must stay unresolved — the entire purpose of this call site is to
// report a lure the boat does not carry, and a resolver that always succeeds cannot do that. So
// the fallback tier is not brought across: this returns null instead, and it returns WHICH tier
// matched, so a word-overlap guess can be reported as a guess rather than passed off as a hit.
//
// v1's copy is left where it is. smart-plan.js still calls it from `runSmartPlan()`, and that
// file is scheduled for deletion as a whole rather than hollowed out a function at a time.

/**
 * THE INCH MARK IN A LURE NAME BREAKS THE JSON WE ASK THE MODEL TO WRITE.
 *
 * Ryan, 2026-09-05, on a plan that died whole:
 *
 *     the model's answer could not be read: Expected ',' or '}' after property value in JSON
 *     at position 1608 ... { "id": "R5", "lure": "3" <<HERE>>Lipless Crankbait", ...
 *
 * The bag holds `3" Lipless Crankbait`. The prompt printed it raw, in the tackle list and again
 * in the per-bait depth note, and asked for `"lure": "exact name from the list"`. The model did
 * exactly that and the unescaped quote ended the string four characters in. TWELVE OF SIXTY-ONE
 * lures carry an inch mark, so a fifth of the bag can kill a plan outright -- not one rod, the
 * whole day, after the pack was fetched and every leg computed.
 *
 * NOT REPAIRED ON THE WAY BACK, DELIBERATELY. parsePlanResponse() does repair a trailing comma,
 * and says why it is allowed to: "JSON forbids the comma outright, so there is exactly one
 * reading of the text with it removed." An unescaped quote inside a string has no such property
 * -- `"3" Lipless Crankbait"` could be the string `3` followed by anything -- so recovering it
 * means guessing where the value ends. The fix is to stop handing the model a character it has
 * to escape.
 *
 * `in` rather than a typographic prime, because the model has to retype it. Checked against the
 * whole inventory: 61 names give 61 distinct quote-free forms, so nothing collides.
 */
// THE ONE COPY IS IN js/utils/tackle-name.js, so the bench reader can undo exactly this substitution
// without importing the prompt builder. Re-exported here because this is where every caller in the
// planner already reaches for it.
export { promptSafeTackleName };

/** Strip the `[...]` annotation bracket a prompt may have hung on a lure name. */
export function stripLureAnnotation(raw) {
  if (!raw) return raw;
  return String(raw).replace(/\s*\[.*$/, '').trim();
}

/**
 * Resolve a lure name the model returned against the inventory's own names.
 *
 * @param   {string}   raw             what the model said
 * @param   {string[]} inventoryNames  the names the prompt handed it
 * @returns {{name: string, tier: 'exact'|'substring'|'words'}|null} null when nothing matches
 */
export function resolveTackleName(raw, inventoryNames) {
  const stripped = stripLureAnnotation(raw);
  if (!stripped) return null;
  const r = String(stripped).toLowerCase().trim();
  if (!r) return null;

  const cleanMap = (inventoryNames || [])
    .map((orig) => ({ orig, clean: stripLureAnnotation(orig) }))
    .filter((m) => m.clean);
  if (!cleanMap.length) return null;

  const exact = cleanMap.find((m) => m.clean.toLowerCase() === r);
  if (exact) return { name: exact.clean, tier: 'exact' };

  // THE FORM THE PROMPT ACTUALLY SHOWED IT, which is not the inventory's spelling. Lure names
  // carrying an inch mark go to the model as `3in Lipless Crankbait` -- see
  // promptSafeTackleName() -- so this is the name it was asked to echo and matching it is exact,
  // not a guess. It has to sit ABOVE the word tier, because that tier resolves
  // `3in Lipless Crankbait` to `2" Lipless Crankbait`: no shared token carries the size, so it
  // scores on "lipless" and "crankbait" and takes whichever comes first. A crash traded for a
  // silently wrong bait is not a fix.
  const asShown = cleanMap.find((m) => promptSafeTackleName(m.clean).toLowerCase() === r);
  if (asShown) return { name: asShown.clean, tier: 'exact' };

  // THE TIER THAT FIXES THE BUG. 'DD3 Crankbait' is inside 'DD3 Crankbait (20-25ft)', and a
  // model asked for a shorter name than the inventory's is the common direction — but the
  // reverse happens too ("DD3 Crankbait (20-25 ft) deep diver"), so both are tested.
  const substr = cleanMap.find((m) => {
    const nl = m.clean.toLowerCase();
    return nl.includes(r) || r.includes(nl);
  });
  if (substr) return { name: substr.clean, tier: 'substring' };

  const rWords = r.replace(/[^a-z0-9"]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  let bestName = null;
  let bestScore = 0;
  for (const { clean } of cleanMap) {
    const nl = clean.toLowerCase();
    const score = rWords.filter((w) => nl.includes(w)).length;
    if (score > bestScore) { bestScore = score; bestName = clean; }
  }
  if (bestScore >= 1) return { name: bestName, tier: 'words' };

  return null;
}

/**
 * THE COASTAL BLOCK, and the one rule in this whole prompt that is about staying alive.
 *
 * v1 carried it twice — `buildCoastalPromptBlock()` and a second `coastalSafetyBlock` spliced
 * into the rod constraints — and v2 carried it nowhere. So between v1's deletion and now, asking
 * for a plan on Charleston Harbour got a prompt that had never been told this is a 12.5 ft pedal
 * kayak on an estuary, and nothing stopped a route out past the jetties.
 *
 * THE TIDE IS NOT WEATHER. On a reservoir the water is where it was yesterday; on a flat it is
 * four feet somewhere else, and the same structure is a target or dry ground depending on the
 * hour. That is why the stage drives the depth band rather than the species table alone.
 *
 * Returns '' when there is nothing tidal, so a lake prompt is byte-for-byte what it was.
 */
export function coastalPromptBlock(ws) {
  const t = ws && ws.tidal;
  if (!t) return '';
  const L = [];
  L.push(`\n\u{1F30A} COASTAL / TIDAL WATER${t.zone ? ` — ${t.zone}` : ''}`);
  L.push('STRICT SAFETY CONSTRAINT: you are restricted to INSHORE water — marsh edges, tidal '
    + 'creeks, estuary mouths, oyster bars and shallow flats. NEVER route past the jetties, into '
    + 'the open ocean, or into open-water surf. This is a 12.5 ft pedal kayak, not an offshore '
    + 'boat, and there is no version of a good day that starts by going outside.');
  L.push('CHARTED DEPTHS ARE MLLW MINIMUMS — the least water that will be there. Add the tide '
    + 'height to get the water actually under the hull, and when the tide is falling, plan the '
    + 'way back out before the way in.');

  if (t.stage) {
    const h = t.heightFtAboveMllw != null ? ` · ${t.heightFtAboveMllw} ft above MLLW` : '';
    L.push(`Tide at launch: ${t.stageLabel || t.stage}${h}`
      + (t.dailyRangeFt != null ? ` · ${t.dailyRangeFt} ft range today` : ''));
  } else {
    L.push('THE TIDE STAGE IS UNKNOWN — no station answered. Treat every charted depth as the '
      + 'MLLW minimum, stay off the skinny water, and say in the plan that the tide was not read.');
  }
  if (t.nextEvent) {
    L.push(`Next turn: ${String(t.nextEvent.type).toUpperCase()}`
      + `${t.nextEvent.at ? ` at ${t.nextEvent.at}` : ''}`
      + `${t.nextEvent.heightFt != null ? ` (${t.nextEvent.heightFt} ft)` : ''}`
      + ' — the day has a shape around that, and the plan should say what changes when it turns.');
  }
  // THE CURRENT, AND EVERYTHING THAT SAYS WHETHER IT IS ABOUT THIS CREEK.
  //
  // This line used to say "Current: flood 1.8 kn" and stop. It asked the model to say which way
  // the water is running while giving it no direction -- the set was computed by
  // water-conditions.js, forwarded to the conditions strip and dropped on the way here. And it
  // gave no station and no distance, so a prediction taken at the harbour entrance read exactly
  // like one taken in the creek. On a pedal kayak both halves decide the day.
  if (t.currentType || t.currentKn != null) {
    const set = Number.isFinite(t.currentDirDeg)
      ? ` setting ${Math.round(t.currentDirDeg)}° (${compassOf(t.currentDirDeg)})` : '';
    L.push(`Current: ${[t.currentType, t.currentKn != null ? `${Math.abs(t.currentKn).toFixed(1)} kn` : '']
      .filter(Boolean).join(' ')}${set}${t.currentAt ? ` at ${t.currentAt}` : ''}. `
      + 'THE TIDE IS THE CURRENT here — there is no spot-lock, so every stop is pedal work '
      + 'against moving water and you must say which way it is running.');
    if (t.currentStation) {
      const far = Number.isFinite(t.currentStationKm) && t.currentStationKm >= 3;
      L.push(`  Predicted at ${t.currentStation}`
        + (Number.isFinite(t.currentStationKm) ? `, ${t.currentStationKm.toFixed(1)} km from the launch` : '')
        + (far ? ' — FAR ENOUGH THAT IT IS THE TIMING THAT TRANSFERS, NOT THE SPEED. Use it for '
               + 'when the water turns; do not state that speed as the current in his creek.'
               : '.'));
    }
  } else if (t.zone) {
    // A BLANK CURRENT ROW AND SLACK WATER LOOK IDENTICAL, and until 2026-09-15 fourteen of the
    // sixteen coastal zones had no bound current station at all -- so the model was reading
    // silence as calm on every South Carolina zone. Say which it is.
    L.push('NO CURRENT PREDICTION ANSWERED for this zone. That is a missing station, NOT slack '
      + 'water — the tide is still running and the plan must say the speed was not read.');
  }
  if (t.surgeVsPredictedFt != null) {
    L.push(`Observed water is ${t.surgeVsPredictedFt > 0 ? '+' : '−'}`
      + `${Math.abs(t.surgeVsPredictedFt).toFixed(1)} ft against the prediction. A foot of surge `
      + 'is not a rounding error on a two-foot tide.');
  }
  // SALT, AND WHICH GAUGE SAID SO. This read "at the gauge" on zones that bind eight of them --
  // Charleston binds twenty-six gauges and eight publish salinity or specific conductance, and
  // one up the Cooper reads a different water from one at the harbour mouth. Salinity is also the
  // number that moves redfish up and down a creek system after rain, so an unattributed one is
  // worse than none. (Counted 2026-09-15; an earlier revision of this comment said twenty, which
  // was estimated and not counted.)
  const saltAt = (t.saltGauge || Number.isFinite(t.saltGaugeKm))
    ? ` at ${t.saltGauge || 'a bound gauge'}`
      + (Number.isFinite(t.saltGaugeKm) ? `, ${t.saltGaugeKm.toFixed(1)} km from the launch` : '')
      + (Number.isFinite(t.saltGaugeKm) && t.saltGaugeKm >= 5
          ? ' — FAR ENOUGH UP OR DOWN THE SYSTEM THAT IT IS A DIRECTION, NOT A READING FOR THIS '
            + 'creek. Say which way it points and do not state it as the salinity where he launches.'
          : '.')
    : ' at the gauge.';
  if (t.salinityPpt != null) L.push(`Salinity ${t.salinityPpt} ppt${saltAt}`);
  // THE SONDE, WHERE NO USGS SITE PUBLISHES SALT AT ALL. ACE Basin and St. Helena bind no gauge
  // carrying 00480 or 00095; a NERRS sonde in the reserve is the only salinity either water has,
  // and until 2026-09-15 it reached the card and never reached this prompt. psu is said as psu:
  // it is the Practical Salinity Scale and USGS publishes ppt, and no line in this app converts
  // between them. For a fisherman the two read the same at these magnitudes, and the model is
  // told that outright rather than being handed a silently relabelled number.
  else if (t.salinityPsu != null) {
    L.push(`Salinity ${t.salinityPsu} psu${saltAt} That is a reserve sonde on the Practical `
      + 'Salinity Scale, not the ppt USGS publishes — read it as the same kind of number for '
      + 'fishing purposes, and do not restate it as ppt.');
  }
  else if (t.conductanceUsCm != null) {
    // NOT CONVERTED, ANYWHERE. Conductance and salinity are different numbers and a converted one
    // would look like a measurement and not be one — water-conditions.js refuses the conversion
    // for that reason and `saltBasis` exists to say which of the two answered.
    L.push(`Conductance ${t.conductanceUsCm} µS/cm${saltAt} No salinity is published here, and `
      + 'conductance is NOT converted to ppt anywhere in this app — treat it as the fresher/'
      + 'saltier signal it is, not as a salinity.');
  }
  if (t.depthBandFt) {
    L.push(`Working depth for this species at this stage: ${t.depthBandFt[0]}–${t.depthBandFt[1]} ft, `
      + 'TIDE-CORRECTED — that is water under the boat, not a charted number.');
  }
  if (t.tactic) L.push(`Stage tactic: ${t.tactic}`);
  if (t.freshwaterIntrusion) {
    L.push(`⚠ FRESHWATER INTRUSION${t.freshwaterIntrusion.rivers ? ` (${t.freshwaterIntrusion.rivers})` : ''}`
      + `: ${t.freshwaterIntrusion.message || 'river discharge is well above normal'}. `
      + 'Penalise the upper creeks and favour inlet-adjacent structure — the fish have moved '
      + 'toward the salt.');
  }
  return L.join('\n') + '\n';
}

/**
 * THE RIVER BLOCK. v2 has never had one, and v1 did not either.
 *
 * Ryan, on what he wants to know before planning: *"if it is a river current flow rate and
 * projected releases if applicable."* A river at a normal stage pushing 8,000 cfs is a different
 * trip from the same stage at 400, and the stage alone does not say which — which is why the flow
 * leads and the percentile band goes next to it. A number with no band is not a fact you can act
 * on.
 *
 * GENERATION IS THE CURRENT on a tailwater, and `false` is as useful as `true`: "not generating"
 * is the reason nothing is moving and nothing is feeding.
 */
export function riverPromptBlock(ws, o = {}) {
  const r = ws && ws.river;
  if (!r) return '';
  // A RESERVOIR IS NOT A RIVER, AND THIS BLOCK USED TO TELL THE MODEL IT WAS.
  //
  // fetchWaterState() fills `river` when the water has a flow reading OR a generating dam --
  // `isRiver || c.flowCfs != null || c.generatingNow != null` -- which is right, because a
  // Dominion or Duke impoundment genuinely has both and they genuinely matter. What was wrong is
  // that this block then opened with "RIVER — THE FLOW IS THE DAY" and asked the model where the
  // seams and eddies set up, which side of a bend holds fish, and whether a leg is worth running
  // upstream. On 13,700 acres of Lake Wateree that is nonsense, and the model dutifully wrote it:
  // "The low flow (1,020 ft³/s) means fish will be less concentrated in current seams". Ryan:
  // "whats up with this on a lake?"
  //
  // The discriminator was already computed one file over and carried on the object the whole
  // time. `ws.featureType` is 'lake' for Wateree and 'river' for the Congaree.
  // ONE ANSWER, AND THE CALLER'S WHERE IT HAS ONE. smart-plan-v2 decides this from saysRiver() plus
  // the presence of a centreline in the pack -- neither of which needs the network, and the second
  // of which survives a dead gauge. This block used to re-derive it from `featureType` alone, so a
  // river whose /conditions call timed out got the lake prompt and the river candidates in the same
  // message. The fallback stays for the Pick Water path, which has a waterState and no flag.
  const isRiver = o.isRiver != null
    ? !!o.isRiver
    : String((ws && ws.featureType) || '') === 'river';
  const L = [];
  L.push(isRiver
    ? '\n\u{1F3DE} RIVER — THE FLOW IS THE DAY'
    : '\n\u{1F30A} MOVING WATER ON AN IMPOUNDMENT — WHERE IT REACHES AND WHERE IT DOES NOT');
  if (r.flowCfs != null) {
    L.push(`Discharge ${Math.round(r.flowCfs).toLocaleString()} ft³/s`
      + `${r.flowIsTidallyFiltered ? ' (tidally filtered net flow — the raw gauge reverses twice a day here)' : ''}`
      + `${r.flowVsNormal ? ` · ${r.flowVsNormal}` : ''}`
      + `${r.flowMedianCfs != null ? ` · median for the date ${Math.round(r.flowMedianCfs).toLocaleString()} ft³/s` : ''}`
      + `${r.flowGauge ? ` · ${r.flowGauge}` : ''}`);
    L.push(isRiver
      ? 'Say what this flow does to the day: where the seams and eddies set up, which side of '
        + 'a bend holds fish at this water, how much of the trolling speed is the river rather '
        + 'than the motor, and whether a leg is worth running upstream at all.'
      // The number is a GAUGE, not the lake. It describes what comes in at the head and what
      // goes out at the dam, and most of the water in between has no current at all.
      : 'THIS IS A GAUGE READING ON AN IMPOUNDMENT, NOT A CURRENT ACROSS THE LAKE. It reaches '
        + 'two places: the river arm above, where the inflow still behaves like a river, and the '
        + 'tailrace below the dam. Everywhere else the fish are on structure, wind and '
        + 'thermocline, not on flow. Do NOT write about seams, eddies, which side of a bend, or '
        + 'running upstream. If the flow does not change this day, say so in one line and spend '
        + 'the words on something that does.');
  } else if (r.gaugeOutOfService) {
    L.push('The gauge is OUT OF SERVICE — there is no flow reading today. Do not infer one from '
      + 'the stage, and say in the plan that the river was not measured.');
  }
  // ── HOW MUCH OF THE TROLLING SPEED IS THE RIVER, AND WHERE THE DAY TURNS HIM AROUND ───────────
  //
  // This block has asked the model "how much of the trolling speed is the river rather than the
  // motor" and "whether a leg is worth running upstream at all" since it was written, and had
  // NOTHING BUT A DISCHARGE IN ft3/s to answer either with — which is a volume, not a speed. The
  // centreline's charted cross-section turns it into one: V = Q/A, guarded so a section with no real
  // charted depth in it never divides a discharge. Computed in smart-plan-v2 off the drifts; this
  // block formats and does not calculate.
  //
  // THE SUPPORT GOES WITH THE NUMBER. The current varies seven-fold along one river at a single
  // discharge, so "n of N reaches measurable" is part of the fact rather than a footnote under it.
  const rc = isRiver ? o.riverCurrent : null;
  if (rc && Number.isFinite(rc.medianMph)) {
    const troll = 2.0;
    L.push(`Current about ${rc.medianMph.toFixed(2)} mph down the channel`
      + ` · ${rc.n} of ${rc.ofN} reaches measurable`
      + `${rc.basis ? ` · ${rc.basis}` : ''}`);
    L.push(`That is ${Math.round((rc.medianMph / troll) * 100)}% of a ${troll} mph trolling speed, so `
      + 'upstream and downstream are not the same leg: each candidate carries both prices as '
      + '`batteryAhUpstream` and `batteryAhDownstream`.');
    const t = rc.turnaround;
    if (t) {
      L.push(`The day turns him around at about ${t.milesUp} miles up, and the ${t.binding} is what `
        + `binds — battery ${t.batteryMiles} mi`
        + `${t.clockMiles != null ? `, clock ${t.clockMiles} mi` : ''}`
        + ` · ${t.ahPerMileUp} Ah a mile against it, ${t.ahPerMileDown} with it. Assumes trolling `
        + 'the whole way at one speed and one current, and no transit.');
      L.push('ORDER THE DAY UPSTREAM FIRST while the battery is full and come back down on the push — '
        + 'that is how he fishes it, and the arithmetic above is why it is also the cheap order.');
    }
  } else if (rc && rc.basis) {
    // A REFUSAL IS AN ANSWER AND MUST REACH THE FIELD IT REFUSED. Tidal, no gauge and no charted
    // section are three different days, and the model must not fill the gap from its own recall.
    L.push(`No channel velocity for this water — ${rc.basis}. Do not invent one, and do not write `
      + 'about how much of the trolling speed is the river.');
  }
  if (r.stageFt != null) L.push(`Stage ${Number(r.stageFt).toFixed(1)} ft`
    + `${r.stageBasis ? ` (${r.stageBasis})` : ''}.`);
  if (r.floodCategory) {
    L.push(`⚠ FLOOD STAGE: ${r.floodCategory}. Debris, no visibility and a bank that is not where `
      + 'it was. Judge this against a 12.5 ft kayak the same way you judge wind, and say so in '
      + '`safety`.');
  } else if (r.ftBelowFloodAction != null && r.ftBelowFloodAction <= 3) {
    L.push(`The river is ${Number(r.ftBelowFloodAction).toFixed(1)} ft below its flood-action stage — `
      + 'close enough that rain upstream matters today.');
  }
  if (r.generatingNow === true) {
    L.push('THE DAM IS GENERATING. That is the current: the water is rising, moving and colder, '
      + 'bait is being pushed through, and the tailrace fishes completely differently from slack '
      + 'water. Plan around it and say where the boat can safely hold.'
      + (isRiver ? '' : ' On an impoundment this pulls water toward the dam and sets up the only '
        + 'real current on the lake — name the part of the lake it reaches.'));
  } else if (r.generatingNow === false) {
    L.push('THE DAM IS NOT GENERATING — that is why nothing is moving. Slack tailrace water is a '
      + 'different fishery from a pulse, and if generation starts mid-trip the river changes under '
      + 'him. Say what he should do when it does.');
  }
  if (r.generationNext) L.push(`Next scheduled generation: ${typeof r.generationNext === 'string'
    ? r.generationNext : JSON.stringify(r.generationNext)}.`);
  if (r.projectedRelease) {
    const n = r.projectedRelease;
    L.push(`Projected release → ${n.mileMarkerName || n.damName || 'downstream'}`
      + `${n.at ? ` at ${String(n.at).slice(11, 16)}` : ''}`
      + `${n.cfs != null ? ` (${Math.round(n.cfs).toLocaleString()} ft³/s)` : ''}. `
      + 'A release is a change to the water he is sitting on, not a forecast — work it into the '
      + 'order of the day.');
  }
  return L.join('\n') + '\n';
}

/**
 * Build the two messages for POST /groq-query.
 *
 * @param {object}   o
 * @param {object[]} o.candidates    forModel() output — what the model may choose from
 * @param {object} [o.drawnDay]      riverDay()'s `.day` — where the drawn day turns, what stopped
 *                                  it, what is left unspent and which arm was taken first. River
 *                                  only, and the object existed for weeks before anything read it.
 * @param {string}   o.water
 * @param {string}   o.ramp
 * @param {string}   o.date
 * @param {string}   o.launchTime    "06:00"
 * @param {string}   o.returnTime    "15:00"
 * @param {string[]} o.species
 * @param {object}   o.conditions    whatever the app already gathered — passed as JSON, verbatim
 * @param {string[]} o.tackle        exact lure names the model may use
 * @param {string[]} [o.snapEligible] the subset of those that may hang off a swivel snap
 * @param {string[]} [o.trollable]    the subset that may be trolled at all. Everything in
 *                                    `tackle` and not in here is cast-only and the prompt says
 *                                    so. Omitted means "assume all of them", which is the old
 *                                    behaviour and the bug.
 * @param {function} [o.lureByName] name -> inventory lure. Used to tell the model HOW each bait
 *                                  reaches a depth instead of letting it read one off the name.
 * @param {number}   [o.usableAh]
 * @param {string[]} [o.hazards]     what is in the way, as sentences that name their own source.
 *                                   chartedHazards() reads the pack's POI layer in two tiers,
 *                                   CANNOT ENTER and AVOID, on Ryan's measured classification —
 *                                   see EVERY_POI_TYPE_ON_THE_CARD_2026-08-27. researchHazards()
 *                                   adds the profile's unpositioned prose. The note keeps them
 *                                   apart, because a dam and a paragraph are not the same claim.
 * @param {string}   [o.intel]       species / research / catch-history prose the app already has
 * @param {object}   [o.waterState]  fetchWaterState() output — the parsed /conditions object
 *                                  plus the derived river, tidal, hazards and pool blocks.
 * @param {object[]} [o.weatherByHour] hourlyWeather() output — {hour, code, cloudPct, ...}.
 * @param {number}   [o.windowMin]   minutes from launch to return — the whole budget.
 * @param {number}   [o.dayMin]      dayCost()'s estimate for the picked water, if the
 *                                  caller has one. Never re-estimated here.
 * @param {object}   [o.thermoclineNorm] thermoclineNormFor() output — what lakes of this depth
 *                                   usually do this month. Absent whenever this water has a
 *                                   measured thermocline, which is the whole point.
 *                                   NOT absent on a reservoir: an impoundment with an inflow
 *                                   gauge or a generating dam carries `river` too, which is why
 *                                   riverPromptBlock() reads `featureType` and not the mere
 *                                   presence of the object. Absent is the same prompt as before.
 * @param {object}   [o.seabedHabitat] seabedHabitatFor() output — the South Atlantic habitat
 *                                   matrix for this fish beside the ENC's charted bottom for this
 *                                   zone. Coastal only; null everywhere inland.
 * @param {object}   [o.inshoreSeason] inshoreSeasonFor() output — what NOAA's inshore intercept
 *                                   survey says about this fish in this STATE in this two-month
 *                                   wave. Coastal only, and null on every inland water, which is
 *                                   the same prompt as before.
 */
// WHERE THE WATER IS TODAY, AND WHAT THAT DOES TO EVERY DEPTH ON THE CHART.
//
// A coastal zone gets coastalPromptBlock and a river gets riverPromptBlock. A reservoir -- which
// is nearly every water this app covers -- got neither, so the only level information reaching
// the model was `poolLevel` inside the conditions JSON: the raw string out of a form field, a
// bare elevation like "355.2" with no datum, no full pool and no sign of which way it was off.
//
// Meanwhile the Worker has computed the whole thing per water since chartDatumShape() was
// written. It carries `charted_at: 'full_pool'`, the drawdown, the operator's own sentence, and
// this line about itself: "which is exactly why this is REPORTED and never APPLIED". The card
// shows it, the printable report prints it, `levelSentence()` says it in one line -- and the
// thing choosing baits against charted depths was never told.
//
// THE CONSEQUENCE IS THE POINT, NOT THE NUMBER. Garmin sounded these packs at full pool. When
// the lake is 2.5 ft down, every contour, every structure depth and every ceiling this prompt
// quotes reads 2.5 ft DEEPER than the water actually is, and nothing in the app subtracts it.
// A crankbait picked against a charted 16 ft ceiling on a lake 3 ft down is fishing 13 ft of
// water. That is the same failure the bait-depth block above exists to prevent, arriving by a
// different road.
//
// Deliberately not corrected here either. `applied: false` is a decision with a reason -- no
// vertical datum is reconciled between an operator's "full pond" and Garmin's sounding -- so the
// model is told the size of the offset and told to carry it, rather than handed numbers this
// file quietly moved.
function poolPromptBlock(ws) {
  if (!ws || ws.error) return '';
  if (ws.featureType && ws.featureType !== 'lake') return '';   // rivers and coast have their own
  if (ws.belowFullPoolFt == null && ws.levelFt == null) return '';
  const b = ws.belowFullPoolFt;
  const off = b == null ? null
    : b > 0.05 ? `${b.toFixed(1)} ft LOWER than the chart assumes`
    : b < -0.05 ? `${Math.abs(b).toFixed(1)} ft HIGHER than the chart assumes`
    : 'right at the level the chart assumes';
  return `
WHERE THE WATER IS TODAY
${levelSentence(ws)}
${ws.operatorMessage ? `The operator's own note: ${ws.operatorMessage}\n` : ''}
Every depth in this prompt — the contours, the structure, the ceilings on each leg — comes off a
Garmin chart sounded at FULL POOL, and nothing in this app has adjusted it.${off ? ` The water is
${off}.` : ''}${b != null && b > 0.05 ? ` So subtract ${b.toFixed(1)} ft from every charted number
before you trust it: a bait picked against a charted 16 ft ceiling is working ${(16 - b).toFixed(1)} ft
of water today, and the shoreline is not where the chart draws it.` : ''}
`;
}

// HOW MUCH OF THIS WATER WAS EVER SOUNDED, WHICH ON A RIVER IS NOT MOST OF IT.
//
// Ryan, after checking a stretch of his own river against the chart app: *"the wateree river is
// pretty much unsounded for most of its entirety"*. He is right, and the app has held the number
// per water the whole time without ever saying it out loud.
//
// `charted` is in the registry for all 355 waters, and split by type it is not subtle:
//
//                  n     median    p25      below 0.50
//     rivers      63     0.501    0.271     31 of 63  (49%)
//     lakes      279     0.928    0.871      3 of 279  (1%)
//     coastal     13     0.219    0.123     13 of 13  (100%)
//
// LakeVu is a lake product. A reservoir is surveyed end to end; a river is sounded where somebody
// funded a survey, and the rest is blank. wateree_river 0.364, broad_river 0.477, and Ryan's own
// home water bates_old_river 0.278 -- 72% of the water he fishes most has no soundings at all.
//
// AND THE PLAN QUOTED IT ANYWAY. Every depth in this prompt, every `maxRunDepthFt`, every bait
// banned on a leg and every warning about a rise comes out of the charted fraction, with the same
// confidence on the Wateree at 0.36 as on Murray at 0.95. This block is the sentence that was
// missing -- the same job poolPromptBlock does for a drawn-down reservoir, and for the same reason:
// the model is told the size of what it cannot see rather than handed numbers that hide it.
//
// NOT A THRESHOLD AND NOT A REFUSAL. It prints the figure whenever the registry has one, because
// "96% sounded" is information too, and what to do about 36% is a fishing judgement rather than
// something this file should make on his behalf.
function chartCoverageBlock(o) {
  const rec = lakeRecordFor(o && o.water ? String(o.water) : '');
  const frac = rec && isNum(rec.charted) ? num(rec.charted) : null;
  if (frac == null || !(frac > 0)) return '';
  const pct = Math.round(frac * 100);
  const gap = 100 - pct;
  return `
HOW MUCH OF THIS WATER HAS EVER BEEN SOUNDED
${pct}% of it. Every depth below -- the contours, the structure depths, the water under each leg,
the shallowest rise on it and every bait judged against those -- comes out of that ${pct}%.${gap > 0 ? `
The other ${gap}% is NOT SHALLOW WATER AND NOT SAFE WATER. It is water nobody measured, and the
chart draws nothing there rather than drawing a depth. Where a leg runs past it, the sounder is
the only thing that knows.` : ''}
`;
}

// WHAT LAKES LIKE THIS USUALLY DO, IN ITS OWN SECTION AND NOT IN THE RESEARCH BLOCK.
//
// 342 of the app's 355 waters have no thermocline cast at all, and a plan is written before the
// trip. Ryan: *"but that is backwards... you are saying i must go fish a lake to find out
// information to fish a lake"*. So the table answers where nobody has measured -- and it prints
// here, beside the coastal and river blocks, rather than inside "WHAT IS ALREADY KNOWN", because
// that heading is a claim about this water and this is not one.
//
// AND IT IS WRITTEN AS PROSE, NOT AS `Label: value`. Ryan's condition on the whole idea was
// *"as long as the LLM doesn't take that as the depth the fish are at"*, and a bare number in a
// column of bare numbers is exactly what gets quoted back. The figure cannot be lifted out of
// this block without the spread, the sample size, the words "not measured", and the sentence
// saying a thermocline is a boundary -- they are in the same sentences as the number.
function thermoclineNormBlock(n) {
  if (!n) return '';
  const month = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
                 'September', 'October', 'November', 'December'][n.month] || 'this month';
  // DEFER TO THE WATER'S OWN REASON WHERE IT HAS ONE. `reason` is limnology.thermocline.note,
  // carried here by thermoclineNormFor(). Without it this block asserted that nobody had published
  // a cast, on waters where one was published and refused for a stated reason -- a claim stronger
  // than the evidence, sitting directly above oxygen depths derived from that same cast.
  const why = n.reason
    ? `${n.reason}\nSo what follows is what lakes of this depth do in`
    : 'Nobody has published a vertical cast for it, so what follows is what lakes of this depth do in';
  return `
THE THERMOCLINE ON THIS WATER HAS NOT BEEN MEASURED
${why}
${month} — across ${n.casts} EPA National Lakes Assessment casts the thermocline sat around
${n.medianFt} ft, with half of those lakes between ${n.p25Ft} and ${n.p75Ft} ft.

That is a typical value for lakes of this depth. It is NOT a fact about this one, and the survey
is national, so on a southern reservoir it more likely reads shallow than deep. Do not state it
as this lake's thermocline and do not build the day around it — say it is the expectation and
say it is unmeasured.

And a thermocline is a boundary, not a depth to fish. The water beneath it is cut off from the
surface and loses oxygen as summer runs; the fishable band is above it. Whatever the sounder shows
on the day beats every word of this.
`;
}

/**
 * WHAT THE INTERCEPT SURVEY SAYS ABOUT THIS FISH THIS MONTH.
 *
 * The coastal side has no research profile the way a reservoir does, so until now the only thing
 * the prompt knew about a redfish in September was its size and creel limit. This is the
 * measured half: eleven years of NOAA's inshore intercepts, per state, per two-month wave.
 *
 * IT IS A STATE FACT AND THE BLOCK SAYS SO IN ITS OWN HEADING, for the reason Ryan gave
 * thermoclineNormBlock above — a survey is not a finding about this creek, and a figure that can
 * be lifted out of the block without the words around it will be quoted back as one.
 *
 * EXPORTED SO THE TEST CAN RUN IT RATHER THAN READ IT. The first version of that test greped
 * this source for its own sentences and went red on two of them -- not because the words were
 * missing but because they sit either side of a string concatenation. That is the
 * source-reading guard failure this suite has hit four times; the rendered block is the thing
 * the model is handed, so the rendered block is what gets asserted.
 *
 * INTERCEPTS ARE ANGLERS, NOT FISH, and the distinction is not pedantry: the number rises with
 * how many people fished as well as with how many fish were there. So it is given as a SHARE of
 * this fish's own year and never as an abundance, and the block says which.
 *
 * NOT SAMPLED IS NOT ZERO. When the survey does not work this wave in this state the block says
 * exactly that and gives no number, because "no data for February" and "nothing caught in
 * February" are opposite sentences and the second one cancels a trip.
 */
export function inshoreSeasonBlock(s) {
  if (!s) return '';
  const L = [];
  L.push(`\nWHAT IS CAUGHT INSHORE IN ${s.state} IN ${String(s.waveLabel || '').toUpperCase()}`);
  L.push(`${s.source}, ${s.years.length ? `${s.years[0]}–${s.years[s.years.length - 1]}` : 'multi-year'}, `
    + `inland waters only. STATEWIDE, not this creek — it says what the season does, not what is `
    + `in front of the ramp.`);

  if (!s.sampled) {
    L.push(`The survey DOES NOT WORK ${s.waveLabel} in ${s.state}, so there is no intercept count `
      + `for ${s.surveyName} in this wave. THAT IS A HOLE IN THE SURVEY, NOT AN ABSENCE OF FISH — `
      + `do not read it as a slow season and do not talk the day down over it.`);
  } else {
    const share = s.sharePct != null ? `${s.sharePct}% of its year` : 'an unranked share of its year';
    const ord = ['', '1st', '2nd', '3rd', '4th', '5th', '6th'][s.rank] || `${s.rank}th`;
    const place = s.rank === 1 ? 'the BUSIEST of the year'
      : s.rank ? `${ord} busiest of the ${s.sampledWaveCount} waves the survey works here` : null;
    L.push(`${s.surveyName}: ${s.waveIntercepts.toLocaleString()} intercepts in ${s.waveLabel}, `
      + `${share}${place ? ` — ${place}` : ''}.`);
    if (s.best && s.rank !== 1) {
      L.push(`Its strongest wave is ${s.best.label} (${s.best.intercepts.toLocaleString()}). `
        + `This is a timing fact, not a forecast for the day.`);
    }
    L.push('An intercept is an ANGLER TRIP that produced this fish, so the count carries how many '
      + 'people fished as well as how many fish were there. Use it for WHEN, never as abundance.');
  }

  const li = s.lengthIn;
  if (li && isNum(li.medianIn)) {
    L.push(`Measured lengths, all waves: median ${li.medianIn}"`
      + (isNum(li.minIn) && isNum(li.maxIn)
          ? `, range ${li.minIn}–${li.maxIn}"` : '')
      + (isNum(li.n) ? ` across ${Number(li.n).toLocaleString()} measured fish` : '')
      + '. Size the presentation to THAT fish, not to the top of the range — and check the median '
      + 'against the slot limit above, because a median under the slot means most of what is '
      + 'landed goes back.');
  }

  // NOT TWICE. When THIS wave is the unsampled one the paragraph above already said so in
  // stronger words, and repeating it underneath reads as two different holes.
  const others = (s.unsampledWaves || []).filter((w) => s.sampled || w !== s.waveLabel);
  if (others.length) {
    L.push(`The survey does not work ${others.join(', ')} in ${s.state} at all. Those `
      + 'months are unmeasured here, not empty.');
  }
  return L.join('\n') + '\n';
}

/**
 * WHAT THIS FISH WANTS OFF THE BOTTOM, AND WHAT THIS ZONE'S BOTTOM IS.
 *
 * Two registries that are columns of numbers apart and a sentence together -- see
 * js/data/seabed-habitat.js for why they are read in one module.
 *
 * THE STAGES ARE PRINTED APART. Red drum rate marsh edge 4.0 as juveniles and 2.0 as adults, and
 * a reader that takes the strongest number across stages makes every adult weight too strong.
 * Whether an 18-25 inch slot fish is an adult is a question about the fish and not about this
 * table, so every stage is labelled and the model is told to pick, rather than being handed one
 * number that has quietly already picked.
 *
 * AND IT SAYS WHAT THE RANKER CANNOT SEE. Four of the matrix's six structure classes -- marsh
 * edge, oyster, grass flat and dock piling -- are not in the coastal packs' `near[]` at all, so
 * the candidate legs were not ordered by them and cannot have been. Saying so is the difference
 * between the model writing "this leg was chosen for its marsh edge" (false) and "work the marsh
 * edge along this leg" (an instruction Ryan can follow off the map layer he already draws).
 */
export function seabedHabitatBlock(s) {
  if (!s) return '';
  const L = [];
  const pretty = (k) => String(k).replace(/_/g, ' ');
  const scale = s.rankScale
    ? Object.entries(s.rankScale).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${n} ${w}`).join(' · ')
    : null;

  L.push('\nBOTTOM AND HABITAT — WHAT THE FISH WANTS AND WHAT THE CHART SHOWS');

  if (s.matrixName) {
    L.push(`${s.region || 'South Atlantic'} habitat matrix, for ${s.matrixName}`
      + (scale ? `. Ratings run ${scale}.` : '.'));
    // ADULT FIRST because that is the fish being targeted; the rest follow labelled, never merged.
    for (const stage of ['adult', 'spawning', 'juvenile', 'larva']) {
      const v = s.stages[stage];
      if (!v) continue;
      const st = (v.structures || []).map((x) => `${pretty(x.key)} ${x.rank}`).join(', ');
      const su = (v.substrates || []).map((x) => `${pretty(x.key)} ${x.rank}`).join(', ');
      if (!st && !su) continue;
      L.push(`  ${stage.toUpperCase()}${st ? ` — structure: ${st}` : ''}${su ? ` · bottom: ${su}` : ''}`);
    }
    L.push('THESE ARE SEPARATE LIFE STAGES AND THE HIGHEST NUMBER ACROSS THEM IS NOT THE ADULT '
      + 'NUMBER. Read the stage that matches the size of fish the limit above lets him keep, and '
      + 'say which stage you read. It is a REGIONAL rating for the whole South Atlantic, not a '
      + 'measurement of this creek.');
  }

  if (s.bottom && s.bottom.length) {
    L.push(`Charted bottom in this zone (NOAA ENC, ${s.seabedFeatures} labelled seabed features `
      + `of ${s.features} charted): ${s.bottom.map((b) => `${pretty(b.key)} ${b.rank}`).join(', ')}.`);
    L.push('That is a count of what the CHART LABELS, not a fraction of the bottom, and every '
      + 'zone on this coast comes back dominated by fine — so it separates one fish from another '
      + 'here far better than it separates this zone from the next one.');
  }

  if (s.wantsRare) {
    const w = s.wantsRare;
    const names = w.wants.map(pretty).join(' and ');
    if (w.weak) {
      // MEDIUM IS NOT A PREFERENCE, and printing one as though it were puts the emphasis on the
      // half of the matrix that does not decide this fish. Seatrout tops out at Medium on every
      // substrate and at Very High on grass flat and marsh edge; the bottom is not the argument.
      L.push(`The best bottom rating this fish carries is only ${w.rating} (${names}) — the matrix `
        + 'is saying the BOTTOM IS NOT WHAT DECIDES THIS FISH here. The structure ratings above '
        + 'are, so build the day on those and treat the bottom as a tie-breaker.');
    } else if (w.scarce) {
      L.push(`⚠ ${names} is what this fish rates highest (${w.rating}) and the chart labels only `
        + `${w.chartedFeatures} of the ${w.chartedTotal} substrate-labelled features as that here — `
        + `the zone is mostly ${pretty(w.dominant)}. Do not hunt for that bottom; meet it on `
        + 'STRUCTURE instead, and say in the plan that is what you are doing.');
    } else {
      L.push(`${names} is what this fish rates highest (${w.rating}) and it is also what the chart `
        + `labels most of here — the bottom and the fish agree in this zone.`);
    }
  }

  if (s.chartStructure && s.chartStructure.length) {
    L.push(`Hard structure the chart carries here: ${s.chartStructure
      .map((c) => `${pretty(c.key)} ${c.rank}`).join(', ')}. Counts only — we hold no positions `
      + 'for these, so name them as water to work, never as a waypoint.');
  }

  if (s.restricted && s.restricted.length) {
    L.push(`The chart also marks ${s.restricted.map((r) => `${r.rank} ${pretty(r.key)}`).join(' and ')} `
      + 'area(s) in this zone. WE HOLD THE COUNT AND NOT THE SHAPES, so the plan cannot claim to '
      + 'have routed around them — say they exist and that they are his to check on the chart.');
  }

  // THE HONEST LIMIT, LAST, SO IT IS NOT LOST ABOVE THE NUMBERS.
  L.push('THE LEG RANKING COULD NOT USE ANY OF THIS. Marsh edge, oyster, grass flat and dock '
    + 'piling are not marks the coastal chartpacks put on a trolling run, so no candidate below '
    + 'was ordered by them. Use this to say what to WORK along a leg; never say a leg was chosen '
    + 'for habitat it was not scored on.');
  return L.join('\n') + '\n';
}

/**
 * WHAT THE LIGHT IS DOING, because a depth without a light state is not an instruction.
 *
 * Ryan, 2026-09-05, on the Wateree plan: "what the app needs to be able to differentiate is the
 * time of day when a depth is given... early morning topwater... that doesn't apply to midday".
 * And then, on what a source actually says: "its not going to say at 6am... early morning...
 * dawn... first thing... first light... midday... evening... overcast vs daylight".
 *
 * So the record carries a light state and this resolves it into hours for THIS day at THIS lake.
 * Nothing here is invented:
 *
 *   The boundaries are civil twilight, from USNO through /conditions. water-conditions.js has
 *   said why since it was written -- "CIVIL TWILIGHT, NOT SUNRISE. The fishing day starts when
 *   you can see to launch and ends when you cannot" -- and until 2026-09-05 fetchWaterState
 *   dropped the almanac on the floor, so no prompt has ever had it.
 *
 *   "Overcast" is WMO weather code 3, which is what the word means in the code table Open-Meteo
 *   answers in. The measured cloud percentage travels beside it as a number, unlabelled.
 *
 * Silent when the almanac is missing, like every other block here: a guess about first light is
 * worse than no sentence about it.
 */
// ── WHAT HE DOES WHEN THE TWO IN THE WATER ARE NOT WORKING ───────────────────────────────────────
//
// Ryan, 2026-09-17: *"and this dashboard doesn't tell me to switch if they aren't working or even
// mention the other 4 rods?"*
//
// The schema used to ask for one `notes.adjustmentTip` for the whole day -- "if nothing has hit in
// thirty minutes, do this" -- and nothing in the app ever read it, so the only sentence that answered
// him was written on every plan and discarded. One line for nine hours was the wrong grain besides:
// what to try next belongs to THIS water at THIS hour, which is what a leg is.
//
// WRITTEN ONCE AND USED IN BOTH BRANCHES of the legs schema, because a river leg and a lake leg want
// exactly the same thing here and two copies of an instruction is how the two start disagreeing.
const FALLBACK_FIELD = `// \`ifNotProducing\` IS THE ANSWER TO "THESE TWO ARE NOT WORKING", and it is
    // the reason the other four rods are aboard. Name a rod THIS PLAN RIGGED that is not in the water
    // on this leg, the deployed rod it goes in place of, and why that is the next thing to try on this
    // water at this hour -- a different depth, a different action, a different amount of noise, and
    // say which. It is not a scheduled change: it is what he does when thirty minutes go by with
    // nothing, and it may never happen.
    // IT IS CHECKED AND IT IS DROPPED IF IT IS EMPTY. A rod already in the water on that leg is not a
    // fallback, a rod this plan never rigged is carrying whatever was on it last trip and nobody
    // knows what that is, and \`insteadOf\` must be one of the two actually out there.
    // Leave it off a leg where neither rod behind the seat is honestly worth reaching for, and say
    // that in \`why\` rather than naming one to fill the field.`;

/**
 * ── THE DAY THE APP DREW, AND WHAT TIME OF DAY EACH PIECE OF IT IS ──────────────────────────────
 *
 * Ryan, 2026-09-17, looking at a nine-hour Congaree plan that rigged one pair of baits and never
 * mentioned the other four rods: *"but if it is only an up and back am i using the same rods all day
 * long... no matter what? that doesn't make sense"*. And then, on what the fix is not: *"dividing it
 * into legs that do not exist just to change baits at arbitrary times doesn't seem to make sense to
 * me either"*.
 *
 * Both are right, and the thing between them is this block. A river leg is a piece of WATER and two
 * legs for an up-and-back is the truth about the day; nothing here subdivides it. What was missing is
 * that the model was never told WHEN any of it happens. The candidate carried `estMin` -- a duration
 * -- and not one field anywhere said what o'clock. So a reach fished out at first light and back in
 * the afternoon arrived as one anonymous stretch, and "the same baits all day" was not a judgement
 * the model made badly, it was the only judgement available to it.
 *
 * riverDay() now stamps `passClock` on each reach: one entry per pass, in the order fished, with its
 * start, its length, which way the boat is going and the light on it. This says it in prose as well,
 * because the day read as a sequence of hours is the thing being reasoned about and a table of two
 * rows per candidate buried in JSON is not that.
 *
 * AND IT SAYS THE SHAPE OF THE DAY, WHICH `legs.day` HAS DESCRIBED SINCE IT WAS WRITTEN AND NOTHING
 * HAS EVER READ. Where the day turns, what stopped it going further, how much of the budget is left
 * over, and which arm of the launch was NOT the one taken first. Its own comment says `offered` is
 * there "so a plan can say what it did NOT take and why" -- and until now no plan could, because the
 * object died in the array it was hung on.
 *
 * Empty string on a lake and on any day with no clock, which is the same silence every other block
 * here keeps rather than printing a heading over nothing.
 */
function drawnDayBlock(day, candidates) {
  const rows = [];
  for (const c of (candidates || [])) {
    for (const p of (Array.isArray(c.passClock) ? c.passClock : [])) {
      if (p && p.at) rows.push({ runId: c.runId, ...p });
    }
  }
  // IN THE ORDER HE FISHES THEM, WHICH IS NOT THE ORDER OF THE LIST. The candidates are a list of
  // REACHES and the day runs out through all of them and back through all of them, so reach A's second
  // pass comes after reach B's second pass. `seq` is stampPassClock's own count of the day, which is
  // the only place that order is known. Without this the table said "in the order he will actually
  // fish them" over an order nobody fishes.
  rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  if (!rows.length && !day) return '';
  const lines = [];

  if (day) {
    const km = (m) => (Number(m) / 1000).toFixed(1);
    lines.push(`THE DAY AS DRAWN — the app costed this against the battery and the clock together, `
             + 'which is arithmetic; everything left over is fishing.');
    lines.push(`- The path turns ${km(day.turnaroundM)} km from the ramp, and covers `
             + `${km(day.fishedM)} km of fished water getting out there and back.`);
    // WHAT STOPPED IT, IN ITS OWN WORDS. "the river ran out" is a real answer on the Congaree's
    // downstream arm -- 3.2 km and then nothing -- and it is a different sentence from "the battery".
    const spare = [
      day.unspentMin != null ? `${day.unspentMin} min` : null,
      day.unspentAh != null ? `${day.unspentAh} Ah` : null,
    ].filter(Boolean).join(' and ');
    lines.push(`- What stopped it going further: ${day.binding}.`
             + (spare ? ` That leaves ${spare} of the budget unspent.` : ''));
    if (day.transitM != null) {
      lines.push(`- ${day.transitM} m of the whole day is transit. Every other metre has baits in `
               + 'it, which is what a river day is for.');
    }
    // ── AND THE OTHER ARM IS NAMED AS WATER NOT TAKEN, NOT AS PART OF THE DAY ──────────────
    //
    // This said "the app took the richer side first" and listed both arms as though both were on
    // the day. Neither half is true any more. riverDay() takes the UPSTREAM arm and only that arm
    // -- "UPSTREAM, ALWAYS, AND ONE ARM. THIS IS A SAFETY RULE AND IT DOES NOT GET SCORED" -- so
    // the richer side is frequently the one left behind. On Ryan's 2026-09-19 Congaree day this
    // sentence claimed the richer side was taken first while handing the model 2 upstream reaches
    // worth 132.3 and naming 2 downstream reaches worth 239.2 that are not in the leg list at all.
    //
    // A model told about four reaches and handed two has been given a day nobody is fishing. So
    // the arm on the day is marked as the day, the other is marked as not fished, and the REASON
    // is his own rather than a score -- "the app picked the better water" invites the model to
    // second-guess it, and "he goes up so he can float home" does not.
    const arms = (day.offered || []);
    const taken = arms.find((a) => a.takenFirst);
    if (arms.length > 1 && taken) {
      lines.push(`- There is water on BOTH sides of the launch and this day fishes ONE of them: `
               + `${arms.map((a) => `${a.reaches} reach${a.reaches === 1 ? '' : 'es'} `
               + `${a.direction} (worth ${a.worth})`
               + `${a.takenFirst ? ' ← THE DAY' : ' — not fished today'}`).join(', ')}. `
               + `The ${taken.direction} arm does not have to be the scoring winner: he goes up `
               + 'first and floats back, because a dead motor far downstream is a fight home '
               + 'against the current in a 12.5 ft pedal kayak. Every leg below is on that one arm, '
               + 'and the other is named only so you know it exists and is not yours to plan.');
    } else if (arms.length === 1) {
      lines.push(`- The water is all on one side of the launch: ${arms[0].reaches} reach`
               + `${arms[0].reaches === 1 ? '' : 'es'} ${arms[0].direction}.`);
    }
    lines.push('');
  }

  if (rows.length) {
    lines.push(`WHEN EACH LEG IS FISHED, AND IN WHAT LIGHT — read the day as hours, not as a list`);
    lines.push('Every reach below is fished TWICE, once out from the ramp and once back, and THE TWO '
             + 'PASSES ARE HOURS APART. In the order he will actually fish them:');
    for (const r of rows) {
      const way = r.upstream ? 'against the current' : 'with the current';
      const sp = r.overGroundMph != null ? `, ${r.overGroundMph} mph over the ground` : '';
      const lit = lightLabel(r.light);
      lines.push(`- ${r.at}—${r.ends} (${r.min} min) ${r.runId} pass ${r.pass} of 2, ${way}${sp}`
               + (lit ? ` · ${lit}` : ''));
    }
    lines.push('');
    lines.push(`The hours are an ESTIMATE at the app's provisional 2.0 mph THROUGH THE WATER, for the `
             + 'same reason `estMin` is one: the real speed comes from the baits you have not chosen '
             + 'yet, and the app re-fits the day once you have. The light on them is not an estimate '
             + `— it is the almanac and that hour's own forecast cloud cover.`);
    lines.push('');
    lines.push('SO ONE PAIR OF BAITS FOR THE WHOLE DAY IS NOW A CHOICE, AND NOT A DEFAULT.');
    lines.push('It is a perfectly good answer. If the right topwater and the right bladed jig cover '
             + 'every hour of this water, rig them, fish them all day, and SAY that is what you are '
             + 'doing and why. What is no longer an answer is rigging for "the day" as though it had '
             + 'one light and one hour in it, because you can now see that it does not.');
    lines.push('WHERE SOMETHING ACTUALLY CHANGES IS WHERE A CHANGE BELONGS. The light going from '
             + 'twilight to bright. The pass turning, so the current is pushing the boat instead of '
             + 'holding it back and every bait behind it is running at a different speed. The far '
             + 'reach being deeper water than the near one.');
    lines.push('AND THE CHEAP WAY TO ACT ON IT IS `deployBack`, NOT `changes`. Four rods are already '
             + 'rigged and standing behind the seat, so putting two down and picking two up at the '
             + 'turnaround costs seconds and no knots \u2014 name a second pair in `deployBack` on that '
             + 'leg. `changes` reties a lure on a rod that is already out, which on a leader rod is '
             + 'two knots with cold wet hands in a moving kayak: keep it for when NO rigged rod '
             + 'carries what the water now wants, and then name the `beforeRunId` AND the `pass` so '
             + 'the app puts the swap at that point in the day rather than at the ramp.');
    lines.push('AND NOWHERE ELSE. Do not put a change on a timer, and do not reach for one because '
             + 'the day looks long. Nothing here is cut into pieces that do not exist just to give a '
             + 'swap somewhere to sit: there are two legs per reach because the boat goes out and '
             + 'comes back, and that is all there is.');
  }
  return `\n${lines.join('\n')}\n`;
}

export function lightPromptBlock(ws, weatherByHour, launchTime, returnTime, lightFacts,
                                isRiver) {
  if (!ws || ws.error) return '';
  const sum = lightSummary(ws, weatherByHour, launchTime, returnTime);
  const lines = [];

  if (ws.civilDawn && ws.sunrise) {
    lines.push(`First light runs ${ws.civilDawn} to ${ws.sunrise} (civil dawn to sunrise).`);
  }
  if (ws.sunset && ws.civilDusk) {
    lines.push(`Last light runs ${ws.sunset} to ${ws.civilDusk} (sunset to civil dusk).`);
  }
  if (!sum) {
    // The almanac exists but the trip does not resolve against it -- no launch or return time. Say
    // the two sentences above and stop, rather than describing a day nobody said the length of.
    return lines.length ? `
WHAT THE LIGHT IS DOING
${lines.join('\n')}
` : '';
  }

  // ── THE DAY, RESOLVED, RUN BY RUN ────────────────────────────────────────────────────────────
  //
  // This block used to print the twilight boundaries and then a list of cloud percentages by hour,
  // and leave the model to work out which hours were low light. It is the same shape as the time
  // budget, where the model "was handed '06:00' and '15:00' and left to do the arithmetic, and it
  // does not do the arithmetic". lightSummary() does the arithmetic: each stretch of the trip with
  // its light state, whether that light is LOW, and which of the two causes made it low.
  lines.push(`THE LIGHT ON THIS TRIP, ${launchTime} to ${returnTime} — ${sum.totalMin} minutes, of `
           + `which ${sum.lowMin} are LOW LIGHT:`);
  for (const r of sum.runs) {
    // The cause and the sky are one phrase, not two. Written as two it printed "LOW LIGHT —
    // overcast · overcast, 95% cloud", which reads as though the app is not sure it already said it.
    const pct = r.cloudMin == null ? ''
      : (r.cloudMin === r.cloudMax ? ` ${r.cloudMax}% cloud`
                                   : ` ${r.cloudMax}–${r.cloudMin}% cloud`);
    const sky = r.skyWord ? `${r.skyWord}${pct}` : 'sky not forecast for these hours';
    const cause = r.low
      ? (r.lowBySun && r.lowBySky ? `LOW LIGHT — twilight, and ${sky}`
        : r.lowBySun ? `LOW LIGHT — twilight (${sky})`
        : `LOW LIGHT — ${sky}`)
      : `full daylight — ${sky}`;
    lines.push(`- ${r.from}–${r.to} (${r.minutes} min): ${r.state || 'unknown'} · ${cause}`);
  }

  // AND THE SENTENCE THAT SAYS WHAT KIND OF DAY IT IS, because "3 of 9 hours are overcast" is a
  // count and this is the thing it means. Ryan, 2026-09-14: "if it was an overcast day then
  // topwater all day might be ok... i still say might because you just never know with fish" -- so
  // it is said as permission, not as an instruction, and the "might" is his.
  if (sum.allLow) {
    lines.push('EVERY MINUTE OF THIS TRIP IS LOW LIGHT. Guidance the research ties to low light, '
             + 'first light, dusk or overcast conditions applies for the WHOLE DAY here — a '
             + 'topwater or a shallow presentation is defensible at noon on a day like this, and '
             + 'you should say that is why rather than treating midday as bright by default.');
  } else if (sum.noneLow) {
    lines.push('NO PART OF THIS TRIP IS LOW LIGHT — it never reaches twilight and the sky is not '
             + 'closing the light down at any hour. Low-light guidance does not apply anywhere on '
             + 'this day; do not carry a dawn pattern into it because it is the only one written '
             + 'down.');
  } else if (isRiver) {
    // ── AND ON A RIVER THE ORDER IS NOT THE MODEL'S TO ARRANGE ──────────────────────────────────
    //
    // The sentence below used to read "Put the low-light legs and the full-daylight legs in the
    // order the light comes" on every water. On a river that is an instruction to do something the
    // app has already done and the model is explicitly forbidden to undo -- rule 3, "DO NOT REORDER
    // THE LEGS" -- so the prompt asked for one thing in one block and its opposite in another, and
    // the model got no say in either. What replaces it points the same idea at what is still open.
    lines.push('THE LIGHT CHANGES DURING THIS TRIP, so a presentation is not a property of the day '
             + '— it belongs to the stretch of it whose light suits it. THE ORDER IS ALREADY '
             + 'FIXED HERE (rule 3) and you are not being asked to arrange the day by light: every '
             + 'leg carries its own clock and its own light in `passClock`, so match what you rig to '
             + 'the light that leg actually has, and say in its `why` what that light is. A topwater '
             + 'fish on the run out at first light and a trolled bait on the way back at noon are '
             + 'not the same fish — and on a river they are the SAME WATER.');
  } else {
    lines.push('THE LIGHT CHANGES DURING THIS TRIP, so a presentation is not a property of the day '
             + '— it belongs to the stretch of it whose light suits it. Put the low-light legs and '
             + 'the full-daylight legs in the order the light comes, and say in each leg\'s `why` '
             + 'what the light is on it. A topwater fish in the first run above and a trolled bait '
             + 'in the middle of the day are not the same fish.');
  }
  // THE MEASURED PERCENTAGES, HOUR BY HOUR, UNLABELLED. The runs above are the app's reading of
  // the sky; this is the sky. hourlyWeather() keeps the figure exactly as Open-Meteo sent it --
  // "no band, no label" -- and the earlier version of this block sent the whole row, so it still
  // does. A run's own range is computed off these, and a reader that wants to check the reading
  // against the numbers can.
  const pcts = (Array.isArray(weatherByHour) ? weatherByHour : [])
    .filter((x) => x && x.cloudPct != null)
    .map((x) => `${String(x.hour).padStart(2, '0')}:00 ${x.cloudPct}%`);
  if (pcts.length) lines.push(`Cloud cover by hour: ${pcts.join(' · ')}.`);

  if (sum.lowBySkyRuns) {
    lines.push('AND LOW LIGHT HERE IS NOT ONLY A TIME. Some of the stretches above are low light '
             + 'because of the SKY, not the hour — which is the same low light a dawn bite has, at '
             + 'whatever o\'clock it happens.');
  }

  // ── WHAT ANYBODY HAS ACTUALLY WRITTEN DOWN ABOUT LIGHT ON THIS WATER ─────────────────────────
  //
  // Research profiles carry `_extractedFacts` -- a fact, the quote it came from, and the source --
  // and until now nothing outside the research pipeline read them. Some of them tie a depth or a
  // presentation to the light, and those are the only SOURCED light guidance this app has: Lake
  // Marion's says "fishing shallow flats less than 6 feet deep early and late, then drift-fishing
  // deeper water along the channels mid-day", with the article it came out of.
  //
  // Selected by the one light lexicon in light-state.js, not by a regex written here, so a fact
  // and a lure's technique line are searched with the same words.
  // NAMED `lightFacts` AND PASSED IN, NOT `researched` AND SELECTED HERE, FOR ONE REASON:
  // one-prompt-two-planners.test.js holds both planners to every field this file reads off `o`, and
  // it does that by looking for the field NAME in each planner's source. `researched` is already a
  // local variable in all four of those files, so a field called that would have passed the guard
  // on the day it was added and gone unwired in silence -- which is the exact failure that test was
  // written for, three times over. A name nothing else uses is a name the guard can see.
  const facts = Array.isArray(lightFacts) ? lightFacts.filter(Boolean) : [];
  if (facts.length) {
    lines.push('');
    lines.push('WHAT THE RESEARCH ON THIS WATER SAYS ABOUT LIGHT — sourced, quoted, and the only '
             + 'light guidance here that is not general knowledge:');
    for (const f of facts) lines.push(`- ${f}`);
  }

  return `
WHAT THE LIGHT IS DOING
${lines.join('\n')}
A depth, a bait or a presentation the research ties to early morning, first light, dusk or
overcast conditions is an instruction for THOSE STRETCHES, and the table above says which of them
this trip actually has. Do not carry it into the middle of a bright day because it is the only
number available — say instead what changes when the light comes up. And do not do the reverse
either: on a day the table calls low light all the way through, the middle of the day is not bright
and must not be planned as though it were. A topwater fish at first light and a trolled bait at ten
o'clock are not the same fish.
`;
}

/**
 * ── WHAT A FACT IS, ACCORDING TO THE FACT ────────────────────────────────────────────────────
 *
 * Every `_extractedFacts` entry carries a `category` off an ENUMERATED list in
 * Worker/research/extract.js -- 34 names, written into the extraction prompt. Nothing outside the
 * research pipeline had ever read it, so the one reader that existed searched the fact's TEXT for
 * a light word and then hand-patched the misfires with a regex for "must|shall|creel".
 *
 * MEASURED ON THE REAL CARD, 2026-09-17, all 716 facts across 78 profiles. Eleven carry a light
 * word and all eleven were being sent under a heading about light. Four of them are not about
 * light at all:
 *
 *     poolLevel    "Watauga generation starts at 1 PM Monday-Friday and noon on Saturday"  x3
 *     tidalRange   "high tide mid-morning and falling tide after lunch"
 *
 * A dam's generation schedule and a tide are both LIVE in this app -- riverPromptBlock reads the
 * gauge and the tide engine reads the station -- so a written one arriving as light guidance is
 * wrong twice: wrong heading, and able to contradict a reading taken this morning. The law regex
 * never had a chance at either, because neither sentence says "must".
 *
 * So the category decides. These are the ones this app already speaks with a live or structured
 * source of its own, and a fact carrying one is not re-sent as prose beside it.
 */
const FACT_SPOKEN_ELSEWHERE = new Set([
  // live, and a written copy can contradict this morning's reading
  'poolLevel', 'drawdownSchedule', 'tidalRange', 'tidalCurrent',
  // limnology: the oxygen floor the bait gate stands on, the thermocline block, measured clarity
  'oxygen', 'thermocline', 'secchi',
  // the regulations block reads the state book, and the advisory rides with it
  'creelLimit_general', 'creelLimit_lakeSpecific', 'sizeLimit_general', 'sizeLimit_lakeSpecific',
  'closedSeason', 'saltwaterRegulation', 'consumptionAdvisory',
  // the hazards block reads the charted POI layer, and the ramps come off the state feed
  'ramp', 'hazard', 'navigation', 'navigationMarker',
  // identity and morphometry, all of which researchIntel() prints off the structured profile
  'surfaceArea', 'maxDepthFt', 'averageDepthFt', 'county', 'damName', 'yearImpounded',
  'reservoirOwner', 'riverSystem', 'waterBodyType', 'trophicStatus', 'estuaryIdentity',
  'hydraulicRetentionDays', 'flushingTime',
]);

/**
 * ── THE FOUR CATEGORIES NOTHING ELSE IN THIS APP CARRIES ─────────────────────────────────────
 *
 * The extraction prompt says it in as many words: "FISHING BEHAVIOUR IS A FIRST-CLASS FACT...
 * A sentence naming a species, a depth and a time of year is worth more than any morphometry in
 * the document." These four are that sentence, and they are the only categories with no structured
 * home -- `seasonalDepth` is where the FISH are, `waterDepthUnderFish` is the water that happens
 * over, `holdingPattern` is bottom versus suspended, `seasonalPattern` is how it MOVES.
 *
 * Everything large in the corpus is already spoken: `summary` (147 facts) is printed by
 * researchIntel as `Summary`, `predatorSpecies` (44) as `Other predators here`, `primaryForage`
 * (16), `structuralElement` (35) and `habitatCover` (11) off the habitat and structure sections,
 * `speciesAbundance` (42) beside them. Re-sending the raw sentence behind a field the model is
 * already shown is duplication, and duplication in a prompt reads as emphasis.
 *
 * WHAT THIS IS WORTH TODAY: nine facts, all on the Congaree, which is the water the 2026-09-17
 * bench was run on and not one of them reached it. "Fish in the Congaree River are heavily
 * influenced by current, becoming more aggressive and more likely to be in shallower water
 * surface-feeding when current is present" is a bait-depth instruction tied to the current this
 * app now measures at that hour, and there is nowhere else in the prompt it could have come from.
 */
const FACT_FISHING_PATTERN = new Set([
  'seasonalDepth', 'waterDepthUnderFish', 'holdingPattern', 'seasonalPattern',
]);

/** The fact's own sentence, falling back to the quote it was taken from. */
function factText(f) {
  if (!f || typeof f !== 'object') return '';
  if (typeof f.fact === 'string' && f.fact.trim()) return f.fact.trim();
  return typeof f.quote === 'string' ? f.quote.trim() : '';
}

/** The fact with its source in brackets, because a fact without its source is not one. */
function factLine(f, text) {
  const src = typeof f.source === 'string' && f.source.trim() ? f.source.trim()
            : (typeof f.url === 'string' ? f.url.trim() : '');
  return `${text}${src ? ` [${src}]` : ' [source not recorded with the fact]'}`;
}

function factsOf(researched) {
  return researched && Array.isArray(researched._extractedFacts) ? researched._extractedFacts : [];
}

/**
 * THE SOURCED LIGHT GUIDANCE A PROFILE ALREADY HOLDS, and nothing else.
 *
 * Picks the facts whose text carries a light word -- by the one light lexicon in light-state.js,
 * so a fact and a lure's technique line are searched with the same words -- and drops anything
 * this app speaks with a source of its own. See FACT_SPOKEN_ELSEWHERE above for what that is and
 * what it measured.
 *
 * A LIGHT-TAGGED FACT COMES HERE EVEN WHEN IT IS ONE OF THE FOUR PATTERN CATEGORIES, and that is
 * deliberate rather than an accident of ordering: this block sits beside the computed hour-by-hour
 * light table, which is the thing such a fact has to be read against. patternFactsFrom() below
 * takes the rest, so no fact appears under two headings.
 *
 * Capped, and the cap is not a quality judgement -- the facts arrive in the order the agents found
 * them and there is no ranking to apply, so it takes the first few and says how many it left.
 */
export function lightFactsFrom(researched) {
  const all = factsOf(researched);
  const picked = [];
  for (const f of all) {
    const text = factText(f);
    if (!text) continue;
    if (!lightPhrasesIn(text).length) continue;
    if (FACT_SPOKEN_ELSEWHERE.has(f.category)) continue;
    picked.push(factLine(f, text));
    if (picked.length >= 8) break;
  }
  if (all.length && picked.length >= 8) picked.push('(first 8 of the light-tagged facts)');
  return picked;
}

/**
 * WHAT ANYBODY HAS WRITTEN DOWN ABOUT WHERE THE FISH SIT ON THIS WATER.
 *
 * The four categories in FACT_FISHING_PATTERN, minus whatever lightFactsFrom() has already taken,
 * each with its source. Same cap and the same reason.
 */
export function patternFactsFrom(researched) {
  const all = factsOf(researched);
  const picked = [];
  for (const f of all) {
    const text = factText(f);
    if (!text) continue;
    if (!FACT_FISHING_PATTERN.has(f && f.category)) continue;
    if (lightPhrasesIn(text).length) continue;   // it went to the light block
    picked.push(factLine(f, text));
    if (picked.length >= 8) break;
  }
  if (all.length && picked.length >= 8) picked.push('(first 8 of them)');
  return picked;
}

/**
 * The block those go in, beside the research rather than beside the light -- these are facts about
 * the fish, not about the hour. Empty string when there are none, which is 77 of 78 waters today
 * and is the prompt this file has always built.
 */
export function patternFactsBlock(patternFacts) {
  const facts = Array.isArray(patternFacts) ? patternFacts.filter(Boolean) : [];
  if (!facts.length) return '';
  return `
AND WHAT ANGLERS HAVE WRITTEN DOWN ABOUT WHERE THE FISH SIT HERE — sourced and quoted, off this
water's own researched documents, and not general knowledge about the species:
${facts.map((f) => `- ${f}`).join('\n')}
These are the sentences behind the depth band and the structure weights above, not a second opinion
about them. A pattern tied to a SEASON is a fact about that season: check it against today's date
and say so when it does not apply, rather than planning the day on a striper run that happens in
April. A pattern tied to the CURRENT, the water level or the forage is a fact about a condition —
the conditions block says whether that condition is in force today.
`;
}

/**
 * HOW LONG THE DAY IS, IN THE UNIT THE PLAN IS COUNTED IN.
 *
 * The Sep 6 Wateree plan came back at 792 minutes against a 540 minute window and 80.61 Ah
 * against 80 usable. The app computes `windowMin` -- plan-water-ui.js works it out of the launch
 * and return times, dayCost() prices the picked set against it, plan-assemble.js writes
 * "estimated 792 min against a 540 min window" into the warnings -- and the string "540" has
 * never appeared in the prompt. The model was handed "06:00" and "15:00" and left to do the
 * arithmetic, and it does not do the arithmetic.
 *
 * The warning fires AFTER the answer comes back, which makes it a receipt, not a constraint.
 *
 * It does not ask the model to drop water. On the Pick Water path the prompt says the opposite
 * three hundred lines down -- "He picked these stretches himself... The list above IS the day" --
 * and a leg left out is a leg he runs with bare rods. So the instruction is to say WHERE THE
 * CLOCK RUNS OUT: which leg he will be on, and what he gives up by turning for the ramp there.
 * The cut stays his; the plan stops pretending the day fits.
 *
 * `dayMin` is dayCost()'s own number when the caller has one. Nothing is re-estimated here.
 */
export function timeBudgetBlock(windowMin, launchTime, returnTime, dayMin) {
  const w = Number(windowMin);
  if (!Number.isFinite(w) || w <= 0) return '';
  const hrs = (w / 60).toFixed(1).replace(/\.0$/, '');
  const est = Number(dayMin);
  const has = Number.isFinite(est) && est > 0;
  const over = has && est > w;
  return `
HOW LONG HE HAS
${launchTime || '?'} to ${returnTime || '?'} is ${w} MINUTES on the water — ${hrs} hours, ramp to
ramp, including every transit and every stop. That is the whole budget and it does not stretch.${has ? `
The app prices the water below at ${Math.round(est)} minutes.` : ''}${over ? ` That is ${Math.round(est - w)} minutes
MORE than he has.

Do not solve this by dropping a leg — he chose this water and he is going to run it. Solve it by
saying WHERE THE CLOCK RUNS OUT: name the leg he will be on when the ${w} minutes are gone, give
the time he reaches it, and say what he gives up by turning for the ramp there instead of
finishing. Put it in the plan where he will read it before he launches, not in a footnote. The
cut is his to make; your job is to tell him which one he is making.` : has ? ` That leaves
${Math.round(w - est)} minutes of slack — spend it on stops, not on padding the legs.` : ''}

THE DAY YOU WRITE MUST ACCOUNT FOR ALL ${w} MINUTES. He is on the water from ${launchTime || '?'}
until ${returnTime || '?'} whatever you plan, so a plan that runs out at the halfway mark does not
end his day — it leaves him on the water with nothing written for the rest of it. Measured
2026-09-14 on Lake Wateree: a 540 minute window came back as a 131 minute plan, two legs and one
stop, finished before nine in the morning.

Fill it with WATER, not with padding: more legs, more passes over a leg that earns them, more
stops. Do not stretch a leg's time to make a number add up.

AND IF IT STILL COMES IN SHORT, SAY SO IN THE PLAN AND SAY WHY. A short day is a legitimate answer
— the water that fits the conditions may genuinely run out, or the battery or the wind may decide
it — but an unexplained gap is not. Name the reason and name the time it ends, in the plan where he
reads it before he launches, not in a footnote.

Every duration you write must add up against ${w}. A day that totals more than that is wrong even
if every leg in it is right, and a day that totals far less is wrong unless it says why.
`;
}

/**
 * ── WHAT THE GAUGES SAY TODAY, AND WHY IT IS NO LONGER A HAND-WRITTEN LIST ──────────────────
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * THE FIRST ROUND. Ryan, 2026-09-06, pasting the whole conditions card: "how much of this from
 * conditions is presented to the LLM... it doesn't look like it". Counted fact by fact against
 * that day's prompt, FIFTEEN of the card's twenty-four reached the model and NINE did not --
 * water temperature, dissolved oxygen, moon, rain chance, barometer, releases, access closures,
 * the flow anomaly and the guide curve. The sharpest was the first: the prompt tells the model
 * to weigh "what the water clarity and temperature argue for" and then never gave it a
 * temperature. Eight of the nine were added here, by hand, one `if` each.
 *
 * THE SECOND ROUND. plan-preflight.js:554 carries the general form of the same bug -- "This
 * returned six keys. /conditions parses about sixty ... The third time it is the LIST that is
 * wrong, not the length of it." fetchWaterState() was repaired there by spreading the whole
 * parsed object, so every field readConditions() produces has been ON `ws` since 2026-09-05.
 * This function was the remaining hand-written list, and it printed thirteen facts.
 *
 * MEASURED 2026-09-22 against js/utils/water-conditions.js: readConditions() returns 114
 * top-level keys. Twenty-six of them reached the conditions card and nothing else.
 *
 * So: the same repair in the same shape. ONE TABLE, and every key readConditions() produces
 * appears in it exactly once -- either inside a fact this block may print, or in
 * CONDITION_ELSEWHERE naming the block that already says it. A key in neither fails a test
 * rather than going quietly missing, and a key claimed here that the producer does not
 * actually return fails the same test. That pair is the only part of this that stops a fourth
 * round. See test/the-list-was-wrong-three-times.test.js.
 *
 * ── WHICH OF THE TWENTY-SIX IS A FISHING FACT ──────────────────────────────────────────────
 *
 * Ryan set the criterion, 2026-09-22: "anything that would give the LLM more information to
 * help choose lures and build the plan... i am not sure which of these is specifically fishing
 * relevant". Not everything measured is one of those. What earns a line, and why:
 *
 *   barometric trend    `pressure3h`. The one weather fact anglers act on directly, and the
 *                       barometer line already here admits its own gap -- "one observation, so
 *                       there is no trend in it". Falling ahead of a front is a feeding window
 *                       and argues for a faster, louder bait; recovering behind one argues for
 *                       slowing down and downsizing. The absolute millibars decide neither.
 *   level trend         `trend24h`, `trend7d`. Rising water pushes fish shallow onto cover that
 *                       was dry last week; falling water pulls them off the flats to the channel
 *                       edge. That changes WHICH STRUCTURE the day is built on, not just the
 *                       prose. `trendMeasures` is what says whether the number is a river stage
 *                       or a pool elevation, and without it the figure is unreadable.
 *   generation, as a    `tvaDischargeCfs`, `tvaTailwaterFt`. `generatingNow` reaches the model
 *   number              already as a boolean; on a tailwater the MAGNITUDE is the difference
 *                       between a push worth fishing and water a 12.5 ft pedal kayak cannot
 *                       hold in. Twelve waters in water_bindings.json are TVA.
 *   the operator's own  `tvaVsGuideFt`, `tvaGuideFt`, `usaceTargetFt`, `dukeGuide`. Where the
 *   target             lake is SUPPOSED to be today. A lake above its guide curve is a lake the
 *                       operator intends to pull down, which is a forecast of current, and a
 *                       Corps lake has no single full pool to be below.
 *   drought             `droughtLevel`, `droughtLevels`, `droughtNotice`. The rule the water
 *                       will be run under: why the level is low and why it will stay low. On
 *                       Wateree it is also why the release schedule reads NO RELEASE, and that
 *                       reason reached the model while the fact behind it did not.
 *   measured turbidity  `turbidityFnu`. The most lure-relevant number on the card, and it
 *                       reached nothing. Clarity decides colour, flash and profile. What the
 *                       model already sees is `clarity`, a WORD -- off the form and the rainfall
 *                       model -- and a modelled "Clear" has sat above a measured 14.4 FNU on the
 *                       Congaree card, which is not clear. This is the reading, USGS 63680.
 *   seasonal swing      `seasonalDrawdownFt`. Every charted depth in the pack is sounded at full
 *                       pool, and this is how far the operator moves this water across a year.
 *   the flow anomaly's  `flowAnomalyOf`, `flowPeriod`, `flowYears`. The anomaly and the median
 *   own provenance      already reach the model; these say what the anomaly is OF and over how
 *                       many years the median was taken. Five years and thirty are not the same
 *                       claim. Folded into the line carrying the number, not given one.
 *   what this water     `unpublished`, `silent`. Not a lure input -- the strongest
 *   does not measure    anti-invention input. A null clarity and an unmeasured clarity look
 *                       identical to a model, and `silent` is the third state: a gauge that DOES
 *                       publish the parameter and returned nothing today, named so it can be
 *                       distrusted rather than filled in from recall.
 *
 * AND WHAT DOES NOT EARN A LINE, because a duplicate that disagrees is worse than a gap. The
 * observed wind -- `windMph`, `windDirDeg`, `gustMph` -- is one instant at one station, while
 * the trip window's wind AND ITS DIRECTION already reach the model hour by hour as
 * `conditions.windByHour`. So only a measurement ON the water earns a line, with its distance
 * and its age, offered beside the forecast rather than instead of it: an anemometer 0.1 km out
 * is a fact worth weighing against a model from 54 km away, and Wateree showed neither.
 * `floodActionFt` is the threshold behind a number riverPromptBlock() already prints as
 * `ftBelowFloodAction`.
 *
 * Every entry is silent when its fields are null. Nothing is inferred from an absence.
 */
const CONDITION_FACTS = [
  {
    id: 'waterTemp',
    keys: ['waterTempF', 'waterTempFrom', 'waterTempGauge', 'waterTempSite',
           'waterTempStation', 'waterTempUpstreamFrom', 'waterTempAgeMin'],
    say(c) {
      if (!isNum(c.waterTempF)) return null;
      // WHERE IT WAS MEASURED TRAVELS WITH IT. A tailrace gauge sits below the dam and is not the
      // lake; a borrowed upstream reading is not this water at all. The card has said so since it
      // was written and a number that arrives without its provenance cannot be argued with.
      const from = c.waterTempFrom === 'upstream'
          ? ` — measured UPSTREAM, not on this water${c.waterTempGauge ? ` (${c.waterTempGauge})` : ''}`
        : c.waterTempGauge ? ` — ${c.waterTempGauge}` : '';
      // AND WHEN. A thermometer two days behind is not today's water and the model has no other
      // way to know. Quiet under two hours, which is the ordinary lag on a USGS series.
      const age = isNum(c.waterTempAgeMin) && c.waterTempAgeMin >= 120
        ? ` · reading is ${Math.round(c.waterTempAgeMin / 60)} h old` : '';
      return `Water temperature ${c.waterTempF} °F${from}${age}.`;
    },
  },
  {
    id: 'oxygen',
    keys: ['oxygenMgL', 'oxygenPpm', 'oxygenGauge'],
    say(c) {
      const at = c.oxygenGauge ? ` (${c.oxygenGauge})` : '';
      if (isNum(c.oxygenMgL)) {
        return `Dissolved oxygen ${c.oxygenMgL} mg/L. Below about 4 mg/L is not holding fish.${at}`;
      }
      // THE SONDE'S COLUMN IS ppm. Same threshold, said in the unit that was actually measured:
      // the two differ by about the density of seawater, which is well inside the slop of a
      // rule of thumb, and saying so is cheaper than converting a number and pretending it came
      // back that way. On ACE Basin and St. Helena this is the only oxygen there is.
      if (isNum(c.oxygenPpm)) {
        return `Dissolved oxygen ${c.oxygenPpm} ppm at the reserve sonde. Below about 4 is not `
          + 'holding fish — the sonde reports ppm and the USGS gauges report mg/L, and at these '
          + 'magnitudes the threshold is the same number.';
      }
      return null;
    },
  },
  {
    // A MEASURED TURBIDITY AND A MODELLED WORD MUST NOT SIT SIDE BY SIDE DISAGREEING — the same
    // rule cardHtml() already enforces, for the same reason. The reading wins and the word is
    // suppressed; where there is no reading the word is labelled as modelled and says so.
    id: 'clarity',
    keys: ['turbidityFnu', 'turbidityGauge', 'clarity', 'clarityIsMeasured', 'clarityNote',
           'clarityScore'],
    say(c) {
      if (isNum(c.turbidityFnu)) {
        return `Turbidity ${c.turbidityFnu} FNU — MEASURED, USGS 63680`
          + `${c.turbidityGauge ? ` (${c.turbidityGauge})` : ''}. This is the clarity of the water, `
          + 'measured, and it outranks any clarity word elsewhere in this request. Higher FNU is '
          + 'dirtier water: let it set colour, flash and profile, and say in the reasoning that it '
          + 'did.';
      }
      if (!c.clarity) return null;
      return `Clarity ${c.clarity} — ${c.clarityIsMeasured
        ? 'a measured Secchi baseline for this water, adjusted for recent rain'
        : `MODELLED FROM RAINFALL, not measured. ${c.clarityNote
            || 'No clarity measurements exist for this water.'} Absence of data is not clear water`}.`;
    },
  },
  {
    id: 'moon',
    keys: ['moonPhase', 'moonIllumination'],
    say(c) {
      return c.moonPhase
        ? `Moon ${c.moonPhase}${c.moonIllumination ? ` · ${c.moonIllumination} lit` : ''}.`
        : null;
    },
  },
  {
    id: 'rain',
    keys: ['popPct'],
    say(c) {
      return isNum(c.popPct) ? `Chance of rain ${c.popPct}% in the first forecast period.` : null;
    },
  },
  {
    // ── THE DIRECTION, WHICH IS THE HALF ANGLERS ACT ON ────────────────────────────────────
    //
    // The absolute reading has been here since 2026-09-06 with the honest caveat that one
    // observation is not a trend. The trend was in the same response the whole time.
    id: 'barometer',
    keys: ['pressureMb', 'pressureFrom', 'pressure3h', 'pressureStale', 'obsStation', 'obsKmAway'],
    say(c) {
      const L = [];
      const where = c.obsStation
        ? ` — ${c.obsStation}${isNum(c.obsKmAway) ? `, ${c.obsKmAway} km from this water` : ''}`
        : '';
      if (isNum(c.pressureMb)) {
        L.push(isNum(c.pressure3h)
          ? `Barometer ${c.pressureMb} mb${where}.`
          // NOT EVERY SOURCE CARRIES A TREND. The NWS station path publishes a single
          // observation, and a direction invented from one reading is not a trend.
          : `Barometer ${c.pressureMb} mb — one observation, so there is no trend in it.${where}`);
      }
      if (isNum(c.pressure3h)) {
        const d = c.pressure3h;
        const way = Math.abs(d) < 0.3 ? 'STEADY'
          : d < 0 ? 'FALLING' : 'RISING';
        L.push(`Barometer ${way} ${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toFixed(1)} mb over `
          + '3 h. This is a lure decision and not decoration: falling pressure ahead of a front is '
          + 'a feeding window and buys a faster, louder, higher-in-the-column presentation, while '
          + 'a barometer recovering behind a front argues for slowing down, downsizing, and '
          + 'fishing tighter to cover. Steady is neither — say so rather than inventing a mood.');
      } else if (c.pressureStale === true) {
        L.push('The barometer’s last reading is too old to use, so there is no pressure and no '
          + 'trend today. Do not reason from one, and do not treat the gap as "steady".');
      }
      return L.length ? L : null;
    },
  },
  {
    // ── THE ANEMOMETER ON THE WATER, BESIDE THE MODEL, NEVER INSTEAD OF IT ─────────────────
    //
    // The trip window's wind reaches the model hour by hour with its direction, from
    // Open-Meteo, as `conditions.windByHour`. That is the right source for a plan and this does
    // not replace it. What it adds is the one case the forecast cannot cover: a station standing
    // ON this water disagreeing with a model drawn from another county.
    id: 'measuredWind',
    keys: ['windMeasured', 'windMph', 'windDirDeg', 'gustMph', 'windFrom', 'windStation',
           'windAgeMin'],
    say(c) {
      const onWater = c.windFrom === 'ndbc' && isNum(c.windMph)
        ? { mph: c.windMph, dirDeg: c.windDirDeg, gustMph: c.gustMph,
            station: c.windStation, ageMin: c.windAgeMin, kmFromWater: null, stale: false }
        : (c.windMeasured && isNum(c.windMeasured.mph) ? c.windMeasured : null);
      if (!onWater) return null;
      const dir = isNum(onWater.dirDeg)
        ? ` from ${Math.round(onWater.dirDeg)}° (${compassOf(onWater.dirDeg)})` : '';
      return `Wind MEASURED on this water: ${Math.round(onWater.mph)} mph`
        + `${isNum(onWater.gustMph) ? ` gusting ${Math.round(onWater.gustMph)}` : ''}${dir}`
        + ` — NDBC ${onWater.station || 'station'}`
        + `${isNum(onWater.kmFromWater) ? `, ${onWater.kmFromWater} km out` : ''}`
        + `${isNum(onWater.ageMin) ? `, ${onWater.ageMin} min old` : ''}`
        + `${onWater.stale ? ', older than the station’s own reporting interval' : ''}. `
        + 'This is one instant, not the day — the hour-by-hour wind in `conditions.windByHour` is '
        + 'what the plan is built against. Where the two disagree, say which one you used for the '
        + 'launch judgement and why.';
    },
  },
  {
    // ── WHICH WAY THE WATER IS GOING, WHICH IS A STRUCTURE DECISION ────────────────────────
    id: 'levelTrend',
    keys: ['trend24h', 'trend7d', 'trendUnits', 'trendMeasures', 'trendCoversHours'],
    say(c) {
      if (!isNum(c.trend24h) && !isNum(c.trend7d)) return null;
      const u = c.trendUnits ? ` ${c.trendUnits}` : '';
      const fmt = (d) => (!isNum(d) ? 'not enough series to say'
        : Math.abs(d) < 0.01 ? 'no change'
        : `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(2)}${u}`);
      const d = isNum(c.trend24h) ? c.trend24h : c.trend7d;
      const way = Math.abs(d) < 0.01 ? 'STEADY' : d > 0 ? 'RISING' : 'FALLING';
      const L = [`${c.trendMeasures || 'Gauge reading'} ${way} — 24 h ${fmt(c.trend24h)}, `
        + `7 d ${fmt(c.trend7d)}, NWPS observed series`
        + `${isNum(c.trendCoversHours) ? ` covering ${Math.round(c.trendCoversHours / 24)} days` : ''}.`];
      L.push('Which way it is going decides WHERE the day is fished, not just how it reads: rising '
        + 'water pushes fish shallow onto cover that was dry a week ago and makes flooded wood and '
        + 'bank grass the pattern, while falling water pulls them off the flats onto the channel '
        + 'edge, the drop and the first deep structure out. Pick the legs that match the direction '
        + 'and say that is why.');
      return L;
    },
  },
  {
    id: 'flowAnomaly',
    keys: ['flowAnomaly', 'flowAnomalyOf', 'flowPeriod', 'flowYears'],
    say(c) {
      if (!isNum(c.flowAnomaly)) return null;
      // THE SUPPORT GOES WITH THE NUMBER. `flowAnomalyOf` names the reach the anomaly is about,
      // and the period of record is what separates a rank worth acting on from noise.
      const of = c.flowAnomalyOf ? ` for ${c.flowAnomalyOf}` : '';
      const over = [c.flowPeriod ? String(c.flowPeriod) : null,
                    isNum(c.flowYears) ? `${c.flowYears} years of record` : null]
        .filter(Boolean).join(', ');
      return `Flow versus normal ${c.flowAnomaly > 0 ? '+' : ''}${c.flowAnomaly}${of} — National `
        + 'Water Model anomaly, published without units. Only the SIGN is usable'
        + `${over ? `, and the normal it is measured against comes from ${over}` : ''}.`;
    },
  },
  {
    // GENERATION IS THE CURRENT, and a boolean does not say how much of it there is.
    id: 'generation',
    keys: ['tvaDischargeCfs', 'tvaTailwaterFt'],
    say(c) {
      if (!isNum(c.tvaDischargeCfs) && !isNum(c.tvaTailwaterFt)) return null;
      const bits = [
        isNum(c.tvaDischargeCfs)
          ? `discharge ${Math.round(c.tvaDischargeCfs).toLocaleString()} ft³/s` : null,
        isNum(c.tvaTailwaterFt) ? `tailwater ${c.tvaTailwaterFt} ft` : null,
      ].filter(Boolean).join(' · ');
      return `TVA at this dam: ${bits}. This is the size of the current, which `
        + '`generating` on its own does not give: a light release is a push worth fishing and a '
        + 'heavy one is water a 12.5 ft pedal kayak cannot hold position in. Say which this is and '
        + 'where the boat can safely sit.';
    },
  },
  {
    // ── WHERE THE LAKE IS SUPPOSED TO BE TODAY ────────────────────────────────────────────
    //
    // A target is not a reading, and the label says so on the same line as the number — the same
    // rule the card has carried since it was written.
    id: 'operatorTarget',
    keys: ['tvaVsGuideFt', 'tvaGuideFt', 'usaceTargetFt', 'usaceProject', 'dukeGuide',
           'seasonalDrawdownFt', 'seasonalDrawdownFrom'],
    say(c) {
      const L = [];
      if (isNum(c.tvaVsGuideFt) || isNum(c.tvaGuideFt)) {
        L.push(`Against TVA's guide curve: ${isNum(c.tvaVsGuideFt)
          ? `${c.tvaVsGuideFt > 0 ? '+' : c.tvaVsGuideFt < 0 ? '−' : ''}${Math.abs(c.tvaVsGuideFt).toFixed(1)} ft`
          : 'the offset is not published'}`
          + `${isNum(c.tvaGuideFt) ? `, guide ${c.tvaGuideFt} ft` : ''}. Above the curve is water `
          + 'the operator intends to move, so expect generation; below it, expect the lake to be '
          + 'held. This is the closest thing there is to a forecast of the current.');
      }
      if (isNum(c.usaceTargetFt)) {
        L.push(`Corps target pool ${c.usaceTargetFt} ft — what ${c.usaceProject || 'this project'} `
          + 'is SUPPOSED to be at today, not a reading. A Corps lake has no single full pool: the '
          + 'target moves with the season, so judge the level against this and not against a '
          + 'remembered number.');
      }
      const g = c.dukeGuide;
      if (g && (isNum(g.vs_target_ft) || g.vs_same_date)) {
        const v = isNum(g.vs_target_ft)
          ? `${g.vs_target_ft > 0 ? '+' : g.vs_target_ft < 0 ? '−' : ''}${Math.abs(g.vs_target_ft).toFixed(1)} ft `
            + `against a guide curve of ${(g.today && g.today.target) ?? '?'} on a scale where 100 is full pond`
          : null;
        const h = g.vs_same_date
          // A RANK, NOT A PERCENTILE. Thirty-odd readings do not support one.
          ? `${g.vs_same_date.band} for this week — higher than ${g.vs_same_date.higher_than} of `
            + `${g.vs_same_date.n} readings within ${g.vs_same_date.window_days} days of this date`
          : null;
        L.push(`Against the operator's guide curve: ${[v, h].filter(Boolean).join('; ')}.`
          // A RESERVOIR LEVEL IS AN OPERATING DECISION, and a rank without the caveat reads as a
          // fact about rainfall.
          + (g.caveat ? ` ${g.caveat}` : ''));
      }
      if (isNum(c.seasonalDrawdownFt) && c.seasonalDrawdownFt > 0) {
        L.push(`This water is moved ${c.seasonalDrawdownFt} ft across a year by `
          + `${c.seasonalDrawdownFrom || 'its operator'}. Every charted depth in the pack was `
          + 'sounded at full pool, so on a lake with a swing this size the charted number and the '
          + 'water under the hull are different questions in the drawdown months.');
      }
      return L.length ? L : null;
    },
  },
  {
    // WHY THE WATER IS WHERE IT IS. A drought level is not a reading and not a target — it is the
    // rule the lake will be run under, and the release cut is published in the level's own comment.
    id: 'drought',
    keys: ['droughtLevel', 'droughtLevels', 'droughtNotice'],
    say(c) {
      const L = [];
      const d = c.droughtNotice;
      if (d) {
        L.push(`DROUGHT: ${d.stage != null ? `Low Inflow Protocol — Stage ${d.stage}` : 'Low Inflow Protocol'}`
          + `${d.suspends_recreation_flows
            ? '. Recreation flow releases are SUSPENDED under this stage, which is why a schedule '
              + 'on this water can read no release'
            : ''}. `
          + `${String(d.text || '').replace(/\s+/g, ' ').slice(0, 400)}`);
      }
      const lvl = c.droughtLevel;
      if (lvl) {
        L.push(`The lake has fallen to ${lvl.level}${isNum(lvl.ft) ? ` (${lvl.ft} ft)` : ''}`
          + `${lvl.comment ? ` — ${lvl.comment}` : ''}. That is the rule the water will be run `
          + 'under, not a reading: it says the level is low for a reason and will stay low, and it '
          + 'is usually why generation is being held back.');
      } else if (Array.isArray(c.droughtLevels) && c.droughtLevels.length) {
        L.push(`The operator publishes ${c.droughtLevels.length} drought levels for this project `
          + `(${c.droughtLevels.map((x) => `${x.level}${isNum(x.ft) ? ` ${x.ft} ft` : ''}`).join(', ')}) `
          + 'and today’s level is above all of them — no drought rule is in force.');
      }
      return L.length ? L : null;
    },
  },
  {
    id: 'releases',
    keys: ['releases', 'releasesRefused'],
    say(c) {
      const rel = c.releases;
      if (!rel) {
        return c.releasesRefused
          ? `No release schedule was read for this water — ${c.releasesRefused}. That is a gap, `
            + 'not a no-release day; do not build the day around current and do not rule it out.'
          : null;
      }
      const items = Array.isArray(rel.items) ? rel.items : [];
      return rel.all_no_release === true || !items.length
        ? 'The operator has published its release schedule and every day on it reads NO RELEASE. '
          + 'Do not build the day around current.'
        : `The operator has published releases: ${items.slice(0, 3)
            .map((i) => `${i.date || '?'} ${i.text || i.cfs || ''}`.trim()).join('; ')}.`;
    },
  },
  {
    id: 'accessNotices',
    keys: ['accessAlerts', 'accessAlertsExpired'],
    say(c) {
      const acc = Array.isArray(c.accessAlerts) ? c.accessAlerts : [];
      if (!acc.length) return null;
      const L = [`ACCESS NOTICES from the operator (${acc.length}) — a closed ramp is a trip that `
        + 'does not happen, so say it if it bears on the launch:'];
      for (const a of acc.slice(0, 4)) {
        L.push(`  · ${a.place || a.water || 'Access area'}: ${String(a.text || '').replace(/\s+/g, ' ').slice(0, 300)}`);
      }
      return L;
    },
  },
  {
    // ── THE THIRD STATE, AND THE ONLY DEFENCE AGAINST A NUMBER BEING INVENTED ──────────────
    //
    // A field can be empty for three reasons and until now the prompt could express one. A value
    // means it was measured. `unpublished` means no gauge bound to this water measures the
    // parameter at all -- a registry gap, and a permanent one. `silent` is the gap between them:
    // a site that DOES catalogue the parameter and returned no number today, named so it can be
    // distrusted rather than filled in from recall. The model has no other way to tell a clear
    // lake from an unmeasured one.
    id: 'honesty',
    keys: ['unpublished', 'silent'],
    say(c) {
      const L = [];
      const un = Array.isArray(c.unpublished) ? c.unpublished : [];
      const si = Array.isArray(c.silent) ? c.silent : [];
      if (un.length) {
        L.push(`NOT MEASURED ON THIS WATER — no gauge bound to it publishes `
          + `${un.map((p) => p.label || p.code).join(', ')}. Those are silent above because nobody `
          + 'measures them here, not because of what they would have said. Do not supply a value '
          + 'for any of them, and where one matters to the plan, say it was not measured.');
      }
      if (si.length) {
        const named = si.map((p) => {
          const why = p.reason === 'site_silent' ? 'whole gauge quiet' : 'no reading';
          const at = p.usgs_site ? ` (site ${p.usgs_site}, ${why})` : ` (${why})`;
          return `${p.label || p.code}${at}`;
        }).join('; ');
        L.push(`MEASURED HERE BUT NOT REPORTING TODAY — ${named}. A gauge that normally answers `
          + 'and did not is different from one that never measured it: treat these as unknown '
          + 'today, not as normal.');
      }
      return L.length ? L : null;
    },
  },
];

/**
 * Every other key readConditions() returns, and what already says it.
 *
 * This is not a list of things that do not matter — most of it is the core of the prompt. It is
 * the record of WHERE each one is said, so that this block does not say it twice and so that a
 * new field cannot land in the producer and reach nothing while looking accounted for.
 */
const CONDITION_ELSEWHERE = {
  // The envelope. `pending` and `error` are the reasons there is nothing, and the block returns
  // '' on an error rather than describing a water it could not read.
  ok: 'envelope',
  slug: 'envelope',
  displayName: 'the water is named in the day header',
  featureType: 'chooses riverPromptBlock() vs poolPromptBlock()',
  pending: 'envelope — the registry gap, surfaced by levelSentence() on the card',
  error: 'envelope — this block returns nothing when it is set',
  observedAt: 'provenance for the level, printed on the card',
  // WHERE THE WATER IS TODAY. poolPromptBlock() and levelSentence().
  levelFt: 'poolPromptBlock()',
  fullPoolFt: 'poolPromptBlock()',
  belowFullPoolFt: 'poolPromptBlock()',
  levelSource: 'levelSentence(), inside poolPromptBlock()',
  levelUrl: 'a link for the card only',
  feedName: 'levelSentence(), inside poolPromptBlock()',
  operatorMessage: 'poolPromptBlock()',
  operatorMessages: 'the older notices, card only',
  // THE FLOW IS THE DAY. riverPromptBlock().
  flowCfs: 'riverPromptBlock()',
  flowGauge: 'riverPromptBlock()',
  flowGaugeKm: 'how far the flow gauge is, card only',
  flowBand: 'riverPromptBlock() as flowVsNormal',
  flowMedian: 'riverPromptBlock() as flowMedianCfs',
  tidalFlowCfs: 'riverPromptBlock() — wins over flowCfs on a tidal river',
  stageFt: 'riverPromptBlock()',
  stageBasis: 'riverPromptBlock()',
  stageGauge: 'provenance for the stage, card only',
  stageGaugeKm: 'provenance for the stage, card only',
  stageGaugeRole: 'provenance for the stage, card only',
  floodCategory: 'riverPromptBlock()',
  floodActionFt: 'the threshold behind ftBelowFloodAction in riverPromptBlock()',
  stageVsActionFt: 'riverPromptBlock() as ftBelowFloodAction',
  gaugeOutOfService: 'riverPromptBlock()',
  generatingNow: 'riverPromptBlock() — the fact; the generation fact above is the magnitude',
  generationNext: 'riverPromptBlock()',
  // INSHORE, WHERE THE TIDE IS THE CURRENT. coastalPromptBlock().
  currentKn: 'coastalPromptBlock()',
  currentType: 'coastalPromptBlock()',
  currentAt: 'coastalPromptBlock()',
  currentStation: 'coastalPromptBlock()',
  currentStationKm: 'coastalPromptBlock()',
  currentBoundBy: 'coastalPromptBlock()',
  currentDirDeg: 'coastalPromptBlock() — the set',
  tideStation: 'coastalPromptBlock()',
  nextTide: 'coastalPromptBlock() as nextEvent',
  surgeFt: 'coastalPromptBlock() as surgeVsPredictedFt',
  salinityPpt: 'coastalPromptBlock()',
  salinityPsu: 'coastalPromptBlock()',
  conductanceUsCm: 'coastalPromptBlock()',
  saltGauge: 'coastalPromptBlock()',
  saltGaugeKm: 'coastalPromptBlock()',
  saltBasis: 'coastalPromptBlock()',
  ndbc: 'the raw buoy envelope — its met fields are lifted into windMph/windDirDeg/gustMph by '
      + 'readConditions() and said by the measuredWind fact; its ocean sonde is the coastal salt',
  // THE FISHING DAY STARTS WHEN YOU CAN SEE TO LAUNCH. lightPromptBlock().
  civilDawn: 'lightPromptBlock()',
  civilDusk: 'lightPromptBlock()',
  sunrise: 'lightPromptBlock()',
  sunset: 'lightPromptBlock()',
  // THE TWO SAFETY FIELDS. Printed from o.hazards in the safety section of the prompt.
  hazards: 'the hazards block, off o.hazards',
  hazardsAllClear: 'the hazards block, off o.hazards',
};

export function conditionsPromptBlock(ws) {
  if (!ws || ws.error) return '';
  const L = [];
  for (const f of CONDITION_FACTS) {
    let said = null;
    try {
      said = f.say(ws);
    } catch (e) {
      // ONE MALFORMED SUB-OBJECT MUST NOT COST THE WHOLE BLOCK. `dukeGuide`, `droughtNotice`,
      // `releases`, `unpublished` and `windMeasured` arrive shaped by the Worker, and a shape
      // that changed upstream is a missing line, not a plan with no conditions in it.
      console.warn(`[prompt] conditions fact ${f.id} could not be said:`, e && e.message);
    }
    if (!said) continue;
    for (const line of [].concat(said)) if (line) L.push(line);
  }
  if (!L.length) return '';
  return `
WHAT THE GAUGES SAY TODAY
${L.join('\n')}
`;
}

export { CONDITION_FACTS, CONDITION_ELSEWHERE };

/**
 * ── SPEED FOLLOWS FROM THE BAIT, AND THE GPS IS NOT THE BAIT'S NUMBER ───────────────────
 *
 * gpsWindowFor() and sharedSpeedWindow() live in lure-knowledge.js beside the windows they read --
 * the conversion is bait physics in moving water, not prose, and plan-assemble.js sets the leg's
 * actual ground speed from the same two functions. This file only says it out loud.
 */
/** One line of prompt for what a bait needs on the water, on a river leg carrying a current. */
export function riverSpeedNote(speed, currentMph) {
  const w = gpsWindowFor(speed, currentMph);
  if (!w) return '';
  const say = (b, lab) => (b
    ? `${lab} ${b.min}-${b.max} (best ${b.ideal})`
    : `${lab} cannot be slowed enough to fish it`);
  // A CLARIFICATION OF THE NUMBER ALREADY ON THE LINE, NOT A SECOND ONE. describeBait() ends with
  // the bait's speed range, and on a river that bare figure is exactly the thing being misread --
  // so this names it as a through-water number and then gives the two ground speeds that hold it.
  return ` — that ${speed.min}-${speed.max} mph is THROUGH THE WATER, so hold `
       + `${say(w.up, 'going up')}, ${say(w.down, 'coming back')} on the GPS`;
}

export function buildPlanRequest(o) {
  const day = {
    water: o.water, ramp: o.ramp, date: o.date,
    launchTime: o.launchTime, returnTime: o.returnTime,
    species: o.species || [],
    usableAh: o.usableAh ?? null,
    conditions: o.conditions || {},
  };
  // THE CURRENT THIS DAY IS FISHED IN, for the speed notes below. One number for the prompt, off
  // the reaches the app actually chose -- riverCurrent.medianMph is driftCurrentSummary's, and the
  // per-leg value rides on each candidate for anything that needs finer than that.
  // `isNum`/`num` FROM utils/num.js, NOT A LOCAL GUARD. Two call sites in this file were still
  // spelling the pattern out by hand after the sweep that replaced twelve of them, and the test
  // that forbids it -- "plan-prompt.js has no copy of the guard left in it" -- had been red since.
  // The sweep's own note says why leaving one behind is leaving the next instance of the family
  // behind with it: the hand-written version returned 0 for null, '' and a blank string, and a
  // zero current reads as measured slack water rather than as nothing measured.
  const riverCurrentMph = o.isRiver && o.riverCurrent && isNum(o.riverCurrent.medianMph)
    ? num(o.riverCurrent.medianMph) : null;
  const snapSet = new Set(o.snapEligible || []);
  const tieOnly = (o.tackle || []).filter((n) => !snapSet.has(n));
  // WHICH OF THE BAG MAY BE TROLLED. The bag was handed over as one flat list of names and the
  // only split it carried was snap-versus-tie -- so a Fluke, `trollable: false` in the inventory
  // and `technique: 'Cast only'` in LURE_KNOWLEDGE, arrived looking exactly like a crankbait.
  // Ryan found one on the starboard troll rod for all three legs of his 2026-08-30 Wateree day.
  // `trollable` was read in exactly two places in the whole plan path, and both of them only used
  // it to build the union that produced this list.
  const trollSet = new Set(o.trollable || o.tackle || []);
  const castOnly = (o.tackle || []).filter((n) => !trollSet.has(n));

  // HOW EACH BAIT GETS TO A DEPTH, SAID OUT LOUD INSTEAD OF READ OFF A NAME.
  //
  // Until now the model was handed a flat list of names and nothing else, so the only depth
  // information reaching it was whatever was printed in the name: "DD3 Crankbait (20-25ft)". It
  // read 25 off the label and the card printed 25. Ryan, 2026-08-30:
  //
  //   > the only way to change the depth of a lure is lead or speed... or changing the lure...
  //   > for a weighted lure (non lipped) either letting out more line or slowing down will drop
  //   > the bait down deeper... the only lure i have that has an actual max depth is the
  //   > crankbaits... and my experience is that most of them run more shallow than they say
  //
  // All of that is already in LURE_KNOWLEDGE and none of it was ever sent. Two facts per bait:
  // what controls its depth, and -- for a bait whose bill controls it -- that the printed range
  // is the maker's word rather than anything measured, so the shallow end is the one to place
  // fish against. `depthWindow().claimed` is that distinction.
  const depthNote = (real) => {
    const lure = o.lureByName ? o.lureByName(real) : null;
    if (!lure) return null;
    // LOOKED UP BY THE INVENTORY'S NAME, PRINTED IN THE FORM THE MODEL CAN ECHO. See
    // promptSafeTackleName(): the bag holds `3" Lipless Crankbait` and an unescaped inch mark
    // ends the JSON string the model is asked to write.
    const name = promptSafeTackleName(real);
    // AT THE SPEED THIS BAIT WILL ACTUALLY BE FISHED AT. On a lake the boat holds one speed and
    // 2.0 is the app's own trollMph, so that is the honest assumption. On a river the app now tells
    // him the GPS speed that puts THIS bait in ITS window, so the depth it runs at is the depth at
    // its own ideal through-water speed -- not at a number nobody is holding.
    const kSpeed = (LURE_KNOWLEDGE[lure.type] || {}).speed;
    const atMph = (riverCurrentMph != null && kSpeed && isNum(kSpeed.ideal))
      ? num(kSpeed.ideal) : 2.0;
    const w = depthWindow(lure, { speedMph: atMph, leadFt: null });
    if (w.mode === 'none') return null;                       // the CAST ONLY block says it better

    // A BAIT THAT ONLY FISHES BEHIND A TROLLING WEIGHT MUST SAY SO HERE, OR THE MODEL GUESSES.
    //
    // It guessed. Ryan's 2026-09-14 plan had the model declare `runsDepthFt: [10,16]` for the
    // 3/4oz Nichols; the app computed 18-22 for the same lead and overruled it, and the two
    // numbers were about two different rigs — the model's about a bare spoon, the app's about
    // one behind 2oz, and neither said which. Without this branch `depthWindow` returns
    // mode 'needs_weight' with null ends and the note below would tell the model a flutter
    // spoon's depth is set by its BILL and that it runs null to null feet.
    if (w.mode === 'needs_weight') {
      return `${name} — this bait ONLY fishes behind an inline trolling weight, and the app `
           + `fits it (Ryan owns 1, 2 and 3 oz; the 2 oz is what is tied on). Bare it is a `
           + `planing surface and rides just under the top at any lead, so do not put one on a `
           + `rod expecting it to sink on its own. Say what depth you want it at and leave the `
           + `weight and the lead to the app — a depth you quote for this bait without a weight `
           + `behind it is a number about a lure that is skipping along the top.`;
    }
    if (w.mode === 'lead') {
      // A PADDLE TAIL HAS NO WEIGHT UNTIL A HEAD IS ON IT, and the model was never told so. It
      // picked 60 ft of lead for Ryan's 4.6" swimbait on his 2026-08-30 Wateree plan — a number
      // about a bait with no mass — and the app, which had also never fitted a head, priced it
      // as a 1oz. Say plainly whose half of the job the lead is.
      const range = jigheadRangeOz(lure.lengthIn, lure.type);
      if (range && lure.weightOz == null) {
        return `${name} — the JIGHEAD is the weight, and the app fits it. Say what depth you `
             + `want this bait at and leave the lead to the app: it clips on the head this bait `
             + `carries (${range.startOz}-${range.maxOz} oz) and works out the line from that, `
             + `the speed and the depth you asked for. A lead you pick is a number about a bait `
             + `with no weight on it yet.`;
      }
      return `${name} — depth set by LEAD and SPEED. More line out or slower is deeper; `
           + `shorter or faster is shallower. No ceiling: it will go as deep as you feed it.`;
    }
    if (w.mode === 'surface') return `${name} — stays on the surface. No running depth.`;
    return `${name} — depth set by its BILL. It runs about ${w.min}-${w.max} ft and NO amount of `
         + `lead or speed takes it deeper; that is the maker's rating, not a measurement, and `
         + `his own experience is these run SHALLOWER than rated. When you need this bait to be `
         + `among the fish, count on ${w.min} ft. When you are checking it against the shallowest `
         + `water on a leg, assume it reaches ${w.max} ft.`;
  };
  const depthNotes = [...trollSet].map(depthNote).filter(Boolean);

  // WHICH BAITS CANNOT WORK ON WHICH LEG, SAID BEFORE THE CHOICE INSTEAD OF AFTER IT.
  //
  // Ryan, holding a plan that warned him a DD2 was the wrong bait for leg 2: "telling me that the
  // baits are wrong... so they shouldn't be offered in the first place... that means that the
  // model is not being told the right things."
  //
  // The model WAS told -- Pick Water has sent `maxRunDepthFt` per candidate since it was written,
  // and since 2026-08-30 it is also told a bill cannot be lifted by lead. It got a 13 ft ceiling
  // and put a DD2 (16-20 ft) on that leg anyway. So the diagnosis is not "it was not told the
  // number"; it is that the app KNOWS the consequence and keeps it to itself. capBaitDepth() works
  // this out exactly, and only once the plan exists, and then writes a warning.
  //
  // The same knowledge, moved in front of the decision. A lure whose depth is set by its BILL and
  // whose shallowest rated depth is already deeper than the leg's ceiling will drag on that leg
  // whatever lead it is given -- which is precisely capBaitDepth()'s test, asked earlier.
  //
  // A LEAD-CONTROLLED BAIT IS NEVER ON THIS LIST. It can always be brought up by shortening the
  // lead, which is what capBaitDepth() does for it rather than complaining, so naming it here
  // would delete water he can fish. Nothing is excluded that has a way of working.
  const cannotUseOn = (ceilingFt) => {
    if (!Number.isFinite(ceilingFt) || !o.lureByName) return undefined;
    const out = [];
    for (const name of trollSet) {
      const lure = o.lureByName(name);
      if (!lure) continue;
      const w = depthWindow(lure, { speedMph: 2.0, leadFt: null });
      if (w.mode !== 'rated' || !Number.isFinite(w.max)) continue;
      // ── max, NOT min, AND THE COMMENT ABOVE CLAIMED THEY WERE THE SAME TEST ──────────────────
      //
      // This read `w.min > ceilingFt` and called itself "precisely capBaitDepth()'s test, asked
      // earlier". capBaitDepth's test is `w.max <= ceilingFt`. They are not the same test, and the
      // model was being handed the lenient one.
      //
      // Measured on Ryan's 2026-09-14 plan: wateree_lake#216 has an 11 ft ceiling, `cannotUse`
      // named the four deep divers and NOT the MR Crankbait (6-12 ft) -- because 6 > 11 is false.
      // The model duly put the MR on that leg, and capBaitDepth then wrote "runs to 12 ft and the
      // shallowest water on this leg is 11 ft. Its depth is the lure itself, so lead will not lift
      // it -- it is the wrong bait for this pass." Told afterwards, having been offered it.
      //
      // Ryan settled the principle on the plan that prompted this whole block: "telling me that the
      // baits are wrong... so they shouldn't be offered in the first place... that means that the
      // model is not being told the right things." A rated bait whose MAX clears the ceiling is
      // fine; one whose max does not will drag somewhere on the pass and no lead lifts a bill.
      //
      // The shallow end is deliberately NOT what is compared. `depthWindow()` on a rated bait
      // returns the maker's own pair, and this file's own note on which end to read says it plainly:
      // "will it drag the bottom? assume it makes `max`. Pessimistic, and it saves the lure."
      if (w.max > ceilingFt) out.push(promptSafeTackleName(name));
    }
    return out.length ? out : undefined;
  };
  /* ── WHAT MAY GO BEHIND THE BOAT ─────────────────────────────────────────────────────────────
   *
   * TWO ELIMINATIONS, BOTH UNCONDITIONAL, AND NOTHING ELSE. A bait that cannot be trolled at all,
   * and a bait that can ONLY fish below the measured anoxic depth. See trollableBaits().
   *
   * THE FIRST VERSION OF THIS BLOCK, SHIPPED AND REVERTED THE SAME DAY, REQUIRED EVERY BAIT TO
   * REACH THE OXYGEN FLOOR, which deleted every topwater, squarebill and MR crankbait in the box.
   * Ryan: "are you saying that topwater for striper is not a viable method... that is the best
   * time for striper to be caught on topwater". A floor says nothing lives BELOW it. It says
   * nothing at all about where above it the fish are, and the top of an oxygenated column at
   * first light is the best water of the day.
   *
   * IT RANKS NOTHING and it does not say when. What band each bait covers is a fact; which one to
   * put out, and at what hour, is the judgement the model and the fisherman are here for.
   */
  const gate = (() => {
    if (!Array.isArray(o.inventory) || !o.inventory.length) return null;
    const floor = Number(o.oxygenFloorFt);
    const hasFloor = Number.isFinite(floor) && floor > 0;
    const { legal, refused } = trollableBaits(o.inventory, {
      oxygenFloorFt: hasFloor ? floor : null, speedMph: 2.0,
      // AND ON A RIVER, AT THE SPEED EACH BAIT WILL ACTUALLY BE FISHED AT. The app now holds a
      // ground speed that puts the bait at its own best through the water, so the covers and the
      // lead below are computed there. 2.0 stays the still-water answer, because on a lake it is
      // the boat's one speed. See trollableBaits() and gpsWindowFor().
      speedMphFor: riverCurrentMph != null
        ? (type) => ((LURE_KNOWLEDGE[type] || {}).speed || {}).ideal : undefined,
      maxLeadFt: FISHING_STYLE.rigging?.maxLeadFt,
      inlineWeightOz: RIGGED_TROLLING_WEIGHT_OZ,
      // THE BOX, so a bait whose weight IS its jighead gets priced on a head that fits its length.
      jigheads: JIGHEADS_OWNED_OZ,
    });
    if (!legal.length) return null;
    const rows = legal.slice().sort((a, b) => (a.covers[0] - b.covers[0]) || (a.covers[1] - b.covers[1]));
    const line = (l) => `- ${promptSafeTackleName(l.name)} — covers `
      + `${l.covers[0] === l.covers[1] ? `${l.covers[0]} ft` : `${l.covers[0]}-${l.covers[1]} ft`}`
      + ` (${l.controlledBy})`
      + `${Number.isFinite(l.leadFt) && l.leadFt > 0
            ? (l.leadIsSetback ? `, ${l.leadFt} ft behind the boat`
                               : `, ${l.leadFt} ft of lead at its deepest`) : ''}`
      + `${l.inlineWeightOz ? ` behind the ${l.inlineWeightOz}oz inline weight` : ''}`
      + `${l.jigheadOz ? ` on a ${ozLabel(l.jigheadOz)} head` : ''}`
      + `${describeBait(l.type) ? ` — ${describeBait(l.type)}` : ''}`
      // AND WHAT TO HOLD ON THE GPS TO GET IT THERE, on a river. See riverSpeedNote().
      + `${riverCurrentMph != null
            ? riverSpeedNote((LURE_KNOWLEDGE[l.type] || {}).speed, riverCurrentMph) : ''}`;
    const why = {};
    for (const r of refused) (why[r.why] = why[r.why] || []).push(promptSafeTackleName(r.name));
    return {
      names: rows.map((l) => promptSafeTackleName(l.name)).join(', '),
      block: `
WHAT EACH OF THESE COVERS, SHALLOWEST FIRST${hasFloor ? ` — AND THE FLOOR IS ${floor} FT` : ''}
${hasFloor ? `There is no oxygen below ${floor} ft, measured on a vertical cast, so nothing holds
under it and a bait worked there is in dead water. That is ALL that number says. It says nothing
about where above it the fish are — at first light they may be on top, and by midday they may be
on the floor. That is your call and the light block above is what informs it.

` : ''}A range below is what the bait can be worked at, not where the fish are. THEY ARE NOT
RANKED: nobody has measured which of these catches more fish on this water, this app included, so
pick on the depth you want and the description, and say in the rod's \`why\` what you picked it for.${
riverCurrentMph != null ? `

THE GPS IS NOT THE SPEED THE BAIT SEES, AND ON THIS WATER THE DIFFERENCE IS ${riverCurrentMph.toFixed(2)} MPH.
The lure only knows the water it is moving through. Going UPSTREAM the water runs past it at your
GPS speed PLUS the current; coming back down, MINUS it. So the same number on the screen is two
different presentations on the two halves of the day, and at 2.0 on the GPS here the bait is doing
${(2 + riverCurrentMph).toFixed(2)} mph going up and ${Math.max(0, 2 - riverCurrentMph).toFixed(2)} coming back. Each line below says what to hold instead.
THE APP SETS THE SPEED FROM THE BAIT YOU CHOOSE, so you do not return one — but TWO RODS SHARE ONE
BOAT, and therefore one ground speed. PICK A PORT AND A STARBOARD WHOSE WINDOWS OVERLAP. Where they
do not, the app holds the SLOWER bait's ceiling so that nothing blows out, and the faster one runs
under its window for the whole pass — that is a real cost and it is yours to spend or avoid. If no
overlapping pair covers the water you want, say so and pick the pair that costs the least.` : ''}

${rows.map(line).join('\n')}
${refused.length ? `
NOT AVAILABLE BEHIND THE BOAT, and why:
${Object.entries(why).map(([w, names]) => `- ${names.join(', ')}: ${w}`).join('\n')}
` : ''}`,
    };
  })();

  const candidates = (o.candidates || []).map((c) => (
    c && isNum(c.maxRunDepthFt)
      ? { ...c, cannotUse: cannotUseOn(Number(c.maxRunDepthFt)) }
      : c));

  const system = 'You are TrollMap Smart Plan, an expert fishing guide planning one day on the '
    + 'water for a kayak angler. Return one valid JSON object and nothing else — no markdown, no '
    + 'commentary, no code fences.';

  const user = `Plan today on ${o.water} for ${(o.species || []).join(' and ') || 'whatever is biting'}.

THE DAY
${JSON.stringify(day, null, 1)}

THE BOAT — physical facts, not preferences
- Native Watersports Slayer Propel Max 12.5, pedal drive, Newport NK180 Pro stern motor.
- The motor has NO spot-lock and no GPS anchor. The pedal drive has instant mechanical reverse.
- SIX rods, always six. Two in the water at a time, one per side, in the holders in front of the
  seat. The other four wait in the vertical holders behind it.
- Spinning rods only. No live bait, no downriggers.
- Positioning while stopped is manual and you must say how: pedal-hover into wind or current in
  open water; a brush gripper or dock rope to tie off silently in timber, brush or docks; a
  stakeout pole on shallow flats; a natural wind drift with a little steer along riprap.

THE RODS — the one constraint that can wreck a day
${FLUORO_RODS.join(', ')} carry a 20 lb fluoro leader. ${SNAP_RODS.join(' and ')} carry swivel snaps.
That terminal tackle is already tied on and stays that way.

A snap adds metal and weight at the nose, which kills the action of anything that swims on its
own lip or blade. So a lure that must be tied direct can only go on a leader rod.

MAY HANG OFF A SNAP (so may go on ${SNAP_RODS.join(' or ')}, or on a leader rod):
${[...snapSet].map(promptSafeTackleName).join(', ') || '(unknown — treat everything as tie-only)'}

MUST BE TIED DIRECT (leader rods only):
${tieOnly.map(promptSafeTackleName).join(', ') || '(none)'}

**AT MOST FOUR tie-only lures.** Ask for five and he has to cut a snap off, tie on a leader, then
tie the leader to the lure, in a moving kayak. Do not do that to him.

**THE LURE CHOICE IS THE WHOLE POINT.** He is here to be handed the baits with the best chance at
${(o.species || []).join(' and ') || 'this species'} on ${o.water}, at this time of year, in this
place. Choose all six on that basis and say why each one earns its rod — depth band it covers,
what it imitates, what the water clarity and temperature argue for. Do not fill slots for the
sake of it and do not reach for a default. Six considered choices.

It is fine if the day only ever fishes two of them; the rest wait behind the seat. But every rod
you name has to be a real recommendation, and you may only deploy, cast with, or change a rod
you named — nobody knows what is on the ones you did not.

Anything you expect to CHANGE during the day belongs on a snap rod if it can be — that change is
seconds, where a leader rod is a knot with wet hands.

Colour is a free string; assume any colour combination is aboard. Use ONLY these exact lure names:
${gate ? gate.names : ((o.tackle || []).map(promptSafeTackleName).join(', ') || '(inventory unavailable)')}
${gate ? gate.block : ''}
${depthNotes.length ? `
HOW EACH OF THESE GETS TO A DEPTH. There are only three ways to move a bait: the lead, the speed,
or a different bait. Do not read a depth off a lure's NAME — the name is what the box says.
${depthNotes.map((d) => `- ${d}`).join('\n')}
` : ''}
${castOnly.length && !o.isRiver ? `
CAST ONLY — NEVER BEHIND THE BOAT. These may go on a casting rod at a stop and NOWHERE else:
${castOnly.map(promptSafeTackleName).join(', ')}
They are unweighted soft plastics. At trolling speed they plane instead of sinking, so they have
no running depth and no length of lead gives them one. A troll rod carrying one of these is a rod
fishing nothing.
` : ''}${castOnly.length && o.isRiver ? `
NOT ON THE WATER TODAY: ${castOnly.map(promptSafeTackleName).join(', ')}.
These are unweighted soft plastics — they plane at trolling speed and have no running depth, so
they are cast baits, and there is no stop to cast them at on a river (rule 4). Do not name one on
a rod. The six rods are six trolling baits.
` : ''}
${o.waterIsChosen ? 'THE WATER HE CHOSE' : 'THE WATER YOU MAY FISH'}
Each candidate is a stretch of a real trolling run, already filtered to water he can reach and
depths that matter today, and ranked by what it passes. \`structures\` lists what each leg goes by
in the order you meet them, with \`atM\` metres from the start of that leg.

NOT EVERYTHING ON A LEG IS THERE TO BE FISHED. An entry carrying \`worthFishing: true\` is a
target. An entry with no \`worthFishing\` is a hazard, an obstruction or a pile — it is on the list
because it is on the water, not because it is worth a cast. Never put a stop on one. Say where it
is and what it means for the pass: which side to hold, whether it forces a lead change, whether it
is the reason a leg is worth fishing in one direction and not the other. \`structuresTotal\` counts
everything on the leg and \`structuresShown\` counts what you were handed; where they differ, the
list is the best of the targets plus every hazard, and there is more castable water than you see.

${o.isRiver ? `THE ORDER IS NOT YOURS HERE AND NEITHER IS THE DEADHEAD. \`transitToM\` and
\`transitToMIfFishedBack\` are on the candidates because the same objects describe a lake day, where
they are a real choice. On a river they are not being offered to you: the app drew the path and the
order is the order (rule 3). What is yours is what goes in the water, and WHEN.
${drawnDayBlock(o.drawnDay, candidates)}` : `WHAT THE ORDER COSTS. Each candidate also carries \`transitToM\` — metres of deadhead from the END
of that leg to the START of every other leg — \`transitFromRampM\` from the ramp to its start, and
\`transitToRampM\` from its end back to the ramp. Those are the only numbers that change when you
reorder the day, and they are yours to spend: the app computes the legs, you choose the sequence.

AND WHAT TURNING AROUND COSTS. \`transitToMIfFishedBack\` is the same table for a leg you troll an
EVEN number of times: turn at each end and you finish where you started, so the hop to the next
leg is measured from the other end of the pass. Where that number is much smaller than
\`transitToM\`, fishing the leg back is cheaper in deadhead AND longer in the water — the two
things almost never point the same way and here they do.`}

${JSON.stringify(candidates)}
${o.waterIsChosen ? `
THE FISHERMAN ALREADY CHOSE THIS WATER AND THIS ORDER.
He picked these stretches himself, off a map, with the reasons for and against in front of him —
they are in \`whyThisWater\` on each one, computed from the chart, not written by you. Do not
re-rank them, do not suggest better water, and do not reorder the day. The list above IS the day,
first to last.

RETURN ONE ENTRY IN \`legs\` FOR EVERY ONE OF THE ${(o.candidates || []).length} \`runId\`s ABOVE
— all ${(o.candidates || []).length} of them, every one carrying its own \`deploy\`. A runId you
leave out does NOT drop that stretch from the day: he picked it, so he is going to run it, and it
goes in the plan with nothing behind the boat. On 2026-08-31 five of ten came back unmentioned and
he pedalled five miles of chosen water with bare rods. If a stretch is genuinely not worth fishing,
say so in its \`why\` and rig it anyway — that is a leg he can skip on the day, which is his call
to make and not one you can make for him by omission.

The order is a SEARCH order: the most diagnostic water first, so that a leg which produces nothing
still tells him something. That is why it is not the shortest route between them.

YOUR JOB IS THE TACKLE. Baits, speeds, leads, presentation, which two rods go in the water on each
leg, and where to pause. Nothing about which water.

\`ladderPartners\` is how many other stretches sit within a turn of that one at a different depth.
Where it is above zero, say so in the leg's notes: he can turn at the end and come back deeper or
shallower without moving the boat, and how many laps that is worth depends on the lures you put
out — a bait that only works 12–18 ft cannot ladder past its own range.
${(o.freeCastSpots || []).length ? `
CAST SPOTS ALREADY ON HIS ROUTE — ${JSON.stringify(o.freeCastSpots)}
These sit inside the water he picked, so working one costs only the minutes spent on it. Prefer
them over anything that would need a detour. Every one is listed; NONE has been pre-selected for
you, because which water is worth stopping on today is the judgement you are here to make.` : ''}${
(o.chosenCastSpots || []).length ? `

HE PICKED THESE CAST SPOTS HIMSELF — ${JSON.stringify(o.chosenCastSpots)}
These are not suggestions and they are not yours to drop. Work each one into the day, and where
one is marked \`free: false\` it costs a run out and back that he already accepted. Say what to
throw at each and how to hold the boat on it — there is no spot-lock, so positioning is pedal work
against the wind or the current and you have to say which.` : ''}${
o.castStopsWanted != null ? `

HE ASKED FOR ${o.castStopsWanted} STOP-AND-CAST${o.castStopsWanted === 1 ? '' : 'S'} TODAY.
That is a request, not a quota. Get as close to it as the water honestly supports: if the good
cover runs out at two, plan two and say why rather than padding to the number. If there are five
worth stopping on and he asked for three, pick the three and name the others as options.` : ''}` : ''}
RULES THAT ARE NOT NEGOTIABLE
1. Name legs by \`runId\` and stops by a structure \`id\`, both copied exactly from the list above.
   Anything invented is thrown away and the plan comes up short.
2. NEVER write a latitude, a longitude, or a place name of your own. The app owns every position.
3. ${o.isRiver ? `THE DAY IS ONE PATH AND ITS SHAPE IS ALREADY DECIDED: OUT FROM THE RAMP, TURN,
   FISH BACK. Every leg above is a piece of that one path, laid out from where he launches, so the
   hop between two neighbouring legs is short — the app trims a leg back to where the structure
   stops, and whatever quiet water it trimmed is what \`transitToM\` charges you to cross. There is
   nowhere else to go — this is a river, and the water is a line.
   THE DAY IS ALREADY DRAWN, AND THE ORDER IS THE ORDER HE WILL FISH IT IN. The app has picked how
   far out to go, which reaches that is, which side of the launch to take first and where it turns
   him around — against the battery and the window together, which is arithmetic and not judgement.
   \`fromRamp\` on each leg says which half of the day it is: \`{direction: 'upstream', m: 8000}\` is
   a reach whose near end is eight kilometres up from the launch. The list is already nearest-first
   on the outward half.
   SO DO NOT REORDER THE LEGS AND DO NOT DROP ONE. Every leg handed to you is part of the day the
   app costed; rig them all, in the order given. A leg you would rather not fish is a sentence in
   the notes, not a leg left out of the list.
   EVERY LEG IS TROLLED OUT AND FISHED BACK, AND THE APP HAS ALREADY SAID SO. That is the day, not
   an extra — a leg trolled out and pedalled back with the rods in is water he paid for twice and
   fished once. There is no pass count to return.
   AND THERE IS NO SPEED TO RETURN EITHER. The app sets the ground speed from the baits you rig,
   once for the run up and once for the run back, because a bait's window is a speed THROUGH THE
   WATER and the current makes those two different numbers on the GPS. See the speed block above the
   bait list, and pick a pair whose windows overlap.
   WHAT IS LEFT IS THE FISHING: which two baits go in the water on each leg, at what lead, why that
   water at that hour, and what the sonar should show. That is the whole of your job here, and it is
   the part nothing in this app can compute.` : `${o.orderIsChosen
   ? `THE ORDER IS FIXED AND IT IS NOT YOURS. Fish them in the order given. If the deadheading
   between two of them looks genuinely wasteful, SAY SO in the notes and leave the order alone —
   he has veto over his own plan and does not need it exercised for him.`
   : `ORDER THE LEGS TO SPEND AS LITTLE OF THE DAY DEADHEADING AS YOU CAN.`} Add up
   \`transitFromRampM\` for the leg you start with, \`transitToM\` for each hop between
   consecutive legs, and \`transitToRampM\` for the leg you finish on — that total is time and
   battery with nothing in the water. Trolling costs about 2.5 Ah per mile; deadheading at 3.5 mph
   costs about 3.8 Ah, half again as much for water you do not fish. Two legs that are each close
   to the ramp can still be six miles from EACH OTHER, and a day that spends nearly half its
   distance travelling is a day half wasted — that is a real plan, from 2026-08-09, and it is what
   \`transitToM\` is here to stop. There is no "out and back": you finish near the ramp because
   you ordered it that way. Prefer a slightly weaker leg next door to a slightly better one across
   the lake, and if the good water genuinely is far apart, fish fewer legs rather than commuting
   between them.
   AND FISH THE GOOD ONES BACK. A pass is a piece of water, not an errand to be run once and
   crossed off. When a stretch earns it — it holds the structure the day is built on, the history
   says fish have come off it, it is the best water you have at that hour — set \`trollPasses\` to
   2 and troll it down and back before you move. That is water fished twice for zero deadhead,
   and it often costs less deadhead than moving on, because you end at the end you came in by:
   compare \`transitToMIfFishedBack\` against \`transitToM\` for the leg that follows it. A day of
   six stretches each fished once, with a transit between every pair, is the shape this is here to
   break. Do not set it on every leg to run the clock up — set it where the water deserves a
   second look, and say why in \`why\`. The app stops adding passes at the first one that would end
   after he is due back.`}
4. ${o.isRiver ? `THERE ARE NO STOPS ON A RIVER. Return \`"stops": []\` and mean it.
   Ryan, 2026-09-17: "i do not typically anchor in a river so stop and cast really isn't going to be
   a thing... i am not going to try and hover with either the trolling motor or the pedals." The
   motor has no spot-lock, the pedal drive cannot hold a 12.5 ft kayak against moving water for
   fifteen minutes, and he has said he will be moving no matter what. A stop on a river is a boat
   going backwards downstream while both hands are on a rod.
   THAT IS A CONSTRAINT ON THE BOAT, NOT A VIEW ABOUT CASTING. The structure list is still there to
   be READ: say which side of the channel a hole is on, which way the bend throws the current, what
   it means for the pass. Work it into the TROLL — a lead change, a speed change, a lane held wide
   of the point bar — because that is the only way this boat fishes it. Every rod on this day is a
   trolling rod.` : `A stop is a pause ON a leg, not instead of one. Stop where the structure is
   better cast at than trolled over — a hump crown, a dock line, a creek mouth, a laydown — and
   only ever on a
   structure carrying \`worthFishing: true\`. Judge every leg's structures on their own merits: a
   day that passes a dozen castable features and stops at one of them has ignored the water the
   app just handed you. Do not pad the list to hit a number either. Stop at what earns it, leg by
   leg, and the count will take care of itself.`}
5. \`depthFt\` on a structure is that structure's own depth — size the presentation from it. Where
   it is null the pipeline has no depth for that kind of feature; say so rather than guessing.
6. TWO RODS IN THE WATER ON EVERY SINGLE LEG. Exactly one port, one starboard, on every leg in the
   list — there is no such thing as a leg with an empty spread. A leg you cannot rig for is a leg
   you should say you cannot rig for, in \`safety.warning\`; it is never one you leave blank.
7. THE FISH ARE NOT ON THE BOTTOM. This is the one that gets got wrong.
   The bait runs at the depth THE FISH ARE HOLDING. It does not run at the depth of the lake bed.
   A leg over 36 ft of water, with the fish holding 15-40 ft, is fished with a bait running about
   20 ft — and that is CORRECT, not a compromise. You do not need a deeper bait for a deeper leg.
   Do not match the bait to the bottom. Do not skip a deep leg because nothing you rigged reaches
   the floor of it: nothing needs to.
   READ THE THREE WATER NUMBERS ON A LEG AS THREE DIFFERENT FACTS. \`depthMinFt\` and
   \`depthMaxFt\` are the shallowest and deepest water the leg actually crosses; \`depthFt\` is the
   median of it. A leg is NOT one depth — these lines are fitted so a kayak can follow them, not
   traced along a single contour, so "the 27 ft line" is a name and 25-32 ft is the water. Judge a
   bait against the range, not the name.
   \`cannotUse\` ON A LEG IS THE LIST OF BAITS THAT WILL NOT CLEAR IT. Their depth is set by a
   bill, so no length of lead lifts them: on that leg they drag, and a dragged bait is a lost
   bait. THAT CUTS BOTH WAYS AND THE SECOND HALF MATTERS. More line will not take a lipped bait
   past its bill — and too little line will not get it down to the bill either. It still has to be
   let back a normal working distance behind the boat like anything else. A lead of 0, or a token
   few feet, is not "the bill decides the depth", it is a bait hanging off the rod tip in the
   wake. Do not deploy one of them there. It is not a judgement about the bait -- the same lure
   may be the right answer on the next leg, and the list is worked out per leg for that reason.
   Nothing appears on it that has any way of working, because a weighted bait is simply given a
   shorter lead instead.
   \`maxRunDepthFt\` IS ONE RISE, NOT THE DEPTH OF THE LEG. It is the shallowest water anywhere on
   that leg, measured within the boat's wander — one spot somewhere along the pass, and the chart
   does not say where. A leg reading 25-31 ft with \`maxRunDepthFt: 20\` is twenty-five to thirty-one
   feet of water that comes up to 20 once. It is NOT a 20 ft leg.
   So size the bait against \`depthFt\`, the median — that is the water the pass mostly is — and read
   the rise as a thing to know about rather than a limit on the whole stretch. A bait that clears
   the median is right for this leg; the rise gets flagged on the card with the lead that would lift
   it over, and the angler decides there. A bait deeper than the MEDIAN is a bait too deep for the
   stretch generally, and that one is wrong: take a shallower bait or a shorter lead.
   That is the angler's own correction, on being shown a lipless pulled off 17 ft down to 11 for a
   whole pass on 11-25 ft water with a median of 20: "i dont see anything wrong with leg 8... it is
   not much different than the other water offered", then "flag the rise and let me decide". Do not
   set every lead on the day to the shallowest rise on it.
   A BILL IS THE EXCEPTION, and it is already worked out for you: \`cannotUse\` is computed against
   the rise, not the median, because no length of lead lifts a lipped bait off a shoal it meets on
   every pass and a dragged crankbait is a lost crankbait. There is nothing to adjust at the rise
   with one of those, so it is simply not offered on that leg.
   FISH LOOK UP, so the error is not symmetric. A bait running ABOVE the fish still gets eaten —
   they come up to it. A bait running BELOW them is behind them and out of sight, and one dragging
   bottom is fouled. So when the water forces you shallower than the band, take it and do not
   apologise for it: shallow is the cheap direction to be wrong in, deep is the expensive one. A low
   \`maxRunDepthFt\` never means "skip this leg", and never leave the rods out of the water.
   WHAT IS BESIDE THE LINE IS NOT WHAT IS UNDER IT. \`relief\` is the chart pipeline's word for the
   water within ${RELIEF_RADIUS_M} m of the pass — \`channel_edge\`, \`break\`, \`steep_bank\` or
   \`flat\` — and \`deepestNearbyFt\` and \`reliefDropFt\` are the measurement it was classified from:
   the deepest charted water in that circle, and how much deeper that is than the line itself. A leg
   reading 25-31 ft with \`reliefDropFt: 38\` has sixty-odd feet of water off its shoulder and fish
   that can sit in it and come up; the same leg with \`reliefDropFt: 3\` is a shelf with nothing
   beside it. Both are 25-31 ft of water under the boat, and the bait depth is the same question on
   each — this changes WHICH LEG IS WORTH THE BATTERY, and which end of a long pass to start on.
   IT IS NOT A DEPTH YOU CAN FISH. The deep water is somewhere in that circle and the chart does not
   say where, exactly as \`maxRunDepthFt\` does not say where its rise is. Never set a bait to
   \`deepestNearbyFt\` — nothing is trolling over it — and never call a leg deep because of it. Where
   the fields are absent the pipeline's probe had no answer there; that is not a flat.

SAFETY — judge it honestly for a 12.5 ft kayak
Sustained wind over 15 mph, or gusts over 20, is a no-go. Judge ${o.ramp || 'the ramp'} against the
wind direction: is it a dangerous windward launch?${o.hazards && o.hazards.length
  ? `\nWHAT IS IN THE WAY on this water:\n`
    + o.hazards.map((h) => `- ${h}`).join('\n')
    + `\nEach line says where it came from. A CANNOT ENTER line is a hard constraint off Garmin's `
    + `survey — no leg through it and no stop in it. An AVOID line is a charted warning. A line `
    + `from the research is written advice with no position at all: say the ones that bear on `
    + `today out loud, and never imply an unpositioned one is marked on the chart.`
  : ''}
${coastalPromptBlock(o.waterState)}${riverPromptBlock(o.waterState, o)}${poolPromptBlock(o.waterState)}${chartCoverageBlock(o)}${conditionsPromptBlock(o.waterState)}${lightPromptBlock(o.waterState, o.weatherByHour, o.launchTime, o.returnTime, o.lightFacts, o.isRiver)}${timeBudgetBlock(o.windowMin, o.launchTime, o.returnTime, o.dayMin)}${thermoclineNormBlock(o.thermoclineNorm)}${inshoreSeasonBlock(o.inshoreSeason)}${seabedHabitatBlock(o.seabedHabitat)}
WHAT IS ALREADY KNOWN
${o.intel || 'NOTHING. No researched profile exists for this water, so everything else here rests '
  + 'on the chart, the gauges and general species knowledge. Say so in the plan rather than '
  + 'writing as though this water had been studied — an absent profile is not a profile that '
  + 'looked and found nothing.'}
${patternFactsBlock(o.patternFacts)}
RETURN EXACTLY THIS SHAPE
{
  "safety": { "isGo": true, "warning": "", "rampEvaluation": "one sentence on wind exposure at this ramp" },
  "loadout": {
    "why": "how these six cover the day's depth bands",
    "rods": [
      { "id": "R1", "lure": "exact name from the list", "color": "free text",
        "role": ${o.isRiver ? '"troll"' : '"troll" or "cast"'}, "leadFt": 95, "runsDepthFt": [22, 28],
        "why": "one sentence" }
      // Only the rods this plan uses — two is a complete answer. Put tie-only lures on
      // ${FLUORO_RODS.join('/')} and snap-friendly ones on ${SNAP_RODS.join('/')} where you can.${o.isRiver ? `
      // EVERY ROD IS "troll" ON THIS DAY. There are no stops on a river (rule 4), so a rod set to
      // "cast" is a rod that never gets picked up.` : ''}
    ]
  },
  "legs": [${o.isRiver ? `
    { "runId": "copied exactly", "deploy": { "port": "R1", "starboard": "R5" },
      "deployBack": { "port": "R2", "starboard": "R6" },
      "ifNotProducing": { "rodId": "R2", "insteadOf": "R1", "why": "one sentence" },
      "why": "one sentence on why this water, at the hours it is fished, in the light it has" }
    // EVERY LEG, IN THE ORDER GIVEN. No \`speedMph\` and no \`trollPasses\`: the app sets both on a
    // river and returning one is ignored. See rule 3.
    //
    // \`deploy\` IS THE RUN OUT AND \`deployBack\` IS THE RUN BACK, and that is the cheapest thing on
    // this boat. The four rods not in the water are already rigged and standing behind the seat, so
    // picking two of them up at the turnaround costs SECONDS. Retying a lure on a deployed rod
    // (\`changes\`) is a knot with cold wet hands in a moving kayak, and on a leader rod it is two
    // knots. So where the run back wants something different, name a different PAIR here first and
    // reach for \`changes\` only when no rigged rod carries what the water now wants.
    // \`deployBack\` IS OPTIONAL, AND LEAVING IT OUT IS A REAL ANSWER: the same two rods come back.
    // Say in \`why\` that you meant it, because the pass coming back may be in different light,
    // against a current that is now behind the boat, and hours from the one going out.
    ${FALLBACK_FIELD}` : `
    { "runId": "copied exactly", "speedMph": 2.0, "trollPasses": 1,
      "deploy": { "port": "R1", "starboard": "R5" },
      "ifNotProducing": { "rodId": "R2", "insteadOf": "R1", "why": "one sentence" },
      "why": "one sentence on why this water, now" }
    // \`trollPasses\` is how many times you troll this stretch before moving on — down, back,
    // down again. Omit it or say 1 for a single pass. See rule 3.
    ${FALLBACK_FIELD}`}
  ],
  "stops": [${o.isRiver ? `],  // EMPTY, ALWAYS, ON A RIVER. See rule 4 — he cannot hold the boat.` : `
    { "runId": "copied exactly", "id": "that structure's \`id\`, copied exactly",
      "rods": ["R6"], "durationMin": 15,
      "why": "why this is worth stopping for rather than trolling over",
      "presentation": "how to work it",
      "positioning": "how to hold the boat there, given no spot-lock" }
    // ONE ENTRY PER STRUCTURE WORTH STOPPING AT, across the whole day. Several is normal; one
    // for a whole day almost never is. Copy \`id\` — NOT \`structureId\`, which is the lake's own
    // name for the feature and is there to be read, not returned.
  ],`}
  "changes": [
    { "beforeRunId": "copied exactly", ${o.isRiver ? '"pass": 2, ' : ''}"rodId": "R5", "to": "exact name from the list",
      "why": "what changed to make this worth the swap" }${o.isRiver ? `
    // \`pass\` IS WHICH OF THE TWO PASSES OVER THAT REACH THE SWAP HAPPENS BEFORE, and on a river
    // it is the whole of how you place a change in TIME. 1 is the run out, 2 is the run back, and
    // they can be hours and a light change apart \u2014 see the day above. Leave it out and the app
    // puts the swap before the run out, which on a reach fished at first light is rarely the point.` : ''}
  ],
  "notes": {
    "scoutNotes": "two or three sentences of tactical overview",
    "fishfinderNarrative": "about 150 words on what the sonar should show along these legs and how to work what is rigged"
  }
  // TWO, AND BOTH ARE READ. Nothing else belongs in \`notes\`. Two more fields used to be asked for
  // here and the app read neither, so a sonar signature and an adjustment tip were written on every
  // plan and binned unseen. What to do when nothing is hitting is \`ifNotProducing\` on each leg now,
  // where it names a rod and a reason instead of being one line about nine hours.
}`;

  return { system, user };
}

/**
 * Pull the JSON object out of whatever the provider returned.
 * Kept in the spirit of the extraction smart-plan.js already used against /groq-query, because
 * that path has survived several providers and their various ideas about code fences.
 */
/**
 * Drop commas that sit immediately before a `]` or a `}`, and count them.
 *
 * STRING-AWARE, because a blind regex is wrong here. `why` and `presentation` are free text the
 * model writes, and a sentence ending "...work it slow, ]" would be silently edited by a pattern
 * that cannot tell a comma in the syntax from a comma in a sentence. This walks the text tracking
 * whether it is inside a string literal and only ever removes a comma that JSON itself forbids.
 *
 * It fixes exactly one class of breakage. Anything else still fails loudly, with the fragment.
 */
function stripTrailingCommas(src) {
  let out = '', inStr = false, esc = false, fixes = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === ',') {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === ']' || src[j] === '}') { fixes++; continue; }
    }
    out += ch;
  }
  return { text: out, fixes };
}

/** The 120 characters either side of where JSON.parse gave up, when it says where. */
function around(src, err) {
  const at = /at position (\d+)/.exec(String(err && err.message) || '');
  if (!at) return '';
  const i = Number(at[1]);
  return `\n…${src.slice(Math.max(0, i - 120), i)}<<HERE>>${src.slice(i, i + 120)}…`;
}

export function parsePlanResponse(text) {
  const raw = String(text || '').replace(/```json|```/g, '').trim();
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a === -1 || b === -1 || b <= a) throw new Error(`no JSON object in response: ${raw.slice(0, 200)}`);
  const body = raw.slice(a, b + 1);
  try { return JSON.parse(body); } catch (first) {
    // A TRAILING COMMA IS NOT A WRONG ANSWER, IT IS A TYPO IN THE PUNCTUATION.
    //
    // Ryan, 2026-08-31, building a Pick Water striper day: "The model did not answer usably:
    // Unexpected token ']', ..." }, ], "chan"... is not valid JSON". A comma before a `]`, and
    // the whole day -- the candidates, the ordering, the rigging, every number the app had
    // already computed -- was thrown away over one character that carries no meaning in JSON.
    //
    // Repairing it is not guessing at what the model meant: JSON forbids the comma outright, so
    // there is exactly one reading of the text with it removed. That is the difference between
    // this and papering over a wrong plan -- nothing here decides anything about fishing.
    //
    // It is said out loud rather than fixed in silence. `_appRepairs` rides on the parsed object,
    // reaches `problems` through planArgsFrom() and lands in the saved plan's `model.response`,
    // so an answer that keeps arriving malformed is visible rather than absorbed.
    const { text: fixed, fixes } = stripTrailingCommas(body);
    if (fixes) {
      try {
        const out = JSON.parse(fixed);
        if (out && typeof out === 'object') {
          out._appRepairs = [`the model's answer was not valid JSON — ${fixes} trailing `
            + `comma${fixes === 1 ? '' : 's'} before a ] or }, removed by the app`];
        }
        return out;
      } catch { /* not the only thing wrong with it; report the original failure */ }
    }
    throw new Error(`${first.message}${around(body, first)}`);
  }
}

/**
 * Put every lure on a rod that can actually carry it, and say what moved.
 *
 * Ryan seats the rods himself — "i am going to choose the rod and put the right bait on it" — so
 * which id a lure lands on is the app's bookkeeping, not a decision anyone is waiting on. What
 * matters is that the bookkeeping is RIGHT, because change cost is read off the rod: a snap is
 * seconds, a leader is a knot.
 *
 * Tie-only lures take leader rods. Everything else fills the snap rods first, because a snap rod
 * is the cheap one to change and the whole point of having two.
 *
 * @param {object[]} rods       [{id, lure, ...}]
 * @param {function} connOf     lureName => 'snap' | 'tie' | 'either' | null
 * @returns {{rods: object[], map: object, problems: string[]}}
 */
export function seatRods(rods, connOf) {
  const problems = [];
  // Only rods the plan actually rigs get seated. The rest keep whatever is already on them and
  // are not the plan's business.
  const need = (rods || []).filter((r) => r && r.lure).map((r) => {
    const c = connOf ? connOf(r.lure) : null;
    return { rod: r, tie: c === 'tie' };
  });

  const ties = need.filter((n) => n.tie).length;
  if (ties > FLUORO_RODS.length) {
    problems.push(`${ties} of the lures must be tied direct and there are only `
                + `${FLUORO_RODS.length} leader rods — that means cutting a snap off on the water`);
  }

  // Deterministic, not "keep what the model said where it is legal". An earlier version tried to
  // preserve the model's ids whenever they were merely legal, and that quietly defeated the whole
  // preference: a spoon on a leader rod is legal, so it stayed there, and the two snap rods sat
  // empty while every change cost a knot. Ids are interchangeable labels — the seating is what
  // has to be right.
  //
  // Ties claim leader rods first, because they have nowhere else to go. Everything else fills the
  // snap rods before spilling onto leader rods, because a snap rod is the cheap one to change and
  // that is the entire reason for having two.
  const freeFluoro = [...FLUORO_RODS], freeSnap = [...SNAP_RODS];
  const order = [...need.filter((n) => n.tie), ...need.filter((n) => !n.tie)];
  for (const n of order) {
    const pool = n.tie ? [freeFluoro] : [freeSnap, freeFluoro];
    n.seat = (pool.find((p) => p.length) || []).shift() || null;
  }

  const map = {};
  const out = need.map((n) => {
    const id = n.seat || n.rod.id;
    if (id !== n.rod.id) map[n.rod.id] = id;
    return { ...n.rod, id, rig: ROD_RIG[id] || 'fluoro' };
  });
  // Everything the plan did not rig, reported as what it is: staged, carrying whatever it was
  // carrying, with no lure this plan can name.
  const rigged = new Set(out.map((r) => r.id));
  for (const id of ROD_IDS) {
    if (!rigged.has(id)) out.push({ id, rig: ROD_RIG[id], lure: null, staged: true });
  }
  return { rods: out.sort((a, b) => ROD_IDS.indexOf(a.id) - ROD_IDS.indexOf(b.id)), map, problems };
}

/**
 * Turn the model's answer into the exact argument object `assemblePlan` takes.
 *
 * Everything the model got wrong is repaired or dropped, never guessed at, and every repair is
 * recorded in `problems` so it can be shown rather than swallowed. `assemblePlan` does the same
 * for stops and rods it cannot resolve; this is the layer above, catching what would not even
 * reach it.
 *
 * @param {object}   res         parsePlanResponse() output
 * @param {object[]} candidates  the FULL candidate objects from selectCandidates(), unordered
 * @param {object}   [ctx]       { tackle: string[], connectionOf: fn }
 */
/**
 * THE FIELDS THE MODEL SETS ON A LEG, IN ONE PLACE, BECAUSE TWO PATHS READ THEM.
 *
 * planArgsFrom() returns `candidates` — the app's candidates with the model's per-leg answers
 * merged on, IN THE MODEL'S ORDER. Smart Plan takes the whole thing, order included. Pick Water
 * cannot: the order there is Ryan's, off a map, and is not the model's to change. So it took
 * `deploy` (a runId-keyed map, order-blind) and discarded `candidates` entirely.
 *
 * That discarded the answers along with the ordering. Measured off his plan of 2026-08-31: the
 * model asked for a second pass on three of ten legs and got none, and wrote a sentence of `why`
 * for every leg and every card came out blank. Both had been computed, validated and thrown away
 * one line apart.
 *
 * Writing the three names out again in plan-from-water.js would fix today and lose the next field
 * the same way. One list, two readers, no drift.
 */
export const MODEL_LEG_FIELDS = ['why', 'speedMph', 'trollPasses', 'ifNotProducing'];

export function planArgsFrom(res, candidates, ctx = {}) {
  const problems = [];
  // Whatever parsePlanResponse() had to repair to make the answer parse at all. Reported here so
  // it reaches the screen and the saved plan by the same route as every other thing the app
  // refused or fixed, rather than living on an object nobody reads.
  for (const r of (Array.isArray(res && res._appRepairs) ? res._appRepairs : [])) problems.push(r);
  const byRun = new Map((candidates || []).map((c) => [c.runId, c]));
  const tackleNames = ctx.tackle && ctx.tackle.length ? ctx.tackle : null;

  // --- the six rods, seated on rods that can carry them ---------------------------------------
  const given = new Map();
  for (const r of ((res.loadout && res.loadout.rods) || [])) {
    if (r && ROD_IDS.includes(r.id) && !given.has(r.id)) given.set(r.id, r);
    else if (r) problems.push(`dropped rod ${JSON.stringify(r && r.id)} — the boat carries ${ROD_IDS.join(', ')}`);
  }
  // A plan that rigs two rods is a complete plan. Rods it does not name keep whatever is on them
  // and are added back by seatRods() as staged — their absence is not a problem to report.
  const claimed = ROD_IDS.filter((id) => given.has(id)).map((id) => {
    const r = given.get(id);
    const asked = str(r.lure);
    if (!asked) problems.push(`${id} is in the loadout with no lure — dropped`);
    const hit = asked && tackleNames ? resolveTackleName(asked, tackleNames) : null;
    if (asked && tackleNames && !hit) {
      problems.push(`${id}: "${asked}" is not in the tackle inventory`);
    } else if (hit && hit.tier === 'words') {
      // Reported, because this tier is a guess: it matched on shared words, not on the name.
      problems.push(`${id}: read "${asked}" as "${hit.name}" — nothing in the inventory is `
                  + 'called that, and this is the closest thing by shared words');
    }
    // The plan carries the INVENTORY's name so anything downstream that looks a lure up finds
    // it. When nothing resolves, the model's own words are kept rather than a substitute — the
    // problem above says the bag does not hold it, and swapping in a different lure would be
    // choosing his tackle for him.
    const lure = (hit && hit.name) || asked;
    return {
      id, role: r.role === 'cast' ? 'cast' : 'troll',
      lure, color: str(r.color), why: str(r.why),
      leadFt: num(r.leadFt),
      runsDepthFt: Array.isArray(r.runsDepthFt) && r.runsDepthFt.length === 2
        ? r.runsDepthFt.map(Number) : null,
    };
  });
  const seat = seatRods(claimed, ctx.connectionOf);
  problems.push(...seat.problems);
  const moved = Object.keys(seat.map);
  if (moved.length) {
    problems.push(`re-seated ${moved.map((k) => `${k}→${seat.map[k]}`).join(', ')} so every lure `
                + 'is on a rod that can carry it');
  }
  const reseat = (id) => (id && seat.map[id]) || id;
  // Only rods this plan actually rigged may be deployed, cast with, or changed. A staged rod is
  // carrying whatever it was carrying last trip, and the plan has no idea what that is — telling
  // him to "swap R3" when it never said what is on R3 is worse than saying nothing.
  const rigged = new Set(seat.rods.filter((r) => !r.staged).map((r) => r.id));
  const usable = (id, what) => {
    if (rigged.has(id)) return true;
    problems.push(`${what} refers to ${id}, which this plan never rigged — it is staged with `
                + 'whatever was already on it');
    return false;
  };

  /* ── ON A RIVER THE APP HAS ALREADY DECIDED THE SHAPE OF THE DAY ───────────────────────────────
   *
   * riverDay() in plan-candidates.js picks the reaches, the order, which side of the launch to take
   * first and where it turns him around; the assembler sets the ground speed from the baits. So
   * three of the four things this loop reads off a leg are not the model's to send on a river -- the
   * ORDER, `trollPasses` and `speedMph` -- and what is left is the rods and the sentence.
   *
   * AND SPREADING AN ABSENT FIELD IS NOT A NO-OP, WHICH IS THE BUG THIS FIXES. `{...c, trollPasses:
   * undefined}` REPLACES the app's 2 with undefined, orientLegs' laps() reads that as one pass, and
   * the river day silently loses the entire way home -- half the water fished and the cheaper half
   * of the battery. The day the app costed only survived if the model happened to echo a number it
   * had already been told.
   *
   * `c.drift` IS THE TEST, the same one selectCandidates uses for `isDrift` and the stops block
   * below uses for the same reason: a river candidate is a drift by construction, so the day answers
   * this about itself rather than being told twice.
   */
  const riverDay = (candidates || []).some((c) => c && c.drift);

  // --- the legs, in the model's order ---------------------------------------------------------
  const ordered = [];
  const deploy = {};
  // ── AND THE TWO RODS HE PICKS UP FOR THE RUN BACK ─────────────────────────────────────────────
  //
  // Ryan, 2026-09-17: *"and this dashboard doesn't tell me to switch if they aren't working or even
  // mention the other 4 rods?"*. `deploy` is keyed by runId and a river reach is fished out and back
  // under one runId, so the two rods on the way out WERE the two rods on the way back and no plan
  // could say otherwise. The only tool for changing the day was `changes`, which reties a lure on a
  // deployed rod -- the expensive move, a knot with cold wet hands -- while the cheap one, putting
  // two rods down and picking up two of the four already rigged behind the seat, could not be
  // expressed at all. Keyed by runId in its own map rather than by a compound key in `deploy`,
  // because a runId may itself contain a `#` and because every existing reader of `deploy` iterates
  // its values.
  const deployBack = {};
  const seen = new Set();
  // What the model sent on a river that the app was never going to read. Collected rather than
  // reported leg by leg, because one sentence about the day is the useful shape.
  const sentAnyway = new Set();
  for (const leg of (Array.isArray(res.legs) ? res.legs : [])) {
    const c = byRun.get(leg && leg.runId);
    if (!c) { problems.push(`no such run: ${JSON.stringify(leg && leg.runId)}`); continue; }
    if (seen.has(c.runId)) { problems.push(`${c.runId} listed twice — kept the first`); continue; }
    seen.add(c.runId);
    // HOW MANY TIMES THIS PASS GETS FISHED.
    //
    // Ryan, 2026-08-31: "its because they have no concept of running back the other direction...
    // there should be almost no deadheading there". Until this field existed the refusal above was
    // the end of the road -- a runId could appear once, so a pass could be fished once, and the
    // only way back over water that had just produced was a transit to somewhere else. It is a
    // count on the leg rather than the same runId listed twice on purpose: `deploy`, `stops` and
    // `changes` are all keyed by runId downstream, and a duplicate key would have silently taken
    // the rods, the stops and the lure changes off the second pass.
    //
    // NOT NAMED `passes`. The candidate this spreads over already has a `passes` field -- the
    // structures the run goes by, which the model reads -- and clobbering it would strip every
    // leg of its structure list on the way to the assembler.
    //
    // No ceiling is invented here. What bounds a day is the return time and the battery, both of
    // which are real, both already measured, and assemblePlan() stops adding passes at the first
    // one that would end after he is due back.
    let trollPasses;
    if (riverDay && (leg.trollPasses != null || leg.speedMph != null)) sentAnyway.add(c.runId);
    if (!riverDay && leg.trollPasses != null) {
      // NOT TRUNCATED. `Math.trunc(1.5)` is a finite 1, so rounding here would accept a request
      // for one and a half passes and fish it once without ever saying it had refused anything.
      const n = Number(leg.trollPasses);
      if (Number.isInteger(n) && n >= 1) trollPasses = n;
      else problems.push(`${c.runId} asked for ${JSON.stringify(leg.trollPasses)} trolling `
                       + 'passes — that is not a whole number of passes, so it is fished once');
    }
    // WHAT THE MODEL SAID ABOUT THIS PARTICULAR LEG, riding on the candidate into the assembler.
    // Built through MODEL_LEG_FIELDS rather than written out here, because there is a second
    // reader -- see plan-from-water.js, which wants these and not the ordering they come in.
    const d = leg.deploy || {};
    const port = reseat(str(d.port)), starboard = reseat(str(d.starboard));
    if (port && starboard && port !== starboard
        && usable(port, `${c.runId} port`) && usable(starboard, `${c.runId} starboard`)) {
      deploy[c.runId] = { port, starboard };
    } else if (port && starboard && port !== starboard) {
      // usable() already said why.
    } else {
      problems.push(`${c.runId} needs one port rod and one starboard rod, got `
                  + `${JSON.stringify(d)} — no rods deployed`);
    }

    // OPTIONAL, AND ABSENT MEANS THE SAME PAIR COMES BACK. That is the right answer on a day whose
    // light and current do not change, and it is what every plan before this field did, so silence
    // here is not a gap to report. Only a pair that is named and unusable is.
    if (riverDay) {
      const b = leg.deployBack || {};
      const bp = reseat(str(b.port)), bs = reseat(str(b.starboard));
      if (bp || bs) {
        if (bp && bs && bp !== bs
            && usable(bp, `${c.runId} port on the run back`)
            && usable(bs, `${c.runId} starboard on the run back`)) {
          deployBack[c.runId] = { port: bp, starboard: bs };
        } else if (!(bp && bs && bp !== bs)) {
          problems.push(`${c.runId} asked for a different pair on the run back and named `
                      + `${JSON.stringify(b)} — that is not one port rod and one starboard rod, so `
                      + 'the run back keeps the rods from the run out');
        }
      }
    }

    // ── AND WHAT HE DOES WHEN THE TWO IN THE WATER ARE NOT WORKING ────────────────────────────
    //
    // Ryan, 2026-09-17: *"and this dashboard doesn't tell me to switch if they aren't working or even
    // mention the other 4 rods?"* It did not, anywhere. The prompt asked for a day-level
    // `notes.adjustmentTip` -- "if nothing has hit in thirty minutes, do this" -- and NOTHING IN THE
    // CODEBASE EVER READ IT, so the one sentence that answered him was generated on every plan and
    // discarded. One sentence for a nine-hour day was the wrong grain anyway: what to try next is a
    // property of THIS water at THIS hour, which is exactly what a leg is.
    //
    // So it is per leg, it names a rod he has already rigged, and it is CHECKED: the rod coming in
    // must be one this plan rigged and must not already be in the water on this leg, and the rod
    // going out must be one of the two that is. A fallback naming a rod that is already out is not a
    // fallback, and one naming a rod carrying nothing known is worse than no sentence -- it tells him
    // to reach for whatever was on it last trip.
    //
    // NOT VALIDATED AGAINST `deployBack`. The pair on the run back may be a different two rods, and
    // the assembler stamps this only on a pass whose pair actually holds the rod being replaced -- so
    // on a leg where the plan already swapped the pair the line is simply absent rather than wrong.
    let ifNotProducing;
    const f = leg.ifNotProducing;
    const out = deploy[c.runId] || null;
    if (f && (str(f.rodId) || str(f.insteadOf))) {
      const inId = reseat(str(f.rodId)), outId = reseat(str(f.insteadOf));
      const isOut = out && (out.port === outId || out.starboard === outId);
      const alreadyIn = out && (out.port === inId || out.starboard === inId);
      if (!inId || !outId) {
        problems.push(`${c.runId} says what to try if nothing produces but names `
                    + `${JSON.stringify(f)} — that needs a rod to put on and the rod it replaces`);
      } else if (alreadyIn) {
        problems.push(`${c.runId} says to try ${inId} if nothing produces, and ${inId} is already in `
                    + 'the water on that leg — dropped, because that is not a change of anything');
      } else if (!isOut) {
        problems.push(`${c.runId} says to swap ${outId} out if nothing produces, and ${outId} is not `
                    + 'one of the two rods it deploys there — dropped');
      } else if (usable(inId, `the fallback rod on ${c.runId}`)) {
        ifNotProducing = { rodId: inId, insteadOf: outId, why: str(f.why) };
      }
    }

    // WHAT THE MODEL SAID ABOUT THIS PARTICULAR LEG, riding on the candidate into the assembler.
    // Built through MODEL_LEG_FIELDS rather than written out here, because there is a second
    // reader -- see plan-from-water.js, which wants these and not the ordering they come in.
    //
    // BELOW THE DEPLOY BLOCK SINCE 2026-09-18, because `ifNotProducing` is checked against the two
    // rods this leg puts in the water and there is no way to check that before they are known.
    const answer = { why: str(leg.why), ifNotProducing };
    if (!riverDay) {
      answer.speedMph = num(leg.speedMph) ?? undefined;
      answer.trollPasses = trollPasses;
      for (const k of MODEL_LEG_FIELDS) if (!(k in answer)) answer[k] = undefined;
    }
    ordered.push({ ...c, ...answer });
  }
  if (!ordered.length) problems.push('the model chose no legs the app recognised');

  // ── PUT A RIVER DAY BACK IN THE APP'S ORDER, AND PUT BACK WHAT WAS LEFT OUT ──────────────────
  //
  // Checked AFTER the "no legs at all" line above, so a river day where nothing came back still
  // reports that rather than looking complete because the app refilled it.
  //
  // A REACH THE MODEL DID NOT RIG IS KEPT, WITH NOTHING IN THE WATER, and assemblePlan says so --
  // "A LEG WITH NOTHING IN THE WATER IS SAID OUT LOUD. IT IS NOT FILLED IN." Dropping it instead
  // would quietly shorten the day the battery and the clock were spent on, and shortening a day is
  // exactly the decision the app made on his behalf and can therefore be held to.
  if (riverDay && ordered.length) {
    const got = new Map(ordered.map((c) => [c.runId, c]));
    const inOrder = [];
    for (const c of (candidates || [])) {
      const hit = got.get(c.runId);
      if (hit) { inOrder.push(hit); continue; }
      problems.push(`${c.runId} is part of the day the app drew and came back with no rods — kept `
                  + 'in the plan with nothing in the water rather than dropped from it');
      inOrder.push({ ...c });
    }
    if (ordered.map((c) => c.runId).join('|') !== inOrder.map((c) => c.runId).join('|')) {
      problems.push('the river legs came back in a different order, or short — a river day is one '
                  + 'path through the launch and the app chose that path, so the order it handed '
                  + 'over is the order kept');
    }
    ordered.length = 0;
    for (const c of inOrder) ordered.push(c);
  }
  if (sentAnyway.size) {
    problems.push(`ignored a speed or a pass count on ${[...sentAnyway].join(', ')} — on a river `
                + 'the app sets both: the reaches are trolled out and fished back, and the ground '
                + 'speed comes from the baits and the current, once each way');
  }

  // --- stops and changes ----------------------------------------------------------------------
  // Only shape is checked here. Whether a structure id exists on its leg is assemblePlan's job,
  // because that is where the leg's own pass list lives.
  // TAKE THE STRUCTURE REFERENCE FROM EITHER FIELD.
  //
  // 2026-08-08. Ryan: the plan "only gave 1 spot to stop and cast". The shape block asked for a
  // field called `structureId`, and the candidate data the model reads ALSO has a field called
  // `structureId` — the lake's own name for the feature, `hump_7`. So the model copied the
  // obvious one, assemblePlan looked it up in a map keyed on `id`, missed, and dropped the stop
  // into a collapsed warnings block. The stops that survived were the ones on timber, attractors
  // and docks, because those carry `structureId: null` and the model had nothing to copy but
  // `id`. Hence exactly one stop, on the unnamed feature.
  //
  // The shape block now says `id`. This accepts either, because a prompt is a request and a
  // parser should not lose a day's fishing over which of two field names a model reached for.
  //
  // AND A RIVER DAY HAS NO STOPS AT ALL, whatever the model returns. Ryan, 2026-09-17: "i do not
  // typically anchor in a river so stop and cast really isn't going to be a thing... i am not going
  // to try and hover with either the trolling motor or the pedals." Rule 4 says so and the shape
  // block asks for an empty array, and a rule stated in a prompt is a request — the 2026-09-17
  // Congaree bench came back with a stop that told him to "use a brush gripper to tie off silently
  // to nearby shoreline timber" in a river, which is a boat swinging on a branch in current.
  //
  // `c.drift` IS THE TEST, the same one selectCandidates uses for `isDrift` and for the whole
  // fished-back price. A river candidate is a drift by construction and a lake candidate is a
  // contour lane, so the day answers this about itself rather than being told twice.
  const stops = (Array.isArray(res.stops) ? res.stops : []).filter((s) => {
    if (riverDay) {
      problems.push('dropped a stop-and-cast: this is a river and the boat cannot be held on a '
                  + `spot — ${str(s && s.why) || JSON.stringify(s)}`);
      return false;
    }
    if (s && str(s.runId) && (str(s.id) || str(s.structureId))) return true;
    problems.push(`dropped a stop with no runId or structure reference: ${JSON.stringify(s)}`);
    return false;
  }).map((s) => ({
    runId: s.runId, structureId: str(s.id) || str(s.structureId),
    rods: Array.isArray(s.rods)
      ? s.rods.map(reseat).filter((x) => ROD_IDS.includes(x) && usable(x, `a stop on ${s.runId}`))
      : [],
    durationMin: num(s.durationMin) ?? 15,
    why: str(s.why), presentation: str(s.presentation), positioning: str(s.positioning),
  }));

  const changes = (Array.isArray(res.changes) ? res.changes : []).filter((c) => {
    if (!(c && str(c.beforeRunId) && str(c.rodId) && str(c.to))) {
      problems.push(`dropped an incomplete lure change: ${JSON.stringify(c)}`);
      return false;
    }
    return usable(reseat(str(c.rodId)), `a lure change before ${c.beforeRunId}`);
  }).map((c) => {
    // A change ties on a lure too, and this was never checked against the bag at all.
    const asked = str(c.to);
    const hit = tackleNames ? resolveTackleName(asked, tackleNames) : null;
    if (asked && tackleNames && !hit) {
      problems.push(`a lure change on ${reseat(str(c.rodId))} ties on "${asked}", which is not `
                  + 'in the tackle inventory');
    }
    // ── WHICH PASS, WHICH IS HOW A CHANGE GETS A TIME ─────────────────────────────────────────
    //
    // A river reach is fished twice and both passes carry the SAME `runId`, so `beforeRunId` alone
    // could only ever mean "before the run out" -- the assembler gated changes on the first visit
    // for exactly that reason. That made a swap at the turnaround structurally impossible, which is
    // most of why every river plan rigged one pair of baits for nine hours: the app had nowhere to
    // put a second one. Absent, out of range, or on a leg fished once, it is 1 and the behaviour is
    // the behaviour every plan before this one had.
    const onPass = num(c.pass);
    if (c.pass != null && onPass !== 1 && onPass !== 2) {
      problems.push(`a lure change on ${reseat(str(c.rodId))} names pass ${JSON.stringify(c.pass)}, `
                  + 'which is not a pass -- placed on the first pass instead');
    }
    return {
      beforeRunId: c.beforeRunId, rodId: reseat(c.rodId),
      pass: onPass === 2 ? 2 : 1,
      to: (hit && hit.name) || asked, why: str(c.why),
    };
  });

  const safety = res.safety || {};
  return {
    candidates: ordered,
    loadout: { why: str(res.loadout && res.loadout.why), rods: seat.rods },
    deploy, deployBack, stops, changes,
    safety: {
      isGo: safety.isGo !== false,
      warning: str(safety.warning) || '',
      rampEvaluation: str(safety.rampEvaluation) || '',
    },
    notes: res.notes && typeof res.notes === 'object' ? res.notes : {},
    problems,
  };
}
