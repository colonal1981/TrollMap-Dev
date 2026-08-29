// THE JUMP BUTTON WAS WIRED AND RETURNED ON ITS FIRST LINE.
//
// topbar.js read `coordInput`, a single combined box. The search modal has had two --
// `coordLat` and `coordLon` -- since it was rebuilt, so getElementById returned null, `?.value`
// gave undefined, and the handler's own `if (!raw) return` swallowed every click silently for
// weeks. Ryan, 2026-08-29: "you put coords in and hit go or whatever the button says and
// nothing happens".
//
// Two things are asserted here. The parsing, which is pure and belongs in a test; and the
// WIRING, by reading topbar.js and checking it names the ids the page provides -- because the
// parsing was never the broken part, and a test that only covered the parser would have passed
// happily through the whole outage.
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseLatLonPair, parseCoord } from '../js/utils/geo.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(path.join(REPO, f), 'utf8');
const near = (a, b, tol = 1e-4) => Math.abs(a - b) < tol;

describe('parseLatLonPair reads the two boxes the modal has', () => {
  it('takes a lat and a lon from their own boxes', () => {
    const r = parseLatLonPair('34.09421', '-81.32882');
    expect(near(r.lat, 34.09421)).toBe(true);
    expect(near(r.lon, -81.32882)).toBe(true);
  });

  it('reads degrees and decimal minutes, which is what the chartplotter shows', () => {
    // N34 05.653 / W081 19.729 is the same point as above.
    const r = parseLatLonPair('N34 05.653', 'W081 19.729');
    expect(near(r.lat, 34.09421, 2e-4)).toBe(true);
    expect(near(r.lon, -81.32882, 2e-4)).toBe(true);
  });

  it('reads degrees minutes seconds', () => {
    const r = parseLatLonPair('34 5 39', '-81 19 43');
    expect(near(r.lat, 34.0942, 1e-3)).toBe(true);
    expect(near(r.lon, -81.3286, 1e-3)).toBe(true);
  });

  it('takes a pasted pair out of the first box when the second is empty', () => {
    const r = parseLatLonPair('34.09421, -81.32882', '');
    expect(near(r.lat, 34.09421)).toBe(true);
    expect(near(r.lon, -81.32882)).toBe(true);
  });

  it('takes a pasted pair separated by a space, because the lon is negative', () => {
    const r = parseLatLonPair('34.09421 -81.32882', '');
    expect(near(r.lat, 34.09421)).toBe(true);
    expect(near(r.lon, -81.32882)).toBe(true);
  });

  it('does NOT read "34 05 39" in one box as two coordinates', () => {
    // Whitespace inside one coordinate is minutes and seconds. Splitting on it would jump to
    // 34N 5E -- Nigeria -- instead of refusing. The old handler did exactly that split.
    const r = parseLatLonPair('34 05 39', '');
    expect(!!r.why).toBe(true);
    expect(r.blame).toBe('lon');
  });

  it('refuses an out-of-range value and says which box', () => {
    const a = parseLatLonPair('99.5', '-81.3');
    expect(!!a.why).toBe(true);
    expect(a.blame).toBe('lat');
    const b = parseLatLonPair('34.1', '-810.3');
    expect(!!b.why).toBe(true);
    expect(b.blame).toBe('lon');
  });

  it('refuses empty input rather than jumping to null island', () => {
    expect(!!parseLatLonPair('', '').why).toBe(true);
  });
});

describe('the handler names the ids the page actually provides', () => {
  const js = src('js/modules/topbar.js');
  const html = src('index.html');

  it('reaches for coordLat and coordLon', () => {
    expect(js.includes("getElementById('coordLat')")).toBe(true);
    expect(js.includes("getElementById('coordLon')")).toBe(true);
  });

  it('no longer reaches for coordInput, which no page has', () => {
    // The CALL, not the word: the comment above the handler names `coordInput` on purpose, so
    // that whoever reads this next knows what the bug was.
    expect(js.includes("getElementById('coordInput')")).toBe(false);
    expect(html.includes('id="coordInput"')).toBe(false);
  });

  it('and the page still provides every id the jump path needs', () => {
    for (const id of ['coordLat', 'coordLon', 'coordGo', 'searchStatus']) {
      expect(html.includes(`id="${id}"`)).toBe(true);
    }
  });
});

describe('parseCoord, which had no callers until now', () => {
  it('is used by parseLatLonPair rather than a second parser', () => {
    expect(src('js/utils/geo.js').includes('const lat = parseCoord(latRaw)')).toBe(true);
  });
  it('still reads a lettered southern/western value as negative', () => {
    expect(parseCoord('S34 5 39') < 0).toBe(true);
    expect(parseCoord('W081 19.729') < 0).toBe(true);
  });
});
