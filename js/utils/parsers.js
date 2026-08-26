/**
 * Format parsers — GPX, KML, GeoJSON.
 *
 * Coordinate convention (internal): [lat, lon]
 * Coordinate convention (GPX / KML / GeoJSON): lon,lat or lon,lat,alt
 *
 * The parsers normalize everything to [lat, lon] on the way in. The
 * GeoJSON-to-Lines helper keeps [lat, lon] as well, since most of the
 * downstream rendering code (Leaflet, etc.) expects that order.
 *
 * Nothing in this module touches Leaflet, the DOM (other than via
 * DOMParser), or any global state. Pass in `data` when you want to
 * build a GPX; we don't reach into a global `DATA` variable.
 */

import { esc } from './escape.js';

// ── XML helpers (private — only used by GPX/KML parsers) ────────────────

/**
 * Strip the XML namespace prefix from a tag name.
 * @example localName('svg:circle') === 'circle'
 */
function localName(t) {
  return t.split('}').pop().split(':').pop();
}

/**
 * Find a direct child element by local name and return its trimmed text.
 * Returns '' if the child is missing.
 */
function ctext(el, name) {
  for (const c of el.children) {
    if (localName(c.tagName) === name) return (c.textContent || '').trim();
  }
  return '';
}

/**
 * Parse a GPX document into { waypoints, tracks }.
 *
 * Waypoints:  [{ lat, lon, name, sym }]
 * Tracks:     [{ name, pts: [[lat, lon], ...] }]
 *
 * @param {string} text — raw GPX text
 * @returns {{waypoints: Array, tracks: Array}}
 * @throws if the document is not valid XML
 */
export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid GPX/XML');

  const all = [...doc.getElementsByTagName('*')];
  const wpts = [];
  const trks = [];

  for (const el of all) {
    const ln = localName(el.tagName);
    if (ln === 'wpt') {
      const lat = parseFloat(el.getAttribute('lat'));
      const lon = parseFloat(el.getAttribute('lon'));
      if (!isNaN(lat) && !isNaN(lon)) {
        wpts.push({
          lat,
          lon,
          name: ctext(el, 'name'),
          sym: ctext(el, 'sym') || 'Waypoint',
        });
      }
    } else if (ln === 'trk') {
      const name = ctext(el, 'name');
      const pts = [];
      for (const seg of el.children) {
        if (localName(seg.tagName) !== 'trkseg') continue;
        for (const p of seg.children) {
          if (localName(p.tagName) !== 'trkpt') continue;
          const lat = parseFloat(p.getAttribute('lat'));
          const lon = parseFloat(p.getAttribute('lon'));
          if (!isNaN(lat) && !isNaN(lon)) pts.push([lat, lon]);
        }
      }
      trks.push({ name, pts });
    }
  }

  return { waypoints: wpts, tracks: trks };
}

/**
 * A LEG'S COLOUR, IN THE ONLY VOCABULARY THE UNIT ACCEPTS.
 *
 * <gpxx:DisplayColor> takes one of a fixed set of NAMES, not a hex value, so a palette built
 * for a web map has to be mapped rather than passed through. Below is the nearest Garmin name
 * for each colour plan-tracks.js actually assigns. Ryan's ActiveCaptain palette (screenshot,
 * 2026-08-26) is exactly the gpxx v3 sixteen, so every name here is one the unit will take.
 *
 * WHY IT LIVES HERE AND NOT IN A GARMIN-ONLY MODULE: it used to live in garmin-export.js,
 * whose exportGarminGPX() was wired to a button -- `exportGarminBtn` -- that does not exist in
 * index.html and never has. The only GPX this app can produce comes from `saveBtn`, which calls
 * buildGPX() below. So the colour fix of 2026-08-26 went into a file that has never run, and
 * Ryan's export of that same day came out with no <extensions> at all and drew five green
 * tracks in ActiveCaptain. garmin-export.js is deleted; this is the one writer.
 *
 * WHAT IT REPLACES: nothing -- no TrollMap export has ever carried a track colour. plan-tracks.js
 * computes `t.color` per leg and says why it must: renderMap() used to derive one by matching the
 * track NAME against v1's phase names, which no v2 track has, so every leg of every v2 plan drew
 * in the same fallback magenta -- troll, deadhead and the run home indistinguishable. That was
 * fixed for the map. The export dropped the value at the door, so the IDENTICAL defect survived
 * on the ECHOMAP -- the screen Ryan reads on the water, and the only one he reads.
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

/**
 * @param {string} hex
 * @returns {string} the gpxx name for that colour, or '' when there is no colour to write.
 *
 * EMPTY, NOT A FALLBACK. The old version answered 'Cyan' for anything unmapped, so a track that
 * never had a colour -- every track in a GPX loaded off the card and saved back -- would go out
 * asserting one. A track with no colour leaves without an <extensions> block, and the unit keeps
 * its own default instead of being told something untrue.
 */
export function displayColor(hex) {
  return GARMIN_COLORS[String(hex || '').toLowerCase()] || '';
}

/**
 * Serialize a working GPX file from the given waypoints/tracks.
 * Supports unified timeline: when state.DATA.waypoints has been sorted
 * by smart-plan-ui to interleave CAST waypoints with trolling waypoints
 * in route order, this function preserves that chronological order.
 *
 * @param {{ waypoints: Array, tracks: Array }} data
 * @returns {string} GPX XML
 */
export function buildGPX(data) {
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="TrollMap GPX Studio — Unified Timeline"`,
    `  xmlns="http://www.topografix.com/GPX/1/1"`,
    `  xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3"`,
    `  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`,
    `  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">`,
  ];

  // Waypoints are already in interleaved route order if Smart Plan has run
  // (see smart-plan-ui.js). Preserve that order verbatim.
  for (const w of data.waypoints) {
    const sym = w.castingStop ? 'Fishing Area' : (w.sym || 'Waypoint');
    const typeVal = w.castingStop ? 'CAST'
                  : w.lureChange ? 'CHANGE'
                  : (w.role === 'launch_ramp' ? 'LAUNCH' : 'TROLL');
    lines.push(
      `  <wpt lat="${w.lat.toFixed(7)}" lon="${w.lon.toFixed(7)}">`,
      `    <name>${esc(w.name)}</name>`,
      `    <sym>${esc(sym)}</sym>`,
      `    <type>${esc(typeVal)}</type>`,
    );
    // Not gated on `castingStop` — see the same note in garmin-export.js. A waypoint that
    // carries a note has a note to write, whatever class it is.
    if (w.structureType) lines.push(`    <cmt>${esc(w.structureType)}${w.depth ? ` ${w.depth}ft` : ''}</cmt>`);
    if (w.tacticalNote) lines.push(`    <desc>${esc(String(w.tacticalNote).slice(0, 200))}</desc>`);
    lines.push(`  </wpt>`);
  }

  for (const t of data.tracks) {
    lines.push(`  <trk>`, `    <name>${esc(t.name)}</name>`);
    // A colour only when the leg has one -- see displayColor above for why '' is not 'Cyan'.
    const color = displayColor(t.color);
    if (color) {
      lines.push(`    <extensions><gpxx:TrackExtension><gpxx:DisplayColor>${color}</gpxx:DisplayColor></gpxx:TrackExtension></extensions>`);
    }
    lines.push(`    <trkseg>`);
    for (const p of t.pts) {
      lines.push(`      <trkpt lat="${p[0].toFixed(7)}" lon="${p[1].toFixed(7)}"/>`);
    }
    lines.push(`    </trkseg>`, `  </trk>`);
  }

  lines.push(`</gpx>`, '');
  return lines.join('\n');
}

/**
 * Parse a KML document into a flat feature list (LineStrings only).
 *
 * @param {string} text — raw KML text
 * @returns {Array<{type: 'LineString', name: string, desc: string, coords: Array<[lat, lon]>}>}
 */
export function parseKML(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const placemarks = [...doc.querySelectorAll('Placemark')];
  const features = [];

  // Reused per-feature: read a <coordinates> element into [lat, lon] pairs.
  function parseCoords(el) {
    const c = el.querySelector('coordinates');
    if (!c) return [];
    return c.textContent.trim().split(/\s+/).map((s) => {
      const [lon, lat] = s.split(',').map(Number);
      return [lat, lon];
    }).filter((p) => !isNaN(p[0]) && !isNaN(p[1]));
  }

  for (const pm of placemarks) {
    const name = (pm.querySelector('name')?.textContent || '').trim();
    const desc = (pm.querySelector('description')?.textContent || '').trim();

    const ls = pm.querySelector('LineString');
    if (ls) features.push({ type: 'LineString', name, desc, coords: parseCoords(ls) });

    const poly = pm.querySelector('Polygon');
    if (poly) {
      const outer = poly.querySelector('outerBoundaryIs');
      if (outer) {
        const r = parseCoords(outer);
        if (r.length) features.push({ type: 'LineString', name, desc, coords: r });
      }
    }
  }
  return features;
}

/**
 * Convert a KML-features list (from parseKML) into a GeoJSON FeatureCollection.
 * Coordinates are flipped back to GeoJSON's lon,lat order.
 *
 * @param {Array} features — output of parseKML
 * @returns {{ type: 'FeatureCollection', features: Array }}
 */
export function kmlToGeoJSON(features) {
  return {
    type: 'FeatureCollection',
    features: features.map((f, i) => ({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: f.coords.map((c) => [c[1], c[0]]),  // [lat, lon] → [lon, lat]
      },
      properties: { name: f.name, description: f.desc, _id: i },
    })),
  };
}

/**
 * Walk a GeoJSON object and collect all LineStrings and MultiLineStrings
 * into a flat list, flipping coords from [lon, lat] to [lat, lon] for
 * downstream consumption.
 *
 * @param {Object} geo — any GeoJSON object (Geometry, Feature, FeatureCollection)
 * @returns {Array<{ coords: Array<[lat, lon]>, props: Object }>}
 */
export function geoJSONToLines(geo) {
  const out = [];
  const add = (coords, props) => {
    if (coords.length >= 2) out.push({ coords: coords.slice(), props: props || {} });
  };

  const walk = (g, props) => {
    if (!g) return;
    if (g.type === 'LineString') {
      add(g.coordinates.map((c) => [c[1], c[0]]), props);
    } else if (g.type === 'MultiLineString') {
      g.coordinates.forEach((c) => add(c.map((p) => [p[1], p[0]]), props));
    } else if (g.type === 'Feature') {
      walk(g.geometry, g.properties);
    } else if (g.type === 'FeatureCollection') {
      (g.features || []).forEach((f) => walk(f.geometry, f.properties));
    }
  };

  walk(geo);
  return out;
}
