/**
 * Catch depth provenance -- ONE place that answers "is this catch's depth a measurement?"
 *
 * The depth on an imported catch is not a sounder reading. nearestLakeAndContour() in
 * catch-journal.js finds the nearest charted contour VERTEX within a mile of the photo's GPS
 * fix, writes that contour's depth onto the catch, and records how far it had to reach in the
 * note:
 *
 *     Depth lookup: ~11ft contour (near, 0.17 mi)
 *
 * 0.17 mi is 274 m. That is not the depth where the fish was. It is the depth of the nearest
 * charted thing to a photograph. Ryan found this himself, twice in one afternoon: a 24.5"
 * catfish filed as Lake Marion that he says was actually in a borrow pit, and a 31.5" catfish
 * whose position he could not place anywhere he has ever fished -- "its near anywhere i have
 * fished". Both sit in the five worst lookups in his 157-catch journal, and the worst of the
 * five reached 0.27 mi to call a fish "1 ft".
 *
 * The distance was in the data the whole time and no screen ever showed it. Three places
 * printed a bare "Depth: 11 ft" as though it were measured -- the journal row, the photo
 * lightbox, and the map marker popup he was reading when he noticed. They all ask this module
 * now, so the rule is stated once instead of three times.
 *
 * ON_CONTOUR_MI is not a new number. nearestLakeAndContour() has always called anything under
 * 0.10 mi "on" the contour and anything past it "near"; that word was already the file's own
 * line between measuring this spot and measuring a different one. All this does is stop the
 * "near" ones from claiming a depth.
 *
 * exportJournalCsv() drops `structure` and keeps `notes`, so the note text -- not the stored
 * object -- is the durable carrier of the distance. Every one of Ryan's 157 rows came back in
 * through the CSV with `structure: null`, which is why the note is parsed first-class here
 * rather than as a fallback.
 */

/** The reach past which a charted contour stops describing the spot the fish came from. */
export const ON_CONTOUR_MI = 0.10;

// Permissive on the qualifier word: rows already in the journal say "on" or "near", and the
// writer now also emits "off", so match any word rather than an enumeration that would have
// to be revised the next time the vocabulary grows.
const LOOKUP_RE = /Depth lookup:\s*~?\s*([\d.]+)\s*ft\s+contour\s*\(\s*([A-Za-z]+)\s*,\s*([\d.]+)\s*mi\s*\)/i;

/**
 * Pull a depth lookup back out of a note string.
 * Returns null when the note carries no lookup -- which is the normal case for a depth Ryan
 * keyed in himself.
 */
export function parseDepthLookup(notes) {
  const m = LOOKUP_RE.exec(String(notes || ''));
  if (!m) return null;
  const depthFt = parseFloat(m[1]);
  const distanceMi = parseFloat(m[3]);
  if (!Number.isFinite(depthFt) || !Number.isFinite(distanceMi)) return null;
  return { depthFt, relation: m[2].toLowerCase(), distanceMi };
}

/**
 * How far the contour lookup for this catch had to reach, in miles, or null if the depth did
 * not come from a lookup at all. Prefers the stored object (a catch enriched in this session)
 * and falls back to the note (everything that came back through a CSV).
 */
export function catchDepthLookupMi(c) {
  if (!c) return null;
  const stored = c.structure && c.structure.contourDistanceMi;
  if (Number.isFinite(stored)) return stored;
  const fromNote = parseDepthLookup(c.notes) || parseDepthLookup(c.ai && c.ai.notes);
  return fromNote ? fromNote.distanceMi : null;
}

/**
 * Was this catch's depth looked up off a chart rather than measured?
 * True when a distance is recoverable, and also when the review flags say the depth came from
 * contours but the note has been lost -- an unknown reach is still not a measurement.
 */
export function isDepthCharted(c) {
  if (!c) return false;
  if (catchDepthLookupMi(c) != null) return true;
  const flags = Array.isArray(c.reviewFlags) ? c.reviewFlags : [];
  return flags.includes('depth_from_contours');
}

/**
 * What a screen should print for this catch's depth.
 *
 * `text` is ready to display. `trusted` is false when the number describes some other piece of
 * water, so a caller that wants to compute with the depth rather than print it has one field
 * to check instead of a threshold to re-derive.
 */
export function describeCatchDepth(c) {
  const raw = c && c.depth != null ? String(c.depth).trim() : '';
  const mi = catchDepthLookupMi(c);
  const charted = isDepthCharted(c);

  if (!raw) return { text: '—', ft: null, lookupMi: mi, charted, trusted: false };

  const ft = `${raw} ft`;
  if (!charted) return { text: ft, ft, lookupMi: null, charted: false, trusted: true };
  if (mi == null) return { text: `${ft} (charted)`, ft, lookupMi: null, charted: true, trusted: false };
  if (mi <= ON_CONTOUR_MI) return { text: `${ft} (charted)`, ft, lookupMi: mi, charted: true, trusted: true };

  return {
    text: `— (nearest charted depth is ${raw} ft, ${mi.toFixed(2)} mi away)`,
    ft: null, lookupMi: mi, charted: true, trusted: false
  };
}
