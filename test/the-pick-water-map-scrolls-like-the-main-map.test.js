// The Pick Water map zooms with the scroll wheel and moves with a drag, like the main map.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-04: "for pickwater to be better i would want the map where i tick lanes to be
// scrollable with my scroll wheel on my mouse just like the main map is... i think that would fix
// that issue" -- the issue being "the zoomed out view where i can't even see what i am clicking".
// Ticking stays what it was: "if i literally only have to pick 1 lane in an area and it builds the
// rest that is pretty cool".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../js/modules/plan-water-ui.js', import.meta.url), 'utf8');

test('the wheel zooms the map about the cursor, and the page does not scroll under it', () => {
  assert.ok(src.includes("document.addEventListener('wheel', (e) => {"));
  assert.ok(src.includes('}, { passive: false });'));
  assert.ok(src.includes('const c0 = F.centre, at = F.at(px, py), k = z0 / z1;'));
  // scrolling all the way out is the whole pick again
  assert.ok(src.includes('T.view = z1 > 1 ? {'));
});

test('a drag moves the zoomed map, and the end of a drag does not tick a lane', () => {
  assert.ok(src.includes("document.addEventListener('pointermove', (e) => {"));
  assert.ok(src.includes('if (drag && drag.moved) return;'));
});

test('the painter and the mouse share one frame, which turns a pixel back into a position', () => {
  assert.ok(src.includes('if (view && view.z > 1 && view.c) {'));
  assert.ok(src.includes('at: (px, py) => [lo0 + (px - ox) / (kx * s), la0 + (h - oy - py) / (ky * s)],'));
  // the mouse asks the same question, so a tick that lands before the last paint still zooms about the cursor
  assert.ok(src.includes('const F = frameOf(T.mapBase, T.view);'));
});

test('a click finds the lane by its line, not only its corners, so it still works zoomed in', () => {
  assert.ok(src.includes('const toSeg = (a, b) => {'));
  assert.ok(src.includes('const d = i ? toSeg(cs[i - 1], cs[i])'));
});

test('a new Find water starts at the whole pick, and no extra buttons were added', () => {
  assert.ok(src.includes('view: null,                // a new Find water starts at the whole pick'));
  assert.ok(!src.includes('data-zoom='));
  assert.ok(!src.includes('turnAt'));
});
