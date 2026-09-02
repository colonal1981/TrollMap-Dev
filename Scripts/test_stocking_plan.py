#!/usr/bin/env python3
r"""test_stocking_plan.py -- the NC WRC warmwater stocking spreadsheets.

    py .\scripts\test_stocking_plan.py

Reads the real CSVs beside the pipeline root and SKIPS if they are not there. No network: every
check below is pure, which is the point -- the crawl in build_nc_species_by_lake.py needs
ncpaws.org and this half does not.

Personal use only, not for distribution or resale; not for navigation.
"""
import io, json, os, sys, importlib.util
_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(_HERE)
_s = importlib.util.spec_from_file_location('bns', os.path.join(_HERE, 'build_nc_species_by_lake.py'))
B = importlib.util.module_from_spec(_s); _s.loader.exec_module(B)

import glob as _g
if not _g.glob(os.path.join(ROOT, B.STOCKING_GLOB)) or not _g.glob(os.path.join(ROOT, B.SUMMARY_GLOB)):
    print('SKIP -- no %s / %s beside the root' % (B.STOCKING_GLOB, B.SUMMARY_GLOB))
    sys.exit(0)

FAILED = []
def check(name, got, want):
    if got == want:
        print('   ok   %s' % name)
    else:
        FAILED.append(name)
        print('   FAIL %s\n        got  %r\n        want %r' % (name, got, want))

plan, legend, unsettled, fname = B.read_stocking_plan(ROOT)

# 1. THE LEGEND IS DERIVED. The detail file writes `BB`, `WY`, `MK` and prints no legend anywhere.
#    Summing the detail by (code, size) and matching each total against the summary's
#    (species, size) settles every code -- and settles it by ARITHMETIC, so it also proves the
#    extraction: every per-water number adds up to the agency's own district totals.
check('every species code is settled by the summary totals', unsettled, [])
check('and all eight are named', sorted(legend), ['BB', 'BG', 'CC', 'LMB', 'MK', 'SB', 'WC', 'WY'])
check('BB is the bodie bass, not the bluegill', legend.get('BB'), 'Bodie Bass')
check('WY is the walleye', legend.get('WY'), 'Walleye')
check('MK is the muskellunge', legend.get('MK'), 'Muskellunge')

# 2. THE ROWS SURVIVE THE READ. cp1252, because a directions cell carries a Windows right quote;
#    utf-8 throws on byte 0x92 at position 733 and takes the whole file with it.
check('the detail file is read whole', len(plan) > 100, True)
check('every row carries a count', all(r['number'] > 0 for r in plan), True)
check('and the year comes off the filename', {r['year'] for r in plan}, {'2026'})

# 3. THE TOTALS. Summing what we kept against the summary is the end-to-end check.
per = {}
for r in plan:
    per[(r['species'], r['size'])] = per.get((r['species'], r['size']), 0) + r['number']
check('bodie bass at 1-2 in. total 561,000 as the summary says', per.get(('Bodie Bass', '1-2"')), 561000)
check('striped bass at 1-2 in. total 1,134,500', per.get(('Striped Bass', '1-2"')), 1134500)
check('walleye at 1-2 in. total 333,000', per.get(('Walleye', '1-2"')), 333000)

# 4. THE BINDING, against the same NC-only maps main() builds.
idx = json.load(io.open(os.path.join(ROOT, 'registry', 'lake_index.json'), encoding='utf-8'))
nc = {s: r for s, r in idx.items() if 'NC' in str(r.get('state') or '').upper()}
by_name, by_bare = {}, {}
for slug, rec in nc.items():
    for n in B.row_names(rec):
        by_name.setdefault(B.norm(n), set()).add(slug)
        by_bare.setdefault(B.norm_bare(n), set()).add(slug)
bound = {}
for r in plan:
    slug = B.bind_stocking(r['name'], by_name, by_bare)
    if slug:
        bound.setdefault(slug, []).append(r)

check('the big waters bind', all(s in bound for s in
      ('lake_norman', 'lake_james', 'fontana_lake', 'hyco_lake', 'badin_lake',
       'b_everett_jordan_lake', 'high_rock_lake')), True)
check('Lake Norman gets its 325,000 bodie bass',
      [r['number'] for r in bound['lake_norman'] if r['species'] == 'Bodie Bass'], [325000])
check('Lake James gets its 180,000 walleye',
      [r['number'] for r in bound['lake_james'] if r['species'] == 'Walleye'], [180000])

# 5. THE ONE THAT MUST NOT BIND. The registry files `Lake Louise` as a name HARTWELL LAKE answers
#    to, and the CSV's Lake Louise is in Buncombe County, NC. A resolver that reaches every state
#    accepts it "across the state line" -- Hartwell spans one -- and writes an NC stocking onto a
#    South Carolina reservoir. NCWRC cannot stock a water North Carolina does not hold.
check('Lake Louise, Buncombe Co does not become Hartwell',
      B.bind_stocking('Lake Louise', by_name, by_bare), None)
check('and no bound water is outside North Carolina',
      [s for s in bound if 'NC' not in str((idx.get(s) or {}).get('state') or '').upper()], [])

# 7. THE API SAYS "SPOTTED BASS" AND NC WRC SAYS THAT IS THE WRONG FISH.
#
#    The fishing-areas API answers `commonName` per location and never once says Alabama Bass --
#    52 locations say Spotted Bass. NC WRC's own page says why, and the sentence IS the rule:
#    "True Spotted Bass are native to the mountain drainages of southwestern North Carolina and
#    have been introduced into the Cape Fear River basin, W. Kerr Scott Reservoir, and the Yadkin
#    River above High Rock Lake. Everyplace else in the state, any fish anglers have been catching
#    that looks like a Spotted Bass is actually an Alabama Bass."
NCD = os.path.join(ROOT, 'NC_Lakes')
rule = B.alabama_rule(NCD)
if not rule:
    print('\nSKIP Alabama Bass -- the rule page is not saved under NC_Lakes')
else:
    print('\nNC WRC Alabama Bass rule')
    check('the rule is READ off the page, not retyped here', bool(rule[0]), True)
    check('and its three introduced exceptions are parsed out of the sentence', rule[1],
          ['Cape Fear River basin', 'W. Kerr Scott Reservoir',
           'Yadkin River above High Rock Lake'])

    waters = B.alabama_waters(NCD)
    check('the impacts document names its waters by basin', len(waters) >= 18, True)
    check('and files the southwest under its own basin headings',
          sorted({b for _n, (b, _s) in waters.items()
                  if b in B.ALB_SW_BASINS}), ['Hiwassee', 'Little Tennessee'])

    # AN INITIAL IS NOT A SENTENCE END. Trimming the heading at any ". " turned
    # "W. Kerr Scott Reservoir" into " Kerr Scott Reservoir", which matches no registry name --
    # and that water is the one document entry that is ALSO one of the three exceptions.
    check('the reservoir with an initial in its name survives the heading trim',
          'W. Kerr Scott Reservoir' in waters, True)
    check('and a heading that starts mid-sentence is trimmed', 'Dan River' in waters, True)

    lakes2 = json.loads(json.dumps(
        json.load(io.open(os.path.join(ROOT, 'registry', 'nc_species_by_lake.json'),
                          encoding='utf-8'))['lakes']))
    rep = B.apply_alabama(lakes2, by_name, by_bare, NCD, idx)

    # CORRECTED: outside true-Spotted-Bass country AND independently named by the impacts
    # document. Two documents, or nothing is changed.
    check('Lake Norman\'s Spotted Bass becomes Alabama Bass',
          ('Alabama Bass' in lakes2['lake_norman']['predatorSpecies']
           and 'Spotted Bass' not in lakes2['lake_norman']['predatorSpecies']), True)
    check('and Moss Lake\'s does too',
          ('Alabama Bass' in lakes2['john_h_moss_lake']['predatorSpecies']
           and 'Spotted Bass' not in lakes2['john_h_moss_lake']['predatorSpecies']), True)

    # KEPT: W. Kerr Scott is named in the rule as true Spotted Bass country AND in the impacts
    # document as having Alabama Bass introduced. Both fish, which is what NC WRC describes.
    ks = lakes2['w_kerr_scott_reservoir']['predatorSpecies']
    check('Kerr Scott keeps its Spotted Bass', 'Spotted Bass' in ks, True)
    check('and gains Alabama Bass beside it', 'Alabama Bass' in ks, True)

    # KEPT: a southwestern mountain drainage, by the document's own basin heading.
    check('Hiwassee keeps its Spotted Bass',
          'Spotted Bass' in lakes2['hiwassee_lake']['predatorSpecies'], True)
    # KEPT: the Cape Fear basin, named in the rule.
    check('the Cape Fear keeps its Spotted Bass',
          'Spotted Bass' in lakes2['cape_fear_river']['predatorSpecies'], True)
    check('and gains no Alabama Bass, being named by neither document',
          'Alabama Bass' in lakes2['cape_fear_river']['predatorSpecies'], False)

    check('nothing is corrected without both documents agreeing', len(rep['corrected']), 2)
    check('the waters named but not shipped are reported, not forced',
          sorted(rep['unbound']),
          ['Apalachia Reservoir', 'Chatuge Reservoir', 'Kerr Reservoir', 'Lake Gaston'])

# 6. THE COMMUNITY PONDS ARE NOT FORCED. Most of the file is city park ponds.
check('the ponds we do not ship are left alone', len(bound) < len({r['name'] for r in plan}), True)
print('\n%d row(s) from %s -> %d water(s)' % (len(plan), fname, len(bound)))

if FAILED:
    print('\n%d FAILED: %s' % (len(FAILED), '; '.join(FAILED)))
    sys.exit(1)
print('all checks passed')
