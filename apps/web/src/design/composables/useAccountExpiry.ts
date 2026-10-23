// SPDX-License-Identifier: BUSL-1.1
import { computed, ref } from 'vue';
import { api } from '../../api/index.js';
import { expiryAtEndOf, lastDayOf } from '../lib/accountExpiry.js';
import { useUndoableWrite, type UndoOffer, type WriteFailure } from '../lib/undoableWrite.js';

/** The account whose expiry changes, with the name to call it by. */
export interface ExpirySubject {
  id: string;
  name: string;
  accountExpiresAt: string | null;
}

export interface ExpiryRun {
  /** As it was before the write, so Undo can put its expiry back. */
  account: ExpirySubject;
  expiresAt: string | null;
}

export type ExpiryFailure = WriteFailure<ExpiryRun>;

/**
 * Set when a user's account expires, or that it never does. The operator
 * picks the last day it works; `onSet` gets the offer of Undo, which puts
 * the previous expiry back the same way. A failed write stays in
 * `failure` until it's retried, dismissed or the next load.
 */
export function useAccountExpiry(options: {
  onSet: (
    account: ExpirySubject,
    expiresAt: string | null,
    offer: UndoOffer,
  ) => void | Promise<void>;
  onFailed?: (failure: ExpiryFailure) => void | Promise<void>;
}) {
  const account = ref<ExpirySubject | null>(null);
  const never = ref(false);
  const endOf = ref<Date | null>(null);

  const writes = useUndoableWrite<ExpiryRun>({
    write: ({ account: a, expiresAt }) => api.users.setAccountExpiry(a.id, { expiresAt }),
    inverse: ({ account: a, expiresAt }) => ({
      account: { ...a, accountExpiresAt: expiresAt },
      expiresAt: a.accountExpiresAt,
    }),
    key: ({ account: a }) => a.id,
    onDone: ({ account: a, expiresAt }, offer) => options.onSet(a, expiresAt, offer),
    onFailed: options.onFailed,
  });
  const submitting = computed(
    () => (account.value ? writes.runningOn(account.value.id) : null) !== null,
  );

  const expiresAt = computed(() =>
    never.value ? null : endOf.value ? expiryAtEndOf(endOf.value) : undefined,
  );
  const ready = computed(() => {
    const next = expiresAt.value;
    if (!account.value || next === undefined || submitting.value) return false;
    if (next !== null && Date.parse(next) <= Date.now()) return false;
    return next !== account.value.accountExpiresAt;
  });

  function load(subject: ExpirySubject): void {
    account.value = subject;
    const current = subject.accountExpiresAt;
    never.value = current === null;
    endOf.value = current && Date.parse(current) > Date.now() ? lastDayOf(current) : null;
    writes.dismiss();
  }

  function submit(): void {
    const next = expiresAt.value;
    if (!ready.value || next === undefined) return;
    writes.run({ account: account.value!, expiresAt: next });
  }

  return {
    account,
    never,
    endOf,
    ready,
    submitting,
    failure: writes.failure,
    load,
    submit,
    retry: writes.retry,
    dismiss: writes.dismiss,
  };
}
