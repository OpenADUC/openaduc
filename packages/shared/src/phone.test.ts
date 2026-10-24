// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { normalizePhone, phoneCountries } from './phone.js';

const mobile = (value: string, defaultCountry: string | null = 'GB') =>
  normalizePhone(value, { kind: 'mobile', defaultCountry });
const telephone = (value: string, defaultCountry: string | null = 'GB') =>
  normalizePhone(value, { kind: 'telephone', defaultCountry });

describe('normalizePhone', () => {
  it('writes a number in Entra’s +CC NUMBER form', () => {
    expect(mobile('07400 123456')).toEqual({
      value: '+44 7400123456',
      warning: null,
      readable: true,
    });
    expect(mobile('+1 (425) 555-0123', null)).toEqual({
      value: '+1 4255550123',
      warning: null,
      readable: true,
    });
    expect(telephone('020 7946 0958')).toEqual({
      value: '+44 2079460958',
      warning: null,
      readable: true,
    });
  });

  it('reads a number without a country code as the directory’s default country', () => {
    expect(mobile('0412 345 678', 'AU').value).toBe('+61 412345678');
  });

  it('keeps an extension, as Entra writes it', () => {
    expect(telephone('+1 425 555 0123 ext. 45')).toEqual({
      value: '+1 4255550123x45',
      warning: null,
      readable: true,
    });
  });

  it('leaves an empty number empty', () => {
    expect(mobile('  ')).toEqual({ value: '', warning: null, readable: true });
  });

  it('keeps a number it can’t read as typed, and says so', () => {
    expect(mobile(' call me ')).toEqual({
      value: 'call me',
      warning: expect.stringContaining('isn’t a phone number'),
      readable: false,
    });
    expect(mobile('12345').warning).toContain('isn’t a phone number');
  });

  it('asks for a country code when there’s no default country', () => {
    expect(mobile('07400 123456', null)).toEqual({
      value: '07400 123456',
      warning: expect.stringContaining('country code'),
      readable: false,
    });
  });

  it('warns when a mobile number is a landline', () => {
    expect(mobile('020 7946 0958')).toEqual({
      value: '+44 2079460958',
      warning: expect.stringContaining('landline'),
      readable: true,
    });
    // Where a number can be either, as in the US, it's taken as given.
    expect(mobile('(425) 555-0123', 'US').warning).toBeNull();
  });

  it('ignores a default country it doesn’t know', () => {
    expect(mobile('+44 7400 123456', 'XX').value).toBe('+44 7400123456');
  });
});

describe('phoneCountries', () => {
  it('lists two-letter country codes', () => {
    expect(phoneCountries()).toContain('GB');
    expect(phoneCountries().every((c) => /^[A-Z]{2}$/.test(c))).toBe(true);
  });
});
