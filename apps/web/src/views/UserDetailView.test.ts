// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import Tooltip from 'primevue/tooltip';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDetail } from '@openaduc/shared';

const inFifteenMinutes = () => new Date(Date.now() + 15 * 60_000).toISOString();

const user: UserDetail = {
  id: 'u1',
  samAccountName: 'jdoe',
  userPrincipalName: 'jdoe@corp.example',
  displayName: 'Jane Doe',
  email: null,
  department: null,
  title: 'Analyst',
  enabled: true,
  locked: false,
  passwordNeverExpires: false,
  passwordExpiresAt: null,
  passwordMustChange: false,
  accountExpiresAt: null,
  lastLogonAt: null,
  modifiedAtSource: null,
  hasPhoto: false,
  givenName: null,
  surname: null,
  phone: null,
  mobile: null,
  managerDn: null,
  manager: null,
  distinguishedName: 'CN=Jane Doe,DC=corp,DC=example',
  passwordLastSetAt: null,
  lastBadPasswordAt: null,
  isPrivileged: false,
  lockedAt: null,
  autoUnlockAt: null,
  employeeID: null,
  employeeNumber: null,
  ipPhone: null,
  homePhone: null,
  homePostalAddress: null,
  description: null,
  company: null,
  c: null,
  co: null,
  l: null,
  st: null,
  postalCode: null,
  cn: null,
  physicalDeliveryOfficeName: null,
  postOfficeBox: null,
  profilePath: null,
  scriptPath: null,
  homeDirectory: null,
  pager: null,
  facsimileTelephoneNumber: null,
  info: null,
  primarySmtpAddress: null,
  otherMailbox: [],
  otherHomePhone: [],
  otherMobile: [],
  emailAliases: [],
  directReports: [],
  groupMemberships: [],
  freshness: { cachedAt: null, liveRefreshedAt: null, isStale: false },
  entra: null,
} as unknown as UserDetail;

const api = {
  users: {
    get: vi.fn(async () => ({ user })),
    activity: vi.fn(async () => ({ rows: [] })),
    update: vi.fn(async () => ({ user })),
  },
  auth: {
    stepUp: vi.fn(async () => ({
      elevated: {
        active: true,
        idleExpiresAt: inFifteenMinutes(),
        absoluteExpiresAt: inFifteenMinutes(),
      },
    })),
  },
};
vi.mock('../api/index.js', () => ({ api }));

const { default: UserDetailView } = await import('./UserDetailView.vue');
const { useAuthStore } = await import('../stores/auth.js');

async function openOrganizationTab(capabilities: string[], elevated: boolean) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.actor = {
    capabilities,
    elevated: elevated
      ? { active: true, idleExpiresAt: inFifteenMinutes(), absoluteExpiresAt: inFifteenMinutes() }
      : { active: false, idleExpiresAt: null, absoluteExpiresAt: null },
  } as never; // only these fields matter
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/users/:id', name: 'user-detail', component: UserDetailView, props: true }],
  });
  await router.push('/users/u1?tab=organization');
  const page = mount(RouterView, {
    global: { plugins: [pinia, router, PrimeVue, ToastService], directives: { tooltip: Tooltip } },
  });
  await flushPromises();
  return { page, auth };
}

const titleField = (page: Awaited<ReturnType<typeof openOrganizationTab>>['page']) =>
  page.find('input[placeholder="Title"]');

async function clickSave(page: Awaited<ReturnType<typeof openOrganizationTab>>['page']) {
  const save = page.findAll('button').find((b) => b.text() === 'Save changes');
  expect(save).toBeDefined();
  await save!.trigger('click');
  await flushPromises();
}

describe('editing a user without an elevated session', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prompts step-up on save, then saves', async () => {
    const { page, auth } = await openOrganizationTab(['read:user', 'write:user.attributes'], false);

    await titleField(page).setValue('Engineer');
    await clickSave(page);
    expect(auth.stepUpRequested).toBe(true);
    expect(api.users.update).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await flushPromises();
    expect(api.users.update).toHaveBeenCalledWith('u1', { patch: { title: 'Engineer' } });
  });

  it('shows a read-only operator no editable fields', async () => {
    const { page } = await openOrganizationTab(['read:user'], true);

    expect(titleField(page).exists()).toBe(false);
    expect(page.text()).toContain('Analyst');
  });
});

describe('unsaved edits when the elevated session ends', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  });
  afterEach(() => vi.useRealTimers());

  it('keeps the edits and saves them after the next step-up', async () => {
    const { page, auth } = await openOrganizationTab(['read:user', 'write:user.attributes'], true);
    await titleField(page).setValue('Engineer');

    vi.advanceTimersByTime(16 * 60_000);
    await flushPromises();
    expect(auth.elevated).toBe(false);
    expect((titleField(page).element as HTMLInputElement).value).toBe('Engineer');

    await clickSave(page);
    expect(auth.stepUpRequested).toBe(true);
    expect(api.users.update).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await flushPromises();
    expect(api.users.update).toHaveBeenCalledWith('u1', { patch: { title: 'Engineer' } });
  });
});
