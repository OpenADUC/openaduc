// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserLicenses } from '@openaduc/shared';

const licenses = vi.fn<(id: string) => Promise<UserLicenses>>();
vi.mock('../../api/index.js', () => ({ api: { users: { licenses } } }));

const { default: UserLicenseList } = await import('./UserLicenseList.vue');

const assignment = { state: 'active' as const, error: null, disabledPlans: 0, lastUpdatedAt: null };

async function show(answer: UserLicenses) {
  licenses.mockResolvedValue(answer);
  const page = mount(UserLicenseList, {
    props: { userId: 'u1', name: 'Alice Anders' },
    global: { plugins: [PrimeVue], stubs: { RouterLink: RouterLinkStub } },
  });
  await flushPromises();
  return page;
}

beforeEach(() => setActivePinia(createPinia()));

describe('UserLicenseList', () => {
  it('names each license, links the AD group it comes from, and says why Entra couldn’t assign one', async () => {
    const page = await show({
      status: 'synced',
      licenses: [
        {
          skuId: 'e3',
          skuPartNumber: 'SPE_E3',
          name: 'Microsoft 365 E3',
          assignments: [
            { ...assignment, group: null, disabledPlans: 2 },
            {
              ...assignment,
              group: { entraGroupId: 'entra-eng', name: 'Engineering', groupId: 'g-eng' },
            },
          ],
        },
        {
          skuId: 'visio',
          skuPartNumber: 'VISIOCLIENT',
          name: 'Visio Plan 2',
          assignments: [
            {
              ...assignment,
              state: 'error',
              error: 'CountViolation',
              group: { entraGroupId: 'entra-cloud', name: 'Cloud Licensing', groupId: null },
            },
          ],
        },
      ],
    });
    const items = page.findAll('.lic-item');
    expect(items[0]!.text()).toContain('Microsoft 365 E3');
    expect(items[0]!.text()).toContain('SPE_E3');
    expect(items[0]!.text()).toContain('Assigned directly');
    expect(items[0]!.text()).toContain('2 service plans turned off');
    const link = items[0]!.findComponent(RouterLinkStub);
    expect(link.text()).toBe('Engineering');
    expect(link.props('to')).toEqual({ name: 'group-detail', params: { id: 'g-eng' } });

    expect(items[1]!.text()).toContain('Cloud Licensing (Entra)');
    expect(items[1]!.findComponent(RouterLinkStub).exists()).toBe(false);
    expect(items[1]!.find('.lic-error').text()).toContain('Not enough licenses');
  });

  it('says a user who isn’t in Entra yet is waiting for sync', async () => {
    const page = await show({ status: 'unsynced', lastSyncAt: '2026-10-24T11:30:00.000Z' });
    expect(page.text()).toContain('Alice Anders isn’t in Microsoft Entra yet');
    expect(page.text()).toContain('The tenant last synced');
  });

  it('says when the user has none', async () => {
    const page = await show({ status: 'synced', licenses: [] });
    expect(page.text()).toContain('Alice Anders has no licenses');
  });
});
