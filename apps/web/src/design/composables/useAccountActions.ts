// SPDX-License-Identifier: BUSL-1.1
import { api } from '../../api/index.js';
import { useUndoableWrite, type UndoOffer, type WriteFailure } from '../lib/undoableWrite.js';

export type AccountAction = 'disable' | 'enable' | 'unlock';
export type AccountKind = 'user' | 'computer';

const CALLS: Record<
  AccountKind,
  Partial<Record<AccountAction, (id: string) => Promise<unknown>>>
> = {
  user: {
    disable: (id) => api.users.disable(id),
    enable: (id) => api.users.enable(id),
    unlock: (id) => api.users.unlock(id),
  },
  computer: {
    disable: (id) => api.computers.disable(id),
    enable: (id) => api.computers.enable(id),
  },
};

// An unlock can't be undone: there is no write that locks an account.
const INVERSE: Record<AccountAction, AccountAction | null> = {
  disable: 'enable',
  enable: 'disable',
  unlock: null,
};

export interface AccountActionRun<T> {
  action: AccountAction;
  account: T;
}

export type AccountActionFailure<T> = WriteFailure<AccountActionRun<T>>;

/**
 * Disable, enable or unlock accounts, one action at a time per account:
 * users by default, or computers (which have no unlock) with `kind`.
 * `onDone` gets the account the action ran on, as the caller passed it, so
 * it can refresh and describe it, and the offer of Undo (none for an
 * unlock). The last failure stays in `failure` until it's retried,
 * dismissed or another action starts.
 */
export function useAccountActions<T extends { id: string }>(options: {
  kind?: AccountKind;
  onDone: (action: AccountAction, account: T, offer: UndoOffer) => void | Promise<void>;
  onFailed?: (failure: AccountActionFailure<T>) => void | Promise<void>;
}) {
  const kind = options.kind ?? 'user';
  const writes = useUndoableWrite<AccountActionRun<T>>({
    write: ({ action, account }) => {
      const call = CALLS[kind][action];
      if (!call) throw new Error(`A ${kind} account can’t be ${action}ed.`);
      return call(account.id);
    },
    inverse: ({ action, account }) => {
      const inverse = INVERSE[action];
      return inverse ? { action: inverse, account } : null;
    },
    key: ({ account }) => account.id,
    onDone: ({ action, account }, offer) => options.onDone(action, account, offer),
    onFailed: options.onFailed,
  });

  const runningOn = (id: string): AccountAction | null => writes.runningOn(id)?.action ?? null;

  /** `after` runs once the action lands, after `onDone`, including after a step-up. */
  function run(action: AccountAction, account: T, after?: () => void | Promise<void>): void {
    writes.run({ action, account }, after);
  }

  return {
    runningOn,
    run,
    failure: writes.failure,
    retry: writes.retry,
    dismiss: writes.dismiss,
  };
}
