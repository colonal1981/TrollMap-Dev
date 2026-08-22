#!/usr/bin/env python3
r"""resolve_feature_types.py -- ask 3DHP what each registry water IS, off the numeric column.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\resolve_feature_types.py `
       --gpkg F:\TrollMapPipeline\3dhp_all_CONUS_20260112_GPKG\3dhp_all_CONUS_20260112_GPKG.gpkg

Writes registry/_feature_types.json -- slug -> {feature_type, featuretype, label, via} -- which
consolidate_lake_index.py reads ahead of NHD and ahead of the name.

WHY THIS EXISTS, AND THE MISTAKE IT CORRECTS

`hydro_3dhp_all_waterbody` carries BOTH a numeric `featuretype` and a text `featuretypelabel`,
and the numeric one is the classification:

    1  River                  61,797
    2  Canal                   9,019
    3  Lake                5,676,466
    4  Ocean or Great Lake       684

On 2026-08-22 this project read `featuretypelabel` out of the REGISTRY CHECKPOINT
(`_registry_state.json`), found 13,718 "Lake" against a single "River", and concluded that 3DHP
could not tell moving water from still. The checkpoint is built with `--types`, so it holds only
what the registry run asked for. **A filtered cache was measured and the claim was made about the
source.** Ryan: "ummm 3dhp has water body type 1 river 2 canal 3 lake 4 ocean/marsh... why can't
you use that" -- it is in 00_START_HERE in his own words, and it was read past.

Same failure as the `11 07 0e` census two days earlier, which counted a lake tile to decide a
question about ocean tiles. **Measure the source, not a derivative of it.**

HOW A SLUG REACHES A 3DHP ROW

Two joins, both already recorded on disk, neither of them a name match:

  gnis   registry rows carry `gnis:<id>`; `_registry_state.json` maps that id to the `fids` the
         registry was built from. `fid` is the primary key, so this is instant.
  id3dhp boundaries cut by `boundary_from_3dhp.py` record `3dhp:<id>` in their staging file's
         `source` string. `id3dhp` is UNINDEXED, so every id goes into ONE `IN` scan -- about
         25 s for the whole set, against minutes if queried one at a time.

A water with neither join is left out of the file rather than guessed. consolidate falls through
to NHD FType for those, and says out loud how many it had to guess from the name.
"""
import argparse, io, json, os, re, sqlite3, sys, time

TABLE = 'hydro_3dhp_all_waterbody'
FEATURE_TYPE = {1: 'river', 2: 'river', 3: 'lake', 4: 'coastal'}
LABEL = {1: 'River', 2: 'Canal', 3: 'Lake', 4: 'Ocean or Great Lake'}
SRC = re.compile(r'"source"\s*:\s*"([^"]+)"')
ID3 = re.compile(r'3dhp:([A-Za-z0-9]+)')


def stage_sources(stage_dir):
    out = {}
    if not os.path.isdir(stage_dir):
        return out
    for f in os.listdir(stage_dir):
        if not f.endswith('.geojson'):
            continue
        try:
            with io.open(os.path.join(stage_dir, f), encoding='utf-8', errors='replace') as fh:
                head = fh.read(2000)
        except OSError:
            continue
        m = SRC.search(head)
        out[f] = m.group(1) if m else ''
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--gpkg', required=True)
    ap.add_argument('--registry', default='registry')
    ap.add_argument('--staging', default='lake_boundaries_3dhp')
    ap.add_argument('--index', default=None, help='default <registry>/lake_index.json')
    ap.add_argument('--state', default=None, help='default <registry>/_registry_state.json')
    ap.add_argument('--out', default=None, help='default <registry>/_feature_types.json')
    a = ap.parse_args()
    R = a.registry
    idx_p = a.index or os.path.join(R, 'lake_index.json')
    st_p = a.state or os.path.join(R, '_registry_state.json')
    out_p = a.out or os.path.join(R, '_feature_types.json')

    with io.open(idx_p, encoding='utf-8') as fh:
        idx = json.load(fh)
    try:
        with io.open(st_p, encoding='utf-8') as fh:
            groups = (json.load(fh) or {}).get('groups') or {}
    except (OSError, ValueError) as exc:
        print('!! could not read %s (%s) -- the gnis join is unavailable' % (st_p, exc))
        groups = {}
    stage = stage_sources(a.staging)

    fid_of, id3_of = {}, {}
    for slug, rec in idx.items():
        g = (rec.get('gnis') or '')
        if g.startswith('gnis:') and g[5:] in groups:
            fids = (groups[g[5:]] or {}).get('fids') or []
            if fids:
                fid_of[slug] = fids
                continue
        try:
            with io.open(os.path.join(R, 'boundaries', slug + '.geojson'),
                         encoding='utf-8', errors='replace') as fh:
                head = fh.read(8192)
        except OSError:
            continue
        m = SRC.search(head)
        blob = stage.get(m.group(1), '') if m else ''
        m2 = ID3.search(blob) or ID3.search(head)
        if m2:
            id3_of[slug] = m2.group(1)

    print('%d rows: %d join by gnis->fid, %d by id3dhp, %d by neither'
          % (len(idx), len(fid_of), len(id3_of), len(idx) - len(fid_of) - len(id3_of)))

    con = sqlite3.connect('file:%s?mode=ro' % a.gpkg, uri=True)
    cur = con.cursor()
    out = {}

    allf = sorted({f for v in fid_of.values() for f in v})
    ft_by_fid = {}
    for i in range(0, len(allf), 900):
        chunk = allf[i:i + 900]
        cur.execute('select fid, featuretype from %s where fid in (%s)'
                    % (TABLE, ','.join('?' * len(chunk))), chunk)
        ft_by_fid.update(dict(cur.fetchall()))
    for slug, fids in fid_of.items():
        # THE LARGEST PIECE DECIDES. A lake built from several fids can pick up a river fid where
        # an arm was merged in; the biggest polygon is the water, not the limb.
        seen = [ft_by_fid[f] for f in fids if f in ft_by_fid]
        if not seen:
            continue
        ft = max(set(seen), key=seen.count)
        if ft in FEATURE_TYPE:
            out[slug] = {'feature_type': FEATURE_TYPE[ft], 'featuretype': ft,
                         'label': LABEL[ft], 'via': 'gnis->fid'}

    vals = sorted(set(id3_of.values()))
    if vals:
        t = time.time()
        cur.execute('select id3dhp, featuretype from %s where id3dhp in (%s)'
                    % (TABLE, ','.join('?' * len(vals))), vals)
        by_id = dict(cur.fetchall())
        print('id3dhp scan: %d ids, %d hits, %.1fs' % (len(vals), len(by_id), time.time() - t))
        for slug, i3 in id3_of.items():
            ft = by_id.get(i3)
            if ft in FEATURE_TYPE:
                out[slug] = {'feature_type': FEATURE_TYPE[ft], 'featuretype': ft,
                             'label': LABEL[ft], 'via': 'id3dhp'}

    hist = {}
    for v in out.values():
        hist[v['label']] = hist.get(v['label'], 0) + 1
    print('resolved %d of %d -> %s' % (len(out), len(idx), hist))
    with io.open(out_p, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
    print('wrote %s' % out_p)
    return 0


if __name__ == '__main__':
    sys.exit(main())
