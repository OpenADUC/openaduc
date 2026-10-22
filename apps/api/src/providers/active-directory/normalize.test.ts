// SPDX-License-Identifier: BUSL-1.1
import type { Entry } from 'ldapts';
import { describe, expect, it } from 'vitest';
import { normalizeComputer, normalizeUser } from './normalize.js';

const base = (dn: string): Entry =>
  ({
    dn,
    distinguishedName: dn,
    objectGUID: Buffer.alloc(16, 1),
    userAccountControl: '4096',
    cn: 'WS01',
  }) as unknown as Entry;

describe('raw attributes never carry secrets', () => {
  it('drops legacy and Windows LAPS passwords from a computer', () => {
    const computer = normalizeComputer({
      ...base('CN=WS01,OU=Workstations,DC=corp,DC=example'),
      'ms-Mcs-AdmPwd': 'S3cret!',
      'msLAPS-Password': '{"p":"S3cret!"}',
      'msLAPS-EncryptedPassword': 'blob',
      'ms-Mcs-AdmPwdExpirationTime': '133000000000000000',
      operatingSystem: 'Windows 11 Pro',
    } as unknown as Entry);

    expect(Object.keys(computer.rawAttributes)).not.toContain('ms-Mcs-AdmPwd');
    expect(Object.keys(computer.rawAttributes)).not.toContain('msLAPS-Password');
    expect(Object.keys(computer.rawAttributes)).not.toContain('msLAPS-EncryptedPassword');
    // Not a secret: when the password rotates is fine to show.
    expect(computer.rawAttributes['ms-Mcs-AdmPwdExpirationTime']).toBe('133000000000000000');
    expect(computer.rawAttributes.operatingSystem).toBe('Windows 11 Pro');
  });

  it('matches attribute names case-insensitively', () => {
    const user = normalizeUser({
      ...base('CN=Alice,OU=Staff,DC=corp,DC=example'),
      userAccountControl: '512',
      'MS-MCS-ADMPWD': 'S3cret!',
      'msDS-ManagedPassword': 'blob',
    } as unknown as Entry);

    expect(Object.keys(user.rawAttributes).map((k) => k.toLowerCase())).not.toContain(
      'ms-mcs-admpwd',
    );
    expect(Object.keys(user.rawAttributes)).not.toContain('msDS-ManagedPassword');
  });
});
