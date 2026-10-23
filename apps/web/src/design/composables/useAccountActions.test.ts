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
const stepUp = vi.fn(async () => ({ elevated: ELEVATED }));
vi.mock('../../api/index.js', () => ({
  api: { users: { disable, enable, unlock }, auth: { stepUp } },
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
    for (const call of [disable, enable, unlock]) call.mockResolvedValue({ ok: true });
  });

  it.each([
    ['disable', disable],
    ['enable', enable],
    ['unlock', unlock],
  ] as const)('%ss the account, then hands back the account it acted on', async (action, call) => {
    const { actions, onDone, onFailed } = setup();

    actions.run(action, jane);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith(action, jane));
    expect(call).toHaveBeenCalledWith('u1');
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('stays running until the refresh is done, and runs one action at a time', async () => {
    let refreshed!: () => void;
    const { actions, onDone } = setup();
    onDone.mockImplementation(() => new Promise<void>((r) => (refreshed = r)));
    const after = vi.fn();

    actions.run('disable', jane, after);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(actions.running.value).toBe('disable');
    actions.run('unlock', jane);
    expect(after).not.toHaveBeenCalled();

    refreshed();
    await vi.waitFor(() => expect(after).toHaveBeenCalledOnce());
    expect(actions.running.value).toBeNull();
    expect(unlock).not.toHaveBeenCalled();
  });

  it('reports a refused action without refreshing', async () => {
    const { actions, onDone, onFailed } = setup();
    disable.mockRejectedValueOnce(new ApiError(403, 'forbidden', 'directory rejected the change'));
    const after = vi.fn();

    actions.run('disable', jane, after);
    await vi.waitFor(() =>
      expect(onFailed).toHaveBeenCalledWith('disable', jane, 'directory rejected the change'),
    );
    expect(onDone).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expect(actions.running.value).toBeNull();
  });

  it('prompts step-up first, then acts', async () => {
    const { actions, auth, onDone } = setup(NOT_ELEVATED);

    actions.run('unlock', jane);
    expect(auth.stepUpRequested).toBe(true);
    expect(unlock).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith('unlock', jane));
    expect(unlock).toHaveBeenCalledOnce();
  });

  it('acts again after step-up when the server says the elevated session is gone', async () => {
    const { actions, auth, onDone, onFailed } = setup();
    enable.mockRejectedValueOnce(new ApiError(403, 'step_up_required', 'step-up required'));
    const after = vi.fn();

    actions.run('enable', jane, after);
    await vi.waitFor(() => expect(enable).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(actions.running.value).toBeNull());
    expect(onFailed).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(after).toHaveBeenCalledOnce());
    expect(enable).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledOnce();
  });
});
