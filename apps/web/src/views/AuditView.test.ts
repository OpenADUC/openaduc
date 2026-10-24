// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AuditBulkSummary,
  BulkJob,
  BulkJobRevertPreview,
  Capability,
  ElevatedSessionState,
} from '@openaduc/shared';
import type { AuditEventRow } from '../api/index.js';

const anEvent = (overrides: Partial<AuditEventRow>): AuditEventRow => ({
  id: '1',
  timestamp: '2026-10-23T10:00:00.000Z',
  actorUserId: 'op',
  actorDisplayName: 'OpenADUC Operator',
  actorAuthMethod: 'ad-password',
  sourceIp: null,
  userAgent: null,
  sessionId: null,
  correlationId: null,
  providerId: 1,
  action: 'user.unlock',
  result: 'success',
  errorCode: null,
  targetType: 'user',
  targetId: 'u1',
  targetDn: 'CN=Jane Doe,DC=corp,DC=example',
  before: null,
  after: null,
  metadata: {},
  bulkJobId: null,
  bulk: null,
  ...overrides,
});

const heading = anEvent({
  id: '10',
  action: 'bulk.create',
  targetId: null,
  targetDn: null,
  bulkJobId: '7',
  bulk: {
    action: 'user.disable',
    subject: null,
    status: 'finished',
    pauseReason: null,
    revertsJobId: null,
    revertible: false,
    revertedBy: null,
    total: 2,
    counts: { total: 2, pending: 0, running: 0, succeeded: 1, partial: 0, failed: 1, skipped: 0 },
  },
});
const rowEvents = [
  anEvent({ id: '12', action: 'user.disable', targetDn: 'CN=Bob Smith', bulkJobId: '7' }),
  anEvent({
    id: '11',
    action: 'user.disable',
    result: 'failure',
    errorCode: 'permission_denied',
    targetDn: 'CN=Guest',
    bulkJobId: '7',
  }),
];

let entries: AuditEventRow[] = [heading, anEvent({ id: '9' })];
const revertPreview: BulkJobRevertPreview = {
  revert: { count: 1, users: [{ id: 'u1', name: 'Jane Doe', changes: [] }] },
  modified: {
    count: 1,
    users: [
      {
        id: 'u2',
        name: 'Bob Smith',
        changes: [{ field: 'enabled', job: false, now: true, restore: true }],
      },
    ],
  },
  unchanged: { count: 0, users: [] },
  notRevertible: { count: 0, users: [] },
  excluded: 1,
  previewToken: 'token-1',
};
const revertJob: BulkJob = {
  id: '8',
  action: 'user.disable',
  revertsJobId: '7',
  subject: null,
  status: 'running',
  pauseReason: null,
  actorDisplayName: 'OpenADUC Operator',
  createdAt: '2026-10-24T09:00:00.000Z',
  finishedAt: null,
  counts: { total: 2, pending: 2, running: 0, succeeded: 0, partial: 0, failed: 0, skipped: 0 },
};

const api = {
  audit: {
    list: vi.fn(async (query: Record<string, string | number>) =>
      query.bulkJobId
        ? { rows: [...rowEvents, heading], total: 3 }
        : { rows: entries, total: entries.length },
    ),
  },
  bulkJobs: {
    revertPreview: vi.fn(async () => revertPreview),
    revert: vi.fn(async () => ({ job: revertJob })),
    get: vi.fn(async () => ({ job: revertJob })),
    rows: vi.fn(async () => ({ rows: [] })),
  },
};
vi.mock('../api/index.js', () => ({ api }));

const { default: AuditView } = await import('./AuditView.vue');
const { useAuthStore } = await import('../stores/auth.js');

enableAutoUnmount(afterEach);
afterEach(() => {
  vi.clearAllMocks();
  entries = [heading, anEvent({ id: '9' })];
});

const ELEVATED: ElevatedSessionState = {
  active: true,
  idleExpiresAt: '2999-01-01T00:15:00.000Z',
  absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
};

async function openAudit(
  capabilities: Capability[] = ['view:audit'],
  elevated: ElevatedSessionState = ELEVATED,
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.actor = { capabilities, elevated } as never;
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/audit', component: AuditView }],
  });
  await router.push('/audit');
  const page = mount(RouterView, {
    attachTo: document.body,
    global: { plugins: [pinia, router, PrimeVue, ToastService], stubs: { teleport: true } },
  });
  await flushPromises();
  return { page, auth };
}

const revertible = (more: Partial<AuditBulkSummary> = {}): AuditEventRow => ({
  ...heading,
  bulk: { ...heading.bulk!, revertible: true, ...more },
});
const text = (el: { text(): string }) => el.text().replace(/\s+/g, ' ');

describe('the audit log', () => {
  it('shows a bulk job as one entry that opens to list its events', async () => {
    const { page } = await openAudit();

    expect(api.audit.list).toHaveBeenCalledWith(expect.objectContaining({ groupBulk: 1 }));
    const text = page.text().replace(/\s+/g, ' ');
    expect(text).toContain('Bulk disable by OpenADUC Operator: 2 users');
    expect(text).toContain('1 succeeded · 1 failed');
    expect(page.findAll('.bulk-event')).toHaveLength(0);

    await page.get('.bulk-toggle').trigger('click');
    await flushPromises();

    expect(api.audit.list).toHaveBeenLastCalledWith({ bulkJobId: '7', page: 1, pageSize: 100 });
    const events = page.findAll('.bulk-event').map((r) => r.text().replace(/\s+/g, ' '));
    expect(events).toHaveLength(3);
    expect(events[1]).toContain('CN=Guest');
    expect(events[1]).toContain('permission_denied');
  });

  it('reverts a bulk job from its entry, confirming with the count', async () => {
    entries = [revertible()];
    const { page } = await openAudit(['view:audit', 'write:user.enableDisable']);

    await page.get('.bulk-revert').trigger('click');
    await flushPromises();

    expect(api.bulkJobs.revertPreview).toHaveBeenCalledWith('7');
    // Opening the dialog doesn't open the job's events too.
    expect(page.findAll('.bulk-event')).toHaveLength(0);
    const dialog = text(page.get('.p-dialog'));
    expect(dialog).toContain('Bulk disable by OpenADUC Operator: 2 users');
    expect(dialog).toContain('Puts back what the job changed for 1 account.');
    expect(dialog).toContain('Changed again since the job (1)');
    expect(dialog).toContain('Account: now Enabled (the job set Disabled); reverting sets Enabled');
    expect(dialog).toContain('1 row of the job failed or needed no change');
    const confirm = () => page.findAll('.p-dialog button').find((b) => /Revert \d/.test(b.text()))!;
    expect(confirm().text()).toBe('Revert 1 account');

    // Bob was changed since: left alone unless ticked.
    await page.get('.br-modified .br-user input').setValue(true);
    expect(confirm().text()).toBe('Revert 2 accounts');
    await confirm().trigger('click');
    await flushPromises();

    expect(api.bulkJobs.revert).toHaveBeenCalledExactlyOnceWith('7', {
      previewToken: 'token-1',
      include: ['u2'],
    });
    expect(page.find('.p-dialog').exists()).toBe(false);
    expect(text(page.get('.bulk-job'))).toContain('Reverting 2 accounts…');
  });

  it('can revert every user changed since the job at once', async () => {
    entries = [revertible()];
    const { page } = await openAudit(['view:audit', 'write:user.enableDisable']);
    await page.get('.bulk-revert').trigger('click');
    await flushPromises();

    await page.get('.br-modified > .br-choice input').setValue(true);
    await page
      .findAll('.p-dialog button')
      .find((b) => b.text() === 'Revert 2 accounts')!
      .trigger('click');
    await flushPromises();

    expect(api.bulkJobs.revert).toHaveBeenCalledWith('7', {
      previewToken: 'token-1',
      include: 'all',
    });
  });

  it('asks for step-up before starting the revert', async () => {
    entries = [revertible()];
    const { page, auth } = await openAudit(['view:audit', 'write:user.enableDisable'], {
      active: false,
      idleExpiresAt: null,
      absoluteExpiresAt: null,
    });
    await page.get('.bulk-revert').trigger('click');
    await flushPromises();

    await page
      .findAll('.p-dialog button')
      .find((b) => b.text() === 'Revert 1 account')!
      .trigger('click');
    await flushPromises();

    expect(auth.stepUpRequested).toBe(true);
    expect(api.bulkJobs.revert).not.toHaveBeenCalled();
  });

  it('offers no revert to an auditor, and says who reverted a job and when', async () => {
    entries = [
      revertible({
        revertible: false,
        revertedBy: {
          jobId: '8',
          actorDisplayName: 'Sam Lee',
          createdAt: '2026-10-24T09:00:00.000Z',
          status: 'finished',
        },
      }),
      revertible({ revertsJobId: '6' }),
    ];
    const { page } = await openAudit(['view:audit']);

    expect(page.find('.bulk-revert').exists()).toBe(false);
    const rows = page.findAll('.bulk-cell').map(text);
    expect(rows[0]).toMatch(/Reverted by Sam Lee on /);
    expect(rows[1]).toContain('Revert of bulk disable by OpenADUC Operator: 2 users');
  });
});
