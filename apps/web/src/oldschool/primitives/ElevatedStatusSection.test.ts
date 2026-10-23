// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { describe, expect, it, vi } from 'vitest';

const api = { auth: { revokeStepUp: vi.fn(async () => ({ ok: true })) } };
vi.mock('../../api/index.js', () => ({ api }));

const { default: ElevatedStatusSection } = await import('./ElevatedStatusSection.vue');
const { useAuthStore } = await import('../../stores/auth.js');

describe('the Old School status bar', () => {
  it('shows an elevated session and ends it', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const idleEnd = new Date(Date.now() + 15 * 60_000);
    useAuthStore().actor = {
      capabilities: [],
      elevated: {
        active: true,
        idleExpiresAt: idleEnd.toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
      },
    } as never; // only these fields matter
    const section = mount(ElevatedStatusSection, {
      global: { plugins: [pinia, PrimeVue, ToastService] },
    });
    const time = idleEnd.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    expect(section.text()).toContain(`Writes unlocked until ${time} if idle`);

    await section.get('button[aria-label="End elevated session"]').trigger('click');
    await flushPromises();
    expect(api.auth.revokeStepUp).toHaveBeenCalledOnce();
    expect(section.text()).toBe('');
  });
});
