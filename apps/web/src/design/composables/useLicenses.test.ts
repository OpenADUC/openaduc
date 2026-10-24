// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupLicenses, UserLicenses } from '@openaduc/shared';
import { ApiError } from '../../api/client.js';

const userLicenses = vi.fn<(id: string) => Promise<UserLicenses>>();
const groupLicenses = vi.fn<(id: string) => Promise<GroupLicenses>>();
vi.mock('../../api/index.js', () => ({
  api: { users: { licenses: userLicenses }, groups: { licenses: groupLicenses } },
}));

const { useGroupLicenses, useUserLicenses } = await import('./useLicenses.js');
const { useLicensedGroupsStore } = await import('../../stores/licensedGroups.js');

const e3 = { skuId: 'e3', skuPartNumber: 'SPE_E3', name: 'Microsoft 365 E3' };

beforeEach(() => {
  setActivePinia(createPinia());
  userLicenses.mockReset();
  groupLicenses.mockReset();
});

describe('useUserLicenses', () => {
  it('keeps only the latest user’s answer', async () => {
    let answerFirst!: (v: UserLicenses) => void;
    userLicenses
      .mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce({ status: 'unsynced', lastSyncAt: null });
    const read = useUserLicenses();
    const first = read.load('u1');
    await read.load('u2');
    answerFirst({ status: 'synced', licenses: [] });
    await first;
    expect(read.licenses.value).toEqual({ status: 'unsynced', lastSyncAt: null });
    expect(read.loading.value).toBe(false);
  });

  it('says why the licenses couldn’t be read', async () => {
    userLicenses.mockRejectedValue(
      new ApiError(502, 'entra_error', 'Graph 403 on /users (User.Read.All is required)'),
    );
    const read = useUserLicenses();
    await read.load('u1');
    expect(read.error.value).toBe('Graph 403 on /users (User.Read.All is required)');
    expect(read.licenses.value).toBeNull();
  });
});

describe('useGroupLicenses', () => {
  it('updates the badge pickers show for the group with what it read', async () => {
    const licensed = useLicensedGroupsStore();
    groupLicenses.mockResolvedValueOnce({
      status: 'synced',
      licenses: [{ ...e3, disabledPlans: 0 }],
      processingState: 'ProcessingComplete',
    });
    const read = useGroupLicenses();
    await read.load('g1');
    expect(licensed.licensesOf('g1')).toEqual([{ ...e3, disabledPlans: 0 }]);

    groupLicenses.mockResolvedValueOnce({ status: 'unsynced', lastSyncAt: null });
    await read.load('g1');
    expect(licensed.licensesOf('g1')).toEqual([]);
  });
});
