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

const resetAccount = vi.fn();
const stepUp = vi.fn(async () => ({ elevated: ELEVATED }));
vi.mock('../../api/index.js', () => ({
  api: { computers: { resetAccount }, auth: { stepUp } },
}));

const { useComputerReset } = await import('./useComputerReset.js');
const { useAuthStore } = await import('../../stores/auth.js');

const ws01 = { id: 'c1', name: 'WS01' };

function setup(elevated = ELEVATED) {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.actor = { capabilities: [], elevated } as never;
  const onReset = vi.fn();
  const onFailed = vi.fn();
  const reset = useComputerReset<typeof ws01>({ onReset, onFailed });
  return { reset, auth, onReset, onFailed };
}

describe('useComputerReset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAccount.mockResolvedValue({ ok: true });
  });

  it('asks first, and resets only once confirmed', async () => {
    const { reset, onReset } = setup();

    reset.ask(ws01);
    expect(reset.pending.value).toEqual(ws01);
    expect(resetAccount).not.toHaveBeenCalled();

    reset.confirm();
    expect(reset.pending.value).toBeNull();
    await vi.waitFor(() => expect(onReset).toHaveBeenCalledWith(ws01));
    expect(resetAccount).toHaveBeenCalledWith('c1');
  });

  it('does nothing when the question is cancelled', () => {
    const { reset } = setup();

    reset.ask(ws01);
    reset.cancel();
    reset.confirm();

    expect(reset.pending.value).toBeNull();
    expect(resetAccount).not.toHaveBeenCalled();
  });

  it('stays running until the refresh is done', async () => {
    let refreshed!: () => void;
    const { reset, onReset } = setup();
    onReset.mockImplementationOnce(() => new Promise<void>((r) => (refreshed = r)));

    reset.ask(ws01);
    reset.confirm();
    await vi.waitFor(() => expect(onReset).toHaveBeenCalledOnce());
    expect(reset.runningOn('c1')).toBe(true);
    refreshed();
    await vi.waitFor(() => expect(reset.runningOn('c1')).toBe(false));
  });

  it('prompts step-up after the confirmation, then resets', async () => {
    const { reset, auth, onReset } = setup(NOT_ELEVATED);

    reset.ask(ws01);
    reset.confirm();
    expect(auth.stepUpRequested).toBe(true);
    expect(resetAccount).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(onReset).toHaveBeenCalledOnce());
  });

  it('keeps a refused reset until it’s retried', async () => {
    const { reset, onReset, onFailed } = setup();
    resetAccount.mockRejectedValueOnce(
      new ApiError(403, 'forbidden', 'directory refused the reset'),
    );

    reset.ask(ws01);
    reset.confirm();
    await vi.waitFor(() =>
      expect(reset.failure.value).toEqual({
        op: { computer: ws01 },
        message: 'directory refused the reset',
        undo: false,
      }),
    );
    expect(onFailed).toHaveBeenCalledOnce();
    expect(onReset).not.toHaveBeenCalled();

    reset.retry();
    await vi.waitFor(() => expect(onReset).toHaveBeenCalledOnce());
    expect(reset.failure.value).toBeNull();
  });
});
