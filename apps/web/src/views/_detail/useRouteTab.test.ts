// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { describe, expect, it } from 'vitest';
import { useRouteTab } from './useRouteTab.js';

type TabId = 'overview' | 'groups' | 'raw';

// A detail page reduced to its tab bar: `raw` shows only once the record
// has loaded and says the operator may see it.
const loaded = ref(false);
const rawVisible = ref(false);
let activeTab: ReturnType<typeof useRouteTab<TabId>>;
const DetailPage = defineComponent({
  setup() {
    activeTab = useRouteTab<TabId>({
      tabs: () => [
        { id: 'overview', visible: true },
        { id: 'groups', visible: true },
        { id: 'raw', visible: rawVisible.value },
      ],
      fallback: 'overview',
      ready: () => loaded.value,
    });
    return () => h('p', activeTab.value);
  },
});

async function open(path: string, opts: { loaded?: boolean; rawVisible?: boolean } = {}) {
  loaded.value = opts.loaded ?? true;
  rawVisible.value = opts.rawVisible ?? false;
  const router: Router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/users', name: 'list', component: { render: () => h('p', 'list') } },
      { path: '/users/:id', name: 'detail', component: DetailPage },
    ],
  });
  await router.push('/users');
  await router.push(path);
  const page = mount(DetailPage, { global: { plugins: [router] } });
  await flushPromises();
  return { page, router };
}

describe('a detail page tab named in the URL', () => {
  it('opens on that tab', async () => {
    const { page } = await open('/users/a?tab=groups');
    expect(page.text()).toBe('groups');
  });

  it('opens on the fallback when the URL names no tab', async () => {
    const { page } = await open('/users/a');
    expect(page.text()).toBe('overview');
  });

  it('falls back when the tab is unknown, and drops it from the URL', async () => {
    const { page, router } = await open('/users/a?tab=bogus');
    expect(page.text()).toBe('overview');
    expect(router.currentRoute.value.query.tab).toBeUndefined();
  });

  it('rejects an unknown tab without waiting for the record', async () => {
    const { page, router } = await open('/users/a?tab=bogus', { loaded: false });
    expect(page.text()).toBe('overview');
    expect(router.currentRoute.value.query.tab).toBeUndefined();
  });

  it('falls back when the operator cannot see the tab', async () => {
    const { page, router } = await open('/users/a?tab=raw', { rawVisible: false });
    expect(page.text()).toBe('overview');
    expect(router.currentRoute.value.query.tab).toBeUndefined();
  });

  it('keeps a tab that depends on the record until the record has loaded', async () => {
    const { page, router } = await open('/users/a?tab=raw', { loaded: false });
    expect(page.text()).toBe('raw');
    expect(router.currentRoute.value.query.tab).toBe('raw');

    rawVisible.value = true;
    loaded.value = true;
    await flushPromises();
    expect(page.text()).toBe('raw');
    expect(router.currentRoute.value.query.tab).toBe('raw');
  });
});

describe('switching tabs', () => {
  it('records the tab in the URL without a history entry per tab', async () => {
    const { page, router } = await open('/users/a?keep=1');
    activeTab.value = 'groups';
    await flushPromises();
    expect(page.text()).toBe('groups');
    expect(router.currentRoute.value.fullPath).toBe('/users/a?keep=1&tab=groups');

    // Back leaves the page rather than stepping through tabs.
    router.back();
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/users');
  });

  it('leaves the fallback tab out of the URL', async () => {
    const { router } = await open('/users/a?tab=groups');
    activeTab.value = 'overview';
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/users/a');
  });

  it('restores the open tab when the operator comes back', async () => {
    const { router } = await open('/users/a');
    activeTab.value = 'groups';
    await flushPromises();
    await router.push('/users');
    router.back();
    await flushPromises();
    expect(router.currentRoute.value.query.tab).toBe('groups');
  });
});

describe('leaving the page', () => {
  it("leaves the next page's tab alone", async () => {
    // Mounted outside a RouterView, the page outlives the navigation — as a
    // real page does for a moment while the route moves on.
    const { router } = await open('/users/a');
    await router.push('/users?tab=bogus');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/users?tab=bogus');
  });
});
