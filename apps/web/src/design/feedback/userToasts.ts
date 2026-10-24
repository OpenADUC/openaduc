// SPDX-License-Identifier: BUSL-1.1
// What a write to a user says when it lands or fails, wherever it was made.
import type { UserCreateResponse } from '@openaduc/shared';
import type { ToastMessageOptions } from 'primevue/toast';
import type { AccountAction } from '../composables/useAccountActions.js';
import type { ResetOutcome } from '../composables/usePasswordReset.js';
import type { UndoOffer } from '../lib/undoableWrite.js';
import { expiryText } from '../lib/accountExpiry.js';
import { fmtAbsolute, nameOf } from '../lib/format.js';
import { undoable, type UndoableToastMessage } from './undoToast.js';

/** The account as it was before the action; a list row has no lockout details. */
interface ActedOn {
  displayName: string | null;
  samAccountName: string;
  lockedAt?: string | null;
  autoUnlockAt?: string | null;
}

const ACCOUNT_ACTION_TEXT: Record<AccountAction, { done: string; verb: string }> = {
  unlock: { done: 'Unlocked', verb: 'unlock' },
  enable: { done: 'Enabled', verb: 'enable' },
  disable: { done: 'Disabled', verb: 'disable' },
};

// The account is as it was before the unlock, so this can still say when it
// was locked even though the reload clears that.
function unlockedDetail(u: ActedOn): string {
  const detail = [`${nameOf(u)} can sign in now.`];
  if (u.lockedAt) detail.push(`Was locked at ${fmtAbsolute(u.lockedAt)}.`);
  if (u.autoUnlockAt) detail.push(`Would have auto-unlocked at ${fmtAbsolute(u.autoUnlockAt)}.`);
  return detail.join(' ');
}

export function accountActionToast(
  action: AccountAction,
  u: ActedOn,
  offer: UndoOffer,
): UndoableToastMessage {
  return undoable(
    {
      severity: 'success',
      summary: `${ACCOUNT_ACTION_TEXT[action].done} ${nameOf(u)}`,
      detail: action === 'unlock' ? unlockedDetail(u) : undefined,
      life: action === 'unlock' ? 5000 : 3000,
    },
    offer,
  );
}

export function accountActionFailedSummary(action: AccountAction, u: ActedOn): string {
  return `Couldn’t ${ACCOUNT_ACTION_TEXT[action].verb} ${nameOf(u)}`;
}

export function passwordResetToast(outcome: ResetOutcome): ToastMessageOptions {
  return {
    severity: 'success',
    summary: outcome.unlocked ? 'Password reset and account unlocked' : 'Password reset',
    detail: outcome.forceChangeAtNextLogin
      ? 'User must change it at next sign-in'
      : 'New password is in effect',
    life: 4000,
  };
}

export const expirySetSummary = (name: string, expiresAt: string | null) =>
  `${name} now ${expiryText(expiresAt)}`;

export const expiryFailedSummary = (name: string) =>
  `Couldn’t change when ${name}’s account expires`;

/** The success toast for a new user, wherever it was created from. */
export function userCreatedToast(created: UserCreateResponse): ToastMessageOptions {
  const enabled = created.completed.includes('enable');
  return {
    severity: 'success',
    summary: 'User created',
    detail: `${created.samAccountName} was created${enabled ? '' : ', disabled'}.`,
    life: 4000,
  };
}
