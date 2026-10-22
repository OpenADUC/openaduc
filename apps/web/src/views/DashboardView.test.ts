// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fail = () => Promise.reject(new Error('directory unavailable'));
const api = {
  users: { search: vi.fn(fail) },
  audit: { list: vi.fn(fail) },
  directories: { list: vi.fn(fail), syncTasks: { list: vi.fn() } },
};
vi.mock('../api/index.js', () => ({ api }));

const { default: DashboardView } = await import('./DashboardView.vue');
const { useAuthStore } = await import('../stores/auth.js');

async function mountDashboard() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().actor = {
    capabilities: ['read:user', 'view:audit', 'configure:directory'],
  } as never; // only capabilities matter to the dashboard
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: DashboardView }],
  });
  const page = mount(DashboardView, {
    global: { plugins: [pinia, router, PrimeVue, ToastService] },
  });
  await flushPromises();
  return page;
}

describe('dashboard panels that fail to load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('say so, with a retry, instead of looking empty or healthy', async () => {
    const page = await mountDashboard();
    const text = page.text();

    expect(text).toContain("Couldn't load accounts needing attention");
    expect(text).not.toContain('Nothing on fire');
    expect(text).toContain("Couldn't load recent activity");
    expect(text).not.toContain('No audit events yet');
    expect(text).toContain("Couldn't load directory status");
  });

  it('load again when retried', async () => {
    const page = await mountDashboard();
    api.audit.list.mockResolvedValueOnce({ rows: [], total: 0 } as never);

    // The directory pill, then issues, then recent activity.
    const retry = page
      .findAll('button')
      .filter((b) => b.text().includes('Retry'))
      .at(-1);
    await retry!.trigger('click');
    await flushPromises();

    expect(api.audit.list).toHaveBeenCalledTimes(2);
    expect(page.text()).toContain('No audit events yet');
  });
});
