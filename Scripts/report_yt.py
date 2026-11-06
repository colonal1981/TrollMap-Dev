#!/usr/bin/env python3
"""report_yt.py -- the Lake Murray monthly video reports (Capt. Chris Blanchette's channel, with Capt. Chip Bragg on
stripers), read from their automatic captions.

Personal use only, not for distribution or resale; not for navigation.

Ryan picked them on 11/6. The 12 transcripts were collected on 11/5 (Firecrawl's YouTube provider) and are kept in the
source cache, reports_sources/yt/<video id>.json. Nothing is fetched here.

HOW IT READS: the captions run as one talk, so a statement is a run of up to three sentences, verbatim, in which the
talk says something a plan can use: a depth, a lure, where the fish sit, a kind of water or a named place. The fish is
the last one the talk named ("the stripers", "largemouth"). This is a rule pass, not a model's reading: it keeps the
guides' words and misses what they say without those words. A Claude pass over the same captions (on his API credit,
his yes of 11/6) can be added later; every quote it returned would be checked word for word against the captions.
"""
import re

import report_column as C
import report_contract as K
import report_text as T

WATER = 'lake_murray'
# The titles without a year, dated by the list made when they were collected (THE_WHERE_AND_WHEN_MAP, 11/5: "September
# 2024 to June 2026: Sept 2024, Oct 2024, Early Winter 2024, Jan, Feb, April, May, June, Oct and Dec 2025, late
# Jan/early Feb 2026, June 2026").
KNOWN = {'htowjsHjpHw': '2024-10', 'np_d0GzYRDY': '2024-12', 'xTa4y2lTDJs': '2025-01', 'vYBxOMtmMbE': '2025-02',
         'ex492ChzQwk': '2025-04', 'NTGCpYlNlRs': '2025-05', '7wD6SGxcWmY': '2026-01'}
MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november',
          'december']
FISH = [('striped bass', r'\bstripers?\b|striped bass|\bstripes\b'), ('largemouth bass', r'largemouth|\bbass\b'),
        ('spotted bass', r'spotted bass|\bspots\b'), ('crappie', r'crappie'), ('catfish', r'catfish|\bcats\b'),
        ('white perch', r'white perch')]
FISH_RX = [(k, re.compile(v, re.I)) for k, v in FISH]
GUIDE = {'striped bass': ['Chip Bragg'], 'largemouth bass': ['Chris Blanchette'], 'spotted bass': ['Chris Blanchette']}


def month_of(rec):
    if rec.get('video_id') in KNOWN: return KNOWN[rec['video_id']]
    t = (rec.get('title') or '').lower()
    y = re.search(r'\b(20\d\d)\b', t)
    m = next((i for i, n in enumerate(MONTHS, 1) if n in t), None)
    if y and m: return '%s-%02d' % (y.group(1), m)
    if rec.get('published'): return rec['published'][:7]
    return None


def useful(x, species):
    return bool(T.depths(x) or T.lures(x, species) or any(re.search(rx, x, re.I) for _, rx in T.POS)
                or T.kinds_of_water(x))


def statements(rec, slug):
    if slug != WATER: return []
    date = month_of(rec)
    if not date: return []
    text = rec.get('text') or ''
    sents = [s for s in T.SENT.split(text) if s.strip()]
    if sents and len(text) / len(sents) > 400:
        # captions with no punctuation come back as one long run: cut it into runs of 35 words, as they stand
        words = list(re.finditer(r'\S+', text))
        sents = [text[words[k].start():(words[k + 35].start() if k + 35 < len(words) else len(text))]
                 for k in range(0, len(words), 35)]
    out, fish, i = [], None, 0
    while i < len(sents):
        named = [k for k, rx in FISH_RX if rx.search(sents[i])]
        if named: fish = named[:1]
        if fish and useful(sents[i], fish):
            run = sents[i:i + 3]
            # stop the run where the talk turns to another fish
            for j in range(1, len(run)):
                if any(rx.search(run[j]) for k, rx in FISH_RX if k not in fish):
                    run = run[:j]; break
            t = ''.join(run).strip()
            if len(t) > 60 and not K.WRAPPING.search(t):           # "make sure you subscribe" is the channel, not the lake
                out.append({'source': 'YT-BigFishBlanch', 'url': rec['url'], 'archived': None, 'date': date,
                            'dated_by': 'video date', 'waters': [WATER], 'water_from': 'source page',
                            'heading': rec.get('title'), 'species': list(fish), 'label': None, 'rating': None,
                            'about': 'named' if named else 'continued', 'text': t,
                            'who': C.who(t) or GUIDE.get(fish[0], []), 'water_temp_f_said': C.temp_f(t),
                            'context': "read from the video's automatic captions; the words are the captions' (mine)"})
            i += len(run); continue
        i += 1
    return out
