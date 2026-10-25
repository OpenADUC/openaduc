// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it } from 'vitest';
import AppearanceTab from './AppearanceTab.vue';
import { useThemeStore } from '../../design/stores/useTheme.js';

enableAutoUnmount(afterEach);

describe('the single-key shortcuts setting', () => {
  it('turns them off and on again', async () => {
    localStorage.clear();
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [] });
    const tab = mount(AppearanceTab, { global: { plugins: [pinia, router] } });
    const toggle = tab.get('#appearance-single-key-shortcuts');
    expect(tab.get('label[for="appearance-single-key-shortcuts"]').text()).toBe(
      'Single-key shortcuts',
    );
    expect((toggle.element as HTMLInputElement).checked).toBe(true);

    await toggle.setValue(false);
    expect(useThemeStore().singleKeyShortcuts).toBe(false);
    await toggle.setValue(true);
    expect(useThemeStore().singleKeyShortcuts).toBe(true);
  });
});
