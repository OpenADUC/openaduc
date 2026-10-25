// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';

const api = {
  settings: { list: vi.fn(async () => ({ settings: {} })) },
  setup: { policy: vi.fn(async () => ({ ok: true })) },
  auth: {
    stepUp: vi.fn(async () => ({ elevated: { active: true, expiresAt: '2999-01-01T00:00:00Z' } })),
  },
};
vi.mock('../../api/index.js', () => ({ api }));

const { default: StepPolicy } = await import('./StepPolicy.vue');
const { useAuthStore } = await import('../../stores/auth.js');

// Setup/initialize opens an elevated session, so this step normally just
// saves; once that session is gone it asks for step-up and saves after.
describe('the setup policy step', () => {
  it('saves again after step-up when the elevated session is gone', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    const step = mount(StepPolicy, { global: { plugins: [pinia, PrimeVue] } });
    await flushPromises();
    api.setup.policy.mockRejectedValueOnce(
      new ApiError(403, 'step_up_required', 'step-up required'),
    );

    await step.find('form').trigger('submit');
    await flushPromises();
    expect(step.text()).not.toContain('step-up required');
    expect(step.emitted('next')).toBeUndefined();

    await auth.stepUp('pw');
    await flushPromises();
    expect(api.setup.policy).toHaveBeenCalledTimes(2);
    expect(step.emitted('next')).toHaveLength(1);
  });
});
