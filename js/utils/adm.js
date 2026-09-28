/**
 * The plan's cue boundaries as a Garmin ADM file the ECHOMAP imports from its card.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY. His UHD2 imports boundaries only from an .adm ("Only boundary files with an .adm extension
 * are supported"), so since 2026-08-26 the app has written each cue as a route and he converted
 * them on the unit: "turning the routes into boundaries takes about 5 minutes total". Asked what to
 * do about it he said "tomorrow i will save the export as a gpx and an adm and we can see if you
 * can make it happen".
 *
 * THE FORMAT, DECODED FROM HIS OWN EXPORT (28Sep26_Trip\ADMEXPORT.ADM, 2026-09-28):
 *
 *   A Garmin IMG container. The header says DSKIMG / GARMIN / USERDATA, the block size is
 *   2^(9+4) = 8192, and the FAT starts at 0x400 in 512-byte entries: flag, 8+3 name, u32 size,
 *   u16 part, then 240 u16 block numbers. The first entry, a blank name, owns the header blocks
 *   (15 of them, 122,880 bytes). An unused slot is flag 0, a blank name, part 1, and 0xFFFF blocks.
 *
 *   USERDATA.BDY carries the boundaries. Its 45-byte header gives the file's length, its type
 *   (0x0F0C), where the record schema and point schema are and how many fields each has, where
 *   the records start, and how many there are. The schema is (tag, size) pairs, and each record is:
 *     0x320 GUID (16)      0x321 1 (4)          0x322 name, NUL-padded (61)   0x323 point count (4)
 *     0x324 14 (4)         0x325 1 (1)          0x326 0 (1)          0x327 0 (4)     0x328 0 (4)
 *     0x329 warning distance, metres, f32 (4)   0x32a alarm on (1)   0x32b offset of its points (4)
 *   then per point: 0x384 lat, 0x385 lon (i32 semicircles), 0x386 0, 0x387 0xFFFFFFFF.
 *   The file ends in 01 00 0A 00 00 00 and a u32 sum of every byte before it.
 *
 *   Rebuilt from its own decoded records, his ten boundaries come back byte for byte, apart from
 *   the slack at the end of each block, which the unit leaves as whatever was on the card.
 *
 * CHECKED ON HIS UNIT: `TMBAR1.ADM` -- one boundary, this file's layout with only the BDY in it --
 * imported with Merge from Card and listed as "TM uncharted ba", Alarm On, Display on, 99/100
 * boundaries left. The unit shows 15 characters of a name, so names are cut to 15 here.
 *
 * Carrying it to the unit is his: ActiveCaptain moves a GPX but not an ADM, so it goes on the card.
 */

const SEMI = 2 ** 31 / 180;
const BS = 8192;
const HEADER_BLOCKS = 15;
export const ADM_NAME_CHARS = 15;

// The container header, as his unit wrote it: every non-zero byte of its first 0x400. The date
// at 0x39 is overwritten with the time the file is made.
const HEADER = [
  [0x0a, [0x09, 0x7e]], [0x0e, [0x01]],
  [0x10, [0x44, 0x53, 0x4b, 0x49, 0x4d, 0x47]],                      // DSKIMG
  [0x17, [0x02, 0x20]], [0x1b, [0x01, 0x40]],
  [0x39, [0xea, 0x07, 0x09, 0x1c, 0x0f, 0x02, 0x0d]],                // 2026-09-28 15:02:13
  [0x40, [0x02, 0x47, 0x41, 0x52, 0x4d, 0x49, 0x4e]],                // GARMIN
  [0x49, [0x55, 0x53, 0x45, 0x52, 0x44, 0x41, 0x54, 0x41]],          // USERDATA
  [0x5e, [0x01, 0x20]], [0x61, [0x09, 0x04]], [0x64, [0x80]],
  [0x1c0, [0x01]], [0x1c3, [0xff, 0x20, 0x3f]], [0x1cc, [0x08]], [0x1fe, [0x55, 0xaa]],
];

const RECORD_SCHEMA = [[0x320, 16], [0x321, 4], [0x322, 61], [0x323, 4], [0x324, 4], [0x325, 1],
  [0x326, 1], [0x327, 4], [0x328, 4], [0x329, 4], [0x32a, 1], [0x32b, 4]];
const POINT_SCHEMA = [[0x384, 4], [0x385, 4], [0x386, 4], [0x387, 4]];
const RECORD_BYTES = 108;

function guid(rand) {
  const g = new Uint8Array(16);
  for (let i = 0; i < 16; i++) g[i] = Math.floor(rand() * 256);
  g[6] = (g[6] & 0x0f) | 0x40;   // a version-4 GUID, as a random one should say it is
  g[8] = (g[8] & 0x3f) | 0x80;
  return g;
}

/** Latin-1 bytes of a name, cut to what the unit shows. Anything outside Latin-1 becomes '?'. */
export function admName(name) {
  const s = String(name || '').slice(0, ADM_NAME_CHARS);
  return Array.from(s, (c) => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 0x3f));
}

/**
 * USERDATA.BDY for `boundaries`: [{ name, pts: [[lat, lon], ...], warnM }].
 * `rand` is only a parameter so a test can pin the GUIDs.
 */
export function bdyFile(boundaries, rand = Math.random) {
  const so = 45, po = so + 4 * RECORD_SCHEMA.length, ro = po + 4 * POINT_SCHEMA.length;
  const recLen = boundaries.reduce((a, b) => a + RECORD_BYTES + 16 * b.pts.length, 0);
  const footAt = ro + recLen;
  const buf = new ArrayBuffer(footAt + 10);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint32(2, footAt, true);
  dv.setUint16(6, 0x0f0c, true);
  u8.set([0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00, 0x02, 0x00], 8);
  dv.setUint32(0x11, footAt + 10 - 0x19, true);
  [so, RECORD_SCHEMA.length, po, POINT_SCHEMA.length, ro, boundaries.length]
    .forEach((v, i) => dv.setUint32(0x15 + 4 * i, v, true));
  RECORD_SCHEMA.concat(POINT_SCHEMA).forEach(([t, s], i) => {
    dv.setUint16(so + 4 * i, t, true); dv.setUint16(so + 4 * i + 2, s, true);
  });
  let o = ro;
  for (const b of boundaries) {
    u8.set(guid(rand), o);
    dv.setUint32(o + 16, 1, true);
    u8.set(admName(b.name), o + 20);                 // the rest of the 61 stays NUL
    dv.setUint32(o + 81, b.pts.length, true);
    dv.setUint32(o + 85, 14, true);
    u8[o + 89] = 1; u8[o + 90] = 0;
    dv.setUint32(o + 91, 0, true); dv.setUint32(o + 95, 0, true);
    dv.setFloat32(o + 99, b.warnM, true);
    u8[o + 103] = b.alarm === false ? 0 : 1;
    dv.setUint32(o + 104, o + RECORD_BYTES, true);
    let p = o + RECORD_BYTES;
    for (const [lat, lon] of b.pts) {
      dv.setInt32(p, Math.round(lat * SEMI), true);
      dv.setInt32(p + 4, Math.round(lon * SEMI), true);
      dv.setUint32(p + 8, 0, true);
      dv.setUint32(p + 12, 0xffffffff, true);
      p += 16;
    }
    o = p;
  }
  u8.set([0x01, 0x00, 0x0a, 0x00, 0x00, 0x00], footAt);
  let sum = 0;
  for (let i = 0; i < footAt; i++) sum = (sum + u8[i]) >>> 0;
  dv.setUint32(footAt + 6, sum, true);
  return u8;
}

/** The IMG container holding one subfile, USERDATA.BDY, as the file his unit imported. */
export function admFile(boundaries, { when = new Date(), rand = Math.random } = {}) {
  const bdy = bdyFile(boundaries, rand);
  const nb = Math.max(1, Math.ceil(bdy.length / BS));
  const tail = Math.ceil(bdy.length / 512) * 512;          // the last block is cut at its sector
  const out = new Uint8Array(HEADER_BLOCKS * BS + (nb - 1) * BS + tail);
  const dv = new DataView(out.buffer);
  for (const [at, bytes] of HEADER) out.set(bytes, at);
  dv.setUint16(0x39, when.getFullYear(), true);
  out.set([when.getMonth() + 1, when.getDate(), when.getHours(), when.getMinutes(),
           when.getSeconds()], 0x3b);
  const entry = (at, name, ext, size, part, blocks) => {
    out[at] = 1;
    out.set(Array.from(name.padEnd(8).slice(0, 8), (c) => c.charCodeAt(0)), at + 1);
    out.set(Array.from(ext.padEnd(3).slice(0, 3), (c) => c.charCodeAt(0)), at + 9);
    dv.setUint32(at + 12, size, true);
    dv.setUint16(at + 16, part, true);
    for (let i = 0; i < 240; i++) dv.setUint16(at + 32 + 2 * i, i < blocks.length ? blocks[i] : 0xffff, true);
  };
  entry(0x400, '', '', HEADER_BLOCKS * BS, 1, Array.from({ length: HEADER_BLOCKS }, (_, i) => i));
  entry(0x600, 'USERDATA', 'BDY', bdy.length, 0, Array.from({ length: nb }, (_, i) => HEADER_BLOCKS + i));
  for (let at = 0x800; at < HEADER_BLOCKS * BS; at += 512) {
    out.fill(0x20, at + 1, at + 12);
    dv.setUint16(at + 16, 1, true);
    out.fill(0xff, at + 32, at + 512);
  }
  out.set(bdy, HEADER_BLOCKS * BS);
  out.fill(0xff, HEADER_BLOCKS * BS + bdy.length);
  return out;
}

/**
 * The plan's cue lines as boundaries. `routes` is state.DATA.routes; only the plan's own cue
 * lines go (`smartPlan`), each a closed triangle on the unit. The warning distance is his: every
 * one of the ten boundaries he converted on 9/28 carried 152.4 m, his 500 ft.
 */
export const HIS_WARNING_M = 152.4;
export function cueBoundaries(routes, warnM = HIS_WARNING_M) {
  return (routes || [])
    .filter((r) => r && r.smartPlan && Array.isArray(r.pts) && r.pts.length >= 3)
    .map((r) => ({ name: r.name, pts: r.pts.map((p) => [Number(p[0]), Number(p[1])]), warnM }));
}
