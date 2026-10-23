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

const disable = vi.fn();
const enable = vi.fn();
const unlock = vi.fn();
const disableComputer = vi.fn();
const enableComputer = vi.fn();
const stepUp = vi.fn(async () => ({ elevated: ELEVATED }));
vi.mock('../../api/index.js', () => ({
  api: {
    users: { disable, enable, unlock },
    computers: { disable: disableComputer, enable: enableComputer },
    auth: { stepUp },
  },
}));

const { useAccountActions } = await import('./useAccountActions.js');
const { useAuthStore } = await import('../../stores/auth.js');

const jane = { id: 'u1', name: 'Jane Doe' };

function setup(elevated = ELEVATED) {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.actor = { capabilities: [], elevated } as never;
  const onDone = vi.fn();
  const onFailed = vi.fn();
  const actions = useAccountActions<typeof jane>({ onDone, onFailed });
  return { actions, auth, onDone, onFailed };
}

describe('useAccountActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const call of [disable, enable, unlock, disableComputer, enableComputer]) {
      call.mockResolvedValue({ ok: true });
    }
  });

  it.each([
    ['disable', disable],
    ['enable', enable],
    ['unlock', unlock],
  ] as const)('%ss the account, then hands back the account it acted on', async (action, call) => {
    const { actions, onDone, onFailed } = setup();

    actions.run(action, jane);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(onDone.mock.calls[0]!.slice(0, 2)).toEqual([action, jane]);
    expect(call).toHaveBeenCalledWith('u1');
    expect(onFailed).not.toHaveBeenCalled();
  });

  it.each([
    ['disable', disableComputer, enableComputer],
    ['enable', enableComputer, disableComputer],
  ] as const)(
    '%ss a computer account, and undoes it the same way',
    async (action, call, inverse) => {
      setActivePinia(createPinia());
      useAuthStore().actor = { capabilities: [], elevated: ELEVATED } as never;
      const onDone = vi.fn();
      const ws01 = { id: 'c1', name: 'WS01' };
      const actions = useAccountActions<typeof ws01>({ kind: 'computer', onDone });

      actions.run(action, ws01);
      await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
      expect(call).toHaveBeenCalledWith('c1');
      (onDone.mock.calls[0]![2] as { undo: () => void }).undo();
      await vi.waitFor(() => expect(inverse).toHaveBeenCalledWith('c1'));
      expect(disable).not.toHaveBeenCalled();
      expect(enable).not.toHaveBeenCalled();
    },
  );

  it('stays running until the refresh is done, one action at a time per account', async () => {
    let refreshed!: () => void;
    const { actions, onDone } = setup();
    onDone.mockImplementationOnce(() => new Promise<void>((r) => (refreshed = r)));
    const after = vi.fn();

    actions.run('disable', jane, after);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(actions.runningOn('u1')).toBe('disable');
    actions.run('unlock', jane);
    expect(after).not.toHaveBeenCalled();

    actions.run('unlock', { id: 'u2', name: 'John Roe' });
    await vi.waitFor(() => expect(unlock).toHaveBeenCalledWith('u2'));

    refreshed();
    await vi.waitFor(() => expect(after).toHaveBeenCalledOnce());
    expect(actions.runningOn('u1')).toBeNull();
    expect(unlock).not.toHaveBeenCalledWith('u1');
  });

  it('reports a refused action without refreshing', async () => {
    const { actions, onDone, onFailed } = setup();
    disable.mockRejectedValueOnce(new ApiError(403, 'forbidden', 'directory rejected the change'));
    const after = vi.fn();

    actions.run('disable', jane, after);
    await vi.waitFor(() =>
      expect(onFailed).toHaveBeenCalledWith({
        op: { action: 'disable', account: jane },
        message: 'directory rejected the change',
        undo: false,
      }),
    );
    expect(onDone).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expect(actions.runningOn('u1')).toBeNull();
  });

  it('prompts step-up first, then acts', async () => {
    const { actions, auth, onDone } = setup(NOT_ELEVATED);

    actions.run('unlock', jane);
    expect(auth.stepUpRequested).toBe(true);
    expect(unlock).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith('unlock', jane, null));
    expect(unlock).toHaveBeenCalledOnce();
  });

  it('acts again after step-up when the server says the elevated session is gone', async () => {
    const { actions, auth, onDone, onFailed } = setup();
    enable.mockRejectedValueOnce(new ApiError(403, 'step_up_required', 'step-up required'));
    const after = vi.fn();

    actions.run('enable', jane, after);
    await vi.waitFor(() => expect(enable).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(actions.runningOn('u1')).toBeNull());
    expect(onFailed).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(after).toHaveBeenCalledOnce());
    expect(enable).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it.each([
    ['disable', enable],
    ['enable', disable],
  ] as const)('undoes a %s with the inverse action', async (action, inverse) => {
    const { actions, onDone } = setup();

    actions.run(action, jane);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(inverse).not.toHaveBeenCalled();

    (onDone.mock.calls[0]![2] as { undo: () => void }).undo();
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(2));
    expect(inverse).toHaveBeenCalledWith('u1');
    expect(onDone.mock.calls[1]![2]).toBeNull();
  });

  it('can’t undo an unlock', async () => {
    const { actions, onDone } = setup();

    actions.run('unlock', jane);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith('unlock', jane, null));
  });

  it('keeps a failure until it’s retried', async () => {
    const { actions, onDone } = setup();
    disable.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));

    actions.run('disable', jane);
    await vi.waitFor(() =>
      expect(actions.failure.value).toEqual({
        op: { action: 'disable', account: jane },
        message: 'DC unreachable',
        undo: false,
      }),
    );

    actions.retry();
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(disable).toHaveBeenCalledTimes(2);
    expect(actions.failure.value).toBeNull();
  });
});
