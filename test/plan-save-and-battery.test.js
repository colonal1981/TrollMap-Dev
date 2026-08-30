// TWO FEATURES DELETED FROM THE PAGE, WITH THEIR CODE LEFT RUNNING.
//
// On 2026-07-09 one commit re-uploaded index.html wholesale -- 346 lines out, 112 in -- and took
// the Plan tab's Save button, its Saved Plans library, its JSON import, and the battery pairing
// panel with it. Every handler behind all four stayed in the JS, bound with `?.` to elements that
// had stopped existing, so the modules still loaded, still ran, and did nothing at all. Ryan found
// them seven weeks apart, both by looking for something and not finding it: "there is no actual
// way to save a plan anymore that i can find", and "i see no way to control the bluetooth for my
// battery in the app anymore???"
//
// `?.` is why it was silent. It was added so a missing element could not throw, which is right,
// and its cost is exactly this. Nothing else was watching.
//
// This watches. It asserts the elements exist AND that the JS still binds them, because either
// half alone passes happily through the outage: a page with the buttons and no handlers looks
// identical to a page with handlers and no buttons.
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(path.join(REPO, f), 'utf8');
const html = src('index.html');
const planJs = src('js/modules/plan-builder.js');
const bleJs = src('js/modules/ble-motor.js');
const wiringJs = src('js/modules/plan-tab-wiring.js');

const hasId = (id) => html.includes(`id="${id}"`);
const binds = (js, id) => js.includes(`getElementById('${id}')`);

// COMMENTS ARE NOT CODE, and an assertion that cannot tell them apart fails on the very comment
// that explains the bug it is guarding. This file's first draft did exactly that twice. Stripping
// them is crude -- it will eat a `//` inside a string literal -- and for asserting that a
// selector is GONE, crude in the safe direction: a survivor inside a string still fails.
const live = (js) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('a plan can be saved, listed, loaded and imported', () => {
  it('the page provides every element the save path needs', () => {
    for (const id of ['savePlanBtn', 'planLibraryList', 'importPlanFile', 'plan-library']) {
      expect(hasId(id)).toBe(true);
    }
  });

  it('and plan-builder.js still binds them', () => {
    expect(binds(planJs, 'savePlanBtn')).toBe(true);
    expect(binds(planJs, 'importPlanFile')).toBe(true);
    expect(binds(planJs, 'planLibraryList')).toBe(true);
  });

  it('the Saved Plans subtab exists and its panel answers to the same name', () => {
    expect(html.includes('data-plansub="library"')).toBe(true);
    // The panel carries the same data-plansub its button does -- plan-tab-wiring.js matches on
    // that, not on the id, because the first panel is #plan-builder behind a button reading
    // `plan` and `#plan-plan` matches nothing.
    expect(/<div id="plan-library"[^>]*data-plansub="library"/.test(html)).toBe(true);
  });

  it('opening the library fills it', () => {
    expect(wiringJs.includes("tab === 'library'")).toBe(true);
    expect(wiringJs.includes('refreshPlanLibrary')).toBe(true);
    expect(planJs.includes('export async function refreshPlanLibrary')).toBe(true);
  });

  it('saving pushes to the cloud through the one shared key', () => {
    expect(planJs.includes("window.pushItemOnSave('plan', planSyncKey(p), p)")).toBe(true);
    expect(planJs.includes('function planSyncKey')).toBe(true);
  });
});

describe('the battery panel is attached to the module that drives it', () => {
  it('the page provides the pair button and every readout', () => {
    for (const id of ['btnEmbedPairBle', 'embedBleAssessmentBox', 'ebName', 'ebSoc',
                      'ebVolts', 'ebAmps', 'ebRemAh', 'ebSprintTime']) {
      expect(hasId(id)).toBe(true);
    }
  });

  it('and ble-motor.js still asks for them', () => {
    for (const id of ['btnEmbedPairBle', 'embedBleAssessmentBox', 'ebSoc', 'ebVolts']) {
      expect(binds(bleJs, id)).toBe(true);
    }
  });

  it('the readout starts hidden, because the module toggles it on connect', () => {
    // ble-motor.js does `boxEl.style.display = 'block'` on pair and 'none' on disconnect. If the
    // markup did not start hidden, an unpaired page would show empty readouts.
    expect(/id="embedBleAssessmentBox"[^>]*display:none/.test(html)).toBe(true);
  });

  it('the button label matches what the module resets it to', () => {
    // On `gattserverdisconnected` the module writes '⚡ Live Web Bluetooth Pair'. If the initial
    // markup said something else, the label would change once and never change back.
    // `Pairing BLE Client…` also contains "Pair" and is the label DURING a pair attempt, not the
    // one it returns to. Picking it made this test fail against markup that was correct.
    const reset = (bleJs.match(/btnPair\.textContent = '([^']+)'/g) || [])
      .map((m) => m.split("'")[1])
      .find((t) => t.includes('Pair') && !t.startsWith('Pairing'));
    expect(typeof reset).toBe('string');
    expect(html.includes(reset)).toBe(true);
  });
});

describe('the wiring that was replaced is gone, not merely outvoted', () => {
  it('plan-builder.js no longer binds the subtabs', () => {
    // Two listeners on one button: the old one hid #plan-builder unless the tab was called
    // `builder`, and the first tab is called `plan`. It only looked fine because
    // plan-tab-wiring.js is imported second and un-hid the panel on the same click.
    expect(live(planJs).includes("querySelectorAll('#panel-plan .subtabs button')")).toBe(false);
  });

  it('and nothing anywhere still queries a tab named "builder"', () => {
    // `builder` is the id of the DIV; `plan` is the name of the TAB. Confusing them is why
    // backToBuilderBtn threw on every press and why loading a plan left you in the library.
    for (const js of [planJs, wiringJs]) {
      expect(live(js).includes('data-plansub="builder"')).toBe(false);
    }
  });

  it('the two bare semicolons left where listeners were removed are cleared', () => {
    expect(/\n;\n\n;\n/.test(planJs)).toBe(false);
  });
});
