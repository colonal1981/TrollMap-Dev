// research/shared.js — split from worker-research.js (behavior-preserving)
import { JSON_HEADERS, r2Text } from '../worker-core.js';
import { STATE_REGULATIONS_CONFIG, fetchStateRegulations, getLakeRegulations, tinyfishFetch } from './clients.js';

const SHARED_ROOT = 'research/shared';
const SHARED_ENABLED_DEFAULT = true;

function sharedEnabled(env) {
  const v = env.SHARED_RESEARCH_ENABLED;
  if (v === undefined || v === null) return SHARED_ENABLED_DEFAULT;
  return String(v).toLowerCase() !== 'false';
}

// ── Fingerprint ───────────────────────────────────────────────────────────────
// Bounded content fingerprint per section 12.3 — not a full cryptographic hash.
// Input capped ~12KB so Worker CPU cost is negligible.
async function contentFingerprint(title, text) {
  const len = text.length;
  const mid = Math.floor(len / 2);
  const sig = [
    (title || '').trim().toLowerCase(),
    String(len),
    text.slice(0, 4096),
    text.slice(Math.max(0, mid - 2048), mid + 2048),
    text.slice(Math.max(0, len - 4096))
  ].join('\x00');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sig));
  return 'fp:' + Array.from(new Uint8Array(buf)).slice(0, 8).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ── Canonical URL → document ID ───────────────────────────────────────────────
async function urlToDocId(canonicalUrl) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalUrl));
  return 'doc-' + Array.from(new Uint8Array(buf)).slice(0, 12).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ── Shared registry R2 helpers ────────────────────────────────────────────────
async function getSharedPointer(env) {
  try {
    const obj = await env.R2_TROLLMAP_CHARTPACKS.get(`${SHARED_ROOT}/pointers/current.json`);
    if (!obj) return null;
    return JSON.parse(await r2Text(obj));
  } catch {
    // Intentionally silent: no pointer object is the normal state before the first shared
    // document is stored, and every caller treats null as "nothing shared yet".
    // Audited 2026-08-03 -- this reports a real absence rather than hiding a failure.
    return null;
  }
}

/**
 * latest.json is an INDEX ENTRY, not a second copy of the document.
 *
 * It used to be the identical bytes: storeSharedDocument() wrote the full record to
 * versions/<versionId>.json and then wrote it again, verbatim, to latest.json. 1,616 shared
 * documents were stored as 3,375 objects, and roughly half a gigabyte of an 11.49 GB bucket
 * was the same text twice, growing by a full copy every time a document changed.
 *
 * A pointer alone would have cost an extra GET on every publish -- handleSharedPublish walks
 * every latest.json to build the generation manifest, and the manifest wants exactly these
 * fields. So latest.json carries them inline and points at the version for the rest. Publish
 * stays at one GET per document; the sections, which are all of the weight, live once.
 *
 * MIGRATION IS BY READ, NOT BY SCRIPT. Every latest.json written before 2026-08-05 is a full
 * inline record with no `pointer` flag, and isLatestPointer() sorts them out. They rewrite
 * themselves into the new shape the next time their document is stored. Nothing has to be
 * backfilled and nothing breaks if it never is.
 */
function isLatestPointer(v) {
  return !!(v && v.pointer === true && typeof v.versionId === 'string');
}

/** The manifest/index fields, lifted off a full record. Keep in step with handleSharedPublish. */
function latestPointerFor(doc) {
  return {
    pointer: true,
    id: doc.id,
    versionId: doc.versionId,
    canonicalUrl: doc.canonicalUrl,
    title: doc.title,
    authority: doc.authority,
    scope: doc.scope,
    lakeSlugs: doc.lakeSlugs,
    indexStatus: doc.indexStatus,
    sections: doc.sections?.length || 0,
    contentFingerprint: doc.contentFingerprint,
    fetchedAt: doc.fetchedAt,
    lastCheckedAt: doc.lastCheckedAt,
    ...(doc.fetchedBy ? { fetchedBy: doc.fetchedBy } : {}),
  };
}

// ── POST /research/shared/publish ─────────────────────────────────────────────
// Publish a new generation — builds manifest of all stored documents,
// validates, then atomically swaps the current pointer.
async function handleSharedPublish(request, env) {
  if (!sharedEnabled(env)) return new Response(JSON.stringify({ ok: false, disabled: true }), { headers: JSON_HEADERS });

  const genId = `gen-${Date.now()}`;
  try {
    // R2 list() returns at most 1,000 keys per call and sets truncated. This asked once and
    // filtered what came back, so with 3,375 objects under research/shared/documents/ the
    // "manifest of all stored documents" has been covering whatever the first page happened to
    // contain -- and a short manifest looks exactly like a small registry. Paginate.
    const latestKeys = [];
    let cursor;
    do {
      const listed = await env.R2_TROLLMAP_CHARTPACKS.list({ prefix: `${SHARED_ROOT}/documents/`, cursor });
      for (const o of listed.objects) if (o.key.endsWith('/latest.json')) latestKeys.push(o);
      cursor = listed.truncated ? listed.cursor : null;
    } while (cursor);

    // Compaction is bounded per run. Rewriting 1,616 inline records in one invocation is a lot
    // of parse work for a Worker on the free plan's CPU budget, and a publish that dies halfway
    // through leaves no manifest at all. A budget means each publish makes definite progress and
    // finishes; `inlineRemaining` in the response says how many are left, so it is obvious that
    // running it again does something.
    const COMPACT_BUDGET = 250;
    const manifest = { generationId: genId, publishedAt: new Date().toISOString(), documents: [] };
    let compacted = 0, compactedBytes = 0, orphanVersions = 0, inlineRemaining = 0;
    for (const obj of latestKeys) {
      const docObj = await env.R2_TROLLMAP_CHARTPACKS.get(obj.key);
      if (!docObj) continue;
      const stored = JSON.parse(await r2Text(docObj));
      // Since 2026-08-05 latest.json IS these fields; before that it was the whole document
      // and `sections` was the array rather than its length. latestPointerFor() flattens the
      // old shape into the new one, so this loop reads one object either way.
      const doc = isLatestPointer(stored) ? stored : latestPointerFor(stored);

      // PUBLISH IS THE MIGRATION. Every latest.json written before 2026-08-05 is a byte-for-byte
      // second copy of its version object -- about half a gigabyte across 1,616 documents. They
      // would otherwise only shrink when their document happened to be re-crawled, which for a
      // dead upstream URL is never. This loop is already reading each one, it is authenticated,
      // and it is the operation whose whole job is "make the shared registry consistent", so it
      // is the right place. head() first: narrowing an inline record whose version object is
      // missing would delete the only copy of its sections.
      if (!isLatestPointer(stored)) {
        if (compacted >= COMPACT_BUDGET) {
          inlineRemaining++;
        } else {
          const vKey = `${SHARED_ROOT}/documents/${doc.id}/versions/${doc.versionId}.json`;
          const vExists = doc.versionId ? await env.R2_TROLLMAP_CHARTPACKS.head(vKey).catch(() => null) : null;
          if (vExists) {
            await env.R2_TROLLMAP_CHARTPACKS.put(obj.key, JSON.stringify(doc),
              { httpMetadata: { contentType: 'application/json' } });
            compacted++;
            compactedBytes += Math.max(0, (obj.size || 0) - JSON.stringify(doc).length);
          } else {
            orphanVersions++;
          }
        }
      }

      manifest.documents.push({
        id: doc.id, versionId: doc.versionId, canonicalUrl: doc.canonicalUrl,
        title: doc.title, authority: doc.authority, scope: doc.scope,
        lakeSlugs: doc.lakeSlugs, indexStatus: doc.indexStatus,
        sections: doc.sections, fetchedAt: doc.fetchedAt
      });
    }
    if (compacted || orphanVersions || inlineRemaining) {
      console.log(`[shared-publish] compacted ${compacted} inline latest.json (~${(compactedBytes / 1e6).toFixed(1)} MB freed), `
                  + `${orphanVersions} left inline because their version object is missing, `
                  + `${inlineRemaining} left for the next run`);
    }

    // Write generation manifest
    await env.R2_TROLLMAP_CHARTPACKS.put(
      `${SHARED_ROOT}/generations/${genId}/manifest.json`,
      JSON.stringify(manifest, null, 2),
      { httpMetadata: { contentType: 'application/json' } }
    );

    // Rotate pointers — previous ← current, current ← new
    const currentObj = await env.R2_TROLLMAP_CHARTPACKS.get(`${SHARED_ROOT}/pointers/current.json`);
    if (currentObj) {
      const current = await r2Text(currentObj);
      await env.R2_TROLLMAP_CHARTPACKS.put(`${SHARED_ROOT}/pointers/previous.json`, current, { httpMetadata: { contentType: 'application/json' } });
    }
    await env.R2_TROLLMAP_CHARTPACKS.put(
      `${SHARED_ROOT}/pointers/current.json`,
      JSON.stringify({ generationId: genId, publishedAt: new Date().toISOString(), documentCount: manifest.documents.length }),
      { httpMetadata: { contentType: 'application/json' } }
    );

    console.log(`[shared-publish] generation ${genId} published — ${manifest.documents.length} documents`);
    return new Response(JSON.stringify({
      ok: true, generationId: genId, documentCount: manifest.documents.length,
      compacted, compactedBytes, orphanVersions, inlineRemaining,
    }), { headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: JSON_HEADERS });
  }
}

// ── GET /research/shared/status ───────────────────────────────────────────────
async function handleSharedStatus(request, env) {
  if (!sharedEnabled(env)) return new Response(JSON.stringify({ ok: true, enabled: false }), { headers: JSON_HEADERS });
  const pointer = await getSharedPointer(env);
  // Paginated for the same reason as publish: one list() call caps at 1,000 keys, and this
  // number is the one thing anyone checks to answer "how much is in the shared registry?"
  let latestCount = 0, inlineCount = 0, bytes = 0, cursor;
  do {
    const listed = await env.R2_TROLLMAP_CHARTPACKS
      .list({ prefix: `${SHARED_ROOT}/documents/`, cursor })
      .catch(() => ({ objects: [], truncated: false }));
    for (const o of listed.objects) {
      bytes += o.size || 0;
      if (!o.key.endsWith('/latest.json')) continue;
      latestCount++;
      // A compacted pointer is well under 2 KB; anything bigger is still an inline copy of its
      // whole document. Size is a good enough proxy to avoid 1,616 GETs just to report a count.
      if ((o.size || 0) > 2048) inlineCount++;
    }
    cursor = listed.truncated ? listed.cursor : null;
  } while (cursor);
  return new Response(JSON.stringify({
    ok: true, enabled: true, pointer,
    storedDocuments: latestCount,
    bytes,
    inlineLatestRemaining: inlineCount,
    note: inlineCount
      ? `${inlineCount} latest.json objects are still full inline copies of their version. `
        + 'POST /research/shared/publish compacts up to 250 per run.'
      : undefined,
  }), { headers: JSON_HEADERS });
}

// ── POST /research/shared/quarantine ─────────────────────────────────────────
async function handleSharedQuarantine(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const { canonicalUrl, reason } = body;
  if (!canonicalUrl) return new Response(JSON.stringify({ ok: false, error: 'missing canonicalUrl' }), { status: 400, headers: JSON_HEADERS });
  const docId = await urlToDocId(canonicalUrl);
  await env.R2_TROLLMAP_CHARTPACKS.put(
    `${SHARED_ROOT}/quarantine/${docId}.json`,
    JSON.stringify({ docId, canonicalUrl, reason: reason || 'manual', quarantinedAt: new Date().toISOString() }),
    { httpMetadata: { contentType: 'application/json' } }
  );
  return new Response(JSON.stringify({ ok: true, docId, quarantined: true }), { headers: JSON_HEADERS });
}

async function handleResearchRegsDebug(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state')?.toUpperCase();
  const lake = url.searchParams.get('lake') || '';
  const raw = url.searchParams.get('raw') === '1';
  const bust = url.searchParams.get('bust') === '1';
  if (!state) return new Response(JSON.stringify({ error: '?state= required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  try {
    const config = STATE_REGULATIONS_CONFIG[state];
    if (!config) return new Response(JSON.stringify({ error: 'No config for state' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    if (raw) {
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const result = await tinyfishFetch({ urls: config.pages.map(p => p.url), format: 'markdown' }, env);
      const text = result.results?.[0]?.text || '';
      const lmbIdx = text.search(/largemouth bass/i);
      return new Response(JSON.stringify({ state, url: config.pages[0].url, length: text.length, lmbIdx, preview: text.slice(offset, offset + 3000) }, null, 2), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    // bust=1 clears KV cache so fresh parse runs
    if (bust) {
      await env.KV.delete(`regulations:${state}:v4`).catch(() => {});
      await env.KV.delete(`regulations:${state}:v3`).catch(() => {});
      await env.KV.delete(`regulations:${state}:v2`).catch(() => {});
    }
    const stateRegs = await fetchStateRegulations(state, env);
    const lakeRegs = lake ? getLakeRegulations(stateRegs, lake) : null;
    return new Response(JSON.stringify({
      state, lake: lake || null,
      generalKeys: Object.keys(stateRegs.general || {}),
      lakeSpecificKeys: Object.keys(stateRegs.lakeSpecific || {}).slice(0, 20),
      lakeRegs: lakeRegs || null,
      sampleGeneral: Object.fromEntries(Object.entries(stateRegs.general || {}).slice(0, 5)),
    }, null, 2), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

export { isLatestPointer, latestPointerFor, SHARED_ROOT, SHARED_ENABLED_DEFAULT, sharedEnabled, contentFingerprint, urlToDocId, getSharedPointer, handleSharedPublish, handleSharedStatus, handleSharedQuarantine, handleResearchRegsDebug };
