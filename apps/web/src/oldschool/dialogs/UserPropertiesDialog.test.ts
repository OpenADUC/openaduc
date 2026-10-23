// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElevatedSessionState } from '@openaduc/shared';
import { aUserDetail } from '../../test/userDetail.js';
import { ApiError } from '../../api/client.js';

const api = {
  users: {
    get: vi.fn(async () => ({ user: aUserDetail({ title: 'Analyst', locked: true }) })),
    update: vi.fn(async () => ({})),
    unlock: vi.fn(async () => ({})),
    removeGroup: vi.fn(async () => ({ ok: true })),
    addGroup: vi.fn(async () => ({ ok: true })),
  },
  auth: {
    stepUp: vi.fn(async () => ({
      elevated: {
        active: true,
        idleExpiresAt: '2999-01-01T00:15:00.000Z',
        absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
      },
    })),
  },
};
vi.mock('../../api/index.js', () => ({ api }));
const toast = { add: vi.fn() };
vi.mock('primevue/usetoast', () => ({ useToast: () => toast }));

const { default: UserPropertiesDialog } = await import('./UserPropertiesDialog.vue');
const { useAuthStore } = await import('../../stores/auth.js');
const { useOldSchool } = await import('../stores/useOldSchool.js');

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

async function openProperties(capabilities: string[], elevated = NOT_ELEVATED) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.actor = {
    capabilities,
    elevated,
  } as never; // only these fields matter
  const oldSchool = useOldSchool();
  oldSchool.openDialog({ kind: 'user-properties', id: 'u1' });
  const dialog = mount(UserPropertiesDialog, {
    props: { windowId: oldSchool.windows[0]!.id, id: 'u1' },
    global: { plugins: [pinia, PrimeVue, ToastService], stubs: { teleport: true } },
  });
  await flushPromises();
  return { dialog, auth };
}

const button = (dialog: Awaited<ReturnType<typeof openProperties>>['dialog'], label: string) =>
  dialog.findAll('button').find((b) => b.text() === label)!;

async function openTab(dialog: Awaited<ReturnType<typeof openProperties>>['dialog'], tab: string) {
  await dialog
    .findAll('[role="tab"]')
    .find((t) => t.text() === tab)!
    .trigger('click');
}

describe('the Old School user properties', () => {
  beforeEach(() => vi.clearAllMocks());

  it('let a write-capable operator edit, then apply after step-up', async () => {
    const { dialog, auth } = await openProperties([
      'read:user',
      'write:user.attributes',
      'write:user.unlock',
      'write:group.membership',
    ]);

    await dialog.get('#displayName').setValue('Jane Q. Doe');
    await button(dialog, 'Apply').trigger('click');
    await flushPromises();
    expect(auth.stepUpRequested).toBe(true);
    expect(api.users.update).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await flushPromises();
    expect(api.users.update).toHaveBeenCalledWith('u1', {
      patch: { displayName: 'Jane Q. Doe' },
    });
  });

  it('apply again after step-up when the server says the elevated session is gone', async () => {
    const { dialog, auth } = await openProperties(['read:user', 'write:user.attributes'], ELEVATED);
    api.users.update.mockRejectedValueOnce(
      new ApiError(403, 'step_up_required', 'step-up required'),
    );

    await dialog.get('#displayName').setValue('Jane Q. Doe');
    await button(dialog, 'Apply').trigger('click');
    await flushPromises();
    expect(api.users.update).toHaveBeenCalledOnce();

    await auth.stepUp('pw');
    await flushPromises();
    expect(api.users.update).toHaveBeenCalledTimes(2);
  });

  it('apply Street to the work address, and are clean once applied', async () => {
    const { dialog } = await openProperties(['read:user', 'write:user.attributes'], ELEVATED);
    await openTab(dialog, 'Address');
    await dialog.get('#street').setValue('1 Main Street');
    expect(button(dialog, 'Apply').attributes('disabled')).toBeUndefined();

    const applied = { user: aUserDetail({ streetAddress: '1 Main Street' }) };
    api.users.get.mockResolvedValueOnce(applied).mockResolvedValueOnce(applied);
    await button(dialog, 'Apply').trigger('click');
    await flushPromises();
    expect(api.users.update).toHaveBeenCalledWith('u1', {
      patch: { streetAddress: '1 Main Street' },
    });
    expect((dialog.get('#street').element as HTMLTextAreaElement).value).toBe('1 Main Street');
    expect(button(dialog, 'Apply').attributes('disabled')).toBeDefined();
  });

  it('say why a value can’t be applied, and won’t apply it', async () => {
    const { dialog } = await openProperties(['read:user', 'write:user.attributes'], ELEVATED);

    await dialog.get('#email').setValue('not an address');
    expect(dialog.text()).toContain('E-mail: Not an email address');
    expect(dialog.get('#email').attributes('aria-invalid')).toBe('true');
    expect(button(dialog, 'Apply').attributes('disabled')).toBeDefined();
    expect(button(dialog, 'OK').attributes('disabled')).toBeDefined();
  });

  it('apply the attributes, then unlock, in one Apply', async () => {
    const { dialog } = await openProperties(
      ['read:user', 'write:user.attributes', 'write:user.unlock'],
      ELEVATED,
    );

    await dialog.get('#displayName').setValue(' Jane Q. Doe ');
    await openTab(dialog, 'Account');
    await dialog.get('input[type="checkbox"]').setValue(true);
    await button(dialog, 'Apply').trigger('click');
    await flushPromises();
    expect(api.users.update).toHaveBeenCalledWith('u1', { patch: { displayName: 'Jane Q. Doe' } });
    expect(api.users.unlock).toHaveBeenCalledOnce();
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ severity: 'success' }));
  });

  it('say in a message box when the account could not be unlocked', async () => {
    const { dialog } = await openProperties(['read:user', 'write:user.unlock'], ELEVATED);
    const oldSchool = useOldSchool();
    api.users.unlock.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));

    await openTab(dialog, 'Account');
    await dialog.get('input[type="checkbox"]').setValue(true);
    await button(dialog, 'Apply').trigger('click');
    await flushPromises();
    expect(api.users.unlock).toHaveBeenCalledOnce();
    expect(oldSchool.windows.at(-1)!.dialog).toMatchObject({
      kind: 'message',
      message: 'Unlock failed\nDC unreachable',
    });
  });

  it('remove a direct membership without asking, and offer Undo, but not one from a nested group', async () => {
    api.users.get.mockResolvedValueOnce({
      user: aUserDetail({
        groupMemberships: [
          { id: 'g1', name: 'Sales', distinguishedName: 'CN=Sales', direct: true },
          { id: 'g2', name: 'Staff', distinguishedName: 'CN=Staff', direct: false },
        ] as never,
      }),
    });
    const { dialog } = await openProperties(['read:user', 'write:group.membership'], ELEVATED);
    const oldSchool = useOldSchool();
    await openTab(dialog, 'Member Of');
    const row = (name: string) =>
      dialog.findAll('.os-listbox-row').find((r) => r.text().includes(name))!;

    await row('Staff').trigger('click');
    expect(button(dialog, 'Remove').attributes('disabled')).toBeDefined();

    await row('Sales').trigger('click');
    const version = oldSchool.dataVersion;
    await button(dialog, 'Remove').trigger('click');
    await flushPromises();
    expect(oldSchool.windows).toHaveLength(1);
    expect(api.users.removeGroup).toHaveBeenCalledWith('u1', { groupId: 'g1' });
    expect(oldSchool.dataVersion).toBe(version + 1);

    const removed = toast.add.mock.calls.at(-1)![0] as { summary: string; undo: () => void };
    expect(removed.summary).toBe('Jane Doe removed from Sales.');
    removed.undo();
    await flushPromises();
    expect(api.users.addGroup).toHaveBeenCalledWith('u1', { groupId: 'g1' });
    expect(oldSchool.dataVersion).toBe(version + 2);
  });

  it('say in a message box when a membership can’t be removed', async () => {
    api.users.get.mockResolvedValueOnce({
      user: aUserDetail({
        groupMemberships: [
          { id: 'g1', name: 'Sales', distinguishedName: 'CN=Sales', direct: true },
        ] as never,
      }),
    });
    api.users.removeGroup.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));
    const { dialog } = await openProperties(['read:user', 'write:group.membership'], ELEVATED);
    const oldSchool = useOldSchool();
    await openTab(dialog, 'Member Of');

    await dialog
      .findAll('.os-listbox-row')
      .find((r) => r.text().includes('Sales'))!
      .trigger('click');
    await button(dialog, 'Remove').trigger('click');
    await flushPromises();
    expect(oldSchool.windows.at(-1)!.dialog).toEqual({
      kind: 'message',
      title: 'Active Directory Domain Services',
      message: 'Windows cannot remove Jane Doe from Sales because:\nDC unreachable',
    });
  });

  it('show a read-only operator nothing they can change', async () => {
    const { dialog } = await openProperties(['read:user']);

    expect(dialog.get('#displayName').attributes('disabled')).toBeDefined();
    await openTab(dialog, 'Account');
    expect(dialog.text()).not.toContain('Unlock account');
    await openTab(dialog, 'Member Of');
    expect(dialog.findAll('button').some((b) => b.text() === 'Add…')).toBe(false);
  });
});
