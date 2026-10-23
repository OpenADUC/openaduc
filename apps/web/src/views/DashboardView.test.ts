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
import { needsAttention } from '../design/lib/attention.js';

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
const ann = aUser('u3', 'Ann Kim', { accountExpiresAt: HOUR_AGO });
const bob = aUser('u4', 'Bob Ray', { accountExpiresAt: HOUR_AGO });

// The directory as the API sees it, in the issues list's order: searches
// return who needs attention, reads return the account, and writes change it.
function directory(...users: UserDetail[]) {
  const state = new Map(users.map((u) => [u.id, u]));
  const change = (id: string, patch: Partial<UserDetail>) =>
    state.set(id, { ...state.get(id)!, ...patch });
  api.users.search.mockImplementation((async (q: { pageSize: number }) => {
    const matching = [...state.values()].filter((u) => needsAttention(u, 1));
    return { rows: matching.slice(0, q.pageSize), total: matching.length, page: 1 };
  }) as never);
  api.users.get.mockImplementation(async (id: string) => ({ user: state.get(id) }));
  api.users.unlock.mockImplementation(async (id: string) => change(id, { locked: false }));
  api.users.enable.mockImplementation(async (id: string) => change(id, { enabled: true }));
  api.users.disable.mockImplementation(async (id: string) => change(id, { enabled: false }));
  api.users.resetPassword.mockImplementation(
    async (id: string, b: { forceChangeAtNextLogin: boolean; unlock: boolean }) =>
      change(id, {
        passwordMustChange: b.forceChangeAtNextLogin,
        passwordExpiresAt: NEXT_MONTH,
        ...(b.unlock ? { locked: false } : {}),
      }),
  );
  api.users.setAccountExpiry.mockImplementation(
    async (id: string, b: { expiresAt: string | null }) =>
      change(id, { accountExpiresAt: b.expiresAt }),
  );
}

type Page = Awaited<ReturnType<typeof mountDashboard>>['page'];

const rowOf = (page: Page, name: string) => {
  const row = page.findAll('.user-list-item').find((r) => r.text().includes(name));
  expect(row, name).toBeDefined();
  return row!;
};
const names = (page: Page) =>
  page.findAll('.user-list-item').map((r) => r.find('.user-list-name').text());
const fixesOn = (page: Page, name: string) =>
  rowOf(page, name)
    .findAll('.user-list-fix')
    .map((b) => b.text());

async function click(page: Page, label: string, within: Page | DOMWrapper<Element> = page) {
  const button = within.findAll('button').find((b) => b.text() === label);
  expect(button, label).toBeDefined();
  await button!.trigger('click');
  await flushPromises();
}

async function extendToNever(page: Page, name: string) {
  await click(page, 'Extend expiry', rowOf(page, name));
  const never = page.findAll('label').find((l) => l.text() === 'Never expires')!;
  await never.get('input').setValue(true);
  await click(page, 'Save');
}

const dcDown = () => new ApiError(500, 'ldap_error', 'DC unreachable');

describe('accounts needing attention', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['a locked account', { locked: true }, 'Unlock'],
    ['an expired password', { passwordExpiresAt: HOUR_AGO }, 'Reset password'],
    ['a password that must change', { passwordMustChange: true }, 'Reset password'],
    ['an expired account', { accountExpiresAt: HOUR_AGO }, 'Extend expiry'],
  ])('offers %s the fix its user page leads with', async (_, condition, fix) => {
    directory(aUser('u1', 'Jane Doe', condition));
    const { page } = await mountDashboard(ALL_FIXES);

    expect(fixesOn(page, 'Jane Doe')).toEqual([fix]);
  });

  it('offers no fix for a password that is only expiring, as its user page doesn’t', async () => {
    directory(aUser('u1', 'Jane Doe', { passwordExpiresAt: IN_12_HOURS }));
    const { page } = await mountDashboard(ALL_FIXES);

    expect(fixesOn(page, 'Jane Doe')).toEqual([]);
  });

  it('offers no fix the operator can’t make', async () => {
    directory(jane, sam);
    const { page } = await mountDashboard(['read:user', 'write:user.resetPassword']);

    expect(fixesOn(page, 'Jane Doe')).toEqual([]);
    expect(fixesOn(page, 'Sam Lee')).toEqual(['Reset password']);
  });

  it('says what it lists, must-change passwords included', async () => {
    directory(jane, aUser('u5', 'Kim Wu', { passwordMustChange: true }));
    const { page } = await mountDashboard(ALL_FIXES);

    expect(page.text()).toContain(
      '2 total · locked, must change password, or account or password expiring within 24h',
    );
  });

  it('unlocks after the step-up its click prompts, and the fixed row leaves', async () => {
    directory(jane, sam);
    const { page, auth, router } = await mountDashboard(
      [...ALL_FIXES, 'view:audit', 'configure:directory'],
      false,
    );

    await click(page, 'Unlock', rowOf(page, 'Jane Doe'));
    expect(auth.stepUpRequested).toBe(true);
    expect(api.users.unlock).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await flushPromises();
    // The same call the user's page makes, so it's audited the same way.
    expect(api.users.unlock).toHaveBeenCalledExactlyOnceWith('u1');
    expect(api.users.get).toHaveBeenCalledExactlyOnceWith('u1');
    expect(names(page)).toEqual(['Sam Lee']);
    expect(page.text()).toContain('1 total');
    expect(page.text()).toContain('Unlocked Jane Doe');
    expect(router.currentRoute.value.path).toBe('/');
    // Only the row changed: the rest of the dashboard wasn't loaded again.
    expect(api.users.search).toHaveBeenCalledOnce();
    expect(api.audit.list).toHaveBeenCalledOnce();
    expect(api.directories.list).toHaveBeenCalledOnce();
  });

  it('updates a row in place when another condition remains, offering its fix', async () => {
    directory(aUser('u1', 'Jane Doe', { locked: true, passwordExpiresAt: HOUR_AGO }), sam);
    const { page } = await mountDashboard(ALL_FIXES);

    await click(page, 'Unlock', rowOf(page, 'Jane Doe'));
    expect(names(page)).toEqual(['Jane Doe', 'Sam Lee']);
    expect(rowOf(page, 'Jane Doe').text()).toContain('Password expired');
    expect(fixesOn(page, 'Jane Doe')).toEqual(['Reset password']);
    expect(page.text()).toContain('2 total');
  });

  it('resets a password in the reset dialog, after step-up, and the row leaves', async () => {
    directory(jane, sam);
    const { page, auth } = await mountDashboard(ALL_FIXES, false);

    await click(page, 'Reset password', rowOf(page, 'Sam Lee'));
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
    // Sam must now change the password, which the list would show; the
    // operator has dealt with it.
    expect(names(page)).toEqual(['Jane Doe']);
    expect(page.text()).toContain('1 total');
  });

  it('extends an expired account in the expiry dialog, and the row leaves', async () => {
    directory(jane, ann);
    const { page } = await mountDashboard(ALL_FIXES);

    await extendToNever(page, 'Ann Kim');
    expect(api.users.setAccountExpiry).toHaveBeenCalledExactlyOnceWith('u3', { expiresAt: null });
    expect(names(page)).toEqual(['Jane Doe']);
    expect(page.text()).toContain('Ann Kim now never expires');
  });

  it('puts a fixed row back where it was when the fix is undone', async () => {
    directory(ann, jane);
    const { page } = await mountDashboard(ALL_FIXES);

    await extendToNever(page, 'Ann Kim');
    expect(names(page)).toEqual(['Jane Doe']);

    await click(page, 'Undo');
    expect(api.users.setAccountExpiry).toHaveBeenLastCalledWith('u3', { expiresAt: HOUR_AGO });
    expect(names(page)).toEqual(['Ann Kim', 'Jane Doe']);
    expect(fixesOn(page, 'Ann Kim')).toEqual(['Extend expiry']);
  });

  it('leaves the expiry dialog open for another account when an Undo lands', async () => {
    directory(ann, bob);
    const { page } = await mountDashboard(ALL_FIXES);

    await extendToNever(page, 'Ann Kim');
    await click(page, 'Extend expiry', rowOf(page, 'Bob Ray'));
    await click(page, 'Undo');
    expect(names(page)).toEqual(['Ann Kim', 'Bob Ray']);
    expect(page.text()).toContain('Choose the last day Bob Ray can sign in');
  });

  it('fills the list from the accounts behind it as rows leave', async () => {
    const locked = Array.from({ length: 12 }, (_, i) =>
      aUser(`l${i + 1}`, `User ${String(i + 1).padStart(2, '0')}`, { locked: true }),
    );
    directory(...locked);
    const { page } = await mountDashboard(ALL_FIXES);
    expect(names(page)).toHaveLength(10);
    expect(page.text()).toContain('12 total');

    await click(page, 'Unlock', rowOf(page, 'User 01'));
    expect(names(page)).toEqual(locked.slice(1, 11).map((u) => u.displayName));
    expect(page.text()).toContain('11 total');
  });

  it('fills past a reset row the API still lists', async () => {
    const locked = Array.from({ length: 10 }, (_, i) =>
      aUser(`l${i + 1}`, `User ${String(i + 1).padStart(2, '0')}`, { locked: true }),
    );
    directory(sam, ...locked);
    const { page } = await mountDashboard(ALL_FIXES);

    await click(page, 'Reset password', rowOf(page, 'Sam Lee'));
    await page.get('#reset-new-password').setValue('N3w-passw0rd!');
    await click(page, 'Reset');
    expect(names(page)).toEqual(locked.map((u) => u.displayName));
    expect(page.text()).toContain('10 total');
  });

  it('keeps a failed fix on its row until it’s retried', async () => {
    directory(jane, sam);
    api.users.unlock.mockRejectedValueOnce(dcDown());
    const { page } = await mountDashboard(ALL_FIXES);

    await click(page, 'Unlock', rowOf(page, 'Jane Doe'));
    expect(names(page)).toEqual(['Jane Doe', 'Sam Lee']);
    expect(rowOf(page, 'Jane Doe').text()).toContain('Couldn’t unlock Jane Doe');
    expect(rowOf(page, 'Jane Doe').text()).toContain('DC unreachable');
    expect(rowOf(page, 'Sam Lee').text()).not.toContain('Couldn’t');

    await click(page, 'Retry', rowOf(page, 'Jane Doe'));
    expect(api.users.unlock).toHaveBeenCalledTimes(2);
    expect(names(page)).toEqual(['Sam Lee']);
    expect(page.text()).not.toContain('Couldn’t unlock');
  });

  it('keeps a failed fix on its row until it’s dismissed', async () => {
    directory(jane, sam);
    api.users.unlock.mockRejectedValueOnce(dcDown());
    const { page } = await mountDashboard(ALL_FIXES);

    await click(page, 'Unlock', rowOf(page, 'Jane Doe'));
    await rowOf(page, 'Jane Doe').get('.p-message-close-button').trigger('click');
    await flushPromises();
    expect(page.text()).not.toContain('Couldn’t unlock');
    expect(fixesOn(page, 'Jane Doe')).toEqual(['Unlock']);
  });

  it('keeps one row’s failure while another row is fixed', async () => {
    directory(jane, aUser('u6', 'Lee Fox', { locked: true }));
    api.users.unlock.mockRejectedValueOnce(dcDown());
    const { page } = await mountDashboard(ALL_FIXES);

    await click(page, 'Unlock', rowOf(page, 'Jane Doe'));
    await click(page, 'Unlock', rowOf(page, 'Lee Fox'));
    expect(names(page)).toEqual(['Jane Doe']);
    expect(rowOf(page, 'Jane Doe').text()).toContain('Couldn’t unlock Jane Doe');
  });

  it('keeps a row whose Undo failed, with its failure, while another row’s expiry dialog opens', async () => {
    directory(ann, bob);
    const { page } = await mountDashboard(ALL_FIXES);

    await extendToNever(page, 'Ann Kim');
    api.users.setAccountExpiry.mockRejectedValueOnce(dcDown());
    await click(page, 'Undo');
    expect(names(page)).toEqual(['Ann Kim', 'Bob Ray']);
    expect(rowOf(page, 'Ann Kim').text()).toContain(
      'Couldn’t change when Ann Kim’s account expires',
    );

    await click(page, 'Extend expiry', rowOf(page, 'Bob Ray'));
    expect(names(page)).toEqual(['Ann Kim', 'Bob Ray']);
    expect(rowOf(page, 'Ann Kim').text()).toContain(
      'Couldn’t change when Ann Kim’s account expires',
    );

    await click(page, 'Retry', rowOf(page, 'Ann Kim'));
    expect(api.users.setAccountExpiry).toHaveBeenLastCalledWith('u3', { expiresAt: HOUR_AGO });
    expect(rowOf(page, 'Ann Kim').text()).not.toContain('Couldn’t');
  });

  it('says on the row when a fixed account couldn’t be read back, and reads it again', async () => {
    directory(jane, sam);
    api.users.get.mockRejectedValueOnce(dcDown());
    const { page } = await mountDashboard(ALL_FIXES);

    await click(page, 'Unlock', rowOf(page, 'Jane Doe'));
    expect(rowOf(page, 'Jane Doe').text()).toContain('Couldn’t read Jane Doe back');

    await click(page, 'Retry', rowOf(page, 'Jane Doe'));
    expect(api.users.unlock).toHaveBeenCalledOnce();
    expect(names(page)).toEqual(['Sam Lee']);
  });

  it('still opens the user’s page from the row', async () => {
    directory(jane);
    const { page, router } = await mountDashboard(ALL_FIXES);

    await rowOf(page, 'Jane Doe').get('.user-list-row').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/users/u1');
  });
});
