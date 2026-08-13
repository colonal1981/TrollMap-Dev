#!/usr/bin/env python3
"""Synthetic test for upload_boundaries_to_r2.py's manifest.

The uploader talks to wrangler and reads two hard-coded F:\\ paths, so nothing here touches
either. The constants are repointed at a temp tree and upload_file() is replaced with a
recorder, which leaves exactly the thing that changed under test: which files a run decides
to push, and what it writes down afterwards.

Personal use only, not for distribution or resale; not for navigation.
"""
import importlib.util, json, os, shutil, sys, tempfile, time
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
FAILURES = []


def check(cond, label):
    print(('  ok   ' if cond else '  FAIL ') + label)
    if not cond:
        FAILURES.append(label)


def load(tmp):
    """Fresh import each time, with the F:\\ constants repointed into tmp."""
    for m in ('upload_boundaries_to_r2',):
        sys.modules.pop(m, None)
    spec = importlib.util.spec_from_file_location(
        'upload_boundaries_to_r2', os.path.join(HERE, 'upload_boundaries_to_r2.py'))
    mod = importlib.util.module_from_spec(spec)
    sys.modules['upload_boundaries_to_r2'] = mod
    spec.loader.exec_module(mod)
    mod.BOUNDARIES_DIR = Path(tmp) / 'boundaries'
    mod.CHARTPACK_DIR = Path(tmp) / 'chartpack'
    mod.MANIFEST_FP = Path(tmp) / '_r2_boundaries_manifest.json'
    mod.ALIASES_JS = None
    return mod


def run(mod, argv, fail_slugs=()):
    """Call main() with argv, recording what upload_file was asked to send."""
    sent = []

    def fake_upload(slug, filepath, dry_run=False, gz=True):
        sent.append(slug)
        return slug not in fail_slugs

    mod.upload_file = fake_upload
    old = sys.argv
    sys.argv = ['upload_boundaries_to_r2.py'] + argv
    code = 0
    try:
        mod.main()
    except SystemExit as e:
        code = e.code or 0
    finally:
        sys.argv = old
    return sent, code


def build(tmp, slugs):
    b = Path(tmp) / 'boundaries'
    c = Path(tmp) / 'chartpack'
    b.mkdir(parents=True, exist_ok=True)
    c.mkdir(parents=True, exist_ok=True)
    for s in slugs:
        (b / (s + '.geojson')).write_text(
            json.dumps({'type': 'FeatureCollection', 'features': [], 'slug': s}), encoding='utf-8')
        (c / s).mkdir(exist_ok=True)
    # a boundary with no pack -- the app can never ask for it, so it is out of scope
    (b / 'orphan_no_pack.geojson').write_text('{"type":"FeatureCollection","features":[]}',
                                              encoding='utf-8')


def main():
    tmp = tempfile.mkdtemp()
    SL = ['lake_a', 'lake_b', 'lake_c']
    build(tmp, SL)
    mod = load(tmp)
    mf = mod.MANIFEST_FP

    print('\n--- a first run pushes everything in scope ---')
    sent, code = run(mod, [])
    check(code == 0, 'exit 0')
    check(sorted(sent) == SL, 'all three in-scope boundaries uploaded (%s)' % sorted(sent))
    check('orphan_no_pack' not in sent, 'a boundary with no chartpack is NOT uploaded')
    check(mf.exists(), 'the manifest was written')
    man = json.load(open(mf, encoding='utf-8'))
    check(sorted(man) == sorted('%s/boundary.geojson' % s for s in SL),
          'the manifest is keyed by the R2 key, not the slug')
    check(all({'size', 'mtime', 'gzip'} <= set(v) for v in man.values()),
          'each entry carries size, mtime and gzip')

    print('\n--- the second run pushes nothing ---')
    sent, code = run(mod, [])
    check(sent == [], 'nothing re-uploaded (%d sent)' % len(sent))
    check(code == 0, 'and it is not an error')

    print('\n--- change one file, and only that one goes ---')
    time.sleep(1.1)
    p = mod.BOUNDARIES_DIR / 'lake_b.geojson'
    p.write_text(json.dumps({'type': 'FeatureCollection', 'features': [1], 'slug': 'lake_b'}),
                 encoding='utf-8')
    sent, code = run(mod, [])
    check(sent == ['lake_b'], 'only the edited boundary uploaded (%s)' % sent)

    print('\n--- --force ignores the manifest ---')
    sent, code = run(mod, ['--force'])
    check(sorted(sent) == SL, 'all three pushed again (%s)' % sorted(sent))

    print('\n--- --dry-run never writes the manifest ---')
    time.sleep(1.1)
    (mod.BOUNDARIES_DIR / 'lake_c.geojson').write_text('{"type":"FeatureCollection","features":[2]}',
                                                       encoding='utf-8')
    before = mf.read_bytes()
    sent, code = run(mod, ['--dry-run'])
    check(sent == ['lake_c'], 'the dry run reports the one changed file (%s)' % sent)
    check(mf.read_bytes() == before, 'and the manifest on disk is untouched')
    sent, code = run(mod, [])
    check(sent == ['lake_c'], 'so a real run afterwards still has it to do (%s)' % sent)

    print('\n--- a FAILED upload does not enter the manifest ---')
    time.sleep(1.1)
    for s in SL:
        (mod.BOUNDARIES_DIR / (s + '.geojson')).write_text('{"type":"FeatureCollection","features":[3]}',
                                                           encoding='utf-8')
    sent, code = run(mod, [], fail_slugs=('lake_a',))
    check(sorted(sent) == SL, 'all three attempted')
    check(code == 1, 'a failure exits non-zero')
    sent, code = run(mod, [])
    check(sent == ['lake_a'], 'a bare re-run retries exactly the one that failed (%s)' % sent)

    print('\n--- flipping gzip re-uploads without --force ---')
    sent, code = run(mod, ['--no-gzip'])
    check(sorted(sent) == SL, 'raw upload re-pushes everything the manifest had as gzipped (%s)'
          % sorted(sent))
    sent, code = run(mod, ['--no-gzip'])
    check(sent == [], 'and the run after that is a no-op again')

    print('\n--- --lake honours the manifest, --force overrides it ---')
    sent, code = run(mod, ['--lake', 'lake_a', '--no-gzip'])
    check(sent == [], '--lake on an unchanged boundary sends nothing')
    sent, code = run(mod, ['--lake', 'lake_a', '--no-gzip', '--force'])
    check(sent == ['lake_a'], '--force sends it (%s)' % sent)
    sent, code = run(mod, ['--lake', 'nope_not_here'])
    check(code == 1, 'a slug with no boundary file is still a hard error, not a skip')

    print('\n--- an unreadable manifest warns and re-pushes, it does not crash ---')
    mf.write_text('{ this is not json', encoding='utf-8')
    sent, code = run(mod, ['--no-gzip'])
    check(sorted(sent) == SL, 'everything went back up (%s)' % sorted(sent))
    check(json.load(open(mf, encoding='utf-8')), 'and a valid manifest replaced the broken one')

    print('\n--- save_manifest is atomic ---')
    mod.save_manifest({'k': {'size': 1, 'mtime': 2, 'gzip': True}}, mf)
    check(not Path(str(mf) + '.tmp').exists(), 'no .tmp left behind')
    check(json.load(open(mf, encoding='utf-8'))['k']['size'] == 1, 'and the content is what was passed')

    print()
    if FAILURES:
        print('FAILED  %d failure(s)' % len(FAILURES))
        for f in FAILURES:
            print('   - %s' % f)
    else:
        print('ALL PASS  0 failure(s)')
    shutil.rmtree(tmp, ignore_errors=True)
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
