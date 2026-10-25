// SPDX-License-Identifier: BUSL-1.1
import { shallowRef } from 'vue';
import { useAuthStore } from '../../stores/auth.js';

/**
 * What a landed write offers: `undo` to reverse it, or `cannotUndo` saying
 * why it can't be reversed from here. Null when there's nothing to say: the
 * write has no inverse (an unlock) or was itself an undo.
 */
export type UndoOffer = { undo: () => void } | { cannotUndo: string } | null;

export interface WriteFailure<Op> {
  op: Op;
  message: string;
  /** The write was an Undo. */
  undo: boolean;
}

interface Attempt<Op> {
  op: Op;
  undo: boolean;
  after?: (() => void | Promise<void>) | undefined;
}

export const UNDO_CANCELLED = 'Step-up was cancelled, so it wasn’t undone.';

/**
 * Runs a workflow's writes, prompting step-up first and retrying after one,
 * one write at a time per `key`. A landed write hands `onDone` its offer of
 * Undo, which makes the inverse write the same way; an Undo waits for
 * whatever is still running on its key (the refresh after the write it
 * undoes) rather than being dropped. The last failure stays in `failure`
 * until it's retried, dismissed or another write starts; an Undo whose
 * step-up prompt is cancelled counts as a failure, so it isn't lost unseen.
 */
export function useUndoableWrite<Op extends object>(options: {
  write: (op: Op) => Promise<unknown>;
  /** The write that reverses `op` once it has landed, or why there's none. */
  inverse: (op: Op) => Op | { cannotUndo: string } | null;
  key?: ((op: Op) => string) | undefined;
  onDone: (op: Op, offer: UndoOffer) => void | Promise<void>;
  onFailed?: ((failure: WriteFailure<Op>) => void | Promise<void>) | undefined;
}) {
  const auth = useAuthStore();
  const keyOf = options.key ?? (() => '');
  // Shallow, so the caller's objects come back as they were passed.
  const running = shallowRef(new Map<string, Op>());
  const settled = new Map<string, Promise<void>>();
  const failure = shallowRef<WriteFailure<Op> | null>(null);
  let retryFailed: (() => void) | null = null;

  const runningOn = (key = ''): Op | null => running.value.get(key) ?? null;

  /** `after` runs once the write lands, after `onDone`, including after a step-up. */
  function run(op: Op, after?: () => void | Promise<void>): void {
    if (runningOn(keyOf(op)) !== null) return;
    start({ op, undo: false, after });
  }

  function start(attempt: Attempt<Op>): void {
    auth.requireStepUp(
      () => commit(attempt),
      null,
      () => cancelled(attempt),
    );
  }

  async function commit(attempt: Attempt<Op>): Promise<void> {
    const key = keyOf(attempt.op);
    if (attempt.undo) {
      while (settled.has(key)) await settled.get(key);
    } else if (runningOn(key) !== null) {
      return;
    }
    let finished!: () => void;
    settled.set(key, new Promise<void>((r) => (finished = r)));
    running.value = new Map(running.value).set(key, attempt.op);
    dismiss();
    try {
      try {
        await options.write(attempt.op);
      } catch (err) {
        const retried = auth.retryAfterStepUp(
          err,
          () => commit(attempt),
          () => cancelled(attempt),
        );
        if (retried) return;
        await fail(attempt, err instanceof Error ? err.message : String(err));
        return;
      }
      await options.onDone(attempt.op, attempt.undo ? null : offerFor(attempt.op));
      await attempt.after?.();
    } finally {
      const rest = new Map(running.value);
      rest.delete(key);
      running.value = rest;
      settled.delete(key);
      finished();
    }
  }

  function offerFor(op: Op): UndoOffer {
    const inverse = options.inverse(op);
    if (inverse === null) return null;
    if (isCannotUndo(inverse)) return inverse;
    return { undo: () => start({ op: inverse, undo: true }) };
  }

  function cancelled(attempt: Attempt<Op>): void {
    if (attempt.undo) void fail(attempt, UNDO_CANCELLED);
  }

  async function fail(attempt: Attempt<Op>, message: string): Promise<void> {
    const f = { op: attempt.op, message, undo: attempt.undo };
    failure.value = f;
    retryFailed = () => start(attempt);
    await options.onFailed?.(f);
  }

  function retry(): void {
    retryFailed?.();
  }

  function dismiss(): void {
    failure.value = null;
    retryFailed = null;
  }

  return { running, runningOn, run, failure, retry, dismiss };
}

function isCannotUndo(x: object): x is { cannotUndo: string } {
  // An Op is the caller's own shape, which never has this key.
  return 'cannotUndo' in x;
}
