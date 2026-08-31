/**
 * plan-to-timeline.js — a v2 plan, in the shape the rest of the Plan tab already reads.
 *
 * WHY THIS EXISTS
 * ---------------
 * 2026-08-08. Ryan on the first v2 plan he ran: "you bolted this thing on, didn't replace the old
 * version, it looks visually different in smart plan doesn't work with the json, html or preview
 * buttons... it is pretty much an after thought and worse than what i had before by a lot."
 *
 * Preview, Print, ⬇JSON and ⬇HTML never read v2's markup — they read `collectPlan()`, and
 * `collectPlan()` reads `window._smartPlanTimeline`. So the plan is converted here into the one
 * shape the tab already understands, and drawn by the renderer that draws everything else.
 *
 * WHAT CHANGED ON 2026-08-09, AND WHY
 * -----------------------------------
 * The first version of this file walked `plan.legs` and keyed everything on time. PLAN_SCHEMA_V2
 * says the opposite twice:
 *
 *   "THE PLAN IS INDEXED BY DISTANCE, NOT TIME"
 *   "planCues(plan) — every stop and change in the order the boat meets them, keyed on distance
 *    along the day. The timeline and the phone's notifications read this, not the legs directly."
 *
 * Ryan's reason for the rule: "every time i catch a fish i am going to slow down or stop
 * completely so more like it needs to be a distance from thing not a time to thing." The clock
 * starts drifting the moment he hooks a fish and never catches up.
 *
 * The old adapter computed the spine correctly upstream and then deleted it at this boundary. Not
 * one metre value survived into the timeline, the exported JSON or the HTML. What DID survive was
 * `routeContext.etaMin` — and it was not even the stop's own position, it was the whole leg's
 * `estDurationMin` copied onto every stop on that leg, so two stops three kilometres apart
 * carried the same number and the cards read "~45min in" for both.
 *
 * So this version:
 *
 *   - takes stop and change order, and every absolute `atM`, from `planCues(plan)`;
 *   - puts `atM` and `legId` on EVERY entry, and sorts on `atM` and nothing else;
 *   - emits `changes` as entries. A day with three lure swaps used to ship as a day with none:
 *     the change objects were built correctly by the assembler and then dropped here;
 *   - carries `parentLegId` on a stop, and `stopIds` on its leg, because a stop is a pause
 *     INSIDE a leg. The array is a render ORDER, not a claim that a stop is a peer of a leg;
 *   - numbers `step` on LEGS ONLY. A stop keeps the schema's own `S<leg>.<n>` identity and is
 *     never renumbered into a flat sequence;
 *   - names every time-shaped field `est*`. The prefix exists so no code can treat an estimate
 *     as authoritative without the name arguing back, and that protection was being lost one hop
 *     downstream the moment `estDurationMin` was copied into a key called `etaMin`.
 *
 * WHAT READS WHAT (measured, not assumed)
 * ---------------------------------------
 *   plan-builder.js:121   collectPlan()          <- window._smartPlanTimeline
 *   plan-builder.js:445   buildPlanPreviewHtml() <- p.timeline
 *   plan-builder.js:231   castingStops           <- window._smartPlanStopCandidates
 *   plan-builder.js:264   p.routeRods            <- window._smartPlanRouteRods
 *   plan-builder.js:329   p.rationale            <- window._smartPlanRationale
 *   plan-builder.js:114   p.trolling.phaseSpeeds <- window._smartPlanPhaseRoutes
 *   smart-plan-ui.js:534  the timeline cards     <- the `unified` argument
 *
 * `_groqPlanTimeline` must be cleared. plan-builder.js:194 falls back to it when the unified
 * timeline is empty and assigns the raw generator timeline straight through — entries with no
 * `step`, no `key`, and `speed` where `speedMph` is expected. A stale one from a v1 run in the
 * same session would quietly render instead of this.
 *
 * Pure. No DOM, no window. The caller installs the result — see smart-plan-v2-wiring.js.
 */

import { planCues } from './plan-assemble.js';
import { ozLabel } from '../utils/oz.js';

// THE MAP AND THE CARD SHARE ONE PALETTE, and this is where it lives.
//
// Ryan, 2026-08-09: "the 2 routes and the transits need to be in different colors... i can't
// tell what is what." On the map they were all the same magenta, because map-init.js coloured a
// track by matching its NAME against v1's phase names ("Phase 1 Dawn") and every v2 track is
// called `L1 · 22.4 ft` or `T2 · transit`, so all of them fell through to the default. On the
// card stack they already had these colours. Exporting them is what lets a line on the water and
// a card on the screen be the same colour, which is the whole of what he asked for.
/**
 * ONE COLOUR PER TROLL LEG, AND CONSECUTIVE LEGS MUST NOT BE THE SAME COLOUR FAMILY.
 *
 * 36dbb56 gave every leg its own entry from this list and that was necessary, not sufficient.
 * The list it gave them was `#00e5ff, #00bcd4, #ffb300, #ff9800, ...` — cyan then a darker cyan,
 * amber then a slightly redder amber. A two-leg day therefore drew two cyan lines, which are two
 * different hex values and one colour to the eye at 2.5 px on a chart in daylight. Ryan,
 * 2026-08-09, after 36dbb56 shipped: "the 2 trolling lanes themselves need to be different colors
 * from each other."
 *
 * So the ORDER is the fix, not the count. The six hues below are spread around the wheel and then
 * sequenced so that every consecutive pair is at least 75 degrees of hue apart — legs 1 and 2 are
 * 160 degrees apart, which is as far as two colours get. The near-twins that caused this are
 * gone. Positions 5 and 6 exist so a long day does not wrap early; a plan has never had more than
 * three troll legs.
 *
 * The 75-degree floor IS A JUDGEMENT AND NOT A MEASUREMENT. Nothing tested how far apart two
 * lines have to be to read as different on the water; 75 is simply comfortably past the 10 and 30
 * degrees that produced the complaint, and it is asserted in plan-tracks.test.js so a future
 * addition to this list cannot quietly reintroduce a twin.
 *
 *   1 cyan   2 orange   3 violet   4 green   5 pink   6 yellow
 */
export const LEG_COLORS = ['#00e5ff', '#ff6d00', '#7c4dff', '#76ff03', '#ff4081', '#ffea00'];
/** A deadhead: grey, because nothing is in the water and it should recede. */
export const TRANSIT_COLOR = '#78909c';
/** The run home: its own colour, and not one the leg cycle reaches in a normal day. */
export const RETURN_COLOR = '#00e676';
const CHANGE_COLOR = '#ffd54f';

const M_PER_MILE = 1609.34;

const miles = (m) => (Number(m) || 0) / M_PER_MILE;
const clean = (s) => (s == null ? '' : String(s));

/** "1.24 mi" — how far into the day this is. The only sort key, and the only cue the phone needs. */
export function markMi(atM) {
  return `${miles(atM).toFixed(2)} mi`;
}

/**
 * Rod ids to the display shape `rodSlotHtml()` and the preview both read.
 *
 * `side` is what the preview prints, and it is positional in the card renderer: rods[0] is the
 * port slot and rods[1] starboard, regardless of what `side` says. So the ORDER here matters more
 * than the label does.
 */
function rodView(rod, side, over) {
  if (!rod) return null;
  // `over` is leg.rodPlan[id] -- what capBaitDepth had to change FOR THIS LEG. It used to write
  // straight into the rod, and the rod is one object shared by every leg through `rodsById`
  // below, so the shallowest leg of the day set the lead for all of them. Ryan's 2026-08-30
  // Wateree plan: leg 2 is the 6 ft line and correctly shortened the fluke to 24 ft; legs 1 and 3
  // are the 24 ft line with the fish at 15-27 ft and inherited it.
  const leadFt = over && over.leadFt != null ? over.leadFt : rod.leadFt;
  const runs = (over && over.runsDepthFt) || rod.runsDepthFt;
  // THE HEAD THE PLAN FITTED. Ryan, 2026-08-30: "for the jig head with a 4.6in swimbait... what
  // weight jig head is it using for the lead, speed, and depth calculations?" It was 1oz by
  // accident and this field was an empty string on every row of every plan, so there was nowhere
  // to look it up. capBaitDepth() picks the head now; this is where it becomes readable.
  const head = over && over.jigheadOz != null ? ozLabel(over.jigheadOz) : '';
  return {
    side,
    rod: rod.id || '',
    lure: clean(rod.lure),
    color: clean(rod.color),
    lead: leadFt ?? '',
    depth: Array.isArray(runs) ? runs.join('–') : '',
    reel: '',
    trailerSize: '', arigWeight: '', jigWeight: head,
    notes: clean(rod.why),
  };
}

/**
 * One v2 plan -> everything the Plan tab's export path needs.
 *
 * @param {object} plan          from assemblePlan()
 * @param {object} [o]
 * @param {number[]} [o.depthBand] [min, max] ft the species is using, for the depth column
 * @param {string}  [o.rationale] the scout narrative
 * @returns {{timeline, routeRods, routeSpeeds, phaseRoutes, castRods, stopCandidates, rationale, cards}}
 */
export function planToTimeline(plan, o = {}) {
  const empty = { timeline: [], routeRods: {}, routeSpeeds: {}, phaseRoutes: [],
                  castRods: [], stopCandidates: [], rationale: '', cards: [] };
  if (!plan || !Array.isArray(plan.legs)) return empty;

  const rodsById = new Map(((plan.loadout && plan.loadout.rods) || []).map((r) => [r.id, r]));
  const band = Array.isArray(o.depthBand) && o.depthBand.length === 2 ? o.depthBand : null;
  // WHAT THE FISH ARE DOING, and WHAT THE APP ALREADY KNOWS IS WRONG WITH THIS LEG.
  //
  // The band alone does not tell a reader whether 15-27 ft is a column to fish or a bottom to
  // follow -- that is `holding`, and the card never had it. And assemblePlan's warnings went to
  // `console.warn` on the Pick Water path (plan-water-ui.js:884) and NOWHERE ELSE, so "R1 on
  // wateree_lake#362: a DD3 Crankbait (20-25ft) runs to 25 ft and the shallowest water on this
  // leg is 6 ft ... it is the wrong bait for this pass" fired three times into a console while
  // the card drew a confident spread. The app was not blind, it was mute.
  const holding = o.holding || null;
  const legWarnings = Array.isArray(o.warnings) ? o.warnings : [];

  const routeRods = {};
  const routeSpeeds = {};
  const phaseRoutes = [];
  const cards = [];
  const stopCandidates = [];

  // Legs first, keyed by their own start on the day's spine. `step` counts legs and only legs.
  const legEntries = [];
  const legById = new Map();
  let trollN = 0;

  for (const leg of plan.legs) {
    const key = leg.id;                                   // 'L3' / 'T2' — unique by construction
    const mi = miles(leg.lengthM);
    const mark = markMi(leg.startM);
    legById.set(leg.id, leg);

    const common = {
      key, legId: leg.id, legType: leg.type,
      atM: leg.startM, startM: leg.startM, lengthM: leg.lengthM,
      endM: leg.startM + leg.lengthM,
      estDurationMin: leg.estDurationMin, estStartTime: leg.estStartTime || null,
      stats: { distMi: mi.toFixed(1), estTimeMin: leg.estDurationMin },
      stopIds: (leg.stops || []).map((s) => s.id),
    };

    if (leg.type === 'transit') {
      // TRANSIT IS SHOWN, NOT SWALLOWED. Ryan, on the one part of v2 he did like: "i pretty much
      // hate all of it except the return leg." A run between legs is real time, real battery and
      // real distance, and hiding it is how a plan starts lying about the day.
      //
      // It rides in as a `troll` entry because the preview branches `if (e.type === 'troll')` and
      // renders anything else as a stop row (plan-builder.js:448). `legType` says what it really
      // is, and BOTH renderers now branch on it.
      //
      // 2026-08-09, off the water. They did not, and the card read:
      //
      //     ➡️ TROLL — Run — 0.8 mi
      //     Target Depth —
      //     Spread / Leads   Port —ft · Stbd —ft
      //     🔵 Port — no lure assigned
      //     🔴 Stbd — no lure assigned
      //
      // Ryan: "if this is the leg to get to the start of the first troll run it doesn't need this
      // information." Four fields, every one of them a dash, describing a spread that does not
      // exist — under a heading that calls a deadhead a troll. `unrouted` comes along so the card
      // can say when the line is straight because the router would not answer.
      // The run home is a transit like any other, and it is also the one he asked for by name,
      // so it is labelled as itself: "1.7 mi to the ramp", not the third "Run 1.7 mi" on the card
      // stack. `role` rides along for the renderer's heading and for the map's colour.
      const home = leg.role === 'return';
      const card = {
        ...common,
        label: home ? `${mi.toFixed(1)} mi to the ramp` : `Run ${mi.toFixed(1)} mi`,
        shortLabel: home ? `Home ${mi.toFixed(1)}mi` : `Run ${mi.toFixed(1)}mi`,
        role: leg.role || null,
        unrouted: !!leg.unrouted,
        icon: home ? '🏁' : '➡️', color: home ? RETURN_COLOR : TRANSIT_COLOR,
        desc: `From ${mark} in · ${home ? 'back to the launch' : 'deadhead'} at ${leg.speedMph} mph`
            + ` · ${leg.batteryAh} Ah · est ${leg.estDurationMin} min`,
        longDesc: leg.unrouted
          ? (home ? 'THE ROUTE HOME IS A STRAIGHT LINE — not water-routed, do not follow it'
                  : 'Moving between legs — STRAIGHT LINE, not water-routed')
          : (home ? 'The run back to the ramp, nothing in the water'
                  : 'Moving between legs, nothing in the water'),
        speedMph: leg.speedMph,
      };
      cards.push(card);
      routeSpeeds[key] = leg.speedMph;
      legEntries.push({
        ...card, type: 'troll', rods: [],
        depthMin: null, depthMax: null,
        port: '', starboard: '', portColor: '', starboardColor: '',
        portLeadFt: '', starboardLeadFt: '',
        why: card.longDesc, phaseName: card.label,
      });
      continue;
    }

    trollN += 1;
    const port = rodsById.get(leg.deploy && leg.deploy.port);
    const stbd = rodsById.get(leg.deploy && leg.deploy.starboard);
    const rp = leg.rodPlan || {};
    const rods = [rodView(port, 'Port', rp[leg.deploy && leg.deploy.port]),
                  rodView(stbd, 'Stbd', rp[leg.deploy && leg.deploy.starboard])].filter(Boolean);

    // WHAT IS UNDER THE BOAT, NOT WHAT THE CONTOUR IS CALLED.
    //
    // This said "The 26.9 ft line", and Ryan took the fitted lanes apart to show why that is a
    // lie: measured on Wateree they sit a median 29-51 m off the contour they are named for, and
    // up to 224 m. Told the fitting is deliberate — a traced contour makes "very short very curved
    // and unfollowable lines" — he wrote the replacement himself:
    //
    //   > your second thought is more honest... it runs from 25-32 ft median 29 shallowest is
    //   > 25ft deepest is 32 allows me to know that the lure depth that is chosen is right or wrong
    //
    // So the sentence is the range and the middle of it. The species band stays in the depth
    // column under its own name; these two are never the same number and never share a label.
    const waterPhrase = (leg.depthMinFt != null && leg.depthMaxFt != null)
      ? (leg.depthMinFt === leg.depthMaxFt
          ? `${leg.depthMinFt} ft under the boat`
          : `${leg.depthMinFt}–${leg.depthMaxFt} ft under the boat · median ${leg.depthFt}`)
      : (leg.depthFt != null ? `${leg.depthFt} ft under the boat` : '');
    // SAY WHEN IT IS THE SAME WATER AGAIN. A leg fished back is its own leg — its own id, its own
    // track, its own minutes — so on a timeline it would otherwise read as a second stretch that
    // happens to be the same length and depth as the one above it. Even passes run the opposite
    // direction to the first, so "fished back" is literally what they are.
    const again = leg.pass > 1
      ? (leg.pass % 2 === 0 ? ' · fished back' : ` · pass ${leg.pass}`)
      : '';
    const samePhrase = leg.pass > 1 ? `same water as Leg ${trollN - 1}, the other way · ` : '';
    const card = {
      ...common,
      label: `Leg ${trollN} — ${mi.toFixed(1)} mi${again}`,
      shortLabel: leg.pass > 1 ? `Leg ${trollN}${leg.pass % 2 === 0 ? ' back' : ` p${leg.pass}`}`
                               : `Leg ${trollN}`,
      icon: '🎣', color: LEG_COLORS[(trollN - 1) % LEG_COLORS.length],
      desc: samePhrase + (waterPhrase ? `${waterPhrase} · ` : '')
          + `from ${mark} in · ${leg.speedMph} mph · ${leg.batteryAh} Ah`,
      longDesc: clean(leg.why),
      speedMph: leg.speedMph,
      // Carried so every reader downstream can tell a second pass from a second stretch without
      // re-deriving it from a repeated runId.
      pass: leg.pass, ofPasses: leg.ofPasses,
    };
    cards.push(card);
    routeRods[key] = rods;
    routeSpeeds[key] = leg.speedMph;
    // phaseRoutes is the legacy shape: the route builder's depth inputs and the notification
    // band labels read it, and both want a RANGE. The species band stays here for them. What the
    // user reads -- the leg card and every export -- gets the contour, below.
    phaseRoutes.push({
      phase: trollN, phaseName: card.label,
      depthMin: band ? band[0] : leg.depthFt, depthMax: band ? band[1] : leg.depthFt,
      depthFt: leg.depthFt ?? null,
      speed: leg.speedMph, estWindow: leg.estStartTime ? `${leg.estStartTime}+` : '',
    });

    // THE LEG HEADER SHOWS THE WATER THE LEG CROSSES, NOT THE SPECIES BAND.
    //
    // Ryan's document carried three target depths: 15–27 ft on the timeline (the band), 25–35 ft
    // in the sonar table and the summary, 18–28 ft in the reasoning box (two hardcoded literals
    // the HTML fell back to). Two of the three were wrong and none was the depth the boat is
    // actually on. What belongs on the leg is the water under it. That was the charted contour
    // until 2026-08-30, when the contour turned out to be a name rather than a measurement — it
    // now comes from the depth profile along the line the boat will actually steer, so a leg that
    // crosses 25 to 32 ft says so instead of claiming a single figure. The band is what the fish
    // are using; it rides along under its own name so nothing has to guess which is which.
    legEntries.push({
      ...card, type: 'troll', rods,
      depthMin: leg.depthMinFt ?? leg.depthFt ?? (band ? band[0] : null),
      depthMax: leg.depthMaxFt ?? leg.depthFt ?? (band ? band[1] : null),
      depthFt: leg.depthFt ?? null,
      speciesBandFt: band,
      holding,
      // The warnings that name THIS leg, by the runId they were written with.
      warnings: leg.runId ? legWarnings.filter((w) => String(w).includes(leg.runId)) : [],
      pass: leg.pass, ofPasses: leg.ofPasses,
      port: rods[0] ? rods[0].lure : '', starboard: rods[1] ? rods[1].lure : '',
      portColor: rods[0] ? rods[0].color : '', starboardColor: rods[1] ? rods[1].color : '',
      portLeadFt: rods[0] ? rods[0].lead : '', starboardLeadFt: rods[1] ? rods[1].lead : '',
      why: clean(leg.why), phaseName: card.label,
    });
  }

  // Stops and changes come from planCues(), which is the schema's named read interface for
  // exactly this: "every stop and change in the order the boat meets them, keyed on distance
  // along the day. The timeline and the phone's notifications read this, not the legs directly."
  // The cue carries the ORDER and the absolute `atM`; the id resolves back to the object.
  const stopById = new Map();
  for (const leg of plan.legs) {
    for (const s of (leg.stops || [])) stopById.set(s.id, { stop: s, leg });
  }
  const changeById = new Map(((plan.changes) || []).map((c) => [c.id, c]));
  const legAt = (atM) => plan.legs.find((l) => atM >= l.startM && atM <= l.startM + l.lengthM) || null;

  const cueEntries = [];
  for (const cue of planCues(plan)) {
    if (cue.kind === 'stop') {
      const found = stopById.get(cue.ref);
      if (!found) continue;
      const { stop: s, leg } = found;
      const at = Array.isArray(s.at) && s.at.length === 2 ? s.at : null;
      const card = legEntries.find((e) => e.legId === leg.id);
      const entry = {
        // A STOP IS NOT A PEER OF A LEG. `parentLegId` says which leg it is a pause inside, and
        // the leg carries `stopIds` back the other way. The array below is a render ORDER.
        legId: leg.id, parentLegId: leg.id, key: leg.id,
        type: 'stop_and_cast', subType: 'v2', id: s.id,
        atM: cue.atM, atLegM: s.atM, mark: markMi(cue.atM),
        estDurationMin: s.durationMin ?? null,
        name: s.structure || s.structureType || `Structure ${s.id}`,
        targetStructure: clean(s.structureType),
        // v2 refuses to invent a depth for a feature type the packs cannot sound, and that `null`
        // is load-bearing — rule 5 of the prompt tells the model to say so rather than guess. The
        // v1 shape defaults this to 6 ft, so it is passed through as null and the renderer's own
        // fallback handles the display. Do not "fix" it to a number here.
        targetDepth: s.depthFt,
        presentation: clean(s.presentation),
        recommendedLures: (s.rods || []).map((id) => {
          const r = rodsById.get(id);
          return r && r.lure ? `${r.id}: ${r.lure}` : id;
        }),
        tacticalNote: clean(s.why),
        positioning: clean(s.positioning) || clean(s.why),
        lat: at ? at[1] : null,
        lon: at ? at[0] : null,
        // `lat` and `lon` must be set together or neither — plan-builder.js:461 guards only on
        // `lat != null` and then calls Number(e.lon).toFixed(4), which turns a null lon into
        // "0.0000" and an undefined one into "NaN".
        //
        // NO etaMin AND NO progressPct. A notification that fires on the clock while the boat is
        // still two miles back is the exact failure PLAN_SCHEMA_V2 lists as impossible by design.
        routeContext: { trackName: card ? card.label : leg.id, legId: leg.id,
                        atM: cue.atM, atLegM: s.atM, mark: markMi(cue.atM),
                        distFromRouteFt: Math.round((s.offM || 0) * 3.28084) },
        score: null, reason: clean(s.why), typeDetail: clean(s.structureType),
      };
      if (entry.lat == null || entry.lon == null) { entry.lat = null; entry.lon = null; }
      cueEntries.push(entry);
      if (entry.lat != null) stopCandidates.push(entry);
      continue;
    }

    // A CHANGE IS AN EVENT WITH A COST, AND IT USED TO SHIP AS NOTHING AT ALL. The assembler
    // builds these correctly — the cost is always read off the rod's own rig, never from the
    // model — and the old adapter never looked at `plan.changes`, so a day with three lure swaps
    // reached the water as a day with none.
    const c = changeById.get(cue.ref);
    if (!c) continue;
    const leg = legAt(c.atM);
    cueEntries.push({
      legId: leg ? leg.id : null, type: 'change', id: c.id,
      atM: c.atM, mark: markMi(c.atM),
      rodId: c.rodId, cost: c.cost, from: clean(c.from), to: clean(c.to),
      why: clean(c.why),
      label: `${c.rodId} → ${clean(c.to)}`,
      icon: '🔁', color: CHANGE_COLOR,
      // A snap is seconds; a fluoro retie is a knot with cold wet hands in a moving kayak. That
      // difference is the whole reason changes are modelled as events at all.
      costLabel: c.cost === 'fluoro' ? 'retie — 20 lb fluoro leader' : 'swivel snap',
    });
  }

  // ONE SORT KEY, AND IT IS DISTANCE. At the same metre: a change happens where the boat is
  // before the next leg starts, then the leg, then anything sitting on it.
  const rank = (e) => (e.type === 'change' ? 0 : e.type === 'troll' ? 1 : 2);
  const timeline = [...legEntries, ...cueEntries]
    .sort((a, b) => (a.atM - b.atM) || (rank(a) - rank(b)));

  // `step` numbers LEGS ONLY. A stop is not a step of its own — it is a pause inside one, and it
  // keeps the assembler's `S<leg>.<n>` identity. Renumbering stops into a flat sequence is how
  // "a stop is a pause INSIDE a leg" turned into "a stop is a step beside one" on every card.
  let stepN = 0;
  for (const e of timeline) if (e.type === 'troll') e.step = ++stepN;

  // Rods the plan never puts in the water are the ones to rig at the truck. `staged` is set by
  // seatRods() for exactly that: chosen, not deployed.
  const castRods = ((plan.loadout && plan.loadout.rods) || [])
    .filter((r) => r.role === 'cast' || r.staged)
    .map((r) => ({ rod: r.id, lure: clean(r.lure), rigging: r.rig === 'fluoro'
                     ? '20 lb fluoro leader — tie direct' : 'swivel snap',
                   jigheadWeight: '', presentation: clean(r.why) }));

  return { timeline, routeRods, routeSpeeds, phaseRoutes, castRods, stopCandidates,
           rationale: clean(o.rationale), cards };
}

/**
 * Put it on `window` where the export path looks.
 *
 * Separate from the pure function above so the whole conversion can be tested with no browser,
 * which is the only reason the seam between six modules stayed honest the first time.
 */
export function installTimeline(w, built) {
  if (!w || !built) return;
  w._smartPlanTimeline = built.timeline;
  w._smartPlanRouteRods = built.routeRods;
  w._smartPlanRouteSpeeds = built.routeSpeeds;
  w._smartPlanPhaseRoutes = built.phaseRoutes;
  w._smartPlanCastRods = built.castRods;
  w._smartPlanStopCandidates = built.stopCandidates;
  w._smartPlanRationale = built.rationale;
  // MUST be cleared, not left. plan-builder.js:194 uses it as the fallback when the unified
  // timeline is empty, and assigns it to `p.timeline` unnormalised. A leftover from a v1 run
  // earlier in the same session would render instead of this one, silently.
  w._groqPlanTimeline = null;
}
