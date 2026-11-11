// Personal use only, not for distribution or resale; not for navigation.
//
// THE LIPLESS LEVELS OFF.
//
// Ryan, 2026-11-08, of his plan's 3" lipless at 10-15 ft on 60 ft at 2 mph: "a 3 inch lipless at 2mph... what are the
// actual chances that it runs that deep?", then "I could let all of my line out on my real and that lipless is never
// going to hit bottom at 2mph lol unless i run pretty dang shallow", and "i will treat the lipless as a shallow bait".
// The app worked its depth from the line out (4.0 ft of lead a foot, no source), so 120 ft put the 3" at 25 ft. The
// one figure found: trolling charts put a 1/2 oz Trap at 7-11 ft on the troll (BassResource forum, read 11/9). So
// line takes it down to about 11 ft and no further; other weights by the file's own weight exponent (mine).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depthWindow, leadForDepth, canReachDepth, levelsOffFt, LURE_KNOWLEDGE } from '../js/data/lure-knowledge.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';

const by = (n) => TACKLE_INVENTORY.find((l) => l.name === n);
const L3 = by('3" Lipless Crankbait');

test('the 3" (1/2 oz) runs 7-11 ft once out on enough line, and more line does not take it deeper', () => {
  assert.equal(levelsOffFt(L3), 11);
  for (const lead of [60, 80, 120, 200]) {
    const w = depthWindow(L3, { speedMph: 2.0, leadFt: lead });
    assert.equal(w.max, 11, `${lead} ft`);
    assert.equal(w.min, 7, `${lead} ft`);
    assert.equal(w.atCeiling, true);
  }
  // short of the ceiling the line still sets it
  const short = depthWindow(L3, { speedMph: 2.0, leadFt: 30 });
  assert.ok(short.max < 11 && short.atCeiling === false, JSON.stringify(short));
});

test('asked for deeper than it goes, it says so instead of handing out more line', () => {
  assert.equal(leadForDepth(L3, 25, 2.0), leadForDepth(L3, 11, 2.0));
  const c = canReachDepth(L3, 15, 2.0, { maxLeadFt: 120 });
  assert.equal(c.ok, false);
  assert.equal(c.limitedBy, 'levels off');
  assert.match(c.detail, /levels off at about 11 ft at 2 mph/);
  assert.equal(canReachDepth(L3, 10, 2.0, { maxLeadFt: 120 }).ok, true);
});

test('heavier goes deeper, lighter shallower; his 1 1/4 oz Super Pogy about 16 ft', () => {
  assert.equal(levelsOffFt(by('2" Lipless Crankbait')), 8.3);
  assert.equal(levelsOffFt(by('4" Lipless Crankbait')), 12.9);
  assert.equal(levelsOffFt({ type: 'lipless', weightOz: 1.25 }), 15.9);
  // only the lipless levels off: a blade bait and a bucktail are still worked from the line
  assert.equal(levelsOffFt(by('3" Blade Vibe Bait')), null);
  assert.equal(levelsOffFt(by('3/4oz Bucktail Jig')), null);
  assert.ok(LURE_KNOWLEDGE.lipless.levelsOff && LURE_KNOWLEDGE.lipless.depthMode === 'lead');
});

test('and slower goes deeper: its ceiling moves with the speed by the same curve as every weighted bait', () => {
  // Ryan, 11/9: "does the app know that i can slow down to drop the sinking baits lower to actually reach the fish?"
  assert.equal(levelsOffFt(L3, 2.0), 11);
  assert.equal(levelsOffFt(L3, 1.6), 13.8);
  assert.equal(levelsOffFt(L3, 2.4), 9.2);
  const slow = depthWindow(L3, { speedMph: 1.6, leadFt: 120 });
  const fast = depthWindow(L3, { speedMph: 2.4, leadFt: 120 });
  assert.ok(slow.max > 11 && fast.max < 11, JSON.stringify({ slow, fast }));
  assert.equal(slow.atCeiling, true);
  // 13 ft is out of reach at 2 mph and in reach at 1.6 on the same line
  assert.equal(canReachDepth(L3, 13, 2.0, { maxLeadFt: 120 }).ok, false);
  assert.equal(canReachDepth(L3, 13, 1.6, { maxLeadFt: 120 }).ok, true);
});

test('the plan is told it levels off, and that slower takes it deeper, not that it goes as deep as it is fed', async () => {
  const { buildPlanRequest } = await import('../js/modules/plan-prompt.js');
  const names = [L3.name];
  const byName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;
  const p = buildPlanRequest({
    water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-11-09',
    launchTime: '07:00', returnTime: '15:00', species: ['Striped Bass'], conditions: {},
    tackle: names, trollable: names, lureByName: byName, candidates: [],
  }).user;
  assert.match(p, /3in Lipless Crankbait[^\n]*LEVELS OFF: about 11 ft at 2 mph however much line is out, about 13\.8 ft at 1\.6 mph/);
  assert.match(p, /Slower is deeper, faster is shallower; past that depth more line buys nothing/);
  assert.doesNotMatch(p, /Lipless Crankbait[^\n]*No ceiling/);
});

// HIS SUPER POGY IS IN THE BOX. Ryan, 2026-11-10: "we never added it after i bought it last month".
test('the Bomber Super Pogy 1-1/4oz is in his tackle, to cast or troll, and levels off about 16 ft at 2 mph', () => {
  const pogy = by('Bomber Super Pogy 1-1/4oz (hi p mullet)');
  assert.ok(pogy, 'in TACKLE_INVENTORY');
  assert.equal(pogy.type, 'lipless');
  assert.equal(pogy.weightOz, 1.25);
  assert.equal(pogy.castable, true);
  assert.equal(pogy.trollable, true);
  assert.equal(Math.round(levelsOffFt(pogy, 2.0)), 16);
});
