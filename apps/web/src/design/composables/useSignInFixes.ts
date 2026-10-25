// SPDX-License-Identifier: BUSL-1.1
import { useAuthStore } from '../../stores/auth.js';
import { accountActionFailedSummary } from '../feedback/userToasts.js';
import type { ActionFailure } from '../lib/actionFailure.js';
import { fixFor, type SignInFix, type SignInInput } from '../lib/signIn.js';
import type { AccountAction, AccountActionFailure } from './useAccountActions.js';

export interface FixTarget extends SignInInput {
  id: string;
  displayName: string | null;
  samAccountName: string;
}

/** What this needs of a `useAccountActions` on users. */
interface AccountActions<T> {
  run(action: 'enable' | 'unlock', account: T): void;
  runningOn(id: string): AccountAction | null;
  failureOn(id: string): AccountActionFailure<T> | null;
  retryOn(id: string): void;
  dismissOn(id: string): void;
}

/**
 * The fix offered for a user's most severe sign-in condition, and making
 * it: Unlock and Enable through `actions`, Reset password and Extend
 * expiry by opening their dialogs. The user's page and the dashboard both
 * use it, so they offer and make the same fix the same way.
 */
export function useSignInFixes<T extends FixTarget>(options: {
  actions: AccountActions<T>;
  resetPassword: (u: T) => void;
  extendExpiry: (u: T) => void;
  extendingExpiry: (u: T) => boolean;
}) {
  const auth = useAuthStore();
  const { actions } = options;

  const fixOf = (u: T): SignInFix | null => fixFor(u, auth.hasCapability);

  function run(fix: SignInFix, u: T): void {
    switch (fix.fix) {
      case 'enable':
      case 'unlock':
        actions.run(fix.fix, u);
        break;
      case 'reset-password':
        options.resetPassword(u);
        break;
      case 'extend-expiry':
        options.extendExpiry(u);
        break;
    }
  }

  function running(fix: SignInFix, u: T): boolean {
    if (fix.fix === 'enable' || fix.fix === 'unlock') return actions.runningOn(u.id) === fix.fix;
    return fix.fix === 'extend-expiry' && options.extendingExpiry(u);
  }

  /** A failed Unlock, Enable or Disable of the account with this id. */
  function actionFailureOn(id: string): ActionFailure | null {
    const f = actions.failureOn(id);
    if (!f) return null;
    return {
      summary: accountActionFailedSummary(f.op.action, f.op.account),
      message: f.message,
      retry: () => actions.retryOn(id),
      dismiss: () => actions.dismissOn(id),
    };
  }

  return { fixOf, run, running, actionFailureOn };
}
