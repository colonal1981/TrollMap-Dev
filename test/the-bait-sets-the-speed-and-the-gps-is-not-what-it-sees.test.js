import { describe, it, expect } from './expect-shim.mjs';

// plan-builder.js wires DOM handlers on load and reaches access-index.js, which decorates
// `window`. The same shim plan-export-reads-the-plan.test.js uses, for the same reason.
const noop = () => {};
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, dataset: {} }), addEventListener: noop,
  readyState: 'complete',
};

const { assemblePlan } = await import('../js/modules/plan-assemble.js');
const { metresBetween } = await import('../js/modules/plan-candidates.js');
const { laneTelemetry } = await import('../js/modules/plan-builder.js');
const { riverSpeedNote } = await import('../js/modules/plan-prompt.js');
const { gpsWindowFor, sharedSpeedWindow, LURE_KNOWLEDGE } = await import('../js/data/lure-knowledge.js');
const { TACKLE_INVENTORY } = await import('../js/data/tackle-inventory.js');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE GPS IS NOT THE SPEED THE BAIT SEES
//
// Ryan, 2026-09-17, on how he holds a trolling speed on moving water: "gps and watching if the
// lures are blowing out or not... i have to really watch it going up river... i like to troll at
// 2-2.5mph but at current that may be way too fast for some baits."
//
// He is right, and the app was no help at all: it hard-coded 2.0 mph in three places and handed
// the model one number for both halves of a river day. Measured on his own box at the Congaree's
// median 0.84 mph, holding 2.0 on the GPS, the bait sees 2.84 going up and 1.16 coming back --
// 49 of his 57 rated baits over-driven upstream, 55 under-speed coming home.
//
// So the speed stopped being the model's to pick. The model picks the BAIT; the app converts that
// bait's through-water window into the ground speed to hold, once per direction, and prints it on
// the leg. Two rods share one boat, so the pair has to share one speed -- which is the reason bait
// choice is still a real judgement and the reason a non-overlapping pair is said out loud.
//
// The numbers below are computed from LURE_KNOWLEDGE and the arithmetic under test, not typed, with
// one exception: the Congaree's 0.84 mph, which is a measurement.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const CONGAREE_MPH = 0.84;
const lureByName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;

// Two baits whose windows OVERLAP, and two that cannot share a speed at all.
const DD1 = TACKLE_INVENTORY.find((l) => l.type === 'crankbait_dd1');
const DD3 = TACKLE_INVENTORY.find((l) => l.type === 'crankbait_dd3');
const SR = TACKLE_INVENTORY.find((l) => l.type === 'crankbait_sr');
const CORK = TACKLE_INVENTORY.find((l) => l.type === 'popping_cork');
// Two LEAD-controlled baits, for the depth check: a rated bait's depth is its bill and moves
// for nothing, so only these can show a lead being computed at the wrong speed.
const LIPLESS = TACKLE_INVENTORY.find((l) => l.type === 'lipless');
const SPOON = TACKLE_INVENTORY.find((l) => l.type === 'flutter_spoon');
const W = (t) => LURE_KNOWLEDGE[t].speed;

describe('gpsWindowFor — the ground speed that holds a bait in its own window', () => {
  it('on still water the two are the same number, which is why this never came up', () => {
    const g = gpsWindowFor(W('crankbait_mr'), 0);
    expect(g.up).toEqual(g.down);
    expect(g.up.min).toBe(W('crankbait_mr').min);
    expect(g.up.max).toBe(W('crankbait_mr').max);
  });

  it('upstream the current is SUBTRACTED and downstream ADDED, by the whole current', () => {
    const s = W('crankbait_mr');
    const g = gpsWindowFor(s, CONGAREE_MPH);
    expect(g.up.ideal).toBe(Number((s.ideal - CONGAREE_MPH).toFixed(1)));
    expect(g.down.ideal).toBe(Number((s.ideal + CONGAREE_MPH).toFixed(1)));
  });

  it('a floor below zero is clamped to zero, because a negative ground speed is not a speed', () => {
    const g = gpsWindowFor(W('popping_cork'), 1.4);   // min 1.0 - 1.4 = -0.4
    expect(g.up.min).toBe(0);
    expect(g.up.max > 0).toBe(true);
  });

  it('a CEILING at or below zero is null, not zero — that direction cannot be fished at all', () => {
    // The popping cork tops out at 1.6 mph through the water. In 2.0 mph of current the boat would
    // have to travel backwards over the ground to slow it down.
    const g = gpsWindowFor(W('popping_cork'), 2.0);
    expect(g.up).toBe(null);
    expect(g.down).not.toBe(null);
  });

  it('no window and no current are both null rather than a guessed band', () => {
    expect(gpsWindowFor(null, 1)).toBe(null);
    expect(gpsWindowFor({ ideal: 2 }, 1)).toBe(null);
    expect(gpsWindowFor(W('crankbait_mr'), null)).toBe(null);
    expect(gpsWindowFor(W('crankbait_mr'), 'fast')).toBe(null);
  });
});

describe('sharedSpeedWindow — two rods share one boat', () => {
  it('one bait is its own window', () => {
    const s = W('crankbait_dd3');
    const w = sharedSpeedWindow([s]);
    expect(w.min).toBe(s.min);
    expect(w.max).toBe(s.max);
    expect(w.ideal).toBe(s.ideal);
    expect(w.overlap).toBe(true);
  });

  it('two overlapping windows intersect, and the speed is the mean of the two bests', () => {
    const a = W('crankbait_dd1'), b = W('crankbait_dd3');
    const w = sharedSpeedWindow([a, b]);
    expect(w.min).toBe(Math.max(a.min, b.min));
    expect(w.max).toBe(Math.min(a.max, b.max));
    expect(w.ideal).toBe(Number(((a.ideal + b.ideal) / 2).toFixed(2)));
    expect(w.overlap).toBe(true);
    expect(w.needsAtLeast).toBe(null);
  });

  it('the mean is clamped INTO the shared band, never left outside it', () => {
    const w = sharedSpeedWindow([{ min: 2.4, ideal: 2.6, max: 3.0 },
                                { min: 1.0, ideal: 1.1, max: 2.6 }]);
    expect(w.min).toBe(2.4);
    expect(w.ideal).toBe(2.4);           // mean 1.85 is below the floor
    expect(w.overlap).toBe(true);
  });

  it('where they do not meet, the SLOWER bait ceiling governs and the conflict is reported', () => {
    const fast = W('crankbait_sr'), slow = W('popping_cork');
    const w = sharedSpeedWindow([fast, slow]);
    expect(w.overlap).toBe(false);
    // Collapsed onto one number so every caller's arithmetic stays valid.
    expect(w.max).toBe(slow.max);
    expect(w.min).toBe(slow.max);
    expect(w.ideal).toBe(slow.max);
    // And the floor that could not be met is kept, because that is the thing to say out loud.
    expect(w.needsAtLeast).toBe(fast.min);
  });

  it('a rod with no window is skipped, and no rod at all is null', () => {
    const w = sharedSpeedWindow([W('crankbait_dd3'), null, { ideal: 9 }]);
    expect(w.n).toBe(1);
    expect(sharedSpeedWindow([null, undefined])).toBe(null);
    expect(sharedSpeedWindow([])).toBe(null);
  });
});

describe('riverSpeedNote — what the prompt tells him to hold', () => {
  it('says the through-water range once and the ground speed for each direction', () => {
    const s = W('crankbait_mr');
    const g = gpsWindowFor(s, CONGAREE_MPH);
    const note = riverSpeedNote(s, CONGAREE_MPH);
    expect(note).toContain(`that ${s.min}-${s.max} mph is THROUGH THE WATER`);
    expect(note).toContain(`going up ${g.up.min}-${g.up.max} (best ${g.up.ideal})`);
    expect(note).toContain(`coming back ${g.down.min}-${g.down.max} (best ${g.down.ideal})`);
    expect(note).toContain('on the GPS');
  });

  it('a direction that cannot be held says so instead of printing a band', () => {
    const note = riverSpeedNote(W('popping_cork'), 2.0);
    expect(note).toContain('going up cannot be slowed enough to fish it');
    expect(note).toContain('coming back');
  });

  it('nothing at all on a bait with no rated speed, rather than an empty band', () => {
    expect(riverSpeedNote(null, CONGAREE_MPH)).toBe('');
  });
});

// ── THE ASSEMBLER ────────────────────────────────────────────────────────────────────────────

// A reach drawn DOWNSTREAM, which is what river-drifts.js lays out: 3DHP's `flowdirection` sets
// vertex order. The launch sits by the first vertex so orientLegs leaves it unflipped and pass 1
// is the run down.
const LAUNCH = [-80.9000, 33.8800];
function reach({ drift = true, currentMph = CONGAREE_MPH, speedMph = null } = {}) {
  const coordinates = [];
  for (let i = 0; i <= 20; i++) coordinates.push([-80.8990 + i * 0.0020, 33.8800]);
  const lengthM = metresBetween(coordinates[0], coordinates[coordinates.length - 1]);
  return {
    runId: 'congaree_river#1', runIndex: 1,
    startM: 0, lengthM, depthFt: 22, depthMinFt: 14, depthMaxFt: 31, maxRunDepthFt: 30,
    start: coordinates[0], end: coordinates[coordinates.length - 1],
    coordinates, passes: [], support: null,
    drift: drift || null, currentMph, trollPasses: 2,
    fromRamp: drift ? { direction: 'downstream', m: 120 } : null,
    ...(speedMph != null ? { speedMph } : {}),
  };
}

const LOADOUT = { rods: [
  { id: 'R1', rig: 'snap', role: 'troll', lure: DD1.name, color: 'Shad' },
  { id: 'R2', rig: 'snap', role: 'troll', lure: DD3.name, color: 'Chrome' },
  { id: 'R3', rig: 'snap', role: 'troll', lure: SR.name, color: 'Craw' },
  { id: 'R4', rig: 'snap', role: 'troll', lure: CORK.name, color: 'Natural' },
  { id: 'R5', rig: 'snap', role: 'troll', lure: LIPLESS.name, color: 'Gold' },
  { id: 'R6', rig: 'snap', role: 'troll', lure: SPOON.name, color: 'Chrome' },
] };

const routed = (a, b) => ({ distanceM: metresBetween(a, b), coordinates: [a, b] });

function build(extra = {}, cands = [reach()]) {
  return assemblePlan({
    transit: routed, candidates: cands, launch: LAUNCH, loadout: LOADOUT,
    slug: 'congaree_river', water: 'Congaree River, SC', ramp: 'Bates Bridge',
    launchTime: '06:00', returnTime: '17:00', usableAh: 80, lureByName,
    deploy: { 'congaree_river#1': { port: 'R1', starboard: 'R2' } },
    ...extra,
  });
}

describe('the app sets the river speed from the bait, once per direction', () => {
  const shared = sharedSpeedWindow([W(DD1.type), W(DD3.type)]);
  const gps = gpsWindowFor(shared, CONGAREE_MPH);

  it('the pass down and the pass back are NOT the same number, and each is its bait window', () => {
    const plan = build();
    const troll = plan.legs.filter((l) => l.type === 'troll');
    expect(troll.length).toBe(2);
    expect(troll[0].speedMph).toBe(gps.down.ideal);
    expect(troll[1].speedMph).toBe(gps.up.ideal);
    expect(troll[0].speedMph).not.toBe(troll[1].speedMph);
  });

  it('the two hold the SAME speed through the water, which is the bait window they share', () => {
    const plan = build();
    const [down, up] = plan.legs.filter((l) => l.type === 'troll');
    expect(Number((down.speedMph - CONGAREE_MPH).toFixed(1)))
      .toBe(Number((up.speedMph + CONGAREE_MPH).toFixed(1)));
  });

  it('the model asking for a speed on a river is not read at all', () => {
    const plan = build({}, [reach({ speedMph: 4.0 })]);
    for (const l of plan.legs.filter((x) => x.type === 'troll')) {
      expect(l.speedMph).not.toBe(4.0);
    }
  });

  it('each pass says which way the boat is pointed, and the card prints it', () => {
    const plan = build();
    const [down, up] = plan.legs.filter((l) => l.type === 'troll');
    expect(down.heading).toBe('downstream');
    expect(up.heading).toBe('upstream');
    const rows = laneTelemetry(plan).filter((r) => !r.transit);
    expect(rows[0].kind).toContain('downstream');
    expect(rows[1].kind).toContain('upstream');
  });

  it('THE UPSTREAM PASS COSTS MORE, which a current-blind cost got backwards', () => {
    // This is the whole reason the amp-hours had to move to ampHoursAlong(). Setting the speed from
    // the bait makes the upstream pass the SLOWER one over the ground, and ampHours() reads a slower
    // leg as a cheaper one -- so the dearer direction would have been priced as the bargain.
    const plan = build();
    const [down, up] = plan.legs.filter((l) => l.type === 'troll');
    expect(up.batteryAh > down.batteryAh).toBe(true);
    expect(up.estDurationMin > down.estDurationMin).toBe(true);
  });

  it('the bait runs the SAME depth both ways, because its depth is set by the water speed', () => {
    // The lead physics take a through-water speed -- a lip and a blade know nothing about the
    // ground. Handed the ground speed, the same bait on the same lead would have been reported at
    // two different depths on the two halves of one leg, out by the whole current each way.
    const lead = { ...reach(), maxRunDepthFt: 12 };   // shallow enough that the cap has to act
    const plan = build({ deploy: { 'congaree_river#1': { port: 'R5', starboard: 'R6' } } }, [lead]);
    const [down, up] = plan.legs.filter((l) => l.type === 'troll');
    expect(down.speedMph).not.toBe(up.speedMph);
    expect(down.rodPlan).not.toBe(undefined);          // there IS something to get wrong
    expect(JSON.stringify(up.rodPlan)).toBe(JSON.stringify(down.rodPlan));
  });

  it('a pair that cannot share a speed is named, both baits, with what it costs', () => {
    const plan = build({ deploy: { 'congaree_river#1': { port: 'R3', starboard: 'R4' } } });
    const hit = plan.warnings.filter((w) => w.includes('no one speed that fishes both baits'));
    expect(hit.length).toBe(1);
    expect(hit[0]).toContain(SR.name);
    expect(hit[0]).toContain(CORK.name);
    expect(hit[0]).toContain('blows');
  });

  it('a current the bait cannot be slowed under is said out loud, not silently over-driven', () => {
    const plan = build({ deploy: { 'congaree_river#1': { port: 'R4', starboard: 'R4' } } },
                                     [reach({ currentMph: 2.0 })]);
    const said = plan.warnings.filter((w) => w.includes('cannot be trolled slow enough going upstream'));
    expect(said.length).toBe(1);
    expect(said[0]).toContain('Watch for blow-out');
    const up = plan.legs.filter((l) => l.type === 'troll').find((l) => l.heading === 'upstream');
    expect(up.speedMph > 0).toBe(true);
  });
});

describe('a lake leg is exactly what it was', () => {
  it('the model still sets the speed and there is no heading to print', () => {
    const lake = { ...reach({ drift: false, currentMph: null, speedMph: 2.2 }) };
    const plan = build({}, [lake]);
    const troll = plan.legs.filter((l) => l.type === 'troll');
    expect(troll[0].speedMph).toBe(2.2);
    expect(troll[1].speedMph).toBe(2.2);
    expect(troll[0].heading).toBe(undefined);
    // Both passes over the same water at the same speed cost the same, as they always did.
    expect(troll[0].batteryAh).toBe(troll[1].batteryAh);
    expect(laneTelemetry(plan).filter((r) => !r.transit)[0].kind).not.toContain('stream');
  });

  it('a river reach with no measured current is a lake leg for this purpose', () => {
    // `currentBasis` records why there is no number -- tidal, no gauge, no charted section -- and
    // none of those is a reason to invent one. The model's speed is the only one there is.
    const plan = build({}, [reach({ currentMph: null, speedMph: 2.1 })]);
    const troll = plan.legs.filter((l) => l.type === 'troll');
    expect(troll[0].speedMph).toBe(2.1);
    expect(troll[0].heading).toBe(undefined);
  });
});
