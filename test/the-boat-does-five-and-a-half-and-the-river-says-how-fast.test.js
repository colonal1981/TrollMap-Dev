/**
 * test/the-boat-does-five-and-a-half-and-the-river-says-how-fast.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * 50 of 56 rivers got gauge readings and no go/no-go, because the only thing that could decide one
 * was a table of hand-set cfs bands for six rivers. Measured 2026-09-24 against those six over 36
 * years of daily flow, neither published alternative measures what the bands measure: NWS action
 * stage sits above every danger line (Wateree 12,031 cfs against 8,000), and "high for the date"
 * called the Wateree GO on 1,601 of the 2,854 days the bands call no-go.
 *
 * What does is how fast the water is moving -- V = Q/A over the pack's charted cross-sections --
 * against how fast the boat goes. Ryan: "full speed with the nk180pro flat on a lake is somewhere
 * around 5.5mph pedaling does not add anything to this really".
 *
 *   node --test test/the-boat-does-five-and-a-half-and-the-river-says-how-fast.test.js
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { slimCentreline, slimLandings, stationAt, stretchAround, currentBetween, currentVerdict,
         packSlugFor, BOAT, REAL_SECTION_FT } from '../Worker/river-geometry.js';
import { RIVERS } from '../Worker/worker-data.js';

const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// A straight river 1 km long, a station every 100 m, east from (34, -80). Every section is 100 m2
// with 6 ft in it, except one uncharted station and one thin one -- the two the guard must drop.
function toyRiver() {
  const n = 11, coords = [], st = [], area = [], deep = [];
  for (let i = 0; i < n; i += 1) {
    coords.push([-80 + i * 0.0010865, 34]);   // ~100 m of longitude at 34N
    st.push(i * 100); area.push(100); deep.push(6);
  }
  area[3] = null; deep[3] = null;             // uncharted
  area[7] = 5; deep[7] = 1;                   // thin chart: 1 ft
  const fc = { features: [{ geometry: { coordinates: coords },
    properties: { slug: 'toy_river', station_m: st, area_m2: area, deepest_line_ft: deep,
                  step_m: 100, length_m: 1000, snap_cap_m: 150 } }] };
  const g = slimCentreline(fc);
  g.landings = slimLandings({ landings: [
    { name: 'Upper Ramp', station_m: 200, lat: 34, lon: -80 + 2 * 0.0010865 },
    { name: 'Lower Ramp', station_m: 800, lat: 34, lon: -80 + 8 * 0.0010865 } ] });
  return g;
}

describe('V = Q/A, per station, only where the chart can answer', () => {
  const g = toyRiver();
  it('100 m2 at 3,531 ft3/s is 1 m/s, which is 2.24 mph', () => {
    const c = currentBetween(g, 0, 1000, 3531.47);
    expect(c.median_mph).toBe(2.24);
    expect(c.p90_mph).toBe(2.24);
  });
  it('the uncharted station and the 1 ft one are left out, not averaged in', () => {
    const c = currentBetween(g, 0, 1000, 3531.47);
    expect(c.stations).toBe(11);
    expect(c.measured_stations).toBe(9);
  });
  it('the guard is the app\'s own 2 ft, and the two files say the same number', () => {
    expect(REAL_SECTION_FT).toBe(2);
    expect(src('../js/modules/river-drifts.js')).toContain('const REAL_SECTION_FT = 2;');
  });
  it('a tidal river is refused, not computed', () => {
    const c = currentBetween(g, 0, 1000, 5000, { tidal: true });
    expect(c.median_mph).toBe(undefined);
    expect(c.basis).toContain('tidal');
  });
  it('no discharge, no speed -- and it says so', () => {
    expect(currentBetween(g, 0, 1000, null).basis).toContain('no discharge');
  });
});

describe('where on the river, and the stretch between two landings', () => {
  const g = toyRiver();
  it('a point beside station 500 is at 500 m, and the stretch is Upper Ramp to Lower Ramp', () => {
    const at = stationAt(g, 34.0003, -80 + 5 * 0.0010865);
    expect(at.station_m).toBe(500);
    const s = stretchAround(g, at.station_m);
    expect([s.from, s.to]).toEqual(['Upper Ramp', 'Lower Ramp']);
    expect([s.from_m, s.to_m]).toEqual([200, 800]);
  });
  it('above the top landing the stretch runs to the top of the river', () => {
    const s = stretchAround(g, 100);
    expect(s.from).toBe('the top of the charted river');
    expect(s.to).toBe('Upper Ramp');
  });
});

describe('the verdict is the current against Ryan\'s 5.5 mph', () => {
  it('his number, in one place, with his words', () => {
    expect(BOAT.topSpeedMph).toBe(5.5);
    expect(BOAT.quote).toContain('nk180pro');
  });
  it('no-go when the fastest tenth reaches the boat\'s top speed', () => {
    expect(currentVerdict({ median_mph: 2.0, p90_mph: 5.5 }).status).toBe('no-go');
  });
  it('caution when the usual current is half of it', () => {
    expect(currentVerdict({ median_mph: 2.75, p90_mph: 4.0 }).status).toBe('caution');
  });
  it('go below both, and no verdict with no current', () => {
    expect(currentVerdict({ median_mph: 1.0, p90_mph: 2.0 }).status).toBe('go');
    expect(currentVerdict({ basis: 'no centreline' })).toBe(null);
  });
});

describe('the six hand-written rivers find their own packs, from the bindings', () => {
  const bound = {
    wateree_river: { display_name: 'Wateree River', pool: { usgs_site: '02148000' } },
    congaree_river: { display_name: 'Congaree River', gauges: [{ usgs_site: '02169500' }, { usgs_site: '02161000' }] },
    broad_river_2: { display_name: 'Broad River (2) (Union Co, SC)', gauges: [{ usgs_site: '02156500' }] },
    santee_river: { display_name: 'Santee River', gauges: [{ usgs_site: '02171645' }] },
    rediversion_canal: { display_name: 'Rediversion Canal', pool: { usgs_site: '02171645' } },
  };
  it('a gauge AND a name: the Carlisle gauge is on the Congaree binding too', () => {
    expect(packSlugFor('wateree', RIVERS.wateree, bound)).toBe('wateree_river');
    expect(packSlugFor('congaree', RIVERS.congaree, bound)).toBe('congaree_river');
    expect(packSlugFor('santee', RIVERS.santee, bound)).toBe('santee_river');
  });
  it('a bound slug is its own pack', () => {
    expect(packSlugFor('broad_river_2', null, bound)).toBe('broad_river_2');
  });
});

describe('/river is wired to it', () => {
  const w = src('../Worker/trollmap-worker.js');
  it('the route hands getRiver the pack, the tide and the binding\'s gauges', () => {
    expect(w).toContain('opts.packSlug = packSlugFor(key, opts.cfg || RIVERS[key], bound);');
    expect(w).toContain('opts.tidal = !!(opts.packSlug && bound[opts.packSlug]');
  });
  it('a river with no hand-set bands gets a verdict when the current can give one', () => {
    expect(w).toContain('if (primary && !cfg.kayakThresholds && !moving) {');
  });
  it('and only for a named stretch: the whole Tuckasegee includes Fontana\'s backwater', () => {
    // Measured 2026-09-24: 105 of the river's 152 measurable sections are over 1,000 m2, all
    // between 68.7 and 74.3 km, below Bryson City -- a median of 0.03 mph at 928 ft3/s.
    expect(w).toContain('const moving = riverAt ? currentVerdict(out.current) : null;');
  });
  it('NWS action stage is a backstop', () => {
    expect(w).toContain('the NWS action stage of ${flood.action} ft.');
  });
});

describe('the real Wateree, when its pack is on this machine', () => {
  const f = new URL('../../chartpack/wateree_river/centreline.geojson', import.meta.url);
  const l = new URL('../../chartpack/wateree_river/launches.json', import.meta.url);
  const have = existsSync(f) && existsSync(l);
  it(have ? 'the Camden gauge is on the river, 7.5 miles down, where USGS says 7.4'
          : 'skipped: the Wateree pack is not on this machine', () => {
    if (!have) return;
    const g = slimCentreline(JSON.parse(readFileSync(f, 'utf8')));
    g.landings = slimLandings(JSON.parse(readFileSync(l, 'utf8')));
    const at = stationAt(g, 34.2446, -80.654);
    expect(at.off_m <= g.snap_cap_m).toBe(true);
    expect(Math.round(at.station_m / 1609.344 * 10) / 10).toBe(7.5);
    // His danger line is 8,000 ft3/s. The current there says caution, the bands say no-go, and on
    // the curated river the stricter one stands.
    const s = stretchAround(g, at.station_m);
    expect(currentVerdict(currentBetween(g, s.from_m, s.to_m, 8000)).status).toBe('caution');
  });
});
