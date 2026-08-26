/**
 * Garmin-formatted GPX export.
 *
 * Same data as `buildGPX` in parsers.js, but with Garmin-specific
 * extensions (gpxx namespace, DisplayColor, type="user" on waypoints)
 * so chartplotters render symbols + colors properly instead of
 * treating everything as generic.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';

// Garmin symbol mapping — common TrollMap symbol names to Garmin's
// built-in symbol IDs.
const GARMIN_SYMBOL_MAP = {
  'Waypoint': 'Waypoint',
  'Fishing Hot Spot Facility': 'Fishing Hot Spot Facility',
  'Anchor': 'Anchor',
  'Boat Ramp': 'Boat Ramp',
  'Buoy, White': 'Buoy, White',
  'danger': 'Skull and Crossbones',
  'Fish': 'Fish',
};

function garminSymbol(s) {
  return GARMIN_SYMBOL_MAP[s] || 'Fishing Hot Spot Facility';
}

/**
 * Trigger a download of `state.DATA` as a Garmin-flavored GPX file.
 * Waypoints are exported in their current chronological order, which after
 * Smart Plan is the unified timeline order (trolling waypoints interleaved
 * with CAST: stop-and-cast waypoints). This satisfies the “GPX export should
 * include stop-and-cast waypoints interleaved with trolling waypoints in route order” rule.
 */
/**
 * A LEG'S COLOUR, IN THE ONLY VOCABULARY THE UNIT ACCEPTS.
 *
 * `<gpxx:DisplayColor>` takes one of a fixed set of NAMES, not a hex value, so a palette built for
 * a web map has to be mapped rather than passed through. Below is the nearest Garmin name for
 * each colour plan-tracks.js actually assigns.
 *
 * WHAT THIS REPLACES: the literal `Cyan`, written into every track of every export ever made.
 * plan-tracks.js computes `t.color` per leg and carries a comment explaining why it must --
 * "renderMap() used to derive one by matching the track NAME against v1's phase names, which no
 * v2 track has, so every leg of every v2 plan drew in the same fallback magenta -- troll,
 * deadhead and the run home indistinguishable."
 *
 * That was fixed for the map. The export went on discarding the value at the door, so the
 * IDENTICAL defect survived on the ECHOMAP -- the screen Ryan actually reads on the water, and
 * the only one he reads. A deadhead, a trolling pass and the run home all drawing the same cyan
 * is the difference between knowing which line to follow and guessing at it.
 */
const GARMIN_COLORS = {
  '#00e5ff': 'Cyan',
  '#ff6d00': 'DarkYellow',      // Garmin has no orange; DarkYellow is the nearest warm tone
  '#7c4dff': 'Magenta',
  '#76ff03': 'Green',
  '#ff4081': 'Red',
  '#ffea00': 'Yellow',
  '#78909c': 'DarkGray',        // a deadhead recedes on the unit exactly as it does on the map
  '#00e676': 'DarkGreen',       // the run home, and nothing else in a normal day
};
export function displayColor(hex) {
  return GARMIN_COLORS[String(hex || '').toLowerCase()] || 'Cyan';
}

export function exportGarminGPX() {
  if (!state.DATA.waypoints.length && !state.DATA.tracks.length) {
    alert('No waypoints or tracks to export');
    return;
  }

  const wptXml = state.DATA.waypoints.map((w) => {
    const isCast = !!w.castingStop;
    const sym = isCast ? (GARMIN_SYMBOL_MAP['Fishing Hot Spot Facility'] || 'Fishing Hot Spot Facility') : garminSymbol(w.sym);
    const typeVal = isCast ? 'CAST'
                  : w.lureChange ? 'CHANGE'
                  : (w.role === 'launch_ramp' ? 'LAUNCH' : 'TROLL');
    // COMMENT AND DESCRIPTION WERE GATED ON `isCast`, so every other waypoint's note was built
    // and then dropped at the door. The chart marks have carried "charted position — compare with
    // the sounder" since the day they were written and not one ever reached the card; a lure
    // change carries the actual instruction — which lure, off which rod, snap or retie — and
    // would have gone the same way. The gate is now "does this waypoint have something to say".
    const cmt = w.structureType ? `\n    <cmt>${esc(w.structureType)}${w.depth ? ` ${w.depth}ft` : ''}</cmt>` : '';
    const desc = w.tacticalNote ? `\n    <desc>${esc(String(w.tacticalNote).slice(0, 200))}</desc>` : '';
    return `  <wpt lat="${w.lat.toFixed(7)}" lon="${w.lon.toFixed(7)}">
    <name>${esc(w.name || 'WPT')}</name>
    <sym>${esc(sym)}</sym>
    <type>${esc(typeVal)}</type>${cmt}${desc}
  </wpt>`;
  }).join('\n');

  const trkXml = state.DATA.tracks.map((t) => `  <trk>
    <name>${esc(t.name || 'Track')}</name>
    <extensions><gpxx:TrackExtension><gpxx:DisplayColor>${displayColor(t.color)}</gpxx:DisplayColor></gpxx:TrackExtension></extensions>
    <trkseg>
${t.pts.map((p) => `      <trkpt lat="${p[0].toFixed(7)}" lon="${p[1].toFixed(7)}"></trkpt>`).join('\n')}
    </trkseg>
  </trk>`).join('\n');

  const planName = document.getElementById('planName')?.value || 'Fishing Plan';
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     creator="TrollMap GPX Studio — Garmin Export"
     version="1.1"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${esc(planName)}</name>
    <desc>Generated by TrollMap GPX Studio — ${new Date().toLocaleString()}</desc>
    <time>${new Date().toISOString()}</time>
  </metadata>
${wptXml}
${trkXml}
</gpx>`;

  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (planName || 'fishing_plan').replace(/\s+/g, '_') + '_Garmin.gpx';
  a.click();
  URL.revokeObjectURL(a.href);
}

// GUARDED SO THE MODULE CAN BE IMPORTED WITHOUT A BROWSER. This line ran at module scope and
// threw `ReferenceError: document is not defined` under node, which meant nothing in this file
// could be unit-tested — including displayColor(), whose whole job is being correct about a
// vocabulary nobody can check by eye. Same guard notifications.js already uses.
if (typeof document !== 'undefined') {
  document.getElementById('exportGarminBtn')?.addEventListener('click', exportGarminGPX);
}
