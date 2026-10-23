// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { groupDeleteBlockReason } from './groupDeletion.js';

describe('groupDeleteBlockReason', () => {
  const DOMAIN = 'S-1-5-21-850847357-2675788760-1070107763';
  const ordinary = {
    distinguishedName: 'CN=Engineering,OU=Groups,DC=example,DC=test',
    sid: `${DOMAIN}-1106`,
    rawAttributes: { groupType: '-2147483646' },
  };

  it('lets an ordinary group go', () => {
    expect(groupDeleteBlockReason(ordinary)).toBeNull();
  });

  it('refuses a critical system object', () => {
    expect(
      groupDeleteBlockReason({
        ...ordinary,
        rawAttributes: { ...ordinary.rawAttributes, isCriticalSystemObject: 'TRUE' },
      }),
    ).toBe('critical_system_object');
  });

  it('refuses built-in groups however they show it', () => {
    const builtin = (over: Partial<typeof ordinary>) =>
      groupDeleteBlockReason({ ...ordinary, ...over });
    expect(builtin({ distinguishedName: 'CN=Print Operators,CN=Builtin,DC=example,DC=test' })).toBe(
      'builtin_group',
    );
    expect(builtin({ rawAttributes: { groupType: '-2147483643' } })).toBe('builtin_group');
    expect(builtin({ sid: `${DOMAIN}-512` })).toBe('builtin_group');
    expect(builtin({ sid: 'S-1-5-32-550' })).toBe('builtin_group');
  });

  it('refuses a group AdminSDHolder protects', () => {
    expect(
      groupDeleteBlockReason({
        ...ordinary,
        rawAttributes: { ...ordinary.rawAttributes, adminCount: ['1'] },
      }),
    ).toBe('protected_group');
  });
});
