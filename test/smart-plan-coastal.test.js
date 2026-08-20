import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { COASTAL_ZONES, COASTAL_SLUGS } from '../js/data/coastal-zones.js';
import { resolveR2Key } from '../js/data/lake-keys.js';

const JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');
function walkJs(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walkJs(p, out);
    else if (e.endsWith('.js')) out.push(p);
  }
  return out;
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// smart-plan.js was v1 and was deleted 2026-08-20. Everything the block below asserted lived
// ONLY in that file, so these were green against code that had not run since v2 shipped.
const V2 = ['js/modules/smart-plan-v2.js', 'js/modules/smart-plan-v2-wiring.js',
            'js/modules/plan-preflight.js', 'js/modules/plan-prompt.js',
            'js/modules/plan-assemble.js', 'js/modules/plan-inputs.js']
  .map((f) => readFileSync(path.join(REPO, f), 'utf8')).join('\n');

// smart-plan.js imports Leaflet-bound modules at load time, so we assert the
// integration contract statically plus the data-level invariants that the
// coastal branch depends on.

describe('coastal mode — what v1 had and v2 does not', () => {
  // NOT DELETED, RECORDED. Six behaviours were asserted here against smart-plan.js and passed
  // for as long as v2 has been the planner that actually runs. Grepped across js/ on
  // 2026-08-20, every one of these names appears NOWHERE outside the deleted file:
  //
  //     buildCoastalContext        tide + salinity gathered for the prompt
  //     buildCoastalPromptBlock    that context injected into the model prompt
  //     coastalSafetyBlock         the inshore-kayak constraints
  //     COASTAL KAYAK RESTRICTION  the restriction text itself
  //     STRICT SAFETY CONSTRAINT   the same, stronger wording
  //     coastalCenter              prefer the zone centre for the forecast call
  //
  // The pieces they were built from are all still here -- getTideStateForZone in tide-engine.js,
  // assessZoneIntrusion in usgs-gauges.js, detectCoastalZone in plan-preflight.js -- so this is
  // a wiring gap, not lost knowledge. It is Ryan's call whether v2 gets them.
  //
  // TRIPWIRES: each fails the moment the name reappears, which forces a real contract to be
  // written instead of this note.
  const MISSING = ['buildCoastalContext', 'buildCoastalPromptBlock', 'coastalSafetyBlock',
                   'COASTAL KAYAK RESTRICTION', 'STRICT SAFETY CONSTRAINT', 'coastalCenter'];
  for (const name of MISSING) {
    it(`RECORDS A GAP: v2 has no ${name}`, () => {
      expect(V2.includes(name),
        `${name} is in v2 now — replace this tripwire with a real assertion`).toBe(false);
    });
  }

  it('the parts those were built from are still available to v2', () => {
    // If these go too, the gap stops being a wiring job and becomes a rebuild.
    for (const [f, sym] of [['js/modules/tide-engine.js', 'getTideStateForZone'],
                            ['js/modules/usgs-gauges.js', 'assessZoneIntrusion'],
                            ['js/modules/plan-preflight.js', 'detectCoastalZone']]) {
      expect(readFileSync(path.join(REPO, f), 'utf8').includes(sym), `${sym} in ${f}`).toBe(true);
    }
  });
});

describe('coastal weather lookup gap', () => {
  it('every coastal zone has a centre for the forecast call', () => {
    // COASTAL_ZONES is the fallback that closes the gap.
    for (const slug of COASTAL_SLUGS) {
      const [lat, lon] = COASTAL_ZONES[slug].center;
      expect(Number.isFinite(lat), `${slug} lat`).toBe(true);
      expect(Number.isFinite(lon), `${slug} lon`).toBe(true);
    }
  });

  it('RECORDS A GAP: v2 does not prefer the coastal centre for the forecast call', () => {
    // Same story as the block above — `coastalCenter` was v1 only. The catalog centres asserted
    // in the test above it are present and finite, so the data half of the fix is ready.
    expect(V2.includes('coastalCenter'),
      'v2 prefers the coastal centre now — write the real assertion').toBe(false);
  });

  it('nothing in the app imports js/data/lakes.js — the file is gone', () => {
    // js/data/lakes.js was deleted 2026-08-04. It had been listed as dead code three times
    // and was not dead: consolidate_lake_index.py read it as the ONLY source of USGS gauge
    // sites (Marion, Moultrie, Murray, Parr Shoals, Wateree), Duke and Dominion basin
    // bindings, normal/min pool elevations, and the curated ramp lists on 38 index rows.
    // Deleting it as written would have stripped all of that silently, because the index
    // still builds — it just builds without gauges.
    //
    // The data moved to registry/curated_lakes.json, beside the index it feeds, where it is
    // obviously pipeline input rather than an orphaned app module. What this test guards is
    // that it never comes BACK into js/ — a re-added lakes.js would be read by nothing and
    // would start the same misdiagnosis over.
    const offenders = [];
    for (const f of walkJs(JS)) {
      const cleaned = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      if (/from\s+['"][^'"]*data\/lakes\.js['"]/.test(cleaned) || /\bLAKE_DB\b/.test(cleaned)) {
        offenders.push(f.slice(JS.length + 1));
      }
    }
    expect(offenders).toEqual([]);
    expect(existsSync(path.join(JS, 'data', 'lakes.js'))).toBe(false);
  });
});

describe('coastal zone detection end to end', () => {
  it('every coastal display name is detected as coastal', () => {
    for (const slug of COASTAL_SLUGS) {
      const key = resolveR2Key(COASTAL_ZONES[slug].name);
      expect(key.startsWith('coast_'), `${slug} not detected`).toBe(true);
    }
  });

  it('freshwater lakes are not misdetected as coastal', () => {
    for (const name of ['Lake Murray, SC', 'Lake Wateree, SC', 'Lake Norman, NC']) {
      const key = resolveR2Key(name);
      expect(key?.startsWith('coast_') ?? false, `${name} misdetected`).toBe(false);
    }
  });
});
