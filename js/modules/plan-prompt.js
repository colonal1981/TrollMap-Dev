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
 * @param {object[]} [o.hazards]     for the safety note; stops are refused by id regardless
 * @param {string}   [o.intel]       species / research / catch-history prose the app already has
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

THE WATER YOU MAY FISH
Each candidate is a stretch of a real trolling run, already filtered to water he can reach and
depths that matter today, and ranked by what it passes. \`structures\` lists what each leg goes by
in the order you meet them, with \`atM\` metres from the start of that leg.

${JSON.stringify(o.candidates || [])}

RULES THAT ARE NOT NEGOTIABLE
1. Name legs by \`runId\` and stops by a structure \`id\`, both copied exactly from the list above.
   Anything invented is thrown away and the plan comes up short.
2. NEVER write a latitude, a longitude, or a place name of your own. The app owns every position.
3. Order the legs so the day flows. There is no "out and back" — if you finish near the ramp it
   is because you ordered it that way. Deadheading costs half again as much battery per mile as
   trolling, so wandering is expensive.
4. A stop is a pause ON a leg, not instead of one. Stop where the structure is better cast at
   than trolled over — a hump crown, a dock line, a creek mouth, a laydown. Judge every leg's
   structures on their own merits: a day that passes a dozen castable features and stops at one
   of them has ignored the water the app just handed you. Do not pad the list to hit a number
   either. Stop at what earns it, leg by leg, and the count will take care of itself.
5. \`depthFt\` on a structure is that structure's own depth — size the presentation from it. Where
   it is null the pipeline has no depth for that kind of feature; say so rather than guessing.
6. Two rods in the water per leg. Exactly one port, one starboard.

SAFETY — judge it honestly for a 12.5 ft kayak
Sustained wind over 15 mph, or gusts over 20, is a no-go. Judge ${o.ramp || 'the ramp'} against the
wind direction: is it a dangerous windward launch?${o.hazards && o.hazards.length
  ? `\nThere are ${o.hazards.length} marked hazard zones on this water; keep clear of them.` : ''}
${o.intel ? `\nWHAT IS ALREADY KNOWN\n${o.intel}\n` : ''}
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
  const tackle = ctx.tackle && ctx.tackle.length ? new Set(ctx.tackle) : null;

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
    const lure = str(r.lure);
    if (!lure) problems.push(`${id} is in the loadout with no lure — dropped`);
    if (lure && tackle && !tackle.has(lure)) problems.push(`${id}: "${lure}" is not in the tackle inventory`);
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
  }).map((c) => ({ beforeRunId: c.beforeRunId, rodId: reseat(c.rodId), to: c.to, why: str(c.why) }));

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
