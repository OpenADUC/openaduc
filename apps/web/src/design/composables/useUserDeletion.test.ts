// SPDX-License-Identifier: BUSL-1.1
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDeletePreflightResponse } from '@openaduc/shared';

const deletePreflight = vi.fn();
const remove = vi.fn();
vi.mock('../../api/index.js', () => ({ api: { users: { deletePreflight, remove } } }));

const { useUserDeletion } = await import('./useUserDeletion.js');

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
    await d.run();
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
    await d.run();
    expect(remove).toHaveBeenCalledWith('u1', {
      confirmSamAccountName: 'tree.test',
      allowTreeDelete: true,
    });
  });

  it('asks nothing extra of an account with no objects inside', async () => {
    const d = await loaded(0);
    expect(d.confirmed.value).toBe(true);
    await d.run();
    expect(remove).toHaveBeenCalledWith('u1', { confirmSamAccountName: 'tree.test' });
  });
});
