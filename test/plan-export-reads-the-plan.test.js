import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { assemblePlan } from '../js/modules/plan-assemble.js';
import { planToTimeline } from '../js/modules/plan-to-timeline.js';
import { metresBetween } from '../js/modules/plan-candidates.js';
import { state } from '../js/core/state.js';

const BUILDER = readFileSync(new URL('../js/modules/plan-builder.js', import.meta.url), 'utf8');
const UI = readFileSync(new URL('../js/modules/smart-plan-ui.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Why this test exists
//
// Ryan's generated document carried THREE different target depths for one morning:
//
//   timeline[].depthMin/depthMax   15–27 ft   (the species band)
//   HTML "Target Drop-Off Depth"   25–35 ft   (a hardcoded literal)
//   HTML "Autonomous AI Reasoning" 18–28 ft   (a different hardcoded literal)
//   HTML "Sonar Settings", Range   25–35 ft   (inherited from the first literal)
//
// Two of the three were wrong, and none of them was the depth the legs actually follow.
// The cause: collectPlan() rebuilt `trolling` from form fields, `#planTargetDepth` is a
// hidden input only v1 ever writes, and the HTML fell through to literals when it was
// empty. The plan knew the answer the whole time and nothing asked it.
// ---------------------------------------------------------------------------

const LAUNCH = [-80.7300, 34.3800];
const routed = (a, b) => ({ distanceM: metresBetween(a, b), coordinates: [a, b] });

function leg(id, fromLon, toLon, lat, depthFt) {
  const coordinates = [];
  for (let i = 0; i <= 10; i++) coordinates.push([fromLon + (toLon - fromLon) * i / 10, lat]);
  return {
    runId: id, runIndex: Number(id.split('#')[1]), startM: 0,
    lengthM: Math.abs(toLon - fromLon) * 111320 * Math.cos(lat * Math.PI / 180),
    depthFt, start: coordinates[0], end: coordinates[coordinates.length - 1],
    coordinates, passes: [], support: null,
  };
}

const PLAN = assemblePlan({
  transit: routed,
  candidates: [leg('w#1', -80.7200, -80.6800, 34.3800, 22.4),
               leg('w#2', -80.6700, -80.6400, 34.3850, 31)],
  launch: LAUNCH,
  loadout: { rods: [{ id: 'R1', rig: 'fluoro', role: 'troll', lure: 'A-Rig', color: 'Shad' },
                    { id: 'R5', rig: 'snap', role: 'troll', lure: 'Spoon', color: 'Chrome' }] },
  deploy: { 'w#1': { port: 'R1', starboard: 'R5' }, 'w#2': { port: 'R1', starboard: 'R5' } },
  slug: 'wateree_lake', water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-08-10',
  launchTime: '06:00', returnTime: '15:00', usableAh: 80,
  species: ['Striped Bass'],
  conditions: { waterTempF: 85, clarity: 'Muddy',
                depthBand: { ft: [15, 27], basis: 'research profile', lakeSpecific: true },
                solunar: { majors: ['10:08'], minors: ['16:08'] } },
  safety: { isGo: true, warning: '', rampEvaluation: 'sheltered' },
});

const noop = () => {};
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, dataset: {} }), addEventListener: noop, readyState: 'complete',
};
const { collectPlan, laneTelemetry } = await import('../js/modules/plan-builder.js');

describe('the export reads the plan instead of re-deriving it', () => {
  state.DATA = { waypoints: [], tracks: [] };
  globalThis.window._planV2 = PLAN;
  const p = collectPlan();

  it('exports the depth the legs follow, not a literal and not the species band', () => {
    expect(p.trolling.targetDepth).toBe('22.4–31');       // the two charted contours
    expect(p.trolling.speciesBandFt).toEqual([15, 27]);    // what the fish are using, named as such
  });

  it('exports the day’s speeds as a range, because each leg has its own', () => {
    // "If a renderer needs one number for the day it reports the range, not a single figure.
    // There is no plan-level trolling speed." The old export read #planSpeed, which said 1.8
    // while both legs ran 2.
    expect(p.trolling.speed).toBe('2');
    expect(p.trolling.legSpeeds.length).toBe(PLAN.legs.length);
    expect(p.trolling.legSpeeds[0].legId).toBe(PLAN.legs[0].id);
  });

  it('exports budget, conditions, meta, safety and warnings — none of which had a route out', () => {
    expect(p.plan.budget.totalM).toBe(PLAN.budget.totalM);
    expect(p.plan.budget.plannedAh).toBe(PLAN.budget.plannedAh);
    expect(p.plan.conditions.waterTempF).toBe(85);
    expect(p.plan.meta.ramp).toBe('Clearwater Cove');
    expect(p.plan.safety.isGo).toBe(true);
    expect(Array.isArray(p.plan.warnings)).toBe(true);
  });

  it('exports each leg with its own depth, speed and place on the spine, and no geometry', () => {
    const legs = p.plan.legs;
    expect(legs.length).toBe(PLAN.legs.length);
    expect(legs.map((l) => l.startM)).toEqual(PLAN.legs.map((l) => l.startM));
    expect(legs.find((l) => l.type === 'troll').depthFt).toBe(22.4);
    // The geometry ships as GPX tracks. A second copy here is a second thing to fall out of sync.
    expect(legs.every((l) => l.coordinates === undefined)).toBe(true);
  });

  it('carries the amp-hour caveat with the amp-hour figures', () => {
    // "This is a two-point fit, not a measurement, and it should say so wherever it surfaces."
    // It said so only in a source comment, while the report printed a battery table with none.
    expect(p.batteryCurve).toContain('two-point fit');
  });

  it('fills meta.solunar from the plan rather than leaving the HTML to compute it', () => {
    expect(p.meta.solunar).toContain('10:08');
  });

  it('leaves the plan block null when no v2 plan has been generated', () => {
    delete globalThis.window._planV2;
    const q = collectPlan();
    expect(q.plan).toBe(null);
    expect(q.trolling.speciesBandFt).toBe(null);
    globalThis.window._planV2 = PLAN;
  });
});

describe('the HTML has no depth of its own to fall back to', () => {
  it('the hardcoded target depths are gone', () => {
    // '25–35' in the sonar table and the summary row, '18–28' in the reasoning box. A plausible
    // number printed where the plan is silent is how one document claimed three depths.
    // Only as prose in the comment explaining the defect -- never as a `|| '25–35'` fallback.
    expect(/\|\|\s*'25–35'/.test(BUILDER)).toBe(false);
    expect(/\|\|\s*'18–28'/.test(BUILDER)).toBe(false);
  });

  it('the sonar table reads the same field the summary does', () => {
    // WAS: expect(BUILDER).toContain('const sonarRange = targetDepth').
    //
    // That asserted the MECHANISM -- one shared variable feeding both -- and the mechanism
    // changed on 2026-08-26, when the four hand-written sonar rows ("Dawn / Structure scan",
    // and the rest, which were invented advice) were replaced by a per-leg contour alarm and
    // depth shading band. The INVARIANT did not change and is what is guarded here: the sonar
    // section and the summary row must both read the legs' own `depthFt`, so one document can
    // never again carry two target depths.
    const p = collectPlan();
    const legFt = PLAN.legs.filter((l) => l.type === 'troll' && l.depthFt != null)
      .map((l) => Number(l.depthFt));
    // the sonar table, rounded to the whole feet the alarm screen takes
    expect(p.trolling.bands.map((b) => b.depthFt)).toEqual(legFt.map((n) => Math.round(n)));
    // the summary row, the same walk, unrounded
    expect(p.trolling.targetDepth).toBe(`${Math.min(...legFt)}\u2013${Math.max(...legFt)}`);
    // and the band is symmetric about the leg's own charted line -- never a species band
    for (const b of p.trolling.bands) {
      expect(b.deep - b.depthFt).toBe(b.depthFt - b.shallow);
    }
  });

  it('the sonar table cannot render without legs to read', () => {
    // The defect was a table printing a plausible number where the plan was silent. No legs,
    // no rows; no rows, no section. There is nothing left for it to fall back to.
    expect(BUILDER).toContain('(p.trolling.bands || []).map');
    expect(/\$\{sonarRows\?`/.test(BUILDER)).toBe(true);
    expect(collectPlan().trolling.bands.length > 0).toBe(true);
  });
});

describe('the leg card shows the contour, not the band', () => {
  const built = planToTimeline(PLAN, { depthBand: [15, 27] });
  it('puts the leg’s own charted line on the leg', () => {
    const first = built.timeline.find((e) => e.legType === 'troll');
    expect(first.depthMin).toBe(22.4);
    expect(first.depthMax).toBe(22.4);
    expect(first.depthFt).toBe(22.4);
    expect(first.speciesBandFt).toEqual([15, 27]);   // along for the ride, under its own name
  });
});


// -----------------------------------------------------------------------------------------------
// A transit card claimed a spread it does not have, 2026-08-09.
//
//     ➡️ TROLL — Run — 0.8 mi
//     Target Depth —
//     Spread / Leads   Port —ft · Stbd —ft
//     🔵 Port — no lure assigned
//     🔴 Stbd — no lure assigned
//
// Ryan: "if this is the leg to get to the start of the first troll run it doesn't need this
// information." Both renderers take the same `type: 'troll'` entry -- that is deliberate, it is
// how a transit gets a leg row instead of a stop row -- so `legType` is the only thing that can
// separate them, and both of them have to look at it. These are source assertions because the
// renderers build HTML strings against a live DOM; the data half is pinned properly in
// plan-to-timeline.test.js.
// -----------------------------------------------------------------------------------------------
describe('a transit is rendered as a transit', () => {
  it('the timeline card branches on legType before it draws a spread', () => {
    const branch = UI.indexOf("entry.legType === 'transit'");
    expect(branch, 'no transit branch in the timeline renderer').toBeGreaterThan(-1);
    // Everything a spread needs is drawn AFTER the branch, so the branch's `return` skips it.
    // 'Target Depth' was renamed 2026-08-30: the tile shows the WATER the leg follows, and
    // calling it the target is what let a card read "Target Depth 6ft" above a bait running
    // 20-25 ft. The tile is the same tile; only the label it carries is honest now.
    // 'Spread / Leads' became 'Where the baits run' on 2026-08-31: the box stopped printing
    // feet of line, which he cannot set, and started printing where each bait runs against
    // the bottom he can feel. Same box, same position, honest label.
    for (const spreadMarkup of ['>Water on this leg</div>', '>Where the baits run</div>',
                                'rodSlotHtml(rods[0]']) {
      expect(UI.indexOf(spreadMarkup), `${spreadMarkup} is drawn before the transit branch`)
        .toBeGreaterThan(branch);
    }
  });

  it('the card does not call a deadhead a troll', () => {
    expect(UI).toContain("entry.role === 'return' ? 'RETURN' : 'TRANSIT'");
    expect(UI).toContain('— ${esc(entry.label)}');
    expect(BUILDER).toContain("e.role === 'return' ? 'RETURN' : 'TRANSIT'");
    expect(BUILDER).toContain('${kind} — ${esc(label)}');
  });

  it('the printed report gives a transit no depth column and no rod column', () => {
    const branch = BUILDER.indexOf("e.legType === 'transit'");
    expect(branch, 'no transit branch in the printed timeline').toBeGreaterThan(-1);
    expect(BUILDER).toContain('Nothing in the water');
    // The rods string for a troll row is built after the transit branch has already returned.
    expect(BUILDER.indexOf('const rods = (e.rods||[])')).toBeGreaterThan(branch);
  });

  it('a real assembled plan produces a transit entry with nothing to put in a spread', () => {
    const built = planToTimeline(PLAN);
    const transits = built.timeline.filter((e) => e.legType === 'transit');
    expect(transits.length).toBeGreaterThan(0);
    for (const t of transits) {
      expect(t.rods).toEqual([]);
      expect(t.depthMin).toBe(null);
      expect(t.portLeadFt).toBe('');
      expect(t.label).not.toContain('Leg');
      expect(Number(t.stats.distMi) >= 0).toBe(true);
    }
    // and no transit leaks into routeRods, which is what fills the two rod slots
    for (const t of transits) expect(built.routeRods[t.key]).toBe(undefined);
  });
});


// -----------------------------------------------------------------------------------------------
// THE LANE TELEMETRY TABLE CONTRADICTED THE TIMELINE THREE INCHES ABOVE IT, 2026-08-09.
//
// In the report Ryan printed:
//
//     every lane at 1.8 mph, INCLUDING the transits, which the plan runs at 3.5
//     L1 at 5.0 mi, where the plan's own leg says 4.5
//     T2 at 224 min, where the plan says 103
//
// Same disease as the three depths above: the table walked state.DATA.tracks, measured the
// polylines itself, and priced every one of them at #planSpeed or at a v1 `Ph<n>` phase-speed
// table the v2 path never writes. The plan had all four numbers on every leg.
// -----------------------------------------------------------------------------------------------
describe('lane telemetry is the plan, not a second opinion about it', () => {
  const rows = laneTelemetry(PLAN);

  it('has one row per leg, in the order the boat meets them', () => {
    expect(rows.length).toBe(PLAN.legs.length);
    expect(rows.map((r) => r.id)).toEqual(PLAN.legs.map((l) => l.id));
  });

  it('prices a transit at the transit speed, which was the headline error', () => {
    const troll = rows.filter((r) => !r.transit);
    const transit = rows.filter((r) => r.transit);
    expect(transit.length).toBeGreaterThan(0);
    expect(troll.length).toBeGreaterThan(0);
    // Not one speed for the whole table.
    expect(new Set(rows.map((r) => r.speedMph)).size).toBeGreaterThan(1);
    for (const r of transit) expect(r.speedMph).toBe('3.5');
    for (const r of troll) expect(r.speedMph).toBe('2.0');
  });

  it('takes distance and run time off the leg rather than measuring anything', () => {
    for (let i = 0; i < rows.length; i++) {
      const leg = PLAN.legs[i];
      expect(rows[i].distMi).toBe((leg.lengthM / 1609.34).toFixed(2));
      expect(rows[i].mins).toBe(leg.estDurationMin);
      expect(rows[i].batteryAh).toBe(leg.batteryAh.toFixed(2));
    }
  });

  it('names the leg for what it is, including the way home', () => {
    expect(rows.find((r) => !r.transit).kind).toContain('Troll');
    expect(rows.find((r) => !r.transit).kind).toContain('22.4 ft');
    const home = PLAN.legs.find((l) => l.role === 'return');
    expect(!!home).toBe(true);
    expect(rows.find((r) => r.id === home.id).kind).toContain('back to the ramp');
  });

  it('survives the export shape, which drops geometry but keeps the numbers', () => {
    // The report renders collectPlan()'s `plan`, not the raw plan object, so the row source has
    // to be that shape — same fields, geometry dropped.
    state.DATA = { waypoints: [], tracks: [] };
    globalThis.window._planV2 = PLAN;
    const exported = laneTelemetry(collectPlan().plan);
    expect(exported.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(exported.map((r) => r.kind)).toEqual(rows.map((r) => r.kind));
    expect(exported.map((r) => r.speedMph)).toEqual(rows.map((r) => r.speedMph));
  });

  it('prints no table at all rather than a guessed one', () => {
    // "Anything that cannot be read off the plan and cannot be measured stays empty."
    expect(laneTelemetry(null)).toEqual([]);
    expect(laneTelemetry({})).toEqual([]);
    expect(laneTelemetry({ legs: [] })).toEqual([]);
  });

  it('no longer walks the tracks or reaches for a fallback speed', () => {
    expect(BUILDER).toContain('const trollTimes = laneTelemetry(p.plan)');
    expect(BUILDER.includes('function calcTrollTimes')).toBe(false);
    expect(BUILDER.includes('function speedForTrack')).toBe(false);
    // The heading no longer promises one pass speed for the whole day.
    expect(BUILDER.includes('Run Times by Pass Speed')).toBe(false);
  });
});
