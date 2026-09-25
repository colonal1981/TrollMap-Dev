// research/storage.js — split from worker-research.js (behavior-preserving)
import { CORS, JSON_HEADERS, callLLM, extractLLMText, r2Text, r2Body, listAllR2 } from '../worker-core.js';
import { getLakeIntel, lakeKeyFromName } from '../worker-data.js';
import { searchWeb } from './clients.js';
import { extractJsonPossibly, researchStorageId, resolveResearchStorageId, stripLakeQualifiers } from './keys.js';
import { stateFullName } from './dataset.js';
import { lakeIndex, identityNamesForLake, resolveRegistryRow } from '../registry.js';
import { buildFactualSummary } from './facts-util.js';
import { writtenOf } from '../../js/utils/fact-date.js';

async function handleResearchList(env) {
  const prefix = "lakes/";
  const masters = [];
  const versions = [];
  // THE SAME READER THE SWEEP USES. This route and refreshStaleLimnology both answer "which
  // waters have a profile?" off this prefix, and until 2026-09-05 they disagreed -- this one
  // paginated and the sweep did not, so /research/list said 80 while the sweep could act on 76.
  // One function, so the two cannot drift apart again.
  for (const obj of await listAllR2(env.R2_TROLLMAP_CHARTPACKS, prefix)) {
    if (obj.key.includes("/versions/")) {
      versions.push({key: obj.key, size: obj.size, uploaded: obj.uploaded});
    } else if (obj.key.startsWith("lakes/") && obj.key.endsWith(".json") && !obj.key.includes("lake_packages")) {
      masters.push({key: obj.key, size: obj.size, uploaded: obj.uploaded, id: obj.key.replace(/^lakes\//,'').replace(/\.json$/,'')});
    }
  }
  masters.sort((a,b)=>a.key.localeCompare(b.key));
  return new Response(JSON.stringify({ok:true, count: masters.length, lakes: masters, versionFiles: versions.length, timestamp: new Date().toISOString()}), {headers: JSON_HEADERS});
}

/**
 * Every OTHER name the registry says this water answers to, for the id resolution below.
 *
 * A profile is filed under whatever the water was CALLED the day it was written, and the resolver
 * underneath only ever tried the one name it was handed. Measured 2026-09-01 across all 80
 * profiles in the bucket: four waters had two profiles each, and every older -- and better --
 * one was filed under a name `legacy_display_names` still carries.
 *
 *   Richard B Russell Lake   lake_russell_sc   + lake_richard_russell_ga
 *   Lake Sidney Lanier       lake_lanier_ga    + lake_sidney_lanier_hall_co_ga
 *   Nottely Lake             lake_nottely_ga   + nottely_lake_ga
 *   Watauga Lake             watauga_tn        + watauga_lake_tn
 *
 * NEVER THROWS. lakeIndex() reads R2 and can fail, and a failure here must degrade to exactly the
 * behaviour this had yesterday -- the caller's own name and nothing else. A read that 404s because
 * the index was briefly unavailable would send a researched lake back through the whole pipeline,
 * which is the failure this function exists to stop.
 */
async function registryIdentityNames(env, lakeName) {
  try {
    return identityNamesForLake(await lakeIndex(env), lakeName) || [];
  } catch (err) {
    console.warn('[storage] identity names unavailable for', lakeName, err && err.message);
    return [];
  }
}

async function handleResearchGet(env, lakeId, version = null) {
  // Every key this lake could be filed under, not just the one its current display name
  // sanitizes to. A 404 here is what sent J. Strom Thurmond back through the whole pipeline
  // on 2026-08-16 while its verified profile sat in the bucket under the pre-county name.
  const found = await resolveResearchStorageId(lakeId,
    (id) => env.R2_TROLLMAP_CHARTPACKS.get(`lakes/${id}.json`).catch(() => null),
    await registryIdentityNames(env, lakeId));
  const safe = found ? found.id : researchStorageId(lakeId);
  const masterKey = `lakes/${safe}.json`;
  const obj = found ? found.hit : null;
  if (!obj) return new Response(JSON.stringify({ok:false, error:`no profile for ${lakeId} (${safe})`}), {status:404, headers:JSON_HEADERS});

  // AN OLDER VERSION, READ THROUGH THE SAME RESOLUTION. `lakes/versions/<id>/vN.json` has been
  // written on every save since the beginning and nothing could ever read it back: 802 objects of
  // history that only the writer had ever seen. Ryan, 2026-09-04, when told we would have to wait
  // to learn what a batch run cost: "we aren't guessing at it... the old research profiles will
  // tell you". They can only tell us if something serves them.
  //
  // IT HANGS OFF /research/get RATHER THAN BEING ITS OWN ROUTE because the hard part is resolving
  // which key this water is filed under, and that is already done above. A second route would be a
  // second copy of that resolution, and this file's history is a list of what happens when two
  // copies of a resolution drift.
  if (version != null) {
    const vKey = `lakes/versions/${safe}/v${version}.json`;
    const vObj = await env.R2_TROLLMAP_CHARTPACKS.get(vKey).catch(() => null);
    if (!vObj) {
      // Saying "no such version" without saying which exist makes the caller guess twice.
      let have = [];
      try {
        const listed = await env.R2_TROLLMAP_CHARTPACKS.list({ prefix: `lakes/versions/${safe}/` });
        have = listed.objects.map((o) => Number((o.key.match(/v(\d+)\.json/) || [])[1]))
          .filter(Number.isFinite).sort((a, b) => a - b);
      } catch (err) {
        console.warn(`[storage] version list failed for ${safe}:`, err && err.message);
      }
      return new Response(JSON.stringify({ok:false, error:`no version ${version} for ${safe}`,
        lakeId, sanitized: safe, versionsAvailable: have}), {status:404, headers:JSON_HEADERS});
    }
    let vData;
    try { vData = JSON.parse(await r2Text(vObj)); } catch (err) {
      return new Response(JSON.stringify({ok:false, error:`version ${version} for ${safe} is not valid JSON`}),
        {status:500, headers:JSON_HEADERS});
    }
    return new Response(JSON.stringify({ok:true, lakeId, sanitized: safe, masterKey: vKey,
      version: Number(version), profile: vData}), {headers: JSON_HEADERS});
  }

  const text = await r2Text(obj);
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    // `{raw: text}` is served with ok:true and looks like a profile to every caller, so a
    // corrupted object in R2 reads as a lake that mysteriously has no facts rather than as
    // a broken file. The shape is kept -- it lets a human recover the bytes -- but the fact
    // that this lake's stored profile no longer parses has to reach the log.
    console.error(`[storage] profile for ${safe} is not valid JSON (${text.length} bytes):`, err && err.message);
    data = { raw: text, parseError: err && err.message };
  }
  // also try to list package files
  let packageFiles = [];
  try {
    const pkgListed = await env.R2_TROLLMAP_CHARTPACKS.list({prefix: `lake_packages/${safe}/`});
    packageFiles = pkgListed.objects.map(o=>({key:o.key, size:o.size, name:o.key.split('/').pop()}));
  } catch (err) {
    // An empty list is a legitimate answer; a failed list is not the same thing, and the
    // caller cannot tell them apart from the response.
    console.warn(`[storage] package list failed for ${safe}:`, err && err.message);
  }
  let versionList = [];
  try {
    const vListed = await env.R2_TROLLMAP_CHARTPACKS.list({prefix: `lakes/versions/${safe}/`});
    versionList = vListed.objects.map(o=>({key:o.key, size:o.size, version: (o.key.match(/v(\d+)\.json/)||[])[1]||null})).sort((a,b)=> (parseInt(b.version||0)-parseInt(a.version||0)));
  } catch (err) {
    console.warn(`[storage] version list failed for ${safe}:`, err && err.message);
  }
  return new Response(JSON.stringify({ok:true, lakeId: lakeId, sanitized: safe, masterKey, profile: data, packageFiles, versions: versionList}), {headers: JSON_HEADERS});
}

// The four keys retired on 2026-09-23. Deleted from every profile as it is saved, so the last
// profile carrying one disappears on its next write rather than needing a migration pass.
const STRIP_ON_SAVE = ['status', 'verified', 'verifiedAt', 'approvedBy'];

async function handleResearchSave(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ok:false, error:"invalid JSON"}), {status:400, headers:JSON_HEADERS}); }
  const lakeName = String(body.lakeName || body.profile?.lakeName || body.profile?.identity?.lakeName || '').trim();
  if (!lakeName) return new Response(JSON.stringify({ok:false, error:"missing lakeName"}), {status:400, headers:JSON_HEADERS});
  // SAVE UNDER THE KEY THIS LAKE ALREADY HAS, NOT THE ONE ITS CURRENT NAME SPELLS.
  //
  // This was the only path in the Worker that did not resolve first, and that is why the store
  // gains a new key every time a display name changes. handleResearchGet resolves, so the app
  // reads the old profile and then writes the merge to a NEW id -- leaving two profiles for one
  // lake and a picker that can only ever match one of them. Lake Robinson has exactly that:
  // `lake_robinson_sc` from before the county rename and `hb_robinson_lake_darlington_co_sc`
  // from a run after it. Measured 2026-08-23: 59 of the 62 profiles in the bucket are under the
  // pre-county spelling.
  //
  // A NEW lake still gets researchStorageId(), so nothing changes for a first save.
  const foundKey = await resolveResearchStorageId(lakeName,
    (id) => env.R2_TROLLMAP_CHARTPACKS.get(`lakes/${id}.json`).catch(() => null),
    await registryIdentityNames(env, lakeName));
  const safe = foundKey ? foundKey.id : researchStorageId(lakeName);
  const incomingProfile = body.profile || body;
  const packageParts = body.packageParts || body.parts || {};
  const notes = body.notes || incomingProfile.notes || "";

  // Determine next version
  let nextVersion = 1;
  let existingMeta = null;
  try {
    const existingObj = foundKey ? foundKey.hit : await env.R2_TROLLMAP_CHARTPACKS.get(`lakes/${safe}.json`);
    if (existingObj) {
      const txt = await r2Text(existingObj);
      const existing = JSON.parse(txt);
      existingMeta = existing.metadata || {};
      const v = parseInt(existingMeta.version || existingMeta.versionNumber || 0);
      if (v) nextVersion = v+1;
      else {
        // list versions to find max
        const vList = await env.R2_TROLLMAP_CHARTPACKS.list({prefix:`lakes/versions/${safe}/`});
        let maxV = 0;
        for (const o of vList.objects) {
          const m = o.key.match(/v(\d+)\.json/);
          if (m) maxV = Math.max(maxV, parseInt(m[1]));
        }
        nextVersion = maxV+1 || 2;
      }
    }
  } catch (err) {
    // DO NOT DEFAULT TO 1 HERE. `nextVersion` is initialised to 1, so swallowing this left it
    // at 1 whenever the read failed for a reason that had nothing to do with the profile being
    // new -- a transient R2 error, a throttle, a malformed existing document. The save then
    // wrote lakes/versions/<lake>/v1.json ON TOP of the real version 1 and reset the counter,
    // losing history with no error anywhere.
    //
    // A version number we could not determine is not a version number. Fail the save.
    console.error(`[storage] version lookup failed for ${safe}:`, err && err.message);
    throw new Error(`cannot determine next version for ${safe}: ${err && err.message}`);
  }

  // ── NO CONFIDENCE AND NO EVIDENCE MAP ARE COMPUTED OR STORED ────────────────────────────────
  //
  // Both stood here and both reached nothing that decides anything -- see the note in agents.js for
  // the confidence, and below for the evidence map. A save no longer invents a percentage.
  //
  // `sources` STAYS. It is the list of feeds and documents a run consulted, it is what the research
  // tab lists, and it is not a score.
  const sources = incomingProfile.sources || [];

  // AND ANY CONFIDENCE OR EVIDENCE ON THE INCOMING PROFILE IS DROPPED RATHER THAN CARRIED.
  //
  // Ryan's own rule: "do not leave unused objects behind, this is how stuff gets missed." A field we
  // stop writing and never strip becomes immortal, because every save merges the stored profile
  // forward -- so the 78 profiles that already carry these would have kept them for ever while
  // nothing wrote or read them. Stripping on save is what makes the deletion actually happen, one
  // water at a time as each is next saved.
  delete incomingProfile.confidence;
  delete incomingProfile.evidence;
  if (packageParts && typeof packageParts === 'object') delete packageParts.evidence;

  // Merge master profile per spec section 6
  const now = new Date().toISOString();
  // Pull identity fields from all sources - identity agent, incoming profile top-level, package parts
  const _id = incomingProfile.identity || packageParts.identity || {};
  const master = {
    lakeName: incomingProfile.lakeName || lakeName,
    aliases: incomingProfile.aliases || _id.aliases || [],
    state: incomingProfile.state || _id.state || packageParts.identity?.state || "",
    riverSystem: incomingProfile.riverSystem || _id.riverSystem || "",
    archetype: incomingProfile.archetype || _id.archetype || "",
    surfaceAreaAcres: incomingProfile.surfaceAreaAcres ?? _id.surfaceAreaAcres ?? null,
    maxDepthFt: incomingProfile.maxDepthFt ?? _id.maxDepthFt ?? null,
    averageDepthFt: incomingProfile.averageDepthFt ?? _id.averageDepthFt ?? null,
    damName: incomingProfile.damName || _id.damName || null,
    yearImpounded: incomingProfile.yearImpounded ?? _id.yearImpounded ?? null,
    reservoirOwner: incomingProfile.reservoirOwner || _id.reservoirOwner || null,
    county: incomingProfile.county || _id.county || null,
    normalPoolFt: incomingProfile.normalPoolFt ?? _id.normalPoolFt ?? null,
    gpsCenter: incomingProfile.gpsCenter || _id.gpsCenter || null,
    // Preserve the full identity section including _geometryDerived flag and
    // _bathymetryMeta so bathymetry-derived depth values survive save/load
    // cycles and resume runs can re-apply them correctly.
    identity: _id,
    limnology: incomingProfile.limnology || packageParts.limnology || {},
    biology: incomingProfile.biology || packageParts.biology || {},
    habitat: incomingProfile.habitat || packageParts.habitat || {},
    navigation: incomingProfile.navigation || packageParts.navigation || {},
    regulations: incomingProfile.regulations || packageParts.regulations || {},
    trollingIntelligence: incomingProfile.trollingIntelligence || incomingProfile.fisheries || packageParts.trollingIntelligence || packageParts.fisheries || null,
    summary: incomingProfile.summary || packageParts.summary || {},
    fieldStatus: incomingProfile.fieldStatus || {},
    sources: incomingProfile.sources || sources || [],
    metadata: {
      // A KEY THIS SAVE DOES NOT MANAGE MUST SURVIVE IT.
      //
      // This object was a literal of ten keys, so every save silently deleted any metadata another
      // endpoint owns. Two exist and both matter:
      //
      //   limnologyRefreshedAt   written by the WQP sweep (research/limnology.js:1048) -- the ONLY
      //                          record of when a profile's limnology was merged, which is exactly
      //                          what a "has this merge gone stale?" check has to read. Measured
      //                          2026-09-12: Lake Moultrie's master carried it and v18 did not,
      //                          because the 09-04 batch save had already dropped it once.
      // RETIRED 2026-09-23: status / verified / verifiedAt / approvedBy. They recorded one thing
      // -- that somebody clicked Approve in the research tab -- and measured against the mirror
      // that day the flag carried no information about the profile: 54 of 61 `verified` profiles
      // held ZERO extracted facts, while the draft with the most facts on the drive (Congaree, 62)
      // was the one `lake-intel` threw away for not being verified. `confidence.biology.reason`
      // is the derived answer to the question the flag pretended to answer. STRIP_ON_SAVE below
      // takes the four keys off any profile that still carries them, so the stored data cleans
      // itself the next time each one is written.
      //
      // Same shape as the 2026-09-04 defect this file already carries a comment about: writing a
      // default over a value someone else set is a write, not a default. The spread goes FIRST and
      // every one of the ten managed keys is assigned after it, so this can only ever carry forward
      // a key the save does not own -- it cannot resurrect a managed value.
      ...(existingMeta || {}),
      version: `${nextVersion}.0`,
      versionNumber: nextVersion,
      lastUpdated: now,
      createdAt: existingMeta?.createdAt || now,
      createdBy: body.requestedBy || incomingProfile.metadata?.createdBy || "Ryan",
      lakeId: safe,
      previousVersion: existingMeta?.version || null
    },
    notes: notes,
    researchLog: incomingProfile.researchLog || body.researchLog || {requestTime: now, completedAgents: Object.keys(packageParts)},
    _extractedFacts: incomingProfile._extractedFacts || [],
    _extractedFactsCount: incomingProfile._extractedFactsCount || (incomingProfile._extractedFacts || []).length,
    _wqpLimnology: incomingProfile._wqpLimnology || null
  };

  // The spread above carries forward every key this save does not manage, which is what keeps
  // limnologyRefreshedAt alive -- and would also keep the four retired keys alive forever. A
  // client that still posts `status` or `approve` is ignored rather than honoured.
  for (const dead of STRIP_ON_SAVE) delete master.metadata[dead];

  // THE SENTENCE MUST NOT OUTLIVE THE NUMBERS IT STATES.
  //
  // `summary.text` is a deterministic restatement of identity + biology + limnology + habitat,
  // and `researchIntel()` hands it to the model -- so it is the copy of these numbers that
  // actually reaches a plan. Only one client path rebuilt it: `assembleAndSaveProfile`, at the
  // end of an agent run. Every other path -- Smart Plan targeted recovery, the geometry
  // re-derive, the validation pass, the editor -- rewrote `identity` and posted the OLD
  // sentence back.
  //
  // Measured 2026-08-24 on Fishing Creek Reservoir (Lancaster Co, SC) v7.0, saved with zero
  // agents: identity read `maxDepthFt: 39` and `surfaceAreaAcres: 2170` from the rebuilt pack
  // while summary.text still read "about 3,431 surface acres, with a maximum depth near 100
  // feet". One file, both numbers, and the wrong one is the one the planner reads.
  //
  // Rebuilt HERE because this is the single door all twelve client save paths go through --
  // the same reason the storage id is resolved here rather than in each of them. Ryan,
  // 2026-08-24: *"why would i run all 8 agents for an identity problem that doesn't even need
  // an agent at all to solve"*. It does not, and now it does not have to.
  //
  // Only replaces a sentence the builder can actually produce, and never touches keywords.
  try {
    const rebuilt = buildFactualSummary(master);
    if (rebuilt && rebuilt !== master.summary?.text) {
      master.summary = { ...(master.summary || {}), text: rebuilt };
    }
  } catch (err) {
    // A profile that cannot be summarised must still SAVE. Losing the run because one
    // habitat field is a shape this builder did not expect is a worse failure than a
    // sentence that stays stale, and the log names the lake so it is not silent.
    console.error(`[storage] summary rebuild failed for ${safe}:`, err && err.message);
  }

  const masterJson = JSON.stringify(master);
  if (masterJson.length > 250*1024) {
    console.warn(`Lake profile ${safe} exceeds 250KB: ${masterJson.length}`);
  }

  // Save current master
  await env.R2_TROLLMAP_CHARTPACKS.put(`lakes/${safe}.json`, masterJson, {
    httpMetadata: {contentType:"application/json"},
    customMetadata: {version: String(nextVersion), status: master.metadata.status, lakeName: lakeName, updated: now}
  });
  // Save version copy
  await env.R2_TROLLMAP_CHARTPACKS.put(`lakes/versions/${safe}/v${nextVersion}.json`, masterJson, {
    httpMetadata: {contentType:"application/json"},
    customMetadata: {version: String(nextVersion), lakeName: lakeName}
  });

  // Save package parts (hybrid)
  const partKeys = ['identity','limnology','biology','forage','habitat','navigation','regulations','trollingIntelligence','summary'];
  for (const k of partKeys) {
    const partData = packageParts[k] || master[k];
    if (partData) {
      await env.R2_TROLLMAP_CHARTPACKS.put(`lake_packages/${safe}/${k}.json`, JSON.stringify(partData, null, 2), {
        httpMetadata: {contentType:"application/json"},
        customMetadata: {lakeName, version: String(nextVersion)}
      });
    }
  }
  // Save sources, research_log, metadata as separate files for Inspector
  await env.R2_TROLLMAP_CHARTPACKS.put(`lake_packages/${safe}/sources.json`, JSON.stringify(master.sources||[], null, 2), {httpMetadata:{contentType:"application/json"}});
  await env.R2_TROLLMAP_CHARTPACKS.put(`lake_packages/${safe}/metadata.json`, JSON.stringify(master.metadata, null, 2), {httpMetadata:{contentType:"application/json"}});
  await env.R2_TROLLMAP_CHARTPACKS.put(`lake_packages/${safe}/research_log.json`, JSON.stringify(master.researchLog||{}, null, 2), {httpMetadata:{contentType:"application/json"}});
  if (master.notes) {
    await env.R2_TROLLMAP_CHARTPACKS.put(`lake_packages/${safe}/notes.md`, String(master.notes), {httpMetadata:{contentType:"text/markdown"}});
  }

  return new Response(JSON.stringify({ok:true, lakeId: safe, lakeName, version: nextVersion, masterKey: `lakes/${safe}.json`, status: master.metadata.status, bytes: masterJson.length}), {headers: JSON_HEADERS});
}

async function handleResearchDeleteNormalizedDoc(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || '').trim();
  const docUrl = String(body.url || '').trim();
  if (!lakeName) return new Response(JSON.stringify({ ok: false, error: 'missing lakeName' }), { status: 400, headers: JSON_HEADERS });
  if (!docUrl) return new Response(JSON.stringify({ ok: false, error: 'missing url' }), { status: 400, headers: JSON_HEADERS });

  const safe = researchStorageId(lakeName);
  const key = `lake_packages/${safe}/normalized_documents.json`;
  const obj = await env.R2_TROLLMAP_CHARTPACKS.get(key).catch(() => null);
  if (!obj) return new Response(JSON.stringify({ ok: false, error: 'no normalized documents found' }), { status: 404, headers: JSON_HEADERS });

  let docs;
  try { docs = JSON.parse(await r2Text(obj)); } catch { return new Response(JSON.stringify({ ok: false, error: 'corrupt normalized documents' }), { status: 500, headers: JSON_HEADERS }); }

  const normTarget = docUrl.split('?')[0].toLowerCase();
  const before = docs.length;
  const filtered = docs.filter(d => String(d.url || '').split('?')[0].toLowerCase() !== normTarget);
  const removed = before - filtered.length;

  if (removed === 0) return new Response(JSON.stringify({ ok: false, error: 'document not found in cache', url: docUrl }), { status: 404, headers: JSON_HEADERS });

  await env.R2_TROLLMAP_CHARTPACKS.put(key, JSON.stringify(filtered, null, 2), { httpMetadata: { contentType: 'application/json' } });
  console.log(`[delete-normalized-doc] removed ${removed} doc(s) matching ${docUrl} from ${lakeName}`);
  return new Response(JSON.stringify({ ok: true, lakeName, url: docUrl, removed, remaining: filtered.length }), { headers: JSON_HEADERS });
}

async function handleResearchDelete(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || body.lake || '').trim();
  if (!lakeName) return new Response(JSON.stringify({ ok:false, error:'missing lakeName' }), { status:400, headers:JSON_HEADERS });
  // DELETE WHAT THE READ WOULD SHOW, or the button lies. handleResearchGet resolves through the
  // candidate list, so the panel can be displaying `lake_robinson_sc` while this deleted
  // `lake_robinson_chesterfield_co_sc` -- a key that does not exist -- and reported a clean run.
  // Nothing was removed and the UI said "Deleted research for ...".
  //
  // AN EXPLICIT `id` SKIPS THE RESOLUTION ENTIRELY, and collapsing a duplicate is why it exists.
  // Four waters carry two profiles -- lake_lanier_ga beside lake_sidney_lanier_hall_co_ga, and
  // three more -- and removing the wrong one is unrecoverable. Resolving by name is fine for the
  // button, which deletes whatever the panel is showing, but it is NOT safe for that cleanup: run
  // by name once and it takes the thin duplicate, run it a second time and the same command takes
  // the good profile that was left. An id is the same object every time it is asked for.
  const explicitId = String(body.id || '').trim();
  if (explicitId && !/^[a-z0-9_]{1,80}$/.test(explicitId)) {
    return new Response(JSON.stringify({ ok:false, error:`not a storage id: ${explicitId}` }),
      { status:400, headers:JSON_HEADERS });
  }
  const foundKey = explicitId ? null : await resolveResearchStorageId(lakeName,
    (id) => env.R2_TROLLMAP_CHARTPACKS.get(`lakes/${id}.json`).catch(() => null),
    await registryIdentityNames(env, lakeName));
  const safe = explicitId || (foundKey ? foundKey.id : researchStorageId(lakeName));
  if (explicitId && !(await env.R2_TROLLMAP_CHARTPACKS.head(`lakes/${safe}.json`).catch(() => null))) {
    // Saying "deleted 0" for an id that was never there reads as success. It is the difference
    // between "already done" and "you typed it wrong", and only one of those is safe to ignore.
    return new Response(JSON.stringify({ ok:false, error:`no profile stored at lakes/${safe}.json`,
      lakeName, id: safe }), { status:404, headers:JSON_HEADERS });
  }
  const keys = [`lakes/${safe}.json`];
  try {
    const pkg = await env.R2_TROLLMAP_CHARTPACKS.list({ prefix: `lake_packages/${safe}/` });
    for (const o of pkg.objects) keys.push(o.key);
  } catch (err) {
    // Worth shouting about: a failed list here means those objects are NOT in `keys`, so the
    // delete below leaves them behind while reporting a clean run.
    console.error(`[storage] package list failed during delete for ${safe}:`, err && err.message);
  }
  try {
    const vers = await env.R2_TROLLMAP_CHARTPACKS.list({ prefix: `lakes/versions/${safe}/` });
    for (const o of vers.objects) keys.push(o.key);
  } catch (err) {
    console.error(`[storage] version list failed during delete for ${safe}:`, err && err.message);
  }
  // Collect failures instead of swallowing them. This loop used to report success to the
  // caller whether or not anything was actually deleted.
  const failed = [];
  for (const key of keys) {
    try {
      await env.R2_TROLLMAP_CHARTPACKS.delete(key);
    } catch (err) {
      console.error(`[storage] delete failed: ${key}`, err && err.message);
      failed.push(key);
    }
  }
  if (failed.length) {
    console.error(`[storage] ${failed.length} of ${keys.length} deletes failed for ${safe}`);
  }
  return new Response(JSON.stringify({ ok:true, lakeName, deleted: keys.length }), { headers: JSON_HEADERS });
}

async function handleResearchPackage(env, lakeId) {
  const found = await resolveResearchStorageId(lakeId, async (id) => {
    const l = await env.R2_TROLLMAP_CHARTPACKS.list({ prefix: `lake_packages/${id}/` }).catch(() => null);
    return l && l.objects.length ? l : null;
  }, await registryIdentityNames(env, lakeId));
  const safe = found ? found.id : researchStorageId(lakeId);
  const listed = found ? found.hit : { objects: [] };
  if (!listed.objects.length) return new Response(JSON.stringify({ok:false, error:`no package for ${lakeId}`}), {status:404, headers:JSON_HEADERS});
  const files = [];
  for (const o of listed.objects) {
    files.push({key:o.key, name:o.key.split('/').pop(), size:o.size, uploaded:o.uploaded});
  }
  files.sort((a,b)=>a.name.localeCompare(b.name));
  return new Response(JSON.stringify({ok:true, lakeId: lakeId, sanitized: safe, count: files.length, files}), {headers: JSON_HEADERS});
}

async function handleResearchPackageFile(env, lakeId, filename) {
  const found = await resolveResearchStorageId(lakeId,
    (id) => env.R2_TROLLMAP_CHARTPACKS.get(`lake_packages/${id}/${filename}`).catch(() => null),
    await registryIdentityNames(env, lakeId));
  const safe = found ? found.id : researchStorageId(lakeId);
  const key = `lake_packages/${safe}/${filename}`;
  const obj = found ? found.hit : null;
  if (!obj) return new Response(JSON.stringify({ok:false, error:`no file ${filename} for ${lakeId}`}), {status:404, headers:JSON_HEADERS});
  const ct = filename.endsWith('.json') ? 'application/json' : filename.endsWith('.md') ? 'text/markdown' : 'application/octet-stream';
  const pkgHeaders = new Headers({...CORS, "Content-Type": ct, "Cache-Control": "no-store"});
  return new Response(r2Body(obj, pkgHeaders), {headers: pkgHeaders});
}

async function handleEnhancedLakeIntel(lakeName, env) {
  // The live context (source registry, scraped report, LakeMonster) with the researched profile
  // beside it. The curated LAKE_INTEL half went on 2026-09-24; the research profile is the profile.
  const key = lakeKeyFromName(lakeName);
  const curated = await getLakeIntel(lakeName);
  let researched = null;
  let researchedProfile = null;
  try {
    const safe = researchStorageId(lakeName);
    // try full lakeName sanitized, then key sanitized
    let obj = await env.R2_TROLLMAP_CHARTPACKS.get(`lakes/${safe}.json`);
    if (!obj) {
      const safeKey = researchStorageId(key);
      obj = await env.R2_TROLLMAP_CHARTPACKS.get(`lakes/${safeKey}.json`);
    }
    if (obj) {
      const txt = await r2Text(obj);
      researchedProfile = JSON.parse(txt);
      researched = {
        exists: true,
        lakeName: researchedProfile.lakeName,
        version: researchedProfile.metadata?.version,
        status: researchedProfile.metadata?.status,
        lastUpdated: researchedProfile.metadata?.lastUpdated,
        summary: researchedProfile.summary,
        trollingIntelligence: researchedProfile.trollingIntelligence,
        fullProfile: researchedProfile
      };
    }
  } catch (err) {
    console.warn('[storage] researched profile merge failed:', err && err.message);
  }
  return {...curated, researched, hasResearchedProfile: !!researched};
}

async function handleResearchValidationPass(request, env) {
  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ success:false, error:'invalid JSON' }), { status:400, headers:JSON_HEADERS });
  }
  const lakeName = String(body.lakeName || '').trim();
  const nullFields = Array.isArray(body.nullFields) ? body.nullFields.filter(Boolean) : [];
  // The client sends extractedFacts (array); retain facts for backward compatibility.
  const rawFacts = body.extractedFacts || body.facts || [];
  const facts = Array.isArray(rawFacts)
    ? rawFacts.map(f => `[${f.category || 'fact'}] ${f.fact || f.quote || ''}${writtenOf(f, rawFacts)}`).filter(Boolean).join('\n')
    : String(rawFacts || '').trim();

  if (!lakeName || !nullFields.length || !facts) {
    return new Response(JSON.stringify({ success:false, error:'missing lakeName, nullFields, or extractedFacts', filled:{} }), { status:400, headers:JSON_HEADERS });
  }

  const prompt = `Fill only requested null fields in a lake research profile for ${lakeName}.

REQUESTED FIELDS:\n${nullFields.join('\n')}

EXTRACTED, SOURCE-BACKED FACTS:\n${facts.slice(0, 30000)}

Return only a JSON object whose keys are requested dot paths and whose values are explicitly supported by the facts. Omit unsupported fields. Do not infer.
Rules: depth values must be specific and convert meters × 3.281; normalPoolFt must be an actual pool elevation, not a fluctuation.`;
  const payload = {
    messages: [
      { role: 'system', content: 'You are a JSON-only evidence extraction agent. Never guess.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0,
    max_tokens: 800,
    response_format: { type: 'json_object' }
  };
  try {
    const llmResult = await callLLM(env, payload, null);
    const parsed = extractJsonPossibly(extractLLMText(llmResult.data));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return new Response(JSON.stringify({ success:false, error:'validation agent returned non-JSON', filled:{} }), { status:502, headers:JSON_HEADERS });
    }
    const allowed = new Set(nullFields);
    // Accept either the requested flat dot-path object or a defensive
    // { filled: { ... } } wrapper from a provider that follows the endpoint
    // name rather than the prompt literally.
    const candidate = parsed.filled && typeof parsed.filled === 'object' && !Array.isArray(parsed.filled)
      ? parsed.filled : parsed;
    // `limnology.thermocline.strength` was the one field this guard existed for -- a qualitative
    // word the model kept answering with a depth. The field is gone, and every limnology number
    // now comes off a depth profile, so there is no path left for this to catch. The trophicStatus
    // wording rule went with it: that bucket is read off Carlson's secchi boundaries, not written.
    const validFieldValue = () => true;
    const filled = Object.fromEntries(Object.entries(candidate).filter(([path, value]) =>
      allowed.has(path) && value !== null && value !== '' && !(Array.isArray(value) && !value.length) && validFieldValue(path, value)
    ));
    return new Response(JSON.stringify({ success:true, filled, meta:{ provider:llmResult.provider, model:llmResult.model } }), { headers:JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ success:false, error:String(e.message || e), filled:{} }), { status:502, headers:JSON_HEADERS });
  }
}


async function handleResearchThermoclineSearch(request, env) {
  const body = await request.json().catch(() => ({}));
  const { lakeName } = body;
  if (!lakeName) return new Response(JSON.stringify({ ok: false, error: 'missing lakeName' }), { status: 400, headers: JSON_HEADERS });

  // THE SECOND COPY OF THE ANCHOR BUG, FOUND 2026-09-16 IN THE DEPLOYED BUNDLE.
  //
  // This was the identical end-anchored strip discover.js carried, and it fails the identical
  // way: a registry display name ends in a county parenthetical, not ", SC", so nothing was
  // stripped and all three queries went out quoting a phrase no page contains. Fixing it in
  // discover.js alone would have been "a fix applied to one caller of a shared misconception is
  // not applied to the misconception", which is a rule this project wrote down after the approve
  // and delete paths disagreed fourteen lines apart in one file.
  const waterRow = await (async () => {
    try { return resolveRegistryRow(await lakeIndex(env), lakeName); } catch { return null; }
  })();
  const waterType = String(waterRow?.feature_type || '').toLowerCase();

  // AND A RIVER IS NOT ASKED AT ALL. `water-type-hints.js` tells the fisheries agent "a river does
  // not stratify -- do NOT report a thermocline", and js/utils/wqp-limnology.js stopped listing it
  // as a gap for the same reason. Searching for one here would be the third half of the pipeline
  // hunting for what the other two refuse. THE REFUSAL TRAVELS: a caller gets a reason rather than
  // an empty result, because "we asked and it cannot answer" and "nobody asked" must look
  // different -- that is what the null-with-no-reason rule is for. Saves three searches and an LLM
  // extract on each of the 57 rivers.
  if (waterType === 'river') {
    return new Response(JSON.stringify({
      ok: true,
      lakeName,
      thermocline: null,
      articles: [],
      queryResults: [],
      note: 'Not searched: this water is a river. Moving water does not stratify, so there is no '
          + 'summer thermocline to find. This is a refusal, not a gap.',
    }), { headers: JSON_HEADERS });
  }

  const queryLake = stripLakeQualifiers(lakeName) || String(lakeName).trim();
  const st = stateFullName(waterRow?.state || 'SC');

  const queries = [
    `"${queryLake}" ${st} thermocline depth summer`,
    `"${queryLake}" ${st} summer fishing depth water temperature`,
    `"${queryLake}" ${st} fishing guide summer depths`,
  ];

  const articles = [];
  const queryResults = [];
  console.log(`[thermocline-search] Starting for ${lakeName} — ${queries.length} queries`);
  for (const q of queries) {
    try {
      console.log(`[thermocline-search] Query: ${q}`);
      const tfResult = await searchWeb({
        query: q,
        domain_type: 'web',
        purpose: `Find thermocline depth and summer fishing depth information for ${queryLake}`,
        location: 'US',
        language: 'en',
      }, env);
      const results = tfResult.results || [];
      let added = 0;
      for (const r of results) {
        const content = r.snippet || r.description || r.summary || r.markdown || r.content || '';
        if (!r.url || !content) continue;
        const normUrl = String(r.url).split('?')[0].toLowerCase();
        if (articles.some(a => a.url.split('?')[0].toLowerCase() === normUrl)) continue;
        articles.push({ url: r.url, title: r.title || r.url, content: content.slice(0, 3000) });
        added++;
        if (articles.length >= 5) break;
      }
      queryResults.push({ query: q, found: results.length, added });
      console.log(`[thermocline-search] → ${results.length} results, ${added} added (total articles: ${articles.length})`);
      if (articles.length >= 5) break;
    } catch (e) {
      console.warn(`[thermocline-search] query error: ${e.message}`);
      queryResults.push({ query: q, error: e.message });
    }
  }

  if (!articles.length) {
    console.log(`[thermocline-search] No articles found — returning early`);
    return new Response(JSON.stringify({ ok: true, thermocline: null, note: 'No guide articles found for thermocline search', articles: [], queryResults }), { headers: JSON_HEADERS });
  }
  console.log(`[thermocline-search] ${articles.length} articles collected — running LLM extract`);

  // Lightweight LLM extract — one call, all articles combined
  const articleText = articles.map((a, i) => `--- Article ${i+1}: ${a.title}\nURL: ${a.url}\n${a.content}`).join('\n\n');
  const systemPrompt = `You are a fishing intelligence analyst. Extract thermocline depth information from fishing guide articles about ${queryLake}. Return ONLY valid JSON, no markdown, no preamble.`;
  const userPrompt = `From the following articles about ${queryLake}, extract any mention of thermocline depth, depth at which fish hold in summer, or the depth below which water becomes too warm or too cold for fish activity.

${articleText}

Return JSON in this exact shape:
{
  "found": true or false,
  "summerThermoclineDepthFt": number or null,
  "depthRangeMin": number or null,
  "depthRangeMax": number or null,
  "confidence": "low" or "very_low",
  "confidenceScore": number between 20 and 45,
  "sourceCount": number of articles that mentioned depth,
  "note": "brief explanation of what was found and from which sources",
  "warning": "Anecdotal — derived from guide articles, not measured vertical profiles"
}

If no thermocline or depth information is found, return found: false and null for all depth fields.`;

  let thermocline = null;
  try {
    const llmResult = await callLLM(env, {
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      max_tokens: 400,
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });
    const text = extractLLMText(llmResult.data).replace(/\`\`\`json|\`\`\`/g, '').trim();
    const parsed = JSON.parse(text);
    if (parsed.found && parsed.summerThermoclineDepthFt != null) {
      thermocline = {
        summerThermoclineDepthFt: parsed.summerThermoclineDepthFt,
        depthRangeMin: parsed.depthRangeMin ?? null,
        depthRangeMax: parsed.depthRangeMax ?? null,
        confidence: 'low',
        confidenceScore: Math.min(45, Math.max(20, parsed.confidenceScore ?? 35)),
        sourceCount: parsed.sourceCount ?? articles.length,
        method: 'anecdotal_guide_articles',
        note: parsed.note || null,
        warning: 'Derived from fishing guide articles — not measured vertical profiles. Use as behavioral estimate only.',
      };
    }
  } catch (e) {
    console.warn(`[thermocline-search] LLM extract failed: ${e.message}`);
  }

  if (thermocline) {
    console.log(`[thermocline-search] ✔ Thermocline derived: ${thermocline.summerThermoclineDepthFt}ft (confidence ${thermocline.confidenceScore}%)`);
  } else {
    console.log(`[thermocline-search] ✗ No thermocline extracted from ${articles.length} articles`);
  }
  return new Response(JSON.stringify({
    ok: true,
    thermocline,
    articleCount: articles.length,
    articles: articles.map(a => ({ title: a.title, url: a.url })),
    queryResults,
    note: thermocline ? null : 'Articles found but no thermocline/depth information extracted',
  }), { headers: JSON_HEADERS });
}


// ── Vision Structure Scanner ──────────────────────────────────────────────────
// ── Vision Scan — single tile analysis endpoint ──────────────────────────────
// Tiling and ESRI image fetching happens client-side (no worker timeout issues).
// Worker receives one base64 image + bounds, runs Gemini, returns structures.

export { handleResearchList, handleResearchGet, handleResearchSave, handleResearchDeleteNormalizedDoc, handleResearchDelete, handleResearchPackage, handleResearchPackageFile, handleEnhancedLakeIntel, handleResearchValidationPass, handleResearchThermoclineSearch };
