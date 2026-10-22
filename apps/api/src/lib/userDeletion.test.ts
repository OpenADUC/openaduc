// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { userDeleteBlockReason } from './userDeletion.js';

const domainSid = 'S-1-5-21-1004336348-1177238915-682003330';

describe('userDeleteBlockReason', () => {
  it('allows a disabled ordinary account', () => {
    expect(
      userDeleteBlockReason({ enabled: false, sid: `${domainSid}-1105`, rawAttributes: {} }),
    ).toBeNull();
  });

  it('refuses enabled accounts', () => {
    expect(
      userDeleteBlockReason({ enabled: true, sid: `${domainSid}-1105`, rawAttributes: {} }),
    ).toBe('enabled');
  });

  it('refuses critical system objects', () => {
    expect(
      userDeleteBlockReason({
        enabled: false,
        sid: `${domainSid}-1105`,
        rawAttributes: { isCriticalSystemObject: 'TRUE' },
      }),
    ).toBe('critical_system_object');
  });

  it('refuses built-in accounts even without the critical flag', () => {
    for (const rid of [500, 501, 502, 503, 504]) {
      expect(
        userDeleteBlockReason({ enabled: false, sid: `${domainSid}-${rid}`, rawAttributes: {} }),
      ).toBe('builtin_account');
    }
  });

  it('allows an account with no SID on record', () => {
    expect(userDeleteBlockReason({ enabled: false, sid: null, rawAttributes: {} })).toBeNull();
  });
});
