// Personal use only, not for distribution or resale; not for navigation.
//
// ONE COLOUR A LOOP, HOME DASHED AND A SHADE DARKER -- and the journal's lure box offers the lures
// the plans use.
//
// Ryan, 2026-10-03, on a four-loop Moultrie day built by "Plan it as one troll": "the color on these
// lanes confuse me... it is really hard looking at the map to figure out which lane is which... a
// bunch look to start and end in the same place? are the out and back of loops the same color?"
// They were not: every leg took the next of six colours, so each loop's out and home were unrelated
// and loop 4 came round in loop 1's colours. Offered one colour a loop, home dashed on the map and
// in the darker shade on the Garmin, he said "yeah go ahead and do both".
//
// And: "the lure list in the catch journal... where does that list come from as i do not see all of
// the possibilities in there?" It was spread-builder's 38 LURE_PRESETS; the plans pick from the
// tackle inventory's 65.

import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { assemblePlan } from '../js/modules/plan-assemble.js';
import { planTracks, legColor, planCueLines, planWaypoints } from '../js/modules/plan-tracks.js';
import { planToTimeline, LEG_COLORS, LOOP_COLORS, loopOf, loopColor, RETURN_COLOR, TRANSIT_COLOR }
  from '../js/modules/plan-to-timeline.js';
import { displayColor, buildGPX } from '../js/utils/parsers.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';

const hue = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return null;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
};
const apart = (a, b) => { const d = Math.abs(hue(a) - hue(b)); return Math.min(d, 360 - d); };
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
};

// A loop day as plan-troll-loop.js hands it over: legs named <slug>#loopN-out / -back.
const LAUNCH = [-79.9887, 33.2545];
function piece(runId, from, to) {
  const coordinates = [];
  for (let i = 0; i <= 10; i++) {
    coordinates.push([from[0] + (to[0] - from[0]) * i / 10, from[1] + (to[1] - from[1]) * i / 10]);
  }
  const dx = (to[0] - from[0]) * 111320 * Math.cos(from[1] * Math.PI / 180);
  const dy = (to[1] - from[1]) * 110540;
  return { runId, startM: 0, lengthM: Math.hypot(dx, dy), depthFt: 30,
           start: coordinates[0], end: coordinates[coordinates.length - 1],
           coordinates, passes: [], support: null };
}
const MOUTH = [-79.9873, 33.2534];
const IDS = ['test_lake#loop1-out', 'test_lake#loop1-back', 'test_lake#loop2-out', 'test_lake#loop2-back',
             'test_lake#loop3-out', 'test_lake#loop3-back', 'test_lake#loop4-out', 'test_lake#loop4-back'];
const TURNS = [[-80.0137, 33.2478], [-79.9873, 33.2704], [-80.0064, 33.2426], [-80.0228, 33.2491]];
function loopPlan() {
  const candidates = [];
  TURNS.forEach((t, k) => {
    candidates.push(piece(IDS[2 * k], MOUTH, t), piece(IDS[2 * k + 1], t, MOUTH));
  });
  const deploy = Object.fromEntries(IDS.map((id) => [id, { port: 'R1', starboard: 'R5' }]));
  return assemblePlan({
    candidates, launch: LAUNCH, slug: 'test_lake', water: 'Test Lake', ramp: 'Short Stay',
    loadout: { rods: [
      { id: 'R1', rig: 'fluoro', role: 'troll', lure: 'DD2 Crankbait (16-20ft)', color: 'Chartreuse' },
      { id: 'R5', rig: 'snap', role: 'troll', lure: '4" Lipless Crankbait', color: 'Chrome' },
    ] },
    launchTime: '06:00', returnTime: '15:00', usableAh: 80, deploy, stops: [],
  });
}

describe('one colour a loop', () => {
  it('reads the loop and the half off the runId, and nothing off any other leg', () => {
    expect(loopOf({ runId: 'lake_moultrie#loop3-back' })).toEqual({ n: 3, half: 'back' });
    expect(loopOf({ runId: 'wateree_lake#loop1-out' })).toEqual({ n: 1, half: 'out' });
    expect(loopOf({ runId: 'wateree_lake#12' })).toBeNull();
    expect(loopOf({ runId: null })).toBeNull();
    expect(loopColor({ runId: 'wateree_lake#12' })).toBeNull();
  });

  it("a loop's out and home are one colour family, home the darker shade", () => {
    for (const [out, home] of LOOP_COLORS) {
      expect(apart(out, home), `${out}/${home} are not one colour`).toBeLessThan(15);
      expect(lum(home), `${home} is not darker than ${out}`).toBeLessThan(lum(out));
    }
  });

  it('the 8/09 rule still holds between loops: next to each other they are far apart', () => {
    for (let i = 1; i < LOOP_COLORS.length; i++) {
      expect(apart(LOOP_COLORS[i - 1][0], LOOP_COLORS[i][0])).toBeGreaterThan(120);
    }
    for (const [out] of LOOP_COLORS) {
      expect(apart(out, RETURN_COLOR), `${out} is the run home's hue`).toBeGreaterThan(30);
    }
  });

  it('each pair is a Garmin colour and its own dark twin, so the unit shows what the map shows', () => {
    for (const [out, home] of LOOP_COLORS) {
      const o = displayColor(out), h = displayColor(home);
      expect(o, `${out} has no Garmin name`).toBeTruthy();
      expect(h).toBe(`Dark${o}`);
    }
    // the run home's dark green is nobody's loop
    for (const pair of LOOP_COLORS) expect(pair.map(displayColor).includes(displayColor(RETURN_COLOR))).toBe(false);
  });

  it('a four-loop day draws four colours: loop 4 no longer comes round in loop 1', () => {
    const p = loopPlan();
    const runOf = new Map(p.legs.map((l) => [l.id, l.runId]));
    const troll = planTracks(p).filter((t) => t.planStep === 'troll');
    expect(troll.length).toBe(8);
    for (const t of troll) {
      const { n, half } = loopOf({ runId: runOf.get(t.legId) });
      expect(t.color).toBe(LOOP_COLORS[n - 1][half === 'back' ? 1 : 0]);
      expect(t.loopHome).toBe(half === 'back');
    }
    expect(new Set(troll.filter((t) => !t.loopHome).map((t) => t.color)).size).toBe(4);
    // transits keep their own grey / green and their own dash
    for (const t of planTracks(p).filter((x) => x.planStep === 'transit')) {
      expect([TRANSIT_COLOR, RETURN_COLOR].includes(t.color)).toBe(true);
      expect(t.dashed).toBe(true);
      expect(t.loopHome).toBe(false);
    }
  });

  it('the card says which loop and wears the colour of its line', () => {
    const p = loopPlan();
    const tracks = new Map(planTracks(p).map((t) => [t.legId, t]));
    const runOf = new Map(p.legs.map((l) => [l.id, l.runId]));
    const cards = planToTimeline(p).cards.filter((c) => c.legType === 'troll');
    expect(cards.length).toBe(8);
    for (const c of cards) {
      const { n, half } = loopOf({ runId: runOf.get(c.legId) });
      expect(c.label.endsWith(`· loop ${n} ${half === 'back' ? 'home' : 'out'}`), c.label).toBe(true);
      expect(c.color).toBe(tracks.get(c.legId).color);
    }
  });

  it('the GPX carries the bright colour out and the dark twin home', () => {
    const p = loopPlan();
    const gpx = buildGPX({ waypoints: [], tracks: planTracks(p) });
    for (const [out, home] of LOOP_COLORS) {
      expect(gpx.includes(`<gpxx:DisplayColor>${displayColor(out)}</gpxx:DisplayColor>`)).toBe(true);
      expect(gpx.includes(`<gpxx:DisplayColor>${displayColor(home)}</gpxx:DisplayColor>`)).toBe(true);
    }
  });

  it('the cue line at a leg start is the colour of its leg', () => {
    const p = loopPlan();
    const colours = new Map(planTracks(p).map((t) => [t.legId, t.color]));
    for (const c of planCueLines(p, planWaypoints(p))) {
      if (c.legId && colours.has(c.legId)) expect(c.color).toBe(colours.get(c.legId));
    }
  });

  it('a day that is not loops is coloured exactly as before', () => {
    const plain = { legs: [
      { id: 'T1', type: 'transit' }, { id: 'L1', type: 'troll', runId: 'w#1' },
      { id: 'L2', type: 'troll', runId: 'w#2' }, { id: 'T2', type: 'transit', role: 'return' },
    ] };
    expect(legColor(plain.legs[1], 0)).toBe(LEG_COLORS[0]);
    expect(legColor(plain.legs[2], 1)).toBe(LEG_COLORS[1]);
    expect(legColor(plain.legs[3], 0)).toBe(RETURN_COLOR);
  });

  it('a loop day saved before this change comes back in the new colours', () => {
    // His 10/4 Moultrie plan was saved one colour a leg. restorePlanView() draws what was saved, so
    // without this a loaded loop day would keep the colours he could not read.
    const pb = readFileSync(new URL('../js/modules/plan-builder.js', import.meta.url), 'utf8');
    const restore = pb.slice(pb.indexOf('function restorePlanView('), pb.indexOf('function armSavedPlan('));
    expect(restore).toMatch(/const lc = loopColor\(leg\), lp = loopOf\(leg\);/);
    expect(restore.includes('cardDefs, unified: unifiedLoops')).toBe(true);
    expect(restore).toMatch(/loopHome: \(loopOf\(legOf\.get\(legId\)\) \|\| \{\}\)\.half === 'back'/);
    expect(restore).toMatch(/loopColor\(legOf\.get\(r\.legId\)\)/);
  });

  it('the map draws a loop home dashed, with the fishing halo', () => {
    const src = readFileSync(new URL('../js/core/map-init.js', import.meta.url), 'utf8');
    expect(src).toMatch(/else if \(t\.loopHome\) \{[\s\S]{0,400}?weight: 6[\s\S]{0,200}?dashArray: '12,6'/);
  });
});

describe('the catch journal offers the lures the plans use', () => {
  it('reads the tackle inventory, not the spread builder presets', () => {
    const src = readFileSync(new URL('../js/modules/catch-journal.js', import.meta.url), 'utf8');
    expect(src.includes('LURE_PRESETS')).toBe(src.includes('It came from `LURE_PRESETS`'));
    expect(src).toMatch(/import \{ TACKLE_INVENTORY \} from '\.\.\/data\/tackle-inventory\.js';/);
    expect(src).toMatch(/TACKLE_INVENTORY\.filter\(\(l\) => l\.trollable \|\| l\.castable\)/);
    expect(src).toMatch(/journalLureNames\(\)\.map/);
  });

  it('the same filter the planners use: every lure, no inline weights', () => {
    const names = TACKLE_INVENTORY.filter((l) => l.trollable || l.castable).map((l) => l.name);
    for (const want of ['4" Lipless Crankbait', 'P-Line Laser Minnow 2oz (PLM2)', 'SPRO Prime Bucktail Jig 1oz (SBTJ-1)',
                        'Fluke 4" – Jighead', 'Stick Bait (Senko)', 'Speedworm 7" – Jighead']) {
      expect(names.includes(want), `${want} is not offered`).toBe(true);
    }
    expect(names.some((n) => /Inline Trolling Weight/.test(n))).toBe(false);
    for (const f of ['smart-plan-v2-wiring.js', 'plan-water-ui.js']) {
      const s = readFileSync(new URL(`../js/modules/${f}`, import.meta.url), 'utf8');
      expect(s, `${f} no longer filters the inventory this way`).toMatch(/TACKLE_INVENTORY\.filter\(\(l\) => l\.trollable \|\| l\.castable\)/);
    }
  });
});
