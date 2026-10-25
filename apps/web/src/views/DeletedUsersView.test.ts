// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';

const jane = {
  id: 'd1',
  cn: 'Jane Doe',
  samAccountName: 'jdoe',
  userPrincipalName: null,
  displayName: 'Jane Doe',
  email: null,
  deletedDn: 'CN=Jane Doe\\0ADEL:d1,CN=Deleted Objects,DC=corp,DC=example',
  lastKnownParent: 'OU=Staff,DC=corp,DC=example',
  deletedAt: null,
  recycled: false,
};
const api = {
  deletedUsers: {
    search: vi.fn(async () => ({
      rows: [jane],
      total: 1,
      recycleBin: { recycleBinEnabled: true, message: null },
    })),
    restore: vi.fn(async () => ({})),
  },
};
vi.mock('../api/index.js', () => ({ api }));

const { default: DeletedUsersView } = await import('./DeletedUsersView.vue');
const { useAuthStore } = await import('../stores/auth.js');

enableAutoUnmount(afterEach);

async function openDeletedUsers() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().actor = {
    capabilities: ['read:user', 'write:user.restore'],
    elevated: {
      active: true,
      idleExpiresAt: '2999-01-01T00:15:00.000Z',
      absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
    },
  } as never;
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/deleted', component: DeletedUsersView },
      { path: '/users/:id', name: 'user-detail', component: { render: () => null } },
      { path: '/users', name: 'user-search', component: { render: () => null } },
    ],
  });
  await router.push('/deleted');
  const page = mount(RouterView, {
    global: { plugins: [pinia, router, PrimeVue, ToastService], stubs: { teleport: true } },
  });
  await flushPromises();
  return page;
}

const click = async (page: Awaited<ReturnType<typeof openDeletedUsers>>, label: string) => {
  await page
    .findAll('button')
    .find((b) => b.text() === label)!
    .trigger('click');
  await flushPromises();
};

describe('restoring a deleted user', () => {
  it('keeps a failed restore in the dialog until it’s retried', async () => {
    api.deletedUsers.restore.mockRejectedValueOnce(
      new ApiError(500, 'ldap_error', 'DC unreachable'),
    );
    const page = await openDeletedUsers();

    await click(page, 'Restore');
    await click(page, 'Restore user');
    expect(page.get('[role="dialog"]').text()).toContain('Restore failed: DC unreachable');

    await click(page, 'Restore user');
    expect(api.deletedUsers.restore).toHaveBeenCalledTimes(2);
    expect(page.text()).not.toContain('Restore failed');
  });
});
