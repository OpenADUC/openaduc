// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { describe, expect, it, vi } from 'vitest';

const api = { auth: { stepUp: vi.fn() } };
vi.mock('../../api/index.js', () => ({ api }));

const { default: StepUpDialog } = await import('./StepUpDialog.vue');

async function prompt(reason: string | null = null) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const dialog = mount(StepUpDialog, {
    props: { visible: true, reason },
    global: { plugins: [pinia, PrimeVue], stubs: { teleport: true } },
  });
  await flushPromises();
  return { dialog, input: dialog.get('input[type="password"]') };
}

describe('the step-up prompt', () => {
  // A write started with Enter (as in quick search) opens the prompt on that
  // Enter's keydown; its keyup then lands in the password field.
  it('submits on Enter’s keydown, not on the keyup of the Enter that opened it', async () => {
    const { dialog, input } = await prompt();

    await input.trigger('keyup', { key: 'Enter' });
    expect(dialog.text()).not.toContain('Password required');

    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(dialog.text()).toContain('Password required');
  });

  it('ignores a held Enter and an input method’s Enter', async () => {
    const { dialog, input } = await prompt();

    await input.trigger('keydown', { key: 'Enter', repeat: true });
    await input.trigger('keydown', { key: 'Enter', isComposing: true });
    await input.trigger('keydown', { key: 'Enter', keyCode: 229 });
    await flushPromises();
    expect(dialog.text()).not.toContain('Password required');
  });

  it('says why it opened, in full, when given a reason', async () => {
    const { dialog } = await prompt(
      'Writes were locked again — confirm your password to continue.',
    );

    expect(dialog.get('.dialog-reason').text()).toBe(
      'Writes were locked again — confirm your password to continue.',
    );
  });

  it('says nothing more when it has no reason to', async () => {
    const { dialog } = await prompt();

    expect(dialog.find('.dialog-reason').exists()).toBe(false);
  });
});
