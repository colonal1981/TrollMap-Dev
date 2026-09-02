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

# ------------------------------------------------------------ GA DNR's identification page
GA = os.path.join(ROOT, B.GA_DIR, B.GA_PAGE)
if not os.path.exists(GA):
    print('\nSKIP GA DNR -- %s is not on the drive. Run fetch_agency_lake_pages.py --state GA --go'
          % os.path.join(B.GA_DIR, B.GA_PAGE))
else:
    print('\n%s' % os.path.join(B.GA_DIR, B.GA_PAGE))
    ga = {g['name']: g for g in B.read_ga_page(GA, canon)}
    check('the page carries about fifty fish', 40 < len(ga) < 60, True)

    # 19. THE PAGE FILES ITS FISH LIKE AN INDEX -- "Bass, Largemouth", "Trout, Brook". Swapping on
    #     the comma reads most of them and gets two wrong in a way no rule fixes: "Sunfish, Rock
    #     Bass" is a rock bass, not a "Rock Bass Sunfish". The forms are offered and the app's own
    #     vocabulary picks, which is a measurement rather than a guess about English.
    for want in ('Largemouth Bass', 'Smallmouth Bass', 'Spotted Bass', 'Redeye Bass', 'Shoal Bass',
                 'Black Crappie', 'Channel Catfish', 'Brook Trout', 'Chain Pickerel'):
        check('%s is read off the inverted heading' % want, want in ga, True)
    check('a fish whose tail IS the whole name is not inverted', 'Rock Bass' in ga, True)
    check('nor the shadow bass', 'Shadow Bass' in ga, True)
    check('and a name in the parentheses is offered too',
          canon.get(B.norm_species(next(n for n in ga if 'Hybrid' in n))), 'White Bass / Hybrid')
    check('a name with no comma is left alone', 'Walleye' in ga and 'Bowfin' in ga, True)

    # 20. THE FIELD THIS WHOLE REFACTOR WENT LOOKING FOR.
    contains("GA DNR's spawning temperature is in Habitat",
             ga['Largemouth Bass']['sections'].get('Habitat', ''),
             'Spawning activity begins when water reaches 63-68 degrees')
    check('and the binomial comes off the same block',
          ga['Largemouth Bass']['scientific'], 'Micropterus salmoides')

    # 21. NOT A FISH. The page's furniture carries <h2> too -- "Search :", "About Us",
    #     "Quick links", "Stay connected" -- and none of it has a labelled field.
    for junk in ('Search', 'About Us', 'Quick links', 'Stay connected', 'featured'):
        check('%s is not a species' % junk, junk in ga, False)

    # 22. A STUB IS A VALUE WITH NOTHING IN IT, NOT A SHORT ONE. Georgia's whole Range field for
    #     the largemouth is "Common throughout Georgia." -- 26 characters, a complete sentence,
    #     and the answer to whether the fish is in the state at all. A `len > 30` floor dropped it.
    check('a short complete sentence is kept',
          ga['Largemouth Bass']['sections'].get('Range'), 'Common throughout Georgia.')

    # 23. THE COLON IS ON BOTH SIDES OF THE </em>, depending on who typed the entry. Most read
    #     `<em>Habitat</em>: ...`, seven read `<em>Habitat: </em>...`. Demanding the first
    #     spelling dropped seven fish -- WALLEYE among them, which is the species this file was
    #     extended for. Georgia's is the only walleye spawning temperature we hold.
    check('the walleye survives the other spelling of the label', 'Walleye' in ga, True)
    contains('with the number it was fetched for', ga['Walleye']['sections'].get('Habitat', ''),
             'Spawns in spring when water reaches 45-50 degrees')

# ------------------------------------------------------ TWRA's Angler's Guide to Tennessee Fish
TN = os.path.join(ROOT, B.TN_GUIDE)
if not os.path.exists(TN):
    print('\nSKIP TWRA -- %s is not beside the root' % B.TN_GUIDE)
else:
    print('\n%s' % B.TN_GUIDE)
    tn = {g['name']: g for g in B.read_tn_guide(TN)}
    check('every species in the book gets an account', len(tn) > 80, True)

    # 14. THE NAME AND ITS BINOMIAL SHARE A BASELINE AND NOT A LINE BUCKET. The italic sits 0.6pt
    #     higher, so they arrive as two rows in the order (binomial, name) -- and a name that
    #     wraps leaves its LAST word on the binomial's row. Looking for "Name (Binomial)" on one
    #     line found 47 of 87 and missed largemouth, spotted, redeye and black crappie.
    for want in ('Largemouth Bass', 'Spotted Bass', 'Redeye Bass', 'Black Crappie', 'Walleye'):
        check('%s is read off a split heading' % want, want in tn, True)
    check('and a name that wraps is put back together', 'Yellow Bass' in tn, True)

    # 15. THE FURNITURE IS SEPARATED BY FONT, not by length or position. The photo credit is the
    #     body face italic at 6pt and the anatomy caption is bold italic at 8pt sitting at x=249
    #     IN THE MIDDLE OF A SENTENCE -- read by line, "jaw extends behind eye" lands between
    #     "prefer calm, warmer waters in" and "rivers, lakes, reservoirs".
    lmb = tn['Largemouth Bass']['sections'].get('Account', '')
    contains('the caption is not spliced into the prose', lmb, 'jaw extends behind eye', False)
    contains('nor the photo credit', lmb, 'Brian James', False)
    contains('and the sentence it interrupted is whole', lmb,
             'prefer calm, warmer waters in rivers, lakes, reservoirs')
    contains("TWRA's spawning temperature survives", lmb,
             'water temperatures approach 62-65')

    # 16. THE "OTHER NAMES" LIST WRAPS, and every line but the last ends in a comma. Consuming
    #     only the first line put "striped jack, stripe, yellow belly, barfish" at the head of the
    #     yellow bass account, where a reader takes it for a sentence.
    yb = tn['Yellow Bass']['sections'].get('Account', '')
    check('the account starts with the account', yb.startswith('Yellow bass are found in quiet'), True)

    # 16b. A CAPTION ON THE SAME BASELINE AS A SENTENCE MUST NOT COST THE SENTENCE. Rejecting the
    #      whole row because it is not uniformly the body face started black crappie at
    #      "sociated with aquatic vegetation" -- the words are filtered, not the row.
    contains('a line sharing its baseline with a caption keeps its words',
             tn['Black Crappie']['sections'].get('Account', ''),
             'Black crappie are found in quiet, warm waters')

    # 17. A HEADING WITH NO BINOMIAL STILL ENDS AN ACCOUNT. The Cherokee bass is a hybrid and has
    #     no species name of its own; "Temperate Bass Comparison Chart" is not a fish at all.
    #     Without them Yellow Bass ran on into the Cherokee bass and Redeye Bass into the crappie.
    contains('yellow bass stops before the cherokee bass', yb, 'cross between the female striped', False)
    contains('redeye bass stops before the crappie', tn['Redeye Bass']['sections'].get('Account',''),
             'white and black crappie', False)
    check('and a comparison chart is not a species', 'Temperate Bass Comparison Chart' in tn, False)
    # 18. THE HYBRID HAS A CROSS WHERE A BINOMIAL GOES: `(Morone saxatilis x M. chrysops)`.
    check('the Cherokee bass is read off its cross', 'Cherokee Bass' in tn, True)
    check('and the app knows it is the striped x white hybrid',
          canon.get(B.norm_species('Cherokee Bass')), 'White Bass / Hybrid')

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
