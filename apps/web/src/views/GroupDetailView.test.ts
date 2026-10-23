// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import Tooltip from 'primevue/tooltip';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';

const jane = {
  id: 'u1',
  samAccountName: 'jdoe',
  userPrincipalName: 'jdoe@corp.example',
  displayName: 'Jane Doe',
  email: null,
  enabled: true,
  locked: false,
  passwordNeverExpires: false,
};
const aGroup = (id: string, name: string) => ({
  id,
  name,
  samAccountName: name.toLowerCase(),
  distinguishedName: `CN=${name},DC=corp,DC=example`,
  description: null,
  groupType: 'security',
  groupScope: 'global',
  memberCount: 1,
  email: null,
  members: [jane],
  freshness: { cachedAt: null, liveRefreshedAt: null },
});
const api = {
  groups: {
    get: vi.fn(async (id: string) => ({
      group: aGroup(id, id === 'g1' ? 'Engineering' : 'Sales'),
    })),
  },
  users: {
    addGroup: vi.fn(async () => ({ ok: true })),
    removeGroup: vi.fn(async () => ({ ok: true })),
  },
};
vi.mock('../api/index.js', () => ({ api }));

const { default: GroupDetailView } = await import('./GroupDetailView.vue');
const { useAuthStore } = await import('../stores/auth.js');

enableAutoUnmount(afterEach);

async function openMembers(id = 'g1') {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().actor = {
    capabilities: ['read:group', 'write:group.membership'],
    elevated: {
      active: true,
      idleExpiresAt: '2999-01-01T00:15:00.000Z',
      absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
    },
  } as never;
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/groups/:id', name: 'group-detail', component: GroupDetailView, props: true },
      { path: '/users/:id', name: 'user-detail', component: { render: () => null } },
    ],
  });
  await router.push(`/groups/${id}?tab=members`);
  const page = mount(RouterView, {
    global: {
      plugins: [pinia, router, PrimeVue, ToastService],
      directives: { tooltip: Tooltip },
      stubs: { teleport: true },
    },
  });
  await flushPromises();
  return { page, router };
}

type Page = Awaited<ReturnType<typeof openMembers>>['page'];

async function click(page: Page, label: string) {
  const button = page.findAll('button').find((b) => b.text() === label);
  expect(button).toBeDefined();
  await button!.trigger('click');
  await flushPromises();
}

describe('changing a group’s members', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes a member without asking, and Undo adds them back', async () => {
    const { page } = await openMembers();

    await click(page, 'Remove');
    expect(api.users.removeGroup).toHaveBeenCalledWith('u1', { groupId: 'g1' });
    expect(page.find('[role="dialog"]').exists()).toBe(false);
    expect(page.text()).toContain('Removed Jane Doe from Engineering');

    await click(page, 'Undo');
    expect(api.users.addGroup).toHaveBeenCalledWith('u1', { groupId: 'g1' });
    expect(page.text()).toContain('Added Jane Doe to Engineering');
  });

  it('keeps a failed remove on the Members tab until dismissed', async () => {
    api.users.removeGroup.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));
    const { page } = await openMembers();

    await click(page, 'Remove');
    const failure = page.get('.inline-failure');
    expect(failure.text()).toContain('Couldn’t remove Jane Doe from Engineering');
    expect(failure.text()).toContain('DC unreachable');

    await failure.get('button[aria-label="Close"]').trigger('click');
    await flushPromises();
    expect(page.find('.inline-failure').exists()).toBe(false);
  });

  it('shows a failed Undo of a remove on the Members tab, not in the add dialog', async () => {
    api.users.addGroup.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));
    const { page } = await openMembers();

    await click(page, 'Remove');
    await click(page, 'Undo');
    expect(page.get('.inline-failure').text()).toContain('Couldn’t add Jane Doe to Engineering');

    await click(page, 'Add member');
    expect(page.get('[role="dialog"]').text()).not.toContain('Couldn’t add');
    expect(page.find('.inline-failure').exists()).toBe(true);
  });

  it('forgets a failure once the page shows another group', async () => {
    api.users.removeGroup.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));
    const { page, router } = await openMembers();
    await click(page, 'Remove');
    expect(page.find('.inline-failure').exists()).toBe(true);

    await router.push('/groups/g2?tab=members');
    await flushPromises();
    expect(page.text()).toContain('Sales');
    expect(page.find('.inline-failure').exists()).toBe(false);
  });
});
