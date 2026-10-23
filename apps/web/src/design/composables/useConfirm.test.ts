// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { defineComponent, h } from 'vue';
import { describe, expect, it } from 'vitest';
import ConfirmDialog from '../feedback/ConfirmDialog.vue';
import { useConfirm } from './useConfirm.js';

describe('asking the operator to confirm', () => {
  it('opens the dialog with the question and resolves true on confirm', async () => {
    const c = useConfirm();
    const answer = c.ask({ title: 'Leave?', message: '2 unsaved changes' });
    expect(c.visible.value).toBe(true);
    expect(c.request.value?.title).toBe('Leave?');

    c.confirm();
    await expect(answer).resolves.toBe(true);
    expect(c.visible.value).toBe(false);
  });

  it('resolves false on cancel', async () => {
    const c = useConfirm();
    const answer = c.ask({ title: 'Leave?' });
    c.cancel();
    await expect(answer).resolves.toBe(false);
    expect(c.visible.value).toBe(false);
  });

  it('cancels an unanswered question when a new one replaces it', async () => {
    const c = useConfirm();
    const first = c.ask({ title: 'First' });
    const second = c.ask({ title: 'Second' });
    await expect(first).resolves.toBe(false);
    expect(c.request.value?.title).toBe('Second');
    c.confirm();
    await expect(second).resolves.toBe(true);
  });

  it("binds the dialog's own close and buttons to the answer", async () => {
    const c = useConfirm();
    const closed = c.ask({ title: 'Leave?', confirmLabel: 'Leave' });
    expect(c.dialog.value).toMatchObject({ title: 'Leave?', confirmLabel: 'Leave', visible: true });
    c.dialog.value['onUpdate:visible'](false);
    await expect(closed).resolves.toBe(false);

    const confirmed = c.ask({ title: 'Leave?' });
    c.dialog.value.onConfirm();
    await expect(confirmed).resolves.toBe(true);
    expect(c.dialog.value.visible).toBe(false);
  });
});

describe('the confirm dialog bound to a question', () => {
  it('answers with the button the operator clicks', async () => {
    let ask!: ReturnType<typeof useConfirm>['ask'];
    const Page = defineComponent({
      setup() {
        const c = useConfirm();
        ask = c.ask;
        return () => h(ConfirmDialog, c.dialog.value);
      },
    });
    const page = mount(Page, { global: { plugins: [PrimeVue], stubs: { teleport: true } } });

    const answer = ask({ title: 'Remove?', confirmLabel: 'Remove' });
    await flushPromises();
    expect(page.text()).toContain('Remove?');
    const remove = page.findAll('button').find((b) => b.text() === 'Remove')!;
    await remove.trigger('click');
    await expect(answer).resolves.toBe(true);
  });
});
