#!/usr/bin/env python3
"""Synthetic end-to-end test for bind_operator_lakes.py.

Personal use only, not for distribution or resale; not for navigation.

The three geometry rules already had their reasoning written into the script. What is new and
untested is the BROOKFIELD branch, and the thing it must never do is invent a facility URL.
safewaters.com publishes one page per lake and links to none of its siblings, so the only
honest source for "where does Chilhowee live" is Chilhowee's own page. Every assertion below
about brookfield is really the same assertion: the URL came out of the file.
"""
import json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, 'bind_operator_lakes.py')

FAIL = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        FAIL.append(msg)


def facility_page(name, slug, host='www.safewaters.com'):
    return (
        '<!DOCTYPE html><html><head>'
        '<title>%s - Safe Waters by Brookfield Renewable N.A.</title>'
        '<link rel="canonical" href="https://%s/facility/%s/" />'
        '<meta property="og:url" content="https://%s/facility/%s/" />'
        '</head><body><h1>%s</h1>'
        '<div class="reading">-1.29 ft</div></body></html>'
    ) % (name, host, slug, host, slug, name)


def view_source(html):
    """What Chrome writes when you Ctrl+U then Ctrl+S: the real markup wrapped in a
    line-number table with every tag escaped. bind_operator_lakes unwraps it."""
    esc = html.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    return ('<table><tr><td class="line-number">1</td>'
            '<td class="line-content">%s</td></tr></table>' % esc)


def southernco_page(rows):
    tr = ''.join(
        '<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>' % (n, '', '', e, f)
        for n, e, f in rows)
    return ('<html><body><table id="MainContent_LakeGrid">'
            '<tr><th>Lake</th><th>Gen</th><th>Rain</th><th>Current</th><th>Full</th></tr>'
            '%s</table></body></html>' % tr)


def row(name, lon, lat, acres, legacy=None):
    return {'name': name, 'display_name': name, 'legacy_display_names': legacy or [],
            'centroid': [lon, lat], 'area_acres': acres}


def run(reg, src, write=False):
    cmd = [sys.executable, SCRIPT, '--registry', reg, '--pagesrc', src]
    if write:
        cmd.append('--write')
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.stdout + r.stderr


def main():
    tmp = tempfile.mkdtemp()
    reg = os.path.join(tmp, 'registry')
    src = os.path.join(tmp, 'pagesrc')
    os.makedirs(reg)
    os.makedirs(src)

    idx = {
        # the real four, at their real centroids
        'santeetlah_lake':  row('Santeetlah Lake', -83.857847, 35.346358, 2638.1),
        'chilhowee_lake':   row('Chilhowee Lake', -84.014940, 35.524368, 1680.4),
        'calderwood_lake':  row('Calderwood Lake', -83.958779, 35.475092, 555.6),
        'cheoah_lake':      row('Cheoah Lake', -83.911309, 35.464508, 1198.3),
        # the Russell pair at their real centroids, which is where distance alone gets it
        # wrong: the 88-acre pond is NEARER the cluster than the 24,608-acre reservoir.
        'richard_b_russell_lake': row('Richard B Russell Lake', -82.701573, 34.190961, 24608,
                                      ['Lake Russell, SC/GA']),
        'lake_russell':     row('Lake Russell', -83.492799, 34.491370, 88, ['Lake Russell, GA']),
        # two unambiguous rows to anchor the operator cluster on
        'hartwell_lake':    row('Hartwell Lake', -82.914651, 34.521827, 54071),
        'lake_sinclair':    row('Lake Sinclair', -83.267332, 33.244963, 13173),
        # a name no feed will mention
        'lake_untouched':   row('Lake Untouched', -80.00, 34.00, 500),
    }
    json.dump(idx, open(os.path.join(reg, 'lake_index.json'), 'w', encoding='utf-8'))
    json.dump({'_note': 'test', 'bindings': {
        'richard_b_russell_lake': {'slug': 'richard_b_russell_lake', 'usace': {'project': 'Russell'}},
        'lake_untouched': {'slug': 'lake_untouched', 'pool': {'site': '02000000'}},
    }}, open(os.path.join(reg, 'water_bindings.json'), 'w', encoding='utf-8'))

    # ── 1. one facility page, and the URL is the page's own ──────────────────────────────
    open(os.path.join(src, 'brookfield_santeetlah.html'), 'w', encoding='utf-8').write(
        view_source(facility_page('Santeetlah', 'santeetlah')))
    out = run(reg, src)
    check('Santeetlah' in out and 'santeetlah_lake' in out,
          'a saved facility page binds its lake')

    # ── 2. the same facility saved twice is still one facility ───────────────────────────
    open(os.path.join(src, '_raw_brookfield_santeetlah.html'), 'w', encoding='utf-8').write(
        facility_page('Santeetlah', 'santeetlah'))
    out = run(reg, src)
    check('brookfield  (1 rows read' in out,
          'a view-source save and its unwrapped twin count as ONE facility')

    # ── 3. a second page binds with no code change ───────────────────────────────────────
    open(os.path.join(src, 'brookfield_chilhowee.html'), 'w', encoding='utf-8').write(
        facility_page('Chilhowee', 'chilhowee'))
    out = run(reg, src)
    check('brookfield  (2 rows read' in out and 'chilhowee_lake' in out,
          'saving another facility page binds it -- no table to extend')

    # ── 4. the URL is read, never composed ───────────────────────────────────────────────
    open(os.path.join(src, 'brookfield_calderwood.html'), 'w', encoding='utf-8').write(
        facility_page('Calderwood', 'calderwood-tapoco', host='safewaters.com'))
    out = run(reg, src, write=True)
    b = json.load(open(os.path.join(reg, 'water_bindings.json'), encoding='utf-8'))['bindings']
    got = (b.get('calderwood_lake') or {}).get('operator') or {}
    check(got.get('url') == 'https://safewaters.com/facility/calderwood-tapoco/',
          'the recorded URL is the page\'s canonical, not <name> lowercased (%s)' % got.get('url'))
    check(got.get('operator') == 'brookfield' and got.get('feed_name') == 'Calderwood',
          'operator and feed_name are recorded -- the Worker returns null without both')

    # ── 5. a page that is not a facility page binds nothing ──────────────────────────────
    open(os.path.join(src, 'brookfield_list.html'), 'w', encoding='utf-8').write(
        '<html><head><title>Little Tennessee - Safe Waters</title>'
        '<link rel="canonical" href="https://safewaters.com/list/north-carolina/little-tennessee/" />'
        '</head><body><h1>Cheoah</h1></body></html>')
    out = run(reg, src)
    check('cheoah_lake' not in out,
          'a list page naming a lake in its <h1> is NOT a facility binding')

    # ── 6. --write leaves every other binding alone ──────────────────────────────────────
    check((b.get('richard_b_russell_lake') or {}).get('usace', {}).get('project') == 'Russell'
          and (b.get('lake_untouched') or {}).get('pool', {}).get('site') == '02000000',
          '--write adds `operator` and clobbers nothing else')
    check(not (b.get('lake_untouched') or {}).get('operator'),
          'a lake no feed names gets no operator')

    # ── 7. the dam rule still decides Russell ────────────────────────────────────────────
    open(os.path.join(src, 'southernco.html'), 'w', encoding='utf-8').write(
        southernco_page([('Hartwell', '660.0', '660'), ('Sinclair', '340.0', '340'),
                         ('Russell', '475.0', '475'), ('Nowhere Lake', '100.0', '100')]))
    out = run(reg, src)
    check('-> richard_b_russell_lake' in out and '-> lake_russell ' not in out,
          'Russell still resolves to the reservoir with the dam binding, not the nearer pond')
    check('Nowhere Lake' not in out, 'a feed row matching no registry lake is skipped silently')

    # ── 8. an operator with no saved page says so and does not crash ─────────────────────
    check('cube' in out and 'SKIP' in out, 'a missing operator page is a SKIP line, not a stack trace')

    shutil.rmtree(tmp, ignore_errors=True)
    print('\n%s  %d failure(s)' % ('FAILED' if FAIL else 'ALL PASS', len(FAIL)))
    for f in FAIL:
        print('   - ' + f)
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
