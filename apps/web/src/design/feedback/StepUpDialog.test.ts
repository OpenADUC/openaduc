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

  // The prompt's own explainer already says to confirm the password.
  it('doesn’t repeat the server’s generic refusal', async () => {
    const { dialog } = await prompt('step-up required — confirm your password to continue');

    expect(dialog.find('.dialog-reason').exists()).toBe(false);
    expect(dialog.text()).not.toContain('step-up required');
  });

  it('says why when the server gives a reason of its own, as a sentence', async () => {
    const { dialog } = await prompt('the directory rejected your step-up password — step up again');

    expect(dialog.get('.dialog-reason').text()).toBe(
      'The directory rejected your step-up password — step up again.',
    );
  });

  it('keeps a reason a write gave as it is', async () => {
    const { dialog } = await prompt('Deleting a group requires step-up authentication.');

    expect(dialog.get('.dialog-reason').text()).toBe(
      'Deleting a group requires step-up authentication.',
    );
  });
});
