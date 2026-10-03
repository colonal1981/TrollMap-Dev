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
 *   mergePulledJournal() is what a pull does now: the journal on this device, plus the catches in
 *                       the pulled record that this device does not have. Nothing on this device is
 *                       overwritten by a pull.
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

/** A pulled journal record into the journal on this device: add what is missing, overwrite nothing. */
export function mergePulledJournal(current, pulled) {
  const incoming = Array.isArray(pulled && pulled.data) ? [pulled] : (isCatch(pulled) ? [pulled] : []);
  return flattenJournal([...(Array.isArray(current) ? current : []), ...incoming]);
}
