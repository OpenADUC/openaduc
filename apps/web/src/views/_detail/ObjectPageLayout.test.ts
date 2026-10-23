// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { defineComponent, h, ref, type Component } from 'vue';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObjectAction, ObjectPageSkeleton, ObjectPageTab } from './objectPage.js';
import type { ActionFailure } from '../../design/lib/actionFailure.js';

vi.mock('../../api/index.js', () => ({ api: {} }));

// Generic components don't fit h()'s overloads.
const ObjectPageLayout = (await import('./ObjectPageLayout.vue')).default as Component;
const { useAuthStore } = await import('../../stores/auth.js');
const { onShortcutKey, shortcuts } = await import('../../design/composables/useShortcuts.js');

enableAutoUnmount(afterEach);

type TabId = 'overview' | 'members' | 'raw';

const refreshing = ref(false);
const loading = ref(false);
let skeleton: ObjectPageSkeleton | undefined;
const actionFailure = ref<ActionFailure | null>(null);
const onRefresh = vi.fn();
let tabs: ObjectPageTab<TabId>[] = [];
let actions: ObjectAction[] = [];
let freshness: { cachedAt: string | null; liveRefreshedAt?: string | null } = { cachedAt: null };

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
          ...freshness,
          tabs,
          fallbackTab: 'overview',
          actions,
          refreshing: refreshing.value,
          loading: loading.value,
          skeleton,
          actionFailure: actionFailure.value,
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
  opts: {
    capabilities?: string[];
    tabs?: ObjectPageTab<TabId>[];
    actions?: ObjectAction[];
    freshness?: typeof freshness;
    loading?: boolean;
    skeleton?: ObjectPageSkeleton;
  } = {},
) {
  tabs = opts.tabs ?? [
    { id: 'overview', label: 'Overview', icon: 'pi-th-large', visible: true },
    { id: 'members', label: 'Members', icon: 'pi-users', count: 3, visible: true },
    { id: 'raw', label: 'Debug', icon: 'pi-code', visible: false },
  ];
  actions = opts.actions ?? [];
  freshness = opts.freshness ?? { cachedAt: null };
  refreshing.value = false;
  loading.value = opts.loading ?? false;
  skeleton = opts.skeleton;
  actionFailure.value = null;
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
    icon: 'pi-trash',
    capability: 'write:group.membership',
    danger: true,
    run,
  };
  const rename: ObjectAction = {
    label: 'Rename…',
    icon: 'pi-id-card',
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
      actions: [{ ...remove, unavailable: 'not for this group' }, rename],
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

describe('object page shortcuts', () => {
  const unlock = vi.fn();
  const enable = vi.fn();
  const disable = vi.fn();
  const actions: ObjectAction[] = [
    {
      label: 'Unlock account',
      icon: 'pi-unlock',
      capability: 'write:user.unlock',
      shortcut: 'u',
      unavailable: 'account isn’t locked',
      run: unlock,
    },
    {
      label: 'Enable account',
      icon: 'pi-check',
      capability: 'write:user.enableDisable',
      shortcut: 'e',
      unavailable: 'account is already enabled',
      run: enable,
    },
    {
      label: 'Disable account',
      icon: 'pi-ban',
      capability: 'write:user.enableDisable',
      shortcut: 'e',
      run: disable,
    },
    { label: 'Rename…', icon: 'pi-id-card', capability: 'write:user.rename', run: vi.fn() },
  ];
  const everything = ['write:user.unlock', 'write:user.enableDisable', 'write:user.rename'];

  beforeAll(() => window.addEventListener('keydown', onShortcutKey));
  afterAll(() => window.removeEventListener('keydown', onShortcutKey));
  beforeEach(() => vi.clearAllMocks());

  const press = async (key: string) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
    await flushPromises();
  };
  const listed = () =>
    shortcuts.value.map((s) => [s.section, s.key, s.label, s.unavailable ?? null]);

  it('switches to the nth visible tab on its number', async () => {
    const { page, router } = await open('/groups/g1');
    await press('2');
    expect(page.find('.body').text()).toContain('showing members');
    expect(router.currentRoute.value.query['tab']).toBe('members');
    await press('3');
    expect(page.find('.body').text()).toContain('showing members');
    await press('1');
    expect(page.find('.body').text()).toContain('showing overview');
  });

  it('runs an action on its key, as the Actions menu would', async () => {
    await open('/groups/g1', { capabilities: everything, actions });
    await press('e');
    expect(disable).toHaveBeenCalledOnce();
    expect(enable).not.toHaveBeenCalled();
  });

  it('lists the actions and tabs, saying why an action can’t run', async () => {
    await open('/groups/g1', { capabilities: everything, actions });
    expect(listed()).toEqual([
      ['Actions', 'u', 'Unlock account', 'account isn’t locked'],
      ['Actions', 'e', 'Disable account', null],
      ['Tabs', '1', 'Overview', null],
      ['Tabs', '2', 'Members', null],
    ]);
    await press('u');
    expect(unlock).not.toHaveBeenCalled();
  });

  it('offers no shortcut for an action the operator lacks the capability for', async () => {
    await open('/groups/g1', { capabilities: ['write:user.unlock'], actions });
    expect(listed().filter(([section]) => section === 'Actions')).toEqual([
      ['Actions', 'u', 'Unlock account', 'account isn’t locked'],
    ]);
    await press('e');
    expect(disable).not.toHaveBeenCalled();
  });

  it('holds an action’s shortcut while another action runs', async () => {
    const busy = actions.map((a) => ({ ...a, disabled: true }));
    await open('/groups/g1', { capabilities: everything, actions: busy });
    await press('e');
    expect(disable).not.toHaveBeenCalled();
    expect(listed()).toContainEqual([
      'Actions',
      'e',
      'Disable account',
      'another action is running',
    ]);
  });

  it('holds an action’s shortcut while the record loads', async () => {
    await open('/groups/g1', { capabilities: everything, actions, loading: true });
    await press('e');
    expect(disable).not.toHaveBeenCalled();
    expect(listed()).toContainEqual([
      'Actions',
      'e',
      'Disable account',
      'the group is still loading',
    ]);
  });
});

describe('a failed action', () => {
  it('shows under the Actions menu, with Retry and dismiss', async () => {
    const { page } = await open('/groups/g1');
    const retry = vi.fn();
    const dismiss = vi.fn();
    actionFailure.value = { summary: 'Disable failed', message: 'DC unreachable', retry, dismiss };
    await flushPromises();
    const alert = page.get('.inline-failure');
    expect(alert.text()).toContain('Disable failed');
    expect(alert.text()).toContain('DC unreachable');

    await alert
      .findAll('button')
      .find((b) => b.text() === 'Retry')!
      .trigger('click');
    expect(retry).toHaveBeenCalledOnce();
    await alert.find('button[aria-label="Close"]').trigger('click');
    expect(dismiss).toHaveBeenCalledOnce();
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

describe('the freshness line', () => {
  const hourAgo = () => new Date(Date.now() - 60 * 60_000).toISOString();

  it('says when the record was last read live and cached', async () => {
    const { page } = await open('/groups/g1', {
      freshness: { cachedAt: hourAgo(), liveRefreshedAt: new Date().toISOString() },
    });
    expect(page.find('.freshness-foot').text()).toBe(
      'Live refreshed just now · Cache written 1h ago',
    );
  });

  it('only says when it was cached for a record never read live', async () => {
    const { page } = await open('/groups/g1', { freshness: { cachedAt: hourAgo() } });
    expect(page.find('.freshness-foot').text()).toBe('Cache written 1h ago');
  });
});

describe('while the record loads', () => {
  it('shows the tabs, with a skeleton header and cards in place of the page', async () => {
    const { page } = await open('/groups/g1', { loading: true });
    expect(page.get('[role="status"]').text()).toBe('Loading group…');
    expect(page.find('.detail-hero h1').exists()).toBe(false);
    expect(page.find('.detail-hero .p-skeleton').exists()).toBe(true);
    expect(tabLabels(page)).toEqual(['Overview', 'Members']);
    expect(page.find('.body').exists()).toBe(false);
    expect(page.findAll('.object-skeleton-card')).toHaveLength(2);
    expect(page.find('.freshness-foot').exists()).toBe(false);
  });

  it('says it is loading outside the busy region, then stops saying so', async () => {
    const { page } = await open('/groups/g1', { loading: true });
    const status = page.get('[role="status"]');
    expect(status.element.closest('[aria-busy]')).toBeNull();
    expect(page.get('.detail-stack').attributes('aria-busy')).toBe('true');

    loading.value = false;
    await flushPromises();
    expect(page.get('[role="status"]').element).toBe(status.element);
    expect(status.text()).toBe('');
    expect(page.get('.detail-stack').attributes('aria-busy')).toBeUndefined();
  });

  it('keeps the lines it held when the record has nothing for them', async () => {
    const { page } = await open('/groups/g1', { loading: true, skeleton: { subtitle: true } });
    loading.value = false;
    await flushPromises();
    expect(page.get('.detail-hero-title').text()).toBe('');
    expect(page.get('.detail-hero-upn').text()).toBe('');
  });

  it('fills the same header and tab bar once the record is there', async () => {
    const { page } = await open('/groups/g1', { loading: true });
    const hero = page.get('.detail-hero').element;
    const tabBar = page.get('.object-tabs').element;

    loading.value = false;
    await flushPromises();
    expect(page.get('.detail-hero').element).toBe(hero);
    expect(page.get('.object-tabs').element).toBe(tabBar);
    expect(page.get('.detail-hero h1').text()).toBe('Finance');
    expect(page.find('.detail-hero .p-skeleton').exists()).toBe(false);
    expect(page.find('.object-skeleton-card').exists()).toBe(false);
    expect(page.get('.body').text()).toContain('showing overview');
  });

  it('keeps the tab counts’ room without showing a count', async () => {
    const { page } = await open('/groups/g1', { loading: true });
    const count = page.get('[aria-label="Members"] .ds-tab-count');
    expect(count.text()).toBe('');
    expect(count.find('.p-skeleton').exists()).toBe(true);
  });

  it('holds a disabled Actions button for an operator who could act', async () => {
    const remove: ObjectAction = {
      label: 'Remove…',
      icon: 'pi-trash',
      capability: 'write:group.membership',
      unavailable: 'the group isn’t loaded',
      run: vi.fn(),
    };
    const { page } = await open('/groups/g1', {
      loading: true,
      capabilities: ['write:group.membership'],
      actions: [remove],
    });
    expect(actionsButton(page)!.attributes('disabled')).toBeDefined();
    expect(
      page.find('button[title="Refresh from directory"]').attributes('disabled'),
    ).toBeDefined();
  });

  it('reserves the header lines and cards the page says it usually has', async () => {
    const plain = (await open('/groups/g1', { loading: true })).page;
    expect(plain.find('.detail-hero-status').exists()).toBe(false);
    expect(plain.find('.detail-hero-title').exists()).toBe(false);

    const { page } = await open('/groups/g1', {
      loading: true,
      skeleton: { status: true, subtitle: true, cards: 1 },
    });
    expect(page.find('.detail-hero-status .p-skeleton').exists()).toBe(true);
    expect(page.find('.detail-hero-title .p-skeleton').exists()).toBe(true);
    expect(page.findAll('.object-skeleton-card')).toHaveLength(1);
  });
});
