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

const addGroup = vi.fn();
const removeGroup = vi.fn();
const nestGroup = vi.fn();
const unnestGroup = vi.fn();
const stepUp = vi.fn(async () => ({ elevated: ELEVATED }));
vi.mock('../../api/index.js', () => ({
  api: {
    users: { addGroup, removeGroup },
    groups: { addGroup: nestGroup, removeGroup: unnestGroup },
    auth: { stepUp },
  },
}));

const { membershipChangeText, membershipDoneText, membershipOf, useGroupMembership } =
  await import('./useGroupMembership.js');
const { useAuthStore } = await import('../../stores/auth.js');

const janeInSales = {
  memberKind: 'user',
  memberId: 'u1',
  memberLabel: 'Jane Doe',
  groupId: 'g1',
  groupLabel: 'Sales',
} as const;
const engineeringInSales = {
  memberKind: 'group',
  memberId: 'g9',
  memberLabel: 'Engineering',
  groupId: 'g1',
  groupLabel: 'Sales',
} as const;

function setup(elevated = ELEVATED) {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.actor = { capabilities: [], elevated } as never;
  const onChanged = vi.fn();
  const onFailed = vi.fn();
  const membership = useGroupMembership({ onChanged, onFailed });
  return { membership, auth, onChanged, onFailed };
}

describe('useGroupMembership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addGroup.mockResolvedValue({ ok: true });
    removeGroup.mockResolvedValue({ ok: true });
    nestGroup.mockResolvedValue({ ok: true });
    unnestGroup.mockResolvedValue({ ok: true });
  });

  it('labels a membership with the first name each side has', () => {
    const group = { id: 'g1', name: '', samAccountName: null, distinguishedName: 'CN=Sales' };
    expect(membershipOf({ id: 'u1', displayName: null, samAccountName: 'jdoe' }, group)).toEqual({
      memberKind: 'user',
      memberId: 'u1',
      memberLabel: 'jdoe',
      groupId: 'g1',
      groupLabel: 'CN=Sales',
    });
    expect(
      membershipOf(
        { id: 'u1', displayName: 'Jane Doe', samAccountName: 'jdoe' },
        { ...group, samAccountName: 'sales' },
      ),
    ).toMatchObject({ memberLabel: 'Jane Doe', groupLabel: 'sales' });
  });

  it('labels a nested group by its name', () => {
    const sales = { id: 'g1', name: 'Sales', distinguishedName: 'CN=Sales' };
    const engineering = {
      kind: 'group' as const,
      id: 'g9',
      name: null,
      samAccountName: 'eng',
      distinguishedName: 'CN=Engineering',
    };
    expect(membershipOf(engineering, sales)).toEqual({
      memberKind: 'group',
      memberId: 'g9',
      memberLabel: 'eng',
      groupId: 'g1',
      groupLabel: 'Sales',
    });
  });

  it('nests a group in a group, and Undo takes it out again', async () => {
    const { membership, onChanged } = setup();

    membership.add(engineeringInSales);
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(nestGroup).toHaveBeenCalledWith('g9', { groupId: 'g1' });
    expect(addGroup).not.toHaveBeenCalled();
    expect(membershipDoneText('add', engineeringInSales)).toBe('Added Engineering to Sales');

    (onChanged.mock.calls[0]![2] as { undo: () => void }).undo();
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(unnestGroup).toHaveBeenCalledWith('g9', { groupId: 'g1' });
  });

  it('adds the user to the group', async () => {
    const { membership, onChanged } = setup();
    const after = vi.fn();

    membership.add(janeInSales, after);
    await vi.waitFor(() => expect(after).toHaveBeenCalledOnce());
    expect(addGroup).toHaveBeenCalledWith('u1', { groupId: 'g1' });
    expect(onChanged).toHaveBeenCalledWith('add', janeInSales, { undo: expect.any(Function) });
  });

  it('removes the user from the group', async () => {
    const { membership, onChanged } = setup();

    membership.remove(janeInSales);
    await vi.waitFor(() =>
      expect(onChanged).toHaveBeenCalledWith('remove', janeInSales, {
        undo: expect.any(Function),
      }),
    );
    expect(removeGroup).toHaveBeenCalledWith('u1', { groupId: 'g1' });
    expect(addGroup).not.toHaveBeenCalled();
  });

  it('stays pending until the refresh is done, and makes one change at a time', async () => {
    let refreshed!: () => void;
    const { membership, onChanged } = setup();
    onChanged.mockImplementation(() => new Promise<void>((r) => (refreshed = r)));

    membership.remove(janeInSales);
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(membership.pending.value).toEqual({ change: 'remove', membership: janeInSales });
    membership.add({ ...janeInSales, groupId: 'g2' });

    refreshed();
    await vi.waitFor(() => expect(membership.pending.value).toBeNull());
    expect(addGroup).not.toHaveBeenCalled();
  });

  it('reports a refused change without refreshing', async () => {
    const { membership, onChanged, onFailed } = setup();
    addGroup.mockRejectedValueOnce(new ApiError(502, 'bad_gateway', 'group add failed'));
    const after = vi.fn();

    membership.add(janeInSales, after);
    await vi.waitFor(() =>
      expect(onFailed).toHaveBeenCalledWith({
        op: { change: 'add', membership: janeInSales },
        message: 'group add failed',
        undo: false,
      }),
    );
    expect(onChanged).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expect(membership.pending.value).toBeNull();
  });

  it('prompts step-up first, then makes the change', async () => {
    const { membership, auth, onChanged } = setup(NOT_ELEVATED);

    membership.add(janeInSales);
    expect(auth.stepUpRequested).toBe(true);
    expect(addGroup).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  });

  it('makes the change after step-up when the server says the elevated session is gone', async () => {
    const { membership, auth, onChanged, onFailed } = setup();
    removeGroup.mockRejectedValueOnce(new ApiError(403, 'step_up_required', 'step-up required'));
    const after = vi.fn();

    membership.remove(janeInSales, after);
    await vi.waitFor(() => expect(removeGroup).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(membership.pending.value).toBeNull());
    expect(onFailed).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(after).toHaveBeenCalledOnce());
    expect(removeGroup).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it.each([
    ['add', 'remove', removeGroup],
    ['remove', 'add', addGroup],
  ] as const)('undoes an %s with a %s', async (change, inverse, call) => {
    const { membership, onChanged } = setup();

    membership[change](janeInSales);
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(call).not.toHaveBeenCalled();

    (onChanged.mock.calls[0]![2] as { undo: () => void }).undo();
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(call).toHaveBeenCalledWith('u1', { groupId: 'g1' });
    expect(onChanged.mock.calls[1]).toEqual([inverse, janeInSales, null]);
  });

  it('says which change a failure was', async () => {
    const { membership } = setup();
    removeGroup.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));

    membership.remove(janeInSales);
    await vi.waitFor(() =>
      expect(membership.failure.value).toEqual({
        op: { change: 'remove', membership: janeInSales },
        message: 'DC unreachable',
        undo: false,
      }),
    );
  });

  it('words a change by what it does', () => {
    expect(membershipDoneText('add', janeInSales)).toBe('Added Jane Doe to Sales');
    expect(membershipDoneText('remove', janeInSales)).toBe('Removed Jane Doe from Sales');
    expect(membershipChangeText('add', janeInSales)).toBe('add Jane Doe to Sales');
    expect(membershipChangeText('remove', janeInSales)).toBe('remove Jane Doe from Sales');
  });
});
