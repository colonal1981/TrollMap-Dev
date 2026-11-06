/**
 * pasted-reports.js -- a report Ryan read himself, pasted in, for the plan to read with the guides'.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-10-01, on the list of what would help the plan most: "for 6 i do not have AHQ
 * subscription... we could use this for current facebook or other posts i guess though", then
 * "You can do #5-6". Santee Cooper Country's October post is the case that started it: the Worker
 * can find a search preview of it ("look for fish in 30-45 ...") and not the post, and he can read
 * the post on his phone.
 *
 * So a pasted report is a guide report with three things the Worker's cannot know, all said by him
 * when he pastes it:
 *   - the DATE it was written (required -- a report is weighed by its age, and an undated paste
 *     would be weighed by nothing);
 *   - WHO wrote it, in his words. Where that matches a source the Worker reads ("Santee Cooper
 *     Country", "Joe Dennis") the paste is the newer report by the same guides and supersedes the
 *     older one the usual way (supersede() in utils/report-water.js);
 *   - on Marion and Moultrie, WHICH LAKE it is about, or that the text says / it is both. A depth
 *     of water in it then marks lanes on that lake only, by the same rule as the guides' reports.
 * Nothing is weighted. It goes into the plan verbatim, dated, labelled as his.
 *
 * Kept in IndexedDB's `settings` store under its own key (no schema change, so no version bump to
 * block on an old tab) and synced through /sync as type `report`, so a post pasted on the phone is
 * there for the plan on the PC. *
 * POSTS TO READ (11/6). Facebook forbids automated collection, so the app does not read a post; it
 * lists the ones a search engine knows about (Worker: GET /guide-reports/<slug>/posts) beside this
 * card. Ryan: "is there an automated way to search for it but not collect it? can i manually
 * collect it after the automatic search?" He opens one, reads it, and "Paste this one" fills the
 * date, who wrote it and the post's link; the paste keeps the link, and a post already pasted
 * drops off the list.
 */

import { SANTEE_LAKES } from '../utils/report-water.js';
import { getAll as dbGetAll, put as dbPut, del as dbDel } from '../utils/db.js';
import { workerAuthOnly } from '../utils/worker-auth.js';

export const PASTE_KIND = 'pasted_report';
export const PASTE_SYNC_TYPE = 'report';
const SAID = 'the date Ryan gave it when he pasted it';

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))
  && !Number.isNaN(new Date(`${d}T12:00:00Z`).getTime());
const letters = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

/**
 * A pasted report as it is kept. `{ ok: true, record }`, or `{ ok: false, why }` in words he can
 * act on. `aboutLake` is kept only on Marion and Moultrie, and only as one of the two.
 */
export function pastedRecord({ text, date, from, aboutLake, slug, link, now = new Date() } = {}) {
  const t = String(text || '').trim();
  if (!slug) return { ok: false, why: 'Pick the water above first -- a report is kept for the water it is about.' };
  if (!t) return { ok: false, why: 'Paste the report into the box first.' };
  if (!isDate(date)) return { ok: false, why: 'Give the date it was written -- the plan weighs a report by how old it is.' };
  const santee = SANTEE_LAKES.includes(slug);
  const id = `pasted-report-${now.getTime().toString(36)}`;
  return {
    ok: true,
    record: {
      key: id, id, kind: PASTE_KIND, slug, text: t, date,
      from: String(from || '').trim(),
      aboutLake: santee && SANTEE_LAKES.includes(aboutLake) ? aboutLake : null,
      // the post it came from, when he pasted it from the list of posts to read
      link: /^https?:\/\/\S+$/.test(String(link || '').trim()) ? String(link).trim() : null,
      savedAt: now.toISOString(),
    },
  };
}

/** The pastes for this water. On Marion and Moultrie that is both lakes' -- Santee Cooper is one system. */
export function pastedForWater(records, slug) {
  const santee = SANTEE_LAKES.includes(slug);
  return (records || []).filter((r) => r && r.kind === PASTE_KIND && r.text && isDate(r.date)
    && (r.slug === slug || (santee && SANTEE_LAKES.includes(r.slug))));
}

/**
 * Which of today's sources he named as the writer, by the words he typed: they are in the source's
 * label or its guides' names, letters only ("Santee Cooper Country", "joe dennis", "Capt Joe
 * Dennis"). Null when nothing matches or more than one set of guides does.
 */
export function sameGuidesAs(from, sourceReports) {
  const f = letters(from);
  if (f.length < 3) return null;
  const hits = (sourceReports || []).filter((r) => r && r.guides && !r.pasted
    && (letters(r.label).includes(f) || letters(r.guides).includes(f) || letters(r.author).includes(f)));
  const guides = [...new Set(hits.map((r) => r.guides))];
  return guides.length === 1 ? { guides: guides[0], label: hits[0].label.replace(/ -- .*$/, '') } : null;
}

const lakeName = (slug) => (slug === 'lake_marion' ? 'Lake Marion' : slug === 'lake_moultrie' ? 'Lake Moultrie' : slug);

/**
 * Pastes as reports for guideReportsBlock() and reportWaterForPlan(). One from the plan's month in
 * an earlier year is history and says so, the way Angler's Headquarters' old Octobers do; every
 * other one is printed with its date for the model to weigh. Nothing is left out for its age.
 */
export function pastedAsReports(records, planDate, sourceReports = []) {
  const pm = String(planDate || '').slice(5, 7);
  const py = String(planDate || '').slice(0, 4);
  return (records || []).map((r) => {
    const same = sameGuidesAs(r.from, sourceReports);
    const history = pm && r.date.slice(5, 7) === pm && r.date.slice(0, 4) < py;
    const notes = [];
    if (same) notes.push(`He said ${same.label} wrote it, so it is by the same guides as that source.`);
    if (r.aboutLake) notes.push(`He said it is about ${lakeName(r.aboutLake)}; a sentence that names the other lake is still that lake's.`);
    return {
      kind: 'pasted',
      pasted: true,
      pasteId: r.id,
      label: `Pasted by Ryan${r.from ? `: ${r.from}` : ''}`,
      guides: same ? same.guides : null,
      published: r.date,
      publishedFrom: SAID,
      ...(history ? { role: 'same month, an earlier year' } : {}),
      aboutLake: r.aboutLake || null,
      url: r.link || null,
      note: notes.join(' ') || null,
      text: r.text,
    };
  });
}

/** One post, one key, whichever way Facebook spelled its address (www., m., tracking). */
export function postKey(u) {
  const t = String(u || '').replace(/#.*$/, '').toLowerCase().replace(/^https?:\/\/(?:www\.|m\.|web\.)?/, 'https://');
  return (/\.php\?|\/watch\/?\?/.test(t) ? t : t.replace(/\?.*$/, '')).replace(/\/+$/, '');
}

/** The posts still to read: the list less every one already pasted (by its link). */
export function postsToRead(posts, pasted) {
  const done = new Set((pasted || []).map((r) => r && r.link).filter(Boolean).map(postKey));
  return (posts || []).filter((p) => p && p.url && !done.has(postKey(p.url)));
}

/**
 * Ask the Worker for the water's posts to read. Never throws: `{ error }` in words he can act on.
 * `fresh` is "Look again": the day's list is kept, and a fresh look is his, so it carries the token.
 */
export async function askPosts({ worker, slug, date, fresh = false, fetchImpl } = {}) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!worker || !slug) return { error: 'Pick the water above first.' };
  if (!f) return { error: 'no fetch' };
  try {
    const q = new URLSearchParams({ ...(date ? { date } : {}), ...(fresh ? { fresh: '1' } : {}) }).toString();
    const r = await f(`${worker}/guide-reports/${encodeURIComponent(slug)}/posts${q ? `?${q}` : ''}`,
      fresh ? { headers: workerAuthOnly() } : undefined);
    if (!r || !r.ok) return { error: `the search could not be asked (HTTP ${r ? r.status : '?'})` };
    return await r.json();
  } catch (e) {
    return { error: `the search could not be asked (${(e && e.message) || e})` };
  }
}

// ── the browser half ─────────────────────────────────────────────────────────────────────────
// Nothing here runs at import, so the pure half above runs under node:test with no IndexedDB.
// cloud-sync.js is loaded when a paste is saved: it touches the page as it loads.

/** Every paste on this device. Never throws: no IndexedDB, or a failed read, is no pastes. */
export async function loadPasted() {
  if (typeof indexedDB === 'undefined') return [];
  try {
    const all = await dbGetAll('settings');
    return (all || []).filter((r) => r && r.kind === PASTE_KIND);
  } catch (_) {
    return [];
  }
}

async function savePasted(record) {
  await dbPut('settings', record);
  try { (await import('./cloud-sync.js')).pushItemOnSave(PASTE_SYNC_TYPE, record.id, record); } catch (_) { /* kept on this device */ }
}

async function deletePasted(id) {
  await dbDel('settings', id);
  try { (await import('./cloud-sync.js')).deleteItemOnDelete(PASTE_SYNC_TYPE, id); } catch (_) { /* gone from this device */ }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * The "A report you read" card on the Smart Plan tab. `slugOf()` answers the water picked above,
 * the same lookup the planner uses.
 */
export function wirePasteBox({ slugOf, dateOf, worker } = {}) {
  const $ = (id) => document.getElementById(id);
  const box = $('pastedReportsCard');
  if (!box || box.dataset.wired) return;
  box.dataset.wired = '1';
  const say = (m, bad) => {
    const el = $('pastedReportStatus');
    if (el) { el.textContent = m; el.style.color = bad ? 'var(--warn)' : 'var(--muted)'; }
  };

  // ── posts to read ──
  let finds = { slug: null, posts: [], error: null, looking: false };
  const renderFinds = (mine) => {
    const el = $('pastedReportFinds');
    if (!el) return;
    if (finds.looking) { el.innerHTML = '<div class="muted" style="font-size:12px">Looking…</div>'; return; }
    if (finds.error) { el.innerHTML = `<div style="font-size:12px;color:var(--warn)">${esc(finds.error)}</div>`; return; }
    const left = postsToRead(finds.posts, mine);
    const done = (finds.posts || []).length - left.length;
    el.innerHTML = left.map((p, i) => `
      <div style="border-top:1px solid var(--border,#1e2a3a);padding:6px 0;font-size:12px">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
          <b>${p.when ? `${esc(p.when)}${p.whenApprox ? ' (about)' : ''}` : 'no date in the search'} · ${esc(p.page)}</b>
          <span style="display:flex;gap:6px;flex-shrink:0">
            <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" style="font-size:11px">Open</a>
            <button type="button" class="small ghost" data-use="${i}" style="font-size:11px">Paste this one</button>
          </span>
        </div>
        <div>${esc(p.title)}</div>
        ${p.preview ? `<div class="muted" style="font-size:11px">The search's preview, not the post: ${esc(p.preview)}</div>` : ''}
      </div>`).join('')
      || `<div class="muted" style="font-size:12px">${finds.slug ? `No posts found${done ? ` that are not pasted already (${done} pasted)` : ''}.` : 'Open this card with a water picked to look for posts.'}</div>`;
    el.dataset.left = JSON.stringify(left.map((p) => ({ url: p.url, when: p.when, whenApprox: p.whenApprox, page: p.page, source: p.source })));
  };
  const find = async (fresh = false) => {
    const slug = slugOf ? slugOf() : null;
    if (!slug || !worker) return;
    if (!fresh && finds.slug === slug && !finds.error) return;
    finds = { slug, posts: [], error: null, looking: true };
    renderFinds([]);
    const got = await askPosts({ worker, slug, date: dateOf ? dateOf() : null, fresh });
    if ((slugOf ? slugOf() : null) !== slug) return;            // the water changed while it looked
    finds = { slug, posts: got.posts || [], error: got.error || null, looking: false };
    render();
  };
  $('pastedReportFinds')?.addEventListener('click', (ev) => {
    const i = ev.target && ev.target.dataset ? ev.target.dataset.use : null;
    if (i == null) return;
    let left = [];
    try { left = JSON.parse($('pastedReportFinds').dataset.left || '[]'); } catch (_) { left = []; }
    const p = left[Number(i)];
    if (!p) return;
    if ($('pastedReportLink')) $('pastedReportLink').value = p.url;
    if ($('pastedReportFrom')) $('pastedReportFrom').value = p.source ? p.page : (p.page === 'a Facebook group' ? '' : p.page);
    if ($('pastedReportDate') && p.when && !p.whenApprox) $('pastedReportDate').value = p.when;
    $('pastedReportText')?.focus();
    say(`Open the post, copy what it says, and paste it here.${p.when && !p.whenApprox ? ' Check the date against the post.' : ' Set the date the post shows.'}`);
  });
  $('pastedReportFindAgain')?.addEventListener('click', () => find(true));

  const render = async () => {
    const slug = slugOf ? slugOf() : null;
    const lakeWrap = $('pastedReportLakeWrap');
    if (lakeWrap) lakeWrap.style.display = SANTEE_LAKES.includes(slug) ? '' : 'none';
    const list = $('pastedReportList');
    const count = $('pastedReportsCount');
    const mine = slug ? pastedForWater(await loadPasted(), slug).sort((a, b) => (a.date < b.date ? 1 : -1)) : [];
    if (count) count.textContent = mine.length ? `(${mine.length} for this water)` : '';
    renderFinds(mine);
    if (!list) return;
    list.innerHTML = mine.map((r) => `
      <div style="border-top:1px solid var(--border,#1e2a3a);padding:6px 0;font-size:12px">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
          <b>${esc(r.date)}${r.from ? ` · ${esc(r.from)}` : ''}${r.aboutLake ? ` · ${esc(lakeName(r.aboutLake))}` : ''}${r.link ? ` · <a href="${esc(r.link)}" target="_blank" rel="noopener noreferrer">the post</a>` : ''}</b>
          <button type="button" class="small ghost" data-del="${esc(r.id)}" style="font-size:11px">Remove</button>
        </div>
        <div class="muted" style="white-space:pre-wrap;max-height:4.5em;overflow:hidden">${esc(r.text)}</div>
      </div>`).join('') || '<div class="muted" style="font-size:12px">None pasted for this water.</div>';
  };

  $('pastedReportSave')?.addEventListener('click', async () => {
    const res = pastedRecord({
      text: $('pastedReportText')?.value, date: $('pastedReportDate')?.value,
      from: $('pastedReportFrom')?.value, aboutLake: $('pastedReportLake')?.value || null,
      slug: slugOf ? slugOf() : null, link: $('pastedReportLink')?.value || null,
    });
    if (!res.ok) return say(res.why, true);
    try {
      await savePasted(res.record);
    } catch (e) {
      return say(`Could not keep it on this device: ${(e && e.message) || e}`, true);
    }
    $('pastedReportText').value = '';
    if ($('pastedReportLink')) $('pastedReportLink').value = '';
    say('Added. The next plan for this water reads it.');
    render();
  });
  $('pastedReportList')?.addEventListener('click', async (ev) => {
    const id = ev.target && ev.target.dataset ? ev.target.dataset.del : null;
    if (!id) return;
    try { await deletePasted(id); say('Removed.'); } catch (e) { say(`Could not remove it: ${(e && e.message) || e}`, true); }
    render();
  });
  const dateEl = $('pastedReportDate');
  if (dateEl && !dateEl.value && dateOf) dateEl.value = dateOf() || '';
  $('planLake')?.addEventListener('change', () => { render(); if (box.open) find(); });
  window.addEventListener('trollmap:data-synced', render);
  box.addEventListener('toggle', () => { if (box.open) { render(); find(); } });
  render();
}
