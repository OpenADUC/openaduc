// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClassRoster } from '@openaduc/shared';

const soon = new Date(Date.now() + 3_600_000).toISOString();
const lastSync = new Date();
lastSync.setHours(14, 32, 0, 0);
const roster: ClassRoster = {
  job: {
    id: '42',
    actorDisplayName: 'Olive Operator',
    createdAt: '2026-10-24T08:00:00Z',
    own: false,
  },
  class: {
    start: { kind: 'fixed', startsAt: soon },
    lifetimeMinutes: 240,
    isUsableOnce: false,
    updatedAt: '2026-10-24T08:00:00Z',
  },
  authoriser: { name: 'Olive Operator', own: false },
  lastSyncAt: lastSync.toISOString(),
  alerts: { unsynced: { count: 1, startsAt: soon }, stuck: [], authority: null, off: null },
  statusError: null,
  rows: [
    {
      rowId: '7',
      line: 2,
      displayName: 'Cara Cole',
      samAccountName: 'cara.cole',
      personalEmail: 'cara@example.com',
      mobile: '+44 7700 900123',
      id: 'u-cara',
      status: 'notYetValid',
      message: null,
      startsAt: soon,
      expiresAt: soon,
      held: true,
    },
    {
      rowId: '8',
      line: 3,
      displayName: 'Dev Dunn',
      samAccountName: 'dev.dunn',
      personalEmail: null,
      mobile: null,
      id: 'u-dev',
      status: 'waitingForSync',
      message: null,
      startsAt: soon,
      expiresAt: soon,
      held: false,
    },
  ],
};
const api = {
  users: {
    import: {
      classRoster: vi.fn(async () => roster),
      takeOverClass: vi.fn(async () => undefined),
      revealClassPass: vi.fn(async () => ({
        temporaryAccessPass: 'Tap-Value-7Kq2',
        startsAt: soon,
        expiresAt: soon,
        isUsableOnce: false,
      })),
    },
  },
};
vi.mock('../api/index.js', () => ({ api }));

const { default: ClassRosterView } = await import('./ClassRosterView.vue');
const { useAuthStore } = await import('../stores/auth.js');

enableAutoUnmount(afterEach);

async function openRoster() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().actor = {
    capabilities: ['read:user', 'write:user.issueTap'],
    elevated: { active: true },
  } as never;
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/users/import/jobs/:id/roster',
        name: 'user-import-roster',
        component: ClassRosterView,
        props: true,
      },
      {
        path: '/users/import/jobs/:id',
        name: 'user-import-job',
        component: { render: () => null },
      },
      { path: '/users/:id', name: 'user-detail', component: { render: () => null } },
    ],
  });
  await router.push('/users/import/jobs/42/roster');
  const page = mount(RouterView, { global: { plugins: [pinia, router, PrimeVue] } });
  await flushPromises();
  return page;
}

describe('the class roster', () => {
  it('lists each person with their pass’s status and the unsynced alert', async () => {
    const page = await openRoster();
    const text = page.text();
    expect(text).toContain('1 person isn’t in Microsoft Entra yet');
    expect(text).toContain('cara@example.com');
    expect(text).toContain('Not yet valid');
    expect(text).toMatch(/Waiting for sync, last cycle \d{1,2}:32/);
    // Not the reader's own import: its People tab isn't theirs to open.
    expect(page.findAll('a').map((a) => a.text())).not.toContain('People');
  });

  it('reveals a held pass in its row', async () => {
    const page = await openRoster();
    expect(page.find('[data-testid="class-pass"]').exists()).toBe(false);
    await page
      .findAll('button')
      .find((b) => b.text() === 'Reveal')!
      .trigger('click');
    await flushPromises();
    expect(api.users.import.revealClassPass).toHaveBeenCalledWith('42', '7');
    expect(page.find('[data-testid="class-pass"]').text()).toBe('Tap-Value-7Kq2');
  });

  it('offers to take over a class whose authoriser can no longer issue passes', async () => {
    api.users.import.classRoster.mockResolvedValueOnce({
      ...roster,
      alerts: {
        ...roster.alerts,
        authority: {
          name: 'Olive Operator',
          message:
            'Olive Operator can no longer issue passes (their account is disabled). Another operator can take over.',
        },
      },
    });
    const page = await openRoster();
    expect(page.text()).toContain('Olive Operator can no longer issue passes');
    await page
      .findAll('button')
      .find((b) => b.text() === 'Take over')!
      .trigger('click');
    await flushPromises();
    expect(api.users.import.takeOverClass).toHaveBeenCalledWith('42');
  });
});
