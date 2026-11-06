#!/usr/bin/env python3
"""report_pasted.py -- the reports Ryan read himself and pasted into the app, read into the water's statements.

Personal use only, not for distribution or resale; not for navigation.

Item 44 (10/1): the "A report you read" card keeps a paste on his device and syncs it as type `report`
(js/modules/pasted-reports.js), with the date he gave it, who wrote it in his words, the water, on Marion and Moultrie
which lake, and since 11/6 the post's link when he pasted it from "Posts to read". The plan read each one whole. Ryan,
11/6, on the pastes joining the water's reports file so the reader counts them with the rest: "i thought that was
already the plan...". It was.

So the reports step, which already sends his key with the save, reads the pastes the app has synced:
  listed()      every paste, from the Worker's sync list (/sync/list-updates, paged) and each one's row
                (/sync/item/report/<id>), a removed one left out;
  keep()        each one written to the source cache, reports_sources/pasted/<id>.json, so the contract's word-for-word
                check has its text;
  statements()  read like a guide's report (report_column.parts): his date, his water, his "who wrote it".
A paste removed in the app is not listed, so it is not read, even though its cached copy stays (nothing is deleted).

No key (a dry run): no paste is read, and the step says so.
"""
import json, os, re, urllib.parse, urllib.request

import report_column as C
import report_contract as K

SANTEE = ('lake_marion', 'lake_moultrie')
PAGE = 500                                     # the Worker's LIMIT on /sync/list-updates
UA = {'User-Agent': 'TrollMap reports step (personal fishing app)'}


def _get(url, token, timeout=60):
    req = urllib.request.Request(url, headers=dict(UA, **{'X-Sync-Token': token}))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def listed(worker, token, get=None):
    """[record] for every paste the app has synced and not removed. `get(url, token)` -> parsed JSON."""
    get = get or _get
    keys, since = {}, None
    while True:
        q = '?since=%s' % urllib.parse.quote(since) if since else ''
        items = (get('%s/sync/list-updates%s' % (worker, q), token) or {}).get('items') or []
        for it in items:
            k = str(it.get('key') or '')
            if k.startswith('report/'): keys[k] = bool(it.get('deleted'))
        if len(items) < PAGE: break
        nxt = items[-1].get('lastModified')
        if not nxt or nxt == since: break
        since = nxt
    out = []
    for k, deleted in sorted(keys.items()):
        if deleted: continue
        rec = get('%s/sync/item/report/%s' % (worker, urllib.parse.quote(k[len('report/'):], safe='')), token) or {}
        if rec.get('deleted') or rec.get('kind') != 'pasted_report' or not str(rec.get('text') or '').strip(): continue
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(rec.get('date') or '')) or not rec.get('id'): continue
        out.append(rec)
    return out


_ONCE = {}


def listed_once(worker, token, get=None):
    """listed(), asked once a run: every water of a run reads the same pastes."""
    if worker not in _ONCE: _ONCE[worker] = listed(worker, token, get)
    return _ONCE[worker]


def url_of(rec):
    """The post he pasted it from, or the paste itself."""
    link = str(rec.get('link') or '').strip()
    return link if re.match(r'https?://\S+$', link) else 'pasted:%s' % rec['id']


def cache_id(rec):
    return re.sub(r'[^A-Za-z0-9_.-]+', '_', str(rec['id']))


def keep(records, folder):
    """Each paste into the source cache, as the cache keeps a page: `slug` is the paste's id, `water` its water."""
    os.makedirs(folder, exist_ok=True)
    for r in records:
        rec = {'url': url_of(r), 'slug': cache_id(r), 'water': r.get('slug'), 'about_lake': r.get('aboutLake'),
               'date': r.get('date'), 'from': r.get('from') or '', 'link': r.get('link'), 'text': r.get('text')}
        with open(os.path.join(folder, rec['slug'] + '.json'), 'w', encoding='utf-8') as f:
            json.dump(rec, f, ensure_ascii=False, indent=1)
    return [cache_id(r) for r in records]


def waters_of(rec):
    """The water he pasted it for. A Santee Cooper paste is both lakes, or the one he said."""
    w = rec.get('water')
    if w in SANTEE:
        return [rec['about_lake']] if rec.get('about_lake') in SANTEE else list(SANTEE)
    return [w] if w else []


def statements(rec, slug):
    """One paste's statements, if it is about `slug`."""
    ws = waters_of(rec)
    date = str(rec.get('date') or '')
    if slug not in ws or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date): return []
    who = [rec['from']] if str(rec.get('from') or '').strip() else []
    out = []
    for sp, lab, rating, t, about in C.parts(rec.get('text') or ''):
        if K.WRAPPING.search(t): continue
        out.append({'source': 'PASTED', 'url': rec['url'], 'archived': None, 'date': date, 'dated_by': 'his date',
                    'waters': ws, 'water_from': 'he said', 'heading': None, 'species': sp, 'label': lab,
                    'rating': rating, 'about': about, 'text': t, 'who': who or C.who(t),
                    'water_temp_f_said': C.temp_f(t)})
    return out
