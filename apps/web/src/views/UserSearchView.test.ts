// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BulkJob, UserMatchCandidate, UserSummary } from '@openaduc/shared';

const summary = (id: string, displayName: string): UserSummary => ({
  id,
  samAccountName: id,
  userPrincipalName: `${id}@corp.example`,
  displayName,
  email: null,
  department: null,
  title: null,
  enabled: true,
  locked: false,
  passwordNeverExpires: false,
  passwordExpiresAt: null,
  passwordMustChange: false,
  accountExpiresAt: null,
  lastLogonAt: null,
  modifiedAtSource: null,
  hasPhoto: false,
});
const candidate = (u: UserSummary): UserMatchCandidate => ({
  id: u.id,
  samAccountName: u.samAccountName,
  userPrincipalName: u.userPrincipalName,
  displayName: u.displayName,
  email: u.email,
  department: u.department,
  title: u.title,
  enabled: u.enabled,
  distinguishedName: `CN=${u.displayName},DC=corp,DC=example`,
});
const jane = summary('jdoe', 'Jane Doe');
const bob = summary('bsmith', 'Bob Smith');
const gone = summary('gone', 'Gone Since Load');

const api = {
  users: {
    search: vi.fn(async () => ({
      rows: [jane, bob],
      total: 2,
      page: 1,
      pageSize: 50_000,
      freshness: { lastSyncedAt: null, stale: false },
    })),
    match: vi.fn(async () => ({
      results: [jane, bob, gone].map((u) => ({
        entry: u.samAccountName,
        status: 'matched' as const,
        user: candidate(u),
      })),
    })),
  },
  bulkJobs: {
    list: vi.fn(async (): Promise<{ jobs: BulkJob[] }> => ({ jobs: [] })),
    get: vi.fn(),
    rows: vi.fn(async () => ({
      rows: [
        {
          targetId: 'bsmith',
          targetName: 'Bob Smith',
          status: 'failed' as const,
          errorCode: 'permission_denied',
          errorMessage: 'The directory refused the change: insufficient access',
        },
      ],
    })),
  },
};
vi.mock('../api/index.js', () => ({ api }));

const { default: UserSearchView } = await import('./UserSearchView.vue');
const { useAuthStore } = await import('../stores/auth.js');

enableAutoUnmount(afterEach);

async function openUsers(query: string) {
  const pinia = createPinia();
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/users', component: UserSearchView },
      { path: '/:other(.*)', name: 'user-detail', component: { render: () => null } },
    ],
  });
  await router.push(`/users${query}`);
  useAuthStore(pinia).actor = {
    capabilities: ['read:user', 'write:user.enableDisable'],
  } as never;
  const page = mount(RouterView, {
    attachTo: document.body,
    global: { plugins: [pinia, router, PrimeVue, ToastService], stubs: { teleport: true } },
  });
  await flushPromises();
  return page;
}

const button = (page: Awaited<ReturnType<typeof openUsers>>, label: string) =>
  page.findAll('button').find((b) => b.text().startsWith(label))!;

describe('the user list, selecting from a pasted list', () => {
  it('selects the loaded matches, and the confirmation counts the ones filters hide', async () => {
    const page = await openUsers('?q=jane');

    await button(page, 'Paste a list').trigger('click');
    await page.get('#paste-list-input').setValue('jdoe\nbsmith\ngone');
    await button(page, 'Find users').trigger('click');
    await flushPromises();
    expect(page.text()).toContain('1 more user isn’t in the loaded list.');

    await button(page, 'Select 2 users').trigger('click');
    await flushPromises();
    expect(page.get('.bulkbar-count').text().replace(/\s+/g, ' ')).toBe(
      '2 selected · 1 hidden by filters',
    );

    await button(page, 'Disable').trigger('click');
    expect(page.text()).toContain('1 of them is hidden by the current filters.');
    expect(page.findAll('.confirm-list li').map((li) => li.text())).toEqual([
      'Jane Doe',
      'Bob Smith',
    ]);
  });

  it('drops selected users that are gone when the list reloads', async () => {
    const page = await openUsers('');
    await button(page, 'Paste a list').trigger('click');
    await page.get('#paste-list-input').setValue('jdoe\nbsmith');
    await button(page, 'Find users').trigger('click');
    await flushPromises();
    await button(page, 'Select 2 users').trigger('click');

    api.users.search.mockResolvedValueOnce({
      ...(await api.users.search()),
      rows: [jane],
      total: 1,
    });
    await button(page, 'Refresh').trigger('click');
    await flushPromises();

    expect(page.get('.bulkbar-count').text()).toBe('1 selected');
  });
});

describe('the user list, coming back to a bulk job', () => {
  const aJob = (status: BulkJob['status'], succeeded: number, failed: number): BulkJob => ({
    id: '7',
    action: 'user.disable',
    status,
    pauseReason: null,
    actorDisplayName: 'OpenADUC Operator',
    createdAt: new Date().toISOString(),
    finishedAt: status === 'finished' ? new Date().toISOString() : null,
    counts: {
      total: 2,
      pending: 2 - succeeded - failed,
      running: 0,
      succeeded,
      failed,
      skipped: 0,
    },
  });

  it('shows the progress of a job still running', async () => {
    api.bulkJobs.list.mockResolvedValueOnce({ jobs: [aJob('running', 1, 0)] });
    api.bulkJobs.get.mockResolvedValue({ job: aJob('running', 1, 0) });
    const page = await openUsers('');

    expect(page.get('.bulk-job').text()).toContain('Disabling 2 accounts…');
    expect(page.get('.bulk-job').text()).toContain('1 of 2 done.');
    expect(button(page, 'Paste a list').attributes('disabled')).toBeDefined();
  });

  it('keeps a finished job’s failed accounts selected until it’s dismissed', async () => {
    localStorage.clear();
    api.bulkJobs.list.mockResolvedValueOnce({ jobs: [aJob('finished', 1, 1)] });
    const page = await openUsers('');

    expect(page.get('.bulk-job').text()).toContain('Disabled 1 of 2 accounts');
    expect(page.get('.bulkbar-count').text()).toBe('1 selected');
    expect(api.bulkJobs.rows).toHaveBeenCalledWith('7', 'failed');

    await button(page, 'Dismiss').trigger('click');
    expect(page.find('.bulk-job').exists()).toBe(false);
    expect(page.get('.bulkbar-count').text()).toBe('1 selected');
  });
});
