// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LicensedGroups } from '@openaduc/shared';

const licensed = vi.fn<() => Promise<LicensedGroups>>();
vi.mock('../../api/index.js', () => ({ api: { groups: { licensed } } }));

const { default: LicenseBadge } = await import('./LicenseBadge.vue');
const { useAuthStore } = await import('../../stores/auth.js');
const { useLicensedGroupsStore } = await import('../../stores/licensedGroups.js');

const e3 = { skuId: 'e3', skuPartNumber: 'SPE_E3', name: 'Microsoft 365 E3' };
const visio = { skuId: 'visio', skuPartNumber: 'VISIOCLIENT', name: 'Visio Plan 2' };

beforeEach(() => {
  setActivePinia(createPinia());
  useAuthStore().actor = { directoryId: 1, capabilities: ['read:group'] } as never;
  licensed.mockReset().mockResolvedValue({
    enabled: true,
    refreshedAt: '2026-10-24T11:00:00Z',
    groups: [
      { id: 'g-eng', licenses: [e3] },
      { id: 'g-design', licenses: [visio, e3] },
    ],
  });
});

const badges = async (ids: string[]) => {
  const pages = ids.map((id) => mount(LicenseBadge, { props: { groupId: id } }));
  await flushPromises();
  return pages;
};

describe('LicenseBadge', () => {
  it('marks a group that grants a license with what it grants, from one shared read', async () => {
    const [eng, design, plain] = await badges(['g-eng', 'g-design', 'g-plain']);
    expect(eng!.text()).toBe('Microsoft 365 E3');
    expect(design!.text()).toBe('2 licenses');
    expect(design!.find('.license-badge').attributes('title')).toBe(
      'Members get Visio Plan 2, Microsoft 365 E3 through this group',
    );
    expect(plain!.find('.license-badge').exists()).toBe(false);
    expect(licensed).toHaveBeenCalledTimes(1);
  });

  it('follows what a group’s page last read', async () => {
    const [eng] = await badges(['g-eng']);
    useLicensedGroupsStore().setGroup('g-eng', []);
    await flushPromises();
    expect(eng!.find('.license-badge').exists()).toBe(false);
  });

  it('shows nothing when the list can’t be read', async () => {
    licensed.mockRejectedValue(new Error('offline'));
    const [eng] = await badges(['g-eng']);
    expect(eng!.find('.license-badge').exists()).toBe(false);
  });
});
