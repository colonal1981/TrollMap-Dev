// A SAVED PLAN COMES BACK AS THE PLAN, AND THE FISH ID REACHES THE MODEL.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-09-27, the night before a Wateree trip: "i refreshed the page which cleared the plan
// i imported the json but it didn't rebuild the plan on the plan tab and it doesn't show in saved
// plans". Import JSON and Saved Plans' Load both ran loadPlanIntoForm(), which put back the form
// and nothing of the day -- no leg cards, no lines on the map -- although every piece of it was in
// the file. And the import never saved, so the next refresh lost it again.
//
// Checked in Chromium on his own file (Lake_Wateree_–_Clearwater_AM_Troll_Sep_28.json): the leg
// cards for all five legs draw, the map carries every leg colour including Leg 1's cyan, and the
// plan lands in Saved Plans.
//
// Same evening, the first catch drop to reach /identify-catch came back from Gemini with a 400:
// "Unknown name \"type\" at 'generation_config.response_schema.properties[3].value'". The schema
// spelled a nullable number the JSON-Schema way, `type: ["NUMBER", "NULL"]`, which Gemini's
// OpenAPI subset refuses outright.
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');
const pb = src('js/modules/plan-builder.js');
const body = (s, head) => {
  const i = s.indexOf(head);
  return i < 0 ? '' : s.slice(i, s.indexOf('\n}\n', i));
};

describe('loading a saved plan redraws the day', () => {
  const load = body(pb, 'function loadPlanIntoForm(');
  const restore = body(pb, 'function restorePlanView(');

  it('the form load goes on to the plan itself', () => {
    expect(load.includes('restorePlanView(p)')).toBe(true);
  });

  it('draws with the renderer the build path uses, from the saved timeline', () => {
    expect(restore.includes('renderSmartPlanUI({')).toBe(true);
    expect(restore.includes('cardDefs, unified')).toBe(true);
    expect(restore.includes("e.type === 'troll'")).toBe(true);
  });

  it('puts the lines back in their card colours, flagged as the plan\'s', () => {
    expect(restore.includes('p.gpx.trackList')).toBe(true);
    expect(restore.includes('color: c ? c.color : undefined')).toBe(true);
    expect(restore.includes('smartPlan: true')).toBe(true);
  });

  it('keeps the plan and model blocks so a re-save writes them back', () => {
    expect(restore.includes('window._planV2 = p.plan')).toBe(true);
    expect(restore.includes('plan: p.plan, request:')).toBe(true);
  });

  it('never calls the model', () => {
    expect(/askModel|runSmartPlanV2|buildSmartPlanV2|fetch\(/.test(restore)).toBe(false);
  });

  it('a file with no timeline gets the form alone, as before', () => {
    expect(restore.includes('if (!unified || !p.plan')).toBe(true);
  });
});

describe('an imported plan is kept', () => {
  const imp = pb.slice(pb.indexOf("getElementById('importPlanFile')"),
                       pb.indexOf("getElementById('importPlanFile')") + 2500);

  it('is saved to the library and pushed like a Save', () => {
    expect(imp.includes("dbPut('plans', rec)")).toBe(true);
    expect(imp.includes('refreshPlanLibrary()')).toBe(true);
    expect(imp.includes("pushItemOnSave('plan', planSyncKey(rec), rec)")).toBe(true);
  });

  it('and importing the same file twice replaces its own copy', () => {
    expect(imp.includes('x.savedAt === p.savedAt')).toBe(true);
    expect(imp.includes('rec.id = same.id')).toBe(true);
  });
});

describe('the fish ID schema is one Gemini accepts', () => {
  const w = src('Worker/trollmap-worker.js');
  const schema = w.slice(w.indexOf('var CATCH_JSON_SCHEMA'), w.indexOf('async function handleIdentifyCatch('));

  it('has no list-valued type anywhere in it', () => {
    expect(schema.length > 0).toBe(true);
    expect(/type:\s*\[/.test(schema)).toBe(false);
  });

  it('says a missing length the OpenAPI way', () => {
    expect(schema.includes('length_inches: { type: "NUMBER", nullable: true }')).toBe(true);
  });
});
