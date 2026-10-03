// Personal use only, not for distribution or resale; not for navigation.
//
// Two things his 10/4 Moultrie plan said wrong the night before the trip, 2026-10-03.
//
// 1. "71.71 ft · full pool 76.8 ft". The 71.71 is the Russelville gauge's 72.76 on NAVD88, and the
//    76.8 is Marion's, copied over in August as "assumed equal to Lake Marion's 76.8; NOT separately
//    published". It is published: both Moultrie gauges' NWS pages carry "75.5: Full pool level as
//    defined by Santee Cooper." on the gauge's own scale. Ryan: "it should use whichever one is
//    correct lol". So where nothing else earns the difference, the pool gauge's own full-pool line
//    and its own reading do: 72.76 against 75.5, 2.74 ft down.
//
// 2. "R4 is rigged with a A-Rig Medium ... and never goes in the water on any leg ... this one buys
//    nothing", and the rigging list's "Not used on any leg or stop — no need to tie it on today",
//    about the rod the plan named as the fallback on seven of its eight legs.
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { chartDatumShape, gaugeFullPoolLine } from '../Worker/conditions.js';
import { assemblePlan } from '../js/modules/plan-assemble.js';
import { metresBetween } from '../js/modules/plan-candidates.js';
import { rodsAtLaunch, rodsAtLaunchHtml } from '../js/modules/rods-at-launch.js';
import { esc } from '../js/utils/escape.js';

const WORKER = readFileSync(new URL('../Worker/conditions.js', import.meta.url), 'utf8');
const BUILDER = readFileSync(new URL('../js/modules/plan-builder.js', import.meta.url), 'utf8');

// The binding verbatim from water_bindings.json (pool LMIS1, NAVD88 nrldb -1.05) and the full_pool.json
// row as it stood on 2026-10-03.
const MOULTRIE = { slug: 'lake_moultrie', display_name: 'Lake Moultrie (Berkeley Co, SC)',
                   feature_type: 'lake', state: 'SC',
                   pool: { lid: 'LMIS1', name: 'Lake Moultrie near Russelville',
                           datum: { name: 'NAVD88', nrldb: -1.05 } },
                   levels: { primary: 'nws:HP' } };
const INHERITED = { ft: 76.8, source: "assumed equal to Lake Marion's 76.8; NOT separately published",
                    datum: null };
// The pool reading's flood context as /conditions carried it at 22:00Z on 2026-10-03.
const LMIS1 = { lid: 'LMIS1', name: 'Lake Moultrie near Russelville', stage: 72.76,
                flood_context: { impacts: { all: [
                  { stage: 74, statement: 'Normal operating level as defined by Santee Cooper.' },
                  { stage: 75.5, statement: 'Full pool level as defined by Santee Cooper.' }] } } };

describe('the full pool comes off the gauge, on the gauge\'s own scale', () => {
  it('reads the line that defines full pool and nothing else', () => {
    expect(gaugeFullPoolLine(LMIS1)).toEqual({ ft: 75.5,
      statement: 'Full pool level as defined by Santee Cooper.', lid: 'LMIS1',
      name: 'Lake Moultrie near Russelville' });
    // Every one of the 31 lines found on 2026-10-03 opens with the words, "normal" allowed first.
    const one = (statement) => gaugeFullPoolLine({ flood_context: { impacts: { all: [{ stage: 660, statement }] } } });
    expect(one('NORMAL FULL POOL ELEVATION.  GAGE LOCATED NEAR BOAT LANDING').ft).toBe(660);
    expect(one('Full Pool. Water begins flowing over the uncontrolled spillway').ft).toBe(660);
    // A sentence about water above or below it is not a definition of it.
    expect(one('Docks flood when the lake is 2 ft above full pool')).toBeNull();
    expect(gaugeFullPoolLine({ flood_context: { impacts: { all: [] } } })).toBeNull();
    expect(gaugeFullPoolLine(null)).toBeNull();
  });

  it('two full-pool lines at two stages is no answer', () => {
    const two = { flood_context: { impacts: { all: [{ stage: 75.5, statement: 'Full pool' },
                                                     { stage: 76.8, statement: 'Full pool' }] } } };
    expect(gaugeFullPoolLine(two)).toBeNull();
  });

  it('Moultrie: 72.76 against 75.5 is 2.74 ft down, and Marion\'s 76.8 is kept beside it', () => {
    const r = chartDatumShape(MOULTRIE, { fullPool: INHERITED, gaugeStageFt: 72.76,
                                          gaugeFullPool: gaugeFullPoolLine(LMIS1) });
    expect(r.level_ft).toBe(72.76);
    expect(r.full_pool_ft).toBe(75.5);
    expect(r.below_full_pool_ft).toBe(2.74);
    expect(r.full_pool_source).toContain('Full pool level as defined by Santee Cooper.');
    expect(r.full_pool_source).toContain('LMIS1');
    // annotate, never filter: the NAVD88 figure and the registry's number are both still said.
    expect(r.datum_note).toContain('NAVD88');
    expect(r.datum_note).toContain('71.71');
    expect(r.full_pool_registry_ft).toBe(76.8);
    expect(r.datum_note).toContain('76.8');
  });

  it('without the line, the two marks still withhold the difference as before', () => {
    const r = chartDatumShape(MOULTRIE, { fullPool: INHERITED, gaugeStageFt: 72.76 });
    expect(r.level_ft).toBe(71.71);
    expect(r.full_pool_ft).toBe(76.8);
    expect(r.below_full_pool_ft).toBeNull();
    expect(r.datum_note).toMatch(/different marks/);
  });

  it('a difference the registry already earns is left alone', () => {
    // Norman: the gauge zero reconciles with full pool (660 + 100 = 760). Its "100: Full Pool."
    // line says the same thing, and the elevation stays the number shown.
    const NORMAN = { slug: 'lake_norman', display_name: 'Lake Norman (Catawba Co, NC)', feature_type: 'lake',
                     pool: { lid: 'CWAN7', datum: { name: 'NGVD29', nrldb: 660 } }, levels: { primary: 'nws:HP' } };
    const r = chartDatumShape(NORMAN, { fullPool: { ft: 760, source: 'x' }, gaugeStageFt: 97.44,
      gaugeFullPool: { ft: 100, statement: 'Full Pool.', lid: 'CWAN7', name: 'x' } });
    expect(r.level_ft).toBe(757.44);
    expect(r.full_pool_ft).toBe(760);
    expect(r.below_full_pool_ft).toBe(2.56);
  });

  it('an operator-settled full pool that disagrees with the gauge line is kept, and the line is said', () => {
    // Lake Lure, 2026-10-03: the town publishes 990.5 MSL; LRDN7 says "990: FULL POOL STAGE.".
    const LURE = { slug: 'lake_lure', display_name: 'Lake Lure (Rutherford Co, NC)', feature_type: 'lake',
                   pool: { lid: 'LRDN7', datum: null }, levels: { primary: 'nws:HP' } };
    const TOWN = { ft: 990.5, source: 'Town of Lake Lure (OPERATOR). "Full pond in Lake Lure is 990.5 MSL."',
                   datum: null, status: 'RESOLVED' };
    const r = chartDatumShape(LURE, { fullPool: TOWN, gaugeStageFt: 989.42,
      gaugeFullPool: { ft: 990, statement: 'FULL POOL STAGE.', lid: 'LRDN7', name: 'Lake Lure Dam' } });
    expect(r.full_pool_ft).toBe(990.5);
    expect(r.below_full_pool_ft).toBeNull();
    expect(r.gauge_full_pool_ft).toBe(990);
    expect(r.datum_note).toContain('FULL POOL STAGE.');
    // ...and where the two agree, the gauge line earns the difference as on Moultrie.
    const same = chartDatumShape(LURE, { fullPool: { ...TOWN, ft: 990 }, gaugeStageFt: 989.42,
      gaugeFullPool: { ft: 990, statement: 'FULL POOL STAGE.', lid: 'LRDN7', name: 'x' } });
    expect(same.below_full_pool_ft).toBe(0.58);
  });

  it('a lake with no registry row gets its difference from the gauge line alone', () => {
    // Lake Summit's EFLN7, 2026-10-03: "100: FULL POOL - 356 CFS", reading 100.31.
    const SUMMIT = { slug: 'lake_summit', display_name: 'Lake Summit (Henderson Co, NC)', feature_type: 'lake',
                     pool: { lid: 'EFLN7', datum: null } };
    const r = chartDatumShape(SUMMIT, { fullPool: null, gaugeStageFt: 100.31,
      gaugeFullPool: { ft: 100, statement: 'FULL POOL - 356 CFS', lid: 'EFLN7', name: 'Green River (NC) at Lake Summit Dam' } });
    expect(r.below_full_pool_ft).toBe(-0.31);
    expect(r.pending).toBeNull();
    // and with neither, it still says why rather than returning nulls
    expect(chartDatumShape(SUMMIT, { fullPool: null, gaugeStageFt: 100.31 }).pending).toBeTruthy();
  });

  it('the Worker hands the pool reading\'s line to the shape', () => {
    expect(WORKER).toContain('gaugeFullPool: gaugeFullPoolLine(poolReading)');
    // and reads the row's settled state under the name the PUBLISHED copy uses. The first cut read
    // only `full_pool_status`, which is the pipeline file's name; R2's copy says `status`, so Lake
    // Lure's town figure was overruled live anyway.
    expect(WORKER).toContain('status: row.status || row.full_pool_status || null');
  });
});

// ── THE ROD THAT IS THE FALLBACK ────────────────────────────────────────────────────────────────

const LAUNCH = [-80.7300, 34.3800];
const routed = (a, b) => ({ distanceM: metresBetween(a, b), coordinates: [a, b] });
function leg(id, fromLon, toLon, lat, depthFt, extra = {}) {
  const coordinates = [];
  for (let i = 0; i <= 10; i++) coordinates.push([fromLon + (toLon - fromLon) * i / 10, lat]);
  return {
    runId: id, runIndex: Number(id.split('#')[1]), startM: 0,
    lengthM: Math.abs(toLon - fromLon) * 111320 * Math.cos(lat * Math.PI / 180),
    depthFt, start: coordinates[0], end: coordinates[coordinates.length - 1],
    coordinates, passes: [], support: null, ...extra,
  };
}
const build = (fallback) => assemblePlan({
  transit: routed,
  candidates: [leg('w#1', -80.7200, -80.6800, 34.3800, 22.4, fallback ? { ifNotProducing: fallback } : {}),
               leg('w#2', -80.6700, -80.6400, 34.3850, 31)],
  launch: LAUNCH,
  loadout: { rods: [
    { id: 'R1', rig: 'fluoro', role: 'troll', lure: 'MR Crankbait (6-12ft)', color: 'Chartreuse Shad' },
    { id: 'R3', rig: 'fluoro', role: 'troll', lure: 'Squarebill Crankbait', color: 'Natural Shad' },
    { id: 'R5', rig: 'snap', role: 'troll', lure: 'Flutter Spoon', color: 'Chrome' },
  ] },
  deploy: { 'w#1': { port: 'R1', starboard: 'R5' }, 'w#2': { port: 'R1', starboard: 'R5' } },
  slug: 'wateree_lake', water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-09-26',
  launchTime: '08:00', returnTime: '16:00', usableAh: 80, species: ['Striped Bass'],
  conditions: { waterTempF: 78, clarity: 'Stained' },
  safety: { isGo: true, warning: '', rampEvaluation: 'sheltered' },
});
const unused = (plan) => plan.warnings.filter((w) => /never goes in the water on any leg/.test(w));

describe('a rod named as the fallback is not rigged for nothing', () => {
  it('the plan does not tell him the backup rod buys nothing', () => {
    const plan = build({ rodId: 'R3', insteadOf: 'R1', why: 'it runs shallower' });
    expect(plan.legs.find((l) => l.runId === 'w#1').ifNotProducing.rodId).toBe('R3');
    expect(unused(plan).some((w) => w.includes('R3'))).toBe(false);
  });

  it('and a rod that is neither in the water nor anybody\'s fallback still is told so', () => {
    expect(unused(build(null)).some((w) => w.includes('R3'))).toBe(true);
  });
});

describe('the rigging list says to tie the backup rod on', () => {
  const LOADOUT = { rods: [
    { id: 'R1', rig: 'fluoro', lure: 'DD3 Crankbait (20-25ft)' },
    { id: 'R2', rig: 'fluoro', lure: 'DD2 Crankbait (16-20ft)' },
    { id: 'R3', rig: 'fluoro', lure: 'A-Rig Heavy (~3.5oz) – 5" Swimbait' },
    { id: 'R4', rig: 'fluoro', lure: 'A-Rig Medium (~2.65oz) – 4.6" Swimbait' },
  ] };
  const ROW = (key, port, stbd, extra) => ({ type: 'troll', key, estStartTime: '06:02',
    rods: [{ side: 'Port', rod: port, lure: 'x' }, { side: 'Stbd', rod: stbd, lure: 'y' }], ...extra });

  it('off the field on a file saved from now on', () => {
    const p = { plan: { loadout: LOADOUT }, timeline: [
      ROW('L1', 'R3', 'R1', { ifNotProducing: { rodId: 'R4', insteadOf: 'R1' } }),
      ROW('L2', 'R3', 'R1', { ifNotProducing: { rodId: 'R4', insteadOf: 'R1' } }),
      ROW('L3', 'R3', 'R1', { ifNotProducing: { rodId: 'R2', insteadOf: 'R1' } }),
      ROW('L4', 'R3', 'R1', { ifNotProducing: { rodId: 'R4', insteadOf: 'R3' } }),
    ] };
    const r4 = rodsAtLaunch(p).rods.find((r) => r.id === 'R4');
    expect(r4.status).toBe('backup');
    expect(r4.backup).toContain('L1–L2, L4');
    expect(r4.backup).toContain('in place of R1 or R3');
    const html = rodsAtLaunchHtml(p, esc);
    expect(html).toContain('tie it on before you leave');
    expect(html).not.toContain('no need to tie it on today');
  });

  it('off the sentence on the file he saved for 10/4, which has no field', () => {
    // His saved row's own words.
    const why = 'This leg launches straight off the ramp in the dark. If they are not producing: '
      + 'put R4 (A-Rig Medium (~2.65oz) – 4.6" Swimbait) on in place of R1 — In the dark and at first '
      + 'light fish sit higher.. In the water here: 18–25 ft.';
    const p = { plan: { loadout: LOADOUT }, timeline: [ROW('L1', 'R3', 'R1', { why })] };
    const r4 = rodsAtLaunch(p).rods.find((r) => r.id === 'R4');
    expect(r4.status).toBe('backup');
    expect(r4.backup).toContain('in place of R1');
  });

  it('a rod that fishes AND backs up elsewhere says both', () => {
    const p = { plan: { loadout: LOADOUT }, timeline: [
      ROW('L1', 'R3', 'R1', { ifNotProducing: { rodId: 'R2', insteadOf: 'R1' } }),
      ROW('L2', 'R3', 'R2'),
    ] };
    const r2 = rodsAtLaunch(p).rods.find((r) => r.id === 'R2');
    expect(r2.status).toBe('fishes');
    expect(r2.backup).toContain('L1');
  });

  it('the saved timeline row carries the field', () => {
    expect(BUILDER).toContain('ifNotProducing: e.ifNotProducing || null,');
  });
});
