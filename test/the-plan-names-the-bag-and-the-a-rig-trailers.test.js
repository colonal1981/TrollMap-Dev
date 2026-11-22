// Personal use only, not for distribution or resale; not for navigation.
//
// THE PLAN NAMES THE BAG, AND THE A-RIG'S TRAILERS, AND WHAT TO PACK.
//
// Ryan, 2026-11-22: "shouldn't the app tell me which trailers to use with the a-rig it tells me the weight of the jig
// head but not which of the million soft plastics i have to put on it?", then "i absolutely will run a different size or
// color on the middle", and of the tackle box: "for the ones that were in a package with a brand, color and size it would
// be really nice if it called that out? that would make it easier for me to make sure the right bag is in my tackle bag
// i bring on the water with me... most stay at home in the garage so i need to know what to grab". His "lets do it".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TACKLE_INVENTORY, colorsOf, lureByName, arigHeadsOz, trailerFits, trailersFor, colorOnItsOwnHead,
         TRAILER_COUNT } from '../js/data/tackle-inventory.js';
import { connectionFor } from '../js/data/lure-knowledge.js';
import { planArgsFrom, buildPlanRequest } from '../js/modules/plan-prompt.js';
import { colorWithBag, trailersSaid } from '../js/modules/plan-to-timeline.js';
import { packList, rodsAtLaunchHtml } from '../js/modules/rods-at-launch.js';
import { colorLines } from '../js/modules/tackle-inventory-ui.js';

const SW3 = 'Swimbait 3" – Jighead', SW4 = 'Swimbait 4" – Jighead', SW5 = 'Swimbait 5" – Jighead';
const HEAVY = 'A-Rig – four 3/4oz heads, 1oz middle (~5.6oz)', LIGHT = 'A-Rig – five 3/8oz heads (~3.5oz)';
const conn = (n) => { const l = lureByName(n); return l ? connectionFor(l.type) : null; };
const ask = (rods) => planArgsFrom({ loadout: { rods }, legs: [{ runId: 'w#1', deploy: { port: rods[0].id, starboard: (rods[1] || rods[0]).id } }] },
  [{ runId: 'w#1' }], { tackle: TACKLE_INVENTORY.map((l) => l.name), connectionOf: conn });

test('every soft-plastic colour says the bag it is in, and the tackle box shows one line a bag', () => {
  assert.deepEqual(colorsOf(SW3)[0], { name: 'Live Threadfin', n: 8, bag: 'BioBait Shadow Swimmer 3"' });
  for (const id of ['swimbait_3_0in', 'swimbait_3in', 'swimbait_4_0in', 'swimbait_4in', 'swimbait_5in', 'swimbait_6in',
                    'cast_stickbait', 'cast_worm_straight', 'cast_creature', 'jig_finesse_ned', 'cast_shrimp', 'crappie_tube']) {
    const l = TACKLE_INVENTORY.find((x) => x.id === id);
    assert.ok(l.colors.length && l.colors.every((c) => c.bag), id);
  }
  // a hard bait has no bag
  assert.ok(TACKLE_INVENTORY.find((x) => x.id === 'cb_hitstick_12').colors.every((c) => !c.bag));
  // the two Watermelon Reds were two bags all along
  const worms = TACKLE_INVENTORY.find((x) => x.id === 'cast_worm_straight').colors;
  assert.deepEqual(worms.filter((c) => /Watermelon Red/.test(c.name)).map((c) => [c.n, c.bag]),
    [[8, 'Rapala CrushCity Janitor 6"'], [12, 'Big Bite Baits Nekorama 7"']]);
  const lines = colorLines(TACKLE_INVENTORY.find((x) => x.id === 'swimbait_3_0in'));
  assert.equal(lines[0], 'BioBait Shadow Swimmer 3": Live Threadfin ×8 · Live Gizzard Shad ×8 · Live Menhaden ×8');
  assert.equal(lines.length, 4);
});

test('a trailer fits a head by the head table, and a bait already on its own head is not a trailer', () => {
  assert.deepEqual(arigHeadsOz(HEAVY), { outside: 0.75, middle: 1.0 });
  assert.deepEqual(arigHeadsOz(LIGHT), { outside: 0.375, middle: 0.375 });
  assert.equal(arigHeadsOz(SW3), null);
  assert.equal(trailerFits(SW3, 0.375).ok, true);
  assert.match(trailerFits(SW3, 0.75).why, /3\/4oz head's hook tears a 3" body \(it takes up to 1\/2oz\)/);
  assert.equal(trailerFits(SW5, 1.0).ok, true);
  assert.equal(trailerFits('Fluke 4" – Jighead', 0.5).ok, false);
  assert.deepEqual(trailersFor(0.375).map((t) => t.name), [SW3, 'Swimbait 3.8" – Jighead']);
  assert.ok(!trailersFor(0.375).some((t) => t.colors.some((c) => /pre-rigged|rigged/.test(c.name))));
  assert.equal(colorOnItsOwnHead({ name: 'Perch (pre-rigged 1/4 oz)' }), true);
  assert.equal(TRAILER_COUNT, 4);
});

test('the prompt lists each bag and count, a backup colour, and the trailers each A-rig\'s heads take', () => {
  const p = buildPlanRequest({ water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-11-23', launchTime: '06:00',
    returnTime: '15:00', species: ['Striped Bass'], conditions: {}, tackle: TACKLE_INVENTORY.map((l) => l.name),
    trollable: TACKLE_INVENTORY.filter((l) => l.trollable).map((l) => l.name), candidates: [{ runId: 'a', depthFt: 20, lengthM: 1500 }] }).user;
  assert.match(p, /- Swimbait 3in – Jighead: Live Threadfin \[BioBait Shadow Swimmer 3in, 8\];/);
  assert.match(p, /also return `backupColor`/);
  assert.match(p, /AN A-RIG NAMES ITS TRAILERS/);
  assert.match(p, /- A-Rig – four 3\/4oz heads, 1oz middle \(~5\.6oz\): the four outside heads 3\/4oz — Swimbait 4in – Jighead, /);
  assert.match(p, /the middle head 1oz — Swimbait 4in – Jighead, .*Swimbait 7in – Jighead/);
  assert.match(p, /- A-Rig – five 3\/8oz heads \(~3\.5oz\): all five heads 3\/8oz — Swimbait 3in – Jighead, Swimbait 3\.8in – Jighead/);
  assert.match(p, /"trailers": \{ "outside": \{ "lure": "a swimbait from its list", "color": "\.\.\." \}, "middle": \{ \.\.\. \} \}/);
});

test('the plan\'s trailers, bag and backup are checked against his box and kept', () => {
  const a = ask([
    { id: 'R5', lure: HEAVY, role: 'troll', leadFt: 100,
      trailers: { outside: { lure: 'Swimbait 4in – Jighead', color: 'Live Sardine' }, middle: { lure: 'Swimbait 5in – Jighead', color: 'plum chartreuse' } } },
    { id: 'R1', lure: SW3, color: 'Live Threadfin', backupColor: 'bluegill flash', role: 'troll', leadFt: 80 },
  ]);
  assert.deepEqual(a.problems, []);
  const rig = a.loadout.rods.find((r) => r.lure === HEAVY), sw = a.loadout.rods.find((r) => r.lure === SW3);
  assert.deepEqual(rig.trailers.outside, { lure: SW4, color: 'Live Sardine', bag: 'BioBait Shadow Swimmer 4" (2 packs)', n: 12, headOz: 0.75 });
  assert.equal(rig.trailers.middle.lure, SW5);
  assert.equal(rig.trailers.middle.color, 'Plum Chartreuse');
  assert.equal(sw.bag, 'BioBait Shadow Swimmer 3"');
  assert.deepEqual(sw.backup, { color: 'Bluegill Flash', bag: 'Keitech Easy Shiner 3"', n: 10 });
});

test('a trailer that does not fit, a colour he has too few of, or none named is said', () => {
  const a = ask([{ id: 'R5', lure: HEAVY, role: 'troll',
    trailers: { outside: { lure: SW3, color: 'Live Threadfin' }, middle: { lure: SW4, color: 'Pinfish' } } }]);
  assert.ok(a.problems.some((p) => /Swimbait 3" – Jighead is not a trailer for the 3\/4oz outside heads/.test(p)), a.problems.join(' | '));
  const few = ask([{ id: 'R5', lure: LIGHT, role: 'troll',
    trailers: { outside: { lure: 'Swimbait 3.8in – Jighead', color: 'Orange Pearl' }, middle: { lure: SW3, color: 'Live Menhaden' } } }]);
  assert.ok(few.problems.some((p) => /he has 2 Swimbait 3\.8" – Jighead in Orange Pearl; the 4 outside arms need 4/.test(p)), few.problems.join(' | '));
  const rigged = ask([{ id: 'R5', lure: LIGHT, role: 'troll',
    trailers: { outside: { lure: SW3, color: 'Perch (pre-rigged 1/4 oz)' }, middle: { lure: SW3, color: 'Live Menhaden' } } }]);
  assert.ok(rigged.problems.some((p) => /already on its own head/.test(p)));
  const none = ask([{ id: 'R5', lure: LIGHT, role: 'troll' }]);
  assert.ok(none.problems.some((p) => /the A-rig's outside trailer is not named/.test(p)));
});

test('the cards print the bag with the colour and the trailers in one line', () => {
  assert.equal(colorWithBag({ color: 'Live Threadfin', bag: 'BioBait Shadow Swimmer 3"' }), 'Live Threadfin (BioBait Shadow Swimmer 3")');
  assert.equal(colorWithBag({ color: 'Pink Lemonade' }), 'Pink Lemonade');
  const t = { outside: { lure: SW4, color: 'Live Sardine', bag: 'BioBait Shadow Swimmer 4"' },
              middle: { lure: SW5, color: 'Plum Chartreuse', bag: 'Down South Lures 5"' } };
  assert.equal(trailersSaid(t), '4 outside: Swimbait 4", Live Sardine (BioBait Shadow Swimmer 4"); '
    + 'middle: Swimbait 5", Plum Chartreuse (Down South Lures 5")');
  const same = { outside: { lure: SW3, color: 'Live Threadfin', bag: 'B' }, middle: { lure: SW3, color: 'Live Threadfin', bag: 'B' } };
  assert.equal(trailersSaid(same), '5 × Swimbait 3", Live Threadfin (B)');
});

test('the packing list is every bag the plan rigs, its backups and the trailers, one line a bag and colour', () => {
  const loadout = new Map([
    ['R1', { id: 'R1', lure: SW3, color: 'Live Threadfin', bag: 'BioBait Shadow Swimmer 3"',
             backup: { color: 'Bluegill Flash', bag: 'Keitech Easy Shiner 3"' } }],
    ['R5', { id: 'R5', lure: HEAVY, trailers: { outside: { lure: SW4, color: 'Live Sardine', bag: 'BioBait Shadow Swimmer 4"' },
                                                middle: { lure: SW5, color: 'Plum Chartreuse', bag: 'Down South Lures 5"' } } }],
    ['R2', { id: 'R2', lure: 'Berkley Deep Hit Stick 12', color: 'Pink Lemonade' }],
    ['R4', { id: 'R4', lure: SW3, color: 'Live Menhaden', bag: 'BioBait Shadow Swimmer 3"' }],
  ]);
  const rods = [{ id: 'R1', status: 'fishes' }, { id: 'R5', status: 'fishes' }, { id: 'R2', status: 'fishes' }, { id: 'R4', status: 'idle' }];
  const pack = packList(rods, loadout);
  assert.deepEqual(pack.map((x) => `${x.bag} · ${x.color} — ${x.uses.join(', ')}`), [
    'BioBait Shadow Swimmer 3" · Live Threadfin — R1',
    'BioBait Shadow Swimmer 4" · Live Sardine — R5 A-rig, 4 outside',
    'Down South Lures 5" · Plum Chartreuse — R5 A-rig middle',
    'Keitech Easy Shiner 3" · Bluegill Flash — R1 backup colour',
  ]);
  // and the report prints it, from the plan's loadout and the rods in the water
  const html = rodsAtLaunchHtml({ plan: { loadout: { rods: [...loadout.values()] } }, timeline: [
    { type: 'troll', key: 'L1', estStartTime: '07:00', rods: [{ rod: 'R1', side: 'Port', lure: SW3 }, { rod: 'R5', side: 'Stbd', lure: HEAVY }] },
    { type: 'troll', key: 'L2', estStartTime: '08:00', rods: [{ rod: 'R2', side: 'Port', lure: 'Berkley Deep Hit Stick 12' }, { rod: 'R5', side: 'Stbd', lure: HEAVY }] },
  ] }, (x) => String(x));
  assert.match(html, /<h3>Soft Plastics To Pack<\/h3>/);
  assert.match(html, /<td><b>BioBait Shadow Swimmer 4"<\/b><\/td><td>Live Sardine<\/td><td class="rp-small">R5 A-rig, 4 outside<\/td>/);
  const packed = html.slice(html.indexOf('Soft Plastics To Pack'), html.indexOf('<h3>Lure Changes'));
  assert.doesNotMatch(packed, /Live Menhaden/);   // R4 is not in the water today
});
