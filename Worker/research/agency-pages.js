/**
 * agency-pages.js — the state's own description of a lake, found through the state's own index.
 *
 * Ryan, 2026-08-15: *"then we need to wire those api into research so we get those when i rerun
 * a profile or run one on one that hasn't been done yet"*
 *
 * WHAT WAS ALREADY THERE, SO THAT THIS DOES NOT BUILD IT TWICE. `discover.js` already seeds
 * TWRA and GADNR profile pages from R2-hosted static copies -- 10 Tennessee and 31 Georgia,
 * frozen 2026-07-23. Those work and are not touched here. What they cannot do is cover a lake
 * that is not on the list, and the list is in the code.
 *
 * MEASURED 2026-08-16, which is what decided the scope of this file:
 *
 *   SOUTH CAROLINA   31 agency pages, 0 wired.  128 shipped rows, and it is the home state.
 *   TENNESSEE        10 of 10 shipped lakes on the static list?  No -- 8. CALDERWOOD and DAVY
 *                    CROCKETT have no seed. Calderwood is on region 4's index and was missed;
 *                    Davy Crockett is in region 1, which was never pulled at all.
 *   GEORGIA          31 static pages, verified this session to be byte-identical to the live
 *                    index. Nothing to add, so nothing is added.
 *
 * NO LAKE LIST IN THIS FILE. Each state publishes an index of its own lake pages; that index is
 * the list. A lake the agency adds tomorrow resolves without a commit -- which is the whole
 * difference between this and the table it sits beside.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */

import { matchWaterName, reportTokens } from '../reports.js';

export const AGENCY_INDEXES = {
  SC: {
    authority: 'SCDNR',
    label: 'SCDNR Lake Description',
    index: 'https://www.dnr.sc.gov/lakes/search.html',
    kind: 'scdnr',
  },
  TN: {
    authority: 'TWRA',
    label: 'TWRA Reservoir Profile',
    index: 'https://www.tn.gov/twra/fishing/where-to-fish.html',
    kind: 'twra',
  },
  // GA is deliberately absent. Its 31 StoryMaps are already seeded from R2 by discover.js and
  // were verified current on 2026-08-15. If that snapshot ever goes stale the live route is
  // arcgis.com/sharing/rest/content/items/<id>/data?f=json, which returns the whole story as
  // structured JSON -- not a scrape.
};

const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;?/gi, ' ').replace(/&amp;/gi, '&').replace(/&#\d+;/g, ' ')
  .replace(/\s+/g, ' ').trim();

const abs = (href, base) => (/^https?:\/\//i.test(href) ? href : `${base}${href.startsWith('/') ? '' : '/'}${href}`);

/**
 * tn.gov serves the same page at two paths and only one of them answered when this was written:
 * the /content/tn/ form returned a server error where the bare /twra/ form returned the page.
 * The links on the index are the /content/tn/ form, so they are rewritten rather than trusted.
 */
export function tnUrl(href) {
  return abs(String(href || '').replace('/content/tn/twra/', '/twra/'), 'https://www.tn.gov');
}

/** SCDNR's index: 14 major lakes at /lakes/<slug>/description.html plus 17 state lakes. */
export function parseScdnrIndex(html) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href="([^"]*\/lakes\/(?:state\/)?[A-Za-z0-9_-]+\/(?:description|index)\.html)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const url = abs(m[1], 'https://www.dnr.sc.gov');
    const name = strip(m[2]);
    // Two of the entries -- "Mountain Lake 1" and "Mountain Lake 2" -- share one URL, so the
    // key is name+url and both survive rather than the second silently replacing the first.
    const k = `${name}|${url}`;
    if (!name || seen.has(k)) continue;
    seen.add(k);
    out.push({ name, url });
  }
  return out;
}

/** The four TWRA regions, off the where-to-fish index. */
export function parseTwraRegions(html) {
  const out = new Set();
  const re = /href="([^"]*\/where-to-fish\/[a-z-]+-?r\d)\.html"/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) out.add(tnUrl(`${m[1]}.html`));
  return [...out];
}

/** One region page: the lakes it lists. */
export function parseTwraRegion(html) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href="([^"]*\/where-to-fish\/[a-z-]+-?r\d\/[A-Za-z0-9_-]+\.html)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const url = tnUrl(m[1]);
    const name = strip(m[2]);
    if (!name || seen.has(url)) continue;
    seen.add(url);
    out.push({ name, url });
  }
  return out;
}

/**
 * Pick the agency page for this water. Best token overlap wins, not the first hit -- the same
 * rule the AHQ hub resolver uses, and for the same reason: SCDNR lists both "Lake Marion" and
 * "Lake Moultrie", TWRA lists "Cherokee Reservoir" and "Chilhowee Reservoir", and a resolver
 * that stops at the first plausible link picks by page order.
 *
 * Pure, so the choice is testable without a network.
 */
export function pickAgencyPage(entries, waterNames) {
  let best = null;
  for (const e of entries || []) {
    const matched = matchWaterName(e.name, waterNames);
    if (!matched) continue;
    const cand = reportTokens(e.name); const w = reportTokens(matched);
    let overlap = 0;
    for (const t of cand) if (w.has(t)) overlap += 1;
    if (!best || overlap > best.overlap) best = { ...e, matched, overlap };
  }
  return best;
}

/**
 * Does this page describe the water we asked for? A NAME IS NOT ENOUGH.
 *
 * Ryan, 2026-08-16: *"region 1 lakes are probably not eastern TN are these lakes even
 * shipped?"* He was right, and the reason is sharper than scope. TWRA's region 1 page for
 * "Davy Crockett Lake" describes a lake of approximately 87 acres in CROCKETT County, west
 * Tennessee. The registry's `davy_crockett_lake` is 204.4 acres in GREENE County on the
 * Nolichucky, 400 km east. Two lakes, one name, and the matcher happily bound them.
 *
 * This is the rule `build_water_bindings.py` already states in its own header -- *"name AND
 * geometry, never either alone -- name-only matches are refused"* -- arriving late to the one
 * place that had no geometry to check against. The page's stated county is the discriminator
 * available here, and the registry carries a county on 452 of 454 rows.
 *
 * A page that names a DIFFERENT county is refused. A page that names NO county is allowed:
 * it cannot discriminate, and refusing everything unstated would throw away the SCDNR set,
 * which mostly gives distance-from-a-city rather than a county line.
 */
export function agencyPageAgrees(entry, registryRow, pageText) {
  const county = String((registryRow && registryRow.county) || '').trim();
  const text = String(pageText || '');
  if (!county || !text) return true;
  const stated = [...text.matchAll(/\b([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)?)\s+Count(?:y|ies)\b/g)]
    .map((m) => m[1].trim().toLowerCase());
  if (!stated.length) return true;
  return stated.includes(county.toLowerCase());
}

// One index fetch per state per isolate. The indexes change when an agency adds a lake, which
// is not often, and a research run touches many lakes in a row.
const _idx = new Map();
function cachedIndex(key, ttlMs, fn) {
  const hit = _idx.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return Promise.resolve(hit.v);
  return fn().then((v) => { _idx.set(key, { t: Date.now(), v }); return v; });
}

async function getText(url, ms = 9000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'TrollMap/1.0 (personal fishing app)' }, signal: c.signal });
    return r.ok ? await r.text() : null;
  } catch (_) { return null; } finally { clearTimeout(t); }
}

/** Every lake page a state's index offers. Cached. Returns [] when the index is unreachable. */
export async function agencyIndexEntries(state, fetchText = getText) {
  const cfg = AGENCY_INDEXES[String(state || '').toUpperCase()];
  if (!cfg) return [];
  const DAY = 24 * 60 * 60 * 1000;
  return cachedIndex(`idx:${cfg.kind}`, DAY, async () => {
    const html = await fetchText(cfg.index);
    if (!html) return [];
    if (cfg.kind === 'scdnr') return parseScdnrIndex(html);
    // TWRA's index lists regions, not lakes. All four are read, because region 1 was never
    // pulled into the static set and that is where Davy Crockett Lake is.
    const regions = parseTwraRegions(html);
    const pages = await Promise.all(regions.map((u) => fetchText(u)));
    return pages.filter(Boolean).flatMap((h) => parseTwraRegion(h));
  });
}

/**
 * The agency profile page for one water, or null.
 *
 * `waterNames` is the registry's name, display name and every legacy name -- the same list the
 * reports route takes, and for the same reason: "Ft. Loudoun Reservoir" only reaches
 * "Fort Loudoun Lake" because the alias set is wide.
 */
export async function resolveAgencyPage(state, waterNames, fetchText = getText, registryRow = null) {
  const st = String(state || '').toUpperCase();
  const cfg = AGENCY_INDEXES[st];
  if (!cfg || !waterNames?.length) return null;
  const entries = await agencyIndexEntries(st, fetchText);
  const hit = pickAgencyPage(entries, waterNames);
  if (!hit) return null;
  // The name matched. Now check the page is about this water and not its namesake -- see
  // agencyPageAgrees(). One fetch, and only once a name has already matched.
  if (registryRow && registryRow.county) {
    const page = await fetchText(hit.url);
    if (page && !agencyPageAgrees(hit, registryRow, strip(page))) return null;
  }
  return {
    url: hit.url,
    title: `${hit.name} — ${cfg.label}`,
    authority: cfg.authority,
    agencyName: hit.name,
    matched: hit.matched,
    indexUrl: cfg.index,
  };
}
