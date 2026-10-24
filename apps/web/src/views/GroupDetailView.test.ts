// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import Tooltip from 'primevue/tooltip';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupLicenses, LicensedGroups } from '@openaduc/shared';
import { ApiError } from '../api/client.js';

const jane = {
  kind: 'user',
  id: 'u1',
  samAccountName: 'jdoe',
  userPrincipalName: 'jdoe@corp.example',
  displayName: 'Jane Doe',
  email: null,
  enabled: true,
  locked: false,
  passwordNeverExpires: false,
};
const nested = {
  kind: 'group',
  id: 'g9',
  name: 'Interns',
  samAccountName: 'interns',
  distinguishedName: 'CN=Interns,DC=corp,DC=example',
  description: null,
  groupType: 'security',
  groupScope: 'global',
};
const aGroup = (id: string, name: string) => ({
  id,
  name,
  samAccountName: name.toLowerCase(),
  distinguishedName: `CN=${name},DC=corp,DC=example`,
  description: null,
  groupType: 'security',
  groupScope: 'global',
  memberCount: 2,
  email: null,
  entra: null as { licenses: boolean } | null,
  members: [jane, nested],
  freshness: { cachedAt: null, liveRefreshedAt: null },
});
const api = {
  groups: {
    get: vi.fn(async (id: string) => ({
      group: aGroup(id, id === 'g1' ? 'Engineering' : 'Sales'),
    })),
    search: vi.fn(async () => ({
      rows: [{ ...aGroup('g5', 'Contractors'), memberCount: 0 }],
      total: 1,
    })),
    addGroup: vi.fn(async () => ({ ok: true })),
    removeGroup: vi.fn(async () => ({ ok: true })),
    deletePreflight: vi.fn(async (id: string) => ({
      id,
      name: 'Engineering',
      samAccountName: 'engineering',
      distinguishedName: 'CN=Engineering,DC=corp,DC=example',
      memberCount: 2,
      memberOf: [
        {
          id: 'g7',
          name: 'All Staff',
          distinguishedName: 'CN=All Staff,DC=corp',
          protected: false,
        },
      ],
      primaryGroupMembers: 0,
      blockedReason: null,
      role: null,
    })),
    remove: vi.fn(async () => ({ ok: true })),
    licensed: vi.fn(async (): Promise<LicensedGroups> => ({
      enabled: false,
      refreshedAt: null,
      refreshFailed: false,
      groups: [],
    })),
    licenses: vi.fn<(id: string) => Promise<GroupLicenses>>(),
  },
  users: {
    search: vi.fn(async () => ({
      rows: [{ ...jane, id: 'u2', displayName: 'John Smith', samAccountName: 'jsmith' }],
      total: 1,
    })),
    addGroup: vi.fn(async () => ({ ok: true })),
    removeGroup: vi.fn(async () => ({ ok: true })),
  },
};
vi.mock('../api/index.js', () => ({ api }));

const { default: GroupDetailView } = await import('./GroupDetailView.vue');
const { useAuthStore } = await import('../stores/auth.js');
const { onShortcutKey, shortcuts } = await import('../design/composables/useShortcuts.js');

enableAutoUnmount(afterEach);

async function openMembers(
  id = 'g1',
  capabilities = ['read:group', 'write:group.membership'],
  tab = 'members',
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().actor = {
    directoryId: 1,
    capabilities,
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
      { path: '/groups', name: 'group-search', component: { render: () => null } },
    ],
  });
  await router.push(`/groups/${id}?tab=${tab}`);
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

async function click(page: Page, label: string, nth = 0) {
  const button = page.findAll('button').filter((b) => b.text() === label)[nth];
  expect(button).toBeDefined();
  await button!.trigger('click');
  await flushPromises();
}

async function addMember(page: Page, query: string, pick: string) {
  await click(page, 'Add member');
  await page.get('[role="dialog"] input').setValue(query);
  const option = await vi.waitFor(() => {
    const found = page.findAll('[role="option"]').find((o) => o.text().includes(pick));
    expect(found).toBeDefined();
    return found!;
  });
  await option.trigger('click');
  await click(page, 'Add');
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

  it('lists a nested group among the members, and opens its page', async () => {
    const { page, router } = await openMembers();

    const row = page.findAll('.members-table tbody tr').find((r) => r.text().includes('Interns'));
    expect(row?.text()).toContain('group');
    await row!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/groups/g9');
  });

  it('takes a nested group out without asking, and Undo puts it back', async () => {
    const { page } = await openMembers();

    await click(page, 'Remove', 1);
    expect(api.groups.removeGroup).toHaveBeenCalledWith('g9', { groupId: 'g1' });
    expect(page.text()).toContain('Removed Interns from Engineering');

    await click(page, 'Undo');
    expect(api.groups.addGroup).toHaveBeenCalledWith('g9', { groupId: 'g1' });
  });

  it('adds a user or a group found by name', async () => {
    const { page } = await openMembers();

    await addMember(page, 'jo', 'John Smith');
    expect(api.users.addGroup).toHaveBeenCalledWith('u2', { groupId: 'g1' });
    expect(page.text()).toContain('Added John Smith to Engineering');

    await addMember(page, 'con', 'Contractors');
    expect(api.groups.addGroup).toHaveBeenCalledWith('g5', { groupId: 'g1' });
    expect(page.text()).toContain('Added Contractors to Engineering');
    expect(api.groups.get).toHaveBeenCalledTimes(3);
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

describe('deleting a group', () => {
  async function actionLabels(page: Page) {
    await click(page, 'Actions');
    return page.findAll('[role="menuitem"]').map((i) => i.text());
  }

  it('is offered only to operators who may delete groups', async () => {
    const { page: operator } = await openMembers();
    expect(await actionLabels(operator)).not.toContain('Delete…');

    const { page: admin } = await openMembers('g1', [
      'read:group',
      'write:group.membership',
      'write:group.delete',
    ]);
    expect(await actionLabels(admin)).toContain('Delete…');
  });

  it('asks first, with the member count and parent groups, then goes to the group list', async () => {
    const { page, router } = await openMembers(
      'g1',
      ['read:group', 'write:group.delete'],
      'overview',
    );
    await click(page, 'Actions');
    const item = page.findAll('[role="menuitem"]').find((i) => i.text() === 'Delete…')!;
    await item.find('a').trigger('click');
    await flushPromises();

    const dialog = page.get('[role="dialog"]');
    expect(dialog.text()).toContain('2 members');
    expect(dialog.text()).toContain('All Staff');
    const confirm = () => dialog.findAll('button').find((b) => b.text() === 'Delete group')!;
    expect(confirm().attributes('disabled')).toBeDefined();
    expect(api.groups.remove).not.toHaveBeenCalled();

    await dialog.get('#dg-confirm-input').setValue('engineering');
    await confirm().trigger('click');
    await flushPromises();

    expect(api.groups.remove).toHaveBeenCalledWith('g1', { confirmSamAccountName: 'engineering' });
    expect(router.currentRoute.value.name).toBe('group-search');
  });
});

describe('shortcuts on a group’s page', () => {
  beforeAll(() => window.addEventListener('keydown', onShortcutKey));
  afterAll(() => window.removeEventListener('keydown', onShortcutKey));

  const listed = () => shortcuts.value.map((s) => `${s.section} ${s.key} ${s.label}`);

  it('add a member on a, switch tabs, and leave Delete without a key', async () => {
    const { page } = await openMembers('g1', [
      'read:group',
      'write:group.membership',
      'write:group.delete',
    ]);
    expect(listed()).toEqual(['Actions a Add member…', 'Tabs 1 Overview', 'Tabs 2 Members']);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', cancelable: true }));
    await flushPromises();
    expect(page.find('[role="dialog"] input').exists()).toBe(true);
  });

  it('offer no Add member key to an operator who can’t manage members', async () => {
    await openMembers('g1', ['read:group']);
    expect(listed()).toEqual(['Tabs 1 Overview', 'Tabs 2 Members']);
  });
});

describe('a group’s licenses', () => {
  const e3 = { skuId: 'e3', skuPartNumber: 'SPE_E3', name: 'Microsoft 365 E3' };

  beforeEach(() => {
    vi.clearAllMocks();
    api.groups.get.mockImplementation(async (id: string) => ({
      group: { ...aGroup(id, 'Engineering'), entra: { licenses: true } },
    }));
    api.groups.licensed.mockResolvedValue({
      enabled: true,
      refreshedAt: '2026-10-24T11:00:00Z',
      refreshFailed: false,
      groups: [{ id: 'g5', licenses: [e3] }],
    });
    api.groups.licenses.mockResolvedValue({
      status: 'synced',
      licenses: [{ ...e3, disabledPlanCount: 1 }],
      processingState: 'ProcessingComplete',
    });
  });
  afterAll(() => {
    api.groups.get.mockImplementation(async (id: string) => ({
      group: aGroup(id, id === 'g1' ? 'Engineering' : 'Sales'),
    }));
    api.groups.licensed.mockResolvedValue({
      enabled: false,
      refreshedAt: null,
      refreshFailed: false,
      groups: [],
    });
  });

  it('shows what the group grants, read live, when the Entra integration reads licenses', async () => {
    const { page } = await openMembers('g1', ['read:group'], 'overview');
    expect(api.groups.licenses).toHaveBeenCalledWith('g1');
    const card = page.findAll('.glic').at(0);
    expect(card?.text()).toContain('Members get these through the group');
    expect(card?.text()).toContain('Microsoft 365 E3');
    expect(card?.text()).toContain('1 service plan turned off');
  });

  it('shows no licenses where the Entra integration doesn’t read them', async () => {
    api.groups.get.mockImplementation(async (id: string) => ({
      group: { ...aGroup(id, 'Engineering'), entra: { licenses: false } },
    }));
    const { page } = await openMembers('g1', ['read:group'], 'overview');
    expect(page.find('.glic').exists()).toBe(false);
    expect(api.groups.licenses).not.toHaveBeenCalled();
  });

  it('badges a licensed group among the members to add', async () => {
    const { page } = await openMembers();
    await click(page, 'Add member');
    await page.get('[role="dialog"] input').setValue('con');
    const option = await vi.waitFor(() => {
      const found = page.findAll('[role="option"]').find((o) => o.text().includes('Contractors'));
      expect(found).toBeDefined();
      return found!;
    });
    expect(option.find('.license-badge').text()).toBe('Microsoft 365 E3');
  });

  it('says when the badges couldn’t be refreshed', async () => {
    api.groups.licensed.mockResolvedValue({
      enabled: true,
      refreshedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      refreshFailed: true,
      groups: [{ id: 'g5', licenses: [e3] }],
    });
    const { page } = await openMembers();
    await click(page, 'Add member');
    await page.get('[role="dialog"] input').setValue('con');
    await vi.waitFor(() =>
      expect(page.find('.license-note').text()).toBe(
        'License badges couldn’t be refreshed from Microsoft Entra. Last updated 2h ago.',
      ),
    );
  });
});
