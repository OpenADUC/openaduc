// SPDX-License-Identifier: BUSL-1.1
import { computed, shallowRef } from 'vue';
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
 *
 * With `failuresPerKey`, for a list of records, each key keeps its own
 * failure (`failureOn`) until it's retried (`retryOn`), dismissed
 * (`dismissOn`) or another write on that key starts.
 */
export function useUndoableWrite<Op extends object>(options: {
  write: (op: Op) => Promise<unknown>;
  /** The write that reverses `op` once it has landed, or why there's none. */
  inverse: (op: Op) => Op | { cannotUndo: string } | null;
  key?: ((op: Op) => string) | undefined;
  onDone: (op: Op, offer: UndoOffer) => void | Promise<void>;
  onFailed?: ((failure: WriteFailure<Op>) => void | Promise<void>) | undefined;
  failuresPerKey?: boolean | undefined;
}) {
  const auth = useAuthStore();
  const keyOf = options.key ?? (() => '');
  // Shallow, so the caller's objects come back as they were passed.
  const running = shallowRef(new Map<string, Op>());
  const settled = new Map<string, Promise<void>>();
  // In the order they failed, so the last is the latest.
  const failures = shallowRef(new Map<string, { failure: WriteFailure<Op>; retry: () => void }>());
  const last = () => [...failures.value.values()].at(-1) ?? null;
  const failure = computed(() => last()?.failure ?? null);
  const failureOn = (key: string): WriteFailure<Op> | null =>
    failures.value.get(key)?.failure ?? null;

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
    clear(key);
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
    const key = keyOf(attempt.op);
    const next = options.failuresPerKey ? new Map(failures.value) : new Map();
    next.delete(key);
    failures.value = next.set(key, { failure: f, retry: () => start(attempt) });
    await options.onFailed?.(f);
  }

  /** Forget the failure on `key`; with one slot, the failure. */
  function clear(key: string): void {
    if (!options.failuresPerKey) {
      if (failures.value.size > 0) failures.value = new Map();
    } else if (failures.value.has(key)) {
      const next = new Map(failures.value);
      next.delete(key);
      failures.value = next;
    }
  }

  function retry(): void {
    last()?.retry();
  }

  function dismiss(): void {
    const f = failure.value;
    if (f) clear(keyOf(f.op));
  }

  function retryOn(key: string): void {
    failures.value.get(key)?.retry();
  }

  return {
    running,
    runningOn,
    run,
    failure,
    failureOn,
    retry,
    dismiss,
    retryOn,
    dismissOn: clear,
  };
}

function isCannotUndo(x: object): x is { cannotUndo: string } {
  // An Op is the caller's own shape, which never has this key.
  return 'cannotUndo' in x;
}
