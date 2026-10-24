// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { childDn, escapeRdnValueRfc, isDnWithin, parseDn } from './dn.js';

describe('escapeRdnValueRfc', () => {
  it('escapes what RFC 4514 requires and nothing more', () => {
    expect(escapeRdnValueRfc('Smith, John')).toBe('Smith\\, John');
    expect(escapeRdnValueRfc('A+B "C" <d>;e=f\\g')).toBe('A\\+B \\"C\\" \\<d\\>\\;e\\=f\\\\g');
    expect(escapeRdnValueRfc('#1 fan')).toBe('\\#1 fan');
    expect(escapeRdnValueRfc(' padded ')).toBe('\\ padded\\ ');
    expect(escapeRdnValueRfc('John Smith (john.smith2)')).toBe('John Smith (john.smith2)');
  });

  it('builds a child DN', () => {
    expect(childDn('CN', 'Smith, John', 'OU=Staff,DC=x')).toBe('CN=Smith\\, John,OU=Staff,DC=x');
  });
});

describe('parseDn', () => {
  it('splits on unescaped commas and unescapes values', () => {
    expect(parseDn('CN=Smith\\, John,OU=Staff , DC=x')).toEqual([
      { type: 'CN', value: 'Smith, John' },
      { type: 'OU', value: 'Staff' },
      { type: 'DC', value: 'x' },
    ]);
    expect(parseDn('OU=Caf\\C3\\A9,DC=x')?.[0]?.value).toBe('Café');
  });

  it('refuses what is not a DN', () => {
    for (const bad of [
      '',
      'Staff',
      'OU=,DC=x',
      'OU=Staff,',
      '=Staff',
      'OU=a"b',
      'OU=a\\',
      'O U=x',
      'OU=\\C3,DC=x',
    ]) {
      expect(parseDn(bad), bad).toBeNull();
    }
  });
});

describe('isDnWithin', () => {
  const base = 'DC=openaduc,DC=test';
  it('accepts the base and anything under it, ignoring case and spacing', () => {
    expect(isDnWithin('dc=OpenADUC, dc=TEST', base)).toBe(true);
    expect(isDnWithin('OU=Staff,OU=OpenADUC Test,DC=openaduc,DC=test', base)).toBe(true);
    expect(isDnWithin('CN=Users,DC=openaduc,DC=test', base)).toBe(true);
  });

  it('refuses another tree, a look-alike and a malformed DN', () => {
    expect(isDnWithin('OU=Staff,DC=other,DC=test', base)).toBe(false);
    expect(isDnWithin('OU=Staff,DC=xopenaduc,DC=test', base)).toBe(false);
    expect(isDnWithin('DC=test', base)).toBe(false);
    expect(isDnWithin('OU=Staff\\', base)).toBe(false);
  });
});
