import { readFileSync } from 'node:fs';
import { describe, it, expect } from './expect-shim.mjs';
import { sanitizeLakeId, researchStorageId, researchStorageIdCandidates, legacyStorageName,
         researchedNames, RESEARCH_CANONICAL_IDS }
  from '../js/data/research-ids.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ONE COPY OF A RULE, AND THE TEST THAT KEEPS IT ONE
//
// `js/data/research-ids.js` mirrored `Worker/research/keys.js` until 2026-09-25, so the research
// picker could answer "which of these do I not have a profile for" without fetching all sixty
// profiles to read their names back out. keys.js imports it now.
//
// Drift here would not throw. It reports a researched lake as unresearched, which sends Ryan to
// re-run a pipeline on a water that is already done, or — worse in the other direction — hides a
// lake from the picker that he still needs. So the Worker's own source is READ, not paraphrased.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// `Worker`, WITH THE CAPITAL, AND THAT IS NOT A STYLE POINT. This read `../worker/research/keys.js`
// and passed for months on Ryan's machine, because Windows does not care about the case of a path.
// The directory is `Worker`. A GitHub runner is Linux and does care, so this threw ENOENT the first
// time the suite ran anywhere but his desk -- found 2026-09-18 while proving out the deploy gate,
// which is the exact class of defect a gate exists to catch and the reason it goes in.
const WORKER = readFileSync(new URL('../Worker/research/keys.js', import.meta.url), 'utf8');

describe('the client mirror agrees with the Worker', () => {
  // 'sanitizeLakeId does what the Worker does, character for character' stood here, lifting the
  // Worker's body and comparing. On 2026-09-25 the Worker stopped carrying one: keys.js imports
  // the storage-id rule from research-ids.js. The guard is the one below it now -- one copy.
  it('THE STORAGE-ID RULE IS ONE COPY: the Worker imports it and declares none of it', () => {
    for (const n of ['sanitizeLakeId', 'stripLakeQualifiers', 'researchStorageId',
                     'legacyStorageName', 'researchStorageIdCandidates']) {
      expect(WORKER).toMatch(new RegExp(`import \\{[^}]*\\b${n}\\b[^}]*\\}\\s*from\\s*'[^']*js/data/research-ids\\.js'`));
      expect(WORKER).not.toMatch(new RegExp(`function\\s+${n}\\s*\\(`));
    }
  });

  // THE DUPLICATION THIS GUARDED IS GONE, AND THAT IS WHY IT WENT RED.
  //
  // This used to lift `const RESEARCH_CANONICAL_IDS = {...}` out of the Worker's source and
  // compare it key by key against the client's. The Worker no longer declares one: keys.js line 1
  // is `import { RESEARCH_CANONICAL_IDS } from '../../js/data/research-ids.js'`. So the regex
  // matched nothing, `Boolean(block)` was false, and a test failed because the thing it was
  // protecting against had been fixed properly.
  //
  // A comparison cannot be the guard any more -- there is nothing to compare. THE GUARD IS THAT
  // THERE IS STILL ONE TABLE, which is a stronger claim than "two tables agree today" and is the
  // claim that stops a second copy reappearing. Drift here never throws: it reports a researched
  // lake as unresearched and sends Ryan to re-run a pipeline on a water that is already done, or
  // hides a lake from the picker that he still needs.
  it('THERE IS ONE TABLE, and the Worker imports it rather than keeping its own', () => {
    expect(WORKER).toMatch(/import \{[^}]*RESEARCH_CANONICAL_IDS[^}]*\}\s*from\s*'[^']*js\/data\/research-ids\.js'/);
    // No second declaration anywhere in the Worker's research layer.
    expect(WORKER).not.toMatch(/(const|let|var)\s+RESEARCH_CANONICAL_IDS\s*=/);
  });

  it('...and the table it imports is a real one, keyed id to id', () => {
    // The import above proves there is one table; this proves the one is not empty. A mirror that
    // agreed with an empty table would have passed the old test too.
    const keys = Object.keys(RESEARCH_CANONICAL_IDS);
    expect(keys.length > 0).toBe(true);
    for (const k of keys) {
      expect(typeof RESEARCH_CANONICAL_IDS[k]).toBe('string');
      expect(RESEARCH_CANONICAL_IDS[k].length > 0).toBe(true);
      // A canonical id must itself be a sanitised id, or the fold produces a key nothing stores.
      expect(sanitizeLakeId(RESEARCH_CANONICAL_IDS[k])).toBe(RESEARCH_CANONICAL_IDS[k]);
    }
  });

  it('folds a border water onto one profile instead of offering it twice', () => {
    // SC calls it Thurmond, GA calls it Clarks Hill. Two names, one profile — and without this
    // the picker offers a lake he has already researched under the other state's name.
    expect(researchStorageId('Lake Thurmond, SC')).toBe('clarks_hill_thurmond_sc_ga');
    expect(researchStorageId('Lake Wylie, NC')).toBe('lake_wylie_sc');
    expect(researchStorageId('Chatuge Lake, NC')).toBe('lake_chatuge_ga');
  });
});

describe('researchedNames — what is already done', () => {
  const LIST = [{ id: 'lake_wateree_sc' }, { id: 'lake_wylie_sc' }, { id: 'clarks_hill_thurmond_sc_ga' }];

  it('matches on the storage id, both spellings of a border water', () => {
    const done = researchedNames(['Lake Wateree, SC', 'Lake Wylie, NC', 'Lake Thurmond, SC'], LIST);
    expect(done.size).toBe(3);
  });

  it('does not match loosely — a near name is a different lake', () => {
    // Two Lake Robinsons in SC, one in Greer and one in Darlington. A fuzzy match would mark the
    // wrong one done and it would simply stop being offered, with nothing on screen saying why.
    const done = researchedNames(['Wateree River, SC', 'Lake Waterees, SC'], LIST);
    expect(done.size).toBe(0);
  });

  it('treats an unreachable list as nothing researched, not everything', () => {
    // fetchResearchedIds() returns [] when the Worker cannot be read. Offering a lake he has
    // already done is a visible, harmless error; hiding one he has not is invisible.
    expect(researchedNames(['Lake Wateree, SC'], []).size).toBe(0);
    expect(researchedNames(['Lake Wateree, SC'], null).size).toBe(0);
  });

  it('accepts bare id strings as well as objects', () => {
    expect(researchedNames(['Lake Wateree, SC'], ['lake_wateree_sc']).size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE PRE-COUNTY SPELLING — added 2026-08-23
//
// `consolidate_lake_index.py` started naming lakes by county in August. Every profile written
// before that is filed under the old "Name, ST" id, and measured against the live bucket that is
// 59 of the 62 profiles in it. The read path had `bare` and `raw` and neither is that spelling,
// so `/research/get?lake=Lake Murray (Newberry Co, SC)` returned 404 while
// `/research/get?lake=Lake Murray, SC` returned a v76 profile.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the pre-county spelling resolves', () => {
  // 'legacyStorageName agrees with the Worker, character for character' stood here. There is one
  // legacyStorageName since 2026-09-25, and the one-copy test at the top holds it there.
  it('the candidates include the pre-county id and the literal one', () => {
    for (const name of ['Lake Murray (Newberry Co, SC)', 'Lake Thurmond, SC',
                        'North Saluda Reservoir (Greenville Co, SC)', 'Lake Wateree, SC']) {
      // The contract, asserted on the OUTPUT: the pre-county id is in the list, and so is the
      // literal one.
      const got = researchStorageIdCandidates(name);
      expect(got.includes(sanitizeLakeId(legacyStorageName(name)))).toBe(true);
      expect(got.includes(sanitizeLakeId(name))).toBe(true);
    }
  });

  it('a county display name finds a profile filed under the old name', () => {
    // The live case. 59 of 62 profiles are filed this way.
    const LIVE = [{ id: 'lake_murray_sc' }, { id: 'north_saluda_reservoir_greenville_co_sc' }];
    const done = researchedNames(['Lake Murray (Newberry Co, SC)',
                                  'North Saluda Reservoir (Greenville Co, SC)'], LIVE);
    expect(done.size).toBe(2);
  });

  it('keeps the number that tells four Saluda Rivers apart', () => {
    // stripLakeQualifiers would leave "Saluda River" and match whichever profile came first.
    // Only the parenthetical carrying "Co" is removed.
    expect(legacyStorageName('Saluda River (2) (Newberry Co, SC)')).toBe('Saluda River (2), SC');
    expect(researchStorageIdCandidates('Saluda River (2) (Newberry Co, SC)'))
      .toContain('saluda_river_2_sc');
  });

  it('still refuses a lake with no profile under ANY spelling', () => {
    expect(researchedNames(['Lake Wateree (Kershaw Co, SC)'], [{ id: 'lake_murray_sc' }]).size).toBe(0);
  });

  it('the Congaree reaches the profile a whole evening went into', () => {
    // 2026-09-17, found by RUNNING the app: a dry bench from Barney Jordan logged "no research
    // profile answered to Congaree River, SC" and planned the day on the generic depth band, while
    // congaree_river_to_sc_601_richland_co_sc sat in the bucket with 62 extracted facts and a
    // Largemouth Bass trollingIntelligence entry.
    //
    // The picker's name comes from the DNR ramp feed (`wb: "Congaree River"` + SC); the profile is
    // filed under the registry's county form, because research_lakes.py drove from that.
    const STORED = [{ id: 'congaree_river_to_sc_601_richland_co_sc' }];
    expect(researchedNames(['Congaree River, SC'], STORED).size).toBe(1);
    expect(researchStorageIdCandidates('Congaree River, SC'))
      .toContain('congaree_river_to_sc_601_richland_co_sc');
  });

  it('and the WRITE rule canonicalises too, or the next save forks it again', () => {
    // researchStorageIdCandidates() reaches for the bare `congaree_river`; researchStorageId() --
    // what a save uses -- sanitizes the picker name to `congaree_river_sc`. Mapping only the read
    // would leave the next save writing a second, thinner profile under the picker's spelling,
    // which is exactly how Lanier, Nottely, Watauga and Russell forked on 2026-09-01.
    expect(researchStorageId('Congaree River, SC')).toBe('congaree_river_to_sc_601_richland_co_sc');
    expect(RESEARCH_CANONICAL_IDS.congaree_river).toBe('congaree_river_to_sc_601_richland_co_sc');
    expect(RESEARCH_CANONICAL_IDS.congaree_river_sc).toBe('congaree_river_to_sc_601_richland_co_sc');
  });

  it('the upper Saluda is one profile, and the Lower Saluda is not in it', () => {
    // 2026-09-24. Ryan: "the upper saluda all the way from before saluda lake to murray is probably
    // ok as 1 piece... then lower saluda is a completely type of river". Both upper picker entries
    // already READ saluda_river_sc; these rows make every WRITE from a registry name land there too.
    const UPPER = ['Saluda River (Greenville Co, SC)',      // saluda_river, display name
                   'Saluda River, SC',                      // the picker's saluda_river_2
                   'Saluda River (2) (Newberry Co, SC)',    // saluda_river_2, display name
                   'Saluda River (2), SC'];                 // saluda_river_2, legacy name
    for (const n of UPPER) {
      expect(researchStorageId(n)).toBe('saluda_river_sc');
      expect(researchStorageIdCandidates(n)[0]).toBe('saluda_river_sc');
    }
    const STORED = [{ id: 'saluda_river_sc' }];
    expect(researchedNames(UPPER, STORED).size).toBe(UPPER.length);
    // The bare key is shared with the Lower Saluda, which is why it is not a row.
    expect(RESEARCH_CANONICAL_IDS.saluda_river).toBe(undefined);
    const LOWER = 'Saluda River (Lower Saluda), SC';
    expect(researchStorageId(LOWER)).toBe('saluda_river_lower_saluda_sc');
    expect(researchStorageIdCandidates(LOWER)).not.toContain('saluda_river_sc');
    expect(researchedNames([LOWER], STORED).size).toBe(0);
  });

  it('the Atlanta Chattahoochee reads its own profile, and the Helen one still reads its own', () => {
    // 2026-09-24. Both pieces answer to "Chattahoochee River, GA"; the tailwater below Buford Dam
    // was being planned on the trout-stream research above Lake Lanier.
    const STORED = ['chattahoochee_river_ga', 'chattahoochee_river_fulton_co_ga'];
    const first = (n) => researchStorageIdCandidates(n).find((id) => STORED.includes(id));
    expect(first('Chattahoochee River (Fulton Co, GA)')).toBe('chattahoochee_river_fulton_co_ga');
    expect(first('Chattahoochee River, GA')).toBe('chattahoochee_river_ga');
    expect(researchStorageId('Chattahoochee River (Fulton Co, GA)')).toBe('chattahoochee_river_fulton_co_ga');
  });

  it('the NC French Broad reaches the research filed under TN, and the order elsewhere is unchanged', () => {
    for (const n of ['FRENCH BROAD RIVER, NC', 'French Broad River (Haywood Co, NC)', 'French Broad River, NC']) {
      expect(researchStorageIdCandidates(n)[0]).toBe('french_broad_river_tn');
      expect(researchStorageId(n)).toBe('french_broad_river_tn');
    }
    expect(RESEARCH_CANONICAL_IDS.french_broad_river).toBe(undefined);
    // The Thurmond order still holds for a water with no row: legacy before its own county form.
    const c = researchStorageIdCandidates('Lake Murray (Newberry Co, SC)');
    expect(c.indexOf('lake_murray_sc') < c.indexOf('lake_murray_newberry_co_sc')).toBe(true);
  });

  it('every canonical row points at something, and never at another key', () => {
    // A row whose target is itself a key is a chain, and a chain is a rename nobody finished.
    // Written generally so a row added tomorrow has to satisfy it too.
    for (const [from, to] of Object.entries(RESEARCH_CANONICAL_IDS)) {
      expect(typeof to === 'string' && to.length > 0).toBe(true);
      if (from === to) continue;   // the Thurmond self-map, which is deliberate
      expect(RESEARCH_CANONICAL_IDS[to] === undefined || RESEARCH_CANONICAL_IDS[to] === to).toBe(true);
    }
  });
});
