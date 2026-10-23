// SPDX-License-Identifier: BUSL-1.1
import { computed, ref } from 'vue';
import { useToast } from 'primevue/usetoast';
import { undoable } from '../../design/feedback/undoToast.js';
import { placeFailure } from '../../design/lib/failurePlacement.js';
import type { AccountKind } from '../../design/composables/useAccountActions.js';
import { useAccountMove } from '../../design/composables/useAccountMove.js';
import type { ObjectActionFailure } from './objectPage';

/**
 * The Move to OU dialog on a user's or computer's page. A move's success
 * toast offers Undo. A failed move shows in the dialog that made it while
 * that's open, else (an Undo's failure) as `pageFailure` for the Actions
 * menu; closing the dialog gives up on a move that failed in it.
 */
export function useMoveDialog(options: {
  kind: AccountKind;
  id: () => string;
  /** Refresh the page once the account has moved. */
  onMoved: () => void | Promise<void>;
}) {
  const toast = useToast();
  const open = ref(false);
  const move = useAccountMove({
    kind: options.kind,
    onMoved: async (account, to, offer) => {
      toast.add(
        undoable(
          {
            severity: 'success',
            summary: `Moved ${account.name} to ${move.ouName(to)}`,
            life: 4000,
          },
          offer,
        ),
      );
      open.value = false;
      await options.onMoved();
    },
  });

  function show(): void {
    open.value = true;
    void move.load(options.id());
  }

  const { inDialog, onPage } = placeFailure(move.failure, {
    belongsHere: (f) => f.op.account.id === options.id(),
    dialog: { open: () => open.value, made: (f) => !f.undo },
  });

  function close(): void {
    open.value = false;
    if (inDialog.value) move.dismiss();
  }

  const pageFailure = computed<ObjectActionFailure | null>(() => {
    const f = onPage.value;
    if (!f) return null;
    return {
      summary: `Couldn’t move ${f.op.account.name} to ${move.ouName(f.op.destinationDn)}`,
      message: f.message,
      retry: move.retry,
      dismiss: move.dismiss,
    };
  });

  return {
    move,
    open,
    show,
    close,
    dialogFailure: inDialog,
    pageFailure,
    submitting: move.submitting,
  };
}
