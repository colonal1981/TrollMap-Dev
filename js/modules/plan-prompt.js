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
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

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
  if (t.currentType || t.currentKn != null) {
    L.push(`Current: ${[t.currentType, t.currentKn != null ? `${Math.abs(t.currentKn).toFixed(1)} kn` : '']
      .filter(Boolean).join(' ')}. THE TIDE IS THE CURRENT here — there is no spot-lock, so every `
      + 'stop is pedal work against moving water and you must say which way it is running.');
  }
  if (t.surgeVsPredictedFt != null) {
    L.push(`Observed water is ${t.surgeVsPredictedFt > 0 ? '+' : '−'}`
      + `${Math.abs(t.surgeVsPredictedFt).toFixed(1)} ft against the prediction. A foot of surge `
      + 'is not a rounding error on a two-foot tide.');
  }
  if (t.salinityPpt != null) L.push(`Salinity ${t.salinityPpt} ppt at the gauge.`);
  else if (t.conductanceUsCm != null) L.push(`Conductance ${t.conductanceUsCm} µS/cm at the gauge.`);
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
export function riverPromptBlock(ws) {
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
  const isRiver = String((ws && ws.featureType) || '') === 'river';
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
 * @param {string}   o.water
 * @param {string}   o.ramp
 * @param {string}   o.date
 * @param {string}   o.launchTime    "06:00"
 * @param {string}   o.returnTime    "15:00"
 * @param {string[]} o.species
 * @param {object}   o.conditions    whatever the app already gathered — passed as JSON, verbatim
 * @param {string[]} o.tackle        exact lure names the model may use
 * @param {string[]} [o.snapEligible] the subset of those that may hang off a swivel snap
 * @param {number}   [o.usableAh]
 * @param {string[]} [o.hazards]     what is in the way, as sentences that name their own source.
 *                                   chartedHazards() reads the pack's POI layer in two tiers,
 *                                   CANNOT ENTER and AVOID, on Ryan's measured classification —
 *                                   see EVERY_POI_TYPE_ON_THE_CARD_2026-08-27. researchHazards()
 *                                   adds the profile's unpositioned prose. The note keeps them
 *                                   apart, because a dam and a paragraph are not the same claim.
 * @param {string}   [o.intel]       species / research / catch-history prose the app already has
 * @param {object}   [o.waterState]  fetchWaterState() output — {featureType, river, tidal}.
 *                                   NOT absent on a reservoir: an impoundment with an inflow
 *                                   gauge or a generating dam carries `river` too, which is why
 *                                   riverPromptBlock() reads `featureType` and not the mere
 *                                   presence of the object. Absent is the same prompt as before.
 */
export function buildPlanRequest(o) {
  const day = {
    water: o.water, ramp: o.ramp, date: o.date,
    launchTime: o.launchTime, returnTime: o.returnTime,
    species: o.species || [],
    usableAh: o.usableAh ?? null,
    conditions: o.conditions || {},
  };
  const snapSet = new Set(o.snapEligible || []);
  const tieOnly = (o.tackle || []).filter((n) => !snapSet.has(n));

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
${[...snapSet].join(', ') || '(unknown — treat everything as tie-only)'}

MUST BE TIED DIRECT (leader rods only):
${tieOnly.join(', ') || '(none)'}

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
${(o.tackle || []).join(', ') || '(inventory unavailable)'}

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

WHAT THE ORDER COSTS. Each candidate also carries \`transitToM\` — metres of deadhead from the END
of that leg to the START of every other leg — \`transitFromRampM\` from the ramp to its start, and
\`transitToRampM\` from its end back to the ramp. Those are the only numbers that change when you
reorder the day, and they are yours to spend: the app computes the legs, you choose the sequence.

${JSON.stringify(o.candidates || [])}
${o.waterIsChosen ? `
THE FISHERMAN ALREADY CHOSE THIS WATER AND THIS ORDER.
He picked these stretches himself, off a map, with the reasons for and against in front of him —
they are in \`whyThisWater\` on each one, computed from the chart, not written by you. Do not
re-rank them, do not suggest better water, and do not reorder the day. The list above IS the day,
first to last.

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
3. ${o.orderIsChosen
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
4. A stop is a pause ON a leg, not instead of one. Stop where the structure is better cast at
   than trolled over — a hump crown, a dock line, a creek mouth, a laydown — and only ever on a
   structure carrying \`worthFishing: true\`. Judge every leg's structures on their own merits: a
   day that passes a dozen castable features and stops at one of them has ignored the water the
   app just handed you. Do not pad the list to hit a number either. Stop at what earns it, leg by
   leg, and the count will take care of itself.
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
   \`maxRunDepthFt\` is a CEILING and nothing else. It is the SHALLOWEST water anywhere on that
   leg, measured within the boat's wander, and it exists for one purpose — so a bait does not drag
   on a rise you cannot see. A leg reading 25-31 ft of water with \`maxRunDepthFt: 20\` has a 20 ft
   shoal somewhere along it, so a bait running 26 ft hangs up there on every pass. It is a number
   you must stay ABOVE. It is not a number to aim at, and a low one never means "skip this leg".
   FISH LOOK UP, so the error is not symmetric and this is why the ceiling is safe to obey. A bait
   running ABOVE the fish still gets eaten — they come up to it. A bait running BELOW them is
   behind them and out of sight, and one dragging bottom is fouled. So when the ceiling forces you
   shallower than the band, take it and do not apologise for it: shallow is the cheap direction to
   be wrong in, deep is the expensive one.
   So, per leg: pick the depth from the fish, then check it against the ceiling. If the ceiling is
   shallower than the band, fish the ceiling. Shorten the lead or take a shallower bait; never
   raise the ceiling, and never leave the rods out of the water.

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
${coastalPromptBlock(o.waterState)}${riverPromptBlock(o.waterState)}
WHAT IS ALREADY KNOWN
${o.intel || 'NOTHING. No researched profile exists for this water, so everything else here rests '
  + 'on the chart, the gauges and general species knowledge. Say so in the plan rather than '
  + 'writing as though this water had been studied — an absent profile is not a profile that '
  + 'looked and found nothing.'}

RETURN EXACTLY THIS SHAPE
{
  "safety": { "isGo": true, "warning": "", "rampEvaluation": "one sentence on wind exposure at this ramp" },
  "loadout": {
    "why": "how these six cover the day's depth bands",
    "rods": [
      { "id": "R1", "lure": "exact name from the list", "color": "free text",
        "role": "troll" or "cast", "leadFt": 95, "runsDepthFt": [22, 28],
        "why": "one sentence" }
      // Only the rods this plan uses — two is a complete answer. Put tie-only lures on
      // ${FLUORO_RODS.join('/')} and snap-friendly ones on ${SNAP_RODS.join('/')} where you can.
    ]
  },
  "legs": [
    { "runId": "copied exactly", "speedMph": 2.0,
      "deploy": { "port": "R1", "starboard": "R5" },
      "why": "one sentence on why this water, now" }
  ],
  "stops": [
    { "runId": "copied exactly", "id": "that structure's \`id\`, copied exactly",
      "rods": ["R6"], "durationMin": 15,
      "why": "why this is worth stopping for rather than trolling over",
      "presentation": "how to work it",
      "positioning": "how to hold the boat there, given no spot-lock" }
    // ONE ENTRY PER STRUCTURE WORTH STOPPING AT, across the whole day. Several is normal; one
    // for a whole day almost never is. Copy \`id\` — NOT \`structureId\`, which is the lake's own
    // name for the feature and is there to be read, not returned.
  ],
  "changes": [
    { "beforeRunId": "copied exactly", "rodId": "R5", "to": "exact name from the list",
      "why": "what changed to make this worth the swap" }
  ],
  "notes": {
    "structureFocus": "the sonar signature to look for",
    "adjustmentTip": "if nothing has hit in thirty minutes, do this",
    "scoutNotes": "two or three sentences of tactical overview",
    "fishfinderNarrative": "about 150 words on what the sonar should show along these legs and how to work what is rigged"
  }
}`;

  return { system, user };
}

/**
 * Pull the JSON object out of whatever the provider returned.
 * Kept in the spirit of the extraction smart-plan.js already used against /groq-query, because
 * that path has survived several providers and their various ideas about code fences.
 */
export function parsePlanResponse(text) {
  const raw = String(text || '').replace(/```json|```/g, '').trim();
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a === -1 || b === -1 || b <= a) throw new Error(`no JSON object in response: ${raw.slice(0, 200)}`);
  return JSON.parse(raw.slice(a, b + 1));
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
export function planArgsFrom(res, candidates, ctx = {}) {
  const problems = [];
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

  // --- the legs, in the model's order ---------------------------------------------------------
  const ordered = [];
  const deploy = {};
  const seen = new Set();
  for (const leg of (Array.isArray(res.legs) ? res.legs : [])) {
    const c = byRun.get(leg && leg.runId);
    if (!c) { problems.push(`no such run: ${JSON.stringify(leg && leg.runId)}`); continue; }
    if (seen.has(c.runId)) { problems.push(`${c.runId} listed twice — kept the first`); continue; }
    seen.add(c.runId);
    // `why` and `speedMph` are the model's, and ride on the candidate into the assembler.
    ordered.push({ ...c, why: str(leg.why), speedMph: num(leg.speedMph) ?? undefined });

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
  }
  if (!ordered.length) problems.push('the model chose no legs the app recognised');

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
  const stops = (Array.isArray(res.stops) ? res.stops : []).filter((s) => {
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
    return {
      beforeRunId: c.beforeRunId, rodId: reseat(c.rodId),
      to: (hit && hit.name) || asked, why: str(c.why),
    };
  });

  const safety = res.safety || {};
  return {
    candidates: ordered,
    loadout: { why: str(res.loadout && res.loadout.why), rods: seat.rods },
    deploy, stops, changes,
    safety: {
      isGo: safety.isGo !== false,
      warning: str(safety.warning) || '',
      rampEvaluation: str(safety.rampEvaluation) || '',
    },
    notes: res.notes && typeof res.notes === 'object' ? res.notes : {},
    problems,
  };
}
