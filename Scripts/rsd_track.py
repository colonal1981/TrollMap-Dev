#!/usr/bin/env python3
"""rsd_track.py - every ping's position and its bottom, for the whole recording.

Personal use only, not for distribution or resale; not for navigation.

Ryan: "are we able to get depth or location vs the bottom?"

LOCATION: yes, and it is per ping. The header is tag/value with the tag's low three bits giving
the type; type 4 carries four bytes. Walking those:

    tag 0x14 @+15   u32   cycle counter, one per 1-5-2 cycle
    tag 0x2c @+28   u32   a clock, ~159 counts per cycle
    tag 0x3c @+56   u32   2048, constant
    tag 0x4c @+63   i32   LATITUDE, semicircles   x 180 / 2^31
    tag 0x54 @+68   i32   LONGITUDE, semicircles
    tag 0x5c @+73   f32   29.69, drifting to 29.76 across 1,200 pings

Nothing was guessed: the position fields were found by asking which field moves smoothly in one
direction over hundreds of pings -- a latitude does not jump -- and the two that did decode, as
semicircles, to a point on Lake Wateree.

DEPTH: the unit does not appear to store a depth number in this record. It stores the echo, and
the bottom is measurable from it -- the first sustained return above half the ping's own peak,
found in 2,355 of 2,355 pings. Correlating every header field against that series turns up
nothing above 0.46, which is just the boat drifting. So depth comes out in SAMPLES here, and one
scale factor turns samples into feet.

That factor does not have to be guessed either: the Quickdraw export from this same trip carries
depth in feet at lat/lon, so joining this track against it solves feet-per-sample from Ryan's own
data. Until that join is run, this writes the bottom in samples and says so.
"""
import argparse, math, os, struct, sys, time

MARK = bytes.fromhex('ac8ef9')
TRAILER, CH, SAMPLES = 11, 14, 1024
SC = 180.0 / 2**31
# Tags, not offsets. The first pass read the position from a fixed +64 and +69, taken from one
# ping, and produced a bounding box spanning the whole globe: this is a TLV stream and a field
# that varies in length ahead of the position moves it. Found by tag, the offsets are wherever
# the encoder put them.
TAG_SEQ, TAG_CLOCK, TAG_LAT, TAG_LON, TAG_TEMP = 0x14, 0x2c, 0x4c, 0x54, 0x5c


def find_fix(body, box, upto=400):
    """The lat/lon pair, located by BOTH tags at their fixed spacing AND both values sane.

    A tag walk that steps one byte whenever it does not see a type-4 tag can slip phase and lock
    onto a byte inside a value, and it did: reading the position at a single offset taken from one
    ping gave a track from Lake Wateree to western North Carolina and four thousand miles of boat
    movement in two and a half hours. Neither is a plausible afternoon.

    So the anchor is a joint constraint, not a scan. `4c <i32 lat> 54 <i32 lon>` -- two known tags
    exactly five bytes apart, each followed by a value that decodes inside the region. Four
    conditions at once; noise does not satisfy them.
    """
    end = min(upto, len(body) - 10)
    for o in range(end):
        if body[o] != TAG_LAT or body[o + 5] != TAG_LON:
            continue
        lat = struct.unpack_from('<i', body, o + 1)[0] * SC
        lon = struct.unpack_from('<i', body, o + 6)[0] * SC
        if box[0] <= lat <= box[1] and box[2] <= lon <= box[3]:
            return lat, lon, o
    return None


def tag_at(body, tag, upto=400):
    """The 4-byte value of `tag`, searched for as a tag byte followed by four bytes."""
    end = min(upto, len(body) - 5)
    for o in range(end):
        if body[o] == tag:
            return o + 1
    return None


def bottom_index(s, frac=0.5, skip=60, run_len=10):
    pk = max(s)
    if pk < 800:
        return None
    thr = pk * frac
    run = 0
    for i in range(skip, len(s)):
        run = run + 1 if s[i] >= thr else 0
        if run >= run_len:
            return i - run_len + 1
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--out', default='rsd_track.csv')
    ap.add_argument('--chunk', type=int, default=1 << 24)
    ap.add_argument('--channel', type=int, default=5)
    # A sanity box, wide enough to cover every water this app carries plus slop, so a garbage
    # read is REPORTED rather than averaged into the track.
    ap.add_argument('--max-jump-ft', type=float, default=50.0)
    ap.add_argument('--lat-lo', type=float, default=29.0)
    ap.add_argument('--lat-hi', type=float, default=38.0)
    ap.add_argument('--lon-lo', type=float, default=-86.0)
    ap.add_argument('--lon-hi', type=float, default=-74.0)
    a = ap.parse_args()

    size = os.path.getsize(a.path)
    t0 = time.time()
    n = kept = jumped = 0
    prev = None
    lat0 = lon0 = None
    total_ft = 0.0
    lat_min = lon_min = 1e9
    lat_max = lon_max = -1e9
    bmin, bmax, bsum = 1 << 30, -1, 0

    out = open(a.out, 'w')
    out.write('# Personal use only, not for distribution or resale; not for navigation.\n')
    out.write('# bottom_sample is the echo index, NOT feet -- the scale is not solved yet.\n')
    out.write('offset,seq,clock,lat,lon,temp_field,bottom_sample,n_samples\n')

    with open(a.path, 'rb') as fh:
        carry, base = b'', 0
        pending = None            # (trailer_pos) -> body starts at pos+11
        while True:
            chunk = fh.read(a.chunk)
            if not chunk:
                break
            buf = carry + chunk
            limit = len(buf) - 11
            i = buf.find(MARK)
            while 0 <= i <= limit:
                p = base + i
                ln = struct.unpack_from('<I', buf, i + 3)[0]
                if prev is not None and ln == p - prev:
                    bs = prev - base + TRAILER
                    if 0 <= bs and i - bs > SAMPLES + 64:
                        body = buf[bs:i]
                        if body[CH] == a.channel:
                            n += 1
                            s = body[SAMPLES:]
                            cnt = len(s) // 2
                            samp = struct.unpack_from('<%dH' % cnt, s, 0)
                            b = bottom_index(samp)
                            fix = find_fix(body, (a.lat_lo, a.lat_hi, a.lon_lo, a.lon_hi))
                            if fix is None:
                                prev = p
                                i = buf.find(MARK, i + 1)
                                continue
                            lat, lon, fo = fix
                            to = tag_at(body, TAG_TEMP)
                            so = tag_at(body, TAG_SEQ)
                            co = tag_at(body, TAG_CLOCK)
                            tmp = struct.unpack_from('<f', body, to)[0] if to else float('nan')
                            seq = struct.unpack_from('<I', body, so)[0] if so else 0
                            clk = struct.unpack_from('<I', body, co)[0] if co else 0
                            # A fix that teleports is a misread, not a boat. At trolling speed a
                            # ping is inches apart; 50 ft is generous by two orders of magnitude.
                            jump = None
                            if lat0 is not None:
                                dy = (lat - lat0) * 364000.0
                                dx = (lon - lon0) * 364000.0 * math.cos(math.radians(lat))
                                jump = math.hypot(dx, dy)
                            if jump is not None and jump > a.max_jump_ft:
                                jumped += 1
                                prev = p
                                i = buf.find(MARK, i + 1)
                                continue
                            if True:
                                kept += 1
                                out.write('%d,%d,%d,%.7f,%.7f,%.4f,%s,%d\n'
                                          % (prev, seq, clk, lat, lon, tmp,
                                             b if b is not None else '', cnt))
                                lat_min = min(lat_min, lat); lat_max = max(lat_max, lat)
                                lon_min = min(lon_min, lon); lon_max = max(lon_max, lon)
                                if jump is not None:
                                    total_ft += jump
                                lat0, lon0 = lat, lon
                                if b is not None:
                                    bmin = min(bmin, b); bmax = max(bmax, b); bsum += b
                prev = p
                i = buf.find(MARK, i + 1)
            keep = max(0, len(buf) - 11)
            carry = buf[keep:]
            base += keep
    out.close()

    print('%s scanned in %.1fs' % (os.path.basename(a.path), time.time() - t0))
    print('%d channel-%d pings, %d fixes kept; %d rejected as a jump over %.0f ft, '
          '%d had no anchored lat/lon pair'
          % (n, a.channel, kept, jumped, a.max_jump_ft, n - kept - jumped))
    print('bbox   lat %.5f .. %.5f   lon %.5f .. %.5f' % (lat_min, lat_max, lon_min, lon_max))
    print('track  %.0f ft (%.2f miles) of boat movement' % (total_ft, total_ft / 5280))
    if bmax > 0:
        print('bottom %d .. %d samples, mean %.0f  -- SAMPLES, not feet' % (bmin, bmax, bsum / kept))
    print('-> %s' % a.out)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
