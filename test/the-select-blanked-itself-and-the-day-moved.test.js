import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A `<select>` SET TO A VALUE IT DOES NOT HOLD BECOMES EMPTY, AND SAYS NOTHING
//
// Ryan, 2026-09-17, on the Congaree bench that exported `rampName: ""`: *"no ramp may have been my
// fault... i forgot that the plan tab doesn't auto populate it from the map dropdown like it does
// for lakes for some reason."* There was a reason and it was not him.
//
// The map's ramp dropdown is filled from the access index — the live SCDNR / NCWRC / GA WRD / TWRA
// feeds. The Plan tab's `#planRamp` is filled by populatePlanRampDropdown(), which on the six
// curated PLAN_RIVERS offers HAND-WRITTEN launch names instead. `onRampChange()` assigned the feed's
// spelling straight into that select; no option matched; and the HTML spec says a select whose value
// is set to a string none of its options carry has its value set to the empty string. No throw, no
// warning. So it worked on every lake and failed on exactly six rivers.
//
// AND THE CONSEQUENCE WAS NOT A MISSING LABEL. `rampCoords()` ended `|| points[0]`, so an empty ramp
// field planned the day from whatever launch the merged index listed first. On the Congaree that is
// Barney Jordan and the plan was right by luck. On the Lumber it is WAGRAM, at river station 16,450
// of a 219,600 m centreline whose every charted feature sits between 211,650 and 219,600 — and since
// the reaches are laid out walking outward from the ramp's station, that is not a wrong label, it is
// a different river.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const REPO = new URL('..', import.meta.url);
const read = (f) => readFileSync(new URL(f, REPO), 'utf8');

const { matchRampIndex, normRampName, RAMP_SAME_M, metresApart } =
  await import('../js/utils/ramp-match.js');

// THE MATCHER IS TESTED AND THE DOM IS NOT, ON PURPOSE. Importing lake-ramp-select.js needs a
// Leaflet stub, a document stub and a fetch stub, and it still never returns under `node --test` --
// picker-order.test.js does exactly that and hangs, which is how this was found. The rule that broke
// is a pure comparison, so it lives in js/utils/ramp-match.js and is checked here; the two lines of
// DOM that call it are checked against the source below.

describe('the same launch under two spellings', () => {
  // The curated Congaree launches, as PLAN_RIVERS carries them.
  const ROWS = [
    { name: 'Barney Jordan (Columbia)', lat: 33.96490, lon: -81.03570 },
    { name: 'Thomas H Newman (Columbia)', lat: 33.94915, lon: -81.02951 },
    { name: 'Bates Bridge (near Wateree confluence)', lat: 33.75342, lon: -80.64513 },
  ];

  it('matches an exact name', () => {
    expect(matchRampIndex(ROWS, 'Barney Jordan (Columbia)', null, null)).toBe(0);
  });

  it('matches a containment either way, which is what two feeds do to one name', () => {
    expect(matchRampIndex(ROWS, 'Barney Jordan', null, null)).toBe(0);
    expect(matchRampIndex(ROWS, 'Barney Jordan (Columbia) - SCDNR', null, null)).toBe(0);
  });

  it('MATCHES ON POSITION WHEN NOT ONE WORD IS SHARED — the whole bug', () => {
    // What the DNR feed calls the same slab of concrete, 4 m away.
    expect(matchRampIndex(ROWS, 'BARNEY JORDAN LANDING', 33.96493, -81.03570)).toBe(0);
  });

  it('a launch further off than the radius is a different launch', () => {
    expect(matchRampIndex(ROWS, 'Somewhere Else', 33.96490 + 0.02, -81.03570)).toBe(-1);
    expect(metresApart(33.96490, -81.03570, 33.96490 + 0.02, -81.03570) > RAMP_SAME_M).toBe(true);
  });

  it('a row with no coordinates cannot be matched by position, and says so', () => {
    expect(matchRampIndex([{ name: 'Barney Jordan (Columbia)' }], 'BARNEY JORDAN LANDING',
                          33.96490, -81.03570)).toBe(-1);
  });

  it('THE NAME BEATS THE POSITION, so a named row wins over a nearer unnamed one', () => {
    const close = [
      { name: 'North Slip', lat: 33.00000, lon: -80.00000 },
      { name: 'South Slip', lat: 33.00009, lon: -80.00000 },   // 10 m away, inside the radius
    ];
    expect(metresApart(33.00000, -80.00000, 33.00009, -80.00000) < RAMP_SAME_M).toBe(true);
    // Standing at the NORTH slip's coordinates and naming the SOUTH one gets the south one.
    expect(matchRampIndex(close, 'South Slip', 33.00000, -80.00000)).toBe(1);
  });

  it('AND 60 m IS SAFE AGAINST THE TIGHTEST REAL PAIR, which was measured and not assumed', () => {
    // Every distinct pair of the 27 curated PLAN_RIVERS launches, closest first: Bushy Park's two
    // (fresh and salt, genuinely different water) are 90 m apart and Hope Ferry / Saluda Shoals Park
    // are 109 m. So the radius has 30 m of headroom against the nearest thing it must NOT collapse.
    //
    // THE FIRST DRAFT OF THIS TEST CLAIMED BUSHY PARK WAS 40 m AND FAILED ON ITS OWN PREMISE. The
    // number was never measured; it was written because it made the point. That is the failure this
    // project keeps writing down, so the measurement stays in the file.
    const bushyM = metresApart(32.96781, -79.93751, 32.96708, -79.93709);
    expect(Math.round(bushyM)).toBe(90);
    expect(bushyM > RAMP_SAME_M).toBe(true);
    expect(Math.round(metresApart(34.04600, -81.19128, 34.04679, -81.19058))).toBe(109);
  });

  it('nothing named and nowhere given is no match, never row zero', () => {
    expect(matchRampIndex(ROWS, '', null, null)).toBe(-1);
    expect(matchRampIndex(ROWS, null, null, null)).toBe(-1);
    expect(matchRampIndex([], 'Barney Jordan', 33.9649, -81.0357)).toBe(-1);
  });

  it('the name normalisation is the one every caller had its own copy of', () => {
    expect(normRampName('  Barney  JORDAN (Columbia) ')).toBe('barney jordan columbia');
    expect(normRampName(null)).toBe('');
  });
});

// AND THE HTML RULE THAT TURNED A MISMATCH INTO SILENCE, written down once because it is the reason
// the matcher has to exist at all: a `<select>` assigned a value none of its options carry has its
// value set to the empty string, and does not throw.
describe('a select set to a value it does not hold becomes empty', () => {
  it('is the behaviour, and it is why the old assignment failed silently', () => {
    const sel = {
      options: [{ value: 'Barney Jordan (Columbia)' }], _value: '',
      get value() { return this._value; },
      set value(v) {
        const hit = this.options.find((o) => o.value === String(v));
        this._value = hit ? hit.value : '';
      },
    };
    sel.value = 'BARNEY JORDAN LANDING';
    expect(sel.value).toBe('');
    sel.value = 'Barney Jordan (Columbia)';
    expect(sel.value).toBe('Barney Jordan (Columbia)');
  });
});

describe('the curated river options carry their own coordinates', () => {
  // Source-level, because populatePlanRampDropdown() reaches the whole plan-builder module and this
  // is a two-line contract: both branches of one function must write the same dataset. The
  // access-index branch has carried it since the live feeds arrived; the curated branch did not.
  const src = read('js/modules/plan-builder.js');
  it('the curated branch sets dataset.lat and dataset.lon like the access branch does', () => {
    const fn = src.slice(src.indexOf('export function populatePlanRampDropdown'));
    const curated = fn.slice(fn.indexOf('getPlanRiverRamps(curated)'), fn.indexOf('// THE ACCESS INDEX IS FOR EVERY WATER'));
    expect(curated).toContain('opt.dataset.lat');
    expect(curated).toContain('opt.dataset.lon');
  });
});

describe('nothing named is not a reason to guess a launch', () => {
  const src = read('js/modules/smart-plan-v2-wiring.js');
  it('rampCoords no longer falls through to the first row of a merged index', () => {
    const fn = src.slice(src.indexOf('export function rampCoords'), src.indexOf('function minutesBetween'));
    expect(fn).not.toContain('|| points[0]');
    expect(fn).toContain('if (!normRampName(rampName)) return null;');
  });
  it('and it reads the chosen option before it reads the index', () => {
    const fn = src.slice(src.indexOf('export function rampCoords'), src.indexOf('function minutesBetween'));
    expect(fn.indexOf('option:checked')).toBeLessThan(fn.indexOf('getLoadedAccessIndex'));
  });
  it('the planner says which of the two refusals it is', () => {
    expect(src).toContain('Select a ramp / launch first');
    expect(src).toContain('Could not place');
  });
});

describe('the two lines of DOM that call the matcher', () => {
  const src = read('js/modules/lake-ramp-select.js');
  const fn = src.slice(src.indexOf('export function syncPlanRamp'));
  it('builds its rows from the options own dataset coordinates', () => {
    expect(fn).toContain('matchRampIndex(rows, name, lat, lon)');
    expect(fn).toContain("parseFloat(o.dataset.lat)");
  });
  it('adds the option rather than assigning a value the select cannot hold', () => {
    expect(fn.indexOf('sel.appendChild(hit)')).toBeLessThan(fn.indexOf('sel.value = hit.value'));
  });
  it('fires change, because setting value in script does not', () => {
    expect(fn).toContain("dispatchEvent(new Event('change'");
  });
  it('and onRampChange no longer assigns the feed name straight in', () => {
    const on = src.slice(src.indexOf('function onRampChange'), src.indexOf('export function syncPlanRamp'));
    expect(on).toContain('syncPlanRamp(selOpt.value, lat, lon)');
    expect(on).not.toContain('planRampEl.value = selOpt.value');
  });
});
