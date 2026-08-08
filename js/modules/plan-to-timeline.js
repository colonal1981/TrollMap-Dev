/**
 * plan-to-timeline.js — a v2 plan, in the shape the rest of the Plan tab already reads.
 *
 * WHY THIS EXISTS
 * ---------------
 * 2026-08-08. Ryan on the first v2 plan he ran: "you bolted this thing on, didn't replace the old
 * version, it looks visually different in smart plan doesn't work with the json, html or preview
 * buttons... it is pretty much an after thought and worse than what i had before by a lot."
 *
 * He was right, and the diagnosis was smaller than the complaint. Preview, Print, ⬇JSON and ⬇HTML
 * never read v2's markup — they read `collectPlan()`, and `collectPlan()` reads
 * `window._smartPlanTimeline`. v2 wrote its own DOM into its own container behind its own button
 * and never touched that global, so it COULD NOT export. It did not need a renderer. It needed to
 * speak the one shape the tab already understands.
 *
 * THE PART THAT IS NOT A SIMPLE TRANSLATION
 * -----------------------------------------
 * `buildUnifiedTimeline()` in smart-plan-ui.js is not a neutral container. It is an out-and-back
 * with exactly four slots — `Ph1 Outbound`, `Ph1 Inbound`, `Ph2 Outbound`, `Ph2 Inbound` — with
 * labels baked in ("Dawn Shallow", "Heading Home"), an `orderMap` over those four keys, and
 * `phaseOrder[trollCursor] || phaseOrder[length-1]`, which quietly stacks every leg past the
 * fourth onto `Ph2 Inbound`.
 *
 * A v2 plan is N legs in an order the model chose, with no outbound and no inbound — rule 3 of the
 * prompt is literally "There is no 'out and back'". Feeding it through four phase slots would
 * throw away the thing v2 was built for. So this module emits the timeline DIRECTLY, one entry per
 * leg, keyed by the leg's own id. Nothing here interleaves: the assembler already placed every
 * stop at its `atM` along its leg, which is the job `buildUnifiedTimeline` was doing by guesswork
 * from `progressPct`.
 *
 * WHAT READS WHAT (measured, not assumed)
 * ---------------------------------------
 *   plan-builder.js:121   collectPlan()          <- window._smartPlanTimeline
 *   plan-builder.js:445   buildPlanPreviewHtml() <- p.timeline
 *   plan-builder.js:231   castingStops           <- window._smartPlanStopCandidates
 *   plan-builder.js:264   p.routeRods            <- window._smartPlanRouteRods
 *   plan-builder.js:329   p.rationale            <- window._smartPlanRationale
 *   plan-builder.js:114   p.trolling.phaseSpeeds <- window._smartPlanPhaseRoutes
 *
 * `_groqPlanTimeline` must be cleared. plan-builder.js:194 falls back to it when the unified
 * timeline is empty and assigns the raw generator timeline straight through — entries with no
 * `step`, no `key`, and `speed` where `speedMph` is expected. A stale one from a v1 run in the
 * same session would quietly render instead of this.
 *
 * Pure. No DOM, no window. The caller installs the result — see smart-plan-v2-wiring.js.
 */

/** Distinct enough to tell apart at a glance, and it repeats rather than running out. */
const LEG_COLORS = ['#00e5ff', '#00bcd4', '#ffb300', '#ff9800', '#7e57c2', '#26a69a',
                    '#ec407a', '#66bb6a', '#5c6bc0', '#ffa726'];
const TRANSIT_COLOR = '#78909c';

const M_PER_MILE = 1609.34;

const miles = (m) => (Number(m) || 0) / M_PER_MILE;
const clean = (s) => (s == null ? '' : String(s));

/**
 * Rod ids to the display shape `rodSlotHtml()` and the preview both read.
 *
 * `side` is what the preview prints, and it is positional in the card renderer: rods[0] is the
 * port slot and rods[1] starboard, regardless of what `side` says. So the ORDER here matters more
 * than the label does.
 */
function rodView(rod, side) {
  if (!rod) return null;
  return {
    side,
    rod: rod.id || '',
    lure: clean(rod.lure),
    color: clean(rod.color),
    lead: rod.leadFt ?? '',
    depth: Array.isArray(rod.runsDepthFt) ? rod.runsDepthFt.join('–') : '',
    reel: '',
    trailerSize: '', arigWeight: '', jigWeight: '',
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

  const timeline = [];
  const routeRods = {};
  const routeSpeeds = {};
  const phaseRoutes = [];
  const cards = [];
  const stopCandidates = [];
  let trollN = 0;

  for (const leg of plan.legs) {
    const key = leg.id;                                   // 'L3' / 'T2' — unique by construction
    const mi = miles(leg.lengthM);

    if (leg.type === 'transit') {
      // TRANSIT IS SHOWN, NOT SWALLOWED. Ryan, on the one part of v2 he did like: "i pretty much
      // hate all of it except the return leg." A run between legs is real time, real battery and
      // real distance, and hiding it is how a plan starts lying about the day.
      //
      // It rides in as a `troll` entry because the preview branches `if (e.type === 'troll')` and
      // renders anything else as a stop row (plan-builder.js:448). A third type would need a
      // third branch in a file this change is deliberately not touching. No rods, so the card
      // shows the two dashed "no lure assigned" slots, which is exactly right for a deadhead.
      const card = {
        key, label: `Run — ${mi.toFixed(1)} mi`, shortLabel: `Run ${mi.toFixed(1)}mi`,
        icon: '➡️', color: TRANSIT_COLOR,
        desc: `Deadhead at ${leg.speedMph} mph · ${leg.batteryAh} Ah · ${leg.estDurationMin} min`,
        longDesc: 'Moving between legs, nothing in the water',
        speedMph: leg.speedMph,
        stats: { distMi: mi.toFixed(1), timeMin: leg.estDurationMin },
      };
      cards.push(card);
      routeSpeeds[key] = leg.speedMph;
      timeline.push({
        ...card, type: 'troll', rods: [],
        depthMin: null, depthMax: null,
        port: '', starboard: '', portColor: '', starboardColor: '',
        portLeadFt: '', starboardLeadFt: '',
        why: `Transit — ${leg.estStartTime}`, phaseName: card.label,
      });
      continue;
    }

    trollN += 1;
    const port = rodsById.get(leg.deploy && leg.deploy.port);
    const stbd = rodsById.get(leg.deploy && leg.deploy.starboard);
    const rods = [rodView(port, 'Port'), rodView(stbd, 'Stbd')].filter(Boolean);

    // The leg's own contour depth is the specific fact; the band is what the species is using.
    // Both go in, in the place each reads best — the band in the depth column because it IS a
    // band, the leg's line in the description because "trolling the 24 ft line" is the sentence.
    const card = {
      key, label: `Leg ${trollN} — ${mi.toFixed(1)} mi`, shortLabel: `Leg ${trollN}`,
      icon: '🎣', color: LEG_COLORS[(trollN - 1) % LEG_COLORS.length],
      desc: leg.depthFt != null
        ? `The ${leg.depthFt} ft line · ${leg.speedMph} mph · ${leg.batteryAh} Ah`
        : `${leg.speedMph} mph · ${leg.batteryAh} Ah`,
      longDesc: clean(leg.why),
      speedMph: leg.speedMph,
      stats: { distMi: mi.toFixed(1), timeMin: leg.estDurationMin },
    };
    cards.push(card);
    routeRods[key] = rods;
    routeSpeeds[key] = leg.speedMph;
    phaseRoutes.push({
      phase: trollN, phaseName: card.label,
      depthMin: band ? band[0] : leg.depthFt, depthMax: band ? band[1] : leg.depthFt,
      speed: leg.speedMph, window: `${leg.estStartTime}+`,
    });

    timeline.push({
      ...card, type: 'troll', rods,
      depthMin: band ? band[0] : leg.depthFt,
      depthMax: band ? band[1] : leg.depthFt,
      port: rods[0] ? rods[0].lure : '', starboard: rods[1] ? rods[1].lure : '',
      portColor: rods[0] ? rods[0].color : '', starboardColor: rods[1] ? rods[1].color : '',
      portLeadFt: rods[0] ? rods[0].lead : '', starboardLeadFt: rods[1] ? rods[1].lead : '',
      why: clean(leg.why), phaseName: card.label,
    });

    // Stops are ALREADY in order along the leg — plan-assemble.js:176 sorts them by `atM` and
    // renumbers. Nothing to weave.
    for (const s of (leg.stops || [])) {
      const at = Array.isArray(s.at) && s.at.length === 2 ? s.at : null;
      const entry = {
        // The leg this stop is on. The v1 shape leaves `key` off stops entirely, which is fine
        // for the four-phase renderer — it reads `key` only on trolls — but it means a stop in an
        // exported plan cannot say which leg it belonged to, and v2 has as many legs as the day
        // needs rather than four named ones. Nothing downstream branches on it for a stop, so
        // carrying it is free and makes the entry self-describing.
        key, type: 'stop_and_cast', subType: 'v2', id: s.id,
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
        routeContext: { trackName: card.label, etaMin: leg.estDurationMin,
                        distFromRouteFt: Math.round(s.offM * 3.28084), progressPct: null },
        score: null, reason: clean(s.why), typeDetail: clean(s.structureType),
      };
      if (entry.lat == null || entry.lon == null) { entry.lat = null; entry.lon = null; }
      timeline.push(entry);
      if (entry.lat != null) stopCandidates.push(entry);
    }
  }

  // `step` is rendered literally as `Step ${entry.step}` on every stop card, so a gap shows up as
  // "Step undefined". 1-based across ALL entries, trolls included.
  timeline.forEach((e, i) => { e.step = i + 1; });

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
