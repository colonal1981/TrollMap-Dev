/**
 * garmin-marks.js -- the waypoints he marks on the Garmin that are not catches: a missed bite,
 * fish on the sonar, a hazard. Labelled by him when he drops the GPX, kept, and handed to the plan.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Item 40 of APP_CHANGE_REQUESTS. On 9/28 he marked 0005 at 10:13 on Wateree, "0005 was a bite
 * that i didn't land", and the nightly drop threw it away: a waypoint becomes a catch only when
 * photos follow it, and every other mark of his reached nothing. Offered three ways to tell the
 * marks apart, Ryan, 2026-10-01: "Ask me at upload". Built on 2026-10-02: "you can build that for
 * the garmin marks".
 *
 * So the drop asks. Each mark he made on the water (markedWaypoints(): a loaded plan's waypoints
 * all share one timestamp and are never asked about) that has no photos after it, is not already
 * a catch in the journal or the review queue, and has not been labelled before, gets four
 * buttons: missed bite, fish on sonar, hazard, skip. Skip is kept too, so the unit's old marks --
 * it exports every one it holds, every time -- are asked about once. Nothing changes on the water.
 *
 * The sonar RECORDINGS never count (item 40: "if i record sonar for the whole day on the lake i am
 * pretty sure it is just going to become noise"). Only marks he chose to drop.
 *
 * Kept in IndexedDB's `settings` store, one record per mark, the way pasted reports are (no
 * schema change), and synced through /sync as type `mark`.
 */

import { markedWaypoints, waypointReadings, localIso } from '../utils/catch-waypoints.js';
import { getAll as dbGetAll, put as dbPut } from '../utils/db.js';

export const MARK_KIND = 'garmin_mark';
export const MARK_SYNC_TYPE = 'mark';

/** The four answers, in the order the buttons show them. `skip` is an answer, not a mark. */
export const MARK_LABELS = Object.freeze([
  { id: 'missed_bite', text: 'Missed bite' },
  { id: 'fish_on_sonar', text: 'Fish on sonar' },
  { id: 'hazard', text: 'Hazard' },
  { id: 'skip', text: 'Skip' },
]);
const LABEL_IDS = new Set(MARK_LABELS.map((l) => l.id));

/**
 * One mark's id, the same every time the unit exports it: the time it was marked and its name.
 * Two marks cannot share both -- a loaded plan's waypoints share a time and are never marks.
 */
export function markId(w) {
  return `mark-${String(w && w.time || '')}-${String(w && w.name || '')}`;
}

const sameMark = (a, b) => !!a && !!b && a.time === b.time && (a.name || '') === (b.name || '');

/**
 * The marks to ask about in this drop, newest first.
 *
 * waypoints: parseGPX()'s waypoints, every file in the drop
 * withPhotos: the waypoints that photos followed in this drop (groupPhotosByWaypoint().catches)
 * journal:   catches and review-queue items; one carrying `waypoint` is that mark's catch
 * known:     the marks already labelled (any answer, skip included)
 */
export function marksToAsk(waypoints, { withPhotos = [], journal = [], known = [] } = {}) {
  const { marked } = markedWaypoints(waypoints);
  const knownIds = new Set((known || []).map((k) => k && k.id));
  const caught = [...(withPhotos || []), ...(journal || []).map((c) => c && c.waypoint).filter(Boolean)];
  return marked
    .filter((w) => !caught.some((c) => sameMark(c, w)))
    .filter((w) => !knownIds.has(markId(w)))
    .sort((a, b) => b.epochS - a.epochS);
}

/**
 * The record kept for a labelled mark. Position, depth and water temperature are the sounder's at
 * the mark (waypointReadings): a missing reading is null, never 0.
 */
export function markRecord(w, label, now = new Date()) {
  if (!LABEL_IDS.has(label)) return null;
  const id = markId(w);
  const epochS = Number.isFinite(w.epochS) ? w.epochS : Date.parse(w.time) / 1000;
  const r = waypointReadings(w);
  return {
    key: id, id, kind: MARK_KIND, label,
    name: w.name || '', time: w.time, datetime: localIso(epochS), date: localIso(epochS).slice(0, 10),
    lat: w.lat, lon: w.lon, depthFt: r.depthFt, waterTempF: r.waterTempF,
    file: w.file || '', savedAt: now.toISOString(),
  };
}

/** The labelled marks a plan reads: everything but skip, with a position. */
export function marksForPlan(records) {
  return (records || []).filter((m) => m && m.kind === MARK_KIND && m.label !== 'skip'
    && LABEL_IDS.has(m.label) && Number.isFinite(Number(m.lat)) && Number.isFinite(Number(m.lon)));
}

// ── the browser half ─────────────────────────────────────────────────────────────────────────
// Nothing here runs at import, so the pure half above runs under node:test with no IndexedDB.

/** Every labelled mark on this device. Never throws: no IndexedDB, or a failed read, is none. */
export async function loadMarks() {
  if (typeof indexedDB === 'undefined') return [];
  try {
    const all = await dbGetAll('settings');
    return (all || []).filter((r) => r && r.kind === MARK_KIND);
  } catch (_) {
    return [];
  }
}

/** Keep one labelled mark here and send it to the cloud. Returns false when it did not save. */
export async function saveMark(record) {
  if (!record) return false;
  try {
    await dbPut('settings', record);
  } catch (err) {
    console.error('[garmin-marks] could not save', record.id, err);
    return false;
  }
  try { (await import('./cloud-sync.js')).pushItemOnSave(MARK_SYNC_TYPE, record.id, record); } catch (_) { /* kept on this device */ }
  return true;
}
