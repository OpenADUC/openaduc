// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount, type DOMWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDetail } from '@openaduc/shared';
import { aUserDetail } from '../test/userDetail.js';
import { ApiError } from '../api/client.js';

const inFifteenMinutes = () => new Date(Date.now() + 15 * 60_000).toISOString();
const ELEVATED = () => ({
  active: true,
  idleExpiresAt: inFifteenMinutes(),
  absoluteExpiresAt: inFifteenMinutes(),
});
const NOT_ELEVATED = { active: false, idleExpiresAt: null, absoluteExpiresAt: null };

const fail = () => Promise.reject(new Error('directory unavailable'));
const api = {
  users: {
    search: vi.fn(fail),
    get: vi.fn(),
    unlock: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    resetPassword: vi.fn(),
    setAccountExpiry: vi.fn(),
  },
  audit: { list: vi.fn(fail) },
  directories: { list: vi.fn(fail), syncTasks: { list: vi.fn() }, policy: vi.fn(fail) },
  auth: { stepUp: vi.fn(async () => ({ elevated: ELEVATED() })) },
};
vi.mock('../api/index.js', () => ({ api }));

const { default: DashboardView } = await import('./DashboardView.vue');
const { useAuthStore } = await import('../stores/auth.js');

async function mountDashboard(
  capabilities = ['read:user', 'view:audit', 'configure:directory'],
  elevated = true,
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.actor = {
    capabilities,
    elevated: elevated ? ELEVATED() : NOT_ELEVATED,
  } as never; // only capabilities and elevation matter to the dashboard
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: DashboardView },
      { path: '/users/:id', name: 'user-detail', component: { render: () => null } },
    ],
  });
  const page = mount(DashboardView, {
    global: { plugins: [pinia, router, PrimeVue, ToastService], stubs: { teleport: true } },
  });
  await flushPromises();
  return { page, auth, router };
}

describe('dashboard panels that fail to load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.users.search.mockImplementation(fail);
  });

  it('say so, with a retry, instead of looking empty or healthy', async () => {
    const { page } = await mountDashboard();
    const text = page.text();

    expect(text).toContain("Couldn't load accounts needing attention");
    expect(text).not.toContain('Nothing on fire');
    expect(text).toContain("Couldn't load recent activity");
    expect(text).not.toContain('No audit events yet');
    expect(text).toContain("Couldn't load directory status");
  });

  it('load again when retried', async () => {
    const { page } = await mountDashboard();
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

// ---- Accounts needing attention: fixing a row in place ----------------------

const HOUR_AGO = new Date(Date.now() - 60 * 60_000).toISOString();
const IN_12_HOURS = new Date(Date.now() + 12 * 60 * 60_000).toISOString();
const NEXT_MONTH = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();

const ALL_FIXES = [
  'read:user',
  'write:user.unlock',
  'write:user.enableDisable',
  'write:user.resetPassword',
];

// A user as the issues list has them, with a password that isn't due.
const aUser = (id: string, displayName: string, overrides: Partial<UserDetail> = {}) =>
  aUserDetail({
    id,
    samAccountName: displayName.split(' ')[0]!.toLowerCase(),
    displayName,
    passwordExpiresAt: NEXT_MONTH,
    ...overrides,
  });

const jane = aUser('u1', 'Jane Doe', { locked: true });
const sam = aUser('u2', 'Sam Lee', { passwordExpiresAt: HOUR_AGO });

function listing(...rows: UserDetail[]) {
  api.users.search.mockResolvedValue({
    rows,
    total: rows.length + 5,
    page: 1,
    pageSize: 10,
  } as never);
}

// What the API reads back after a write, by user id.
function rereads(byId: Record<string, UserDetail>) {
  api.users.get.mockImplementation(async (id: string) => ({ user: byId[id] }));
}

type Page = Awaited<ReturnType<typeof mountDashboard>>['page'];

const rowOf = (page: Page, name: string) =>
  page.findAll('.user-list-item').find((r) => r.text().includes(name));
const names = (page: Page) =>
  page.findAll('.user-list-item').map((r) => r.find('.user-list-name').text());
const fixesOn = (page: Page, name: string) =>
  rowOf(page, name)!
    .findAll('.user-list-fix')
    .map((b) => b.text());

async function click(page: Page, label: string, within: Page | DOMWrapper<Element> = page) {
  const button = within.findAll('button').find((b) => b.text() === label);
  expect(button, label).toBeDefined();
  await button!.trigger('click');
  await flushPromises();
}

describe('accounts needing attention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const write of ['unlock', 'enable', 'disable', 'resetPassword', 'setAccountExpiry']) {
      api.users[write as 'unlock'].mockResolvedValue({ ok: true });
    }
  });

  it.each([
    ['a locked account', { locked: true }, 'Unlock'],
    ['an expired password', { passwordExpiresAt: HOUR_AGO }, 'Reset password'],
    ['a password that must change', { passwordMustChange: true }, 'Reset password'],
    ['an expired account', { accountExpiresAt: HOUR_AGO }, 'Extend expiry'],
    ['a disabled account', { enabled: false }, 'Enable'],
  ])('offers %s the fix its user page leads with', async (_, condition, fix) => {
    listing(aUser('u1', 'Jane Doe', condition));
    const { page } = await mountDashboard(ALL_FIXES);

    expect(fixesOn(page, 'Jane Doe')).toEqual([fix]);
  });

  it('offers no fix for a password that is only expiring, as its user page doesn’t', async () => {
    listing(aUser('u1', 'Jane Doe', { passwordExpiresAt: IN_12_HOURS }));
    const { page } = await mountDashboard(ALL_FIXES);

    expect(fixesOn(page, 'Jane Doe')).toEqual([]);
  });

  it('offers no fix the operator can’t make', async () => {
    listing(jane, sam);
    const { page } = await mountDashboard(['read:user', 'write:user.resetPassword']);

    expect(fixesOn(page, 'Jane Doe')).toEqual([]);
    expect(fixesOn(page, 'Sam Lee')).toEqual(['Reset password']);
  });

  it('unlocks after the step-up its click prompts, and the fixed row leaves', async () => {
    listing(jane, sam);
    rereads({ u1: { ...jane, locked: false } });
    const { page, auth, router } = await mountDashboard(ALL_FIXES, false);

    await click(page, 'Unlock', rowOf(page, 'Jane Doe')!);
    expect(auth.stepUpRequested).toBe(true);
    expect(api.users.unlock).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await flushPromises();
    // The same call the user's page makes, so it's audited the same way.
    expect(api.users.unlock).toHaveBeenCalledExactlyOnceWith('u1');
    expect(api.users.get).toHaveBeenCalledExactlyOnceWith('u1');
    expect(api.users.search).toHaveBeenCalledOnce();
    expect(names(page)).toEqual(['Sam Lee']);
    expect(page.text()).toContain('6 total');
    expect(page.text()).toContain('Unlocked Jane Doe');
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('updates a row in place when another condition remains, offering its fix', async () => {
    listing(aUser('u1', 'Jane Doe', { locked: true, passwordExpiresAt: HOUR_AGO }), sam);
    rereads({ u1: aUser('u1', 'Jane Doe', { passwordExpiresAt: HOUR_AGO }) });
    const { page } = await mountDashboard(ALL_FIXES);

    await click(page, 'Unlock', rowOf(page, 'Jane Doe')!);
    expect(names(page)).toEqual(['Jane Doe', 'Sam Lee']);
    expect(rowOf(page, 'Jane Doe')!.text()).toContain('Password expired');
    expect(fixesOn(page, 'Jane Doe')).toEqual(['Reset password']);
    expect(page.text()).toContain('7 total');
  });

  it('enables a disabled account the way its user page does', async () => {
    listing(aUser('u1', 'Jane Doe', { enabled: false }));
    rereads({ u1: aUser('u1', 'Jane Doe') });
    const { page } = await mountDashboard(ALL_FIXES);

    await click(page, 'Enable', rowOf(page, 'Jane Doe')!);
    expect(api.users.enable).toHaveBeenCalledExactlyOnceWith('u1');
    expect(names(page)).toEqual([]);
  });

  it('resets a password in the reset dialog, after step-up, and the row leaves', async () => {
    listing(jane, sam);
    rereads({ u2: { ...sam, passwordExpiresAt: NEXT_MONTH } });
    const { page, auth } = await mountDashboard(ALL_FIXES, false);

    await click(page, 'Reset password', rowOf(page, 'Sam Lee')!);
    expect(auth.stepUpRequested).toBe(false);
    expect(page.text()).toContain('Set a new password for Sam Lee');
    await page.get('#reset-new-password').setValue('N3w-passw0rd!');
    await click(page, 'Reset');
    expect(auth.stepUpRequested).toBe(true);
    expect(api.users.resetPassword).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await flushPromises();
    expect(api.users.resetPassword).toHaveBeenCalledExactlyOnceWith('u2', {
      newPassword: 'N3w-passw0rd!',
      forceChangeAtNextLogin: true,
      unlock: false,
    });
    expect(page.find('#reset-new-password').exists()).toBe(false);
    expect(names(page)).toEqual(['Jane Doe']);
    expect(api.users.search).toHaveBeenCalledOnce();
  });

  it('extends an expired account in the expiry dialog, and the row leaves', async () => {
    listing(jane, aUser('u3', 'Ann Kim', { accountExpiresAt: HOUR_AGO }));
    rereads({ u3: aUser('u3', 'Ann Kim') });
    const { page } = await mountDashboard(ALL_FIXES);

    await click(page, 'Extend expiry', rowOf(page, 'Ann Kim')!);
    const never = page.findAll('label').find((l) => l.text() === 'Never expires')!;
    await never.get('input').setValue(true);
    await click(page, 'Save');
    expect(api.users.setAccountExpiry).toHaveBeenCalledExactlyOnceWith('u3', { expiresAt: null });
    expect(names(page)).toEqual(['Jane Doe']);
    expect(page.text()).toContain('Ann Kim now never expires');
  });

  it('puts a fixed row back where it was when the fix is undone', async () => {
    const ann = aUser('u3', 'Ann Kim', { accountExpiresAt: HOUR_AGO });
    listing(ann, jane);
    api.users.get
      .mockResolvedValueOnce({ user: aUser('u3', 'Ann Kim') })
      .mockResolvedValueOnce({ user: ann });
    const { page } = await mountDashboard(ALL_FIXES);

    await click(page, 'Extend expiry', rowOf(page, 'Ann Kim')!);
    const never = page.findAll('label').find((l) => l.text() === 'Never expires')!;
    await never.get('input').setValue(true);
    await click(page, 'Save');
    expect(names(page)).toEqual(['Jane Doe']);

    await click(page, 'Undo');
    expect(api.users.setAccountExpiry).toHaveBeenLastCalledWith('u3', { expiresAt: HOUR_AGO });
    expect(names(page)).toEqual(['Ann Kim', 'Jane Doe']);
    expect(fixesOn(page, 'Ann Kim')).toEqual(['Extend expiry']);
  });

  it('keeps a failed fix on its row until it’s retried', async () => {
    listing(jane, sam);
    rereads({ u1: { ...jane, locked: false } });
    api.users.unlock.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));
    const { page } = await mountDashboard(ALL_FIXES);

    await click(page, 'Unlock', rowOf(page, 'Jane Doe')!);
    expect(names(page)).toEqual(['Jane Doe', 'Sam Lee']);
    expect(rowOf(page, 'Jane Doe')!.text()).toContain('Couldn’t unlock Jane Doe');
    expect(rowOf(page, 'Jane Doe')!.text()).toContain('DC unreachable');
    expect(rowOf(page, 'Sam Lee')!.text()).not.toContain('Couldn’t');

    await click(page, 'Retry', rowOf(page, 'Jane Doe')!);
    expect(api.users.unlock).toHaveBeenCalledTimes(2);
    expect(names(page)).toEqual(['Sam Lee']);
    expect(page.text()).not.toContain('Couldn’t unlock');
  });

  it('keeps a failed fix on its row until it’s dismissed', async () => {
    listing(jane, sam);
    api.users.unlock.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));
    const { page } = await mountDashboard(ALL_FIXES);

    await click(page, 'Unlock', rowOf(page, 'Jane Doe')!);
    await rowOf(page, 'Jane Doe')!.get('.p-message-close-button').trigger('click');
    await flushPromises();
    expect(page.text()).not.toContain('Couldn’t unlock');
    expect(fixesOn(page, 'Jane Doe')).toEqual(['Unlock']);
  });

  it('says on the row when a fixed account couldn’t be read back, and reads it again', async () => {
    listing(jane, sam);
    api.users.get
      .mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'))
      .mockResolvedValueOnce({ user: { ...jane, locked: false } });
    const { page } = await mountDashboard(ALL_FIXES);

    await click(page, 'Unlock', rowOf(page, 'Jane Doe')!);
    expect(rowOf(page, 'Jane Doe')!.text()).toContain('Couldn’t read Jane Doe back');

    await click(page, 'Retry', rowOf(page, 'Jane Doe')!);
    expect(api.users.unlock).toHaveBeenCalledOnce();
    expect(names(page)).toEqual(['Sam Lee']);
  });

  it('still opens the user’s page from the row', async () => {
    listing(jane);
    const { page, router } = await mountDashboard(ALL_FIXES);

    await rowOf(page, 'Jane Doe')!.get('.user-list-row').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/users/u1');
  });
});
