// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { describe, expect, it, vi } from 'vitest';

const api = { auth: { stepUp: vi.fn() } };
vi.mock('../../api/index.js', () => ({ api }));

const { default: StepUpDialog } = await import('./StepUpDialog.vue');

describe('the step-up prompt', () => {
  // A write started with Enter (as in quick search) opens the prompt on that
  // Enter's keydown; its keyup then lands in the password field.
  it('submits on Enter’s keydown, not on the keyup of the Enter that opened it', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const dialog = mount(StepUpDialog, {
      props: { visible: true, reason: null },
      global: { plugins: [pinia, PrimeVue], stubs: { teleport: true } },
    });
    await flushPromises();
    const input = dialog.get('input[type="password"]');

    await input.trigger('keyup', { key: 'Enter' });
    expect(dialog.text()).not.toContain('Password required');

    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(dialog.text()).toContain('Password required');
  });
});
