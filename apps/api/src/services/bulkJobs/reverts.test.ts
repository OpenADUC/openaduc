// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { judge, REVERTS, type AccountNow } from './reverts.js';

const now = (more: Partial<AccountNow> = {}): AccountNow => ({
  enabled: true,
  parent: { dn: 'OU=Staff,DC=corp', guid: 'staff' },
  accountExpiresAt: null,
  passwordMustChange: false,
  passwordNeverExpires: false,
  attributes: {},
  manager: { dn: null, guid: null },
  groupIds: null,
  uSNChanged: '100',
  ...more,
});

const verdictOf = (
  action: keyof typeof REVERTS,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  account: AccountNow,
  touched: string | null = null,
) => judge(REVERTS[action].facets(before, after), account, touched);

describe('judging a row of a job to revert', () => {
  const disabled = { before: { enabled: true }, after: { enabled: false } };

  it('reverts what is still as the job left it, and leaves what is back as it was', () => {
    expect(
      verdictOf('user.disable', disabled.before, disabled.after, now({ enabled: false })).kind,
    ).toBe('revert');
    expect(
      verdictOf('user.disable', disabled.before, disabled.after, now({ enabled: true })).kind,
    ).toBe('unchanged');
  });

  it('counts a row written again since as modified, even when changed back', () => {
    const verdict = verdictOf(
      'user.disable',
      disabled.before,
      disabled.after,
      now({ enabled: false }),
      'Changed in the directory since the job',
    );

    expect(verdict).toMatchObject({
      kind: 'modified',
      drift: [],
      changedSince: 'Changed in the directory since the job',
    });
    // Back as it was is done, however it got there.
    expect(verdictOf('user.disable', disabled.before, disabled.after, now(), 'touched').kind).toBe(
      'unchanged',
    );
  });

  it('counts a field changed to something else since as modified', () => {
    const verdict = verdictOf(
      'user.update',
      { department: 'Engineering' },
      { department: 'Sales' },
      now({ attributes: { department: 'Marketing' } }),
    );

    expect(verdict.kind).toBe('modified');
    expect(verdict.drift.map((f) => f.field)).toEqual(['department']);
  });

  it('reverts an expiry the job couldn’t read back, rather than calling it changed', () => {
    const at = '2031-03-01T00:00:00.000Z';
    const verdict = verdictOf(
      'user.accountExpiry.set',
      { accountExpiresAt: null },
      {},
      now({ accountExpiresAt: new Date(at) }),
    );

    expect(verdict.kind).toBe('revert');
    expect(verdict.pending[0]!.after).toBeUndefined();
    expect(verdictOf('user.accountExpiry.set', { accountExpiresAt: null }, {}, now()).kind).toBe(
      'unchanged',
    );
  });

  it('finds an OU by GUID however it’s been renamed since', () => {
    const before = { parentDn: 'OU=Staff,DC=corp', parentGuid: 'STAFF' };
    const after = { parentDn: 'OU=Contractors,DC=corp', parentGuid: 'contractors' };
    const renamed = now({ parent: { dn: 'OU=Vendors,DC=corp', guid: 'contractors' } });
    const elsewhere = now({ parent: { dn: 'OU=Contractors,DC=corp', guid: 'other' } });

    expect(verdictOf('user.move', before, after, renamed).kind).toBe('revert');
    expect(verdictOf('user.move', before, after, elsewhere).kind).toBe('modified');
    expect(
      verdictOf(
        'user.move',
        before,
        after,
        now({ parent: { dn: 'OU=People,DC=corp', guid: 'staff' } }),
      ).kind,
    ).toBe('unchanged');
  });

  it('compares OUs by DN for rows from before GUIDs were kept', () => {
    const before = { parentDn: 'OU=Staff,DC=corp' };
    const after = { parentDn: 'OU=Contractors,DC=corp' };

    expect(
      verdictOf(
        'user.move',
        before,
        after,
        now({ parent: { dn: 'ou=contractors,dc=corp', guid: 'contractors' } }),
      ).kind,
    ).toBe('revert');
  });

  it('finds a manager by GUID however they’ve been renamed since', () => {
    const before = { managerDn: 'CN=Dave,DC=corp', managerGuid: 'dave' };
    const after = { managerDn: 'CN=Erin,DC=corp', managerGuid: 'erin' };
    const facets = REVERTS['user.update'].facets(before, after);

    expect(facets.map((f) => f.field)).toEqual(['manager']);
    expect(
      judge(facets, now({ manager: { dn: 'CN=Erin Evans,DC=corp', guid: 'erin' } }), null).kind,
    ).toBe('revert');
    expect(
      judge(facets, now({ manager: { dn: 'CN=Dave Diaz,DC=corp', guid: 'dave' } }), null).kind,
    ).toBe('unchanged');
    expect(judge(facets, now({ manager: { dn: null, guid: null } }), null).kind).toBe('modified');
  });

  it('reverts a membership the cache still has, and one it hasn’t read', () => {
    const after = { groups: [{ id: 'G1', name: 'Sales', isMember: true }] };

    expect(verdictOf('user.group.add', {}, after, now({ groupIds: new Set(['g1']) })).kind).toBe(
      'revert',
    );
    expect(verdictOf('user.group.add', {}, after, now({ groupIds: new Set() })).kind).toBe(
      'unchanged',
    );
    expect(verdictOf('user.group.add', {}, after, now({ groupIds: null })).kind).toBe('revert');
  });
});
