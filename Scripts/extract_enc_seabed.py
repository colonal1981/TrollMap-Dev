#!/usr/bin/env python3
"""
extract_enc_seabed.py -- bottom composition out of the NOAA charts we already have.

Personal use only, not for distribution or resale; not for navigation.

WHY THE ENCs AND NOT THE CHARTS WE ALREADY EXTRACT
    The coastal packs are built from the i-Boating vector tile cache, and Ryan was right that
    the soundings in them are NOAA's -- i-Boating's US charts are built on NOAA ENC data and
    the tile layer is even called `layer_soundg`, which is S-57's SOUNDG.

    But i-Boating kept the depth and dropped the rest. Scanning 600 tiles of the Georgia coastal
    cache finds six layers and no more: layer_areas, layer_soundg, layer_lines, layer_points,
    layer_depcnt, layer_points_rotate. No SBDARE. So the seabed class -- the single thing that
    would tell a plan whether it is over mud or shell -- was thrown away on the way through,
    and the original cells are sitting on the drive unread.

WHAT IT TAKES
    SBDARE      seabed area: NATSUR is the nature of the surface, coded.
    WRECKS      a wreck is structure whether or not the chart calls it that.
    OBSTRN      obstructions, same reasoning.
    UWTROC      underwater rocks -- hard bottom standing proud of soft bottom.

    The substrate keys it emits are the ones registry/species_habitat_weights.json already uses,
    because the whole point is that a species that wants soft bottom can be told where soft
    bottom is. A key here that the weights file does not know is reported, not written.

    READ FROM INSIDE THE ZIPS. GDAL reads S-57 through /vsizip/, so nothing is unpacked and the
    52 MB stays 52 MB. Cell updates (.001 .. .006) are applied by GDAL automatically.

USAGE
    py extract_enc_seabed.py --dry-run          # what would be read, and from where
    py extract_enc_seabed.py                    # write the per-zone seabed layers
    py extract_enc_seabed.py --zone coast_charleston_sc
"""

import argparse
import glob
import json
import os
import re
import sys
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
NOTE = 'Personal use only, not for distribution or resale; not for navigation.'
ENC_DIR = 'NOAA_ENC'
OUT_DIR = 'habitat_output'

# S-57 layers worth reading, and what each one is for. Chosen from a census of the charts
# (--list-layers), not from memory: 77 layers are present and these are the ones that are either
# bottom, or structure the ranker already has a weight for.
LAYERS = {
    'SBDARE': 'seabed',        # nature of the surface
    'WRECKS': 'wreck',
    'OBSTRN': 'obstruction',
    'UWTROC': 'rock',
    # ── added after the census ───────────────────────────────────────────────────────────────
    # SLCONS is the big one: 705 features in nine APPROACH cells, and the harbour cells (424 of
    # the 606) are where the docks are. Jetties, groynes, piers, wharves, training walls, rip rap
    # and sea walls -- hard edge, which is what the habitat matrix ranks High for sheepshead and
    # black drum and what classifyStructure() already matches on.
    'SLCONS': 'shore_structure',
    'PILPNT': 'piling',        # dock_piling, straight up
    'BRIDGE': 'bridge',        # DEFAULT_WEIGHTS already carries bridge and pile
    # Tide rips, overfalls and eddies. NOTHING ELSE WE HAVE MARKS MOVING WATER. A rip at a creek
    # mouth on the ebb is the thing coastal-scoring.js scores creek_mouth for, and until now the
    # only evidence for it was that a creek was there.
    'WATTUR': 'turbulence',
    # Sand waves. The only source we have for `structured_sand`, which the habitat matrix ranks
    # and NATSUR cannot produce -- it is a shape, not a surface.
    'SNDWAV': 'sand_wave',
    # ── where you may not go ─────────────────────────────────────────────────────────────────
    # Ryan, 2026-09-03, on Bushy Park on the Cooper: "it is right next to the naval weapons base
    # and there are areas that you are not allowed to go... being able to see that in trollmap
    # would be good it allows me to plan around them."
    #
    # He thought Garmin might already mark these. Garmin marks SOMETHING called restricted_area
    # -- 198 of them on 25 waters -- but checked against the packs they are swim-area stakes and
    # no-boat buoys on reservoirs. Across all 22 coastal packs there are three, and they are a
    # swimming platform in Albemarle and a no-discharge line at Cape Fear. In the box around
    # Bushy Park the packs hold place names, nav lights, piles and obstructions and NOT ONE
    # restricted area. The military zones are RESARE polygons in the ENC and nowhere else.
    'RESARE': 'restricted',
    # Where the chart admits it does not know. Worth as much as knowing the depth.
    'UNSARE': 'unsurveyed',
}

# A CONSTRAINT NEEDS ITS EDGES. Everything else here is reduced to a representative point,
# because the ranker's structureIndex() reduces polygons to centroids anyway and a point is what
# it consumes. A no-go zone is not a target, it is a boundary, and the centre of a restricted
# area tells you nothing about where its line runs.
KEEP_GEOMETRY = {'RESARE', 'UNSARE'}

# RESTRN -- what is actually forbidden. This is the operative field: "entry prohibited" and "no
# anchoring" are very different days. IHO's numbers.
RESTRN = {
    1: 'anchoring_prohibited', 2: 'anchoring_restricted',
    3: 'fishing_prohibited', 4: 'fishing_restricted',
    5: 'trawling_prohibited', 6: 'trawling_restricted',
    7: 'entry_prohibited', 8: 'entry_restricted',
    9: 'dredging_prohibited', 10: 'dredging_restricted',
    11: 'diving_prohibited', 12: 'diving_restricted',
    13: 'no_wake', 14: 'area_to_be_avoided',
    15: 'construction_prohibited', 16: 'discharging_prohibited',
    17: 'discharging_restricted',
}

# The ones that change where a kayak can go or fish, as opposed to what a ship may do there.
MATTERS_TO_US = {'entry_prohibited', 'entry_restricted',
                 'fishing_prohibited', 'fishing_restricted', 'area_to_be_avoided'}

# CATREA (category of restricted area) is DELIBERATELY NOT DECODED. I am not confident of the
# code order, and a table typed from memory that labels a military zone as a swimming area is
# worse than no label at all. The raw code is passed through so it can be decoded later against
# the standard rather than against my recollection.

# CATSLC, the category of a shoreline construction. A fishing pier and a rip-rap revetment are
# both SLCONS and they are not the same place to put a leg, so the code is decoded rather than
# thrown away. IHO's numbers.
CATSLC = {
    1: 'breakwater', 2: 'groyne', 3: 'mole', 4: 'pier', 5: 'promenade_pier',
    6: 'wharf', 7: 'training_wall', 8: 'rip_rap', 9: 'revetment', 10: 'sea_wall',
    11: 'landing_steps', 12: 'ramp', 13: 'slipway', 14: 'fender', 15: 'solid_face_wharf',
    16: 'open_face_wharf', 17: 'log_ramp',
}

# ── the one typed table ─────────────────────────────────────────────────────────────────────
# S-57 NATSUR, the standard "nature of surface" code list, against the substrate keys that
# registry/species_habitat_weights.json already uses. These are IHO's numbers, not ours; the
# mapping is only the grouping into the four classes the habitat matrix ranks.
NATSUR = {
    1:  ('mud',      'fine'),
    2:  ('clay',     'fine'),
    3:  ('silt',     'fine'),
    4:  ('sand',     'fine'),
    5:  ('stone',    'coarse'),
    6:  ('gravel',   'coarse'),
    7:  ('pebbles',  'coarse'),
    8:  ('cobbles',  'coarse'),
    9:  ('rock',     'hard'),
    11: ('lava',     'hard'),
    14: ('coral',    'live_hard'),
    17: ('shells',   'shell'),
    18: ('boulder',  'hard'),
}

# Usage band from the cell name: US5xxxxx is harbour, US4 approach. Bands 1-3 are overview and
# coastal charts whose seabed polygons are far too coarse to put a leg on.
BAND_RE = re.compile(r'US(\d)', re.I)
DEFAULT_MIN_BAND = 4


def layer_names(rows):
    """
    Layer names out of whatever the reader returned.

    pyogrio hands back an Nx2 array of (name, geometry_type); fiona and ogr hand back names.
    Normalised here so the caller does not care which library is installed.
    """
    out = []
    for r in (rows.tolist() if hasattr(rows, 'tolist') else list(rows)):
        out.append(str(r[0]) if isinstance(r, (list, tuple)) else str(r))
    return out


def list_layers(path):
    """
    Layer names in an S-57 cell, asked of GDAL rather than assumed.

    THREE READERS, BECAUSE GEOPANDAS PICKS ONE AND DOES NOT SAY WHICH. The first version tried
    fiona then osgeo and reported "No module named 'osgeo'" on every cell -- on a machine where
    the main extract had already read 1,235 layers successfully, because geopandas is running
    on pyogrio and neither of the two I asked was installed. A tool that cannot find the library
    already doing the work is asking the wrong question.
    """
    errors = []
    try:
        import pyogrio                                           # noqa: WPS433
        return layer_names(pyogrio.list_layers(path))
    except ImportError as e:
        errors.append(str(e))
    try:
        import fiona                                             # noqa: WPS433
        return layer_names(fiona.listlayers(path))
    except ImportError as e:
        errors.append(str(e))
    try:
        from osgeo import ogr                                    # noqa: WPS433
    except ImportError as e:
        errors.append(str(e))
        raise RuntimeError('no reader available: ' + '; '.join(errors))
    ds = ogr.Open(path)
    if ds is None:
        raise RuntimeError('could not open')
    return [ds.GetLayerByIndex(i).GetName() for i in range(ds.GetLayerCount())]


def push_layer(slug, name, text, dry_run=False):
    """
    One zone's layer into R2, through the road that already exists.

    NOT A SIXTH UPLOADER. extract_coastal_habitat.py's own note records what happened the last
    time somebody wrote another one: it became "the FIFTH road into trollmap-chartpacks and the
    last one found", sat on 208 MB raw across 37 objects, and the audit could not see it because
    `marsh_edges` and `oyster_beds` were in no uploader's layer vocabulary so no rule had an
    opinion about them.

    `seabed.geojson` is that shape exactly. So it goes up the same road, gzipped the same way,
    into the same per-slug key layout -- and the import is lazy because that module exits at
    import time when geopandas is missing, which must not take a --dry-run down with it.
    """
    try:
        from extract_coastal_habitat import upload_to_r2       # noqa: WPS433
    except SystemExit as e:
        raise RuntimeError('extract_coastal_habitat.py refused to import '
                           f'(missing geopandas or coastal_catalog.py): {e}')
    return upload_to_r2(slug, name, text, dry_run=dry_run)


def _root():
    d = HERE
    for _ in range(4):
        if os.path.isdir(os.path.join(d, ENC_DIR)):
            return d
        d = os.path.dirname(d)
    return os.path.dirname(HERE)


# ── pure helpers, all testable without GDAL ─────────────────────────────────────────────────
def band_of(cell_path):
    """Usage band 1-5 from a cell's name, or None when it is not a US cell."""
    name = os.path.basename(str(cell_path))
    m = BAND_RE.match(name)
    return int(m.group(1)) if m else None


def cells_in_zip(zip_path, min_band=DEFAULT_MIN_BAND):
    """
    Every base cell in the archive worth reading, as /vsizip/ paths.

    Only `.000` -- the `.001`..`.006` files are UPDATES to a base cell, not cells of their own,
    and GDAL applies them when it opens the base. Listing them as cells would read the same
    water several times and count it several times.
    """
    out = []
    with zipfile.ZipFile(zip_path) as z:
        for n in z.namelist():
            if not n.lower().endswith('.000'):
                continue
            b = band_of(n)
            if b is None or b < min_band:
                continue
            out.append(('/vsizip/' + zip_path.replace('\\', '/') + '/' + n, b))
    return sorted(out)


def natsur_codes(value):
    """
    NATSUR as a list of ints, however GDAL hands it over.

    S-57 attributes like NATSUR are LIST-VALUED, and geopandas returns those as a numpy array,
    not a string. The first version tested for int/float and otherwise called str() -- which
    turned array([1, 4]) into "[1 4]", split it into '[1' and '4]', found neither was a digit,
    and reported no substrate at all. The first real run read 574 features into ACE Basin and
    scored not one of them, and the only sign was a dash in a column.

    So: anything iterable is iterated, and the string path strips brackets rather than trusting
    that it will never see one.
    """
    if value is None:
        return []
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        # NaN IS A FLOAT. pandas fills a missing numeric column with it, so `isinstance(v, float)`
        # is True for a cell that holds nothing at all, and int(nan) raises. Third variant of the
        # same mistake in this function -- the value is not the type the column implies -- and
        # the reason the checks here are paranoid rather than tidy.
        if value != value or value in (float('inf'), float('-inf')):
            return []
        return [int(value)]
    if isinstance(value, (list, tuple, set)) or hasattr(value, 'tolist'):
        seq = value.tolist() if hasattr(value, 'tolist') else list(value)
        out = []
        for v in (seq if isinstance(seq, (list, tuple)) else [seq]):
            out += natsur_codes(v)
        return out
    out = []
    for part in re.split(r'[,\s]+', str(value).strip('[]() ')):
        part = part.strip('[]() ')
        if part.isdigit():
            out.append(int(part))
    return out


def jsonable(v):
    """
    A value json.dump will accept.

    Same root cause as the NATSUR bug and it crashed the first real run outright: NATQUA came
    back as an ndarray and json.dump raised on it after the features were already gathered --
    an hour of chart reading thrown away at the write.
    """
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if hasattr(v, 'tolist'):
        v = v.tolist()
    if isinstance(v, (list, tuple, set)):
        return [jsonable(x) for x in v]
    if isinstance(v, dict):
        return {str(k): jsonable(x) for k, x in v.items()}
    return str(v)


def first_code(value):
    """The first integer in a coded attribute, or None. Same list handling as NATSUR."""
    codes = natsur_codes(value)
    return codes[0] if codes else None


def substrate_of(natsur_value):
    """
    (substrate_key, [names]) for a feature's NATSUR, or (None, []) when nothing is coded.

    THE FIRST CODE IS THE DOMINANT ONE. S-57 orders NATSUR by prevalence, so 'sand over rock'
    is sand. Picking the hardest or the softest instead would silently reclassify the bottom.
    """
    names, keys = [], []
    for c in natsur_codes(natsur_value):
        if c in NATSUR:
            n, k = NATSUR[c]
            names.append(n)
            keys.append(k)
    return (keys[0] if keys else None), names


def summarise(features):
    """Counts per substrate key and per named surface, for the registry line."""
    by_key = Counter()
    by_name = Counter()
    for f in features:
        if f.get('substrate'):
            by_key[f['substrate']] += 1
        for n in f.get('surfaces') or []:
            by_name[n] += 1
    return dict(by_key.most_common()), dict(by_name.most_common())


def weights_substrate_keys(root):
    """The substrate vocabulary the weights file uses. Read, so the two cannot drift apart."""
    p = os.path.join(root, 'registry', 'species_habitat_weights.json')
    if not os.path.exists(p):
        return set()
    try:
        with open(p, encoding='utf-8') as f:
            d = json.load(f)
    except (OSError, ValueError):
        return set()
    keys = set()
    for rec in (d.get('species') or {}).values():
        for stage in (rec.get('substrates') or {}).values():
            keys.update(stage)
    return keys


# ── geometry (shared shape with the other zone binders) ─────────────────────────────────────
def rings(geom):
    t = (geom or {}).get('type')
    c = (geom or {}).get('coordinates')
    return [c] if t == 'Polygon' else (c if t == 'MultiPolygon' else [])


def in_polygon(x, y, poly):
    inside = False
    for i, ring in enumerate(poly):
        hit = False
        n = len(ring)
        for j in range(n):
            x1, y1 = ring[j][:2]
            x2, y2 = ring[(j + 1) % n][:2]
            if (y1 > y) != (y2 > y):
                if x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                    hit = not hit
        if i == 0:
            if not hit:
                return False
            inside = True
        elif hit:
            return False
    return inside


def load_zones(root, only=None):
    zones = {}
    for path in sorted(glob.glob(os.path.join(root, 'registry', 'boundaries',
                                              'coast_*.geojson'))):
        slug = os.path.basename(path)[:-len('.geojson')]
        if only and slug not in only:
            continue
        try:
            with open(path, encoding='utf-8') as f:
                gj = json.load(f)
        except (OSError, ValueError):
            continue
        polys = []
        for feat in (gj.get('features') or [gj]):
            polys += rings(feat.get('geometry') or feat)
        if not polys:
            continue
        xs = [p[0] for poly in polys for ring in poly for p in ring]
        ys = [p[1] for poly in polys for ring in poly for p in ring]
        zones[slug] = {'polys': polys, 'bbox': (min(xs), min(ys), max(xs), max(ys))}
    return zones


def zones_containing(lon, lat, zones):
    hits = []
    for slug, z in zones.items():
        x0, y0, x1, y1 = z['bbox']
        if not (x0 <= lon <= x1 and y0 <= lat <= y1):
            continue
        if any(in_polygon(lon, lat, p) for p in z['polys']):
            hits.append(slug)
    return hits


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default=None)
    ap.add_argument('--zone', action='append', default=None)
    ap.add_argument('--min-band', type=int, default=DEFAULT_MIN_BAND,
                    help='lowest chart usage band to read (4 approach, 5 harbour)')
    ap.add_argument('--upload', action='store_true',
                    help='also push each zone\'s seabed.geojson to R2, through the same road '
                         'extract_coastal_habitat.py uses for oyster_beds and marsh_edges')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--list-layers', type=int, metavar='N', default=0,
                    help='open N cells per archive and report every S-57 layer in them, with '
                         'feature counts. Reads nothing else and writes nothing.')
    a = ap.parse_args()

    root = a.root or _root()
    zips = sorted(glob.glob(os.path.join(root, ENC_DIR, '*.zip')))
    if not zips:
        print(f'ERROR: no ENC archives in {os.path.join(root, ENC_DIR)}', file=sys.stderr)
        return 2
    zones = load_zones(root, set(a.zone) if a.zone else None)
    if not zones:
        print('ERROR: no coastal boundaries to bind to', file=sys.stderr)
        return 2

    cells = []
    for z in zips:
        got = cells_in_zip(z, a.min_band)
        cells += got
        bands = Counter(b for _, b in got)
        print(f'{os.path.basename(z):16} {len(got):>4} cell(s) at band >= {a.min_band}  '
              f'{dict(sorted(bands.items()))}')
    print(f'{len(cells)} cell(s) total, {len(zones)} zone(s)')

    known = weights_substrate_keys(root)
    if known:
        mine = {k for _, k in NATSUR.values()}
        extra = mine - known
        print(f'substrate keys: {len(mine)} here, {len(known)} in species_habitat_weights.json'
              + (f'  -- not in the weights file: {", ".join(sorted(extra))}' if extra else ''))

    if a.dry_run:
        print('\ndry run -- no chart opened, nothing written')
        return 0

    try:
        import geopandas as gpd                                  # noqa: WPS433
    except ImportError:
        print('ERROR: pip install geopandas --break-system-packages', file=sys.stderr)
        return 2

    if a.list_layers:
        # WHAT ELSE IS IN THESE CHARTS.
        #
        # LAYERS above is four object classes chosen for a reason, and choosing four means
        # deciding the rest are not worth having -- from memory, which is how a source gets
        # missed. This asks the charts instead. Feature counts come with the names because a
        # layer that exists and is empty in our water is not a layer we want.
        per_zip = defaultdict(Counter)
        rows = defaultdict(Counter)
        for zpath in zips:
            sample = [p for p, _ in cells_in_zip(zpath, a.min_band)][:a.list_layers]
            print(f'\n{os.path.basename(zpath)}: opening {len(sample)} cell(s)')
            for cell in sample:
                try:
                    names = list_layers(cell)
                except Exception as e:                           # noqa: BLE001
                    print(f'   !! {os.path.basename(cell)}: {e}')
                    continue
                for lname in names:
                    per_zip[os.path.basename(zpath)][lname] += 1
                    try:
                        gdf = gpd.read_file(cell, layer=lname)
                        rows[lname][os.path.basename(zpath)] += 0 if gdf is None else len(gdf)
                    except Exception:                            # noqa: BLE001
                        pass
        allnames = sorted({n for c in per_zip.values() for n in c})
        print(f'\n{len(allnames)} distinct S-57 layer(s) across the sampled cells')
        print(f"  {'layer':10} {'cells':>6} {'features':>9}   {'taken?':7}")
        for n in sorted(allnames, key=lambda n: -sum(rows[n].values())):
            cells_with = sum(c[n] for c in per_zip.values())
            feats = sum(rows[n].values())
            print(f'  {n:10} {cells_with:>6} {feats:>9}   '
                  f'{"yes" if n in LAYERS else "-"}')
        return 0

    per_zone = defaultdict(list)
    read = skipped = 0
    for path, band in cells:
        for layer, kind in LAYERS.items():
            try:
                gdf = gpd.read_file(path, layer=layer)
            except Exception:                                    # noqa: BLE001
                skipped += 1
                continue
            if gdf is None or gdf.empty:
                continue
            if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
                gdf = gdf.to_crs('EPSG:4326')
            read += 1
            for _, row in gdf.iterrows():
                g = row.geometry
                if g is None or g.is_empty:
                    continue
                pt = g.representative_point()
                hits = zones_containing(pt.x, pt.y, zones)
                if not hits:
                    continue
                shape = None
                if layer in KEEP_GEOMETRY:
                    try:
                        shape = jsonable(g.__geo_interface__)
                    except Exception:                            # noqa: BLE001
                        shape = None
                key, names = substrate_of(row.get('NATSUR'))
                rec = {'kind': kind, 'substrate': key, 'surfaces': names,
                       'lon': round(pt.x, 6), 'lat': round(pt.y, 6),
                       'band': band, 'cell': os.path.basename(path)}
                if shape:
                    rec['shape'] = shape
                cat = first_code(row.get('CATSLC'))
                if cat is not None:
                    rec['category'] = CATSLC.get(cat, f'catslc_{cat}')
                rules = [RESTRN.get(c, f'restrn_{c}') for c in natsur_codes(row.get('RESTRN'))]
                if rules:
                    rec['restrictions'] = rules
                    rec['blocksUs'] = sorted(set(rules) & MATTERS_TO_US)
                craw = first_code(row.get('CATREA'))
                if craw is not None:
                    rec['catrea'] = craw
                for extra in ('NATQUA', 'WATLEV', 'VALSOU', 'CATOBS', 'CATWRK', 'OBJNAM',
                              'INFORM', 'NINFOM'):
                    v = jsonable(row.get(extra))
                    if v is not None and v != [] and str(v) != 'nan':
                        rec[extra] = v
                for slug in hits:
                    per_zone[slug].append(rec)

    print(f'\nread {read} layer(s); {skipped} layer read(s) not present in a cell')
    out_root = os.path.join(root, OUT_DIR)
    summary = {}
    pushed = []
    for slug in sorted(zones):
        feats = per_zone.get(slug, [])
        keys, names = summarise(feats)
        summary[slug] = {'features': len(feats), 'bySubstrate': keys, 'bySurface': names,
                         'byKind': dict(Counter(f['kind'] for f in feats)),
                         'byCategory': dict(Counter(f['category'] for f in feats
                                                    if f.get('category')).most_common()),
                         'restrictions': dict(Counter(r for f in feats
                                                      for r in (f.get('restrictions') or [])
                                                      ).most_common()),
                         'blocksUs': dict(Counter(r for f in feats
                                                  for r in (f.get('blocksUs') or [])
                                                  ).most_common())}
        print(f'  {slug:32} {len(feats):>6}  {keys or "-"}')
        if feats and not keys:
            # A zone full of seabed features and not one classified means NATSUR is not being
            # read, not that the bottom is unknown. That is a defect wearing the costume of a
            # result, and it is exactly what the first run did.
            seabed = sum(1 for f in feats if f['kind'] == 'seabed')
            if seabed:
                print(f'  {"":32}  !! {seabed} seabed feature(s) and no NATSUR read -- '
                      'the attribute is not being parsed')
        if not feats:
            continue
        d = os.path.join(out_root, slug)
        os.makedirs(d, exist_ok=True)
        gj = {'type': 'FeatureCollection', 'properties': {'note': NOTE,
                                                          'generatedBy': 'extract_enc_seabed.py'},
              'features': [{'type': 'Feature',
                            'geometry': f.get('shape')
                            or {'type': 'Point', 'coordinates': [f['lon'], f['lat']]},
                            'properties': {k: v for k, v in f.items()
                                           if k not in ('lon', 'lat', 'shape')}} for f in feats]}
        text = json.dumps(gj, separators=(',', ':'))
        with open(os.path.join(d, 'seabed.geojson'), 'w', encoding='utf-8') as f:
            f.write(text)
        if a.upload:
            try:
                pushed.append((slug, push_layer(slug, 'seabed.geojson', text)))
            except Exception as e:                               # noqa: BLE001
                print(f'  {"":32}  !! upload failed: {e}')
                pushed.append((slug, False))

    dest = os.path.join(root, 'registry', 'enc_seabed_by_zone.json')
    with open(dest, 'w', encoding='utf-8') as f:
        json.dump({'note': NOTE, 'generatedBy': 'extract_enc_seabed.py',
                   'generated': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                   'minBand': a.min_band, 'cells': len(cells),
                   'zones': summary}, f, indent=1)
    print(f'\nwrote {dest} and per-zone seabed.geojson under {out_root}')
    if a.upload:
        ok = sum(1 for _, good in pushed if good)
        print(f'uploaded {ok} of {len(pushed)} zone layer(s) to R2')
        if ok != len(pushed):
            # A partial upload is the one outcome that must not read as success: the packs then
            # hold seabed for some zones and not others, and a zone with none looks surveyed.
            print('!! not every zone landed -- re-run with --upload to finish, '
                  'the rest are unchanged')
            return 1
    elif per_zone:
        print('NOT UPLOADED. Pass --upload to push these into the packs; until then the app '
              'cannot read them.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
