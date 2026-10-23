// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElevatedSessionState, GroupSummary } from '@openaduc/shared';
import { ApiError } from '../../api/client.js';
import { aUserDetail } from '../../test/userDetail.js';

const ELEVATED: ElevatedSessionState = {
  active: true,
  idleExpiresAt: '2999-01-01T00:15:00.000Z',
  absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
};

const aGroup = (id: string, name: string | null): GroupSummary => ({
  id,
  name,
  samAccountName: name,
  distinguishedName: `CN=${name ?? id},DC=corp,DC=example`,
  description: null,
  groupType: 'security',
  groupScope: 'global',
  memberCount: 0,
});
const SALES = aGroup('g1', 'Sales');
const STAFF = aGroup('g2', 'Staff');

const get = vi.fn();
const search = vi.fn();
const addGroup = vi.fn();
const stepUp = vi.fn(async () => ({ elevated: ELEVATED }));
vi.mock('../../api/index.js', () => ({
  api: { users: { get, addGroup }, groups: { search }, auth: { stepUp } },
}));

const { useAddToGroup } = await import('./useAddToGroup.js');
const { useAuthStore } = await import('../../stores/auth.js');

async function setup() {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.actor = { capabilities: [], elevated: ELEVATED } as never;
  const onAdded = vi.fn();
  const onFailed = vi.fn();
  const picker = useAddToGroup({ onAdded, onFailed });
  await picker.load('u1');
  return { picker, auth, onAdded, onFailed };
}

async function typeQuery(picker: Awaited<ReturnType<typeof setup>>['picker'], q: string) {
  picker.query.value = q;
  await nextTick();
  await vi.advanceTimersByTimeAsync(200);
}

describe('useAddToGroup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    get.mockResolvedValue({
      user: aUserDetail({
        groupMemberships: [
          { id: 'g2', name: 'Staff', distinguishedName: 'CN=Staff', direct: false },
        ] as never,
      }),
    });
    search.mockResolvedValue({ rows: [SALES, STAFF] });
    addGroup.mockResolvedValue({ ok: true });
  });
  afterEach(() => vi.useRealTimers());

  it('searches once the name is long enough, and flags groups the user is already in', async () => {
    const { picker } = await setup();

    await typeQuery(picker, 's');
    expect(picker.queryTooShort.value).toBe(true);
    expect(search).not.toHaveBeenCalled();

    await typeQuery(picker, ' sa ');
    expect(search).toHaveBeenCalledWith({ q: 'sa', pageSize: 12 });
    expect(picker.results.value).toEqual([SALES, STAFF]);
    expect(picker.isMember('g1')).toBe(false);
    expect(picker.isMember('g2')).toBe(true);
  });

  it('shows the latest search’s results, not a slower earlier one’s', async () => {
    const { picker } = await setup();
    let slow!: (v: unknown) => void;
    search.mockImplementationOnce(() => new Promise((r) => (slow = r)));

    await typeQuery(picker, 'sal');
    await typeQuery(picker, 'sta');
    slow({ rows: [SALES] });
    await vi.advanceTimersByTimeAsync(10);
    expect(picker.results.value).toEqual([SALES, STAFF]);
    expect(picker.searching.value).toBe(false);
  });

  it('adds the user to the group, refreshing before it’s done', async () => {
    const { picker, onAdded } = await setup();
    let refreshed!: () => void;
    onAdded.mockImplementation(() => new Promise<void>((r) => (refreshed = r)));
    const after = vi.fn();

    picker.add(aGroup('g1', null), after);
    await vi.waitFor(() => expect(onAdded).toHaveBeenCalledOnce());
    expect(addGroup).toHaveBeenCalledWith('u1', { groupId: 'g1' });
    expect(onAdded).toHaveBeenCalledWith({
      userId: 'u1',
      userLabel: 'Jane Doe',
      groupId: 'g1',
      groupLabel: 'CN=g1,DC=corp,DC=example',
    });
    expect(picker.adding.value).toBe('g1');

    refreshed();
    await vi.waitFor(() => expect(after).toHaveBeenCalledOnce());
    expect(picker.adding.value).toBeNull();
  });

  it('won’t add the user to a group they’re already in', async () => {
    const { picker } = await setup();
    picker.add(STAFF);
    await vi.advanceTimersByTimeAsync(10);
    expect(addGroup).not.toHaveBeenCalled();
  });

  it('reports a refused add', async () => {
    const { picker, onAdded, onFailed } = await setup();
    addGroup.mockRejectedValueOnce(new ApiError(403, 'forbidden', 'directory rejected the change'));

    picker.add(SALES);
    await vi.waitFor(() => expect(onFailed).toHaveBeenCalledWith('directory rejected the change'));
    expect(onAdded).not.toHaveBeenCalled();
  });

  it('adds after step-up when the server says the elevated session is gone', async () => {
    const { picker, auth, onAdded, onFailed } = await setup();
    addGroup.mockRejectedValueOnce(new ApiError(403, 'step_up_required', 'step-up required'));

    picker.add(SALES);
    await vi.waitFor(() => expect(addGroup).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(picker.adding.value).toBeNull());
    await auth.stepUp('pw');
    await vi.waitFor(() => expect(onAdded).toHaveBeenCalledOnce());
    expect(addGroup).toHaveBeenCalledTimes(2);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('says why the account couldn’t be read', async () => {
    get.mockRejectedValueOnce(new ApiError(404, 'not_found', 'user not found'));
    const { picker } = await setup();
    expect(picker.error.value).toBe('user not found');
    picker.add(SALES);
    await vi.advanceTimersByTimeAsync(10);
    expect(addGroup).not.toHaveBeenCalled();
  });
});
