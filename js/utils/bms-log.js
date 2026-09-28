/**
 * The battery log: every reading the paired BMS sends, kept on the phone.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-09-28, on Wateree: "into the wind at 52% throttle I'm going about 1.9mph and it is
 * only usimg 53watts and the xzny app is showing 2.0amp draw". The app's battery model
 * (`ampsAtMph()` in plan-candidates.js) is a two-point fit that says 4.6 A at 1.9 mph on still
 * water, so every Ah on a plan has been more than twice his real draw. The code has said since
 * 2026-08-07 that the real curve "is learnable from his own trips", and nothing ever kept the
 * readings: ble-motor.js polled the BMS every 3 s and overwrote one object. The XZNY app keeps no
 * log he can export either. Asked "Does trollmap have a log for the battery meter", the answer was
 * no, so this is it.
 *
 * WHAT IT KEEPS: each basic-info packet, as it arrived, with the phone's clock. No speed: the
 * Garmin track has speed on every point with its own clock, and the two are joined by time
 * afterwards. Nothing here is averaged, filtered or thinned.
 *
 * WHERE: IndexedDB on the phone, one database of its own, so it can never fill or break another
 * store the app keeps. A reading that cannot be written is dropped and said in the console; the
 * live readout does not depend on it.
 */

const DB_NAME = 'trollmap-bms-log';
const STORE = 'readings';

let dbPromise = null;

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
      req.onerror = () => { console.warn('battery log: could not open', req.error); resolve(null); };
    });
  }
  return dbPromise;
}

/**
 * Keep one reading. `r` carries what the BMS said: volts, signed amps (negative is discharge on
 * a JBD BMS), state of charge, remaining and full Ah, and the first temperature probe.
 */
export async function logReading(r) {
  const db = await openDb();
  if (!db) return false;
  const rec = {
    t: Number.isFinite(r.t) ? r.t : Date.now(),
    volts: r.volts, amps: r.amps, soc: r.soc,
    remainingAh: r.remainingAh, capacityAh: r.capacityAh,
    tempC: r.tempC ?? null, device: r.device ?? null,
  };
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add(rec);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => { console.warn('battery log: reading not kept', tx.error); resolve(false); };
  });
}

/** Every reading kept, oldest first. */
export async function readLog() {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.t - b.t));
    req.onerror = () => resolve([]);
  });
}

export async function countLog() {
  const db = await openDb();
  if (!db) return 0;
  return new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => resolve(0);
  });
}

// A reading the BMS did not give is absent, not zero: Number(null) is 0, the trap this repo keeps
// finding, so nothing below calls Number() on a value before asking whether it is there.
const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const cell = (v, dp) => (num(v) == null ? '' : num(v).toFixed(dp));

/**
 * The log as CSV. Time is UTC ISO, which is what a GPX track carries, so the two join on it
 * without a time zone. Watts is volts times amps as the BMS gave them; draw is the magnitude.
 */
export function bmsLogCsv(rows) {
  const head = 'time_utc,volts,amps,draw_a,watts,soc_pct,remaining_ah,capacity_ah,temp_c,device';
  const lines = (rows || []).map((r) => {
    const a = num(r.amps);
    const v = num(r.volts);
    const draw = a == null ? null : Math.abs(a);
    const watts = v != null && draw != null ? v * draw : null;
    const dev = r.device ? `"${String(r.device).replace(/"/g, '""')}"` : '';
    return [new Date(r.t).toISOString(), cell(v, 2), cell(a, 2), cell(draw, 2), cell(watts, 1),
      r.soc ?? '', cell(r.remainingAh, 2), cell(r.capacityAh, 2), cell(r.tempC, 1), dev].join(',');
  });
  return [head, ...lines].join('\n') + '\n';
}

/** Hands the phone the CSV as a file. The log itself stays; nothing is cleared. */
export async function saveLogFile() {
  const rows = await readLog();
  const csv = bmsLogCsv(rows);
  const day = rows.length ? new Date(rows[rows.length - 1].t) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `trollmap_battery_log_${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}.csv`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return rows.length;
}
