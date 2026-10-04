// Plan it as one troll lays the loop on the main map, a click on the water is where a loop turns,
// and Pick Water, Generate Smart Plan and the Bench are off the screen.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-04: "pickwater ticking lanes and clicking buttons doesn't always produce an actual
// loop... i need a better way of doing this"; "Would this then work to replace pickwater and generate
// smartplan? we keep adding stuff and none of it actually works the way i want"; and on the answer,
// "lets try it... if i just have to click something and not actually draw an entire route i will give
// a chance... will it actually still use all of the structure and my catch history".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { turnsReached, SAME_WATER_M } from '../js/modules/plan-troll-loop.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const html = read('../index.html');
const ui = read('../js/modules/plan-water-ui.js');
const lom = read('../js/modules/loop-on-map.js');
const mapInit = read('../js/core/map-init.js');

// A loop south from a ramp at the origin: out down one line, home up another 400 m east.
const lon0 = -80.22, lat0 = 33.54;
const dLat = (m) => m / 110540, dLon = (m) => m / (111320 * Math.cos(lat0 * Math.PI / 180));
const at = (eM, nM) => [lon0 + dLon(eM), lat0 + dLat(nM)];
const loop = {
  grid: { cellM: 25 },
  legs: [
    { petal: 0, half: 'out', coords: [at(0, 0), at(0, -3000)] },
    { petal: 0, half: 'back', coords: [at(400, -3000), at(400, 0)] },
  ],
};

test('a turn the loop goes to is reached, and says how far the line passes it', () => {
  const [r] = turnsReached([at(0, -1500)], loop);
  assert.equal(r.reached, true);
  assert.ok(r.offM <= 12, `offM ${r.offM}`);   // the line is read every 20 m
  // a click 150 m off the line, where the water was too shallow: the loop turned near it
  const [n] = turnsReached([at(-150, -2000)], loop);
  assert.equal(n.reached, true);
  assert.ok(n.offM >= 140 && n.offM <= 160, `offM ${n.offM}`);
});

test('a turn no loop got to is not reached, so the map can say so instead of dropping it', () => {
  const [r] = turnsReached([at(-2000, -1500)], loop);
  assert.equal(r.reached, false);
  assert.ok(r.offM > 1900);
  // the limit is trollLoop's own search radius round a turn, plus a cell
  const edge = 3 * SAME_WATER_M + 25;
  assert.equal(turnsReached([at(-(edge - 10), -1500)], loop)[0].reached, true);
  assert.equal(turnsReached([at(-(edge + 10), -1500)], loop)[0].reached, false);
});

test('turns come back in the order he clicked them, and no loop means none reached', () => {
  const r = turnsReached([at(0, -500), at(-3000, 0), at(400, -2500)], loop);
  assert.deepEqual(r.map((x) => x.reached), [true, false, true]);
  assert.deepEqual(turnsReached([at(0, -500)], null).map((x) => x.reached), [false]);
});

test('where the loop says which turn each loop was laid for, that is the answer, however far off it turned', () => {
  // Potato Creek's mouth, 10/4: the loop it asked for turned 400 m off the click, at the nearest water
  // it may troll -- reached; and a second turn no loop could get to was laid for by none -- not reached.
  const told = {
    ...loop,
    petals: [{ via: 0 }, { via: null }],
    legs: [...loop.legs, { petal: 1, half: 'out', coords: [at(0, 0), at(0, 3000)] }, { petal: 1, half: 'back', coords: [at(300, 3000), at(300, 0)] }],
  };
  const r = turnsReached([at(-400, -3000), at(-5000, 0)], told);
  assert.equal(r[0].reached, true);
  assert.equal(r[0].petal, 0);
  assert.ok(r[0].offM >= 390 && r[0].offM <= 410, `offM ${r[0].offM}`);
  assert.equal(r[1].reached, false);
  assert.equal(r[1].petal, null);
  assert.equal(r[1].passedBy, null);
  // a turn on water a loop already trolls has no loop of its own, and the day goes past it
  const [, p] = turnsReached([at(-400, -3000), at(30, -2000)], told);
  assert.equal(p.reached, false);
  assert.equal(p.passedBy, 0);
});

test('a turn no loop can reach does not cost the rest of the day: that loop is chosen as any other', () => {
  const src = read('../js/modules/plan-troll-loop.js');
  assert.ok(src.includes('if (!pt && !petals.length) pt = yield* petal(ctx0, pm, petals, taken, null, false);'));
  assert.ok(src.includes('pt.via = asked ? p : null;'));
  assert.ok(src.includes('lineFt: p.lineFt, score: p.score, via: p.via != null ? p.via : null })),'));
});

test('Troll it for me takes the turns from the map exactly where he clicked, not the middle of a lane', () => {
  assert.ok(ui.includes('export async function trollForMe(opts = {}) {'));
  assert.ok(ui.includes('const fromMap = Array.isArray(opts.via);'));
  assert.ok(ui.includes('const via = (fromMap ? opts.via : ['));
  // a reason no click can fix is marked, so the day goes to the lane plan instead
  assert.ok(ui.includes("T.loopNoWater = noWater"));
  assert.ok(ui.includes('export function loopForMap() {'));
  assert.ok(ui.includes('export function riverHere() {'));
  // (spelled without the import call itself, which the audit would read as an import of this file)
  assert.ok(ui.includes("loop-on-map.js')).planAsOneTroll();"));
});

test('the loop is still his catches and the structure: the turn fixes where it turns and nothing else', () => {
  // the line still comes from his catches (the loop reads the ones within reach), and the day is
  // still chosen fish first
  assert.ok(ui.includes('const fallback = loopLine({ waterFt: guide, band, holding: T.holding, steerFt: steer });'));
  assert.ok(ui.includes('marks: T.spots, catches, via,'));
  // and the bar says what each loop passes
  assert.ok(lom.includes('catches and ${plural(s.structure || 0, \'charted mark\')}'));
});

test('one button: a river goes to the river plan, a lake is laid on the main map with the old plan taken off', () => {
  assert.ok(lom.includes("if (riverHere()) {"));
  assert.ok(lom.includes("$('runSmartPlanBtn')?.click();"));
  assert.ok(lom.includes('state.MAP.removeLayer(state.LAYER)'));
  assert.ok(lom.includes("document.querySelector('#bottomNav button[data-tab=\"map\"]')"));
  // anything else that draws the map ends the loop, so two days are never on it at once
  assert.ok(mapInit.includes("if (typeof window.endLoopPreview === 'function') window.endLoopPreview();"));
});

test('a click on the water is a turn; a double click is a zoom; a number clicked comes off; at most four', () => {
  assert.ok(lom.includes("state.MAP.on('dblclick', () => clearTimeout(S.clickTimer));"));
  assert.ok(lom.includes('const MAX_TURNS = 4;'));
  assert.ok(lom.includes("m.on('click', () => removeTurn(i));"));
  // the loop lines do not swallow a click meant for the water under them
  assert.ok(lom.includes('interactive: false'));
  // a click during the build is not a turn
  assert.ok(lom.includes('if (!S.on || S.building) return;'));
});

test('Pick Water, Generate Smart Plan and the Bench are off the screen, not deleted, and their ids still work', () => {
  assert.ok(html.includes('<button data-plansub="water" style="display:none">'));
  assert.ok(html.includes('<button id="runSmartPlanBtn" type="button" class="primary" style="display:none">'));
  assert.ok(html.includes('<button data-tab="bench" style="display:none">'));
  assert.ok(html.includes('id="plan-water"'), 'the Pick Water panel stays, hidden: the loop reads the water through it');
  assert.ok(html.includes('id="panel-bench"'));
  assert.ok(/<button id="runTrollPlanBtn" type="button" class="primary"/.test(html));
  // the two Pick Water settings moved to the Smart Plan card, ids and all, once each
  const card = html.slice(html.indexOf('id="plan-builder"'), html.indexOf('id="plan-water"'));
  assert.ok(card.includes('id="wgMinPass"') && card.includes('id="wgStops"'));
  assert.equal(html.split('id="wgMinPass"').length - 1, 1);
  assert.equal(html.split('id="wgStops"').length - 1, 1);
});
