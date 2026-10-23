// SPDX-License-Identifier: BUSL-1.1
// Why a user can't sign in, from the account as the API last read it, and
// the write that fixes it.
import type { Capability } from '@openaduc/shared';
import { fmtAbsolute, fmtRelative } from './format.js';

/**
 * The account as far as signing in goes. A list row has the summary
 * fields; a user's page also has the lockout details.
 */
export interface SignInInput {
  enabled?: boolean | null;
  locked?: boolean | null;
  passwordNeverExpires?: boolean | null;
  passwordExpiresAt?: string | null;
  passwordMustChange?: boolean | null;
  accountExpiresAt?: string | null;
  modifiedAtSource?: string | null;
  lockedAt?: string | null;
  autoUnlockAt?: string | null;
  lockedUntilUnlocked?: boolean | null;
  badPasswordCount?: number | null;
}

export type UserStatusKind =
  'active' | 'disabled' | 'locked' | 'pwd-must-change' | 'pwd-expired' | 'pwd-expiring' | 'expired';

export type LockoutEnd = { at: string } | 'when-unlocked' | 'unknown';

export type SignInBlocker =
  // AD doesn't record when an account was disabled; its last change is the
  // closest it has.
  | { kind: 'disabled'; changedAt: string | null }
  | { kind: 'locked'; since: string | null; badPasswords: number | null; ends: LockoutEnd }
  | { kind: 'password-expired'; since: string }
  | { kind: 'account-expired'; since: string }
  | { kind: 'must-change-password' };

type Kind = SignInBlocker['kind'];

export type SignInFixKind = 'enable' | 'unlock' | 'reset-password' | 'extend-expiry';

export interface SignInFix {
  fix: SignInFixKind;
  label: string;
  icon: string;
  capability: Capability;
}

const past = (iso: string | null | undefined, now: Date): iso is string =>
  !!iso && new Date(iso).getTime() <= now.getTime();

/**
 * What keeps the account from signing in, most severe first: fixing a
 * later one doesn't help while an earlier one stands.
 */
export function signInBlockers(u: SignInInput, now: Date = new Date()): SignInBlocker[] {
  const blockers: SignInBlocker[] = [];
  if (u.enabled === false)
    blockers.push({ kind: 'disabled', changedAt: u.modifiedAtSource ?? null });
  if (u.locked) {
    blockers.push({
      kind: 'locked',
      since: u.lockedAt ?? null,
      badPasswords: u.badPasswordCount ?? null,
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

const when = (iso: string, now: Date) => `${fmtAbsolute(iso)} (${fmtRelative(iso, now)})`;

/** How a lockout ends, or null when the domain's policy couldn't be read. */
export function lockoutEnd(b: { ends: LockoutEnd }, now: Date = new Date()): string | null {
  if (b.ends === 'unknown') return null;
  if (b.ends === 'when-unlocked') return 'Stays locked until someone unlocks it';
  return `Unlocks on its own ${when(b.ends.at, now)}`;
}

const RESET_PASSWORD: SignInFix = {
  fix: 'reset-password',
  label: 'Reset password',
  icon: 'pi-key',
  capability: 'write:user.resetPassword',
};

/** Everything said about a condition, and the fix offered for it. */
const CONDITIONS: {
  [K in Kind]: {
    title: string;
    icon: string;
    /** The status badge that names it. */
    badge: UserStatusKind;
    fix: SignInFix;
    details: (b: Extract<SignInBlocker, { kind: K }>, now: Date) => string[];
  };
} = {
  disabled: {
    title: 'Disabled',
    icon: 'pi-ban',
    badge: 'disabled',
    fix: {
      fix: 'enable',
      label: 'Enable',
      icon: 'pi-check',
      capability: 'write:user.enableDisable',
    },
    details: (b, now) => (b.changedAt ? [`Account last changed ${when(b.changedAt, now)}`] : []),
  },
  locked: {
    title: 'Locked',
    icon: 'pi-lock',
    badge: 'locked',
    fix: { fix: 'unlock', label: 'Unlock', icon: 'pi-unlock', capability: 'write:user.unlock' },
    details: (b, now) => {
      const details: string[] = [];
      if (b.since) details.push(`Since ${when(b.since, now)}`);
      // badPwdCount isn't replicated: the DC that answered may count 0 for
      // a lockout another DC made, so a 0 says nothing.
      if (b.badPasswords) {
        details.push(`${b.badPasswords} bad password${b.badPasswords === 1 ? '' : 's'}`);
      }
      const end = lockoutEnd(b, now);
      if (end) details.push(end);
      return details;
    },
  },
  'password-expired': {
    title: 'Password expired',
    icon: 'pi-key',
    badge: 'pwd-expired',
    fix: RESET_PASSWORD,
    details: (b, now) => [`Since ${when(b.since, now)}`],
  },
  'account-expired': {
    title: 'Account expired',
    icon: 'pi-calendar-times',
    badge: 'expired',
    fix: {
      fix: 'extend-expiry',
      label: 'Extend expiry',
      icon: 'pi-calendar-plus',
      capability: 'write:user.enableDisable',
    },
    details: (b, now) => [`Since ${when(b.since, now)}`],
  },
  // Sign-ins that can't ask for a new password fail until it changes; the
  // helpdesk's fix is a new password, with or without the change required.
  'must-change-password': {
    title: 'Must change password at next sign-in',
    icon: 'pi-key',
    badge: 'pwd-must-change',
    fix: RESET_PASSWORD,
    details: () => [
      'Sign-ins that can’t ask for a new password, such as many VPNs and web apps, fail until it’s changed',
    ],
  },
};

export function signInFix(b: SignInBlocker): SignInFix {
  return CONDITIONS[b.kind].fix;
}

export function describeBlocker(
  b: SignInBlocker,
  now: Date = new Date(),
): { title: string; icon: string; details: string[] } {
  const { title, icon, details } = CONDITIONS[b.kind];
  // TypeScript can't pair the row's `details` with this blocker's kind.
  const describe = details as (b: SignInBlocker, now: Date) => string[];
  return { title, icon, details: describe(b, now) };
}

const EXPIRING_SOON_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The one word for an account's state, wherever it's shown: the most severe
 * condition stopping sign-in, else a password expiring within two weeks.
 */
export function userStatus(u: SignInInput, now: Date = new Date()): UserStatusKind {
  const top = signInBlockers(u, now)[0];
  if (top) return CONDITIONS[top.kind].badge;
  if (
    !u.passwordNeverExpires &&
    u.passwordExpiresAt &&
    Date.parse(u.passwordExpiresAt) - now.getTime() <= EXPIRING_SOON_MS
  ) {
    return 'pwd-expiring';
  }
  return 'active';
}

export function userStatusLabel(kind: UserStatusKind): string {
  return {
    active: 'Active',
    disabled: 'Disabled',
    locked: 'Locked',
    'pwd-must-change': 'Must change password',
    'pwd-expired': 'Password expired',
    'pwd-expiring': 'Expires soon',
    expired: 'Expired',
  }[kind];
}
