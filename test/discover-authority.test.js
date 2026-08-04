// authorityForUrl -- the domain-trust ladder shared by the Grok and Wikipedia citation paths.
//
// This file exists for one line of it. Both call sites used to carry their own copy of the
// ladder ending in `} catch {}`, with `authority` initialised to '' rather than 'Web'. The
// filter downstream reads:
//
//     if (authority === 'Web') { skip as low-value; continue; }
//
// so a URL that `new URL()` could not parse left authority at '' , failed that equality, and
// was seeded as a high-value source. The single worst input was the only one guaranteed to
// get through. These tests pin the fix from both ends: the ladder still classifies real
// agency domains, and garbage still lands on 'Web'.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { authorityForUrl } from '../Worker/research/discover.js';

describe('authorityForUrl: agency domains keep their label', () => {
  const cases = [
    ['https://www.sad.usace.army.mil/Portals/60/docs/lake.pdf', 'USACE'],
    ['https://nepis.epa.gov/Exe/ZyPDF.cgi?Dockey=P100ABCD.txt', 'EPA'],
    ['https://waterdata.usgs.gov/nwis/uv?site_no=02169500', 'USGS'],
    ['https://www.osti.gov/biblio/123456', 'Academic'],
    ['https://tidesandcurrents.noaa.gov/stationhome.html?id=8665530', 'Academic'],
    ['https://www.dnr.sc.gov/fish/survey/2024.pdf', 'SCDNR'],
    ['https://www.ncwildlife.gov/fishing/report', 'NCWRC'],
    ['https://georgiawildlife.com/fishing/lakes', 'GADNR'],
    ['https://www.tn.gov/twra/fishing.html', 'TWRA'],
    ['https://lakelevels.duke-energy.com/', 'Duke Energy'],
    ['https://elibrary.ferc.gov/eLibrary/doc', 'FERC'],
    ['https://www.santeecooper.com/lakes/', 'Santee Cooper'],
    ['https://seafwa.org/journal/2019/paper', 'Academic'],
    ['https://www.tva.com/environment/lake-levels', 'TVA'],
    ['https://southcarolinaparks.com/dreher-island', 'SC State'],
  ];
  for (const [url, expected] of cases) {
    test(`${expected} <- ${new URL(url).hostname}`, () => {
      assert.equal(authorityForUrl(url, 'murray'), expected);
    });
  }
});

describe('authorityForUrl: .edu only counts when the URL names the lake', () => {
  test('a university page about the lake is Academic', () => {
    assert.equal(authorityForUrl('https://cofc.edu/reports/murray-survey', 'murray'), 'Academic');
  });
  test('an unrelated university page is not', () => {
    // Otherwise every .edu on the internet outranks a fishing guide.
    assert.equal(authorityForUrl('https://cofc.edu/admissions', 'murray'), 'Web');
  });
});

describe('authorityForUrl: an unparseable URL is Web, not empty', () => {
  // The regression. Each of these throws inside `new URL()`.
  const junk = [
    ['a bare path', '/reports/lake.pdf'],
    ['a scheme-relative URL', '//example.com/x'],
    ['no scheme at all', 'dnr.sc.gov/fish/survey.pdf'],
    ['empty string', ''],
    ['whitespace', '   '],
    ['not a URL in any sense', 'see attached'],
    ['null', null],
    ['undefined', undefined],
  ];
  for (const [label, url] of junk) {
    test(`${label} -> 'Web'`, () => {
      const got = authorityForUrl(url, 'murray');
      assert.equal(got, 'Web');
      // The property that actually mattered: the caller's `authority === 'Web'` test has to
      // fire. An empty string, null or undefined all silently fail that comparison.
      assert.equal(got === 'Web', true, 'the low-value filter must recognise this value');
    });
  }
});

describe('authorityForUrl: the ladder is order-sensitive where it overlaps', () => {
  test('nepis.epa.gov is EPA, not caught by a later rule', () => {
    assert.equal(authorityForUrl('https://nepis.epa.gov/x', 'murray'), 'EPA');
  });
  test('a .gov that matches nothing specific falls to Web', () => {
    // `.gov` alone is not authority here -- the scoring pass grants a bonus for it, but the
    // citation filter wants a named agency.
    assert.equal(authorityForUrl('https://www.whitehouse.gov/', 'murray'), 'Web');
  });
});

describe('both citation paths now share one ladder', () => {
  test('discover.js declares the citation ladder exactly once', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../Worker/research/discover.js', import.meta.url), 'utf8');

    // Counting the domain alone is too blunt -- it also appears in the scoring pass's
    // `.gov$|usace...` bonus regex, which is not a ladder. Count the two ladder FORMS
    // instead. `return 'USACE'` is authorityForUrl; `authority = 'USACE'` is the
    // search-results ladder, which stays separate on purpose because it carries
    // 'Fishing Guide', 'Grokipedia' and the state dnrName -- labels that are useful for
    // ranking search hits but must not let a blog through the citation filter.
    const returnsForm = (src.match(/return 'USACE'/g) || []).length;
    const assignsForm = (src.match(/authority = 'USACE'/g) || []).length;

    assert.equal(returnsForm, 1, 'authorityForUrl should be the only function returning USACE');
    assert.equal(assignsForm, 1,
      'a second copy of the citation ladder has reappeared -- call authorityForUrl instead');
  });
});
