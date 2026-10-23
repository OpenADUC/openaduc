// SPDX-License-Identifier: BUSL-1.1
import { ref } from 'vue';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';

export type AccountAction = 'disable' | 'enable' | 'unlock';

const CALLS: Record<AccountAction, (id: string) => Promise<unknown>> = {
  disable: (id) => api.users.disable(id),
  enable: (id) => api.users.enable(id),
  unlock: (id) => api.users.unlock(id),
};

/**
 * Disable, enable or unlock accounts, one action at a time per account.
 * `onDone` gets the account the action ran on, as the caller passed it, so
 * it can refresh and describe it.
 */
export function useAccountActions<T extends { id: string }>(options: {
  onDone: (action: AccountAction, account: T) => void | Promise<void>;
  onFailed: (action: AccountAction, account: T, message: string) => void | Promise<void>;
}) {
  const auth = useAuthStore();
  const running = ref(new Map<string, AccountAction>());
  const runningOn = (id: string): AccountAction | null => running.value.get(id) ?? null;

  /** `after` runs once the action lands, after `onDone`, including after a step-up. */
  function run(action: AccountAction, account: T, after?: () => void | Promise<void>): void {
    if (runningOn(account.id)) return;
    auth.requireStepUp(() => commit(action, account, after));
  }

  async function commit(
    action: AccountAction,
    account: T,
    after?: () => void | Promise<void>,
  ): Promise<void> {
    if (runningOn(account.id)) return;
    running.value.set(account.id, action);
    try {
      try {
        await CALLS[action](account.id);
      } catch (err) {
        if (auth.retryAfterStepUp(err, () => commit(action, account, after))) return;
        await options.onFailed(
          action,
          account,
          err instanceof ApiError ? err.message : String(err),
        );
        return;
      }
      await options.onDone(action, account);
      await after?.();
    } finally {
      running.value.delete(account.id);
    }
  }

  return { runningOn, run };
}
