// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import type { Component } from 'vue';
import { RouterView, createMemoryHistory, createRouter, type Router } from 'vue-router';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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

type Search = { mockRejectedValueOnce(err: Error): unknown };
const lists: [string, Component, Search, string][] = [
  ['users', (await import('./UserSearchView.vue')).default, api.users.search, 'user'],
  ['groups', (await import('./GroupSearchView.vue')).default, api.groups.search, 'group'],
  [
    'computers',
    (await import('./ComputerSearchView.vue')).default,
    api.computers.search,
    'computer',
  ],
];
const { useAuthStore } = await import('../stores/auth.js');
const { useThemeStore } = await import('../design/stores/useTheme.js');
const { onShortcutKey, shortcuts } = await import('../design/composables/useShortcuts.js');

enableAutoUnmount(afterEach);

let router: Router;

async function openList(view: Component, density: 'compact' | 'balanced' | 'comfy' = 'balanced') {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().actor = { capabilities: ['read:user', 'read:group', 'read:computer'] } as never;
  useThemeStore().setDensity(density);
  router = createRouter({
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

const status = (page: Page) => page.get('.sr-only[role="status"]').text();
const busy = (page: Page) => page.get('.p-datatable').attributes('aria-busy');
type Page = Awaited<ReturnType<typeof openList>>;

describe.each(lists)('the %s list while it loads', (name, view, search, one) => {
  it('shows skeleton rows in the table, then the rows in the same table', async () => {
    const page = await openList(view);
    const table = page.get('.p-datatable').element;
    expect(page.findAll('.list-skeleton-row').length).toBeGreaterThan(0);
    expect(page.find('.ds-empty').exists()).toBe(false);
    expect(page.get('.page-title').text()).not.toContain('(0)');
    expect(status(page)).toBe(`Loading ${name}…`);
    expect(busy(page)).toBe('true');

    answer();
    await flushPromises();
    expect(page.find('.list-skeleton').exists()).toBe(false);
    expect(page.get('.p-datatable').element).toBe(table);
    // A test DOM has no viewport, so the virtual scroller renders no rows.
    expect(page.get('.page-title').text()).toContain('(1)');
    expect(page.find('.ds-empty').exists()).toBe(false);
    expect(status(page)).toBe(`1 ${one}`);
    expect(busy(page)).toBeUndefined();
  });

  it('keeps its rows, not a skeleton, while it refreshes', async () => {
    const page = await openList(view);
    answer();
    await flushPromises();

    await page
      .findAll('button')
      .find((b) => b.text() === 'Refresh')!
      .trigger('click');
    await flushPromises();
    expect(page.find('.list-skeleton').exists()).toBe(false);
    expect(page.get('.page-title').text()).toContain('(1)');
    expect(busy(page)).toBe('true');
    answer();
    await flushPromises();
  });

  it('shows a failed first load as before', async () => {
    search.mockRejectedValueOnce(new Error('DC unreachable'));
    const page = await openList(view);
    expect(page.find('.list-skeleton').exists()).toBe(false);
    expect(page.get('.p-message').text()).toContain('DC unreachable');
    expect(page.find('.ds-empty').exists()).toBe(true);
    expect(status(page)).toBe('');
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

// Two of each, listed out of the order the table sorts them in.
const second = {
  users: { ...jane, id: 'u0', samAccountName: 'aadams', displayName: 'Abe Adams' },
  groups: { ...finance, id: 'g0', name: 'Accounting', samAccountName: 'accounting' },
  computers: { ...ws01, id: 'c0', name: 'AP01', samAccountName: 'AP01$' },
};
const first = { users: jane, groups: finance, computers: ws01 };

describe.each(lists)('shortcuts on the %s list', (name, view, search, one) => {
  type Rows = { mockResolvedValueOnce(v: unknown): unknown };
  const key = name as keyof typeof second;

  // The virtual scroller renders rows only into a viewport with a height,
  // and needs its content's padding to work out how many fit.
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  const padding = document.createElement('style');
  padding.textContent = '.p-virtualscroller-content { padding: 0 }';
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 600,
    });
    document.head.append(padding);
    window.addEventListener('keydown', onShortcutKey);
  });
  afterAll(() => {
    if (height) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height);
    padding.remove();
    window.removeEventListener('keydown', onShortcutKey);
  });

  async function openTwo() {
    (search as unknown as Rows).mockResolvedValueOnce({
      rows: [first[key], second[key]],
      total: 2,
      freshness,
    });
    const page = await openList(view);
    await flushPromises();
    return page;
  }

  async function press(key: string, target: EventTarget = document.body) {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await flushPromises();
  }
  const highlighted = (page: Page) => page.findAll('tbody tr[aria-current="true"]');

  it('moves a highlight through the rows as sorted with j and k, and opens it on Enter', async () => {
    const page = await openTwo();
    expect(page.findAll('tbody tr[data-p-index]')).toHaveLength(2);
    expect(highlighted(page)).toHaveLength(0);

    await press('j');
    expect(highlighted(page)).toHaveLength(1);
    expect(highlighted(page)[0]!.attributes('data-p-index')).toBe('0');
    expect(highlighted(page)[0]!.classes()).toContain('is-highlighted');
    expect(document.activeElement).toBe(highlighted(page)[0]!.element);

    await press('j');
    await press('j');
    expect(highlighted(page)[0]!.attributes('data-p-index')).toBe('1');
    await press('k');
    expect(highlighted(page)[0]!.attributes('data-p-index')).toBe('0');

    await press('Enter');
    await flushPromises();
    expect(router.currentRoute.value.params['id']).toBe(second[key].id);
  });

  it('opens the Filters with the cursor in the search field on /', async () => {
    const page = await openTwo();
    await press('/');
    const field = document.activeElement as HTMLInputElement;
    expect(field.tagName).toBe('INPUT');
    expect(field.closest('[role="dialog"]')?.textContent).toContain('Filters');

    await press('j', field);
    expect(highlighted(page)).toHaveLength(0);
  });

  // Only the user list has row checkboxes.
  it.runIf(name === 'users')('keeps moving after a row’s checkbox is ticked', async () => {
    const page = await openTwo();
    const check = page.get('tbody input[type="checkbox"]');
    await check.trigger('click');
    (check.element as HTMLInputElement).focus();
    await press('j', check.element);
    expect(highlighted(page)).toHaveLength(1);
  });

  it('lists the list’s shortcuts', async () => {
    await openTwo();
    const listed = () =>
      shortcuts.value
        .filter((s) => s.section === 'List')
        .map((s) =>
          s.unavailable ? `${s.key} ${s.label} (${s.unavailable})` : `${s.key} ${s.label}`,
        );
    expect(listed()).toEqual([
      `/ Search ${name}`,
      'j Next row',
      'k Previous row',
      `Enter Open the highlighted ${one} (no row highlighted)`,
    ]);
    await press('j');
    expect(listed()[3]).toBe(`Enter Open the highlighted ${one}`);
  });
});
