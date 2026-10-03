/**
 * a-numbered-mark-on-the-water-is-a-channel-marker.test.js
 *
 * 2026-10-03. Ryan, on Lake Moultrie's "2" at 33.24911, -79.99603, filed as a Highway marker:
 * "these are not land POI at all... they are channel markers they alternate red and green and mark
 * the channel and the app only shows them if i turn on garmin land POI". The extractor filed every
 * bare number as `road_shield`, an off-water class. Scripts/refile_channel_markers.py refiles each
 * one in the pack's charted water as `channel_marker` with `side` from its number (33 CFR 62.43:
 * red even, green odd); this is the map drawing them.
 *
 *   node --test test/a-numbered-mark-on-the-water-is-a-channel-marker.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../js/modules/supplemental-layers.js', import.meta.url), 'utf8');
// The module needs a browser to import, so the one pure function is lifted out of the source.
const body = src.slice(src.indexOf('export function channelMarkerColor(p) {'));
const fn = new Function(`${body.slice('export '.length, body.indexOf('\n}\n') + 2)}; return channelMarkerColor;`)();

describe('a channel marker is drawn in its own colour, on the water', () => {
  it('red for an even number, green for an odd one, from the side the pipeline wrote', () => {
    expect(fn({ poi_type: 'channel_marker', side: 'red', marker_number: 2 })).toBe('#e53935');
    expect(fn({ poi_type: 'channel_marker', side: 'green', marker_number: 5 })).toBe('#43a047');
  });

  it('nothing else is recoloured, and a marker with no side keeps the table colour', () => {
    expect(fn({ poi_type: 'road_shield', side: 'red' })).toBe(null);
    expect(fn({ poi_type: 'channel_marker' })).toBe(null);
    expect(fn(null)).toBe(null);
  });

  it('it has a style and a name of its own, and the renderer uses both', () => {
    expect(src.includes("channel_marker:  { emoji: '🚩'")).toBe(true);
    expect(src.includes("channel_marker:   'Channel marker',")).toBe(true);
    expect(src.includes('const style = { ...base, color: channelMarkerColor(p) || base.color };')).toBe(true);
    expect(src.includes('`${label} ${p.marker_number}`')).toBe(true);
  });

  it('the refile marks it on the water, so the land-POI switch no longer hides it', () => {
    const py = readFileSync(new URL('../Scripts/refile_channel_markers.py', import.meta.url), 'utf8');
    expect(py.includes("pr['on_water'] = True")).toBe(true);
    expect(py.includes("pr['poi_type'] = 'channel_marker'")).toBe(true);
    expect(src.includes('if (_poiOnWaterOnly && p.on_water === false) { hidden++; return; }')).toBe(true);
  });
});
