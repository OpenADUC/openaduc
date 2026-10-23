// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupDeletePreflightResponse } from '@openaduc/shared';
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
  api: { groups: { deletePreflight, remove }, auth: { stepUp } },
}));

const { useGroupDeletion } = await import('./useGroupDeletion.js');
const { useAuthStore } = await import('../../stores/auth.js');

const falcon = (
  over: Partial<GroupDeletePreflightResponse> = {},
): GroupDeletePreflightResponse => ({
  id: 'g1',
  name: 'Project Falcon',
  samAccountName: 'project.falcon',
  distinguishedName: 'CN=Project Falcon,OU=Groups,DC=corp,DC=test',
  memberCount: 3,
  memberOf: [
    {
      id: 'g2',
      name: 'All Staff',
      distinguishedName: 'CN=All Staff,DC=corp,DC=test',
      protected: false,
    },
  ],
  primaryGroupMembers: 0,
  blockedReason: null,
  role: null,
  ...over,
});

async function loaded(preflight = falcon(), elevated = true) {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.actor = {
    capabilities: ['read:group', 'write:group.delete'],
    elevated: { active: elevated },
  } as never;
  deletePreflight.mockResolvedValue(preflight);
  const onDeleted = vi.fn();
  const deletion = useGroupDeletion({ onDeleted });
  await deletion.load('g1');
  return { deletion, auth, onDeleted };
}

describe('useGroupDeletion', () => {
  beforeEach(() => {
    remove.mockReset().mockResolvedValue({ ok: true });
  });

  it('shows what the group holds and belongs to before asking', async () => {
    const { deletion } = await loaded();

    expect(deletion.phase.value).toBe('review');
    expect(deletion.preflight.value).toMatchObject({ memberCount: 3, memberOf: [{ id: 'g2' }] });
    expect(deletion.confirmed.value).toBe(false);
  });

  it('is confirmed once the pre-Windows 2000 name is typed, in any case', async () => {
    const { deletion } = await loaded();

    deletion.typed.value = ' Project.Falcon ';

    expect(deletion.confirmed.value).toBe(true);
  });

  it('can’t be confirmed for a group that refuses deletion, and says why', async () => {
    const { deletion } = await loaded(falcon({ blockedReason: 'protected_group' }));

    deletion.typed.value = 'project.falcon';
    deletion.remove();

    expect(deletion.confirmed.value).toBe(false);
    expect(deletion.blockedText.value).toMatch(/protected administrative group/);
    expect(remove).not.toHaveBeenCalled();
  });

  it('names the role a role group grants, and the protected group it sits in', async () => {
    const { deletion: role } = await loaded(
      falcon({ blockedReason: 'role_group', role: 'operator' }),
    );
    expect(role.blockedText.value).toMatch(/grants OpenADUC’s operator role/);

    const { deletion: nested } = await loaded(
      falcon({
        blockedReason: 'member_of_protected_group',
        memberOf: [
          {
            id: 'g3',
            name: 'Domain Admins',
            distinguishedName: 'CN=Domain Admins',
            protected: true,
          },
          { id: 'g2', name: 'All Staff', distinguishedName: 'CN=All Staff', protected: false },
        ],
      }),
    );
    expect(nested.blockedText.value).toBe(
      'It’s a member of Domain Admins, a protected group. Take it out first.',
    );

    const { deletion: primary } = await loaded(
      falcon({ blockedReason: 'primary_group', primaryGroupMembers: 2 }),
    );
    expect(primary.blockedText.value).toMatch(/primary group of 2 accounts/);
  });

  it('prompts step-up before the first delete, then deletes', async () => {
    const { deletion, auth, onDeleted } = await loaded(falcon(), false);
    deletion.typed.value = 'project.falcon';

    deletion.remove();
    expect(auth.stepUpRequested).toBe(true);
    expect(remove).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
    expect(remove).toHaveBeenCalledWith('g1', { confirmSamAccountName: 'project.falcon' });
  });

  it('deletes after step-up when the server says the elevated session is gone', async () => {
    const { deletion, auth, onDeleted } = await loaded();
    remove.mockRejectedValueOnce(new ApiError(403, 'step_up_required', 'step-up required'));
    deletion.typed.value = 'project.falcon';

    deletion.remove();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    expect(deletion.error.value).toBeNull();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
  });

  it('keeps a refused delete in the dialog, with the directory’s reason', async () => {
    const { deletion, onDeleted } = await loaded();
    remove.mockRejectedValueOnce(new ApiError(403, 'forbidden', 'directory refused the delete'));
    deletion.typed.value = 'project.falcon';

    deletion.remove();

    await vi.waitFor(() => expect(deletion.error.value).toBe('directory refused the delete'));
    expect(deletion.deleting.value).toBe(false);
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('says why the group couldn’t be checked', async () => {
    setActivePinia(createPinia());
    useAuthStore().actor = { capabilities: [], elevated: { active: true } } as never;
    deletePreflight.mockRejectedValueOnce(new ApiError(404, 'not_found', 'group not found'));
    const deletion = useGroupDeletion({ onDeleted: vi.fn() });

    await deletion.load('g1');

    expect(deletion.phase.value).toBe('error');
    expect(deletion.loadError.value).toBe('group not found');
  });
});
