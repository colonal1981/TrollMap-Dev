/**
 * test/the-river-shows-when-the-map-is-out.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-09-24: "the zoom doesn't work on all of them sometimes you have to actually pan the
 * map to find the river".
 *
 * Measured the same day over the 57 rivers: 30 frame at zoom 8-10 when picked, and nothing of a
 * river draws there -- contour-data.js hides the linework below CONTOUR_MIN_ZOOM and a 60 m channel
 * is inside one basemap pixel at 250 m a pixel. The first plan was to frame on the pack centreline
 * instead of the registry box. Measured before it shipped: 22 of 57 rivers have a launch outside
 * the centreline's box, broad_river 18 of its 23. The frame stays the box; the fix is drawing the
 * water's own outline, thinned, below the zoom its linework starts at.
 *
 * The fixture is cut from the real registry by _scratch/make_river_lines_fixture.py.
 *
 *   node --test test/the-river-shows-when-the-map-is-out.test.js
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';

const FX = JSON.parse(readFileSync(
  new URL('./fixtures/the-river-shows-when-the-map-is-out.2026-09-24.json', import.meta.url), 'utf8'));
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const lines = await import('../js/data/river-lines.js');
const inBox = ([w, s, e, n], lon, lat) => lon >= w && lon <= e && lat >= s && lat <= n;

// ── 1. why the frame did not move ──────────────────────────────────────────────────────────────
describe('the frame stays the registry box, because the launches are on the whole water', () => {
  it('every broad_river launch is inside the box the map already frames', () => {
    const w = FX.waters.broad_river;
    const out = w.launches.filter((l) => !inBox(w.bounds_wsen, l.lon, l.lat));
    expect(out.length).toBe(0);
  });
  it('and 18 of its 23 are outside the centreline\'s box -- the frame that was nearly shipped', () => {
    const w = FX.waters.broad_river;
    expect(w.launches.length).toBe(23);
    expect(w.launches.filter((l) => !inBox(w.centreline_wsen, l.lon, l.lat)).length).toBe(18);
  });
  it('lake-ramp-select.js still fits boundsWSEN, and draws the line beside it rather than instead', () => {
    const s = src('../js/modules/lake-ramp-select.js');
    expect(s.includes('state.MAP.fitBounds([[b[1], b[0]], [b[3], b[2]]], { padding: [40, 40] });')).toBe(true);
    expect(/rec\.featureType === 'river'\) showRiverLine\(rec\.slug\)/.test(s)).toBe(true);
    expect(/else clearRiverLine\(\);/.test(s)).toBe(true);
  });
});

// ── 2. the outline ────────────────────────────────────────────────────────────────────────────
describe('the outline is the water, in Leaflet order', () => {
  const payload = FX.river_lines;
  it('comes back [lat, lon], one ring per polygon', () => {
    const rings = lines.riverLatLngs('broad_river', payload);
    const raw = payload.waters.broad_river.lines;
    expect(rings.length).toBe(raw.length);
    expect(rings[0][0]).toEqual([raw[0][0][1], raw[0][0][0]]);
  });
  it('sits inside the box it is framed by, every vertex of both rivers', () => {
    for (const slug of ['broad_river', 'saluda_river_2']) {
      const b = FX.waters[slug].bounds_wsen;
      // The registry box is rounded to the same 5 places the file is, so a vertex on its edge
      // may sit half a unit outside it -- 0.56 m, and the file records that bound itself.
      const slack = 1e-5;
      const pad = [b[0] - slack, b[1] - slack, b[2] + slack, b[3] + slack];
      const bad = payload.waters[slug].lines.flat().filter(([lon, lat]) => !inBox(pad, lon, lat));
      expect(bad.length).toBe(0);
    }
  });
  it('was thinned to one pixel at the last zoom it is drawn at, not to a number picked for it', () => {
    expect(payload.drawn_below_zoom).toBe(11);
    expect(/CONTOUR_MIN_ZOOM 11 - 1/.test(payload.tolerance_rule)).toBe(true);
    // 2 pi R cos(lat) / (256 * 2^10) at broad_river's mean latitude.
    const [, s, , n] = payload.waters.broad_river.wsen;
    const want = 2 * Math.PI * 6378137 * Math.cos(((s + n) / 2) * Math.PI / 180) / (256 * 2 ** 10);
    expect(Math.abs(payload.waters.broad_river.tolerance_m - want) < 0.1).toBe(true);
  });
  it('nothing for a water the file does not carry, and nothing before it loads', () => {
    expect(lines.riverLatLngs('lake_murray', payload)).toBe(null);
    lines._resetRiverLines();
    expect(lines.riverLatLngs('broad_river')).toBe(null);
  });
  it('skips a vertex that is not two numbers rather than drawing to NaN', () => {
    const p = { waters: { x: { lines: [[[-81, 34], [null, 34.1], [-81.1, 34.2]], [[-81, 34]]] } } };
    expect(lines.riverLatLngs('x', p)).toEqual([[[34, -81], [34.2, -81.1]]]);
  });
});

// ── 3. only where the river's own linework does not draw ─────────────────────────────────────
describe('drawn below CONTOUR_MIN_ZOOM and nowhere else', () => {
  it('below the floor, yes; at it and above, no', () => {
    expect(lines.drawRiverLineAt(8, 11)).toBe(true);
    expect(lines.drawRiverLineAt(10, 11)).toBe(true);
    expect(lines.drawRiverLineAt(11, 11)).toBe(false);
    expect(lines.drawRiverLineAt(14, 11)).toBe(false);
    expect(lines.drawRiverLineAt(NaN, 11)).toBe(false);
  });
  it('the floor is contour-data.js\'s own constant, exported, in the shape the builder reads', () => {
    const cd = src('../js/modules/contour-data.js');
    expect(/^export const CONTOUR_MIN_ZOOM = 11;$/m.test(cd)).toBe(true);
    const py = src('../Scripts/build_river_lines.py');
    expect(py.includes("const\\s+CONTOUR_MIN_ZOOM\\s*=\\s*(\\d+)")).toBe(true);
    expect(/import \{ CONTOUR_MIN_ZOOM \} from '\.\/contour-data\.js';/
      .test(src('../js/modules/river-line-layer.js'))).toBe(true);
  });
});

// ── 4. it reaches the app ─────────────────────────────────────────────────────────────────────
describe('published, verified and loaded', () => {
  it('the uploader ships it, the checker checks it, and the app asks for that path', () => {
    expect(src('../Scripts/upload_garmin_to_r2.py')
      .includes('f"{args.prefix}_registry/river_lines.json"')).toBe(true);
    expect(src('../Scripts/verify_registry_r2.py')
      .includes('("river_lines.json", "river_lines.json", "verbatim",')).toBe(true);
    expect(lines.RIVER_LINES_PATH).toBe('/chartpacks/_registry/river_lines.json');
  });
  it('a body without `waters` is refused, not cached as an answer', async () => {
    lines._resetRiverLines();
    const bad = await lines.primeRiverLines({ worker: 'https://w', fetch: async () => ({ ok: true, json: async () => ({ error: 'x' }) }) });
    expect(bad).toBe(null);
    expect(lines.riverLinesPrimed()).toBe(false);
    const good = await lines.primeRiverLines({ worker: 'https://w', fetch: async () => ({ ok: true, json: async () => FX.river_lines }) });
    expect(!!good).toBe(true);
    expect(lines.riverLatLngs('saluda_river_2').length > 0).toBe(true);
    lines._resetRiverLines();
  });
});
