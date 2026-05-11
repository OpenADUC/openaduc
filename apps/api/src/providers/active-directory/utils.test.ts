// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import {
  encodeUnicodePassword,
  escapeDnValue,
  escapeLdapFilter,
  filetimeToDate,
  isLocked,
  objectGuidFromString,
  objectGuidToString,
  parseUserAccountControl,
  sidToString,
  bufferToLdapFilterValue,
} from './utils.js';

describe('objectGuid', () => {
  it('round-trips a known mixed-endian GUID', () => {
    // First three groups little-endian, last two big-endian.
    const buf = Buffer.from([
      0xd3, 0xa4, 0x75, 0x60, 0x7c, 0x84, 0x9f, 0x4b, 0x9b, 0x26, 0x7e, 0x4f, 0x1d, 0x1f, 0x8a,
      0x0c,
    ]);
    expect(objectGuidToString(buf)).toBe('6075a4d3-847c-4b9f-9b26-7e4f1d1f8a0c');
    expect(objectGuidFromString('6075a4d3-847c-4b9f-9b26-7e4f1d1f8a0c').equals(buf)).toBe(true);
  });

  it('rejects wrong-length buffers', () => {
    expect(() => objectGuidToString(Buffer.alloc(15))).toThrow();
  });

  it('rejects malformed strings', () => {
    expect(() => objectGuidFromString('not-a-guid')).toThrow();
  });
});

describe('sidToString', () => {
  it('parses S-1-5-21-... domain SID', () => {
    // S-1-5-21-1004336348-1177238915-682003330-512 = Domain Admins.
    // Layout: rev=1, subAuthCount=5, idAuthority=5,
    // sub-authorities: [21, 1004336348, 1177238915, 682003330, 512] (LE u32 each).
    const subAuths = [21, 1004336348, 1177238915, 682003330, 512];
    const buf = Buffer.alloc(8 + 4 * subAuths.length);
    buf[0] = 1;
    buf[1] = subAuths.length;
    // identifierAuthority: 6 bytes BE = 0,0,0,0,0,5
    buf[7] = 5;
    for (let i = 0; i < subAuths.length; i++) {
      buf.writeUInt32LE(subAuths[i]!, 8 + i * 4);
    }
    expect(sidToString(buf)).toBe('S-1-5-21-1004336348-1177238915-682003330-512');
  });

  it('parses well-known S-1-1-0 (Everyone)', () => {
    const buf = Buffer.from([1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
    expect(sidToString(buf)).toBe('S-1-1-0');
  });

  it('rejects truncated SIDs', () => {
    expect(() => sidToString(Buffer.from([1, 2, 0]))).toThrow();
  });
});

describe('filetimeToDate', () => {
  it('converts the Windows epoch start to a Date', () => {
    // 1 January 1970 00:00:00 UTC in FILETIME 100ns ticks.
    const filetime = '116444736000000000';
    expect(filetimeToDate(filetime)?.toISOString()).toBe('1970-01-01T00:00:00.000Z');
  });

  it('treats 0 and INT64_MAX as never', () => {
    expect(filetimeToDate('0')).toBeNull();
    expect(filetimeToDate('9223372036854775807')).toBeNull();
    expect(filetimeToDate(null)).toBeNull();
    expect(filetimeToDate(undefined)).toBeNull();
    expect(filetimeToDate('')).toBeNull();
  });

  it('converts a recent date round-trip-ish', () => {
    // 2024-01-15T08:34:22.000Z → ms = 1705307662000
    // FILETIME = (ms + 11644473600000) * 10000
    const ms = Date.UTC(2024, 0, 15, 8, 34, 22);
    const filetime = ((BigInt(ms) + 11644473600000n) * 10000n).toString();
    const date = filetimeToDate(filetime);
    expect(date?.toISOString()).toBe('2024-01-15T08:34:22.000Z');
  });

  it('returns null for malformed input', () => {
    expect(filetimeToDate('not-a-number')).toBeNull();
  });
});

describe('parseUserAccountControl', () => {
  it('decodes NORMAL_ACCOUNT (512) as enabled', () => {
    const s = parseUserAccountControl('512');
    expect(s.enabled).toBe(true);
    expect(s.passwordExpired).toBe(false);
    expect(s.passwordNeverExpires).toBe(false);
  });

  it('decodes NORMAL_ACCOUNT | ACCOUNTDISABLE (514) as disabled', () => {
    expect(parseUserAccountControl('514').enabled).toBe(false);
  });

  it('decodes DONT_EXPIRE_PASSWORD bit', () => {
    // 0x10000 | 0x200 = 66048
    expect(parseUserAccountControl('66048').passwordNeverExpires).toBe(true);
  });

  it('treats null/undefined as enabled', () => {
    // No UAC at all is unusual but should default to enabled.
    expect(parseUserAccountControl(null).enabled).toBe(true);
    expect(parseUserAccountControl(undefined).enabled).toBe(true);
  });
});

describe('isLocked', () => {
  it('treats 0 / null / unset as unlocked', () => {
    expect(isLocked('0')).toBe(false);
    expect(isLocked(0)).toBe(false);
    expect(isLocked(null)).toBe(false);
    expect(isLocked(undefined)).toBe(false);
    expect(isLocked('')).toBe(false);
  });

  it('treats nonzero FILETIME as locked', () => {
    expect(isLocked('132514567890123456')).toBe(true);
  });

  it('treats INT64_MAX sentinel as not-currently-locked', () => {
    expect(isLocked('9223372036854775807')).toBe(false);
  });
});

describe('escapeLdapFilter', () => {
  it('escapes the RFC 4515 special characters', () => {
    expect(escapeLdapFilter('a*b(c)d\\e')).toBe('a\\2ab\\28c\\29d\\5ce');
  });

  it('passes plain text through', () => {
    expect(escapeLdapFilter('john.smith')).toBe('john.smith');
  });

  it('escapes NUL', () => {
    expect(escapeLdapFilter('a\0b')).toBe('a\\00b');
  });
});

describe('escapeDnValue', () => {
  it('escapes DN-special chars', () => {
    expect(escapeDnValue('Smith, John')).toBe('Smith\\, John');
  });

  it('escapes leading # and space', () => {
    expect(escapeDnValue('#weird')).toBe('\\#weird');
    expect(escapeDnValue(' leading')).toBe('\\ leading');
  });

  it('escapes trailing space', () => {
    expect(escapeDnValue('trailing ')).toBe('trailing\\ ');
  });
});

describe('bufferToLdapFilterValue', () => {
  it('formats each byte as \\xx', () => {
    expect(bufferToLdapFilterValue(Buffer.from([0xab, 0xcd, 0x01]))).toBe('\\ab\\cd\\01');
  });
});

describe('encodeUnicodePassword', () => {
  it('wraps the value in quotes and encodes as UTF-16LE', () => {
    const buf = encodeUnicodePassword('p');
    // Should be 6 bytes: ["][p]["] each 2 bytes LE.
    expect(buf).toEqual(Buffer.from([0x22, 0x00, 0x70, 0x00, 0x22, 0x00]));
  });
});
