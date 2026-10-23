// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  users: {
    search: vi.fn(async () => ({
      rows: [
        { id: 'u1', displayName: 'Sam Sales', samAccountName: 'ssales', email: null },
        { id: 'u2', displayName: 'Sally Salt', samAccountName: 'ssalt', email: null },
      ],
    })),
  },
  groups: {
    search: vi.fn(async () => ({
      rows: [{ id: 'g1', name: 'Sales Team', description: null, memberCount: 3 }],
    })),
  },
  computers: {
    search: vi.fn(async () => ({
      rows: [{ id: 'c1', name: 'SALES-PC01', dnsHostName: 'sales-pc01.corp.example' }],
    })),
  },
  ous: {
    list: vi.fn(async () => ({
      ous: [
        { distinguishedName: 'OU=Corp,DC=corp,DC=example', name: 'Corp', parentDn: null },
        {
          distinguishedName: 'OU=Sales,OU=Corp,DC=corp,DC=example',
          name: 'Sales',
          parentDn: 'OU=Corp,DC=corp,DC=example',
        },
        {
          distinguishedName: 'OU=Sales Team,OU=Sales\\, East,DC=corp,DC=example',
          name: 'Sales Team',
          parentDn: 'OU=Sales\\, East,DC=corp,DC=example',
        },
      ],
    })),
  },
};
vi.mock('../../api/index.js', () => ({ api }));

const { default: GlobalSearch } = await import('./GlobalSearch.vue');
const { useAuthStore } = await import('../../stores/auth.js');

async function searchFor(text: string, capabilities: string[]) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().actor = { capabilities } as never; // only capabilities matter here
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:any(.*)*', component: { render: () => h('p') } }],
  });
  await router.push('/');
  const search = mount(GlobalSearch, {
    global: { plugins: [pinia, router], stubs: { teleport: true } },
  });
  await search.find('.gs-trigger').trigger('click');
  await search.find('input').setValue(text);
  await vi.advanceTimersByTimeAsync(250);
  await flushPromises();
  return { search, router };
}

const ALL = ['read:user', 'read:group', 'read:computer'];

describe('quick search', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it('groups results by type', async () => {
    const { search } = await searchFor('sal', ALL);
    const labels = search.findAll('.gs-group-label').map((l) => l.text());
    expect(labels).toEqual(['Users', 'Groups', 'Computers', 'OUs']);
    expect(search.text()).toContain('SALES-PC01');
    // OU names match on the name, not the rest of the DN; the path under
    // each reads outermost first, with DN escapes undone.
    const ous = search.findAll('.gs-group')[3]!;
    expect(ous.findAll('.gs-row-primary').map((r) => r.text())).toEqual(['Sales', 'Sales Team']);
    expect(ous.findAll('.gs-row-secondary').map((r) => r.text())).toEqual([
      'corp.example / Corp',
      'corp.example / Sales, East',
    ]);
  });

  it('searches only what the operator can read', async () => {
    const { search } = await searchFor('sal', ['read:user']);
    expect(api.computers.search).not.toHaveBeenCalled();
    expect(api.groups.search).not.toHaveBeenCalled();
    const labels = search.findAll('.gs-group-label').map((l) => l.text());
    expect(labels).toEqual(['Users', 'OUs']);
  });

  it('leaves out OUs, like users, for operators who cannot read users', async () => {
    const { search } = await searchFor('sal', ['read:computer']);
    expect(api.users.search).not.toHaveBeenCalled();
    expect(api.ous.list).not.toHaveBeenCalled();
    const labels = search.findAll('.gs-group-label').map((l) => l.text());
    expect(labels).toEqual(['Computers']);
  });

  it('keeps the other results when one kind fails, and says which', async () => {
    api.computers.search.mockRejectedValueOnce(new Error('boom'));
    const { search } = await searchFor('sal', ALL);
    const labels = search.findAll('.gs-group-label').map((l) => l.text());
    expect(labels).toEqual(['Users', 'Groups', 'OUs']);
    expect(search.find('.gs-failed').text()).toBe("Couldn't search Computers.");
  });

  it('says the search failed rather than that nothing matched', async () => {
    api.users.search.mockRejectedValueOnce(new Error('boom'));
    api.ous.list.mockRejectedValueOnce(new Error('boom'));
    const { search } = await searchFor('sal', ['read:user']);
    expect(search.text()).toContain("Couldn't search Users or OUs.");
    expect(search.text()).not.toContain('No matches');
  });

  it('moves across groups with the arrow keys and opens the highlighted result', async () => {
    const { search, router } = await searchFor('sal', ALL);
    const input = search.find('input');
    // Two users, then the group, then the computer.
    for (let i = 0; i < 3; i++) await input.trigger('keydown', { key: 'ArrowDown' });
    expect(search.find('.gs-row.active').text()).toContain('SALES-PC01');

    await input.trigger('keydown', { key: 'ArrowUp' });
    expect(search.find('.gs-row.active').text()).toContain('Sales Team');

    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/groups/g1');
  });

  it('walks on into the OUs, stops at the last result, and opens it', async () => {
    const { search, router } = await searchFor('sal', ALL);
    const input = search.find('input');
    for (let i = 0; i < 9; i++) await input.trigger('keydown', { key: 'ArrowDown' });
    expect(search.find('.gs-row.active').text()).toContain('Sales Team');

    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/browse');
    expect(router.currentRoute.value.query.ou).toBe(
      'OU=Sales Team,OU=Sales\\, East,DC=corp,DC=example',
    );
  });

  it('fetches the OU list once per opening, however the text changes', async () => {
    const { search } = await searchFor('sal', ALL);
    const input = search.find('input');
    for (const text of ['s', 'sa', 'sales']) {
      await input.setValue(text);
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(api.ous.list).toHaveBeenCalledOnce();

    await search.find('.gs-close').trigger('click');
    await search.find('.gs-trigger').trigger('click');
    await search.find('input').setValue('sal');
    await vi.advanceTimersByTimeAsync(250);
    expect(api.ous.list).toHaveBeenCalledTimes(2);
  });

  it('drops a search that answers after the panel closed', async () => {
    let answer!: (v: unknown) => void;
    api.users.search.mockImplementationOnce(() => new Promise((r) => (answer = r)) as never);
    const { search, router } = await searchFor('sam', ['read:user']);
    await search.find('.gs-close').trigger('click');
    answer({ rows: [{ id: 'u9', displayName: 'Late Larry', samAccountName: 'll', email: null }] });
    await flushPromises();

    // Reopened and empty, Enter has nothing to open.
    await search.find('.gs-trigger').trigger('click');
    await search.find('input').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('opens the OU browser at a picked OU', async () => {
    const { search, router } = await searchFor('sal', ALL);
    const ou = search.findAll('.gs-group')[3]!.find('.gs-row');
    await ou.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/browse');
    expect(router.currentRoute.value.query.ou).toBe('OU=Sales,OU=Corp,DC=corp,DC=example');
  });
});
