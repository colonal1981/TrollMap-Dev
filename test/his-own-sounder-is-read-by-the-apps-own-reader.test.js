/**
 * The pipeline reads his Quickdraw with the app's own reader, and gets the app's own answer.
 *
 * Ryan, 2026-10-05: "lets see if you can make contours on bates using my the data from my fish
 * finder". Scripts/survey_chart.py builds that chart, and the soundings come from
 * Scripts/qdc_points.mjs, which imports js/modules/qdc-decoder.js rather than porting it -- a second
 * decoder is a second answer to "where is this sounding". These hold that the script is a thin door
 * onto the reader: the same soundings, from a card nested as deep as his is, and an empty folder
 * said rather than written as nothing.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQDCFolder } from '../js/modules/qdc-decoder.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'Scripts', 'qdc_points.mjs');

const L1 = { size: 90112, offset: 4097, l_size2: 128, a_step: 90 / 2 ** 21, sectors: 4 };

/** A layer-1 .qdc tile at (tx, ty), `cells` as [gx, gy, depth_cm] -- as in qdc-decoder.test.js. */
function tileBytes(tx, ty, cells) {
  const b = new Uint8Array(L1.size);
  const dv = new DataView(b.buffer);
  dv.setInt16(164, tx, true);
  dv.setInt16(160, ty, true);
  for (const [gx, gy, cm] of cells) {
    const xx = Math.floor(gx / 32), x = gx % 32;
    const yy = Math.floor(gy / 32), y = gy % 32;
    const k = ((yy * L1.sectors + xx) * 1024) + (y * 32) + x;
    const i = L1.offset + 4 * k;
    dv.setInt16(i - 1, cm, true);
    dv.setInt16(i + 1, 0x0300, true);
  }
  return b;
}

test('the script hands back exactly what the app reads, from a card ten folders deep', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qdc-'));
  // His card nests a .qdc ten folders deep; a second file shares the first one's tile.
  const deep = path.join(root, 'Garmin', 'Quickdraw', 'U', 'a', 'b', 'c', 'd', 'e', 'f', 'g');
  fs.mkdirSync(deep, { recursive: true });
  const a = tileBytes(-14680, 6150, [[5, 5, 400], [6, 6, 500], [40, 70, 1200]]);
  const b = tileBytes(-14680, 6150, [[6, 6, 700], [7, 7, 800]]);
  fs.writeFileSync(path.join(deep, '0001.qdc'), a);
  fs.writeFileSync(path.join(root, 'Garmin', 'Quickdraw', 'U', '0002.qdc'), b);
  fs.writeFileSync(path.join(deep, 'notes.txt'), 'not a tile');

  const out = path.join(root, 'points.json');
  const log = execFileSync(process.execPath, [SCRIPT, '--layer', '1', '--out', out, root], { encoding: 'utf8' });
  const rows = JSON.parse(fs.readFileSync(out, 'utf8'));

  // The app, given the same two files in the same (path) order.
  const files = [path.join(root, 'Garmin', 'Quickdraw', 'U', '0002.qdc'), path.join(deep, '0001.qdc')]
    .sort().map((p) => new File([fs.readFileSync(p)], path.basename(p)));
  const app = await parseQDCFolder(files, 1);

  assert.equal(rows.length, app.length, 'the same number of soundings');
  const key = (lon, lat) => `${lon.toFixed(7)},${lat.toFixed(7)}`;
  const want = new Map(app.map((p) => [key(p.lon, p.lat), p.depth]));
  for (const [lon, lat, ft] of rows) {
    assert.ok(want.has(key(lon, lat)), `a sounding the app does not have at ${lon},${lat}`);
    assert.ok(Math.abs(want.get(key(lon, lat)) - ft) < 0.006, 'at the depth the app reads, to the hundredth');
  }
  assert.match(log, /2 \.qdc file\(s\) seen, 2 of a Quickdraw size; layer 1: 4 soundings/, 'and it says what it read');
});

test('a folder with no tile in it is said, not written as an empty chart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qdc-empty-'));
  const out = path.join(root, 'points.json');
  const r = spawnSync(process.execPath, [SCRIPT, '--layer', '0', '--out', out, root], { encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'it fails');
  assert.ok(!fs.existsSync(out), 'and writes nothing');
});
