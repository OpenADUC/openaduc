// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aUserDetail } from '../../test/userDetail.js';

const api = {
  users: {
    get: vi.fn(async () => ({ user: aUserDetail({ locked: true }) })),
    resetPassword: vi.fn(async () => ({ ok: true })),
    unlock: vi.fn(async () => ({})),
  },
};
vi.mock('../../api/index.js', () => ({ api }));
const toast = { add: vi.fn() };
vi.mock('primevue/usetoast', () => ({ useToast: () => toast }));

const { default: ResetPasswordDialog } = await import('./ResetPasswordDialog.vue');
const { useAuthStore } = await import('../../stores/auth.js');
const { useOldSchool } = await import('../stores/useOldSchool.js');

async function openReset() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().actor = { capabilities: [], elevated: { active: true } } as never;
  const oldSchool = useOldSchool();
  oldSchool.openDialog({ kind: 'reset-password', id: 'u1', samAccountName: 'jdoe' });
  const dialog = mount(ResetPasswordDialog, {
    props: { windowId: oldSchool.windows[0]!.id, id: 'u1', samAccountName: 'jdoe' },
    global: { plugins: [pinia, PrimeVue], stubs: { teleport: true } },
  });
  await flushPromises();
  return dialog;
}

const button = (dialog: Awaited<ReturnType<typeof openReset>>, label: string) =>
  dialog.findAll('button').find((b) => b.text() === label)!;

describe('the Old School reset password dialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resets and unlocks a locked account in one request', async () => {
    const dialog = await openReset();
    const unlock = dialog
      .findAll('label')
      .find((l) => l.text().includes("Unlock the user's account"))!
      .get('input');
    expect((unlock.element as HTMLInputElement).checked).toBe(true);

    await dialog.get('#np').setValue('N3w-passw0rd!');
    await dialog.get('#cp').setValue('N3w-passw0rd!');
    await button(dialog, 'OK').trigger('click');
    await flushPromises();

    expect(api.users.resetPassword).toHaveBeenCalledWith('u1', {
      newPassword: 'N3w-passw0rd!',
      forceChangeAtNextLogin: true,
      unlock: true,
    });
    expect(api.users.unlock).not.toHaveBeenCalled();
  });

  it('needs the confirmation only while the password is hidden', async () => {
    const dialog = await openReset();
    await dialog.get('#np').setValue('N3w-passw0rd!');
    expect(button(dialog, 'OK').attributes('disabled')).toBeDefined();

    await button(dialog, 'Generate').trigger('click');
    expect(dialog.find('#cp').exists()).toBe(false);
    expect(button(dialog, 'OK').attributes('disabled')).toBeUndefined();
  });
});
