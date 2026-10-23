// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectoryPolicy } from '@openaduc/shared';
import { ApiError } from '../../api/client.js';
import { aUserDetail } from '../../test/userDetail.js';

const policy: DirectoryPolicy = {
  lockoutDurationMinutes: 0,
  lockoutThreshold: 5,
  lockoutObservationMinutes: 30,
  maxPwdAgeDays: 42,
  minPwdLength: 12,
  pwdHistoryLength: 24,
  complexityRequired: true,
  fetchedAt: '2026-01-01T00:00:00.000Z',
};

const get = vi.fn();
const resetPassword = vi.fn();
const policyFetch = vi.fn(async () => ({ policy }));
const stepUp = vi.fn(async () => ({
  elevated: {
    active: true,
    idleExpiresAt: '2999-01-01T00:15:00.000Z',
    absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
  },
}));
vi.mock('../../api/index.js', () => ({
  api: { users: { get, resetPassword }, directories: { policy: policyFetch }, auth: { stepUp } },
}));

const { usePasswordReset } = await import('./usePasswordReset.js');
const { useAuthStore } = await import('../../stores/auth.js');

const RESET_AND_UNLOCK = ['read:user', 'write:user.resetPassword', 'write:user.unlock'];

function setup(capabilities = RESET_AND_UNLOCK, elevated = true) {
  setActivePinia(createPinia());
  useAuthStore().actor = { directoryId: 1, capabilities, elevated: { active: elevated } } as never;
  const onReset = vi.fn();
  return { reset: usePasswordReset({ onReset }), onReset };
}

async function loaded(
  reset: ReturnType<typeof usePasswordReset>,
  user: ReturnType<typeof aUserDetail>,
) {
  get.mockResolvedValue({ user });
  await reset.load(user.id);
}

// The submit runs once any step-up is through, after the click returns.
const settled = () => new Promise((r) => setTimeout(r));

describe('usePasswordReset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPassword.mockResolvedValue({ ok: true });
  });

  it('offers to unlock a locked account, ticked, and unlocks it in the same request', async () => {
    const { reset, onReset } = setup();
    await loaded(reset, aUserDetail({ locked: true }));
    expect(reset.offerUnlock.value).toBe(true);
    expect(reset.alsoUnlock.value).toBe(true);

    reset.password.value = 'Correct-Horse-9';
    reset.submit();
    await settled();

    expect(resetPassword).toHaveBeenCalledOnce();
    expect(resetPassword).toHaveBeenCalledWith('u1', {
      newPassword: 'Correct-Horse-9',
      forceChangeAtNextLogin: true,
      unlock: true,
    });
    expect(onReset).toHaveBeenCalledWith({ unlocked: true, forceChangeAtNextLogin: true });
  });

  it('doesn’t offer to unlock an account that isn’t locked', async () => {
    const { reset } = setup();
    await loaded(reset, aUserDetail({ locked: false }));
    expect(reset.offerUnlock.value).toBe(false);

    reset.alsoUnlock.value = true;
    reset.password.value = 'Correct-Horse-9';
    reset.submit();
    await settled();
    expect(resetPassword).toHaveBeenCalledWith('u1', expect.objectContaining({ unlock: false }));
  });

  it('doesn’t offer to unlock to an operator who may only reset', async () => {
    const { reset } = setup(['read:user', 'write:user.resetPassword']);
    await loaded(reset, aUserDetail({ locked: true }));
    expect(reset.offerUnlock.value).toBe(false);

    reset.password.value = 'Correct-Horse-9';
    reset.submit();
    await settled();
    expect(resetPassword).toHaveBeenCalledWith('u1', expect.objectContaining({ unlock: false }));
  });

  it('checks against the domain’s policy and generates a password that passes it', async () => {
    const { reset } = setup();
    await loaded(reset, aUserDetail());

    reset.password.value = 'Short-1a';
    expect(reset.acceptable.value).toBe(false);
    reset.submit();
    await settled();
    expect(resetPassword).not.toHaveBeenCalled();

    reset.generate();
    expect(reset.password.value.length).toBeGreaterThanOrEqual(12);
    expect(reset.acceptable.value).toBe(true);
    expect(reset.shown.value).toBe(true);
    expect(reset.historyNote.value).toContain('24');
  });

  it('prompts step-up before sending the new password, then resets', async () => {
    const { reset, onReset } = setup(RESET_AND_UNLOCK, false);
    await loaded(reset, aUserDetail());
    reset.password.value = 'Correct-Horse-9';

    reset.submit();
    await settled();
    expect(useAuthStore().stepUpRequested).toBe(true);
    expect(resetPassword).not.toHaveBeenCalled();

    await useAuthStore().stepUp('pw');
    await vi.waitFor(() => expect(onReset).toHaveBeenCalledOnce());
    expect(resetPassword).toHaveBeenCalledOnce();
  });

  it('finishes the reset after step-up when the server says the elevated session is gone', async () => {
    const { reset, onReset } = setup();
    await loaded(reset, aUserDetail({ locked: true }));
    reset.password.value = 'Correct-Horse-9';
    resetPassword.mockRejectedValueOnce(new ApiError(403, 'step_up_required', 'step-up required'));

    reset.submit();
    await settled();
    expect(reset.error.value).toBeNull();
    expect(onReset).not.toHaveBeenCalled();

    await useAuthStore().stepUp('pw');
    await vi.waitFor(() => expect(onReset).toHaveBeenCalledOnce());
    expect(resetPassword).toHaveBeenCalledTimes(2);
  });

  it('says whether copying worked, until the password changes', async () => {
    const { reset } = setup();
    await loaded(reset, aUserDetail());
    reset.password.value = 'Correct-Horse-9';
    const writeText = vi.fn().mockRejectedValueOnce(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await reset.copy();
    expect(reset.copied.value).toBe(false);
    await reset.copy();
    expect(writeText).toHaveBeenLastCalledWith('Correct-Horse-9');
    expect(reset.copied.value).toBe(true);

    reset.password.value = 'Correct-Horse-10';
    await nextTick();
    expect(reset.copied.value).toBeNull();
    vi.unstubAllGlobals();
  });

  it('shows why the directory refused the password', async () => {
    const { reset, onReset } = setup();
    await loaded(reset, aUserDetail());
    reset.password.value = 'Correct-Horse-9';
    resetPassword.mockRejectedValueOnce(new ApiError(400, 'bad_request', 'directory rejected'));

    reset.submit();
    await settled();
    expect(reset.error.value).toBe('directory rejected');
    expect(onReset).not.toHaveBeenCalled();
  });
});
