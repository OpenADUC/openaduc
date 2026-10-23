// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDeletePreflightResponse } from '@openaduc/shared';
import { ApiError } from '../../api/client.js';

const deletePreflight = vi.fn();
const remove = vi.fn();
const stepUp = vi.fn(async () => ({
  elevated: {
    active: true,
    idleExpiresAt: '2999-01-01T00:15:00.000Z',
    absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
  },
}));
vi.mock('../../api/index.js', () => ({
  api: { users: { deletePreflight, remove }, auth: { stepUp } },
}));

const { useUserDeletion } = await import('./useUserDeletion.js');
const { useAuthStore } = await import('../../stores/auth.js');

const user = (childObjects: number | null) => ({
  id: 'u1',
  samAccountName: 'tree.test',
  displayName: 'Tree Test',
  distinguishedName: 'CN=tree.test,DC=x',
  enabled: false,
  privileged: false,
  childObjects,
  blockedReason: null,
});

async function loaded(childObjects: number | null) {
  setActivePinia(createPinia());
  deletePreflight.mockResolvedValue({
    recycleBin: null,
    users: [user(childObjects)],
  } satisfies UserDeletePreflightResponse);
  const d = useUserDeletion();
  await d.load(['u1']);
  d.typed.value = 'tree.test';
  return d;
}

describe('useUserDeletion with child objects', () => {
  beforeEach(() => {
    remove.mockReset().mockResolvedValue({});
  });

  it('needs the extra confirmation when the account holds objects', async () => {
    const d = await loaded(2);
    expect(d.confirmed.value).toBe(false);

    d.includeChildren.value = true;
    expect(d.confirmed.value).toBe(true);
    await d.run(() => undefined);
    expect(remove).toHaveBeenCalledWith('u1', {
      confirmSamAccountName: 'tree.test',
      allowTreeDelete: true,
    });
  });

  it('treats an uncounted account as possibly holding objects, so it can still be deleted', async () => {
    const d = await loaded(null);
    expect(d.childCountUnknown.value).toBe(true);
    expect(d.confirmed.value).toBe(false);

    d.includeChildren.value = true;
    await d.run(() => undefined);
    expect(remove).toHaveBeenCalledWith('u1', {
      confirmSamAccountName: 'tree.test',
      allowTreeDelete: true,
    });
  });

  it('asks nothing extra of an account with no objects inside', async () => {
    const d = await loaded(0);
    expect(d.confirmed.value).toBe(true);
    await d.run(() => undefined);
    expect(remove).toHaveBeenCalledWith('u1', { confirmSamAccountName: 'tree.test' });
  });
});

describe('useUserDeletion when the elevated session has ended', () => {
  beforeEach(() => {
    remove.mockReset().mockResolvedValue({});
  });

  it('stops, then deletes after step-up', async () => {
    const d = await loaded(0);
    remove.mockRejectedValueOnce(new ApiError(403, 'step_up_required', 'step-up required'));
    const retry = vi.fn(async (): Promise<void> => {
      await d.run(retry);
    });

    expect(await d.run(retry)).toBeNull();
    expect(d.phase.value).toBe('review');
    expect(d.failures.value).toEqual([]);

    await useAuthStore().stepUp('pw');
    await vi.waitFor(() => expect(d.phase.value).toBe('finished'));
    expect(remove).toHaveBeenCalledTimes(2);
    expect(d.deletedIds.value).toEqual(['u1']);
  });
});
