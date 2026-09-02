#!/usr/bin/env python3
r"""test_sc_roster_reader.py -- SCDNR names the fish in prose, and sc_page() returned [].

    py .\scripts\test_sc_roster_reader.py

No network. The end-to-end half reads the saved pages under SC_Lakes/ and SKIPS with a non-zero
exit if that folder is absent, rather than printing SKIP and passing forever.

WHAT THIS GUARDS. `sc_page()` returned `'species': []` as a literal on all 26 SCDNR rows from the
day it was written. Ryan, 2026-09-02: *"there is 0 chance greenwood and secession are missing from
both the SC ramps feed species list or the SC lakes pages."* He was right -- Lake Secession's saved
page named six fish in sentences the reader walked straight past, and I had reported the water as
having none, which is a fact about our parser stated as a fact about SCDNR.

EVERY ASSERTION BELOW QUOTES A REAL SAVED PAGE. The last regex in this project written against a
sentence I typed rather than fetched -- the Randleman title rule -- passed its test and missed the
live document.

Personal use only, not for distribution or resale; not for navigation.
"""
import importlib.util, io, json, os, re, sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_UP1 = os.path.dirname(_HERE)
ROOT = _UP1 if os.path.isdir(os.path.join(_UP1, 'registry')) else os.path.dirname(_UP1)

FAILED = []
def check(name, got, want):
    if got == want:
        print('   ok   %s' % name)
    else:
        FAILED.append(name)
        print('   FAIL %s\n        got  %r\n        want %r' % (name, got, want))

_s = importlib.util.spec_from_file_location('b', os.path.join(_HERE, 'build_agency_lake_facts.py'))
B = importlib.util.module_from_spec(_s); _s.loader.exec_module(B)

VOCAB = set(B.nc_species_vocab(ROOT)) | set(B.group_term_vocab(ROOT))
names = lambda paras: [x['name'] for x in B.sc_species(paras, VOCAB)]

print('\nthe vocabulary comes out of the repo, not out of this file')
check('RESEARCH_SPECIES_CANON was readable', len(B.nc_species_vocab(ROOT)) > 40, True)
check('GROUP_TERM_MAP was readable', len(B.group_term_vocab(ROOT)) > 5, True)
check('and it knows the words SCDNR actually writes',
      sorted(t for t in ('bream', 'black bass', 'catfish', 'crappie') if t in VOCAB),
      ['black bass', 'bream', 'catfish', 'crappie'])

print('\nsc_complete() -- the elided head noun')
# Hartwell: "three species of black bass, striped and hybrid bass, black crappie, and bream"
check('the head comes from the NEXT part, not the last',
      B.sc_complete(['black bass', 'striped', 'hybrid bass', 'black crappie', 'bream'], VOCAB),
      ['black bass', 'striped bass', 'hybrid bass', 'black crappie', 'bream'])
# Jonesville: "largemouth bass, bluegill, shellcracker, and channel catfish"
check('a part that is already a fish is left alone',
      B.sc_complete(['largemouth bass', 'bluegill', 'shellcracker', 'channel catfish'], VOCAB),
      ['largemouth bass', 'bluegill', 'shellcracker', 'channel catfish'])
# Russell: "black bass (spotted and largemouth)"
check('a parenthetical gloss completes too',
      B.sc_complete(['spotted', 'largemouth bass'], VOCAB), ['spotted bass', 'largemouth bass'])

print('\nthe roster sentences, quoted from SC_Lakes/')
S = {
 'secession': ['Secession maintains an excellent fishery for black crappie and largemouth bass.'
               ' The lake also supports good fishing for catfish and bream (redear and bluegill).'
               ' Secession maintains the rare opportunity for a seasonal (spring) fishery for'
               ' white bass in the headwaters of the lake.'],
 'wateree':   ['Popular sport fish on Lake Wateree include black crappie, striped bass,'
               ' largemouth bass and catfish.'],
 'state':     ['Lake Ashwood is a 75-acre lake providing largemouth bass, bluegill,'
               ' shell-cracker, and catfish fishing.'],
 'murray':    ['This reservoir is probably best known for its largemouth bass and striped bass'
               ' fishery but it serves host to a number of other popular gamefish including'
               ' bluegill, redear sunfish, crappie and catfish.'],
 'jocassee':  ['The state record spotted bass, redeye bass, smallmouth bass, brown trout, and'
               ' rainbow trout were caught from Lake Jocassee.'],
 'marion':    ['Much of this large woody debris serves as excellent fish habitat for nearly all'
               ' fish species that inhabit the lake (especially crappie, bream, and catfish).'],
}
check('Secession -- the water Ryan said could not be empty',
      sorted(names(S['secession'])),
      ['black crappie', 'bluegill', 'bream', 'catfish', 'largemouth bass', 'redear', 'white bass'])
check('Wateree -- "Popular sport fish ... include"', sorted(names(S['wateree'])),
      ['black crappie', 'catfish', 'largemouth bass', 'striped bass'])
check('the state-lakes boilerplate, hyphen folded', sorted(names(S['state'])),
      ['bluegill', 'catfish', 'largemouth bass', 'shellcracker'])
check('Murray -- "serves host to ... including"', sorted(names(S['murray'])),
      ['bluegill', 'catfish', 'crappie', 'redear sunfish'])
check('Jocassee -- the state-record sentence', sorted(names(S['jocassee'])),
      ['brown trout', 'rainbow trout', 'redeye bass', 'smallmouth bass', 'spotted bass'])
check('Marion -- "habitat for ... (especially ...)"', sorted(names(S['marion'])),
      ['bream', 'catfish', 'crappie'])

print('\nwhat it must NOT take')
# Lake Thicketty's directions. A bare fish-word scan invents a trout stream out of a street.
check('a street name is not a fishery', names(['Take an immediate left onto Trout View Road.']), [])
check('an amenity list is not a roster',
      names(['The park is open daily providing a boat ramp, picnic area and fishing.']), [])
check('and with no vocabulary it emits for the Worker to judge',
      'boat ramp' in [n.lower() for n in
                      [x['name'] for x in B.sc_species(
                          ['The park is open daily providing a boat ramp, picnic area and'
                           ' fishing.'], ())]], True)

print('\nthe sentence is kept as the citation')
one = B.sc_species(S['wateree'], VOCAB)[0]
check('every name carries the sentence it came from', one['notes'], [S['wateree'][0]])

folder = os.path.join(ROOT, 'SC_Lakes')
if not os.path.isdir(folder):
    print('\nSKIP the end-to-end half -- no %s' % folder)
    print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                    else 'all checks passed'))
    sys.exit(2 if not FAILED else 1)

print('\nend to end, over every saved SCDNR page')
waters = total = 0
for f in sorted(os.listdir(folder)):
    if not f.endswith('.html'):
        continue
    blocks, raw = B.blocks_of(os.path.join(folder, f))
    page = B.sc_page(blocks, raw, VOCAB)
    if not page:
        continue
    if page['species']:
        waters += 1
        total += len(page['species'])
check('the reader no longer returns [] on every page', waters > 15, True)
check('and no page contributes an implausible pile', total < waters * 12, True)
print('        %d page(s) yield species, %d name(s) -- both were 0' % (waters, total))

print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                else 'all checks passed'))
sys.exit(1 if FAILED else 0)
