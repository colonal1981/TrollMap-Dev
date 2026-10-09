/**
 * journal-merge.js — the catch journal is ONE record, and a pull must not add it to itself.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHAT HAPPENED. catch-journal.js pushes the whole journal as one sync item, `catch/catches`, a
 * record `{ name: 'catches', data: [...every catch] }`. cloud-sync.js's pull was written for one
 * item per catch ("for journal 'catches' the id is row.id"), so every time it pulled `catch/catches`
 * it looked for a catch keyed 'catches', found none, and PUSHED THE WHOLE JOURNAL RECORD INTO THE
 * JOURNAL AS ONE MORE CATCH. Ryan's export on 2026-10-03: 663 confirmed, 159 real catches and 504
 * rows with every field blank -- "Unknown: 504" on the species card. Each blank row was a copy of the
 * journal as some device had last pushed it.
 *
 * So:
 *   flattenJournal()    takes a journal array that may hold such copies and returns the catches:
 *                       the real ones as they stand, plus any catch that exists ONLY inside a copy
 *                       (one logged on another device that never merged), each once. A copy of
 *                       any other journal record (the review queue) holds no catches and is dropped.
 *   mergeJournals()     is what a pull does with the cloud's journal, and what the Worker does with a
 *                       journal pushed to it: two copies become one, fish by fish (below).
 *
 * A CHANGE ON ONE DEVICE REACHES THE OTHERS (2026-10-09). Ryan, after 25 fish were renamed in his
 * Chrome journal: "and the next thing is how to make this persist wherever i open it... either storing
 * in r2 or something else...". The journal was already in the cloud; what kept the names on one device
 * was this file. A pull added the fish a device lacked and overwrote nothing, so a renamed fish stayed
 * renamed only where it was renamed, and every save sent that device's whole journal over the cloud's,
 * so a phone that had not caught up put the old names back. A deleted fish came back from any device
 * that still had it. Asked whether this was it -- every fish carries when it was last changed, the
 * later change wins, a deleted fish is remembered as deleted, and the Worker uses the same rule -- "yes".
 *
 *   stampJournal()      runs in saveCatches(): a fish that is not what it was at the last save, or is
 *                       new, gets `editedAt`; a fish that was there and is gone goes into `removed`
 *                       with the time. So every way of changing a fish stamps it, with nothing to add
 *                       at each place that changes one.
 *   mergeJournals()     for a fish both copies have, the one changed later wins; with the same time, or
 *                       neither stamped, the copy already there stays (this device's on a pull, the
 *                       cloud's at the Worker), so nothing changes that nobody changed. A fish in
 *                       `removed` stays gone unless it was changed after it was deleted. A copy from
 *                       the cloud never has the picture; the one here keeps its own.
 */

const CATCH_FIELDS = ['species', 'date', 'time', 'length', 'lake', 'lat', 'lon', 'sourceFile', 'notes', 'lure'];

/** A journal record (or a copy of one) rather than a catch: an array of rows and no catch fields. */
export function isJournalRecord(x) {
  if (!x || typeof x !== 'object' || !Array.isArray(x.data)) return false;
  return !CATCH_FIELDS.some((k) => x[k] != null && String(x[k]).trim() !== '');
}

/** A catch worth keeping: an object carrying at least one thing a catch is. */
export function isCatch(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x) && !isJournalRecord(x)
    && CATCH_FIELDS.some((k) => x[k] != null && String(x[k]).trim() !== '');
}

/**
 * Who a catch is: its photo when it has one, otherwise when and where. Not the species or the
 * length -- those get corrected after the fact, and a corrected catch is still the same fish, so an
 * older copy of it inside a journal copy must not come back as a second one.
 */
export function catchKey(c) {
  const f = String(c.sourceFile || '').trim().toLowerCase();
  if (f) return `f:${f}`;
  const where = ['date', 'time', 'lat', 'lon'].map((k) => String(c[k] ?? '').trim().toLowerCase());
  return where.some(Boolean) ? where.join('|')
    : ['species', 'length', 'lake', 'notes'].map((k) => String(c[k] ?? '').trim().toLowerCase()).join('|');
}

/**
 * @param {Array} arr  the journal as stored
 * @returns {{catches: object[], records: number, recovered: number, dropped: number}}
 *          `records` journal copies found, `recovered` catches that were only inside one,
 *          `dropped` entries that were neither a catch nor a copy of the journal
 */
export function flattenJournal(arr) {
  const out = [], seen = new Set();
  let records = 0, recovered = 0, dropped = 0;
  // The catches standing in the journal first: they are this device's truth.
  const inside = [];
  for (const x of (Array.isArray(arr) ? arr : [])) {
    if (isCatch(x)) {
      const k = catchKey(x);
      if (!seen.has(k)) { seen.add(k); out.push(x); }
    } else if (isJournalRecord(x)) { records++; inside.push(x); } else dropped++;
  }
  // Then whatever only a copy holds. A copy can hold copies; walked with a stack, each array once.
  const done = new Set();
  while (inside.length) {
    const r = inside.pop();
    if (done.has(r.data)) continue;
    done.add(r.data);
    // A copy of the review queue is not the journal: its rows are imports waiting to be approved.
    const isQueue = /queue/i.test(String(r.name || r.key || ''));
    for (const x of r.data) {
      if (isJournalRecord(x)) { records++; inside.push(x); continue; }
      if (isQueue || !isCatch(x)) continue;
      const k = catchKey(x);
      if (!seen.has(k)) { seen.add(k); out.push(x); recovered++; }
    }
  }
  return { catches: out, records, recovered, dropped };
}

/**
 * The fields that hold a picture. They stay on the device that has them -- catchesForSync() in
 * catch-journal.js leaves them out of the copy that goes to the cloud -- so a newer copy of a fish
 * from the cloud keeps this device's picture, and a picture is not what makes a fish changed.
 */
export const PHOTO_FIELDS = ['photoDataUrl', 'lurePhotoDataUrl', 'thumbDataUrl'];
// Not what a fish says: when it was changed, and the cloud copy's note that a picture is on a device.
const NOT_THE_FISH = new Set([...PHOTO_FIELDS, 'editedAt', 'photoOnDevice']);

/** What a fish says, in one string, the same whatever order its fields were written in. */
function fishText(c) {
  return JSON.stringify(Object.keys(c).filter((k) => !NOT_THE_FISH.has(k)).sort().map((k) => [k, c[k]]));
}
const stampOf = (c) => String((c && c.editedAt) || '');

/**
 * Stamp the fish that changed since the last save. Sets `editedAt = now` on each fish in `after` that
 * is new or not what it was in `before`, in place. Unchanged fish keep the stamp they had, or none.
 * @param {Array}  before   the journal as last saved on this device
 * @param {Array}  after    the journal being saved
 * @param {object} removed  catchKey -> when it was deleted, as last saved
 * @param {string} now      an ISO time
 * @returns {{removed: object, stamped: number}} `removed` with the fish gone since the last save
 *          added and any fish that is back taken out
 */
export function stampJournal(before, after, removed, now) {
  const was = new Map();
  for (const c of (Array.isArray(before) ? before : [])) if (isCatch(c)) was.set(catchKey(c), c);
  const out = { ...(removed && typeof removed === 'object' ? removed : {}) };
  const here = new Set();
  let stamped = 0;
  for (const c of (Array.isArray(after) ? after : [])) {
    if (!isCatch(c)) continue;
    const k = catchKey(c);
    here.add(k);
    const old = was.get(k);
    if (!old || fishText(old) !== fishText(c)) { c.editedAt = now; stamped++; }
    delete out[k];
  }
  for (const k of was.keys()) if (!here.has(k)) out[k] = now;
  return { removed: out, stamped };
}

/** The winning copy, with the picture the losing one had and it lacks. */
function withPictureOf(winner, loser) {
  const add = {};
  for (const f of PHOTO_FIELDS) if (loser[f] && !winner[f]) add[f] = loser[f];
  return Object.keys(add).length ? { ...winner, ...add } : winner;
}

/**
 * Two copies of the journal into one.
 * @param {object} here   the copy already there: `{ data, removed }` (this device's on a pull, the
 *                        cloud's at the Worker); a missing one is an empty journal
 * @param {object} there  the copy coming in: `{ data, removed }`, or one bare catch (an old sync row)
 * @returns {{catches: object[], removed: object, added: number, replaced: number, gone: number}}
 *          `added` fish only `there` had, `replaced` fish `there` changed later, `gone` fish `here`
 *          had that were deleted after their last change
 */
export function mergeJournals(here, there) {
  const mine = flattenJournal(here && here.data).catches;
  const incoming = Array.isArray(there && there.data) ? flattenJournal(there.data).catches
    : (isCatch(there) ? [there] : []);
  const removed = { ...((here && here.removed) || {}) };
  for (const [k, at] of Object.entries((there && there.removed) || {})) {
    if (!removed[k] || String(at) > String(removed[k])) removed[k] = at;
  }
  const byKey = new Map(), order = [], from = new Map();
  for (const c of mine) { const k = catchKey(c); if (!byKey.has(k)) { byKey.set(k, c); order.push(k); } }
  for (const c of incoming) {
    const k = catchKey(c), have = byKey.get(k);
    if (!have) { byKey.set(k, c); order.push(k); from.set(k, 'added'); }
    else if (stampOf(c) > stampOf(have)) { byKey.set(k, withPictureOf(c, have)); from.set(k, 'replaced'); }
  }
  const catches = [];
  const n = { added: 0, replaced: 0, gone: 0 };
  for (const k of order) {
    const c = byKey.get(k);
    if (removed[k]) {
      if (!(stampOf(c) > String(removed[k]))) { if (from.get(k) !== 'added') n.gone++; continue; }
      delete removed[k];   // changed after it was deleted: it is back
    }
    if (from.has(k)) n[from.get(k)]++;
    catches.push(c);
  }
  return { catches, removed, ...n };
}
