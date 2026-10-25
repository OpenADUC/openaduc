// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElevatedSessionState } from '@openaduc/shared';
import { ApiError } from '../../api/client.js';

const ELEVATED: ElevatedSessionState = {
  active: true,
  idleExpiresAt: '2999-01-01T00:15:00.000Z',
  absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
};
const NOT_ELEVATED: ElevatedSessionState = {
  active: false,
  idleExpiresAt: null,
  absoluteExpiresAt: null,
};

const stepUp = vi.fn(async () => ({ elevated: ELEVATED }));
vi.mock('../../api/index.js', () => ({ api: { auth: { stepUp } } }));

const { useUndoableWrite, UNDO_CANCELLED } = await import('./undoableWrite.js');
const { useAuthStore } = await import('../../stores/auth.js');

// A switch: on/off, undone by flipping it back.
interface Flip {
  to: 'on' | 'off';
}

function setup(elevated = ELEVATED) {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.actor = { capabilities: [], elevated } as never;
  const write = vi.fn(async (_op: Flip) => undefined);
  const onDone = vi.fn();
  const onFailed = vi.fn();
  const writes = useUndoableWrite<Flip>({
    write,
    inverse: ({ to }) => ({ to: to === 'on' ? 'off' : 'on' }),
    onDone,
    onFailed,
  });
  const undoOf = (call: number) => (onDone.mock.calls[call]![1] as { undo: () => void }).undo;
  return { writes, auth, write, onDone, onFailed, undoOf };
}

describe('an undoable write', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers an Undo that makes the inverse write, and offers none for the undo', async () => {
    const { writes, write, onDone, undoOf } = setup();

    writes.run({ to: 'on' });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    undoOf(0)();
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(2));
    expect(write).toHaveBeenLastCalledWith({ to: 'off' });
    expect(onDone.mock.calls[1]).toEqual([{ to: 'off' }, null]);
  });

  it('passes on why a write can’t be undone', async () => {
    setActivePinia(createPinia());
    useAuthStore().actor = { capabilities: [], elevated: ELEVATED } as never;
    const onDone = vi.fn();
    const writes = useUndoableWrite<Flip>({
      write: async () => undefined,
      inverse: () => ({ cannotUndo: 'It was never off.' }),
      onDone,
    });

    writes.run({ to: 'on' });
    await vi.waitFor(() =>
      expect(onDone).toHaveBeenCalledWith({ to: 'on' }, { cannotUndo: 'It was never off.' }),
    );
  });

  it('runs an Undo clicked during the refresh after the write once the refresh is done', async () => {
    const { writes, write, onDone, undoOf } = setup();
    let refreshed!: () => void;
    onDone.mockImplementationOnce(() => new Promise<void>((r) => (refreshed = r)));

    writes.run({ to: 'on' });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    undoOf(0)();
    await new Promise((r) => setTimeout(r, 10));
    expect(write).toHaveBeenCalledOnce();

    refreshed();
    await vi.waitFor(() => expect(write).toHaveBeenLastCalledWith({ to: 'off' }));
  });

  it('keeps an Undo whose step-up is cancelled as a failure to retry', async () => {
    const { writes, auth, write, onDone, onFailed, undoOf } = setup();
    writes.run({ to: 'on' });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    auth.actor = { capabilities: [], elevated: NOT_ELEVATED } as never;

    undoOf(0)();
    expect(auth.stepUpRequested).toBe(true);
    auth.cancelStepUp();
    expect(writes.failure.value).toEqual({
      op: { to: 'off' },
      message: UNDO_CANCELLED,
      undo: true,
    });
    expect(onFailed).toHaveBeenCalledOnce();

    writes.retry();
    await auth.stepUp('pw');
    await vi.waitFor(() => expect(write).toHaveBeenLastCalledWith({ to: 'off' }));
    expect(writes.failure.value).toBeNull();
  });

  it('drops a write whose step-up is cancelled without calling it a failure', () => {
    const { writes, auth } = setup(NOT_ELEVATED);

    writes.run({ to: 'on' });
    auth.cancelStepUp();
    expect(writes.failure.value).toBeNull();
  });

  it('keeps a failure until it’s retried or dismissed, and retries an Undo as an Undo', async () => {
    const { writes, write, onDone, undoOf } = setup();
    writes.run({ to: 'on' });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    write.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));

    undoOf(0)();
    await vi.waitFor(() =>
      expect(writes.failure.value).toEqual({
        op: { to: 'off' },
        message: 'DC unreachable',
        undo: true,
      }),
    );
    writes.retry();
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(2));
    expect(onDone.mock.calls[1]).toEqual([{ to: 'off' }, null]);
    expect(writes.failure.value).toBeNull();

    write.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));
    writes.run({ to: 'on' });
    await vi.waitFor(() => expect(writes.failure.value).not.toBeNull());
    writes.dismiss();
    expect(writes.failure.value).toBeNull();
    writes.retry();
    expect(write).toHaveBeenCalledTimes(4);
  });

  it('runs one write at a time per key, dropping a second click', async () => {
    const { writes, write, onDone } = setup();
    let refreshed!: () => void;
    onDone.mockImplementationOnce(() => new Promise<void>((r) => (refreshed = r)));

    writes.run({ to: 'on' });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(writes.runningOn()).toEqual({ to: 'on' });
    writes.run({ to: 'off' });
    refreshed();
    await vi.waitFor(() => expect(writes.runningOn()).toBeNull());
    expect(write).toHaveBeenCalledOnce();
  });
});

describe('undoable writes to several records', () => {
  beforeEach(() => vi.clearAllMocks());

  // A switch per record.
  interface Toggle {
    id: string;
    to: 'on' | 'off';
  }

  function setupMany(failuresPerKey: boolean) {
    setActivePinia(createPinia());
    useAuthStore().actor = { capabilities: [], elevated: ELEVATED } as never;
    const write = vi.fn(async (_op: Toggle) => undefined);
    const onDone = vi.fn();
    const writes = useUndoableWrite<Toggle>({
      write,
      inverse: ({ id, to }) => ({ id, to: to === 'on' ? 'off' : 'on' }),
      key: ({ id }) => id,
      onDone,
      failuresPerKey,
    });
    return { writes, write, onDone };
  }

  it('keeps each record’s failure while another record is written', async () => {
    const { writes, write, onDone } = setupMany(true);
    write.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));

    writes.run({ id: 'a', to: 'on' });
    await vi.waitFor(() => expect(writes.failureOn('a')).not.toBeNull());
    writes.run({ id: 'b', to: 'on' });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(writes.failureOn('a')?.message).toBe('DC unreachable');
    expect(writes.failureOn('b')).toBeNull();

    writes.retryOn('a');
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(2));
    expect(write).toHaveBeenLastCalledWith({ id: 'a', to: 'on' });
    expect(writes.failureOn('a')).toBeNull();
  });

  it('dismisses one record’s failure and leaves the others', async () => {
    const { writes, write } = setupMany(true);
    write.mockRejectedValue(new ApiError(500, 'ldap_error', 'DC unreachable'));

    writes.run({ id: 'a', to: 'on' });
    writes.run({ id: 'b', to: 'on' });
    await vi.waitFor(() => expect(writes.failureOn('b')).not.toBeNull());
    writes.dismissOn('b');
    expect(writes.failureOn('b')).toBeNull();
    expect(writes.failureOn('a')).not.toBeNull();
  });

  it('keeps one failure, the last, without failuresPerKey', async () => {
    const { writes, write } = setupMany(false);
    write.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));

    writes.run({ id: 'a', to: 'on' });
    await vi.waitFor(() => expect(writes.failure.value).not.toBeNull());
    writes.run({ id: 'b', to: 'on' });
    await vi.waitFor(() => expect(writes.runningOn('b')).toBeNull());
    expect(writes.failure.value).toBeNull();
    expect(writes.failureOn('a')).toBeNull();
  });
});
