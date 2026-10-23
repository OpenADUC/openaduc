// SPDX-License-Identifier: BUSL-1.1
import { api } from '../../api/index.js';
import { useUndoableWrite, type UndoOffer, type WriteFailure } from '../lib/undoableWrite.js';

export type AccountAction = 'disable' | 'enable' | 'unlock';
export type AccountKind = 'user' | 'computer';

type Call = (id: string) => Promise<unknown>;

const CALLS = {
  user: {
    disable: (id) => api.users.disable(id),
    enable: (id) => api.users.enable(id),
    unlock: (id) => api.users.unlock(id),
  },
  computer: {
    disable: (id) => api.computers.disable(id),
    enable: (id) => api.computers.enable(id),
  },
} satisfies Record<AccountKind, Partial<Record<AccountAction, Call>>>;

/** The actions an account of this kind has: a computer has no unlock. */
export type ActionOn<K extends AccountKind> = keyof (typeof CALLS)[K] & AccountAction;

// An unlock can't be undone: there is no write that locks an account.
const INVERSE = { disable: 'enable', enable: 'disable', unlock: null } as const;

export interface AccountActionRun<T, A extends AccountAction = AccountAction> {
  action: A;
  account: T;
}

export type AccountActionFailure<T, A extends AccountAction = AccountAction> = WriteFailure<
  AccountActionRun<T, A>
>;

/**
 * Disable, enable or unlock accounts, one action at a time per account:
 * users by default, or computers (which have no unlock) with `kind`.
 * `onDone` gets the account the action ran on, as the caller passed it, so
 * it can refresh and describe it, and the offer of Undo (none for an
 * unlock). The last failure stays in `failure` until it's retried,
 * dismissed or another action starts; with `failuresPerAccount`, each
 * account's stays in `failureOn(id)` until one on that account does.
 */
export function useAccountActions<
  T extends { id: string },
  K extends AccountKind = 'user',
>(options: {
  kind?: K;
  onDone: (action: ActionOn<K>, account: T, offer: UndoOffer) => void | Promise<void>;
  onFailed?: (failure: AccountActionFailure<T, ActionOn<K>>) => void | Promise<void>;
  failuresPerAccount?: boolean;
}) {
  type A = ActionOn<K>;
  // `kind` defaults to 'user' exactly when K does.
  const calls = CALLS[options.kind ?? 'user'] as Record<A, Call>;
  const writes = useUndoableWrite<AccountActionRun<T, A>>({
    write: ({ action, account }) => calls[action](account.id),
    inverse: ({ action, account }) => {
      const inverse = INVERSE[action] as A | null;
      return inverse ? { action: inverse, account } : null;
    },
    key: ({ account }) => account.id,
    onDone: ({ action, account }, offer) => options.onDone(action, account, offer),
    onFailed: options.onFailed,
    failuresPerKey: options.failuresPerAccount,
  });

  const runningOn = (id: string): A | null => writes.runningOn(id)?.action ?? null;

  /** `after` runs once the action lands, after `onDone`, including after a step-up. */
  function run(action: A, account: T, after?: () => void | Promise<void>): void {
    writes.run({ action, account }, after);
  }

  return {
    runningOn,
    run,
    failure: writes.failure,
    failureOn: writes.failureOn,
    retry: writes.retry,
    dismiss: writes.dismiss,
    retryOn: writes.retryOn,
    dismissOn: writes.dismissOn,
  };
}
