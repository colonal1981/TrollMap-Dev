#!/usr/bin/env python3
"""claude_fish_sorter.py - sort and measure catch photos with Claude, for Catch Center's CSV import.

Personal use only, not for distribution or resale; not for navigation.

    py Scripts\\claude_fish_sorter.py --folders "F:\\...\\Photos from 2024" --out F:\\TrollMapPipeline\\catch_sort --only-day 2024-12-07
    py Scripts\\claude_fish_sorter.py --folders "F:\\...\\Photos from 2023" "F:\\...\\Photos from 2024" --out F:\\TrollMapPipeline\\catch_sort --history catches_approved.csv

WHY

Ryan, 2026-10-03, on two Dec 7, 2024 fish that were never in the app: *"lets refresh the old fish
sorter... lets make it much better than it is now and lets use claude to sort them and get them
measured... I would like all of those on my catch history"*. The 2023 and 2024 sort files
(`csv\\fish_sort_results_v2_*_recovered.csv`) were never imported, and the old sorter
(`scripts_old\\_review_2026-08-04\\fish_sorter_v5_3tier.py`) ran a local model, then Grok, then
Gemini, each on one photo at a time.

HOW

Claude runs on this PC through the `claude` CLI and his Max subscription -- the same way
claude_plan_bridge.py does -- with the photos sent as image blocks on stdin (`--input-format
stream-json`). No API key, no credits.

1. **Every photo's time and place** come from its Google Takeout sidecar (`photoTakenTime`,
   `geoData`), matched by the sidecar's own `title`, with the photo's EXIF as the fallback. Times are
   written in Eastern time, which is what the app's journal holds. Exact duplicate files (same
   sha256) are read once.
2. **Pass 1 sorts a day at a time.** The day's photos go to the sort model together, small and in
   the order taken, with their times. It says which photos show a fish, which are on the bump board,
   and which photos are the SAME fish -- one entry per fish caught, however many photos he took of
   it. That is a judgement about the fish, not a time window: a lure shot and a board shot two
   minutes apart are one fish, and two fish a minute apart are two. A day with more photos than one
   request carries is cut at its longest gaps.
3. **Pass 2 measures each fish that has a board photo,** with the measure model: the board photo at
   full size and up to two more photos of the same fish. Species from the app's own list, and the
   length read off the board's printed numbers -- or no length where they cannot be read.
4. **Nothing already in the catch history comes in again** (`--history`, a Catch Center CSV): a fish
   is dropped if any of its photos is a history row's file or hash, or a history catch on that date
   falls inside the minutes its photos span.
5. **One CSV in Catch Center's format** (the columns of `catches_approved.csv`, plus the `length_inches`
   its import reads the length from), every row left for
   review: import it, select the photo folder for the year, check each fish, approve.

Every answer is cached under `--out`, so a run that stops -- a usage limit, a closed laptop --
picks up where it left off. A usage-limit answer stops the run cleanly, writes what it has, and
says so.
"""
import argparse, base64, csv, datetime as dt, hashlib, json, os, re, subprocess, sys, tempfile, time
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from claude_species import claude_exe, _LIMIT_WORDS  # noqa: E402  (the CLI finder and usage-limit words the species step uses)

try:
    from PIL import Image, ExifTags, ImageOps
except Exception:                                        # pragma: no cover
    sys.exit('claude_fish_sorter.py needs Pillow (py -m pip install pillow)')

EASTERN = ZoneInfo('America/New_York')
PHOTO_EXT = ('.jpg', '.jpeg', '.png', '.webp')
# The app's own species list (js/modules/catch-journal.js SPECIES, less the blank and 'Not Fish'),
# so an answer is a value the review form can show. test_claude_fish_sorter.py keeps them in step.
SPECIES = ['Striped Bass', 'White Bass / Hybrid', 'Largemouth Bass', 'Spotted Bass', 'Smallmouth Bass',
           'Crappie', 'Black Crappie', 'White Crappie', 'Catfish', 'Blue Catfish', 'Channel Catfish',
           'Flathead Catfish', 'Bowfin', 'Chain Pickerel', 'Bluegill', 'Sunfish (Panfish)',
           'Redear Sunfish (Shellcracker)', 'Yellow Perch', 'Gar', 'Longnose Gar', 'Red Drum (Redfish)',
           'Speckled Trout (Spotted Seatrout)', 'Flounder', 'American Shad', 'Other Fish']
CSV_COLUMNS = ['review_status', 'review_flags', 'filename', 'datetime', 'date', 'time', 'lat', 'lon',
               'lake', 'depth', 'has_fish', 'on_bump_board', 'species', 'verified_length_inches',
               'ai_length_inches', 'length_verified', 'confidence', 'source_model', 'notes', 'tempF',
               'windMph', 'windDir', 'cloudPct', 'pressureHpa', 'moonPhase', 'sha256', 'source_path',
               'imported_from', 'length_inches']
# `length_inches` is not one of catches_approved.csv's columns, and it has to be there: Catch Center's
# import (catch-journal.js normalizeCsvRow) reads the length from length_inches and never reads
# ai_length_inches, so a length only in ai_length_inches comes in blank. Both carry the same number.
# How many photos one sort request carries, each at SORT_PX on its long side -- enough to see a
# fish, a board and a lure, at about 600 image tokens apiece.
SORT_BATCH = 30
SORT_PX = 768
MEASURE_PX = 1568          # the size Claude reads an image at; anything larger is scaled down to it


class UsageLimit(Exception):
    pass


# ── the photos ─────────────────────────────────────────────────────────────────────────────────

def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


SIDECAR_CUT = re.compile(r'(?:\.s(?:u(?:p(?:p(?:l(?:e(?:m(?:e(?:n(?:t(?:a(?:l)?)?)?)?)?)?)?)?)?)?)?'
                         r'(?:[-.].*)?)?\.json$', re.I)


def read_sidecars(folder):
    """{photo filename: sidecar dict}, keyed both by the photo name the sidecar's filename starts
    with and by the sidecar's own `title`. Google truncates sidecar NAMES (".supplemental-met.json",
    ".s.json"), never the title."""
    out = {}
    for name in os.listdir(folder):
        if not name.lower().endswith('.json') or name.lower() == 'metadata.json':
            continue
        try:
            with open(os.path.join(folder, name), 'r', encoding='utf-8') as fh:
                js = json.load(fh)
        except Exception:
            continue
        if not isinstance(js, dict) or 'photoTakenTime' not in js:
            continue
        stem = SIDECAR_CUT.sub('', name)
        out.setdefault(stem, js)
        if js.get('title'):
            out.setdefault(js['title'], js)
    return out


def exif_time_place(path):
    """(local time, lat, lon) off the photo itself, each None where it is not there."""
    try:
        ex = Image.open(path).getexif()
        sub = ex.get_ifd(0x8769)
        when = sub.get(36867) or ex.get(306)
        t = dt.datetime.strptime(str(when), '%Y:%m:%d %H:%M:%S').replace(tzinfo=EASTERN) if when else None
        gps = ex.get_ifd(0x8825)

        def deg(v, ref):
            d = float(v[0]) + float(v[1]) / 60 + float(v[2]) / 3600
            return -d if str(ref).upper() in ('S', 'W') else d
        lat = deg(gps[2], gps[1]) if 2 in gps and 1 in gps else None
        lon = deg(gps[4], gps[3]) if 4 in gps and 3 in gps else None
        return t, lat, lon
    except Exception:
        return None, None, None


def photo_row(folder, name, side):
    path = os.path.join(folder, name)
    js = side.get(name) or side.get(re.sub(r'(~\d+|-edited)(?=\.[^.]+$)', '', name))
    when = lat = lon = None
    if js:
        ts = int((js.get('photoTakenTime') or {}).get('timestamp') or 0)
        when = dt.datetime.fromtimestamp(ts, EASTERN) if ts else None
        for key in ('geoDataExif', 'geoData'):
            g = js.get(key) or {}
            if g.get('latitude') or g.get('longitude'):
                lat, lon = float(g['latitude']), float(g['longitude'])
                break
    if when is None or lat is None:
        t2, la2, lo2 = exif_time_place(path)
        when = when or t2
        if lat is None and la2 is not None:
            lat, lon = la2, lo2
    return {'name': name, 'path': path, 'when': when, 'lat': lat, 'lon': lon}


def list_photos(folders, only_day=None):
    """Every photo with its local time, position and hash, oldest first. A file whose hash was
    already seen is the same photo twice and is read once."""
    rows, seen = [], set()
    for folder in folders:
        side = read_sidecars(folder)
        for name in sorted(os.listdir(folder)):
            if not name.lower().endswith(PHOTO_EXT):
                continue
            r = photo_row(folder, name, side)
            if r['when'] is None:
                continue
            if only_day and r['when'].strftime('%Y-%m-%d') != only_day:
                continue
            r['sha256'] = sha256_of(r['path'])
            if r['sha256'] in seen:
                continue
            seen.add(r['sha256'])
            rows.append(r)
    rows.sort(key=lambda r: r['when'])
    return rows


def jpeg_b64(path, px, cache_dir):
    os.makedirs(cache_dir, exist_ok=True)
    out = os.path.join(cache_dir, '%s_%d.jpg' % (os.path.basename(path), px))
    if not os.path.isfile(out):
        im = ImageOps.exif_transpose(Image.open(path))
        im.thumbnail((px, px))
        im.convert('RGB').save(out, 'JPEG', quality=88)
    with open(out, 'rb') as fh:
        return base64.b64encode(fh.read()).decode()


def image_block(path, px, cache_dir):
    return {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/jpeg',
                                        'data': jpeg_b64(path, px, cache_dir)}}


# ── Claude ───────────────────────────────────────────────────────────────────────────────────

def ask(blocks, model, timeout=900):
    """One `claude -p` with image and text blocks on stdin. (text, model id, seconds, usd)."""
    exe = claude_exe()
    if not exe:
        sys.exit('claude CLI not found on this PC -- set TROLLMAP_CLAUDE_EXE, or install Claude Code')
    msg = {'type': 'user', 'message': {'role': 'user', 'content': blocks}}
    t0 = time.perf_counter()
    with tempfile.TemporaryDirectory() as cwd:          # no CLAUDE.md, no project settings
        p = subprocess.run([exe, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
                            '--verbose', '--model', model, '--tools', '', '--no-session-persistence',
                            '--strict-mcp-config'],
                           input=json.dumps(msg) + '\n', capture_output=True, text=True,
                           encoding='utf-8', cwd=cwd, timeout=timeout)
    res = None
    for line in (p.stdout or '').splitlines():
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get('type') == 'result':
            res = o
    if not res or res.get('is_error') or res.get('subtype') != 'success':
        why = str((res or {}).get('result') or p.stderr or p.stdout or 'no answer')[:400]
        if _LIMIT_WORDS.search(why):
            raise UsageLimit(why)
        raise RuntimeError('claude: ' + why)
    mid = next(iter((res.get('modelUsage') or {}).keys()), model)
    return str(res.get('result') or ''), mid, round(time.perf_counter() - t0, 1), res.get('total_cost_usd')


def json_of(text):
    a, b = text.find('{'), text.rfind('}')
    if a < 0 or b <= a:
        raise ValueError('no JSON object in the answer: ' + ' '.join(text.split())[:300])
    return json.loads(text[a:b + 1])


SORT_ASK = """These are {n} photos from Ryan's phone, taken on {day}, in the order taken. Each one is
labelled just before it with its number and the time it was taken.

He fishes from a kayak and photographs what he catches: often the fish with the lure still in its
mouth, then the fish lying on a yellow bump board (a measuring board with printed inch numbers),
sometimes the fish held in his hand. The other photos are anything else -- the water, the kayak,
gear, people, screens, scenery.

Return ONE JSON object and nothing else:
{{"photos": [{{"i": 1, "fish": true, "board": false, "held": true, "lure_shot": false, "what": "up to 12 words"}}],
  "fish": [{{"photos": [1, 2], "board_photo": 2, "best_photo": 2, "species_guess": "...", "why_same_fish": "up to 15 words"}}]}}

- "photos": every photo, by its number.
- "fish": ONE entry for each fish caught. Photos of the same fish -- several angles, a burst, the
  lure shot and then the board shot -- go in one entry. A second fish is its own entry even if it
  looks alike and was minutes apart: tell them apart by size, markings, the lure, the setting and
  the time. A photo with no fish is in no entry.
- "board_photo": the clearest photo of that fish on the bump board, mouth at the bump; null if none.
- "species_guess": one of {species}, or "Unknown".
"""

MEASURE_ASK = """Photo A is the board shot of one fish Ryan caught on {day} at {time}{where}. The
other photos, if any, are the same fish from other angles.

Read two things:
- "species": one of {species}.
- "length_in": the length on the bump board -- mouth against the bump, read where the tip of the
  tail reaches on the board's printed inch numbers -- to the nearest 0.25 inch. null if the numbers
  at the tail cannot be read, the mouth is off the bump, or the tail is off the board.

Return ONE JSON object and nothing else:
{{"species": "...", "length_in": 22.25, "confidence": "high|medium|low",
  "how_read": "which printed numbers you read the tail against, up to 25 words",
  "problems": ["anything that makes the length or the species doubtful"]}}
"""


def chunks_of(photos, batch=SORT_BATCH):
    """The day cut at its longest gaps until every piece fits one request."""
    parts = [photos]
    while any(len(c) > batch for c in parts):
        nxt = []
        for c in parts:
            if len(c) <= batch:
                nxt.append(c)
                continue
            gaps = [(c[i + 1]['when'] - c[i]['when']).total_seconds() for i in range(len(c) - 1)]
            k = max(range(len(gaps)), key=lambda i: gaps[i]) + 1
            nxt += [c[:k], c[k:]]
        parts = nxt
    return parts


def fish_from(ans, chunk):
    """Pass 1's answer for one chunk, as fish carrying their own photo rows."""
    n = len(chunk)
    ok = lambda i: isinstance(i, int) and 1 <= i <= n
    what = {p.get('i'): p.get('what', '') for p in ans.get('photos') or []}
    out = []
    for f in ans.get('fish') or []:
        idx = [i for i in f.get('photos') or [] if ok(i)]
        if not idx:
            continue
        bp, best = f.get('board_photo'), f.get('best_photo')
        if ok(bp) and bp not in idx:
            idx.append(bp)
        out.append({'photos': [chunk[i - 1] for i in sorted(set(idx))],
                    'board': chunk[bp - 1] if ok(bp) else None,
                    'best': chunk[best - 1] if ok(best) else chunk[idx[0] - 1],
                    'species_guess': f.get('species_guess') or 'Unknown',
                    'why': f.get('why_same_fish') or '',
                    'what': [what.get(i, '') for i in idx],
                    'sort_model': ans.get('_model')})
    return out


def sort_day(day, photos, model, out, log):
    """Pass 1 for one day. Cached per chunk under out/pass1."""
    fish = []
    for ci, chunk in enumerate(chunks_of(photos)):
        cache = os.path.join(out, 'pass1', '%s_%d.json' % (day, ci))
        ans = None
        if os.path.isfile(cache):
            with open(cache, 'r', encoding='utf-8') as fh:
                ans = json.load(fh)
            if ans.get('_files') != [p['name'] for p in chunk]:
                ans = None                               # the day's photos changed; ask again
        if ans is None:
            blocks = [{'type': 'text', 'text': SORT_ASK.format(n=len(chunk), day=day, species=json.dumps(SPECIES))}]
            for i, ph in enumerate(chunk, 1):
                blocks.append({'type': 'text', 'text': 'Photo %d -- %s' % (i, ph['when'].strftime('%H:%M:%S'))})
                blocks.append(image_block(ph['path'], SORT_PX, os.path.join(out, 'thumbs')))
            text, mid, secs, usd = ask(blocks, model)
            ans = json_of(text)
            ans.update({'_model': mid, '_seconds': secs, '_usd': usd, '_files': [p['name'] for p in chunk]})
            os.makedirs(os.path.dirname(cache), exist_ok=True)
            with open(cache, 'w', encoding='utf-8') as fh:
                json.dump(ans, fh, indent=1)
            log('  sorted %s part %d: %d photos -> %d fish, %.0fs' % (day, ci + 1, len(chunk), len(ans.get('fish') or []), secs))
        fish += fish_from(ans, chunk)
    return fish


def measure(fish, model, out, log):
    """Pass 2 for one fish with a board photo. Cached per board photo under out/pass2."""
    b = fish['board']
    cache = os.path.join(out, 'pass2', b['name'] + '.json')
    if os.path.isfile(cache):
        with open(cache, 'r', encoding='utf-8') as fh:
            return json.load(fh)
    where = (' near %.5f, %.5f' % (b['lat'], b['lon'])) if b['lat'] is not None else ''
    blocks = [{'type': 'text', 'text': MEASURE_ASK.format(day=b['when'].strftime('%Y-%m-%d'),
                                                         time=b['when'].strftime('%H:%M'),
                                                         where=where, species=json.dumps(SPECIES))},
              {'type': 'text', 'text': 'Photo A (the board shot)'},
              image_block(b['path'], MEASURE_PX, os.path.join(out, 'boards'))]
    for k, p in enumerate([p for p in fish['photos'] if p is not b][:2]):
        blocks.append({'type': 'text', 'text': 'Photo %s (same fish)' % 'BC'[k]})
        blocks.append(image_block(p['path'], SORT_PX, os.path.join(out, 'thumbs')))
    text, mid, secs, usd = ask(blocks, model)
    ans = json_of(text)
    ans.update({'_model': mid, '_seconds': secs, '_usd': usd})
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    with open(cache, 'w', encoding='utf-8') as fh:
        json.dump(ans, fh, indent=1)
    log('  measured %s: %s, %s in (%s), %.0fs' % (b['name'], ans.get('species'), ans.get('length_in'), ans.get('confidence'), secs))
    return ans


# ── the catch history ────────────────────────────────────────────────────────────────────────

def read_history(path):
    files, hashes, times = set(), set(), {}
    if not path or not os.path.isfile(path):
        return files, hashes, times
    with open(path, 'r', encoding='utf-8-sig', newline='') as fh:
        for r in csv.DictReader(fh):
            if (r.get('filename') or '').strip():
                files.add(r['filename'].strip().lower())
            if (r.get('sha256') or '').strip():
                hashes.add(r['sha256'].strip().lower())
            d, t = (r.get('date') or '').strip(), (r.get('time') or '').strip()
            if d and t:
                times.setdefault(d, []).append(t[:8])
    return files, hashes, times


def already_held(fish, history):
    files, hashes, times = history
    if any(p['name'].lower() in files or p['sha256'] in hashes for p in fish['photos']):
        return True
    day = fish['photos'][0]['when'].strftime('%Y-%m-%d')
    t0 = min(p['when'] for p in fish['photos']).strftime('%H:%M:%S')
    t1 = max(p['when'] for p in fish['photos']).strftime('%H:%M:%S')
    return any(t0 <= t <= t1 for t in times.get(day, ()))


# ── the CSV ──────────────────────────────────────────────────────────────────────────────────

def row_for(fish, m, run_tag):
    b = fish['board'] or fish['best']
    m = m or {}
    flags = ['claude_sorter']
    species = m.get('species') or fish['species_guess']
    if species not in SPECIES:
        flags.append('species_needs_review')
    length = m.get('length_in')
    if fish['board']:
        flags.append('verify_board_length_from_photo')
        if length in (None, ''):
            flags.append('board_missing_length')
    else:
        flags.append('handheld_no_board')
    conf = m.get('confidence') or ('medium' if fish['board'] else 'low')
    if str(conf).lower() == 'low':
        flags.append('low_confidence')
    notes = []
    if m:
        notes.append('Claude (%s): %s' % (m.get('_model'), m.get('how_read') or ''))
        if m.get('problems'):
            notes.append('Doubts: ' + '; '.join(str(x) for x in m['problems']))
    notes.append('Sorted by %s: %s' % (fish.get('sort_model'), fish.get('why') or ''))
    others = [p['name'] for p in fish['photos'] if p is not b]
    if others:
        notes.append('Same fish: ' + ', '.join(others))
    model = m.get('_model') or fish.get('sort_model') or ''
    return {
        'review_status': '', 'review_flags': '|'.join(flags), 'filename': b['name'],
        'datetime': b['when'].strftime('%Y-%m-%dT%H:%M:%S'), 'date': b['when'].strftime('%Y-%m-%d'),
        'time': b['when'].strftime('%H:%M:%S'),
        'lat': '' if b['lat'] is None else round(b['lat'], 7), 'lon': '' if b['lon'] is None else round(b['lon'], 7),
        'lake': '', 'depth': '', 'has_fish': 'true', 'on_bump_board': 'true' if fish['board'] else 'false',
        'species': species or 'Unknown',
        'verified_length_inches': '', 'ai_length_inches': '' if length in (None, '') else length,
        'length_verified': 'false', 'confidence': conf, 'source_model': '%s (claude_fish_sorter)' % model,
        'notes': ' | '.join(n for n in notes if n), 'tempF': '', 'windMph': '', 'windDir': '', 'cloudPct': '',
        'pressureHpa': '', 'moonPhase': '', 'sha256': b['sha256'], 'source_path': b['path'],
        'imported_from': run_tag, 'length_inches': '' if length in (None, '') else length,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--folders', nargs='+', required=True, help='Google Takeout "Photos from YYYY" folders')
    ap.add_argument('--out', required=True, help='cache and output folder')
    ap.add_argument('--history', default=None, help='a Catch Center CSV of the catches already held')
    ap.add_argument('--sort-model', default='sonnet')
    ap.add_argument('--measure-model', default='opus')
    ap.add_argument('--only-day', default=None, help='YYYY-MM-DD, for a test')
    ap.add_argument('--csv-name', default=None)
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    logf = open(os.path.join(a.out, 'sorter.log'), 'a', encoding='utf-8')

    def log(msg):
        line = '%s %s' % (time.strftime('%H:%M:%S'), msg)
        print(line, flush=True)
        logf.write(line + '\n')
        logf.flush()

    t0 = time.time()
    photos = list_photos(a.folders, a.only_day)
    days = {}
    for p in photos:
        days.setdefault(p['when'].strftime('%Y-%m-%d'), []).append(p)
    log('%d photos on %d days from %s' % (len(photos), len(days), '; '.join(a.folders)))
    history = read_history(a.history)
    run_tag = 'claude_fish_sorter_%s' % dt.date.today().isoformat()
    rows, held, failed, stopped = [], 0, [], None
    try:
        for day in sorted(days):
            try:
                fish = sort_day(day, days[day], a.sort_model, a.out, log)
            except (RuntimeError, ValueError, json.JSONDecodeError) as e:
                failed.append(day)
                log('  %s NOT SORTED: %s' % (day, str(e)[:200]))
                continue
            for f in fish:
                if already_held(f, history):
                    held += 1
                    continue
                m = None
                if f['board']:
                    try:
                        m = measure(f, a.measure_model, a.out, log)
                    except (RuntimeError, ValueError, json.JSONDecodeError) as e:
                        log('  %s NOT MEASURED: %s' % (f['board']['name'], str(e)[:200]))
                rows.append(row_for(f, m, run_tag))
    except UsageLimit as e:
        stopped = str(e)
        log('STOPPED at the usage limit -- run the same command again after it resets: ' + stopped[:200])
    path = os.path.join(a.out, a.csv_name or ('catches_claude_%s.csv' % (a.only_day or 'all')))
    with open(path, 'w', encoding='utf-8', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=CSV_COLUMNS)
        w.writeheader()
        w.writerows(rows)
    boards = sum(1 for r in rows if r['on_bump_board'] == 'true')
    log('%d fish written (%d on the board, %d without), %d already in the catch history, %d days not sorted%s, '
        '%.0f min%s -> %s' % (len(rows), boards, len(rows) - boards, held, len(failed),
                              (' (%s)' % ', '.join(failed)) if failed else '', (time.time() - t0) / 60,
                              ' -- STOPPED EARLY' if stopped else '', path))
    return 2 if stopped else 0


if __name__ == '__main__':
    sys.exit(main())
