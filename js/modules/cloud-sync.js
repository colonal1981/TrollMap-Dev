/**
 * Cloud Sync — auto-push on save, auto-pull on load.
 *
 * Architecture:
 *   - Push: per-item POST with `lastModified` timestamp
 *   - Pull: delta-by-timestamp against a server-provided list
 *   - Conflict resolution: last-write-wins (newer `lastModified` wins)
 *   - Deletes: tombstones — server stores `{...meta, deleted: true}`
 *     and client removes the local record when it sees one
 *   - Offline: failed pushes go into a `pending_sync` IndexedDB queue;
 *     drained on the next successful online sync
 *
 * Worker endpoints expected:
 *   POST /sync/item/{type}/{id}    { ...data, lastModified }
 *   GET  /sync/list-updates        { items: [{ key, lastModified, deleted? }] }
 *   GET  /sync/item/{type}/{id}    { ...data }   (for fetching a single item)
 *   POST /sync/batch-pull          (future) { keys: [...] } -> { items: {...} }
 *
 * Drop this file at `js/modules/cloud-sync.js` and add `import
 * './modules/cloud-sync.js';` to `js/main.js`. The push + pull fire
 * automatically — no other wiring needed.
 */

import { state, CF_WORKER_URL } from '../core/state.js';

// Per-install secret token. Regenerate if compromised. For multi-tenant,
// move to Cloudflare Access auth header instead.
const SYNC_TOKEN = 'trollmap2026';

// Map item type → IndexedDB store name. Don't pluralize by string
// manipulation — `'catch' + 's' = 'catchs'` is wrong.
const STORE_BY_TYPE = {
  plan: 'plans',
  spread: 'spreads',
  catch: 'journal',
  // chart: 'charts',  // charts live in R2 — excluded from D1 sync
  layer: 'layers',
};

const statusEl = () => document.getElementById('syncStatus');

/**
 * Update the on-screen sync status pill. Auto-clears after 4s.
 * @param {string} msg
 * @param {boolean} [isError]
 */
function setStatus(msg, isError = false) {
  const el = statusEl();
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? 'var(--bad)' : 'var(--accent2)';
  setTimeout(() => {
    if (el.textContent === msg) el.textContent = '';
  }, 4000);
}

/**
 * Drain the pending-sync queue. Called after a successful online sync.
 * Each entry is { type, id, payload, attempts }.
 */
async function drainPendingQueue() {
  if (!window.DB?.db) return;
  let queue = [];
  try {
    const rec = await window.DB.get('settings', 'pending_sync');
    queue = rec?.queue || [];
  } catch (_) {}
  if (!queue.length) return;

  console.log(`☁️ Draining ${queue.length} queued sync items…`);
  const remaining = [];
  for (const item of queue) {
    try {
      const r = await fetch(`${CF_WORKER_URL}/sync/item/${item.type}/${encodeURIComponent(item.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Token': SYNC_TOKEN },
        body: JSON.stringify({ ...item.payload, lastModified: new Date().toISOString() }),
      });
      if (!r.ok) {
        item.attempts = (item.attempts || 0) + 1;
        if (item.attempts < 10) remaining.push(item);
      }
    } catch (_) {
      item.attempts = (item.attempts || 0) + 1;
      if (item.attempts < 10) remaining.push(item);
    }
  }
  try {
    await window.DB.put('settings', { key: 'pending_sync', queue: remaining });
  } catch (_) {}
  if (remaining.length === 0) setStatus('☁️ Queued items synced');
}

/**
 * Queue a push for later (called when the live push fails).
 */
async function queueForLater(type, id, payload) {
  if (!window.DB?.db) return;
  let queue = [];
  try {
    const rec = await window.DB.get('settings', 'pending_sync');
    queue = rec?.queue || [];
  } catch (_) {}
  // Dedupe: if same key already queued, replace it.
  queue = queue.filter((q) => !(q.type === type && q.id === id));
  queue.push({ type, id, payload, attempts: 0 });
  try {
    await window.DB.put('settings', { key: 'pending_sync', queue });
  } catch (_) {}
}

/**
 * Push one item to the cloud. Fire-and-forget — never blocks the UI.
 * On failure, queues for retry on next successful sync.
 *
 * @param {string} type    - 'plan', 'spread', 'catch', 'chart', 'layer'
 * @param {string|number} id - unique id for the item
 * @param {object} data    - full payload to save
 */
export function pushItemOnSave(type, id, data) {
  if (!type || id == null) return;

  // Charts live in R2 via the capture pipeline — never sync to D1
  // Also skip any chart-related sync that the worker does not implement
  if (type === 'chart' || type === 'charts') return;

  const payload = { ...data, lastModified: new Date().toISOString() };

  fetch(`${CF_WORKER_URL}/sync/item/${type}/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sync-Token': SYNC_TOKEN },
    body: JSON.stringify(payload),
  })
    .then((r) => {
      if (r.ok) {
        setStatus('☁️ Saved to cloud');
        drainPendingQueue().catch((_) => {});
      } else {
        // Don't spam the console on expected missing routes (e.g. /sync/item/chart)
        if (type !== 'chart' && type !== 'charts') {
          setStatus('☁️ Save queued (offline?)', true);
        }
        queueForLater(type, id, data);
      }
    })
    .catch((err) => {
      // Suppress noisy errors for chart sync (worker does not have /sync routes yet)
      if (type !== 'chart' && type !== 'charts') {
        console.warn(`Cloud push for ${type}/${id} failed:`, err);
        setStatus('☁️ Save queued (offline?)', true);
      }
      queueForLater(type, id, data);
    });
}

/**
 * Pull updates from the cloud. Compares each server item's
 * `lastModified` against our local timestamp; fetches any newer
 * items; merges into IndexedDB; dispatches a `trollmap:data-synced`
 * event so tabs can refresh without a page reload.
 */
export async function pullUpdatesOnLoad() {
  console.log('🔄 Checking cloud for updates…');
  setStatus('Checking cloud…');

  try {
    // 0 means "fetch everything" on first run.
    const localRec = await window.DB?.get('settings', 'lastSyncTimestamp');
    const localLastSync = localRec?.value || 0;

    // 1. Ask server for the list of updates since our timestamp.
    const listUrl = localLastSync
      ? `${CF_WORKER_URL}/sync/list-updates?since=${localLastSync}`
      : `${CF_WORKER_URL}/sync/list-updates`;
    const res = await fetch(listUrl, {
      headers: { 'X-Sync-Token': SYNC_TOKEN },
      cache: 'no-store',
    });
    if (!res.ok) {
      console.warn('Cloud list-updates returned', res.status);
      setStatus('Cloud unavailable', true);
      return;
    }
    const { items: serverItems = [] } = await res.json();
    if (!serverItems.length) {
      console.log('👍 Local data is up to date.');
      setStatus('Up to date');
      // Still drain queue in case we had pending writes
      await drainPendingQueue();
      return;
    }

    console.log(`⬇️ ${serverItems.length} update(s) from cloud.`);
    setStatus(`Pulling ${serverItems.length} update(s)…`);

    let latestTimestamp = localLastSync;
    let merged = [];

    // 2. Fetch each newer item (in the future, the server should
    //    expose /sync/batch-pull so this is one round-trip).
    for (const meta of serverItems) {
      try {
        const itemRes = await fetch(`${CF_WORKER_URL}/sync/item/${meta.key}`, {
          headers: { 'X-Sync-Token': SYNC_TOKEN },
        });
        if (!itemRes.ok) continue;
        const data = await itemRes.json();

        const [type, ...idParts] = meta.key.split('/');
        const id = idParts.join('/'); // re-join in case id contains slashes
        const store = STORE_BY_TYPE[type];
        if (!store) {
          console.warn(`Unknown sync type: ${type}`);
          continue;
        }

        // Tombstone: server says this item was deleted.
        if (data?.deleted === true) {
          try { await window.DB.del(store, id); } catch (_) {}
          merged.push({ type, id, deleted: true });
        } else {
          // Strip sync metadata before saving to local store
          const { lastModified, deleted, ...local } = data;
          const record = { ...local, key: id, lastModified, _syncedAt: Date.now() };
          // For plans/spreads the id IS the name; for charts it's the name;
          // for journal "catches" the id is row.id. Pick what fits the store.
          if (store === 'journal') {
            // catches are stored as a single record named 'catches' with data array
            const cur = await window.DB.get('journal', 'catches');
            const data2 = cur?.data || [];
            const idx = data2.findIndex((c) => c.key === id || c.id === id);
            const merged2 = [...data2];
            if (idx >= 0) merged2[idx] = { ...merged2[idx], ...local };
            else merged2.push(local);
            await window.DB.put('journal', { name: 'catches', data: merged2 });
          } else if (store === 'charts') {
            // charts is one record '__all__' with array
            const cur = await window.DB.get('charts', '__all__');
            const arr = cur?.charts || [];
            const idx = arr.findIndex((c) => c.name === id);
            const arr2 = [...arr];
            if (idx >= 0) arr2[idx] = { ...arr2[idx], ...local };
            else arr2.push(local);
            await window.DB.put('charts', { name: '__all__', charts: arr2, savedAt: new Date().toISOString() });
          } else {
            // plans, spreads, layers — keyed by id/name
            // For plans: check if a record with same name already exists locally
            // to avoid duplicates when the cloud key differs from local auto-increment id
            if (store === 'plans' && local.meta?.name) {
              const existing = await window.DB.getAll('plans').catch(() => []);
              const match = existing.find(p => (p.meta?.name || p.name) === local.meta.name);
              if (match) {
                // Update existing record in place rather than creating a new one
                await window.DB.put(store, { ...match, ...local, _syncedAt: Date.now() });
              } else {
                await window.DB.put(store, record);
              }
            } else {
              await window.DB.put(store, record);
            }
          }
          merged.push({ type, id, deleted: false });
        }

        if (meta.lastModified && meta.lastModified > latestTimestamp) {
          latestTimestamp = meta.lastModified;
        }
      } catch (err) {
        console.warn(`Failed to pull ${meta.key}:`, err);
      }
    }

    // 3. Update our high-water mark.
    await window.DB?.put('settings', {
      key: 'lastSyncTimestamp',
      value: typeof latestTimestamp === 'string'
        ? new Date(latestTimestamp).getTime()
        : latestTimestamp,
    });

    // 4. Drain any pending offline writes from earlier.
    await drainPendingQueue();

    // 5. Notify the rest of the app so panels can refresh.
    window.dispatchEvent(new CustomEvent('trollmap:data-synced', {
      detail: { merged },
    }));

    setStatus(`✅ Synced ${merged.length} item(s)`);
  } catch (err) {
    console.warn('Cloud pull failed:', err);
    setStatus('Pull failed', true);
  }
}

/**
 * Backfill — push every existing local record up to the cloud.
 * Useful for first-time setup when you have lots of local data
 * that needs to migrate to D1.
 */
export async function pushAllLocalToCloud() {
  if (!window.DB?.db) return;
  const stores = ['plans', 'spreads', 'journal', 'layers']; // charts live in R2, not D1
  let count = 0;
  for (const store of stores) {
    try {
      const all = await window.DB.getAll(store);
      for (const rec of all) {
        const id = rec.key ?? rec.name ?? rec.id ?? 'unknown';
        const type = Object.entries(STORE_BY_TYPE).find(([, v]) => v === store)?.[0];
        if (!type) continue;
        pushItemOnSave(type, String(id), rec);
        count++;
      }
    } catch (err) {
      console.warn(`Backfill ${store} failed:`, err);
    }
  }
  console.log(`☁️ Queued ${count} items for cloud upload.`);
}

// Convenience for old monolithic code paths that call window.pushItemOnSave
window.pushItemOnSave = pushItemOnSave;
