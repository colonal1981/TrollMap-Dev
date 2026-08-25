// "WIND 5 MPH FROM 999°"
//
// Reported by Ryan 2026-08-25 off a live conditions card for the Lower Saluda. The speed was
// real; the direction was NWS MapClick's numeric sentinel for a missing or variable bearing,
// rendered as a compass heading.
//
// `obsNum` already caught this feed's STRING sentinels -- the literal characters "NA" -- and
// this file's `NO_DATA` set already caught the negative numeric family, -999 / -9999 / -99999.
// 999 is the same family with the sign flipped, and a set of negative numbers has nothing to
// say about it.
//
// SO THE GUARD IS THE DOMAIN, NOT THE VALUE. A compass bearing is 0 to 360. Listing 999 would
// leave the next sentinel through; bounding the field cannot.
import { describe, it, expect } from './expect-shim.mjs';
import { obsBearing } from '../Worker/conditions.js';

describe('the reported bug', () => {
  it('999 is not a direction', () => {
    expect(obsBearing('999')).toBe(null);
    expect(obsBearing(999)).toBe(null);
  });

  it('and neither is the rest of the family, whatever its sign', () => {
    for (const v of [999, 9999, 99999, -999, -9999, -99999, -999999]) {
      expect(obsBearing(v)).toBe(null);
    }
  });
});

describe('a real bearing survives', () => {
  it('keeps every cardinal and the ends of the range', () => {
    expect(obsBearing('0')).toBe(0);
    expect(obsBearing('90')).toBe(90);
    expect(obsBearing('180')).toBe(180);
    expect(obsBearing('270')).toBe(270);
    expect(obsBearing('360')).toBe(360);
  });

  it('does not swallow due north, which is zero and falsy', () => {
    // The trap next door: `n || null` turns a northerly into a missing reading.
    expect(obsBearing('0')).toBe(0);
    expect(obsBearing(0)).toBe(0);
  });

  it('keeps a fractional bearing', () => {
    expect(obsBearing('12.5')).toBe(12.5);
  });

  it('reads the strings this feed actually sends, because every field is a string', () => {
    expect(obsBearing(' 210 ')).toBe(210);
  });
});

describe('everything outside the domain is refused', () => {
  it('refuses one degree past either end', () => {
    expect(obsBearing('361')).toBe(null);
    expect(obsBearing('-1')).toBe(null);
  });

  it('still refuses the string sentinels obsNum was written for', () => {
    expect(obsBearing('NA')).toBe(null);
    expect(obsBearing('N/A')).toBe(null);
    expect(obsBearing('-')).toBe(null);
    expect(obsBearing('')).toBe(null);
    expect(obsBearing('   ')).toBe(null);
  });

  it('refuses absent values without throwing', () => {
    expect(obsBearing(null)).toBe(null);
    expect(obsBearing(undefined)).toBe(null);
    expect(obsBearing(NaN)).toBe(null);
    expect(obsBearing({})).toBe(null);
    expect(obsBearing([])).toBe(null);
  });

  it('refuses text that is not a number', () => {
    expect(obsBearing('variable')).toBe(null);
    expect(obsBearing('VRB')).toBe(null);
    expect(obsBearing('north')).toBe(null);
  });
});
