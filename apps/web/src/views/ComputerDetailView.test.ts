// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import Tooltip from 'primevue/tooltip';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComputerDetail } from '@openaduc/shared';
import { ApiError } from '../api/client.js';

const WORKSTATIONS = 'OU=Workstations,DC=corp,DC=example';

const aComputer = (overrides: Partial<ComputerDetail> = {}): ComputerDetail => ({
  id: 'c1',
  name: 'WS01',
  samAccountName: 'WS01$',
  distinguishedName: `CN=WS01,${WORKSTATIONS}`,
  dnsHostName: 'ws01.corp.example',
  operatingSystem: null,
  operatingSystemVersion: null,
  enabled: true,
  lastLogonAt: null,
  modifiedAtSource: null,
  description: null,
  managedByDn: null,
  managedBy: null,
  passwordLastSetAt: null,
  createdAtSource: null,
  machineRole: null,
  siteName: null,
  operatingSystemServicePack: null,
  location: null,
  groupMemberships: [],
  freshness: { cachedAt: null, isStale: false },
  rawAttributes: null,
  ...overrides,
});

const api = {
  computers: {
    get: vi.fn(async () => ({ computer: aComputer() })),
    disable: vi.fn(async () => ({ ok: true })),
    enable: vi.fn(async () => ({ ok: true })),
    resetAccount: vi.fn(async () => ({ ok: true })),
    move: vi.fn(async () => ({ ok: true })),
  },
  ous: {
    list: vi.fn(async () => ({
      ous: [
        { distinguishedName: WORKSTATIONS, name: 'Workstations', parentDn: null, stale: false },
      ],
    })),
  },
  auth: { stepUp: vi.fn() },
};
vi.mock('../api/index.js', () => ({ api }));

const { default: ComputerDetailView } = await import('./ComputerDetailView.vue');
const { useAuthStore } = await import('../stores/auth.js');

const inFifteenMinutes = () => new Date(Date.now() + 15 * 60_000).toISOString();

async function openPage(capabilities: string[]) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().actor = {
    capabilities,
    elevated: {
      active: true,
      idleExpiresAt: inFifteenMinutes(),
      absoluteExpiresAt: inFifteenMinutes(),
    },
  } as never;
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/computers/:id',
        name: 'computer-detail',
        component: ComputerDetailView,
        props: true,
      },
    ],
  });
  await router.push('/computers/c1');
  const page = mount(RouterView, {
    global: {
      plugins: [pinia, router, PrimeVue, ToastService],
      directives: { tooltip: Tooltip },
      stubs: { teleport: true },
    },
  });
  await flushPromises();
  return page;
}

type Page = Awaited<ReturnType<typeof openPage>>;

async function click(page: Page, label: string) {
  const button = page.findAll('button').find((b) => b.text() === label);
  expect(button, label).toBeDefined();
  await button!.trigger('click');
  await flushPromises();
}

async function menuItems(page: Page) {
  await click(page, 'Actions');
  return page.findAll('[role="menuitem"]');
}

async function runAction(page: Page, label: string) {
  const item = (await menuItems(page)).find((i) => i.text() === label);
  expect(item, label).toBeDefined();
  await item!.find('a').trigger('click');
  await flushPromises();
}

const ALL = [
  'read:computer',
  'write:computer.enableDisable',
  'write:computer.resetAccount',
  'write:computer.move',
];

describe('a computer’s actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.computers.get.mockResolvedValue({ computer: aComputer() });
  });

  it('offers each action only with its capability', async () => {
    expect((await menuItems(await openPage(ALL))).map((i) => i.text())).toEqual([
      'Disable account',
      'Reset account…',
      'Move to OU…',
    ]);
    const reader = await openPage(['read:computer']);
    expect(reader.findAll('button').some((b) => b.text() === 'Actions')).toBe(false);
  });

  it('disables the computer without asking, and Undo enables it again', async () => {
    const page = await openPage(ALL);

    await runAction(page, 'Disable account');
    expect(api.computers.disable).toHaveBeenCalledWith('c1');
    expect(page.text()).toContain('Disabled WS01');

    await click(page, 'Undo');
    expect(api.computers.enable).toHaveBeenCalledWith('c1');
    expect(page.text()).toContain('Enabled WS01');
  });

  it('offers Enable on a disabled computer', async () => {
    api.computers.get.mockResolvedValue({ computer: aComputer({ enabled: false }) });
    const page = await openPage(ALL);

    await runAction(page, 'Enable account');
    expect(api.computers.enable).toHaveBeenCalledWith('c1');
  });

  it('asks before resetting the account', async () => {
    const page = await openPage(ALL);

    await runAction(page, 'Reset account…');
    expect(api.computers.resetAccount).not.toHaveBeenCalled();
    expect(page.text()).toContain('can’t sign in to the domain until it rejoins');

    await click(page, 'Reset account');
    expect(api.computers.resetAccount).toHaveBeenCalledWith('c1');
    expect(page.text()).toContain('Reset the account of WS01');
    expect(page.findAll('button').some((b) => b.text() === 'Undo')).toBe(false);
  });

  it('doesn’t reset when the question is cancelled', async () => {
    const page = await openPage(ALL);

    await runAction(page, 'Reset account…');
    await click(page, 'Cancel');
    expect(api.computers.resetAccount).not.toHaveBeenCalled();
  });

  it('keeps a failed reset under the Actions menu until retried', async () => {
    api.computers.resetAccount.mockRejectedValueOnce(
      new ApiError(403, 'forbidden', 'directory refused the reset'),
    );
    const page = await openPage(ALL);

    await runAction(page, 'Reset account…');
    await click(page, 'Reset account');
    expect(page.get('.inline-failure').text()).toContain('Couldn’t reset the account of WS01');
    expect(page.get('.inline-failure').text()).toContain('directory refused the reset');

    await click(page, 'Retry');
    expect(api.computers.resetAccount).toHaveBeenCalledTimes(2);
    expect(page.find('.inline-failure').exists()).toBe(false);
  });

  it('opens the move dialog at the computer’s current OU', async () => {
    const page = await openPage(ALL);

    await runAction(page, 'Move to OU…');
    expect(api.computers.get).toHaveBeenCalledTimes(2);
    expect(page.text()).toContain(`Currently in:${WORKSTATIONS}`);
    expect(page.text()).toContain("That's the computer's current OU");
  });
});
