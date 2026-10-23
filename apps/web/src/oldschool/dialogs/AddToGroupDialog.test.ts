// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aUserDetail } from '../../test/userDetail.js';
import { ApiError } from '../../api/client.js';

const aGroup = (id: string, name: string) => ({
  id,
  name,
  samAccountName: name,
  distinguishedName: `CN=${name},DC=corp,DC=example`,
  description: null,
  groupType: 'security',
  groupScope: 'global',
  memberCount: 0,
});
const api = {
  users: {
    get: vi.fn(async () => ({
      user: aUserDetail({
        groupMemberships: [
          { id: 'g2', name: 'Staff', distinguishedName: 'CN=Staff', direct: true },
          { id: 'g3', name: 'Ops', distinguishedName: 'CN=Ops', direct: false },
        ] as never,
      }),
    })),
    addGroup: vi.fn(async () => ({ ok: true })),
  },
  groups: {
    search: vi.fn(async () => ({
      rows: [aGroup('g1', 'Sales'), aGroup('g2', 'Staff'), aGroup('g3', 'Ops')],
      total: 3,
    })),
  },
};
vi.mock('../../api/index.js', () => ({ api }));
const toast = { add: vi.fn() };
vi.mock('primevue/usetoast', () => ({ useToast: () => toast }));

const { default: AddToGroupDialog } = await import('./AddToGroupDialog.vue');
const { useAuthStore } = await import('../../stores/auth.js');
const { useOldSchool } = await import('../stores/useOldSchool.js');

async function openAddToGroup() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().actor = {
    capabilities: ['read:user', 'write:group.membership'],
    elevated: {
      active: true,
      idleExpiresAt: '2999-01-01T00:15:00.000Z',
      absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
    },
  } as never;
  const oldSchool = useOldSchool();
  oldSchool.openDialog({ kind: 'add-to-group', userId: 'u1', userLabel: 'Jane Doe' });
  const dialog = mount(AddToGroupDialog, {
    props: { windowId: oldSchool.windows[0]!.id, userId: 'u1', userLabel: 'Jane Doe' },
    global: { plugins: [pinia, PrimeVue], stubs: { teleport: true } },
  });
  await flushPromises();
  await dialog.get('input.os-input').setValue('s');
  await vi.advanceTimersByTimeAsync(200);
  await dialog.get('input.os-input').setValue('sa');
  await vi.advanceTimersByTimeAsync(200);
  await flushPromises();
  return { dialog, oldSchool };
}

const row = (dialog: Awaited<ReturnType<typeof openAddToGroup>>['dialog'], name: string) =>
  dialog.findAll('.os-listbox-row').find((r) => r.text().includes(name))!;
const ok = (dialog: Awaited<ReturnType<typeof openAddToGroup>>['dialog']) =>
  dialog.findAll('button').find((b) => b.text() === 'OK')!;

describe('the Old School add to group dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('won’t add the user to a group they’re directly in, but will to one they’re in by nesting', async () => {
    const { dialog } = await openAddToGroup();
    expect(api.groups.search).toHaveBeenCalledOnce();
    expect(row(dialog, 'Staff').text()).toContain('(already a member)');
    expect(row(dialog, 'Ops').text()).toContain('(member via a nested group)');

    await row(dialog, 'Staff').trigger('click');
    expect(ok(dialog).attributes('disabled')).toBeDefined();
    await row(dialog, 'Ops').trigger('click');
    expect(ok(dialog).attributes('disabled')).toBeUndefined();
  });

  it('says when the group search failed', async () => {
    api.groups.search.mockRejectedValueOnce(
      new ApiError(503, 'unavailable', 'directory unreachable'),
    );
    const { dialog } = await openAddToGroup();
    expect(dialog.text()).toContain('The search failed: directory unreachable');
    expect(dialog.text()).not.toContain('No matches.');
  });

  it('adds the user to the chosen group, then refreshes and closes', async () => {
    const { dialog, oldSchool } = await openAddToGroup();
    const version = oldSchool.dataVersion;

    await row(dialog, 'Sales').trigger('click');
    await ok(dialog).trigger('click');
    await flushPromises();
    expect(api.users.addGroup).toHaveBeenCalledWith('u1', { groupId: 'g1' });
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'Added Jane Doe to Sales.' }),
    );
    expect(oldSchool.dataVersion).toBe(version + 1);
    expect(dialog.emitted('close')).toHaveLength(1);
  });

  it('says in a message box why the add failed', async () => {
    api.users.addGroup.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));
    const { dialog, oldSchool } = await openAddToGroup();

    await row(dialog, 'Sales').trigger('click');
    await ok(dialog).trigger('click');
    await flushPromises();
    expect(oldSchool.windows.at(-1)!.dialog).toEqual({
      kind: 'message',
      title: 'Active Directory Domain Services',
      message: 'Windows cannot add Jane Doe to Sales because:\nDC unreachable',
    });
    expect(dialog.emitted('close')).toBeUndefined();
  });
});
