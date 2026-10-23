// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { useToast } from 'primevue/usetoast';
import { defineComponent, h } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppToast from './AppToast.vue';
import { undoable, UNDO_TOAST_LIFE_MS } from './undoToast.js';

enableAutoUnmount(afterEach);

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
  afterEach(() => vi.useRealTimers());

  it('offers Undo on an undoable success, which undoes once and closes the toast', async () => {
    const { page, toast } = mountToast();
    const undo = vi.fn();

    toast.add(
      undoable({ severity: 'success', summary: 'Disabled Jane Doe', life: 3000 }, { undo }),
    );
    await flushPromises();
    expect(page.text()).toContain('Disabled Jane Doe');

    await undoButton(page)!.trigger('click');
    await flushPromises();
    expect(undo).toHaveBeenCalledOnce();
    expect(page.text()).not.toContain('Disabled Jane Doe');
  });

  it('shows plain messages without Undo', async () => {
    const { page, toast } = mountToast();

    toast.add(undoable({ severity: 'success', summary: 'Unlocked Jane Doe', detail: 'Hi' }, null));
    await flushPromises();
    expect(page.text()).toContain('Unlocked Jane Doe');
    expect(page.text()).toContain('Hi');
    expect(undoButton(page)).toBeUndefined();
  });

  it('says why a change can’t be undone', async () => {
    const { page, toast } = mountToast();

    toast.add(
      undoable({ severity: 'success', summary: 'Moved' }, { cannotUndo: 'It came from CN=Users.' }),
    );
    await flushPromises();
    expect(page.text()).toContain('It came from CN=Users.');
    expect(undoButton(page)).toBeUndefined();
  });

  it('times out an Undo toast, but not while it has keyboard focus', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { page, toast } = mountToast();
    toast.add(undoable({ severity: 'success', summary: 'Disabled Jane Doe' }, { undo: vi.fn() }));
    await flushPromises();
    const message = page.get('.p-toast-message');

    await message.trigger('focusin');
    await vi.advanceTimersByTimeAsync(UNDO_TOAST_LIFE_MS * 2);
    expect(page.text()).toContain('Disabled Jane Doe');

    await message.trigger('focusout');
    await vi.advanceTimersByTimeAsync(UNDO_TOAST_LIFE_MS);
    await flushPromises();
    expect(page.text()).not.toContain('Disabled Jane Doe');
  });
});
