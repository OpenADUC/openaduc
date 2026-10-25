// SPDX-License-Identifier: BUSL-1.1
import { shallowRef, type ShallowRef } from 'vue';
import { api } from '../../api/index.js';
import { useUndoableWrite, type WriteFailure } from '../lib/undoableWrite.js';

export interface ComputerResetRun<T> {
  computer: T;
}

export type ComputerResetFailure<T> = WriteFailure<ComputerResetRun<T>>;

/**
 * Reset a computer's account, as ADUC's Reset Account does. The computer
 * can't authenticate to the domain until it rejoins, and nothing undoes
 * that, so it asks first: `ask` sets `pending` for the UI to confirm or
 * cancel. A failure stays in `failure` until it's retried or dismissed.
 */
export function useComputerReset<T extends { id: string }>(options: {
  onReset: (computer: T) => void | Promise<void>;
  onFailed?: (failure: ComputerResetFailure<T>) => void | Promise<void>;
}) {
  const pending: ShallowRef<T | null> = shallowRef(null);
  const writes = useUndoableWrite<ComputerResetRun<T>>({
    write: ({ computer }) => api.computers.resetAccount(computer.id),
    inverse: () => null,
    key: ({ computer }) => computer.id,
    onDone: ({ computer }) => options.onReset(computer),
    onFailed: options.onFailed,
  });

  function ask(computer: T): void {
    pending.value = computer;
  }

  function confirm(): void {
    const computer = pending.value;
    pending.value = null;
    if (computer) writes.run({ computer });
  }

  function cancel(): void {
    pending.value = null;
  }

  const runningOn = (id: string): boolean => writes.runningOn(id) !== null;

  return {
    pending,
    ask,
    confirm,
    cancel,
    runningOn,
    failure: writes.failure,
    retry: writes.retry,
    dismiss: writes.dismiss,
  };
}
