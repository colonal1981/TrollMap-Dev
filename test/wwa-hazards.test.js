// A BLANK IS A SPACE, A WATCH IS NOT A WARNING, AND `event` WAS NEVER AN EVENT.
//
// FIXTURES ARE REAL. Both rows below are transcribed verbatim from
// mapservices.weather.noaa.gov/.../WWA/watch_warn_adv/MapServer/1/query, queried
// `where=1=1&outFields=*` on 2026-08-25 — the first time anything had asked that layer what it
// declares rather than assuming the five fields the app happened to request.
//
// The layer declares fifteen. Four of them change what a paddler is told, and the one the app
// DID surface under the name `event` is a tracking number.
import { describe, it, expect } from './expect-shim.mjs';
import { wwaText, wwaSeverity } from '../Worker/conditions.js';

// Illinois, 2026-08-24. A live Flood Warning: `sig` set, `ends` blank.
const FLOOD_WARNING = {
  objectid: 1,
  prod_type: 'Flood Warning',
  msg_type: 'FLS',
  phenom: 'FL',
  url: 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.c5fe1389.001.1',
  expiration: '2026-08-25T00:30:00-05:00',
  onset: '2026-08-24T09:46:00-05:00',
  ends: ' ',
  issuance: '2026-08-24T09:46:00-05:00',
  event: '0038',
  sig: 'W',
  wfo: 'KILX',
  cap_id: 'urn:oid:2.49.0.1.840.0.c5fe1389.001.1',
};

// 2026-08-25. A Special Weather Statement: `sig`, `phenom` and `wfo` ALL blank.
const SPECIAL_STATEMENT = {
  prod_type: 'Special Weather Statement',
  sig: ' ',
  onset: '2026-08-25T07:22:00-04:00',
  ends: ' ',
  msg_type: 'SPS',
  phenom: ' ',
  wfo: ' ',
  cap_id: 'urn:oid:2.49.0.1.840.0.2e33b330.001.1',
};

describe('a blank field is a single space', () => {
  it('does not pass a space through as a value', () => {
    expect(wwaText(FLOOD_WARNING.ends)).toBe(null);
    expect(wwaText(SPECIAL_STATEMENT.wfo)).toBe(null);
    expect(wwaText(SPECIAL_STATEMENT.phenom)).toBe(null);
  });

  it('is the whole reason `|| null` was not enough', () => {
    // The bug this replaces, stated as a test so it cannot come back.
    expect(FLOOD_WARNING.ends || null).toBe(' ');
    expect(Boolean(FLOOD_WARNING.ends)).toBe(true);
  });

  it('keeps real text intact and trims the padding upstream ships', () => {
    expect(wwaText(' KILX ')).toBe('KILX');
    expect(wwaText('Flood Warning')).toBe('Flood Warning');
  });

  it('treats absent, null and empty the same as blank', () => {
    expect(wwaText(undefined)).toBe(null);
    expect(wwaText(null)).toBe(null);
    expect(wwaText('')).toBe(null);
    expect(wwaText('   ')).toBe(null);
  });

  it('does not swallow a legitimate zero', () => {
    expect(wwaText(0)).toBe('0');
  });
});

describe('severity — the field that separates a watch from a warning', () => {
  it('reads VTEC significance when the product carries one', () => {
    expect(wwaSeverity(FLOOD_WARNING.sig, FLOOD_WARNING.prod_type)).toBe('Warning');
    expect(wwaSeverity('A', 'Severe Thunderstorm Watch')).toBe('Watch');
    expect(wwaSeverity('Y', 'Small Craft Advisory')).toBe('Advisory');
  });

  it('covers the rest of the codebook rather than the three we happen to see', () => {
    expect(wwaSeverity('S', 'Anything')).toBe('Statement');
    expect(wwaSeverity('F', 'Anything')).toBe('Forecast');
    expect(wwaSeverity('O', 'Anything')).toBe('Outlook');
    expect(wwaSeverity('N', 'Anything')).toBe('Synopsis');
  });

  it('falls back to the product name when `sig` is blank', () => {
    // The real SPS row. Without the fallback this is null on a live statement.
    expect(wwaSeverity(SPECIAL_STATEMENT.sig, SPECIAL_STATEMENT.prod_type)).toBe('Statement');
  });

  it('finds the noun anywhere in the name, not only at the end', () => {
    expect(wwaSeverity(' ', 'Warning for Small Craft')).toBe('Warning');
  });

  it('normalises the fallback casing so two rows never read as two kinds', () => {
    expect(wwaSeverity('', 'SEVERE THUNDERSTORM WARNING')).toBe('Warning');
    expect(wwaSeverity('', 'severe thunderstorm watch')).toBe('Watch');
  });

  it('is case-insensitive on the code itself', () => {
    expect(wwaSeverity('w', 'Flood Warning')).toBe('Warning');
  });

  it('says null rather than guessing when neither door answers', () => {
    expect(wwaSeverity(' ', 'Hazardous Weather Outlook Statement Removed')).toBe('Statement');
    expect(wwaSeverity(' ', 'Air Quality Alert')).toBe(null);
    expect(wwaSeverity(null, null)).toBe(null);
  });

  it('does not invent a severity from an unknown code', () => {
    // `Z` is not in the codebook. Falling through to the name is correct; inventing is not.
    expect(wwaSeverity('Z', 'Rip Current Statement')).toBe('Statement');
    expect(wwaSeverity('Z', 'Nothing Recognisable')).toBe(null);
  });
});

describe('the tracking number that was being shown as an event name', () => {
  it('is four digits, not a label', () => {
    expect(FLOOD_WARNING.event).toBe('0038');
    expect(wwaText(FLOOD_WARNING.event)).toBe('0038');
    // Nothing about it is human-readable, which is why it is `etn` now and not `type`.
    expect(/^\d{4}$/.test(FLOOD_WARNING.event)).toBe(true);
  });

  it('leaves `prod_type` as the only field that names the hazard', () => {
    expect(wwaText(FLOOD_WARNING.prod_type)).toBe('Flood Warning');
  });
});

describe('the two clocks, which are not the same clock', () => {
  it('onset and issuance can differ, and the app was showing issuance', () => {
    const watch = { onset: '2026-08-25T14:00:00-04:00', issuance: '2026-08-25T06:00:00-04:00' };
    const begins = wwaText(watch.onset) || wwaText(watch.issuance);
    expect(begins).toBe('2026-08-25T14:00:00-04:00');
    expect(begins).not.toBe(watch.issuance);
  });

  it('falls back to issuance only when onset is genuinely blank', () => {
    const begins = wwaText(SPECIAL_STATEMENT.onset) || wwaText(SPECIAL_STATEMENT.issuance);
    expect(begins).toBe('2026-08-25T07:22:00-04:00');
  });

  it('falls back to expiration when the hazard clock is blank', () => {
    const ends = wwaText(FLOOD_WARNING.ends) || wwaText(FLOOD_WARNING.expiration);
    expect(ends).toBe('2026-08-25T00:30:00-05:00');
  });

  it('prefers the hazard clock when upstream sets it', () => {
    const row = { ends: '2026-08-25T15:00:00-04:00', expiration: '2026-08-25T18:00:00-04:00' };
    expect(wwaText(row.ends) || wwaText(row.expiration)).toBe('2026-08-25T15:00:00-04:00');
  });

  it('yields null rather than a space when both clocks are blank', () => {
    expect(wwaText(' ') || wwaText(' ')).toBe(null);
  });
});
