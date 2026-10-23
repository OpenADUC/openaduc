// SPDX-License-Identifier: BUSL-1.1
import { ref, shallowRef } from 'vue';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';

export type AccountAction = 'disable' | 'enable' | 'unlock';

const CALLS: Record<AccountAction, (id: string) => Promise<unknown>> = {
  disable: (id) => api.users.disable(id),
  enable: (id) => api.users.enable(id),
  unlock: (id) => api.users.unlock(id),
};

// An unlock can't be undone: there is no write that locks an account.
const INVERSE: Partial<Record<AccountAction, AccountAction>> = {
  disable: 'enable',
  enable: 'disable',
};

export interface AccountActionFailure<T> {
  action: AccountAction;
  account: T;
  message: string;
}

/**
 * Disable, enable or unlock accounts, one action at a time per account.
 * `onDone` gets the account the action ran on, as the caller passed it, so
 * it can refresh and describe it, and `undo`, which runs the inverse action
 * the same way. `undo` is null for an unlock and for an undo.
 *
 * The last failure stays in `failure` until it's retried, dismissed or
 * another action starts.
 */
export function useAccountActions<T extends { id: string }>(options: {
  onDone: (action: AccountAction, account: T, undo: (() => void) | null) => void | Promise<void>;
  onFailed?: (action: AccountAction, account: T, message: string) => void | Promise<void>;
}) {
  const auth = useAuthStore();
  const running = ref(new Map<string, AccountAction>());
  const runningOn = (id: string): AccountAction | null => running.value.get(id) ?? null;
  const failure = shallowRef<AccountActionFailure<T> | null>(null);
  let retryFailed: (() => void) | null = null;

  /** `after` runs once the action lands, after `onDone`, including after a step-up. */
  function run(action: AccountAction, account: T, after?: () => void | Promise<void>): void {
    start(action, account, false, after);
  }

  function start(
    action: AccountAction,
    account: T,
    undoing: boolean,
    after?: () => void | Promise<void>,
  ): void {
    if (runningOn(account.id)) return;
    auth.requireStepUp(() => commit(action, account, undoing, after));
  }

  async function commit(
    action: AccountAction,
    account: T,
    undoing: boolean,
    after?: () => void | Promise<void>,
  ): Promise<void> {
    if (runningOn(account.id)) return;
    running.value.set(account.id, action);
    dismiss();
    try {
      try {
        await CALLS[action](account.id);
      } catch (err) {
        if (auth.retryAfterStepUp(err, () => commit(action, account, undoing, after))) return;
        const message = err instanceof ApiError ? err.message : String(err);
        failure.value = { action, account, message };
        retryFailed = () => start(action, account, undoing, after);
        await options.onFailed?.(action, account, message);
        return;
      }
      const inverse = undoing ? undefined : INVERSE[action];
      await options.onDone(action, account, inverse ? () => start(inverse, account, true) : null);
      await after?.();
    } finally {
      running.value.delete(account.id);
    }
  }

  function retry(): void {
    retryFailed?.();
  }

  function dismiss(): void {
    failure.value = null;
    retryFailed = null;
  }

  return { runningOn, run, failure, retry, dismiss };
}
