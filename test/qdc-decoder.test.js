/**
 * Behaviour tests for the raw QDC reader and the contour engine on top of it.
 *
 * Both assertions here are for bugs that shipped, and both are written on what the code DOES
 * rather than on an identifier being present -- a tripwire on a name is a placeholder for a
 * contract, not a contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQDCFolder, clusterPoints, gridSizeFor, buildDepthGrid, contourGrid,
} from '../js/modules/qdc-decoder.js';

const L1 = { size: 90112, offset: 4097, l_size2: 128, a_step: 90 / 2 ** 21, sectors: 4 };
const DEG_PER_TILE = L1.a_step * L1.l_size2;

/** A layer-1 .qdc tile at (tx, ty), with `cells` given as [gx, gy, depth_cm]. */
function qdcTile(name, tx, ty, cells) {
  const b = new Uint8Array(L1.size);
  const dv = new DataView(b.buffer);
  dv.setInt16(164, tx, true);
  dv.setInt16(160, ty, true);
  for (const [gx, gy, cm] of cells) {
    const xx = Math.floor(gx / 32), x = gx % 32;
    const yy = Math.floor(gy / 32), y = gy % 32;
    const k = ((yy * L1.sectors + xx) * 1024) + (y * 32) + x;
    const i = L1.offset + 4 * k;
    dv.setInt16(i - 1, cm, true);      // depth, centimetres
    dv.setInt16(i + 1, 0x0300, true);  // the status word Garmin writes on a sounded cell
  }
  return new File([b], name);
}
const cellLon = (tx, gx) => tx * DEG_PER_TILE + L1.a_step / 2 + gx * L1.a_step;
const cellLat = (ty, gy) => ty * DEG_PER_TILE + L1.a_step / 2 + gy * L1.a_step;


test('a folder of far-apart tiles decodes; the grid is per tile, not per folder', async () => {
  // A .qdc file writes a block that begins at its own tile index, so nothing needs an array
  // spanning the whole folder. The old reader allocated one anyway. Ryan's C folder holds 2,959
  // tiles inside a 311 x 344 rectangle -- 97% air -- and asked for 1.75e9 cells, 3.5 GB, which
  // Chrome refuses outright: 'Array buffer allocation failed', thrown before one depth was read.
  //
  // Node is more forgiving than a browser and will hand out 3.5 GB, so this fixture puts the two
  // tiles 513 apart -- 2.8 degrees, about coast to mountains, an ordinary span for a folder that
  // has been anywhere. That asks for 8.7 GB, which Node refuses too, with the same RangeError.
  // Sized to the tile it is 16,384 cells at any span at all.
  const SPAN = 513;
  const far = [
    qdcTile('a.qdc', -15000, 6000, [[10, 10, 300]]),
    qdcTile('b.qdc', -15000 + SPAN, 6000 + SPAN, [[20, 20, 900]]),
  ];
  const pts = await parseQDCFolder(far, 1);
  assert.equal(pts.length, 2, 'both soundings survive');
  const byDepth = pts.slice().sort((p, q) => p.depth - q.depth);
  assert.ok(Math.abs(byDepth[0].lon - cellLon(-15000, 10)) < 1e-9, 'first sounding keeps its longitude');
  assert.ok(Math.abs(byDepth[0].lat - cellLat(6000, 10)) < 1e-9, 'first sounding keeps its latitude');
  assert.ok(Math.abs(byDepth[1].lon - cellLon(-15000 + SPAN, 20)) < 1e-9, 'second sounding keeps its longitude');
  assert.ok(Math.abs(byDepth[1].depth - (900 / 100) * 3.28084) < 1e-9, 'centimetres become feet');
});

test('two files on the SAME tile merge; a later blank does not erase an earlier depth', async () => {
  // The C (community) and U (own recordings) trees carry the same tile indices. The single-array
  // reader got this right by accident, because both files wrote into one grid and a zero cell is
  // never written. Reading a tile at a time has to keep that on purpose.
  const files = [
    qdcTile('c.qdc', -14680, 6150, [[5, 5, 400], [6, 6, 500]]),
    qdcTile('u.qdc', -14680, 6150, [[6, 6, 700], [7, 7, 800]]),
  ];
  const pts = await parseQDCFolder(files, 1);
  assert.equal(pts.length, 3, 'three distinct cells, not four rows and not two');
  const at = (gx, gy) => pts.find((p) => Math.abs(p.lon - cellLon(-14680, gx)) < 1e-9
                                      && Math.abs(p.lat - cellLat(6150, gy)) < 1e-9);
  assert.ok(at(5, 5), 'the cell only the first file holds survives');
  assert.ok(at(7, 7), 'the cell only the second file holds survives');
  assert.ok(Math.abs(at(6, 6).depth - (700 / 100) * 3.28084) < 1e-9,
    'where both files hold a cell, the later one wins -- as the single array did');
});

test('the fringe fill does not push the drawn contours past the soundings', async () => {
  // buildDepthGrid dilates the data by one cell and fills the ring from the nearest real value,
  // so marching squares can CLOSE a contour at the edge of coverage instead of leaving it
  // hanging. That ring is a numerical device for the surface. Drawn, it is line over ground
  // nobody went near: on the Bates oxbow it put 24.5% of contour vertices outside the soundings,
  // up to 24.3 m out, on water 75 m wide. That is why TrollMap drew contours on the bank where
  // ActiveCaptain did not.
  //
  // The contract is scale-free and needs no invented threshold: turning the fringe ON must not
  // move the drawn lines further from the soundings than leaving it OFF does. It may differ by
  // less than one grid cell -- the smallest step the grid can resolve -- and no more.
  //
  // A narrow shoaling water is what exposes it. Over a wide flat block the shallow contours sit
  // well inside the data and the fringe never shows, which is how this survived.
  const cells = [];
  for (let gx = 8; gx < 120; gx++) {
    const mid = 40 + 18 * Math.sin(gx / 26);              // a meandering channel
    for (let k = -6; k <= 6; k++) {                        // ~12 cells, 48 m, bank to bank
      const gy = Math.round(mid + k);
      if (gy < 0 || gy > 127) continue;
      cells.push([gx, gy, Math.round(140 + 560 * Math.cos((k / 6) * (Math.PI / 2)) ** 2)]);
    }
  }
  const pts = await parseQDCFolder([qdcTile('band.qdc', -14680, 6150, cells)], 1);
  const cluster = clusterPoints(pts, 1000).sort((a, b) => b.length - a.length)[0];
  const n = gridSizeFor(cluster, 15);

  const MLON = 111320 * Math.cos((33.78 * Math.PI) / 180), MLAT = 111132;
  const reach = (fringe) => {
    const g = buildDepthGrid(cluster, n, true, fringe, 3);
    const fc = contourGrid(g, 2, 4, 120);
    assert.ok(fc.features.length > 0, `the fixture produces contours with fringe=${fringe}`);
    let worst = 0, seen = 0;
    for (const f of fc.features) {
      for (const [lon, lat] of f.geometry.coordinates) {
        seen++;
        let best = Infinity;
        for (const p of cluster) {
          const d = Math.hypot((p.lon - lon) * MLON, (p.lat - lat) * MLAT);
          if (d < best) best = d;
        }
        if (best > worst) worst = best;
      }
    }
    assert.ok(seen > 100, `enough vertices were tested (${seen})`);
    return { worst, meta: g.meta };
  };

  const off = reach(false);
  const on = reach(true);
  const { minLon, maxLon, minLat, maxLat } = on.meta;
  const cellW = ((maxLon - minLon) / n) * MLON;
  const cellH = ((maxLat - minLat) / n) * MLAT;
  const oneCell = Math.min(cellW, cellH);

  assert.ok(on.worst - off.worst < oneCell,
    `the fringe pushed the contours ${(on.worst - off.worst).toFixed(1)} m further from the `
    + `soundings than fringe-off does, which is more than one ${oneCell.toFixed(1)} m grid cell `
    + `(fringe off reaches ${off.worst.toFixed(1)} m, fringe on ${on.worst.toFixed(1)} m)`);
});
