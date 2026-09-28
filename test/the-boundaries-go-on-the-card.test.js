// The boundaries go on the card as an ADM his unit reads.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-09-27: "turning the routes into boundaries takes about 5 minutes total", and "tomorrow
// i will save the export as a gpx and an adm and we can see if you can make it happen". The format
// was decoded from his own export on 9/28, and `test/fixtures/TMBAR1.ADM` is the file his ECHOMAP
// then imported: one boundary, "TM uncharted bar", listed on the unit as "TM uncharted ba", Alarm
// On, 99/100 left. The unit shows 15 characters of a name, so the app cuts names to 15.
//
// What these hold:
//   1. js/utils/adm.js writes that exact file, byte for byte, given its GUID and time -- except the
//      name's 16th character and the checksum that covers it;
//   2. the BDY inside decodes to the boundary that went in: name, points, warning distance, alarm;
//   3. only the plan's own cue lines become boundaries, each with his 500 ft warning;
//   4. the checksum is the byte sum the unit writes.

import { describe, it, expect } from './expect-shim.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { admFile, bdyFile, cueBoundaries, HIS_WARNING_M, ADM_NAME_CHARS } from '../js/utils/adm.js';

const ACCEPTED = new Uint8Array(readFileSync(new URL('./fixtures/TMBAR1.ADM', import.meta.url)));
const GUID = [17, 206, 141, 104, 35, 177, 68, 36, 152, 132, 100, 138, 19, 154, 218, 247];
const pinned = () => { let i = 0; return () => (GUID[i++ % 16] + 0.5) / 256; };
const BAR = { name: 'TM uncharted bar', warnM: 152.4,
  pts: [[34.378320, -80.738520], [34.378400, -80.738850], [34.378140, -80.738800]] };
const SC = 180 / 2 ** 31;

function decodeBdy(file) {
  const base = 15 * 8192;
  const dv = new DataView(file.buffer, file.byteOffset);
  const size = dv.getUint32(0x600 + 12, true);
  const b = file.subarray(base, base + size);
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = d.getUint32(0x25, true);
  const n = d.getUint32(0x29, true);
  const out = [];
  for (let i = 0; i < n; i++) {
    const name = String.fromCharCode(...b.subarray(off + 20, off + 81)).replace(/\0.*$/s, '');
    const cnt = d.getUint32(off + 81, true);
    const warnM = d.getFloat32(off + 99, true);
    const alarm = b[off + 103];
    const po = d.getUint32(off + 104, true);
    const pts = [];
    for (let k = 0; k < cnt; k++) pts.push([d.getInt32(po + 16 * k, true) * SC, d.getInt32(po + 16 * k + 4, true) * SC]);
    out.push({ name, warnM, alarm, pts });
    off = po + 16 * cnt;
  }
  const foot = d.getUint32(2, true);
  let sum = 0;
  for (let i = 0; i < foot; i++) sum = (sum + b[i]) >>> 0;
  return { out, sumOk: d.getUint32(foot + 6, true) === sum, footer: [...b.subarray(foot, foot + 6)] };
}

describe('the file his unit imported', () => {
  it('is what the app writes, apart from the name cut to 15 and its checksum', () => {
    const mine = admFile([BAR], { when: new Date(2026, 8, 28, 22, 0, 0), rand: pinned() });
    assert.equal(mine.length, ACCEPTED.length);
    const diff = [];
    for (let i = 0; i < mine.length; i++) if (mine[i] !== ACCEPTED[i]) diff.push(i);
    // 123024 is the 16th character of the name ('r', now NUL); 123151-123154 the checksum.
    assert.deepEqual(diff.filter((i) => i < 123151 || i > 123154), [123024]);
    assert.ok(diff.every((i) => i === 123024 || (i >= 123151 && i <= 123154)));
  });

  it('decodes to the boundary that went in, as the unit listed it', () => {
    const { out, sumOk, footer } = decodeBdy(admFile([BAR], { rand: pinned() }));
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'TM uncharted ba');
    assert.equal(out[0].name.length, ADM_NAME_CHARS);
    assert.ok(Math.abs(out[0].warnM - 152.4) < 1e-4);
    assert.equal(out[0].alarm, 1);
    out[0].pts.forEach((p, k) => {
      assert.ok(Math.abs(p[0] - BAR.pts[k][0]) < 1e-6 && Math.abs(p[1] - BAR.pts[k][1]) < 1e-6);
    });
    assert.ok(sumOk, 'the footer checksum is the byte sum');
    assert.deepEqual(footer, [1, 0, 10, 0, 0, 0]);
  });

  it('holds many boundaries, each pointing at its own points', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...BAR, name: `L${i + 1} 15-25ft`,
      pts: BAR.pts.map(([a, b]) => [a + i * 0.001, b]) }));
    const { out, sumOk } = decodeBdy(admFile(many));
    assert.equal(out.length, 12);
    assert.equal(out[11].name, 'L12 15-25ft');
    assert.ok(Math.abs(out[11].pts[0][0] - (34.378320 + 0.011)) < 1e-6);
    assert.ok(sumOk);
    assert.equal(bdyFile(many).length, 45 + 64 + 12 * (108 + 48) + 10);
  });
});

describe('the page writes it, for a built plan and a loaded one', () => {
  const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  it('has a Save ADM beside Save GPX that writes the cue lines as TMmmdd.ADM', () => {
    expect(/id="saveAdmBtn"/.test(src('../index.html'))).toBe(true);
    const io = src('../js/modules/file-io.js');
    expect(io.includes("getElementById('saveAdmBtn')")).toBe(true);
    expect(io.includes('cueBoundaries(state.DATA && state.DATA.routes)')).toBe(true);
    expect(io.includes('a.download = `TM${mmdd}.ADM`')).toBe(true);
  });
  it('keeps the cue lines in a saved plan and puts them back on load', () => {
    const pb = src('../js/modules/plan-builder.js');
    expect(pb.includes('routeList: (state.DATA.routes || []).filter((r) => r.smartPlan')).toBe(true);
    expect(pb.includes('((p.gpx && p.gpx.routeList) || [])')).toBe(true);
  });
});

describe('the plan\'s cue lines become the boundaries', () => {
  it('takes only the plan\'s own routes, with his 500 ft warning', () => {
    const routes = [
      { name: 'L1 15-25ft', smartPlan: true, pts: [[34.37, -80.73], [34.3701, -80.7299], [34.37, -80.7298]] },
      { name: 'his own route', pts: [[34.1, -80.1], [34.2, -80.2], [34.3, -80.3]] },
      { name: 'S1-1 dock_clust', smartPlan: true, pts: [[34.36, -80.72], [34.3601, -80.7199], [34.36, -80.7198]] },
    ];
    const b = cueBoundaries(routes);
    assert.deepEqual(b.map((x) => x.name), ['L1 15-25ft', 'S1-1 dock_clust']);
    assert.ok(b.every((x) => x.warnM === HIS_WARNING_M && x.pts.length === 3));
    assert.equal(HIS_WARNING_M, 152.4, 'his 500 ft, off every boundary he converted on 9/28');
  });
});
