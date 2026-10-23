// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { aUserDetail } from '../../test/userDetail.js';
import {
  describeBlocker,
  lockoutEnd,
  signInBlockers,
  signInFix,
  userStatus,
  type SignInBlocker,
} from './signIn.js';

const NOW = new Date('2026-10-23T12:00:00.000Z');
const HOUR_AGO = '2026-10-23T11:00:00.000Z';
const IN_AN_HOUR = '2026-10-23T13:00:00.000Z';
const kinds = (b: SignInBlocker[]) => b.map((x) => x.kind);

describe('signInBlockers', () => {
  it('finds nothing for an account that can sign in', () => {
    expect(signInBlockers(aUserDetail({ passwordExpiresAt: IN_AN_HOUR }), NOW)).toEqual([]);
  });

  it('finds a disabled account, with when it last changed', () => {
    expect(
      signInBlockers(aUserDetail({ enabled: false, modifiedAtSource: HOUR_AGO }), NOW),
    ).toEqual([{ kind: 'disabled', changedAt: HOUR_AGO }]);
  });

  it('finds a lockout that ends on its own', () => {
    const u = aUserDetail({
      locked: true,
      lockedAt: HOUR_AGO,
      autoUnlockAt: IN_AN_HOUR,
      badPasswordCount: 5,
    });
    expect(signInBlockers(u, NOW)).toEqual([
      { kind: 'locked', since: HOUR_AGO, badPasswords: 5, ends: { at: IN_AN_HOUR } },
    ]);
  });

  it('finds a lockout that lasts until someone unlocks the account', () => {
    const u = aUserDetail({ locked: true, lockedAt: HOUR_AGO, lockedUntilUnlocked: true });
    expect(signInBlockers(u, NOW)).toEqual([
      { kind: 'locked', since: HOUR_AGO, badPasswords: null, ends: 'when-unlocked' },
    ]);
  });

  it('doesn’t guess when a lockout ends without the policy', () => {
    const [b] = signInBlockers(aUserDetail({ locked: true }), NOW);
    expect(b).toMatchObject({ kind: 'locked', ends: 'unknown' });
  });

  it('finds an expired password, with since when', () => {
    expect(signInBlockers(aUserDetail({ passwordExpiresAt: HOUR_AGO }), NOW)).toEqual([
      { kind: 'password-expired', since: HOUR_AGO },
    ]);
  });

  it('ignores a past password expiry when the password never expires', () => {
    const u = aUserDetail({ passwordExpiresAt: HOUR_AGO, passwordNeverExpires: true });
    expect(signInBlockers(u, NOW)).toEqual([]);
  });

  it('finds an expired account, with since when', () => {
    expect(signInBlockers(aUserDetail({ accountExpiresAt: HOUR_AGO }), NOW)).toEqual([
      { kind: 'account-expired', since: HOUR_AGO },
    ]);
    expect(signInBlockers(aUserDetail({ accountExpiresAt: IN_AN_HOUR }), NOW)).toEqual([]);
  });

  it('finds a password that must change at next sign-in', () => {
    expect(signInBlockers(aUserDetail({ passwordMustChange: true }), NOW)).toEqual([
      { kind: 'must-change-password' },
    ]);
  });

  it('puts the most severe first when several apply', () => {
    const u = aUserDetail({
      enabled: false,
      locked: true,
      passwordExpiresAt: HOUR_AGO,
      accountExpiresAt: HOUR_AGO,
    });
    expect(kinds(signInBlockers(u, NOW))).toEqual([
      'disabled',
      'locked',
      'password-expired',
      'account-expired',
    ]);
    expect(
      kinds(
        signInBlockers(aUserDetail({ accountExpiresAt: HOUR_AGO, passwordMustChange: true }), NOW),
      ),
    ).toEqual(['account-expired', 'must-change-password']);
  });

  it('calls a password that must change just that, not expired too', () => {
    const u = aUserDetail({ passwordMustChange: true, passwordExpiresAt: HOUR_AGO });
    expect(kinds(signInBlockers(u, NOW))).toEqual(['must-change-password']);
  });
});

describe('signInFix', () => {
  it('fixes each condition with its own write', () => {
    const fix = (b: SignInBlocker) => signInFix(b);
    expect(fix({ kind: 'disabled', changedAt: null })).toMatchObject({
      fix: 'enable',
      label: 'Enable',
      capability: 'write:user.enableDisable',
    });
    expect(
      fix({ kind: 'locked', since: null, badPasswords: null, ends: 'when-unlocked' }),
    ).toMatchObject({ fix: 'unlock', label: 'Unlock', capability: 'write:user.unlock' });
    expect(fix({ kind: 'password-expired', since: HOUR_AGO })).toMatchObject({
      fix: 'reset-password',
      label: 'Reset password',
      capability: 'write:user.resetPassword',
    });
    expect(fix({ kind: 'account-expired', since: HOUR_AGO })).toMatchObject({
      fix: 'extend-expiry',
      label: 'Extend expiry',
      capability: 'write:user.enableDisable',
    });
    expect(fix({ kind: 'must-change-password' })).toMatchObject({
      fix: 'reset-password',
      capability: 'write:user.resetPassword',
    });
  });
});

describe('lockoutEnd', () => {
  it('says when a lockout ends, or that it lasts until someone unlocks it', () => {
    expect(lockoutEnd({ ends: { at: IN_AN_HOUR } }, NOW)).toBe(
      `Unlocks on its own ${new Date(IN_AN_HOUR).toLocaleString()} (in 1h)`,
    );
    expect(lockoutEnd({ ends: 'when-unlocked' }, NOW)).toBe(
      'Stays locked until someone unlocks it',
    );
    expect(lockoutEnd({ ends: 'unknown' }, NOW)).toBeNull();
  });
});

describe('describeBlocker', () => {
  const at = (iso: string) => new Date(iso).toLocaleString();

  it('names each condition with its timing', () => {
    expect(describeBlocker({ kind: 'disabled', changedAt: HOUR_AGO }, NOW)).toMatchObject({
      title: 'Disabled',
      details: [`Account last changed ${at(HOUR_AGO)} (1h ago)`],
    });
    expect(
      describeBlocker(
        { kind: 'locked', since: HOUR_AGO, badPasswords: 5, ends: 'when-unlocked' },
        NOW,
      ),
    ).toMatchObject({
      title: 'Locked',
      details: [
        `Since ${at(HOUR_AGO)} (1h ago)`,
        '5 bad passwords',
        'Stays locked until someone unlocks it',
      ],
    });
    expect(describeBlocker({ kind: 'password-expired', since: HOUR_AGO }, NOW)).toMatchObject({
      title: 'Password expired',
      details: [`Since ${at(HOUR_AGO)} (1h ago)`],
    });
    expect(describeBlocker({ kind: 'account-expired', since: HOUR_AGO }, NOW)).toMatchObject({
      title: 'Account expired',
      details: [`Since ${at(HOUR_AGO)} (1h ago)`],
    });
    expect(describeBlocker({ kind: 'must-change-password' }, NOW).title).toBe(
      'Must change password at next sign-in',
    );
  });

  it('leaves out what isn’t known', () => {
    expect(describeBlocker({ kind: 'disabled', changedAt: null }, NOW).details).toEqual([]);
    expect(
      describeBlocker({ kind: 'locked', since: null, badPasswords: 1, ends: 'unknown' }, NOW)
        .details,
    ).toEqual(['1 bad password']);
  });
});

describe('userStatus', () => {
  const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

  it('names the most severe condition, as the user’s page leads with it', () => {
    expect(userStatus({ enabled: false, locked: true }, NOW)).toBe('disabled');
    expect(userStatus({ enabled: true, locked: true, passwordMustChange: true }, NOW)).toBe(
      'locked',
    );
    expect(
      userStatus({ enabled: true, passwordExpiresAt: days(-1), accountExpiresAt: days(-1) }, NOW),
    ).toBe('pwd-expired');
    expect(
      userStatus({ enabled: true, accountExpiresAt: days(-1), passwordMustChange: true }, NOW),
    ).toBe('expired');
    expect(userStatus({ enabled: true, passwordMustChange: true }, NOW)).toBe('pwd-must-change');
  });

  it('falls back to a password expiring within two weeks', () => {
    expect(userStatus({ enabled: true, passwordExpiresAt: days(5) }, NOW)).toBe('pwd-expiring');
    expect(userStatus({ enabled: true, passwordExpiresAt: days(30) }, NOW)).toBe('active');
    expect(
      userStatus({ enabled: true, passwordExpiresAt: days(5), passwordNeverExpires: true }, NOW),
    ).toBe('active');
  });
});
