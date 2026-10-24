// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BULK_ATTRIBUTE_FIELDS,
  type BulkUserAttributesPreview,
  type BulkGroupMembershipPreview,
  type BulkJob,
  type Capability,
  type GroupSummary,
  type UserMatchCandidate,
  type UserSummary,
} from '@openaduc/shared';

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
    previewGroupChange: vi.fn(),
    previewAttributeEdit: vi.fn(),
  },
  groups: {
    search: vi.fn(async (): Promise<{ rows: GroupSummary[]; total: number }> => ({
      rows: [],
      total: 0,
    })),
  },
  bulkJobs: {
    list: vi.fn(async (): Promise<{ jobs: BulkJob[] }> => ({ jobs: [] })),
    get: vi.fn(),
    startGroupChange: vi.fn(),
    startAttributeEdit: vi.fn(),
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

async function openUsers(
  query: string,
  capabilities: Capability[] = ['read:user', 'write:user.enableDisable'],
) {
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
    capabilities,
    elevated: {
      active: true,
      idleExpiresAt: '2999-01-01T00:15:00.000Z',
      absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
    },
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
    subject: null,
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
      partial: 0,
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

describe('the user list, adding the selection to groups', () => {
  const sales: GroupSummary = {
    id: 'g1',
    name: 'Sales',
    samAccountName: 'Sales',
    distinguishedName: 'CN=Sales,DC=corp,DC=example',
    description: null,
    groupType: 'security',
    groupScope: 'global',
    memberCount: 1,
  };

  it('picks a group, previews who it adds, and starts the job on confirming', async () => {
    api.groups.search.mockResolvedValue({ rows: [sales], total: 1 });
    const preview: BulkGroupMembershipPreview = {
      op: 'add',
      unknownCount: 0,
      previewToken: 'tok',
      groups: [
        {
          id: 'g1',
          name: 'Sales',
          distinguishedName: sales.distinguishedName,
          privilege: { reason: 'protected' },
          changes: 1,
          unchanged: { count: 1, users: [{ id: 'jdoe', name: 'Jane Doe' }] },
          indirect: { count: 0, users: [] },
        },
      ],
    };
    api.users.previewGroupChange.mockResolvedValue(preview);
    const running: BulkJob = {
      id: '8',
      action: 'user.group.add',
      subject: { groups: [{ id: 'g1', name: 'Sales', distinguishedName: 'CN=Sales' }] },
      status: 'running',
      pauseReason: null,
      actorDisplayName: 'OpenADUC Operator',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      counts: { total: 2, pending: 2, running: 0, succeeded: 0, partial: 0, failed: 0, skipped: 0 },
    };
    api.bulkJobs.startGroupChange.mockResolvedValue({ job: running });
    api.bulkJobs.get.mockResolvedValue({ job: running });
    const page = await openUsers('', ['read:user', 'write:group.membership']);
    await button(page, 'Paste a list').trigger('click');
    await page.get('#paste-list-input').setValue('jdoe\nbsmith');
    await button(page, 'Find users').trigger('click');
    await flushPromises();
    await button(page, 'Select 2 users').trigger('click');

    await button(page, 'Groups…').trigger('click');
    expect(page.text()).toContain('Add 2 accounts to groups');
    await page.get('input[aria-label="Search groups"]').setValue('sal');
    await vi.waitFor(() => expect(button(page, 'Choose')).toBeDefined());
    await button(page, 'Choose').trigger('click');
    await button(page, 'Preview').trigger('click');
    await flushPromises();

    expect(api.users.previewGroupChange).toHaveBeenCalledWith({
      op: 'add',
      ids: ['jdoe', 'bsmith'],
      groupIds: ['g1'],
    });
    const text = page.text();
    expect(text).toContain('Add 2 accounts to Sales?');
    expect(text).toContain('1 will be added · 1 is already a member');
    expect(text).toContain('Administrative group: its members get admin rights in AD.');
    expect(text).toContain('Already members (1)');
    expect(api.bulkJobs.startGroupChange).not.toHaveBeenCalled();

    expect(button(page, 'Add to group').attributes('disabled')).toBeDefined();
    await page.get('#bg-ack').setValue(true);
    await button(page, 'Add to group').trigger('click');
    await flushPromises();
    expect(api.bulkJobs.startGroupChange).toHaveBeenCalledExactlyOnceWith({
      op: 'add',
      ids: ['jdoe', 'bsmith'],
      groupIds: ['g1'],
      previewToken: 'tok',
      acknowledgeProtected: true,
    });
    expect(page.get('.bulk-job').text()).toContain('Adding 2 accounts to Sales…');
  });
});

describe('the user list, editing the selection’s attributes', () => {
  it('shows mixed values, previews each user’s change, and starts the job on confirming', async () => {
    const current = {
      ...Object.fromEntries(BULK_ATTRIBUTE_FIELDS.map((f) => [f, { kind: 'same', value: null }])),
      department: { kind: 'multiple', count: 2 },
      company: { kind: 'same', value: 'Initech' },
    } as BulkUserAttributesPreview['current'];
    const empty = {
      current,
      changed: { count: 0, offset: 0, users: [] },
      unchanged: { count: 0, users: [] },
      unread: { count: 0, users: [] },
      skipped: { count: 0, users: [] },
      fields: [],
      unknownCount: 0,
      previewToken: 'none',
    };
    api.users.previewAttributeEdit.mockResolvedValueOnce(empty).mockResolvedValueOnce({
      ...empty,
      changed: {
        count: 1,
        offset: 0,
        users: [
          {
            id: 'jdoe',
            name: 'Jane Doe',
            changes: [
              { field: 'department', before: 'Engineering', after: 'Sales' },
              { field: 'company', before: 'Initech', after: null },
            ],
          },
        ],
      },
      unchanged: { count: 1, users: [{ id: 'bsmith', name: 'Bob Smith' }] },
      fields: [
        { field: 'department', count: 1, unread: 0 },
        { field: 'company', count: 1, unread: 0 },
      ],
      previewToken: 'tok',
    });
    const running: BulkJob = {
      id: '9',
      action: 'user.update',
      subject: {
        attributes: [
          { field: 'department', value: 'Sales' },
          { field: 'company', value: null },
        ],
      },
      status: 'running',
      pauseReason: null,
      actorDisplayName: 'OpenADUC Operator',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      counts: { total: 2, pending: 2, running: 0, succeeded: 0, partial: 0, failed: 0, skipped: 0 },
    };
    api.bulkJobs.startAttributeEdit.mockResolvedValue({ job: running });
    api.bulkJobs.get.mockResolvedValue({ job: running });
    const page = await openUsers('', ['read:user', 'write:user.attributes']);
    await button(page, 'Paste a list').trigger('click');
    await page.get('#paste-list-input').setValue('jdoe\nbsmith');
    await button(page, 'Find users').trigger('click');
    await flushPromises();
    await button(page, 'Select 2 users').trigger('click');

    await button(page, 'Edit…').trigger('click');
    await flushPromises();
    expect(page.text()).toContain('Edit 2 accounts');
    const field = (label: string) =>
      page.findAll('.be-field').find((f) => f.get('.be-label').text() === label)!;
    expect(field('Department').text()).toContain('Now: (multiple values)');
    expect(field('Company').text()).toContain('Now: Initech');
    expect(field('Office').text()).toContain('Now: empty');
    expect(button(page, 'Preview').attributes('disabled')).toBeDefined();

    const mode = (label: string, choice: string) =>
      field(label)
        .findAll('button')
        .find((b) => b.text() === choice)!
        .trigger('click');
    await mode('Department', 'Set');
    await field('Department').get('input').setValue('Sales');
    await mode('Company', 'Clear');
    await button(page, 'Preview').trigger('click');
    await flushPromises();

    expect(api.users.previewAttributeEdit).toHaveBeenLastCalledWith({
      ids: ['jdoe', 'bsmith'],
      changes: { department: 'Sales', company: null },
    });
    const text = page.text();
    expect(text).toContain('Edit 2 accounts?');
    expect(text).toContain('Department: 1 user changes');
    expect(page.get('.be-user').text()).toMatch(/Jane Doe.*Department.*Engineering.*Sales/s);
    expect(page.get('.be-user').text()).toMatch(/Company.*Initech.*\(empty\)/s);
    expect(text).toContain('Already as asked, unchanged (1)');
    expect(api.bulkJobs.startAttributeEdit).not.toHaveBeenCalled();

    await button(page, 'Edit account').trigger('click');
    await flushPromises();
    expect(api.bulkJobs.startAttributeEdit).toHaveBeenCalledExactlyOnceWith({
      ids: ['jdoe', 'bsmith'],
      changes: { department: 'Sales', company: null },
      previewToken: 'tok',
    });
    expect(page.get('.bulk-job').text()).toContain('Editing 2 accounts (department and company)…');
  });
});
