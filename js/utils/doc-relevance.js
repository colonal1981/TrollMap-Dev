/**
 * doc-relevance.js — the off-lake gate, moved off the Worker.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY IT MOVED. This Worker is on the Cloudflare FREE plan, where CPU is capped at 10 ms per
 * request and, unlike the paid plan's 30 s, THAT NUMBER IS NOT CONFIGURABLE. `save-normalized`
 * was parsing up to 1.8 MB of JSON, scanning the first 3,000 characters of every document,
 * rebuilding the array and re-serialising it — all inside that 10 ms. From wrangler tail on
 * 2026-08-16: "POST /research/save-normalized - Exceeded CPU Limit".
 *
 * None of that work needs a Worker. The browser already holds the documents, has no CPU
 * ceiling, and is where they were fetched. What the Worker has that the browser does not is
 * the R2 credential — so it should write bytes and nothing else, which is what it does now:
 * the client sends the finished array and the Worker streams the request body straight into
 * the bucket without parsing it.
 *
 * The logic below is a port of the Worker's gate, unchanged in behaviour and now testable —
 * it could never be exercised where it was, because it lived behind an HTTP handler.
 */

const OFFICIAL_SOURCE = /eregulations\.com|dnr\.sc\.gov|dnr\.nc\.gov|epd\.georgia|epa\.gov|waterqualitydata|grokipedia|santeecooper|ncwildlife|tw\.gov/i;

/** "Lake Marion, SC" -> {baseName: "Marion", state: "SC"} */
export function lakeTerms(lakeName) {
  const name = String(lakeName || '');
  const baseName = name
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/^Lake\s+/i, '')
    .replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const m = name.match(/,?\s*\b(SC|NC|GA|TN)\b/i);
  return { baseName, state: m ? m[1].toUpperCase() : '' };
}

/**
 * Does this document plausibly concern this lake?
 *
 * Both a name AND a state signal, because "Marion Lake, MN" passes a name check on its own.
 * Official sources bypass it: an SCDNR or EPA document is about the water it is about, and
 * dropping one for failing a substring test costs more than the occasional off-lake page.
 */
export function isOnLakeDoc(doc, lakeName, altNames = []) {
  const { baseName, state } = lakeTerms(lakeName);
  const url = String(doc?.url || '').toLowerCase();
  if (OFFICIAL_SOURCE.test(url)) return true;

  const combined = `${String(doc?.title || '').toLowerCase()} ${url} `
    + `${String(doc?.fullText || doc?.text || '').slice(0, 3000).toLowerCase()}`;

  // EVERY NAME THE WATER HAS, because discovery was already told all of them and this was not.
  //
  // lake-research-engine.js builds `names` for /research/discover out of the registry row --
  // `[name, displayName, ...legacyDisplayNames]` -- under a comment naming the exact problem:
  // "SCDNR says 'Lake Thurmond' where the registry says 'J. Strom Thurmond Reservoir', TWRA says
  // 'Ft. Loudoun Reservoir' where it says 'Fort Loudoun Lake'." Discovery then found documents
  // under those names and handed them here, where the gate knew only the display name and threw
  // them away.
  //
  // Measured 2026-09-01 on two runs of the batch: Lake Sidney Lanier (Hall Co, GA) fetched nine
  // documents and this gate rejected SIX of them, both times. Its base name is "Sidney Lanier"
  // and every document in the world writes "Lake Lanier" -- which the registry has known all
  // along, in legacy_display_names. Counted across the 64 research waters: 40 carry a legacy
  // name whose base differs from the one this looks for, and the clean misses are the ones
  // nobody spells the registry's way -- Clarks Hill for Thurmond, Jordan Lake for B. Everett
  // Jordan Lake, Moss Lake for John H. Moss Lake, and every Lake-versus-Reservoir pair in
  // Tennessee, where "Norris Reservoir" does not contain "Norris Lake".
  //
  // Still both halves: a name AND a state. Widening the names does not widen the state test,
  // which is what keeps "Marion Lake, MN" out.
  const names = [String(lakeName || ''), baseName];
  for (const alt of Array.isArray(altNames) ? altNames : []) {
    if (!alt) continue;
    names.push(String(alt), lakeTerms(alt).baseName);
  }
  const hasLakeName = names
    .map((t) => String(t || '').toLowerCase().trim())
    .filter((t) => t.length >= 4)
    .some((t) => combined.includes(t));
  if (!hasLakeName) return false;
  if (!state) return true;

  const s = state.toLowerCase();
  return [` ${s} `, `(${s})`, `${s} lake`, 'south carolina', 'north carolina', 'georgia', 'tennessee',
    'santee', 'scdnr', 'ncwrc', 'gadnr'].some((t) => combined.includes(t));
}

/** The finished array the Worker will store verbatim. */
export function prepareNormalizedDocuments(documents, lakeName, agentTags = [], nowIso = null, altNames = []) {
  const all = Array.isArray(documents) ? documents : [];
  const stamp = nowIso || new Date().toISOString();
  // AGENT TAGS ARE POSITIONAL AGAINST THE ORIGINAL LIST, so the original index has to be
  // carried across the filter. The Worker's version mapped over the FILTERED array with its
  // own index -- drop document 1 and every tag after it shifts down one, so a document
  // discovered by `identity` gets filed as `habitat`. Faithfully ported, then caught by the
  // first test that had ever been able to run this code, which is the whole argument for
  // moving it out of an HTTP handler.
  const kept = all
    .map((doc, i) => ({ doc, i }))
    .filter(({ doc }) => isOnLakeDoc(doc, lakeName, altNames));
  return {
    documents: kept.map(({ doc, i }) => ({
      ...doc,
      agentTags: doc.agentTags || agentTags[i] || [],
      discoveredBy: doc.discoveredBy || (agentTags[i] ? agentTags[i][0] : 'unknown'),
      fetchedAt: doc.fetchedAt || stamp,
    })),
    rejected: all.length - kept.length,
    total: all.length,
  };
}
