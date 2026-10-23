// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import {
  groupDeleteBlock,
  isProtectedGroup,
  type GroupDeleteFacts,
  type GroupLike,
} from './groupDeletion.js';

const DOMAIN = 'S-1-5-21-850847357-2675788760-1070107763';
const ordinary: GroupLike = {
  distinguishedName: 'CN=Engineering,OU=Groups,DC=example,DC=test',
  sid: `${DOMAIN}-1106`,
  rawAttributes: { groupType: '-2147483646' },
};
const noFacts: GroupDeleteFacts = { parents: [], primaryGroupMembers: 0 };
const reason = (
  over: Partial<typeof ordinary>,
  facts: GroupDeleteFacts = noFacts,
  roles: { dn: string; role: 'admin' | 'operator' | 'auditor' }[] = [],
) => groupDeleteBlock({ ...ordinary, ...over }, facts, roles)?.reason ?? null;

describe('groupDeleteBlock', () => {
  it('lets an ordinary group go', () => {
    expect(reason({})).toBeNull();
  });

  it('refuses a critical system object', () => {
    expect(reason({ rawAttributes: { isCriticalSystemObject: 'TRUE' } })).toBe(
      'critical_system_object',
    );
  });

  it('refuses built-in groups however they show it', () => {
    expect(reason({ distinguishedName: 'CN=Print Operators,CN=Builtin,DC=example,DC=test' })).toBe(
      'builtin_group',
    );
    expect(reason({ rawAttributes: { groupType: '-2147483643' } })).toBe('builtin_group');
    expect(reason({ sid: `${DOMAIN}-512` })).toBe('builtin_group');
    expect(reason({ sid: 'S-1-5-32-550' })).toBe('builtin_group');
  });

  it('refuses a group AdminSDHolder protects', () => {
    expect(reason({ rawAttributes: { adminCount: ['1'] } })).toBe('protected_group');
  });

  it('refuses a group mapped to an OpenADUC role, naming the role', () => {
    const block = groupDeleteBlock(ordinary, noFacts, [
      { dn: ordinary.distinguishedName.toUpperCase(), role: 'operator' },
    ]);
    expect(block).toEqual({ reason: 'role_group', role: 'operator' });
  });

  it('refuses a group nested directly in a protected group', () => {
    const domainAdmins = {
      distinguishedName: 'CN=Domain Admins,CN=Users,DC=example,DC=test',
      sid: `${DOMAIN}-512`,
      rawAttributes: {},
    };
    const allStaff = { ...ordinary, distinguishedName: 'CN=All Staff,DC=example,DC=test' };
    expect(reason({}, { parents: [allStaff], primaryGroupMembers: 0 })).toBeNull();
    expect(reason({}, { parents: [allStaff, domainAdmins], primaryGroupMembers: 0 })).toBe(
      'member_of_protected_group',
    );
  });

  it('refuses some user’s primary group', () => {
    expect(reason({}, { parents: [], primaryGroupMembers: 2 })).toBe('primary_group');
  });
});

describe('isProtectedGroup', () => {
  it('knows the protected groups by SID, not name', () => {
    const g = (sid: string) => ({ distinguishedName: 'CN=x', sid, rawAttributes: {} });
    expect(isProtectedGroup(g('S-1-5-32-544'))).toBe(true); // Administrators
    expect(isProtectedGroup(g('S-1-5-32-545'))).toBe(false); // Users
    expect(isProtectedGroup(g(`${DOMAIN}-519`))).toBe(true); // Enterprise Admins
    expect(isProtectedGroup(g(`${DOMAIN}-513`))).toBe(false); // Domain Users
    expect(isProtectedGroup(g(`${DOMAIN}-1200`))).toBe(false);
  });
});
