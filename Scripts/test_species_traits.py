#!/usr/bin/env python3
r"""test_species_traits.py -- the two pdf readers in build_species_traits.py.

    py .\scripts\test_species_traits.py

Reads the real documents -- FreshwaterFishPocketGuide.pdf beside the pipeline root and the
species profiles under NC_Lakes\ -- and SKIPS whichever is not on the drive. Neither belongs in
the repo: the guide is 50 MB and NC_Lakes is 375 MB of state pdfs.

Each check below is a bug that was in a reader and is named by what it did wrong. Every one of
them was found by reading the extracted text, not by reading the code.

Personal use only, not for distribution or resale; not for navigation.
"""
import os, re, sys
_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(_HERE)
sys.path.insert(0, _HERE)
import build_species_traits as B

FAILED = []


def check(name, got, want):
    if got == want:
        print('   ok   %s' % name)
    else:
        FAILED.append(name)
        print('   FAIL %s\n        got  %r\n        want %r' % (name, got, want))


def contains(name, hay, needle, want=True):
    check(name, (needle in hay), want)


# ------------------------------------------------------------------ the app's own vocabulary
canon = B.species_vocab(ROOT)
check('the species vocabulary is read out of facts-util.js, not retyped here', len(canon) > 30, True)
check('and the lookup normalises the way the app does -- the guide prints a comma the table has '
      'no room for',
      canon.get(B.norm_species('Striped Bass X White Bass, Hybrid')), 'White Bass / Hybrid')
check('SCDNR prints the short name for the shellcracker', canon.get(B.norm_species('Redear')),
      'Redear Sunfish (Shellcracker)')
check('and for the redbreast', canon.get(B.norm_species('Redbreast')), 'Redbreast Sunfish')

# ---------------------------------------------------------------------- SCDNR's pocket guide
GUIDE = os.path.join(ROOT, B.SC_GUIDE)
if not os.path.exists(GUIDE):
    print('SKIP SCDNR -- %s is not beside the root' % B.SC_GUIDE)
else:
    import pdfplumber
    print('\n%s' % B.SC_GUIDE)
    with pdfplumber.open(GUIDE) as pdf:
        # 1. THE OVERPRINT. Page 27 draws its title twice at identical coordinates and the two
        #    copies interleave character by character: "GGRREEEENN SSUUNNFFIISSHH".
        name, sub = B.sc_title(pdf.pages[26])
        check('the twice-drawn title is read once', name, 'Green Sunfish')
        check('and its binomial comes off the same page', sub, 'Lepomis cyanellus')

        # 2. THE TITLE PAGE IS NOT COLUMNAR. Four words either side of an illustration are not a
        #    gutter; cutting there split the name into "SMALLMOUTH" and "BASS".
        check('a two-word name survives the page it is printed on', B.sc_title(pdf.pages[8])[0],
              'Smallmouth Bass')
        # 3. And a name that wraps to two lines is still one name.
        check('so does a name that wraps', B.sc_title(pdf.pages[84])[0], 'Eastern Mosquitofish')
        # 4. THE HYBRID HAS NO BINOMIAL. Looking for one missed the page entirely.
        check('the hybrid spread is titled off its biggest type, not off a latin name',
              B.sc_title(pdf.pages[36])[0], 'Striped Bass X White Bass, Hybrid')

        # 5. THE COLUMNS. Read line by line, the left column is Description and the right is
        #    Spawning, so the text came out "The upper jaw extends back past the rear Spawning:
        #    Spawning usually begins when water". Any number quoted out of that is on the wrong
        #    sentence.
        bluegill = B.sc_sections('\n'.join(t for t, _, _, _ in B.page_rows(pdf.pages[15])))
        check('all ten SCDNR labels come off one page', len(bluegill), 10)
        contains('Description is Description', bluegill['Description'],
                 'laterally compressed')
        contains('and stops where Range begins', bluegill['Description'], 'Spawning', False)
        # 6. A VALUE PUSHED INTO THE SECOND COLUMN CAME OUT AT THE END OF THE PAGE. "Average
        #    Size:" was empty and "3-8 ounces." was orphaned three sections later.
        check('a value set beside its label stays with it', bluegill['Average Size'], '3-8 ounces.')
        contains('and so does a paragraph whose first line is', bluegill['Miscellaneous'],
                 'Just like largemouth bass, bluegills are one of the most common')

        # 7. THE LIGATURES. The guide sets fi/fl/ff as their own text run at zero advance, so
        #    every one of them arrived as a broken word: "sunfi sh", "diff erent", "off spring".
        contains('no fi ligature is left split', bluegill['Preferred Habitat'], 'fi ', False)
        contains('the word is whole', bluegill['Spawning'], 'different bluegill nests')
        # 8. AND THE WINDOW THAT JOINS THEM MUST NOT SWALLOW A TIGHT SPACE.
        lmb = B.sc_sections('\n'.join(t for t, _, _, _ in B.page_rows(pdf.pages[7])))
        contains('a real word space survives', lmb['Preferred Habitat'], 'slow moving streams')
        contains('the state\'s spawning temperature is quotable', lmb['Spawning'],
                 'water temperatures range between 65-75')

# ------------------------------------------------------------------ NC WRC's Wildlife Profiles
NC = os.path.join(ROOT, B.NC_DIR)
if not os.path.isdir(NC) or not os.listdir(NC):
    print('\nSKIP NCWRC -- no NC_Lakes on the drive. Run fetch_agency_lake_pages.py --state NC --go')
else:
    print('\n%s' % os.path.join(B.NC_DIR, B.NC_PROFILE))

    def profile(fn):
        p = os.path.join(NC, fn)
        return B.read_nc_profile(p) if os.path.exists(p) else None

    # 9. THE RUNNING HEADER READ AS A HEADING and cut the section in half: bluegill's habitat
    #    text was coming out under a heading called "Bluegill", 815 characters instead of 2,029.
    g = profile('3595_bluegill-species-profile.pdf')
    if g:
        hh = g['sections'].get('Habitat and Habits', '')
        check('the habitat section is not cut at the page break', len(hh) > 1800, True)
        contains('it starts where NCWRC starts it', hh, 'Bluegills prefer protected areas')
        contains('and runs to the end of the page after', hh, 'docks, weedbeds or bridges')
        # 10. THE MASTHEAD LANDED MID-SENTENCE on the page it continues onto.
        contains('the masthead is not spliced into the prose', hh, 'Wildlife Profiles', False)
        contains('the sentence it interrupted is whole', hh,
                 'tend to form nesting colonies')
        check('and NCWRC\'s two spellings are one section', 'Habitats & Habits' in g['sections'],
              False)

    # 11. THE SHEET WITH NO HABITAT HEADING. NCWRC printed the walleye's habitat and spawning
    #     prose under "History and Status" and gave it no habitat heading at all.
    g = profile('3459_walleye-species-profile.pdf')
    if g:
        hs = g['sections'].get('History and Status', '')
        contains('the walleye sheet still yields its spawning paragraph', hs,
                 'begins in late February as water temperatures reach 42 degrees')
        contains('and its depth band', hs, 'depths of 2 to 4 ft.')
        contains('a word broken across a line comes back whole', hs, 'boulders or bedrock')

    # 12. TWO ZONES, TWO COLUMN GEOMETRIES. One vertical cut for the whole page put
    #     "Classification / Class: Osteichthyes" in the middle of the sentence about anadromy.
    g = profile('3590_american-shad-species-profile.pdf')
    if g:
        hh = g['sections'].get('Habitat and Habits', '')
        contains('the sidebar is not spliced into the body', hh, 'Classification', False)
        contains('the sentence it interrupted is whole', hh,
                 'spend most of their life in saltwater but return to spawn')

    # 13. A SCANNED SHEET IS REPORTED, NOT SILENTLY EMPTY. NCWRC's striped bass profile has no
    #     text layer at all -- three pages of images.
    g = profile('3262_striped-bass-species-profile.pdf')
    if g:
        check('the scanned sheet says why it is empty', g['sections'], {})
        contains('and says it in words', g.get('why') or '', 'scan')

print()
if FAILED:
    print('%d FAILED: %s' % (len(FAILED), '; '.join(FAILED)))
    sys.exit(1)
print('all checks passed')
