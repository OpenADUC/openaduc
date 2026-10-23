// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { defineComponent, h, ref, type Component } from 'vue';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObjectAction, ObjectPageTab } from './objectPage.js';

vi.mock('../../api/index.js', () => ({ api: {} }));

// Generic components don't fit h()'s overloads.
const ObjectPageLayout = (await import('./ObjectPageLayout.vue')).default as Component;
const { useAuthStore } = await import('../../stores/auth.js');

enableAutoUnmount(afterEach);

type TabId = 'overview' | 'members' | 'raw';

const refreshing = ref(false);
const onRefresh = vi.fn();
let tabs: ObjectPageTab<TabId>[] = [];
let actions: ObjectAction[] = [];

// A group page reduced to the layout: each tab's body names the tab.
const GroupPage = defineComponent({
  setup() {
    return () =>
      h(
        ObjectPageLayout,
        {
          kind: 'group',
          name: 'Finance',
          avatar: { name: 'Finance', seed: 'finance', shape: 'rounded' },
          dn: 'CN=Finance,OU=Groups,DC=corp,DC=example',
          freshness: { cachedAt: null },
          tabs,
          fallbackTab: 'overview',
          actions,
          refreshing: refreshing.value,
          onRefresh,
        },
        {
          default: ({ tab, select }: { tab: TabId; select: (id: TabId) => void }) =>
            h('div', { class: 'body' }, [
              h('p', `showing ${tab}`),
              h('button', { class: 'see-members', onClick: () => select('members') }, 'See all'),
            ]),
        },
      );
  },
});

async function open(
  path: string,
  opts: { capabilities?: string[]; tabs?: ObjectPageTab<TabId>[]; actions?: ObjectAction[] } = {},
) {
  tabs = opts.tabs ?? [
    { id: 'overview', label: 'Overview', icon: 'pi-th-large', visible: true },
    { id: 'members', label: 'Members', icon: 'pi-users', count: 3, visible: true },
    { id: 'raw', label: 'Debug', icon: 'pi-code', visible: false },
  ];
  actions = opts.actions ?? [];
  refreshing.value = false;
  onRefresh.mockClear();
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().actor = { capabilities: opts.capabilities ?? [] } as never; // only this matters
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/groups/:id', name: 'group-detail', component: GroupPage }],
  });
  await router.push(path);
  const page = mount(RouterView, {
    attachTo: document.body,
    global: { plugins: [pinia, router, PrimeVue, ToastService], stubs: { teleport: true } },
  });
  await flushPromises();
  return { page, router };
}

type Page = Awaited<ReturnType<typeof open>>['page'];

const tabLabels = (page: Page) =>
  page.findAll('[role="tab"]').map((t) => t.attributes('aria-label'));
const actionsButton = (page: Page) => page.findAll('button').find((b) => b.text() === 'Actions');

async function openActionsMenu(page: Page) {
  await actionsButton(page)!.trigger('click');
  await flushPromises();
  return page.findAll('[role="menuitem"]');
}

describe('object page tabs', () => {
  it('opens the tab the URL names', async () => {
    const { page } = await open('/groups/g1?tab=members');
    expect(page.find('.body').text()).toContain('showing members');
    expect(page.find('[aria-selected="true"]').attributes('aria-label')).toBe('Members');
  });

  it('shows only the visible tabs, with their counts', async () => {
    const { page } = await open('/groups/g1');
    expect(tabLabels(page)).toEqual(['Overview', 'Members']);
    expect(page.find('[aria-label="Members"]').text()).toContain('3');
  });

  it('switches tab on click and keeps it in the URL', async () => {
    const { page, router } = await open('/groups/g1');
    expect(page.find('.body').text()).toContain('showing overview');

    await page.find('[aria-label="Members"]').trigger('click');
    await flushPromises();
    expect(page.find('.body').text()).toContain('showing members');
    expect(router.currentRoute.value.query.tab).toBe('members');
  });

  it('lets the page body switch tab', async () => {
    const { page, router } = await open('/groups/g1');
    await page.find('.see-members').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.tab).toBe('members');
  });

  it('falls back from a tab the operator cannot see', async () => {
    const { page, router } = await open('/groups/g1?tab=raw');
    expect(page.find('.body').text()).toContain('showing overview');
    expect(router.currentRoute.value.query.tab).toBeUndefined();
  });
});

describe('the actions menu', () => {
  const run = vi.fn();
  const remove: ObjectAction = {
    label: 'Remove…',
    icon: 'pi pi-trash',
    capability: 'write:group.membership',
    danger: true,
    run,
  };
  const rename: ObjectAction = {
    label: 'Rename…',
    icon: 'pi pi-id-card',
    capability: 'write:user.rename',
    run,
  };

  it('offers only the actions the operator has the capability for', async () => {
    const { page } = await open('/groups/g1', {
      capabilities: ['write:group.membership'],
      actions: [remove, rename],
    });
    const items = await openActionsMenu(page);
    expect(items.map((i) => i.text())).toEqual(['Remove…']);
  });

  it('leaves out actions that do not apply to this object', async () => {
    const { page } = await open('/groups/g1', {
      capabilities: ['write:group.membership', 'write:user.rename'],
      actions: [{ ...remove, available: false }, rename],
    });
    const items = await openActionsMenu(page);
    expect(items.map((i) => i.text())).toEqual(['Rename…']);
  });

  it('has no Actions button when nothing is on offer', async () => {
    const { page } = await open('/groups/g1', { capabilities: [], actions: [remove, rename] });
    expect(actionsButton(page)).toBeUndefined();
  });

  it('runs the chosen action', async () => {
    run.mockClear();
    const { page } = await open('/groups/g1', {
      capabilities: ['write:group.membership'],
      actions: [remove],
    });
    const [item] = await openActionsMenu(page);
    await item!.find('a').trigger('click');
    expect(run).toHaveBeenCalledOnce();
  });

  it("shows a disabled action that can't be run", async () => {
    run.mockClear();
    const { page } = await open('/groups/g1', {
      capabilities: ['write:group.membership'],
      actions: [{ ...remove, disabled: true }],
    });
    const [item] = await openActionsMenu(page);
    expect(item!.attributes('aria-disabled')).toBe('true');
    await item!.find('a').trigger('click');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('refreshing', () => {
  it('asks the page to refresh', async () => {
    const { page } = await open('/groups/g1');
    await page.find('button[title="Refresh from directory"]').trigger('click');
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('shows that a refresh is running', async () => {
    const { page } = await open('/groups/g1');
    refreshing.value = true;
    await flushPromises();
    const button = page.find('button[title="Refresh from directory"]');
    expect(button.attributes('disabled')).toBeDefined();
  });
});
