// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportJobResponse, ImportJobRow } from '@openaduc/shared';

const E3 = { skuId: 'e3', skuPartNumber: 'SPE_E3', name: 'Microsoft 365 E3', group: 'All Staff' };
const person = (over: Partial<ImportJobRow>): ImportJobRow => ({
  line: 2,
  displayName: 'Lia Lane',
  samAccountName: 'lia.lane',
  userPrincipalName: 'lia.lane@corp.test',
  status: 'succeeded',
  id: 'u-lia',
  completed: ['create', 'password', 'enable', 'groups', 'manager'],
  failed: [],
  errorMessage: null,
  needsPasswordReset: false,
  licenses: null,
  ...over,
});
const view: ImportJobResponse = {
  job: {
    id: '42',
    action: 'user.create',
    subject: { import: { passwordMode: 'random', mustChange: false, enabled: true } },
    status: 'finished',
    pauseReason: null,
    revertsJobId: null,
    revertible: false,
    revertedBy: null,
    actorDisplayName: 'Olive Operator',
    createdAt: '2026-10-24T09:00:00.000Z',
    finishedAt: '2026-10-24T09:01:00.000Z',
    counts: {
      total: 3,
      pending: 0,
      running: 0,
      succeeded: 3,
      partial: 0,
      failed: 0,
      skipped: 0,
    },
  },
  rows: [
    person({
      licenses: {
        status: 'settled',
        message: null,
        licenses: [{ ...E3, state: 'error', error: 'CountViolation' }],
        checkedAt: '2026-10-24T09:20:00.000Z',
      },
    }),
    person({
      line: 3,
      displayName: 'Max Mohr',
      samAccountName: 'max.mohr',
      id: 'u-max',
      licenses: {
        status: 'waiting',
        message: 'Waiting for Connect Sync to bring them to Microsoft Entra.',
        licenses: [{ ...E3, state: 'pending', error: null }],
        checkedAt: null,
      },
    }),
    person({ line: 4, displayName: 'Quin Quay', samAccountName: 'quin.quay', id: 'u-quin' }),
  ],
  results: { passwords: 'none', downloadedAt: null, expiresAt: null },
  passwordReset: null,
  classTap: null,
};
const api = { users: { import: { job: vi.fn(async () => view) } } };
vi.mock('../api/index.js', () => ({ api }));

const { default: ImportJobView } = await import('./ImportJobView.vue');
const { useAuthStore } = await import('../stores/auth.js');

enableAutoUnmount(afterEach);

async function openJob() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().actor = { capabilities: ['write:user.create'], elevated: null } as never;
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/users/import/jobs/:id', component: ImportJobView, props: true },
      { path: '/users/import', name: 'user-import', component: { render: () => null } },
      { path: '/users/:id', name: 'user-detail', component: { render: () => null } },
    ],
  });
  await router.push('/users/import/jobs/42');
  const page = mount(RouterView, { global: { plugins: [pinia, router, PrimeVue] } });
  await flushPromises();
  return page;
}

describe('an import’s page', () => {
  it('shows each person’s licenses as Entra has them, with why one wasn’t assigned', async () => {
    const page = await openJob();
    const cells = page.findAll('tbody tr').map((tr) => tr.findAll('td').at(-1)!.text());
    expect(page.findAll('th').map((th) => th.text())).toContain('Licenses');
    expect(cells[0]).toContain('Microsoft 365 E3');
    expect(cells[0]).toContain('Not assigned');
    expect(cells[0]).toContain('From All Staff');
    expect(cells[0]).toContain('Not enough licenses');
    expect(cells[1]).toContain('Waiting');
    expect(cells[1]).toContain('Waiting for Connect Sync to bring them to Microsoft Entra.');
    expect(cells[2]).toBe('');
    expect(page.text()).toContain('again every half minute');
  });
});
