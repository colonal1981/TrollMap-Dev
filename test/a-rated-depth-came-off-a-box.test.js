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
import { depthWindow, leadForDepth, canReachDepth,
         requiresInlineWeight } from '../js/data/lure-knowledge.js';
import { buildPlanRequest } from '../js/modules/plan-prompt.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';

const byName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;
const DD3 = TACKLE_INVENTORY.find((l) => l.type === 'crankbait_dd3');
// THE STAND-IN FOR "A BAIT WHOSE DEPTH IS LEAD AND SPEED" MUST NOT BE ONE THAT NEEDS A RIG.
//
// It was the flutter spoon, picked by a `lipless_crank` type that has never existed followed by
// `|| flutter_spoon`. From 2026-09-14 a bare flutter spoon correctly reports `needs_weight` and
// no depth at all -- Ryan: "a 3/4oz spoon unweighted at 2mph is a surface lure" -- so it is the
// one bait in the box that cannot stand for the general case. The predicate now says what it
// means, and the spoon gets its own assertions at the bottom of this file.
const LEADED = TACKLE_INVENTORY.find((l) => (l.trollable || l.castable)
  && !requiresInlineWeight(l.type)
  && depthWindow(l, { leadFt: 100, speedMph: 2 }).mode === 'lead');

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
    expect(LEADED.type).not.toBe('flutter_spoon');   // see the note on LEADED
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


describe('the baits that cannot work on a leg are named before the choice, not after it', () => {
  // Ryan, holding a plan that warned him a DD2 was the wrong bait for leg 2: "telling me that the
  // baits are wrong... so they shouldn't be offered in the first place... that means that the
  // model is not being told the right things."
  //
  // It WAS told: Pick Water has sent `maxRunDepthFt` per candidate since it was written, and it
  // got a 13 ft ceiling and put a DD2 (16-20 ft) on that leg regardless. The real fault is that
  // capBaitDepth() works out exactly which lures cannot clear a leg, does it only once the plan
  // exists, and then writes a warning. Same knowledge, moved in front of the decision.
  const names = TACKLE_INVENTORY.filter((l) => l.trollable).map((l) => l.name);
  const ask = (candidates) => buildPlanRequest({
    water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-08-30',
    launchTime: '06:00', returnTime: '15:00', species: ['Striped Bass'], conditions: {},
    tackle: names, trollable: names, lureByName: byName, candidates,
  }).user;
  const cands = (text) => {
    const i = text.indexOf('[{"runId"');
    return JSON.parse(text.slice(i, text.indexOf('\n', i)));
  };

  it('names every bill that is already deeper than the ceiling', () => {
    const c = cands(ask([{ runId: 'a', depthFt: 20, maxRunDepthFt: 13, lengthM: 1954 }]))[0];
    // 13 ft of water: every deep diver drags, including the DD2 the model actually chose.
    expect(c.cannotUse).toContain(DD3.name);
    expect(c.cannotUse.some((n) => /DD1/.test(n))).toBe(true);
    expect(c.cannotUse.some((n) => /DD2/.test(n))).toBe(true);
    expect(c.cannotUse.some((n) => /DD4/.test(n))).toBe(true);
  });

  it('and only those — a deeper leg rules out fewer', () => {
    const c = cands(ask([{ runId: 'a', depthFt: 28, maxRunDepthFt: 24, lengthM: 1832 }]))[0];
    expect(c.cannotUse.some((n) => /DD4/.test(n))).toBe(true);
    expect(c.cannotUse.some((n) => /DD1|DD2/.test(n))).toBe(false);
  });

  it('never names a lead-controlled bait, because a shorter lead is always the answer', () => {
    // Naming one would delete water he can fish. capBaitDepth() shortens the lead for these
    // rather than complaining, so nothing appears here that has a way of working.
    const c = cands(ask([{ runId: 'a', depthFt: 8, maxRunDepthFt: 4, lengthM: 1954 }]))[0];
    for (const n of c.cannotUse) {
      expect(depthWindow(byName(n), { speedMph: 2, leadFt: null }).mode).toBe('rated');
    }
    expect(c.cannotUse.includes(LEADED.name)).toBe(false);
  });

  it('says nothing where the app has no ceiling to go on', () => {
    const c = cands(ask([{ runId: 'a', depthFt: 20, lengthM: 1954 }]))[0];
    expect(c.cannotUse === undefined).toBe(true);
  });

  it('and tells the model it is per leg, not a verdict on the bait', () => {
    const p = ask([{ runId: 'a', depthFt: 20, maxRunDepthFt: 13, lengthM: 1954 }]);
    expect(p).toMatch(/THE LIST OF BAITS THAT WILL NOT CLEAR IT/);
    expect(p).toMatch(/the same lure\s+may be the right answer on the next leg/);
    expect(p).toMatch(/Nothing appears on it that has any way of working/);
  });
});

// ── THE THIRD KIND OF CLAIM: A DEPTH THAT DOES NOT EXIST UNTIL THE RIG DOES ────────────────────
//
// Ryan, 2026-09-14, on a plan that put his 3/4oz Nichols at 22 ft: "is the spoon depths assuming
// that i am using the 2oz trolling weight rig? because a 3/4oz spoon unweighted at 2mph is a
// surface lure not these depths??? unless i am thinking wrong?"
//
// A rated depth is the maker's claim. A lead-controlled depth is the app's arithmetic. This is
// neither: it is a question that has no answer until a weight is on the line, and answering it
// with a number was the failure.
describe('a bait that only fishes behind a weight says so instead of guessing', () => {
  const SPOON = TACKLE_INVENTORY.find((l) => l.type === 'flutter_spoon');

  it('bare, it has no running depth at any lead', () => {
    const w = depthWindow(SPOON, { speedMph: 2.0, leadFt: 120 });
    expect(w.mode).toBe('needs_weight');
    expect(w.min).toBe(null);
    expect(w.max).toBe(null);
  });

  it('rigged, it is an ordinary lead-controlled bait again', () => {
    const w = depthWindow({ ...SPOON, inlineWeightOz: 2 }, { speedMph: 2.0, leadFt: 70 });
    expect(w.mode).toBe('lead');
    expect(w.claimed).toBe(false);
    expect(w.max).toBe(22);
  });

  it('and the prompt tells the model, instead of letting it read the 3/4oz on the label', () => {
    const p = buildPlanRequest({
      water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-09-14',
      launchTime: '06:00', returnTime: '15:00', species: ['Striped Bass'], conditions: {},
      tackle: [SPOON.name], trollable: [SPOON.name], lureByName: byName, candidates: [],
    }).user;
    expect(p).toMatch(/ONLY fishes behind an inline trolling weight/);
    expect(p).toMatch(/planing surface/);
    expect(p.includes('depth set by its BILL')).toBe(false);   // the branch it used to fall into
  });
});

// ── cannotUse USED THE SHALLOW END, AND capBaitDepth USES THE DEEP ONE ──────────────────────────
//
// `cannotUseOn()` in plan-prompt.js tested `w.min > ceilingFt` and its own comment called that
// "precisely capBaitDepth()'s test, asked earlier". capBaitDepth's test is `w.max <= ceilingFt`.
// Not the same test, and the model was handed the lenient one.
//
// Measured on Ryan's 2026-09-14 plan: wateree_lake#216 has an 11 ft ceiling, and `cannotUse` named
// the four deep divers and NOT the MR Crankbait (6-12 ft), because 6 > 11 is false. The model put
// the MR on that leg and capBaitDepth then wrote "runs to 12 ft and the shallowest water on this
// leg is 11 ft. Its depth is the lure itself, so lead will not lift it -- it is the wrong bait for
// this pass." Told afterwards, having been offered it.
//
// Ryan, on the plan that caused this block to exist: "telling me that the baits are wrong... so
// they shouldn't be offered in the first place... that means that the model is not being told the
// right things."
describe('a rated bait is refused a leg its BILL cannot clear, before the model picks', () => {
  const askFor = (ceilingFt) => buildPlanRequest({
    water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-09-14',
    launchTime: '06:00', returnTime: '15:00', species: ['Striped Bass'], conditions: {},
    candidates: [{ runId: 'wateree_lake#216', depthFt: 20, maxRunDepthFt: ceilingFt,
                   lengthM: 2000, structures: [] }],
    tackle: TACKLE_INVENTORY.filter((l) => l.trollable || l.castable).map((l) => l.name),
    trollable: TACKLE_INVENTORY.filter((l) => l.trollable).map((l) => l.name),
    lureByName: byName,
  }).user;
  const cannotUse = (ceilingFt) => {
    const m = askFor(ceilingFt).match(/"cannotUse":\[([^\]]*)\]/);
    return m ? m[1] : '';
  };

  it('an 11 ft ceiling refuses the 6-12 ft crankbait, not only the deep divers', () => {
    const list = cannotUse(11);
    expect(list.includes('MR Crankbait (6-12ft)')).toBe(true);
    expect(list.includes('DD4 Crankbait (25ft+)')).toBe(true);
  });

  it('a ceiling the bill clears leaves the bait on the table', () => {
    const list = cannotUse(14);
    expect(list.includes('MR Crankbait (6-12ft)')).toBe(false);     // max 12, clears 14
    // AND THE DD1 IS STILL REFUSED AT 14 FT, which is the whole point of reading `max`. It is
    // rated 14-18: its shallowest is exactly the ceiling and its deepest is four feet under it, so
    // it drags somewhere on the pass. My first draft of this assertion expected it to pass and the
    // code was right -- written down because "rated 14-18 on 14 ft of water" reads fine until you
    // notice which end the bait actually makes.
    expect(list.includes('DD1 Crankbait (14-18ft)')).toBe(true);
  });

  it('deep water refuses nothing', () => {
    expect(cannotUse(40)).toBe('');
  });

  it('a lead-controlled bait is NEVER on the list, at any ceiling', () => {
    // It can always be brought up by shortening the lead, which is what capBaitDepth does for it
    // rather than complaining. Naming it here would delete water he can fish.
    for (const ceiling of [5, 11, 14, 40]) {
      expect(cannotUse(ceiling).includes('Flutter Spoon')).toBe(false);
      expect(cannotUse(ceiling).includes('Swimbait')).toBe(false);
    }
  });
});
