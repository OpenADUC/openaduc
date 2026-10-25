// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupDetail, GroupSummary, UserSummary } from '@openaduc/shared';
import { ApiError } from '../../api/client.js';

const aUser = (id: string, displayName: string): UserSummary =>
  ({ id, displayName, samAccountName: displayName.toLowerCase() }) as UserSummary;
const aGroup = (id: string, name: string): GroupSummary => ({
  id,
  name,
  samAccountName: name,
  distinguishedName: `CN=${name},DC=corp,DC=example`,
  description: null,
  groupType: 'security',
  groupScope: 'global',
  memberCount: 0,
});
const JANE = aUser('u1', 'Jane Doe');
const JOHN = aUser('u2', 'John Smith');
const STAFF = aGroup('g1', 'Staff');
const ENGINEERING = aGroup('g2', 'Engineering');
const SALES = aGroup('g3', 'Sales');

const searchUsers = vi.fn();
const searchGroups = vi.fn();
vi.mock('../../api/index.js', () => ({
  api: { users: { search: searchUsers }, groups: { search: searchGroups } },
}));

const { useGroupMemberSearch } = await import('./useGroupMemberSearch.js');

// Staff has Jane and Engineering in it already.
const staff = {
  ...STAFF,
  members: [
    { kind: 'user', id: 'u1' },
    { kind: 'group', id: 'g2' },
  ],
} as GroupDetail;

function setup() {
  const group = ref<GroupDetail | null>(staff);
  return { search: useGroupMemberSearch(() => group.value), group };
}

async function typeQuery(search: ReturnType<typeof setup>['search'], q: string) {
  search.query.value = q;
  await nextTick();
  await vi.advanceTimersByTimeAsync(250);
}

describe('useGroupMemberSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    searchUsers.mockResolvedValue({ rows: [JANE, JOHN], total: 2 });
    searchGroups.mockResolvedValue({ rows: [STAFF, ENGINEERING, SALES], total: 3 });
  });
  afterEach(() => vi.useRealTimers());

  it('finds users and groups that aren’t members yet, leaving out the group itself', async () => {
    const { search } = setup();

    await typeQuery(search, ' s ');

    expect(searchUsers).toHaveBeenCalledWith({ q: 's', pageSize: 10 });
    expect(searchGroups).toHaveBeenCalledWith({ q: 's', pageSize: 10 });
    expect(search.results.value).toEqual([
      { kind: 'user', ...JOHN },
      { kind: 'group', ...SALES },
    ]);
    expect(search.searching.value).toBe(false);
  });

  it('searches nothing for a blank query', async () => {
    const { search } = setup();

    await typeQuery(search, '  ');

    expect(searchUsers).not.toHaveBeenCalled();
    expect(search.results.value).toEqual([]);
  });

  it('says why a search failed, rather than finding nothing', async () => {
    const { search } = setup();
    searchGroups.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'directory unreachable'));

    await typeQuery(search, 'sa');
    expect(search.searchError.value).toBe('directory unreachable');
    expect(search.results.value).toEqual([]);

    await typeQuery(search, 'sal');
    expect(search.searchError.value).toBeNull();
    expect(search.results.value).toHaveLength(2);
  });

  it('shows the latest search’s results, not a slower earlier one’s', async () => {
    const { search } = setup();
    let slow!: (v: unknown) => void;
    searchUsers.mockImplementationOnce(() => new Promise((r) => (slow = r)));

    await typeQuery(search, 'j');
    searchUsers.mockResolvedValueOnce({ rows: [], total: 0 });
    await typeQuery(search, 'sa');
    slow({ rows: [JOHN], total: 1 });
    await vi.advanceTimersByTimeAsync(10);

    expect(search.results.value).toEqual([{ kind: 'group', ...SALES }]);
  });

  it('starts over when reset', async () => {
    const { search } = setup();
    await typeQuery(search, 'sa');

    search.reset();

    expect(search.query.value).toBe('');
    expect(search.results.value).toEqual([]);
  });
});
