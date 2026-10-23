// SPDX-License-Identifier: BUSL-1.1
import { computed, ref, shallowRef } from 'vue';

export interface ConfirmRequest {
  title: string;
  message?: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  severity?: 'danger' | 'warn' | 'info';
}

// A question for the app's ConfirmDialog that the caller can await, the way
// window.confirm reads — including from an async route guard. Bind the
// dialog with `<ConfirmDialog v-bind="dialog" />`. The last question stays
// bound after it's answered so the text doesn't blank while it closes.
export function useConfirm() {
  const request = ref<ConfirmRequest | null>(null);
  const visible = ref(false);
  const settle = shallowRef<((ok: boolean) => void) | null>(null);

  function answer(ok: boolean): void {
    const resolve = settle.value;
    settle.value = null;
    visible.value = false;
    resolve?.(ok);
  }

  function ask(req: ConfirmRequest): Promise<boolean> {
    answer(false);
    request.value = req;
    visible.value = true;
    return new Promise((resolve) => (settle.value = resolve));
  }

  const confirm = () => answer(true);
  const cancel = () => answer(false);

  const dialog = computed(() => ({
    ...(request.value ?? { title: '' }),
    visible: visible.value,
    'onUpdate:visible': (v: boolean) => {
      if (!v) cancel();
    },
    onCancel: cancel,
    onConfirm: confirm,
  }));

  return { request, visible, dialog, ask, confirm, cancel };
}
