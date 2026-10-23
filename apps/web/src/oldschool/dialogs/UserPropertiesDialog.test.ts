// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aUserDetail } from '../../test/userDetail.js';

const api = {
  users: {
    get: vi.fn(async () => ({ user: aUserDetail({ title: 'Analyst', locked: true }) })),
    update: vi.fn(async () => ({})),
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

const { default: UserPropertiesDialog } = await import('./UserPropertiesDialog.vue');
const { useAuthStore } = await import('../../stores/auth.js');
const { useOldSchool } = await import('../stores/useOldSchool.js');

async function openProperties(capabilities: string[]) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.actor = {
    capabilities,
    elevated: { active: false, idleExpiresAt: null, absoluteExpiresAt: null },
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

  it('show a read-only operator nothing they can change', async () => {
    const { dialog } = await openProperties(['read:user']);

    expect(dialog.get('#displayName').attributes('disabled')).toBeDefined();
    await openTab(dialog, 'Account');
    expect(dialog.get('input[type="checkbox"]').attributes('disabled')).toBeDefined();
    await openTab(dialog, 'Member Of');
    expect(button(dialog, 'Add…').attributes('disabled')).toBeDefined();
  });
});
