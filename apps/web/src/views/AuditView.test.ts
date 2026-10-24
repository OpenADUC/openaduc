// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const api = {
  audit: {
    list: vi.fn(async (query: Record<string, string | number>) =>
      query.bulkJobId
        ? { rows: [...rowEvents, heading], total: 3 }
        : { rows: [heading, anEvent({ id: '9' })], total: 2 },
    ),
  },
};
vi.mock('../api/index.js', () => ({ api }));

const { default: AuditView } = await import('./AuditView.vue');

enableAutoUnmount(afterEach);

async function openAudit() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/audit', component: AuditView }],
  });
  await router.push('/audit');
  const page = mount(RouterView, {
    attachTo: document.body,
    global: { plugins: [createPinia(), router, PrimeVue], stubs: { teleport: true } },
  });
  await flushPromises();
  return page;
}

describe('the audit log', () => {
  it('shows a bulk job as one entry that opens to list its events', async () => {
    const page = await openAudit();

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
});
