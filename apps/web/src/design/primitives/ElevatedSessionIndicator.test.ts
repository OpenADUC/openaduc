// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import Tooltip from 'primevue/tooltip';
import { describe, expect, it, vi } from 'vitest';

const api = { auth: { revokeStepUp: vi.fn(async () => ({ ok: true })) } };
vi.mock('../../api/index.js', () => ({ api }));

const { default: ElevatedSessionIndicator } = await import('./ElevatedSessionIndicator.vue');
const { useAuthStore } = await import('../../stores/auth.js');

const IDLE_END = new Date(Date.now() + 15 * 60_000);
const ABSOLUTE_END = new Date(Date.now() + 4 * 60 * 60_000);
const time = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function mountFor(elevated: boolean, compact = false, absoluteEnd = ABSOLUTE_END) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().actor = {
    capabilities: ['write:user.attributes'],
    elevated: elevated
      ? {
          active: true,
          idleExpiresAt: IDLE_END.toISOString(),
          absoluteExpiresAt: absoluteEnd.toISOString(),
        }
      : { active: false, idleExpiresAt: null, absoluteExpiresAt: null },
  } as never; // only these fields matter
  return mount(ElevatedSessionIndicator, {
    props: { compact },
    global: { plugins: [pinia, PrimeVue, ToastService], directives: { tooltip: Tooltip } },
  });
}

describe('the elevated session indicator', () => {
  it('shows that writes are unlocked and when that ends if idle', () => {
    const indicator = mountFor(true);

    expect(indicator.text()).toContain('Writes unlocked');
    expect(indicator.text()).toContain(`until ${time(IDLE_END)} if idle`);
  });

  it('doesn\'t say "if idle" once the idle end has reached the absolute end', () => {
    const indicator = mountFor(true, false, IDLE_END);

    expect(indicator.text()).toContain(`until ${time(IDLE_END)}`);
    expect(indicator.text()).not.toContain('if idle');
  });

  it('ends the elevated session when asked', async () => {
    const indicator = mountFor(true);

    await indicator.get('button[aria-label="End elevated session"]').trigger('click');
    await flushPromises();
    expect(api.auth.revokeStepUp).toHaveBeenCalledOnce();
    expect(useAuthStore().elevated).toBe(false);
    expect(indicator.text()).toBe('');
  });

  it('offers the same in the collapsed sidebar', () => {
    const indicator = mountFor(true, true);

    expect(indicator.find('button[aria-label="End elevated session"]').exists()).toBe(true);
  });

  it('shows nothing without an elevated session', () => {
    expect(mountFor(false).text()).toBe('');
  });
});
