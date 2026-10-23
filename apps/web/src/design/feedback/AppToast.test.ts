// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { useToast } from 'primevue/usetoast';
import { defineComponent, h } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import AppToast from './AppToast.vue';
import { undoable, UNDO_TOAST_LIFE_MS } from './undoToast.js';

function mountToast() {
  let toast!: ReturnType<typeof useToast>;
  const page = mount(
    defineComponent({
      setup() {
        toast = useToast();
        return () => h(AppToast);
      },
    }),
    { global: { plugins: [PrimeVue, ToastService], stubs: { teleport: true } } },
  );
  return { page, toast };
}

const undoButton = (page: ReturnType<typeof mountToast>['page']) =>
  page.findAll('button').find((b) => b.text() === 'Undo');

describe('the app toast', () => {
  it('offers Undo on an undoable success, which undoes once and closes the toast', async () => {
    const { page, toast } = mountToast();
    const undo = vi.fn();

    toast.add(undoable({ severity: 'success', summary: 'Account disabled', life: 3000 }, undo));
    await flushPromises();
    expect(page.text()).toContain('Account disabled');

    await undoButton(page)!.trigger('click');
    await flushPromises();
    expect(undo).toHaveBeenCalledOnce();
    expect(page.text()).not.toContain('Account disabled');
  });

  it('shows plain messages without Undo', async () => {
    const { page, toast } = mountToast();

    toast.add(undoable({ severity: 'success', summary: 'Account unlocked', detail: 'Hi' }, null));
    await flushPromises();
    expect(page.text()).toContain('Account unlocked');
    expect(page.text()).toContain('Hi');
    expect(undoButton(page)).toBeUndefined();
  });

  it('stays up long enough to reach Undo', () => {
    expect(undoable({ life: 3000 }, () => undefined).life).toBe(UNDO_TOAST_LIFE_MS);
    expect(undoable({ life: 3000 }, null).life).toBe(3000);
  });
});
