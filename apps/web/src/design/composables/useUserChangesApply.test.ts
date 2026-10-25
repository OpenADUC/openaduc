// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElevatedSessionState } from '@openaduc/shared';
import { ApiError } from '../../api/client.js';
import { aUserDetail } from '../../test/userDetail.js';

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

const update = vi.fn();
const unlock = vi.fn();
const stepUp = vi.fn(async () => ({ elevated: ELEVATED }));
vi.mock('../../api/index.js', () => ({
  api: { users: { update, unlock }, auth: { stepUp } },
}));

const { useUserChangesApply } = await import('./useUserChangesApply.js');
const { useAuthStore } = await import('../../stores/auth.js');

function setup(elevated = ELEVATED) {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.actor = { capabilities: [], elevated } as never;
  const calls: string[] = [];
  const onApplied = vi.fn(() => void calls.push('applied'));
  const onFailed = vi.fn();
  const refresh = vi.fn(() => void calls.push('refresh'));
  const changes = useUserChangesApply({ onApplied, onFailed, refresh });
  changes.reset(aUserDetail({ title: 'Analyst', locked: true }));
  return { changes, auth, calls, onApplied, onFailed, refresh };
}

describe('useUserChangesApply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    update.mockResolvedValue({ ok: true });
    unlock.mockResolvedValue({ ok: true });
  });

  it('saves the attributes, then unlocks, then refreshes', async () => {
    const { changes, calls, onFailed } = setup();
    changes.draft.title = 'Lead Analyst';
    changes.unlock.value = true;
    const after = vi.fn(() => void calls.push('after'));

    changes.apply(after);
    await vi.waitFor(() => expect(after).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledWith('u1', { patch: { title: 'Lead Analyst' } });
    expect(unlock).toHaveBeenCalledWith('u1');
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(unlock.mock.invocationCallOrder[0]!);
    expect(calls).toEqual(['applied', 'refresh', 'after']);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('counts an unlock alone as a change, but not on an account that isn’t locked', () => {
    const { changes } = setup();
    changes.unlock.value = true;
    expect(changes.dirty.value).toBe(true);

    changes.reset(aUserDetail({ locked: false }));
    changes.unlock.value = true;
    expect(changes.dirty.value).toBe(false);
  });

  it('says the attributes were applied when only the unlock failed, and refreshes', async () => {
    const { changes, onApplied, onFailed, refresh } = setup();
    unlock.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));
    changes.draft.title = 'Lead Analyst';
    changes.unlock.value = true;

    changes.apply();
    await vi.waitFor(() =>
      expect(onFailed).toHaveBeenCalledWith(
        'Changes applied, but the account was not unlocked.',
        'DC unreachable',
      ),
    );
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(onApplied).not.toHaveBeenCalled();
    expect(changes.applying.value).toBe(false);
  });

  it('reports a failed unlock on its own without refreshing', async () => {
    const { changes, onFailed, refresh } = setup();
    unlock.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));
    changes.unlock.value = true;

    changes.apply();
    await vi.waitFor(() =>
      expect(onFailed).toHaveBeenCalledWith('Unlock failed', 'DC unreachable'),
    );
    expect(update).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('doesn’t unlock when the attributes were refused', async () => {
    const { changes, onFailed } = setup();
    update.mockRejectedValueOnce(new ApiError(400, 'bad_request', 'constraint violation'));
    changes.draft.title = 'Lead Analyst';
    changes.unlock.value = true;

    changes.apply();
    await vi.waitFor(() =>
      expect(onFailed).toHaveBeenCalledWith('Apply failed', 'constraint violation'),
    );
    expect(unlock).not.toHaveBeenCalled();
  });

  it('prompts step-up first, then applies everything', async () => {
    const { changes, auth, onApplied } = setup(NOT_ELEVATED);
    changes.draft.title = 'Lead Analyst';
    changes.unlock.value = true;

    changes.apply();
    expect(auth.stepUpRequested).toBe(true);
    expect(update).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
    expect(unlock).toHaveBeenCalledOnce();
  });

  it('unlocks after step-up when the session ends between the save and the unlock', async () => {
    const { changes, auth, onApplied, onFailed } = setup();
    unlock.mockRejectedValueOnce(new ApiError(403, 'step_up_required', 'step-up required'));
    changes.draft.title = 'Lead Analyst';
    changes.unlock.value = true;
    const after = vi.fn();

    changes.apply(after);
    await vi.waitFor(() => expect(unlock).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(changes.applying.value).toBe(false));
    expect(onFailed).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(after).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledOnce();
    expect(unlock).toHaveBeenCalledTimes(2);
    expect(onApplied).toHaveBeenCalledOnce();
  });
});
