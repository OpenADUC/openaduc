// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { directoryCountry, directoryCountryCodes } from './country.js';

describe('directoryCountry', () => {
  it('names a country and gives its number as AD stores it', () => {
    expect(directoryCountry('gb')).toEqual({
      c: 'GB',
      co: 'United Kingdom',
      countryCode: '826',
    });
    expect(directoryCountry('AF')?.countryCode).toBe('4');
  });

  it('knows no country for a code ISO 3166 doesn’t assign', () => {
    expect(directoryCountry('XK')).toBeNull();
    expect(directoryCountry('')).toBeNull();
  });

  it('lists every assigned code once', () => {
    const codes = directoryCountryCodes();
    expect(codes).toHaveLength(249);
    expect(new Set(codes).size).toBe(249);
  });
});
