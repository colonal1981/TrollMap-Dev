// A RATED DEPTH CAME OFF A BOX, AND THE MODEL WAS READING IT OFF A NAME.
//
// Ryan, 2026-08-30:
//
//   > the only way to change the depth of a lure is lead or speed... or changing the lure... so
//   > for a weighted lure (non lipped) either letting out more line or slowing down will drop the
//   > bait down deeper... the only lure i have that has an actual max depth is the crankbaits...
//   > it doesn't matter how much line you let out or how fast you go they aren't going to go much
//   > deeper than their spec... and my experience is that most of them run more shallow than they
//   > say they do
//
// Three of those four were already modelled. leadForDepth() clamps a rated bait to its rating,
// capBaitDepth() refuses to lift one by shortening the lead, and speedFactor() makes slower
// deeper and faster shallower for everything weighted. The fourth was nowhere.
//
// And the model never saw ANY of it. buildPlanRequest() handed over a flat list of names, so the
// only depth information reaching it was whatever the name happened to print --
// "DD3 Crankbait (20-25ft)" -- and it read 25 off the label.
//
// NO SHRINK FACTOR IS INVENTED HERE, and none can be: he cannot measure one either, "my sonar
// isn't going to show where my bait is... i do not have live sonar". The rated pair already spans
// the uncertainty, so the rule is which END to read, and it depends on the question being asked:
// the deep end when checking whether it will drag, the shallow end when claiming it is with the
// fish.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from './expect-shim.mjs';
import { depthWindow, leadForDepth, canReachDepth } from '../js/data/lure-knowledge.js';
import { buildPlanRequest } from '../js/modules/plan-prompt.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';

const byName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;
const DD3 = TACKLE_INVENTORY.find((l) => l.type === 'crankbait_dd3');
const LEADED = TACKLE_INVENTORY.find((l) => l.type === 'lipless_crank' || l.type === 'flutter_spoon')
            || TACKLE_INVENTORY.find((l) => depthWindow(l, { leadFt: 100, speedMph: 2 }).mode === 'lead');

describe('a bill and a weight are different claims and now say so', () => {
  it('a rated depth is marked as a claim', () => {
    const w = depthWindow(DD3, { speedMph: 2.0, leadFt: 100 });
    expect(w.mode).toBe('rated');
    expect(w.claimed).toBe(true);
  });

  it('a lead-controlled depth is not', () => {
    const w = depthWindow(LEADED, { speedMph: 2.0, leadFt: 100 });
    expect(w.mode).toBe('lead');
    expect(w.claimed).toBe(false);
  });

  it('and the two ends of a rating are the two different answers', () => {
    // The whole rule, in one assertion: what to fear and what to count on are not the same number.
    const w = depthWindow(DD3, { speedMph: 2.0, leadFt: 100 });
    expect(w.min).toBe(20);   // count on this when placing it among fish
    expect(w.max).toBe(25);   // assume this when checking it against the shallowest water
    expect(w.max > w.min).toBe(true);
  });

  it('still refuses to lead a crank past its bill', () => {
    // Unchanged, and checked here because the change above sits next to it: Ryan's "it doesn't
    // matter how much line you let out... they aren't going to go much deeper than their spec".
    const deep = leadForDepth(DD3, 40, 2.0);
    const rated = leadForDepth(DD3, 25, 2.0);
    expect(deep).toBe(rated);
    expect(canReachDepth(DD3, 40, 2.0).ok).toBe(false);
  });

  it('and still makes a weighted bait deeper on more line and on less speed', () => {
    const slow = leadForDepth(LEADED, 25, 1.4);
    const fast = leadForDepth(LEADED, 25, 2.8);
    expect(slow < fast).toBe(true);                       // slower needs less line for the depth
    const shallow = depthWindow(LEADED, { speedMph: 2.0, leadFt: 50 });
    const deeper = depthWindow(LEADED, { speedMph: 2.0, leadFt: 120 });
    expect(deeper.max > shallow.max).toBe(true);          // more line is deeper, with no ceiling
  });
});

describe('the model is told how a bait reaches a depth, not left to read the label', () => {
  const names = [DD3.name, LEADED.name];
  const prompt = () => buildPlanRequest({
    water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-08-30',
    launchTime: '06:00', returnTime: '15:00', species: ['Striped Bass'], conditions: {},
    tackle: names, trollable: names, lureByName: byName, candidates: [],
  }).user;

  it('says a crank is set by its bill, and which end to trust for which question', () => {
    const p = prompt();
    expect(p).toMatch(/depth set by its BILL/);
    expect(p).toMatch(/run SHALLOWER than rated/);
    expect(p).toMatch(/count on 20 ft/);          // among the fish
    expect(p).toMatch(/assume it reaches 25 ft/); // against the shallowest water
  });

  it('says a weighted bait is set by lead and speed, with no ceiling', () => {
    const p = prompt();
    expect(p).toMatch(/depth set by LEAD and SPEED/);
    expect(p).toMatch(/More line out or slower is deeper/);
    expect(p).toMatch(/No ceiling/);
  });

  it('tells it not to read a depth off the name, which is what it had been doing', () => {
    expect(prompt()).toMatch(/Do not read a depth off a lure's NAME/);
  });

  it('says nothing at all when the caller cannot resolve a lure', () => {
    // No inventory, no invented facts. The block simply does not appear.
    const p = buildPlanRequest({
      water: 'W', ramp: 'R', date: '2026-08-30', launchTime: '06:00', returnTime: '15:00',
      species: ['Striped Bass'], conditions: {}, tackle: names, trollable: names, candidates: [],
    }).user;
    expect(p.includes('HOW EACH OF THESE GETS TO A DEPTH')).toBe(false);
  });
});

describe('both planners hand the resolver over', () => {
  const live = (f) => readFileSync(new URL(f, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('Pick Water and Smart Plan both pass lureByName into the prompt', () => {
    // Pick Water already passed it to the ASSEMBLER; neither passed it to the PROMPT, and Smart
    // Plan did not have it at all -- so on that path the model's only depth source was the name.
    expect(live('../js/modules/plan-from-water.js')).toMatch(/lureByName: o\.lureByName/);
    expect(live('../js/modules/smart-plan-v2.js')).toMatch(/lureByName: o\.lureByName/);
    expect(live('../js/modules/smart-plan-v2-wiring.js')).toMatch(/lureByName: \(name\) =>/);
  });
});
