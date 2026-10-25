// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TapPreflight } from '@openaduc/shared';

const user = { id: 'u1', displayName: 'Alice Anders', samAccountName: 'alice.anders' };
const ready: TapPreflight = {
  status: 'ready',
  policy: {
    defaultLifetimeMinutes: 60,
    minLifetimeMinutes: 60,
    maxLifetimeMinutes: 480,
    usableOnceOnly: true,
  },
  existing: null,
  inPolicyScope: true,
};
const api = {
  users: {
    tapPreflight: vi.fn(),
    issueTap: vi.fn(async () => ({
      temporaryAccessPass: 'Tap-Value-7Kq2',
      startsAt: '2026-10-24T12:00:00.000Z',
      expiresAt: '2026-10-24T13:00:00.000Z',
      lifetimeMinutes: 60,
      isUsableOnce: true,
      replaced: false,
    })),
  },
};
vi.mock('../../api/index.js', () => ({ api }));

const { default: IssueTapDialog } = await import('./IssueTapDialog.vue');
const { useAuthStore } = await import('../../stores/auth.js');

function open(preflight: TapPreflight) {
  api.users.tapPreflight.mockResolvedValue(preflight);
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().actor = {
    directoryId: 1,
    capabilities: ['read:user', 'write:user.issueTap'],
    elevated: { active: true },
  } as never;
  return mount(IssueTapDialog, {
    props: { visible: true, user },
    global: { plugins: [pinia, PrimeVue], stubs: { teleport: true } },
  });
}

const button = (dialog: ReturnType<typeof open>, label: string) =>
  dialog.findAll('button').find((b) => b.text() === label);

describe('the Issue TAP dialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('issues a pass within the policy and shows it until closed', async () => {
    const dialog = open(ready);
    await flushPromises();
    expect(dialog.text()).toContain('The tenant allows 1 hour to 8 hours.');
    expect(dialog.text()).toContain('The tenant allows only one-time passes.');
    const once = dialog.find('input[type="checkbox"]').element as HTMLInputElement;
    expect(once.checked && once.disabled).toBe(true);

    await button(dialog, 'Issue pass')!.trigger('click');
    await flushPromises();
    expect(dialog.get('[data-testid="tap-value"]').text()).toBe('Tap-Value-7Kq2');
    expect(dialog.emitted('issued')).toHaveLength(1);

    await dialog.setProps({ visible: false });
    await dialog.setProps({ visible: true });
    await flushPromises();
    expect(dialog.find('[data-testid="tap-value"]').exists()).toBe(false);
  });

  it('warns when the tenant’s policy doesn’t cover the user, and still issues', async () => {
    const dialog = open({ ...ready, inPolicyScope: false });
    await flushPromises();
    expect(dialog.text()).toContain('Microsoft Entra may not accept a pass for them');
    expect(button(dialog, 'Issue pass')!.attributes('disabled')).toBeUndefined();
  });

  it('says an unsynced user is waiting for sync', async () => {
    const dialog = open({ status: 'unsynced', lastSyncAt: '2026-10-24T11:30:00.000Z' });
    await flushPromises();
    expect(dialog.text()).toContain('Alice Anders isn’t in Microsoft Entra yet');
    expect(dialog.text()).toContain('The tenant last synced');
    expect(button(dialog, 'Issue pass')).toBeUndefined();
    expect(button(dialog, 'Check again')).toBeDefined();
  });
});
