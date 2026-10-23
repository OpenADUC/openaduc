// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';

const api = {
  settings: {
    list: vi.fn(async () => ({ settings: {} })),
    update: vi.fn(async () => ({ ok: true, updated: [] })),
  },
  directories: { policy: vi.fn(async () => ({ policy: null })) },
  auth: {
    stepUp: vi.fn(async () => ({
      elevated: {
        active: true,
        idleExpiresAt: '2999-01-01T00:00:00Z',
        absoluteExpiresAt: '2999-01-01T00:00:00Z',
      },
    })),
  },
};
vi.mock('../../api/index.js', () => ({ api }));

const { default: PolicyTab } = await import('./PolicyTab.vue');
const { useAuthStore } = await import('../../stores/auth.js');

async function openTab(elevated: boolean) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.actor = {
    capabilities: ['configure:security'],
    directoryId: 1,
    elevated: elevated
      ? {
          active: true,
          idleExpiresAt: '2999-01-01T00:00:00Z',
          absoluteExpiresAt: '2999-01-01T00:00:00Z',
        }
      : { active: false, idleExpiresAt: null, absoluteExpiresAt: null },
  } as never; // only these fields matter
  const tab = mount(PolicyTab, { global: { plugins: [pinia, PrimeVue, ToastService] } });
  await flushPromises();
  const save = tab.findAll('button').find((b) => b.text().includes('Save changes'))!;
  return { auth, save, tab };
}

describe('elevated session limits', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the configured limits and saves them with the rest', async () => {
    api.settings.list.mockResolvedValueOnce({
      settings: {
        'stepup.idle_timeout_minutes': { value: 10 },
        'stepup.absolute_lifetime_minutes': { value: 120 },
      },
    } as never);
    const { save, tab } = await openTab(true);
    expect((tab.find('#stepup-idle').element as HTMLInputElement).value).toBe('10');
    expect((tab.find('#stepup-lifetime').element as HTMLInputElement).value).toBe('120');

    await save.trigger('click');
    await flushPromises();
    expect(api.settings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        'stepup.idle_timeout_minutes': 10,
        'stepup.absolute_lifetime_minutes': 120,
      }),
    );
  });
});

// Settings changes need step-up (ADR 0001: the first write prompts, then retries).
describe('saving settings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks for step-up first, then saves', async () => {
    const { auth, save } = await openTab(false);

    await save.trigger('click');
    expect(auth.stepUpRequested).toBe(true);
    expect(api.settings.update).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await flushPromises();
    expect(api.settings.update).toHaveBeenCalledOnce();
  });

  it('saves again after step-up when the server asked for it', async () => {
    const { auth, save } = await openTab(true);
    api.settings.update.mockRejectedValueOnce(
      new ApiError(403, 'step_up_required', 'step-up required'),
    );

    await save.trigger('click');
    await flushPromises();
    expect(api.settings.update).toHaveBeenCalledOnce();

    await auth.stepUp('pw');
    await flushPromises();
    expect(api.settings.update).toHaveBeenCalledTimes(2);
  });
});
