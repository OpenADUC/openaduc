// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

const DOMAIN = 'DC=corp,DC=example';
const STAFF = `OU=Staff,${DOMAIN}`;
const ou = (name: string, parentDn: string) => ({
  distinguishedName: `OU=${name},${parentDn}`,
  name,
  parentDn,
  description: null,
  stale: false,
});
const api = {
  ous: {
    list: vi.fn(async () => ({ ous: [ou('Staff', DOMAIN), ou('Interns', STAFF)] })),
    contents: vi.fn(async () => ({ users: [], groups: [], computers: [] })),
  },
};
vi.mock('../../api/index.js', () => ({ api }));
vi.mock('primevue/usetoast', () => ({ useToast: () => ({ add: vi.fn() }) }));

const { default: OuTreePane } = await import('./OuTreePane.vue');
const { default: ContentsListPane } = await import('./ContentsListPane.vue');
const { useAuthStore } = await import('../../stores/auth.js');

enableAutoUnmount(afterEach);

describe('the Old School console tree', () => {
  it('expands down to a container opened from the contents list', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    useAuthStore().actor = { capabilities: ['read:user'] } as never;
    const mmc = mount(defineComponent({ render: () => [h(OuTreePane), h(ContentsListPane)] }), {
      attachTo: document.body,
      global: { plugins: [pinia, PrimeVue] },
    });
    await flushPromises();
    const tree = () => mmc.findAll('.os-tree-node').map((n) => n.text().replace(/[▸▾]/g, ''));
    expect(tree()).not.toContain('Interns');

    await mmc
      .findAll('.os-list-row')
      .find((r) => r.text().startsWith('Staff'))!
      .trigger('dblclick');
    await flushPromises();
    await mmc
      .findAll('.os-list-row')
      .find((r) => r.text().startsWith('Interns'))!
      .trigger('dblclick');
    await flushPromises();

    expect(tree()).toContain('Interns');
    expect(mmc.get('.os-tree-node.selected').text()).toBe('Interns');
  });
});
