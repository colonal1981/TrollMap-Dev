import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { COASTAL_ZONES, COASTAL_SLUGS } from '../js/data/coastal-zones.js';
import { resolveR2Key } from '../js/data/lake-keys.js';
import { coastalPromptBlock } from '../js/modules/plan-prompt.js';

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
const V2 = ['js/modules/smart-plan-v2.js', 'js/modules/smart-plan-v2-wiring.js',
            'js/modules/plan-preflight.js', 'js/modules/plan-prompt.js',
            'js/modules/plan-assemble.js', 'js/modules/plan-inputs.js']
  .map((f) => readFileSync(path.join(REPO, f), 'utf8')).join('\n');

// ─────────────────────────────────────────────────────────────────────────────
// THE TRIPWIRES FIRED, WHICH IS WHAT THEY WERE FOR.
//
// This block used to hold six `RECORDS A GAP: v2 has no <name>` assertions — greps that would
// fail the moment a v1 name reappeared in v2, forcing a real contract to be written instead of a
// note. Ryan, 2026-08-20: *"yes v2 gets them... it should never have not had them... are there
// any river specifics that are missing as well... if so fix that too"*. So the gap is closed and
// the tripwires are replaced by the contracts they were holding a place for.
//
// TWO OF THE SIX WERE NEVER TRUE, AND THAT IS THE LESSON WORTH KEEPING: a grep for a NAME is not
// a check on a BEHAVIOUR.
//
//   `coastalCenter` — v1's variable name. fetchForecast() in plan-preflight.js has preferred
//   `COASTAL_ZONES[zoneKey].center` over the lake centroid since it was written; it just spells
//   the variable `centre`. The tripwire said the behaviour was missing and it was there, green
//   the whole time, because the string was not.
//
//   `COASTAL KAYAK RESTRICTION` — v1's weaker wording for the same rule v2 now writes as
//   STRICT SAFETY CONSTRAINT. Absence of that phrase never meant absence of the restriction.
//
// So the assertions below test what the prompt SAYS and what the code DOES, not what it is
// called.
// ─────────────────────────────────────────────────────────────────────────────

/** A tide state shaped the way fetchWaterState() emits one. */
const TIDAL = {
  featureType: 'coastal',
  tidal: {
    zone: 'Charleston Harbor, SC', station: '8665530',
    stage: 'ebb', stageLabel: 'Falling (ebb)',
    heightFtAboveMllw: 3.2, dailyRangeFt: 5.4,
    nextEvent: { type: 'low', at: '11:42', heightFt: 0.3 },
    currentKn: 1.4, currentType: 'ebb', surgeVsPredictedFt: 0.6, salinityPpt: 22.4,
    depthBandFt: [4, 8],
    tactic: 'Falling water — set up on oyster points and creek mouths as bait flushes out.',
    freshwaterIntrusion: { message: 'Santee discharge is 2.1x its 30-day mean', rivers: 'Santee River' },
  },
};

describe('coastal mode — what v2 has now', () => {
  it('the inshore restriction reaches the prompt, in the strong wording', () => {
    // THE ONE RULE IN THE WHOLE PROMPT THAT IS ABOUT STAYING ALIVE. Between v1's deletion and
    // 2026-08-20, a plan on Charleston Harbour was built by a prompt that had never been told
    // this is a 12.5 ft pedal kayak on an estuary.
    const b = coastalPromptBlock(TIDAL);
    expect(b).toContain('STRICT SAFETY CONSTRAINT');
    expect(b).toContain('INSHORE');
    expect(b).toMatch(/never route past the jetties/i);
    expect(b).toMatch(/12\.5 ft pedal kayak/i);
  });

  it('and the constraint is in the module the model actually reads', () => {
    expect(V2).toContain('STRICT SAFETY CONSTRAINT');
    expect(V2).toContain('coastalPromptBlock(o.waterState)');
  });

  it('the tide is gathered before the model call', () => {
    // v1 spelled this buildCoastalContext(); v2 spells it fetchWaterState() and gathers the
    // river with it, because a planner that reads one and not the other is the same gap twice.
    expect(V2).toContain('fetchWaterState');
    expect(V2).toContain('getTideStateForZone');
    expect(V2).toContain('assessZoneIntrusion');
    const wiring = readFileSync(path.join(REPO, 'js/modules/smart-plan-v2-wiring.js'), 'utf8');
    expect(wiring).toContain('await fetchWaterState(');
    expect(wiring).toContain('waterState,');
  });

  it('the same prompt is built when the water was picked off the map', () => {
    // Two plans behaving differently on the same boat on the same water is the divergence
    // plan-water-ui.js' own header warns about.
    const ui = readFileSync(path.join(REPO, 'js/modules/plan-water-ui.js'), 'utf8');
    expect(ui).toContain('await fetchWaterState(');
    expect(ui).toContain('waterState,');
  });

  it('the tide-stage depth band and tactic are carried, not just the numbers', () => {
    const b = coastalPromptBlock(TIDAL);
    expect(b).toContain('4–8 ft');
    expect(b).toMatch(/TIDE-CORRECTED/);
    expect(b).toContain('oyster points and creek mouths');
  });

  it('freshwater intrusion names the rivers and says what to do about it', () => {
    const b = coastalPromptBlock(TIDAL);
    expect(b).toContain('FRESHWATER INTRUSION');
    expect(b).toContain('Santee River');
    expect(b).toMatch(/penalise the upper creeks/i);
  });

  it('an unread tide says so instead of going quiet', () => {
    // A COLD SOURCE IS NOT CALM WATER. The safety rule has to survive the station being down.
    const b = coastalPromptBlock({ featureType: 'coastal', tidal: { zone: 'Winyah Bay, SC' } });
    expect(b).toContain('STRICT SAFETY CONSTRAINT');
    expect(b).toMatch(/TIDE STAGE IS UNKNOWN/);
    expect(b).toMatch(/say in the plan that the tide was not read/i);
  });

  it('a reservoir prompt is unchanged — the block is empty, not blank-lined', () => {
    expect(coastalPromptBlock(null)).toBe('');
    expect(coastalPromptBlock({ featureType: 'lake', river: {}, tidal: null })).toBe('');
  });

  it('the parts it is built from are still where v2 reaches for them', () => {
    for (const [f, sym] of [['js/modules/tide-engine.js', 'getTideStateForZone'],
                            ['js/modules/usgs-gauges.js', 'assessZoneIntrusion'],
                            ['js/modules/coastal-scoring.js', 'DEPTH_BANDS'],
                            ['js/modules/coastal-scoring.js', 'tacticalNote'],
                            ['js/modules/plan-preflight.js', 'detectCoastalZone']]) {
      expect(readFileSync(path.join(REPO, f), 'utf8').includes(sym), `${sym} in ${f}`).toBe(true);
    }
  });
});

describe('coastal weather lookup', () => {
  it('every coastal zone has a centre for the forecast call', () => {
    for (const slug of COASTAL_SLUGS) {
      const [lat, lon] = COASTAL_ZONES[slug].center;
      expect(Number.isFinite(lat), `${slug} lat`).toBe(true);
      expect(Number.isFinite(lon), `${slug} lon`).toBe(true);
    }
  });

  it('the forecast prefers the zone centre over the lake centroid', () => {
    // The behaviour the `coastalCenter` tripwire claimed was missing. It reads the COASTAL_ZONES
    // centre FIRST and falls back to lakeDbEntryFor — assert the order, since a fallback that
    // ran first would be the bug.
    const src = readFileSync(path.join(REPO, 'js/modules/plan-preflight.js'), 'utf8');
    const zoneAt = src.indexOf('COASTAL_ZONES[zoneKey] || {}).center');
    const lakeAt = src.indexOf('lakeDbEntryFor(lakeName) || {}).center');
    expect(zoneAt > 0, 'zone centre not read').toBe(true);
    expect(lakeAt > 0, 'lake centroid fallback not read').toBe(true);
    expect(zoneAt < lakeAt, 'the lake centroid is being preferred over the zone centre').toBe(true);
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
