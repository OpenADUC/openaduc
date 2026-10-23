// SPDX-License-Identifier: BUSL-1.1
// Why a user can't sign in, from what the API has cached for the account,
// and the write that fixes it.
import type { Capability, UserDetail } from '@openaduc/shared';
import { fmtAbsolute, fmtRelative } from './format.js';

export type SignInInput = Pick<
  UserDetail,
  | 'enabled'
  | 'modifiedAtSource'
  | 'locked'
  | 'lockedAt'
  | 'autoUnlockAt'
  | 'lockedUntilUnlocked'
  | 'badPasswordCount'
  | 'passwordNeverExpires'
  | 'passwordExpiresAt'
  | 'passwordMustChange'
  | 'accountExpiresAt'
>;

export type LockoutEnd = { at: string } | 'when-unlocked' | 'unknown';

export type SignInBlocker =
  // AD doesn't record when an account was disabled; its last change is the
  // closest it has.
  | { kind: 'disabled'; changedAt: string | null }
  | { kind: 'locked'; since: string | null; badPasswords: number | null; ends: LockoutEnd }
  | { kind: 'password-expired'; since: string }
  | { kind: 'account-expired'; since: string }
  | { kind: 'must-change-password' };

export type SignInFixKind = 'enable' | 'unlock' | 'reset-password' | 'extend-expiry';

export interface SignInFix {
  fix: SignInFixKind;
  label: string;
  icon: string;
  capability: Capability;
}

const past = (iso: string | null, now: Date): iso is string =>
  iso !== null && new Date(iso).getTime() <= now.getTime();

/**
 * What keeps the account from signing in, most severe first: fixing a
 * later one doesn't help while an earlier one stands.
 */
export function signInBlockers(u: SignInInput, now: Date = new Date()): SignInBlocker[] {
  const blockers: SignInBlocker[] = [];
  if (!u.enabled) blockers.push({ kind: 'disabled', changedAt: u.modifiedAtSource });
  if (u.locked) {
    blockers.push({
      kind: 'locked',
      since: u.lockedAt,
      badPasswords: u.badPasswordCount,
      ends: u.autoUnlockAt
        ? { at: u.autoUnlockAt }
        : u.lockedUntilUnlocked
          ? 'when-unlocked'
          : 'unknown',
    });
  }
  // A must-change password reads as expired too; the must-change says more.
  if (!u.passwordNeverExpires && !u.passwordMustChange && past(u.passwordExpiresAt, now)) {
    blockers.push({ kind: 'password-expired', since: u.passwordExpiresAt });
  }
  if (past(u.accountExpiresAt, now)) {
    blockers.push({ kind: 'account-expired', since: u.accountExpiresAt });
  }
  if (u.passwordMustChange) blockers.push({ kind: 'must-change-password' });
  return blockers;
}

const FIXES: Record<SignInBlocker['kind'], SignInFix> = {
  disabled: {
    fix: 'enable',
    label: 'Enable',
    icon: 'pi-check',
    capability: 'write:user.enableDisable',
  },
  locked: { fix: 'unlock', label: 'Unlock', icon: 'pi-unlock', capability: 'write:user.unlock' },
  'password-expired': {
    fix: 'reset-password',
    label: 'Reset password',
    icon: 'pi-key',
    capability: 'write:user.resetPassword',
  },
  'account-expired': {
    fix: 'extend-expiry',
    label: 'Extend expiry',
    icon: 'pi-calendar-plus',
    capability: 'write:user.enableDisable',
  },
  // Sign-ins that can't ask for a new password fail until it changes; the
  // helpdesk's fix is a new password, with or without the change required.
  'must-change-password': {
    fix: 'reset-password',
    label: 'Reset password',
    icon: 'pi-key',
    capability: 'write:user.resetPassword',
  },
};

export function signInFix(b: SignInBlocker): SignInFix {
  return FIXES[b.kind];
}

const when = (iso: string, now: Date) => `${fmtAbsolute(iso)} (${fmtRelative(iso, now)})`;

/** How a lockout ends, or null when the domain's policy couldn't be read. */
export function lockoutEnd(b: { ends: LockoutEnd }, now: Date = new Date()): string | null {
  if (b.ends === 'unknown') return null;
  if (b.ends === 'when-unlocked') return 'Stays locked until someone unlocks it';
  return `Unlocks on its own ${when(b.ends.at, now)}`;
}

export function describeBlocker(
  b: SignInBlocker,
  now: Date = new Date(),
): { title: string; details: string[] } {
  switch (b.kind) {
    case 'disabled':
      return {
        title: 'Disabled',
        details: b.changedAt ? [`Account last changed ${when(b.changedAt, now)}`] : [],
      };
    case 'locked': {
      const details: string[] = [];
      if (b.since) details.push(`Since ${when(b.since, now)}`);
      if (b.badPasswords !== null) {
        details.push(`${b.badPasswords} bad password${b.badPasswords === 1 ? '' : 's'}`);
      }
      const end = lockoutEnd(b, now);
      if (end) details.push(end);
      return { title: 'Locked', details };
    }
    case 'password-expired':
      return { title: 'Password expired', details: [`Since ${when(b.since, now)}`] };
    case 'account-expired':
      return { title: 'Account expired', details: [`Since ${when(b.since, now)}`] };
    case 'must-change-password':
      return {
        title: 'Must change password at next sign-in',
        details: [
          'Sign-ins that can’t ask for a new password, such as many VPNs and web apps, fail until it’s changed',
        ],
      };
  }
}
