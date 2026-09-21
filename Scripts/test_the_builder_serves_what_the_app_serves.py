#!/usr/bin/env python3
"""The builder and the uploader must agree on which waters exist.

Personal use only, not for distribution or resale; not for navigation.

2026-09-21. `upload_garmin_to_r2.py` gates on `registry/lake_index.json` and says so in its own
help: "ONLY these slugs ship... See the gate below for why this is not optional."
`build_all_chartpacks.py` gated on nothing and took the whole registry -- 1,833 waters against the
354 the app offers. So every rebuild spent about six times what it needed to, on packs the
uploader would then refuse and the app could never load.

Ryan caught it mid-run: "NOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO dont rebuild packs we are never
going to serve in the app". And the history, which is why charted.json disagrees: "773 was the
number before i redrew lines to limit it... it was just getting too big and unwieldy and i was
never going to fish those waters... it honestly is still bigger than what i am realistically
going to fish but this number is something we can handle much easier."

So there are three counts and only one of them is live:

    registry/lake_index.json   354    what the app offers and the uploader ships
    charted.json shipped:true  773    the boundary before Ryan redrew it
    the registry                1,833    every water there is a boundary for

THE CHEAP ANSWER HAS TO BE THE DEFAULT. That is the whole assertion here: a wide build must be
asked for by name, the gate must refuse rather than fall back to wide when the index is missing,
and --only-lakes must bypass it or --jobs breaks -- every worker runs with an explicit slug list
the parent has already gated, and narrowing it twice would drop lakes silently.
"""
import os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, 'build_all_chartpacks.py'), encoding='utf-8').read()
UP  = open(os.path.join(HERE, 'upload_garmin_to_r2.py'), encoding='utf-8').read()

FAIL = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        FAIL.append(msg)


def main():
    print('--- the builder gates on the same file the uploader does ---')
    check("'lake_index.json'" in SRC,
          'build_all_chartpacks reads lake_index.json. Without it the default is 1,479 packs '
          'nothing can load')
    check('lake_index.json' in UP,
          'and the uploader still gates on the same file, or they are measuring different things')
    check("add_argument('--all-registry'" in SRC,
          'going wider takes --all-registry: a name nobody types by accident')

    print('\n--- the gate refuses rather than falling back to wide ---')
    m = re.search(r"if not a\.all_registry and not a\.only_lakes:(.*?)\n    tiles = ", SRC, re.S)
    check(bool(m), 'the gate runs before the tile list is derived, so the tiles follow the lakes')
    if m:
        check('sys.exit(' in m.group(1),
              'a missing lake_index.json EXITS. Falling back to "build everything" is the exact '
              'failure the gate exists to prevent, and it would look like a successful run')

    print('\n--- and --jobs is not narrowed twice ---')
    check('not a.only_lakes' in SRC,
          '--only-lakes bypasses the gate. Every --jobs worker runs with an explicit slug list '
          'the parent already gated; narrowing it again would drop lakes with no message')
    check("'--only-lakes', lf" in SRC,
          'the workers are still handed that explicit list')

    print('\n--- a long run can be watched ---')
    check("'-u'" in SRC,
          'workers run unbuffered. A log that only appears when the process exits cannot be '
          'told from a hang -- 30 minutes of a 0-byte file on 2026-09-21')
    check('py -u .\\\\build_all_chartpacks.py' in SRC,
          'and the usage line in the docstring carries -u, because a command in a docstring is '
          'a dependency')

    print('\n--- the machine, not a guess ---')
    check(re.search(r"add_argument\('--jobs', type=int, default=4", SRC) is not None,
          "--jobs defaults to 4. 6 drew \"slow and a little rough on my computer\" and 12 drew "
          '"not a good idea" on the extract, both from Ryan on this machine')

    print('\n%s  %d failure(s)' % ('FAILED' if FAIL else 'ALL PASS', len(FAIL)))
    for f in FAIL:
        print('   - ' + f)
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
