// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const CORP = 'OU=Corp,DC=corp,DC=example';
const SALES = 'OU=Sales,OU=Corp,DC=corp,DC=example';
const api = {
  ous: {
    list: vi.fn(async () => ({
      ous: [
        { distinguishedName: CORP, name: 'Corp', parentDn: null, description: null, stale: false },
        {
          distinguishedName: SALES,
          name: 'Sales',
          parentDn: CORP,
          description: null,
          stale: false,
        },
      ],
    })),
    contents: vi.fn(async () => ({
      users: [],
      groups: [],
      computers: [],
      linkedGroupPolicies: [],
      inheritedGroupPolicies: [],
    })),
  },
  groups: {
    nameCheck: vi.fn(async () => ({
      nameTaken: false,
      samAccountNameTaken: false,
      nameTakenBy: null,
      samAccountNameTakenBy: null,
    })),
    create: vi.fn(async () => ({
      ok: true,
      distinguishedName: `CN=Closers,${SALES}`,
      group: { id: 'g1', name: 'Closers', samAccountName: 'Closers' },
    })),
  },
  directories: {
    naming: {
      get: vi.fn(async () => ({
        naming: { pattern: '{first}.{last}', upnSuffix: 'corp.example' },
        upnSuffixes: ['corp.example'],
      })),
      check: vi.fn(async (_id: number, body: { names: { first: string; last: string }[] }) => {
        const { resolveNames } = await import('@openaduc/shared');
        return {
          suggestions: resolveNames(
            body.names.map((name) => ({ name })),
            { pattern: '{first}.{last}', upnSuffix: 'corp.example' },
            { samAccountNames: [], userPrincipalNames: [], mailAddresses: [], cns: [] },
          ),
        };
      }),
    },
    newUsers: {
      get: vi.fn(async () => ({
        newUsers: { mailFromUpn: true, passwordMode: 'random', phoneCountry: null },
      })),
    },
    policy: vi.fn(async () => ({ policy: { minPwdLength: 7, complexityRequired: true } })),
  },
  users: {
    create: vi.fn(async () => ({
      id: 'u1',
      distinguishedName: `CN=Jane Doe,${SALES}`,
      samAccountName: 'jane.doe',
      completed: ['create', 'password', 'enable'],
      remaining: [],
      failure: null,
    })),
  },
};
vi.mock('../api/index.js', () => ({ api }));

const { default: OuBrowserView } = await import('./OuBrowserView.vue');
const { useAuthStore } = await import('../stores/auth.js');

async function openBrowser(path: string, capabilities = ['read:user']) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().actor = { directoryId: 1, capabilities, elevated: { active: true } } as never;
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/browse', name: 'ou-browser', component: OuBrowserView },
      { path: '/users/:id', name: 'user-detail', component: { template: '<div />' } },
    ],
  });
  await router.push(path);
  const page = mount(OuBrowserView, {
    global: { plugins: [pinia, router, PrimeVue, ToastService], stubs: { teleport: true } },
  });
  await flushPromises();
  return { page, router };
}

describe('the OU browser opened at an OU', () => {
  beforeEach(() => vi.clearAllMocks());

  it('selects that OU and shows its contents', async () => {
    const { page } = await openBrowser(`/browse?ou=${encodeURIComponent(SALES)}`);
    expect(api.ous.contents).toHaveBeenCalledWith(SALES);
    expect(page.find('.dn-line').text()).toBe(SALES);
  });

  it('matches the DN regardless of case', async () => {
    await openBrowser(`/browse?ou=${encodeURIComponent(SALES.toLowerCase())}`);
    expect(api.ous.contents).toHaveBeenCalledWith(SALES);
  });

  it('drops an OU that does not exist from the URL', async () => {
    const { router } = await openBrowser('/browse?ou=OU%3DGone%2CDC%3Dcorp%2CDC%3Dexample');
    expect(api.ous.contents).not.toHaveBeenCalled();
    expect(router.currentRoute.value.query.ou).toBeUndefined();
  });
});

describe('creating a group from an OU', () => {
  beforeEach(() => vi.clearAllMocks());

  it('isn’t offered without write:group.create', async () => {
    const { page } = await openBrowser(`/browse?ou=${encodeURIComponent(SALES)}`);
    expect(page.findAll('button').map((b) => b.text())).not.toContain('New group');
  });

  it('creates the group in the OU on screen, and shows it there', async () => {
    const { page } = await openBrowser(`/browse?ou=${encodeURIComponent(SALES)}`, [
      'read:user',
      'write:group.create',
    ]);
    await page
      .findAll('button')
      .find((b) => b.text() === 'New group')!
      .trigger('click');
    await flushPromises();

    await page.get('#ng-name').setValue('Closers');
    const create = () =>
      page
        .get('[role="dialog"]')
        .findAll('button')
        .find((b) => b.text() === 'Create group')!;
    await vi.waitFor(() => expect(create().attributes('disabled')).toBeUndefined());
    await create().trigger('click');
    await flushPromises();

    expect(api.groups.create).toHaveBeenCalledWith(
      expect.objectContaining({ parentDn: SALES, name: 'Closers', samAccountName: 'Closers' }),
    );
    expect(api.ous.contents).toHaveBeenLastCalledWith(SALES);
    expect(api.ous.contents).toHaveBeenCalledTimes(2);
  });
});

describe('creating a user from an OU', () => {
  beforeEach(() => vi.clearAllMocks());

  it('isn’t offered without write:user.create', async () => {
    const { page } = await openBrowser(`/browse?ou=${encodeURIComponent(SALES)}`);
    expect(page.findAll('button').map((b) => b.text())).not.toContain('New user');
  });

  it('creates the user in the OU on screen, and opens their page', async () => {
    const { page, router } = await openBrowser(`/browse?ou=${encodeURIComponent(SALES)}`, [
      'read:user',
      'write:user.create',
    ]);
    await page
      .findAll('button')
      .find((b) => b.text() === 'New user')!
      .trigger('click');
    await flushPromises();

    await page.get('#nu-first').setValue('Jane');
    await page.get('#nu-last').setValue('Doe');
    const create = () =>
      page
        .get('[role="dialog"]')
        .findAll('button')
        .find((b) => b.text() === 'Create user')!;
    await vi.waitFor(() => expect(create().attributes('disabled')).toBeUndefined(), {
      timeout: 2000,
    });
    expect((page.get('#nu-sam').element as HTMLInputElement).value).toBe('jane.doe');
    await create().trigger('click');
    await flushPromises();

    expect(api.users.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ouDn: SALES,
        samAccountName: 'jane.doe',
        userPrincipalName: 'jane.doe@corp.example',
        password: { mode: 'random' },
      }),
    );
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/users/u1'));
  });
});
