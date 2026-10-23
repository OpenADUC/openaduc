// SPDX-License-Identifier: BUSL-1.1
import { computed, ref } from 'vue';
import { useToast } from 'primevue/usetoast';
import { undoable } from '../../design/feedback/undoToast.js';
import { placeFailure } from '../../design/lib/failurePlacement.js';
import { expiryText } from '../../design/lib/accountExpiry.js';
import { useAccountExpiry, type ExpirySubject } from '../../design/composables/useAccountExpiry.js';
import type { ObjectActionFailure } from './objectPage';

/**
 * The Account expiry dialog on a user's page. A change's success toast
 * offers Undo. A failed write shows in the dialog that made it while that's
 * open, else (an Undo's failure) as `pageFailure` for the Actions menu;
 * closing the dialog gives up on a write that failed in it.
 */
export function useExpiryDialog(options: {
  id: () => string;
  /** Refresh the page once the expiry has changed. */
  onSet: () => void | Promise<void>;
}) {
  const toast = useToast();
  const open = ref(false);
  const expiry = useAccountExpiry({
    onSet: async (account, expiresAt, offer) => {
      toast.add(
        undoable(
          {
            severity: 'success',
            summary: `${account.name} now ${expiryText(expiresAt)}`,
            life: 4000,
          },
          offer,
        ),
      );
      open.value = false;
      await options.onSet();
    },
  });

  function show(account: ExpirySubject): void {
    expiry.load(account);
    open.value = true;
  }

  const { inDialog, onPage } = placeFailure(expiry.failure, {
    belongsHere: (f) => f.op.account.id === options.id(),
    dialog: { open: () => open.value, made: (f) => !f.undo },
  });

  function close(): void {
    open.value = false;
    if (inDialog.value) expiry.dismiss();
  }

  const pageFailure = computed<ObjectActionFailure | null>(() => {
    const f = onPage.value;
    if (!f) return null;
    return {
      summary: `Couldn’t change when ${f.op.account.name}’s account expires`,
      message: f.message,
      retry: expiry.retry,
      dismiss: expiry.dismiss,
    };
  });

  return {
    expiry,
    open,
    show,
    close,
    dialogFailure: inDialog,
    pageFailure,
    submitting: expiry.submitting,
  };
}
