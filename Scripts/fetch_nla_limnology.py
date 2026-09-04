#!/usr/bin/env python3
r"""fetch_nla_limnology.py -- the vertical profiles WQP does not have.

    py .\scripts\fetch_nla_limnology.py                 # dry run: what it would match and write
    py .\scripts\fetch_nla_limnology.py --go            # download, match, write the registry file
    py .\scripts\fetch_nla_limnology.py --go --refresh  # re-download the EPA files

Dry run by default, like every other writer in this pipeline.

WHY THIS EXISTS. Ryan, 2026-09-04, after the thermocline came back null on his own lake: "research
is still needed for limnology... wqp cannot do it by itself". He is right, and the app's own notes
had already said so. Across 66 profiles carrying a WQP block, 233,371 records:

    37   answered -- a thermocline depth came out
     7   "No thermocline: summer DO never fell under 4 mg/L"      a real answer, not a gap
    13   "Every record carries a depth but they fall in one 2 ft band. These are surface
          grabs with a depth stamp, not a vertical profile."       <- Lake Wateree, 3,211 records
     6   "records are surface..."
     3   "Depth-profile records exist but were insufficient to derive..."

So 22 waters have WQP data and no vertical profile in it, and 14 more have no WQP block at all.
The two numbers that set a summer depth band -- the thermocline and the depth oxygen fails at --
cannot be got from surface grabs no matter how many of them there are.

WHAT THIS READS. EPA's National Aquatic Resource Surveys publish the National Lakes Assessment,
which is the modern successor to the 1970s National Eutrophication Survey that Worker/research/
dataset.js already hunts on NEPIS. Ryan: "wasn't the EPA NSCEP NES reports supposed to help with
some of that although they are older... is there anything newer?" This is the newer one. Field
crews "recorded temperature, pH and dissolved oxygen at multiple depths using an electronic
sensor" -- a real vertical cast, which is exactly the measurement missing.

Three cycles, site information plus the hydrographic profile for each:

    2007   nla2007_sampledlakeinformation_20091113.csv  +  nla2007_profile_20091008.csv
    2012   nla2012_wide_siteinfo_08232016.csv           +  nla2012_profile_wide.csv
    2022   nla22_siteinfo.csv                           +  nla2022_profile_wide.csv

A LAKE IS MATCHED BY ITS COORDINATES, NEVER BY ITS NAME. NLA carries GNIS_NAME and a lat/lon per
site; our boundaries are polygons. A point-in-polygon test against registry/boundaries/<slug>.geojson
is the same test build_water_names.py settled on after a ramp 475 m away donated its name to the
wrong pond. Name matching across two federal datasets and our own aliases is how Goat Rock Lake
reached rock_eagle_lake 200 km away.

AND IT REFUSES TO INVENT A DEPTH. This is the whole reason the file is written this way.
Lake Wateree's stored profile carried, for months:

    thermocline.summerDepthFt  27      note: "No specific thermocline depth profile data
                                              provided in the source text."
    oxygen.depletionDepthFt    "27"    note: "DO drops below 2 mg/L in bottom waters;
    oxygen.anoxicBelowFt        27            specific depth not provided."

Three fields, one number, one of them a string, and both notes saying the depth was never given.
Nothing in the evidence array supported any of it. So every derivation below states the rows it
came from, and returns None with a reason rather than a number when the cast cannot carry one:
fewer than MIN_DEPTHS readings, a span shallower than MIN_SPAN_M, or no gradient reaching
THERMO_GRAD_C_PER_M. A refusal with a reason is a result.

Personal use only, not for distribution or resale; not for navigation.
"""
import argparse
import csv
import io
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

UA = ('trollmap-nla/1.0 (+personal use; https://github.com/colonal1981/TrollMap-Dev)')
STATES = {'SC', 'NC', 'GA', 'TN'}
CACHE = '_nla'
OUT = 'nla_limnology.json'

# key -> (site information, hydrographic profile). Both are published per cycle.
SOURCES = {
    '2007': ('https://www.epa.gov/sites/default/files/2014-01/nla2007_sampledlakeinformation_20091113.csv',
             'https://www.epa.gov/sites/default/files/2013-09/nla2007_profile_20091008.csv'),
    '2012': ('https://www.epa.gov/sites/default/files/2016-12/nla2012_wide_siteinfo_08232016.csv',
             'https://www.epa.gov/system/files/other-files/2024-09/nla2012_profile_wide.csv'),
    '2022': ('https://www.epa.gov/system/files/other-files/2024-08/nla22_siteinfo.csv',
             'https://www.epa.gov/system/files/other-files/2024-08/nla2022_profile_wide.csv'),
}

# ── WHAT A CAST HAS TO CARRY BEFORE IT MAY ANSWER ───────────────────────────────────────────
# A thermocline is a gradient, not a depth somebody liked the look of. These three are the whole
# guard, and every one of them produces a NAMED refusal rather than a silent null.
MIN_DEPTHS = 4          # four readings is the fewest that can show a break rather than a slope
MIN_SPAN_M = 3.0        # a cast over one metre of water describes the surface, not the column
THERMO_GRAD_C_PER_M = 1.0   # the classical definition, and the one WQP's own reader uses
ANOXIC_MGL = 2.0
DEPLETION_MGL = 5.0
M_TO_FT = 3.28084

# NLA has renamed these across cycles. Read as a list of candidates, never as one typed name --
# 2007 says LAT_DD, 2012 and 2022 say LAT_DD83, and a reader that knows one gets nothing from the
# others while looking exactly like a survey that does not cover us.
COL = {
    'site':  ['UID', 'SITE_ID', 'NLA12_ID', 'NLA22_ID', 'NLA07_ID'],
    # 2007 says ST, 2012 says STATE, and 2022 says PSTL_CODE. The first run found no state
    # column in the 2022 file at all and reported "3880 sites in SC/NC/GA/TN" -- which was
    # every site in the country, unfiltered. The point-in-polygon test still gave the right
    # 61 matches, so nothing was wrong in the OUTPUT; the report was wrong, and a report
    # that misstates its own scope is how a count gets quoted later as a fact.
    'state': ['STATE', 'ST', 'PSTL_CODE', 'STATE_NAME'],
    'name':  ['GNIS_NAME', 'LAKENAME', 'LAKE_NAME', 'NARS_NAME'],
    'lat':   ['LAT_DD83', 'LAT_DD', 'LATITUDE', 'INDEX_LAT_DD'],
    'lon':   ['LON_DD83', 'LON_DD', 'LONGITUDE', 'INDEX_LON_DD'],
    'date':  ['DATE_COL', 'DATE_SAMP', 'VISIT_DATE', 'SAMPLE_DATE'],
    'depth': ['DEPTH', 'PROFILE_DEPTH', 'DEPTH_M', 'SAMPLE_DEPTH'],
    'temp':  ['TEMPERATURE', 'TEMP', 'TEMP_FIELD', 'WTEMP'],
    'do':    ['OXYGEN', 'DO', 'DO_FIELD', 'DISSOLVED_OXYGEN', 'DO_MGL'],
}


def pick(headers, names):
    """The first candidate this file actually has, matched case- and space-insensitively."""
    norm = {str(h or '').strip().upper().replace(' ', '_'): h for h in headers}
    for n in names:
        if n in norm:
            return norm[n]
    return None


def num(v):
    try:
        f = float(str(v).strip())
        return f if f == f else None            # NaN is not a number, whatever float() says
    except (TypeError, ValueError):
        return None


def fetch(url, path, refresh=False):
    if os.path.exists(path) and not refresh:
        return path, os.path.getsize(path), 'cached'
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/csv,*/*'})
    with urllib.request.urlopen(req, timeout=180) as r:
        body = r.read()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(body)
    return path, len(body), 'downloaded'


def read_csv(path):
    with open(path, encoding='utf-8-sig', errors='replace', newline='') as fh:
        rdr = csv.DictReader(fh)
        return rdr.fieldnames or [], list(rdr)


# ── THE DERIVATIONS, EACH ONE ABLE TO REFUSE ────────────────────────────────────────────────

def thermocline_from(cast):
    """The steepest temperature gradient in a cast, or a reason there is none.

    Returns (depth_ft, note). `depth_ft` is None whenever the cast cannot carry the answer, and
    `note` always says which of the three guards refused it -- because "no thermocline" and "we
    did not measure deep enough to see one" are different claims about the lake.
    """
    pts = sorted([(d, t) for d, t, _o in cast if d is not None and t is not None])
    if len(pts) < MIN_DEPTHS:
        return None, f'only {len(pts)} temperature readings in the cast; {MIN_DEPTHS} needed'
    span = pts[-1][0] - pts[0][0]
    if span < MIN_SPAN_M:
        return None, f'the cast spans {span:.1f} m; that describes the surface, not the column'
    best, at = 0.0, None
    for (d1, t1), (d2, t2) in zip(pts, pts[1:]):
        dz = d2 - d1
        if dz <= 0:
            continue
        grad = abs(t1 - t2) / dz
        if grad > best:
            best, at = grad, (d1 + d2) / 2.0
    if best < THERMO_GRAD_C_PER_M:
        return None, (f'no layer reaches {THERMO_GRAD_C_PER_M} C/m -- steepest was {best:.2f} C/m '
                      f'over {span:.1f} m. This lake did not stratify on this visit.')
    return round(at * M_TO_FT, 1), f'steepest gradient {best:.2f} C/m at {at:.1f} m'


def oxygen_from(cast, threshold):
    """The shallowest depth where DO falls below `threshold`, or a reason there is none."""
    pts = sorted([(d, o) for d, _t, o in cast if d is not None and o is not None])
    if len(pts) < MIN_DEPTHS:
        return None, f'only {len(pts)} oxygen readings in the cast; {MIN_DEPTHS} needed'
    for d, o in pts:
        if o < threshold:
            return round(d * M_TO_FT, 1), f'{o:.2f} mg/L at {d:.1f} m'
    lo = min(o for _d, o in pts)
    return None, (f'oxygen never fell under {threshold} mg/L -- lowest was {lo:.2f} mg/L at '
                  f'{max(d for d, _o in pts):.1f} m. That is an answer, not a gap.')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--registry', default='registry')
    ap.add_argument('--go', action='store_true', help='download, match and write')
    ap.add_argument('--refresh', action='store_true', help='re-download the EPA files')
    ap.add_argument('--years', default='2007,2012,2022')
    args = ap.parse_args()

    reg = os.path.abspath(args.registry)
    cache = os.path.join(reg, CACHE)
    bdir = os.path.join(reg, 'boundaries')
    if not os.path.isdir(bdir):
        sys.exit(f'no boundaries folder at {bdir} -- nothing to match against')

    try:
        from shapely.geometry import shape, Point
        from shapely.strtree import STRtree
    except ImportError:
        sys.exit('shapely is required: py -m pip install shapely')

    # ── our waters, as polygons, because a coordinate is the only honest join here ───────────
    geoms, slugs = [], []
    for fn in sorted(os.listdir(bdir)):
        if not fn.endswith('.geojson'):
            continue
        try:
            g = json.load(open(os.path.join(bdir, fn), encoding='utf-8'))
            gm = shape(g['features'][0]['geometry'] if g.get('type') == 'FeatureCollection'
                       else (g.get('geometry') or g))
        except Exception:
            continue
        geoms.append(gm)
        slugs.append(fn[:-len('.geojson')])
    if not geoms:
        sys.exit('no boundary polygons read')
    tree = STRtree(geoms)
    print(f'{len(geoms)} boundary polygons to match against')

    years = [y.strip() for y in args.years.split(',') if y.strip() in SOURCES]
    if not args.go:
        print('\ndry run. --go downloads these and matches them:')
        for y in years:
            for u in SOURCES[y]:
                print(f'  {y}  {u}')
        print('\nNothing is written without --go.')
        return 0

    # A PARTIAL RUN MUST NOT WRITE A WHOLE FILE -- three instances of that in this pipeline
    # already and a standing rule about it. `--years 2022` used to replace a file holding all
    # three cycles, taking 95 waters down to 32 without saying so.
    out, unmatched, refusals = {}, [], []
    prior = os.path.join(reg, OUT)
    if set(years) != set(SOURCES) and os.path.exists(prior):
        try:
            keep = (json.load(open(prior, encoding='utf-8')) or {}).get('waters') or {}
            for slug, rec in keep.items():
                rec['visits'] = [v for v in (rec.get('visits') or []) if v.get('year') not in years]
                if rec['visits']:
                    out[slug] = rec
            print(f'carrying forward {len(out)} water(s) from the years this run is not doing')
        except Exception as e:
            sys.exit(f'{prior} exists and could not be read ({e}). Refusing to overwrite it.')
    for y in years:
        si_url, pr_url = SOURCES[y]
        si_path, si_n, how1 = fetch(si_url, os.path.join(cache, f'nla{y}_siteinfo.csv'), args.refresh)
        pr_path, pr_n, how2 = fetch(pr_url, os.path.join(cache, f'nla{y}_profile.csv'), args.refresh)
        print(f'\n{y}: siteinfo {si_n:,} B ({how1}), profile {pr_n:,} B ({how2})')

        sh, srows = read_csv(si_path)
        c_site, c_state = pick(sh, COL['site']), pick(sh, COL['state'])
        c_name, c_lat, c_lon = pick(sh, COL['name']), pick(sh, COL['lat']), pick(sh, COL['lon'])
        if not (c_site and c_lat and c_lon):
            print(f'  !! site file has no id/lat/lon column this reader knows: {sh[:12]}')
            continue
        print(f'  columns: site={c_site} state={c_state} name={c_name} lat={c_lat} lon={c_lon}')

        # site -> our slug, by containment
        here, in_states = {}, 0
        for r in srows:
            # THE POLYGON IS THE TEST AND THE STATE CODE IS NOT. Filtering on the state column
            # first cost 26 real matches on the 2022 file the moment that column was found: our
            # boundaries carry border waters -- Hartwell SC/GA, Chatuge NC/GA, Calderwood TN/NC --
            # and EPA assigns each site ONE state. A weaker gate in front of a stronger one is the
            # same shape as the ramp species that never reached a plan. The state is now read for
            # the report only, and containment decides.
            st = str(r.get(c_state) or '').strip().upper()[:2] if c_state else ''
            if st in STATES:
                in_states += 1
            lat, lon = num(r.get(c_lat)), num(r.get(c_lon))
            if lat is None or lon is None:
                continue
            p = Point(lon, lat)
            hit = None
            for i in tree.query(p):
                idx = int(i)
                if geoms[idx].contains(p):
                    hit = slugs[idx]
                    break
            nm = str(r.get(c_name) or '').strip() if c_name else ''
            if hit:
                here[str(r.get(c_site)).strip()] = {'slug': hit, 'nla_name': nm,
                                                    'lat': lat, 'lon': lon, 'state': st}
            elif st in STATES:
                # Reported only for OUR states, because this list is a candidate list -- waters
                # EPA has a vertical cast for that we do not carry -- and a national one is noise.
                # Containment still decides what MATCHES; this gate only decides what is worth
                # printing when nothing matched.
                unmatched.append((y, nm or str(r.get(c_site)), st, lat, lon))
        print(f'  {in_states} sites carry an SC/NC/GA/TN code; {len(here)} sites of ANY code sit inside one of our boundaries')
        if not here:
            continue

        ph, prows = read_csv(pr_path)
        p_site = pick(ph, COL['site'])
        p_depth, p_temp, p_do = pick(ph, COL['depth']), pick(ph, COL['temp']), pick(ph, COL['do'])
        p_date = pick(ph, COL['date'])
        if not (p_site and p_depth):
            print(f'  !! profile file has no id/depth column this reader knows: {ph[:14]}')
            continue
        casts = {}
        for r in prows:
            sid = str(r.get(p_site) or '').strip()
            if sid not in here:
                continue
            casts.setdefault(sid, {'rows': [], 'date': str(r.get(p_date) or '').strip() if p_date else ''})
            casts[sid]['rows'].append((num(r.get(p_depth)),
                                       num(r.get(p_temp)) if p_temp else None,
                                       num(r.get(p_do)) if p_do else None))
        print(f'  {len(casts)} of them have profile rows')

        for sid, meta in here.items():
            c = casts.get(sid)
            if not c:
                refusals.append((meta['slug'], y, 'site matched but the profile file has no rows for it'))
                continue
            th, th_note = thermocline_from(c['rows'])
            an, an_note = oxygen_from(c['rows'], ANOXIC_MGL)
            dp, dp_note = oxygen_from(c['rows'], DEPLETION_MGL)
            rec = out.setdefault(meta['slug'], {'slug': meta['slug'], 'visits': []})
            rec['visits'].append({
                'year': y, 'site_id': sid, 'nla_name': meta['nla_name'], 'state': meta['state'],
                'lat': meta['lat'], 'lon': meta['lon'], 'date': c['date'],
                'readings': len(c['rows']),
                'thermoclineFt': th, 'thermoclineNote': th_note,
                'anoxicBelowFt': an, 'anoxicNote': an_note,
                'depletionDepthFt': dp, 'depletionNote': dp_note,
                'source': si_url, 'profileSource': pr_url,
            })
            if th is None:
                refusals.append((meta['slug'], y, th_note))

    path = os.path.join(reg, OUT)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump({
            'generated': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'source': 'EPA National Aquatic Resource Surveys -- National Lakes Assessment',
            'note': 'Vertical temperature and dissolved-oxygen casts, which WQP surface grabs '
                    'cannot supply. A depth is emitted only where the cast supports it; every '
                    'refusal carries its reason. Personal use only, not for distribution or '
                    'resale; not for navigation.',
            'guards': {'minDepths': MIN_DEPTHS, 'minSpanM': MIN_SPAN_M,
                       'thermoclineGradientCPerM': THERMO_GRAD_C_PER_M,
                       'anoxicMgL': ANOXIC_MGL, 'depletionMgL': DEPLETION_MGL},
            'water_count': len(out),
            'waters': dict(sorted(out.items())),
        }, fh, indent=1, ensure_ascii=False)

    got = sum(1 for r in out.values() if any(v['thermoclineFt'] is not None for v in r['visits']))
    print(f'\n{len(out)} of our waters have an NLA cast -> {path}')
    print(f'  {got} of them yield a thermocline depth')
    if refusals:
        print(f'\n{len(refusals)} refusals, with the reason:')
        for slug, y, why in refusals[:12]:
            print(f'  {slug:<28} {y}  {why[:96]}')
    if unmatched:
        print(f'\n{len(unmatched)} NLA sites in our four states matched no boundary of ours '
              f'(they are lakes we do not carry):')
        for y, nm, st, lat, lon in unmatched[:8]:
            print(f'  {y}  {nm[:34]:<34} {st}  {lat:.5f},{lon:.5f}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
