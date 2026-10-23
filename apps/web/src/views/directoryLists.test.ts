// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import type { Component } from 'vue';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

const freshness = { lastSyncedAt: null, stale: false };
const jane = {
  id: 'u1',
  samAccountName: 'jdoe',
  userPrincipalName: 'jdoe@corp.example',
  displayName: 'Jane Doe',
  email: null,
  enabled: true,
  locked: false,
  passwordNeverExpires: false,
  passwordExpiresAt: null,
  lastLogonAt: null,
  modifiedAtSource: null,
  department: null,
  title: null,
};
const finance = {
  id: 'g1',
  name: 'Finance',
  samAccountName: 'finance',
  distinguishedName: 'CN=Finance,DC=corp,DC=example',
  description: null,
  groupType: 'security',
  groupScope: 'global',
  memberCount: 0,
  email: null,
};
const ws01 = {
  id: 'c1',
  name: 'WS01',
  samAccountName: 'WS01$',
  distinguishedName: 'CN=WS01,DC=corp,DC=example',
  dnsHostName: 'ws01.corp.example',
  operatingSystem: null,
  operatingSystemVersion: null,
  enabled: true,
  lastLogonAt: null,
};

// Each search waits until the test lets it answer.
let answer: () => void = () => {};
const pending = <T>(value: T) =>
  vi.fn(
    () =>
      new Promise<T>((resolve) => {
        answer = () => resolve(value);
      }),
  );
const api = {
  users: { search: pending({ rows: [jane], total: 1, freshness }) },
  groups: { search: pending({ rows: [finance], total: 1, freshness }) },
  computers: { search: pending({ rows: [ws01], total: 1, freshness }) },
};
vi.mock('../api/index.js', () => ({ api }));

const lists: [string, Component][] = [
  ['users', (await import('./UserSearchView.vue')).default],
  ['groups', (await import('./GroupSearchView.vue')).default],
  ['computers', (await import('./ComputerSearchView.vue')).default],
];
const { useAuthStore } = await import('../stores/auth.js');
const { useThemeStore } = await import('../design/stores/useTheme.js');

enableAutoUnmount(afterEach);

async function openList(view: Component, density: 'compact' | 'balanced' | 'comfy' = 'balanced') {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().actor = { capabilities: ['read:user', 'read:group', 'read:computer'] } as never;
  useThemeStore().setDensity(density);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/list', component: view },
      { path: '/:other(.*)', name: 'other', component: { render: () => null } },
    ],
  });
  for (const name of ['user-detail', 'group-detail', 'computer-detail']) {
    router.addRoute({ path: `/${name}/:id`, name, component: { render: () => null } });
  }
  for (const name of ['deleted-users', 'deleted-computers', 'user-search', 'group-search']) {
    router.addRoute({ path: `/${name}`, name, component: { render: () => null } });
  }
  await router.push('/list');
  const page = mount(RouterView, {
    attachTo: document.body,
    global: { plugins: [pinia, router, PrimeVue, ToastService], stubs: { teleport: true } },
  });
  await flushPromises();
  return page;
}

describe.each(lists)('the %s list while it loads', (_name, view) => {
  it('shows skeleton rows in the table, then the rows in the same table', async () => {
    const page = await openList(view);
    const table = page.get('.p-datatable').element;
    const skeleton = page.get('.list-skeleton');
    expect(skeleton.attributes('role')).toBe('status');
    expect(skeleton.findAll('.list-skeleton-row').length).toBeGreaterThan(0);
    expect(page.find('.ds-empty').exists()).toBe(false);
    expect(page.get('.page-title').text()).not.toContain('(0)');

    answer();
    await flushPromises();
    expect(page.find('.list-skeleton').exists()).toBe(false);
    expect(page.get('.p-datatable').element).toBe(table);
    // A test DOM has no viewport, so the virtual scroller renders no rows.
    expect(page.get('.page-title').text()).toContain('(1)');
    expect(page.find('.ds-empty').exists()).toBe(false);
  });

  it('sizes its rows like the list’s rows for the density', async () => {
    for (const [density, height] of [
      ['compact', '40px'],
      ['comfy', '56px'],
    ] as const) {
      const page = await openList(view, density);
      const rows = page.findAll('.list-skeleton-row');
      expect(rows[0]!.attributes('style')).toContain(`height: ${height}`);
      answer();
      await flushPromises();
      page.unmount();
    }
  });
});
