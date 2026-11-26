/**
 * The steering box's log: every line it sends, and every command the phone sends it, kept on the phone.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * The first water test (Second Mill, 2026-11-26) was read off two terminal-app logs he had to save and
 * send by hand. The review doc asked that the panel keep it instead, "the way it saves battery readings"
 * (bms-log.js): an IndexedDB store of its own, nothing averaged or thinned, saved to a file on demand.
 * The file is the terminal app's shape -- time, then the line -- so the same reading of it works.
 *
 * Lines arrive two or three a second for hours, so they are written in batches every two seconds, one
 * transaction each. A line that cannot be written is dropped and said in the console; the panel does
 * not depend on the log.
 */
const DB_NAME = 'trollmap-autopilot-log';
const STORE = 'lines';
let dbPromise = null;
let pending = [];
let flushTimer = 0;

function openDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true }).createIndex('t', 't');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { console.warn('autopilot log: could not open', req.error); resolve(null); };
    });
  }
  return dbPromise;
}

async function flush() {
  flushTimer = 0;
  const batch = pending;
  pending = [];
  if (!batch.length) return;
  const db = await openDb();
  if (!db) return;
  await new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    for (const r of batch) st.add(r);
    tx.oncomplete = () => resolve();
    tx.onerror = () => { console.warn('autopilot log: lines not kept', tx.error); resolve(); };
  });
}

/** Keep one line. `dir` is 'in' for the box's, 'out' for what the phone sent. */
export function keepLine(line, dir = 'in', t = Date.now()) {
  pending.push({ t, dir, line: String(line) });
  if (!flushTimer) flushTimer = setTimeout(flush, 2000);
}

export async function readLines() {
  await flush();
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.t - b.t || a.id - b.id));
    req.onerror = () => resolve([]);
  });
}

export async function countLines() {
  await flush();
  const db = await openDb();
  if (!db) return 0;
  return new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => resolve(0);
  });
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
/** "14:07:12.345 HOLD 214 h213 ..." -- the phone's local time, as the terminal app writes it; "> " marks what was sent. */
export function logText(rows) {
  return (rows || []).map((r) => {
    const d = new Date(r.t);
    const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    return `${hms} ${r.dir === 'out' ? '> ' : ''}${r.line}`;
  }).join('\n') + '\n';
}

/** One file per day kept, the newest day: trollmap_autopilot_log_2026-11-27.txt. The log itself stays. */
export async function saveLogFile() {
  const rows = await readLines();
  if (!rows.length) return 0;
  const last = new Date(rows[rows.length - 1].t);
  const day = `${last.getFullYear()}-${pad(last.getMonth() + 1)}-${pad(last.getDate())}`;
  const today = rows.filter((r) => {
    const d = new Date(r.t);
    return d.getFullYear() === last.getFullYear() && d.getMonth() === last.getMonth() && d.getDate() === last.getDate();
  });
  const url = URL.createObjectURL(new Blob([logText(today)], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `trollmap_autopilot_log_${day}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return today.length;
}
