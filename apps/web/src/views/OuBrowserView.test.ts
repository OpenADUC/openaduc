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
};
vi.mock('../api/index.js', () => ({ api }));

const { default: OuBrowserView } = await import('./OuBrowserView.vue');
const { useAuthStore } = await import('../stores/auth.js');

async function openBrowser(path: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().actor = { capabilities: ['read:user'] } as never; // only capabilities matter
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/browse', name: 'ou-browser', component: OuBrowserView }],
  });
  await router.push(path);
  const page = mount(OuBrowserView, {
    global: { plugins: [pinia, router, PrimeVue, ToastService] },
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
